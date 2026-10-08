import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {createHash,randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {TaskAttentionService} from '../src/work/task-attention.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {initializeRoleMemoryViews,RoleMemoryViewService} from '../src/work/role-memory-views.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeMarkdownKnowledge} from '../src/capabilities/markdown-knowledge.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeMarkdownKnowledge(pool);await initializeRoleMemory(pool);await initializeCollaboration(pool);await initializeRoleMemoryViews(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(kind:'employee'|'twin'='employee',scope='SOC'){
 const owner=randomUUID(),roleService=new RoleService(pool,identity)
 const created=await roleService.create(owner,{requestId:randomUUID(),fields:{name:kind==='twin'?'我的分身':'调查岗',kind,scopes:[scope],duty:'核对来源',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[created.id])
 const role=(await roleService.list(owner,{}))[0]!
 const task=kind==='employee'?await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'季度复盘',goal:'核对处置记录',scope},assignee:{roleId:role.id,expectedVersion:2}}):undefined
 return {owner,role,task,service:new RoleMemoryService(pool,identity),human:{ownerId:owner,kind:'human' as const}}
}

async function memoryViewFixture(){
 const f=await fixture('twin','general'),groupId=randomUUID(),views=new RoleMemoryViewService(pool,identity,f.service)
 await pool.query("insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at) values($1,$2,$3,'{}',$4,1,false,false,now(),now())",[groupId,f.owner,randomUUID(),JSON.stringify({name:'协作群',scope:'general',announcement:'',memberRoleIds:[f.role.id]})])
 await pool.query('insert into teloa_group_members(group_id,owner_id,member_key,role_id,created_at) values($1,$2,$3::text,$3::uuid,now())',[groupId,f.owner,f.role.id])
 const candidate=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'可分享经验',markdown:'仅分享这一条固定经验。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 const memory=await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1}),entries=[{memoryId:memory.id,memoryVersion:memory.content.version,contentSha256:memory.content.contentHash}]
 return {...f,groupId,views,memory,input:{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,groupId,entries}}
}

test('共享视图真实持久化且幂等，只读取固定项并保持原记忆私有',async()=>{
 const f=await memoryViewFixture(),view=await f.views.create(f.owner,f.input)
 assert.deepEqual(await new RoleMemoryViewService(pool,identity,new RoleMemoryService(pool,identity)).read(f.owner,{viewId:view.id}),view)
 assert.deepEqual(await f.views.create(f.owner,f.input),view)
 await assert.rejects(f.views.create(f.owner,{...f.input,entries:[{...f.input.entries[0],contentSha256:'0'.repeat(64)}]}),{code:'teloa/conflict'})
 const privateQueries:string[]=[],db={query:(async(text:string,values:unknown[])=>{if(text.includes('teloa_role_memor'))privateQueries.push(text);return pool.query(text,values)}) as Pool['query']}
 assert.deepEqual(await f.service.confirmedForRun(db,f.owner,{scope:'general',groupId:f.groupId,memoryViewId:null},f.role),[])
 assert.equal(privateQueries.length,0)
 const selected=await f.service.confirmedForRun(db,f.owner,{scope:'general',groupId:f.groupId,memoryViewId:view.id},f.role)
 assert.deepEqual(selected.map(memory=>[memory.id,memory.visibility.kind]),[[f.memory.id,'private']])
 assert.ok(privateQueries.find(text=>text.includes('from teloa_role_memories'))?.includes('id=any($3::uuid[])'))
 assert.equal((await f.service.list(f.human,{roleId:f.role.id}))[0]!.visibility.kind,'private')
 await assert.rejects(f.service.confirmedForRun(pool,f.owner,{scope:'general',groupId:randomUUID(),memoryViewId:view.id},f.role),{code:'teloa/forbidden'})
 await assert.rejects(f.views.read(randomUUID(),{viewId:view.id}),{code:'teloa/forbidden'})
 await assert.rejects(pool.query('update teloa_role_memory_views set version=1 where owner_id=$1 and id=$2',[f.owner,view.id]),/immutable/)
})

