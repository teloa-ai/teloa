import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {
 BusinessScopeService,BusinessSpaceService,IndustryDataSourceService,IndustryExecutionToolService,IndustryKnowledgeService,
 IndustryLoadService,IndustryMcpConnectionService,IndustryPluginService,IndustryReferenceCatalog,IndustryRoleService,IndustryRoleSource,
 MarketContentStore,ResourceService,RoleService,combineReferenceCatalogs,createIndustryLoadSource,
 initializeIndustryDataSources,initializeIndustryExecutionTools,initializeIndustryKnowledge,initializeIndustryLoads,
 initializeIndustryMcpConnections,initializeIndustryPlugins,initializeIndustryRoles,initializeMarketContents,initializeResources,
 initializeCollaboration,initializeGroupAgentGrants,initializeRoleLifecycle,initializeRoles,initializeTasks,migrateToPersonalSpace,rollbackPersonalSpaceMigration,
 IndustryPlanService,IndustryPlanSource,IndustryWorkSource,PlanService,RoleLifecycleService,TaskService,
 initializeIndustryPlans,initializePlans,
 type IndustryLoadRecord,type IndustryLoadService as IndustryLoadServiceType,type IndustryPluginInstallPort,
} from '../src/index.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const enc=new TextEncoder(),file=(path:string,text:string)=>({path,bytes:enc.encode(text)})
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeResources(pool);await initializeIndustryLoads(pool)
 await initializeIndustryKnowledge(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool)
 await initializeRoleLifecycle(pool);await initializeIndustryRoles(pool)
 await initializeIndustryDataSources(pool);await initializeIndustryExecutionTools(pool)
 await initializeIndustryMcpConnections(pool);await initializeIndustryPlugins(pool)
 await initializePlans(pool);await initializeIndustryPlans(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const responsibility={triggers:['收到事件'],autonomousActions:['读取资料'],confirmationPoints:['执行前核对'],escalationRules:['冲突时升级'],deliveryChecks:['附证据来源']}
/** 模板覆盖六类有实例投影的资源，迁移测试因此能一次断言全部六张冻结实例表。 */
const manifest=(domain:string,scope=domain)=>({
 format:'teloa.business-package/v2',id:'migration',title:'迁移模板',version:'1.0.0',domain,scope,description:'多空间迁移',
 resources:[
  {id:'guide',kind:'knowledge',title:'行业指南',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}},
  {id:'analyst',kind:'role',title:'分析岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},
  {id:'alerts',kind:'data-source',title:'告警来源',version:'1.0.0',required:false,source:{kind:'local',path:'alerts.json'}},
  {id:'action',kind:'execution-tool',title:'处置工具',version:'1.0.0',required:false,source:{kind:'local',path:'action.json'}},
  {id:'bridge',kind:'mcp',title:'资料连接',version:'1.0.0',required:false,source:{kind:'local',path:'bridge.json'}},
  {id:'viewer',kind:'plugin',title:'可视化插件',version:'1.0.0',required:false,source:{kind:'local',path:'viewer.json'}},
 ],
 relations:[{kind:'role-knowledge',from:'analyst',to:'guide'}],entrypoints:[],
})
const files=(domain:string,body:string,scope=domain)=>[
 file('teloa.json',JSON.stringify(manifest(domain,scope))),file('guide.md',body),
 file('role.json',JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility})),
 file('alerts.json','{}'),file('action.json','{}'),file('bridge.json','{}'),file('viewer.json','{}'),
]
/** 四类 kit 资源的固定来源形状一致，测试按加载项回放同一份定义即可。 */
const reader=<T>(loads:IndustryLoadServiceType,definition:T|((load:IndustryLoadRecord)=>T))=>({read:async(db:Parameters<IndustryLoadServiceType['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{
 const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId)
 assert.ok(item)
 return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:typeof definition==='function'?(definition as (load:IndustryLoadRecord)=>T)(load):definition}
}})
const unavailable=async():Promise<never>=>{throw new Error('本测试只登记 kit 实例，不推进安装')}
const pluginPort:IndustryPluginInstallPort={preview:unavailable,install:unavailable,reconcile:unavailable,find:async()=>null}
const instanceOf=(load:IndustryLoadRecord,localId:string)=>load.items.find(item=>item.localId===localId)!.instanceId
const count=async(sql:string,params:unknown[]):Promise<number>=>Number((await pool.query(sql,params)).rows[0].count)
const receipts=async(owner:string)=>(await pool.query('select kind,target_table,target_id,previous from teloa_business_space_migrations where owner_id=$1 order by kind,target_table,target_id',[owner])).rows
const spaces=async(owner:string)=>(await pool.query('select id,kind from teloa_business_spaces where owner_id=$1 order by created_at,id',[owner])).rows
const loadRow=async(id:string)=>(await pool.query('select space_id,space_version,status,unloaded_at,domain,scope from teloa_industry_loads where id=$1',[id])).rows[0]

