import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import type {Pool as PoolType,PoolClient} from 'pg'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {
 IndustryDataSourceService,IndustryExecutionToolService,IndustryLoadService,IndustryMcpConnectionService,IndustryPluginService,
 IndustryRoleService,IndustryRoleSource,MarketContentStore,PlanService,RoleService,createIndustryLoadSource,
 initializeIndustryDataSources,initializeIndustryExecutionTools,initializeIndustryLoads,initializeIndustryMcpConnections,
 initializeIndustryPlans,initializeIndustryPlugins,initializeIndustryRoles,initializeMarketContents,initializePlanOccurrences,
 initializePlans,initializeRoles,initializeTasks,
 type IndustryLoadRecord,
} from '../src/index.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {IndustryUpdateChoices,MarketPluginInstallPreview,MarketPluginInstallationState} from '@teloa/contract'
import type {PluginInstallation} from '../src/market/plugin-installations.ts'

let container:StartedPostgreSqlContainer,pool:PoolType
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeMarketContents(pool);await initializeIndustryLoads(pool);await initializeIndustryDataSources(pool)
 await initializeIndustryExecutionTools(pool);await initializeIndustryMcpConnections(pool);await initializeIndustryPlugins(pool)
 await initializeRoles(pool);await initializeIndustryRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializePlans(pool);await initializeIndustryPlans(pool);await initializePlanOccurrences(pool);await initializeTasks(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const identity={id:randomUUID,now:()=>new Date().toISOString()}
const enc=new TextEncoder()
const file=(path:string,text:string)=>({path,bytes:enc.encode(text)})
const guide=(id:string)=>({id,kind:'knowledge' as const,title:'研究手册',version:'1.0.0',required:true,source:{kind:'local' as const,path:'guide.md'}})
const manifest=(version:string,options:{body:string;legacy:boolean;extra:boolean})=>({
 format:'teloa.business-package/v2' as const,id:'research',title:'研究模板',version,domain:'general',description:'研究行业模板',
 resources:[
  guide('guide'),
  {id:'analyst',kind:'role' as const,title:'分析岗',version:'1.0.0',required:true,source:{kind:'local' as const,path:'role.json'}},
  {id:'alerts',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,source:{kind:'local' as const,path:'alerts.json'}},
  ...(options.legacy?[{id:'legacy',kind:'knowledge' as const,title:'旧手册',version:'1.0.0',required:false,source:{kind:'local' as const,path:'legacy.md'}}]:[]),
  ...(options.extra?[{id:'extra',kind:'knowledge' as const,title:'新增手册',version:'1.0.0',required:false,source:{kind:'local' as const,path:'extra.md'}}]:[]),
 ],
 relations:[{kind:'role-knowledge' as const,from:'analyst',to:'guide'}],entrypoints:[] as string[],
})
const files=(body:string,options:{legacy:boolean;extra:boolean},value:ReturnType<typeof manifest>)=>[
 file('teloa.json',JSON.stringify(value)),file('guide.md',body),
 file('role.json',JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:'核对',dataScope:'资料',executionScope:'代拟'})),
 file('alerts.json',JSON.stringify({format:'teloa.data-source/v1',sourceId:'research-alert-http',scopes:['general']})),
 ...(options.legacy?[file('legacy.md','# 旧手册')]:[]),
 ...(options.extra?[file('extra.md','# 新增手册')]:[]),
]
async function content(owner:string,market:MarketContentStore,version:string,options:{body:string;legacy:boolean;extra:boolean}){
 const value=manifest(version,options)
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'研究'},manifestPath:'teloa.json',files:files(options.body,options,value),references:[]})
 return saved.content
}
const dataSourceDefinition={format:'teloa.data-source/v1' as const,sourceId:'research-alert-http',scopes:['general']}
/** 四类 kit 资源的固定来源形状一致，测试只需按加载项回放同一份定义。 */
const reader=<T>(loads:IndustryLoadService,definition:T)=>({read:async(db:PoolClient,owner:string,input:{loadId:string;itemInstanceId:string})=>{
 const load=await loads.getInTransaction(db,owner,{loadId:input.loadId}),item=load.items.find(value=>value.instanceId===input.itemInstanceId)
 assert.ok(item)
 return {loadId:load.id,itemInstanceId:item.instanceId,itemLocalId:item.localId,contentId:load.contentId,contentHash:load.contentHash,itemVersion:item.version,fileHash:'f'.repeat(64),definition}
}})
const instanceOf=(load:IndustryLoadRecord,localId:string)=>load.items.find(item=>item.localId===localId)!.instanceId
/** 基线 v1.0.0 与候选 v1.1.0：手册正文变化、旧手册移除、新增手册出现，岗位与告警来源原样不动。 */
async function prepare(){
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const baseline=await content(owner,market,'1.0.0',{body:'# 原手册',legacy:true,extra:false})
 const candidate=await content(owner,market,'1.1.0',{body:'# 新手册',legacy:false,extra:true})
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:baseline.id,contentHash:baseline.hash,target:{kind:'new',spaceId:randomUUID(),name:'研究空间'}})
 return {owner,market,loads,baseline,candidate,load}
}
const choices=(patch:Partial<IndustryUpdateChoices>={}):IndustryUpdateChoices=>({resources:{guide:'keep',legacy:'skip',extra:'candidate'},roles:{},relations:'keep',entrypoints:'keep',positioning:'candidate',...patch})
const command=(f:Awaited<ReturnType<typeof prepare>>,patch:Record<string,unknown>={})=>({requestId:randomUUID(),loadId:f.load.id,candidateContentId:f.candidate.id,expectedMappingHash:f.load.mappingHash,choices:choices(),...patch})
const untouched=async(f:Awaited<ReturnType<typeof prepare>>)=>{
 assert.equal((await f.loads.get(f.owner,{loadId:f.load.id})).status,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_loads where owner_id=$1',[f.owner])).rows[0].count,1)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_upgrade_plans where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_upgrade_requests where owner_id=$1',[f.owner])).rows[0].count,0)
}

test('候选必须是同一模板的更高版本，同版本、更低版本与其它模板一律拒绝且不落任何写',async()=>{
 const f=await prepare()
 const lower=await content(f.owner,f.market,'0.9.0',{body:'# 旧手册正文',legacy:true,extra:false})
 const other=await f.market.import({ownerId:f.owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'别的'},manifestPath:'teloa.json',files:files('# 手册',{legacy:false,extra:false},{...manifest('2.0.0',{body:'# 手册',legacy:false,extra:false}),id:'other'}),references:[]})
 for(const candidateContentId of [f.baseline.id,lower.id,other.content.id])
  await assert.rejects(f.loads.upgrade(f.owner,command(f,{candidateContentId,choices:choices({resources:{}})})),{code:'teloa/invalid-input',message:'候选内容必须是同一行业模板的更高版本。'})
 await untouched(f)
})

