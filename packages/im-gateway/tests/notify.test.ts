import test from 'node:test'
import assert from 'node:assert/strict'
import type {NotificationChannelInput} from '../../harness-dsh/src/notification-deliveries.ts'
import {createImNotificationAdapter} from '../src/core/notify.ts'
import {createBroadcastNotificationAdapter,createLocalNotificationAdapter} from '../../harness-dsh/src/notification-deliveries.ts'
import type {ImBinding} from '../src/core/bindings.ts'
import type {ImChannelAdapter} from '../src/core/types.ts'
import {recordingCardAdapter} from './approval-fakes.ts'
import {bindingOf} from './router-fakes.ts'

const input=(patch:Partial<NotificationChannelInput>={}):NotificationChannelInput=>({
 idempotencyKey:'notification:v1:'+'a'.repeat(64),ownerId:'local:teloa-owner',claimId:'c1c1c1c1-0000-4000-8000-000000000001',
 planId:'p1p1p1p1-0000-4000-8000-000000000002',taskId:'t1t1t1t1-0000-4000-8000-000000000003',runId:'r1r1r1r1-0000-4000-8000-000000000004',
 policy:'always',conclusion:'policy-always',...patch,
})

function setup(options:{bindings?:ImBinding[];online?:string[];adapters?:Record<string,ImChannelAdapter>;workbenchUrl?:string;send?:(channelId:string,chatId:string,text:string)=>Promise<{messageId:string}>}={}){
 const tg=recordingCardAdapter('telegram')
 const adapters:Record<string,ImChannelAdapter>={telegram:tg.adapter,...options.adapters}
 const rows=options.bindings??[bindingOf({chatId:'100'})]
 /** 经出站（限流、同聊天串行）发送；桩直接转给适配器。 */
 const routed:{channelId:string;chatId:string}[]=[]
 const notify=createImNotificationAdapter({
  bindings:{list:async(channelId?:string)=>rows.filter(row=>channelId===undefined||row.channelId===channelId)},
  adapter:channelId=>adapters[channelId],
  onlineChannels:()=>options.online??['telegram'],
  workbenchUrl:()=>options.workbenchUrl,
  send:options.send??((channelId,chatId,text)=>{routed.push({channelId,chatId});return adapters[channelId]!.send(chatId,text)}),
 })
 return {notify,tg,routed}
}

test('channel 为 im；正文等于固定模板：结论文案 + task id + run id（+ 工作台链接），不含计划、策略等其它输入',async()=>{
 const {notify,tg}=setup()
 assert.equal(notify.channel,'im')
 const receipt=await notify.deliver(input(),new AbortController().signal)
 assert.deepEqual(tg.sent,[{chatId:'100',text:'任务运行已完成\ntask t1t1t1t1-0000-4000-8000-000000000003\nrun r1r1r1r1-0000-4000-8000-000000000004'}])
 assert.equal(receipt.receiptId,'im:telegram:msg-1')
 assert.doesNotMatch(tg.sent[0]!.text,/p1p1p1p1|c1c1c1c1|notification:v1|always/)
})

test('配置状态按本人私聊绑定判断，已绑定但暂时离线仍是待投递目标',async()=>{
 assert.equal(await setup({bindings:[]}).notify.isConfigured?.(input().ownerId),false)
 assert.equal(await setup({bindings:[bindingOf()]}).notify.isConfigured?.(input().ownerId),false)
 assert.equal(await setup({bindings:[bindingOf({chatId:'100',ownerId:'another-owner'})]}).notify.isConfigured?.(input().ownerId),false)
 assert.equal(await setup({online:[]}).notify.isConfigured?.(input().ownerId),true)
})

test('多适配器部分失败后原编号重试，成功的 IM 不重复发送',async()=>{
 const {notify,tg}=setup(),broadcast=createBroadcastNotificationAdapter(createLocalNotificationAdapter({info(){}}),{warn(){}})
 let failing=true
 const keys:string[]=[]
 broadcast.add(notify);broadcast.add({channel:'other',deliver:async request=>{keys.push(request.idempotencyKey);if(failing)throw new Error('offline');return {receiptId:'other'}}})
 const request=input(),signal=new AbortController().signal
 await assert.rejects(broadcast.deliver(request,signal),/offline/)
 failing=false
 await broadcast.deliver(request,signal)
 assert.equal(tg.sent.length,1)
 assert.deepEqual(keys,[request.idempotencyKey,request.idempotencyKey])
})

