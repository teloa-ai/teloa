import {readAssistantVoiceNoteResult,type AssistantVoiceNoteInput,type AssistantVoiceNoteResult,readVoiceCall,readVoiceCallByRequest,readVoiceReadiness,readVoiceServiceSettings,readVoiceCallEndByRequestResult,readVoiceCallMutedResult,type VoiceCallStartInput} from '@teloa/contract'
export type AssistantVoiceInput=AssistantVoiceNoteInput
export type AssistantVoiceTranscript=AssistantVoiceNoteResult
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
export type VoiceMediaIdentity={callId:string;callGeneration:string}
export type VoiceMediaBinding=VoiceMediaIdentity&{token:string}
export type VoiceRealtimeMedia={path:'/teloa-voice/stream';protocol:'teloa.voice.pcm.v1'}
export type VoiceMediaSnapshot={token:string;closing:boolean;muted:boolean;playbackGeneration:number;speech:{utteranceId:string;playbackGeneration:number;audio:string}|null;realtime?:VoiceRealtimeMedia}
const invalid=()=>new Error('语音媒体回包不正确。')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9-]{36}$/i.test(v)
export function createEmployeeVoiceApi(call:Call){
 return {
  async transcribe(input:AssistantVoiceInput,signal?:AbortSignal):Promise<AssistantVoiceTranscript>{
   const result=readAssistantVoiceNoteResult(await call('voice-input/transcribe',input,signal))
   if(result.requestId!==input.requestId||result.sessionId!==input.sessionId||result.contextVersion!==input.expectedContextVersion)throw invalid()
   return result
  },
  readiness:async()=>readVoiceReadiness(await call('voice-calls/readiness',{})),
  async recognitionReadiness(){
   const {asr}=readVoiceServiceSettings(await call('voice-service/settings',{}))
   return readVoiceReadiness(asr.configured?{status:'ready',providerId:asr.providerId}:{status:'unavailable',providerId:asr.providerId,reason:'provider-unconfigured'})
  },
  start:async(input:VoiceCallStartInput)=>readVoiceCall(await call('voice-calls/start',input)),
  read:async(requestId:string)=>readVoiceCallByRequest(await call('voice-calls/get-by-request',{requestId})),
  end:async(requestId:string)=>readVoiceCallEndByRequestResult(await call('voice-calls/end-by-request',{requestId})),
  interrupt:async(callId:string)=>readVoiceCall(await call('voice-calls/interrupt',{callId})),
  muted:async(input:VoiceMediaIdentity&{muted:boolean})=>readVoiceCallMutedResult(await call('voice-calls/set-muted',input)),
  async media(input:VoiceMediaIdentity):Promise<VoiceMediaSnapshot|null>{
   const v=await call('voice-calls/media',input)
   if(v===null)return null
   if(!v||typeof v!=='object'||Array.isArray(v))throw invalid()
   const r=v as Record<string,unknown>
   const realtime=Object.hasOwn(r,'realtime'),keys=['token','closing','muted','playbackGeneration','speech',...realtime?['realtime']:[]]
   if(Object.keys(r).length!==keys.length||Object.keys(r).some(key=>!keys.includes(key))||!uuid(r.token)||typeof r.closing!=='boolean'||typeof r.muted!=='boolean'||!Number.isSafeInteger(r.playbackGeneration)||Number(r.playbackGeneration)<0)throw invalid()
   if(realtime){
    if(!r.realtime||typeof r.realtime!=='object'||Array.isArray(r.realtime)||r.speech!==null)throw invalid()
    const media=r.realtime as Record<string,unknown>
    if(Object.keys(media).length!==2||media.path!=='/teloa-voice/stream'||media.protocol!=='teloa.voice.pcm.v1')throw invalid()
   }
   if(r.speech!==null){
    if(!r.speech||typeof r.speech!=='object'||Array.isArray(r.speech))throw invalid()
    const speech=r.speech as Record<string,unknown>
    if(Object.keys(speech).length!==3||!uuid(speech.utteranceId)||speech.playbackGeneration!==r.playbackGeneration||typeof speech.audio!=='string'||!speech.audio.length||speech.audio.length>28*1024*1024||speech.audio.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(speech.audio))throw invalid()
   }
   return r as unknown as VoiceMediaSnapshot
  },
  ready:async(input:VoiceMediaBinding)=>{await call('voice-calls/media-ready',input)},
  closed:async(input:VoiceMediaBinding)=>{await call('voice-calls/media-closed',input)},
  async turn(input:{callId:string;commitId:string}){
   const v=await call('voice-calls/turn',input)
   if(!v||typeof v!=='object'||Array.isArray(v))throw invalid()
   const r=v as Record<string,unknown>
   if(Object.keys(r).length!==4||!['unknown','queued','active','ended'].includes(String(r.state))||!['not-ready','queued','suppressed','unknown'].includes(String(r.speech))||typeof r.replyExpected!=='boolean'||r.reason!==null&&typeof r.reason!=='string')throw invalid()
   return r as {state:'unknown'|'queued'|'active'|'ended';speech:string;replyExpected:boolean;reason:string|null}
  },
  playback:async(input:VoiceMediaBinding&{playbackGeneration:number;state:'playing'|'idle'})=>{await call('voice-calls/playback',input)},
  async audio(input:VoiceMediaBinding&{turnId:string;audio:string}){
   const value=await call('voice-calls/audio',input)
   if(!value||typeof value!=='object'||Array.isArray(value))throw invalid()
   const r=value as Record<string,unknown>
   if(Object.keys(r).length!==2||r.text!==null&&typeof r.text!=='string'||r.receipt!==null&&(!r.receipt||typeof r.receipt!=='object'))throw invalid()
   return {text:r.text as string|null,receipt:r.receipt}
  },
 }
}
export type EmployeeVoiceApi=ReturnType<typeof createEmployeeVoiceApi>