/** 一套完整装配：同一个连接池上的全部服务，`edition` 取默认值（个人版），因此目标锁定按真实行为生效。 */
function assemble(owner:string){
 const market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const catalog=new IndustryReferenceCatalog(pool,market,loads)
 const sources=combineReferenceCatalogs(createPublicReferenceCatalog(),catalog)
 const resources=new ResourceService(pool,sources,identity)
 const knowledge=new IndustryKnowledgeService(pool,identity,loads,sources,resources)
 const roles=new RoleService(pool,identity)
 const roleInstances=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles)
 const dataSources=new IndustryDataSourceService(pool,identity,loads,reader(loads,(load:IndustryLoadRecord)=>({format:'teloa.data-source/v1' as const,sourceId:'research-alert-http',scopes:[load.domain]})),{ready:async()=>({ready:true as const,probedAt:'2026-09-15T00:00:00.000Z'})})
 const executionTools=new IndustryExecutionToolService(pool,identity,loads,reader(loads,{format:'teloa.execution-tool/v1' as const,adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate']}),{ready:async()=>({ready:true as const})})
 const mcp=new IndustryMcpConnectionService(pool,identity,loads,reader(loads,{format:'teloa.mcp-connection/v1' as const,serverName:'teloa_reference',tools:['read_reference']}),{ready:async()=>({ready:true as const,observedAt:'2026-09-15T00:00:00.000Z'})})
 const plugins=new IndustryPluginService(pool,identity,loads,reader(loads,{format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'dsh-visualize',version:'0.1.2'}),pluginPort)
 return {owner,market,loads,catalog,sources,resources,knowledge,roles,roleInstances,dataSources,executionTools,mcp,plugins,spacesService:new BusinessSpaceService(pool,identity),scopes:new BusinessScopeService(pool)}
}

/**
 * 在指定空间里建一条加载。`domain` 先取 `'space-<空间身份>'`——这正是第二阶段之前所有实例冻结下来的取值形状，
 * 用真实服务实例化就能得到与存量库一字不差的行，不必在测试里另算一遍各表的派生指纹。
 */
async function loadInto(f:ReturnType<typeof assemble>,spaceId:string,body:string,name='团队空间'){
 const saved=await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'迁移'},manifestPath:'teloa.json',files:files('space-'+spaceId,body),references:[]})
 return f.loads.create(f.owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId,name}})
}
/** 把加载的 `scope` 改回真实业务范围标签；市场行业归类 `domain` 保持不动。 */
async function relabel(load:IndustryLoadRecord,scope:string){
 await pool.query("update teloa_industry_loads set scope=$2,source_snapshot=jsonb_set(source_snapshot,'{scope}',to_jsonb($2::text)) where id=$1",[load.id,scope])
}

test('0 行与 1 行空间：引导后迁移无事可做，本人空间恒为一行',async()=>{
 const f=assemble(randomUUID())
 const personal=await f.spacesService.ensurePersonal(f.owner)
 assert.equal(personal.kind,'personal')
 assert.deepEqual(await receipts(f.owner),[])
 assert.deepEqual(await migrateToPersonalSpace(pool,f.owner),{moved:0,unloaded:0,scopes:0,resources:0})

 const single=assemble(randomUUID())
 const load=await loadInto(single,randomUUID(),'# 单空间')
 const adopted=await single.spacesService.ensurePersonal(single.owner)
 // 功能验证 已把唯一一行标成本人空间，加载本来就在里面：迁移只登记标签，不搬也不写回执。
 assert.equal(adopted.id,load.space.id)
 assert.deepEqual(await receipts(single.owner),[])
 assert.equal((await loadRow(load.id)).space_id,load.space.id)
 assert.deepEqual((await spaces(single.owner)).map(row=>row.kind),['personal'])
 assert.ok((await single.scopes.list(single.owner)).some(item=>item.scope===load.domain))
})

