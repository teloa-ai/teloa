// 夹具：main 4fdb16f4（packages/* 版本 0.2.0-alpha.6）的 v2 索引读取器原样复制（仅把 work-error / resources / roles 的导入改指当前契约），
// 代表已发行旧版应用：逐条严格解析，已知 kind 且版本范围满足本机的条目出现未知字段即整份拒收。不要修改。
import {WorkError} from '../../../packages/contract/src/work-error.ts'
import {isRecord} from '../../../packages/contract/src/resources.ts'
import {readMarketCatalogEntry,type MarketCatalogEntry} from './market-catalog.ts'
import {marketEntryKinds} from './market-taxonomy.ts'
import {parseTeloaRange,teloaRangeSatisfies} from './semver-range.ts'

/**
 * 在线市场索引（规格 2026-09-25 §4.1；多版本并行发布见市场类型扩展规格 §4）。
 *
 * - `index.json`（v1）格式冻结：只收 skill / solution / connector，旧应用照常可读；
 * - `v2/index.json`（v2）收全部 kind；读取时对未知 kind 与 `compatibility.teloa` 不满足本机版本的条目跳过并计数。
 * 两份都不携带工件字节；添加时仍按条目的固定来源逐文件核对。
 */
export type MarketIndex={format:'teloa.market-index/v1';catalogVersion:string;entries:MarketCatalogEntry[]}
export type MarketIndexSkipped={unknownKind:number;newerApp:number}
/** 发布端组装出的 v2 索引文档（不带 skipped，写入 v2/index.json 的就是它）。 */
export type MarketIndexV2Document={format:'teloa.market-index/v2';catalogVersion:string;entries:MarketCatalogEntry[]}
export type MarketIndexV2={format:'teloa.market-index/v2';catalogVersion:string;entries:MarketCatalogEntry[];skipped:MarketIndexSkipped}
/** 应用拉取索引的大小上限（字节）。 */
export const MARKET_INDEX_MAX_BYTES=5*1024*1024
/** 索引发布主机；应用只接受 https 且主机完全一致的地址。 */
export const MARKET_INDEX_HOST='market.teloa.ai'
/** v1 索引冻结收录的 kind。 */
export const MARKET_INDEX_V1_KINDS=['skill','solution','connector'] as const
/** v1 冻结时的行业词表：旧版应用遇到词表外的键会整份拒收，发布端把之后新增的二级键在 v1 中降为其一级键。 */
export const MARKET_INDEX_V1_INDUSTRIES=['general','cyber-security','marketing','media','software','other','cyber-security/soc','cyber-security/detection','cyber-security/appsec','cyber-security/grc','marketing/new-media','media/video'] as const
export function marketIndexPath(version:1|2):'index.json'|'v2/index.json'{return version===1?'index.json':'v2/index.json'}

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const catalogVersionPattern=/^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/

function envelope(value:unknown,format:'teloa.market-index/v1'|'teloa.market-index/v2'):{catalogVersion:string;entries:unknown[]}{
 if(!isRecord(value)||Object.keys(value).length!==3||!Object.hasOwn(value,'format')||!Object.hasOwn(value,'catalogVersion')||!Object.hasOwn(value,'entries'))throw bad('市场索引格式不正确或包含未知字段。')
 if(value.format!==format)throw bad('市场索引格式版本不受支持。')
 if(typeof value.catalogVersion!=='string'||!catalogVersionPattern.test(value.catalogVersion))throw bad('市场索引目录版本格式不正确。')
 if(!Array.isArray(value.entries)||value.entries.length>1000)throw bad('市场索引条目最多 1000 项。')
 return {catalogVersion:value.catalogVersion,entries:value.entries}
}
/** Teloa 自编的内置技能没有外部固定来源（upstream 为 null），只随发行快照提供，不进在线索引（v1 / v2 都不收；旧版读取器要求 upstream）。 */
function noBuiltinWithoutUpstream(entries:MarketCatalogEntry[]):void{
 if(entries.some(entry=>entry.kind==='skill'&&entry.upstream===null))throw bad('市场索引不收无上游来源的 Teloa 内置技能。')
}
function orderedIds(ids:string[]):void{
 if(new Set(ids).size!==ids.length)throw bad('市场索引条目标识不能重复。')
 for(let at=1;at<ids.length;at+=1)if(ids[at-1]!>=ids[at]!)throw bad('市场索引条目必须按标识升序排列。')
}

