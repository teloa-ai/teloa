import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {SessionSeq} from '@deepseek-ai/dsh-session'
import {quiescenceFixture} from './fixtures/task-run-quiescence.ts'
import {assertSourceFollowupEvents,assertTaskRunQuiescentEvents,inspectTaskRunQuiescence} from '../src/task-run-source-followup.ts'

test('暂停冷证明逐Run核验原ended和正式unknown；没有后继时复用原prefix且从不恢复Agent',async t=>{
 const f=await quiescenceFixture(t),before=await readFile(f.path),snapshot=structuredClone(f.unknown),history=[f.a1,f.unknown]
 for(const run of history)await inspectTaskRunQuiescence(f.ctx,run,AbortSignal.timeout(5000),history)
 assertSourceFollowupEvents(f.unknown,f.events);assert.deepEqual(f.unknown,snapshot);assert.deepEqual(await readFile(f.path),before)
 assert.equal(f.ctx.get('agentLoop'),undefined);assert.equal(f.ctx.get('sessionController'),undefined)
 const error={...f.a1,evidence:{...f.a1.evidence!,state:'ended' as const,turn:1,messageSeq:1,endSeq:2,reason:'error'}}
 const events=structuredClone(f.events);events[2]={type:'turn/end',seq:SessionSeq(2),time:3,data:{turn:1,reason:{kind:'error',error:{code:'UNKNOWN',message:'零输出失败'}}}}
 assert.doesNotThrow(()=>assertTaskRunQuiescentEvents(error,events,[error]))
})

test('F1已在原Session完成后再次暂停：可信终态后继可证明静止；新followup仍拒绝旧unknown带工作尾部',async t=>{
 const f=await quiescenceFixture(t),original=structuredClone(f.unknown),f1=await f.appendF1(),history=[f.a1,f.unknown,f1],before=await readFile(f.path)
 for(const run of history)await inspectTaskRunQuiescence(f.ctx,run,AbortSignal.timeout(5000),history)
 assert.throws(()=>assertSourceFollowupEvents(f.unknown,f.events),'暂停证明不能放宽新followup准入')
 assert.throws(()=>assertTaskRunQuiescentEvents(f.unknown,f.events,[f.a1,f.unknown]),'未持久绑定的新输入不可认领')
 assert.throws(()=>assertTaskRunQuiescentEvents(f.unknown,f.events,[f.a1,f.unknown,{...f1,state:'active'}]),'活动后继不能静止')
 assert.throws(()=>assertTaskRunQuiescentEvents({...f.unknown,submissionDisposition:{...f.unknown.submissionDisposition!,logSha256:'0'.repeat(64)}},f.events,[f.a1,{...f.unknown,submissionDisposition:{...f.unknown.submissionDisposition!,logSha256:'0'.repeat(64)}},f1]),'原prefix变化拒绝')
 assert.throws(()=>assertTaskRunQuiescentEvents(f.unknown,f.events,[f.a1,f.unknown,{...f1,taskId:randomUUID()}]),'跨Task不能认领原Session')
 const nativeRequestId=randomUUID(),id=randomUUID(),secondUnknown={...f.unknown,id,taskVersion:4,nativeRequestId,submissionDisposition:{...f.unknown.submissionDisposition!,runId:id,nativeRequestId,runtimeId:randomUUID(),requestId:randomUUID(),logCut:f.events.length-1,logSha256:createHash('sha256').update(JSON.stringify(f.events)).digest('hex')}}
 assert.doesNotThrow(()=>assertTaskRunQuiescentEvents(f.unknown,f.events,[...history,secondUnknown]),'第二次正式处置的unknown按各自prefix核对，不设人为数量上限')
 assert.throws(()=>assertTaskRunQuiescentEvents(f.unknown,f.events,[...history,{...secondUnknown,submissionDisposition:{...secondUnknown.submissionDisposition,logSha256:'0'.repeat(64)}}]),'任一unknown的prefix不符都拒绝')
 assert.deepEqual(f.unknown,original);assert.deepEqual(await readFile(f.path),before)
 let busy=true
 f.ctx.provide('jobs',{list:()=>busy?[{owner:f.unknown.sessionId,status:'running'}]:[]} as never)
 await assert.rejects(inspectTaskRunQuiescence(f.ctx,f.unknown,AbortSignal.timeout(5000),history),'当前宿主后台工作仍在途时不静止')
 busy=false;await inspectTaskRunQuiescence(f.ctx,f.unknown,AbortSignal.timeout(5000),history)
 f.ctx.provide('teloaNativeInput',{input:{hasPendingJobCompletion:()=>true,hasCancelledJobCompletion:()=>false}} as never)
 await assert.rejects(inspectTaskRunQuiescence(f.ctx,f.unknown,AbortSignal.timeout(5000),history),'当前官方完成通知仍在队列时不静止')
})
