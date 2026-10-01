import {WorkError,groupAttachmentListInput,groupAttachmentReadInput,groupAttachmentUploadInput,groupAttachmentUploadMaxBodyBytes,groupAttachmentUploadRoutePath,groupAttachmentWithdrawInput,isGroupAttachment,isGroupAttachmentBytes} from '@teloa/contract'
import type {GroupAttachment,GroupAttachmentBytes} from '@teloa/contract'
import type {GroupAttachmentBytePorts} from '@teloa/backend'
import type {AttachmentPorts} from './attachments.ts'

export const groupAttachmentEndpoints=['groups/attachments/upload','groups/attachments/list','groups/attachments/read','groups/attachments/withdraw'] as const
/** 浏览器上传只经 `createGroupAttachmentUploadRoute` 的专用路由；/teloa 通道见到它回 not-found。 */
export const groupAttachmentUploadEndpoint=groupAttachmentEndpoints[0]

export type GroupAttachmentOperations={
 upload:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>
 list:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>
 read:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>
 withdraw:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>
}

const invalidResponse=()=>new WorkError('teloa/invalid-host-response','群附件服务返回了无效或跨本人的结果。')

/** 元数据回包逐条过契约判定器再核归属：形状对不上或不是本人的原件，一律不交给浏览器。 */
function savedAttachment(value:unknown,owner:string):GroupAttachment{
 if(!isGroupAttachment(value)||value.ownerId!==owner)throw invalidResponse()
 return value
}
function savedAttachments(value:unknown,owner:string):GroupAttachment[]{
 if(!Array.isArray(value))throw invalidResponse()
 return value.map(item=>savedAttachment(item,owner))
}
/** 原件是本人级的，字节回包里没有 ownerId 可核；判定器已覆盖 bytes 与 dataBase64 的自洽。 */
function savedBytes(value:unknown):GroupAttachmentBytes{
 if(!isGroupAttachmentBytes(value))throw invalidResponse()
 return value
}

