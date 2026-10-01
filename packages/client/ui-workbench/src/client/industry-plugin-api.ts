import {readIndustryPluginDefinition,readMarketPluginInstallPreview,type IndustryPluginDefinition,type MarketPluginInstallPreview} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(method:string,payload:unknown)=>Promise<unknown>

export type IndustryPluginState='needs_install'|'installing'|'pending-enable'|'active'|'restart-required'|'failed'|'detached'
type IndustryPluginBase={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;definition:IndustryPluginDefinition;definitionHash:string;createdAt:string;updatedAt:string}
/** 第三个分支是来源漂移投影：状态回落为 needs_install，但已冻结的安装身份与 revision 原样保留。 */
export type IndustryPluginInstance=IndustryPluginBase&({state:'needs_install';revision:1;installationId:null;drift?:undefined}|{state:Exclude<IndustryPluginState,'needs_install'>;revision:number;installationId:string;drift?:undefined}|{state:'needs_install';revision:number;installationId:string|null;drift:true})
export type IndustryPluginInstantiateInput={requestId:string;loadId:string;itemInstanceId:string}
/** 安装是「客户端持固定预览提交」：这一份 preview 就是人在确认区逐条核过的那一份，服务端再与 registry 现取的逐字比对。 */
export type IndustryPluginInstallInput={requestId:string;instanceId:string;expectedRevision:number;preview:MarketPluginInstallPreview}
export type IndustryPluginJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
export type IndustryInstanceListError={instanceId:string;code:'teloa/storage-corrupt'|'teloa/source-unavailable'}

const PLUGIN_INSTALL_SCHEMA='teloa.industry-plugin-install/v1'

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const version=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;try{return new Date(value).toISOString()===value}catch{return false}}
const states:readonly string[]=['needs_install','installing','pending-enable','active','restart-required','failed','detached']
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}
const request=(value:IndustryPluginInstantiateInput):IndustryPluginInstantiateInput=>{let row:Record<string,unknown>;try{row=exact(value,['requestId','loadId','itemInstanceId'])}catch{throw Error('行业扩展登记请求格式不正确。')}if(!uuid(row.requestId)||!uuid(row.loadId)||!uuid(row.itemInstanceId))throw Error('行业扩展登记请求格式不正确。');return {requestId:row.requestId.toLowerCase(),loadId:row.loadId.toLowerCase(),itemInstanceId:row.itemInstanceId.toLowerCase()}}
const installRequest=(value:IndustryPluginInstallInput):IndustryPluginInstallInput=>{let row:Record<string,unknown>;try{row=exact(value,['requestId','instanceId','expectedRevision','preview'])}catch{throw Error('行业扩展安装请求格式不正确。')}if(!uuid(row.requestId)||!uuid(row.instanceId)||!Number.isSafeInteger(row.expectedRevision)||(row.expectedRevision as number)<1)throw Error('行业扩展安装请求格式不正确。');let preview:MarketPluginInstallPreview;try{preview=readMarketPluginInstallPreview(row.preview)}catch{throw Error('行业扩展安装预览格式不正确。')};return {requestId:row.requestId.toLowerCase(),instanceId:row.instanceId.toLowerCase(),expectedRevision:row.expectedRevision as number,preview}}

/** 目录的逐行失败项：只接受两种既定错误码。 */
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
 }catch{throw Error('行业扩展实例目录格式不正确。')}
}

