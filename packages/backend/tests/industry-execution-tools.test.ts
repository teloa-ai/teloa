import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {IndustryExecutionToolService,IndustryLoadService,initializeIndustryExecutionTools,initializeIndustryLoads,type IndustryExecutionToolSourceSnapshot,type IndustryLoadSource} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeIndustryLoads(pool);await initializeIndustryExecutionTools(pool)})
after(async()=>{await pool?.end();await container?.stop()})

const contentId=randomUUID(),contentHash='a'.repeat(64),snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'security',description:'安全行业模板',resources:[{localId:'isolate-endpoint',kind:'execution-tool' as const,title:'隔离终端',version:'1.0.0',required:true,available:true}],relations:[],entrypoints:[]}
const source:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const fixedDefinition={format:'teloa.execution-tool/v1' as const,adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate']}
const sourceReader=(loads:IndustryLoadService,read?:(value:IndustryExecutionToolSourceSnapshot)=>IndustryExecutionToolSourceSnapshot)=>({read:async(db:Parameters<IndustryLoadService['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId);assert.ok(item);const value={loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:fixedDefinition};return read?read(value):value}})
const ready={ready:async()=>({ready:true as const})}

test('行业执行工具只登记固定加载映射并保持待授权',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId,contentHash,target:{kind:'new',spaceId:randomUUID(),name:'SOC'}})
 const service=new IndustryExecutionToolService(pool,identity,loads,sourceReader(loads),ready),requestId=randomUUID(),input={requestId,loadId:load.id,itemInstanceId:load.items[0]!.instanceId}
 const first=await service.instantiate(owner,input),retry=await service.instantiate(owner,input)
 assert.deepEqual(retry,first);assert.equal(first.state,'needs_authorization');assert.equal(first.revision,1);assert.equal(first.scope,load.space.scope)
 assert.deepEqual((await service.list(owner,{})).items,[first]);assert.deepEqual(await service.get(owner,{instanceId:first.id}),first)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_execution_tool_instances where owner_id=$1',[owner])).rows[0].count,1)
})

test('行业执行工具拒绝数据源目标、跨本人读取及损坏固定映射',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},dataSource:IndustryLoadSource={read:async()=>({...snapshot,resources:[{...snapshot.resources[0]!,kind:'data-source' as const}]})},loads=new IndustryLoadService(pool,identity,dataSource)
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'数据空间'}}),service=new IndustryExecutionToolService(pool,identity,loads,sourceReader(loads),ready)
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/conflict'})
 const properLoads=new IndustryLoadService(pool,identity,source),proper=await properLoads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'c'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'执行空间'}}),properService=new IndustryExecutionToolService(pool,identity,properLoads,sourceReader(properLoads),ready),saved=await properService.instantiate(owner,{requestId:randomUUID(),loadId:proper.id,itemInstanceId:proper.items[0]!.instanceId})
 await assert.rejects(properService.get('other',{instanceId:saved.id}),{code:'teloa/forbidden'})
 await pool.query('update teloa_industry_execution_tool_instances set item_local_id=$2 where id=$1',[saved.id,'other'])
 await assert.rejects(properService.get(owner,{instanceId:saved.id}),{code:'teloa/storage-corrupt'})
})

test('真实 readiness 通过后激活并以同一请求恢复固定授权回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'d'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'授权空间'}})
 let probes=0,available=true
 const readiness={ready:async(tool:string,signal:AbortSignal)=>{probes+=1;assert.equal(tool,'security.endpoint.isolate');assert.equal(signal.aborted,false);return available?{ready:true as const}:{ready:false as const,reason:'offline'}}}
 const service=new IndustryExecutionToolService(pool,identity,loads,sourceReader(loads),readiness),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID(),command={requestId,instanceId:created.id,expectedRevision:created.revision},active=await service.authorize(owner,command,new AbortController().signal)
 assert.equal(active.state,'active');assert.equal(active.revision,2);assert.deepEqual(active.binding,{adapterId:'security-action-http',tools:['security.endpoint.isolate'],definitionHash:active.binding?.definitionHash});assert.match(active.binding!.definitionHash,/^[a-f0-9]{64}$/)
 available=false
 assert.deepEqual(await service.authorize(owner,command,new AbortController().signal),active)
 assert.equal(probes,1)
 await assert.rejects(service.authorize(owner,{...command,expectedRevision:2},new AbortController().signal),{code:'teloa/conflict'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),active)
 const client=await pool.connect()
 try{
  await client.query('begin isolation level repeatable read')
  assert.deepEqual(await service.activeBindingForItemInTransaction(client,owner,{loadId:load.id,itemInstanceId:load.items[0]!.instanceId,tool:'security.endpoint.isolate'}),active.binding)
  assert.equal(await service.activeBindingForItemInTransaction(client,owner,{loadId:load.id,itemInstanceId:randomUUID(),tool:'security.endpoint.isolate'}),null)
  await client.query('commit')
 }catch(error){await client.query('rollback').catch(()=>{});throw error}finally{client.release()}
})

