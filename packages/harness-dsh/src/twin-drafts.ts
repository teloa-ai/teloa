import {createHash} from 'node:crypto'
import {SessionSeq,type Session} from '@deepseek-ai/dsh-session'
import {WorkError,twinDraftHumanEndpoints,type TwinDraftSourceInput,type TwinDraftAdoption} from '@teloa/contract'
import type {TwinDraftService,TwinDraftPorts} from '@teloa/backend'
import {readSessionEvents} from './session-events.ts'

export {twinDraftHumanEndpoints}
type TwinDraftSourceDb=Parameters<NonNullable<TwinDraftPorts['conversation']>>[2]
type Operations=Pick<TwinDraftService,'list'|'get'|'create'|'revise'|'return'|'adopt'|'receipt'>
/** 仅在已认证本人浏览器 on-call 中装配；禁止加入通用 endpointSet、teloaWork.invoke 或模型工具。 */
export function createTwinDraftHandler(owner:string,get:()=>Promise<Operations>,ports:{afterGroupSend?:(adoption:TwinDraftAdoption)=>Promise<void>|void;report?:(error:unknown)=>void}={}){
 return async(endpoint:string,payload:unknown)=>{
  if(!(twinDraftHumanEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此代拟稿接口。')
  const service=await get()
  switch(endpoint){
   case 'twin-drafts/list':return service.list(owner,payload)
   case 'twin-drafts/get':return service.get(owner,payload)
   case 'twin-drafts/create':return service.create(owner,payload)
   case 'twin-drafts/revise':return service.revise(owner,payload)
   case 'twin-drafts/return':return service.return(owner,payload)
   case 'twin-drafts/adopt':{
    const result=await service.adopt(owner,payload)
    // 消息、采用回执与持久唤醒已提交；调度唤醒失败不把发送伪装成失败。
    if(result.receipt.result.kind==='group-message')try{await ports.afterGroupSend?.(result)}catch(error){try{ports.report?.(error)}catch{/* 已提交发送不会因日志端口失败而重发。 */}}
    return result
   }
   case 'twin-drafts/receipt':return service.receipt(owner,payload)
  }
 }
}
export type TwinDraftConversationPorts={
 conversation:(owner:string,sessionId:string,db?:TwinDraftSourceDb)=>Promise<{ownerId:string;sessionId:string;status:string;title?:string}>
 session:(sessionId:string)=>Promise<Session>
}
/** 原文从本人会话固定事件读取，不接受调用方提交文本或作者。继承消息不能冒充本会话来源。 */
export function createTwinDraftConversationReader(ports:TwinDraftConversationPorts){
 return async(owner:string,input:Extract<TwinDraftSourceInput,{kind:'conversation'}>,db?:TwinDraftSourceDb)=>{
  const binding=await ports.conversation(owner,input.sessionId,db)
  if(binding.ownerId!==owner||binding.sessionId!==input.sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','原会话不属于当前本人。')
  const session=await ports.session(input.sessionId),event=readSessionEvents(session).find(e=>e.seq===input.messageSeq)
  if(session.id!==input.sessionId||session.header.origin==='subagent'||!session.isOwnSeq(SessionSeq(input.messageSeq))||![...session.surface.nodes].includes(SessionSeq(input.messageSeq))||!event||event.type!=='user/message'||event.surfaceOp!=='append'||event.data.id!==input.messageId||event.data.source.kind!=='user'||event.data.content.some(block=>block.type!=='text'))throw new WorkError('teloa/forbidden','代拟原文不是当前本人会话的固定文字消息。')
  const text=event.data.content.map(block=>block.type==='text'?block.text:'').join('\n')
  if(!text.trim())throw new WorkError('teloa/source-unavailable','原消息没有可代拟的文字。')
  return {label:binding.title?.trim()||'工作会话',text}
 }
}
export function twinDraftToolRequestId(owner:string,sessionId:string,callId:string):string{
 if(!callId||callId.length>512)throw new WorkError('teloa/invalid-input','保存代拟稿需要稳定工具调用身份。')
 const h=createHash('sha256').update(JSON.stringify(['teloa/twin-draft-tool/v1',owner,sessionId,callId])).digest('hex')
 return h.slice(0,8)+'-'+h.slice(8,12)+'-5'+h.slice(13,16)+'-a'+h.slice(17,20)+'-'+h.slice(20,32)
}
