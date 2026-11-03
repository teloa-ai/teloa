import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {setupRoleWork,roleFixture,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {WorkBudgetService} from '../src/work/work-budget.ts'

for(const withReference of [false,true])test(`维护退出审计${withReference?'含内置参考MCP第三世代':'兼容原双世代'}与原Run未知处置原子提交，失败回滚、幂等且预算不变`,{timeout:30000},async()=>{
 const api=await loadRoleWorkModule('task-run-submission')
 assert.equal(typeof api.TaskRunSubmissionService.prototype.disposeUnknownAfterMaintenance,'function','缺少正式维护来源原子处置入口')
 const f=await setupRoleWork()
 try{
  await initializeTeloaDatabase(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),sessionId='maintenance-'+randomUUID(),conversationId=randomUUID()
  const db=await f.pool.connect();try{await db.query('begin');await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  const link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(f.pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=>'teloa-standard')
  const claimed=(await runs.claim(owner,{runId:prepared.id})).run,runtimeId=randomUUID(),links=new TaskRunRuntimeLinkService(f.pool)
  await links.put(owner,{runId:claimed.id,kind:'job',nativeId:'owner:'+runtimeId+':'+sessionId,sessionId,payload:{record:'owner',runtimeId,requestId:claimed.nativeRequestId}})
  const budget=new WorkBudgetService(f.pool,identity),reservation=await budget.reserveOwnerRouting(owner,{modelRequestId:'maintenance-'+claimed.nativeRequestId,tokens:256});await budget.markDispatched(owner,{reservationId:reservation.id})
  const beforeBudget=(await f.pool.query('select * from teloa_work_budget_reservations')).rows
  const run=await runs.requestStop(owner,{runId:claimed.id}),service=new api.TaskRunSubmissionService(f.pool),requestId=randomUUID()
  const input={requestId,runId:run.id,acknowledgeUnknown:true},fence={runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),runtimeId,logCut:0,logSha256:'a'.repeat(64),assertCurrent(){}}
  const audit={schema:'teloa.task-run-maintenance/v1',source:'maintenance-process-exit',installId:randomUUID(),requestId,runId:run.id,processReceipt:{schema:'teloa.maintenance-process-exit/v1',bindingSha256:'b'.repeat(64),supervisor:{pid:100,pidVersion:10,uniqueId:'1000',uid:501,children:[101]},child:{pid:101,pidVersion:11,uniqueId:'1001',uid:501,ppid:100,parentUniqueId:'1000',children:withReference?[102]:[]},...(withReference?{referenceMcp:{pid:102,pidVersion:12,uniqueId:'1002',uid:501,ppid:101,parentUniqueId:'1001',children:[]}}:{}),exited:withReference?[100,101,102]:[100,101],signal:'SIGTERM'},backupSha256:'c'.repeat(64),logFileSha256:'d'.repeat(64)}
  const before=(await f.pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows
  await assert.rejects(service.disposeUnknownAfterMaintenance(owner,input,runs,fence,{...audit,requestId:randomUUID()}))
  if(withReference){
   for(const change of [
    (proof:typeof audit.processReceipt)=>{proof.exited=[100,101]},
    (proof:typeof audit.processReceipt)=>{proof.referenceMcp!.ppid=100},
    (proof:typeof audit.processReceipt)=>{proof.referenceMcp!.parentUniqueId='different'},
    (proof:typeof audit.processReceipt)=>{proof.referenceMcp!.uid=502},
    (proof:typeof audit.processReceipt)=>{proof.child.children.push(103)},
   ]){const invalid=structuredClone(audit);change(invalid.processReceipt);await assert.rejects(service.disposeUnknownAfterMaintenance(owner,input,runs,fence,invalid))}
   assert.deepEqual((await f.pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows,before)
   assert.equal((await f.pool.query('select * from teloa_task_run_maintenance_dispositions')).rowCount,0)
  }
  await f.pool.query("create function maintenance_fail() returns trigger language plpgsql as $$ begin raise exception 'audit rejected'; end $$; create trigger maintenance_fail before insert on teloa_task_run_maintenance_dispositions for each row execute function maintenance_fail()")
  await assert.rejects(service.disposeUnknownAfterMaintenance(owner,input,runs,fence,audit),/audit rejected/)
  assert.deepEqual((await f.pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows,before)
  assert.equal((await f.pool.query('select * from teloa_task_run_maintenance_dispositions')).rowCount,0)
  await f.pool.query('drop trigger maintenance_fail on teloa_task_run_maintenance_dispositions')
  const result=await service.disposeUnknownAfterMaintenance(owner,input,runs,fence,audit)
  assert.equal(result.state,'submission_unknown');assert.equal(result.submissionDisposition.runtimeId,runtimeId)
  assert.equal((await f.pool.query('select state from teloa_tasks where id=$1',[taskId])).rows[0].state,'paused')
  assert.equal((await f.pool.query('select * from teloa_task_run_maintenance_dispositions')).rowCount,1)
  assert.deepEqual(await service.disposeUnknownAfterMaintenance(owner,input,runs,fence,audit),result)
  await assert.rejects(service.disposeUnknownAfterMaintenance(owner,input,runs,fence,{...audit,backupSha256:'e'.repeat(64)}))
  assert.deepEqual((await f.pool.query('select * from teloa_work_budget_reservations')).rows,beforeBudget)
  assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,false)
 }finally{await f.close()}
})
