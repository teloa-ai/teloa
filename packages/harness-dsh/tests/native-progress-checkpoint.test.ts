import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import type {NativeProgressCheckpoint,NativeProgressCheckpointInput} from '../src/native-input-checkpoint.ts'
import {nativeHotCausalityFixture,hotGate,textAnswer,toolAnswer} from './fixtures/native-hot-causality.ts'
import {nativeProviderKernel} from './fixtures/native-input-provider.ts'
import {loopWorkFixture} from './fixtures/native-loop-work-admission.ts'

const options={timeout:10000}

test('本人取消后的真实turn-end仍用所属writer持久收尾，不能漏掉终态释放证据',options,async t=>{
 const seen:NativeProgressCheckpointInput[]=[],gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async input=>{input.assertCurrent();seen.push(input)})
 f.adapter.prepareGate=gate;f.adapter.scripts.push(textAnswer)
 const message=await f.send('progress-cancel-terminal');await gate.entered
 f.agent.cancel({kind:'user'},{keepInbox:true});gate.release();await f.agent.whenIdle()
 const terminal=seen.find(input=>input.phase==='turn-end')
 assert.ok(terminal,'取消必须送达持久终态，而非只留下活跃预约')
 const last=terminal.snapshot.events.at(-1)
 assert.equal(last?.type,'turn/end');assert.equal(last?.type==='turn/end'&&last.data.turn,terminal.turn)
 assert.equal(last?.type==='turn/end'&&last.data.reason.kind,'aborted')
 assert.deepEqual(terminal.roots.map(root=>root.messageId),[message.id])
 assert.ok((await f.cold()).events.some(event=>event.type==='turn/end'&&event.seq===last!.seq))
})
async function fixture(t:TestContext,progress?:NativeProgressCheckpoint,checkpoint:()=>Promise<void>=async()=>{},durable=true){
 const root=await mkdtemp('/private/tmp/teloa-progress-checkpoint-');t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await nativeHotCausalityFixture(t,{persistenceRoot:root,...progress===undefined?{}:{progress},...durable?{checkpoint}:{}})
 return {...f,root,async cold(){
  const cold=await nativeProviderKernel(t)
  await cold.ctx.plugin(cold.persistencePackage.default,{root,compression:'none'})
  await cold.ctx.plugin(cold.loopPackage.AgentLoop,{agents:[]})
  const reader=await cold.ctx.sessionPersistence.open(f.agent.id,'read')
  try{
   const {events}=await reader.read(),session=cold.sessionPackage.Session.create(f.agent.id,events,reader.header,reader.inheritedEventCount)
   return {events,inbox:cold.ctx.sessionProjections.stateOf(session,'inbox')!}
  }finally{await reader.close()}
 }}
}

test('实际writer完整推进领取、模型、步骤与轮次快照，最后快照包含真实完成事件',options,async t=>{
 const seen:NativeProgressCheckpointInput[]=[]
 const f=await fixture(t,async input=>{input.assertCurrent();seen.push(input)})
 f.adapter.scripts.push(textAnswer);const message=await f.send('progress-completed');await f.agent.whenIdle()
 assert.deepEqual(seen.map(input=>input.phase),['claimed','model','step-end','turn-end'])
 assert.equal(seen[0]!.snapshot.events.some(event=>event.type==='agent/inbox/spliced'&&(event.data.removedCount??0)>0),true)
 assert.equal(seen[1]!.snapshot.events.some(event=>event.type==='user/message'&&event.data.id===message.id),true)
 assert.deepEqual(seen.at(-1)!.snapshot.events,f.agent.session.snapshotEvents())
 for(const input of seen){
  assert.equal(Object.isFrozen(input),true);assert.equal(Object.isFrozen(input.roots),true)
  assert.deepEqual(input.roots.map(root=>[root.sessionId,root.messageId,root.nativeRequestId]),[[f.agent.id,message.id,'progress-completed']])
 }
 assert.equal(f.adapter.requests.length,1)
})

test('模型前真实持久确认等待维持零模型，到期后原工作继续且新输入拒绝',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async input=>{if(input.phase==='model')await gate.wait(input.signal);input.assertCurrent()})
 f.adapter.scripts.push(textAnswer);await f.send('progress-model-wait');await gate.entered
 assert.equal(f.adapter.requests.length,0)
 f.rights.valid=false;gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1);await assert.rejects(f.send('new-after-progress-expiry'),{code:'teloa/forbidden'})
})

test('领取后持久确认拒绝即停止模型，已提交的Inbox领取不伪装回滚',options,async t=>{
 const f=await fixture(t,async()=>{throw Error('持久推进不可用')})
 f.adapter.scripts.push(textAnswer);await f.send('progress-claimed-failure');await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0);assert.equal(f.counters.tools,0)
 assert.deepEqual(f.agent.inbox.nextTurn,[]);assert.deepEqual(f.agent.inbox.nextStep,[])
 const stored=await f.cold()
 assert.equal(stored.events.some(event=>event.type==='agent/inbox/spliced'&&(event.data.removedCount??0)>0),true)
 assert.equal(stored.events.some(event=>event.type==='assistant/message'),false)
})

