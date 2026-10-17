import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import type {GroupTaskBusinessGrant} from '@teloa/backend'
import {WorkError} from '@teloa/contract'
import type {BusinessConversationAuthorizationPorts} from './business-conversation-authorization.ts'
import type {ConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import {readSessionEvents} from './session-events.ts'
import type {TaskToolPolicy} from './task-tool-guard.ts'

export type GroupBusinessTaskAuthorizationPorts=Pick<BusinessConversationAuthorizationPorts,'owner'|'scopes'>&{
 groupTask?:(db:unknown,sessionId:string)=>Promise<GroupTaskBusinessGrant>
}
/** 群只提供交流上下文；业务权限来自原 Run、当前员工和该项工作固定的单一业务。 */
export async function authorizeGroupBusinessTask(ports:GroupBusinessTaskAuthorizationPorts,exec:Pick<ToolExecution,'agent'|'signal'|'name'>,policy:TaskToolPolicy,db:unknown=null){
 const sessionId=exec.agent?.session.id
 if(!sessionId||!ports.groupTask||exec.agent!.session.header.origin==='subagent')throw new WorkError('teloa/forbidden','员工或任务会话不能使用本人业务权限。')
 if(policy.stopRequested||!policy.allowedTools.includes(exec.name))throw new WorkError('teloa/forbidden','本人没有为这项工作授予该业务工具。')
 const grant=await ports.groupTask(db,sessionId);exec.signal.throwIfAborted()
 if(grant.sessionId!==sessionId||grant.ownerId!==ports.owner||policy.nativeRequestId!==grant.nativeRequestId)throw new WorkError('teloa/forbidden','原工作运行身份不一致。')
 const selected=(await ports.scopes()).filter(item=>item.scope===grant.scope)
 if(selected.length!==1||!selected[0]!.title.trim())throw new WorkError('teloa/forbidden','当前本人已无权访问该业务。')
 return {scope:grant.scope,title:selected[0]!.title,actor:{ownerId:ports.owner,scopeIds:[grant.scope]},fingerprint:grant.fingerprint,task:grant}
}
/** 活动追加不替换原 Run 的指令身份。 */
export function readGroupBusinessTaskInstruction(exec:Pick<ToolExecution,'agent'>,grant:GroupTaskBusinessGrant):ConversationInstructionIdentity{
 const session=exec.agent!.session,event=readSessionEvents(session).find(row=>row.type==='user/message'&&row.surfaceOp==='append'&&(row.data as {source?:{rpcId?:string}}).source?.rpcId===grant.nativeRequestId)
 if(!event||event.type!=='user/message')throw new WorkError('teloa/forbidden','原工作输入不可核对。')
 return {sessionId:session.id,messageId:event.data.id,seq:event.seq}
}
