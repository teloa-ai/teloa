// 夹具：main 分叉点 f12fef61 的 v1 索引读取器原样复制（仅把 work-error / resources 的导入改指当前契约），
// 代表已发行旧版应用：oauth 只认 {kind, reason}，逐条严格解析、一条不合规即整份拒收。不要修改。
import {WorkError} from '../../../packages/contract/src/work-error.ts'
import {isRecord} from '../../../packages/contract/src/resources.ts'
import {readMarketCatalogEntry,type MarketCatalogEntry} from './market-catalog.ts'

/**
 * 在线市场索引（发布到 https://market.teloa.ai/index.json，规格 2026-09-25 §4.1）。
 *
 * 与随发行固定的快照 `teloa.market-catalog/v1` 不同：索引同时收录 Teloa 官方条目
 * （delivery builtin / install / managed）与上游固定来源条目（delivery upstream），
 * 且不携带工件字节。条目只影响浏览与添加入口；添加时仍按条目的固定来源逐文件核对。
 */
export type MarketIndex={format:'teloa.market-index/v1';catalogVersion:string;entries:MarketCatalogEntry[]}
/** 应用拉取索引的大小上限（字节）。 */
export const MARKET_INDEX_MAX_BYTES=5*1024*1024
/** 索引发布主机；应用只接受 https 且主机完全一致的地址。 */
export const MARKET_INDEX_HOST='market.teloa.ai'

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)

export function readMarketIndex(value:unknown):MarketIndex{
 if(!isRecord(value)||Object.keys(value).length!==3||!Object.hasOwn(value,'format')||!Object.hasOwn(value,'catalogVersion')||!Object.hasOwn(value,'entries'))throw bad('市场索引格式不正确或包含未知字段。')
 if(value.format!=='teloa.market-index/v1')throw bad('市场索引格式版本不受支持。')
 if(typeof value.catalogVersion!=='string'||!/^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/.test(value.catalogVersion))throw bad('市场索引目录版本格式不正确。')
 if(!Array.isArray(value.entries)||value.entries.length>1000)throw bad('市场索引条目最多 1000 项。')
 const entries=value.entries.map(item=>readMarketCatalogEntry(item))
 const ids=entries.map(entry=>entry.id)
 if(new Set(ids).size!==ids.length)throw bad('市场索引条目标识不能重复。')
 for(let at=1;at<ids.length;at+=1)if(ids[at-1]!>=ids[at]!)throw bad('市场索引条目必须按标识升序排列。')
 return {format:'teloa.market-index/v1',catalogVersion:value.catalogVersion,entries}
}
