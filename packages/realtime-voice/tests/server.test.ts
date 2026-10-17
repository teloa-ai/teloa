import {test,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type IncomingMessage} from 'node:http'
import {createHash,randomUUID} from 'node:crypto'
import {once,getEventListeners} from 'node:events'
import WebSocket from 'ws'
import {Context} from '@deepseek-ai/cordis'
import type {HostConnectionHandle} from '@deepseek-ai/dsh-client-connection'
import type {VoiceCall,VoiceTranscriptSeal} from '@teloa/contract'
import type {TeloaVoicePluginPort,VoiceMediaAdapter,VoiceConnection,VoiceTransportConnectInput,VoicePcmSession} from '@teloa/harness-dsh/voice-plugin'
import {apply,inject,name} from '../src/index.ts'
import {realtimeVoicePath,realtimeVoiceProtocol} from '../src/server.ts'

const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
async function until(condition:()=>boolean):Promise<void>{
 const deadline=performance.now()+1500
 while(!condition()){
  if(performance.now()>deadline)throw Error('服务端条件未及时满足。')
  await new Promise(resolve=>setTimeout(resolve,2))
 }
}
function pcm(ms:number,amplitude=0):Uint8Array{
 const bytes=new Uint8Array(ms*32),view=new DataView(bytes.buffer)
 for(let offset=0;offset<bytes.length;offset+=2)view.setInt16(offset,amplitude,true)
 return bytes
}
type Client={socket:WebSocket;json:Record<string,unknown>[];audio:Buffer[];close:Promise<[number,Buffer]>}

async function fixture(t:TestContext,overrides:Partial<TeloaVoicePluginPort>={}){
 const browserPeer={id:'browser',principal:{kind:'owner'}},apiPeer={id:'api',principal:{kind:'owner'}}
 const connection={browserPeer,admit(request:IncomingMessage){
  if(request.headers.origin!=='http://voice.test')return {rejection:403 as const}
  if(request.headers.cookie==='owner=browser')return {peer:browserPeer}
  if(request.headers.cookie==='owner=api')return {peer:apiPeer}
  return {rejection:401 as const}
 }} as unknown as HostConnectionHandle
 const routes=new Map<string,(request:IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>void|Promise<void>>()
 const server=createServer((_request,response)=>response.writeHead(404).end())
 server.on('upgrade',(request,socket,head)=>{
  const handler=routes.get(new URL(request.url??'/', 'http://localhost').pathname)
  if(handler)void handler(request,socket,head)
  else socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
 })
 let media!:VoiceMediaAdapter,disposePlugin!:(()=>Promise<void>),detached=0,interrupts=0
 const clients:Client[]=[],events:Parameters<VoiceTransportConnectInput['onEvent']>[0][]=[],inputs=new Map<string,VoiceTransportConnectInput>()
 const accepted:VoiceTranscriptSeal[]=[],receipts:string[]=[],transcribed:Uint8Array[]=[]
 const admissions:{expected:number;current:number}[]=[],timings:Record<string,unknown>[]=[]
 let recognize:TeloaVoicePluginPort['speech']['transcribe']=async audio=>({text:'核对这份报告。',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'asr-final-receipt'})
 let synthesize:TeloaVoicePluginPort['speakPcm']=async(_text,_signal,onAudio)=>{await onAudio(Uint8Array.from([1,0,2,0]))}
 let activeConnection:VoiceConnection|undefined
 const ports:TeloaVoicePluginPort={
  recordTiming:event=>timings.push(event),
  speech:{async speak(){throw Error('测试不使用MP3。')},async transcribe(audio,format,signal){
   assert.equal(format,'wav');transcribed.push(Uint8Array.from(audio));return recognize(audio,format,signal)
  }},
  speakPcm:(...args)=>synthesize(...args),
  configured:async()=>true,providerId:async()=> 'minimax',
  attach(adapter){media=adapter;return ()=>{detached++}},
  async acceptTranscript(receipt,expected){
   const seal=await media.readTranscriptSeal(receipt);assert.ok(seal)
   accepted.push(seal);receipts.push(receipt)
   admissions.push({expected,current:media.snapshot({callId:seal.callId,callGeneration:seal.callGeneration})!.playbackGeneration})
  },
  async interrupt(callId){
   interrupts++
   const input=inputs.get(callId)
   const current=input?media.snapshot({callId,callGeneration:input.callGeneration})?.playbackGeneration??0:0
   await activeConnection?.interruptPlayback({playbackGeneration:current+1})
   return {} as VoiceCall
  },
  async end(callId){const input=inputs.get(callId);if(input)await media.transport.closePending?.(input);return {} as VoiceCall},
  failure(reason){return Object.assign(new Error('语音连接暂不可用。'),{reason})},
  ...overrides,
 }
 const context=new Context()
 context.provide('connection',connection)
 context.provide('teloaVoice',ports)
 context.provide('webServer',{registerUpgrade(route:{path:string;handler:(request:IncomingMessage,socket:import('node:stream').Duplex,head:Buffer)=>void|Promise<void>}){
   routes.set(route.path,route.handler);return ()=>{routes.delete(route.path)}
  }} as never)
 const plugin=await context.plugin({name,inject,apply})
 disposePlugin=()=>context.fiber.dispose()
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 const address=server.address();assert.ok(address&&typeof address==='object')
 const url=`ws://127.0.0.1:${address.port}`
 t.after(async()=>{
  for(const client of clients)if(client.socket.readyState!==WebSocket.CLOSED)client.socket.terminate()
  await Promise.all(clients.map(client=>client.close))
  await disposePlugin()
  await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))
 })
 const open=async(options:{cookie?:string;origin?:string;path?:string;protocol?:string;autoAck?:boolean}={}):Promise<Client>=>{
  const socket=new WebSocket(url+(options.path??realtimeVoicePath),options.protocol??realtimeVoiceProtocol,{headers:{cookie:options.cookie??'owner=browser',origin:options.origin??'http://voice.test'}})
  socket.on('error',()=>{})
  const client:Client={socket,json:[],audio:[],close:new Promise(resolve=>socket.once('close',(code,reason)=>resolve([code,reason])))}
  clients.push(client)
  socket.on('message',(data,binary)=>{
   if(binary){client.audio.push(Buffer.from(data as Buffer));return}
   const row=JSON.parse(data.toString()) as Record<string,unknown>;client.json.push(row)
   if(row.type==='close'&&options.autoAck!==false)socket.send(JSON.stringify({type:'closed'}))
  })
  await once(socket,'open');return client
 }
 const reserve=()=>{
  const input:VoiceTransportConnectInput={callId:randomUUID(),callGeneration:randomUUID(),roleContext:{ownerId:'owner',sessionId:'original-session',target:'assistant',scope:'general',contextVersion:1},signal:new AbortController().signal,onEvent:event=>events.push(event)}
  const abort=new AbortController();inputs.set(input.callId,input)
  const bound={...input,signal:abort.signal};inputs.set(input.callId,bound)
  const pending=media.transport.connect(bound);void pending.catch(()=>{})
  const snapshot=media.snapshot({callId:input.callId,callGeneration:input.callGeneration});assert.ok(snapshot)
  return {input:bound,abort,pending,hello:{type:'hello',callId:input.callId,callGeneration:input.callGeneration,token:snapshot.token}}
 }
 const connect=async()=>{
  const call=reserve(),client=await open()
  client.socket.send(JSON.stringify(call.hello));activeConnection=await call.pending
  await until(()=>client.json.some(row=>row.type==='ready'))
  return {...call,client,connection:activeConnection}
 }
 return {open,reserve,connect,events,accepted,receipts,transcribed,admissions,timings,get media(){return media},get interrupts(){return interrupts},get detached(){return detached},
  recognize(fn:typeof recognize){recognize=fn},synthesize(fn:typeof synthesize){synthesize=fn},
  unload:()=>plugin.dispose(),
 }
}