test('≥2 行空间：其它空间的加载搬进本人空间并登记 scope 标签，空间行保留',async()=>{
 const f=assemble(randomUUID())
 const first=await loadInto(f,randomUUID(),'# 第一份')
 const second=await loadInto(f,randomUUID(),'# 第二份','第二空间')
 await relabel(second,'research')
 assert.notEqual(first.space.id,second.space.id)
 const personal=await f.spacesService.ensurePersonal(f.owner)
 // 最早那行被标成本人空间，第二个空间的加载搬进来；空间行本身按规格保留不删。
 assert.equal(personal.id,first.space.id)
 assert.equal((await loadRow(second.id)).space_id,personal.id)
 assert.equal((await spaces(f.owner)).length,2)
 const moved=(await receipts(f.owner)).filter(row=>row.kind==='load-moved')
 assert.equal(moved.length,1)
 assert.equal(moved[0].target_id,second.id)
 assert.equal(moved[0].previous.space_id,second.space.id)
 assert.ok((await f.scopes.list(f.owner)).some(item=>item.scope==='research'&&item.kind==='domain'))
 assert.deepEqual((await f.loads.list(f.owner,{})).items.map(item=>item.space.id).sort(),[personal.id,personal.id])
})

test('迁移只登记业务 scope，不把市场行业 domain 注册成独立业务范围',async()=>{
 const f=assemble(randomUUID()),personal=await f.spacesService.ensurePersonal(f.owner)
 const saved=await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'安全运营'},manifestPath:'teloa.json',files:files('security','# 安全运营','SOC'),references:[]})
 const load=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'existing',spaceId:personal.id,expectedVersion:personal.version}})
 assert.equal(load.domain,'security');assert.equal(load.scope,'SOC')

 // 宿主重启会再次运行本人空间迁移；市场分类不能因此出现在业务目录。
 await f.spacesService.ensurePersonal(f.owner)
 const labels=Object.fromEntries((await f.scopes.list(f.owner)).map(item=>[item.scope,item]))
 assert.equal(labels.security,undefined)
 assert.equal(labels.SOC?.scope,'SOC')
 assert.equal((await loadRow(load.id)).domain,'security')
 assert.equal((await loadRow(load.id)).scope,'SOC')
})

test('同一内容撞到本人空间唯一键：保留仍活跃且最新的一条，其余置为已卸载并留回执',async()=>{
 const f=assemble(randomUUID())
 const market=f.market,shared=await market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'共享'},manifestPath:'teloa.json',files:files('shared','# 共享正文'),references:[]})
 const older=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:shared.content.id,contentHash:shared.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'旧空间'}})
 const newer=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:shared.content.id,contentHash:shared.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'新空间'}})
 const personal=await f.spacesService.ensurePersonal(f.owner)
 assert.equal(personal.id,older.space.id)
 // 本人空间已有同摘要的占位者（最早那行就是本人空间），它留下，另一条原地置为已卸载。
 assert.equal((await loadRow(older.id)).status,'active')
 const unloaded=await loadRow(newer.id)
 assert.equal(unloaded.status,'unloaded')
 assert.equal(unloaded.space_id,newer.space.id)
 assert.ok(unloaded.unloaded_at)
 const rows=(await receipts(f.owner)).filter(row=>row.kind==='load-unloaded-duplicate')
 assert.equal(rows.length,1)
 assert.deepEqual(rows[0].previous,{status:'active',unloaded_at:null,space_id:newer.space.id})
 assert.deepEqual((await f.loads.list(f.owner,{})).items.map(item=>item.id),[older.id])
})

test('非本人空间之间同摘要相撞时保留活跃且最新的一条搬入本人空间',async()=>{
 const f=assemble(randomUUID())
 await loadInto(f,randomUUID(),'# 占位模板')
 const shared=await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'共享'},manifestPath:'teloa.json',files:files('shared','# 共享正文'),references:[]})
 const older=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:shared.content.id,contentHash:shared.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'旧空间'}})
 const newer=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:shared.content.id,contentHash:shared.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'新空间'}})
 const personal=await f.spacesService.ensurePersonal(f.owner)
 assert.equal((await loadRow(newer.id)).space_id,personal.id)
 assert.equal((await loadRow(newer.id)).status,'active')
 assert.equal((await loadRow(older.id)).space_id,older.space.id)
 assert.equal((await loadRow(older.id)).status,'unloaded')
})

