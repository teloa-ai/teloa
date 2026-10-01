import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError} from '@teloa/contract'
import {initializeResources} from '../src/capabilities/schema.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations} from '../src/work/object-conversations.ts'
import {initializeTaskRuns} from '../src/work/task-runs.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts} from '../src/work/artifacts.ts'
import {initializeMarkdownKnowledge} from '../src/capabilities/markdown-knowledge.ts'
import {initializeRoleMemory,RoleMemoryService} from '../src/work/role-memory.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializePlans} from '../src/work/plans.ts'
import {initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {initializeBusinessData,BusinessDataService} from '../src/work/business-data.ts'
import {initializeBusinessTasks,BusinessTaskService} from '../src/work/business-tasks.ts'
import {initializeSecurityRequests,SecurityRequestJournal} from '../src/security/request-journal.ts'
import {initializeSecurityActions,SecurityActionService} from '../src/security/actions.ts'
import {initializeSecurityApprovals,SecurityApprovalService} from '../src/security/approvals.ts'
import {createSecurityEndpointIsolateDefinition} from '../src/security/action-authorization.ts'
import {initializeRoleDailyLogs,RoleDailyLogService} from '../src/work/role-daily-logs.ts'
import {readAutoDreamSetting,AUTO_DREAM_DEFAULT_TRIGGER} from '../src/work/auto-dream-plans.ts'
import {AutoDreamHabitService} from '../src/work/auto-dream-habits.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const now='2026-09-15T02:00:00.000Z'
const inDay='2026-09-15T03:00:00.000Z'
const inDayLater='2026-09-15T04:00:00.000Z'
const outOfDay='2026-09-13T02:00:00.000Z'
const day='2026-09-15'
const nowIso='2026-09-15T15:45:00.000Z' // 23:45 SGT，晚于 23:30 触发时刻，观察日仍是同一天
const identity={id:randomUUID,now:()=>now}
const securityDefinition=createSecurityEndpointIsolateDefinition()
const catalog={require(tool:string){if(tool!==securityDefinition.tool)throw new WorkError('teloa/forbidden','未授权的工具。');return securityDefinition}}

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeResources(pool);await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)
 await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeMarkdownKnowledge(pool);await initializeRoleMemory(pool)
 await initializeCollaboration(pool);await initializePlans(pool);await initializePlanOccurrences(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool)
 await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool)
 await initializeRoleDailyLogs(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function world(){
 const owner=randomUUID(),roles=new RoleService(pool,identity)
 const employee=await roles.create(owner,{requestId:randomUUID(),fields:{name:'调查岗',kind:'employee',scopes:['SOC'],duty:'核对来源',dataScope:'已授权资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'standard'}}})
 const employeeVersion=Number((await pool.query('select version from teloa_roles where id=$1',[employee.id])).rows[0].version)
 const twin=await roles.create(owner,{requestId:randomUUID(),fields:{name:'我的分身',kind:'twin',scopes:['general'],duty:'代拟',dataScope:'个人工作资料',executionScope:'仅代拟，不执行',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const memory=new RoleMemoryService(pool,identity)
 const logs=new RoleDailyLogService(pool,identity,memory)
 const habits=new AutoDreamHabitService(pool,identity,logs,readAutoDreamSetting)
 return {owner,employee,employeeVersion,twin,memory,logs,habits,human:{ownerId:owner,kind:'human' as const}}
}

async function systemPlan(owner:string,roleId:string,state:'active'|'paused'='active'){
 const planId=randomUUID(),trigger=AUTO_DREAM_DEFAULT_TRIGGER
 const definition={title:'Auto Dream · 每日小结',goal:'习惯观察设置载体。',scope:'SOC',dataScope:'本人已授权资料。',delivery:'结论与证据。',roleId,trigger,notificationPolicy:'silent'}
 const source={kind:'system-digest',roleId}
 await pool.query(`insert into teloa_plans(id,owner_id,request_id,request_spec,definition,source,notification_policy,role_id,role_version,scope,version,config_version,state,archived_reason,archived_at,created_at,updated_at)
  values($1,$2,$3,$4,$5,$6,'silent',$7,1,'SOC',1,1,$8,null,null,$9,$9)`,
  [planId,owner,randomUUID(),JSON.stringify({fields:{...definition,expectedRoleVersion:1},source}),JSON.stringify(definition),JSON.stringify(source),roleId,state,now])
 return planId
}

async function run(owner:string,taskId:string,roleId:string,roleVersion:number,createdAt=inDay){
 const id=randomUUID()
 await pool.query(`insert into teloa_task_runs(id,owner_id,request_id,request_spec,task_id,role_id,task_version,role_version,link_version,session_id,native_request_id,state,input_text,created_at)
  values($1,$2,$3,'{}'::jsonb,$4,$5,1,$6,1,$7,$8,'accepted','{}',$9)`,[id,owner,randomUUID(),taskId,roleId,roleVersion,'session-'+id,randomUUID(),createdAt])
 return id
}

async function artifactVersion(owner:string,artifactId:string,number:number,source:Record<string,unknown>,bodyText:string,createdAt=inDay){
 if(number===1)await pool.query('insert into teloa_artifacts(id,owner_id,request_id,request_spec,source_key,current_version) values($1,$2,$3,\'{}\'::jsonb,$4,$5)',[artifactId,owner,randomUUID(),artifactId,number])
 else await pool.query('update teloa_artifacts set current_version=$2 where id=$1',[artifactId,number])
 const content={title:'处置报告',sections:[{id:'s1',title:'结论',text:bodyText}],snapshotIds:[],note:'无附件。'}
 await pool.query('insert into teloa_artifact_versions(owner_id,artifact_id,number,source,content,created_at) values($1,$2,$3,$4,$5,$6)',[owner,artifactId,number,JSON.stringify(source),JSON.stringify(content),createdAt])
}

async function approval(owner:string,reason:string,scope='SOC'){
 const principal={ownerId:owner,approverId:'local-self',scopeIds:[scope]},sourceId='security-alert-http'
 const alert={scope,type:'alert',id:'evt-'+randomUUID().slice(0,8),version:1,title:'prod-03 异常脚本',source:'EDR',observedAt:'2026-09-14T01:00:00.000Z',receivedAt:'2026-09-14T01:00:01.000Z',quality:'complete' as const,summary:'调查外联。',fields:[{label:'资产',value:'prod-03'}]}
 const data=new BusinessDataService(pool,{id:sourceId,scopes:[scope],query:async()=>({schema:'teloa.data-source-page/v1',sourceId,scope,capturedAt:'2026-09-14T01:00:02.000Z',items:[alert]})})
 const snapshot=(await data.query(principal,{scope,limit:10})).items[0]!
 const {task}=await new BusinessTaskService(pool,identity,new TaskService(pool,identity)).create(principal,{requestId:randomUUID(),reference:{scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash},goal:'核对资产风险'})
 const journal=new SecurityRequestJournal(pool),execution={existsForAction:async()=>false}
 const actions=new SecurityActionService(pool,identity,catalog,journal,execution)
 const approvals=new SecurityApprovalService(pool,identity,catalog,journal)
 const proposed=await actions.propose(principal,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,title:'隔离 prod-03',goal:'阻断异常外联',tool:securityDefinition.tool,targetSet:['prod-03'],params:{reason:'已核对异常进程'}})
 const pending=await actions.submit(principal,{requestId:randomUUID(),actionId:proposed.id,expectedActionVersion:proposed.version})
 const decided=await approvals.decide(principal,{requestId:randomUUID(),actionId:pending.id,expectedActionVersion:pending.version,decision:'approved',reason,impactConfirmed:true})
 return decided
}

async function correction(owner:string,colleagueRoleId:string,taskId:string,runId:string){
 const groupId=randomUUID(),rootId=randomUUID(),replyId=randomUUID()
 await pool.query(`insert into teloa_groups(id,owner_id,request_id,request_spec,definition,version,pinned,archived,created_at,updated_at)
  values($1,$2,$3,'{}'::jsonb,$4,1,false,false,$5,$5)`,[groupId,owner,randomUUID(),JSON.stringify({title:'处置组',scope:'SOC'}),now])
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id)
  values($1,$2,$3,$4,'{}'::jsonb,null,$5,'已按处置手册隔离。','[]'::jsonb,$6,$7,$8)`,[rootId,owner,groupId,randomUUID(),colleagueRoleId,inDay,taskId,runId])
 await pool.query(`insert into teloa_group_messages(id,owner_id,group_id,request_id,request_spec,root_id,author_id,text,reference_snapshot,created_at,task_id,run_id)
  values($1,$2,$3,$4,'{}'::jsonb,$5,'self','这里应该按最新标准重新处理。','[]'::jsonb,$6,null,null)`,[replyId,owner,groupId,randomUUID(),rootId,inDayLater])
 return {rootId,replyId}
}

test('当天四类操作各出现后产生一条 habit-digest，正文四段固定小节且不含模型措辞，重复调用当天只有一条',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'季度复盘',goal:'核对处置记录，需要写验收标准。',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 const runId=await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 // 类别 1：放行/拒绝
 const decided=await approval(f.owner,'已核对生产影响，允许隔离。')
 // 类别 2：修订（第 1 版来自运行，第 2 版为本人修订；正文含独特标记，断言绝不外泄）
 const secret='UNIQUE_SECRET_BODY_9f3e1c2b_不应出现在习惯观察里'
 const artifactId=randomUUID()
 await artifactVersion(f.owner,artifactId,1,{kind:'run',id:runId,scope:'SOC',version:'1',title:'处置报告'},'初版结论。')
 await artifactVersion(f.owner,artifactId,2,{kind:'session',id:'s-1',scope:'SOC',version:'1',title:'处置报告'},secret,inDayLater)
 // 类别 3：交办文案（额外两条任务，含重复短语与验收标准）
 await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对二',goal:'核对处置记录，确认无遗漏。',scope:'SOC'}})
 await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对三',goal:'编写压测报告，需要写验收标准。',scope:'SOC'}})
 // 类别 4：群里的纠正
 await correction(f.owner,f.employee.id,task.id,runId)

 const runsBefore=Number((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n)
 const log=await f.habits.ensureForDay(f.owner,f.twin,nowIso)
 assert.ok(log)
 assert.equal(log!.kind,'habit-digest');assert.equal(log!.runId,null);assert.deepEqual(log!.scopeIds,[]);assert.equal(log!.state,'kept');assert.equal(log!.day,day);assert.equal(log!.roleId,f.twin.id)
 const saved=(await f.memory.list({ownerId:f.owner,kind:'human'},{roleId:f.twin.id}))[0]!
 assert.ok(saved,'习惯观察应自动保存为分身样本')
 assert.equal(saved.state,'confirmed');assert.equal(saved.visibility.kind,'private')
 assert.equal(saved.content.markdown,log.markdown);assert.equal(saved.source.kind,'habit-digest')
 for(const heading of ['## 放行与拒绝','## 对成果的修订','## 交办文案','## 群里的纠正'])assert.ok(log!.markdown.includes(heading),heading)
 assert.doesNotMatch(log!.markdown,/看起来|似乎|建议你|可能|也许/)
 assert.doesNotMatch(log!.markdown,new RegExp(secret))
 for(const item of log!.evidence)assert.doesNotMatch(item.title,new RegExp(secret))
 assert.match(log!.markdown,/允许 · 类别/)
 assert.ok(log!.markdown.includes(decided.reason))
 assert.match(log!.markdown,/当天新建任务 4 条/)
 assert.match(log!.markdown,/是否每次都写验收标准：否。/)
 assert.match(log!.markdown,/成果 [0-9a-f]{8}：本日新增 1 版/)
 assert.match(log!.markdown,/群回帖 · 话题 /)

 const runsAfter=Number((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1',[f.owner])).rows[0].n)
 assert.equal(runsAfter,runsBefore) // 全程零模型调用：没有新增运行

 const replay=await f.habits.ensureForDay(f.owner,f.twin,nowIso)
 assert.equal(replay,undefined) // 当天已有一条，惰性生成不重复
 const count=Number((await pool.query("select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind='habit-digest'",[f.owner,f.twin.id])).rows[0].n)
 assert.equal(count,1)
 await f.memory.withdraw(f.human,{requestId:randomUUID(),memoryId:saved.id,expectedStateVersion:saved.stateVersion})
 await f.habits.ensureForDay(f.owner,f.twin,nowIso)
 assert.equal((await f.memory.list(f.human,{roleId:f.twin.id}))[0]!.state,'withdrawn','自动观察重试不能恢复本人撤回的样本')
})

test('观察日志已写入但自动保存失败，后台重试会补齐同一份私有样本',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id)
 await approval(f.owner,'补齐来源后放行。')
 let failed=false
 const flaky=new AutoDreamHabitService(pool,identity,{
  writeHabitLog:(...args)=>f.logs.writeHabitLog(...args),
  get:(...args)=>f.logs.get(...args),
  rememberHabit:async log=>{if(!failed){failed=true;throw new WorkError('teloa/dependency-unavailable','暂时无法保存。')}return f.logs.rememberHabit(log)},
 },readAutoDreamSetting)
 await assert.rejects(flaky.ensureForDay(f.owner,f.twin,nowIso),{code:'teloa/dependency-unavailable'})
 assert.equal((await f.logs.list(f.human,{roleId:f.twin.id})).items.length,1)
 assert.equal((await f.memory.list(f.human,{roleId:f.twin.id})).length,0)
 await flaky.ensureForDay(f.owner,f.twin,nowIso)
 const memories=await f.memory.list(f.human,{roleId:f.twin.id})
 assert.equal(memories.length,1);assert.equal(memories[0]!.state,'confirmed')
 await flaky.ensureForDay(f.owner,f.twin,nowIso)
 assert.equal((await f.memory.list(f.human,{roleId:f.twin.id})).length,1)
})

test('开关关着或没有系统计划时不生成；历史仍可读',async()=>{
 const f=await world()
 assert.equal(await f.habits.ensureForDay(f.owner,f.twin,nowIso),undefined) // 零系统计划：设置读不出
 await systemPlan(f.owner,f.employee.id,'paused')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对',goal:'核对来源',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 await approval(f.owner,'关着的开关不应产出观察。')
 assert.equal(await f.habits.ensureForDay(f.owner,f.twin,nowIso),undefined)
 // 历史日志（其它日期）不受影响，仍可读
 const historicalId=randomUUID()
 await pool.query(`insert into teloa_role_daily_logs(id,owner_id,role_id,role_version,kind,day,state,run_id,title,markdown,scope_ids,evidence,prune_hints,request_id,request_spec,created_at,discarded_at)
  values($1,$2,$3,$4,'habit-digest','2026-09-01'::date,'kept',null,'历史观察','## 放行与拒绝\n- 无。','[]'::jsonb,'[]'::jsonb,'[]'::jsonb,$5,'{}'::jsonb,$6,null)`,
  [historicalId,f.owner,f.twin.id,1,randomUUID(),now])
 const got=await f.logs.get(f.human,{roleId:f.twin.id,logId:historicalId})
 assert.equal(got.log.id,historicalId);assert.equal(got.log.state,'kept')
})

test('零证据时不生成也不报错',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 await assert.doesNotReject(async()=>{
  const result=await f.habits.ensureForDay(f.owner,f.twin,nowIso)
  assert.equal(result,undefined)
 })
})

test('自动保存观察后还可手工补充两条，单份观察合计最多三条',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对',goal:'核对来源',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 await approval(f.owner,'放行以便产生观察证据。')
 const log=(await f.habits.ensureForDay(f.owner,f.twin,nowIso))!
 assert.ok(log)
 const promote=(index:number)=>f.memory.create(f.human,{requestId:randomUUID(),roleId:f.twin.id,expectedRoleVersion:1,title:'记下的习惯 '+index,markdown:'记下的习惯正文 '+index,source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}})
 const promoted=[await promote(0),await promote(1)]
 for(const item of promoted){assert.equal(item.state,'candidate');assert.deepEqual(item.visibility,{kind:'private',scopeIds:[]});assert.deepEqual(item.source,{kind:'habit-digest',id:log.id,version:1})}
 await assert.rejects(promote(2),{code:'teloa/conflict',message:'一份观察最多记下 3 条。'})
})

test('丢弃观察日志后未提升条目无法再提升；已提升记忆保留但来源不可核对',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对',goal:'核对来源',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 await approval(f.owner,'放行以便产生观察证据。')
 const log=(await f.habits.ensureForDay(f.owner,f.twin,nowIso))!
 const kept=await f.memory.create(f.human,{requestId:randomUUID(),roleId:f.twin.id,expectedRoleVersion:1,title:'记下的习惯',markdown:'记下的习惯正文。',source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}})
 await f.logs.discard(f.human,{requestId:randomUUID(),logId:log.id,expectedState:'kept'})
 await assert.rejects(f.memory.create(f.human,{requestId:randomUUID(),roleId:f.twin.id,expectedRoleVersion:1,title:'太晚了',markdown:'丢弃后不能再提升。',source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}}),{code:'teloa/version-conflict'})
 const after=(await f.memory.list(f.human,{roleId:f.twin.id})).find(item=>item.id===kept.id)!
 assert.equal(after.state,'candidate');assert.equal(after.sourceAvailable,false);assert.deepEqual(after.content,kept.content)
})

test('分身私有记忆确认满 30 条后，第 31 条（来自习惯观察提升）确认抛 teloa/conflict',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对',goal:'核对来源',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 await approval(f.owner,'放行以便产生观察证据。')
 const log=(await f.habits.ensureForDay(f.owner,f.twin,nowIso))!
 const promoted=await f.memory.create(f.human,{requestId:randomUUID(),roleId:f.twin.id,expectedRoleVersion:1,title:'记下的习惯',markdown:'记下的习惯正文。',source:{kind:'habit-digest',id:log.id,version:1},visibility:{kind:'private',scopeIds:[]}})
 const fillers=[]
 for(let index=0;index<30;index++)fillers.push(await f.memory.create(f.human,{requestId:randomUUID(),roleId:f.twin.id,expectedRoleVersion:1,title:`偏好 ${index}`,markdown:`固定偏好 ${index}`,source:{kind:'self-feedback',id:randomUUID(),version:1},visibility:{kind:'private',scopeIds:[]}}))
 for(const filler of fillers)await f.memory.confirm(f.human,{requestId:randomUUID(),memoryId:filler.id,expectedStateVersion:1})
 await assert.rejects(f.memory.confirm(f.human,{requestId:randomUUID(),memoryId:promoted.id,expectedStateVersion:1}),{code:'teloa/conflict',message:'分身私有记忆最多确认 30 条；请先撤回不再适用的记忆。'})
})

test('并发两次惰性生成当天只落一条日志，均正常返回，没有未翻译的原生异常',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对',goal:'核对来源',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 await approval(f.owner,'放行以便产生观察证据。')
 const settled=await Promise.allSettled([f.habits.ensureForDay(f.owner,f.twin,nowIso),f.habits.ensureForDay(f.owner,f.twin,nowIso)])
 for(const outcome of settled)assert.equal(outcome.status,'fulfilled',outcome.status==='rejected'?String(outcome.reason):undefined)
 const produced=settled.filter(outcome=>outcome.status==='fulfilled'&&outcome.value!==undefined)
 assert.equal(produced.length,1)
 const count=Number((await pool.query("select count(*)::int n from teloa_role_daily_logs where owner_id=$1 and role_id=$2 and kind='habit-digest'",[f.owner,f.twin.id])).rows[0].n)
 assert.equal(count,1)
})

test('超过 60 条修订证据时仍能落库：证据裁到 60 条，正文按字节上限截断并提示',async()=>{
 const f=await world()
 await systemPlan(f.owner,f.employee.id,'active')
 const task=await new TaskService(pool,identity).create(f.owner,{requestId:randomUUID(),fields:{title:'核对',goal:'核对来源',scope:'SOC'},assignee:{roleId:f.employee.id,expectedVersion:f.employeeVersion}})
 const runId=await run(f.owner,task.id,f.employee.id,f.employeeVersion)
 for(let index=0;index<220;index++){
  const artifactId=randomUUID()
  await artifactVersion(f.owner,artifactId,1,{kind:'run',id:runId,scope:'SOC',version:'1',title:'批量报告'},'初版。')
  await artifactVersion(f.owner,artifactId,2,{kind:'session',id:'s-'+index,scope:'SOC',version:'1',title:'批量报告'},'批量修订 '+index+'。',inDayLater)
 }
 const log=(await f.habits.ensureForDay(f.owner,f.twin,nowIso))!
 assert.ok(log)
 assert.equal(log.evidence.length,60)
 assert.ok(Buffer.byteLength(log.markdown,'utf8')<=16000,'正文必须落在 16000 字节以内')
 assert.match(log.markdown,/仅保留前 60 条/)
})
