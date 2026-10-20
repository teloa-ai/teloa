import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHmac} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeTaskTransitions} from '../src/work/task-transitions.ts'
import {initializeEmployeeIntegrations,EmployeeIntegrationService} from '../src/work/employee-integrations.ts'
import {initializeEmployeeApiWork,EmployeeApiWorkService,type EmployeeApiRuntime} from '../src/work/employee-api-work.ts'
import {EmployeeApiWebhooks} from '../src/work/employee-api-webhooks.ts'
import {WorkLineageService} from '../src/work/work-lineage.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {TaskRun} from '../src/work/task-runs.ts'
import {verifyWebhook} from '../../sdk/index.mjs'

let container:StartedPostgreSqlContainer,pool:Pool,now:Date
const clock=()=>now
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskTransitions(pool);await initializeEmployeeIntegrations(pool);await initializeEmployeeApiWork(pool)
 now=new Date()
},{timeout:120_000})
after(async()=>{await pool?.end();await container?.stop()})
async function fixture(permissions=['read','execute','cancel'],webhookUrl?:string){
 const owner='local:'+randomUUID(),secrets=new Map<string,string>(),secretPort={write:async(id:string,value:string)=>{secrets.set(id,value)},read:async(id:string)=>secrets.get(id),remove:async(id:string)=>{secrets.delete(id)}}
 const keys=new EmployeeIntegrationService(pool,secretPort,clock)
 const role=await new RoleService(pool,{id:randomUUID,now:()=>clock().toISOString()}).create(owner,{requestId:randomUUID(),fields:{name:'API核对岗',kind:'employee',scopes:['general'],duty:'核对本人资料',dataScope:'本人提供的资料',executionScope:'只读核对',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const issued=await keys.create(owner,{name:'业务系统',employeeId:role.id,expectedEmployeeVersion:role.version,scope:'general',permissions,maxConcurrent:2,expiresInDays:30,...webhookUrl?{webhookUrl}:{}}),identity=await keys.authenticate(issued.apiKey)
 const runs=new Map<string,TaskRun>(),calls:string[]=[];let waiting=false
 const runtime:EmployeeApiRuntime={
  prepare:async(_owner,input)=>{calls.push('prepare:'+input.requestId);let run=runs.get(input.requestId);if(!run){run={id:randomUUID(),state:'prepared',taskId:input.taskId,stopRequestedAt:null,evidence:null} as TaskRun;runs.set(input.requestId,run)}return run},
  start:async(_owner,id)=>{calls.push('start:'+id);const run=[...runs.values()].find(r=>r.id===id)!;run.state='active';return run},
  read:async(_owner,id)=>[...runs.values()].find(r=>r.id===id)!,
  stop:async(_owner,id)=>{calls.push('stop:'+id);const run=[...runs.values()].find(r=>r.id===id)!;run.state='ended';run.stopRequestedAt=clock().toISOString();run.evidence={state:'ended',turn:1,messageSeq:1,endSeq:4,reason:'cancelled'};return run},
  withdraw:async(_owner,id)=>{calls.push('withdraw:'+id);const run=[...runs.values()].find(r=>r.id===id)!;run.state='withdrawn';return run},
  waiting:async()=>waiting,
  result:async()=>({text:'FIXED-RESULT-'+role.id,review:'unreviewed'}),
 }
 return {owner,role,keys,issued,identity,secrets,secretPort,runs,calls,setWaiting:(value:boolean)=>{waiting=value},work:new EmployeeApiWorkService(pool,keys,runtime,owner,clock),complete:()=>{for(const run of runs.values()){run.state='ended';run.evidence={state:'ended',turn:1,messageSeq:1,endSeq:4,reason:'completed'}}}}
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
