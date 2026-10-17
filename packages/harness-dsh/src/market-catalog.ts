import {createHash} from 'node:crypto'
import {WorkError,isRecord,marketConnectorArtifactOptional,readMarketCatalogArtifact,readMarketCatalogEntry,readMarketCatalogListContents,readMarketCatalogListSecretGroup,marketCatalogSkillName,marketEntryKinds,type MarketCatalogListItem,type MarketCatalogListCounts,type MarketCatalogListSkipped} from '@teloa/contract'

export const marketCatalogEndpoints=['market-catalog/list','market-catalog/add','market-catalog/ranking','market-catalog/solution','market-catalog/role'] as const
export type MarketCatalogOperations={
 list:(actor:{ownerId:string;kind:'human'},request?:Record<string,unknown>)=>Promise<unknown>
 add:(actor:{ownerId:string;kind:'human'},input:unknown)=>Promise<unknown>
 /** AI 员工条目完整资源安装（旧 v1 员工原样返回）；requestId 由宿主按（本人, 条目, 版本）派生，客户端不传。 */
 addRole:(actor:{ownerId:string;kind:'human'},input:{entryId:string;version:string})=>Promise<unknown>
 /** AI 员工添加前的组成预览：固定派生包清单；未接线时按依赖不可用拒绝。 */
 rolePackage?:(actor:{ownerId:string;kind:'human'},input:{entryId:string})=>Promise<unknown>|unknown
 /** 官方方案产品页：方案包清单原文与只读接入源；未接线（测试、只读装配）时按依赖不可用拒绝。 */
 solutionPackage?:(actor:{ownerId:string;kind:'human'},input:{entryId:string})=>Promise<unknown>|unknown
}
type Encode=(value:unknown)=>Record<string,unknown>

const invalid=()=>new WorkError('teloa/invalid-input','官方目录请求格式不正确或包含未知字段。')
const hostBad=()=>new WorkError('teloa/invalid-host-response','官方目录服务返回了无效内容。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex')

const LIST_REQUEST_KEYS=['cursor','limit','query','kind','marketplace','sort'] as const
const VALID_LIST_KEYS=new Set<string>(LIST_REQUEST_KEYS)

const VALID_RESPONSE_KEYS=new Set(['catalogVersion','items','nextCursor','counts','skipped'])
/** 目录回包逐条复核：条目、工件清单（上游与模型条目为 null）、已添加内容 id、已建岗位 id（仅 role 条目）、共享密钥组（仅分组技能）、五类计数与跳过计数；不透传额外字段。 */
function encodeList(value:unknown):{catalogVersion:string;items:MarketCatalogListItem[];nextCursor:string|null;counts:MarketCatalogListCounts;skipped:MarketCatalogListSkipped}{
 try{
  if(!isRecord(value)||typeof value.catalogVersion!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value.catalogVersion)||!Array.isArray(value.items)||value.items.length>500)throw hostBad()
  if(Object.keys(value).some(k=>!VALID_RESPONSE_KEYS.has(k)))throw hostBad()
  if(!('nextCursor' in value)||(value.nextCursor!==null&&typeof value.nextCursor!=='string'))throw hostBad()
  const counts=value.counts,skipped=value.skipped
  if(!isRecord(counts)||Object.keys(counts).length!==marketEntryKinds.length||marketEntryKinds.some(kind=>!Number.isSafeInteger(counts[kind])||(counts[kind] as number)<0))throw hostBad()
  if(!isRecord(skipped)||Object.keys(skipped).length!==2||!Number.isSafeInteger(skipped.unknownKind)||!Number.isSafeInteger(skipped.newerApp)||(skipped.unknownKind as number)<0||(skipped.newerApp as number)<0)throw hostBad()
  const items=value.items.map(item=>{
   // contents 可选（官方方案包内各类资源数量，存在才加入键集）；其余五键必须齐全
   const hasContents=isRecord(item)&&Object.hasOwn(item,'contents')
   if(!isRecord(item)||Object.keys(item).length!==(hasContents?6:5)||!('secretGroup' in item)||!('entry' in item)||!('artifact' in item)||!(item.addedContentId===null||uuid(item.addedContentId))||!(item.addedRoleId===null||uuid(item.addedRoleId)))throw hostBad()
   const entry=readMarketCatalogEntry(item.entry)
   if(entry.kind!=='role'&&item.addedRoleId!==null)throw hostBad()
   // 上游条目：artifact 为 null，跳过工件校验；模型条目无工件，回包必须恰为 null；在线索引的非 stdio 连接器可为 null
   if(entry.kind==='model'&&item.artifact!==null)throw hostBad()
   const artifact=entry.delivery==='upstream'||entry.kind==='model'||item.artifact===null&&marketConnectorArtifactOptional(entry)?null:readMarketCatalogArtifact(item.artifact,entry,sha256)
   return {entry,artifact,addedContentId:item.addedContentId as string|null,addedRoleId:item.addedRoleId as string|null,secretGroup:readMarketCatalogListSecretGroup(item.secretGroup,entry),...(hasContents?{contents:readMarketCatalogListContents(item.contents,entry)}:{})}
  })
  return {catalogVersion:value.catalogVersion,items,nextCursor:value.nextCursor as string|null,counts:{...counts} as MarketCatalogListCounts,skipped:{unknownKind:skipped.unknownKind as number,newerApp:skipped.newerApp as number}}
 }catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-host-response')throw error;throw hostBad()}
}

