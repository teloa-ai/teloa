import {WorkError} from './work-error.ts'
import {isRecord,resourceId,resourceVersion} from './resources.ts'

/**
 * 端侧中文检索试点（规格 2026-09-27 §5.2、§7.1）的跨边界契约。
 *
 * 检索范围只由服务端依据主体确定；结果不携带资料正文以外的任何路径或下载地址，
 * 模型准备状态与 DSH `SpeechPreparationState` 同形，`downloading` 多带一个 `stage`
 * 区分「运行时安装」与「模型工件下载」两段进度。
 */
/** retrieval/cancel 只取消后台索引（清补跑并等待收尾），不取消模型准备或移除已提交向量；仅本人界面调用。 */
export const retrievalEndpoints=['retrieval/status','retrieval/enroll','retrieval/remove','retrieval/reindex','retrieval/cancel','retrieval-model/status','retrieval-model/prepare','retrieval-model/cancel'] as const
export type RetrievalEndpoint=typeof retrievalEndpoints[number]
export const retrievalLimits={maxEnrollments:500,maxSourceBytes:2*1024*1024,maxChunks:50000,maxQueryChars:500,maxResults:8,maxExcerptBytes:2048,maxTotalExcerptBytes:16384,dimensions:1024,vectorBytes:4096} as const

/** 发行默认变体（关键决定 9；改默认是设计约束，扩展 runtime/assets.json 的 defaultVariant 须与之一致）。 */
export const embeddingDefaultVariant='fp32' as const
export type EmbeddingVariant='fp32'|'int8'
/**
 * 模型文件下载来源：官方 Hugging Face 或国内镜像 hf-mirror.com（第三方社区镜像）。选镜像只改写下载主机、路径不变，
 * 文件仍按固定字节数与 sha256 核对，完整性不依赖镜像；选择只作用于本次准备，不保存。
 */
export const embeddingDownloadSources=['official','hf-mirror'] as const
export type EmbeddingDownloadSource=typeof embeddingDownloadSources[number]
/** 物理内存不超过 8 GiB 的机器（M1/M2 Mac mini 8 GB 一档，未实机验证）。 */
export const embeddingLowMemoryBytes=8*1024**3
/** 内存风险提示条件：物理内存 ≤ 8 GiB 且所选变体为 fp32（本机实测 fp32 推理子进程峰值约 3.9 GB）。准备确认卡与设置页据此提示。 */
export function embeddingMemoryRisk(input:{totalMemoryBytes:number;variant:EmbeddingVariant}):boolean{
 return input.variant==='fp32'&&input.totalMemoryBytes<=embeddingLowMemoryBytes
}

/** `industryModelPhases` 的子集：嵌入服务不区分 `waking`，扩展停用或平台不支持时服务本身不存在。 */
export const embeddingPreparationPhases=['unprepared','checking','downloading','loading','ready','standby','cancelling','cancelled','failed'] as const
export type EmbeddingPreparationPhase=typeof embeddingPreparationPhases[number]
export const embeddingPreparationStages=['runtime','assets'] as const
export type EmbeddingPreparationStage=typeof embeddingPreparationStages[number]
export const embeddingDownloadFailureReasons=['network','dns','timeout','certificate','http','integrity','storage','unknown'] as const
export type EmbeddingDownloadFailure={resource:string;source:string;reason:typeof embeddingDownloadFailureReasons[number]}
export type EmbeddingPreparationState=
 |{phase:'unprepared'|'ready'|'standby'|'cancelled'}
 |{phase:'downloading';stage:EmbeddingPreparationStage;resource:string;completedBytes:number;totalBytes?:number}
 |{phase:'checking'|'loading'|'cancelling';startedAt:number}
 |{phase:'failed';message:string;download?:EmbeddingDownloadFailure}

export type RetrievalPendingReason='stale'|'building'|'failed'
export type RetrievalCoverage={
 searched:{resourceId:string;title:string;version:number}[]
 /** 只列目标范围内已加入但当前不可检索的资料；范围外资料不计数也不提示。 */
 pending:{resourceId:string;title:string;reason:RetrievalPendingReason}[]
 note:string
}
export type RetrievalSearchHit={
 resourceId:string;resourceVersion:number;title:string;sourceId:string;sourceVersion:string
 /** 分块在原文中的行区间（含首尾，从 0 起）。 */
 lines:[number,number]
 /** 分块在原文中的字符区间（半开区间，从 0 起）。 */
 chars:[number,number]
 heading:string|null
 /** 余弦相似度。 */
 score:number
 excerpt:string
}
export type RetrievalSearchResult={coverage:RetrievalCoverage;results:RetrievalSearchHit[]}

const badState=()=>new WorkError('teloa/invalid-input','本地检索模型状态格式不正确。')
const badResult=()=>new WorkError('teloa/invalid-input','检索结果格式不正确。')
const exact=(value:unknown,keys:readonly string[],optional:readonly string[],bad:()=>WorkError):Record<string,unknown>=>{
 if(!isRecord(value))throw bad()
 const present=Object.keys(value).filter(key=>value[key]!==undefined)
 if(present.some(key=>!keys.includes(key)&&!optional.includes(key))||keys.some(key=>!present.includes(key)))throw bad()
 return value
}
const label=(value:unknown,max:number):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max
const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0
const hostName=/^[A-Za-z0-9.-]{1,253}$/
/** 进度与失败里的 resource 只写相对工件路径或包名（如 `onnx/model.onnx`、`onnxruntime-node@1.30.0`），不收 URL、查询串或协议前缀。 */
const resourceName=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._@\/-]{0,199}$/.test(value)&&!value.includes('//')&&!value.includes('..')
const sourceIdPattern=/^[a-zA-Z0-9_-]{1,128}$/
const sha256=/^[a-f0-9]{64}$/
const utf8=new TextEncoder()

