import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {IndustryReferenceCatalog,combineReferenceCatalogs} from '../src/capabilities/industry-reference-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {IndustryKnowledgeService,initializeIndustryKnowledge} from '../src/work/industry-knowledge.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {IndustryRoleService,catalogRoleRequestId,initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {WorkError} from '@teloa/contract'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {ConversationService,FileConversationRepository} from '../src/work/conversations.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {BindingClient} from '../../client/ui-workbench/src/client/binding-client.ts'
import {createObjectConversationApi} from '../../client/ui-workbench/src/client/object-conversation-api.ts'
import {ensureHomeObjectContext} from '../../client/ui-workbench/src/client/home-object-context.ts'
import {TaskService} from '../src/work/tasks.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()},enc=new TextEncoder(),file=(path:string,text:string)=>({path,bytes:enc.encode(text)})
const responsibility={triggers:['收到安全事件'],autonomousActions:['读取已授权证据'],confirmationPoints:['执行变更前请本人核对'],escalationRules:['证据冲突时升级'],deliveryChecks:['结论包含证据来源']}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeMarketContents(pool);await initializeResources(pool);await initializeIndustryLoads(pool);await initializeKnowledgeAndRoles(pool)},{timeout:180_000})
async function initializeKnowledgeAndRoles(db:Pool){await initializeIndustryKnowledge(db);await initializeRoles(db);await initializeCollaboration(db);await initializeGroupAgentGrants(db);await initializeTasks(db);await initializeRoleLifecycle(db);await initializeIndustryRoles(db)}
after(async()=>{await pool?.end();await container?.stop()})

async function setup(db:Pool,owner=randomUUID(),roleBytes:Uint8Array=enc.encode(JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility}))){
 const market=new MarketContentStore(db,identity),manifest={format:'teloa.business-package/v2',id:'roles',title:'岗位',version:'1.0.0',domain:'general',description:'岗位实例化',resources:[{id:'guide',kind:'knowledge',title:'必需资料',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}},{id:'optional',kind:'knowledge',title:'可选资料',version:'1.0.0',required:false,source:{kind:'local',path:'missing.md'}},{id:'analyst',kind:'role',title:'分析岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},{id:'tool',kind:'skill',title:'工具声明',version:'1.0.0',required:false,source:{kind:'local',path:'tool.md'}}],relations:[{kind:'role-knowledge',from:'analyst',to:'guide'},{kind:'role-knowledge',from:'analyst',to:'optional'},{kind:'role-skill',from:'analyst',to:'tool'}],entrypoints:[]},saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'岗位'},manifestPath:'teloa.json',files:[file('teloa.json',JSON.stringify(manifest)),file('guide.md','# 指南'),{path:'role.json',bytes:roleBytes},file('tool.md','声明')],references:[]}),loads=new IndustryLoadService(db,identity,createIndustryLoadSource(market)),load=await loads.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'行业空间'}}),catalog=new IndustryReferenceCatalog(db,market,loads),sources=combineReferenceCatalogs(createPublicReferenceCatalog(),catalog),resources=new ResourceService(db,sources,identity),knowledge=new IndustryKnowledgeService(db,identity,loads,sources,resources),roles=new RoleService(db,identity),service=new IndustryRoleService(db,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles)
 return {owner,load,loads,resources,knowledge,roles,service,role:load.items.find(x=>x.localId==='analyst')!,guide:load.items.find(x=>x.localId==='guide')!}
}

test('固定行业依赖创建默认暂停岗位，声明不转成授权',async()=>{const f=await setup(pool),ki=await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId}),input={requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId},[a,b]=await Promise.all([f.service.instantiate(f.owner,input),f.service.instantiate(f.owner,{...input,requestId:randomUUID()})]);assert.equal(a.id,b.id);assert.equal(a.state,'paused');assert.deepEqual(a.role!.scopes,[f.load.space.scope]);assert.deepEqual(a.role!.skills,[]);assert.deepEqual(a.role!.knowledge,[ki.resource!.id]);assert.deepEqual(a.omittedKnowledge.map(x=>x.reason),['skipped']);assert.deepEqual(a.declarations.map(x=>x.status),['pending-adapter']);assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,1)})

