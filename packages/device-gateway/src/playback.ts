import {encodeAudioFrame,type DeviceControl,type HostControl} from './protocol.ts'

type Ports=Readonly<{
 connectionGeneration:number;allocateStream:()=>number;assertCurrent:()=>void;signal:AbortSignal
 sendControl:(message:HostControl)=>void;sendAudio:(bytes:Uint8Array)=>Promise<void>
}>
type Ack=Extract<DeviceControl,{type:'playback.ready'|'playback.progress'|'playback.played'}>
type Active={streamId:number;controller:AbortController;ready:boolean;sent:number;progress:number;ended:boolean;played:boolean;wake:()=>void}
const invalid=()=>new Error('播放流回执不正确或已经失效。')

/** 设备确认消费才推进最多 1980ms；供应商、网络和播放端共享取消边界。 */
export function createPlaybackChannel(ports:Ports){
 let current:Active|undefined,retired=0
 const check=(active:Active)=>{ports.signal.throwIfAborted();active.controller.signal.throwIfAborted();ports.assertCurrent();if(current!==active)throw invalid()}
 const send=(active:Active,message:HostControl)=>{check(active);ports.sendControl(message)}
 const wait=async(active:Active,predicate:()=>boolean)=>{
  check(active)
  if(predicate())return
  await new Promise<void>((resolve,reject)=>{
   const signal=AbortSignal.any([ports.signal,active.controller.signal])
   const finish=(error?:unknown)=>{clearTimeout(timer);signal.removeEventListener('abort',abort);active.wake=()=>{};error?reject(error):resolve()}
   const abort=()=>finish(signal.reason??invalid()),timer=setTimeout(()=>finish(invalid()),10000)
   active.wake=()=>{try{check(active);if(predicate())finish()}catch(error){finish(error)}}
   signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();else active.wake()
  })
  check(active)
 }
 const cancellable=async<T>(active:Active,promise:Promise<T>):Promise<T>=>{
  check(active)
  const signal=AbortSignal.any([ports.signal,active.controller.signal])
  return new Promise<T>((resolve,reject)=>{
   const abort=()=>reject(signal.reason??invalid())
   signal.addEventListener('abort',abort,{once:true})
   void promise.then(value=>{signal.removeEventListener('abort',abort);try{check(active);resolve(value)}catch(error){reject(error)}},error=>{signal.removeEventListener('abort',abort);reject(error)})
   if(signal.aborted)abort()
  })
 }
 const interrupt=()=>{
  const active=current;if(!active)return
  try{send(active,{type:'playback.interrupted',streamId:active.streamId})}catch{/* 失联后不再发送状态。 */}
  retired=Math.max(retired,active.streamId);current=undefined;active.controller.abort(invalid());active.wake()
 }
 return Object.freeze({
  get active(){return current!==undefined},interrupt,
  accept(message:Ack):boolean{
   const active=current
   if(!active||message.streamId!==active.streamId){if(message.streamId<=retired)return false;throw invalid()}
   check(active)
   if(message.type==='playback.ready'){
    if(active.ready)throw invalid()
    active.ready=true
   }else if(message.type==='playback.progress'){
    if(!active.ready||message.sequence<active.progress||message.sequence>=active.sent)throw invalid()
    active.progress=message.sequence
   }else{
    if(!active.ended||message.lastSequence!==active.sent-1||active.played)throw invalid()
    active.played=true
   }
   active.wake();return true
  },
  async play(input:Readonly<{captureId:string;text:string;packets:(signal:AbortSignal)=>AsyncIterable<Uint8Array>}>):Promise<void>{
   if(current)throw new Error('设备正在播放原结果。')
   const active:Active={streamId:ports.allocateStream(),controller:new AbortController(),ready:false,sent:0,progress:-1,ended:false,played:false,wake:()=>{}}
   current=active
   let iterator:AsyncIterator<Uint8Array>|undefined
   try{
    send(active,{type:'playback.start',captureId:input.captureId,streamId:active.streamId,sampleRate:24000,frameDurationMs:60})
    send(active,{type:'playback.text',streamId:active.streamId,text:input.text})
    await wait(active,()=>active.ready)
    iterator=input.packets(AbortSignal.any([ports.signal,active.controller.signal]))[Symbol.asyncIterator]()
    while(true){
     const next=await cancellable(active,iterator.next())
     if(next.done)break
     if(active.sent>=2000)throw new Error('语音段超过播放上限。')
     await wait(active,()=>active.sent-active.progress-1<33)
     const bytes=encodeAudioFrame({kind:2,connectionGeneration:ports.connectionGeneration,streamId:active.streamId,sequence:active.sent,payload:next.value})
     // 先占序号，再发送；紧邻返回的播放进度可以核对刚发出的帧。
     active.sent++
     await cancellable(active,ports.sendAudio(bytes))
    }
    if(active.sent===0)throw new Error('语音段为空。')
    active.ended=true
    send(active,{type:'playback.end',streamId:active.streamId,lastSequence:active.sent-1})
    await wait(active,()=>active.played)
   }catch(error){
    if(current===active){try{send(active,{type:'playback.interrupted',streamId:active.streamId})}catch{/* 撤销和断线时由连接边界停止旧流。 */}}
    throw error
   }finally{
    if(current===active){current=undefined;retired=Math.max(retired,active.streamId)}
    active.controller.abort(invalid());active.wake()
    // 上游也接收同一取消信号；不能等待一个不响应取消的供应商阻塞撤销。
    if(iterator?.return)void Promise.resolve(iterator.return()).catch(()=>{})
   }
  },
 })
}