/** 六类实例都用真实服务建起来，随后把加载的 scope 改回真实标签——这就是第二阶段之前的存量形态。 */
async function legacy(){
 const f=assemble(randomUUID())
 const anchor=await loadInto(f,randomUUID(),'# 本人空间原有内容')
 const spaceId=randomUUID(),load=await loadInto(f,spaceId,'# 行业指南正文','行业空间')
 const frozen='space-'+spaceId
 assert.equal(load.space.scope,frozen)
 const knowledge=await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'guide')})
 const role=await f.roleInstances.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'analyst')})
 const kit={
  alerts:await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'alerts')}),
  action:await f.executionTools.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'action')}),
  bridge:await f.mcp.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'bridge')}),
  viewer:await f.plugins.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'viewer')}),
 }
 assert.equal(knowledge.scope,frozen)
 assert.equal(role.scope,frozen)
 assert.deepEqual(role.role!.scopes,[frozen])
 assert.deepEqual(knowledge.resource!.scopeIds,[frozen])
 for(const value of Object.values(kit))assert.equal(value.scope,frozen)
 await relabel(load,'research')
 await relabel(anchor,'general')
 return {...f,anchor,load,frozen,made:{knowledge,role,kit}}
}

test('冻结的业务范围被改写为加载的 scope：六张实例表、资料与真实岗位随后都能正常读出',async()=>{
 const f=await legacy()
 // 迁移之前：实例冻结的仍是旧取值，与加载当前的 scope 不符，读取判定为记录损坏。
 await assert.rejects(f.knowledge.get(f.owner,{instanceId:f.made.knowledge.id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.roleInstances.get(f.owner,{instanceId:f.made.role.id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.dataSources.get(f.owner,{instanceId:f.made.kit.alerts.id}),{code:'teloa/storage-corrupt'})

 const personal=await f.spacesService.ensurePersonal(f.owner)
 assert.equal((await loadRow(f.load.id)).space_id,personal.id)

 const settled=await f.knowledge.get(f.owner,{instanceId:f.made.knowledge.id})
 assert.equal(settled.scope,'research')
 assert.deepEqual(settled.resource!.scopeIds,['research'])
 assert.equal((await f.knowledge.list(f.owner,{})).items.length,1)
 const settledRole=await f.roleInstances.get(f.owner,{instanceId:f.made.role.id})
 assert.equal(settledRole.scope,'research')
 assert.deepEqual(settledRole.role!.scopes,['research'])
 assert.deepEqual((await f.roles.list(f.owner,{})).map(row=>row.scopes),[['research']])
 assert.equal((await f.roleInstances.list(f.owner,{})).items.length,1)
 for(const [service,instance] of [[f.dataSources,f.made.kit.alerts],[f.executionTools,f.made.kit.action],[f.mcp,f.made.kit.bridge],[f.plugins,f.made.kit.viewer]] as const){
  assert.equal((await service.get(f.owner,{instanceId:instance.id})).scope,'research')
  assert.deepEqual((await service.list(f.owner,{})).errors,undefined)
 }
 // 行业资料目录按业务范围标签联接加载，迁移后用新标签就能找回这份资料。
 const actor={ownerId:f.owner,kind:'human' as const,scopeIds:['research']}
 assert.deepEqual((await f.catalog.list({actor})).references.map(row=>row.title),['行业指南'])
 assert.deepEqual((await f.catalog.list({actor:{...actor,scopeIds:[f.frozen]}})).references,[])
 assert.equal((await count('select count(*)::int count from teloa_business_space_migrations where owner_id=$1 and kind=$2',[f.owner,'scope-rewritten'])) >= 6,true)
})

test('重跑迁移既不改行也不写回执',async()=>{
 const f=await legacy()
 await f.spacesService.ensurePersonal(f.owner)
 const before=await receipts(f.owner)
 assert.ok(before.length)
 assert.deepEqual(await migrateToPersonalSpace(pool,f.owner),{moved:0,unloaded:0,scopes:0,resources:0})
 await f.spacesService.ensurePersonal(f.owner)
 assert.deepEqual(await receipts(f.owner),before)
 assert.equal((await f.knowledge.get(f.owner,{instanceId:f.made.knowledge.id})).scope,'research')
})

test('回滚按回执逐条写回原值并删光回执，重复回滚无操作',async()=>{
 const f=await legacy()
 const snapshot=async()=>({
  loads:(await pool.query('select id,space_id,space_version,status,unloaded_at from teloa_industry_loads where owner_id=$1 order by id',[f.owner])).rows,
  knowledge:(await pool.query('select scope,spec,digest,mapping_digest from teloa_industry_knowledge_instances where owner_id=$1 order by id',[f.owner])).rows,
  roles:(await pool.query('select scope,definition,definition_hash,mapping_digest from teloa_industry_role_instances where owner_id=$1 order by id',[f.owner])).rows,
  role:(await pool.query('select definition,request_spec from teloa_roles where owner_id=$1 order by id',[f.owner])).rows,
  resources:(await pool.query('select spec from teloa_resources where owner_id=$1 order by id',[f.owner])).rows,
  drafts:(await pool.query('select spec,request_spec from teloa_resource_drafts where owner_id=$1 order by id',[f.owner])).rows,
  kit:(await pool.query('select scope,mapping_digest from teloa_industry_data_source_instances where owner_id=$1 order by id',[f.owner])).rows,
 })
 const before=await snapshot()
 await f.spacesService.ensurePersonal(f.owner)
 assert.notDeepEqual(await snapshot(),before)
 const rolled=await rollbackPersonalSpaceMigration(pool,f.owner)
 assert.ok(rolled>0)
 assert.deepEqual(await snapshot(),before)
 assert.deepEqual(await receipts(f.owner),[])
 assert.equal(await rollbackPersonalSpaceMigration(pool,f.owner),0)
 assert.deepEqual(await snapshot(),before)
})

test('个人版加载目标锁定：新建空间被拒，非本人空间被拒，任何写都不落',async()=>{
 const f=assemble(randomUUID())
 const other=await loadInto(f,randomUUID(),'# 别处')
 await f.spacesService.ensurePersonal(f.owner)
 const saved=await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'再来一份'},manifestPath:'teloa.json',files:files('another','# 另一份'),references:[]})
 const before=await count('select count(*)::int count from teloa_industry_loads where owner_id=$1',[f.owner])
 const spacesBefore=await count('select count(*)::int count from teloa_business_spaces where owner_id=$1',[f.owner])
 await assert.rejects(f.loads.create(f.owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'新空间'}}),{code:'teloa/forbidden',message:'个人版只有一个工作空间，新建空间是专业版 / 企业版功能。'})
 await assert.rejects(f.loads.create(f.owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'existing',spaceId:randomUUID(),expectedVersion:1}}),{code:'teloa/forbidden',message:'个人版只能加载到本人工作空间。'})
 assert.equal(await count('select count(*)::int count from teloa_industry_loads where owner_id=$1',[f.owner]),before)
 assert.equal(await count('select count(*)::int count from teloa_business_spaces where owner_id=$1',[f.owner]),spacesBefore)
 assert.equal(await count('select count(*)::int count from teloa_industry_load_requests where owner_id=$1',[f.owner]),before)
 // 本人空间本身仍然收得进新的加载。
 const personal=(await f.spacesService.current(f.owner)).id
 assert.equal(personal,other.space.id)
 const added=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'existing',spaceId:personal,expectedVersion:(await f.spacesService.current(f.owner)).version}})
 assert.equal(added.space.id,personal)
})

