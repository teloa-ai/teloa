import {initializeGroupRoutingDecisions} from '../src/work/group-routing-decisions.ts'
import {initializeGroupRoutingOutbox} from '../src/work/group-routing-outbox.ts'
import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAttachments} from '../src/work/group-attachments.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {readRunGroupContext,type RunGroupContext} from '../src/work/task-run-group-context.ts'
import {groupTopicNotice,readRunGroupTopic,readGroupConversationTopic,groupTopicTextMaxChars,groupRoutingTopicTextMaxChars} from '../src/work/group-topic.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {GroupWorkInputService,initializeGroupWorkInputs,readGroupWorkContinuation} from '../src/work/group-work-inputs.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
// 逐条消息的时刻必须递增，话题的升序与「取尾部二十条」才有确定答案。
let clock=Date.parse('2026-09-21T09:00:00.000Z')
const identity={id:randomUUID,now:()=>new Date(clock+=1000).toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeGroupTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeGroupAttachments(pool)
 await initializeGroupWorkInputs(pool)
 await initializeGroupRoutingDecisions(pool);await initializeGroupRoutingOutbox(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

/** 群、在岗同事、话题根、群任务、授权与一次已准备的运行；`run.groupContext` 就是话题投影的入参。 */
async function fixture(routed=false){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'soc-analyst'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'SOC 研判群',scope:'SOC',announcement:'仅使用已固定资料。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请分析 alert-001 的影响。'})
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,action:'save',resources:[],canPost:true,canAutoRun:routed})
 const created=await new GroupTaskService(pool,identity,tasks).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:root.id,expectedGroupVersion:group.version,goal:'给出可审计的研判结论。',assignee:{roleId:role.id,expectedVersion:2},...(routed?{trigger:'routed',executionMode:'work',routingAttemptVersion:1}:{})})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole)=>readRunGroupContext(db,actor,task,currentRole),groupTopic:(db,actor,context,continuation)=>readRunGroupTopic(db,actor,context,'',groupTopicTextMaxChars,continuation)})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 if(!run.groupContext)throw Error('群运行必须带群上下文')
 return {owner,groups,group,root,role,runs,run,context:run.groupContext}
}
async function topicOf(owner:string,context:RunGroupContext,displayName?:string){
 const db=await pool.connect()
 try{return await readRunGroupTopic(db,owner,context,displayName)}finally{db.release()}
}

test('QLT003 新群话题携带真实消息身份，作者身份不充当引用，且冻结后可读回',async t=>{
 t.diagnostic(`隔离 PostgreSQL fixture ${container.getId()}`)
 const f=await fixture(),original=f.run.inputText,first=JSON.parse(original).groupTopic
 assert.equal(first.messages[0].messageId,f.root.id,'本人消息引用必须来自持久消息 id')
 assert.equal(first.messages[0].authorId,'self')
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const draft=await new GroupRunMessageService(pool,identity).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'初版：20 元 + 30 元 = 50 元。'})
 const follow=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:draft.id,text:'请引用初版消息复核金额。'})
 const later=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,text:'晚到消息不得进入此前水位。'})
 const other=await f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'另一群',scope:'SOC',announcement:'',rules:openGroupRules,memberRoleIds:[f.role.id]}})
 const foreign=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:other.id,expectedVersion:other.version,text:'外群消息不得投影。'})
 const db=await pool.connect()
 try{
  const topic=await readGroupConversationTopic(db,f.owner,{groupId:f.group.id,messageId:follow.id,replyToMessageId:draft.id,mode:'main',roleId:f.role.id})
  assert.deepEqual(topic!.messages.map(message=>message.messageId),[f.root.id,draft.id,follow.id])
  const projected=topic!.messages.find(message=>message.messageId===draft.id)!
  assert.equal(projected.authorId,f.role.id);assert.equal(projected.authorKind,'role');assert.equal(projected.text,draft.text)
  assert.notEqual(projected.messageId,projected.authorId,'真实员工回帖 id 与真实员工 roleId 分别投影')
  assert.ok(!topic!.messages.some(message=>message.messageId===later.id||message.messageId===foreign.id))
  assert.equal(await readGroupConversationTopic(db,randomUUID(),{groupId:f.group.id,messageId:follow.id,replyToMessageId:draft.id,mode:'main',roleId:null}),undefined,'换本人身份不能读原群')
 }finally{db.release()}
 assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).inputText,original,'新字段在原冻结输入中保留，不随新回帖改写')
 assert.equal((await f.runs.list(f.owner,{taskId:f.run.taskId}))[0]!.inputText,original)
})

