export type MicrophoneRoot={
 navigator:Pick<Navigator,'mediaDevices'>
 AudioContext:typeof AudioContext
 AudioWorkletNode:typeof AudioWorkletNode
 URL:Pick<typeof URL,'createObjectURL'|'revokeObjectURL'>
 Blob:typeof Blob
}
export type VoiceMicrophone={setMuted:(muted:boolean)=>void;isLive:()=>boolean;close:()=>Promise<void>}
export const voiceAbortError=()=>new DOMException('语音连接已取消。','AbortError')

function abortable<T>(pending:Promise<T>,signal:AbortSignal|undefined,late?:(value:T)=>void):Promise<T>{
 return new Promise((resolve,reject)=>{
  let settled=false
  const abort=()=>{if(!settled){settled=true;reject(voiceAbortError())}}
  signal?.addEventListener('abort',abort,{once:true})
  if(signal?.aborted)abort()
  pending.then(value=>{signal?.removeEventListener('abort',abort);if(settled){late?.(value);return}settled=true;resolve(value)},error=>{signal?.removeEventListener('abort',abort);if(!settled){settled=true;reject(error)}})
 })
}

/** 保留原有语音留言接口；有界 PCM 平均降采样为 16k 单声道 WAV。 */
export function encodeVoiceWav(parts:readonly Float32Array[],rate:number):Uint8Array{
 const samples=parts.reduce((count,part)=>count+part.length,0)
 if(!Number.isFinite(rate)||rate<16000||!samples||samples>rate*16)throw Error('语音采集长度不正确。')
 const input=new Float32Array(samples);let offset=0;for(const part of parts){input.set(part,offset);offset+=part.length}
 const targetRate=16000,length=Math.floor(samples*targetRate/rate),bytes=new Uint8Array(44+length*2),view=new DataView(bytes.buffer)
 const tag=(at:number,value:string)=>{for(let n=0;n<value.length;n++)view.setUint8(at+n,value.charCodeAt(n))}
 tag(0,'RIFF');view.setUint32(4,bytes.length-8,true);tag(8,'WAVE');tag(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,targetRate,true);view.setUint32(28,targetRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,length*2,true)
 for(let n=0;n<length;n++){
  const start=Math.floor(n*rate/targetRate),end=Math.max(start+1,Math.floor((n+1)*rate/targetRate));let sum=0
  for(let at=start;at<Math.min(end,input.length);at++)sum+=input[at]!
  const value=Math.max(-1,Math.min(1,sum/(end-start)));view.setInt16(44+n*2,value<0?value*32768:value*32767,true)
 }
 return bytes
}

const worklet=`class VoiceCapture extends AudioWorkletProcessor{constructor(){super();this.buffer=new Float32Array(2048);this.offset=0}process(inputs){const input=inputs[0]?.[0];if(!input)return true;let at=0;while(at<input.length){const n=Math.min(input.length-at,this.buffer.length-this.offset);this.buffer.set(input.subarray(at,at+n),this.offset);this.offset+=n;at+=n;if(this.offset===this.buffer.length){const samples=this.buffer;this.port.postMessage(samples,[samples.buffer]);this.buffer=new Float32Array(2048);this.offset=0}}return true}}registerProcessor('teloa-voice-capture',VoiceCapture)`

/** AudioWorklet 采集沿用工作台策略；取消先回收资源，迟到授权只能停止轨道。 */
export async function openVoiceMicrophone(onSamples:(samples:Float32Array,rate:number)=>void,options:{signal?:AbortSignal;root?:MicrophoneRoot;onEnded?:()=>void}={}):Promise<VoiceMicrophone>{
 const root=options.root??globalThis as unknown as MicrophoneRoot,signal=options.signal
 if(signal?.aborted)throw voiceAbortError()
 const stream=await abortable(root.navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false}),signal,late=>late.getTracks().forEach(track=>track.stop()))
 let context:AudioContext|undefined,node:AudioWorkletNode|undefined,source:MediaStreamAudioSourceNode|undefined,silence:GainNode|undefined,closed=false,closePromise:Promise<void>|undefined
 const ended=()=>{if(!closed)options.onEnded?.()}
 const close=():Promise<void>=>{
  if(closePromise)return closePromise
  if(!closed){
   closed=true;signal?.removeEventListener('abort',abort)
   for(const track of stream.getTracks()){track.removeEventListener('ended',ended);track.stop()}
   if(node){node.port.onmessage=null;node.disconnect()}source?.disconnect();silence?.disconnect()
  }
  // 采集已停止不代表上下文关闭成功；失败不缓存为永久终态，重试仍关闭原上下文。
  closePromise=Promise.resolve().then(()=>context&&context.state!=='closed'?context.close():undefined).catch(error=>{closePromise=undefined;throw error})
  return closePromise
 }
 const abort=()=>{void close().catch(()=>{})}
 signal?.addEventListener('abort',abort,{once:true})
 try{
  if(signal?.aborted)throw voiceAbortError()
  for(const track of stream.getAudioTracks())track.addEventListener('ended',ended)
  context=new root.AudioContext()
  const url=root.URL.createObjectURL(new root.Blob([worklet],{type:'text/javascript'}))
  try{await abortable(context.audioWorklet.addModule(url),signal)}finally{root.URL.revokeObjectURL(url)}
  if(closed||signal?.aborted)throw voiceAbortError()
  node=new root.AudioWorkletNode(context,'teloa-voice-capture');node.port.onmessage=event=>{if(!closed&&event.data instanceof Float32Array)onSamples(event.data,context!.sampleRate)}
  source=context.createMediaStreamSource(stream);silence=context.createGain();silence.gain.value=0;source.connect(node).connect(silence).connect(context.destination)
  await abortable(context.resume(),signal)
  if(closed||signal?.aborted)throw voiceAbortError()
  const isLive=()=>!closed&&context?.state==='running'&&stream.getAudioTracks().length===1&&stream.getAudioTracks().every(track=>track.readyState==='live')
  if(!isLive())throw Error('麦克风不可用。')
  return {setMuted(muted){if(closed)throw Error('麦克风已关闭。');stream.getAudioTracks().forEach(track=>{track.enabled=!muted})},isLive,close}
 }catch(error){await close().catch(()=>{});throw error}
}

/** 跨采集分片保留平均窗口，避免 44.1k 输入在每个分片边缘丢采样。 */
export function createPCM16Encoder(){
 let sourceRate=0,ratio=1,remaining=1,sum=0
 return {reset(){sourceRate=0;ratio=1;remaining=1;sum=0},encode(samples:Float32Array,rate:number):ArrayBuffer{
  if(!Number.isFinite(rate)||rate<16000||rate>192000||samples.length>16384)throw Error('语音采样不正确。')
  if(rate!==sourceRate){sourceRate=rate;ratio=rate/16000;remaining=ratio;sum=0}
  const bytes=new ArrayBuffer((Math.ceil(samples.length/ratio)+1)*2),view=new DataView(bytes);let offset=0
  for(const raw of samples){
   const sample=Number.isFinite(raw)?Math.max(-1,Math.min(1,raw)):0;let available=1
   while(available>1e-9){
    const used=Math.min(available,remaining);sum+=sample*used;remaining-=used;available-=used
    if(remaining<1e-9){const value=Math.max(-1,Math.min(1,sum/ratio));view.setInt16(offset,value<0?value*32768:value*32767,true);offset+=2;remaining=ratio;sum=0}
   }
  }
  return bytes.slice(0,offset)
 }}
}
