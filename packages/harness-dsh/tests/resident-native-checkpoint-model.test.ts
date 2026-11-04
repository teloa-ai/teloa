import test from 'node:test'
import assert from 'node:assert/strict'
import {nativeCheckpointRequestHeader} from '../src/resident-work-runtime.ts'
import {loopWorkFixture,loopText} from './fixtures/native-loop-work-admission.ts'

for(const mode of ['initial','same-turn','next-turn'] as const)test('检查点模型来源：'+mode,async t=>{
 const f=await loopWorkFixture(t,true)
 f.adapter.scripts.push(loopText)
 await f.send('first-owner')
 const first=f.events.find(event=>event.type==='turn/start')
 const header=f.events.find(event=>event.type==='request/header')
 assert.ok(first&&header)
 if(mode==='initial')assert.equal(nativeCheckpointRequestHeader(f.events.slice(0,first.seq+1),1),undefined)
 else if(mode==='same-turn')assert.deepEqual(nativeCheckpointRequestHeader(f.events,1),header)
 else{
  f.adapter.scripts.push(loopText)
  await f.send('second-owner')
  const second=f.events.find(event=>event.type==='turn/start'&&event.data.turn===2)
  assert.ok(second)
  assert.equal(nativeCheckpointRequestHeader(f.events.slice(0,second.seq+1),2),undefined,'新轮模型尚未派发，不能继承上一轮header')
 }
})
