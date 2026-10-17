import test from 'node:test'
import assert from 'node:assert/strict'
import {createSocket} from 'node:dgram'
import {randomUUID} from 'node:crypto'
import {deviceTimeProof,startDeviceTime} from '../src/device-time.ts'
import {deriveDeviceCredential} from '../src/device-pairing.ts'

test('新 nonce 的 HMAC 时钟只答复当前设备；篡改与撤销均无响应',async t=>{
 const secret=Buffer.alloc(32,8),id=randomUUID(),credential=deriveDeviceCredential(secret,id);let active=true
 const host=await startDeviceTime({host:'127.0.0.1',port:0,secret,now:()=>1800000000000,allowed:async(device,key)=>active&&device===id&&key===credential});t.after(()=>host.close())
 const socket=createSocket('udp4');t.after(()=>socket.close());await new Promise<void>(resolve=>socket.bind(0,'127.0.0.1',resolve))
 const send=(proof?:string)=>new Promise<Record<string,unknown>|null>((resolve,reject)=>{
  const nonce=randomUUID(),timer=setTimeout(()=>{socket.off('message',receive);resolve(null)},100)
  function receive(bytes:Buffer){clearTimeout(timer);socket.off('message',receive);resolve(JSON.parse(bytes.toString()))}
  socket.on('message',receive);socket.send(JSON.stringify({deviceId:id,nonce,proof:proof??deviceTimeProof(credential,`teloa-time-request/v1\n${id}\n${nonce}`)}),host.address.port,'127.0.0.1',error=>{if(error)reject(error)})
 })
 const response=await send();assert.equal(response?.unix_time,1800000000)
 assert.equal(response?.proof,deviceTimeProof(credential,`teloa-time/v1\n${response?.nonce}\n1800000000`))
 assert.equal(await send('0'.repeat(64)),null);active=false;assert.equal(await send(),null)
 await host.close();await host.close()
})
