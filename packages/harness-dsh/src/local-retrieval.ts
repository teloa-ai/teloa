import type {Context} from '@deepseek-ai/cordis'
import {defineTool,type PreToolDecision,type ToolExecution} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,readEmbeddingPreparationState,readRetrievalSearchResult,retrievalEndpoints,retrievalLimits,taskInput,embeddingProviderIds,embeddingProviderForCatalog,type EmbeddingProviderId,type EmbeddingDownloadSource,type EmbeddingPreparationState,type EmbeddingVariant} from '@teloa/contract'
import type {Embedder,ResourceActor,RetrievalIndexService} from '@teloa/backend'
import type {TaskToolPolicyReader} from './task-tool-guard.ts'
import {captureRetrievalPreparation,sameRetrievalPreparation,readRetrievalPrepareInput,readRetrievalPreparationDetails,type RetrievalPreparationDetails} from '@teloa/contract'

/** 公开检索工具名（规格 §7.1）；岗位授权候选与 `task-tool-guard` 的清单都按这个名字。 */
export const knowledgeSearchToolName='teloa_knowledge_search'
/** 首次使用继续采用 Qwen；准备其他模型不会改变本人的选择。 */
export const embeddingProviderId:EmbeddingProviderId='qwen3-embedding-0.6b'

/** 扩展 `@teloa/local-embedding` 提供的 `teloaEmbedding` 服务形状（规格 §5.2）；宿主经 `ctx.reflect.get` 发现，不引入扩展源码。 */
export type EmbeddingServiceLike={
 snapshot():unknown
 /** source 为本次下载来源（已按确认过的来源表核对），缺省官方；不保存。 */
 prepare(id:string,request?:{source?:EmbeddingDownloadSource}):void
 cancelPreparation(id:string):Promise<void>
 embed(id:string,input:{kind:'query'|'passage';texts:string[]},signal:AbortSignal):Promise<{profileHash:string;vectors:Float32Array[]}>
}
export type EmbeddingProviderView={id:string;location:'host-local';catalogId:string;catalogVersion:string;profileHash:string;variant:EmbeddingVariant;totalMemoryBytes:number;memoryRisk:boolean;preparation:EmbeddingPreparationState;preparationDetails?:RetrievalPreparationDetails}
export type RetrievalModelStatus={enabled:boolean;provider:EmbeddingProviderView|null;selectedProviderId:EmbeddingProviderId;building:boolean;guidance:string|null}

export type LocalRetrievalPorts={
 owner:string
 conversation:(sessionId:string)=>Promise<{ownerId:string;sessionId:string;status:'pending'|'ready';scopeIds:readonly string[]}>
 readTaskPolicy:TaskToolPolicyReader
 /** 受管任务的主体与目标范围（`taskKnowledgeAuthorization` 的结果，岗位范围已收窄）；普通会话不调。 */
 taskAuthorization:(sessionId:string,signal:AbortSignal)=>Promise<{actor:ResourceActor;targetScopes:string[]}>
 /** 本人主体（含全部已登记范围）：只用于界面端点，模型工具永远拿不到它。 */
 humanActor:()=>Promise<ResourceActor>
 retrieval:()=>Promise<Pick<RetrievalIndexService,'search'|'enroll'|'remove'|'status'|'buildPending'|'reconcile'>>
 /** `ctx.reflect.get('teloaEmbedding')`：扩展未启用或已停用时为 undefined。 */
 embedding:()=>EmbeddingServiceLike|undefined
 /** 后台建索引的准入（宿主传 runtimeAdmission.run）。 */
 admit:<T>(work:()=>Promise<T>)=>Promise<T>
 /** 只记阶段与错误类别，不记查询文本或资料内容。 */
 log:(level:'info'|'warn',message:string)=>void
 /** 准备模型后跟踪就绪的轮询间隔；缺省 2 秒，只给测试缩短。 */
 readyPollMs?:number
 /** 本人「停止整理」的选择跨重启保留；缺省只在进程内记住。 */
 autoPause?:{read:()=>Promise<boolean>;write:(paused:boolean)=>Promise<void>}
 /** 本人明确选择的检索模型；读取失败不得回退默认模型。 */
 modelSelection?:{read:()=>Promise<EmbeddingProviderId>;write:(id:EmbeddingProviderId)=>Promise<void>}
}