const resourceId=/^[a-z0-9][a-z0-9._-]{0,127}$/i
/** 方案包回包复核：条目标识与请求一致、版本固定、清单是带资源表的对象、只读接入源去重且都指向清单里的连接；清单全文由界面按清单格式完整复核。只取四个键，不透传其他字段。 */
function encodeSolutionPackage(value:unknown,entryId:string):{entryId:string;version:string;manifest:Record<string,unknown>;readOnlyResources:string[]}{
 if(!isRecord(value)||value.entryId!==entryId||typeof value.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.version)||!isRecord(value.manifest)||!Array.isArray(value.manifest.resources)||value.manifest.resources.length>500||!Array.isArray(value.readOnlyResources))throw hostBad()
 const resources=value.manifest.resources as unknown[],readOnly=value.readOnlyResources as unknown[]
 const connection=(id:unknown)=>typeof id==='string'&&resourceId.test(id)&&resources.some(resource=>isRecord(resource)&&resource.id===id&&resource.kind==='mcp')
 if(readOnly.some(id=>!connection(id))||new Set(readOnly).size!==readOnly.length)throw hostBad()
 return {entryId,version:value.version,manifest:value.manifest,readOnlyResources:[...readOnly as string[]]}
}

const skillNames=(value:unknown):string[]=>{if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!marketCatalogSkillName.test(item)))throw hostBad();return value as string[]}
const RESOURCE_STATES=['done','pending','failed','conflict','needs-user','optional'],NEXT=['resume','connect','retry','review']
type InstallSummary={complete:boolean;loadId:string;roleState:string|null;next:string|null;resources:{kind:string;title:string;state:string;nativeName?:string}[]}
/** 完整资源安装摘要逐字段复核：只透传固定键；原生名按技能名口径核对。 */
function encodeInstall(value:unknown):InstallSummary{
 if(!isRecord(value)||Object.keys(value).length!==5||typeof value.complete!=='boolean'||!uuid(value.loadId)||(value.roleState!==null&&typeof value.roleState!=='string')||(value.next!==null&&!NEXT.includes(value.next as string))||!Array.isArray(value.resources)||value.resources.length>500)throw hostBad()
 const resources=value.resources.map(row=>{
  if(!isRecord(row)||typeof row.kind!=='string'||typeof row.title!=='string'||!RESOURCE_STATES.includes(row.state as string)||row.nativeName!==undefined&&(typeof row.nativeName!=='string'||!marketCatalogSkillName.test(row.nativeName)))throw hostBad()
  return {kind:row.kind,title:row.title,state:row.state as string,...(typeof row.nativeName==='string'?{nativeName:row.nativeName}:{})}
 })
 return {complete:value.complete,loadId:value.loadId.toLowerCase(),roleState:value.roleState as string|null,next:value.next as string|null,resources}
}
/**
 * 建岗回执逐字段复核，不透传其他字段。旧 v1 员工：roleId 为 uuid、status 二值、skills 技能名列表（原三键）。
 * 完整资源安装另带 install 摘要：员工尚未建立时 roleId 为 null、status 为 pending；skills 为员工实际绑定的原生名。
 */
function encodeRoleReceipt(value:unknown):{roleId:string|null;status:'created'|'existing'|'pending';skills:string[];install?:InstallSummary}{
 if(!isRecord(value))throw hostBad()
 if(value.install===undefined){
  if(!uuid(value.roleId)||(value.status!=='created'&&value.status!=='existing'))throw hostBad()
  return {roleId:value.roleId.toLowerCase(),status:value.status,skills:[...skillNames(value.skills)]}
 }
 if(value.roleId===null?value.status!=='pending':!uuid(value.roleId)||(value.status!=='created'&&value.status!=='existing'))throw hostBad()
 return {roleId:typeof value.roleId==='string'?value.roleId.toLowerCase():null,status:value.status as 'created'|'existing'|'pending',skills:[...skillNames(value.skills)],install:encodeInstall(value.install)}
}
const semver=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
/** 员工组成预览回包复核：条目与请求一致、版本固定、父包身份与清单是带资源表的对象；清单全文由界面按清单格式完整复核。 */
function encodeRolePackage(value:unknown,entryId:string):{entryId:string;version:string;packageId:string;packageVersion:string;manifest:Record<string,unknown>}{
 if(!isRecord(value)||value.entryId!==entryId||typeof value.version!=='string'||!semver.test(value.version)||typeof value.packageId!=='string'||!resourceId.test(value.packageId)||typeof value.packageVersion!=='string'||!semver.test(value.packageVersion)||!isRecord(value.manifest)||!Array.isArray(value.manifest.resources)||value.manifest.resources.length>500)throw hostBad()
 return {entryId,version:value.version,packageId:value.packageId,packageVersion:value.packageVersion,manifest:value.manifest}
}

