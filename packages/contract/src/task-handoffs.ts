import {WorkError} from './index.ts'
import {resourceId,resourceVersion} from './resources.ts'
import {taskDefinition,workTaskStates,type WorkTask} from './tasks.ts'

export type TaskHandoffTarget={kind:'self'}|{kind:'role';roleId:string;expectedRoleVersion:number}
export interface TaskHandoffChangeInput{requestId:string;taskId:string;expectedTaskVersion:number;target:TaskHandoffTarget;note:string}
export type TaskHandoffParty={kind:'self'}|{kind:'role';roleId:string;roleVersion:number}
export interface TaskHandoffChange{requestId:string;taskId:string;baseVersion:number;appliedVersion:number;from:TaskHandoffParty;to:TaskHandoffParty;note:string;createdAt:string}
export interface TaskHandoffChangeResult{task:WorkTask;change:TaskHandoffChange}

const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const exact=(value:Record<string,unknown>,keys:readonly string[],optional:readonly string[]=[])=>keys.every(key=>Object.hasOwn(value,key))&&Object.keys(value).every(key=>keys.includes(key)||optional.includes(key))
const stamp=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))

export function isTaskHandoffTarget(value:unknown):value is TaskHandoffTarget{
 if(!record(value))return false
 return value.kind==='self'?exact(value,['kind']):value.kind==='role'&&exact(value,['kind','roleId','expectedRoleVersion'])&&resourceId(value.roleId)&&resourceVersion(value.expectedRoleVersion)
}

export function readTaskHandoffChangeInput(value:unknown):TaskHandoffChangeInput{
 if(!record(value)||!exact(value,['requestId','taskId','expectedTaskVersion','target','note'])||!resourceId(value.requestId)||!resourceId(value.taskId)||!resourceVersion(value.expectedTaskVersion)||!isTaskHandoffTarget(value.target)||typeof value.note!=='string'||!value.note.trim()||value.note.length>4000)throw new WorkError('teloa/invalid-input','改派目标、版本或交接说明不合法。')
 const target=value.target.kind==='self'?{kind:'self' as const}:{kind:'role' as const,roleId:value.target.roleId.toLowerCase(),expectedRoleVersion:value.target.expectedRoleVersion}
 return {requestId:value.requestId.toLowerCase(),taskId:value.taskId.toLowerCase(),expectedTaskVersion:value.expectedTaskVersion,target,note:value.note.trim()}
}

export function isTaskHandoffParty(value:unknown):value is TaskHandoffParty{
 if(!record(value))return false
 return value.kind==='self'?exact(value,['kind']):value.kind==='role'&&exact(value,['kind','roleId','roleVersion'])&&resourceId(value.roleId)&&resourceVersion(value.roleVersion)
}

export function isTaskHandoffChange(value:unknown):value is TaskHandoffChange{
 if(!record(value)||!exact(value,['requestId','taskId','baseVersion','appliedVersion','from','to','note','createdAt'])||!resourceId(value.requestId)||!resourceId(value.taskId)||!resourceVersion(value.baseVersion)||value.appliedVersion!==value.baseVersion+1||!isTaskHandoffParty(value.from)||!isTaskHandoffParty(value.to)||typeof value.note!=='string'||!value.note||value.note!==value.note.trim()||value.note.length>4000||!stamp(value.createdAt))return false
 if(value.from.kind!==value.to.kind)return true
 if(value.from.kind==='self'||value.to.kind==='self')return false
 return value.from.roleId!==value.to.roleId
}

function isWorkTask(value:unknown):value is WorkTask{
 if(!record(value)||!exact(value,['id','ownerId','title','goal','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'],['groupId','skills']))return false
 try{taskDefinition({title:value.title,goal:value.goal,scope:value.scope,groupId:value.groupId,skills:value.skills})}catch{return false}
 return resourceId(value.id)&&typeof value.ownerId==='string'&&!!value.ownerId&&value.ownerId===value.ownerId.trim()&&value.ownerId.length<=128&&resourceVersion(value.version)&&workTaskStates.some(state=>state===value.state)&&(value.assigneeRoleId===null?value.assigneeRoleVersion===null:resourceId(value.assigneeRoleId)&&resourceVersion(value.assigneeRoleVersion))&&stamp(value.createdAt)&&stamp(value.updatedAt)
}

export function isTaskHandoffChangeResult(value:unknown):value is TaskHandoffChangeResult{
 if(!record(value)||!exact(value,['task','change'])||!isWorkTask(value.task)||!isTaskHandoffChange(value.change)||value.task.id!==value.change.taskId||value.task.version<value.change.appliedVersion)return false
 if(value.task.version!==value.change.appliedVersion)return true
 return value.change.to.kind==='self'?value.task.assigneeRoleId===null&&value.task.assigneeRoleVersion===null:value.task.assigneeRoleId===value.change.to.roleId&&value.task.assigneeRoleVersion===value.change.to.roleVersion
}
