// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：保留 api()／pollLoop() 骨架，实现 Teloa ImChannelAdapter（callback_query、话题线程、卡片与编辑、answerCallbackQuery），凭据经 deps.env() 按次读取、401/403/409 终态不重试、指数退避；出站转义 & < > 后用 HTML 模式、关闭链接预览、429 按 retry_after 等待、卡片正文截断到 4096。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
/**
 * Telegram 渠道适配器：Bot API 长轮询，零第三方依赖（纯 fetch）。
 * 只做协议翻译；外呼只到 https://api.telegram.org，token 不进日志、错误与回包。
 * @module dsh-im-gateway/channels/telegram
 */

import type {ImChannelErrorCode} from '@teloa/contract'
import type {AdapterDeps,ApprovalCard,ImChannelAdapter,ImChatKind,ImInbound} from '../core/types.ts'
import {maxReconnectAttempts,reconnectDelayMs} from '../core/backoff.ts'
import {truncate} from '../core/truncate.ts'

type TgUser={id:number;is_bot?:boolean;username?:string;first_name?:string;last_name?:string}
type TgEntity={type:string;offset:number;length:number;user?:TgUser}
type TgMessage={
 message_id:number
 message_thread_id?:number
 is_topic_message?:boolean
 date:number
 chat:{id:number;type:string}
 from?:TgUser
 text?:string
 caption?:string
 entities?:TgEntity[]
 caption_entities?:TgEntity[]
 reply_to_message?:{message_id:number}
 photo?:unknown[]
 document?:{file_name?:string;mime_type?:string;file_size?:number}
}
type TgUpdate={update_id:number;message?:TgMessage;callback_query?:{id:string;from:TgUser;message?:TgMessage;data?:string}}

const API='https://api.telegram.org'
const tokenPattern=/^\d+:[A-Za-z0-9_-]+$/
const callbackPattern=/^[ar]:[A-Za-z0-9_-]{1,62}$/
const pollTimeoutSec=30
const requestTimeoutMs=15_000

const maxTextLength=4096

class TelegramApiError extends Error{
 readonly status:number
 /** 429 时平台给出的等待时长（parameters.retry_after 秒 ×1000）。 */
 readonly retryAfterMs?:number
 constructor(status:number,message:string,retryAfterMs?:number){
  super(message)
  this.status=status
  if(retryAfterMs!==undefined)this.retryAfterMs=retryAfterMs
 }
}

/** 按钮 callback_data：与入站同一正则（字符集 [A-Za-z0-9_-]、总长 ≤64 字节），不符构造期即抛错（N12），不出网。 */
export function telegramCallbackData(kind:'a'|'r',callbackId:string):string{
 const data=`${kind}:${callbackId}`
 if(!callbackPattern.test(data))throw new Error('Telegram callback_data 超过 64 字节或含非法字符')
 return data
}

/** HTML 模式下正文只允许纯文本：& < > 转为实体，模型输出无法渲染成标签或伪装链接。 */
function escapeHtml(text:string):string{
 return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
}

// 非话题超群的普通回复也带 message_thread_id，只有 is_topic_message===true 才算话题线程。
function chatKindOf(msg:TgMessage):ImChatKind|undefined{
 if(msg.chat.type==='private')return 'direct'
 if(msg.chat.type==='group'||msg.chat.type==='supergroup')return msg.is_topic_message===true&&msg.message_thread_id!==undefined?'thread':'group'
 return undefined
}

function displayName(user:TgUser):string{
 return [user.first_name,user.last_name].filter(Boolean).join(' ')||user.username||String(user.id)
}

function chatIdParam(chatId:string):number{
 if(!/^-?\d{1,20}$/.test(chatId))throw new Error('Telegram chat id 格式不合法')
 return Number(chatId)
}

