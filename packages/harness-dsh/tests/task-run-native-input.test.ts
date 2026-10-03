import test from 'node:test'
import assert from 'node:assert/strict'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry,type Agent} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import {LlmAdapter,LlmRuntime,createUserMessage,type UserMessage} from '@deepseek-ai/dsh-llm'
import {SessionId,SessionSeq,SessionLogOffset,type SessionStore} from '@deepseek-ai/dsh-session'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import type {TaskExecutionScope,TaskRun} from '@teloa/backend'
import {WorkAccess,type WorkAccessRequest} from '../../backend/src/work/work-access.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'
import {patchedSessionPackage} from './fixtures/native-final-session.ts'

const deferred=<T=void>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done});return {promise,resolve}}
const forbidden={code:'teloa/forbidden'}
class NoModel extends LlmAdapter{
 calls=0
 override async resolveModel(provider:string,model:string){return {provider,id:model,name:model}}
 async *stream():AsyncIterable<never>{this.calls++;throw Error('任务准入测试不得调用模型')}
}

async function fixture(t:{after:(action:()=>unknown)=>void},managed=true,inherited=false){
 const sessionPackage=await patchedSessionPackage(t),ctx=new Context(),publication=deferred(),published=deferred<Agent>()
 for(const plugin of [LlmRuntime,sessionPackage.SessionStore,SessionProjectionRegistry,SystemPrompt,ToolRuntime,AgentRegistry])await ctx.plugin(plugin)
 await ctx.plugin(AgentLoop,{agents:[]})
 const model=new NoModel();ctx.llm.registerAdapter(['controlled'],model)
 // 使用官方发布屏障持有驱动，保留真实 followup/Inbox，禁止任何模型或轮次启动。
 ctx.on('agent/created',async({agent})=>{published.resolve(agent);await publication.promise})
 const original=createUserMessage({source:{kind:'user',rpcId:'request-fixed'},content:[{type:'text',text:'accepted only in the parent'}]})
 const seed=[{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},{type:'user/message',seq:SessionSeq(1),time:1,data:original,surfaceOp:'append'},{type:'turn/end',seq:SessionSeq(2),time:1,data:{turn:1,reason:{kind:'completed'}}}] as const
 const creating=ctx.agents.create({sessionId:SessionId('task-native-session'),agentOptions:{provider:'controlled',model:'fixed'},...(inherited?{meta:{isSeeded:true,parentSession:SessionId('task-native-parent')},seed,inheritedEventCount:SessionLogOffset(seed.length)}:{})})
 const agent=await published.promise
 t.after(async()=>{const disposing=ctx.fiber.dispose();publication.resolve();await Promise.allSettled([creating,disposing]);assert.equal(model.calls,0)})
 const state={attachments:0,controllerPrompts:0,owner:'owner',resolved:undefined as Agent|undefined,admitted:undefined as UserMessage['content']|undefined}
 ctx.provide('sessionController',{resolveAgent:async(id:string)=>{assert.equal(id,agent.id);return {agent:state.resolved??agent}},prompt:async()=>{state.controllerPrompts++;throw Error('local-routing 不得回退 Controller')}} as never)
 ctx.provide('attachments',{admitPromptContent:async(content:UserMessage['content'])=>{state.attachments++;return state.admitted??structuredClone(content)}} as never)
 const access=new WorkAccess(),nativeInput=managed?createNativeWorkInput(ctx,access):undefined
 const ports=dshTaskRunPorts(ctx,'owner',async(sessionId)=>({ownerId:state.owner,sessionId,status:'ready'}),undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,nativeInput)
 const run={id:'run-fixed',taskId:'task-fixed',taskVersion:3,linkVersion:2,sessionId:agent.id,nativeRequestId:'request-fixed',inputText:'固定任务输入',allowedTools:[],skills:[],knowledge:[],modelPolicy:{primary:{provider:'controlled',model:'fixed'}}} as unknown as TaskRun
 const target:TaskExecutionScope={taskId:run.taskId,taskVersion:run.taskVersion,sessionId:agent.id,linkVersion:run.linkVersion,scope:'SOC'}
 const before=agent.session.snapshotEvents().length,signal=new AbortController().signal
 const zero=()=>{assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0);assert.equal(agent.inbox.nextStep.length,0)}
 return {ctx,agent,state,access,nativeInput,ports,run,target,before,signal,zero}
}

