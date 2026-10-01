/**
 * 验收桩渠道：本机回环 HTTP 驾驭的假 IM，只供浏览器验收驱动 IM 往返，不连任何外部平台。
 * 只在 TELOA_BROWSER_ACCEPTANCE=1 且 TELOA_IM_STUB_PORT 为合法端口时可构造（正式环境 createAdapter('stub') 抛错，
 * 启动脚本另在非验收环境拒绝该变量）。监听 127.0.0.1:port：
 *  POST /inbound  {chatId,chatKind,messageId,sender,text,mentions?,action?} → 交给 handler（至多等 5 秒处理再回 200）
 *  GET  /outbound → 返回并清空 send/sendCard/editMessage/ack 记录
 *  POST /fault {kind:'conflict'|'unauthorized'|'disconnect'} → 模拟 409 / 401 / 断线（断线按 backoff 重连）
 * 凭据 {STUB_TOKEN} 与正式渠道走同一 credentials 路径，按次读取，不进日志与回包。
 */
import {createServer,type IncomingMessage,type Server} from 'node:http'
import {WorkError,type ImChannelErrorCode} from '@teloa/contract'
import {reconnectDelayMs} from '../core/backoff.ts'
import type {AdapterDeps,ApprovalCard,ImChannelAdapter,ImChatKind,ImInbound} from '../core/types.ts'

type OutboundRecord={kind:'send'|'card'|'edit'|'ack';chatId:string;messageId:string;text:string;threadId?:string;card?:ApprovalCard}

const maxBodyBytes=64*1024
const settleLimitMs=5000
const chatKinds:readonly ImChatKind[]=['direct','group','thread']

/** 验收标记与合法端口齐备才返回端口，否则 undefined。 */
export function stubChannelPort(env:NodeJS.ProcessEnv=process.env):number|undefined{
 if(env.TELOA_BROWSER_ACCEPTANCE!=='1')return undefined
 const raw=env.TELOA_IM_STUB_PORT
 if(!raw||!/^\d{1,5}$/.test(raw))return undefined
 const port=Number(raw)
 return port>=1&&port<=65535?port:undefined
}

export function assertStubAllowed(env:NodeJS.ProcessEnv):number{
 const port=stubChannelPort(env)
 if(port===undefined)throw new WorkError('teloa/invalid-input','验收桩渠道只允许在浏览器验收环境（TELOA_BROWSER_ACCEPTANCE=1 且设 TELOA_IM_STUB_PORT）使用。')
 return port
}

const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const text=(value:unknown):value is string=>typeof value==='string'&&value.length<=8000

function readBody(req:IncomingMessage):Promise<unknown>{
 return new Promise((resolve,reject)=>{
  const chunks:Buffer[]=[]
  let size=0
  req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>maxBodyBytes){reject(new Error('too large'));req.destroy()}else chunks.push(chunk)})
  req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch(error){reject(error)}})
  req.on('error',reject)
 })
}

/** 入站子集校验：不合形状返回 undefined（400）。 */
function inboundOf(body:unknown,at:string):ImInbound|undefined{
 if(!isRecord(body)||!text(body.chatId)||!body.chatId||!chatKinds.includes(body.chatKind as ImChatKind)||!text(body.messageId)||!body.messageId||!text(body.text))return undefined
 const sender=body.sender
 if(!isRecord(sender)||!text(sender.imUserId)||!sender.imUserId||!text(sender.displayName))return undefined
 const mentions:ImInbound['mentions'][number][]=[]
 if(body.mentions!==undefined){
  if(!Array.isArray(body.mentions))return undefined
  for(const item of body.mentions){
   if(!isRecord(item)||!text(item.raw))return undefined
   if(item.kind==='botSelf')mentions.push({kind:'botSelf',raw:item.raw})
   else if(item.kind==='user'&&text(item.imUserId))mentions.push({kind:'user',imUserId:item.imUserId,raw:item.raw})
   else return undefined
  }
 }
 let action:ImInbound['action']
 if(body.action!==undefined){
  const row=body.action
  if(!isRecord(row)||!text(row.callbackId)||(row.value!=='approve'&&row.value!=='reject'))return undefined
  action={callbackId:row.callbackId,value:row.value,callbackToken:''}
 }
 const chatKind=body.chatKind as ImChatKind
 return {
  channelId:'stub',chatId:body.chatId,chatKind,messageId:body.messageId,
  ...(chatKind==='thread'&&text(body.threadId)?{threadId:body.threadId}:{}),
  sender:{imUserId:sender.imUserId,displayName:sender.displayName},
  text:body.text,mentions,media:[],...(action?{action}:{}),at,raw:body,
 }
}

