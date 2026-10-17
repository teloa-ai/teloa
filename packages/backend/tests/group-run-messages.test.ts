import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,artifactFileTotalBytes,type ArtifactFile,type GroupRunFileClaim} from '@teloa/contract'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAttachments} from '../src/work/group-attachments.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {GroupRunMessageService} from '../src/work/group-run-messages.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {initializeGroupWorkInputs} from '../src/work/group-work-inputs.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeTeloaDatabase} from '../src/work/initialize-database.ts'
import {GroupRoutingDecisionService} from '../src/work/group-routing-decisions.ts'
import {GroupRoutingStatusService} from '../src/work/group-routing-status.ts'
import {GroupRunResultManifestService} from '../src/work/group-run-result-manifest.ts'
import {createTaskRunGroupPublisher} from '../../harness-dsh/src/task-run-group-publisher.ts'
import {TaskRunDriver} from '../../harness-dsh/src/task-run-driver.ts'
import {monitorTaskRuns} from '../../harness-dsh/src/task-run-monitor.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-18T09:00:00.000Z').toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeTeloaDatabase(pool)
})

const sha=(content:string)=>createHash('sha256').update(content).digest('hex')
const snapshot=(sessionId:string,path:string,content:string):ArtifactFile=>({schema:'teloa.file-snapshot/v1',sessionId,path,id:sha(JSON.stringify([sessionId,path])),sha256:sha(content),bytes:Buffer.byteLength(content),capturedAt:'2026-09-18T09:00:00.000Z',contentBase64:Buffer.from(content).toString('base64')})
/** 工作区桩：登记过的路径按内容现读，其余按既有三道闸的位置码拒绝。 */
function workspace(files:Record<string,string>){
 const reported:string[]=[]
 return {reported,ports:{
  readClaimedFile:async(sessionId:string,claim:GroupRunFileClaim):Promise<ArtifactFile>=>{
   const content=files[claim.path]
   if(content===undefined)throw new WorkError('teloa/file-scope','该文件不在可选产物范围内。')
   return snapshot(sessionId,claim.path,content)
  },
  report:(code:string)=>{reported.push(code)}
 }}
}
async function counts(owner:string){
 const one=async(table:string)=>(await pool.query(`select count(*)::int as count from ${table} where owner_id=$1`,[owner])).rows[0].count as number
 return {snapshots:await one('teloa_artifact_snapshots'),versions:await one('teloa_artifact_versions'),attachments:await one('teloa_attachments')}
}
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(canPost=true,resourceCount=1,mode?:'main'|'thread'){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'soc-analyst'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const activeRole={...role,state:'active' as const,version:2}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'SOC 研判群',scope:'SOC',announcement:'仅使用已固定资料。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const resources=[]
 for(let index=1;index<=resourceCount;index++)resources.push(await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:`EDR 告警证据 ${index}`,markdown:`# alert-00${index}\n\n进程树与主机证据。`}))
 const resource=resources[0]!,grantResources=resources.map(item=>({kind:'group-resource' as const,id:item.id,version:item.version}))
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请分析 alert-001 的影响。',references:grantResources})
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,action:'save',resources:grantResources,canPost,canAutoRun:!!mode})
 const trigger=mode==='thread'?await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,rootId:root.id,text:'请在本话题补充说明。',references:grantResources}):root
 const created=await new GroupTaskService(pool,identity,tasks).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:trigger.id,expectedGroupVersion:group.version,goal:'给出可审计的研判结论。',assignee:{roleId:role.id,expectedVersion:2},...(mode?{trigger:'routed',executionMode:'reply',routingAttemptVersion:1}:{})})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole)=>import('../src/work/task-run-group-context.ts').then(({readRunGroupContext})=>readRunGroupContext(db,actor,task,currentRole))})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 return {owner,groups,grants,group,resource,root,trigger,role:activeRole,runs,run}
}

