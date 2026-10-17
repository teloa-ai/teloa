import {emptyMarketCatalogCounts,marketConnectorArtifactOptional,marketEntryKinds,readMarketCatalogEntry,readMarketCatalogListContents,readMarketCatalogListSecretGroup,type MarketCatalogArtifact,type MarketCatalogListContents,type MarketCatalogEntry,type MarketCatalogListSecretGroup,type MarketCatalogListCounts,type MarketCatalogListRequest,type MarketCatalogListSkipped} from '@teloa/contract'

import type {MarketReviewsApi} from './market-reviews-api.js'
import {validateIndustryManifest,type IndustryManifest} from './industry-manifest.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type MarketCatalogItem={entry:MarketCatalogEntry;artifact:MarketCatalogArtifact|null;addedContentId:string|null;addedRoleId:string|null;secretGroup:MarketCatalogListSecretGroup|null;contents?:MarketCatalogListContents}
/** 官方方案产品页的数据：方案包清单（已按清单格式复核）与判定为只读的接入源资源标识。 */
export type MarketCatalogSolutionPackage={manifest:IndustryManifest;readOnlyResources:string[]}
/** 目录员工完整资源安装的单项状态：needs-user 只表示已登记、待本人授权的连接或模型设置。 */
/** conflict 表示本人已有内容不同的同名方法：未另装、未覆盖，需本人处理。 */
export type CatalogRoleResource={kind:string;title:string;state:'done'|'pending'|'failed'|'conflict'|'needs-user'|'optional';nativeName?:string}
export type CatalogRoleInstall={complete:boolean;loadId:string;roleState:string|null;next:'resume'|'connect'|'retry'|'review'|null;resources:CatalogRoleResource[]}
/** 目录员工添加回执：旧 v1 无 install；skills 在完整资源安装中为员工实际绑定的原生名。 */
export type CatalogRoleReceipt={roleId:string|null;status:'created'|'existing'|'pending';skills:string[];install?:CatalogRoleInstall}
export type MarketCatalogListing={catalogVersion:string;items:MarketCatalogItem[];nextCursor:string|null;counts:MarketCatalogListCounts;skipped:MarketCatalogListSkipped}
/** reviews 缺省时（旧宿主、测试替身）应用不显示评价。 */
export type MarketCatalogApi=ReturnType<typeof createMarketCatalogApi>&{reviews?:MarketReviewsApi}
/** 市场二期安装量榜单：条目 ID → 累计安装量与近 7 日安装量。 */
export type MarketCatalogRanking=ReadonlyMap<string,{installs:number;recent:number}>
export type MarketCatalogSource=NonNullable<MarketCatalogListRequest['marketplace']>
/** 条目原始来源的显示名：只用于详情里的来源说明；目录本身只有 Teloa 官方一个。 */
export const marketCatalogSourceLabels:Record<MarketCatalogSource,string>={teloa:'Teloa', 'claude-code':'Claude Code',codex:'Codex',dsh:'DSH',openclaw:'OpenClaw',clawhub:'ClawHub',hermes:'Hermes',cursor:'Cursor'}
/** 条目的原始来源（upstream 条目的 origin.marketplace），不是目录提供方。 */
export const catalogEntrySource=(entry:MarketCatalogEntry):MarketCatalogSource=>entry.delivery==='upstream'?entry.origin.marketplace:'teloa'
export const catalogEntryTitle=(entry:MarketCatalogEntry)=>entry.kind==='skill'?entry.skill.title:entry.kind==='solution'?entry.solution.title:entry.kind==='dashboard'?entry.dashboard.title:entry.kind==='role'?entry.role.title:entry.kind==='connector'?entry.connector.title:entry.model.title
/** 只导航到当前可读目录里的资源，不把资源 ID 当内容 UUID；推荐优先且保持其余来源顺序。 */
export function catalogAlternatives(entry:MarketCatalogEntry,items:readonly MarketCatalogItem[]):Array<{item:MarketCatalogItem;recommended:boolean}>{
 const alternatives='alternatives' in entry?entry.alternatives??[]:[]
 if(!alternatives.length)return []
 const byId=new Map(items.map(item=>[item.entry.id,item]))
 return alternatives.flatMap(alternative=>{
  const item=byId.get(alternative.entryId)
  return item&&item.entry.id!==entry.id?[{item,recommended:alternative.recommended===true}]:[]
 }).sort((a,b)=>Number(b.recommended)-Number(a.recommended))
}

/**
 * 读取 Teloa 官方目录：宿主按固定来源审核后一次给出全部当前条目（原始来源、上游与许可保留在各条目里），客户端不再逐个查询外部来源。
 * 固定目录版本、读完所有分页；异常游标或上限后的剩余页不能冒充完整目录。`marketplace` 只接受 teloa，保留给已显式传入的调用方。
 */
