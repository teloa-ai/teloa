import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Context} from '@deepseek-ai/cordis'
import {ToolRuntime} from '@deepseek-ai/dsh-tools'
import {SystemPrompt} from '@deepseek-ai/dsh-system-prompt'
import {LlmRuntime,ToolCallId} from '@deepseek-ai/dsh-llm'
import {SessionStore,SessionId} from '@deepseek-ai/dsh-session'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {AgentLoop} from '@deepseek-ai/dsh-agent-loop'
import {SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection'
import {openResourceDatabase,AutoDreamHabitService,readAutoDreamSetting,AUTO_DREAM_DEFAULT_TRIGGER,ObjectConversationService,PlanOccurrenceService,RoleDailyLogService,RoleMemoryService,RoleService,TaskRunService,TaskService,initializeResources,initializeRoles,initializeTasks,initializeObjectConversations,initializeTaskRuns,initializeArtifactSnapshots,initializeArtifacts,initializeMarkdownKnowledge,initializeRoleMemory,initializeCollaboration,initializePlans,initializePlanOccurrences,initializeBusinessData,initializeBusinessTasks,initializeSecurityRequests,initializeSecurityActions,initializeSecurityApprovals,initializeRoleDailyLogs} from '@teloa/backend'
import {createRoleDailyLogHandler,registerRoleDailyDigestTools,roleDayEvidenceToolName} from '../src/role-daily-log.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:RoleDailyLogService['pool'],temporary:string
const identity={id:randomUUID,now:()=>new Date().toISOString()}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').withDatabase('teloa').start()
 temporary=await mkdtemp(join(tmpdir(),'teloa-role-daily-log-'));const config=join(temporary,'database.json')
 await writeFile(config,JSON.stringify({connectionString:container.getConnectionUri()}),{mode:0o600})
 pool=(await openResourceDatabase(config,identity)).pool
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeMarkdownKnowledge(pool);await initializeRoleMemory(pool)
 await initializeCollaboration(pool);await initializePlans(pool);await initializePlanOccurrences(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool)
 await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool)
 await initializeRoleDailyLogs(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop();if(temporary)await rm(temporary,{recursive:true,force:true})})

/**
 * 观察日由真实时钟与 `trigger`（23:30 Asia/Singapore）决定，可能是本地今天也可能是本地昨天。
 * 夹具不重算那条规则：两天各放一条交办文案，无论落在哪一天都有当天证据，且只会生成一条观察。
 */
const singaporeDay=(shift:number)=>new Date(Date.now()+8*3600*1000+shift*86400000).toISOString().slice(0,10)
const noonUtc=(day:string)=>day+'T04:00:00.000Z' // 12:00 Asia/Singapore

