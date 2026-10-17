import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {SessionId,type SessionEvent} from '@deepseek-ai/dsh-session'
import {ToolCallId,type GenerateOptions,type StreamChunk} from '@deepseek-ai/dsh-llm'
import type {SubagentResult} from '@deepseek-ai/dsh-subagent'
import {ApprovalService} from '@deepseek-ai/dsh-user-approval'
import {LocalJobRegistry} from '@deepseek-ai/dsh-jobs-local'
import {TeamService} from '@deepseek-ai/dsh-experimental-agent-team'
import type {TaskRun,TaskRunRuntimeLink,TaskRunRuntimeLinks} from '@teloa/backend'
import {nativeHotSubagentFixture} from './fixtures/native-hot-subagent.ts'
import {deferred,until} from './fixtures/native-subagent-admission.ts'
import {registerExternalHarnessAdmission} from '../src/external-harness-admission.ts'
import {createExternalHarnessConsent} from '../src/external-harness-consent.ts'
import {createTaskRunBackground,taskRunRuntimeId} from '../src/task-run-background.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {taskRunTeamContinuations} from '../src/task-run-team-records.ts'
import {taskRunExternalContinuations} from '../src/task-run-external-continuations.ts'
import {createTaskRunTeam} from '../src/task-run-team.ts'
import {registerTaskToolGuard} from '../src/task-tool-guard.ts'
import type {SubagentDelegationPorts} from '../src/subagent-delegation.ts'
import {leaseTaskDeliveryReview,createReviewSourceCatalog,deliveryReviewToolName,type DeliveryReviewTrace} from '../src/task-delivery-review.ts'

const goal='仅核对本轮合成计算结果并交付正文。',result='原生外部执行算得7500。',draft='本轮核对结果为7500。'
const text=(value:string):StreamChunk[]=>[{type:'block-start',index:0,blockType:'text'},{type:'text-delta',index:0,text:value},{type:'block-end',index:0,block:{type:'text',text:value}},{type:'finish',reason:{kind:'stop'}}]
const call=(name:string,id:string,args:unknown):StreamChunk[]=>[{type:'block-start',index:0,blockType:'tool-call'},{type:'block-end',index:0,block:{type:'tool-call',name,id:ToolCallId(id),arguments:JSON.stringify(args)}},{type:'finish',reason:{kind:'tool-calls'}}]

