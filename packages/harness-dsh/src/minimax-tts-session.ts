import WebSocket,{type ClientOptions,type RawData} from 'ws'

export type MiniMaxTtsSession=Readonly<{
 synthesize:(text:string,signal:AbortSignal,onAudio:(bytes:Uint8Array)=>void|Promise<void>)=>Promise<void>
 /** 立即停交旧音频；收到供应商取消确认后才允许下一句发送。 */
 cancel:()=>Promise<void>
 /** 只结束媒体，不补合成尾文，不取消原会话工作。 */
 close:()=>Promise<void>
}>
export type MiniMaxTtsSessionOptions=Readonly<{
 key:()=>Promise<string|undefined>
 voice:Readonly<{model:string;voiceId:string}>
 signal:AbortSignal
 socketFactory?:(url:string,options:ClientOptions)=>WebSocket
}>
const endpoint='wss://api.minimax.io/ws/v1/t2a_v2_bidi'
const idleMs=15000,totalMs=30000,maxMessage=1024*1024,maxQueuedAudio=8*1024*1024,maxAudio=24*1024*1024
const cancelMs=800
// 正常厂商音频多为2KiB小包，合成快于播放；包数不能把几秒长句误判为溢出。
// 总积压仍由8MiB与4096事件的硬上限约束。
const maxQueue=3,maxPackets=4096,maxEvents=4096,maxBufferedSend=256*1024
type FailureCode='invalid-input'|'unavailable'|'closed'|'timeout'
class TtsFailure extends Error{
 readonly code:FailureCode
 constructor(code:FailureCode){super(code==='invalid-input'?'语音播报输入或队列不正确。':code==='closed'?'语音播报连接已关闭。':'MiniMax 语音播报暂不可用。');this.name='MiniMaxTtsError';this.code=code}
}
const failure=(code:FailureCode='unavailable')=>new TtsFailure(code)
const canceled=()=>new DOMException('语音播报已取消。','AbortError')
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
type Operation={
 text:string;signal:AbortSignal;onAudio:(bytes:Uint8Array)=>void|Promise<void>
 resolve:()=>void;reject:(error:Error)=>void;abort:()=>void;settled:boolean
 tail:Promise<void>;bytes:number;packets:number;events:number;flushed:boolean
 idle?:ReturnType<typeof setTimeout>;total?:ReturnType<typeof setTimeout>
}
type CancelBarrier={promise:Promise<void>;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}

/**
 * MiniMax 官方双向 TTS 协议：https://platform.minimax.io/docs/api-reference/speech-t2a-websocket-bidi
 * 一次 task_start，多次整句 task_continue + task_flush；PCM16、24kHz、单声道。
 * task_canceled / task_flushed 是官方有序栅栏。协议没有客户端逐句 id，trace_id 与
 * sentence_start 都不是音频归属凭据；复用依赖供应商在确认后不再发送上一轮音频。
 * 取消期间与空闲时丢弃音频，异步消费绑定原操作，绝不把旧队列移交下一句。
 */
