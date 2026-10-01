import {WorkError,isRecord,readIndustryUpdateChoices,taskInput} from '@teloa/contract'
import type {IndustryLoadRecord,IndustryLoadPage} from '@teloa/backend'

type Ports={create:(owner:string,input:unknown)=>Promise<unknown>;get:(owner:string,input:unknown)=>Promise<unknown>;list:(owner:string,input:unknown)=>Promise<unknown>;unload:(owner:string,input:unknown)=>Promise<unknown>;upgrade:(owner:string,input:unknown)=>Promise<unknown>}
export const industryLoadEndpoints=['industry-loads/create','industry-loads/get','industry-loads/list','industry-loads/unload','industry-loads/upgrade'] as const
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-host-response','行业模板加载回包包含无效身份或资源映射。')
const exact=(value:unknown,keys:string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const kinds=['role','knowledge','skill','mcp','plugin','data-source','execution-tool','work-template','plan','object-type','business-view','business-action','business-configuration']
const statuses=['active','unloaded','superseded']
const relationTargets:Record<string,string[]>={'role-knowledge':['knowledge'],'role-skill':['skill'],'role-connection':['mcp','data-source','execution-tool'],'role-work':['work-template','plan']}

function read(value:unknown,owner:string):IndustryLoadRecord{
 try{
  const row=exact(value,['id','ownerId','contentId','contentHash','templateId','templateVersion','templateTitle','domain','scope','description','targetVersion','space','items','relations','entrypoints','createdAt','mappingHash','status','unloadedAt','upgrade'])
  if(!uuid(row.id)||row.ownerId!==owner||!uuid(row.contentId)||!hash(row.contentHash)||!stable(row.templateId)||!version(row.templateVersion)||!text(row.templateTitle,120)||!text(row.domain,80)||!text(row.scope,80)||!text(row.description,2000)||typeof row.createdAt!=='string'||!Number.isFinite(Date.parse(row.createdAt))||new Date(row.createdAt).toISOString()!==row.createdAt)throw invalid()
  // 卸载时刻只在已卸载的加载上出现，且不能早于加载时刻。
  if(!hash(row.mappingHash)||!statuses.some(status=>status===row.status))throw invalid()
  if(row.status==='unloaded'){if(!stamp(row.unloadedAt)||(row.unloadedAt as string)<row.createdAt)throw invalid()}else if(row.unloadedAt!==undefined)throw invalid()
  // 升级血缘只出现在继任加载上：被替代的加载身份、它的模板版本、当时固定的选择与差异摘要缺一不可。
  const upgrade=row.upgrade===undefined?undefined:exact(row.upgrade,['loadId','templateVersion','choices','diffDigest','createdAt'])
  if(upgrade){
   if(!uuid(upgrade.loadId)||upgrade.loadId.toLowerCase()===String(row.id).toLowerCase()||!version(upgrade.templateVersion)||!hash(upgrade.diffDigest)||!stamp(upgrade.createdAt)||(upgrade.createdAt as string)<row.createdAt)throw invalid()
   readIndustryUpdateChoices(upgrade.choices)
  }
  // `space.scope` 与加载的 scope 都是业务范围标签，不再由空间身份拼出。
  const space=exact(row.space,['id','name','version','scope']);if(!uuid(space.id)||!text(space.scope,80)||!text(space.name,80)||!positive(space.version)||!positive(row.targetVersion)||space.version<row.targetVersion)throw invalid()
  if(space.scope!==row.scope)throw invalid()
  if(!Array.isArray(row.items)||!row.items.length||row.items.length>500||!Array.isArray(row.relations)||row.relations.length>2000||!Array.isArray(row.entrypoints)||row.entrypoints.length>500)throw invalid()
  const localIds=new Set<string>(),instances=new Map<string,string>(),carried=new Set<string>()
  for(const value of row.items){
   const item=exact(value,['localId','instanceId','kind','title','version','required','status','carriedFrom'])
   if(!stable(item.localId)||localIds.has(item.localId)||!uuid(item.instanceId)||instances.has(item.instanceId.toLowerCase())||typeof item.kind!=='string'||!kinds.includes(item.kind)||!text(item.title,120)||!version(item.version)||typeof item.required!=='boolean'||!['pending-adapter','skipped','instantiated','active','detached'].some(status=>status===item.status)||item.required&&item.status==='skipped')throw invalid()
   // 沿用来源只在继任加载上出现，且必须指向本加载之外的实例身份。
   if(item.carriedFrom!==undefined&&(!upgrade||!uuid(item.carriedFrom)||carried.has(item.carriedFrom.toLowerCase())))throw invalid()
   if(item.carriedFrom!==undefined)carried.add(item.carriedFrom.toLowerCase())
   localIds.add(item.localId);instances.set(item.instanceId.toLowerCase(),item.kind)
  }
  for(const value of carried)if(instances.has(value))throw invalid()
  const links=new Set<string>()
  for(const value of row.relations){
   const link=exact(value,['kind','from','to'])
   if(typeof link.kind!=='string'||!uuid(link.from)||!uuid(link.to)||instances.get(link.from.toLowerCase())!=='role'||!relationTargets[link.kind]?.includes(instances.get(link.to.toLowerCase())??''))throw invalid()
   const key=JSON.stringify([link.kind,link.from.toLowerCase(),link.to.toLowerCase()]);if(links.has(key))throw invalid();links.add(key)
  }
  const entries=new Set<string>()
  for(const entry of row.entrypoints){if(!uuid(entry)||entries.has(entry.toLowerCase())||!['skill','work-template'].includes(instances.get(entry.toLowerCase())??''))throw invalid();entries.add(entry.toLowerCase())}
  return row as unknown as IndustryLoadRecord
 }catch{throw invalid()}
}

export type IndustryLoadUpgradeResult={superseded:IndustryLoadRecord;successor:IndustryLoadRecord}
export function createIndustryLoadsHandler(owner:string,get:()=>Promise<Ports>){
 return async(method:string,payload:unknown):Promise<IndustryLoadRecord|IndustryLoadPage|IndustryLoadUpgradeResult>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-loads/list'){
   const input=taskInput(payload,['includeUnloaded'])
   if(input.includeUnloaded!==undefined&&typeof input.includeUnloaded!=='boolean')throw new WorkError('teloa/invalid-input','是否包含已卸载加载必须是布尔值。')
   const result=exact(await (await get()).list(owner,payload),['items']);if(!Array.isArray(result.items))throw invalid()
   const items=result.items.map(item=>read(item,owner));if(new Set(items.map(item=>item.id.toLowerCase())).size!==items.length)throw invalid()
   if(input.includeUnloaded!==true&&items.some(item=>item.status!=='active'))throw invalid()
   return {items}
  }
  if(method==='industry-loads/get'){
   const input=taskInput(payload,['loadId']);if(!uuid(input.loadId))throw new WorkError('teloa/invalid-input','加载身份必须是 UUID。')
   const result=read(await (await get()).get(owner,payload),owner);if(result.id.toLowerCase()!==input.loadId.toLowerCase())throw invalid();return result
  }
  if(method==='industry-loads/create'){
   const input=taskInput(payload,['requestId','contentId','contentHash','target']),target=taskInput(input.target,['kind','spaceId','name','expectedVersion'])
   if(!uuid(input.requestId)||!uuid(input.contentId)||!hash(input.contentHash)||!uuid(target.spaceId))throw new WorkError('teloa/invalid-input','加载请求身份或来源摘要无效。')
   if(target.kind==='new'){taskInput(target,['kind','spaceId','name']);if(!text(target.name,80))throw new WorkError('teloa/invalid-input','请填写空间名称。')}
   else if(target.kind==='existing'){taskInput(target,['kind','spaceId','expectedVersion']);if(!positive(target.expectedVersion))throw new WorkError('teloa/invalid-input','目标空间版本无效。')}
   else throw new WorkError('teloa/invalid-input','目标空间类型无效。')
   const result=read(await (await get()).create(owner,payload),owner)
   if(result.contentId.toLowerCase()!==input.contentId.toLowerCase()||result.contentHash!==input.contentHash||result.space.id.toLowerCase()!==target.spaceId.toLowerCase())throw invalid()
   return result
  }
  if(method==='industry-loads/unload'){
   const input=taskInput(payload,['requestId','loadId','expectedMappingHash'])
   if(!uuid(input.requestId)||!uuid(input.loadId)||!hash(input.expectedMappingHash))throw new WorkError('teloa/invalid-input','卸载请求身份或映射指纹无效。')
   const result=read(await (await get()).unload(owner,payload),owner)
   if(result.id.toLowerCase()!==input.loadId.toLowerCase()||result.status!=='unloaded')throw invalid()
   return result
  }
  if(method==='industry-loads/upgrade'){
   const input=taskInput(payload,['requestId','loadId','candidateContentId','expectedMappingHash','choices'])
   if(!uuid(input.requestId)||!uuid(input.loadId)||!uuid(input.candidateContentId)||!hash(input.expectedMappingHash))throw new WorkError('teloa/invalid-input','升级请求身份、候选内容或映射指纹无效。')
   try{readIndustryUpdateChoices(input.choices)}catch{throw new WorkError('teloa/invalid-input','升级处理方式格式不正确。')}
   const result=exact(await (await get()).upgrade(owner,payload),['superseded','successor'])
   const superseded=read(result.superseded,owner),successor=read(result.successor,owner)
   // 继任链必须闭合：旧加载已被替代、继任加载仍在生效、升级血缘指回旧加载且落在同一业务空间。
   if(superseded.id.toLowerCase()!==input.loadId.toLowerCase()||superseded.status!=='superseded')throw invalid()
   if(successor.status!=='active'||successor.contentId.toLowerCase()!==input.candidateContentId.toLowerCase())throw invalid()
   if(successor.upgrade?.loadId.toLowerCase()!==superseded.id.toLowerCase()||successor.upgrade.templateVersion!==superseded.templateVersion||successor.space.id.toLowerCase()!==superseded.space.id.toLowerCase())throw invalid()
   return {superseded,successor}
  }
  throw new WorkError('teloa/invalid-input','不支持的行业加载操作。')
 }
}
