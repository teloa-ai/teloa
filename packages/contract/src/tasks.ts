import {readTaskCompletionPolicy,type TaskCompletionPolicy} from './task-completion.ts'
import {WorkError,isRecord} from './index.ts'
export const workTaskStates=['ready','running','paused','waiting','blocked','completed','cancelled'] as const
export type TaskDefinition={title:string;goal:string;scope:string;groupId:string|null;skills:string[];completionPolicy?:TaskCompletionPolicy}
export type WorkExecutor={kind:'owner';grantId:string;grantVersion:number}|{kind:'role';roleId:string;roleVersion:number}
export type TaskExecutor={kind:'unassigned'}|WorkExecutor
export function readWorkExecutor(input:unknown):WorkExecutor{
 const row=taskInput(input,['kind','grantId','grantVersion','roleId','roleVersion'])
 const owner=row.kind==='owner',id=owner?row.grantId:row.roleId,version=owner?row.grantVersion:row.roleVersion
 if(!['owner','role'].includes(String(row.kind))||Object.keys(row).length!==3||typeof id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)||!Number.isSafeInteger(version)||(version as number)<1)throw new WorkError('teloa/invalid-input','执行身份或授权版本不正确。')
 return owner?{kind:'owner',grantId:id,grantVersion:version as number}:{kind:'role',roleId:id,roleVersion:version as number}
}
export type WorkTask=TaskDefinition&{executor?:TaskExecutor;contentVersion?:number;id:string;ownerId:string;version:number;state:typeof workTaskStates[number];assigneeRoleId:string|null;assigneeRoleVersion:number|null;createdAt:string;updatedAt:string}
export type TaskDraftCreateInput={requestId:string;sessionId:string;fields:TaskDefinition;groupName?:string;businessName?:string}
export type TaskDraftCreateReceipt=TaskDraftCreateInput&{task:WorkTask}
export function taskInput(input:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(input)||Object.keys(input).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','任务请求包含未知字段或格式不正确。');return input
}
/** 缺字段按已存任务回落：`groupId` 回落 null，`skills` 回落空列表。 */
function taskGroupId(value:unknown):string|null{
 if(value===undefined||value===null)return null
 if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))throw new WorkError('teloa/invalid-input','关联的协作群身份不合法。')
 return value
}
function taskSkills(value:unknown):string[]{
 if(value===undefined)return []
 if(!Array.isArray(value)||value.length>16)throw new WorkError('teloa/invalid-input','使用技能不合法。')
 const list:string[]=[]
 for(const item of value){
  if(typeof item!=='string')throw new WorkError('teloa/invalid-input','使用技能不合法。')
  const text=item.trim();if(!text||text.length>80)throw new WorkError('teloa/invalid-input','使用技能不合法。')
  if(!list.includes(text))list.push(text)
 }
 return list
}
export function taskDefinition(input:unknown):TaskDefinition{
 const row=taskInput(input,['title','goal','scope','groupId','skills','completionPolicy'])
 const text=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new WorkError('teloa/invalid-input','任务名称、目标或业务身份不合法。');return value.trim()}
 const scope=text(row.scope,128);if(!/^[-a-zA-Z0-9_]+$/.test(scope))throw new WorkError('teloa/invalid-input','业务身份格式不正确。')
 return {title:text(row.title,120),goal:text(row.goal,8000),scope,groupId:taskGroupId(row.groupId),skills:taskSkills(row.skills),...(row.completionPolicy===undefined?{}:{completionPolicy:readTaskCompletionPolicy(row.completionPolicy)})}
}
export type TaskConfigurationFields=Partial<Pick<TaskDefinition,'title'|'goal'|'scope'|'groupId'|'skills'>>
/** 局部定义修改不包含负责人、执行许可、自动结项或运行状态。 */
export function taskConfigurationFields(input:unknown):TaskConfigurationFields{
 const row=taskInput(input,['title','goal','scope','groupId','skills'])
 if(!Object.keys(row).length||Object.values(row).some(value=>value===undefined))throw new WorkError('teloa/invalid-input','请提供实际需要修改的任务定义。')
 const normalized=taskDefinition({title:'任务',goal:'目标',scope:'general',...row})
 return Object.fromEntries(Object.keys(row).sort().map(key=>[key,normalized[key as keyof TaskConfigurationFields]])) as TaskConfigurationFields
}