test('选择必须逐项覆盖变化资源且取值与变化类型相符，越界与错配都不落任何写',async()=>{
 const f=await prepare()
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:choices({resources:{guide:'keep',legacy:'skip'}})})),{code:'teloa/invalid-input',message:'新增手册：请选择处理方式。'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:choices({resources:{guide:'keep',legacy:'keep',extra:'candidate'}})})),{code:'teloa/invalid-input',message:'旧手册：处理方式与资源变化不符。'})
 // 被移除的知识不是 kit 管理状态的四类资源，没有"解除"这个终态，只能搁置。
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:choices({resources:{guide:'keep',legacy:'detach',extra:'candidate'}})})),{code:'teloa/invalid-input',message:'旧手册：处理方式与资源变化不符。'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:choices({resources:{guide:'detach',legacy:'skip',extra:'candidate'}})})),{code:'teloa/invalid-input',message:'研究手册：处理方式与资源变化不符。'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:choices({resources:{guide:'keep',legacy:'skip',extra:'keep'}})})),{code:'teloa/invalid-input',message:'新增手册：处理方式与资源变化不符。'})
 // 未变化的资源不接受选择：它一律沿用旧实例。
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:choices({resources:{guide:'keep',legacy:'skip',extra:'candidate',analyst:'keep'}})})),{code:'teloa/invalid-input',message:'资源选择与当前差异不一致，请重新比较。'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:{...choices(),relations:'detach'}})),{code:'teloa/invalid-input'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{choices:{...choices(),roles:{[randomUUID()]:'keep-local'}}})),{code:'teloa/invalid-input',message:'员工处理方式指向的员工不属于本次加载。'})
 await untouched(f)
})

test('映射指纹与本人身份不符时拒绝升级，映射指纹按当前加载核对',async()=>{
 const f=await prepare()
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{expectedMappingHash:'a'.repeat(64)})),{code:'teloa/version-conflict'})
 await assert.rejects(f.loads.upgrade(randomUUID(),command(f)),{code:'teloa/forbidden'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f,{expectedMappingHash:'zz'})),{code:'teloa/invalid-input'})
 await untouched(f)
})

test('升级固定计划并建立继任加载：旧加载转 superseded、沿用项记来源实例、计划与回执各一条',async()=>{
 const f=await prepare()
 const input=command(f)
 const {superseded,successor}=await f.loads.upgrade(f.owner,input)
 assert.equal(superseded.id,f.load.id)
 assert.equal(superseded.status,'superseded')
 assert.equal(superseded.upgrade,undefined)
 assert.equal(successor.status,'active')
 assert.equal(successor.templateVersion,'1.1.0')
 assert.equal(successor.contentId,f.candidate.id)
 assert.equal(successor.space.id,f.load.space.id)
 assert.equal(successor.targetVersion,2)
 assert.deepEqual(successor.upgrade,{loadId:f.load.id,templateVersion:'1.0.0',choices:choices(),diffDigest:successor.upgrade!.diffDigest,createdAt:successor.upgrade!.createdAt})
 assert.match(successor.upgrade!.diffDigest,/^[0-9a-f]{64}$/)
 // 沿用项带旧实例身份：未列出选择的 analyst/alerts 默认沿用，显式 keep 的 guide 也沿用，新增的 extra 不沿用。
 assert.equal(successor.items.find(item=>item.localId==='guide')?.carriedFrom,instanceOf(f.load,'guide'))
 assert.equal(successor.items.find(item=>item.localId==='analyst')?.carriedFrom,instanceOf(f.load,'analyst'))
 assert.equal(successor.items.find(item=>item.localId==='alerts')?.carriedFrom,instanceOf(f.load,'alerts'))
 assert.equal(successor.items.find(item=>item.localId==='extra')?.carriedFrom,undefined)
 assert.equal(successor.items.some(item=>item.localId==='legacy'),false)
 // 继任加载项自己有新的实例身份，沿用只记来源，不复用身份。
 assert.notEqual(instanceOf(successor,'guide'),instanceOf(f.load,'guide'))
 const plans=(await pool.query('select * from teloa_industry_upgrade_plans where owner_id=$1',[f.owner])).rows
 assert.equal(plans.length,1)
 assert.equal(plans[0].load_id,f.load.id)
 assert.equal(plans[0].successor_load_id,successor.id)
 assert.equal(plans[0].diff_digest,successor.upgrade!.diffDigest)
 assert.deepEqual(plans[0].choices,choices())
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_upgrade_requests where owner_id=$1',[f.owner])).rows[0].count,1)
 // 目录默认只剩继任加载，旧加载仍可按身份读出以便追溯。
 assert.deepEqual((await f.loads.list(f.owner,{})).items.map(item=>item.id),[successor.id])
 assert.equal((await f.loads.list(f.owner,{includeUnloaded:true})).items.length,2)
 assert.equal((await f.loads.get(f.owner,{loadId:f.load.id})).status,'superseded')
 // 同请求复放得到完全相同的两条记录；换选择同请求拒绝；换请求再升级同一旧加载拒绝。
 assert.deepEqual(await f.loads.upgrade(f.owner,input),{superseded,successor})
 await assert.rejects(f.loads.upgrade(f.owner,{...input,choices:choices({positioning:'keep'})}),{code:'teloa/conflict',message:'同一升级请求不能更换目标加载、候选内容或处理方式。'})
 await assert.rejects(f.loads.upgrade(f.owner,command(f)),{code:'teloa/conflict',message:'行业模板加载已卸载或已被升级替代。'})
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_loads where owner_id=$1',[f.owner])).rows[0].count,2)
})

