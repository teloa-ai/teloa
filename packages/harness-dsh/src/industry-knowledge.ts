import {WorkError,isRecord,isWorkResource,taskInput} from '@teloa/contract'
import type {IndustryKnowledgeInstance} from '@teloa/backend'

type Ports={instantiate:(owner:string,input:unknown)=>Promise<unknown>;get:(owner:string,input:unknown)=>Promise<unknown>;list:(owner:string,input:unknown)=>Promise<unknown>}
export const industryKnowledgeEndpoints=['industry-knowledge/instantiate','industry-knowledge/get','industry-knowledge/list'] as const
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const text=(v:unknown,max:number):v is string=>typeof v==='string'&&!!v.trim()&&v.length<=max
const integer=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const invalid=()=>new WorkError('teloa/invalid-host-response','行业知识回包的身份、范围或实际资料状态不一致。')
const exact=(v:unknown,keys:string[])=>{if(!isRecord(v)||Object.keys(v).some(key=>!keys.includes(key)))throw invalid();return v}
function read(value:unknown,owner:string):IndustryKnowledgeInstance{
 const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','title','scope','sourceId','sourceVersion','revision','state','resource','failure','createdAt','updatedAt'])
 if(!uuid(row.id)||row.ownerId!==owner||!uuid(row.loadId)||!uuid(row.itemInstanceId)||typeof row.itemLocalId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(row.itemLocalId)||!text(row.title,200)||!text(row.scope,80)||row.sourceId!==`industry_${row.loadId.toLowerCase()}_${row.itemInstanceId.toLowerCase()}`||typeof row.sourceVersion!=='string'||!/^[a-f0-9]{64}$/.test(row.sourceVersion)||!integer(row.revision)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw invalid()
 if(row.state==='active'||row.state==='withdrawn'){
  const resource=exact(row.resource,['id','ownerId','title','sourceId','sourceVersion','scopeIds','version','status','createdAt','updatedAt'])
  if(!isWorkResource(resource)||!integer(resource.version)||!stamp(resource.createdAt)||!stamp(resource.updatedAt)||resource.updatedAt<resource.createdAt||resource.ownerId!==owner||resource.title!==row.title||resource.sourceId!==row.sourceId||resource.sourceVersion!==row.sourceVersion||resource.scopeIds.length!==1||resource.scopeIds[0]!==row.scope||resource.status!==row.state||row.failure!==null)throw invalid()
 }else if(row.state==='pending'||row.state==='failed'){
  if(row.resource!==null)throw invalid()
  if(row.state==='pending'){if(row.failure!==null)throw invalid()}
  else{const failure=exact(row.failure,['code','message']);if(typeof failure.code!=='string'||!/^teloa\/[a-z0-9-]+$/.test(failure.code)||!text(failure.message,2000))throw invalid()}
 }else throw invalid()
 return row as unknown as IndustryKnowledgeInstance
}
export function createIndustryKnowledgeHandler(owner:string,get:()=>Promise<Ports>){
 return async(method:string,payload:unknown):Promise<IndustryKnowledgeInstance|{items:IndustryKnowledgeInstance[]}>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-knowledge/list'){
   taskInput(payload,[])
   const result=exact(await(await get()).list(owner,payload),['items']);if(!Array.isArray(result.items))throw invalid()
   const items=result.items.map(item=>read(item,owner)),ids=new Set<string>(),mappings=new Set<string>(),resources=new Set<string>()
   for(const item of items){const key=item.loadId.toLowerCase()+'/'+item.itemInstanceId.toLowerCase(),id=item.id.toLowerCase();if(ids.has(id)||mappings.has(key)||item.resource&&resources.has(item.resource.id.toLowerCase()))throw invalid();ids.add(id);mappings.add(key);if(item.resource)resources.add(item.resource.id.toLowerCase())}
   return {items}
  }
  if(method==='industry-knowledge/get'){
   const input=taskInput(payload,['instanceId']);if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','实例身份必须是 UUID。')
   const result=read(await(await get()).get(owner,payload),owner);if(result.id.toLowerCase()!==input.instanceId.toLowerCase())throw invalid();return result
  }
  if(method==='industry-knowledge/instantiate'){
   const input=taskInput(payload,['requestId','loadId','itemInstanceId']);if(!uuid(input.requestId)||!uuid(input.loadId)||!uuid(input.itemInstanceId))throw new WorkError('teloa/invalid-input','行业知识请求身份必须是 UUID。')
   const result=read(await(await get()).instantiate(owner,payload),owner);if(result.loadId.toLowerCase()!==input.loadId.toLowerCase()||result.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase())throw invalid();return result
  }
  throw new WorkError('teloa/invalid-input','不支持的行业知识操作。')
 }
}
