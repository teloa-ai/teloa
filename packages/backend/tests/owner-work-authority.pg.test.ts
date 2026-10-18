import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork} from '../src/work/conversation-work.ts'
import {OwnerWorkAuthority} from '../src/work/owner-work-authority.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {ArtifactService,initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {ArtifactFeedbackService,initializeArtifactFeedback} from '../src/work/artifact-feedback.ts'
import {ArtifactRevisionRequestService,isArtifactRevisionProducer} from '../src/work/artifact-revision-requests.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {TaskTransitions,initializeTaskTransitions,initializeTaskCompletions} from '../src/work/task-transitions.ts'
let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:16-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});locks=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeCollaboration(pool)},{timeout:180000})
after(async()=>{await locks?.end();await pool?.end();await stopTestContainer(container)})
test('已结项成果通过后续本人工作局部续改；普通写口仍拒绝，原归属和旧版本不变',async()=>{
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeArtifactFeedback(pool)
 const owner=randomUUID(),tasks=new TaskService(pool,identity),original=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'原任务',goal:'原目标',scope:'general'}})
 const originalSource=await taskArtifactSource(pool,owner,original.id,false),artifacts=new ArtifactService(pool,identity,async(actor,expected,db)=>({source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:[]}))
 const base=await artifacts.create(owner,{requestId:randomUUID(),source:originalSource,content:{title:'完整成果',sections:[{id:'a',title:'需修改',text:'旧正文'},{id:'b',title:'保留',text:'本人保留的内容'}],snapshotIds:[],note:'初版'}})
 await pool.query("update teloa_tasks set state='completed',version=2 where id=$1",[original.id])
 await assert.rejects(artifacts.revise(owner,{artifactId:base.artifactId,expectedVersion:1,source:originalSource,content:{...base.content,note:'非法直写'}}),{code:'teloa/conflict'})
 const feedback=await new ArtifactFeedbackService(pool,identity).add(owner,{requestId:randomUUID(),artifactId:base.artifactId,version:1,sectionId:'a',text:'用清楚的依据补全',source:originalSource})
 const source={sessionId:'source_'+randomUUID(),messageId:'accepted-revision',messageSeq:1,requestId:randomUUID()},revisions=new ArtifactRevisionRequestService(pool,identity.now),revision=await revisions.request(owner,{requestId:randomUUID(),artifactId:base.artifactId,baseVersion:1,feedbackId:feedback.id,sessionId:source.sessionId})
 const sourceText='请按反馈续改 [teloa-revision:'+revision.id+']'
 assert.ok((await revisions.goalForSource(owner,{sessionId:source.sessionId,sourceText}))?.includes('用清楚的依据补全'))
 await assert.rejects(revisions.goalForSource(owner,{sessionId:'other',sourceText}),{code:'teloa/forbidden'})
 await assert.rejects(revisions.goalForSource('other-owner',{sessionId:source.sessionId,sourceText}),{code:'teloa/forbidden'})
 const staleFeedback=await new ArtifactFeedbackService(pool,identity).add(owner,{requestId:randomUUID(),artifactId:base.artifactId,version:1,sectionId:'a',text:'另一份尚未交办的反馈',source:originalSource})
 const stale=await revisions.request(owner,{requestId:randomUUID(),artifactId:base.artifactId,baseVersion:1,feedbackId:staleFeedback.id,sessionId:source.sessionId}),staleSource={sessionId:source.sessionId,sourceText:'续改 [teloa-revision:'+stale.id+']'}
 await revisions.bindSource(owner,{...source,sourceText},'general')
 const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:source.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
 await requests.reserve(owner,{...source,sourceText,kind:'task',executor:'general',scope:'general',title:'修订成果',goal:'只修订已选择段落'})
 const task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:source.requestId,executor:'general'}),sessionId='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async(actor:string,id:string)=>({id:conversationId,ownerId:actor,sessionId:id,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
 assert.equal(JSON.parse(run.inputText).artifactRevision.originalText,'旧正文')
 assert.ok((await revisions.goalForSource(owner,{sessionId:source.sessionId,sourceText}))?.includes('用清楚的依据补全'),'同一有效 bound 修订仍可在执行时核对')
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const authorize=async(db:import('pg').PoolClient,id:string)=>{await runs.executionScopeInTransaction(db,owner,{runId:id,mode:'completion'});return {assertCurrent:()=>{}}}
 const result=await artifacts.reviseFromRequest(owner,{revisionId:revision.id,runId:run.id,text:'有依据的新正文'},authorize)
 assert.equal(result.applied,true)
 await assert.rejects(revisions.goalForSource(owner,{sessionId:source.sessionId,sourceText}),{code:'teloa/version-conflict'},'已完成标记不再投影为当前可交办修订')
 assert.equal((await revisions.list(owner,base.artifactId)).find(value=>value.id===stale.id)?.state,'requested')
 await assert.rejects(revisions.goalForSource(owner,staleSource),{code:'teloa/version-conflict'},'仍 requested 但成果 head 已漂移也不得披露为当前修订')
 const versions=await artifacts.list(owner,{artifactId:base.artifactId})
 assert.equal(versions.length,2);assert.equal(versions[0]!.content.sections[0]!.text,'旧正文');assert.deepEqual(versions[1]!.source,originalSource);assert.deepEqual(versions[1]!.content.sections[1],base.content.sections[1])
 assert.equal(await isArtifactRevisionProducer(pool,owner,task.id,versions[1]!),true)
 const produced=await artifacts.listTask(owner,await taskArtifactSource(pool,owner,task.id,false))
 assert.equal(produced[0]?.artifactId,base.artifactId);assert.equal(produced[0]?.producer?.taskVersion,3)
 assert.deepEqual(await artifacts.reviseFromRequest(owner,{revisionId:revision.id,runId:run.id,text:'有依据的新正文'},authorize),result)
 await assert.rejects(artifacts.reviseFromRequest('another-owner',{revisionId:revision.id,runId:run.id,text:'有依据的新正文'},authorize),{code:'teloa/forbidden'})
 await initializeTaskTransitions(pool);await initializeTaskCompletions(pool)
 const states=new TaskTransitions(pool,identity)
 const complete=await states.change(owner,{requestId:randomUUID(),taskId:task.id,expectedVersion:3,action:'complete',artifact:{id:base.artifactId,version:2},note:'本人核对后续修改'})
 assert.equal(complete.state,'completed');assert.equal((await states.completion(owner,{taskId:task.id}))?.artifactVersion,2)
 assert.equal((await tasks.list(owner,{})).find(row=>row.id===original.id)?.version,2)
})
test('本人授权只消费已受理 general 原消息，旧空负责人不获得授权；原请求停止立即撤销新执行',async()=>{
 const owner=randomUUID(),source={sessionId:'source_'+randomUUID(),messageId:'accepted',messageSeq:1,requestId:randomUUID()}
 const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:source.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
 const authority=new OwnerWorkAuthority(pool),tasks=new TaskService(pool,identity)
 await assert.rejects(authority.capture(owner,source),{code:'teloa/forbidden'})
 await requests.reserve(owner,{...source,kind:'task',executor:'general',scope:'general',title:'本人工作',goal:'核对合成资料'})
 const grant=await authority.capture(owner,source)
 assert.deepEqual(grant.executor,{kind:'owner',grantId:source.requestId,grantVersion:1})
 const task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:source.requestId,executor:'general'})
 assert.deepEqual(task.executor,grant.executor);assert.equal(task.assigneeRoleId,null)
 const draft=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'草稿',goal:'未交办',scope:'general'}})
 assert.notEqual(draft.executor?.kind,'owner')
 for(const bad of [{...source,messageId:'forged'},{...source,messageSeq:2},{...source,sessionId:'other'}])await assert.rejects(authority.capture(owner,bad),{code:'teloa/forbidden'})
 await assert.rejects(authority.capture('other',source),{code:'teloa/forbidden'})
 await authority.assertCurrent(owner,grant.executor,'prepare')
 const reading=await locks.connect()
 try{
  await reading.query('begin')
  for(const key of [JSON.stringify(['teloa/conversation-task-child',owner,task.id]),JSON.stringify(['teloa/conversation-work',owner,'request:'+source.requestId])])await reading.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[key])
  await authority.assertCurrent(owner,grant.executor,'resume')
 }finally{await reading.query('rollback');reading.release()}
 await requests.stop(owner,{sessionId:source.sessionId,requestId:source.requestId})
 await assert.rejects(authority.assertCurrent(owner,grant.executor,'start'),{code:'teloa/forbidden'})
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[owner])).rows[0].n,0)
})
test('通用本人 Run 复用一次领取和原生证据状态机；不创建员工，重启仍可读',async()=>{
 const owner=randomUUID(),source={sessionId:'source_'+randomUUID(),messageId:'accepted',messageSeq:1,requestId:randomUUID()},sessionId='task-run-'+randomUUID(),conversationId=randomUUID()
 const requests=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:source.sessionId,status:'ready',submitted:true}),undefined,undefined,locks)
 await requests.reserve(owner,{...source,kind:'task',executor:'general',scope:'general',title:'独立工作',goal:'整理合成说明'})
 const tasks=new TaskService(pool,identity),task=await tasks.createForConversation(owner,{sessionId:source.sessionId,requestId:source.requestId,executor:'general'})
 const inspect=async(actor:string,id:string)=>({id:conversationId,ownerId:actor,sessionId:id,status:'ready'})
 const links=new ObjectConversationService(pool,inspect,identity.now)
 await links.change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect)
 const target=await runs.preparationTarget(owner,{taskId:task.id,expectedTaskVersion:1})
 assert.equal(target.roleId,null);assert.deepEqual(target.executor,task.executor)
 const command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId,expectedLinkVersion:1}
 const prepared=await runs.prepareOwner(owner,command,{agentPresetId:'teloa-standard'})
 assert.equal(prepared.roleId,null);assert.equal(prepared.roleSnapshot,undefined)
 assert.deepEqual((await runs.claim(owner,{runId:prepared.id})).run.executor,task.executor)
 assert.equal((await runs.claim(owner,{runId:prepared.id})).dispatch,false)
 await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'accepted'}})
 await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 assert.ok((await runs.outstanding(owner)).includes(prepared.id),'结束事务必须保留待保存成果，冷恢复不重跑模型')
 await runs.ownerResultPublished(owner,prepared.id)
 assert.ok(!(await runs.outstanding(owner)).includes(prepared.id))
 assert.equal((await tasks.list(owner,{}))[0]!.state,'waiting')
 assert.deepEqual((await new TaskRunService(pool,identity,inspect).get(owner,{runId:prepared.id})).executor,task.executor)
 assert.equal((await pool.query('select count(*)::int n from teloa_roles where owner_id=$1',[owner])).rows[0].n,0)
})

