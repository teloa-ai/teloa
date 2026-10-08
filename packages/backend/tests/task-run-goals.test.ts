import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,insertRoleRun,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {createRunRoleSnapshot} from '../src/work/run-role-snapshot.ts'

test('Goal 后端绑定真实 Run、唯一续轮与 revision 沿革，未知结果不能重发',async()=>{
 const f=await setupRoleWork()
 try{
  const api=await loadRoleWorkModule('task-run-goals')
  assert.equal(typeof api.TaskRunGoalService,'function','必须存在持久 Goal 准入服务')
  await api.initializeTaskRunGoals(f.pool)
  const {owner,role,taskId,authorization}=await roleFixture(f.pool,'employee'),runId=await insertRoleRun(f.pool,owner,role.id,taskId)
  // 一键运行沿真实 Harness 入口固定带前缀的 SessionId，不能把它当成业务 UUID。
  const sessionId='task-run-'+randomUUID()
  await f.pool.query('update teloa_task_runs set session_id=$2 where id=$1',[runId,sessionId])
  const db=await f.pool.connect();let lineage
  try{await db.query('begin');lineage=await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[runId,JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:taskId,version:1,scope:'general',title:'版本小结',goal:'核对材料'},role:createRunRoleSnapshot(role,authorization),lineage})])
  let goal={goalId:'goal-id',revision:1,phase:'active',activation:'armed',roundsStarted:0,maxGoalRounds:3}
  const service=new api.TaskRunGoalService(f.pool,identity,{hostGeneration:()=>1,inspectGoal:async()=>goal,admitRound:async()=>({assertCurrent(){}})})
  const nativeRequestId=(await f.pool.query('select native_request_id from teloa_task_runs where id=$1',[runId])).rows[0].native_request_id
  assert.deepEqual(await service.findRun(owner,sessionId),{id:runId,sessionId,nativeRequestId})
  assert.deepEqual(await service.read(owner,{runId}),{binding:null,continuations:[]})
  assert.equal(await service.findRun(randomUUID(),sessionId),null)
  assert.equal(await service.findRun(owner,randomUUID()),null,'历史 UUID 会话形状仍可查询')
  await assert.rejects(service.findRun(owner,'task-run/invalid'),{code:'teloa/invalid-input'})
  const binding=await service.bind(owner,{runId,goalId:goal.goalId,revision:1,hostGeneration:1})
  assert.equal(binding.sessionId,sessionId)
  await assert.rejects(service.bind(randomUUID(),{runId,goalId:goal.goalId,revision:1,hostGeneration:1}),{code:'teloa/forbidden'})
  const request={binding,round:1,messageId:'message',nativeRequestId:'native-request',payloadSha256:'a'.repeat(64)}
  const reserved=await service.reserve(owner,request)
  assert.deepEqual(await service.reserve(owner,request),reserved)
  await assert.rejects(service.reserve(owner,{...request,messageId:'another'}),{code:'teloa/conflict'})
  await service.confirm(owner,{nativeRequestId:'native-request',acceptedSeq:5})
  goal={...goal,revision:2,phase:'complete'}
  await service.updateRef(owner,{runId,goalId:goal.goalId,previousRevision:1,revision:2})
  const read=await service.read(owner,{runId})
  assert.equal(read.binding.revision,2);assert.equal(read.continuations[0].revision,1);assert.equal(read.continuations[0].state,'accepted')
  await assert.rejects(service.acquire(owner,{binding,round:2}),{code:'teloa/version-conflict'})
 }finally{await f.close()}
})
