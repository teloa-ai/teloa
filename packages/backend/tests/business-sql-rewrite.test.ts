import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type BusinessObjectTypeDefinition,type BusinessFieldType} from '@teloa/contract'
import {initializeBusinessData,businessObjectSnapshotHash} from '../src/work/business-data.ts'
import {initializeBusinessWarehouse} from '../src/work/business-warehouse.ts'
import {analyzeBusinessSql,prepareBusinessSqlParser,verifyRewrittenBusinessSql} from '../src/work/business-sql-guard.ts'
import {rewriteBusinessSql} from '../src/work/business-sql-rewrite.ts'

/** 快照表改写器：产物形状、占位符编号、二次校验，以及规格 §4.2 示例在 search_path=pg_temp 的只读事务里真库执行。 */

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 await prepareBusinessSqlParser()
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessData(pool)
 await initializeBusinessWarehouse(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const field=(name:string,type:BusinessFieldType,from:string)=>({name,label:from,type,required:false,from})
const objectType=(id:string,fields:ReturnType<typeof field>[]):BusinessObjectTypeDefinition=>({format:'teloa.business-object-type/v1',id,version:'1',domain:'SOC',title:id,unit:'条',lead:'说明',sourceId:'soc',fields})
const types=[
 objectType('soc-alert',[field('alerted_at','datetime','告警时间'),field('resolved_at','datetime','处置时间'),field('severity','enum','严重度'),field('score','number','分值'),field('confirmed','boolean','已确认'),field('handling','duration','处置时长')]),
 objectType('soc-ticket',[field('alert_id','text','告警'),field('status','enum','状态')]),
]
const actor={ownerId:'owner-1',scope:'SOC'}
const rewrite=(sql:string)=>rewriteBusinessSql(analyzeBusinessSql(sql,types),actor,'public')
const flat=(sql:string)=>sql.replace(/\s+/g,' ').toLowerCase()
const maxParam=(sql:string)=>Math.max(0,...[...sql.matchAll(/\$(\d+)/g)].map(match=>Number(match[1])))

const specExample=`select severity,
       percentile_cont(0.9) within group (order by extract(epoch from resolved_at - alerted_at)) as mttr_p90_seconds
from soc_alert
where alerted_at >= now() - interval '7 days'
group by severity`

test('改写产物：限定名、标签走占位符、当前版本条件、参数个数',()=>{
 const result=rewrite(specExample),sql=flat(result.sql)
 assert.ok(sql.includes("public.teloa_safe_timestamptz((select f ->> 'value' from jsonb_array_elements(s.snapshot -> 'fields') as f where (f ->> 'label') = $4 limit 1)) as alerted_at"),result.sql)
 assert.ok(sql.includes('distinct on (object_id)'))
 assert.ok(sql.includes('from public.teloa_business_object_snapshots'))
 assert.ok(sql.includes('owner_id = $1 and scope_id = $2 and object_type = $3'))
 assert.match(sql,/public\.teloa_safe_numeric\(\(select f ->> 'value' [^)]*\) as f where \(f ->> 'label'\) = \$7 limit 1\)\) as score/,'number 走 teloa_safe_numeric')
 assert.match(sql,/public\.teloa_safe_duration_seconds\(\(select f ->> 'value' [^)]*\) as f where \(f ->> 'label'\) = \$9 limit 1\)\) as handling/,'duration 走 teloa_safe_duration_seconds')
 assert.ok(sql.includes("public.teloa_safe_boolean((select f ->> 'value'"))
 // enum 保持原值 text，不包转换函数。
 assert.match(sql,/, \(select f ->> 'value' from jsonb_array_elements\(s\.snapshot -> 'fields'\) as f where \(f ->> 'label'\) = \$6 limit 1\) as severity/)
 assert.doesNotMatch(result.sql,/(?<!public\.)teloa_(?:business_object_snapshots|safe_)/)
 // 标签不拼进 SQL 文本。
 for(const label of ['告警时间','处置时间','严重度'])assert.ok(!result.sql.includes(label),label)
 assert.deepEqual(result.params,['owner-1','SOC','soc-alert','告警时间','处置时间','严重度','分值','已确认','处置时长'])
 assert.equal(maxParam(result.sql),result.params.length)
 assert.deepEqual(result.tables,[{logical:'soc_alert',alias:'soc_alert',objectTypeParam:3}])
 // now() 原样保留，由执行器事务固化。
 assert.ok(sql.includes('now()'))
})

