import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import type {IndustryDataSourceDefinition} from '@teloa/contract'
import {IndustryDataSourceService,IndustryLoadService,initializeIndustryDataSources,initializeIndustryLoads,type IndustryDataSourceSourceSnapshot,type IndustryLoadSource} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool);await initializeIndustryDataSources(pool)})
after(async()=>{await pool?.end();await container?.stop()})

const contentId=randomUUID(),contentHash='a'.repeat(64),snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'SOC',description:'安全行业模板',resources:[{localId:'alert-source',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,available:true}],relations:[],entrypoints:[]}
const source:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const fixedDefinition={format:'teloa.data-source/v1' as const,sourceId:'security-alert-http',scopes:['SOC']}
const sourceReader=(loads:IndustryLoadService,read?:(value:IndustryDataSourceSourceSnapshot)=>IndustryDataSourceSourceSnapshot)=>({read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId);assert.ok(item);const value={loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:fixedDefinition};return read?read(value):value}})
const ready={ready:async()=>({ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'})}

test('行业数据源只登记固定加载映射并保持待授权',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 const service=new IndustryDataSourceService(pool,identity,loads,sourceReader(loads),ready),requestId=randomUUID(),input={requestId,loadId:load.id,itemInstanceId:load.items[0]!.instanceId}
 const first=await service.instantiate(owner,input),retry=await service.instantiate(owner,input)
 assert.deepEqual(retry,first);assert.equal(first.state,'needs_authorization');assert.equal(first.revision,1);assert.equal(first.scope,load.space.scope)
 assert.deepEqual((await service.list(owner,{})).items,[first]);assert.deepEqual(await service.get(owner,{instanceId:first.id}),first)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_data_source_instances where owner_id=$1',[owner])).rows[0].count,1)
})

test('行业数据源拒绝执行工具目标、跨本人读取及损坏固定映射',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},executionTool:IndustryLoadSource={read:async()=>({...snapshot,resources:[{...snapshot.resources[0]!,kind:'execution-tool' as const}]})},loads=new IndustryLoadService(pool,identity,executionTool)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'执行空间'}}),service=new IndustryDataSourceService(pool,identity,loads,sourceReader(loads),ready)
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/conflict'})
 const properLoads=new IndustryLoadService(pool,identity,source),proper=await properLoads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'c'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'数据空间'}}),properService=new IndustryDataSourceService(pool,identity,properLoads,sourceReader(properLoads),ready),saved=await properService.instantiate(owner,{requestId:randomUUID(),loadId:proper.id,itemInstanceId:proper.items[0]!.instanceId})
 await assert.rejects(properService.get('other',{instanceId:saved.id}),{code:'teloa/forbidden'})
 await pool.query('update teloa_industry_data_source_instances set item_local_id=$2 where id=$1',[saved.id,'other'])
 await assert.rejects(properService.get(owner,{instanceId:saved.id}),{code:'teloa/storage-corrupt'})
})

