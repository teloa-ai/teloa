import {assessLocalModelFit} from './local-model-fit.ts'
import {readOllamaAddress} from './ollama-address.ts'
import {homedir,totalmem} from 'node:os'
import {join,dirname} from 'node:path'
import {statfs,stat,readFile,mkdir} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {LlmError,type LlmCallConfig} from '@deepseek-ai/dsh-llm'
import {WorkError,isRecord,ollamaModelNamePattern,ollamaDigestPattern,localModelEndpoints,readLocalModelPullInput,readLocalModelPullRequest,readLocalModelTargetNameInput,readLocalModelAddressInput,readLocalModelNameInput,readLocalModelsOverview,readPullJobView,taskInput,OLLAMA_DEFAULT_ADDRESS,OLLAMA_MIN_VERSION,type LocalModelsOverview,type LocalModelRow,type PullJobView,type MarketCatalogModelEntry,type MarketCatalogModelVariant,type MarketCatalogText} from '@teloa/contract'
import {writeAtomic} from './pending-plugins.ts'
import {ensureOllamaRoute,removeFromOllamaRoute,ollamaRouteHasModel,readOllamaRequestRoute,tightenOllamaRequestRoute,type SettingsPort,type CredentialsPort} from './local-models-route.ts'
import {ollamaReasoning} from './ollama-reasoning.ts'
import type {OllamaClient,OllamaTag,OllamaRunningModel} from './ollama-client.ts'
import {OllamaHttpError,abortable} from './ollama-client.ts'
import {prepareOllamaContext,inspectOllamaContext,ollamaContextBudget} from './ollama-context.ts'

/**
 * 宿主 `local-models/*` 七端点（模型二期规格 §5–§6、§8）。状态真源是 Ollama `/api/tags` 与 DSH 设置；
 * `<runtimeRoot>/local-models.json` 只记地址与 Teloa 经手记录，每次 overview 都重新对照，不伪造就绪。
 * 拉取 / 目录外接入 / 移除都是本人在界面确认的动作：只经认证后的工作台 RPC（endpointSet）到达；
 * IM 通道的 `teloaWork.invoke` 白名单不含这些端点，会话工具只能拿 `pullFacts` / `startPull` 两个口（功能验证）。
 */
export type LocalModelsDeps={
 runtimeRoot:string
 /** 只回 form:'local-general' 的模型条目。 */
 catalog:()=>MarketCatalogModelEntry[]
 settings:SettingsPort
 credentials:CredentialsPort
 client:(address:{baseURL:string;host:string;local:boolean})=>Pick<OllamaClient,'version'|'tags'|'ps'|'show'|'pull'|'remove'|'load'>
 hardware?:()=>{totalMemBytes:number;arch:string;platform:string}
 diskFree?:(path:string)=>Promise<number>
 now?:()=>string
 logger:{info(...a:unknown[]):void;warn(...a:unknown[]):void}
}
export type LocalModelPullInput=ReturnType<typeof readLocalModelPullInput>
/** 确认卡五项事实（规格 §6.1），界面与 `teloa_model_prepare` 共用。 */
export type PullFacts={entryId:string;version:string;variant:number;name:string;title:MarketCatalogText;quant:string;baseURL:string;catalogDigest:string|null;sizeBytes:number;diskFreeBytes:number|null;local:boolean;licenseTier:'commercial'|'restricted';licenseName:string;licenseURL:string;restrictions:MarketCatalogText[];fit:LocalModelRow['fit'];runtime:'missing'|'running'}

/** 只固定批准的目标与目录事实；可用磁盘随时变化，由真正下载前的检查负责。 */
export const pullApprovalIdentity=(facts:PullFacts)=>JSON.stringify([facts.entryId,facts.version,facts.variant,facts.name,facts.title['zh-CN'],facts.title.en,facts.quant,facts.baseURL,facts.catalogDigest,facts.sizeBytes,facts.licenseTier,facts.licenseName,facts.licenseURL,facts.restrictions.map(row=>[row['zh-CN'],row.en]),facts.fit])

