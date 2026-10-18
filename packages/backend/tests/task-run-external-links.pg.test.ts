import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {TaskRunSubagentService} from '../src/work/task-run-subagents.ts'
import {TaskRunRuntimeLinkService,type TaskRunRuntimeLink} from '../src/work/task-run-runtime-links.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)},{timeout:180000})
after(async()=>{await pool?.end();await stopTestContainer(container)})
async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'委派岗',kind:'employee',scopes:['general'],duty:'核对',dataScope:'授权范围',executionScope:'受管',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'委派验收',goal:'核对固定身份',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId='parent_'+randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}),run=(await runs.claim(owner,{runId:prepared.id})).run
 await pool.query("update teloa_task_runs set allowed_tools=$2::jsonb where id=$1",[run.id,JSON.stringify(['subagent_codex','subagent_claude_code'])])
 const service=new TaskRunRuntimeLinkService(pool),local=new TaskRunSubagentService(pool,identity)
 const permit={runId:run.id,requestId:run.nativeRequestId,reservationId:'external:'+randomUUID(),runtimeId:'runtime',workspaceRoot:'/tmp/teloa-external-work',provider:'codex' as const,maxPerRun:2}
 return {owner,run,runs,service,local,permit}
}

test('外部预留独立核对归属、请求、工具、停止与生命周期',async()=>{
 const f=await fixture()
 await assert.rejects(f.service.reserveExternal(f.owner,{...f.permit,workspaceRoot:'relative'}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.reserveExternal(f.owner,{...f.permit,maxPerRun:0}),{code:'teloa/invalid-input'})
 await assert.rejects(f.service.put(f.owner,{runId:f.run.id,kind:'external',nativeId:f.permit.reservationId,sessionId:f.run.sessionId,payload:{provider:f.permit.provider,runtimeId:f.permit.runtimeId,requestId:f.permit.requestId,reservationId:f.permit.reservationId,workspaceRoot:f.permit.workspaceRoot,status:'reserved'}}),{code:'teloa/conflict'})
 await assert.rejects(f.service.reserveExternal('another',f.permit),{code:'teloa/forbidden'})
 await assert.rejects(f.service.reserveExternal(f.owner,{...f.permit,requestId:randomUUID()}),{code:'teloa/forbidden'})
 await pool.query("update teloa_task_runs set allowed_tools='[]'::jsonb where id=$1",[f.run.id])
 await assert.rejects(f.service.reserveExternal(f.owner,f.permit),{code:'teloa/forbidden'})
 await pool.query("update teloa_task_runs set allowed_tools='[\"subagent_codex\"]'::jsonb,stop_requested_at=now() where id=$1",[f.run.id])
 await assert.rejects(f.service.reserveExternal(f.owner,f.permit),{code:'teloa/conflict'})
 await pool.query("update teloa_task_runs set stop_requested_at=null,state='ended' where id=$1",[f.run.id])
 await assert.rejects(f.service.reserveExternal(f.owner,f.permit),{code:'teloa/conflict'})
 assert.deepEqual(await f.service.list(f.owner,{runId:f.run.id}),[])
})

test('外部 activation 唯一绑定且终态不可改写，不伪造本地子会话',async()=>{
 const f=await fixture();await f.service.reserveExternal(f.owner,f.permit)
 const [reserved]=await f.service.list(f.owner,{runId:f.run.id,kind:'external'})
 assert.equal(reserved!.sessionId,f.run.sessionId);assert.equal(reserved!.kind,'external')
 assert.equal(reserved!.payload.status,'reserved')
 const running={...reserved,payload:{...reserved!.payload,activationId:'native-child',status:'running'}} as TaskRunRuntimeLink
 await f.service.put(f.owner,running)
 await assert.rejects(f.service.put(f.owner,{...running,payload:{...running.payload,activationId:'another-child'}}),{code:'teloa/conflict'})
 const completed={...running,payload:{...running.payload,status:'completed'}}
 await f.service.put(f.owner,completed)
 await assert.rejects(f.service.put(f.owner,running),{code:'teloa/conflict'})
 await assert.rejects(f.service.reserveExternal(f.owner,f.permit),{code:'teloa/execution-pending'})
 assert.equal((await pool.query('select count(*)::int n from teloa_task_run_subagents where run_id=$1',[f.run.id])).rows[0].n,0)
})

test('本地与外部并发竞争同一累计额度，只能成功一份预留',async()=>{
 const f=await fixture(),outcomes=await Promise.allSettled([f.service.reserveExternal(f.owner,{...f.permit,maxPerRun:1}),f.local.reserve(f.owner,{runId:f.run.id,reservationId:'local:'+randomUUID(),limit:1})])
 assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1)
 const count=(await pool.query("select ((select count(*) from teloa_task_run_subagents where run_id=$1)+(select count(*) from teloa_task_run_runtime_links where run_id=$1 and kind='external'))::int n",[f.run.id])).rows[0].n
 assert.equal(count,1)
})

test('重复并发的外部调用不获得两份启动许可，未知不自动重派',async()=>{
 const f=await fixture(),outcomes=await Promise.allSettled([f.service.reserveExternal(f.owner,f.permit),f.service.reserveExternal(f.owner,f.permit)])
 assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1)
 const [reserved]=await f.service.list(f.owner,{runId:f.run.id,kind:'external'})
 await f.service.put(f.owner,{...reserved,payload:{...reserved!.payload,status:'unknown'}})
 await assert.rejects(f.service.reserveExternal(f.owner,f.permit),{code:'teloa/execution-pending'})
 await assert.rejects(f.local.reserve(f.owner,{runId:f.run.id,reservationId:'local:'+randomUUID(),limit:1}),{code:'teloa/conflict'})
})


test('外部未结算或未知时父 Run 不能先记录完成',async()=>{
 const f=await fixture();await f.service.reserveExternal(f.owner,f.permit)
 const terminal={runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}}
 await assert.rejects(f.runs.record(f.owner,terminal),{code:'teloa/conflict'})
 const [reserved]=await f.service.list(f.owner,{runId:f.run.id,kind:'external'})
 await f.service.put(f.owner,{...reserved,payload:{...reserved!.payload,status:'unknown'}})
 await assert.rejects(f.runs.record(f.owner,terminal),{code:'teloa/conflict'})
})