test('被替代的加载不再接受实例写入，候选版本已在场时不能再作为继任加载',async()=>{
 const f=await prepare()
 const {successor}=await f.loads.upgrade(f.owner,command(f))
 const dataSources=new IndustryDataSourceService(pool,identity,f.loads,reader(f.loads,dataSourceDefinition),{ready:async()=>({ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'})})
 await assert.rejects(dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:instanceOf(f.load,'alerts')}),{code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
 // 继任加载本身仍可正常登记实例。
 assert.equal((await dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:successor.id,itemInstanceId:instanceOf(successor,'alerts')})).state,'needs_authorization')
 // 继任加载可以继续往上升级，沿用链逐级记来源实例。
 const third=await content(f.owner,f.market,'1.2.0',{body:'# 第三版手册',legacy:false,extra:true})
 const {successor:latest}=await f.loads.upgrade(f.owner,{requestId:randomUUID(),loadId:successor.id,candidateContentId:third.id,expectedMappingHash:successor.mappingHash,choices:choices({resources:{guide:'keep'}})})
 assert.equal(latest.upgrade?.loadId,successor.id)
 assert.equal(latest.upgrade?.templateVersion,'1.1.0')
 assert.equal(latest.items.find(item=>item.localId==='extra')?.carriedFrom,instanceOf(successor,'extra'))
})

test('候选版本已单独加载到同一业务空间时不能再作为继任加载，旧加载保持原样',async()=>{
 const f=await prepare()
 await f.loads.create(f.owner,{requestId:randomUUID(),contentId:f.candidate.id,contentHash:f.candidate.hash,target:{kind:'existing',spaceId:f.load.space.id,expectedVersion:1}})
 await assert.rejects(f.loads.upgrade(f.owner,command(f)),{code:'teloa/conflict',message:'候选版本已加载到该业务空间，不能再作为继任加载。'})
 assert.equal((await f.loads.get(f.owner,{loadId:f.load.id})).status,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_upgrade_plans where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_upgrade_requests where owner_id=$1',[f.owner])).rows[0].count,0)
})

test('未接入内容读取端口时升级显式失败，不静默降级为按快照比较',async()=>{
 const f=await prepare()
 const loads=new IndustryLoadService(pool,identity,{read:(owner,contentId,contentHash)=>createIndustryLoadSource(f.market).read(owner,contentId,contentHash)})
 await assert.rejects(loads.upgrade(f.owner,command(f)),{code:'teloa/dependency-unavailable'})
 await untouched(f)
})

/** 同一模板的两个版本各建一套内容与加载，用来只核对版本比较本身。 */
async function versionPair(before:string,after:string){
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const baseline=await content(owner,market,before,{body:'# 原手册',legacy:false,extra:false})
 const candidate=await content(owner,market,after,{body:'# 新手册',legacy:false,extra:false})
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:baseline.id,contentHash:baseline.hash,target:{kind:'new',spaceId:randomUUID(),name:'研究空间'}})
 return {owner,loads,load,candidate}
}
const upgradeTo=async(pair:Awaited<ReturnType<typeof versionPair>>)=>pair.loads.upgrade(pair.owner,{requestId:randomUUID(),loadId:pair.load.id,candidateContentId:pair.candidate.id,expectedMappingHash:pair.load.mappingHash,choices:choices({resources:{guide:'candidate'}})})

test('版本比较遵循 semver 预发布次序：正式版高于预发布，预发布标识按段比较且数字段按数值',async()=>{
 for(const [before,after] of [['1.0.0-beta.1','1.0.0'],['1.0.0-beta.1','1.0.0-beta.2'],['1.0.0-beta.9','1.0.0-beta.10'],['1.0.0-alpha','1.0.0-alpha.1'],['1.0.0-rc.1','1.0.1']]){
  const pair=await versionPair(before!,after!)
  assert.equal((await upgradeTo(pair)).successor.templateVersion,after)
 }
 for(const [before,after] of [['1.0.0','1.0.0-beta.1'],['1.0.0-beta.2','1.0.0-beta.1'],['1.0.0-beta.10','1.0.0-beta.9'],['1.0.0-alpha.1','1.0.0-alpha'],['1.0.0-beta.1','1.0.0-beta.1+build']]){
  const pair=await versionPair(before!,after!)
  await assert.rejects(upgradeTo(pair),{code:'teloa/invalid-input',message:'候选内容必须是同一行业模板的更高版本。'})
 }
})

test('同一内容在同一空间被卸载或被替代后不能重新加载，重复加载不写回执',async()=>{
 const superseded=await prepare()
 await superseded.loads.upgrade(superseded.owner,command(superseded))
 const reloadSuperseded={requestId:randomUUID(),contentId:superseded.baseline.id,contentHash:superseded.baseline.hash,target:{kind:'existing' as const,spaceId:superseded.load.space.id,expectedVersion:2}}
 await assert.rejects(superseded.loads.create(superseded.owner,reloadSuperseded),{code:'teloa/conflict',message:'同一内容已在此业务空间加载过，并已卸载或被升级替代，不能再次加载。'})
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_requests where owner_id=$1 and request_id=$2',[superseded.owner,reloadSuperseded.requestId])).rows[0].count,0)
 assert.equal((await superseded.loads.list(superseded.owner,{})).items.length,1)

 const unloaded=await prepare()
 await unloaded.loads.unload(unloaded.owner,{requestId:randomUUID(),loadId:unloaded.load.id,expectedMappingHash:unloaded.load.mappingHash})
 const reloadUnloaded={requestId:randomUUID(),contentId:unloaded.baseline.id,contentHash:unloaded.baseline.hash,target:{kind:'existing' as const,spaceId:unloaded.load.space.id,expectedVersion:1}}
 await assert.rejects(unloaded.loads.create(unloaded.owner,reloadUnloaded),{code:'teloa/conflict',message:'同一内容已在此业务空间加载过，并已卸载或被升级替代，不能再次加载。'})
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_requests where owner_id=$1 and request_id=$2',[unloaded.owner,reloadUnloaded.requestId])).rows[0].count,0)
 assert.equal((await unloaded.loads.list(unloaded.owner,{})).items.length,0)
 // 仍在生效的加载照旧复用同一条记录。
 const active=await prepare()
 const again=await active.loads.create(active.owner,{requestId:randomUUID(),contentId:active.baseline.id,contentHash:active.baseline.hash,target:{kind:'existing',spaceId:active.load.space.id,expectedVersion:1}})
 assert.equal(again.id,active.load.id)
})

const executionToolDefinition={format:'teloa.execution-tool/v1' as const,adapterId:'security-action-http' as const,tools:['security.endpoint.isolate'] as ['security.endpoint.isolate']}
const mcpDefinition={format:'teloa.mcp-connection/v1' as const,serverName:'teloa_reference',tools:['read_reference']}
const pluginDefinition={format:'teloa.plugin/v1' as const,registry:'npm' as const,packageName:'dsh-visualize',version:'0.1.2'}
/**
 * 按选择应用的夹具清单：`alerts` 两版完全相同（未变化，隐含沿用），`probe` 与 `analyst` 定义版本变化（可取候选），
 * 基线独有的四项分别是 kit 管理的四类资源（候选里被移除，可解除），候选独有的 `extra` 是新增资源。
 * `brief` 两版也完全相同，用来核对"没有实例投影的类型即便未变化也不标沿用"。
 */
const applyManifest=(version:string)=>{
 const first=version==='1.0.0',bumped=first?'1.0.0':'1.1.0'
 return {
  format:'teloa.business-package/v2' as const,id:'apply',title:'应用模板',version,domain:'general',description:'按选择应用',
  resources:[
   {id:'alerts',kind:'data-source' as const,title:'告警来源',version:'1.0.0',required:true,source:{kind:'local' as const,path:'alerts.json'}},
   {id:'probe',kind:'data-source' as const,title:'巡检来源',version:bumped,required:false,source:{kind:'local' as const,path:'probe.json'}},
   {id:'analyst',kind:'role' as const,title:'分析岗',version:bumped,required:true,source:{kind:'local' as const,path:'role.json'}},
   {id:'brief',kind:'skill' as const,title:'简报',version:'1.0.0',required:false,source:{kind:'local' as const,path:'skills/brief/SKILL.md'}},
   ...(first?[
    {id:'old-source',kind:'data-source' as const,title:'旧告警来源',version:'1.0.0',required:false,source:{kind:'local' as const,path:'old-source.json'}},
    {id:'old-tool',kind:'execution-tool' as const,title:'旧执行器',version:'1.0.0',required:false,source:{kind:'local' as const,path:'old-tool.json'}},
    {id:'old-mcp',kind:'mcp' as const,title:'旧资料连接',version:'1.0.0',required:false,source:{kind:'local' as const,path:'old-mcp.json'}},
    {id:'old-plugin',kind:'plugin' as const,title:'旧可视化插件',version:'1.0.0',required:false,source:{kind:'local' as const,path:'old-plugin.json'}},
   ]:[{id:'extra',kind:'knowledge' as const,title:'新增手册',version:'1.0.0',required:false,source:{kind:'local' as const,path:'extra.md'}}]),
  ],
  relations:[] as {kind:string;from:string;to:string}[],entrypoints:[] as string[],
 }
}
const applyFiles=(version:string,manifestValue:unknown)=>{
 const first=version==='1.0.0'
 return [
  file('teloa.json',JSON.stringify(manifestValue)),
  file('alerts.json',JSON.stringify({format:'teloa.data-source/v1',sourceId:'research-alert-http',scopes:['general']})),
  file('probe.json',JSON.stringify({format:'teloa.data-source/v1',sourceId:'research-alert-http',scopes:['general']})),
  file('role.json',JSON.stringify({format:'teloa.role/v1',name:'分析岗',kind:'employee',duty:first?'核对':'核对并复盘',dataScope:'资料',executionScope:'代拟'})),
  file('skills/brief/SKILL.md','---\nname: apply-brief\ndescription: 形成简报\n---\n固定方法'),
  ...(first?[file('old-source.json','{}'),file('old-tool.json','{}'),file('old-mcp.json','{}'),file('old-plugin.json','{}')]:[file('extra.md','# 新增手册')]),
 ]
}
async function applyContent(owner:string,market:MarketContentStore,version:string,patch:(value:ReturnType<typeof applyManifest>)=>unknown=value=>value,roleRuntime?:Record<string,unknown>){
 const value=patch(applyManifest(version))
 const files=applyFiles(version,value).map(row=>row.path==='role.json'&&roleRuntime?file('role.json',JSON.stringify({...JSON.parse(new TextDecoder().decode(row.bytes)),runtimeConfig:roleRuntime})):row)
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'应用'},manifestPath:'teloa.json',files,references:[]})
 return saved.content
}
const applyChoices=(patch:Partial<IndustryUpdateChoices>={}):IndustryUpdateChoices=>({
 resources:{probe:'candidate',analyst:'candidate','old-source':'detach','old-tool':'detach','old-mcp':'detach','old-plugin':'detach',extra:'candidate'},
 roles:{},relations:'keep',entrypoints:'keep',positioning:'keep',...patch,
})
const detachTables={'old-source':'teloa_industry_data_source_instances','old-tool':'teloa_industry_execution_tool_instances','old-mcp':'teloa_industry_mcp_instances','old-plugin':'teloa_industry_plugin_instances'} as const
/** 建一份四类 kit 实例齐备、岗位已建立、告警来源已连接的加载，用来核对"按选择应用"。 */
async function applyFixture(db:PoolType=pool){
 const owner=randomUUID(),market=new MarketContentStore(db,identity),roleService=new RoleService(db,identity)
 // 岗位服务依赖加载服务，加载服务的重放端口又依赖岗位服务：端口延迟取值，两者才能互指。
 const loads:IndustryLoadService=new IndustryLoadService(db,identity,createIndustryLoadSource(market),new PlanService(db,identity),{applyTemplateInTransaction:async(client,ownerId,input)=>industryRoles.applyTemplateInTransaction(client,ownerId,input)})
 const industryRoles:IndustryRoleService=new IndustryRoleService(db,identity,loads,new IndustryRoleSource(market,loads),{get:async()=>{throw Error('本夹具没有知识依赖')}},roleService)
 const baseline=await applyContent(owner,market,'1.0.0'),candidate=await applyContent(owner,market,'1.1.0')
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:baseline.id,contentHash:baseline.hash,target:{kind:'new',spaceId:randomUUID(),name:'应用空间'}})
 const dataSources=new IndustryDataSourceService(db,identity,loads,reader(loads,dataSourceDefinition),{ready:async()=>({ready:true as const,probedAt:'2026-09-14T00:00:00.000Z'})})
 const alerts=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'alerts')})
 await dataSources.authorize(owner,{requestId:randomUUID(),instanceId:alerts.id,expectedRevision:alerts.revision},new AbortController().signal)
 const oldSource=await dataSources.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'old-source')})
 const executionTools=new IndustryExecutionToolService(db,identity,loads,reader(loads,executionToolDefinition),{ready:async()=>({ready:true as const,observedAt:'2026-09-14T00:00:00.000Z'})})
 await executionTools.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'old-tool')})
 const mcp=new IndustryMcpConnectionService(db,identity,loads,reader(loads,mcpDefinition),{ready:async()=>({ready:true as const,observedAt:'2026-09-14T00:00:00.000Z',tools:['read_reference']})})
 await mcp.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'old-mcp')})
 const plugins=new IndustryPluginService(db,identity,loads,reader(loads,pluginDefinition),{
  preview:async()=>{throw Error('不应预览')},install:async()=>{throw Error('不应安装')},reconcile:async()=>{throw Error('不应核对')},find:async()=>null,
 })
 await plugins.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'old-plugin')})
 const roleRequest={requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'analyst')},roleInstance=await industryRoles.instantiate(owner,roleRequest)
 assert.ok(roleInstance.role)
 return {owner,market,loads,roleService,industryRoles,dataSources,baseline,candidate,load,alerts,oldSource,role:roleInstance.role,roleRequest}
}
const applyCommand=(f:Awaited<ReturnType<typeof applyFixture>>,patch:Record<string,unknown>={})=>({requestId:randomUUID(),loadId:f.load.id,candidateContentId:f.candidate.id,expectedMappingHash:f.load.mappingHash,choices:applyChoices(),...patch})
const detachStates=async(owner:string,load:IndustryLoadRecord)=>Object.fromEntries(await Promise.all(Object.entries(detachTables).map(
 async([localId,table])=>[localId,(await pool.query(`select state,revision from ${table} where owner_id=$1 and item_instance_id=$2`,[owner,instanceOf(load,localId)])).rows[0] as {state:string;revision:number}] as const,
)))
/** 岗位的可写字段：`edit` 只接受完整定义，因此从当前岗位原样带过去再改要改的那两项。 */
const roleFields=(role:{name:string;kind:'employee'|'twin';scopes:string[];duty:string;dataScope:string;executionScope:string;skills:string[];knowledge:string[];responsibility?:unknown},patch:Record<string,unknown>)=>({
 name:role.name,kind:role.kind,scopes:role.scopes,duty:role.duty,dataScope:role.dataScope,executionScope:role.executionScope,skills:role.skills,knowledge:role.knowledge,responsibility:role.responsibility,...patch,
})

