import {WorkError,embeddingMemoryRisk,type EmbeddingDownloadSource,type EmbeddingPreparationState,type RetrievalPreparationDetails} from '@teloa/contract'
import {managedInstallErrorCode} from '@teloa/harness-dsh/managed-package-install'
import {AssetDownloadError,type EmbeddingVariant} from './assets.ts'
import {embeddingDimensions} from './pooling.ts'

export type EmbeddingKind='query'|'passage'
export type EmbeddingInput={kind:EmbeddingKind;texts:string[]}
/** 一个已加载模型的推理子进程（宿主拥有其生命周期）。 */
export type EmbeddingEngine={
 embed(kind:EmbeddingKind,texts:string[],signal:AbortSignal):Promise<{vectors:Float32Array[];truncated:number}>
 /** 终止子进程并等待其进程范围退出。 */
 close():Promise<void>
 /** 子进程退出（含崩溃）时 resolve。 */
 exited:Promise<unknown>
}
export type EmbeddingProviderOptions={
 preparationDetails?:RetrievalPreparationDetails
 id:string;catalogId:string;catalogVersion:string;variant:EmbeddingVariant;profileHash:string
 /** 运行时阶段：check 只核对，install 经受管安装（不可中途终止，取消时不再等待其结果）。 */
 runtime:{resource:string;source:string;check():Promise<boolean>;install():Promise<string>}
 /** resource：工件阶段开始时（尚无字节进度，例如复核已在位的文件）显示的首个文件；source：本次准备的下载来源。 */
 assets:{resource:string;inspect():Promise<'complete'|'missing'>;prepare(signal:AbortSignal,onProgress:(state:{resource:string;completedBytes:number;totalBytes:number})=>void,source:EmbeddingDownloadSource):Promise<void>}
 startEngine(signal:AbortSignal):Promise<EmbeddingEngine>
 idleTimeoutMs:number
 /** 宿主物理内存：快照据此给出 memoryRisk（≤ 8 GiB 且 fp32），准备确认卡与设置页提示内存风险。 */
 totalMemoryBytes:number
 maxPending?:number;maxTexts?:number
 prepareTimeoutMs?:number;loadTimeoutMs?:number;inferenceTimeoutMs?:number
 now?:()=>number
 onChange?:(state:EmbeddingPreparationState)=>void
}

const unavailable=()=>new WorkError('teloa/dependency-unavailable','本地检索模型未准备，请在市场·模型中确认准备。')
const cancelled=()=>new WorkError('teloa/cancelled','本地检索请求已取消。')

