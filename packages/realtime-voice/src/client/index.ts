import {createPCM16Encoder,openVoiceMicrophone,voiceAbortError,type MicrophoneRoot,type VoiceMicrophone} from './microphone.ts'

export type BrowserVoiceRoot=MicrophoneRoot&{WebSocket:typeof WebSocket;location:Pick<Location,'href'|'origin'>}
export type DuplexVoiceFailureReason='provider-unconfigured'|'provider-unavailable'|'microphone-unavailable'|'microphone-denied'|'connection-failed'|'connection-lost'|'authorization-changed'|'media-close-failed'
export type DuplexClientEvent=
 |{type:'phase';phase:'listening'|'recording'|'thinking'|'speaking'}
 |{type:'transcript';text:string}
 |{type:'play-blocked'}
 |{type:'closed'}
 |{type:'error';reason:DuplexVoiceFailureReason}
export type DuplexVoiceEvent=DuplexClientEvent
export type DuplexVoiceClient={close:()=>Promise<void>;setMuted:(muted:boolean)=>Promise<void>;interrupt:()=>void;commit:()=>void;play:()=>Promise<void>}
export type DuplexVoiceOptions={url:string;callId:string;callGeneration:string;token:string;onEvent:(event:DuplexClientEvent)=>void;signal?:AbortSignal;root?:BrowserVoiceRoot}
const reasons:readonly string[]=['provider-unconfigured','provider-unavailable','microphone-unavailable','microphone-denied','connection-failed','connection-lost','authorization-changed','media-close-failed']
const phases:readonly string[]=['listening','recording','thinking','speaking']
class VoiceClientError extends Error{readonly reason:DuplexVoiceFailureReason;constructor(reason:DuplexVoiceFailureReason){super('语音连接暂不可用。');this.name='VoiceClientError';this.reason=reason}}
const generation=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>=0&&Number(value)<=0xffffffff
function attemptClose(action:()=>Promise<void>|undefined):Promise<void>{try{return action()??Promise.resolve()}catch(error){return Promise.reject(error)}}

function resumeContext(context:AudioContext,signal:AbortSignal):Promise<void>{
 return new Promise((resolve,reject)=>{
  let settled=false
  const finish=(error?:VoiceClientError)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);if(error)reject(error);else resolve()}
  const abort=()=>finish(new VoiceClientError('connection-lost')),timer=setTimeout(()=>finish(new VoiceClientError('provider-unavailable')),5000)
  signal.addEventListener('abort',abort,{once:true})
  if(signal.aborted){abort();return}
  try{void context.resume().then(()=>finish(),()=>finish(new VoiceClientError('provider-unavailable')))}catch{finish(new VoiceClientError('provider-unavailable'))}
 })
}

function mediaURL(value:string,root:BrowserVoiceRoot):string{
 const url=new URL(value,root.location.href)
 if(url.protocol==='https:')url.protocol='wss:';else if(url.protocol==='http:')url.protocol='ws:'
 if(!['ws:','wss:'].includes(url.protocol)||url.username||url.password||url.hash)throw new VoiceClientError('connection-failed')
 const origin=new URL(url);origin.protocol=origin.protocol==='wss:'?'https:':'http:'
 if(origin.origin!==root.location.origin)throw new VoiceClientError('connection-failed')
 return url.toString()
}

