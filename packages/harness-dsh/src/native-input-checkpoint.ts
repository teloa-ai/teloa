import type {Agent,InboxTarget} from '@deepseek-ai/dsh-agent'
import type {SessionEvent,SessionHeader,UserMessage} from '@deepseek-ai/dsh-session'

/** 只标识私有实际受理根；这些字段本身不授予新工作或恢复许可。 */
export type NativeInputRoot=Readonly<{sessionId:string;messageId:string;nativeRequestId:string|null;payloadSha256:string}>
export type NativeCheckpointSnapshot=Readonly<{header:Readonly<SessionHeader>;events:readonly SessionEvent[];inheritedEventCount:number}>

/** 只在实际 Loop writer 已 flush/read、尚未领取 Inbox 时调用。 */
export type NativeInputCheckpointInput=Readonly<{
 agent:Agent
 turn:number
 step:number
 target:InboxTarget
 signal:AbortSignal
 messages:readonly UserMessage[]
 snapshot:NativeCheckpointSnapshot
 roots:readonly NativeInputRoot[]
 /** 精确最终受理根与物理运行窗口；不能转为新工作授权。 */
 assertCurrent:()=>void
}>

/** 宿主持久确认完成后才返回；异常或取消保留尚未领取的输入。 */
export type NativeInputCheckpoint=(input:NativeInputCheckpointInput)=>Promise<void>

/** 实际领取、外部派发前与正常收尾，复用同一 writer 的完整持久前缀。 */
export type NativeProgressCheckpointInput=Readonly<{
 phase:'claimed'|'model'|'tools'|'step-end'|'turn-end'
 agent:Agent
 turn:number
 step:number
 signal:AbortSignal
 snapshot:NativeCheckpointSnapshot
 roots:readonly NativeInputRoot[]
 assertCurrent:()=>void
}>
export type NativeProgressCheckpoint=(input:NativeProgressCheckpointInput)=>Promise<void>

/** 官方冷读后、任何恢复写入前的完整候选；只有部署拥有者可以核验持久许可。 */
export type NativeInputRestoreInput=Readonly<{
 sessionId:string
 snapshot:NativeCheckpointSnapshot
 messages:readonly UserMessage[]
 signal:AbortSignal
}>
export type NativeInputRestoreLease=Readonly<{
 roots:readonly NativeInputRoot[]
 /** 仅允许已核验根继续执行；不能据此接纳新输入。 */
 assertCurrent:()=>undefined
}>
export type NativeInputRestore=(input:NativeInputRestoreInput)=>NativeInputRestoreLease|PromiseLike<NativeInputRestoreLease>