test('按选择应用：沿用项投影来源实例状态、候选项仍可实例化、被移除的四类 kit 实例转终态',async()=>{
 const f=await applyFixture()
 const before=await detachStates(f.owner,f.load)
 for(const [localId,row] of Object.entries(before)){assert.notEqual(row.state,'detached',localId);assert.equal(row.revision,1,localId)}
 const {superseded,successor}=await f.loads.upgrade(f.owner,applyCommand(f))
 assert.equal(superseded.status,'superseded')
 // keep（未列出选择即沿用）：继任项记来源实例，状态取来源实例的真实状态——已连接的数据源在继任加载上仍显示可用。
 const carried=successor.items.find(item=>item.localId==='alerts')!
 assert.equal(carried.carriedFrom,instanceOf(f.load,'alerts'))
 assert.equal(carried.status,'active')
 assert.notEqual(carried.instanceId,instanceOf(f.load,'alerts'))
 // 沿用项不再另行实例化，避免同一项两个实例。
 await assert.rejects(f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:successor.id,itemInstanceId:carried.instanceId}),{code:'teloa/conflict'})
 // candidate 与新增：继任项没有沿用来源、仍是待接入，并且可以在继任加载上真正登记新实例。
 const probe=successor.items.find(item=>item.localId==='probe')!
 assert.equal(probe.carriedFrom,undefined)
 assert.equal(probe.status,'pending-adapter')
 assert.equal(successor.items.find(item=>item.localId==='extra')?.status,'pending-adapter')
 assert.equal(successor.items.find(item=>item.localId==='extra')?.carriedFrom,undefined)
 assert.equal((await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:successor.id,itemInstanceId:probe.instanceId})).state,'needs_authorization')
 // detach：四类 kit 实例都转终态且修订 +1，绑定与定义列保留；被移除的资源在继任加载上根本没有项。
 for(const [localId,row] of Object.entries(await detachStates(f.owner,f.load))){
  assert.equal(row.state,'detached',localId)
  assert.equal(row.revision,before[localId]!.revision+1,localId)
  assert.equal(successor.items.some(item=>item.localId===localId),false,localId)
 }
 // 已解除的旧实例不再接受写入。
 await assert.rejects(f.dataSources.authorize(f.owner,{requestId:randomUUID(),instanceId:f.oldSource.id,expectedRevision:2},new AbortController().signal),{code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
})

