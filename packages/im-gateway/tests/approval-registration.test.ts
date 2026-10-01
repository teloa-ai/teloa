import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {Context} from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'
import type {ApprovalOutcome,ApprovalRequestEvent} from '@deepseek-ai/dsh-user-approval/types'
import type {AskUserQuestionAnswer} from '@deepseek-ai/dsh-user-questions/types'
import {createBroadcastNotificationAdapter,createLocalNotificationAdapter} from '../../harness-dsh/src/notification-deliveries.ts'
import {createTeloaWorkService} from '../../harness-dsh/src/teloa-work-service.ts'
import {createImApproval} from '../src/core/approval.ts'
import * as imGateway from '../src/index.ts'
import {agentWith,approvalHarness,click,recordingCardAdapter,until} from './approval-fakes.ts'
import {fakeCredentials,withTemp} from './im-fakes.ts'

const req={agent:agentWith('{"command":"ls"}','call-1','sess-1'),callId:'call-1',toolName:'bash'} as unknown as ApprovalRequestEvent

test('12. cordis 真实实例：先注册工作台桩，再以 {global,prepend} 注册 IM → IM 先收到，其 next() 到达工作台桩',async()=>{
 const ctx=new Context()
 const order:string[]=[]
 const {deps,tg}=approvalHarness()
 const im=createImApproval(deps)
 ctx.on('approval/request',async()=>{order.push(`workbench(cards=${tg.cards.length})`);return 'rejected'})
 ctx.on('approval/request',function(this:unknown,request,next){order.push('im');return im.answerer.call(this,request,next)},{global:true,prepend:true})
 const outcome=await ctx.waterfall('approval/request',req,()=>Promise.resolve('unavailable' as ApprovalOutcome))
 assert.deepEqual(order,['im','workbench(cards=1)'])
 assert.equal(outcome,'rejected')
 assert.deepEqual(tg.edits.map(row=>row.text),['已在网页处理'])
})

async function mount(root:string,options:{webServer?:{port:number};broadcast?:ReturnType<typeof createBroadcastNotificationAdapter>}={}){
 const dir=join(root,'im-gateway')
 await mkdir(dir,{recursive:true})
 await writeFile(join(dir,'channels.json'),JSON.stringify({channels:[{channelId:'telegram',kind:'telegram',enabled:true,createdAt:'2026-09-26T00:00:00.000Z'}]}))
 await writeFile(join(dir,'im-bindings.json'),JSON.stringify({bindings:[{channelId:'telegram',imUserId:'u1',ownerId:'local:teloa-owner',displayName:'张三',boundAt:'2026-09-26T00:00:00.000Z',target:{kind:'assistant'},chatId:'100'}]}))
 const tg=recordingCardAdapter('telegram')
 const teloaWork=createTeloaWorkService({
  owner:'local:teloa-owner',runtimeRoot:root,
  dispatch:async endpoint=>endpoint==='roles/list'||endpoint==='groups/list'?[]:undefined,
  broadcast:options.broadcast??({add:()=>()=>{}} as never),
  install:async()=>join(root,'sdk'),attachAllowed:()=>true,
 })
 const ctx=new Context()
 ctx.provide('teloaWork',teloaWork)
 ctx.provide('credentials',fakeCredentials().credentials)
 ctx.provide('sessionController',{})
 ctx.provide('sessions',{})
 if(options.webServer)ctx.provide('webServer',options.webServer)
 // 工作台 answerer 先于插件注册（真实宿主里 dsh-client-ui-approval 较早装载）。
 const workbench={approval:[] as ((o:ApprovalOutcome)=>void)[],questions:[] as ((a:AskUserQuestionAnswer)=>void)[]}
 ctx.on('approval/request',()=>new Promise<ApprovalOutcome>(resolve=>{workbench.approval.push(resolve)}))
 ctx.on('user-questions/request',()=>new Promise<AskUserQuestionAnswer>(resolve=>{workbench.questions.push(resolve)}))
 const fiber=ctx.plugin(imGateway,{createAdapter:()=>tg.adapter})
 await fiber
 // 渠道在插件装载后异步启动：等到入站处理器真的挂上再往下走；按次数轮询到点就静默放行，后面只会在 handler! 上炸出无关错误。
 await until(()=>tg.state.handler!==undefined,'IM 渠道启动并挂上入站处理器')
 return {ctx,tg,teloaWork,fiber,workbench}
}

test('12. 插件装载：审批旁路排在工作台之前；IM 按钮经真实入站链裁决，工作台卡片仍在等待（已知限制）',()=>withTemp(async root=>{
 const {ctx,tg,fiber,workbench}=await mount(root)
 const result=ctx.waterfall('approval/request',req,()=>Promise.resolve('unavailable' as ApprovalOutcome))
 await until(()=>tg.cards.length>0&&workbench.approval.length>0,'IM 发卡且 next() 到达工作台')
 assert.equal(tg.cards.length,1)
 assert.equal(tg.cards[0]!.chatId,'100')
 assert.equal(workbench.approval.length,1,'IM 发卡后 next() 到达工作台')
 // 非绑定者经入站链点击：无权，不裁决。
 await tg.state.handler!(click({callbackId:tg.cards[0]!.card.callbackId,sender:{imUserId:'u9',displayName:'李四'}}))
 assert.match(tg.acks[0]!.text!,/无权/)
 await tg.state.handler!(click({callbackId:tg.cards[0]!.card.callbackId,value:'approve'}))
 assert.equal(await result,'allowed-once')
 assert.deepEqual(tg.edits.map(row=>row.text),['已批准（IM）'])
 await fiber.dispose()
}))

