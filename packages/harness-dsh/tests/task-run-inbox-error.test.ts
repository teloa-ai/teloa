import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {withAcceptedInboxErrorFence,type AcceptedInboxErrorFence,type TaskRun} from '@teloa/backend'
import {acceptedInboxErrorEvidence} from '../src/task-run-inbox-error.ts'
import {TaskRunDriver} from '../src/task-run-driver.ts'
import {runBudgetTerminal} from '../src/resident-model-budget.ts'
import {assertSafeTaskRunRetry} from '../src/task-run-retry-proof.ts'
import {createNativeInputGuard,nativeInputIdentity} from '../src/native-input-access.ts'
import {patchedSessionFixture} from './fixtures/native-final-session.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {createTaskRunBackground} from '../src/task-run-background.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {assertTaskRunQuiescentEvents} from '../src/task-run-source-followup.ts'
import {readEndedTaskRunSession} from '../src/task-run-cold-session.ts'

const sha=(s:string)=>createHash('sha256').update(s).digest('hex')
function fixture(){
 const run={id:randomUUID(),taskId:randomUUID(),sessionId:'session',nativeRequestId:randomUUID(),inputText:'合成原始输入',state:'accepted',evidence:{state:'accepted'},stopRequestedAt:null,allowedTools:[],skills:[]} as unknown as TaskRun
 const message=createUserMessage({content:[{type:'text',text:run.inputText},{type:'text',text:'合成元数据'}],source:{kind:'user',rpcId:run.nativeRequestId}})
 const events=[{seq:0,time:1,type:'session/end-seed',data:{}},{seq:1,time:2,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:0,inserted:[message]}},{seq:2,time:3,type:'turn/start',data:{turn:1}},{seq:3,time:4,type:'agent/inbox/spliced',data:{target:'next-turn',start:0,removedCount:1,inserted:[]}},{seq:4,time:5,type:'turn/end',data:{turn:1,reason:{kind:'error',error:{code:'UNKNOWN',message:'合成准备失败'}}}}] as SessionEvent[]
 return {run,events,message}
}
test('149 唯一受理、同队列消费和实际error生成显式锚点；完整载荷而非假user消息',()=>{
 const f=fixture(),e=acceptedInboxErrorEvidence(f.run,f.events)!
 assert.equal(e.reason,'error');assert.equal(e.messageSeq,1);assert.equal(e.inputAnchor.acceptedSeq,1)
 assert.equal(e.inputAnchor.messageId,f.message.id);assert.equal(e.inputAnchor.payloadSha256,nativeInputIdentity(f.message).payloadSha256)
 assert.equal(e.inputAnchor.prefixSha256,sha(JSON.stringify(f.events)))
 assert.equal(f.events.some(e=>e.type==='user/message'),false)
 for(const alter of [
  (g:ReturnType<typeof fixture>)=>{g.events[1]!.data={...g.events[1]!.data,target:'next-step'} as never},
  (g:ReturnType<typeof fixture>)=>{g.events[3]!.data={...g.events[3]!.data,removedCount:0} as never},
  (g:ReturnType<typeof fixture>)=>{g.events[3]!.data={...g.events[3]!.data,outcome:'canceled'} as never},
  (g:ReturnType<typeof fixture>)=>{g.events[1]!.data={...g.events[1]!.data,inserted:[{...g.message,source:{kind:'user',rpcId:randomUUID()}}]} as never},
  (g:ReturnType<typeof fixture>)=>{g.events[1]!.data={...g.events[1]!.data,inserted:[{...g.message,content:[{type:'text',text:'被更换的输入'}]}]} as never},
  (g:ReturnType<typeof fixture>)=>{g.events[4]!.data={turn:2,reason:{kind:'error',error:{code:'UNKNOWN',message:'不归本轮'}}} as never},
  (g:ReturnType<typeof fixture>)=>{g.events[4]!.data={turn:1,reason:{kind:'completed'}} as never},
  (g:ReturnType<typeof fixture>)=>{g.events.push({...g.events[4]!,seq:SessionSeq(5)})},
  (g:ReturnType<typeof fixture>)=>{g.events[3]={seq:SessionSeq(3),time:4,type:'user/message',surfaceOp:'append',data:g.message}},
 ]){const g=fixture();alter(g);assert.equal(acceptedInboxErrorEvidence(g.run,g.events),null)}
 assert.equal(acceptedInboxErrorEvidence(f.run,f.events,1),null)
})

