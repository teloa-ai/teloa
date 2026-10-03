import test from 'node:test'
import assert from 'node:assert/strict'
import {SessionId,SessionSeq,SessionLogOffset} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {WorkAccess} from '../../backend/src/work/work-access.ts'
import {WorkError} from '@teloa/contract'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {controllerAdmissionFixture,promptRequest,queueRequest,type ControllerInputCandidate,type ControllerInputAdmission,type AdmittingSessionController} from './fixtures/native-controller-admission.ts'

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const denied=()=>new WorkError('teloa/forbidden','测试拒绝')
const insertions=(agent:{session:{snapshotEvents:()=>readonly {type:string;data:unknown}[]}})=>agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&(event.data as {inserted:unknown[]}).inserted.length!==0)
function installManaged(f:Awaited<ReturnType<typeof controllerAdmissionFixture>>,admission?:ControllerInputAdmission){
 const access=new WorkAccess();access.requirePolicy();access.installPolicy(async()=>({assertCurrent:()=>{}}))
 const work=createNativeWorkInput(f.ctx,access)
 f.controller.requireInputAdmission()
 const policy:ControllerInputAdmission=admission??((candidate,dispatch)=>work.withNewInput(candidate.agent,candidate.message,{producer:candidate.kind==='prompt'?'prompt':'queue',identity:JSON.stringify(candidate.kind==='prompt'?[candidate.kind,candidate.requestId,candidate.mode]:[candidate.kind,candidate.itemId,candidate.target])},dispatch))
 f.controller.installInputAdmission(policy)
 return {access,work,policy}
}

test('未安装 hook 的 Free 真 controller 保留 prompt/edit/remove 原队列路径',async t=>{
 const f=await controllerAdmissionFixture(t),request=promptRequest(f.agent)
 assert.deepEqual(await f.controller.prompt(request,new AbortController().signal),{accepted:true})
 const input=f.agent.inbox.nextTurn[0]!
 assert.deepEqual(await f.controller.updateQueue(queueRequest(f.agent,input.id)),{accepted:true})
 assert.equal(f.agent.inbox.nextTurn[0]?.content[0]?.type,'text');assert.notEqual(f.agent.inbox.nextTurn[0],input)
 await f.controller.updateQueue({sessionId:f.agent.id,itemId:input.id,action:{kind:'remove'}})
 assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.state.commits,1)
})

test('required 单向、holder 原/scoped不可替换、同policy幂等且唯一，缺hook零插入',async t=>{
 const f=await controllerAdmissionFixture(t),before=insertions(f.agent).length
 f.controller.requireInputAdmission();f.controller.requireInputAdmission()
 const holder=Reflect.get(f.controller,'inputAdmission')
 assert.ok(Object.isFrozen(holder))
 for(const receiver of [f.controller,Reflect.get(f.agent.ctx,'sessionController')]){
  assert.equal(Reflect.set(receiver,'inputAdmission',{managed:false}),false)
  assert.equal(Reflect.deleteProperty(receiver,'inputAdmission'),false)
  assert.throws(()=>Object.defineProperty(receiver,'inputAdmission',{value:{managed:false}}),TypeError)
  assert.equal(Reflect.get(receiver,'inputAdmission'),holder)
 }
 await assert.rejects(f.controller.prompt(promptRequest(f.agent),new AbortController().signal),{code:'session/input-admission-unavailable'})
 assert.equal(insertions(f.agent).length,before);assert.equal(f.state.bindCalls,0)
 const policy:ControllerInputAdmission=async()=>{throw denied()}
 f.controller.installInputAdmission(policy);f.controller.installInputAdmission(policy)
 ;(Reflect.get(f.agent.ctx,'sessionController') as unknown as AdmittingSessionController).installInputAdmission(policy)
 assert.throws(()=>f.controller.installInputAdmission(async()=>{}),/already installed/)
})

test('policy 的核心 WorkError 保持原对象/错误码，许可拒绝不伪装 agent-busy',async t=>{
 const f=await controllerAdmissionFixture(t),error=denied()
 f.controller.requireInputAdmission();f.controller.installInputAdmission(async()=>{throw error})
 await assert.rejects(f.controller.prompt(promptRequest(f.agent),new AbortController().signal),caught=>caught===error)
 assert.equal(insertions(f.agent).length,0);assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.state.bindCalls,0)
})

