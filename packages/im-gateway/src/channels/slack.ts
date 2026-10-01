// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：保留 openSocket()／connect() 与「envelope 先 ack 再处理」，实现 Teloa ImChannelAdapter（block_actions、thread_ts、chat.update、@解析），凭据经 deps.env() 按次读取、终态错误不重试、指数退避、disconnect 主动重连；放行 file_share／thread_broadcast 子类型并记录文件元数据、出站关闭链接展开、429 按 Retry-After 等待、卡片字段截断、不外传 response_url。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
/**
 * Slack 渠道适配器：Socket Mode（app-level token 建 WebSocket）+ Web API，
 * 零第三方依赖（原生 WebSocket + fetch）。需要接收 ack（envelope_id）。
 * 外呼只到 https://slack.com/api 与其返回的 wss://*.slack.com 网关；token 与连接 ticket 不进日志、错误与回包。
 * @module dsh-im-gateway/channels/slack
 */

import type {ImChannelErrorCode} from '@teloa/contract'
import type {AdapterDeps,ApprovalCard,ImChannelAdapter,ImChatKind,ImInbound} from '../core/types.ts'
import {maxReconnectAttempts,reconnectDelayMs} from '../core/backoff.ts'
import {truncate} from '../core/truncate.ts'

type SlackEvent={
 type?:string
 subtype?:string
 text?:string
 user?:string
 user_profile?:{display_name?:string;real_name?:string}
 channel?:string
 channel_type?:string
 bot_id?:string
 ts?:string
 thread_ts?:string
 files?:{name?:string;mimetype?:string;size?:number}[]
}
type SlackBlockActions={
 type:'block_actions'
 user?:{id?:string;username?:string;name?:string}
 channel?:{id?:string}
 container?:{message_ts?:string;channel_id?:string;thread_ts?:string}
 message?:{ts?:string;thread_ts?:string}
 response_url?:string
 actions?:{action_id?:string;value?:string}[]
}
type SlackEnvelope={
 envelope_id?:string
 type?:string
 payload?:{type?:string;event?:SlackEvent}
}

const API='https://slack.com/api'
const botTokenPattern=/^xoxb-[A-Za-z0-9-]+$/
const appTokenPattern=/^xapp-[A-Za-z0-9-]+$/
const callbackIdPattern=/^[A-Za-z0-9_-]{1,128}$/
const errorCodePattern=/^[a-z0-9_]{1,64}$/
const terminalErrors=new Set(['invalid_auth','not_authed','account_inactive','token_revoked'])
const requestTimeoutMs=15_000
/** 放行的 message 子类型：普通消息（无 subtype）、带文件的消息、线程内「同时发到频道」。其余（编辑、删除、入群等）丢弃。 */
const acceptedSubtypes=new Set([undefined,'file_share','thread_broadcast'])
const maxSectionLength=3000
const maxButtonLength=75

class SlackApiError extends Error{
 readonly code:string
 /** 429 时响应头 Retry-After（秒）×1000。 */
 readonly retryAfterMs?:number
 constructor(code:string,message:string,retryAfterMs?:number){
  super(message)
  this.code=code
  if(retryAfterMs!==undefined)this.retryAfterMs=retryAfterMs
 }
}

