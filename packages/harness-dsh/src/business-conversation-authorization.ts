import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,isBusinessScopeKey,type BusinessConversationBinding} from '@teloa/contract'
import type {ConversationWorkContext} from '@teloa/backend'
import {authorizeOrdinaryConversationMutation} from './conversation-mutation.ts'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
export type BusinessConversationAuthorizationPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready'}>
 readTaskPolicy:TaskToolPolicyReader
 isRoleConversation:(sessionId:string)=>Promise<boolean>
 isTaskConversation:(sessionId:string)=>Promise<boolean>
 /** 真实bySession必须保留未bind预约，不能将pending降为undefined。 */
 binding:(sessionId:string)=>Promise<BusinessConversationBinding|undefined>
 context:(sessionId:string)=>Promise<ConversationWorkContext|null>
 scopes:()=>Promise<Array<{scope:string;title:string}>>
}
/** 业务读写共用真实本人会话闸；roleId仅为接手偏好，不能代替真实role link。 */
export async function authorizeBusinessConversation(ports:BusinessConversationAuthorizationPorts,exec:Pick<ToolExecution,'agent'|'signal'>,label:string){
 const auth=await authorizeOrdinaryConversationMutation({...ports,...(exec.agent?{agent:exec.agent}:{}),signal:exec.signal},label)
 if(await ports.isRoleConversation(auth.sessionId)||await ports.isTaskConversation(auth.sessionId))throw new WorkError('teloa/forbidden','员工或任务会话不能使用本人业务权限。')
 const binding=await ports.binding(auth.sessionId),context=await ports.context(auth.sessionId)
 if(binding&&(binding.kind!=='daily'||binding.sessionId!==auth.sessionId||binding.draftId!==undefined))throw new WorkError('teloa/forbidden','搭建或尚未绑定的日常会话不能读写正式业务。')
 if(!context||context.sessionId!==auth.sessionId||!isBusinessScopeKey(context.scopeId)||context.scopeId==='general'||binding&&binding.scope!==context.scopeId)throw new WorkError('teloa/forbidden','请在已确定业务范围的本人会话中操作。')
 const scope=context.scopeId,choices=await ports.scopes(),selected=choices.filter(item=>item.scope===scope)
 if(selected.length!==1||typeof selected[0]!.title!=='string'||!selected[0]!.title.trim())throw new WorkError('teloa/forbidden','当前本人已无权访问该业务。')
 exec.signal.throwIfAborted()
 const actor={ownerId:ports.owner,scopeIds:[scope]}
 return {scope,title:selected[0]!.title,actor,fingerprint:JSON.stringify([ports.owner,auth.sessionId,context.scopeId,context.roleId,context.version,binding??null])}
}
