import {WorkError,isRecord,readMarketRatings,readMarketReviewPage,readMarketOwnReview,readMarketAccountStatus,checkMarketReviewInput,marketReviewEntryId,type MarketRatings,type MarketLinkPoll,type MarketLinkStart} from '@teloa/contract'
import {detectMarketRemoteExclusion} from './market-remote.ts'

/**
 * 市场评分评论的宿主端（规格 2026-09-25-市场三期评分评论 §3、§4.4、§13、§14）。
 * - 只连 https://api.market.teloa.ai；回环覆盖 TELOA_MARKET_API_ENDPOINT=http://127.0.0.1:<端口> 只在浏览器验收态
 *   （TELOA_BROWSER_ACCEPTANCE=1）生效，供本机桩，其他环境与其他值一律忽略；禁重定向、响应 ≤1 MiB、15 秒超时；
 *   回包经契约读取器与本文件的线上形状核对严格校验。
 * - 跟随在线市场开关 TELOA_MARKET_REMOTE（detectMarketRemoteExclusion）：未启用时不联网，summary 返回 enabled:false。
 *   验收态本身会关闭在线市场；只有 TELOA_MARKET_REMOTE=on 且回环覆盖生效时，评价接口才在验收里接本机桩。
 * - 应用令牌只存凭据记录（index.ts 接 ctx.credentials 的 teloa-market/account），不写日志、不回前端、不进会话；服务端回 401 即删除本机记录。
 * - RPC 只在本人浏览器的 /teloa 连接上分发（不进 endpointSet）；会话发表另经原生确认卡（market-review-tools.ts）。
 */
export const marketReviewEndpoints=['market-reviews/summary','market-reviews/list','market-reviews/account','market-reviews/link-start','market-reviews/link-poll','market-reviews/unlink','market-reviews/mine','market-reviews/publish','market-reviews/delete'] as const
export type MarketReviewEndpoint=typeof marketReviewEndpoints[number]
export type MarketCredentialStore={read():Promise<string|undefined>;write(token:string):Promise<void>;remove():Promise<void>}
export type MarketReviewsOptions={getEnv:()=>NodeJS.ProcessEnv;store:MarketCredentialStore;appVersion:string;fetch?:typeof fetch;now?:()=>number}

const API_ORIGIN='https://api.market.teloa.ai'
const SITE_ACCOUNT='https://market.teloa.ai/account/'
const SITE_CONNECT='https://market.teloa.ai/account/connect/'
const TIMEOUT_MS=15_000,MAX_BYTES=1024*1024,SUMMARY_TTL=5*60_000,SUMMARY_BACKOFF=60_000
const TOKEN=/^tmkt_[A-Za-z0-9_-]{43}$/
const DEVICE_CODE=/^[A-Za-z0-9_-]{43}$/
const USER_CODE=/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/
// 与 market-worker/src/protocol.mjs 的 parseCursor 同形：修改时间毫秒（安全整数）.评价 ID
const CURSOR=/^(?:0|[1-9]\d{0,15})\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** 回环覆盖：只在验收态、只认 http://127.0.0.1:<端口>；生产、开发、CI 一律不认。 */
function marketApiOverride(env:NodeJS.ProcessEnv):string|undefined{
 const override=env.TELOA_MARKET_API_ENDPOINT
 return env.TELOA_BROWSER_ACCEPTANCE==='1'&&override&&/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(override)?override:undefined
}
export function marketApiBase(env:NodeJS.ProcessEnv):string{
 return marketApiOverride(env)??API_ORIGIN
}
/** 评价接口是否联网：沿用在线市场开关；验收态例外只在回环覆盖生效、且其余开关（on / 非 CI / 非开发）全部放行时成立，此时请求只会到本机桩。 */
export function marketReviewsEnabled(env:NodeJS.ProcessEnv):boolean{
 const reason=detectMarketRemoteExclusion(env)
 if(reason===undefined)return true
 if(reason!=='acceptance'||marketApiOverride(env)===undefined)return false
 const {TELOA_BROWSER_ACCEPTANCE:_acceptance,...rest}=env
 return detectMarketRemoteExclusion(rest)===undefined
}

