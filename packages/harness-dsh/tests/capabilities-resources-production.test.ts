import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime,defineTool} from '@deepseek-ai/dsh-tools'
import {SkillRegistry,type SkillViewOptions} from '@deepseek-ai/dsh-skill'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {BusinessSpaceService,BusinessScopeService,ConversationService,FileConversationRepository,openResourceDatabase,type ResourceActor} from '@teloa/backend'
import {promptFullTextMaxBytes,type CapabilitySnapshot,type Conversation,type ResourceDirectory,type SourceReference} from '@teloa/contract'
import {stopTestContainer} from '../../backend/tests/postgres-test-lifecycle.ts'
import {apply} from '../src/index.ts'
import {registerResources} from '../src/resources.ts'
import {host} from './fixtures/production-host.ts'

const owner='local:teloa-owner',identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('目录查询不得读取技能正文或执行外部工具。')}

test('E04：正式能力 RPC 与资料只读工具使用当前会话的目录边界',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-capabilities-resources-')),runtime=host({agents:true}),preset=new Context(),tools=new Context()
 const previousRoot=process.env.TELOA_PROJECT_ROOT
 let container:StartedPostgreSqlContainer|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 t.after(async()=>{
  await tools.fiber.dispose();await preset.fiber.dispose();await runtime.ctx.fiber.dispose();await database?.close();await stopTestContainer(container)
  if(previousRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=previousRoot
  await rm(root,{recursive:true,force:true})
 })
 process.env.TELOA_PROJECT_ROOT=process.cwd()
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const config=join(root,'.runtime/teloa/database.json')
 await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true})
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true})
 await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 await runtime.ready(join(root,'.runtime/dsh'));await apply(runtime.ctx,{projectRoot:root})
 database=await openResourceDatabase(config,identity)
 const db=database,actor:ResourceActor={ownerId:owner,kind:'human',scopeIds:['general','SOC','AppSec']}
 const space=await new BusinessSpaceService(db.pool,identity).current(owner)
 for(const scope of ['SOC','AppSec'])await BusinessScopeService.ensure(db.pool,owner,{scope,title:scope,kind:'builtin',spaceId:space.id})
 const seed=async(title:string,scopeIds:string[],options:{ownerId?:string;draftOnly?:boolean;withdraw?:boolean;markdown?:string}={})=>{
  const principal={...actor,ownerId:options.ownerId??owner}
  const knowledge=await db.knowledge.createPaste(principal,{requestId:randomUUID(),title,category:'sop',topics:[],scopeIds,markdown:options.markdown??'# 合成资料\n正文不应进入目录：'+title})
  const draft=await db.service.create(principal,{requestId:randomUUID(),title,scopeIds,sourceId:'knowledge_'+knowledge.item.id,sourceVersion:knowledge.version.contentHash})
  const resource=options.draftOnly?undefined:await db.service.apply(principal,{draftId:draft.id,expectedVersion:draft.version})
  if(options.withdraw&&resource)await db.service.withdraw(principal,{resourceId:resource.id,expectedVersion:resource.version})
  return {knowledge,draft,resource}
 }
 const general=await seed('通用已确认',['general']),soc=await seed('SOC 已确认',['SOC']),appsec=await seed('AppSec 已确认',['AppSec'])
 const shared=await seed('同时要求两范围',['SOC','AppSec']),draft=await seed('仅草案',['general'],{draftOnly:true}),withdrawn=await seed('已撤回',['general'],{withdraw:true})
 const large=await seed('仅检索大资料',['general'],{markdown:'# 大资料\n'+'x'.repeat(promptFullTextMaxBytes+1)})
 const foreign=await seed('其他本人私有资料',['general'],{ownerId:'foreign-owner'})
 const fixtures=[general,soc,appsec,shared,draft,withdrawn,large,foreign]
 const ownId=SessionId(randomUUID()),fallbackId=SessionId(randomUUID()),foreignId=SessionId(randomUUID())
 const cwd=join(root,'selected-workspace');await mkdir(cwd)
 const {agent}=await runtime.ctx.agents.create({sessionId:ownId,meta:{cwd},agentOptions:{provider:'test',model:'test'}})
 await runtime.ctx.agents.create({sessionId:fallbackId,meta:{cwd:root},agentOptions:{provider:'test',model:'test'}})
 await runtime.ctx.agents.create({sessionId:foreignId,meta:{cwd},agentOptions:{provider:'test',model:'test'}})
 for(const sessionId of [ownId,fallbackId])assert.equal((await runtime.rpc('conversations/ensure',{sessionId},AbortSignal.timeout(5000))).ok,true)
 const conversations=new ConversationService(new FileConversationRepository(join(root,'.runtime/teloa/conversations.json')),{create:unavailable,inspect:async()=>{}},identity)
 await conversations.ensure('foreign-owner',{sessionId:foreignId})
 for(const plugin of [SystemPrompt,ToolRuntime,SkillRegistry])await preset.plugin(plugin)
 const skillLookups:SkillViewOptions[]=[]
 preset.skills.registerProvider(()=>({name:'fixture-workspace',list:async options=>{
  skillLookups.push(options)
  return options.cwd===cwd?[{name:'selected-workspace-skill',description:'当前工作区技能',source:'project-dsh',provider:'fixture-workspace',rank:0,locator:'fixture',invocation:{modelInvocable:false,userInvocable:true}}]:[]
 },get:unavailable}))
 preset.skills.register({name:'internal-creator',description:'内置管理能力',source:'runtime',provider:'teloa-builtin',content:'不得回显的技能正文'})
 runtime.ctx.skills.register({name:'root-fallback-skill',description:'根提供方技能',source:'runtime',content:'根技能正文'})
 for(const [ctx,name] of [[preset,'mcp__selected__read'],[preset,'non_mcp_selected'],[runtime.ctx,'mcp__root__read']] as const)ctx.tools.register(defineTool({name,description:name,parameters:{},output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},execute:unavailable}))
 // production-host 的 preset 公共查找端口确定性选路；技能/工具注册表是真实官方实现。
 // 不宣称此夹具验证了官方 preset Loader 的启动、模型或远端 MCP 连通性。
 const originalServiceFor=runtime.ctx.agentPresets.serviceFor
 runtime.ctx.agentPresets.serviceFor=((target:unknown,name:string)=>target===agent?(name==='skills'?preset.skills:name==='tools'?preset.tools:undefined):undefined) as typeof originalServiceFor
 const readCapabilities=async(sessionId=ownId)=>{
  const reply=await runtime.rpc('capabilities/read',{sessionId},AbortSignal.timeout(10000))
  assert.equal(reply.ok,true,JSON.stringify(reply));return reply.value as CapabilitySnapshot
 }
 const noBodies=(value:unknown)=>{
  const serialized=JSON.stringify(value)
  for(const item of fixtures)assert.equal(serialized.includes(JSON.stringify(item.knowledge.version.markdown).slice(1,-1)),false,'目录不得返回完整资料正文')
  assert.equal(serialized.includes('正文不应进入目录：'),false,'目录不得返回正文片段')
  assert.equal(serialized.includes('不得回显的技能正文'),false)
 }

 await t.test('实际 RPC 按当前 Agent 的 preset/cwd 聚合目录，隐藏内置技能与非 MCP 工具',async()=>{
  const snapshot=await readCapabilities()
  assert.equal(snapshot.schema,'teloa.capabilities/v1');assert.equal(snapshot.conversation.sessionId,ownId)
  assert.deepEqual(snapshot.skills,[{name:'selected-workspace-skill',description:'当前工作区技能',source:'project-dsh',provider:'fixture-workspace',modelInvocable:false,userInvocable:true}])
  assert.equal(skillLookups.at(-1)?.cwd,cwd);assert.equal(skillLookups.at(-1)?.scope,agent)
  assert.deepEqual(snapshot.connections,{status:'observed',tools:[{name:'mcp__selected__read',description:'mcp__selected__read'}]})
  assert.deepEqual(snapshot.writes,{status:'draft-only'});assert.equal(snapshot.knowledge.status,'ready')
  if(snapshot.knowledge.status!=='ready')throw Error('资料目录未就绪')
  assert.deepEqual(snapshot.knowledge.resources.map(row=>row.id),[general.resource!.id],'草案、撤回、超预算、他范围和他本人不进入引用候选')
  noBodies(snapshot)
  const fallback=await readCapabilities(fallbackId)
  assert.ok(fallback.skills.some(row=>row.name==='root-fallback-skill'))
  if(fallback.connections.status!=='observed')throw Error('根连接目录未完成观察')
  assert.ok(fallback.connections.tools.some(row=>row.name==='mcp__root__read'))
  assert.equal(fallback.skills.some(row=>row.name==='selected-workspace-skill'),false)
 })

 await t.test('实际 RPC 拒绝他本人、未绑定会话与伪造主体参数',async()=>{
  for(const [payload,code] of [[{sessionId:foreignId},'teloa/forbidden'],[{sessionId:randomUUID()},'teloa/not-bound'],[{sessionId:ownId,ownerId:'foreign-owner'},'teloa/invalid-input']] as const){
   const before=skillLookups.length,reply=await runtime.rpc('capabilities/read',payload,AbortSignal.timeout(10000))
   assert.equal(reply.ok,false);assert.equal(reply.error?.code,code);assert.equal(skillLookups.length,before,'身份拒绝先于技能查询');noBodies(reply)
  }
 })

 await t.test('真实资料存储损坏降为 unavailable，仍返回技能/连接且不回显存储内容',async()=>{
  const row=(await db.pool.query('select spec from teloa_resources where id=$1',[general.resource!.id])).rows[0] as {spec:unknown}
  try{
   await db.pool.query('update teloa_resources set spec=$2 where id=$1',[general.resource!.id,JSON.stringify({title:123,privateFixture:'目录中不可回显此存储原文'})])
   const snapshot=await readCapabilities()
   assert.equal(snapshot.knowledge.status,'unavailable')
   assert.deepEqual(snapshot.skills.map(item=>item.name),['selected-workspace-skill'])
   if(snapshot.connections.status!=='observed')throw Error('资料不可用时连接目录仍应可观察')
   assert.deepEqual(snapshot.connections.tools.map(item=>item.name),['mcp__selected__read'])
   assert.equal(JSON.stringify(snapshot).includes('目录中不可回显此存储原文'),false);noBodies(snapshot)
  }finally{await db.pool.query('update teloa_resources set spec=$2 where id=$1',[general.resource!.id,JSON.stringify(row.spec)])}
 })

 for(const plugin of [LlmRuntime,SystemPrompt,ToolRuntime,SessionStore,SessionProjectionRegistry,AgentRegistry])await tools.plugin(plugin)
 await tools.plugin(AgentLoop,{agents:[]})
 const socId=SessionId(randomUUID()),appsecId=SessionId(randomUUID()),unboundId=SessionId(randomUUID())
 const agents=await Promise.all([socId,appsecId,foreignId,unboundId].map(sessionId=>tools.agents.create({sessionId,meta:{cwd:root},agentOptions:{provider:'unused',model:'unused'}})))
 await conversations.ensure(owner,{sessionId:socId});await conversations.ensure(owner,{sessionId:appsecId})
 // 普通文件目录目前只登记 general。范围标签由可信绑定端口夹具提供，归属/绑定仍经过真实 ConversationService。
 const scopes=new Map<string,string[]>([[socId,['general','SOC']],[appsecId,['general','AppSec']]])
 const scopedConversations={bySession:async(caller:string,id:string)=>{
  const bound=await conversations.bySession(caller,id)
  return {...bound,scopeIds:scopes.get(id)??bound.scopeIds} as Conversation&{status:'ready'}
 }} as ConversationService
 const resources=registerResources(tools,root,owner,scopedConversations,unavailable)
 const call=(name:string,index:number|undefined,args:Record<string,unknown>={})=>tools.tools.execute({name,arguments:args,callId:ToolCallId(randomUUID()),...(index===undefined?{}:{agent:agents[index]!.agent}),signal:AbortSignal.timeout(10000)})
 const counts=async()=>{
  const result=await db.pool.query('select (select count(*)::int from teloa_resources) resources,(select count(*)::int from teloa_resource_drafts) drafts,(select count(*)::int from teloa_message_snapshots) snapshots,(select count(*)::int from teloa_resource_reads) reads,(select count(*)::int from teloa_business_scopes) scopes')
  return result.rows[0]
 }
 await t.test('官方 ToolRuntime 执行两目录工具：仅采用绑定范围，查询不新增范围/引用/草案',async()=>{
  const before=await counts(),human=await resources.handle('resources/list',{}) as ResourceDirectory
  assert.ok(human.resources.some(row=>row.id===soc.resource!.id)&&human.resources.some(row=>row.id===appsec.resource!.id),'本人管理目录同时拥有两范围，不能替代 Agent 目录')
  for(const [index,allowed,denied] of [[0,soc,appsec],[1,appsec,soc]] as const){
   const listed=await call('teloa_resources_list',index);assert.equal(listed.isError,false,JSON.stringify(listed))
   const directory=JSON.parse(listed.value as string) as ResourceDirectory
   assert.deepEqual(directory.resources.map(row=>row.id).sort(),[general.resource!.id,allowed.resource!.id,withdrawn.resource!.id,large.resource!.id].sort())
   assert.deepEqual(directory.drafts.map(row=>row.id).sort(),[general.draft.id,allowed.draft.id,draft.draft.id,withdrawn.draft.id,large.draft.id].sort())
   assert.equal(directory.resources.some(row=>row.id===denied.resource!.id||row.id===shared.resource!.id||row.id===foreign.resource!.id),false)
   const sources=await call('teloa_resources_sources',index);assert.equal(sources.isError,false,JSON.stringify(sources))
   const references=JSON.parse(sources.value as string) as SourceReference[]
   assert.deepEqual(references.filter(row=>row.id.startsWith('knowledge_')).map(row=>row.id).sort(),[general,allowed,draft,withdrawn,large].map(item=>'knowledge_'+item.knowledge.item.id).sort())
   noBodies(directory);noBodies(references)
  }
  assert.deepEqual(await counts(),before,'目录查询不创建业务范围、资源、草案、消息快照或资料使用记录')
 })

 await t.test('官方 ToolRuntime 拒绝他本人/未绑定/无 Agent/伪造范围；拒绝不写业务表',async()=>{
  const before=await counts()
  for(const name of ['teloa_resources_list','teloa_resources_sources']){
   for(const index of [2,3,undefined]){
    const result=await call(name,index)
    assert.equal(result.isError,true,JSON.stringify(result));assert.equal(JSON.stringify(result).includes(foreign.knowledge.item.title),false)
   }
   for(const args of [{ownerId:'foreign-owner'},{scopeIds:['general','SOC','AppSec']}]){
    const result=await call(name,0,args)
    assert.equal(result.isError,true,JSON.stringify(result));noBodies(result)
   }
  }
  assert.deepEqual(await counts(),before)
 })
 assert.deepEqual(runtime.modelCalls,[],'本补验不调用真实或脚本模型')
})
