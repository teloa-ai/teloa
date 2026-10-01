/**
 * 受管 MCP 连接 OAuth 流程管理器（宿主侧）。
 *
 * 只调用 `@modelcontextprotocol/sdk` 的独立 OAuth 函数（discovery / DCR / PKCE 授权 / 换取 / 刷新），
 * 不实现 `OAuthClientProvider`、不走 SDK 的 `auth()` 编排；`codeVerifier` 只存 `pendingFlows` 一处。
 * 令牌与 client 信息写入 `ctx.credentials` 的 `teloa-managed-mcp/*` 记录的 `oauth_*` 槽，
 * 绝不出现在回包、日志或错误消息里。PKCE public client：任何路径都不读写客户端密钥。
 */
import {WorkError,isRecord,type MarketCatalogConnectorEntry} from '@teloa/contract'
import {discoverOAuthServerInfo,exchangeAuthorization,refreshAuthorization,registerClient,startAuthorization} from '@modelcontextprotocol/sdk/client/auth.js'
import type {AuthorizationServerMetadata,OAuthClientInformationMixed,OAuthClientMetadata,OAuthTokens} from '@modelcontextprotocol/sdk/shared/auth.js'
import type {FetchLike} from '@modelcontextprotocol/sdk/shared/transport.js'
import {InvalidClientError,InvalidGrantError,UnauthorizedClientError} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import {lookup as dnsLookup} from 'node:dns/promises'
import {randomBytes,timingSafeEqual} from 'node:crypto'
import {isIP} from 'node:net'
import {isCredentialStoreLocked} from './credentials/store-state.ts'
import type {McpSlotStore} from './managed-mcp-credentials.ts'

const invalid=(msg:string)=>new WorkError('teloa/invalid-input',msg)

/** 待处理授权流程有效期：10 分钟 */
export const pendingFlowTtlMs=10*60*1000
/** 令牌到期前多久开始刷新：5 分钟 */
export const refreshAheadMs=5*60*1000
/** SDK 发往授权服务器的请求（发现 / DCR / 换取 / 刷新）未带 signal 时的超时：15 秒 */
const defaultRequestTimeoutMs=15_000
/** AS 未给 expires_in 时按 3600 s */
const defaultExpiresInSeconds=3600

/** 固定脱敏文案：刷新失败（Rulings 7） */
export const oauthExpiredMessage='授权已过期或被吊销，请重新连接并完成 OAuth 授权。'
/** 固定脱敏文案：授权码换取令牌失败（计划附录） */
export const oauthExchangeFailedMessage='OAuth 凭据无效或授权码已过期，请重新连接并完成授权。'
/** 固定脱敏文案：用户在授权页拒绝或授权服务器回传错误（计划附录） */
export const oauthDeniedMessage='OAuth 授权被取消或拒绝，请重新连接并完成授权。'
/** 固定脱敏文案：发起授权时 SDK 与授权服务器交互失败（不透出 AS 的 error_description） */
const oauthServerUnavailableMessage='OAuth 授权服务器暂不可用或不兼容，暂不能发起授权。'
/** 服务器部署未配置公开回调（计划附录） */
const publicCallbackRequiredMessage='服务器部署需在配置文件中设置 oauth.publicCallbackUrl 才能使用 OAuth 授权。'

// ──────────── 凭据槽（任务 4 表） ────────────

const slotAccessToken='oauth_access_token'
const slotRefreshToken='oauth_refresh_token'
const slotTokenExpiry='oauth_token_expiry'
const slotClientInfo='oauth_client_info'
const slotAsMetadata='oauth_as_metadata'
const slotUserClientId='oauth_client_id'
/** 签发当前令牌时使用的 client_id：刷新与吊销只用它，不受之后用户 client_id 或 DCR 信息变化影响 */
const slotTokenClientId='oauth_token_client_id'
/** 宿主内部写入的槽；`oauth_client_id` 是用户填写的配置，不在清理范围 */
const hostWrittenSlots=[slotAccessToken,slotRefreshToken,slotTokenExpiry,slotTokenClientId,slotClientInfo,slotAsMetadata] as const

/** 持久化的 client 信息：只保留 client_id（public client，永不保存客户端密钥）与注册时的 redirect_uri */
type StoredClientInformation={client_id:string;redirect_uri:string}

