import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService,type TaskRun} from '../src/work/task-runs.ts'
import {initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts,ArtifactService} from '../src/work/artifacts.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {initializeTaskTransitions,initializeTaskCompletions,TaskTransitions} from '../src/work/task-transitions.ts'
import {TaskRunInteractionService} from '../src/work/task-run-interaction.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeBusinessData} from '../src/work/business-data.ts'
import {initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {initializeSecurityRequests} from '../src/security/request-journal.ts'
import {initializeSecurityActions} from '../src/security/actions.ts'
import {initializeSecurityApprovals} from '../src/security/approvals.ts'
import {initializeSecurityActionExecutions} from '../src/security/action-executions.ts'
import {initializeWorkControl} from '../src/work/work-control.ts'
import {loopWorkFixture,loopText} from '../../harness-dsh/tests/fixtures/native-loop-work-admission.ts'
import {observeTaskRun} from '../../harness-dsh/src/task-run-observation.ts'
import {readSessionEvents} from '../../harness-dsh/src/session-events.ts'
import {readTaskRunGroupResult} from '../../harness-dsh/src/task-run-group-result.ts'
import {taskRunInteractionRequest} from '../../harness-dsh/src/task-run-interaction.ts'
import {assertTaskRunCompletedProof} from '../../harness-dsh/src/task-run-completed-proof.ts'
import {initializeTaskRunGoals,TaskRunGoalService} from '../src/work/task-run-goals.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:1})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeRoleToolGrants(pool);await initializeTaskTransitions(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeTaskCompletions(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool);await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool);await initializeSecurityActionExecutions(pool)
 await initializeWorkControl(pool)
 await initializeTaskRunGoals(pool)
},{timeout:120_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(options?:{sessionId:string;execute:(run:TaskRun)=>Promise<unknown>}){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'本人资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const tasks=new TaskService(pool,identity),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'核对原资料',goal:'输出核对结果',scope:'general'},assignee:{roleId:role.id,expectedVersion:1}}),sessionId=options?.sessionId??randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'teloa-standard')
 await runs.claim(owner,{runId:prepared.id})
 const evidence=options?await options.execute(prepared):{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}
 const run=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
 const interactions=new TaskRunInteractionService(runs,async fixed=>{assert.deepEqual(fixed.evidence,run.evidence)})
 const complete=async()=>{
  const artifacts=new ArtifactService(pool,identity,async(actor,expected,db)=>({source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:[]})),artifact=await artifacts.create(owner,{requestId:randomUUID(),source:await taskArtifactSource(pool,owner,task.id,false),content:{title:'原固定成果',sections:[{id:'result',title:'核对结果',text:'原资料已核对'}],snapshotIds:[],note:'本人确认'}})
  return new TaskTransitions(pool,identity).change(owner,{taskId:task.id,requestId:randomUUID(),expectedVersion:3,action:'complete',artifact:{id:artifact.artifactId,version:1},note:'本人验收'})
 }
 return {owner,role,task,sessionId,runs,run,interactions,complete}
}

test('本人验收前保持任务输入锁定，收口后独立追问不改原Task、Run和结项成果',{timeout:20_000},async()=>{
 const f=await fixture()
 await assert.rejects(f.interactions.read(f.owner,f.sessionId),{code:'teloa/conflict'})
 const task=await f.complete(),before=await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id]),interaction=await f.interactions.read(f.owner,f.sessionId)
 assert.ok(interaction);interaction.lease.assertCurrent();assert.equal(interaction.run.id,f.run.id);assert.equal(interaction.target.taskId,f.task.id)
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),f.run)
 assert.equal((await pool.query('select version from teloa_tasks where id=$1',[f.task.id])).rows[0].version,task.version)
 assert.deepEqual((await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows,before.rows)
 await assert.rejects(f.interactions.read(randomUUID(),f.sessionId),{code:'teloa/forbidden'})
})

