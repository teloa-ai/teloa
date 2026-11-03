import {readFile} from 'node:fs/promises'
import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {Pool} from './postgres-test-lifecycle.ts'
import {identity} from './role-work-test-fixture.ts'
import {RoleService} from '../src/work/roles.ts'
import {TaskService} from '../src/work/tasks.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {roleWorkOutstanding} from '../src/work/role-delegations.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {TaskRunService,type TaskRun} from '../src/work/task-runs.ts'
import {TaskRunSubmissionService,readUnpublishedCancellationSettled} from '../src/work/task-run-submission.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {WorkControlService} from '../src/work/work-control.ts'
import {WorkControlDriver} from '../../harness-dsh/src/work-control-driver.ts'

test('确定未发布取消具有独立服务契约，不借未知处置承认未知',()=>{
 assert.equal(typeof Reflect.get(TaskRunSubmissionService.prototype,'unpublishedCancellationSettled'),'function')
 assert.equal(typeof Reflect.get(TaskRunSubmissionService.prototype,'cancelNotPublished'),'function')
 assert.equal(typeof Reflect.get(TaskRunSubmissionService.prototype,'cancelNotPublishedAfterMaintenance'),'function')
})

const url=process.env.TELOA_TEST_CANCEL_PG_URL
test('真实PG：确定未发布停止安全取消、幂等和拒绝竞争/后果',{skip:!url,timeout:30000},async()=>{
 const pool=new Pool({connectionString:url,max:4,statement_timeout:5000})
 try{
  await initializeTeloaDatabase(pool)
  const service=new TaskRunSubmissionService(pool)
  async function configuredRoleTask(){
   const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对同事',kind:'employee',scopes:['general'],duty:'核对材料',dataScope:'本轮合成资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
   const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'版本小结',goal:'核对材料',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
   return {owner,role,taskId:task.id}
  }
  async function outstanding(f:{owner:string;roleId:string;taskId:string},expected:boolean){
   const db=await pool.connect()
   try{
    await db.query('begin');await db.query('select id from teloa_tasks where owner_id=$1 and id=$2 for update',[f.owner,f.taskId])
    const tx=(await db.query('select txid_current()::text id')).rows[0].id
    assert.equal(await roleWorkOutstanding(db,f.owner,f.roleId,{taskId:f.taskId}),expected,'来源恢复只接受完整未发布取消证明')
    assert.equal((await db.query('select txid_current()::text id')).rows[0].id,tx,'共享predicate不能提交调用方事务')
    await db.query('commit')
   }catch(error){await db.query('rollback');throw error}finally{db.release()}
  }
  async function fixture(){
   const {owner,role,taskId}=await configuredRoleTask(),sessionId='cancel-'+randomUUID(),conversationId=randomUUID()
   const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
   const link=await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
   const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=>'teloa-standard')
   let run=(await runs.claim(owner,{runId:prepared.id})).run
   const runtimeId=randomUUID(),ticket=await service.begin(owner,run,runtimeId)
   await new TaskRunRuntimeLinkService(pool).put(owner,{runId:run.id,kind:'job',nativeId:'owner:'+runtimeId+':'+sessionId,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
   await service.finish(owner,ticket,'not-published')
   const second=await service.begin(owner,run,runtimeId);await service.finish(owner,second,'not-published')
   run=await runs.requestStop(owner,{runId:run.id})
   const command={requestId:run.id,runId:run.id,confirmNotPublished:true},fence={runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),runtimeId,notPublished:true as const,logCut:-1,logSha256:createHash('sha256').update('[]').digest('hex'),assertCurrent(){}}
   return {owner,run,runs,command,fence,ticket,second,taskId,roleId:role.id}
  }
  { // 正式prepared撤回兼容；没有投递票据也不能忽略后果。
   const {owner,role,taskId}=await configuredRoleTask(),sessionId='withdraw-'+randomUUID(),conversationId=randomUUID()
   const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
   const link=await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
   const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=>'teloa-standard'),withdrawn=await runs.withdraw(owner,{runId:prepared.id})
   assert.equal(await service.unpublishedCancellationSettled(owner,withdrawn),true)
   await outstanding({owner,roleId:role.id,taskId},false)
   await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'reserved',now())",[owner,withdrawn.id,'withdraw-child-'+randomUUID()])
   assert.equal(await service.unpublishedCancellationSettled(owner,withdrawn),false)
  }
  const f=await fixture()
  assert.equal(await service.recoverable(f.owner,f.run),false)
  assert.equal(await (service as any).publicationState(f.owner,f.run),'not-published','停止意图不得抹掉确定投递事实')
  const [a,b]=await Promise.all([(service as any).cancelNotPublished(f.owner,f.command,f.runs,f.fence),(service as any).cancelNotPublished(f.owner,f.command,f.runs,f.fence)])
  assert.equal(await service.unpublishedCancellationSettled(f.owner,a),true,'取消证明结清保留owner历史')
  await outstanding(f,false)
  const queryOnly=await pool.connect();try{assert.equal(await readUnpublishedCancellationSettled(queryOnly,randomUUID(),a),false,'其他本人不能消费同形快照');assert.equal(await readUnpublishedCancellationSettled(queryOnly,f.owner,{...a,sessionId:'foreign-session'}),false)}finally{queryOnly.release()}
  for(const mutation of ["update teloa_task_run_submissions set state='accepted' where owner_id=$1 and run_id=$2 and attempt=1","update teloa_task_run_submissions set settled_at=null where owner_id=$1 and run_id=$2 and attempt=1","update teloa_task_run_unpublished_cancellations set receipt=jsonb_set(receipt,'{attemptIds}','[]') where owner_id=$1 and run_id=$2"]){
   const db=await pool.connect();try{await db.query('begin');await db.query(mutation,[f.owner,f.run.id]);await db.query('commit');assert.equal(await service.unpublishedCancellationSettled(f.owner,a),false);await outstanding(f,true)}finally{db.release()}
   await pool.query("update teloa_task_run_submissions set state='not-published',settled_at=$3 where owner_id=$1 and run_id=$2 and attempt=1",[f.owner,f.run.id,new Date(Date.parse(f.run.stopRequestedAt!)-1)])
   await pool.query("update teloa_task_run_unpublished_cancellations set receipt=jsonb_set(receipt,'{attemptIds}',$3::jsonb) where owner_id=$1 and run_id=$2",[f.owner,f.run.id,JSON.stringify([f.ticket.attemptId,f.second.attemptId])])
  }
  assert.equal(await service.unpublishedCancellationSettled(f.owner,a),true)
  for(const effect of ['no-receipt','owner-settlement','child','budget','budget-without-owner'] as const){
   const c=await fixture(),cancelled=await service.cancelNotPublished(c.owner,c.command,c.runs,c.fence)
   if(effect==='no-receipt')await pool.query('delete from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2',[c.owner,c.run.id])
   if(effect==='owner-settlement')await pool.query("update teloa_task_run_runtime_links set owner_settlement='{}' where owner_id=$1 and run_id=$2",[c.owner,c.run.id])
   if(effect==='child')await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'reserved',now())",[c.owner,c.run.id,'proof-child-'+randomUUID()])
   if(effect==='budget'||effect==='budget-without-owner'){
    if(effect==='budget-without-owner')await pool.query('delete from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[c.owner,c.run.id])
    await pool.query("insert into teloa_work_budget_reservations(id,owner_id,budget_account_id,control_generation,model_request_id,kind,reserved_tokens,reserved_rounds,state,created_at) values($1,$2,$3,$4,$5,'retry',1,0,'unknown',now())",[randomUUID(),c.owner,c.run.lineage!.budgetAccountId,c.run.lineage!.controlGeneration,'proof-model-'+randomUUID()])
   }
   assert.equal(await service.unpublishedCancellationSettled(c.owner,cancelled),false,effect)
   if(effect!=='budget-without-owner')await outstanding(c,true)
  }
  let nativeReads=0,driver:WorkControlDriver
  const controls=new WorkControlService(pool,identity,{hostGeneration:()=>2,inspectRun:(owner,input)=>driver.inspectRun(owner,input)})
  driver=new WorkControlDriver({runs:f.runs,runtimeLinks:new TaskRunRuntimeLinkService(pool),unpublishedCancellationSettled:(owner:string,run:TaskRun)=>service.unpublishedCancellationSettled(owner,run),ports:{events:async()=>{nativeReads++;throw Error('不得恢复旧会话')}}} as never)
  const paused=await controls.disarmForRestart(f.owner,{hostGeneration:2})
  assert.ok(paused.length>0)
  for(const control of paused){const settled=await controls.reconcile(f.owner,{controlId:control.id,generation:control.generation});assert.equal(settled.state,'paused');assert.deepEqual(settled.pendingRunIds,[]);assert.deepEqual(settled.unknownOperationIds,[])}
  assert.equal(nativeReads,0)
  assert.equal(a.state,'withdrawn');assert.deepEqual(b,a);assert.equal(a.evidence,null);assert.equal(a.stopRequestedAt,f.run.stopRequestedAt);assert.equal(a.sessionId,f.run.sessionId)
  assert.equal((await pool.query('select count(*)::integer n from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2',[f.owner,f.run.id])).rows[0].n,1)
  assert.equal((await pool.query('select state from teloa_tasks where id=$1',[f.taskId])).rows[0].state,'paused')
  assert.deepEqual((await pool.query('select state from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt',[f.owner,f.run.id])).rows.map(r=>r.state),['not-published','not-published'])
  await assert.rejects((service as any).publicationState(f.owner,f.run),'取消后旧快照不可仍宣称可展示的submitting未发状态')
  await assert.rejects(service.finish(f.owner,f.second,'accepted'),'迟到回执不能覆盖取消')
  await assert.rejects(service.begin(f.owner,f.run,f.fence.runtimeId),'取消后不可再派发')
  await assert.rejects(f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}}))
  assert.deepEqual(await f.runs.outstanding(f.owner),[])
  for(const state of ['accepted','dispatching']){
   const c=await fixture();await pool.query('update teloa_task_run_submissions set state=$3 where owner_id=$1 and run_id=$2 and attempt=1',[c.owner,c.run.id,state])
   assert.equal(await service.publicationState(c.owner,c.run),'unknown','不能因latest未发掩盖旧accepted/dispatching')
   await assert.rejects((service as any).cancelNotPublished(c.owner,c.command,c.runs,c.fence),'任何旧accepted/dispatching都拒绝')
  }
  const changed=await fixture()
  await assert.rejects((service as any).cancelNotPublished(changed.owner,changed.command,changed.runs,{...changed.fence,inputSha256:'0'.repeat(64)}))
  let checked=0
  await assert.rejects((service as any).cancelNotPublished(changed.owner,changed.command,changed.runs,{...changed.fence,assertCurrent(){if(++checked>1)throw Error('fence changed')}}))
  assert.equal((await changed.runs.get(changed.owner,{runId:changed.run.id})).state,'submitting')
  for(const effect of ['child','external','budget','unsettled','false-proof','wrong-runtime','unstopped'] as const){
   const c=await fixture()
   if(effect==='child')await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'reserved',now())",[c.owner,c.run.id,'cancel-child-'+randomUUID()])
   if(effect==='external')await pool.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'browser',$3,$4,$5)",[c.owner,c.run.id,'browser-'+randomUUID(),c.run.sessionId,JSON.stringify({runtimeId:c.fence.runtimeId,requestId:c.run.nativeRequestId,status:'unknown'})])
   if(effect==='budget')await pool.query("insert into teloa_work_budget_reservations(id,owner_id,budget_account_id,control_generation,model_request_id,kind,reserved_tokens,reserved_rounds,state,created_at) values($1,$2,$3,$4,$5,'retry',1,0,'unknown',now())",[randomUUID(),c.owner,c.run.lineage!.budgetAccountId,c.run.lineage!.controlGeneration,'cancel-model-'+randomUUID()])
   if(effect==='unsettled')await pool.query('update teloa_task_run_submissions set settled_at=null where owner_id=$1 and run_id=$2 and attempt=1',[c.owner,c.run.id])
   if(effect==='unstopped')await pool.query('update teloa_task_runs set stop_requested_at=null where owner_id=$1 and id=$2',[c.owner,c.run.id])
   const fence=effect==='false-proof'?{...c.fence,notPublished:undefined}:effect==='wrong-runtime'?{...c.fence,runtimeId:randomUUID()}:c.fence
   await assert.rejects((service as any).cancelNotPublished(c.owner,c.command,c.runs,fence),effect)
   assert.equal((await c.runs.get(c.owner,{runId:c.run.id})).state,'submitting')
  }
  const maintained=await fixture(),pidVersion=1,supervisor={pid:101,pidVersion,uniqueId:'101'},child={pid:102,pidVersion,uniqueId:'102'}
  const audit={schema:'teloa.task-run-maintenance/v1',source:'maintenance-process-exit',installId:randomUUID(),requestId:maintained.command.requestId,runId:maintained.run.id,processReceipt:{schema:'teloa.maintenance-process-exit/v1',signal:'SIGTERM',supervisor,child,exited:[101,102],bindingSha256:'a'.repeat(64)},backupSha256:'b'.repeat(64),logFileSha256:'c'.repeat(64)}
  await assert.rejects((service as any).cancelNotPublishedAfterMaintenance(maintained.owner,maintained.command,maintained.runs,maintained.fence,{...audit,processReceipt:{...audit.processReceipt,exited:[101]}}))
  const cancelled=await (service as any).cancelNotPublishedAfterMaintenance(maintained.owner,maintained.command,maintained.runs,maintained.fence,audit)
  assert.equal(cancelled.state,'withdrawn')
  await outstanding(maintained,false)
  assert.deepEqual(await (service as any).cancelNotPublishedAfterMaintenance(maintained.owner,maintained.command,maintained.runs,maintained.fence,audit),cancelled)
  assert.equal((await pool.query('select count(*)::integer n from teloa_task_run_maintenance_dispositions where owner_id=$1',[maintained.owner])).rows[0].n,0,'确定未发布审计不能污染unknown处置')
  const fast=await fixture()
  await pool.query("update teloa_task_run_submissions set state='dispatching',settled_at=null where owner_id=$1 and run_id=$2 and attempt=2",[fast.owner,fast.run.id])
  await fast.runs.record(fast.owner,{runId:fast.run.id,sessionId:fast.run.sessionId,nativeRequestId:fast.run.nativeRequestId,evidence:{state:'accepted'}})
  await fast.runs.record(fast.owner,{runId:fast.run.id,sessionId:fast.run.sessionId,nativeRequestId:fast.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:0,endSeq:1,reason:'completed'}})
  await service.finish(fast.owner,fast.second,'accepted')
  assert.equal((await pool.query('select state from teloa_task_run_submissions where owner_id=$1 and run_id=$2 and attempt=2',[fast.owner,fast.run.id])).rows[0].state,'accepted','原生极快结束先到，不妨碍真实accepted票据结清')
  await assert.rejects((service as any).publicationState(fast.owner,fast.run),'旧submitting快照不得覆盖并发结束事实')
  const newer=await fixture()
  await pool.query("update teloa_tasks set version=version+1,state='waiting' where id=$1",[newer.taskId])
  await (service as any).cancelNotPublished(newer.owner,newer.command,newer.runs,newer.fence)
  assert.equal((await pool.query('select state from teloa_tasks where id=$1',[newer.taskId])).rows[0].state,'waiting','旧Run取消不能覆盖新Task状态')
 }finally{await pool.end()}
})