const disabledGuidance='本地检索尚未启用，请先启用本地检索并准备模型。'
const disabled=()=>new WorkError('teloa/dependency-unavailable',disabledGuidance,{extension:'local-embedding',endpoint:'bundled-extensions/set'})
const unprepared=()=>new WorkError('teloa/dependency-unavailable','本地检索模型未准备，请在资料页确认开启资料检索。')
const unreadable=()=>new WorkError('teloa/dependency-unavailable','本地检索模型状态不可读，请重启宿主后重试。')
const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const hex64=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const reviewedProvider=(value:unknown):value is EmbeddingProviderId=>(embeddingProviderIds as readonly unknown[]).includes(value)

/** 快照只读：形状不符即视为不可用，不猜测阶段。 */
export function readEmbeddingProvider(snapshot:unknown,providerId:string):EmbeddingProviderView|undefined{
 if(!isRecord(snapshot)||!Array.isArray(snapshot.providers))throw unreadable()
 const row=snapshot.providers.find(item=>isRecord(item)&&item.id===providerId)
 if(row===undefined)return undefined
 if(!isRecord(row)||!reviewedProvider(providerId)||row.location!=='host-local'||typeof row.catalogId!=='string'||embeddingProviderForCatalog(row.catalogId)!==providerId||typeof row.catalogVersion!=='string'||!hex64(row.profileHash)||(row.variant!=='fp32'&&row.variant!=='int8'&&row.variant!=='ollama')||typeof row.totalMemoryBytes!=='number'||!Number.isSafeInteger(row.totalMemoryBytes)||row.totalMemoryBytes<=0||typeof row.memoryRisk!=='boolean')throw unreadable()
 let preparation:EmbeddingPreparationState
 try{preparation=readEmbeddingPreparationState(row.preparation)}catch{throw unreadable()}
 return {id:providerId,location:'host-local',catalogId:row.catalogId,catalogVersion:row.catalogVersion,profileHash:row.profileHash,variant:row.variant,totalMemoryBytes:row.totalMemoryBytes,memoryRisk:row.memoryRisk,preparation,...(row.preparationDetails===undefined?{}:{preparationDetails:readRetrievalPreparationDetails(row.preparationDetails)})}
}

/** 工具参数：只接受 query 与 limit（规格 §7.1）；limit 缺省交给服务端默认值，null 不算缺省。 */
export function searchInput(args:unknown):{query:string;limit?:number}{
 if(!isRecord(args)||Object.keys(args).some(key=>key!=='query'&&key!=='limit'))throw bad('检索参数只接受 query 与 limit，不接受资料、范围或路径参数。')
 const query=args.query
 if(typeof query!=='string'||!query.trim()||[...query].length>retrievalLimits.maxQueryChars)throw bad('query 须为 1–500 字的文本。')
 if(args.limit===undefined)return {query}
 if(typeof args.limit!=='number'||!Number.isSafeInteger(args.limit)||args.limit<1||args.limit>retrievalLimits.maxResults)throw bad('limit 须为 1–8 的整数。')
 return {query,limit:args.limit}
}

/**
 * 端侧中文检索的宿主接线（规格 §7）：
 *  - 公开工具 `teloa_knowledge_search`：本人普通会话在模型就绪后默认可用，按会话绑定范围检索；受管任务须岗位整工具授权，
 *    按 `taskKnowledgeAuthorization` 的主体与目标范围检索；子 Agent 会话拒绝。模型未就绪只报 `dependency-unavailable`，不触发准备或安装。
 *  - 界面端点 `retrieval/*`、`retrieval-model/*`：只以本人主体转发到后端与扩展服务；加入/移出/重建/准备只由本人界面操作。
 *  - 后台建索引单飞可取消；启动对账 `reconcile()` 只在进程内调用，不暴露为 RPC。
 */