test('结构化提及沿原运行持久发布，跨本人拒绝且主群话题水位独立',async()=>{
 const f=await fixture(true,0,'main'),manifests=new GroupRunResultManifestService(pool),key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId}
 assert.equal(typeof manifests.mentionSelf,'function','需要绑定原运行的结构化提及声明')
 await assert.rejects(manifests.mentionSelf(f.owner,key),{code:'teloa/conflict'})
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 await Promise.all([manifests.mentionSelf(f.owner,key),manifests.mentionSelf(f.owner,key)])
 assert.equal((await new GroupRunResultManifestService(pool).read(f.owner,key)).mentionSelf,true)
 await assert.rejects(manifests.mentionSelf('other',key),{code:'teloa/forbidden'})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 await assert.rejects(manifests.mentionSelf(f.owner,key),{code:'teloa/conflict'})
 const publisher=new GroupRunMessageService(pool,identity),input={requestId:f.run.nativeRequestId,runId:f.run.id,text:'同名员工的正文，没有依赖 @姓名。'},message=await publisher.post(f.owner,input)
 assert.equal('mentionSelf' in message&&message.mentionSelf,true)
 assert.equal((await publisher.post(f.owner,input)).id,message.id)
 assert.equal((await f.groups.mentionMessages(f.owner,{groupId:f.group.id})).items[0]?.rootId,null)
 assert.deepEqual((await f.groups.attention(f.owner,{})).items,[{groupId:f.group.id,unreadCount:1,mentionCount:1}])
 assert.equal((await f.groups.mentionMessages(f.owner,{groupId:f.group.id,rootId:f.root.id})).items.length,0,'v2主群回帖不进话题提及')
 await assert.rejects(f.groups.mentionMessages('other',{groupId:f.group.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.groups.mentionMessages(f.owner,{groupId:f.group.id,before:randomUUID()}),{code:'teloa/forbidden'})
 assert.equal((await f.groups.attention('other',{})).items.length,0)
 await f.groups.markRead(f.owner,{groupId:f.group.id,messageId:message.id})
 assert.equal((await f.groups.attention(f.owner,{})).items[0]?.mentionCount,0)
 assert.equal((await f.groups.mentionMessages(f.owner,{groupId:f.group.id})).items[0]?.unread,false)
 const topic=await fixture(true,0,'thread'),topicKey={sessionId:topic.run.sessionId,nativeRequestId:topic.run.nativeRequestId}
 await topic.runs.claim(topic.owner,{runId:topic.run.id})
 await topic.runs.record(topic.owner,{runId:topic.run.id,sessionId:topic.run.sessionId,nativeRequestId:topic.run.nativeRequestId,evidence:{state:'accepted'}})
 await manifests.mentionSelf(topic.owner,topicKey)
 await topic.runs.record(topic.owner,{runId:topic.run.id,sessionId:topic.run.sessionId,nativeRequestId:topic.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const reply=await publisher.post(topic.owner,{requestId:topic.run.nativeRequestId,runId:topic.run.id,text:'仅本话题提醒'})
 assert.equal((await topic.groups.mentionMessages(topic.owner,{groupId:topic.group.id})).items[0]?.rootId,topic.root.id)
 await topic.groups.markRead(topic.owner,{groupId:topic.group.id,messageId:topic.root.id})
 assert.equal((await topic.groups.attention(topic.owner,{})).items[0]?.mentionCount,1)
 await topic.groups.markRead(topic.owner,{groupId:topic.group.id,rootId:topic.root.id,messageId:reply.id})
 assert.equal((await topic.groups.attention(topic.owner,{})).items[0]?.mentionCount,0)
})

test('结构化提及撤权及角色版本变化拒绝，旧正文与回复本人不补造提醒',async()=>{
 for(const change of ['grant','role'] as const){
  const f=await fixture(true,0,'main'),key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId},manifest=new GroupRunResultManifestService(pool)
  await f.runs.claim(f.owner,{runId:f.run.id});await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
  await manifest.mentionSelf(f.owner,key)
  if(change==='grant')await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
  else await pool.query('update teloa_roles set version=version+1 where owner_id=$1 and id=$2',[f.owner,f.role.id])
  await assert.rejects(manifest.mentionSelf(f.owner,key))
  await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
  await assert.rejects(new GroupRunMessageService(pool,identity).post(f.owner,{requestId:f.run.nativeRequestId,runId:f.run.id,text:'不可发布'}))
  assert.equal((await f.groups.attention(f.owner,{})).items[0]?.mentionCount,0)
 }
 const f=await fixture(true,0,'main')
 await f.runs.claim(f.owner,{runId:f.run.id});await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const message=await new GroupRunMessageService(pool,identity).post(f.owner,{requestId:f.run.nativeRequestId,runId:f.run.id,text:'@Max 请注意；这段只有文字，回复本人的根。'})
 assert.equal('mentionSelf' in message,false)
 assert.equal((await f.groups.mentionMessages(f.owner,{groupId:f.group.id})).items.length,0)
 assert.equal((await f.groups.attention(f.owner,{})).items[0]?.unreadCount,1)
})

test('停止及取消不能新登记提及，原运行没有虚构成功意图',async()=>{
 const f=await fixture(true,0,'main'),manifest=new GroupRunResultManifestService(pool),key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId}
 await f.runs.claim(f.owner,{runId:f.run.id});await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 const cancelled=new AbortController();cancelled.abort()
 await assert.rejects(manifest.mentionSelf(f.owner,key,cancelled.signal))
 assert.equal((await manifest.read(f.owner,key)).mentionSelf,undefined)
 await f.runs.requestStop(f.owner,{runId:f.run.id})
 await assert.rejects(manifest.mentionSelf(f.owner,key),{code:'teloa/conflict'})
 assert.equal((await manifest.read(f.owner,key)).mentionSelf,undefined)
 assert.equal((await f.groups.mentionMessages(f.owner,{groupId:f.group.id})).items.length,0)
})

test('提及分页在同时间戳仍连续且遵循原群水位，伪造跨群游标不读数据',async()=>{
 const f=await fixture(true,0,'main'),ids:string[]=[]
 // 此处只验证真实PG分页边界，合成消息不冒充真实模型或自然历史。
 for(let n=0;n<55;n++){
  const id=randomUUID();ids.push(id)
  await pool.query("insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,task_id,run_id,text,reference_snapshot,mention_snapshot,created_at,mention_self) values($1,$2,$3,$4,'{}',null,$5,$6,$7,$8,'[]','[]',$9,true)",[id,f.owner,f.group.id,randomUUID(),f.role.id,randomUUID(),randomUUID(),'合成提及 '+n,identity.now()])
 }
 const one=await f.groups.mentionMessages(f.owner,{groupId:f.group.id,limit:50}),two=await f.groups.mentionMessages(f.owner,{groupId:f.group.id,limit:50,before:one.next})
 assert.equal(one.items.length,50);assert.equal(two.items.length,5);assert.equal(two.next,null)
 const ordered=[...ids].sort()
 assert.deepEqual([...one.items,...two.items].map(item=>item.message.id),[...ordered].reverse())
 await f.groups.markRead(f.owner,{groupId:f.group.id,messageId:ordered[20]})
 const unread=await f.groups.mentionMessages(f.owner,{groupId:f.group.id,unreadOnly:true,limit:100})
 assert.equal(unread.items.length,34);assert.ok(unread.items.every(item=>item.unread))
 const other=await fixture(true,0,'main')
 await assert.rejects(f.groups.mentionMessages(f.owner,{groupId:other.group.id,before:one.next}),{code:'teloa/forbidden'})
 await assert.rejects(f.groups.mentionMessages(f.owner,{groupId:f.group.id,before:other.root.id}),{code:'teloa/forbidden'})
})

test('长回复完整保存到原消息，摘要不切断字符；原文件和7份引用保留，按需读回且幂等不重复',async()=>{
 const f=await fixture(true,7,'main'),content='# 成果文件\n\n原成果仍可读取。',claim={path:'成果.md',sha256:sha(content)},ports=workspace({[claim.path]:content})
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const text='    # 完整结论\n\n'+'已核实的事实🙂。'.repeat(2500)+'\n\n末尾结论不可丢失。\n  ',service=new GroupRunMessageService(pool,identity,ports.ports)
 const input={requestId:f.run.nativeRequestId,runId:f.run.id,text,files:[claim]},posted=await service.post(f.owner,input)
 assert.ok('runId' in posted)
 assert.equal((await service.post(f.owner,input)).id,posted.id)
 assert.equal(posted.text.length<=8000,true);assert.equal(posted.text.endsWith('…'),true);assert.equal(posted.text.includes('\ufffd'),false)
 assert.deepEqual(posted.fullText,{chars:text.length,sha256:sha(text)})
 assert.equal(posted.references.filter(row=>row.kind==='group-resource').length,7)
 assert.equal(posted.references.filter(row=>row.kind==='artifact').length,1)
 const fresh=new CollaborationService(pool,identity),read=await fresh.messageBody(f.owner,{groupId:f.group.id,messageId:posted.id})
 assert.deepEqual(read,{groupId:f.group.id,messageId:posted.id,text,chars:text.length,sha256:sha(text)})
 const messages=await fresh.messages(f.owner,{groupId:f.group.id}),row=messages.find(row=>row.id===posted.id)!
 assert.ok('runId' in row)
 assert.equal(messages.filter(row=>'runId' in row).length,1);assert.deepEqual(row.fullText,posted.fullText)
 assert.equal('text' in row.fullText!,false,'群流只带全文身份，不反复传完整结果')
 assert.equal('contextMode' in row&&row.contextMode,'main');assert.equal('replyToMessageId' in row&&row.replyToMessageId,f.root.id)
 await assert.rejects(service.post(f.owner,{...input,text:text+'变化'}),{code:'teloa/conflict'})
 await assert.rejects(fresh.messageBody('other',{groupId:f.group.id,messageId:posted.id}),{code:'teloa/forbidden'})
 const other=await fixture()
 await assert.rejects(fresh.messageBody(f.owner,{groupId:other.group.id,messageId:posted.id}),{code:'teloa/forbidden'})
 await assert.rejects(fresh.messageBody(f.owner,{groupId:f.group.id,messageId:other.root.id}),{code:'teloa/forbidden'})
 const sameOwnerGroup=await f.groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'本人另一群',scope:'SOC',announcement:'',rules:openGroupRules,memberRoleIds:[f.role.id]}})
 await assert.rejects(fresh.messageBody(f.owner,{groupId:sameOwnerGroup.id,messageId:posted.id}),{code:'teloa/forbidden'},'同一本人的另一群也不能冒充原消息归属')
 await pool.query('update teloa_group_messages set full_text=$3 where owner_id=$1 and id=$2',[f.owner,posted.id,text+'损坏'])
 await assert.rejects(fresh.messageBody(f.owner,{groupId:f.group.id,messageId:posted.id}),{code:'teloa/storage-corrupt'})
})