test('attachments await 后才授权 exact快照；等待期间可变request不能更换 rpcId/mode/content',async t=>{
 const f=await controllerAdmissionFixture(t),entered=deferred(),release=deferred(),seen:ControllerInputCandidate[]=[]
 f.intake.admit=async content=>{entered.resolve();await release.promise;return [{type:'text',text:'admitted exact body'}]}
 const managed=installManaged(f,async(candidate,dispatch)=>{
  seen.push(candidate);assert.ok(Object.isFrozen(candidate));assert.ok(Object.isFrozen(candidate.message));assert.equal(candidate.agent,f.agent)
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:'prompt',identity:candidate.kind==='prompt'?candidate.requestId:'unexpected'},dispatch)
 })
 const request={...promptRequest(f.agent,'original')},pending=f.controller.prompt(request,new AbortController().signal)
 await entered.promise;assert.equal(seen.length,0);request.requestId='changed' as typeof request.requestId;request.mode='steer';request.content=[{type:'text',text:'mutated'}]
 release.resolve();await pending
 assert.equal(seen.length,1);assert.equal(seen[0]?.kind,'prompt')
 const candidate=seen[0] as Extract<ControllerInputCandidate,{kind:'prompt'}>
 assert.equal(candidate.requestId,'original');assert.equal(candidate.mode,'queue');assert.equal(candidate.message.source.kind,'user');assert.equal(Reflect.get(candidate.message.source,'rpcId'),'original')
 assert.deepEqual(candidate.message.content,[{type:'text',text:'admitted exact body'}]);assert.equal(f.agent.inbox.nextTurn[0]?.id,candidate.message.id)
 assert.equal(f.agent.inbox.nextStep.length,0);assert.equal(f.state.commits,1)
})

test('同session/rpcId 并发等待先重查已有回执，只有一次attachments/许可/投递',async t=>{
 const f=await controllerAdmissionFixture(t),entered=deferred(),release=deferred();let calls=0,valid=true
 const managed=installManaged(f,async(candidate,dispatch)=>{
  calls++;entered.resolve();await release.promise;if(!valid)throw denied()
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:'prompt',identity:'concurrent-rpc'},dispatch)
 })
 const request=promptRequest(f.agent,'same-rpc'),a=f.controller.prompt(request,new AbortController().signal),b=f.controller.prompt({...request},new AbortController().signal)
 await entered.promise;await Promise.resolve();assert.equal(calls,1);release.resolve()
 assert.deepEqual(await Promise.all([a,b]),[{accepted:true},{accepted:true}]);assert.equal(calls,1);assert.equal(f.state.attachmentCalls,1);assert.equal(f.state.commits,1);assert.equal(insertions(f.agent).length,1)
 valid=false;managed.work.close()
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent,'same-rpc','changed old body'),new AbortController().signal),{accepted:true})
 assert.equal(calls,1);assert.equal(insertions(f.agent).length,1)
})

test('相同rpcId的不同exact Session不共享授权或并发锁',async t=>{
 const f=await controllerAdmissionFixture(t),entered=deferred(),release=deferred(),seen:ControllerInputCandidate[]=[]
 const managed=installManaged(f,async(candidate,dispatch)=>{
  seen.push(candidate);if(seen.length===2)entered.resolve();await release.promise
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:'prompt',identity:'same-rpc'},dispatch)
 })
 const pending=Promise.all([f.controller.prompt(promptRequest(f.agent,'same-rpc'),new AbortController().signal),f.controller.prompt(promptRequest(f.other,'same-rpc'),new AbortController().signal)])
 await entered.promise;assert.notEqual(seen[0]?.agent,seen[1]?.agent);release.resolve();await pending
 assert.equal(insertions(f.agent).length,1);assert.equal(insertions(f.other).length,1)
})

test('queue-edit 拒绝保留旧exact item，允许时最终guard只替换同对象候选',async t=>{
 const f=await controllerAdmissionFixture(t);let rejectEdit=true
 const managed=installManaged(f,async(candidate,dispatch)=>{
  if(candidate.kind==='queue-edit'&&rejectEdit)throw denied()
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:candidate.kind==='prompt'?'prompt':'queue',identity:candidate.kind},dispatch)
 })
 await f.controller.prompt(promptRequest(f.agent),new AbortController().signal)
 const old=f.agent.inbox.nextTurn[0]!,before=insertions(f.agent).length
 await assert.rejects(f.controller.updateQueue(queueRequest(f.agent,old.id)),{code:'teloa/forbidden'})
 assert.equal(f.agent.inbox.nextTurn[0],old);assert.equal(insertions(f.agent).length,before)
 rejectEdit=false;await f.controller.updateQueue(queueRequest(f.agent,old.id,'allowed edit'))
 assert.equal(f.agent.inbox.nextTurn[0]?.id,old.id);assert.notEqual(f.agent.inbox.nextTurn[0],old);assert.equal(insertions(f.agent).length,before+1)
})