for(const [delayed,stopAfterExternal] of [[true,false],[false,false],[true,true]] as const)test(stopAfterExternal?'停止同Run外部完成唤起的第二turn，保留原生取消回执且不生成交付':delayed?'延迟外部完成在第二turn续原Run，原生占位不收口，R1/R2后冷读同一正式交付':'同轮立即完成的外部执行仍按原审批、R1/R2和固定窗口交付',{timeout:15000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),rpc='delayed-external-rpc',runId='delayed-external-run',native=deferred<SubagentResult>()
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),tool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 await f.ctx.plugin(ApprovalService,{policy:'ask'})
 await f.ctx.plugin(LocalJobRegistry,{})
 await f.ctx.plugin(TeamService,{maxMembers:6})
 f.ctx.on('approval/request',async()=> 'allowed-once' as const)
 let starts=0
 f.service.registerProvider({name:'claude-code',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){starts++;return {id:SessionId('delayed-external-child'),result:delayed?native.promise:Promise.resolve({output:[{type:'text',text:result}],stopReason:'completed' as const}),dispose:async()=>{}}}})
 await f.ctx.plugin(tool,{provider:'claude-code',toolName:'subagent_claude_code',maxDepth:'provider-managed'})
 const rows=new Map<string,TaskRunRuntimeLink>(),links:TaskRunRuntimeLinks={list:async input=>[...rows.values()].filter(row=>row.runId===input.runId&&(!input.kind||row.kind===input.kind)),put:async row=>{rows.set(row.kind+':'+row.nativeId,structuredClone(row))}}
 const background=createTaskRunBackground(f.ctx,links),control=registerExternalHarnessAdmission(f.ctx,{consent:createExternalHarnessConsent(f.ctx),authorize:async input=>({runId,requestId:rpc,reservationId:'external:'+createHash('sha256').update(JSON.stringify([taskRunRuntimeId,input.sessionId,input.callId,input.provider])).digest('hex'),runtimeId:taskRunRuntimeId,workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),reserve:async()=>{},save:async()=>{},links})
 t.after(async()=>{native.resolve({output:[],stopReason:'aborted'});await control.dispose();background.dispose()})
 let run={id:runId,taskId:'task',ownerId:'owner',sessionId:f.parent.id,nativeRequestId:rpc,state:'accepted',stopRequestedAt:null,executor:{kind:'owner',grantId:'grant',grantVersion:1},allowedTools:['subagent_claude_code'],skills:[],subagents:[],inputText:goal} as unknown as TaskRun
 const unexpected=async()=>{throw Error('本用例不派发受管 Team')}
 const delegation:SubagentDelegationPorts={limits:{maxDepth:1,maxPerRun:6},runId:async id=>id===f.parent.id?runId:undefined,reserve:unexpected,release:unexpected,bind:unexpected,settle:unexpected,abandon:unexpected}
 const readPolicy=async()=>({allowedTools:run.allowedTools,nativeRequestId:rpc})
 const taskTeam=createTaskRunTeam(f.ctx,delegation,readPolicy,links);t.after(taskTeam.dispose)
 t.after(registerTaskToolGuard(f.ctx,readPolicy,[],undefined,delegation,undefined,taskTeam))
 await background.start(run)
 const scripts=[call('subagent_claude_code','delayed-call',{prompt:goal,description:'合成外部执行'}),...delayed?[text('已派发，等待原生完成通知。')]:[],text(draft),call(deliveryReviewToolName,'review-r1',{phase:'revise',issues:[]}),call(deliveryReviewToolName,'review-r2',{phase:'verify',verdict:'accept',checks:['goal',1,2,3,4,5,6,7,8].map(id=>({id,status:'pass'})),changeChecks:[],findings:[]})]
 const resumed=deferred<void>()
 f.adapter.stream=async function*(options:GenerateOptions){
  f.adapter.requests.push(options)
  if(stopAfterExternal&&f.adapter.requests.length===3){
   assert.ok(options.signal);resumed.resolve()
   await new Promise<void>((_resolve,reject)=>{if(options.signal!.aborted)reject(options.signal!.reason);else options.signal!.addEventListener('abort',()=>reject(options.signal!.reason),{once:true})})
  }
  const next=scripts.shift();assert.ok(next,'不得追加模型请求');yield* next
 }
 const traces:DeliveryReviewTrace[]=[],release=leaseTaskDeliveryReview(f.parent,{runId,requestId:rpc,material:{goal,inputs:{knowledge:0,group:false,context:false},methods:[],catalog:createReviewSourceCatalog([{id:'goal',kind:'goal',title:'本人原指令',text:goal,origin:{field:'workRequest',pointer:'/sourceText'}}])},publish:async(message,signal)=>f.work.withNewInput(f.parent,message,{producer:'prompt',identity:message.id},()=>f.parent.inject(message),signal),trace:entry=>traces.push(entry),readExecution:async()=>{const proof=f.work.readReviewState(f.parent,rpc);return {runId,sessionId:f.parent.id,requestId:rpc,allowedTools:run.allowedTools,continuationMessageIds:new Set(proof.continuationMessageIds),runtimeLinks:[...rows.values()],jobs:[],pendingJobCompletion:proof.pendingJobCompletion,pendingInput:proof.pendingInput,children:'none',flow:'none'}}})
 t.after(release)
 const continuations=async(fixed:TaskRun,events:readonly SessionEvent[])=>new Set([...taskRunTeamContinuations(events,[]),...taskRunExternalContinuations(fixed,events,[...rows.values()])])
 let published:string|undefined
 const driver=new TaskRunDriver({get:async()=>run,executionScope:async()=>{throw Error('不重新领取')},claim:async()=>{throw Error('不重发')},requestStop:async()=>run,record:async(_owner,input)=>{const evidence=(input as {evidence:NonNullable<TaskRun['evidence']>}).evidence;run={...run,state:evidence.state,evidence};return run}},{check:async()=>{},send:async()=>{throw Error('不重发')},stop:async()=>{},events:async()=>f.events(),backgroundState:background.state,continuations,publishOwnerResult:async fixed=>{assert.ok(fixed.evidence?.state==='ended');published=readTaskRunGroupResult(f.events().slice(0,fixed.evidence.endSeq+1),rpc,await continuations(fixed,f.events()),undefined,{requireReview:true,runId})}})
 const sending=f.send(rpc,goal)
 if(delayed){
  await until(()=>f.parent.status==='idle'&&f.events().some(event=>event.type==='turn/end'))
  assert.equal(f.adapter.requests.length,2);assert.equal(traces.length,0,'占位不能消耗复核租约')
  const pending=await driver.reconcile('owner',{runId})
  if(stopAfterExternal){
   native.resolve({output:[{type:'text',text:result}],stopReason:'completed'})
   await resumed.promise
   await taskTeam.stop({...run,stopRequestedAt:'2026-10-17T00:00:00Z'},AbortSignal.timeout(5000))
   await sending;await f.parent.whenIdle()
   assert.equal(f.adapter.requests.length,3);assert.equal(starts,1);assert.equal(f.parent.status,'idle')
   assert.equal(f.events().filter(event=>event.type==='turn/end').at(-1)?.data.reason.kind,'aborted')
   assert.equal(traces.some(row=>row.state==='delivered'),false);assert.equal(published,undefined)
   return
  }
  const captured=deferred<void>(),releaseRead=deferred<void>(),readEvents=driver.ports.events
  let capturedEvents:readonly SessionEvent[]=[]
  driver.ports.events=async()=>{capturedEvents=[...f.events()];captured.resolve();await releaseRead.promise;return capturedEvents}
  const racing=driver.reconcile('owner',{runId})
  await captured.promise
  native.resolve({output:[{type:'text',text:result}],stopReason:'completed'})
  assert.equal(pending.state,'active','已派发未结束的真实external不能提前冻结第一turn')
  await f.service.waitForChildren(f.parent);await f.parent.whenIdle()
  assert.deepEqual(await taskTeam.continuations(f.parent,rpc,capturedEvents,run.allowedTools),new Set(),'守卫不把快照尚未包含的完成通知当作授权')
  releaseRead.resolve()
  await assert.rejects(racing,{code:'teloa/execution-pending'},'同一真实SDK完成写入晚于events快照时应待核，不能报数据损坏或冻结旧窗口')
  assert.equal(run.state,'active')
  driver.ports.events=readEvents
 }
 await sending
 await f.service.waitForChildren(f.parent);await f.parent.whenIdle()
 assert.equal(starts,1);assert.equal(f.adapter.requests.length,delayed?5:4);assert.ok(traces.some(row=>row.state==='delivered'))
 const complete=await driver.reconcile('owner',{runId});assert.equal(complete.state,'ended')
 const end=f.events().filter(event=>event.type==='turn/end').at(-1);assert.ok(end);assert.equal(complete.evidence?.state==='ended'&&complete.evidence.endSeq,end.seq)
 await driver.reconcile('owner',{runId});assert.equal(published,draft)
 assert.equal(readTaskRunGroupResult(JSON.parse(JSON.stringify(f.events())),rpc,await continuations(run,f.events()),undefined,{requireReview:true,runId}),draft)
 const events=f.events(),saved=[...rows.values()],external=saved.find(row=>row.kind==='external');assert.ok(external?.kind==='external')
 assert.deepEqual(await taskTeam.runContinuations(run,events),await continuations(run,events),'正式驱动共用严格外部续接真源')
 assert.deepEqual(await taskTeam.continuations(f.parent,rpc,events,run.allowedTools),await continuations(run,events),'守卫与驱动冻结范围一致')
 await assert.rejects(taskTeam.continuations(f.parent,rpc,events,[]),{code:'teloa/storage-corrupt'},'失去原工具授权不能仅借完成通知续接')
 for(const mode of delayed?['run','session','request','reservation','child','missing-catalog','missing-approval','rejected-approval','copied-source','duplicate-notice','changed-message','foreign-root']as const:[])await t.test('不把 '+mode+' 当作同Run完成',async()=>{
  const changed=structuredClone(events),links=structuredClone(saved),row=links.find(row=>row.kind==='external');assert.ok(row?.kind==='external')
  if(mode==='run')row.runId='foreign-run'
  if(mode==='session')row.sessionId='foreign-session'
  if(mode==='request')row.payload.requestId='foreign-request'
  if(mode==='reservation')row.nativeId='external:foreign'
  if(mode==='child')row.payload.activationId='foreign-child'
  if(mode==='missing-catalog'){const event=changed.find(event=>event.type==='subagent/catalog');assert.ok(event);Object.assign(event,{type:'session/title',data:{title:'无目录'}})}
  if(mode==='missing-approval'){const event=changed.find(event=>event.type==='approval/asked');assert.ok(event);Object.assign(event,{type:'session/title',data:{title:'无审批'}})}
  if(mode==='rejected-approval'){const event=changed.find(event=>event.type==='approval/decided');assert.ok(event?.type==='approval/decided');event.data.outcome='rejected'}
  if(mode==='copied-source'){const event=changed.find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.source.kind==='subagent-settled'));assert.ok(event?.type==='agent/inbox/spliced');event.data.inserted=[]}
  if(mode==='duplicate-notice'){const event=changed.find(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.source.kind==='subagent-settled'));assert.ok(event?.type==='agent/inbox/spliced');event.data.inserted.push(structuredClone(event.data.inserted[0]!))}
  if(mode==='changed-message'){const event=changed.find(event=>event.type==='user/message'&&event.data.source.kind==='subagent-settled');assert.ok(event?.type==='user/message');Reflect.set(event.data,'content',[{type:'text',text:'复制child身份但替换正文'}])}
  if(mode==='foreign-root'){const event=changed.find(event=>event.type==='user/message'&&event.data.source.kind==='user');assert.ok(event?.type==='user/message'&&event.data.source.kind==='user');Reflect.set(event.data.source,'rpcId','foreign-rpc')}
  assert.throws(()=>taskRunExternalContinuations(run,changed,links),{code:'teloa/storage-corrupt'})
  const tampered=createTaskRunTeam(f.ctx,delegation,readPolicy,{list:async()=>links,put:unexpected})
  try{await assert.rejects(tampered.continuations(f.parent,rpc,changed,run.allowedTools),{code:'teloa/storage-corrupt'})}finally{tampered.dispose()}
 })
})

