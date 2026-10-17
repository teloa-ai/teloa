import test from 'node:test'
import assert from 'node:assert/strict'
import type {TaskRun} from '@teloa/backend'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import * as budget from '../src/resident-model-budget.ts'
const run={id:'11111111-1111-4111-8111-111111111111',sessionId:'original-session',nativeRequestId:'22222222-2222-4222-8222-222222222222',state:'ended',evidence:{state:'ended',turn:1,messageSeq:1,endSeq:3,reason:'interrupted'}} as TaskRun
const events=[{seq:0,time:1000,type:'turn/start',data:{turn:1}},{seq:1,time:1001,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:run.nativeRequestId}}},{seq:2,time:1001,type:'turn/end',data:{turn:1,reason:{kind:'interrupted'}}},{seq:3,time:46000,type:'session/end-seed',data:{}}] as SessionEvent[]
const read=(value:TaskRun,rows:SessionEvent[]=events,sessionId=run.sessionId,inheritedEventCount=0)=>(budget as unknown as {runBudgetTerminal:(run:TaskRun,snapshot:{sessionId:string;events:readonly SessionEvent[];inheritedEventCount:number})=>unknown}).runBudgetTerminal(value,{sessionId,events:rows,inheritedEventCount})
test('原生修复turn/end复用旧时间时只以同Run正式end-seed封口时刻停止耗时',()=>{
 assert.deepEqual(read(run),{schema:'teloa.work-budget-terminal/v1',runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,turn:1,messageSeq:1,endSeq:3,turnEndSeq:2,terminalKind:'session/end-seed',endedAt:new Date(46000).toISOString()})
 const direct={...run,evidence:{...run.evidence!,endSeq:2}}
 assert.equal((read(direct,events.slice(0,3)) as {terminalKind:string}).terminalKind,'turn/end')
})
test('不接受错会话/请求/序号、未终态、继承输入或外来消息作为预算结束证据',()=>{
 for(const value of [{...run,state:'active'},{...run,nativeRequestId:'33333333-3333-4333-8333-333333333333'},{...run,evidence:{...run.evidence!,endSeq:4}}])assert.equal(read(value as TaskRun),null)
 assert.equal(read(run,events,'foreign-session'),null);assert.equal(read(run,events,run.sessionId,2),null)
 assert.equal(read(run,events.map(row=>row.seq===3?{...row,data:{inherited:true}} as SessionEvent:row)),null)
 assert.equal(read(run,events.map(row=>row.seq===3?{...row,time:NaN}:row)),null)
 const foreign=[...events.slice(0,2),{seq:2,time:2000,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'foreign'}}},...events.slice(2).map(row=>({...row,seq:row.seq+1}))] as SessionEvent[]
 assert.equal(read({...run,evidence:{...run.evidence!,endSeq:4}} as TaskRun,foreign),null)
})
test('冻结终态之后的独立追加不抹掉原Run可信前缀或扩大原Run耗时区间',()=>{
 const later=[...events,{seq:4,time:50000,type:'turn/start',data:{turn:2}},{seq:5,time:50001,type:'user/message',surfaceOp:'append',data:{source:{kind:'user',rpcId:'later-independent-request'}}}] as SessionEvent[]
 assert.deepEqual(read(run,later),read(run))
 const direct={...run,evidence:{...run.evidence!,endSeq:2}}
 assert.deepEqual(read(direct,events),read(direct,events.slice(0,3)))
})
