import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {workAccess,type WorkAccessRequest} from '../src/work/work-access.ts'
import {initializeMarketContents} from '../src/market/content-store.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {initializeConversationWork,ConversationWorkService} from '../src/work/conversation-work.ts'
import {initializePlans,PlanService} from '../src/work/plans.ts'
import {initializePlanOccurrences,PlanOccurrenceService} from '../src/work/plan-occurrences.ts'
import {initializeBusinessSpaces,BusinessSpaceService} from '../src/work/business-spaces.ts'
import {initializeBusinessConversationBindings,BusinessConversationBindingService} from '../src/work/business-conversation-bindings.ts'
import {initializeBusinessReassignments,BusinessReassignmentService} from '../src/work/business-reassignment.ts'
import type {Conversation,BusinessReassignmentInstruction} from '@teloa/contract'
import {testRoleResponsibility} from './role-test-fixture.ts'

let container:StartedPostgreSqlContainer,pool:Pool,locks:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
type State={allowed:boolean;epoch:number;now:number;expires:number;requests:Readonly<WorkAccessRequest>[]}
const states=new Map<string,State>()
function state(owner:string){let value=states.get(owner);if(!value){value={allowed:true,epoch:1,now:100,expires:200,requests:[]};states.set(owner,value)}return value}
before(async()=>{
 workAccess.requirePolicy();workAccess.installPolicy(async request=>{
  if(request.kind==='native-input')throw Error('此业务事务夹具不接收原生输入。')
  const current=state(request.ownerId),epoch=current.epoch
  current.requests.push(request)
  await Promise.resolve()
  return {assertCurrent:()=>{if(!current.allowed||current.epoch!==epoch||current.now>=current.expires)throw Error('test admission denied')}}
 })
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73').start()
 pool=new Pool({connectionString:container.getConnectionUri(),max:5,connectionTimeoutMillis:3000,statement_timeout:5000})
 locks=new Pool({connectionString:container.getConnectionUri(),max:2,connectionTimeoutMillis:3000,statement_timeout:5000})
 await initializeMarketContents(pool);await initializeRoles(pool);await initializeCollaboration(pool);await initializeGroupAgentGrants(pool)
 await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeConversationWork(pool)
 await initializePlans(pool);await initializePlanOccurrences(pool)
 await initializeBusinessSpaces(pool);await initializeBusinessConversationBindings(pool);await initializeBusinessReassignments(pool)
},{timeout:120000})
after(async()=>{await locks?.end();await pool?.end();await container?.stop()})
/** 屏障只延迟本用例的真实PG query回包，SQL已在原事务执行；随后必须实际rollback。 */
function afterQuery(real:Pool,match:(sql:string)=>boolean,change:()=>void):Pool{
 let consumed=false
 return new Proxy(real,{get(target,key){
  if(key==='connect')return async()=>{
   const db=await target.connect()
   return new Proxy(db,{get(client,property){
    if(property==='query')return async(sql:string,values?:unknown[])=>{
     const result=await db.query(sql,values)
     if(!consumed&&match(sql)){consumed=true;await new Promise<void>(resolve=>setImmediate(resolve));change()}
     return result
    }
    const value=Reflect.get(client,property);return typeof value==='function'?value.bind(client):value
   }})
  }
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value
 }})
}
async function activeRole(owner:string,scope='general'){
 const role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对员工',kind:'employee',scopes:[scope],duty:'核对',dataScope:'本人资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'fixed-reviewer'}}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id]);return role
}
async function runFixture(){
 const owner=randomUUID(),role=await activeRole(owner),task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'准入任务',goal:'核对资料',scope:'general'},assignee:{roleId:role.id,expectedVersion:role.version}})
 const sessionId='run-'+randomUUID(),id=randomUUID(),inspect=async()=>({id,ownerId:owner,sessionId,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const service=new TaskRunService(pool,identity,inspect),run=await service.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:role.version,sessionId,expectedLinkVersion:1})
 return {owner,task,run,service,inspect}
}
async function runState(taskId:string,runId:string){return (await pool.query('select t.state task_state,t.version task_version,r.state run_state from teloa_tasks t join teloa_task_runs r on r.task_id=t.id where t.id=$1 and r.id=$2',[taskId,runId])).rows[0]}
async function conversationFixture(){
 const owner=randomUUID(),role=await activeRole(owner),sessionId='work-'+randomUUID(),inspect=async(actor:string,id:string)=>({ownerId:actor,sessionId:id,status:'ready',submitted:false})
 const service=new ConversationWorkService(pool,identity.now,inspect,undefined,undefined,locks)
 await service.setContext(owner,{requestId:randomUUID(),sessionId,scopeId:'general',roleId:role.id,expectedVersion:0})
 const input={requestId:randomUUID(),sessionId,messageId:randomUUID(),messageSeq:1,kind:'task' as const,scope:'general',title:'准入交办',goal:'核对资料',roleId:role.id,expectedRoleVersion:role.version}
 return {owner,role,sessionId,service,input,inspect}
}
async function workRows(owner:string){return (await pool.query('select (select count(*)::int from teloa_conversation_work_requests where owner_id=$1) requests,(select bool_or(locked) from teloa_conversation_work_contexts where owner_id=$1) locked',[owner])).rows[0]}
const schedule={kind:'schedule' as const,cadence:'daily' as const,weekday:1,time:'09:00',timezone:'Asia/Singapore' as const}
async function planFixture(){
 const owner=randomUUID(),role=await activeRole(owner),clock={id:randomUUID,now:()=>'2026-09-11T00:00:00.000Z'},plans=new PlanService(pool,clock)
 const created=await plans.create(owner,{requestId:randomUUID(),fields:{title:'准入计划',goal:'核对资料',scope:'general',dataScope:'本人资料',delivery:'核对结果',roleId:role.id,expectedRoleVersion:role.version,trigger:schedule,notificationPolicy:'attention'},source:{kind:'manual'}})
 const plan=await plans.change(owner,{planId:created.id,requestId:randomUUID(),expectedVersion:1,action:'enable'}),service=new PlanOccurrenceService(pool,{id:randomUUID})
 const input={planId:plan.id,requestId:randomUUID(),expectedVersion:plan.version,expectedConfigVersion:plan.configVersion,now:'2026-09-11T00:30:00.000Z'}
 return {owner,role,plan,service,input}
}
async function planRows(owner:string){return (await pool.query('select (select jsonb_agg(to_jsonb(o) order by id) from teloa_plan_occurrences o where owner_id=$1) occurrences,(select jsonb_agg(to_jsonb(s) order by plan_id) from teloa_plan_schedule_state s where owner_id=$1) state',[owner])).rows[0]}

