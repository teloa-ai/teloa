import {isRecord,taskDefinition,workTaskStates} from '@teloa/contract'

export const conversationTaskConfigurationToolNames=['teloa_task_configuration_create','teloa_task_configuration_save','teloa_task_materials_add'] as const
export type ConversationTaskConfigurationReceipt={kind:'task';id:string;title:string;revision:string;scope:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
/** 原任务入口仅投影成功工具回执；聊天中的文字与其他本人记录不能制造入口。 */
export function conversationTaskConfigurationReceipt(value:unknown,sessionId?:string,owner='local:teloa-owner'):ConversationTaskConfigurationReceipt|undefined{
 try{
  if(!isRecord(value)||value.schema!=='teloa.task-configuration-result/v1'||!['created','saved'].includes(String(value.operation))||typeof value.sessionId!=='string'||!value.sessionId||sessionId!==undefined&&value.sessionId!==sessionId||value.executionStarted!==false||!isRecord(value.task))return
  const task=value.task
  if(task.ownerId!==owner||!uuid(task.id)||task.id!==value.taskId||task.title!==value.taskName||!Number.isSafeInteger(task.version)||Number(task.version)<1||!workTaskStates.includes(task.state as typeof workTaskStates[number])||typeof task.updatedAt!=='string'||!Number.isFinite(Date.parse(task.updatedAt)))return
  const definition=taskDefinition({title:task.title,goal:task.goal,scope:task.scope,groupId:task.groupId,skills:task.skills,...(task.completionPolicy===undefined?{}:{completionPolicy:task.completionPolicy})})
  return {kind:'task',id:task.id,title:definition.title,revision:task.version+':'+task.updatedAt+':'+task.state,scope:definition.scope}
 }catch{/* 损坏回执保留原生工具详情，不产生可导航的任务入口。 */}
}
