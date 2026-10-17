import {WorkError,type VoiceCallContext,type VoiceFailureReason,type VoiceReadiness,type VoiceTranscriptCandidate} from '@teloa/contract'

export type VoiceTransportEvent=
 |Readonly<VoiceTranscriptCandidate&{type:'transcript-candidate'}>
 |Readonly<{type:'playback';callGeneration:string;playbackGeneration:number;state:'playing'|'idle'}>
 |Readonly<{type:'disconnected';callGeneration:string}>
 |Readonly<{type:'error';callGeneration:string;reason:VoiceFailureReason}>
/** 连接对象不持有 Task/Run 或取消工作端口；signal 只控制媒体资源。 */
export type VoiceConnection=Readonly<{
 interruptPlayback:(input:Readonly<{playbackGeneration:number}>)=>Promise<void>
 /** 只有实际媒体采集/上行状态改变后 resolve；缺少端口不能生成静音成功回执。 */
 setMuted?:(input:Readonly<{muted:boolean;callGeneration:string}>)=>Promise<void>
 /** 只确认当前世代已接收播报；实际播放起止由提供方事件报告。 */
 enqueueSpeech?:(input:Readonly<{utteranceId:string;text:string;callGeneration:string;playbackGeneration:number}>)=>Promise<void>
 /** 宿主原生流的候选首句只可预合成；正式回复匹配后才播放，释放函数不影响已采用音频。 */
 prepareSpeech?:(input:Readonly<{utteranceId:string;text:string;callGeneration:string;playbackGeneration:number}>)=>(()=>void)
 close:()=>Promise<void>
}>
export type VoiceTransportConnectInput=Readonly<{
 callId:string
 callGeneration:string
 roleContext:VoiceCallContext
 signal:AbortSignal
 /** 必须在打开媒体前安装，避免初始事件先于返回连接对象。 */
 onEvent:(event:VoiceTransportEvent)=>void
}>
export type VoiceTransport=Readonly<{
 /** 无麦克风/网络副作用；真实凭据探针由提供方配置流程独立执行。 */
 readiness:()=>Promise<VoiceReadiness>
 /** 只有媒体实际连接后 resolve；close/abort 要立即停止本地上行、播放与缓冲。 */
 connect:(input:VoiceTransportConnectInput)=>Promise<VoiceConnection>
 /** connect 拒绝/取消后，只收尾该原世代实际待关闭媒体；真实物理关闭确认后才 resolve。 */
 closePending?:(input:Readonly<{callId:string;callGeneration:string}>)=>Promise<void>
}>
const failureReasons:readonly VoiceFailureReason[]=['provider-unconfigured','provider-unavailable','microphone-unavailable','microphone-denied','connection-failed','connection-lost','authorization-changed','media-close-failed']
/** 适配器只可上报受限类别，不能把提供方原始异常透传至会话 DTO。 */
export class VoiceTransportFailure extends Error{
 readonly reason:VoiceFailureReason
 constructor(reason:VoiceFailureReason){
  if(!failureReasons.includes(reason))throw new WorkError('teloa/invalid-host-response','语音服务错误类别不正确。')
  super('语音连接暂不可用。');this.name='VoiceTransportFailure';this.reason=reason
 }
}
export function sanitizeVoiceFailure(error:unknown,fallback:VoiceFailureReason='connection-failed'):VoiceFailureReason{
 return error instanceof VoiceTransportFailure&&failureReasons.includes(error.reason)?error.reason:fallback
}
export function createUnavailableVoiceTransport():VoiceTransport{
 return Object.freeze({
  async readiness(){return Object.freeze({status:'unavailable' as const,providerId:null,reason:'provider-unconfigured' as const})},
  async connect(){throw new WorkError('teloa/unavailable','尚未配置可用的语音服务。')},
 })
}