test('注入企业版时多空间分支照旧可用',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const enterprise=new IndustryLoadService(pool,identity,createIndustryLoadSource(market),undefined,undefined,'enterprise')
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'企业'},manifestPath:'teloa.json',files:files('enterprise','# 企业'),references:[]})
 await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const created=await enterprise.create(owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'另一个空间'}})
 assert.equal(created.status,'active')
 assert.equal(await count('select count(*)::int count from teloa_business_spaces where owner_id=$1',[owner]),2)
})

test('被编辑过的岗位：定义与创建请求两列各自改写，迁移后仍读得出，回滚恢复两列',async()=>{
 const f=await legacy()
 const role=f.made.role.role!
 // 编辑之后 `teloa_roles.definition` 与停在创建时刻的 `request_spec` 不再相同，
 // 两列若被同一份改写后的定义覆盖，`findByRequest` 的固定定义核对立刻由真变假。
 const fields={name:role.name,kind:role.kind,scopes:role.scopes,duty:'改过的职责',dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,responsibility:role.responsibility,...(role.runtimeConfig?{runtimeConfig:role.runtimeConfig}:{})}
 await f.roles.edit(f.owner,{roleId:role.id,expectedVersion:role.version,fields})
 const before=async()=>(await pool.query('select definition,request_spec from teloa_roles where id=$1',[role.id])).rows[0]
 const original=await before()
 assert.notDeepEqual(original.definition,original.request_spec)

 await f.spacesService.ensurePersonal(f.owner)
 const settled=await f.roleInstances.get(f.owner,{instanceId:f.made.role.id})
 assert.equal(settled.scope,'research')
 assert.equal(settled.role!.duty,'改过的职责')
 assert.deepEqual(settled.role!.scopes,['research'])
 assert.equal((await f.roleInstances.list(f.owner,{})).items.length,1)
 const rewritten=await before()
 assert.deepEqual(rewritten.definition.scopes,['research'])
 assert.deepEqual(rewritten.request_spec.scopes,['research'])
 assert.equal(rewritten.definition.duty,'改过的职责')
 assert.notEqual(rewritten.request_spec.duty,'改过的职责')

 await rollbackPersonalSpaceMigration(pool,f.owner)
 assert.deepEqual(await before(),original)
})

