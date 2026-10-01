import test from 'node:test'
import assert from 'node:assert/strict'
import {WorkError} from '@teloa/contract'
import {PlanCoordinator,type PlanCoordinatorPorts,type PlanCoordinatorReport} from '../src/plan-coordinator.ts'
import {startPlanScheduler} from '../src/plan-scheduler.ts'

const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const signal=()=>new AbortController().signal
const job=(claim:number)=>({claimId:id(claim),taskId:id(claim+100),taskCreatedVersion:1 as const,taskTitle:'计划任务',roleId:id(900),roleVersion:1})
function fixture(){
 const calls:string[]=[],reports:PlanCoordinatorReport[]=[],notificationReports:string[]=[],active=[{id:id(1),state:'active' as const}]
 const pending=[{id:id(11),planId:id(1),taskRequestId:id(21)}]
 const ready=new Map<string,ReturnType<typeof job>>()
 const ports:PlanCoordinatorPorts={
  plans:{schedulerPlans:async(owner)=>{assert.equal(owner,'owner');calls.push('plans');return {items:active}}},
  occurrences:{
   recover:async(owner,{planId,now})=>{assert.equal(owner,'owner');calls.push(`baseline:${planId}:${now}`)},
   recoveryPending:async(owner)=>{assert.equal(owner,'owner');calls.push('pending');return {items:[...pending]}},
   dispatchTask:async(owner,{claimId,taskRequestId})=>{assert.equal(owner,'owner');calls.push(`task:${claimId}:${taskRequestId}`);ready.set(claimId,job(Number(claimId.slice(-12))));const index=pending.findIndex(p=>p.id===claimId);if(index!==-1)pending.splice(index,1)},
   claim:async(owner,{planId})=>{assert.equal(owner,'owner');calls.push(`claim:${planId}`);return {occurrence:null,dispatch:false}},
   pendingExecutions:async(owner)=>{assert.equal(owner,'owner');calls.push('executions');return {items:[...ready.values()].map(job=>({job,action:'prepare' as const,run:null}))}},
  },
  dispatcher:{dispatch:async(owner,value)=>{assert.equal(owner,'owner');calls.push(`execute:${value.claimId}`)}},
  notifications:{deliver:async(owner)=>{assert.equal(owner,'owner')},report:code=>notificationReports.push(code)},
  report:async(owner,report)=>{assert.equal(owner,'owner');reports.push(report)},
 }
 return {ports,calls,reports,notificationReports,active,pending,ready,coordinator:new PlanCoordinator('owner',ports)}
}

test('启动先建立未来基线再恢复固定领取和执行；普通tick不重建新启用计划基线',async()=>{
 const f=fixture(),now='2026-09-12T00:00:00.000Z'
 await f.coordinator.recover(now,signal())
 assert.deepEqual(f.calls,['plans',`baseline:${id(1)}:${now}`,'pending',`task:${id(11)}:${id(21)}`,'executions',`execute:${id(11)}`])
 f.calls.length=0;f.active.push({id:id(2),state:'active'})
 await f.coordinator.tick('2026-09-12T00:00:02.000Z',signal())
 assert.ok(!f.calls.some(call=>call.startsWith('baseline:')))
 assert.ok(f.calls.indexOf('pending')<f.calls.indexOf(`claim:${id(2)}`))
 assert.ok(f.reports.some(report=>report.phase==='cycle'&&report.outcome==='success'))
})

test('宿主明确检测中断后恢复未来基线，失败计划下次重试基线而不补领历史',async()=>{
 const f=fixture();await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal());f.calls.length=0
 let failures=1
 f.ports.occurrences.recover=async(_owner,{planId,now})=>{f.calls.push(`baseline:${planId}:${now}`);if(failures-->0)throw new WorkError('teloa/source-unavailable','坏来源')}
 await f.coordinator.recover('2026-09-12T00:01:01.000Z',signal())
 assert.ok(f.calls.some(call=>call.startsWith('baseline:')));assert.ok(!f.calls.includes(`claim:${id(1)}`))
 f.calls.length=0;await f.coordinator.tick('2026-09-12T00:01:03.000Z',signal())
 assert.ok(f.calls.some(call=>call.startsWith('baseline:')));assert.ok(f.calls.includes(`claim:${id(1)}`))
})

test('逐计划和领取错误持久报告后继续其他工作，报告端口失败最终可见',async()=>{
 const f=fixture();f.active.push({id:id(2),state:'active'});f.pending.push({id:id(12),planId:id(2),taskRequestId:id(22)})
 const create=f.ports.occurrences.dispatchTask
 f.ports.occurrences.dispatchTask=async(owner,input)=>{if(input.claimId===id(11))throw new WorkError('teloa/conflict','不要泄漏原错误');return create(owner,input)}
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal())
 assert.ok(f.calls.includes(`execute:${id(12)}`))
 assert.ok(f.reports.some(report=>report.claimId===id(11)&&report.outcome==='failed'&&report.code==='teloa/conflict'))
 assert.ok(!JSON.stringify(f.reports).includes('不要泄漏原错误'))
 f.ports.report=async()=>{throw Error('状态持久化失败')}
 f.calls.length=0
 await assert.rejects(f.coordinator.tick('2026-09-12T00:00:02.000Z',signal()),/状态持久化失败/)
 assert.ok(f.calls.includes(`claim:${id(2)}`))
})

