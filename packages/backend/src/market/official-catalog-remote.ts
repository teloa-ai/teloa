import {isRecord,readMarketIndex,readMarketIndexV2,verifyMarketIndex,marketIndexPath,MARKET_INDEX_HOST,MARKET_INDEX_MAX_BYTES,type MarketIndex,type MarketIndexV2,type MarketCatalogConnectorEntry,type MarketCatalogUpstreamSkillEntry} from '@teloa/contract'
import {adoptRemoteUpstreamEntries} from './official-upstream.ts'
import {officialCatalogIndex} from './official-catalog-snapshot.ts'

/**
 * 应用拉取签名在线索引（规格 2026-09-25 §4.1；计划 功能验证）。
 *
 * - 只接受 https 且主机为 market.teloa.ai，禁止重定向，索引不超过 5 MiB，用 ETag 缓存；
 * - 验签（Ed25519，覆盖 index.json 完整字节）与结构校验都通过后，原子替换内存中的在线目录；
 * - 任何一步失败整份拒绝、保留当前目录，只记一条原因，不打扰用户；
 * - 先拉本机支持的最高格式版本 v2（v2/index.json，含全部 kind 与跳过计数），下载、验签或结构任一失败回退 v1（index.json，冻结三类）；
 * - 目录版本只升不降：验签与结构都通过、但 catalogVersion 早于本机随发行固定的目录或已采用的在线目录时，同样整份拒绝（照常回退 v1），
 *   避免服务端滞后的旧索引覆盖新发行目录；版本按 YYYY.M.D[.N] 各段数值比较，不合规范的版本一律拒绝。
 *
 * 索引中的上游条目（delivery upstream）替换进浏览与添加入口：这些条目添加时按固定来源逐文件核对；
 * 非 stdio 连接器（managed）不需要工件字节，替换进官方连接目录，仍经受管连接添加与本人授权；快照同 id / 同服务名的条目优先。
 * 其余 Teloa 官方条目（builtin / install、stdio 连接器）的工件字节随发行固定，在线索引里的新条目应用拿不到字节，
 * 因此结构上照样校验，但不进入列表，待下一发行随快照更新。
 */
export type OfficialCatalogRemoteOptions={
 /** SPKI PEM 公钥；随应用发行内置。 */
 publicKey:string
 /** 本机应用版本（semver），v2 索引按 compatibility.teloa 过滤时使用。 */
 teloaVersion:string
 /** 本机目录版本下限；默认取随发行固定的目录快照（official-catalog-snapshot.ts）的 catalogVersion。测试注入以使用人工夹具版本。 */
 baselineCatalogVersion?:string
 url?:string
 urlV2?:string
 fetch?:typeof fetch
 /** info：常态（v2 尚未发布时的 404 回退、采用时的跳过计数）；warn：真正异常（验签 / 结构 / 网络 / 非 404 状态）。 */
 log?:(level:'info'|'warn',message:string)=>void
}
export type OfficialCatalogRemoteResult='adopted'|'unchanged'|'rejected'

/** 各格式版本的索引地址；以后 v3 同理。 */
export function marketIndexUrl(version:1|2):string{return `https://${MARKET_INDEX_HOST}/${marketIndexPath(version)}`}
export const MARKET_INDEX_URL=marketIndexUrl(1)
const SIX_HOURS=6*60*60*1000
const REQUEST_TIMEOUT_MS=30_000
const MAX_SIGNATURE_BYTES=1024

class Rejected extends Error{
 readonly status:number|undefined
 constructor(message:string,status?:number){super(message);this.status=status}
}
const reject=(message:string,status?:number)=>new Rejected(message,status)

type CatalogVersion={text:string;parts:number[]}
/** 目录版本 YYYY.M.D 或 YYYY.M.D.N（N 为当日序号，缺省为 0）；不合规范返回 null。 */
function parseCatalogVersion(text:string):CatalogVersion|null{
 const match=/^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d{1,6}))?$/.exec(text)
 return match?{text,parts:[Number(match[1]),Number(match[2]),Number(match[3]),Number(match[4]??0)]}:null
}
/** 逐段数值比较（2026.10.1 晚于 2026.9.30，2026.10.1.10 晚于 2026.10.1.9），不按字符串。 */
function compareCatalogVersion(a:CatalogVersion,b:CatalogVersion):number{
 for(let i=0;i<4;i++){const diff=a.parts[i]!-b.parts[i]!;if(diff)return diff}
 return 0
}
const snapshotCatalogVersion=isRecord(officialCatalogIndex)&&typeof officialCatalogIndex.catalogVersion==='string'?officialCatalogIndex.catalogVersion:''