test('终审 I-2：方案模板指定的首选/备用模型不应用到岗位，实例记录带可见的 model/skipped 声明',async()=>{const bytes=enc.encode(JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility,runtimeConfig:{agentPresetId:'security-analyst',model:{provider:'deepseek-official',model:'deepseek-flash'},fallbackModel:{provider:'other-cloud',model:'x'}}})),f=await setup(pool,randomUUID(),bytes);await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId});const created=await f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId});assert.equal(created.state,'paused');assert.deepEqual(created.role!.runtimeConfig,{agentPresetId:'security-analyst'});assert.ok(created.declarations.some(row=>row.kind==='model'&&row.status==='skipped'&&row.itemInstanceId===f.role.instanceId),JSON.stringify(created.declarations));const listed=await f.service.get(f.owner,{instanceId:created.id});assert.ok(listed.declarations.some(row=>row.kind==='model'))})

test('行业岗位的推荐职责与运行配置固定到暂停岗位并等待后续核验',async()=>{const bytes=enc.encode(JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility,runtimeConfig:{agentPresetId:'security-analyst'}})),f=await setup(pool,randomUUID(),bytes);await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId});const created=await f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId});assert.equal(created.state,'paused');assert.deepEqual(created.role!.responsibility,responsibility);assert.deepEqual(created.role!.runtimeConfig,{agentPresetId:'security-analyst'});assert.deepEqual(created.role!.skills,[]);assert.equal((await pool.query('select state from teloa_roles where id=$1',[created.role!.id])).rows[0].state,'paused')})
test('旧行业岗位模板缺少结构化职责时以空职责实例化，不改写固定来源字节',async()=>{
 const original=JSON.stringify({format:'teloa.role/v1',name:'旧分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟'}),f=await setup(pool,randomUUID(),enc.encode(original))
 await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId})
 const created=await f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId})
 assert.deepEqual(created.role!.responsibility,{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]})
 const source=await new MarketContentStore(pool,identity).get({ownerId:f.owner,kind:'human'},{contentId:f.load.contentId})
 assert.equal(new TextDecoder().decode(source.files.find(file=>file.path==='role.json')!.bytes),original)
})

test('必需知识未启用时拒绝且不留下岗位映射',async()=>{const f=await setup(pool);await assert.rejects(f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId}),{code:'teloa/dependency-unavailable'});assert.equal((await pool.query('select count(*)::int n from teloa_industry_role_instances where owner_id=$1',[f.owner])).rows[0].n,0)})

test('创建提交后回包丢失可核回同一岗位，合法编辑、退役和知识撤回不被重放覆盖',async()=>{const f=await setup(pool),ki=await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId}),input={requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId},lossy={createOrExisting:f.roles.createOrExisting.bind(f.roles),findByRequest:f.roles.findByRequest.bind(f.roles),editInTransaction:f.roles.editInTransaction.bind(f.roles),create:async(...args:Parameters<RoleService['create']>)=>{await f.roles.create(...args);throw new WorkError('teloa/storage-unavailable','回包丢失')}},created=await new IndustryRoleService(pool,identity,f.loads,new IndustryRoleSource(new MarketContentStore(pool,identity),f.loads),f.knowledge,lossy).instantiate(f.owner,input);assert.equal(created.state,'paused');const edited=await f.roles.edit(f.owner,{roleId:created.role!.id,expectedVersion:created.role!.version,fields:{name:'合法改名',kind:created.role!.kind,scopes:[...created.role!.scopes,'general'],duty:created.role!.duty,dataScope:created.role!.dataScope,executionScope:created.role!.executionScope,skills:created.role!.skills,knowledge:[],responsibility:created.role!.responsibility!}}),lifecycle=new RoleLifecycleService(pool,identity),active=await lifecycle.change(f.owner,{roleId:edited.id,expectedVersion:edited.version,action:'resume',reason:'验收'}),retired=await lifecycle.change(f.owner,{roleId:edited.id,expectedVersion:active.role.version,action:'retire',reason:'验收'});await f.resources.withdraw({ownerId:f.owner,kind:'human',scopeIds:[f.load.space.scope]},{resourceId:ki.resource!.id,expectedVersion:ki.resource!.version});const again=await f.service.instantiate(f.owner,input);assert.equal(again.role!.name,'合法改名');assert.deepEqual(again.role!.knowledge,[]);assert.equal(again.state,'retired');assert.equal(again.role!.id,retired.role.id);assert.equal((await f.service.list(f.owner,{})).items[0]!.state,'retired')})

