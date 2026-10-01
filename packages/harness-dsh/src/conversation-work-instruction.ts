import {createHash} from 'node:crypto'
import type {ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,parseResourceReferences,parseBusinessRecordReferences} from '@teloa/contract'
import type {ConversationWorkReserveInput} from '@teloa/backend'
import {readConversationInstructionIdentity} from './conversation-instruction-identity.ts'
import {readSessionEvents} from './session-events.ts'

export function sourceInstruction(owner:string,exec:Pick<ToolExecution,'agent'>):Pick<ConversationWorkReserveInput,'requestId'|'sessionId'|'messageId'|'messageSeq'|'sourceText'>{
 if(!exec.agent)throw new WorkError('teloa/not-bound','没有真实发起会话。')
 const identity=readConversationInstructionIdentity(exec.agent),session=exec.agent.session
 const event=readSessionEvents(session).find(event=>event.seq===identity.seq)
 if(!event||event.type!=='user/message')throw new WorkError('teloa/forbidden','交办来源不是本人消息。')
 if(event.data.content.some(block=>block.type!=='text'))throw new WorkError('teloa/invalid-input','本次输入含尚未接入员工交办的附件或结构化内容，请先把所需内容保存为已授权资料再交办；原会话内容仍保留。')
 const sourceText=event.data.content.map(block=>block.type==='text'?block.text:'').join('\n')
 try{parseResourceReferences(sourceText);parseBusinessRecordReferences(sourceText)}catch{throw new WorkError('teloa/invalid-reference','原指令中的资料或记录引用损坏，请重新选择；未创建任务。')}
 const source=event.data.source,nativeIdentity='rpcId' in source&&typeof source.rpcId==='string'?source.rpcId:event.data.id
 const h=createHash('sha256').update(JSON.stringify(['teloa-work-instruction/v1',owner,session.id,nativeIdentity])).digest('hex')
 return {requestId:`${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`,sessionId:session.id,messageId:event.data.id,messageSeq:event.seq,sourceText}
}