export async function loadCatalogListing(api:Pick<MarketCatalogApi,'list'>,marketplace:'teloa'='teloa'):Promise<MarketCatalogListing>{
 const items:MarketCatalogItem[]=[],seenIds=new Set<string>(),seenCursors=new Set<string>()
 let cursor:string|null=null,first:MarketCatalogListing|undefined
 for(let page=0;page<20;page++){
  const value=await api.list({marketplace,limit:50,...(cursor?{cursor}:{})})
  first??=value
  if(value.catalogVersion!==first.catalogVersion)throw Error('teloa/source-unavailable')
  for(const item of value.items){
   if(seenIds.has(item.entry.id))throw Error('teloa/source-unavailable')
   seenIds.add(item.entry.id);items.push(item)
  }
  cursor=value.nextCursor
  if(!cursor)return {catalogVersion:first.catalogVersion,items,nextCursor:null,counts:first.counts??emptyMarketCatalogCounts(),skipped:first.skipped??{unknownKind:0,newerApp:0}}
  if(seenCursors.has(cursor))throw Error('teloa/source-unavailable')
  seenCursors.add(cursor)
 }
 throw Error('teloa/source-unavailable')
}

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const uuid=(value:unknown):value is string=>typeof value==='string'&&UUID.test(value)
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)

const VALID_LIST_KEYS=new Set(['catalogVersion','items','nextCursor','counts','skipped'])

/** 浏览器端只做结构复核：宿主已按固定快照核验字节与树摘要，这里防止把异常回包当目录展示。 */
function artifact(value:unknown):MarketCatalogArtifact{
 const row=value&&record(value)&&Object.keys(value).length===2&&'files' in value&&'treeHash' in value?value:null
 if(!row)throw Error()
 if(!Array.isArray(row.files)||row.files.length<1||row.files.length>500||typeof row.treeHash!=='string'||!/^[0-9a-f]{64}$/.test(row.treeHash))throw Error()
 const files=row.files.map((input:unknown)=>{
  if(!record(input)||Object.keys(input).length!==3||!('path' in input&&'sha256' in input&&'size' in input))throw Error()
  if(typeof input.path!=='string'||!input.path||typeof input.sha256!=='string'||!/^[0-9a-f]{64}$/.test(input.sha256)||!Number.isSafeInteger(input.size))throw Error()
  return {path:input.path,sha256:input.sha256,size:input.size as number}
 })
 return {files,treeHash:row.treeHash}
}
function listing(value:unknown):MarketCatalogListing{
 try{
  if(!record(value))throw Error()
  // 旧宿主可不带 nextCursor；提供时必须是有效字符串或明确的 null。
  const keys=Object.keys(value)
  if(keys.some(k=>!VALID_LIST_KEYS.has(k)))throw Error()
  if(typeof value.catalogVersion!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value.catalogVersion)||!Array.isArray(value.items)||value.items.length>500)throw Error()
  if('nextCursor' in value&&value.nextCursor!==null&&(typeof value.nextCursor!=='string'||!value.nextCursor||value.nextCursor.length>120))throw Error()
  const nextCursor=typeof value.nextCursor==='string'?value.nextCursor:null
  const items=value.items.map((input:unknown)=>{
   // contents 可选：官方方案包内各类资源数量，存在才加入键集（旧宿主回包没有）
   const hasContents=record(input)&&Object.hasOwn(input,'contents')
   if(!record(input)||Object.keys(input).length!==(hasContents?6:5)||!('entry' in input&&'artifact' in input&&'addedContentId' in input&&'addedRoleId' in input&&'secretGroup' in input))throw Error()
   if(input.addedContentId!==null&&!uuid(input.addedContentId))throw Error()
   if(input.addedRoleId!==null&&!uuid(input.addedRoleId))throw Error()
   const entry=readMarketCatalogEntry(input.entry)
   if(entry.kind!=='role'&&input.addedRoleId!==null)throw Error()
   // 上游条目 artifact 为 null；模型条目无工件，回包必须恰为 null；在线索引的非 stdio 连接器可为 null
   if(entry.kind==='model'&&input.artifact!==null)throw Error()
   const art=entry.delivery==='upstream'||entry.kind==='model'||input.artifact===null&&marketConnectorArtifactOptional(entry)?null:artifact(input.artifact)
   return {entry,artifact:art,addedContentId:input.addedContentId as string|null,addedRoleId:input.addedRoleId as string|null,secretGroup:readMarketCatalogListSecretGroup(input.secretGroup,entry),...(hasContents?{contents:readMarketCatalogListContents(input.contents,entry)}:{})}
  })
  const count=(v:unknown)=>Number.isSafeInteger(v)&&(v as number)>=0
  const rawCounts=value.counts,skipped=value.skipped
  const counts=record(rawCounts)&&!Object.hasOwn(rawCounts,'dashboard')&&Object.keys(rawCounts).length===marketEntryKinds.length-1?{...rawCounts,dashboard:0}:rawCounts
  if(!record(counts)||Object.keys(counts).length!==marketEntryKinds.length||marketEntryKinds.some(kind=>!count(counts[kind])))throw Error()
  if(!record(skipped)||Object.keys(skipped).length!==2||!count(skipped.unknownKind)||!count(skipped.newerApp))throw Error()
  return {catalogVersion:value.catalogVersion,items,nextCursor,counts:{...counts} as MarketCatalogListCounts,skipped:{unknownKind:skipped.unknownKind as number,newerApp:skipped.newerApp as number}}
 }catch{throw Error('官方目录回包格式不正确。')}
}
const cleared=['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/source-unavailable','teloa/storage-corrupt']
const rejected=(error:unknown)=>record(error)&&error.rejected===true&&typeof error.code==='string'&&cleared.includes(error.code)