test('queue-edit 等许可时旧item改变，迟到候选不得覆盖新内容且request捕获一次',async t=>{
 const f=await controllerAdmissionFixture(t),entered=deferred(),release=deferred();let holding=false
 const managed=installManaged(f,async(candidate,dispatch)=>{
  if(candidate.kind==='queue-edit'&&holding&&candidate.message.content[0]?.type==='text'&&candidate.message.content[0].text==='older edit'){entered.resolve();await release.promise}
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:candidate.kind==='prompt'?'prompt':'queue',identity:candidate.kind},dispatch)
 })
 await f.controller.prompt(promptRequest(f.agent),new AbortController().signal);const old=f.agent.inbox.nextTurn[0]!
 holding=true;const request={...queueRequest(f.agent,old.id,'older edit')},pending=f.controller.updateQueue(request),rejected=assert.rejects(pending,{code:'session/queue-item-not-found'})
 await entered.promise;request.action={kind:'remove'};request.itemId='changed' as typeof request.itemId
 await f.controller.updateQueue(queueRequest(f.agent,old.id,'newer edit'));const current=f.agent.inbox.nextTurn[0]!,before=insertions(f.agent).length
 release.resolve();await rejected;assert.equal(f.agent.inbox.nextTurn[0],current);assert.equal(insertions(f.agent).length,before)
})

test('受管 queue-steer 明确待可信accepted续作，拒绝不移除原已受理项',async t=>{
 const f=await controllerAdmissionFixture(t);let calls=0
 const managed=installManaged(f,async(candidate,dispatch)=>{calls++;await managed.work.withNewInput(candidate.agent,candidate.message,{producer:'prompt',identity:'first'},dispatch)})
 await f.controller.prompt(promptRequest(f.agent),new AbortController().signal);const old=f.agent.inbox.nextTurn[0]!,before=insertions(f.agent).length,previousCalls=calls
 await assert.rejects(f.controller.updateQueue({sessionId:f.agent.id,itemId:old.id,action:{kind:'steer'}}),{code:'session/steer-unavailable',details:{itemId:old.id,reason:'TRUSTED_CONTINUATION_NOT_IMPLEMENTED'}})
 assert.equal(f.agent.inbox.nextTurn[0],old);assert.equal(insertions(f.agent).length,before);assert.equal(calls,previousCalls)
 await f.controller.updateQueue({sessionId:f.agent.id,itemId:old.id,action:{kind:'remove'}})
 assert.equal(f.agent.inbox.nextTurn.length,0)
})

test('publisher exact target受最终guard约束，错误target许可不能投到原Session',async t=>{
 const f=await controllerAdmissionFixture(t)
 const managed=installManaged(f,async(candidate,dispatch)=>{await managed.work.withNewInput(f.other,candidate.message,{producer:'prompt',identity:'wrong target'},dispatch)})
 await assert.rejects(f.controller.prompt(promptRequest(f.agent),new AbortController().signal),{code:'teloa/forbidden'})
 assert.equal(insertions(f.agent).length,0);assert.equal(insertions(f.other).length,0);assert.equal(f.state.commits,0);assert.equal(f.state.rollbacks,1)
})

test('同步dispatch一旦返回就无迟到能力，未dispatch/重复/回调异常不能双投',async t=>{
 const f=await controllerAdmissionFixture(t);let saved:()=>void=()=>{},called=0
 const managed=installManaged(f,async(candidate,dispatch)=>{
  saved=dispatch;await managed.work.withNewInput(candidate.agent,candidate.message,{producer:'prompt',identity:'once'},()=>{dispatch();assert.throws(()=>dispatch(),/scope is closed/);called++})
  throw Error('test after accepted prompt')
 })
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent),new AbortController().signal),{accepted:true})
 assert.equal(called,1);assert.equal(insertions(f.agent).length,1);assert.throws(()=>saved(),/scope is closed/)
})

test('真实 Session 和 Inbox observer 异常均由官方隔离，已受理回执保持',async t=>{
 const f=await controllerAdmissionFixture(t);installManaged(f);let sessionNotifications=0,inboxNotifications=0
 f.ctx.on('session/event',()=>{sessionNotifications++;throw Error('test contained session observer')},{global:true})
 f.agent.ctx.on('agent/inbox/inserted',()=>{inboxNotifications++;throw Error('test contained inbox observer')})
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent,'observer-rpc'),new AbortController().signal),{accepted:true})
 assert.equal(insertions(f.agent).length,1);assert.equal(f.agent.inbox.nextTurn.length,1);assert.ok(sessionNotifications>=1);assert.equal(inboxNotifications,1)
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent,'observer-rpc'),new AbortController().signal),{accepted:true})
 assert.equal(insertions(f.agent).length,1)
})

