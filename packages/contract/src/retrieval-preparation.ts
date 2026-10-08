import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {embeddingDownloadSources,type EmbeddingDownloadSource} from './local-retrieval.ts'

/** 由随附扩展从固定 manifest/配方及宿主路径生成；不来自市场条目的展示文案。 */
export type OnnxRetrievalPreparationDetails={
 kind?:undefined
 modelName:string;license:string;upstreamRepo:string;conversionRepo:string
 modelDirectory:string;runtimeDirectory:string
 files:{path:string;source:string;bytes:number;sha256:string;shared:boolean}[]
 runtime:{package:string;version:string;source:string;integrity:string;unpackedBytesEstimate:number}
 reserveBytes:number;memoryBytesEstimate:[number,number]
 /** 确认卡上可选的下载来源（首项为官方，来自扩展固定清单）；缺省表示只能用官方来源。 */
 downloadSources?:{id:EmbeddingDownloadSource;host:string}[]
}
export type OllamaRetrievalPreparationDetails={
 kind:'ollama';modelName:string;license:string;upstreamRepo:string
 runtime:{name:'Ollama';endpoint:string;managed:false;minimumVersion:'0.40.0'}
 model:{name:string;source:string;digest:string;bytes:number}
 nativeDimensions:768;storageDimensions:1024
 downloadSources:{id:'official';host:string}[]
}
export type RetrievalPreparationDetails=OnnxRetrievalPreparationDetails|OllamaRetrievalPreparationDetails
export function readRetrievalPreparationDetails(value:unknown):RetrievalPreparationDetails{
 const bad=()=>new WorkError('teloa/invalid-host-response','本地检索准备信息格式不正确。')
 const exact=(value:unknown,keys:string[])=>{if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!(key in value)))throw bad();return value}
 const label=(value:unknown,max=4096):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\p{Cc}\p{Cf}]/u.test(value)
 const count=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>0
 if(isRecord(value)&&value.kind==='ollama'){
  const row=exact(value,['kind','modelName','license','upstreamRepo','runtime','model','nativeDimensions','storageDimensions','downloadSources'])
  if(!label(row.modelName,120)||!label(row.license,200)||row.upstreamRepo!=='https://huggingface.co/google/embeddinggemma-2'||row.nativeDimensions!==768||row.storageDimensions!==1024)throw bad()
  const runtime=exact(row.runtime,['name','endpoint','managed','minimumVersion']),model=exact(row.model,['name','source','digest','bytes'])
  let endpoint:URL
  try{endpoint=new URL(String(runtime.endpoint))}catch{throw bad()}
  if(runtime.name!=='Ollama'||runtime.managed!==false||runtime.minimumVersion!=='0.40.0'||endpoint.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(endpoint.hostname)||endpoint.username||endpoint.password||endpoint.pathname!=='/'||endpoint.search||endpoint.hash)throw bad()
  if(model.name!=='embeddinggemma-2:latest'||model.source!=='registry.ollama.ai'||typeof model.digest!=='string'||!/^sha256:[a-f0-9]{64}$/.test(model.digest)||!count(model.bytes))throw bad()
  if(!Array.isArray(row.downloadSources)||row.downloadSources.length!==1)throw bad()
  const source=exact(row.downloadSources[0],['id','host']);if(source.id!=='official'||source.host!=='registry.ollama.ai')throw bad()
  return {kind:'ollama',modelName:row.modelName,license:row.license,upstreamRepo:row.upstreamRepo,runtime:{name:'Ollama',endpoint:runtime.endpoint as string,managed:false,minimumVersion:'0.40.0'},model:{name:model.name,source:model.source,digest:model.digest,bytes:model.bytes},nativeDimensions:768,storageDimensions:1024,downloadSources:[{id:'official',host:'registry.ollama.ai'}]}
 }
 const row=exact(value,['modelName','license','upstreamRepo','conversionRepo','modelDirectory','runtimeDirectory','files','runtime','reserveBytes','memoryBytesEstimate',...(isRecord(value)&&'downloadSources' in value?['downloadSources']:[])])
 for(const key of ['modelName','license','upstreamRepo','conversionRepo','modelDirectory','runtimeDirectory'])if(!label(row[key]))throw bad()
 if(!Array.isArray(row.files)||!row.files.length||row.files.length>32||!count(row.reserveBytes)||!Array.isArray(row.memoryBytesEstimate)||row.memoryBytesEstimate.length!==2||!row.memoryBytesEstimate.every(count)||row.memoryBytesEstimate[0]!>row.memoryBytesEstimate[1]!)throw bad()
 const seen=new Set<string>()
 const files=row.files.map(value=>{
  const file=exact(value,['path','source','bytes','sha256','shared'])
  if(!label(file.path,200)||!/^[-a-zA-Z0-9_.]+(?:\/[-a-zA-Z0-9_.]+)*$/.test(file.path)||file.path.split('/').some(part=>part==='..'||part==='.')||seen.has(file.path)||!label(file.source,253)||!/^[-a-zA-Z0-9.]+$/.test(file.source)||!count(file.bytes)||typeof file.sha256!=='string'||!/^[a-f0-9]{64}$/.test(file.sha256)||typeof file.shared!=='boolean')throw bad()
  seen.add(file.path)
  return {path:file.path,source:file.source,bytes:file.bytes,sha256:file.sha256,shared:file.shared}
 })
 const runtime=exact(row.runtime,['package','version','source','integrity','unpackedBytesEstimate'])
 if(!label(runtime.package,100)||!label(runtime.version,100)||!label(runtime.source,253)||!/^[-a-zA-Z0-9.]+$/.test(runtime.source)||typeof runtime.integrity!=='string'||!/^sha512-[a-zA-Z0-9+/]+={0,2}$/.test(runtime.integrity)||!count(runtime.unpackedBytesEstimate))throw bad()
 let downloadSources:{id:EmbeddingDownloadSource;host:string}[]|undefined
 if('downloadSources' in row){
  // 来源表外形固定：首项官方、id 不重复且只取已知值、host 只是主机名（不收 URL、查询串）。
  if(!Array.isArray(row.downloadSources)||!row.downloadSources.length||row.downloadSources.length>embeddingDownloadSources.length)throw bad()
  downloadSources=row.downloadSources.map(value=>{
   const source=exact(value,['id','host'])
   if(!(embeddingDownloadSources as readonly unknown[]).includes(source.id)||!label(source.host,253)||!/^[-a-zA-Z0-9.]+$/.test(source.host))throw bad()
   return {id:source.id as EmbeddingDownloadSource,host:source.host}
  })
  if(downloadSources[0]!.id!=='official'||new Set(downloadSources.map(source=>source.id)).size!==downloadSources.length)throw bad()
 }
 return {modelName:row.modelName as string,license:row.license as string,upstreamRepo:row.upstreamRepo as string,conversionRepo:row.conversionRepo as string,modelDirectory:row.modelDirectory as string,runtimeDirectory:row.runtimeDirectory as string,files,runtime:{package:runtime.package,version:runtime.version,source:runtime.source,integrity:runtime.integrity,unpackedBytesEstimate:runtime.unpackedBytesEstimate},reserveBytes:row.reserveBytes,memoryBytesEstimate:[row.memoryBytesEstimate[0]!,row.memoryBytesEstimate[1]!],...(downloadSources?{downloadSources}:{})}
}

