import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,stopTestContainer} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeTaskTransitions,TaskTransitions} from '../src/work/task-transitions.ts'
import {initializeWorkControl,WorkControlService} from '../src/work/work-control.ts'
import {initializeWorkRecovery,WorkRecoveryService} from '../src/work/work-recovery.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool
const seal={assertCurrent(){}}
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock';container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskTransitions(pool);await initializeWorkControl(pool);await initializeWorkRecovery(pool)})
after(async()=>{await pool?.end();await stopTestContainer(container)})
async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'原本人调查岗',kind:'employee',scopes:['general'],duty:'核查合成资料',dataScope:'本任务',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'security-analyst'}}}),tasks=new TaskService(pool,identity),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'同一任务',goal:'按原口径17核对',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),sessionId=randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),command={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1},run=await runs.prepare(owner,command);await runs.claim(owner,{runId:run.id});await runs.record(owner,{runId:run.id,sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended',turn:0,messageSeq:1,endSeq:2,reason:'completed'}})
 const waiting=(await tasks.list(owner,{}))[0]!,edited=await tasks.edit(owner,{taskId:task.id,expectedVersion:waiting.version,fields:{goal:'按本人已修改的口径19核对'}})
 return {owner,role,task,waiting,edited,tasks,runs,run,command,transitions:new TaskTransitions(pool,identity)}
}
test('本人已保存新目标的waiting原Task，经显式rework回ready；同nonce并发/重放不重复转态且不自动执行',async()=>{
 const f=await fixture(),before=(await pool.query('select * from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows
 assert.equal(f.edited.state,'waiting');const request={taskId:f.task.id,requestId:randomUUID(),expectedVersion:f.edited.version,action:'rework'}
 const [a,b]=await Promise.all([f.transitions.change(f.owner,request,seal),f.transitions.change(f.owner,request,seal)]);assert.deepEqual(a,b);assert.equal(a.id,f.task.id);assert.equal(a.state,'ready');assert.equal(a.version,f.edited.version+1);assert.equal(a.contentVersion,f.edited.contentVersion)
 const authorization=await pool.query<{execution_authorization:unknown}>('select execution_authorization from teloa_tasks where owner_id=$1 and id=$2',[f.owner,f.task.id]);assert.equal(authorization.rowCount,1);assert.equal(authorization.rows[0]!.execution_authorization,null)
 assert.deepEqual((await pool.query('select * from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows,before,'仅重新准备状态，不新Run/不改旧Run')
 assert.deepEqual(await f.transitions.change(f.owner,request,seal),a)
 const next=await f.runs.prepare(f.owner,{...f.command,requestId:randomUUID(),expectedTaskVersion:a.version});assert.equal(next.taskId,f.task.id);assert.equal(JSON.parse(next.inputText).task.goal,a.goal);assert.equal(next.state,'prepared');assert.equal(next.roleVersion,f.role.version)
})

test('restart-paused原round保持不变；本人明确恢复空候选后同Task正常prepare/claim可达',async()=>{
 const f=await fixture(),controls=new WorkControlService(pool,identity,{ownerAuthority:{authorize:async()=>seal},hostGeneration:()=>2,inspectRun:async()=>({settled:true,unknownOperationIds:[]})})
 const pauseds=await controls.disarmForRestart(f.owner,{hostGeneration:2});assert.equal(pauseds.length,1)
 const paused=await controls.reconcile(f.owner,{controlId:pauseds[0]!.id,generation:pauseds[0]!.generation}),before=(await pool.query('select * from teloa_work_controls where owner_id=$1',[f.owner])).rows
 const candidate=await f.transitions.reworkCandidate(f.owner,{taskId:f.task.id,expectedVersion:f.edited.version});assert.equal(candidate.available,true);assert.equal(candidate.controlId,paused.id)
 const ready=await f.transitions.change(f.owner,{taskId:f.task.id,expectedVersion:f.edited.version,requestId:randomUUID(),action:'rework'},seal)
 assert.deepEqual((await pool.query('select * from teloa_work_controls where owner_id=$1',[f.owner])).rows,before,'rework不恢复control')
 await assert.rejects(controls.acquireForLineage(f.owner,{taskId:f.task.id,mode:'new-input'}),{code:'teloa/forbidden'})
 const recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>2,ownerAuthority:{authorize:async()=>seal},authorizeResume:async()=>{throw Error('空候选不得提交任何Run')}})
 assert.deepEqual(await recovery.inspect(f.owner,{controlId:paused.id}),[])
 const active=await recovery.resume(f.owner,{requestId:randomUUID(),controlId:paused.id,expectedVersion:paused.version,candidateRunIds:[]});assert.equal(active.state,'active')
 const next=await f.runs.prepare(f.owner,{...f.command,requestId:randomUUID(),expectedTaskVersion:ready.version});(await controls.acquireForRun(f.owner,{runId:next.id,mode:'new-input'})).lease.assertCurrent();assert.equal(next.state,'prepared');const claimed=await f.runs.claim(f.owner,{runId:next.id});assert.equal(claimed.dispatch,true);assert.equal(claimed.run.taskId,f.task.id);assert.equal(JSON.parse(claimed.run.inputText).task.goal,ready.goal)
})
test('同一资格拒绝无本人seal、未改目标、无编辑回执、不可变来源漂移、角色变化和过期CAS',async()=>{
 const f=await fixture(),request={taskId:f.task.id,expectedVersion:f.edited.version,requestId:randomUUID(),action:'rework'}
 await assert.rejects(f.transitions.change(f.owner,request),{code:'teloa/forbidden'})
 await assert.rejects(f.transitions.change(f.owner,request,{assertCurrent(){throw Object.assign(Error('expired'),{code:'teloa/forbidden'})}}),{code:'teloa/forbidden'})
 await assert.rejects(f.transitions.change(f.owner,{...request,expectedVersion:f.edited.version-1},seal),{code:'teloa/version-conflict'})
 const negative=async(sql:string,args:unknown[],restore:string,back:unknown[])=>{await pool.query(sql,args);assert.equal((await f.transitions.reworkCandidate(f.owner,{taskId:f.task.id,expectedVersion:f.edited.version})).available,false);await assert.rejects(f.transitions.change(f.owner,{...request,requestId:randomUUID()},seal),{code:'teloa/conflict'});await pool.query(restore,back)}
 await negative("update teloa_tasks set definition=jsonb_set(definition,'{goal}',$2::jsonb) where id=$1",[f.task.id,JSON.stringify(f.task.goal)],"update teloa_tasks set definition=jsonb_set(definition,'{goal}',$2::jsonb) where id=$1",[f.task.id,JSON.stringify(f.edited.goal)])
 const edits=(await pool.query('delete from teloa_task_edits where task_id=$1 returning *',[f.task.id])).rows;assert.equal((await f.transitions.reworkCandidate(f.owner,{taskId:f.task.id,expectedVersion:f.edited.version})).available,false);for(const r of edits)await pool.query('insert into teloa_task_edits values($1,$2,$3,$4)',[r.task_id,r.base_version,r.request_spec,r.result])
 await negative("update teloa_roles set state='paused' where id=$1",[f.role.id],"update teloa_roles set state='active' where id=$1",[f.role.id])
 const lineage=(await pool.query('select source from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0]!.source
 await assert.rejects(pool.query('update teloa_task_work_lineage set source=$3 where owner_id=$1 and task_id=$2',[f.owner,f.task.id,{kind:'integration',taskId:f.task.id}]),/immutable/);assert.deepEqual((await pool.query('select source from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0]!.source,lineage)
 const results=await Promise.allSettled([f.transitions.change(f.owner,request,seal),f.transitions.change(f.owner,{...request,requestId:randomUUID()},seal)]);assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
})
