import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializePlans,PlanService} from '../src/work/plans.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializePlanOccurrences,PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializePlanSchedulerStatus,PlanSchedulerStatusService} from '../src/work/plan-scheduler-status.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializePlans(pool);await initializeTasks(pool);await initializePlanOccurrences(pool);await initializeTaskRuns(pool);await initializePlanSchedulerStatus(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function activePlan(owner:string,now='2026-09-12T00:00:00.000Z'){
 const identity={id:randomUUID,now:()=>now},roles=new RoleService(pool,identity)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调度岗',kind:'employee',scopes:['general'],duty:'核对',dataScope:'已授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const plans=new PlanService(pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日核对',goal:'核对资料',scope:'general',dataScope:'已授权资料',delivery:'摘要',roleId:role.id,expectedRoleVersion:1,trigger:schedule,notificationPolicy:'attention'},source:{kind:'manual'}})
 const plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 return {plan,role}
}

test('本人总状态与每计划状态分别保存，成功清除安全失败码并保留最近成功时间',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),times=['2026-09-12T00:00:01.000Z','2026-09-12T00:00:02.000Z','2026-09-12T00:00:03.000Z'],service=new PlanSchedulerStatusService(pool,{now:()=>times.shift()!})
 const ownerFailure=await service.record(owner,{outcome:'failed',code:'teloa/scheduler-cycle-failed'})
 assert.deepEqual(ownerFailure,{ownerId:owner,planId:null,health:'failing',failureCode:'teloa/scheduler-cycle-failed',lastAttemptAt:'2026-09-12T00:00:01.000Z',lastSuccessAt:null})
 const planSuccess=await service.record(owner,{planId:plan.id,outcome:'success'})
 assert.equal(planSuccess.health,'healthy');assert.equal(planSuccess.lastSuccessAt,'2026-09-12T00:00:02.000Z')
 const recovered=await service.record(owner,{outcome:'success'})
 assert.deepEqual(recovered,{ownerId:owner,planId:null,health:'healthy',failureCode:null,lastAttemptAt:'2026-09-12T00:00:03.000Z',lastSuccessAt:'2026-09-12T00:00:03.000Z'})
 assert.deepEqual(await service.get(owner,{}),recovered)
 assert.deepEqual(await service.get(owner,{planId:plan.id}),planSuccess)
 assert.deepEqual(await service.list(owner,{}),[recovered,planSuccess])
 assert.deepEqual(await service.list('other',{}),[])
 await assert.rejects(service.get('other',{planId:plan.id}),{code:'teloa/forbidden'})
})

test('旧时间不覆盖新状态，同一时间失败优先且失败码确定',async()=>{
 const owner=randomUUID(),clock={value:'2026-09-12T00:00:03.000Z'},service=new PlanSchedulerStatusService(pool,{now:()=>clock.value})
 const newest=await service.record(owner,{outcome:'success'})
 clock.value='2026-09-12T00:00:01.000Z'
 assert.deepEqual(await service.record(owner,{outcome:'failed',code:'teloa/z-failed'}),newest)
 clock.value='2026-09-12T00:00:03.000Z'
 const results=await Promise.all([
  service.record(owner,{outcome:'success'}),
  service.record(owner,{outcome:'failed',code:'teloa/z-failed'}),
  service.record(owner,{outcome:'failed',code:'teloa/a-failed'}),
 ])
 assert.ok(results.every(row=>row.health==='failing'||row.health==='healthy'))
 assert.deepEqual(await service.get(owner,{}),{ownerId:owner,planId:null,health:'failing',failureCode:'teloa/a-failed',lastAttemptAt:'2026-09-12T00:00:03.000Z',lastSuccessAt:'2026-09-12T00:00:03.000Z'})
})

test('状态写入严格拒绝未知字段、原始错误和不属于本人的计划',async()=>{
 const owner=randomUUID(),{plan}=await activePlan(owner),service=new PlanSchedulerStatusService(pool,{now:()=>new Date().toISOString()})
 for(const input of [
  {outcome:'failed'},
  {outcome:'failed',code:'database password=secret'},
  {outcome:'success',code:'teloa/not-used'},
  {outcome:'skipped'},
  {outcome:'success',error:'raw secret'},
 ])await assert.rejects(service.record(owner,input),{code:'teloa/invalid-input'})
 await assert.rejects(service.record('other',{planId:plan.id,outcome:'success'}),{code:'teloa/forbidden'})
 assert.deepEqual(await service.list(owner,{}),[])
})

async function claimedTask(owner:string){
 const {plan}=await activePlan(owner,'2026-09-12T00:00:00.000Z'),occurrences=new PlanOccurrenceService(pool,{id:randomUUID})
 const occurrence=(await occurrences.claim(owner,{planId:plan.id,now:'2026-09-12T01:00:00.000Z'})).occurrence!
 const {task}=await occurrences.dispatchTask(owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:'2026-09-12T01:00:01.000Z'})
 return {occurrence,task}
}

test('终态且无执行的真实领取可并发幂等确认，固定回执按本人读取',async()=>{
 const owner=randomUUID(),{occurrence,task}=await claimedTask(owner)
 await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 const service=new PlanSchedulerStatusService(pool,{now:()=> '2026-09-12T02:00:00.000Z'}),input={claimId:occurrence.id,taskId:task.id,reason:'task-ended' as const}
 const results=await Promise.all(Array.from({length:6},()=>service.acknowledge(owner,input)))
 const expected={ownerId:owner,claimId:occurrence.id,taskId:task.id,reason:'task-ended',acknowledgedAt:'2026-09-12T02:00:00.000Z'}
 assert.ok(results.every(row=>JSON.stringify(row)===JSON.stringify(expected)))
 assert.deepEqual(await service.acknowledgement(owner,{claimId:occurrence.id}),expected)
 await assert.rejects(service.acknowledgement('other',{claimId:occurrence.id}),{code:'teloa/forbidden'})
 assert.equal((await pool.query('select count(*)::int as count from teloa_plan_scheduler_acks where claim_id=$1',[occurrence.id])).rows[0].count,1)
})

