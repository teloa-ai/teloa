import {createHash} from 'node:crypto'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {WorkError} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {readNativePlainTextMessage,type NativePlainTextMessage} from './native-artifact-message.ts'
import {readSessionEvents} from './session-events.ts'
import type {Session} from '@deepseek-ai/dsh-session'
import {readConversationInstructionIdentity,type ConversationInstructionIdentity} from './conversation-instruction-identity.ts'

type ConversationBinding={ownerId:string;sessionId:string;status:'pending'|'ready'}
type MutationSession={id:string;header:{origin?:string};inheritedEventCount:number;snapshotEvents:()=>readonly SessionEvent[];surface?:{nodes:Iterable<number>}}
type UserAppendEvent=Extract<SessionEvent,{type:'user/message'}>&{surfaceOp:'append'}
const isUserAppendEvent=(event:SessionEvent):event is UserAppendEvent=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'
type OrdinaryMutationInput={owner:string;conversation:(sessionId:string)=>Promise<ConversationBinding>;readTaskPolicy:TaskToolPolicyReader;agent?:{session:{id:string;header:{origin?:string}}};signal:AbortSignal}
export type OrdinaryConversationMutationAuthorization={ownerId:string;sessionId:string}
export type ConversationMutationAuthorization={ownerId:string;sessionId:string;instruction:NativePlainTextMessage}
export type ConversationMutationInput={owner:string;conversation:(sessionId:string)=>Promise<ConversationBinding>;readTaskPolicy:TaskToolPolicyReader;agent?:{session:MutationSession};signal:AbortSignal}
export type ConversationInstructionMutationInput=Omit<ConversationMutationInput,'agent'>&{agent?:{session:Session}}
export type ConversationInstructionMutationAuthorization={ownerId:string;sessionId:string;instruction:ConversationInstructionIdentity}

export function assertConversationInstructionMutationAuthorization(expected:ConversationInstructionMutationAuthorization|undefined,actual:ConversationInstructionMutationAuthorization):void{
 if(!expected||expected.ownerId!==actual.ownerId||expected.sessionId!==actual.sessionId||expected.instruction.sessionId!==actual.instruction.sessionId||expected.instruction.messageId!==actual.instruction.messageId||expected.instruction.seq!==actual.instruction.seq)throw new WorkError('teloa/version-conflict','审核期间本人指令已变化，请按当前指令重新执行本次操作。')
}

/** 能力配置只核验真实用户指令身份，附件、图片和引用不代替也不妨碍本人授权。 */
export async function authorizeConversationInstructionMutation(input:ConversationInstructionMutationInput):Promise<ConversationInstructionMutationAuthorization>{
 if(!input.agent)throw new WorkError('teloa/not-bound','能力管理需要真实本人普通会话。')
 const instruction=readConversationInstructionIdentity(input.agent)
 const authorization=await authorizeOrdinaryConversationMutation(input,'能力管理')
 const actual={...authorization,instruction:readConversationInstructionIdentity(input.agent)}
 assertConversationInstructionMutationAuthorization({...authorization,instruction},actual)
 return {...authorization,instruction}
}

export function conversationInstructionMutationRequestId(authorization:ConversationInstructionMutationAuthorization,toolName:string,callId:unknown):string{
 if(typeof callId!=='string'||!callId.trim()||callId.length>512)throw new WorkError('teloa/invalid-input','能力配置需要真实稳定的工具调用身份。')
 const digest=createHash('sha256').update(['teloa-conversation-instruction-mutation/v1',authorization.ownerId,authorization.sessionId,authorization.instruction.messageId,String(authorization.instruction.seq),toolName,callId].join('\0')).digest('hex')
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}

