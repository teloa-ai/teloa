import {WorkError,isRecord,readIndustryPluginDefinition,readMarketPluginInstallPreview,taskInput,type MarketPluginInstallPreview} from '@teloa/contract'
import type {IndustryPluginInstance,IndustryInstanceListError} from '@teloa/backend'

type Ports={instantiate:(owner:string,input:unknown)=>Promise<unknown>;preview:(owner:string,input:unknown)=>Promise<unknown>;install:(owner:string,input:unknown)=>Promise<unknown>;enable:(owner:string,input:unknown)=>Promise<unknown>;reconcile:(owner:string,input:unknown)=>Promise<unknown>;get:(owner:string,input:unknown)=>Promise<unknown>;list:(owner:string,input:unknown)=>Promise<unknown>}
export const industryPluginEndpoints=['industry-plugins/instantiate','industry-plugins/preview','industry-plugins/install','industry-plugins/enable','industry-plugins/reconcile','industry-plugins/get','industry-plugins/list'] as const

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const advanceable=(value:unknown):value is number=>positive(value)&&Number(value)<2147483647
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
// `pending-enable`：包已装进 profile 但不在 bundles 里，等本人第二次显式启用。
const states=['needs_install','installing','pending-enable','active','restart-required','failed','detached']
const invalid=()=>new WorkError('teloa/invalid-host-response','行业扩展回包的身份、固定定义或安装状态不一致。')
const exact=(value:unknown,keys:string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}

/** 端口只能抛 WorkError：DSH 插件安装服务的非 WorkError 异常统一收敛为依赖不可用。 */
export async function guardDshPluginInstall<T>(run:()=>Promise<T>):Promise<T>{
 try{return await run()}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/dependency-unavailable','DSH 扩展安装服务不可用。')}
}

