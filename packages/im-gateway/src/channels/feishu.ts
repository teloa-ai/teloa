// 源自 dsh-im-gateway（https://github.com/zhuiyueya/dsh-im-gateway，commit c907dd5，MIT，Copyright (c) 2026 zhuiyueya）。
// Teloa 修改：保留「动态加载 SDK → Client + EventDispatcher.register → WSClient.start」骨架与文本消息解析（另补 post 富文本提取纯文本），SDK 改为经 deps.loadSdk() 从受管安装目录加载（不进 package.json）；实现 Teloa ImChannelAdapter（card.action.trigger 与同步 toast、@解析、话题回复、卡片 patch 撤按钮、bot/v3/info 取机器人 open_id），凭据经 deps.env() 按次读取、凭据错误码终态不重试、启动失败指数退避、出站中和 <at> 标签、429 按限流重置时间、卡片字段截断、SDK 错误脱敏；同一实现按渠道种类传 SDK 官方域名常量（feishu → Domain.Feishu、lark → Domain.Lark）与各自凭据键。许可全文见 packages/im-gateway/licenses/dsh-im-gateway.LICENSE，来源记录见 provenance/dsh-im-gateway.md。
/**
 * 飞书 / Lark 渠道适配器：官方 Node SDK 的 WebSocket 长连接 + IM API。同一实现服务两个渠道种类：feishu（open.feishu.cn）与
 * lark（飞书国际版，open.larksuite.com），只按种类切换 SDK 域名常量、凭据键与显示名；域名不接受任何用户输入。
 * SDK（@larksuiteoapi/node-sdk 1.74.0）由宿主按需受管安装，经 deps.loadSdk() 加载；缺失时状态提示重新保存凭据。
 * 凭据只交给 SDK 构造参数；SDK 抛出的原始错误（axios，带请求头与 tenant token）不进日志、错误与回包。
 * @module dsh-im-gateway/channels/feishu
 */

import type {ImChannelErrorCode} from '@teloa/contract'
import type {AdapterDeps,ApprovalCard,ImChannelAdapter,ImChatKind,ImInbound} from '../core/types.ts'
import {maxReconnectAttempts,reconnectDelayMs} from '../core/backoff.ts'
import {truncate} from '../core/truncate.ts'
import type {FeishuClient,FeishuLogger,FeishuResponse,FeishuSdk,FeishuWsClient} from './feishu-sdk.ts'

type RawMessageEvent={
 sender?:{sender_id?:{open_id?:string};sender_type?:string}
 message?:{
  message_id?:string
  root_id?:string
  thread_id?:string
  chat_id?:string
  chat_type?:string
  message_type?:string
  content?:string
  create_time?:string
  mentions?:{key?:string;id?:{open_id?:string};name?:string}[]
 }
}
type RawCardAction={
 operator?:{open_id?:string}
 token?:string
 action?:{value?:unknown}
 context?:{open_message_id?:string;open_chat_id?:string}
}

/**
 * App ID 形态：cli_ 后 8–64 位字母数字（飞书与 Lark 都用 cli_ 前缀，放宽以免误拒真实应用）；不符按凭据错误终态处理，不出网。
 */
const appIdPattern=/^cli_[A-Za-z0-9]{8,64}$/
/** SDK 1.74.0 WSClient.start 实际接受的 App ID（lib/index.js 同一正则），不符时它静默返回、不建长连接：建连前先核对，给出明确状态。 */
const wsAppIdPattern=/^cli_[0-9a-fA-F]{16}$/
const callbackIdPattern=/^[A-Za-z0-9_-]{1,128}$/
/** app 凭据错误码：终态不重试。 */
const terminalCodes=new Set([99991663,99991664])
const rateLimitCode=99991400
const maxTextLength=4000
const maxButtonLength=75
/** card.action.trigger 须在 3 秒内同步回包：最多等业务 ack 这么久。 */
const toastWaitMs=2000
const rememberLimit=500

class FeishuApiError extends Error{
 readonly code?:number
 /** 429／99991400 时限流重置时间（x-ogw-ratelimit-reset 秒 ×1000）。 */
 readonly retryAfterMs?:number
 readonly terminal:boolean
 /** 终态时对外的状态错误码；缺省为凭据无效。 */
 readonly status?:ImChannelErrorCode
 constructor(message:string,opts:{code?:number;retryAfterMs?:number;terminal?:boolean;status?:ImChannelErrorCode}={}){
  super(message)
  if(opts.status!==undefined)this.status=opts.status
  if(opts.code!==undefined)this.code=opts.code
  if(opts.retryAfterMs!==undefined)this.retryAfterMs=opts.retryAfterMs
  this.terminal=opts.terminal??(opts.code!==undefined&&terminalCodes.has(opts.code))
 }
}