test('通话连接后预热宿主PCM会话，连续回答复用，插话取消和挂断关闭专属连接',async t=>{
 let opened=0,cancelled=0,closed=0
 const spoken:string[]=[],f=await fixture(t,{openPcmSession:async()=>{opened++;return {async synthesize(text,_signal,onAudio){spoken.push(text);await onAudio(Uint8Array.from([1,0]))},async cancel(){cancelled++},async close(){closed++}}}})
 f.synthesize(async()=>{throw Error('已有持久会话不应另发HTTP请求')})
 const {client,connection,input}=await f.connect()
 await until(()=>opened===1)
 await connection.enqueueSpeech!({utteranceId:'first',text:'第一句。',callGeneration:input.callGeneration,playbackGeneration:1})
 await connection.enqueueSpeech!({utteranceId:'second',text:'第二句。',callGeneration:input.callGeneration,playbackGeneration:2})
 assert.equal(opened,1);assert.deepEqual(spoken,['第一句。','第二句。'])
 await connection.interruptPlayback({playbackGeneration:3});assert.ok(cancelled>=1)
 await connection.close();await until(()=>closed===1)
 assert.ok(client.audio.length>=2)
})

test('192ms本机识别候选等完整封口才准入，续说丢弃旧结果，最终音频只识别一次',async t=>{
 const candidates:Array<{audio:Uint8Array;signal:AbortSignal}>=[]
 const f=await fixture(t,{
  openVad:async()=>({predict:async pcm=>pcm[0]? .95:0,reset(){},async close(){}}),
  speech:{async speak(){},async transcribe(){throw Error('相同候选不应重新识别')},async prepareRecognition(audio,_format,signal){candidates.push({audio,signal});return {text:'最终完整的输入。',providerId:'sensevoice-local',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'local-'+candidates.length}}},
 })
 const {client,connection,input}=await f.connect()
 client.socket.send(Buffer.concat([pcm(320,1000),pcm(192)]));await until(()=>candidates.length===1)
 assert.equal(f.accepted.length,0,'候选不能提前进入原模型或工具')
 client.socket.send(pcm(64,1000));await tick()
 assert.equal(candidates[0]!.signal.aborted,false,'续说丢弃候选，但不能取消已完成或在途推理而销毁常驻识别进程')
 client.socket.send(pcm(192));await until(()=>candidates.length===2)
 assert.equal(f.accepted.length,0)
 client.socket.send(pcm(416));await until(()=>f.accepted.length===1)
 assert.equal(candidates.length,2);assert.equal(f.accepted[0]!.source.audioSha256,createHash('sha256').update(candidates[1]!.audio).digest('hex'))
 client.socket.send(Buffer.concat([pcm(320,1000),pcm(192)]));await until(()=>candidates.length===3)
 await connection.setMuted!({muted:true,callGeneration:input.callGeneration})
 assert.equal(candidates[2]!.signal.aborted,true);assert.equal(f.accepted.length,1)
})