test('岗位选 use-template 时按候选模板重放定义并覆盖本地修改，岗位版本 +1 且落编辑回执',async()=>{
 const f=await applyFixture()
 const edited=await f.roleService.edit(f.owner,{roleId:f.role.id,expectedVersion:f.role.version,fields:roleFields(f.role,{name:'本地改名',duty:'本地职责'})})
 assert.equal(edited.version,2)
 await f.loads.upgrade(f.owner,applyCommand(f,{choices:applyChoices({roles:{[instanceOf(f.load,'analyst')]:'use-template'}})}))
 const replayed=(await f.roleService.list(f.owner,{})).find(row=>row.id===f.role.id)!
 assert.equal(replayed.version,3)
 assert.equal(replayed.name,'分析岗')
 assert.equal(replayed.duty,'核对并复盘')
 // 空间范围、能力与知识不是模板字段，仍取实例化当时固定下来的那份。
 assert.deepEqual(replayed.scopes,[f.load.space.scope])
 assert.deepEqual(replayed.skills,[])
 assert.deepEqual(replayed.knowledge,[])
 assert.equal((await pool.query('select count(*)::int as count from teloa_role_edits where role_id=$1',[f.role.id])).rows[0].count,2)
 // 实例行上冻结的创建定义与下游请求身份原样不动，岗位实例仍能读出这个岗位。
 assert.equal((await f.industryRoles.list(f.owner,{})).items[0]!.role?.name,'分析岗')
})

test('复审 M-a/M-b：候选模板带模型指定时 use-template 保留本人已选的岗位模型、其余运行配置按模板，实例补记 model/skipped 提示且回执摘要同步',async()=>{
 const f=await applyFixture()
 const candidate=await applyContent(f.owner,f.market,'1.1.0',value=>value,{agentPresetId:'security-analyst',model:{provider:'deepseek-official',model:'deepseek-flash'},fallbackModel:{provider:'other-cloud',model:'x'}})
 const own={model:{provider:'ollama',model:'qwen3:4b'},fallbackModel:{provider:'deepseek-official',model:'deepseek-v4-pro'}}
 await f.roleService.edit(f.owner,{roleId:f.role.id,expectedVersion:f.role.version,fields:roleFields(f.role,{runtimeConfig:own})})
 const before=(await f.industryRoles.list(f.owner,{})).items[0]!
 assert.equal(before.declarations.some(row=>row.kind==='model'),false)
 await f.loads.upgrade(f.owner,applyCommand(f,{candidateContentId:candidate.id,choices:applyChoices({roles:{[instanceOf(f.load,'analyst')]:'use-template'}})}))
 const replayed=(await f.roleService.list(f.owner,{})).find(row=>row.id===f.role.id)!
 assert.equal(replayed.duty,'核对并复盘')
 assert.deepEqual(replayed.runtimeConfig,{agentPresetId:'security-analyst',...own},'模板不能指定岗位模型，本人已选模型不得被清空')
 const after=(await f.industryRoles.list(f.owner,{})).items[0]!
 assert.ok(after.declarations.some(row=>row.kind==='model'&&row.status==='skipped'&&row.itemInstanceId===before.itemInstanceId),JSON.stringify(after.declarations))
 assert.equal(after.revision,before.revision+1)
 assert.equal(after.role?.id,f.role.id)
 // 原实例化请求重放仍按同一回执返回，不因摘要同步而报损坏。
 const replayedInstance=await f.industryRoles.instantiate(f.owner,f.roleRequest)
 assert.equal(replayedInstance.id,before.id)
})

test('岗位选 keep-local 时一个字都不改，既不动岗位定义也不动版本',async()=>{
 const f=await applyFixture()
 const edited=await f.roleService.edit(f.owner,{roleId:f.role.id,expectedVersion:f.role.version,fields:roleFields(f.role,{name:'本地改名',duty:'本地职责'})})
 await f.loads.upgrade(f.owner,applyCommand(f,{choices:applyChoices({roles:{[instanceOf(f.load,'analyst')]:'keep-local'}})}))
 const kept=(await f.roleService.list(f.owner,{})).find(row=>row.id===f.role.id)!
 assert.deepEqual([kept.version,kept.name,kept.duty],[edited.version,'本地改名','本地职责'])
})

test('应用中途失败整笔回滚：继任加载、计划、回执、替代状态与已解除的实例全部不落',async()=>{
 const f=await applyFixture()
 // 运行中的岗位不允许编辑（既有判据），正好用来制造应用中途失败。
 await pool.query("update teloa_roles set state='active' where id=$1",[f.role.id])
 await assert.rejects(f.loads.upgrade(f.owner,applyCommand(f,{choices:applyChoices({roles:{[instanceOf(f.load,'analyst')]:'use-template'}})})),{code:'teloa/conflict',message:'请先暂停员工并核对关联工作。'})
 assert.equal((await f.loads.get(f.owner,{loadId:f.load.id})).status,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_loads where owner_id=$1',[f.owner])).rows[0].count,1)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_upgrade_plans where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_upgrade_requests where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int as count from teloa_role_edits where role_id=$1',[f.role.id])).rows[0].count,0)
 for(const [localId,row] of Object.entries(await detachStates(f.owner,f.load))){assert.notEqual(row.state,'detached',localId);assert.equal(row.revision,1,localId)}
})

