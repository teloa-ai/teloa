import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessDataService,initializeBusinessData,businessObjectSnapshotHash,readBusinessObjectSnapshot} from '../src/work/business-data.ts'
import {BusinessWarehouseService,businessSafeFunctions,currentVersionSubquery,initializeBusinessWarehouse} from '../src/work/business-warehouse.ts'

/** 快照数据仓语义的真库验收：安全转换函数、tombstone、配额每事务一次、保留清理只删非当前版本。 */

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessData(pool)
 await initializeBusinessWarehouse(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const NOW='2026-09-25T12:00:00.000Z'
const day=86_400_000
const ago=(days:number)=>new Date(Date.parse(NOW)-days*day).toISOString()
const warehouse=()=>new BusinessWarehouseService(pool,{now:()=>NOW})
const alert=(id:string,version:number)=>({scope:'SOC',type:'alert',id,version,title:'告警 '+id,source:'EDR',observedAt:'2026-09-12T01:00:00.000Z',receivedAt:'2026-09-12T01:00:01.000Z',quality:'complete' as const,summary:'摘要',fields:[{label:'严重度',value:'高'}]})

async function put(owner:string,id:string,version:number,firstSeenAt:string,objectType='alert'):Promise<void>{
 const item={...alert(id,version),type:objectType}
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   values($1,'SOC',$2,$3,$4,$5,$6,'EDR',$7)`,[owner,objectType,id,version,businessObjectSnapshotHash(item),JSON.stringify(item),firstSeenAt])
}

async function inTransaction<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect()
 try{await db.query('begin');const result=await run(db);await db.query('commit');return result}
 catch(error){await db.query('rollback');throw error}finally{db.release()}
}

test('四个安全转换函数：失败与越界一律 NULL，immutable 且 strict',async()=>{
 const one=async(sql:string,value:string)=>(await pool.query(`select ${sql}($1) as v`,[value])).rows[0].v
 assert.equal(await one('teloa_safe_numeric','12.5'),'12.5')
 assert.equal(await one('teloa_safe_numeric','-3e2'),'-300')
 assert.equal(await one('teloa_safe_numeric','n/a'),null)
 // numeric 本身不溢出（上限 131072 位整数），必须由函数自己钳住，否则会把 10^400 当作有效数值交给图表。
 assert.equal(await one('teloa_safe_numeric','1e400'),null)
 assert.equal(await one('teloa_safe_numeric','-1e400'),null)
 assert.equal(await one('teloa_safe_numeric','1'+'0'.repeat(400)),null)
 assert.equal(await one('teloa_safe_numeric','1e99999'),null)
 assert.ok(await one('teloa_safe_timestamptz','2026-09-25T00:00:00.000Z')!==null)
 assert.equal((await one('teloa_safe_timestamptz','2026-09-25T08:00:00+08:00') as Date).toISOString(),'2026-09-25T00:00:00.000Z')
 assert.equal(await one('teloa_safe_timestamptz','昨天'),null)
 // 形似 ISO 但日历上不存在：正则放行后 cast 会报错，必须落 NULL 而不是让整条查询失败。
 assert.equal(await one('teloa_safe_timestamptz','2026-02-31T00:00:00Z'),null)
 assert.equal(await one('teloa_safe_timestamptz','now'),null)
 assert.equal(await one('teloa_safe_boolean','是'),true)
 assert.equal(await one('teloa_safe_boolean','TRUE'),true)
 assert.equal(await one('teloa_safe_boolean','否'),false)
 assert.equal(await one('teloa_safe_boolean','0'),false)
 assert.equal(await one('teloa_safe_boolean','maybe'),null)
 // 时长与契约 parseDurationSeconds 同一口径：纯秒数或 ISO 8601（PnW / PnDTnHnMn(.n)S），至少一段，上限 1e12 秒。
 const seconds=async(value:string)=>{const v=await one('teloa_safe_duration_seconds',value);return v===null?null:Number(v)}
 assert.equal(await seconds('PT15M'),900)
 assert.equal(await seconds('PT1H30M'),5400)
 assert.equal(await seconds('P1DT2H'),93600)
 assert.equal(await seconds('P2W'),1209600)
 assert.equal(await seconds('PT0.5S'),0.5)
 assert.equal(await seconds('270'),270)
 assert.equal(await seconds('270.5'),270.5)
 for(const value of ['x','P','PT','P1Y','P1M','-5','1e3',' 270','PT1.5M','P1W2D','1'+'0'.repeat(20),'PT'+'9'.repeat(70)+'S'])assert.equal(await seconds(value),null,value)
 // 同一条语句里常量实参（会被内联并常量折叠）与脏值混在一起也不报错。
 const folded=(await pool.query("select public.teloa_safe_numeric('n/a') as a,public.teloa_safe_numeric('1e400') as b,public.teloa_safe_timestamptz('2026-02-31') as c,public.teloa_safe_duration_seconds('PT') as d")).rows[0]
 assert.deepEqual(folded,{a:null,b:null,c:null,d:null})
 const meta=(await pool.query(`select p.proname,p.provolatile,p.proisstrict from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=any($1) order by p.proname`,[[...businessSafeFunctions]])).rows
 assert.deepEqual(meta,[...businessSafeFunctions].sort().map(proname=>({proname,provolatile:'i',proisstrict:true})))
 // search_path=pg_temp 时只能以 public. 限定名调用：改写产物的前提。
 const hidden=await inTransaction(async db=>{await db.query('set local search_path=pg_temp');return (await db.query("select public.teloa_safe_boolean('1') as v")).rows[0].v})
 assert.equal(hidden,true)
})

test('初始化幂等：重复执行函数与索引不报错',async()=>{
 await initializeBusinessData(pool)
 await initializeBusinessWarehouse(pool)
 await initializeBusinessWarehouse(pool)
 const indexes=(await pool.query(`select indexname from pg_indexes where tablename='teloa_business_object_snapshots' order by indexname`)).rows.map(row=>row.indexname)
 assert.ok(indexes.includes('teloa_business_object_snapshots_current'))
 assert.ok(indexes.includes('teloa_business_object_snapshots_first_seen'))
})

test('tombstone 让对象退出当前版本，再次调用不写新行',async()=>{
 const owner=randomUUID(),service=warehouse()
 await put(owner,'evt-1',1,ago(2));await put(owner,'evt-1',2,ago(1));await put(owner,'evt-2',1,ago(1))
 const written=await inTransaction(db=>service.tombstone(db,owner,'SOC','alert','evt-1','sync-mapping'))
 assert.equal(written,true)
 const stored=(await pool.query('select object_version,snapshot,source_id,first_seen_at from teloa_business_object_snapshots where owner_id=$1 and object_id=$2 order by object_version desc limit 1',[owner,'evt-1'])).rows[0]
 assert.equal(stored.object_version,3);assert.equal(stored.source_id,'sync-mapping');assert.equal(stored.first_seen_at.toISOString(),NOW)
 const parsed=readBusinessObjectSnapshot(stored.snapshot,'SOC')
 assert.equal(parsed.deletedAt,NOW);assert.equal(parsed.version,3);assert.deepEqual(parsed.fields,alert('evt-1',2).fields)
 const live=(await pool.query(`select object_id from ${currentVersionSubquery(false)} s order by object_id`,[owner,'SOC','alert'])).rows.map(row=>row.object_id)
 assert.deepEqual(live,['evt-2'])
 const all=(await pool.query(`select object_id,object_version,s.snapshot->>'deletedAt' as _deleted_at from ${currentVersionSubquery(true)} s order by object_id`,[owner,'SOC','alert'])).rows
 assert.deepEqual(all,[{object_id:'evt-1',object_version:3,_deleted_at:NOW},{object_id:'evt-2',object_version:1,_deleted_at:null}])
 assert.equal(await inTransaction(db=>service.tombstone(db,owner,'SOC','alert','evt-1','sync-mapping')),false)
 assert.equal(await inTransaction(db=>service.tombstone(db,owner,'SOC','alert','not-there','sync-mapping')),false)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[owner])).rows[0].n,4)
})

test('配额按范围合计版本行数，超配只拒绝新增',{timeout:120000},async()=>{
 const owner=randomUUID(),service=warehouse()
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   select $1,'SOC',case when g%2=0 then 'alert' else 'asset' end,'o'||g,1,repeat('a',64),'{}'::jsonb,'bulk',$2 from generate_series(1,499999) g`,[owner,NOW])
 assert.equal(await inTransaction(db=>service.scopeRowCount(db,owner,'SOC')),499_999)
 await assert.rejects(inTransaction(db=>service.assertQuota(db,owner,'SOC',2)),(error:{code?:string;message?:string})=>error.code==='teloa/invalid-input'&&error.message!.includes('500 000'))
 await inTransaction(db=>service.assertQuota(db,owner,'SOC',1))
 // 其他范围与其他本人不受影响。
 await inTransaction(db=>service.assertQuota(db,owner,'AppSec',2))
 await inTransaction(db=>service.assertQuota(db,randomUUID(),'SOC',2))
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[owner])
})