const unavailable=()=>new WorkError('teloa/source-unavailable','市场评价服务暂不可用，请稍后重试。')
const disabled=()=>new WorkError('teloa/source-unavailable','在线市场未启用，评分与评价暂不可用。')
const invalidInput=()=>new WorkError('teloa/invalid-input','市场评价请求格式不正确或包含未知字段。')
const hostBad=()=>new WorkError('teloa/invalid-host-response','市场评价服务返回了无效内容。')
const notLinked=()=>new WorkError('teloa/forbidden','还没有连接市场账号：请在 市场 > 官方目录 > 条目的「评价」里连接。')
const vaultDown=()=>new WorkError('teloa/storage-unavailable','本机密钥存储暂不可用，无法读取或保存市场账号连接。')

function mapError(status:number,body:unknown):WorkError{
 const code=isRecord(body)&&typeof body.error==='string'?body.error:''
 if(status===401)return new WorkError('teloa/forbidden','市场账号连接已失效，请在市场里重新连接。')
 if(status===404)return new WorkError('teloa/not-found','市场里没有这个条目或这条评价。')
 if(status===409)return new WorkError('teloa/conflict','你已认领该条目，不能评价自己的条目。')
 if(status===429)return new WorkError('teloa/dependency-unavailable','操作太频繁，请稍后再试。')
 if(status===400&&code==='invalid_input')return new WorkError('teloa/invalid-input','评价需要 1–5 星，正文最多 2000 字、最多 2 个链接，不能包含控制字符或违规用语。')
 if(status===403)return new WorkError('teloa/forbidden','市场服务拒绝了这次操作。')
 return unavailable()
}

async function readLimited(response:Response):Promise<string>{
 if(!response.body)return ''
 const reader=response.body.getReader(),chunks:Uint8Array[]=[]
 let total=0
 for(;;){
  const {done,value}=await reader.read()
  if(done)break
  total+=value.byteLength
  if(total>MAX_BYTES){await reader.cancel().catch(()=>{});throw unavailable()}
  chunks.push(value)
 }
 const out=new Uint8Array(total);let at=0
 for(const chunk of chunks){out.set(chunk,at);at+=chunk.byteLength}
 return new TextDecoder('utf-8',{fatal:true}).decode(out)
}

/** 只接受恰好这些自有字段的 JSON 对象。 */
const exact=(value:unknown,keys:readonly string[]):value is Record<string,unknown>=>isRecord(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
function readWireSummary(value:unknown):MarketRatings{
 if(!exact(value,['format','asOf','entries'])||value.format!=='teloa.market-ratings/v1')throw hostBad()
 return readMarketRatings({enabled:true,asOf:value.asOf,entries:value.entries})
}
/** GET /v1/me（应用令牌）：{account:{id,provider,nickname,githubLogin,admin,createdAt},login,moderation}；只取昵称、登录方式与审核方式（post 为先发后审，未知值按先审后发）。 */
function readMe(value:unknown):{linked:true;nickname:string;provider:'email'|'github';moderation:'pre'|'post'}{
 if(!exact(value,['account','login','moderation'])||!exact(value.account,['id','provider','nickname','githubLogin','admin','createdAt']))throw hostBad()
 const status=readMarketAccountStatus({linked:true,nickname:value.account.nickname,provider:value.account.provider})
 if(!status.linked)throw hostBad()
 return {...status,moderation:value.moderation==='post'?'post':'pre'}
}
function exactPayload(payload:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(payload)||Object.keys(payload).some(key=>!keys.includes(key)))throw invalidInput()
 return payload
}
function entryOf(value:unknown):string{
 if(typeof value!=='string'||!marketReviewEntryId.test(value))throw invalidInput()
 return value
}

