import test from 'node:test'
import assert from 'node:assert/strict'
import {createPendingReceiptRpc} from '../src/client/pending-receipt-rpc.ts'

const requestId='61a2a1d4-0d7b-4c1a-8c39-2a1d63a52b18'
const success={ok:true,value:{id:'saved',version:1},receipt:{requestId}}

test('市场原文件上传不触发通用pending确认，领域导入回执原样交给专用恢复器',async()=>{
 const calls:string[]=[],reply={ok:true,value:{receipt:{requestId},content:{id:'fixed'}}}
 const rpc=createPendingReceiptRpc(async endpoint=>{calls.push(endpoint);return reply},()=>assert.fail('市场上传没有通用pending回执'))
 assert.equal(await rpc('market-content/import',{requestId,files:[{base64:'a'.repeat(200_000)}]}),reply)
 assert.deepEqual(calls,['market-content/import'])
})

test('成功回包实际收到后才确认；业务值不被改写',async()=>{
 const calls:unknown[][]=[]
 let changed=0
 const rpc=createPendingReceiptRpc(async(endpoint,payload)=>{calls.push([endpoint,payload]);return endpoint==='requests/pending/ack'?{ok:true,value:{requestId}}:success},()=>changed++)
 assert.equal(await rpc('industry-data-sources/authorize',{requestId}),success)
 assert.deepEqual(calls,[['industry-data-sources/authorize',{requestId}],['requests/pending/ack',{requestId}]])
 assert.equal(changed,1)
})

test('DSH 传输仅保留 ok/value 时，仍按共享写命令清单确认收到的原请求',async()=>{
 const calls:string[]=[]
 const reply={ok:true,value:{id:'saved'}}
 const rpc=createPendingReceiptRpc(async endpoint=>{calls.push(endpoint);return reply},()=>{})
 assert.equal(await rpc('groups/messages/send',{requestId}),reply)
 assert.deepEqual(calls,['groups/messages/send','requests/pending/ack'])
})

test('原成功回包丢失时没有确认，服务端目录可以保留',async()=>{
 const calls:string[]=[]
 const rpc=createPendingReceiptRpc(async endpoint=>{calls.push(endpoint);throw Error('response lost')},()=>assert.fail('没有收到回包'))
 await assert.rejects(rpc('tasks/create',{requestId}),/response lost/)
 assert.deepEqual(calls,['tasks/create'])
})

test('确认提交后丢回包不遮蔽业务结果，并通知目录重读',async()=>{
 let acknowledged=false,changed=0
 const rpc=createPendingReceiptRpc(async endpoint=>{
  if(endpoint==='requests/pending/ack'){acknowledged=true;throw Error('ack response lost')}
  return success
 },()=>changed++)
 assert.equal(await rpc('security-actions/propose',{requestId}),success)
 assert.equal(acknowledged,true)
 assert.equal(changed,1)
})

test('确认超时有界；传输未响应取消也不阻塞原结果',async()=>{
 let ackSignal:AbortSignal|undefined
 const rpc=createPendingReceiptRpc(async(endpoint,_payload,signal)=>{
  if(endpoint==='requests/pending/ack'){ackSignal=signal;return new Promise<never>(()=>{})}
  return success
 },()=>{},10)
 assert.equal(await rpc('tasks/create',{requestId}),success)
 assert.equal(ackSignal?.aborted,true)
})

test('错误回包的拒绝码及结构化阻塞事实原样保留，不确认',async()=>{
 const failure={ok:false,error:{code:'teloa/conflict',message:'blocked',details:{runs:['active-run']}}}
 let calls=0
 const rpc=createPendingReceiptRpc(async()=>{calls++;return failure},()=>assert.fail('不应确认错误'))
 assert.equal(await rpc('industry-loads/unload',{requestId}),failure)
 assert.equal(calls,1)
})

test('旧回包、只读命令、没有自动回执的恢复不会重复确认',async()=>{
 for(const endpoint of ['tasks/list','requests/pending/recover']){
  let calls=0
  const reply={ok:true,value:{id:'saved'}}
  const rpc=createPendingReceiptRpc(async()=>{calls++;return reply},()=>assert.fail('没有自动回执'))
  assert.equal(await rpc(endpoint,{requestId}),reply)
  assert.equal(calls,1)
 }
})

test('畸形或错配回执不能确认另一请求；UUID大小写规范化',async()=>{
 for(const receipt of [null,{requestId:'wrong'},{requestId,extra:true},{requestId:'cda36fa7-d59d-4c85-9f0d-0f4386d63677'}]){
  let calls=0,changed=0
  const reply={...success,receipt}
  const rpc=createPendingReceiptRpc(async()=>{calls++;return reply},()=>changed++)
  assert.equal(await rpc('tasks/create',{requestId}),reply)
  assert.equal(calls,1)
  assert.equal(changed,1)
 }
 const rpc=createPendingReceiptRpc(async(endpoint,payload)=>{
  if(endpoint==='requests/pending/ack')assert.deepEqual(payload,{requestId})
  return success
 },()=>{})
 await rpc('tasks/create',{requestId:requestId.toUpperCase()})
})

test('看板刷新是共享写命令：回包无 receipt 时按 payload.requestId 确认；看板读取同形回包不确认',async()=>{
 const refreshCalls:unknown[][]=[]
 const reply={ok:true,value:{refreshing:true}}
 const refresh=createPendingReceiptRpc(async(endpoint,payload)=>{refreshCalls.push([endpoint,payload]);return endpoint==='requests/pending/ack'?{ok:true,value:{requestId}}:reply},()=>{})
 assert.equal(await refresh('business-dashboards/refresh',{requestId,scope:'SOC',dashboardId:'soc-overview'}),reply)
 assert.deepEqual(refreshCalls[1],['requests/pending/ack',{requestId}])
 const readCalls:string[]=[]
 const read=createPendingReceiptRpc(async endpoint=>{readCalls.push(endpoint);return reply},()=>assert.fail('只读命令没有回执'))
 assert.equal(await read('business-dashboards/read',{requestId,scope:'SOC',dashboardId:'soc-overview'}),reply)
 assert.deepEqual(readCalls,['business-dashboards/read'])
})
