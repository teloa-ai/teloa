import {createHash} from 'node:crypto'
import {TaskRunSubmissionService,ArtifactAvailabilityService} from '@teloa/backend'
import {NativeSessionContinuationJournal,initializeNativeSessionContinuations,type NativeSessionCheckpoint} from '@teloa/backend'
import {hasPreparedMaintenance} from '@teloa/backend'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import {foldGoal} from '@deepseek-ai/dsh-goal'
import {boundContextSummary} from '@deepseek-ai/dsh-llm'
import {finalAssistantOutput} from '@deepseek-ai/dsh-subagent'
import {WorkError,taskInput,readRetrievalSearchResult,groupRoutingAttemptRequestId,groupRoutingSessionId,type WorkControlChange} from '@teloa/contract'
import {ArtifactService,taskArtifactSource,taskArtifactSessions,GroupRoutingOutboxService,WorkLineageService,WorkControlService,WorkRecoveryService,WorkBudgetService,TaskRunGoalService,TaskRunRuntimeLinkService,TaskCompletionService,readStoredTask,WorkEventService,MarketContentStore,WorkProgressService,WorkRetryService,combineWorkAccessLeases,readTrustedGroupMessageRunSource,readCurrentGroupRoutingAttempt,readGroupRunAppendIds,RoleWorkEligibilityService,workAccess,type TaskRunService,type TaskRun,type OwnerWorkAuthority,type ResourceService,type RoleDailyLogService,type WorkAccessLease,type WorkResumeInput,type WorkRecoveryCheckpoint,type TaskExecutionScope,type ConversationService} from '@teloa/backend'
import {createTaskRunGoal} from './task-run-goal.ts'
import {createTaskCompletionVerifiers,systemDigestArtifactContent} from './task-completion-verifiers.ts'
import {WorkControlDriver} from './work-control-driver.ts'
import {WorkRecoveryCoordinator,controlledWorkRestore} from './work-recovery-coordinator.ts'
import {TaskRunDriver,type TaskRunPorts} from './task-run-driver.ts'
import {assertSafeTaskRunRetry} from './task-run-retry-proof.ts'
import {TaskRunSubagentService,TaskRunWebAccessService,roleWorkOutstanding} from '@teloa/backend'
import {nativeInputRecoveryCandidate,type NativeInputRecoveryCandidate} from './native-input-recovery-candidate.ts'
import {createNativeSessionManualContinuation} from './native-session-manual-continuation.ts'
import {createNativeSessionTaskContinuation} from './native-session-task-continuation.ts'
import {nativeInputIdentity} from './native-input-access.ts'
import {taskRunTeamContinuations,taskRunTeamRelayGrant,nativeRunContinuationKey} from './task-run-team-records.ts'
import {readSessionEvents} from './session-events.ts'
import {taskKnowledgeAuthorization} from './task-run-dsh.ts'
import {inspectNativeProgressRound} from './work-stagnation.ts'
import {drainGroupRoutingOutbox,drainGroupRoutingWakes,type GroupRoutingOutboxPorts} from './group-routing-outbox-driver.ts'
import type {TeloaNativeInput} from './native-input-provider.ts'
import {runBudgetTerminal,type ResidentRoutingBudget} from './resident-model-budget.ts'
import {isRoutingSession} from './group-routing.ts'
import {groupRoutingEmptyRetryRequestId,mayRetryEmptyGroupRouting} from './group-routing-result.ts'
import {observeTaskRun} from './task-run-observation.ts'
import type {NativeCheckpointSnapshot,NativeInputRestore,NativeInputRestoreInput,NativeInputRestoreLease,NativeInputCheckpointInput,NativeProgressCheckpointInput} from './native-input-checkpoint.ts'
import {taskRunOwnerSettlement} from './task-run-owner-settlement.ts'
import {taskRunRuntimeId as defaultTaskRunRuntimeId} from './task-run-background.ts'
import {plannedRestartResume} from './planned-restart-resume.ts'
import {taskRunQuiescentSettlement} from './task-run-quiescence.ts'
import {readDeliveryReviewCheckpoint} from './task-delivery-review.ts'

type Pool=TaskRunService['pool']
type Permit=Awaited<ReturnType<WorkRecoveryService['begin']>>
type RunDriverBinding={ports:TaskRunPorts;runtimeLinks:ConstructorParameters<typeof WorkControlDriver>[0]['runtimeLinks']}
export type ResidentWorkRuntimeOptions={
 runtimeId?:string
 interactiveAdmission?:(sessionId:string,continuation?:true)=>Promise<WorkAccessLease>
 completedInteraction?:(sessionId:string)=>Promise<{run:TaskRun;lease:WorkAccessLease}|null>
 manualInteractionAccepted?:(sessionId:string)=>void
 owner:string;pool:Pool;identity:{id:()=>string;now:()=>string};nativeInput:TeloaNativeInput['input'];ownerAuthority:OwnerWorkAuthority
 runs:()=>Promise<TaskRunService>;resources:ResourceService;dailyLogs:()=>Promise<RoleDailyLogService>
 executionScope:(db:Parameters<TaskRunService['readVerifiedInTransaction']>[0],owner:string,runId:string,mode:'active'|'completion')=>Promise<TaskExecutionScope>
 approval?:NonNullable<ConstructorParameters<typeof WorkEventService>[2]>['approval']
 business?:NonNullable<ConstructorParameters<typeof WorkEventService>[2]>['business']
 businessOrigin?:NonNullable<ConstructorParameters<typeof WorkEventService>[2]>['businessOrigin']
 verifyInitialMessage:(run:TaskRun,message:NativeInputRestoreInput['messages'][number],acceptedAt:number)=>Promise<boolean>
 ordinaryConversations?:Pick<ConversationService,'repository'>
 report:(code:string)=>void
 /** 本人升级命令交给新宿主的一次性计划重启回执；不能替代原生自动续作的独立持久证明。 */
 plannedRestartId?:string
}
export const residentOwnerEndpoints=['session-continuations/inspect','session-continuations/resume','work-controls/get','work-controls/change','work-recovery/inspect','work-recovery/resume','work-budgets/read','work-budgets/configure','work-budgets/owner/read','work-budgets/owner/configure','work-progress/get'] as const
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const requestId=(value:unknown)=>{const s=hash(value);return s.slice(0,8)+'-'+s.slice(8,12)+'-5'+s.slice(13,16)+'-a'+s.slice(17,20)+'-'+s.slice(20,32)}
const unavailable=()=>new WorkError('teloa/unavailable','当前宿主的受控工作端口尚未就绪。')

/** 只承接原执行范围已核验的授权；普通资料事件不使用此读取口。 */
export function readResidentRunKnowledge(resources:Pick<ResourceService,'executionKnowledgeInTransaction'>,db:Parameters<ResourceService['executionKnowledgeInTransaction']>[0],authorization:ReturnType<typeof taskKnowledgeAuthorization>,ids:readonly string[]){
 return resources.executionKnowledgeInTransaction(db,authorization.actor,authorization.targetScopes,ids,undefined,authorization.fixedKnowledgeRead)
}

