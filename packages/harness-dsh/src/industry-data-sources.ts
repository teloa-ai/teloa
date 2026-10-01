import {WorkError,isRecord,taskInput} from '@teloa/contract'
import type {IndustryDataSourceInstance,IndustryInstanceListError} from '@teloa/backend'

type Ports={instantiate:(owner:string,input:unknown)=>Promise<unknown>;get:(owner:string,input:unknown)=>Promise<unknown>;list:(owner:string,input:unknown)=>Promise<unknown>;authorize:(owner:string,input:unknown,signal:AbortSignal)=>Promise<unknown>}
export const industryDataSourceEndpoints=['industry-data-sources/instantiate','industry-data-sources/get','industry-data-sources/list','industry-data-sources/authorize'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const advanceable=(value:unknown):value is number=>positive(value)&&Number(value)<2147483647
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const portId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-host-response','行业数据源回包的身份、固定映射或授权状态不一致。')
const exact=(value:unknown,keys:string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}

/**
 * 来源已漂移的实例被投影回初始态但仍带着已冻结的绑定，因此「是否应有绑定」按 `drift` 而非状态判断；
 * `drift` 只能是字面 `true`，且只会出现在初始态上。
 * 已解除（`detached`）的实例保留解除前的绑定：空与非空两种形态都合法，修订恒 ≥2。
 */
const bound=(row:Record<string,unknown>,initial:string):boolean=>{
 if(row.drift!==undefined&&(row.drift!==true||row.state!==initial))throw invalid()
 if(row.state==='detached'){if(Number(row.revision)<2)throw invalid();return row.binding!==null}
 return row.state!==initial||row.drift===true
}

function read(value:unknown,owner:string):IndustryDataSourceInstance{
 const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','contentId','contentHash','itemVersion','scope','state','revision','binding','createdAt','updatedAt','drift'])
 if(!uuid(row.id)||row.ownerId!==owner||!uuid(row.loadId)||!uuid(row.itemInstanceId)||!stable(row.itemLocalId)||!uuid(row.contentId)||!hash(row.contentHash)||!version(row.itemVersion)||!text(row.scope,80)||!['needs_authorization','active','detached'].some(state=>state===row.state)||!positive(row.revision)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw invalid()
 if(!bound(row,'needs_authorization')){
  if(row.binding!==null||row.state!=='detached'&&row.revision!==1)throw invalid()
 }else{
  const binding=exact(row.binding,['sourceId','scopes','definitionHash','probedAt'])
  if(Number(row.revision)<2||!portId(binding.sourceId)||!Array.isArray(binding.scopes)||!binding.scopes.length||binding.scopes.some(scope=>!text(scope,120))||!hash(binding.definitionHash)||!stamp(binding.probedAt))throw invalid()
 }
 return row as unknown as IndustryDataSourceInstance
}

/** 目录的逐行失败项：只接受两种既定错误码与本人目录内未出现过的实例身份。 */
function readErrors(value:unknown,items:Set<string>):IndustryInstanceListError[]{
 if(!Array.isArray(value)||!value.length)throw invalid()
 const seen=new Set<string>()
 return value.map(entry=>{
  const row=exact(entry,['instanceId','code'])
  if(!uuid(row.instanceId)||row.code!=='teloa/storage-corrupt'&&row.code!=='teloa/source-unavailable')throw invalid()
  const id=row.instanceId.toLowerCase();if(seen.has(id)||items.has(id))throw invalid();seen.add(id)
  return {instanceId:row.instanceId,code:row.code}
 })
}

export function createIndustryDataSourceHandler(owner:string,get:()=>Promise<Ports>){
 return async(method:string,payload:unknown,signal=new AbortController().signal):Promise<IndustryDataSourceInstance|{items:IndustryDataSourceInstance[];errors?:IndustryInstanceListError[]}>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-data-sources/list'){
   taskInput(payload,[])
   const result=exact(await(await get()).list(owner,payload),['items','errors'])
   if(!Array.isArray(result.items))throw invalid()
   const items=result.items.map(item=>read(item,owner)),ids=new Set<string>(),mappings=new Set<string>()
   for(const item of items){const id=item.id.toLowerCase(),mapping=item.loadId.toLowerCase()+'/'+item.itemInstanceId.toLowerCase();if(ids.has(id)||mappings.has(mapping))throw invalid();ids.add(id);mappings.add(mapping)}
   return {items,...(result.errors===undefined?{}:{errors:readErrors(result.errors,ids)})}
  }
  if(method==='industry-data-sources/get'){
   const input=taskInput(payload,['instanceId'])
   if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','行业数据源实例身份必须是 UUID。')
   const result=read(await(await get()).get(owner,payload),owner)
   if(result.id.toLowerCase()!==input.instanceId.toLowerCase())throw invalid()
   return result
  }
  if(method==='industry-data-sources/instantiate'){
   const input=taskInput(payload,['requestId','loadId','itemInstanceId'])
   if(!uuid(input.requestId)||!uuid(input.loadId)||!uuid(input.itemInstanceId))throw new WorkError('teloa/invalid-input','行业数据源请求身份必须是 UUID。')
   const result=read(await(await get()).instantiate(owner,payload),owner)
   if(result.loadId.toLowerCase()!==input.loadId.toLowerCase()||result.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase())throw invalid()
   return result
  }
  if(method==='industry-data-sources/authorize'){
   const input=taskInput(payload,['requestId','instanceId','expectedRevision'])
   if(!uuid(input.requestId)||!uuid(input.instanceId)||!advanceable(input.expectedRevision))throw new WorkError('teloa/invalid-input','行业数据源授权身份或版本无效。')
   const normalized={requestId:input.requestId.toLowerCase(),instanceId:input.instanceId.toLowerCase(),expectedRevision:input.expectedRevision}
   signal.throwIfAborted()
   const result=read(await(await get()).authorize(owner,normalized,signal),owner)
   signal.throwIfAborted()
   if(result.id.toLowerCase()!==normalized.instanceId||result.state!=='active'||result.revision!==normalized.expectedRevision+1)throw invalid()
   return result
  }
  throw new WorkError('teloa/invalid-input','不支持的行业数据源操作。')
 }
}
