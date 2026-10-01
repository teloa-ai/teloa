import test from 'node:test'
import assert from 'node:assert/strict'
import {startPlanScheduler} from '../src/plan-scheduler.ts'
import {PlanCoordinator} from '../src/plan-coordinator.ts'

const settle=()=>new Promise(resolve=>setImmediate(resolve))
const deferred=()=>{
 let resolve!:()=>void
 const promise=new Promise<void>(done=>{resolve=done})
 return {promise,resolve}
}

function observedClock(){
 let now='2026-09-12T00:59:58.000Z',work=()=>{},heartbeat=()=>{}
 return {clock:()=>now,set:(value:string)=>{now=value},work:()=>work(),beat:()=>heartbeat(),
  schedule:(callback:()=>void)=>{work=callback;return ()=>{}},
  observe:(callback:()=>void)=>{heartbeat=callback;return ()=>{}},
 }
}

test('正常异步扫描超过一分钟但心跳连续，仍领取扫描期间到期的计划',async()=>{
 const clock=observedClock(),gate=deferred(),id='00000000-0000-4000-8000-000000000001'
 let nextAt='',recoveries=0,claims=0,slow=false
 const coordinator=new PlanCoordinator('owner',{
  plans:{schedulerPlans:async()=>({items:[{id,state:'active'}]})},
  occurrences:{
   recover:async(_owner,{now})=>{recoveries++;nextAt=now<'2026-09-12T01:00:00.000Z'?'2026-09-12T01:00:00.000Z':'2026-09-13T01:00:00.000Z'},
   recoveryPending:async()=>{if(slow){slow=false;await gate.promise}return {items:[]}},
   pendingExecutions:async()=>({items:[]}),dispatchTask:async()=>{},
   claim:async(_owner,{now})=>{if(now>=nextAt){claims++;nextAt='2026-09-13T01:00:00.000Z'}return {occurrence:null,dispatch:false}},
  },dispatcher:{dispatch:async()=>{}},notifications:{deliver:async()=>{},report:()=>{}},report:async()=>{},
 })
 const stop=startPlanScheduler({recover:(now,signal)=>coordinator.recover(now,signal),tick:(now,signal)=>coordinator.tick(now,signal),report:()=>assert.fail('连续心跳不应报错')},clock.clock,clock.schedule,{observe:clock.observe})
 await settle();slow=true;clock.set('2026-09-12T00:59:59.000Z');clock.work();await settle()
 for(const now of ['2026-09-12T01:00:20.000Z','2026-09-12T01:00:40.000Z','2026-09-12T01:01:01.000Z']){clock.set(now);clock.beat();await settle()}
 gate.resolve();await settle();clock.work();await settle()
 assert.equal(recoveries,1);assert.equal(claims,1);await stop()
})

test('异步扫描期间心跳真正长中断会取消本周期，再恢复未来基线',async()=>{
 const clock=observedClock(),gate=deferred()
 let recoveries=0,ticks=0,aborted=false
 const stop=startPlanScheduler({recover:async()=>{recoveries++},tick:async(_now,signal)=>{ticks++;if(ticks===1){await gate.promise;aborted=signal.aborted;signal.throwIfAborted()}},report:()=>{}},clock.clock,clock.schedule,{observe:clock.observe})
 await settle();clock.set('2026-09-12T01:01:01.000Z');clock.beat();gate.resolve();await settle()
 clock.work();await settle();assert.equal(aborted,true);assert.equal(recoveries,2);assert.equal(ticks,2);await stop()
})

test('空闲时长间断或时钟回退，即使工作timer先到也先恢复',async()=>{
 const clock=observedClock(),calls:string[]=[]
 const stop=startPlanScheduler({recover:async()=>{calls.push('recover')},tick:async()=>{calls.push('tick')},report:()=>{}},clock.clock,clock.schedule,{observe:clock.observe})
 await settle();clock.set('2026-09-12T01:01:01.000Z');clock.work();await settle()
 clock.set('2026-09-12T01:00:59.000Z');clock.work();await settle()
 assert.deepEqual(calls,['recover','tick','recover','tick','recover','tick']);await stop()
})

test('恢复期间真正中断不会将旧恢复标为成功，下一周期仍重试恢复',async()=>{
 const clock=observedClock(),gate=deferred()
 let recoveries=0,ticks=0
 const stop=startPlanScheduler({recover:async()=>{recoveries++;if(recoveries===1)await gate.promise},tick:async()=>{ticks++},report:()=>{}},clock.clock,clock.schedule,{observe:clock.observe})
 clock.set('2026-09-12T01:01:01.000Z');clock.beat();gate.resolve();await settle()
 assert.equal(ticks,0);clock.work();await settle();assert.equal(recoveries,2);assert.equal(ticks,1);await stop()
})

test('停止同时取消工作与观察计时器，迟到回调不能重启或继续安排心跳',async()=>{
 let work=()=>{},heartbeat=()=>{},cancelledWork=0,cancelledHeartbeat=0,observations=0,ticks=0
 const stop=startPlanScheduler({recover:async()=>{},tick:async()=>{ticks++},report:()=>{}},()=>'2026-09-12T00:00:00.000Z',callback=>{work=callback;return ()=>{cancelledWork++}},{observe:callback=>{observations++;heartbeat=callback;return ()=>{cancelledHeartbeat++}}})
 await settle();await stop();await stop();work();heartbeat();await settle()
 assert.equal(cancelledWork,1);assert.equal(cancelledHeartbeat,1);assert.equal(observations,1);assert.equal(ticks,1)
})