export function createStubAdapter(deps:AdapterDeps&{port:number}):ImChannelAdapter{
 const sleep=deps.sleep??((ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms).unref()}))
 let handler:((m:ImInbound)=>Promise<void>)|undefined
 let server:Server|undefined
 let connected=false
 let lastEventAt:string|undefined
 /** 状态错误码（审查 L4）：与正式渠道同一套码，前端按码本地化。 */
 let error:ImChannelErrorCode|undefined
 let outbox:OutboundRecord[]=[]
 let seq=0
 /** 消息 id 带进程启动时刻前缀：宿主重启后不与旧卡片 id 重复。 */
 const idPrefix=`stub-${Date.now().toString(36)}`
 /** 每次 start/stop 递增：断线重连只作用于发起它的那一轮。 */
 let generation=0

 const token=async():Promise<boolean>=>Boolean((await deps.env()).STUB_TOKEN)
 const terminal=(code:ImChannelErrorCode)=>{connected=false;error=code;deps.log.warn('[stub] 渠道终止：%s',code)}
 const record=(row:OutboundRecord)=>{outbox.push(row);return {messageId:row.messageId}}
 const nextId=()=>`${idPrefix}-${++seq}`
 const requireConnected=async()=>{
  if(!connected)throw new Error('stub 渠道未连接')
  if(!(await token())){terminal('credentials-invalid');throw new Error('stub 凭据无效')}
 }
 const reconnect=async(round:number)=>{
  await sleep(reconnectDelayMs(1))
  if(round!==generation||error!==undefined)return
  connected=true
  deps.log.info('[stub] 已重连')
 }

 const listen=()=>new Promise<Server>((resolve,reject)=>{
  const s=createServer((req,res)=>{
   const reply=(status:number,body?:unknown)=>{res.writeHead(status,{'content-type':'application/json',connection:'close'});res.end(body===undefined?'{}':JSON.stringify(body))}
   void (async()=>{
    const path=new URL(req.url??'/','http://127.0.0.1').pathname
    if(req.method==='GET'&&path==='/outbound'){const rows=outbox;outbox=[];reply(200,rows);return}
    if(req.method!=='POST'||(path!=='/inbound'&&path!=='/fault')){reply(404);return}
    let body:unknown
    try{body=await readBody(req)}catch{reply(400);return}
    if(path==='/fault'){
     const kind=isRecord(body)?body.kind:undefined
     if(kind==='conflict')terminal('another-host')
     else if(kind==='unauthorized')terminal('credentials-invalid')
     else if(kind==='disconnect'){connected=false;deps.log.info('[stub] 连接断开，按退避重连');void reconnect(generation)}
     else{reply(400);return}
     reply(200)
     return
    }
    const m=inboundOf(body,deps.now().toISOString())
    if(!m){reply(400);return}
    if(!connected||!handler){reply(503);return}
    lastEventAt=deps.now().toISOString()
    // 至多等处理 settleLimitMs 再回包：命令类同步回复此时已进 /outbound；等审批等长处理不挡住驱动方（同 telegram 不阻塞轮询）。
    const handled=handler(m).catch(()=>deps.log.warn('[stub] 入站处理失败：chat=%s message=%s',m.chatId,m.messageId))
    let timer:ReturnType<typeof setTimeout>|undefined
    await Promise.race([handled,new Promise<void>(resolve=>{timer=setTimeout(resolve,settleLimitMs)})])
    clearTimeout(timer)
    reply(200)
   })()
  })
  s.once('error',reject)
  s.listen(deps.port,'127.0.0.1',()=>{s.off('error',reject);resolve(s)})
 })

 return {
  id:'stub',
  label:'验收桩',
  capabilities:{text:true,card:true,button:true,thread:true,file:false,edit:true,maxMessageLength:4096,rateLimitPerMinute:20},
  async start(h){
   handler=h
   if(server)return
   generation+=1
   error=undefined
   if(!(await token())){terminal('credentials-invalid');return}
   server=await listen()
   connected=true
   deps.log.info('[stub] 监听 127.0.0.1:%s',deps.port)
  },
  async stop(){
   generation+=1
   connected=false
   const s=server
   server=undefined
   if(s)await new Promise<void>(resolve=>{s.close(()=>resolve());s.closeAllConnections()})
  },
  async send(chatId,body,opts){
   await requireConnected()
   return record({kind:'send',chatId,messageId:nextId(),text:body,...(opts?.threadId===undefined?{}:{threadId:opts.threadId})})
  },
  async sendCard(chatId,card,opts){
   await requireConnected()
   return record({kind:'card',chatId,messageId:nextId(),text:[card.title,...card.lines].join('\n'),card,...(opts?.threadId===undefined?{}:{threadId:opts.threadId})})
  },
  async editMessage(chatId,messageId,body){
   await requireConnected()
   record({kind:'edit',chatId,messageId,text:body})
  },
  async ack(m,body){
   if(m.action)record({kind:'ack',chatId:m.chatId,messageId:m.messageId,text:body??''})
  },
  status(){
   return {connected,...(lastEventAt===undefined?{}:{lastEventAt}),...(error===undefined?{}:{error})}
  },
 }
}
