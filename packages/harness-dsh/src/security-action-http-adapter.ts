import {WorkError,isRecord,type SecurityActionDispatch,type SecurityExecutionReceipt} from '@teloa/contract'
import type {SecurityActionAdapter} from './security-action-execution.ts'

export type SecurityActionHttpOptions={
 baseUrl?:string
 token?:string
 fetch?:typeof globalThis.fetch
 timeouts?:{headersMs:number;idleMs:number;totalMs:number}
}
const idempotency=Object.freeze({schema:'teloa.security-action-idempotency/v1',key:'operationId',persistence:'durable',sameRequest:'same-operation',differentRequest:'conflict'} as const)
const maxBytes=64*1024
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value&&value===value.trim()&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-host-response','安全执行服务回包不符合固定协议。')
const unavailable=()=>new WorkError('teloa/dependency-unavailable','安全执行连接未配置或暂不可用；请保留原操作身份核对。')
const invalidInput=()=>new WorkError('teloa/invalid-input','安全动作派发身份或内容不正确。')
function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value
}
function targets(value:unknown):value is string[]{return Array.isArray(value)&&value.length>0&&value.length<=256&&value.every(item=>text(item,512))&&new Set(value).size===value.length}
function canonical(value:unknown,seen=new Set<object>()):string{
 if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value)
 if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value)
 if(typeof value!=='object'||value===null||seen.has(value))throw invalidInput()
 seen.add(value)
 try{
  if(Array.isArray(value))return `[${Array.from(value,item=>canonical(item,seen)).join(',')}]`
  if(Object.getPrototypeOf(value)!==Object.prototype&&Object.getPrototypeOf(value)!==null)throw invalidInput()
  return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(Reflect.get(value,key),seen)}`).join(',')}}`
 }finally{seen.delete(value)}
}

