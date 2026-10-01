import {WorkError,isRecord} from '@teloa/contract'

export const marketContentEndpoints=['market-content/import','market-content/import-github','market-content/import-github-skill','market-content/get','market-content/receipt','market-content/list'] as const
export type MarketContentOperations={
 import:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
 importGithub:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
 importGithubSkill:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
 get:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
 getImport:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
 list:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
}

const MAX_FILE=2*1024*1024,MAX_TOTAL=20*1024*1024,MAX_BASE64=4*Math.ceil(MAX_FILE/3)
const invalid=()=>new WorkError('teloa/invalid-input','市场内容传输格式不正确或包含未知字段。')
const object=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value
}
const string=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length<=max
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const path=(value:unknown):value is string=>string(value,500)&&!!value&&!value.startsWith('/')&&!value.split('/').some(part=>!part||part==='.'||part==='..')&&!/[\\:?%#\u0000-\u001f\u007f]/.test(value)
function upload(value:unknown):void{
 const row=object(value,['kind','name'])
 if(row.kind!=='upload'||!string(row.name,300)||!row.name.trim())throw invalid()
}
function decode(value:unknown):Uint8Array{
 if(typeof value!=='string'||value.length>MAX_BASE64||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw invalid()
 const bytes=Buffer.from(value,'base64')
 if(bytes.toString('base64')!==value||bytes.byteLength>MAX_FILE)throw invalid()
 return Uint8Array.from(bytes)
}
function decodeFiles(value:unknown):{path:string;bytes:Uint8Array}[]{
 if(!Array.isArray(value)||value.length<1||value.length>500)throw invalid()
 let total=0
 return value.map(input=>{
  const row=object(input,['path','base64']);if(!path(row.path))throw invalid()
  const bytes=decode(row.base64);total+=bytes.byteLength;if(total>MAX_TOTAL)throw invalid()
  return {path:row.path,bytes}
 })
}
function validateAtomic(row:Record<string,unknown>):void{
 upload(row.source)
 const metadata=object(row.metadata,['id','title','version','categories','localized'])
 if(!string(metadata.id,120)||!string(metadata.title,120)||!string(metadata.version,80)||!Array.isArray(metadata.categories)||metadata.categories.some(value=>!string(value,80)))throw invalid()
}
function trust(value:unknown):void{if(value===undefined)return;const row=object(value,['publisher','repository','license','signature','compatibility','plugins','externalCapabilities','permissions','review']);if(!string(row.publisher,200)||!row.publisher.trim()||row.repository!==null&&!isRecord(row.repository)||!isRecord(row.license)||!isRecord(row.signature)||!isRecord(row.compatibility)||!Array.isArray(row.plugins)||!Array.isArray(row.externalCapabilities)||!Array.isArray(row.permissions)||!isRecord(row.review))throw invalid()}
function validateIndustry(row:Record<string,unknown>):void{
 upload(row.source);if(!path(row.manifestPath)||!Array.isArray(row.references)||row.references.length>500)throw invalid()
 for(const input of row.references){
  const reference=object(input,['resourceId','sourceContentId','sourceItemId','sourceResourceId','sourceHash'])
  if(!string(reference.resourceId,120)||!uuid(reference.sourceContentId)||!string(reference.sourceItemId,200)||!string(reference.sourceResourceId,120)||typeof reference.sourceHash!=='string'||!/^[0-9a-f]{64}$/.test(reference.sourceHash))throw invalid()
 }
}
function decodeImport(payload:unknown):Record<string,unknown>{
 if(!isRecord(payload))throw invalid()
 let row:Record<string,unknown>
 if(payload.kind==='atomic-skill'){
  row=object(payload,['kind','requestId','source','metadata','trust','files']);validateAtomic(row);trust(row.trust)
 }else if(payload.kind==='industry-template'){
  row=object(payload,['kind','requestId','source','manifestPath','trust','files','references']);validateIndustry(row);trust(row.trust)
 }else throw invalid()
 if(!uuid(row.requestId))throw invalid()
 return {...row,files:decodeFiles(row.files)}
}
function decodeGithubImport(payload:unknown):Record<string,unknown>{
 // 客户端不得提交信任声明；宿主只转发请求身份与清单路径，信任沿用固定来源回执。
 const row=object(payload,['requestId','githubRequestId','manifestPath'])
 if(!uuid(row.requestId)||!uuid(row.githubRequestId)||!path(row.manifestPath))throw invalid()
 return {requestId:row.requestId,githubRequestId:row.githubRequestId,manifestPath:row.manifestPath}
}
function decodeGithubSkillImport(payload:unknown):Record<string,unknown>{
 // 同上：客户端只给请求身份与 SKILL.md 路径；名称、版本与信任都由宿主从固定来源推出。
 const row=object(payload,['requestId','githubRequestId','skillPath'])
 if(!uuid(row.requestId)||!uuid(row.githubRequestId)||!path(row.skillPath)||(row.skillPath!=='SKILL.md'&&!row.skillPath.endsWith('/SKILL.md')))throw invalid()
 return {requestId:row.requestId,githubRequestId:row.githubRequestId,skillPath:row.skillPath}
}
function identity(payload:unknown,key:'contentId'|'requestId'):Record<string,unknown>{
 const row=object(payload,[key]);if(!uuid(row[key]))throw invalid();return row
}
function page(payload:unknown):Record<string,unknown>{
 const row=object(payload,['cursor','limit'])
 if(row.cursor!==undefined&&!uuid(row.cursor))throw invalid()
 if(row.limit!==undefined&&(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>100))throw invalid()
 return row
}
function encodeContent(value:unknown):Record<string,unknown>{
 if(!isRecord(value)||!Array.isArray(value.files))throw new WorkError('teloa/invalid-host-response','市场内容服务返回了无效内容。')
 const files=value.files.map(input=>{
  if(!isRecord(input)||typeof input.path!=='string'||typeof input.hash!=='string'||!(input.bytes instanceof Uint8Array))throw new WorkError('teloa/invalid-host-response','市场内容服务返回了无效文件。')
  return {path:input.path,hash:input.hash,base64:Buffer.from(input.bytes).toString('base64')}
 })
 const {files:_,...content}=value
 return {...content,files}
}
/** 市场导入回执编码（文件转 base64）；官方目录添加接口复用同一编码。 */
export function encodeReceipt(value:unknown):Record<string,unknown>{
 if(!isRecord(value)||!isRecord(value.receipt))throw new WorkError('teloa/invalid-host-response','市场内容服务返回了无效导入回执。')
 return {receipt:value.receipt,content:encodeContent(value.content)}
}
function encodePage(value:unknown,owner:string):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!['items','nextCursor'].includes(key))||!Array.isArray(value.items)||value.items.length>100||(value.nextCursor!==null&&!uuid(value.nextCursor)))throw new WorkError('teloa/invalid-host-response','市场内容服务返回了无效目录页。')
 const items=value.items.map(item=>{
  if(!isRecord(item)||Object.hasOwn(item,'files')||!uuid(item.id)||item.ownerId!==owner)throw new WorkError('teloa/invalid-host-response','市场内容服务返回了无效目录项。')
  return item
 })
 return {items,nextCursor:value.nextCursor}
}

