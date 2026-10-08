import type {TaskAssignee} from './task-api.js'
import type {CollaborationScope} from './collaboration-preview.js'
import {canReceiveTask,type PreviewRole} from './role-preview.ts'

export type HomeWorkAssigneeOption={id:string;name:string;version:number;scopes:CollaborationScope[];kind?:PreviewRole['kind'];workAccess?:PreviewRole['workAccess']}
type HomeWorkAssigneeSource=Pick<PreviewRole,'id'|'name'|'version'|'kind'|'state'|'scopes'|'storage'|'workAccess'>
export const canReceiveHomeWorkAssignee=(role:HomeWorkAssigneeOption,scope:string)=>canReceiveTask({...role,kind:role.kind??'employee',state:'active'},scope)

export function homeWorkAssigneeOptions(roles:readonly HomeWorkAssigneeSource[]):HomeWorkAssigneeOption[]{
  return roles.filter(role=>role.storage==='persistent'&&(canReceiveTask(role,'general')||role.scopes.some(scope=>canReceiveTask(role,scope))))
    .map(role=>({id:role.id,name:role.name,version:role.version,scopes:[...role.scopes],...(role.kind==='twin'?{kind:'twin' as const,workAccess:role.workAccess}:{})}))
}

export function resolveHomeWorkAssignee(options:readonly HomeWorkAssigneeOption[],selected:string,scope:CollaborationScope):TaskAssignee|undefined{
  if(selected==='self')return undefined
  const role=options.find(option=>option.id===selected)
  if(!role)throw Error('所选负责人已不可用，请重新选择。')
  if(!canReceiveHomeWorkAssignee(role,scope))throw Error('所选负责人不能接收当前业务的工作。')
  return {roleId:role.id,expectedVersion:role.version}
}
