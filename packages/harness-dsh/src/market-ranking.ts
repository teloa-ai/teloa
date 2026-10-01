import {detectExclusion,getEndpointBase} from './usage-stats.ts'

export type MarketRankingEntry={id:string;installs:number;recent:number}
export type MarketRanking={asOf:string|null;entries:MarketRankingEntry[]}

const EMPTY:MarketRanking={asOf:null,entries:[]}
const TTL_MS=10*60_000
const RETRY_MS=60_000
const MAX_BYTES=256*1024
const catalogId=/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,2}$/
const count=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>=0
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
const invalid=()=>new Error('invalid ranking')

/** 严格读取 metrics 服务的榜单（规格 2026-09-26 §6）：格式、时间、条目 ID 规则、非负整数；任一不符就整份拒绝。 */
export function readMarketRanking(value:unknown):MarketRanking{
 if(!record(value)||value.format!=='teloa.market-installs/v1'||typeof value.asOf!=='string'||Number.isNaN(Date.parse(value.asOf))||!Array.isArray(value.entries)||value.entries.length>2000)throw invalid()
 const entries=value.entries.map(item=>{
  if(!record(item)||typeof item.id!=='string'||!catalogId.test(item.id)||!count(item.installs)||!count(item.recent))throw invalid()
  return {id:item.id,installs:item.installs,recent:item.recent}
 })
 return {asOf:value.asOf,entries}
}

/** 按字节累计读取响应体：声明长度或实际字节超过上限即中止（抛出时 for-await 会取消底层流）。 */
async function readLimited(response:Response):Promise<string>{
 if(Number(response.headers.get('content-length')??0)>MAX_BYTES)throw invalid()
 const chunks:Uint8Array[]=[]
 let size=0
 for await(const chunk of response.body??[]){
  size+=chunk.byteLength
  if(size>MAX_BYTES)throw invalid()
  chunks.push(chunk)
 }
 return Buffer.concat(chunks).toString('utf8')
}

/**
 * 应用读取安装量榜单：与上报用同一开关（TELOA_USAGE_STATS=on 且无内部排除）；处于排除环境时不联网，直接返回空榜。
 * 成功结果缓存 10 分钟；失败后 1 分钟内不重试，期间返回上次成功的结果，没有则返回空榜。榜单只影响排序与展示，不影响添加。
 * 缓存过期时的并发调用合并为同一次请求。
 * known：宿主本地目录快照中是否仍有该条目；已下架或不存在的条目从榜单剔除。
 * getEndpointEnv：上报地址只认宿主传入的只读启动快照（launch-env.ts），工作区 `.env` 不能把榜单读取改发到别处。
 */
export function createMarketRanking(getEnv:()=>NodeJS.ProcessEnv=()=>process.env,now:()=>number=()=>Date.now(),known:(id:string)=>boolean=()=>true,getEndpointEnv:()=>Readonly<Record<string,string|undefined>>=()=>process.env){
 let good:MarketRanking|undefined
 let nextAt=0
 let inflight:Promise<MarketRanking>|undefined
 const refresh=async():Promise<MarketRanking>=>{
  try{
   const response=await fetch(getEndpointBase(getEndpointEnv())+'/v1/market-installs',{redirect:'error',signal:AbortSignal.timeout(3000)})
   if(!response.ok)throw invalid()
   const ranking=readMarketRanking(JSON.parse(await readLimited(response)))
   good={asOf:ranking.asOf,entries:ranking.entries.filter(entry=>known(entry.id))}
   nextAt=now()+TTL_MS
  }catch{
   nextAt=now()+RETRY_MS
  }
  return good??EMPTY
 }
 return async():Promise<MarketRanking>=>{
  if(detectExclusion(getEnv()))return EMPTY
  if(now()<nextAt)return good??EMPTY
  inflight??=refresh().finally(()=>{inflight=undefined})
  return inflight
 }
}
