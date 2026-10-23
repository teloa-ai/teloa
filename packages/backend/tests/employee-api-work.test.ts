import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHmac} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeTaskTransitions,initializeTaskCompletions} from '../src/work/task-transitions.ts'
import {initializeWorkProgress} from '../src/work/work-progress.ts'
import {initializeEmployeeIntegrations,EmployeeIntegrationService} from '../src/work/employee-integrations.ts'
import {initializeEmployeeApiWork,EmployeeApiWorkService,type EmployeeApiRuntime} from '../src/work/employee-api-work.ts'
import {EmployeeApiWebhooks} from '../src/work/employee-api-webhooks.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {TaskRun} from '../src/work/task-runs.ts'
import {verifyWebhook} from '../../sdk/index.mjs'
import {EmployeeApiError} from '../../sdk/contract.mjs'

let container:StartedPostgreSqlContainer,pool:Pool,now:Date
const clock=()=>now
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskTransitions(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeTaskCompletions(pool);await initializeWorkProgress(pool);await initializeEmployeeIntegrations(pool);await initializeEmployeeApiWork(pool)
 now=new Date()
},{timeout:120_000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(permissions=['read','execute','cancel'],webhookUrl?:string){
 const owner='local:'+randomUUID(),secrets=new Map<string,string>(),secretPort={write:async(id:string,value:string)=>{secrets.set(id,value)},read:async(id:string)=>secrets.get(id),remove:async(id:string)=>{secrets.delete(id)}}
 const keys=new EmployeeIntegrationService(pool,secretPort,clock)
 const role=await new RoleService(pool,{id:randomUUID,now:()=>clock().toISOString()}).create(owner,{requestId:randomUUID(),fields:{name:'API核对岗',kind:'employee',scopes:['general'],duty:'核对本人资料',dataScope:'本人提供的资料',executionScope:'只读核对',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const issued=await keys.create(owner,{name:'业务系统',employeeId:role.id,expectedEmployeeVersion:role.version,scope:'general',permissions,maxConcurrent:2,expiresInDays:30,...webhookUrl?{webhookUrl}:{}}),identity=await keys.authenticate(issued.apiKey)
 const runs=new Map<string,TaskRun>(),calls:string[]=[],checks:{permissionMode:string;model:{provider:string;model:string}|null}[]=[],prepares:{requestId:string;permissionMode?:string;model?:{provider:string;model:string}}[]=[]
 let waiting=false,checkError:Error|undefined,resultText='FIXED-RESULT-'+role.id
 const runById=(id:string)=>[...runs.values()].find(run=>run.id===id)!
 const runtime:EmployeeApiRuntime={
  check:async options=>{checks.push(options);if(checkError)throw checkError},
  prepare:async(owner,input)=>{
   calls.push('prepare:'+input.requestId);prepares.push(input)
   let run=runs.get(input.requestId)
   if(!run){
    const id=randomUUID(),task=(await pool.query('select version from teloa_tasks where owner_id=$1 and id=$2',[owner,input.taskId])).rows[0]
    if(!task)throw Error('missing task')
    await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at,permission_mode,model_policy,model_policy_override)
     values($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,'prepared','{}',$11,$12,$13,$14)`,
     [id,owner,input.requestId,JSON.stringify(input),input.taskId,role.id,task.version,role.version,'fixture-'+input.requestId,id,clock().toISOString(),input.permissionMode??null,input.model?JSON.stringify({primary:input.model}):null,input.model!==undefined])
    run={id,state:'prepared',taskId:input.taskId,roleId:role.id,roleVersion:role.version,taskVersion:task.version,linkVersion:1,sessionId:'fixture-'+input.requestId,nativeRequestId:id,stopRequestedAt:null,evidence:null,allowedTools:[],skills:[],knowledge:[],memory:[],inputText:'{}',createdAt:clock().toISOString(),...(input.permissionMode?{permissionMode:input.permissionMode as never}:{}),modelPolicy:{primary:input.model??{provider:'fixture',model:'default'}},...(input.model?{modelPolicyOverride:true}:{})} as TaskRun
    runs.set(input.requestId,run)
   }
   return run
  },
  start:async(owner,id)=>{
   calls.push('start:'+id);const run=runById(id)
   const task=(await pool.query("update teloa_tasks set state='running',version=version+1,updated_at=$3 where owner_id=$1 and id=$2 and state in ('ready','paused','blocked') returning version",[owner,run.taskId,clock().toISOString()])).rows[0]
   if(!task)throw Error('task cannot start')
   await pool.query("update teloa_task_runs set state='submitting',task_state_version=$3 where owner_id=$1 and id=$2",[owner,id,task.version])
   run.state='active';return run
  },
  read:async(_owner,id)=>runById(id),
  stop:async(owner,id)=>{
   calls.push('stop:'+id);const run=runById(id);run.state='ended';run.stopRequestedAt=clock().toISOString();run.evidence={state:'ended',turn:1,messageSeq:1,endSeq:4,reason:'cancelled'}
   await pool.query('update teloa_task_runs set state=$3,evidence=$4 where owner_id=$1 and id=$2',[owner,id,'ended',JSON.stringify(run.evidence)]);return run
  },
  withdraw:async(owner,id)=>{calls.push('withdraw:'+id);const run=runById(id);run.state='withdrawn';await pool.query("update teloa_task_runs set state='withdrawn' where owner_id=$1 and id=$2",[owner,id]);return run},
  waiting:async()=>waiting,
  result:async()=>({text:resultText,review:'unreviewed'}),
 }
 const complete=async()=>{
  for(const run of runs.values()){
   run.state='ended';run.evidence={state:'ended',turn:1,messageSeq:1,endSeq:4,reason:'completed'}
   const row=(await pool.query('select task_state_version from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.id])).rows[0]
   if(row?.task_state_version===null||row?.task_state_version===undefined)throw Error('run was not started')
   await pool.query("update teloa_tasks set state='waiting',version=version+1,updated_at=$4 where owner_id=$1 and id=$2 and state='running' and version=$3",[owner,run.taskId,row.task_state_version,clock().toISOString()])
   await pool.query("update teloa_task_runs set state='ended',evidence=$3 where owner_id=$1 and id=$2",[owner,run.id,JSON.stringify(run.evidence)])
  }
 }
 return {owner,role,keys,issued,identity,secrets,secretPort,runs,calls,checks,prepares,setCheckError:(error:Error|undefined)=>{checkError=error},setResult:(value:string)=>{resultText=value},setWaiting:(value:boolean)=>{waiting=value},work:new EmployeeApiWorkService(pool,keys,runtime,owner,clock),complete}
}
const next=()=>{now=new Date(now.getTime()+3000)}
test('高熵集成密钥只存摘要，员工与权限隔离、轮换、过期及撤销不授予工具',async()=>{
 const f=await fixture(['read'])
 assert.equal((await f.work.employees(f.identity)).items[0]?.id,f.role.id)
 assert.doesNotMatch(JSON.stringify((await pool.query('select * from teloa_employee_integrations where id=$1',[f.identity.id])).rows),new RegExp(f.issued.apiKey))
 assert.doesNotMatch(JSON.stringify(await f.keys.list(f.owner)),/tokenHash|token_hash|apiKey/)
 await assert.rejects(()=>f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'核对'}),{code:'forbidden'})
 const rotated=await f.keys.rotate(f.owner,{id:f.identity.id});await assert.rejects(()=>f.keys.authenticate(f.issued.apiKey),{code:'unauthorized'})
 const current=await f.keys.authenticate(rotated.apiKey);await assert.rejects(()=>f.work.employees(f.identity),{code:'unauthorized'})
 await f.keys.revoke(f.owner,{id:current.id});await assert.rejects(()=>f.keys.authenticate(rotated.apiKey),{code:'unauthorized'})
 assert.deepEqual(f.calls,[])
 const expired=await fixture(['read']);await pool.query('update teloa_employee_integrations set expires_at=$2 where id=$1',[expired.identity.id,new Date(clock().getTime()-1000)])
 await assert.rejects(()=>expired.keys.authenticate(expired.issued.apiKey),{code:'unauthorized'});await assert.rejects(()=>expired.work.employees(expired.identity),{code:'unauthorized'})
})
test('同幂等键并发创建一个Task与真实集成来源，异文冲突，其他凭据不能访问',async()=>{
 const f=await fixture(),requestId=randomUUID(),input={employeeId:f.role.id,input:'核对本次资料'}
 const responses=await Promise.all(Array.from({length:5},()=>f.work.command(f.identity,'start',requestId,input)))
 assert.ok(responses.every(row=>row.id===responses[0]!.id));assert.equal(responses[0]!.state,'queued');assert.deepEqual(f.calls,[])
 const rounds=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1',[responses[0]!.id])).rows
 assert.equal(rounds.length,1)
 const lineage=await new WorkLineageService(pool,{id:randomUUID,now:()=>clock().toISOString()}).read(f.owner,{taskId:rounds[0].task_id})
 assert.equal(lineage?.rootTaskId,rounds[0].task_id)
 assert.deepEqual((await pool.query('select source from teloa_task_work_lineage where task_id=$1',[rounds[0].task_id])).rows[0].source,{kind:'integration',workId:responses[0]!.id,round:1})
 await assert.rejects(()=>f.work.command(f.identity,'start',requestId,{...input,input:'变更原文'}),{code:'idempotency_conflict'})
 const other=await fixture();await assert.rejects(()=>other.work.get(other.identity,responses[0]!.id),{code:'not_found'})
 assert.equal((await f.work.events(f.identity,responses[0]!.id)).items.length,1)
})
test('运行、固定结果、后续轮次与版本、取消按不同状态返回',async()=>{
 const f=await fixture(),saved=await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'核对第一轮'})
 await f.work.tick(AbortSignal.timeout(5000));let current=await f.work.get(f.identity,saved.id);assert.equal(current.state,'running');assert.equal(f.calls.length,2)
 next();f.setWaiting(true);await f.work.tick(AbortSignal.timeout(5000));assert.equal((await f.work.get(f.identity,saved.id)).state,'waiting');f.setWaiting(false)
 next();f.complete();await f.work.tick(AbortSignal.timeout(5000));current=await f.work.get(f.identity,saved.id);assert.equal(current.state,'succeeded')
 const result=await f.work.result(f.identity,saved.id);assert.equal(result.review,'unreviewed');assert.equal(result.round,1)
 await assert.rejects(()=>f.work.command(f.identity,'continue',randomUUID(),{expectedVersion:saved.version,input:'续做'},saved.id),{code:'version_conflict'})
 const continued=await f.work.command(f.identity,'continue',randomUUID(),{expectedVersion:current.version,input:'再核对第二轮'},saved.id)
 assert.equal(continued.id,saved.id);assert.equal(continued.round,2)
 assert.deepEqual(await f.work.result(f.identity,saved.id,1),result)
 const cancelled=await f.work.command(f.identity,'cancel',randomUUID(),{expectedVersion:continued.version},saved.id);assert.equal(cancelled.state,'cancel_requested')
 next();await f.work.tick(AbortSignal.timeout(5000));current=await f.work.get(f.identity,saved.id);assert.equal(current.state,'cancelled')
 assert.equal((await pool.query('select t.state from teloa_tasks t join teloa_employee_api_rounds r on r.task_id=t.id where r.work_id=$1 and r.round=2',[saved.id])).rows[0].state,'cancelled')
 const repeated=await f.work.command(f.identity,'cancel',randomUUID(),{expectedVersion:current.version},saved.id);assert.equal(repeated.state,'cancelled')
 const events=await f.work.events(f.identity,saved.id);assert.ok(events.items.every(x=>x.event.specversion==='1.0'&&x.event.data.id===saved.id));assert.equal((await f.work.events(f.identity,saved.id,events.nextCursor)).items.length,0)
 assert.deepEqual(await f.work.get(f.identity,saved.id),current)
})
test('按请求保存权限模式与模型，续办继承上一轮选择且幂等键不能改档',async()=>{
 const f=await fixture(),requestId=randomUUID()
 const work=await f.work.command(f.identity,'start',requestId,{employeeId:f.role.id,input:'按只读模式核对',permissionMode:'read-only',model:{provider:'custom-provider',model:'example-model',reasoningEffort:'high'}})
 assert.equal(work.permissionMode,'read-only');assert.deepEqual(work.model,{provider:'custom-provider',model:'example-model',reasoningEffort:'high'})
 assert.deepEqual(f.checks.at(-1),{permissionMode:'read-only',model:{provider:'custom-provider',model:'example-model',reasoningEffort:'high'}})
 const rounds=()=>pool.query('select * from teloa_employee_api_rounds where work_id=$1 order by round',[work.id]).then(rows=>rows.rows)
 let stored=await rounds();assert.equal(stored[0]!.permission_mode,'read-only');assert.equal(stored[0]!.model_provider,'custom-provider');assert.equal(stored[0]!.model_id,'example-model');assert.equal(stored[0]!.model_reasoning_effort,'high')
 await assert.rejects(()=>f.work.command(f.identity,'start',requestId,{employeeId:f.role.id,input:'按只读模式核对',permissionMode:'workspace-write',model:{provider:'custom-provider',model:'example-model',reasoningEffort:'high'}}),{code:'idempotency_conflict'})
 await assert.rejects(()=>f.work.command(f.identity,'continue',randomUUID(),{expectedVersion:work.version,input:'换档',permissionMode:'auto'},work.id),{code:'invalid_request'})
 await f.work.tick(AbortSignal.timeout(5000))
 assert.equal(f.prepares[0]!.permissionMode,'read-only');assert.deepEqual(f.prepares[0]!.model,{provider:'custom-provider',model:'example-model',reasoningEffort:'high'})
 assert.deepEqual((await f.work.get(f.identity,work.id)).model,{provider:'custom-provider',model:'example-model',reasoningEffort:'high'})
 next();f.complete();await f.work.tick(AbortSignal.timeout(5000));let current=await f.work.get(f.identity,work.id);assert.equal(current.state,'succeeded')
 const continued=await f.work.command(f.identity,'continue',randomUUID(),{expectedVersion:current.version,input:'按上一轮继续'},work.id)
 assert.equal(continued.permissionMode,'read-only');assert.deepEqual(continued.model,{provider:'custom-provider',model:'example-model',reasoningEffort:'high'})
 stored=await rounds();assert.equal(stored[1]!.permission_mode,'read-only');assert.equal(stored[1]!.model_provider,'custom-provider')
 assert.deepEqual(f.checks.at(-1),{permissionMode:'read-only',model:{provider:'custom-provider',model:'example-model',reasoningEffort:'high'}})
 next();await f.work.tick(AbortSignal.timeout(5000))
 assert.equal(f.prepares[1]!.permissionMode,'read-only');assert.deepEqual(f.prepares[1]!.model,{provider:'custom-provider',model:'example-model',reasoningEffort:'high'})
})
test('权限预设不可用时明确拒绝且不创建工作',async()=>{
 const f=await fixture();f.setCheckError(new EmployeeApiError('permission_mode_unavailable','missing preset',409))
 await assert.rejects(()=>f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'核对'}),{code:'permission_mode_unavailable'})
 assert.equal((await pool.query('select count(*)::int n from teloa_employee_api_work where owner_id=$1',[f.owner])).rows[0].n,0)
})
test('成功结果在同一事务生成正式成果、完成关联任务并更新工作进展',async()=>{
 const f=await fixture(),work=await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'核对并生成报告'})
 await f.work.tick(AbortSignal.timeout(5000));f.complete()
 next();await f.work.tick(AbortSignal.timeout(5000))
 const current=await f.work.get(f.identity,work.id),result=await f.work.result(f.identity,work.id)
 assert.equal(current.state,'succeeded');assert.equal(current.permissionMode,'danger-full-access');assert.deepEqual(current.model,{provider:'fixture',model:'default'})
 const round=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1 and round=1',[work.id])).rows[0],task=(await pool.query('select * from teloa_tasks where owner_id=$1 and id=$2',[f.owner,round.task_id])).rows[0]
 assert.equal(task.state,'completed')
 const completion=(await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,task.id])).rows[0]
 assert.equal(completion.task_version,task.version);assert.equal(completion.artifact_version,1)
 const artifact=(await pool.query('select * from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=1',[f.owner,completion.artifact_id])).rows[0]
 assert.equal(artifact.source.kind,'task');assert.equal(artifact.source.id,task.id);assert.equal(artifact.content.sections.map((section:{text:string})=>section.text).join(''),result.text)
 const progress=(await pool.query('select * from teloa_work_progress where owner_id=$1 and root_task_id=$2',[f.owner,task.id])).rows[0].progress
 assert.equal(progress.stage,'报告已自动交付');assert.equal(progress.wait,null);assert.deepEqual(progress.artifactIds,[completion.artifact_id])
 const delivery=(await pool.query('select * from teloa_employee_api_round_deliveries where work_id=$1 and round=1',[work.id])).rows[0]
 assert.equal(delivery.artifact_id,completion.artifact_id);assert.equal(delivery.result_version,result.version);assert.equal(delivery.task_version,task.version)
 const events=await f.work.events(f.identity,work.id);assert.equal(events.items.at(-1)?.event.data.permissionMode,'danger-full-access');assert.deepEqual(events.items.at(-1)?.event.data.model,{provider:'fixture',model:'default'})
 const count=async()=>(await pool.query('select count(*)::int n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n
 const before=await count();next();await f.work.tick(AbortSignal.timeout(5000));assert.equal(await count(),before)
})
test('升级前已保存固定结果但任务仍等待的工作直接补齐交付，不重新准备或重复成果',async()=>{
 const f=await fixture(),work=await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'旧结果补交付'})
 await f.work.tick(AbortSignal.timeout(5000));f.complete();next();await f.work.tick(AbortSignal.timeout(5000))
 const round=(await pool.query('select * from teloa_employee_api_rounds where work_id=$1 and round=1',[work.id])).rows[0],delivery=(await pool.query('select * from teloa_employee_api_round_deliveries where work_id=$1 and round=1',[work.id])).rows[0]
 const calls=f.calls.length
 await pool.query('delete from teloa_employee_api_round_deliveries where work_id=$1',[work.id])
 await pool.query('delete from teloa_work_progress_receipts where owner_id=$1',[f.owner])
 await pool.query('delete from teloa_work_progress where owner_id=$1',[f.owner])
 await pool.query('delete from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,round.task_id])
 await pool.query('delete from teloa_task_transitions where owner_id=$1 and task_id=$2',[f.owner,round.task_id])
 await pool.query('delete from teloa_artifact_versions where owner_id=$1 and artifact_id=$2',[f.owner,delivery.artifact_id])
 await pool.query('delete from teloa_artifacts where owner_id=$1 and id=$2',[f.owner,delivery.artifact_id])
 const run=(await pool.query('select task_state_version from teloa_task_runs where owner_id=$1 and id=$2',[f.owner,round.run_id])).rows[0]
 await pool.query("update teloa_tasks set state='waiting',version=$3,updated_at=$4 where owner_id=$1 and id=$2",[f.owner,round.task_id,run.task_state_version+1,clock().toISOString()])
 await pool.query("update teloa_employee_api_work set state='succeeded',result_version=1,error=null,delivery_required=true,next_check_at=$2 where id=$1",[work.id,clock()])
 next();await f.work.tick(AbortSignal.timeout(5000))
 assert.equal(f.calls.length,calls,'恢复交付不重新调用 prepare/start')
 const repaired=(await f.work.get(f.identity,work.id));assert.equal(repaired.state,'succeeded')
 const task=(await pool.query('select * from teloa_tasks where owner_id=$1 and id=$2',[f.owner,round.task_id])).rows[0];assert.equal(task.state,'completed')
 const repairedDelivery=(await pool.query('select * from teloa_employee_api_round_deliveries where work_id=$1 and round=1',[work.id])).rows[0];assert.notEqual(repairedDelivery.artifact_id,delivery.artifact_id)
 const progress=(await pool.query('select * from teloa_work_progress where owner_id=$1 and root_task_id=$2',[f.owner,round.task_id])).rows[0].progress;assert.equal(progress.stage,'报告已自动交付')
 assert.equal((await pool.query('select count(*)::int n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n,1)
 next();await f.work.tick(AbortSignal.timeout(5000));assert.equal((await pool.query('select count(*)::int n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n,1)
})
test('固定结果超过成果容量时明确失败且不截断、不创建正式成果',async()=>{
 const f=await fixture(),work=await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'超长报告'})
 f.setResult('x'.repeat(64001))
 await f.work.tick(AbortSignal.timeout(5000));f.complete();next();await f.work.tick(AbortSignal.timeout(5000))
 const current=await f.work.get(f.identity,work.id)
 assert.equal(current.state,'failed');assert.equal(current.error,'artifact_too_large')
 assert.equal((await f.work.result(f.identity,work.id)).text.length,64001)
 assert.equal((await pool.query('select count(*)::int n from teloa_artifacts where owner_id=$1',[f.owner])).rows[0].n,0)
 const round=(await pool.query('select task_id from teloa_employee_api_rounds where work_id=$1 and round=1',[work.id])).rows[0]
 assert.equal((await pool.query('select state from teloa_tasks where owner_id=$1 and id=$2',[f.owner,round.task_id])).rows[0].state,'waiting')
})
test('并发额度、配置版本变化与尚未派发时撤销，均在原生执行之前拒绝',async()=>{
 const f=await fixture(),one=await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'第一项'})
 await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'第二项'})
 await assert.rejects(()=>f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'第三项'}),{code:'concurrency_limit'})
 await f.keys.revoke(f.owner,{id:f.identity.id});next();await f.work.tick(AbortSignal.timeout(5000));assert.deepEqual(f.calls,[])
 assert.equal((await pool.query('select state from teloa_employee_api_work where id=$1',[one.id])).rows[0].state,'cancelled')
 const changed=await fixture();await pool.query('update teloa_roles set version=version+1 where id=$1',[changed.role.id])
 await assert.rejects(()=>changed.work.command(changed.identity,'start',randomUUID(),{employeeId:changed.role.id,input:'旧配置'}),{code:'employee_changed'})
})
test('CloudEvents固定事件ID、HMAC原始正文、失败重试、人工重投与撤销取消回调',async()=>{
 const f=await fixture(undefined,'http://127.0.0.1:12345/callback'),work=await f.work.command(f.identity,'start',randomUUID(),{employeeId:f.role.id,input:'通知测试'})
 const attempts:{body:string;headers:Headers}[]=[],statuses=[503,200]
 const hooks=new EmployeeApiWebhooks(pool,f.secretPort,f.owner,async(_url,init)=>{attempts.push({body:String(init?.body),headers:new Headers(init?.headers)});return new Response('',{status:statuses.shift()??503})},clock)
 await hooks.tick(AbortSignal.timeout(5000));next();await hooks.tick(AbortSignal.timeout(5000))
 assert.equal(attempts.length,2);assert.equal(attempts[0]!.headers.get('teloa-webhook-id'),attempts[1]!.headers.get('teloa-webhook-id'))
 const a=attempts[1]!,timestamp=a.headers.get('teloa-webhook-timestamp')!,signature=a.headers.get('teloa-webhook-signature')!
 assert.equal(await verifyWebhook({body:a.body,secret:f.issued.signingSecret!,timestamp,signature,now:clock().getTime()}),true)
 assert.equal(await verifyWebhook({body:a.body+' ',secret:f.issued.signingSecret!,timestamp,signature,now:clock().getTime()}),false)
 assert.equal((await hooks.list(f.owner,f.identity.id))[0]!.state,'delivered')
 const event=(await f.work.events(f.identity,work.id)).items[0]!.event
 await pool.query("update teloa_employee_api_deliveries set state='failed' where event_id=$1",[event.id]);assert.equal((await hooks.retry(f.owner,event.id)).retried,true)
 await f.keys.revoke(f.owner,{id:f.identity.id});await hooks.tick(AbortSignal.timeout(5000));assert.equal((await hooks.list(f.owner,f.identity.id))[0]!.state,'cancelled');assert.equal(attempts.length,2)
})
