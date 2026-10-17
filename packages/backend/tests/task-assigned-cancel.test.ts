import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {TaskRunService,initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeTaskRunSubagents} from '../src/work/task-run-subagents.ts'
import {initializeTaskRunFlows} from '../src/work/task-run-flows.ts'
import {TaskRunRuntimeLinkService,initializeTaskRunRuntimeLinks} from '../src/work/task-run-runtime-links.ts'
import {TaskTransitions,initializeTaskTransitions} from '../src/work/task-transitions.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskRunFlows(pool);await initializeTaskRunSubagents(pool);await initializeTaskRunRuntimeLinks(pool);await initializeTaskTransitions(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})
const identity={id:randomUUID,now:()=>new Date().toISOString()}
async function fixture(){
 const owner=randomUUID(),tasks=new TaskService(pool,identity),states=new TaskTransitions(pool,identity)
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['general'],duty:'调查',dataScope:'只读',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'investigator'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const sessions=new Map<string,string>(),inspect=async(_owner:string,sessionId:string)=>({id:sessions.get(sessionId)!,sessionId,ownerId:owner,status:'ready' as const})
 const runs=new TaskRunService(pool,identity,inspect)
 const assign=async(title:string)=>{
  const task=await tasks.create(owner,{requestId:randomUUID(),fields:{title,goal:'核对证据',scope:'general'},assignee:{roleId:role.id,expectedVersion:1}}),sessionId=randomUUID()
  sessions.set(sessionId,randomUUID())
  await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
  return {task,sessionId}
 }
 const cancel=(taskId:string,expectedVersion:number,requestId=randomUUID())=>states.change(owner,{taskId,requestId,expectedVersion,action:'cancel'})
 const state=async(taskId:string)=>(await tasks.list(owner,{})).find(t=>t.id===taskId)!.state
 return {owner,tasks,states,role,runs,assign,cancel,state}
}
test('员工任务没有任何执行时，本人可直接取消；取消后旧执行请求不能开始新工作',async()=>{
 const f=await fixture(),{task,sessionId}=await f.assign('未派发的交办')
 const command={taskId:task.id,requestId:randomUUID(),expectedVersion:1,action:'cancel'}
 const [a,b]=await Promise.all([f.states.change(f.owner,command),f.states.change(f.owner,command)])
 assert.deepEqual(a,b);assert.equal(a.state,'cancelled');assert.equal(a.version,2);assert.equal(await f.state(task.id),'cancelled')
 await assert.rejects(f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1}),{code:'teloa/version-conflict'})
 await assert.rejects(f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:2,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1}),{code:'teloa/conflict'})
 assert.equal((await f.runs.list(f.owner,{taskId:task.id})).length,0)
 // 伪装的启动、暂停、恢复仍由执行服务驱动，不随取消一起放开。
 const other=await f.assign('另一交办')
 for(const action of ['start','pause','resume'])await assert.rejects(f.states.change(f.owner,{taskId:other.task.id,requestId:randomUUID(),expectedVersion:1,action}),{code:'teloa/conflict'})
 assert.equal(await f.state(other.task.id),'ready')
})
test('取消与准备执行并发时由任务行锁串行，只能有一方成功',async()=>{
 const f=await fixture(),{task,sessionId}=await f.assign('并发交办')
 const prepare=f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 const [prepared,cancelled]=await Promise.allSettled([prepare,f.cancel(task.id,1)])
 assert.notEqual(prepared.status,cancelled.status)
 if(cancelled.status==='fulfilled'){assert.equal(cancelled.value.state,'cancelled');assert.equal((prepared as PromiseRejectedResult).reason.code,'teloa/version-conflict');assert.equal((await f.runs.list(f.owner,{taskId:task.id})).length,0)}
 else{assert.equal(cancelled.reason.code,'teloa/conflict');assert.equal((prepared as PromiseFulfilledResult<{state:string}>).value.state,'prepared');assert.equal(await f.state(task.id),'ready')}
})
test('待领取或进行中的执行阻止通用取消并指向停止流程；全部执行收尾后才能取消，且不受同岗位其他任务影响',async()=>{
 const f=await fixture(),{task,sessionId}=await f.assign('进行中的交办'),busy=await f.assign('同岗位另一任务')
 const busyRun=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:busy.task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId:busy.sessionId,expectedLinkVersion:1})
 await f.runs.claim(f.owner,{runId:busyRun.id})
 const prepared=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 await assert.rejects(f.cancel(task.id,1),{code:'teloa/conflict',message:/停止/})
 assert.equal(await f.state(task.id),'ready')
 await f.runs.claim(f.owner,{runId:prepared.id})
 assert.equal(await f.state(task.id),'running')
 await assert.rejects(f.cancel(task.id,2),{code:'teloa/conflict',message:/停止/})
 await f.runs.record(f.owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'aborted'}})
 assert.equal(await f.state(task.id),'paused')
 // 同岗位另一任务仍在执行，不应误挡这个已结束任务。
 assert.equal((await f.runs.list(f.owner,{taskId:busy.task.id}))[0]!.state,'submitting')
 const cancelled=await f.cancel(task.id,3)
 assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.version,4)
 assert.equal((await f.runs.list(f.owner,{taskId:task.id}))[0]!.state,'ended')
 assert.equal(await f.state(busy.task.id),'running')
})
test('已结束执行仍有未收口子工作或证据损坏时拒绝取消；撤销准备后可以取消',async()=>{
 const f=await fixture(),{task,sessionId}=await f.assign('子工作未收口')
 const run=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 await f.runs.claim(f.owner,{runId:run.id})
 await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'reserved',$4)",[f.owner,run.id,randomUUID(),identity.now()])
 await pool.query("update teloa_task_runs set state='ended',evidence=$2 where id=$1",[run.id,JSON.stringify({state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'aborted'})])
 await pool.query("update teloa_tasks set state='paused',version=3 where id=$1",[task.id])
 await assert.rejects(f.cancel(task.id,3),{code:'teloa/conflict'})
 await pool.query("update teloa_task_run_subagents set state='abandoned',ended_at=$2,stop_reason='stopped' where run_id=$1",[run.id,identity.now()])
 await pool.query("update teloa_task_runs set evidence='{\"state\":\"ended\"}'::jsonb where id=$1",[run.id])
 await assert.rejects(f.cancel(task.id,3),{code:'teloa/conflict'})
 await pool.query("update teloa_task_runs set evidence=$2 where id=$1",[run.id,JSON.stringify({state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'aborted'})])
 assert.equal((await f.cancel(task.id,3)).state,'cancelled')
 const withdrawn=await f.assign('撤销准备后取消')
 const prepared=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:withdrawn.task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId:withdrawn.sessionId,expectedLinkVersion:1})
 await assert.rejects(f.cancel(withdrawn.task.id,1),{code:'teloa/conflict'})
 await f.runs.withdraw(f.owner,{runId:prepared.id})
 assert.equal((await f.cancel(withdrawn.task.id,1)).state,'cancelled')
})