async function world(){
 const owner='local:'+randomUUID(),roles=new RoleService(pool,identity)
 const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'核对来源',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const twin=await roles.create(owner,{requestId:randomUUID(),fields:{name:'我的分身',kind:'twin',scopes:['general'],duty:'代拟',dataScope:'个人工作资料',executionScope:'仅代拟，不执行',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 // Auto Dream 的开关与时刻只有一个载体：在岗同事的 system-digest 计划。
 const definition={title:'Auto Dream · 每日小结',goal:'习惯观察设置载体。',scope:'SOC',dataScope:'本人已授权资料。',delivery:'结论与证据。',roleId:employee.id,trigger:AUTO_DREAM_DEFAULT_TRIGGER,notificationPolicy:'silent'}
 const source={kind:'system-digest',roleId:employee.id},nowIso=new Date().toISOString()
 await pool.query(`insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at)
  values($1,$2,$3,$4,$5,$6,'silent',$7,1,'SOC',1,1,'active',null,null,$8,$8)`,
  [randomUUID(),owner,randomUUID(),JSON.stringify({fields:{...definition,expectedRoleVersion:1},source}),JSON.stringify(definition),JSON.stringify(source),employee.id,nowIso])
 // 证据第 3 类（交办文案）：本人直接建、不经持续计划领取的任务。
 for(const shift of [0,-1])await pool.query(`insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at)
  values($1,$2,$3,'{}'::jsonb,$4,1,'ready',$5,$5)`,
  [randomUUID(),owner,randomUUID(),JSON.stringify({title:'核对处置记录',goal:'核对处置记录，需要写验收标准。',scope:'SOC',groupId:null,skills:[]}),noonUtc(singaporeDay(shift))])
 const logs=new RoleDailyLogService(pool,identity,new RoleMemoryService(pool,identity))
 const habits=new AutoDreamHabitService(pool,identity,logs,readAutoDreamSetting)
 // 与正式宿主同形接线：目录读口先取岗位，分身才惰性生成当天那一条。
 const handle=createRoleDailyLogHandler(owner,async()=>logs,async()=>({
  role:async roleId=>(await roles.list(owner,{})).find(role=>role.id===roleId),
  ensureForDay:(actor,role,nowIso)=>habits.ensureForDay(actor,role,nowIso),
 }))
 return {owner,employee,twin,handle}
}

test('本人读分身目录时惰性生成当天习惯观察；读同事目录不触发生成',{timeout:120000},async()=>{
 const f=await world()
 const employeeItems=(await f.handle('role-daily-log/list',{roleId:f.employee.id})) as {items:{kind:string}[]}
 assert.deepEqual(employeeItems.items,[])
 assert.equal(Number((await pool.query('select count(*)::int n from teloa_role_daily_logs where owner_id=$1',[f.owner])).rows[0].n),0)

 const first=(await f.handle('role-daily-log/list',{roleId:f.twin.id})) as {items:{kind:string;state:string;day:string}[]}
 assert.equal(first.items.length,1)
 assert.equal(first.items[0]!.kind,'habit-digest')
 assert.equal(first.items[0]!.state,'kept')
 assert.ok([singaporeDay(0),singaporeDay(-1)].includes(first.items[0]!.day))

 // 同一天重复打开目录不会再生成第二条。
 const second=(await f.handle('role-daily-log/list',{roleId:f.twin.id})) as {items:unknown[]}
 assert.equal(second.items.length,1)
 assert.equal(Number((await pool.query("select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind='habit-digest'",[f.owner,f.twin.id])).rows[0].n),1)
})

test('习惯观察生成失败不影响目录读取',{timeout:120000},async()=>{
 const f=await world()
 const logs=new RoleDailyLogService(pool,identity,new RoleMemoryService(pool,identity))
 const roles=new RoleService(pool,identity)
 const broken=createRoleDailyLogHandler(f.owner,async()=>logs,async()=>({
  role:async roleId=>(await roles.list(f.owner,{})).find(role=>role.id===roleId),
  ensureForDay:async()=>{throw Error('习惯观察证据读取失败')},
 }))
 const items=(await broken('role-daily-log/list',{roleId:f.twin.id})) as {items:unknown[]}
 assert.deepEqual(items.items,[])
})

/**
 * 立即运行（`plans/trigger`）领取的 occurrenceId 形如 `manual:<taskRequestId>`，本身不带日期；
 * 定时领取的才是 `2026-09-21T23:30[Asia/Singapore]`。两条路径派出的都是同一个 system-digest 计划，
 * 小结闸必须都判成 `digest`。这里按真实真源接线：PlanOccurrenceService 领取派任务、TaskRunService 建运行、
 * RoleDailyLogService 认身份，再由真实的 `ports.run`/`ports.digestRun` 组合真跑一次 `teloa_role_day_evidence`。
 */
async function digestWorld(){
 const owner='local:'+randomUUID(),roles=new RoleService(pool,identity),planId=randomUUID(),nowIso=new Date().toISOString()
 const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'核对来源',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const definition={title:'Auto Dream · 每日小结',goal:'收口今天的工作并提出记忆候选。',scope:'SOC',dataScope:'本人已授权资料。',delivery:'结论与证据。',roleId:employee.id,trigger:AUTO_DREAM_DEFAULT_TRIGGER,notificationPolicy:'silent'}
 const source={kind:'system-digest',roleId:employee.id}
 await pool.query(`insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at)
  values($1,$2,$3,$4,$5,$6,'silent',$7,1,'SOC',1,1,'active',null,null,$8,$8)`,
  [planId,owner,randomUUID(),JSON.stringify({fields:{...definition,expectedRoleVersion:1},source}),JSON.stringify(definition),JSON.stringify(source),employee.id,nowIso])
 return {owner,employee,planId}
}

/** 与宿主同形：会话 id 用 `task-run-<claimId>`，运行由 prepare→claim→record 推进到 accepted。 */
async function startRun(owner:string,roleId:string,taskId:string,requestId:string){
 const sessionId='task-run-'+requestId,conversationId=randomUUID()
 const inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready' as const})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:taskId,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect)
 const prepared=await runs.prepare(owner,{requestId,taskId,expectedTaskVersion:1,roleId,expectedRoleVersion:1,sessionId,expectedLinkVersion:1})
 await runs.claim(owner,{runId:prepared.id})
 const run=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence:{state:'accepted'}})
 return {run,sessionId,inspect}
}

async function digestGate(owner:string,sessionId:string,inspect:()=>Promise<{id:string;sessionId:string;ownerId:string;status:'ready'}>){
 const ctx=new Context()
 await ctx.plugin(LlmRuntime);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]})
 const {agent}=await ctx.agents.create({sessionId:SessionId(sessionId),agentOptions:{provider:'test',model:'test'}})
 const logs=new RoleDailyLogService(pool,identity,new RoleMemoryService(pool,identity)),runs=new TaskRunService(pool,identity,inspect)
 registerRoleDailyDigestTools(ctx,{
  owner,
  run:id=>runs.skillScope(owner,{sessionId:id}),
  digestRun:id=>logs.digestRun(owner,{runId:id}),
  evidence:value=>logs.dayEvidence(owner,value),
  submit:(value,requestId,input)=>logs.submitDigest(owner,value,requestId,input),
 })
 return {ctx,read:()=>ctx.tools.execute({agent,name:roleDayEvidenceToolName,arguments:{},callId:ToolCallId('digest-1'),signal:AbortSignal.timeout(30000)})}
}

