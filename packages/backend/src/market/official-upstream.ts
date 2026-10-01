import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join,dirname} from 'node:path'
import {WorkError,readMarketCatalogEntry,type MarketCatalogUpstreamSkillEntry,type MarketIndexSkipped} from '@teloa/contract'
import {officialUpstreamIndexSha256} from './official-upstream-index-sha256.ts'

const sha256=(value:string)=>createHash('sha256').update(value).digest('hex')
const corrupt=()=>new WorkError('teloa/storage-corrupt','上游资源索引完整性校验失败，上游目录已停用。')

// full entry cache: loaded lazily at startup
let cache:Map<string,MarketCatalogUpstreamSkillEntry>|WorkError|undefined
// 在线索引采用后的上游目录：签名与结构都通过才整份替换（official-catalog-remote.ts），优先于随发行打包的索引。
let remote:Map<string,MarketCatalogUpstreamSkillEntry>|undefined

let remoteSkipped:MarketIndexSkipped={unknownKind:0,newerApp:0}
/** 原子替换在线上游目录；只由验签通过的在线索引调用。v2 索引带跳过计数，v1 传缺省全 0。 */
export function adoptRemoteUpstreamEntries(entries:readonly MarketCatalogUpstreamSkillEntry[],skipped:MarketIndexSkipped={unknownKind:0,newerApp:0}):void{
 remote=new Map(entries.map(entry=>[entry.id,entry]))
 remoteSkipped={...skipped}
}
/** 最近一次采用的在线索引跳过计数；供 market-catalog/list 回包给界面显示「有 N 项需更新应用后可用」。 */
export function remoteIndexSkipped():MarketIndexSkipped{return {...remoteSkipped}}

/** 启动时调用，验证索引完整性并缓存所有条目。 */
export async function loadOfficialUpstreamIndex():Promise<void>{
 try{
  const indexPath=join(dirname(fileURLToPath(import.meta.url)),'official-upstream-index.json')
  const raw=await readFile(indexPath,'utf8')
  if(sha256(raw)!==officialUpstreamIndexSha256)throw corrupt()
  let parsed:unknown
  try{parsed=JSON.parse(raw)}catch{throw corrupt()}
  if(!parsed||typeof parsed!=='object'||!Array.isArray((parsed as Record<string,unknown>).entries))throw corrupt()
  const index=parsed as {entries:unknown[]}
  const map=new Map<string,MarketCatalogUpstreamSkillEntry>()
  for(const raw of index.entries){
   try{
    const entry=readMarketCatalogEntry(raw)
    if(entry.delivery!=='upstream')throw new Error('delivery must be upstream')
    map.set(entry.id,entry as MarketCatalogUpstreamSkillEntry)
   }catch(err){
    if(err instanceof WorkError&&err.code==='teloa/storage-corrupt')throw err
    throw corrupt()
   }
  }
  cache=map
 }catch(error){
  cache=error instanceof WorkError?error:corrupt()
 }
}

function getCache():Map<string,MarketCatalogUpstreamSkillEntry>{
 if(remote)return remote
 if(!cache)throw new WorkError('teloa/source-unavailable','上游资源索引尚未加载。')
 if(cache instanceof WorkError)throw cache
 return cache
}

/** 上游来源列表：索引未加载或损坏时抛 WorkError（source-unavailable / storage-corrupt），调用方据此显示「来源暂时无法读取」，不能当作空目录。 */
export function listUpstreamEntries():MarketCatalogUpstreamSkillEntry[]{
 return [...getCache().values()]
}

export function getUpstreamEntry(id:string):MarketCatalogUpstreamSkillEntry|undefined{
 try{return getCache().get(id)}catch{return undefined}
}
