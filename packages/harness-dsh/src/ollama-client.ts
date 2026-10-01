import {isRefusedAddress,readOllamaAddress} from './ollama-address.ts'
import {lookup as dnsLookup} from 'node:dns/promises'
import {request as httpRequest} from 'node:http'
import {request as httpsRequest} from 'node:https'
import {isIP,type LookupFunction} from 'node:net'
import {Readable} from 'node:stream'
import {WorkError,isRecord,ollamaModelNamePattern} from '@teloa/contract'

/**
 * Ollama 原生接口客户端（模型二期规格 §3 / §8）。
 * 只请求固定路径；DNS 名每次请求前解析、任一结果落入拒绝网段即拒绝；建连时经 `http.request` 的 `lookup` 只允许连到
 * 刚校验过的地址（钉住，保留原 Host 头与 SNI，不给 DNS 重绑定留窗口）；IP 字面量走全局 fetch。任何跳转都不跟随。失败映射：连接失败/超时 → dependency-unavailable，
 * 非 2xx/非法 JSON/形状不符 → invalid-host-response，拉取 `{error}` 行或分片空闲超时 → source-unavailable，拒绝网段 → forbidden。
 */
export type OllamaTag={name:string;size:number;digest:string;family:string|null;parameterSize:string|null;quantizationLevel:string|null}
export type OllamaThinking={values:(boolean|string)[];default:boolean|string}
export type OllamaShow={family:string|null;contextLength:number|null;capabilities:string[]|null;thinking?:OllamaThinking}
/** /api/ps 的每请求已分配容量，不能用 /api/show 的训练/标称上限代替。 */
export type OllamaRunningModel={name:string;digest:string|null;contextLength:number|null}
/** 保留状态用于运行期原生故障分类，错误正文不进入模型或日志。 */
export class OllamaHttpError extends WorkError{
 readonly status:number
 constructor(status:number){super('teloa/invalid-host-response',`Ollama 返回 HTTP ${status}。`);this.status=status}
}
export type OllamaPullProgress={completed:number;total:number|null;status:string}
/**
 * `fetch` 只供测试注入，且只在地址为 IP 字面量时生效：DNS 名一律走钉住通道，生产代码不得传 `fetch`。
 * `timeoutMs`（缺省 3 s）覆盖整个请求（建连 + 响应头 + 响应体）；拉取只用它计到响应头，之后按 `pullIdleTimeoutMs`（缺省 60 s）判分片空闲。
 * 空加载有独立 `loadTimeoutMs`（缺省 180 s），允许从磁盘加载权重；用户取消优先。
 */
export type OllamaClientDeps={lookup?:(host:string)=>Promise<{address:string;family:number}[]>;fetch?:typeof fetch;timeoutMs?:number;pullIdleTimeoutMs?:number;loadTimeoutMs?:number}
/** 非流式回包上限：/api/tags 数百条也远小于 1 MiB。 */
const MAX_JSON_BYTES=1_048_576
/** 拉取进度单行上限：Ollama 单行 <1 KB。 */
const MAX_PULL_LINE_BYTES=65_536
type OllamaPath='/api/version'|'/api/tags'|'/api/ps'|'/api/show'|'/api/pull'|'/api/delete'|'/api/chat'

const hostResponse=(message:string)=>new WorkError('teloa/invalid-host-response',message)
const unavailable=(message:string)=>new WorkError('teloa/dependency-unavailable',message)
const modelName=(name:string):string=>{if(!ollamaModelNamePattern.test(name)||name.length>128)throw new WorkError('teloa/invalid-input','本地模型名称格式不正确。');return name}
const optionalText=(value:unknown):string|null=>typeof value==='string'&&value.length>0&&value.length<=256?value:null
/** Ollama 清单回裸十六进制，目录/持久记录用 sha256:；只归一表示，不改变摘要。 */
const normalizedDigest=(value:unknown):string=>{
 if(typeof value!=='string'||!/^(?:sha256:)?[0-9a-f]{64}$/.test(value))throw hostResponse('Ollama 模型摘要格式不正确。')
 return value.startsWith('sha256:')?value:`sha256:${value}`
}

export class OllamaClient{
 private readonly address:{baseURL:string;host:string;local:boolean}
 private readonly deps:OllamaClientDeps
 constructor(address:{baseURL:string;host:string;local:boolean},deps:OllamaClientDeps={}){this.address=readOllamaAddress(address.baseURL);this.deps=deps}