/** 与原生语音 provider 同形的准备状态机与串行推理队列（规格 §4.5、§5.2）。 */
export function createEmbeddingProvider(options:EmbeddingProviderOptions){
 const now=options.now??Date.now
 const maxPending=options.maxPending??8,maxTexts=options.maxTexts??32
 const lifetime=new AbortController()
 let state:EmbeddingPreparationState={phase:'checking',startedAt:now()}
 const publish=(next:EmbeddingPreparationState)=>{state=next;options.onChange?.(next)}
 options.onChange?.(state)
 let engine:EmbeddingEngine|undefined
 let idle:ReturnType<typeof setTimeout>|undefined
 let preparing:{controller:AbortController;done:Promise<void>;published:boolean}|undefined
 let tail:Promise<unknown>=Promise.resolve()
 let pending=0,truncatedTexts=0

 const healthy=async()=>{
  const [runtime,assets]=await Promise.all([options.runtime.check(),options.assets.inspect()])
  return runtime&&assets==='complete'
 }
 // 启用只检查：运行时目录与模型缓存都完整即 standby，不下载、不安装、不加载。
 const inspected=healthy().then(ok=>{if(state.phase==='checking')publish({phase:ok?'standby':'unprepared'})},()=>{
  if(state.phase==='checking')publish({phase:'failed',message:'检查本地检索模型缓存失败，请确认缓存目录可读后重试。'})
 })

 const clearIdle=()=>{if(idle!==undefined)clearTimeout(idle);idle=undefined}
 const recycle=async()=>{
  const current=engine
  engine=undefined
  clearIdle()
  if(current)await current.close().catch(()=>{})
  if(state.phase==='ready'||state.phase==='loading')publish({phase:'standby'})
 }
 const armIdle=()=>{
  clearIdle()
  if(options.idleTimeoutMs<=0)return
  idle=setTimeout(()=>{if(pending===0)void recycle()},options.idleTimeoutMs)
  idle.unref?.()
 }
 const attach=(next:EmbeddingEngine)=>{
  engine=next
  // 崩溃恢复：进程意外退出后回到 standby，下次 embed 重新唤醒。
  void next.exited.then(()=>{if(engine===next){engine=undefined;clearIdle();if(state.phase==='ready')publish({phase:'standby'})}})
 }
 const until=<T>(promise:Promise<T>,signal:AbortSignal)=>new Promise<T>((resolve,reject)=>{
  signal.throwIfAborted()
  const abort=()=>reject(signal.reason)
  signal.addEventListener('abort',abort,{once:true})
  promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort))
 })
 const failed=(error:unknown,timedOut:boolean):EmbeddingPreparationState=>{
  if(error instanceof AssetDownloadError)return {phase:'failed',message:error.message.slice(0,500),download:{resource:error.resource,source:error.source,reason:error.reason}}
  const install=managedInstallErrorCode(error)
  if(install||(error instanceof WorkError&&error.code==='teloa/forbidden'))return {phase:'failed',message:(error as WorkError).message.slice(0,500),download:{resource:options.runtime.resource,source:options.runtime.source,reason:install==='install-timeout'?'timeout':install===undefined?'integrity':'unknown'}}
  if(timedOut)return {phase:'failed',message:'准备超过时限，已中止；请检查网络后重试。'}
  return {phase:'failed',message:'加载本地检索模型失败，请重新准备。'}
 }

 /** 来源只作用于本次准备，不保存；缺省官方。 */
 const prepare=(request:{source?:EmbeddingDownloadSource}={})=>{
  if(preparing||state.phase==='ready'||state.phase==='standby')return
  const controller=new AbortController()
  const deadline=AbortSignal.timeout(options.prepareTimeoutMs??2*60*60_000)
  const signal=AbortSignal.any([controller.signal,lifetime.signal,deadline])
  const task={controller,published:false,done:Promise.resolve()}
  task.done=(async()=>{
   await inspected
   if(state.phase==='ready'||state.phase==='standby')return
   try{
    // 先运行时后工件（关键决定 2）；npm 安装不能中途终止，取消后不再等待它，装完的目录下次核对后直接复用。
    publish({phase:'downloading',stage:'runtime',resource:options.runtime.resource,completedBytes:0})
    await until(options.runtime.install(),signal)
    publish({phase:'downloading',stage:'assets',resource:options.assets.resource,completedBytes:0})
    await options.assets.prepare(signal,progress=>{if(!signal.aborted)publish({phase:'downloading',stage:'assets',...progress})},request.source??'official')
    publish({phase:'loading',startedAt:now()})
    const next=await options.startEngine(signal)
    if(signal.aborted){await next.close();signal.throwIfAborted()}
    attach(next)
    task.published=true
    publish({phase:'ready'})
    armIdle()
   }catch(error){
    if(controller.signal.aborted||lifetime.signal.aborted)publish({phase:'cancelled'})
    else publish(failed(error,deadline.aborted))
   }
  })().finally(()=>{if(preparing===task)preparing=undefined})
  preparing=task
 }

 const cancelPreparation=async()=>{
  const task=preparing
  if(!task)return
  // 结果已发布：只等任务收尾，不覆盖。
  if(!task.published){publish({phase:'cancelling',startedAt:now()});task.controller.abort(new Error('准备已取消'))}
  await task.done
 }

 const run=async(input:EmbeddingInput,signal:AbortSignal)=>{
  if(state.phase!=='ready'&&state.phase!=='standby')throw unavailable()
  clearIdle()
  try{
   if(!engine){
    publish({phase:'loading',startedAt:now()})
    attach(await options.startEngine(AbortSignal.any([signal,lifetime.signal,AbortSignal.timeout(options.loadTimeoutMs??120_000)])))
    publish({phase:'ready'})
   }
   const result=await engine!.embed(input.kind,input.texts,AbortSignal.any([signal,lifetime.signal,AbortSignal.timeout(options.inferenceTimeoutMs??120_000)]))
   if(result.vectors.length!==input.texts.length||result.vectors.some(vector=>!(vector instanceof Float32Array)||vector.length!==embeddingDimensions))throw new Error('推理响应格式不正确')
   truncatedTexts+=result.truncated
   armIdle()
   return {profileHash:options.profileHash,vectors:result.vectors}
  }catch(error){
   await recycle()
   // 缓存或运行时在待命期间被破坏：回到未准备，由本人重新确认准备。
   if(!(await healthy().catch(()=>false))&&(state.phase==='standby'))publish({phase:'unprepared'})
   if(signal.aborted)throw cancelled()
   throw new WorkError('teloa/dependency-unavailable','本地检索推理失败，已回收推理进程，请重试。')
  }
 }

 const embed=(input:EmbeddingInput,signal:AbortSignal):Promise<{profileHash:string;vectors:Float32Array[]}>=>{
  const texts=(input as {texts?:unknown})?.texts
  if((input?.kind!=='query'&&input?.kind!=='passage')||!Array.isArray(texts)||texts.length===0||texts.length>maxTexts||texts.some(text=>typeof text!=='string'))
   return Promise.reject(new WorkError('teloa/invalid-input',`嵌入请求须为 query 或 passage，且包含 1–${maxTexts} 条文本。`))
  if(state.phase!=='ready'&&state.phase!=='standby')return Promise.reject(unavailable())
  if(signal.aborted)return Promise.reject(cancelled())
  if(pending>=maxPending)return Promise.reject(new WorkError('teloa/dependency-unavailable','本地检索正忙，请稍后重试。',{retryable:true}))
  pending++
  return new Promise<{profileHash:string;vectors:Float32Array[]}>((resolve,reject)=>{
   let started=false
   const abort=()=>{if(!started)reject(cancelled())}
   signal.addEventListener('abort',abort,{once:true})
   tail=tail.then(async()=>{
    if(signal.aborted)return
    started=true
    try{resolve(await run({kind:input.kind,texts:[...texts as string[]]},signal))}
    catch(error){reject(error)}
    finally{signal.removeEventListener('abort',abort)}
   })
  }).finally(()=>{pending--})
 }

 return {
  id:options.id,
  inspected,
  state:()=>state,
  snapshotRow:()=>({id:options.id,location:'host-local' as const,catalogId:options.catalogId,catalogVersion:options.catalogVersion,profileHash:options.profileHash,variant:options.variant,totalMemoryBytes:options.totalMemoryBytes,memoryRisk:embeddingMemoryRisk({totalMemoryBytes:options.totalMemoryBytes,variant:options.variant}),preparation:state,...(options.preparationDetails?{preparationDetails:options.preparationDetails}:{})}),
  prepare,
  settled:()=>preparing?.done??Promise.resolve(),
  cancelPreparation,
  embed,
  metrics:()=>({truncatedTexts}),
  async dispose(){
   lifetime.abort(new Error('本地检索扩展已停用'))
   clearIdle()
   await preparing?.done
   await tail.catch(()=>{})
   await recycle()
  },
 }
}
export type EmbeddingProvider=ReturnType<typeof createEmbeddingProvider>

