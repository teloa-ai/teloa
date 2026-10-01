/**
 * 入站消息总入口（规格 §4.3、§5.1、§9）。顺序：
 * 去重（按钮回调除外，重放由审批待决表判定）→ 每聊天（群聊按人）30 条/分钟限流 → 按钮回调交审批（绑定与否都进，由它回「无权」）
 * → /pair（未绑定者唯一可走的路）→ 未绑定：审计 ignored-unbound（按账号每分钟至多一条）后静默丢弃
 * → 已绑定私聊：命令／提问回答／路由到目标会话。
 * 群与话题（§4.3）：IM 群未绑定 Teloa 协作群 → 静默；他人发言与绑定者未 @ 的发言只进内存缓冲、不调任何端点；
 * 绑定者 @机器人或 @同事名 → 本人原文 + 缓冲（资料前缀包裹）经 groups/messages/send 发出，缓冲随即清空。
 */
import {WorkError,isSecretRejection,secretKindsIn} from '@teloa/contract'
import type {ImAuditRow} from './audit.ts'
import {currentSessionId,type createBindingStore,type ImBinding} from './bindings.ts'
import {commandHelp,parseCommand,type Command} from './commands.ts'
import {composeGroupText,type GroupBuffer} from './group-buffer.ts'
import type {GroupTrigger,OutboundRoute} from './outbound.ts'
import type {createPairingService} from './pairing.ts'
import {createRateLimiter} from './rate-limit.ts'
import type {ImRouter,ImSource} from './router.ts'
import type {ImChannelAdapter,ImInbound} from './types.ts'

export type InboundDeps={
 /** 绑定归属的本人（teloaWork.owner）。 */
 owner:string
 bindings:ReturnType<typeof createBindingStore>
 pairing:ReturnType<typeof createPairingService>
 router:ImRouter
 audit:{record(row:ImAuditRow):Promise<void>}
 rateLimit:{take(key:string):boolean}
 adapter:(channelId:string)=>ImChannelAdapter|undefined
 approval:{handleClick(channelId:string,m:ImInbound,binding:ImBinding|undefined):Promise<boolean>}
 questions:{tryAnswer(channelId:string,m:ImInbound,binding:ImBinding):Promise<boolean>}
 workbenchUrl:()=>string|undefined
 /** 键含 chatId：Telegram message_id、Slack ts 只在聊天内唯一。 */
 dedupe:{seen(channelId:string,chatId:string,messageId:string):boolean}
 now:()=>number
 groupBuffer:GroupBuffer
 /** 私聊路由成功后登记「会话 → 本聊天」；群 @ 成功后登记群触发。出站回复据此投递。 */
 outbound:{track(sessionId:string,route:OutboundRoute):void;expectGroup(trigger:GroupTrigger):void}
}

const hintIntervalMs=60_000
/** 这些事只能在工作台做（密钥、付款、账号、安全设置），IM 命令一律不执行。 */
const riskyCommand=/密钥|凭据|付款|支付|删除账号|注销|安全设置|api[-_ ]?key|secret|password|payment|delete account|security/i
const pairReplies={
 'not-in-direct':'配对码只能私聊发送，请重新生成。',
 'already-bound':'该账号已绑定，无需再次配对。',
 invalid:'配对码无效。',
 locked:'尝试次数过多，请稍后再试。',
} as const
const secretRejectedReply='消息疑似含密钥或令牌，已拒收、未发送。密钥请到工作台设置页保存，不要发在聊天里。'

/** 最近 limit 个 (channelId,chatId,messageId) 去重；超出淘汰最早的。 */
export function createDedupe(limit=500):InboundDeps['dedupe']{
 const keys=new Set<string>()
 return {
  seen(channelId,chatId,messageId){
   const key=`${channelId}\n${chatId}\n${messageId}`
   if(keys.has(key))return true
   keys.add(key)
   if(keys.size>limit)keys.delete(keys.values().next().value!)
   return false
  },
 }
}

