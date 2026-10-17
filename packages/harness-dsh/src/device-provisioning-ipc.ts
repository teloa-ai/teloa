import {createServer,createConnection,type Socket} from 'node:net'
import {mkdir,lstat,chmod,unlink} from 'node:fs/promises'
import {join} from 'node:path'
import {hardwareRecord,hardwareOperationId} from '@teloa/contract'
import type {createDevicePairing} from './device-pairing.ts'

/** 只有同一 OS 用户可访问；不提供 begin、任意串口、浏览器会话或 shell 端口。 */
export async function startDeviceProvisioningIpc(root:string,service:ReturnType<typeof createDevicePairing>){
 const directory=join(root,'device-pairing');await mkdir(directory,{mode:0o700}) .catch(error=>{if(error.code!=='EEXIST')throw error})
 const parent=await lstat(directory)
 if(!parent.isDirectory()||parent.isSymbolicLink()||parent.mode&0o077||parent.uid!==process.getuid?.())throw new Error('USB 配对目录权限不正确。')
 const path=join(directory,'host.sock'),clients=new Set<Socket>()
 const prior=await lstat(path).catch(error=>{if(error.code!=='ENOENT')throw error;return undefined})
 if(prior){
  if(!prior.isSocket()||prior.uid!==parent.uid||prior.mode&0o077)throw new Error('配对 socket 归属无法核对。')
  const stale=await new Promise<boolean>(resolve=>{const probe=createConnection(path);probe.setTimeout(500,()=>{probe.destroy();resolve(false)});probe.once('connect',()=>{probe.destroy();resolve(false)});probe.once('error',(error:NodeJS.ErrnoException)=>resolve(error.code==='ECONNREFUSED'))})
  const current=await lstat(path).catch(()=>undefined)
  if(!stale||current?.ino!==prior.ino)throw new Error('配对服务已运行或无法核对。')
  await unlink(path)
 }
 const server=createServer(socket=>{
  if(clients.size>=4){socket.destroy();return};clients.add(socket);socket.setTimeout(5000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>clients.delete(socket))
  let bytes=Buffer.alloc(0),handled=false
  socket.on('data',chunk=>{
   if(handled)return
   bytes=Buffer.concat([bytes,chunk]);if(bytes.length>16384){socket.destroy();return}
   const end=bytes.indexOf(10);if(end<0)return;handled=true
   void (async()=>{
    try{
     const row=hardwareRecord(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,end))),['operation','id','nonce','confirmed','digest'])
     if(end!==bytes.length-1||!hardwareOperationId(row.id))throw Error()
     let result:unknown
     if(row.operation==='status'&&Object.keys(row).length===2)result=await service.status(row.id)
     else if(row.operation==='cancel'&&Object.keys(row).length===2)result=await service.cancel(row.id)
     else if(row.operation==='provision'&&Object.keys(row).length===4&&typeof row.nonce==='string'&&row.confirmed===true)result=await service.provision(row.id,{nonce:row.nonce,confirmed:true})
     else if(row.operation==='complete'&&Object.keys(row).length===3&&typeof row.digest==='string')result=await service.complete(row.id,row.digest)
     else throw Error()
     socket.end(JSON.stringify({ok:true,value:result})+'\n')
    }catch{socket.end('{"ok":false,"error":"配对请求已失效或无法核对。"}\n')}
   })()
  })
 })
 await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(path,()=>{server.removeListener('error',reject);resolve()})})
 server.on('error',()=>{})
 await chmod(path,0o600);const saved=await lstat(path);let closing:Promise<void>|undefined
 return Object.freeze({path,close(){return closing??= (async()=>{for(const socket of clients)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));const current=await lstat(path).catch(()=>undefined);if(current?.isSocket()&&current.ino===saved.ino)await unlink(path)})()}})
}
