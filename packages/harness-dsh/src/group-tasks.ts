import {WorkError,groupTaskCreateInput,isGroupTaskSource,taskDefinition,taskInput,workTaskStates,type GroupTaskSource,type WorkTask} from '@teloa/contract'
import type {GroupTaskRecord,GroupTaskService} from '@teloa/backend'

export const groupTaskEndpoints=['groups/tasks/create','groups/tasks/source'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const exact=(value:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)&&!optional.includes(key))||keys.some(key=>!Object.hasOwn(value,key)))throw new WorkError('teloa/invalid-host-response','群消息任务回包格式不正确。');return value as Record<string,unknown>}
const invalid=()=>new WorkError('teloa/invalid-host-response','群消息任务回包与原请求不一致。')

function task(value:unknown,owner:string):WorkTask{
 const row=exact(value,['id','ownerId','title','goal','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'],['groupId','skills'])
 let definition:ReturnType<typeof taskDefinition>
 try{definition=taskDefinition({title:row.title,goal:row.goal,scope:row.scope,groupId:row.groupId,skills:row.skills})}catch{throw invalid()}
 if(!uuid(row.id)||row.ownerId!==owner||!positive(row.version)||!workTaskStates.includes(row.state as never)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt||(row.assigneeRoleId===null?row.assigneeRoleVersion!==null:!uuid(row.assigneeRoleId)||!positive(row.assigneeRoleVersion)))throw invalid()
 return {...definition,id:row.id,ownerId:owner,version:row.version as number,state:row.state as WorkTask['state'],assigneeRoleId:row.assigneeRoleId as string|null,assigneeRoleVersion:row.assigneeRoleVersion as number|null,createdAt:row.createdAt as string,updatedAt:row.updatedAt as string}
}

function source(value:unknown,owner:string):GroupTaskSource{
 if(!isGroupTaskSource(value)||value.ownerId!==owner||!stamp(value.createdAt)||!stamp(value.messageCreatedAt))throw invalid()
 return value
}

export function createGroupTaskHandler(owner:string,get:()=>Promise<Pick<GroupTaskService,'create'|'source'>>){
 return async(endpoint:string,payload:unknown):Promise<GroupTaskRecord|GroupTaskSource|null>=>{
  if(!(groupTaskEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此群消息任务接口。')
  if(endpoint==='groups/tasks/source'){
   const input=taskInput(payload,['taskId'])
   if(!uuid(input.taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
   const result=await (await get()).source(owner,payload)
   if(result===null)return null
   const parsed=source(result,owner)
   if(parsed.taskId.toLowerCase()!==input.taskId.toLowerCase())throw invalid()
   return parsed
  }
  const input=groupTaskCreateInput(payload),result=exact(await (await get()).create(owner,input),['task','source']),savedTask=task(result.task,owner),savedSource=source(result.source,owner)
  if(savedSource.taskId.toLowerCase()!==savedTask.id.toLowerCase()||savedSource.groupId.toLowerCase()!==input.groupId.toLowerCase()||savedSource.messageId.toLowerCase()!==input.messageId.toLowerCase()||savedSource.groupVersion!==input.expectedGroupVersion||savedTask.goal!==input.goal||(input.assignee===undefined?savedTask.assigneeRoleId!==null||savedSource.createdAssignee!==null:savedTask.assigneeRoleId?.toLowerCase()!==input.assignee.roleId.toLowerCase()||savedTask.assigneeRoleVersion!==input.assignee.expectedVersion||savedSource.createdAssignee===null||savedSource.createdAssignee.roleId.toLowerCase()!==input.assignee.roleId.toLowerCase()||savedSource.createdAssignee.roleVersion!==input.assignee.expectedVersion))throw invalid()
  return {task:savedTask,source:savedSource}
 }
}
