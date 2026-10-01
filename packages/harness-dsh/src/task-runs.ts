import {WorkError,taskInput} from '@teloa/contract'
import type {DigitalRole,WebAccessEntry,TaskRunModelStatus} from '@teloa/contract'
import {TaskRunPresetError,type ConversationService,type ConversationTaskIdentity,type ObjectConversationService,type TaskExecutionScope,type TaskRun,type TaskRunService,type TaskRunSkillDatabase,type TaskRunSubagent} from '@teloa/backend'
import {TaskRunDriver,type TaskRunPorts} from './task-run-driver.ts'
export const taskRunEndpoints=['task-runs/list','task-runs/prepare','task-runs/start','task-runs/reconcile','task-runs/stop','task-runs/withdraw','task-runs/subagents/recover']
export type TaskKnowledgeLoader=(target:TaskExecutionScope,role:DigitalRole,database:TaskRunSkillDatabase,signal:AbortSignal)=>Promise<TaskRun['knowledge']>
export type ManagedTaskRunPreparationPorts={conversations:Pick<ConversationService,'createRun'|'runReservation'|'failRunReservation'>;links:Pick<ObjectConversationService,'change'>}
export type TaskRunSubagentReader={listMany:(owner:string,runIds:readonly string[])=>Promise<Map<string,TaskRunSubagent[]>>;recover?:(owner:string,input:unknown)=>Promise<TaskRunSubagent>}
/** 运行会话是原生资源，令牌估算只在读口附带，不回写或改变 Run 的固定快照。 */
export type TaskRunMeasurementReader={estimate:(sessionId:string)=>Promise<number|undefined>}
/** 与 TaskRunSubagentReader 并列：运行回包内的上网记录读口，同样按 owner 批量核对归属。 */
export type TaskRunWebAccessReader={listMany:(owner:string,runIds:readonly string[])=>Promise<Map<string,WebAccessEntry[]>>}
export type TaskRunModelReader={read:(run:TaskRun)=>Promise<TaskRunModelStatus|undefined>}
export function createTaskRunHandler(owner:string,get:()=>Promise<TaskRunService>,ports:TaskRunPorts,loadTaskKnowledge?:TaskKnowledgeLoader,managed?:ManagedTaskRunPreparationPorts,subagents?:TaskRunSubagentReader,measurements?:TaskRunMeasurementReader,webAccess?:TaskRunWebAccessReader,models?:TaskRunModelReader){
 const withSubagents=async<T extends TaskRun|TaskRun[]>(value:T):Promise<T>=>{
  if(!subagents&&!measurements&&!webAccess&&!models)return value
  const runs=Array.isArray(value)?value:[value],registered=subagents?await subagents.listMany(owner,runs.map(run=>run.id)):new Map<string,TaskRunSubagent[]>()
  const webAccessRegistered=webAccess?await webAccess.listMany(owner,runs.map(run=>run.id)):new Map<string,WebAccessEntry[]>()
  const attached=await Promise.all(runs.map(async run=>{
   const entries=registered.get(run.id),webAccessEntries=webAccessRegistered.get(run.id),estimated=await measurements?.estimate(run.sessionId),contextTokenEstimate=typeof estimated==='number'&&Number.isSafeInteger(estimated)&&estimated>=0&&estimated<=2147483647?estimated:undefined
   const modelStatus=await models?.read(run).catch(()=>({state:'unavailable' as const}))
   return {...run,...(entries?.length?{subagents:entries}:{}),...(webAccessEntries?.length?{webAccess:webAccessEntries}:{}),...(contextTokenEstimate===undefined?{}:{contextTokenEstimate}),...(modelStatus?{modelStatus}:{})}
  }))
  return (Array.isArray(value)?attached:attached[0]!) as T
 }
 return async(endpoint:string,payload:unknown,signal:AbortSignal,parentIdentity?:ConversationTaskIdentity)=>{
  if(!taskRunEndpoints.includes(endpoint))throw new WorkError('teloa/not-found','未提供此执行接口。')
  const prepareInput=endpoint==='task-runs/prepare'?taskInput(payload,['requestId','taskId','expectedTaskVersion','roleId','expectedRoleVersion','sessionId','expectedLinkVersion']):undefined
  const oneClick=prepareInput!==undefined&&prepareInput.sessionId===undefined
  taskInput(payload,endpoint==='task-runs/list'?['taskId']:endpoint==='task-runs/prepare'?(oneClick?['requestId','taskId','expectedTaskVersion']:['requestId','taskId','expectedTaskVersion','roleId','expectedRoleVersion','sessionId','expectedLinkVersion']):endpoint==='task-runs/subagents/recover'?['runId','reservationId']:['runId'])
  signal.throwIfAborted()
  const service=await get()
  if(parentIdentity&&endpoint!=='task-runs/prepare'&&endpoint!=='task-runs/start')throw new WorkError('teloa/invalid-input','父交办身份仅用于准备或启动固定执行。')
  if(endpoint==='task-runs/prepare'||endpoint==='task-runs/start'){
   const parent=await service.conversationParent(owner,endpoint==='task-runs/prepare'?{taskId:prepareInput!.taskId}:{runId:taskInput(payload,['runId']).runId})
   const authorized=parent===null?parentIdentity===undefined:parentIdentity?.sessionId===parent.sessionId&&parentIdentity.requestId===parent.requestId&&parentIdentity.roleId===parent.roleId
   if(!authorized)throw new WorkError('teloa/conflict','此执行归属原交办，请从原交办核对或继续。')
  }
  if(endpoint==='task-runs/list')return withSubagents(await service.list(owner,payload))
  if(endpoint==='task-runs/subagents/recover'){
   if(!subagents?.recover)throw new WorkError('teloa/unavailable','子 Agent 恢复登记尚未配置。')
   await subagents.recover(owner,payload)
   return withSubagents(await service.get(owner,{runId:taskInput(payload,['runId','reservationId']).runId}))
  }
  const prepare=(input:unknown,fixedAgentPresetId?:string)=>service.prepare(owner,input,async(sessionId,role,database,industryInstallationIds)=>{await ports.check({sessionId,...(fixedAgentPresetId?{agentPresetId:fixedAgentPresetId}:role.runtimeConfig?.agentPresetId?{agentPresetId:role.runtimeConfig.agentPresetId}:{})},signal);return ports.loadSkills?.(sessionId,role.skills,signal,database,industryInstallationIds)},async(target,role,database)=>await ports.loadKnowledge?.(target,role.knowledge,signal,role.scopes,database)??[],async(target,role,database)=>{signal.throwIfAborted();const result=await loadTaskKnowledge?.(target,role,database,signal)??[];signal.throwIfAborted();return result},async(sessionId,agentPresetId)=>{signal.throwIfAborted();if(!ports.prepareSession)throw new TaskRunPresetError('teloa/preset-unavailable','session-create','宿主没有提供运行配置会话创建能力。');const resolved=await ports.prepareSession(sessionId,fixedAgentPresetId??agentPresetId,signal);signal.throwIfAborted();return resolved},ports.prepareModels?role=>ports.prepareModels!(role.runtimeConfig,signal):undefined)
  if(endpoint==='task-runs/prepare'){
   if(!oneClick)return withSubagents(await prepare(payload))
   if(!managed||!ports.resolvePreset)throw new WorkError('teloa/unavailable','运行专用会话准备能力未配置。')
   const command=prepareInput!,sessionId='task-run-'+String(command.requestId),previous=await service.request(owner,command)
   if(previous){if(previous.state==='configuration_failed')await managed.conversations.failRunReservation(owner,{requestId:command.requestId,sessionId});return withSubagents(previous)}
   const reservation=await managed.conversations.runReservation(owner,{requestId:command.requestId})
   if(reservation?.status==='failed'||reservation&&(!reservation.run||reservation.sessionId!==sessionId||reservation.run.taskId!==command.taskId||reservation.run.taskVersion!==command.expectedTaskVersion))throw new WorkError('teloa/storage-corrupt','运行专用会话预约与固定准备请求不一致。')
   const currentTarget=await service.preparationTarget(owner,{taskId:command.taskId,expectedTaskVersion:command.expectedTaskVersion})
   if(reservation&&(reservation.title!==currentTarget.title||reservation.run!.roleId!==currentTarget.roleId||reservation.run!.roleVersion!==currentTarget.roleVersion||currentTarget.agentPresetId!==undefined&&reservation.run!.agentPresetId!==currentTarget.agentPresetId))throw new WorkError('teloa/storage-corrupt','运行专用会话预约与当前任务负责人不一致。')
   const target=reservation?{taskId:reservation.run!.taskId,taskVersion:reservation.run!.taskVersion,title:reservation.title,roleId:reservation.run!.roleId,roleVersion:reservation.run!.roleVersion,agentPresetId:reservation.run!.agentPresetId}:currentTarget
   const failedInput={requestId:command.requestId,taskId:target.taskId,expectedTaskVersion:target.taskVersion,roleId:target.roleId,expectedRoleVersion:target.roleVersion,sessionId}
   let fixedAgentPresetId:string
   if(reservation)fixedAgentPresetId=reservation.run!.agentPresetId
   else try{fixedAgentPresetId=await ports.resolvePreset(target.agentPresetId,signal)}catch(error){signal.throwIfAborted();return withSubagents(await service.failPreparation(owner,failedInput,error))}
   let conversation
   try{conversation=await managed.conversations.createRun(owner,{requestId:command.requestId,title:target.title},{sessionId,taskId:target.taskId,taskVersion:target.taskVersion,roleId:target.roleId,roleVersion:target.roleVersion,agentPresetId:fixedAgentPresetId,signal})}catch(error){signal.throwIfAborted();if(error instanceof TaskRunPresetError){const failed=await service.failPreparation(owner,failedInput,error,fixedAgentPresetId);await managed.conversations.failRunReservation(owner,{requestId:command.requestId,sessionId});return withSubagents(failed)}throw error}
   if(conversation.ownerId!==owner||conversation.requestId!==command.requestId||conversation.title!==target.title||conversation.status!=='ready'||conversation.sessionId!==sessionId||conversation.requestedSessionId!==sessionId||conversation.purpose!=='task-run'||!conversation.run||conversation.run.taskId!==target.taskId||conversation.run.taskVersion!==target.taskVersion||conversation.run.roleId!==target.roleId||conversation.run.roleVersion!==target.roleVersion||conversation.run.agentPresetId!==fixedAgentPresetId)throw new WorkError('teloa/storage-corrupt','运行会话回执与固定准备请求不一致。')
   const link=await managed.links.change(owner,{requestId:command.requestId,kind:'task',objectId:target.taskId,expectedObjectVersion:target.taskVersion,sessionId,expectedLinkVersion:0,action:'link'})
   if(link.kind!=='task'||link.objectId!==target.taskId||link.objectVersion!==target.taskVersion||link.conversationId!==conversation.id||link.sessionId!==sessionId||!link.active)throw new WorkError('teloa/storage-corrupt','运行会话关联回执与固定任务不一致。')
   return withSubagents(await service.prepare(owner,{...failedInput,expectedLinkVersion:link.version},async(sessionId,role,database,industryInstallationIds)=>{await ports.check({sessionId,agentPresetId:fixedAgentPresetId},signal);return ports.loadSkills?.(sessionId,role.skills,signal,database,industryInstallationIds)},async(target,role,database)=>await ports.loadKnowledge?.(target,role.knowledge,signal,role.scopes,database)??[],async(target,role,database)=>{signal.throwIfAborted();const result=await loadTaskKnowledge?.(target,role,database,signal)??[];signal.throwIfAborted();return result},async()=>fixedAgentPresetId,ports.prepareModels?role=>ports.prepareModels!(role.runtimeConfig,signal):undefined))
  }
  if(endpoint==='task-runs/withdraw')return withSubagents(await service.withdraw(owner,payload))
  const driver=new TaskRunDriver(service,ports)
  if(endpoint==='task-runs/stop')return withSubagents(await driver.stop(owner,payload,signal))
  return withSubagents(await (endpoint==='task-runs/start'?driver.start(owner,payload,signal):driver.reconcile(owner,payload)))
 }
}
