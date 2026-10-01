import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {DatabaseError,Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,type BusinessObjectTypeDefinition} from '@teloa/contract'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {analyzeBusinessSql,prepareBusinessSqlParser} from '../src/work/business-sql-guard.ts'
import {rewriteBusinessSql,type BusinessSqlRewrite} from '../src/work/business-sql-rewrite.ts'
import {BusinessSqlExecutor,businessSqlExecutionDefaults,businessSqlParserMajor,businessSqlPoolConfig,businessSqlPoolSize,businessSqlLegacyReaderRole,businessSqlReaderRoleOf,businessSqlServerSupport,initializeBusinessSqlRole} from '../src/work/business-sql-executor.ts'

/**
 * 执行边界真库负例：执行器是白名单与改写器之后的第二道防线，这里大多**直接构造 rewrite 对象绕过白名单**，只测执行器自身兜得住。
 */

/** pool：应用侧（超级用户，等价个人版 teloa）；reader：执行器专用连接池，按初始化写下的口令文件以只读角色直接登录。 */
let container:StartedPostgreSqlContainer,pool:Pool,reader:Pool,secretDir:string,secretPath:string,readerPassword:string,readerRole:string,readerFile:string
const identity={now:()=>new Date().toISOString()}
const hash='a'.repeat(64)
before(async()=>{
 await prepareBusinessSqlParser()
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 secretDir=await mkdtemp(join(tmpdir(),'teloa-t9-'))
 secretPath=join(secretDir,'business-sql-reader.json')
 const status=await initializeTeloaDatabase(pool,{businessSqlSecretPath:secretPath})
 assert.equal(status.businessSqlRole?.mode,'role',status.businessSqlRole?.reason)
 readerRole=status.businessSqlRole.role!
 assert.equal(readerRole,businessSqlReaderRoleOf(container.getDatabase(),'public'))
 readerFile=join(secretDir,'business-sql-reader.'+readerRole.slice(businessSqlLegacyReaderRole.length+1)+'.json')
 readerPassword=JSON.parse(await readFile(readerFile,'utf8')).password
 reader=new Pool(await businessSqlPoolConfig({connectionString:container.getConnectionUri()},status.businessSqlRole,secretPath))
 for(const [owner,id] of [['owner-1','alert-1'],['owner-1','alert-2'],['owner-2','secret-2']] as const)
  await pool.query(`insert into public.teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values($1,'SOC','soc-alert',$2,1,$3,$4,'EDR',now())`,[owner,id,hash,JSON.stringify({fields:[{label:'严重度',value:owner==='owner-2'?'机密':'high'}]})])
},{timeout:120000})
after(async()=>{await reader?.end();await pool?.end();await container?.stop();if(secretDir)await rm(secretDir,{recursive:true,force:true})})

const raw=(sql:string,params:string[]=[]):BusinessSqlRewrite=>({sql,params,tables:[]})
const rejectsWith=async(promise:Promise<unknown>,code:string,reason?:RegExp,absent:string[]=[])=>{
 await assert.rejects(promise,(error:unknown)=>{
  assert.ok(error instanceof WorkError,String(error))
  assert.equal(error.code,code,error.message)
  if(reason)assert.match(error.message,reason)
  for(const text of absent)assert.ok(!error.message.includes(text),'报错文本不得带出 '+text+'：'+error.message)
  return true
 })
}
const poolAs=(user:string,password:string,max?:number)=>new Pool({host:container.getHost(),port:container.getPort(),database:container.getDatabase(),user,password,...(max?{max}:{})})
const soc:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',id:'soc-alert',version:'1',domain:'SOC',title:'告警',unit:'条',lead:'说明',sourceId:'soc',fields:[{name:'severity',label:'严重度',type:'enum',required:false,from:'严重度'}]}
const readerAs=(max?:number)=>poolAs(readerRole,readerPassword,max)
const executor=()=>new BusinessSqlExecutor(reader,identity,'role')

test('初始化只读角色：超级用户落 role、口令文件 0600 且复用、口令不入回包、专用池以只读角色登录、权限只到快照表与安全函数',{timeout:30000},async()=>{
 const before=await readFile(readerFile,'utf8')
 const again=await initializeBusinessSqlRole(pool,secretPath)
 assert.deepEqual(again,{mode:'role',skippedSettings:[],schema:'public',role:readerRole})
 assert.equal(await readFile(readerFile,'utf8'),before)
 assert.equal((await stat(readerFile)).mode&0o777,0o600)
 assert.ok(!JSON.stringify(again).includes(readerPassword))
 assert.match(readerPassword,/^[A-Za-z0-9_-]{43}$/)
 const role=(await pool.query('select rolcanlogin, rolsuper, rolcreaterole, rolcreatedb, rolbypassrls from pg_roles where rolname=$1',[readerRole])).rows[0]
 assert.deepEqual(role,{rolcanlogin:true,rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false})
 // 存的是 SCRAM 校验值，不是明文。
 assert.match((await pool.query('select rolpassword from pg_authid where rolname=$1',[readerRole])).rows[0].rolpassword,/^SCRAM-SHA-256\$/)
 assert.equal(reader.options.max,businessSqlPoolSize)
 assert.deepEqual((await reader.query("select session_user::text as s, current_user::text as c, current_setting('temp_file_limit') as t")).rows[0],{s:readerRole,c:readerRole,t:businessSqlExecutionDefaults.tempFileLimit})
 const db=await pool.connect()
 const inReaderTransaction=async(sql:string,params:unknown[]=[])=>{
  await db.query('begin');await db.query('set local role '+readerRole)
  try{return await db.query(sql,params)}finally{await db.query('rollback')}
 }
 try{
  await assert.rejects(inReaderTransaction('select * from public.teloa_business_sync_runs'),{code:'42501'})
  assert.equal((await inReaderTransaction('select count(*)::int as n from public.teloa_business_object_snapshots where owner_id=$1 and scope_id=$2',['owner-1','SOC'])).rows[0].n,2)
  assert.equal(Number((await inReaderTransaction("select public.teloa_safe_numeric('1') as n")).rows[0].n),1)
 }finally{db.release()}
})

