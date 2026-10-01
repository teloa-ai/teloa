import test,{after,before} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService} from '../src/work/task-runs.ts'
import {initializeTaskRunSubagents,TaskRunSubagentService} from '../src/work/task-run-subagents.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeTaskRunSubagents(pool)
},{timeout:180_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'拆分岗',kind:'employee',scopes:['general'],duty:'拆分工作',dataScope:'范围内',executionScope:'受管',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await pool.query("update teloa_roles set state='active',version=2 where id=$1",[role.id])
 const task=await new TaskService(pool,identity).create(owner,{requestId:randomUUID(),fields:{title:'拆分任务',goal:'验证登记',scope:'general'},assignee:{roleId:role.id,expectedVersion:2}})
 const sessionId='parent_'+randomUUID().replaceAll('-',''),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:2,sessionId,expectedLinkVersion:1}),claimed=await runs.claim(owner,{runId:prepared.id})
 return {owner,run:claimed.run,runs}
}

test('先预留、后绑定、结束：登记完整归属父 Run 且同一预留幂等',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID()
 const first=await service.reserve(owner,{runId:run.id,reservationId,limit:2})
 assert.deepEqual(first,{reservation:{runId:run.id,reservationId,state:'reserved',createdAt:first.reservation.createdAt},count:1})
 const replay=await service.reserve(owner,{runId:run.id,reservationId,limit:1})
 assert.deepEqual(replay,first)
 const childSessionId='child_'+randomUUID().replaceAll('-','')
 const started=await service.bind(owner,{reservationId,childSessionId,depth:1})
 assert.equal(started.state,'started');assert.equal(started.childSessionId,childSessionId);assert.equal(started.depth,1);assert.ok(started.startedAt)
 assert.deepEqual(await service.outstanding(owner,run.id),[started])
 const ended=await service.settle(owner,{childSessionId,stopReason:'completed',tokenEstimate:321})
 assert.equal(ended.state,'ended');assert.equal(ended.stopReason,'completed');assert.equal(ended.tokenEstimate,321);assert.ok(ended.endedAt)
 assert.deepEqual(await service.outstanding(owner,run.id),[])
 assert.deepEqual(await service.list(owner,run.id),[ended])
 assert.deepEqual(await service.settle(owner,{childSessionId,stopReason:'ignored-replay',tokenEstimate:321}),ended)
 await assert.rejects(service.settle(owner,{childSessionId,stopReason:'ignored-replay',tokenEstimate:322}),{code:'teloa/conflict'})
})

test('生命周期先结项时，工具可补写一次结束时令牌估算',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID(),childSessionId='child_'+randomUUID().replaceAll('-','')
 await service.reserve(owner,{runId:run.id,reservationId,limit:2})
 await service.bind(owner,{reservationId,childSessionId,depth:1})
 const ended=await service.settle(owner,{childSessionId,stopReason:'completed'})
 assert.equal(ended.tokenEstimate,undefined)
 const enriched=await service.settle(owner,{childSessionId,stopReason:'completed',tokenEstimate:8})
 assert.equal(enriched.tokenEstimate,8)
})

test('父 Run 生命周期、累计上限、本人和子会话唯一性都由登记服务强制',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunSubagentService(pool,identity),first='call:'+randomUUID()
 await service.reserve(owner,{runId:run.id,reservationId:first,limit:1})
 await assert.rejects(service.reserve(owner,{runId:run.id,reservationId:'call:'+randomUUID(),limit:1}),{code:'teloa/conflict'})
 await assert.rejects(service.reserve(randomUUID(),{runId:run.id,reservationId:'call:'+randomUUID(),limit:1}),{code:'teloa/forbidden'})
 await pool.query("update teloa_task_runs set state='ended' where id=$1",[run.id])
 await assert.rejects(service.reserve(owner,{runId:run.id,reservationId:'call:'+randomUUID(),limit:2}),{code:'teloa/conflict'})
 const childSessionId='child_'+randomUUID().replaceAll('-','')
 await assert.rejects(service.bind(owner,{reservationId:first,childSessionId,depth:1}),{code:'teloa/conflict'})
 // 恢复真实活跃状态，再保留下面跨父 Run 的子会话唯一性验证。
 await pool.query("update teloa_task_runs set state='submitting' where id=$1",[run.id])
 await service.bind(owner,{reservationId:first,childSessionId,depth:1})
 const second=await fixture(),secondReservation='call:'+randomUUID()
 await service.reserve(second.owner,{runId:second.run.id,reservationId:secondReservation,limit:2})
 await assert.rejects(service.bind(second.owner,{reservationId:secondReservation,childSessionId,depth:1}),error=>(error as {code?:string}).code==='23505')
})

