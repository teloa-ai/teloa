import {createSocket} from 'node:dgram'
import {createHmac,timingSafeEqual} from 'node:crypto'
import {hardwareOperationId,hardwareRecord} from '@teloa/contract'
import {deriveDeviceCredential} from './device-pairing.ts'

export const deviceTimeProof=(key:string,text:string)=>createHmac('sha256',key).update(text).digest('hex')
const equal=(one:string,two:unknown)=>typeof two==='string'&&/^[a-f0-9]{64}$/.test(two)&&timingSafeEqual(Buffer.from(one,'hex'),Buffer.from(two,'hex'))
/** 有认证的引导时钟，不发凭据；随机 nonce 防旧时间回放，TLS 仍核对名称和日期。 */
export async function startDeviceTime(ports:{host:string;port:number;secret:Uint8Array;allowed:(id:string,credential:string)=>Promise<boolean>;now?:()=>number}){
 const socket=createSocket('udp4');let pending=0,window=0,count=0,closed=false
 socket.on('error',()=>{})
 socket.on('message',(bytes,peer)=>{
  const stamp=Date.now();if(stamp-window>1000){window=stamp;count=0}
  if(closed||bytes.length>1024||pending>=4||count++>=20)return;pending++
  void (async()=>{
   try{
    const row=hardwareRecord(JSON.parse(bytes.toString('utf8')),['deviceId','nonce','proof'])
    if(Object.keys(row).length!==3||!hardwareOperationId(row.deviceId)||!hardwareOperationId(row.nonce))return
    const credential=deriveDeviceCredential(ports.secret,row.deviceId)
    if(!equal(deviceTimeProof(credential,`teloa-time-request/v1\n${row.deviceId}\n${row.nonce}`),row.proof)||!await ports.allowed(row.deviceId,credential)||closed)return
    const time=Math.floor((ports.now?.()??Date.now())/1000)
    socket.send(JSON.stringify({nonce:row.nonce,unix_time:time,proof:deviceTimeProof(credential,`teloa-time/v1\n${row.nonce}\n${time}`)}),peer.port,peer.address,()=>{})
   }catch{/* 无效包与鉴权失败均无响应。 */}finally{pending--}
  })()
 })
 await new Promise<void>((resolve,reject)=>{socket.once('error',reject);socket.bind(ports.port,ports.host,()=>{socket.removeListener('error',reject);resolve()})})
 let closing:Promise<void>|undefined
 return Object.freeze({address:socket.address(),close:()=>closing??=new Promise<void>(resolve=>{closed=true;socket.close(()=>resolve())})})
}