test('请求目标与回执坏指针显式区分冲突和存储损坏',async()=>{const a=await setup(pool),b=await setup(pool,a.owner);for(const f of [a,b])await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId});const requestId=randomUUID(),left=await a.service.instantiate(a.owner,{requestId,loadId:a.load.id,itemInstanceId:a.role.instanceId}),right=await b.service.instantiate(b.owner,{requestId:randomUUID(),loadId:b.load.id,itemInstanceId:b.role.instanceId});await assert.rejects(a.service.instantiate(a.owner,{requestId,loadId:b.load.id,itemInstanceId:b.role.instanceId}),{code:'teloa/conflict'});await pool.query('update teloa_industry_role_requests set instance_id=$1 where owner_id=$2 and request_id=$3',[right.id,a.owner,requestId]);await assert.rejects(a.service.instantiate(a.owner,{requestId,loadId:a.load.id,itemInstanceId:a.role.instanceId}),{code:'teloa/storage-corrupt'});assert.ok(left)})

test('首次依赖边界拒绝不属于目标加载的伪active回包',async()=>{const f=await setup(pool),real=await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId}),fake={get:async()=>({...real,loadId:randomUUID()})},service=new IndustryRoleService(pool,identity,f.loads,new IndustryRoleSource(new MarketContentStore(pool,identity),f.loads),fake,f.roles);await assert.rejects(service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId}),{code:'teloa/storage-corrupt'});assert.equal((await pool.query('select count(*)::int n from teloa_industry_role_instances where owner_id=$1',[f.owner])).rows[0].n,0)})

test('准备身份篡改被拒，提交与恢复查询同时失联时随后可恢复',async()=>{const a=await setup(pool);await a.knowledge.instantiate(a.owner,{requestId:randomUUID(),loadId:a.load.id,itemInstanceId:a.guide.instanceId});const input={requestId:randomUUID(),loadId:a.load.id,itemInstanceId:a.role.instanceId},unavailable={createOrExisting:a.roles.createOrExisting.bind(a.roles),create:async()=>{throw new WorkError('teloa/storage-unavailable','准备中断')},findByRequest:a.roles.findByRequest.bind(a.roles),editInTransaction:a.roles.editInTransaction.bind(a.roles)},pending=await new IndustryRoleService(pool,identity,a.loads,new IndustryRoleSource(new MarketContentStore(pool,identity),a.loads),a.knowledge,unavailable).instantiate(a.owner,input);assert.equal(pending.state,'pending');await pool.query('update teloa_industry_role_instances set downstream_request_id=$2 where id=$1',[pending.id,randomUUID()]);await assert.rejects(a.service.instantiate(a.owner,input),{code:'teloa/storage-corrupt'});const b=await setup(pool);await b.knowledge.instantiate(b.owner,{requestId:randomUUID(),loadId:b.load.id,itemInstanceId:b.guide.instanceId});let lost=false;const uncertain={createOrExisting:b.roles.createOrExisting.bind(b.roles),create:async(...args:Parameters<RoleService['create']>)=>{await b.roles.create(...args);lost=true;throw new WorkError('teloa/storage-unavailable','提交回包丢失')},findByRequest:async(...args:Parameters<RoleService['findByRequest']>)=>{if(lost)throw new WorkError('teloa/storage-unavailable','恢复查询不可用');return b.roles.findByRequest(...args)},editInTransaction:b.roles.editInTransaction.bind(b.roles)},service=new IndustryRoleService(pool,identity,b.loads,new IndustryRoleSource(new MarketContentStore(pool,identity),b.loads),b.knowledge,uncertain),unknown=await service.instantiate(b.owner,{requestId:randomUUID(),loadId:b.load.id,itemInstanceId:b.role.instanceId});assert.equal(unknown.state,'pending');lost=false;assert.equal((await service.get(b.owner,{instanceId:unknown.id})).state,'paused')})


test('岗位固定文件拒绝权限字段、非法UTF8和超限内容',async()=>{for(const bytes of [enc.encode(JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'资料',executionScope:'代拟',scopes:['general']})),new Uint8Array([0xff,0xfe]),new Uint8Array(128*1024+1).fill(32)]){const f=await setup(pool,randomUUID(),bytes);await assert.rejects(f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId}),{code:'teloa/source-unavailable'});assert.equal((await pool.query('select count(*)::int n from teloa_industry_role_instances where owner_id=$1',[f.owner])).rows[0].n,0)}})

