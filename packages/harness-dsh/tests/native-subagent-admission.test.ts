import test from 'node:test'
import assert from 'node:assert/strict'
import {setImmediate as immediate} from 'node:timers/promises'
import {subagentFixture,deferred,type Admission,type AdmissionRequest} from './fixtures/native-subagent-admission.ts'
import {patchedSessionPackage} from './fixtures/native-final-session.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'

function count(f:Awaited<ReturnType<typeof subagentFixture>>){return [f.ledger(f.parent).length,f.ledger(f.child).length]}
function held(){const entered=deferred<AdmissionRequest>(),gate=deferred();const provider:Admission=async(request,dispatch)=>{entered.resolve(request);await gate.promise;dispatch()};return {entered,gate,provider}}

test('原始 npm 和 patched Free 均走真实 resident prompt/sendMessage，上下行原语义保持',async t=>{
 for(const patched of [false,true]){
  const f=await subagentFixture(t,{},patched),before=count(f)
  const prompt=await f.prompt('free queue'),down=await f.send(f.parent,f.child,'free down'),up=await f.send(f.child,f.parent,'free up')
  assert.equal(f.ledger(f.child).at(-2)?.id,prompt.messageId);assert.equal(f.ledger(f.child).at(-1)?.id,down);assert.equal(f.ledger(f.parent).at(-1)?.id,up)
  assert.deepEqual(count(f),[before[0]!+1,before[1]!+2]);assert.equal(f.modelCalls(),0)
 }
})

test('required 缺provider零新Inbox；原始/scoped共享唯一且不可替换holder',async t=>{
 const f=await subagentFixture(t,{requirePromptAdmission:true}),before=count(f)
 await assert.rejects(f.prompt('required'),/temporarily unavailable/)
 await assert.rejects(f.send(f.parent,f.child,'required down'),/provider is unavailable/)
 await assert.rejects(f.send(f.child,f.parent,'required up'),/provider is unavailable/)
 assert.deepEqual(count(f),before)
 const provider:Admission=async(_,dispatch)=>dispatch(),scoped=Reflect.get(f.ctx.extend(),'subagents') as typeof f.service
 f.service.installPromptAdmission(provider);scoped.installPromptAdmission(provider);scoped.requirePromptAdmission()
 assert.throws(()=>f.service.installPromptAdmission(async()=>{}),/provider is unavailable/)
 assert.equal(Reflect.set(f.service,'promptAdmission',{}),false)
 assert.equal(Reflect.set(scoped,'promptAdmission',{}),false)
 await f.prompt('installed');assert.equal(count(f)[1],before[1]!+1)
})

test('exact冻结请求跨await零写；queue/steer和两个方向均同步once',async t=>{
 for(const direction of ['queue','steer','down','up'] as const){
  const h=held(),f=await subagentFixture(t,{admitPrompt:async(request,dispatch)=>{h.entered.resolve(request);await h.gate.promise;dispatch();assert.throws(dispatch,/scope is closed/)} }),before=count(f)
  const pending=direction==='up'?f.send(f.child,f.parent,'held up'):direction==='down'?f.send(f.parent,f.child,'held down'):f.prompt('held '+direction,direction)
  const request=await h.entered.promise;assert.deepEqual(count(f),before);assert.ok(Object.isFrozen(request));assert.ok(Object.isFrozen(request.message));assert.ok(Object.isFrozen(request.message.content));assert.equal(Object.isFrozen(request.agent),false)
  assert.equal(request.agent,direction==='up'?f.parent:f.child);assert.equal(request.sender,direction==='up'?f.child:f.parent)
  h.gate.resolve();const result=await pending;const id=typeof result==='string'?result:result.messageId
  assert.equal(f.ledger(request.agent).at(-1)?.id,id)
 }
})

test('等待撤销、未提交和迟到dispatch均零写；来源和lineage不自动许可',async t=>{
 const h=held();let allowed=true
 const f=await subagentFixture(t,{admitPrompt:async(request,dispatch)=>{h.entered.resolve(request);await h.gate.promise;if(!allowed)throw Error('revoked');dispatch()} }),before=count(f)
 const pending=f.send(f.parent,f.child,'revoked');await h.entered.promise;allowed=false;h.gate.resolve();await assert.rejects(pending,/revoked/);assert.deepEqual(count(f),before)
 let late:(()=>void)|undefined
 const g=await subagentFixture(t,{admitPrompt:async(_,dispatch)=>{late=dispatch}}),gBefore=count(g)
 await assert.rejects(g.send(g.child,g.parent,'never submitted'),/not admitted/);assert.throws(()=>late!(),/scope is closed/);assert.deepEqual(count(g),gBefore)
})

test('跨await caller取消和live sender/child residency变化拒绝，无新插入',async t=>{
 for(const mode of ['abort','child-residency','sender-residency'] as const){
  const h=held(),f=await subagentFixture(t,{admitPrompt:h.provider}),before=count(f),abort=new AbortController()
  const pending=mode==='sender-residency'?f.send(f.child,f.parent,'changed',abort.signal):f.send(f.parent,f.child,'changed',abort.signal)
  await h.entered.promise
  const id=mode==='sender-residency'?f.child.id:f.child.id,activation=f.registry.resident.get(id)
  if(mode==='abort')abort.abort(Error('caller stopped'));else f.registry.resident.delete(id)
  h.gate.resolve();await assert.rejects(pending);assert.deepEqual(count(f),before)
  if(mode!=='abort')f.registry.resident.set(id,activation)
 }
})