/**
 * SDK tenant token 缓存（Cache 接口：get/set 带 namespace 与绝对过期毫秒）。SDK 默认的模块级缓存只按 appId 分键、不分域名，
 * 飞书与 Lark 同进程并存时会串用对方的 token：每个 Client 各带一份内存缓存。
 */
function createTokenCache(){
 const values=new Map<string,{value:unknown;expiredTime?:number}>()
 const keyOf=(key:string|symbol,namespace?:string)=>`${namespace??''}/${String(key)}`
 return {
  async get(key:string|symbol,options?:{namespace?:string}):Promise<unknown>{
   const entry=values.get(keyOf(key,options?.namespace))
   if(!entry)return undefined
   if(entry.expiredTime!==undefined&&entry.expiredTime<=Date.now()){values.delete(keyOf(key,options?.namespace));return undefined}
   return entry.value
  },
  async set(key:string|symbol,value:unknown,expiredTime?:number,options?:{namespace?:string}):Promise<boolean>{
   values.set(keyOf(key,options?.namespace),{value,...(expiredTime===undefined?{}:{expiredTime})})
   return true
  },
 }
}

/** 渠道种类 → 官方域名常量名（SDK Domain 枚举键）、凭据键、显示名。 */
const brands={
 feishu:{label:'飞书',domain:'Feishu',appId:'FEISHU_APP_ID',appSecret:'FEISHU_APP_SECRET',encryptKey:'FEISHU_ENCRYPT_KEY'},
 lark:{label:'Lark',domain:'Lark',appId:'LARK_APP_ID',appSecret:'LARK_APP_SECRET',encryptKey:'LARK_ENCRYPT_KEY'},
} as const
export type FeishuBrand=keyof typeof brands

const isObject=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null

/** 限流重置时间：取 x-ogw-ratelimit-reset（秒）；取不到返回空对象，由调用方按指数退避。 */
function resetAfter(holder:Record<string,unknown>|undefined):{retryAfterMs?:number}{
 const reset=holder&&isObject(holder.headers)?Number(holder.headers['x-ogw-ratelimit-reset']):Number.NaN
 return Number.isFinite(reset)&&reset>0?{retryAfterMs:reset*1000}:{}
}

/** 只从 SDK 错误中取 HTTP 状态、业务码与限流重置时间，其余（请求配置、请求头）一律丢弃。 */
function sanitize(method:string,err:unknown):FeishuApiError{
 const response=isObject(err)&&isObject(err.response)?err.response:undefined
 const data=response&&isObject(response.data)?response.data:undefined
 const code=typeof data?.code==='number'?data.code:undefined
 const status=typeof response?.status==='number'?response.status:undefined
 const limited=status===429||code===rateLimitCode
 const detail=code!==undefined?`code ${code}`:status!==undefined?`HTTP ${status}`:`网络错误（${err instanceof Error?err.name:'unknown'}）`
 return new FeishuApiError(`feishu ${method}: ${detail}`,{...(code===undefined?{}:{code}),...(limited?resetAfter(response):{})})
}

async function call<T extends FeishuResponse<unknown>>(method:string,run:()=>Promise<T>):Promise<T>{
 let res:T
 try{
  res=await run()
 }catch(err){
  throw sanitize(method,err)
 }
 // 业务码形式的限流（200 回包）：回包若带重置头则按它等待，否则由调用方按指数退避。
 if(typeof res?.code==='number'&&res.code!==0)throw new FeishuApiError(`feishu ${method}: code ${res.code}`,{code:res.code,...(res.code===rateLimitCode&&isObject(res)?resetAfter(res):{})})
 return res
}

/** 飞书文本消息会把 <at user_id="…"> 渲染为提及（含 @所有人）、把 [文字](链接) 渲染为超链接：插入零宽空格使其按原文显示。 */
function neutralizeAt(text:string):string{
 return text.replace(/<(?=\/?at[\s>])/gi,'<\u200b').replace(/\]\(/g,']\u200b(')
}

