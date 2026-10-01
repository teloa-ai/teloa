/**
 * 个人版单空间验收的「存量多空间库」那一半（功能验证 第二段）。
 *
 * 浏览器验收跑不了这一段：`pnpm dev:dsh:acceptance` 先建 schema 再直接起宿主，宿主装配的第一件事就是
 * `ensurePersonal`（迁移随之发生），没有可以在两者之间写入存量行的位置。因此这里用同一个入口
 * （`BusinessSpaceService.ensurePersonal`，宿主装配调的就是它）在真实 PostgreSQL 上跑完整一遍：
 * 两个团队空间各一条加载、一个已连接的数据源实例、一个岗位实例、一条冻结了 `space-<uuid>` 的任务、
 * 一条冻结了 `Design` 的任务 → 启动即收敛 → 回滚还原。
 *
 * 与 `business-space-migration.test.ts` 的分工：那边逐条验证迁移的每一类行为（搬移、去重、改写、回执、回滚）；
 * 这里只跑一条贯穿的验收路径，断言的是「存量库启动之后界面能读到的东西」：单一本人空间、两条加载都在它名下、
 * 六类实例读得出来、标签目录里有 domain 与两类历史标签、回执齐全且可整体回滚。
 */
import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {
 BusinessScopeService,BusinessSpaceService,IndustryDataSourceService,IndustryKnowledgeService,IndustryLoadService,
 IndustryReferenceCatalog,IndustryRoleService,IndustryRoleSource,MarketContentStore,ResourceService,RoleService,TaskService,
 combineReferenceCatalogs,createIndustryLoadSource,initializeIndustryDataSources,initializeIndustryKnowledge,
 initializeIndustryLoads,initializeIndustryRoles,initializeMarketContents,initializeResources,initializeRoleLifecycle,
 initializeRoles,initializeTasks,rollbackPersonalSpaceMigration,
 type IndustryLoadRecord,type IndustryLoadService as IndustryLoadServiceType,
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
 await initializeIndustryKnowledge(pool);await initializeRoles(pool);await initializeTasks(pool)
 await initializeRoleLifecycle(pool);await initializeIndustryRoles(pool);await initializeIndustryDataSources(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const responsibility={triggers:['收到告警'],autonomousActions:['读取资料'],confirmationPoints:['执行前核对'],escalationRules:['冲突时升级'],deliveryChecks:['附证据来源']}
const manifest=(domain:string)=>({
 format:'teloa.business-package/v2',id:'legacy',title:'存量模板',version:'1.0.0',domain,description:'存量多空间库',
 resources:[
  {id:'analyst',kind:'role',title:'分析岗',version:'1.0.0',required:true,source:{kind:'local',path:'role.json'}},
  {id:'alerts',kind:'data-source',title:'告警来源',version:'1.0.0',required:false,source:{kind:'local',path:'alerts.json'}},
 ],
 relations:[],entrypoints:[],
})
const files=(domain:string,body:string)=>[
 file('teloa.json',JSON.stringify(manifest(domain))),file('note.md',body),
 file('role.json',JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'获准资料',executionScope:'代拟',responsibility})),
 file('alerts.json','{}'),
]
/**
 * 数据源固定定义的 `scopes` 同时列出冻结取值与迁移后的标签：真实存量库里这份定义是模板里的静态字节，
 * 迁移只改实例的 `scope` 列，不会让固定来源发生漂移；测试若按 `load.domain` 动态生成定义，改写后会被判成来源漂移。
 */
const reader=(loads:IndustryLoadServiceType,scopes:readonly string[])=>({read:async(db:Parameters<IndustryLoadServiceType['getInTransaction']>[0],owner:string,input:{loadId:string;itemInstanceId:string})=>{
 const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId)
 assert.ok(item)
 return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition:{format:'teloa.data-source/v1' as const,sourceId:'legacy-alert-http',scopes:[...scopes]}}
}})
const instanceOf=(load:IndustryLoadRecord,localId:string)=>load.items.find(item=>item.localId===localId)!.instanceId

