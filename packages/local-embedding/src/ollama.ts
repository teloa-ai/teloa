import {totalmem} from 'node:os'
import {WorkError,type EmbeddingPreparationState,type RetrievalPreparationDetails} from '@teloa/contract'
import {AssetDownloadError} from './assets.ts'
import {embeddingDimensions} from './pooling.ts'
import {embeddingConfigurationHash} from './profile.ts'
import {createEmbeddingProvider,type EmbeddingEngine} from './service.ts'

export const embeddingGemma2ProviderId='embeddinggemma-2'
export const embeddingGemma2CatalogId='teloa.model.embeddinggemma-2'
export const embeddingGemma2CatalogVersion='1.0.0'
export const embeddingGemma2Model='embeddinggemma-2:latest'
export const embeddingGemma2MinimumOllama='0.40.0'
/** 2026-10-08 官方 registry manifest 原始字节的 SHA-256；不是张量层或 GGUF 摘要。 */
export const embeddingGemma2Digest='sha256:969600645b5240cbf78f46456c819f38bea9f59c3e34a2993a0ae54334e3db04'
const modelBytes=1325205612
const modelSource='registry.ollama.ai'
const resource='embeddinggemma-2'
/** 只识别已知原因，不把下载地址、IP 或原始运行时错误返回界面。 */
const pullFailureReason=(error:unknown)=>typeof error!=='string'?'unknown' as const:/newer version of Ollama/i.test(error)?'runtime-version' as const:/requires MLX|MLX runtime is not available/i.test(error)?'runtime-unsupported' as const:/non-public|network|dial tcp|no such host|connection|timeout/i.test(error)?'network' as const:'unknown' as const
const defaultEndpoint='http://127.0.0.1:11434'
const nativeDimensions=768
export const embeddingGemma2Profile=Object.freeze({
 catalogId:embeddingGemma2CatalogId,catalogVersion:embeddingGemma2CatalogVersion,variant:'ollama',
 model:embeddingGemma2Model,modelDigest:embeddingGemma2Digest,nativeDimensions,storageDimensions:embeddingDimensions,
 storageAdapter:'zero-pad',pooling:'mean',normalize:'l2',maxTokens:8192,truncate:false,
 queryInstruction:'task: search result | query: ',documentPrefix:'title: none | text: ',
} as const)
export function embeddingGemma2ProfileHash(profile:Record<string,unknown>=embeddingGemma2Profile):string{
 return embeddingConfigurationHash(profile)
}

/** 只接受本机数字回环地址；不读取 OLLAMA_HOST、项目环境变量或远程服务配置。 */
function localEndpoint(value:string):string{
 let url:URL
 try{url=new URL(value)}catch{throw new WorkError('teloa/invalid-input','Ollama 必须使用本机 HTTP 回环地址。')}
 if(url.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(url.hostname)||url.username||url.password||url.pathname!=='/'||url.search||url.hash)
  throw new WorkError('teloa/invalid-input','Ollama 必须使用本机 HTTP 回环地址，且不能包含凭据、路径或查询参数。')
 return url.origin
}

export function ollamaPreparationDetails(endpoint=defaultEndpoint):RetrievalPreparationDetails{
 return {
  kind:'ollama',modelName:'EmbeddingGemma 2',license:'Apache-2.0',upstreamRepo:'https://huggingface.co/google/embeddinggemma-2',
  runtime:{name:'Ollama',endpoint:localEndpoint(endpoint),managed:false,minimumVersion:embeddingGemma2MinimumOllama},
  model:{name:embeddingGemma2Model,source:modelSource,digest:embeddingGemma2Digest,bytes:modelBytes},
  nativeDimensions,storageDimensions:embeddingDimensions,downloadSources:[{id:'official',host:modelSource}],
 }
}

export type OllamaEmbeddingOptions={
 /** 仅供宿主与隔离验收选本机端口，始终受回环地址校验。 */
 endpoint?:string
 fetch?:typeof globalThis.fetch
 totalMemoryBytes?:number
 onChange?:(state:EmbeddingPreparationState)=>void
 prepareTimeoutMs?:number
 inferenceTimeoutMs?:number
}

