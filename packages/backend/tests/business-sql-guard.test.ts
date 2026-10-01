import test,{before} from 'node:test'
import assert from 'node:assert/strict'
import {WorkError,type BusinessObjectTypeDefinition,type BusinessFieldType} from '@teloa/contract'
import {analyzeBusinessSql,prepareBusinessSqlParser,verifyRewrittenBusinessSql} from '../src/work/business-sql-guard.ts'
import {businessSqlAllowedNodes} from '../src/work/business-sql-whitelist.ts'

/** 纯解析：看板 SQL 语法树白名单（规格 §4.2）的正例、负例与 PG14+ 语法形态。 */

before(()=>prepareBusinessSqlParser())

const field=(name:string,type:BusinessFieldType,from:string)=>({name,label:from,type,required:false,from})
const objectType=(id:string,fields:ReturnType<typeof field>[]):BusinessObjectTypeDefinition=>({format:'teloa.business-object-type/v1',id,version:'1',domain:'SOC',title:id,unit:'条',lead:'说明',sourceId:'soc',fields})
const socTypes=[
 objectType('soc-alert',[field('severity','enum','严重度'),field('alerted_at','datetime','告警时间'),field('resolved_at','datetime','处置时间'),field('title','text','标题'),field('n','number','数量'),field('x','number','指标X'),field('y','number','指标Y'),field('a','text','甲'),field('b','text','乙')]),
 objectType('soc-ticket',[field('a','text','甲'),field('alert_id','text','告警'),field('status','enum','状态')]),
]
/** 所有被放行的语法树都记下，文件末尾核对其中出现的节点种类都在文档常量 `businessSqlAllowedNodes` 里（常量与校验器不漂移）。 */
const accepted:unknown[]=[]
const ok=(sql:string)=>{const analysis=analyzeBusinessSql(sql,socTypes);accepted.push(analysis.ast);return analysis}
const rejects=(sql:string,word?:string)=>{
 assert.throws(()=>ok(sql),(error:unknown)=>{
  assert.ok(error instanceof WorkError,sql)
  assert.equal(error.code,'teloa/invalid-input',sql)
  if(word!==undefined)assert.ok(error.message.includes(word),`${sql} → ${error.message}（应含「${word}」）`)
  return true
 })
}

const specExample=`select severity,
       percentile_cont(0.9) within group (order by extract(epoch from resolved_at - alerted_at)) as mttr_p90_seconds
from soc_alert
where alerted_at >= now() - interval '7 days'
group by severity`

test('规格 §4.2 示例通过：记录逻辑表、引用列',()=>{
 const analysis=ok(specExample)
 assert.deepEqual(analysis.tables.map(table=>[table.logical,table.objectType.id,table.alias]),[['soc_alert','soc-alert','soc_alert']])
 assert.deepEqual([...analysis.columnsByTable.get('soc_alert')!].sort(),['alerted_at','resolved_at','severity'])
 assert.deepEqual(analysis.ctes,[])
})

