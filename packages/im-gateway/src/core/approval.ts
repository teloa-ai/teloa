/**
 * 审批旁路 answerer（规格 §6，评审 C1 + H2）：以 `{global:true,prepend:true}` 挂在 `approval/request` 最前，
 * 先向绑定者私聊发审批卡，再 `next()` 交给工作台 answerer，二者竞速：
 * - 只有真实裁决（IM 的 allowed-once/rejected，工作台的 allowed-once/rejected/cancelled）算先答，并撤另一侧的卡；
 * - 工作台 `next()` 立即回 'unavailable'（链尾默认值，或工作台已连接但未接卡）或抛错不算裁决：记下后继续等 IM，
 *   30 分钟超时撤卡并原样透传 'unavailable'（调用方 fail-closed）；只能拒绝的卡片不再等，立即改卡并透传 'unavailable'（审查修复 R1 L-1）；
 * - IM 只产生 allowed-once/rejected；超时、取消、渠道停用、解绑只撤卡，不产生否决。
 * 按钮回调数据只作待决表查找键：渠道、聊天、卡片消息、点击者须与登记的待决项全部一致才接受裁决；
 * 已裁决、已撤、宿主重启后的旧卡一律回「已处理或已过期」。卡片回调里的 chatKind 不参与判定（飞书缓存淘汰或重启后不可信）。
 * 卡片带本次调用参数（审查 M1）：按 req.callId 从请求所属会话（req.agent.session，进程内只读）取 tool/call 参数，
 * 脱敏后截断约 600 字；取不到参数不让在 IM 盲批——写「参数请到工作台查看」，卡片只给「拒绝」。
 * 参数 JSON 逐叶子脱敏（审查 H1）；有字段被整值遮蔽、整段被遮或被截断时同样只给「拒绝」，附「完整参数请到工作台查看」（审查 M1）。
 * 命令／可执行类内容（除 draftToolNames 外的全部工具，默认即是）只要有任何遮蔽也只给「拒绝」，附「含已遮蔽的凭据，请到工作台查看并批准」：
 * 键值与 Bearer 类遮住的 shell 词在上下文里可能正是要执行的命令，同类写法逐条堵不住（审查 R3-H1，设计约束方案 B）。
 * 平台发送至多等 5 秒（审查 M2）：超时立即交工作台，迟到成功的卡随后撤掉。
 */
import type {ApprovalOutcome,ApprovalRequestEvent} from '@deepseek-ai/dsh-user-approval/types'
import {telegramCallbackData} from '../channels/telegram.ts'
import {deceptiveText,entropyHit,redact,redacted,secretKeyName,type ImAuditRow} from './audit.ts'
import type {ImBinding} from './bindings.ts'
import {truncate} from './truncate.ts'
import type {ImChannelAdapter,ImInbound} from './types.ts'

export type ApprovalDeps={
 bindings:{list(channelId?:string):Promise<ImBinding[]>}
 adapter:(channelId:string)=>ImChannelAdapter|undefined
 /** 已连接的渠道，按优先顺序。 */
 onlineChannels:()=>string[]
 /** 本宿主 owner：只发给本 owner 的绑定者。 */
 ownerId:string
 audit:{record(row:ImAuditRow):Promise<void>}
 now:()=>number
 /** 30 分钟。 */
 timeoutMs:number
 /** 8 位 hex，CSPRNG。 */
 random:()=>string
 setTimeout:(fn:()=>void,ms:number)=>unknown
 clearTimeout:(timer:unknown)=>void
 workbenchUrl:()=>string|undefined
}

type Pending={callbackId:string;channelId:string;chatId:string;messageId:string;imUserId:string;rejectOnly:boolean;settled:boolean;resolve:(o:'allowed-once'|'rejected')=>void;withdraw:(text:string)=>void;timer:unknown}
type Race={side:'im';o:'allowed-once'|'rejected'}|{side:'workbench';o:ApprovalOutcome}|{side:'timeout'}|{side:'abort'}|{side:'withdrawn';text:string}

