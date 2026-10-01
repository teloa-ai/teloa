import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Pool as PoolType,PoolClient} from 'pg'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {
 IndustryDataSourceService,IndustryExecutionToolService,IndustryLoadService,IndustryMcpConnectionService,IndustryPluginService,PlanService,RoleService,
 initializeIndustryDataSources,initializeIndustryExecutionTools,initializeIndustryLoads,initializeIndustryMcpConnections,initializeIndustryPlans,initializeIndustryPlugins,
 initializeMarketContents,initializePlanOccurrences,initializePlans,initializeRoles,initializeSkillInstallations,initializeTaskRunSkillRefs,initializeTaskRuns,initializeTasks,
 type IndustryLoadRecord,type IndustryLoadSource,
} from '../src/index.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:PoolType
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeIndustryLoads(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeMarketContents(pool);await initializePlans(pool)
 await initializeIndustryPlans(pool);await initializePlanOccurrences(pool);await initializeSkillInstallations(pool);await initializeTaskRuns(pool);await initializeTaskRunSkillRefs(pool)
 await initializeIndustryDataSources(pool);await initializeIndustryExecutionTools(pool);await initializeIndustryMcpConnections(pool);await initializeIndustryPlugins(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
const snapshot={templateId:'security',templateVersion:'1.0.0',title:'安全工作',domain:'SOC',description:'安全行业模板',relations:[],entrypoints:[],resources:[
 {localId:'alerts',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,available:true},
 {localId:'isolate',kind:'execution-tool' as const,title:'隔离执行器',version:'1.0.0',required:true,available:true},
 {localId:'reference',kind:'mcp' as const,title:'资料连接',version:'1.0.0',required:true,available:true},
 {localId:'visualize',kind:'plugin' as const,title:'可视化插件',version:'0.1.2',required:false,available:true},
 {localId:'triage',kind:'skill' as const,title:'告警分诊',version:'1.0.0',required:true,available:true},
 // 始终不实例化，用来核对「卸载后连全新的登记也不允许」。
 {localId:'standby',kind:'data-source' as const,title:'备用告警来源',version:'1.0.0',required:false,available:true},
]}
const source:IndustryLoadSource={read:async()=>structuredClone(snapshot)}
const dataSourceDefinition={format:'teloa.data-source/v1' as const,sourceId:'security-alert-http',scopes:['SOC']}
const executionToolDefinition={format:'teloa.execution-tool/v1' as const,adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate']}
const mcpDefinition={format:'teloa.mcp-connection/v1' as const,serverName:'teloa_reference',tools:['read_reference']}
const pluginDefinition={format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'dsh-visualize',version:'0.1.2'}

/** 四类资源的固定来源形状一致，测试只需按加载项回放同一份定义。 */
const reader=<T>(loads:IndustryLoadService,definition:T)=>({read:async(db:PoolClient,owner:string,input:{loadId:string;itemInstanceId:string})=>{
 const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId)
 assert.ok(item)
 return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition}
}})
const instanceOf=(load:IndustryLoadRecord,localId:string)=>load.items.find(item=>item.localId===localId)!.instanceId
const states=async(owner:string,loadId:string)=>Object.fromEntries(await Promise.all(
 ['teloa_industry_data_source_instances','teloa_industry_execution_tool_instances','teloa_industry_mcp_instances','teloa_industry_plugin_instances']
  .map(async table=>[table,(await pool.query(`select state,revision from ${table} where owner_id=$1 and load_id=$2`,[owner,loadId])).rows[0]] as const)
))

/** 建一份完整的已加载环境：四类实例各一个（数据源已连接），外加一条本加载的 Skill 使用关系。 */
async function prepare(owner:string){
 const loads=new IndustryLoadService(pool,identity,source,new PlanService(pool,identity))
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:randomUUID().replace(/-/g,'')+randomUUID().replace(/-/g,''),target:{kind:'new',spaceId:randomUUID(),name:'安全空间'}})
 const dataSources=new IndustryDataSourceService(pool,identity,loads,reader(loads,dataSourceDefinition),{ready:async()=>({ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'})})
 const created=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'alerts')})
 await dataSources.authorize(owner,{requestId:randomUUID(),instanceId:created.id,expectedRevision:created.revision},new AbortController().signal)
 const executionTools=new IndustryExecutionToolService(pool,identity,loads,reader(loads,executionToolDefinition),{ready:async()=>({ready:true as const,observedAt:'2026-09-14T00:00:00.000Z'})})
 await executionTools.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'isolate')})
 const mcp=new IndustryMcpConnectionService(pool,identity,loads,reader(loads,mcpDefinition),{ready:async()=>({ready:true as const,observedAt:'2026-09-14T00:00:00.000Z',tools:['read_reference']})})
 await mcp.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'reference')})
 const plugins=new IndustryPluginService(pool,identity,loads,reader(loads,pluginDefinition),{
  preview:async()=>{throw Error('不应预览')},install:async()=>{throw Error('不应安装')},reconcile:async()=>{throw Error('不应核对')},find:async()=>null,
 })
 await plugins.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'visualize')})
 const installationId=await installation(owner)
 await pool.query('insert into teloa_skill_install_usages values($1,$2,$3,$4,$5)',[owner,load.id,instanceOf(load,'triage'),installationId,'c'.repeat(64)])
 return {loads,load,dataSources,executionTools,mcp,plugins,installationId}
}