test('执行空页仍沿游标恢复，新领取后第二遍目录不重复处理本轮已见执行',async()=>{
 const f=fixture();f.pending.length=0
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal());f.calls.length=0
 const cursor={claimedAt:'2026-09-12T00:00:00.000Z',claimId:id(30)}
 f.ports.occurrences.pendingExecutions=async(_owner,input)=>{
  f.calls.push(`page:${input.cursor?.claimId??'first'}`)
  if(!input.cursor)return {items:[],cursor}
  return {items:[{job:job(31),action:'reconcile',run:{id:id(51)}},...(f.ready.has(id(32))?[{job:job(32),action:'prepare' as const,run:null}]:[])]}
 }
 f.ports.occurrences.claim=async()=>({occurrence:{id:id(32),planId:id(1),taskRequestId:id(42)},dispatch:true})
 await f.coordinator.tick('2026-09-12T00:00:02.000Z',signal())
 assert.equal(f.calls.filter(call=>call===`execute:${id(31)}`).length,1)
 assert.equal(f.calls.filter(call=>call===`execute:${id(32)}`).length,1)
 assert.ok(f.calls.includes(`task:${id(32)}:${id(42)}`))
})

test('取消后停止后续端口，已提交领取不回滚且下次按原身份恢复',async()=>{
 const f=fixture(),abort=new AbortController(),create=f.ports.occurrences.dispatchTask
 f.ports.occurrences.dispatchTask=async(owner,input)=>{await create(owner,input);abort.abort()}
 await assert.rejects(f.coordinator.recover('2026-09-12T00:00:00.000Z',abort.signal),{name:'AbortError'})
 assert.ok(!f.calls.includes('executions'));assert.equal(f.ready.size,1)
 f.ports.occurrences.dispatchTask=create
 await new PlanCoordinator('owner',f.ports).recover('2026-09-12T00:00:02.000Z',signal())
 assert.ok(f.calls.includes(`execute:${id(11)}`))
})

test('明确跳过不委托执行；重复分页游标显式报错而非无限循环',async()=>{
 const f=fixture();f.pending.length=0
 f.ports.occurrences.pendingExecutions=async()=>({items:[{job:job(11),action:'skip',reason:'task-ended',run:null}]})
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal())
 assert.ok(!f.calls.includes(`execute:${id(11)}`));assert.ok(f.reports.some(r=>r.outcome==='skipped'&&r.code==='teloa/task-ended'))
 const cursor={claimedAt:'2026-09-12T00:00:00.000Z',claimId:id(30)}
 f.ports.occurrences.pendingExecutions=async()=>({items:[],cursor})
 await f.coordinator.tick('2026-09-12T00:00:02.000Z',signal())
 assert.ok(f.reports.some(r=>r.outcome==='failed'&&r.code==='teloa/storage-corrupt'))
})

test('单个执行失败不阻断同页其他计划，周期失败状态不会被成功步骤清掉',async()=>{
 const f=fixture();f.pending.length=0;f.ready.set(id(11),job(11));f.ready.set(id(12),job(12))
 f.ports.dispatcher.dispatch=async(_owner,value)=>{f.calls.push(`execute:${value.claimId}`);if(value.claimId===id(11))throw new WorkError('teloa/execution-pending','等待核对')}
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal())
 assert.ok(f.calls.includes(`execute:${id(12)}`))
 assert.deepEqual(f.reports.at(-1),{phase:'cycle',now:'2026-09-12T00:00:00.000Z',outcome:'failed',code:'teloa/execution-pending'})
})

test('通知故障独立报告，不污染调度健康且不重新派发执行',async()=>{
 const f=fixture();let attempts=0
 f.ports.notifications.deliver=async()=>{attempts++;throw Error('Authorization: Bearer secret')}
 f.ports.notifications.report=code=>{f.notificationReports.push(code);throw Error('logger unavailable')}
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal())
 assert.equal(attempts,1);assert.deepEqual(f.notificationReports,['teloa/notification-unavailable'])
 assert.deepEqual(f.reports.at(-1),{phase:'cycle',now:'2026-09-12T00:00:00.000Z',outcome:'success'})
 assert.equal(f.calls.filter(call=>call===`execute:${id(11)}`).length,1)
 assert.ok(!JSON.stringify(f.notificationReports).includes('secret'))
})

