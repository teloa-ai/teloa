import {recoveryStorageError} from './recovery-error.ts'
type Call=(method:string,payload:unknown)=>Promise<unknown>
export type IndustryDataSourceBinding={sourceId:string;scopes:string[];definitionHash:string;probedAt:string}
type IndustryDataSourceBase={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;createdAt:string;updatedAt:string}
/** 第三个分支是来源漂移投影：状态回落为初始态，但已冻结的绑定与 revision 原样保留；第四个是模板卸载后的终态。 */
export type IndustryDataSourceInstance=IndustryDataSourceBase&({state:'needs_authorization';revision:1;binding:null;drift?:undefined}|{state:'active';revision:number;binding:IndustryDataSourceBinding;drift?:undefined}|{state:'needs_authorization';revision:number;binding:IndustryDataSourceBinding;drift:true}|{state:'detached';revision:number;binding:IndustryDataSourceBinding|null;drift?:undefined})
export type IndustryDataSourceInstantiateInput={requestId:string;loadId:string;itemInstanceId:string}
export type IndustryDataSourceAuthorizeInput={requestId:string;instanceId:string;expectedRevision:number}
export type IndustryDataSourceJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
/** 目录的逐行失败项：只接受两种既定错误码。 */
export type IndustryInstanceListError={instanceId:string;code:'teloa/storage-corrupt'|'teloa/source-unavailable'}

const DATA_SOURCE_AUTHORIZE_SCHEMA='teloa.industry-data-source-authorize/v1'

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const portId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;try{return new Date(value).toISOString()===value}catch{return false}}
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}
const request=(value:IndustryDataSourceInstantiateInput):IndustryDataSourceInstantiateInput=>{if(!uuid(value.requestId)||!uuid(value.loadId)||!uuid(value.itemInstanceId))throw Error('行业数据源实例化请求格式不正确。');return {requestId:value.requestId.toLowerCase(),loadId:value.loadId.toLowerCase(),itemInstanceId:value.itemInstanceId.toLowerCase()}}
const authorization=(value:IndustryDataSourceAuthorizeInput):IndustryDataSourceAuthorizeInput=>{if(!uuid(value.requestId)||!uuid(value.instanceId)||!positive(value.expectedRevision))throw Error('行业数据源授权请求格式不正确。');return {requestId:value.requestId.toLowerCase(),instanceId:value.instanceId.toLowerCase(),expectedRevision:value.expectedRevision}}
function readErrors(value:unknown,items:Set<string>):IndustryInstanceListError[]{
 try{
  if(!Array.isArray(value)||!value.length)throw Error()
  const seen=new Set<string>()
  return value.map(entry=>{
   const row=exact(entry,['instanceId','code'])
   if(!uuid(row.instanceId)||row.code!=='teloa/storage-corrupt'&&row.code!=='teloa/source-unavailable')throw Error()
   const id=row.instanceId.toLowerCase();if(seen.has(id)||items.has(id))throw Error();seen.add(id)
   return {instanceId:row.instanceId,code:row.code}
  })
 }catch{throw Error('行业数据源实例目录格式不正确。')}
}

const readBinding=(value:unknown):void=>{
 const binding=exact(value,['sourceId','scopes','definitionHash','probedAt'])
 if(!portId(binding.sourceId)||!Array.isArray(binding.scopes)||!binding.scopes.length||binding.scopes.some(scope=>!text(scope,120))||!hash(binding.definitionHash)||!stamp(binding.probedAt))throw Error()
}

