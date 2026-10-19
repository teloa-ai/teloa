import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {WorkError} from '@teloa/contract'
import {setupRoleWork,roleFixture,insertRoleRun,identity,ownerAuthority,delegationFields} from '../../backend/tests/role-work-test-fixture.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'
import {initializeWorkControl,WorkControlService} from '../../backend/src/work/work-control.ts'
import {initializeWorkRecovery,WorkRecoveryService} from '../../backend/src/work/work-recovery.ts'
import {WorkLineageService} from '../../backend/src/work/work-lineage.ts'
import {RoleService} from '../../backend/src/work/roles.ts'
import {RoleDelegationService} from '../../backend/src/work/role-delegations.ts'
import {TwinExecutionConsentService} from '../../backend/src/work/twin-execution-consents.ts'
import {RoleWorkEligibilityService} from '../../backend/src/work/role-work-eligibility.ts'
import {createRunRoleSnapshot} from '../../backend/src/work/run-role-snapshot.ts'
import {PlanService} from '../../backend/src/work/plans.ts'
import {initializePlanOccurrences,PlanOccurrenceService} from '../../backend/src/work/plan-occurrences.ts'
import {WorkRecoveryCoordinator} from '../src/work-recovery-coordinator.ts'
import {plannedRestartResume} from '../src/planned-restart-resume.ts'