 async version():Promise<string>{
  const body=await this.json('/api/version')
  if(typeof body.version!=='string'||!body.version||body.version.length>64)throw hostResponse('Ollama 版本信息格式不正确。')
  return body.version
 }
 async tags():Promise<OllamaTag[]>{
  const body=await this.json('/api/tags')
  if(!Array.isArray(body.models))throw hostResponse('Ollama 模型清单格式不正确。')
  return body.models.map((item):OllamaTag=>{
   if(!isRecord(item)||typeof item.name!=='string'||!item.name||typeof item.size!=='number'||!Number.isFinite(item.size)||item.size<0||typeof item.digest!=='string'||!item.digest)throw hostResponse('Ollama 模型清单条目格式不正确。')
   const details=isRecord(item.details)?item.details:{}
   return {name:item.name,size:item.size,digest:normalizedDigest(item.digest),family:optionalText(details.family),parameterSize:optionalText(details.parameter_size),quantizationLevel:optionalText(details.quantization_level)}
  })
 }
 async ps(signal?:AbortSignal):Promise<OllamaRunningModel[]>{
  const body=await this.json('/api/ps',undefined,undefined,signal)
  if(!Array.isArray(body.models))throw hostResponse('Ollama 运行中清单格式不正确。')
  const names=new Set<string>()
  return body.models.map((item):OllamaRunningModel=>{
   if(!isRecord(item)||typeof item.name!=='string'||!item.name)throw hostResponse('Ollama 运行中条目格式不正确。')
   if(names.has(item.name)||item.context_length!==undefined&&(typeof item.context_length!=='number'||!Number.isSafeInteger(item.context_length)||item.context_length<=0)||item.digest!==undefined&&(typeof item.digest!=='string'||!item.digest))throw hostResponse('Ollama 运行容量格式不正确。')
   names.add(item.name)
   return {name:item.name,digest:item.digest===undefined?null:normalizedDigest(item.digest),contextLength:typeof item.context_length==='number'?item.context_length:null}
  })
 }
 /** 官方空 messages 只加载模型，不发送用户资料、不生成正文，也不覆写 num_ctx。 */
 async load(name:string,signal:AbortSignal):Promise<void>{
  const body=await this.json('/api/chat',{model:modelName(name),messages:[],stream:false},undefined,signal,this.deps.loadTimeoutMs??180_000).catch(error=>{
   if(error instanceof WorkError&&error.code==='teloa/dependency-unavailable')throw unavailable('Ollama 模型加载失败或超时，请检查运行状态和可用内存后重试。')
   throw error
  })
  if(body.done!==true)throw hostResponse('Ollama 尚未完成模型加载。')
 }
 async show(name:string):Promise<OllamaShow>{
  const body=await this.json('/api/show',{model:modelName(name)})
  const details=isRecord(body.details)?body.details:{},info=isRecord(body.model_info)?body.model_info:{}
  const contextKey=Object.keys(info).find(key=>key.endsWith('.context_length')),contextRaw=contextKey===undefined?undefined:info[contextKey]
  const contextLength=typeof contextRaw==='number'&&Number.isSafeInteger(contextRaw)&&contextRaw>0?contextRaw:null
  if(body.capabilities!==undefined&&(!Array.isArray(body.capabilities)||body.capabilities.some(item=>typeof item!=='string')))throw hostResponse('Ollama 模型能力字段格式不正确。')
  let thinking:OllamaThinking|undefined
  if(body.thinking!==undefined){
   const descriptor=body.thinking,valid=(value:unknown):value is boolean|string=>typeof value==='boolean'||typeof value==='string'&&value.length>0&&value.length<=64
   if(!isRecord(descriptor)||!Array.isArray(descriptor.values)||!descriptor.values.length||descriptor.values.length>16||!descriptor.values.every(valid)||new Set(descriptor.values).size!==descriptor.values.length||!valid(descriptor.default)||!descriptor.values.includes(descriptor.default))throw hostResponse('Ollama 模型思考能力格式不正确。')
   thinking={values:descriptor.values,default:descriptor.default}
  }
  return {family:optionalText(details.family),contextLength,capabilities:Array.isArray(body.capabilities)?body.capabilities as string[]:null,...(thinking?{thinking}:{})}
 }
 /**
 * 逐行读 NDJSON 进度；`timeoutMs` 只计到响应头，之后每成功解析出一行才重置空闲计时（缺省 60 s），
 * 超时或单行超过上限即断开：空闲超时抛 source-unavailable，行过长抛 invalid-host-response；外部 abort 原样以 AbortError 拒绝。
 */
 async pull(name:string,onProgress:(progress:OllamaPullProgress)=>void,signal:AbortSignal):Promise<void>{
  modelName(name)
  const inner=new AbortController();let idleTimedOut=false,idle:ReturnType<typeof setTimeout>|undefined
  const armIdle=()=>{if(idle)clearTimeout(idle);idle=setTimeout(()=>{idleTimedOut=true;inner.abort()},this.deps.pullIdleTimeoutMs??60_000)}
  const abort=()=>inner.abort(signal.reason)
  if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})
  const stalled=()=>new WorkError('teloa/source-unavailable','Ollama 拉取长时间没有进度，已断开。')
  const headersDeadline=setTimeout(()=>inner.abort(),this.deps.timeoutMs??3000)
  try{
   let response:Response
   try{response=await this.request('/api/pull',{body:{model:name,stream:true},signal:inner.signal})}finally{clearTimeout(headersDeadline)}
   if(!response.body)throw hostResponse('Ollama 拉取响应没有内容。')
   armIdle()
   const reader=response.body.getReader(),decoder=new TextDecoder();let buffered='',lastCompleted=0,lastTotal:number|null=null,succeeded=false
   const handle=(line:string)=>{
    if(Buffer.byteLength(line,'utf8')>MAX_PULL_LINE_BYTES)throw hostResponse('Ollama 拉取进度行过长。')
    if(!line.trim())return
    let row:unknown;try{row=JSON.parse(line)}catch{throw hostResponse('Ollama 拉取进度不是合法 JSON。')}
    if(!isRecord(row))throw hostResponse('Ollama 拉取进度格式不正确。')
    if(typeof row.error==='string')throw new WorkError('teloa/source-unavailable',`Ollama 拉取失败：${row.error.slice(0,500)}`)
    if(typeof row.status!=='string')throw hostResponse('Ollama 拉取进度缺少状态。')
    if(row.status==='success')succeeded=true
    // 状态行（verifying / success）不带字节数：沿用上一次进度，回调看到的 completed 不回退。
    if(typeof row.completed==='number'&&Number.isFinite(row.completed)&&row.completed>=0)lastCompleted=Math.max(lastCompleted,row.completed)
    if(typeof row.total==='number'&&Number.isFinite(row.total)&&row.total>0)lastTotal=row.total
    armIdle()
    onProgress({completed:lastCompleted,total:lastTotal,status:row.status})
   }
   try{
    for(;;){
     let chunk:ReadableStreamReadResult<Uint8Array>
     try{chunk=await reader.read()}catch(error){
      if(idleTimedOut)throw stalled()
      if(signal.aborted)throw signal.reason instanceof Error?signal.reason:error
      throw new WorkError('teloa/source-unavailable','Ollama 拉取连接中断。')
     }
     if(chunk.done)break
     buffered+=decoder.decode(chunk.value,{stream:true})
     const lines=buffered.split('\n');buffered=lines.pop()??''
     for(const line of lines)handle(line)
     if(Buffer.byteLength(buffered,'utf8')>MAX_PULL_LINE_BYTES)throw hostResponse('Ollama 拉取进度行过长。')
    }
    handle(buffered+decoder.decode())
    if(!succeeded)throw new WorkError('teloa/source-unavailable','Ollama 拉取尚未完成，连接已结束。')
   }finally{reader.cancel().catch(()=>{})}
  }catch(error){
   if(idleTimedOut&&!(error instanceof WorkError))throw stalled()
   if(error instanceof WorkError||signal.aborted)throw error
   throw unavailable('未检测到 Ollama：连接失败或超时。')
  }finally{if(idle)clearTimeout(idle);signal.removeEventListener('abort',abort);inner.abort()}
 }
 async remove(name:string):Promise<void>{
  await this.json('/api/delete',{model:modelName(name)},'DELETE')
 }

 /** 非流式接口：整请求（建连 + 头 + 体）在 `timeoutMs` 内完成，体不超过 MAX_JSON_BYTES；超时→dependency-unavailable，超长/非 JSON→invalid-host-response。 */
 private async json(path:OllamaPath,body?:unknown,method?:string,signal?:AbortSignal,timeoutMs=this.deps.timeoutMs??3000):Promise<Record<string,unknown>>{
  signal?.throwIfAborted()
  const controller=new AbortController(),abort=()=>controller.abort(signal?.reason),deadline=setTimeout(()=>controller.abort(),timeoutMs)
  signal?.addEventListener('abort',abort,{once:true})
  try{
   const response=await this.request(path,{...(method?{method}:{}),...(body===undefined?{}:{body}),signal:controller.signal})
   const text=await readBounded(response.body,MAX_JSON_BYTES)
   if(!text.trim())return {}
   let parsed:unknown;try{parsed=JSON.parse(text)}catch{throw hostResponse('Ollama 返回的内容不是合法 JSON。')}
   if(!isRecord(parsed))throw hostResponse('Ollama 返回的内容格式不正确。')
   return parsed
  }catch(error){
   signal?.throwIfAborted()
   if(error instanceof WorkError)throw error
   throw unavailable('未检测到 Ollama：连接失败或超时。')
  }finally{clearTimeout(deadline);signal?.removeEventListener('abort',abort);controller.abort()}
 }
 /** DNS 名每次解析并校验全部结果（任一落入拒绝网段即拒绝），返回可用于钉住建连的地址；IP 字面量回 null，直接连。 */
 private async target():Promise<{address:string;family:number}[]|null>{
  if(isIP(this.address.host))return null
  const lookup=this.deps.lookup??(host=>dnsLookup(host,{all:true}))
  const results=await lookup(this.address.host).catch(()=>{throw new WorkError('teloa/dependency-unavailable','无法解析 Ollama 地址。')})
  if(!results.length||results.some(r=>isIP(r.address)===0||isRefusedAddress(r.address)))throw new WorkError('teloa/forbidden','Ollama 地址解析到不允许的网段，已拒绝连接。')
  return results
 }
 /** 发一次固定路径请求，只负责建连与响应头；截止时间由调用方经 `signal` 控制（json() 整体计时、pull() 头/空闲分段计时）。非 2xx 时先释放响应体再抛错。 */
 private async request(path:OllamaPath,init:{method?:string;body?:unknown;signal:AbortSignal}):Promise<Response>{
  init.signal.throwIfAborted()
  const addresses=await abortable(this.target(),init.signal)
  init.signal.throwIfAborted()
  const url=new URL(path,this.address.baseURL).toString()
  const options:RequestInit={method:init.method??(init.body===undefined?'GET':'POST'),redirect:'error',signal:init.signal,headers:{Accept:'application/json',...(init.body===undefined?{}:{'Content-Type':'application/json'})},...(init.body===undefined?{}:{body:JSON.stringify(init.body)})}
  try{
   // DNS 名一律走钉住通道；注入的 fetch 只在 IP 字面量下生效（测试用）。
   const response=await (addresses!==null?pinnedFetch(url,options,addresses):(this.deps.fetch??fetch)(url,options))
   if(!response.ok){await response.body?.cancel().catch(()=>{});throw new OllamaHttpError(response.status)}
   return response
  }catch(error){
   if(error instanceof WorkError)throw error
   if(init.signal.aborted)throw error
   throw unavailable('未检测到 Ollama：连接失败或超时。')
  }
 }
}