test('安全转换函数：数值只认 ASCII 数字（ICU 排序规则下也不报错），时间必须带时区',async()=>{
 const icu=(await pool.query(`select collname from pg_collation where collprovider='i' and collname='und-x-icu'`)).rows.length===1
 assert.ok(icu,'测试库须带 ICU 排序规则')
 // ICU 排序规则下 \d 会放行阿拉伯-印度数字等非 ASCII 数字，随后 ::numeric 报错拖垮整条查询；必须落 NULL。
 const icuCall=async(fn:string,value:string)=>(await pool.query(`select public.${fn}($1 collate "und-x-icu") as v`,[value])).rows[0].v
 for(const value of ['١٢','١.٥','12e١'])assert.equal(await icuCall('teloa_safe_numeric',value),null,value)
 assert.equal(await icuCall('teloa_safe_numeric','12.5'),'12.5')
 assert.equal(await icuCall('teloa_safe_timestamptz','٢٠٢٦-09-25T00:00:00Z'),null)
 // 带时刻不带时区的值会随会话时区漂移：一律 NULL，不按会话时区猜。
 const one=async(value:string)=>(await pool.query('select public.teloa_safe_timestamptz($1) as v',[value])).rows[0].v
 for(const value of ['2026-09-25T08:00','2026-09-25 08:00:00','2026-09-25T08:00:00.123','2026-09-25 10:00'])assert.equal(await one(value),null,value)
 // 纯日期按 UTC 零点解释，与会话时区无关；日历上不存在的日期与多余字符仍是 NULL。
 assert.equal((await one('2026-09-25') as Date).toISOString(),'2026-09-25T00:00:00.000Z')
 const shifted=await inTransaction(async db=>{await db.query("set local timezone='Asia/Shanghai'");return (await db.query("select public.teloa_safe_timestamptz('2026-09-25') as v")).rows[0].v as Date})
 assert.equal(shifted.toISOString(),'2026-09-25T00:00:00.000Z')
 for(const value of ['2026-02-30','2026-13-01','2026-09-25 ','20260925'])assert.equal(await one(value),null,value)
 assert.equal(await icuCall('teloa_safe_timestamptz','٢٠٢٦-09-25'),null)
 assert.equal((await one('2026-09-25T08:00Z') as Date).toISOString(),'2026-09-25T08:00:00.000Z')
 assert.equal((await one('2026-09-25 08:00:00+0800') as Date).toISOString(),'2026-09-25T00:00:00.000Z')
 assert.equal((await one('2026-09-25T08:00:00.5+08') as Date).toISOString(),'2026-09-25T00:00:00.500Z')
})

