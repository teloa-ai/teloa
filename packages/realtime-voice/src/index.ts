import type {IncomingMessage} from 'node:http'
import type {Context} from '@deepseek-ai/cordis'
import type {HostConnectionHandle} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {TeloaVoicePluginPort} from '@teloa/harness-dsh/voice-plugin'
import {WebSocketServer} from 'ws'
import {createRealtimeVoiceMedia,realtimeVoicePath,realtimeVoiceProtocol} from './server.ts'

export const name='teloa-realtime-voice'
export const inject=['teloaVoice','connection','webServer'] as const
/** 同源只解决 CSRF；付费媒体还必须是宿主实际认证的本人浏览器 peer。 */
export function authorizeVoiceSocket(connection:Pick<HostConnectionHandle,'admit'|'browserPeer'>,request:IncomingMessage):boolean{
 const admission=connection.admit(request)
 return !('rejection' in admission)&&admission.peer===connection.browserPeer
}
export function apply(ctx:Context){
 const port=ctx.get('teloaVoice') as TeloaVoicePluginPort,bridge=createRealtimeVoiceMedia(port)
 const acceptor=new WebSocketServer({noServer:true,maxPayload:64*1024,handleProtocols:protocols=>protocols.has(realtimeVoiceProtocol)?realtimeVoiceProtocol:false})
 ctx.effect(()=>{
  let detach:(()=>void)|undefined
  try{
   detach=port.attach(bridge.media)
   const off=ctx.webServer.registerUpgrade({path:realtimeVoicePath,handler(request,socket,head){
    const protocols=String(request.headers['sec-websocket-protocol']??'').split(',').map(value=>value.trim())
    if(request.url!==realtimeVoicePath||!protocols.includes(realtimeVoiceProtocol)||!authorizeVoiceSocket(ctx.connection,request)){
     socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
     return
    }
    acceptor.handleUpgrade(request,socket,head,client=>bridge.accept(client))
   }})
   return async()=>{
    off()
    try{await bridge.closeAll()}
    finally{detach?.();bridge.media.dispose();acceptor.close()}
   }
  }catch(error){
   detach?.();bridge.media.dispose();acceptor.close()
   throw error
  }
 },'Teloa 实时语音媒体')
}
