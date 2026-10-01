/** 生产 apply + 真实 Cordis Agent/Tools/Approval/JSONL/PG；控制器只创建和读取真实 Agent，不调用模型。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {ToolCallId,createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,initializeBusinessSpaces,initializeBusinessScopes,initializeBusinessConversationBindings,initializeConversationWork,BusinessConversationBindingService,BusinessConfigurationDraftService,BusinessSpaceService,ConversationService,FileConversationRepository,ConversationWorkService,type BusinessConfigurationDraft} from '@teloa/backend'
import type {BusinessConversationBinding} from '@teloa/contract'
import {apply} from '../src/index.ts'
import {compositionEntries,type RpcHandler} from './fixtures/production-host.ts'
import {installNativeSessions,installNativeHostServices,ControlledPromptModel} from './fixtures/native-host-services.ts'
import {registerConversationWorkTools} from '../src/conversation-work-tools.ts'
import {readSessionEvents} from '../src/session-events.ts'

const officialRequire=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const official=(name:string)=>import(officialRequire.resolve('@deepseek-ai/'+name))

const owner='local:teloa-owner',read='teloa_business_builder_read',revise='teloa_business_builder_revise'
test('rc.1真实Controller/Query/JSONL/ProjectionCache/Workspace与只读PG：冷daily按用户活动，归档不恢复',{timeout:120000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-daily-official-')),ctx=new Context()
 let container:StartedPostgreSqlContainer|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined,readOnly:Awaited<ReturnType<typeof openResourceDatabase>>['pool']|undefined
 t.after(async()=>{await ctx.fiber.dispose();await readOnly?.end();await database?.pool.end();await container?.stop();await rm(root,{recursive:true,force:true})})
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start();const config=join(root,'database.json');await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 const identity={id:randomUUID,now:()=>new Date().toISOString()};database=await openResourceDatabase(config,identity);const pool=database.pool
 class CountingModel extends ControlledPromptModel{calls=0;override async *stream(){this.calls++;throw Error('不得调用模型')}}
 const model=new CountingModel()
 await installNativeSessions(ctx);await ctx.plugin(ToolRuntime);await installNativeHostServices(ctx,join(root,'native'));ctx.llm.registerAdapter(['controlled'],model)
 await ctx.plugin((await official('dsh-storage')).Storage);await ctx.plugin(await official('dsh-storage-json'),{root:join(root,'domains')});await ctx.plugin(await official('dsh-storage-domain'),{backend:'json'})
 await ctx.plugin((await official('dsh-workspace')).WorkspaceRegistry)
 await ctx.plugin((await official('dsh-session-query-sqlite')).SqliteSessionQueryEngine,{path:join(root,'query.sqlite'),openAt:'never'})
 await ctx.plugin((await official('dsh-session-projection-cache')).SessionProjectionCache,{writeEveryEvents:100,writeIntervalMs:60000})
 await ctx.plugin((await official('dsh-typert-registry')).default);await ctx.plugin((await official('dsh-api-gateway')).default)
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'controlled',model:'fixed'}),saveSelection:async()=>{}})
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})});ctx.provide('fs',{})
 await ctx.plugin((await official('dsh-api-session-controller')).SessionController,{nativeOpen:false})
 const query=Reflect.get(ctx,'sessionQuery') as {listSessions():Promise<Array<{live:boolean}>>}
 const owned=new Map<string,Awaited<ReturnType<typeof ctx.agents.create>>>(),repository=new FileConversationRepository(join(root,'conversations.json'))
 const conversations=new ConversationService(repository,{create:async id=>{const handle=await ctx.agents.create({sessionId:SessionId(id),meta:{cwd:root},agentOptions:{provider:'controlled',model:'fixed'}});owned.set(id,handle);return id},inspect:async id=>{assert.ok(owned.has(id))}},identity)
 await initializeBusinessSpaces(pool);await initializeBusinessScopes(pool);await initializeBusinessConversationBindings(pool);await initializeConversationWork(pool)
 const actor={ownerId:owner,scopeIds:['SOC']};await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const drafts=new BusinessConfigurationDraftService(pool,identity),contexts:ConversationWorkService=new ConversationWorkService(pool,identity.now,async(who,sessionId)=>({...await conversations.bySession(who,sessionId),submitted:readSessionEvents(owned.get(sessionId)!.agent.session).some(event=>event.type==='user/message'&&event.data.source.kind==='user')}),(who,sessionId)=>bindings.prepareWorkGuard(who,sessionId))
 const bindings:BusinessConversationBindingService=new BusinessConversationBindingService(pool,identity,{drafts,conversations,contexts})
 const create=async(title:string)=>{const requestId=randomUUID();await bindings.reserve(actor,{requestId,kind:'daily',scope:'SOC',title});const native=await conversations.create(owner,{requestId,title});await contexts.setContext(owner,{requestId,sessionId:native.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0});return bindings.bind(actor,{requestId,sessionId:native.sessionId})}
 const older=await create('先创建但最近使用'),newer=await create('后创建未使用'),agent=owned.get(older.sessionId!)!.agent
 agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'真实本人活动'}]}),{surfaceOp:'append'})
 await Reflect.get(ctx,'sessionProjectionCache').write(agent.session)
 assert.equal((await ctx.sessionController.list({},AbortSignal.timeout(5000))).items[0]!.sessionId,older.sessionId)
 for(const handle of owned.values())await handle.dispose()
 assert.equal(ctx.agents.list().length,0);assert.ok((await query.listSessions()).every(record=>!record.live))
 const directory=await ctx.sessionController.list({},AbortSignal.timeout(5000));assert.equal(directory.items[0]!.sessionId,older.sessionId);assert.equal(directory.items[0]!.agentAvailable,false)
 assert.equal(directory.items.find(item=>item.sessionId===newer.sessionId)!.blank,true)
 const {Pool}=createRequire(new URL('../../backend/package.json',import.meta.url))('pg') as {Pool:new(config:{connectionString:string;max:number;options:string})=>NonNullable<typeof database>['pool']}
 readOnly=new Pool({connectionString:container.getConnectionUri(),max:1,options:'-c default_transaction_read_only=on'})
 const cold=new BusinessConversationBindingService(readOnly,identity,{drafts,conversations,contexts:{context:async()=>{throw Error('不得激活context')}},visibleSessions:async signal=>{const {items}=await ctx.sessionController.list({},signal??AbortSignal.timeout(5000)),archived=new Set(ctx.workspaceRegistry.archivedSessionIds);return items.filter(item=>!archived.has(item.sessionId))}})
 const before=await repository.read()
 assert.equal((await cold.recentDaily(actor,{scope:'SOC'}))?.sessionId,older.sessionId)
 await ctx.workspaceRegistry.archiveSession(SessionId(older.sessionId!))
 // rc.1 list 本身仍包含归档；正式适配必须另读公开归档集合。
 assert.ok((await ctx.sessionController.list({},AbortSignal.timeout(5000))).items.some(item=>item.sessionId===older.sessionId))
 assert.equal((await cold.recentDaily(actor,{scope:'SOC'}))?.sessionId,newer.sessionId)
 await pool.query('update teloa_business_conversation_bindings set session_id=null where owner_id=$1 and request_id=$2',[owner,older.requestId])
 await assert.rejects(cold.recentDaily(actor,{scope:'SOC'}),{code:'teloa/conflict',details:{reason:'daily-session-unavailable'}})
 assert.equal(ctx.agents.list().length,0);assert.ok((await query.listSessions()).every(record=>!record.live));assert.deepEqual(await repository.read(),before)
 assert.ok(ctx.workspaceRegistry.archivedSessionIds.includes(SessionId(older.sessionId!)))
 let afterFreeze:((sessionId:string)=>Promise<void>)|undefined
 await t.test('真实prompt在pending消息commit前拒绝，恢复固定scope后不自动消费或重放',{timeout:10000},async()=>{
  let dispatches=0,pendingChecks=0
  registerConversationWorkTools(ctx,{owner,conversation:sessionId=>conversations.bySession(owner,sessionId),readTaskPolicy:async()=>null,isRoleConversation:async()=>false,isBuilder:sessionId=>bindings.isBuilder(owner,sessionId),isPendingDaily:sessionId=>{pendingChecks++;return bindings.isPendingDaily(owner,sessionId)},context:sessionId=>contexts.context(owner,{sessionId}),freeze:async sessionId=>{const value=await contexts.freeze(owner,{sessionId});await afterFreeze?.(sessionId);return value},scopes:async()=>['SOC'],roles:async()=>[],dispatch:async()=>{dispatches++;throw Error('不得派发')},status:async()=>null,stop:async()=>null,facts:async()=>null,data:async()=>null,now:identity.now})
  const requestId=randomUUID();await bindings.reserve(actor,{requestId,kind:'daily',scope:'SOC',title:'消息在恢复前到达'})
  const n=await conversations.create(owner,{requestId,title:'消息在恢复前到达'}),live=owned.get(n.sessionId)!.agent
  await ctx.sessionController.prompt({sessionId:SessionId(n.sessionId),requestId:randomUUID() as never,mode:'queue',content:[{type:'text',text:'请交办但预约尚未恢复'}]},AbortSignal.timeout(5000));await live.whenIdle()
  const before=readSessionEvents(live.session)
  assert.equal(pendingChecks,1,'真实原生循环已经进入pending守卫')
  assert.equal(before.filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,0,'pre-step拒绝发生在user/message commit之前')
  assert.ok(before.some(event=>event.type==='turn/end'&&event.data.reason.kind==='error'))
  assert.ok(before.some(event=>event.type==='agent/inbox/spliced'),'原始输入保留在原生inbox事件，不复制正文')
  assert.equal(model.calls,0);assert.equal(dispatches,0)
  assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_requests where owner_id=$1 and session_id=$2',[owner,n.sessionId])).rows[0].n,0)
  assert.equal((await bindings.bySession(actor,{sessionId:n.sessionId}))?.sessionId,undefined)
  const fixed={requestId,sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0}
  await contexts.setContext(owner,fixed)
  await bindings.bind(actor,{requestId,sessionId:n.sessionId});await live.whenIdle()
  assert.equal((await contexts.context(owner,{sessionId:n.sessionId}))?.scopeId,'SOC')
  assert.equal(model.calls,0);assert.equal(dispatches,0);assert.equal(readSessionEvents(live.session).length,before.length,'恢复不会再次消费或重放旧消息')
 })
 await t.test('R1 真实prompt在空context freeze后暂停：commit前后均不能首次改scope/role且读仍null',{timeout:10000},async()=>{
  const n=await conversations.create(owner,{requestId:randomUUID(),title:'未选业务的普通会话'}),live=owned.get(n.sessionId)!.agent
  let frozen!:()=>void,release!:()=>void
  const reached=new Promise<void>(resolve=>frozen=resolve),gate=new Promise<void>(resolve=>release=resolve)
  afterFreeze=async sessionId=>{if(sessionId===n.sessionId){frozen();await gate}}
  try{
   await ctx.sessionController.prompt({sessionId:SessionId(n.sessionId),requestId:randomUUID() as never,mode:'queue',content:[{type:'text',text:'直接询问未指定业务'}]},AbortSignal.timeout(5000))
   await reached
   assert.equal(readSessionEvents(live.session).filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,0)
   assert.equal(await contexts.context(owner,{sessionId:n.sessionId}),null)
   for(const roleId of [null,randomUUID()])await assert.rejects(contexts.setContext(owner,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId,expectedVersion:0}),{code:'teloa/conflict'})
   release();await live.whenIdle()
   assert.equal(readSessionEvents(live.session).filter(event=>event.type==='user/message'&&event.data.source.kind==='user').length,1)
   await assert.rejects(contexts.setContext(owner,{requestId:randomUUID(),sessionId:n.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0}),{code:'teloa/conflict'})
   assert.equal(await contexts.context(owner,{sessionId:n.sessionId}),null)
  }finally{release();afterFreeze=undefined;await live.whenIdle()}
 })
})
test('生产搭建工具与普通上下文隔离：真实注册、预约恢复、原生审批和daily兼容',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-builder-production-')),ctx=new Context(),priorRoot=process.env.TELOA_PROJECT_ROOT
 let container:StartedPostgreSqlContainer|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 t.after(async()=>{await ctx.fiber.dispose();await database?.pool.end();await container?.stop();if(priorRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=priorRoot;await rm(root,{recursive:true,force:true})})
 process.env.TELOA_PROJECT_ROOT=resolve(process.cwd());process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 // 宿主内部 pool 由生产 factory 创建；在真实 checkout 边界收紧容量，覆盖 role/task/resolveAgent 间接读取。
 type DatabasePool=Awaited<ReturnType<typeof openResourceDatabase>>['pool']
 const {Pool}=createRequire(new URL('../../backend/package.json',import.meta.url))('pg') as {Pool:{prototype:DatabasePool}}
 const connect=Pool.prototype.connect
 t.mock.method(Pool.prototype,'connect',function(this:DatabasePool,...args:unknown[]){this.options.max=1;this.options.connectionTimeoutMillis=1500;return Reflect.apply(connect,this,args)})
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const config=join(root,'.runtime/teloa/database.json');await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true});await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 ctx.provide('loader',compositionEntries());await installNativeSessions(ctx);await ctx.plugin(ToolRuntime);await installNativeHostServices(ctx,join(root,'.runtime/dsh'));ctx.llm.registerAdapter(['controlled'],new ControlledPromptModel())
 const workspaces=new Map<string,{id:string;path:string}>(),archived:string[]=[]
 ctx.provide('workspaceRegistry',{archivedSessionIds:archived,create:async(path:string)=>{const prior=[...workspaces.values()].find(item=>item.path===path);if(prior)return prior;const item={id:randomUUID(),path};workspaces.set(item.id,item);return item},get:(id:string)=>workspaces.get(id),list:()=>[...workspaces.values()]})
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'teloa-standard'})})
 ctx.provide('skills',{list:async()=>[],registerProvider:(factory:(control:{invalidate:()=>void;signal:AbortSignal})=>unknown)=>{factory({invalidate:()=>{},signal:new AbortController().signal});return ()=>{}}});ctx.provide('fs',{});ctx.provide('fileReferences',{})
 const visible:string[]=[]
 ctx.provide('sessionController',{
  list:async()=>({items:visible.map(sessionId=>({sessionId}))}),
  create:async(input:{sessionId?:string;agentPreset?:string;workspaceId?:string}={})=>{const sessionId=SessionId(input.sessionId??randomUUID());await ctx.agents.create({sessionId,meta:{cwd:workspaces.get(input.workspaceId??'')?.path??root,...(input.agentPreset?{agentPreset:input.agentPreset}:{})},agentOptions:{provider:'controlled',model:'fixed'}});visible.unshift(sessionId);return {sessionId,...(input.agentPreset?{agentPreset:input.agentPreset}:{})}},
  resolveAgent:async(id:string)=>{const agent=ctx.agents.get(SessionId(id));return agent?{agent}:{error:{code:'not-found',message:'missing'}}},
  inspect:async(id:string)=>{const agent=ctx.agents.get(SessionId(id));assert.ok(agent);return {sessionId:id,meta:agent.session.header,status:agent.status}},modelCatalog:async()=>({default:{provider:'controlled',model:'fixed'}}),
 })
 let rpc:RpcHandler|undefined;ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(_path:string,handler:RpcHandler)=>{rpc=handler;return ()=>{}}}})
 await apply(ctx,{projectRoot:root});database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()});const pool=database.pool
 const raw=(endpoint:string,payload:unknown)=>rpc!(endpoint,payload,AbortSignal.timeout(15000))
 const call=async<T>(endpoint:string,payload:unknown):Promise<T>=>{const reply=await raw(endpoint,payload);assert.equal(reply.ok,true,endpoint+': '+JSON.stringify(reply.error));return reply.value as T}
 const userTurn=(sessionId:string)=>{const agent=ctx.agents.get(SessionId(sessionId))!;agent.session.append('turn/start',{turn:0} as never);agent.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'请整理客户业务草案'}]}),{surfaceOp:'append'});return agent}
 const tool=(sessionId:string,name:string,args:Record<string,unknown>={})=>ctx.tools.execute({agent:ctx.agents.get(SessionId(sessionId))!,name,arguments:args,callId:ToolCallId(randomUUID()),signal:AbortSignal.timeout(15000)})
 const builder=async(title:string)=>{const request={requestId:randomUUID(),kind:'builder',title},reservation=await call<BusinessConversationBinding>('business-conversations/reserve',request),native=await call<{sessionId:string}>('conversations/create',{requestId:request.requestId,title});return {...native,reservation,request}}
 let approvals=0,decision:()=>Promise<'allowed-once'|'rejected'>=async()=> 'allowed-once'
 ctx.on('approval/request',async()=>{approvals++;return decision()})

 await t.test('生产工具注册可见，native ready未bind不进入ordinary上下文或正式交办',async()=>{
  assert.ok(ctx.tools.get(read),'生产入口必须注册read');assert.ok(ctx.tools.get(revise),'生产入口必须注册revise')
  const f=await builder('待恢复的业务')
  assert.deepEqual(await call('work-context/eligibility',{sessionId:f.sessionId}),{sessionId:f.sessionId,eligible:false,reason:'builder'})
  for(const scopeId of ['general','SOC'])assert.equal((await raw('work-context/set',{requestId:randomUUID(),sessionId:f.sessionId,scopeId,roleId:null,expectedVersion:0})).ok,false)
  assert.equal((await raw('work-context/read',{sessionId:f.sessionId})).ok,false)
  const agent=userTurn(f.sessionId),messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续搭建'}]})]
  const step=await ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:AbortSignal.timeout(15000)},async()=>({kind:'enter' as const,messages}))
  assert.equal(step.kind,'enter');if(step.kind==='enter')assert.ok(!step.messages.some(message=>message.source.kind==='plugin:teloa.work'))
  for(const [name,args] of [[read,{}],['teloa_work_directory',{}],['teloa_work_dispatch',{scope:'SOC',title:'禁止交办',goal:'禁止交办',roleId:randomUUID(),expectedRoleVersion:1}],['teloa_work_collect_reports',{scope:'SOC',title:'禁止汇报',goal:'禁止汇报'}]] as const)assert.equal((await tool(f.sessionId,name,args)).isError,true,name)
  assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_contexts where session_id=$1',[f.sessionId])).rows[0].n,0)
  assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_requests where session_id=$1',[f.sessionId])).rows[0].n,0)
 })
 await t.test('真实绑定后读取并一次原生审批修订，草案端点读到同一revision，旧工作工具仍禁用',async()=>{
  const f=await builder('原生客户业务');await call('business-conversations/bind',{requestId:f.request.requestId,sessionId:f.sessionId});userTurn(f.sessionId)
  const directory=await tool(f.sessionId,read);assert.equal(directory.isError,false,JSON.stringify(directory));assert.equal(JSON.parse(directory.value as string).draftId,f.reservation.draftId)
  const prior=approvals;assert.equal((await tool(f.sessionId,revise,{draftId:f.reservation.draftId,expectedRevision:1,patch:{title:'原生修订客户'}})).isError,false);assert.equal(approvals,prior+1)
  const draft=await call<BusinessConfigurationDraft>('business-configuration/draft',{sessionId:f.sessionId,draftId:f.reservation.draftId});assert.equal(draft.revision,2);assert.equal(draft.candidate.title,'原生修订客户')
  assert.equal((await tool(f.sessionId,'teloa_work_directory')).isError,true)
  assert.equal((await raw('work-context/set',{requestId:randomUUID(),sessionId:f.sessionId,scopeId:'general',roleId:null,expectedVersion:0})).ok,false)
 })
 await t.test('真实审批期间绑定被撤除，execute重新读取绑定拒绝修改',async()=>{
  const f=await builder('审批中的业务');await call('business-conversations/bind',{requestId:f.request.requestId,sessionId:f.sessionId});userTurn(f.sessionId)
  const prior=approvals
  decision=async()=>{await pool.query('delete from teloa_business_conversation_bindings where owner_id=$1 and request_id=$2',[owner,f.request.requestId]);return 'allowed-once'}
  try{assert.equal((await tool(f.sessionId,revise,{draftId:f.reservation.draftId,expectedRevision:1,patch:{title:'不得写入'}})).isError,true)}finally{decision=async()=> 'allowed-once'}
  assert.equal(approvals,prior+1)
  assert.equal((await pool.query('select revision from teloa_business_configuration_drafts where owner_id=$1 and id=$2',[owner,f.reservation.draftId])).rows[0].revision,1)
 })
 await t.test('旧ordinary及daily保留真实work-context路径，daily不能冒用builder工具',async()=>{
  const ordinary=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'普通工作'})
  assert.deepEqual(await call('work-context/eligibility',{sessionId:ordinary.sessionId}),{sessionId:ordinary.sessionId,eligible:true,reason:null})
  const ordinaryContext=await call<{scopeId:string}>('work-context/set',{requestId:randomUUID(),sessionId:ordinary.sessionId,scopeId:'general',roleId:null,expectedVersion:0});assert.equal(ordinaryContext.scopeId,'general')
  const ordinaryAgent=userTurn(ordinary.sessionId),messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'继续工作'}]})]
  const step=await ctx.waterfall('agent/pre-step',{agent:ordinaryAgent,messages,turn:1,step:1,signal:AbortSignal.timeout(15000)},async()=>({kind:'enter' as const,messages}))
  assert.equal(step.kind,'enter');if(step.kind==='enter')assert.ok(step.messages.some(message=>message.source.kind==='plugin:teloa.work'))
  assert.equal((await pool.query('select locked from teloa_conversation_work_contexts where session_id=$1',[ordinary.sessionId])).rows[0].locked,true)
  assert.equal((await tool(ordinary.sessionId,'teloa_work_directory')).isError,false);assert.equal((await tool(ordinary.sessionId,read)).isError,true)
  const request={requestId:randomUUID(),kind:'daily',title:'日常客户工作',scope:'SOC'};await call('business-conversations/reserve',request)
  const daily=await call<{sessionId:string}>('conversations/create',{requestId:request.requestId,title:request.title})
  await call('work-context/set',{requestId:randomUUID(),sessionId:daily.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0});await call('business-conversations/bind',{requestId:request.requestId,sessionId:daily.sessionId})
  assert.equal((await call<{eligible:boolean}>('work-context/eligibility',{sessionId:daily.sessionId})).eligible,true)
  assert.equal((await call<{scopeId:string}>('work-context/read',{sessionId:daily.sessionId})).scopeId,'SOC')
  userTurn(daily.sessionId);assert.equal((await tool(daily.sessionId,'teloa_work_directory')).isError,false);assert.equal((await tool(daily.sessionId,read)).isError,true)
 })
 await t.test('生产recent与pending daily恢复：同scope可设置，未bind两门拒绝，bound不可改投general',async()=>{
  const request={requestId:randomUUID(),kind:'daily',title:'待恢复日常',scope:'SOC'};const pending=await call<BusinessConversationBinding>('business-conversations/reserve',request)
  assert.deepEqual(await call('business-conversations/recent-daily',{scope:'SOC'}),pending)
  const native=await call<{sessionId:string}>('conversations/create',{requestId:request.requestId,title:request.title}),sessionId=native.sessionId
  assert.deepEqual(await call('business-conversations/by-session',{sessionId}),pending)
  assert.equal((await tool(sessionId,'teloa_work_directory')).isError,true)
  const agent=ctx.agents.get(SessionId(sessionId))!,messages=[createUserMessage({source:{kind:'user'},content:[{type:'text',text:'尚未恢复'}]})]
  await assert.rejects(ctx.waterfall('agent/pre-step',{agent,messages,turn:1,step:1,signal:AbortSignal.timeout(15000)},async()=>({kind:'enter' as const,messages})),{code:'teloa/binding-pending'})
  assert.equal((await raw('work-context/set',{requestId:randomUUID(),sessionId,scopeId:'general',roleId:null,expectedVersion:0})).ok,false)
  await call('work-context/set',{requestId:request.requestId,sessionId,scopeId:'SOC',roleId:null,expectedVersion:0})
  const bound=await call('business-conversations/bind',{requestId:request.requestId,sessionId})
  assert.deepEqual(await call('business-conversations/recent-daily',{scope:'SOC'}),bound)
  assert.equal((await raw('work-context/set',{requestId:randomUUID(),sessionId,scopeId:'general',roleId:null,expectedVersion:1})).ok,false)
  assert.equal((await call<{scopeId:string}>('work-context/read',{sessionId})).scopeId,'SOC')
  assert.equal((await tool(sessionId,'teloa_work_directory')).isError,false)
  archived.push(sessionId);assert.notEqual((await call<BusinessConversationBinding|null>('business-conversations/recent-daily',{scope:'SOC'}))?.sessionId,sessionId)
  await pool.query('update teloa_business_conversation_bindings set session_id=null where owner_id=$1 and request_id=$2',[owner,request.requestId])
  const hidden=await raw('business-conversations/recent-daily',{scope:'SOC'});assert.equal(hidden.ok,false);assert.equal((hidden.error as {details?:{reason?:string}}).details?.reason,'daily-session-unavailable')
 })
 await t.test('工具端口采用后即时刷新scope授权，继续读取同一已保存业务而不另建',async()=>{
  const f=await builder('即时授权的业务');await call('business-conversations/bind',{requestId:f.request.requestId,sessionId:f.sessionId});userTurn(f.sessionId)
  const draft=await call<BusinessConfigurationDraft>('business-configuration/draft',{sessionId:f.sessionId,draftId:f.reservation.draftId})
  const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'位',lead:'跟进客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'}]}
  const page={id:'customers',title:'客户',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}
  assert.equal((await tool(f.sessionId,revise,{draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page],homePageId:page.id}})).isError,false)
  const preview=await call<{receipt:string}>('business-configuration/preview',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2})
  await call('business-configuration/apply',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2,expectedBaseVersion:0,requestId:randomUUID(),previewReceipt:preview.receipt})
  const result=await tool(f.sessionId,read);assert.equal(result.isError,false,JSON.stringify(result));const current=JSON.parse(result.value as string)
  assert.equal(current.draftId,draft.id);assert.equal(current.status,'applied');assert.equal(current.scope,draft.scope)
  assert.equal((await pool.query('select count(*)::int n from teloa_business_conversation_bindings where owner_id=$1 and request_id=$2',[owner,f.request.requestId])).rows[0].n,1)
 })

 await t.test('生产记录工具沿真实业务与页面共用快照；官方确认、原轮幂等与新轮发现原回执',async()=>{
  const recordRead='teloa_business_records_read',recordWrite='teloa_business_records_write'
  assert.ok(ctx.tools.get(recordRead),'生产入口必须注册真实本地记录读取工具')
  assert.ok(ctx.tools.get(recordWrite),'生产入口必须注册真实本地记录写工具')
  const f=await builder('日常维护客户');await call('business-conversations/bind',{requestId:f.request.requestId,sessionId:f.sessionId});userTurn(f.sessionId)
  const draft=await call<BusinessConfigurationDraft>('business-configuration/draft',{sessionId:f.sessionId,draftId:f.reservation.draftId}),scope=draft.scope
  const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'跟进客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'},{name:'note',label:'备注',type:'text',required:false,from:'备注'}]}
  const page={id:'customers',title:'客户',kind:'records',objectType:'customer',fields:['name','note'],allowCreate:true,allowEdit:true,allowArchive:true}
  assert.equal((await tool(f.sessionId,revise,{draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page],homePageId:page.id}})).isError,false)
  const preview=await call<{receipt:string}>('business-configuration/preview',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2})
  await call('business-configuration/apply',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2,expectedBaseVersion:0,requestId:randomUUID(),previewReceipt:preview.receipt})
  assert.equal((await tool(f.sessionId,recordRead)).isError,true,'搭建会话不能借记录工具改正式数据')
  const request={requestId:randomUUID(),kind:'daily',title:'客户日常',scope};await call('business-conversations/reserve',request)
  const native=await call<{sessionId:string}>('conversations/create',{requestId:request.requestId,title:request.title}),sessionId=native.sessionId
  userTurn(sessionId);assert.equal((await tool(sessionId,recordRead)).isError,true,'未绑定日常不可读写')
  // 原生未实际消费工具轮次前恢复固定归属；上面的手工事件只用于测试身份，清楚保持不走真实模型。
  const agent=ctx.agents.get(SessionId(sessionId))!
  const pendingEvents=readSessionEvents(agent.session)
  assert.ok(pendingEvents.some(event=>event.type==='user/message'))
  // 新建另一个完整日常，避免把已手工追加本人事件的pending会话当未发送会话恢复。
  const readyRequest={requestId:randomUUID(),kind:'daily',title:'可用客户日常',scope};await call('business-conversations/reserve',readyRequest)
  const ready=await call<{sessionId:string}>('conversations/create',{requestId:readyRequest.requestId,title:readyRequest.title}),daily=ready.sessionId
  await call('work-context/set',{requestId:readyRequest.requestId,sessionId:daily,scopeId:scope,roleId:null,expectedVersion:0});await call('business-conversations/bind',{requestId:readyRequest.requestId,sessionId:daily})
  const freshTurn=(text:string)=>{const a=ctx.agents.get(SessionId(daily))!;a.session.append('turn/start',{turn:0} as never);a.session.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text}]}),{surfaceOp:'append'});return a}
  freshTurn('新增客户甲和客户乙，分别备注下周联系和试用中')
  const directory=await tool(daily,recordRead);assert.equal(directory.isError,false,JSON.stringify(directory));assert.equal(JSON.parse(directory.value as string).types.find((row:{type:string})=>row.type==='customer').title,'客户')
  const operations=['甲','乙'].map((name,index)=>({operation:'create',type:'customer',title:'客户'+name,summary:'',fields:[{name:'name',value:name},{name:'note',value:index===0?'下周联系':'试用中'}]}))
  const count=async()=>Number((await pool.query('select count(*) n from teloa_business_record_heads where owner_id=$1 and scope_id=$2',[owner,scope])).rows[0].n)
  decision=async()=> 'rejected';const rejected=await tool(daily,recordWrite,{operations});decision=async()=> 'allowed-once'
  assert.equal(rejected.isError,true);assert.equal(await count(),0)
  const prior=approvals,result=await tool(daily,recordWrite,{operations});assert.equal(result.isError,false,JSON.stringify(result));assert.equal(approvals,prior+1)
  const receipt=JSON.parse(result.value as string);assert.equal(await count(),2);assert.equal(receipt.items.length,2)
  const duplicate=await tool(daily,recordWrite,{operations});assert.equal(duplicate.isError,false);assert.equal(JSON.parse(duplicate.value as string).requestId,receipt.requestId);assert.equal(await count(),2)
  assert.equal((await tool(daily,recordWrite,{operations:[{...operations[0],title:'同轮变更'}]})).isError,true);assert.equal(await count(),2)
  const listed=await call<{items:Array<{id:string;version:number;fields:Array<{label:string;value:string}>}>}>('business-records/list',{scope,type:'customer',limit:20});assert.equal(listed.items.length,2)
  const customer=listed.items.find(row=>row.fields.some(field=>field.label==='姓名'&&field.value==='甲'))!
  assert.ok(customer)
  freshTurn('客户甲的姓名改为甲一，备注保留')
  const current=await tool(daily,recordRead,{mode:'get',type:'customer',id:customer.id});assert.equal(current.isError,false)
  assert.ok(JSON.parse(current.value as string).values.some((field:{name:string;value:string})=>field.name==='note'&&field.value==='下周联系'))
  const edit=await tool(daily,recordWrite,{operations:[{operation:'edit',type:'customer',id:customer.id,expectedVersion:1,fields:[{name:'name',value:'甲一'},{name:'note',value:'下周联系'}]}]});assert.equal(edit.isError,false,JSON.stringify(edit))
  const edited=await call<{version:number;fields:Array<{label:string;value:string}>}>('business-records/get',{scope,type:'customer',id:customer.id});assert.equal(edited.version,2);assert.ok(edited.fields.some(field=>field.label==='备注'&&field.value==='下周联系'))
  freshTurn('归档客户甲，保留历史记录')
  const archived=await tool(daily,recordWrite,{operations:[{operation:'archive',type:'customer',id:customer.id,expectedVersion:2}]});assert.equal(archived.isError,false,JSON.stringify(archived))
  const remaining=await call<{items:unknown[]}>('business-records/list',{scope,type:'customer',limit:20});assert.equal(remaining.items.length,1)
  const historical=await call<{version:number}>('business-records/get',{scope,type:'customer',id:customer.id,version:1});assert.equal(historical.version,1)
  freshTurn('核对先前保存的客户，不要重复新增')
  const discovered=await tool(daily,recordRead,{mode:'recent-writes'});assert.equal(discovered.isError,false);const recent=JSON.parse(discovered.value as string);assert.ok(recent.items.some((row:{requestId:string})=>row.requestId===receipt.requestId));assert.equal(await count(),2)
  const fixed=await tool(daily,recordRead,{mode:'receipt',requestId:receipt.requestId});assert.equal(fixed.isError,false);assert.equal(JSON.parse(fixed.value as string).items.length,2)
  const ordinary=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'同业务另一会话'})
  await call('work-context/set',{requestId:randomUUID(),sessionId:ordinary.sessionId,scopeId:scope,roleId:null,expectedVersion:0});userTurn(ordinary.sessionId)
  const separate=await tool(ordinary.sessionId,recordRead,{mode:'recent-writes'});assert.equal(separate.isError,false);assert.deepEqual(JSON.parse(separate.value as string).items,[])
  const other=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'另一业务'})
  await call('work-context/set',{requestId:randomUUID(),sessionId:other.sessionId,scopeId:'SOC',roleId:null,expectedVersion:0});userTurn(other.sessionId)
  assert.equal((await tool(other.sessionId,recordRead,{mode:'receipt',requestId:receipt.requestId})).isError,true,'原回执不扩展当前业务授权')
 })

})