test('续改提交遇到新版时保留候选和原归属，不覆盖本人并发修改',async()=>{
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeArtifactFeedback(pool)
 const owner=randomUUID(),sessionId='source_'+randomUUID(),source={kind:'session' as const,id:sessionId,scope:'general',version:randomUUID(),title:'并发原稿'},artifacts=new ArtifactService(pool,identity,async()=>({source,sessionIds:[sessionId]}))
 const base=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'并发成果',sections:[{id:'a',title:'正文',text:'原稿正文'},{id:'b',title:'保留',text:'其他段落'}],snapshotIds:[],note:'初版'}})
 const feedback=await new ArtifactFeedbackService(pool,identity).add(owner,{requestId:randomUUID(),artifactId:base.artifactId,version:1,sectionId:'a',text:'补充已核实依据',source}),revisions=new ArtifactRevisionRequestService(pool,identity.now),revision=await revisions.request(owner,{requestId:randomUUID(),artifactId:base.artifactId,baseVersion:1,feedbackId:feedback.id,sessionId})
 const accepted={sessionId,messageId:'accepted',messageSeq:1,requestId:randomUUID()},sourceText='[teloa-revision:'+revision.id+']'
 await revisions.bindSource(owner,{...accepted,sourceText},'general')
 await new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId,status:'ready',submitted:true}),undefined,undefined,locks).reserve(owner,{...accepted,sourceText,kind:'task',executor:'general',scope:'general',title:'续改',goal:'修订指定原稿'})
 const task=await new TaskService(pool,identity).createForConversation(owner,{sessionId,requestId:accepted.requestId,executor:'general'}),runSession='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,ownerId:owner,sessionId:runSession,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId:runSession,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepareOwner(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,executor:task.executor,sessionId:runSession,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId:runSession,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 const newer=await artifacts.revise(owner,{artifactId:base.artifactId,expectedVersion:1,source,content:{...base.content,sections:[{...base.content.sections[0]!,text:'本人同时修订的新正文'},base.content.sections[1]!],note:'本人修改'}})
 const authorize=async(db:import('pg').PoolClient,id:string)=>{await runs.executionScopeInTransaction(db,owner,{runId:id,mode:'completion'});return {assertCurrent(){}}}
 const result=await artifacts.reviseFromRequest(owner,{revisionId:revision.id,runId:run.id,text:'AI候选正文'},authorize)
 assert.equal(result.applied,false);assert.equal(result.candidateText,'AI候选正文')
 assert.deepEqual((await artifacts.list(owner,{artifactId:base.artifactId}))[1],newer)
 assert.equal((await revisions.list(owner,base.artifactId))[0]?.state,'conflict')
 assert.deepEqual(await artifacts.reviseFromRequest(owner,{revisionId:revision.id,runId:run.id,text:'AI候选正文'},authorize),result)
 assert.equal((await artifacts.list(owner,{artifactId:base.artifactId})).length,2)
})