test('TaskRun 首次prepared拒绝零持久变更，可信能力request固定真实员工与会话',async()=>{
 const f=await runFixture(),before=await runState(f.task.id,f.run.id),current=state(f.owner),calls=current.requests.length
 current.allowed=false
 await assert.rejects(f.service.claim(f.owner,{runId:f.run.id}),{code:'teloa/forbidden'})
 assert.deepEqual(await runState(f.task.id,f.run.id),before)
 assert.deepEqual(current.requests.slice(calls),[{kind:'capability',capability:'people',ownerId:f.owner,sessionId:f.run.sessionId,objectId:f.run.roleId,operation:'run'}])
})
test('TaskRun许可到期仍可返回旧accepted回执、读取、停止意图和对账',async()=>{
 const f=await runFixture(),claimed=await f.service.claim(f.owner,{runId:f.run.id})
 assert.equal(claimed.dispatch,true)
 await f.service.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})
 const current=state(f.owner),calls=current.requests.length;current.now=current.expires
 assert.equal((await f.service.claim(f.owner,{runId:f.run.id})).dispatch,false)
 assert.equal((await f.service.get(f.owner,{runId:f.run.id})).state,'accepted')
 assert.ok((await f.service.requestStop(f.owner,{runId:f.run.id})).stopRequestedAt)
 assert.equal((await f.service.record(f.owner,{runId:f.run.id,sessionId:f.run.sessionId,nativeRequestId:f.run.nativeRequestId,evidence:{state:'accepted'}})).state,'accepted')
 assert.equal(current.requests.length,calls)
})
test('TaskRun真实PG末次写回包延迟跨到期，Task和Run全部回滚',async()=>{
 const f=await runFixture(),before=await runState(f.task.id,f.run.id),current=state(f.owner)
 const delayed=afterQuery(pool,sql=>sql.startsWith("update teloa_task_runs set state='submitting'"),()=>{current.now=current.expires})
 await assert.rejects(new TaskRunService(delayed,identity,f.inspect).claim(f.owner,{runId:f.run.id}),{code:'teloa/forbidden'})
 assert.deepEqual(await runState(f.task.id,f.run.id),before)
})
test('会话新reserve拒绝不落请求、不锁context；旧同spec/read/stop保留',async()=>{
 const f=await conversationFixture(),before=await workRows(f.owner),current=state(f.owner)
 current.allowed=false
 await assert.rejects(f.service.reserve(f.owner,f.input),{code:'teloa/forbidden'})
 assert.deepEqual(await workRows(f.owner),before)
 current.allowed=true;const saved=await f.service.reserve(f.owner,f.input),calls=current.requests.length
 current.allowed=false
 assert.deepEqual(await f.service.reserve(f.owner,f.input),saved)
 assert.equal((await f.service.get(f.owner,{sessionId:f.sessionId,requestId:f.input.requestId}))?.requestId,f.input.requestId)
 assert.ok((await f.service.stop(f.owner,{sessionId:f.sessionId,requestId:f.input.requestId})).stoppedAt)
 await assert.rejects(f.service.reserve(f.owner,{...f.input,goal:'更换旧指令'}),{code:'teloa/conflict'})
 assert.equal(current.requests.length,calls)
})
test('会话真实context写回包延迟期间切身份epoch，首请求和context全部回滚',async()=>{
 const f=await conversationFixture(),before=await workRows(f.owner),current=state(f.owner)
 const delayed=afterQuery(pool,sql=>sql.startsWith('update teloa_conversation_work_contexts set locked=true'),()=>{current.epoch++})
 await assert.rejects(new ConversationWorkService(delayed,identity.now,f.inspect).reserve(f.owner,f.input),{code:'teloa/forbidden'})
 assert.deepEqual(await workRows(f.owner),before)
})
test('Plan manual新occurrence拒绝零写，准许后到期旧回执仍返回',async()=>{
 const f=await planFixture(),before=await planRows(f.owner),current=state(f.owner)
 current.allowed=false
 await assert.rejects(f.service.trigger(f.owner,f.input),{code:'teloa/forbidden'})
 assert.deepEqual(await planRows(f.owner),before)
 current.allowed=true;const accepted=await f.service.trigger(f.owner,f.input),calls=current.requests.length
 current.now=current.expires
 assert.deepEqual(await f.service.trigger(f.owner,f.input),{occurrence:accepted.occurrence,dispatch:false})
 assert.deepEqual(await f.service.list(f.owner,{planId:f.plan.id}),[accepted.occurrence])
 assert.equal(current.requests.length,calls)
})
test('Plan manual真实insert回包延迟跨到期，occurrence全部回滚',async()=>{
 const f=await planFixture(),before=await planRows(f.owner),current=state(f.owner)
 const delayed=afterQuery(pool,sql=>sql.startsWith('insert into teloa_plan_occurrences'),()=>{current.now=current.expires})
 await assert.rejects(new PlanOccurrenceService(delayed,{id:randomUUID}).trigger(f.owner,f.input),{code:'teloa/forbidden'})
 assert.deepEqual(await planRows(f.owner),before)
})
test('Plan schedule拒绝时既有游标保持；空游标首次save也整体回滚',async()=>{
 for(const existing of [false,true]){
  const f=await planFixture(),current=state(f.owner)
  if(existing)await f.service.recover(f.owner,{planId:f.plan.id,now:'2026-09-11T00:30:00.000Z'})
  const before=await planRows(f.owner);current.allowed=false
  await assert.rejects(f.service.claim(f.owner,{planId:f.plan.id,now:'2026-09-11T01:00:00.000Z'}),{code:'teloa/forbidden'})
  assert.deepEqual(await planRows(f.owner),before)
 }
})
test('Plan schedule真实游标写回包延迟跨到期，occurrence/游标回滚后可再次准入',async()=>{
 const f=await planFixture(),current=state(f.owner)
 await f.service.recover(f.owner,{planId:f.plan.id,now:'2026-09-11T00:30:00.000Z'})
 const before=await planRows(f.owner),input={planId:f.plan.id,now:'2026-09-11T01:00:00.000Z'}
 const delayed=afterQuery(pool,sql=>sql.startsWith('update teloa_plan_schedule_state set plan_version='),()=>{current.now=current.expires})
 await assert.rejects(new PlanOccurrenceService(delayed,{id:randomUUID}).claim(f.owner,input),{code:'teloa/forbidden'})
 assert.deepEqual(await planRows(f.owner),before)
 current.now=100
 assert.equal((await f.service.claim(f.owner,input)).dispatch,true)
})
test('并发schedule只有真实新领取申请一次准入；旧游标查询不重新准入',async()=>{
 const f=await planFixture(),current=state(f.owner),input={planId:f.plan.id,now:'2026-09-11T01:00:00.000Z'}
 await f.service.recover(f.owner,{planId:f.plan.id,now:'2026-09-11T00:30:00.000Z'})
 const calls=current.requests.length
 const results=await Promise.all(Array.from({length:6},()=>f.service.claim(f.owner,input)))
 assert.equal(results.filter(row=>row.dispatch).length,1);assert.equal(current.requests.length,calls+2)
 assert.deepEqual(current.requests.slice(calls).map(row=>row.kind),['capability','plan-occurrence'])
 current.allowed=false;assert.equal((await f.service.claim(f.owner,input)).dispatch,false);assert.equal(current.requests.length,calls+2)
})