test('确认等待领取锁时不先占任务锁，避免与任务关联反序死锁',async()=>{
 const owner=randomUUID(),{occurrence,task}=await claimedTask(owner)
 await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 const holder=await pool.connect(),probe=await pool.connect(),service=new PlanSchedulerStatusService(pool,{now:()=> '2026-09-12T02:00:00.000Z'})
 let pending:Promise<unknown>|undefined
 try{
  await holder.query('begin');await holder.query('select id from teloa_plan_occurrences where id=$1 for update',[occurrence.id])
  pending=service.acknowledge(owner,{claimId:occurrence.id,taskId:task.id,reason:'task-ended'})
  for(let attempt=0;attempt<100;attempt++){
   const waiting=await pool.query("select 1 from pg_stat_activity where wait_event_type='Lock' and query like 'select * from teloa_plan_occurrences where id=$1%'")
   if(waiting.rowCount)break
   if(attempt===99)throw Error('确认请求没有等待领取锁')
   await new Promise(resolve=>setTimeout(resolve,5))
  }
  await probe.query('begin')
  await probe.query('select id from teloa_tasks where id=$1 for update nowait',[task.id])
  await probe.query('rollback')
 }finally{
  await probe.query('rollback');probe.release();await holder.query('commit');holder.release();await pending
 }
})

test('跳过确认拒绝非终态、错误任务、已有执行及损坏关联',async()=>{
 const owner=randomUUID(),first=await claimedTask(owner),service=new PlanSchedulerStatusService(pool,{now:()=> '2026-09-12T02:00:00.000Z'})
 const input={claimId:first.occurrence.id,taskId:first.task.id,reason:'task-ended' as const}
 await assert.rejects(service.acknowledge(owner,input),{code:'teloa/conflict'})
 await pool.query("update teloa_tasks set state='cancelled' where id=$1",[first.task.id])
 const other=await claimedTask(owner)
 await pool.query("update teloa_tasks set state='completed' where id=$1",[other.task.id])
 await assert.rejects(service.acknowledge(owner,{...input,taskId:other.task.id}),{code:'teloa/conflict'})
 await assert.rejects(service.acknowledge('other',input),{code:'teloa/forbidden'})

 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,allowed_tools,role_skills,role_knowledge,tool_argument_rules,plan_context_hash)
  values($1,$2,$3,'{}',$4,$5,1,1,1,'session',$6,'withdrawn','fixed',$7,'[]','[]','[]',null,null)`,[randomUUID(),owner,first.occurrence.id,first.task.id,first.occurrence.fields.roleId,randomUUID(),new Date('2026-09-12T01:30:00.000Z')])
 await assert.rejects(service.acknowledge(owner,input),{code:'teloa/conflict'})
 await pool.query('delete from teloa_task_runs where request_id=$1',[first.occurrence.id])
 await pool.query('alter table teloa_tasks drop constraint teloa_tasks_state_check')
 try{
  await pool.query("update teloa_tasks set state='unknown' where id=$1",[first.task.id])
  await assert.rejects(service.acknowledge(owner,input),{code:'teloa/storage-corrupt'})
 }finally{
  await pool.query("update teloa_tasks set state='cancelled' where id=$1",[first.task.id])
  await pool.query("alter table teloa_tasks add constraint teloa_tasks_state_check check(state in ('ready','running','paused','waiting','blocked','completed','cancelled'))")
 }
 await pool.query('update teloa_plan_task_links set task_request_id=$2 where claim_id=$1',[first.occurrence.id,randomUUID()])
 await assert.rejects(service.acknowledge(owner,input),{code:'teloa/storage-corrupt'})
})

test('状态与确认记录损坏时查询显式失败',async()=>{
 const owner=randomUUID(),service=new PlanSchedulerStatusService(pool,{now:()=> '2026-09-12T02:00:00.000Z'})
 await service.record(owner,{outcome:'success'})
 try{
  await pool.query("update teloa_plan_scheduler_status set last_attempt_at='infinity',last_success_at='infinity' where owner_id=$1",[owner])
  await assert.rejects(service.get(owner,{}),{code:'teloa/storage-corrupt'})
 }finally{
  await pool.query("update teloa_plan_scheduler_status set last_attempt_at='2026-09-12T02:00:00Z',last_success_at='2026-09-12T02:00:00Z' where owner_id=$1",[owner])
 }
 const {occurrence,task}=await claimedTask(owner);await pool.query("update teloa_tasks set state='completed' where id=$1",[task.id])
 await service.acknowledge(owner,{claimId:occurrence.id,taskId:task.id,reason:'task-ended'})
 await pool.query("alter table teloa_plan_scheduler_acks drop constraint teloa_plan_scheduler_acks_reason_check")
 try{
  await pool.query("update teloa_plan_scheduler_acks set reason='unknown' where claim_id=$1",[occurrence.id])
  await assert.rejects(service.acknowledgement(owner,{claimId:occurrence.id}),{code:'teloa/storage-corrupt'})
 }finally{
  await pool.query("update teloa_plan_scheduler_acks set reason='task-ended' where claim_id=$1",[occurrence.id])
  await pool.query("alter table teloa_plan_scheduler_acks add constraint teloa_plan_scheduler_acks_reason_check check(reason='task-ended')")
 }
})
