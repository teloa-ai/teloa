import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionId,SessionLogOffset,type SessionEvent} from '@deepseek-ai/dsh-session'
import {foldGoal} from '@deepseek-ai/dsh-goal'
import {boundContextSummary} from '@deepseek-ai/dsh-llm'
import {finalAssistantOutput} from '@deepseek-ai/dsh-subagent'
import {WorkError,artifactContent,taskInput,readRetrievalSearchResult,groupRoutingRequestId,groupRoutingSessionId,type WorkControlChange} from '@teloa/contract'
import {ArtifactService,taskArtifactSource,taskArtifactSessions,GroupRoutingOutboxService,WorkLineageService,WorkControlService,WorkRecoveryService,WorkBudgetService,TaskRunGoalService,TaskRunRuntimeLinkService,TaskCompletionService,readStoredTask,WorkEventService,MarketContentStore,WorkProgressService,WorkRetryService,combineWorkAccessLeases,readTrustedGroupMessageRunSource,RoleWorkEligibilityService,workAccess,type TaskRunService,type TaskRun,type OwnerWorkAuthority,type ResourceService,type RoleDailyLogService,type WorkAccessLease,type WorkResumeInput,type WorkRecoveryCheckpoint,type TaskExecutionScope,type ConversationService} from '@teloa/backend'
import {createTaskRunGoal} from './task-run-goal.ts'
import {createTaskCompletionVerifiers} from './task-completion-verifiers.ts'
import {WorkControlDriver} from './work-control-driver.ts'
import {WorkRecoveryCoordinator,controlledWorkRestore} from './work-recovery-coordinator.ts'
import {TaskRunDriver,type TaskRunPorts} from './task-run-driver.ts'
import {nativeInputRecoveryCandidate,type NativeInputRecoveryCandidate} from './native-input-recovery-candidate.ts'
import {createOrdinaryNativeRestoreAuthorization} from './ordinary-native-restore.ts'
import {nativeInputIdentity} from './native-input-access.ts'
import {taskRunTeamContinuations} from './task-run-team-records.ts'
import {readSessionEvents} from './session-events.ts'
import {taskKnowledgeAuthorization} from './task-run-dsh.ts'
import {inspectNativeProgressRound} from './work-stagnation.ts'
import {drainGroupRoutingOutbox,drainGroupRoutingWakes,type GroupRoutingOutboxPorts} from './group-routing-outbox-driver.ts'
import type {TeloaNativeInput} from './native-input-provider.ts'
import type {ResidentRoutingBudget} from './resident-model-budget.ts'
import {isRoutingSession} from './group-routing.ts'
import type {NativeCheckpointSnapshot,NativeInputRestore,NativeInputRestoreInput,NativeInputRestoreLease} from './native-input-checkpoint.ts'

type Pool=TaskRunService['pool']
type Permit=Awaited<ReturnType<WorkRecoveryService['begin']>>
type RunDriverBinding={ports:TaskRunPorts;runtimeLinks:ConstructorParameters<typeof WorkControlDriver>[0]['runtimeLinks']}
export type ResidentWorkRuntimeOptions={
 owner:string;pool:Pool;identity:{id:()=>string;now:()=>string};nativeInput:TeloaNativeInput['input'];ownerAuthority:OwnerWorkAuthority
 runs:()=>Promise<TaskRunService>;resources:ResourceService;dailyLogs:()=>Promise<RoleDailyLogService>
 executionScope:(db:Parameters<TaskRunService['readVerifiedInTransaction']>[0],owner:string,runId:string,mode:'active'|'completion')=>Promise<TaskExecutionScope>
 approval?:NonNullable<ConstructorParameters<typeof WorkEventService>[2]>['approval']
 verifyInitialMessage:(run:TaskRun,message:NativeInputRestoreInput['messages'][number],acceptedAt:number)=>Promise<boolean>
 ordinaryConversations?:Pick<ConversationService,'repository'>
 report:(code:string)=>void
}
export const residentOwnerEndpoints=['work-controls/get','work-controls/change','work-recovery/inspect','work-recovery/resume','work-budgets/read','work-budgets/configure','work-budgets/owner/read','work-budgets/owner/configure','work-progress/get'] as const
const canonical=(v:unknown):unknown=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const requestId=(value:unknown)=>{const s=hash(value);return s.slice(0,8)+'-'+s.slice(8,12)+'-5'+s.slice(13,16)+'-a'+s.slice(17,20)+'-'+s.slice(20,32)}
const unavailable=()=>new WorkError('teloa/unavailable','当前宿主的受控工作端口尚未就绪。')