function read(value:unknown):IndustryDataSourceInstance{
 try{
  const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','contentId','contentHash','itemVersion','scope','state','revision','binding','createdAt','updatedAt','drift'])
  if(!uuid(row.id)||typeof row.ownerId!=='string'||!row.ownerId||row.ownerId.length>128||!uuid(row.loadId)||!uuid(row.itemInstanceId)||!stable(row.itemLocalId)||!uuid(row.contentId)||!hash(row.contentHash)||!version(row.itemVersion)||typeof row.scope!=='string'||!row.scope||!['needs_authorization','active','detached'].includes(String(row.state))||!positive(row.revision)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw Error()
  // 来源已漂移的实例投影回初始态但保留绑定，故「是否应有绑定」按 drift 而非状态判断。
  if(row.drift!==undefined&&(row.drift!==true||row.state!=='needs_authorization'))throw Error()
  if(row.state==='detached'){
   // 已解除的实例保留解除前的绑定：两种形态都合法，修订恒 ≥2。
   if(Number(row.revision)<2)throw Error()
   if(row.binding!==null)readBinding(row.binding)
  }else if(row.state==='needs_authorization'&&row.drift!==true){
   if(row.revision!==1||row.binding!==null)throw Error()
  }else{
   if(Number(row.revision)<2)throw Error()
   readBinding(row.binding)
  }
  return row as unknown as IndustryDataSourceInstance
 }catch{throw Error('行业数据源实例记录格式不正确。')}
}

export type IndustryDataSourceApi=ReturnType<typeof createIndustryDataSourceApi>
export function createIndustryDataSourceApi(call:Call,journal?:IndustryDataSourceJournal){
 let pending:IndustryDataSourceAuthorizeInput|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>1000)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!==DATA_SOURCE_AUTHORIZE_SCHEMA)throw Error();pending=authorization(saved.request as IndustryDataSourceAuthorizeInput)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{if(recoveryError)throw recoveryError;if(!pending)throw Error('没有待核对的行业数据源授权请求。');if(busy)throw Error('行业数据源授权正在核对。');const input=pending;busy=true;try{journal?.write(JSON.stringify({schema:DATA_SOURCE_AUTHORIZE_SCHEMA,request:input}));let raw:unknown;try{raw=await call('industry-data-sources/authorize',input)}catch(error){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))){journal?.clear();pending=undefined}throw error}const result=read(raw);if(result.id.toLowerCase()!==input.instanceId||result.state!=='active'||result.revision!==input.expectedRevision+1)throw Error('行业数据源授权结果与请求不一致。');journal?.clear();pending=undefined;return result}finally{busy=false}}
 return {
 pending:()=>pending?structuredClone(pending):undefined,
 recoveryMessage:()=>recoveryError,
 /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
 discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
 recover:send,
 async instantiate(value:IndustryDataSourceInstantiateInput){const input=request(value),result=read(await call('industry-data-sources/instantiate',input));if(result.loadId.toLowerCase()!==input.loadId||result.itemInstanceId.toLowerCase()!==input.itemInstanceId)throw Error('行业数据源实例映射与请求不一致。');return result},
 async authorize(value:IndustryDataSourceAuthorizeInput){if(recoveryError)throw recoveryError;const normalized=authorization(value);if(pending&&JSON.stringify(pending)!==JSON.stringify(normalized))throw Error('请先核对原行业数据源授权请求。');pending??=normalized;return send()},
 async get(instanceId:string){if(!uuid(instanceId))throw Error('行业数据源实例身份不正确。');const normalized=instanceId.toLowerCase(),result=read(await call('industry-data-sources/get',{instanceId:normalized}));if(result.id.toLowerCase()!==normalized)throw Error('行业数据源实例响应与目标身份不一致。');return result},
 async list(){let row:Record<string,unknown>;try{row=exact(await call('industry-data-sources/list',{}),['items','errors']);if(!Array.isArray(row.items))throw Error()}catch{throw Error('行业数据源实例目录格式不正确。')}const items=row.items.map(read),ids=new Set(items.map(item=>item.id.toLowerCase())),mappings=new Set(items.map(item=>item.loadId.toLowerCase()+':'+item.itemInstanceId.toLowerCase()));if(ids.size!==items.length||mappings.size!==items.length)throw Error('行业数据源实例目录存在重复映射。');return {items,...(row.errors===undefined?{}:{errors:readErrors(row.errors,ids)})}},
}}