/** 群附件只由认证后的工作台 RPC 调用；本人身份由宿主固定。 */
export function createGroupAttachmentHandler(owner:string,get:(signal:AbortSignal)=>Promise<GroupAttachmentOperations|undefined>){
 return async(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>=>{
  if(!(groupAttachmentEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此群附件接口。')
  // 先过契约解析器再开服务：未经逐字解析的入参一个字节都不许到达服务层。
  const input=endpoint==='groups/attachments/upload'?groupAttachmentUploadInput(payload)
   :endpoint==='groups/attachments/list'?groupAttachmentListInput(payload)
   :endpoint==='groups/attachments/read'?groupAttachmentReadInput(payload)
   :groupAttachmentWithdrawInput(payload)
  // 解析完与每次进服务之前各判一次取消：服务方法自身不收 signal，取消只能在这两处生效。
  signal.throwIfAborted()
  const service=await get(signal)
  if(!service)throw new WorkError('teloa/host-unavailable','群附件服务尚未就绪。')
  signal.throwIfAborted()
  if(endpoint==='groups/attachments/upload')return {attachment:savedAttachment(await service.upload(owner,input,signal),owner)}
  if(endpoint==='groups/attachments/list')return {items:savedAttachments(await service.list(owner,input,signal),owner)}
  if(endpoint==='groups/attachments/read')return {bytes:savedBytes(await service.read(owner,input,signal))}
  return {attachment:savedAttachment(await service.withdraw(owner,input,signal),owner)}
 }
}

/**
 * T1 的四方法端口 → 后端的三方法端口，全仓唯一一处适配。
 * 读回按 `kind` 分流：图片交归一化之后的落盘事实（`mime`／`bytes`／像素），
 * 文件交宿主清洗过的叶名——两种引用都要与落盘时逐字一致，否则附件仓拒绝读取。
 * 后端的 `readBytes` 自身不收 `signal`，取消按次注入：每次 RPC 现折一份端口。
 */
export function toBackendBytePorts(ports:AttachmentPorts,signal?:AbortSignal):GroupAttachmentBytePorts{
 return {
  saveImage:(dataBase64,mime,name)=>ports.saveImage(dataBase64,mime,name),
  saveFile:(dataBase64,name)=>ports.saveFile(dataBase64,name),
  readBytes:row=>{
   if(row.kind!=='image')return ports.readFileBytes({attachmentId:row.attachmentId,name:row.name,bytes:row.bytes},signal)
   // 图片引用必须带像素：DDL 的 check 保证在用行不会缺，缺了就是行坏了，不能拿 0 去凑一个必定被拒的引用。
   if(row.width===null||row.height===null)throw new WorkError('teloa/storage-corrupt','附件像素事实缺失。')
   return ports.readImageBytes({attachmentId:row.attachmentId,mediaType:row.mime,bytes:row.bytes,width:row.width,height:row.height},signal)
  },
 }
}

type RouteFailure={ok:false;error:{code:string;message:string;details:Record<string,unknown>}}
/** 与 /teloa 通道的失败回包同一口径：WorkError 原码原文原 details，其余一律 host-unavailable、原因只进日志。 */
function routeFailure(error:unknown):RouteFailure{
 return {ok:false,error:error instanceof WorkError
  ?{code:error.code,message:error.message,details:error.details&&typeof error.details==='object'?error.details as Record<string,unknown>:{}}
  :{code:'teloa/host-unavailable',message:'工作服务暂不可用，请重试；详细原因已记录在宿主日志。',details:{}}}
}
const routeJson=(status:number,body:unknown)=>Response.json(body,{status,headers:{'cache-control':'no-store'}})
const routeReject=(status:number,message:string)=>routeJson(status,routeFailure(new WorkError('teloa/invalid-input',message)))

/** 边读边计数：多于声明长度立即取消读取（不读到底）；少于声明长度（客户端中途断开）同样不交给业务。 */
async function readDeclaredBody(request:Request,length:number):Promise<string|undefined>{
 if(!request.body)return undefined
 const reader=request.body.getReader(),chunks:Uint8Array[]=[]
 let received=0
 for(;;){
  const {done,value}=await reader.read()
  if(done)break
  received+=value.byteLength
  if(received>length){await reader.cancel().catch(()=>{});return undefined}
  chunks.push(value)
 }
 if(received!==length)return undefined
 const joined=Buffer.concat(chunks)
 chunks.length=0
 return new TextDecoder('utf-8',{fatal:true}).decode(joined)
}

/**
 * 群附件上传的专用 Fetch 路由（审查 M1）。挂在 DSH 官方 `connection.fetch.register` 上：`/api` 的 Host/Origin 围栏与
 * 本人浏览器 Cookie 鉴权由 DSH 在调用本路由之前完成，与 /teloa 通道是同一个 `admit()`；这里再要求 JSON 请求头（跨站表单
 * 发不出这种请求，跨源 fetch 需预检，与 /teloa 同一条约束）。之后三步都发生在读请求体之前或读的过程中：
 * 1. 按 Content-Length 判长：缺失或超过 `groupAttachmentUploadMaxBodyBytes` 立即拒，一个字节都不读；
 * 2. 按本人串行：宿主只服务一位本人，一条队列即本人级锁；拿到锁才开始读体，并发上传不会同时在堆里展开；
 * 3. 边读边计数：多于声明长度立即停读。
 * 业务判定仍全部交给同一个 `handle`（契约解析、群可写、额度、幂等回执不变）。
 */
export function createGroupAttachmentUploadRoute(handle:(endpoint:string,payload:unknown,signal:AbortSignal)=>Promise<unknown>,report:(error:unknown)=>void=()=>{}){
 let tail:Promise<void>=Promise.resolve()
 return {
  path:groupAttachmentUploadRoutePath,
  methods:['POST'] as const,
  requestBody:'streaming' as const,
  fetch:async(request:Request):Promise<Response>=>{
   if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json')return routeReject(415,'群附件上传请求必须是 JSON。')
   const declared=request.headers.get('content-length')
   if(declared===null||!/^[0-9]{1,15}$/.test(declared))return routeReject(411,'群附件上传请求必须带上请求长度。')
   const length=Number(declared)
   if(length<1||length>groupAttachmentUploadMaxBodyBytes)return routeReject(413,'附件超过单件上限。')
   const prior=tail
   let release!:()=>void
   tail=new Promise<void>(done=>{release=done})
   try{
    await prior
    if(request.signal.aborted)return routeReject(400,'群附件上传已取消。')
    let text:string|undefined
    try{text=await readDeclaredBody(request,length)}catch{text=undefined}
    if(text===undefined)return routeReject(400,'群附件上传请求的长度或编码不正确。')
    let payload:unknown
    try{payload=JSON.parse(text)}catch{return routeReject(400,'群附件上传请求不是合法 JSON。')}
    text=undefined
    return routeJson(200,{ok:true,value:await handle(groupAttachmentUploadEndpoint,payload,request.signal)})
   }catch(error){
    report(error)
    return routeJson(200,routeFailure(error))
   }finally{release()}
  },
 }
}
