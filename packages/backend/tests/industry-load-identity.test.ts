import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeMarketContents,MarketContentStore,type MarketFileInput} from '../src/market/content-store.ts'
import {createIndustryLoadSource,type IndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 useLocalContainerRuntime()
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withLabels({'teloa.test':'industry-load-identity'}).start()
 console.info('industry-load-identity isolated container:',container.getId())
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeIndustryLoads(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function prepare(db=pool){
 const owner=randomUUID(),market=new MarketContentStore(db,identity),actor={ownerId:owner,kind:'human' as const}
 const manifest={format:'teloa.business-package/v2',id:'identity-test',title:'同字节来源身份',version:'1.0.0',domain:'general',description:'只核对同字节不同声明的固定来源身份。',resources:[{id:'method',kind:'skill',title:'固定方法',version:'1.0.0',required:true,source:{kind:'local',path:'SKILL.md'}}],relations:[],entrypoints:[]}
 const file=(path:string,text:string):MarketFileInput=>({path,bytes:new TextEncoder().encode(text)})
 const base={kind:'industry-template' as const,source:{kind:'upload' as const,name:'同字节来源'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),file('SKILL.md','# 固定方法')],references:[]}
 const old=(await market.import(actor,{...base,requestId:randomUUID()})).content
 const next=(await market.import(actor,{...base,requestId:randomUUID(),trust:{publisher:'Teloa验收',repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'未声明',dsh:'未声明'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'本地上传来源尚未完成签名与兼容审查'}}})).content
 assert.equal(next.hash,old.hash);assert.notEqual(next.id,old.id);assert.notEqual(next.trustHash,old.trustHash)
 const source=createIndustryLoadSource(market),loads=new IndustryLoadService(db,identity,source,undefined,undefined,'enterprise')
 const oldInput={requestId:randomUUID(),contentId:old.id,contentHash:old.hash,target:{kind:'new' as const,spaceId:randomUUID(),name:'固定来源身份空间'}}
 const load=await loads.create(owner,oldInput)
 const command={requestId:randomUUID(),contentId:next.id,contentHash:next.hash,target:{kind:'existing' as const,spaceId:load.space.id,expectedVersion:load.space.version}}
 return {owner,market,source,loads,old,next,load,oldInput,command}
}
type Fixture=Awaited<ReturnType<typeof prepare>>
async function storeOldCollision(f:Fixture){
 const {requestId,...spec}=f.command
 // 仅隔离 PG 重建旧版已提交的错误关联，产品库不经手工 SQL 修复。
 await pool.query('insert into teloa_industry_load_requests values($1,$2,$3,$4)',[f.owner,requestId,JSON.stringify(spec),f.load.id])
}
async function durableState(f:Fixture){
 return {
  loads:(await pool.query('select * from teloa_industry_loads where owner_id=$1 order by id',[f.owner])).rows,
  items:(await pool.query('select i.* from teloa_industry_load_items i join teloa_industry_loads l on l.id=i.load_id where l.owner_id=$1 order by i.instance_id',[f.owner])).rows,
  receipts:(await pool.query('select * from teloa_industry_load_requests where owner_id=$1 order by request_id',[f.owner])).rows,
  space:(await pool.query('select * from teloa_business_spaces where id=$1',[f.load.space.id])).rows,
 }
}

test('相同字节不同信任声明的content身份独立加载；同一content和原请求保持幂等',async()=>{
 const f=await prepare(),before=await durableState(f)
 const a=await f.loads.create(f.owner,f.command)
 assert.equal(a.contentId,f.next.id,'不能将新固定content身份替换为同hash旧content')
 const b=await f.loads.create(f.owner,f.command)
 assert.deepEqual(a,b);assert.notEqual(a.id,f.load.id);assert.notEqual(a.items[0]!.instanceId,f.load.items[0]!.instanceId)
 assert.equal(a.space.version,2)
 const again=await f.loads.create(f.owner,{...f.command,requestId:randomUUID(),target:{...f.command.target,expectedVersion:2}})
 assert.equal(again.id,a.id);assert.equal(again.space.version,2)
 const after=await durableState(f)
 assert.deepEqual(after.loads.find(row=>row.id===f.load.id),before.loads[0]);assert.deepEqual(after.items.filter(row=>row.load_id===f.load.id),before.items)
 assert.equal(after.loads.length,2)
 assert.equal((await f.market.get({ownerId:f.owner,kind:'human'},{contentId:a.contentId})).trust.license.status,'declared')
})