test('同一父 Run 可并发预留多个子 Agent，每条按自己的预留身份绑定',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunSubagentService(pool,identity),one='call:'+randomUUID(),two='call:'+randomUUID()
 const [first,second]=await Promise.all([service.reserve(owner,{runId:run.id,reservationId:one,limit:3}),service.reserve(owner,{runId:run.id,reservationId:two,limit:3})])
 assert.equal(first.count+second.count,3)
 const firstChild='child_'+randomUUID().replaceAll('-',''),secondChild='child_'+randomUUID().replaceAll('-','')
 const [boundOne,boundTwo]=await Promise.all([service.bind(owner,{reservationId:one,childSessionId:firstChild,depth:1}),service.bind(owner,{reservationId:two,childSessionId:secondChild,depth:1})])
 assert.equal(boundOne.childSessionId,firstChild);assert.equal(boundTwo.childSessionId,secondChild)
 assert.equal((await service.outstanding(owner,run.id)).length,2)
})

test('启动尚未发布子会话时释放预留，不计入累计上限',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID()
 await service.reserve(owner,{runId:run.id,reservationId,limit:1})
 await service.release(owner,{reservationId})
 assert.deepEqual(await service.list(owner,run.id),[])
 await service.reserve(owner,{runId:run.id,reservationId:'call:'+randomUUID(),limit:1})
})

test('数据库结构拒绝未绑定的结束态和没有停止原因的完成态',async()=>{
 const {owner,run}=await fixture()
 await assert.rejects(pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'ended',$4)",[owner,run.id,'call:'+randomUUID(),identity.now()]),error=>(error as {code?:string}).code==='23514')
})

test('绑定失败可把预留登记为 abandoned，不再阻塞 Run 结项但仍计入累计上限',async()=>{
 const {owner,run}=await fixture(),service=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID(),childSessionId='child_'+randomUUID().replaceAll('-','')
 await service.reserve(owner,{runId:run.id,reservationId,limit:1})
 const abandoned=await service.abandon(owner,{reservationId,childSessionId,depth:1,stopReason:'bind-failed'})
 assert.equal(abandoned.state,'abandoned');assert.equal(abandoned.childSessionId,childSessionId);assert.equal(abandoned.depth,1);assert.equal(abandoned.stopReason,'bind-failed');assert.ok(abandoned.startedAt);assert.ok(abandoned.endedAt)
 assert.deepEqual(await service.outstanding(owner,run.id),[])
 await assert.rejects(service.reserve(owner,{runId:run.id,reservationId:'call:'+randomUUID(),limit:1}),{code:'teloa/conflict'})
 assert.deepEqual(await service.abandon(owner,{reservationId,childSessionId,depth:1,stopReason:'ignored-replay'}),abandoned)
})