test('共享视图拒绝候选、跨本人、未知项以及不匹配的版本或摘要',async()=>{
 const f=await memoryViewFixture(),fresh=(entries:unknown)=>f.views.create(f.owner,{...f.input,requestId:randomUUID(),entries})
 const candidate=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'未确认偏好',markdown:'本人尚未决定。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 for(const entry of [{memoryId:candidate.id,memoryVersion:1,contentSha256:candidate.content.contentHash},{...f.input.entries[0],memoryId:randomUUID()},{...f.input.entries[0],memoryVersion:2},{...f.input.entries[0],contentSha256:'0'.repeat(64)}])await assert.rejects(fresh([entry]),{code:'teloa/version-conflict'})
 const other=await memoryViewFixture()
 await assert.rejects(fresh(other.input.entries),{code:'teloa/version-conflict'})
 await assert.rejects(fresh([f.input.entries[0],f.input.entries[0]]),{code:'teloa/invalid-input'})
 await assert.rejects(f.views.create(f.owner,{...f.input,ownerId:other.owner}),{code:'teloa/invalid-input'})
 await assert.rejects(f.views.create(f.owner,{...f.input,expectedRoleVersion:3}),{code:'teloa/version-conflict'})
 await assert.rejects(f.views.create(f.owner,{...f.input,groupId:other.groupId}),{code:'teloa/forbidden'})
})

test('视图读取消费拒绝岗位改版、移出群、归档和固定记忆撤回',async()=>{
 const f=await memoryViewFixture(),view=await f.views.create(f.owner,f.input),read=()=>f.views.read(f.owner,{viewId:view.id})
 await pool.query('update teloa_roles set version=3 where id=$1',[f.role.id]);await assert.rejects(read(),{code:'teloa/version-conflict'})
 await pool.query('update teloa_roles set version=2 where id=$1',[f.role.id])
 await pool.query('delete from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3',[f.owner,f.groupId,f.role.id]);await assert.rejects(read(),{code:'teloa/forbidden'})
 await pool.query('insert into teloa_group_members(group_id,owner_id,member_key,role_id,created_at) values($1,$2,$3::text,$3::uuid,now())',[f.groupId,f.owner,f.role.id])
 await pool.query('update teloa_groups set archived=true where id=$1',[f.groupId]);await assert.rejects(read(),{code:'teloa/forbidden'})
 await pool.query('update teloa_groups set archived=false where id=$1',[f.groupId])
 await f.service.withdraw(f.human,{requestId:randomUUID(),memoryId:f.memory.id,expectedStateVersion:2})
 await assert.rejects(read(),{code:'teloa/version-conflict'})
 await assert.rejects(f.service.confirmedForRun(pool,f.owner,{scope:'general',groupId:f.groupId,memoryViewId:view.id},f.role),{code:'teloa/version-conflict'})
 assert.deepEqual(await f.views.create(f.owner,f.input),view)
})

test('分身新运行只读本人已确认私有记忆，旧缺选择调用不能取得私有正文',async()=>{
 const f=await fixture('twin','general'),candidate=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'本人偏好',markdown:'先列证据再写结论。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}})
 await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})
 const selected=await f.service.confirmedForRun(pool,f.owner,{scope:'general',memoryViewId:null,groupId:null},f.role)
 assert.deepEqual(selected.map(item=>[item.id,item.visibility.kind]),[[candidate.id,'private']])
 await assert.rejects(f.service.confirmedForRun(pool,f.owner,{scope:'general'},f.role),{code:'teloa/forbidden'})
 await assert.rejects(f.service.confirmedForRun(pool,f.owner,{scope:'',memoryViewId:null,groupId:null},f.role),{code:'teloa/forbidden'})
 assert.deepEqual(await f.service.confirmedForRun(pool,f.owner,{scope:'general',memoryViewId:null,groupId:randomUUID()},f.role),[])
})

test('员工历史字符串范围仍按岗位记忆读取',async()=>{
 const f=await fixture(),memory=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'经验',markdown:'核对证据。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1})
 assert.deepEqual((await f.service.confirmedForRun(pool,f.owner,'SOC',f.role)).map(item=>item.id),[memory.id])
})