test('max=1不会在下游调用期间占用事务连接',async()=>{const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500});try{const f=await setup(single);await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.guide.instanceId});assert.equal((await f.service.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:f.role.instanceId})).state,'paused')}finally{await single.end()}})

const catalogRoleEntry=()=>({format:'teloa.market-catalog-entry/v1' as const,id:'teloa.role.analyst',kind:'role' as const,delivery:'install' as const,version:'1.0.0',upstream:null,
 taxonomy:{functions:['security' as const],industries:['general' as const]},
 role:{roleId:'analyst',title:{'zh-CN':'分析岗',en:'Analyst'},summary:{'zh-CN':'核对。',en:'Check.'},
  definition:{name:'分析岗',kind:'employee' as const,duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility},
  skills:['tool','absent-skill'],scope:'analysis',preferredModel:null,fromSolution:{packageId:'roles',version:'1.0.0',path:'roles/analyst.json'}},
 modifications:[],license:{spdx:'MIT',files:[],url:'https://opensource.org/license/mit'},
 compatibility:{status:'content-only' as const,teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},
 requires:{tools:[],network:false,runtimes:[]},review:{status:'approved' as const,reviewedAt:'2026-09-25',reviewer:'Teloa'}})

test('createFromCatalog：建暂停岗位、scopes 继承条目 scope、技能原样写声明；同一人重复添加返回同一岗位 existing，不重复建岗；不同人各建各的',async()=>{
 const f=await setup(pool),input={entryId:'teloa.role.analyst',version:'1.0.0'}
 assert.equal((await f.service.catalogRoleIds(f.owner,[catalogRoleEntry()])).size,0)
 const first=await f.service.createFromCatalog(f.owner,input,catalogRoleEntry())
 assert.equal((await f.service.catalogRoleIds(f.owner,[catalogRoleEntry()])).get('teloa.role.analyst'),first.roleId);assert.equal((await f.service.catalogRoleIds(f.owner,[{...catalogRoleEntry(),version:'1.0.1'}])).size,0)
 assert.equal(first.status,'created');assert.deepEqual(first.skills,['tool','absent-skill'])
 const row=(await pool.query('select definition,state,request_id from teloa_roles where id=$1 and owner_id=$2',[first.roleId,f.owner])).rows[0]
 assert.equal(row.state,'paused');assert.deepEqual(row.definition.scopes,['analysis']);assert.deepEqual(row.definition.skills,['tool','absent-skill']);assert.deepEqual(row.definition.responsibility,responsibility)
 assert.equal(row.request_id,catalogRoleRequestId(f.owner,'teloa.role.analyst','1.0.0'))
 const again=await f.service.createFromCatalog(f.owner,input,catalogRoleEntry())
 assert.deepEqual(again,{...first,status:'existing'})
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,1)
 const other=await setup(pool)
 assert.notEqual((await other.service.createFromCatalog(other.owner,input,catalogRoleEntry())).roleId,first.roleId)
 await assert.rejects(f.service.createFromCatalog(f.owner,{...input,version:'1.0.1'},catalogRoleEntry()),{code:'teloa/version-conflict'})
 await assert.rejects(f.service.createFromCatalog(f.owner,{...input,extra:1},catalogRoleEntry()),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.createFromCatalog('',input,catalogRoleEntry()),{code:'teloa/forbidden'})
})

