import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {setupRoleWork,roleFixture,identity,loadRoleWorkModule} from './role-work-test-fixture.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupWorkInputService} from '../src/work/group-work-inputs.ts'
import {drainGroupWorkInputs} from '../../harness-dsh/src/group-work-input-driver.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'
import {Pool} from './postgres-test-lifecycle.ts'

test('提交凭据持久绑定原身份，只有明确未发布回执可跨宿主恢复且并发只领取一次',{timeout:30000},async()=>{
 const api=await loadRoleWorkModule('task-run-submission')
 assert.equal(typeof api.TaskRunSubmissionService,'function','缺少正式提交回执服务，未知提交无法区分确定未发布')
 const f=await setupRoleWork()
 try{
  await initializeTeloaDatabase(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),sessionId='submission-'+randomUUID(),conversationId=randomUUID()
  const db=await f.pool.connect();try{await db.query('begin');await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  const link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(f.pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'teloa-standard')
  const run=(await runs.claim(owner,{runId:prepared.id})).run,service=new api.TaskRunSubmissionService(f.pool),generation=randomUUID()
  assert.equal(await service.recoverable(owner,run),false,'无凭据的旧 unknown 不能重发')
  assert.deepEqual(await service.unpublishedOwnerIds(owner,run.id),[],'缺提交凭据不能退休旧owner')
  const first=await service.begin(owner,run,generation)
  const ownerNativeId='owner:'+generation+':'+run.sessionId
  await new TaskRunRuntimeLinkService(f.pool).put(owner,{runId:run.id,kind:'job',nativeId:ownerNativeId,sessionId:run.sessionId,payload:{record:'owner',runtimeId:generation,requestId:run.nativeRequestId}})
  assert.equal(first.runtimeId,generation)
  assert.equal(await service.recoverable(owner,run),false,'在途或崩溃未知不能重发')
  await assert.rejects(service.begin(owner,run,randomUUID()))
  for(const altered of [{...first,runtimeId:randomUUID()},{...first,nativeRequestId:randomUUID()},{...first,sessionId:'other'},{...first,inputSha256:'0'.repeat(64)}])await assert.rejects(service.finish(owner,altered,'not-published'))
  await assert.rejects(service.finish(randomUUID(),first,'not-published'))
  await service.finish(owner,first,'not-published')
  await service.finish(owner,first,'not-published')
  assert.deepEqual(await service.unpublishedOwnerIds(owner,run.id),['owner:'+generation+':'+run.sessionId])
  const guardedPool=new Pool({...f.pool.options,options:'-c lock_timeout=1000',statement_timeout:3000}),guarded=new api.TaskRunSubmissionService(guardedPool),held=await f.pool.connect()
  try{
   await held.query('begin')
   await held.query('select id from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,run.id])
   assert.deepEqual(await guarded.unpublishedOwnerIds(owner,run.id),[ownerNativeId],'纯读过滤应兼容续报准备持有的共享锁')
   await assert.rejects(guarded.begin(owner,run,randomUUID()),{code:'55P03'},'提交写入口仍需排他锁，不能借纯读修复降低写隔离')
   await held.query('commit')
   await held.query('begin')
   await held.query('select id from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,run.id])
   await assert.rejects(guarded.unpublishedOwnerIds(owner,run.id),{code:'55P03'},'读取仍须等提交写事务释放原 Run')
  }finally{await held.query('rollback');held.release();await guardedPool.end()}
  assert.equal((await f.pool.query('select count(*)::integer count from teloa_task_run_submissions where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0].count,1,'被共享锁拒绝的写入不得留下新提交')
  await f.pool.query("update teloa_task_run_runtime_links set payload=jsonb_set(payload,'{runtimeId}',to_jsonb($3::text)) where owner_id=$1 and run_id=$2",[owner,run.id,randomUUID()])
  await assert.rejects(service.unpublishedOwnerIds(owner,run.id),'nativeId与payload世代不一致不得退休owner')
  await f.pool.query("update teloa_task_run_runtime_links set payload=jsonb_set(payload,'{runtimeId}',to_jsonb($3::text)) where owner_id=$1 and run_id=$2",[owner,run.id,generation])
  const unavailable=new api.TaskRunSubmissionService({connect:async()=>{const db=await f.pool.connect();return {query:(sql:string,args?:unknown[])=>{if(sql.startsWith('select * from teloa_task_run_submissions'))throw Error('回执读取失败');return db.query(sql,args)},release:()=>db.release()}}})
  await assert.rejects(unavailable.unpublishedOwnerIds(owner,run.id),/回执读取失败/,'读失败不得变成可忽略旧owner')
  assert.equal(await new api.TaskRunSubmissionService(f.pool).recoverable(owner,run),true,'服务重建仍认持久未发布证明')
  await assert.rejects(service.recoverable(owner,{...run,inputText:'更改后的输入'}))
  const attempts=await Promise.allSettled([service.begin(owner,run,generation),service.begin(owner,run,generation)])
  assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1)
  const next=attempts.find(x=>x.status==='fulfilled')!.value
  assert.notEqual(next.attemptId,first.attemptId)
  assert.deepEqual(await service.unpublishedOwnerIds(owner,run.id),[],'同世代有dispatching尝试时不能用之前未发布回执排除owner')
  await assert.rejects(service.finish(owner,first,'accepted'),'迟到旧宿主回执不能改变新尝试')
  await service.finish(owner,next,'accepted')
  assert.deepEqual(await service.unpublishedOwnerIds(owner,run.id),[],'同世代混合accepted与not-published不能退休owner')
  assert.equal(await service.recoverable(owner,run),false)
  await assert.rejects(service.finish(owner,next,'not-published'),'受理后不能降级')
  assert.deepEqual(await runs.get(owner,{runId:run.id}),run,'提交审计不能改写原Run身份或伪造原生终态')
  assert.equal(typeof service.disposeUnknown,'function','未知提交必须有显式且留审计的正式处置路径')
  await assert.rejects(service.disposeUnknown(owner,{requestId:randomUUID(),runId:run.id,acknowledgeUnknown:true},runs,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),runtimeId:randomUUID(),logCut:0,logSha256:'a'.repeat(64),assertCurrent(){}}),'尚未本人请求停止的运行不能处置')
 }finally{await f.close()}
})

test('本人明确处置未知提交须同时持有原身份停发栅栏，原任务暂停且不伪造执行证据',{timeout:30000},async()=>{
 const api=await loadRoleWorkModule('task-run-submission'),f=await setupRoleWork()
 try{
  await initializeTeloaDatabase(f.pool)
  const {owner,role,taskId}=await roleFixture(f.pool,'employee'),sessionId='unknown-'+randomUUID(),conversationId=randomUUID()
  const groups=new CollaborationService(f.pool,identity),inputs=new GroupWorkInputService(f.pool,identity)
  const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'未知提交回归群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
  await f.pool.query("update teloa_tasks set definition=jsonb_set(definition,'{groupId}',to_jsonb($2::text)) where id=$1",[taskId,group.id])
  const db=await f.pool.connect();try{await db.query('begin');await new WorkLineageService(f.pool,identity).bindTask(db,owner,{taskId,source:{kind:'owner-task',taskId}});await db.query('commit')}finally{db.release()}
  await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
  const inspect=async()=>({id:conversationId,ownerId:owner,sessionId,status:'ready'})
  const link=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const runs=new TaskRunService(f.pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:link.version},undefined,undefined,undefined,async()=> 'teloa-standard')
  const claimed=(await runs.claim(owner,{runId:prepared.id})).run,service=new api.TaskRunSubmissionService(f.pool),runtimeId=randomUUID()
  const attempt=await service.begin(owner,claimed,runtimeId)
  await service.finish(owner,attempt,'accepted')
  const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'这轮结束后补充负责人列。'})
  const expectedTaskVersion=(await f.pool.query('select version from teloa_tasks where id=$1',[taskId])).rows[0].version
  const queued=await inputs.reserveInTransaction(f.pool,owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,taskId,expectedTaskVersion,operation:'continue'})
  assert.equal(queued.state,'reserved')
  const run=await runs.requestStop(owner,{runId:prepared.id})
  const command={runId:run.id,requestId:randomUUID(),acknowledgeUnknown:true},fence={runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex'),runtimeId,logCut:8,logSha256:'a'.repeat(64),assertCurrent(){}}
  const before=(await f.pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows[0]
  await assert.rejects(service.disposeUnknown(owner,{...command,acknowledgeUnknown:false},runs,fence))
  await assert.rejects(service.disposeUnknown(randomUUID(),command,runs,fence))
  await assert.rejects(service.disposeUnknown(owner,command,runs,{...fence,runId:randomUUID()}))
  await assert.rejects(service.disposeUnknown(owner,command,runs,{...fence,runtimeId:randomUUID()}),'重新加载冷会话的新宿主不能替原提交世代作证')
  await assert.rejects(service.disposeUnknown(owner,command,runs,{...fence,assertCurrent(){throw Error('原宿主仍活动')}}))
  let calls=0
  await assert.rejects(service.disposeUnknown(owner,command,runs,{...fence,assertCurrent(){if(++calls===3)throw Error('提交期间宿主栅栏变化')}}))
  assert.deepEqual((await f.pool.query('select * from teloa_task_runs where id=$1',[run.id])).rows[0],before,'栅栏失效必须完整回滚')
  const closed=await service.disposeUnknown(owner,command,runs,fence)
  assert.equal(closed.state,'submission_unknown');assert.equal(closed.evidence,null);assert.equal(closed.stopRequestedAt,run.stopRequestedAt)
  assert.equal(closed.id,run.id);assert.equal(closed.sessionId,run.sessionId);assert.equal(closed.nativeRequestId,run.nativeRequestId);assert.equal(closed.inputText,run.inputText)
  assert.equal(closed.submissionDisposition.acknowledgedUnknown,true)
  assert.equal((await f.pool.query('select state from teloa_task_run_submissions where run_id=$1',[run.id])).rows[0].state,'accepted','已发布审计不能在处置中降成未发布')
  assert.equal((await f.pool.query('select state from teloa_tasks where id=$1',[taskId])).rows[0].state,'paused')
  const paused=(await f.pool.query('select version,state from teloa_tasks where id=$1',[taskId])).rows[0],queuedCalls:string[]=[]
  await drainGroupWorkInputs(owner,{inputs,prepare:async()=>{queuedCalls.push('prepare');throw Error('禁止自动准备')},start:async()=>{queuedCalls.push('start');throw Error('禁止自动启动')},readRun:async()=>{queuedCalls.push('readRun');throw Error('不应消费原处置')},reconcile:async()=>{queuedCalls.push('reconcile');throw Error('不应继续')},stop:async()=>{throw Error('不是停止回执')},report:()=>{}},AbortSignal.timeout(5000))
  assert.equal((await inputs.get(owner,queued.requestId)).state,'rejected','处置前排队的追加不能复活原任务')
  assert.deepEqual(queuedCalls,[])
  assert.deepEqual((await f.pool.query('select version,state from teloa_tasks where id=$1',[taskId])).rows[0],paused,'未知处置后的Task不升版本、不变ready')
  assert.deepEqual(await service.disposeUnknown(owner,command,runs,fence),closed)
  assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,false)
  await assert.rejects(runs.executionAdmission(owner,run.id))
  await assert.rejects(runs.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}}),'迟到回执不能覆盖本人处置')
  assert.deepEqual(await runs.outstanding(owner),[])
 }finally{await f.close()}
})