test('binding.commit 提交后故障不伪报未受理，后续同rpc仍返回唯一accepted',async t=>{
 const f=await controllerAdmissionFixture(t);installManaged(f)
 f.intake.commit=()=>{throw Error('test binding commit failed')}
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent,'binding-rpc'),new AbortController().signal),{accepted:true})
 assert.equal(insertions(f.agent).length,1);assert.equal(f.state.commits,0);assert.equal(f.state.rollbacks,1)
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent,'binding-rpc'),new AbortController().signal),{accepted:true})
 assert.equal(insertions(f.agent).length,1);assert.equal(f.state.bindCalls,1)
})

test('queue edit 保留官方observer异常隔离；旧同id不能冒充新候选受理回执',async t=>{
 const f=await controllerAdmissionFixture(t);let rejectEdit=false
 const managed=installManaged(f,async(candidate,dispatch)=>{
  if(candidate.kind==='queue-edit'&&rejectEdit)throw denied()
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:candidate.kind==='prompt'?'prompt':'queue',identity:candidate.kind},dispatch)
 })
 await f.controller.prompt(promptRequest(f.agent),new AbortController().signal)
 const old=f.agent.inbox.nextTurn[0]!,before=insertions(f.agent).length
 rejectEdit=true;await assert.rejects(f.controller.updateQueue(queueRequest(f.agent,old.id,'rejected changed body')),{code:'teloa/forbidden'})
 assert.equal(f.agent.inbox.nextTurn[0],old);assert.equal(insertions(f.agent).length,before)
 rejectEdit=false;f.agent.ctx.on('agent/inbox/inserted',()=>{throw Error('test edit after commit')})
 assert.deepEqual(await f.controller.updateQueue(queueRequest(f.agent,old.id,'accepted changed body')),{accepted:true})
 assert.equal(insertions(f.agent).length,before+1);assert.notEqual(f.agent.inbox.nextTurn[0],old)
 assert.deepEqual(f.agent.inbox.nextTurn[0]?.content,[{type:'text',text:'accepted changed body'}])
})


test('真实Inbox通知dispatch校验器在append后抛错，prompt按owned rpc、edit按新exact事件确认受理',async t=>{
 const prompt=await controllerAdmissionFixture(t);installManaged(prompt);let promptFaults=0
 prompt.ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted'){promptFaults++;throw Error('test after append dispatch validation')}})
 assert.deepEqual(await prompt.controller.prompt(promptRequest(prompt.agent,'dispatch-rpc'),new AbortController().signal),{accepted:true})
 assert.equal(insertions(prompt.agent).length,1);assert.equal(prompt.agent.inbox.nextTurn.length,1);assert.equal(promptFaults,1)
 assert.deepEqual(await prompt.controller.prompt(promptRequest(prompt.agent,'dispatch-rpc'),new AbortController().signal),{accepted:true})
 assert.equal(promptFaults,1);assert.equal(insertions(prompt.agent).length,1)
 const edit=await controllerAdmissionFixture(t);installManaged(edit)
 await edit.controller.prompt(promptRequest(edit.agent),new AbortController().signal);const old=edit.agent.inbox.nextTurn[0]!,before=insertions(edit.agent).length;let editFaults=0
 edit.ctx.on('internal/dispatch',(_mode,name)=>{if(name==='agent/inbox/inserted'){editFaults++;throw Error('test after edit append dispatch validation')}})
 assert.deepEqual(await edit.controller.updateQueue(queueRequest(edit.agent,old.id,'new exact dispatch candidate')),{accepted:true})
 assert.equal(editFaults,1);assert.equal(insertions(edit.agent).length,before+1);assert.notEqual(edit.agent.inbox.nextTurn[0],old)
 assert.deepEqual(edit.agent.inbox.nextTurn[0]?.content,[{type:'text',text:'new exact dispatch candidate'}])
})