test('等待时exact另一Context同id Agent、live child closing和tree drain拒绝',async t=>{
 for(const mode of ['agent','closing','draining'] as const){
  const h=held(),f=await subagentFixture(t,{admitPrompt:h.provider}),before=count(f)
  const pending=f.send(f.parent,f.child,'cutoff');await h.entered.promise
  if(mode==='agent'){
   const other=await subagentFixture(t);await f.registry.get(f.child.id).handle.dispose()
   const unregister=f.ctx.agents.register(other.child);await unregister;t.after(()=>unregister())
   assert.equal(other.child.id,f.child.id);assert.equal(f.ctx.agents.get(f.child.id),other.child)
  }else if(mode==='closing'){
   const activation=f.registry.get(f.child.id);const closing=activation.inbox.close(()=>Promise.resolve());await closing
  }else f.registry.draining=true
  h.gate.resolve();await assert.rejects(pending);assert.deepEqual(count(f),before)
 }
})

test('实际插入后provider抛错/重复调用不回滚，不产生第二条；收到真实messageId',async t=>{
 for(const mode of ['throw','duplicate'] as const){
  const f=await subagentFixture(t,{admitPrompt:async(_,dispatch)=>{dispatch();if(mode==='throw')throw Error('after accepted');dispatch()} }),before=count(f)
  const id=await f.send(f.child,f.parent,'actual acceptance');assert.equal(f.ledger(f.parent).at(-1)?.id,id);assert.deepEqual(count(f),[before[0]!+1,before[1]])
 }
})

test('并发相同rpcId是两个官方新message，不冒称dedup或已有回执',async t=>{
 let calls=0;const h=held(),f=await subagentFixture(t,{admitPrompt:async(request,dispatch)=>{calls++;if(calls===1){h.entered.resolve(request);await h.gate.promise}dispatch()} }),before=count(f)
 const one=f.prompt('same rpc','queue','rpc-same'),two=f.prompt('same rpc','queue','rpc-same');await h.entered.promise;await immediate();assert.equal(calls,1);assert.deepEqual(count(f),before)
 h.gate.resolve();const [a,b]=await Promise.all([one,two]);assert.notEqual(a.messageId,b.messageId);assert.equal(calls,2);assert.equal(count(f)[1],before[1]!+2)
 for(const message of f.ledger(f.child).slice(-2)){assert.equal(message.source.kind,'user');if(message.source.kind==='user')assert.equal(Reflect.get(message.source,'rpcId'),'rpc-same')}
})

test('真 patched Session final + NativeWorkInput 跨许可await撤销零写，恢复准许仅实际一次',async t=>{
 const sessionPackage=await patchedSessionPackage(t),access=new WorkAccess(),h=held();let allowed=true,work:ReturnType<typeof createNativeWorkInput>|undefined
 access.requirePolicy();access.installPolicy(async()=>{h.entered.resolve({} as AdmissionRequest);await h.gate.promise;return {assertCurrent(){if(!allowed)throw Error('revoked final')}}})
 const f=await subagentFixture(t,{admitPrompt:async(request,dispatch)=>{await work!.withNewInput(request.agent,request.message,{producer:'subagent',identity:JSON.stringify([request.sender.id,request.agent.id,request.delivery])},dispatch)} },true,{sessionPackage,beforeService({ctx}){work=createNativeWorkInput(ctx,access)}}),before=count(f)
 const pending=f.send(f.parent,f.child,'new revoked');await h.entered.promise;allowed=false;h.gate.resolve();await assert.rejects(pending);assert.deepEqual(count(f),before)
 allowed=true;const id=await f.send(f.child,f.parent,'new allowed');assert.equal(f.ledger(f.parent).at(-1)?.id,id);assert.deepEqual(count(f),[before[0]!+1,before[1]])
 work!.close()
})

test('投递回调提交后的异步返回仍已受理；迟到再调用无第二次写',async t=>{
 let late:(()=>void)|undefined
 const f=await subagentFixture(t,{admitPrompt:async(_,dispatch)=>{late=dispatch;await (async()=>{dispatch();return 'invalid async post-result'})();throw Error('after accepted async')} }),before=count(f)
 const id=await f.send(f.parent,f.child,'accepted async');assert.equal(f.ledger(f.child).at(-1)?.id,id);assert.deepEqual(count(f),[before[0],before[1]!+1]);assert.throws(()=>late!(),/scope is closed/);assert.deepEqual(count(f),[before[0],before[1]!+1])
})

test('跨await session/handle/parent链条替换不能借原许可，新写为零',async t=>{
 for(const mode of ['target-session','handle-agent','parent-session'] as const){
  const h=held(),f=await subagentFixture(t,{admitPrompt:h.provider}),before=count(f),activation=f.registry.get(f.child.id),handle=activation.handle
  const pending=f.send(f.parent,f.child,'snapshot changed');await h.entered.promise
  const original=mode==='handle-agent'?handle.agent:mode==='parent-session'?f.parent.session:f.child.session
  if(mode==='handle-agent')handle.agent=f.parent
  else Reflect.set(mode==='parent-session'?f.parent:f.child,'session',mode==='parent-session'?f.child.session:f.parent.session)
  h.gate.resolve();await assert.rejects(pending)
  if(mode==='handle-agent')handle.agent=original
  else Reflect.set(mode==='parent-session'?f.parent:f.child,'session',original)
  assert.deepEqual(count(f),before)
 }
})