test('句中停顿的慢候选只撤销资格，不重启识别进程或堆积候选；封口只采用完整音频',async t=>{
 let release!:()=>void,previewSignal:AbortSignal|undefined,previews=0,finals=0
 const gate=new Promise<void>(resolve=>{release=resolve});t.after(release)
 const f=await fixture(t,{
  openVad:async()=>({predict:async pcm=>pcm[0]? .95:0,reset(){},async close(){}}),
  speech:{async speak(){},async prepareRecognition(audio,_format,signal){
   previews++;previewSignal=signal;await gate
   return {text:'不完整的旧候选。',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'old'}
  },async transcribe(audio){finals++;return {text:'完整的新一句。',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'final'}}},
 })
 const {client,connection,input}=await f.connect()
 client.socket.send(Buffer.concat([pcm(320,1000),pcm(192)]));await until(()=>previews===1)
 client.socket.send(Buffer.concat([pcm(64,1000),pcm(192),pcm(64,1000),pcm(192)]))
 await tick();assert.equal(previewSignal!.aborted,false);assert.equal(f.accepted.length,0)
 client.socket.send(pcm(416));await until(()=>finals===1)
 assert.equal(previews,1);assert.equal(f.accepted[0]!.text,'完整的新一句。')
 release();await tick();assert.equal(f.accepted.length,1,'迟到候选不能成为第二条输入')
 await connection.setMuted!({muted:true,callGeneration:input.callGeneration})
 assert.equal(previewSignal!.aborted,true)
})

test('取消栅栏失败后后台重建专属WS，后续回答恢复复用；重连迟到不能复活已挂断通话',async t=>{
 let opened=0,closed=0,spoken=0,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve});t.after(release)
 const f=await fixture(t,{openPcmSession:async()=>{
  const index=++opened;if(index===3)await gate
  return {async synthesize(_text,_signal,onAudio){spoken++;await onAudio(Uint8Array.of(index,0))},async cancel(){throw Error('取消确认丢失')},async close(){closed++}}
 }})
 f.synthesize(async()=>{throw Error('重连后不应一直走HTTP')})
 const {connection,input}=await f.connect();await tick()
 await connection.interruptPlayback({playbackGeneration:1});await until(()=>opened===2);await tick()
 await connection.enqueueSpeech!({utteranceId:'recovered',text:'恢复后的回答。',callGeneration:input.callGeneration,playbackGeneration:2})
 assert.equal(spoken,1);assert.equal(closed,1)
 await connection.interruptPlayback({playbackGeneration:3});await until(()=>opened===3)
 await connection.close();release();await until(()=>closed===3)
})

test('本机识别预热不阻塞接通，随媒体挂断取消且不生成本人输入',async t=>{
 let warming:AbortSignal|undefined
 const f=await fixture(t,{speech:{async speak(){},async transcribe(){throw Error('预热不能当作本人转写')},async warm(signal){warming=signal;await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))}}})
 const {connection}=await f.connect()
 assert.ok(warming);assert.equal(warming.aborted,false)
 assert.equal(f.accepted.length,0);assert.equal(f.transcribed.length,0)
 await connection.close();assert.equal(warming.aborted,true)
})

test('候选首句提前合成但不出声，正式正文逐字匹配后只播一次且保留后文',async t=>{
 const f=await fixture(t),spoken:string[]=[],prefix='这是正式的首句，'
 f.synthesize(async(text,_signal,onAudio)=>{spoken.push(text);await onAudio(Uint8Array.of(text===prefix?1:2,0))})
 const {client,connection,input}=await f.connect()
 const discard=connection.prepareSpeech!({utteranceId:'final',text:prefix,callGeneration:input.callGeneration,playbackGeneration:0})
 await tick();assert.deepEqual(spoken,[prefix]);assert.equal(client.audio.length,0)
 await connection.enqueueSpeech!({utteranceId:'final',text:prefix+'后面的内容。',callGeneration:input.callGeneration,playbackGeneration:1})
 discard();await until(()=>client.audio.length===2)
 assert.deepEqual(spoken,[prefix,'后面的内容。'])
 assert.deepEqual(client.audio.map(bytes=>[...bytes.subarray(4)]),[[1,0],[2,0]])
})