const reasonMax=1000
const argumentsMax=600
/** 平台发送（发卡、发提问）的等待上限。 */
export const sendLimitMs=5000
const decisions=new Set<ApprovalOutcome>(['allowed-once','rejected','cancelled'])
/** 只把定义存成待确认草案、本身不执行任何内容的 Teloa 工具（非命令类）：正文内片段遮蔽仍可在 IM 批准。其余工具一律按命令类处理。 */
export const draftToolNames:ReadonlySet<string>=new Set(['teloa_create_draft','teloa_business_definitions_draft'])
/** 只允许在工作台批准的工具：IM 卡片一律只给「拒绝」并引导到工作台。终审 I-3：本机模型下载会占用数 GB 磁盘与带宽；市场评价发表是以本人署名对外公开发布，必须在原生确认卡上看全文后由本人点选。技能代发的非 GET 请求会带宿主注入的密钥改动外部服务的数据（含按岗位授权的同事任务会话），IM 不能确认（规格 2026-09-27 §5）。 */
export const workbenchOnlyToolNames:ReadonlySet<string>=new Set(['teloa_model_prepare','teloa_market_review_publish','teloa_skill_http'])
/** 审批卡提示文案（稳定键；只描述原因，不回显参数原文）。 */
export const approvalCardNotice={
 argumentsUnavailable:'参数请到工作台查看',
 argumentsIncomplete:'完整参数请到工作台查看',
 credentialRedacted:'含已遮蔽的凭据，请到工作台查看并批准',
 workbenchOnly:'该操作只能在工作台批准，IM 上只能拒绝',
} as const

/** 绑定者的 IM 私聊：在线渠道中第一个本 owner、带私聊 chatId 的绑定者、且适配器能发卡的。 */
export async function pickTarget(deps:Pick<ApprovalDeps,'bindings'|'adapter'|'onlineChannels'|'ownerId'>,capability:'card'|'text'):Promise<{adapter:ImChannelAdapter;binding:ImBinding&{chatId:string}}|undefined>{
 for(const channelId of deps.onlineChannels()){
  const adapter=deps.adapter(channelId)
  if(!adapter||(capability==='card'&&!adapter.sendCard))continue
  const binding=(await deps.bindings.list(channelId).catch(()=>[])).find(row=>row.chatId!==undefined&&row.ownerId===deps.ownerId)
  if(binding)return {adapter,binding:binding as ImBinding&{chatId:string}}
 }
 return undefined
}

type EventReader={snapshotEvents?():readonly {type:string;data?:unknown}[]}

/** 按 callId 从请求所属会话的事件里取该工具调用的参数原文；无 callId、会话不可读、找不到、同一 callId 命中多条或事件工具名与审批工具名不一致 → undefined（fail-closed，审查 R5 Minor）。 */
export function callArguments(req:ApprovalRequestEvent):string|undefined{
 if(req.callId===undefined)return undefined
 try{
  const events=(req.agent as unknown as {session?:EventReader}|undefined)?.session?.snapshotEvents?.()??[]
  const hits=events.filter(event=>event.type==='tool/call'&&(event.data as {callId?:unknown}|undefined)?.callId===req.callId)
  if(hits.length!==1)return undefined
  const data=hits[0]!.data as {name?:unknown;arguments?:unknown}
  if(data.name!==req.toolName)return undefined
  if(typeof data.arguments==='string')return data.arguments
  return data.arguments===undefined?undefined:JSON.stringify(data.arguments)
 }catch{}
 return undefined
}

/** 脱敏后只剩遮蔽标记与标点空白：该值被整值遮蔽。 */
const wholly=(before:string,after:string)=>after!==before&&after.replaceAll(redacted,'').replace(/[\s\p{P}\p{S}]/gu,'')===''

