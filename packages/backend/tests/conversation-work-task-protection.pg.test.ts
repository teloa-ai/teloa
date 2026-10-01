import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {ConversationWorkService,initializeConversationWork,workRequestChildId} from '../src/work/conversation-work.ts'
import {BusinessDataService,initializeBusinessData} from '../src/work/business-data.ts'
import {BusinessTaskService,initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {CollaborationService,initializeCollaboration} from '../src/work/collaboration.ts'
import {GroupTaskService,initializeGroupTasks} from '../src/work/group-tasks.ts'
import {GroupAgentGrantService,initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {groupTaskSourceDigest} from '../src/work/group-task-source-digest.ts'
import {readRunGroupContext} from '../src/work/task-run-group-context.ts'
import type {GroupTaskSource} from '@teloa/contract'
import {IndustryTaskService,initializeIndustryTasks} from '../src/work/industry-tasks.ts'
import {PlanService} from '../src/work/plans.ts'
import {PlanOccurrenceService,initializePlanOccurrences} from '../src/work/plan-occurrences.ts'
import {ObjectConversationService,initializeObjectConversations} from '../src/work/object-conversations.ts'
import {TaskRunService,initializeTaskRuns} from '../src/work/task-runs.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool,observer:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{container=await new PostgreSqlContainer('postgres:17-alpine').start();const connectionString=container.getConnectionUri();pool=new Pool({connectionString,max:1,connectionTimeoutMillis:1500,statement_timeout:4000});locks=new Pool({connectionString,max:2,connectionTimeoutMillis:1500,statement_timeout:4000});observer=new Pool({connectionString,max:2,connectionTimeoutMillis:1500,statement_timeout:4000});await initializeRoles(pool);await initializeTasks(pool);await initializeBusinessData(pool);await initializeBusinessTasks(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool);await initializeGroupTasks(pool);await initializeIndustryTasks(pool);await initializePlanOccurrences(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool)})
after(async()=>{await locks?.end();await observer?.end();await pool?.end();await container?.stop()})
async function fixture(reserve=true){
 await initializeConversationWork(pool)
 const owner=randomUUID(),sessionId='work-'+randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'原执行人',kind:'employee',scopes:['SOC'],duty:'调查',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 const service=new ConversationWorkService(pool,identity.now,async()=>({ownerId:owner,sessionId,status:'ready',submitted:false}),undefined,undefined,locks)
 const request={requestId:randomUUID(),sessionId,messageId:'original',messageSeq:1,kind:'task',scope:'SOC',title:'固定任务',goal:'原交办目标',roleId:role.id,expectedRoleVersion:role.version}
 if(reserve)await service.reserve(owner,request)
 const child=workRequestChildId(request.requestId,'task',role.id),input={requestId:child,fields:{title:request.title,goal:request.goal,scope:'SOC'},assignee:{roleId:role.id,expectedVersion:role.version}},tasks=new TaskService(pool,identity)
 return {owner,sessionId,role,service,request,child,input,tasks,parentIdentity:{sessionId,requestId:request.requestId,roleId:role.id}}
}
async function parentRunFixture(runPool:Pool=pool){
 const f=await fixture(),task=await f.tasks.createForConversation(f.owner,f.parentIdentity),sessionId='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async(owner:string,id:string)=>({ownerId:owner,sessionId:id,id:conversationId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(runPool,identity,inspect),input={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1}
 return {...f,task,runs,input,inspect}
}
/** 已有 Task 的两种固定来源并存夹具；群读取、授权和资源锁仍走生产 reader。 */
async function parentRunGroupFixture(){
 const f=await parentRunFixture(),groups=new CollaborationService(pool,identity),group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'固定来源群',scope:'SOC',announcement:'资料只读',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[f.role.id]}})
 const resource=await groups.saveResource(f.owner,{requestId:randomUUID(),groupId:group.id,resourceId:randomUUID(),expectedVersion:0,title:'固定资料',markdown:'原始证据'})
 const message=await groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'核对固定资料',references:[{kind:'group-resource',id:resource.id,version:1}]})
 const createdAt=identity.now(),source:GroupTaskSource={schema:'teloa.group-task-source/v1',taskId:f.task.id,ownerId:f.owner,groupId:group.id,groupVersion:group.version,messageId:message.id,rootId:message.id,messageCreatedAt:message.createdAt,messageText:message.text,references:message.references,createdAssignee:{roleId:f.role.id,roleVersion:f.role.version},trigger:'manual',createdAt}
 await pool.query('insert into teloa_group_task_sources(task_id,owner_id,request_id,request_spec,group_id,group_version,message_id,root_id,source_snapshot,snapshot_digest,created_at) values($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10)',[f.task.id,f.owner,f.child,JSON.stringify({groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:f.task.goal,assignee:{roleId:f.role.id,expectedVersion:f.role.version}}),group.id,group.version,message.id,JSON.stringify(source),groupTaskSourceDigest(source),createdAt])
 await new GroupAgentGrantService(pool,identity.now).change(f.owner,{requestId:randomUUID(),groupId:group.id,roleId:f.role.id,expectedGroupVersion:group.version,expectedRoleVersion:f.role.version,action:'save',resources:message.references,canPost:false,canAutoRun:false})
 return {...f,group,resource}
}
for(const operation of ['prepare','configuration-failure','claim'] as const)for(const mutation of ['resource-withdraw','grant-revoke'] as const)test('父 '+operation+' 父锁竞争不得释放群资料读锁后提交过期快照：'+mutation,async()=>{
 const f=await parentRunGroupFixture(),runPool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500,statement_timeout:4000})
 let entered!:()=>void,release!:()=>void,hold=false
 const held=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
 const runs=new TaskRunService(runPool,identity,f.inspect,{allowedTools:[],groupContext:async(db,owner,task,role)=>{const context=await readRunGroupContext(db,owner,task,role);if(hold){entered();await gate}return context}})
 const prepared=operation==='claim'?await runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset'):undefined
 hold=true
 const pending=(operation==='claim'?runs.claim(f.owner,{runId:prepared!.id}):runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=>{if(operation==='configuration-failure')throw Error('preset unavailable');return 'fixed-preset'})).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 const holder=await observer.connect(),writer=await observer.connect()
 try{
  await held
  await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',f.owner,'request:'+f.request.requestId])])
  // 资料撤回/授权撤销真实等待前段 reader 的 FOR SHARE。旧两段实现会在等 P 时放锁并继续用旧快照。
  const withdrawing=mutation==='resource-withdraw'?writer.query('update teloa_group_resources set withdrawn_at=now() where owner_id=$1 and id=$2',[f.owner,f.resource.id]):new GroupAgentGrantService(locks,identity.now).change(f.owner,{requestId:randomUUID(),groupId:f.group.id,roleId:f.role.id,expectedGroupVersion:f.group.version,expectedRoleVersion:f.role.version,action:'revoke',resources:[],canPost:false,canAutoRun:false})
  release();await withdrawing
  await holder.query('commit')
  assert.equal((await pending).error?.code,'teloa/conflict','父锁竞争应回滚整个预检事务，不得带已撤回资料写入或发放发送权')
  assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0].n,prepared?1:0)
  if(prepared)assert.equal((await runs.get(f.owner,{runId:prepared.id})).state,'prepared')
 }finally{release();await holder.query('rollback');holder.release();writer.release();await pending;await runPool.end()}
})
test('父停止先落库后，直接 prepare 与 failPreparation 均不得新增 Run',async()=>{
 const f=await parentRunFixture()
 await f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId})
 await assert.rejects(f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset'),{code:'teloa/conflict'})
 await assert.rejects(f.runs.failPreparation(f.owner,{requestId:randomUUID(),taskId:f.task.id,expectedTaskVersion:f.task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:'task-run-'+randomUUID()},new Error('preset unavailable')),{code:'teloa/conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0].n,0)
})
test('prepare 宿主回调期间停止可落库；同事务写闸拒绝迟到 Run',async()=>{
 const runPool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500,statement_timeout:4000}),f=await parentRunFixture(runPool)
 let entered!:()=>void,release!:()=>void
 const held=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve)
 const pending=f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=>{entered();await gate;return 'fixed-preset'})
 try{
  await held
  const stopped=await Promise.race([f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('宿主回调不得持 C/P 或占满停止所需连接')),1200))])
  assert.ok(stopped.stoppedAt)
  release()
  await assert.rejects(pending,{code:'teloa/conflict'})
  assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0].n,0)
 }finally{release();await pending.catch(()=>{});await runPool.end()}
})
test('父 prepared Run 在停止先提交后不得领取发送权',async()=>{
 const f=await parentRunFixture(),prepared=await f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset')
 await f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId})
 await assert.rejects(f.runs.claim(f.owner,{runId:prepared.id}),{code:'teloa/conflict'})
 assert.equal((await f.runs.get(f.owner,{runId:prepared.id})).state,'prepared')
})
test('父 failPreparation 等待 P 时不得先持 R 或 Task 行锁',async()=>{
 const tag='run-parent-lock-'+randomUUID(),runPool=new Pool({connectionString:container.getConnectionUri(),max:1,application_name:tag,connectionTimeoutMillis:1500,statement_timeout:4000}),f=await parentRunFixture(runPool),holder=await observer.connect(),blocker=await observer.connect(),runRequestId=randomUUID()
 const requestLock=JSON.stringify(['task-run-request',f.owner,runRequestId]),parentLock=JSON.stringify(['teloa/conversation-work',f.owner,'request:'+f.request.requestId])
 await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[parentLock])
 await blocker.query('begin');await blocker.query('select id from teloa_tasks where owner_id=$1 and id=$2 for update',[f.owner,f.task.id])
 const pending=f.runs.failPreparation(f.owner,{requestId:runRequestId,taskId:f.task.id,expectedTaskVersion:f.task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId:'task-run-'+randomUUID()},new Error('preset unavailable')).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+1200
  while(!(await locks.query("select 1 from pg_stat_activity where application_name=$1 and wait_event_type='Lock'",[tag])).rowCount){assert.ok(Date.now()<deadline,'父 Run 应等待保护锁');await new Promise(resolve=>setTimeout(resolve,10))}
  assert.equal((await locks.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) as free',[requestLock])).rows[0].free,true,'等待 P 时不得先占 R')
  await holder.query('update teloa_conversation_work_requests set stopped_at=now() where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId]);await holder.query('commit')
  await blocker.query('commit')
  assert.equal((await pending).error?.code,'teloa/conflict')
 }finally{await holder.query('rollback');await blocker.query('rollback');holder.release();blocker.release();await pending;await runPool.end()}
})
for(const operation of ['prepare','claim'] as const)for(const lock of ['C','P'] as const)test('父 '+operation+' 遇 '+lock+' 竞争立即回滚，不持 Run/Task 行锁等待父请求',async()=>{
 const runPool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500,statement_timeout:4000}),f=await parentRunFixture(runPool),prepared=operation==='claim'?await f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset'):undefined,holder=await observer.connect()
 const key=lock==='C'?JSON.stringify(['teloa/conversation-task-child',f.owner,f.child]):JSON.stringify(['teloa/conversation-work',f.owner,'request:'+f.request.requestId])
 await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[key])
 const pending=(prepared?f.runs.claim(f.owner,{runId:prepared.id}):f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset')).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 let timeout:ReturnType<typeof setTimeout>|undefined
 try{
  const result=await Promise.race([pending,new Promise<never>((_,reject)=>timeout=setTimeout(()=>reject(Error('已有预检行锁时不可阻塞等待 C/P')),1200))])
  assert.equal(result.error?.code,'teloa/conflict')
  const checker=await observer.connect()
  try{
   assert.equal((await checker.query('select id from teloa_tasks where owner_id=$1 and id=$2 for update nowait',[f.owner,f.task.id])).rowCount,1,'回滚必须释放 Task 行锁')
   if(prepared)assert.equal((await checker.query('select id from teloa_task_runs where owner_id=$1 and id=$2 for update nowait',[f.owner,prepared.id])).rowCount,1,'回滚必须释放 Run 行锁')
  }finally{checker.release()}
  assert.equal((await pool.query('select count(*)::int n from teloa_task_runs where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows[0].n,prepared?1:0)
  await holder.query('commit')
  // 竞争本身不消费请求或发送权；同一请求在锁释放后可以完成一次。
  const run=prepared??await f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset')
  assert.equal((await f.runs.claim(f.owner,{runId:run.id})).dispatch,true)
  assert.equal((await f.runs.claim(f.owner,{runId:run.id})).dispatch,false)
 }finally{clearTimeout(timeout);await holder.query('rollback');holder.release();await pending;await runPool.end()}
})
test('claim 上下文回调期间停止可落库；回调返回后拒绝领取发送权',async()=>{
 const runPool=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:1500,statement_timeout:4000}),f=await parentRunFixture(runPool),prepared=await f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset')
 let entered!:()=>void,release!:()=>void,timeout:ReturnType<typeof setTimeout>|undefined
 const held=new Promise<void>(resolve=>entered=resolve),gate=new Promise<void>(resolve=>release=resolve),runs=new TaskRunService(runPool,identity,f.inspect,{allowedTools:[],groupContext:async()=>{entered();await gate;return undefined}})
 const pending=runs.claim(f.owner,{runId:prepared.id})
 try{
  await held
  const stopped=await Promise.race([f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),new Promise<never>((_,reject)=>timeout=setTimeout(()=>reject(Error('上下文回调不得持父保护锁阻塞停止')),1200))])
  assert.ok(stopped.stoppedAt);release()
  await assert.rejects(pending,{code:'teloa/conflict'})
  assert.equal((await runs.get(f.owner,{runId:prepared.id})).state,'prepared')
 }finally{clearTimeout(timeout);release();await pending.catch(()=>{});await runPool.end()}
})
test('父 prepare 与 claim 在停止前可沿原路径提交一次',async()=>{
 const f=await parentRunFixture(),prepared=await f.runs.prepare(f.owner,f.input,undefined,undefined,undefined,async()=> 'fixed-preset')
 assert.equal(prepared.state,'prepared')
 const claimed=await f.runs.claim(f.owner,{runId:prepared.id})
 assert.equal(claimed.dispatch,true)
 assert.equal(claimed.run.state,'submitting')
 assert.equal((await f.runs.claim(f.owner,{runId:prepared.id})).dispatch,false)
})
test('Run 归属从固定 Task 子索引推导，普通任务无父交办',async()=>{
 const f=await fixture(),bound=await f.tasks.createForConversation(f.owner,f.parentIdentity),plain=await f.tasks.create(f.owner,{requestId:randomUUID(),fields:{title:'普通任务',goal:'普通目标',scope:'general'}})
 const runs=new TaskRunService(pool,identity,async(owner,sessionId)=>({ownerId:owner,sessionId,id:'conversation',status:'ready'})) as TaskRunService&{conversationParent:(owner:string,input:{taskId:string})=>Promise<unknown>}
 assert.deepEqual(await runs.conversationParent(f.owner,{taskId:bound.id}),f.parentIdentity)
 assert.equal(await runs.conversationParent(f.owner,{taskId:plain.id}),null)
})
test('已持久父 Run 的归属从 Run→Task→确定子索引推导',async()=>{
 const f=await fixture(),task=await f.tasks.createForConversation(f.owner,f.parentIdentity),sessionId='task-run-'+randomUUID(),conversationId=randomUUID(),inspect=async(owner:string,id:string)=>({ownerId:owner,sessionId:id,id:conversationId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(f.owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),run=await runs.prepare(f.owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:f.role.id,expectedRoleVersion:f.role.version,sessionId,expectedLinkVersion:1})
 assert.deepEqual(await runs.conversationParent(f.owner,{runId:run.id}),f.parentIdentity)
})
test('旧独立 Task 存储尚无交办请求表时仍可判为普通任务',async()=>{
 const schema='run_parent_legacy_'+randomUUID().replaceAll('-',''),legacy=new Pool({connectionString:container.getConnectionUri(),options:`-c search_path=${schema}`}),owner=randomUUID(),taskId=randomUUID()
 await pool.query(`create schema "${schema}"`)
 try{
  await legacy.query('create table teloa_tasks(id uuid primary key,owner_id text not null,request_id uuid not null)')
  await legacy.query('insert into teloa_tasks values($1,$2,$3)',[taskId,owner,randomUUID()])
  const runs=new TaskRunService(legacy,identity,async(actor,sessionId)=>({ownerId:actor,sessionId,id:'conversation',status:'ready'}))
  assert.equal(await runs.conversationParent(owner,{taskId}),null)
 }finally{await legacy.end();await pool.query(`drop schema "${schema}" cascade`)}
})
test('旧普通 Run 存储无父表时 prepare、failPreparation 与 claim 保持原路径',async()=>{
 const schema='run_legacy_'+randomUUID().replaceAll('-',''),legacy=new Pool({connectionString:container.getConnectionUri(),max:1,options:`-c search_path=${schema}`}),owner=randomUUID()
 await pool.query(`create schema "${schema}"`)
 try{
  await initializeRoles(legacy);await initializeTasks(legacy);await initializeObjectConversations(legacy);await initializeTaskRuns(legacy)
  const role=await new RoleService(legacy,identity).create(owner,{requestId:randomUUID(),fields:{name:'普通同事',kind:'employee',scopes:['general'],duty:'核对',dataScope:'资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'fixed-preset'}}})
  const task=await new TaskService(legacy,identity).create(owner,{requestId:randomUUID(),fields:{title:'普通任务',goal:'无父请求',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}}),sessionId='legacy-'+randomUUID(),inspect=async(actor:string,id:string)=>({ownerId:actor,sessionId:id,id:'legacy-conversation',status:'ready'})
  await new ObjectConversationService(legacy,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:task.version,sessionId,expectedLinkVersion:0,action:'link'})
  // 只在隔离旧存储夹具撤去后加的父表，验证真实 Run 写入口的兼容性。
  await legacy.query('drop table teloa_conversation_work_requests')
  const runs=new TaskRunService(legacy,identity,inspect),input={requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1}
  const failed=await runs.failPreparation(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:task.version,roleId:role.id,expectedRoleVersion:role.version,sessionId:'unavailable-'+randomUUID()},Error('preset unavailable'),'fixed-preset')
  assert.equal(failed.state,'configuration_failed')
  const run=await runs.prepare(owner,input)
  assert.equal(run.state,'prepared');assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,true);assert.equal((await runs.claim(owner,{runId:run.id})).dispatch,false)
  assert.equal(legacy.waitingCount,0)
 }finally{await legacy.end();await pool.query(`drop schema "${schema}" cascade`)}
})
test('独立 initializeTasks 后普通任务可创建，max1 无需先初始化会话服务',async()=>{
 const task=await new TaskService(pool,identity).create(randomUUID(),{requestId:randomUUID(),fields:{title:'普通任务',goal:'未绑定交办',scope:'general'}})
 assert.equal(task.state,'ready');assert.equal(pool.waitingCount,0)
})
test('已reserve但尚无Task，停止后迟到旧create拒绝；既存任务回执仍可核对',async()=>{
 const f=await fixture();assert.equal(await f.tasks.requestForConversation(f.owner,f.parentIdentity),null)
 await f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId})
 await assert.rejects(f.tasks.createForConversation(f.owner,f.parentIdentity),{code:'teloa/conflict'})
 assert.equal(await f.tasks.requestForConversation(f.owner,f.parentIdentity),null)
 const active=await fixture(),saved=await active.tasks.createForConversation(active.owner,active.parentIdentity)
 await active.service.stop(active.owner,{sessionId:active.sessionId,requestId:active.request.requestId})
 assert.deepEqual(await active.tasks.createForConversation(active.owner,active.parentIdentity),saved)
 assert.equal(pool.waitingCount,0)
})
test('旧kind=task索引回填沿唯一helper，重跑稳定；损坏索引和唯一碰撞均拒绝启动',async()=>{
 const f=await fixture()
 await pool.query('alter table teloa_conversation_work_requests drop column task_child_request_id cascade')
 await initializeConversationWork(pool)
 assert.equal((await pool.query('select task_child_request_id from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId])).rows[0].task_child_request_id,f.child)
 await initializeTasks(pool)
 assert.equal((await pool.query('select task_child_request_id from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId])).rows[0].task_child_request_id,f.child)
 const other=randomUUID();await pool.query('update teloa_conversation_work_requests set task_child_request_id=$3 where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId,other])
 try{await assert.rejects(initializeConversationWork(pool),{code:'teloa/storage-corrupt'})}finally{await pool.query('update teloa_conversation_work_requests set task_child_request_id=$3 where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId,f.child])}
 const copy={...f.request,requestId:randomUUID()}
 await assert.rejects(pool.query('insert into teloa_conversation_work_requests(owner_id,request_id,session_id,request_spec,targets,created_at,task_child_request_id) select owner_id,$3,session_id,$4,targets,created_at,task_child_request_id from teloa_conversation_work_requests where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId,copy.requestId,JSON.stringify(copy)]),{code:'23505'})
})
test('真实父请求事务锁阻止旧Task穿透；关闭先提交则零Task，max1释放连接',async()=>{
 const f=await fixture(),holder=await observer.connect()
 const key=JSON.stringify(['teloa/conversation-work',f.owner,'request:'+f.request.requestId])
 await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[key])
 const pending=f.tasks.createForConversation(f.owner,f.parentIdentity).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select pg_advisory_xact_lock%'" )).rowCount){assert.ok(Date.now()<deadline,'旧 create 必须等待同一父请求保护锁');await new Promise(r=>setTimeout(r,10))}
  await holder.query('update teloa_conversation_work_requests set stopped_at=now() where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId]);await holder.query('commit')
  assert.equal((await pending).error?.code,'teloa/conflict');assert.equal(await f.tasks.requestForConversation(f.owner,f.parentIdentity),null)
 }finally{await holder.query('rollback');holder.release();await pending}
 assert.equal(pool.waitingCount,0);assert.equal(pool.idleCount,1)
})

test('BusinessTask 外层先父锁再 task-create，停止后零 Task/source 且保留原对象',async()=>{
 const f=await fixture(),snapshot={scope:'SOC',type:'alert',id:'source',version:1,title:'原对象',source:'test',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'',fields:[]}
 const page=await new BusinessDataService(pool,{id:'test',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'test',scope:'SOC',capturedAt:identity.now(),items:[snapshot]})}).query({ownerId:f.owner,scopeIds:['SOC']},{scope:'SOC',limit:10})
 const fixed=page.items[0]!,reference={scope:fixed.scope,type:fixed.type,id:fixed.id,version:fixed.version,snapshotHash:fixed.snapshotHash},service=new BusinessTaskService(pool,identity,f.tasks),holder=await observer.connect()
 await holder.query('begin');await holder.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/conversation-work',f.owner,'request:'+f.request.requestId])])
 const pending=service.create({ownerId:f.owner,scopeIds:['SOC']},{requestId:f.child,assignee:f.input.assignee,title:'固定任务',goal:'原交办目标',reference}).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select pg_advisory_xact_lock%'" )).rowCount){assert.ok(Date.now()<deadline,'BusinessTask 必须先等待父请求锁');await new Promise(r=>setTimeout(r,10))}
  const checker=await observer.connect()
  try{await checker.query('begin');assert.equal((await checker.query('select pg_try_advisory_xact_lock(hashtextextended($1,0)) as free',[JSON.stringify(['teloa/task-create',f.owner,f.child])])).rows[0].free,true,'等待父请求时不得先占 task-create');await checker.query('rollback')}finally{checker.release()}
  await holder.query('update teloa_conversation_work_requests set stopped_at=now() where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId]);await holder.query('commit')
  assert.equal((await pending).error?.code,'teloa/conflict')
  assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
  assert.equal((await pool.query('select count(*)::int n from teloa_business_task_sources where owner_id=$1',[f.owner])).rows[0].n,0)
 }finally{await holder.query('rollback');holder.release();await pending}
})

test('创建先提交则 stop 等同一保护锁，之后只可重放原 Task；主池 max1',async()=>{
 const f=await fixture(),creator=await observer.connect()
 await creator.query('begin');const task=await f.tasks.createForConversationInTransaction(creator,f.owner,f.parentIdentity)
 const stopping=f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId})
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like 'select pg_advisory_xact_lock%'" )).rowCount){assert.ok(Date.now()<deadline,'stop 必须等待未提交的 create 父锁');await new Promise(r=>setTimeout(r,10))}
  await creator.query('commit');assert.ok((await stopping).stoppedAt)
  assert.deepEqual(await f.tasks.createForConversation(f.owner,f.parentIdentity),task)
 }finally{await creator.query('rollback');creator.release();await stopping}
 assert.equal(pool.waitingCount,0)
})

test('稳定schema重复初始化只读核验，不等待另一事务的请求行写入',async()=>{
 const f=await fixture(),writer=await observer.connect()
 await writer.query('begin');await writer.query('update teloa_conversation_work_requests set notified_at=now() where owner_id=$1 and request_id=$2',[f.owner,f.request.requestId])
 try{await initializeConversationWork(pool);await initializeTasks(pool)}finally{await writer.query('rollback');writer.release()}
 assert.equal(pool.waitingCount,0)
})

for(const entry of ['group','industry','plan'] as const)test('R1 '+entry+' 与普通 Task 同子请求竞争必须 parent-first，无死锁或超时',async()=>{
 const f=await fixture()
 let create:()=>Promise<unknown>
 if(entry==='group'){
  const groups=new CollaborationService(pool,identity),group=await groups.create(f.owner,{requestId:randomUUID(),expectedVersion:0,fields:{name:'并发测试群',scope:'SOC',announcement:'固定来源',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},memberRoleIds:[]}})
  const message=await groups.send(f.owner,{requestId:randomUUID(),groupId:group.id,expectedVersion:group.version,text:'原群消息',references:[]})
  const service=new GroupTaskService(pool,identity,f.tasks)
  create=()=>service.create(f.owner,{requestId:f.child.toUpperCase(),groupId:group.id,messageId:message.id,expectedGroupVersion:group.version,goal:'群目标'})
 }else if(entry==='industry'){
  const snapshot={loadId:randomUUID(),itemInstanceId:randomUUID(),itemLocalId:'work',contentId:randomUUID(),contentHash:'a'.repeat(64),templateId:'work',templateVersion:'1.0.0',fileHash:'b'.repeat(64),title:'行业任务',method:'核对',requirements:['资料'],output:'结果',skills:[],scope:'SOC'}
  // 来源读取为有界夹具；真正竞争的是两个公开 Service + TaskService 的 PG 事务和锁。
  const service=new IndustryTaskService(pool,identity,{read:async()=>snapshot,assertModelsReady:async()=>{}},f.tasks)
  create=()=>service.create(f.owner,{requestId:f.child.toUpperCase(),loadId:snapshot.loadId,itemInstanceId:snapshot.itemInstanceId,goal:'行业目标',inputs:['资料']})
 }else{
  const plans=new PlanService(pool,identity),created=await plans.create(f.owner,{requestId:randomUUID(),fields:{title:'计划任务',goal:'计划目标',scope:'SOC',dataScope:'资料',delivery:'结果',roleId:f.role.id,expectedRoleVersion:f.role.version,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'attention'},source:{kind:'manual'}})
  const plan=await plans.change(f.owner,{planId:created.id,requestId:randomUUID(),expectedVersion:created.version,action:'enable'}),service=new PlanOccurrenceService(pool,identity)
  const {occurrence}=await service.trigger(f.owner,{planId:plan.id,requestId:f.child,expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:identity.now()})
  create=()=>service.dispatchTask(f.owner,{claimId:occurrence.id,taskRequestId:f.child,now:identity.now()})
 }
 let release!:()=>void,entered!:(pid:number)=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<number>(resolve=>{entered=resolve}),taskKey=JSON.stringify(['teloa/task-create',f.owner,f.child])
 const normalPool={connect:async()=>{
  const db=await locks.connect(),pid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid
  return {query:async(sql:string,values?:unknown[])=>{if(sql.startsWith('select pg_advisory_xact_lock')&&values?.[0]===taskKey){entered(pid);await gate}return db.query(sql,values)},release:()=>db.release()}
 }} as unknown as Pool
 const normal=new TaskService(normalPool,identity).createForConversation(f.owner,f.parentIdentity).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 const pid=await held,other=create().then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query('select 1 from pg_stat_activity where datname=current_database() and $1::int=any(pg_blocking_pids(pid))',[pid])).rowCount){assert.ok(Date.now()<deadline,'另一路必须在真实 PG 共同保护锁等待');await new Promise(r=>setTimeout(r,10))}
  release()
  const [a,b]=await Promise.all([normal,other])
  assert.equal(a.error,undefined,'普通 Task 已持父锁，不能被反序入口形成死锁')
  assert.equal(b.error?.code,'teloa/conflict','后到入口必须核对已有任务身份，不得死锁或另建')
  assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
  assert.equal(pool.waitingCount,0)
 }finally{release();await Promise.all([normal,other])}
})

for(const rollback of [false,true])test('R2 独立Task先持子键，'+(rollback?'回滚后reserve可建立父':'提交后reserve不得绑定已有任务'),async()=>{
 const f=await fixture(false)
 let release!:()=>void,entered!:(pid:number)=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<number>(resolve=>{entered=resolve})
 const taskPool={connect:async()=>{const db=await locks.connect(),pid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid;return {query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql.startsWith('insert into teloa_tasks')){entered(pid);await gate;if(rollback)throw Error('controlled rollback before commit')}return result},release:()=>db.release()}}} as unknown as Pool
 const task=new TaskService(taskPool,identity).create(f.owner,f.input).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 const pid=await held,reserve=f.service.reserve(f.owner,f.request).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query('select 1 from pg_stat_activity where datname=current_database() and $1::int=any(pg_blocking_pids(pid))',[pid])).rowCount){assert.ok(Date.now()<deadline,'reserve 必须等待未提交创建');await new Promise(r=>setTimeout(r,10))}
  release();const [a,b]=await Promise.all([task,reserve])
  if(rollback){assert.equal(a.error?.message,'controlled rollback before commit');assert.equal(b.error,undefined);assert.equal((await observer.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)}
  else{assert.equal(a.error,undefined);assert.equal(b.error?.code,'teloa/conflict');assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),null);assert.equal((await f.tasks.request(f.owner,{requestId:f.child}))?.id,a.value?.id)}
 }finally{release();await Promise.all([task,reserve])}
})