type Record_={entryId:string|null;version:string|null;variant:number|null;name:string;digest:string;status:'ready'|'unverified'|'attached';routeModelId:string|null;requestAddress?:string;at:string}
type State={format:'teloa.local-models/v1';address:{baseURL:string;custom:boolean;updatedAt:string};records:Record_[]}
type Job={pullId:string;requestId:string;requestSpec:string;name:string;phase:PullJobView['phase'];completed:number;total:number|null;error:string|null;controller:AbortController}
type Address=ReturnType<typeof readOllamaAddress>
type Variant={entry:MarketCatalogModelEntry;variant:MarketCatalogModelVariant;index:number}

const STATE_FORMAT='teloa.local-models/v1'
const fit=(totalGb:number,h:{minRamGb:number;recommendedRamGb:number}):LocalModelRow['fit']=>totalGb>=h.recommendedRamGb?'good':totalGb>=h.minRamGb?'slow':'poor'
const versionAtLeast=(v:string,min:string)=>{if(!/^v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i.test(v))return false;const a=v.replace(/^v/,'').split(/[-+]/)[0]!.split('.').map(Number),b=min.split('.').map(Number);for(let i=0;i<3;i++){if(a[i]!>b[i]!)return true;if(a[i]!<b[i]!)return false}return true}
const activePhase=(job:Job|null):job is Job=>job!==null&&(job.phase==='pulling'||job.phase==='verifying')
const jobView=(job:Job):PullJobView=>({pullId:job.pullId,name:job.name,phase:job.phase,completed:job.completed,total:job.total,error:job.error})
const errorText=(error:unknown)=>(error instanceof Error?error.message:String(error)).slice(0,800)||'本地模型操作失败。'
const checkCompletion=(capabilities:string[]|null)=>{
 if(capabilities!==null&&!capabilities.includes('completion'))throw new WorkError('teloa/source-invalid','该模型不支持对话生成，暂时不能接入为对话模型。')
}