test('存量任务、计划与群冻结的 space-<空间身份> 被登记为历史标签，行本身不改',async()=>{
 const f=assemble(randomUUID())
 const spaceId=randomUUID(),load=await loadInto(f,spaceId,'# 历史范围'),frozen='space-'+spaceId
 const tasks=new TaskService(pool,identity)
 const task=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'旧范围事项',goal:'核对存量',scope:frozen}})
 // 模拟第二阶段之前的存量：那时还没有标签表，这个取值在目录里一行都没有。
 await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[f.owner,frozen])
 await relabel(load,'research')

 await f.spacesService.ensurePersonal(f.owner)
 const labels=Object.fromEntries((await f.scopes.list(f.owner)).map(item=>[item.scope,item]))
 assert.equal(labels[frozen]?.kind,'legacy')
 assert.equal(labels[frozen]?.title,'团队空间（历史）')
 assert.equal(labels.research?.kind,'domain')
 // 任务行一字未动：它的范围进了任务版本与回执指纹，改行会把既有任务整条读坏。
 assert.equal((await tasks.list(f.owner,{})).find(item=>item.id===task.id)?.scope,frozen)
 assert.equal((await pool.query('select count(*)::int count from teloa_business_space_migrations where owner_id=$1 and target_table=$2',[f.owner,'teloa_tasks'])).rows[0].count,0)
 await f.spacesService.ensurePersonal(f.owner)
 assert.equal((await f.scopes.list(f.owner)).filter(item=>item.scope===frozen).length,1)
})

test('存量任务的任意历史范围都登记为标签：非 space- 形状的取值迁移后仍可编辑',async()=>{
 const f=assemble(randomUUID())
 const load=await loadInto(f,randomUUID(),'# 自定义范围')
 const tasks=new TaskService(pool,identity)
 // 第二阶段之前 `security` 这类自定义取值随处可见，标签表里却一行都没有：先借一条标签建任务，再删掉还原存量形态。
 await BusinessScopeService.ensure(pool,f.owner,{scope:'security',title:'安全',kind:'domain',spaceId:load.space.id})
 const task=await tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'旧范围事项',goal:'核对存量',scope:'security'}})
 await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[f.owner,'security'])
 await assert.rejects(tasks.edit(f.owner,{taskId:task.id,expectedVersion:task.version,fields:{title:'改过的标题',goal:'改过的目标'}}),{code:'teloa/invalid-input',message:'业务范围未登记。'})

 await f.spacesService.ensurePersonal(f.owner)
 const labels=Object.fromEntries((await f.scopes.list(f.owner)).map(item=>[item.scope,item]))
 assert.equal(labels.security?.kind,'legacy')
 assert.equal(labels.security?.title,'security')
 const edited=await tasks.edit(f.owner,{taskId:task.id,expectedVersion:task.version,fields:{title:'改过的标题',goal:'改过的目标'}})
 assert.equal(edited.scope,'security')
 assert.equal(edited.version,task.version+1)
 // 任务行本身不进回执，重跑登记也只有一条标签。
 assert.equal(await count('select count(*)::int count from teloa_business_space_migrations where owner_id=$1 and target_table=$2',[f.owner,'teloa_tasks']),0)
 await f.spacesService.ensurePersonal(f.owner)
 assert.equal((await f.scopes.list(f.owner)).filter(item=>item.scope==='security').length,1)
})

