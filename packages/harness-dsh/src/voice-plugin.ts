import type {VoiceCall,VoiceFailureReason} from '@teloa/contract'
import type {VoiceMediaAdapter} from './voice-media-registry.ts'
import type {VoiceSpeech,VoicePcmSession} from './voice-service.ts'
export type {VoicePcmSession} from './voice-service.ts'
export type {VoiceMediaAdapter,VoiceMediaSnapshot,VoiceConversationState,VoiceStageTiming} from './voice-media-registry.ts'
import type {VoiceStageTiming} from './voice-media-registry.ts'
export type {VoiceTransport,VoiceTransportConnectInput,VoiceConnection} from './voice-transport.ts'
export type VoiceActivityDetector=Readonly<{predict:(pcm:Int16Array)=>Promise<number>;reset:()=>void;close:()=>Promise<void>}>

/** 仅本机受信插件可持有此对象；不经 RPC 或模型工具暴露。 */
export type TeloaVoicePluginPort=Readonly<{
 speech:VoiceSpeech
 speakPcm:VoiceSpeech['speak']
 /** 通话专属流式播报会话；凭据始终留在宿主，不经媒体端口暴露。 */
 openPcmSession?:(signal:AbortSignal)=>Promise<VoicePcmSession|null>
 /** 每路独立人声检测；只读已准备的本机模型，没有模型时保留原媒体路径。 */
 openVad?:()=>Promise<VoiceActivityDetector|null>
 configured:()=>Promise<boolean>
 providerId:()=>Promise<string>
 attach:(media:VoiceMediaAdapter)=>(()=>void)
 acceptTranscript:(receipt:string,expectedPlaybackGeneration:number)=>Promise<unknown>
 /** 仅内部阶段时间与关联键，禁止传入转写、模型正文、音频或凭据。 */
 recordTiming?:(input:VoiceStageTiming)=>void
 interrupt:(callId:string)=>Promise<VoiceCall>
 end:(callId:string)=>Promise<VoiceCall>
 failure:(reason:VoiceFailureReason)=>Error
}>
declare module '@deepseek-ai/cordis'{interface Context{teloaVoice:TeloaVoicePluginPort}}