test('长回复不挤占8份资料引用；附件失败说明导致超限时完整正文仍可读且不静默截尾',async()=>{
 const f=await fixture(true,8),service=new GroupRunMessageService(pool,identity,workspace({}).ports)
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const text='x'.repeat(7997)+'🙂尾',posted=await service.post(f.owner,{requestId:f.run.nativeRequestId,runId:f.run.id,text,files:[{path:'missing.md',sha256:sha('missing')}]})
 assert.ok('runId' in posted)
 assert.equal(posted.references.length,8);assert.equal(posted.text.length<=8000,true)
 const full=await f.groups.messageBody(f.owner,{groupId:f.group.id,messageId:posted.id})
 assert.equal(full.text.endsWith(text),true);assert.match(full.text,/有 1 件文件未能贴出/)
 assert.deepEqual(posted.fullText,{chars:full.text.length,sha256:sha(full.text)})
})

test('附件及无视觉意图按原运行持久保存；并发、撤权、取消和结束边界均不丢声明或串运行',async()=>{
 const f=await fixture(),service=new GroupRunResultManifestService(pool),key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId}
 assert.deepEqual(await service.read(f.owner,key),{files:[],noVision:false})
 await service.markNoVision(f.owner,key)
 await assert.rejects(service.declare(f.owner,{...key,claim:{path:'a.md',sha256:sha('a')}}),{code:'teloa/conflict'})
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 const claims=[{path:'a.md',sha256:sha('a')},{path:'b.md',sha256:sha('b')}]
 await Promise.all(claims.map(claim=>service.declare(f.owner,{...key,claim})))
 const fresh=new GroupRunResultManifestService(pool),saved=await fresh.read(f.owner,key)
 assert.deepEqual(saved.files.sort((a,b)=>a.path.localeCompare(b.path)),claims);assert.equal(saved.noVision,true)
 assert.equal((await fresh.declare(f.owner,{...key,claim:claims[0]!})).duplicate,true)
 await assert.rejects(fresh.read('other',key),{code:'teloa/forbidden'})
 await assert.rejects(fresh.read(f.owner,{...key,nativeRequestId:randomUUID()}),{code:'teloa/forbidden'})
 const cancelled=new AbortController();cancelled.abort()
 await assert.rejects(fresh.declare(f.owner,{...key,claim:{path:'cancel.md',sha256:sha('cancel')}},cancelled.signal))
 for(let i=2;i<8;i++)await fresh.declare(f.owner,{...key,claim:{path:i+'.md',sha256:sha(String(i))}})
 await assert.rejects(fresh.declare(f.owner,{...key,claim:{path:'ninth.md',sha256:sha('ninth')}}),{code:'teloa/conflict'})
 assert.equal((await fresh.read(f.owner,key)).files.length,8)
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(fresh.declare(f.owner,{...key,claim:claims[0]!}),{code:'teloa/version-conflict'})
 assert.equal((await fresh.read(f.owner,key)).files.length,8,'撤权不抹掉历史声明')
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 await assert.rejects(fresh.markNoVision(f.owner,key),{code:'teloa/conflict'},'原结束运行的清单不可修改')
})