test('149 Driver通过内部fence收口且不调用普通record/send/publish；新budget锚点不冒充user',async()=>{
 const f=fixture(),e=acceptedInboxErrorEvidence(f.run,f.events)!,runtimeId=randomUUID();let records=0
 const deny=async()=>{throw Error('不得发送、完成发布或走普通证据口')}
 const ports={check:deny,send:deny,stop:deny,events:async()=>f.events,backgroundState:async()=>({outstanding:false,interrupted:false}),subagentState:async()=> 'none' as const,flowState:async()=> 'none' as const,stopState:async()=>({running:false,settledSeq:4}),goalObservation:async()=>undefined,retryOwnerOnlyBackground:async()=>true,publishOwnerResult:deny,publishGroupResult:deny,withAcceptedInboxFailureFence:async<T>(_run:TaskRun,_signal:AbortSignal,work:(v:AcceptedInboxErrorFence)=>Promise<T>)=>withAcceptedInboxErrorFence({runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,runtimeId,inputSha256:sha(f.run.inputText),endedAt:new Date(5).toISOString(),evidence:e},()=>{},work)}
 const service={get:async()=>f.run,record:deny,recordAcceptedInboxFailure:async()=>{records++;f.run={...f.run,state:'ended',evidence:e};return f.run}}
 const driver=new TaskRunDriver(service as never,ports)
 const result=await driver.reconcile('owner',{runId:f.run.id})
 await driver.reconcile('owner',{runId:f.run.id})
 assert.equal(result.state,'ended');assert.equal(records,1)
 const terminal=runBudgetTerminal(result,{sessionId:result.sessionId,events:f.events,inheritedEventCount:0})!
 assert.deepEqual(terminal.inputAnchor,e.inputAnchor);assert.equal(terminal.turnEndSeq,4)
 assert.doesNotThrow(()=>assertTaskRunQuiescentEvents(result,f.events,[result]))
 await assertSafeTaskRunRetry(result,ports as never,new AbortController().signal,{subagents:[],webAccess:[]})
 result.stopRequestedAt=new Date(5).toISOString()
 await assert.rejects(assertSafeTaskRunRetry(result,ports as never,new AbortController().signal,{subagents:[],webAccess:[]}))
})

test('149 真实final append短Session栅栏覆盖异步read/write/commit失败，finally释放且不影响另一Session',async t=>{
 const {ctx,agent,other}=await patchedSessionFixture(t)
 const guard=createNativeInputGuard(ctx,{final:true}),input=createUserMessage({content:[{type:'text',text:'新正常输入'}],source:{kind:'user',rpcId:'new'}})
 for(const phase of ['read','write','commit','cancel']){
  const before=agent.session.seq
  await assert.rejects(agent.runMaintenance(()=>guard.withQuiescentSession(agent.session,()=>assert.equal(agent.status,'idle'),async()=>{
   await Promise.resolve()
   assert.throws(()=>guard.withSyncLease(agent.session,nativeInputIdentity(input),{assertCurrent(){}},()=>agent.inbox.append('next-turn',input)),{code:'teloa/forbidden'})
   assert.equal(agent.session.seq,before)
   other.session.append('session/end-seed',{})
   throw Error(phase)
  })),new RegExp(phase))
  guard.withSyncLease(agent.session,nativeInputIdentity(input),{assertCurrent(){}},()=>agent.inbox.append('next-turn',input))
  assert.equal(agent.inbox.nextTurn.length,1);agent.inbox.splice('next-turn',0,1,[])
 }
})

