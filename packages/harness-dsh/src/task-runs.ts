import {isDeepStrictEqual} from 'node:util'
import {readTaskRunSourceFollowupCommand,readTaskRunSourceFollowup,sourceFollowupNotice,resultFollowupNotice,type TaskRunSourceFollowupCandidate,type TaskRunSourceFollowupCommand} from '@teloa/contract'
import {prepareOwnerRun} from './owner-run-admission.ts'
import {WorkError,taskInput,taskRunOriginInput} from '@teloa/contract'
import {readTaskRunMemorySelection} from '@teloa/contract'
import {readEmployeeApiModel,readEmployeeApiPermissionMode,type EmployeeModelSelection,type EmployeePermissionMode} from '../../sdk/contract.mjs'
import type {DigitalRole,WebAccessEntry,TaskRunModelStatus,TaskRunOrigin} from '@teloa/contract'
import {TaskRunPresetError,type ConversationService,type ConversationTaskIdentity,type ObjectConversationService,type TaskExecutionScope,type TaskRun,type TaskRunService,type TaskRunSkillDatabase,type TaskRunSubagent} from '@teloa/backend'
import {assertSafeTaskRunRetry} from './task-run-retry-proof.ts'
import {workRequestChildId} from '@teloa/backend'
import {TaskRunDriver,type TaskRunPorts} from './task-run-driver.ts'
import type {TaskRunDeliveryReader} from './task-run-delivery-status.ts'
export const taskRunEndpoints=['task-runs/retry','task-runs/origin','task-runs/list','task-runs/prepare','task-runs/start','task-runs/reconcile','task-runs/stop','task-runs/withdraw','task-runs/subagents/recover'] as const
export const taskRunOwnerEndpoint='task-runs/dispose-unknown'
export const taskRunOwnerEndpoints=[taskRunOwnerEndpoint,'task-runs/session','task-runs/source-followup/get','task-runs/source-followup/prepare'] as const
type TaskRunMutationEndpoint=Exclude<typeof taskRunEndpoints[number],'task-runs/list'|'task-runs/origin'>
export type TaskKnowledgeLoader=(target:TaskExecutionScope,role:DigitalRole,database:TaskRunSkillDatabase,signal:AbortSignal)=>Promise<TaskRun['knowledge']>
/** `admitRun` 在 prepare 写入 Run 的同一事务内执行容量准入；拒绝即不建 Run，调用方按原请求下次再准备。 */
type RunAdmission=NonNullable<Parameters<TaskRunService['prepare']>[7]>
export type ManagedTaskRunPreparationPorts={conversations:Pick<ConversationService,'createRun'|'runReservation'|'failRunReservation'>&Partial<Pick<ConversationService,'snapshotBySession'>>;links:Pick<ObjectConversationService,'change'>;beforeCreate?:(sessionId:string)=>void;admitRun?:(db:Parameters<RunAdmission>[0],owner:string,lineage:Parameters<RunAdmission>[1])=>Promise<void>}
type TaskRunSessionRead={schema:'teloa.task-run-session/v1';conversation:Awaited<ReturnType<ConversationService['snapshotBySession']>>;anchor:TaskRun;currentRunId:string;run:TaskRun}
export type TaskRunSubagentReader={listMany:(owner:string,runIds:readonly string[])=>Promise<Map<string,TaskRunSubagent[]>>;recover?:(owner:string,input:unknown)=>Promise<TaskRunSubagent>}
/** 运行会话是原生资源，令牌估算只在读口附带，不回写或改变 Run 的固定快照。 */
export type TaskRunMeasurementReader={estimate:(sessionId:string)=>Promise<number|undefined>}
/** 与 TaskRunSubagentReader 并列：运行回包内的上网记录读口，同样按 owner 批量核对归属。 */
export type TaskRunWebAccessReader={listMany:(owner:string,runIds:readonly string[])=>Promise<Map<string,WebAccessEntry[]>>}
export type TaskRunModelReader={read:(run:TaskRun)=>Promise<TaskRunModelStatus|undefined>}
type PrepareOptions={permissionMode?:EmployeePermissionMode;model?:EmployeeModelSelection}
function readPrepareOptions(payload:unknown):PrepareOptions{
 const value=payload as Record<string,unknown>
 try{return {...(value.permissionMode===undefined?{}:{permissionMode:readEmployeeApiPermissionMode(value.permissionMode)}),...(value.model===undefined?{}:{model:readEmployeeApiModel(value.model)})}}
 catch{throw new WorkError('teloa/invalid-input','执行权限模式或模型参数不正确。')}
}
export function createTaskRunHandler(owner:string,get:()=>Promise<TaskRunService>,ports:TaskRunPorts,loadTaskKnowledge?:TaskKnowledgeLoader,managed?:ManagedTaskRunPreparationPorts,subagents?:TaskRunSubagentReader,measurements?:TaskRunMeasurementReader,webAccess?:TaskRunWebAccessReader,models?:TaskRunModelReader,delivery?:TaskRunDeliveryReader){
 const sourcePreparations=new Map<string,{command:TaskRunSourceFollowupCommand;work:Promise<TaskRun>}>()
 const withSubagents=async<T extends TaskRun|TaskRun[]>(value:T):Promise<T>=>{
  if(!subagents&&!measurements&&!webAccess&&!models&&!delivery&&!ports.submissions)return value
  const runs=Array.isArray(value)?value:[value],registered=subagents?await subagents.listMany(owner,runs.map(run=>run.id)):new Map<string,TaskRunSubagent[]>()
  const webAccessRegistered=webAccess?await webAccess.listMany(owner,runs.map(run=>run.id)):new Map<string,WebAccessEntry[]>()
  const attached=await Promise.all(runs.map(async run=>{
   const entries=registered.get(run.id),webAccessEntries=webAccessRegistered.get(run.id),estimated=await measurements?.estimate(run.sessionId),contextTokenEstimate=typeof estimated==='number'&&Number.isSafeInteger(estimated)&&estimated>=0&&estimated<=2147483647?estimated:undefined
   const modelStatus=await models?.read(run).catch(()=>({state:'unavailable' as const}))
   const deliveryCheck=await delivery?.read(owner,run)
   const submissionRecovery=run.state==='submitting'&&ports.submissions?(ports.submissions.publicationState?await ports.submissions.publicationState(run):await ports.submissions.recoverable(run)?'not-published' as const:'unknown' as const):undefined
   return {...run,...(submissionRecovery?{submissionRecovery}:{}),...(entries?.length?{subagents:entries}:{}),...(webAccessEntries?.length?{webAccess:webAccessEntries}:{}),...(contextTokenEstimate===undefined?{}:{contextTokenEstimate}),...(modelStatus?{modelStatus}:{}),...(deliveryCheck?{deliveryCheck}:{})}
  }))
  return (Array.isArray(value)?attached:attached[0]!) as T
 }
 async function readSession(payload:unknown,signal:AbortSignal,includeDetails:boolean,parentIdentity?:ConversationTaskIdentity):Promise<TaskRunSessionRead>{
  const input=taskInput(payload,['sessionId','runId']),id=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
  if(parentIdentity||typeof input.sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(input.sessionId)||input.runId!==undefined&&!id(input.runId))throw new WorkError('teloa/invalid-input','运行会话读取身份不正确。')
  signal.throwIfAborted()
  if(!managed?.conversations.snapshotBySession)throw new WorkError('teloa/unavailable','运行会话预约读口尚未就绪。')
  const sessionId=input.sessionId,conversation=await managed.conversations.snapshotBySession(owner,sessionId),fixed=conversation.run,service=await get()
  const denied=()=>new WorkError('teloa/conflict','运行会话与原任务预约不一致，请重新核对。')
  if(conversation.ownerId!==owner||conversation.sessionId!==sessionId||conversation.status!=='ready'||conversation.purpose!=='task-run'||!fixed||!conversation.requestId)throw denied()
  // 目录与详情共用原预约和完整历史校验；目录不为每一行打开原生日志加载展示详情。
  const snapshot=includeDetails?undefined:await service.directorySessionSnapshot(owner,{requestId:conversation.requestId,taskId:fixed.taskId,expectedTaskVersion:fixed.taskVersion,sessionId})
  const current=includeDetails?await service.sessionRun(owner,{sessionId}):snapshot?.current,anchor=includeDetails?await service.requestForSession(owner,{requestId:conversation.requestId,taskId:fixed.taskId,expectedTaskVersion:fixed.taskVersion,sessionId}):snapshot?.anchor
  if(!current||!anchor)throw denied()
  const same=(run:TaskRun)=>run.taskId===fixed.taskId&&run.sessionId===sessionId&&run.roleId===fixed.roleId&&run.roleVersion===fixed.roleVersion&&run.agentPresetId===fixed.agentPresetId&&isDeepStrictEqual(run.executor,fixed.executor)&&JSON.parse(run.inputText).task?.title===conversation.title
  if(!same(anchor)||anchor.taskVersion!==fixed.taskVersion||!same(current)||current.taskVersion<anchor.taskVersion)throw denied()
  const run=input.runId===undefined?current:await service.get(owner,{runId:input.runId})
  if(!same(run)||run.taskVersion<anchor.taskVersion||includeDetails&&(await service.sessionRun(owner,{sessionId}))?.id!==current.id)throw denied()
  signal.throwIfAborted()
  const result=includeDetails?await withSubagents(run):run
  signal.throwIfAborted()
  return {schema:'teloa.task-run-session/v1',conversation,anchor,currentRunId:current.id,run:result}
 }
 function handle(endpoint:'task-runs/origin',payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity):Promise<TaskRunOrigin>
 function handle(endpoint:'task-runs/list',payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity):Promise<TaskRun[]>
 function handle(endpoint:'task-runs/session',payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity):Promise<TaskRunSessionRead>
 function handle(endpoint:TaskRunMutationEndpoint,payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity):Promise<TaskRun>
 function handle(endpoint:string,payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity):Promise<TaskRun|TaskRun[]|TaskRunOrigin|TaskRunSourceFollowupCandidate|TaskRunSessionRead>
 async function handle(endpoint:string,payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity):Promise<TaskRun|TaskRun[]|TaskRunOrigin|TaskRunSourceFollowupCandidate|TaskRunSessionRead>{
  if(!taskRunOwnerEndpoints.some(known=>known===endpoint)&&!taskRunEndpoints.some(known=>known===endpoint))throw new WorkError('teloa/not-found','未提供此执行接口。')
  if(endpoint==='task-runs/session')return readSession(payload,signal,true,parentIdentity)
  if(endpoint==='task-runs/origin'){
   const target=taskRunOriginInput(payload);if(parentIdentity)throw new WorkError('teloa/invalid-input','来源读口不接受执行身份。')
   const source=await(await get()).origin(owner,target);signal.throwIfAborted();return source
  }
  if(endpoint==='task-runs/source-followup/get'||endpoint==='task-runs/source-followup/prepare'){
   if(parentIdentity||!ports.inspectSourceFollowup)throw new WorkError('teloa/forbidden','后续核验仅供本人在原告警任务中明确确认。')
   const service=await get()
   if(endpoint==='task-runs/source-followup/get'){
    const {candidate,original}=await service.sourceFollowupTarget(owner,payload)
    await ports.inspectSourceFollowup(original,signal);signal.throwIfAborted();return candidate
   }
   const command=readTaskRunSourceFollowupCommand(payload),inflight=sourcePreparations.get(command.requestId)
   if(inflight){if(!isDeepStrictEqual(inflight.command,command))throw new WorkError('teloa/conflict','该确认请求正在核验其他要求。');const result=await inflight.work;signal.throwIfAborted();return result}
   const operation=async():Promise<TaskRun>=>{
   const original=await service.get(owner,{runId:command.runId})
   const previous=await service.request(owner,{requestId:command.requestId,taskId:original.taskId,expectedTaskVersion:command.expectedTaskVersion})
   if(previous){
    const f=previous.sourceFollowup
    if(!f||f.originalRunId!==command.runId||f.kind!==command.kind||f.disposition?.requestId!==command.dispositionRequestId||f.sourceUpdateId!==command.sourceUpdateId||f.instruction!==command.instruction)throw new WorkError('teloa/conflict','该确认请求已经记录其他核验要求。')
    return withSubagents(previous)
   }
   const {candidate}=await service.sourceFollowupTarget(owner,{runId:command.runId})
   if(candidate.kind!==command.kind||candidate.expectedTaskVersion!==command.expectedTaskVersion||candidate.disposition?.requestId!==command.dispositionRequestId||candidate.sourceUpdateId!==command.sourceUpdateId||!managed?.admitRun)throw new WorkError('teloa/conflict','原任务或后续核验准入已变化，请重新核对。')
   await ports.inspectSourceFollowup!(original,signal);signal.throwIfAborted()
   if(original.permissionMode){if(!ports.checkPermissionMode)throw new WorkError('teloa/unavailable','当前权限模式核对尚未就绪。');await ports.checkPermissionMode(original.permissionMode,signal)}
   if(original.modelPolicyOverride){
    if(!original.modelPolicy||!ports.checkModel)throw new WorkError('teloa/unavailable','本人固定模型核对尚未就绪。')
    await ports.checkModel(original.modelPolicy.primary,signal)
    if(original.modelPolicy.fallback)await ports.checkModel(original.modelPolicy.fallback,signal)
   }
   const f=readTaskRunSourceFollowup({schema:'teloa.task-run-source-followup/v1',kind:candidate.kind,originalNativeRequestId:candidate.originalNativeRequestId,originalInputSha256:candidate.originalInputSha256,originalEvidenceSha256:candidate.originalEvidenceSha256,requestId:command.requestId,taskId:candidate.taskId,taskVersion:candidate.expectedTaskVersion,sessionId:candidate.sessionId,originalRunId:candidate.runId,...(candidate.disposition?{disposition:candidate.disposition}:{}),sourceUpdateId:candidate.sourceUpdateId,sourceTaskVersion:candidate.sourceTaskVersion,sourceEventId:candidate.sourceEventId,reference:candidate.reference,instruction:command.instruction,confirmedAt:new Date().toISOString(),notice:candidate.kind==='unknown-verification'?sourceFollowupNotice:resultFollowupNotice})
   managed.beforeCreate?.(original.sessionId)
   const prepared=await service.prepare(owner,{requestId:f.requestId,taskId:f.taskId,expectedTaskVersion:f.taskVersion,roleId:original.roleId,expectedRoleVersion:original.roleVersion,sessionId:f.sessionId,expectedLinkVersion:original.linkVersion},async()=>{
    await ports.inspectSourceFollowup!(original,signal);return structuredClone(original.skills)
   },async(target,role,database)=>await ports.loadKnowledge?.(target,role.knowledge,signal,role.scopes,database)??[],async(target,role,database)=>await loadTaskKnowledge?.(target,role,database,signal)??[],async()=>{
    if(!ports.resolvePreset||await ports.resolvePreset(original.agentPresetId,signal)!==original.agentPresetId)throw new WorkError('teloa/version-conflict','原会话运行配置已变化。');return original.agentPresetId!
   },ports.prepareModels?role=>ports.prepareModels!(role.runtimeConfig,signal):undefined,(db,lineage)=>managed.admitRun!(db,owner,lineage),{sourceFollowup:f,...(original.permissionMode?{permissionMode:original.permissionMode}:{}),...(original.modelPolicyOverride?{modelPolicy:original.modelPolicy!}:{})})
   return withSubagents(prepared)
   }
   const work=operation(),entry={command:structuredClone(command),work};sourcePreparations.set(command.requestId,entry)
   try{return await work}finally{if(sourcePreparations.get(command.requestId)===entry)sourcePreparations.delete(command.requestId)}
  }
  if(endpoint==='task-runs/dispose-unknown'){
   const command=taskInput(payload,['requestId','runId','acknowledgeUnknown'])
   const validId=(value:unknown)=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
   if(parentIdentity||!validId(command.requestId)||!validId(command.runId)||command.acknowledgeUnknown!==true||Object.keys(command).length!==3)throw new WorkError('teloa/invalid-input','请明确确认保留本次提交结果未知，再结束本次提交。')
   const service=await get(),original=await service.get(owner,{runId:command.runId})
   if(original.state==='submission_unknown'){
    if(original.submissionDisposition?.requestId!==command.requestId)throw new WorkError('teloa/conflict','原提交已经处置，请核对原回执。')
    return withSubagents(original)
   }
   if(original.state!=='submitting'||!ports.disposeSubmission)throw new WorkError('teloa/conflict','当前执行不能按未知提交处置。')
   const driver=new TaskRunDriver(service,ports)
   // 未知提交可能没有可取消的原生轮次；停止失败不是停妥证明。仍由下面的持久身份栅栏
   // 核验原宿主、队列、子级及后台活动，不能让一个通用取消异常永久阻断本人处置。
   try{await driver.stop(owner,{runId:original.id},signal)}catch{signal.throwIfAborted()}
   try{await driver.reconcile(owner,{runId:original.id},signal)}catch{signal.throwIfAborted()}
   const stopped=await service.get(owner,{runId:original.id})
   if(stopped.state!=='submitting')return withSubagents(stopped)
   return withSubagents(await ports.disposeSubmission(stopped,command,signal))
  }
  if(endpoint==='task-runs/retry'){
   const command=taskInput(payload,['runId']);signal.throwIfAborted();const service=await get()
   const parent=await service.conversationParent(owner,{runId:command.runId})
   if(!parent||!parentIdentity||parentIdentity.sessionId!==parent.sessionId||parentIdentity.requestId!==parent.requestId||parentIdentity.roleId!==parent.roleId||parentIdentity.executor!==parent.executor)throw new WorkError('teloa/conflict','此执行归属原交办，请从原交办核对或继续。',{reason:'conversation-work-parent'})
   const origin=await service.origin(owner,{runId:command.runId})
   if(!origin.source||origin.source.stopped||origin.source.sessionId!==parent.sessionId||origin.source.requestId!==parent.requestId)throw new WorkError('teloa/conflict','原交办已停止或来源不可核对，不能新增执行。')
   const failed=await service.get(owner,{runId:command.runId}),original='task-run-'+workRequestChildId(parent.requestId,'run',parent.roleId)
   if(failed.sessionId!==original||(parent.executor==='general'?failed.roleId!==null||failed.executor?.kind!=='owner'||failed.executor.grantId!==parent.requestId:failed.roleId!==parent.roleId))throw new WorkError('teloa/conflict','只能核对原交办的首个失败执行，不会无限创建重试。')
   const requestId=workRequestChildId(parent.requestId,'run-retry:'+failed.id,parent.roleId),sessionId='task-run-'+requestId
   const runs=await service.list(owner,{taskId:failed.taskId}),existing=runs.filter(run=>run.sessionId===sessionId)
   if(existing.length>1)throw new WorkError('teloa/storage-corrupt','原交办重试记录重复。')
   if(existing[0]){
    if(existing[0].roleId!==failed.roleId)throw new WorkError('teloa/storage-corrupt','重试与原固定员工不一致。')
    signal.throwIfAborted();return withSubagents(existing[0])
   }
   if(runs.some(run=>run.id!==failed.id))throw new WorkError('teloa/conflict','原任务已有其他执行，请先核对运行记录。')
   if(failed.evidence?.state==='ended'&&failed.evidence.reason==='completed'&&(await delivery?.read(owner,failed))?.state!=='review-required')throw new WorkError('teloa/conflict','原执行的正式成果仍待核对或已经保存，不能重复执行。')
   if(!subagents||!webAccess)throw new WorkError('teloa/unavailable','执行副作用登记尚未完成核对，不能重复派发。')
   const [children,web]=await Promise.all([subagents.listMany(owner,[failed.id]),webAccess.listMany(owner,[failed.id])])
   await assertSafeTaskRunRetry(failed,ports,signal,{subagents:children.get(failed.id)??[],webAccess:web.get(failed.id)??[]})
   const taskVersion=await service.retryTaskVersion(owner,failed);signal.throwIfAborted()
   const target=await service.preparationTarget(owner,{taskId:failed.taskId,expectedTaskVersion:taskVersion})
   if(failed.lineage&&!ports.prepareRetry)throw new WorkError('teloa/unavailable','整项失败重试的恢复预检尚未就绪。')
   await ports.prepareRetry?.(failed,signal);signal.throwIfAborted()
   payload={requestId,taskId:failed.taskId,expectedTaskVersion:target.taskVersion};endpoint='task-runs/prepare'
  }
  const prepareInput=endpoint==='task-runs/prepare'?{...taskInput(payload,['requestId','taskId','expectedTaskVersion','roleId','expectedRoleVersion','sessionId','expectedLinkVersion','permissionMode','model','selectedMemoryIds'])}:undefined
  if(prepareInput){const ids=readTaskRunMemorySelection(prepareInput.selectedMemoryIds);if(ids===undefined)delete prepareInput.selectedMemoryIds;else prepareInput.selectedMemoryIds=ids}
  const prepareOptions=endpoint==='task-runs/prepare'?readPrepareOptions(payload):undefined
  const oneClick=prepareInput!==undefined&&prepareInput.sessionId===undefined
  taskInput(payload,endpoint==='task-runs/list'?['taskId']:endpoint==='task-runs/prepare'?(oneClick?['requestId','taskId','expectedTaskVersion','permissionMode','model','selectedMemoryIds']:['requestId','taskId','expectedTaskVersion','roleId','expectedRoleVersion','sessionId','expectedLinkVersion','permissionMode','model','selectedMemoryIds']):endpoint==='task-runs/subagents/recover'?['runId','reservationId']:['runId'])
  signal.throwIfAborted()
  const service=await get()
  if(parentIdentity&&endpoint!=='task-runs/prepare'&&endpoint!=='task-runs/start')throw new WorkError('teloa/invalid-input','父交办身份仅用于准备或启动固定执行。')
  if(endpoint==='task-runs/prepare'||endpoint==='task-runs/start'){
   const parent=await service.conversationParent(owner,endpoint==='task-runs/prepare'?{taskId:prepareInput!.taskId}:{runId:taskInput(payload,['runId']).runId})
   const authorized=parent===null?parentIdentity===undefined:parentIdentity?.sessionId===parent.sessionId&&parentIdentity.requestId===parent.requestId&&parentIdentity.roleId===parent.roleId&&parentIdentity.executor===parent.executor
   if(!authorized)throw new WorkError('teloa/conflict','此执行归属原交办，请从原交办核对或继续。',{reason:'conversation-work-parent'})
  }
  if(endpoint==='task-runs/list')return withSubagents(await service.list(owner,payload))
  if(endpoint==='task-runs/subagents/recover'){
   if(!subagents?.recover)throw new WorkError('teloa/unavailable','子 Agent 恢复登记尚未配置。')
   await subagents.recover(owner,payload)
   return withSubagents(await service.get(owner,{runId:taskInput(payload,['runId','reservationId']).runId}))
  }
  const optionsOf=(fixed:PrepareOptions|undefined)=>fixed&&(fixed.permissionMode!==undefined||fixed.model!==undefined)?{...(fixed.permissionMode===undefined?{}:{permissionMode:fixed.permissionMode}),...(fixed.model===undefined?{}:{modelPolicy:{primary:fixed.model}})}:undefined
  const prepare=(input:unknown,fixedAgentPresetId?:string,fixed?:PrepareOptions,reuse=false)=>service.prepare(owner,input,async(sessionId,role,database,industryInstallationIds,previousRun)=>{await ports.check({sessionId,...(previousRun?{previousRun}:{}),...(fixedAgentPresetId?{agentPresetId:fixedAgentPresetId}:role.runtimeConfig?.agentPresetId?{agentPresetId:role.runtimeConfig.agentPresetId}:{}),...(fixed?.permissionMode?{permissionMode:fixed.permissionMode}:{})},signal);return ports.loadSkills?.(sessionId,role.skills,signal,database,industryInstallationIds)},async(target,role,database)=>await ports.loadKnowledge?.(target,role.knowledge,signal,role.scopes,database)??[],async(target,role,database)=>{signal.throwIfAborted();const result=await loadTaskKnowledge?.(target,role,database,signal)??[];signal.throwIfAborted();return result},async(sessionId,agentPresetId,permissionMode)=>{signal.throwIfAborted();if(reuse&&fixedAgentPresetId)return fixedAgentPresetId;if(!ports.prepareSession)throw new TaskRunPresetError('teloa/preset-unavailable','session-create','宿主没有提供运行配置会话创建能力。');const resolved=await ports.prepareSession(sessionId,fixedAgentPresetId??agentPresetId,signal,permissionMode);signal.throwIfAborted();return resolved},ports.prepareModels?role=>ports.prepareModels!(role.runtimeConfig,signal):undefined,managed?.admitRun?(db,lineage)=>managed.admitRun!(db,owner,lineage):undefined,optionsOf(fixed))
  if(prepareOptions?.permissionMode){if(!ports.checkPermissionMode)throw new WorkError('teloa/unavailable','宿主尚未配置权限模式核对能力。');await ports.checkPermissionMode(prepareOptions.permissionMode,signal)}
  if(prepareOptions?.model){if(!ports.checkModel)throw new WorkError('teloa/unavailable','宿主尚未配置模型目录核对能力。');await ports.checkModel(prepareOptions.model,signal)}
  if(endpoint==='task-runs/prepare'){
   managed?.beforeCreate?.(oneClick?'task-run-'+String(prepareInput!.requestId):String(prepareInput!.sessionId))
   // 请求级选择通过 prepareOptions 固定到 Run；身份查询和请求快照只接收原有身份字段。
   const {permissionMode:_permissionMode,model:_model,...command}=prepareInput!
   if(!oneClick)return withSubagents(await prepare(command,undefined,prepareOptions))
   if(!managed||!ports.resolvePreset)throw new WorkError('teloa/unavailable','运行专用会话准备能力未配置。')
   const sessionId='task-run-'+String(command.requestId),previous=await service.request(owner,command)
   if(previous){if(previous.state==='configuration_failed'&&previous.sessionId===sessionId)await managed.conversations.failRunReservation(owner,{requestId:command.requestId,sessionId});return withSubagents(previous)}
   const continued=await service.sourceContinuation(owner,{requestId:command.requestId,taskId:command.taskId,expectedTaskVersion:command.expectedTaskVersion})
   if(continued){
    managed.beforeCreate?.(continued.sessionId)
    const target=await service.preparationTarget(owner,{taskId:command.taskId,expectedTaskVersion:command.expectedTaskVersion})
    if(target.roleId!==continued.roleId||target.roleVersion!==continued.roleVersion||target.agentPresetId!==undefined&&target.agentPresetId!==continued.agentPresetId)throw new WorkError('teloa/version-conflict','原告警的员工或运行配置已变化，请先核对续报。')
    return withSubagents(await prepare({...command,roleId:continued.roleId,expectedRoleVersion:continued.roleVersion,sessionId:continued.sessionId,expectedLinkVersion:continued.linkVersion},continued.agentPresetId,prepareOptions,true))
   }
   const reservation=await managed.conversations.runReservation(owner,{requestId:command.requestId})
   if(reservation?.status==='failed'||reservation&&(!reservation.run||reservation.sessionId!==sessionId||reservation.run.taskId!==command.taskId||reservation.run.taskVersion!==command.expectedTaskVersion))throw new WorkError('teloa/storage-corrupt','运行专用会话预约与固定准备请求不一致。')
   const currentTarget=await service.preparationTarget(owner,{taskId:command.taskId,expectedTaskVersion:command.expectedTaskVersion})
   if(currentTarget.executor?.kind==='owner'&&command.selectedMemoryIds!==undefined)throw new WorkError('teloa/invalid-input','本人执行没有岗位经验选择。')
   if(currentTarget.executor?.kind==='owner')return withSubagents(await prepareOwnerRun(owner,{requestId:String(command.requestId),taskId:String(command.taskId),expectedTaskVersion:Number(command.expectedTaskVersion)},currentTarget,service,ports,managed,signal))
   if(reservation&&(reservation.title!==currentTarget.title||reservation.run!.roleId!==currentTarget.roleId||reservation.run!.roleVersion!==currentTarget.roleVersion||currentTarget.agentPresetId!==undefined&&reservation.run!.agentPresetId!==currentTarget.agentPresetId))throw new WorkError('teloa/storage-corrupt','运行专用会话预约与当前任务负责人不一致。')
   const target=reservation?{taskId:reservation.run!.taskId,taskVersion:reservation.run!.taskVersion,title:reservation.title,roleId:reservation.run!.roleId,roleVersion:reservation.run!.roleVersion,agentPresetId:reservation.run!.agentPresetId}:currentTarget
   const failedInput={requestId:command.requestId,taskId:target.taskId,expectedTaskVersion:target.taskVersion,roleId:target.roleId,expectedRoleVersion:target.roleVersion,sessionId,...(command.selectedMemoryIds===undefined?{}:{selectedMemoryIds:command.selectedMemoryIds})}
   if(target.roleId===null||target.roleVersion===null)throw new WorkError('teloa/forbidden','当前运行需要固定员工身份。')
   let fixedAgentPresetId:string
   if(reservation)fixedAgentPresetId=reservation.run!.agentPresetId
   else try{fixedAgentPresetId=await ports.resolvePreset(target.agentPresetId,signal)}catch(error){signal.throwIfAborted();return withSubagents(await service.failPreparation(owner,failedInput,error))}
   let conversation
   try{conversation=await managed.conversations.createRun(owner,{requestId:command.requestId,title:target.title},{sessionId,taskId:target.taskId,taskVersion:target.taskVersion,roleId:target.roleId,roleVersion:target.roleVersion,agentPresetId:fixedAgentPresetId,signal})}catch(error){signal.throwIfAborted();if(error instanceof TaskRunPresetError){const failed=await service.failPreparation(owner,failedInput,error,fixedAgentPresetId);await managed.conversations.failRunReservation(owner,{requestId:command.requestId,sessionId});return withSubagents(failed)}throw error}
   if(conversation.ownerId!==owner||conversation.requestId!==command.requestId||conversation.title!==target.title||conversation.status!=='ready'||conversation.sessionId!==sessionId||conversation.requestedSessionId!==sessionId||conversation.purpose!=='task-run'||!conversation.run||conversation.run.taskId!==target.taskId||conversation.run.taskVersion!==target.taskVersion||conversation.run.roleId!==target.roleId||conversation.run.roleVersion!==target.roleVersion||conversation.run.agentPresetId!==fixedAgentPresetId)throw new WorkError('teloa/storage-corrupt','运行会话回执与固定准备请求不一致。')
   const link=await managed.links.change(owner,{requestId:command.requestId,kind:'task',objectId:target.taskId,expectedObjectVersion:target.taskVersion,sessionId,expectedLinkVersion:0,action:'link'})
   if(link.kind!=='task'||link.objectId!==target.taskId||link.objectVersion!==target.taskVersion||link.conversationId!==conversation.id||link.sessionId!==sessionId||!link.active)throw new WorkError('teloa/storage-corrupt','运行会话关联回执与固定任务不一致。')
   return withSubagents(await service.prepare(owner,{...failedInput,expectedLinkVersion:link.version},async(sessionId,role,database,industryInstallationIds,previousRun)=>{await ports.check({sessionId,...(previousRun?{previousRun}:{}),agentPresetId:fixedAgentPresetId,...(prepareOptions?.permissionMode?{permissionMode:prepareOptions.permissionMode}:{})},signal);return ports.loadSkills?.(sessionId,role.skills,signal,database,industryInstallationIds)},async(target,role,database)=>await ports.loadKnowledge?.(target,role.knowledge,signal,role.scopes,database)??[],async(target,role,database)=>{signal.throwIfAborted();const result=await loadTaskKnowledge?.(target,role,database,signal)??[];signal.throwIfAborted();return result},async(sessionId,agentPresetId,permissionMode)=>fixedAgentPresetId,ports.prepareModels?role=>ports.prepareModels!(role.runtimeConfig,signal):undefined,managed.admitRun?(db,lineage)=>managed.admitRun!(db,owner,lineage):undefined,optionsOf(prepareOptions)))
  }
  if(endpoint==='task-runs/withdraw')return withSubagents(await service.withdraw(owner,payload))
  const driver=new TaskRunDriver(service,ports)
  if(endpoint==='task-runs/stop')return withSubagents(await driver.stop(owner,payload,signal))
  return withSubagents(await (endpoint==='task-runs/start'?driver.start(owner,payload,signal):driver.reconcile(owner,payload)))
 }
 // 仅宿主内部目录使用；客户端不能借请求参数关闭详情或改变身份校验。
 return Object.assign(handle,{readDirectorySession:(payload:{sessionId:string},signal:AbortSignal)=>readSession(payload,signal,false)})
}