test('候选复用已预热WS；匹配时不另建HTTP，取消确认未到时新句仍立即走独立通路',async t=>{
 const prefix='这是正式的首句，',spoken:string[]=[];let release!:()=>void,cancelled=0,http=0
 const barrier=new Promise<void>(resolve=>{release=resolve})
 const f=await fixture(t,{openPcmSession:async()=>({async synthesize(text,signal,onAudio){spoken.push(text);await onAudio(Uint8Array.of(1,0));signal.throwIfAborted()},async cancel(){cancelled++;await barrier},async close(){release()}})})
 f.synthesize(async(_text,_signal,onAudio)=>{http++;await onAudio(Uint8Array.of(2,0))})
 const {client,connection,input}=await f.connect();await tick()
 connection.prepareSpeech!({utteranceId:'first',text:prefix,callGeneration:input.callGeneration,playbackGeneration:0})
 await tick();assert.equal(client.audio.length,0)
 await connection.enqueueSpeech!({utteranceId:'first',text:prefix+'完整后文。',callGeneration:input.callGeneration,playbackGeneration:1})
 assert.equal(http,0);assert.deepEqual(spoken,[prefix,'完整后文。'])
 connection.prepareSpeech!({utteranceId:'old',text:prefix,callGeneration:input.callGeneration,playbackGeneration:1})
 await tick();await connection.interruptPlayback({playbackGeneration:2})
 await connection.enqueueSpeech!({utteranceId:'new',text:'新的正式回复。',callGeneration:input.callGeneration,playbackGeneration:3})
 assert.equal(cancelled,1);assert.equal(http,1);release()
})

test('候选不匹配、音色变化、插话失效或首包前失败，均走原正式合成且不重播候选',async t=>{
 for(const mode of ['mismatch','voice','interrupt','failure'] as const){
  let voice='first'
  const f=await fixture(t,{speech:{async speak(){},async transcribe(){return null},async signature(){return voice}}}),spoken:string[]=[],prefix='这是候选的首句，'
  f.synthesize(async(text,signal,onAudio)=>{spoken.push(text);const candidate=spoken.length===1;if(mode==='failure'&&candidate)throw Error('候选失败');signal.throwIfAborted();await onAudio(Uint8Array.of(candidate?1:2,0))})
  const {client,connection,input}=await f.connect()
  connection.prepareSpeech!({utteranceId:'final',text:prefix,callGeneration:input.callGeneration,playbackGeneration:0})
  await tick();assert.equal(client.audio.length,0)
  if(mode==='voice')voice='second'
  if(mode==='interrupt')await connection.interruptPlayback({playbackGeneration:1})
  const text=mode==='mismatch'?'正式答案不同。':prefix+'正式后文。'
  await connection.enqueueSpeech!({utteranceId:'final',text,callGeneration:input.callGeneration,playbackGeneration:mode==='interrupt'?2:1})
  await until(()=>client.audio.length>0)
  assert.ok(client.audio.every(bytes=>bytes[4]===2),mode)
  assert.equal(spoken.filter(value=>value===text).length,mode==='failure'?0:1)
 }
})

test('预热尚未返回时挂断，迟到PCM会话立即关闭，不再播放',async t=>{
 let release!:(value:VoicePcmSession)=>void,closed=0
 const held=new Promise<VoicePcmSession>(resolve=>{release=resolve}),f=await fixture(t,{openPcmSession:()=>held})
 const {connection}=await f.connect()
 await connection.close()
 release({async synthesize(){throw Error('挂断后不能合成')},async cancel(){},async close(){closed++}})
 await until(()=>closed===1)
})

test('WS取消确认仍在等待时新句立即走MiniMax HTTP流，不继承旧等待',async t=>{
 let release!:()=>void,legacy=0
 const held=new Promise<void>(resolve=>{release=resolve})
 const f=await fixture(t,{openPcmSession:async()=>({async synthesize(){throw Error('取消中的会话不能接新句')},cancel:()=>held,async close(){}})})
 const {connection,input}=await f.connect();await tick()
 const cancel=connection.interruptPlayback({playbackGeneration:1})
 f.synthesize(async(_text,_signal,onAudio)=>{legacy++;await onAudio(Uint8Array.of(1,0))})
 await connection.enqueueSpeech!({utteranceId:'next',text:'继续聊天。',callGeneration:input.callGeneration,playbackGeneration:2})
 assert.equal(legacy,1);release();await cancel
})

test('静音取消旧识别，取消静音后的迟到回包不能变成本人新输入',async t=>{
 const f=await fixture(t),{connection,client,input}=await f.connect()
 let release!:()=>void,oldSignal:AbortSignal|undefined
 f.recognize(async(audio,_format,signal)=>{oldSignal=signal;await new Promise<void>(resolve=>{release=resolve});return {text:'静音前旧结果',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'old'}})
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]));await until(()=>f.transcribed.length===1)
 await connection.setMuted!({muted:true,callGeneration:input.callGeneration})
 await connection.setMuted!({muted:false,callGeneration:input.callGeneration})
 assert.equal(oldSignal?.aborted,true);release();await tick();await tick()
 assert.equal(f.accepted.length,0)
 f.recognize(async audio=>({text:'新结果',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'new'}))
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]));await until(()=>f.accepted.length===1)
 assert.equal(f.accepted[0]!.text,'新结果')
})

test('正式长回复分句合成仍使用同一播放代次，插话后不启动旧后段',async t=>{
 const f=await fixture(t),{connection,client,input}=await f.connect(),spoken:string[]=[]
 f.synthesize(async(text,_signal,onAudio)=>{spoken.push(text);await onAudio(Uint8Array.of(1,0));if(text==='第一句。')await connection.interruptPlayback({playbackGeneration:2})})
 await assert.rejects(connection.enqueueSpeech!({utteranceId:'segments',text:'第一句。第二句。',callGeneration:input.callGeneration,playbackGeneration:1}))
 assert.deepEqual(spoken,['第一句。']);assert.equal(client.json.filter(row=>row.type==='speech-end').length,0)
})