test('分身可为自己的真实运行提出私有经验候选，仍不能确认或引用另一岗位运行',async()=>{
 const f=await fixture('twin','general'),runId=randomUUID(),taskId=randomUUID()
 await pool.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,'{}',$4,1,'ready',$5,2,now(),now())",[taskId,f.owner,randomUUID(),JSON.stringify({title:'分身任务',goal:'核对资料',scope:'general',priority:'normal',dueAt:null,projectId:null,groupId:null,participants:[]}),f.role.id])
 await pool.query("insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at) values($1,$2,$3,'{}',$4,$5,1,2,1,$6,$7,'active',$8,now())",[runId,f.owner,randomUUID(),taskId,f.role.id,'twin-memory-'+runId,randomUUID(),JSON.stringify({task:{id:taskId,version:1,title:'分身任务',goal:'核对资料',scope:'general'}})])
 const input={requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'运行经验',markdown:'本轮实际核对后形成的经验。',source:{kind:'run',id:runId,version:1},visibility:{kind:'private',scopeIds:[]}},agent={ownerId:f.owner,kind:'agent' as const,roleId:f.role.id}
 const memory=await f.service.create(agent,input)
 assert.equal(memory.state,'candidate');assert.equal(memory.visibility.kind,'private')
 await assert.rejects(f.service.confirm(agent,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1}),{code:'teloa/forbidden'})
 await pool.query('update teloa_task_runs set role_id=$2 where id=$1',[runId,(await fixture()).role.id])
 await assert.rejects(f.service.create(agent,{...input,requestId:randomUUID()}),{code:'teloa/forbidden'})
})

test('候选正文与任务来源固定，重复请求幂等且跨本人不可读',async()=>{
 const f=await fixture(),requestId=randomUUID(),input={requestId,roleId:f.role.id,expectedRoleVersion:2,title:'交付前核对来源',markdown:'交付前必须核对来源版本。',source:{kind:'task' as const,id:f.task!.id,version:1},visibility:{kind:'role' as const,scopeIds:['SOC']}}
 const first=await f.service.create(f.human,input),replay=await f.service.create(f.human,input)
 assert.deepEqual(replay,first);assert.equal(first.state,'candidate');assert.equal(first.stateVersion,1);assert.equal(first.sourceTitle,'季度复盘');assert.equal(first.sourceAvailable,true)
 assert.equal(first.content.version,1);assert.equal(first.content.contentHash,createHash('sha256').update(input.markdown).digest('hex'));assert.equal(first.content.markdown,input.markdown)
 assert.deepEqual(await f.service.list(f.human,{roleId:f.role.id}),[first])
 await assert.rejects(f.service.list({ownerId:randomUUID(),kind:'human'},{roleId:f.role.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.service.create(f.human,{...input,title:'另一个候选'}),{code:'teloa/conflict'})
})

test('只有本人可确认，撤回保留正文与确认历史且重复决定不生成新状态',async()=>{
 const f=await fixture(),memory=await f.service.create({ownerId:f.owner,kind:'agent',roleId:f.role.id},{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'核对异常关闭原因',markdown:'关闭异常前确认处置证据。',source:{kind:'task',id:f.task!.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 assert.deepEqual(memory.proposedBy,{kind:'role',roleId:f.role.id,roleVersion:2})
 await assert.rejects(f.service.confirm({ownerId:f.owner,kind:'agent',roleId:f.role.id},{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1}),{code:'teloa/forbidden'})
 const confirmInput={requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1},confirmed=await f.service.confirm(f.human,confirmInput)
 assert.equal(confirmed.state,'confirmed');assert.equal(confirmed.stateVersion,2);assert.ok(confirmed.confirmedAt);assert.deepEqual(await f.service.confirm(f.human,confirmInput),confirmed)
 const withdrawn=await f.service.withdraw(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:2})
 assert.equal(withdrawn.state,'withdrawn');assert.equal(withdrawn.stateVersion,3);assert.equal(withdrawn.confirmedAt,confirmed.confirmedAt);assert.deepEqual(withdrawn.content,confirmed.content);assert.ok(withdrawn.withdrawnAt)
 assert.deepEqual(await f.service.confirm(f.human,confirmInput),confirmed)
 await assert.rejects(f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:3}),{code:'teloa/conflict'})
})

test('创建回执先于当前岗位与来源核验，确认和改版后仍精确重放首次 candidate',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'固定候选回执',markdown:'创建回执不跟随当前状态变化。',source:{kind:'task' as const,id:f.task!.id,version:1},visibility:{kind:'role' as const,scopeIds:['SOC']}}
 const candidate=await f.service.create(f.human,input)
 await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})
 await pool.query('update teloa_tasks set version=2 where id=$1',[f.task!.id]);await pool.query('update teloa_roles set version=3 where id=$1',[f.role.id])
 assert.deepEqual(await f.service.create(f.human,input),candidate)
 await pool.query('alter table teloa_role_memory_creations disable trigger teloa_role_memory_creations_immutable')
 await pool.query('delete from teloa_role_memory_creations where owner_id=$1 and request_id=$2',[f.owner,input.requestId])
 await pool.query('alter table teloa_role_memory_creations enable trigger teloa_role_memory_creations_immutable')
 await initializeRoleMemory(pool)
 assert.deepEqual(await f.service.create(f.human,input),candidate)
})

