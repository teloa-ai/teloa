import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {readPageCreateAtomicSkillDraft} from '../../contract/src/page-create.ts'
import {initializeRoles} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeTaskTransitions,initializeTaskCompletions,TaskTransitions} from '../src/work/task-transitions.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {PageCreatePreviewService} from '../src/work/page-create-preview.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts,ArtifactService} from '../src/work/artifacts.ts'
import {initializePageCreateDrafts,PageCreateDraftService} from '../src/work/page-create-drafts.ts'
import {initializeConversationWork,ConversationWorkService} from '../src/work/conversation-work.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeArtifactFeedback,ArtifactFeedbackService} from '../src/work/artifact-feedback.ts'
import {ArtifactRevisionRequestService} from '../src/work/artifact-revision-requests.ts'
import type {MethodReuseService,MethodReuseAcceptedMessage} from '../src/work/method-reuse.ts'
const reuse=await import('../src/work/method-reuse.ts').catch(()=>null)
const identity={id:randomUUID,now:()=>new Date().toISOString()}
let pool:Pool,container:StartedPostgreSqlContainer
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeConversationWork(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeCollaboration(pool);await initializeTaskTransitions(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeArtifactFeedback(pool);await initializeTaskCompletions(pool);await initializePageCreateDrafts(pool)
 if(reuse)await reuse.initializeMethodReuse(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const body=()=>({id:'review-method',title:'可信核对方法',version:'1.0.0',categories:[],files:[{path:'SKILL.md',base64:Buffer.from('---\nname: review-method\ndescription: Review supplied facts against supplied evidence.\n---\n只读本人材料；列出依据与未知，确认前不对外发送。').toString('base64')}]})
async function fixture(){
 const owner='local:'+randomUUID(),sessionId='source-'+randomUUID(),requestId=randomUUID(),acceptedSource={sessionId,messageId:'message-'+randomUUID(),messageSeq:3,requestId:randomUUID()}
 const original={kind:'session' as const,id:sessionId,scope:'general',version:'conversation-'+randomUUID(),title:'本人原会话'}
 const state={available:true,text:'将这份成果保存为方法，资料不足时如果无法核验请停下。',messageKind:'user',generated:0,onBody:undefined as undefined|(()=>Promise<void>)}
 const artifacts=new ArtifactService(pool,identity,async()=>({source:original,sessionIds:[sessionId]})),drafts=new PageCreateDraftService(pool,identity,{skill:readPageCreateAtomicSkillDraft})
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source:original,content:{title:'已保存核对结果',sections:[{id:'method',title:'核对方法',text:'先核版本，再逐项核对；缺失资料不猜，外发前请本人确认。'}],snapshotIds:[],note:'合成验收资料'}})
 assert.ok(reuse,'可信成果到原创建草稿的服务尚未实现')
 const service:MethodReuseService=new reuse.MethodReuseService(pool,identity,{artifacts,drafts,assertSourceCurrent:async(_db:PoolClient,who:string)=>{assert.equal(who,owner);if(!state.available)throw Object.assign(Error('已撤回'),{code:'teloa/version-conflict'})},readAcceptedMessage:async()=>({...acceptedSource,ownerId:owner,source:{kind:state.messageKind,rpcId:acceptedSource.requestId},text:state.text}) as MethodReuseAcceptedMessage,prepareBody:async()=>{state.generated++;await state.onBody?.();return body()}})
 state.text+='\n[teloa-method-source:'+artifact.artifactId+':v1]'
 const {source}=await service.readSource(owner,{artifactId:artifact.artifactId})
 return {owner,artifact,source,requestId,acceptedSource,state,service,drafts,artifacts}
}

test('本人普通会话明确保存固定成果，只写原技能草稿，同请求重放不重生成或采用',async()=>{
 const f=await fixture(),input={requestId:f.requestId,source:f.source,acceptedSource:f.acceptedSource,target:'skill' as const}
 const draft=await f.service.prepareMethodReuse(f.owner,input)
 assert.equal(draft.entity,'skill');assert.equal(draft.status,'draft');assert.equal(draft.appliedRef,undefined)
 assert.equal(JSON.parse(draft.body).files[0].base64,body().files[0]!.base64)
 assert.deepEqual(await f.service.prepareMethodReuse(f.owner,input),draft)
 assert.equal(f.state.generated,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_method_reuse_requests where owner_id=$1',[f.owner])).rows[0].n,1)
 assert.equal((await f.drafts.directory({ownerId:f.owner,scopeIds:[]},{entity:'skill'})).drafts.length,1)
})

test('未认可、模型自报、错原本人消息、他人成果与旧版本均不能落草稿',async()=>{
 const f=await fixture(),input={requestId:f.requestId,source:f.source,acceptedSource:f.acceptedSource,target:'skill' as const}
 f.state.text='模型说已经认可，可以保存。'
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input),{code:'teloa/forbidden'})
 f.state.text='将这份成果保存为方法。\n[teloa-method-source:'+f.source.artifactId+':v1]';f.state.messageKind='model'
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input),{code:'teloa/forbidden'})
 f.state.messageKind='user'
 await assert.rejects(f.service.prepareMethodReuse(f.owner,{...input,acceptedSource:{...f.acceptedSource,messageSeq:4}}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.prepareMethodReuse('other-owner',input),{code:'teloa/forbidden'})
 await assert.rejects(f.service.prepareMethodReuse(f.owner,{...input,source:{...f.source,basisHash:'f'.repeat(64)}}),{code:'teloa/version-conflict'})
 await f.artifacts.revise(f.owner,{artifactId:f.source.artifactId,expectedVersion:1,source:f.artifact.source,content:{...f.artifact.content,note:'本人后继修订'}})
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input),{code:'teloa/version-conflict'})
 assert.equal(f.state.generated,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_drafts where owner_id=$1',[f.owner])).rows[0].n,0)
})

