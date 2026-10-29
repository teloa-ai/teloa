import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from '../../backend/tests/postgres-test-lifecycle.ts'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../../backend/src/work/roles.ts'
import {initializeTasks} from '../../backend/src/work/tasks.ts'
import {TaskRunService,initializeTaskRuns,type TaskRun} from '../../backend/src/work/task-runs.ts'
import {ObjectConversationService,initializeObjectConversations} from '../../backend/src/work/object-conversations.ts'
import {EmployeeIntegrationService,initializeEmployeeIntegrations} from '../../backend/src/work/employee-integrations.ts'
import {EmployeeApiWorkService,initializeEmployeeApiWork,type EmployeeApiRuntime} from '../../backend/src/work/employee-api-work.ts'
import {initializeArtifactSnapshots} from '../../backend/src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../../backend/src/work/artifacts.ts'
import {WorkControlService,initializeWorkControl} from '../../backend/src/work/work-control.ts'
import {createTaskRunHandler} from '../src/task-runs.ts'
import {taskInput} from '@teloa/contract'
import {createTaskRunApi} from '../../client/ui-workbench/src/client/task-run-api.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'

// 真实 PostgreSQL、TaskRunService、TaskRunDriver 与外层 API 工作事务；仅原生会话/模型发送使用桩。
// 为捕获 FK 行锁与跨事务等待，不以 EmployeeApiRuntime 的状态替身代替真实执行服务。
test('API自动派发在外层工作事务内准备并启动真实Run，解析默认模型不会跨事务自锁',{timeout:120000},async t=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').start(),pool=new Pool({connectionString:container.getConnectionUri(),statement_timeout:1500})
 t.after(async()=>{await pool.end();await container.stop()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeWorkControl(pool);await initializeEmployeeIntegrations(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeEmployeeApiWork(pool)
 const owner='local:teloa-owner',identity={id:randomUUID,now:()=>new Date().toISOString()},roles=new RoleService(pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'API真实执行岗',kind:'employee',scopes:['general'],duty:'读取资料',dataScope:'本人提供',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{model:{provider:'fixture',model:'default'}}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const keys=new EmployeeIntegrationService(pool,{write:async()=>{},read:async()=>undefined,remove:async()=>{}}),issued=await keys.create(owner,{name:'跨事务验收',employeeId:role.id,expectedEmployeeVersion:role.version,scope:'general',permissions:['read','execute','cancel'],maxConcurrent:4,expiresInDays:1}),grant=await keys.authenticate(issued.apiKey)
 const conversations=new Map<string,any>(),inspect=async(_owner:string,sessionId:string)=>{const row=conversations.get(sessionId);assert.ok(row);return row}
 const service=new TaskRunService(pool,identity,inspect,{allowedTools:['read_reference']}),controls=new WorkControlService(pool,identity),links=new ObjectConversationService(pool,inspect,identity.now)
 let sends=0,prepares=0
 const handler=createTaskRunHandler(owner,async()=>service,{checkPermissionMode:async()=>{},checkModel:async()=>{},resolvePreset:async()=> 'default-agent',prepareModels:async()=>({primary:{provider:'fixture',model:'default'}}),check:async()=>{},send:async()=>{sends++},stop:async()=>{},events:async()=>[],controlState:run=>controls.stateForRun(owner,{runId:run.id})},undefined,{conversations:{runReservation:async(_owner,input)=>{const request=taskInput(input,['requestId']);return conversations.get('task-run-'+String(request.requestId))??null},failRunReservation:async()=>false,createRun:async(_owner,input,run)=>{const request=taskInput(input,['requestId','title']);const row={id:randomUUID(),ownerId:owner,requestId:String(request.requestId),title:String(request.title),scopeIds:['general'] as ['general'],version:1 as const,status:'ready' as const,sessionId:run.sessionId,requestedSessionId:run.sessionId,purpose:'task-run' as const,run:{taskId:run.taskId,taskVersion:run.taskVersion,roleId:run.roleId,roleVersion:run.roleVersion,agentPresetId:run.agentPresetId},createdAt:identity.now()};conversations.set(row.sessionId,row);return row}},links})
 const runtime:EmployeeApiRuntime={prepare:async(actor,input,signal)=>{assert.equal(actor,owner);prepares++;return handler('task-runs/prepare',input,signal)},start:async(_actor,runId,signal)=>handler('task-runs/start',{runId},signal),read:async(_actor,runId)=>service.get(owner,{runId}),stop:async(_actor,runId,signal)=>handler('task-runs/stop',{runId},signal),withdraw:async(_actor,runId,signal)=>handler('task-runs/withdraw',{runId},signal),result:async()=>undefined}
 let time=new Date()
 const work=new EmployeeApiWorkService(pool,keys,runtime,owner,()=>time),accepted=await work.command(grant,'start',randomUUID(),{employeeId:role.id,input:'自动读取资料',permissionMode:'read-only'})
 await work.tick(AbortSignal.timeout(10000))
 const current=await work.get(grant,accepted.id)
 assert.equal(current.state,'running');assert.equal(current.error,null);assert.equal(sends,1);assert.equal(prepares,1)
 const round=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1',[accepted.id])).rows[0]
 assert.ok(round.run_id);assert.equal(round.model_provider,'fixture');assert.equal(round.model_id,'default')
 const run:TaskRun=await service.get(owner,{runId:round.run_id});assert.equal(run.state,'accepted')
 // 模拟原生prepare已提交、start前外层故障：恢复时不得先写round并自锁，也不能遗失固定默认模型。
 const start=runtime.start;let fail=true
 runtime.start=async(...args)=>{if(fail)throw Error('模拟派发前外层故障');return start(...args)}
 const retry=await work.command(grant,'start',randomUUID(),{employeeId:role.id,input:'恢复同一已准备运行',permissionMode:'workspace-write'})
 await work.tick(AbortSignal.timeout(10000),()=>{})
 assert.equal((await work.get(grant,retry.id)).error,'dispatch_unavailable')
 const before=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1',[retry.id])).rows[0]
 assert.equal(before.run_id,null);assert.equal(before.model_provider,null)
 const fixed=(await pool.query('select id from teloa_task_runs where task_id=$1 and request_id=$2',[before.task_id,before.request_id])).rows[0].id
 fail=false;time=new Date(time.getTime()+31000)
 await work.tick(AbortSignal.timeout(10000))
 assert.equal((await work.get(grant,retry.id)).state,'running')
 const restored=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1',[retry.id])).rows[0]
 assert.equal(restored.run_id,fixed);assert.equal(restored.model_provider,'fixture');assert.equal(restored.model_id,'default')
 assert.equal(prepares,2);assert.equal(sends,2)
 // 客户端消费真实后端Run的JSON传输形状，覆盖两档权限和请求级模型覆盖。
 const explicit=await work.command(grant,'start',randomUUID(),{employeeId:role.id,input:'按请求固定模型',permissionMode:'read-only',model:{provider:'fixture',model:'selected'}})
 await work.tick(AbortSignal.timeout(10000))
 assert.equal((await work.get(grant,explicit.id)).state,'running')
 const explicitRound=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1',[explicit.id])).rows[0]
 for(const [runId,mode,override] of [[round.run_id,'read-only',false],[restored.run_id,'workspace-write',false],[explicitRound.run_id,'read-only',true]] as const){
  const actual=await service.get(owner,{runId}),wire=JSON.parse(JSON.stringify(actual))
  const client=createTaskRunApi(async(method,payload)=>{
   if(method==='task-runs/list'){assert.deepEqual(payload,{taskId:actual.taskId});return [wire]}
   assert.equal(method,'conversations/read');assert.deepEqual(payload,{sessionId:actual.sessionId});return JSON.parse(JSON.stringify(conversations.get(actual.sessionId)))
  })
  const view=(await client.list(actual.taskId))[0]!
  assert.equal(view.permissionMode,mode);assert.equal(view.modelPolicyOverride===true,override)
  assert.equal((await client.chatPresentation(actual.sessionId))?.runId,actual.id)
 }


})