test('群上下文使用本人资料姓名，权限身份与原消息保持不变',async()=>{
 const f=await fixture(),topic=await topicOf(f.owner,f.context,'Max Luo')
 assert.equal(topic!.messages[0]!.authorName,'Max Luo')
 assert.equal(topic!.messages[0]!.authorId,'self')
 assert.equal(topic!.messages[0]!.authorKind,'self')
 assert.equal(topic!.messages[0]!.text,f.root.text)
 assert.match(topic!.notice,/称呼/)
 const db=await pool.connect()
 try{
  const continuous=await readGroupConversationTopic(db,f.owner,{groupId:f.group.id,messageId:f.root.id,replyToMessageId:null,mode:'main',roleId:null,displayName:'Max Luo'})
  assert.equal(continuous!.messages[0]!.authorName,'Max Luo')
  assert.equal(continuous!.messages[0]!.authorId,'self')
 }finally{db.release()}
})

test('主讨论引用已交付原稿返工：新 Run 按当前本人消息读取原稿与复核，保留原 Task 来源和旧 Run',async()=>{
 const f=await fixture(true),taskId=f.run.taskId,sourceBefore=(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[taskId])).rows[0]
 assert.equal(sourceBefore.source_snapshot.schema,'teloa.group-task-source/v2')
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const draft=await new GroupRunMessageService(pool,identity).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'原初稿：A=120，B=80，C=50；合计250；客户待核实。'})
 for(let index=0;index<24;index++)await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,text:`其余交流 ${index}；不能挤掉本次精确引用的原稿。`})
 const review=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:draft.id,text:'原复核意见：金额一致，新增本人确认清单。'})
 const follow=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,replyToMessageId:draft.id,text:'请继续原任务，在原报告末补本人确认清单。'})
 assert.equal(follow.rootId,null,'与真实 UI 相同：主讨论精确引用，不伪造话题归属')
 const later=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,text:'稍后另议：金额变成999，不得进入此前返工。'})
 const version=(await pool.query('select version from teloa_tasks where id=$1',[taskId])).rows[0].version,inputs=new GroupWorkInputService(pool,identity),requestId=randomUUID(),db=await pool.connect()
 try{await inputs.reserveInTransaction(db,f.owner,{requestId,groupId:f.group.id,messageId:follow.id,taskId,expectedTaskVersion:version,operation:'continue'})}finally{db.release()}
 const continued=await inputs.continueTask(f.owner,requestId);assert.equal(continued.state,'continued')
 const run=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId,expectedTaskVersion:continued.taskVersion,roleId:f.role.id,expectedRoleVersion:2,sessionId:f.run.sessionId,expectedLinkVersion:1})
 const input=JSON.parse(run.inputText),messages=input.groupTopic.messages
 assert.ok(messages.some((message:{text:string})=>message.text===draft.text),'当前返工必须可见被引用的已交付原稿，不能仍冻结在最初交办水位')
 assert.ok(messages.some((message:{text:string})=>message.text===review.text),'当前消息之前的复核意见可见')
 assert.ok(messages.some((message:{text:string})=>message.text===follow.text))
 assert.ok(!messages.some((message:{text:string})=>message.text===later.text),'当前返工之后的消息不进入冻结上下文')
 assert.equal(input.groupContinuation.messageId,follow.id);assert.equal(input.groupContext.source.rootId,f.root.id);assert.deepEqual(input.groupContext.files,[],'引用正文不扩展附件授权')
 assert.equal(run.taskId,taskId);assert.notEqual(run.id,f.run.id)
 assert.deepEqual((await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[taskId])).rows[0],sourceBefore)
 assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).inputText,f.run.inputText,'旧 Run 输入不随追加改写')
 assert.deepEqual((await topicOf(f.owner,f.context))?.messages.map(message=>message.text),[f.root.text],'没有 continuation 仍保留原 v2 水位')
 const read=await pool.connect()
 try{
  const continuation=(await readGroupWorkContinuation(read,f.owner,taskId,continued.taskVersion))!
  await assert.rejects(readRunGroupTopic(read,f.owner,f.context,'',undefined,{...continuation,messageId:later.id,text:later.text,createdAt:later.createdAt}),{code:'teloa/forbidden'},'未登记成本任务续办的消息不能任意推进读取水位')
  await assert.rejects(readRunGroupTopic(read,f.owner,f.context,'',undefined,{...continuation,text:'篡改的本人要求'}),{code:'teloa/forbidden'})
  await assert.rejects(readRunGroupTopic(read,randomUUID(),f.context,'',undefined,continuation),{code:'teloa/forbidden'})
  const otherGroup=await f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'其他群',scope:'SOC',announcement:'',rules:openGroupRules,memberRoleIds:[f.role.id]}})
  const foreign=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:otherGroup.id,expectedVersion:otherGroup.version,text:'另一个群的内容不属于原任务。'})
  await assert.rejects(readRunGroupTopic(read,f.owner,f.context,'',undefined,{...continuation,messageId:foreign.id,text:foreign.text,createdAt:foreign.createdAt}),{code:'teloa/forbidden'})
  // 同一选择器仍过滤入群前不可见的引用；只给当前本人消息，不因 replyTo 读回被遮蔽的原稿。
  await pool.query("update teloa_groups set definition=jsonb_set(definition,'{rules,historyVisibleToNewMembers}','false'::jsonb) where owner_id=$1 and id=$2",[f.owner,f.group.id])
  await pool.query('update teloa_group_members set created_at=$4 where owner_id=$1 and group_id=$2 and role_id=$3',[f.owner,f.group.id,f.role.id,follow.createdAt])
  const restricted=await readRunGroupTopic(read,f.owner,f.context,'',undefined,continuation)
  assert.deepEqual(restricted?.messages.map(message=>message.text),[follow.text],'不可见引用和之后消息都不进入当前上下文')
 }finally{read.release()}
})