test('超时：pg_sleep(6) 在 5 秒中止，pg_sleep(0.1) 正常',{timeout:30000},async()=>{
 await rejectsWith(executor().execute('SOC',raw('select pg_sleep(6)')),'teloa/dependency-unavailable',/^查询超过 5 秒已中止$/)
 const ok=await executor().execute('SOC',raw('select pg_sleep(0.1) as slept'))
 assert.deepEqual(ok.columns,[{name:'slept',type:'null'}])
 assert.deepEqual(ok.rows,[[null]])
})

test('行数上限：10 000 行通过、10 001 行拒绝',{timeout:30000},async()=>{
 const ok=await executor().execute('SOC',raw('select g from generate_series(1,10000) g'))
 assert.equal(ok.rowCount,10000)
 assert.equal(ok.rows.length,10000)
 assert.deepEqual(ok.columns,[{name:'g',type:'number'}])
 assert.equal(ok.rows[9999]![0],10000)
 assert.equal(ok.throttled,false)
 assert.ok(ok.bytes>0)
 await rejectsWith(executor().execute('SOC',raw('select g from generate_series(1,10001) g')),'teloa/invalid-input',/^结果超过 10 000 行$/)
 // 用户 SQL 以行注释收尾也注释不掉外包的 limit：外包另起一行。
 await rejectsWith(executor().execute('SOC',raw('select g from generate_series(1,10001) g --')),'teloa/invalid-input',/^结果超过 10 000 行$/)
})

test('字节上限：单行超 1 MB 拒绝、略小于 1 MB 通过、累计超 8 MB 中止',{timeout:30000},async()=>{
 await rejectsWith(executor().execute('SOC',raw("select repeat('x',1024*1024+1) as big")),'teloa/invalid-input',/^单行超过 1 MB$/)
 const ok=await executor().execute('SOC',raw("select repeat('x',1024*1024-100) as big"))
 assert.equal(ok.rowCount,1)
 assert.equal((ok.rows[0]![0] as string).length,1024*1024-100)
 await rejectsWith(executor().execute('SOC',raw("select g, repeat('x',900*1024) as big from generate_series(1,10) g")),'teloa/invalid-input',/^结果超过 8 MB$/)
 // 中止后连接照常可用（取消的是那条语句，连接归还连接池前已回滚）。
 assert.equal((await executor().execute('SOC',raw('select 1 as one'))).rows[0]![0],1)
})

test('临时文件上限：超出 temp_file_limit → 查询临时文件超限（role 模式由角色级设置固定，只读角色自己改不动）',{timeout:30000},async()=>{
 await pool.query(`alter role ${readerRole} set temp_file_limit='1MB'`)
 const fresh=readerAs()
 try{
  const small=new BusinessSqlExecutor(fresh,identity,'role',{...businessSqlExecutionDefaults,workMem:'64kB'})
  await rejectsWith(small.execute('SOC',raw('select count(*) as n from (select g from generate_series(1,300000) g order by g desc) s')),'teloa/dependency-unavailable',/^查询临时文件超限$/)
 }finally{await fresh.end();await initializeBusinessSqlRole(pool,secretPath)}
})

test('并发：同范围前 5 条并行、第 6 条排队后完成；排队超时报错；不同范围互不影响',{timeout:30000},async()=>{
 // 全局上限放宽到 6（池上限 10），这里只测每范围信号量；全局信号量另有用例。
 const wide={...businessSqlExecutionDefaults,concurrencyTotal:6},roomy=readerAs(10)
 const shared=new BusinessSqlExecutor(roomy,identity,'role',wide),started=Date.now()
 const batch=Array.from({length:6},()=>shared.execute('SOC',raw('select pg_sleep(1) as s')))
 await new Promise(resolve=>setTimeout(resolve,50))
 assert.equal(shared.pending('SOC'),1)
 assert.equal(shared.pending('OTHER'),0)
 const results=await Promise.all(batch)
 const elapsed=Date.now()-started
 assert.ok(elapsed<3000,'耗时 '+elapsed)
 assert.equal(results.filter(result=>result.throttled).length,1)
 assert.equal(shared.pending('SOC'),0)

 const hurried=new BusinessSqlExecutor(roomy,identity,'role',{...wide,queueWaitMs:100})
 const settled=await Promise.allSettled(Array.from({length:6},()=>hurried.execute('SOC',raw('select pg_sleep(1) as s'))))
 const rejected=settled.filter(result=>result.status==='rejected')
 assert.equal(rejected.length,1)
 const reason=(rejected[0] as PromiseRejectedResult).reason
 assert.ok(reason instanceof WorkError)
 assert.equal(reason.code,'teloa/dependency-unavailable')
 assert.equal(reason.message,'查询排队超时')

 const isolated=new BusinessSqlExecutor(roomy,identity,'role',wide),begun=Date.now()
 await Promise.all([...Array.from({length:5},()=>isolated.execute('SOC',raw('select pg_sleep(1) as s'))),isolated.execute('OTHER',raw('select pg_sleep(1) as s'))])
 assert.ok(Date.now()-begun<1900,'不同范围不应排队')
 await roomy.end()
})