/** 服务 `teloaEmbedding`（规格 §5.2）：接口与 DSH `speechToText` 同形，便于官方补齐后迁移。 */
export type TeloaEmbeddingService={
 snapshot():{providers:ReturnType<EmbeddingProvider['snapshotRow']>[]}
 /** 只能由界面确认后的 `retrieval-model/prepare` 端点调用；先装运行时再下载工件。source 为本次下载来源，缺省官方。 */
 prepare(id:string,request?:{source?:EmbeddingDownloadSource}):void
 cancelPreparation(id:string):Promise<void>
 embed(id:string,input:EmbeddingInput,signal:AbortSignal):Promise<{profileHash:string;vectors:Float32Array[]}>
}
export function createEmbeddingService(providers:readonly EmbeddingProvider[]):TeloaEmbeddingService{
 const find=(id:string)=>{
  const provider=providers.find(row=>row.id===id)
  if(!provider)throw new WorkError('teloa/not-found','没有这个本地检索模型。')
  return provider
 }
 return {
  snapshot:()=>({providers:providers.map(provider=>provider.snapshotRow())}),
  prepare:(id,request)=>find(id).prepare(request),
  cancelPreparation:async id=>find(id).cancelPreparation(),
  embed:async(id,input,signal)=>find(id).embed(input,signal),
 }
}
