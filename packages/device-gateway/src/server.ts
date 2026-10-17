import {createServer,type ServerOptions} from 'node:https'
import {networkInterfaces} from 'node:os'
import {randomInt} from 'node:crypto'
import type {Duplex} from 'node:stream'
import WebSocket,{WebSocketServer,type RawData} from 'ws'
import {createAudioReceiver,deviceProtocol,encodeHostControl,maxControlBytes,readDeviceControl,type HostControl} from './protocol.ts'
import {createPlaybackChannel} from './playback.ts'

export type DeviceAuthorization=Readonly<{bindingId:string;signal:AbortSignal;assertCurrent:()=>void;release:()=>void}>
export class DeviceCaptureBusy extends Error{}
export class DeviceCaptureUnavailable extends Error{}
export type DeviceCapture=Readonly<{push:(packet:Uint8Array)=>Promise<void>;stop:()=>Promise<void>;abort:()=>void}>
export type DeviceSink=Readonly<{
 control:(message:Extract<HostControl,{type:'transcript'|'request.receipt'|'error'|'approval.card'|'approval.ack'}>)=>void
 sealed:(captureId:string,reason:'silence'|'stop'|'limit')=>void
 discarded:(captureId:string)=>void
 play:(input:Readonly<{captureId:string;text:string;packets:(signal:AbortSignal)=>AsyncIterable<Uint8Array>}>)=>Promise<void>
}>
export type DeviceMedia=Readonly<{
 start:(captureId:string,signal:AbortSignal)=>Promise<DeviceCapture>
 status:(captureId:string)=>Promise<void>;repeat:(captureId:string)=>Promise<void>
 approvals?:(index:number)=>Promise<void>
 decide?:(input:Readonly<{ticket:string;digest:string;decision:'approve'|'reject'}>)=>Promise<void>
 abort:()=>void;close:()=>Promise<void>
}>
type Ports=Readonly<{
 tls:Pick<ServerOptions,'key'|'cert'>;listen:Readonly<{host:string;port:number}>
 authorize:(credential:string,signal:AbortSignal)=>Promise<DeviceAuthorization|null>
 media:(authorization:DeviceAuthorization,sink:DeviceSink,signal:AbortSignal)=>Promise<DeviceMedia>
}>
const invalid=()=>new Error('设备连接或协议不可用。')
const bytes=(data:RawData)=>data instanceof ArrayBuffer?new Uint8Array(data):Array.isArray(data)?Buffer.concat(data):data
const validHost=(host:string)=>{
 if(host==='127.0.0.1')return true
 const octets=host.split('.').map(Number)
 if(octets.length!==4||octets.some((n,i)=>!Number.isInteger(n)||n<0||n>255||String(n)!==host.split('.')[i]))return false
 const [a,b]=octets
 return (a===10||a===172&&b!>=16&&b!<=31||a===192&&b===168)&&Object.values(networkInterfaces()).flat().some(info=>info?.family==='IPv4'&&info.address===host&&!info.internal)
}
const token=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value)&&Buffer.from(value,'base64url').toString('base64url')===value

