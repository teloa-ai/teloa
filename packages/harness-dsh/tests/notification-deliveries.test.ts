import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'

const feature=await import('../src/notification-deliveries.ts').catch(()=>null)

test('Harness 提供可注入通知投递驱动和本机 adapter',()=>{
 assert.equal(typeof feature?.NotificationDeliveryDriver,'function')
 assert.equal(typeof feature?.createLocalNotificationAdapter,'function')
})

const delivery={id:'notification:v1:'+'a'.repeat(64),ownerId:'owner',claimId:'11111111-1111-4111-8111-111111111111',planId:'22222222-2222-4222-8222-222222222222',taskId:'33333333-3333-4333-8333-333333333333',runId:'44444444-4444-4444-8444-444444444444',policy:'attention' as const,conclusion:'attention-required' as const,channel:'local-log',status:'delivering' as const,attempts:1,attemptToken:'55555555-5555-4555-8555-555555555555',leaseExpiresAt:'2026-09-13T00:00:30.000Z',receipt:null,error:null,createdAt:'2026-09-13T00:00:00.000Z',updatedAt:'2026-09-13T00:00:00.000Z',deliveredAt:null}

function fixture(){
 const calls:{materialize:unknown[];claim:unknown[];complete:unknown[];fail:unknown[];adapter:unknown[]}={materialize:[],claim:[],complete:[],fail:[],adapter:[]}
 let claimed=false,adapterFailure:unknown
 const service={
  materialize:async(owner:string,input:unknown)=>{calls.materialize.push([owner,input]);return {deliveryIds:[delivery.id]}},
  claim:async(owner:string,input:unknown)=>{calls.claim.push([owner,input]);if(claimed)return null;claimed=true;return delivery},
  complete:async(owner:string,input:unknown)=>{calls.complete.push([owner,input]);return {...delivery,status:'delivered' as const}},
  fail:async(owner:string,input:unknown)=>{calls.fail.push([owner,input]);return {...delivery,status:'failed' as const}},
 }
 const adapter={channel:'local-log',deliver:async(input:unknown)=>{calls.adapter.push(input);if(adapterFailure)throw adapterFailure;return {receiptId:'local:'+delivery.id}}}
 const driver=new feature!.NotificationDeliveryDriver(service,adapter,{now:()=>'2026-09-13T00:00:00.000Z',limit:20})
 return {calls,service,adapter,driver,fail:(error:unknown)=>{adapterFailure=error}}
}

test('投递只消费已物化记录，adapter 收到 stable idempotency key，成功只写通知回执',async()=>{
 const f=fixture(),result=await f.driver.deliver('owner',new AbortController().signal)
 assert.deepEqual(result,{materialized:1,attempted:1,delivered:1,failed:0})
 assert.deepEqual(f.calls.materialize,[['owner',{channel:'local-log',limit:20,now:'2026-09-13T00:00:00.000Z'}]])
 assert.deepEqual(f.calls.adapter,[{idempotencyKey:delivery.id,ownerId:'owner',claimId:delivery.claimId,planId:delivery.planId,taskId:delivery.taskId,runId:delivery.runId,policy:'attention',conclusion:'attention-required'}])
 assert.deepEqual(f.calls.complete,[['owner',{deliveryId:delivery.id,attemptToken:delivery.attemptToken,receiptId:'local:'+delivery.id,now:'2026-09-13T00:00:00.000Z'}]])
 assert.deepEqual(f.calls.fail,[])
})

test('通道失败只记录安全错误码，不泄漏错误文本也不抛回执行循环',async()=>{
 const f=fixture();f.fail(new Error('Authorization: Bearer secret-token'))
 const result=await f.driver.deliver('owner',new AbortController().signal)
 assert.deepEqual(result,{materialized:1,attempted:1,delivered:0,failed:1})
 assert.deepEqual(f.calls.complete,[])
 assert.deepEqual(f.calls.fail,[['owner',{deliveryId:delivery.id,attemptToken:delivery.attemptToken,code:'teloa/notification-unavailable',now:'2026-09-13T00:00:00.000Z'}]])
 assert.ok(!JSON.stringify(f.calls).includes('secret-token'))
})

test('Abort 不写失败回执，租约到期后由后端恢复',async()=>{
 const f=fixture(),controller=new AbortController();f.adapter.deliver=async()=>{controller.abort();throw new DOMException('aborted','AbortError')}
 await assert.rejects(f.driver.deliver('owner',controller.signal),{name:'AbortError'})
 assert.deepEqual(f.calls.complete,[]);assert.deepEqual(f.calls.fail,[])
})

test('本机 adapter 只记录事实引用并用 delivery id 返回可核对回执',async()=>{
 const records:unknown[][]=[],adapter=feature!.createLocalNotificationAdapter({info:(...args:unknown[])=>records.push(args)})
 assert.equal(adapter.channel,'local-log')
 const receipt=await adapter.deliver({idempotencyKey:delivery.id,ownerId:'owner',claimId:delivery.claimId,planId:delivery.planId,taskId:delivery.taskId,runId:delivery.runId,policy:'attention',conclusion:'attention-required'},new AbortController().signal)
 assert.deepEqual(receipt,{receiptId:'local-log:'+delivery.id});assert.equal(records.length,1)
 assert.match(String(records[0]?.[0]),/通知投递/);assert.ok(JSON.stringify(records[0]).includes(delivery.id));assert.ok(!JSON.stringify(records[0]).includes('credential'))
})

test('宿主初始化投递表并把同一投递器接入计划协调与 Run 观察，不新增通知 RPC',async()=>{
 const source=await readFile(new URL('../src/index.ts',import.meta.url),'utf8')
 const sequence=await readFile(new URL('../../backend/src/work/initialize-database.ts',import.meta.url),'utf8')
 assert.match(source,/await initializeTeloaDatabase\(database\.pool[,)]/)
 assert.match(sequence,/await initializeNotificationDeliveries\(pool\)/)
 assert.match(source,/const deliverNotifications=/)
 assert.match(source,/deliverNotifications/)
 assert.match(source,/deliver:async\(\)=>\{await deliverNotifications\(owner,new AbortController\(\)\.signal\);await deliverConversationWork\(\)\}/)
 assert.ok(!source.includes("'notifications/"))
})