test('真实PG：计划升级重启只恢复无候选或全部安全恢复的控制，经真实 coordinator 续上票据；本人暂停、未知、未开启安全恢复、所属本轮被本人暂停与检查后变化都保持暂停',{timeout:120000},async t=>{
 const f=await setupRoleWork();t.after(()=>f.close())
 await initializeWorkControl(f.pool);await initializeWorkRecovery(f.pool);await initializePlanOccurrences(f.pool)
 const {owner,role:twin}=await roleFixture(f.pool),lineage=new WorkLineageService(f.pool,identity)
 const employee=await new RoleService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'研究同事',kind:'employee',scopes:['general','research'],duty:'查证',dataScope:'授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 // 分身的长期委托开启安全恢复，并有本人回执：其候选 safeRecovery=true。员工按任务授权：可恢复但未开启安全恢复。
 const saved=await new RoleDelegationService(f.pool,identity,ownerAuthority).change(owner,{requestId:randomUUID(),roleId:twin.id,expectedRoleVersion:twin.version,expectedVersion:null,action:'save',fields:{...delegationFields,safeRecovery:true}})
 const delegation={kind:'delegation' as const,delegationId:saved.id,delegationVersion:saved.version}
 await new TwinExecutionConsentService(f.pool,identity,ownerAuthority).confirm(owner,{requestId:randomUUID(),roleId:twin.id,expectedRoleVersion:twin.version,authorization:delegation})
 const twinSnapshot=(await new RoleWorkEligibilityService(f.pool).authorize(owner,{roleId:twin.id,expectedRoleVersion:twin.version,scope:'general',inputSchema:'teloa.task-run-input/v2',authorization:delegation,groupId:null})).snapshot
 const task=async(roleId:string,roleVersion:number,requestId:string=randomUUID())=>{const id=randomUUID();await f.pool.query(`insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,content_version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,'{}',$4,1,1,'ready',$5,$6,now(),now())`,[id,owner,requestId,JSON.stringify({title:'版本小结',goal:'核对材料',scope:'general',groupId:null,skills:[]}),roleId,roleVersion]);return id}
 const bind=async(taskId:string,source:any={kind:'owner-task',taskId})=>{const db=await f.pool.connect();try{await db.query('begin');const value=await lineage.bindTask(db,owner,{taskId,source});await db.query('commit');return value}finally{db.release()}}
 const run=async(roleId:string,taskId:string,input:unknown)=>{const id=await insertRoleRun(f.pool,owner,roleId,taskId,'accepted');await f.pool.query('update teloa_task_runs set input_text=$2 where id=$1',[id,JSON.stringify(input)]);return id}
 const twinInput={schema:'teloa.task-run-input/v2',role:twinSnapshot}

 const idle=(await bind(await task(twin.id,twin.version))).roundControlId
 const ownerPaused=(await bind(await task(twin.id,twin.version))).roundControlId
 const unknownTask=await task(twin.id,twin.version),unknown=(await bind(unknownTask)).roundControlId,unknownRun=await run(twin.id,unknownTask,twinInput)
 const unsafeTask=await task(employee.id,employee.version),unsafe=(await bind(unsafeTask)).roundControlId
 const unsafeRun=await run(employee.id,unsafeTask,{schema:'teloa.task-run-input/v2',role:createRunRoleSnapshot(employee,{kind:'task',taskId:unsafeTask,taskContentVersion:1})})
 const safeTask=await task(twin.id,twin.version),safe=(await bind(safeTask)).roundControlId,safeRun=await run(twin.id,safeTask,twinInput)
 const raceTask=await task(twin.id,twin.version),race=(await bind(raceTask)).roundControlId
 // 真实计划定义：本人在升级前暂停了其中一轮，该轮有可安全恢复的候选。
 const planner=await new RoleService(f.pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'已授权资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 await f.pool.query("update teloa_roles set state='active' where id=$1",[planner.id])
 const plans=new PlanService(f.pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日核对',goal:'核对资料',scope:'general',dataScope:'本人资料',delivery:'核对结果',roleId:planner.id,expectedRoleVersion:planner.version,notificationPolicy:'attention',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}},source:{kind:'manual'}})
 const plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const occurrence=(await new PlanOccurrenceService(f.pool,identity).trigger(owner,{planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:'2026-10-09T01:00:00.000Z'})).occurrence!
 const planTask=await task(twin.id,twin.version,occurrence.taskRequestId),planLineage=await bind(planTask,{kind:'plan-occurrence',claimId:occurrence.id}),definition=planLineage.definitionControlId!,planRun=await run(twin.id,planTask,twinInput)

 let host=1
 const checkpoints=new Map<string,string>([[unknownRun,'unknown']])
 const controls=new WorkControlService(f.pool,identity,{hostGeneration:()=>host,ownerAuthority,inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const recovery=new WorkRecoveryService(f.pool,identity,controls,{hostGeneration:()=>host,ownerAuthority,authorizeResume:async()=>({assertCurrent(){}}),
  inspectCheckpoint:async(_owner,input)=>checkpoints.get(input.runId)==='unknown'?{reason:'unknown',checkpointSha256:'c'.repeat(64),hasPendingInput:false,unknownOperationIds:['browser:dirty']}:{reason:'accepted',checkpointSha256:'a'.repeat(64),hasPendingInput:true,unknownOperationIds:[]}})
 let failBegin=1;const restored:string[]=[]
 const coordinator=new WorkRecoveryCoordinator({service:{resume:recovery.resume.bind(recovery),record:recovery.record.bind(recovery),begin:async(value,input)=>{if(input.runId===safeRun&&failBegin>0){failBegin--;throw new WorkError('teloa/unavailable','宿主会话尚未就绪。')}return recovery.begin(value,input)}},
  runs:{get:async(_owner:string,input:{runId:string})=>{const row=(await f.pool.query('select state,session_id from teloa_task_runs where id=$1',[input.runId])).rows[0];return {state:row.state,sessionId:row.session_id} as never}},
  startUnaccepted:async()=>{throw Error('不应派发未受理候选')},restoreAccepted:async(_owner,input)=>{restored.push(input.runId)}})
 const pauseOwner=async(controlId:string,definitionId?:string)=>{const current=await controls.get(owner,{controlId});const paused=await controls.change(owner,{requestId:randomUUID(),controlId:definitionId??controlId,expectedVersion:current.version,action:'pause',scope:'round',roundControlId:definitionId?controlId:null});await controls.reconcile(owner,{controlId,generation:paused.generation})}
 await pauseOwner(ownerPaused);await pauseOwner(planLineage.roundControlId,definition)

 const restartId=randomUUID(),reports:string[]=[]
 host=2;const restarted=await controls.disarmForRestart(owner,{hostGeneration:2})
 assert.deepEqual(restarted.map(c=>c.id).sort(),[idle,unknown,unsafe,safe,race,definition].sort(),'本人暂停的本轮与定义下的本轮都不在撤防结果里')
 assert.equal(await controls.claimPlannedRestart(owner,{restartId,hostGeneration:2,controlIds:restarted.map(c=>c.id)}),true)
 assert.equal(await controls.claimPlannedRestart(owner,{restartId,hostGeneration:2,controlIds:[]}),false,'同一回执只能认领一次')
 const raceGeneration=restarted.find(c=>c.id===race)!.generation
 const drain=plannedRestartResume(owner,restartId,restarted.filter(c=>c.id!==race),{controls,inspect:(value,input)=>recovery.inspect(value,input),resume:(value,input,signal,planned)=>coordinator.resume(value,input,signal,planned),report:code=>reports.push(code)})
 await drain(new AbortController().signal)
 assert.equal((await controls.get(owner,{controlId:idle})).state,'pausing','收口前只等待')
 for(const control of restarted)await controls.reconcile(owner,{controlId:control.id,generation:control.generation})
 await drain(new AbortController().signal)
 assert.equal((await controls.get(owner,{controlId:safe})).state,'active','恢复已提交');assert.deepEqual(restored,[],'派发阶段宿主未就绪')
 await drain(new AbortController().signal)
 assert.deepEqual(restored,[safeRun],'同一请求续上 reserved 票据')
 assert.equal((await f.pool.query("select count(*)::int as n from teloa_work_recovery_tickets where run_id=$1 and state='applied'",[safeRun])).rows[0].n,1)
 await drain(new AbortController().signal);assert.deepEqual(restored,[safeRun],'不重复派发')

 const state=async(id:string)=>(await f.pool.query('select state,pause_origin from teloa_work_controls where id=$1',[id])).rows[0]
 assert.deepEqual(await state(idle),{state:'active',pause_origin:null})
 assert.deepEqual(await state(ownerPaused),{state:'paused',pause_origin:'owner'})
 assert.deepEqual(await state(unknown),{state:'paused',pause_origin:'restart'})
 assert.deepEqual(await state(unsafe),{state:'paused',pause_origin:'restart'})
 assert.deepEqual(await state(definition),{state:'paused',pause_origin:'restart'})
 assert.deepEqual(await state(planLineage.roundControlId),{state:'paused',pause_origin:'owner'},'定义级恢复不撤销本人对单轮的暂停')
 const inspected=await recovery.inspect(owner,{controlId:unsafe});assert.deepEqual(inspected.map(c=>[c.runId,c.resumable,c.safeRecovery]),[[unsafeRun,true,false]])
 assert.deepEqual((await recovery.inspect(owner,{controlId:definition})).map(c=>[c.runId,c.safeRecovery]),[[planRun,true]])
 for(const id of [unknown,unsafe])assert.ok(reports.some(code=>code==='teloa/planned-restart-held:'+id+':candidates'),id)
 assert.ok(reports.includes('teloa/planned-restart-held:'+definition+':teloa/conflict'))
 assert.ok(reports.includes('teloa/planned-restart-retry:'+safe+':teloa/unavailable'))
 const results=(await f.pool.query('select results from teloa_work_control_planned_restarts where owner_id=$1 and restart_id=$2',[owner,restartId])).rows[0].results
 assert.deepEqual(results,{[idle]:'resumed',[safe]:'resumed',[unknown]:'held:candidates',[unsafe]:'held:candidates',[definition]:'held:teloa/conflict',[race]:'pending'})

 // 检查与使用之间本人先恢复再暂停：世代已变，恢复事务按撤防世代复核后拒绝。
 const racePaused=await controls.get(owner,{controlId:race})
 await recovery.resume(owner,{requestId:randomUUID(),controlId:race,expectedVersion:racePaused.version,candidateRunIds:[]});await pauseOwner(race)
 const now=await controls.get(owner,{controlId:race})
 await assert.rejects(recovery.resume(owner,{requestId:randomUUID(),controlId:race,expectedVersion:now.version,candidateRunIds:[]},{generation:raceGeneration}),{code:'teloa/conflict'})
 assert.deepEqual(await state(race),{state:'paused',pause_origin:'owner'})

 // 回执不能被之后的重启沿用；上一代认领后未做完的项标为 abandoned，供日志提示手动恢复。
 host=3;const again=await controls.disarmForRestart(owner,{hostGeneration:3})
 assert.deepEqual(again.map(c=>c.id).sort(),[idle,safe].sort())
 assert.equal(await controls.claimPlannedRestart(owner,{restartId,hostGeneration:3,controlIds:[]}),false)
 assert.deepEqual(await controls.abandonPlannedRestarts(owner,{hostGeneration:3}),[race])
 assert.equal((await f.pool.query('select results->>$3 as v from teloa_work_control_planned_restarts where owner_id=$1 and restart_id=$2',[owner,restartId,race])).rows[0].v,'abandoned')
 assert.deepEqual(await controls.abandonPlannedRestarts(owner,{hostGeneration:3}),[])
 await assert.rejects(controls.claimPlannedRestart(owner,{restartId:randomUUID(),hostGeneration:2,controlIds:[]}),{code:'teloa/forbidden'})
})