test('立即运行派出的 system-digest 运行被判成小结运行，当日证据读得出来',{timeout:120000},async t=>{
 const f=await digestWorld(),now=new Date().toISOString()
 const occurrences=new PlanOccurrenceService(pool,identity)
 const {occurrence}=await occurrences.trigger(f.owner,{planId:f.planId,requestId:randomUUID(),expectedVersion:1,expectedConfigVersion:1,now})
 assert.match(occurrence.occurrenceId,/^manual:/)
 const {task}=await occurrences.dispatchTask(f.owner,{claimId:occurrence.id,taskRequestId:occurrence.taskRequestId,now})
 const started=await startRun(f.owner,f.employee.id,task.id,occurrence.id)
 const gate=await digestGate(f.owner,started.sessionId,started.inspect);t.after(()=>gate.ctx.fiber.dispose())
 const result=await gate.read()
 assert.equal(result.isError,false,JSON.stringify(result))
 const text=result.content.find(item=>item.type==='text')
 assert.ok(text?.type==='text')
 const evidence=JSON.parse(text.text) as {day:string;roleId:string;runs:{id:string}[]}
 assert.equal(evidence.roleId,f.employee.id)
 assert.equal(evidence.day,singaporeDay(0))
 assert.ok(evidence.runs.some(item=>item.id===started.run.id))
})

test('普通任务的运行里两个小结工具一律拒绝',{timeout:120000},async t=>{
 const f=await digestWorld(),requestId=randomUUID()
 const task=await new TaskService(pool,identity).create(f.owner,{requestId,fields:{title:'核对处置记录',goal:'核对处置记录，需要写验收标准。',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:1}})
 const started=await startRun(f.owner,f.employee.id,task.id,requestId)
 const gate=await digestGate(f.owner,started.sessionId,started.inspect);t.after(()=>gate.ctx.fiber.dispose())
 const result=await gate.read()
 assert.equal(result.isError,true)
 assert.match(JSON.stringify(result),/这两个工具只能在 Auto Dream 的每日小结运行里使用。/)
})
