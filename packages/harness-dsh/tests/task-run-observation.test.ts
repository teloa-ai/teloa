import test from 'node:test'
import assert from 'node:assert/strict'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {observeTaskRun,settledStopSeq,type StopFreeze} from '../src/task-run-observation.ts'

const events=(...rows:object[])=>rows.map((row,seq)=>({seq,time:seq,...row})) as SessionEvent[]
const start=(turn:number)=>({type:'turn/start',data:{turn}})
const end=(turn:number,kind:string)=>({type:'turn/end',data:{turn,reason:{kind}}})
const message=(rpcId:string)=>({type:'user/message',surfaceOp:'append',data:{id:rpcId,source:{kind:'user',rpcId},role:'user',content:[]}})

test('只把目标请求所在轮次作为执行证据，接收回执与其他会话轮次不代表成功',()=>{
 assert.deepEqual(observeTaskRun([], 'target'),{state:'unobserved'})
 assert.deepEqual(observeTaskRun(events(start(0),message('other'),end(0,'completed')),'target'),{state:'unobserved'})
 assert.deepEqual(observeTaskRun(events(start(0),message('target')),'target'),{state:'active',turn:0,messageSeq:1})
 assert.deepEqual(observeTaskRun(events(start(0),message('target'),end(0,'completed'),start(1),message('other')),'target'),{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
})

test('保留取消、受阻、模型失败、额度耗尽、崩溃修复与扩展终态，不归为任务结项',()=>{
 for(const reason of ['aborted','blocked','error','max-tokens','interrupted','plugin-limit']){
  assert.deepEqual(observeTaskRun(events(start(0),message('target'),end(0,reason)),'target'),{state:'ended',turn:0,messageSeq:1,endSeq:2,reason})
 }
})

test('不把插件注入与压缩副本认作本次请求，不猜测残缺日志或重复请求的结果',()=>{
 const plugin={...message('target'),data:{...message('target').data,source:{kind:'plugin',rpcId:'target'}}}
 const compacted={...message('target'),surfaceOp:'replace'}
 assert.deepEqual(observeTaskRun(events(start(0),plugin,compacted,end(0,'completed')),'target'),{state:'unobserved'})
 for(const log of [events(message('target')),events(start(0),message('target'),end(1,'completed')),events(start(0),start(1)),events(start(0),message('target'),message('target')),events(start(0),message('target'),end(0,'completed'),start(1),message('target'))])assert.throws(()=>observeTaskRun(log,'target'))
 assert.throws(()=>observeTaskRun(events(start(0),message('target')).slice(1),'target'))
 assert.throws(()=>observeTaskRun([],''))
})

test('停止收口判据：宿主不在运行且 seq 冻结够久才给出收口依据，仍在跑或还在长都不给',()=>{
 const memory=new Map<string,StopFreeze>()
 // 还在跑：不记时，也不给依据。
 assert.equal(settledStopSeq(memory,'run',true,19,1000),null)
 assert.equal(memory.size,0)
 // 首次读到静止只是开始计时；同一个 seq 熬满 3 秒才算冻结。
 assert.equal(settledStopSeq(memory,'run',false,19,1000),null)
 assert.equal(settledStopSeq(memory,'run',false,19,3999),null)
 assert.equal(settledStopSeq(memory,'run',false,19,4000),19)
 // 给过依据就不再留档，免得收口后的记录继续占着冻结表。
 assert.equal(memory.size,0)
 // seq 还在增长：计时从新的 seq 重新开始，中途不会凑满。
 assert.equal(settledStopSeq(memory,'run',false,19,1000),null)
 assert.equal(settledStopSeq(memory,'run',false,20,3999),null)
 assert.equal(settledStopSeq(memory,'run',false,20,4000),null)
 assert.equal(settledStopSeq(memory,'run',false,20,6999),20)
 // 又跑起来了：冻结记录作废，回到"还在跑"。
 memory.set('run',{seq:20,since:0})
 assert.equal(settledStopSeq(memory,'run',true,20,100000),null)
 assert.equal(memory.size,0)
 // 日志为空（lastSeq 为 -1）不构成依据。
 assert.equal(settledStopSeq(memory,'run',false,-1,1000),null)
 assert.equal(settledStopSeq(memory,'run',false,-1,100000),null)
})

test('官方后台完成续轮沿用初始请求锚点，只在最后一个续轮结束后终止',()=>{
 const notice={type:'user/message',surfaceOp:'append',data:{id:'job-notice',source:{kind:'tool-jobs',form:'notice',summary:'Job finished'},role:'user',content:[]}}
 const initial=events(start(0),message('target'),end(0,'completed'))
 assert.deepEqual(observeTaskRun(events(...initial,start(1),notice),'target'),{state:'active',turn:0,messageSeq:1})
 assert.deepEqual(observeTaskRun(events(...initial,start(1),notice,end(1,'completed')),'target'),{state:'ended',turn:0,messageSeq:1,endSeq:5,reason:'completed'})
 // 中间夹入另一个人类请求后，后续官方通知不继承原 Run。
 const unrelated=events(...initial,start(1),message('other'),end(1,'completed'),start(2),notice)
 assert.deepEqual(observeTaskRun(unrelated,'target'),{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'})
})
