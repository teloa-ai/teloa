import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
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
import {groupTopicNotice,readRunGroupTopic} from '../src/work/group-topic.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
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
})
after(async()=>{await pool?.end();await container?.stop()})

/** 群、在岗同事、话题根、群任务、授权与一次已准备的运行；`run.groupContext` 就是话题投影的入参。 */
async function fixture(){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'soc-analyst'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'SOC 研判群',scope:'SOC',announcement:'仅使用已固定资料。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请分析 alert-001 的影响。'})
 const created=await new GroupTaskService(pool,identity,tasks).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:root.id,expectedGroupVersion:group.version,goal:'给出可审计的研判结论。',assignee:{roleId:role.id,expectedVersion:2}})
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,action:'save',resources:[],canPost:true,canAutoRun:false})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole)=>readRunGroupContext(db,actor,task,currentRole)})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 if(!run.groupContext)throw Error('群运行必须带群上下文')
 return {owner,groups,group,root,role,runs,run,context:run.groupContext}
}
async function topicOf(owner:string,context:RunGroupContext){
 const db=await pool.connect()
 try{return await readRunGroupTopic(db,owner,context)}finally{db.release()}
}

test('话题为空时返回 undefined（整个键不进 JSON）',async()=>{
 const f=await fixture()
 assert.equal(await topicOf(f.owner,{...f.context,source:{...f.context.source,rootId:randomUUID()}}),undefined)
})

test('至多二十条、升序、每项恰五键、notice 逐字',async()=>{
 const f=await fixture()
 for(let index=1;index<=24;index++)await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:`补充第 ${index} 条。`})
 const topic=await topicOf(f.owner,f.context)
 assert.equal(topic?.notice,groupTopicNotice)
 assert.equal(topic?.messages.length,20)
 for(const message of topic!.messages)assert.deepEqual(Object.keys(message).sort(),['authorId','authorKind','authorName','createdAt','text'])
 const stamps=topic!.messages.map(message=>message.createdAt)
 assert.deepEqual(stamps,[...stamps].sort())
 // 尾部二十条：话题共 25 条，最早的根与随后四条被截掉。
 assert.equal(topic!.messages[0]!.text,'补充第 5 条。')
 assert.equal(topic!.messages.at(-1)!.text,'补充第 24 条。')
})

test('正文截一千字符',async()=>{
 const f=await fixture()
 await f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,rootId:f.root.id,text:'长'.repeat(1500)})
 const topic=await topicOf(f.owner,f.context)
 assert.equal(topic!.messages.at(-1)!.text.length,1000)
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