test('候选模板里已移除的岗位不能采用模板定义，未接入岗位服务时带该选择的升级显式失败',async()=>{
 const f=await applyFixture()
 const analyst=instanceOf(f.load,'analyst')
 const withTemplate=applyChoices({roles:{[analyst]:'use-template'}})
 const bare=new IndustryLoadService(pool,identity,createIndustryLoadSource(f.market))
 await assert.rejects(bare.upgrade(f.owner,applyCommand(f,{choices:withTemplate})),{code:'teloa/dependency-unavailable',message:'员工服务尚未接入，不能按模板重放员工定义。'})
 const dropped=await applyContent(f.owner,f.market,'1.2.0',value=>({...value,resources:value.resources.filter(row=>row.id!=='analyst')}))
 await assert.rejects(f.loads.upgrade(f.owner,applyCommand(f,{candidateContentId:dropped.id,choices:applyChoices({resources:{probe:'candidate',analyst:'skip','old-source':'detach','old-tool':'detach','old-mcp':'detach','old-plugin':'detach',extra:'candidate'},roles:{[analyst]:'use-template'}})})),{code:'teloa/invalid-input',message:'采用模板定义的员工在候选模板中已移除或不再是包内定义。'})
 assert.equal((await f.loads.get(f.owner,{loadId:f.load.id})).status,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_upgrade_plans where owner_id=$1',[f.owner])).rows[0].count,0)
})

const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
/** 由某次加载创建、仍在生效的持续计划：用来核对升级的在途阻断与"随升级暂停"。 */
async function activePlan(owner:string,loadId:string){
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'升级岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'已授权资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const plans=new PlanService(pool,identity)
 const plan=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日资料核对',goal:'核对当日资料并形成结论。',scope:'general',dataScope:'已授权资料。',delivery:'结论与待办。',roleId:role.id,expectedRoleVersion:1,trigger:schedule,notificationPolicy:'attention'},source:{kind:'manual'}})
 const enabled=await plans.change(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,action:'enable'})
 await pool.query('insert into teloa_industry_plan_sources values($1,$2,$3,$4,$5,$6,now())',[plan.id,owner,randomUUID(),JSON.stringify({loadId}),JSON.stringify({loadId}),'a'.repeat(64)])
 return enabled
}
/** 领取后尚未落任务的日程：计划仍在生效且版本一致时即为"占用中"。 */
async function claimedOccurrence(owner:string,plan:{id:string;version:number;configVersion:number}){
 const id=randomUUID()
 await pool.query('insert into teloa_plan_occurrences values($1,$2,$3,$4,$5,$6,now(),now(),$7,$8,$9)',[
  id,owner,plan.id,plan.version,plan.configVersion,'2026-09-15T09:00[Asia/Singapore]',randomUUID(),JSON.stringify({fixture:true}),'f'.repeat(64),
 ])
 return id
}

test('沿用来源恒指向真正持有实例的项：二级升级后仍投影来源实例的状态，也不再另开实例',async()=>{
 const f=await applyFixture()
 const {successor}=await f.loads.upgrade(f.owner,applyCommand(f))
 // v1.1 → v1.2 两版资源逐字相同，因此所有资源都未变化、一律隐含沿用。
 const third=await applyContent(f.owner,f.market,'1.2.0')
 const {successor:latest}=await f.loads.upgrade(f.owner,{requestId:randomUUID(),loadId:successor.id,candidateContentId:third.id,expectedMappingHash:successor.mappingHash,choices:applyChoices({resources:{}})})
 const carried=latest.items.find(item=>item.localId==='alerts')!
 // 跳过中间那一跳：v1.1 的沿用项自己没有实例行，指向它会让状态投影与防重判据一起落空。
 assert.equal(carried.carriedFrom,instanceOf(f.load,'alerts'))
 assert.notEqual(carried.carriedFrom,instanceOf(successor,'alerts'))
 assert.equal(carried.status,'active')
 await assert.rejects(f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:latest.id,itemInstanceId:carried.instanceId}),{code:'teloa/conflict'})
 // 链上的 detach 也只对本次被移除的资源生效：v1.1 起就没有这四项了。
 assert.deepEqual(latest.items.map(item=>item.localId).sort(),['alerts','analyst','brief','extra','probe'])
})

test('没有实例投影的类型不标沿用：能力项在继任加载上是全新的待接入项',async()=>{
 const f=await applyFixture()
 const {successor}=await f.loads.upgrade(f.owner,applyCommand(f))
 const brief=successor.items.find(item=>item.localId==='brief')!
 // 能力的使用关系按 (加载,加载项) 绑定：继任加载上是新的加载项身份，旧加载的安装够不到它。
 assert.equal(brief.carriedFrom,undefined)
 assert.equal(brief.status,'pending-adapter')
 assert.notEqual(brief.instanceId,instanceOf(f.load,'brief'))
 assert.equal((await pool.query("select count(*)::int as count from teloa_industry_load_items where load_id=$1 and carried_from is not null and kind in ('skill','plan','task','work-template')",[successor.id])).rows[0].count,0)
})