function parseContent(raw:string|undefined):Record<string,unknown>{
 try{
  const value=JSON.parse(raw??'{}') as unknown
  return isObject(value)?value:{}
 }catch{
  return {}
 }
}

/**
 * post（富文本）→ 纯文本：标题一行、每段一行；text/a/code_block/md 取文字，at 输出占位键（随后与 text 消息同样还原为 @名字），
 * 图片与视频只记媒体元数据（不下载），表情等其余元素忽略。接收事件的 content 为 {title,content}，也兼容按语言包裹的 {zh_cn:{…}}。
 */
function postText(content:Record<string,unknown>):{text:string;media:ImInbound['media']}{
 const body=Array.isArray(content.content)?content:Object.values(content).find(value=>isObject(value)&&Array.isArray(value.content))
 if(!isObject(body)||!Array.isArray(body.content))return {text:'',media:[]}
 const media:{kind:'image'|'file'}[]=[]
 const lines=typeof body.title==='string'&&body.title?[body.title]:[]
 for(const paragraph of body.content){
  if(!Array.isArray(paragraph))continue
  let line=''
  for(const element of paragraph){
   if(!isObject(element))continue
   if(element.tag==='img'||element.tag==='media'){media.push({kind:element.tag==='img'?'image':'file'});continue}
   if(element.tag==='at'){
    const key=typeof element.user_id==='string'&&element.user_id.startsWith('@_user_')?element.user_id:undefined
    line+=key??(typeof element.user_name==='string'?`@${element.user_name}`:'')
    continue
   }
   if(typeof element.text==='string')line+=element.text
   else if(element.tag==='a'&&typeof element.href==='string')line+=element.href
  }
  if(line)lines.push(line)
 }
 return {text:lines.join('\n'),media}
}

function remember<V>(map:Map<string,V>,key:string,value:V):void{
 map.delete(key)
 if(map.size>=rememberLimit)map.delete(map.keys().next().value!)
 map.set(key,value)
}

function cardContent(body:string,card?:ApprovalCard):string{
 const button=(label:string,type:'primary'|'danger',decision:'approve'|'reject')=>({tag:'button',text:{tag:'plain_text',content:truncate(label,maxButtonLength)},type,value:{callbackId:card!.callbackId,decision}})
 return JSON.stringify({
  config:{wide_screen_mode:true},
  ...(card?{header:{title:{tag:'plain_text',content:truncate(card.title,maxTextLength)}}}:{}),
  elements:[
   // plain_text 不解释 lark_md 链接与 <at>，卡片正文按原文显示。
   {tag:'div',text:{tag:'plain_text',content:truncate(body,maxTextLength)}},
   ...(card?[{tag:'action',actions:[...(card.approveLabel===undefined?[]:[button(card.approveLabel,'primary','approve')]),button(card.rejectLabel,'danger','reject')]}]:[]),
  ],
 })
}