async function reassignmentFixture(){
 const owner=randomUUID();await new BusinessSpaceService(pool,identity).ensurePersonal(owner)
 const oldRole=await activeRole(owner,'SOC'),newRole=await activeRole(owner,'SOC'),sessions=new Map<string,Conversation>()
 const inspect=async(actor:string,id:string)=>{const row=sessions.get(id);assert.equal(row?.ownerId,actor);return {...row!,status:'ready',submitted:true}}
 const work=new ConversationWorkService(pool,identity.now,inspect,undefined,async()=>['SOC'],locks)
 const bindings=new BusinessConversationBindingService(pool,identity,{drafts:{begin:async()=>{throw Error('no draft')},get:async()=>{throw Error('no draft')}},conversations:{bySession:async(actor,id)=>{const row=sessions.get(id);assert.equal(row?.ownerId,actor);return {...row!,status:'ready' as const}}},contexts:work})
 const daily=async()=>{
  const id='daily-'+randomUUID(),requestId=randomUUID(),now=identity.now()
  sessions.set(id,{id:randomUUID(),ownerId:owner,title:'日常工作',scopeIds:['general'],version:1,status:'ready',sessionId:id,requestedSessionId:id,requestId,createdAt:now})
  await pool.query('insert into teloa_conversation_work_contexts values($1,$2,$3,null,1,true)',[owner,id,'SOC'])
  await pool.query("insert into teloa_business_conversation_bindings(owner_id,request_id,kind,title,scope_id,session_id,created_at,updated_at) values($1,$2,'daily',$3,$6,$4,$5,$5)",[owner,requestId,'日常工作',id,now,'SOC'])
  return id
 }
 const oldSessionId=await daily(),newSessionId=await daily(),oldRequestId=randomUUID()
 await work.reserve(owner,{requestId:oldRequestId,sessionId:oldSessionId,messageId:'original',messageSeq:1,kind:'task',scope:'SOC',title:'原交办',goal:'保留目标',roleId:oldRole.id,expectedRoleVersion:oldRole.version})
 const instruction:BusinessReassignmentInstruction={requestId:randomUUID(),sessionId:newSessionId,messageId:randomUUID(),messageSeq:2,sourceText:'本人明确改派',selection:{oldRequestId,newRoleId:newRole.id,expectedNewRoleVersion:newRole.version}},input={oldRequestId,instruction}
 const service=new BusinessReassignmentService(pool,identity.now,work,bindings),snapshot=await service.prepare(owner,input,async()=>{})
 await work.stop(owner,{sessionId:oldSessionId,requestId:oldRequestId})
 return {owner,work,bindings,service,input,snapshot}
}
test('改派共享reserve后的末次successor写跨到期，外层最终commit闸回滚两类记录',async()=>{
 const f=await reassignmentFixture(),current=state(f.owner)
 const before=(await pool.query('select (select count(*)::int from teloa_conversation_work_requests where owner_id=$1) requests,(select count(*)::int from teloa_conversation_work_successors where owner_id=$1) successors',[f.owner])).rows[0]
 const delayed=afterQuery(pool,sql=>sql.startsWith('insert into teloa_conversation_work_successors'),()=>{current.now=current.expires})
 await assert.rejects(new BusinessReassignmentService(delayed,identity.now,f.work,f.bindings).commit(f.owner,f.input,f.snapshot,async()=>{}),{code:'teloa/forbidden'})
 assert.deepEqual((await pool.query('select (select count(*)::int from teloa_conversation_work_requests where owner_id=$1) requests,(select count(*)::int from teloa_conversation_work_successors where owner_id=$1) successors',[f.owner])).rows[0],before)
})