test('对沿用项选解除时解除的是持有实例：二级升级上被移除的沿用资源真的转终态',async()=>{
 const f=await applyFixture()
 const {successor}=await f.loads.upgrade(f.owner,applyCommand(f))
 assert.equal(successor.items.find(item=>item.localId==='alerts')?.carriedFrom,instanceOf(f.load,'alerts'))
 const before=(await pool.query('select state,revision from teloa_industry_data_source_instances where id=$1',[f.alerts.id])).rows[0]
 assert.equal(before.state,'active')
 // v1.1 → v1.2 只有 alerts 被移除：它的实例挂在 v1.0 的加载上，按当前加载过滤会一行都匹配不到。
 const third=await applyContent(f.owner,f.market,'1.2.0',value=>({...value,resources:value.resources.filter(row=>row.id!=='alerts')}))
 const {successor:latest}=await f.loads.upgrade(f.owner,{requestId:randomUUID(),loadId:successor.id,candidateContentId:third.id,expectedMappingHash:successor.mappingHash,
  choices:{resources:{alerts:'detach'},roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'}})
 assert.equal(latest.items.some(item=>item.localId==='alerts'),false)
 const after=(await pool.query('select state,revision from teloa_industry_data_source_instances where id=$1',[f.alerts.id])).rows[0]
 assert.equal(after.state,'detached')
 assert.equal(after.revision,before.revision+1)
 await assert.rejects(f.dataSources.authorize(f.owner,{requestId:randomUUID(),instanceId:f.alerts.id,expectedRevision:after.revision},new AbortController().signal),
  {code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
})

test('卸载继任加载连沿用来的持有实例一起解除：升级过的模板卸载后不留可写实例',async()=>{
 const f=await applyFixture()
 const {successor}=await f.loads.upgrade(f.owner,applyCommand(f))
 const own=await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:successor.id,itemInstanceId:instanceOf(successor,'probe')})
 const before=(await pool.query('select state,revision from teloa_industry_data_source_instances where id=$1',[f.alerts.id])).rows[0]
 assert.equal(before.state,'active')
 const unloaded=await f.loads.unload(f.owner,{requestId:randomUUID(),loadId:successor.id,expectedMappingHash:successor.mappingHash})
 assert.equal(unloaded.status,'unloaded')
 // 沿用来的持有实例（仍挂在被替代的加载上）与继任加载自己的实例都转终态。
 const carried=(await pool.query('select state,revision from teloa_industry_data_source_instances where id=$1',[f.alerts.id])).rows[0]
 assert.equal(carried.state,'detached')
 assert.equal(carried.revision,before.revision+1)
 assert.equal((await pool.query('select state from teloa_industry_data_source_instances where id=$1',[own.id])).rows[0].state,'detached')
 await assert.rejects(f.dataSources.authorize(f.owner,{requestId:randomUUID(),instanceId:own.id,expectedRevision:own.revision},new AbortController().signal),
  {code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
})

test('沿用来的实例仍可推进：被替代加载上尚未连接的数据源在继任加载在场时能完成授权',async()=>{
 const f=await applyFixture()
 const probe=await f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:instanceOf(f.load,'probe')})
 assert.equal(probe.state,'needs_authorization')
 const {successor}=await f.loads.upgrade(f.owner,applyCommand(f,{choices:applyChoices({resources:{probe:'keep',analyst:'candidate','old-source':'detach','old-tool':'detach','old-mcp':'detach','old-plugin':'detach',extra:'candidate'}})}))
 const carried=successor.items.find(item=>item.localId==='probe')!
 assert.equal(carried.carriedFrom,instanceOf(f.load,'probe'))
 assert.equal(carried.status,'instantiated')
 const authorized=await f.dataSources.authorize(f.owner,{requestId:randomUUID(),instanceId:probe.id,expectedRevision:probe.revision},new AbortController().signal)
 assert.equal(authorized.state,'active')
 assert.equal(authorized.revision,probe.revision+1)
 // 实例仍留在被替代的加载上，只是继任加载把它投影为已连接。
 assert.equal(authorized.loadId,f.load.id)
 assert.equal((await f.loads.get(f.owner,{loadId:successor.id})).items.find(item=>item.localId==='probe')?.status,'active')
 // 新开实例仍然被拒：放行的只有推进。
 await assert.rejects(f.dataSources.instantiate(f.owner,{requestId:randomUUID(),loadId:f.load.id,itemInstanceId:instanceOf(f.load,'probe')}),{code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
 // 已解除的实例不在放行范围内。
 await assert.rejects(f.dataSources.authorize(f.owner,{requestId:randomUUID(),instanceId:f.oldSource.id,expectedRevision:2},new AbortController().signal),{code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
})

test('旧加载有占用中的计划日程时不能升级；升级成功则旧加载的计划一并暂停并记原因',async()=>{
 const blocked=await applyFixture()
 const plan=await activePlan(blocked.owner,blocked.load.id)
 const occurrenceId=await claimedOccurrence(blocked.owner,plan)
 const before=await detachStates(blocked.owner,blocked.load)
 await assert.rejects(blocked.loads.upgrade(blocked.owner,applyCommand(blocked)),error=>{
  assert.equal((error as {code:string}).code,'teloa/conflict')
  assert.deepEqual((error as {details:{blockers:unknown[]}}).details,{blockers:[{kind:'plan-occurrence',id:occurrenceId}]})
  return true
 })
 assert.deepEqual(await detachStates(blocked.owner,blocked.load),before)
 assert.equal((await blocked.loads.get(blocked.owner,{loadId:blocked.load.id})).status,'active')
 assert.equal((await pool.query('select state from teloa_plans where id=$1',[plan.id])).rows[0].state,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_upgrade_plans where owner_id=$1',[blocked.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_upgrade_requests where owner_id=$1',[blocked.owner])).rows[0].count,0)

 const f=await applyFixture()
 const kept=await activePlan(f.owner,f.load.id)
 await f.loads.upgrade(f.owner,applyCommand(f))
 assert.equal((await pool.query('select state from teloa_plans where id=$1',[kept.id])).rows[0].state,'paused')
 assert.equal((await pool.query("select request_spec->>'note' note from teloa_plan_changes where plan_id=$1 and request_spec->>'action'='pause'",[kept.id])).rows[0].note,'模板已升级，请在新版本重新启用')
})

/**
 * 阻断判据必须先于继任加载 `insert`：同一笔升级既有在途阻断项、候选版本又已单独加载到同一空间时，
 * 用户要看到的是"还有进行中的执行"，而不是 `insert` 的"候选版本已加载"。顺序写反了这一例会先撞重复加载。
 */
test('在途阻断先于继任加载建立：候选版本已单独加载也仍然报阻断项，且不落任何写',async()=>{
 const f=await applyFixture()
 const plan=await activePlan(f.owner,f.load.id)
 const occurrenceId=await claimedOccurrence(f.owner,plan)
 await f.loads.create(f.owner,{requestId:randomUUID(),contentId:f.candidate.id,contentHash:f.candidate.hash,target:{kind:'existing',spaceId:f.load.space.id,expectedVersion:1}})
 const before=await detachStates(f.owner,f.load)
 await assert.rejects(f.loads.upgrade(f.owner,applyCommand(f)),error=>{
  assert.equal((error as {code:string}).code,'teloa/conflict')
  assert.deepEqual((error as {details:{blockers:unknown[]}}).details,{blockers:[{kind:'plan-occurrence',id:occurrenceId}]})
  assert.doesNotMatch((error as Error).message,/候选版本已加载/)
  return true
 })
 assert.deepEqual(await detachStates(f.owner,f.load),before)
 assert.equal((await f.loads.get(f.owner,{loadId:f.load.id})).status,'active')
 assert.equal((await pool.query('select state from teloa_plans where id=$1',[plan.id])).rows[0].state,'active')
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_loads where owner_id=$1',[f.owner])).rows[0].count,2)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_upgrade_plans where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int as count from teloa_industry_load_upgrade_requests where owner_id=$1',[f.owner])).rows[0].count,0)
})

test('按模板重放岗位定义复用升级事务的连接：连接上限为 1 也能完成整笔升级',async()=>{
 const single=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:3000})
 try{
  const f=await applyFixture(single)
  const {successor}=await f.loads.upgrade(f.owner,applyCommand(f,{choices:applyChoices({roles:{[instanceOf(f.load,'analyst')]:'use-template'}})}))
  assert.equal(successor.templateVersion,'1.1.0')
  assert.equal((await f.roleService.list(f.owner,{})).find(row=>row.id===f.role.id)?.duty,'核对并复盘')
 }finally{await single.end()}
})

/**
 * 插件在两版都在（逐字未变化 → 隐含沿用），另有一个只在基线里的插件（被移除 → 解除）。
 * 用来核对 `verifyFresh` 的放宽只覆盖"仍被活跃加载沿用"这一支：核对是写路径，沿用项要能继续核对，已解除的一律拒。
 */
