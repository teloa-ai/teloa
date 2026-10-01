import type {Session} from '@deepseek-ai/dsh-session'
import {WorkError} from '@teloa/contract'
import {readSessionEvents} from './session-events.ts'

export type ConversationInstructionIdentity={sessionId:string;messageId:string;seq:number}
/** 调用方先核对真实本人普通 Agent；这里只取原生指令身份，不读取附件或引用正文。 */
export function readConversationInstructionIdentity(agent:{session:Session}):ConversationInstructionIdentity{
 const session=agent.session,events=readSessionEvents(session),start=events.filter(event=>event.type==='turn/start').at(-1)?.seq
 if(start===undefined||start<session.inheritedEventCount)throw new WorkError('teloa/forbidden','当前会话没有可核验的本轮本人指令。')
 const instructions=events.filter(event=>event.seq>start&&event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user')
 if(instructions.length!==1)throw new WorkError('teloa/forbidden','本轮必须恰有一条真实本人指令。')
 const event=instructions[0]!
 if(event.type!=='user/message'||event.seq<session.inheritedEventCount||![...session.surface.nodes].includes(event.seq))throw new WorkError('teloa/forbidden','原本人指令已被替换或继承，请重新发起修改。')
 return {sessionId:session.id,messageId:event.data.id,seq:event.seq}
}
