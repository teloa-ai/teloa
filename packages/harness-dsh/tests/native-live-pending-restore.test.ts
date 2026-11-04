import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {WorkError} from '@teloa/contract'
import {nativeInputIdentity} from '../src/native-input-access.ts'
import type {NativeInputRestoreInput} from '../src/native-input-checkpoint.ts'
import {nativeHotCausalityFixture,hotGate,textAnswer} from './fixtures/native-hot-causality.ts'
import {readSessionEvents} from '../src/session-events.ts'

async function fixture(t:TestContext){
 const root=await mkdtemp(join(tmpdir(),'teloa-live-pending-'));t.after(()=>rm(root,{recursive:true,force:true}))
 const state={checkpoint:false,manual:false,epoch:0},seen:NativeInputRestoreInput[]=[]
 let wait:ReturnType<typeof hotGate>|undefined
 const f=await nativeHotCausalityFixture(t,{persistenceRoot:root,checkpoint:async()=>{if(!state.checkpoint)throw Error('检查点确认丢失')},restore:async input=>{
  seen.push(input);const epoch=state.epoch
  if(!state.manual)throw new WorkError('teloa/forbidden','没有本人显式恢复许可')
  await wait?.wait(input.signal)
  const assertCurrent=()=>{input.signal.throwIfAborted();if(!state.manual||epoch!==state.epoch)throw new WorkError('teloa/forbidden','恢复许可已失效');return undefined}
  assertCurrent()
  return Object.freeze({roots:Object.freeze(input.messages.map(message=>Object.freeze({sessionId:input.sessionId,messageId:message.id,nativeRequestId:Reflect.get(message.source,'rpcId') as string,payloadSha256:nativeInputIdentity(message).payloadSha256}))),assertCurrent})
 }})
 return {...f,state,seen,setWait(value:ReturnType<typeof hotGate>|undefined){wait=value}}
}

test('真实writer显式重核原待办：原许可过期仍不重投，恢复只领取同一Inbox一次', {timeout:10000},async t=>{
 const f=await fixture(t),message=await f.send('already-accepted');await f.agent.whenIdle()
 const prefix=[...readSessionEvents(f.agent.session)]
 assert.equal(f.adapter.requests.length,0);assert.deepEqual(f.agent.inbox.nextTurn.map(input=>input.id),[message.id])
 f.rights.generation++
 await assert.rejects(f.work.wakePending(f.agent),{code:'teloa/forbidden'})
 assert.deepEqual(readSessionEvents(f.agent.session),prefix)
 f.state.manual=true;f.state.checkpoint=true;f.adapter.scripts.push(textAnswer)
 assert.equal(await f.work.wakePending(f.agent),true);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1);assert.deepEqual(f.agent.inbox.nextTurn,[])
 const events=readSessionEvents(f.agent.session)
 assert.deepEqual(events.slice(0,prefix.length),prefix)
 assert.equal(events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(input=>input.id===message.id)).length,1)
 assert.equal(events.filter(event=>event.type==='user/message'&&event.data.id===message.id).length,1)
 f.state.manual=false;f.state.epoch++
 f.adapter.scripts.push(textAnswer);await f.send('later-user-input');await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,2,'恢复根结束后不钉住本人后续新输入')
})

for(const change of ['revoke','cancel'] as const)test('显式恢复等待中'+change+'及迟到成功均不派发模型',{timeout:10000},async t=>{
 const f=await fixture(t);await f.send('pending-'+change);await f.agent.whenIdle()
 const prefix=[...readSessionEvents(f.agent.session)],gate=hotGate();t.after(gate.release)
 f.state.manual=true;f.state.checkpoint=true;f.setWait(gate)
 const resumed=f.work.wakePending(f.agent);await gate.entered
 if(change==='revoke')f.state.epoch++;else f.agent.cancel({kind:'user'},{keepInbox:true})
 gate.release();await assert.rejects(resumed);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,0);assert.equal(f.counters.tools,0)
 assert.deepEqual(readSessionEvents(f.agent.session),prefix)
 assert.equal(f.agent.inbox.nextTurn.length,1)
})

test('并发恢复仅有一个物理维护窗口，伪造Agent不能进入实际writer',{timeout:10000},async t=>{
 const f=await fixture(t);await f.send('one-pending-input');await f.agent.whenIdle()
 const gate=hotGate();t.after(gate.release)
 f.state.manual=true;f.state.checkpoint=true;f.setWait(gate);f.adapter.scripts.push(textAnswer)
 const first=f.work.wakePending(f.agent);await gate.entered
 assert.equal(await f.work.wakePending(f.agent),false)
 await assert.rejects(f.work.wakePending({...f.agent} as typeof f.agent),{code:'teloa/forbidden'})
 gate.release();assert.equal(await first,true);await f.agent.whenIdle()
 assert.equal(f.seen.length,1);assert.equal(f.adapter.requests.length,1)
})