test('Task local-routing 等待实际 WorkAccess 后提交 exact 消息至官方 Session/Inbox',async t=>{
 const e=await fixture(t),entered=deferred(),release=deferred(),seen:WorkAccessRequest[]=[]
 e.access.requirePolicy();e.access.installPolicy(async request=>{seen.push(request);entered.resolve();await release.promise;return {assertCurrent:()=>{}}})
 const pending=e.ports.send(e.run,e.signal,e.target)
 await entered.promise;e.zero();assert.equal(seen.length,1)
 const request=seen[0] as Extract<WorkAccessRequest,{kind:'native-input'}>
 assert.equal(request.kind,'native-input');assert.equal(request.producer,'task-run');assert.equal(request.sessionId,e.agent.id);assert.equal(request.nativeRequestId,e.run.nativeRequestId)
 assert.equal(Object.isFrozen(request),true);assert.match(request.payloadSha256,/^[a-f0-9]{64}$/);assert.match(request.contextSha256,/^[a-f0-9]{64}$/)
 release.resolve();await pending
 const input=e.agent.inbox.nextTurn[0]!
 assert.equal(input.id,request.messageId);assert.equal(Reflect.get(input.source,'rpcId'),e.run.nativeRequestId);assert.equal(nativeInputIdentity(input,e.run.nativeRequestId).payloadSha256,request.payloadSha256)
 assert.equal(input.content[0]?.type,'text');assert.equal((input.content[0] as {text:string}).text,e.run.inputText)
 const events=e.agent.session.snapshotEvents().slice(e.before)
 assert.equal(events.length,1);assert.equal(events[0]?.type,'agent/inbox/spliced');assert.equal(e.state.controllerPrompts,0)
})

test('等待许可时撤销或取消均拒绝，真实 Session 和 Inbox 零写',async t=>{
 for(const reason of ['revoked','aborted']){
  const e=await fixture(t),entered=deferred(),release=deferred(),abort=new AbortController();let valid=true
  e.access.requirePolicy();e.access.installPolicy(async()=>{entered.resolve();await release.promise;return {assertCurrent:()=>{if(!valid)throw Error('revoked')}}})
  const pending=e.ports.send(e.run,abort.signal,e.target),rejected=assert.rejects(pending,forbidden)
  await entered.promise;e.zero();if(reason==='revoked')valid=false;else abort.abort()
  release.resolve();await rejected;e.zero()
 }
})

test('dispatch 后撤销仍由最终同步闸拒绝，失败后同请求可以重新申请且仅写一次',async t=>{
 const e=await fixture(t);let valid=true,deny=true,calls=0
 e.access.installPolicy(async()=>{calls++;return {assertCurrent:()=>{if(!valid)throw Error('revoked')}}})
 e.ctx.on('internal/dispatch',(_mode,name,args)=>{if(deny&&name==='session/event'&&args[1]?.type==='agent/inbox/spliced')valid=false})
 await assert.rejects(e.ports.send(e.run,e.signal,e.target),forbidden);e.zero();assert.equal(calls,1)
 valid=true;deny=false;await e.ports.send(e.run,e.signal,e.target)
 assert.equal(calls,2);assert.equal(e.agent.inbox.nextTurn.length,1);assert.equal(e.agent.session.snapshotEvents().length,e.before+1)
})

test('同 session/rpc 并发串行，首条受理后到期第二调用只返回原回执',async t=>{
 const e=await fixture(t),entered=deferred(),release=deferred();let valid=true,calls=0
 e.access.installPolicy(async()=>{calls++;entered.resolve();await release.promise;return {assertCurrent:()=>{if(!valid)throw Error('expired')}}})
 e.ctx.on('session/event',(_session,event)=>{if(event.type==='agent/inbox/spliced'&&event.data.inserted.length)valid=false})
 const first=e.ports.send(e.run,e.signal,e.target),second=e.ports.send(e.run,e.signal,e.target)
 await entered.promise;await new Promise<void>(done=>setImmediate(done));assert.equal(calls,1);e.zero()
 release.resolve();await Promise.all([first,second])
 assert.equal(valid,false);assert.equal(calls,1);assert.equal(e.state.attachments,1);assert.equal(e.agent.inbox.nextTurn.length,1)
 assert.equal(e.agent.session.snapshotEvents().length,e.before+1)
})

test('官方三处已有 user rpc 回执不需要新许可，其他身份仍拒绝',async t=>{
 for(const location of ['next-turn','next-step','history']){
  const e=await fixture(t),message=createUserMessage({source:{kind:'user',rpcId:e.run.nativeRequestId},content:[{type:'text',text:'此前已受理'}]})
  if(location==='history')e.agent.session.append('user/message',message,{surfaceOp:'append'})
  else await e.nativeInput!.withNewInput(e.agent,message,{producer:'queue',identity:'original-admitted-request'},()=>{e.agent.inbox.append(location as 'next-turn'|'next-step',message)})
  e.access.requirePolicy() // 故意不安装策略；旧回执若误授权会失败。
  const before=e.agent.session.snapshotEvents().length
  await e.ports.send(e.run,e.signal,e.target)
  assert.equal(e.agent.session.snapshotEvents().length,before);assert.equal(e.state.attachments,0)
  await assert.rejects(e.ports.send(e.run,e.signal,{...e.target,taskId:'other'}),forbidden)
  e.state.owner='other';await assert.rejects(e.ports.send(e.run,e.signal,e.target),forbidden)
 }
})