/**
 * 审批参数脱敏（审查 H1）：能按 JSON 解析就逐叶子只对字符串（含键名）脱敏，凭据键名的值整值遮蔽，再紧凑序列化；
 * 否则按文本脱敏。lossy：有字段被整值遮蔽、整段文本被遮蔽，或命中高熵串规则（审查 L1）——此时卡片不给「批准」。
 * 前缀类与 key=value 类的片段遮蔽：非命令类（executable=false）不算 lossy；命令类算 lossy 并置 credential（审查 R3-H1）。
 * 命令类原文本就含遮蔽标记（`bash [redacted]` 在 shell 里是方括号 glob）、看不见的字符、同形／全角冒充、白名单外字母与组合附加符、非 ASCII 空白或完整码位白名单外的任何码位时与真遮蔽同等对待（审查 R4-M1、R5-M1、R6-M1、R7、R8，见 deceptiveText）。
 */
export function redactArguments(args:string,executable=true):{text:string;lossy:boolean;credential:boolean}{
 let lossy=false,credential=false
 const leaf=(value:string)=>{
  const safe=redact(value),whole=wholly(value,safe)||entropyHit(value)
  lossy||=whole
  if(executable&&!whole&&(safe!==value||deceptiveText(safe))){lossy=true;credential=true}
  return safe
 }
 const walk=(value:unknown):unknown=>{
  if(typeof value==='string')return leaf(value)
  if(Array.isArray(value))return value.map(walk)
  if(value===null||typeof value!=='object')return value
  return Object.fromEntries(Object.entries(value).map(([key,child])=>{
   if(!secretKeyName.test(key))return [leaf(key),walk(child)]
   lossy=true
   return [leaf(key),redacted]
  }))
 }
 let parsed:unknown
 try{parsed=JSON.parse(args)}catch{const text=leaf(args);return {text,lossy,credential}}
 const text=JSON.stringify(walk(parsed))
 return {text,lossy,credential}
}

/**
 * 平台发送至多等 sendLimitMs：按时完成照常返回（失败照常抛出）；超时返回 undefined，调用方立即交工作台，
 * 此后迟到的成功交给 late 撤掉，迟到的失败忽略。
 */
export function withinSendLimit<T>(deps:Pick<ApprovalDeps,'setTimeout'|'clearTimeout'>,sending:Promise<T>,late:(value:T)=>void):Promise<T|undefined>{
 return new Promise<T|undefined>((resolve,reject)=>{
  let timedOut=false
  const timer=deps.setTimeout(()=>{timedOut=true;resolve(undefined)},sendLimitMs)
  sending.then(value=>{
   if(timedOut){late(value);return}
   deps.clearTimeout(timer)
   resolve(value)
  },(error:unknown)=>{
   if(timedOut)return
   deps.clearTimeout(timer)
   reject(error)
  })
 })
}

/** 附工作台链接（宿主已知且不含令牌时）。 */
export function withWorkbenchLink(deps:Pick<ApprovalDeps,'workbenchUrl'>,text:string):string{
 const url=deps.workbenchUrl()
 return url?`${text}\n${url}`:text
}

export function telegramCallbackDataFor(card:Pick<Pending,'callbackId'>):{approve:string;reject:string}{
 return {approve:telegramCallbackData('a',card.callbackId),reject:telegramCallbackData('r',card.callbackId)}
}