/** 同一宿主共享持久服务和最终许可；启动/本人 RPC 的生命周期由 index 拥有。 */
export async function createResidentWorkRuntime(ctx:Context,options:ResidentWorkRuntimeOptions){
 const {owner,pool,identity,nativeInput,runs,resources,dailyLogs}=options
 if(typeof nativeInput?.withNewInput!=='function')throw unavailable()
 const assertOwner=(value:string)=>{if(value!==owner)throw new WorkError('teloa/forbidden','只能操作当前本人的工作。')}
 const progress=new WorkProgressService(pool,identity),lineage=new WorkLineageService(pool,identity),outbox=new GroupRoutingOutboxService(pool,identity),budgets=new WorkBudgetService(pool,identity,options.ownerAuthority)
 const prior=(await pool.query('select generation from teloa_work_control_hosts where owner_id=$1',[owner])).rows[0]
 const generation=Number(prior?.generation??0)+1
 let binding:RunDriverBinding|undefined,controlDriver:WorkControlDriver|undefined,closed=false
 const attached=()=>{if(closed||!binding)throw unavailable();return binding}
 const driver=async()=>new TaskRunDriver(await runs(),attached().ports)
 const authority={authorize:async(value:string,request:Readonly<{requestId:string;controlId:string}>)=>{assertOwner(value);return options.ownerAuthority.authorize(value,{requestId:request.requestId,roleId:request.controlId,operation:'resume'})}}
 const controls=new WorkControlService(pool,identity,{hostGeneration:()=>generation,ownerAuthority:authority,inspectRun:async(value,input)=>{assertOwner(value);if(!controlDriver)throw unavailable();const proof=await controlDriver.inspectRun(value,input),operations=(await pool.query("select e.operation_id,e.state from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id join teloa_task_runs r on r.owner_id=a.owner_id and r.task_id=a.task_id where r.owner_id=$1 and r.id=$2 and e.state not in ('succeeded','failed')",[value,input.runId])).rows;return {settled:proof.settled&&operations.length===0,unknownOperationIds:[...proof.unknownOperationIds,...operations.filter(row=>row.state==='dispatching'||row.state==='effect_unknown').map(row=>'security:'+row.operation_id)]}}})
 const restarted=await controls.disarmForRestart(owner,{hostGeneration:generation})
 const snapshot=async(sessionId:string):Promise<NativeCheckpointSnapshot>=>{
  const agent=ctx.agents.get(SessionId(sessionId))
  if(agent){if(!await ctx.sessions.flush(agent.session))throw unavailable();return {header:agent.session.header,events:[...readSessionEvents(agent.session)],inheritedEventCount:Number(agent.session.inheritedEventCount)}}
  const handle=await ctx.sessionPersistence.open(SessionId(sessionId),'read')
  try{return {header:handle.header,events:(await handle.read()).events,inheritedEventCount:Number(handle.inheritedEventCount)}}finally{await handle.close()}
 }
 const ordinaryProvenance=new Map<string,number>()
 const invalidateOrdinaryRestore=(sessionId:string)=>{if(typeof sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(sessionId))throw unavailable();ordinaryProvenance.set(sessionId,(ordinaryProvenance.get(sessionId)??0)+1)}
 const authorizeOrdinaryRestore=options.ordinaryConversations?createOrdinaryNativeRestoreAuthorization(ctx,{owner,conversations:options.ordinaryConversations,pool,snapshot,isRoutingSession,provenanceGeneration:sessionId=>ordinaryProvenance.get(sessionId)??0,assertCurrent:()=>{if(closed)throw unavailable()}}):undefined
 const inboxFor=(value:NativeCheckpointSnapshot)=>ctx.sessionProjections.stateOf(Session.create(SessionId(value.header.id),value.events,value.header,SessionLogOffset(value.inheritedEventCount)),'inbox')
 const inspectCheckpoint=async(value:string,input:{runId:string;sessionId:string;nativeRequestId:string},db?:Parameters<TaskRunService['readVerifiedInTransaction']>[0]):Promise<WorkRecoveryCheckpoint>=>{
  assertOwner(value);const fixed=await snapshot(input.sessionId),inbox=inboxFor(fixed),unknown:string[]=[],client=db??await pool.connect()
  try{
  const run=await(await runs()).readVerifiedInTransaction(client,owner,input.runId)
  const accepted=fixed.events.some(event=>event.seq>=fixed.inheritedEventCount&&((event.type==='user/message'&&event.data.source.kind==='user'&&Reflect.get(event.data.source,'rpcId')===input.nativeRequestId)||(event.type==='agent/inbox/spliced'&&event.data.inserted.some(message=>message.source.kind==='user'&&Reflect.get(message.source,'rpcId')===input.nativeRequestId))))
  if(!inbox)unknown.push('checkpoint:inbox-unavailable')
  const pending=!!inbox&&(inbox['next-turn'].length>0||inbox['next-step'].length>0)
  if(pending&&!nativeInputRecoveryCandidate({snapshot:fixed,inbox}))unknown.push('checkpoint:roots-unverified')
  const last=[...fixed.events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  if(last?.type==='turn/start')unknown.push('checkpoint:unfinished-turn')
  for(const link of await new TaskRunRuntimeLinkService(pool).listInTransaction(client,owner,{runId:run.id})){if(link.kind==='browser'&&link.payload.status==='dirty')unknown.push('browser:'+link.payload.dispatchId);if(link.kind==='job'&&link.payload.record==='job'&&['running','stopping'].includes(link.payload.status))unknown.push('job:'+link.nativeId)}
  const external=(await client.query("select e.operation_id from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where e.owner_id=$1 and a.task_id=$2 and e.state not in ('succeeded','failed')",[value,run.taskId])).rows;unknown.push(...external.map(row=>'security:'+row.operation_id))
  return {reason:unknown.length||!accepted&&run.state!=='prepared'?'unknown':accepted?'accepted':'unaccepted',checkpointSha256:hash(fixed),hasPendingInput:pending,unknownOperationIds:unknown}
  }finally{if(!db)client.release()}
 }
 const recovery=new WorkRecoveryService(pool,identity,controls,{hostGeneration:()=>generation,ownerAuthority:authority,inspectCheckpoint,authorizeResume:async(db,value,{candidate})=>{assertOwner(value);const run=await(await runs()).readVerifiedInTransaction(db,value,candidate.runId);if(!run.lineage)throw unavailable();return budgets.admissionInTransaction(db,value,run.lineage.budgetAccountId)}})
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
     const current=await resources.executionKnowledgeInTransaction(db,auth.actor,auth.targetScopes,ids)
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
  if(closed||input.snapshot.header.id!==input.sessionId||!actual||hash(actual)!==hash(candidate)||hash(actual.messages)!==hash(input.messages))throw unavailable()
  if(!entry){
   if(!authorizeOrdinaryRestore)throw unavailable()
   const fingerprint=hash([input.sessionId,input.snapshot,input.messages]),proof=await authorizeOrdinaryRestore(input,actual)
   if(!proof||hash(proof.roots)!==hash(actual.roots)||typeof proof.assertCurrent!=='function')throw unavailable()
   const current=()=>{input.signal.throwIfAborted();if(closed||recovering.has(input.sessionId)||fingerprint!==hash([input.sessionId,input.snapshot,input.messages]))throw unavailable();const returned:unknown=proof.assertCurrent();if(returned!==undefined){void Promise.resolve(returned).catch(()=>{});throw unavailable()}}
   current();return Object.freeze({roots:Object.freeze(actual.roots.map(root=>Object.freeze({...root}))),assertCurrent:()=>{current();return undefined}})
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
    if(Object.keys(source).some(key=>!['kind','rpcId'].includes(key))||Reflect.get(source,'rpcId')!==run.nativeRequestId||root.nativeRequestId!==run.nativeRequestId||!await options.verifyInitialMessage(run,message,accepted.time))throw unavailable()
   }else if(source.kind==='goal'){
    const matches=stored.continuations.filter(receipt=>receipt.state==='accepted'&&receipt.ownerId===owner&&receipt.runId===run.id&&receipt.sessionId===run.sessionId&&receipt.controlId===run.lineage!.roundControlId&&receipt.messageId===message.id&&receipt.goalId===source.goalId&&receipt.revision===source.revision&&receipt.round===source.round&&receipt.payloadSha256===root.payloadSha256&&receipt.acceptedSeq===accepted.seq)
    if(!stored.binding||Object.keys(source).some(key=>!['kind','goalId','revision','round'].includes(key))||root.nativeRequestId!==null||matches.length!==1)throw unavailable()
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
  const entry=recovering.get(input.sessionId);if(!entry){
   if(closed||!authorizeOrdinaryRestore)throw unavailable()
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
 const artifacts=new ArtifactService(pool,identity,async(value,expected,db)=>{assertOwner(value);if(expected.kind!=='task')throw unavailable();return {source:await taskArtifactSource(db,value,expected.id,true),sessionIds:await taskArtifactSessions(db,value,expected.id,true)}})
 const verifiers=createTaskCompletionVerifiers({digest:async input=>(await dailyLogs()).completeEvidenceInTransaction(input.db,input.ownerId,input.run.id),saveDigestArtifact:async(input,evidence)=>{const saved=await artifacts.createInTransaction(input.db,input.ownerId,{requestId:requestId(['daily-digest-artifact',input.ownerId,input.run.id]),source:await taskArtifactSource(input.db,input.ownerId,input.task.id,true),content:artifactContent({title:input.task.title,sections:[{id:'daily-digest',title:evidence.log.day,text:evidence.log.markdown}],snapshotIds:[]})});return {id:saved.artifactId,version:saved.number}},material:async(input,source)=>{
  const target=await options.executionScope(input.db,input.ownerId,input.run.id,'completion'),auth=taskKnowledgeAuthorization(input.ownerId,target,input.run.roleSnapshot?.scopes)
  if(auth.knowledgeIds!==undefined&&auth.knowledgeIds!==null&&!auth.knowledgeIds.includes(source.resourceId))throw unavailable()
  const current=(await resources.executionKnowledgeInTransaction(input.db,auth.actor,auth.targetScopes,[source.resourceId]))[0];if(!current)throw unavailable();return current
 },saveMaterialSummaryArtifact:async(input,delivery)=>({receiptId:delivery.requestId,artifact:await artifacts.createInTransaction(input.db,input.ownerId,{requestId:delivery.requestId,source:await taskArtifactSource(input.db,input.ownerId,input.task.id,true),content:delivery.content})})})
 const settleRun=async(value:string,run:TaskRun)=>{
  assertOwner(value);if(run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||!binding)return
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
 const events=new WorkEventService(pool,identity,{material:async(db,value,resourceId)=>{assertOwner(value);const row=(await db.query('select spec from teloa_resources where owner_id=$1 and id=$2',[value,resourceId])).rows[0];if(!row||!Array.isArray(row.spec.scopeIds))throw unavailable();const scopes=row.spec.scopeIds as string[],current=(await resources.executionKnowledgeInTransaction(db,{ownerId:value,kind:'agent',scopeIds:scopes},scopes,[resourceId]))[0];if(!current)throw unavailable();return {sourceVersion:current.sourceVersion,contentSha256:createHash('sha256').update(current.text).digest('hex')}},...(options.approval?{approval:options.approval}:{})},new MarketContentStore(pool,identity))
 const routingInputs=new Map<string,ResidentRoutingBudget>()
 const bindRouting=async(input:{sessionId:string;day:string;groupId:string;messageId:string;nativeRequestId:string}):Promise<()=>void>=>{
  if(closed||!/^\d{4}-\d{2}-\d{2}$/.test(input.day)||input.sessionId!==groupRoutingSessionId(owner,input.groupId,input.day)||input.nativeRequestId!==groupRoutingRequestId(owner,input.groupId,input.messageId)||routingInputs.has(input.sessionId))throw unavailable()
  const db=await pool.connect()
  try{
   await db.query('begin')
   const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2',[owner,input.groupId])).rows[0],message=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,input.groupId,input.messageId])).rows[0]
   if(!group||group.archived||!message)throw unavailable()
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
 const acquire=async(input:{sessionId:string;producer:string}):Promise<WorkAccessLease|null>=>{if(closed)throw unavailable();if(isRoutingSession(input.sessionId)){if(input.producer!=='prompt'&&input.producer!=='queue')throw unavailable();return(await resolveRouting(input.sessionId))!.lease}const run=await resolveRun(input.sessionId);if(!run)return null;return combineWorkAccessLeases([await(await runs()).executionAdmission(owner,run.id),(await controls.acquireForRun(owner,{runId:run.id,mode:'new-input'})).lease,...(recoveringInputs.has(input.sessionId)?[recoveringInputs.get(input.sessionId)!]:[])])}

 return {outbox,budgets,controls,recovery,goals,goal,retries,events,progress,lineage,acquire,restore,authorizeRestoreRoots,invalidateOrdinaryRestore,resolveRun,bindRouting,resolveRouting,hostGeneration:()=>generation,settleRun,
  async attachRunDriver(value:RunDriverBinding){binding=value;controlDriver=new WorkControlDriver({controls,runs:{get:async(actor,input)=>{assertOwner(actor);return(await runs()).get(actor,input)}},lineage,driver:{stop:async(actor,input,signal)=>(await driver()).stop(actor,input,signal)},ports:value.ports,runtimeLinks:value.runtimeLinks});for(const control of restarted)await controlDriver.apply(owner,control,new AbortController().signal)},
  async pump(delivery:GroupRoutingOutboxPorts,route:(owner:string,messageId:string,signal:AbortSignal)=>Promise<void>,signal:AbortSignal){await drainGroupRoutingWakes(owner,{outbox,route,report:options.report},signal);await drainGroupRoutingOutbox(owner,delivery,signal);
   const children=(await pool.query("select s.run_id,s.reservation_id from teloa_task_run_subagents s where s.owner_id=$1 and s.state='ended' and not exists(select 1 from teloa_work_events e where e.owner_id=s.owner_id and e.payload->>'kind'='child-completed' and e.payload->>'parentRunId'=s.run_id::text and e.payload->>'reservationId'=s.reservation_id) order by s.ended_at limit 100",[owner])).rows
   for(const child of children){signal.throwIfAborted();const db=await pool.connect();try{await db.query('begin');await events.appendSource(db,{kind:'child-completed',sourceId:child.run_id,receiptId:child.reservation_id});await db.query('commit')}catch(error){await db.query('rollback');options.report(error instanceof WorkError?error.code:'teloa/unavailable')}finally{db.release()}}
   // Run commit 后崩溃可以丢失 callback；只核真实已完成 Run 和等待验收 Task，不重新执行。
   const completed=(await pool.query("select r.id from teloa_task_runs r join teloa_tasks t on t.owner_id=r.owner_id and t.id=r.task_id where r.owner_id=$1 and r.state='ended' and r.evidence->>'reason'='completed' and t.state='waiting' and t.definition->'completionPolicy'->>'kind'='verified' order by r.created_at,r.id limit 100",[owner])).rows
   for(const row of completed){signal.throwIfAborted();try{await settleRun(owner,await(await runs()).get(owner,{runId:row.id}))}catch(error){options.report(error instanceof WorkError?error.code:'teloa/unavailable')}}
   const rows=(await pool.query("select id,generation from teloa_work_controls where owner_id=$1 and state in ('pausing','ending') order by id",[owner])).rows;for(const row of rows){signal.throwIfAborted();if(controlDriver)await controlDriver.apply(owner,await controls.get(owner,{controlId:row.id}),signal)}},
  async ownerRpc(endpoint:string,input:unknown,signal:AbortSignal){signal.throwIfAborted();if(endpoint==='work-progress/get'){const row=taskInput(input,['rootTaskId']);return progress.get(owner,{rootTaskId:row.rootTaskId as string})}if(endpoint==='work-controls/get')return controls.get(owner,input as {controlId:string});if(endpoint==='work-controls/change')return controls.change(owner,input as WorkControlChange);if(endpoint==='work-recovery/inspect')return recovery.inspect(owner,input as {controlId:string});if(endpoint==='work-recovery/resume')return coordinator.resume(owner,input as WorkResumeInput,signal);if(endpoint==='work-budgets/read')return budgets.read(owner,input);if(endpoint==='work-budgets/configure')return budgets.configure(owner,input);if(endpoint==='work-budgets/owner/read'){taskInput(input,[]);return budgets.readOwner(owner)}if(endpoint==='work-budgets/owner/configure')return budgets.configureOwner(owner,input);throw new WorkError('teloa/not-found','未提供此本人工作接口。')},
  close(){closed=true;unsubscribe();goal.close();recovering.clear();recoveryRequests.clear();recoveringInputs.clear();routingInputs.clear();ordinaryProvenance.clear()},
 }
}
