import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {RoleService} from '../src/work/roles.ts'
import {CollaborationService} from '../src/work/collaboration.ts'
import {GroupAgentGrantService} from '../src/work/group-agent-grants.ts'
import {PlanService} from '../src/work/plans.ts'
import {PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {ObjectConversationService} from '../src/work/object-conversations.ts'
import {TaskRunService} from '../src/work/task-runs.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {GroupRoutingOutboxService,readTrustedGroupMessageRunSource} from '../src/work/group-routing-outbox.ts'
import {RoleWorkEligibilityService} from '../src/work/role-work-eligibility.ts'
import {GroupRunResultManifestService} from '../src/work/group-run-result-manifest.ts'
import {createTaskRunGroupPublisher} from '../../harness-dsh/src/task-run-group-publisher.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=> '2026-10-15T00:00:00.000Z'}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeTeloaDatabase(pool)
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop()})
const knowledgeText="原计划已授予的资料。",knowledge={id:randomUUID(),version:1,title:"原计划资料",sourceId:randomUUID(),sourceVersion:createHash("sha256").update(knowledgeText).digest("hex"),scopeIds:["general"],text:knowledgeText}
async function fixture(canPost=true,knowledgeIds:string[]=[]){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'定时汇报员工',kind:'employee',scopes:['general'],duty:'核对原资料并汇报',dataScope:'本人已授权资料',executionScope:'只读核对',skills:[],knowledge:knowledgeIds,responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 const groups=new CollaborationService(pool,identity),group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'定时汇报群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[role.id]}})
 const grants=new GroupAgentGrantService(pool,identity.now);await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:role.version,action:'save',resources:[],canPost,canAutoRun:true})
 const plans=new PlanService(pool,identity),fields={title:'每日原资料核对',goal:'核对原资料并保留依据。',scope:'general',dataScope:'本人明确授权资料',delivery:'核对结果和依据',roleId:role.id,expectedRoleVersion:role.version,groupId:group.id,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'}
 return {owner,role,group,groups,grants,plans,fields}
}
test('普通计划保存汇报群但保持暂停，发生实例和原任务固定同一群与原权限',async()=>{
 const f=await fixture(),saved=await f.plans.create(f.owner,{requestId:randomUUID(),fields:f.fields,source:{kind:'manual'}})
 assert.equal(saved.groupId,f.group.id);assert.equal(saved.state,'paused')
 const active=await f.plans.change(f.owner,{requestId:randomUUID(),planId:saved.id,expectedVersion:saved.version,action:'enable'}),occurrences=new PlanOccurrenceService(pool,{id:randomUUID})
 const {occurrence}=await occurrences.trigger(f.owner,{planId:active.id,requestId:randomUUID(),expectedVersion:active.version,expectedConfigVersion:active.configVersion,now:identity.now()})
 assert.equal(occurrence.fields.groupId,f.group.id);assert.equal(occurrence.taskRequest.fields.groupId,f.group.id)
 const {task}=await occurrences.dispatchTask(f.owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:identity.now()})
 assert.equal(task.groupId,f.group.id)
 assert.equal((await occurrences.list(f.owner,{planId:active.id}))[0]!.id,occurrence.id)
})
test('无发言许可不保存自动群汇报；领取前撤权不创建本轮任务或群消息',async()=>{
 const denied=await fixture(false);await assert.rejects(denied.plans.create(denied.owner,{requestId:randomUUID(),fields:denied.fields,source:{kind:'manual'}}),{code:'teloa/forbidden'})
 const f=await fixture(),saved=await f.plans.create(f.owner,{requestId:randomUUID(),fields:f.fields,source:{kind:'manual'}}),active=await f.plans.change(f.owner,{requestId:randomUUID(),planId:saved.id,expectedVersion:saved.version,action:'enable'})
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(new PlanOccurrenceService(pool,{id:randomUUID}).trigger(f.owner,{planId:active.id,requestId:randomUUID(),expectedVersion:active.version,expectedConfigVersion:active.configVersion,now:identity.now()}),{code:'teloa/forbidden'})
 assert.equal((await pool.query('select count(*)::int as n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
 assert.equal((await pool.query('select count(*)::int as n from teloa_group_messages where owner_id=$1',[f.owner])).rows[0].n,0)
})

async function preparedReport(withKnowledge=false){
 const f=await fixture(true,withKnowledge?[knowledge.id]:[]),plan=await f.plans.create(f.owner,{requestId:randomUUID(),fields:f.fields,source:{kind:'manual'}}),active=await f.plans.change(f.owner,{requestId:randomUUID(),planId:plan.id,expectedVersion:plan.version,action:'enable'}),occurrences=new PlanOccurrenceService(pool,{id:randomUUID})
 const {occurrence}=await occurrences.trigger(f.owner,{planId:active.id,requestId:randomUUID(),expectedVersion:active.version,expectedConfigVersion:active.configVersion,now:identity.now()}),{task}=await occurrences.dispatchTask(f.owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now:identity.now()})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],planContext:(db,owner,taskId)=>occurrences.executionContext(db,owner,taskId)})
 const run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1},undefined,async(_target,role)=>role.knowledge.map(()=>knowledge))
 return {...f,plan:active,occurrence,task,run,runs}
}
async function completedReport(){
 const f=await preparedReport();await f.runs.claim(f.owner,{runId:f.run.id})
 const ended=await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 return {...f,run:ended}
}
test('原生结束后主动汇报原计划任务，同一发生实例幂等且不伪造本人来源消息',async()=>{
 const f=await completedReport(),routing=new GroupRoutingOutboxService(pool,identity),service=new GroupRunMessageService(pool,identity,undefined,undefined,routing),published:string[]=[],publisher=createTaskRunGroupPublisher({post:input=>service.post(f.owner,input),failure:(run,code)=>service.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),route:id=>published.push(id),report:()=>{}})
 await publisher(f.run,'本轮核对结果：原资料一致。');await publisher(f.run,'本轮核对结果：原资料一致。')
 const messages=await f.groups.messages(f.owner,{groupId:f.group.id});assert.equal(messages.length,1)
 const message=messages[0]!;assert.ok('runId' in message);assert.equal(message.taskId,f.task.id);assert.equal(message.runId,f.run.id);assert.equal(message.rootId,null);assert.equal(message.authorId,f.role.id)
 assert.equal((await pool.query('select request_id from teloa_group_messages where id=$1',[message.id])).rows[0].request_id,f.occurrence.id)
 assert.deepEqual(published,[message.id,message.id])
 assert.equal((await pool.query('select count(*)::int as n from teloa_group_routing_wakes where owner_id=$1 and message_id=$2',[f.owner,message.id])).rows[0].n,1)
 assert.equal((await readTrustedGroupMessageRunSource(pool,f.owner,{groupId:f.group.id,messageId:message.id}))?.taskId,f.task.id)
 const admission=await new RoleWorkEligibilityService(pool).authorizeGroupRoutingSource(f.owner,{groupId:f.group.id,messageId:message.id});assert.equal(admission.role.id,f.role.id);admission.assertCurrent()
 assert.equal((await pool.query('select count(*)::int as n from teloa_group_messages where owner_id=$1 and author_id=$2',[f.owner,'self'])).rows[0].n,0)
})
test('发布前撤权、群归档、员工暂停或计划暂停均保留结果而不发帖',async()=>{
 for(const mode of ['grant','group','role','retired','member','plan']){
  const f=await completedReport()
  if(mode==='grant')await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
  if(mode==='group')await pool.query('update teloa_groups set archived=true where id=$1',[f.group.id])
  if(mode==='role')await pool.query("update teloa_roles set state='paused',version=version+1 where id=$1",[f.role.id])
  if(mode==='retired')await pool.query("update teloa_roles set state='retired',version=version+1 where id=$1",[f.role.id])
  if(mode==='member')await pool.query('delete from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3',[f.owner,f.group.id,f.role.id])
  if(mode==='plan')await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'pause'})
  const service=new GroupRunMessageService(pool,identity),codes:string[]=[],publisher=createTaskRunGroupPublisher({post:input=>service.post(f.owner,input),failure:(run,code)=>service.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:code=>codes.push(code)})
  await publisher(f.run,'已保留的原结果。');assert.equal(codes.length,1,mode)
  const saved=(await pool.query('select state,evidence,group_publication from teloa_task_runs where id=$1',[f.run.id])).rows[0];assert.equal(saved.state,'ended');assert.equal(saved.evidence.reason,'completed');assert.equal(saved.group_publication.state,'blocked')
  assert.equal((await f.groups.messages(f.owner,{groupId:f.group.id})).length,0)
 }
})