export function createInbound(deps:InboundDeps):(channelId:string,m:ImInbound)=>Promise<void>{
 const hinted=new Map<string,number>()
 // 未绑定者刷屏不刷审计（审查 L4）：ignored-unbound 按账号每分钟至多一条。
 const unboundAudit=createRateLimiter(1,deps.now)

 const reply=async(channelId:string,m:ImInbound,text:string):Promise<void>=>{
  // 回复失败不影响已完成的路由与审计。
  await deps.adapter(channelId)?.send(m.chatId,text,m.threadId===undefined?undefined:{threadId:m.threadId}).catch(()=>{})
 }
 const record=(channelId:string,m:ImInbound,row:Pick<ImAuditRow,'action'|'result'>&Partial<Pick<ImAuditRow,'text'|'targetId'>>)=>
  deps.audit.record({at:new Date(deps.now()).toISOString(),channelId,chatId:m.chatId,imUserId:m.sender.imUserId,messageId:m.messageId,...row}).catch(()=>{})
 const withLink=(text:string)=>{
  const url=deps.workbenchUrl()
  return url?`${text}\n${url}`:text
 }
 // 贴密钥闸拒收（两种拒收由 isSecretRejection 统一识别）：回固定提示，不回原文与命中片段。
 const failure=(error:unknown)=>isSecretRejection(error)?withLink(secretRejectedReply):error instanceof WorkError?`处理失败：${error.message}`:'处理失败，请到工作台查看。'

 const pair=async(channelId:string,m:ImInbound,code:string,binding:ImBinding|undefined)=>{
  const result=deps.pairing.redeem({channelId,imUserId:m.sender.imUserId,chatId:m.chatId,code,chatKind:m.chatKind,alreadyBound:binding!==undefined})
  if(result.kind!=='bound'){
   // 群里未绑定者发 /pair 一律静默，不向群暴露机器人与配对状态。
   if(m.chatKind==='direct'||binding)await reply(channelId,m,pairReplies[result.kind])
   await record(channelId,m,{action:'pair-rejected',result:result.kind,text:m.text})
   return
  }
  try{
   await deps.bindings.bind({channelId,imUserId:m.sender.imUserId,displayName:m.sender.displayName,ownerId:deps.owner,chatId:m.chatId})
  }catch(error){
   await reply(channelId,m,failure(error))
   await record(channelId,m,{action:'pair-rejected',result:error instanceof WorkError?error.code:'failed',text:m.text})
   return
  }
  await reply(channelId,m,'已绑定。发送 /help 查看可用命令。')
  await record(channelId,m,{action:'pair',result:'bound',text:m.text})
 }

 const runCommand=async(command:Exclude<Command,{name:'pair'}>,binding:ImBinding,source:ImSource):Promise<string>=>{
  switch(command.name){
   case 'new':
    await deps.router.newSession(binding,source)
    return '已新开会话。'
   case 'status':{
    const target=binding.target
    const name=target.kind==='assistant'?'助理':`同事「${(await deps.router.listRoles()).find(role=>role.id===target.roleId)?.name??'已不存在'}」`
    return `当前对话对象：${name}${currentSessionId(binding)?'':'（尚未开始会话）'}。`
   }
   case 'stop':{
    const sessionId=currentSessionId(binding)
    if(!sessionId)return '当前没有会话。'
    deps.router.stop(sessionId)
    return '已请求停止当前回复。'
   }
   case 'colleague':{
    const roles=await deps.router.listRoles()
    const query=command.query?.toLowerCase()
    if(query===undefined)return `可选同事：${roles.map(role=>role.name).join('、')||'暂无'}\n发送「/同事 名字」切换，「/同事 助理」切回助理。`
    if(query==='助理'||query==='assistant'){
     await deps.bindings.change(binding.channelId,binding.imUserId,{target:{kind:'assistant'}})
     return '已切换到助理。'
    }
    const role=roles.find(row=>row.name.toLowerCase()===query)
    if(!role)return `没有找到同事「${command.query}」。`
    await deps.bindings.change(binding.channelId,binding.imUserId,{target:{kind:'role',roleId:role.id}})
    return `已切换到同事「${role.name}」。`
   }
   case 'tasks':
    return deps.router.tasksSummary()
   case 'attention':
    return withLink(await deps.router.attentionSummary())
   case 'help':
    return commandHelp.join('\n')
  }
 }

 const direct=async(channelId:string,m:ImInbound,binding:ImBinding,command:Command|undefined)=>{
  const source={channelId,chatId:m.chatId,messageId:m.messageId}
  const text=m.text.trim()
  // 形态预检（规格 §6）：斜杠命令与提问回答不经宿主准入闸，先按形态拒收；审计不带原文。已存值比对仍由宿主闸负责。
  if(secretKindsIn([m.text],[]).length){
   await reply(channelId,m,withLink(secretRejectedReply))
   await record(channelId,m,{action:command===undefined?'message':'command',result:'secret-rejected'})
   return
  }
  if(command===undefined&&text.startsWith('/')){
   const risky=riskyCommand.test(text)
   await reply(channelId,m,risky?withLink('请到工作台完成：密钥、付款、账号与安全设置只能在工作台操作。'):'未知命令，发送 /help 查看可用命令。')
   // 未识别的命令最可能夹带密钥（如「/apikey …」），审计不存原文。
   await record(channelId,m,{action:'command',result:risky?'workbench-only':'unknown'})
   return
  }
  try{
   if(command!==undefined&&command.name!=='pair'){
    await reply(channelId,m,await runCommand(command,binding,source))
    await record(channelId,m,{action:'command',result:'ok',text:m.text})
    return
   }
   if(await deps.questions.tryAnswer(channelId,m,binding))return
   if(!text){await reply(channelId,m,'目前只支持文字消息。');return}
   const {sessionId}=await deps.router.ensureTargetSession(binding,source)
   await deps.router.prompt(sessionId,m.text,source)
   deps.outbound.track(sessionId,{channelId,imUserId:binding.imUserId,chatId:m.chatId,...(m.threadId===undefined?{}:{threadId:m.threadId})})
   await record(channelId,m,{action:'message',result:'queued',targetId:sessionId,text:m.text})
  }catch(error){
   await reply(channelId,m,failure(error))
   // 被贴密钥闸拒收：审计不存原文（审计表会长期留存），只记类别。
   if(isSecretRejection(error))await record(channelId,m,{action:command===undefined?'message':'command',result:'secret-rejected'})
   else await record(channelId,m,{action:command===undefined?'message':'command',result:'failed',text:m.text})
  }
 }

 const group=async(channelId:string,m:ImInbound,binding:ImBinding|undefined)=>{
  const target=await deps.bindings.groups.byChat(channelId,m.chatId)
  if(!target)return
  const row={displayName:m.sender.displayName,at:m.at,text:m.text}
  // 他人发言是资料不是指令：只进缓冲，@ 也不触发任何动作。
  if(!binding){deps.groupBuffer.push(channelId,m.chatId,row);return}
  const botMentioned=m.mentions.some(item=>item.kind==='botSelf')
  const roles=botMentioned||m.text.includes('@')?await deps.router.listRoles().catch(()=>[]):[]
  const mentioned=roles.filter(role=>role.name&&m.text.includes(`@${role.name}`))
  if(!botMentioned&&!mentioned.length){deps.groupBuffer.push(channelId,m.chatId,row);return}
  try{
   const merged=deps.groupBuffer.size(channelId,m.chatId)
   const text=composeGroupText(m.text,deps.groupBuffer.drain(channelId,m.chatId))
   const sent=await deps.router.sendGroup(target,text,mentioned.map(role=>({roleId:role.id,expectedVersion:role.version})),{channelId,chatId:m.chatId,messageId:m.messageId})
   // 由这条协作群消息派生的同事回复回发到本 IM 群（同一话题）。
   if(sent)deps.outbound.expectGroup({channelId,chatId:m.chatId,...(m.threadId===undefined?{}:{threadId:m.threadId}),imUserId:binding.imUserId,groupId:target.groupId,...sent})
   await record(channelId,m,{action:'message',result:'group-sent',targetId:target.groupId,text:m.text})
   // 并入协作群的他人发言另记一条：只记条数，不含正文。
   if(merged)await record(channelId,m,{action:'message',result:`buffer-merged:${merged}`,targetId:target.groupId})
  }catch(error){
   // 群里有他人：只回固定文案，不回 WorkError 原文（审查 L5）；贴密钥拒收回与私聊同一条固定提示。
   await reply(channelId,m,isSecretRejection(error)?withLink(secretRejectedReply):'处理失败，请到工作台查看。')
   if(isSecretRejection(error))await record(channelId,m,{action:'message',result:'secret-rejected',targetId:target.groupId})
   else await record(channelId,m,{action:'message',result:'failed',targetId:target.groupId,text:m.text})
  }
 }

 return async(channelId,m)=>{
  if(!m.action&&deps.dedupe.seen(channelId,m.chatId,m.messageId))return
  const binding=await deps.bindings.find(channelId,m.sender.imUserId)
  // 群聊按人限流：他人刷屏不挡绑定者。
  const chatKey=m.chatKind==='direct'?`${channelId}\n${m.chatId}`:`${channelId}\n${m.chatId}\n${m.sender.imUserId}`
  if(!deps.rateLimit.take(chatKey)){
   // 超限丢弃；只对已绑定者每分钟提示一次，未绑定者不得到任何回应。
   const now=deps.now()
   if(binding&&now-(hinted.get(chatKey)??-Infinity)>=hintIntervalMs){hinted.set(chatKey,now);await reply(channelId,m,'消息太频繁，请稍后再发。')}
   return
  }
  if(m.action){await deps.approval.handleClick(channelId,m,binding);return}
  const command=parseCommand(m.text)
  if(command?.name==='pair')return pair(channelId,m,command.code,binding)
  if(m.chatKind!=='direct')return group(channelId,m,binding)
  if(!binding){
   if(unboundAudit.take(`${channelId}\n${m.sender.imUserId}`))await record(channelId,m,{action:'ignored-unbound',result:'ignored'})
   return
  }
  await direct(channelId,m,binding,command)
 }
}