export function registerLocalRetrieval(ctx:Context,ports:LocalRetrievalPorts){
 let selectedProviderId:EmbeddingProviderId=embeddingProviderId,selectionKnown=!ports.modelSelection,selectionError:WorkError|undefined,changing:Promise<void>|undefined,selectionGeneration=0
 const selectionLoaded=ports.modelSelection?Promise.resolve().then(()=>ports.modelSelection!.read()).then(id=>{
  if(!reviewedProvider(id))throw new WorkError('teloa/storage-corrupt','本地检索模型选择记录损坏，请修复后重试。')
  selectedProviderId=id
 }).catch(error=>{
  selectionError=error instanceof WorkError?error:new WorkError('teloa/storage-unavailable','本地检索模型选择暂时无法读取，请重试。')
  ports.log('warn','本地检索模型选择读取失败：'+selectionError.code)
 }).finally(()=>{selectionKnown=true}):Promise.resolve()
 const loadedSelection=async()=>{await selectionLoaded;if(selectionError)throw selectionError}
 const waitForSelection=async()=>{await loadedSelection();while(changing)await changing}
 const provider=(id:EmbeddingProviderId=selectedProviderId):{service:EmbeddingServiceLike;provider:EmbeddingProviderView}|undefined=>{
  const service=ports.embedding()
  if(!service)return undefined
  let snapshot:unknown
  try{snapshot=service.snapshot()}catch{throw unreadable()}
  const row=readEmbeddingProvider(snapshot,id)
  return row===undefined?undefined:{service,provider:row}
 }
 const adapter=(service:EmbeddingServiceLike,row:EmbeddingProviderView):Embedder=>{
  const generation=selectionGeneration
  const current=()=>{if(generation!==selectionGeneration||changing||selectedProviderId!==row.id||profileHash()!==row.profileHash)throw new WorkError('teloa/conflict','本地检索模型已变化，请重试。')}
  return {profileHash:row.profileHash,async embed(kind,texts,signal){
  current();signal.throwIfAborted()
  const result=await service.embed(row.id,{kind,texts},signal)
  current();signal.throwIfAborted()
  if(!isRecord(result)||result.profileHash!==row.profileHash||!Array.isArray(result.vectors))throw new WorkError('teloa/dependency-unavailable','本地检索模型配置已变化，请重试。')
  return result.vectors as Float32Array[]
 }}}
 /** 只在 ready / standby 受理（standby 由服务按需唤醒）；其余阶段一律不可用，且这里绝不调用 prepare。 */
 const requireEmbedder=():Embedder=>{
  if(selectionError)throw selectionError
  if(!selectionKnown||changing)throw new WorkError('teloa/conflict','本地检索模型正在切换，请稍后重试。')
  const found=provider()
  if(!found)throw disabled()
  const phase=found.provider.preparation.phase
  if(phase!=='ready'&&phase!=='standby')throw unprepared()
  return adapter(found.service,found.provider)
 }
 const embedderIfReady=():Embedder|undefined=>{try{return requireEmbedder()}catch{return undefined}}
 const profileHash=():string|null=>{try{return provider()?.provider.profileHash??null}catch{return null}}

 // —— 后台建索引：单飞；在跑时的新请求合并成一次补跑（retryFailed 取并）；停止时中止。 ——
 let running:{controller:AbortController;done:Promise<void>}|undefined,rerun:{retryFailed:boolean}|undefined,cancelling:Promise<void>|undefined,disposed=false
 const assertActive=(signal:AbortSignal)=>{
  signal.throwIfAborted()
  if(disposed)throw new WorkError('teloa/dependency-unavailable','本地检索宿主正在停止，请稍后重试。')
 }
 const startBuild=(options:{retryFailed:boolean})=>{
  if(disposed||cancelling||changing||!selectionKnown||selectionError)return
  if(running){rerun={retryFailed:(rerun?.retryFailed??false)||options.retryFailed};return}
  // 先登记再启动：建索引在没有可用模型时会同步结束，登记放在后面会留下一个永远清不掉的 running。
  const task={controller:new AbortController(),done:Promise.resolve()}
  running=task
  task.done=(async()=>{
   try{
    const embedder=embedderIfReady()
    if(!embedder)return
    const result=await ports.admit(async()=>{
     // 准入排队和服务/主体读取期间也可能取消；出队后不能再下发旧批次。
     const signal=task.controller.signal
     assertActive(signal)
     const retrieval=await ports.retrieval()
     assertActive(signal)
     const actor=await ports.humanActor()
     assertActive(signal)
     return retrieval.buildPending(actor,embedder,signal,{retryFailed:options.retryFailed})
    })
    ports.log('info',`本地检索建索引完成：就绪 ${result.ready} 份，失败 ${result.failed} 份。`)
   }catch(error){
    if(!task.controller.signal.aborted)ports.log('warn','本地检索建索引未完成：'+(error instanceof WorkError?error.code:'teloa/dependency-unavailable'))
   }finally{
    if(running===task)running=undefined
    const next=rerun
    rerun=undefined
    if(next)startBuild(next)
   }
  })()
 }
 const building=()=>running!==undefined
 const waitBuild=async(signal:AbortSignal)=>{
  while(running){
   signal.throwIfAborted()
   const done=running.done
   await new Promise<void>((resolve,reject)=>{
    const aborted=()=>reject(signal.reason)
    signal.addEventListener('abort',aborted,{once:true})
    done.then(resolve,reject).finally(()=>signal.removeEventListener('abort',aborted))
   })
  }
  assertActive(signal)
 }
 // —— 自动整理：模型准备就绪后整理一次；读状态时发现新的待更新资料（加入后资料出了新版本）也整理一次。
 // 同一批待更新资料只自动整理一次，避免暂时读不到的资料在每次读状态时反复触发；本人取消后不自动续建，
 // 直到本人再点重建或重新准备模型；这个选择经 autoPause 跨重启保留。 ——
 let autoPaused=false,pauseTouched=false,lastAutoKey='',pauseWrites=Promise.resolve()
 const readyWatches=new Map<EmbeddingProviderId,ReturnType<typeof setTimeout>>()
 // 启动时读回上次的选择；读到之前本人已经操作过就以本人这次操作为准。
 let pauseKnown=!ports.autoPause
 const pauseLoaded=(ports.autoPause?.read()??Promise.resolve(false)).then(value=>{if(!pauseTouched&&value)autoPaused=true},()=>ports.log('warn','本地检索停止整理记录读取失败，按未停止处理。')).finally(()=>{pauseKnown=true})
 const setAutoPaused=(value:boolean)=>{
  pauseTouched=true
  if(autoPaused===value&&pauseKnown)return pauseWrites
  autoPaused=value
  // 写入和移除停止记录共用一个队列；后到的本人选择必须最后落盘。
  pauseWrites=pauseWrites.then(()=>ports.autoPause?.write(value)).catch(()=>ports.log('warn','本地检索停止整理记录写入失败。'))
  return pauseWrites
 }
 const autoBuild=(items:readonly {resourceId:string|null;version:number|null;state:string}[])=>{
  if(autoPaused||disposed||cancelling||running||changing||!selectionKnown||selectionError)return
  const key=items.filter(item=>item.state==='stale'&&item.resourceId!==null).map(item=>item.resourceId+':'+item.version).sort().join('|')
  const profileKey=profileHash()+':'+key
  if(!key||profileKey===lastAutoKey||!embedderIfReady())return
  lastAutoKey=profileKey
  startBuild({retryFailed:false})
 }
 /** 准备是后台进行的：跟踪到就绪（含待机）时整理一次；失败、取消或回到未准备就停止跟踪。 */
 const followPreparation=(id:EmbeddingProviderId)=>{
  clearTimeout(readyWatches.get(id))
  const tick=()=>{
   readyWatches.delete(id)
   if(disposed)return
   let phase:string|undefined
   try{phase=provider(id)?.provider.preparation.phase}catch{return}
   if(phase==='ready'||phase==='standby'){if(id===selectedProviderId&&!autoPaused)startBuild({retryFailed:false});return}
   if(phase==='checking'||phase==='downloading'||phase==='loading')schedule()
  }
  const schedule=()=>{const timer=setTimeout(tick,ports.readyPollMs??2000);timer.unref?.();readyWatches.set(id,timer)}
  schedule()
 }
 const cancelBuild=():Promise<void>=>{
  rerun=undefined
  if(cancelling)return cancelling
  const task=running
  if(!task)return Promise.resolve()
  task.controller.abort(new WorkError('teloa/cancelled','本地检索建索引已取消。'))
  const done=task.done.finally(()=>{if(cancelling===done)cancelling=undefined})
  cancelling=done
  return done
 }

 // 只登记已调用的后端清理；等待模型选择或读取服务的外层任务不能反过来阻塞切换。
 const actualReconciles=new Set<Promise<{removed:number}>>()
 const waitReconciles=async()=>{while(actualReconciles.size)await Promise.allSettled([...actualReconciles])}
 const reconcileIndexes=async(retrieval:Awaited<ReturnType<LocalRetrievalPorts['retrieval']>>,hash:string|null,generation:number,active:()=>boolean=()=>true)=>{
  if(!active()||disposed||changing||selectionGeneration!==generation||profileHash()!==hash)return {removed:0}
  const cleanup=retrieval.reconcile(hash??undefined)
  actualReconciles.add(cleanup)
  try{return await cleanup}finally{actualReconciles.delete(cleanup)}
 }

 // Cordis 4.0.4 公开依赖子作用域：服务出现/替换时补 profile 对账；不阻塞可选扩展缺失的宿主。
 // 冷启动时 teloaWork 尚未提供，原有启动对账仍只做通用清理。这里不准备模型、不操作权重目录。
 const profileReconciler=ctx.inject(['teloaEmbedding'],scope=>{
  let active=true
  const done=(async()=>{
   await waitForSelection()
   const hash=profileHash(),generation=selectionGeneration
   if(!active||disposed||hash===null)return
   await ports.admit(async()=>{
   const retrieval=await ports.retrieval()
   // 扩展卸载/替换或宿主停机期间取消尚未开始的清理，不能用旧 hash 清理新配置。
   const result=await reconcileIndexes(retrieval,hash,generation,()=>active)
   if(result.removed)ports.log('info',`本地检索配置对账：清理 ${result.removed} 条失效索引。`)
   })
  })().catch(error=>ports.log('warn','本地检索配置对账未完成：'+(error instanceof WorkError?error.code:'teloa/dependency-unavailable')))
  scope.effect(()=>()=>{active=false;return done})
 })

 // —— 工具：主体判定与参数核对在前置守卫与正文各做一次（确认期间身份可能变化）。 ——
 const subject=async(exec:Pick<ToolExecution,'agent'|'signal'>):Promise<{actor:ResourceActor;targetScopes:string[]}>=>{
  if(!exec.agent)throw new WorkError('teloa/not-bound','本地检索需要已绑定的工作会话。')
  const session=exec.agent.session,sessionId=session.id
  if(session.header.origin==='subagent')throw forbidden('子 Agent 会话不能使用本地检索。')
  let binding:Awaited<ReturnType<LocalRetrievalPorts['conversation']>>,policy:Awaited<ReturnType<TaskToolPolicyReader>>
  try{[binding,policy]=await Promise.all([ports.conversation(sessionId),ports.readTaskPolicy(sessionId,exec.signal)])}
  catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/dependency-unavailable','暂时无法核对会话身份。')}
  if(binding.ownerId!==ports.owner||binding.sessionId!==sessionId||binding.status!=='ready')throw forbidden('当前会话未绑定为本人可用工作会话。')
  exec.signal.throwIfAborted()
  // 本人普通会话：模型就绪后默认可用，范围即会话绑定范围（IM 私聊同样是普通会话绑定，不另扩大）。
  if(policy===null)return {actor:{ownerId:ports.owner,kind:'agent',scopeIds:[...binding.scopeIds]},targetScopes:[...binding.scopeIds]}
  if(policy.stopRequested===true)throw forbidden('本次执行已请求停止。')
  if(!policy.allowedTools.includes(knowledgeSearchToolName))throw forbidden('当前任务未授权本地检索，请核对员工执行范围。')
  return ports.taskAuthorization(sessionId,exec.signal)
 }
 ctx.tools.register(defineTool({
  name:knowledgeSearchToolName,
  description:'回答需要本人工作资料中的信息时，主动使用此工具检索已加入且当前会话有权读取的资料。资料更新后自动整理，再返回带原文位置（行、字符区间、标题路径）的有界摘录与覆盖范围。coverage.searched 是本次实际检索的资料，coverage.pending 是已加入但尚不可检索的资料；如有 pending，应如实说明覆盖范围，不能把尚未检索的资料当成已核实。只接受 query（1–500 字）与 limit（1–8，默认 5），不能指定资料、范围或路径。',
  parameters:{query:{type:'string',required:true},limit:{type:'integer'}},
  output:{schema:{type:'string'},render:(_args,value)=>[{type:'text',text:value}]},
  execute:async(args,exec)=>{
   await waitForSelection()
   const input=searchInput(args),{actor,targetScopes}=await subject(exec)
   // 授权核验之后才取模型：未就绪不推理、不准备。
   const embedder=requireEmbedder()
   const generation=selectionGeneration
   const retrieval=await ports.retrieval()
   const indexes=await retrieval.status(actor,embedder.profileHash)
   if(!pauseKnown)await pauseLoaded
   // 仅整理本人已经加入的资料，沿现有单飞流程；查询取消不撤回已经受理的整理。
   autoBuild(indexes.items)
   await waitBuild(exec.signal)
   if(generation!==selectionGeneration)throw new WorkError('teloa/conflict','本地检索模型已变化，请重试。')
   const result=await retrieval.search(actor,targetScopes,input,embedder,exec.signal)
   if(generation!==selectionGeneration)throw new WorkError('teloa/conflict','本地检索模型已变化，请重试。')
   exec.signal.throwIfAborted()
   return JSON.stringify(readRetrievalSearchResult(result))
  },
 }))
 const removePreExecute=ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(exec.name!==knowledgeSearchToolName)return next()
  try{await waitForSelection();searchInput(exec.arguments);await subject(exec)}
  catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'暂时无法核对本地检索身份。'}}
  return next()
 })

 // —— 界面端点：只以本人主体转发。 ——
 const modelStatus=(id:EmbeddingProviderId=selectedProviderId):RetrievalModelStatus=>{
  const found=provider(id)
  if(!found)return {enabled:ports.embedding()!==undefined,provider:null,selectedProviderId,building:building(),guidance:disabledGuidance}
  return {enabled:true,provider:found.provider,selectedProviderId,building:building(),guidance:null}
 }
 const requestedProvider=(payload:unknown)=>{const input=taskInput(payload,['providerId']);if(input.providerId===undefined)return selectedProviderId;if(!reviewedProvider(input.providerId))throw bad('本地检索模型选择不正确。');return input.providerId}
 const requireService=():EmbeddingServiceLike=>{const service=ports.embedding();if(!service)throw disabled();return service}
 // 状态轮询与已授权检索共用自动整理；不要求本人打开资料页才能更新已加入的资料。
 const status=async()=>{
  const value=await (await ports.retrieval()).status(await ports.humanActor(),profileHash())
  if(!pauseKnown)await pauseLoaded
  autoBuild(value.items)
  return {...value,building:building()}
 }
 const mutationContext=async(signal:AbortSignal)=>{
  const retrieval=await ports.retrieval()
  assertActive(signal)
  const actor=await ports.humanActor()
  assertActive(signal)
  return {retrieval,actor}
 }
 const selectModel=async(payload:unknown,signal:AbortSignal):Promise<RetrievalModelStatus>=>{
  const input=taskInput(payload,['providerId','profileHash'])
  if(!reviewedProvider(input.providerId)||!hex64(input.profileHash))throw bad('模型选择须携带正确的 providerId 与 profileHash。')
  if(changing)throw new WorkError('teloa/conflict','本地检索模型正在切换，请稍后重试。')
  const id=input.providerId,hash=input.profileHash,found=provider(id)
  if(!found)throw disabled()
  const verify=(current:ReturnType<typeof provider>)=>{
   if(!current||current.service!==found.service||current.provider.profileHash!==hash)throw new WorkError('teloa/conflict','本地检索模型配置已变化，请重新选择。')
   if(!['ready','standby'].includes(current.provider.preparation.phase))throw unprepared()
  }
  verify(found)
  selectionGeneration++
  // 先进入切换状态，旧批实际收尾和选择写入期间不能再启动整理或查询。
  const switchDone=Promise.resolve().then(async()=>{
   await cancelBuild()
   await waitReconciles()
   assertActive(signal)
   verify(provider(id))
   // 已有权重的标签不能证明当前 Ollama 能运行此模型；显式选用只探测，不下载或准备。
   if(found.provider.variant==='ollama'){
    const result=await found.service.embed(id,{kind:'query',texts:['Teloa']},signal)
    assertActive(signal)
    if(result.profileHash!==hash)throw new WorkError('teloa/conflict','本地检索模型配置已变化，请重新选择。')
    verify(provider(id))
   }
   try{await ports.modelSelection?.write(id)}catch{throw new WorkError('teloa/storage-unavailable','本地检索模型选择未保存，请重试。')}
   // 写入已提交后保留本人选择；短 RPC 后续取消不承诺撤回持久记录。
   selectedProviderId=id
   clearTimeout(readyWatches.get(id));readyWatches.delete(id)
   lastAutoKey=''
   await setAutoPaused(false)
  })
  const done=switchDone.finally(()=>{if(changing===done)changing=undefined})
  changing=done
  await done
  startBuild({retryFailed:false})
  return modelStatus(id)
 }
 const handle=async(endpoint:string,payload:unknown,signal:AbortSignal):Promise<unknown>=>{
  if(!(retrievalEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此本地检索接口。')
  assertActive(signal)
  if(endpoint==='retrieval-model/select')await loadedSelection();else await waitForSelection()
  assertActive(signal)
  switch(endpoint){
   case 'retrieval-model/status':return modelStatus(requestedProvider(payload))
   case 'retrieval-model/prepare':{
    // source 只能是官方或本人确认过的来源表里的镜像；来源表随 preparationDetails 一起参与下面的一致性核对。
    const {expected,source}=readRetrievalPrepareInput(payload)
    // 捕获一次服务，在同一个同步执行段读取、比较并调用它；不能核对 A 后再解析服务调用 B。
    if(!reviewedProvider(expected.id))throw bad('本地检索模型选择不正确。')
    const found=provider(expected.id)
    if(!found)throw disabled()
    if(!found.provider.preparationDetails||!sameRetrievalPreparation(captureRetrievalPreparation(found.provider),expected))throw new WorkError('teloa/conflict','本地检索准备配置已变化，请重新确认。')
    assertActive(signal)
    found.service.prepare(expected.id,source?{source}:undefined)
    const resumed=expected.id===selectedProviderId?setAutoPaused(false):undefined
    followPreparation(expected.id)
    await resumed
    return {enabled:true,provider:readEmbeddingProvider(found.service.snapshot(),expected.id)??null,selectedProviderId,building:building(),guidance:null}
   }
   case 'retrieval-model/cancel':{
    const id=requestedProvider(payload)
    await requireService().cancelPreparation(id)
    clearTimeout(readyWatches.get(id));readyWatches.delete(id)
    return modelStatus(id)
   }
   case 'retrieval-model/select':return selectModel(payload,signal)
   case 'retrieval/status':taskInput(payload,[]);return status()
   case 'retrieval/cancel':taskInput(payload,[]);await Promise.all([setAutoPaused(true),cancelBuild()]);return status()
   case 'retrieval/enroll':{
    const {retrieval,actor}=await mutationContext(signal)
    // await helper 返回本身也会让出；紧贴实际写入再核一次。
    assertActive(signal)
    await retrieval.enroll(actor,payload)
    // 提交已开始后不承诺取消回滚；已受理后台任务不绑定短 RPC 的 signal。
    // 模型不可用时只登记加入，不建索引；状态显示 stale，模型准备就绪后自动整理一次。
    startBuild({retryFailed:false})
    return status()
   }
   case 'retrieval/remove':{
    const {retrieval,actor}=await mutationContext(signal)
    assertActive(signal)
    await retrieval.remove(actor,payload)
    return status()
   }
   default:{
    taskInput(payload,[])
    if(cancelling)throw new WorkError('teloa/conflict','本地检索索引正在取消，请收尾后重建。')
    requireEmbedder()
    await setAutoPaused(false)
    assertActive(signal)
    startBuild({retryFailed:true})
    return status()
   }
  }
 }
 const idle=async()=>{while(running)await running.done}
 return {
  handle,
  building,
  /** 宿主启动对账：等本人模型选择加载后清理失效绑定，合法旧模型的就绪索引保留。 */
  reconcile:async()=>{
   await waitForSelection()
   const hash=profileHash(),generation=selectionGeneration
   const result=await reconcileIndexes(await ports.retrieval(),hash,generation)
   if(result.removed)ports.log('info',`本地检索启动对账：清理 ${result.removed} 条失效索引。`)
  },
  idle,
  dispose:async()=>{disposed=true;for(const timer of readyWatches.values())clearTimeout(timer);readyWatches.clear();await Promise.all([cancelBuild(),waitReconciles(),changing?.catch(()=>{}),profileReconciler.dispose()]);await pauseWrites;removePreExecute()},
 }
}