test('旧状态回执缺少 result 时稳定拒绝重放，当前记忆仍可读取',async()=>{
 const f=await fixture(),memory=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'旧回执',markdown:'正文仍可读取。',source:{kind:'task',id:f.task!.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}}),request={requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1}
 await f.service.confirm(f.human,request)
 await pool.query('alter table teloa_role_memory_changes disable trigger teloa_role_memory_changes_immutable')
 await pool.query('update teloa_role_memory_changes set result=null where owner_id=$1 and request_id=$2',[f.owner,request.requestId])
 await pool.query('alter table teloa_role_memory_changes enable trigger teloa_role_memory_changes_immutable')
 await assert.rejects(f.service.confirm(f.human,request),{code:'teloa/conflict'})
 assert.equal((await f.service.list(f.human,{roleId:f.role.id}))[0]?.state,'confirmed')
})

test('数字员工记忆只能使用相容岗位范围，分身判断力样本只能本人提出并保持私有',async()=>{
 const employee=await fixture(),base={requestId:randomUUID(),roleId:employee.role.id,expectedRoleVersion:2,title:'边界',markdown:'只在相同业务范围内引用。',source:{kind:'task' as const,id:employee.task!.id,version:1}}
 await assert.rejects(employee.service.create(employee.human,{...base,visibility:{kind:'private',scopeIds:[]}}),{code:'teloa/invalid-input'})
 await assert.rejects(employee.service.create(employee.human,{...base,requestId:randomUUID(),visibility:{kind:'role',scopeIds:['general']}}),{code:'teloa/forbidden'})
 await assert.rejects(employee.service.create({ownerId:employee.owner,kind:'agent',roleId:employee.role.id},{...base,requestId:randomUUID(),source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}}),{code:'teloa/forbidden'})
 const twin=await fixture('twin','general'),privateInput={requestId:randomUUID(),roleId:twin.role.id,expectedRoleVersion:2,title:'本人偏好',markdown:'建议先列出证据缺口。',source:{kind:'self-feedback' as const,id:randomUUID(),version:1},visibility:{kind:'private' as const,scopeIds:[]}}
 const saved=await twin.service.create(twin.human,privateInput);assert.equal(saved.visibility.kind,'private')
 await assert.rejects(twin.service.create({ownerId:twin.owner,kind:'agent',roleId:twin.role.id},{...privateInput,requestId:randomUUID(),source:{...privateInput.source,id:randomUUID()}}),{code:'teloa/forbidden'})
 await assert.rejects(twin.service.create(twin.human,{...privateInput,requestId:randomUUID(),source:{...privateInput.source,id:randomUUID()},visibility:{kind:'role',scopeIds:['general']}}),{code:'teloa/invalid-input'})
})

test('运行只读取当时已确认且来源、岗位范围仍相容的记忆',async()=>{
 const f=await fixture(),candidate=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'复核来源',markdown:'先核对固定来源再交付。',source:{kind:'task',id:f.task!.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 assert.deepEqual(await f.service.confirmedForRun(pool,f.owner,{scope:'SOC'},f.role),[])
 const confirmed=await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1}),refs=await f.service.confirmedForRun(pool,f.owner,{scope:'SOC'},f.role)
 assert.deepEqual(refs,[{id:confirmed.id,version:1,title:confirmed.title,contentHash:confirmed.content.contentHash,markdown:confirmed.content.markdown,source:confirmed.source,visibility:confirmed.visibility}])
 assert.deepEqual(await f.service.confirmedForRun(pool,f.owner,{scope:'general'},{...f.role,scopes:['SOC','general']}),[])
 await pool.query("update teloa_tasks set version=2 where id=$1",[f.task!.id])
 assert.deepEqual(await f.service.confirmedForRun(pool,f.owner,{scope:'SOC'},f.role),[])
 const listed=(await f.service.list(f.human,{roleId:f.role.id}))[0]!;assert.equal(listed.sourceAvailable,false);assert.equal(listed.content.markdown,confirmed.content.markdown)
})

