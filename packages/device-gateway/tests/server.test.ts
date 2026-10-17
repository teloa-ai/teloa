import assert from 'node:assert/strict'
import {after,before,test} from 'node:test'
import {mkdtemp,readFile,rm,chmod} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {execFileSync} from 'node:child_process'
import {createServer,createConnection} from 'node:net'
import {once} from 'node:events'
import {randomBytes} from 'node:crypto'
import WebSocket from 'ws'
import {createDeviceGateway,DeviceCaptureBusy,DeviceCaptureUnavailable,type DeviceMedia,type DeviceSink} from '../src/server.ts'
import {deviceProtocol,encodeAudioFrame} from '../src/protocol.ts'

const hello={type:'hello',protocol:deviceProtocol,audio:{uplink:{format:'opus',sampleRate:16000,channels:1,frameDurationMs:60},downlink:{format:'opus',sampleRate:24000,channels:1,frameDurationMs:60}}}
const captureId='a8b4284f-9b02-4d76-a494-673984e06666',secondId='b8b4284f-9b02-4d76-a494-673984e06666'
const credential=randomBytes(32).toString('base64url')
let cert:Buffer,key:Buffer,directory:string
before(async()=>{
 directory=await mkdtemp(join(tmpdir(),'teloa-gateway-tls-'));await chmod(directory,0o700)
 execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1','-keyout',join(directory,'key.pem'),'-out',join(directory,'cert.pem')],{stdio:'ignore'})
 key=await readFile(join(directory,'key.pem'));cert=await readFile(join(directory,'cert.pem'))
})
after(async()=>{await rm(directory,{recursive:true,force:true})})
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve))
const until=async(check:()=>boolean)=>{const deadline=performance.now()+2500;while(!check()){if(performance.now()>deadline)throw new Error('本机测试条件超时');await new Promise(resolve=>setTimeout(resolve,5))}}
async function fixture(media?:(sink:DeviceSink,signal:AbortSignal)=>Promise<DeviceMedia>){
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening')
 const address=reservation.address();if(!address||typeof address==='string')throw new Error('port')
 const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()))
 const grant=new AbortController();let mediaOpened=0,released=0,authorized=0,aborted=0,stopped=0,packets=0
 const gateway=createDeviceGateway({tls:{key,cert},listen:{host:'127.0.0.1',port},authorize:async token=>{
  authorized++;if(token!==credential)return null
  return {bindingId:'owned-binding',signal:grant.signal,assertCurrent:()=>grant.signal.throwIfAborted(),release:()=>{released++}}
 },media:async(_lease,sink,signal)=>{mediaOpened++;return media?media(sink,signal):{start:async()=>({push:async()=>{packets++},stop:async()=>{stopped++},abort:()=>{aborted++}}),status:async()=>{},repeat:async()=>{},abort:()=>{},close:async()=>{}}}})
 await gateway.start()
 const connect=async(options:{token?:string;path?:string;trusted?:boolean}={})=>{
  const ws=new WebSocket(`wss://127.0.0.1:${port}${options.path??'/devices/v1/connect'}`,{...(options.trusted===false?{}:{ca:cert}),headers:{Authorization:`Bearer ${options.token??credential}`}})
  ws.on('error',()=>{})
  return ws
 }
 return {gateway,connect,grant,counts:()=>({mediaOpened,released,authorized,aborted,stopped,packets})}
}
async function open(f:Awaited<ReturnType<typeof fixture>>){
 const ws=await f.connect(),messages:Record<string,unknown>[]=[]
 ws.on('message',(bytes,binary)=>{if(!binary)messages.push(JSON.parse(bytes.toString()))})
 await once(ws,'open');ws.send(JSON.stringify(hello));await until(()=>messages.some(message=>message.type==='hello'))
 return {ws,messages,generation:messages.find(message=>message.type==='hello')!.connectionGeneration as number}
}
test('仅明确本机私网接口与独立端口可启动',()=>{
 const options={tls:{key,cert},authorize:async()=>null,media:async()=>{throw new Error('不可达')}}
 for(const host of ['0.0.0.0','::','8.8.8.8','192.168.255.254'])assert.throws(()=>createDeviceGateway({...options,listen:{host,port:32145}}))
 for(const port of [0,3100,3101])assert.throws(()=>createDeviceGateway({...options,listen:{host:'127.0.0.1',port}}))
})
test('无可信证书、错误路径及无效凭据不创建媒体',async()=>{
 const f=await fixture()
 try{
  const untrusted=await f.connect({trusted:false});await once(untrusted,'error')
  for(const options of [{path:'/workspace/rpc'},{path:'/devices/v1/connect?token=secret'},{token:randomBytes(32).toString('base64url')}]){
   const ws=await f.connect(options);await once(ws,'error')
  }
  assert.equal(f.counts().mediaOpened,0)
 }finally{await f.gateway.close()}
})
test('认证和严格 hello 后才开放媒体，重复绑定连接不抢占',async()=>{
 const f=await fixture()
 try{
  const a=await open(f);assert.equal(f.counts().mediaOpened,1)
  const duplicate=await f.connect();await once(duplicate,'error');assert.equal(a.ws.readyState,WebSocket.OPEN)
  a.ws.send(JSON.stringify({type:'listen.start',captureId,ownerId:'forged'}));await once(a.ws,'close')
  assert.equal(f.counts().packets,0)
 }finally{await f.gateway.close()}
 assert.equal(f.counts().released,2)
})
test('断线和打断丢半句，旧流不能进入下一句',async()=>{
 const f=await fixture()
 try{
  const a=await open(f);a.ws.send(JSON.stringify({type:'listen.start',captureId}));await until(()=>a.messages.some(x=>x.type==='listen.ready'))
  const first=a.messages.find(x=>x.type==='listen.ready')!.streamId as number
  a.ws.send(encodeAudioFrame({kind:1,connectionGeneration:a.generation,streamId:first,sequence:0,payload:Uint8Array.of(1)}));await until(()=>f.counts().packets===1)
  a.ws.send(JSON.stringify({type:'abort'}));await until(()=>f.counts().aborted===1)
  a.ws.send(JSON.stringify({type:'listen.start',captureId:secondId}));await until(()=>a.messages.filter(x=>x.type==='listen.ready').length===2)
  const second=a.messages.filter(x=>x.type==='listen.ready')[1]!.streamId as number
  a.ws.send(encodeAudioFrame({kind:1,connectionGeneration:a.generation,streamId:first,sequence:1,payload:Uint8Array.of(1)}))
  a.ws.send(encodeAudioFrame({kind:1,connectionGeneration:a.generation,streamId:second,sequence:0,payload:Uint8Array.of(1)}));await until(()=>f.counts().packets===2)
  a.ws.close();await once(a.ws,'close');await until(()=>f.counts().aborted===2)
  assert.equal(f.counts().stopped,0)
 }finally{await f.gateway.close()}
})
test('撤销同步关闭并拒绝迟到宿主输出',async()=>{
 let sink:DeviceSink|undefined
 const f=await fixture(async current=>{sink=current;return {start:async()=>{throw new Error('unused')},status:async()=>{},repeat:async()=>{},abort:()=>{},close:async()=>{}}})
 try{
  const a=await open(f);f.grant.abort();assert.throws(()=>sink!.control({type:'transcript',captureId,text:'不可外发'}))
  await once(a.ws,'close');assert.equal(a.messages.some(x=>x.text==='不可外发'),false)
 }finally{await f.gateway.close()}
})
test('媒体占用与未配置返回有限错误，连接仍可查询原结果',async()=>{
 let starts=0,statuses=0
 const f=await fixture(async()=>({start:async()=>{if(starts++===0)throw new DeviceCaptureBusy();throw new DeviceCaptureUnavailable()},status:async()=>{statuses++},repeat:async()=>{throw new DeviceCaptureBusy()},abort(){},close:async()=>{}}))
 try{
  const a=await open(f)
  a.ws.send(JSON.stringify({type:'listen.start',captureId}));await until(()=>a.messages.some(x=>x.type==='error'&&x.code==='busy'))
  a.ws.send(JSON.stringify({type:'listen.start',captureId:secondId}));await until(()=>a.messages.some(x=>x.type==='error'&&x.code==='unavailable'))
  a.ws.send(JSON.stringify({type:'playback.repeat',captureId}));await until(()=>a.messages.filter(x=>x.type==='error'&&x.code==='busy').length===2)
  a.ws.send(JSON.stringify({type:'request.status',captureId}));await until(()=>statuses===1)
  assert.equal(a.ws.readyState,WebSocket.OPEN)
 }finally{await f.gateway.close()}
})
test('待处理媒体超过一秒即关闭，不积累无限解码任务',async()=>{
 let resolvePush:(()=>void)|undefined,aborted=0
 const f=await fixture(async()=>({start:async()=>({push:async()=>new Promise<void>(resolve=>{resolvePush=resolve}),stop:async()=>{},abort:()=>{aborted++;resolvePush?.()}}),status:async()=>{},repeat:async()=>{},abort:()=>{},close:async()=>{}}))
 try{
  const a=await open(f);a.ws.send(JSON.stringify({type:'listen.start',captureId}));await until(()=>a.messages.some(x=>x.type==='listen.ready'))
  const streamId=a.messages.find(x=>x.type==='listen.ready')!.streamId as number
  for(let sequence=0;sequence<18;sequence++)a.ws.send(encodeAudioFrame({kind:1,connectionGeneration:a.generation,streamId,sequence,payload:Uint8Array.of(1)}))
  await once(a.ws,'close');assert.equal(aborted,1)
 }finally{await f.gateway.close()}
})
test('启动未回调时关闭也必须释放监听器，不能遗留端口',async()=>{
 const reservation=createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening')
 const address=reservation.address();if(!address||typeof address==='string')throw new Error('port')
 await new Promise<void>(resolve=>reservation.close(()=>resolve()))
 const gateway=createDeviceGateway({tls:{key,cert},listen:{host:'127.0.0.1',port:address.port},authorize:async()=>null,media:async()=>{throw new Error('unused')}})
 const starting=gateway.start();await gateway.close();await starting
 const client=createConnection({host:'127.0.0.1',port:address.port})
 try{assert.equal(await new Promise<boolean>(resolve=>{client.once('connect',()=>resolve(true));client.once('error',()=>resolve(false))}),false)}finally{client.destroy()}
})