export function createMarketReviewsHandler(options:MarketReviewsOptions){
 const fetchImpl=options.fetch??fetch,now=options.now??Date.now
 let summaryCache:{at:number;value:MarketRatings}|null=null,summaryFailedAt=Number.NEGATIVE_INFINITY
 // 设备码只留在宿主内存，不回前端
 let pending:{deviceCode:string;expiresAt:number}|null=null
 const enabled=()=>marketReviewsEnabled(options.getEnv())
 // 凭据存储故障（锁定、不可写）只报固定文案：内部错误可能带记录键名
 const vault=async<T>(run:()=>Promise<T>):Promise<T>=>{try{return await run()}catch{throw vaultDown()}}
 const readToken=async():Promise<string|undefined>=>{const value=await vault(()=>options.store.read());return value&&TOKEN.test(value)?value:undefined}

 async function call(method:string,path:string,init:{body?:unknown;token?:string}={}):Promise<unknown>{
  if(!enabled())throw disabled()
  let response:Response,body:unknown
  try{
   response=await fetchImpl(marketApiBase(options.getEnv())+path,{method,redirect:'error',signal:AbortSignal.timeout(TIMEOUT_MS),
    headers:{Accept:'application/json',...(init.body===undefined?{}:{'Content-Type':'application/json'}),...(init.token?{Authorization:'Bearer '+init.token}:{})},
    ...(init.body===undefined?{}:{body:JSON.stringify(init.body)})})
   body=JSON.parse(await readLimited(response))
  }catch{throw unavailable()}
  if(response.status===401&&init.token)await vault(()=>options.store.remove())
  if(response.status<200||response.status>=300)throw mapError(response.status,body)
  return body
 }
 async function token():Promise<string>{
  const value=await readToken()
  if(!value)throw notLinked()
  return value
 }

 async function summary():Promise<MarketRatings>{
  if(!enabled())return {enabled:false,asOf:null,entries:[]}
  const at=now(),fallback=()=>summaryCache?.value??{enabled:true,asOf:null,entries:[]}
  if(summaryCache&&at-summaryCache.at<SUMMARY_TTL)return summaryCache.value
  if(at-summaryFailedAt<SUMMARY_BACKOFF)return fallback()
  try{
   const value=readWireSummary(await call('GET','/v1/summary'))
   summaryCache={at,value}
   return value
  }catch{
   summaryFailedAt=at
   return fallback()
  }
 }
 async function account(){
  const value=await readToken()
  if(!value)return {linked:false as const}
  try{return readMe(await call('GET','/v1/me',{token:value}))}
  catch(error){if(error instanceof WorkError&&error.code==='teloa/forbidden')return {linked:false as const};throw error}
 }
 async function linkStart():Promise<MarketLinkStart>{
  if(await readToken())throw new WorkError('teloa/conflict','已经连接了市场账号；如需更换，请先断开。')
  const body=await call('POST','/v1/device/start',{body:{label:'Teloa '+options.appVersion}})
  // 可选 verificationUriComplete（连接确认页带码链接）：只在恰为 connect 页 + 本次用户码时采用，否则丢弃该键、仍用账号页链接
  const complete=isRecord(body)&&Object.hasOwn(body,'verificationUriComplete')?body.verificationUriComplete:undefined
  if(!exact(body,complete===undefined?['deviceCode','userCode','verificationUri','expiresIn','interval']:['deviceCode','userCode','verificationUri','verificationUriComplete','expiresIn','interval'])||typeof body.deviceCode!=='string'||!DEVICE_CODE.test(body.deviceCode)||typeof body.userCode!=='string'||!USER_CODE.test(body.userCode)||body.verificationUri!==SITE_ACCOUNT
   ||typeof body.expiresIn!=='number'||!Number.isInteger(body.expiresIn)||body.expiresIn<60||body.expiresIn>900||typeof body.interval!=='number'||!Number.isInteger(body.interval)||body.interval<1||body.interval>60)throw hostBad()
  const expiresAt=now()+body.expiresIn*1000
  pending={deviceCode:body.deviceCode,expiresAt}
  const direct=SITE_CONNECT+'?code='+encodeURIComponent(body.userCode)
  return {userCode:body.userCode,verificationUri:complete===direct?direct:SITE_ACCOUNT+'?code='+body.userCode,expiresAt:new Date(expiresAt).toISOString(),interval:body.interval}
 }
 async function linkPoll(payload:unknown):Promise<MarketLinkPoll>{
  const row=exactPayload(payload,['cancel'])
  if(row.cancel!==undefined&&row.cancel!==true)throw invalidInput()
  // 显式取消：清掉设备码，之后网页上误点「允许」也不会被这台设备领取
  if(row.cancel){pending=null;return {status:'idle'}}
  if(!pending)return {status:'idle'}
  if(now()>=pending.expiresAt){pending=null;return {status:'expired'}}
  const current=pending
  const body=await call('POST','/v1/device/token',{body:{deviceCode:current.deviceCode}})
  const token=exact(body,['status','token'])&&body.status==='approved'&&typeof body.token==='string'&&TOKEN.test(body.token)?body.token:undefined
  // 等待期间已取消、断开或重新发起：这次轮询作废；若恰好领到令牌，尽力作废后丢弃，不落本机
  if(pending!==current){
   if(token){try{await call('POST','/v1/auth/logout',{token})}catch{}}
   return {status:'idle'}
  }
  if(exact(body,['status'])&&body.status==='pending')return {status:'pending'}
  if(exact(body,['status'])&&(body.status==='denied'||body.status==='expired')){pending=null;return {status:body.status}}
  if(!token)throw hostBad()
  pending=null
  // 令牌存不下去就尽力作废服务端刚建的会话，不留只能在账号页手工撤销的孤儿会话
  try{await vault(()=>options.store.write(token))}
  catch(error){try{await call('POST','/v1/auth/logout',{token})}catch{}throw error}
  const me=readMe(await call('GET','/v1/me',{token}))
  return {status:'linked',nickname:me.nickname,provider:me.provider}
 }
 async function unlink(){
  const value=await readToken()
  // 服务端作废失败也继续删除本机记录
  if(value){try{await call('POST','/v1/auth/logout',{token:value})}catch{}}
  await vault(()=>options.store.remove())
  pending=null
  return {linked:false as const}
 }
 async function list(payload:unknown){
  const row=exactPayload(payload,['entryId','cursor'])
  const id=entryOf(row.entryId)
  if(row.cursor!==undefined&&(typeof row.cursor!=='string'||!CURSOR.test(row.cursor)))throw invalidInput()
  return readMarketReviewPage(await call('GET',`/v1/entries/${id}/reviews`+(typeof row.cursor==='string'?'?cursor='+encodeURIComponent(row.cursor):'')))
 }
 async function mine(payload:unknown){
  const id=entryOf(exactPayload(payload,['entryId']).entryId)
  return {review:readMarketOwnReview(await call('GET',`/v1/entries/${id}/review`,{token:await token()}))}
 }
 async function publish(payload:unknown){
  const row=exactPayload(payload,['entryId','rating','body'])
  const id=entryOf(row.entryId),input=checkMarketReviewInput(Object.hasOwn(row,'body')?{rating:row.rating,body:row.body}:{rating:row.rating})
  const review=readMarketOwnReview(await call('PUT',`/v1/entries/${id}/review`,{token:await token(),body:input}))
  if(!review)throw hostBad()
  return {review}
 }
 async function remove(payload:unknown){
  const id=entryOf(exactPayload(payload,['entryId']).entryId)
  const body=await call('DELETE',`/v1/entries/${id}/review`,{token:await token()})
  if(!exact(body,['deleted'])||body.deleted!==true)throw hostBad()
  return {deleted:true as const}
 }

 return async(endpoint:string,payload:unknown):Promise<unknown>=>{
  if(!(marketReviewEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/invalid-input','未提供此市场评价接口。')
  switch(endpoint as MarketReviewEndpoint){
   case 'market-reviews/summary':exactPayload(payload,[]);return summary()
   case 'market-reviews/list':return list(payload)
   case 'market-reviews/account':exactPayload(payload,[]);return account()
   case 'market-reviews/link-start':exactPayload(payload,[]);return linkStart()
   case 'market-reviews/link-poll':return linkPoll(payload)
   case 'market-reviews/unlink':exactPayload(payload,[]);return unlink()
   case 'market-reviews/mine':return mine(payload)
   case 'market-reviews/publish':return publish(payload)
   case 'market-reviews/delete':return remove(payload)
  }
 }
}
