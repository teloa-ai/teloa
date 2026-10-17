import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session'
import {createUserMessage} from '@deepseek-ai/dsh-llm'
import {initializeTeloaDatabase,ResourceService,RoleService,TaskService,ConversationWorkService,TaskRunService,ObjectConversationService,TaskRunRuntimeLinkService,TaskRunSubagentService,TaskRunFlowService,defaultWorkBudgetPolicy,type TaskRunRuntimeLinks} from '@teloa/backend'
import {createPublicReferenceCatalog} from '../../mcp-reference/src/local.ts'
import {setupRoleWork,identity} from '../../backend/tests/role-work-test-fixture.ts'
import {testRoleResponsibility} from '../../backend/tests/role-test-fixture.ts'
import {installNativeSessions,installNativeHostServices,installNativeSessionController,ControlledPromptModel,publishNativeFixtureInput} from './fixtures/native-host-services.ts'
import {createResidentWorkRuntime} from '../src/resident-work-runtime.ts'
import {requireNativeInputProvider} from '../src/native-input-provider.ts'
import {dshTaskRunPorts} from '../src/task-run-dsh.ts'
import {createTaskRunBackground,taskRunRuntimeId} from '../src/task-run-background.ts'
import {observeTaskRun} from '../src/task-run-observation.ts'
import {readSessionEvents} from '../src/session-events.ts'
import {taskRunOwnerSettlement} from '../src/task-run-owner-settlement.ts'
const nativeRequire=createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))
const official=(name:string)=>import(nativeRequire.resolve('@deepseek-ai/'+name))

/** 本用例验证已结束固定 Run 的冷恢复预检；不替代新会话的完整预设挂载验收。 */
async function nativeHost(directory:string){
 const ctx=new Context();await installNativeSessions(ctx);await installNativeHostServices(ctx,directory)
 await ctx.plugin((await official('dsh-storage')).Storage);await ctx.plugin(await official('dsh-storage-json'),{root:join(directory,'domains')});await ctx.plugin(await official('dsh-storage-domain'),{backend:'json'})
 await ctx.plugin((await official('dsh-workspace')).WorkspaceRegistry)
 await ctx.plugin((await official('dsh-session-query-sqlite')).SqliteSessionQueryEngine,{path:join(directory,'query.sqlite'),openAt:'never'})
 await ctx.plugin((await official('dsh-session-projection-cache')).SessionProjectionCache,{writeEveryEvents:100,writeIntervalMs:60000})
 // alpha3：Gateway 与 SessionController 都注入 remoteAccess；按官方组合同时挂载 RemoteAccessService，否则二者不激活。
 await ctx.plugin((await official('dsh-typert-registry')).default);await ctx.plugin((await official('dsh-api-remote-access')).default);await ctx.plugin((await official('dsh-api-gateway')).default)
 ctx.provide('agentDefaultModel',{currentSelection:()=>({provider:'controlled',model:'fixed'}),saveSelection:async()=>{}})
 ctx.provide('fileUploads',{registerAgentResolver:()=>()=>{},bindPrompt:()=>({commit(){},[Symbol.dispose](){}})})
 // alpha3 宿主装配已注册真实 LocalFileSystem 等服务；只在缺失时提供空桩，不重复注册。
 if(!ctx.get('fs'))ctx.provide('fs',{});if(!ctx.get('fileReferences'))ctx.provide('fileReferences',{})
 await installNativeSessionController(ctx,{nativeOpen:false})
 return ctx
}