test('配额并发：两个事务各自都在上限内、合计超额时，后到的一方等前者提交后被拒',{timeout:120000},async()=>{
 const owner=randomUUID(),service=warehouse()
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   select $1,'SOC','alert','o'||g,1,repeat('a',64),'{}'::jsonb,'bulk',$2 from generate_series(1,499997) g`,[owner,NOW])
 const first=await pool.connect(),second=await pool.connect()
 try{
  await first.query('begin');await second.query('begin')
  await service.assertQuota(first,owner,'SOC',2)
  await first.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values($1,'SOC','alert','n1',1,repeat('a',64),'{}'::jsonb,'bulk',$2),($1,'SOC','alert','n2',1,repeat('a',64),'{}'::jsonb,'bulk',$2)`,[owner,NOW])
  let settled=false
  const pending=service.assertQuota(second,owner,'SOC',2).finally(()=>{settled=true})
  pending.catch(()=>{})
  await new Promise(resolve=>setTimeout(resolve,300))
  assert.equal(settled,false,'后到的一方在配额锁上等待，不拿提交前的计数')
  await first.query('commit')
  await assert.rejects(pending,(error:{code?:string;message?:string})=>error.code==='teloa/invalid-input'&&error.message!.includes('500 000'))
 }finally{await first.query('rollback').catch(()=>{});await second.query('rollback').catch(()=>{});first.release();second.release()}
 // 另一范围不受这把锁牵连。
 await inTransaction(db=>service.assertQuota(db,owner,'AppSec',2))
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[owner])
})