const carryManifest=(version:string)=>({
 format:'teloa.business-package/v2' as const,id:'carry-plugin',title:'插件沿用模板',version,domain:'general',description:'插件沿用',
 resources:[
  {id:'viz',kind:'plugin' as const,title:'可视化插件',version:'1.0.0',required:true,source:{kind:'local' as const,path:'viz.json'}},
  ...(version==='1.0.0'
   ?[{id:'gone',kind:'plugin' as const,title:'待移除插件',version:'1.0.0',required:false,source:{kind:'local' as const,path:'gone.json'}}]
   :[{id:'note',kind:'knowledge' as const,title:'新增说明',version:'1.0.0',required:false,source:{kind:'local' as const,path:'note.md'}}]),
 ],
 relations:[] as {kind:string;from:string;to:string}[],entrypoints:[] as string[],
})
async function carryContent(owner:string,market:MarketContentStore,version:string){
 const value=carryManifest(version),first=version==='1.0.0'
 const saved=await market.import({ownerId:owner,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'插件沿用'},manifestPath:'teloa.json',files:[
  file('teloa.json',JSON.stringify(value)),file('viz.json','{}'),
  ...(first?[file('gone.json','{}')]:[file('note.md','# 新增说明')]),
 ],references:[]})
 return saved.content
}
const pluginPreview:MarketPluginInstallPreview={
 schema:'teloa.market-plugin-install-preview/v1',source:{registry:'npm',packageName:'dsh-visualize',version:'0.1.2'},
 trust:{status:'verified',publisher:'Teloa Labs',integrity:'sha512-QWxhZGRpbjpjpbnRlZ3JpdHk='},bundleHash:'b'.repeat(64),
 permissionSummary:{permissions:[{id:'workspace.read',description:'读取当前工作区',required:true}]},
}

test('插件核对在沿用到活跃加载后仍可进行并递增修订，已解除的插件一律拒绝核对',async()=>{
 const owner=randomUUID(),market=new MarketContentStore(pool,identity)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const baseline=await carryContent(owner,market,'1.0.0'),candidate=await carryContent(owner,market,'1.1.0')
 const load=await loads.create(owner,{requestId:randomUUID(),contentId:baseline.id,contentHash:baseline.hash,target:{kind:'new',spaceId:randomUUID(),name:'插件沿用空间'}})
 const installed:PluginInstallation={id:randomUUID(),ownerId:owner,preview:pluginPreview,state:'preparing',attempt:1,createdAt:'2026-09-14T00:00:00.000Z',updatedAt:'2026-09-14T00:00:00.000Z'}
 let observed:MarketPluginInstallationState='preparing'
 const plugins=new IndustryPluginService(pool,identity,loads,reader(loads,pluginDefinition),{
  find:async()=>null,preview:async()=>pluginPreview,install:async()=>installed,
  reconcile:async(actor:string,installationId:string)=>{assert.equal(actor,owner);assert.equal(installationId,installed.id);return {...installed,state:observed}},
 })
 const viz=await plugins.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'viz')})
 const gone=await plugins.instantiate(owner,{requestId:randomUUID(),loadId:load.id,itemInstanceId:instanceOf(load,'gone')})
 const installing=await plugins.install(owner,{requestId:randomUUID(),instanceId:viz.id,expectedRevision:viz.revision,preview:pluginPreview})
 assert.equal(installing.state,'installing');assert.equal(installing.revision,2)
 const {superseded,successor}=await loads.upgrade(owner,{requestId:randomUUID(),loadId:load.id,candidateContentId:candidate.id,expectedMappingHash:load.mappingHash,
  choices:{resources:{gone:'detach',note:'candidate'},roles:{},relations:'keep',entrypoints:'keep',positioning:'keep'}})
 assert.equal(superseded.status,'superseded')
 assert.equal(successor.items.find(item=>item.localId==='viz')?.carriedFrom,instanceOf(load,'viz'))
 // 沿用到活跃加载的插件仍可核对：状态确有变化时修订递增，实例本身仍留在被替代的加载上。
 observed='installed-active'
 const reconciled=await plugins.reconcile(owner,{instanceId:viz.id})
 assert.equal(reconciled.state,'active');assert.equal(reconciled.revision,3);assert.equal(reconciled.loadId,load.id)
 assert.equal((await loads.get(owner,{loadId:successor.id})).items.find(item=>item.localId==='viz')?.status,'active')
 // 同一状态再核对不写库、不动修订。
 assert.deepEqual(await plugins.reconcile(owner,{instanceId:viz.id}),reconciled)
 assert.equal((await pool.query('select revision from teloa_industry_plugin_instances where id=$1',[viz.id])).rows[0].revision,3)
 // 被移除并解除的插件不在放行范围内：核对一律拒绝，状态与修订都不变。
 const before=(await pool.query('select state,revision from teloa_industry_plugin_instances where id=$1',[gone.id])).rows[0]
 assert.equal(before.state,'detached')
 await assert.rejects(plugins.reconcile(owner,{instanceId:gone.id}),{code:'teloa/conflict',message:'行业模板已卸载或已被升级替代，不能继续操作。'})
 assert.deepEqual((await pool.query('select state,revision from teloa_industry_plugin_instances where id=$1',[gone.id])).rows[0],before)
})

test('升级和卸载先等待配置锁再取加载行锁，受管范围禁止市场修改',async()=>{
 const {lockBusinessConfiguration}=await import('../src/work/business-configuration-lock.ts')
 for(const operation of ['upgrade','unload'] as const){
  const f=await prepare(),db=await pool.connect()
  await db.query('begin');await lockBusinessConfiguration(db,f.owner,f.load.scope)
  await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope=$2',[f.owner,f.load.scope])
  const pid=Number((await db.query('select pg_backend_pid() pid')).rows[0].pid)
  const work=operation==='upgrade'?f.loads.upgrade(f.owner,command(f)):f.loads.unload(f.owner,{requestId:randomUUID(),loadId:f.load.id,expectedMappingHash:f.load.mappingHash})
  const pending=work.then(value=>({value}),error=>({error}))
  try{
   let blocked=false;const deadline=Date.now()+5000
   while(Date.now()<deadline){
    if((await pool.query("select 1 from pg_stat_activity where wait_event='advisory' and $1=any(pg_blocking_pids(pid))",[pid])).rowCount){blocked=true;break}
    await new Promise<void>(resolve=>setImmediate(resolve))
   }
   assert.equal(blocked,true,operation+' 必须先等待配置锁')
   await db.query('select id from teloa_industry_loads where id=$1 for update nowait',[f.load.id])
   await db.query('commit')
   const result=await pending
   assert.ok('error' in result);assert.equal(result.error.code,'teloa/conflict')
   await untouched(f)
  }finally{await db.query('rollback');db.release();await pending}
 }
})

test('升级固定来源的scope不一致时拒绝，不能持加载行锁再取另一个范围锁',async()=>{
 const f=await prepare(),original=createIndustryLoadSource(f.market)
 const loads=new IndustryLoadService(pool,identity,{...original,read:async(...args)=>({...await original.read(...args),scope:'other-scope'})})
 await assert.rejects(loads.upgrade(f.owner,command(f)),{code:'teloa/source-unavailable'})
 await untouched(f)
})
