import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool} from './postgres-test-lifecycle.ts'
import {initializeRoles,RoleService} from '../src/work/roles.ts'
import {initializeTasks,TaskService} from '../src/work/tasks.ts'
import {initializeObjectConversations,ObjectConversationService} from '../src/work/object-conversations.ts'
import {initializeTaskRuns,TaskRunService,type TaskRun} from '../src/work/task-runs.ts'
import {initializeRoleToolGrants} from '../src/work/role-tool-grants.ts'
import {initializeArtifactSnapshots} from '../src/work/artifact-snapshots.ts'
import {initializeArtifacts,ArtifactService} from '../src/work/artifacts.ts'
import {taskArtifactSource} from '../src/work/artifact-task-source.ts'
import {initializeTaskTransitions,initializeTaskCompletions,TaskTransitions} from '../src/work/task-transitions.ts'
import {TaskRunInteractionService} from '../src/work/task-run-interaction.ts'
import {testRoleResponsibility} from './role-test-fixture.ts'
import {initializeBusinessData} from '../src/work/business-data.ts'
import {initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {initializeSecurityRequests} from '../src/security/request-journal.ts'
import {initializeSecurityActions} from '../src/security/actions.ts'
import {initializeSecurityApprovals} from '../src/security/approvals.ts'
import {initializeSecurityActionExecutions} from '../src/security/action-executions.ts'
import {NativeSessionContinuationJournal,initializeNativeSessionContinuations,type NativeSessionCheckpoint} from '../src/work/native-session-continuations.ts'
import {initializeWorkControl} from '../src/work/work-control.ts'
import {initializeConversationWork} from '../src/work/conversation-work.ts'
import {FileConversationRepository} from '../src/work/conversations.ts'
import {createNativeSessionManualContinuation} from '../../harness-dsh/src/native-session-manual-continuation.ts'
import {nativeHotCausalityFixture,textAnswer} from '../../harness-dsh/tests/fixtures/native-hot-causality.ts'
import {loopWorkFixture,loopText} from '../../harness-dsh/tests/fixtures/native-loop-work-admission.ts'
import {observeTaskRun} from '../../harness-dsh/src/task-run-observation.ts'
import {readSessionEvents} from '../../harness-dsh/src/session-events.ts'
import {readTaskRunGroupResult} from '../../harness-dsh/src/task-run-group-result.ts'
import {taskRunInteractionRequest} from '../../harness-dsh/src/task-run-interaction.ts'
import {assertTaskRunCompletedProof} from '../../harness-dsh/src/task-run-completed-proof.ts'
import {initializeTaskRunGoals,TaskRunGoalService} from '../src/work/task-run-goals.ts'
import {TaskRunRuntimeLinkService} from '../src/work/task-run-runtime-links.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri(),max:1})
 await initializeRoles(pool);await initializeTasks(pool);await initializeObjectConversations(pool);await initializeTaskRuns(pool);await initializeRoleToolGrants(pool);await initializeTaskTransitions(pool);await initializeArtifactSnapshots(pool);await initializeArtifacts(pool);await initializeTaskCompletions(pool)
 await initializeBusinessData(pool);await initializeBusinessTasks(pool);await initializeSecurityRequests(pool);await initializeSecurityActions(pool);await initializeSecurityApprovals(pool);await initializeSecurityActionExecutions(pool)
 await initializeNativeSessionContinuations(pool)
 await initializeWorkControl(pool)
 await initializeConversationWork(pool)
 await initializeTaskRunGoals(pool)
},{timeout:120_000})
after(async()=>{await pool?.end();await container?.stop()})