test('市场引入的暂停同事首次聊天一次完成会话与岗位关联，不恢复岗位、不接新任务、不重复创建',async()=>{
 const f=await setup(pool),entry=catalogRoleEntry(),input={entryId:entry.id,version:entry.version}
 const receipt=await f.service.createFromCatalog(f.owner,input,entry)
 const role=(await f.roles.list(f.owner,{})).find(row=>row.id===receipt.roleId)!
 assert.equal(role.state,'paused')
 await initializeObjectConversations(pool)
 const directory=await mkdtemp(join(tmpdir(),'teloa-market-first-chat-'))
 try{
  const native=new Set<string>()
  const conversations=new ConversationService(new FileConversationRepository(join(directory,'conversations.json')),{create:async id=>{native.add(id);return id},inspect:async id=>{assert.ok(native.has(id))}},identity,async(owner,id)=>(await f.roles.list(owner,{})).find(row=>row.id===id))
  const links=new ObjectConversationService(pool,async(owner,id)=>conversations.bySession(owner,id),identity.now)
  const api=createObjectConversationApi(async(method,payload)=>method==='object-conversations/list'?links.list(f.owner,payload):links.change(f.owner,payload))
  let current:string|undefined
  const work=new BindingClient({list:()=>conversations.list(f.owner,{}),read:id=>conversations.bySession(f.owner,id),ensure:id=>conversations.ensure(f.owner,{sessionId:id}),isNativeChild:()=>false,catalog:async()=>{throw Error('首聊不读取能力目录')},block:()=>{},create:command=>conversations.create(f.owner,{...command,title:command.title??'新工作会话'}),adopt:async id=>id,open:id=>{current=id},current:()=>current})
  const created=await work.create({roleId:role.id,beforeOpen:async conversation=>{await ensureHomeObjectContext(api,{kind:'role',id:role.id,title:role.name,version:role.version,canStart:true},conversation.sessionId,entry.role.scope)}})
  assert.equal(current,created.sessionId)
  assert.equal(work.getPendingCreation(),undefined)
  const linked=await links.bySession(f.owner,{sessionId:created.sessionId})
  assert.equal(linked.length,1);assert.equal(linked[0]!.objectId,role.id);assert.equal(linked[0]!.scopeId,entry.role.scope)
  const command={requestId:randomUUID(),kind:'role',objectId:role.id,expectedObjectVersion:role.version,sessionId:randomUUID(),expectedLinkVersion:0,action:'link',scopeId:entry.role.scope}
  await assert.rejects(links.change(randomUUID(),command),{code:'teloa/forbidden'})
  await assert.rejects(links.change(f.owner,{...command,expectedObjectVersion:role.version+1}),{code:'teloa/version-conflict'})
  await assert.rejects(links.change(f.owner,{...command,scopeId:'GRC'}),{code:'teloa/forbidden'})
  assert.equal((await links.list(f.owner,{kind:'role',objectId:role.id})).length,1)
  assert.equal((await f.roles.list(f.owner,{})).find(row=>row.id===role.id)!.state,'paused')
  assert.equal((await f.service.createFromCatalog(f.owner,input,entry)).roleId,role.id)
  assert.equal((await conversations.list(f.owner,{})).length,1)
  assert.equal((await f.roles.list(f.owner,{})).length,1)
  const tasks=new TaskService(pool,identity)
  await assert.rejects(tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'不得自动接单',goal:'保持暂停',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),{code:'teloa/conflict'})
  assert.deepEqual(await tasks.list(f.owner,{}),[])
 }finally{await rm(directory,{recursive:true,force:true})}
})

test('createFromCatalog 并发：同一人同时添加同一条目版本只建一条岗位，恰一个回 created、其余回 existing',async()=>{
 const f=await setup(pool),input={entryId:'teloa.role.analyst',version:'1.0.0'}
 // 若实现先查后建，让所有调用都先读到「尚无岗位」再往下走，稳定复现先查后建的竞态。
 const read=f.roles.findByRequest.bind(f.roles);let arrived=0,release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve})
 f.roles.findByRequest=async(...args)=>{const found=await read(...args);if(++arrived===6)release();await gate;return found}
 const results=await Promise.all(Array.from({length:6},()=>f.service.createFromCatalog(f.owner,input,catalogRoleEntry())))
 assert.deepEqual(results.map(item=>item.status).sort(),['created','existing','existing','existing','existing','existing'])
 assert.equal(new Set(results.map(item=>item.roleId)).size,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,1)
})

test('createFromCatalog：退役岗位不算已添加，同一条目版本可重新添加并建新岗位；catalogRoleIds 一次按请求 id 批量回显',async()=>{
 const f=await setup(pool),input={entryId:'teloa.role.analyst',version:'1.0.0'},entry=catalogRoleEntry(),other={...catalogRoleEntry(),id:'teloa.role.other'}
 const first=await f.service.createFromCatalog(f.owner,input,entry)
 const queries:unknown[]=[],query=pool.query.bind(pool);(pool as {query:unknown}).query=(...args:unknown[])=>{queries.push(args[0]);return (query as (...a:unknown[])=>unknown)(...args)}
 try{assert.deepEqual([...(await f.service.catalogRoleIds(f.owner,[entry,other]))],[['teloa.role.analyst',first.roleId]]);assert.equal(queries.length,1)}finally{(pool as {query:unknown}).query=query}
 const lifecycle=new RoleLifecycleService(pool,identity),role=(await f.roles.list(f.owner,{})).find(item=>item.id===first.roleId)!
 await lifecycle.change(f.owner,{roleId:role.id,expectedVersion:role.version,action:'retire',reason:'验收'})
 assert.equal((await f.service.catalogRoleIds(f.owner,[entry])).size,0)
 const again=await f.service.createFromCatalog(f.owner,input,entry)
 assert.equal(again.status,'created');assert.notEqual(again.roleId,first.roleId)
 assert.deepEqual([...(await f.service.catalogRoleIds(f.owner,[entry]))],[['teloa.role.analyst',again.roleId]])
 const third=await f.service.createFromCatalog(f.owner,input,entry)
 assert.equal(third.status,'existing');assert.equal(third.roleId,again.roleId)
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,2)
})

