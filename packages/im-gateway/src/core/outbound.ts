/**
 * 出站投递（规格 §4.4）：订阅 session/event，一期只在 `assistant/message` 以 `surfaceOp:'append'` 落定（整条完成）时投递；
 * `replace` 是压缩改写历史、`interrupted` 是被取消的半截，都不外发；工具调用、工具结果与思考块不外发。
 * 取纯文本块 → toPlainText → 按渠道 maxMessageLength 分片 → 同一聊天串行逐片 send，保持顺序。
 * 转义与关闭链接预览由各适配器负责，这里不重复处理。
 * 路由：私聊先认 track（本人私聊时登记，带话题），再按绑定里的私聊 chatId 与当前会话重建（宿主重启后无需本人先发消息）；
 * 群：绑定者在 IM 群 @ 后登记触发（expectGroup），只认由该条协作群消息派生的同事运行会话，按群绑定回发到对应 IM 群；
 * 该会话运行结束（turn/end）或首条完整回复（不含工具调用）排入投递后即摘除回发登记，此后不再外发（审查 L2）。
 * 投递前重查：私聊会话须仍是 (channelId,imUserId) 绑定的当前会话（解绑、/new、切换同事、移除渠道即丢弃）；群须仍绑同一协作群且触发者仍绑定。
 */
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {currentSessionId,type ImBinding,type ImGroupBinding} from './bindings.ts'
import {toPlainText} from './format.ts'
import {splitText} from './split.ts'
import type {ImChannelAdapter} from './types.ts'

export type OutboundRoute={channelId:string;imUserId:string;chatId:string;threadId?:string}
/** 群 @ 触发：IM 群路由（imUserId 为触发者）+ 协作群 groupId、触发消息 messageId 与其发送时刻 since。 */
export type GroupTrigger=OutboundRoute&{groupId:string;messageId:string;since:string}
/** 群回发带同事名前缀（固定格式，不进 i18n）。 */
type Target={kind:'direct';route:OutboundRoute}|{kind:'group';route:GroupTrigger;name:string}

export type OutboundDeps={
 adapter:(channelId:string)=>ImChannelAdapter|undefined
 bindings:{
  find(channelId:string,imUserId:string):Promise<ImBinding|undefined>
  list():Promise<ImBinding[]>
  groups:{byChat(channelId:string,chatId:string):Promise<ImGroupBinding|undefined>}
 }
 /** 反查由某条协作群消息派生的同事运行会话与其同事名（router.groupRunSessions）。 */
 groupRunSessions:(trigger:{groupId:string;messageId:string;since:string})=>Promise<{sessionId:string;name:string}[]>
 now?:()=>number
 /** 渠道出站限流：按 channelId 取令牌，取不到就等一会儿再取。 */
 rateLimit:{take(channelId:string):boolean}
 log:{info(f:string,...v:unknown[]):void;warn(f:string,...v:unknown[]):void}
 sleep?:(ms:number)=>Promise<void>
}

const rateWaitMs=3_000
const rateWaitTries=20
const retryTries=3
const retryAfterMaxMs=60_000
/** 群触发的有效期：超时后该次 @ 派生的回复不再回发。 */
const triggerTtlMs=60*60_000
const triggerMax=20
/** 已判定与群触发无关的会话：上限内不重复反查；已摘除回发登记的群会话同一上限。 */
const unrelatedMax=1000
/** 群回发的同事名前缀（固定格式，不进 i18n）。 */
export const groupReplyPrefix=(name:string)=>`【${name}】`

const retryAfter=(error:unknown):number|undefined=>{
 const value=typeof error==='object'&&error!==null?(error as {retryAfterMs?:unknown}).retryAfterMs:undefined
 return typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(value,retryAfterMaxMs):undefined
}