for(const rollback of [false,true])test('R2 reserve未提交索引不可见，Task必须等子键后重读父'+(rollback?'，父回滚':'，父提交'),async()=>{
 const f=await fixture(false)
 let release!:()=>void,entered!:(pid:number)=>void,paused=false
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<number>(resolve=>{entered=resolve})
 const reserving=new ConversationWorkService(pool,identity.now,async()=>({ownerId:f.owner,sessionId:f.sessionId,status:'ready',submitted:false}),async()=>async db=>{if(!paused){paused=true;entered((await db.query('select pg_backend_pid() as pid')).rows[0].pid);await gate;if(rollback)throw Error('controlled reserve rollback')}},undefined,locks)
 const reserve=reserving.reserve(f.owner,f.request).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 const pid=await held,task=new TaskService(locks,identity).create(f.owner,f.input).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query('select 1 from pg_stat_activity where datname=current_database() and $1::int=any(pg_blocking_pids(pid))',[pid])).rowCount){assert.ok(Date.now()<deadline,'索引不可见也必须等待reserve的共同子锁');await new Promise(r=>setTimeout(r,10))}
  assert.equal((await observer.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
  release();const [a,b]=await Promise.all([reserve,task])
  if(rollback){assert.equal(b.error,undefined);assert.equal(a.error?.message,'controlled reserve rollback');assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),null)}
  else{assert.equal(b.error?.code,'teloa/conflict','父提交后普通入口也不能冒用');assert.equal(a.error,undefined);assert.equal(a.value?.requestId,f.request.requestId);await f.tasks.createForConversation(f.owner,f.parentIdentity);assert.deepEqual(await f.service.reserve(f.owner,f.request),a.value,'Task 已存在时原父预约回执仍优先返回')}
 }finally{release();await Promise.all([reserve,task])}
})