/** 仅供认证后的工作台 RPC；不注册为 Agent 工具。添加只把条目固定为本人内容，安装仍走既有安装接口。 */
/** ranking：市场二期的安装量榜单读取（market-ranking.ts）；未注入时返回空榜。 */
export function createMarketCatalogHandler(owner:string,get:()=>Promise<MarketCatalogOperations>,encodeReceipt:Encode,ranking:()=>Promise<unknown>=async()=>({asOf:null,entries:[]})){
 return async(endpoint:string,payload:unknown):Promise<unknown>=>{
  if(!(marketCatalogEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/invalid-input','未提供此官方目录接口。')
  const actor={ownerId:owner,kind:'human'} as const
  if(endpoint==='market-catalog/ranking'){
   // 只读公开聚合，不打开目录服务与数据库；载荷只能是空对象
   if(!isRecord(payload)||Object.keys(payload).length>0)throw invalid()
   return ranking()
  }
  if(endpoint==='market-catalog/list'){
   if(!isRecord(payload))throw invalid()
   const keys=Object.keys(payload)
   if(keys.some(k=>!VALID_LIST_KEYS.has(k)))throw invalid()
   // 可选字段类型校验
   if('limit' in payload&&payload.limit!==undefined&&(!Number.isSafeInteger(payload.limit)||(payload.limit as number)<1||(payload.limit as number)>50))throw invalid()
   if('cursor' in payload&&payload.cursor!==undefined&&typeof payload.cursor!=='string')throw invalid()
   if('query' in payload&&payload.query!==undefined&&typeof payload.query!=='string')throw invalid()
   if('kind' in payload&&payload.kind!==undefined&&!(marketEntryKinds as readonly string[]).includes(payload.kind as string))throw invalid()
   const validMarketplaces=['teloa','claude-code','codex','dsh','openclaw','clawhub','hermes','cursor']
   if('marketplace' in payload&&payload.marketplace!==undefined&&!validMarketplaces.includes(payload.marketplace as string))throw invalid()
   if('sort' in payload&&payload.sort!==undefined&&!['installs','name'].includes(payload.sort as string))throw invalid()
   const request=keys.length?payload as Record<string,unknown>:undefined
   return encodeList(await (await get()).list(actor,request))
  }
  if(!isRecord(payload)||typeof payload.entryId!=='string'||payload.entryId.length>120)throw invalid()
  if(endpoint==='market-catalog/solution'){
   // 只读：恰好一个非空条目标识
   if(Object.keys(payload).length!==1||!payload.entryId)throw invalid()
   const operations=await get()
   if(!operations.solutionPackage)throw new WorkError('teloa/dependency-unavailable','官方方案内容读取尚未接通。')
   return encodeSolutionPackage(await operations.solutionPackage(actor,{entryId:payload.entryId}),payload.entryId)
  }
  if(endpoint==='market-catalog/role'){
   // 只读：恰好一个非空条目标识
   if(Object.keys(payload).length!==1||!payload.entryId)throw invalid()
   const operations=await get()
   if(!operations.rolePackage)throw new WorkError('teloa/dependency-unavailable','AI 员工组成读取尚未接通。')
   return encodeRolePackage(await operations.rolePackage(actor,{entryId:payload.entryId}),payload.entryId)
  }
  if(payload.kind==='role'){
   // AI 员工条目：恰好三键（requestId 由宿主按本人 + 条目 + 版本派生，客户端不传）；回包只透传复核过的字段
   if(Object.keys(payload).length!==3||typeof payload.version!=='string'||!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(payload.version))throw invalid()
   return encodeRoleReceipt(await (await get()).addRole(actor,{entryId:payload.entryId,version:payload.version}))
  }
  // 内容条目：恰好 2 键，或带第 3 键 expectedTreeHash（预览时的工件树摘要，64 hex）；其余一律拒绝
  if(!uuid(payload.requestId)||Object.keys(payload).some(k=>!['requestId','entryId','expectedTreeHash'].includes(k)))throw invalid()
  if('expectedTreeHash' in payload&&(typeof payload.expectedTreeHash!=='string'||!/^[0-9a-f]{64}$/.test(payload.expectedTreeHash)))throw invalid()
  return encodeReceipt(await (await get()).add(actor,{requestId:payload.requestId,entryId:payload.entryId,...(typeof payload.expectedTreeHash==='string'?{expectedTreeHash:payload.expectedTreeHash}:{})}))
 }
}