export function createFeishuAdapter(deps:AdapterDeps&{loadSdk:()=>Promise<FeishuSdk>;brand?:FeishuBrand}):ImChannelAdapter{
 const id=deps.brand??'feishu'
 const brand=brands[id]
 const tag=`[${id}]`
 let handler:((m:ImInbound)=>Promise<void>)|undefined
 let sdk:FeishuSdk|undefined
 let client:FeishuClient|undefined
 let clientKey:string|undefined
 let ws:FeishuWsClient|undefined
 let botOpenId:string|undefined
 let stopped=true
 let abort=new AbortController()
 let attempt=0
 let connected=false
 let lastEventAt:string|undefined
 /** 状态错误码（审查 L4）：前端按码本地化，不回平台原文。 */
 let error:ImChannelErrorCode|undefined
 /** 正在执行连接循环（含退避）的那次启动的 signal：期间 onError 不另起重建，由循环统一处理。 */
 let rebuilding:AbortSignal|undefined
 /** 最近见过的会话类型（卡片回调不带 chat_type）。 */
 const chatKinds=new Map<string,ImChatKind>()
 /** 发到话题里的审批卡：卡片 message_id → 话题根消息 id。 */
 const cardThreads=new Map<string,string>()
 const pendingToasts=new Map<ImInbound,(text:string|undefined)=>void>()
 const sdkLogger:FeishuLogger={error:()=>deps.log.warn(`${tag} SDK 报告错误`),warn(){},info(){},debug(){},trace(){}}

 const sleep=(ms:number,signal:AbortSignal):Promise<void>=>{
  if(deps.sleep)return deps.sleep(ms)
  return new Promise(resolve=>{
   const timer=setTimeout(resolve,ms)
   signal.addEventListener('abort',()=>{clearTimeout(timer);resolve()},{once:true})
  })
 }

 async function loadSdk():Promise<FeishuSdk>{
  sdk??=await deps.loadSdk()
  return sdk
 }

 /** 凭据按次读取；变化（轮换）时重建 Client（连同其 token 缓存），未变时复用以保留 tenant token 缓存。 */
 async function credentials():Promise<{appId:string;appSecret:string;encryptKey?:string}>{
  const env=await deps.env()
  const appId=env[brand.appId]
  const appSecret=env[brand.appSecret]
  const encryptKey=env[brand.encryptKey]
  if(!appId||!appIdPattern.test(appId)||!appSecret)throw new FeishuApiError(`${id}: 凭据格式不合法`,{terminal:true})
  return {appId,appSecret,...(encryptKey?{encryptKey}:{})}
 }

 async function clientFor(creds?:{appId:string;appSecret:string}):Promise<FeishuClient>{
  const {appId,appSecret}=creds??await credentials()
  const key=`${appId}\n${appSecret}`
  if(!client||clientKey!==key){
   const {Client,Domain}=await loadSdk()
   client=new Client({appId,appSecret,domain:Domain[brand.domain],cache:createTokenCache(),logger:sdkLogger})
   clientKey=key
  }
  return client
 }

 function dispatch(m:ImInbound):Promise<void>{
  lastEventAt=deps.now().toISOString()
  return (handler?.(m)??Promise.resolve()).catch(()=>deps.log.warn(`${tag} 入站处理失败：chat=%s message=%s`,m.chatId,m.messageId))
 }

 function fromMessage(data:RawMessageEvent):ImInbound|undefined{
  const msg=data.message
  const senderId=data.sender?.sender_id?.open_id
  if(!msg?.message_id||!msg.chat_id||!senderId||data.sender?.sender_type!=='user')return undefined
  const chatKind:ImChatKind|undefined=msg.chat_type==='p2p'?'direct':msg.chat_type==='group'?(msg.thread_id?'thread':'group'):undefined
  if(!chatKind)return undefined
  remember(chatKinds,msg.chat_id,chatKind==='direct'?'direct':'group')
  const content=parseContent(msg.content)
  const post=msg.message_type==='post'?postText(content):undefined
  let text=msg.message_type==='text'&&typeof content.text==='string'?content.text:post?.text??''
  const mentionList=msg.mentions??[]
  // 占位键 @_user_N 替换回 @名字；长键先换，避免 @_user_1 吃掉 @_user_10 的前缀。
  for(const mention of [...mentionList].sort((a,b)=>(b.key?.length??0)-(a.key?.length??0))){
   if(mention.key)text=text.split(mention.key).join(`@${mention.name??mention.id?.open_id??''}`)
  }
  const mentions:({kind:'user';imUserId:string;raw:string}|{kind:'botSelf';raw:string})[]=[]
  for(const mention of mentionList){
   const openId=mention.id?.open_id
   if(!mention.key||!openId)continue
   const raw=`@${mention.name??openId}`
   mentions.push(openId===botOpenId?{kind:'botSelf',raw}:{kind:'user',imUserId:openId,raw})
  }
  // 一期文件只收元数据、不下载。
  const fileName=typeof content.file_name==='string'?{name:content.file_name}:{}
  const media:ImInbound['media']=msg.message_type==='image'?[{kind:'image'}]:msg.message_type==='file'||msg.message_type==='media'||msg.message_type==='audio'?[{kind:'file',...fileName}]:post?.media??[]
  if(!text&&media.length===0)return undefined
  const createdMs=Number(msg.create_time)
  return {
   channelId:id,
   chatId:msg.chat_id,
   chatKind,
   messageId:msg.message_id,
   // 话题 id（omt_…）不能用于回复：threadId 取话题根消息 id，新话题的根消息即自身。
   ...(chatKind==='thread'?{threadId:msg.root_id??msg.message_id}:{}),
   sender:{imUserId:senderId,displayName:senderId},
   text,
   mentions,
   media,
   at:Number.isFinite(createdMs)&&createdMs>0?new Date(createdMs).toISOString():deps.now().toISOString(),
   raw:data,
  }
 }

 async function onCardAction(data:RawCardAction):Promise<unknown>{
  const value=data.action?.value
  const callbackId=isObject(value)&&typeof value.callbackId==='string'?value.callbackId:undefined
  const decision=isObject(value)&&(value.decision==='approve'||value.decision==='reject')?value.decision:undefined
  const chatId=data.context?.open_chat_id
  const messageId=data.context?.open_message_id
  const operator=data.operator?.open_id
  // 按钮 value 只作待决表查找键：不是本适配器发出的按钮或格式不符即丢弃。
  if(!callbackId||!callbackIdPattern.test(callbackId)||!decision||!chatId||!messageId||!operator)return undefined
  const threadId=cardThreads.get(messageId)
  const chatKind:ImChatKind=threadId!==undefined?'thread':chatKinds.get(chatId)??'group'
  // 卡片 token 可在 30 分钟内更新该卡片，不随 raw 透传。
  const {token:_,...raw}=data
  const m:ImInbound={
   channelId:id,
   chatId,
   chatKind,
   messageId,
   ...(threadId===undefined?{}:{threadId}),
   sender:{imUserId:operator,displayName:operator},
   text:'',
   mentions:[],
   media:[],
   action:{callbackId,value:decision,callbackToken:''},
   at:deps.now().toISOString(),
   raw,
  }
  let settle:(text:string|undefined)=>void=()=>{}
  const toast=new Promise<string|undefined>(resolve=>{settle=resolve})
  pendingToasts.set(m,settle)
  const timer=setTimeout(()=>settle(undefined),toastWaitMs)
  timer.unref?.()
  void dispatch(m).finally(()=>settle(undefined))
  try{
   const text=await toast
   return text===undefined?undefined:{toast:{type:'info',content:text}}
  }finally{
   clearTimeout(timer)
   pendingToasts.delete(m)
  }
 }

 /** 记一次失败并等待退避；返回是否应继续重连。 */
 async function backoff(signal:AbortSignal,retryAfterMs?:number):Promise<boolean>{
  attempt+=1
  if(attempt===maxReconnectAttempts){
   error='reconnecting'
   deps.log.warn(`${tag} 连接连续失败 %s 次`,attempt)
  }
  await sleep(retryAfterMs??reconnectDelayMs(attempt),signal)
  return !signal.aborted
 }

 async function connect(signal:AbortSignal):Promise<void>{
  const creds=await credentials()
  if(!wsAppIdPattern.test(creds.appId))throw new FeishuApiError(`${id}: App ID 格式暂时无法建立长连接`,{terminal:true,status:'app-id-unsupported'})
  const {EventDispatcher,WSClient,Domain}=await loadSdk()
  const info=await call('bot/v3/info',async()=>(await clientFor(creds)).request({url:'/open-apis/bot/v3/info',method:'GET'}))
  if(!info.bot?.open_id)throw new FeishuApiError(`${id} bot/v3/info: 缺少 open_id`)
  botOpenId=info.bot.open_id
  if(signal.aborted)return
  const eventDispatcher=new EventDispatcher({...(creds.encryptKey===undefined?{}:{encryptKey:creds.encryptKey}),logger:sdkLogger}).register({
   'im.message.receive_v1':async data=>{
    const m=fromMessage(data as RawMessageEvent)
    // 不等待业务处理：一条消息的处理可能等待审批，而审批卡片回调本身也要经本连接到达。
    if(m)void dispatch(m)
   },
   'card.action.trigger':data=>onCardAction(data as RawCardAction),
  })
  const socket:FeishuWsClient=new WSClient({
   appId:creds.appId,
   appSecret:creds.appSecret,
   domain:Domain[brand.domain],
   logger:sdkLogger,
   autoReconnect:true,
   handshakeTimeoutMs:15_000,
   onReady:()=>{
    if(ws!==socket)return
    connected=true
    attempt=0
    error=undefined
    deps.log.info(`${tag} WebSocket 长连接已建立`)
   },
   onReconnecting:()=>{
    if(ws===socket)connected=false
   },
   onReconnected:()=>{
    if(ws!==socket)return
    connected=true
    attempt=0
    error=undefined
   },
   // SDK 自带重连用尽（或首连失败不再重试）：丢弃该连接，按指数退避整体重建。连接循环进行中时由循环负责重建，保证单一路径。
   onError:()=>{
    if(ws!==socket)return
    ws=undefined
    connected=false
    socket.close({force:true})
    if(signal.aborted||rebuilding===signal)return
    deps.log.info(`${tag} 长连接失败，准备重建`)
    void loop(signal,true)
   },
  })
  ws=socket
  await socket.start({eventDispatcher})
  // start 期间已触发 onError（连接被丢弃）：按失败交给循环退避重建。
  if(ws!==socket&&!signal.aborted)throw new FeishuApiError(`${id} ws: 长连接失败`)
 }

 async function loop(signal:AbortSignal,afterFailure=false):Promise<void>{
  rebuilding=signal
  try{
   if(afterFailure&&!(await backoff(signal)))return
   await connectLoop(signal)
  }finally{
   if(rebuilding===signal)rebuilding=undefined
  }
 }

 async function connectLoop(signal:AbortSignal):Promise<void>{
  while(!signal.aborted){
   try{
    await connect(signal)
    return
   }catch(err){
    // 先丢弃本轮连接：其迟到的 onError 因 ws 不再指向它而被忽略。
    const failed=ws
    ws=undefined
    failed?.close({force:true})
    if(signal.aborted)return
    connected=false
    if(err instanceof FeishuApiError&&err.terminal){
     error=err.status??'credentials-invalid'
     deps.log.warn(`${tag} 连接终止：%s`,error)
     stopped=true
     abort.abort()
     return
    }
    deps.log.info(`${tag} 连接错误（第 %s 次）：%s`,attempt+1,err instanceof FeishuApiError?err.message:err instanceof Error?err.name:'unknown')
    if(!(await backoff(signal,err instanceof FeishuApiError?err.retryAfterMs:undefined)))return
   }
  }
 }

 async function run(signal:AbortSignal):Promise<void>{
  try{
   await loadSdk()
  }catch{
   error='sdk-missing'
   deps.log.warn(`${tag} %s`,error)
   stopped=true
   return
  }
  await loop(signal)
 }

 return {
  id,
  label:brand.label,
  capabilities:{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:maxTextLength,rateLimitPerMinute:50},
  async start(h){
   handler=h
   if(!stopped)return
   stopped=false
   error=undefined
   attempt=0
   botOpenId=undefined
   abort=new AbortController()
   deps.log.info(`${tag} 开始连接（WebSocket 长连接）`)
   // 不阻塞插件 apply：连接与重连在后台进行，状态经 status() 暴露。
   void run(abort.signal)
  },
  async stop(){
   stopped=true
   abort.abort()
   const socket=ws
   ws=undefined
   connected=false
   socket?.close({force:true})
   for(const settle of pendingToasts.values())settle(undefined)
  },
  async send(chatId,text,opts){
   const content=JSON.stringify({text:neutralizeAt(text)})
   const im=(await clientFor()).im.message
   const threadId=opts?.threadId
   const res=threadId===undefined
    ?await call('im.message.create',()=>im.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'text',content}}))
    :await call('im.message.reply',()=>im.reply({path:{message_id:threadId},data:{msg_type:'text',content,reply_in_thread:true}}))
   return {messageId:String(res.data?.message_id)}
  },
  async sendCard(chatId,card:ApprovalCard,opts){
   if(!callbackIdPattern.test(card.callbackId))throw new Error('飞书按钮 callbackId 格式不合法')
   const content=cardContent(card.lines.join('\n')||card.title,card)
   const im=(await clientFor()).im.message
   const threadId=opts?.threadId
   const res=threadId===undefined
    ?await call('im.message.create',()=>im.create({params:{receive_id_type:'chat_id'},data:{receive_id:chatId,msg_type:'interactive',content}}))
    :await call('im.message.reply',()=>im.reply({path:{message_id:threadId},data:{msg_type:'interactive',content,reply_in_thread:true}}))
   const messageId=String(res.data?.message_id)
   if(threadId!==undefined)remember(cardThreads,messageId,threadId)
   return {messageId}
  },
  async editMessage(_chatId,messageId,text){
   // 审批卡为 interactive 消息：patch 为无按钮卡片即撤按钮（im.message.update 只适用于 text/post）。
   const im=(await clientFor()).im.message
   await call('im.message.patch',()=>im.patch({path:{message_id:messageId},data:{content:cardContent(text)}}))
  },
  async ack(m,text){
   pendingToasts.get(m)?.(text)
  },
  status(){
   return {connected,...(lastEventAt===undefined?{}:{lastEventAt}),...(error===undefined?{}:{error})}
  },
 }
}
