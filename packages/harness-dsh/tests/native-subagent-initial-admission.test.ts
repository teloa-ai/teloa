import test from 'node:test'
import assert from 'node:assert/strict'
import type {Agent} from '@deepseek-ai/dsh-agent'
import type {SessionStore} from '@deepseek-ai/dsh-session'
import {initialSubagentFixture,deferred,until,requireSubagents,type AdmissionRequest} from './fixtures/native-subagent-admission.ts'
import {patchedSessionPackage} from './fixtures/native-final-session.ts'
import {createNativeWorkInput} from '../src/native-work-input.ts'
import {WorkAccess} from '../../backend/src/work/work-access.ts'

type Fixture=Awaited<ReturnType<typeof initialSubagentFixture>>
const start=(f:Fixture,delivery:'parent'|'caller',signal?:AbortSignal)=>delivery==='parent'?f.startContinuable('initial-child',signal):f.startOneShot(signal)
const inserted=(request:AdmissionRequest)=>request.agent.session.snapshotEvents().filter(event=>event.type==='agent/inbox/spliced').flatMap(event=>event.data.inserted)
function cause(f:Fixture,request:AdmissionRequest){
 assert.equal(request.kind,'initial');assert.equal(request.kind==='initial'&&request.mode,'continuable')
 assert.equal(request.sender,f.parent);assert.equal(request.delivery,'queue')
 for(const value of [request,request.message,request.message.content,request.message.source])assert.ok(Object.isFrozen(value))
 const sessions=Reflect.get(f.ctx,'sessions') as unknown as SessionStore
 assert.equal(request.agent.session,sessions.get(request.agent.id));assert.equal(f.ctx.agents.isOwnedBy(request.agent.id,f.parent),true)
}

for(const delivery of ['parent','caller'] as const){
 test(delivery+' 原完整 npm 与 patched Free 均在初始受理后返回真实 activation',async t=>{
  for(const patched of [false,true]){
   const f=await initialSubagentFixture(t,{}, {patched}),receipt=await start(f,delivery)
   const child=f.ctx.agents.get(receipt.childId)!
   assert.ok(child);assert.equal(f.ledger(child)[0]!.id,receipt.messageId)
   assert.equal(f.ledger(child)[0]!.source.kind,'user');assert.equal(f.modelCalls(),0)
   await receipt.dispose()
  }
 })
 test(delivery+' required 缺策略在回包前拒绝且零初始输入',async t=>{
  const f=await initialSubagentFixture(t,{requirePromptAdmission:true})
  await assert.rejects(start(f,delivery),/provider is unavailable/)
  assert.equal(f.modelCalls(),0)
 })
 test(delivery+' exact 初始准入跨 await 保持零写，提交一次返回同一 messageId',async t=>{
  const entered=deferred<AdmissionRequest>(),release=deferred();let late:(()=>void)|undefined
  const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{entered.resolve(request);await release.promise;late=dispatch;dispatch();assert.throws(dispatch,/scope is closed/)}})
  const pending=start(f,delivery),request=await entered.promise
  cause(f,request);assert.equal(inserted(request).length,0)
  release.resolve();const receipt=await pending
  assert.equal(receipt.childId,request.agent.id);assert.equal(receipt.messageId,request.message.id)
  assert.deepEqual(inserted(request),[request.message]);assert.throws(()=>late!(),/scope is closed/)
  await receipt.dispose()
 })
 test(delivery+' 许可等待撤销或 caller 取消均拒绝、零写并释放精确 Agent',async t=>{
  for(const mode of ['revoked','abort'] as const){
   const entered=deferred<AdmissionRequest>(),release=deferred(),abort=new AbortController()
   const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{entered.resolve(request);await release.promise;if(mode==='revoked')throw Error('test revoked');dispatch()}})
   const pending=start(f,delivery,abort.signal),request=await entered.promise,denied=assert.rejects(pending)
   if(mode==='abort')abort.abort(Error('test caller stopped'))
   release.resolve();await denied
   assert.equal(inserted(request).length,0);assert.equal(f.ctx.agents.get(request.agent.id),undefined)
  }
 })
 test(delivery+' 最后提交核对 child/parent Session 与原生 ownership',async t=>{
  for(const change of ['child-session','parent-session','ownership'] as const){
   const entered=deferred<AdmissionRequest>(),release=deferred();let restore=()=>{}
   const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{entered.resolve(request);await release.promise;try{dispatch()}finally{restore()}}})
   const pending=start(f,delivery),request=await entered.promise,denied=assert.rejects(pending,/residency changed/)
   if(change==='ownership'){
    const entries=Reflect.get(f.ctx.agents,'store') as Map<string,{owner:Agent|undefined}>,entry=entries.get(request.agent.id)!,owner=entry.owner
    entry.owner=undefined;restore=()=>{entry.owner=owner}
   }else{
    const target=change==='child-session'?request.agent:f.parent,session=target.session
    Reflect.set(target,'session',change==='child-session'?f.parent.session:request.agent.session);restore=()=>{Reflect.set(target,'session',session)}
   }
   release.resolve();await denied;assert.equal(inserted(request).length,0)
  }
 })
 test(delivery+' 实际初始插入后策略抛错保留唯一真实 receipt',async t=>{
  let request:AdmissionRequest|undefined
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{request=candidate;dispatch();throw Error('test after accepted')}})
  const receipt=await start(f,delivery)
  assert.equal(receipt.messageId,request!.message.id);assert.deepEqual(inserted(request!),[request!.message]);await receipt.dispose()
 })
 test(delivery+' 真 Session 最终 lease 撤销时初始消息零写',async t=>{
  const sessionPackage=await patchedSessionPackage(t),access=new WorkAccess(),entered=deferred(),release=deferred();let valid=true,input:ReturnType<typeof createNativeWorkInput>,request:AdmissionRequest|undefined
  access.requirePolicy();access.installPolicy(async()=>{entered.resolve();await release.promise;return {assertCurrent(){if(!valid)throw Error('test final revoked')}}})
  const f=await initialSubagentFixture(t,{admitPrompt:async(candidate,dispatch)=>{request=candidate;await input.withNewInput(candidate.agent,candidate.message,{producer:'subagent',identity:'initial:'+candidate.agent.id},dispatch,candidate.signal)}},{sessionPackage,beforeService({ctx}){input=createNativeWorkInput(ctx,access);t.after(()=>input.close())}})
  const pending=start(f,delivery);await entered.promise;const denied=assert.rejects(pending)
  assert.equal(inserted(request!).length,0);valid=false;release.resolve();await denied;assert.equal(inserted(request!).length,0)
 })
}

