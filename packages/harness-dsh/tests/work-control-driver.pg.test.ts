import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {WorkError,taskInput} from '@teloa/contract'
import {setupRoleWork,roleFixture,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {initializeWorkControl,WorkControlService} from '../../backend/src/work/work-control.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {WorkControlDriver} from '../src/work-control-driver.ts'
import {initializeTeloaDatabase,TaskRunRuntimeLinkService,WorkBudgetService,WorkRecoveryService,type TaskRun} from '@teloa/backend'
import {taskRunQuiescentSettlement} from '../src/task-run-quiescence.ts'
import {quiescenceFixture} from './fixtures/task-run-quiescence.ts'

test('真实PG：宿主重启暂停只剩无会话、无 link 的 configuration_failed Run 时，不读执行日志即由 pausing 收口为 paused',{timeout:60000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 await initializeWorkControl(f.pool)
 const {owner,role,taskId}=await roleFixture(f.pool,'employee'),lineage=new WorkLineageService(f.pool,identity),db=await f.pool.connect()
 let source
 try{await db.query('begin');source=await lineage.bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 const runId=randomUUID(),sessionId='task-run-'+randomUUID()
 await f.pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,evidence,configuration_error)
 values($1,$2,$3,'{}',$4,$5,1,1,0,$6,$7,'configuration_failed','{}',now(),null,$8)`,[runId,owner,randomUUID(),taskId,role.id,sessionId,randomUUID(),JSON.stringify({code:'teloa/invalid-input',stage:'session-create',message:'创建需要有效的请求 ID 与工作标题。'})])
 let host=1,events=0,driver:WorkControlDriver|undefined
 const service=new WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:async(value,input)=>driver!.inspectRun(value,input)})
 driver=new WorkControlDriver({controls:service,runs:{get:async()=>({id:runId,state:'configuration_failed',sessionId})},lineage,driver:{stop:async()=>{throw Error('配置失败 Run 不应走业务停止')}},ports:{stop:async()=>{throw Error('配置失败 Run 不应走原生停止')},goalObservation:async()=>null,events:async()=>{events++;throw new WorkError('teloa/forbidden','执行会话身份未就绪。')}},runtimeLinks:{list:async()=>[]}} as never)
 host=2;const [restart]=await service.disarmForRestart(owner,{hostGeneration:2})
 assert.equal(restart?.id,source.roundControlId);assert.equal(restart.state,'pausing');assert.deepEqual(restart.pendingRunIds,[runId])
 const settled=await driver.apply(owner,restart,new AbortController().signal)
 assert.equal(settled.state,'paused');assert.equal(events,0)
 assert.equal((await service.get(owner,{controlId:restart.id})).state,'paused')
})

test('真实PG：同Task的ended→已处置unknown可冷收口暂停；本人空候选恢复不重发旧unknown，F1完成后下次重启仍可暂停',{timeout:60000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close());await initializeTeloaDatabase(f.pool)
 const cold=await quiescenceFixture(t),{owner,role,taskId}=await roleFixture(f.pool,'employee'),lineage=new WorkLineageService(f.pool,identity),db=await f.pool.connect()
 let source
 try{await db.query('begin');source=await lineage.bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
 const values=new Map<string,TaskRun>(),links=new TaskRunRuntimeLinkService(f.pool)
 const save=async(value:TaskRun)=>{
  const run={...value,taskId,roleId:role.id,roleVersion:role.version};values.set(run.id,run)
  await f.pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,evidence,stop_requested_at,submission_disposition)
   values($1,$2,$3,'{}',$4,$5,$6,$7,1,$8,$9,'submitting',$10,$11,null,null,null)`,[run.id,owner,randomUUID(),taskId,role.id,run.taskVersion,run.roleVersion,run.sessionId,run.nativeRequestId,run.inputText,run.createdAt])
  const runtimeId=run.submissionDisposition?.runtimeId??randomUUID()
  await links.put(owner,{runId:run.id,kind:'job',nativeId:`owner:${runtimeId}:${run.sessionId}`,sessionId:run.sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
  await f.pool.query('update teloa_task_runs set state=$2,evidence=$3,stop_requested_at=$4,submission_disposition=$5 where id=$1',[run.id,run.state,run.evidence?JSON.stringify(run.evidence):null,run.stopRequestedAt,run.submissionDisposition?JSON.stringify(run.submissionDisposition):null])
  return run
 }
 const a1=await save(cold.a1),unknown=await save(cold.unknown),budgets=new WorkBudgetService(f.pool,identity)
 const reservation=await budgets.reserve(owner,{budgetAccountId:source.budgetAccountId,controlGeneration:1,modelRequestId:unknown.nativeRequestId,kind:'retry',tokens:100,rounds:0});await budgets.markDispatched(owner,{reservationId:reservation.id})
 const frozen=async()=>({runs:(await f.pool.query('select * from teloa_task_runs where owner_id=$1 and id=any($2::uuid[]) order by id',[owner,[a1.id,unknown.id]])).rows,links:(await f.pool.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=any($2::uuid[]) order by run_id',[owner,[a1.id,unknown.id]])).rows,budget:(await f.pool.query('select * from teloa_work_budget_reservations where owner_id=$1',[owner])).rows})
 const before=await frozen();let host=1,driver:WorkControlDriver|undefined,warm=0,readerCalls=0
 const reader={pool:f.pool,readRun:async(_db:Parameters<import('@teloa/backend').TaskRunService['readVerifiedInTransaction']>[0],actor:string,id:string)=>{assert.equal(actor,owner);readerCalls++;return values.get(id)!}}
 const controls=new WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},inspectRun:(actor,input)=>driver!.inspectRun(actor,input)})
 driver=new WorkControlDriver({controls,runs:{get:async(_actor,input)=>{const value=taskInput(input,['runId']);assert.ok(typeof value.runId==='string');return values.get(value.runId)!}},lineage,driver:{stop:async()=>{throw Error('不重发/停止旧业务请求')}},ports:{stop:async()=>{warm++;throw Error('不materialize旧Agent')},goalObservation:async()=>{warm++;throw Error('不materialize旧Goal')},events:async()=>[]},runtimeLinks:links,terminalSettled:async()=>false,quiescentSettled:(actor,run)=>taskRunQuiescentSettlement(cold.ctx,actor,run,reader,AbortSignal.timeout(5000))})
 host=2;const [restart]=await controls.disarmForRestart(owner,{hostGeneration:host});assert.equal(restart!.state,'pausing')
 const paused=await driver.apply(owner,restart!,AbortSignal.timeout(10000));assert.equal(paused.state,'paused');assert.deepEqual(paused.pendingRunIds,[]);assert.equal(warm,0);assert.ok(readerCalls>0)
 const recovery=new WorkRecoveryService(f.pool,identity,controls,{hostGeneration:()=>host,ownerAuthority:{authorize:async()=>({assertCurrent(){}})},authorizeResume:async()=>{throw Error('空候选不能取得旧Run恢复许可')}})
 assert.deepEqual(await recovery.inspect(owner,{controlId:paused.id}),[])
 const requestId=randomUUID(),active=await recovery.resume(owner,{requestId,controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[]});assert.equal(active.state,'active')
 assert.deepEqual((await f.pool.query('select spec from teloa_work_recovery_requests where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0].spec.candidateRunIds,[])
 assert.equal((await f.pool.query('select 1 from teloa_work_recovery_tickets where owner_id=$1',[owner])).rowCount,0)
 assert.deepEqual(await frozen(),before)
 await save(await cold.appendF1())
 const nextId=randomUUID(),nextNative=randomUUID();await save({...unknown,id:nextId,taskVersion:4,nativeRequestId:nextNative,submissionDisposition:{...unknown.submissionDisposition!,runId:nextId,nativeRequestId:nextNative,requestId:randomUUID(),runtimeId:randomUUID(),logCut:cold.events.length-1,logSha256:createHash('sha256').update(JSON.stringify(cold.events)).digest('hex')}})
 host=3;const [next]=await controls.disarmForRestart(owner,{hostGeneration:host})
 assert.equal((await driver.apply(owner,next!,AbortSignal.timeout(10000))).state,'paused');assert.equal(warm,0);assert.deepEqual(await frozen(),before)
})