test('Teloa 表不在 public：产物按给定模式限定，二次校验只认该模式；模式名须是普通小写标识符',()=>{
 const {sql,params}=rewriteBusinessSql(analyzeBusinessSql(specExample,types),actor,'teloa_e2e_0a1b')
 assert.ok(sql.includes('teloa_e2e_0a1b.teloa_business_object_snapshots')&&sql.includes('teloa_e2e_0a1b.teloa_safe_timestamptz')&&!sql.includes('public.'))
 verifyRewrittenBusinessSql(sql,params.length,'teloa_e2e_0a1b')
 const invalid=(run:()=>unknown)=>assert.throws(run,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'||assert.fail(String(error)))
 invalid(()=>verifyRewrittenBusinessSql(sql,params.length,'public'))
 invalid(()=>verifyRewrittenBusinessSql(rewrite(specExample).sql,params.length,'teloa_e2e_0a1b'))
 for(const schema of ['','Public','pg_catalog','a-b','x"y']){
  invalid(()=>rewriteBusinessSql(analyzeBusinessSql(specExample,types),actor,schema))
  invalid(()=>verifyRewrittenBusinessSql('select 42 as n',0,schema))
 }
})

test('二次校验：产物通过；去掉 public. 即拒绝；产物过不了用户白名单',()=>{
 const {sql,params}=rewrite(specExample)
 verifyRewrittenBusinessSql(sql,params.length,'public')
 const invalid=(run:()=>unknown,word:string)=>assert.throws(run,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&error.message.includes(word)||assert.fail(String(error)))
 invalid(()=>verifyRewrittenBusinessSql(sql.replaceAll('public.',''),params.length,'public'),'teloa_')
 invalid(()=>verifyRewrittenBusinessSql(sql,params.length-1,'public'),'超出范围')
 // 无表产物按 0 个参数校验；有表产物若声称 0 个参数，任何 $n 都越界。
 verifyRewrittenBusinessSql('select 42 as n',0,'public')
 invalid(()=>verifyRewrittenBusinessSql(sql,0,'public'),'超出范围')
 invalid(()=>verifyRewrittenBusinessSql('select 42 as n',1,'public'),'参数个数')
 invalid(()=>analyzeBusinessSql(sql,types),'不允许')
 // 平台放行项只在二次校验里有效，且形态固定。
 invalid(()=>verifyRewrittenBusinessSql('select * from public.other_table',3,'public'),'模式名')
 invalid(()=>verifyRewrittenBusinessSql('select * from soc_alert',3,'public'),'未声明的表 soc_alert')
 invalid(()=>verifyRewrittenBusinessSql('select * from generate_series(1,3) g',3,'public'),'RangeFunction')
 invalid(()=>verifyRewrittenBusinessSql('select public.pg_sleep(1)',3,'public'),'模式名')
 invalid(()=>verifyRewrittenBusinessSql('select teloa_safe_numeric($1)',3,'public'),'不允许的函数 teloa_safe_numeric')
 verifyRewrittenBusinessSql("select public.teloa_safe_numeric(f ->> 'value') from jsonb_array_elements($1) f where f ->> 'label' = $2",3,'public')
})

test('两张逻辑表 join：对象类型占位按登记顺序，标签从其后接续；别名冲突拒绝；分析结果不被改写',()=>{
 const analysis=analyzeBusinessSql('select a.severity, t.status from soc_alert a join soc_ticket t on t.alert_id = a._id',types)
 const result=rewriteBusinessSql(analysis,actor,'public')
 assert.equal(result.tables[0]!.objectTypeParam,3)
 assert.equal(result.tables[1]!.objectTypeParam,4)
 assert.deepEqual(result.tables.map(table=>[table.logical,table.alias]),[['soc_alert','a'],['soc_ticket','t']])
 assert.deepEqual(result.params.slice(2,5),['soc-alert','soc-ticket','告警时间'])
 assert.ok(flat(result.sql).includes('(f ->> \'label\') = $5 limit 1)) as alerted_at'))
 assert.equal(result.params.length,4+6+2)
 assert.equal(maxParam(result.sql),result.params.length)
 assert.ok('RangeVar' in analysis.tables[0]!.node,'分析结果里的语法树保持原样')
 assert.throws(()=>analyzeBusinessSql('select a.severity from soc_alert a join soc_ticket a on true',types),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input')
})

test('select now() 不涉及逻辑表：不带任何参数（未被引用的 $1/$2 在 PG 推不出类型，报 42P18）',()=>{
 const result=rewrite('select now()')
 assert.deepEqual(result.params,[])
 assert.deepEqual(result.tables,[])
 assert.equal(flat(result.sql),'select now()')
})

const HOUR=3_600_000
async function put(owner:string,id:string,version:number,fields:Array<{label:string;value:string}>,deletedAt?:string):Promise<void>{
 const stamp=new Date(Date.now()-24*HOUR).toISOString()
 const item={scope:'SOC',type:'soc-alert',id,version,title:'告警 '+id,source:'EDR',observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'摘要',fields,...(deletedAt===undefined?{}:{deletedAt})}
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   values($1,'SOC','soc-alert',$2,$3,$4,$5,'EDR',$6)`,[owner,id,version,businessObjectSnapshotHash(item),JSON.stringify(item),stamp])
}

test('真库：search_path=pg_temp 的只读事务执行改写产物',{timeout:60000},async()=>{
 const owner=randomUUID(),at=(hours:number)=>new Date(Date.now()-hours*HOUR).toISOString()
 const alert=(severity:string,alerted:string,resolved:string)=>[{label:'严重度',value:severity},{label:'告警时间',value:alerted},{label:'处置时间',value:resolved}]
 // 三个对象各两版：版本 1 全是 medium，只要当前版本算对就不会出现 medium 组；alert-2 当前版本告警时间是脏值。
 await put(owner,'alert-1',1,alert('medium',at(10),at(9)))
 await put(owner,'alert-1',2,alert('high',at(10),at(6)))
 await put(owner,'alert-2',1,alert('medium',at(8),at(7)))
 await put(owner,'alert-2',2,alert('high','n/a',at(1)))
 await put(owner,'alert-3',1,alert('medium',at(5),at(4)))
 await put(owner,'alert-3',2,alert('low',at(5),at(3)))
 // alert-4 已 tombstone：它的 critical 组不得出现。
 await put(owner,'alert-4',1,alert('critical',at(2),at(1)))
 await put(owner,'alert-4',2,alert('critical',at(2),at(1)),at(0.5))
 const grouped=rewriteBusinessSql(analyzeBusinessSql(specExample+' order by severity',types),{ownerId:owner,scope:'SOC'},'public')
 const expanded=rewriteBusinessSql(analyzeBusinessSql('select _id, _version, _deleted_at, alerted_at from soc_alert order by _id',types),{ownerId:owner,scope:'SOC'},'public')
 const db=await pool.connect()
 try{
  await db.query('begin read only')
  await db.query('set local search_path=pg_temp')
  const rows=(await db.query(grouped.sql,grouped.params)).rows
  assert.deepEqual(rows.map(row=>[row.severity,Math.round(Number(row.mttr_p90_seconds))]),[['high',14400],['low',7200]])
  const current=(await db.query(expanded.sql,expanded.params)).rows
  assert.deepEqual(current.map(row=>[row._id,row._version,row._deleted_at]),[['alert-1',2,null],['alert-2',2,null],['alert-3',2,null]])
  assert.equal(current[1].alerted_at,null,'脏值转换为 NULL，不让整条查询失败')
  assert.ok(current[0].alerted_at instanceof Date)
  // 去掉 public. 的产物在同一事务里找不到快照表：证明 search_path 确实不含 public。
  await assert.rejects(db.query(grouped.sql.replaceAll('public.',''),grouped.params),(error:{code?:string})=>error.code==='42P01')
 }finally{await db.query('rollback');db.release()}
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[owner])
})

test('真库：VALUES 分支排序 / offset 旁路（pg_sleep、改 search_path、报错泄露他人快照）在分析阶段即拒绝，不进数据库',{timeout:60000},async()=>{
 const other=randomUUID(),stamp=new Date().toISOString()
 const item={scope:'SOC',type:'soc-alert',id:'secret-1',version:1,title:'OTHER-OWNER-SECRET',source:'EDR',observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'摘要',fields:[]}
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   values($1,'SOC','soc-alert','secret-1',1,$2,$3,'EDR',$4)`,[other,businessObjectSnapshotHash(item),JSON.stringify(item),stamp])
 const db=await pool.connect()
 try{
  await db.query('begin read only')
  await db.query('set local search_path=pg_temp')
  const started=Date.now()
  for(const sql of [
   'values (1) order by pg_sleep(10)',
   "values (1) order by (select set_config('search_path','public',false))",
   "select * from (values (1) offset (select cast(string_agg(snapshot::text,',') as int) from public.teloa_business_object_snapshots)) v(n)",
   // 修复前这三条的改写产物在真库上分别：睡满 1 秒、把 search_path 改成 public、把他人快照原文带进 22P02 报错。
   'values (1) order by (select 1 from pg_sleep(1) where $1::text||$2::text is not null)',
   "values (1) order by (select set_config('search_path','public',false)||$1||$2)",
   "select * from (values (1) offset (select cast(string_agg(snapshot::text,',') as int) from public.teloa_business_object_snapshots where $1||$2 is not null)) v(n)",
  ]){
   await assert.rejects(async()=>{const {sql:rewritten,params}=rewrite(sql);await db.query(rewritten,params)},(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'||assert.fail(sql+' → '+String(error)))
  }
  assert.ok(Date.now()-started<500,'没有任何一条进入数据库执行')
  assert.equal((await db.query('show search_path')).rows[0].search_path,'pg_temp')
 }finally{await db.query('rollback');db.release()}
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[other])
})

test('真库：duration 字段按 ISO 8601 时长或纯秒数折成秒，其余 NULL',{timeout:60000},async()=>{
 const owner=randomUUID()
 for(const [id,value] of [['d-1','PT15M'],['d-2','PT1H30M'],['d-3','270.5'],['d-4','x'],['d-5','P1Y']] as const)await put(owner,id,1,[{label:'处置时长',value}])
 const {sql,params}=rewriteBusinessSql(analyzeBusinessSql('select _id, handling from soc_alert order by _id',types),{ownerId:owner,scope:'SOC'},'public')
 const db=await pool.connect()
 try{
  await db.query('begin read only')
  await db.query('set local search_path=pg_temp')
  const rows=(await db.query(sql,params)).rows
  assert.deepEqual(rows.map(row=>[row._id,row.handling===null?null:Number(row.handling)]),[['d-1',900],['d-2',5400],['d-3',270.5],['d-4',null],['d-5',null]])
 }finally{await db.query('rollback');db.release()}
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[owner])
})

