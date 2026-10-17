import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import {brandString} from '@deepseek-ai/dsh-brand'
import type {GenerateOptions,StreamChunk} from '@deepseek-ai/dsh-llm'
import type {SessionRequestId} from '@deepseek-ai/dsh-api-session-controller'
import type {AgentHandle} from '@deepseek-ai/dsh-agent'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,RoleService,ConversationWorkService,TaskRunService,ConversationService,FileConversationRepository,workRequestChildId} from '@teloa/backend'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'
import {apply} from '../src/index.ts'
import {conversationWorkRequestId} from '../src/conversation-work-instruction.ts'
import {compositionEntries,type RpcHandler} from './fixtures/production-host.ts'
import {installNativeSessions,installNativeHostServices,installNativeSessionController,ControlledPromptModel} from './fixtures/native-host-services.ts'
import {readSessionEvents} from '../src/session-events.ts'

const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),official=(name:string)=>import(require.resolve('@deepseek-ai/'+name))
test('完整生产装配+PG：结束自动task v3的原冷Run显式重试，不以历史skillScope当前授权阻断',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-run-retry-production-')),ctx=new Context(),priorRoot=process.env.TELOA_PROJECT_ROOT
 let container:StartedPostgreSqlContainer|undefined,database:Awaited<ReturnType<typeof openResourceDatabase>>|undefined
 t.after(async()=>{await ctx.fiber.dispose();await database?.pool.end();await container?.stop();if(priorRoot===undefined)delete process.env.TELOA_PROJECT_ROOT;else process.env.TELOA_PROJECT_ROOT=priorRoot;await rm(root,{recursive:true,force:true})})
 process.env.TELOA_PROJECT_ROOT=resolve(process.cwd());process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 const config=join(root,'.runtime/teloa/database.json');await mkdir(join(root,'.runtime/teloa/skills'),{recursive:true});await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 await mkdir(join(root,'.runtime/dsh/profiles/teloa'),{recursive:true});await writeFile(join(root,'.runtime/dsh/profiles/teloa/package.json'),JSON.stringify({dsh:{profile:{bundles:[],patchReload:'startup'}}}))
 ctx.provide('loader',compositionEntries());await installNativeSessions(ctx);await installNativeHostServices(ctx,join(root,'.runtime/dsh'))
 // calls 只数被测 Run 的模型请求；承载原始人类消息的父会话固定回复一句，不计入。
 class BeforeOutputFailure extends ControlledPromptModel{
  calls=0;parent=''
  override async *stream(options?:GenerateOptions):AsyncIterable<StreamChunk>{
   if(options&&String(options.sessionId)===this.parent){const text='已收到原交办。';yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text};yield {type:'block-end',index:0,block:{type:'text',text}};yield {type:'finish',reason:{kind:'stop'}};return}
   this.calls++;throw Error('合成模型首输出前失败')
  }
 }
 const model=new BeforeOutputFailure();ctx.llm.registerAdapter(['controlled'],model)
 await ctx.plugin((await official('dsh-storage')).Storage);await ctx.plugin(await official('dsh-storage-json'),{root:join(root,'domains')});await ctx.plugin(await official('dsh-storage-domain'),{backend:'json'})
 await ctx.plugin((await official('dsh-workspace')).WorkspaceRegistry)
 await ctx.plugin((await official('dsh-session-query-sqlite')).SqliteSessionQueryEngine,{path:join(root,'query.sqlite'),openAt:'never'})
 await ctx.plugin((await official('dsh-session-projection-cache')).SessionProjectionCache,{writeEveryEvents:100,writeIntervalMs:60000})
 await ctx.plugin((await official('dsh-typert-registry')).default);await ctx.plugin((await official('dsh-api-gateway')).default)
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'controlled',model:'fixed'}),saveSelection:async()=>{}})
 // 仅固定模型元数据和空预设；会话、控制器、循环、准入、后台/Team及所有业务端口均走生产实现。
 ctx.provide('agentPresets',{serviceFor:()=>undefined,mount:async()=>{},acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'teloa-standard'})})
 ctx.sessionProjections.register((await official('dsh-agent-preset-registry')).agentPresetProjectionDefinition)
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})});ctx.provide('fileReferences',{})
 await ctx.plugin((await official('dsh-api-remote-access')).RemoteAccessService)
 await installNativeSessionController(ctx,{nativeOpen:false})
 const createErrors:string[]=[],controllerCreate=ctx.sessionController.create.bind(ctx.sessionController)
 t.mock.method(ctx.sessionController,'create',async(...args:Parameters<typeof controllerCreate>)=>{try{return await controllerCreate(...args)}catch(error){createErrors.push(error instanceof Error?error.stack??error.message:String(error));throw error}})
 const handles=new Map<string,AgentHandle>(),create=ctx.agents.create.bind(ctx.agents)
 t.mock.method(ctx.agents,'create',async(...args:Parameters<typeof create>)=>{const handle=await create(...args);handles.set(handle.agent.id,handle);return handle})
 let rpc:RpcHandler|undefined;ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(_path:string,handler:RpcHandler)=>{rpc=handler;return ()=>{}}}})
 await apply(ctx,{projectRoot:root});database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()});const pool=database.pool,owner='local:teloa-owner',identity={id:randomUUID,now:()=>new Date().toISOString()}
 const call=async<T>(endpoint:string,payload:unknown):Promise<T>=>{const reply=await rpc!(endpoint,payload,AbortSignal.timeout(20000));assert.equal(reply.ok,true,endpoint+': '+JSON.stringify(reply.error));return reply.value as T}
 const parent=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'合成 SOC 原交办'})
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'固定同事',kind:'employee',scopes:['general'],duty:'核对',dataScope:'原资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active',version=3 where owner_id=$1 and id=$2",[owner,role.id])
 const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:parent.sessionId,status:'ready',submitted:false}))
 // 会话交办必须携带可核对的原始人类消息：经真实 Controller 受理后，按其原生身份固定来源。
 const origin=handles.get(parent.sessionId);assert.ok(origin,'父会话由完整生产 Controller 创建');model.parent=parent.sessionId
 const sourceText='请让固定同事核对事实，不执行外部动作。'
 await ctx.sessionController.prompt({sessionId:SessionId(parent.sessionId),requestId:brandString<SessionRequestId>(randomUUID()),mode:'queue',content:[{type:'text',text:sourceText}]},AbortSignal.timeout(5000));await origin.agent.whenIdle()
 const human=readSessionEvents(origin.agent.session).find(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')
 assert.ok(human&&human.type==='user/message','原始人类消息已由原生日志受理')
 const humanSource=human.data.source,nativeIdentity='rpcId' in humanSource&&typeof humanSource.rpcId==='string'?humanSource.rpcId:human.data.id
 const request=await requests.reserve(owner,{requestId:conversationWorkRequestId(owner,parent.sessionId,nativeIdentity),sessionId:parent.sessionId,messageId:human.data.id,messageSeq:human.seq,kind:'task',scope:'general',title:'原任务',goal:'核对事实，不执行外部动作',sourceText,roleId:role.id,expectedRoleVersion:3})
 const input={sessionId:parent.sessionId,requestId:request.requestId}
 const first=await call('work-requests/resume',input)
 const conversations=new ConversationService(new FileConversationRepository(join(root,'.runtime/teloa/conversations.json')),{create:async()=>{throw Error('回读不能创建会话')},inspect:async sessionId=>{await ctx.sessionController.inspect(SessionId(sessionId))}},identity)
 const runs=new TaskRunService(pool,identity,(actor,sessionId)=>conversations.bySession(actor,sessionId))
 const originalSession='task-run-'+workRequestChildId(request.requestId,'run',role.id)
 const original=handles.get(originalSession);assert.ok(original,'完整生产 Controller 已创建首 Run')
 await original.agent.whenIdle()
 await call('work-requests/status',input)
 let stored=(await pool.query('select * from teloa_task_runs where owner_id=$1 and session_id=$2',[owner,originalSession])).rows[0];assert.ok(stored)
 await call('task-runs/reconcile',{runId:stored.id})
 stored=(await pool.query('select * from teloa_task_runs where owner_id=$1 and session_id=$2',[owner,originalSession])).rows[0]
 const task=(await pool.query('select version,content_version,state,definition from teloa_tasks where owner_id=$1 and id=$2',[owner,stored.task_id])).rows[0]
 assert.equal(stored.state,'ended',JSON.stringify({first,state:stored.state,error:stored.configuration_error,createErrors}));assert.equal(stored.task_version,1);assert.equal(stored.task_state_version,2);assert.equal(task.version,3);assert.equal(task.content_version,1);assert.equal(task.state,'blocked');assert.equal(model.calls,1)
 const failed=await runs.get(owner,{runId:stored.id}),before=readSessionEvents(original.agent.session)
 await original.dispose();assert.equal(ctx.agents.get(SessionId(originalSession)),undefined)
 await assert.rejects(runs.skillScope(owner,{sessionId:originalSession}),{code:'teloa/version-conflict'},'正式继续执行许可仍拒绝历史状态版本，不因只读 retry 核验放宽')
 const stacks:string[]=[],skillScope=TaskRunService.prototype.skillScope
 let historicalSkillChecks=0
 t.mock.method(TaskRunService.prototype,'skillScope',async function(this:TaskRunService,...args:Parameters<TaskRunService['skillScope']>){if((args[1] as {sessionId?:unknown}).sessionId===originalSession)historicalSkillChecks++;try{return await skillScope.apply(this,args)}catch(error){stacks.push(error instanceof Error?error.stack??error.message:String(error));throw error}})
 const resumed=await call<{members:Array<{reason?:string;runId?:string}>}>('work-requests/resume',input)
 const history=(await pool.query('select * from teloa_task_runs where owner_id=$1 and task_id=$2 order by created_at,id',[owner,stored.task_id])).rows
 assert.equal(history.length,2,JSON.stringify({resumed,stacks}));assert.deepEqual(history[0],stored,'原 Run/固定版本/正文/终态不可重写')
 assert.equal(history[1].task_version,3);assert.equal(history[1].role_version,3);assert.equal(history[1].task_id,stored.task_id)
 const retrySession='task-run-'+workRequestChildId(request.requestId,'run-retry:'+stored.id,role.id);assert.equal(history[1].session_id,retrySession)
 assert.equal(ctx.agents.get(SessionId(originalSession)),undefined);assert.deepEqual((await ctx.sessionController.inspect(SessionId(originalSession))).events,before)
 assert.deepEqual(await runs.get(owner,{runId:failed.id}),failed)
 await handles.get(retrySession)?.agent.whenIdle();await call('work-requests/status',input)
 await call('work-requests/resume',input)
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[owner,stored.task_id])).rows[0].n,2,'重放原卡只读取固定 retry，不派生第三 Run')
 assert.equal(model.calls,2,'只有显式新 Run 启动一次模型，不恢复原失败轮')
 assert.equal(historicalSkillChecks,0,'只读历史使用原终态策略，不回查当前执行技能许可')
})