/** 安装记录只作为使用关系与运行引用的落点，卸载既不读它也不改它。 */
async function installation(owner:string){
 const id=randomUUID()
 await pool.query('insert into teloa_skill_installations(id,owner_id,source,source_key,bundle_hash,record_hash,native,native_name,state,version,created_at,updated_at) values($1,$2,$3,$4,$5,$5,$6,$7,$8,1,now(),now())',[
  id,owner,JSON.stringify({kind:'atomic',contentId:randomUUID(),contentHash:'a'.repeat(64),resourceId:'triage',resourceVersion:'1.0.0'}),createHash('sha256').update(id).digest('hex'),'e'.repeat(64),
  JSON.stringify({name:'triage-'+id.slice(0,8),description:'分诊',modelInvocable:true,userInvocable:false,bodyHash:'b'.repeat(64)}),'triage-'+id.slice(0,8),'installed',
 ])
 return id
}

async function activePlan(owner:string,loadId:string){
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'安全岗',kind:'employee',scopes:['general'],duty:'核对告警',dataScope:'已授权资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const plans=new PlanService(pool,identity)
 const plan=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日告警核对',goal:'核对当日告警并形成结论。',scope:'general',dataScope:'已授权告警。',delivery:'结论与待办。',roleId:role.id,expectedRoleVersion:1,trigger:schedule,notificationPolicy:'attention'},source:{kind:'manual'}})
 const enabled=await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'enable'})
 await pool.query('insert into teloa_industry_plan_sources values($1,$2,$3,$4,$5,$6,now())',[plan.id,owner,randomUUID(),JSON.stringify({loadId}),JSON.stringify({loadId}),'a'.repeat(64)])
 return {plan:enabled,roleId:role.id}
}

/** 领取后尚未落任务的日程：计划仍在生效且版本一致时即为"占用中"。 */
async function claimedOccurrence(owner:string,plan:{id:string;version:number;configVersion:number}){
 const id=randomUUID()
 await pool.query('insert into teloa_plan_occurrences values($1,$2,$3,$4,$5,$6,now(),now(),$7,$8,$9)',[
  id,owner,plan.id,plan.version,plan.configVersion,'2026-09-14T09:00[Asia/Singapore]',randomUUID(),JSON.stringify({fixture:true}),'f'.repeat(64),
 ])
 return id
}

async function preparedRun(owner:string,roleId:string,installationId:string){
 const taskId=randomUUID(),runId=randomUUID()
 await pool.query('insert into teloa_tasks values($1,$2,$3,$4,$5,1,$6,$7,1,now(),now())',[taskId,owner,randomUUID(),JSON.stringify({fixture:true}),JSON.stringify({title:'核对告警',goal:'核对','scope':'general'}),'ready',roleId])
 await pool.query('insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,$4,$5,$6,1,1,1,$7,$8,$9,$10,now())',[
  runId,owner,randomUUID(),JSON.stringify({fixture:true}),taskId,roleId,'session-'+runId,randomUUID(),'prepared','核对告警',
 ])
 await pool.query('insert into teloa_task_run_skill_refs values($1,$2,$3,$4,$5,$6,$7)',[owner,runId,installationId,'triage','e'.repeat(64),JSON.stringify([]),'a'.repeat(64)])
 return runId
}

