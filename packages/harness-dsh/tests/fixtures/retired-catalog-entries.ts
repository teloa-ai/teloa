import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {readMarketCatalogIndex,type MarketCatalogConnectorEntry,type MarketCatalogIndexEntry,type MarketCatalogModelEntry} from '@teloa/contract'

/**
 * 已下架官方目录条目的协议夹具（只用于测试，不回目录）。
 *
 * 来源固定：官方目录快照 2026.10.7.1（索引 sha256 b4698aac…，社区仓提交 a655079），
 * 这些条目自 2026.10.14.5 起不在市场目录；本机 Ollama 模型、MiniMax 原生模型设置/BYOK 与 OAuth 连接器
 * 仍是平台能力，相关测试改用本夹具而不是读取当前目录。
 * 夹具整体经 readMarketCatalogIndex 读取：条目结构、工件清单与树摘要都按契约核验，和真实快照同一规则。
 */
const raw=JSON.parse(readFileSync(new URL('./retired-catalog-entries.json',import.meta.url),'utf8')) as {source:{catalogVersion:string;indexSha256:string;commit:string;retiredIn:string};entries:unknown[]}
const sha256=(text:string)=>createHash('sha256').update(text).digest('hex')
const index=readMarketCatalogIndex({format:'teloa.market-catalog/v1',catalogVersion:raw.source.catalogVersion,entries:raw.entries},sha256)

export const retiredCatalogSource=raw.source
export const retiredCatalogEntries:readonly MarketCatalogIndexEntry[]=index.entries
const byId=new Map(index.entries.map(entry=>[entry.id,entry]))
export function retiredEntry(id:string):MarketCatalogIndexEntry{
 const entry=byId.get(id)
 if(!entry)throw new Error('已下架条目夹具里没有 '+id)
 return entry
}
/** 原目录里的 5 个 local-general 本机模型条目（Ollama 运行时）。 */
export const retiredLocalModelEntries:readonly MarketCatalogModelEntry[]=index.entries.flatMap(entry=>entry.kind==='model'&&entry.model.form==='local-general'?[entry]:[])
/** 原目录 MiniMax 云模型条目：自定义 provider（anthropic-messages，国内站 /anthropic）。 */
export const retiredMinimaxEntry=retiredEntry('teloa.model.minimax') as MarketCatalogModelEntry
/** 原目录 OAuth 连接器条目（Supabase 远端、GitLab、Composio）。 */
export const retiredOAuthConnectorEntries:readonly MarketCatalogConnectorEntry[]=index.entries.flatMap(entry=>entry.kind==='connector'?[entry]:[])
