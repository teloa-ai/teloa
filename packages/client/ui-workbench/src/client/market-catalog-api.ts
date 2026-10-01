import {emptyMarketCatalogCounts,marketEntryKinds,readMarketCatalogEntry,readMarketCatalogListContents,readMarketCatalogListSecretGroup,type MarketCatalogArtifact,type MarketCatalogListContents,type MarketCatalogEntry,type MarketCatalogListSecretGroup,type MarketCatalogListCounts,type MarketCatalogListRequest,type MarketCatalogListSkipped} from '@teloa/contract'

import type {MarketReviewsApi} from './market-reviews-api.js'
import {validateIndustryManifest,type IndustryManifest} from './industry-manifest.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
export type MarketCatalogItem={entry:MarketCatalogEntry;artifact:MarketCatalogArtifact|null;addedContentId:string|null;addedRoleId:string|null;secretGroup:MarketCatalogListSecretGroup|null;contents?:MarketCatalogListContents}
/** 官方方案产品页的数据：方案包清单（已按清单格式复核）与判定为只读的接入源资源标识。 */
export type MarketCatalogSolutionPackage={manifest:IndustryManifest;readOnlyResources:string[]}
export type MarketCatalogListing={catalogVersion:string;items:MarketCatalogItem[];nextCursor:string|null;counts:MarketCatalogListCounts;skipped:MarketCatalogListSkipped}
/** reviews 缺省时（旧宿主、测试替身）应用不显示评价。 */
export type MarketCatalogApi=ReturnType<typeof createMarketCatalogApi>&{reviews?:MarketReviewsApi}
/** 市场二期安装量榜单：条目 ID → 累计安装量与近 7 日安装量。 */
export type MarketCatalogRanking=ReadonlyMap<string,{installs:number;recent:number}>
export type MarketCatalogSource=NonNullable<MarketCatalogListRequest['marketplace']>
export const marketCatalogSources=['teloa','claude-code','codex','dsh','openclaw','clawhub','hermes'] as const satisfies readonly MarketCatalogSource[]
export const marketCatalogSourceLabels:Record<MarketCatalogSource,string>={teloa:'Teloa', 'claude-code':'Claude Code',codex:'Codex',dsh:'DSH',openclaw:'OpenClaw',clawhub:'ClawHub',hermes:'Hermes'}
/** 仅用于客户端合并结果；不改变宿主回包契约。 */
export type MarketCatalogCollection=MarketCatalogListing&{unavailableSources:MarketCatalogSource[]}
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

