import {submissionFailureDiagnostic} from '../src/task-run-submission-diagnostic.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import type {TaskRun,TaskExecutionScope} from '@teloa/backend'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '@teloa/backend'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {LoopWorkAdapter,loopText} from './fixtures/native-loop-work-admission.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {createTaskRunHandler,taskRunEndpoints,taskRunOwnerEndpoint} from '../src/task-runs.ts'
import type {TaskRunService} from '@teloa/backend'
import {drainBusinessTaskSourceUpdates,type BusinessTaskSourceUpdatePorts} from '../src/business-source-update-driver.ts'

test('真实Loop发布前拒绝持久记未发布，迟到回调被关闭，恢复同请求只执行一次',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter()
 ctx.llm.registerAdapter(['loop-test'],adapter)
 ctx.provide('sessionController',{resolveAgent:async()=>({agent}),prompt:async()=>{throw Error('不得绕过固定模型')}} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const native=createNativeWorkInput(ctx,new WorkAccess());t.after(native.close)
 let late:(()=>void)|undefined,deny=true
 const input={withNewInput:async(...args:Parameters<typeof native.withNewInput>)=>{if(deny){late=args[3];throw Error('项目准入拒绝')}return native.withNewInput(...args)}}
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,input)
 let state:string|undefined,attempts=0
 const journal={begin:async()=>{assert.ok(state===undefined||state==='not-published');state='dispatching';attempts++;return {attemptId:randomUUID()}},finish:async(_attempt:unknown,outcome:string)=>{state=outcome},recoverable:async()=>state==='not-published'}
 Object.assign(ports,{submissions:journal})
 const run={id:randomUUID(),taskId:randomUUID(),taskVersion:1,linkVersion:1,sessionId:agent.id,nativeRequestId:randomUUID(),state:'submitting',stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[],inputText:'同一告警固定快照',modelPolicy:{primary:{provider:'loop-test',model:'one'}}} as unknown as TaskRun
 const target:TaskExecutionScope={taskId:run.taskId,taskVersion:1,sessionId:agent.id,linkVersion:1,scope:'SOC'},signal=AbortSignal.timeout(20000)
 await assert.rejects(ports.send(run,signal,target),(error:unknown)=>{assert.deepEqual(submissionFailureDiagnostic(error),{phase:'native-input',category:'Error',code:'teloa/execution-pending'});return error instanceof Error&&/项目准入拒绝/.test(error.message)})
 assert.equal(state,'not-published','拒绝必须由正式发布边界记录，不能一直提交未知')
 assert.throws(()=>late!(),{code:'teloa/conflict'},'失败后保留的异步回调不能迟到发布')
 assert.equal(adapter.requests.length,0)
 deny=false;adapter.scripts.push(loopText)
 await ports.send(run,signal,target);await agent.whenIdle()
 assert.equal(state,'accepted');assert.equal(attempts,2);assert.equal(adapter.requests.length,1)
 assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='user/message'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===run.nativeRequestId).length,1)
})

test('发布原语已进入后的回包丢失保持未知，真实Loop没有第二次输入',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),adapter=new LoopWorkAdapter()
 ctx.llm.registerAdapter(['loop-test'],adapter)
 ctx.provide('sessionController',{resolveAgent:async()=>({agent})} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:unknown)=>structuredClone(content)} as never)
 const native=createNativeWorkInput(ctx,new WorkAccess());t.after(native.close)
 const ports=dshTaskRunPorts(ctx,'owner',async sessionId=>({ownerId:'owner',sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,{withNewInput:async(...args:Parameters<typeof native.withNewInput>)=>{await native.withNewInput(...args);throw Error('受理后丢失回包')}})
 let state:string|undefined
 Object.assign(ports,{submissions:{begin:async()=>{assert.equal(state,undefined);state='dispatching';return {attemptId:randomUUID()}},finish:async(_ticket:unknown,result:string)=>{state=result},recoverable:async()=>state==='not-published'}})
 const run={id:randomUUID(),taskId:randomUUID(),taskVersion:1,linkVersion:1,sessionId:agent.id,nativeRequestId:randomUUID(),state:'submitting',stopRequestedAt:null,allowedTools:[],skills:[],knowledge:[],inputText:'发布后故障',modelPolicy:{primary:{provider:'loop-test',model:'one'}}} as unknown as TaskRun
 adapter.scripts.push(loopText)
 await assert.rejects(ports.send(run,AbortSignal.timeout(10000),{taskId:run.taskId,taskVersion:1,sessionId:agent.id,linkVersion:1,scope:'SOC'}),/受理后丢失回包/)
 await agent.whenIdle();assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>Reflect.get(message.source,'rpcId')===run.nativeRequestId)).length,1);assert.ok(adapter.requests.length<=1);assert.equal(state,'dispatching')
 assert.equal(await ports.submissions!.recoverable(run),false)
})