export function createLocalModelsHandler(deps:LocalModelsDeps){
 const file=join(deps.runtimeRoot,'local-models.json')
 const now=deps.now??(()=>new Date().toISOString())
 const lifetime=new AbortController()
 let job:Job|null=null
 // 状态文件的读改写串行化：拉取完成的异步落盘与界面操作可能同时到达。
 let queue:Promise<unknown>=Promise.resolve()
 const withState=<T>(run:(state:State)=>Promise<T>|T):Promise<T>=>{const next=queue.then(async()=>run(await readState()));queue=next.catch(()=>undefined);return next}

 const readState=async():Promise<State>=>{
  const invalid=()=>new WorkError('teloa/storage-unavailable','本地模型记录文件损坏或不可读，请检查 local-models.json。')
  let text:string
  try{text=await readFile(file,'utf8')}catch(error){
   if(isRecord(error)&&error.code==='ENOENT')return {format:STATE_FORMAT,address:{baseURL:OLLAMA_DEFAULT_ADDRESS,custom:false,updatedAt:now()},records:[]}
   throw invalid()
  }
  let value:unknown
  try{value=JSON.parse(text)}catch{throw invalid()}
  const timestamp=(v:unknown)=>typeof v==='string'&&Number.isFinite(Date.parse(v))
  if(!isRecord(value)||value.format!==STATE_FORMAT||!Array.isArray(value.records)||!isRecord(value.address)||typeof value.address.custom!=='boolean'||!timestamp(value.address.updatedAt))throw invalid()
  try{readOllamaAddress(value.address.baseURL)}catch{throw invalid()}
  const names=new Set<string>()
  for(const record of value.records){
   if(!isRecord(record)||typeof record.name!=='string'||record.name.length>128||!ollamaModelNamePattern.test(record.name)||names.has(record.name)||typeof record.digest!=='string'||!ollamaDigestPattern.test(record.digest)||!['ready','unverified','attached'].includes(String(record.status))||!timestamp(record.at)||!(record.routeModelId===null||record.routeModelId===record.name))throw invalid()
   const catalogRecord=typeof record.entryId==='string'&&typeof record.version==='string'&&Number.isSafeInteger(record.variant)&&Number(record.variant)>=0
   if(!catalogRecord&&!(record.entryId===null&&record.version===null&&record.variant===null))throw invalid()
   if(record.requestAddress!==undefined){try{if(readOllamaAddress(record.requestAddress).baseURL!==record.requestAddress)throw invalid()}catch{throw invalid()}}
   names.add(record.name)
  }
  return value as unknown as State
 }
 const writeState=async(state:State)=>{await mkdir(dirname(file),{recursive:true});await writeAtomic(file,JSON.stringify(state,null,1)+'\n',0o600)}
 const upsertRecord=(state:State,record:Record_)=>{const i=state.records.findIndex(item=>item.name===record.name);if(i<0)state.records.push(record);else state.records[i]=record}

 const diskFree=async(local:boolean):Promise<number|null>=>{
  if(!local)return null
  const root=process.env.OLLAMA_MODELS??join(homedir(),'.ollama','models')
  let probe=root
  for(;;){try{await stat(probe);break}catch{const parent=dirname(probe);if(parent===probe)break;probe=parent}}
  try{
   if(deps.diskFree)return await deps.diskFree(probe)
   const fs=await statfs(probe);return Number(fs.bavail)*Number(fs.bsize)
  }catch{return null}
  }
 const hardware=()=>{
  const h=deps.hardware?.()??{totalMemBytes:totalmem(),arch:process.arch,platform:process.platform}
  return {totalGb:h.totalMemBytes/2**30,unified:h.arch==='arm64'&&h.platform==='darwin',arch:h.arch,platform:h.platform}
 }
 const variants=():Variant[]=>deps.catalog().flatMap(entry=>entry.model.form==='local-general'?entry.model.variants.map((variant,index)=>({entry,variant,index})):[])
 const findVariant=(entryId:string,index:number):Variant=>{
  const entry=deps.catalog().find(item=>item.id===entryId)
  if(!entry||entry.model.form!=='local-general')throw new WorkError('teloa/not-found','官方目录中没有这个本机模型资源。')
  const variant=entry.model.variants[index]
  if(!variant)throw new WorkError('teloa/invalid-input','本机模型变体不存在。')
  return {entry,variant,index}
 }

 /** 运行时探测：版本失败 → missing；清单不可读必须显式报错，不能用空清单伪装成模型已丢失。 */
 const probe=async(address:Address)=>{
  const client=deps.client(address)
  let version:string|null=null
  try{version=await client.version()}catch(error){deps.logger.info('Teloa 本地模型：未检测到 Ollama（%s）',error instanceof Error?error.message:String(error))}
  if(version===null)return {client,state:'missing' as const,version,outdated:false,tags:[] as OllamaTag[],running:[] as OllamaRunningModel[]}
  let tags:OllamaTag[],running:OllamaRunningModel[]
  try{[tags,running]=await Promise.all([client.tags(),client.ps().catch(()=>[])])}
  catch{throw new WorkError('teloa/source-unavailable','Ollama 已运行，但暂时无法读取模型清单，请重试。')}
  return {client,state:'running' as const,version,outdated:!versionAtLeast(version,OLLAMA_MIN_VERSION),tags,running}
 }

 const rowStatus=(v:Variant,record:Record_|undefined,tag:OllamaTag|undefined,runtime:'missing'|'running',address:Address):LocalModelRow['status']=>{
  const name=v.variant.sources[0].name
  if(runtime==='missing')return 'runtime-missing'
  if(activePhase(job)&&job.name===name)return job.phase==='pulling'?'pulling':'verifying'
  if(!tag)return record?'missing':'not-pulled'
  const routed=ollamaRouteHasModel(deps.settings,address,v.variant.models.id)
  if(record){
   if(tag.digest!==record.digest)return 'unverified'
   if(record.status==='attached')return routed?'attached':'route-pending'
   if(record.status==='unverified'||tag.digest!==v.variant.sources[0].digest)return 'unverified'
   return routed?'ready':'route-pending'
  }
  // Ollama 里有、Teloa 没经手：摘要与目录一致算已核验但未写路由（再次拉取即补路由），否则按未核验。
  const digest=v.variant.sources[0].digest
  return digest!==null&&tag.digest===digest?'route-pending':'unverified'
 }

 const overview=async(state:State):Promise<LocalModelsOverview>=>{
  const address=readOllamaAddress(state.address.baseURL)
  const runtime=await probe(address)
  const hw=hardware(),catalogNames=new Set<string>()
  const rows:LocalModelRow[]=variants().map(v=>{
   const name=v.variant.sources[0].name;catalogNames.add(name)
   const record=state.records.find(item=>item.name===name),tag=runtime.tags.find(item=>item.name===name)
   const loaded=runtime.running.find(row=>row.name===name)
   // 默认 8K 只用于未加载的受审工件；未知实际容量或换版权重不得伪称内存够用。
   const verified=!tag||tag.digest===v.variant.sources[0].digest
   const contextTokens=loaded?(verified&&loaded.digest===tag?.digest?loaded.contextLength:null):8192
   const assessed=address.local&&verified&&contextTokens!==null?assessLocalModelFit({hardware:{totalMemBytes:Math.round(hw.totalGb*2**30),arch:hw.arch,platform:hw.platform},ollamaName:name,quant:v.variant.quant,sizeBytes:v.variant.sizeBytes,contextTokens}):undefined
   const memoryEstimate=assessed&&assessed.basis.catalogDigest===v.variant.sources[0].digest?{sourceVersion:assessed.basis.sourceVersion,contextTokens:assessed.contextTokens,contextSupported:assessed.contextSupported,requiredMemoryBytes:assessed.requiredMemoryBytes,availableMemoryBytes:assessed.availableMemoryBytes,fit:assessed.fit}:undefined
   return {...(memoryEstimate?{memoryEstimate}:{}),entryId:v.entry.id,version:v.entry.version,variant:v.index,name,title:v.entry.model.title,quant:v.variant.quant,sizeBytes:v.variant.sizeBytes,fit:fit(hw.totalGb,v.variant.hardware),licenseTier:v.entry.model.license.tier,licenseName:v.entry.model.license.name,licenseURL:v.entry.model.license.url,restrictions:v.entry.model.license.restrictions,catalogDigest:v.variant.sources[0].digest,status:rowStatus(v,record,tag,runtime.state,address),loaded:runtime.running.some(row=>row.name===name),runtimeContextLength:runtime.running.find(row=>row.name===name&&row.digest===tag?.digest)?.contextLength??null}
  })
  const result:LocalModelsOverview={
   runtime:{state:runtime.state,version:runtime.version,outdated:runtime.outdated,address:{baseURL:address.baseURL,custom:state.address.custom,local:address.local}},
   hardware:{totalMemGb:Math.round(hw.totalGb*10)/10,unified:hw.unified,diskFreeBytes:runtime.state==='running'?await diskFree(address.local):null},
   rows,
   offCatalog:runtime.tags.filter(tag=>!catalogNames.has(tag.name)).map(tag=>({name:tag.name,sizeBytes:tag.size,family:tag.family,parameterSize:tag.parameterSize,loaded:runtime.running.some(row=>row.name===tag.name),runtimeContextLength:runtime.running.find(row=>row.name===tag.name&&row.digest===tag.digest)?.contextLength??null,status:state.records.some(record=>record.name===tag.name&&record.routeModelId!==null)&&ollamaRouteHasModel(deps.settings,address,tag.name)?'attached' as const:'unverified' as const})),
   pull:job===null?null:jobView(job),
  }
  return readLocalModelsOverview(result)
 }

 const factsFor=(v:Variant,address:Address,runtime:PullFacts['runtime'],free:number|null):PullFacts=>({entryId:v.entry.id,version:v.entry.version,variant:v.index,name:v.variant.sources[0].name,title:v.entry.model.title,quant:v.variant.quant,baseURL:address.baseURL,catalogDigest:v.variant.sources[0].digest,sizeBytes:v.variant.sizeBytes,diskFreeBytes:free,local:address.local,licenseTier:v.entry.model.license.tier,licenseName:v.entry.model.license.name,licenseURL:v.entry.model.license.url,restrictions:v.entry.model.license.restrictions,fit:fit(hardware().totalGb,v.variant.hardware),runtime})
 const pullFacts=async(entryId:string,variantIndex:number):Promise<PullFacts>=>{
  const v=findVariant(entryId,variantIndex)
  const state=await withState(s=>s),address=readOllamaAddress(state.address.baseURL),runtime=await probe(address)
  return factsFor(v,address,runtime.state,runtime.state==='running'?await diskFree(address.local):null)
 }

 /** 拉取后核对摘要和能力、空加载并读取实际容量，再写路由；未通过时保留权重。 */
 const verify=async(current:Job,v:Variant,address:Address,client:ReturnType<LocalModelsDeps['client']>)=>withState(async state=>{
  current.controller.signal.throwIfAborted()
  const name=v.variant.sources[0].name,tags=await client.tags(),tag=tags.find(item=>item.name===name)
  current.controller.signal.throwIfAborted()
  if(!tag)throw new WorkError('teloa/source-unavailable','拉取完成但 Ollama 清单里没有该模型。')
  const catalogDigest=v.variant.sources[0].digest
  if(catalogDigest===null||tag.digest!==catalogDigest){
   upsertRecord(state,{entryId:v.entry.id,version:v.entry.version,variant:v.index,name,digest:tag.digest,status:'unverified',routeModelId:null,at:now()});await writeState(state)
   current.phase='done'
   return
  }
  const shown=await client.show(name)
  checkCompletion(shown.capabilities)
  current.controller.signal.throwIfAborted()
  const allocated=await prepareOllamaContext(client,name,tag.digest,current.controller.signal)
  const model={id:v.variant.models.id,name:v.variant.models.id,...ollamaContextBudget(allocated,shown.contextLength,v.variant.models.maxTokens),...ollamaReasoning(shown),input:v.variant.models.input.filter(input=>input==='text'||shown.capabilities===null||shown.capabilities.includes('vision'))}
  const owned=state.records.flatMap(item=>item.routeModelId===null?[]:[item.routeModelId])
  let routeModelId:string|null=null
  try{const managed=await ensureOllamaRoute({settings:deps.settings,credentials:deps.credentials},address,[model],owned);routeModelId=managed.includes(model.id)?model.id:null}
  catch(error){routeModelId=null;current.error=errorText(error);deps.logger.warn('Teloa 本地模型：路由写入失败（%s）',current.error)}
  upsertRecord(state,{entryId:v.entry.id,version:v.entry.version,variant:v.index,name,digest:tag.digest,status:'ready',routeModelId,...(current.error===null?{requestAddress:address.baseURL}:{}),at:now()});await writeState(state)
  current.phase='done'
 })

 const startPull=async(input:LocalModelPullInput,approved?:PullFacts,signal?:AbortSignal,expectedAddress?:string):Promise<PullJobView>=>withState(async state=>{
  signal?.throwIfAborted()
  checkAddress(state,expectedAddress)
  const requestSpec=JSON.stringify([input.entryId,input.version,input.variant,input.acknowledgeRestrictions])
  if(job?.requestId===input.requestId){
   if(job.requestSpec!==requestSpec)throw new WorkError('teloa/conflict','同一拉取请求不能更改模型或许可确认。')
   return readPullJobView(jobView(job))
  }
  const v=findVariant(input.entryId,input.variant)
  if(v.entry.version!==input.version)throw new WorkError('teloa/version-conflict','目录资源已更新，请刷新后再拉取。')
  if(v.entry.model.license.tier==='restricted'&&!input.acknowledgeRestrictions)throw new WorkError('teloa/invalid-input','该模型许可带限制，请先确认已知悉。')
  const name=v.variant.sources[0].name
  if(activePhase(job))throw new WorkError('teloa/conflict',job.name===name?'该模型正在拉取中。':'已有拉取作业在进行，一次只允许一个。')
  const address=readOllamaAddress(state.address.baseURL),client=deps.client(address)
  if(approved&&pullApprovalIdentity(approved)!==pullApprovalIdentity(factsFor(v,address,'running',null)))throw new WorkError('teloa/version-conflict','模型或 Ollama 下载目标已变化，请重新确认。')
  try{await client.version()}catch{throw new WorkError('teloa/dependency-unavailable','未检测到 Ollama，无法拉取。')}
  const free=await diskFree(address.local)
  signal?.throwIfAborted()
  if(free!==null&&free<v.variant.sizeBytes*1.1+2**30)throw new WorkError('teloa/dependency-unavailable','磁盘空间不足：该模型需要约 '+Math.ceil((v.variant.sizeBytes*1.1+2**30)/2**30)+' GiB 可用空间。')
  const controller=new AbortController()
  const current:Job={pullId:randomUUID(),requestId:input.requestId,requestSpec,name,phase:'pulling',completed:0,total:null,error:null,controller}
  job=current
  void (async()=>{
   try{
    await client.pull(name,progress=>{current.completed=progress.completed;current.total=progress.total},controller.signal)
    if(controller.signal.aborted)return
    current.phase='verifying'
    await verify(current,v,address,client)
    if(current.phase==='verifying')current.phase='done'
   }catch(error){
    if(current.phase==='cancelled'||controller.signal.aborted){current.phase='cancelled';return}
    const downloading=current.phase==='pulling'
    current.phase='failed'
    const message=errorText(error)
    current.error=downloading&&error instanceof WorkError&&error.code==='teloa/source-unavailable'?'需要联网拉取；已下载的模型仍可离线使用。（'+message+'）':message
    deps.logger.warn('Teloa 本地模型：拉取 %s 失败（%s）',name,message)
   }
  })()
  return readPullJobView(jobView(current))
 })

 const attach=async(name:string,expectedAddress?:string,requestSignal?:AbortSignal):Promise<LocalModelsOverview>=>{
  const signal=requestSignal?AbortSignal.any([requestSignal,lifetime.signal]):lifetime.signal
  return withState(async state=>{
   signal.throwIfAborted()
   checkAddress(state,expectedAddress)
   if(activePhase(job)&&job.name===name)throw new WorkError('teloa/conflict','该模型正在拉取中。')
   const address=readOllamaAddress(state.address.baseURL),client=deps.client(address)
   const tags=await client.tags().catch(()=>{throw new WorkError('teloa/dependency-unavailable','未检测到 Ollama，无法接入。')})
   const tag=tags.find(item=>item.name===name)
   if(!tag)throw new WorkError('teloa/source-unavailable','Ollama 里没有这个模型。')
   const shown=await client.show(name)
   checkCompletion(shown.capabilities)
   const allocated=await prepareOllamaContext(client,name,tag.digest,signal)
   const model={id:name,name,...ollamaContextBudget(allocated,shown.contextLength,4096),...ollamaReasoning(shown),input:shown.capabilities?.includes('vision')?['text','image'] as ('text'|'image')[]:['text'] as ('text'|'image')[]}
   const owned=state.records.flatMap(item=>item.routeModelId===null?[]:[item.routeModelId])
   const managed=await ensureOllamaRoute({settings:deps.settings,credentials:deps.credentials},address,[model],owned)
   const v=variants().find(item=>item.variant.sources[0].name===name)
   upsertRecord(state,{entryId:v?.entry.id??null,version:v?.entry.version??null,variant:v?.index??null,name,digest:tag.digest,status:'attached',routeModelId:managed.includes(name)?name:null,requestAddress:address.baseURL,at:now()})
   await writeState(state)
   return overview(state)
  })
 }

 /** 先删路由再删模型（规格 §6.5）：两步任一失败保留另一步状态并报错，不留下「路由指向已删模型」。 */
 const remove=async(name:string,expectedAddress?:string):Promise<LocalModelsOverview>=>{
  return withState(async state=>{
   checkAddress(state,expectedAddress)
   if(activePhase(job)&&job.name===name)throw new WorkError('teloa/conflict','该模型正在拉取中，请先取消。')
   const address=readOllamaAddress(state.address.baseURL),client=deps.client(address)
   const record=state.records.find(item=>item.name===name)
   if(!record?.routeModelId&&ollamaRouteHasModel(deps.settings,address,name))throw new WorkError('teloa/conflict','模型仍由你自行配置的路由引用，请先在模型设置中移除引用。')
   if(record&&record.routeModelId!==null){
    await removeFromOllamaRoute({settings:deps.settings,credentials:deps.credentials},record.routeModelId,address)
    record.routeModelId=null
    await writeState(state)
   }
   try{await client.remove(name)}
   catch(error){
    if(error instanceof WorkError&&error.code==='teloa/invalid-host-response')throw new WorkError('teloa/source-unavailable','Ollama 里没有这个模型或删除被拒绝；路由已移除。')
    throw error
   }
   state.records=state.records.filter(item=>item.name!==name)
   await writeState(state)
   return overview(state)
  })
 }

 const checkAddress=(state:State,expected:string|undefined)=>{
  if(expected!==undefined&&state.address.baseURL!==expected)throw new WorkError('teloa/version-conflict','Ollama 目标已变化，请刷新并重新确认。')
 }

 const setAddress=async(baseURL:string|null):Promise<LocalModelsOverview>=>{
  return withState(async state=>{
   if(activePhase(job))throw new WorkError('teloa/conflict','拉取进行中不能更改 Ollama 地址。')
   const next=readOllamaAddress(baseURL??OLLAMA_DEFAULT_ADDRESS).baseURL
   // 换服务后旧记录不能授权删除新服务的同名路由；保留历史，但重新接入前不再持有管理权。
   if(state.address.baseURL!==next)for(const record of state.records)record.routeModelId=null
   state.address={baseURL:next,custom:baseURL!==null,updatedAt:now()}
   await writeState(state)
   return overview(state)
  })
 }

 const handle=async(endpoint:string,payload:unknown,_signal?:AbortSignal):Promise<unknown>=>{
  if(!(localModelEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此本地模型接口。')
  if(endpoint==='local-models/overview'){taskInput(payload,[]);return withState(overview)}
  if(endpoint==='local-models/address')return setAddress(readLocalModelAddressInput(payload).baseURL)
  if(endpoint==='local-models/pull'){const {expectedAddress,...input}=readLocalModelPullRequest(payload);return startPull(input,undefined,_signal,expectedAddress)}
  if(endpoint==='local-models/pull-status'){taskInput(payload,[]);return job===null?null:readPullJobView(jobView(job))}
  if(endpoint==='local-models/pull-cancel'){
   const {name}=readLocalModelNameInput(payload)
   // 加载可能较久；先中止网络等待，再串行确认，不能排在加载锁后才 abort。
   const cancelling=job
   if(activePhase(cancelling)&&cancelling.name===name)cancelling.controller.abort()
   return withState(()=>{
    if(cancelling?.name===name&&cancelling.phase==='cancelled')return readPullJobView(jobView(cancelling))
    if(!activePhase(job)||job.name!==name)throw new WorkError('teloa/not-found','没有进行中的拉取作业。')
    job.phase='cancelled';job.controller.abort()
    return readPullJobView(jobView(job))
   })
  }
  const {name,expectedAddress}=readLocalModelTargetNameInput(payload)
  if(endpoint==='local-models/attach')return attach(name,expectedAddress,_signal)
  return remove(name,expectedAddress)
 }

 // 下载可立即取消；核对写入与关闭串行，避免半写入时把已完成的操作误报为取消。
 const dispose=async()=>{
  lifetime.abort()
  if(activePhase(job))job.controller.abort()
  await queue
 }
 /** 每次请求重验已获本人批准的模型；普通用户自建路由不被 Teloa 接管。 */
 const requestCapacity=async(config:LlmCallConfig,signal:AbortSignal,load=false):Promise<number|null>=>{
  if(config.provider!=='ollama')return null
  const combined=AbortSignal.any([signal,lifetime.signal])
  return abortable(withState(async state=>{
   combined.throwIfAborted()
   const record=state.records.find(row=>row.name===config.model&&(row.routeModelId===row.name||row.requestAddress!==undefined))
   if(!record)return null
   const address=readOllamaAddress(state.address.baseURL)
   if(record.requestAddress!==undefined&&record.requestAddress!==address.baseURL)throw new WorkError('teloa/version-conflict','模型接入地址已变化，请重新核对并接入。')
   const before=readOllamaRequestRoute(deps.settings,address,record.name)
   let allocated:number
   try{allocated=await (load?prepareOllamaContext:inspectOllamaContext)(deps.client(address),record.name,record.digest,combined)}
   catch(error){
    combined.throwIfAborted()
    // 仅已知服务故障进入原生兜底；版本/权限/配置错误保持原样，不能被云端成功掩盖。
    if(error instanceof OllamaHttpError)throw new LlmError('本地模型服务拒绝请求。',error.status===401||error.status===403?'AUTH':error.status===404?'UNKNOWN_MODEL':error.status===429?'RATE_LIMIT':error.status>=500?'SERVER':'INVALID_REQUEST')
    if(error instanceof WorkError&&error.code==='teloa/dependency-unavailable')throw new LlmError('本地模型服务连接失败。','TRANSPORT')
    if(error instanceof WorkError&&error.code==='teloa/source-unavailable')throw new LlmError('本地模型实际容量暂不可核实。','SERVER')
    // 终审 Minor 1：运行时不报告容量属版本/配置问题，按不可恢复请求错误结束，不切远程。
    if(error instanceof WorkError&&error.code==='teloa/source-invalid')throw new LlmError(error.message,'INVALID_REQUEST')
    throw error
   }
   combined.throwIfAborted()
   const budget=ollamaContextBudget(allocated,before.contextWindow??null,before.maxTokens??Math.max(1,Math.floor(allocated/2)))
   if(record.routeModelId!==null)await tightenOllamaRequestRoute(deps.settings,address,record.name,before.fingerprint,budget.contextWindow,budget.maxTokens,combined)
   else if(readOllamaRequestRoute(deps.settings,address,record.name).fingerprint!==before.fingerprint)throw new WorkError('teloa/version-conflict','模型配置在容量核对期间发生变化，请重试。')
   combined.throwIfAborted()
   return budget.contextWindow
  }),combined)
 }
 const prepareRequest=async(config:LlmCallConfig,signal:AbortSignal):Promise<LlmCallConfig>=>{
  const capacity=await requestCapacity(config,signal,true)
  return capacity===null?config:{...config,maxTokens:Math.min(config.maxTokens??Number.MAX_SAFE_INTEGER,Math.max(1,Math.floor(capacity/2)))}
 }
 return {handle,pullFacts,startPull,prepareRequest,requestCapacity,dispose}
}