test('卡住的预留只能由同一父 Run 的本人显式收口；收口保留审计记录且不伪造子会话完成',async()=>{
 const {owner,run,runs}=await fixture(),service=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID(),terminal={runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended' as const,turn:1,messageSeq:2,endSeq:3,reason:'completed' as const}}
 await service.reserve(owner,{runId:run.id,reservationId,limit:2})
 await assert.rejects(runs.record(owner,terminal),{code:'teloa/conflict'})
 await assert.rejects(service.recover(randomUUID(),{runId:run.id,reservationId}),{code:'teloa/forbidden'})
 await assert.rejects(service.recover(owner,{runId:randomUUID(),reservationId}),{code:'teloa/conflict'})
 const recovered=await service.recover(owner,{runId:run.id,reservationId})
 assert.deepEqual(recovered,{runId:run.id,reservationId,state:'abandoned',createdAt:recovered.createdAt,endedAt:recovered.endedAt,stopReason:'manual-recovery'})
 assert.deepEqual(await service.outstanding(owner,run.id),[])
 await assert.rejects(service.bind(owner,{reservationId,childSessionId:'child_'+randomUUID().replaceAll('-',''),depth:1}),{code:'teloa/conflict'})
 await assert.rejects(service.recover(owner,{runId:run.id,reservationId}),{code:'teloa/conflict'})
 assert.equal((await runs.record(owner,terminal)).state,'ended')
})

test('已启动子任务不能人工收口，仍阻塞父 Run 直到原生结算路径返回',async()=>{
 const {owner,run,runs}=await fixture(),service=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID(),childSessionId='child_'+randomUUID().replaceAll('-',''),terminal={runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended' as const,turn:1,messageSeq:2,endSeq:3,reason:'completed' as const}}
 await service.reserve(owner,{runId:run.id,reservationId,limit:2})
 const started=await service.bind(owner,{reservationId,childSessionId,depth:1})
 await assert.rejects(service.recover(owner,{runId:run.id,reservationId}),error=>error instanceof Error&&'code'in error&&(error as {code?:string}).code==='teloa/conflict'&&error.message==='子 Agent 已启动，请先在原生会话结束后再核对。')
 assert.deepEqual(await service.outstanding(owner,run.id),[started])
 await assert.rejects(runs.record(owner,terminal),{code:'teloa/conflict'})
 await service.settle(owner,{childSessionId,stopReason:'completed'})
 assert.equal((await runs.record(owner,terminal)).state,'ended')
})

test('父 Run 必须等全部子 Agent 结项后才能记录原生终态',async()=>{
 const {owner,run,runs}=await fixture(),subagents=new TaskRunSubagentService(pool,identity),reservationId='call:'+randomUUID(),childSessionId='child_'+randomUUID().replaceAll('-','')
 await subagents.reserve(owner,{runId:run.id,reservationId,limit:2})
 await subagents.bind(owner,{reservationId,childSessionId,depth:1})
 const terminal={runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,evidence:{state:'ended' as const,turn:1,messageSeq:2,endSeq:3,reason:'completed' as const}}
 await assert.rejects(runs.record(owner,terminal),error=>error instanceof Error&&'code'in error&&(error as {code?:string}).code==='teloa/conflict'&&error.message==='仍有在执行的子任务，请等待其结束后再结项。')
 assert.equal((await runs.get(owner,{runId:run.id})).state,'submitting')
 await subagents.settle(owner,{childSessionId,stopReason:'completed'})
 assert.equal((await runs.record(owner,terminal)).state,'ended')
})

test('初始化迁移只替换已知生命周期约束，不会移除后续扩展的完整性约束',async()=>{
 const {owner,run}=await fixture()
 await pool.query("alter table teloa_task_run_subagents add constraint teloa_task_run_subagents_future_guard check(reservation_id<>'future-invalid')")
 await initializeTaskRunSubagents(pool)
 await assert.rejects(pool.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,'future-invalid','reserved',$3)",[owner,run.id,identity.now()]),error=>(error as {code?:string}).code==='23514')
})

test('父 Run 停止后不再预留或绑定新子会话，已有绑定可幂等读取并正常结算',async()=>{
 const {owner,run,runs}=await fixture(),service=new TaskRunSubagentService(pool,identity),reserved='call:'+randomUUID(),started='call:'+randomUUID(),childSessionId='child_'+randomUUID().replaceAll('-','')
 await service.reserve(owner,{runId:run.id,reservationId:reserved,limit:3})
 await service.reserve(owner,{runId:run.id,reservationId:started,limit:3})
 const bound=await service.bind(owner,{reservationId:started,childSessionId,depth:1})
 await runs.requestStop(owner,{runId:run.id})
 await assert.rejects(service.reserve(owner,{runId:run.id,reservationId:'call:'+randomUUID(),limit:3}),{code:'teloa/conflict'})
 await assert.rejects(service.bind(owner,{reservationId:reserved,childSessionId:'late_'+randomUUID().replaceAll('-',''),depth:1}),{code:'teloa/conflict'})
 assert.deepEqual(await service.bind(owner,{reservationId:started,childSessionId,depth:1}),bound)
 const ended=await service.settle(owner,{childSessionId,stopReason:'user'})
 assert.equal(ended.state,'ended')
 assert.deepEqual(await service.bind(owner,{reservationId:started,childSessionId,depth:1}),ended,'重启复核精确身份不重开已结束的子会话')
 assert.equal((await service.list(owner,run.id)).find(row=>row.reservationId===reserved)?.state,'reserved')
})
