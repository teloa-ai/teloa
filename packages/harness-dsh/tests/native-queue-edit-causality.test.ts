import test from 'node:test'
import assert from 'node:assert/strict'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {createNativeProducerAdmissions} from '../src/native-producer-admission.ts'
import {registerProjectRuntimeContext} from '../src/project-runtime-context.ts'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'
import {attachAdmissionController,promptRequest,queueRequest} from './fixtures/native-controller-admission.ts'

const signal=new AbortController().signal

for(const bound of [false,true])test('真实Controller队列连续编辑经项目accepted/claim进入下一模型，仅发送最终正文：'+(bound?'绑定项目':'普通会话'), {timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t),{controller}=await attachAdmissionController(t,f.ctx)
 const runtime=registerProjectRuntimeContext(f.ctx,{owner:'queue-owner',prepare:async input=>bound?{
  binding:{sessionId:input.sessionId,projectId:'queue-project',version:1,title:'队列编辑项目',memoryMode:'enabled',generation:1,contextVersion:1,settingsVersion:1},
  manifestId:'manifest-'+input.query,text:'本次项目资料 '+input.query,sources:[],reset:false,providerSessionId:input.sessionId+'-project',
 }:null,readBinding:async()=>null,assertCurrent:async()=>{},assertPreparedCurrentSync(){},recordUsed:async()=>{}})
 t.after(()=>runtime.close())
 const acceptedMessages:string[]=[],originalAccepted=runtime.hooks.accepted
 runtime.hooks.accepted=(...args)=>{originalAccepted(...args);acceptedMessages.push(JSON.stringify(args[1].content))}
 controller.requireInputAdmission();controller.installInputAdmission(createNativeProducerAdmissions(f.work).controller)
 let release!:()=>void
 const maintenance=f.agent.runMaintenance(signal=>new Promise<void>(done=>{release=done;signal.addEventListener('abort',()=>done(),{once:true})}))
 while(!release)await new Promise<void>(done=>setImmediate(done))
 await controller.prompt(promptRequest(f.agent,'queued-owner-request','queued v1'),signal)
 const original=f.agent.inbox.nextTurn[0]!
 await controller.updateQueue(queueRequest(f.agent,original.id,'queued v2'))
 await controller.updateQueue(queueRequest(f.agent,original.id,'queued v3'))
 const edited=f.agent.inbox.nextTurn[0]!
 assert.equal(edited.id,original.id);assert.deepEqual(edited.source,original.source)
 assert.equal(f.adapter.requests.length,0)
 assert.equal(acceptedMessages.length,3,JSON.stringify({acceptedMessages,events:f.events()}))
 f.adapter.scripts.push(textAnswer);release();await maintenance;await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 const actual=JSON.stringify(f.adapter.requests[0]!.messages)
 assert.match(actual,/queued v3/);assert.doesNotMatch(actual,/queued v1|queued v2/)
 assert.equal(f.agent.inbox.nextTurn.length,0)
 assert.ok(f.events().some(event=>event.type==='turn/end'&&event.data.reason.kind==='completed'))
 // 已领取 id 不得伪装新输入，即使重新获得一次输入许可也不产生模型受理。
 const repeated={...edited,content:[{type:'text' as const,text:'reused after claim'}]}
 await f.work.withNewInput(f.agent,repeated,{producer:'queue',identity:'forged-after-claim'},()=>f.agent.followup(repeated))
 await f.agent.whenIdle();assert.equal(f.adapter.requests.length,1)
 f.agent.cancel({kind:'user'},{keepInbox:true});await f.agent.whenIdle()
})

test('真实编辑遇过期续作许可保留原稿；跨Session未受理原项不能转用编辑根', {timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t),{controller}=await attachAdmissionController(t,f.ctx)
 controller.requireInputAdmission();controller.installInputAdmission(createNativeProducerAdmissions(f.work).controller)
 let release!:()=>void
 const maintenance=f.agent.runMaintenance(signal=>new Promise<void>(done=>{release=done;signal.addEventListener('abort',()=>done(),{once:true})}))
 while(!release)await new Promise<void>(done=>setImmediate(done))
 await controller.prompt(promptRequest(f.agent,'lease-owner','original'),signal)
 const original=f.agent.inbox.nextTurn[0]!,before=f.agent.session.seq
 f.rights.generation++
 f.rights.revoked=true
 await assert.rejects(controller.updateQueue(queueRequest(f.agent,original.id,'revoked edit')))
 assert.equal(f.agent.inbox.nextTurn[0],original);assert.equal(f.agent.session.seq,before)
 await assert.rejects(controller.updateQueue(queueRequest(f.other,original.id,'wrong parent')))
 assert.equal(f.other.inbox.nextTurn.length,0)
 f.agent.cancel({kind:'user'});release();await maintenance;await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0)
})

test('最终项目accepted回调异常不留下可领取的半注册新根', {timeout:15000},async t=>{
 const f=await nativeHotCausalityFixture(t)
 const runtime=registerProjectRuntimeContext(f.ctx,{owner:'queue-owner',prepare:async()=>null,readBinding:async()=>null,assertCurrent:async()=>{},assertPreparedCurrentSync(){},recordUsed:async()=>{}})
 t.after(()=>runtime.close())
 const accepted=runtime.hooks.accepted
 // 明确注入最终同步回调故障；正常Session已落日志的事实仍保留，不能撤销或重发。
 runtime.hooks.accepted=(...args)=>{accepted(...args);throw Error('accepted observer failure')}
 const message=createUserMessage({source:{kind:'user',rpcId:'callback-failed'},content:[{type:'text',text:'must not execute'}]})
 await f.work.withNewInput(f.agent,message,{producer:'prompt',identity:'callback-failed'},()=>f.agent.followup(message))
 runtime.hooks.accepted=accepted
 await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0)
 assert.ok(f.events().some(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(item=>item.id===message.id)))
 assert.ok(f.events().some(event=>event.type==='turn/end'&&event.data.reason.kind==='aborted'))
})