test('真实PG：原J07同源双Run完整形状只取消未发Run，原首报/来源/票据完整保留',{skip:!url||!process.env.TELOA_TEST_CANCEL_SNAPSHOT,timeout:30000},async()=>{
 const admin=new Pool({connectionString:url,max:1}),schema='cancel_shape_'+randomUUID().replaceAll('-','')
 await admin.query('create schema '+schema)
 const pool=new Pool({connectionString:url,max:2,options:'-c search_path='+schema+',public',statement_timeout:5000})
 try{
  await initializeTeloaDatabase(pool)
  const f=JSON.parse(await readFile(process.env.TELOA_TEST_CANCEL_SNAPSHOT!,'utf8'))
  const metadata=(await pool.query('select table_name,column_name,data_type from information_schema.columns where table_schema=$1',[schema])).rows
  async function insert(table:string,rows:Record<string,unknown>[]){
   const fields=metadata.filter(r=>r.table_name===table)
   for(const row of rows){const cols=Object.keys(row).filter(c=>fields.some(r=>r.column_name===c));await pool.query('insert into '+table+'('+cols.map(c=>'"'+c+'"').join(',')+') values('+cols.map((_,i)=>'$'+(i+1)).join(',')+')',cols.map(c=>fields.find(r=>r.column_name===c)?.data_type==='jsonb'&&row[c]!==null?JSON.stringify(row[c]):row[c]))}
  }
  await insert('teloa_roles',f.closed.teloa_roles);await insert('teloa_tasks',f.tasks)
  for(const table of ['teloa_plans','teloa_work_budget_accounts','teloa_work_controls','teloa_work_plan_bindings','teloa_plan_occurrences','teloa_plan_task_links','teloa_task_work_lineage','teloa_role_tool_grants','teloa_role_work_delegations','teloa_resources','teloa_business_object_snapshots','teloa_business_task_sources','teloa_object_conversations','teloa_work_events','teloa_business_task_source_updates'])await insert(table,f.closed[table])
  await insert('teloa_task_runs',f.runs);await insert('teloa_task_run_submissions',f.submissions);await insert('teloa_task_run_runtime_links',f.runtimeLinks)
  const owner=f.runs[1].owner_id,runs=new TaskRunService(pool,identity,async()=>{throw Error('取消不能启动或解析宿主')}),service=new TaskRunSubmissionService(pool)
  const first=await runs.get(owner,{runId:f.runs[0].id}),second=await runs.get(owner,{runId:f.runs[1].id}),beforeTickets=(await pool.query('select attempt,attempt_id,state,run_id from teloa_task_run_submissions order by run_id,attempt')).rows
  assert.equal(first.state,'ended');assert.equal(first.evidence?.state,'ended');assert.equal(second.state,'submitting');assert.equal(first.sessionId,second.sessionId)
  const beforeUpdates=(await pool.query('select * from teloa_business_task_source_updates')).rows,beforeSnapshots=(await pool.query('select * from teloa_business_object_snapshots')).rows
  const latest=f.submissions.filter((t:any)=>t.run_id===second.id).at(-1),fence={runId:second.id,sessionId:second.sessionId,nativeRequestId:second.nativeRequestId,inputSha256:createHash('sha256').update(second.inputText).digest('hex'),runtimeId:latest.runtime_id,logCut:16,logSha256:'a'.repeat(64),notPublished:true as const,assertCurrent(){}}
  const command={requestId:randomUUID(),runId:second.id,confirmNotPublished:true}
  assert.equal(await service.publicationState(owner,second),'not-published')
  const cancelled=await service.cancelNotPublished(owner,command,runs,fence);assert.equal(cancelled.state,'withdrawn');assert.equal(cancelled.evidence,null)
  assert.deepEqual(await runs.get(owner,{runId:first.id}),first);assert.equal(cancelled.inputText,second.inputText);assert.equal(cancelled.sessionId,first.sessionId)
  assert.deepEqual((await pool.query('select attempt,attempt_id,state,run_id from teloa_task_run_submissions order by run_id,attempt')).rows,beforeTickets)
  assert.deepEqual((await pool.query('select * from teloa_business_task_source_updates')).rows,beforeUpdates);assert.deepEqual((await pool.query('select * from teloa_business_object_snapshots')).rows,beforeSnapshots)
  assert.deepEqual(await runs.outstanding(owner),[])
 }finally{await pool.end();await admin.query('drop schema '+schema+' cascade');await admin.end()}
})