export function createMiniMaxTtsSession(input:MiniMaxTtsSessionOptions):Promise<MiniMaxTtsSession>{
 return new Promise((resolve,reject)=>{
  let phase:'connecting'|'starting'|'ready'|'closed'='connecting',socket:WebSocket|undefined,ready=false
  const isClosed=()=>phase==='closed'
  let active:Operation|undefined,barrier:CancelBarrier|undefined,queuedAudio=0
  let heartbeat:ReturnType<typeof setInterval>|undefined
  const queue:Operation[]=[]
  const settle=(operation:Operation,error?:Error)=>{
   if(operation.settled)return
   operation.settled=true
   clearTimeout(operation.idle);clearTimeout(operation.total)
   operation.signal.removeEventListener('abort',operation.abort)
   if(error)operation.reject(error);else operation.resolve()
  }
  const rootAbort=()=>shutdown(canceled())
  const initial=setTimeout(()=>shutdown(failure('timeout')),idleMs);initial.unref()
  const cleanupSocket=()=>{
   if(!socket)return
   const current=socket
   current.off('message',message);current.off('close',disconnected)
   // ws 在 CONNECTING 时 terminate 会异步发 error；保留脱敏吸收器至真实关闭。
   const cleanup=()=>{current.off('error',errored);current.off('close',cleanup)}
   if(current.readyState===WebSocket.CLOSED){cleanup();return}
   current.once('close',cleanup)
   try{current.terminate()}catch{cleanup()}
  }
  function shutdown(error:Error){
   if(phase==='closed')return
   phase='closed';clearTimeout(initial);clearInterval(heartbeat)
   input.signal?.removeEventListener('abort',rootAbort)
   if(active){settle(active,error);active=undefined}
   for(const operation of queue.splice(0))settle(operation,error)
   if(barrier){clearTimeout(barrier.timer);barrier.reject(error);barrier=undefined}
   if(!ready)reject(error)
   cleanupSocket()
  }
  const errored=()=>shutdown(failure()),disconnected=()=>shutdown(failure())
  const send=(value:Record<string,unknown>)=>{
   if(phase==='closed')return
   if(!socket||socket.readyState!==WebSocket.OPEN||socket.bufferedAmount>maxBufferedSend){shutdown(failure());return}
   try{socket.send(JSON.stringify(value),error=>{if(error)shutdown(failure())})}catch{shutdown(failure())}
  }
  const touch=(operation:Operation)=>{
   clearTimeout(operation.idle)
   operation.idle=setTimeout(()=>shutdown(failure('timeout')),idleMs);operation.idle.unref()
  }
  const pump=()=>{
   if(phase!=='ready'||active||barrier)return
   const operation=queue.shift()
   if(!operation)return
   if(operation.signal.aborted){settle(operation,canceled());pump();return}
   active=operation;touch(operation)
   operation.total=setTimeout(()=>shutdown(failure('timeout')),Math.max(totalMs,Math.min(300000,operation.text.length*100)));operation.total.unref()
   send({event:'task_continue',text:operation.text})
   if(active===operation&&phase==='ready')send({event:'task_flush'})
  }
  const complete=(operation:Operation)=>{
   void operation.tail.then(()=>{
    if(active!==operation||operation.settled||phase!=='ready')return
    if(!operation.bytes||operation.bytes%2){shutdown(failure());return}
    active=undefined;settle(operation);queueMicrotask(pump)
   })
  }
  const beginCancel=():Promise<void>=>{
   if(phase==='closed')return Promise.reject(failure('closed'))
   if(barrier)return barrier.promise
   for(const operation of queue.splice(0))settle(operation,canceled())
   if(!active)return Promise.resolve()
   const previous=active;active=undefined;settle(previous,canceled())
   let done!:()=>void,fail!:(error:Error)=>void
   const promise=new Promise<void>((accept,decline)=>{done=accept;fail=decline})
   const timer=setTimeout(()=>shutdown(failure('timeout')),cancelMs);timer.unref()
   barrier={promise,resolve:done,reject:fail,timer}
   send({event:'task_cancel'})
   return promise
  }
  const audio=(operation:Operation,hex:unknown)=>{
   if(typeof hex!=='string'||hex.length%2||!/^[\da-f]*$/i.test(hex)){shutdown(failure());return}
   if(!hex)return
   const bytes=Buffer.from(hex,'hex')
   if(operation.bytes+bytes.byteLength>maxAudio||queuedAudio+bytes.byteLength>maxQueuedAudio||operation.packets>=maxPackets){shutdown(failure());return}
   operation.bytes+=bytes.byteLength;operation.packets++;queuedAudio+=bytes.byteLength
   operation.tail=operation.tail.then(async()=>{
    if(active!==operation||operation.settled||phase!=='ready')return
    await operation.onAudio(bytes)
   }).then(()=>{operation.packets--;queuedAudio-=bytes.byteLength},()=>{
    operation.packets--;queuedAudio-=bytes.byteLength
    if(active===operation&&!operation.settled)shutdown(failure())
   })
  }
  function message(raw:RawData,binary:boolean){
   if(phase==='closed')return
   try{
    const size=Array.isArray(raw)?raw.reduce((sum,part)=>sum+part.byteLength,0):raw.byteLength
    if(binary||size>maxMessage){shutdown(failure());return}
    const bytes=Array.isArray(raw)?Buffer.concat(raw):Buffer.isBuffer(raw)?raw:Buffer.from(raw)
    const row:unknown=JSON.parse(bytes.toString('utf8'))
    if(!object(row)||row.event!==undefined&&typeof row.event!=='string'){shutdown(failure());return}
    if(row.base_resp!==undefined&&(!object(row.base_resp)||!Number.isSafeInteger(row.base_resp.status_code)||row.base_resp.status_code!==0)){shutdown(failure());return}
    if(row.event==='task_failed'||row.event==='task_finished'){shutdown(failure());return}
    if(phase==='connecting'){
     if(row.event!=='connected_success'){shutdown(failure());return}
     phase='starting'
     send({event:'task_start',model:input.voice.model,language_boost:'auto',voice_setting:{voice_id:input.voice.voiceId,speed:1,vol:1,pitch:0},audio_setting:{sample_rate:24000,format:'pcm',channel:1}})
     return
    }
    if(phase==='starting'){
     if(row.event!=='task_started'){shutdown(failure());return}
     phase='ready';ready=true;clearTimeout(initial)
     heartbeat=setInterval(()=>{
      if(phase==='closed')return
      try{socket?.ping()}catch{shutdown(failure())}
     },30000);heartbeat.unref()
     resolve(session);return
    }
    if(barrier){
     if(row.event==='task_canceled'){
      const current=barrier;barrier=undefined;clearTimeout(current.timer);current.resolve();queueMicrotask(pump)
     }
     return // 取消确认前的所有旧音频/flush不进入下一句。
    }
    if(row.event==='task_canceled'){if(active)shutdown(failure());return}
    const operation=active
    if(!operation)return
    if(++operation.events>maxEvents){shutdown(failure());return}
    if(operation.flushed){if(row.event==='task_flushed')shutdown(failure());return}
    touch(operation)
    if(row.event==='task_flushed'){
     if(operation.flushed){shutdown(failure());return}
     // 厂商已交付完毕，后续只等消费者播放背压；媒体取消仍即时生效。
     clearTimeout(operation.idle);clearTimeout(operation.total)
     operation.flushed=true;complete(operation);return
    }
    if(row.extra_info!==undefined){
     if(!object(row.extra_info)){shutdown(failure());return}
     const info=row.extra_info
     if(info.audio_sample_rate!==undefined&&info.audio_sample_rate!==24000||info.audio_channel!==undefined&&info.audio_channel!==1||info.audio_format!==undefined&&info.audio_format!=='pcm'){shutdown(failure());return}
    }
    if(row.data!==undefined){
     if(!object(row.data)){shutdown(failure());return}
     if(row.data.audio!==undefined)audio(operation,row.data.audio)
    }
   }catch{shutdown(failure())}
  }
  const session:MiniMaxTtsSession=Object.freeze({
   synthesize(text,signal,onAudio){
    if(phase!=='ready')return Promise.reject(failure('closed'))
    if(typeof text!=='string'||!text.trim()||text.length>=10000||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)||!(signal instanceof AbortSignal)||typeof onAudio!=='function'||queue.length+(active?1:0)>=maxQueue)return Promise.reject(failure('invalid-input'))
    if(signal.aborted)return Promise.reject(canceled())
    return new Promise<void>((accept,decline)=>{
     const operation:Operation={text,signal,onAudio,resolve:accept,reject:decline,settled:false,tail:Promise.resolve(),bytes:0,packets:0,events:0,flushed:false,abort:()=>{
      if(operation.settled)return
      if(active===operation){void beginCancel().catch(()=>{});return}
      const index=queue.indexOf(operation);if(index>=0)queue.splice(index,1)
      settle(operation,canceled())
     }}
     signal.addEventListener('abort',operation.abort,{once:true});queue.push(operation);pump()
    })
   },
   cancel:beginCancel,
   async close(){shutdown(failure('closed'))},
  })
  if(!(input.signal instanceof AbortSignal)||typeof input.key!=='function'||!input.voice||typeof input.voice.model!=='string'||!input.voice.model.trim()||input.voice.model.length>128||typeof input.voice.voiceId!=='string'||!input.voice.voiceId.trim()||input.voice.voiceId.length>256){shutdown(failure('invalid-input'));return}
  input.signal.addEventListener('abort',rootAbort,{once:true})
  if(input.signal.aborted){shutdown(canceled());return}
  void Promise.resolve().then(()=>input.key()).then(key=>{
   if(phase==='closed')return
   if(typeof key!=='string'||!key.trim()||/[\x00-\x20\x7f]/.test(key)){shutdown(failure());return}
   try{
    const factory=input.socketFactory??((url:string,options:ClientOptions)=>new WebSocket(url,options))
    socket=factory(endpoint,{headers:{Authorization:'Bearer '+key},handshakeTimeout:idleMs,maxPayload:maxMessage,perMessageDeflate:false,followRedirects:false,rejectUnauthorized:true})
    socket.on('error',errored);socket.on('close',disconnected);socket.on('message',message)
    if(isClosed()){cleanupSocket();return}
   }catch{shutdown(failure())}
  },()=>shutdown(failure()))
 })
}