test('取消或准备期间来源撤回不留草稿，后继采用须再核原固定来源',async()=>{
 const f=await fixture(),input={requestId:f.requestId,source:f.source,acceptedSource:f.acceptedSource,target:'skill' as const},controller=new AbortController()
 f.state.onBody=async()=>{controller.abort()}
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input,controller.signal))
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_drafts where owner_id=$1',[f.owner])).rows[0].n,0)
 f.state.onBody=async()=>{f.state.available=false}
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input),{code:'teloa/version-conflict'})
 f.state.available=true;f.state.onBody=undefined
 const draft=await f.service.prepareMethodReuse(f.owner,input)
 await f.service.assertDraftCurrent(f.owner,{draftId:draft.id,bodyHash:draft.bodyHash})
 f.state.available=false
 await assert.rejects(f.service.assertDraftCurrent(f.owner,{draftId:draft.id,bodyHash:draft.bodyHash}),{code:'teloa/version-conflict'})
})

test('原人工结项的固定成果可复用，合法完成版本不误拒；自动verifiedCompletion不冒人工认可',async()=>{
 assert.ok(reuse)
 for(const automatic of [false,true]){
  const owner='local:'+randomUUID(),tasks=new TaskService(pool,identity),transitions=new TaskTransitions(pool,identity)
  const initial=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'验收来源',goal:'核对本人材料',scope:'general'}})
  const running=await transitions.change(owner,{taskId:initial.id,requestId:randomUUID(),expectedVersion:1,action:'start'})
  const original=await taskArtifactSource(pool,owner,running.id,false)
  const artifacts=new ArtifactService(pool,identity,async()=>({source:original,sessionIds:[]}))
  const artifact=await artifacts.create(owner,{requestId:randomUUID(),source:original,content:{title:'认可来源',sections:[{id:'one',title:'核对步骤',text:'先读输入，核对依据，缺资料停下。'}],snapshotIds:[],note:'合成验收记录'}})
  const command={taskId:running.id,requestId:randomUUID(),expectedVersion:running.version,action:'complete',artifact:{id:artifact.artifactId,version:artifact.number},note:'本人核验通过'}
  if(automatic){const db=await pool.connect();try{await db.query('begin');await transitions.changeInTransaction(db,owner,command,{candidate:{},policy:{},receiptIds:[]});await db.query('commit')}finally{db.release()}}
  else await transitions.change(owner,command)
  const drafts=new PageCreateDraftService(pool,identity,{skill:readPageCreateAtomicSkillDraft})
  const service:MethodReuseService=new reuse.MethodReuseService(pool,identity,{artifacts,drafts,assertSourceCurrent:async()=>{throw Error('合法结项不按旧Task版本误拒')},readAcceptedMessage:async()=>{throw Error('人工认可不要求伪造普通消息')},prepareBody:async()=>body()})
  const {source}=await service.readSource(owner,{artifactId:artifact.artifactId})
  assert.equal(source.taskId,running.id)
  const input={requestId:randomUUID(),source,target:'skill' as const}
  const db=await pool.connect()
  try{
   await db.query('begin')
   if(automatic)await assert.rejects(service.assertPlanSourceInTransaction(db,owner,{source}),{code:'teloa/forbidden'})
   else assert.deepEqual(await service.assertPlanSourceInTransaction(db,owner,{source}),{intent:'save-paused'})
   await db.query('rollback')
  }finally{db.release()}
  if(automatic)await assert.rejects(service.prepareMethodReuse(owner,input),{code:'teloa/forbidden'})
  else{const draft=await service.prepareMethodReuse(owner,input);assert.equal(draft.status,'draft');assert.equal(draft.entity,'skill')}
 }
})