test('双向会话连续合成完整后文，候选不重复；打断丢弃批次后续音频并可恢复',async t=>{
 const spoken:string[]=[],prefix='这是提前准备的首句，'
 let interrupted=false,connection:VoiceConnection,input:VoiceTransportConnectInput
 const f=await fixture(t,{openPcmSession:async()=>({async synthesize(text,signal,onAudio){
  spoken.push(text);await onAudio(Uint8Array.of(1,0));signal.throwIfAborted()
  if(text.startsWith('打断测试')){await connection.interruptPlayback({playbackGeneration:3});interrupted=signal.aborted;await onAudio(Uint8Array.of(9,0))}
 },async cancel(){},async close(){}})})
 const connected=await f.connect();connection=connected.connection;input=connected.input;await tick()
 connection.prepareSpeech!({utteranceId:'batch',text:prefix,callGeneration:input.callGeneration,playbackGeneration:0})
 await tick();assert.equal(connected.client.audio.length,0)
 await connection.enqueueSpeech!({utteranceId:'batch',text:prefix+'后文第一句。后文第二句。',callGeneration:input.callGeneration,playbackGeneration:1})
 assert.deepEqual(spoken,[prefix,'后文第一句。后文第二句。'])
 await assert.rejects(connection.enqueueSpeech!({utteranceId:'barge',text:'打断测试。不能播放旧后文。',callGeneration:input.callGeneration,playbackGeneration:2}))
 assert.equal(interrupted,true)
 await connection.enqueueSpeech!({utteranceId:'recovered',text:'现在恢复。继续当前话题。',callGeneration:input.callGeneration,playbackGeneration:4})
 await until(()=>connected.client.json.some(row=>row.type==='speech-end'&&row.generation===4))
 assert.ok(connected.client.audio.every(bytes=>bytes[4]!==9),'取消后旧批次不能漏播')
 assert.equal(spoken.at(-1),'现在恢复。继续当前话题。')
})

test('持久会话预热失败保留原MiniMax HTTP播报，不结束可用通话',async t=>{
 let legacy=0
 const f=await fixture(t,{openPcmSession:async()=>{throw Error('供应商连接不可用')}})
 f.synthesize(async(_text,_signal,onAudio)=>{legacy++;await onAudio(Uint8Array.from([1,0]))})
 const {connection,input}=await f.connect()
 await connection.enqueueSpeech!({utteranceId:'fallback',text:'继续原通话。',callGeneration:input.callGeneration,playbackGeneration:1})
 assert.equal(legacy,1)
})

test('预热握手仍在等待时首句立即走原HTTP，不能将握手超时叠到回答上',async t=>{
 let legacy=0,release!:(value:null)=>void
 const pending=new Promise<null>(resolve=>{release=resolve}),f=await fixture(t,{openPcmSession:()=>pending})
 t.after(()=>release(null))
 f.synthesize(async(_text,_signal,onAudio)=>{legacy++;await onAudio(Uint8Array.from([1,0]))})
 const {connection,input}=await f.connect()
 const speech=connection.enqueueSpeech!({utteranceId:'no-wait',text:'第一句。',callGeneration:input.callGeneration,playbackGeneration:1})
 await until(()=>legacy===1)
 release(null);await speech
})

test('已预热WS断线后取消不结束通话，未发PCM的合成失败回退HTTP并弃用失效连接',async t=>{
 let legacy=0,closed=0,opened=0
 const f=await fixture(t,{openPcmSession:async()=>{opened++;return {async synthesize(){throw Error('失效会话')},async cancel(){throw Error('已断线')},async close(){closed++}}}})
 f.synthesize(async(_text,_signal,onAudio)=>{legacy++;await onAudio(Uint8Array.from([1,0]))})
 const {connection,input}=await f.connect();await until(()=>opened===1)
 await connection.interruptPlayback({playbackGeneration:1})
 await until(()=>closed===1)
 await connection.enqueueSpeech!({utteranceId:'after-lost',text:'仍可回答。',callGeneration:input.callGeneration,playbackGeneration:2})
 assert.equal(legacy,1)
})

test('WS在首音前失败只回退一次，已发送PCM后失败不能重放全文',async t=>{
 let legacy=0,closed=0,partial=false
 const f=await fixture(t,{openPcmSession:async()=>({async synthesize(_text,_signal,onAudio){if(partial)await onAudio(Uint8Array.from([1,0]));throw Error('供应商失效')},async cancel(){},async close(){closed++}})})
 f.synthesize(async(_text,_signal,onAudio)=>{legacy++;await onAudio(Uint8Array.from([1,0]))})
 const first=await f.connect();await tick()
 await first.connection.enqueueSpeech!({utteranceId:'fallback',text:'第一句。',callGeneration:first.input.callGeneration,playbackGeneration:1})
 assert.equal(legacy,1);await until(()=>closed===1)
 partial=true
 const second=await f.connect();await tick()
 await assert.rejects(second.connection.enqueueSpeech!({utteranceId:'partial',text:'不可重播。',callGeneration:second.input.callGeneration,playbackGeneration:1}))
 assert.equal(legacy,1,'一旦发出PCM，回退会重复朗读，必须禁止')
})

