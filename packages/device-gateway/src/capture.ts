import {createOpusDecoder} from './audio-codecs.ts'
import {createPcmTurn,createPcmWindowAdapter,type SealedPcmTurn} from './audio-turn.ts'
import {createSileroVad} from './silero-vad.ts'

/** 只接受网关已校验、排队的 Opus 载荷；封口与半句丢弃分别通知宿主。 */
export async function createDeviceAudioCapture(ports:Readonly<{
 captureId:string;modelPath:string;signal:AbortSignal
 onSealed:(turn:SealedPcmTurn)=>void;onDiscard:(reason:'no-speech'|'too-short')=>void
}>){
 ports.signal.throwIfAborted()
 const vad=await createSileroVad(ports.modelPath)
 let decoder:ReturnType<typeof createOpusDecoder>
 try{ports.signal.throwIfAborted();decoder=createOpusDecoder()}catch(error){await vad.close();throw error}
 let closed=false,closing:Promise<void>|undefined
 const cleanup=()=>{
  if(closed)return closing!
  closed=true;clearInterval(timer);ports.signal.removeEventListener('abort',abort)
  adapter.reset();decoder.close();closing=vad.close();return closing
 }
 const turn=createPcmTurn({captureId:ports.captureId,onSealed:sealed=>{
  void cleanup().catch(()=>{});ports.onSealed(sealed)
 },onDiscard:discarded=>{
  void cleanup().catch(()=>{})
  if(discarded.reason!=='aborted')ports.onDiscard(discarded.reason)
 }})
 const adapter=createPcmWindowAdapter({predict:vad.predict,onWindow:turn.push})
 const abort=()=>{turn.abort();void cleanup().catch(()=>{})}
 const timer=setInterval(()=>{try{if(!closed)turn.poll()}catch{abort()}},50);timer.unref()
 ports.signal.addEventListener('abort',abort,{once:true})
 if(ports.signal.aborted)abort()
 return Object.freeze({
  async push(packet:Uint8Array){
   if(closed)return
   try{ports.signal.throwIfAborted();await adapter.push(decoder.decode(packet))}catch(error){abort();throw error}
  },
  async stop(){
   if(closed)return
   try{ports.signal.throwIfAborted();await adapter.flush();if(!closed)turn.stop()}catch(error){abort();throw error}
  },abort,
  async close(){abort();await closing},
 })
}