test('明确固定引用阻止模型换另一份本人成果，只有保存意图不能伪造启用',async()=>{
 const f=await fixture(),input={requestId:f.requestId,source:f.source,acceptedSource:f.acceptedSource,target:'skill' as const}
 f.state.text='将这份成果保存为方法。'
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input),{code:'teloa/forbidden'})
 f.state.text='将这份成果保存为方法。\n[teloa-method-source:'+randomUUID()+':v1]'
 await assert.rejects(f.service.prepareMethodReuse(f.owner,input),{code:'teloa/forbidden'})
 assert.equal(f.state.generated,0)
 const schedule={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
 const work={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:9,maxTokens:65536,maxElapsedMs:300000,maxConcurrent:1,maxRetries:1,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const plan={definition:{title:'可信核对计划',goal:'按认可方法整理本人提供的资料',scope:'general',dataScope:'本人指定材料',delivery:'核对报告',roleId:null,executor:{kind:'owner'},trigger:schedule,notificationPolicy:'attention'},work,source:f.source,intent:'create-and-enable'}
 const service:MethodReuseService=new reuse!.MethodReuseService(pool,identity,{artifacts:f.artifacts,drafts:f.drafts,assertSourceCurrent:async()=>{},readAcceptedMessage:async()=>({...f.acceptedSource,ownerId:f.owner,source:{kind:'user',rpcId:f.acceptedSource.requestId},text:f.state.text}),prepareBody:async()=>plan})
 const planInput={...input,target:'plan' as const}
 f.state.text='将这份成果保存为计划，不要启用。\n[teloa-method-source:'+f.source.artifactId+':v1]'
 await assert.rejects(service.prepareMethodReuse(f.owner,planInput),{code:'teloa/forbidden'})
 f.state.text='将这份成果保存为计划，并启用。\n[teloa-method-source:'+f.source.artifactId+':v1]'
 const draft=await service.prepareMethodReuse(f.owner,planInput)
 assert.equal(draft.entity,'plan');assert.equal(draft.status,'draft');assert.equal(draft.appliedRef,undefined)
 const preview=await new PageCreatePreviewService(pool,identity,f.drafts).preview({ownerId:f.owner,scopeIds:[]},{draftId:draft.id})
 assert.equal(preview.next.endpoint,'plans/create-owner-confirmed');assert.deepEqual(preview.next.consentKeys,['create.consequence.permission'])
 assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
})

