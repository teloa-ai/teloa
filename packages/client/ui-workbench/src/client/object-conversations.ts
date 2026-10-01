import type {Conversation} from '@teloa/contract'
export type ConversationObject={kind:'role'|'task';id:string;title:string;version:number;canStart:boolean}
export type ObjectConversationLink={kind:ConversationObject['kind'];objectId:string;objectVersion:number;conversationId:string;sessionId:string;scopeId?:string}
export function linkObjectConversation(links:readonly ObjectConversationLink[],object:ConversationObject,conversation:Conversation,scopeId?:string):ObjectConversationLink[]{
 if(!object.canStart)throw Error('当前对象已暂停或结束，不能新增会话关联。')
 if(conversation.status!=='ready')throw Error('工作会话尚未就绪。')
 const existing=links.find(link=>link.kind===object.kind&&link.objectId===object.id&&link.conversationId===conversation.id)
 if(existing){if(existing.sessionId!==conversation.sessionId)throw Error('会话身份不一致。');return [...links]}
 return [...links,{kind:object.kind,objectId:object.id,objectVersion:object.version,conversationId:conversation.id,sessionId:conversation.sessionId,...(scopeId?{scopeId}:{})}]
}
export function unlinkObjectConversation(links:readonly ObjectConversationLink[],object:ConversationObject,conversationId:string){return links.filter(link=>!(link.kind===object.kind&&link.objectId===object.id&&link.conversationId===conversationId))}
