import {WebSocket} from 'ws'
import type {Transport} from '@modelcontextprotocol/sdk/shared/transport.js'
import {JSONRPCMessageSchema,type JSONRPCMessage} from '@modelcontextprotocol/sdk/types.js'

/** 出站和本机协议验收共用的 MCP Transport，不转发任何进程或工作台 RPC。 */
export function createSocketTransport(socket:WebSocket):Transport{
 let started=false,closed=false
 const transport:Transport={
  async start(){
   if(started)throw Error('MCP transport already started')
   started=true
   socket.on('message',(bytes,binary)=>{
    if(closed)return
    try{
     const data=bytes instanceof ArrayBuffer?Buffer.from(bytes):Array.isArray(bytes)?Buffer.concat(bytes):bytes
     if(binary||data.byteLength>65536)throw Error('invalid frame')
     const message=JSONRPCMessageSchema.parse(JSON.parse(data.toString()))
     transport.onmessage?.(message)
    }catch{transport.onerror?.(Error('MCP message rejected'));socket.close(1008,'invalid message')}
   })
   socket.on('error',()=>transport.onerror?.(Error('MCP connection unavailable')))
   socket.once('close',()=>{closed=true;transport.onclose?.()})
   if(socket.readyState===WebSocket.OPEN)return
   if(socket.readyState!==WebSocket.CONNECTING)throw Error('MCP connection unavailable')
   await new Promise<void>((resolve,reject)=>{
    const cleanup=()=>{socket.off('open',open);socket.off('close',failed);socket.off('error',failed)}
    const open=()=>{cleanup();resolve()}
    const failed=()=>{cleanup();reject(Error('MCP connection unavailable'))}
    socket.once('open',open);socket.once('close',failed);socket.once('error',failed)
   })
  },
  async send(message:JSONRPCMessage){
   if(closed||socket.readyState!==WebSocket.OPEN)throw Error('MCP connection unavailable')
   const value=JSON.stringify(message)
   // 回包也有界，异常业务回包不能耗尽出站缓存。
   if(Buffer.byteLength(value)>65536||socket.bufferedAmount>131072)throw Error('MCP message too large')
   await new Promise<void>((resolve,reject)=>socket.send(value,error=>error?reject(Error('MCP send unavailable')):resolve()))
  },
  async close(){
   if(closed)return
   closed=true
   if(socket.readyState===WebSocket.CLOSED)return
   await new Promise<void>(resolve=>{socket.once('close',()=>resolve());socket.terminate()})
  },
 }
 return transport
}