test('正例：表达式、聚合、窗口、CTE、子查询、current_date',()=>{
 for(const sql of [
  'select nullif(a,b) from soc_alert',
  'select coalesce(n,0) from soc_alert',
  "select case when n > 1 then 'x' when n is null then 'z' else 'y' end from soc_alert",
  "select now() - interval '7 days'",
  'select percentile_cont(0.5) within group (order by x) from soc_alert',
  'select percentile_disc(0.5) within group (order by x desc) from soc_alert',
  "select count(*) filter (where severity = 'high'), count(distinct title) from soc_alert",
  'select title, row_number() over (partition by severity order by alerted_at) from soc_alert',
  'select title, lag(n,1) over w, rank() over w from soc_alert window w as (order by alerted_at rows between 1 preceding and current row)',
  'with t as (select _id as id, severity from soc_alert) select t.severity, soc_ticket.status from t join soc_ticket on soc_ticket.alert_id = t.id',
  "select title from soc_alert where _id in (select alert_id from soc_ticket where status = 'open')",
  'select title from soc_alert where exists (select 1 from soc_ticket t where t.alert_id = soc_alert._id)',
  'select (select count(*) from soc_ticket) as total',
  'select current_date',
  'select title from soc_alert where alerted_at::date = current_date',
  'select greatest(x,y), least(x,y), abs(x), round(x,2), ceil(x), floor(x), power(x,2), sqrt(x) from soc_alert',
  "select concat(title,'-'), length(title), lower(title), upper(title), split_part(title,'-',1), left(title,2), right(title,2) from soc_alert",
  "select date_trunc('day',alerted_at), to_char(alerted_at,'YYYY'), age(resolved_at,alerted_at) from soc_alert",
  "select title from soc_alert where title like 'a%' or title ilike 'b%' and n between 1 and 2 and n not in (3,4) and severity is not null and (n > 1) is not true",
  'select severity, count(*) as total from soc_alert group by severity having count(*) > 1 order by total desc, severity limit 10 offset 1',
  'select distinct severity from soc_alert',
  'select a.title, t.status from soc_alert a left join soc_ticket t on t.alert_id = a._id',
  'select * from soc_alert',
  'select a.* from soc_alert a',
  'select _id, _version, _source, _synced_at, _observed_at, _deleted_at from soc_alert',
  'select title, -n from soc_alert where not (n > 1)',
  'with c as (select * from soc_alert) select c.title from c',
  'with c(k) as (select severity from soc_alert) select k from c',
  'select s.k from (select severity as k from soc_alert) s',
 ])ok(sql)
})

test('正例：PG14+ 语法形态',()=>{
 for(const sql of [
  'select trim(title) from soc_alert',
  "select trim(leading ' ' from title) from soc_alert",
  'select substring(title from 1 for 8), substring(title,1,8) from soc_alert',
  'select extract(epoch from resolved_at - alerted_at) from soc_alert',
  "select date_part('hour',alerted_at) from soc_alert",
  'select make_interval(days => 7), make_interval(hours => n::int4, mins => 3) from soc_alert',
  'select alerted_at::timestamptz, n::int8, x::bigint, severity::text, n::integer, n::int, x::numeric, (n > 1)::boolean, (n > 1)::bool, cast(alerted_at as timestamp with time zone) from soc_alert',
  'select a from soc_alert union all select a from soc_ticket',
  'select a from soc_alert union select a from soc_ticket order by a',
  "select * from (values (1,'a'),(2,'b')) v(n,label)",
  'select v.label from (values (1,null),(2,true)) v(n,label)',
  'select now()',
 ])ok(sql)
})

test('负例：语句种类、多条语句、占位符、递归',()=>{
 rejects('with recursive c as (select 1) select * from c','递归')
 rejects('select 1; select 2','多条')
 rejects("set work_mem = '1GB'",'VariableSetStmt')
 rejects("copy soc_alert to '/tmp/a'",'CopyStmt')
 rejects("do $$begin end$$",'DoStmt')
 rejects('alter table soc_alert add column z int','AlterTableStmt')
 rejects("insert into soc_alert values (1)",'InsertStmt')
 rejects('update soc_alert set n = 1','UpdateStmt')
 rejects('delete from soc_alert','DeleteStmt')
 rejects('create table z (a int)','CreateStmt')
 rejects('drop table soc_alert','DropStmt')
 rejects('explain select 1','ExplainStmt')
 rejects('begin','TransactionStmt')
 rejects('select $1','占位符')
 rejects('select title from soc_alert where n = $1','占位符')
 rejects('select * from soc_alert for update','LockingClause')
 rejects('select * into z from soc_alert','IntoClause')
 rejects('select severity, count(*) from soc_alert group by grouping sets ((severity),())','GroupingSet')
 rejects('select severity from soc_alert group by rollup(severity)','GroupingSet')
 rejects('select from where','语法')
 rejects('','SELECT')
})

test('负例：模式名、未声明的表与列',()=>{
 rejects('select * from pg_catalog.pg_class','模式名')
 rejects('select * from information_schema.tables','模式名')
 rejects('select * from public.teloa_business_object_snapshots','模式名')
 rejects('select * from teloa_business_object_snapshots','未声明的表')
 rejects('select * from other_scope_table','未声明的表')
 rejects('select foo from soc_alert','未声明的列 foo')
 rejects('select z.title from soc_alert','未声明的表 z')
 rejects('select soc_alert.foo from soc_alert','未声明的列 foo')
 rejects('select a from soc_alert join soc_ticket on soc_ticket.alert_id = soc_alert._id','有歧义')
 rejects('select a.title from soc_alert a join soc_ticket a on true','别名')
 rejects('select c.x from soc_alert c.x','语法')
 rejects('with soc_alert as (select 1 as k) select k from soc_alert','重名')
})