test('12. 插件装载：提问旁路排在工作台之前；绑定者私聊回复编号即回答',()=>withTemp(async root=>{
 const {ctx,tg,fiber,workbench}=await mount(root)
 const result=ctx.waterfall('user-questions/request',{questions:[{id:'q',question:'选哪个？',options:[{label:'甲'},{label:'乙'}]}]},()=>Promise.reject(new Error('NO_PROVIDER')))
 await until(()=>tg.sent.length>0&&workbench.questions.length>0,'IM 发出提问且 next() 到达工作台')
 assert.match(tg.sent[0]!.text,/选哪个？/)
 assert.equal(workbench.questions.length,1)
 await tg.state.handler!({channelId:'telegram',chatId:'100',chatKind:'direct',messageId:'r1',sender:{imUserId:'u1',displayName:'张三'},text:'1',mentions:[],media:[],at:'2026-09-26T00:00:00.000Z',raw:{}})
 assert.deepEqual(await result,{answers:[{id:'q',selected:['甲']}]})
 await fiber.dispose()
}))

test('停用渠道 → 停渠道前撤下待决审批卡（停用文案），不裁决；工作台仍可答',()=>withTemp(async root=>{
 const {ctx,tg,teloaWork,fiber,workbench}=await mount(root)
 const result=ctx.waterfall('approval/request',req,()=>Promise.resolve('unavailable' as ApprovalOutcome))
 await until(()=>tg.cards.length>0&&workbench.approval.length>0,'IM 发卡且 next() 到达工作台')
 await teloaWork.dispatchExtension('im/channels/disable',{requestId:'5f0c3a52-6b1e-4d8a-9f2b-1c3d4e5f6a7b',channelId:'telegram'},new AbortController().signal)
 assert.deepEqual(tg.edits.map(row=>row.text),['渠道已停用，请到工作台处理'])
 workbench.approval[0]!('rejected')
 assert.equal(await result,'rejected')
 await fiber.dispose()
}))

test('L1 插件释放：先撤全部待决卡与提问（停止文案），再停渠道；不裁决、工作台仍可答',()=>withTemp(async root=>{
 const {ctx,tg,fiber,workbench}=await mount(root)
 const order:string[]=[]
 const stop=tg.adapter.stop.bind(tg.adapter)
 tg.adapter.stop=async()=>{order.push('stop');await stop()}
 const edit=tg.adapter.editMessage!.bind(tg.adapter)
 tg.adapter.editMessage=async(chatId,messageId,text)=>{order.push('edit:'+text);await edit(chatId,messageId,text)}
 const result=ctx.waterfall('approval/request',req,()=>Promise.resolve('unavailable' as ApprovalOutcome))
 await until(()=>tg.cards.length>0&&workbench.approval.length>0,'IM 发卡且 next() 到达工作台')
 assert.equal(tg.cards.length,1)
 await fiber.dispose()
 assert.deepEqual(order,['edit:IM 通道已停止，请到工作台处理','stop'])
 workbench.approval[0]!('rejected')
 assert.equal(await result,'rejected')
}))

test('L2 过期／高危命令文案附工作台链接：宿主有 webServer 时取其监听端口拼不含令牌的本机地址；没有则不附',()=>withTemp(async root=>{
 assert.equal(imGateway.workbenchUrlOf({port:3100}),'http://127.0.0.1:3100/')
 assert.equal(imGateway.workbenchUrlOf({port:0}),undefined)
 assert.equal(imGateway.workbenchUrlOf(undefined),undefined)
 const withServer=await mount(root,{webServer:{port:3100}})
 await withServer.tg.state.handler!({channelId:'telegram',chatId:'100',chatKind:'direct',messageId:'k1',sender:{imUserId:'u1',displayName:'张三'},text:'/设置密钥 abc',mentions:[],media:[],at:'2026-09-26T00:00:00.000Z',raw:{}})
 assert.match(withServer.tg.sent.at(-1)!.text,/请到工作台完成[^\n]*\nhttp:\/\/127\.0\.0\.1:3100\/$/)
 await withServer.fiber.dispose()
}))

test('功能验证 插件装载：IM 通知适配器挂到宿主广播上，推给绑定者私聊（只含结论、task、run 与工作台链接）；释放后摘除',()=>withTemp(async root=>{
 const warns:unknown[][]=[]
 const broadcast=createBroadcastNotificationAdapter(createLocalNotificationAdapter({info(){}}),{warn:(...values:unknown[])=>{warns.push(values)}})
 const {tg,fiber}=await mount(root,{broadcast,webServer:{port:3100}})
 const input={idempotencyKey:'notification:v1:'+'b'.repeat(64),ownerId:'local:teloa-owner',claimId:'c',planId:'p',taskId:'task-1',runId:'run-1',policy:'failure' as const,conclusion:'execution-failed' as const}
 assert.equal(broadcast.channel,'local-log')
 assert.deepEqual(await broadcast.deliver(input,new AbortController().signal),{receiptId:'broadcast:'+input.idempotencyKey})
 assert.deepEqual(tg.sent.map(row=>[row.chatId,row.text]),[['100','任务运行失败\ntask task-1\nrun run-1\nhttp://127.0.0.1:3100/']])
 assert.equal(warns.length,0)
 await fiber.dispose()
 await broadcast.deliver(input,new AbortController().signal)
 assert.equal(tg.sent.length,1,'释放后不再推送')
}))