test('managed prompt只认本目标own history，fork继承的同rpc不能伪报accepted；Free保持原语义',async t=>{
 for(const managed of [true,false]){
  const f=await controllerAdmissionFixture(t),message=createUserMessage({source:{kind:'user',rpcId:'inherited-rpc'},content:[{type:'text',text:'accepted only by the parent'}]})
  const seed=[{type:'turn/start',seq:SessionSeq(0),time:1,data:{turn:1}},{type:'user/message',seq:SessionSeq(1),time:1,data:message,surfaceOp:'append'},{type:'turn/end',seq:SessionSeq(2),time:1,data:{turn:1,reason:{kind:'completed'}}}] as const
  const {agent}=await f.ctx.agents.create({sessionId:SessionId('controller-inherited-target'),agentOptions:{provider:'test',model:'test'},meta:{isSeeded:true,parentSession:f.agent.id},seed,inheritedEventCount:SessionLogOffset(seed.length)})
  void agent.runMaintenance(signal=>new Promise<void>(done=>{signal.addEventListener('abort',()=>done(),{once:true})}))
  const before=agent.session.snapshotEvents().length
  assert.equal(agent.session.inheritedEventCount,3);assert.equal(agent.session.isOwnSeq(SessionSeq(1)),false)
  if(managed){
   f.controller.requireInputAdmission()
   await assert.rejects(f.controller.prompt(promptRequest(agent,'inherited-rpc','new target body'),new AbortController().signal),{code:'session/input-admission-unavailable'})
  }else assert.deepEqual(await f.controller.prompt(promptRequest(agent,'inherited-rpc','new target body'),new AbortController().signal),{accepted:true})
  assert.equal(agent.session.snapshotEvents().length,before);assert.equal(agent.inbox.nextTurn.length,0)
 }
})

test('本目标own user history的旧rpc仍优先返回回执，不重新申请许可或读附件',async t=>{
 const f=await controllerAdmissionFixture(t),message=createUserMessage({source:{kind:'user',rpcId:'own-history-rpc'},content:[{type:'text',text:'own accepted history'}]})
 const event=f.agent.session.append('user/message',message,{surfaceOp:'append'}),before=f.agent.session.snapshotEvents().length
 assert.equal(f.agent.session.isOwnSeq(event.seq),true)
 f.controller.requireInputAdmission() // 缺策略只应拒绝新请求，不能阻断本目标的旧回执。
 assert.deepEqual(await f.controller.prompt(promptRequest(f.agent,'own-history-rpc','new draft'),new AbortController().signal),{accepted:true})
 assert.equal(f.agent.session.snapshotEvents().length,before);assert.equal(f.agent.inbox.nextTurn.length,0);assert.equal(f.state.attachmentCalls,0)
})


test('同rpc串行等待后原Agent已dispose并被同id新Agent替换，旧对象回执不得早返',async t=>{
 const f=await controllerAdmissionFixture(t),ready=deferred(),publish=deferred(),committed=deferred(),finish=deferred();let calls=0
 const handle=await f.ctx.agents.create({sessionId:SessionId('controller-replaced-target'),agentOptions:{provider:'test',model:'test'}}),agent=handle.agent,session=agent.session
 void agent.runMaintenance(signal=>new Promise<void>(done=>{signal.addEventListener('abort',()=>done(),{once:true})}))
 const managed=installManaged(f,async(candidate,dispatch)=>{
  calls++;ready.resolve();await publish.promise
  await managed.work.withNewInput(candidate.agent,candidate.message,{producer:'prompt',identity:'queued-original'},dispatch)
  committed.resolve();await finish.promise
 })
 const first=f.controller.prompt(promptRequest(agent,'queued-receipt'),new AbortController().signal)
 await ready.promise
 const second=f.controller.prompt(promptRequest(agent,'queued-receipt'),new AbortController().signal),rejected=assert.rejects(second,{code:'session/not-found'})
 await new Promise<void>(done=>setImmediate(done));assert.equal(calls,1)
 publish.resolve();await committed.promise;assert.equal(agent.inbox.nextTurn.length,1)
 // 真实已受理输入成为本目标 own history；无需模型即可保留 dispose 后的旧回执。
 const accepted=agent.inbox.nextTurn[0]!,event=session.append('user/message',accepted,{surfaceOp:'append'})
 assert.equal(session.isOwnSeq(event.seq),true)
 await handle.dispose()
 const replacement=await f.ctx.agents.create({sessionId:agent.id,agentOptions:{provider:'test',model:'test'}})
 void replacement.agent.runMaintenance(signal=>new Promise<void>(done=>{signal.addEventListener('abort',()=>done(),{once:true})}))
 assert.notEqual(replacement.agent,agent);assert.notEqual(replacement.agent.session,session);assert.equal(f.ctx.agents.get(agent.id),replacement.agent)
 finish.resolve();assert.deepEqual(await first,{accepted:true});await rejected
 assert.equal(calls,1);assert.equal(f.state.attachmentCalls,1);assert.equal(session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.length).length,1)
 assert.equal(replacement.agent.inbox.nextTurn.length,0)
})
