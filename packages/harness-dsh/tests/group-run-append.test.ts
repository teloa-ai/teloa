import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {groupRunAppendRequestId,groupWorkInputTransitions,type GroupWorkInputState} from '@teloa/contract'
import {deliverGroupRunAppend,groupRunAppendAcceptedSeq,groupRunAwaitsApproval,type GroupRunAppendPorts} from '../src/group-run-append.ts'
import {observeTaskRunTimeline} from '../src/task-run-observation.ts'
import {groupRunAppendKey} from '../src/task-run-team-records.ts'

const R='dddddddd-1111-4111-8111-111111111111',T='cccccccc-1111-4111-8111-111111111111',RUN='ffffffff-1111-4111-8111-111111111111',S='eeeeeeee-1111-4111-8111-111111111111'
const runRequest='run-native-request',appendId=groupRunAppendRequestId('owner',R)
const user=(seq:number,rpcId:string):SessionEvent=>({seq,time:seq,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId},content:[],id:'m'+seq,role:'user'}} as unknown as SessionEvent)
const turn=(seq:number,kind:'turn/start'|'turn/end',n:number):SessionEvent=>({seq,time:seq,type:kind,data:kind==='turn/end'?{turn:n,reason:{kind:'completed'}}:{turn:n}} as unknown as SessionEvent)

function world(runState='active'){
 let row={requestId:R,taskId:T,taskVersion:3,runId:null as string|null,state:'reserved' as GroupWorkInputState,nativeRequestId:null as string|null,acceptedSeq:null as number|null,operation:'continue' as const}
 let events:SessionEvent[]=[turn(0,'turn/start',0),user(1,runRequest)]
 const submits:string[]=[]
 const ports:GroupRunAppendPorts={
  settle:async(_owner,input)=>{if(groupWorkInputTransitions[row.state].includes(input.state as GroupWorkInputState)&&(!row.nativeRequestId||!input.nativeRequestId||row.nativeRequestId===input.nativeRequestId))row={...row,state:input.state,runId:row.runId??input.runId,nativeRequestId:row.nativeRequestId??input.nativeRequestId??null,acceptedSeq:row.acceptedSeq??input.acceptedSeq??null};return {...row}},
  target:async()=>row.state==='reserved'&&['active','accepted'].includes(runState)?{runId:RUN,sessionId:S,text:'补上负责人列'}:null,
  events:async()=>events,
  run:async()=>({state:runState,sessionId:S}),
  submit:async(_session,id)=>{submits.push(id);events=[...events,user(events.length,id)]},
 }
 return {ports,read:()=>row,item:()=>({...row,groupId:S,messageId:S,observedRunId:RUN,versioned:false}),submits,setRun:(state:string)=>{runState=state},drop:()=>{events=events.filter(event=>!(event.type==='user/message'&&(event.data.source as {rpcId?:string}).rpcId===appendId))}}
}

test('活动 Run 追加：先持久登记原 Run 与派生原生身份，再经 queue 准入提交，按原生日志受理序号结算',async()=>{
 const w=world()
 assert.equal(await deliverGroupRunAppend('owner',w.item(),w.ports,AbortSignal.timeout(1000)),'accepted')
 assert.deepEqual(w.submits,[appendId])
 assert.deepEqual([w.read().state,w.read().runId,w.read().nativeRequestId,w.read().acceptedSeq],['accepted',RUN,appendId,2])
})

test('提交后未见受理证据：保持待核对，恢复只读日志不重发；原 Run 收敛仍未受理则交给新版本续办',async()=>{
 const w=world();w.ports.submit=async(_s,id)=>{w.submits.push(id)}
 assert.equal(await deliverGroupRunAppend('owner',w.item(),w.ports,AbortSignal.timeout(1000)),'pending')
 assert.equal(w.read().state,'unknown')
 assert.equal(await deliverGroupRunAppend('owner',w.item(),w.ports,AbortSignal.timeout(1000)),'pending')
 assert.equal(w.submits.length,1,'已有原生身份时绝不再次提交')
 w.setRun('ended')
 assert.equal(await deliverGroupRunAppend('owner',w.item(),w.ports,AbortSignal.timeout(1000)),'absent')
})

test('带新资料或原 Run 已收敛的追加不进入活动 Run（不热扩范围），交给收敛后的续办',async()=>{
 const w=world('ended')
 assert.equal(await deliverGroupRunAppend('owner',w.item(),w.ports,AbortSignal.timeout(1000)),'skipped')
 assert.deepEqual(w.submits,[])
})

test('运行观察：登记过的追加 rpcId 属于本 Run；未登记的本人输入仍切断续接资格',()=>{
 const events=[turn(0,'turn/start',0),user(1,runRequest),turn(2,'turn/end',0),turn(3,'turn/start',1),user(4,appendId)]
 assert.equal(observeTaskRunTimeline(events,runRequest,new Set([groupRunAppendKey(appendId)])).authorized,true)
 assert.equal(observeTaskRunTimeline(events,runRequest,new Set()).authorized,false)
 assert.equal(groupRunAppendAcceptedSeq(events,appendId),4)
 assert.equal(groupRunAppendAcceptedSeq(events,'other'),null)
})

test('原生审批待定：approval/asked 之后没有同 id 的 approval/decided 才算等待本人决定',()=>{
 const event=(seq:number,type:string,data:unknown)=>({seq,type,data}) as unknown as SessionEvent
 assert.equal(groupRunAwaitsApproval([]),false)
 assert.equal(groupRunAwaitsApproval([event(1,'approval/asked',{id:'a',toolName:'run_code'})]),true)
 assert.equal(groupRunAwaitsApproval([event(1,'approval/asked',{id:'a',toolName:'run_code'}),event(2,'approval/decided',{id:'a',outcome:'rejected'})]),false)
 assert.equal(groupRunAwaitsApproval([event(1,'approval/asked',{id:'a',toolName:'run_code'}),event(2,'approval/decided',{id:'a',outcome:'allowed-once'}),event(3,'approval/asked',{id:'b',toolName:'run_code'})]),true)
})
