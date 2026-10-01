import {createHash} from 'node:crypto'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {WorkError} from '@teloa/contract'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {readNativePlainTextMessage,type NativePlainTextMessage} from './native-artifact-message.ts'
import {readSessionEvents} from './session-events.ts'

type ConversationBinding={ownerId:string;sessionId:string;status:'pending'|'ready'}
type MutationSession={id:string;header:{origin?:string};inheritedEventCount:number;snapshotEvents:()=>readonly SessionEvent[];surface?:{nodes:Iterable<number>}}
type UserAppendEvent=Extract<SessionEvent,{type:'user/message'}>&{surfaceOp:'append'}
const isUserAppendEvent=(event:SessionEvent):event is UserAppendEvent=>event.type==='user/message'&&event.surfaceOp==='append'&&event.data.source.kind==='user'
type OrdinaryMutationInput={owner:string;conversation:(sessionId:string)=>Promise<ConversationBinding>;readTaskPolicy:TaskToolPolicyReader;agent?:{session:{id:string;header:{origin?:string}}};signal:AbortSignal}
export type OrdinaryConversationMutationAuthorization={ownerId:string;sessionId:string}
export type ConversationMutationAuthorization={ownerId:string;sessionId:string;instruction:NativePlainTextMessage}
export type ConversationMutationInput={owner:string;conversation:(sessionId:string)=>Promise<ConversationBinding>;readTaskPolicy:TaskToolPolicyReader;agent?:{session:MutationSession};signal:AbortSignal}

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

export async function authorizeConversationMutation(input:ConversationMutationInput):Promise<ConversationMutationAuthorization>{
 const authorization=await authorizeOrdinaryConversationMutation(input,'工作资料保存')
 const session=input.agent!.session
 const events=readSessionEvents(session),turnStarts=events.filter(event=>event.type==='turn/start'),start=turnStarts.at(-1)?.seq
 if(start===undefined||start<session.inheritedEventCount)throw new WorkError('teloa/forbidden','当前会话没有可核验的活跃用户指令。')
 const instructions=events.filter((event):event is UserAppendEvent=>event.seq>start&&isUserAppendEvent(event))
 if(instructions.length!==1)throw new WorkError('teloa/forbidden','当前轮次必须且只能有一条真实用户指令。')
 const event=instructions[0]!,instruction=readNativePlainTextMessage(session,{messageId:event.data.id,seq:event.seq})
 if(input.signal.aborted)throw new WorkError('teloa/conflict','本次工作资料保存操作已取消。')
 return {...authorization,instruction}
}

export function conversationMutationRequestId(authorization:ConversationMutationAuthorization,toolName:string):string{
 const digest=createHash('sha256').update(['teloa-conversation-mutation/v1',authorization.ownerId,authorization.sessionId,authorization.instruction.messageId,String(authorization.instruction.seq),authorization.instruction.selectionHash,toolName].join('\0')).digest('hex')
 return `${digest.slice(0,8)}-${digest.slice(8,12)}-5${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`
}
