import {WorkError,readVoiceCallContext,type AssistantVoiceCallContext,type AssistantVoiceCallStartInput,type Conversation} from '@teloa/contract'
import type {ObjectConversationService} from '@teloa/backend'

export type AssistantVoiceContextPorts={
 readConversation:(sessionId:string)=>Promise<Pick<Conversation,'id'|'ownerId'|'sessionId'|'status'|'purpose'>>
 readRequestedRoleId:(sessionId:string)=>Promise<string|null>
 links:Pick<ObjectConversationService,'bySession'>
 readHomeContext?:(sessionId:string)=>Promise<{sessionId:string;scopeId:string;roleId:string|null;version:number}|null>
 assistantEligible?:(sessionId:string)=>Promise<boolean>
}
/** 个人助手是本人普通原会话；general/null 从正式上下文回读，不能由媒体 payload 自报。 */
export async function readAssistantVoiceContext(owner:string,input:AssistantVoiceCallStartInput,ports:AssistantVoiceContextPorts,assertCurrent:()=>void):Promise<AssistantVoiceCallContext>{
 const denied=()=>new WorkError('teloa/forbidden','当前会话不是本人原个人助手会话。')
 if(!ports.readHomeContext||!ports.assistantEligible)throw new WorkError('teloa/unavailable','个人助手语音上下文读口尚未就绪。')
 assertCurrent();const conversation=await ports.readConversation(input.sessionId);assertCurrent()
 if(conversation.ownerId!==owner||conversation.sessionId!==input.sessionId||conversation.status!=='ready'||conversation.purpose!==undefined&&conversation.purpose!=='assistant')throw denied()
 const eligible=await ports.assistantEligible(input.sessionId);assertCurrent();if(eligible!==true)throw denied()
 const home=await ports.readHomeContext(input.sessionId);assertCurrent()
 if(!home||home.sessionId!==input.sessionId||home.scopeId!=='general'||home.roleId!==null)throw denied()
 if(home.version!==input.expectedContextVersion)throw new WorkError('teloa/version-conflict','个人助手原会话上下文已变化，请重新核对。')
 const links=await ports.links.bySession(owner,{sessionId:input.sessionId});assertCurrent()
 const requested=await ports.readRequestedRoleId(input.sessionId);assertCurrent()
 if(requested!==null||links.some(link=>link.kind==='role'&&link.active))throw denied()
 const context=readVoiceCallContext({ownerId:owner,sessionId:input.sessionId,scope:'general',target:'assistant',contextVersion:home.version})
 if(context.target!=='assistant')throw denied()
 return context
}
