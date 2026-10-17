import test from 'node:test'
import assert from 'node:assert/strict'
const valid={available:true,configured:true,writable:true,state:'ready',authorization:{enabled:true,grantVersion:2,scopes:['assistant.send','reply.read','task.prepare'],assistantName:'小松鼠'}}
test('硬件设置只接受有限状态回包，秘密或额外身份字段不得进入界面',async()=>{
 const api=await import('../src/client/hardware-devices-api.ts').catch(()=>({createHardwareDevicesApi:undefined}))
 assert.equal(typeof api.createHardwareDevicesApi,'function')
 let response:unknown=valid
 const devices=api.createHardwareDevicesApi!(async()=>response)
 assert.equal((await devices.status()).available,true)
 for(const bad of [{...valid,endpoint:'wss://secret'},{...valid,authorization:{...valid.authorization,ownerId:'foreign'}},{...valid,state:'made-up'},{...valid,configured:'yes'}]){
  response=bad;await assert.rejects(devices.status())
 }
 response={available:false};assert.deepEqual(await devices.status(),{available:false})
})