function validateUrl(value:string):URL{
 let url:URL
 try{url=new URL(value)}catch{throw reject('索引地址无效。')}
 if(url.protocol!=='https:')throw reject('索引地址必须使用 https。')
 if(url.hostname!==MARKET_INDEX_HOST)throw reject('索引主机不在白名单内：'+url.hostname)
 if(url.port||url.username||url.password)throw reject('索引地址不允许端口或用户信息。')
 return url
}

const limitLabel=(limit:number)=>limit>=1024*1024?(limit/1024/1024)+' MiB':(limit/1024)+' KiB'
/** 边读边计数（Content-Length 已在 download 核对过），超过上限立即中止，不把整份响应读进内存。 */
async function readLimited(response:Response,limit:number,label:string):Promise<Uint8Array>{
 if(!response.body)throw reject(label+'没有内容。')
 const reader=response.body.getReader(),chunks:Uint8Array[]=[]
 let total=0
 for(;;){
  const {done,value}=await reader.read()
  if(done)break
  total+=value.byteLength
  if(total>limit){await reader.cancel().catch(()=>{});throw reject(label+'大小超过 '+limitLabel(limit)+' 上限。')}
  chunks.push(value)
 }
 const out=new Uint8Array(total);let at=0
 for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength}
 return out
}