for(const reason of ['completed','interrupted'] as const)test(`零工具零技能的原生${reason}轮仅留精确宿主登记时可取消，保留原运行证据`,async()=>{
 const f=await fixture(),{task,sessionId}=await f.assign('纯文本收尾')
 const run=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 await f.runs.claim(f.owner,{runId:run.id})
 const runtimeId=randomUUID(),links=new TaskRunRuntimeLinkService(pool)
 await links.put(f.owner,{runId:run.id,kind:'job',nativeId:`owner:${runtimeId}:${sessionId}`,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
 const evidence={state:'ended' as const,turn:1,messageSeq:2,endSeq:3,reason}
 await f.runs.record(f.owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence})
 const cancelled=await f.cancel(task.id,3)
 assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.version,4)
 assert.deepEqual((await f.runs.list(f.owner,{taskId:task.id}))[0]!.evidence,evidence)
 assert.equal((await links.list(f.owner,{runId:run.id})).length,1,'登记保留，不删除历史来绕过核验')
})

test('纯文本宿主例外不放行实际job、子级、流程、权限快照损坏或归属不符',async()=>{
 for(const kind of ['job','child','flow','tools','skills','input','request','session','owners'] as const){
  const f=await fixture(),{task,sessionId}=await f.assign('未知关联仍阻止取消')
  const run=await f.runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:f.role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
  await f.runs.claim(f.owner,{runId:run.id})
  const runtimeId=randomUUID(),links=new TaskRunRuntimeLinkService(pool),nativeId=`owner:${runtimeId}:${sessionId}`
  await links.put(f.owner,{runId:run.id,kind:'job',nativeId,sessionId,payload:{record:'owner',runtimeId,requestId:run.nativeRequestId}})
  if(kind==='job')await links.put(f.owner,{runId:run.id,kind:'job',nativeId:runtimeId+':pending',sessionId,payload:{record:'job',runtimeId,requestId:run.nativeRequestId,jobId:'pending',status:'running'}})
  if(kind==='owners')await links.put(f.owner,{runId:run.id,kind:'job',nativeId:`owner:other:${sessionId}`,sessionId,payload:{record:'owner',runtimeId:'other',requestId:run.nativeRequestId}})
  if(kind==='child')await pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at,ended_at,stop_reason) values($1,$2,$3,'abandoned',now(),now(),'not-submitted')",[f.owner,run.id,randomUUID()])
  if(kind==='flow')await pool.query("insert into teloa_task_run_flows(flow_id,owner_id,run_id,request_id,request_spec,definition_version,state,steps,created_at,updated_at) values($1,$2,$3,$4,'{}',1,'completed','[]',now(),now())",[randomUUID(),f.owner,run.id,randomUUID()])
  await f.runs.record(f.owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}})
  if(kind==='tools')await pool.query('update teloa_task_runs set allowed_tools=$2 where id=$1',[run.id,JSON.stringify(['read'])])
  if(kind==='skills')await pool.query("update teloa_task_runs set role_skills='null'::jsonb where id=$1",[run.id])
  if(kind==='input')await pool.query("update teloa_task_runs set input_text='{}' where id=$1",[run.id])
  if(kind==='request')await pool.query("update teloa_task_run_runtime_links set payload=jsonb_set(payload,'{requestId}',$3::jsonb) where run_id=$1 and native_id=$2",[run.id,nativeId,JSON.stringify(randomUUID())])
  if(kind==='session')await pool.query('update teloa_task_run_runtime_links set session_id=$3 where run_id=$1 and native_id=$2',[run.id,nativeId,'wrong-session'])
  await assert.rejects(f.cancel(task.id,3),{code:'teloa/conflict',details:{reason:'task-work-outstanding'}},kind)
  assert.equal(await f.state(task.id),'waiting',kind)
 }
})