export async function authorizeOrdinaryConversationMutation(input:OrdinaryMutationInput,label='平台配置'):Promise<OrdinaryConversationMutationAuthorization>{
 if(!input.agent)throw new WorkError('teloa/not-bound',label+'需要真实本人普通会话。')
 if(input.signal.aborted)throw new WorkError('teloa/conflict','本次'+label+'操作已取消。')
 const session=input.agent.session,sessionId=session.id
 if(session.header.origin==='subagent')throw new WorkError('teloa/forbidden','子 Agent 会话不能执行'+label+'。')
 let binding:ConversationBinding,policy:Awaited<ReturnType<TaskToolPolicyReader>>
 try{[binding,policy]=await Promise.all([input.conversation(sessionId),input.readTaskPolicy(sessionId,input.signal)])}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/host-unavailable',label+'服务暂不可用，请重试并先核对目录。')}
 if(binding.ownerId!==input.owner||binding.sessionId!==sessionId||binding.status!=='ready')throw new WorkError('teloa/forbidden','当前会话未绑定为本人可用工作会话。')
 if(policy!==null)throw new WorkError('teloa/forbidden','任务执行会话及其历史会话不能执行'+label+'。')
 if(input.signal.aborted)throw new WorkError('teloa/conflict','本次'+label+'操作已取消。')
 return {ownerId:input.owner,sessionId}
}

/** 轻量检查：最近一条 `turn/start` 之后至少一条真实用户指令（不要求恰好一条）；会话内安装工具用它兜底，不取指令正文。 */
export function hasActiveUserInstruction(session:Pick<MutationSession,'inheritedEventCount'|'snapshotEvents'>&{seq?:number}):boolean{
 const events=readSessionEvents(session),start=events.filter(event=>event.type==='turn/start').at(-1)?.seq
 if(start===undefined||start<session.inheritedEventCount)return false
 return events.some(event=>event.seq>start&&isUserAppendEvent(event))
}

function activeInstruction(session:MutationSession):NativePlainTextMessage{
 const events=readSessionEvents(session),turnStarts=events.filter(event=>event.type==='turn/start'),start=turnStarts.at(-1)?.seq
 if(start===undefined||start<session.inheritedEventCount)throw new WorkError('teloa/forbidden','当前会话没有可核验的活跃用户指令。')
 const instructions=events.filter((event):event is UserAppendEvent=>event.seq>start&&isUserAppendEvent(event))
 if(instructions.length!==1)throw new WorkError('teloa/forbidden','当前轮次必须且只能有一条真实用户指令。')
 const event=instructions[0]!
 return readNativePlainTextMessage(session,{messageId:event.data.id,seq:event.seq})
}

export function assertConversationMutationAuthorization(expected:ConversationMutationAuthorization|undefined,actual:ConversationMutationAuthorization):void{
 if(!expected||expected.ownerId!==actual.ownerId||expected.sessionId!==actual.sessionId||expected.instruction.messageId!==actual.instruction.messageId||expected.instruction.seq!==actual.instruction.seq||expected.instruction.selectionHash!==actual.instruction.selectionHash)throw new WorkError('teloa/version-conflict','审核期间本人指令已变化，请按当前指令重新执行本次操作。')
}

export async function authorizeConversationMutation(input:ConversationMutationInput):Promise<ConversationMutationAuthorization>{
 if(!input.agent)throw new WorkError('teloa/not-bound','工作资料保存需要真实本人普通会话。')
 // 在任何归属/策略异步查询之前固定指令，等待期间不能把旧参数重新绑定到新轮次。
 const instruction=activeInstruction(input.agent.session)
 const authorization=await authorizeOrdinaryConversationMutation(input,'工作资料保存')
 const actual={...authorization,instruction:activeInstruction(input.agent.session)}
 assertConversationMutationAuthorization({...authorization,instruction},actual)
 if(input.signal.aborted)throw new WorkError('teloa/conflict','本次工作资料保存操作已取消。')
 return {...authorization,instruction}
}

export function conversationMutationRequestId(authorization:ConversationMutationAuthorization,toolName:string):string{
 const digest=createHash('sha256').update(['teloa-conversation-mutation/v1',authorization.ownerId,authorization.sessionId,authorization.instruction.messageId,String(authorization.instruction.seq),authorization.instruction.selectionHash,toolName].join('\0')).digest('hex')
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}