test('插件 source/rpc 不能冒充已受理用户回执',async t=>{
 const e=await fixture(t),message=createUserMessage({source:{kind:'plugin',plugin:'fixture',rpcId:e.run.nativeRequestId} as never,content:[{type:'text',text:'插件通知'}]})
 e.agent.session.append('user/message',message,{surfaceOp:'append'});e.access.requirePolicy()
 await assert.rejects(e.ports.send(e.run,e.signal,e.target),{code:'teloa/conflict'})
 assert.equal(e.state.attachments,0);assert.equal(e.agent.inbox.nextTurn.length,0)
})

test('等待期间原 Run/cause 与附件数组变更不移植请求或最终载荷',async t=>{
 const e=await fixture(t),entered=deferred(),release=deferred(),seen:WorkAccessRequest[]=[]
 e.access.installPolicy(async request=>{seen.push(request);entered.resolve();await release.promise;return {assertCurrent:()=>{}}})
 const pending=e.ports.send(e.run,e.signal,e.target)
 await entered.promise;e.run.nativeRequestId='changed';e.run.inputText='changed';e.target.taskId='changed'
 release.resolve();await pending
 assert.equal(Reflect.get(e.agent.inbox.nextTurn[0]!.source,'rpcId'),'request-fixed');assert.equal((e.agent.inbox.nextTurn[0]!.content[0] as {text:string}).text,'固定任务输入')
 assert.equal((seen[0] as Extract<WorkAccessRequest,{kind:'native-input'}>).nativeRequestId,'request-fixed')
 const changed=await fixture(t),wait=deferred(),ready=deferred()
 changed.state.admitted=[{type:'text',text:'admitted-fixed'}]
 changed.access.installPolicy(async()=>{ready.resolve();await wait.promise;return {assertCurrent:()=>{}}})
 const mutation=changed.ports.send(changed.run,changed.signal,changed.target)
 await ready.promise;(changed.state.admitted[0] as {text:string}).text='changed-after-proof'
 wait.resolve();await mutation;assert.equal((changed.agent.inbox.nextTurn[0]!.content[0] as {text:string}).text,'admitted-fixed');assert.equal(changed.agent.session.snapshotEvents().length,changed.before+1)
})

test('许可等待期间会话变忙，新 Task 输入拒绝且不增加原生写入',async t=>{
 const e=await fixture(t),entered=deferred(),release=deferred()
 e.access.installPolicy(async()=>{entered.resolve();await release.promise;return {assertCurrent:()=>{}}})
 const pending=e.ports.send(e.run,e.signal,e.target),rejected=assert.rejects(pending,{code:'teloa/conflict'})
 await entered.promise;e.agent.session.append('turn/start',{turn:0});const before=e.agent.session.snapshotEvents().length
 release.resolve();await rejected;assert.equal(e.agent.session.snapshotEvents().length,before);assert.equal(e.agent.inbox.nextTurn.length,0)
})

test('Free 未提供 coordinator 时沿用官方 local-routing，并保持同请求幂等',async t=>{
 const e=await fixture(t,false)
 await e.ports.send(e.run,e.signal,e.target);await e.ports.send(e.run,e.signal,e.target)
 assert.equal(e.agent.inbox.nextTurn.length,1);assert.equal(e.agent.session.snapshotEvents().length,e.before+1);assert.equal(e.state.attachments,1)
})


test('空请求与同名但属于另一 Context 的官方 Agent 不得提供旧回执或新许可',async t=>{
 const e=await fixture(t),foreign=await fixture(t)
 await assert.rejects(e.ports.send({...e.run,nativeRequestId:''},e.signal,e.target),forbidden);e.zero()
 await foreign.ports.send(foreign.run,foreign.signal,foreign.target)
 assert.equal(foreign.agent.id,e.agent.id);assert.equal(foreign.agent.inbox.nextTurn.length,1)
 e.state.resolved=foreign.agent;e.access.requirePolicy()
 await assert.rejects(e.ports.send(e.run,e.signal,e.target),forbidden);e.zero();assert.equal(e.state.attachments,0)
})


