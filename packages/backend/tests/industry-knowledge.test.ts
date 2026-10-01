import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryReferenceCatalog,combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {IndustryKnowledgeService,initializeIndustryKnowledge} from '../src/work/industry-knowledge.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {WorkError} from '@teloa/contract'
let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},enc=new TextEncoder(),file=(path:string,text:string)=>({path,bytes:enc.encode(text)})
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool);await initializeResources(pool);await initializeIndustryLoads(pool);await initializeIndustryKnowledge(pool)},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
async function setup(db:Pool,owner=randomUUID()){
 const market=new MarketContentStore(db,identity),manifest={format:'teloa.business-package/v2',id:'instantiate',title:'实例化',version:'1.0.0',domain:'research',description:'知识实例化',resources:[{id:'guide',kind:'knowledge',title:'行业指南',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}},{id:'optional',kind:'knowledge',title:'可选资料',version:'1.0.0',required:false,source:{kind:'local',path:'missing.md'}},{id:'role',kind:'role',title:'岗位',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}}],relations:[{kind:'role-knowledge',from:'role',to:'guide'}],entrypoints:[]},saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'实例化'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),file('guide.md','# 行业指南'),file('role.json','{}')],references:[]}),loads=new IndustryLoadService(db,identity,createIndustryLoadSource(market)),load=await loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'行业空间'}}),catalog=new IndustryReferenceCatalog(db,market,loads),sources=combineReferenceCatalogs(createPublicReferenceCatalog(),catalog),resources=new ResourceService(db,sources,identity),service=new IndustryKnowledgeService(db,identity,loads,sources,resources)
 return {owner,load,loads,sources,resources,service,item:load.items.find(row=>row.localId==='guide')!,skipped:load.items.find(row=>row.localId==='optional')!}
}
test('同请求和不同请求并发只创建一个真实资料并恢复固定回执',async()=>{
 const f=await setup(pool),requestId=randomUUID(),input={requestId,loadId:f.load.id,itemInstanceId:f.item.instanceId},[a,b,c]=await Promise.all([f.service.instantiate(f.owner,input),f.service.instantiate(f.owner,input),f.service.instantiate(f.owner,{...input,requestId:randomUUID()})])
 assert.equal(a.id,b.id);assert.equal(a.id,c.id);assert.equal(a.state,'active');assert.ok(a.resource);assert.deepEqual(a.resource!.scopeIds,[f.load.space.scope]);assert.equal(a.resource!.sourceId,a.sourceId)
 const counts=(await pool.query(`select (select count(*)::int from teloa_industry_knowledge_instances where owner_id=$1) instances,(select count(*)::int from teloa_resource_drafts where owner_id=$1) drafts,(select count(*)::int from teloa_resources where owner_id=$1) resources`,[f.owner])).rows[0];assert.deepEqual(counts,{instances:1,drafts:1,resources:1})
 const settled=await f.service.get(f.owner,{instanceId:a.id}),again=await f.service.instantiate(f.owner,input);assert.equal(again.revision,settled.revision);assert.equal((await f.service.list(f.owner,{})).items[0]!.resource!.id,a.resource!.id);assert.equal((await f.service.get(f.owner,{instanceId:a.id})).state,'active')
 await assert.rejects(f.service.instantiate(f.owner,{...input,loadId:randomUUID()}),{code:'teloa/conflict'})
})
test('跨本人、跳过项和伪造映射被拒且不留下实例',async()=>{
 const f=await setup(pool)
 await assert.rejects(f.service.instantiate(randomUUID(),{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.skipped.instanceId}),{code:'teloa/conflict'})
 await assert.rejects(f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:randomUUID()}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_knowledge_instances where owner_id=$1',[f.owner])).rows[0].count,0)
})
test('apply已提交且可核对时直接恢复同一资源，撤回不复活',async()=>{
 const f=await setup(pool),requestId=randomUUID(),input={requestId,loadId:f.load.id,itemInstanceId:f.item.instanceId},lossy={...f.resources,create:f.resources.create.bind(f.resources),findDraft:f.resources.findDraft.bind(f.resources),getResource:f.resources.getResource.bind(f.resources),apply:async(...args:Parameters<ResourceService['apply']>)=>{await f.resources.apply(...args);throw new WorkError('teloa/storage-unavailable','apply回包丢失')}},service=new IndustryKnowledgeService(pool,identity,f.loads,f.sources,lossy)
 const pending=await service.instantiate(f.owner,input);assert.equal(pending.state,'active');assert.ok(pending.resource)
 const recovered=await f.service.instantiate(f.owner,input);assert.equal(recovered.state,'active');assert.ok(recovered.resource)
 const withdrawn=await f.resources.withdraw({ownerId:f.owner,kind:'human',scopeIds:[f.load.space.scope]},{resourceId:recovered.resource!.id,expectedVersion:recovered.resource!.version});assert.equal(withdrawn.status,'withdrawn')
 const replay=await f.service.instantiate(f.owner,input);assert.equal(replay.state,'withdrawn');assert.equal(replay.resource!.id,recovered.resource!.id);assert.equal((await pool.query('select count(*)::int count from teloa_resources where owner_id=$1',[f.owner])).rows[0].count,1)
})
test('apply回包和恢复查询同时不可用时保留pending，随后get读回真实资源',async()=>{
 const f=await setup(pool),input={requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId};let unavailable=false
 const broken={create:f.resources.create.bind(f.resources),apply:async(...args:Parameters<ResourceService['apply']>)=>{await f.resources.apply(...args);unavailable=true;throw new WorkError('teloa/storage-unavailable','apply回包丢失')},findDraft:async(...args:Parameters<ResourceService['findDraft']>)=>{if(unavailable)throw new WorkError('teloa/storage-unavailable','恢复查询不可用');return f.resources.findDraft(...args)},getResource:f.resources.getResource.bind(f.resources)},service=new IndustryKnowledgeService(pool,identity,f.loads,f.sources,broken),pending=await service.instantiate(f.owner,input)
 assert.equal(pending.state,'pending');unavailable=false;const recovered=await f.service.get(f.owner,{instanceId:pending.id});assert.equal(recovered.state,'active');assert.ok(recovered.resource)
})
test('准备后与create提交后的未知中断均复用固定下游请求恢复',async()=>{
 for(const afterCreate of [false,true]){
  const f=await setup(pool),input={requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId},broken={create:async(...args:Parameters<ResourceService['create']>)=>{if(afterCreate)await f.resources.create(...args);throw new WorkError('teloa/storage-unavailable','create结果未知')},apply:f.resources.apply.bind(f.resources),findDraft:f.resources.findDraft.bind(f.resources),getResource:f.resources.getResource.bind(f.resources)},first=await new IndustryKnowledgeService(pool,identity,f.loads,f.sources,broken).instantiate(f.owner,input)
  assert.equal(first.state,'pending');const recovered=await f.service.instantiate(f.owner,input);assert.equal(recovered.state,'active');assert.equal((await pool.query('select count(*)::int count from teloa_resources where owner_id=$1',[f.owner])).rows[0].count,1)
 }
})
test('另一请求沿用已冻结映射，不依赖当前来源目录；draft查询仍核对范围',async()=>{
 const f=await setup(pool),first=await f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId}),unreadable={list:async()=>{throw new WorkError('teloa/source-unavailable','来源暂不可用')},read:f.sources.read.bind(f.sources)},service=new IndustryKnowledgeService(pool,identity,f.loads,unreadable,f.resources)
 const recovered=await service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId});assert.equal(recovered.resource!.id,first.resource!.id)
 const stored=(await pool.query('select downstream_request_id from teloa_industry_knowledge_instances where id=$1',[first.id])).rows[0];await assert.rejects(f.resources.findDraft({ownerId:f.owner,kind:'human',scopeIds:['general']},{requestId:stored.downstream_request_id}),{code:'teloa/forbidden'})
})
test('稳定下游身份及请求映射被合法UUID替换时显式损坏',async()=>{
 const a=await setup(pool),requestId=randomUUID(),input={requestId,loadId:a.load.id,itemInstanceId:a.item.instanceId},broken={create:async()=>{throw new WorkError('teloa/storage-unavailable','准备后中断')},apply:a.resources.apply.bind(a.resources),findDraft:a.resources.findDraft.bind(a.resources),getResource:a.resources.getResource.bind(a.resources)},pending=await new IndustryKnowledgeService(pool,identity,a.loads,a.sources,broken).instantiate(a.owner,input)
 await pool.query('update teloa_industry_knowledge_instances set downstream_request_id=$2 where id=$1',[pending.id,randomUUID()]);await assert.rejects(a.service.instantiate(a.owner,input),{code:'teloa/storage-corrupt'})
 const ownA=await setup(pool),ownB=await setup(pool,ownA.owner),receiptId=randomUUID(),left=await ownA.service.instantiate(ownA.owner,{requestId:receiptId,loadId:ownA.load.id,itemInstanceId:ownA.item.instanceId}),right=await ownB.service.instantiate(ownB.owner,{requestId:randomUUID(),loadId:ownB.load.id,itemInstanceId:ownB.item.instanceId});await pool.query('update teloa_industry_knowledge_requests set instance_id=$1 where owner_id=$2 and request_id=$3',[right.id,ownA.owner,receiptId]);await assert.rejects(ownA.service.instantiate(ownA.owner,{requestId:receiptId,loadId:ownA.load.id,itemInstanceId:ownA.item.instanceId}),{code:'teloa/storage-corrupt'});assert.ok(left)
 const other=await setup(pool),foreign=await other.service.instantiate(other.owner,{requestId:randomUUID(),loadId:other.load.id,itemInstanceId:other.item.instanceId}),clean=await setup(pool),ownRequest=randomUUID();await clean.service.instantiate(clean.owner,{requestId:ownRequest,loadId:clean.load.id,itemInstanceId:clean.item.instanceId});await pool.query('update teloa_industry_knowledge_requests set instance_id=$1 where owner_id=$2 and request_id=$3',[foreign.id,clean.owner,ownRequest]);await assert.rejects(clean.service.instantiate(clean.owner,{requestId:ownRequest,loadId:clean.load.id,itemInstanceId:clean.item.instanceId}),{code:'teloa/storage-corrupt'})
})
test('create提交后草案被编辑，恢复拒绝且不应用错误资料',async()=>{
 const f=await setup(pool),input={requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId},broken={create:async(...args:Parameters<ResourceService['create']>)=>{await f.resources.create(...args);throw new WorkError('teloa/storage-unavailable','create回包丢失')},apply:f.resources.apply.bind(f.resources),findDraft:f.resources.findDraft.bind(f.resources),getResource:f.resources.getResource.bind(f.resources)},pending=await new IndustryKnowledgeService(pool,identity,f.loads,f.sources,broken).instantiate(f.owner,input),stored=(await pool.query('select downstream_request_id from teloa_industry_knowledge_instances where id=$1',[pending.id])).rows[0],ownerActor={ownerId:f.owner,kind:'human' as const,scopeIds:[f.load.space.scope]},draft=await f.resources.findDraft(ownerActor,{requestId:stored.downstream_request_id});assert.ok(draft)
 await f.resources.update(ownerActor,{draftId:draft!.id,expectedVersion:draft!.version,title:'被编辑',sourceId:draft!.sourceId,sourceVersion:draft!.sourceVersion,scopeIds:draft!.scopeIds});await assert.rejects(f.service.instantiate(f.owner,input),{code:'teloa/storage-corrupt'});assert.equal((await pool.query('select count(*)::int count from teloa_resources where owner_id=$1',[f.owner])).rows[0].count,0)
})
test('连接池max=1时协调事务不跨下游调用持有连接',async()=>{
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500})
 try{const f=await setup(single),saved=await f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.item.instanceId});assert.equal(saved.state,'active')}finally{await single.end()}
})
