import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {existsSync} from 'node:fs'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir,homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {ReferenceCatalog} from '@teloa/mcp-reference/catalog'
import {createPublicReferenceCatalog} from '@teloa/mcp-reference/local'
import {initializeResources} from '../src/capabilities/schema.ts'
import {ResourceService,type ResourceActor} from '../src/capabilities/resources.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeGroupTasks} from '../src/work/group-tasks.ts'
import {initializeGroupWorkInputs} from '../src/work/group-work-inputs.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
const file=new URL('../src/work/task-run-reference.ts',import.meta.url),tool='mcp__teloa_reference__read_reference',identity={id:randomUUID,now:()=>new Date().toISOString()}
let pool:Pool,container:StartedPostgreSqlContainer,root:string
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start();pool=new Pool({connectionString:container.getConnectionUri(),max:3});root=await mkdtemp(join(tmpdir(),'teloa-reference-pg-'));await initializeResources(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeGroupTasks(pool);await initializeGroupWorkInputs(pool);await initializeTaskRuns(pool)},{timeout:60000})
after(async()=>{await pool?.end();await container?.stop();if(root)await rm(root,{recursive:true,force:true})})
async function fixture(ownerOverride?:string){
 const owner=ownerOverride??randomUUID(),scope='general',actor:ResourceActor={ownerId:owner,kind:'human',scopeIds:[scope]},sourceId='local_material_'+randomUUID(),path=sourceId+'.md',text='本例固定知识正文。';await writeFile(join(root,path),text)
 const catalog=new ReferenceCatalog(root,[{id:sourceId,title:'本例知识',file:path}]),version=(await catalog.list()).references[0]!.version,resources=new ResourceService(pool,catalog,identity)
 const draft=await resources.create(actor,{requestId:randomUUID(),title:'本例知识',sourceId,sourceVersion:version,scopeIds:[scope]}),resource=await resources.apply(actor,{draftId:draft.id,expectedVersion:draft.version})
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'本例员工',kind:'employee',scopes:[scope],duty:'只读',dataScope:'本例资料',executionScope:'核对',skills:[],knowledge:[resource.id],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'test'}}});await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'本例核对',goal:'读取固定资料',scope},assignee:{roleId:role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect,{allowedTools:[tool],argumentRules:[{name:tool,allowed:[{id:sourceId,version}]}]}),run=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1},undefined,async()=>resources.executionKnowledge({ownerId:owner,kind:'agent',scopeIds:[scope]},[scope],[resource.id]));await runs.claim(owner,{runId:run.id})
 const readPort:import('../src/work/task-run-reference.ts').TaskReferenceReadPort=(db,_run,target,refs,signal)=>resources.executionKnowledgeReferencesInTransaction(db,{ownerId:owner,kind:'agent',scopeIds:[target.scope]},[target.scope],refs,signal)
 let currentRead=readPort
 const read=async(args:unknown={id:sourceId,version},who:string=owner,session:string=sessionId,signal=new AbortController().signal)=>{
  // 原生产路径为静态公共目录；RED保留同一真实注册资源/Run，仅新reader缺席时走原reader。
  if(!existsSync(file))return createPublicReferenceCatalog().read((args as any).id,(args as any).version)
  return (await import('../src/work/task-run-reference.ts')).readTaskRunReference({pool,runs,read:currentRead},who,session,args,signal)
 }
 return {owner,role,actor,resources,resource,path,text,sourceId,version,run,runs,sessionId,read,readPort,setReadPort:(value:typeof readPort)=>{currentRead=value}}
}
test('可信参考PG：同Run选定本机来源成功、实时读固定字节且无新Run',async t=>{
 t.diagnostic('owned PostgreSQL container '+container.getId());const f=await fixture(),r=await f.read();assert.equal(r.text,f.text);assert.equal(r.version,f.version);assert.equal(r.id,f.sourceId);assert.deepEqual((r as any).references,[{id:f.resource.id,version:1}]);assert.equal((await f.runs.list(f.owner,{taskId:f.run.taskId})).length,1)
})
test('可信参考PG：未选、旧hash、异owner/session、异员工来源均拒绝',async()=>{
 const a=await fixture(),b=await fixture();for(const [args,owner,session]of [[{id:a.sourceId,version:'0'.repeat(64)},a.owner,a.sessionId],[{id:'local_material_'+randomUUID(),version:a.version},a.owner,a.sessionId],[{id:a.sourceId,version:a.version},b.owner,a.sessionId],[{id:a.sourceId,version:a.version},a.owner,b.sessionId],[{id:b.sourceId,version:b.version},a.owner,a.sessionId],[{id:a.sourceId,version:a.version,scope:'general'},a.owner,a.sessionId]] as const)await assert.rejects(a.read(args,owner,session))
})
test('可信参考PG：撤回/旧resource版本/源文件改变拒绝，不能回退Run缓存',async()=>{
 const a=await fixture();await a.resources.withdraw(a.actor,{resourceId:a.resource.id,expectedVersion:1});await assert.rejects(a.read(),{code:'teloa/resource-withdrawn'});assert.equal(a.run.knowledge[0]!.text,a.text)
 const b=await fixture();await writeFile(join(root,b.path),'改变后的文件');await assert.rejects(b.read(),{code:'teloa/version-conflict'})
 const c=await fixture();await pool.query('update teloa_resources set revision=revision+1 where owner_id=$1 and id=$2',[c.owner,c.resource.id]);await assert.rejects(c.read(),{code:'teloa/version-conflict'})
})
test('可信参考PG：当前岗位暂停与取消拒绝并释放事务连接',async()=>{
 const a=await fixture();await pool.query("update teloa_roles set state='paused' where owner_id=$1 and id=$2",[a.owner,a.role.id]);await assert.rejects(a.read())
 const b=await fixture(),c=new AbortController();c.abort();await assert.rejects(b.read(undefined,b.owner,b.sessionId,c.signal));assert.equal((await pool.query('select 1 ok')).rows[0].ok,1)
})

test('可信参考PG：同本人不同员工的来源与当前范围漂移仍不可读取',async()=>{
 const a=await fixture(),b=await fixture(a.owner)
 await assert.rejects(b.read({id:a.sourceId,version:a.version}),{code:'teloa/forbidden'})
 await assert.rejects(a.read(undefined,a.owner,'ordinary-unbound-session'),{code:'teloa/forbidden'})
 await pool.query("update teloa_resources set spec=jsonb_set(spec,'{scopeIds}',$3::jsonb) where owner_id=$1 and id=$2",[a.owner,a.resource.id,JSON.stringify(['SOC'])])
 await assert.rejects(a.read(),{code:'teloa/forbidden'})
})
test('可信参考PG：在途读取后取消不发布正文并回滚释放当前锁',async()=>{
 const a=await fixture();let enter!:()=>void,release!:()=>void
 const entered=new Promise<void>(r=>enter=r),gate=new Promise<void>(r=>release=r)
 a.setReadPort(async(...args)=>{const value=await a.readPort(...args);enter();await gate;return value})
 const c=new AbortController(),pending=a.read(undefined,a.owner,a.sessionId,c.signal),rejected=assert.rejects(pending)
 await entered;c.abort();release();await rejected
 const db=await pool.connect();try{await db.query('begin');await db.query("set local lock_timeout='500ms'");await db.query('select * from teloa_resources where owner_id=$1 and id=$2 for update',[a.owner,a.resource.id]);await db.query('rollback')}finally{db.release()}
})