test('转写受理后仍显示原模型等待，真实无回复终态才恢复监听且旧代次不能覆盖',async t=>{
 const f=await fixture(t),{client,input}=await f.connect()
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]))
 await until(()=>f.accepted.length===1);await tick();await tick()
 assert.equal(client.json.filter(row=>row.type==='phase').at(-1)?.phase,'thinking','受理转写不等于模型已经回答')
 const seal=f.accepted[0]!,state={callId:input.callId,callGeneration:input.callGeneration,turnId:seal.turnId,playbackGeneration:1,state:'idle' as const}
 f.media.conversationState?.({...state,playbackGeneration:0});await tick();await tick()
 assert.equal(client.json.filter(row=>row.type==='phase').at(-1)?.phase,'thinking')
 f.media.conversationState?.(state)
 await until(()=>client.json.filter(row=>row.type==='phase').at(-1)?.phase==='listening')
})

test('实时媒体封口保留本机识别实际来源',async t=>{
 const f=await fixture(t),{client}=await f.connect()
 f.recognize(async audio=>({text:'本机结果',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'local-stt:test',providerId:'sensevoice-local'}))
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]))
 await until(()=>f.accepted.length===1)
 assert.equal(f.accepted[0]!.source.providerId,'sensevoice-local');assert.equal(f.accepted[0]!.source.sttReceiptId,'local-stt:test')
})

test('连续完整音频并行识别且按说话顺序受理，后句不等待前句识别才开始',async t=>{
 const f=await fixture(t),{client}=await f.connect()
 let release!:()=>void,started=0
 const gate=new Promise<void>(resolve=>{release=resolve});t.after(release)
 f.recognize(async audio=>{
  const index=++started
  if(index===1)await gate
  return {text:index===1?'第一段完整转写。':'第二段完整转写。',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'sealed-asr-'+index}
 })
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600),pcm(200,2000),pcm(600)]))
 await until(()=>started===2)
 assert.equal(f.accepted.length,0,'后句先识别完也不能抢先插入原会话')
 release();await until(()=>f.accepted.length===2)
 assert.deepEqual(f.accepted.map(seal=>seal.text),['第一段完整转写。','第二段完整转写。'])
 assert.deepEqual(f.admissions.map(row=>row.expected),[1,2])
})

test('语音阶段计时绑定原轮次且首PCM直接发出，诊断不携带转写或播报内容',async t=>{
 const f=await fixture(t),{client,input,connection}=await f.connect()
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]));await until(()=>f.accepted.length===1)
 const seal=f.accepted[0]!,requestId=randomUUID(),text='不能出现在诊断里的播报正文'
 await connection.enqueueSpeech!({utteranceId:requestId,text,callGeneration:input.callGeneration,playbackGeneration:2})
 await until(()=>client.audio.length>0)
 assert.deepEqual(f.timings.map(row=>row.stage),['asr-start','asr-completed','tts-start','tts-first-pcm','audio-first-send'])
 assert.ok(f.timings.every(row=>row.callId===input.callId&&row.callGeneration===input.callGeneration&&typeof row.at==='number'))
 assert.equal(f.timings[0]!.turnId,seal.turnId);assert.equal(f.timings[1]!.turnId,seal.turnId)
 assert.equal(f.timings[2]!.requestId,requestId)
 assert.ok(!JSON.stringify(f.timings).includes(text));assert.ok(!JSON.stringify(f.timings).includes(seal.text))
})

test('真实HTTP升级只允许官方认证的本人browserPeer、指定路径和子协议',async t=>{
 const f=await fixture(t)
 for(const options of [{cookie:''},{cookie:'owner=api'},{origin:'http://other.test'},{protocol:'other.protocol'},{path:realtimeVoicePath+'?token=forbidden'}]){
  await assert.rejects(f.open(options),/Unexpected server response: 403/)
 }
 const {connection}=await f.connect();await connection.close()
})

test('hello必须精确绑定实际通话与世代，错误票据不消耗原票据且不能重复认领',async t=>{
 const f=await fixture(t),call=f.reserve()
 for(const hello of [{...call.hello,callGeneration:randomUUID()},{...call.hello,token:randomUUID()},{...call.hello,text:'伪造文本'}]){
  const client=await f.open();client.socket.send(JSON.stringify(hello));assert.equal((await client.close)[0],1008)
 }
 const client=await f.open();client.socket.send(JSON.stringify(call.hello));const connection=await call.pending
 const replay=await f.open();replay.socket.send(JSON.stringify(call.hello));assert.equal((await replay.close)[0],1008)
 assert.equal(client.socket.readyState,WebSocket.OPEN);await connection.close()
})

test('真实PCM经VAD封口及宿主ASR生成可信转写，同一包多段不丢失',async t=>{
 const f=await fixture(t),{client,input}=await f.connect()
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600),pcm(200,2000),pcm(600)]))
 await until(()=>f.accepted.length===2)
 assert.equal(f.transcribed.length,2);assert.equal(f.interrupts,2)
 assert.deepEqual(f.admissions,[{expected:1,current:2},{expected:2,current:2}])
 for(let index=0;index<2;index++){
  const audio=Buffer.from(f.transcribed[index]!),seal=f.accepted[index]!
  assert.equal(audio.toString('ascii',0,4),'RIFF');assert.equal(audio.readUInt32LE(24),16000)
  assert.equal(audio.length,25644);assert.equal(seal.callId,input.callId);assert.equal(seal.sessionId,'original-session')
  assert.equal(seal.source.audioSha256,createHash('sha256').update(audio).digest('hex'))
  assert.equal(seal.source.sttReceiptId,'asr-final-receipt');assert.equal(seal.text,'核对这份报告。')
  assert.equal(await f.media.readTranscriptSeal(f.receipts[index]!),null)
 }
})