export function createOutbound(deps:OutboundDeps){
 const sleep=deps.sleep??(ms=>new Promise<void>(resolve=>setTimeout(resolve,ms)))
 const now=deps.now??Date.now
 const routes=new Map<string,OutboundRoute>()
 let triggers:{route:GroupTrigger;expiresAt:number}[]=[]
 const groupSessions=new Map<string,{route:GroupTrigger;expiresAt:number;name:string}>()
 const unrelated=new Set<string>()
 /** 已摘除回发登记的群会话：不再回发，也不因再次反查而重新登记；不随新触发清空。 */
 const finished=new Set<string>()
 const finish=(sessionId:string)=>{
  groupSessions.delete(sessionId)
  if(finished.size>=unrelatedMax)finished.delete(finished.values().next().value!)
  finished.add(sessionId)
 }
 /** 事件到达序号；反查须晚于事件到达才能看见该会话的运行（运行先于其会话事件落库）。 */
 let arrivals=0
 let latest:{seq:number;done:Promise<boolean>}|undefined
 /** 每个会话一条串行链：解析路由与入队按事件到达顺序。 */
 const chains=new Map<string,Promise<void>>()
 /** 每个聊天一条串行队列。 */
 const queues=new Map<string,Promise<void>>()

 /** 排入该聊天的串行队列；队列本身不因某条失败而中断。 */
 const enqueue=<T>(route:Pick<OutboundRoute,'channelId'|'chatId'>,task:()=>Promise<T>):Promise<T>=>{
  const key=`${route.channelId}\n${route.chatId}`
  const run=(queues.get(key)??Promise.resolve()).then(task)
  const settled=run.then(()=>{},()=>{})
  queues.set(key,settled)
  void settled.finally(()=>{if(queues.get(key)===settled)queues.delete(key)})
  return run
 }
 /** 一片：先等渠道令牌，再发；平台给出 retryAfterMs 就照等后重试同一片。 */
 const sendPiece=async(adapter:ImChannelAdapter,route:Pick<OutboundRoute,'channelId'|'chatId'|'threadId'>,text:string):Promise<{messageId:string}>=>{
  for(let tries=0;!deps.rateLimit.take(route.channelId);tries+=1){
   if(tries>=rateWaitTries)throw new Error('rate-limited')
   await sleep(rateWaitMs)
  }
  const opts=route.threadId===undefined?undefined:{threadId:route.threadId}
  for(let attempt=1;;attempt+=1){
   try{return await adapter.send(route.chatId,text,opts)}
   catch(error){
    const wait=retryAfter(error)
    if(wait===undefined||attempt>=retryTries)throw error
    await sleep(wait)
   }
  }
 }

 /** 反查全部未过期触发；多个会话同时未命中时共用一次（只要该次反查开始于它们到达之后）。返回是否全部查成。 */
 const refreshSince=(seq:number):Promise<boolean>=>{
  if(latest&&latest.seq>=seq)return latest.done
  const done=(latest?.done??Promise.resolve(true)).then(async()=>{
   let ok=true
   for(const trigger of triggers){
    const sessions=await deps.groupRunSessions(trigger.route).catch(()=>{ok=false;return [] as {sessionId:string;name:string}[]})
    for(const {sessionId,name} of sessions)if(!finished.has(sessionId))groupSessions.set(sessionId,{...trigger,name})
   }
   return ok
  })
  latest={seq:arrivals,done}
  return done
 }
 const groupHit=(sessionId:string)=>{
  const entry=groupSessions.get(sessionId)
  if(entry&&entry.expiresAt>now())return {kind:'group',route:entry.route,name:entry.name} as const
  groupSessions.delete(sessionId)
  return undefined
 }
 const resolve=async(sessionId:string,seq:number):Promise<Target|undefined>=>{
  const tracked=routes.get(sessionId)
  if(tracked)return {kind:'direct',route:tracked}
  const owner=(await deps.bindings.list().catch(()=>[])).find(binding=>binding.chatId!==undefined&&currentSessionId(binding)===sessionId)
  if(owner?.chatId!==undefined)return {kind:'direct',route:{channelId:owner.channelId,imUserId:owner.imUserId,chatId:owner.chatId}}
  const known=groupHit(sessionId)
  if(known)return known
  triggers=triggers.filter(trigger=>trigger.expiresAt>now())
  if(!triggers.length||unrelated.has(sessionId)||finished.has(sessionId))return undefined
  const complete=await refreshSince(seq)
  const found=groupHit(sessionId)
  if(found)return found
  if(complete){
   if(unrelated.size>=unrelatedMax)unrelated.delete(unrelated.values().next().value!)
   unrelated.add(sessionId)
  }
  return undefined
 }
 /** 投递前重查：私聊须仍是该绑定的当前会话；群须仍绑同一协作群、触发者仍绑定。 */
 const stillOwned=async(sessionId:string,target:Target):Promise<boolean>=>{
  const {route}=target
  const binding=await deps.bindings.find(route.channelId,route.imUserId).catch(()=>undefined)
  if(target.kind==='direct')return binding!==undefined&&currentSessionId(binding)===sessionId
  const group=await deps.bindings.groups.byChat(route.channelId,route.chatId).catch(()=>undefined)
  return binding!==undefined&&group?.groupId===target.route.groupId
 }

 const deliver=async(sessionId:string,target:Target,text:string)=>{
  const {route}=target
  if(!await stillOwned(sessionId,target)){
   if(routes.get(sessionId)===route)routes.delete(sessionId)
   return
  }
  const adapter=deps.adapter(route.channelId)
  if(!adapter)return
  const body=target.kind==='group'?groupReplyPrefix(target.name)+text:text
  try{
   for(const piece of splitText(body,adapter.capabilities.maxMessageLength))await sendPiece(adapter,route,piece)
  }catch{
   // 不带平台错误原文与回复正文，避免把会话内容写进宿主日志。
   deps.log.warn('IM 出站投递失败，已放弃本条剩余分片：%s',route.channelId)
  }
 }

 return {
  track(sessionId:string,route:OutboundRoute):void{
   routes.set(sessionId,{...route})
  },
  /** 绑定者在 IM 群 @ 成功发出协作群消息后登记；有效期内由该消息派生的同事回复回发到该 IM 群。 */
  expectGroup(trigger:GroupTrigger):void{
   triggers.push({route:{...trigger},expiresAt:now()+triggerTtlMs})
   if(triggers.length>triggerMax)triggers.shift()
   unrelated.clear()
  },
  onSessionEvent(session:{id:string},event:SessionEvent):void{
   const id=session.id
   const chain=(task:()=>Promise<void>)=>{
    const run=(chains.get(id)??Promise.resolve()).then(task).catch(()=>{})
    chains.set(id,run)
    void run.finally(()=>{if(chains.get(id)===run)chains.delete(id)})
   }
   // 运行结束：群 @ 派生会话摘除回发登记（排在该会话已到达的回复之后）。
   if(event.type==='turn/end'){chain(async()=>{if(groupSessions.has(id))finish(id)});return}
   if(event.type!=='assistant/message'||event.surfaceOp!=='append'||event.data.interrupted)return
   const content=event.data.message.content
   const text=toPlainText(content.flatMap(block=>block.type==='text'?[block.text]:[]).join('\n'))
   if(!text)return
   const complete=!content.some(block=>block.type==='tool-call')
   const seq=++arrivals
   chain(async()=>{
    const target=await resolve(id,seq)
    if(!target)return
    if(target.kind==='group'&&complete)finish(id)
    // 同一聊天一条串行队列：前一条回复的分片全部发完才轮到下一条（多位同事回同一 IM 群也不交错）。
    await enqueue(target.route,()=>deliver(id,target,text))
   })
  },
  /** 通知等单条私聊推送（审查 L2）：同样先取渠道令牌、排入该聊天的串行队列；渠道不在线抛错。 */
  sendDirect(route:{channelId:string;chatId:string},text:string):Promise<{messageId:string}>{
   const adapter=deps.adapter(route.channelId)
   if(!adapter)return Promise.reject(new Error('im: channel offline'))
   return enqueue(route,()=>sendPiece(adapter,route,text))
  },
  /** 等所有已排队的投递结束（测试与释放用）。 */
  async idle():Promise<void>{
   while(chains.size||queues.size)await Promise.all([...chains.values(),...queues.values()])
  },
 }
}
