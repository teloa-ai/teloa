import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {createHash} from 'node:crypto'
import {savedArtifactMessage,WorkError,type SavedArtifactMessage} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'
/** 使用固定日志序号，而非当前模型压缩表面或流式片段。 */
export function readNativeArtifactMessage(sessionId:string,events:readonly SessionEvent[],expected:SavedArtifactMessage):SavedArtifactMessage{
 const event=events[expected.seq]
 if(!event||event.seq!==expected.seq||(event.type!=='user/message'&&event.type!=='assistant/message')||event.surfaceOp!=='append')throw new WorkError('teloa/invalid-input','指定原消息不存在或不是可选的原始消息。')
 const message=event.type==='user/message'&&event.data.source.kind==='user'?event.data:event.type==='assistant/message'?event.data.message:undefined
 if(!message||message.id!==expected.messageId||expected.sessionId!==sessionId)throw new WorkError('teloa/invalid-input','原消息身份与来源不一致。')
 const actual=savedArtifactMessage({sessionId,messageId:message.id,seq:event.seq,role:event.type==='user/message'?'user':'assistant',at:new Date(event.time).toISOString(),text:message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),images:message.content.flatMap((block,blockIndex)=>block.type==='image'?[{blockIndex,attachment:block.attachment}]:[]),interrupted:event.type==='assistant/message'&&event.data.interrupted===true,omittedBlocks:message.content.filter(block=>block.type!=='text'&&block.type!=='image').length})
 if(JSON.stringify(actual)!==JSON.stringify(savedArtifactMessage(expected)))throw new WorkError('teloa/version-conflict','选定内容与原消息不一致，请重新读取核对。')
 return actual
}

export type NativePlainTextMessage={sessionId:string;messageId:string;seq:number;role:'user'|'assistant';at:string;selectionHash:string;markdown:string}
type PlainTextSession={id:string;inheritedEventCount:number;snapshotEvents:()=>readonly SessionEvent[];surface?:{nodes:Iterable<number>}}
type PlainTextPointer={messageId:string;seq:number;selectionHash?:string}

/** 从可信原生日志读取一条当前会话内的完整纯文本 append；正文不接受调用方提供。 */
export function readNativePlainTextMessage(session:PlainTextSession,pointer:PlainTextPointer):NativePlainTextMessage{
 if(!Number.isSafeInteger(pointer.seq)||pointer.seq<session.inheritedEventCount)throw new WorkError('teloa/forbidden','继承消息或无效消息不能沉淀为当前会话资料。')
 const event=readSessionEvents(session).find(candidate=>candidate.seq===pointer.seq)
 if(!event||event.seq!==pointer.seq||event.surfaceOp!=='append'||(event.type!=='user/message'&&event.type!=='assistant/message'))throw new WorkError('teloa/invalid-input','指定消息不存在或不是原始追加消息。')
 if(session.surface&&!new Set(session.surface.nodes).has(pointer.seq))throw new WorkError('teloa/version-conflict','指定消息已被替换或不在当前可见会话中。')
 const message=event.type==='user/message'&&event.data.source.kind==='user'?event.data:event.type==='assistant/message'?event.data.message:undefined
 if(!message||message.id!==pointer.messageId||(event.type==='assistant/message'&&event.data.interrupted===true))throw new WorkError('teloa/invalid-input','指定消息身份不符、被中断或不是本人会话内容。')
 if(!message.content.length||message.content.some(block=>block.type!=='text'))throw new WorkError('teloa/invalid-input','首版只能保存完整纯文本消息；图片、附件和工具内容请等待对应来源接入。')
 const markdown=message.content.map(block=>block.type==='text'?block.text:'').join('\n')
 if(!markdown.trim())throw new WorkError('teloa/invalid-input','空白消息不能保存为工作资料。')
 const role=event.type==='user/message'?'user' as const:'assistant' as const,at=new Date(event.time).toISOString()
 const selectionHash=createHash('sha256').update(JSON.stringify([session.id,message.id,event.seq,role,at,markdown])).digest('hex')
 if(pointer.selectionHash!==undefined&&pointer.selectionHash!==selectionHash)throw new WorkError('teloa/version-conflict','消息内容已变化，请重新选择。')
 return {sessionId:session.id,messageId:message.id,seq:event.seq,role,at,selectionHash,markdown}
}
