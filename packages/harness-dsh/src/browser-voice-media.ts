import {createHash,randomUUID} from 'node:crypto'
import {WorkError,type VoiceTranscriptSeal} from '@teloa/contract'
import type {VoiceSpeech} from './voice-service.ts'
import {VoiceTransportFailure,type VoiceTransport,type VoiceTransportConnectInput,type VoiceConnection} from './voice-transport.ts'

type Identity=Readonly<{callId:string;callGeneration:string}>
type Bound=Identity&Readonly<{token:string}>
type Speech=Readonly<{utteranceId:string;playbackGeneration:number;audio:string}>
type Channel={input:VoiceTransportConnectInput;token:string;ready:boolean;closed:boolean;closing:boolean;expired:boolean;muted:boolean;lastSeen:number;generation:number;speech:Speech|null;readyResolve:()=>void;readyReject:(error:unknown)=>void;closeResolve:()=>void;closePromise:Promise<void>;abort:AbortController;speechAbort?:AbortController;turns:Map<string,{hash:string;pending:Promise<VoiceTranscriptSeal|null>}>}
const invalid=()=>new WorkError('teloa/invalid-input','语音媒体请求不正确。')
const stale=()=>new WorkError('teloa/conflict','通话已结束或媒体世代已变化。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function row(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value as Record<string,unknown>
}
/** 本人浏览器媒体桥。输入只有有界 WAV，转写和播报只由宿主产生；不持有任务取消能力。 */
export function createBrowserVoiceMedia(ports:{configured:()=>Promise<boolean>;providerId?:()=>Promise<string>;speech:VoiceSpeech}){
 const channels=new Map<string,Channel>(),seals=new Map<string,VoiceTranscriptSeal>()
 let disposed=false
 const identity=(value:unknown,extra:readonly string[]=[],bound=true)=>{
  const r=row(value,['callId','callGeneration',...bound?['token']:[],...extra])
  if(!uuid(r.callId)||!uuid(r.callGeneration)||bound&&!uuid(r.token))throw invalid()
  const channel=channels.get(r.callId)
  if(!channel||channel.input.callGeneration!==r.callGeneration||bound&&channel.token!==r.token)throw stale()
  return {channel,r}
 }
 const live=(channel:Channel)=>{if(disposed||!channel.ready||channel.closed||channel.closing||channel.abort.signal.aborted||channel.input.signal.aborted)throw stale()}
 const stop=(channel:Channel)=>{
  channel.closing=true;channel.speech=null;channel.speechAbort?.abort();channel.abort.abort()
  channel.readyReject(new VoiceTransportFailure('connection-lost'))
 }
 const heartbeat=setInterval(()=>{
  for(const channel of channels.values())if(!channel.closed&&Date.now()-channel.lastSeen>12000){
   // 无心跳的媒体租约失活：宿主不再接纳音频或播报，不宣称远端麦克风已停止。
   stop(channel);channel.expired=true;channel.closed=true;channel.closeResolve()
   channel.input.onEvent({type:'disconnected',callGeneration:channel.input.callGeneration})
  }
 },2000);heartbeat.unref()
 const close=async(channel:Channel)=>{
  stop(channel)
  if(channel.closed)return
  try{await Promise.race([channel.closePromise,new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(new VoiceTransportFailure('media-close-failed')),5000);timer.unref();void channel.closePromise.then(()=>clearTimeout(timer))})])}
  catch{throw new VoiceTransportFailure('media-close-failed')}
 }
 const transport:VoiceTransport={
  async readiness(){
   // 就绪口径来自当前所选播报厂商；识别凭据由 configured 一并核对。
   const providerId=await ports.providerId?.()??'minimax'
   return await ports.configured()?{status:'ready',providerId}:{status:'unavailable',providerId,reason:'provider-unconfigured'}
  },
  async connect(input){
   if(disposed||input.signal.aborted)throw stale()
   let readyResolve!:()=>void,readyReject!:(error:unknown)=>void,closeResolve!:()=>void
   const ready=new Promise<void>((resolve,reject)=>{readyResolve=resolve;readyReject=reject}),closePromise=new Promise<void>(resolve=>{closeResolve=resolve})
   const channel:Channel={input,token:randomUUID(),ready:false,closed:false,closing:false,expired:false,muted:false,lastSeen:Date.now(),generation:0,speech:null,readyResolve,readyReject,closeResolve,closePromise,abort:new AbortController(),turns:new Map()}
   channels.set(input.callId,channel)
   const abort=()=>stop(channel),timeout=setTimeout(()=>readyReject(new VoiceTransportFailure('connection-failed')),15000);timeout.unref();input.signal.addEventListener('abort',abort,{once:true})
   try{await ready;live(channel)}finally{clearTimeout(timeout);if(channel.closed)input.signal.removeEventListener('abort',abort)}
   const connection:VoiceConnection={
    async close(){await close(channel);input.signal.removeEventListener('abort',abort)},
    async setMuted({muted,callGeneration}){live(channel);if(callGeneration!==input.callGeneration)throw stale();channel.muted=muted},
    async interruptPlayback({playbackGeneration}){live(channel);channel.generation=playbackGeneration;channel.speechAbort?.abort();channel.speech=null},
    async enqueueSpeech({utteranceId,text,callGeneration,playbackGeneration}){
     live(channel);if(callGeneration!==input.callGeneration)throw stale()
     channel.speechAbort?.abort();const control=new AbortController();channel.speechAbort=control;channel.generation=playbackGeneration
     const signal=AbortSignal.any([control.signal,channel.abort.signal,input.signal]),parts:Uint8Array[]=[]
     // 长回复仍保留原会话全文；不截断后伪装成完整语音回答。
     if(text.length>=10000)throw new VoiceTransportFailure('provider-unavailable')
     await ports.speech.speak(text,signal,part=>{parts.push(Uint8Array.from(part))});live(channel);signal.throwIfAborted()
     if(channel.generation!==playbackGeneration)throw stale()
     channel.speech={utteranceId,playbackGeneration,audio:Buffer.concat(parts).toString('base64')}
    },
   }
   return connection
  },
  async closePending(input){const channel=channels.get(input.callId);if(channel?.input.callGeneration===input.callGeneration)await close(channel)},
 }
 return Object.freeze({transport,
  inactiveCalls(){return [...channels.values()].filter(channel=>channel.expired||channel.closed).map(channel=>({callId:channel.input.callId,callGeneration:channel.input.callGeneration}))},
  snapshot(value:unknown){
   const r=row(value,['callId','callGeneration']);if(!uuid(r.callId)||!uuid(r.callGeneration))throw invalid()
   if(!channels.has(r.callId))return null
   const {channel}=identity(value,[],false);channel.lastSeen=Date.now()
   return {token:channel.token,closing:channel.closing,muted:channel.muted,playbackGeneration:channel.generation,speech:channel.speech}
  },
  ready(value:unknown){const {channel}=identity(value);if(channel.closed||channel.closing||channel.input.signal.aborted)throw stale();channel.ready=true;channel.lastSeen=Date.now();channel.readyResolve()},
  closed(value:unknown){const {channel}=identity(value);stop(channel);channel.closed=true;channel.closeResolve()},
  playback(value:unknown){
   const {channel,r}=identity(value,['playbackGeneration','state']);live(channel)
   if(!Number.isSafeInteger(r.playbackGeneration)||!['playing','idle'].includes(String(r.state)))throw invalid()
   if(r.playbackGeneration!==channel.generation||!channel.speech)return
   channel.input.onEvent({type:'playback',callGeneration:channel.input.callGeneration,playbackGeneration:channel.generation,state:r.state as 'playing'|'idle'})
   if(r.state==='idle')channel.speech=null
  },
  async transcribe(value:unknown){
   const {channel,r}=identity(value,['turnId','audio']);live(channel)
   if(channel.muted||!uuid(r.turnId)||typeof r.audio!=='string'||r.audio.length>700000||r.audio.length%4||!/^[A-Za-z0-9+/]+={0,2}$/.test(r.audio))throw invalid()
   const audio=Buffer.from(r.audio,'base64'),hash=createHash('sha256').update(audio).digest('hex'),previous=channel.turns.get(r.turnId)
   if(previous){if(previous.hash!==hash)throw stale();return previous.pending}
   if(channel.turns.size>=100)throw new WorkError('teloa/conflict','通话已达到本次轮次数，请结束后重新拨打。')
   const signal=AbortSignal.any([channel.abort.signal,channel.input.signal]),turnId=r.turnId
   const pending=(async()=>{
    const transcript=await ports.speech.transcribe(audio,'wav',signal);live(channel);signal.throwIfAborted();if(channel.muted)throw stale()
    if(!transcript)return null
    if(transcript.audioSha256!==hash)throw new VoiceTransportFailure('provider-unavailable')
    const receipt=randomUUID(),seal:VoiceTranscriptSeal=Object.freeze({...channel.input.roleContext,callId:channel.input.callId,callGeneration:channel.input.callGeneration,turnId,speaker:'owner',revision:1,text:transcript.text,closed:true,complete:true,producerReceipt:receipt,source:Object.freeze({kind:'sealed-audio-stt',providerId:transcript.providerId??'minimax',audioSha256:hash,sealReceiptId:randomUUID(),sttReceiptId:transcript.receiptId})})
    seals.set(receipt,seal);return seal
   })();channel.turns.set(turnId,{hash,pending});return pending
  },
  async readTranscriptSeal(receipt:string){return seals.get(receipt)??null},
  dispose(){disposed=true;clearInterval(heartbeat);for(const channel of channels.values())stop(channel)},
 })
}
