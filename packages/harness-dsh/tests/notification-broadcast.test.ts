import test from 'node:test'
import assert from 'node:assert/strict'
import {createBroadcastNotificationAdapter,type NotificationChannelAdapter,type NotificationChannelInput} from '../src/notification-deliveries.ts'

const input:NotificationChannelInput={idempotencyKey:'notification:v1:'+'a'.repeat(64),ownerId:'owner',claimId:'11111111-1111-4111-8111-111111111111',planId:'22222222-2222-4222-8222-222222222222',taskId:'33333333-3333-4333-8333-333333333333',runId:'44444444-4444-4444-8444-444444444444',policy:'attention',conclusion:'attention-required'}

function adapter(channel:string,behaviour:'ok'|Error):NotificationChannelAdapter&{calls:number}{
 const row={channel,calls:0,deliver:async()=>{row.calls+=1;if(behaviour instanceof Error)throw behaviour;return {receiptId:channel+':'+input.idempotencyKey}}}
 return row
}

test('I1：channel 沿用 primary.channel（升级前后投递去重键不变）；primary 成功、追加适配器抛错仍回执且 receiptId 以 broadcast: 开头',async()=>{
 const primary=adapter('local-log','ok'),im=adapter('im-telegram',new Error('Authorization: Bearer secret'))
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 assert.equal(broadcast.channel,'local-log')
 broadcast.add(im)
 const receipt=await broadcast.deliver(input,new AbortController().signal)
 assert.equal(receipt.receiptId,'broadcast:'+input.idempotencyKey)
 assert.equal(primary.calls,1)
 assert.equal(im.calls,1)
})

test('primary 抛错、追加适配器成功也算送达',async()=>{
 const primary=adapter('local-log',new Error('disk full')),im=adapter('im-slack','ok')
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 broadcast.add(im)
 assert.deepEqual(await broadcast.deliver(input,new AbortController().signal),{receiptId:'broadcast:'+input.idempotencyKey})
})

test('全部适配器抛错 → reject 且抛出最后一个错误',async()=>{
 const primary=adapter('local-log',new Error('first')),im=adapter('im-feishu',new Error('last'))
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 broadcast.add(im)
 await assert.rejects(broadcast.deliver(input,new AbortController().signal),{message:'last'})
})

test('add() 返回的 dispose 生效：移除后不再调用该适配器',async()=>{
 const primary=adapter('local-log','ok'),im=adapter('im-telegram','ok')
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 const dispose=broadcast.add(im)
 await broadcast.deliver(input,new AbortController().signal)
 dispose()
 await broadcast.deliver(input,new AbortController().signal)
 assert.equal(primary.calls,2)
 assert.equal(im.calls,1)
})

test('signal 已 abort 时 throw 且不调任何适配器',async()=>{
 const primary=adapter('local-log','ok'),im=adapter('im-telegram','ok')
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 broadcast.add(im)
 const controller=new AbortController();controller.abort()
 await assert.rejects(broadcast.deliver(input,controller.signal),{name:'AbortError'})
 assert.equal(primary.calls,0)
 assert.equal(im.calls,0)
})

test('M3：适配器失败记录 channel 与安全错误码，不记错误原文与凭据',async()=>{
 const records:unknown[][]=[]
 const primary=adapter('local-log','ok'),im=adapter('im-telegram',Object.assign(new Error('Authorization: Bearer secret-token'),{code:'ECONNRESET'}))
 const slack=adapter('im-slack',new Error('xoxb-secret-token leaked'))
 const broadcast=createBroadcastNotificationAdapter(primary,{warn:(...args:unknown[])=>records.push(args)})
 broadcast.add(im);broadcast.add(slack)
 await broadcast.deliver(input,new AbortController().signal)
 assert.equal(records.length,2)
 assert.ok(records[0]!.includes('im-telegram')&&records[0]!.includes('ECONNRESET'))
 assert.ok(records[1]!.includes('im-slack')&&records[1]!.includes('unknown'))
 assert.ok(!JSON.stringify(records).includes('secret'))
})