test('短噪声不废弃持续回答，确认的插话才取消旧播报且继续识别',async t=>{
 const f=await fixture(t),{client,connection,input}=await f.connect()
 let speechSignal:AbortSignal|undefined
 f.synthesize(async(_text,signal,onAudio)=>{
  speechSignal=signal;await onAudio(Uint8Array.from([1,0,2,0]))
  await new Promise<void>(resolve=>{if(signal.aborted)resolve();else signal.addEventListener('abort',()=>resolve(),{once:true})})
  signal.throwIfAborted()
 })
 const speaking=connection.enqueueSpeech!({utteranceId:'ongoing',text:'继续说明原来的工作。',callGeneration:input.callGeneration,playbackGeneration:1})
 void speaking.catch(()=>{})
 await until(()=>client.audio.length===1)
 for(const ms of [20,180]){
  client.socket.send(Buffer.concat([pcm(ms,2000),pcm(600)]))
  const pong=once(client.socket,'pong');client.socket.ping();await pong
  assert.equal(f.interrupts,0)
  assert.equal(speechSignal?.aborted,false)
  assert.equal(f.media.snapshot({callId:input.callId,callGeneration:input.callGeneration})?.playbackGeneration,1)
 }
 assert.equal(f.transcribed.length,0)
 client.socket.send(pcm(180,1000))
 const pong=once(client.socket,'pong');client.socket.ping();await pong
 assert.equal(f.interrupts,0)
 client.socket.send(pcm(20,1000));await until(()=>f.interrupts===1)
 await assert.rejects(speaking);assert.equal(speechSignal?.aborted,true)
 client.socket.send(pcm(600));await until(()=>f.accepted.length===1)
 assert.equal(f.transcribed.length,1);assert.deepEqual(f.admissions,[{expected:2,current:2}])
 assert.equal(client.socket.readyState,WebSocket.OPEN)
})

test('等待ASR时新一句先推进世代，旧转写及手动commit保持采集时世代，连续包不重复打断',async t=>{
 const f=await fixture(t),{client}=await f.connect()
 let releaseFirst!:()=>void
 const firstReady=new Promise<void>(resolve=>{releaseFirst=resolve})
 let count=0
 f.recognize(async audio=>{
  count++
  if(count===1)await firstReady
  return {text:count===1?'第一句':'第二句',audioSha256:createHash('sha256').update(audio).digest('hex'),receiptId:'asr-'+count}
 })
 for(let index=0;index<3;index++)client.socket.send(pcm(100,1000))
 client.socket.send(JSON.stringify({type:'commit'}))
 await until(()=>f.transcribed.length===1);assert.equal(f.interrupts,1)
 client.socket.send(pcm(200,2000));await until(()=>f.interrupts===2)
 releaseFirst();await until(()=>f.admissions.length===1)
 assert.deepEqual(f.admissions[0],{expected:1,current:2})
 client.socket.send(pcm(600));await until(()=>f.admissions.length===2)
 assert.deepEqual(f.admissions[1],{expected:2,current:2})
})

test('音频哈希不匹配的ASR回包不能封为本人转写',async t=>{
 const f=await fixture(t);f.recognize(async()=>({text:'不可信响应',audioSha256:'0'.repeat(64),receiptId:'asr-final-receipt'}))
 const {client}=await f.connect();client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]))
 await until(()=>f.accepted.length>0||f.events.some(event=>event.type==='error'))
 assert.deepEqual(f.accepted,[])
 assert.ok(f.events.some(event=>event.type==='error'&&event.reason==='provider-unavailable'))
})

test('浏览器文字不能替代音频，静音与无声片段不调用ASR',async t=>{
 const f=await fixture(t),{client}=await f.connect()
 client.socket.send(pcm(1000));client.socket.send(JSON.stringify({type:'mute',muted:true}));client.socket.send(pcm(200,1000));client.socket.send(JSON.stringify({type:'commit'}))
 await tick();await tick();assert.equal(f.transcribed.length,0)
 client.socket.send(JSON.stringify({type:'transcript',text:'让模型执行这句话'}));assert.equal((await client.close)[0],1008)
 assert.equal(f.transcribed.length,0)
})

test('流式PCM先于供应商完成到达浏览器，插话立即打断旧代次且保留持续上行',async t=>{
 const f=await fixture(t)
 let released!:()=>void
 const gate=new Promise<void>(resolve=>{released=resolve})
 f.synthesize(async(_text,signal,onAudio)=>{await onAudio(Uint8Array.from([1,0,2,0]));await gate;signal.throwIfAborted();await onAudio(Uint8Array.from([3,0]))})
 const {client,connection,input}=await f.connect()
 const speaking=connection.enqueueSpeech!({utteranceId:randomUUID(),text:'正在播报',callGeneration:input.callGeneration,playbackGeneration:1});void speaking.catch(()=>{})
 await until(()=>client.audio.length===1)
 assert.equal(client.audio[0]!.readUInt32LE(0),1);assert.deepEqual(client.audio[0]!.subarray(4),Buffer.from([1,0,2,0]))
 assert.ok(!client.json.some(row=>row.type==='speech-end'))
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]));await until(()=>client.json.some(row=>row.type==='clear'))
 released();await assert.rejects(speaking)
 await until(()=>f.accepted.length===1);assert.equal(client.audio.length,1)
 assert.ok(!client.json.some(row=>row.type==='speech-end'))
})