test('重建服务从持久清单发布同一正文与文件；无视觉说明、文件摘要和回群幂等均保留',async()=>{
 const f=await fixture(),key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId},manifest=new GroupRunResultManifestService(pool)
 await manifest.markNoVision(f.owner,key)
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 const content='# 核对结果\n\n文件声明在重建服务后仍可回群。',claim={path:'核对结果.md',sha256:sha(content)}
 await manifest.declare(f.owner,{...key,claim})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const workspacePorts=workspace({[claim.path]:content}),messages=new GroupRunMessageService(pool,identity,workspacePorts.ports),fresh=new GroupRunResultManifestService(pool)
 const publish=createTaskRunGroupPublisher({post:input=>messages.post(f.owner,input),run:(sessionId,nativeRequestId)=>fresh.read(f.owner,{sessionId,nativeRequestId}),failure:(run,code)=>messages.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:()=>{}})
 await publish(f.run,'核对完成。');await publish(f.run,'核对完成。')
 const posted=(await f.groups.messages(f.owner,{groupId:f.group.id})).filter(row=>'runId' in row)
 assert.equal(posted.length,1);assert.match(posted[0]!.text,/本轮模型没有读图能力/)
 const reference=posted[0]!.references.find(row=>row.kind==='artifact')!
 assert.ok(reference)
 const snapshots=(await pool.query('select content from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[f.owner,reference.id,reference.version])).rows[0].content.snapshotIds
 const file=(await pool.query('select content from teloa_artifact_snapshots where owner_id=$1 and snapshot_id=$2',[f.owner,snapshots[0]])).rows[0].content
 assert.equal(file.sha256,claim.sha256);assert.equal(Buffer.from(file.contentBase64,'base64').toString(),content)
 assert.deepEqual((await fresh.read(f.owner,key)).files,[claim])
})

test('发布拒绝持久显示结果未发出；暂时故障只观察原结束运行，送达后清回执且不重复消息',async()=>{
 const f=await fixture(true,1,'main'),post=new GroupRunMessageService(pool,identity)
 await new GroupRoutingDecisionService(pool,identity).withTopicLock(f.owner,f.group.id,f.root.id,db=>new GroupRoutingDecisionService(pool,identity).record(db,f.owner,{groupId:f.group.id,messageId:f.root.id,decision:{kind:'routed',respond:[f.role.id],reactions:[],hops:0,candidateIds:[f.role.id],truncatedCandidates:false,stopMessageId:null,at:identity.now()}}))
 await pool.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,task_id,run_id,created_at) values($1,$2,$3,$4,1,$5,$6,$7,$8,'settled',$9,$10,$11)`,[randomUUID(),f.owner,f.group.id,f.root.id,f.role.id,f.role.version,randomUUID(),f.group.version,f.run.taskId,f.run.id,identity.now()])
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await createTaskRunGroupPublisher({post:input=>post.post(f.owner,input),failure:(run,code)=>post.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:()=>{}})(f.run,'原结果保留')
 const status=(await new GroupRoutingStatusService(pool).status(f.owner,{groupId:f.group.id,messageIds:[f.root.id]})).items[0]!
 assert.equal(status.phase,'publication-blocked');assert.equal(status.hintCode,'result-retained');assert.equal(status.canRetry,false)
 assert.deepEqual(await f.runs.outstanding(f.owner),[],'权限变化后不循环重试，也不再执行原工作')
 const stored=(await pool.query('select state,evidence,group_publication from teloa_task_runs where id=$1',[f.run.id])).rows[0]
 assert.equal(stored.state,'ended');assert.equal(stored.evidence.reason,'completed');assert.equal(stored.group_publication.state,'blocked')
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:stored.evidence})
 assert.deepEqual(await f.runs.outstanding(f.owner),[],'迟到的同一结束证据不重置发布阻断')
 await assert.rejects(post.failure('other',{runId:f.run.id,nativeRequestId:f.run.nativeRequestId,code:'teloa/forbidden'}),{code:'teloa/forbidden'})

 const g=await fixture(true,1,'main'),clock={...identity,now:()=>new Date().toISOString()},retry=new GroupRunMessageService(pool,clock)
 await assert.rejects(retry.failure(g.owner,{runId:g.run.id,nativeRequestId:g.run.nativeRequestId,code:'teloa/dependency-unavailable'}),{code:'teloa/conflict'},'未结束运行不能写发布失败')
 await g.runs.claim(g.owner,{runId:g.run.id})
 await g.runs.record(g.owner,{runId:g.run.id,sessionId:g.run.sessionId,nativeRequestId:g.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 assert.deepEqual(await g.runs.outstanding(g.owner),[g.run.id],'已结束但未发出的原结果仍需观察')
 await retry.failure(g.owner,{runId:g.run.id,nativeRequestId:g.run.nativeRequestId,code:'teloa/dependency-unavailable'})
 assert.deepEqual(await g.runs.outstanding(g.owner),[],'重试间隔内不重复读取')
 await pool.query("update teloa_task_runs set group_publication_next_at=now()-interval '1 second' where id=$1",[g.run.id])
 assert.deepEqual(await g.runs.outstanding(g.owner),[g.run.id],'间隔后继续原运行的发布')
 const request={requestId:g.run.nativeRequestId,runId:g.run.id,text:'恢复后同一结果'}
 const message=await retry.post(g.owner,request);assert.deepEqual(await retry.post(g.owner,request),message)
 await retry.failure(g.owner,{runId:g.run.id,nativeRequestId:g.run.nativeRequestId,code:'teloa/dependency-unavailable'})
 assert.deepEqual(await g.runs.outstanding(g.owner),[])
 assert.equal((await pool.query('select group_publication from teloa_task_runs where id=$1',[g.run.id])).rows[0].group_publication,null,'迟到失败不能覆盖已经送达的事实')
 assert.equal((await g.groups.messages(g.owner,{groupId:g.group.id})).filter(row=>'runId' in row).length,1)
 const history=await fixture(true,1,'main')
 await history.runs.claim(history.owner,{runId:history.run.id})
 await history.runs.record(history.owner,{runId:history.run.id,sessionId:history.run.sessionId,nativeRequestId:history.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 await pool.query('update teloa_task_runs set group_publication=null where id=$1',[history.run.id])
 assert.deepEqual(await history.runs.outstanding(history.owner),[],'旧版本没有待发布回执的历史工作不因升级隐式补发')
})

test('主群和话题回复的显示位置只取原服务端来源，根关联与原消息引用在刷新后保留',async()=>{
 for(const mode of ['main','thread'] as const){
  const f=await fixture(true,1,mode),messages=new GroupRunMessageService(pool,identity)
  await f.runs.claim(f.owner,{runId:f.run.id})
  await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
  const saved=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'员工正式回应。'})
  const listed=(await f.groups.messages(f.owner,{groupId:f.group.id})).find(row=>row.id===saved.id)!
  assert.equal(listed.rootId,f.root.id)
  assert.equal('contextMode' in listed&&listed.contextMode,mode)
  assert.equal('replyToMessageId' in listed&&listed.replyToMessageId,f.trigger.id)
  assert.deepEqual((await f.groups.messages(f.owner,{groupId:f.group.id,rootId:f.root.id})).find(row=>row.id===saved.id),listed)
  await assert.rejects(f.groups.messages('other',{groupId:f.group.id}),{code:'teloa/forbidden'})
  await assert.rejects(f.groups.send(f.owner,{requestId:randomUUID(),groupId:f.group.id,expectedVersion:f.group.version,text:'不能伪造显示来源。',contextMode:'main'}),{code:'teloa/invalid-input'})
 }
})

test('数字员工只在原生运行已结束后，按固定资料与当前群内发言授权回传消息',async()=>{
 const f=await fixture(),messages=new GroupRunMessageService(pool,identity),input={requestId:randomUUID(),runId:f.run.id,text:'已完成初步研判：需要核对父进程与横向连接。'}
 await assert.rejects(messages.post(f.owner,input),{code:'teloa/conflict'})
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 await assert.rejects(messages.post(f.owner,input),{code:'teloa/conflict'})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'active',turn:1,messageSeq:2}})
 await assert.rejects(messages.post(f.owner,input),{code:'teloa/conflict'})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 const saved=await messages.post(f.owner,input)
 assert.notEqual(saved.authorId,'self')
 if(!('runId' in saved))throw Error('数字员工身份丢失')
 assert.equal(saved.authorId,f.role.id)
 assert.equal(saved.taskId,f.run.taskId)
 assert.equal(saved.runId,f.run.id)
 assert.equal(saved.rootId,f.root.id)
 assert.deepEqual(saved.references,[{kind:'group-resource',id:f.resource.id,version:f.resource.version}])
 // 不带 files 的回帖与本次变更前逐字一致：不定版、不落快照、不碰附件仓。
 assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
 assert.deepEqual(await messages.post(f.owner,input),saved)
 assert.deepEqual((await f.groups.messages(f.owner,{groupId:f.group.id,rootId:f.root.id})).map(message=>message.id),[f.root.id,saved.id])
 await f.grants.change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
 await assert.rejects(messages.post(f.owner,{...input,requestId:randomUUID(),text:'授权撤回后不得补发。'}),{code:'teloa/version-conflict'})
})

test('没有群内发言授权时，即使运行已被原生确认也不能回传',async()=>{
 const f=await fixture(false),messages=new GroupRunMessageService(pool,identity)
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 await assert.rejects(messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'不应发送。'}),{code:'teloa/forbidden'})
})

test('运行状态结束但原生证据未结束时必须拒绝回传',async()=>{
 const f=await fixture(),messages=new GroupRunMessageService(pool,identity)
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 await pool.query("update teloa_task_runs set state='ended' where owner_id=$1 and id=$2",[f.owner,f.run.id])
 await assert.rejects(messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'不应发送。'}),{code:'teloa/conflict'})
})

test('旧群消息表升级后保留本人消息约束，并为数字员工回传补齐运行来源列',async()=>{
 const schema='group_message_upgrade_'+randomUUID().replaceAll('-',''),upgrade=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`})
 await pool.query(`create schema "${schema}"`)
 try{
  await initializeRoles(upgrade)
  await upgrade.query(`create table teloa_groups (id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null,definition jsonb not null,version integer not null,pinned boolean not null,archived boolean not null,created_at timestamptz not null,updated_at timestamptz not null,unique(id,owner_id));
   create table teloa_group_messages (id uuid primary key,owner_id text not null,group_id uuid not null,request_id uuid not null,request_spec jsonb not null,root_id uuid,author_id text not null check(author_id='self'),text text not null,reference_snapshot jsonb not null,created_at timestamptz not null,unique(owner_id,request_id),unique(id,group_id),foreign key(group_id,owner_id) references teloa_groups(id,owner_id),foreign key(root_id) references teloa_group_messages(id));`)
  await initializeCollaboration(upgrade)
  const columns=(await upgrade.query("select column_name from information_schema.columns where table_schema=current_schema() and table_name='teloa_group_messages' and column_name in ('task_id','run_id') order by column_name")).rows.map(row=>row.column_name)
  assert.deepEqual(columns,['run_id','task_id'])
  const definition=(await upgrade.query("select pg_get_constraintdef(oid) definition from pg_constraint where conrelid='teloa_group_messages'::regclass and conname='teloa_group_messages_author_execution_v1'")).rows[0]?.definition
  assert.match(definition,/author_id = 'self'/);assert.match(definition,/task_id IS NULL/);assert.match(definition,/run_id IS NOT NULL/)
 }finally{await upgrade.end();await pool.query(`drop schema "${schema}" cascade`)}
})

