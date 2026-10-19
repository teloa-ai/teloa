import test from 'node:test'
import assert from 'node:assert/strict'
import {nativeHotCausalityFixture,textAnswer} from './fixtures/native-hot-causality.ts'

test('原Run的真实群续办根可进入交付复核，未登记追加、错误会话和撤权仍拒绝',{timeout:10000},async t=>{
 const f=await nativeHotCausalityFixture(t)
 f.adapter.scripts.push(textAnswer,textAnswer)
 let rounds=0,appendMessageId:string|undefined,verified=false
 const admitted=new Set(['group-append-rpc'])
 f.ctx.on('agent/turn-stopping',()=>{
  rounds++
  if(rounds===1){
   assert.equal(f.work.readReviewState(f.agent,'original-rpc').pendingInput,false)
   return
  }
  assert.throws(()=>f.work.readReviewState(f.agent,'original-rpc'),{code:'teloa/forbidden'},'未提供同Run持久追加身份时保持拒绝')
  assert.throws(()=>f.work.readReviewState(f.agent,'original-rpc',new Set(['different-rpc'])),{code:'teloa/forbidden'})
  assert.throws(()=>f.work.readReviewState(f.other,'original-rpc',admitted),{code:'teloa/forbidden'})
  const state=f.work.readReviewState(f.agent,'original-rpc',admitted)
  assert.deepEqual(state.continuationMessageIds,[appendMessageId])
  assert.equal(state.pendingInput,false)
  assert.ok(Object.isFrozen(state.continuationMessageIds))
  f.rights.revoked=true
  assert.throws(()=>f.work.readReviewState(f.agent,'original-rpc',admitted),{code:'teloa/forbidden'},'登记追加不抵消现行许可撤回')
  verified=true
 })
 await f.send('original-rpc');await f.agent.whenIdle()
 const message=await f.send('group-append-rpc');appendMessageId=message.id
 await f.agent.whenIdle()
 assert.equal(rounds,2)
 assert.equal(verified,true,'全部复核及撤权断言必须实际完成，不以事件回调报错冒充通过')
})