function assemble(owner:string,dataSourceScopes:readonly string[]){
 const market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const catalog=new IndustryReferenceCatalog(pool,market,loads)
 const sources=combineReferenceCatalogs(createPublicReferenceCatalog(),catalog)
 const resources=new ResourceService(pool,sources,identity)
 const knowledge=new IndustryKnowledgeService(pool,identity,loads,sources,resources)
 const roles=new RoleService(pool,identity)
 return {
  owner,market,loads,roles,
  roleInstances:new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles),
  dataSources:new IndustryDataSourceService(pool,identity,loads,reader(loads,dataSourceScopes),{ready:async()=>({ready:true as const,probedAt:'2026-09-15T00:00:00.000Z'})}),
  tasks:new TaskService(pool,identity),
  spacesService:new BusinessSpaceService(pool,identity),
  scopes:new BusinessScopeService(pool),
 }
}
/** 建一条加载：`domain` 先取 `'space-<空间身份>'`，实例因此冻结成第二阶段之前的存量形状。 */
async function loadInto(f:ReturnType<typeof assemble>,spaceId:string,body:string,name:string){
 const saved=await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'存量'},manifestPath:'teloa.json',files:files('space-'+spaceId,body),references:[]})
 return f.loads.create(f.owner,{requestId:randomUUID(),contentId:saved.content.id,contentHash:saved.content.hash,target:{kind:'new',spaceId,name}})
}
/** 加载行上的 `scope` 换成真实业务范围标签；`domain` 同步为旧存量的兼容形状。 */
async function relabel(load:IndustryLoadRecord,scope:string){
 await pool.query("update teloa_industry_loads set domain=$2,scope=$2,source_snapshot=jsonb_set(jsonb_set(source_snapshot,'{domain}',to_jsonb($2::text)),'{scope}',to_jsonb($2::text)) where id=$1",[load.id,scope])
}
/** 建一条冻结了 `scope` 的任务，随后删掉它的标签行：第二阶段之前没有标签表，这些取值在目录里一行都没有。 */
async function legacyTask(f:ReturnType<typeof assemble>,scope:string,title:string){
 await pool.query('insert into teloa_business_scopes(owner_id,space_id,scope,title,kind,created_at) select $1,id,$2,$2,$3,now() from teloa_business_spaces where owner_id=$1 order by created_at limit 1 on conflict do nothing',[f.owner,scope,'domain'])
 const task=await f.tasks.create(f.owner,{requestId:randomUUID(),fields:{title,goal:'核对存量',scope}})
 await pool.query('delete from teloa_business_scopes where owner_id=$1 and scope=$2',[f.owner,scope])
 return task
}