test('已派发未开始的汇报计划暂停后，不能领取原生发送权',async()=>{
 const f=await preparedReport();await f.plans.change(f.owner,{requestId:randomUUID(),planId:f.plan.id,expectedVersion:f.plan.version,action:'pause'})
 await assert.rejects(f.runs.claim(f.owner,{runId:f.run.id}),{code:'teloa/version-conflict'})
 assert.equal((await f.runs.get(f.owner,{runId:f.run.id})).state,'prepared')
})
test('计划汇报复用成果声明和定版，结果文件可从同一原任务取得',async()=>{
 const f=await preparedReport(),key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId},manifests=new GroupRunResultManifestService(pool)
 await f.runs.claim(f.owner,{runId:f.run.id});await f.runs.record(f.owner,{runId:f.run.id,...key,evidence:{state:'accepted'}})
 const content='# 定时核对结果\n原资料一致。',sha256=createHash('sha256').update(content).digest('hex'),claim={path:'定时核对结果.md',sha256}
 await manifests.declare(f.owner,{...key,claim})
 const ended=await f.runs.record(f.owner,{runId:f.run.id,...key,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const service=new GroupRunMessageService(pool,identity,{readClaimedFile:async(sessionId,claim)=>({schema:'teloa.file-snapshot/v1',sessionId,path:claim.path,id:createHash('sha256').update(claim.path).digest('hex'),sha256:claim.sha256,bytes:Buffer.byteLength(content),capturedAt:identity.now(),contentBase64:Buffer.from(content).toString('base64')}),report:code=>{throw Error(code)}})
 await createTaskRunGroupPublisher({post:input=>service.post(f.owner,input),run:(sessionId,nativeRequestId)=>manifests.read(f.owner,{sessionId,nativeRequestId}),failure:(run,code)=>service.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:code=>{throw Error(code)}})(ended,'原资料一致，核对结果见成果文件。')
 const message=(await f.groups.messages(f.owner,{groupId:f.group.id}))[0]!,reference=message.references.find(r=>r.kind==='artifact');assert.ok(reference)
 assert.equal((await pool.query('select source from teloa_artifact_versions where owner_id=$1 and artifact_id=$2',[f.owner,reference.id])).rows[0].source.id,f.task.id)
})
test('暂时发布故障保留同一发生实例，恢复后由待办重试且不再运行模型',async()=>{
 const f=await completedReport(),service=new GroupRunMessageService(pool,identity)
 const pending=(await pool.query('select group_publication from teloa_task_runs where id=$1',[f.run.id])).rows[0].group_publication
 assert.equal(pending?.code,'teloa/publication-pending','原生终态与待发布必须同事务落库，立即发帖前宿主中断仍能恢复')
 assert.ok((await f.runs.outstanding(f.owner)).includes(f.run.id))
 await service.failure(f.owner,{runId:f.run.id,nativeRequestId:f.run.nativeRequestId,code:'teloa/dependency-unavailable'})
 const due=new TaskRunService(pool,{...identity,now:()=> '2026-10-15T00:01:01.000Z'},async()=>({id:randomUUID(),sessionId:f.run.sessionId,ownerId:f.owner,status:'ready'}))
 await pool.query("update teloa_task_runs set group_publication_next_at=now()-interval '1 second' where id=$1",[f.run.id])
 assert.ok((await due.outstanding(f.owner)).includes(f.run.id))
 await createTaskRunGroupPublisher({post:input=>service.post(f.owner,input),failure:(run,code)=>service.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:code=>{throw Error(code)}})(f.run,'恢复后原结果。')
 assert.equal((await pool.query('select group_publication from teloa_task_runs where id=$1',[f.run.id])).rows[0].group_publication,null)
 assert.equal((await f.groups.messages(f.owner,{groupId:f.group.id})).length,1)
 assert.ok(!(await due.outstanding(f.owner)).includes(f.run.id))
})


test('已有群执行上下文不能借计划快照换汇报目标',async()=>{
 const f=await completedReport()
 await pool.query("update teloa_task_runs set group_context_hash=$2,input_text=(input_text::jsonb||'{\"groupContext\":{}}'::jsonb)::text where id=$1",[f.run.id,'a'.repeat(64)])
 await assert.rejects(new GroupRunMessageService(pool,identity).post(f.owner,{requestId:f.occurrence.id,runId:f.run.id,text:'不应发布'}),{code:'teloa/storage-corrupt'})
 assert.equal((await f.groups.messages(f.owner,{groupId:f.group.id})).length,0)
})


test('只选汇报群保留原计划知识，不将报告目标变成群资料读取授权',async()=>{
 const f=await preparedReport(true)
 assert.deepEqual(f.run.knowledge.map(item=>item.id),[knowledge.id])
 assert.equal(f.run.groupContext,undefined)
 assert.match(f.run.inputText,/原计划已授予的资料/)
})