async function ended(canPost=true,resourceCount=1){
 const f=await fixture(canPost,resourceCount)
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
 return f
}

test('同事声明的本次运行文件定版成成果并按引用贴回，附件仓一行不增',async()=>{
 const f=await ended(),stub=workspace({'报告.md':'# 研判结论','图表.csv':'a,b\n1,2'})
 const files=[{path:'报告.md',sha256:sha('# 研判结论')},{path:'图表.csv',sha256:sha('a,b\n1,2')}],text='已完成研判，附上报告与图表。'
 await assert.rejects(new GroupRunMessageService(pool,identity).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text,files}),{code:'teloa/dependency-unavailable'})
 const messages=new GroupRunMessageService(pool,identity,stub.ports)
 const saved=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text,files})
 assert.equal(saved.text,text)
 assert.deepEqual(stub.reported,[])
 const reference=saved.references.find(item=>item.kind==='artifact')
 if(!reference)throw Error('成果引用缺失')
 assert.deepEqual(saved.references,[{kind:'group-resource',id:f.resource.id,version:f.resource.version},{kind:'artifact',id:reference.id,version:1}])
 assert.deepEqual(await counts(f.owner),{snapshots:2,versions:1,attachments:0})
 const row=(await pool.query('select source,content from teloa_artifact_versions where owner_id=$1 and artifact_id=$2',[f.owner,reference.id])).rows[0]
 assert.equal(row.source.kind,'task');assert.equal(row.source.id,f.run.taskId)
 assert.deepEqual(row.content.sections,[])
 assert.equal(row.content.note,'由群内运行自动定版。')
 assert.ok(!row.content.title.includes(text)&&!row.content.title.includes('研判结论'))
 assert.equal(row.content.snapshotIds.length,2)
 // 同一个运行重放（哪怕换一个回帖请求身份）只得到同一版成果。
 const again=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text,files})
 assert.deepEqual(again.references,saved.references)
 assert.deepEqual(await counts(f.owner),{snapshots:2,versions:1,attachments:0})
})

test('同一回帖请求换一组声明文件判冲突，不命中旧回执',async()=>{
 const f=await ended(),stub=workspace({'报告.md':'# 研判结论','图表.csv':'a,b\n1,2'})
 const messages=new GroupRunMessageService(pool,identity,stub.ports),requestId=randomUUID()
 const files=[{path:'报告.md',sha256:sha('# 研判结论')}],text='已完成研判。'
 const saved=await messages.post(f.owner,{requestId,runId:f.run.id,text,files})
 assert.deepEqual(await messages.post(f.owner,{requestId,runId:f.run.id,text,files}),saved)
 // 顺序不同但集合相同仍是同一请求；换一组文件必须判冲突。
 assert.deepEqual(await messages.post(f.owner,{requestId,runId:f.run.id,text,files:[...files]}),saved)
 await assert.rejects(messages.post(f.owner,{requestId,runId:f.run.id,text,files:[{path:'图表.csv',sha256:sha('a,b\n1,2')}]}),{code:'teloa/conflict'})
 await assert.rejects(messages.post(f.owner,{requestId,runId:f.run.id,text}),{code:'teloa/conflict'})
})