/** 默认没有监听器；只有宿主明确调用 start 才开独立私网 WSS，且只承接有限设备协议。 */
export function createDeviceGateway(ports:Ports){
 const {host,port}=ports.listen
 if(!validHost(host)||!Number.isInteger(port)||port<1024||port>65535||[3100,3101].includes(port)||!ports.tls.key||!ports.tls.cert)throw invalid()
 const server=createServer({...ports.tls,minVersion:'TLSv1.2',maxHeaderSize:8192,requestTimeout:10000,headersTimeout:10000},(_request,response)=>{response.writeHead(404);response.end()})
 const sockets=new WebSocketServer({noServer:true,maxPayload:maxControlBytes,perMessageDeflate:false,clientTracking:false})
 const occupied=new Set<string>(),connections=new Set<()=>Promise<void>>(),upgrades=new Map<AbortController,Duplex>()
 let started=false,closed=false,starting:Promise<void>|undefined,closing:Promise<void>|undefined
 const reject=(socket:Duplex,status=401)=>{if(socket.destroyed)return;socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)}
 server.on('clientError',(_error,socket)=>{socket.destroy()})
 server.on('tlsClientError',()=>{})
 server.on('upgrade',(request,socket,head)=>{
  socket.on('error',()=>{})
  if(closed||request.url!=='/devices/v1/connect'||request.method!=='GET'||request.headers.origin!==undefined||upgrades.size>=4){reject(socket,404);return}
  const value=request.headers.authorization,secret=typeof value==='string'&&value.startsWith('Bearer ')?value.slice(7):undefined
  if(!token(secret)){reject(socket);return}
  const pending=new AbortController();upgrades.set(pending,socket)
  const timeout=setTimeout(()=>{pending.abort();reject(socket,408)},10000)
  const disconnected=()=>pending.abort();socket.once('close',disconnected)
  const expire=()=>{upgrades.delete(pending);clearTimeout(timeout);socket.removeListener('close',disconnected)}
  void (async()=>{
   let authorization:DeviceAuthorization|null=null,claimed=false
   try{
    authorization=await ports.authorize(secret,pending.signal)
    pending.signal.throwIfAborted()
    if(!authorization)throw invalid()
    authorization.assertCurrent();authorization.signal.throwIfAborted()
    if(closed||socket.destroyed)throw invalid()
    if(occupied.has(authorization.bindingId)){reject(socket,409);return}
    occupied.add(authorization.bindingId);claimed=true
    const lease=authorization
    sockets.handleUpgrade(request,socket,head,ws=>{expire();attach(ws,lease)})
    authorization=null
   }catch{reject(socket)}finally{
    expire()
    if(authorization){if(claimed)occupied.delete(authorization.bindingId);try{authorization.release()}catch{/* 只释放本连接句柄。 */}}
   }
  })()
 })
 function attach(ws:WebSocket,lease:DeviceAuthorization){
  const life=new AbortController(),connectionGeneration=randomInt(1,0xffffffff)
  let nextStream=1,ready=false,opening=false,closing=false,media:DeviceMedia|undefined,ending:Promise<void>|undefined,lastPong=performance.now(),commands=0
  type Capture={captureId:string;streamId:number;controller:AbortController;receiver:ReturnType<typeof createAudioReceiver>;handler?:DeviceCapture;queue:Promise<void>;pending:number;stopping:boolean}
  let capture:Capture|undefined,retiredStream=0
  const retiredCaptures=new Set<string>()
  const assertCurrent=()=>{life.signal.throwIfAborted();lease.signal.throwIfAborted();lease.assertCurrent();if(closed||ws.readyState!==WebSocket.OPEN)throw invalid()}
  const allocateStream=()=>{assertCurrent();if(nextStream>=0xffffffff)throw invalid();return nextStream++}
  const control=(message:HostControl)=>{assertCurrent();const data=encodeHostControl(message);if(ws.bufferedAmount>2*maxControlBytes)throw invalid();ws.send(data,{binary:false},error=>{if(error)void finish()})}
  const playback=createPlaybackChannel({connectionGeneration,allocateStream,assertCurrent,signal:life.signal,sendControl:control,sendAudio:data=>new Promise<void>((resolve,reject)=>{
   try{assertCurrent();if(ws.bufferedAmount>33*4112)throw invalid();ws.send(data,{binary:true},error=>error?reject(invalid()):resolve())}catch{reject(invalid())}
  })})
  const retire=(current:Capture)=>{
   current.receiver.close();retiredStream=Math.max(retiredStream,current.streamId);retiredCaptures.add(current.captureId)
   if(retiredCaptures.size>128)retiredCaptures.delete(retiredCaptures.values().next().value!)
   if(capture===current)capture=undefined
  }
  const abortCapture=()=>{const current=capture;if(!current)return;retire(current);current.controller.abort();try{current.handler?.abort()}catch{/* 终止媒体不影响正式工作。 */}}
  const sink:DeviceSink={control:message=>control(message),sealed(captureId,reason){
   const current=capture;if(!current||current.captureId!==captureId)throw invalid()
   retire(current);control({type:'listen.sealed',captureId,reason})
  },discarded(captureId){
   const current=capture;if(!current||current.captureId!==captureId)throw invalid()
   retire(current);control({type:'error',code:'no-speech'})
  },async play(input){assertCurrent();if(capture)throw invalid();return playback.play(input)}}
  const handshake=setTimeout(()=>{void finish()},10000),heartbeat=setInterval(()=>{
   if(performance.now()-lastPong>=30000){void finish();return}
   try{assertCurrent();ws.ping()}catch{void finish()}
  },15000)
  heartbeat.unref();handshake.unref()
  async function finish(){
   if(closing)return ending
   closing=true
   // 先同步拒绝迟到 ASR/输出，再异步释放媒体；不得取消已受理的原生工作。
   life.abort();clearTimeout(handshake);clearInterval(heartbeat);lease.signal.removeEventListener('abort',revoked)
   abortCapture();playback.interrupt();try{media?.abort()}catch{/* 继续关闭连接。 */}
   ws.terminate()
   ending=(async()=>{
    try{await media?.close()}catch{/* 输出仅返回有限错误，不能泄漏供应商内容。 */}
    finally{occupied.delete(lease.bindingId);connections.delete(finish);try{lease.release()}catch{/* 不能复活已关闭句柄。 */}}
   })()
   return ending
  }
  const revoked=()=>{void finish()};lease.signal.addEventListener('abort',revoked,{once:true})
  connections.add(finish);ws.on('error',()=>{void finish()});ws.on('close',()=>{void finish()});ws.on('pong',()=>{lastPong=performance.now()})
  const run=(operation:()=>Promise<void>)=>{
   if(commands>=2){void finish();return}
   commands++;void operation().catch(error=>{
    if(error instanceof DeviceCaptureBusy||error instanceof DeviceCaptureUnavailable){try{control({type:'error',code:error instanceof DeviceCaptureBusy?'busy':'unavailable'});return}catch{/* 连接已关闭。 */}}
    return finish()
   }).finally(()=>{commands--})
  }
  ws.on('message',(raw,binary)=>{
   try{
    assertCurrent();const data=bytes(raw)
    if(binary){
     if(!ready||data.byteLength<=16||data.byteLength>4112)throw invalid()
     const header=new DataView(data.buffer,data.byteOffset,data.byteLength),streamId=header.getUint32(8)
     if(header.getUint8(0)!==1||header.getUint8(1)!==1||header.getUint16(2)!==0||header.getUint32(4)!==connectionGeneration||streamId<1||streamId>=0xffffffff)throw invalid()
     const current=capture
     // 自然封口后，网络中尚有少量旧上行；丢弃它们，不能送进下一句。
     if(!current||streamId!==current.streamId){if(streamId<=retiredStream)return;throw invalid()}
     if(current.stopping||!current.handler||current.pending>=16)throw invalid()
     const packet=current.receiver.accept(data);current.pending++
     current.queue=current.queue.then(async()=>{if(capture!==current||current.controller.signal.aborted)return;assertCurrent();await current.handler!.push(packet)}).finally(()=>{current.pending--})
     void current.queue.catch(()=>finish());return
    }
    const message=readDeviceControl(data)
    if(!ready){
     if(opening||message.type!=='hello')throw invalid()
     opening=true
     run(async()=>{
      const opened=await ports.media(lease,sink,life.signal)
      if(life.signal.aborted){await opened.close();return}
      media=opened;assertCurrent();ready=true;clearTimeout(handshake);control({type:'hello',protocol:deviceProtocol,connectionGeneration})
     });return
    }
    if(message.type==='hello')throw invalid()
    if(message.type==='abort'){abortCapture();playback.interrupt();media!.abort();return}
    if(message.type==='playback.ready'||message.type==='playback.progress'||message.type==='playback.played'){playback.accept(message);return}
    if(message.type==='listen.start'){
     if(capture||playback.active){control({type:'error',code:'busy'});return}
     const current:Capture={captureId:message.captureId,streamId:allocateStream(),controller:new AbortController(),receiver:createAudioReceiver({kind:1,connectionGeneration,streamId:nextStream-1}),queue:Promise.resolve(),pending:0,stopping:false}
     capture=current
     run(async()=>{
      let handler:DeviceCapture
      try{handler=await media!.start(current.captureId,AbortSignal.any([life.signal,current.controller.signal]))}
      catch(error){if(error instanceof DeviceCaptureBusy||error instanceof DeviceCaptureUnavailable){retire(current);current.controller.abort();control({type:'error',code:error instanceof DeviceCaptureBusy?'busy':'unavailable'});return};throw error}
      if(capture!==current||current.controller.signal.aborted||life.signal.aborted){handler.abort();return}
      assertCurrent();current.handler=handler;control({type:'listen.ready',captureId:current.captureId,streamId:current.streamId})
     });return
    }
    if(message.type==='listen.stop'){
     const current=capture
     if(!current||current.captureId!==message.captureId){if(retiredCaptures.has(message.captureId))return;throw invalid()}
     if(current.stopping)return
     current.stopping=true;current.receiver.close()
     run(async()=>{await current.queue;if(capture!==current)return;assertCurrent();await current.handler?.stop()});return
    }
    if(message.type==='request.status')run(()=>media!.status(message.captureId))
    else if(message.type==='approval.list')run(async()=>{if(!media!.approvals)throw new DeviceCaptureUnavailable();await media!.approvals(message.index)})
    else if(message.type==='approval.decide')run(async()=>{if(!media!.decide)throw new DeviceCaptureUnavailable();await media!.decide({ticket:message.ticket,digest:message.digest,decision:message.decision})})
    else if(message.type==='playback.repeat'){if(capture||playback.active){control({type:'error',code:'busy'});return};run(()=>media!.repeat(message.captureId))}
   }catch{void finish()}
  })
  if(lease.signal.aborted)void finish()
 }
 return Object.freeze({
  async start(){
   if(closed||started||starting)throw invalid()
   starting=new Promise<void>((resolve,reject)=>{const error=()=>reject(invalid());server.once('error',error);server.listen(port,host,()=>{server.removeListener('error',error);started=true;resolve()})})
   await starting
  },
  async close(){
   if(closing)return closing
   closed=true
   closing=(async()=>{
    for(const [pending,socket] of upgrades){pending.abort();socket.destroy()}
    await Promise.allSettled([...connections].map(finish=>finish()))
    await starting?.catch(()=>{})
    if(started)await new Promise<void>(resolve=>server.close(()=>resolve()))
    sockets.close()
   })()
   return closing
  },
 })
}