test('首次恢复失败不领取，下一轮重试恢复成功后才开始领取',async()=>{
 let scheduled=()=>{},recoveries=0,ticks=0
 const reports:Array<[string,string]>=[],times=['2026-09-11T09:00:00.000Z','2026-09-11T09:00:02.000Z','2026-09-11T09:00:03.000Z']
 let timeIndex=0
 const stop=startPlanScheduler({
  recover:async now=>{assert.equal(now,times[recoveries]);recoveries++;if(recoveries===1)throw {code:'teloa/recovery-unavailable'}},
  tick:async now=>{assert.equal(now,times[2]);ticks++},
  report:(phase,code)=>reports.push([phase,code]),
 },()=>times[timeIndex++]!,work=>{scheduled=work;return ()=>{}})
 await settle()
 assert.equal(recoveries,1)
 assert.equal(ticks,0)
 assert.deepEqual(reports,[['recover','teloa/recovery-unavailable']])

 scheduled();await settle()
 assert.equal(recoveries,2)
 assert.equal(ticks,1)
 await stop()
})

test('重复计时回调不会让领取重叠，本轮完成后才安排下一轮',async()=>{
 let scheduled=()=>{},scheduleCount=0,tickCount=0,active=0,maxActive=0,cancelled=0
 const secondTick=deferred()
 const stop=startPlanScheduler({
  recover:async()=>{},
  tick:async()=>{
   tickCount++;active++;maxActive=Math.max(maxActive,active)
   if(tickCount===2)await secondTick.promise
   active--
  },
  report:()=>{},
 },()=>new Date().toISOString(),work=>{scheduled=work;scheduleCount++;return ()=>{cancelled++}})
 await settle()
 assert.equal(tickCount,1)
 assert.equal(scheduleCount,1)

 scheduled();scheduled();await settle()
 assert.equal(tickCount,2)
 assert.equal(maxActive,1)
 assert.equal(scheduleCount,1)
 secondTick.resolve();await settle()
 assert.equal(scheduleCount,2)

 const stale=scheduled
 await stop()
 stale();await settle()
 assert.equal(tickCount,2)
 assert.equal(cancelled,1)
})

test('领取失败会上报脱敏错误并在下一轮继续运行',async()=>{
 let scheduled=()=>{},ticks=0,recoveries=0
 const reports:Array<[string,string]>=[]
 const stop=startPlanScheduler({
  recover:async()=>{recoveries++},
  tick:async()=>{ticks++;if(ticks===1)throw Error('database password in private detail')},
  report:(phase,code)=>reports.push([phase,code]),
 },()=>new Date().toISOString(),work=>{scheduled=work;return ()=>{}})
 await settle()
 assert.deepEqual(reports,[['tick','teloa/plan-scheduler-unavailable']])
 assert.ok(!reports[0]![1].includes('private'))

 scheduled();await settle()
 assert.equal(recoveries,1)
 assert.equal(ticks,2)
 await stop()
})

test('恢复进行中停止会等待恢复结束，并且不再领取或定时',async()=>{
 const recovery=deferred()
 let tickCount=0,scheduleCount=0,stopped=false
 const stop=startPlanScheduler({
  recover:async()=>recovery.promise,
  tick:async()=>{tickCount++},
  report:()=>{},
 },()=>new Date().toISOString(),work=>{scheduleCount++;return ()=>{void work}})
 await settle()
 const ending=stop().then(()=>{stopped=true})
 await settle()
 assert.equal(stopped,false)

 recovery.resolve();await ending
 assert.equal(tickCount,0)
 assert.equal(scheduleCount,0)
})

test('领取进行中停止会发出取消信号，端口可据此阻止下一次领取并完成清理',async()=>{
 const cleanup=deferred()
 let claims=0,sawAbort=false,finished=false
 const stop=startPlanScheduler({
  recover:async(_now,signal)=>{assert.equal(signal.aborted,false)},
  tick:async(_now,signal)=>{
   claims++
   await new Promise<void>(resolve=>signal.addEventListener('abort',()=>{sawAbort=true;resolve()},{once:true}))
   await cleanup.promise
   if(!signal.aborted)claims++
  },
  report:()=>{},
 },()=>new Date().toISOString(),()=>()=>{})
 await settle()
 const ending=stop().then(()=>{finished=true})
 await settle()
 assert.equal(sawAbort,true)
 assert.equal(finished,false)

 cleanup.resolve();await ending
 assert.equal(claims,1)
})

test('重复停止复用同一个等待结果且只取消一次计时',async()=>{
 let cancelled=0,ticks=0
 const stop=startPlanScheduler({
  recover:async()=>{},
  tick:async()=>{ticks++},
  report:()=>{},
 },()=>new Date().toISOString(),()=>()=>{cancelled++})
 await settle()

 const first=stop(),second=stop()
 assert.equal(first,second)
 await Promise.all([first,second])
 assert.equal(cancelled,1)
 assert.equal(ticks,1)
})

test('错误报告端口抛错不会终止后续调度',async()=>{
 let scheduled=()=>{},ticks=0,reports=0
 const stop=startPlanScheduler({
  recover:async()=>{},
  tick:async()=>{ticks++;if(ticks===1)throw Error('tick failed')},
  report:()=>{reports++;throw Error('report failed')},
 },()=>new Date().toISOString(),work=>{scheduled=work;return ()=>{}})
 await settle()
 assert.equal(reports,1)

 scheduled();await settle()
 assert.equal(ticks,2)
 await stop()
})