test('越界或内容已变的声明只剔除该文件，正文照发并前置未贴出提示',async()=>{
 const f=await ended(),stub=workspace({'报告.md':'# 研判结论','图表.csv':'a,b\n1,2'})
 const messages=new GroupRunMessageService(pool,identity,stub.ports)
 const saved=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'正文必须照发。',files:[{path:'报告.md',sha256:sha('# 研判结论')},{path:'别处/越界.md',sha256:sha('x')},{path:'图表.csv',sha256:sha('已经改过了')}]})
 assert.equal(saved.text,'【有 2 件文件未能贴出。】\n\n正文必须照发。')
 assert.deepEqual(stub.reported.slice().sort(),['teloa/file-changed','teloa/file-scope'])
 assert.equal(saved.references.filter(item=>item.kind==='artifact').length,1)
 assert.deepEqual(await counts(f.owner),{snapshots:1,versions:1,attachments:0})
})

test('声明的文件全部核对失败时不定版、不加引用，正文照发',async()=>{
 const f=await ended(),stub=workspace({})
 const messages=new GroupRunMessageService(pool,identity,stub.ports)
 const saved=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'结论仍然要发。',files:[{path:'报告.md',sha256:sha('x')},{path:'图表.csv',sha256:sha('y')}]})
 assert.equal(saved.text,'【有 2 件文件未能贴出。】\n\n结论仍然要发。')
 assert.deepEqual(saved.references,[{kind:'group-resource',id:f.resource.id,version:f.resource.version}])
 assert.deepEqual(stub.reported,['teloa/file-scope','teloa/file-scope'])
 assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
})

test('引用已满 8 条时不追加成果引用，正文照发并计入未贴出',async()=>{
 const f=await ended(true,8),stub=workspace({'报告.md':'# 研判结论'})
 const messages=new GroupRunMessageService(pool,identity,stub.ports)
 const saved=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'资料已满。',files:[{path:'报告.md',sha256:sha('# 研判结论')}]})
 assert.equal(saved.references.length,8)
 assert.ok(!saved.references.some(item=>item.kind==='artifact'))
 assert.equal(saved.text,'【有 1 件文件未能贴出。】\n\n资料已满。')
 // 整段跳过定版：不落快照、不留没人引用的成果。
 assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
 assert.deepEqual(stub.reported,['teloa/conflict'])
})

test('回帖被拒或写入失败时，自动定版的成果与快照一并回滚',async()=>{
 const denied=await ended(false),stub=workspace({'报告.md':'# 研判结论'})
 const files=[{path:'报告.md',sha256:sha('# 研判结论')}]
 await assert.rejects(new GroupRunMessageService(pool,identity,stub.ports).post(denied.owner,{requestId:randomUUID(),runId:denied.run.id,text:'不应发送。',files}),{code:'teloa/forbidden'})
 assert.deepEqual(await counts(denied.owner),{snapshots:0,versions:0,attachments:0})
 const f=await ended()
 await pool.query("create function reject_group_run_message_test() returns trigger language plpgsql as $$ begin raise exception 'message unavailable'; end $$;create trigger reject_group_run_message_test before insert on teloa_group_messages for each row when (new.author_id<>'self') execute function reject_group_run_message_test()")
 try{
  await assert.rejects(new GroupRunMessageService(pool,identity,stub.ports).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'写入会失败。',files}),/message unavailable/)
  assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
 }finally{await pool.query('drop trigger reject_group_run_message_test on teloa_group_messages;drop function reject_group_run_message_test()')}
})

test('任务已结项后不再为本次运行自动定版，但正文照发并前置未贴出提示',async()=>{
 const f=await ended(),stub=workspace({'报告.md':'# 研判结论'})
 await pool.query("update teloa_tasks set state='completed' where owner_id=$1 and id=$2",[f.owner,f.run.taskId])
 // 任务已结项是 `taskArtifactSource(…,true)` 抛的 teloa/conflict。它必须与别的定版失败同等降级：
 // 若原样上抛就会穿过保存点回滚整条 post，再被 `task-run-group-publisher` 吞掉，连同事的正文一起丢。
 const saved=await new GroupRunMessageService(pool,identity,stub.ports).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'已结项。',files:[{path:'报告.md',sha256:sha('# 研判结论')}]})
 assert.equal(saved.text,'【有 1 件文件未能贴出。】\n\n已结项。')
 assert.ok(!saved.references.some(item=>item.kind==='artifact'))
 assert.deepEqual(stub.reported,['teloa/conflict'])
 assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
})

test('不带文件的回帖指纹与本次变更之前逐字相同，旧回执重放仍返回同一条',async()=>{
 const f=await ended(),messages=new GroupRunMessageService(pool,identity),input={requestId:randomUUID(),runId:f.run.id,text:'不带文件的回帖。'}
 const saved=await messages.post(f.owner,input)
 const stored=(await pool.query('select request_spec from teloa_group_messages where owner_id=$1 and id=$2',[f.owner,saved.id])).rows[0].request_spec
 assert.deepEqual(stored,{kind:'teloa.group-run-message/v1',runId:f.run.id,text:input.text})
 assert.deepEqual(await messages.post(f.owner,input),saved)
 // 显式给空数组与不给是同一个请求，不因多一个键判冲突。
 assert.deepEqual(await messages.post(f.owner,{...input,files:[]}),saved)
})

test('同一运行换一组文件另定一版，同一组文件重放仍是同一版',async()=>{
 const f=await ended(),stub=workspace({'报告.md':'# 研判结论','图表.csv':'a,b\n1,2'})
 // 递增时钟：定版的任何字段都不能取当前时刻，否则两帖会因标题不同而判冲突。
 let tick=0
 const messages=new GroupRunMessageService(pool,{id:randomUUID,now:()=>new Date(Date.parse('2026-09-18T09:00:00.000Z')+(tick++)*60000).toISOString()},stub.ports)
 const first=[{path:'报告.md',sha256:sha('# 研判结论')}],second=[...first,{path:'图表.csv',sha256:sha('a,b\n1,2')}]
 const one=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'第一帖。',files:first})
 const again=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'第一帖重放。',files:first})
 const two=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'第二帖。',files:second})
 const oneRef=one.references.find(item=>item.kind==='artifact'),againRef=again.references.find(item=>item.kind==='artifact'),twoRef=two.references.find(item=>item.kind==='artifact')
 if(!oneRef||!againRef||!twoRef)throw Error('成果引用缺失')
 assert.deepEqual(againRef,oneRef)
 assert.notEqual(twoRef.id,oneRef.id)
 assert.deepEqual(await counts(f.owner),{snapshots:2,versions:2,attachments:0})
})