test('plan旧entity约束原地升级保留原技能草稿，配置预览只指向本人原确认入口',async()=>{
 const f=await fixture(),owner={ownerId:f.owner,scopeIds:[]},skill=await f.drafts.draft(owner,{entity:'skill',body:body(),requestId:randomUUID()})
 const schedule={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}
 const work={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule}],budget:{maxGoalRounds:9,maxTokens:65536,maxElapsedMs:300000,maxConcurrent:1,maxRetries:1,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}
 const input={entity:'plan' as const,requestId:randomUUID(),body:{kind:'configure-work',planId:randomUUID(),expectedVersion:2,expectedConfigVersion:1,work}}
 await pool.query("alter table teloa_page_create_drafts drop constraint teloa_page_create_drafts_entity_check, add constraint teloa_page_create_drafts_entity_check check(entity in ('business-definition','business-domain','role','skill','connector','extension','share')) not valid")
 await assert.rejects(f.drafts.draft(owner,input),{code:'23514'})
 await initializePageCreateDrafts(pool)
 assert.deepEqual(await f.drafts.read(owner,{draftId:skill.id}),skill)
 const draft=await f.drafts.draft(owner,input)
 assert.equal(JSON.parse(draft.body).intent,'save-paused')
 const preview=await new PageCreatePreviewService(pool,identity,f.drafts).preview(owner,{draftId:draft.id})
 assert.equal(preview.next.endpoint,'plans/configure-work-confirmed');assert.deepEqual(preview.next.consentKeys,[])
 assert.equal((await f.drafts.directory(owner,{entity:'plan'})).drafts.length,1)
})

test('未结项Task只读来源复用正式共享锁，不因read-only事务误拒也不推进任务',async()=>{
 assert.ok(reuse)
 const owner='local:'+randomUUID(),tasks=new TaskService(pool,identity),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'尚未结项来源',goal:'先查看已保存成果',scope:'general'}})
 const original=await taskArtifactSource(pool,owner,task.id,false),artifacts=new ArtifactService(pool,identity,async()=>({source:original,sessionIds:[]})),drafts=new PageCreateDraftService(pool,identity,{skill:readPageCreateAtomicSkillDraft})
 const artifact=await artifacts.create(owner,{requestId:randomUUID(),source:original,content:{title:'中间成果',sections:[{id:'one',title:'内容',text:'仅供本人查看，不宣称认可。'}],snapshotIds:[],note:'合成只读例'}})
 const before=(await tasks.list(owner,{})).find(item=>item.id===task.id)
 const service:MethodReuseService=new reuse.MethodReuseService(pool,identity,{artifacts,drafts,assertSourceCurrent:async(db,who,saved)=>{assert.deepEqual(await taskArtifactSource(db,who,saved.source.id,true),saved.source)},readAcceptedMessage:async()=>{throw Error('只读不需要认可消息')},prepareBody:async()=>{throw Error('只读不生成草稿')}})
 const read=await service.readSource(owner,{artifactId:artifact.artifactId})
 assert.equal(read.source.version,1);assert.equal(read.artifact.artifactId,artifact.artifactId)
 assert.deepEqual((await tasks.list(owner,{})).find(item=>item.id===task.id),before)
 assert.equal((await drafts.directory({ownerId:owner,scopeIds:[]},{entity:'skill'})).drafts.length,0)
})

