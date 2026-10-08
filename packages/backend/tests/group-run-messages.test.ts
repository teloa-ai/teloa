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
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
const openGroupRules={historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true}

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date('2026-09-18T09:00:00.000Z').toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeGroupTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeGroupAttachments(pool)
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

async function fixture(canPost=true,resourceCount=1){
 const owner=randomUUID(),roles=new RoleService(pool,identity),tasks=new TaskService(pool,identity),groups=new CollaborationService(pool,identity),grants=new GroupAgentGrantService(pool,identity.now)
 const role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'SOC 研判员',kind:'employee',scopes:['SOC'],duty:'研判固定告警资料',dataScope:'固定资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'soc-analyst'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const activeRole={...role,state:'active' as const,version:2}
 const group=await groups.create(owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'SOC 研判群',scope:'SOC',announcement:'仅使用已固定资料。',rules:openGroupRules,memberRoleIds:[role.id]}})
 const resources=[]
 for(let index=1;index<=resourceCount;index++)resources.push(await groups.saveResource(owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:`EDR 告警证据 ${index}`,markdown:`# alert-00${index}\n\n进程树与主机证据。`}))
 const resource=resources[0]!,grantResources=resources.map(item=>({kind:'group-resource' as const,id:item.id,version:item.version}))
 const root=await groups.send(owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'请分析 alert-001 的影响。',references:grantResources})
 await grants.change(owner,{requestId:randomUUID(),groupId:group.id,roleId:role.id,expectedGroupVersion:group.version,expectedRoleVersion:2,action:'save',resources:grantResources,canPost,canAutoRun:false})
 const created=await new GroupTaskService(pool,identity,tasks).create(owner,{requestId:randomUUID(),groupId:group.id,messageId:root.id,expectedGroupVersion:group.version,goal:'给出可审计的研判结论。',assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:created.task.id,expectedObjectVersion:created.task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[],groupContext:(db,actor,task,currentRole)=>import('../src/work/task-run-group-context.ts').then(({readRunGroupContext})=>readRunGroupContext(db,actor,task,currentRole))})
 const run=await runs.prepare(owner,{requestId:randomUUID(),taskId:created.task.id,expectedTaskVersion:created.task.version,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 return {owner,groups,grants,group,resource,root,role:activeRole,runs,run}
}

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