test('占用中的计划日程阻断卸载并逐条列出阻塞项，任何写都不发生',async()=>{
 const owner=randomUUID(),{loads,load}=await prepare(owner),{plan}=await activePlan(owner,load.id)
 const occurrenceId=await claimedOccurrence(owner,plan)
 const before=await states(owner,load.id)
 await assert.rejects(loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash}),error=>{
  assert.equal((error as {code:string}).code,'teloa/conflict')
  assert.deepEqual((error as {details:{blockers:unknown[]}}).details,{blockers:[{kind:'plan-occurrence',id:occurrenceId}]})
  return true
 })
 assert.deepEqual(await states(owner,load.id),before)
 assert.equal((await loads.get(owner,{loadId:load.id})).status,'active')
 assert.equal((await pool.query("select state from teloa_plans where id=$1",[plan.id])).rows[0].state,'active')
 assert.equal((await pool.query('select count(*)::int count from teloa_skill_install_usages where owner_id=$1',[owner])).rows[0].count,1)
 assert.equal((await pool.query('select count(*)::int count from teloa_industry_load_unload_requests where owner_id=$1',[owner])).rows[0].count,0)
})

test('引用本加载 Skill 的在途运行阻断卸载',async()=>{
 const owner=randomUUID(),{loads,load,installationId}=await prepare(owner),{roleId}=await activePlan(owner,load.id)
 const runId=await preparedRun(owner,roleId,installationId)
 await assert.rejects(loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash}),error=>{
  assert.deepEqual((error as {details:{blockers:unknown[]}}).details,{blockers:[{kind:'task-run',id:runId}]})
  return (error as {code:string}).code==='teloa/conflict'
 })
 await pool.query("update teloa_task_runs set state='ended' where id=$1",[runId])
 const unloaded=await loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash})
 assert.equal(unloaded.status,'unloaded')
})

test('映射指纹不符只报版本冲突，不解除任何实例',async()=>{
 const owner=randomUUID(),{loads,load}=await prepare(owner),before=await states(owner,load.id)
 await assert.rejects(loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:'a'.repeat(64)}),{code:'teloa/version-conflict'})
 assert.deepEqual(await states(owner,load.id),before)
 assert.equal((await loads.get(owner,{loadId:load.id})).status,'active')
 await assert.rejects(loads.unload('other',{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash}),{code:'teloa/forbidden'})
 await assert.rejects(loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:'not-a-hash'}),{code:'teloa/invalid-input'})
})

