import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {setupRoleWork,roleFixture,insertRoleRun,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {WorkControlService,initializeWorkControl} from '../src/work/work-control.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {WorkBudgetService,initializeWorkBudgets,defaultWorkBudgetPolicy} from '../src/work/work-budget.ts'
import {TaskRunGoalService,initializeTaskRunGoals} from '../src/work/task-run-goals.ts'
import {createRunRoleSnapshot} from '../src/work/run-role-snapshot.ts'
import {WorkRecoveryService,initializeWorkRecovery} from '../src/work/work-recovery.ts'

test('有限重试持久保留attempt/nextAt；未知与本人等待不自动重试，回执重放不双计',{timeout:15000},async()=>{
 const f=await setupRoleWork()
 try{
  const api=await loadRoleWorkModule('work-retries');assert.equal(typeof api.WorkRetryService,'function','必须有持久有限重试服务')
  await initializeWorkControl(f.pool);await initializeWorkBudgets(f.pool);await api.initializeWorkRetries(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),runId=await insertRoleRun(f.pool,owner,role.id,taskId),db=await f.pool.connect();let lineage
  try{await db.query('begin');lineage=await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query('update teloa_work_budget_accounts set policy=$3 where owner_id=$1 and id=$2',[owner,lineage.budgetAccountId,JSON.stringify({...defaultWorkBudgetPolicy,maxRetries:1})])
  let now=Date.now();const clock={...identity,now:()=>new Date(now).toISOString()},controls=new WorkControlService(f.pool,clock),budget=new WorkBudgetService(f.pool,clock)
  const ports={controls,authorizeAttempt:async(db:any,owner:string,input:any)=>{const r=await budget.reserveInTransaction(db,owner,{budgetAccountId:lineage.budgetAccountId,controlGeneration:input.controlGeneration,modelRequestId:input.modelRequestId,kind:'retry',tokens:1,rounds:0});return budget.lease(owner,r)}}
  let service=new api.WorkRetryService(f.pool,clock,ports);const operationId='stable-model-operation'
  const ready=await service.register(owner,{runId,operationId});assert.equal(ready.maxAttempts,2)
  const first=await service.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1});assert.equal(first.dispatch,true);assert.equal(first.retry.attempts,1)
  const failure={operationId,attempt:1,receiptId:'failure:1',outcome:'transient',reason:'临时上游故障'},backoff=await service.record(owner,failure)
  assert.equal(backoff.state,'backoff');assert.ok(Date.parse(backoff.nextAttemptAt)>now);assert.deepEqual(await service.record(owner,failure),backoff)
  service=new api.WorkRetryService(f.pool,clock,ports);assert.deepEqual(await service.read(owner,{operationId}),backoff)
  await assert.rejects(service.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1}),{code:'teloa/conflict'})
  now=Date.parse(backoff.nextAttemptAt)+1
  const second=await service.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1});assert.equal(second.retry.attempts,2)
  const exhausted=await service.record(owner,{operationId,attempt:2,receiptId:'failure:2',outcome:'transient',reason:'再次临时故障'});assert.equal(exhausted.state,'exhausted')
  await assert.rejects(service.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1}),{code:'teloa/conflict'})
  for(const [suffix,outcome,state] of [['auth','permission','owner-wait'],['external','unknown','unknown']]){
   const operationId='operation:'+suffix;await service.register(owner,{runId,operationId});const claimed=await service.claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1})
   assert.equal((await service.record(owner,{operationId,attempt:claimed.attempt,receiptId:'receipt:'+suffix,outcome,reason:'等待核对'})).state,state)
   now+=3600_000;await assert.rejects(new api.WorkRetryService(f.pool,clock,ports).claim(owner,{operationId,requestId:randomUUID(),expectedGeneration:1}),{code:outcome==='unknown'?'teloa/execution-pending':'teloa/conflict'})
  }
 }finally{await f.close()}
})