export function createTelegramAdapter(deps:AdapterDeps):ImChannelAdapter{
 const fetchImpl=deps.fetch??fetch
 let handler:((m:ImInbound)=>Promise<void>)|undefined
 let offset:number|undefined
 let stopped=true
 let loop:Promise<void>|undefined
 let abort=new AbortController()
 let botUsername:string|undefined
 let connected=false
 let lastEventAt:string|undefined
 /** 状态错误码（审查 L4）：前端按码本地化，不回平台原文。 */
 let error:ImChannelErrorCode|undefined

 const sleep=(ms:number):Promise<void>=>{
  if(deps.sleep)return deps.sleep(ms)
  const signal=abort.signal
  return new Promise(resolve=>{
   const timer=setTimeout(resolve,ms)
   signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})
  })
 }

 async function api<T>(method:string,body:Record<string,unknown>,timeoutMs=requestTimeoutMs):Promise<T>{
  // 凭据按次读取不缓存；格式校验同时防止 token 改写请求路径。
  const token=(await deps.env()).TELEGRAM_BOT_TOKEN
  if(!token||!tokenPattern.test(token))throw new TelegramApiError(401,`telegram ${method}: 凭据格式不合法`)
  let res:Response
  try{
   res=await fetchImpl(`${API}/bot${token}/${method}`,{
    method:'POST',
    headers:{'content-type':'application/json'},
    body:JSON.stringify(body),
    signal:AbortSignal.any([abort.signal,AbortSignal.timeout(timeoutMs)]),
   })
  }catch(err){
   // 原始错误可能携带请求 URL（含 token），只保留错误名。
   throw new TelegramApiError(0,`telegram ${method}: 网络错误（${err instanceof Error?err.name:'unknown'}）`)
  }
  const data=(await res.json().catch(()=>undefined)) as {ok?:boolean;error_code?:number;result?:T;parameters?:{retry_after?:unknown}}|undefined
  if(!res.ok||!data?.ok){
   const retryAfter=data?.parameters?.retry_after
   const retryAfterMs=typeof retryAfter==='number'&&Number.isFinite(retryAfter)&&retryAfter>0?retryAfter*1000:undefined
   throw new TelegramApiError(data?.error_code??res.status,`telegram ${method}: HTTP ${res.status}`,retryAfterMs)
  }
  return data.result as T
 }

 function mentionsOf(text:string,entities:TgEntity[]):ImInbound['mentions']{
  const out:({kind:'user';imUserId:string;raw:string}|{kind:'botSelf';raw:string})[]=[]
  for(const entity of entities){
   const raw=text.slice(entity.offset,entity.offset+entity.length)
   if(entity.type==='mention'&&botUsername&&raw.toLowerCase()===`@${botUsername.toLowerCase()}`)out.push({kind:'botSelf',raw})
   else if(entity.type==='text_mention'&&entity.user)out.push({kind:'user',imUserId:String(entity.user.id),raw})
  }
  return out
 }

 function fromMessage(update:TgUpdate,msg:TgMessage):ImInbound|undefined{
  const chatKind=chatKindOf(msg)
  if(!chatKind||!msg.from)return undefined
  const text=msg.text??msg.caption??''
  const media:ImInbound['media']=[
   ...(msg.photo?[{kind:'image' as const}]:[]),
   ...(msg.document?[{kind:'file' as const,...(msg.document.file_name===undefined?{}:{name:msg.document.file_name}),...(msg.document.mime_type===undefined?{}:{mime:msg.document.mime_type}),...(msg.document.file_size===undefined?{}:{bytes:msg.document.file_size})}]:[]),
  ]
  if(!text&&media.length===0)return undefined
  return {
   channelId:'telegram',
   chatId:String(msg.chat.id),
   chatKind,
   messageId:String(msg.message_id),
   ...(chatKind==='thread'?{threadId:String(msg.message_thread_id)}:{}),
   ...(msg.reply_to_message?{replyToId:String(msg.reply_to_message.message_id)}:{}),
   sender:{imUserId:String(msg.from.id),displayName:displayName(msg.from)},
   text,
   mentions:mentionsOf(text,msg.entities??msg.caption_entities??[]),
   media,
   at:new Date(msg.date*1000).toISOString(),
   raw:update,
  }
 }

 async function fromCallback(update:TgUpdate):Promise<ImInbound|undefined>{
  const query=update.callback_query!
  const msg=query.message
  const chatKind=msg&&chatKindOf(msg)
  // data 只作待决表查找键：格式不符或缺消息上下文则由适配器直接应答后丢弃，避免客户端转圈。
  if(!query.data||!callbackPattern.test(query.data)||!msg||!chatKind){
   await answer(query.id)
   return undefined
  }
  return {
   channelId:'telegram',
   chatId:String(msg.chat.id),
   chatKind,
   messageId:String(msg.message_id),
   ...(chatKind==='thread'?{threadId:String(msg.message_thread_id)}:{}),
   sender:{imUserId:String(query.from.id),displayName:displayName(query.from)},
   text:'',
   mentions:[],
   media:[],
   action:{callbackId:query.data.slice(2),value:query.data[0]==='a'?'approve':'reject',callbackToken:query.id},
   at:deps.now().toISOString(),
   raw:update,
  }
 }

 async function answer(callbackQueryId:string,text?:string):Promise<void>{
  await api('answerCallbackQuery',{callback_query_id:callbackQueryId,...(text===undefined?{}:{text})}).catch((err:unknown)=>{
   deps.log.warn('[telegram] answerCallbackQuery 失败：%s',err instanceof TelegramApiError?err.status:'unknown')
  })
 }

 function dispatch(m:ImInbound):void{
  lastEventAt=deps.now().toISOString()
  // 不等待业务处理：一条消息的处理可能等待审批，而审批回调本身也要经本循环到达。
  void handler?.(m).catch(()=>{
   deps.log.warn('[telegram] 入站处理失败：chat=%s message=%s',m.chatId,m.messageId)
   // 按钮回调处理失败时补一次应答，避免客户端一直转圈。
   if(m.action)void answer(m.action.callbackToken)
  })
 }

 async function pollLoop():Promise<void>{
  let attempt=0
  while(!stopped){
   try{
    if(botUsername===undefined)botUsername=(await api<{username?:string}>('getMe',{})).username??''
    const updates=await api<TgUpdate[]>('getUpdates',{
     offset,
     timeout:pollTimeoutSec,
     allowed_updates:['message','callback_query'],
    },(pollTimeoutSec+10)*1000)
    attempt=0
    connected=true
    error=undefined
    for(const update of updates){
     offset=update.update_id+1
     const m=update.callback_query?await fromCallback(update):update.message?fromMessage(update,update.message):undefined
     if(m)dispatch(m)
    }
    // 空批次避免空转（上游做法）。
    if(updates.length===0&&!stopped)await sleep(50)
   }catch(err){
    if(stopped)break
    connected=false
    const status=err instanceof TelegramApiError?err.status:0
    if(status===401||status===403||status===409){
     error=status===409?'another-host':'credentials-invalid'
     deps.log.warn('[telegram] 轮询终止：%s',error)
     stopped=true
     break
    }
    attempt+=1
    deps.log.info('[telegram] 轮询错误（第 %s 次）：%s',attempt,err instanceof Error?err.message:'unknown')
    if(attempt===maxReconnectAttempts){
     error='reconnecting'
     deps.log.warn('[telegram] 连接连续失败 %s 次',attempt)
    }
    await sleep(err instanceof TelegramApiError&&err.retryAfterMs!==undefined?err.retryAfterMs:reconnectDelayMs(attempt))
   }
  }
  connected=false
 }

 async function sendMessage(body:Record<string,unknown>):Promise<{messageId:string}>{
  // 关闭链接预览：预览由 Telegram 服务端抓取正文里的链接，会把内网或带令牌的地址外泄给第三方。
  const result=await api<{message_id:number}>('sendMessage',{...body,link_preview_options:{is_disabled:true}})
  return {messageId:String(result.message_id)}
 }

 return {
  id:'telegram',
  label:'Telegram',
  capabilities:{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:maxTextLength,rateLimitPerMinute:20},
  async start(h){
   handler=h
   if(loop)return
   stopped=false
   error=undefined
   abort=new AbortController()
   deps.log.info('[telegram] 开始长轮询（Bot API）')
   loop=pollLoop().finally(()=>{loop=undefined})
  },
  async stop(){
   stopped=true
   abort.abort()
   await loop
   connected=false
  },
  async send(chatId,text,opts){
   const base={chat_id:chatIdParam(chatId),text,...(opts?.threadId===undefined?{}:{message_thread_id:Number(opts.threadId)})}
   try{
    return await sendMessage({...base,text:escapeHtml(text),parse_mode:'HTML'})
   }catch(err){
    // HTML 实体非法（400）时回退纯文本（上游做法，纯文本模式同样不渲染标签）；其它错误（含 429）原样抛出。
    if(!(err instanceof TelegramApiError&&err.status===400))throw err
    return sendMessage(base)
   }
  },
  async sendCard(chatId,card:ApprovalCard,opts){
   const inline_keyboard=[[
    ...(card.approveLabel===undefined?[]:[{text:card.approveLabel,callback_data:telegramCallbackData('a',card.callbackId)}]),
    {text:card.rejectLabel,callback_data:telegramCallbackData('r',card.callbackId)},
   ]]
   return sendMessage({
    chat_id:chatIdParam(chatId),
    // 上限按实体解析后的字数计：先截断再转义。
    text:escapeHtml(truncate([card.title,...card.lines].join('\n'),maxTextLength)),
    parse_mode:'HTML',
    ...(opts?.threadId===undefined?{}:{message_thread_id:Number(opts.threadId)}),
    reply_markup:{inline_keyboard},
   })
  },
  async editMessage(chatId,messageId,text){
   await api('editMessageText',{chat_id:chatIdParam(chatId),message_id:Number(messageId),text,reply_markup:{inline_keyboard:[]}})
  },
  async ack(m,text){
   if(m.action)await answer(m.action.callbackToken,text)
  },
  status(){
   return {connected,...(lastEventAt===undefined?{}:{lastEventAt}),...(error===undefined?{}:{error})}
  },
 }
}