/**
 * `scope` 不符合业务范围标签命名判据的存量加载（中文、超长——都是加载判据落地之前入库的）：
 * 迁移既不拿它改写冻结列，也不把它登记成标签，只把实例现有的 `space-<空间身份>` 登记成历史标签。
 */
for(const [name,scope] of [['中文','安全运营'],['超长','a'.repeat(65)]] as const)
 test('scope 不合规（'+name+'）的存量加载：跳过改写、不登记该 scope、实例范围登记为历史标签',async()=>{
  const f=assemble(randomUUID())
  const spaceId=randomUUID(),load=await loadInto(f,spaceId,'# 不合规 domain','历史空间')
  const frozen='space-'+spaceId
  const knowledge=await f.knowledge.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'guide')})
  const role=await f.roleInstances.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'analyst')})
  const alerts=await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'alerts')})
  // 存量形态：加载当时登记的 `space-<空间身份>` 标签在第二阶段之前并不存在。
  await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[f.owner,frozen])
  await relabel(load,scope)
  const before=async()=>(await pool.query('select scope,spec from teloa_industry_knowledge_instances where id=$1',[knowledge.id])).rows[0]
  const original=await before()

  // 宿主装配这一步不能抛：不合规的 scope 一旦进 `roleDefinition`，整个宿主都起不来。
  await f.spacesService.ensurePersonal(f.owner)

  const labels=Object.fromEntries((await f.scopes.list(f.owner)).map(item=>[item.scope,item]))
  assert.equal(labels[scope],undefined)
  assert.equal(labels[frozen]?.kind,'legacy')
  assert.equal(labels[frozen]?.title,'历史空间（历史）')
  // 六张实例表一行都没改，也没有一条改写回执。
  assert.deepEqual(await before(),original)
  assert.equal((await pool.query('select scope from teloa_industry_role_instances where id=$1',[role.id])).rows[0].scope,frozen)
  assert.equal((await pool.query('select scope from teloa_industry_data_source_instances where id=$1',[alerts.id])).rows[0].scope,frozen)
  assert.equal(await count('select count(*)::int count from teloa_business_space_migrations where owner_id=$1 and kind=$2',[f.owner,'scope-rewritten']),0)
  // 残留（已记入验收报告边界）：范围仍与 scope 不符，这些实例要等模板换成合规 scope 重新导入才读得回来。
  await assert.rejects(f.knowledge.get(f.owner,{instanceId:knowledge.id}),{code:'teloa/storage-corrupt'})
  assert.deepEqual(await migrateToPersonalSpace(pool,f.owner),{moved:0,unloaded:0,scopes:0,resources:0})
 })

/** 带持续计划与 kit 实例的一份模板：用来核对重复加载退役时确实走了卸载协议。 */
const planFiles=(domain:string)=>{
 const value={
  format:'teloa.business-package/v2',id:'dup',title:'重复模板',version:'1.0.0',domain,description:'重复加载',
  resources:[
   {id:'work',kind:'work-template',title:'核对工作',version:'1.0.0',required:true,source:{kind:'local',path:'work.json'}},
   {id:'daily',kind:'plan',title:'每日核对',version:'1.0.0',required:true,source:{kind:'local',path:'plan.json'}},
   {id:'analyst',kind:'role',title:'计划岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},
   {id:'alerts',kind:'data-source',title:'告警来源',version:'1.0.0',required:false,source:{kind:'local',path:'alerts.json'}},
  ],
  relations:[{kind:'role-work',from:'analyst',to:'work'},{kind:'role-work',from:'analyst',to:'daily'}],entrypoints:['work'],
 }
 return [
  file('teloa.json',JSON.stringify(value)),
  file('work.json',JSON.stringify({format:'teloa.work-template/v1',id:'work',title:'核对工作',version:'1.0.0',domain,description:'逐项核对',requirements:['资料'],output:'简报',skills:[]})),
  file('plan.json',JSON.stringify({format:'teloa.plan/v1',version:'1.0.0',title:'每日核对',workTemplate:'work',dataScope:'当天资料',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}})),
  file('role.json',JSON.stringify({format:'teloa.role/v1',name:'计划岗',kind:'employee',duty:'核对',dataScope:'资料',executionScope:'代拟',responsibility,runtimeConfig:{agentPresetId:'plan-operator'}})),
  file('alerts.json','{}'),
 ]
}