export async function readClientInformation(slots:McpSlotStore,serverName:string):Promise<StoredClientInformation|undefined>{
 const raw=(await slots.read(serverName))[slotClientInfo]
 if(!raw)return undefined
 try{
  const parsed=JSON.parse(raw)
  if(isRecord(parsed)&&typeof parsed.client_id==='string'&&typeof parsed.redirect_uri==='string')return {client_id:parsed.client_id,redirect_uri:parsed.redirect_uri}
 }catch{}
 return undefined
}

export async function saveClientInformation(slots:McpSlotStore,serverName:string,info:StoredClientInformation):Promise<void>{
 await slots.patch(serverName,{[slotClientInfo]:JSON.stringify({client_id:info.client_id,redirect_uri:info.redirect_uri})})
}

export type StoredTokens={accessToken:string;refreshToken?:string;expiresAt:number}

export async function readTokens(store:McpSlotStore,serverName:string):Promise<StoredTokens|undefined>{
 const slots=await store.read(serverName)
 const accessToken=slots[slotAccessToken]
 const expiresAt=Date.parse(slots[slotTokenExpiry]??'')
 if(!accessToken||Number.isNaN(expiresAt))return undefined
 const refreshToken=slots[slotRefreshToken]
 return refreshToken?{accessToken,refreshToken,expiresAt}:{accessToken,expiresAt}
}

/** expires_at = now + expires_in*1000（无 expires_in 按 3600 s）；AS 未轮换 refresh_token 时保留旧值；clientId 为签发该令牌的 client */
export async function saveTokens(slots:McpSlotStore,serverName:string,tokens:OAuthTokens,clientId?:string,now:()=>number=Date.now):Promise<void>{
 const expiresAt=now()+(tokens.expires_in??defaultExpiresInSeconds)*1000
 const patch:Record<string,string|undefined>={[slotAccessToken]:tokens.access_token,[slotTokenExpiry]:new Date(expiresAt).toISOString()}
 if(tokens.refresh_token)patch[slotRefreshToken]=tokens.refresh_token
 if(clientId)patch[slotTokenClientId]=clientId
 await slots.patch(serverName,patch)
}

/** 只清令牌槽（access / refresh / expiry / 签发 client_id），保留 client 信息、AS 元数据与用户 client_id */
export async function clearTokens(slots:McpSlotStore,serverName:string):Promise<void>{
 await slots.patch(serverName,{[slotAccessToken]:undefined,[slotRefreshToken]:undefined,[slotTokenExpiry]:undefined,[slotTokenClientId]:undefined})
}

/** 断开或删除连接时清除宿主写入的全部 oauth_* 槽；记录不存在时静默 */
export async function clearOAuthCredentials(store:McpSlotStore,serverName:string):Promise<void>{
 const slots=await store.read(serverName)
 if(!hostWrittenSlots.some(key=>key in slots))return
 await store.patch(serverName,Object.fromEntries(hostWrittenSlots.map(key=>[key,undefined])))
}

async function readAsMetadata(slots:McpSlotStore,serverName:string):Promise<AuthorizationServerMetadata|undefined>{
 const raw=(await slots.read(serverName))[slotAsMetadata]
 if(!raw)return undefined
 try{const parsed=JSON.parse(raw);return isRecord(parsed)?parsed as AuthorizationServerMetadata:undefined}catch{return undefined}
}

// ──────────── 回调地址与 client 元数据 ────────────

type WebServerLike={host:string;port:number}

/**
 * 本地部署：`http://127.0.0.1:<port>/oauth/callback`（RFC 8252 loopback）。
 * 配置了 publicCallbackUrl（必须 https、无用户信息）时改用该值；
 * 宿主监听非 127.0.0.1 又无公开回调时拒绝发起 OAuth（安全审查点「回调只监听本机」）。
 */
export function redirectUrl(ctx:{webServer:WebServerLike},publicCallbackUrl?:string):string{
 if(publicCallbackUrl){
  let url:URL
  try{url=new URL(publicCallbackUrl)}catch{throw invalid('oauth.publicCallbackUrl 不是合法 URL。')}
  if(url.protocol!=='https:'||url.username||url.password||publicCallbackUrl.includes('#'))throw invalid('oauth.publicCallbackUrl 必须是不含用户信息与 fragment 的 https 地址。')
  return url.toString()
 }
 if(ctx.webServer.host!=='127.0.0.1')throw invalid(publicCallbackRequiredMessage)
 return `http://127.0.0.1:${ctx.webServer.port}/oauth/callback`
}