test('端口回的会话或路径与声明不符时不定版，只计失败并记位置码',async()=>{
 const f=await ended(),reported:string[]=[]
 const ports={
  readClaimedFile:async(_sessionId:string,claim:GroupRunFileClaim):Promise<ArtifactFile>=>({...snapshot('another-session','别的文件.md','x'),sha256:claim.sha256}),
  report:(code:string)=>{reported.push(code)}
 }
 const saved=await new GroupRunMessageService(pool,identity,ports).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'结论照发。',files:[{path:'报告.md',sha256:sha('# 研判结论')}]})
 assert.equal(saved.text,'【有 1 件文件未能贴出。】\n\n结论照发。')
 assert.ok(!saved.references.some(item=>item.kind==='artifact'))
 assert.deepEqual(reported,['teloa/file-changed'])
 assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
})

test('定版本身被成果服务拒绝时只丢文件，正文照发且不留孤儿快照',async()=>{
 const f=await ended(),reported:string[]=[]
 // 两条不同路径解析到同一个文件身份（软链的形状）：成果服务按重复引用拒为 teloa/invalid-input。
 const ports={
  readClaimedFile:async(sessionId:string,claim:GroupRunFileClaim):Promise<ArtifactFile>=>({...snapshot(sessionId,claim.path,claim.path),id:sha('同一个真实目标'),sha256:claim.sha256}),
  report:(code:string)=>{reported.push(code)}
 }
 const files=[{path:'报告.md',sha256:sha('报告.md')},{path:'副本.md',sha256:sha('副本.md')}]
 const saved=await new GroupRunMessageService(pool,identity,ports).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'定版失败也要发。',files})
 assert.equal(saved.text,'【有 2 件文件未能贴出。】\n\n定版失败也要发。')
 assert.ok(!saved.references.some(item=>item.kind==='artifact'))
 assert.deepEqual(reported,['teloa/invalid-input'])
 assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
})

test('声明文件合计越过成果总量上限时只剔除越界那件',async()=>{
 const f=await ended(),reported:string[]=[]
 // 路径排序让小文件先进预算：越界的那件正好卡在「已用量 ＋ 本件 > 上限」上，钉住的是累加而不是单件闸。
 const huge={path:'超量.json',sha256:sha('超量')},small={path:'报告.md',sha256:sha('# 研判结论')}
 const ports={
  readClaimedFile:async(sessionId:string,claim:GroupRunFileClaim):Promise<ArtifactFile>=>claim.path===huge.path
   // 单个文件的 8 MiB 闸在端口里，这里只造「合计越界」的形状：它在预算判否后就被剔除，不会走到落盘校验。
   ?{...snapshot(sessionId,claim.path,'超量'),bytes:artifactFileTotalBytes}
   :snapshot(sessionId,claim.path,'# 研判结论'),
  report:(code:string)=>{reported.push(code)}
 }
 const saved=await new GroupRunMessageService(pool,identity,ports).post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'合计越界。',files:[small,huge]})
 assert.equal(saved.text,'【有 1 件文件未能贴出。】\n\n合计越界。')
 assert.deepEqual(reported,['teloa/file-too-large'])
 const reference=saved.references.find(item=>item.kind==='artifact')
 if(!reference)throw Error('成果引用缺失')
 assert.deepEqual(await counts(f.owner),{snapshots:1,versions:1,attachments:0})
})

test('复用已定的那一版不重新现读，且按它实际收了几件反推未贴出件数',async()=>{
 const f=await ended(),reported:string[]=[]
 let reads=0
 // 每次现读的 capturedAt 都不同：没有复用分支，第二帖会因内容不同被判冲突。
 const ports={
  readClaimedFile:async(sessionId:string,claim:GroupRunFileClaim):Promise<ArtifactFile>=>{
   reads++
   if(claim.path==='缺失.md')throw new WorkError('teloa/file-scope','该文件不在可选产物范围内。')
   return {...snapshot(sessionId,claim.path,'# 研判结论'),capturedAt:new Date(Date.parse('2026-09-18T09:00:00.000Z')+reads*1000).toISOString(),sha256:claim.sha256}
  },
  report:(code:string)=>{reported.push(code)}
 }
 const messages=new GroupRunMessageService(pool,identity,ports)
 const files=[{path:'报告.md',sha256:sha('# 研判结论')},{path:'缺失.md',sha256:sha('缺失')}]
 const first=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'第一帖。',files})
 assert.equal(first.text,'【有 1 件文件未能贴出。】\n\n第一帖。')
 const readsAfterFirst=reads
 const second=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'第二帖。',files})
 assert.equal(reads,readsAfterFirst)
 // 第一帖漏掉的那件，第二帖不能谎报成全都贴出了。
 assert.equal(second.text,'【有 1 件文件未能贴出。】\n\n第二帖。')
 assert.deepEqual(second.references.find(item=>item.kind==='artifact'),first.references.find(item=>item.kind==='artifact'))
 assert.deepEqual(await counts(f.owner),{snapshots:1,versions:1,attachments:0})
})

test('同内容不同路径的两帖各自定版，不互撞成同一个请求身份',async()=>{
 const f=await ended(),stub=workspace({'报告.md':'同一份内容','副本.md':'同一份内容'})
 const messages=new GroupRunMessageService(pool,identity,stub.ports)
 const one=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'原件。',files:[{path:'报告.md',sha256:sha('同一份内容')}]})
 const two=await messages.post(f.owner,{requestId:randomUUID(),runId:f.run.id,text:'另一条路径。',files:[{path:'副本.md',sha256:sha('同一份内容')}]})
 const oneRef=one.references.find(item=>item.kind==='artifact'),twoRef=two.references.find(item=>item.kind==='artifact')
 if(!oneRef||!twoRef)throw Error('成果引用缺失')
 assert.notEqual(twoRef.id,oneRef.id)
 assert.equal(one.text,'原件。');assert.equal(two.text,'另一条路径。')
 assert.deepEqual(await counts(f.owner),{snapshots:2,versions:2,attachments:0})
})