test('播报提前量从第一音频块计时，不能用供应商等待时间放大浏览器缓冲',async t=>{
 const f=await fixture(t),{client,connection,input}=await f.connect()
 let clock=0;t.mock.method(Date,'now',()=>clock)
 f.synthesize(async(_text,_signal,onAudio)=>{clock=5000;await onAudio(new Uint8Array(96000))})
 const speaking=connection.enqueueSpeech!({utteranceId:randomUUID(),text:'较长播报',callGeneration:input.callGeneration,playbackGeneration:1});void speaking.catch(()=>{})
 await until(()=>client.audio.length>=14)
 await new Promise(resolve=>setTimeout(resolve,25))
 assert.ok(client.audio.length<24,'两秒音频不能在首块到达时全部预推。')
 await connection.interruptPlayback({playbackGeneration:2});await assert.rejects(speaking)
})

test('播放世代必须在uint32范围且不能回退，非法世代不发帧',async t=>{
 const f=await fixture(t),{client,connection,input}=await f.connect()
 for(const playbackGeneration of [-1,1.5,0x100000000,Number.MAX_SAFE_INTEGER]){
  await assert.rejects(connection.interruptPlayback({playbackGeneration}))
  await assert.rejects(connection.enqueueSpeech!({utteranceId:randomUUID(),text:'测试',callGeneration:input.callGeneration,playbackGeneration}))
 }
 assert.deepEqual(client.audio,[])
 await connection.interruptPlayback({playbackGeneration:0xffffffff})
 await assert.rejects(connection.interruptPlayback({playbackGeneration:1}))
 assert.equal(f.media.snapshot({callId:input.callId,callGeneration:input.callGeneration})?.playbackGeneration,0xffffffff)
})

test('当前播放结束及清播恢复监听阶段，旧世代播放回执不能改阶段',async t=>{
 const f=await fixture(t),{client,connection}=await f.connect()
 await connection.interruptPlayback({playbackGeneration:1})
 await until(()=>client.json.some(row=>row.type==='clear'))
 assert.ok(client.json.some(row=>row.type==='phase'&&row.phase==='listening'))
 client.json.length=0
 client.socket.send(JSON.stringify({type:'playback',generation:0,state:'idle'}));await tick();await tick()
 assert.equal(client.json.length,0)
 client.socket.send(JSON.stringify({type:'playback',generation:1,state:'idle'}))
 await until(()=>client.json.some(row=>row.type==='phase'&&row.phase==='listening'))
 client.socket.send(pcm(200,1000));await until(()=>client.json.some(row=>row.type==='clear'&&row.generation===2))
 client.json.length=0
 client.socket.send(JSON.stringify({type:'playback',generation:2,state:'idle'}))
 await until(()=>client.json.some(row=>row.type==='phase'&&row.phase==='recording'))
})

test('closing接受真实closed回执并回收麦克风通道、ASR信号与原会话监听',async t=>{
 const f=await fixture(t)
 let asrSignal:AbortSignal|undefined
 f.recognize(async(_audio,_format,signal)=>{asrSignal=signal;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}))})
 const {client,connection,input}=await f.connect()
 client.socket.send(Buffer.concat([pcm(200,1000),pcm(600)]));await until(()=>asrSignal!==undefined)
 await connection.close();assert.equal((await client.close)[0],1000)
 assert.equal(asrSignal?.aborted,true);assert.equal(getEventListeners(input.signal,'abort').length,0)
 assert.deepEqual(f.accepted,[])
 assert.ok(!f.events.some(event=>event.type==='error'))
})

test('connect超时或取消移除未建立渠道及abort监听，迟到hello不能复活',async t=>{
 const f=await fixture(t)
 t.mock.timers.enable({apis:['setTimeout']});const call=f.reserve();t.mock.timers.tick(15000)
 await assert.rejects(call.pending);t.mock.timers.reset()
 assert.equal(f.media.snapshot({callId:call.input.callId,callGeneration:call.input.callGeneration}),null)
 assert.equal(getEventListeners(call.input.signal,'abort').length,0)
 const late=await f.open();late.socket.send(JSON.stringify(call.hello));assert.equal((await late.close)[0],1008)
 const cancelled=f.reserve();cancelled.abort.abort();await assert.rejects(cancelled.pending)
 assert.equal(f.media.snapshot({callId:cancelled.input.callId,callGeneration:cancelled.input.callGeneration}),null)
})

test('真实Cordis插件卸载撤下升级路由、媒体注册及活动socket',async t=>{
 const f=await fixture(t),{client,input}=await f.connect()
 await f.unload()
 assert.equal(f.detached,1);assert.equal((await client.close)[0],1000)
 assert.equal(f.media.snapshot({callId:input.callId,callGeneration:input.callGeneration}),null)
 await assert.rejects(f.open(),/Unexpected server response: 404/)
})