test('中止信号：排队中与执行中都能中止，连接照常可用',{timeout:30000},async()=>{
 const controller=new AbortController(),running=executor().execute('SOC',raw('select pg_sleep(3) as s'),controller.signal)
 setTimeout(()=>controller.abort(),200)
 const started=Date.now()
 await rejectsWith(running,'teloa/dependency-unavailable',/^查询已中止$/)
 assert.ok(Date.now()-started<2000)
 const single=new BusinessSqlExecutor(reader,identity,'role',{...businessSqlExecutionDefaults,concurrencyPerScope:1}),queued=new AbortController()
 const first=single.execute('SOC',raw('select pg_sleep(0.5) as s')),second=single.execute('SOC',raw('select 1 as one'),queued.signal)
 await new Promise(resolve=>setTimeout(resolve,50))
 assert.equal(single.pending('SOC'),1)
 queued.abort()
 await rejectsWith(second,'teloa/dependency-unavailable',/^查询已中止$/)
 assert.equal(single.pending('SOC'),0)
 await first
 const aborted=new AbortController();aborted.abort()
 await rejectsWith(executor().execute('SOC',raw('select 1 as one'),aborted.signal),'teloa/dependency-unavailable',/^查询已中止$/)
})

test('now() 固化：一条语句里前后两次 now() 相等且等于 computedAt',{timeout:30000},async()=>{
 const result=await executor().execute('SOC',raw('select now() as a, pg_sleep(0.5), now() as b'))
 assert.deepEqual(result.columns.map(column=>column.type),['datetime','null','datetime'])
 assert.equal(result.rows[0]![0],result.rows[0]![2])
 assert.equal(result.rows[0]![0],result.computedAt)
 assert.match(result.computedAt,/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
})

test('search_path=pg_temp 与限定名自洽：未限定表/函数找不到，限定的改写产物形态正常',{timeout:30000},async()=>{
 const schemas=await executor().execute('SOC',raw('select current_schemas(true)::text as s'))
 assert.ok(!String(schemas.rows[0]![0]).includes('public'),String(schemas.rows[0]![0]))
 await rejectsWith(executor().execute('SOC',raw('select * from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2',['owner-1','SOC'])),'teloa/invalid-input',/42P01/,['teloa_business_object_snapshots'])
 const qualified=await executor().execute('SOC',raw('select _id from (select object_id as _id from public.teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3) s order by _id',['owner-1','SOC','soc-alert']))
 assert.deepEqual(qualified.rows,[['alert-1'],['alert-2']])
 const stamp=await executor().execute('SOC',raw("select public.teloa_safe_timestamptz('2026-01-01T00:00:00.000Z') as t"))
 assert.deepEqual(stamp.rows,[['2026-01-01T00:00:00.000Z']])
 await rejectsWith(executor().execute('SOC',raw("select teloa_safe_timestamptz('2026-01-01T00:00:00.000Z') as t")),'teloa/invalid-input',/42883/,['teloa_safe_timestamptz'])
})

test('无表查询：改写产物不带平台参数，常量与 union 照常执行；有表查询仍按本人范围',{timeout:30000},async()=>{
 const run=(sql:string)=>executor().execute('SOC',rewriteBusinessSql(analyzeBusinessSql(sql,[soc]),{ownerId:'owner-1',scope:'SOC'},'public'))
 assert.deepEqual((await run('select 42 as n')).rows,[[42]])
 assert.deepEqual((await run("select 'a' as k union all select 'b' order by k")).rows,[['a'],['b']])
 assert.deepEqual((await run('select count(*) as n from soc_alert')).rows,[[2]])
})

test('跨 owner：改写产物只读本人行；越出快照表的读取在 role 模式被只读角色拒绝；报错不带出他人数据',{timeout:30000},async()=>{
 const own=rewriteBusinessSql(analyzeBusinessSql('select _id, severity from soc_alert order by _id',[soc]),{ownerId:'owner-1',scope:'SOC'},'public')
 const result=await executor().execute('SOC',own)
 assert.deepEqual(result.rows,[['alert-1','high'],['alert-2','high']])
 assert.deepEqual(result.columns,[{name:'_id',type:'text'},{name:'severity',type:'text'}])
 const probe=rewriteBusinessSql(analyzeBusinessSql("select _id from soc_alert where _id = 'secret-2'",[soc]),{ownerId:'owner-1',scope:'SOC'},'public')
 assert.deepEqual((await executor().execute('SOC',probe)).rows,[])
 await rejectsWith(executor().execute('SOC',raw('select owner_id, status from public.teloa_business_sync_runs')),'teloa/forbidden',/^当前主体未获准读取此业务范围$/,['teloa_business_sync_runs'])
 // 类型转换错误的 PG 原文会带出取值：统一改为固定文案。
 await rejectsWith(executor().execute('SOC',raw("select (select snapshot->'fields'->0->>'value' from public.teloa_business_object_snapshots where object_id='secret-2')::int as v")),'teloa/invalid-input',/22P02/,['机密'])
})

test('写操作：只读事务拒绝（写函数、nextval）',{timeout:30000},async()=>{
 await pool.query('create table if not exists public.t9_sink(v int)')
 await pool.query('create sequence if not exists public.t9_seq')
 await pool.query('create or replace function public.t9_write() returns int language sql as $$ insert into public.t9_sink values(1) returning v $$')
 // fallback 只允许非超级用户（托管库）：用一个有写权限的普通用户证明只读事务这一道。
 await pool.query("create role t9_plain login password 't9_plain'")
 await pool.query('grant insert on public.t9_sink to t9_plain')
 await pool.query('grant usage on sequence public.t9_seq to t9_plain')
 const plain=poolAs('t9_plain','t9_plain')
 try{
  await rejectsWith(new BusinessSqlExecutor(plain,identity,'fallback').execute('SOC',raw('select public.t9_write() as w')),'teloa/forbidden',/只允许读取/)
  await rejectsWith(new BusinessSqlExecutor(plain,identity,'fallback').execute('SOC',raw("select nextval('public.t9_seq') as n")),'teloa/forbidden',/只允许读取/)
 }finally{await plain.end()}
 // role 模式下两道防线叠加：只读角色连序列的使用权都没有，先于只读事务报 42501。
 await rejectsWith(executor().execute('SOC',raw("select nextval('public.t9_seq') as n")),'teloa/forbidden')
 await rejectsWith(executor().execute('SOC',raw('select public.t9_write() as w')),'teloa/forbidden')
 // 多语句在扩展协议下直接被 PG 拒绝，外包也保证只能是一条 select。
 await rejectsWith(executor().execute('SOC',raw('select 1) q; delete from public.t9_sink; select (1')),'teloa/invalid-input')
 assert.equal((await pool.query('select count(*)::int as n from public.t9_sink')).rows[0].n,0)
})

test('set_config 企图：改角色/改会话参数被识破并回滚、超级用户级参数被拒、运行中改超时无效、改只读被拒',{timeout:30000},async()=>{
 const session=(await pool.query('select session_user as u')).rows[0].u as string
 // 只读角色不是超级用户的成员，切不过去（42501）。
 await rejectsWith(executor().execute('SOC',raw(`select set_config('role','${session}',true) as r`)),'teloa/forbidden',/^当前主体未获准读取此业务范围$/)
 await rejectsWith(executor().execute('SOC',raw("select set_config('temp_file_limit','-1',true) as r")),'teloa/forbidden',/^当前主体未获准读取此业务范围$/)
 await rejectsWith(executor().execute('SOC',raw("select set_config('transaction_read_only','off',true) as r")),'teloa/invalid-input',/25001/)
 // 会话级 set_config(…,false)：事务回滚把它撤销，连接回到连接池时是干净的。
 const single=readerAs(2)
 try{
  const guarded=new BusinessSqlExecutor(single,identity,'role',{...businessSqlExecutionDefaults,concurrencyTotal:1})
  const before=(await single.query("select current_setting('work_mem') as w, current_setting('search_path') as p")).rows[0]
  await rejectsWith(guarded.execute('SOC',raw("select set_config('work_mem','1GB',false) as a, set_config('search_path','public',false) as b")),'teloa/forbidden',/执行边界/)
  assert.deepEqual((await single.query("select current_setting('work_mem') as w, current_setting('search_path') as p")).rows[0],before)
 }finally{await single.end()}
 // 语句中途把 statement_timeout 改成 0 不会解除已在计时的超时。
 await rejectsWith(executor().execute('SOC',raw("select set_config('statement_timeout','0',true) as t, pg_sleep(6) as s")),'teloa/dependency-unavailable',/^查询超过 5 秒已中止$/)
})

/** 包一层 PoolClient.query：文本命中 pattern 的语句抛 42501，其余照常。专用连接池，用完即关。 */
const stubbedPool=(pattern:RegExp)=>{
 const stubbed=readerAs()
 const connect=stubbed.connect.bind(stubbed) as ()=>Promise<PoolClient>
 ;(stubbed as unknown as {connect:()=>Promise<PoolClient>}).connect=async()=>{
  const client=await connect(),query=client.query.bind(client) as (...args:unknown[])=>unknown
  ;(client as unknown as {query:(...args:unknown[])=>unknown}).query=(...args:unknown[])=>typeof args[0]==='string'&&pattern.test(args[0])?Promise.reject(Object.assign(new DatabaseError('permission denied',0,'error'),{code:'42501'})):query(...args)
  return client
 }
 return stubbed
}

test('SET 阶段 42501：work_mem 跳过并只告警一次；search_path 不许跳过',{timeout:30000},async(t)=>{
 const warn=t.mock.method(console,'warn',()=>{})
 const warned=(pattern:RegExp)=>warn.mock.calls.filter(call=>pattern.test(String(call.arguments[0]))).length
 const memDenied=stubbedPool(/^set local work_mem/)
 try{
  const subject=new BusinessSqlExecutor(memDenied,identity,'role')
  assert.deepEqual((await subject.execute('SOC',raw('select 1 as one'))).rows,[[1]])
  assert.deepEqual([...subject.skippedSettings],['work_mem'])
  assert.equal(warned(/work_mem/),1)
  await subject.execute('SOC',raw('select 1 as one'))
  assert.equal(warned(/work_mem/),1)
 }finally{await memDenied.end()}

 const pathDenied=stubbedPool(/^set local search_path/)
 try{await assert.rejects(new BusinessSqlExecutor(pathDenied,identity,'role').execute('SOC',raw('select 1 as one')),WorkError)}finally{await pathDenied.end()}
})

test('三种环境：无 createrole → fallback（非超级用户允许降级并告警）；建表方=建角色方 → role 且以只读角色登录；角色被他人建过、当前用户无 ADMIN → fallback',{timeout:60000},async(t)=>{
 const warn=t.mock.method(console,'warn',()=>{})
 await reader.end()
 const dropReader=async()=>{await pool.query('drop owned by '+readerRole);await pool.query('drop role '+readerRole)}
 const otherSecret=join(secretDir,'other.json')
 // (a) 无 createrole：降级为事务只读；temp_file_limit 是超级用户级参数，普通用户真实地被跳过。
 await pool.query("create role limited login password 'limited'")
 await pool.query('grant select, insert on public.teloa_business_object_snapshots, public.t9_sink to limited')
 const limited=poolAs('limited','limited')
 try{
  const status=await initializeBusinessSqlRole(limited,otherSecret)
  assert.equal(status.mode,'fallback')
  assert.match(status.reason!,/createrole/)
  assert.deepEqual(status.skippedSettings,['temp_file_limit'])
  assert.ok(warn.mock.calls.some(call=>/降级为事务只读/.test(String(call.arguments[0]))))
  const fallback=new BusinessSqlExecutor(limited,identity,'fallback')
  await rejectsWith(fallback.execute('SOC',raw('select public.t9_write() as w')),'teloa/forbidden',/只允许读取/)
  assert.deepEqual((await fallback.execute('SOC',raw('select count(*)::int as n from public.teloa_business_object_snapshots'))).rows,[[3]])
 }finally{await limited.end()}

 // (b) 有 createrole、非超级用户，快照表归它所有：自己建的角色自带 ADMIN，能设登录口令；专用池以只读角色登录。
 await dropReader()
 await pool.query("create role creator login createrole password 'creator'")
 await pool.query('alter table public.teloa_business_object_snapshots owner to creator')
 const creator=poolAs('creator','creator')
 try{
  const status=await initializeBusinessSqlRole(creator,otherSecret)
  assert.equal(status.mode,'role',status.reason)
  // 非超级用户不能给只读角色设超级用户级参数 temp_file_limit：如实列出（PG15+ 的 public 本就不许 PUBLIC 建对象，无需收回）。
  assert.deepEqual(status.skippedSettings,['temp_file_limit'])
  const creatorReader=new Pool(await businessSqlPoolConfig({host:container.getHost(),port:container.getPort(),database:container.getDatabase(),user:'creator',password:'creator'},{mode:'role',role:readerRole},otherSecret))
  try{
   const subject=new BusinessSqlExecutor(creatorReader,identity,'role')
   assert.deepEqual((await subject.execute('SOC',raw('select current_user::text as u, session_user::text as s'))).rows,[[readerRole,readerRole]])
   assert.deepEqual((await subject.execute('SOC',raw('select object_id from public.teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 order by object_id',['owner-1','SOC']))).rows,[['alert-1'],['alert-2']])
  }finally{await creatorReader.end()}

  // (c) 角色由超级用户建好、creator 没有 ADMIN：设不了登录口令 → fallback。
  await dropReader()
  await pool.query('create role '+readerRole+' nologin')
  const again=await initializeBusinessSqlRole(creator,otherSecret)
  assert.equal(again.mode,'fallback')
  assert.match(again.reason!,/登录口令/)
 }finally{await creator.end()}
 // 复原：超级用户重新初始化（沿用口令文件），后续用例仍按 role 模式。
 assert.equal((await initializeBusinessSqlRole(pool,secretPath)).mode,'role')
 reader=new Pool(await businessSqlPoolConfig({connectionString:container.getConnectionUri()},{mode:'role',role:readerRole},secretPath))
})

test('只读角色直接登录：语句内 set_config 把 role 改回 none 也拿不到更高权限（session_user 就是只读角色）',{timeout:30000},async()=>{
 const result=await executor().execute('SOC',raw("select set_config('role','none',true) as r, has_table_privilege('public.teloa_business_sync_runs','select') as p, current_user::text as u, session_user::text as s"))
 assert.deepEqual(result.rows,[['none',false,readerRole,readerRole]])
})

test('超级用户不许降级：只读角色不可用 → unavailable；执行器在超级用户会话上一律拒绝，固定文案、原因只进服务端日志',{timeout:30000},async(t)=>{
 const warn=t.mock.method(console,'warn',()=>{})
 // 初始化走 pool.query：在 query 上包一层，alter role 一律 42501（等价「只读角色设不了登录口令」）。
 const loginDenied=new Pool({connectionString:container.getConnectionUri()}),query=loginDenied.query.bind(loginDenied) as (...args:unknown[])=>unknown
 ;(loginDenied as unknown as {query:(...args:unknown[])=>unknown}).query=(...args:unknown[])=>typeof args[0]==='string'&&/^alter role/.test(args[0])?Promise.reject(Object.assign(new DatabaseError('permission denied',0,'error'),{code:'42501'})):query(...args)
 try{
  const status=await initializeBusinessSqlRole(loginDenied,secretPath)
  assert.equal(status.mode,'unavailable')
  assert.match(status.reason!,/登录口令/)
  assert.ok(warn.mock.calls.some(call=>/看板查询不可用/.test(String(call.arguments[0]))))
 }finally{await loginDenied.end()}
 for(const [mode,logged] of [['fallback',/超级用户/],['role',/不是只读角色/],['unavailable',undefined]] as const){
  warn.mock.resetCalls()
  await rejectsWith(new BusinessSqlExecutor(pool,identity,mode).execute('SOC',raw('select 1 as one')),'teloa/dependency-unavailable',/^看板查询暂不可用$/)
  if(logged)assert.ok(warn.mock.calls.some(call=>logged.test(String(call.arguments[0]))),mode)
 }
 // 未给口令文件位置（如安装期初始化）：不建登录、不告警，状态为 unavailable。
 assert.equal((await initializeBusinessSqlRole(pool)).mode,'unavailable')
})

test('只读角色被预先加了权限：超级用户初始化把属性纠正回最小；带角色成员资格 → unavailable；会话用户是超级用户的只读角色 → 执行拒绝',{timeout:30000},async(t)=>{
 const warn=t.mock.method(console,'warn',()=>{})
 const attributes='select rolsuper, rolcreatedb, rolcreaterole, rolinherit, rolreplication, rolbypassrls, rolconnlimit from pg_roles where rolname=$1'
 try{
  // ③ 预建同名角色带多余属性：超级用户路径显式收回。
  await pool.query(`alter role ${readerRole} createdb createrole inherit replication bypassrls connection limit -1`)
  assert.equal((await initializeBusinessSqlRole(pool,secretPath)).mode,'role')
  assert.deepEqual((await pool.query(attributes,[readerRole])).rows[0],{rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolinherit:false,rolreplication:false,rolbypassrls:false,rolconnlimit:8})
  // ② 属于 pg_read_all_data：探测时发现成员资格，超级用户环境不降级 → unavailable。
  await pool.query(`grant pg_read_all_data to ${readerRole}`)
  const member=await initializeBusinessSqlRole(pool,secretPath)
  assert.equal(member.mode,'unavailable')
  assert.match(member.reason!,/成员资格/)
  await pool.query(`revoke pg_read_all_data from ${readerRole}`)
  // ① 只读角色本身被提成超级用户：执行时核对会话用户属性，固定文案拒绝，原因只进日志。
  await pool.query(`alter role ${readerRole} superuser`)
  warn.mock.resetCalls()
  await rejectsWith(executor().execute('SOC',raw('select 1 as one')),'teloa/dependency-unavailable',/^看板查询暂不可用$/)
  assert.ok(warn.mock.calls.some(call=>/超级用户/.test(String(call.arguments[0]))))
 }finally{
  await pool.query(`revoke pg_read_all_data from ${readerRole}`).catch(()=>{})
  assert.equal((await initializeBusinessSqlRole(pool,secretPath)).mode,'role')
 }
 assert.equal((await pool.query('select rolsuper from pg_roles where rolname=$1',[readerRole])).rows[0].rolsuper,false)
})

test('PUBLIC 的 create：Teloa 专用 schema 上收回；public 是整库共用的命名空间，不替同库其他应用收回，只列入 skippedSettings',{timeout:30000},async()=>{
 await pool.query('grant create on schema public to public')
 try{
  const status=await initializeBusinessSqlRole(pool,secretPath)
  assert.equal(status.mode,'role')
  assert.deepEqual(status.skippedSettings,['public_schema_create'])
  assert.equal((await pool.query("select has_schema_privilege('public','public','create') as c")).rows[0].c,true)
 }finally{await pool.query('revoke create on schema public from public')}
 await pool.query('create schema teloa_owned')
 const url=new URL(container.getConnectionUri());url.searchParams.set('options','-c search_path=teloa_owned')
 const owned=new Pool({connectionString:url.toString()})
 try{
  await pool.query('grant create on schema teloa_owned to public')
  const status=await initializeTeloaDatabase(owned,{businessSqlSecretPath:secretPath})
  assert.equal(status.businessSqlRole.mode,'role',status.businessSqlRole.reason)
  assert.deepEqual(status.businessSqlRole.skippedSettings,[])
  assert.equal((await pool.query("select has_schema_privilege('public','teloa_owned','create') as c")).rows[0].c,false)
 }finally{await owned.end()}
})

test('口令文件：解析失败只报固定文案不带原文；属主不是当前进程用户拒绝；新建不留临时文件',{timeout:30000},async(t)=>{
 const config={connectionString:container.getConnectionUri()}
 const broken=join(secretDir,'broken.json')
 await writeFile(join(secretDir,'broken.'+readerRole.slice(businessSqlLegacyReaderRole.length+1)+'.json'),'{"password":"x9leak',{mode:0o600})
 await rejectsWith(businessSqlPoolConfig(config,{mode:'role',role:readerRole},broken),'teloa/storage-unavailable',/^只读角色口令文件格式不正确$/,['x9leak'])
 const uid=process.getuid!()
 t.mock.method(process as {getuid:()=>number},'getuid',()=>uid+1)
 await rejectsWith(businessSqlPoolConfig(config,{mode:'role',role:readerRole},secretPath),'teloa/storage-unavailable',/身份或权限/)
 t.mock.restoreAll()
 const freshDir=await mkdtemp(join(tmpdir(),'teloa-t9-fresh-'))
 try{
  assert.equal((await initializeBusinessSqlRole(pool,join(freshDir,'reader.json'))).mode,'role')
  const file='reader.'+readerRole.slice(businessSqlLegacyReaderRole.length+1)+'.json'
  assert.deepEqual(await readdir(freshDir),[file])
  assert.equal((await stat(join(freshDir,file))).mode&0o777,0o600)
 }finally{
  await rm(freshDir,{recursive:true,force:true})
  // 复原只读角色口令为 secretPath 对应口令文件里的那一份。
  assert.equal((await initializeBusinessSqlRole(pool,secretPath)).mode,'role')
 }
})

test('数据库与解析器主版本：14 以下与高于解析器一律拒绝；低于解析器放行并只记录一次',{timeout:30000},async(t)=>{
 assert.equal(businessSqlParserMajor,18)
 assert.equal(businessSqlServerSupport(130014,18),'unsupported')
 assert.equal(businessSqlServerSupport(140000,18),'older')
 assert.equal(businessSqlServerSupport(170006,18),'older')
 assert.equal(businessSqlServerSupport(180001,18),'same')
 assert.equal(businessSqlServerSupport(190000,18),'unsupported')
 assert.equal(businessSqlServerSupport(Number.NaN,18),'unsupported')
 const server=Number((await pool.query("select current_setting('server_version_num') as v")).rows[0].v)
 const warn=t.mock.method(console,'warn',()=>{})
 const subject=executor()
 await subject.execute('SOC',raw('select 1 as one'))
 await subject.execute('SOC',raw('select 1 as one'))
 const noted=warn.mock.calls.filter(call=>/解析器按 PostgreSQL 18 语法校验/.test(String(call.arguments[0]))).length
 assert.equal(noted,businessSqlServerSupport(server)==='older'?1:0)
})

test('专用连接池与全局信号量：两个范围同时打满，应用共享池照常；同时执行的语句不超过全局上限',{timeout:30000},async()=>{
 const shared=poolAs(container.getUsername(),container.getPassword(),1),dedicated=readerAs(4)
 try{
  const subject=new BusinessSqlExecutor(dedicated,identity,'role')
  const batch=['SOC','OTHER'].flatMap(scope=>Array.from({length:5},()=>subject.execute(scope,raw('select pg_sleep(1) as t9_global'))))
  await new Promise(resolve=>setTimeout(resolve,300))
  const started=Date.now()
  assert.equal((await shared.query('select 1 as one')).rows[0].one,1)
  assert.ok(Date.now()-started<500,'应用共享池被占用')
  const running=(await pool.query("select count(*)::int as n from pg_stat_activity where state='active' and query like '%t9_global%' and pid<>pg_backend_pid()")).rows[0].n
  assert.equal(running,businessSqlExecutionDefaults.concurrencyTotal)
  assert.equal((await Promise.all(batch)).length,10)
 }finally{await shared.end();await dedicated.end()}
})

test('连接池满：取连接的等待受排队时限约束；执行中取消走协议级取消、不借连接、即时生效',{timeout:30000},async()=>{
 const dedicated=readerAs(2),held:PoolClient[]=[]
 try{
  const subject=new BusinessSqlExecutor(dedicated,identity,'role',{...businessSqlExecutionDefaults,concurrencyTotal:1,queueWaitMs:300})
  held.push(await dedicated.connect(),await dedicated.connect())
  const began=Date.now()
  await rejectsWith(subject.execute('SOC',raw('select 1 as one')),'teloa/dependency-unavailable',/^查询排队超时$/)
  assert.ok(Date.now()-began<1500,'取连接等待未受约束')
  held.pop()!.release()
  const controller=new AbortController(),running=subject.execute('SOC',raw('select pg_sleep(3) as s'),controller.signal)
  await new Promise(resolve=>setTimeout(resolve,300))
  // 池已满：一条在执行、一条被占住，没有空闲连接可借。
  assert.equal(dedicated.totalCount,2)
  assert.equal(dedicated.idleCount,0)
  const stopped=Date.now()
  controller.abort()
  await rejectsWith(running,'teloa/dependency-unavailable',/^查询已中止$/)
  assert.ok(Date.now()-stopped<1000,'取消耗时 '+(Date.now()-stopped))
 }finally{for(const client of held)client.release();await dedicated.end()}
})

test('连接回收：成功路径释放会话级 advisory 锁并复用连接；失败路径销毁连接；服务端日志只记 SQLSTATE 与 routine',{timeout:30000},async(t)=>{
 const warn=t.mock.method(console,'warn',()=>{})
 const dedicated=readerAs(2)
 try{
  const subject=new BusinessSqlExecutor(dedicated,identity,'role',{...businessSqlExecutionDefaults,concurrencyTotal:1})
  const pid=async()=>(await subject.execute('SOC',raw('select pg_backend_pid() as p'))).rows[0]![0]
  const first=await pid()
  assert.equal(await pid(),first)
  await subject.execute('SOC',raw('select pg_advisory_lock(4242) as l'))
  assert.equal((await pool.query("select count(*)::int as n from pg_locks where locktype='advisory' and objid=4242")).rows[0].n,0)
  assert.equal(await pid(),first)
  await rejectsWith(subject.execute('SOC',raw("select 'x9secret'::int as v")),'teloa/invalid-input',/22P02/)
  assert.notEqual(await pid(),first)
  const logged=warn.mock.calls.map(call=>String(call.arguments[0])).filter(text=>/22P02/.test(text))
  assert.equal(logged.length,1)
  assert.match(logged[0]!,/SQLSTATE 22P02（[A-Za-z0-9_]+）/)
  assert.ok(!logged[0]!.includes('x9secret'))
 }finally{await dedicated.end()}
})

test('Teloa 表不在 public（验收宿主的独立 schema）：函数与授权落在该 schema，改写产物只读该 schema 的快照，不碰 public',{timeout:60000},async()=>{
 await pool.query('create schema teloa_iso')
 const url=new URL(container.getConnectionUri());url.searchParams.set('options','-c search_path=teloa_iso')
 const isolated=new Pool({connectionString:url.toString()})
 // 只读角色按 schema 派生：同一 secretPath 落成各自的口令文件，不改 public 那个角色的口令。
 const isoSecret=secretPath
 let isoReader:Pool|undefined
 try{
  const status=await initializeTeloaDatabase(isolated,{businessSqlSecretPath:isoSecret})
  assert.equal(status.businessSqlRole?.mode,'role',status.businessSqlRole?.reason)
  assert.equal(status.businessSqlRole?.schema,'teloa_iso')
  assert.notEqual(status.businessSqlRole.role,readerRole)
  const functions=(await pool.query("select n.nspname as schema from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname='teloa_safe_numeric' and n.nspname in ('public','teloa_iso') order by 1")).rows.map(row=>row.schema)
  assert.deepEqual(functions,['public','teloa_iso'])
  await isolated.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values('owner-1','SOC','soc-alert','iso-1',1,$1,$2,'EDR',now())`,[hash,JSON.stringify({fields:[{label:'严重度',value:'low'}]})])
  isoReader=new Pool(await businessSqlPoolConfig({connectionString:container.getConnectionUri()},status.businessSqlRole,isoSecret))
  const subject=new BusinessSqlExecutor(isoReader,identity,'role',businessSqlExecutionDefaults,status.businessSqlRole?.schema)
  const rewrite=rewriteBusinessSql(analyzeBusinessSql('select _id, severity from soc_alert order by _id',[soc]),{ownerId:'owner-1',scope:'SOC'},subject.schema)
  assert.deepEqual((await subject.execute('SOC',rewrite)).rows,[['iso-1','low']])
  // 同一条用户 SQL 按 public 改写仍读 public 的两行：两边互不串。
  assert.deepEqual((await executor().execute('SOC',rewriteBusinessSql(analyzeBusinessSql('select _id from soc_alert order by _id',[soc]),{ownerId:'owner-1',scope:'SOC'},'public'))).rows,[['alert-1'],['alert-2']])
 }finally{await isoReader?.end();await isolated.end()}
})

test('两台宿主同库不同 schema 并发启动：只读角色与口令文件按 schema 派生，互不顶掉口令；各角色只能读自己 schema；收回旧共用角色在本 schema 上的授权',{timeout:90000},async()=>{
 const schemas=['teloa_host_a','teloa_host_b'] as const
 for(const schema of schemas)await pool.query('create schema '+schema)
 const pools=schemas.map(schema=>{const url=new URL(container.getConnectionUri());url.searchParams.set('options','-c search_path='+schema);return new Pool({connectionString:url.toString()})})
 // 两台宿主各自的运行目录里同名的口令文件位置；这里故意用同一个 secretPath，证明文件也按角色分开。
 const shared=join(secretDir,'hosts.json')
 const readers:Pool[]=[]
 try{
  const [a,b]=(await Promise.all(pools.map(item=>initializeTeloaDatabase(item,{businessSqlSecretPath:shared})))).map(item=>item.businessSqlRole)
  assert.equal(a!.mode,'role',a!.reason);assert.equal(b!.mode,'role',b!.reason)
  assert.deepEqual([a!.role,b!.role],schemas.map(schema=>businessSqlReaderRoleOf(container.getDatabase(),schema)))
  assert.notEqual(a!.role,b!.role)
  for(const role of [a!.role!,b!.role!])assert.match(role,/^teloa_business_reader_[0-9a-f]{16}$/)
  const files=(await readdir(secretDir)).filter(name=>name.startsWith('hosts.')).sort()
  assert.deepEqual(files,[a!.role!,b!.role!].map(role=>'hosts.'+role.slice(businessSqlLegacyReaderRole.length+1)+'.json').sort())
  for(const [index,item] of pools.entries())await item.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values('owner-1','SOC','soc-alert',$1,1,$2,$3,'EDR',now())`,['host-'+index,hash,JSON.stringify({fields:[{label:'严重度',value:'low'}]})])
  const config={connectionString:container.getConnectionUri()}
  // 两边都初始化完之后，A 再重启一次（重设它自己的口令）：B 的口令不受影响，两个专用池新建连接都能登录。
  assert.equal((await initializeTeloaDatabase(pools[0]!,{businessSqlSecretPath:shared})).businessSqlRole.mode,'role')
  for(const status of [a!,b!])readers.push(new Pool(await businessSqlPoolConfig(config,status,shared)))
  const run=(index:0|1,sql:string)=>new BusinessSqlExecutor(readers[index]!,identity,'role',businessSqlExecutionDefaults,schemas[index]).execute('SOC',rewriteBusinessSql(analyzeBusinessSql(sql,[soc]),{ownerId:'owner-1',scope:'SOC'},schemas[index]))
  assert.deepEqual((await run(0,'select _id from soc_alert')).rows,[['host-0']])
  assert.deepEqual((await run(1,'select _id from soc_alert')).rows,[['host-1']])
  // 数据库层隔离：A 的角色读不到 B 的快照表、也读不到 public 的，反之亦然。
  await assert.rejects(readers[0]!.query('select count(*) from teloa_host_b.teloa_business_object_snapshots'),{code:'42501'})
  await assert.rejects(readers[1]!.query('select count(*) from teloa_host_a.teloa_business_object_snapshots'),{code:'42501'})
  await assert.rejects(readers[0]!.query('select count(*) from public.teloa_business_object_snapshots'),{code:'42501'})
  // 专用池登录的不是本 schema 的角色：执行器拒绝。
  await rejectsWith(new BusinessSqlExecutor(readers[1]!,identity,'role',businessSqlExecutionDefaults,schemas[0]).execute('SOC',raw('select 1 as one')),'teloa/dependency-unavailable',/^看板查询暂不可用$/)

  // 旧版共用角色在 A、B、public 上都有授权（升级前的残留）：A 重新初始化只收回 A 上的，B 与 public 不动，角色不删。
  await pool.query(`create role ${businessSqlLegacyReaderRole} nologin`)
  for(const schema of [...schemas,'public'])await pool.query(`grant usage on schema ${schema} to ${businessSqlLegacyReaderRole};grant select on ${schema}.teloa_business_object_snapshots to ${businessSqlLegacyReaderRole};grant execute on function ${schema}.teloa_safe_numeric(text) to ${businessSqlLegacyReaderRole}`)
  assert.equal((await initializeTeloaDatabase(pools[0]!,{businessSqlSecretPath:shared})).businessSqlRole.mode,'role')
  // 函数执行权看直接授权（PUBLIC 默认可执行任何函数，has_function_privilege 恒真）。
  const legacy=async(schema:string)=>(await pool.query(`select has_schema_privilege($1,$2,'usage') as u, has_table_privilege($1,$2||'.teloa_business_object_snapshots','select') as t, exists(select 1 from information_schema.routine_privileges where grantee=$1 and routine_schema=$2 and routine_name='teloa_safe_numeric') as f`,[businessSqlLegacyReaderRole,schema])).rows[0]
  assert.deepEqual(await legacy('teloa_host_a'),{u:false,t:false,f:false})
  assert.deepEqual(await legacy('teloa_host_b'),{u:true,t:true,f:true})
  assert.deepEqual(await legacy('public'),{u:true,t:true,f:true})
  assert.equal((await pool.query('select count(*)::int as n from pg_roles where rolname=$1',[businessSqlLegacyReaderRole])).rows[0].n,1)
 }finally{
  for(const item of readers)await item.end()
  for(const item of pools)await item.end()
  await pool.query(`drop owned by ${businessSqlLegacyReaderRole}`).catch(()=>{})
  await pool.query(`drop role if exists ${businessSqlLegacyReaderRole}`)
 }
})

test('安全转换函数属主既不是当前用户也不是超级用户（他人抢先建了同名函数）：只读角色初始化一律 unavailable',{timeout:30000},async(t)=>{
 const warn=t.mock.method(console,'warn',()=>{})
 await pool.query('create role mallory nologin')
 await pool.query('alter function public.teloa_safe_numeric(text) owner to mallory')
 try{
  const status=await initializeBusinessSqlRole(pool,secretPath)
  assert.equal(status.mode,'unavailable')
  assert.match(status.reason!,/属主/)
  assert.ok(warn.mock.calls.some(call=>/属主/.test(String(call.arguments[0]))))
 }finally{
  await pool.query('alter function public.teloa_safe_numeric(text) owner to current_user')
  await pool.query('drop role mallory')
 }
 assert.equal((await initializeBusinessSqlRole(pool,secretPath)).mode,'role')
})