test('执行器未就绪时不写授权状态或回执',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'e'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'未连接空间'}}),service=new IndustryExecutionToolService(pool,identity,loads,sourceReader(loads),{ready:async()=>({ready:false as const,reason:'adapter unavailable'})}),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),requestId=randomUUID()
 await assert.rejects(service.authorize(owner,{requestId,instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/dependency-unavailable'})
 assert.deepEqual(await service.get(owner,{instanceId:created.id}),created)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_execution_tool_authorize_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].count,0)
})

test('授权拒绝客户端伪造定义以及核验期间发生的固定来源漂移',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'1'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移空间'}})
 let reads=0
 const drifting=sourceReader(loads,value=>{reads+=1;return reads===1?value:{...value,fileHash:'0'.repeat(64)}}),service=new IndustryExecutionToolService(pool,identity,loads,drifting,ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 await assert.rejects(service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1,adapterId:'forged'},new AbortController().signal),{code:'teloa/invalid-input'})
 await assert.rejects(service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal),{code:'teloa/source-unavailable'})
 assert.equal((await service.get(owner,{instanceId:created.id})).state,'needs_authorization')
})

test('并发授权只有一个请求能推进同一预期版本',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'2'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'并发空间'}}),service=new IndustryExecutionToolService(pool,identity,loads,sourceReader(loads),ready),created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),signal=new AbortController().signal
 const settled=await Promise.allSettled([service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},signal),service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},signal)])
 assert.equal(settled.filter(result=>result.status==='fulfilled').length,1)
 const failure=settled.find(result=>result.status==='rejected') as PromiseRejectedResult
 assert.equal(failure.reason.code,'teloa/version-conflict')
 assert.equal((await service.get(owner,{instanceId:created.id})).revision,2)
})

test('固定来源漂移后目录投影为待授权并保留绑定，写路径仍判定来源不可用',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source),load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'3'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'漂移投影空间'}})
 let drifted=false
 const reader=sourceReader(loads,value=>drifted?{...value,fileHash:'0'.repeat(64)}:value),service=new IndustryExecutionToolService(pool,identity,loads,reader,ready)
 const created=await service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId})
 const active=await service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:1},new AbortController().signal)
 assert.equal(active.state,'active');assert.ok(!('drift' in active))
 drifted=true
 const projected=await service.get(owner,{instanceId:created.id})
 assert.deepEqual(projected,{...active,state:'needs_authorization',drift:true})
 assert.deepEqual(await service.list(owner,{}),{items:[projected]})
 await assert.rejects(service.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:load.items[0]!.instanceId}),{code:'teloa/source-unavailable'})
 await assert.rejects(service.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:projected.revision},new AbortController().signal),{code:'teloa/source-unavailable'})
 const stored=(await pool.query('select state,revision,binding from teloa_industry_execution_tool_instances where id=$1',[created.id])).rows[0]
 assert.equal(stored.state,'active');assert.equal(stored.revision,2);assert.deepEqual(stored.binding,active.binding)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_execution_tool_authorize_requests where owner_id=$1',[owner])).rows[0].count,1)
})

test('目录逐行容错：损坏的执行工具实例只记入 errors，其余实例照常返回',async()=>{
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},loads=new IndustryLoadService(pool,identity,source)
 const first=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'4'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间甲'}})
 const second=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'5'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'容错空间乙'}})
 const service=new IndustryExecutionToolService(pool,identity,loads,sourceReader(loads),ready)
 const broken=await service.instantiate(owner,{requestId:randomUUID(),loadId:first.id,itemInstanceId:first.items[0]!.instanceId})
 const good=await service.instantiate(owner,{requestId:randomUUID(),loadId:second.id,itemInstanceId:second.items[0]!.instanceId})
 await pool.query('update teloa_industry_execution_tool_instances set item_local_id=$2 where id=$1',[broken.id,'tampered'])
 assert.deepEqual(await service.list(owner,{}),{items:[good],errors:[{instanceId:broken.id,code:'teloa/storage-corrupt'}]})
 await assert.rejects(service.get(owner,{instanceId:broken.id}),{code:'teloa/storage-corrupt'})
})