test('话题为空时返回 undefined（整个键不进 JSON）',async()=>{
 const f=await fixture()
 assert.equal(await topicOf(f.owner,{...f.context,source:{...f.context.source,rootId:randomUUID()}}),undefined)
})

test('至多二十条、升序、每项恰六键、notice 逐字',async()=>{
 const f=await fixture()
 for(let index=1;index<=24;index++)await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:`补充第 ${index} 条。`})
 const topic=await topicOf(f.owner,f.context)
 assert.equal(topic?.notice,groupTopicNotice)
 assert.equal(topic?.messages.length,20)
 for(const message of topic!.messages)assert.deepEqual(Object.keys(message).sort(),['authorId','authorKind','authorName','createdAt','messageId','text'])
 const stamps=topic!.messages.map(message=>message.createdAt)
 assert.deepEqual(stamps,[...stamps].sort())
 // 尾部二十条：话题共 25 条，最早的根与随后四条被截掉。
 assert.equal(topic!.messages[0]!.text,'补充第 5 条。')
 assert.equal(topic!.messages.at(-1)!.text,'补充第 24 条。')
})

test('GRP-03 执行上下文不再静默截断：1500 字原样保留，超预算时带显式截断提示',async()=>{
 const f=await fixture()
 await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'长'.repeat(1500)})
 const medium=await topicOf(f.owner,f.context)
 assert.equal(medium!.messages.at(-1)!.text,'长'.repeat(1500),'执行侧上游长正文应完整保留，供后序交叉核对')
 const long='超'.repeat(5000)
 await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:long})
 const topic=await topicOf(f.owner,f.context)
 const last=topic!.messages.at(-1)!
 assert.ok(last.text.length<=groupTopicTextMaxChars,'截断后连同提示仍须守住同一预算')
 assert.match(last.text,/正文被截断：全文 5000 字符/)
 assert.match(last.text,/完整正文请在原群消息中核对/)
})

test('GRP-03 路由选人面用更小预算，但截断同样显式提示',async()=>{
 const f=await fixture()
 const long=await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'核'.repeat(1600)})
 const db=await pool.connect()
 try{
  const routingView=await readGroupConversationTopic(db,f.owner,{groupId:f.group.id,messageId:long.id,replyToMessageId:null,mode:'main',roleId:null,textMaxChars:groupRoutingTopicTextMaxChars})
  const last=routingView!.messages.at(-1)!
  assert.ok(last.text.length<=groupRoutingTopicTextMaxChars)
  assert.match(last.text,/正文被截断：全文 1600 字符/)
 }finally{db.release()}
})

test('同事消息的 authorKind 是 role、authorId 是 roleId',async()=>{
 const f=await fixture()
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 await new GroupRunMessageService(pool,identity).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'已完成初步研判。'})
 const topic=await topicOf(f.owner,f.context)
 const reply=topic!.messages.find(message=>message.authorKind==='role')
 assert.equal(reply?.authorId,f.role.id)
 assert.equal(reply?.authorName,'SOC 研判员')
 assert.equal(reply?.text,'已完成初步研判。')
 assert.equal(topic!.messages[0]!.authorKind,'self')
 assert.equal(topic!.messages[0]!.authorId,'self')
})