test('已完成Run仍受后台未知工作、撤权及完整原生证据约束',{timeout:20_000},async()=>{
 const f=await fixture();await f.complete()
 const runtimeId=randomUUID(),nativeId='owner:'+runtimeId+':'+f.sessionId
 await pool.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'job',$3,$4,$5)",[f.owner,f.run.id,nativeId,f.sessionId,JSON.stringify({record:'owner',runtimeId,requestId:f.run.nativeRequestId})])
 await pool.query("update teloa_roles set state='paused' where id=$1",[f.role.id])
 await assert.rejects(f.interactions.read(f.owner,f.sessionId),{code:'teloa/forbidden'})
 await pool.query("update teloa_roles set state='active' where id=$1",[f.role.id])
 const cold=new TaskRunInteractionService(f.runs,async()=>{throw Error('原生完整日志缺失')})
 await assert.rejects(cold.read(f.owner,f.sessionId),/原生完整日志缺失/)
 await pool.query("update teloa_task_run_runtime_links set payload=$4 where owner_id=$1 and run_id=$2 and native_id=$3",[f.owner,f.run.id,nativeId,JSON.stringify({record:'owner',runtimeId,requestId:'unknown-request'})])
 await assert.rejects(f.interactions.read(f.owner,f.sessionId),{code:'teloa/conflict'})
})

test('员工后续授权版本保留原冻结身份，追问工具只取原范围与当前授权交集',async()=>{
 const f=await fixture();await f.complete()
 const rules=[{name:'newly-granted',allowed:[{}]}]
 await pool.query('insert into teloa_role_tool_grants(role_id,base_version,role_version,state,rules,request_spec,created_at) values($1,1,2,\'active\',$2,$3,$4)',[f.role.id,JSON.stringify(rules),JSON.stringify({action:'save',rules}),identity.now()])
 await pool.query('update teloa_roles set version=2 where id=$1',[f.role.id])
 const interaction=await f.interactions.read(f.owner,f.sessionId)
 assert.ok(interaction)
 assert.equal(interaction.run.roleVersion,1)
 assert.deepEqual(interaction.currentRules,rules)
 assert.deepEqual(interaction.allowedTools,[],'新增授权不能扩大原运行的空工具范围')
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),f.run)
})

test('单连接真实Task结项与原SDK日志共同开放追问，后续轮次不改变固定报告或原记录',{timeout:20_000},async t=>{
 const native=await loopWorkFixture(t,true)
 native.adapter.scripts.push(loopText)
 const f=await fixture({sessionId:String(native.agent.id),execute:async run=>{await native.send(run.nativeRequestId);return observeTaskRun(readSessionEvents(native.agent.session),run.nativeRequestId)}})
 const goals=new TaskRunGoalService(pool,identity,{hostGeneration:()=>1,inspectGoal:async()=>{throw Error('只读签收不能激活Goal')},admitRound:async()=>{throw Error('只读签收不能预约轮次')}})
 const interactions=new TaskRunInteractionService(f.runs,async(run,db)=>{
  const links=await new TaskRunRuntimeLinkService(pool).listInTransaction(db,f.owner,{runId:run.id}),goal=await goals.readInTransaction(db,f.owner,{runId:run.id})
  assertTaskRunCompletedProof(run,readSessionEvents(native.agent.session),links,[],goal)
 })
 await assert.rejects(interactions.read(f.owner,f.sessionId),{code:'teloa/conflict'})
 const task=await f.complete(),completion=(await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows
 const prefix=[...readSessionEvents(native.agent.session)]
 assert.ok(await interactions.read(f.owner,f.sessionId))
 f.runs.enableCompletedInteractions(async(owner,sid,db)=>{const value=await interactions.read(owner,sid,db);if(!value)return null;const requestId=taskRunInteractionRequest(readSessionEvents(native.agent.session),value.run);return {...value,...(requestId?{requestId}:{})}})
 native.adapter.scripts.push(loopText);await native.send('independent-new-user')
 assert.ok(await interactions.read(f.owner,f.sessionId))
 assert.deepEqual(readSessionEvents(native.agent.session).slice(0,prefix.length),prefix)
 assert.equal(readTaskRunGroupResult(prefix,f.run.nativeRequestId),'done')
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),f.run)
 assert.deepEqual((await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows,completion)
 assert.equal((await pool.query('select version from teloa_tasks where id=$1',[f.task.id])).rows[0].version,task.version)
 assert.equal(native.adapter.requests.length,2)
})