test('真实PG与官方冷Controller：重启收口旧owner失败轮，owner/角色/预算复核后恢复同谱系',{timeout:90000},async t=>{
 const f=await setupRoleWork(),directory=await mkdtemp(join(process.cwd(),'.tmp-resident-retry-'))
 const contexts:Context[]=[],residents:Array<Awaited<ReturnType<typeof createResidentWorkRuntime>>>=[]
 const portsByHost=new Map<Context,ReturnType<typeof dshTaskRunPorts>>()
 t.after(async()=>{for(const resident of residents)resident.close();for(const ctx of contexts)await ctx.fiber.dispose();await f.close();await rm(directory,{recursive:true,force:true})})
 await initializeTeloaDatabase(f.pool)
 const resources=new ResourceService(f.pool,createPublicReferenceCatalog(),identity)
 const owner=randomUUID(),roles=new RoleService(f.pool,identity),role=await roles.create(owner,{requestId:randomUUID(),fields:{name:'固定职责',kind:'employee',scopes:['general'],duty:'核对事实',dataScope:'原资料',executionScope:'代拟',skills:[],knowledge:[],responsibility:testRoleResponsibility,runtimeConfig:{agentPresetId:'teloa-standard'}}})
 await f.pool.query("update teloa_roles set state='active',version=3 where owner_id=$1 and id=$2",[owner,role.id])
 const parentSession='parent-'+randomUUID(),sessionId='run-'+randomUUID(),conversationIds=new Map<string,string>()
 const inspect=async(_actor:string,id:string)=>{if(!conversationIds.has(id))conversationIds.set(id,randomUUID());return {id:conversationIds.get(id)!,ownerId:owner,sessionId:id,status:'ready'}}
 const requests=new ConversationWorkService(f.pool,identity.now,async()=>({ownerId:owner,sessionId:parentSession,status:'ready',submitted:false}))
 const parent=await requests.reserve(owner,{requestId:randomUUID(),sessionId:parentSession,messageId:'human',messageSeq:1,kind:'task',scope:'general',title:'原目标',goal:'逐字核对事实',roleId:role.id,expectedRoleVersion:3})
 const runs=new TaskRunService(f.pool,identity,inspect),journal=new TaskRunRuntimeLinkService(f.pool),links:TaskRunRuntimeLinks={list:input=>journal.list(owner,input),put:input=>journal.put(owner,input)}
 let seals=0,revoked=false
 const createResident=async(ctx:Context)=>{
  const resident=await createResidentWorkRuntime(ctx,{owner,pool:f.pool,identity,nativeInput:requireNativeInputProvider(ctx).input,ownerAuthority:{authorize:async()=>{seals++;return {assertCurrent(){if(revoked)throw Error('本人许可已撤销')}}}},runs:async()=>runs,resources,dailyLogs:async()=>{throw Error('恢复不能读或生成员工日志')},executionScope:(db,actor,runId,mode)=>runs.executionScopeInTransaction(db,actor,{runId,mode}),verifyInitialMessage:async()=>false,report:()=>{}})
  ctx.provide('teloaResidentInputAdmission',resident)
  residents.push(resident)
  const ports=dshTaskRunPorts(ctx,owner,id=>inspect(owner,id),undefined,undefined,undefined,undefined,undefined,undefined,links,undefined,undefined,requireNativeInputProvider(ctx).input,{goalObservation:resident.goal.observation,stopGoal:resident.goal.stop})
  ports.subagentState=async run=>(await new TaskRunSubagentService(f.pool,identity).list(owner,run.id)).length?'outstanding':'none'
  ports.flowState=async run=>await new TaskRunFlowService(f.pool,identity).get(owner,{runId:run.id})?'outstanding':'none'
  ports.controlState=run=>resident.controls.stateForRun(owner,{runId:run.id})
  portsByHost.set(ctx,ports)
  await resident.attachRunDriver({ports,runtimeLinks:journal})
  return resident
 }
 const first=await nativeHost(directory);contexts.push(first);const prior=await createResident(first)
 t.diagnostic('首宿主真实控制已就绪')
 const task=await new TaskService(f.pool,identity).createForConversation(owner,{sessionId:parentSession,requestId:parent.requestId,roleId:role.id})
 class BeforeOutputFailure extends ControlledPromptModel{calls=0;override async *stream(){this.calls++;throw Error('首输出之前失败')}}
 const model=new BeforeOutputFailure();first.llm.registerAdapter(['controlled'],model)
 const handle=await first.agents.create({sessionId:SessionId(sessionId),meta:{cwd:directory,agentPreset:'teloa-standard'},agentOptions:{provider:'controlled',model:'fixed'}})
 const linked=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:task.id,expectedObjectVersion:1,sessionId,expectedLinkVersion:0,action:'link'})
 const prepared=await runs.prepare(owner,{requestId:randomUUID(),taskId:task.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:3,sessionId,expectedLinkVersion:linked.version}),claimed=await runs.claim(owner,{runId:prepared.id})
 const missed=await prior.budgets.reserve(owner,{budgetAccountId:prepared.lineage!.budgetAccountId,controlGeneration:1,modelRequestId:'bounded-budget-proof',kind:'retry',tokens:2,rounds:0})
 const immediate=await prior.budgets.reserve(owner,{budgetAccountId:prepared.lineage!.budgetAccountId,controlGeneration:1,modelRequestId:'immediate-budget-proof',kind:'retry',tokens:0,rounds:0})
 await prior.budgets.markDispatched(owner,{reservationId:immediate.id})
 const backgroundRuntimeId=randomUUID(),background=createTaskRunBackground(first,links,undefined,backgroundRuntimeId);await background.start(claimed.run)
 await publishNativeFixtureInput(first,handle.agent,createUserMessage({source:{kind:'user',rpcId:claimed.run.nativeRequestId},content:[{type:'text',text:claimed.run.inputText}]}));await handle.agent.whenIdle()
 const before=readSessionEvents(handle.agent.session),evidence=observeTaskRun(before,claimed.run.nativeRequestId)
 assert.ok(evidence.state==='ended'&&evidence.reason==='error');const failed=await runs.record(owner,{runId:prepared.id,sessionId,nativeRequestId:prepared.nativeRequestId,evidence})
 assert.equal((await f.pool.query('select version from teloa_tasks where id=$1',[task.id])).rows[0].version,3);assert.equal(model.calls,1)
 const retryFixture=async(runId:string,operationId:string,modelRequestId:string)=>{
  await f.pool.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,attempts,max_attempts,state,completed,last_reason,created_at,updated_at) values($1,$2,$3,$4,1,3,'unknown',false,'原回执未知',now(),now())",[owner,operationId,runId,prepared.lineage!.budgetAccountId])
  await f.pool.query("insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,$3,1,$4,'{}')",[owner,randomUUID(),operationId,modelRequestId])
 }
 await retryFixture(failed.id,'model:immediate-budget-proof',immediate.modelRequestId)
 await retryFixture(failed.id,'model:missed-budget-proof',missed.modelRequestId)
 await prior.settleRun(owner,failed)
 assert.equal((await f.pool.query('select owner_settlement from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[owner,failed.id])).rows[0].owner_settlement,null,'resident不能替其它runtime签新证明')
 const ownerProof=await taskRunOwnerSettlement(first,failed,{runtimeId:backgroundRuntimeId,ports:{...portsByHost.get(first)!,backgroundState:background.state},listLinks:()=>journal.list(owner,{runId:failed.id}),nativeInput:requireNativeInputProvider(first).input,now:identity.now})
 assert.ok(ownerProof,'实际官方会话与原宿主活动收口后产生终态证明')
 await journal.recordOwnerSettlement(owner,ownerProof)
 const ownerStored=(await f.pool.query("select payload,owner_settlement from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and native_id=$3",[owner,failed.id,ownerProof.nativeId])).rows[0]
 assert.deepEqual(ownerStored.owner_settlement,ownerProof);assert.equal(ownerStored.payload.record,'owner');assert.equal(ownerStored.payload.runtimeId,backgroundRuntimeId,'证明另存，原owner历史身份不被覆盖')
 // 当前宿主接线须由正式 settleRun 自动调用 producer 和 store；不以手动 helper 读回代替接线证明。
 const currentSession='current-owner-'+randomUUID(),currentModel=new BeforeOutputFailure();first.llm.registerAdapter(['controlled-owner'],currentModel)
 const currentRequest=await requests.reserve(owner,{requestId:randomUUID(),sessionId:parentSession,messageId:'current-owner',messageSeq:2,kind:'task',scope:'general',title:'当前宿主收口',goal:'核对当前宿主终态接线',roleId:role.id,expectedRoleVersion:3})
 const currentTask=await new TaskService(f.pool,identity).createForConversation(owner,{sessionId:parentSession,requestId:currentRequest.requestId,roleId:role.id})
 const currentHandle=await first.agents.create({sessionId:SessionId(currentSession),meta:{cwd:directory,agentPreset:'teloa-standard'},agentOptions:{provider:'controlled-owner',model:'fixed'}})
 const currentLink=await new ObjectConversationService(f.pool,inspect,identity.now).change(owner,{requestId:randomUUID(),kind:'task',objectId:currentTask.id,expectedObjectVersion:1,sessionId:currentSession,expectedLinkVersion:0,action:'link'})
 const currentRuns=new TaskRunService(f.pool,identity,inspect,{allowedTools:['get_goal']})
 const currentPrepared=await currentRuns.prepare(owner,{requestId:randomUUID(),taskId:currentTask.id,expectedTaskVersion:1,roleId:role.id,expectedRoleVersion:3,sessionId:currentSession,expectedLinkVersion:currentLink.version}),currentClaimed=await currentRuns.claim(owner,{runId:currentPrepared.id})
 const currentBackground=createTaskRunBackground(first,links);await currentBackground.start(currentClaimed.run)
 await publishNativeFixtureInput(first,currentHandle.agent,createUserMessage({source:{kind:'user',rpcId:currentClaimed.run.nativeRequestId},content:[{type:'text',text:currentClaimed.run.inputText}]}));await currentHandle.agent.whenIdle()
 const currentEvidence=observeTaskRun(readSessionEvents(currentHandle.agent.session),currentClaimed.run.nativeRequestId)
 assert.ok(currentEvidence.state==='ended');const currentEnded=await currentRuns.record(owner,{runId:currentPrepared.id,sessionId:currentSession,nativeRequestId:currentPrepared.nativeRequestId,evidence:currentEvidence})
 await prior.settleRun(owner,currentEnded)
 const automatic=(await f.pool.query('select payload,owner_settlement from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[owner,currentEnded.id])).rows[0]
 assert.ok(automatic.owner_settlement,'正常settleRun必须自动保存当前宿主终态证明')
 assert.equal(automatic.payload.runtimeId,taskRunRuntimeId);assert.equal(automatic.owner_settlement.runId,currentEnded.id);assert.deepEqual(automatic.owner_settlement.evidence,currentEvidence);assert.equal(currentModel.calls,1)
 // 自有测试库回到“回调漏写”的初始事实；pump 只能补同宿主证明，不能执行工作或模型。
 await f.pool.query('update teloa_task_run_runtime_links set owner_settlement=null where owner_id=$1 and run_id=$2',[owner,currentEnded.id])
 const noOwnerReplay=async():Promise<never>=>{throw Error('owner证明补核不能创建或执行工作')}
 await prior.pump({outbox:prior.outbox,createTask:noOwnerReplay,prepare:noOwnerReplay,start:noOwnerReplay,readRun:noOwnerReplay,reconcile:noOwnerReplay,report:()=>{}},noOwnerReplay,new AbortController().signal)
 const repaired=(await f.pool.query('select owner_settlement from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[owner,currentEnded.id])).rows[0].owner_settlement
 assert.ok(repaired,'有界pump应补当前宿主遗漏的终态证明');assert.equal(repaired.nativeId,automatic.owner_settlement.nativeId);assert.equal(repaired.prefixSha256,automatic.owner_settlement.prefixSha256);assert.equal(currentModel.calls,1)
 currentBackground.dispose()
 const immediateProof=(await f.pool.query('select elapsed_ended_at,elapsed_terminal,state,actual_tokens,settled_at from teloa_work_budget_reservations where id=$1',[immediate.id])).rows[0]
 assert.equal(immediateProof.elapsed_ended_at.toISOString(),new Date(before[evidence.endSeq]!.time).toISOString(),'正式终态回调封口同Run预算时钟')
 assert.equal(immediateProof.elapsed_terminal.runId,failed.id);assert.equal(immediateProof.state,'unknown');assert.equal(immediateProof.actual_tokens,null);assert.equal(immediateProof.settled_at,null)
 await prior.budgets.markDispatched(owner,{reservationId:missed.id})
 // 早于真实 Run 的一批缺失日志只能保留未知；它们不能永久饿死后面的可核终态。
 for(let index=0;index<100;index++){
  const id=randomUUID(),taskId=randomUUID(),modelRequestId='retry:missing-proof:'+index
  await f.pool.query("insert into teloa_tasks select (jsonb_populate_record(null::teloa_tasks,to_jsonb(t)||jsonb_build_object('id',$2::text,'request_id',$3::text))).* from teloa_tasks t where id=$1",[task.id,taskId,randomUUID()])
  await f.pool.query("insert into teloa_task_runs select (jsonb_populate_record(null::teloa_task_runs,to_jsonb(r)||jsonb_build_object('id',$2::text,'request_id',$3::text,'native_request_id',$4::text,'session_id',$5::text,'task_id',$6::text,'created_at',r.created_at-interval '1 second'))).* from teloa_task_runs r where id=$1",[failed.id,id,randomUUID(),randomUUID(),'missing-budget-proof-'+index,taskId])
  await f.pool.query("insert into teloa_work_budget_reservations(id,owner_id,budget_account_id,control_generation,model_request_id,kind,reserved_tokens,reserved_rounds,state,created_at) values($1,$2,$3,1,$4,'retry',0,0,'unknown',now())",[randomUUID(),owner,prepared.lineage!.budgetAccountId,modelRequestId])
  await retryFixture(id,'model:missing-proof:'+index,modelRequestId)
 }
 t.diagnostic('原生模型首输出前失败，Task 已由运行状态自动进入 v3')
 await first.sessions.flush(handle.agent.session);background.dispose();prior.close();await first.fiber.dispose()
 const cold=await nativeHost(directory);contexts.push(cold);const restored=await createResident(cold)
 assert.equal((await f.pool.query('select elapsed_ended_at from teloa_work_budget_reservations where id=$1',[missed.id])).rows[0].elapsed_ended_at,null,'第一批最多读取100个未知Run')
 const never=async():Promise<never>=>{throw Error('预算补核不能创建或执行工作')}
 await restored.pump({outbox:restored.outbox,createTask:never,prepare:never,start:never,readRun:never,reconcile:never,report:()=>{}},never,new AbortController().signal)
 const recovered=(await f.pool.query('select elapsed_ended_at,elapsed_terminal,state,actual_tokens,settled_at from teloa_work_budget_reservations where id=$1',[missed.id])).rows[0]
 assert.ok(recovered.elapsed_ended_at,'第二批必须越过不可证旧项，正式冷读取原Run终态')
 assert.equal(recovered.elapsed_ended_at.toISOString(),new Date(before[evidence.endSeq]!.time).toISOString());assert.equal(recovered.elapsed_terminal.runId,failed.id)
 assert.equal(recovered.state,'unknown');assert.equal(recovered.actual_tokens,null);assert.equal(recovered.settled_at,null)
 assert.equal((await f.pool.query("select count(*)::int count from teloa_work_budget_reservations where owner_id=$1 and model_request_id like 'retry:missing-proof:%' and state='unknown' and elapsed_ended_at is null",[owner])).rows[0].count,100,'缺失原生日志的项目不伪造终态或释放未知预留')
 assert.equal(model.calls,1,'启动/轮转补核只读原日志，不重新执行模型')
 t.diagnostic('第二宿主启动和正式暂停收口已返回')
 assert.equal(cold.agents.get(SessionId(sessionId)),undefined)
 assert.equal(await restored.controls.stateForRun(owner,{runId:failed.id}),'paused','必须从真实冷读取收口宿主重启暂停')
 const state=await restored.controls.get(owner,{controlId:failed.lineage!.roundControlId});assert.equal(state.generation,2)
 // 完成历史不应被新增预检当作在途执行；原卡的一次 retry 身份仍由 handler 核对。
 await f.pool.query("insert into teloa_task_runs select (jsonb_populate_record(null::teloa_task_runs,to_jsonb(r)||jsonb_build_object('id',$2::text,'request_id',$3::text,'native_request_id',$4::text,'session_id',$5::text))).* from teloa_task_runs r where id=$1",[failed.id,randomUUID(),randomUUID(),randomUUID(),'history-'+randomUUID()])
 revoked=true;await assert.rejects(restored.prepareRetry(failed,new AbortController().signal));assert.equal(await restored.controls.stateForRun(owner,{runId:failed.id}),'paused')
 revoked=false;await f.pool.query("update teloa_roles set state='paused' where id=$1",[role.id]);await assert.rejects(restored.prepareRetry(failed,new AbortController().signal));assert.equal(await restored.controls.stateForRun(owner,{runId:failed.id}),'paused')
 await f.pool.query("update teloa_roles set state='active' where id=$1",[role.id])
 const pendingId=randomUUID()
 await f.pool.query("insert into teloa_task_runs select (jsonb_populate_record(null::teloa_task_runs,to_jsonb(r)||jsonb_build_object('id',$2::text,'request_id',$3::text,'native_request_id',$4::text,'session_id',$5::text,'state','prepared','evidence',null))).* from teloa_task_runs r where id=$1",[failed.id,pendingId,randomUUID(),randomUUID(),'pending-'+randomUUID()])
 await assert.rejects(restored.prepareRetry(failed,new AbortController().signal),{code:'teloa/conflict'});assert.equal(await restored.controls.stateForRun(owner,{runId:failed.id}),'paused')
 await f.pool.query("update teloa_task_runs set state='withdrawn' where id=$1",[pendingId])
 await f.pool.query("update teloa_work_budget_accounts set policy=$2 where id=$1",[failed.lineage!.budgetAccountId,JSON.stringify({...defaultWorkBudgetPolicy,maxTokens:1})])
 await assert.rejects(restored.prepareRetry(failed,new AbortController().signal),{code:'teloa/budget-exhausted',details:{reason:'tokens',scope:'work'}});assert.equal(await restored.controls.stateForRun(owner,{runId:failed.id}),'paused')
 await f.pool.query('update teloa_work_budget_accounts set policy=null where id=$1',[failed.lineage!.budgetAccountId])
 await restored.prepareRetry(failed,new AbortController().signal)
 assert.ok(seals>=3);assert.equal(await restored.controls.stateForRun(owner,{runId:failed.id}),'active')
 assert.equal((await restored.controls.get(owner,{controlId:state.id})).generation,3)
 assert.deepEqual(await runs.get(owner,{runId:failed.id}),failed);assert.deepEqual((await cold.sessionController.inspect(SessionId(sessionId))).events,before)
 assert.equal(cold.agents.get(SessionId(sessionId)),undefined);assert.equal(model.calls,1)
 const active=await restored.controls.get(owner,{controlId:state.id}),manual=await restored.controls.change(owner,{requestId:randomUUID(),controlId:state.id,expectedVersion:active.version,action:'pause',scope:'round',roundControlId:null})
 assert.notEqual(manual.state,'active');await assert.rejects(restored.prepareRetry(failed,new AbortController().signal),{code:'teloa/conflict'})
})
