import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {TaskService,initializeTasks,readStoredTask} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork} from '../src/work/conversation-work.ts'
import {TaskRunService,initializeTaskRuns,type TaskRun} from '../src/work/task-runs.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactFeedbackService,initializeArtifactFeedback} from '../src/work/artifact-feedback.ts'
import {ArtifactRevisionRequestService} from '../src/work/artifact-revision-requests.ts'
import {taskArtifactSource,taskArtifactSessions} from '../src/work/artifact-task-source.ts'
import {workRequestChildId} from '../src/work/conversation-work-task-protection.ts'
import {TaskTransitions,initializeTaskTransitions,initializeTaskCompletions} from '../src/work/task-transitions.ts'
import {workAccess} from '../src/work/work-access.ts'
import {WorkError,type WorkTask} from '@teloa/contract'

test('owner交付依据只读原已受理本人消息，固定Run/owner/child/来源改变均拒绝',async t=>{
 const container=await new PostgreSqlContainer('postgres:17-alpine').withPullPolicy({shouldPull:()=>false}).start()
 const pool=new Pool({connectionString:container.getConnectionUri()}),locks=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await locks.end();await pool.end();await container.stop()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeCollaboration(pool)
 const owner=randomUUID(),identity={id:randomUUID,now:()=>new Date().toISOString()},source={sessionId:'source-'+randomUUID(),messageId:'own-source',messageSeq:9,requestId:randomUUID()},sourceText='整理一份周会行动单，只用本人给出的合成事实。',goal='整理本周周会行动单。'
 const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:source.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
 await requests.reserve(owner,{...source,kind:'task',executor:'general',scope:'general',title:'原工作',goal,sourceText})
 const tasks=new TaskService(pool,identity),task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:source.requestId,executor:'general'}),sessionId='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async(actor:string,id:string)=>({ownerId:actor,sessionId:id,id:conversationId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const service=new TaskRunService(pool,identity,inspect),run=await service.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
 const before=(await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[owner,task.id])).rows
 const projected=await service.ownerReviewSource(owner,run)
 assert.equal(projected.sourceText,sourceText);assert.equal(projected.summary,goal);assert.deepEqual(projected.source,source);assert.equal(projected.runId,run.id)
 assert.deepEqual((await pool.query('select version,state from teloa_tasks where owner_id=$1 and id=$2',[owner,task.id])).rows,before,'读取不改变任务或授予执行')
 await assert.rejects(service.ownerReviewSource('other-owner',run),{code:'teloa/forbidden'})
 for(const patch of [{taskId:randomUUID()},{nativeRequestId:randomUUID()},{inputText:run.inputText+' '},{executor:{...run.executor!,grantId:randomUUID()}}])await assert.rejects(service.ownerReviewSource(owner,{...run,...patch}),{code:'teloa/forbidden'})
 await pool.query("update teloa_conversation_work_requests set request_spec=jsonb_set(request_spec,'{sourceText}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[owner,source.requestId,'另一条本人原文'])
 await assert.rejects(service.ownerReviewSource(owner,run),{code:'teloa/version-conflict'},'即使同grant，也不能把改变的原文投给旧Run')
 await pool.query("update teloa_conversation_work_requests set request_spec=jsonb_set(request_spec,'{sourceText}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[owner,source.requestId,sourceText])
 await t.test('员工原交办只读固定role子任务与原文，直接Task无父来源不伪造本人消息',async()=>{
  const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'查证员工',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'仅本人给出资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}}},{state:'active'})
  const fixedSource={...source,requestId:randomUUID(),messageId:randomUUID()}
  await requests.reserve(owner,{...fixedSource,kind:'task',scope:'general',title:'员工交办',goal,sourceText,roleId:role.id,expectedRoleVersion:role.version})
  const task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:fixedSource.requestId,roleId:role.id})
  const make=async(task:WorkTask)=>{
   const sessionId='role-run-'+randomUUID();await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
   return service.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
  }
  const run=await make(task),projected=await service.conversationReviewSource(owner,run);assert.ok(projected)
  assert.equal(projected.sourceText,sourceText);assert.equal(projected.summary,goal);assert.equal(projected.roleId,role.id);assert.equal(projected.roleVersion,role.version);assert.deepEqual(projected.source,fixedSource)
  for(const patch of [{roleId:randomUUID()},{roleVersion:role.version+1},{nativeRequestId:randomUUID()},{inputText:run.inputText+' '}])await assert.rejects(service.conversationReviewSource(owner,{...run,...patch}),{code:'teloa/forbidden'})
  await assert.rejects(service.conversationReviewSource('other-owner',run),{code:'teloa/forbidden'})
  const direct=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'本人直接任务',goal:'本人直接写入的目标。',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
  assert.equal(await service.conversationReviewSource(owner,await make(direct)),null)
  await pool.query("update teloa_conversation_work_requests set request_spec=jsonb_set(request_spec,'{sourceText}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[owner,fixedSource.requestId,'改变的原文'])
  await assert.rejects(service.conversationReviewSource(owner,run),{code:'teloa/version-conflict'})
 })
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeArtifactFeedback(pool)
 const artifacts=new ArtifactService(pool,identity,async(who,expected,db)=>({source:await taskArtifactSource(db,who,expected.id,true),sessionIds:await taskArtifactSessions(db,who,expected.id,true)}))
 const getTask=async(taskId:string)=>readStoredTask((await pool.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,taskId])).rows[0])
 const prepare=async(fixedSource={...source,requestId:randomUUID(),messageId:randomUUID()},text=sourceText):Promise<TaskRun>=>{
  await requests.reserve(owner,{...fixedSource,kind:'task',executor:'general',scope:'general',title:'独立交付',goal,sourceText:text})
  const task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:fixedSource.requestId,executor:'general'}),sessionId='task-run-'+randomUUID()
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  const run=await service.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
  await service.claim(owner,{runId:run.id});await service.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'accepted'}})
  return service.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'completed'}})
 }
 await t.test('缺复核阻断仅持有原CAS的任务，结束待办且保留原生completed',async()=>{
  const run=await prepare();assert.equal(await artifacts.ownerRunReceipt(owner,run),false)
  assert.ok((await service.outstanding(owner)).includes(run.id))
  await service.ownerResultBlocked(owner,run.id)
  const task=await getTask(run.taskId);assert.equal(task.state,'blocked');assert.equal(task.version,4)
  const saved=await service.get(owner,{runId:run.id});assert.equal(saved.evidence?.state==='ended'?saved.evidence.reason:undefined,'completed')
  assert.equal((await service.outstanding(owner)).includes(run.id),false)
  await service.ownerResultBlocked(owner,run.id);assert.equal((await getTask(run.taskId)).version,4,'重复处理不继续增版')
  assert.equal((await pool.query('select count(*)::int as n from teloa_artifacts where owner_id=$1',[owner])).rows[0].n,0)
 })
 await t.test('旧pending=false及后续本人变更均不改Task，旧发布待办不无限重试',async()=>{
  const old=await prepare();await pool.query('update teloa_task_runs set owner_result_pending=false where id=$1',[old.id])
  await service.ownerResultBlocked(owner,old.id);assert.equal((await getTask(old.taskId)).state,'waiting')
  const moved=await prepare();await pool.query("update teloa_tasks set state='paused',version=version+1 where owner_id=$1 and id=$2",[owner,moved.taskId])
  await service.ownerResultBlocked(owner,moved.id);assert.equal((await getTask(moved.taskId)).state,'paused');assert.equal((await service.outstanding(owner)).includes(moved.id),false)
 })
 await t.test('普通精确成果回执冷恢复可读，任意同任务成果不算本次发布',async()=>{
  const run=await prepare(),source=await taskArtifactSource(pool,owner,run.taskId,false),content={title:'原成果',sections:[{id:'result-0',title:'正文',text:'已正式定版正文'}],snapshotIds:[],note:'定版'}
  await artifacts.create(owner,{requestId:randomUUID(),source,content});assert.equal(await artifacts.ownerRunReceipt(owner,run),false)
  await artifacts.create(owner,{requestId:workRequestChildId(run.id,'owner-artifact'),source,content});assert.equal(await artifacts.ownerRunReceipt(owner,run),true)
  await service.ownerResultPublished(owner,run.id);assert.equal((await service.outstanding(owner)).includes(run.id),false);assert.equal((await getTask(run.taskId)).state,'waiting')
  await assert.rejects(artifacts.ownerRunReceipt(owner,{...run,nativeRequestId:randomUUID()}),{code:'teloa/forbidden'})
 })
 await t.test('修订继承已结项v1的原用户独有事实，绑定原producer而非反馈交办',async()=>{
  const originalSource={...source,requestId:randomUUID(),messageId:randomUUID()},facts='已核对8项，供应商回访由小林负责。\r\n仅这些是已给事实。 🔒\n',baseRun=await prepare(originalSource,facts),baseSource=await taskArtifactSource(pool,owner,baseRun.taskId,false)
  const base=await artifacts.create(owner,{requestId:workRequestChildId(baseRun.id,'owner-artifact'),source:baseSource,content:{title:'待修订',sections:[{id:'section',title:'正文',text:'原AI自行增加了下次周会前安排。\r\n原稿编辑基线 🔒\n'}],snapshotIds:[],note:'定版'}})
  await initializeTaskTransitions(pool);await initializeTaskCompletions(pool)
  await new TaskTransitions(pool,identity).change(owner,{requestId:randomUUID(),taskId:baseRun.taskId,expectedVersion:3,action:'complete',artifact:{id:base.artifactId,version:1},note:'本人核对原版'})
  const makeRevision=async(baseVersion=1)=>{
   const feedback=await new ArtifactFeedbackService(pool,identity).add(owner,{requestId:randomUUID(),artifactId:base.artifactId,version:baseVersion,sectionId:'section',text:'只更新版式，保留原已给事实，删除未经确认的日期。',source:baseSource}),revisions=new ArtifactRevisionRequestService(pool,identity.now),revision=await revisions.request(owner,{requestId:randomUUID(),artifactId:base.artifactId,baseVersion,feedbackId:feedback.id,sessionId:source.sessionId})
   const fixedSource={...source,requestId:randomUUID(),messageId:randomUUID()},text=`按原反馈修改。[teloa-revision:${revision.id}]`
   await revisions.bindSource(owner,{...fixedSource,sourceText:text},'general')
   await requests.reserve(owner,{...fixedSource,sourceText:text,kind:'task',executor:'general',scope:'general',title:'修订成果',goal:(await revisions.goalForSource(owner,{sessionId:source.sessionId,sourceText:text}))!})
   const task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:fixedSource.requestId,executor:'general'}),sessionId='task-run-'+randomUUID()
   await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
   return service.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
  }
  const run=await makeRevision(),fixed=JSON.parse(run.inputText).artifactRevision
  assert.equal(fixed.basis?.sourceText,facts,'修订反馈没有重述的原用户事实应从v1独立来源恢复')
  assert.deepEqual(fixed.basis.source,originalSource);assert.equal(fixed.basis.producer.runId,baseRun.id);assert.equal(fixed.basis.producer.taskId,baseRun.taskId)
  assert.ok(run.executor?.kind==='owner');assert.notEqual(fixed.basis.source.requestId,run.executor.grantId);assert.equal((await getTask(baseRun.taskId)).state,'completed');assert.deepEqual(run.knowledge,[])
  await assert.rejects(service.claim('other-owner',{runId:run.id}),{code:'teloa/forbidden'})
  const claim=()=>service.claim(owner,{runId:run.id})
  await pool.query('update teloa_artifacts set request_id=$3 where owner_id=$1 and id=$2',[owner,base.artifactId,randomUUID()]);await assert.rejects(claim(),{code:'teloa/version-conflict'},'无确定生产请求不能选任意同Task Run');await pool.query('update teloa_artifacts set request_id=$3 where owner_id=$1 and id=$2',[owner,base.artifactId,workRequestChildId(baseRun.id,'owner-artifact')])
  await pool.query("update teloa_conversation_work_requests set request_spec=jsonb_set(request_spec,'{sourceText}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[owner,originalSource.requestId,'同ID换成另一份事实']);await assert.rejects(claim(),{code:'teloa/version-conflict'});await pool.query("update teloa_conversation_work_requests set request_spec=jsonb_set(request_spec,'{sourceText}',to_jsonb($3::text)) where owner_id=$1 and request_id=$2",[owner,originalSource.requestId,facts])
  await pool.query('update teloa_artifacts set current_version=2 where owner_id=$1 and id=$2',[owner,base.artifactId]);await assert.rejects(claim(),{code:'teloa/version-conflict'},'固定base已漂移不能切latest');await pool.query('update teloa_artifacts set current_version=1 where owner_id=$1 and id=$2',[owner,base.artifactId])
  const originalTask=await getTask(baseRun.taskId)
  await pool.query("update teloa_tasks set definition=jsonb_set(definition,'{goal}',to_jsonb($3::text)) where owner_id=$1 and id=$2",[owner,baseRun.taskId,'已改变的目标']);await assert.rejects(claim(),{code:'teloa/version-conflict'});await pool.query("update teloa_tasks set definition=jsonb_set(definition,'{goal}',to_jsonb($3::text)) where owner_id=$1 and id=$2",[owner,baseRun.taskId,originalTask.goal])
  await pool.query('update teloa_task_runs set native_request_id=$3 where owner_id=$1 and id=$2',[owner,baseRun.id,randomUUID()]);await assert.rejects(claim(),{code:'teloa/version-conflict'});await pool.query('update teloa_task_runs set native_request_id=$3 where owner_id=$1 and id=$2',[owner,baseRun.id,baseRun.nativeRequestId])
  const corrupt=JSON.parse(run.inputText);corrupt.artifactRevision.basis.sourceTextSha256='0'.repeat(64)
  await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[owner,run.id,JSON.stringify(corrupt)]);await assert.rejects(service.get(owner,{runId:run.id}),{code:'teloa/storage-corrupt'});await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[owner,run.id,run.inputText])
  const legacy=await makeRevision(),legacyInput=JSON.parse(legacy.inputText);delete legacyInput.artifactRevision.basis
  const legacyText=JSON.stringify(legacyInput);await pool.query('update teloa_task_runs set input_text=$3 where owner_id=$1 and id=$2',[owner,legacy.id,legacyText]);assert.equal((await service.get(owner,{runId:legacy.id})).inputText,legacyText);await service.claim(owner,{runId:legacy.id});const legacyReadback=(await service.get(owner,{runId:legacy.id})).inputText;assert.ok(Buffer.from(legacyReadback).equals(Buffer.from(legacyText)),'历史8字段Run准入不补basis，完整字节保持');assert.equal(Object.keys(JSON.parse(legacyReadback).artifactRevision).length,8);assert.equal(JSON.parse(legacyReadback).artifactRevision.originalText,base.content.sections[0]!.text)
  t.diagnostic(JSON.stringify({case:'legacy-eight-field-full-byte',beforeSha256:createHash('sha256').update(legacyText).digest('hex'),afterSha256:createHash('sha256').update(legacyReadback).digest('hex'),bytes:Buffer.byteLength(legacyText),crlf:true,unicode:true,originalTaskState:(await getTask(baseRun.taskId)).state}))
  let revoked=false
  workAccess.installPolicy(async request=>{const original=request.kind==='capability'&&request.objectId===originalSource.requestId;return {assertCurrent(){if(original&&revoked)throw new WorkError('teloa/forbidden','原事实读取已撤权。')}}})
  revoked=true;await assert.rejects(claim(),{code:'teloa/forbidden'});revoked=false
  const before=await getTask(baseRun.taskId);await claim();assert.deepEqual(await getTask(baseRun.taskId),before,'读取历史来源不能重新激活原Task')
  const admission=await service.executionAdmission(owner,run.id)
  await service.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:3,reason:'completed'}})
  await artifacts.reviseFromRequest(owner,{revisionId:fixed.requestId,runId:run.id,text:'保留原用户的8项核对事实。'},async db=>{await service.executionScopeInTransaction(db,owner,{runId:run.id,mode:'completion'});return {assertCurrent(){}}})
  const next=await makeRevision(2)
  assert.deepEqual(JSON.parse(next.inputText).artifactRevision.basis,fixed.basis,'正式v2 producer只复用已冻结的扁平初版依据，不把反馈交办当原事实')
  const nextAdmission=await service.executionAdmission(owner,next.id)
  await requests.stop(owner,{sessionId:originalSource.sessionId,requestId:originalSource.requestId})
  assert.throws(()=>admission.assertCurrent(),{code:'teloa/forbidden'},'原来源停止须立即使已经返回的执行lease失效')
  assert.throws(()=>nextAdmission.assertCurrent(),{code:'teloa/forbidden'},'扁平继承来源的待执行lease也须立即失效')
  await assert.rejects(service.claim(owner,{runId:next.id}),{code:'teloa/forbidden'})
  t.diagnostic(JSON.stringify({case:'fixed-producer-source-and-stop',originalTaskCompleted:true,baseVersion2FlattenedBasis:true,originalSourceLeaseRevoked:true,knowledgeInherited:0}))
 })
 await t.test('修订精确request/Run/producer/版本正文回执恢复，不把其他成果或修订当本次',async()=>{
  const baseRun=await prepare(),baseSource=await taskArtifactSource(pool,owner,baseRun.taskId,false),base=await artifacts.create(owner,{requestId:randomUUID(),source:baseSource,content:{title:'待修订',sections:[{id:'section',title:'正文',text:'原正文'}],snapshotIds:[],note:'定版'}})
  const feedback=await new ArtifactFeedbackService(pool,identity).add(owner,{requestId:randomUUID(),artifactId:base.artifactId,version:1,sectionId:'section',text:'仅修订这节。',source:baseSource})
  const revisions=new ArtifactRevisionRequestService(pool,identity.now),revision=await revisions.request(owner,{requestId:randomUUID(),artifactId:base.artifactId,baseVersion:1,feedbackId:feedback.id,sessionId:source.sessionId})
  const fixedSource={...source,requestId:randomUUID(),messageId:randomUUID()},text=`按原反馈修改。[teloa-revision:${revision.id}]`
  await revisions.bindSource(owner,{...fixedSource,sourceText:text},'general')
  const run=await prepare(fixedSource,text);assert.equal(await artifacts.ownerRunReceipt(owner,run),false)
  await artifacts.reviseFromRequest(owner,{revisionId:revision.id,runId:run.id,text:'修订后正文'},async()=>({assertCurrent:()=>{}}))
  assert.equal(await artifacts.ownerRunReceipt(owner,run),true)
  await service.ownerResultPublished(owner,run.id);assert.equal((await service.outstanding(owner)).includes(run.id),false)
  await pool.query("update teloa_artifact_revision_requests set candidate_text='另一正文' where owner_id=$1 and id=$2",[owner,revision.id])
  await assert.rejects(artifacts.ownerRunReceipt(owner,run),{code:'teloa/storage-corrupt'})
 })
})
