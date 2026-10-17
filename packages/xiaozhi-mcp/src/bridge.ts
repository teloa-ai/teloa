import {WebSocket} from 'ws'
import type {HardwareRequestPort} from '@teloa/contract'
import {readXiaozhiEndpoint} from './endpoint.ts'
import {createSocketTransport} from './transport.ts'
import {createXiaozhiServer} from './server.ts'
export {createXiaozhiServer} from './server.ts'
export type XiaozhiBridgeState='idle'|'connecting'|'ready'|'retrying'|'failed'|'stopped'
export type XiaozhiBridgePorts={endpoint:()=>Promise<string>;requests:HardwareRequestPort;onStatus?:(state:XiaozhiBridgeState)=>void;connect?:(endpoint:string)=>WebSocket}

/** 一条显式启用的出站连接；每次重连重建协议会话，业务回执留在宿主。 */
export function createXiaozhiBridge(ports:XiaozhiBridgePorts){
 let enabled=false,generation=0,attempt=0,state:XiaozhiBridgeState='idle'
 let retry:ReturnType<typeof setTimeout>|undefined,cleanup:(()=>Promise<void>)|undefined
 const status=(next:XiaozhiBridgeState)=>{state=next;ports.onStatus?.(next)}
 const cycle=async(current:number)=>{
  if(!enabled||generation!==current)return
  status('connecting')
  let socket:WebSocket,server:ReturnType<typeof createXiaozhiServer>
  try{
   const endpoint=readXiaozhiEndpoint(await ports.endpoint())
   if(!enabled||generation!==current)return
   socket=ports.connect?.(endpoint)??new WebSocket(endpoint,{maxPayload:65536,handshakeTimeout:10000,followRedirects:false})
   server=createXiaozhiServer(ports.requests)
  }catch{if(enabled&&generation===current){enabled=false;status('failed')}return}
  let settled=false,fatal=false,lastPong=performance.now()
  const handshake=setTimeout(()=>socket.terminate(),10000)
  const heartbeat=setInterval(()=>{
   if(performance.now()-lastPong>=30000){socket.terminate();return}
   if(socket.readyState===WebSocket.OPEN)socket.ping()
  },15000)
  const clear=()=>{clearTimeout(handshake);clearInterval(heartbeat)}
  const finish=()=>{
   if(settled)return
   settled=true;clear();void server.close().catch(()=>{})
   if(!enabled||generation!==current)return
   if(fatal){enabled=false;status('failed');return}
   status('retrying')
   const delay=[1000,2000,4000,8000,16000,30000][Math.min(attempt++,5)]!
   retry=setTimeout(()=>{void cycle(current)},delay*(0.8+Math.random()*0.4))
  }
  cleanup=async()=>{settled=true;clear();await server.close().catch(()=>{});if(socket.readyState!==WebSocket.CLOSED)socket.terminate()}
  socket.on('pong',()=>{lastPong=performance.now()})
  socket.on('unexpected-response',(_request,response)=>{fatal=response.statusCode===401||response.statusCode===403||!!response.headers.location;response.resume();socket.terminate()})
  socket.on('error',error=>{const code=(error as NodeJS.ErrnoException).code;fatal=!!code&&/CERT|TLS|SSL|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code);finish()})
  socket.on('close',code=>{if(code===1008)fatal=true;finish()})
  server.oninitialized=()=>{
   if(!enabled||generation!==current||settled)return
   clearTimeout(handshake);attempt=0;status('ready')
  }
  try{await server.connect(createSocketTransport(socket))}catch{finish()}
 }
 return Object.freeze({
  get state(){return state},
  start(){if(enabled)return;enabled=true;attempt=0;void cycle(++generation)},
  async stop(){enabled=false;generation++;clearTimeout(retry);retry=undefined;await cleanup?.();cleanup=undefined;status('stopped')},
 })
}