/** 无状态传输边界。运行时只核验自报能力；持久行为必须通过同目标版本的部署 conformance。 */
export class SecurityActionHttpAdapter implements SecurityActionAdapter{
 readonly tool='security.endpoint.isolate'
 readonly idempotency=idempotency
 readonly #options:SecurityActionHttpOptions
 constructor(options:SecurityActionHttpOptions={}){this.#options={...options,...(options.timeouts?{timeouts:{...options.timeouts}}:{})}}
 private configuration(){
  const {baseUrl,token}=this.#options
  if(typeof baseUrl!=='string'||!baseUrl||baseUrl!==baseUrl.trim()||/[\x00-\x20\x7f\\?#]/.test(baseUrl)||typeof token!=='string'||!token||!/^[A-Za-z0-9._~+\/-]+=*$/.test(token))throw unavailable()
  let url:URL
  try{url=new URL(baseUrl)}catch{throw unavailable()}
  const authority=/^[a-z]+:\/\/([^/]+)/i.exec(baseUrl)?.[1]
  if(!authority||authority.includes('@')||url.username||url.password||url.search||url.hash||!url.hostname)throw unavailable()
  if(url.protocol!=='https:'&&(url.protocol!=='http:'||!(/^(127\.0\.0\.1|\[::1\])(:[0-9]+)?$/.test(authority))))throw unavailable()
  const timeouts=this.#options.timeouts??{headersMs:5000,idleMs:5000,totalMs:15000}
  if(Object.values(timeouts).length!==3||Object.values(timeouts).some(ms=>!Number.isSafeInteger(ms)||ms<=0||ms>2147483647))throw unavailable()
  return {baseUrl:url.href.replace(/\/+$/,''),token,timeouts,fetch:this.#options.fetch??globalThis.fetch}
 }
 async ready(signal:AbortSignal):Promise<{ready:true}|{ready:false;reason:string}>{
  signal.throwIfAborted()
  try{
   const response=await this.request('GET','/capabilities',signal)
   const value=exact(response.body,['schema','idempotency']),declaration=exact(value.idempotency,['key','persistence','sameRequest','differentRequest'])
   if(value.schema!=='teloa.security-action-capabilities/v1'||declaration.key!=='operationId'||declaration.persistence!=='durable'||declaration.sameRequest!=='same-operation'||declaration.differentRequest!=='conflict')throw invalid()
   return {ready:true}
  }catch{signal.throwIfAborted();return {ready:false,reason:'安全执行配置或目标持久幂等能力尚未核验通过。'}}
 }
 async execute(dispatch:SecurityActionDispatch,signal:AbortSignal):Promise<SecurityExecutionReceipt>{
  signal.throwIfAborted()
  this.configuration()
  let body:string
  try{
   exact(dispatch,['operationId','actionId','tool','playbookVersion','targets','params'])
   if(!uuid(dispatch.operationId)||!uuid(dispatch.actionId)||dispatch.tool!==this.tool||!text(dispatch.playbookVersion,256)||!targets(dispatch.targets)||!isRecord(dispatch.params))throw invalidInput()
   body=canonical(dispatch)
  }catch{throw invalidInput()}
  const expected={operationId:dispatch.operationId,actionId:dispatch.actionId,targets:[...dispatch.targets]}
  const response=await this.request('POST','',signal,{body,operationId:expected.operationId})
  return this.receipt(response.body,expected,response.status,'POST')
 }
 async observe(input:{operationId:string;actionId:string;targets:string[]},signal:AbortSignal):Promise<SecurityExecutionReceipt|null>{
  signal.throwIfAborted()
  if(!input||!uuid(input.operationId)||!uuid(input.actionId)||!targets(input.targets))throw invalidInput()
  const expected={operationId:input.operationId,actionId:input.actionId,targets:[...input.targets]}
  const response=await this.request('GET',`/operations/${expected.operationId}`,signal)
  return response.status===404?null:this.receipt(response.body,expected,response.status,'GET')
 }
 private receipt(value:unknown,expected:{operationId:string;actionId:string;targets:string[]},httpStatus:number,method:'GET'|'POST'):SecurityExecutionReceipt{
  const row=exact(value,['operationId','actionId','receiptId','state','detail','targets','observedAt'])
  if(row.operationId!==expected.operationId||row.actionId!==expected.actionId||!text(row.receiptId,256)||!text(row.detail,4000)||typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt))||new Date(row.observedAt).toISOString()!==row.observedAt||typeof row.state!=='string'||!['accepted','succeeded','failed'].includes(row.state)||!Array.isArray(row.targets)||row.targets.length!==expected.targets.length)throw invalid()
  const result=row.targets.map(item=>{const target=exact(item,['id','state']);if(!text(target.id,512)||!expected.targets.includes(target.id)||typeof target.state!=='string'||!['unknown','succeeded','failed'].includes(target.state))throw invalid();return {target:target.id,state:target.state as 'unknown'|'succeeded'|'failed'}})
  if(new Set(result.map(item=>item.target)).size!==result.length||row.state==='accepted'&&!result.every(item=>item.state==='unknown')||row.state==='succeeded'&&!result.every(item=>item.state==='succeeded')||row.state==='failed'&&!result.some(item=>item.state==='failed')||method==='POST'&&(httpStatus===202?row.state!=='accepted':row.state==='accepted'))throw invalid()
  return {receiptId:row.receiptId,status:row.state as SecurityExecutionReceipt['status'],detail:row.detail,observedAt:row.observedAt,targets:result}
 }
 private async request(method:'GET'|'POST',path:string,signal:AbortSignal,post?:{body:string;operationId:string}):Promise<{status:number;body:unknown}>{
  signal.throwIfAborted()
  const config=this.configuration(),controller=new AbortController()
  if(post?.body.includes(config.token))throw invalidInput()
  const abort=()=>controller.abort()
  signal.addEventListener('abort',abort,{once:true})
  const total=setTimeout(abort,config.timeouts.totalMs)
  let phase:ReturnType<typeof setTimeout>|undefined
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined
  const arm=(ms:number)=>{clearTimeout(phase);phase=setTimeout(abort,ms)}
  const bounded=async<T>(promise:Promise<T>):Promise<T>=>{
   let rejectAbort!:()=>void
   const aborted=new Promise<never>((_resolve,reject)=>{rejectAbort=()=>reject(unavailable());controller.signal.addEventListener('abort',rejectAbort,{once:true});if(controller.signal.aborted)rejectAbort()})
   try{return await Promise.race([promise.catch(()=>{throw unavailable()}),aborted])}finally{controller.signal.removeEventListener('abort',rejectAbort)}
  }
  try{
   arm(config.timeouts.headersMs)
   const response=await bounded(Promise.resolve().then(()=>config.fetch(`${config.baseUrl}/v1/security-actions${path}`,{method,redirect:'error',signal:controller.signal,headers:{Authorization:`Bearer ${config.token}`,Accept:'application/json',...(post?{'Content-Type':'application/json','Idempotency-Key':post.operationId}:{})},...(post?{body:post.body}:{})})))
   clearTimeout(phase)
   reader=response.body?.getReader()
   if(response.redirected||response.status>=300&&response.status<400)throw invalid()
   if(method==='GET'&&path.startsWith('/operations/')&&response.status===404)return {status:404,body:null}
   if(method==='POST'&&response.status===409)throw new WorkError('teloa/conflict','原操作身份已绑定不同派发内容。')
   if([401,403,429].includes(response.status)||response.status>=500)throw unavailable()
   if(response.status!==200&&!(method==='POST'&&response.status===202))throw invalid()
   const declared=response.headers.get('content-length')
   if(declared!==null&&(!/^(0|[1-9][0-9]*)$/.test(declared)||Number(declared)>maxBytes))throw invalid()
   if(!reader)throw invalid()
   const chunks:Uint8Array[]=[],decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true});let size=0
   while(true){arm(config.timeouts.idleMs);const next=await bounded(reader.read());clearTimeout(phase);if(next.done)break;size+=next.value.byteLength;if(size>maxBytes)throw invalid();chunks.push(next.value)}
   if(!size||declared!==null&&size!==Number(declared))throw invalid()
   const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
   let body:unknown
   try{const raw=decoder.decode(bytes);if(raw.includes(config.token))throw invalid();body=JSON.parse(raw);if(JSON.stringify(body).includes(config.token))throw invalid()}catch{throw invalid()}
   signal.throwIfAborted()
   return {status:response.status,body}
  }catch(error){
   signal.throwIfAborted()
   if(error instanceof WorkError)throw error
   // 禁止透传 fetch/解析异常及 cause：远端可能在其中反射 Authorization。
   throw unavailable()
  }finally{
   clearTimeout(total);clearTimeout(phase);signal.removeEventListener('abort',abort);controller.abort()
   if(reader)void reader.cancel().catch(()=>{})
  }
 }
}