test('driver只沿持久未发布回执恢复原Run，仍重新核对当前范围和控制',async()=>{
 let current={id:'run',taskId:'task',sessionId:'session',nativeRequestId:'native',state:'submitting',stopRequestedAt:null,allowedTools:['bash'],inputText:'原固定输入'} as TaskRun,claims=0,sends=0,checks=0
 const target={taskId:'task',taskVersion:1,sessionId:'session',linkVersion:1,scope:'SOC'}
 const driver=new TaskRunDriver({get:async()=>current,executionScope:async()=>target,claim:async()=>{claims++;throw Error('恢复不能重新领取或改版本')},record:async()=>current={...current,state:'accepted',evidence:{state:'accepted'}},requestStop:async()=>current},{check:async()=>{checks++},send:async run=>{assert.equal(run,current);sends++},events:async()=>[],stop:async()=>{},submissions:{recoverable:async()=>true,begin:async()=>{throw Error('此夹具仅验证driver')},finish:async()=>{}}})
 assert.equal((await driver.start('owner',{runId:'run'},new AbortController().signal)).state,'accepted')
 assert.deepEqual({claims,sends,checks},{claims:0,sends:1,checks:1})
})

test('本人处置接口先持久停止意图，空闲取消冲突仍必须经过正式栅栏且坏请求不停止',async()=>{
 let run={id:randomUUID(),sessionId:'original',nativeRequestId:randomUUID(),state:'submitting',evidence:null,stopRequestedAt:null} as TaskRun,stops=0,fences=0
 const requestId=randomUUID(),service={get:async()=>run,requestStop:async()=>{stops++;return run={...run,stopRequestedAt:new Date().toISOString()}}} as unknown as TaskRunService
 const ports={check:async()=>{},send:async()=>assert.fail('未知不能重发'),events:async()=>[],stop:async()=>{throw Error('没有可取消的原生轮次')},disposeSubmission:async(original:TaskRun)=>{assert.equal(original.stopRequestedAt,run.stopRequestedAt);assert.ok(original.stopRequestedAt);fences++;return run={...run,state:'submission_unknown',submissionDisposition:{requestId} as never}}}
 const handle=createTaskRunHandler('owner',async()=>service,ports),signal=new AbortController().signal
 assert.equal(taskRunEndpoints.some(value=>String(value)===taskRunOwnerEndpoint),false,'本人处置不能成为模型可调用接口')
 for(const command of [{requestId,runId:run.id,acknowledgeUnknown:false},{requestId:'invalid',runId:run.id,acknowledgeUnknown:true},{requestId,runId:run.id,acknowledgeUnknown:true,proof:'客户端证明'}])await assert.rejects(handle(taskRunOwnerEndpoint,command,signal))
 assert.equal(stops,0)
 assert.equal((await handle(taskRunOwnerEndpoint,{requestId,runId:run.id,acknowledgeUnknown:true},signal) as TaskRun).state,'submission_unknown')
 assert.deepEqual({stops,fences},{stops:1,fences:1})
 await handle(taskRunOwnerEndpoint,{requestId,runId:run.id,acknowledgeUnknown:true},signal)
 assert.deepEqual({stops,fences},{stops:1,fences:1},'回包丢失按原请求幂等读取，不重复处置')
})

