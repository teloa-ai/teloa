import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {SessionSeq} from '@deepseek-ai/dsh-session'
import {quiescenceFixture,cancelledQuiescenceFixture,createUserMessage} from './fixtures/task-run-quiescence.ts'
import {assertSourceFollowupEvents,assertTaskRunQuiescentEvents,inspectTaskRunQuiescence} from '../src/task-run-source-followup.ts'
import {taskRunQuiescentSettlement} from '../src/task-run-quiescence.ts'

test('正常取消与两轮真实持久终态共用会话：暂停冷证明不把撤回历史当在途',async t=>{
 const f=await cancelledQuiescenceFixture(t),last=await f.appendCompleted(),before=await readFile(f.path)
 assert.equal(await taskRunQuiescentSettlement(f.ctx,f.owner,last,f.reader,AbortSignal.timeout(5000)),true)
 assert.deepEqual(await readFile(f.path),before)
 for(const kind of ['missing','input','receipt','active','foreign','effects'] as const){
  const original={input:f.cancelled.inputText,state:f.cancelled.state,hash:f.receipt.logSha256,role:f.cancelled.roleId}
  if(kind==='missing')f.absent(true)
  if(kind==='input')f.cancelled.inputText='不同的固定输入'
  if(kind==='receipt')f.receipt.logSha256='0'.repeat(64)
  if(kind==='active')f.cancelled.state='active'
  if(kind==='foreign')f.cancelled.roleId=randomUUID()
  if(kind==='effects')f.effects(true)
  assert.equal(await taskRunQuiescentSettlement(f.ctx,f.owner,last,f.reader,AbortSignal.timeout(5000)),false,kind)
  f.absent(false);f.effects(false);f.cancelled.inputText=original.input;f.cancelled.state=original.state;f.cancelled.roleId=original.role;f.receipt.logSha256=original.hash
 }
 assert.equal(f.ctx.get('agentLoop'),undefined);assert.equal(f.ctx.get('sessionController'),undefined)
})

test('维护取消双票据与普通取消均核完整历史：后继合法引用旧ID不等于旧请求发布',async t=>{
 const f=await cancelledQuiescenceFixture(t);f.maintained();await f.appendCompleted();const second=f.addCancelled(),last=await f.appendCompleted(),before=await readFile(f.path)
 assert.equal(await taskRunQuiescentSettlement(f.ctx,f.owner,last,f.reader,AbortSignal.timeout(5000)),true)
 assert.deepEqual(await readFile(f.path),before)
 // 重新读取同事务资格的对象，模拟真实消费边界；测试仅改副本，绝不改持久日志。
 const history=await Promise.all(f.history.map(run=>f.reader.readRun({} as never,f.owner,run.id)))
 const {readSourceFollowupUnpublishedHistory}=await import('@teloa/backend')
 const db=await f.reader.pool.connect()
 try{for(const run of history)if(run.state==='withdrawn')assert(await readSourceFollowupUnpublishedHistory(db,f.owner,run))}finally{db.release()}
 const later=f.events.findIndex(event=>event.type==='user/message'&&event.data.source.kind==='user'&&'rpcId' in event.data.source&&event.data.source.rpcId===last.nativeRequestId)
 assert(later>0)
 const header={type:'request/header',seq:SessionSeq(later+1),time:20,data:{header:{config:{provider:'test',model:'test'},tools:[{description:'合法工具说明引用 '+second.nativeRequestId}]},reason:'start',startsSeries:true}} as unknown as (typeof f.events)[number]
 const withHeader=structuredClone(f.events);withHeader.splice(later+1,0,header);withHeader.forEach((event,index)=>{event.seq=SessionSeq(index)})
 // 这里不借改endSeq规避prefix：header生产身份由真正已绑定user turn约束，原receipt cut之前完全不变。
 const lastProof=history.find(run=>run.id===last.id)!;assert(lastProof.evidence?.state==='ended');lastProof.evidence.endSeq++
 assert.doesNotThrow(()=>assertTaskRunQuiescentEvents(lastProof,withHeader,history))
 lastProof.evidence.endSeq--
 const replay=structuredClone(f.events),event=replay[later]!;assert.equal(event.type,'user/message');if(event.type==='user/message')replay[later]={...event,data:{...event.data,source:createUserMessage({source:{kind:'user',rpcId:second.nativeRequestId},content:[]}).source}}
 assert.throws(()=>assertTaskRunQuiescentEvents(history.find(run=>run.id===last.id)!,replay,history))
 assert.equal(f.ctx.get('agentLoop'),undefined)
})

test('暂停冷证明逐Run核验原ended和正式unknown；没有后继时复用原prefix且从不恢复Agent',async t=>{
 const f=await quiescenceFixture(t),before=await readFile(f.path),snapshot=structuredClone(f.unknown),history=[f.a1,f.unknown]
 for(const run of history)await inspectTaskRunQuiescence(f.ctx,run,AbortSignal.timeout(5000),history)
 assertSourceFollowupEvents(f.unknown,f.events);assert.deepEqual(f.unknown,snapshot);assert.deepEqual(await readFile(f.path),before)
 assert.equal(f.ctx.get('agentLoop'),undefined);assert.equal(f.ctx.get('sessionController'),undefined)
 const error={...f.a1,evidence:{state:'ended' as const,turn:1,messageSeq:1,endSeq:2,reason:'error' as const}}
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