test('真实provider启动失败无activation，保留原工具错误而不制造损坏或完成续轮',{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true),rpc='prepare-failed-rpc',runId='prepare-failed-run'
 const require=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json')),tool=await import(require.resolve('@deepseek-ai/dsh-tool-subagent'))
 await f.ctx.plugin(ApprovalService,{policy:'ask'});f.ctx.on('approval/request',async()=> 'allowed-once' as const)
 const failedWrite=deferred<void>(),finishFailure=deferred<void>()
 f.service.registerProvider({name:'claude-code',capabilities:{agentOptions:false,agentPreset:false,outputSchema:false,depthLimit:false},inheritsParentContext:false,async start(){throw Error('synthetic-provider-prepare-failed')}})
 await f.ctx.plugin(tool,{provider:'claude-code',toolName:'subagent_claude_code',maxDepth:'provider-managed'})
 const rows=new Map<string,TaskRunRuntimeLink>(),control=registerExternalHarnessAdmission(f.ctx,{consent:createExternalHarnessConsent(f.ctx),authorize:async input=>({runId,requestId:rpc,reservationId:'external:'+createHash('sha256').update(JSON.stringify([taskRunRuntimeId,input.sessionId,input.callId,input.provider])).digest('hex'),runtimeId:taskRunRuntimeId,workspaceRoot:await f.ctx.workingDirectory.ensure(f.parent,input.signal),provider:input.provider,assertCurrent(){}}),reserve:async()=>{},save:async metadata=>{if(metadata.status==='failed'){failedWrite.resolve();await finishFailure.promise}},links:{list:async()=>[...rows.values()],put:async row=>{rows.set(row.nativeId,structuredClone(row))}}})
 t.after(()=>control.dispose());f.adapter.parentScript=call('subagent_claude_code','prepare-failed-call',{prompt:goal,description:'准备失败'})
 const sending=f.send(rpc,goal);await failedWrite.promise
 const binding={id:runId,sessionId:f.parent.id,nativeRequestId:rpc,allowedTools:['subagent_claude_code']}
 let beforeReceipt:unknown
 try{taskRunExternalContinuations(binding,f.events(),[...rows.values()])}catch(error){beforeReceipt=error}
 finishFailure.resolve();await sending
 assert.ok(beforeReceipt instanceof Error&&Reflect.get(beforeReceipt,'code')==='teloa/execution-pending','失败登记已写但原生错误回执尚未追加时仍应待核')
 const stored=[...rows.values()],row=stored[0];assert.ok(row?.kind==='external');assert.equal(row.payload.status,'failed');assert.equal(row.payload.activationId,undefined)
 const events=f.events();assert.ok(events.some(event=>event.type==='tool/result'&&event.data.message.isError));assert.equal(events.some(event=>event.type==='subagent/catalog'),false)
 assert.equal(taskRunExternalContinuations(binding,events,stored).size,0)
 assert.throws(()=>taskRunExternalContinuations(binding,events,[{...row,payload:{...row.payload,status:'completed'}}]),{code:'teloa/storage-corrupt'},'无activation不能冒完成')
 const falseSuccess=structuredClone(events),receipt=falseSuccess.find(event=>event.type==='tool/result');assert.ok(receipt?.type==='tool/result');Reflect.set(receipt.data.message,'isError',false)
 assert.throws(()=>taskRunExternalContinuations(binding,falseSuccess,stored),{code:'teloa/storage-corrupt'},'无activation的失败登记须有真实错误回执')
})

