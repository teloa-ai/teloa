import {WorkError,isRecord} from './index.ts'
export const workTaskStates=['ready','running','paused','waiting','blocked','completed','cancelled'] as const
export type TaskDefinition={title:string;goal:string;scope:string;groupId:string|null;skills:string[]}
export type WorkTask=TaskDefinition&{id:string;ownerId:string;version:number;state:typeof workTaskStates[number];assigneeRoleId:string|null;assigneeRoleVersion:number|null;createdAt:string;updatedAt:string}
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
 const row=taskInput(input,['title','goal','scope','groupId','skills'])
 const text=(value:unknown,max:number)=>{if(typeof value!=='string'||!value.trim()||value.length>max)throw new WorkError('teloa/invalid-input','任务名称、目标或业务身份不合法。');return value.trim()}
 const scope=text(row.scope,128);if(!/^[-a-zA-Z0-9_]+$/.test(scope))throw new WorkError('teloa/invalid-input','业务身份格式不正确。')
 return {title:text(row.title,120),goal:text(row.goal,8000),scope,groupId:taskGroupId(row.groupId),skills:taskSkills(row.skills)}
}
