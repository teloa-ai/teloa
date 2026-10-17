import {TaskRunPresetError,type TaskRunPreparationTarget,type TaskRunService,type TaskRun} from '@teloa/backend'
import type {TaskRunModelPolicy,TaskToolArgumentRule} from '@teloa/contract'
import {WorkError} from '@teloa/contract'
import type {ManagedTaskRunPreparationPorts} from './task-runs.ts'
import type {TaskRunPorts} from './task-run-driver.ts'

/** 本人工作只负责组装；运行、预算、停止和恢复继续交给原 TaskRunDriver。 */
export async function prepareOwnerRun(owner:string,command:{requestId:string;taskId:string;expectedTaskVersion:number},target:TaskRunPreparationTarget,service:TaskRunService,ports:TaskRunPorts,managed:ManagedTaskRunPreparationPorts,signal:AbortSignal):Promise<TaskRun>{
 if(!target.executor||target.roleId!==null||target.roleVersion!==null||!ports.resolvePreset)throw new WorkError('teloa/forbidden','本人运行身份或宿主配置未就绪。')
 const sessionId='task-run-'+command.requestId,base={...command,executor:target.executor,sessionId},reservation=await managed.conversations.runReservation(owner,{requestId:command.requestId})
 if(reservation&&(reservation.status==='failed'||reservation.sessionId!==sessionId||reservation.run?.taskId!==target.taskId||reservation.run.taskVersion!==target.taskVersion||JSON.stringify(reservation.run.executor)!==JSON.stringify(target.executor)))throw new WorkError('teloa/storage-corrupt','本人运行预约与原工作不一致。')
 let agentPresetId:string|undefined,modelPolicy:TaskRunModelPolicy|undefined
 try{
  agentPresetId=reservation?.run?.agentPresetId??await ports.resolvePreset(target.agentPresetId,signal)
  const conversation=await managed.conversations.createRun(owner,{requestId:command.requestId,title:target.title},{sessionId,taskId:target.taskId,taskVersion:target.taskVersion,roleId:null,roleVersion:null,executor:target.executor,agentPresetId,signal})
  if(conversation.ownerId!==owner||conversation.sessionId!==sessionId||conversation.purpose!=='task-run'||conversation.status!=='ready'||conversation.run?.taskId!==target.taskId||JSON.stringify(conversation.run.executor)!==JSON.stringify(target.executor))throw new TaskRunPresetError('teloa/preset-unavailable','session-receipt','本人专用工作会话回执不一致。')
  await ports.check({sessionId,agentPresetId},signal)
  modelPolicy=await ports.prepareModels?.(target.ownerPlanPolicy?{model:target.ownerPlanPolicy.modelPolicy.primary,...(target.ownerPlanPolicy.modelPolicy.fallback?{fallbackModel:target.ownerPlanPolicy.modelPolicy.fallback}:{})}:undefined,signal)
 }catch(error){
  signal.throwIfAborted()
  const failure={code:error instanceof WorkError?error.code:'teloa/preset-unavailable',stage:error instanceof TaskRunPresetError?error.stage:'session-create' as const,message:error instanceof WorkError?error.message:'本人运行配置暂不可用，请核对模型设置。'}
  const run=await service.prepareOwner(owner,{...base,expectedLinkVersion:0},{...(agentPresetId?{agentPresetId}:{}),configurationError:failure})
  if(reservation||agentPresetId)await managed.conversations.failRunReservation(owner,{requestId:command.requestId,sessionId})
  return run
 }
 const link=await managed.links.change(owner,{requestId:command.requestId,kind:'task',objectId:target.taskId,expectedObjectVersion:target.taskVersion,sessionId,expectedLinkVersion:0,action:'link'})
 signal.throwIfAborted()
 const policy=await ports.prepareOwnerPolicy?.(sessionId,agentPresetId!,signal,{taskId:target.taskId,taskVersion:target.taskVersion,sessionId,linkVersion:link.version,scope:'general'})??{allowedTools:[]}
 return service.prepareOwner(owner,{...base,expectedLinkVersion:link.version},{agentPresetId:agentPresetId!,...(modelPolicy?{modelPolicy}:{}),...policy})
}