async function fixture(options?:{sessionId:string;execute:(run:TaskRun)=>Promise<unknown>}){
 const owner=randomUUID(),role=await new RoleService(pool,identity).create(owner,{requestId:randomUUID(),fields:{name:'核对岗',kind:'employee',scopes:['general'],duty:'核对资料',dataScope:'本人资料',executionScope:'只读',skills:[],knowledge:[],responsibility:testRoleResponsibility}})
 await pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const tasks=new TaskService(pool,identity),task=await tasks.create(owner,{requestId:randomUUID(),fields:{title:'核对原资料',goal:'输出核对结果',scope:'general'},assignee:{roleId:role.id,expectedVersion:1}}),sessionId=options?.sessionId??randomUUID(),conversationId=randomUUID(),inspect=async()=>({id:conversationId,sessionId,ownerId:owner,status:'ready'})
 await new ObjectConversationService(pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const runs=new TaskRunService(pool,identity,inspect),prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:1,sessionId,expectedLinkVersion:1},undefined,undefined,undefined,async()=> 'teloa-standard')
 await runs.claim(owner,{runId:prepared.id})
 const evidence=options?await options.execute(prepared):{state:'ended',turn:1,messageSeq:2,endSeq:3,reason:'completed'}
 const run=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
 const interactions=new TaskRunInteractionService(runs,async fixed=>{assert.deepEqual(fixed.evidence,run.evidence)})
 const complete=async()=>{
  const artifacts=new ArtifactService(pool,identity,async(actor,expected,db)=>({source:await taskArtifactSource(db,actor,expected.id,true),sessionIds:[]})),artifact=await artifacts.create(owner,{requestId:randomUUID(),source:await taskArtifactSource(pool,owner,task.id,false),content:{title:'原固定成果',sections:[{id:'result',title:'核对结果',text:'原资料已核对'}],snapshotIds:[],note:'本人确认'}})
  return new TaskTransitions(pool,identity).change(owner,{taskId:task.id,requestId:randomUUID(),expectedVersion:3,action:'complete',artifact:{id:artifact.artifactId,version:1},note:'本人验收'})
 }
 return {owner,role,task,sessionId,runs,run,interactions,complete}
}

test('本人验收前保持任务输入锁定，收口后独立追问不改原Task、Run和结项成果',{timeout:20_000},async()=>{
 const f=await fixture()
 await assert.rejects(f.interactions.read(f.owner,f.sessionId),{code:'teloa/conflict'})
 const task=await f.complete(),before=await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id]),interaction=await f.interactions.read(f.owner,f.sessionId)
 assert.ok(interaction);interaction.lease.assertCurrent();assert.equal(interaction.run.id,f.run.id);assert.equal(interaction.target.taskId,f.task.id)
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),f.run)
 assert.equal((await pool.query('select version from teloa_tasks where id=$1',[f.task.id])).rows[0].version,task.version)
 assert.deepEqual((await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows,before.rows)
 await assert.rejects(f.interactions.read(randomUUID(),f.sessionId),{code:'teloa/forbidden'})
})

test('已完成Run仍受后台未知工作、撤权及完整原生证据约束',{timeout:20_000},async()=>{
 const f=await fixture();await f.complete()
 const runtimeId=randomUUID(),nativeId='owner:'+runtimeId+':'+f.sessionId
 await pool.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'job',$3,$4,$5)",[f.owner,f.run.id,nativeId,f.sessionId,JSON.stringify({record:'owner',runtimeId,requestId:f.run.nativeRequestId})])
 await pool.query("update teloa_roles set state='paused' where id=$1",[f.role.id])
 await assert.rejects(f.interactions.read(f.owner,f.sessionId),{code:'teloa/forbidden'})
 await pool.query("update teloa_roles set state='active' where id=$1",[f.role.id])
 const cold=new TaskRunInteractionService(f.runs,async()=>{throw Error('原生完整日志缺失')})
 await assert.rejects(cold.read(f.owner,f.sessionId),/原生完整日志缺失/)
 await pool.query("update teloa_task_run_runtime_links set payload=$4 where owner_id=$1 and run_id=$2 and native_id=$3",[f.owner,f.run.id,nativeId,JSON.stringify({record:'owner',runtimeId,requestId:'unknown-request'})])
 await assert.rejects(f.interactions.read(f.owner,f.sessionId),{code:'teloa/conflict'})
})

test('员工后续授权版本保留原冻结身份，追问工具只取原范围与当前授权交集',async()=>{
 const f=await fixture();await f.complete()
 const rules=[{name:'newly-granted',allowed:[{}]}]
 await pool.query('insert into teloa_role_tool_grants(role_id,base_version,role_version,state,rules,request_spec,created_at) values($1,1,2,\'active\',$2,$3,$4)',[f.role.id,JSON.stringify(rules),JSON.stringify({action:'save',rules}),identity.now()])
 await pool.query('update teloa_roles set version=2 where id=$1',[f.role.id])
 const interaction=await f.interactions.read(f.owner,f.sessionId)
 assert.ok(interaction)
 assert.equal(interaction.run.roleVersion,1)
 assert.deepEqual(interaction.currentRules,rules)
 assert.deepEqual(interaction.allowedTools,[],'新增授权不能扩大原运行的空工具范围')
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),f.run)
})