export function readEmbeddingPreparationState(value:unknown):EmbeddingPreparationState{
 if(!isRecord(value)||!(embeddingPreparationPhases as readonly unknown[]).includes(value.phase))throw badState()
 const phase=value.phase as EmbeddingPreparationPhase
 if(phase==='downloading'){
  const row=exact(value,['phase','stage','resource','completedBytes'],['totalBytes'],badState)
  if(!(embeddingPreparationStages as readonly unknown[]).includes(row.stage)||!resourceName(row.resource)||!count(row.completedBytes))throw badState()
  if(row.totalBytes!==undefined&&(!count(row.totalBytes)||row.completedBytes>row.totalBytes))throw badState()
  return {phase,stage:row.stage as EmbeddingPreparationStage,resource:row.resource,completedBytes:row.completedBytes,...(row.totalBytes===undefined?{}:{totalBytes:row.totalBytes})}
 }
 if(phase==='checking'||phase==='loading'||phase==='cancelling'){
  const row=exact(value,['phase','startedAt'],[],badState)
  if(!count(row.startedAt))throw badState()
  return {phase,startedAt:row.startedAt}
 }
 if(phase==='failed'){
  const row=exact(value,['phase','message'],['download'],badState)
  if(!label(row.message,500))throw badState()
  if(row.download===undefined)return {phase,message:row.message}
  const download=exact(row.download,['resource','source','reason'],[],badState)
  // 来源只写主机名，避免把带凭据或查询参数的下载地址带进界面与日志。
  if(!resourceName(download.resource)||typeof download.source!=='string'||!hostName.test(download.source)||!(embeddingDownloadFailureReasons as readonly unknown[]).includes(download.reason))throw badState()
  return {phase,message:row.message,download:{resource:download.resource,source:download.source,reason:download.reason as EmbeddingDownloadFailure['reason']}}
 }
 exact(value,['phase'],[],badState)
 return {phase}
}

function readCoverage(value:unknown):RetrievalCoverage{
 const row=exact(value,['searched','pending','note'],[],badResult)
 if(!label(row.note,500)||!Array.isArray(row.searched)||!Array.isArray(row.pending)||row.searched.length>retrievalLimits.maxEnrollments||row.pending.length>retrievalLimits.maxEnrollments)throw badResult()
 const seen=new Set<string>()
 const claim=(id:string)=>{if(seen.has(id))throw badResult();seen.add(id)}
 const searched=row.searched.map(item=>{
  const r=exact(item,['resourceId','title','version'],[],badResult)
  if(!resourceId(r.resourceId)||!label(r.title,200)||!resourceVersion(r.version))throw badResult()
  claim(r.resourceId)
  return {resourceId:r.resourceId,title:r.title,version:r.version}
 })
 const pending=row.pending.map(item=>{
  const r=exact(item,['resourceId','title','reason'],[],badResult)
  if(!resourceId(r.resourceId)||!label(r.title,200)||(r.reason!=='stale'&&r.reason!=='building'&&r.reason!=='failed'))throw badResult()
  claim(r.resourceId)
  return {resourceId:r.resourceId,title:r.title,reason:r.reason as RetrievalPendingReason}
 })
 return {searched,pending,note:row.note}
}

const range=(value:unknown,strict:boolean):value is [number,number]=>Array.isArray(value)&&value.length===2&&count(value[0])&&count(value[1])&&(strict?value[0]<value[1]:value[0]<=value[1])

/** 命中只能来自 `coverage.searched` 中的资料且版本一致；摘录按 UTF-8 字节限额，逐条与总量都受限。 */
export function readRetrievalSearchResult(value:unknown):RetrievalSearchResult{
 const row=exact(value,['coverage','results'],[],badResult)
 const coverage=readCoverage(row.coverage)
 if(!Array.isArray(row.results)||row.results.length>retrievalLimits.maxResults)throw badResult()
 const searched=new Map(coverage.searched.map(item=>[item.resourceId,item.version]))
 let totalBytes=0
 const results=row.results.map(item=>{
  const r=exact(item,['resourceId','resourceVersion','title','sourceId','sourceVersion','lines','chars','heading','score','excerpt'],[],badResult)
  if(!resourceId(r.resourceId)||!resourceVersion(r.resourceVersion)||searched.get(r.resourceId)!==r.resourceVersion)throw badResult()
  if(!label(r.title,200)||typeof r.sourceId!=='string'||!sourceIdPattern.test(r.sourceId)||typeof r.sourceVersion!=='string'||!sha256.test(r.sourceVersion))throw badResult()
  if(!range(r.lines,false)||!range(r.chars,true))throw badResult()
  if(r.heading!==null&&!label(r.heading,200))throw badResult()
  if(typeof r.score!=='number'||!Number.isFinite(r.score)||r.score<-1||r.score>1)throw badResult()
  if(typeof r.excerpt!=='string'||!r.excerpt.trim())throw badResult()
  const bytes=utf8.encode(r.excerpt).byteLength
  totalBytes+=bytes
  if(bytes>retrievalLimits.maxExcerptBytes||totalBytes>retrievalLimits.maxTotalExcerptBytes)throw badResult()
  return {resourceId:r.resourceId,resourceVersion:r.resourceVersion,title:r.title,sourceId:r.sourceId,sourceVersion:r.sourceVersion,lines:[r.lines[0],r.lines[1]] as [number,number],chars:[r.chars[0],r.chars[1]] as [number,number],heading:r.heading as string|null,score:r.score,excerpt:r.excerpt}
 })
 return {coverage,results}
}