test('取消失败报告后立即停止下一计划；并发协调请求被拒绝',async()=>{
 const f=fixture(),abort=new AbortController();f.active.push({id:id(2),state:'active'})
 let entered!:()=>void,release!:()=>void
 const reached=new Promise<void>(resolve=>{entered=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 f.ports.occurrences.recover=async()=>{entered();await gate;throw Error('failed')}
 f.ports.report=async()=>{abort.abort()}
 const running=f.coordinator.recover('2026-09-12T00:00:00.000Z',abort.signal)
 await reached
 await assert.rejects(f.coordinator.tick('2026-09-12T00:00:02.000Z',signal()),{code:'teloa/conflict'})
 release();await assert.rejects(running,{name:'AbortError'})
 assert.ok(!f.calls.includes('pending'))
})

test('现有scheduler可装配协调器，启动恢复后串行tick且卸载后不再调用',async()=>{
 const f=fixture(),queued:Array<()=>void>=[]
 let scheduled!:()=>void
 const ready=new Promise<void>(resolve=>{scheduled=resolve})
 const stop=startPlanScheduler({recover:(now,s)=>f.coordinator.recover(now,s),tick:(now,s)=>f.coordinator.tick(now,s),report:()=>assert.fail('正常调度不应报告外层失败')},()=>'2026-09-12T00:00:00.000Z',work=>{queued.push(work);scheduled();return ()=>{queued.length=0}})
 await ready
 assert.equal(f.calls.filter(call=>call.startsWith('baseline:')).length,1)
 assert.ok(f.calls.includes(`claim:${id(1)}`))
 await stop();assert.equal(queued.length,0)
})

test('页内坏领取逐项持久报告，仍处理同页正常执行和后续分页',async()=>{
 const f=fixture();f.pending.length=0
 const cursor={claimedAt:'2026-09-12T00:00:00.000Z',claimId:id(20)}
 f.ports.occurrences.pendingExecutions=async(_owner,input)=>input.cursor?
  {items:[{job:job(31),action:'prepare',run:null}]}:
  {items:[{job:job(12),action:'prepare',run:null}],errors:[{claimId:id(11),code:'teloa/storage-corrupt'}],cursor}
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal())
 assert.ok(f.reports.some(report=>report.claimId===id(11)&&report.outcome==='failed'&&report.code==='teloa/storage-corrupt'))
 assert.ok(f.calls.includes(`execute:${id(12)}`));assert.ok(f.calls.includes(`execute:${id(31)}`))
 assert.equal(f.reports.at(-1)?.outcome,'failed')
})

test('同周期同计划派发失败不能被后续未到期claim成功清掉，执行错误携带计划归属',async()=>{
 const f=fixture();await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal());f.reports.length=0
 f.pending.push({id:id(12),planId:id(1),taskRequestId:id(22)})
 f.ports.occurrences.dispatchTask=async()=>{throw new WorkError('teloa/source-unavailable','失败')}
 f.ports.occurrences.pendingExecutions=async()=>({items:[{planId:id(2),job:job(13),action:'prepare',run:null}]})
 f.ports.dispatcher.dispatch=async()=>{throw new WorkError('teloa/execution-pending','执行待核对')}
 await f.coordinator.tick('2026-09-12T00:00:02.000Z',signal())
 const planReports=f.reports.filter(report=>report.planId===id(1))
 assert.equal(planReports.at(-1)?.outcome,'failed');assert.ok(!planReports.some(report=>report.outcome==='success'))
 assert.ok(f.reports.some(report=>report.planId===id(2)&&report.outcome==='failed'))
})

test('坏计划和坏旧领取消耗分页后仍恢复后续正常计划，不再依赖全量list或pending',async()=>{
 const f=fixture();f.pending.length=0
 f.ports.plans.schedulerPlans=async(_owner,input)=>input.cursor?
  {items:[{id:id(2),state:'active'}]}:
  {items:[],errors:[{planId:id(1),code:'teloa/storage-corrupt'}],cursor:{id:id(1)}}
 f.ports.occurrences.recoveryPending=async(_owner,input)=>input.cursor?
  {items:[{id:id(12),planId:id(2),taskRequestId:id(22)}]}:
  {items:[],errors:[{claimId:id(11),planId:id(1),code:'teloa/storage-corrupt'}],cursor:{claimId:id(11),claimedAt:'2026-09-12T00:00:00.000Z'}}
 await f.coordinator.recover('2026-09-12T00:00:00.000Z',signal())
 assert.ok(f.calls.includes(`baseline:${id(2)}:2026-09-12T00:00:00.000Z`))
 assert.ok(f.calls.includes(`task:${id(12)}:${id(22)}`));assert.ok(f.calls.includes(`execute:${id(12)}`))
 assert.ok(f.reports.some(report=>report.phase==='pending'&&report.claimId===id(11)&&report.planId===id(1)&&report.outcome==='failed'))
 assert.equal(f.reports.filter(report=>report.planId===id(1)).at(-1)?.outcome,'failed')
 assert.equal(f.reports.filter(report=>report.planId===id(2)).at(-1)?.outcome,'success')
})
