/** 生产 apply + 真实 Cordis Agent/Tools/Approval/JSONL/PG；控制器只创建和读取真实 Agent，不调用模型。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {ToolCallId,createUserMessage,type StreamChunk} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,type BusinessConfigurationDraft} from '@teloa/backend'
import type {BusinessConversationBinding} from '@teloa/contract'
import {apply} from '../src/index.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {compositionEntries,type RpcHandler} from './fixtures/production-host.ts'
import {installNativeSessions,installNativeHostServices,ControlledPromptModel} from './fixtures/native-host-services.ts'

const owner='local:teloa-owner',revise='teloa_business_builder_revise'
class WorkAnswerModel extends ControlledPromptModel{
 calls=0
 override async *stream():AsyncIterable<StreamChunk>{
  this.calls++
  const text='客户资料已核对，依据为固定记录快照。'
  yield {type:'block-start',index:0,blockType:'text'}
  yield {type:'text-delta',index:0,text}
  yield {type:'block-end',index:0,block:{type:'text',text}}
  yield {type:'finish',reason:{kind:'stop'}}
 }
}
test('负责人生产装配：真实RPC、原生审批、单连接池和任务目录',{timeout:180000},async t=>{
 const root=await mkdtemp(join(process.cwd(),'.tmp-business-work-production-')),ctx=new Context(),priorRoot=process.env.TELOA_PROJECT_ROOT
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
 const model=new WorkAnswerModel()
 ctx.provide('loader',compositionEntries());await installNativeSessions(ctx);await ctx.plugin(ToolRuntime);await installNativeHostServices(ctx,join(root,'.runtime/dsh'));ctx.llm.registerAdapter(['controlled'],model)
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

 assert.ok(ctx.tools.get('teloa_business_responsibility_read'),'生产入口必须注册负责人读取')
 assert.ok(ctx.tools.get('teloa_business_responsibility_set'),'生产入口必须注册负责人修改')
 const f=await builder('负责人接线业务');await call('business-conversations/bind',{requestId:f.request.requestId,sessionId:f.sessionId});userTurn(f.sessionId)
 const draft=await call<BusinessConfigurationDraft>('business-configuration/draft',{sessionId:f.sessionId,draftId:f.reservation.draftId}),scope=draft.scope
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'跟进客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'}]}
 const page={id:'customers',title:'客户',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}
 assert.equal((await tool(f.sessionId,revise,{draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page],homePageId:page.id}})).isError,false)
 const preview=await call<{receipt:string}>('business-configuration/preview',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2})
 await call('business-configuration/apply',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2,expectedBaseVersion:0,requestId:randomUUID(),previewReceipt:preview.receipt})
 const initial=await call<{version:number;roleId:null}>('business-responsibility/read',{scope});assert.equal(initial.version,0);assert.equal(initial.roleId,null)
 assert.equal((await raw('business-responsibility/read',{scope:'forbidden'})).ok,false)
 assert.equal((await tool(f.sessionId,'teloa_business_responsibility_read')).isError,true)
 const role=await call<{id:string;version:number}>('roles/create',{requestId:randomUUID(),fields:{name:'客户负责人',kind:'employee',scopes:[scope],duty:'核对客户',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}})
 const ordinary=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'本人业务工作'})
 await call('work-context/set',{requestId:randomUUID(),sessionId:ordinary.sessionId,scopeId:scope,roleId:role.id,expectedVersion:0});userTurn(ordinary.sessionId)
 const readTool=await tool(ordinary.sessionId,'teloa_business_responsibility_read');assert.equal(readTool.isError,false,JSON.stringify(readTool))
 const choice={expectedVersion:0,role:{id:role.id,expectedVersion:role.version}},before=approvals
 decision=async()=>'rejected';assert.equal((await tool(ordinary.sessionId,'teloa_business_responsibility_set',choice)).isError,true)
 assert.equal((await call<{version:number}>('business-responsibility/read',{scope})).version,0)
 decision=async()=>'allowed-once';const selected=await tool(ordinary.sessionId,'teloa_business_responsibility_set',choice);assert.equal(selected.isError,false,JSON.stringify(selected));assert.equal(approvals,before+2)
 const selectedBody=JSON.parse(selected.value as string),original={requestId:selectedBody.requestId,scope,...choice}
 assert.equal((await call<{roleId:string}>('business-responsibility/receipt',original)).roleId,role.id)
 assert.equal((await tool(ordinary.sessionId,'teloa_business_responsibility_set',choice)).isError,false);assert.equal(approvals,before+2,'相同本人指令复用原回执')
 const directory=await tool(ordinary.sessionId,'teloa_work_directory');assert.equal(directory.isError,false,JSON.stringify(directory));assert.match(directory.value as string,/客户负责人/)
 assert.deepEqual(await call('business-tasks/list-for-scope',{scope}),{items:[]})
 assert.deepEqual(await call('business-tasks/list-for-object',{scope,type:'customer',id:'not-created'}),{items:[]})
 const dailyRequest={requestId:randomUUID(),kind:'daily',scope,title:'同一业务日常'}
 await call('business-conversations/reserve',dailyRequest)
 const daily=await call<{sessionId:string}>('conversations/create',{requestId:dailyRequest.requestId,title:dailyRequest.title})
 assert.equal((await tool(daily.sessionId,'teloa_business_responsibility_read')).isError,true,'待绑定不能借本人业务授权')
 await call('work-context/set',{requestId:dailyRequest.requestId,sessionId:daily.sessionId,scopeId:scope,roleId:null,expectedVersion:0});await call('business-conversations/bind',{requestId:dailyRequest.requestId,sessionId:daily.sessionId})
 userTurn(daily.sessionId);assert.equal((await tool(daily.sessionId,'teloa_business_responsibility_read')).isError,false)
 userTurn(ordinary.sessionId);decision=async()=>{userTurn(ordinary.sessionId);return 'allowed-once'}
 assert.equal((await tool(ordinary.sessionId,'teloa_business_responsibility_set',{expectedVersion:1,role:null})).isError,true,'审批后新指令使原exec失效')
 assert.equal((await call<{version:number}>('business-responsibility/read',{scope})).version,1);decision=async()=>'allowed-once'
 const cleared=await call<{version:number}>('business-responsibility/set',{requestId:randomUUID(),scope,expectedVersion:1,role:null});assert.equal(cleared.version,2)
 assert.equal((await call<{roleId:string}>('business-responsibility/receipt',original)).roleId,role.id,'旧回执不是当前负责人')
 assert.equal((await pool.query("select count(*)::int n from teloa_tasks where owner_id=$1 and definition->>'scope'=$2",[owner,scope])).rows[0].n,0,'选负责人不生成任务')
 const record=await tool(ordinary.sessionId,'teloa_business_records_write',{operations:[{operation:'create',type:'customer',title:'测试客户',summary:'',fields:[{name:'name',value:'测试客户'}]}]});assert.equal(record.isError,false,JSON.stringify(record))
 const saved=JSON.parse(record.value as string).items[0],reference={scope,type:'customer',id:saved.id,version:saved.version,snapshotHash:saved.snapshotHash}
 userTurn(ordinary.sessionId)
 const dispatch={scope,title:'核对客户资料',goal:'核对真实客户资料并列出依据',roleId:role.id,expectedRoleVersion:role.version,reference},beforeDispatch=approvals
 assert.equal((await tool(ordinary.sessionId,'teloa_work_dispatch',{...dispatch,reference:{...reference,snapshotHash:'0'.repeat(64)}})).isError,true,'坏hash必须经统一历史核验拒绝')
 assert.equal(approvals,beforeDispatch)
 decision=async()=>'rejected';assert.equal((await tool(ordinary.sessionId,'teloa_work_dispatch',dispatch)).isError,true);decision=async()=>'allowed-once'
 assert.equal(approvals,beforeDispatch+1,'真对象核验后才进入真实审批')
 assert.equal((await pool.query("select count(*)::int n from teloa_tasks where owner_id=$1 and definition->>'scope'=$2",[owner,scope])).rows[0].n,0)
 const task=await call<{task:{id:string;title:string}}>('business-tasks/create',{requestId:randomUUID(),reference,title:'核对客户资料',goal:'核对真实客户资料并列出依据',assignee:{roleId:role.id,expectedVersion:role.version}})
 assert.equal(task.task.title,'核对客户资料')
 for(const endpoint of ['business-tasks/list-for-scope','business-tasks/list-for-object']){
  const list=await call<{items:Array<{task:{id:string;goal?:string};source:{reference:unknown}}> }>(endpoint,{scope,...(endpoint.endsWith('object')?{type:'customer',id:saved.id}:{})})
  assert.equal(list.items.length,1);assert.equal(list.items[0]!.task.id,task.task.id);assert.equal(list.items[0]!.task.goal,undefined);assert.deepEqual(list.items[0]!.source.reference,reference)
 }
 // 旧跨业务回执仍归general协调；真实scope目录不可见时不能读取成员业务详情。
 const cross=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'跨业务结果核对'})
 const crossId=randomUUID(),hiddenScope='hidden_'+randomUUID().replaceAll('-','')
 const crossSpec={requestId:crossId,sessionId:cross.sessionId,messageId:'historical-approved',messageSeq:1,kind:'report',scope:'general',allBusinesses:true,title:'跨业务汇报',goal:'核对成员进展'}
 const crossTargets=[{roleId:role.id,roleVersion:role.version,name:'已撤权成员业务私有名称',scope:hiddenScope,unavailable:'paused'}]
 await pool.query('insert into teloa_conversation_work_requests(owner_id,request_id,session_id,request_spec,targets,created_at) values($1,$2,$3,$4,$5,now())',[owner,crossId,cross.sessionId,JSON.stringify(crossSpec),JSON.stringify(crossTargets)])
 const hidden=await raw('work-requests/status',{sessionId:cross.sessionId,requestId:crossId})
 assert.equal(hidden.ok,false,'general协调权限不能使不可访问的成员业务结果可见')
 assert.equal(hidden.error?.code,'teloa/forbidden');assert.ok(!JSON.stringify(hidden).includes('已撤权成员业务私有名称'))
 assert.equal((await raw('work-requests/list',{sessionId:cross.sessionId})).ok,false)
 assert.equal((await pool.query('select notified_at from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,crossId])).rows[0].notified_at,null)

 // 正式工具从本人原指令出发，经过原生审批、真实 Task/Run 与原生会话，再回到同一发起会话。
 userTurn(ordinary.sessionId)
 const dispatched=await tool(ordinary.sessionId,'teloa_work_dispatch',dispatch)
 assert.equal(dispatched.isError,false,JSON.stringify(dispatched))
 const received=JSON.parse(dispatched.value as string) as {requestId:string;members:Array<{task?:{id:string};run?:{id:string;sessionId:string};status:string}>}
 assert.equal(received.members.length,1)
 assert.ok(received.members[0]?.task?.id)
 assert.ok(received.members[0]?.run?.id,JSON.stringify(received))
 const startedRun=received.members[0]!.run!,native=ctx.agents.get(SessionId(startedRun.sessionId))!
 await native.whenIdle()
 assert.equal(model.calls,1,'明确交办恰好调用一次受管原生模型')
 await call('task-runs/reconcile',{runId:startedRun.id})
 const status=await call<{counts:{received:number};members:Array<{result?:string}>}>('work-requests/status',{sessionId:ordinary.sessionId,requestId:received.requestId})
 assert.equal(status.counts.received,1)
 assert.match(status.members[0]!.result??'',/固定记录快照/)
 const notices=()=>readSessionEvents(ctx.agents.get(SessionId(ordinary.sessionId))!.session).filter(event=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='plugin:teloa.work'&&event.data.source.requestId===received.requestId)
 for(let attempt=0;attempt<100&&!notices().length;attempt++)await new Promise(resolve=>setTimeout(resolve,50))
 assert.equal(notices().length,1,'受管执行结果应回流到原本人会话且只追加一次')
 assert.match(JSON.stringify(notices()[0]),/固定记录快照/)
 const repeat=await tool(ordinary.sessionId,'teloa_work_dispatch',dispatch)
 assert.equal(repeat.isError,false,JSON.stringify(repeat))
 assert.equal(model.calls,1,'同一本人消息重试不能重复发送 Run')
 assert.equal(notices().length,1,'重试不重复回流通知')
 assert.equal((await pool.query('select count(*)::int n from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[owner,received.requestId])).rows[0].n,1)
 // 父身份只由正式 dispatch 内部消费；公开入口即使复制已成功原spec也不能冒领回执。
 const fixedTask=(await pool.query('select request_id,request_spec from teloa_tasks where owner_id=$1 and id=$2',[owner,received.members[0]!.task!.id])).rows[0]
 const ordinaryReplay=await raw('tasks/create',{requestId:fixedTask.request_id,...fixedTask.request_spec})
 assert.equal(ordinaryReplay.ok,false);assert.equal(ordinaryReplay.error?.code,'teloa/conflict')
 const fixedSource=(await pool.query('select request_spec from teloa_business_task_sources where owner_id=$1 and task_id=$2',[owner,received.members[0]!.task!.id])).rows[0]
 const sourceReplay=await raw('business-tasks/create',{requestId:fixedTask.request_id,...fixedSource.request_spec})
 assert.equal(sourceReplay.ok,false);assert.equal(sourceReplay.error?.code,'teloa/conflict')
 for(const endpoint of ['work-requests/resume','work-requests/stop','work-requests/status']){
  const restored=await call<{members:Array<{task?:{id:string}}> }>(endpoint,{sessionId:ordinary.sessionId,requestId:received.requestId})
  assert.equal(restored.members[0]?.task?.id,received.members[0]!.task!.id,endpoint+' 必须沿固定父身份读原任务')
 }
 assert.equal(model.calls,1,'读、停止和恢复原父请求不重发')


 // 同事有非空工具授权时，pre-step 的 toolPolicy 也必须在原事务复用 max=1 连接。
 const currentRole=async()=>((await call<Array<{id:string;version:number;state:string}>>('roles/list',{})).find(item=>item.id===role.id))!
 let activeRole=await currentRole()
 await call('roles/lifecycle',{roleId:role.id,expectedVersion:activeRole.version,action:'pause',reason:'配置测试工具'})
 activeRole=await currentRole()
 await call('role-tools/change',{roleId:role.id,expectedRoleVersion:activeRole.version,action:'save',rules:[{name:'web_search',anyArguments:true,allowed:[]}]})
 activeRole=await currentRole()
 await call('roles/lifecycle',{roleId:role.id,expectedVersion:activeRole.version,action:'resume',reason:'继续任务'})
 activeRole=await currentRole()
 userTurn(ordinary.sessionId)
 const withTool=await tool(ordinary.sessionId,'teloa_work_dispatch',{scope,title:'核对近期客户',goal:'只核对当前客户记录',roleId:role.id,expectedRoleVersion:activeRole.version})
 assert.equal(withTool.isError,false,JSON.stringify(withTool))
 const toolRun=JSON.parse(withTool.value as string) as {members:Array<{run?:{id:string;sessionId:string};task?:{id:string}}>}
 assert.ok(toolRun.members[0]?.run?.id,JSON.stringify(toolRun))
 assert.equal((await call<Array<{allowedTools:string[]}>>('task-runs/list',{taskId:toolRun.members[0]!.task!.id}))[0]!.allowedTools.includes('web_search'),true)
 await ctx.agents.get(SessionId(toolRun.members[0]!.run!.sessionId))!.whenIdle()
 const runGate=await tool(toolRun.members[0]!.run!.sessionId,'teloa_work_directory')
 assert.equal(runGate.isError,true,'受管 Run 不能冒用本人交办工具')
 assert.doesNotMatch(JSON.stringify(runGate),/storage-unavailable|资源数据库暂不可用/,'非空工具策略复核不能耗尽 max=1 连接池')
 await call('task-runs/reconcile',{runId:toolRun.members[0]!.run!.id})
 assert.equal(model.calls,2,'授权工具的任务也只调用一次原生模型')

})
