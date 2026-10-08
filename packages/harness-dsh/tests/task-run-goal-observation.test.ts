import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {observeTaskRun,observeTaskRunTimeline} from '../src/task-run-observation.ts'
import {readTaskRunGroupResult} from '../src/task-run-group-result.ts'
import {nativeInputIdentity} from '../src/native-input-access.ts'

const rows=(...items:any[])=>items.map((item,seq)=>({time:seq,seq,...item})) as SessionEvent[]
const start=(turn:number)=>({type:'turn/start',data:{turn}})
const end=(turn:number)=>({type:'turn/end',data:{turn,reason:{kind:'completed'}}})
const initial={id:'initial',role:'user',content:[],source:{kind:'user',rpcId:'request'}}
const continuation={id:'continuation',role:'user',content:[],source:{kind:'goal',goalId:'goal',revision:1,round:1}}
const user=(data:any)=>({type:'user/message',surfaceOp:'append',data})
const answer=(turn:number,text:string)=>({type:'assistant/message',surfaceOp:'append',data:{turn,message:{content:[{type:'text',text}]}}})
const binding={ownerId:'owner',runId:'run',sessionId:'session',goalId:'goal',revision:2,hostGeneration:1,controlId:'control',controlGeneration:1}
const receipt={...binding,revision:1,round:1,messageId:continuation.id,nativeRequestId:'goal-request',payloadSha256:nativeInputIdentity(continuation as any).payloadSha256,acceptedSeq:3,state:'accepted' as const}
const context=(phase='active',receipts:any[]=[receipt])=>({binding,continuations:receipts,goalPhase:phase,activation:'armed',pendingRound:false,childrenOutstanding:false}) as any

test('Goal 活跃时首轮完成不能结束 Run；最后已确认轮完成且 Goal complete 才回传',()=>{
 const first=rows(start(0),user(initial),end(0))
 assert.equal(observeTaskRun(first,'request',undefined,context()).state,'active')
 const log=rows(...first,{type:'agent/inbox/spliced',data:{inserted:[continuation]}},start(1),user(continuation),answer(1,'最后一轮成果'),end(1))
 assert.deepEqual(observeTaskRun(log,'request',undefined,context('complete')),{state:'ended',turn:0,messageSeq:1,endSeq:7,reason:'completed'})
 assert.equal(readTaskRunGroupResult(log,'request',undefined,context('complete')),'最后一轮成果')
 assert.equal(readTaskRunGroupResult(log,'request',undefined,context()),undefined)
})

test('Goal source 自报、别的 Run 票据、载荷篡改、未受理票据不能获得续轮资格',()=>{
 for(const receipts of [[],[{...receipt,runId:'other'}],[{...receipt,payloadSha256:'0'.repeat(64)}],[{...receipt,state:'reserved',acceptedSeq:null}]]){
  const log=rows(start(0),user(initial),end(0),{type:'agent/inbox/spliced',data:{inserted:[continuation]}},start(1),user(continuation))
  assert.equal(observeTaskRunTimeline(log,'request',undefined,undefined,context('complete',receipts)).authorized,false)
  assert.equal(observeTaskRun(log,'request',undefined,context('complete',receipts)).state,'ended')
 }
 const mixed=rows(start(0),user(initial),user(continuation))
 assert.equal(observeTaskRunTimeline(mixed,'request',undefined,undefined,context('complete',[])).authorized,false)
})

test('Goal 完成后仍有排队续轮或子工作，不能提前 ended',()=>{
 const log=rows(start(0),user(initial),end(0))
 for(const extra of [{pendingRound:true},{childrenOutstanding:true}])assert.equal(observeTaskRun(log,'request',undefined,{...context('complete'),...extra}).state,'active')
})

test('整项暂停的原生 aborted 保留未终态 Run；外来 Goal 仍不能取得资格',()=>{
 const log=rows(start(0),user(initial),{type:'turn/end',data:{turn:0,reason:{kind:'aborted'}}})
 assert.equal(observeTaskRun(log,'request',undefined,{...context('paused'),activation:'disarmed'}).state,'active')
 const mixed=rows(start(0),user(initial),user(continuation),{type:'turn/end',data:{turn:0,reason:{kind:'aborted'}}})
 assert.equal(observeTaskRunTimeline(mixed,'request',undefined,undefined,{...context('paused',[]),activation:'disarmed'}).authorized,false)
 const resumed=rows(...log,{type:'agent/inbox/spliced',data:{inserted:[continuation]}},start(1),user(continuation),answer(1,'恢复后有效成果'),end(1))
 assert.equal(observeTaskRun(resumed,'request',undefined,context('complete')).state,'ended');assert.equal(readTaskRunGroupResult(resumed,'request',undefined,context('complete')),'恢复后有效成果')
})
