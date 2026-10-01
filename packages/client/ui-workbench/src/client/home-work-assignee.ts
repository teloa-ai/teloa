import type {TaskAssignee} from './task-api.js'
import type {CollaborationScope} from './collaboration-preview.js'
import type {PreviewRole} from './role-preview.js'
import {roleSupportsScope} from '@teloa/contract'

export type HomeWorkAssigneeOption={id:string;name:string;version:number;scopes:CollaborationScope[]}

export function homeWorkAssigneeOptions(roles:readonly PreviewRole[]):HomeWorkAssigneeOption[]{
  return roles.filter(role=>role.storage==='persistent'&&role.kind==='employee'&&role.state==='active')
    .map(role=>({id:role.id,name:role.name,version:role.version,scopes:[...role.scopes]}))
}

export function resolveHomeWorkAssignee(options:readonly HomeWorkAssigneeOption[],selected:string,scope:CollaborationScope):TaskAssignee|undefined{
  if(selected==='self')return undefined
  const role=options.find(option=>option.id===selected)
  if(!role)throw Error('所选负责人已不可用，请重新选择。')
  if(!roleSupportsScope(role.scopes,scope))throw Error('所选负责人不能接收当前业务的工作。')
  return {roleId:role.id,expectedVersion:role.version}
}