test('负例：函数白名单与禁用函数',()=>{
 rejects('select pg_sleep(1)','pg_sleep')
 rejects('select clock_timestamp()','clock_timestamp')
 rejects("select lo_import('x')",'lo_')
 rejects("select dblink_connect('x')",'dblink')
 rejects("select xpath('/a','<a/>')",'xpath')
 rejects("select current_setting('x')",'current_setting')
 rejects("select set_config('a','b',false)",'set_config')
 rejects('select random()','random')
 rejects('select md5(title) from soc_alert','不允许的函数 md5')
 rejects('select sum(x) within group (order by y) from soc_alert','WITHIN GROUP')
 rejects('select percentile_cont(0.5) from soc_alert','WITHIN GROUP')
 rejects('select sum(x order by y) from soc_alert','排序')
 rejects('select sum(*) from soc_alert')
 rejects('select concat(variadic array[title]) from soc_alert')
})

test('负例：类型转换、SQLValueFunction、连接、FROM 形态',()=>{
 rejects('select x::json from soc_alert','不允许的类型转换 json')
 rejects('select alerted_at::timestamp from soc_alert','不允许的类型转换 timestamp')
 rejects('select current_timestamp','SQLValueFunction')
 rejects('select current_user','SQLValueFunction')
 rejects('select a.title from soc_alert a full join soc_ticket t on true','连接')
 rejects('select a.title from soc_alert a right join soc_ticket t on true','连接')
 rejects('select a.title from soc_alert a cross join soc_ticket t','CROSS JOIN')
 rejects('select a.title from soc_alert a join soc_ticket t using (a)','USING')
 rejects('select a.title from soc_alert a natural join soc_ticket t','NATURAL')
 rejects('select a.title from soc_alert a, soc_ticket t','逗号')
 rejects('select * from generate_series(1,10)','RangeFunction')
 rejects('select * from soc_alert tablesample system (10)','RangeTableSample')
 rejects('select title from only soc_alert','ONLY')
 rejects('select array[1]','A_ArrayExpr')
 rejects('select row(1,2)','RowExpr')
 rejects('select title collate "C" from soc_alert','CollateClause')
 rejects('select n from soc_alert where n = any(array[1])','不允许的语法')
 rejects("select title from soc_alert where title similar to 'x'",'SIMILAR')
 rejects("select title from soc_alert where title ~ 'x'",'运算符')
 rejects('select n operator(pg_catalog.+) 1 from soc_alert','模式名')
})

test('负例：PG14+ 语法形态',()=>{
 rejects('select pg_catalog.btrim(title) from soc_alert','模式名')
 rejects("select position('a' in title) from soc_alert",'不允许的函数 position')
 rejects("select overlay(title placing 'y' from 1 for 2) from soc_alert",'不允许的函数 overlay')
 rejects("select alerted_at at time zone 'UTC' from soc_alert",'不允许的函数 timezone')
 rejects('select title::varchar(10) from soc_alert','不允许的类型转换')
 rejects('select title::public.mytype from soc_alert','不允许的类型转换')
 rejects('select title::a.b.c from soc_alert','不允许的类型转换')
 rejects('select x::int[] from soc_alert','不允许的类型转换')
 rejects('select round(x, digits => 2) from soc_alert','不允许命名参数')
 rejects('select make_interval(foo => 1)','不允许命名参数')
 rejects('select teloa_safe_numeric(title) from soc_alert','不允许的函数')
 rejects('select public.teloa_safe_numeric(title) from soc_alert','不允许的函数')
 rejects('select a from soc_alert intersect select a from soc_ticket','不允许的集合运算')
 rejects('select a from soc_alert except select a from soc_ticket','不允许的集合运算')
 rejects('select a, b from soc_alert union select a from soc_ticket','列数')
 rejects('select * from (values (1),(now())) v(n)','VALUES')
 rejects('select s.k from soc_alert a, lateral (select t.status as k from soc_ticket t where t.alert_id = a._id) s','不允许 LATERAL')
 rejects('select s.k from soc_alert a join lateral (select t.status as k from soc_ticket t where t.alert_id = a._id) s on true','不允许 LATERAL')
 rejects('select distinct on (severity) severity from soc_alert','DISTINCT ON')
})