test('原误绑定回执以同request受控修复并保留旧关联审计；并发和单连接恢复只生效一次',async()=>{
 const f=await prepare();await storeOldCollision(f)
 const before=await durableState(f),single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:3000})
 try{
  const loads=new IndustryLoadService(single,identity,createIndustryLoadSource(new MarketContentStore(single,identity)),undefined,undefined,'enterprise')
  const [a,b]=await Promise.all([loads.create(f.owner,f.command),loads.create(f.owner,f.command)])
  assert.deepEqual(a,b);assert.equal(a.contentId,f.next.id);assert.notEqual(a.id,f.load.id);assert.equal(a.space.version,2)
  const after=await durableState(f)
  assert.deepEqual(after.loads.find(row=>row.id===f.load.id),before.loads[0]);assert.deepEqual(after.items.filter(row=>row.load_id===f.load.id),before.items)
  const original=before.receipts.find(row=>row.request_id===f.command.requestId)!,receipt=after.receipts.find(row=>row.request_id===f.command.requestId)!
  assert.deepEqual(receipt,{...original,load_id:a.id})
  const audit=(await pool.query('select * from teloa_industry_load_request_repairs where owner_id=$1 and request_id=$2',[f.owner,f.command.requestId])).rows
  assert.equal(audit.length,1);assert.equal(audit[0].original_load_id,f.load.id);assert.equal(audit[0].corrected_load_id,a.id);assert.deepEqual(audit[0].request_spec,original.request_spec);assert.ok(audit[0].repaired_at instanceof Date)
  assert.equal((await loads.create(f.owner,f.command)).id,a.id)
  assert.equal((await durableState(f)).loads.length,2)
  const replayOnly=new IndustryLoadService(single,identity,{read:async()=>{throw Error('准确回执不得重读来源')}},undefined,undefined,'enterprise')
  await pool.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1',[f.owner])
  const replayBefore=await durableState(f)
  assert.equal((await replayOnly.create(f.owner,f.command)).id,a.id)
  assert.deepEqual(await durableState(f),replayBefore)
 }finally{await single.end()}
})

test('误绑定修复不绕过原expectedVersion或整体配置管理，拒绝时原回执与映射不变',async()=>{
 const stale=await prepare();await storeOldCollision(stale)
 await pool.query('update teloa_business_spaces set version=version+1 where id=$1',[stale.load.space.id])
 const before=await durableState(stale)
 await assert.rejects(stale.loads.create(stale.owner,stale.command),{code:'teloa/version-conflict'})
 assert.deepEqual(await durableState(stale),before)
 const managed=await prepare();await storeOldCollision(managed)
 await pool.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1',[managed.owner])
 const managedBefore=await durableState(managed)
 await assert.rejects(managed.loads.create(managed.owner,managed.command),{code:'teloa/conflict'})
 assert.deepEqual(await durableState(managed),managedBefore)
})

test('误绑定修复仍服从本人目标权限，已退役原加载也不恢复执行血缘',async()=>{
 const denied=await prepare();await storeOldCollision(denied)
 await pool.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at,kind) values($1,$2,'本人空间','',1,now(),now(),'personal')",[randomUUID(),denied.owner])
 const personalLoads=new IndustryLoadService(pool,identity,denied.source,undefined,undefined,'personal'),deniedBefore=await durableState(denied)
 await assert.rejects(personalLoads.create(denied.owner,denied.command),{code:'teloa/forbidden'})
 assert.deepEqual(await durableState(denied),deniedBefore)
 const retired=await prepare();await storeOldCollision(retired)
 await retired.loads.unload(retired.owner,{requestId:randomUUID(),loadId:retired.load.id,expectedMappingHash:retired.load.mappingHash})
 const retiredBefore=await durableState(retired)
 await assert.rejects(retired.loads.create(retired.owner,retired.command),{code:'teloa/storage-corrupt'})
 assert.deepEqual(await durableState(retired),retiredBefore)
})

