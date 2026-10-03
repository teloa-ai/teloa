import type {Agent,InboxTarget} from '@deepseek-ai/dsh-agent'
import type {SessionEvent,SessionHeader,UserMessage} from '@deepseek-ai/dsh-session'

/** 只在实际 Loop writer 已 flush/read、尚未领取 Inbox 时调用。 */
export type NativeInputCheckpointInput=Readonly<{
 agent:Agent
 turn:number
 step:number
 target:InboxTarget
 signal:AbortSignal
 messages:readonly UserMessage[]
 snapshot:Readonly<{header:Readonly<SessionHeader>;events:readonly SessionEvent[];inheritedEventCount:number}>
 /** 精确最终受理根与物理运行窗口；不能转为新工作授权。 */
 assertCurrent:()=>void
}>

/** 宿主持久确认完成后才返回；异常或取消保留尚未领取的输入。 */
export type NativeInputCheckpoint=(input:NativeInputCheckpointInput)=>Promise<void>
