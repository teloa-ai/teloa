import {createHash} from 'node:crypto'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,parseResourceReferences,parseBusinessRecordReferences} from '@teloa/contract'
import type {ConversationWorkReserveInput} from '@teloa/backend'
import {readConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import {readSessionEvents} from './session-events.ts'
import {SessionSeq,type Session} from '@deepseek-ai/dsh-session'

export type ConversationWorkSourceKey=Pick<ConversationWorkReserveInput,'requestId'|'sessionId'|'messageId'|'messageSeq'>
/** 同一原生本人请求的稳定业务身份；读取固定原消息与受理时共用，不按当前轮次重算。 */
export function conversationWorkRequestId(owner:string,sessionId:string,nativeIdentity:string):string{
 const h=createHash('sha256').update(JSON.stringify(['teloa-work-instruction/v1',owner,sessionId,nativeIdentity])).digest('hex')
 return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`
}
/** 只核指定原消息，不选择最新消息，也不唤醒原 Agent。 */
export function assertOwnerReviewMessage(owner:string,session:Session,expected:{source:ConversationWorkSourceKey;sourceText:string}):void{
 const source=expected.source,seq=SessionSeq(source.messageSeq),event=readSessionEvents(session).find(event=>event.seq===seq)
 if(session.id!==source.sessionId||session.header.origin==='subagent'||!session.isOwnSeq(seq)||![...session.surface.nodes].includes(seq)||!event||event.type!=='user/message'||event.surfaceOp!=='append'||event.data.id!==source.messageId||event.data.source.kind!=='user'||event.data.content.some(block=>block.type!=='text'))throw new WorkError('teloa/forbidden','本人复核来源不是固定的本人原消息。')
 const native='rpcId'in event.data.source&&typeof event.data.source.rpcId==='string'?event.data.source.rpcId:event.data.id
 if(conversationWorkRequestId(owner,session.id,native)!==source.requestId||event.data.content.map(block=>block.type==='text'?block.text:'').join('\n')!==expected.sourceText)throw new WorkError('teloa/forbidden','本人复核来源与原受理消息不一致。')
}
/** 只读同一原生本人消息身份；普通外部引擎入口不因此丢失附件能力。 */
export function sourceInstructionKey(owner:string,exec:Pick<ToolExecution,'agent'>):ConversationWorkSourceKey{
 if(!exec.agent)throw new WorkError('teloa/not-bound','没有真实发起会话。')
 const identity=readConversationInstructionIdentity(exec.agent),session=exec.agent.session
 const event=readSessionEvents(session).find(event=>event.seq===identity.seq)
 if(!event||event.type!=='user/message')throw new WorkError('teloa/forbidden','交办来源不是本人消息。')
 const source=event.data.source,nativeIdentity='rpcId' in source&&typeof source.rpcId==='string'?source.rpcId:event.data.id
 return {requestId:conversationWorkRequestId(owner,session.id,nativeIdentity),sessionId:session.id,messageId:event.data.id,messageSeq:event.seq}
}
export function sourceInstruction(owner:string,exec:Pick<ToolExecution,'agent'>):Pick<ConversationWorkReserveInput,'requestId'|'sessionId'|'messageId'|'messageSeq'|'sourceText'>{
 const identity=sourceInstructionKey(owner,exec)
 const event=readSessionEvents(exec.agent!.session).find(event=>event.seq===identity.messageSeq)
 if(!event||event.type!=='user/message')throw new WorkError('teloa/forbidden','交办来源不是本人消息。')
 if(event.data.content.some(block=>block.type!=='text'))throw new WorkError('teloa/invalid-input','本次输入含尚未接入员工交办的附件或结构化内容，请先把所需内容保存为已授权资料再交办；原会话内容仍保留。')
 const sourceText=event.data.content.map(block=>block.type==='text'?block.text:'').join('\n')
 try{parseResourceReferences(sourceText);parseBusinessRecordReferences(sourceText)}catch{throw new WorkError('teloa/invalid-reference','原指令中的资料或记录引用损坏，请重新选择；未创建任务。')}
 return {...identity,sourceText}
}