/** 每个来源固定版本、读完所有分页；异常游标或上限后的剩余页不能冒充完整目录。 */
async function allPages(api:Pick<MarketCatalogApi,'list'>,marketplace:MarketCatalogSource):Promise<MarketCatalogListing>{
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

/** 「全部来源」读取每个原生目录来源（sources 首项须为 teloa）；上游不可读时保留其他来源并明确报告。计数仍是 Teloa 官方目录计数。 */
export async function loadCatalogListing(api:Pick<MarketCatalogApi,'list'>,marketplace?:MarketCatalogSource,sources:readonly MarketCatalogSource[]=marketCatalogSources):Promise<MarketCatalogCollection>{
 if(marketplace)return {...await allPages(api,marketplace),unavailableSources:[]}
 const results=await Promise.allSettled(sources.map(source=>allPages(api,source)))
 const official=results[0]!
 if(official.status==='rejected')throw official.reason
 const items:MarketCatalogItem[]=[],unavailableSources:MarketCatalogSource[]=[]
 results.forEach((result,index)=>{
  if(result.status==='fulfilled')items.push(...result.value.items)
  else unavailableSources.push(sources[index]!)
 })
 return {...official.value,items,unavailableSources}
}
/** 上游来源只收技能：当前分类不含技能时只读 Teloa 目录。 */
export function catalogSourcesForKinds(kinds:readonly MarketCatalogEntry['kind'][]|undefined):readonly MarketCatalogSource[]{
 return !kinds||kinds.includes('skill')?marketCatalogSources:['teloa']
}
/** 按分类懒加载来源：先读所需来源；可见资源的其他来源指向未读目录时再补读全部来源，推荐导航不因懒加载失效。 */
export async function loadCatalogListingForKinds(api:Pick<MarketCatalogApi,'list'>,kinds:readonly MarketCatalogEntry['kind'][]|undefined):Promise<MarketCatalogCollection>{
 const sources=catalogSourcesForKinds(kinds),first=await loadCatalogListing(api,undefined,sources)
 if(sources.length===marketCatalogSources.length)return first
 const ids=new Set(first.items.map(item=>item.entry.id))
 const dangling=first.items.some(({entry})=>(!kinds||kinds.includes(entry.kind))&&'alternatives' in entry&&(entry.alternatives??[]).some(item=>!ids.has(item.entryId)))
 return dangling?loadCatalogListing(api):first
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
   // 上游条目 artifact 为 null；模型条目无工件，回包必须恰为 null
   if(entry.kind==='model'&&input.artifact!==null)throw Error()
   const art=entry.delivery==='upstream'||entry.kind==='model'?null:artifact(input.artifact)
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
  async add(entryId:string):Promise<{contentId:string}>{
   if(typeof entryId!=='string'||!entryId||entryId.length>120)throw Error('官方目录资源标识不正确。')
   const requestId=awaiting.get(entryId)??newId();awaiting.set(entryId,requestId)
   try{
    const value=await call('market-catalog/add',{requestId,entryId})
    let contentId:string
    try{
     const row=record(value)&&Object.keys(value).length===2&&'receipt' in value&&'content' in value?value:null
     if(!row)throw Error()
     const receipt=record(row.receipt)&&Object.keys(row.receipt).length===4&&'requestId' in row.receipt&&'contentId' in row.receipt&&'source' in row.receipt&&'createdAt' in row.receipt?row.receipt:null
     if(!receipt)throw Error()
     const source=record(receipt.source)&&Object.keys(receipt.source).length===6&&'kind' in receipt.source&&'catalog' in receipt.source&&'catalogVersion' in receipt.source&&'entryId' in receipt.source&&'entryVersion' in receipt.source&&'treeHash' in receipt.source?receipt.source:null
     if(!source)throw Error()
     if(receipt.requestId!==requestId||!uuid(receipt.contentId)||source.kind!=='catalog'||source.entryId!==entryId||!record(row.content)||row.content.id!==receipt.contentId)throw Error()
     contentId=receipt.contentId as string
    }catch{throw Error('官方目录添加回执与原请求不一致。')}
    awaiting.delete(entryId)
    return {contentId}
   }catch(error){if(rejected(error))awaiting.delete(entryId);throw error}
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
  /** AI 同事条目一键建岗；不传 requestId，宿主按（本人, 条目, 版本）派生并幂等，重复添加返回 existing。 */
  async addRole(entryId:string,version:string):Promise<{roleId:string;status:'created'|'existing';skills:string[]}>{
   if(typeof entryId!=='string'||!entryId||entryId.length>120||typeof version!=='string'||!version)throw Error('官方目录资源标识不正确。')
   const value=await call('market-catalog/add',{entryId,version,kind:'role'})
   if(!record(value)||Object.keys(value).length!==3||!uuid(value.roleId)||(value.status!=='created'&&value.status!=='existing')||!Array.isArray(value.skills)||value.skills.some(item=>typeof item!=='string'))throw Error('AI 员工添加回执格式不正确。')
   return {roleId:value.roleId,status:value.status,skills:value.skills as string[]}
  },
 }
}

export const catalogText=(value:{'zh-CN':string;en:string},locale:string)=>locale.startsWith('zh')?value['zh-CN']:value.en