export class OfficialCatalogRemote{
 private readonly urls:{1:string;2:string}
 private readonly teloaVersion:string
 private readonly fetchImpl:typeof fetch
 private readonly log:(level:'info'|'warn',message:string)=>void
 private readonly publicKey:string
 private etags:{1:string|null;2:string|null}={1:null,2:null}
 // 当前采用的格式版本；只对它带 if-none-match，避免回退 v1 后 v2 恢复时被旧 ETag 的 304 拦住而停在 v1。
 private adopted:1|2|null=null
 private index:MarketIndex|MarketIndexV2|null=null
 // 可采用的最低目录版本：初始为本机固定目录版本，每次采用后抬升到已采用版本，只升不降。
 private floor:CatalogVersion
 private timer:ReturnType<typeof setInterval>|null=null
 private inflight:Promise<OfficialCatalogRemoteResult>|null=null
 constructor(options:OfficialCatalogRemoteOptions){
  const baseline=options.baselineCatalogVersion??snapshotCatalogVersion,floor=parseCatalogVersion(baseline)
  if(!floor)throw new Error('本机目录版本不符合 YYYY.M.D[.N]：'+baseline)
  this.floor=floor
  this.urls={1:options.url??marketIndexUrl(1),2:options.urlV2??marketIndexUrl(2)}
  this.teloaVersion=options.teloaVersion
  this.fetchImpl=options.fetch??fetch
  this.log=options.log??(()=>{})
  this.publicKey=options.publicKey
 }
 /** 最近一次采用的索引；从未成功时为 null。 */
 current():MarketIndex|MarketIndexV2|null{return this.index}
 private async download(url:string,limit:number,label:string,headers:Record<string,string>):Promise<Response>{
  let response:Response
  try{response=await this.fetchImpl(url,{redirect:'error',headers,signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)})}
  catch(error){throw reject(label+'下载失败（redirect 或网络错误）：'+(error instanceof Error?error.message:String(error)))}
  if(response.redirected)throw reject(label+'发生重定向，已拒绝。')
  if(response.status===304)return response
  if(response.status!==200)throw reject(label+'返回状态 '+response.status+'。',response.status)
  const declared=Number(response.headers.get('content-length'))
  if(Number.isFinite(declared)&&declared>limit)throw reject(label+'声明大小超过 '+limitLabel(limit)+' 上限。')
  return response
 }
 private async fetchVersion(version:1|2):Promise<OfficialCatalogRemoteResult>{
  const url=validateUrl(this.urls[version]).toString(),label=version===2?'v2 索引':'索引'
  // 先取签名再取索引：发布时 index.json 与 .sig 相继覆盖，先拿签名可减少拿到「新索引 + 旧签名」的窗口。
  const signatureResponse=await this.download(url+'.sig',MAX_SIGNATURE_BYTES,label+'签名',{})
  const signatureText=new TextDecoder().decode(await readLimited(signatureResponse,MAX_SIGNATURE_BYTES,label+'签名')).trim()
  const etag=this.adopted===version?this.etags[version]:null
  const response=await this.download(url,MARKET_INDEX_MAX_BYTES,label,etag?{'if-none-match':etag}:{})
  if(response.status===304)return 'unchanged'
  const bytes=await readLimited(response,MARKET_INDEX_MAX_BYTES,label)
  const signature=/^[A-Za-z0-9+/]+=*$/.test(signatureText)?Buffer.from(signatureText,'base64'):Buffer.alloc(0)
  if(signature.byteLength!==64)throw reject(label+'签名文件格式不正确。')
  if(!verifyMarketIndex(bytes,signature,this.publicKey))throw reject(label+'签名验证失败。')
  let parsed:unknown
  try{parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))}catch{throw reject(label+'不是合法 JSON。')}
  let index:MarketIndex|MarketIndexV2
  try{index=version===2?readMarketIndexV2(parsed,this.teloaVersion):readMarketIndex(parsed)}catch(error){throw reject(label+'结构不合法：'+(error instanceof Error?error.message:String(error)))}
  // 连接器服务名是本机连接与工具公开名的命名空间，索引内重复按结构不合法整份拒绝（快照读取器同样要求唯一）。
  const connectors=index.entries.filter((entry):entry is MarketCatalogConnectorEntry=>entry.kind==='connector')
  if(new Set(connectors.map(entry=>entry.connector.serverName)).size!==connectors.length)throw reject(label+'结构不合法：连接器服务名重复。')
  // 整份替换会移除旧索引没有的条目，因此只接受不早于本机固定目录与已采用目录的版本；不合并新旧条目。
  const catalogVersion=parseCatalogVersion(index.catalogVersion)
  if(!catalogVersion)throw reject(label+'目录版本不符合 YYYY.M.D[.N]：'+index.catalogVersion)
  if(compareCatalogVersion(catalogVersion,this.floor)<0)throw reject(label+'目录版本 '+index.catalogVersion+' 早于本机目录 '+this.floor.text+'，不替换。')
  // 签名确认发布身份，不能把已退出的第三方目录重新变成用户可浏览的市场渠道。
  // 原始出处仅用于已审 Teloa 应用的许可与安装溯源；本人自建或已安装的资源不受此目录规则影响。
  const reviewedSources=new Set(['claude-code','codex','dsh','cursor'])
  if(index.entries.some(entry=>entry.review.reviewer!=='Teloa'||entry.delivery==='upstream'&&!reviewedSources.has(entry.origin.marketplace)))throw reject(label+'含有不符合 Teloa 官方收录规则的条目。')
  // stdio 连接器的安装锁随发行工件逐字节固定，在线索引不带工件字节，只记数不采用。
  const remoteConnectors=connectors.filter(entry=>entry.connector.recipe.transport!=='stdio'),stdio=connectors.length-remoteConnectors.length
  // 结构与签名都通过后才替换，且一次性替换（不做部分采用）：上游条目与连接器先采用成功，再记索引与 ETag，失败时状态不变。
  const skipped=index.format==='teloa.market-index/v2'?index.skipped:{unknownKind:0,newerApp:0}
  adoptRemoteUpstreamEntries(index.entries.filter((entry):entry is MarketCatalogUpstreamSkillEntry=>entry.delivery==='upstream'),skipped,remoteConnectors)
  this.index=index
  this.floor=catalogVersion
  this.adopted=version
  this.etags[version]=response.headers.get('etag')
  // unknownKind 只进计数与日志（对本机永远不可用，界面不提示）；newerApp 由界面显示一行。
  if(skipped.unknownKind||skipped.newerApp)this.log('info',`v2 索引已采用：跳过未知类型 ${skipped.unknownKind} 项、需更新应用 ${skipped.newerApp} 项。`)
  if(stdio)this.log('info',`${label}已采用：stdio 连接器 ${stdio} 项需随应用发行提供安装锁，暂不进入在线目录。`)
  return 'adopted'
 }
 /** 先拉本机支持的最高格式版本（v2）；下载、验签或结构任一失败则回退 v1，只记一条原因（v2 尚未发布的 404 记 info，其余 warn）。 */
 private async fetchOnce():Promise<OfficialCatalogRemoteResult>{
  try{return await this.fetchVersion(2)}
  catch(error){
   if(!(error instanceof Rejected))throw error
   this.log(error.status===404?'info':'warn','v2 索引未采用，回退 v1：'+error.message)
   return this.fetchVersion(1)
  }
 }
 /** 拉取一次；并发调用合并为同一次。失败只记原因并返回 rejected，永不抛出。 */
 refresh():Promise<OfficialCatalogRemoteResult>{
  return this.inflight??=this.fetchOnce().catch(error=>{
   this.log('warn',error instanceof Rejected?error.message:'索引拉取出错：'+(error instanceof Error?error.message:String(error)))
   return 'rejected' as const
  }).finally(()=>{this.inflight=null})
 }
 /** 启动时拉取一次，之后按周期拉取；计时器不阻止进程退出。 */
 start(intervalMs=SIX_HOURS):void{
  if(this.timer)return
  void this.refresh()
  this.timer=setInterval(()=>{void this.refresh()},intervalMs)
  this.timer.unref?.()
 }
 stop():void{
  if(this.timer){clearInterval(this.timer);this.timer=null}
 }
}