test('真实 readiness 通过后激活并以同一请求恢复固定授权回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'d'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'授权空间'}})
 let probes=0,available=true
 const readiness={ready:async(definition:IndustryDataSourceDefinition,scope:string,signal:AbortSignal)=>{probes+=1;assert.deepEqual(definition,fixedDefinition);assert.equal(scope,'SOC');assert.equal(signal.aborted,false);return available?{ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'}:{ready:false as const,reason:'offline'}}}
 const service=new IndustryDataSourceService(pool,identity,loads,sourceReader(loads),readiness),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID(),command={requestId,instanceId:created.id,expectedRevision:created.revision},active=await service.authorize(owner,command,new AbortController().signal)
 assert.equal(active.state,'active');assert.equal(active.revision,2);assert.deepEqual(active.binding,{sourceId:'security-alert-http',scopes:['SOC'],definitionHash:active.binding?.definitionHash,probedAt:'2026-09-14T00:00:00.000Z'});assert.match(active.binding!.definitionHash,/^[a-f0-9]{64}$/)
 available=false
 assert.deepEqual(await service.authorize(owner,command,new AbortController().signal),active)
 assert.equal(probes,1)
 await assert.rejects(service.authorize(owner,{...command,expectedRevision:2},new AbortController().signal),{code:'teloa/conflict'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),active)
})

test('数据源未就绪时不写授权状态或回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'e'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'未连接空间'}}),service=new IndustryDataSourceService(pool,identity,loads,sourceReader(loads),{ready:async()=>({ready:false as const,reason:'source unavailable'})}),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID()
 await assert.rejects(service.authorize(owner,{requestId,instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_data_source_authorize_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)
})

test('授权拒绝客户端伪造定义以及核验期间发生的固定来源漂移',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'1'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移空间'}})
 let reads=0
 const drifting=sourceReader(loads,value=>{reads+=1;return reads<=2?value:{...value,fileHash:'0'.repeat(64)}}),service=new IndustryDataSourceService(pool,identity,loads,drifting,ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 await assert.rejects(service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,sourceId:'forged'},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/source-unavailable'})
 assert.equal((await service.get(owner,{instanceId:created.id})).state,'needs_authorization')
})

test('并发授权只有一个请求能推进同一预期版本',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'2'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'并发空间'}}),service=new IndustryDataSourceService(pool,identity,loads,sourceReader(loads),ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),signal=new AbortController().signal
 const settled=await Promise.allSettled([service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},signal),service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},signal)])
 assert.equal(settled.filter(result=>result.status==='fulfilled').length,1)
 const failure=settled.find(result=>result.status==='rejected') as PromiseRejectedResult
 assert.equal(failure.reason.code,'teloa/version-conflict')
 assert.equal((await service.get(owner,{instanceId:created.id})).revision,2)
})

test('数据源定义范围不覆盖加载行业时拒绝登记',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'3'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'范围空间'}})
 const narrow=sourceReader(loads,value=>({...value,definition:{...value.definition,scopes:['OTHER']}})),service=new IndustryDataSourceService(pool,identity,loads,narrow,ready)
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/invalid-input'})
})