/** 用户实际确认的固定配置；不含会随进度变化的 preparation 状态。 */
export type RetrievalPreparationExpected={
 id:string;location:'host-local';catalogId:string;catalogVersion:string;profileHash:string;variant:'fp32'|'int8'|'ollama'
 totalMemoryBytes:number;memoryRisk:boolean;preparationDetails:RetrievalPreparationDetails
}
const invalidPreparationInput=()=>new WorkError('teloa/invalid-input','准备请求须携带完整的已确认配置，请刷新页面后重新确认。')
export function readRetrievalPreparationExpected(value:unknown):RetrievalPreparationExpected{
 const keys=['id','location','catalogId','catalogVersion','profileHash','variant','totalMemoryBytes','memoryRisk','preparationDetails']
 const label=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=200&&!/[\p{Cc}\p{Cf}]/u.test(v)
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!(key in value))||!label(value.id)||value.location!=='host-local'||!label(value.catalogId)||!label(value.catalogVersion)||typeof value.profileHash!=='string'||!/^[a-f0-9]{64}$/.test(value.profileHash)||(value.variant!=='fp32'&&value.variant!=='int8'&&value.variant!=='ollama')||typeof value.totalMemoryBytes!=='number'||!Number.isSafeInteger(value.totalMemoryBytes)||value.totalMemoryBytes<=0||typeof value.memoryRisk!=='boolean')throw invalidPreparationInput()
 let preparationDetails:RetrievalPreparationDetails
 try{preparationDetails=readRetrievalPreparationDetails(value.preparationDetails)}catch{throw invalidPreparationInput()}
 return {id:value.id,location:value.location,catalogId:value.catalogId,catalogVersion:value.catalogVersion,profileHash:value.profileHash,variant:value.variant,totalMemoryBytes:value.totalMemoryBytes,memoryRisk:value.memoryRisk,preparationDetails}
}
/** 从已读取的 provider 克隆确认内容，避免随后修改快照把用户确认对象一起改掉。 */
export function captureRetrievalPreparation(provider:Omit<RetrievalPreparationExpected,'preparationDetails'>&{preparationDetails?:RetrievalPreparationDetails}):RetrievalPreparationExpected{
 const {id,location,catalogId,catalogVersion,profileHash,variant,totalMemoryBytes,memoryRisk,preparationDetails}=provider
 return readRetrievalPreparationExpected({id,location,catalogId,catalogVersion,profileHash,variant,totalMemoryBytes,memoryRisk,preparationDetails})
}
export function sameRetrievalPreparation(a:RetrievalPreparationExpected,b:RetrievalPreparationExpected):boolean{
 return JSON.stringify(readRetrievalPreparationExpected(a))===JSON.stringify(readRetrievalPreparationExpected(b))
}
/**
 * 不兼容旧的 {} 无条件准备：缺 expected、额外键和不完整预期均拒绝。
 * 可选 source 选本次下载来源：缺省即官方且原样不补；官方始终可选，镜像只在本人确认过的来源表里才可选。
 */
export function readRetrievalPrepareInput(value:unknown):{expected:RetrievalPreparationExpected;source?:EmbeddingDownloadSource}{
 if(!isRecord(value)||!('expected' in value)||Object.keys(value).some(key=>key!=='expected'&&key!=='source'))throw invalidPreparationInput()
 const expected=readRetrievalPreparationExpected(value.expected)
 if(!('source' in value))return {expected}
 const source=value.source
 if(source!=='official'&&!expected.preparationDetails.downloadSources?.some(row=>row.id===source))throw invalidPreparationInput()
 return {expected,source:source as EmbeddingDownloadSource}
}