test('正式续改v2按真实producer Task认可复用，保原归属及v1历史，不能猜另一普通Task',async()=>{
 assert.ok(reuse)
 const owner='local:'+randomUUID(),tasks=new TaskService(pool,identity),transitions=new TaskTransitions(pool,identity)
 const created=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'原成果任务',goal:'保留原工作目标',scope:'general'}})
 const original=await transitions.change(owner,{taskId:created.id,requestId:randomUUID(),expectedVersion:1,action:'start'})
 const source=await taskArtifactSource(pool,owner,original.id,false),artifacts=new ArtifactService(pool,identity,async(who,expected,db)=>({source:await taskArtifactSource(db,who,expected.id,true),sessionIds:[]}))
 const v1=await artifacts.create(owner,{requestId:randomUUID(),source,content:{title:'有历史的成果',sections:[{id:'a',title:'续改部分',text:'原来的工作步骤'},{id:'b',title:'保留部分',text:'本人未改的边界'}],snapshotIds:[],note:'初版成果'}})
 await transitions.change(owner,{taskId:original.id,requestId:randomUUID(),expectedVersion:2,action:'complete',artifact:{id:v1.artifactId,version:1},note:'认可初版'})
 const feedback=await new ArtifactFeedbackService(pool,identity).add(owner,{requestId:randomUUID(),artifactId:v1.artifactId,version:1,sectionId:'a',text:'补足原输入核对步骤',source})
 const accepted={sessionId:'revision-'+randomUUID(),messageId:'accepted-revision',messageSeq:1,requestId:randomUUID()},revisions=new ArtifactRevisionRequestService(pool,identity.now)
 const revision=await revisions.request(owner,{requestId:randomUUID(),artifactId:v1.artifactId,baseVersion:1,feedbackId:feedback.id,sessionId:accepted.sessionId}),sourceText='按本人反馈续改 [teloa-revision:'+revision.id+']'
 await revisions.bindSource(owner,{...accepted,sourceText},'general')
 await new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId:accepted.sessionId,status:'ready',submitted:true}),undefined,undefined,pool).reserve(owner,{...accepted,sourceText,kind:'task',executor:'general',scope:'general',title:'后续修订',goal:'修订原成果指定段落'})
 const producer=await tasks.createForConversation(owner,{sessionId:accepted.sessionId,requestId:accepted.requestId,executor:'general'}),sessionId='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async(who:string,id:string)=>({id:conversationId,ownerId:who,sessionId:id,status:'ready' as const})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:producer.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepareOwner(owner,{requestId:randomUUID(),taskId:producer.id,expectedTaskVersion:1,executor:producer.executor,sessionId,expectedLinkVersion:1},{agentPresetId:'teloa-standard'})
 await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:2,reason:'completed'}})
 await artifacts.reviseFromRequest(owner,{revisionId:revision.id,runId:run.id,text:'先核对原输入，再逐项整理依据；缺少材料停下，外发前确认。'},async(db,id)=>{await runs.executionScopeInTransaction(db,owner,{runId:id,mode:'completion'});return {assertCurrent:()=>{}}})
 const versions=await artifacts.list(owner,{artifactId:v1.artifactId})
 assert.equal(versions[0]?.content.sections[0]?.text,'原来的工作步骤');assert.deepEqual(versions[1]?.source,v1.source)
 await transitions.change(owner,{taskId:producer.id,requestId:randomUUID(),expectedVersion:3,action:'complete',artifact:{id:v1.artifactId,version:2},note:'本人认可后续修订'})
 const drafts=new PageCreateDraftService(pool,identity,{skill:readPageCreateAtomicSkillDraft}),service:MethodReuseService=new reuse.MethodReuseService(pool,identity,{artifacts,drafts,assertSourceCurrent:async()=>{throw Error('正式producer不能误按已完成旧任务来源拒绝')},readAcceptedMessage:async()=>{throw Error('人工认可无需伪造消息')},prepareBody:async()=>body()})
 const read=await service.readSource(owner,{artifactId:v1.artifactId})
 assert.equal(read.source.version,2);assert.equal(read.source.taskId,producer.id);assert.deepEqual(read.artifact.source,v1.source)
 const method=await service.prepareMethodReuse(owner,{requestId:randomUUID(),source:read.source,target:'skill'})
 assert.equal(method.status,'draft')
 await assert.rejects(service.prepareMethodReuse(owner,{requestId:randomUUID(),source:{...read.source,taskId:original.id},target:'skill'}),{code:'teloa/forbidden'})
})

test('计划后续来源在调用方同一事务核验，不另取连接或把来源检查当执行授权',async()=>{
 assert.ok(reuse)
 const f=await fixture();f.state.text='将这份成果保存为计划，默认暂停。\n[teloa-method-source:'+f.source.artifactId+':v1]'
 let extraConnections=0
 const guardedPool={connect:async()=>{extraConnections++;throw Error('已有db的来源检查不得再占pool连接')}} as unknown as Pool
 const service:MethodReuseService=new reuse.MethodReuseService(guardedPool,identity,f.service.ports),db=await pool.connect()
 try{
  await db.query('begin')
  const transaction=(await db.query('select txid_current() as id')).rows[0].id
  const source={source:f.source,acceptedSource:f.acceptedSource}
  assert.deepEqual(await service.assertPlanSourceInTransaction(db,f.owner,source),{intent:'save-paused'})
  assert.equal((await db.query('select txid_current() as id')).rows[0].id,transaction)
  assert.equal(extraConnections,0);assert.equal(f.state.generated,0)
  assert.equal((await db.query('select count(*)::int n from teloa_method_reuse_requests where owner_id=$1',[f.owner])).rows[0].n,0)
  f.state.text='将这份成果保存为方法。\n[teloa-method-source:'+f.source.artifactId+':v1]'
  await assert.rejects(service.assertPlanSourceInTransaction(db,f.owner,source),{code:'teloa/forbidden'})
  f.state.text='将这份成果保存为计划。\n[teloa-method-source:'+f.source.artifactId+':v1]';f.state.available=false
  await assert.rejects(service.assertPlanSourceInTransaction(db,f.owner,source),{code:'teloa/version-conflict'})
 }finally{await db.query('rollback');db.release()}
})