/** 仅供认证后的工作台 RPC 使用；不注册为 Agent 工具，也不产生安装状态。 */
export function createMarketContentHandler(owner:string,get:()=>Promise<MarketContentOperations>){
 return async(endpoint:string,payload:unknown):Promise<unknown>=>{
  if(!marketContentEndpoints.includes(endpoint as typeof marketContentEndpoints[number]))throw new WorkError('teloa/not-found','未提供此市场内容接口。')
  const actor={ownerId:owner,kind:'human'} as const
  if(endpoint==='market-content/import'){
   const input=decodeImport(payload),service=await get()
   return encodeReceipt(await service.import(actor,input))
  }
  if(endpoint==='market-content/import-github'){
   const input=decodeGithubImport(payload),service=await get()
   return encodeReceipt(await service.importGithub(actor,input))
  }
  if(endpoint==='market-content/import-github-skill'){
   const input=decodeGithubSkillImport(payload),service=await get()
   return encodeReceipt(await service.importGithubSkill(actor,input))
  }
  if(endpoint==='market-content/get'){
   const input=identity(payload,'contentId'),service=await get()
   return encodeContent(await service.get(actor,input))
  }
  if(endpoint==='market-content/list'){
   const input=page(payload),service=await get()
   return encodePage(await service.list(actor,input),owner)
  }
  const input=identity(payload,'requestId'),service=await get()
  return encodeReceipt(await service.getImport(actor,input))
 }
}