test('BusinessDataService 一页多条只做一次配额 count(*)',async()=>{
 const counts:string[]=[]
 const counted={
  connect:async()=>{
   const client=await pool.connect(),query=client.query.bind(client)
   return new Proxy(client,{get:(target,key)=>key==='query'?(sql:unknown,...rest:unknown[])=>{if(typeof sql==='string'&&/count\(\*\)/i.test(sql))counts.push(sql);return (query as (...args:unknown[])=>unknown)(sql,...rest)}:Reflect.get(target,key)})
  },
 } as unknown as Pool
 const items=[alert('a-1',1),alert('a-2',1),alert('a-3',1)]
 const service=new BusinessDataService(counted,{id:'security-alert-http',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:'SOC',capturedAt:'2026-09-12T01:00:02.000Z',items})})
 const page=await service.query({ownerId:randomUUID(),scopeIds:['SOC']},{scope:'SOC',limit:10})
 assert.equal(page.items.length,3)
 assert.equal(counts.length,1)
})

test('保留清理只删过期且非当前版本的行，分批、可重复',async()=>{
 const owner=randomUUID(),service=warehouse()
 for(const id of ['p-1','p-2','p-3']){await put(owner,id,1,ago(100));await put(owner,id,2,ago(50));await put(owner,id,3,ago(1))}
 // 当前版本本身就过期：仍保留（它是这个对象唯一的现状）。
 await put(owner,'p-old',1,ago(200))
 // 其他对象类型与其他本人不被波及。
 await put(owner,'x-1',1,ago(100),'asset');await put(owner,'x-1',2,ago(1),'asset')
 await put('other-'+owner,'p-1',1,ago(100));await put('other-'+owner,'p-1',2,ago(1))
 assert.equal(await service.prune(owner,'SOC','alert',90),3)
 const left=(await pool.query(`select object_id,object_version from teloa_business_object_snapshots where owner_id=$1 and object_type='alert' order by object_id,object_version`,[owner])).rows.map(row=>row.object_id+'@'+row.object_version)
 assert.deepEqual(left,['p-1@2','p-1@3','p-2@2','p-2@3','p-3@2','p-3@3','p-old@1'])
 assert.equal(await service.prune(owner,'SOC','alert',90),0)
 assert.equal(await service.prune(owner,'SOC','alert',30),3)
 assert.equal((await pool.query(`select count(*)::int n from teloa_business_object_snapshots where owner_id=$1 and object_type='asset'`,[owner])).rows[0].n,2)
 assert.equal((await pool.query(`select count(*)::int n from teloa_business_object_snapshots where owner_id=$1`,['other-'+owner])).rows[0].n,2)
 for(const days of [0,366,1.5])await assert.rejects(service.prune(owner,'SOC','alert',days),{code:'teloa/invalid-input'})
 const controller=new AbortController();controller.abort()
 await assert.rejects(service.prune(owner,'SOC','alert',1,controller.signal),{name:'AbortError'})
})

test('保留清理跳过仍被任务来源引用的历史版本',async()=>{
 // 任务来源与安全动作以外键钉住对象的某个版本；清理若删到它们会整批 23503 失败。
 await pool.query(`create table if not exists teloa_business_task_sources (
   owner_id text not null,scope_id text not null,object_type text not null,object_id text not null,object_version integer not null,
   foreign key(owner_id,scope_id,object_type,object_id,object_version) references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version))`)
 const owner=randomUUID(),service=warehouse()
 for(const id of ['r-1','r-2']){await put(owner,id,1,ago(100));await put(owner,id,2,ago(1))}
 await pool.query(`insert into teloa_business_task_sources values($1,'SOC','alert','r-1',1)`,[owner])
 assert.equal(await service.prune(owner,'SOC','alert',90),1)
 const left=(await pool.query(`select object_id||'@'||object_version as k from teloa_business_object_snapshots where owner_id=$1 order by 1`,[owner])).rows.map(row=>row.k)
 assert.deepEqual(left,['r-1@1','r-1@2','r-2@2'])
 await pool.query('drop table teloa_business_task_sources')
})
