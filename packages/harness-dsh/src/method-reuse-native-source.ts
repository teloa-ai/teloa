import type {Session} from '@deepseek-ai/dsh-session'
import {SessionSeq} from '@deepseek-ai/dsh-session'
import {WorkError,readMethodReuseAcceptedSource} from '@teloa/contract'
import type {MethodReusePorts} from '@teloa/backend'
import {readSessionEvents} from './session-events.ts'

type Ports={
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready';purpose?:string}>
 session:(sessionId:string)=>Promise<Session>
}
/** 只读正式本人原生消息。附件正文、继承消息、工具回执与替换掉的消息均不构成采用意图。 */
export function createMethodReuseMessageReader(owner:string,ports:Ports):MethodReusePorts['readAcceptedMessage']{
 return async(actor,input)=>{
  const expected=readMethodReuseAcceptedSource(input)
  if(actor!==owner)throw new WorkError('teloa/forbidden','方法来源不属于当前本人。')
  const binding=await ports.conversation(expected.sessionId)
  if(binding.ownerId!==owner||binding.sessionId!==expected.sessionId||binding.status!=='ready'||binding.purpose==='task-run')throw new WorkError('teloa/forbidden','方法采用需要本人的普通工作会话。')
  const session=await ports.session(expected.sessionId),seq=SessionSeq(expected.messageSeq)
  if(session.id!==expected.sessionId||session.header.origin==='subagent'||!session.isOwnSeq(seq)||![...session.surface.nodes].includes(seq))throw new WorkError('teloa/source-unavailable','原方法采用消息已不可读取。')
  const event=readSessionEvents(session).find(event=>event.seq===expected.messageSeq)
  if(!event||event.type!=='user/message'||event.surfaceOp!=='append'||event.data.id!==expected.messageId||event.data.source.kind!=='user'||!('rpcId'in event.data.source)||event.data.source.rpcId!==expected.requestId)throw new WorkError('teloa/forbidden','方法采用来源不是固定的本人消息。')
  return {...expected,ownerId:owner,source:{kind:'user',rpcId:expected.requestId},text:event.data.content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n')}
 }
}