test('存量两空间库启动即收敛到单一本人空间，实例与目录可读，回滚可还原', async()=>{
 // 1. 存量：两个团队空间，各一条加载；第二个空间上再建岗位实例与已连接的数据源实例。
 const firstSpace=randomUUID(),secondSpace=randomUUID()
 const f=assemble(randomUUID(),['space-'+secondSpace,'research'])
 const first=await loadInto(f,firstSpace,'# 第一空间','安全团队空间')
 const second=await loadInto(f,secondSpace,'# 第二空间','研究团队空间')
 const frozen='space-'+secondSpace
 assert.equal(second.space.scope,frozen)
 const role=await f.roleInstances.instantiate(f.owner,{requestId:randomUUID(),loadId:second.id,itemInstanceId:instanceOf(second,'analyst')})
 const registered=await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:second.id,itemInstanceId:instanceOf(second,'alerts')})
 const connected=await f.dataSources.authorize(f.owner,{requestId:randomUUID(),instanceId:registered.id,expectedRevision:registered.revision},new AbortController().signal)
 assert.equal(connected.state,'active')
 assert.equal(connected.scope,frozen)
 assert.deepEqual(role.role!.scopes,[frozen])
 await relabel(first,'SOC')
 await relabel(second,'research')
 // 冻结了历史范围的两条任务：一条是旧空间身份，一条是已下线的内置 Design。
 const spaceTask=await legacyTask(f,frozen,'旧空间事项')
 const designTask=await legacyTask(f,'Design','设计事项')
 assert.equal((await pool.query('select count(*)::int count from teloa_business_spaces where owner_id=$1',[f.owner])).rows[0].count,2)

 const before={
  loads:(await pool.query('select id,space_id,space_version,status from teloa_industry_loads where owner_id=$1 order by id',[f.owner])).rows,
  roleInstances:(await pool.query('select scope,definition,definition_hash,mapping_digest from teloa_industry_role_instances where owner_id=$1 order by id',[f.owner])).rows,
  roles:(await pool.query('select definition,request_spec from teloa_roles where owner_id=$1 order by id',[f.owner])).rows,
  dataSources:(await pool.query('select scope,state,mapping_digest from teloa_industry_data_source_instances where owner_id=$1 order by id',[f.owner])).rows,
 }
 // 迁移之前：实例冻结的取值与加载当前的 domain 不符，读取判定为记录损坏。
 await assert.rejects(f.dataSources.get(f.owner,{instanceId:connected.id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.roleInstances.get(f.owner,{instanceId:role.id}),{code:'teloa/storage-corrupt'})

 // 2. 宿主启动：装配里调的就是这一句。
 const personal=await f.spacesService.ensurePersonal(f.owner)
 assert.equal(personal.kind,'personal')
 const spaces=(await pool.query('select id,kind from teloa_business_spaces where owner_id=$1 order by created_at,id',[f.owner])).rows
 assert.deepEqual(spaces.map(row=>row.kind),['personal','team'])
 assert.equal(personal.id,first.space.id)

 // 3. 收敛结果：两条加载都在本人空间名下，六类实例读得出来，标签目录齐全。
 const loads=await f.loads.list(f.owner,{})
 assert.deepEqual(loads.items.map(item=>item.space.id).sort(),[personal.id,personal.id])
 assert.deepEqual(loads.items.map(item=>item.space.scope).sort(),['SOC','research'])
 assert.deepEqual(loads.items.map(item=>item.space.name),[personal.name,personal.name])
 const settledSource=await f.dataSources.get(f.owner,{instanceId:connected.id})
 assert.equal(settledSource.scope,'research')
 assert.equal(settledSource.state,'active')
 assert.deepEqual((await f.dataSources.list(f.owner,{})).errors,undefined)
 const settledRole=await f.roleInstances.get(f.owner,{instanceId:role.id})
 assert.equal(settledRole.scope,'research')
 assert.deepEqual(settledRole.role!.scopes,['research'])
 assert.deepEqual((await f.roles.list(f.owner,{})).map(row=>row.scopes),[['research']])
 const labels=Object.fromEntries((await f.scopes.list(f.owner)).map(item=>[item.scope,item]))
 assert.equal(labels.general?.kind,'builtin');assert.equal(labels.SOC?.kind,'builtin');assert.equal(labels.AppSec?.kind,'builtin')
 assert.equal(labels.research?.kind,'domain')
 assert.equal(labels[frozen]?.kind,'legacy')
 assert.equal(labels[frozen]?.title,'研究团队空间（历史）')
 assert.equal(labels.Design?.kind,'legacy')
 assert.equal(labels.Design?.title,'设计（历史）')
 // 任务行一字未动：范围进了任务版本与回执指纹，改行会把既有任务整条读坏。
 const tasks=await f.tasks.list(f.owner,{})
 assert.equal(tasks.find(item=>item.id===spaceTask.id)?.scope,frozen)
 assert.equal(tasks.find(item=>item.id===designTask.id)?.scope,'Design')
 const receipts=(await pool.query('select kind,count(*)::int count from teloa_business_space_migrations where owner_id=$1 group by kind order by kind',[f.owner])).rows
 assert.deepEqual(receipts.map(row=>row.kind),['load-moved','scope-rewritten'])
 assert.ok(receipts.find(row=>row.kind==='scope-rewritten')!.count>=3)

 // 4. 重跑不再改任何行（宿主每次启动都会调一次）。
 const after=await pool.query('select seq from teloa_business_space_migrations where owner_id=$1 order by seq',[f.owner])
 await f.spacesService.ensurePersonal(f.owner)
 assert.deepEqual((await pool.query('select seq from teloa_business_space_migrations where owner_id=$1 order by seq',[f.owner])).rows,after.rows)

 // 5. 回滚：逐列还原到存量形状，回执删光。
 assert.ok(await rollbackPersonalSpaceMigration(pool,f.owner)>0)
 assert.deepEqual({
  loads:(await pool.query('select id,space_id,space_version,status from teloa_industry_loads where owner_id=$1 order by id',[f.owner])).rows,
  roleInstances:(await pool.query('select scope,definition,definition_hash,mapping_digest from teloa_industry_role_instances where owner_id=$1 order by id',[f.owner])).rows,
  roles:(await pool.query('select definition,request_spec from teloa_roles where owner_id=$1 order by id',[f.owner])).rows,
  dataSources:(await pool.query('select scope,state,mapping_digest from teloa_industry_data_source_instances where owner_id=$1 order by id',[f.owner])).rows,
 },before)
 assert.equal((await pool.query('select count(*)::int count from teloa_business_space_migrations where owner_id=$1',[f.owner])).rows[0].count,0)
 // 标签只增不减：回滚不撤标签，否则仍指向它的任务与群无法读写。
 assert.equal((await f.scopes.list(f.owner)).some(item=>item.scope===frozen),true)
})