test('正文版本和状态回执不可删除或改写',async()=>{
 const f=await fixture(),memory=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'不可变',markdown:'保留当时确认的正文。',source:{kind:'task',id:f.task!.id,version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 await assert.rejects(pool.query("update teloa_role_memory_versions set markdown='被替换' where memory_id=$1",[memory.id]),/immutable/)
 await assert.rejects(pool.query('delete from teloa_role_memory_versions where memory_id=$1',[memory.id]),/immutable/)
 await assert.rejects(pool.query("update teloa_role_memory_creations set result='{}' where memory_id=$1",[memory.id]),/immutable/)
 await assert.rejects(pool.query('delete from teloa_role_memory_creations where memory_id=$1',[memory.id]),/immutable/)
 const confirmed=await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1})
 await assert.rejects(pool.query('delete from teloa_role_memory_changes where memory_id=$1',[memory.id]),/immutable/)
 assert.equal((await f.service.list(f.human,{roleId:f.role.id}))[0]?.state,confirmed.state)
})

test('run、artifact、knowledge 来源逐类校验本人、当前版本和可见范围',async()=>{
 const f=await fixture(),now=identity.now()
 const runId=randomUUID(),runSnapshot={task:{id:f.task!.id,version:1,title:'运行取证',goal:'复核',scope:'SOC'}}
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at)
  values($1,$2,$3,'{}',$4,$5,1,2,1,$6,$7,'ended',$8,$9)`,[runId,f.owner,randomUUID(),f.task!.id,f.role.id,randomUUID(),randomUUID(),JSON.stringify(runSnapshot),now])
 const artifactId=randomUUID(),artifactSource={kind:'task',id:f.task!.id,scope:'SOC',version:'1',title:'季度复盘'},artifactContent={title:'固定成果',sections:[{id:'summary',title:'摘要',text:'已复核。'}],snapshotIds:[],note:'固定版本。'}
 await pool.query("insert into teloa_artifacts values($1,$2,$3,'{}','source',1)",[artifactId,f.owner,randomUUID()])
 await pool.query('insert into teloa_artifact_versions values($1,$2,1,$3,$4,$5)',[f.owner,artifactId,JSON.stringify(artifactSource),JSON.stringify(artifactContent),now])
 const knowledgeSourceId=randomUUID(),knowledgeId=randomUUID()
 await pool.query("insert into teloa_knowledge_sources values($1,$2,'paste',$3)",[knowledgeSourceId,f.owner,now])
 await pool.query("insert into teloa_knowledge_items(id,owner_id,request_id,request_spec,source_id,workspace_id,title,category,topics,scope_ids,current_version,status,created_at,updated_at) values($1,$2,$3,'{}',$4,'default','调查手册','sop','[]','[\"SOC\"]',1,'active',$5,$5)",[knowledgeId,f.owner,randomUUID(),knowledgeSourceId,now])
 await pool.query('insert into teloa_knowledge_versions(owner_id,knowledge_id,source_id,number,content_hash,bytes,markdown_path,created_at) values($1,$2,$3,1,$4,4,$5,$6)',[f.owner,knowledgeId,knowledgeSourceId,'a'.repeat(64),'owner/item/0001-a.md',now])
 const sources=[{kind:'run' as const,id:runId,version:1},{kind:'artifact' as const,id:artifactId,version:1},{kind:'knowledge' as const,id:knowledgeId,version:1}]
 const memories=[]
 for(const [index,source] of sources.entries()){
  await assert.rejects(f.service.create({...f.human,ownerId:randomUUID()},{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'越界',markdown:'不可读取。',source,visibility:{kind:'role',scopeIds:['SOC']}}),{code:'teloa/forbidden'})
  memories.push(await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'来源 '+index,markdown:'保留来源版本。',source,visibility:{kind:'role',scopeIds:['SOC']}}))
 }
 assert.deepEqual(memories.map(item=>item.sourceAvailable),[true,true,true])
 for(const memory of memories)await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1})
 const pendingKnowledge=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'待确认知识',markdown:'确认前再次核验来源。',source:sources[2]!,visibility:{kind:'role',scopeIds:['SOC']}})
 await pool.query("update teloa_task_runs set state='withdrawn' where id=$1",[runId])
 await pool.query('update teloa_artifacts set current_version=2 where id=$1',[artifactId])
 await pool.query("update teloa_knowledge_items set scope_ids='[\"general\"]' where owner_id=$1 and id=$2",[f.owner,knowledgeId])
 const listed=await f.service.list(f.human,{roleId:f.role.id})
 assert.deepEqual(listed.map(item=>item.sourceAvailable),[false,false,false,false])
 assert.deepEqual(await f.service.confirmedForRun(pool,f.owner,{scope:'SOC'},f.role),[])
 await assert.rejects(f.service.confirm(f.human,{requestId:randomUUID(),memoryId:pendingKnowledge.id,expectedStateVersion:1}),{code:'teloa/version-conflict'})
})

test('每个岗位范围最多确认三十条，新 Run 对超限数据确定性选择最近三十条',async()=>{
 const f=await fixture(),candidates=[]
 for(let index=0;index<31;index++)candidates.push(await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:`经验 ${String(index).padStart(2,'0')}`,markdown:`固定经验 ${index}`,source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}}))
 for(const memory of candidates.slice(0,29))await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1})
 const competing=await Promise.allSettled(candidates.slice(29).map(memory=>f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1})))
 assert.equal(competing.filter(item=>item.status==='fulfilled').length,1);assert.equal(competing.filter(item=>item.status==='rejected'&&(item.reason as {code?:string}).code==='teloa/conflict').length,1)
 const overflow=candidates[29+competing.findIndex(item=>item.status==='rejected')]!
 await pool.query("update teloa_role_memories set state='confirmed',state_version=2,confirmed_at=$2 where owner_id=$1 and id=$3",[f.owner,identity.now(),overflow.id])
 const expected=(await f.service.list(f.human,{roleId:f.role.id})).filter(item=>item.state==='confirmed').sort((a,b)=>b.confirmedAt!.localeCompare(a.confirmedAt!)||b.candidateAt.localeCompare(a.candidateAt)||a.id.localeCompare(b.id)).slice(0,30).map(item=>item.id),selected=await f.service.confirmedForRun(pool,f.owner,{scope:'SOC'},f.role)
 assert.equal(selected.length,30);assert.deepEqual(selected.map(item=>item.id),expected)
})

test('分身私有记忆最多确认三十条，撤回一条后原本超限的一条可再确认',async()=>{
 const f=await fixture('twin','general'),candidates=[]
 for(let index=0;index<31;index++)candidates.push(await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:`偏好 ${String(index).padStart(2,'0')}`,markdown:`固定偏好 ${index}`,source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}}))
 for(const memory of candidates.slice(0,30))await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:memory.id,expectedStateVersion:1})
 await assert.rejects(f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidates[30]!.id,expectedStateVersion:1}),{code:'teloa/conflict',message:'分身私有记忆最多确认 30 条；请先撤回不再适用的记忆。'})
 const withdrawn=await f.service.withdraw(f.human,{requestId:randomUUID(),memoryId:candidates[0]!.id,expectedStateVersion:2})
 assert.equal(withdrawn.state,'withdrawn')
 const confirmed=await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidates[30]!.id,expectedStateVersion:1})
 assert.equal(confirmed.state,'confirmed')
})

test('Run 固定已确认记忆，撤回后旧 Run 仍可读而新 Run 不再注入',async()=>{
 const f=await fixture(),candidate=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'固定经验',markdown:'交付前核对来源和适用范围。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 const confirmed=await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})
 const links=new ObjectConversationService(pool,async(_owner,sessionId)=>({id:'conversation-'+sessionId,sessionId,ownerId:f.owner,status:'ready'}),identity.now)
 const prepareTask=async(taskId:string,taskVersion:number)=>{
  const sessionId=randomUUID();await links.change(f.owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:taskVersion,sessionId,expectedLinkVersion:0,action:'link'})
  const service=new TaskRunService(pool,identity,async()=>({id:'conversation-'+sessionId,sessionId,ownerId:f.owner,status:'ready'}),{allowedTools:[],roleMemory:(db,owner,target,role)=>f.service.confirmedForRun(db,owner,target,role)})
  return {service,run:await service.prepare(f.owner,{requestId:randomUUID(),taskId,expectedTaskVersion:taskVersion,roleId:f.role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})}
 }
 const first=await prepareTask(f.task!.id,1)
 assert.deepEqual(first.run.memory,[{id:confirmed.id,version:1,title:confirmed.title,contentHash:confirmed.content.contentHash,markdown:confirmed.content.markdown,source:confirmed.source,visibility:confirmed.visibility}])
 assert.deepEqual(JSON.parse(first.run.inputText).memory.contents,first.run.memory)
 const changed=JSON.parse(first.run.inputText);changed.memory.contents[0].markdown='被替换的正文'
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[first.run.id,JSON.stringify(changed)])
 await assert.rejects(first.service.get(f.owner,{runId:first.run.id}),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[first.run.id,first.run.inputText])
 await pool.query("update teloa_task_runs set role_memory=jsonb_set(role_memory,'{0,contentHash}','\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"') where id=$1",[first.run.id])
 await assert.rejects(first.service.get(f.owner,{runId:first.run.id}),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_task_runs set role_memory=$2 where id=$1',[first.run.id,JSON.stringify(first.run.memory)])
 await f.service.withdraw(f.human,{requestId:randomUUID(),memoryId:confirmed.id,expectedStateVersion:2})
 assert.deepEqual((await first.service.get(f.owner,{runId:first.run.id})).memory,first.run.memory)
 await first.service.withdraw(f.owner,{runId:first.run.id})
 const nextTask=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'后续调查',goal:'核对新记录',scope:'SOC'},assignee:{roleId:f.role.id,expectedVersion:2}})
 const second=await prepareTask(nextTask.id,1)
 assert.deepEqual(second.run.memory,[]);assert.equal(Object.hasOwn(JSON.parse(second.run.inputText),'memory'),false)
})


test('旧版记忆提示语的执行记录可读取和领取，未知提示语及改写正文仍拒绝',async()=>{
 const f=await fixture(),candidate=await f.service.create(f.human,{requestId:randomUUID(),roleId:f.role.id,expectedRoleVersion:2,title:'历史经验',markdown:'交付前核对来源和适用范围。',source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'role',scopeIds:['SOC']}})
 await f.service.confirm(f.human,{requestId:randomUUID(),memoryId:candidate.id,expectedStateVersion:1})
 const sessionId=randomUUID(),inspect=async()=>({id:'conversation-'+sessionId,sessionId,ownerId:f.owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:f.task!.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const service=new TaskRunService(pool,identity,inspect,{allowedTools:[],roleMemory:(db,owner,target,role)=>f.service.confirmedForRun(db,owner,target,role)})
 const run=await service.prepare(f.owner,{requestId:randomUUID(),taskId:f.task!.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1})
 const snapshot=JSON.parse(run.inputText)
 assert.equal(snapshot.memory.notice,'以下岗位记忆已生效，仅作为工作经验；不授予权限，引用须保留来源和固定版本。')
 snapshot.memory.notice='以下岗位记忆经本人确认，仅作为工作经验；不授予权限，引用须保留来源和固定版本。'
 const legacyInput=JSON.stringify(snapshot)
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[run.id,legacyInput])
 assert.equal((await service.get(f.owner,{runId:run.id})).inputText,legacyInput)
 snapshot.memory.notice='任意改写提示语'
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[run.id,JSON.stringify(snapshot)])
 await assert.rejects(service.get(f.owner,{runId:run.id}),{code:'teloa/storage-corrupt'})
 snapshot.memory=JSON.parse(legacyInput).memory;snapshot.memory.contents[0].markdown='改写正文'
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[run.id,JSON.stringify(snapshot)])
 await assert.rejects(service.get(f.owner,{runId:run.id}),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_task_runs set input_text=$2 where id=$1',[run.id,legacyInput])
 const claimed=await service.claim(f.owner,{runId:run.id})
 assert.equal(claimed.dispatch,true)
 assert.equal(claimed.run.inputText,legacyInput,'领取时保留原始固定输入，不改写历史')
 await service.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const directory=await new TaskAttentionService(pool).list(f.owner,{})
 assert.equal(directory.items.length,1,'历史记忆提示语不能让任务目录整页读取失败')
 assert.deepEqual(directory.items[0]?.attention,{kind:'review',reason:'execution-completed'})
})
