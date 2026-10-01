import type {Conversation} from '@teloa/contract'
import type {PreviewRole} from './role-preview.js'
import type {PreviewTask} from './task-preview.js'

export type HomeRecentContext={scope:string;owner:string}
type ConversationLink={kind:'task'|'role';objectId:string;sessionId:string;active?:boolean}

const unique=(rows:HomeRecentContext[]):HomeRecentContext|undefined=>{
 const values=[...new Map(rows.map(row=>[row.scope+'\u0000'+row.owner,row])).values()]
 return values.length===1?values[0]:undefined
}

/** 任务自带业务范围与负责人，语境可以直接读出来；首页任务行与会话关联共用这一份判断。 */
export function homeTaskContext(
 task:Pick<PreviewTask,'scope'|'assigneeId'>|undefined,
 roles:readonly Pick<PreviewRole,'id'|'name'>[],
 scopeNames:Readonly<Record<string,string>>,
 selfLabel:string,
 roleId?:string,
):HomeRecentContext|undefined{
 if(!task)return undefined
 const scope=scopeNames[task.scope]
 const ownerId=roleId??task.assigneeId
 const owner=ownerId==='self'?selfLabel:roles.find(role=>role.id===ownerId)?.name
 return scope&&owner?{scope,owner}:undefined
}

/**
 * 首页只展示能由固定运行身份或现有对象关联证明的会话语境。普通会话的 contract
 * scopeIds 目前恒为 general，不能拿它猜业务；多个关联给出不同答案时也退回通用“会话”。
 */
export function homeRecentContext(
 conversation:Conversation,
 links:readonly ConversationLink[],
 tasks:readonly Pick<PreviewTask,'id'|'scope'|'assigneeId'>[],
 roles:readonly Pick<PreviewRole,'id'|'name'|'scopes'>[],
 scopeNames:Readonly<Record<string,string>>,
 selfLabel:string,
):HomeRecentContext|undefined{
 const fromTask=(task:Pick<PreviewTask,'scope'|'assigneeId'>|undefined,roleId?:string)=>homeTaskContext(task,roles,scopeNames,selfLabel,roleId)
 if(conversation.run)return fromTask(tasks.find(task=>task.id===conversation.run!.taskId),conversation.run.roleId)
 const contexts=links.filter(link=>link.sessionId===conversation.sessionId&&link.active!==false).flatMap(link=>{
  if(link.kind==='task'){
   const context=fromTask(tasks.find(task=>task.id===link.objectId))
   return context?[context]:[]
  }
  const role=roles.find(role=>role.id===link.objectId)
  if(!role||role.scopes.length!==1)return []
  const scope=scopeNames[role.scopes[0]!]
  return scope?[{scope,owner:role.name}]:[]
 })
 return unique(contexts)
}