/** 取消立即结束等待并消费迟到结果；底层排队或 DNS 操作在继续工作前还须核对 signal。 */
export async function abortable<T>(pending:Promise<T>,signal:AbortSignal):Promise<T>{
 let abort:()=>void=()=>{}
 try{
  return await Promise.race([pending,new Promise<never>((_resolve,reject)=>{
   abort=()=>reject(signal.reason)
   if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true})
  })])
 }finally{signal.removeEventListener('abort',abort)}
}

/**
 * 以 `http(s).request` 建连、`lookup` 只回刚校验过的地址：连接一定落在校验结果里，Host 头与 TLS SNI 仍是本人填写的主机名。
 * （全局 fetch 会丢弃自定义 Host 头，无法一边钉 IP 一边保留主机名。）不跟随跳转：3xx 原样回给调用方判为非 2xx。
 */
function pinnedFetch(url:string,init:RequestInit,addresses:{address:string;family:number}[]):Promise<Response>{
 const target=new URL(url),first=addresses[0]!
 const lookup=((_hostname:string,options:{all?:boolean},callback:(error:Error|null,...rest:unknown[])=>void)=>{
  if(options.all)callback(null,addresses.map(item=>({address:item.address,family:item.family})))
  else callback(null,first.address,first.family)
 }) as unknown as LookupFunction
 return new Promise<Response>((resolve,reject)=>{
  const req=(target.protocol==='https:'?httpsRequest:httpRequest)(target,{method:init.method,headers:init.headers as Record<string,string>,lookup,signal:init.signal??undefined},res=>{
   const status=res.statusCode??0
   if(status<200||status>599){res.destroy();reject(new Error(`unexpected status ${status}`));return}
   const headers=new Headers()
   for(const [key,value] of Object.entries(res.headers)){if(typeof value==='string')headers.set(key,value);else if(Array.isArray(value))for(const item of value)headers.append(key,item)}
   resolve(new Response(status===204||status===304?null:Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,{status,statusText:res.statusMessage??'',headers}))
  })
  req.on('error',reject)
  if(typeof init.body==='string')req.end(init.body);else req.end()
 })
}

/** 读完响应体并限长；超过上限即取消读取并抛 invalid-host-response。abort 会让 read() 拒绝，由调用方归为超时。 */
async function readBounded(body:ReadableStream<Uint8Array>|null,maxBytes:number):Promise<string>{
 if(!body)return ''
 const reader=body.getReader(),chunks:Uint8Array[]=[];let size=0
 try{
  for(;;){
   const {done,value}=await reader.read();if(done)break
   size+=value.byteLength
   if(size>maxBytes)throw hostResponse('Ollama 回包超过大小上限。')
   chunks.push(value)
  }
 }finally{reader.cancel().catch(()=>{})}
 return Buffer.concat(chunks).toString('utf8')
}