function read(value:unknown,owner:string):IndustryPluginInstance{
 const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','contentId','contentHash','itemVersion','scope','definition','definitionHash','installationId','state','revision','createdAt','updatedAt','drift'])
 if(!uuid(row.id)||row.ownerId!==owner||!uuid(row.loadId)||!uuid(row.itemInstanceId)||!stable(row.itemLocalId)||!uuid(row.contentId)||!hash(row.contentHash)||!version(row.itemVersion)||!text(row.scope,80)||!hash(row.definitionHash)||!states.some(state=>state===row.state)||!positive(row.revision)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw invalid()
 try{readIndustryPluginDefinition(row.definition)}catch{throw invalid()}
 // 来源已漂移的实例被投影回 `needs_install` 但仍带着已冻结的安装身份，故初始态不变量只在未漂移时成立。
 if(row.drift!==undefined&&(row.drift!==true||row.state!=='needs_install'))throw invalid()
 if(row.drift===true){
  if(row.installationId===null?row.revision!==1:!uuid(row.installationId)||Number(row.revision)<2)throw invalid()
 }else if(row.state==='needs_install'){
  if(row.installationId!==null||row.revision!==1)throw invalid()
 }else if(row.state==='detached'){
  // 已解除的插件保留解除前的安装身份：从登记态解除时仍为 null，从已安装态解除时仍是原安装。
  if(Number(row.revision)<2||row.installationId!==null&&!uuid(row.installationId))throw invalid()
 }else if(!uuid(row.installationId))throw invalid()
 return row as unknown as IndustryPluginInstance
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

export function createIndustryPluginHandler(owner:string,get:(signal?:AbortSignal)=>Promise<Ports>){
 return async(method:string,payload:unknown,signal=new AbortController().signal):Promise<IndustryPluginInstance|MarketPluginInstallPreview|{items:IndustryPluginInstance[];errors?:IndustryInstanceListError[]}>=>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(method==='industry-plugins/list'){
   taskInput(payload,[])
   const result=exact(await(await get()).list(owner,payload),['items','errors'])
   if(!Array.isArray(result.items))throw invalid()
   const items=result.items.map(item=>read(item,owner)),ids=new Set<string>(),mappings=new Set<string>()
   for(const item of items){const id=item.id.toLowerCase(),mapping=item.loadId.toLowerCase()+'/'+item.itemInstanceId.toLowerCase();if(ids.has(id)||mappings.has(mapping))throw invalid();ids.add(id);mappings.add(mapping)}
   return {items,...(result.errors===undefined?{}:{errors:readErrors(result.errors,ids)})}
  }
  if(method==='industry-plugins/get'){
   const input=taskInput(payload,['instanceId'])
   if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','行业扩展实例身份必须是 UUID。')
   const result=read(await(await get()).get(owner,payload),owner)
   if(result.id.toLowerCase()!==input.instanceId.toLowerCase())throw invalid()
   return result
  }
  if(method==='industry-plugins/instantiate'){
   const input=taskInput(payload,['requestId','loadId','itemInstanceId'])
   if(!uuid(input.requestId)||!uuid(input.loadId)||!uuid(input.itemInstanceId))throw new WorkError('teloa/invalid-input','行业扩展请求身份必须是 UUID。')
   const result=read(await(await get()).instantiate(owner,payload),owner)
   if(result.loadId.toLowerCase()!==input.loadId.toLowerCase()||result.itemInstanceId.toLowerCase()!==input.itemInstanceId.toLowerCase())throw invalid()
   return result
  }
  // 安装前的知情同意：把市场路径同一份预览原样交给客户端逐条展示（权限、发布者、信任、完整性摘要）。
  if(method==='industry-plugins/preview'){
   const input=taskInput(payload,['instanceId'])
   if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','行业扩展实例身份必须是 UUID。')
   signal.throwIfAborted()
   const result=await(await get(signal)).preview(owner,{instanceId:input.instanceId.toLowerCase()})
   signal.throwIfAborted()
   try{return readMarketPluginInstallPreview(result)}catch{throw invalid()}
  }
  if(method==='industry-plugins/install'){
   const input=taskInput(payload,['requestId','instanceId','expectedRevision','preview'])
   if(!uuid(input.requestId)||!uuid(input.instanceId)||!advanceable(input.expectedRevision))throw new WorkError('teloa/invalid-input','行业扩展安装请求身份或版本无效。')
   // 客户端持固定预览提交：形状先在通道口核一遍，服务端再与 registry 现取的预览逐字比对。
   let preview:MarketPluginInstallPreview
   try{preview=readMarketPluginInstallPreview(input.preview)}catch{throw new WorkError('teloa/invalid-input','行业扩展安装预览格式不正确。')}
   const normalized={requestId:input.requestId.toLowerCase(),instanceId:input.instanceId.toLowerCase(),expectedRevision:input.expectedRevision,preview}
   signal.throwIfAborted()
   const result=read(await(await get(signal)).install(owner,normalized),owner)
   signal.throwIfAborted()
   if(result.id.toLowerCase()!==normalized.instanceId||result.revision!==normalized.expectedRevision+1||result.installationId===null)throw invalid()
   return result
  }
  // 启用是本人的第二次显式动作：安装只把包装进 profile，包名不进 bundles，补丁层在启用前不参与组合。
  if(method==='industry-plugins/enable'){
   const input=taskInput(payload,['instanceId','preview'])
   if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','行业扩展实例身份必须是 UUID。')
   let preview:MarketPluginInstallPreview
   try{preview=readMarketPluginInstallPreview(input.preview)}catch{throw new WorkError('teloa/invalid-input','行业扩展启用预览格式不正确。')}
   const normalized={instanceId:input.instanceId.toLowerCase(),preview}
   signal.throwIfAborted()
   const result=read(await(await get(signal)).enable(owner,normalized),owner)
   signal.throwIfAborted()
   if(result.id.toLowerCase()!==normalized.instanceId||result.installationId===null)throw invalid()
   return result
  }
  if(method==='industry-plugins/reconcile'){
   const input=taskInput(payload,['instanceId'])
   if(!uuid(input.instanceId))throw new WorkError('teloa/invalid-input','行业扩展实例身份必须是 UUID。')
   const normalized={instanceId:input.instanceId.toLowerCase()}
   signal.throwIfAborted()
   const result=read(await(await get(signal)).reconcile(owner,normalized),owner)
   signal.throwIfAborted()
   if(result.id.toLowerCase()!==normalized.instanceId)throw invalid()
   return result
  }
  throw new WorkError('teloa/invalid-input','不支持的行业扩展操作。')
 }
}