test('重复加载按卸载协议退役：实例解除、计划暂停，未接入计划服务时整笔失败',async()=>{
 const f=assemble(randomUUID())
 const market=f.market,shared=await market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'重复'},manifestPath:'teloa.json',files:planFiles('dup'),references:[]})
 const keeper=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:shared.content.id,contentHash:shared.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'先建空间'}})
 const duplicate=await f.loads.create(f.owner,{requestId:randomUUID(),contentId:shared.content.id,contentHash:shared.content.hash,target:{kind:'new',spaceId:randomUUID(),name:'后建空间'}})
 // 在将被退役的那条加载上建起一个 kit 实例与一份生效中的持续计划。
 const alerts=await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:duplicate.id,itemInstanceId:instanceOf(duplicate,'alerts')})
 const roleInstance=await f.roleInstances.instantiate(f.owner,{requestId:randomUUID(),loadId:duplicate.id,itemInstanceId:instanceOf(duplicate,'analyst')})
 const active=(await new RoleLifecycleService(pool,identity).change(f.owner,{roleId:roleInstance.role!.id,expectedVersion:roleInstance.role!.version,action:'resume',reason:'建计划'})).role
 const plans=new PlanService(pool,identity,market)
 const industryPlans=new IndustryPlanService(pool,identity,new IndustryPlanSource(market,f.loads,new IndustryWorkSource(market,f.loads)),plans)
 const created=await industryPlans.create(f.owner,{requestId:randomUUID(),loadId:duplicate.id,itemInstanceId:instanceOf(duplicate,'daily'),goal:'每日核对资料',delivery:'带来源简报',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'10:00',timezone:'Asia/Singapore'},roleId:active.id,expectedRoleVersion:active.version,notificationPolicy:'attention'})
 const enabled=await plans.change(f.owner,{planId:created.plan.id,requestId:randomUUID(),expectedVersion:created.plan.version,action:'enable'})
 assert.equal(enabled.state,'active')

 // 没接入持续计划服务时整笔失败，一行都不改：绝不留下一个挂在已卸载模板上的在效计划。
 await assert.rejects(f.spacesService.ensurePersonal(f.owner),{code:'teloa/dependency-unavailable'})
 assert.equal((await pool.query('select status from teloa_industry_loads where id=$1',[duplicate.id])).rows[0].status,'active')
 assert.equal((await pool.query('select count(*)::int count from teloa_business_space_migrations where owner_id=$1',[f.owner])).rows[0].count,0)

 const wired=new BusinessSpaceService(pool,identity,{changeInTransaction:(db,ownerId,input)=>plans.changeInTransaction(db,ownerId,input)})
 const personal=await wired.ensurePersonal(f.owner)
 assert.equal(personal.id,keeper.space.id)
 assert.equal((await loadRow(duplicate.id)).status,'unloaded')
 assert.equal((await loadRow(keeper.id)).space_id,personal.id)
 assert.equal((await f.dataSources.get(f.owner,{instanceId:alerts.id})).state,'detached')
 assert.equal((await plans.get(f.owner,{planId:created.plan.id})).state,'paused')

 // 回滚把实例状态与加载状态写回；计划暂停走的是持续计划服务自己的台账，按设计不在回滚范围内。
 await rollbackPersonalSpaceMigration(pool,f.owner)
 assert.equal((await pool.query('select state,revision from teloa_industry_data_source_instances where id=$1',[alerts.id])).rows[0].state,alerts.state)
 assert.equal((await loadRow(duplicate.id)).status,'active')
 assert.equal((await loadRow(keeper.id)).space_id,keeper.space.id)
})
