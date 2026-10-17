import {WorkError,type VoiceTranscriptSeal} from '@teloa/contract'
import type {VoiceTransport} from './voice-transport.ts'

export type VoiceConversationState=Readonly<{callId:string;callGeneration:string;turnId:string;playbackGeneration:number;state:'waiting'|'idle'}>
export type VoiceStageTiming=Readonly<{callId:string;callGeneration:string;turnId?:string;requestId?:string;stage:'asr-start'|'asr-completed'|'model-submit'|'final-response-first-text'|'model-completed'|'tts-prefetch-start'|'tts-prefetch-first-pcm'|'tts-start'|'tts-first-pcm'|'audio-first-send';at:number}>
export type VoiceMediaSnapshot=Readonly<{token:string;closing:boolean;muted:boolean;playbackGeneration:number;speech:Readonly<{utteranceId:string;playbackGeneration:number;audio:string}>|null;realtime?:Readonly<{path:string;protocol:'teloa.voice.pcm.v1'}>}>
/** 插件只扩展媒体，不获得任务、模型工具或本人授权写口。 */
export type VoiceMediaAdapter=Readonly<{
 transport:VoiceTransport
 snapshot:(input:unknown)=>VoiceMediaSnapshot|null
 ready:(input:unknown)=>void
 closed:(input:unknown)=>void
 playback:(input:unknown)=>void
 /** 宿主原会话的真实等待/终态通知；不受理文本、模型请求或工作授权。 */
 conversationState?:(input:VoiceConversationState)=>void
 transcribe:(input:unknown)=>Promise<VoiceTranscriptSeal|null>
 readTranscriptSeal:(receipt:string)=>Promise<VoiceTranscriptSeal|null>
 inactiveCalls:()=>readonly Readonly<{callId:string;callGeneration:string}>[]
 dispose:()=>void
}>
const unavailable=()=>new WorkError('teloa/unavailable','语音媒体注册已关闭。')
const invalid=()=>new WorkError('teloa/invalid-input','未找到原通话媒体。')

/** 连接时固定适配器；安装、停用或再次注册都不能迁移正在进行的通话。 */
export function createVoiceMediaRegistry(legacy:VoiceMediaAdapter){
 let current=legacy,disposed=false
 const adapters=new Set([legacy]),calls=new Map<string,{generation:string;media:VoiceMediaAdapter;pending:ReturnType<VoiceTransport['connect']>}>()
 const identity=(value:unknown)=>{
  if(!value||typeof value!=='object'||typeof Reflect.get(value,'callId')!=='string')throw invalid()
  return calls.get(Reflect.get(value,'callId') as string)
 }
 const required=(value:unknown)=>{if(disposed)throw unavailable();const record=identity(value);if(!record)throw invalid();return record.media}
 const transport:VoiceTransport={
  async readiness(){if(disposed)throw unavailable();return current.transport.readiness()},
  connect(input){
   if(disposed)return Promise.reject(unavailable())
   const previous=calls.get(input.callId)
   if(previous)return previous.generation===input.callGeneration?previous.pending:Promise.reject(invalid())
   const media=current
   // 在进入异步 connect 前登记；首个浏览器媒体查询可以读取同一个预约。
   const pending=Promise.resolve().then(()=>media.transport.connect(input))
   calls.set(input.callId,{generation:input.callGeneration,media,pending})
   return pending
  },
  async closePending(input){await required(input).transport.closePending?.(input)},
 }
 return Object.freeze({
  transport,
  attach(media:VoiceMediaAdapter){
   if(disposed)throw unavailable()
   if(current!==legacy||adapters.has(media))throw new WorkError('teloa/conflict','实时语音媒体已经注册。')
   adapters.add(media);current=media;let attached=true
   return ()=>{if(attached&&current===media)current=legacy;attached=false}
  },
  snapshot(input:unknown){if(disposed)throw unavailable();return identity(input)?.media.snapshot(input)??null},
  ready(input:unknown){required(input).ready(input)},
  closed(input:unknown){required(input).closed(input)},
  playback(input:unknown){required(input).playback(input)},
  conversationState(input:VoiceConversationState){if(disposed)return;const record=calls.get(input.callId);if(record?.generation===input.callGeneration)record.media.conversationState?.(input)},
  transcribe(input:unknown){return required(input).transcribe(input)},
  async readTranscriptSeal(receipt:string):Promise<VoiceTranscriptSeal|null>{
   if(disposed)return null
   const used=new Set([...calls.values()].map(call=>call.media))
   for(const media of used){
    const seal=await media.readTranscriptSeal(receipt)
    if(!seal)continue
    const call=calls.get(seal.callId)
    if(call?.media===media&&call.generation===seal.callGeneration)return seal
    throw new WorkError('teloa/forbidden','语音封口不属于原媒体连接。')
   }
   return null
  },
  inactiveCalls(){return [...adapters].flatMap(media=>media.inactiveCalls())},
  dispose(){if(disposed)return;disposed=true;for(const media of adapters)media.dispose();calls.clear();adapters.clear()},
 })
}