test('卸载解除四类实例、删除使用关系、暂停本加载计划并记录卸载时刻',async()=>{
 const owner=randomUUID(),{loads,load}=await prepare(owner),{plan}=await activePlan(owner,load.id)
 // 未接入持续计划服务的加载服务不得悄悄跳过暂停：显式失败并整笔回滚。
 const portless=new IndustryLoadService(pool,identity,source)
 await assert.rejects(portless.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash}),{code:'teloa/dependency-unavailable'})
 assert.equal((await loads.get(owner,{loadId:load.id})).status,'active')
 assert.deepEqual(Object.values(await states(owner,load.id)).map(row=>row.state),['active','needs_authorization','needs_connection','needs_install'])
 const requestId=randomUUID(),unloaded=await loads.unload(owner,{requestId,loadId:load.id,expectedMappingHash:load.mappingHash})
 assert.equal(unloaded.status,'unloaded');assert.ok(unloaded.unloadedAt)
 assert.deepEqual({...unloaded,status:'active',unloadedAt:undefined},{...load,unloadedAt:undefined,items:unloaded.items})
 for(const [table,row] of Object.entries(await states(owner,load.id))){assert.equal(row.state,'detached',table);assert.ok(row.revision>=2,table)}
 // 数据源解除前已连接，绑定列必须原样保留供追溯。
 assert.ok((await pool.query('select binding from teloa_industry_data_source_instances where owner_id=$1',[owner])).rows[0].binding)
 assert.equal((await pool.query('select count(*)::int count from teloa_skill_install_usages where owner_id=$1',[owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int count from teloa_skill_installations where owner_id=$1',[owner])).rows[0].count,1)
 const paused=(await pool.query('select state,version from teloa_plans where id=$1',[plan.id])).rows[0]
 assert.equal(paused.state,'paused');assert.equal(paused.version,plan.version+1)
 assert.equal((await pool.query("select request_spec->>'note' note from teloa_plan_changes where plan_id=$1 and request_spec->>'action'='pause'",[plan.id])).rows[0].note,'模板已卸载')
 assert.equal((await pool.query('select archived_reason from teloa_plans where id=$1',[plan.id])).rows[0].archived_reason,null)
 // 同一请求复放返回同一结果；换一个请求则拒绝重复卸载。
 assert.deepEqual(await loads.unload(owner,{requestId,loadId:load.id,expectedMappingHash:load.mappingHash}),unloaded)
 await assert.rejects(loads.unload(owner,{requestId,loadId:load.id,expectedMappingHash:'b'.repeat(64)}),{code:'teloa/conflict'})
 await assert.rejects(loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash}),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int count from teloa_plan_changes where plan_id=$1',[plan.id])).rows[0].count,2)
})

test('已卸载加载创建的计划不能重新启用：启用判据先核对来源加载仍在生效',async()=>{
 const owner=randomUUID(),{loads,load}=await prepare(owner),{plan}=await activePlan(owner,load.id)
 await loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash})
 const plans=new PlanService(pool,identity),paused=(await pool.query('select version from teloa_plans where id=$1',[plan.id])).rows[0]
 await assert.rejects(plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:Number(paused.version),action:'enable'}),
  {code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能重新启用该持续计划。'})
 assert.deepEqual((await pool.query('select state,version from teloa_plans where id=$1',[plan.id])).rows[0],{state:'paused',version:Number(paused.version)})
 // 没有行业来源的计划不受这条判据影响。
 const plain=await plans.create(owner,{requestId:randomUUID(),fields:{title:'自建计划',goal:'核对当日资料。',scope:'general',dataScope:'已授权资料。',delivery:'结论。',roleId:(await pool.query('select role_id from teloa_plans where id=$1',[plan.id])).rows[0].role_id,expectedRoleVersion:1,trigger:schedule,notificationPolicy:'attention'},source:{kind:'manual'}})
 assert.equal((await plans.change(owner,{planId:plain.id,requestId:randomUUID(),expectedVersion:plain.version,action:'enable'})).state,'active')
})

test('已卸载的加载默认不出现在目录里，显式索取时返回且 get 始终可读',async()=>{
 const owner=randomUUID(),{loads,load}=await prepare(owner),second=await prepare(owner)
 await loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash})
 assert.deepEqual((await loads.list(owner,{})).items.map(item=>item.id),[second.load.id])
 assert.deepEqual((await loads.list(owner,{includeUnloaded:true})).items.map(item=>item.id).sort(),[load.id,second.load.id].sort())
 assert.equal((await loads.get(owner,{loadId:load.id})).status,'unloaded')
 await assert.rejects(loads.list(owner,{includeUnloaded:'yes'}),{code:'teloa/invalid-input'})
})

test('卸载后实例只读不可写：登记、推进与插件核对都被拒绝，目录仍可读出已解除实例',async()=>{
 const owner=randomUUID(),{loads,load,dataSources,executionTools,mcp,plugins}=await prepare(owner)
 const tool=(await executionTools.list(owner,{})).items[0]!
 await loads.unload(owner,{requestId:randomUUID(),loadId:load.id,expectedMappingHash:load.mappingHash})
 assert.deepEqual((await dataSources.list(owner,{})).items.map(item=>item.state),['detached'])
 assert.equal((await mcp.list(owner,{})).items[0]!.state,'detached')
 await assert.rejects(executionTools.authorize(owner,{requestId:randomUUID(),instanceId:tool.id,expectedRevision:tool.revision},new AbortController().signal),{code:'teloa/conflict'})
 const pluginInstance=(await plugins.list(owner,{})).items[0]!
 await assert.rejects(plugins.reconcile(owner,{instanceId:pluginInstance.id}),{code:'teloa/conflict'})
 // 从未实例化过的项也不能再登记：拒绝理由必须是「加载已不活跃」，而不是既有的「不可实例化」。
 const other=new IndustryDataSourceService(pool,identity,loads,reader(loads,dataSourceDefinition),{ready:async()=>({ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'})})
 await assert.rejects(other.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'standby')}),{code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
})
