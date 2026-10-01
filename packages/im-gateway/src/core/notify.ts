/**
 * 通知推送的 IM 适配器（规格 §9）：经 teloaWork.notifications.addAdapter 挂到宿主广播适配器上，旁路投递。
 * 广播沿用 primary.channel（local-log）去重，本适配器失败不影响回执，广播只记 channel 与错误码。
 * 正文只含结论固定文案、任务 id、运行 id 与工作台链接（有则附），不含标题、正文、结果内容；
 * 只推给本 owner 的绑定者私聊（配对时记下的 chatId），在线渠道里取第一个。安全动作只推送、不在 IM 决定。
 * 发送经出站（渠道限流、同聊天串行）；同一运行同一结论在内存里只推一次，driver 重试拿回同一回执（审查 L2）。
 */
import type {ImBinding} from './bindings.ts'
import type {ImChannelAdapter} from './types.ts'

/** 与 harness-dsh `notification-deliveries.ts` 的 NotificationChannelInput／NotificationChannelAdapter 同构（插件不引入宿主源码）。 */
export type NotificationInput={
 idempotencyKey:string;ownerId:string;claimId:string;planId:string;taskId:string;runId:string
 policy:'always'|'attention'|'failure';conclusion:'policy-always'|'attention-required'|'execution-failed'
}
export type NotificationAdapter={channel:string;deliver:(input:NotificationInput,signal:AbortSignal)=>Promise<{receiptId:string}>}

export type NotifyDeps={
 bindings:{list(channelId?:string):Promise<ImBinding[]>}
 adapter:(channelId:string)=>ImChannelAdapter|undefined
 /** 已连接的渠道，按优先顺序。 */
 onlineChannels:()=>string[]
 workbenchUrl:()=>string|undefined
 /** 经出站发送（outbound.sendDirect）：渠道限流、同聊天串行。 */
 send:(channelId:string,chatId:string,text:string)=>Promise<{messageId:string}>
}

const headlines:Record<NotificationInput['conclusion'],string>={
 'policy-always':'任务运行已完成',
 'attention-required':'任务需要你处理',
 'execution-failed':'任务运行失败',
}

/** 去重表上限：超出按先进先出淘汰。 */
const deliveredMax=1000

export function createImNotificationAdapter(deps:NotifyDeps):NotificationAdapter{
 /** 运行 id + 结论 → 在途或已成功的回执；失败即移除，允许重试。 */
 const delivered=new Map<string,Promise<{receiptId:string}>>()
 const push=async(input:NotificationInput,signal:AbortSignal):Promise<{receiptId:string}>=>{
  for(const channelId of deps.onlineChannels()){
   const adapter=deps.adapter(channelId)
   if(!adapter)continue
   const binding=(await deps.bindings.list(channelId).catch(()=>[])).find(row=>row.chatId!==undefined&&row.ownerId===input.ownerId)
   if(!binding?.chatId)continue
   signal.throwIfAborted()
   const url=deps.workbenchUrl()
   const text=[headlines[input.conclusion],'task '+input.taskId,'run '+input.runId,...(url?[url]:[])].join('\n')
   const {messageId}=await deps.send(channelId,binding.chatId,text)
   return {receiptId:`im:${channelId}:${messageId}`}
  }
  throw new Error('im: no bound channel')
 }
 return {
  channel:'im',
  async deliver(input,signal){
   signal.throwIfAborted()
   const key=`${input.runId}\n${input.conclusion}`
   const known=delivered.get(key)
   if(known)return known
   const pending=push(input,signal)
   delivered.set(key,pending)
   if(delivered.size>deliveredMax)delivered.delete(delivered.keys().next().value!)
   pending.catch(()=>{if(delivered.get(key)===pending)delivered.delete(key)})
   return pending
  },
 }
}