test('外部后台读口区分当前活动、旧世代未知和错误归属',{timeout:10000},async t=>{
 const f=await nativeHotSubagentFixture(t,'one-shot',false,true)
 await f.ctx.plugin(LocalJobRegistry,{})
 const run={id:'run',sessionId:f.parent.id,nativeRequestId:'rpc'}
 const external:Extract<TaskRunRuntimeLink,{kind:'external'}>={kind:'external',runId:run.id,sessionId:run.sessionId,nativeId:'external:reservation',payload:{provider:'claude-code',runtimeId:taskRunRuntimeId,requestId:run.nativeRequestId,reservationId:'external:reservation',workspaceRoot:'/tmp/synthetic',status:'running'}}
 let row:TaskRunRuntimeLink=structuredClone(external)
 const background=createTaskRunBackground(f.ctx,{list:async()=>[row],put:async()=>{throw Error('只读状态不能写关联')}})
 t.after(background.dispose)
 assert.deepEqual(await background.state(run),{outstanding:true,interrupted:false})
 row={...external,payload:{...external.payload,runtimeId:'old-host'}}
 assert.deepEqual(await background.state(run),{outstanding:false,interrupted:true},'旧宿主未收口不冒当前仍在运行')
 row={...external,payload:{...external.payload,status:'unknown'}}
 assert.deepEqual(await background.state(run),{outstanding:false,interrupted:true})
 for(const changed of [{...external,runId:'other'},{...external,sessionId:'other'},{...external,payload:{...external.payload,requestId:'other'}}]){
  row=changed;await assert.rejects(background.state(run),{code:'teloa/storage-corrupt'})
 }
 assert.equal(f.adapter.requests.length,0)
})
