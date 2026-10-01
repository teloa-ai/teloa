import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {type MessageReference} from '@teloa/contract'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupAttachmentService,initializeGroupAttachments} from '../src/work/group-attachments.ts'
import {artifactVersion as artifactVersionRow,attachmentPorts,uploadFile} from './group-attachment-test-fixture.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {groupTaskSourceDigest} from '../src/work/group-task-source-digest.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {groupRoutedTaskGoal} from '../src/work/group-routing-text.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-21T09:00:00.000Z').toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeGroupTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeGroupAttachments(pool)
})
after(async()=>{await pool?.end();await container?.stop()})

/** 造出一条真实的数字员工回帖：建群 → 本人发话题 → 转任务 → 授权 → 运行结束 → 员工回传。 */
async function employeeReply(goal='给出可审计的研判结论。'){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const groupTasks=new GroupTaskService(pool,identity,tasks)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'soc-analyst'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'SOC 研判群',scope:'SOC',announcement:'仅使用已固定资料。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'EDR 告警证据',markdown:'# alert-001\n\n进程树与主机证据。'})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请分析 alert-001 的影响。',references:[{kind:'group-resource',id:resource.id,version:resource.version}]})
 const taskRequest={requestId:randomUUID(),groupId:group.id,messageId:root.id,expectedGroupVersion:group.version,goal,assignee:{roleId:role.id,expectedVersion:2}}
 const created=await groupTasks.create(owner,taskRequest)
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,action:'save',resources:[{kind:'group-resource',id:resource.id,version:resource.version}],canPost:true,canAutoRun:false})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole)=>import('../src/work/task-run-group-context.ts').then(({readRunGroupContext})=>readRunGroupContext(db,actor,task,currentRole))})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:run.id})
 await runs.record(owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const reply=await new GroupRunMessageService(pool,identity).post(owner,{requestId:randomUUID(),runId:run.id,text:'已完成初步研判：需要核对父进程与横向连接。'})
 return {owner,group,root,role,reply,groupTasks,created,run,taskRequest}
}

test('更新默认群回复目标后，旧目标仍可领取和回帖；同请求重试不改历史或重复建任务',async()=>{
 const legacyGoal='在群里回应这条消息。只做回答与说明；不新建任务、不推进任何任务状态、不做需要审批的动作。'
 assert.notEqual(groupRoutedTaskGoal,legacyGoal)
 const f=await employeeReply(legacyGoal)
 assert.equal(f.created.task.goal,legacyGoal)
 assert.equal(JSON.parse(f.run.inputText).task.goal,legacyGoal)
 assert.ok('taskId' in f.reply)
 assert.equal(f.reply.taskId,f.created.task.id)
 const retry=await f.groupTasks.create(f.owner,f.taskRequest)
 assert.equal(retry.task.id,f.created.task.id)
 assert.equal(retry.task.goal,legacyGoal)
 assert.deepEqual(retry.source,f.created.source)
 await assert.rejects(f.groupTasks.create(f.owner,{...f.taskRequest,goal:groupRoutedTaskGoal}),{code:'teloa/conflict'})
 const counts=(await pool.query('select (select count(*) from teloa_tasks where owner_id=$1)::int as tasks,(select count(*) from teloa_task_runs where owner_id=$1)::int as runs',[f.owner])).rows[0]
 assert.deepEqual(counts,{tasks:1,runs:1})
})

test('数字员工回帖可以直接转成下一跳群任务，来源固定在同一话题根',async()=>{
 const f=await employeeReply()
 assert.notEqual(f.reply.authorId,'self')
 const created=await f.groupTasks.create(f.owner,{requestId:randomUUID(),groupId:f.group.id,messageId:f.reply.id,expectedGroupVersion:f.group.version,goal:'接着核对父进程与横向连接。',assignee:{roleId:f.role.id,expectedVersion:2}})
 assert.equal(created.source.messageId,f.reply.id)
 assert.equal(created.source.rootId,f.root.id)
 assert.equal(created.source.messageText,f.reply.text)
 assert.equal(created.source.groupVersion,f.group.version)
 assert.deepEqual(created.source.createdAssignee,{roleId:f.role.id,roleVersion:2})
 assert.deepEqual(await f.groupTasks.source(f.owner,{taskId:created.task.id}),created.source)
})