test('真实已受理 Goal 轮的停滞计数持久幂等；同资料版本换seq不算进展',{timeout:15000},async()=>{
 const f=await setupRoleWork()
 try{
  const api=await loadRoleWorkModule('work-retries')
  await initializeWorkControl(f.pool);await initializeWorkBudgets(f.pool);await initializeTaskRunGoals(f.pool);await api.initializeWorkRetries(f.pool)
  const {owner,role,taskId,authorization}=await roleFixture(f.pool,'employee'),runId=await insertRoleRun(f.pool,owner,role.id,taskId),db=await f.pool.connect();let lineage
  try{await db.query('begin');lineage=await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query('update teloa_work_budget_accounts set policy=$3 where owner_id=$1 and id=$2',[owner,lineage.budgetAccountId,JSON.stringify({...defaultWorkBudgetPolicy,stagnationRounds:2})])
  await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[runId,JSON.stringify({schema:'teloa.task-run-input/v2',task:{id:taskId,version:1,scope:'general',title:'版本小结',goal:'核对材料'},role:createRunRoleSnapshot(role,authorization),lineage})])
  const goal={goalId:'persistent-progress',revision:1,phase:'active' as const,activation:'armed' as const,roundsStarted:0,maxGoalRounds:5}
  const controls=new WorkControlService(f.pool,identity,{ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async()=>({settled:true,unknownOperationIds:[]})}),goals=new TaskRunGoalService(f.pool,identity,{hostGeneration:()=>1,inspectGoal:async()=>goal,admitRound:async()=>({assertCurrent(){}})})
  const binding=await goals.bind(owner,{runId,goalId:goal.goalId,revision:1,hostGeneration:1})
  let completed=false;const ports={controls,inspectProgressRound:async(_owner:string,input:any)=>({completed,evidence:input.round===3?[]:[{runId,seq:10*input.round,kind:'artifact',referenceId:'resource:owner-version:sha256-1'}]})}
  let service=new api.WorkRetryService(f.pool,identity,ports)
  assert.equal(typeof service.readStagnation,'function','需要从持久进展读取续轮判断')
  assert.equal((await service.readStagnation(owner,{runId,goalId:goal.goalId})).lastRound,0)
  for(let round=1;round<=3;round++){
   goal.roundsStarted=round-1
   await goals.reserve(owner,{binding,round,messageId:'progress:'+round,nativeRequestId:'progress-native:'+round,payloadSha256:'a'.repeat(64)})
   await goals.confirm(owner,{nativeRequestId:'progress-native:'+round,acceptedSeq:round*5})
   const input={runId,goalId:goal.goalId,revision:1,round}
   if(round===1){await assert.rejects(service.recordProgressRound(owner,input),{code:'teloa/execution-pending'});completed=true}
   const state=await service.recordProgressRound(owner,input)
   assert.equal(state.roundsWithoutProgress,round-1);assert.equal(state.shouldWait,round===3)
   assert.deepEqual(await service.recordProgressRound(owner,input),state)
  }
  service=new api.WorkRetryService(f.pool,identity,ports)
  const persisted=await service.readStagnation(owner,{runId,goalId:goal.goalId});assert.equal(persisted.roundsWithoutProgress,2);assert.equal(persisted.shouldWait,true);assert.equal(persisted.evidence.length,1)
  await assert.rejects(service.readStagnation(randomUUID(),{runId,goalId:goal.goalId}),{code:'teloa/forbidden'})
  assert.equal(typeof service.acknowledgeStagnation,'function','只有真实本人恢复票据能放行停滞后的一轮')
  await initializeWorkRecovery(f.pool)
  await assert.rejects(service.acknowledgeStagnation(owner,{requestId:randomUUID(),runId,goalId:goal.goalId,controlGeneration:1}),{code:'teloa/forbidden'})
  const c=await controls.get(owner,{controlId:lineage.roundControlId}),pausing=await controls.change(owner,{requestId:randomUUID(),controlId:c.id,expectedVersion:c.version,action:'pause',scope:'round',roundControlId:null}),paused=await controls.reconcile(owner,{controlId:c.id,generation:pausing.generation})
  const recovery=new WorkRecoveryService(f.pool,identity,controls,{hostGeneration:()=>1,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectCheckpoint:async()=>({reason:'accepted',checkpointSha256:'b'.repeat(64),hasPendingInput:true,unknownOperationIds:[]}),authorizeResume:async()=>({assertCurrent(){}})})
  const request={requestId:randomUUID(),controlId:c.id,expectedVersion:paused.version,candidateRunIds:[runId]},active=await recovery.resume(owner,request)
  await recovery.begin(owner,{requestId:request.requestId,runId})
  const acknowledgement={requestId:request.requestId,runId,goalId:goal.goalId,controlGeneration:active.generation}
  await service.acknowledgeStagnation(owner,acknowledgement);await service.acknowledgeStagnation(owner,acknowledgement)
  const allowance={runId,goalId:goal.goalId,controlGeneration:active.generation,round:4}
  assert.equal(await service.consumeStagnationAllowance(owner,allowance),true);assert.equal(await new api.WorkRetryService(f.pool,identity,ports).consumeStagnationAllowance(owner,allowance),true)
  assert.equal(await service.consumeStagnationAllowance(owner,{...allowance,round:5}),false)
  assert.equal((await service.readStagnation(owner,{runId,goalId:goal.goalId})).roundsWithoutProgress,2,'本人确认不清除预算或无进展事实')
 }finally{await f.close()}
})