for(const business of [false,true])test('R3 UUID '+(business?'BusinessTask':'普通Task')+' 大写child先提交，reserve不得因锁键大小写差异收养独立任务',async()=>{
 const f=await fixture(false)
 let release!:()=>void,entered!:(pid:number)=>void
 const gate=new Promise<void>(resolve=>{release=resolve}),held=new Promise<number>(resolve=>{entered=resolve})
 const taskPool={connect:async()=>{const db=await locks.connect(),pid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid;return {query:async(sql:string,values?:unknown[])=>{const result=await db.query(sql,values);if(sql.startsWith('insert into teloa_tasks')){entered(pid);await gate}return result},release:()=>db.release()}}} as unknown as Pool
 const tasks=new TaskService(taskPool,identity)
 let create:()=>Promise<unknown>
 if(business){
  const snapshot={scope:'SOC',type:'alert',id:'source',version:1,title:'原对象',source:'test',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'',fields:[]},page=await new BusinessDataService(pool,{id:'test',scopes:['SOC'],query:async()=>({schema:'teloa.data-source-page/v1',sourceId:'test',scope:'SOC',capturedAt:identity.now(),items:[snapshot]})}).query({ownerId:f.owner,scopeIds:['SOC']},{scope:'SOC',limit:10}),fixed=page.items[0]!,service=new BusinessTaskService(taskPool,identity,tasks)
  create=()=>service.create({ownerId:f.owner,scopeIds:['SOC']},{requestId:f.child.toUpperCase(),assignee:f.input.assignee,title:f.input.fields.title,goal:f.input.fields.goal,reference:{scope:fixed.scope,type:fixed.type,id:fixed.id,version:fixed.version,snapshotHash:fixed.snapshotHash}})
 }else create=()=>tasks.create(f.owner,{...f.input,requestId:f.child.toUpperCase()})
 const task=create().then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 const pid=await held,reserve=f.service.reserve(f.owner,f.request).then(value=>({value,error:undefined}),error=>({value:undefined,error}))
 try{
  const deadline=Date.now()+3000
  while(!(await observer.query('select 1 from pg_stat_activity where datname=current_database() and $1::int=any(pg_blocking_pids(pid))',[pid])).rowCount){assert.ok(Date.now()<deadline,'reserve必须等待已持锁的创建事务');await new Promise(r=>setTimeout(r,10))}
  release();const [a,b]=await Promise.all([task,reserve]);assert.equal(a.error,undefined);assert.equal(b.error?.code,'teloa/conflict','大小写不改变同一UUID归属，不能收养独立Task')
  assert.equal(await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.request.requestId}),null)
  const lower=await f.tasks.request(f.owner,{requestId:f.child}),upper=await f.tasks.request(f.owner,{requestId:f.child.toUpperCase()})
  assert.deepEqual(upper,lower);assert.ok(lower)
  if(!business){
   const prior=(await observer.query('select request_spec from teloa_tasks where id=$1',[lower.id])).rows[0].request_spec
   assert.equal(Object.hasOwn(prior,'requestId'),false,'普通 Task 历史指纹不含 requestId')
   assert.deepEqual(await f.tasks.create(f.owner,f.input),lower)
   assert.deepEqual(await f.tasks.create(f.owner,{...f.input,requestId:f.child.toUpperCase()}),lower)
   assert.deepEqual((await observer.query('select request_spec from teloa_tasks where id=$1',[lower.id])).rows[0].request_spec,prior,'大小写重试不改历史指纹')
  }
  assert.equal((await observer.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,1)
 }finally{release();await Promise.all([task,reserve])}
})

test('R3 UUID 父已提交时大写child普通request明确拒绝，不误报索引损坏',async()=>{
 const f=await fixture();await f.tasks.createForConversation(f.owner,f.parentIdentity)
 await assert.rejects(f.tasks.request(f.owner,{requestId:f.child.toUpperCase()}),{code:'teloa/conflict'})
})