test('15秒真实依赖超时后自然退避，新连接与观察器只补发合成长结果及双文件一次',{timeout:60000},async t=>{
 // 合成的已完成 Run 只验证发布恢复机制；不冒充实模执行或正式宿主冷启。
 const f=await fixture(true,1,'main'),clock={...identity,now:()=>new Date().toISOString()},key={sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId}
 const bodies={'恢复报告.md':'# 恢复报告\n\n两件原声明文件按原字节恢复。','恢复数据.csv':'key,value\nfirst,1\nsecond,2\n'},claims=Object.entries(bodies).map(([path,text])=>({path,sha256:sha(text)}))
 await f.runs.claim(f.owner,{runId:f.run.id})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 const manifest=new GroupRunResultManifestService(pool)
 for(const claim of claims)await manifest.declare(f.owner,{...key,claim})
 await f.runs.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:1,endSeq:3,reason:'completed'}})
 const text='合成恢复正文🙂：只核验同一结果与两件文件的持久发布。\n'.repeat(600)+'原结果末尾必须保留。'
 assert.ok(text.length>8000)
 const nativeEvents=[
  {seq:0,time:0,type:'turn/start',data:{turn:1}},
  {seq:1,time:1,type:'user/message',surfaceOp:'append',data:{id:'synthetic-request',role:'user',source:{kind:'user',rpcId:f.run.nativeRequestId},content:[]}},
  {seq:2,time:2,type:'assistant/message',surfaceOp:'append',data:{turn:1,step:1,message:{id:'synthetic-answer',role:'assistant',content:[{type:'text',text}]},stream:[]}},
  {seq:3,time:3,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}},
 ] as unknown as Awaited<ReturnType<ConstructorParameters<typeof TaskRunDriver>[1]['events']>>
 const before=(await pool.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,f.run.id])).rows[0]
 const calls:Array<{requestId:string;runId:string;text:string;files?:GroupRunFileClaim[]}>=[],ports=workspace(bodies)
 const make=(connection:Pool)=>{
  const service=new TaskRunService(connection,clock,async()=>({id:randomUUID(),sessionId:f.run.sessionId,ownerId:f.owner,status:'ready'}),{allowedTools:[]})
  const messages=new GroupRunMessageService(connection,clock,ports.ports),saved=new GroupRunResultManifestService(connection)
  const publish=createTaskRunGroupPublisher({post:input=>{calls.push(input);return messages.post(f.owner,input)},run:(sessionId,nativeRequestId)=>saved.read(f.owner,{sessionId,nativeRequestId}),failure:(run,code)=>messages.failure(f.owner,{runId:run.id,nativeRequestId:run.nativeRequestId,code}),report:()=>assert.fail('暂时依赖故障不能被当成授权拒绝')})
  return {service,driver:new TaskRunDriver(service,{check:async()=>assert.fail('恢复不重新检查或启动模型'),send:async()=>assert.fail('恢复不发新模型请求'),stop:async()=>assert.fail('恢复不停止原结束 Run'),events:async()=>nativeEvents,publishGroupResult:publish})}
 }
 const connection={connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:5000,statement_timeout:15000},first=new Pool(connection)
 let closeFirst=true
 t.after(async()=>{if(closeFirst)await first.end()})
 const old=make(first),lock=await pool.connect()
 try{
  await lock.query('begin')
  await lock.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-run-message',f.owner,f.run.nativeRequestId])])
  const started=Date.now()
  await assert.rejects(old.driver.reconcile(f.owner,{runId:f.run.id}),{code:'57014'},'必须等到真正的 PostgreSQL statement_timeout，不在超时前放锁')
  assert.ok(Date.now()-started>=14000)
  const failed=(await pool.query('select state,evidence,group_publication,group_publication_next_at from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,f.run.id])).rows[0]
  assert.equal(failed.state,'ended');assert.deepEqual(failed.evidence,before.evidence)
  assert.deepEqual({...failed.group_publication,at:undefined},{state:'retrying',code:'teloa/dependency-unavailable',attempts:1,at:undefined})
  assert.equal(failed.group_publication_next_at.getTime()-Date.parse(failed.group_publication.at),2000)
  assert.deepEqual(await old.service.outstanding(f.owner),[],'真实退避窗口内不重试，不能 SQL 改时钟')
  assert.equal((await f.groups.messages(f.owner,{groupId:f.group.id})).filter(m=>'runId' in m).length,0)
  assert.deepEqual(await counts(f.owner),{snapshots:0,versions:0,attachments:0})
  assert.deepEqual((await manifest.read(f.owner,key)).files,claims)
 }finally{await lock.query('rollback');lock.release()}
 await first.end();closeFirst=false
 const fresh=new Pool(connection),restarted=make(fresh),reports:string[]=[]
 t.after(()=>fresh.end())
 const close=monitorTaskRuns({list:()=>restarted.service.outstanding(f.owner),reconcile:id=>restarted.driver.reconcile(f.owner,{runId:id}),report:(_id,code)=>reports.push(code)})
 t.after(close)
 const deadline=Date.now()+10000
 let posted=(await f.groups.messages(f.owner,{groupId:f.group.id})).filter(m=>'runId' in m)
 while(!posted.length&&Date.now()<deadline){await new Promise(resolve=>setTimeout(resolve,100));posted=(await f.groups.messages(f.owner,{groupId:f.group.id})).filter(m=>'runId' in m)}
 await close()
 assert.equal(posted.length,1);const message=posted[0]!
 assert.deepEqual(await f.groups.messageBody(f.owner,{groupId:f.group.id,messageId:message.id}),{groupId:f.group.id,messageId:message.id,text,chars:text.length,sha256:sha(text)})
 const reference=message.references.find(r=>r.kind==='artifact');assert.ok(reference)
 const content=(await pool.query('select content from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[f.owner,reference.id,reference.version])).rows[0].content
 const files=(await pool.query('select content from teloa_artifact_snapshots where owner_id=$1 and snapshot_id=any($2)',[f.owner,content.snapshotIds])).rows.map(row=>row.content)
 assert.equal(files.length,2)
 for(const [path,body] of Object.entries(bodies)){const file=files.find(f=>f.path===path);assert.ok(file);assert.equal(file.sha256,sha(body));assert.equal(Buffer.from(file.contentBase64,'base64').toString(),body)}
 await restarted.driver.reconcile(f.owner,{runId:f.run.id})
 assert.equal((await f.groups.messages(f.owner,{groupId:f.group.id})).filter(m=>'runId' in m).length,1)
 assert.deepEqual(await counts(f.owner),{snapshots:2,versions:1,attachments:0})
 assert.deepEqual(await restarted.service.outstanding(f.owner),[]);assert.deepEqual(reports,[])
 assert.equal(calls.length,3,'一次真实超时、一次观察器成功、一次同结果幂等核对')
 assert.ok(calls.every(c=>c.requestId===f.run.nativeRequestId&&c.runId===f.run.id&&c.text===text&&JSON.stringify(c.files)===JSON.stringify(claims)))
 const after=(await pool.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,f.run.id])).rows[0]
 assert.deepEqual(after,{...before,group_publication:null,group_publication_next_at:null},'恢复只清待发布回执，不改原 Run 及其结束证据')
})