export function createImApproval(deps:ApprovalDeps){
 const pending=new Map<string,Pending>()
 const expiredText=()=>withWorkbenchLink(deps,'已过期，请到工作台处理')
 const edit=(row:Pending,text:string)=>deps.adapter(row.channelId)?.editMessage?.(row.chatId,row.messageId,text).catch(()=>{})
 const record=(channelId:string,m:ImInbound,action:ImAuditRow['action'],result:string)=>
  deps.audit.record({at:new Date(deps.now()).toISOString(),channelId,chatId:m.chatId,imUserId:m.sender.imUserId,messageId:m.messageId,action,result,...(m.action?{targetId:m.action.callbackId}:{})}).catch(()=>{})
 const ack=(channelId:string,m:ImInbound,text:string)=>deps.adapter(channelId)?.ack?.(m,text).catch(()=>{})
 const newCallbackId=()=>{
  for(;;){
   const id=deps.random()
   if(!pending.has(id))return id
  }
 }
 /** 撤下待决项并编辑卡片；不裁决。 */
 const withdrawWhere=async(match:(row:Pending)=>boolean,text:string)=>{
  const rows=[...pending.values()].filter(match)
  for(const row of rows)row.withdraw(text)
  await Promise.all(rows.map(row=>edit(row,text)))
 }

 return {
  async answerer(this:unknown,req:ApprovalRequestEvent,next:()=>Promise<ApprovalOutcome>):Promise<ApprovalOutcome>{
   const target=await pickTarget(deps,'card')
   if(!target)return next()
   const {adapter,binding}=target
   const callbackId=newCallbackId()
   const args=callArguments(req)
   const shown=args===undefined?undefined:redactArguments(args,!draftToolNames.has(req.toolName))
   // 取不到、有字段被整值遮蔽、被截断，或命令类内容有任何遮蔽：IM 上看不全就不给「批准」（审查 H1、M1、R3-H1）。
   const workbenchOnly=workbenchOnlyToolNames.has(req.toolName)
   const rejectOnly=workbenchOnly||shown===undefined||shown.lossy||shown.text.length>argumentsMax
   const lines=[
    ...(req.reason?[truncate(redact(req.reason),reasonMax)]:[]),
    ...(workbenchOnly?[withWorkbenchLink(deps,approvalCardNotice.workbenchOnly)]:[]),
    ...(shown===undefined?[approvalCardNotice.argumentsUnavailable]:[`参数：${truncate(shown.text,argumentsMax)}`,...(rejectOnly&&shown.credential?[approvalCardNotice.credentialRedacted]:[]),...(rejectOnly&&(!shown.credential||shown.text.length>argumentsMax)?[approvalCardNotice.argumentsIncomplete]:[])]),
    `来自会话 ${String(req.agent?.id)}`,
   ]
   let messageId:string
   try{
    const card={title:truncate(redact(req.toolName),200),lines,callbackId,...(rejectOnly?{}:{approveLabel:'批准'}),rejectLabel:'拒绝'}
    const sent=await withinSendLimit(deps,adapter.sendCard!(binding.chatId,card),
     late=>{void adapter.editMessage?.(binding.chatId,late.messageId,withWorkbenchLink(deps,'发送超时，请到工作台处理')).catch(()=>{})})
    if(!sent)return next()
    messageId=sent.messageId
   }catch{
    return next()
   }
   let settleRace!:(race:Race)=>void
   const signal=new Promise<Race>(resolve=>{settleRace=resolve})
   // IM 侧只结束一次：点击、超时、取消、撤卡任一先到即摘下待决项，之后的点击一律回「已处理或已过期」。
   const settle=(race:Race)=>{
    if(row.settled)return
    row.settled=true
    if(pending.get(callbackId)===row)pending.delete(callbackId)
    settleRace(race)
   }
   const row:Pending={
    callbackId,channelId:binding.channelId,chatId:binding.chatId,messageId,imUserId:binding.imUserId,rejectOnly,settled:false,
    resolve:o=>settle({side:'im',o}),
    withdraw:text=>settle({side:'withdrawn',text}),
    timer:undefined,
   }
   pending.set(callbackId,row)
   const onAbort=()=>settle({side:'abort'})
   req.signal?.addEventListener('abort',onAbort,{once:true})
   if(req.signal?.aborted)onAbort()
   row.timer=deps.setTimeout(()=>settle({side:'timeout'}),deps.timeoutMs)
   // 先发卡再交工作台；工作台抛错视同 unavailable，不产生未处理拒绝。
   const workbench=next().then(o=>({side:'workbench',o}) as Race,()=>({side:'workbench',o:'unavailable'}) as Race)
   const cleanup=()=>{
    row.settled=true
    if(pending.get(callbackId)===row)pending.delete(callbackId)
    deps.clearTimeout(row.timer)
    req.signal?.removeEventListener('abort',onAbort)
   }
   /** IM 侧已结束但不裁决：工作台已报 unavailable 就透传，否则继续等工作台。 */
   const fallBack=async(workbenchUnavailable:boolean):Promise<ApprovalOutcome>=>{
    if(workbenchUnavailable)return 'unavailable'
    const result=await workbench
    return result.side==='workbench'?result.o:'unavailable'
   }
   let workbenchUnavailable=false
   for(;;){
    const race=await Promise.race(workbenchUnavailable?[signal]:[signal,workbench])
    switch(race.side){
     case 'im':
      cleanup()
      return race.o
     case 'workbench':
      if(decisions.has(race.o)){
       cleanup()
       await edit(row,'已在网页处理')
       return race.o
      }
      // 只能拒绝的卡片（审查修复 R1 L-1）：IM 上给不出批准，工作台又已无人应答，再等只会把调用方挂满超时；
      // 立即结束、改卡引导到工作台重试，原样透传 unavailable（DSH 按拒绝处理，fail-closed）。
      if(row.rejectOnly){
       cleanup()
       await edit(row,withWorkbenchLink(deps,'工作台暂无人处理，本次未执行；请到工作台重试'))
       return 'unavailable'
      }
      // H2：链尾默认值或工作台未接卡，不算裁决；卡片不动，继续等 IM 直到超时。
      workbenchUnavailable=true
      continue
     case 'timeout':
      cleanup()
      await edit(row,expiredText())
      return fallBack(workbenchUnavailable)
     case 'abort':
      // dsh-user-approval 已自回 cancelled；IM 不产生结果。
      cleanup()
      await edit(row,'已取消')
      return fallBack(workbenchUnavailable)
     case 'withdrawn':
      cleanup()
      return fallBack(workbenchUnavailable)
    }
   }
  },
  async handleClick(channelId:string,m:ImInbound,binding:ImBinding|undefined):Promise<boolean>{
   if(!m.action)return false
   const row=pending.get(m.action.callbackId)
   if(!row||row.settled){
    await ack(channelId,m,'已处理或已过期')
    await record(channelId,m,'approval-click','expired')
    return true
   }
   // 渠道、聊天、卡片消息、点击者、绑定者五项全部一致才接受；回调数据只作查找键。
   const authorized=binding!==undefined&&channelId===row.channelId&&m.chatId===row.chatId&&m.messageId===row.messageId
    &&m.sender.imUserId===row.imUserId&&binding.channelId===row.channelId&&binding.imUserId===row.imUserId
   if(!authorized){
    await ack(channelId,m,'无权处理此审批')
    await record(channelId,m,'unauthorized-click','denied')
    return true
   }
   // 只给「拒绝」的卡（取不到参数）：批准回调只可能是伪造的，不裁决。
   if(row.rejectOnly&&m.action.value==='approve'){
    await ack(channelId,m,'此审批只能在工作台批准')
    await record(channelId,m,'unauthorized-click','approve-not-offered')
    return true
   }
   const outcome=m.action.value==='approve'?'allowed-once':'rejected'
   row.resolve(outcome)
   await edit(row,outcome==='allowed-once'?'已批准（IM）':'已拒绝（IM）')
   await ack(channelId,m,'已提交')
   await record(channelId,m,'approval-click',outcome)
   return true
  },
  /** 渠道停用：该渠道全部待决卡改停用文案并撤下，不裁决。 */
  withdrawChannel(channelId:string):Promise<void>{
   return withdrawWhere(row=>row.channelId===channelId,'渠道已停用，请到工作台处理')
  },
  /** 解绑：该用户的待决卡改「已失效」并撤下，不裁决。 */
  withdrawUser(channelId:string,imUserId:string):Promise<void>{
   return withdrawWhere(row=>row.channelId===channelId&&row.imUserId===imUserId,'已失效')
  },
  /** 插件释放：全部待决卡改停止文案并撤下，不裁决。 */
  withdrawAll():Promise<void>{
   return withdrawWhere(()=>true,'IM 通道已停止，请到工作台处理')
  },
  pendingCount():number{
   return pending.size
  },
 }
}