test('catalogRoleIds 退役链：查询轮数=该页最长退役链长度+1，各条目同轮批量查，不按条目逐个查',async()=>{
 const f=await setup(pool),input={entryId:'teloa.role.analyst',version:'1.0.0'},entry=catalogRoleEntry(),other={...catalogRoleEntry(),id:'teloa.role.other'}
 const lifecycle=new RoleLifecycleService(pool,identity)
 const retire=async(roleId:string)=>{const role=(await f.roles.list(f.owner,{})).find(item=>item.id===roleId)!;await lifecycle.change(f.owner,{roleId,expectedVersion:role.version,action:'retire',reason:'验收'})}
 const counted=async()=>{
  const queries:unknown[]=[],query=pool.query.bind(pool);(pool as {query:unknown}).query=(...args:unknown[])=>{queries.push(args[0]);return (query as (...a:unknown[])=>unknown)(...args)}
  try{return {ids:[...(await f.service.catalogRoleIds(f.owner,[entry,other]))],queries:queries.length}}finally{(pool as {query:unknown}).query=query}
 }
 await retire((await f.service.createFromCatalog(f.owner,input,entry)).roleId)
 await retire((await f.service.createFromCatalog(f.owner,input,entry)).roleId)
 // 两代都已退役：第一轮命中第一代、第二轮命中第二代、第三轮查不到——三轮收口；没有岗位的 other 与之同轮，不另加查询。
 assert.deepEqual(await counted(),{ids:[],queries:3})
 const third=await f.service.createFromCatalog(f.owner,input,entry)
 assert.equal(third.status,'created')
 assert.deepEqual(await counted(),{ids:[['teloa.role.analyst',third.roleId]],queries:3})
})

test('createFromCatalog：查到请求 id 之后、创建之前岗位恰被退役，沿下一代请求 id 重新创建，不回「已添加」那条退役岗位',async()=>{
 const f=await setup(pool),input={entryId:'teloa.role.analyst',version:'1.0.0'},entry=catalogRoleEntry()
 const first=await f.service.createFromCatalog(f.owner,input,entry)
 const lifecycle=new RoleLifecycleService(pool,identity),original=f.roles.createOrExisting.bind(f.roles)
 let raced=false
 // 只在第一次调用时插入退役：此刻 catalogRoleRequests 已按「未退役」取回第一代请求 id。
 ;(f.roles as {createOrExisting:unknown}).createOrExisting=async(...args:Parameters<typeof original>)=>{
  if(!raced){raced=true;const role=(await f.roles.list(f.owner,{})).find(item=>item.id===first.roleId)!;await lifecycle.change(f.owner,{roleId:role.id,expectedVersion:role.version,action:'retire',reason:'并发退役'})}
  return original(...args)
 }
 try{
  const again=await f.service.createFromCatalog(f.owner,input,entry)
  assert.equal(raced,true)
  assert.equal(again.status,'created');assert.notEqual(again.roleId,first.roleId)
  assert.deepEqual([...(await f.service.catalogRoleIds(f.owner,[entry]))],[['teloa.role.analyst',again.roleId]])
 }finally{(f.roles as {createOrExisting:unknown}).createOrExisting=original}
})

test('createFromCatalog：目录未升版本但内容变化时回 teloa/conflict 提示刷新，不报存储损坏、不另建岗位',async()=>{
 const f=await setup(pool),input={entryId:'teloa.role.analyst',version:'1.0.0'}
 await f.service.createFromCatalog(f.owner,input,catalogRoleEntry())
 const changed=catalogRoleEntry();changed.role.definition.duty='改过的职责'
 await assert.rejects(f.service.createFromCatalog(f.owner,input,changed),{code:'teloa/conflict',message:'目录条目已变化，请刷新后重试。'})
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[f.owner])).rows[0].n,1)
})
