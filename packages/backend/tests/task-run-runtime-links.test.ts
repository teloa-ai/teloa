import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeTaskRunRuntimeLinks,TaskRunRuntimeLinkService,type TaskRunRuntimeLink} from '../src/work/task-run-runtime-links.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'拆分岗',kind:'employee',scopes:['general'],duty:'拆分工作',dataScope:'范围内',executionScope:'受管',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'拆分任务',goal:'验证登记',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId='parent_'+randomUUID().replaceAll('-',''),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}),claimed=await runs.claim(owner,{runId:prepared.id})
 return {owner,run:claimed.run,runs}
}


const job=(run:{id:string;sessionId:string;nativeRequestId:string}):TaskRunRuntimeLink=>({runId:run.id,kind:'job',nativeId:'runtime:job',sessionId:run.sessionId,payload:{record:'job',runtimeId:'runtime',requestId:run.nativeRequestId,jobId:'job',status:'running'}})

test('原生运行关联持久化、按本人和 Run 隔离，状态更新不改变身份',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunRuntimeLinkService(pool),input=job(run)
 await Promise.all([service.put(owner,input),service.put(owner,input)])
 assert.deepEqual(await new TaskRunRuntimeLinkService(pool).list(owner,{runId:run.id}),[input])
 await assert.rejects(service.list('another',{runId:run.id}),{code:'teloa/forbidden'})
 await assert.rejects(service.put('another',input),{code:'teloa/forbidden'})
 const completed={...input,payload:{...input.payload,status:'completed'}}
 await service.put(owner,completed)
 await service.put(owner,completed)
 await assert.rejects(service.put(owner,input),{code:'teloa/conflict'})
 await assert.rejects(service.put(owner,{...completed,sessionId:'another'}),{code:'teloa/conflict'})
 assert.deepEqual(await service.list(owner,{runId:run.id,kind:'team'}),[])
 assert.deepEqual(await service.list(owner,{runId:run.id,kind:'job'}),[completed])
})

test('owner 与 team 关联必须匹配 Run 请求和会话，回执不可改写且字段严格校验',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunRuntimeLinkService(pool)
 const input={runId:run.id,kind:'team',nativeId:'call:1',sessionId:run.sessionId,payload:{requestId:run.nativeRequestId,reservationId:'call:1',name:'reviewer'}}
 await service.put(owner,input)
 await service.put(owner,input)
 await assert.rejects(service.put(owner,{...input,payload:{...input.payload,name:'replacement'}}),{code:'teloa/conflict'})
 await assert.rejects(service.put(owner,{...input,nativeId:'call:2',payload:{...input.payload,reservationId:'call:2',requestId:randomUUID()}}),{code:'teloa/forbidden'})
 await assert.rejects(service.put(owner,{...input,payload:{...input.payload,secret:'unexpected'}}),{code:'teloa/invalid-input'})
 const marker={runId:run.id,kind:'job',nativeId:'owner:runtime:'+run.sessionId,sessionId:run.sessionId,payload:{record:'owner',runtimeId:'runtime',requestId:run.nativeRequestId}}
 await service.put(owner,marker)
 assert.equal((await service.list(owner,{runId:run.id})).length,2)
 await assert.rejects(service.put(owner,{...marker,nativeId:'wrong'}),{code:'teloa/invalid-input'})
})

test('后台 Job 可属于已登记子会话，不能借用无关会话',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunRuntimeLinkService(pool),input=job(run)
 await assert.rejects(service.put(owner,{...input,sessionId:'unrelated'}),{code:'teloa/forbidden'})
 await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,child_session_id,depth,state,created_at,started_at) values($1,$2,'call:child','child_registered',1,'started',now(),now())",[owner,run.id])
 await service.put(owner,{...input,sessionId:'child_registered'})
 assert.equal((await service.list(owner,{runId:run.id}))[0]?.sessionId,'child_registered')
})

test('浏览器派发关联兼容旧表，先 dirty 再 closed，父子会话和请求身份不可扩大',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunRuntimeLinkService(pool)
 // 模拟已上线的 job/team CHECK：重复初始化必须原位兼容且不抹除已有行。
 await service.put(owner,job(run))
 await pool.query("alter table teloa_task_run_runtime_links drop constraint teloa_task_run_runtime_links_kind_check, add constraint teloa_task_run_runtime_links_kind_check check(kind in ('job','team'))")
 await initializeTaskRunRuntimeLinks(pool);await initializeTaskRunRuntimeLinks(pool)
 const input={runId:run.id,kind:'browser',nativeId:'runtime:dispatch',sessionId:run.sessionId,payload:{runtimeId:'runtime',requestId:run.nativeRequestId,dispatchId:'dispatch',status:'dirty'}}
 await assert.rejects(service.put(owner,{...input,payload:{...input.payload,status:'closed'}}),{code:'teloa/conflict'})
 await service.put(owner,input)
 await assert.rejects(service.put(owner,{...input,sessionId:'unregistered'}),{code:'teloa/conflict'})
 await assert.rejects(service.put(owner,{...input,nativeId:'runtime:foreign',sessionId:'unregistered',payload:{...input.payload,dispatchId:'foreign'}}),{code:'teloa/forbidden'})
 await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,child_session_id,depth,state,created_at,started_at) values($1,$2,'browser:child','browser_registered',1,'started',now(),now())",[owner,run.id])
 await service.put(owner,{...input,nativeId:'runtime:child',sessionId:'browser_registered',payload:{...input.payload,dispatchId:'child'}})
 const closed={...input,payload:{...input.payload,status:'closed'}}
 await service.put(owner,closed);await service.put(owner,closed)
 await assert.rejects(service.put(owner,input),{code:'teloa/conflict'})
 await assert.rejects(service.put(owner,{...input,nativeId:'wrong'}),{code:'teloa/invalid-input'})
 await assert.rejects(service.put(owner,{...input,payload:{...input.payload,requestId:randomUUID()}}),{code:'teloa/conflict'})
 assert.equal((await service.list(owner,{runId:run.id,kind:'browser'})).length,2)
 assert.equal((await service.list(owner,{runId:run.id,kind:'job'})).length,1)
})