/** 本文件里 `artifactVersion` 固定用同一个测试时钟；夹具本体在 `group-attachment-test-fixture.ts`。 */
const artifactVersion=(owner:string)=>artifactVersionRow(pool,owner,identity.now())

/** 建群 → 本人发一条话题消息，供触发来源用例复用；不涉及数字员工回帖。 */
async function humanTopic(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity)
 const groupTasks=new GroupTaskService(pool,identity,tasks)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'触发来源群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请研判此告警。'})
 return {owner,groups,group,message,groupTasks}
}

test('触发来源缺省为 manual，显式传 mention 时写入，且不推进任务或消息状态、不产生运行',async()=>{
 const {owner,group,message,groupTasks}=await humanTopic()
 const manual=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'默认触发来源。'})
 assert.equal(manual.source.trigger,'manual')
 assert.equal(manual.task.state,'ready')
 const manualRow=(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[manual.task.id])).rows[0]
 assert.equal(Object.keys(manualRow.source_snapshot).length,13)
 assert.equal(manualRow.snapshot_digest,groupTaskSourceDigest(manual.source))
 const mentioned=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'由提及触发。',trigger:'mention'})
 assert.equal(mentioned.source.trigger,'mention')
 assert.equal(mentioned.task.state,'ready')
 assert.equal((await pool.query('select author_id from teloa_group_messages where id=$1',[message.id])).rows[0].author_id,'self')
 assert.equal((await pool.query('select count(*)::int as n from teloa_task_runs where task_id in ($1,$2)',[manual.task.id,mentioned.task.id])).rows[0].n,0)
})

test('触发来源 routed 写进来源快照与请求指纹；老行仍回落 manual，摘要逐字不含 trigger（链 A）',async()=>{
 const {owner,group,message,groupTasks}=await humanTopic()
 const routed=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'由群内路由触发。',trigger:'routed'})
 assert.equal(routed.source.trigger,'routed')
 assert.equal(Object.keys(routed.source).length,13)
 assert.equal((await groupTasks.source(owner,{taskId:routed.task.id}))?.trigger,'routed')
 // ② 'routed' 与 'mention' 同样进请求指纹，只有缺省的 'manual' 不进（`requestSpec` 的既有分支不改）。
 const manual=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'默认触发来源。'})
 const specOf=async(taskId:string)=>(await pool.query('select request_spec from teloa_group_task_sources where task_id=$1',[taskId])).rows[0].request_spec
 assert.equal((await specOf(routed.task.id)).trigger,'routed')
 assert.equal('trigger' in await specOf(manual.task.id),false)
 // ① 老行（12 键、无 trigger）仍按 manual 回落，扩位不改老行读法。
 await pool.query("update teloa_group_task_sources set source_snapshot=source_snapshot-'trigger' where task_id=$1",[routed.task.id])
 assert.equal((await groupTasks.source(owner,{taskId:routed.task.id}))?.trigger,'manual')
 // ③ 同一条历史行的摘要逐字不变：固定字段序列本就不含 trigger（`group-task-source-digest.ts:5-13` 零改动）。
 const stored=(await pool.query('select snapshot_digest from teloa_group_task_sources where task_id=$1',[routed.task.id])).rows[0].snapshot_digest
 assert.equal(stored,groupTaskSourceDigest(routed.source))
 assert.equal(stored,groupTaskSourceDigest({...routed.source,trigger:'manual'}))
 assert.equal(stored,groupTaskSourceDigest({...routed.source,trigger:'mention'}))
})

test('群成员业务范围不限（2026-09-21 用户裁定 B）；建群任务时负责人不支持群范围仍被任务层拦下，支持范围的负责人正常建任务',async()=>{
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity)
 const groupTasks=new GroupTaskService(pool,identity,tasks)
 const socRole=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const appsecRole=await roles.create(owner,{requestId:randomUUID(),fields:{name:'AppSec 复核员',kind:'employee',scopes:['AppSec'],duty:'复核应用安全工单',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 // 群成员不限业务范围：只支持 AppSec 的岗位也能加入 SOC 群。
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'混合成员群',scope:'SOC',announcement:'固定范围。',rules:openGroupRules,memberRoleIds:[socRole.id,appsecRole.id]}})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请研判此告警。'})
 await assert.rejects(groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'指派给不支持范围的负责人。',assignee:{roleId:appsecRole.id,expectedVersion:appsecRole.version}}),{code:'teloa/forbidden'})
 const created=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'指派给支持范围的负责人。',assignee:{roleId:socRole.id,expectedVersion:socRole.version}})
 assert.equal(created.task.assigneeRoleId,socRole.id)
})