test('负例：VALUES 分支不得带排序、limit/offset（旁路注入回归）',()=>{
 rejects('values (1) order by pg_sleep(10)','VALUES')
 rejects("values (1) order by (select set_config('search_path','public',false))",'VALUES')
 rejects("select * from (values (1) offset (select cast(string_agg(snapshot::text,',') as int) from public.teloa_business_object_snapshots)) v(n)",'VALUES')
 rejects('select * from (values (1) limit (select count(*) from soc_ticket)) v(n)','VALUES')
 rejects('values (1),(2) order by 1','VALUES')
 rejects('values (1) limit 1','VALUES')
 // VALUES 里的每一项照常逐项校验。
 rejects("select * from (values ((select set_config('a','b',false)))) v(n)",'VALUES')
 // UNION 两侧各自带的排序 / limit 同样严格递归。
 rejects('(select a from soc_alert order by pg_sleep(1)) union select a from soc_ticket','pg_sleep')
 rejects('select a from soc_alert union (select a from soc_ticket limit (select pg_sleep(1)))','pg_sleep')
 rejects('select a from soc_alert union select a from soc_ticket order by pg_sleep(1)','pg_sleep')
 rejects('select a from soc_alert union (values (1) order by 1)','VALUES')
})

test('二次校验同样拒绝 VALUES 旁路；jsonb_array_elements 只在 FROM 函数形态放行',()=>{
 const invalid=(sql:string,word:string)=>assert.throws(()=>verifyRewrittenBusinessSql(sql,3,'public'),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input'&&error.message.includes(word)||assert.fail(sql+' → '+String(error)))
 invalid("VALUES (1) ORDER BY (SELECT (set_config('search_path', 'public', false) || $1) || $2)",'VALUES')
 invalid("SELECT * FROM ( VALUES (1) OFFSET (SELECT (string_agg(snapshot::text, ','))::int FROM public.teloa_business_object_snapshots WHERE $1 || $2 IS NOT NULL) ) AS v(n)",'VALUES')
 invalid('select jsonb_array_elements($1)','jsonb_array_elements')
 invalid('select 1 from public.teloa_business_object_snapshots s where jsonb_array_elements(s.snapshot) is not null','jsonb_array_elements')
})

test('负例：substring 第二参数只能是整数常量；join 的 on 条件必须引用列',()=>{
 rejects("select substring(title from '(a+)+$') from soc_alert",'substring')
 rejects("select substring(title,'(a+)+$') from soc_alert",'substring')
 rejects("select substring(title similar '%x%' escape '#') from soc_alert",'substring')
 rejects('select substring(title,n) from soc_alert','substring')
 rejects('select substring(title) from soc_alert','substring')
 ok('select substring(title from 0 for 2), substring(title,-1), substring(title,2,n) from soc_alert')
 rejects('select a.title from soc_alert a join soc_ticket t on true','on 条件')
 rejects('select a.title from soc_alert a left join soc_ticket t on 1 = 1','on 条件')
 rejects("select a.title from soc_alert a join soc_ticket t on (select true)",'on 条件')
})

test('负例：超长、过深输入一律 teloa/invalid-input（不抛 RangeError）',()=>{
 rejects('select 1'+' + 1'.repeat(50000),'过长')
 rejects("select '"+'x'.repeat(20*1024*1024)+"'",'过长')
 rejects('select '+'('.repeat(8000)+'1'+')'.repeat(8000),'过长')
 rejects('select '+'(1 + '.repeat(2000)+'1'+')'.repeat(2000),'过深')
 rejects('select 1'+' + 1'.repeat(3000),'过深')
 rejects('select '+'(select '.repeat(1500)+'1'+')'.repeat(1500),'过深')
 rejects('select '+'-('.repeat(2000)+'n'+')'.repeat(2000)+' from soc_alert','过深')
 rejects('select * from '+'(select * from '.repeat(600)+'soc_alert'+') s'.repeat(600),'过深')
 assert.throws(()=>verifyRewrittenBusinessSql('select 1'+' + 1'.repeat(3000),3,'public'),(error:unknown)=>error instanceof WorkError&&error.code==='teloa/invalid-input')
})

test('负例：CTE 名、别名、列改名、输出列名、窗口名只能是普通小写标识符（deparser 不给 CTE / 窗口名加引号，曾可拼出跨租户查询）',()=>{
 rejects(`with "x AS(SELECT 1)SELECT*FROM/*" as (select 1),
 "*/public.teloa_business_object_snapshots where $1::text<$2--" as (select 1) select 1`,'标识符')
 rejects('with "a b" as (select 1) select 1','标识符')
 rejects('with "C" as (select 1) select 1','标识符')
 rejects('with c("k k") as (select 1) select 1','标识符')
 rejects('select "x y".title from soc_alert "x y"','标识符')
 rejects('select s.k from (select severity as k from soc_alert) "s*/"','标识符')
 rejects('select s."k*/" from (select severity from soc_alert) s("k*/")','标识符')
 rejects('select severity as "告警 */" from soc_alert','标识符')
 rejects('select 1 as "Total"','标识符')
 rejects('select rank() over "w x" from soc_alert window "w x" as (order by n)','标识符')
 rejects('select rank() over ("w x" order by n) from soc_alert window "w x" as (partition by severity)','标识符')
 // 普通小写标识符照常通过，含下划线开头与数字。
 ok('with c_1(k_2) as (select severity from soc_alert) select _x.k_2 as total_3 from c_1 _x')
 ok('select rank() over (w order by n) from soc_alert window w as (partition by severity)')
})

test('负例：join 的 on 条件必须含「左表.列 = 右表.列」的等值（遍历语法树，不做字符串匹配）',()=>{
 for(const sql of [
  'select a.title from soc_alert a join soc_ticket t on a._id = a._id',
  'select a.title from soc_alert a join soc_ticket t on t.status is null or true',
  "select a.title from soc_alert a join soc_ticket t on 'ColumnRef' = 'ColumnRef'",
  'select a.title from soc_alert a join soc_ticket t on t.alert_id = a._id or true',
  'select a.title from soc_alert a join soc_ticket t on not (t.alert_id = a._id)',
  "select a.title from soc_alert a join soc_ticket t on t.alert_id = 'x'",
  'select a.title from soc_alert a join soc_ticket t on t.alert_id <> a._id',
  'select a.title from soc_alert a join soc_ticket t on t.alert_id = a._id::text',
  'select a.title from soc_alert a join soc_ticket t on t.alert_id = title',
  'select a.title from soc_alert a join soc_ticket t on (select t.alert_id = a._id)',
  'select a.title from soc_alert a join soc_ticket t on t.alert_id = t.alert_id and a._id = a._id',
 ])rejects(sql,'on 条件')
 ok("select a.title from soc_alert a join soc_ticket t on t.alert_id = a._id and t.status = 'open'")
 ok("select a.title from soc_alert a join soc_ticket t on (t.status = 'open' and (a._id = t.alert_id))")
 ok('select a.title from soc_alert a join soc_ticket t on t.alert_id = a._id join soc_ticket u on u.alert_id = a._id')
})

test('文档常量 businessSqlAllowedNodes 与校验器一致：本文件所有正例语法树里出现的节点种类都在常量里',()=>{
 assert.ok(accepted.length>20,'正例应先跑完')
 const seen=new Set<string>()
 const walk=(value:unknown):void=>{
  if(Array.isArray(value)){value.forEach(walk);return}
  if(typeof value!=='object'||value===null)return
  for(const [key,child] of Object.entries(value)){
   // 语法树 JSON 里节点以 { 节点种类: {...} } 出现，种类名首字母大写；字段名一律小写开头。
   if(/^[A-Z]/.test(key))seen.add(key)
   walk(child)
  }
 }
 accepted.forEach(walk)
 for(const kind of ['SelectStmt','FuncCall','ColumnRef','CommonTableExpr','WindowDef'])assert.ok(seen.has(kind),'正例应覆盖 '+kind)
 assert.deepEqual([...seen].filter(kind=>!businessSqlAllowedNodes.has(kind)).sort(),[])
})
