import {resourceId,resourceScopes,resourceVersion} from './resources.ts'
import {taskDefinition,workTaskStates,type WorkTask} from './tasks.ts'

export type TaskMaterialRef={
 id:string
 taskId:string
 taskVersion:number
 resourceId:string
 resourceVersion:number
 title:string
 sourceId:string
 sourceVersion:string
 scopeIds:string[]
 available:boolean
 createdAt:string
}

export type TaskMaterialResult={task:WorkTask;material:TaskMaterialRef}
export type TaskMaterialAddInput={requestId:string;taskId:string;expectedTaskVersion:number;resourceId:string;expectedResourceVersion:number}

const exact=(value:Record<string,unknown>,keys:readonly string[],optional:readonly string[]=[])=>keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>keys.includes(key)||optional.includes(key))
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))

function isWorkTask(value:unknown):value is WorkTask{
 if(!record(value)||!exact(value,['id','ownerId','title','goal','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'],['groupId','skills']))return false
 try{taskDefinition({title:value.title,goal:value.goal,scope:value.scope,groupId:value.groupId,skills:value.skills})}catch{return false}
 return resourceId(value.id)&&typeof value.ownerId==='string'&&!!value.ownerId&&value.ownerId.length<=128&&resourceVersion(value.version)&&workTaskStates.some(state=>state===value.state)&&(value.assigneeRoleId===null?value.assigneeRoleVersion===null:resourceId(value.assigneeRoleId)&&resourceVersion(value.assigneeRoleVersion))&&stamp(value.createdAt)&&stamp(value.updatedAt)
}

export function isTaskMaterialRef(value:unknown):value is TaskMaterialRef{
 if(!record(value)||!exact(value,['id','taskId','taskVersion','resourceId','resourceVersion','title','sourceId','sourceVersion','scopeIds','available','createdAt']))return false
 return resourceId(value.id)&&resourceId(value.taskId)&&resourceVersion(value.taskVersion)&&resourceId(value.resourceId)&&resourceVersion(value.resourceVersion)&&typeof value.title==='string'&&!!value.title.trim()&&value.title.length<=200&&typeof value.sourceId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value.sourceId)&&typeof value.sourceVersion==='string'&&/^[a-f0-9]{64}$/.test(value.sourceVersion)&&resourceScopes(value.scopeIds)&&typeof value.available==='boolean'&&stamp(value.createdAt)
}

export function isTaskMaterialList(value:unknown):value is TaskMaterialRef[]{
 if(!Array.isArray(value)||!value.every(isTaskMaterialRef))return false
 const taskId=value[0]?.taskId
 return value.every(item=>item.taskId===taskId)&&new Set(value.map(item=>item.id)).size===value.length&&new Set(value.map(item=>item.resourceId)).size===value.length&&new Set(value.map(item=>item.taskVersion)).size===value.length
}

export function isTaskMaterialResult(value:unknown):value is TaskMaterialResult{
 return record(value)&&exact(value,['task','material'])&&isWorkTask(value.task)&&isTaskMaterialRef(value.material)&&value.task.id===value.material.taskId&&value.task.version===value.material.taskVersion
}

export function isTaskMaterialAddInput(value:unknown):value is TaskMaterialAddInput{
 return record(value)&&exact(value,['requestId','taskId','expectedTaskVersion','resourceId','expectedResourceVersion'])&&resourceId(value.requestId)&&resourceId(value.taskId)&&resourceVersion(value.expectedTaskVersion)&&resourceId(value.resourceId)&&resourceVersion(value.expectedResourceVersion)
}
