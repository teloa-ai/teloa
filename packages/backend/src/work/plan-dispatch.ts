import {isDeepStrictEqual} from 'node:util'
import {WorkError,type WorkTask} from '@teloa/contract'
import type {TaskService} from './tasks.ts'
import type {PlanOccurrence} from './plan-occurrences.ts'

export type PlanDispatchKey={claimId:string;taskRequestId:string}
export type PlanTaskAssociation=PlanDispatchKey&{taskId:string}
export type PlanDispatchPorts={tasks:Pick<TaskService,'create'>;revalidate:(owner:string,key:PlanDispatchKey)=>Promise<PlanOccurrence>;linkTask:(owner:string,association:PlanTaskAssociation)=>Promise<PlanTaskAssociation>}
export type PlanDispatchResult={occurrence:PlanOccurrence;task:WorkTask;association:PlanTaskAssociation}

const corrupt=()=>new WorkError('teloa/storage-corrupt','持续计划领取、任务请求或派发回执身份不一致，已停止派发。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
function fixedSnapshot(row:PlanOccurrence){
 return {id:row.id,ownerId:row.ownerId,planId:row.planId,planVersion:row.planVersion,configVersion:row.configVersion,occurrenceId:row.occurrenceId,scheduledAt:row.scheduledAt,claimedAt:row.claimedAt,taskRequestId:row.taskRequestId,fields:row.fields,source:row.source,roleVersion:row.roleVersion,taskRequest:row.taskRequest}
}
function checkRequest(row:PlanOccurrence){
 if(!uuid(row.id)||!uuid(row.taskRequestId)||row.taskRequest?.requestId!==row.taskRequestId)throw corrupt()
 if(!isDeepStrictEqual(row.taskRequest.fields,{title:row.fields.title,goal:row.fields.goal,scope:row.fields.scope})||!isDeepStrictEqual(row.taskRequest.assignee,{roleId:row.fields.roleId,expectedVersion:row.roleVersion}))throw corrupt()
}

/**
 * 仅适配现有普通任务服务；待派发记录与失败状态由领取服务保存。
 * revalidate/create 是两个调用，不提供计划暂停的原子保证，暂不接生产调度。
 * 正式装配前须将派发许可与暂停整合；不能跨连接持有角色锁后调用 create。
 */
export class PlanDispatcher{
 readonly ports:PlanDispatchPorts
 constructor(ports:PlanDispatchPorts){this.ports=ports}
 async dispatch(owner:string,occurrence:PlanOccurrence):Promise<PlanDispatchResult>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128||occurrence.ownerId!==owner)throw new WorkError('teloa/forbidden','领取记录不属于当前本人。')
  const fixed=structuredClone(occurrence)
  checkRequest(fixed)
  const key={claimId:fixed.id,taskRequestId:fixed.taskRequestId}
  const verified=await this.ports.revalidate(owner,key)
  if(!isDeepStrictEqual(fixedSnapshot(verified),fixedSnapshot(fixed)))throw corrupt()
  // 失败或回包未知均向上传递；下次仍以领取时保存的 requestId 调用现有幂等 create。
  const task=await this.ports.tasks.create(owner,structuredClone(fixed.taskRequest))
  if(!uuid(task.id)||task.ownerId!==owner)throw corrupt()
  const association={...key,taskId:task.id}
  // linkTask 负责在数据库中核对任务 request_id，并条件关联，不能以当前标题猜任务。
  const linked=await this.ports.linkTask(owner,association)
  if(!isDeepStrictEqual(linked,association))throw corrupt()
  return {occurrence:fixed,task,association}
 }
}