test('工具前checkpoint持久化真实模型结果，确认后才派发工具及下一模型',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const phases:string[]=[]
 const f=await fixture(t,async input=>{phases.push(input.phase);if(input.phase==='tools')await gate.wait(input.signal)})
 f.adapter.scripts.push(toolAnswer,textAnswer);await f.send('progress-tools');await gate.entered
 assert.equal(f.adapter.requests.length,1);assert.equal(f.counters.tools,0)
 assert.equal((await f.cold()).events.some(event=>event.type==='assistant/message'),true)
 gate.release();await f.agent.whenIdle()
 assert.equal(f.counters.tools,1);assert.equal(f.adapter.requests.length,2);assert.equal(phases.at(-1),'turn-end')
})

test('实际领取后等待期间撤销，迟到成功不能调用模型',options,async t=>{
 const gate=hotGate();t.after(gate.release)
 const f=await fixture(t,async input=>{if(input.phase==='claimed')await gate.wait(input.signal)})
 f.adapter.scripts.push(textAnswer);await f.send('progress-revoke');await gate.entered
 f.rights.revoked=true;gate.release();await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0);assert.equal(f.counters.tools,0)
})

test('确认拒绝后的真实宿主卸载保留磁盘待办，独立新图可读回',options,async t=>{
 const f=await fixture(t,undefined,async()=>{throw Error('确认丢失')})
 f.adapter.scripts.push(textAnswer);const message=await f.send('progress-pending-shutdown');await f.agent.whenIdle()
 await f.ctx.fiber.dispose()
 const cold=await f.cold()
 assert.deepEqual(cold.inbox['next-turn'].map(row=>row.id),[message.id])
 assert.equal(cold.events.filter(event=>event.type==='agent/inbox/spliced'&&(event.data.removedCount??0)>0).length,0)
 assert.equal(f.adapter.requests.length,0)
})

test('有持久策略的显式本人取消继续清空待办，之后卸载不复活',options,async t=>{
 const f=await fixture(t)
 await f.send('progress-explicit-cancel',f.agent,false)
 f.agent.cancel({kind:'hook',reason:'本人取消'})
 await f.ctx.fiber.dispose()
 assert.deepEqual((await f.cold()).inbox['next-turn'],[])
})
test('未开启持久策略时保留原宿主卸载取消待办语义',options,async t=>{
 const f=await fixture(t,undefined,async()=>{},false)
 await f.send('unguarded-shutdown',f.agent,false);await f.ctx.fiber.dispose()
 assert.deepEqual((await f.cold()).inbox['next-turn'],[])
})
test('SDK required缺progress提供方在实际claim后保持零模型，scoped策略只能装一次',options,async t=>{
 const root=await mkdtemp('/private/tmp/teloa-progress-required-');t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,false,root),scoped=f.ctx.extend().agentLoop as typeof f.loop
 scoped.requireProgressCheckpoint()
 await f.send('progress-provider-missing')
 assert.equal(f.adapter.requests.length,0)
 scoped.installProgressCheckpoint(()=>Object.freeze({assertCurrent(){return undefined}}))
 assert.throws(()=>f.loop.installProgressCheckpoint(()=>{}))
})
for(const invalid of ['getter','promise'] as const)test(`SDK progress ${invalid}租约不可放行模型`,options,async t=>{
 const root=await mkdtemp('/private/tmp/teloa-progress-lease-');t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,false,root);let getters=0
 f.loop.requireProgressCheckpoint();f.loop.installProgressCheckpoint(()=>invalid==='getter'?Object.freeze({get assertCurrent(){getters++;return ()=>{}}}):Object.freeze({assertCurrent(){return Promise.reject(Error('不是同步租约'))}}))
 await f.send('progress-lease-'+invalid)
 assert.equal(f.adapter.requests.length,0);assert.equal(getters,0)
})
test('SDK progress await后的最后同步租约复核失效仍保持零模型',options,async t=>{
 const root=await mkdtemp('/private/tmp/teloa-progress-final-');t.after(()=>rm(root,{recursive:true,force:true}))
 const f=await loopWorkFixture(t,false,root);let assertions=0,finalDenied=false
 f.loop.requireProgressCheckpoint();f.loop.installProgressCheckpoint(input=>{
  const phase=(input as {phase:string}).phase
  return Object.freeze({assertCurrent(){if(phase==='claimed'&&++assertions===2){finalDenied=true;throw Error('最终同步租约失效')}return undefined}})
 })
 await f.send('progress-final-assertion');assert.equal(finalDenied,true);assert.equal(f.adapter.requests.length,0)
})