export function clientMetadata(redirectUrl:string):OAuthClientMetadata{
 return {client_name:'Teloa',redirect_uris:[redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'}
}

/** 128 bit cryptographic 随机 state */
export function newState():string{return randomBytes(16).toString('hex')}

// ──────────── SSRF 防护 ────────────

const privateHostPat=/^(localhost|.*\.(localhost|local|internal|localdomain))$/i

/** URL 主机名去掉 IPv6 方括号与 FQDN 尾点（`localhost.` 与 `localhost` 同指本机） */
function bareHost(url:URL):string{return url.hostname.replace(/^\[|\]$/g,'').replace(/\.+$/,'')}

function isPrivateIpv4(ip:string):boolean{
 const parts=ip.split('.').map(Number)
 const [a,b]=parts as [number,number,number,number]
 return a===0||a===10||a===127||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&b===168)||(a===100&&b>=64&&b<=127)||(a===198&&(b===18||b===19))||a>=224
}

/** 展开为 8 个 16 位分组；末尾点分 IPv4 折成两组。输入须已通过 isIP()===6 */
function ipv6Groups(ip:string):number[]{
 let text=ip.toLowerCase()
 const dotted=/(\d+\.\d+\.\d+\.\d+)$/.exec(text)
 if(dotted){
  const [a,b,c,d]=dotted[1]!.split('.').map(Number) as [number,number,number,number]
  text=`${text.slice(0,dotted.index)}${((a<<8)|b).toString(16)}:${((c<<8)|d).toString(16)}`
 }
 const [head,tail]=text.split('::') as [string,string|undefined]
 const parse=(part:string)=>part?part.split(':').map(g=>parseInt(g,16)):[]
 const left=parse(head),right=tail===undefined?[]:parse(tail)
 return [...left,...Array<number>(8-left.length-right.length).fill(0),...right]
}

function isPrivateIpv6(ip:string):boolean{
 const [g0,g1,g2,g3,g4,g5,g6,g7]=ipv6Groups(ip) as [number,number,number,number,number,number,number,number]
 // ::/96（含 ::、::1、IPv4 兼容 ::a.b.c.d）与 ::ffff:0:0/96（IPv4 映射）按内嵌 IPv4 判定
 if(g0===0&&g1===0&&g2===0&&g3===0&&g4===0&&(g5===0||g5===0xffff))return isPrivateIpv4(`${g6>>8}.${g6&255}.${g7>>8}.${g7&255}`)
 // 64:ff9b::/96 NAT64：可经网关转到任意 IPv4（含内网），整段拒绝
 if(g0===0x64&&g1===0xff9b&&g2===0&&g3===0&&g4===0&&g5===0)return true
 // 2002::/16 6to4 与 2001::/32 Teredo：隧道可转到任意 IPv4（含内网），整段拒绝
 if(g0===0x2002||(g0===0x2001&&g1===0))return true
 // fc00::/7 唯一本地、fe80::/10 链路本地、ff00::/8 组播
 return (g0&0xfe00)===0xfc00||(g0&0xffc0)===0xfe80||(g0&0xff00)===0xff00
}

function isPrivateAddress(ip:string):boolean{
 const kind=isIP(ip)
 return kind===4?isPrivateIpv4(ip):kind===6?isPrivateIpv6(ip):true
}

function isLoopbackUrl(value:string|URL):boolean{
 try{
  const host=bareHost(new URL(value))
  return host==='localhost'||host==='::1'||(isIP(host)===4&&host.startsWith('127.'))
 }catch{return false}
}

function originOf(value:string|URL):string|undefined{
 try{return new URL(value).origin}catch{return undefined}
}

/** RFC 8414 §3.3 比较用：去掉 fragment 与路径尾斜杠（URL 解析已规范化大小写与默认端口） */
function normalizedIssuer(value:string):string|undefined{
 try{const url=new URL(value);return url.origin+url.pathname.replace(/\/+$/,'')+url.search}catch{return undefined}
}

/** 授权服务器/资源服务器地址必须是公网 https 且不含用户信息：拦截 http、环回、内网、链路本地、localhost 等目标。 */
export function assertPublicHttpsUrl(value:string|URL,label:string):URL{
 let url:URL
 try{url=value instanceof URL?value:new URL(value)}catch{throw invalid(`${label}不是合法 URL。`)}
 if(url.protocol!=='https:')throw invalid(`${label}必须使用 https。`)
 if(url.username||url.password)throw invalid(`${label}不得包含用户信息。`)
 const host=bareHost(url)
 if(isIP(host)!==0?isPrivateAddress(host):privateHostPat.test(host))throw invalid(`${label}不允许指向本机或内网地址。`)
 return url
}

// ──────────── 流程管理器 ────────────

/** 发起授权阶段：宿主自身的 WorkError 原样抛出；SDK / 网络原生错误统一为固定文案，不透出 AS 的 error_description */
async function sdkCall<T>(pending:Promise<T>):Promise<T>{
 try{return await pending}
 catch(error){
  if(error instanceof WorkError)throw error
  throw new WorkError('teloa/dependency-unavailable',oauthServerUnavailableMessage)
 }
}

export type PendingFlow={
 connectionId:string
 serverName:string
 serverUrl:string
 redirectUri:string
 codeVerifier:string
 /** 发起时确定的 client_id 与 AS 元数据：回调直接使用，不回读凭据槽 */
 clientId:string
 metadata:AuthorizationServerMetadata
 /** 授权服务器的授权链接：经宿主 /oauth/start 跳转打开，不直接交给客户端 */
 authorizationUrl:string
 /** 浏览器绑定：首次打开 /oauth/start 时生成并下发为 cookie，回调必须带回同值 */
 browserNonce?:string
 expiresAt:number
}

export type CallbackResult=
 |{kind:'authorized';connectionId:string;serverName:string}
 |{kind:'invalid-state'}
 |{kind:'exchange-failed';connectionId:string;serverName:string;errorMessage:string}
 |{kind:'denied';connectionId:string;serverName:string;errorMessage:string}
 /** 凭据存储锁定或不可写：不换取（或已吊销刚换得的令牌），调用方不改连接状态 */
 |{kind:'storage-locked';connectionId:string;serverName:string}

export type RefreshCandidate={id:string;serverName:string;status:string;entry:MarketCatalogConnectorEntry}
export type RefreshOutcome={connectionId:string;serverName:string;result:'refreshed'|'skipped'|'failed';errorMessage?:string}

export type OAuthFlowManagerOptions={
 runtimeRoot:string
 /** 凭据槽：ctx.credentials 的 teloa-managed-mcp/* 记录 */
 slots:McpSlotStore
 /** 服务器部署的公开 https 回调地址：配置文件 oauth.publicCallbackUrl，缺省时由调用方以启动快照里的 TELOA_OAUTH_PUBLIC_CALLBACK_URL 兜底；管理器自己不读 process.env */
 publicCallbackUrl?:string
 fetchFn?:FetchLike
 now?:()=>number
 /** 仅测试用：允许 http 与环回地址的授权服务器（默认严格执行 assertPublicHttpsUrl） */
 insecureAllowLoopbackServers?:boolean
 /** 仅验收夹具用：只放行这一个环回 origin（如 http://127.0.0.1:43123），其余目标（含 localhost、其他端口）仍严格校验 */
 allowedLoopbackOrigin?:string
 /** 仅测试用：SDK 请求未带 signal 时的超时毫秒数（默认 15 秒） */
 requestTimeoutMs?:number
 /** 仅测试用：替换 DNS 解析（默认 node:dns lookup all:true） */
 lookup?:(hostname:string)=>Promise<readonly {address:string}[]>
}

/** 一个实例服务所有 OAuth 连接；state → 待处理流程 */
export class OAuthFlowManager{
 readonly pendingFlows=new Map<string,PendingFlow>()
 private readonly slots:McpSlotStore
 private readonly publicCallbackUrl:string|undefined
 private readonly now:()=>number
 private readonly fetchFn:FetchLike
 private readonly assertUrl:(value:string|URL,label:string)=>void
 /** serverName → 令牌读写链尾；同一连接的回调写令牌、刷新与调用方的吊销删除串行执行 */
 private readonly refreshLocks=new Map<string,Promise<void>>()

 constructor(options:OAuthFlowManagerOptions){
  this.slots=options.slots
  this.publicCallbackUrl=options.publicCallbackUrl
  this.now=options.now??Date.now
  const baseFetch:FetchLike=options.fetchFn??((url,init)=>fetch(url,init))
  // 测试放行只限环回地址、验收放行只限给定的一个 origin：其余目标（含内网）仍走严格校验
  const allowedOrigin=options.allowedLoopbackOrigin!==undefined?new URL(options.allowedLoopbackOrigin).origin:undefined
  if(allowedOrigin!==undefined&&!isLoopbackUrl(allowedOrigin))throw invalid('allowedLoopbackOrigin 必须是环回地址。')
  const allowed=(value:string|URL)=>options.insecureAllowLoopbackServers?isLoopbackUrl(value):allowedOrigin!==undefined&&originOf(value)===allowedOrigin
  this.assertUrl=(value,label)=>{if(!allowed(value))assertPublicHttpsUrl(value,label)}
  const lookup=options.lookup??(hostname=>dnsLookup(hostname,{all:true}))
  const requestTimeoutMs=options.requestTimeoutMs??defaultRequestTimeoutMs
  // SDK 的每一次 HTTP 调用（discovery / DCR / token）都经此校验目标地址与其 DNS 全部解析结果，且不跟随重定向，避免元数据把宿主引向内网。
  // 残余风险：校验与 fetch 实际建连各自解析 DNS，恶意权威 DNS 仍可在两次解析之间换址（DNS rebinding）；
  // 彻底消除需把 undici Agent 的 connect.lookup 接入 fetch dispatcher（本包已依赖 undici，见 public-address.ts）；「OAuth 端点地址钉住」列为后续项，尚未实现。
  this.fetchFn=async(url,init)=>{
   this.assertUrl(url,'OAuth 授权服务器地址')
   const target=new URL(url)
   const host=bareHost(target)
   if(isIP(host)===0&&!allowed(target)){
    const addresses=await lookup(host)
    if(addresses.length===0||addresses.some(({address})=>isPrivateAddress(address)))throw invalid('OAuth 授权服务器地址不允许解析到本机或内网地址。')
   }
   // SDK 的独立 OAuth 函数不带 signal：补超时，挂起的授权服务器不会永久占住令牌锁
   return baseFetch(url,{...init,redirect:'error',signal:init?.signal??AbortSignal.timeout(requestTimeoutMs)})
  }
 }

 private prunePendingFlows():void{
  const now=this.now()
  for(const [state,flow] of this.pendingFlows){if(flow.expiresAt<=now)this.pendingFlows.delete(state)}
 }

 /** 在该连接的令牌锁内执行（与回调写令牌、刷新共用）；调用方用于吊销并删除凭据，避免与进行中的刷新交错写回 */
 exclusive<T>(serverName:string,task:()=>Promise<T>):Promise<T>{return this.serialize(serverName,task)}

 private serialize<T>(key:string,task:()=>Promise<T>):Promise<T>{
  const run=(this.refreshLocks.get(key)??Promise.resolve()).then(task)
  const tail=run.then(()=>{},()=>{})
  this.refreshLocks.set(key,tail)
  void tail.then(()=>{if(this.refreshLocks.get(key)===tail)this.refreshLocks.delete(key)})
  return run
 }

 private async discover(serverUrl:string):Promise<{authorizationServerUrl:string;metadata:AuthorizationServerMetadata}>{
  const info=await discoverOAuthServerInfo(serverUrl,{fetchFn:this.fetchFn})
  this.assertUrl(info.authorizationServerUrl,'OAuth 授权服务器地址')
  const metadata=info.authorizationServerMetadata
  if(!metadata)throw new WorkError('teloa/dependency-unavailable','无法获取 OAuth 授权服务器元数据，暂不能发起授权。')
  // RFC 8414 §3.3：元数据的 issuer 必须与所请求的授权服务器标识一致，否则可能是被冒充的元数据
  const issuer=normalizedIssuer(metadata.issuer)
  if(issuer===undefined||issuer!==normalizedIssuer(info.authorizationServerUrl))throw new WorkError('teloa/dependency-unavailable','OAuth 授权服务器元数据的 issuer 与授权服务器地址不一致，暂不能发起授权。')
  // SDK 在元数据缺省该字段时不校验 PKCE 支持；此处强制要求显式声明 S256
  if(!metadata.code_challenge_methods_supported?.includes('S256'))throw new WorkError('teloa/dependency-unavailable','OAuth 授权服务器未声明支持 PKCE S256，暂不能发起授权。')
  // 浏览器要打开的授权端点不经 fetchFn，需单独校验
  this.assertUrl(metadata.authorization_endpoint,'OAuth 授权端点')
  return {authorizationServerUrl:info.authorizationServerUrl,metadata}
 }

 private async resolveClientInformation(
  entry:MarketCatalogConnectorEntry,authorizationServerUrl:string,metadata:AuthorizationServerMetadata,redirectUri:string,
 ):Promise<OAuthClientInformationMixed>{
  const {serverName,auth}=entry.connector
  if(auth.kind==='oauth'&&auth.supported&&auth.requiresUserClientId){
   const clientId=(await this.slots.read(serverName))[slotUserClientId]
   if(!clientId)throw invalid('该连接需要先填写 OAuth client_id 凭据才能发起授权。')
   return {client_id:clientId}
  }
  const stored=await readClientInformation(this.slots,serverName)
  if(stored&&stored.redirect_uri===redirectUri)return {client_id:stored.client_id}
  if(!metadata.registration_endpoint)throw new WorkError('teloa/dependency-unavailable','授权服务器不支持动态客户端注册，且连接未要求用户提供 client_id，无法完成 OAuth。')
  const registered=await registerClient(authorizationServerUrl,{metadata,clientMetadata:clientMetadata(redirectUri),fetchFn:this.fetchFn})
  await this.serialize(serverName,()=>saveClientInformation(this.slots,serverName,{client_id:registered.client_id,redirect_uri:redirectUri}))
  return {client_id:registered.client_id}
 }

 /**
  * 发起授权：返回授权服务器链接、state 与宿主授权入口 startUrl（与回调同目录的 start?state=…，不含任何凭据）；
  * 同一连接重复发起时作废旧 state
  */
 async startFlow(ctx:{webServer:WebServerLike},connectionId:string,entry:MarketCatalogConnectorEntry):Promise<{authorizationUrl:string;state:string;startUrl:string}>{
  const {serverName,auth,recipe}=entry.connector
  if(auth.kind!=='oauth'||!auth.supported)throw invalid('该连接不支持 OAuth 授权。')
  if(recipe.transport!=='streamable-http')throw invalid('OAuth 授权仅支持远端 streamable-http 连接。')
  const serverUrl=recipe.url
  this.assertUrl(serverUrl,'MCP 服务器地址')
  const redirectUri=redirectUrl(ctx,this.publicCallbackUrl)

  const {authorizationServerUrl,metadata}=await sdkCall(this.discover(serverUrl))
  // 凭据文件读-改-写与回调写令牌、刷新同锁，避免互相覆盖
  await this.serialize(serverName,()=>this.slots.patch(serverName,{[slotAsMetadata]:JSON.stringify(metadata)}))
  const clientInformation=await sdkCall(this.resolveClientInformation(entry,authorizationServerUrl,metadata,redirectUri))

  this.prunePendingFlows()
  for(const [state,flow] of this.pendingFlows){if(flow.connectionId===connectionId)this.pendingFlows.delete(state)}
  const state=newState()
  const scope=auth.scopes.length>0?auth.scopes.join(' '):undefined
  const {authorizationUrl,codeVerifier}=await sdkCall(startAuthorization(authorizationServerUrl,{
   metadata,clientInformation,redirectUrl:redirectUri,state,resource:new URL(serverUrl),...(scope?{scope}:{}),
  }))
  this.pendingFlows.set(state,{connectionId,serverName,serverUrl,redirectUri,codeVerifier,clientId:clientInformation.client_id,metadata,authorizationUrl:authorizationUrl.toString(),expiresAt:this.now()+pendingFlowTtlMs})
  return {authorizationUrl:authorizationUrl.toString(),state,startUrl:new URL(`start?state=${state}`,redirectUri).toString()}
 }

 /**
  * 浏览器打开 /oauth/start：返回要跳转的授权链接；只有第一次打开时生成浏览器绑定 nonce（由调用方下发为 cookie），
  * 之后再打开只跳转不再下发，拿到链接的其他浏览器无法完成回调。state 不存在或已过期返回 undefined。
  */
 bindBrowser(state:string):{authorizationUrl:string;redirectUri:string;nonce?:string}|undefined{
  this.prunePendingFlows()
  const flow=this.pendingFlows.get(state)
  if(!flow)return undefined
  if(flow.browserNonce!==undefined)return {authorizationUrl:flow.authorizationUrl,redirectUri:flow.redirectUri}
  flow.browserNonce=randomBytes(16).toString('hex')
  return {authorizationUrl:flow.authorizationUrl,redirectUri:flow.redirectUri,nonce:flow.browserNonce}
 }

 /** 回调携带的浏览器绑定是否与该 state 的 nonce 一致（不消耗 state） */
 browserBound(state:string,nonce:string|undefined):boolean{
  const expected=this.pendingFlows.get(state)?.browserNonce
  if(expected===undefined||nonce===undefined||!/^[0-9a-f]{32}$/.test(nonce))return false
  return timingSafeEqual(Buffer.from(nonce),Buffer.from(expected))
 }

 /**
  * 浏览器回调：state 必须存在且未过期，取出后立即删除（一次性）；随后用 codeVerifier 换取令牌并写 0600 文件。
  * 返回值不含 code / 令牌 / AS 原始报错；调用方据此更新连接状态并重连 DSH。
  * `iss`：RFC 9207——AS 元数据声明支持或回调带了 iss 时，必须与 issuer 一致，否则按无效 state 处理且不换取。
  * `isCurrent`：在令牌锁内、写入前确认连接仍是发起授权的那条；否则吊销刚换得的令牌、不写入，按无效 state 处理。
  */
 async handleCallback(state:string,code:string|undefined,error?:string,options:{iss?:string;isCurrent?:(connectionId:string)=>Promise<boolean>}={}):Promise<CallbackResult>{
  this.prunePendingFlows()
  const flow=this.pendingFlows.get(state)
  if(!flow)return {kind:'invalid-state'}
  this.pendingFlows.delete(state)
  const {connectionId,serverName,serverUrl,redirectUri,codeVerifier,clientId,metadata}=flow
  const issRequired=(metadata as {authorization_response_iss_parameter_supported?:unknown}).authorization_response_iss_parameter_supported===true
  if((issRequired||options.iss!==undefined)&&options.iss!==metadata.issuer)return {kind:'invalid-state'}
  if(error||!code)return {kind:'denied',connectionId,serverName,errorMessage:oauthDeniedMessage}
  // 与同一 serverName 的刷新共用令牌锁：进行中的刷新写完后再换取并写入，避免旧刷新结果覆盖新授权
  return this.serialize(serverName,async():Promise<CallbackResult>=>{
   // 存储不可写就不换取：否则换得的令牌无处保存
   try{await this.slots.assertWritable(serverName)}catch(error){if(isCredentialStoreLocked(error))return {kind:'storage-locked',connectionId,serverName};throw error}
   let tokens:OAuthTokens
   try{
    tokens=await exchangeAuthorization(metadata.issuer,{
     metadata,clientInformation:{client_id:clientId},authorizationCode:code,codeVerifier,redirectUri,resource:new URL(serverUrl),fetchFn:this.fetchFn,
    })
   }catch{
    return {kind:'exchange-failed',connectionId,serverName,errorMessage:oauthExchangeFailedMessage}
   }
   const issued={accessToken:tokens.access_token,...(tokens.refresh_token?{refreshToken:tokens.refresh_token}:{})}
   try{
    if(options.isCurrent&&!await options.isCurrent(connectionId)){
     await this.revoke(metadata,clientId,issued)
     return {kind:'invalid-state'}
    }
    await saveTokens(this.slots,serverName,tokens,clientId,this.now)
    return {kind:'authorized',connectionId,serverName}
   }catch(error){
    // 预检之后存储才锁定：吊销刚换得、却没能保存的令牌
    if(isCredentialStoreLocked(error)){await this.revoke(metadata,clientId,issued);return {kind:'storage-locked',connectionId,serverName}}
    return {kind:'exchange-failed',connectionId,serverName,errorMessage:oauthExchangeFailedMessage}
   }
  })
 }

 /**
  * 定时刷新（调用方每分钟一次）：只处理 status=connected 且 expires_at - now < 5 分钟的连接。
  * 同一 serverName 的读-改-写串行执行（并发调用只会发出一次 refresh 请求）。
  * 刷新成功原子写入新令牌（AS 轮换 refresh_token 时替换旧值），调用方负责以新 Bearer 头重连 DSH；
  * AS 明确判定 refresh_token / client 失效（invalid_grant / unauthorized_client / invalid_client）或本地缺少刷新所需信息时
  * 清除令牌槽并返回 failed + 固定脱敏文案；网络错误、5xx 等暂时性失败返回 skipped，令牌保留待下轮重试。
  */
 async refreshIfNeeded(connections:readonly RefreshCandidate[]):Promise<RefreshOutcome[]>{
  const outcomes:RefreshOutcome[]=[]
  for(const conn of connections){
   const base={connectionId:conn.id,serverName:conn.serverName}
   const {auth,recipe}=conn.entry.connector
   if(conn.status!=='connected'||auth.kind!=='oauth'||!auth.supported||recipe.transport!=='streamable-http'){outcomes.push({...base,result:'skipped'});continue}
   const requiresUserClientId=auth.requiresUserClientId===true
   outcomes.push({...base,...await this.serialize(conn.serverName,()=>this.refreshOne(conn.serverName,recipe.url,requiresUserClientId))})
  }
  return outcomes
 }

 private async refreshOne(serverName:string,resourceUrl:string,requiresUserClientId:boolean):Promise<Pick<RefreshOutcome,'result'|'errorMessage'>>{
  // 存储锁定时不清令牌、不判失败：只跳过，连接状态留待存储恢复后再处理
  const expire=async():Promise<Pick<RefreshOutcome,'result'|'errorMessage'>>=>{
   try{await clearTokens(this.slots,serverName)}catch(error){if(isCredentialStoreLocked(error))return {result:'skipped'}}
   return {result:'failed',errorMessage:oauthExpiredMessage}
  }
  try{
   const tokens=await readTokens(this.slots,serverName)
   if(!tokens||tokens.expiresAt-this.now()>=refreshAheadMs)return {result:'skipped'}
   if(!tokens.refreshToken)return await expire()
   const metadata=await readAsMetadata(this.slots,serverName)
   // 用签发该令牌的 client_id；缺该槽的旧令牌与发起时同序：要求用户 client_id 的连接器只用用户填写值，否则用 DCR 注册结果
   const slots=await this.slots.read(serverName)
   const clientId=slots[slotTokenClientId]??(requiresUserClientId
    ?slots[slotUserClientId]
    :(await readClientInformation(this.slots,serverName))?.client_id)
   if(!metadata||!clientId)return await expire()
   // 可读不可写时不发刷新：AS 可能轮换 refresh_token，新令牌存不下就会丢掉仍有效的旧令牌
   await this.slots.assertWritable(serverName)
   const refreshed=await refreshAuthorization(metadata.issuer,{
    metadata,clientInformation:{client_id:clientId},refreshToken:tokens.refreshToken,resource:new URL(resourceUrl),fetchFn:this.fetchFn,
   })
   await saveTokens(this.slots,serverName,refreshed,clientId,this.now)
   return {result:'refreshed'}
  }catch(error){
   if(isCredentialStoreLocked(error))return {result:'skipped'}
   if(error instanceof InvalidGrantError||error instanceof UnauthorizedClientError||error instanceof InvalidClientError)return await expire()
   return {result:'skipped'}
  }
 }

 /**
  * RFC 7009 best-effort 吊销当前保存的 refresh_token 与 access_token；任何失败静默。
  * client_id 与刷新同序：签发令牌时的 client_id；缺该槽的旧令牌用户 client_id 优先（该槽只可能出现在要求用户 client_id 的连接器上），其次 DCR 注册结果。
  */
 async revokeTokens(serverName:string):Promise<void>{
  try{await (await this.prepareRevoke(serverName))()}catch{}
 }

 /**
  * 吊销分两段：先只读取令牌、元数据与 client_id（存储锁定在这里抛出，尚无副作用），返回的闭包再做远端吊销（失败静默）。
  * 调用方据此先写存储、最后做不可逆的远端动作。
  */
 async prepareRevoke(serverName:string):Promise<()=>Promise<void>>{
  const tokens=await readTokens(this.slots,serverName)
  const metadata=await readAsMetadata(this.slots,serverName)
  if(!tokens||!metadata)return async()=>{}
  const slots=await this.slots.read(serverName)
  const clientId=slots[slotTokenClientId]??slots[slotUserClientId]??(await readClientInformation(this.slots,serverName))?.client_id
  return async()=>{await this.revoke(metadata,clientId,tokens).catch(()=>{})}
 }

 private async revoke(metadata:AuthorizationServerMetadata,clientId:string|undefined,tokens:{accessToken:string;refreshToken?:string}):Promise<void>{
  const endpoint=(metadata as {revocation_endpoint?:unknown}).revocation_endpoint
  if(typeof endpoint!=='string')return
  const hints:[string,string][]=tokens.refreshToken?[[tokens.refreshToken,'refresh_token'],[tokens.accessToken,'access_token']]:[[tokens.accessToken,'access_token']]
  // 两个请求并发，各限时 10 秒：删除 / 断开等待吊销结果，超时按失败静默处理
  await Promise.allSettled(hints.map(([token,hint])=>{
   const body=new URLSearchParams({token,token_type_hint:hint})
   if(clientId)body.set('client_id',clientId)
   return this.fetchFn(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:body.toString(),signal:AbortSignal.timeout(10_000)})
  }))
 }
}
