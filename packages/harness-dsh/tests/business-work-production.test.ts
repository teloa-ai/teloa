/** 生产 apply + 真实 Cordis Agent/Tools/Approval/JSONL/PG；控制器只创建和读取真实 Agent，不调用模型。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {ToolCallId,type StreamChunk,type GenerateOptions} from '@deepseek-ai/dsh-llm'
import {SessionId} from '@deepseek-ai/dsh-session'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {openResourceDatabase,type BusinessConfigurationDraft} from '@teloa/backend'
import type {BusinessConversationBinding} from '@teloa/contract'
import {readRunBusinessContext,type RunBusinessContext} from '@teloa/backend'
import {apply} from '../src/index.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {compositionEntries,type RpcHandler} from './fixtures/production-host.ts'
import {installNativeSessions,installNativeHostServices,ControlledPromptModel} from './fixtures/native-host-services.ts'

import {nativeToolInvocation} from './fixtures/native-tool-invocation.ts'

const owner='local:teloa-owner',revise='teloa_business_builder_revise'
class WorkAnswerModel extends ControlledPromptModel{
 calls=0
 resultMode=false;resultCalls=0;resultContext:RunBusinessContext|undefined
 override async *stream(options?:GenerateOptions):AsyncIterable<StreamChunk>{
  this.calls++
  if(this.resultMode&&this.resultCalls++===0){
   assert.ok(options)
   for(const message of options.messages)for(const block of message.content){
    if(block.type!=='text')continue
    try{const input=JSON.parse(block.text);if(input.businessContext){const {notice:_notice,...context}=input.businessContext;this.resultContext=readRunBusinessContext(context)}}catch{}
   }
   assert.ok(this.resultContext?.resultMappings,'真正模型输入必须携带生效成果目录')
   assert.equal(this.resultContext.resultMappings.length,1)
   const target=this.resultContext.resultMappings[0]!
   assert.equal(target.mapping.title,'客户研判结果')
   assert.deepEqual(target.objectType.fields.find(field=>field.name==='severity')?.values,['高','低'])
   assert.equal(target.objectType.fields.find(field=>field.name==='severity')?.required,true)
   const id=ToolCallId('fixed-object-result'),args=JSON.stringify({result:{severity:'高'}})
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id,name:'teloa_business_object_result_record',argumentsDelta:args}
   yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'teloa_business_object_result_record',arguments:args}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
   return
  }
  if(this.calls===2){
   const id=ToolCallId('managed-directory-denied'),args='{}'
   yield {type:'block-start',index:0,blockType:'tool-call'}
   yield {type:'tool-call-delta',index:0,id,name:'teloa_work_directory',argumentsDelta:args}
   yield {type:'block-end',index:0,block:{type:'tool-call',id,name:'teloa_work_directory',arguments:args}}
   yield {type:'finish',reason:{kind:'tool-calls'}}
   return
  }
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
 ctx.provide('loader',compositionEntries());await installNativeSessions(ctx);await installNativeHostServices(ctx,join(root,'.runtime/dsh'));const invocation=nativeToolInvocation(ctx,{providers:['controlled'],adapter:model})
 const workspaces=new Map<string,{id:string;path:string}>(),archived:string[]=[]
 ctx.provide('workspaceRegistry',{archivedSessionIds:archived,create:async(path:string)=>{const prior=[...workspaces.values()].find(item=>item.path===path);if(prior)return prior;const item={id:randomUUID(),path};workspaces.set(item.id,item);return item},get:(id:string)=>workspaces.get(id),list:()=>[...workspaces.values()]})
 ctx.provide('agentPresets',{serviceFor:()=>undefined,acquireScope:async()=>({key:{},async [Symbol.asyncDispose](){}}),resolve:async(id?:string)=>({id:id??'teloa-standard'})})
 ctx.provide('fileReferences',{})
 const visible:string[]=[],pinnedTitles=new Map<string,string>()
 ctx.provide('sessionController',{
  list:async()=>({items:visible.map(sessionId=>({sessionId}))}),
  create:async(input:{sessionId?:string;agentPreset?:string;workspaceId?:string}={})=>{const sessionId=SessionId(input.sessionId??randomUUID());await ctx.agents.create({sessionId,meta:{cwd:workspaces.get(input.workspaceId??'')?.path??root,...(input.agentPreset?{agentPreset:input.agentPreset}:{})},agentOptions:{provider:'controlled',model:'fixed'}});visible.unshift(sessionId);return {sessionId,...(input.agentPreset?{agentPreset:input.agentPreset}:{})}},
  resolveAgent:async(id:string)=>{const agent=ctx.agents.get(SessionId(id));return agent?{agent}:{error:{code:'not-found',message:'missing'}}},
  rename:async(input:{sessionId:string;title:string})=>{assert.ok(ctx.agents.get(SessionId(input.sessionId)));pinnedTitles.set(input.sessionId,input.title);return {title:input.title,seq:1}},
  // 与官方 Controller.inspect 同形：生产的本人复核来源要从冷读事件核对原始人类消息。
  inspect:async(id:string)=>{const agent=ctx.agents.get(SessionId(id));assert.ok(agent);return {sessionId:id,meta:agent.session.header,events:agent.session.snapshotEvents(),inheritedEventCount:agent.session.inheritedEventCount,status:agent.status}},modelCatalog:async()=>({default:{provider:'controlled',model:'fixed'}}),
 })
 let rpc:RpcHandler|undefined;ctx.provide('connection',{fetch:{register:()=>async()=>{}},rpc:{handle:(_path:string,handler:RpcHandler)=>{rpc=handler;return ()=>{}}}})
 await apply(ctx,{projectRoot:root});database=await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()});const pool=database.pool
 const raw=(endpoint:string,payload:unknown)=>rpc!(endpoint,payload,AbortSignal.timeout(15000))
 const call=async<T>(endpoint:string,payload:unknown):Promise<T>=>{const reply=await raw(endpoint,payload);assert.equal(reply.ok,true,endpoint+': '+JSON.stringify(reply.error));return reply.value as T}
 const userTurn=(sessionId:string)=>invocation.instruction(ctx.agents.get(SessionId(sessionId))!)
 const tool=async(sessionId:string,name:string,args:Record<string,unknown>={},callId?:ToolCallId)=>{
  try{return await invocation.invoke(ctx.agents.get(SessionId(sessionId))!,{name,arguments:args,...(callId?{callId}:{}),signal:AbortSignal.timeout(15000)})}
  catch(cause){throw new Error('原生工具执行未完成：'+name,{cause})}
 }
 const builder=async(title:string)=>{const request={requestId:randomUUID(),kind:'builder',title},reservation=await call<BusinessConversationBinding>('business-conversations/reserve',request),native=await call<{sessionId:string}>('conversations/create',{requestId:request.requestId,title});return {...native,reservation,request}}
 await t.test('本人主聊正式RPC核验旧通用上下文，登记原身份、固定标题和拒绝改投',async()=>{
  const legacy=await call<{sessionId:string;requestId:string}>('conversations/create',{requestId:randomUUID(),title:'Teloa 小松鼠助手'})
  await call('work-context/set',{requestId:randomUUID(),sessionId:legacy.sessionId,scopeId:'general',roleId:null,expectedVersion:0})
  const draftTask=await call<any>('tasks/create',{requestId:randomUUID(),fields:{title:'主聊来源合成草稿',goal:'仅记录创建来源，不执行',scope:'general'}})
  await call('object-conversations/change',{requestId:randomUUID(),kind:'task',objectId:draftTask.id,expectedObjectVersion:draftTask.version,sessionId:legacy.sessionId,expectedLinkVersion:0,action:'link',sourceOnly:true})
  const main=await call<{sessionId:string;purpose:string;requestId:string}>('conversations/assistant',{})
  assert.equal(main.sessionId,legacy.sessionId);assert.equal(main.requestId,legacy.requestId);assert.equal(main.purpose,'assistant')
  assert.equal(pinnedTitles.get(main.sessionId),'Teloa 小松鼠助手')
  const repeated=await Promise.all([call<any>('conversations/assistant',{}),call<any>('conversations/assistant',{})]);assert.ok(repeated.every(row=>row.sessionId===main.sessionId))
  const read=await call<any>('conversations/read',{sessionId:main.sessionId});assert.equal(read.purpose,'assistant')
  assert.equal((await call<any>('work-context/eligibility',{sessionId:main.sessionId})).eligible,true,'任务创建来源不把主聊变成执行上下文')
  const otherTask=await call<any>('tasks/create',{requestId:randomUUID(),fields:{title:'独立执行合成草稿',goal:'仅用于身份改投拒绝验证',scope:'general'}})
  const executionLink=await raw('object-conversations/change',{requestId:randomUUID(),kind:'task',objectId:otherTask.id,expectedObjectVersion:otherTask.version,sessionId:main.sessionId,expectedLinkVersion:0,action:'link'})
  assert.equal(executionLink.ok,false);assert.equal(executionLink.error?.code,'teloa/forbidden')
  const changed=await raw('work-context/set',{requestId:randomUUID(),sessionId:main.sessionId,scopeId:'sales',roleId:null,expectedVersion:1})
  assert.equal(changed.ok,false);assert.equal(changed.error?.code,'teloa/forbidden')
  assert.equal((await call<any>('work-context/read',{sessionId:main.sessionId})).scopeId,'general')
  archived.push(main.sessionId);const archivedReply=await raw('conversations/assistant',{});assert.equal(archivedReply.ok,false);assert.equal(archivedReply.error?.code,'teloa/conflict');archived.pop()
  assert.equal(visible.filter(id=>id===main.sessionId).length,1)
 })
 let approvals=0,decision:()=>Promise<'allowed-once'|'rejected'>=async()=> 'allowed-once'
 ctx.on('approval/request',async()=>{approvals++;return decision()})

 assert.ok(ctx.tools.get('teloa_business_responsibility_read'),'生产入口必须注册负责人读取')
 assert.ok(ctx.tools.get('teloa_business_responsibility_set'),'生产入口必须注册负责人修改')
 const f=await builder('负责人接线业务');await call('business-conversations/bind',{requestId:f.request.requestId,sessionId:f.sessionId});await userTurn(f.sessionId)
 const draft=await call<BusinessConfigurationDraft>('business-configuration/draft',{sessionId:f.sessionId,draftId:f.reservation.draftId}),scope=draft.scope
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'跟进客户',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'name',label:'姓名',type:'text',required:true,from:'姓名'}]}
 const resultDefinition={...definition,id:'customer-result',title:'客户研判',fields:[{name:'id',label:'客户编号',type:'text',required:true,from:'客户编号'},{name:'severity',label:'严重度',type:'enum',required:true,from:'严重度',values:['高','低']}]}
 const resultMapping={format:'teloa.business-source-mapping/v1',id:'customer-result-mapping',version:'1.0.0',domain:scope,title:'客户研判结果',objectType:resultDefinition.id,source:{kind:'role-result'},mapping:[{path:'$.object.id',field:'id'},{path:'$.result.severity',field:'severity'}],primaryKey:['id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const page={id:'customers',title:'客户',kind:'records',objectType:'customer',fields:['name'],allowCreate:true,allowEdit:true,allowArchive:true}
 assert.equal((await tool(f.sessionId,revise,{draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},{kind:'object-type',definition:resultDefinition},{kind:'source-mapping',definition:resultMapping}],upsertPages:[page],homePageId:page.id}})).isError,false)
 const preview=await call<{receipt:string}>('business-configuration/preview',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2})
 await call('business-configuration/apply',{sessionId:f.sessionId,draftId:draft.id,expectedRevision:2,expectedBaseVersion:0,requestId:randomUUID(),previewReceipt:preview.receipt})
 const initial=await call<{version:number;roleId:null}>('business-responsibility/read',{scope});assert.equal(initial.version,0);assert.equal(initial.roleId,null)
 assert.equal((await raw('business-responsibility/read',{scope:'forbidden'})).ok,false)
 assert.equal((await tool(f.sessionId,'teloa_business_responsibility_read')).isError,true)
 let role=await call<{id:string;version:number}>('roles/create',{requestId:randomUUID(),fields:{name:'客户负责人',kind:'employee',scopes:[scope],duty:'核对客户',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}})
 // task-18 回归夹具：新空工具闸要求员工运行在准备前有真实执行工具；按宿主候选（优先 web）授权后恢复在岗，不放宽产品闸。
 {
  const reload=async()=>((await call<Array<{id:string;version:number;state:string}>>('roles/list',{})).find(item=>item.id===role.id)!)
  const paused=await reload()
  await call('roles/lifecycle',{roleId:paused.id,expectedVersion:paused.version,action:'pause',reason:'配置执行工具'})
  const afterPause=await reload()
  const available=await call<{rules:{name:string}[]}>('role-tools/candidates',{roleId:afterPause.id})
  const rule=available.rules.find(item=>item.name==='web_search')??available.rules.find(item=>item.name==='web_fetch')??available.rules.find(item=>item.name!=='subagent_task')
  assert.ok(rule,'宿主必须提供至少一项真实工具候选')
  await call('role-tools/change',{roleId:afterPause.id,expectedRoleVersion:afterPause.version,action:'save',rules:[{name:rule.name,anyArguments:true,allowed:[]}]})
  const changed=await reload()
  await call('roles/lifecycle',{roleId:changed.id,expectedVersion:changed.version,action:'resume',reason:'继续任务'})
  const resumed=await reload();role={id:resumed.id,version:resumed.version}
 }
 const ordinary=await call<{sessionId:string}>('conversations/create',{requestId:randomUUID(),title:'本人业务工作'})
 await call('work-context/set',{requestId:randomUUID(),sessionId:ordinary.sessionId,scopeId:scope,roleId:role.id,expectedVersion:0});await userTurn(ordinary.sessionId)
 const readTool=await tool(ordinary.sessionId,'teloa_business_responsibility_read');assert.equal(readTool.isError,false,JSON.stringify(readTool))
 const choice={expectedVersion:0,role:{id:role.id,expectedVersion:role.version}},before=approvals
 decision=async()=>'rejected';assert.equal((await tool(ordinary.sessionId,'teloa_business_responsibility_set',choice)).isError,true)
 assert.equal((await call<{version:number}>('business-responsibility/read',{scope})).version,0)
 const sameCallId=ToolCallId(randomUUID())
 decision=async()=>'allowed-once';const selected=await tool(ordinary.sessionId,'teloa_business_responsibility_set',choice,sameCallId);assert.equal(selected.isError,false,JSON.stringify(selected));assert.equal(approvals,before+2)
 const selectedBody=JSON.parse(selected.value as string),original={requestId:selectedBody.requestId,scope,...choice}
 assert.equal((await call<{roleId:string}>('business-responsibility/receipt',original)).roleId,role.id)
 const instructionEvents=()=>readSessionEvents(ctx.agents.get(SessionId(ordinary.sessionId))!.session).filter(event=>event.type==='turn/start'||event.type==='user/message'&&event.data.source.kind==='user')
 const priorInstruction=instructionEvents()
 assert.equal((await tool(ordinary.sessionId,'teloa_business_responsibility_set',choice,sameCallId)).isError,false);assert.equal(approvals,before+2,'相同本人指令复用原回执')
 assert.deepEqual(instructionEvents(),priorInstruction,'重复 callId 继续同一本人指令，不制造新轮次或用户消息')
 assert.equal(readSessionEvents(ctx.agents.get(SessionId(ordinary.sessionId))!.session).filter(event=>event.type==='tool/call'&&event.data.callId===sameCallId).length,2,'两次调用都经过原生工具循环')
 const directory=await tool(ordinary.sessionId,'teloa_work_directory');assert.equal(directory.isError,false,JSON.stringify(directory));assert.match(directory.value as string,/客户负责人/)
 assert.deepEqual(await call('business-tasks/list-for-scope',{scope}),{items:[]})
 assert.deepEqual(await call('business-tasks/list-for-object',{scope,type:'customer',id:'not-created'}),{items:[]})
 const dailyRequest={requestId:randomUUID(),kind:'daily',scope,title:'同一业务日常'}
 await call('business-conversations/reserve',dailyRequest)
 const daily=await call<{sessionId:string}>('conversations/create',{requestId:dailyRequest.requestId,title:dailyRequest.title})
 assert.equal((await tool(daily.sessionId,'teloa_business_responsibility_read')).isError,true,'待绑定不能借本人业务授权')
 await call('work-context/set',{requestId:dailyRequest.requestId,sessionId:daily.sessionId,scopeId:scope,roleId:null,expectedVersion:0});await call('business-conversations/bind',{requestId:dailyRequest.requestId,sessionId:daily.sessionId})
 await userTurn(daily.sessionId);assert.equal((await tool(daily.sessionId,'teloa_business_responsibility_read')).isError,false)
 await userTurn(ordinary.sessionId);decision=async()=>{await userTurn(ordinary.sessionId);return 'allowed-once'}
 assert.equal((await tool(ordinary.sessionId,'teloa_business_responsibility_set',{expectedVersion:1,role:null})).isError,true,'审批后新指令使原exec失效')
 assert.equal((await call<{version:number}>('business-responsibility/read',{scope})).version,1);decision=async()=>'allowed-once'
 const cleared=await call<{version:number}>('business-responsibility/set',{requestId:randomUUID(),scope,expectedVersion:1,role:null});assert.equal(cleared.version,2)
 assert.equal((await call<{roleId:string}>('business-responsibility/receipt',original)).roleId,role.id,'旧回执不是当前负责人')
 assert.equal((await pool.query("select count(*)::int n from teloa_tasks where owner_id=$1 and definition->>'scope'=$2",[owner,scope])).rows[0].n,0,'选负责人不生成任务')
 const record=await tool(ordinary.sessionId,'teloa_business_records_write',{operations:[{operation:'create',type:'customer',title:'测试客户',summary:'',fields:[{name:'name',value:'测试客户'}]}]});assert.equal(record.isError,false,JSON.stringify(record))
 const saved=JSON.parse(record.value as string).items[0],reference={scope,type:'customer',id:saved.id,version:saved.version,snapshotHash:saved.snapshotHash}
 await userTurn(ordinary.sessionId)
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
 await userTurn(ordinary.sessionId)
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
 assert.equal(notices().length,0,'本人原轮次仍活动时结果保持待回流，不插入在途工具链')
 const repeat=await tool(ordinary.sessionId,'teloa_work_dispatch',dispatch)
 assert.equal(repeat.isError,false,JSON.stringify(repeat))
 assert.equal(model.calls,1,'同一本人消息重试不能重复发送 Run')
 assert.equal(notices().length,0,'原轮次内重试也不能提前回流通知')
 // 工具模型结束真实原轮次后才进入 idle；回流通知不能替它结束或唤醒模型。
 await invocation.finish(ctx.agents.get(SessionId(ordinary.sessionId))!,'交办结果已就绪，等待本人核对。')
 for(let attempt=0;attempt<100&&!notices().length;attempt++)await new Promise(resolve=>setTimeout(resolve,50))
 assert.equal(notices().length,1,'闲置后受管执行结果回流到原本人会话且只追加一次')
 assert.match(JSON.stringify(notices()[0]),/固定记录快照/)
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
 await userTurn(ordinary.sessionId)
 const withTool=await tool(ordinary.sessionId,'teloa_work_dispatch',{scope,title:'核对近期客户',goal:'只核对当前客户记录',roleId:role.id,expectedRoleVersion:activeRole.version})
 assert.equal(withTool.isError,false,JSON.stringify(withTool))
 const toolRun=JSON.parse(withTool.value as string) as {members:Array<{run?:{id:string;sessionId:string};task?:{id:string}}>}
 assert.ok(toolRun.members[0]?.run?.id,JSON.stringify(toolRun))
 assert.equal((await call<Array<{allowedTools:string[]}>>('task-runs/list',{taskId:toolRun.members[0]!.task!.id}))[0]!.allowedTools.includes('web_search'),true)
 const toolAgent=ctx.agents.get(SessionId(toolRun.members[0]!.run!.sessionId))!
 await toolAgent.whenIdle()
 const runGate=readSessionEvents(toolAgent.session).find(event=>event.type==='tool/result'&&event.data.message.toolCallId==='managed-directory-denied')
 assert.ok(runGate?.type==='tool/result','工具拒绝须来自受管执行的原轮次，不向已结束 Run 注入新指令')
 assert.equal(runGate.data.message.isError,true,'受管 Run 不能冒用本人交办工具')
 assert.doesNotMatch(JSON.stringify(runGate),/storage-unavailable|资源数据库暂不可用/,'非空工具策略复核不能耗尽 max=1 连接池')
 await call('task-runs/reconcile',{runId:toolRun.members[0]!.run!.id})
 const endedEvents=readSessionEvents(toolAgent.session)
 await assert.rejects(()=>userTurn(toolAgent.id),error=>!!error&&typeof error==='object'&&Reflect.get(error,'code')==='teloa/version-conflict','已结束 Run 不能接受新的本人指令')
 assert.deepEqual(readSessionEvents(toolAgent.session),endedEvents,'拒绝过期输入不能追加原会话日志')
 assert.equal(model.calls,3,'两项任务加一次拒绝工具后的原轮次续答，不因过期输入重发模型')

 // 原生模型只取得业务目标和宿主冻结的目录，不在 goal 里手填任何映射身份。
 activeRole=await currentRole()
 await call('roles/lifecycle',{roleId:role.id,expectedVersion:activeRole.version,action:'pause',reason:'配置成果能力'})
 activeRole=await currentRole()
 await call('role-tools/change',{roleId:role.id,expectedRoleVersion:activeRole.version,action:'save',rules:[{name:'teloa_business_object_result_record',anyArguments:true,allowed:[]}]})
 activeRole=await currentRole()
 await call('roles/lifecycle',{roleId:role.id,expectedVersion:activeRole.version,action:'resume',reason:'继续结构化工作'})
 activeRole=await currentRole();model.resultMode=true
 await userTurn(ordinary.sessionId)
 const resultDispatch=await tool(ordinary.sessionId,'teloa_work_dispatch',{scope,title:'记录客户研判',goal:'核对当前客户并记录研判严重度',roleId:role.id,expectedRoleVersion:activeRole.version,reference})
 assert.equal(resultDispatch.isError,false,JSON.stringify(resultDispatch))
 const resultReceipt=JSON.parse(resultDispatch.value as string) as {members:Array<{run:{id:string;sessionId:string};task:{id:string}} >},resultRun=resultReceipt.members[0]!.run,resultAgent=ctx.agents.get(SessionId(resultRun.sessionId))!
 assert.deepEqual((await call<Array<{allowedTools:string[]}>>('task-runs/list',{taskId:resultReceipt.members[0]!.task.id}))[0]!.allowedTools,['teloa_business_object_result_record'],'目录不能授予员工任何额外读取或写口')
 await resultAgent.whenIdle()
 const written=readSessionEvents(resultAgent.session).find(event=>event.type==='tool/result'&&event.data.message.toolCallId==='fixed-object-result')
 assert.ok(written?.type==='tool/result',JSON.stringify(readSessionEvents(resultAgent.session).filter(event=>event.type==='turn/end')))
 assert.equal(written.data.message.isError,false,JSON.stringify(written))
 assert.equal(model.resultCalls,2,'一次结构化写入和原轮次续答，不盲猜映射')
 assert.equal(model.resultContext!.object.id,reference.id)
 const heads=await pool.query('select mapping_id,run_id from teloa_business_task_result_heads where owner_id=$1 and scope_id=$2 and object_id=$3',[owner,scope,reference.id])
 assert.equal(heads.rows.length,1);assert.equal(heads.rows[0].mapping_id,resultMapping.id);assert.equal(heads.rows[0].run_id,resultRun.id)
 const snapshot=await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4',[owner,scope,resultDefinition.id,reference.id])
 assert.equal(snapshot.rows.length,1);assert.deepEqual(snapshot.rows[0].snapshot.fields,[{label:'客户编号',value:reference.id},{label:'严重度',value:'高'}])
 await call('task-runs/reconcile',{runId:resultRun.id})

})