test('误绑定必须重验原来源及完全相同快照；换spec、hash、目标或原坏映射均不自动纠正',async()=>{
 for(const problem of ['source-bytes','snapshot','spec','hash','space','owner','mapping'] as const){
  const f=await prepare();await storeOldCollision(f)
  let loads=f.loads,command=f.command
  if(problem==='source-bytes')await pool.query("update teloa_market_files set bytes=$2 where content_id=$1 and path='SKILL.md'",[f.next.id,Buffer.from('# altered')])
  if(problem==='snapshot'){
   const source:IndustryLoadSource={read:async(...args)=>({...await f.source.read(...args),title:'不同快照'})}
   loads=new IndustryLoadService(pool,identity,source,undefined,undefined,'enterprise')
  }
  if(problem==='spec')command={...command,target:{...command.target,expectedVersion:2}}
  if(problem==='hash')await pool.query('update teloa_industry_loads set content_hash=$2 where id=$1',[f.load.id,'0'.repeat(64)])
  if(problem==='space'){
   const other=await f.loads.create(f.owner,{...f.oldInput,requestId:randomUUID(),target:{...f.oldInput.target,spaceId:randomUUID()}})
   await pool.query('update teloa_industry_load_requests set load_id=$3 where owner_id=$1 and request_id=$2',[f.owner,f.command.requestId,other.id])
  }
  if(problem==='owner'){
   const other=await prepare()
   await pool.query('update teloa_industry_load_requests set load_id=$3 where owner_id=$1 and request_id=$2',[f.owner,f.command.requestId,other.load.id])
  }
  if(problem==='mapping')await pool.query('update teloa_industry_load_items set instance_id=$2 where load_id=$1',[f.load.id,randomUUID()])
  const before=await durableState(f)
  await assert.rejects(loads.create(f.owner,command),{code:problem==='spec'?'teloa/conflict':'teloa/storage-corrupt'},problem)
  assert.deepEqual(await durableState(f),before,problem)
  assert.equal((await pool.query('select 1 from teloa_industry_load_request_repairs where owner_id=$1',[f.owner])).rowCount,0)
 }
})

test('误绑定修复先等配置锁，期间不能取得空间锁，配置变成受管后原样拒绝',async()=>{
 const f=await prepare();await storeOldCollision(f);const before=await durableState(f),db=await pool.connect()
 await db.query('begin');await lockBusinessConfiguration(db,f.owner,'general')
 const pid=Number((await db.query('select pg_backend_pid() pid')).rows[0].pid)
 const pending=f.loads.create(f.owner,f.command).then(value=>({value}),error=>({error}))
 try{
  let blocked=false;const deadline=Date.now()+5000
  while(Date.now()<deadline){
   if((await pool.query("select 1 from pg_stat_activity where wait_event='advisory' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount){blocked=true;break}
   await new Promise<void>(resolve=>setImmediate(resolve))
  }
  assert.equal(blocked,true,'纠正回执也必须先等配置锁')
  await db.query('select id from teloa_business_spaces where id=$1 for update nowait',[f.load.space.id])
  await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1',[f.owner]);await db.query('commit')
  const result=await pending;assert.ok('error' in result);assert.equal(result.error.code,'teloa/conflict')
  assert.deepEqual(await durableState(f),before)
 }finally{await db.query('rollback');db.release();await pending}
})

test('旧hash唯一约束按源码初始化迁移，无业务行改写；新身份索引生效且重复初始化幂等',async()=>{
 const schema='load_identity_'+randomUUID().replaceAll('-','')
 await pool.query(`create schema ${schema}`)
 const legacy=new Pool({connectionString:container.getConnectionUri(),options:'-c search_path='+schema})
 try{
  await initializeMarketContents(legacy);await initializeIndustryLoads(legacy)
  const f=await prepare(legacy)
  await legacy.query('drop index if exists teloa_industry_loads_source_identity')
  await legacy.query('alter table teloa_industry_loads drop constraint if exists teloa_industry_loads_owner_id_space_id_content_hash_key')
  // 模拟历史库被 PostgreSQL 截短或管理员重命名的约束，迁移必须按旧列集识别。
  await legacy.query('alter table teloa_industry_loads add constraint renamed_legacy_load_identity unique(content_hash,space_id,owner_id)')
  const before={loads:(await legacy.query('select * from teloa_industry_loads')).rows,items:(await legacy.query('select * from teloa_industry_load_items')).rows,receipts:(await legacy.query('select * from teloa_industry_load_requests')).rows}
  await Promise.all([initializeIndustryLoads(legacy),initializeIndustryLoads(legacy)])
  assert.deepEqual({loads:(await legacy.query('select * from teloa_industry_loads')).rows,items:(await legacy.query('select * from teloa_industry_load_items')).rows,receipts:(await legacy.query('select * from teloa_industry_load_requests')).rows},before)
  assert.equal((await legacy.query("select 1 from pg_constraint where conrelid='teloa_industry_loads'::regclass and conname in ('teloa_industry_loads_owner_id_space_id_content_hash_key','renamed_legacy_load_identity')")).rowCount,0)
  const next=await f.loads.create(f.owner,f.command);assert.equal(next.contentId,f.next.id)
  await assert.rejects(legacy.query('update teloa_industry_loads set content_id=$2 where id=$1',[next.id,f.old.id]),{code:'23505'})
 }finally{await legacy.end()}
})