test('原生 manager 的 cold resume 独立核验新递送，历史不充当准入',async t=>{
 const seen:AdmissionRequest[]=[],f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{seen.push(request);dispatch()}})
 const first=await f.startContinuable();f.releaseSteps();await until(()=>f.ctx.agents.get(first.childId)===undefined)
 const id=await requireSubagents(f.ctx).sendMessage(f.parent,first.childId,[{type:'text',text:'真实恢复新递送'}],{signal:new AbortController().signal})
 assert.deepEqual(seen.map(row=>row.kind),['initial','resume']);assert.equal(seen[1]!.message.id,id)
 assert.notEqual(seen[1]!.agent,seen[0]!.agent);assert.equal(seen[1]!.sender,f.parent);assert.ok(inserted(seen[1]!).some(message=>message.id===id))
})

test('cold resume 等待期间撤销只保留旧历史、零新消息',async t=>{
 const entered=deferred<AdmissionRequest>(),release=deferred();let valid=true
 const f=await initialSubagentFixture(t,{admitPrompt:async(request,dispatch)=>{if(request.kind==='resume'){entered.resolve(request);await release.promise;if(!valid)throw Error('test resume revoked')}dispatch()}})
 const first=await f.startContinuable();f.releaseSteps();await until(()=>f.ctx.agents.get(first.childId)===undefined)
 const pending=requireSubagents(f.ctx).sendMessage(f.parent,first.childId,[{type:'text',text:'不得借旧输入受理'}],{signal:new AbortController().signal}),denied=assert.rejects(pending,/test resume revoked/)
 const request=await entered.promise;assert.ok(inserted(request).some(message=>message.id===first.messageId))
 valid=false;release.resolve();await denied;assert.ok(!inserted(request).some(message=>message.id===request.message.id))
})