test('同源续报遇到已处置的未知Run转为等待本人，不能冒充受理或再次发送',async()=>{
 const settled:unknown[]=[],row={id:'update',taskId:'task',taskVersion:2,state:'continued',runId:'original-run'}
 const ports={updates:{pending:async()=>[row],continueTask:async()=>row,settle:async(_owner:string,value:unknown)=>{settled.push(value)}},prepare:async()=>assert.fail('不能新建'),start:async()=>assert.fail('不能重发'),readRun:async()=>({state:'submission_unknown',nativeRequestId:'original-request'}),reconcile:async()=>assert.fail('未知处置已经终结，不再自动核验'),report:()=>{}} as unknown as BusinessTaskSourceUpdatePorts
 await drainBusinessTaskSourceUpdates('owner',ports,new AbortController().signal)
 assert.deepEqual(settled,[{id:'update',state:'needs-user',runId:'original-run',reason:'teloa/submission-unknown'}])
})

test('确定未发布的停止沿原宿主栅栏取消，不对空原生轮次重复cancel/send',async()=>{
 let run={id:randomUUID(),state:'submitting',evidence:null,stopRequestedAt:null} as TaskRun,cancelled=0
 const driver=new TaskRunDriver({get:async()=>run,requestStop:async()=>run={...run,stopRequestedAt:new Date().toISOString()}} as never,{
  submissions:{publicationState:async()=> 'not-published',recoverable:async()=>false,begin:async()=>assert.fail('不重发'),finish:async()=>{}},
  cancelNotPublishedSubmission:async(fixed:TaskRun)=>{assert.ok(fixed.stopRequestedAt);cancelled++;return run={...fixed,state:'withdrawn'}},
  stop:async()=>assert.fail('未发布不能要求存在原生active轮次'),send:async()=>assert.fail('不能发模型'),check:async()=>{},events:async()=>[]
 } as never)
 assert.equal((await driver.stop('owner',{runId:run.id},new AbortController().signal)).state,'withdrawn')
 assert.equal((await driver.stop('owner',{runId:run.id},new AbortController().signal)).state,'withdrawn')
 assert.equal(cancelled,1)
})

test('运行列表停止后仍保留确定未发布事实，重发许可仍单独拒绝',async()=>{
 const run={id:randomUUID(),state:'submitting',evidence:null,stopRequestedAt:new Date().toISOString()} as TaskRun
 const handle=createTaskRunHandler('owner',async()=>({list:async()=>[run]}) as never,{
  submissions:{publicationState:async()=> 'not-published',recoverable:async()=>false,begin:async()=>assert.fail(),finish:async()=>{}}
 } as never)
 const rows=await handle('task-runs/list',{taskId:randomUUID()},new AbortController().signal) as Array<TaskRun&{submissionRecovery:string}>
 assert.equal(rows[0]!.submissionRecovery,'not-published')
 assert.equal(rows[0]!.stopRequestedAt,run.stopRequestedAt)
})

test('已取消的同源续报仅记等待本人，不因新轮询再次prepare或start',async()=>{
 const settled:unknown[]=[],row={id:'update',taskId:'task',taskVersion:2,state:'continued',runId:'cancelled-run'}
 const ports={updates:{pending:async()=>[row],continueTask:async()=>row,settle:async(_owner:string,value:unknown)=>{settled.push(value)}},prepare:async()=>assert.fail('取消后不能自动新建'),start:async()=>assert.fail('取消后不能自动重发'),readRun:async()=>({state:'withdrawn',nativeRequestId:'cancelled-native'}),reconcile:async()=>assert.fail('取消已终态，不重核原生'),report:()=>{}} as unknown as BusinessTaskSourceUpdatePorts
 await drainBusinessTaskSourceUpdates('owner',ports,new AbortController().signal)
 assert.deepEqual(settled,[{id:'update',state:'needs-user',runId:'cancelled-run',reason:'teloa/run-not-accepted'}])
})