/** 同一宿主共享持久服务和最终许可；启动/本人 RPC 的生命周期由 index 拥有。 */
export async function createResidentWorkRuntime(ctx:Context,options:ResidentWorkRuntimeOptions){
 const {owner,pool,identity,nativeInput,runs,resources,dailyLogs}=options
 const taskRunRuntimeId=options.runtimeId??defaultTaskRunRuntimeId
 if(typeof nativeInput?.withNewInput!=='function')throw unavailable()
 const assertOwner=(value:string)=>{if(value!==owner)throw new WorkError('teloa/forbidden','只能操作当前本人的工作。')}
 const progress=new WorkProgressService(pool,identity),lineage=new WorkLineageService(pool,identity),outbox=new GroupRoutingOutboxService(pool,identity),budgets=new WorkBudgetService(pool,identity,options.ownerAuthority,async(db,actor,proof)=>{
  assertOwner(actor)
  const rows=(await db.query("select record from teloa_native_session_continuations where owner_id=$1 and run_id=$2 and (record->>'state'='accepted' or record->'automaticAdmission'->'retirement' is not null) and (record->>'hostGeneration')::integer=$3",[owner,proof.runId,proof.hostGeneration])).rows
  const matches=rows.map(row=>continuations.read(row.record)).filter(r=>r.mode==='automatic'&&(r.automaticAdmission?.retirement?.endedAt??r.acceptedAt)===proof.endedAt&&r.checkpoint.runtimeId===proof.oldRuntimeId&&r.checkpoint.hostGeneration===proof.oldHostGeneration&&r.checkpoint.requestId===proof.nativeRequestId&&r.checkpoint.sessionId===proof.sessionId&&r.automaticAdmission&&proof.modelRequestIds.every(id=>r.automaticAdmission!.modelRequestIds.includes(id)))
  if(matches.length!==1)throw unavailable()
  const record=matches[0]!
  await assertAutomaticControls(db,record)
  if(record.automaticAdmission?.retirement){
   const r=record.automaticAdmission.retirement,fixed=await snapshot(record.checkpoint.sessionId),event=fixed.events[r.seq]
   if(!event||createHash('sha256').update(JSON.stringify(event)).digest('hex')!==r.eventSha256||new Date(event.time).toISOString()!==r.endedAt||createHash('sha256').update(JSON.stringify(fixed.events.slice(0,record.prefix.logCut+1))).digest('hex')!==record.prefix.logSha256)throw unavailable()
   if(r.boundary==='turn/end'?(event.type!=='turn/end'||event.data.reason.kind==='aborted'&&event.data.reason.reason.kind!=='disposed'):(r.seq!==record.checkpoint.logCut||!['claimed','step-end','model'].includes(record.checkpoint.phase)))throw unavailable()
  }else if(record.state!=='accepted')throw unavailable()
  const exact=(await db.query('select model_request_id from teloa_work_budget_reservations where owner_id=$1 and control_generation=$2 and model_request_id=any($3::text[]) order by model_request_id',[owner,proof.controlGeneration,record.automaticAdmission!.modelRequestIds])).rows.map(row=>row.model_request_id)
  if(hash(exact)!==hash([...proof.modelRequestIds].sort()))throw unavailable()
  return Object.freeze({assertCurrent:()=>{if(closed||generation!==proof.hostGeneration)throw unavailable()}})
 })
 const prior=(await pool.query('select generation from teloa_work_control_hosts where owner_id=$1',[owner])).rows[0]
 const generation=Number(prior?.generation??0)+1
 await initializeNativeSessionContinuations(pool)
 const continuations=new NativeSessionContinuationJournal(pool,identity)
 let binding:RunDriverBinding|undefined,controlDriver:WorkControlDriver|undefined,closed=false
 let automaticContinuation:ReturnType<typeof createNativeSessionTaskContinuation>|undefined
 const restartProtectedRuns=new Set<string>()
 const restartProtectionCurrent=async(runId:string)=>restartProtectedRuns.has(runId)&&(await pool.query("select 1 from teloa_work_controls c join teloa_task_work_lineage l on l.owner_id=c.owner_id and (l.round_control_id=c.id or l.definition_control_id=c.id) join teloa_task_runs r on r.owner_id=l.owner_id and r.task_id=l.task_id where r.owner_id=$1 and r.id=$2 and c.id=any($3::uuid[]) and c.pause_origin='restart' and c.state in ('pausing','paused') and c.generation=any($4::integer[])",[owner,runId,restarted.map(c=>c.id),restarted.map(c=>c.generation)])).rowCount!==0
 const attached=()=>{if(closed||!binding)throw unavailable();return binding}
 const driver=async()=>new TaskRunDriver(await runs(),attached().ports)
 const authority={authorize:async(value:string,request:Readonly<{requestId:string;controlId:string}>)=>{assertOwner(value);return options.ownerAuthority.authorize(value,{requestId:request.requestId,roleId:request.controlId,operation:'resume'})}}
 const zeroWorkFailure=async(run:TaskRun,signal:AbortSignal)=>{
  const [children,web]=await Promise.all([new TaskRunSubagentService(pool,identity).listMany(owner,[run.id]),new TaskRunWebAccessService(pool,identity).listMany(owner,[run.id])])
  await assertSafeTaskRunRetry(run,attached().ports,signal,{subagents:children.get(run.id)??[],webAccess:web.get(run.id)??[]})
 }
 /**
  * 已结束 Run 的持久终态结算：复用委托收口同一判据（`roleWorkOutstanding`：原任务全部 Run 已终态、子工作/流程收口、runtime link 回执或宿主结算成立、
  * 群交付与安全效果无残留）。不读原生会话、不改库、不把模型完成当业务质检通过；任一判据不成立即 false，由调用方保持待核对。
  */
 const terminalRunSettled=async(run:TaskRun):Promise<boolean>=>{
  if(run.state!=='ended'||run.evidence?.state!=='ended')return false
  const db=await pool.connect()
  try{
   await db.query('begin')
   // 与 prepare/claim/record 的「run 锁 → task 锁」次序兼容：这里只取任务行共享锁作串行点，不再取 run 锁。
   await db.query('select 1 from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,run.taskId])
   const outstanding=await roleWorkOutstanding(db,owner,run.roleId??'',{taskId:run.taskId})
   await db.query('commit');return !outstanding
  }catch(error){await db.query('rollback').catch(()=>{});if(error instanceof WorkError)return false;throw error}
  finally{db.release()}
 }
 const quiescentRunSettled=async(run:TaskRun)=>taskRunQuiescentSettlement(ctx,owner,run,{pool,readRun:async(db,actor,id)=>(await runs()).readVerifiedInTransaction(db,actor,id)},new AbortController().signal)
 const controls=new WorkControlService(pool,identity,{hostGeneration:()=>generation,ownerAuthority:authority,inspectRun:async(value,input)=>{
  assertOwner(value);if(!controlDriver)throw unavailable()
  if(await restartProtectionCurrent(input.runId))return {settled:true,unknownOperationIds:[]}
  let proof=await controlDriver.inspectRun(value,input).catch(()=>({settled:false,unknownOperationIds:[] as string[]}))
  // 完整官方零副作用失败证明可收口暂停；不把冷 idle 或 owner 本身当完成证据。
  if(!proof.settled)try{await zeroWorkFailure(await(await runs()).get(value,{runId:input.runId}),new AbortController().signal);proof={settled:true,unknownOperationIds:[]}}catch{}
  const operations=(await pool.query("select e.operation_id,e.state from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id join teloa_task_runs r on r.owner_id=a.owner_id and r.task_id=a.task_id where r.owner_id=$1 and r.id=$2 and e.state not in ('succeeded','failed')",[value,input.runId])).rows
  return {settled:proof.settled&&operations.length===0,unknownOperationIds:[...proof.unknownOperationIds,...operations.filter(row=>row.state==='dispatching'||row.state==='effect_unknown').map(row=>'security:'+row.operation_id)]}
 }})
 const restarted=await controls.disarmForRestart(owner,{hostGeneration:generation})
 // 上一代宿主认领后未做完的自动恢复不再续做，只提示本人在原入口手动恢复。
 const abandoned=await controls.abandonPlannedRestarts(owner,{hostGeneration:generation}).catch(()=>[] as string[])
 if(abandoned.length)options.report('teloa/planned-restart-incomplete:'+abandoned.join(','))
 const planned=options.plannedRestartId!==undefined&&await controls.claimPlannedRestart(owner,{restartId:options.plannedRestartId,hostGeneration:generation,controlIds:restarted.map(control=>control.id)}).catch(error=>{options.report(error instanceof WorkError?error.code:'teloa/unavailable');return false})
 const snapshot=async(sessionId:string):Promise<NativeCheckpointSnapshot>=>{
  const agent=ctx.agents.get(SessionId(sessionId))
  if(agent){if(!await ctx.sessions.flush(agent.session))throw unavailable();return {header:agent.session.header,events:[...readSessionEvents(agent.session)],inheritedEventCount:Number(agent.session.inheritedEventCount)}}
  const handle=await ctx.sessionPersistence.open(SessionId(sessionId),'read')
  try{return {header:handle.header,events:(await handle.read()).events,inheritedEventCount:Number(handle.inheritedEventCount)}}finally{await handle.close()}
 }
 const settleRunBudget=async(run:TaskRun)=>{
  if(run.state!=='ended'||run.evidence?.state!=='ended')return
  const fixed=await snapshot(run.sessionId),proof=runBudgetTerminal(run,{sessionId:fixed.header.id,events:fixed.events,inheritedEventCount:fixed.inheritedEventCount})
  if(proof)await budgets.recordRunTerminal(owner,proof)
 }
 const settleRunOwner=async(run:TaskRun)=>{
  if(closed||!binding||run.state!=='ended')return
  const proof=await taskRunOwnerSettlement(ctx,run,{runtimeId:taskRunRuntimeId,ports:binding.ports,listLinks:()=>binding!.runtimeLinks.list(owner,{runId:run.id}),nativeInput,now:identity.now})
  if(proof)await new TaskRunRuntimeLinkService(pool).recordOwnerSettlement(owner,proof)
 }
 let ownerScanAfter:{createdAt:string;id:string}|undefined
 const reconcileOwnerSettlements=async(signal:AbortSignal)=>{
  if(closed||!binding)return
  // 仅原存活宿主补写漏回调；新宿主不以空 jobs 表替旧进程的未知工作作证。
  const rows=(await pool.query(`select distinct r.id,r.created_at from teloa_task_runs r join teloa_task_run_runtime_links l on l.owner_id=r.owner_id and l.run_id=r.id where r.owner_id=$1 and r.state='ended' and l.kind='job' and l.payload->>'record'='owner' and l.payload->>'runtimeId'=$2 and l.owner_settlement is null and ($3::timestamptz is null or (r.created_at,r.id)>($3::timestamptz,$4::uuid)) order by r.created_at,r.id limit 100`,[owner,taskRunRuntimeId,ownerScanAfter?.createdAt??null,ownerScanAfter?.id??null])).rows
  for(const row of rows){signal.throwIfAborted();try{await settleRunOwner(await(await runs()).get(owner,{runId:row.id}))}catch(error){options.report(error instanceof WorkError?error.code:'teloa/unavailable')}ownerScanAfter={createdAt:row.created_at.toISOString(),id:row.id}}
  if(rows.length<100)ownerScanAfter=undefined
 }
 let budgetScanAfter:{createdAt:string;id:string}|undefined
 const reconcileRunBudgets=async(signal:AbortSignal)=>{
  // 正常回调前宿主退出时，只补原已结束 Run 的未知用量时钟；不恢复执行或释放预留。
  // 每轮最多100项，失败也前移；读至尾部后下一轮重查，缺失日志不能饿死后续可信终态。
  const rows=(await pool.query(`select distinct r.id,r.created_at from teloa_work_budget_reservations b join teloa_work_retry_claims c on c.owner_id=b.owner_id and c.model_request_id=b.model_request_id join teloa_work_retries retry on retry.owner_id=c.owner_id and retry.operation_id=c.operation_id join teloa_task_runs r on r.owner_id=retry.owner_id and r.id=retry.run_id where b.owner_id=$1 and b.state='unknown' and b.elapsed_terminal is null and r.state='ended' and ($2::timestamptz is null or (r.created_at,r.id)>($2::timestamptz,$3::uuid)) order by r.created_at,r.id limit 100`,[owner,budgetScanAfter?.createdAt??null,budgetScanAfter?.id??null])).rows
  for(const row of rows){signal.throwIfAborted();try{await settleRunBudget(await(await runs()).get(owner,{runId:row.id}))}catch(error){options.report(error instanceof WorkError?error.code:'teloa/unavailable')}budgetScanAfter={createdAt:row.created_at.toISOString(),id:row.id}}
  if(rows.length<100)budgetScanAfter=undefined
 }
 let manualContinuation:ReturnType<typeof createNativeSessionManualContinuation>|undefined
 const invalidateOrdinaryRestore=(sessionId:string)=>{if(typeof sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(sessionId))throw unavailable();manualContinuation?.invalidate(sessionId)}
 const inboxFor=(value:NativeCheckpointSnapshot)=>ctx.sessionProjections.stateOf(Session.create(SessionId(value.header.id),value.events,value.header,SessionLogOffset(value.inheritedEventCount)),'inbox')
 const inspectCheckpoint=async(value:string,input:{runId:string;sessionId:string;nativeRequestId:string},db?:Parameters<TaskRunService['readVerifiedInTransaction']>[0],verifiedRun?:TaskRun):Promise<WorkRecoveryCheckpoint>=>{
  assertOwner(value);const fixed=await snapshot(input.sessionId),inbox=inboxFor(fixed),unknown:string[]=[],client=db??await pool.connect()
  try{
  // 来源任务恢复已在任务锁下核验原终态，复用该快照而不反向等待执行行锁。
  const run=verifiedRun??await(await runs()).readVerifiedInTransaction(client,owner,input.runId)
  if(run.id!==input.runId||run.sessionId!==input.sessionId||run.nativeRequestId!==input.nativeRequestId)throw unavailable()
  const accepted=fixed.events.some(event=>event.seq>=fixed.inheritedEventCount&&((event.type==='user/message'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===input.nativeRequestId)||(event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.source.kind==='user'&&Reflect.get(message.source,'rpcId')===input.nativeRequestId))))
  if(!inbox)unknown.push('checkpoint:inbox-unavailable')
  const pending=!!inbox&&(inbox['next-turn'].length>0||inbox['next-step'].length>0)
  if(pending&&!nativeInputRecoveryCandidate({snapshot:fixed,inbox}))unknown.push('checkpoint:roots-unverified')
  const last=[...fixed.events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  if(last?.type==='turn/start')unknown.push('checkpoint:unfinished-turn')
  for(const link of await new TaskRunRuntimeLinkService(pool).listInTransaction(client,owner,{runId:run.id})){if(link.kind==='browser'&&link.payload.status==='dirty')unknown.push('browser:'+link.payload.dispatchId);if(link.kind==='job'&&link.payload.record==='job'&&['running','stopping'].includes(link.payload.status))unknown.push('job:'+link.nativeId);if(link.kind==='external'&&['reserved','running','stopping','unknown'].includes(link.payload.status))unknown.push('external:'+link.payload.provider+':'+link.payload.reservationId)}
  const external=(await client.query("select e.operation_id from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where e.owner_id=$1 and a.task_id=$2 and e.state not in ('succeeded','failed')",[value,run.taskId])).rows;unknown.push(...external.map(row=>'security:'+row.operation_id))
  return {reason:unknown.length||!accepted&&run.state!=='prepared'?'unknown':accepted?'accepted':'unaccepted',checkpointSha256:hash(fixed),hasPendingInput:pending,unknownOperationIds:unknown}
  }finally{if(!db)client.release()}
 }
 const recovery=new WorkRecoveryService(pool,identity,controls,{resumeSourceTask:async(db,value,{task,control},approval)=>{assertOwner(value);return(await runs()).resumeSourceTaskInTransaction(db,value,task,control,approval,async run=>{const current=await inspectCheckpoint(value,{runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId},db,run);if(current.reason!=='accepted'||current.hasPendingInput||current.unknownOperationIds.length)throw new WorkError('teloa/execution-pending','原会话仍有待办或未知受理，请先核对。')})},hostGeneration:()=>generation,ownerAuthority:authority,inspectCheckpoint,authorizeResume:async(db,value,{candidate})=>{assertOwner(value);const run=await(await runs()).readVerifiedInTransaction(db,value,candidate.runId);if(!run.lineage)throw unavailable();const budget=await budgets.admissionInTransaction(db,value,run.lineage.budgetAccountId);if(!await hasPreparedMaintenance(db,value,run.id))return budget;return combineWorkAccessLeases([budget,await(await runs()).preparedMaintenanceResumeAdmissionInTransaction(db,value,run.id)])}})
 let goal:ReturnType<typeof createTaskRunGoal>
 const goals=new TaskRunGoalService(pool,identity,{hostGeneration:()=>generation,inspectGoal:async sessionId=>{const agent=ctx.agents.get(SessionId(sessionId));if(!agent)return null;const g=ctx.goals.get(agent);return g?{goalId:g.id,revision:g.revision,phase:g.phase,activation:g.activation,roundsStarted:g.roundsStarted,maxGoalRounds:g.maxGoalRounds}:null},admitRound:async(db,value,{binding:fixed,round})=>{
  assertOwner(value);const row=(await db.query('select task_id from teloa_task_runs where owner_id=$1 and id=$2',[value,fixed.runId])).rows[0],source=row&&await lineage.readInTransaction(db,value,{taskId:row.task_id})
  if(!source||source.roundControlId!==fixed.controlId)throw unavailable()
  const control=await controls.acquireForRun(value,{runId:fixed.runId,expectedGeneration:fixed.controlGeneration,mode:'new-input'},db),reservation=await budgets.reserveInTransaction(db,value,{budgetAccountId:source.budgetAccountId,controlGeneration:fixed.controlGeneration,modelRequestId:'goal-round:'+hash([fixed.runId,fixed.goalId,fixed.revision,round]),kind:'goal',tokens:0,rounds:1})
  return combineWorkAccessLeases([control.lease,budgets.lease(value,reservation)])
 }})
 const retries=new WorkRetryService(pool,identity,{controls,inspectProgressRound:async(value,round)=>{
  assertOwner(value);const run=await(await runs()).get(value,{runId:round.runId}),fixed=await snapshot(run.sessionId),state=await goal.observation(run,fixed.events),receipt=state?.continuations.find(r=>r.goalId===round.goalId&&r.revision===round.revision&&r.round===round.round)
  if(!state||!receipt)return {completed:false,evidence:[]}
  return inspectNativeProgressRound(run,receipt,fixed.events,state,async events=>{
   // 只消费同轮真实成功检索回执；稳定资料版本事实不会因 query/call ID 变化重复计为进展。
   const evidence=[]
   for(const event of events){
    if(event.type!=='tool/result'||event.data.message.isError)continue
    const call=events.find(item=>item.type==='tool/call'&&item.data.callId===event.data.message.toolCallId)
    if(call?.type!=='tool/call'||call.data.name!=='teloa_knowledge_search')continue
    const text=event.data.message.content.filter(part=>part.type==='text').map(part=>part.text).join('')
    let result:ReturnType<typeof readRetrievalSearchResult>;try{result=readRetrievalSearchResult(JSON.parse(text))}catch{continue}
    if(!result.results.length)continue
    const db=await pool.connect()
    try{
     await db.query('begin isolation level repeatable read')
     const target=await options.executionScope(db,value,run.id,'active'),auth=taskKnowledgeAuthorization(value,target,run.roleSnapshot?.scopes)
     const ids=[...new Set(result.results.map(hit=>hit.resourceId))]
     if(auth.knowledgeIds!==undefined&&auth.knowledgeIds!==null&&ids.some(id=>!auth.knowledgeIds!.includes(id)))continue
     const current=await readResidentRunKnowledge(resources,db,auth,ids)
     if(result.results.some(hit=>!current.some(row=>row.id===hit.resourceId&&row.version===hit.resourceVersion&&row.sourceId===hit.sourceId&&row.sourceVersion===hit.sourceVersion)))continue
     const facts=current.map(row=>[row.id,row.version,row.sourceId,row.sourceVersion]).sort((a,b)=>String(a[0]).localeCompare(String(b[0])))
     for(const fact of facts)evidence.push({runId:run.id,seq:Number(event.seq),kind:'tool-receipt' as const,referenceId:hash(fact)})
     await db.query('commit')
    }finally{await db.query('rollback').catch(()=>{});db.release()}
   }
   return evidence
  },await attached().ports.continuations?.(run,fixed.events))
 }})
 goal=createTaskRunGoal(ctx,goals,owner,{nativeInput,hostGeneration:()=>generation,foldGoal,requireStagnation:true,stagnation:{readStagnation:input=>retries.readStagnation(owner,input),recordProgressRound:input=>retries.recordProgressRound(owner,input),consumeStagnationAllowance:input=>retries.consumeStagnationAllowance(owner,input)}})
 const recoveringInputs=new Map<string,WorkAccessLease>()
 const recoveryRequests=new Map<string,string>()
 const recovering=new Map<string,{runId:string;permit:Permit}>()
 const authorizeRestoreRoots=async(input:NativeInputRestoreInput,candidate:NativeInputRecoveryCandidate):Promise<NativeInputRestoreLease>=>{
  input.signal.throwIfAborted()
  const entry=recovering.get(input.sessionId),actual=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox:inboxFor(input.snapshot)})
  if(!entry&&automaticContinuation?.admission(input.sessionId))return automaticContinuation.restore(input)
  if(closed||input.snapshot.header.id!==input.sessionId||!actual||hash(actual)!==hash(candidate)||hash(actual.messages)!==hash(input.messages))throw unavailable()
  if(!entry){
   if(!manualContinuation)throw unavailable()
   const proof=await manualContinuation.restore(input)
   if(hash(proof.roots)!==hash(actual.roots))throw unavailable()
   return proof
  }
  if(entry.permit.candidate.reason!=='accepted'||entry.permit.checkpointSha256!==hash(input.snapshot))throw unavailable()
  entry.permit.lease.assertCurrent()
  const run=await(await runs()).get(owner,{runId:entry.runId})
  if(run.sessionId!==input.sessionId||!run.lineage||run.lineage.ownerId!==owner)throw unavailable()
  const role=await(await runs()).executionAdmission(owner,run.id),control=(await controls.acquireForRun(owner,{runId:run.id,mode:'continuation'})).lease
  const registered=await new TaskRunRuntimeLinkService(pool).list(owner,{runId:run.id,kind:'team'})
  const grants=registered.filter(row=>row.kind==='team')
  if(grants.some(row=>row.runId!==run.id||row.sessionId!==run.sessionId||row.payload.requestId!==run.nativeRequestId))throw unavailable()
  const team=taskRunTeamContinuations(input.snapshot.events,grants),stored=await goals.read(owner,{runId:run.id})
  for(let i=0;i<actual.messages.length;i++){
   const message=actual.messages[i]!,root=actual.roots[i]!,accepted=actual.acceptedEvents[i]!,source=message.source
   if(root.sessionId!==run.sessionId||nativeInputIdentity(message,root.nativeRequestId??undefined).payloadSha256!==root.payloadSha256)throw unavailable()
   if(source.kind==='user'){
    const rpcId=Reflect.get(source,'rpcId')
    // 本人在原群对活动 Run 的追加：只认宿主为本 Run 会话持久登记过的同一原生请求身份，不凭消息正文或来源猜测。
    const appended=rpcId!==run.nativeRequestId&&typeof rpcId==='string'&&root.nativeRequestId===rpcId&&(await readGroupRunAppendIds(pool,owner,run.sessionId)).includes(rpcId)
    if(Object.keys(source).some(key=>!['kind','rpcId'].includes(key))||!appended&&(rpcId!==run.nativeRequestId||root.nativeRequestId!==run.nativeRequestId||!await options.verifyInitialMessage(run,message,accepted.time)))throw unavailable()
   }else if(source.kind==='goal'){
    const matches=stored.continuations.filter(receipt=>receipt.state==='accepted'&&receipt.ownerId===owner&&receipt.runId===run.id&&receipt.sessionId===run.sessionId&&receipt.controlId===run.lineage!.roundControlId&&receipt.messageId===message.id&&receipt.goalId===source.goalId&&receipt.revision===source.revision&&receipt.round===source.round&&receipt.payloadSha256===root.payloadSha256&&receipt.acceptedSeq===accepted.seq)
    if(!stored.binding||Object.keys(source).some(key=>!['kind','goalId','revision','round'].includes(key))||root.nativeRequestId!==null||matches.length!==1)throw unavailable()
   }else if(source.kind==='agent-message'){
    if(Object.keys(source).some(key=>!['kind','form','senderSessionId'].includes(key))||source.form!=='relay'||root.nativeRequestId!==null||!team.has(JSON.stringify(['agent-message',source.senderSessionId,message.id])))throw unavailable()
    const grant=taskRunTeamRelayGrant(input.snapshot.events,grants,source.senderSessionId,accepted.seq)
    const children=(await pool.query('select reservation_id from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and child_session_id=$3',[owner,run.id,source.senderSessionId])).rows
    if(!grant||children.length!==1||grant.payload.reservationId!==children[0].reservation_id||hash(message.content[0])!==hash({type:'text',text:`Team message from ${grant.payload.name}:`}))throw unavailable()
    const child=await snapshot(source.senderSessionId)
    if(child.header.parentSession!==run.sessionId)throw unavailable()
   }else if(source.kind==='team-message'){
    if(Object.keys(source).some(key=>!['kind','teamId','messageId','senderId','senderName'].includes(key))||source.teamId!==run.sessionId||root.nativeRequestId!==null||!team.has(JSON.stringify([source.teamId,source.messageId,source.senderId,source.senderName])))throw unavailable()
    const queued=input.snapshot.events.filter(event=>event.seq<accepted.seq&&event.type==='team/message/queued'&&event.data.teamId===source.teamId&&event.data.message.id===source.messageId)
    if(queued.length!==1||queued[0]!.type!=='team/message/queued')throw unavailable()
    const original=queued[0]!.data.message
    if(original.targetId!==run.sessionId||original.senderId!==source.senderId||original.senderName!==source.senderName||hash(message.content)!==hash([{type:'text',text:`Team message ${original.id} from ${original.senderName}:`},...original.content]))throw unavailable()
    const children=(await pool.query('select reservation_id from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and child_session_id=$3',[owner,run.id,source.senderId])).rows
    if(children.length!==1||!grants.some(grant=>grant.payload.reservationId===children[0].reservation_id&&grant.payload.name===source.senderName))throw unavailable()
   }else if(source.kind==='subagent-settled'){
    if(Object.keys(source).some(key=>!['kind','form','summary','senderSessionId'].includes(key))||source.form!=='notice'||root.nativeRequestId!==null)throw unavailable()
    const rows=(await pool.query("select reservation_id,stop_reason from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and child_session_id=$3 and state='ended'",[owner,run.id,source.senderSessionId])).rows
    if(rows.length!==1)throw unavailable()
    const child=await snapshot(source.senderSessionId),own=child.events.slice(child.inheritedEventCount),end=[...own].reverse().find(event=>event.type==='turn/end')
    if(child.header.parentSession!==run.sessionId||end?.type!=='turn/end'||end.data.reason.kind!==rows[0].stop_reason)throw unavailable()
    const subject=`Background subagent ${source.senderSessionId}`,reason=rows[0].stop_reason as string
    const summary=reason==='completed'?`${subject} finished and will do no further work unless you send it more.`:reason==='aborted'?`${subject} was stopped before it finished.`:reason==='max-tokens'?`${subject} ran out of room before it finished.`:reason==='refusal'?`${subject} declined the task.`:reason==='error'?`${subject} failed before it finished.`:`${subject} ended abnormally (${reason}) before it finished.`
    const output=(finalAssistantOutput(own)??[]).filter(block=>block.type==='text'&&block.text.length>0)
    const content=[{type:'text',text:summary},...(output.length?[{type:'text',text:'Its closing message:'},...output]:[{type:'text',text:'It left no closing message.'}])]
    if(source.summary!==boundContextSummary(summary)||hash(message.content)!==hash(content))throw unavailable()
   }else throw unavailable()
  }
  const lease=combineWorkAccessLeases([entry.permit.lease,role,control]),roots=Object.freeze(actual.roots.map(root=>Object.freeze({...root})))
  lease.assertCurrent();input.signal.throwIfAborted()
  return Object.freeze({roots,assertCurrent:()=>{input.signal.throwIfAborted();if(closed||recovering.get(input.sessionId)!==entry||entry.permit.checkpointSha256!==hash(input.snapshot))throw unavailable();lease.assertCurrent();return undefined}})
 }
 const restore=async(input:NativeInputRestoreInput,base:NativeInputRestore):Promise<NativeInputRestoreLease>=>{
  if(automaticContinuation?.admission(input.sessionId))return automaticContinuation.restore(input)
  const entry=recovering.get(input.sessionId);if(!entry){
   if(closed||!manualContinuation)throw unavailable()
   const candidate=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox:inboxFor(input.snapshot)});if(!candidate)throw unavailable()
   const proof=await authorizeRestoreRoots(input,candidate),restored=await base(input)
   if(!restored||hash(restored.roots)!==hash(proof.roots)||typeof restored.assertCurrent!=='function')throw unavailable()
   const lease=combineWorkAccessLeases([proof,restored]);lease.assertCurrent()
   return Object.freeze({roots:proof.roots,assertCurrent:()=>{input.signal.throwIfAborted();lease.assertCurrent();return undefined}})
  }
  if(entry.permit.checkpointSha256!==hash(input.snapshot))throw new WorkError('teloa/forbidden','本检查点没有当前本人恢复票据。')
  entry.permit.lease.assertCurrent();const run=await(await runs()).get(owner,{runId:entry.runId}),candidate=nativeInputRecoveryCandidate({snapshot:input.snapshot,inbox:inboxFor(input.snapshot)})
  if(!candidate||hash(candidate.messages)!==hash(input.messages)||run.sessionId!==input.sessionId)throw unavailable()
  return controlledWorkRestore(base,async()=>({permit:entry.permit,sessionId:input.sessionId}),current=>hash(current.snapshot))(input)

 }
 const coordinator=new WorkRecoveryCoordinator({service:{resume:recovery.resume.bind(recovery),record:recovery.record.bind(recovery),begin:async(value,input)=>{assertOwner(value);const permit=await recovery.begin(value,input);recoveryRequests.set(input.runId,input.requestId);return permit}},runs:{get:async(value,input)=>{assertOwner(value);return(await runs()).get(value,input)}},startUnaccepted:async(value,input,signal)=>{assertOwner(value);input.lease.assertCurrent();const run=await(await runs()).get(value,{runId:input.runId});recoveringInputs.set(run.sessionId,input.lease);try{await(await driver()).start(value,{runId:input.runId},signal)}finally{recoveringInputs.delete(run.sessionId)}},restoreAccepted:async(value,input,signal)=>{
  assertOwner(value);recovering.set(input.sessionId,{runId:input.runId,permit:input.permit});signal.throwIfAborted()
  const agent=await ctx.sessionController.resolveAgent(SessionId(input.sessionId));if('error'in agent)throw unavailable();input.permit.lease.assertCurrent()
 },resumeGoal:async(value,input,signal)=>{assertOwner(value);signal.throwIfAborted();const run=await(await runs()).get(value,{runId:input.runId}),request=recoveryRequests.get(input.runId);if(input.permit.candidate.goal){if(!request||!run.lineage)throw unavailable();const round=await controls.get(value,{controlId:run.lineage.roundControlId});await retries.acknowledgeStagnation(value,{requestId:request,runId:run.id,goalId:input.permit.candidate.goal.goalId,controlGeneration:round.generation})}await goal.resume(run,input.permit.lease)}})
 const resumePlanned=planned?plannedRestartResume(owner,options.plannedRestartId!,restarted,{controls,inspect:(value,input)=>recovery.inspect(value,input),resume:(value,input,signal,plannedRestart)=>coordinator.resume(value,input,signal,plannedRestart),report:options.report}):async()=>{}
 const artifacts=new ArtifactService(pool,identity,async(value,expected,db)=>{assertOwner(value);if(expected.kind!=='task')throw unavailable();return {source:await taskArtifactSource(db,value,expected.id,true),sessionIds:await taskArtifactSessions(db,value,expected.id,true)}})
 const verifiers=createTaskCompletionVerifiers({digest:async input=>(await dailyLogs()).completeEvidenceInTransaction(input.db,input.ownerId,input.run.id),saveDigestArtifact:async(input,evidence)=>{const saved=await artifacts.createInTransaction(input.db,input.ownerId,{requestId:requestId(['daily-digest-artifact',input.ownerId,input.run.id]),source:await taskArtifactSource(input.db,input.ownerId,input.task.id,true),content:systemDigestArtifactContent(input.task.title,evidence.log)});return {id:saved.artifactId,version:saved.number}},material:async(input,source)=>{
  const target=await options.executionScope(input.db,input.ownerId,input.run.id,'completion'),auth=taskKnowledgeAuthorization(input.ownerId,target,input.run.roleSnapshot?.scopes)
  if(auth.knowledgeIds!==undefined&&auth.knowledgeIds!==null&&!auth.knowledgeIds.includes(source.resourceId))throw unavailable()
  const current=(await readResidentRunKnowledge(resources,input.db,auth,[source.resourceId]))[0];if(!current)throw unavailable();return current
 },saveMaterialSummaryArtifact:async(input,delivery)=>({receiptId:delivery.requestId,artifact:await artifacts.createInTransaction(input.db,input.ownerId,{requestId:delivery.requestId,source:await taskArtifactSource(input.db,input.ownerId,input.task.id,true),content:delivery.content})})})
 const settleRun=async(value:string,run:TaskRun)=>{
  assertOwner(value);try{await settleRunOwner(run)}catch(error){options.report(error instanceof WorkError?error.code:'teloa/unavailable')}await settleRunBudget(run);if(run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||!binding)return
  const row=(await pool.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,run.taskId])).rows[0];if(!row)throw unavailable();const task=readStoredTask(row);if(task.completionPolicy?.kind!=='verified'||task.state!=='waiting')return
  const ports=attached().ports,events=await ports.events(run),observedGoal=await ports.goalObservation?.(run,events),background=await ports.backgroundState?.(run),children=await ports.subagentState?.(run,new AbortController().signal)
  const service=new TaskCompletionService(pool,identity,{readRun:(db,actor,id)=>runs().then(api=>api.readVerifiedInTransaction(db,actor,id)),readLineage:(db,actor,id)=>lineage.readInTransaction(db,actor,{taskId:id}),verifiers,settlement:async(db,actor,current)=>{
   const pending=(await db.query("select id from teloa_security_actions where owner_id=$1 and task_id=$2 and state not in ('succeeded','rejected','withdrawn','failed') limit 1",[actor,current.taskId])).rows.length
   const descendants=(await db.query("select r.id from teloa_task_runs r join teloa_task_work_lineage l on l.owner_id=r.owner_id and l.task_id=r.task_id where r.owner_id=$1 and l.root_task_id=$2 and r.id<>$3 and r.state not in ('ended','withdrawn','configuration_failed') limit 1",[actor,current.lineage?.rootTaskId,current.id])).rows.length
   const flow=(await db.query('select state from teloa_task_run_flows where owner_id=$1 and run_id=$2',[actor,current.id])).rows[0]
   const verified=(!flow||['completed','compensated'].includes(flow.state))&&!pending&&!descendants&&background?.outstanding!==true&&background?.ownerOnly!==true&&children==='none'&&(!observedGoal||observedGoal.goalPhase==='complete'&&!observedGoal.pendingRound)
   return {verified,reason:verified?null:'work-unsettled'}
  }})
  await service.complete(owner,{requestId:requestId(['verified-completion',owner,run.id]),taskId:task.id,expectedVersion:task.version,candidate:{runId:run.id,terminalEventSeq:run.evidence.endSeq,receiptIds:[],artifactIds:[]}})
  await progress.recordRunProgress(value,run.id)
 }
 const events=new WorkEventService(pool,identity,{material:async(db,value,resourceId)=>{assertOwner(value);const row=(await db.query('select spec from teloa_resources where owner_id=$1 and id=$2',[value,resourceId])).rows[0];if(!row||!Array.isArray(row.spec.scopeIds))throw unavailable();const scopes=row.spec.scopeIds as string[],current=(await resources.executionKnowledgeInTransaction(db,{ownerId:value,kind:'agent',scopeIds:scopes},scopes,[resourceId]))[0];if(!current)throw unavailable();return {sourceVersion:current.sourceVersion,contentSha256:createHash('sha256').update(current.text).digest('hex')}},...(options.approval?{approval:options.approval}:{}),...(options.business?{business:options.business}:{}),...(options.businessOrigin?{businessOrigin:options.businessOrigin}:{})},new MarketContentStore(pool,identity))
 const routingInputs=new Map<string,ResidentRoutingBudget>()
 const bindRouting=async(input:{sessionId:string;day:string;groupId:string;messageId:string;nativeRequestId:string;artifactMessageIds?:readonly string[]}):Promise<()=>void>=>{
  if(closed||!/^\d{4}-\d{2}-\d{2}$/.test(input.day)||input.sessionId!==groupRoutingSessionId(owner,input.groupId,input.day)||routingInputs.has(input.sessionId))throw unavailable()
  const db=await pool.connect()
  try{
   await db.query('begin')
   const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2',[owner,input.groupId])).rows[0],message=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,input.groupId,input.messageId])).rows[0]
   if(!group||group.archived||!message)throw unavailable()
   // 原生请求身份必须对应本消息当前仍待定案的那一次尝试：第一尝试沿原公式，重试使用带尝试版本的身份。
   const attempt=await readCurrentGroupRoutingAttempt(db,owner,input.messageId)
   const primaryId=groupRoutingAttemptRequestId(owner,input.groupId,input.messageId,attempt.attemptVersion)
   if(attempt.decision!==null)throw unavailable()
   if(input.nativeRequestId!==primaryId){
    const agent=ctx.agents.get(SessionId(input.sessionId)),history=agent?readSessionEvents(agent.session):[],observed=observeTaskRun(history,primaryId)
    if(input.nativeRequestId!==groupRoutingEmptyRetryRequestId(primaryId)||observed.state!=='ended'||!mayRetryEmptyGroupRouting(history,primaryId,observed.turn))throw unavailable()
   }
   const source=await readTrustedGroupMessageRunSource(db,owner,{groupId:input.groupId,messageId:input.messageId}),leases:WorkAccessLease[]=[]
   let budgetAccountId:string|null=null,controlGeneration=1
   if(message.author_id==='self'){
    if(source||message.run_id!==null||message.task_id!==null)throw unavailable()
    const locked=(await db.query('select archived from teloa_groups where owner_id=$1 and id=$2 for share',[owner,input.groupId])).rows[0];if(!locked||locked.archived)throw unavailable()
    leases.push(await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:input.sessionId,objectId:input.groupId,operation:'run'}))
   }else{
    if(!source)throw new WorkError('teloa/conflict','历史角色消息没有可信工作来源，不能自动接力。')
    const role=await new RoleWorkEligibilityService(pool).authorizeGroupRoutingSource(owner,{groupId:input.groupId,messageId:input.messageId},db)
    const run=await(await runs()).readVerifiedInTransaction(db,owner,source.runId)
    if(!run.roleSnapshot||!run.lineage)throw unavailable()
    const control=await controls.acquireForLineage(owner,{taskId:source.taskId,mode:'new-input'},db),budget=await budgets.admissionInTransaction(db,owner,source.lineage.budgetAccountId)
    budgetAccountId=source.lineage.budgetAccountId;controlGeneration=control.control.generation
    leases.push({assertCurrent:role.assertCurrent},control.lease,budget)
   }
   const base=combineWorkAccessLeases(leases),entry:ResidentRoutingBudget={budgetAccountId,controlGeneration,operationId:input.nativeRequestId,lease:{assertCurrent:()=>{if(closed||routingInputs.get(input.sessionId)!==entry)throw unavailable();base.assertCurrent()}}}
   // 话题向模型裁剪掉 messageId 前先保存原来源；复用当前事务，不嵌套占用第二个池连接。
   await new ArtifactAvailabilityService(pool,identity.now).bindInputInTransaction(db,owner,{sessionId:input.sessionId,references:[],groupMessageIds:[...new Set([input.messageId,...(input.artifactMessageIds??[])])]})
   base.assertCurrent();await db.query('commit');routingInputs.set(input.sessionId,entry)
   return ()=>{if(routingInputs.get(input.sessionId)===entry)routingInputs.delete(input.sessionId)}
  }catch(cause){await db.query('rollback');throw cause}finally{db.release()}
 }
 const resolveRouting=async(sessionId:string):Promise<ResidentRoutingBudget|null>=>{if(!isRoutingSession(sessionId))return null;const entry=routingInputs.get(sessionId);if(!entry)throw unavailable();entry.lease.assertCurrent();return entry}
 const unsubscribe=controls.subscribe(async({control,action})=>{if(action!=='resume'&&controlDriver)await controlDriver.apply(owner,control,new AbortController().signal)})
 const resolveRun=async(sessionId:string):Promise<TaskRun|null>=>{
  if(isRoutingSession(sessionId))return null
  const child=(await pool.query('select owner_id,run_id from teloa_task_run_subagents where child_session_id=$1',[sessionId])).rows
  if(child.length){if(child.some(row=>row.owner_id!==owner)||new Set(child.map(row=>row.run_id)).size!==1)throw new WorkError('teloa/forbidden','子会话不属于当前本人的固定执行。');return(await runs()).get(owner,{runId:child[0].run_id})}
  return(await runs()).skillScope(owner,{sessionId})
 }
 const acquire=async(input:{sessionId:string;producer:string;sourceKind?:string}):Promise<WorkAccessLease|null>=>{if(closed)throw unavailable();if(input.producer==='task-run'){const automatic=automaticContinuation?.admission(input.sessionId);if(automatic)return automatic}if(isRoutingSession(input.sessionId)){if(input.producer!=='prompt'&&input.producer!=='queue')throw unavailable();return(await resolveRouting(input.sessionId))!.lease}const run=await resolveRun(input.sessionId);if(!run)return null;if(run.state==='ended'){const continuation=input.producer==='task-run'&&input.sourceKind==='tool-jobs';if(!options.interactiveAdmission||!continuation&&input.producer!=='prompt'&&input.producer!=='queue')throw unavailable();return options.interactiveAdmission(input.sessionId,continuation?true:undefined)}if(input.sourceKind==='user'&&(input.producer==='prompt'||input.producer==='queue'))throw new WorkError('teloa/conflict','原任务仍由执行编排管理，暂不能提交独立追问。');return combineWorkAccessLeases([await(await runs()).executionAdmission(owner,run.id),(await controls.acquireForRun(owner,{runId:run.id,mode:'new-input'})).lease,...(recoveringInputs.has(input.sessionId)?[recoveringInputs.get(input.sessionId)!]:[])])}
 const saveNativeCheckpoint=async(input:NativeInputCheckpointInput|NativeProgressCheckpointInput)=>{
  input.assertCurrent()
  if('messages'in input)await manualContinuation?.checkpoint(input)
  if('messages'in input)await automaticContinuation?.checkpoint(input)
  const sessionId=String(input.agent.id)
  // 路由和派生会话保留各自专用恢复协议，不能登记为本人独立会话或任务续作。
  if(isRoutingSession(sessionId)||input.snapshot.header.origin!==undefined||input.snapshot.header.parentSession!==undefined||input.snapshot.header.isSeeded||(input.snapshot.header.delegationDepth??0)!==0||input.snapshot.inheritedEventCount!==0)return
  const rows=(await pool.query('select id,owner_id from teloa_task_runs where session_id=$1 order by created_at desc,id desc',[sessionId])).rows
  if(rows.some(row=>row.owner_id!==owner))throw new WorkError('teloa/forbidden','检查点会话不属于本人。')
  const run=rows.length?await(await runs()).get(owner,{runId:rows[0].id}):null
  const active=run!==null&&['submitting','accepted','active'].includes(run.state)&&input.roots.some(root=>root.nativeRequestId===run.nativeRequestId)
  const requestId=active?run.nativeRequestId:input.roots.find(root=>root.nativeRequestId!==null)?.nativeRequestId
  if(!requestId||!input.snapshot.events.length)return
  const phase='phase'in input?input.phase:'claimed'
  const header=phase==='claimed'?undefined:[...input.snapshot.events].reverse().find(event=>event.type==='request/header')
  // 独立追问不借用旧Task的模型；只保存本请求已落入官方日志的真实选择。
  const model=active?run.modelPolicy?.primary:header?.type==='request/header'?header.data.header.config:undefined
  let review=active?readDeliveryReviewCheckpoint(input.agent):null
  const terminal=input.snapshot.events.at(-1)
  if(active&&!review&&phase==='turn-end'&&terminal?.type==='turn/end'&&terminal.data.reason.kind!=='completed'){
   const previous=await continuations.latest(owner,sessionId)
   if(previous?.hostGeneration===generation&&previous.runtimeId===taskRunRuntimeId&&previous.runId===run.id)review=previous.review
  }
  const checkpoint:NativeSessionCheckpoint={ownerId:owner,sessionId,runtimeId:taskRunRuntimeId,hostGeneration:generation,runId:active?run.id:null,scopeRunId:run?.id??null,requestId,phase,logCut:input.snapshot.events.length-1,logSha256:createHash('sha256').update(JSON.stringify(input.snapshot.events)).digest('hex'),roots:input.roots,model:model?{provider:model.provider,model:model.model,...(model.reasoningEffort?{reasoningEffort:model.reasoningEffort}:{}),...(active&&run.permissionMode?{permissionMode:run.permissionMode}:{})}:null,review}
  checkpoint.background={runtimeId:taskRunRuntimeId,unsettledJobIds:Reflect.get(ctx,'jobs')?ctx.jobs.list(input.agent.id).filter(job=>!['completed','killed','failed'].includes(job.status)).map(job=>String(job.id)):[]}
  await continuations.save(checkpoint,()=>{if(closed)throw unavailable();input.assertCurrent()})
 }
 const prepareRetry=async(run:TaskRun,signal:AbortSignal):Promise<void>=>{
  if(closed)throw unavailable();signal.throwIfAborted();await zeroWorkFailure(run,signal)
  if(!run.lineage||run.lineage.ownerId!==owner||run.lineage.definitionControlId!==null)throw unavailable()
  const control=await controls.get(owner,{controlId:run.lineage.roundControlId})
  const seal=await authority.authorize(owner,{requestId:requestId(['task-run-retry-resume',owner,run.id,control.generation]),controlId:control.id})
  const db=await pool.connect();let resumed
  try{
   await db.query('begin')
   const host=(await db.query('select generation from teloa_work_control_hosts where owner_id=$1 for share',[owner])).rows[0]
   if(closed||host?.generation!==generation)throw unavailable()
   const service=await runs(),role=await service.retryAdmissionInTransaction(db,owner,run.id),current=await service.readVerifiedInTransaction(db,owner,run.id)
   if(hash(current)!==hash(run))throw unavailable()
   const lease=combineWorkAccessLeases([seal,role,await budgets.admissionInTransaction(db,owner,run.lineage.budgetAccountId),await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:null,objectId:control.id,operation:'resume'})])
   const now=await controls.retryControlInTransaction(db,owner,{controlId:control.id})
   if(now.version!==control.version||now.generation!==control.generation)throw unavailable()
   if((await db.query("select id from teloa_task_runs where owner_id=$1 and task_id=$2 and id<>$3 and state not in ('ended','withdrawn','configuration_failed','submission_unknown')",[owner,run.taskId,run.id])).rowCount)throw new WorkError('teloa/conflict','原任务已有在途或未知执行，不能恢复后重复派发。')
   signal.throwIfAborted();lease.assertCurrent()
   if(now.state==='paused')resumed=await controls.resumeInTransaction(db,owner,{controlId:now.id,expectedVersion:now.version},lease)
   signal.throwIfAborted();lease.assertCurrent();await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
  if(resumed)await controls.publishResume(owner,resumed)
 }

 const manualBinding=async(c:NativeSessionCheckpoint,db:Pick<Pool,'query'>=pool):Promise<string>=>{
  if(closed||c.ownerId!==owner||c.runId!==null||isRoutingSession(c.sessionId))throw unavailable()
  const rows=(await options.ordinaryConversations?.repository.read())?.filter(row=>row.sessionId===c.sessionId)
  if(rows?.length!==1||rows[0]!.ownerId!==owner||rows[0]!.status!=='ready')throw unavailable()
  const row=rows[0]!
  if(c.scopeRunId!==null){
   const run=(await db.query('select r.id,r.native_request_id,r.state,r.evidence,r.stop_requested_at,t.state as task_state from teloa_task_runs r join teloa_tasks t on t.id=r.task_id and t.owner_id=r.owner_id where r.owner_id=$1 and r.session_id=$2 order by r.created_at desc,r.id desc limit 1',[owner,c.sessionId])).rows[0]
   if(row.purpose!=='task-run'||!run||run.id!==c.scopeRunId||run.native_request_id===c.requestId||run.state!=='ended'||run.evidence?.reason!=='completed'||run.stop_requested_at!==null||run.task_state!=='completed')throw unavailable()
   return hash([row,run])
  }
  if(row.purpose==='task-run'||row.run!==undefined)throw unavailable()
  const associated=await db.query(`select 1 from teloa_task_runs where session_id=$1
   union all select 1 from teloa_task_run_subagents where child_session_id=$1
   union all select 1 from teloa_task_run_runtime_links where session_id=$1
   union all select 1 from teloa_task_run_goals where binding->>'sessionId'=$1
   union all select 1 from teloa_object_conversations where session_id=$1
   union all select 1 from teloa_conversation_work_requests where session_id=$1 limit 1`,[c.sessionId])
  if(associated.rows.length)throw unavailable()
  const contexts=(await db.query('select * from teloa_conversation_work_contexts where session_id=$1',[c.sessionId])).rows
  if(contexts.some(context=>context.owner_id!==owner||context.locked!==true)||contexts.length>1)throw unavailable()
  return hash([row,contexts])
 }
 manualContinuation=createNativeSessionManualContinuation(ctx,{owner,journal:continuations,nativeInput,generation:()=>generation,snapshot,inbox:inboxFor,binding:manualBinding,
  assertCurrent:()=>{if(closed)throw unavailable()},
  accepted:c=>{if(c.scopeRunId!==null)options.manualInteractionAccepted?.(c.sessionId)},
  authorize:async c=>{
   await manualBinding(c)
   const capability=await workAccess.authorizeSessionCapabilities(c.sessionId,'restore')
   if(c.scopeRunId===null)return capability
   const interaction=await options.completedInteraction?.(c.sessionId)
   if(!interaction||interaction.run.id!==c.scopeRunId||interaction.run.nativeRequestId===c.requestId)throw unavailable()
   return combineWorkAccessLeases([capability,interaction.lease])
  },
 })

 const assertAutomaticControls=async(db:Parameters<TaskRunService['readVerifiedInTransaction']>[0],record:import('@teloa/backend').NativeSessionContinuation)=>{
  if(closed||record.hostGeneration!==generation||!record.automaticAdmission)throw unavailable()
  const host=(await db.query('select generation from teloa_work_control_hosts where owner_id=$1 for share',[owner])).rows[0]
  if(host?.generation!==generation)throw unavailable()
  for(const control of record.automaticAdmission.controls){const row=(await db.query('select state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,control.id])).rows[0];if(row?.state!=='active'||row.generation!==control.generation)throw unavailable()}
 }
 const automaticSafe=async(c:NativeSessionCheckpoint,db:Pick<Pool,'query'>=pool)=>{
  if(c.runId===null||c.background?.runtimeId!==c.runtimeId||c.background.unsettledJobIds.length)return false
  const fixed=(await db.query('select r.*,t.state as task_state from teloa_task_runs r join teloa_tasks t on t.owner_id=r.owner_id and t.id=r.task_id where r.owner_id=$1 and r.id=$2',[owner,c.runId])).rows[0]
  if(!fixed||fixed.session_id!==c.sessionId||fixed.native_request_id!==c.requestId||fixed.stop_requested_at!==null||!['submitting','accepted','active'].includes(fixed.state)&&!(fixed.state==='ended'&&fixed.evidence?.reason==='completed'&&fixed.task_state==='waiting'&&c.review!==null))return false
  const unknown=await db.query(`select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and state in ('reserved','started')
   union all select 1 from teloa_task_run_flows where owner_id=$1 and run_id=$2 and state not in ('completed','compensated')
   union all select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and ((kind='browser' and payload->>'status'='dirty') or (kind='job' and payload->>'record'='job' and payload->>'status' not in ('completed','failed','killed')) or (kind='external' and payload->>'status' in ('reserved','running','stopping','unknown')))
   union all select 1 from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where a.owner_id=$1 and a.task_id=$3 and e.state not in ('succeeded','failed')
   union all select 1 from teloa_task_run_goals where owner_id=$1 and run_id=$2 limit 1`,[owner,c.runId,fixed.task_id])
  return !unknown.rowCount
 }
 const retireAutomaticBudgets=async(db:Parameters<TaskRunService['readVerifiedInTransaction']>[0],record:import('@teloa/backend').NativeSessionContinuation,run:TaskRun)=>{
  const admission=record.automaticAdmission;if(!admission?.modelRequestIds.length)return
  const endedAt=admission.retirement?.endedAt??record.acceptedAt;if(!endedAt)throw unavailable()
  await assertAutomaticControls(db,record)
  const rows=(await db.query('select distinct control_generation from teloa_work_budget_reservations where owner_id=$1 and model_request_id=any($2::text[]) order by control_generation',[owner,admission.modelRequestIds])).rows
  for(const row of rows){const ids=(await db.query('select model_request_id from teloa_work_budget_reservations where owner_id=$1 and control_generation=$2 and model_request_id=any($3::text[]) order by model_request_id',[owner,row.control_generation,admission.modelRequestIds])).rows.map(r=>r.model_request_id as string)
   await budgets.retirePreviousHostRequestsInTransaction(db,owner,{runId:run.id,taskId:run.taskId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,oldRuntimeId:record.checkpoint.runtimeId,oldHostGeneration:record.checkpoint.hostGeneration,hostGeneration:generation,controlGeneration:row.control_generation,modelRequestIds:ids,endedAt})}
 }
 automaticContinuation=createNativeSessionTaskContinuation({report:options.report,owner,journal:continuations,nativeInput,generation:()=>generation,snapshot,inbox:inboxFor,safe:automaticSafe,assertCurrent:()=>{if(closed)throw unavailable()},
  execute:async(run,target,resumption,signal)=>{const execute=attached().ports.continueNative;if(!execute)throw unavailable();await execute(run,target,resumption,signal)},
  authorize:async(db,c,record)=>{
   if(!await automaticSafe(c,db))throw unavailable()
   const service=await runs();let run=await service.readVerifiedInTransaction(db,owner,c.runId!)
   if(!run.lineage)throw unavailable()
   const ids=[run.lineage.roundControlId,...run.lineage.definitionControlId?[run.lineage.definitionControlId]:[]].sort()
   if(record.automaticAdmission)await assertAutomaticControls(db,record)
   else{
    // 重启撤防先锁住控制；封存精确旧请求后才允许新宿主模型准入。
    for(const id of ids){const control=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2 for update',[owner,id])).rows[0];if(!control||control.state!=='active'&&(control.state!=='paused'||control.pause_origin!=='restart'||!restarted.some(c=>c.id===id&&c.generation===control.generation)))throw unavailable()}
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-budget/'+owner])
    const requests=(await db.query(`select distinct b.model_request_id from teloa_work_budget_reservations b join teloa_work_retry_claims c on c.owner_id=b.owner_id and c.model_request_id=b.model_request_id join teloa_work_retries r on r.owner_id=c.owner_id and r.operation_id=c.operation_id where b.owner_id=$1 and r.run_id=$2 and r.budget_account_id=b.budget_account_id and b.state in ('reserved','unknown') and (b.elapsed_terminal is null or b.elapsed_terminal->>'schema'<>'teloa.previous-host-budget-terminal/v1') order by b.model_request_id`,[owner,run.id])).rows.map(row=>row.model_request_id as string)
    const capability=await workAccess.authorizeSessionCapabilities(c.sessionId,'restore')
    await options.executionScope(db,owner,run.id,run.state==='ended'?'completion':'active')
    const resumed=[]
    for(const id of ids){const control=await controls.getInTransaction(db,owner,{controlId:id});if(control.state==='paused')resumed.push(await controls.resumeInTransaction(db,owner,{controlId:id,expectedVersion:control.version},capability));else resumed.push(control)}
    const fixed=await snapshot(c.sessionId),lastStart=[...fixed.events].reverse().find(e=>e.seq<=record.prefix.logCut&&e.type==='turn/start'),terminal=[...fixed.events].reverse().find(e=>e.seq<=record.prefix.logCut&&e.seq>(lastStart?.seq??-1)&&e.type==='turn/end'&&e.data.reason.kind!=='interrupted'),point=terminal??(['claimed','step-end','model'].includes(c.phase)?fixed.events[c.logCut]:undefined)
    if(createHash('sha256').update(JSON.stringify(fixed.events.slice(0,record.prefix.logCut+1))).digest('hex')!==record.prefix.logSha256)throw unavailable()
    let retirement:NonNullable<import('@teloa/backend').NativeSessionContinuation['automaticAdmission']>['retirement']
    if(point){
     const endedAt=new Date(point.time).toISOString(),unclosed=(await db.query("select 1 from teloa_work_budget_reservations where owner_id=$1 and model_request_id=any($2::text[]) and state='unknown' and created_at>=$3::timestamptz and elapsed_terminal is null limit 1",[owner,requests,endedAt])).rowCount
     if((terminal?.type==='turn/end'&&(terminal.data.reason.kind!=='aborted'||terminal.data.reason.reason.kind==='disposed')||!terminal&&!unclosed))retirement={endedAt,seq:point.seq,eventSha256:createHash('sha256').update(JSON.stringify(point)).digest('hex'),boundary:terminal?'turn/end':'checkpoint'}
    }
    if(requests.length&&!retirement)throw new WorkError('teloa/execution-pending','旧宿主仍有缺少可靠结束边界的模型请求，请保留原结果并核对。')
    record.automaticAdmission={runtimeId:taskRunRuntimeId,controls:resumed.map(c=>({id:c.id,generation:c.generation})),modelRequestIds:requests,...retirement?{retirement}:{},...run.evidence?.state==='ended'?{priorEvidence:run.evidence}:{}}
    await db.query('update teloa_native_session_continuations set record=$3 where owner_id=$1 and id=$2',[owner,record.id,JSON.stringify(record)])
    await retireAutomaticBudgets(db,record,run)
   }
   run=await service.reopenNativeContinuationInTransaction(db,owner,run.id,record.id)
   const role=await service.executionAdmissionInTransaction(db,owner,run.id),control=await controls.acquireForRun(owner,{runId:run.id,mode:'continuation'},db),budget=await budgets.admissionInTransaction(db,owner,run.lineage!.budgetAccountId),capability=await workAccess.authorizeSessionCapabilities(c.sessionId,'restore')
   const target=await options.executionScope(db,owner,run.id,'active'),lease=combineWorkAccessLeases([role,control.lease,budget,capability])
   lease.assertCurrent();return {run,target,lease}
  },
  accepted:async(record,input)=>{
   if(!record.automaticAdmission?.modelRequestIds.length)return
   const run=await(await runs()).get(owner,{runId:record.checkpoint.runId!}),db=await pool.connect()
   try{await db.query('begin');await assertAutomaticControls(db,record)
    await retireAutomaticBudgets(db,record,run)
    input.assertCurrent();await db.query('commit')
   }catch(error){await db.query('rollback');throw error}finally{db.release()}
  },
 })

 return {outbox,budgets,controls,recovery,goals,goal,retries,events,progress,lineage,acquire,continuation:automaticContinuation.continuation,prepareRetry,restore,authorizeRestoreRoots,invalidateOrdinaryRestore,resolveRun,bindRouting,resolveRouting,hostGeneration:()=>generation,settleRun,nativeCheckpoint:saveNativeCheckpoint,nativeProgress:saveNativeCheckpoint,
  async nativeContinuations(run:TaskRun,events:readonly SessionEvent[]):Promise<ReadonlySet<string>>{
   const result=new Set<string>()
   for(const r of await continuations.records(owner,run.sessionId)){
    if(r.mode!=='automatic'||r.input!=='continuation'||r.checkpoint.runId!==run.id||r.checkpoint.requestId!==run.nativeRequestId||r.state!=='accepted'||r.acceptedSeq===null||r.message===null)continue
    const accepted=events[r.acceptedSeq]
    if(!accepted||accepted.type!=='agent/inbox/spliced'||accepted.data.target!=='next-turn'||accepted.data.inserted.length!==1||hash(accepted.data.inserted[0])!==hash(r.message)||createHash('sha256').update(JSON.stringify(accepted)).digest('hex')!==r.acceptedEventSha256||createHash('sha256').update(JSON.stringify(events.slice(0,r.prefix.logCut+1))).digest('hex')!==r.prefix.logSha256)throw unavailable()
    result.add(nativeRunContinuationKey(r.id))
   }
   return result
  },
  async attachRunDriver(value:RunDriverBinding){
   binding=value
   for(const id of await automaticContinuation!.safeRunIds())restartProtectedRuns.add(id)
   await reconcileOwnerSettlements(new AbortController().signal)
   await reconcileRunBudgets(new AbortController().signal)
   const pausePorts={...value.ports,stop:async(run:TaskRun,signal:AbortSignal)=>{
    if(await restartProtectionCurrent(run.id))return
    // 宿主启动的暂停不得为了取消一个已证实零副作用的终轮、或已按持久终态结算收口的成功终轮而重新 materialize 它。
    if(run.state==='ended'){
     try{await zeroWorkFailure(run,signal);return}catch{signal.throwIfAborted()}
     if(await terminalRunSettled(run))return
    }
    await value.ports.stop(run,signal)
   }}
   controlDriver=new WorkControlDriver({controls,runs:{get:async(actor,input)=>{assertOwner(actor);return(await runs()).get(actor,input)}},lineage,driver:{stop:async(actor,input,signal)=>(await driver()).stop(actor,input,signal)},ports:pausePorts,runtimeLinks:value.runtimeLinks,unpublishedCancellationSettled:async(actor,run)=>{assertOwner(actor);return new TaskRunSubmissionService(options.pool).unpublishedCancellationSettled(actor,run)},terminalSettled:async(actor,run)=>{assertOwner(actor);return terminalRunSettled(run)},quiescentSettled:async(actor,run)=>{assertOwner(actor);return quiescentRunSettled(run)}})
   for(const control of restarted)await controlDriver.apply(owner,control,new AbortController().signal)
  },
  async pump(delivery:GroupRoutingOutboxPorts,route:(owner:string,messageId:string,signal:AbortSignal)=>Promise<void>,signal:AbortSignal){await reconcileOwnerSettlements(signal);await reconcileRunBudgets(signal);await automaticContinuation!.pump(signal);await drainGroupRoutingWakes(owner,{outbox,route,report:options.report},signal);await drainGroupRoutingOutbox(owner,delivery,signal);
   const children=(await pool.query("select s.run_id,s.reservation_id from teloa_task_run_subagents s where s.owner_id=$1 and s.state='ended' and not exists(select 1 from teloa_work_events e where e.owner_id=s.owner_id and e.payload->>'kind'='child-completed' and e.payload->>'parentRunId'=s.run_id::text and e.payload->>'reservationId'=s.reservation_id) order by s.ended_at limit 100",[owner])).rows
   for(const child of children){signal.throwIfAborted();const db=await pool.connect();try{await db.query('begin');await events.appendSource(db,{kind:'child-completed',sourceId:child.run_id,receiptId:child.reservation_id});await db.query('commit')}catch(error){await db.query('rollback');options.report(error instanceof WorkError?error.code:'teloa/unavailable')}finally{db.release()}}
   // Run commit 后崩溃可以丢失 callback；只核真实已完成 Run 和等待验收 Task，不重新执行。
   const completed=(await pool.query("select r.id from teloa_task_runs r join teloa_tasks t on t.owner_id=r.owner_id and t.id=r.task_id where r.owner_id=$1 and r.state='ended' and r.evidence->>'reason'='completed' and t.state='waiting' and t.definition->'completionPolicy'->>'kind'='verified' order by r.created_at,r.id limit 100",[owner])).rows
   for(const row of completed){signal.throwIfAborted();try{await settleRun(owner,await(await runs()).get(owner,{runId:row.id}))}catch(error){options.report(error instanceof WorkError?error.code:'teloa/unavailable')}}
   const rows=(await pool.query("select id,generation from teloa_work_controls where owner_id=$1 and state in ('pausing','ending') order by id",[owner])).rows;for(const row of rows){signal.throwIfAborted();if(controlDriver)await controlDriver.apply(owner,await controls.get(owner,{controlId:row.id}),signal)}
   // 只在就绪后的维护循环中恢复，不在启动就绪前派发工作。
   await resumePlanned(signal)},
  async ownerRpc(endpoint:string,input:unknown,signal:AbortSignal){
   signal.throwIfAborted()
   if(endpoint==='session-continuations/inspect'||endpoint==='session-continuations/resume'){
    const value=taskInput(input,endpoint.endsWith('/resume')?['sessionId','prefixSha256']:['sessionId'])
    if(typeof value.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(value.sessionId)||!manualContinuation)throw new WorkError('teloa/invalid-input','恢复会话身份不正确。')
    if(endpoint.endsWith('/inspect'))return manualContinuation.inspect(value.sessionId)
    if(typeof value.prefixSha256!=='string'||!(/^[a-f0-9]{64}$/).test(value.prefixSha256))throw new WorkError('teloa/invalid-input','原会话恢复位置不正确。')
    return manualContinuation.resume(value.sessionId,value.prefixSha256,signal)
   }
   if(endpoint==='work-progress/get'){const row=taskInput(input,['rootTaskId']);return progress.get(owner,{rootTaskId:row.rootTaskId as string})}if(endpoint==='work-controls/get')return controls.get(owner,input as {controlId:string});if(endpoint==='work-controls/change')return controls.change(owner,input as WorkControlChange);if(endpoint==='work-recovery/inspect')return recovery.inspect(owner,input as {controlId:string});if(endpoint==='work-recovery/resume')return coordinator.resume(owner,input as WorkResumeInput,signal);if(endpoint==='work-budgets/read')return budgets.read(owner,input);if(endpoint==='work-budgets/configure')return budgets.configure(owner,input);if(endpoint==='work-budgets/owner/read'){taskInput(input,[]);return budgets.readOwner(owner)}if(endpoint==='work-budgets/owner/configure')return budgets.configureOwner(owner,input);throw new WorkError('teloa/not-found','未提供此本人工作接口。')},
  close(){closed=true;unsubscribe();goal.close();recovering.clear();recoveryRequests.clear();recoveringInputs.clear();routingInputs.clear();manualContinuation?.close()},
 }
}