const invalidInput=(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'
/** 绕过分析阶段、直接把语法树里某个名字改成给定值，模拟「分析阶段漏了一类标识符」：改写器的往返校验必须独立兜住。 */
function tampered(sql:string,edit:(ast:any)=>void){
 const analysis=analyzeBusinessSql(sql,types)
 edit(analysis.ast)
 return analysis
}
const firstSelect=(ast:any)=>ast.stmts[0].stmt.SelectStmt

test('往返校验：deparse 后重解析与改写语法树不一致即拒绝（CTE 名、窗口名不加引号）；deparse 异常转固定文案',()=>{
 const hostile='x AS(SELECT 1)SELECT*FROM public.teloa_business_object_snapshots--'
 const cte=tampered('with c as (select 1) select 1',ast=>{firstSelect(ast).withClause.ctes[0].CommonTableExpr.ctename=hostile})
 assert.throws(()=>rewriteBusinessSql(cte,actor,'public'),invalidInput)
 const window=tampered('select rank() over w from soc_alert window w as (order by score)',ast=>{
  const select=firstSelect(ast)
  select.windowClause[0].WindowDef.name='w,x'
  select.targetList[0].ResTarget.val.FuncCall.over.name='w,x'
 })
 assert.throws(()=>rewriteBusinessSql(window,actor,'public'),invalidInput)
 const broken=tampered('select 1',ast=>{firstSelect(ast).targetList[0]={NoSuchNode:{}}})
 assert.throws(()=>rewriteBusinessSql(broken,actor,'public'),(error:unknown)=>invalidInput(error)&&(error as WorkError).message==='SQL 过于复杂或无法解析。'||assert.fail(String(error)))
})

test('往返校验不误伤：各类字符串常量（转义、美元引号、Unicode 转义、注释符号）与带引号列名照常改写',()=>{
 for(const sql of [
  "select 'it''s', E'a\\'b\\\\c', $$d ' */ --$$, $t$a$$b$t$, U&'\\0041', 'a\\b', 'x/*', '--', ';' from soc_alert",
  "select severity from soc_alert where severity = E'\\n--' or severity like '%*/%'",
  'with c(k) as (select severity from soc_alert) select c.k from c join soc_ticket t on t.status = c.k',
  'select rank() over (w order by score) from soc_alert window w as (partition by severity)',
 ])rewrite(sql)
})

test('真库：CTE 名注入（修复前会失败：改写产物成为无 owner/scope 过滤的快照表查询，读到其他租户数据）在改写前即拒绝',{timeout:60000},async()=>{
 const victim=randomUUID(),stamp=new Date().toISOString()
 const item={scope:'OTHER',type:'soc-alert',id:'victim-1',version:1,title:'VICTIM-SECRET',source:'EDR',observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'摘要',fields:[]}
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   values($1,'OTHER','soc-alert','victim-1',1,$2,$3,'EDR',$4)`,[victim,businessObjectSnapshotHash(item),JSON.stringify(item),stamp])
 // 攻击者 ownerId 以 0 开头，保证 $1::text<$2（'SOC'）在任何排序规则下成立。
 const attacker={ownerId:'0-attacker',scope:'SOC'}
 const hostile='x AS(SELECT 1)SELECT*FROM public.teloa_business_object_snapshots--'
 const attempts:Array<()=>ReturnType<typeof rewriteBusinessSql>>=[
  ()=>rewriteBusinessSql(analyzeBusinessSql(`with "x AS(SELECT 1)SELECT*FROM/*" as (select 1),
 "*/public.teloa_business_object_snapshots where $1::text<$2--" as (select 1) select 1`,types),attacker,'public'),
  ()=>rewriteBusinessSql(tampered('with c as (select 1) select 1',ast=>{firstSelect(ast).withClause.ctes[0].CommonTableExpr.ctename=hostile}),attacker,'public'),
 ]
 const db=await pool.connect()
 try{
  await db.query('begin read only')
  await db.query('set local search_path=pg_temp')
  for(const attempt of attempts){
   await assert.rejects(async()=>{
    const {sql,params}=attempt()
    const rows=(await db.query(sql,params)).rows
    assert.fail('改写产物进入数据库并返回 '+rows.length+' 行：'+JSON.stringify(rows).slice(0,200))
   },(error:unknown)=>invalidInput(error)||assert.fail(String(error)))
  }
 }finally{await db.query('rollback');db.release()}
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[victim])
})

test('真库：字符串常量经 deparse 后语义不变',{timeout:60000},async()=>{
 const owner=randomUUID()
 await put(owner,'c-1',1,[])
 const {sql,params}=rewriteBusinessSql(analyzeBusinessSql("select 'it''s' as a, E'a\\'b\\\\c' as b, $$d ' */ --$$ as c, U&'\\0041' as d, 'a\\b' as e, E'\\n--' as f from soc_alert",types),{ownerId:owner,scope:'SOC'},'public')
 const db=await pool.connect()
 try{
  await db.query('begin read only')
  await db.query('set local search_path=pg_temp')
  assert.deepEqual((await db.query(sql,params)).rows,[{a:"it's",b:"a'b\\c",c:"d ' */ --",d:'A',e:'a\\b',f:'\n--'}])
 }finally{await db.query('rollback');db.release()}
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[owner])
})

/* ---------- 二期：整页时间范围注入（规格 §3.2、§10） ---------- */

const range=(interval='7 days',logical='soc_alert',column='alerted_at')=>({timeFilter:{logical,column,interval}})
const rangeParamRefs=(sql:string,param:number)=>[...sql.matchAll(new RegExp('\\$'+param+'(?!\\d)','g'))].length
/** 一期改写器（a0760894）对同一条 SQL 的产物原文：`all` / 不传范围时必须与它逐字相同。 */
const phaseOneTicketSql="SELECT status, count(*) AS n FROM ( SELECT s.object_id AS _id, s.object_version AS _version, s.source_id AS _source, s.first_seen_at AS _synced_at, public.teloa_safe_timestamptz(s.snapshot ->> 'observedAt') AS _observed_at, public.teloa_safe_timestamptz(s.snapshot ->> 'deletedAt') AS _deleted_at, (SELECT f ->> 'value' FROM jsonb_array_elements(s.snapshot -> 'fields') AS f WHERE (f ->> 'label') = $4 LIMIT 1) AS alert_id, (SELECT f ->> 'value' FROM jsonb_array_elements(s.snapshot -> 'fields') AS f WHERE (f ->> 'label') = $5 LIMIT 1) AS status FROM ( SELECT * FROM ( SELECT DISTINCT ON (object_id) * FROM public.teloa_business_object_snapshots WHERE owner_id = $1 AND scope_id = $2 AND object_type = $3 ORDER BY object_id, object_version DESC ) AS latest WHERE latest.snapshot ->> 'deletedAt' IS NULL ) AS s ) AS soc_ticket GROUP BY status"

test('范围 all / 不传：产物与一期逐字相同（快照）',()=>{
 const sql='select status, count(*) as n from soc_ticket group by status'
 for(const options of [undefined,{}]){
  const result=rewriteBusinessSql(analyzeBusinessSql(sql,types),actor,'public',options)
  assert.equal(result.sql,phaseOneTicketSql)
  assert.deepEqual(result.params,['owner-1','SOC','soc-ticket','告警','状态'])
 }
})

test('范围 7d：产物只多一个参数、取值 "7 days"；谓词在平台段里、列名按需加引号；往返校验与二次校验通过；区间文本不进 SQL',()=>{
 const base=rewrite(specExample),ranged=rewriteBusinessSql(analyzeBusinessSql(specExample,types),actor,'public',range())
 assert.deepEqual(ranged.params,[...base.params,'7 days'])
 const k=ranged.params.length
 assert.equal(maxParam(ranged.sql),k)
 assert.equal(rangeParamRefs(ranged.sql,k),1)
 const sql=flat(ranged.sql)
 assert.ok(sql.includes(`) as teloa_range where teloa_range.alerted_at >= (now() - cast($${k} as interval)) ) as soc_alert`),ranged.sql)
 assert.equal(ranged.sql.split('7 days').length,base.sql.split('7 days').length,'区间文本只走占位符：产物里的 7 days 只有用户 SQL 自写的那一处')
 // 用户 SQL 自写的时间条件原样保留，与注入谓词叠加。
 assert.ok(sql.includes("alerted_at >= (now() - '7 days'::interval)")||sql.includes("interval '7 days'"),ranged.sql)
 verifyRewrittenBusinessSql(ranged.sql,k,'public')
 const invalid=(run:()=>unknown)=>assert.throws(run,(error:unknown)=>invalidInput(error)||assert.fail(String(error)))
 invalid(()=>verifyRewrittenBusinessSql(ranged.sql,k-1,'public'))
 invalid(()=>verifyRewrittenBusinessSql(ranged.sql.replaceAll('public.',''),k,'public'))
 // 两张表 join 只包被接入的那一张。
 const joined=rewriteBusinessSql(analyzeBusinessSql('select a.severity, t.status from soc_alert a join soc_ticket t on t.alert_id = a._id',types),actor,'public',range())
 assert.equal((joined.sql.match(/teloa_range/g)??[]).length,2,'一处包装：子查询别名 + 谓词限定各一次')
 assert.equal(joined.params.at(-1),'7 days')
 assert.equal(maxParam(joined.sql),joined.params.length)
 // 系统列同样可接入。
 const observed=rewriteBusinessSql(analyzeBusinessSql('select count(*) as n from soc_alert',types),actor,'public',range('30 days','soc_alert','_observed_at'))
 assert.ok(flat(observed.sql).includes('teloa_range._observed_at >= (now()'),observed.sql)
 // 带连字符的字段标识经 identifier() 加引号，deparse 往返后仍是同一个列。
 const hyphen=objectType('soc-alert',[field('first-seen-at','datetime','首次出现')])
 const quoted=rewriteBusinessSql(analyzeBusinessSql('select count(*) as n from soc_alert',[hyphen]),actor,'public',range('7 days','soc_alert','first-seen-at'))
 assert.ok(quoted.sql.includes('teloa_range."first-seen-at" >= (now() - CAST($5 AS interval))'),quoted.sql)
 verifyRewrittenBusinessSql(quoted.sql,quoted.params.length,'public')
})

test('自连接：同一逻辑表两处引用都被过滤，参数只占一个位置',()=>{
 const self=rewriteBusinessSql(analyzeBusinessSql('select a._id from soc_alert a join soc_alert b on a._id = b._id',types),actor,'public',range())
 const k=self.params.length
 assert.equal(self.params.filter(value=>value==='7 days').length,1)
 assert.equal(rangeParamRefs(self.sql,k),2)
 assert.equal((self.sql.match(new RegExp(`teloa_range\\.alerted_at >= \\(now\\(\\) - CAST\\(\\$${k} AS interval\\)\\)`,'g'))??[]).length,2,self.sql)
 verifyRewrittenBusinessSql(self.sql,k,'public')
 // 子查询 / CTE 里再读一次同样过滤。
 const nested=rewriteBusinessSql(analyzeBusinessSql('with c as (select _id from soc_alert) select count(*) as n from c where exists (select 1 from soc_alert x where x._id = c._id)',types),actor,'public',range())
 assert.equal(rangeParamRefs(nested.sql,nested.params.length),2)
})

test('SQL 没有读取接入表 → invalid-input「组件接入了时间范围，但 SQL 没有读取表 X」；列不是该表时间列也拒；用户写 $n 仍在分析阶段拒',()=>{
 const reason=(message:RegExp)=>(error:unknown)=>invalidInput(error)&&message.test((error as WorkError).message)||assert.fail(String(error))
 assert.throws(()=>rewriteBusinessSql(analyzeBusinessSql('select status from soc_ticket',types),actor,'public',range()),reason(/^组件接入了时间范围，但 SQL 没有读取表 soc_alert/))
 assert.throws(()=>rewriteBusinessSql(analyzeBusinessSql('select now() as n',types),actor,'public',range()),reason(/没有读取表 soc_alert/))
 // CTE 不能与业务对象表同名（守卫既有规则）：用户没法用 CTE 冒充被接入的表、绕过注入段。
 assert.throws(()=>analyzeBusinessSql('with soc_alert as (select 1 as n) select n from soc_alert',types),reason(/重名/))
 for(const column of ['score','severity','_id','_deleted_at','nope'])
  assert.throws(()=>rewriteBusinessSql(analyzeBusinessSql('select count(*) as n from soc_alert',types),actor,'public',range('7 days','soc_alert',column)),reason(/时间/),column)
 for(const sql of ['select count(*) as n from soc_alert where alerted_at >= now() - $4::interval','select $1 as a from soc_alert','select count(*) as n from soc_alert where _id = $10'])
  assert.throws(()=>analyzeBusinessSql(sql,types),reason(/参数占位符/),sql)
})

test('区间被篡改：取值只作参数，永不进 SQL 文本',()=>{
 const hostile="7 days') or true --"
 const result=rewriteBusinessSql(analyzeBusinessSql('select count(*) as n from soc_alert',types),actor,'public',range(hostile))
 assert.ok(!result.sql.includes(hostile)&&!result.sql.includes('or true'))
 assert.equal(result.params.at(-1),hostile)
 assert.equal(maxParam(result.sql),result.params.length)
})

test('真库：14 天数据，7 天范围只计窗口内对象，边界对象（恰为 now()-7 天）计入，脏时间值被排除；all 全计；别名 / CTE 同名 teloa_range 盖不掉注入段',{timeout:60000},async()=>{
 const owner=randomUUID(),at=(hours:number)=>new Date(Date.now()-hours*HOUR).toISOString()
 // 第 0..13 天各一条（再往前挪 1 小时，远离边界）：7 天窗口内恰 7 条。
 for(let day=0;day<14;day++)await put(owner,'day-'+day,1,[{label:'告警时间',value:at(day*24+1)},{label:'严重度',value:'high'}])
 await put(owner,'dirty',1,[{label:'告警时间',value:'n/a'},{label:'严重度',value:'high'}])
 await put(owner,'missing',1,[{label:'严重度',value:'high'}])
 // 旧版本在窗口内、当前版本在窗口外：当前版本条件先于时间条件，不得被旧版本捞回。
 await put(owner,'moved',1,[{label:'告警时间',value:at(2)}])
 await put(owner,'moved',2,[{label:'告警时间',value:at(20*24)}])
 const q=(sql:string,options?:Parameters<typeof rewriteBusinessSql>[3])=>rewriteBusinessSql(analyzeBusinessSql(sql,types),{ownerId:owner,scope:'SOC'},'public',options)
 const db=await pool.connect()
 try{
  await db.query('begin')
  // 边界对象的告警时间取本事务的 now()-7 天：事务内 now() 固定，与注入谓词里的 now() 同值。
  const edge=(await db.query(`select to_char((now() - interval '7 days') at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as edge`)).rows[0].edge as string
  const item={scope:'SOC',type:'soc-alert',id:'edge',version:1,title:'告警 edge',source:'EDR',observedAt:at(1),receivedAt:at(1),quality:'complete' as const,summary:'摘要',fields:[{label:'告警时间',value:edge}]}
  await db.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values($1,'SOC','soc-alert','edge',1,$2,$3,'EDR',now())`,[owner,businessObjectSnapshotHash(item),JSON.stringify(item)])
  await db.query('set local search_path=pg_temp')
  const ids=async(rewritten:ReturnType<typeof rewriteBusinessSql>)=>(await db.query(rewritten.sql,rewritten.params)).rows.map(row=>String(row._id)).sort()
  const week=await ids(q('select _id from soc_alert order by _id',range()))
  assert.deepEqual(week,['day-0','day-1','day-2','day-3','day-4','day-5','day-6','edge'])
  assert.equal((await ids(q('select _id from soc_alert'))).length,14+4,'all：全部当前对象（含脏值、缺值、边界、移出窗口的）')
  assert.deepEqual(await ids(q('select _id from soc_alert',range('24 hours'))),['day-0'])
  // 用户 SQL 把表别名写成 teloa_range、或写同名 CTE，都盖不掉注入段：结果与上面一致。
  assert.deepEqual(await ids(q('select teloa_range._id from soc_alert teloa_range',range())),week)
  assert.deepEqual(await ids(q('with teloa_range as (select _id from soc_alert) select a._id from soc_alert a join teloa_range r on r._id = a._id',range())),week)
  // 用户自写更宽的条件也放不出窗口外的对象；更窄的条件与注入谓词叠加。
  assert.deepEqual(await ids(q("select _id from soc_alert where alerted_at >= now() - interval '30 days' or alerted_at is null",range())),week)
  assert.deepEqual(await ids(q("select _id from soc_alert where alerted_at >= now() - interval '2 days'",range())),['day-0','day-1'])
  // 自连接两侧都被过滤。
  assert.deepEqual(await ids(q('select a._id from soc_alert a join soc_alert b on a._id = b._id',range())),week)
  // 篡改的区间文本在库里只是一个非法的 interval 参数值：整条报错，不改变语义。
  await db.query('savepoint hostile')
  await assert.rejects(db.query(q('select _id from soc_alert',range("7 days') or true --")).sql,q('select _id from soc_alert',range("7 days') or true --")).params),(error:{code?:string})=>error.code==='22007')
  await db.query('rollback to savepoint hostile')
 }finally{await db.query('rollback');db.release()}
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[owner])
})
