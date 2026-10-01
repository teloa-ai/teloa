import test,{before,after} from 'node:test'
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
import {initializeTaskTransitions,TaskTransitions} from '../src/work/task-transitions.ts'
import {TaskAttentionService} from '../src/work/task-attention.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskTransitions(pool)})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'调查',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'investigator'}}});await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'调查',goal:'核对',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}
 return {owner,role,task,runs,command}
}
async function end(reason:string){const f=await fixture(),run=await f.runs.prepare(f.owner,f.command);await f.runs.claim(f.owner,{runId:run.id});await f.runs.record(f.owner,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason}});return {...f,run}}

test('正常结束只表示结果待核对，主动暂停和已结项任务不告警',async()=>{
 const completed=await end('completed'),manualOwner=randomUUID(),tasks=new TaskService(pool,identity),manual=await tasks.create(manualOwner,{requestId:randomUUID(),fields:{title:'本人任务',goal:'整理',scope:'general'}}),transitions=new TaskTransitions(pool,identity)
 const running=await transitions.change(manualOwner,{taskId:manual.id,requestId:randomUUID(),expectedVersion:1,action:'start'});await transitions.change(manualOwner,{taskId:manual.id,requestId:randomUUID(),expectedVersion:running.version,action:'pause'})
 assert.deepEqual((await new TaskAttentionService(pool).list(completed.owner,{})).items[0]?.attention,{kind:'review',reason:'execution-completed'})
 assert.equal((await new TaskAttentionService(pool).list(manualOwner,{})).items[0]?.attention,null)
 await pool.query("update teloa_tasks set state='completed' where id=$1",[completed.task.id]);await pool.query("update teloa_task_runs set input_text='历史坏探针' where id=$1",[completed.run.id]);assert.equal((await new TaskAttentionService(pool).list(completed.owner,{})).items[0]?.attention,null)
})

test('失败只归因当前最新终轮，新准备遮住旧失败且版本编辑失配保守提示',async()=>{
 const failed=await end('error'),service=new TaskAttentionService(pool)
 assert.deepEqual((await service.list(failed.owner,{})).items[0]?.attention,{kind:'error',reason:'execution-failed'})
 const edited=await new TaskService(pool,identity).edit(failed.owner,{taskId:failed.task.id,expectedVersion:3,fields:{title:'新版调查',goal:'重新核对'}})
 assert.deepEqual((await service.list(failed.owner,{})).items[0]?.attention,{kind:'error',reason:'task-blocked'})
 const retry=await end('error'),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:retry.owner,status:'ready'});await new ObjectConversationService(pool,inspect,identity.now).change(retry.owner,{requestId:randomUUID(),kind:'task',objectId:retry.task.id,expectedObjectVersion:3,sessionId,expectedLinkVersion:0,action:'link'})
 const prepared=await new TaskRunService(pool,identity,inspect).prepare(retry.owner,{...retry.command,requestId:randomUUID(),expectedTaskVersion:3,sessionId});await pool.query("update teloa_task_runs set created_at='2000-01-01T00:00:00.000Z' where id=$1",[prepared.id])
 assert.deepEqual((await service.list(retry.owner,{})).items[0]?.attention,{kind:'error',reason:'task-blocked'})
 assert.deepEqual(await service.list(randomUUID(),{}),{items:[]})
 await assert.rejects(service.list(failed.owner,{extra:true}),{code:'teloa/invalid-input'})
})

test('等待状态无当前正常终轮时不伪造验收，多当前候选显式损坏',async()=>{
 const waiting=await end('completed'),service=new TaskAttentionService(pool);await new TaskService(pool,identity).edit(waiting.owner,{taskId:waiting.task.id,expectedVersion:3,fields:{title:'更新后待核对',goal:'新目标'}})
 assert.deepEqual((await service.list(waiting.owner,{})).items[0]?.attention,{kind:'review',reason:'task-waiting'})
 const corrupt=await end('error'),row=(await pool.query('select * from teloa_task_runs where id=$1',[corrupt.run.id])).rows[0],requestId=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,plan_context_hash,tool_argument_rules,evidence,role_knowledge,role_skills,task_state_version,allowed_tools,industry_context_hash) select $2,owner_id,$3::uuid,jsonb_set(request_spec,'{requestId}',to_jsonb($3::uuid::text)),task_id,role_id,task_version,role_version,link_version,session_id,$4,state,input_text,created_at,plan_context_hash,tool_argument_rules,evidence,role_knowledge,role_skills,task_state_version,allowed_tools,industry_context_hash from teloa_task_runs where id=$1`,[row.id,randomUUID(),requestId,randomUUID()])
 await assert.rejects(service.list(corrupt.owner,{}),{code:'teloa/storage-corrupt'})
})

test('当前任务的运行配置失败需本人关注，但不是在途执行',async()=>{
 const f=await fixture(),run=await f.runs.prepare(f.owner,f.command,undefined,undefined,undefined,async()=>{throw new Error('preset missing')})
 assert.equal(run.state,'configuration_failed')
 assert.deepEqual((await new TaskAttentionService(pool).list(f.owner,{})).items[0]?.attention,{kind:'error',reason:'execution-configuration-failed'})
 const retry=await f.runs.prepare(f.owner,{...f.command,requestId:randomUUID()})
 assert.equal(retry.state,'prepared')
 assert.equal((await new TaskAttentionService(pool).list(f.owner,{})).items[0]?.attention,null)
})