/** 浏览器只传媒体与控制回执；最终转写的本人授权和会话提交由宿主封口。 */
export async function openDuplexVoice(options:DuplexVoiceOptions):Promise<DuplexVoiceClient>{
 const root=options.root??globalThis as unknown as BrowserVoiceRoot,url=mediaURL(options.url,root),signal=options.signal
 for(const value of [options.callId,options.callGeneration,options.token])if(typeof value!=='string'||!value||value.length>512)throw new VoiceClientError('connection-failed')
 if(signal?.aborted)throw voiceAbortError()
 let microphone:VoiceMicrophone|undefined,player:AudioContext|undefined,socket:WebSocket|undefined,closed=false,ready=false,helloSent=false,muted=false,settled=false,closePromise:Promise<void>|undefined,timeout:ReturnType<typeof setTimeout>|undefined
 let currentGeneration=0,minimumGeneration=0,playAt=0,outputDone=false,reportedPlaying=false,playBlocked=false
 const lifetime=new AbortController()
 const encoder=createPCM16Encoder(),sources=new Map<AudioBufferSourceNode,{generation:number;startAt:number;timer:ReturnType<typeof setTimeout>|undefined}>()
 const emit=(event:DuplexClientEvent)=>{try{options.onEvent(event)}catch{/* 消费方渲染异常不能打断媒体回收。 */}}
 let resolveReady!:(client:DuplexVoiceClient)=>void,rejectReady!:(error:unknown)=>void
 const connected=new Promise<DuplexVoiceClient>((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
 void connected.catch(()=>{})
 const reject=(error:unknown)=>{if(!settled){settled=true;rejectReady(error)}}
 const send=(event:unknown)=>{if(socket?.readyState!==1)throw new VoiceClientError('connection-lost');socket.send(JSON.stringify(event))}
 const clearPlayback=()=>{
  for(const [source,item] of sources){if(item.timer!==undefined)clearTimeout(item.timer);source.onended=null;try{source.stop()}catch{}try{source.disconnect()}catch{}}
  sources.clear();playAt=0;outputDone=false;reportedPlaying=false
 }
 const close=():Promise<void>=>{
  if(closePromise)return closePromise
  closed=true;ready=false
  const closingMicrophone=attemptClose(()=>microphone?.close())
  lifetime.abort();if(timeout!==undefined)clearTimeout(timeout);signal?.removeEventListener('abort',abort);reject(new VoiceClientError('connection-lost'));clearPlayback()
  if(player)player.onstatechange=null
  const closingPlayer=attemptClose(()=>player&&player.state!=='closed'?player.close():undefined)
  closePromise=(async()=>{
   const results=await Promise.allSettled([closingMicrophone,closingPlayer]),failed=results.some(result=>result.status==='rejected')
   if(socket){
    socket.onopen=null;socket.onmessage=null;socket.onerror=null;socket.onclose=null
    if(!failed&&socket.readyState===1)try{send({type:'closed'})}catch{}
    try{socket.close(1000,'closed')}catch{}
   }
   if(failed){emit({type:'error',reason:'media-close-failed'});throw new VoiceClientError('media-close-failed')}
   emit({type:'closed'})
  })().catch(error=>{closePromise=undefined;throw error})
  return closePromise
 }
 const fail=(reason:DuplexVoiceFailureReason)=>{if(closed)return;emit({type:'error',reason});reject(new VoiceClientError(reason));void close().catch(()=>{})}
 const abort=()=>{reject(voiceAbortError());void close().catch(()=>{})}
 signal?.addEventListener('abort',abort,{once:true})
 const idle=()=>{
  if(closed||sources.size||!outputDone)return
  outputDone=false;reportedPlaying=false;send({type:'playback',generation:currentGeneration,state:'idle'})
 }
 const armPlaying=(source:AudioBufferSourceNode)=>{
  const item=sources.get(source);if(!item||item.timer!==undefined||player?.state!=='running')return
  item.timer=setTimeout(()=>{
   item.timer=undefined
   if(closed||!sources.has(source)||item.generation!==currentGeneration||item.generation<minimumGeneration||player?.state!=='running'||reportedPlaying)return
   reportedPlaying=true;try{send({type:'playback',generation:currentGeneration,state:'playing'});emit({type:'phase',phase:'speaking'})}catch{fail('connection-lost')}
  },Math.max(0,(item.startAt-player.currentTime)*1000))
 }
 const markBlocked=()=>{if(!closed&&!playBlocked){playBlocked=true;emit({type:'play-blocked'})}}
 const resumed=()=>{if(closed||player?.state!=='running')return;playBlocked=false;for(const source of sources.keys())armPlaying(source)}
 const play=async()=>{
  if(closed||!player)throw new VoiceClientError('connection-lost')
  try{await resumeContext(player,lifetime.signal);if(closed)throw new VoiceClientError('connection-lost');if(player.state!=='running')throw Error();resumed()}catch{markBlocked();throw new VoiceClientError(closed?'connection-lost':'provider-unavailable')}
 }
 const client:DuplexVoiceClient={close,play,async setMuted(value){
  if(closed||!ready||!microphone)throw new VoiceClientError('connection-lost')
  microphone.setMuted(value);muted=value;encoder.reset();send({type:'mute',muted:value})
 },interrupt(){if(closed||!ready)return;minimumGeneration=currentGeneration+1;clearPlayback();try{send({type:'interrupt'})}catch{fail('connection-lost')}},commit(){if(closed||!ready)return;try{send({type:'commit'})}catch{fail('connection-lost')}}}

 // 播放时钟排程参考 AlexKaiqi/dsh-realtime-voice client.js schedulePCM（MIT）；
 // 生命周期、五秒上限、代次隔离和可信宿主协议由 Teloa 维护，来源声明保留在包许可证中。
 const audio=(data:ArrayBuffer)=>{
  if(!ready||closed||!player)return
  if(data.byteLength<6||data.byteLength%2||data.byteLength>24000*2*5+4){fail('provider-unavailable');return}
  const view=new DataView(data),next=view.getUint32(0,true)
  if(next<minimumGeneration||next<currentGeneration)return
  if(next>currentGeneration){clearPlayback();currentGeneration=next}
  const samples=(data.byteLength-4)/2,duration=samples/24000,now=player.currentTime,startAt=Math.max(playAt,now+(playAt===0 ? .12 : .004))
  if(startAt-now+duration>5+1e-6){fail('provider-unavailable');return}
  const buffer=player.createBuffer(1,samples,24000),channel=buffer.getChannelData(0)
  for(let n=0;n<samples;n++)channel[n]=view.getInt16(4+n*2,true)/32768
  const source=player.createBufferSource();source.buffer=buffer;source.connect(player.destination)
  playAt=startAt+duration;sources.set(source,{generation:next,startAt,timer:undefined})
  source.onended=()=>{const item=sources.get(source);if(!item)return;if(item.timer!==undefined)clearTimeout(item.timer);sources.delete(source);source.disconnect();if(!closed&&next===currentGeneration)try{idle()}catch{fail('connection-lost')}}
  source.start(startAt);armPlaying(source)
 }
 try{
  microphone=await openVoiceMicrophone((samples,rate)=>{
   if(closed||!ready||muted||socket?.readyState!==1)return
   if(socket.bufferedAmount>256*1024){fail('connection-lost');return}
   try{const pcm=encoder.encode(samples,rate);if(pcm.byteLength)socket.send(pcm)}catch{fail('microphone-unavailable')}
  },{signal:lifetime.signal,root,onEnded:()=>fail('microphone-unavailable')})
  if(closed||signal?.aborted){await microphone.close();throw voiceAbortError()}
  player=new root.AudioContext({sampleRate:24000});player.onstatechange=()=>{if(player?.state==='running')resumed();else if(player?.state==='suspended')markBlocked()}
  // 浏览器可能让 resume() 一直等待用户手势；允许先建连并保留显式播放入口。
  try{void player.resume().then(resumed,markBlocked)}catch{markBlocked()}
  await Promise.resolve();if(player.state!=='running')markBlocked()
  if(closed||signal?.aborted)throw voiceAbortError()
  socket=new root.WebSocket(url,'teloa.voice.pcm.v1');socket.binaryType='arraybuffer'
  timeout=setTimeout(()=>fail('connection-failed'),15000)
  socket.onopen=()=>{if(closed)return;try{send({type:'hello',callId:options.callId,callGeneration:options.callGeneration,token:options.token});helloSent=true}catch{fail('connection-failed')}}
  socket.onmessage=event=>{
   if(closed)return
   if(event.data instanceof ArrayBuffer){try{audio(event.data)}catch{fail('provider-unavailable')}return}
   if(typeof event.data!=='string'||event.data.length>24000){fail('provider-unavailable');return}
   let value:Record<string,unknown>;try{const parsed:unknown=JSON.parse(event.data);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error();value=parsed as Record<string,unknown>}catch{fail('provider-unavailable');return}
   if(value.type==='ready'){
    if(!helloSent){fail('connection-failed');return}if(ready)return
    ready=true;if(timeout!==undefined)clearTimeout(timeout);if(!settled){settled=true;resolveReady(client)}emit({type:'phase',phase:'listening'});return
   }
   if(value.type==='close'){void close().catch(()=>{});return}
   if(value.type==='error'){fail(reasons.includes(String(value.reason))?value.reason as DuplexVoiceFailureReason:'provider-unavailable');return}
   if(!ready)return
   if(value.type==='transcript'&&typeof value.text==='string'&&value.text.length<=20000){emit({type:'transcript',text:value.text});return}
   if(value.type==='phase'&&phases.includes(String(value.phase))){emit({type:'phase',phase:value.phase as 'listening'|'recording'|'thinking'|'speaking'});return}
   if(['clear','speech-start','speech-end'].includes(String(value.type))&&generation(value.generation)){
    const next=value.generation;if(next<currentGeneration||next<minimumGeneration)return
    if(value.type==='clear'||next>currentGeneration){clearPlayback();currentGeneration=next}
    if(value.type==='speech-end'){outputDone=true;try{idle()}catch{fail('connection-lost')}}
   }
  }
  socket.onerror=()=>fail(ready?'connection-lost':'connection-failed')
  socket.onclose=()=>fail(ready?'connection-lost':'connection-failed')
  return await connected
 }catch(error){
  const normalized=error instanceof VoiceClientError||error instanceof DOMException&&error.name==='AbortError'?error:new VoiceClientError(error instanceof DOMException&&error.name==='NotAllowedError'?'microphone-denied':'microphone-unavailable')
  reject(normalized);if(!closed){emit({type:'error',reason:normalized instanceof VoiceClientError?normalized.reason:'connection-failed'});await close().catch(()=>{})}
  throw normalized
 }
}
