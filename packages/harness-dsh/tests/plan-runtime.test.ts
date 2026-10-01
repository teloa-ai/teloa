import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {ConversationService,openResourceDatabase,RoleService,PlanService,TaskRunService,initializeRoles,initializeTasks,initializePlans,initializeMarketContents,initializePlanOccurrences,initializeObjectConversations,initializeTaskRuns,initializePlanSchedulerStatus,PlanOccurrenceService,PlanSchedulerStatusService} from '@teloa/backend'
import {testRoleResponsibility} from './role-test-fixture.ts'
import type {TaskExecutionScope,RunSkill,RunKnowledge} from '@teloa/backend'
import type {Conversation} from '@teloa/contract'
import {createPlanRuntime} from '../src/plan-runtime.ts'
import type {TaskRunPorts} from '../src/task-run-driver.ts'

let container:StartedPostgreSqlContainer,pool:TaskRunService['pool'],temporary:string
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-plan-runtime-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,{id:randomUUID,now:()=>new Date().toISOString()})).pool
 await initializeRoles(pool);await initializeTasks(pool);await initializePlans(pool);await initializeMarketContents(pool);await initializePlanOccurrences(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializePlanSchedulerStatus(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

async function fixture(){
 const owner=randomUUID();let now='2026-09-12T00:00:00.000Z',rows:Conversation[]=[],beforeRunService:(()=>Promise<void>)|undefined
 const sessions=new Set<string>(),identity={id:randomUUID,now:()=>now}
 const conversations=new ConversationService({read:async()=>rows,write:async value=>{rows=structuredClone(value)}},{create:async id=>{sessions.add(id);return id},inspect:async id=>{assert.ok(sessions.has(id))}},identity)
 const content='核对资料来源。',skill:RunSkill={name:'verify-source',provider:'test',source:'fixed',description:'核对来源',content,sha256:createHash('sha256').update(content).digest('hex')}
 const text='可信资料正文',knowledge:RunKnowledge={id:randomUUID(),version:1,title:'参考资料',sourceId:'reference',sourceVersion:createHash('sha256').update(text).digest('hex'),scopeIds:['general'],text}
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'资料核对岗',kind:'employee',scopes:['general'],duty:'核对',dataScope:'限定资料',executionScope:'只读',skills:[skill.name],knowledge:[knowledge.id],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'security-analyst'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const plans=new PlanService(pool,identity),created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'每日核对',goal:'核对资料来源',scope:'general',dataScope:'本人指定资料',delivery:'资料差异及来源',roleId:role.id,expectedRoleVersion:1,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'},source:{kind:'manual'}})
 const plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'})
 const calls={sends:0,checks:0,skills:0,skillDatabases:[] as unknown[],knowledge:[] as TaskExecutionScope[]}
 const runPorts:TaskRunPorts={
  resolvePreset:async declared=>declared??'default-agent',
  check:async(_run,signal)=>{signal.throwIfAborted();calls.checks++},
  loadSkills:async(_session,names,signal,database)=>{signal.throwIfAborted();assert.deepEqual(names,[skill.name]);calls.skills++;calls.skillDatabases.push(database);return [skill]},
  loadKnowledge:async(target,ids,signal)=>{signal.throwIfAborted();assert.deepEqual(ids,[knowledge.id]);calls.knowledge.push(target);return [knowledge]},
  send:async()=>{calls.sends++},stop:async()=>{},events:async()=>[],
 }
 const getRunService=async():Promise<TaskRunService>=>{await beforeRunService?.();return new TaskRunService(pool,identity,(actor,id)=>conversations.bySession(actor,id),{allowedTools:[],runReservation:(actor,id)=>conversations.isTaskRunReserved(actor,id),planContext:(db,actor,taskId)=>runtime.executionContext(db,actor,taskId)})}
 const runtime=createPlanRuntime({owner,getPool:async()=>pool,conversations,getRunService,runPorts})
 return {owner,plan,plans,role,conversations,runtime,runPorts,calls,setNow:(value:string)=>{now=value},setBeforeRunService:(value:(()=>Promise<void>)|undefined)=>{beforeRunService=value},getRunService}
}

test('创建runtime不读取数据库、不建表、不启动调度',()=>{
 let calls=0
 createPlanRuntime({owner:'owner',getPool:async()=>{calls++;throw Error('不得调用')},getRunService:async()=>{throw Error('不得调用')},conversations:{createRun:async()=>{throw Error('不得调用')},runReservation:async()=>{throw Error('不得调用')},failRunReservation:async()=>{throw Error('不得调用')},bySession:async()=>{throw Error('不得调用')}},runPorts:{check:async()=>{},send:async()=>{},stop:async()=>{},events:async()=>[]}})
 assert.equal(calls,0)
})

test('runtime 将独立通知端口接入协调周期，不把结果写入调度状态',async()=>{
 const f=await fixture();let deliveries=0,reports:string[]=[]
 const runtime=createPlanRuntime({owner:f.owner,getPool:async()=>pool,conversations:f.conversations,getRunService:f.getRunService,runPorts:f.runPorts,deliverNotifications:async(owner,signal)=>{assert.equal(owner,f.owner);signal.throwIfAborted();deliveries++},reportNotification:code=>reports.push(code)})
 await runtime.coordinator.recover('2026-09-12T00:00:00.000Z',new AbortController().signal)
 assert.equal(deliveries,1);assert.deepEqual(reports,[])
 assert.equal((await runtime.status({}))?.health,'healthy')
})

test('真实计划到期经helper创建普通任务并准备发送，技能知识使用可信执行范围',async()=>{
 const f=await fixture(),signal=new AbortController().signal
 await f.runtime.coordinator.recover('2026-09-12T00:59:59.000Z',signal)
 f.setNow('2026-09-12T01:00:00.000Z');await f.runtime.coordinator.tick('2026-09-12T01:00:00.000Z',signal)
 assert.equal(f.calls.sends,1);assert.equal(f.calls.skills,1);assert.ok(f.calls.checks>=2)
 assert.equal(typeof (f.calls.skillDatabases[0] as {query?:unknown})?.query,'function','计划 prepare 必须把已持有的事务连接传给 Skill 安装复验')
 const tasks=(await pool.query('select * from teloa_tasks where owner_id=$1',[f.owner])).rows
 assert.equal(tasks.length,1);assert.equal(tasks[0].state,'running')
 assert.equal(f.calls.knowledge.length,1)
 const run=(await (await f.getRunService()).list(f.owner,{taskId:tasks[0].id}))[0]!
 assert.equal(run.agentPresetId,'security-analyst')
 assert.deepEqual(f.calls.knowledge[0],{taskId:tasks[0].id,taskVersion:1,sessionId:run.sessionId,linkVersion:1,scope:'general'})
 assert.equal(run.state,'accepted');assert.equal(JSON.parse(run.inputText).planContext.delivery,'资料差异及来源')
 assert.equal((await f.runtime.status({planId:f.plan.id}))?.health,'healthy')
 assert.equal((await f.runtime.status({}))?.lastAttemptAt,'2026-09-12T01:00:00.000Z')
 const overview=await f.runtime.overview({planId:f.plan.id});assert.equal(overview.latest?.task?.id,tasks[0].id)
 const history=await f.runtime.readPorts.executionHistory(f.owner,{planId:f.plan.id,limit:20})
 assert.equal(history.items.length,1)
 assert.equal(history.items[0]!.task!.id,tasks[0].id)
 assert.ok(history.items[0]!.run?.id)
 await assert.rejects(f.runtime.readPorts.executionHistory('other',{planId:f.plan.id,limit:20}),{code:'teloa/forbidden'})
 await f.runtime.coordinator.tick('2026-09-12T01:00:02.000Z',signal);assert.equal(f.calls.sends,1)
 await assert.rejects(f.runtime.readPorts.overview('other',{planId:f.plan.id}),{code:'teloa/forbidden'})
})

test('本人立即运行复用正式任务与Agent执行链，不改下一次日程且同请求不重复发送',async()=>{
 const f=await fixture(),signal=new AbortController().signal
 await f.runtime.coordinator.recover('2026-09-12T00:30:00.000Z',signal)
 const before=await f.runtime.overview({planId:f.plan.id})
 const requestId=randomUUID(),input={planId:f.plan.id,requestId,expectedVersion:f.plan.version,expectedConfigVersion:f.plan.configVersion,now:'2026-09-12T00:31:00.000Z'}
 const first=await f.runtime.trigger(input,signal)
 assert.equal(first.occurrence.occurrenceId,'manual:'+requestId)
 assert.equal(first.task.ownerId,f.owner);assert.equal(first.run.taskId,first.task.id)
 assert.equal(f.calls.sends,1);assert.equal(f.calls.skills,1);assert.equal(f.calls.knowledge.length,1)
 const after=await f.runtime.overview({planId:f.plan.id})
 assert.equal(after.nextAt,before.nextAt)
 const again=await f.runtime.trigger(input,signal)
 assert.equal(again.task.id,first.task.id);assert.equal(again.run.id,first.run.id);assert.equal(f.calls.sends,1)
})

test('计划岗位未声明 preset 时解析并固定宿主真实默认配置',async()=>{
 const f=await fixture(),signal=new AbortController().signal;let declared:unknown='not-called'
 await pool.query("update teloa_roles set definition=definition-'runtimeConfig' where id=$1",[f.role.id])
 f.runPorts.resolvePreset=async value=>{declared=value;return 'default-agent'}
 await f.runtime.coordinator.recover('2026-09-12T00:59:59.000Z',signal)
 f.setNow('2026-09-12T01:00:00.000Z');await f.runtime.coordinator.tick('2026-09-12T01:00:00.000Z',signal)
 const task=(await pool.query('select id from teloa_tasks where owner_id=$1',[f.owner])).rows[0]
 const run=(await (await f.getRunService()).list(f.owner,{taskId:task.id}))[0]!
 assert.equal(declared,undefined);assert.equal(run.agentPresetId,'default-agent');assert.equal(f.calls.sends,1)
})

test('计划运行配置失败保留终态执行并报告稳定失败，恢复不再启动 Agent',async()=>{
 const f=await fixture(),signal=new AbortController().signal
 f.runPorts.resolvePreset=async()=>{throw Error('preset missing')}
 await f.runtime.coordinator.recover('2026-09-12T00:59:59.000Z',signal)
 f.setNow('2026-09-12T01:00:00.000Z');await f.runtime.coordinator.tick('2026-09-12T01:00:00.000Z',signal)
 const task=(await pool.query('select id from teloa_tasks where owner_id=$1',[f.owner])).rows[0],runs=await (await f.getRunService()).list(f.owner,{taskId:task.id})
 assert.equal(runs[0]?.state,'configuration_failed');assert.equal(f.calls.sends,0)
 assert.equal((await f.runtime.status({planId:f.plan.id}))?.failureCode,'teloa/run-configuration-failed')
 assert.equal((await f.runtime.readPorts.executionHistory(f.owner,{planId:f.plan.id,limit:20})).items[0]?.run?.state,'configuration_failed')
 await f.runtime.coordinator.recover('2026-09-12T01:00:02.000Z',signal);assert.equal(f.calls.sends,0)
})

test('计划任务创建后岗位版本变化时，可信 prepare 在会话预约和 Run 前拒绝',async()=>{
 const f=await fixture(),signal=new AbortController().signal;let upgraded=false
 f.setBeforeRunService(async()=>{if(upgraded)return;upgraded=true;await pool.query('update teloa_roles set version=version+1 where id=$1',[f.role.id])})
 await f.runtime.coordinator.recover('2026-09-12T00:59:59.000Z',signal)
 f.setNow('2026-09-12T01:00:00.000Z');await f.runtime.coordinator.tick('2026-09-12T01:00:00.000Z',signal)
 const task=(await pool.query('select id,assignee_role_version from teloa_tasks where owner_id=$1',[f.owner])).rows[0]
 const occurrence=(await pool.query('select id from teloa_plan_occurrences where owner_id=$1',[f.owner])).rows[0]
 assert.equal(task.assignee_role_version,1)
 assert.equal((await f.runtime.status({planId:f.plan.id}))?.failureCode,'teloa/version-conflict')
 assert.equal(await f.conversations.runReservation(f.owner,{requestId:occurrence.id}),null)
 assert.equal((await pool.query('select count(*)::int count from teloa_object_conversations where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.equal((await pool.query('select count(*)::int count from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].count,0)
 assert.deepEqual(f.calls,{sends:0,checks:0,skills:0,skillDatabases:[],knowledge:[]})
})

test('发送回包未知持久记录失败，重建runtime只恢复原run且不重新发送',async()=>{
 const f=await fixture(),signal=new AbortController().signal
 f.runPorts.send=async()=>{f.calls.sends++;throw Error('原生提交结果未知')}
 await f.runtime.coordinator.recover('2026-09-12T00:59:59.000Z',signal)
 await f.runtime.coordinator.tick('2026-09-12T01:00:00.000Z',signal)
 assert.equal((await f.runtime.status({planId:f.plan.id}))?.failureCode,'teloa/execution-pending')
 assert.equal((await f.runtime.status({}))?.health,'failing')
 const restored=createPlanRuntime({owner:f.owner,getPool:async()=>pool,conversations:f.conversations,getRunService:f.getRunService,runPorts:f.runPorts})
 await restored.coordinator.recover('2026-09-12T01:00:02.000Z',signal)
 assert.equal((await restored.status({planId:f.plan.id}))?.failureCode,'teloa/execution-pending')
 assert.equal((await restored.status({}))?.health,'failing')
 await restored.coordinator.tick('2026-09-12T01:00:04.000Z',signal)
 assert.equal((await restored.status({planId:f.plan.id}))?.health,'failing')
 assert.equal(f.calls.sends,1)
 assert.equal((await pool.query('select count(*) from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].count,'1')
})

test('终态无run的skip通过helper写入真实ack，普通重叠skip不伪造失败',async()=>{
 const f=await fixture(),service=new PlanOccurrenceService(pool,{id:randomUUID}),signal=new AbortController().signal
 const claim=(await service.claim(f.owner,{planId:f.plan.id,now:'2026-09-12T01:00:00.000Z'})).occurrence!
 const {task}=await service.dispatchTask(f.owner,{claimId:claim.id,taskRequestId:claim.taskRequestId,now:'2026-09-12T01:00:00.000Z'})
 await pool.query("update teloa_tasks set state='cancelled' where id=$1",[task.id])
 await f.runtime.coordinator.recover('2026-09-12T01:00:02.000Z',signal)
 const ack=await new PlanSchedulerStatusService(pool,{now:()=>new Date().toISOString()}).acknowledgement(f.owner,{claimId:claim.id})
 assert.equal(ack.taskId,task.id);assert.equal(ack.acknowledgedAt,'2026-09-12T01:00:02.000Z');assert.equal(f.calls.sends,0)
 assert.equal((await f.runtime.status({}))?.health,'healthy')
 const prior=await f.runtime.status({planId:f.plan.id})
 await f.runtime.coordinator.ports.report(f.owner,{phase:'skip',planId:f.plan.id,now:'2026-09-12T01:00:03.000Z',outcome:'skipped',code:'teloa/plan-pending-overlap'},signal)
 assert.deepEqual(await f.runtime.status({planId:f.plan.id}),prior)
})