function read(value:unknown):IndustryPluginInstance{
 try{
  const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','contentId','contentHash','itemVersion','scope','definition','definitionHash','installationId','state','revision','createdAt','updatedAt','drift'])
  if(!uuid(row.id)||typeof row.ownerId!=='string'||!row.ownerId||row.ownerId.length>128||!uuid(row.loadId)||!uuid(row.itemInstanceId)||!stable(row.itemLocalId)||!uuid(row.contentId)||!hash(row.contentHash)||!version(row.itemVersion)||typeof row.scope!=='string'||!row.scope||!hash(row.definitionHash)||!states.includes(row.state as string)||!Number.isSafeInteger(row.revision)||(row.revision as number)<1||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw Error()
  readIndustryPluginDefinition(row.definition)
  // 来源已漂移的实例投影回 needs_install 但保留安装身份，故初始态不变量只在未漂移时成立。
  if(row.drift!==undefined&&(row.drift!==true||row.state!=='needs_install'))throw Error()
  if(row.drift===true){
   if(row.installationId===null?row.revision!==1:!uuid(row.installationId)||(row.revision as number)<2)throw Error()
  }else if(row.state==='needs_install'){
   if(row.revision!==1||row.installationId!==null)throw Error()
  }else if(row.state==='detached'){
   // 已解除的插件保留解除前的安装身份：从登记态解除时仍为 null，从已安装态解除时仍是原安装。
   if((row.revision as number)<2||row.installationId!==null&&!uuid(row.installationId))throw Error()
  }else if(!uuid(row.installationId)||(row.revision as number)<2)throw Error()
  return row as unknown as IndustryPluginInstance
 }catch{throw Error('行业扩展实例记录格式不正确。')}
}

export type IndustryPluginApi=ReturnType<typeof createIndustryPluginApi>
export function createIndustryPluginApi(call:Call,journal?:IndustryPluginJournal){
 let pending:IndustryPluginInstallInput|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>12_000)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!==PLUGIN_INSTALL_SCHEMA)throw Error();pending=installRequest(saved.request as IndustryPluginInstallInput)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{if(recoveryError)throw recoveryError;if(!pending)throw Error('没有待核对的行业扩展安装请求。');if(busy)throw Error('行业扩展安装正在核对。');const input=pending;busy=true;try{journal?.write(JSON.stringify({schema:PLUGIN_INSTALL_SCHEMA,request:input}));let raw:unknown;try{raw=await call('industry-plugins/install',input)}catch(error){if(error&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))){journal?.clear();pending=undefined}throw error}const result=read(raw);if(result.id.toLowerCase()!==input.instanceId||result.installationId===null||result.revision!==input.expectedRevision+1)throw Error('行业扩展安装响应与目标身份或版本不一致。');journal?.clear();pending=undefined;return result}finally{busy=false}}
 return {
 pending:()=>pending?structuredClone(pending):undefined,
 recoveryMessage:()=>recoveryError,
 // 丢弃只清本地记录，不通知服务端：requestId 一丢就没有可靠的撤销面了（规格 §二 D4）。
 discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
 recover:send,
 async instantiate(value:IndustryPluginInstantiateInput){const input=request(value),result=read(await call('industry-plugins/instantiate',input));if(result.loadId.toLowerCase()!==input.loadId||result.itemInstanceId.toLowerCase()!==input.itemInstanceId)throw Error('行业扩展实例映射与请求不一致。');return result},
 async install(value:IndustryPluginInstallInput){if(recoveryError)throw recoveryError;const normalized=installRequest(value);if(pending&&JSON.stringify(pending)!==JSON.stringify(normalized))throw Error('请先核对原行业扩展安装请求。');pending??=normalized;return send()},
 /** 安装前的知情同意：与市场路径同一份预览，逐条摆出权限、发布者、信任结论与完整性摘要。 */
 async preview(instanceId:string){if(!uuid(instanceId))throw Error('行业扩展实例身份不正确。');try{return readMarketPluginInstallPreview(await call('industry-plugins/preview',{instanceId:instanceId.toLowerCase()}))}catch(error){throw error instanceof Error&&error.message?error:Error('行业扩展安装预览格式不正确。')}},
 /** 启用是本人的第二次显式动作：不消耗 requestId，仍要把核过的那一份预览原样带回。 */
 async enable(instanceId:string,preview:MarketPluginInstallPreview){
  if(!uuid(instanceId))throw Error('行业扩展实例身份不正确。')
  let fixed:MarketPluginInstallPreview;try{fixed=readMarketPluginInstallPreview(preview)}catch{throw Error('行业扩展启用预览格式不正确。')}
  const normalized=instanceId.toLowerCase(),result=read(await call('industry-plugins/enable',{instanceId:normalized,preview:fixed}))
  if(result.id.toLowerCase()!==normalized)throw Error('行业扩展启用响应身份不一致。')
  return result
 },
 async reconcile(instanceId:string){if(!uuid(instanceId))throw Error('行业扩展实例身份不正确。');const normalized=instanceId.toLowerCase(),result=read(await call('industry-plugins/reconcile',{instanceId:normalized}));if(result.id.toLowerCase()!==normalized)throw Error('行业扩展实例响应与目标身份不一致。');return result},
 async get(instanceId:string){if(!uuid(instanceId))throw Error('行业扩展实例身份不正确。');const normalized=instanceId.toLowerCase(),result=read(await call('industry-plugins/get',{instanceId:normalized}));if(result.id.toLowerCase()!==normalized)throw Error('行业扩展实例响应与目标身份不一致。');return result},
 async list(){let row:Record<string,unknown>;try{row=exact(await call('industry-plugins/list',{}),['items','errors']);if(!Array.isArray(row.items))throw Error()}catch{throw Error('行业扩展实例目录格式不正确。')}const items=row.items.map(read),ids=new Set(items.map(item=>item.id.toLowerCase())),mappings=new Set(items.map(item=>item.loadId.toLowerCase()+':'+item.itemInstanceId.toLowerCase()));if(ids.size!==items.length||mappings.size!==items.length)throw Error('行业扩展实例目录存在重复映射。');return {items,...(row.errors===undefined?{}:{errors:readErrors(row.errors,ids)})}},
}}