test('真实append后Inbox通知dispatch抛错返回已受理，到期重试仍是唯一原回执',async t=>{
 const e=await fixture(t);let valid=true,calls=0,faults=0
 e.access.requirePolicy();e.access.installPolicy(async()=>{calls++;return {assertCurrent:()=>{if(!valid)throw Error('expired')}}})
 const session=e.agent.session
 e.ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted'){faults++;throw Error('task inbox dispatch failed after append')}},{global:true})
 await e.ports.send(e.run,e.signal,e.target)
 assert.equal(faults,1);assert.equal(calls,1);assert.equal(e.agent.inbox.nextTurn.length,1)
 const events=session.snapshotEvents().slice(e.before),event=events[0]!
 assert.equal(events.length,1);assert.equal(event.type,'agent/inbox/spliced');assert.equal(session.isOwnSeq(event.seq),true)
 valid=false;await e.ports.send(e.run,e.signal,e.target)
 assert.equal(calls,1);assert.equal(faults,1);assert.equal(e.state.attachments,1);assert.equal(session.snapshotEvents().length,e.before+1)
})

test('普通Session与Inbox observer异常由官方隔离，Task原版亦保持唯一受理',async t=>{
 const e=await fixture(t);let sessionNotices=0,inboxNotices=0,calls=0
 e.access.installPolicy(async()=>{calls++;return {assertCurrent:()=>{}}})
 e.ctx.on('session/event',()=>{sessionNotices++;throw Error('contained task session observer')},{global:true})
 e.agent.ctx.on('agent/inbox/inserted',()=>{inboxNotices++;throw Error('contained task inbox observer')})
 await e.ports.send(e.run,e.signal,e.target);await e.ports.send(e.run,e.signal,e.target)
 assert.ok(sessionNotices>=1);assert.equal(inboxNotices,1);assert.equal(calls,1)
 assert.equal(e.agent.inbox.nextTurn.length,1);assert.equal(e.agent.session.snapshotEvents().length,e.before+1)
})

test('本次append前同步否决无真实写入，Task保留原异常对象且不冒充受理',async t=>{
 const e=await fixture(t),failure=Error('task real pre-append veto')
 e.ctx.on('internal/dispatch',(_mode,name,args)=>{if(name==='session/event'&&args[1]?.type==='agent/inbox/spliced')throw failure},{global:true})
 await assert.rejects(e.ports.send(e.run,e.signal,e.target),caught=>caught===failure)
 e.zero();assert.equal(e.state.attachments,1)
})

test('另一exact Session同id不同载荷的新insertion不能充当本次Task受理证据',async t=>{
 // Free 控制场景：跨 Session 的真实提交不能充当本目标输入回执。
 const e=await fixture(t,false),failure=Error('original exact task candidate was vetoed');let nested=false
 const other=(Reflect.get(e.ctx,'sessions') as unknown as SessionStore).create(SessionId('task-native-other'))
 const otherBefore=other.snapshotEvents().length
 e.ctx.on('internal/dispatch',(_mode,name,args)=>{
  const event=args[1]
  if(nested||name!=='session/event'||event?.type!=='agent/inbox/spliced'||event.data.inserted.length!==1)return
  nested=true
  const original=event.data.inserted[0]!,different={...original,content:[{type:'text' as const,text:'different body with the same identity'}]}
  other.append('agent/inbox/spliced',{target:'next-turn',start:0,inserted:[different]})
  throw failure
 },{global:true})
 await assert.rejects(e.ports.send(e.run,e.signal,e.target),caught=>caught===failure)
 e.zero()
 const events=other.snapshotEvents().slice(otherBefore),event=events[0]!
 assert.equal(events.length,1);assert.equal(event.type,'agent/inbox/spliced')
 if(event.type!=='agent/inbox/spliced')throw Error('unexpected other Session event')
 assert.deepEqual(event.data.inserted[0]!.content,[{type:'text',text:'different body with the same identity'}])
 assert.equal(Reflect.get(event.data.inserted[0]!.source,'rpcId'),e.run.nativeRequestId)
})

test('managed Task不把fork inherited history误当本目标旧回执，Free保留官方语义',async t=>{
 for(const managed of [true,false]){
  const e=await fixture(t,managed,true)
  e.access.requirePolicy() // 未安装策略，不能把父历史当成当前任务已受理。
  assert.equal(e.agent.session.inheritedEventCount,3);assert.equal(e.agent.session.isOwnSeq(SessionSeq(1)),false)
  if(managed)await assert.rejects(e.ports.send(e.run,e.signal,e.target),{code:'teloa/conflict'})
  else await e.ports.send(e.run,e.signal,e.target)
  e.zero();assert.equal(e.state.attachments,0)
 }
})
