import {isRecord,resourceTitle,embeddingProviderIds,readEmbeddingPreparationState,readRetrievalPreparationDetails,readRetrievalPrepareInput,WorkError,type EmbeddingProviderId,type EmbeddingDownloadSource,type EmbeddingPreparationState,type RetrievalPreparationDetails,type RetrievalPreparationExpected} from '@teloa/contract'

export type RetrievalProvider={id:string;location:'host-local';catalogId:string;catalogVersion:string;profileHash:string;variant:'fp32'|'int8'|'ollama';totalMemoryBytes:number;memoryRisk:boolean;preparation:EmbeddingPreparationState;preparationDetails?:RetrievalPreparationDetails}
export type RetrievalModelStatus={enabled:boolean;provider:RetrievalProvider|null;building:boolean;guidance:string|null;selectedProviderId?:EmbeddingProviderId}
export type RetrievalItem={sourceId:string;resourceId:string|null;title:string|null;version:number|null;state:'building'|'ready'|'failed'|'stale'|'unavailable';chunkCount:number|null}
export type RetrievalStatus={items:RetrievalItem[];enrolled:number;chunks:number;building:boolean}
const invalid=()=>new WorkError('teloa/invalid-host-response','本地检索服务返回的内容格式不正确。')
const text=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&!/[\p{Cc}\p{Cf}]/u.test(v)
const count=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
function exact(v:unknown,keys:string[],optional:string[]=[]):Record<string,unknown>{if(!isRecord(v)||keys.some(k=>!(k in v))||Object.keys(v).some(k=>!keys.includes(k)&&!optional.includes(k)))throw invalid();return v}
export function readRetrievalModelStatus(value:unknown):RetrievalModelStatus{
 const row=exact(value,['enabled','provider','building','guidance'],['selectedProviderId'])
 if(row.selectedProviderId!==undefined&&!(embeddingProviderIds as readonly unknown[]).includes(row.selectedProviderId))throw invalid()
 if(typeof row.enabled!=='boolean'||typeof row.building!=='boolean'||!(row.guidance===null||text(row.guidance)))throw invalid()
 let provider:RetrievalProvider|null=null
 if(row.provider!==null){
  const p=exact(row.provider,['id','location','catalogId','catalogVersion','profileHash','variant','totalMemoryBytes','memoryRisk','preparation'],['preparationDetails'])
  if(!row.enabled||!text(p.id)||p.location!=='host-local'||!text(p.catalogId)||!text(p.catalogVersion)||typeof p.profileHash!=='string'||!/^[a-f0-9]{64}$/.test(p.profileHash)||(p.variant!=='fp32'&&p.variant!=='int8'&&p.variant!=='ollama')||!count(p.totalMemoryBytes)||p.totalMemoryBytes===0||typeof p.memoryRisk!=='boolean')throw invalid()
  provider={id:p.id,location:p.location,catalogId:p.catalogId,catalogVersion:p.catalogVersion,profileHash:p.profileHash,variant:p.variant,totalMemoryBytes:p.totalMemoryBytes,memoryRisk:p.memoryRisk,preparation:readEmbeddingPreparationState(p.preparation),...(p.preparationDetails===undefined?{}:{preparationDetails:readRetrievalPreparationDetails(p.preparationDetails)})}
 }
 return {enabled:row.enabled,provider,building:row.building,guidance:row.guidance,...(row.selectedProviderId===undefined?{}:{selectedProviderId:row.selectedProviderId as EmbeddingProviderId})}
}
export function readRetrievalStatus(value:unknown):RetrievalStatus{
 const row=exact(value,['items','enrolled','chunks','building'])
 if(!Array.isArray(row.items)||!count(row.enrolled)||!count(row.chunks)||typeof row.building!=='boolean')throw invalid()
 const seen=new Set<string>()
 const items=row.items.map(value=>{
  const item=exact(value,['sourceId','resourceId','title','version','state','chunkCount'])
  if(!text(item.sourceId)||!['building','ready','failed','stale','unavailable'].includes(item.state as string))throw invalid()

  if(item.state==='unavailable'){if([item.resourceId,item.title,item.version,item.chunkCount].some(v=>v!==null))throw invalid()}
  else if(!text(item.resourceId)||!resourceTitle(item.title)||!count(item.version)||item.version===0||!(item.chunkCount===null||count(item.chunkCount)))throw invalid()
  const identity=item.resourceId??item.sourceId
  if(seen.has(identity as string))throw invalid()
  seen.add(identity as string)
  return item as RetrievalItem
 })
 if(new Set(items.map(item=>item.sourceId)).size>row.enrolled)throw invalid()
 return {items,enrolled:row.enrolled,chunks:row.chunks,building:row.building}
}
export type LocalRetrievalApi=ReturnType<typeof createLocalRetrievalApi>
export function createLocalRetrievalApi(call:(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>){
 const model=async(endpoint:string,signal?:AbortSignal,providerId?:EmbeddingProviderId)=>readRetrievalModelStatus(await call(endpoint,providerId?{providerId}:{},signal))
 const index=async(endpoint:string,payload:unknown,signal?:AbortSignal)=>readRetrievalStatus(await call(endpoint,payload,signal))
 return {
  modelStatus:(signal?:AbortSignal,providerId?:EmbeddingProviderId)=>model('retrieval-model/status',signal,providerId),
  /** source 缺省时载荷只带 expected（即官方来源）。 */
  prepare:async(expected:RetrievalPreparationExpected,signal?:AbortSignal,source?:EmbeddingDownloadSource)=>readRetrievalModelStatus(await call('retrieval-model/prepare',readRetrievalPrepareInput(source?{expected,source}:{expected}),signal)),
  cancelPreparation:(signal?:AbortSignal,providerId?:EmbeddingProviderId)=>model('retrieval-model/cancel',signal,providerId),
  select:async(providerId:EmbeddingProviderId,profileHash:string,signal?:AbortSignal)=>readRetrievalModelStatus(await call('retrieval-model/select',{providerId,profileHash},signal)),
  status:(signal?:AbortSignal)=>index('retrieval/status',{},signal),
  enroll:(sourceId:string,signal?:AbortSignal)=>index('retrieval/enroll',{sourceIds:[sourceId]},signal),
  remove:(sourceId:string,signal?:AbortSignal)=>index('retrieval/remove',{sourceIds:[sourceId]},signal),
  reindex:(signal?:AbortSignal)=>index('retrieval/reindex',{},signal),
  cancel:(signal?:AbortSignal)=>index('retrieval/cancel',{},signal),
 }
}
