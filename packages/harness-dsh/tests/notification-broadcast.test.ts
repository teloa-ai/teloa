import test from 'node:test'
import assert from 'node:assert/strict'
import {createBroadcastNotificationAdapter,type NotificationChannelAdapter,type NotificationChannelInput} from '../src/notification-deliveries.ts'

const input:NotificationChannelInput={idempotencyKey:'notification:v1:'+'a'.repeat(64),ownerId:'owner',claimId:'11111111-1111-4111-8111-111111111111',planId:'22222222-2222-4222-8222-222222222222',taskId:'33333333-3333-4333-8333-333333333333',runId:'44444444-4444-4444-8444-444444444444',policy:'attention',conclusion:'attention-required'}

function adapter(channel:string,behaviour:'ok'|Error):NotificationChannelAdapter&{calls:number}{
 const row={channel,calls:0,deliver:async()=>{row.calls+=1;if(behaviour instanceof Error)throw behaviour;return {receiptId:channel+':'+input.idempotencyKey}}}
 return row
}

test('channel 沿用 primary.channel；日志成功不能掩盖已配置通知渠道的发送失败',async()=>{
 const primary=adapter('local-log','ok'),im=adapter('im-telegram',new Error('Authorization: Bearer secret'))
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 assert.equal(broadcast.channel,'local-log')
 broadcast.add(im)
 await assert.rejects(broadcast.deliver(input,new AbortController().signal),{message:'Authorization: Bearer secret'})
 assert.equal(primary.calls,1)
 assert.equal(im.calls,1)
})

test('所有追加通知渠道均需成功，单个发送成功不能掩盖其他接收方失败',async()=>{
 const primary=adapter('local-log','ok'),im=adapter('im-telegram','ok'),slack=adapter('im-slack',new Error('slack unavailable'))
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}})
 broadcast.add(im);broadcast.add(slack)
 await assert.rejects(broadcast.deliver(input,new AbortController().signal),{message:'slack unavailable'})
 assert.equal(im.calls,1);assert.equal(slack.calls,1)
})

test('日志回执返回后已中止，不再发送 IM 或完成通知',async()=>{
 const controller=new AbortController(),im=adapter('im-telegram','ok')
 const primary:NotificationChannelAdapter={channel:'local-log',deliver:async()=>{controller.abort();return {receiptId:'log'}}}
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}});broadcast.add(im)
 await assert.rejects(broadcast.deliver(input,controller.signal),{name:'AbortError'})
 assert.equal(im.calls,0)
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
 await assert.rejects(broadcast.deliver(input,new AbortController().signal))
 assert.equal(records.length,2)
 assert.ok(records[0]!.includes('im-telegram')&&records[0]!.includes('ECONNRESET'))
 assert.ok(records[1]!.includes('im-slack')&&records[1]!.includes('unknown'))
 assert.ok(!JSON.stringify(records).includes('secret'))
})

test('默认加载插件但本人未配置通知目标时，跳过该插件而不制造发送失败',async()=>{
 const primary=adapter('local-log','ok'),im=Object.assign(adapter('im','ok'),{isConfigured:async(ownerId:string)=>{assert.equal(ownerId,input.ownerId);return false}})
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}});broadcast.add(im)
 assert.deepEqual(await broadcast.deliver(input,new AbortController().signal),{receiptId:'broadcast:'+input.idempotencyKey})
 assert.equal(im.calls,0);assert.equal(primary.calls,1)
})

test('通知目标读取失败不能降为未配置，也不能被日志成功覆盖',async()=>{
 const primary=adapter('local-log','ok'),im=Object.assign(adapter('im','ok'),{isConfigured:async()=>{throw new Error('binding unavailable')}})
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}});broadcast.add(im)
 await assert.rejects(broadcast.deliver(input,new AbortController().signal),{message:'binding unavailable'})
 assert.equal(im.calls,0)
})

test('前序回执等待期间移除追加适配器，不再向已移除目标发送',async()=>{
 let dispose=()=>{}
 const primary:NotificationChannelAdapter={channel:'local-log',deliver:async()=>{dispose();return {receiptId:'log'}}},im=adapter('im','ok')
 const broadcast=createBroadcastNotificationAdapter(primary,{warn(){}});dispose=broadcast.add(im)
 await broadcast.deliver(input,new AbortController().signal)
 assert.equal(im.calls,0)
})

test('配置读取等待期间移除插件，随后读取失败也不再要求该目标投递',async()=>{
 let started!:()=>void,reject!: (error:Error)=>void
 const checking=new Promise<void>(resolve=>{started=resolve})
 const pending=new Promise<boolean>((_,fail)=>{reject=fail})
 const im=Object.assign(adapter('im','ok'),{isConfigured:async()=>{started();return pending}})
 const broadcast=createBroadcastNotificationAdapter(adapter('local-log','ok'),{warn(){}}),dispose=broadcast.add(im)
 const delivery=broadcast.deliver(input,new AbortController().signal)
 await checking
 dispose();reject(new Error('binding unavailable'))
 assert.deepEqual(await delivery,{receiptId:'broadcast:'+input.idempotencyKey})
 assert.equal(im.calls,0)
})