test('授权复检定义范围，历史登记不能绕过行业覆盖规则',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'4'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'授权范围空间'}})
 let probes=0,narrow=false
 const readiness={ready:async()=>{probes+=1;return {ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'}}}
 const reader=sourceReader(loads,value=>narrow?{...value,definition:{...value.definition,scopes:['OTHER']}}:value),service=new IndustryDataSourceService(pool,identity,loads,reader,readiness)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID()
 narrow=true
 await assert.rejects(service.authorize(owner,{requestId,instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/invalid-input'})
 assert.equal(probes,0)
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_data_source_authorize_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)
})

test('旧库已有的 active 行在初始化时回落为待授权并清除其授权回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'5'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'旧库空间'}}),item=load.items[0]!
 await pool.query('create schema if not exists legacy')
 const legacy=new Pool({connectionString:container.getConnectionUri(),options:'-c search_path=legacy,public'})
 try{
  await legacy.query(`
   create table if not exists teloa_industry_data_source_instances(
    id uuid primary key,owner_id text not null,load_id uuid not null references teloa_industry_loads(id),item_instance_id uuid not null,item_local_id text not null,
    content_id uuid not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),item_version text not null,scope text not null,
    state text not null check(state in ('needs_authorization','active')),revision integer not null check(revision>0),mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,updated_at timestamptz not null,
    unique(owner_id,load_id,item_instance_id)
   );
   create table if not exists teloa_industry_data_source_create_requests(
    owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_data_source_instances(id),primary key(owner_id,request_id)
   );
   create table if not exists teloa_industry_data_source_authorize_requests(
    owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_data_source_instances(id),result_revision integer not null check(result_revision>0),primary key(owner_id,request_id)
   );
  `)
  const id=randomUUID(),requestId=randomUUID()
  const mappingDigest=createHash('sha256').update(JSON.stringify([id,owner,load.id,item.instanceId,item.localId,load.contentId,load.contentHash,item.version,load.space.scope])).digest('hex')
  await legacy.query("insert into teloa_industry_data_source_instances(id,owner_id,load_id,item_instance_id,item_local_id,content_id,content_hash,item_version,scope,state,revision,mapping_digest,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',2,$10,now(),now())",[id,owner,load.id,item.instanceId,item.localId,load.contentId,load.contentHash,item.version,load.space.scope,mappingDigest])
  await legacy.query('insert into teloa_industry_data_source_authorize_requests(owner_id,request_id,request_spec,instance_id,result_revision) values($1,$2,$3,$4,2)',[owner,requestId,JSON.stringify({instanceId:id,expectedRevision:1}),id])
  await initializeIndustryDataSources(legacy)
  await initializeIndustryDataSources(legacy)
  const migrated=(await legacy.query('select state,revision,binding,binding_hash from teloa_industry_data_source_instances where id=$1',[id])).rows[0]
  assert.equal(migrated.state,'needs_authorization');assert.equal(migrated.revision,1);assert.equal(migrated.binding,null);assert.equal(migrated.binding_hash,null)
  assert.equal((await legacy.query('select count(*)::int count from teloa_industry_data_source_authorize_requests where owner_id=$1',[owner])).rows[0].count,0)
  const service=new IndustryDataSourceService(legacy,identity,loads,sourceReader(loads),ready),restored=await service.get(owner,{instanceId:id})
  assert.equal(restored.state,'needs_authorization');assert.equal(restored.revision,1);assert.equal(restored.binding,null)
 }finally{await legacy.end()}
})

test('固定来源漂移后目录投影为待授权并保留绑定，写路径仍判定来源不可用',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'6'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移投影空间'}})
 let drifted=false
 const reader=sourceReader(loads,value=>drifted?{...value,fileHash:'0'.repeat(64)}:value),service=new IndustryDataSourceService(pool,identity,loads,reader,ready)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const active=await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal)
 assert.equal(active.state,'active');assert.ok(!('drift' in active))
 drifted=true
 const projected=await service.get(owner,{instanceId:created.id})
 assert.deepEqual(projected,{...active,state:'needs_authorization',drift:true})
 assert.deepEqual(await service.list(owner,{}),{items:[projected]})
 const requestId=randomUUID()
 await assert.rejects(service.instantiate(owner,{requestId,loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:projected.revision},new AbortController().signal),{code:'teloa/source-unavailable'})
 const stored=(await pool.query('select state,revision,binding from teloa_industry_data_source_instances where id=$1',[created.id])).rows[0]
 assert.equal(stored.state,'active');assert.equal(stored.revision,2);assert.deepEqual(stored.binding,active.binding)
 // 登记的幂等键按既有语义在事务内写入（只把新 requestId 指向既有实例，不改实例状态）；授权回执一条都不能落。
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_data_source_create_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,1)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_data_source_authorize_requests where owner_id=$1',[owner])).rows[0].count,1)
})

test('目录逐行容错：损坏的数据源实例只记入 errors，其余实例照常返回',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const first=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'7'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间甲'}})
 const second=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'8'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间乙'}})
 const service=new IndustryDataSourceService(pool,identity,loads,sourceReader(loads),ready)
 const broken=await service.instantiate(owner,{requestId:randomUUID(),loadId:first.id,itemInstanceId:first.items[0]!.instanceId})
 const good=await service.instantiate(owner,{requestId:randomUUID(),loadId:second.id,itemInstanceId:second.items[0]!.instanceId})
 await pool.query('update teloa_industry_data_source_instances set item_local_id=$2 where id=$1',[broken.id,'tampered'])
 assert.deepEqual(await service.list(owner,{}),{items:[good],errors:[{instanceId:broken.id,code:'teloa/storage-corrupt'}]})
 await assert.rejects(service.get(owner,{instanceId:broken.id}),{code:'teloa/storage-corrupt'})
})