export function readMarketIndex(value:unknown):MarketIndex{
 const {catalogVersion,entries:raw}=envelope(value,'teloa.market-index/v1')
 const entries=raw.map(item=>readMarketCatalogEntry(item))
 if(entries.some(entry=>!(MARKET_INDEX_V1_KINDS as readonly string[]).includes(entry.kind)))throw bad('v1 索引只收 skill、solution、connector；其余类型请发布到 v2 索引。')
 // v1 是冻结格式：旧应用把 secrets 当未知字段整份拒收，带 secrets 的条目只能进 v2。
 if(entries.some(entry=>entry.kind==='skill'&&entry.secrets!==undefined))throw bad('v1 索引不收声明密钥的技能条目；请发布到 v2 索引。')
 noBuiltinWithoutUpstream(entries)
 orderedIds(entries.map(entry=>entry.id))
 return {format:'teloa.market-index/v1',catalogVersion,entries}
}

/** v2 读取：未知 kind 与 compatibility.teloa 不满足 teloaVersion（含本机不认识的范围语法）的条目跳过并计数；已知 kind 的结构错误仍整份拒绝。严格范围语法只在收录 / 构建端核对。 */
export function readMarketIndexV2(value:unknown,teloaVersion:string):MarketIndexV2{
 const {catalogVersion,entries:raw}=envelope(value,'teloa.market-index/v2')
 const skipped:MarketIndexSkipped={unknownKind:0,newerApp:0},entries:MarketCatalogEntry[]=[],ids:string[]=[]
 for(const item of raw){
  if(!isRecord(item)||typeof item.id!=='string')throw bad('市场索引条目格式不正确。')
  ids.push(item.id)
  if(!(marketEntryKinds as readonly unknown[]).includes(item.kind)){skipped.unknownKind+=1;continue}
  // 先按原始范围判定：新版应用才认识的范围语法本机解析不了，按「需更新应用」跳过，而不是让严格读取整份拒绝。
  const range=isRecord(item.compatibility)?item.compatibility.teloa:undefined
  if(typeof range==='string'&&!teloaRangeSatisfies(range,teloaVersion)){skipped.newerApp+=1;continue}
  entries.push(readMarketCatalogEntry(item))
 }
 noBuiltinWithoutUpstream(entries)
 orderedIds(ids)
 return {format:'teloa.market-index/v2',catalogVersion,entries,skipped}
}

/** v2 发布端组装：只做结构检查（kind 须为已知类型、compatibility.teloa 范围语法严格可解析、标识升序去重），不按本机版本过滤、不产生 skipped。 */
export function assembleMarketIndexV2(value:unknown):MarketIndexV2Document{
 const {catalogVersion,entries:raw}=envelope(value,'teloa.market-index/v2')
 const entries=raw.map(item=>{
  if(!isRecord(item)||typeof item.id!=='string')throw bad('市场索引条目格式不正确。')
  if(!(marketEntryKinds as readonly unknown[]).includes(item.kind))throw bad('市场索引条目类型不受支持：'+item.id)
  const range=isRecord(item.compatibility)?item.compatibility.teloa:undefined
  if(typeof range==='string'){try{parseTeloaRange(range)}catch{throw bad('市场索引条目 Teloa 兼容范围语法不正确：'+item.id)}}
  return readMarketCatalogEntry(item)
 })
 noBuiltinWithoutUpstream(entries)
 orderedIds(entries.map(entry=>entry.id))
 return {format:'teloa.market-index/v2',catalogVersion,entries}
}