/**
 * 官方目录读取与添加。添加只把条目固定为本人技能内容，安装仍走市场详情里的既有安装控件；
 * 同一条目在失败后以原请求 ID 重试，宿主按请求身份重放原回执，不会重复固定。
 */
export function createMarketCatalogApi(call:Call,newId:()=>string=()=>crypto.randomUUID()){
 const awaiting=new Map<string,string>()
 return {
  /** 无参数调用发送 {}（向后兼容）；传入请求对象时按字段过滤。 */
  async list(request?:MarketCatalogListRequest):Promise<MarketCatalogListing>{
   return listing(await call('market-catalog/list',request??{}))
  },
  /** 安装量榜单：宿主未开启统计时为空表；宿主异常或结构不符同样返回空表，不影响目录显示。 */
  async ranking():Promise<MarketCatalogRanking>{
   try{
    const value=await call('market-catalog/ranking',{})
    if(!record(value)||Object.keys(value).length!==2||!(value.asOf===null||typeof value.asOf==='string')||!Array.isArray(value.entries)||value.entries.length>2000)throw Error()
    const map=new Map<string,{installs:number;recent:number}>()
    for(const row of value.entries){
     if(!record(row)||Object.keys(row).length!==3||typeof row.id!=='string'||!Number.isSafeInteger(row.installs)||(row.installs as number)<0||!Number.isSafeInteger(row.recent)||(row.recent as number)<0)throw Error()
     map.set(row.id,{installs:row.installs as number,recent:row.recent as number})
    }
    return map
   }catch{return new Map()}
  },
  /** expected：所选来源的条目版本与树指纹；带上时宿主在下载前核对指纹，回执的版本与指纹也须与所选一致。 */
  async add(entryId:string,expected?:{version:string;treeHash:string}):Promise<{contentId:string}>{
   if(typeof entryId!=='string'||!entryId||entryId.length>120)throw Error('官方目录资源标识不正确。')
   if(expected!==undefined&&(typeof expected.version!=='string'||!expected.version||expected.version.length>80||typeof expected.treeHash!=='string'||!/^[0-9a-f]{64}$/.test(expected.treeHash)))throw Error('所选来源的版本或指纹格式不正确。')
   // 重试沿用原请求身份；所选指纹不同即另一请求，不借旧请求身份改写校验值
   const key=entryId+'\n'+(expected?.treeHash??''),requestId=awaiting.get(key)??newId();awaiting.set(key,requestId)
   try{
    const value=await call('market-catalog/add',{requestId,entryId,...(expected?{expectedTreeHash:expected.treeHash}:{})})
    let contentId:string
    try{
     const row=record(value)&&Object.keys(value).length===2&&'receipt' in value&&'content' in value?value:null
     if(!row)throw Error()
     const receipt=record(row.receipt)&&Object.keys(row.receipt).length===4&&'requestId' in row.receipt&&'contentId' in row.receipt&&'source' in row.receipt&&'createdAt' in row.receipt?row.receipt:null
     if(!receipt)throw Error()
     const source=record(receipt.source)&&Object.keys(receipt.source).length===6&&'kind' in receipt.source&&'catalog' in receipt.source&&'catalogVersion' in receipt.source&&'entryId' in receipt.source&&'entryVersion' in receipt.source&&'treeHash' in receipt.source?receipt.source:null
     if(!source)throw Error()
     if(receipt.requestId!==requestId||!uuid(receipt.contentId)||source.kind!=='catalog'||source.entryId!==entryId||!record(row.content)||row.content.id!==receipt.contentId)throw Error()
     if(expected&&(source.entryVersion!==expected.version||source.treeHash!==expected.treeHash))throw Error()
     contentId=receipt.contentId as string
    }catch{throw Error('官方目录添加回执与原请求不一致。')}
    awaiting.delete(key)
    return {contentId}
   }catch(error){if(rejected(error))awaiting.delete(key);throw error}
  },
  /** 官方方案「添加后你会得到」：只发条目标识；清单按格式完整复核，版本须与回包版本一致，只读接入源须去重且都指向清单里的连接。 */
  async solutionPackage(entryId:string):Promise<MarketCatalogSolutionPackage>{
   const value=await call('market-catalog/solution',{entryId})
   try{
    if(!record(value)||Object.keys(value).length!==4||value.entryId!==entryId||typeof value.version!=='string'||!Array.isArray(value.readOnlyResources))throw Error()
    const manifest=validateIndustryManifest(value.manifest),readOnly=value.readOnlyResources
    if(manifest.version!==value.version||new Set(readOnly).size!==readOnly.length||readOnly.some(id=>!manifest.resources.some(resource=>resource.id===id&&resource.kind==='mcp')))throw Error()
    return {manifest,readOnlyResources:readOnly as string[]}
   }catch{throw Error('官方方案内容回包格式不正确。')}
  },
  /** AI 员工添加前的组成预览：固定派生包清单按清单格式完整复核，只含这一位员工。 */
  async rolePackage(entryId:string):Promise<{packageId:string;packageVersion:string;manifest:IndustryManifest}>{
   const value=await call('market-catalog/role',{entryId})
   try{
    if(!record(value)||Object.keys(value).length!==5||value.entryId!==entryId||typeof value.version!=='string'||typeof value.packageId!=='string'||typeof value.packageVersion!=='string')throw Error()
    const manifest=validateIndustryManifest(value.manifest)
    if(manifest.resources.filter(resource=>resource.kind==='role').length!==1)throw Error()
    return {packageId:value.packageId,packageVersion:value.packageVersion,manifest}
   }catch{throw Error('AI 员工组成回包格式不正确。')}
  },
  /**
   * AI 员工条目添加；不传 requestId，宿主按（本人, 条目, 版本）派生并幂等，重复添加返回 existing，未完成的资源再添加一次续做。
   * 旧 v1 员工回原三键；完整资源安装另带 install 摘要（员工未建立时 roleId 为 null、status 为 pending）。
   */
  async addRole(entryId:string,version:string):Promise<CatalogRoleReceipt>{
   if(typeof entryId!=='string'||!entryId||entryId.length>120||typeof version!=='string'||!version)throw Error('官方目录资源标识不正确。')
   const value=await call('market-catalog/add',{entryId,version,kind:'role'})
   const bad=()=>Error('AI 员工添加回执格式不正确。')
   if(!record(value)||!Array.isArray(value.skills)||value.skills.some(item=>typeof item!=='string'))throw bad()
   if(value.install===undefined){
    if(Object.keys(value).length!==3||!uuid(value.roleId)||(value.status!=='created'&&value.status!=='existing'))throw bad()
    return {roleId:value.roleId,status:value.status,skills:value.skills as string[]}
   }
   const install=value.install
   if(Object.keys(value).length!==4||(value.roleId===null?value.status!=='pending':!uuid(value.roleId)||(value.status!=='created'&&value.status!=='existing')))throw bad()
   if(!record(install)||typeof install.complete!=='boolean'||!uuid(install.loadId)||(install.roleState!==null&&typeof install.roleState!=='string')||(install.next!==null&&!['resume','connect','retry','review'].includes(install.next as string))||!Array.isArray(install.resources))throw bad()
   const resources=install.resources.map(row=>{
    if(!record(row)||typeof row.kind!=='string'||typeof row.title!=='string'||!['done','pending','failed','conflict','needs-user','optional'].includes(row.state as string)||row.nativeName!==undefined&&typeof row.nativeName!=='string')throw bad()
    return {kind:row.kind,title:row.title,state:row.state as CatalogRoleResource['state'],...(typeof row.nativeName==='string'?{nativeName:row.nativeName}:{})}
   })
   return {roleId:value.roleId as string|null,status:value.status as CatalogRoleReceipt['status'],skills:value.skills as string[],install:{complete:install.complete,loadId:install.loadId,roleState:install.roleState as string|null,next:install.next as CatalogRoleInstall['next'],resources}}
  },
 }
}

export const catalogText=(value:{'zh-CN':string;'zh-TW'?:string;en:string},locale:string)=>locale==='zh-TW'&&value['zh-TW']?value['zh-TW']:locale.startsWith('zh')?value['zh-CN']:value.en