test('三种结论的固定文案；有工作台地址时附在末行',async()=>{
 const cases=[['policy-always','任务运行已完成'],['attention-required','任务需要你处理'],['execution-failed','任务运行失败']] as const
 for(const [conclusion,headline] of cases){
  const {notify,tg}=setup({workbenchUrl:'http://127.0.0.1:3100/'})
  await notify.deliver(input({conclusion}),new AbortController().signal)
  assert.equal(tg.sent[0]!.text,`${headline}\ntask t1t1t1t1-0000-4000-8000-000000000003\nrun r1r1r1r1-0000-4000-8000-000000000004\nhttp://127.0.0.1:3100/`)
 }
})

test('无在线绑定渠道（无绑定／渠道离线／绑定无私聊 chatId／绑定属于别的 owner）→ reject 且不发送',async()=>{
 for(const options of [{bindings:[]},{online:[]},{bindings:[bindingOf()]},{bindings:[bindingOf({chatId:'100',ownerId:'someone-else'})]}]){
  const {notify,tg}=setup(options)
  await assert.rejects(notify.deliver(input(),new AbortController().signal),/im: no bound channel/)
  assert.equal(tg.sent.length,0)
 }
})

test('只推给绑定者本人私聊：取在线渠道里第一个本 owner 的私聊绑定',async()=>{
 const sl=recordingCardAdapter('slack')
 const {notify,tg}=setup({online:['slack','telegram'],adapters:{slack:sl.adapter},bindings:[bindingOf({chatId:'100'}),bindingOf({channelId:'slack',imUserId:'U1',chatId:'D1'})]})
 const receipt=await notify.deliver(input(),new AbortController().signal)
 assert.equal(sl.sent.length,1)
 assert.equal(sl.sent[0]!.chatId,'D1')
 assert.equal(tg.sent.length,0)
 assert.equal(receipt.receiptId,'im:slack:msg-1')
})

test('signal 已 abort → throw 且不发送；发送失败原样抛出（广播只记 channel 与错误码）',async()=>{
 const {notify,tg}=setup()
 const controller=new AbortController()
 controller.abort()
 await assert.rejects(notify.deliver(input(),controller.signal))
 assert.equal(tg.sent.length,0)
 const failing=recordingCardAdapter('telegram')
 failing.adapter.send=async()=>{throw Object.assign(new Error('boom token=abc'),{code:'im/send-failed'})}
 const broken=setup({adapters:{telegram:failing.adapter}})
 await assert.rejects(broken.notify.deliver(input(),new AbortController().signal),/boom/)
})

test('L2 通知经出站发送（限流、同聊天串行），不直接调适配器 send',async()=>{
 const {notify,tg,routed}=setup()
 await notify.deliver(input(),new AbortController().signal)
 assert.deepEqual(routed,[{channelId:'telegram',chatId:'100'}])
 assert.equal(tg.sent.length,1)
})

test('L2 同一运行同一结论只推一次（driver 重试、并发重入）：回执相同；不同结论照常推送；发送失败不记，重试会再发',async()=>{
 const {notify,tg}=setup()
 const signal=new AbortController().signal
 const [a,b]=await Promise.all([notify.deliver(input(),signal),notify.deliver(input({idempotencyKey:'notification:v1:'+'c'.repeat(64)}),signal)])
 const c=await notify.deliver(input(),signal)
 assert.equal(tg.sent.length,1)
 assert.deepEqual([b,c],[a,a])
 await notify.deliver(input({conclusion:'execution-failed'}),signal)
 assert.equal(tg.sent.length,2)
 let fail=true
 const flaky=setup({send:async()=>{if(fail){fail=false;throw new Error('network')}return {messageId:'m-2'}}})
 await assert.rejects(flaky.notify.deliver(input(),signal),/network/)
 assert.deepEqual(await flaky.notify.deliver(input(),signal),{receiptId:'im:telegram:m-2'})
})