test('原方法草稿的本人续改与来源账本同事务更新，保留原认可和旧正文且仍可合法采用',async()=>{
 const f=await fixture(),draft=await f.service.prepareMethodReuse(f.owner,{requestId:f.requestId,source:f.source,acceptedSource:f.acceptedSource,target:'skill'}),prior=(await pool.query('select * from teloa_method_reuse_requests where owner_id=$1',[f.owner])).rows[0]
 // 旧方法原稿没有 origin_source 时仍从已可信的原方法账本恢复会话。
 await pool.query('update teloa_page_create_drafts set origin_source=null where owner_id=$1 and id=$2',[f.owner,draft.id])
 assert.equal((await f.drafts.origin({ownerId:f.owner,scopeIds:[]},{draftId:draft.id,expectedBodyHash:draft.bodyHash})).sessionId,f.acceptedSource.sessionId)
 const changed={...body(),title:'修订后的可信核对方法'},input={draftId:draft.id,expectedBodyHash:draft.bodyHash,entity:'skill' as const,body:changed,requestId:randomUUID(),acceptedSource:{...f.acceptedSource,messageId:'next-native-message',messageSeq:6,requestId:randomUUID()}}
 const guard={assertCurrent:async()=>{},method:(db:PoolClient,current:typeof draft,value:unknown,hash:string,restoring:boolean)=>f.service.reviseDraftInTransaction(db,f.owner,current,value,hash,undefined,restoring)}
 const next=await f.drafts.revise({ownerId:f.owner,scopeIds:[]},input,guard),after=(await pool.query('select * from teloa_method_reuse_requests where owner_id=$1',[f.owner])).rows[0]
 assert.deepEqual(after.request_spec,prior.request_spec);assert.deepEqual(after.acceptance,prior.acceptance);assert.equal(after.draft_id,draft.id);assert.equal(after.body_hash,next.bodyHash);assert.notEqual(next.bodyHash,draft.bodyHash)
 const authority=await f.service.assertDraftCurrent(f.owner,{draftId:draft.id,bodyHash:next.bodyHash});assert.deepEqual(authority?.source,f.source);assert.equal(authority?.intent,'save-paused')
 const ledgerBeforeRestore=(await pool.query('select xmin::text as transaction,* from teloa_method_reuse_requests where owner_id=$1',[f.owner])).rows
 assert.deepEqual(await f.drafts.revise({ownerId:f.owner,scopeIds:[]},input,guard),next)
 assert.deepEqual((await pool.query('select xmin::text as transaction,* from teloa_method_reuse_requests where owner_id=$1',[f.owner])).rows,ledgerBeforeRestore,'同一调用丢响应恢复不能重写来源账本')
 await assert.rejects(f.service.assertDraftCurrent(f.owner,{draftId:draft.id,bodyHash:draft.bodyHash}),{code:'teloa/version-conflict'})
 f.state.available=false
 await assert.rejects(f.drafts.revise({ownerId:f.owner,scopeIds:[]},input,guard),{code:'teloa/version-conflict'})
 await assert.rejects(f.drafts.revise({ownerId:f.owner,scopeIds:[]},{...input,expectedBodyHash:next.bodyHash,requestId:randomUUID(),body:{...changed,title:'撤权后不得保存'}},guard),{code:'teloa/version-conflict'})
 assert.equal((await f.drafts.read({ownerId:f.owner,scopeIds:[]},{draftId:draft.id})).bodyHash,next.bodyHash)
 assert.equal((await pool.query('select count(*)::int n from teloa_page_create_draft_revisions where owner_id=$1',[f.owner])).rows[0].n,1)
})
