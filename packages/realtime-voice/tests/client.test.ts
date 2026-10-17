import assert from 'node:assert/strict'
import test from 'node:test'
import {openDuplexVoice,type BrowserVoiceRoot,type DuplexVoiceEvent} from '../src/client/index.ts'
import {createPCM16Encoder,encodeVoiceWav} from '../src/client/microphone.ts'

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
function fixture(options:{delayedMedia?:boolean;blockedPlayback?:boolean;pendingPlayerResume?:boolean;delayedWorklet?:boolean;failCloseRate?:number}={}){
 let releaseMedia!:(stream:MediaStream)=>void
 const track={enabled:true,readyState:'live',stops:0,stop(){this.stops++;this.readyState='ended'},addEventListener(){},removeEventListener(){}}
 const stream={getTracks:()=>[track],getAudioTracks:()=>[track]} as unknown as MediaStream
 const contexts:Context[]=[],processors:Worklet[]=[],sockets:Socket[]=[]
 class Node{disconnected=false;connect<T>(target:T){return target}disconnect(){this.disconnected=true}}
 class Source extends Node{buffer:AudioBuffer|null=null;onended:(()=>void)|null=null;stopped=false;started=false;startAt=0;start(at=0){this.started=true;this.startAt=at}stop(){this.stopped=true}finish(){this.onended?.()}}
 class Context{
  sampleRate:number;state='suspended';currentTime=0;destination={};sources:Source[]=[];closed=false;closeAttempts=0
  audioWorklet={addModule:()=>options.delayedWorklet?new Promise<void>(()=>{}):Promise.resolve()}
  constructor(input?:{sampleRate?:number}){this.sampleRate=input?.sampleRate??48000;contexts.push(this)}
  createMediaStreamSource(){return new Node()}
  createGain(){return Object.assign(new Node(),{gain:{value:0}})}
  async resume(){if(options.pendingPlayerResume&&this.sampleRate===24000)return new Promise<void>(()=>{});if(options.blockedPlayback&&this.sampleRate===24000)throw new DOMException('private autoplay diagnostic','NotAllowedError');this.state='running'}
  async close(){this.closeAttempts++;if(options.failCloseRate===this.sampleRate&&this.closeAttempts===1)throw Error('private close diagnostic');this.closed=true;this.state='closed'}
  createBuffer(_channels:number,length:number,rate:number){return {duration:length/rate,getChannelData:()=>new Float32Array(length)}}
  createBufferSource(){const source=new Source();this.sources.push(source);return source}
 }
 class Worklet extends Node{port:{onmessage:((e:{data:Float32Array})=>void)|null}={onmessage:null};constructor(){super();processors.push(this)}}
 class Socket{
  readyState=0;binaryType='';bufferedAmount=0;sent:unknown[]=[];protocol:string;closed=false
  onopen:(()=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;onmessage:((e:{data:unknown})=>void)|null=null
  readonly url:string
  constructor(url:string,protocol:string){this.url=url;this.protocol=protocol;sockets.push(this)}
  send(data:unknown){this.sent.push(data)}
  open(){this.readyState=1;this.onopen?.()}
  message(data:unknown){this.onmessage?.({data})}
  close(){this.closed=true;this.readyState=3}
  disconnect(){this.readyState=3;this.onclose?.()}
 }
 const root={navigator:{mediaDevices:{getUserMedia:()=>options.delayedMedia?new Promise<MediaStream>(resolve=>{releaseMedia=resolve}):Promise.resolve(stream)}},AudioContext:Context,AudioWorkletNode:Worklet,WebSocket:Socket,URL:{createObjectURL:()=> 'blob:voice-test',revokeObjectURL(){}},Blob,location:{href:'https://teloa.test/work',origin:'https://teloa.test'}} as unknown as BrowserVoiceRoot
 const events:DuplexVoiceEvent[]=[]
 const begin=(signal?:AbortSignal)=>openDuplexVoice({url:'/voice',callId:'call',callGeneration:'epoch',token:'lease',onEvent:event=>events.push(event),root,...signal?{signal}:{}})
 const connected=async()=>{const pending=begin();await tick();assert.equal(sockets.length,1);const socket=sockets[0]!;socket.open();socket.message(JSON.stringify({type:'ready'}));return {client:await pending,socket}}
 const packet=(generation:number,samples=2400)=>{const bytes=new ArrayBuffer(4+samples*2),view=new DataView(bytes);view.setUint32(0,generation,true);for(let at=4;at<bytes.byteLength;at+=2)view.setInt16(at,12000,true);return bytes}
 const json=(socket:Socket)=>socket.sent.filter((value):value is string=>typeof value==='string').map(value=>JSON.parse(value) as Record<string,unknown>)
 return {root,begin,connected,contexts,processors,sockets,track,events,release:()=>releaseMedia(stream),packet,json}
}

test('取消等待中的麦克风会拒绝建连，迟到的采集轨立即回收且不创建连接',async()=>{
 const f=fixture({delayedMedia:true}),abort=new AbortController(),pending=f.begin(abort.signal)
 abort.abort();await assert.rejects(pending,{name:'AbortError'})
 f.release();await tick()
 assert.equal(f.track.stops,1);assert.equal(f.contexts.length,0);assert.equal(f.sockets.length,0)
})

test('握手绑定本人通话，ready 前不上传；ready 后推理及播报期间持续采集，静音确实停止上行',async()=>{
 const f=fixture(),pending=f.begin();await tick();const socket=f.sockets[0]!
 assert.equal(f.contexts.length,2);assert.equal(socket.protocol,'teloa.voice.pcm.v1')
 socket.open();assert.deepEqual(f.json(socket),[{type:'hello',callId:'call',callGeneration:'epoch',token:'lease'}])
 const mic=f.processors[0]!;mic.port.onmessage?.({data:new Float32Array(480).fill(.5)})
 assert.equal(socket.sent.filter(value=>typeof value!=='string').length,0)
 socket.message(JSON.stringify({type:'ready'}));const client=await pending
 socket.message(JSON.stringify({type:'phase',phase:'thinking'}));socket.message(JSON.stringify({type:'speech-start',generation:1}));socket.message(f.packet(1))
 mic.port.onmessage?.({data:new Float32Array(480).fill(.5)})
 const binary=socket.sent.find(value=>typeof value!=='string') as ArrayBuffer
 assert.equal(binary.byteLength,320);assert.equal(new DataView(binary).getInt16(0,true),16383)
 await client.setMuted(true);assert.equal(f.track.enabled,false)
 mic.port.onmessage?.({data:new Float32Array(480).fill(.5)});assert.equal(socket.sent.filter(value=>typeof value!=='string').length,1)
 await client.setMuted(false);assert.equal(f.track.enabled,true)
 mic.port.onmessage?.({data:new Float32Array(480).fill(.5)});assert.equal(socket.sent.filter(value=>typeof value!=='string').length,2)
 await client.close();assert.equal(f.track.readyState,'ended');assert.ok(f.contexts.every(context=>context.closed));assert.equal(socket.closed,true)
 assert.deepEqual(f.json(socket).at(-1),{type:'closed'})
})

test('clear 同步停止旧音频，旧代次及旧完成事件不能恢复播放；新代次能继续播放',async()=>{
 const f=fixture(),{client,socket}=await f.connected(),player=f.contexts[1]!
 socket.message(JSON.stringify({type:'speech-start',generation:1}));socket.message(f.packet(1));const old=player.sources[0]!
 socket.message(JSON.stringify({type:'clear',generation:2}));assert.equal(old.stopped,true)
 socket.message(f.packet(1));socket.message(JSON.stringify({type:'speech-start',generation:1}));assert.equal(player.sources.length,1)
 old.finish();socket.message(f.packet(2));assert.equal(player.sources.length,2);assert.equal(player.sources[1]!.started,true)
 client.interrupt();assert.equal(player.sources[1]!.stopped,true)
 socket.message(f.packet(2));assert.equal(player.sources.length,2)
 await client.close()
})

test('网络持续阻塞时停止上行和释放媒体，不让浏览器发送队列无限增长',async()=>{
 const f=fixture(),{client,socket}=await f.connected()
 socket.bufferedAmount=256*1024+1
 f.processors[0]!.port.onmessage?.({data:new Float32Array(480).fill(.5)})
 await tick()
 assert.equal(socket.sent.filter(value=>typeof value!=='string').length,0)
 assert.equal(f.track.readyState,'ended')
 assert.ok(f.events.some(event=>event.type==='error'&&event.reason==='connection-lost'))
 await client.close()
})

test('同一播报网络间隙只补4ms，清播后的新轮重新预缓冲120ms',async()=>{
 const f=fixture(),{client,socket}=await f.connected(),player=f.contexts[1]!
 player.currentTime=10;socket.message(f.packet(1))
 assert.equal(player.sources[0]!.startAt,10.12)
 player.currentTime=11;socket.message(f.packet(1))
 assert.equal(player.sources[1]!.startAt,11.004)
 socket.message(JSON.stringify({type:'clear',generation:2}));socket.message(f.packet(2))
 assert.equal(player.sources[2]!.startAt,11.12)
 await client.close()
})

test('服务端关闭与网络断线均回收麦克风和播放器，关闭回执不会重复',async()=>{
 for(const remoteClose of [true,false]){
  const f=fixture(),{client,socket}=await f.connected()
  if(remoteClose)socket.message(JSON.stringify({type:'close'}));else socket.disconnect()
  await tick();await client.close()
  assert.equal(f.track.stops,1);assert.ok(f.contexts.every(context=>context.closed));assert.equal(f.events.filter(event=>event.type==='closed').length,1)
  assert.equal(f.json(socket).filter(event=>event.type==='closed').length,remoteClose?1:0)
  if(!remoteClose)assert.ok(f.events.some(event=>event.type==='error'&&event.reason==='connection-lost'))
 }
})

test('播放器拒绝自动播放可恢复，队列不能超过五秒，原始服务端异常不会进入事件',async()=>{
 const f=fixture({blockedPlayback:true}),{client,socket}=await f.connected()
 assert.ok(f.events.some(event=>event.type==='play-blocked'))
 await assert.rejects(client.play());assert.ok(!JSON.stringify(f.events).includes('private autoplay diagnostic'))
 socket.message(f.packet(1,24000*4.8));assert.equal(f.contexts[1]!.sources.length,1)
 socket.message(f.packet(1,2400));await tick()
 assert.ok(f.events.some(event=>event.type==='error'&&event.reason==='provider-unavailable'));assert.equal(f.track.readyState,'ended')
 await client.close()
 const g=fixture(),second=await g.connected();second.socket.message(JSON.stringify({type:'error',reason:'private key or provider diagnostic'}));await tick()
 assert.ok(!JSON.stringify(g.events).includes('private key'));await second.client.close()
})

test('跨源媒体 URL 在取得麦克风前拒绝，转写和提交只经过指定协议',async()=>{
 const f=fixture();await assert.rejects(openDuplexVoice({url:'wss://other.test/voice',callId:'call',callGeneration:'epoch',token:'lease',root:f.root,onEvent:()=>{}}));assert.equal(f.contexts.length,0)
 const {client,socket}=await f.connected();socket.message(JSON.stringify({type:'transcript',text:'核对报告'}));client.commit()
 assert.ok(f.events.some(event=>event.type==='transcript'&&event.text==='核对报告'));assert.deepEqual(f.json(socket).at(-1),{type:'commit'});await client.close()
})

test('自动播放等待用户手势不能阻塞媒体握手，关闭会解除仍等待中的 play',async()=>{
 const f=fixture({pendingPlayerResume:true}),controller=new AbortController(),pending=f.begin(controller.signal)
 void pending.catch(()=>{})
 try{
  await tick();assert.equal(f.sockets.length,1)
  const socket=f.sockets[0]!;socket.open();socket.message(JSON.stringify({type:'ready'}));const client=await pending
  assert.ok(f.events.some(event=>event.type==='play-blocked'))
  const playing=client.play();const closing=client.close();await assert.rejects(playing);await closing
 }finally{controller.abort()}
})

test('AudioWorklet 加载未完成时取消仍立即停止采集并回收上下文',async()=>{
 const f=fixture({delayedWorklet:true}),controller=new AbortController(),pending=f.begin(controller.signal)
 await tick();controller.abort();await assert.rejects(pending,{name:'AbortError'})
 assert.equal(f.track.stops,1);assert.ok(f.contexts.every(context=>context.closed));assert.equal(f.sockets.length,0)
})

test('分片平均降采样保持 44.1k 窗口连续，WAV 接口保持旧语音留言契约',()=>{
 const encoder=createPCM16Encoder();let length=0
 for(let n=0;n<100;n++)length+=encoder.encode(new Float32Array(441).fill(.5),44100).byteLength
 assert.equal(length,32000)
 const audio=encodeVoiceWav([new Float32Array(48000).fill(.5)],48000),view=new DataView(audio.buffer)
 assert.equal(audio.byteLength,32044);assert.equal(view.getUint32(24,true),16000);assert.equal(view.getInt16(44,true),16383)
 assert.throws(()=>encodeVoiceWav([],48000))
})

test('关闭失败不发送成功回执，重试只回收尚未关闭的采集或播放上下文',async()=>{
 for(const rate of [48000,24000]){
  const f=fixture({failCloseRate:rate}),{client,socket}=await f.connected()
  await assert.rejects(client.close(),error=>typeof error==='object'&&error!==null&&Reflect.get(error,'reason')==='media-close-failed')
  assert.equal(f.track.stops,1);assert.equal(socket.closed,true);assert.equal(f.json(socket).filter(event=>event.type==='closed').length,0)
  assert.equal(f.events.filter(event=>event.type==='closed').length,0)
  await client.close()
  assert.ok(f.contexts.every(context=>context.closed));assert.equal(f.contexts.find(context=>context.sampleRate===rate)!.closeAttempts,2)
  assert.equal(f.contexts.find(context=>context.sampleRate!==rate)!.closeAttempts,1);assert.equal(f.track.stops,1)
  assert.equal(f.events.filter(event=>event.type==='closed').length,1);assert.ok(!JSON.stringify(f.events).includes('private close'))
 }
})