test('单连接真实Task结项与原SDK日志共同开放追问，后续轮次不改变固定报告或原记录',{timeout:20_000},async t=>{
 const native=await loopWorkFixture(t,true)
 native.adapter.scripts.push(loopText)
 const f=await fixture({sessionId:String(native.agent.id),execute:async run=>{await native.send(run.nativeRequestId);return observeTaskRun(readSessionEvents(native.agent.session),run.nativeRequestId)}})
 const goals=new TaskRunGoalService(pool,identity,{hostGeneration:()=>1,inspectGoal:async()=>{throw Error('只读签收不能激活Goal')},admitRound:async()=>{throw Error('只读签收不能预约轮次')}})
 const interactions=new TaskRunInteractionService(f.runs,async(run,db)=>{
  const links=await new TaskRunRuntimeLinkService(pool).listInTransaction(db,f.owner,{runId:run.id}),goal=await goals.readInTransaction(db,f.owner,{runId:run.id})
  assertTaskRunCompletedProof(run,readSessionEvents(native.agent.session),links,[],goal)
 })
 await assert.rejects(interactions.read(f.owner,f.sessionId),{code:'teloa/conflict'})
 const task=await f.complete(),completion=(await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows
 const prefix=[...readSessionEvents(native.agent.session)]
 assert.ok(await interactions.read(f.owner,f.sessionId))
 f.runs.enableCompletedInteractions(async(owner,sid,db)=>{const value=await interactions.read(owner,sid,db);if(!value)return null;const requestId=taskRunInteractionRequest(readSessionEvents(native.agent.session),value.run);return {...value,...(requestId?{requestId}:{})}})
 native.adapter.scripts.push(loopText);await native.send('independent-new-user')
 assert.ok(await interactions.read(f.owner,f.sessionId))
 assert.deepEqual(readSessionEvents(native.agent.session).slice(0,prefix.length),prefix)
 assert.equal(readTaskRunGroupResult(prefix,f.run.nativeRequestId),'done')
 assert.deepEqual(await f.runs.get(f.owner,{runId:f.run.id}),f.run)
 assert.deepEqual((await pool.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2',[f.owner,f.task.id])).rows,completion)
 assert.equal((await pool.query('select version from teloa_tasks where id=$1',[f.task.id])).rows[0].version,task.version)
 assert.equal(native.adapter.requests.length,2)
})

test('续作账本事务拒绝后不留票据；同前缀幂等且只固定精确Inbox回执',async()=>{
 const journal=new NativeSessionContinuationJournal(pool,identity),owner=randomUUID(),sessionId=randomUUID(),requestId=randomUUID(),runId=randomUUID()
 const c:NativeSessionCheckpoint={ownerId:owner,sessionId,runtimeId:randomUUID(),hostGeneration:1,runId,scopeRunId:runId,requestId,phase:'model',logCut:4,logSha256:'a'.repeat(64),roots:[{sessionId,messageId:randomUUID(),nativeRequestId:requestId,payloadSha256:'b'.repeat(64)}],model:{provider:'fixture',model:'fixed-model'},review:null}
 await pool.query('insert into teloa_work_control_hosts(owner_id,generation) values($1,1)',[owner])
 await journal.save(c,()=>{})
 await pool.query('update teloa_work_control_hosts set generation=2 where owner_id=$1',[owner])
 await assert.rejects(journal.save({...c,logCut:5},()=>{}),{code:'teloa/conflict'})
 await assert.rejects(journal.prepare(c,2,'automatic',async()=>{throw Error('当前授权已失效')}),/当前授权已失效/)
 assert.deepEqual(await journal.records(owner,sessionId),[])
 const authorize=async()=>({assertCurrent(){}}),first=await journal.prepare(c,2,'automatic',authorize),again=await journal.prepare(c,2,'automatic',authorize)
 assert.equal(first.record.id,again.record.id);assert.equal(first.record.state,'prepared')
 const event={type:'agent/inbox/spliced',seq:5,data:{target:'next-turn',start:0,inserted:[first.record.message]}}
 await assert.rejects(journal.accept(owner,first.record.id,5,{...event,data:{...event.data,inserted:[{...first.record.message,id:randomUUID()}]}},()=>{},2),{code:'teloa/conflict'})
 const accepted=await journal.accept(owner,first.record.id,5,event,()=>{},2)
 assert.equal(accepted.state,'accepted');assert.equal(accepted.acceptedSeq,5)
 assert.deepEqual(await journal.accept(owner,first.record.id,5,event,()=>{},2),accepted)
 assert.equal((await journal.records(owner,sessionId)).length,1)
 await assert.rejects(journal.prepare({...c,logSha256:'c'.repeat(64)},2,'automatic',authorize),{code:'teloa/conflict'})
 await assert.rejects(journal.save({...c,model:{...c.model!,rawCredential:'forbidden'} as never},()=>{}),{code:'teloa/conflict'})
})

test('真实PG票据与原writer贯通：历史读取不执行，显式恢复过期原根且重试不重复消息',{timeout:20_000},async t=>{
 const owner=randomUUID(),runtimeId=randomUUID(),root=await mkdtemp(join(tmpdir(),'teloa-manual-ledger-'))
 t.after(()=>rm(root,{recursive:true,force:true}))
 const journal=new NativeSessionContinuationJournal(pool,identity)
 await pool.query('insert into teloa_work_control_hosts(owner_id,generation) values($1,1)',[owner])
 let manual:ReturnType<typeof createNativeSessionManualContinuation>|undefined,allowClaim=false
 const f=await nativeHotCausalityFixture(t,{persistenceRoot:join(root,'history'),restore:input=>{if(!manual)throw Error('尚未初始化');return manual.restore(input)},checkpoint:async input=>{
  await manual?.checkpoint(input)
  await journal.save({ownerId:owner,sessionId:input.agent.id,runtimeId,hostGeneration:1,runId:null,scopeRunId:null,requestId:'manual-original-input',phase:'claimed',logCut:input.snapshot.events.length-1,logSha256:createHash('sha256').update(JSON.stringify(input.snapshot.events)).digest('hex'),roots:input.roots,model:null,review:null,background:{runtimeId,unsettledJobIds:[]}},input.assertCurrent)
  if(!allowClaim)throw Error('原持久确认后的响应丢失')
 }})
 const sessionId=String(f.agent.id),repository=new FileConversationRepository(join(root,'conversations.json'))
 await repository.write([{id:'manual-original',ownerId:owner,sessionId,requestedSessionId:sessionId,title:'本人原工作',scopeIds:['general'],version:1,status:'ready',createdAt:identity.now()}])
 await pool.query('insert into teloa_conversation_work_contexts(owner_id,session_id,scope_id,version,locked) values($1,$2,\'general\',1,true)',[owner,sessionId])
 f.ctx.provide('sessionController',{resolveAgent:async(id:string)=>{assert.equal(id,sessionId);return {agent:f.agent}}} as never)
 const snapshot=async()=>{
  await f.ctx.sessions.flush(f.agent.session)
  const reader=await f.ctx.sessionPersistence.open(f.agent.id,'read')
  try{return {header:reader.header,events:(await reader.read()).events,inheritedEventCount:Number(reader.inheritedEventCount)}}finally{await reader.close()}
 }
 manual=createNativeSessionManualContinuation(f.ctx,{owner,journal,nativeInput:f.work,generation:()=>1,assertCurrent(){},snapshot,
  inbox:value=>f.ctx.sessionProjections.stateOf(f.sessionPackage.Session.create(f.agent.id,value.events,value.header,f.sessionPackage.SessionLogOffset(value.inheritedEventCount)),'inbox'),
  binding:async(_c,db)=>{const rows=(await repository.read()).filter(row=>row.ownerId===owner&&row.sessionId===sessionId&&row.status==='ready');assert.equal(rows.length,1);const context=(await(db??pool).query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2',[owner,sessionId])).rows;return JSON.stringify([rows,context])},
  authorize:()=>f.access.authorize({kind:'capability',capability:'general-agent',ownerId:owner,sessionId,objectId:null,operation:'resume'}),
 })
 const original=await f.send('manual-original-input');await f.agent.whenIdle()
 const prefix=await snapshot(),read=await manual.inspect(sessionId)
 assert.equal(read.available,true);assert.deepEqual(await journal.records(owner,sessionId),[]);assert.equal(f.adapter.requests.length,0)
 await assert.rejects(f.work.wakePending(f.agent),{code:'teloa/conflict'})
 assert.deepEqual(await snapshot(),prefix,'没有本人操作的原地唤醒不能改历史或执行')
 f.rights.generation++;allowClaim=true;f.adapter.scripts.push(textAnswer)
 await manual.resume(sessionId,read.prefixSha256!,new AbortController().signal);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1)
 const records=await journal.records(owner,sessionId);assert.equal(records.length,1);assert.equal(records[0]!.input,'pending');assert.equal(records[0]!.state,'accepted')
 const after=await snapshot()
 assert.deepEqual(after.events.slice(0,prefix.events.length),prefix.events)
 assert.equal(after.events.filter(event=>event.type==='user/message'&&event.data.id===original.id).length,1)
 assert.equal(after.events.filter(event=>event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.id===original.id)).length,1)
 await manual.resume(sessionId,read.prefixSha256!,new AbortController().signal);await f.agent.whenIdle()
 assert.equal(f.adapter.requests.length,1);assert.equal((await journal.records(owner,sessionId)).length,1)
 assert.equal((await manual.inspect(sessionId)).available,false)
 manual.close()
})