/** Slack mrkdwn 要求转义 & < >；同时防止出站文本携带 <!channel>、<@U…> 等控制序列。 */
function escapeText(text:string):string{
 return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

/** Socket Mode 网关只接受 wss://slack.com 或其子域，其它地址视为协议错误。 */
function socketUrlOk(raw:string):boolean{
 try{
  const url=new URL(raw)
  return url.protocol==='wss:'&&(url.hostname==='slack.com'||url.hostname.endsWith('.slack.com'))
 }catch{
  return false
 }
}

function chatKindOf(channelType:string|undefined,ts:string|undefined,threadTs:string|undefined):ImChatKind|undefined{
 if(channelType==='im')return 'direct'
 if(channelType==='channel'||channelType==='group'||channelType==='mpim')return threadTs!==undefined&&threadTs!==ts?'thread':'group'
 return undefined
}

function withoutResponseUrl(payload:SlackBlockActions):Omit<SlackBlockActions,'response_url'>{
 const {response_url:_,...rest}=payload
 return rest
}

function tsToIso(ts:string,fallback:Date):string{
 const ms=Number(ts)*1000
 return Number.isFinite(ms)?new Date(ms).toISOString():fallback.toISOString()
}

export function createSlackAdapter(deps:AdapterDeps):ImChannelAdapter{
 const fetchImpl=deps.fetch??fetch
 const WebSocketImpl=deps.WebSocketImpl??globalThis.WebSocket
 let handler:((m:ImInbound)=>Promise<void>)|undefined
 let ws:WebSocket|undefined
 let stopped=true
 let abort=new AbortController()
 let botUserId:string|undefined
 let attempt=0
 let connected=false
 let lastEventAt:string|undefined
 /** 状态错误码（审查 L4）：前端按码本地化，不回平台原文。 */
 let error:ImChannelErrorCode|undefined

 const sleep=(ms:number,signal:AbortSignal):Promise<void>=>{
  if(deps.sleep)return deps.sleep(ms)
  return new Promise(resolve=>{
   const timer=setTimeout(resolve,ms)
   signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})
  })
 }

 async function api<T extends object>(method:string,body:Record<string,unknown>,tokenKind:'bot'|'app'='bot'):Promise<T>{
  // 凭据按次读取不缓存；格式校验不通过按 invalid_auth 处理，不出网。
  const env=await deps.env()
  const token=tokenKind==='app'?env.SLACK_APP_TOKEN:env.SLACK_BOT_TOKEN
  if(!token||!(tokenKind==='app'?appTokenPattern:botTokenPattern).test(token))throw new SlackApiError('invalid_auth',`slack ${method}: 凭据格式不合法`)
  let res:Response
  try{
   res=await fetchImpl(`${API}/${method}`,{
    method:'POST',
    headers:{authorization:`Bearer ${token}`,'content-type':'application/json; charset=utf-8'},
    body:JSON.stringify(body),
    signal:AbortSignal.any([abort.signal,AbortSignal.timeout(requestTimeoutMs)]),
   })
  }catch(err){
   throw new SlackApiError('network',`slack ${method}: 网络错误（${err instanceof Error?err.name:'unknown'}）`)
  }
  const data=(await res.json().catch(()=>undefined)) as ({ok?:boolean;error?:string}&T)|undefined
  if(!res.ok||!data?.ok){
   // 平台错误码是枚举字符串；形状不符时不回显。
   const code=typeof data?.error==='string'&&errorCodePattern.test(data.error)?data.error:`http_${res.status}`
   const retryAfter=res.status===429?Number(res.headers.get('retry-after')):Number.NaN
   throw new SlackApiError(code,`slack ${method}: ${code}`,Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:undefined)
  }
  return data
 }

 async function openSocket():Promise<string>{
  const data=await api<{url?:string}>('apps.connections.open',{},'app')
  if(typeof data.url!=='string'||!socketUrlOk(data.url))throw new SlackApiError('bad_url','slack apps.connections.open: 网关地址不合法')
  return data.url
 }

 function mentionsOf(text:string):ImInbound['mentions']{
  const out:({kind:'user';imUserId:string;raw:string}|{kind:'botSelf';raw:string})[]=[]
  for(const match of text.matchAll(/<@([A-Z0-9]+)>/g)){
   if(match[1]===botUserId)out.push({kind:'botSelf',raw:match[0]})
   else out.push({kind:'user',imUserId:match[1]!,raw:match[0]})
  }
  return out
 }

 function fromEvent(envelope:SlackEnvelope,event:SlackEvent):ImInbound|undefined{
  if(event.type!=='message'||!acceptedSubtypes.has(event.subtype)||event.bot_id!==undefined)return undefined
  if(!event.user||!event.channel||!event.ts)return undefined
  const text=event.text??''
  // 一期文件只收元数据、不下载。
  const media:ImInbound['media']=(event.files??[]).map(file=>({
   kind:file.mimetype?.startsWith('image/')?'image' as const:'file' as const,
   ...(file.name===undefined?{}:{name:file.name}),
   ...(file.mimetype===undefined?{}:{mime:file.mimetype}),
   ...(file.size===undefined?{}:{bytes:file.size}),
  }))
  if(!text&&media.length===0)return undefined
  const chatKind=chatKindOf(event.channel_type,event.ts,event.thread_ts)
  if(!chatKind)return undefined
  return {
   channelId:'slack',
   chatId:event.channel,
   chatKind,
   messageId:event.ts,
   ...(chatKind==='thread'?{threadId:event.thread_ts!}:{}),
   sender:{imUserId:event.user,displayName:event.user_profile?.display_name||event.user_profile?.real_name||event.user},
   text,
   mentions:mentionsOf(text),
   media,
   at:tsToIso(event.ts,deps.now()),
   raw:envelope,
  }
 }

 function fromBlockActions(envelope:SlackEnvelope,payload:SlackBlockActions):ImInbound|undefined{
  const action=payload.actions?.[0]
  const decision=action?.action_id==='im_approve'?'approve':action?.action_id==='im_reject'?'reject':undefined
  // 按钮 value 只作待决表查找键：不是本适配器发出的按钮或格式不符即丢弃。
  if(!decision||!action?.value||!callbackIdPattern.test(action.value))return undefined
  const chatId=payload.channel?.id??payload.container?.channel_id
  const messageTs=payload.container?.message_ts??payload.message?.ts
  const threadTs=payload.container?.thread_ts??payload.message?.thread_ts
  const userId=payload.user?.id
  if(!chatId||!messageTs||!userId)return undefined
  const chatKind:ImChatKind=chatId.startsWith('D')?'direct':threadTs!==undefined&&threadTs!==messageTs?'thread':'group'
  return {
   channelId:'slack',
   chatId,
   chatKind,
   messageId:messageTs,
   ...(chatKind==='thread'?{threadId:threadTs!}:{}),
   sender:{imUserId:userId,displayName:payload.user?.name??payload.user?.username??userId},
   text:'',
   mentions:[],
   media:[],
   // 本适配器不实现 ack，response_url（可向会话发消息的凭证性地址）既不作回执令牌、也不随 raw 透传。
   action:{callbackId:action.value,value:decision,callbackToken:''},
   at:deps.now().toISOString(),
   raw:{...envelope,payload:withoutResponseUrl(payload)},
  }
 }

 function dispatch(m:ImInbound):void{
  lastEventAt=deps.now().toISOString()
  // 不等待业务处理：一条消息的处理可能等待审批，而审批按钮回调本身也要经本连接到达。
  void handler?.(m).catch(()=>deps.log.warn('[slack] 入站处理失败：chat=%s message=%s',m.chatId,m.messageId))
 }

 function onEnvelope(socket:WebSocket,data:unknown):void{
  let envelope:SlackEnvelope
  try{
   envelope=JSON.parse(String(data)) as SlackEnvelope
  }catch{
   return
  }
  // 所有 envelope 都要在 3 秒内 ack，否则 Slack 会重发；ack 先于任何业务处理。
  if(typeof envelope.envelope_id==='string')socket.send(JSON.stringify({envelope_id:envelope.envelope_id}))
  if(envelope.type==='hello'){
   attempt=0
   error=undefined
   return
  }
  if(envelope.type==='disconnect'){
   // 网关即将轮换：主动换新连接，旧连接的 onclose 不再触发退避。
   if(ws===socket){
    ws=undefined
    connected=false
    socket.close(1000)
    if(!stopped)void run(abort.signal)
   }
   return
  }
  const payload=envelope.payload
  if(envelope.type==='events_api'&&payload?.event){
   const m=fromEvent(envelope,payload.event)
   if(m)dispatch(m)
  }else if(envelope.type==='interactive'&&payload?.type==='block_actions'){
   const m=fromBlockActions(envelope,payload as SlackBlockActions)
   if(m)dispatch(m)
  }
 }

 // 每次 start() 换新的 AbortSignal；旧一轮的重连链见到 aborted 即退出，stop→start 不会叠出两条连接。
 async function connect(signal:AbortSignal):Promise<void>{
  if(botUserId===undefined)botUserId=(await api<{user_id?:string}>('auth.test',{})).user_id??''
  const url=await openSocket()
  if(signal.aborted)return
  const socket=new WebSocketImpl(url)
  ws=socket
  socket.onopen=()=>{
   if(ws!==socket)return
   connected=true
   deps.log.info('[slack] Socket Mode 已连接')
  }
  socket.onmessage=ev=>onEnvelope(socket,ev.data)
  socket.onclose=ev=>{
   if(ws!==socket)return
   ws=undefined
   connected=false
   if(signal.aborted)return
   deps.log.info('[slack] 连接断开（code %s），准备重连',ev.code)
   void backoff(signal).then(again=>again?run(signal):undefined)
  }
  socket.onerror=()=>{}
 }

 /** 记一次失败并等待退避；返回是否应继续重连。 */
 async function backoff(signal:AbortSignal,retryAfterMs?:number):Promise<boolean>{
  attempt+=1
  if(attempt===maxReconnectAttempts){
   error='reconnecting'
   deps.log.warn('[slack] 连接连续失败 %s 次',attempt)
  }
  await sleep(retryAfterMs??reconnectDelayMs(attempt),signal)
  return !signal.aborted
 }

 async function run(signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
   try{
    await connect(signal)
    return
   }catch(err){
    if(signal.aborted)return
    connected=false
    const code=err instanceof SlackApiError?err.code:'unknown'
    if(terminalErrors.has(code)){
     error='credentials-invalid'
     deps.log.warn('[slack] 连接终止：%s',error)
     stopped=true
     abort.abort()
     return
    }
    deps.log.info('[slack] 连接错误（第 %s 次）：%s',attempt+1,err instanceof Error?err.message:'unknown')
    if(!(await backoff(signal,err instanceof SlackApiError?err.retryAfterMs:undefined)))return
   }
  }
 }

 async function postMessage(body:Record<string,unknown>):Promise<{messageId:string}>{
  // 关闭链接展开：展开由 Slack 服务端抓取正文里的链接，会把内网或带令牌的地址外泄给第三方。
  const result=await api<{ts?:string}>('chat.postMessage',{...body,unfurl_links:false,unfurl_media:false})
  return {messageId:String(result.ts)}
 }

 return {
  id:'slack',
  label:'Slack',
  capabilities:{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:3000,rateLimitPerMinute:50},
  async start(h){
   handler=h
   if(!stopped)return
   stopped=false
   error=undefined
   attempt=0
   botUserId=undefined
   abort=new AbortController()
   deps.log.info('[slack] 开始连接（Socket Mode）')
   // 不阻塞插件 apply：连接与重连在后台进行，状态经 status() 暴露。
   void run(abort.signal)
  },
  async stop(){
   stopped=true
   abort.abort()
   const socket=ws
   ws=undefined
   connected=false
   socket?.close(1000)
  },
  async send(chatId,text,opts){
   return postMessage({channel:chatId,text:escapeText(text),...(opts?.threadId===undefined?{}:{thread_ts:opts.threadId})})
  },
  async sendCard(chatId,card:ApprovalCard,opts){
   if(!callbackIdPattern.test(card.callbackId))throw new Error('Slack 按钮 callbackId 格式不合法')
   return postMessage({
    channel:chatId,
    text:escapeText(card.title),
    ...(opts?.threadId===undefined?{}:{thread_ts:opts.threadId}),
    blocks:[
     {type:'section',text:{type:'plain_text',text:truncate([card.title,...card.lines].join('\n'),maxSectionLength)}},
     {type:'actions',elements:[
      ...(card.approveLabel===undefined?[]:[{type:'button',text:{type:'plain_text',text:truncate(card.approveLabel,maxButtonLength)},action_id:'im_approve',value:card.callbackId,style:'primary'}]),
      {type:'button',text:{type:'plain_text',text:truncate(card.rejectLabel,maxButtonLength)},action_id:'im_reject',value:card.callbackId,style:'danger'},
     ]},
    ],
   })
  },
  async editMessage(chatId,messageId,text){
   await api('chat.update',{channel:chatId,ts:messageId,text:escapeText(text),blocks:[]})
  },
  status(){
   return {connected,...(lastEventAt===undefined?{}:{lastEventAt}),...(error===undefined?{}:{error})}
  },
 }
}