test('149 真实SDK pre-step失败无user/model，正常DSH端口只在原Agent/空队列/持久稳定时签fence',async t=>{
 const {ctx,agent,sessions}=await patchedSessionFixture(t),runtimeId=randomUUID(),f=fixture()
 f.run.sessionId=agent.id
 ctx.provide('jobs',{list:()=>[],events:{subscribe:()=>()=>{}},get:()=>{throw Error('没有Job')}} as never)
 const native=createNativeWorkInput(ctx,{authorize:async()=>({assertCurrent(){}}),authorizeSessionCapabilities:async()=>({assertCurrent(){}})} as never)
 const release=agent.ctx.on('agent/pre-step',()=>{throw Error('合成预消息失败')})
 const message=createUserMessage({content:[{type:'text',text:f.run.inputText}],source:{kind:'user',rpcId:f.run.nativeRequestId}})
 await native.withNewInput(agent,message,{producer:'task-run',identity:f.run.id},()=>agent.followup(message))
 await agent.whenIdle();release()
 const events=readSessionEvents(agent.session)
 const e=acceptedInboxErrorEvidence(f.run,events)!
 assert.ok(e);assert.equal(events.some(e=>e.type==='user/message'||e.type==='request/header'||e.type.startsWith('tool/')),false)
 // 只替换本例持久化端口；Agent/Inbox/最终Append/DSH factory均为实际实现。
 Object.defineProperty(sessions,'flush',{configurable:true,writable:true,value:async()=>true})
 const links={list:async()=>[{runId:f.run.id,nativeId:'owner:'+runtimeId+':'+agent.id,sessionId:agent.id,kind:'job' as const,payload:{record:'owner' as const,runtimeId,requestId:f.run.nativeRequestId}}],put:async()=>{throw Error('不能新增运行关联')}}
 const ports=dshTaskRunPorts(ctx,'owner',async()=>({ownerId:'owner',sessionId:agent.id,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,native,undefined,runtimeId)
 ports.subagentState=async()=> 'none';ports.flowState=async()=> 'none'
 let entered=0
 const proof=await ports.withAcceptedInboxFailureFence!(f.run,new AbortController().signal,async fence=>{entered++;assert.deepEqual(fence.evidence,e);assert.throws(()=>agent.session.append('session/end-seed',{}),{code:'teloa/forbidden'});return fence.evidence})
 assert.deepEqual(proof,e);assert.equal(entered,1)
 ports.flowState=async()=> 'outstanding'
 assert.equal(await ports.withAcceptedInboxFailureFence!(f.run,new AbortController().signal,async()=>{throw Error('活动flow不可进入')}),null)
 ports.flowState=async()=> 'none'
 // 栅栏工作抛错之后也必须释放，正常元数据可继续写入。
 await assert.rejects(ports.withAcceptedInboxFailureFence!(f.run,new AbortController().signal,async()=>{throw Error('DB rejected')}),/DB rejected/)
 agent.session.append('session/end-seed',{})
})

test('149 冷error读取沿真实Session及Inbox投影，不创建Agent；合法emptyseed后缀仍可读',async t=>{
 const {ctx,agent}=await patchedSessionFixture(t),f=fixture();f.run.sessionId=agent.id
 const e=acceptedInboxErrorEvidence(f.run,f.events)!
 const run={...f.run,state:'ended',evidence:e,stopRequestedAt:new Date(6).toISOString()}
 const events=[...f.events,{seq:SessionSeq(5),time:6,type:'session/end-seed' as const,data:{}}]
 let snapshots=0
 ctx.provide('sessionController',{inspect:async()=>{snapshots++;return {meta:agent.session.header,inheritedEventCount:0,events}}} as never)
 const before=ctx.agents.get(agent.id)
 const cold=await readEndedTaskRunSession(ctx,run)
 assert.deepEqual(cold.inbox,{'next-turn':[],'next-step':[]});assert.equal(snapshots,1);assert.equal(ctx.agents.get(agent.id),before)
 ctx.provide('jobs',{list:()=>[],events:{subscribe:()=>()=>{}},get:()=>{throw Error('没有Job')}} as never)
 const oldRuntime=randomUUID(),background=createTaskRunBackground(ctx,{list:async()=>[{runId:run.id,sessionId:run.sessionId,nativeId:'owner:'+oldRuntime+':'+run.sessionId,kind:'job',payload:{record:'owner',runtimeId:oldRuntime,requestId:run.nativeRequestId}}],put:async()=>{throw Error('只读不能注册')}},undefined,randomUUID())
 t.after(background.dispose)
 const state=await background.state(run);assert.equal(state.interrupted,true)
 const deny=async()=>{throw Error('不能执行')}
 let exactReads=0
 const ports={check:deny,send:deny,stop:deny,events:async()=>events,backgroundState:async()=>background.state(run),subagentState:async()=> 'none' as const,flowState:async()=> 'none' as const,goalObservation:async()=>undefined,stopState:async()=>{const read=await readEndedTaskRunSession(ctx,run);return {running:read.inbox['next-turn'].length!==0,settledSeq:e.endSeq}},retryOwnerOnlyBackground:async()=>{exactReads++;return background.retryOwnerOnly(run)}}
 await assertSafeTaskRunRetry({...run,stopRequestedAt:null},ports,new AbortController().signal,{subagents:[],webAccess:[]})
 assert.equal(exactReads,2)
 events[5]={seq:SessionSeq(5),time:6,type:'turn/start',data:{turn:2}} as never
 await assert.rejects(readEndedTaskRunSession(ctx,run),{code:'teloa/session-unavailable'})
})
