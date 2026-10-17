import {WorkError} from '@teloa/contract'

export type ExperienceDocument={documentId:string;content:string;metadata:Record<string,string>}
export type ExperienceFact={id:string;text:string;type:'world'|'experience'|'observation';documentId?:string;sourceFactIds:string[]}
export type MemoryOperationState='pending'|'processing'|'completed'|'failed'|'cancelled'|'not_found'
export interface MemoryProvider{
 retain(bankId:string,operationId:string,documents:ExperienceDocument[],signal?:AbortSignal):Promise<void>
 operation(bankId:string,operationId:string,signal?:AbortSignal):Promise<MemoryOperationState>
 recall(bankId:string,query:string,signal?:AbortSignal):Promise<ExperienceFact[]>
}
export type HindsightMemoryOptions={endpoint:string;token?:string;timeoutMs?:number;allowHttp?:boolean;fetch?:typeof fetch}
const unavailable=()=>new WorkError('teloa/dependency-unavailable','经验记忆服务暂时不可用，当前任务仍可使用已确认的记忆。')
const record=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value))throw unavailable();return value as Record<string,unknown>}
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,256}$/.test(value)

/** 官方 v1 HTTP 边界；仅管理记忆协议，不持有 Teloa 的业务授权。 */
export class HindsightMemoryProvider implements MemoryProvider{
 private readonly base:URL;private readonly timeoutMs:number;private readonly token:string|undefined;private readonly transport:typeof fetch
 constructor(options:HindsightMemoryOptions){
  try{
   const url=new URL(options.endpoint),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname)
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.protocol==='http:'&&!local&&!options.allowHttp)throw Error()
   const timeout=options.timeoutMs??4000
   if(!Number.isSafeInteger(timeout)||timeout<1||timeout>60000||options.token!==undefined&&(!options.token.trim()||/[\r\n]/.test(options.token)))throw Error()
   url.pathname=url.pathname.replace(/\/$/,'')+'/'
   this.base=url;this.timeoutMs=timeout;this.token=options.token;this.transport=options.fetch??fetch
  }catch{throw new WorkError('teloa/invalid-input','经验记忆服务配置不正确；远端连接需使用 HTTPS。')}
 }
 private async request(bankId:string,path:string,body?:unknown,signal?:AbortSignal,notFoundOperation?:string):Promise<Record<string,unknown>>{
  if(!identifier(bankId))throw unavailable()
  signal?.throwIfAborted()
  const bounded=AbortSignal.any([AbortSignal.timeout(this.timeoutMs),...(signal?[signal]:[])])
  const encoded=body===undefined?undefined:JSON.stringify(body)
  if(encoded!==undefined&&Buffer.byteLength(encoded)>8*1024*1024)throw unavailable()
  const response=await this.transport(new URL(`v1/default/banks/${bankId}/${path}`,this.base),{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(this.token?{authorization:`Bearer ${this.token}`}:{})},...(encoded===undefined?{}:{body:encoded}),signal:bounded,redirect:'error'})
  if(response.status===404&&notFoundOperation){await response.body?.cancel();return {operation_id:notFoundOperation,status:'not_found'}}
  if(!response.ok||response.redirected){await response.body?.cancel();throw unavailable()}
  if(!response.body)throw unavailable()
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0
  try{
   while(true){bounded.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>1024*1024){await reader.cancel();throw unavailable()}chunks.push(next.value)}
   bounded.throwIfAborted()
   return record(JSON.parse(Buffer.concat(chunks).toString('utf8')))
  }catch{await reader.cancel().catch(()=>{});throw unavailable()}finally{reader.releaseLock()}
 }
 async retain(bankId:string,operationId:string,documents:ExperienceDocument[],signal?:AbortSignal):Promise<void>{
  if(!identifier(operationId))throw unavailable()
  const row=await this.request(bankId,'memories',{async:true,operation_id:operationId,items:documents.map(document=>({content:document.content,document_id:document.documentId,metadata:document.metadata,timestamp:'unset'}))},signal)
  if(row.success!==true||row.bank_id!==bankId||row.async!==true||row.operation_id!==operationId||row.items_count!==documents.length)throw unavailable()
 }
 async operation(bankId:string,operationId:string,signal?:AbortSignal):Promise<MemoryOperationState>{
  if(!identifier(operationId))throw unavailable()
  const row=await this.request(bankId,`operations/${operationId}`,undefined,signal,operationId)
  if(row.operation_id!==operationId||!['pending','processing','completed','failed','cancelled','not_found'].includes(String(row.status)))throw unavailable()
  return row.status as MemoryOperationState
 }
 async recall(bankId:string,query:string,signal?:AbortSignal):Promise<ExperienceFact[]>{
  if(typeof query!=='string'||!query.trim()||query.length>8000)throw unavailable()
  const row=await this.request(bankId,'memories/recall',{query,budget:'low',max_tokens:2048,types:['world','experience','observation']},signal)
  if(!Array.isArray(row.results)||row.results.length>256)throw unavailable()
  return row.results.map(value=>{
   const fact=record(value)
   if(!identifier(fact.id)||typeof fact.text!=='string'||!fact.text.trim()||fact.text.length>65536||!['world','experience','observation'].includes(String(fact.type))||fact.document_id!==undefined&&fact.document_id!==null&&!identifier(fact.document_id))throw unavailable()
   const sources=fact.source_fact_ids??[]
   if(!Array.isArray(sources)||sources.length>256||sources.some(id=>!identifier(id)))throw unavailable()
   return {id:fact.id,text:fact.text,type:fact.type as ExperienceFact['type'],...(typeof fact.document_id==='string'?{documentId:fact.document_id}:{}),sourceFactIds:sources as string[]}
  })
 }
}