/** Ollama 不受管安装、不自动启动；显式 prepare 才拉取，摘要一致后才可推理。 */
export function createOllamaEmbeddingProvider(options:OllamaEmbeddingOptions={}){
 const endpoint=localEndpoint(options.endpoint??defaultEndpoint)
 const request=options.fetch??globalThis.fetch
 const api=async(path:string,signal:AbortSignal,body?:unknown)=>{
  const response=await request(endpoint+path,{method:body===undefined?'GET':'POST',...(body===undefined?{}:{headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal,redirect:'error'})
  if(!response.ok){if(path==='/api/pull'){if(response.status===412){await response.body?.cancel();throw new AssetDownloadError(resource,modelSource,'runtime-version','请更新 Ollama 后重试。')}const failure=await readJson(response).catch(()=>undefined);const reason=pullFailureReason(typeof failure==='object'&&failure!==null?Reflect.get(failure,'error'):undefined);throw new AssetDownloadError(resource,modelSource,reason,'模型下载失败，请重试或选择其他检索模型。')}await response.body?.cancel();throw new WorkError('teloa/dependency-unavailable',`本机 Ollama 请求失败（HTTP ${response.status}），请确认服务可用后重试。`)}
  return response
 }
 const readJson=async(response:Response):Promise<unknown>=>{
  const reader=response.body?.getReader()
  if(!reader)throw new Error('Ollama 响应为空')
  const decoder=new TextDecoder();let bytes=0,text=''
  try{
   while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.byteLength;if(bytes>4*1024**2)throw new Error('Ollama 响应过大');text+=decoder.decode(next.value,{stream:true})}
   return JSON.parse(text+decoder.decode())
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 }
 const runtimeCheck=async(signal:AbortSignal=AbortSignal.timeout(5000))=>{
  try{
   const value=await readJson(await api('/api/version',signal))
   return typeof value==='object'&&value!==null&&typeof Reflect.get(value,'version')==='string'
  }catch{return false}
 }
 const inspect=async(signal:AbortSignal=AbortSignal.timeout(5000))=>{
  const value=await readJson(await api('/api/tags',signal))
  if(typeof value!=='object'||value===null||!Array.isArray(Reflect.get(value,'models')))throw new Error('Ollama 模型列表格式不正确')
  const models=Reflect.get(value,'models') as unknown[]
  const model=models.find(row=>typeof row==='object'&&row!==null&&(Reflect.get(row,'name')===embeddingGemma2Model||Reflect.get(row,'model')===embeddingGemma2Model))
  if(!model)return 'missing' as const
  const digest=Reflect.get(model as object,'digest')
  return digest===embeddingGemma2Digest||digest===embeddingGemma2Digest.slice(7)?'complete' as const:'missing' as const
 }
 const assertRuntime=async(signal:AbortSignal)=>{
  const value=await readJson(await api('/api/version',signal))
  const version=typeof value==='object'&&value!==null?Reflect.get(value,'version'):undefined
  const parts=typeof version==='string'?/^(\d+)\.(\d+)\.(\d+)$/.exec(version):null
  if(!parts||!(Number(parts[1])>0||Number(parts[2])>=40))throw new AssetDownloadError(resource,modelSource,'runtime-version','请更新到 Ollama 0.40.0 或更高版本后重试。')
 }
 const assertModel=async(signal:AbortSignal)=>{
  if(await inspect(signal)!=='complete')throw new AssetDownloadError(resource,modelSource,'integrity','模型摘要与固定版本不符，请重新准备。')
 }
 const prepare=async(signal:AbortSignal,onProgress:(state:{resource:string;completedBytes:number;totalBytes:number})=>void,source:string)=>{
  if(source!=='official')throw new WorkError('teloa/invalid-input','EmbeddingGemma 2 仅支持 Ollama 官方下载来源。')
  if(await inspect(signal)==='complete')return
  let response:Response
  try{response=await api('/api/pull',signal,{model:embeddingGemma2Model,stream:true})}
  catch(error){if(signal.aborted||error instanceof AssetDownloadError)throw error;throw new AssetDownloadError(resource,modelSource,'network','Ollama 无法开始模型下载，请检查本机服务和网络后重试。')}
  const reader=response.body?.getReader()
  if(!reader)throw new AssetDownloadError(resource,modelSource,'unknown','Ollama 未返回下载进度。')
  const decoder=new TextDecoder(),layers=new Map<string,number>();let buffer='',success=false
  const line=(text:string)=>{
   if(!text.trim())return
   if(text.length>65536)throw new Error('Ollama 下载进度过大')
   const value=JSON.parse(text) as Record<string,unknown>
   if(value.error!==undefined)throw new AssetDownloadError(resource,modelSource,pullFailureReason(value.error),'Ollama 模型下载失败，请检查网络、存储空间和服务版本后重试。')
   if(value.status==='success')success=true
   if(value.digest!==undefined&&value.total!==undefined){
    const completed=value.completed??0
    if(typeof value.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(value.digest)||typeof value.total!=='number'||!Number.isSafeInteger(value.total)||value.total<0||typeof completed!=='number'||!Number.isSafeInteger(completed)||completed<0||completed>value.total)throw new Error('Ollama 下载进度格式不正确')
    layers.set(value.digest,completed)
    const completedBytes=[...layers.values()].reduce((sum,bytes)=>sum+bytes,0)
    if(completedBytes>modelBytes)throw new AssetDownloadError(resource,modelSource,'integrity','下载容量与固定模型不符，请刷新模型版本后重试。')
    onProgress({resource,completedBytes,totalBytes:modelBytes})
   }
  }
  try{
   while(true){
    signal.throwIfAborted()
    const next=await reader.read();if(next.done)break
    buffer+=decoder.decode(next.value,{stream:true})
    let end:number
    while((end=buffer.indexOf('\n'))!==-1){line(buffer.slice(0,end));buffer=buffer.slice(end+1)}
    if(buffer.length>65536)throw new Error('Ollama 下载进度过大')
   }
   buffer+=decoder.decode();line(buffer)
   signal.throwIfAborted()
   if(!success)throw new AssetDownloadError(resource,modelSource,'unknown','Ollama 下载未完成，请重新准备。')
   await assertModel(signal)
   onProgress({resource,completedBytes:modelBytes,totalBytes:modelBytes})
  }catch(error){
   if(signal.aborted||error instanceof AssetDownloadError||error instanceof WorkError)throw error
   throw new AssetDownloadError(resource,modelSource,'unknown','Ollama 下载响应未完成或格式不正确，请重新准备。')
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 }
 const startEngine=async(signal:AbortSignal):Promise<EmbeddingEngine>=>{
  await assertRuntime(signal)
  await assertModel(signal)
  const lifetime=new AbortController()
  let finish!:()=>void
  const exited=new Promise<void>(resolve=>{finish=resolve})
  const active=new Set<Promise<unknown>>()
  return {
   exited,
   embed(kind,texts,signal){
    const run=(async()=>{
     const combined=AbortSignal.any([signal,lifetime.signal])
     await assertModel(combined)
     const input=texts.map(text=>(kind==='query'?embeddingGemma2Profile.queryInstruction:embeddingGemma2Profile.documentPrefix)+text)
     const value=await readJson(await api('/api/embed',combined,{model:embeddingGemma2Model,input,dimensions:nativeDimensions,truncate:false,keep_alive:'5m'}))
     // latest 是可变标签：请求期间被其他客户端替换时也不能提交到旧配置的索引。
     await assertModel(combined)
     if(typeof value!=='object'||value===null)throw new Error('Ollama 嵌入响应格式不正确')
     if(Reflect.get(value,'model')!==embeddingGemma2Model)throw new Error('Ollama 嵌入响应模型不一致')
     const vectors=Reflect.get(value,'embeddings') as unknown
     if(!Array.isArray(vectors)||vectors.length!==texts.length)throw new Error('Ollama 嵌入响应数量不正确')
     return {vectors:vectors.map(vector=>{
      if(!Array.isArray(vector)||vector.length!==nativeDimensions||vector.some(value=>typeof value!=='number'||!Number.isFinite(value)))throw new Error('Ollama 嵌入响应维度不正确')
      const norm=Math.sqrt(vector.reduce((sum,value)=>sum+value*value,0))
      if(!Number.isFinite(norm)||norm===0)throw new Error('Ollama 嵌入响应不能归一化')
      const padded=new Float32Array(embeddingDimensions)
      for(let i=0;i<nativeDimensions;i++)padded[i]=vector[i]/norm
      return padded
     }),truncated:0}
    })()
    active.add(run);void run.finally(()=>active.delete(run)).catch(()=>{})
    return run
   },
   async close(){lifetime.abort(new Error('Ollama 检索请求已回收'));await Promise.allSettled([...active]);finish()},
  }
 }
 return createEmbeddingProvider({
  id:embeddingGemma2ProviderId,catalogId:embeddingGemma2CatalogId,catalogVersion:embeddingGemma2CatalogVersion,
  variant:'ollama',profileHash:embeddingGemma2ProfileHash(),preparationDetails:ollamaPreparationDetails(endpoint),
  runtime:{resource:'ollama',source:'127.0.0.1',managed:false,check:()=>runtimeCheck(),install:async signal=>{
   if(!await runtimeCheck(signal))throw new WorkError('teloa/dependency-unavailable','本机 Ollama 服务尚未就绪，请先打开 Ollama，再重新准备模型。')
   await assertRuntime(signal!)
   return endpoint
  }},
  assets:{resource,inspect:()=>inspect().catch(()=>'missing' as const),prepare},
  verifyPreparedEngine:async(engine,signal)=>{
   try{await engine.embed('query',['Teloa'],AbortSignal.any([signal,AbortSignal.timeout(options.inferenceTimeoutMs??120_000)]))}
   catch(error){
    if(signal.aborted)throw error
    throw new WorkError('teloa/dependency-unavailable','本机 Ollama 尚不能运行 EmbeddingGemma 2，请检查 Ollama 版本及模型后重新准备。')
   }
  },
  startEngine,idleTimeoutMs:5*60_000,totalMemoryBytes:options.totalMemoryBytes??totalmem(),
  ...(options.prepareTimeoutMs===undefined?{}:{prepareTimeoutMs:options.prepareTimeoutMs}),
  ...(options.inferenceTimeoutMs===undefined?{}:{inferenceTimeoutMs:options.inferenceTimeoutMs}),
  ...(options.onChange===undefined?{}:{onChange:options.onChange}),
 })
}