test('同一请求换触发来源判为冲突；老快照行（12 键、无 trigger）仍可读出且按 manual 补齐',async()=>{
 const {owner,group,message,groupTasks}=await humanTopic()
 const requestId=randomUUID()
 const base={requestId,groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'固定目标。'}
 const created=await groupTasks.create(owner,base)
 assert.equal(created.source.trigger,'manual')
 await assert.rejects(groupTasks.create(owner,{...base,trigger:'mention'}),{code:'teloa/conflict'})
 await pool.query("update teloa_group_task_sources set source_snapshot=source_snapshot-'trigger' where task_id=$1",[created.task.id])
 const reread=await groupTasks.source(owner,{taskId:created.task.id})
 assert.equal(reread?.trigger,'manual')
 assert.equal(Object.keys(reread as object).length,13)
})

test('从引用三类原件的消息建任务：来源引用一致、键数仍 13、摘要对得上',async()=>{
 const {owner,groups,group,groupTasks}=await humanTopic()
 const attachments=new GroupAttachmentService(pool,identity,attachmentPorts())
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'三类原件资料',markdown:'# 资料\n\n固定线索。'})
 const attachment=await uploadFile(attachments,owner,group.id,group.version,'任务来源原件。')
 const artifactId=await artifactVersion(owner)
 const references:MessageReference[]=[
  {kind:'group-resource',id:resource.id,version:resource.version},
  {kind:'attachment',id:attachment.attachmentId,version:1},
  {kind:'artifact',id:artifactId,version:1}
 ]
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请核对这三件原件。',references})
 const created=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'核对三件原件。'})
 assert.deepEqual(created.source.references,references)
 const row=(await pool.query('select source_snapshot,snapshot_digest from teloa_group_task_sources where task_id=$1',[created.task.id])).rows[0]
 assert.equal(Object.keys(row.source_snapshot).length,13)
 assert.equal(row.snapshot_digest,groupTaskSourceDigest(created.source))
 assert.deepEqual(await groupTasks.source(owner,{taskId:created.task.id}),created.source)
})

test('老任务来源行的 snapshot_digest 在引用升级后逐字不变，旧二元组引用读回按群资料归一化',async()=>{
 const {owner,groups,group,groupTasks}=await humanTopic()
 const resource=await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'历史资料',markdown:'# 历史\n\n固定线索。'})
 const message=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'历史话题。',references:[{kind:'group-resource',id:resource.id,version:resource.version}]})
 const created=await groupTasks.create(owner,{requestId:randomUUID(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'历史目标。'})
 const source=created.source
 const stored=(await pool.query('select snapshot_digest from teloa_group_task_sources where task_id=$1',[created.task.id])).rows[0].snapshot_digest
 // 本期之前的摘要算法逐字重写：每条引用投影成 [resourceId,resourceVersion] 二元组。
 const legacyReferences=source.references.map(reference=>({resourceId:reference.id,resourceVersion:reference.version}))
 const legacyDigest=createHash('sha256').update(JSON.stringify([
  source.schema,source.taskId,source.ownerId,source.groupId,source.groupVersion,
  source.messageId,source.rootId,source.messageCreatedAt,source.messageText,
  legacyReferences.map(reference=>[reference.resourceId,reference.resourceVersion]),
  source.createdAssignee&&[source.createdAssignee.roleId,source.createdAssignee.roleVersion],source.createdAt,
 ])).digest('hex')
 assert.equal(stored,legacyDigest)
 // 13 键的老行（有 trigger、旧引用形状）仍可读出，摘要仍然对得上。
 const legacyThirteen={...source,references:legacyReferences}
 await pool.query('update teloa_group_task_sources set source_snapshot=$2::jsonb where task_id=$1',[created.task.id,JSON.stringify(legacyThirteen)])
 assert.deepEqual(await groupTasks.source(owner,{taskId:created.task.id}),source)
 // 12 键的更老的行（无 trigger、旧引用形状）同理。
 const {trigger:_trigger,...legacyTwelve}=legacyThirteen
 await pool.query('update teloa_group_task_sources set source_snapshot=$2::jsonb where task_id=$1',[created.task.id,JSON.stringify(legacyTwelve)])
 assert.deepEqual(await groupTasks.source(owner,{taskId:created.task.id}),source)
})
