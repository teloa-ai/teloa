import {WorkError,isRecord,taskInput,mcpToolFullName,connectorHeaderName,connectorHeaderScheme,isForbiddenConnectorHeader,stdioArgEnvRefs,type MarketCatalogConnectorEntry,type MarketCatalogConnectorRecipe,type ConnectorAuth,type TaskToolArgumentRule} from '@teloa/contract'
import type {Context} from '@deepseek-ai/cordis'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import type {Fiber} from '@deepseek-ai/cordis'
import type {PreToolDecision} from '@deepseek-ai/dsh-tools'
import {chmod,mkdir,readFile,rename,unlink,writeFile} from 'node:fs/promises'
import {closeSync,existsSync,fstatSync,openSync,readFileSync} from 'node:fs'
import type {IncomingMessage,ServerResponse} from 'node:http'
import {resolve} from 'node:path'
import {randomUUID} from 'node:crypto'
import {installLockedPackage,managedInstallErrorCode,managedInstallTimeoutMs,serialInstall,type ManagedInstallErrorCode} from './managed-package-install.ts'
import {OAuthFlowManager,clearTokens,oauthExpiredMessage,pendingFlowTtlMs,readTokens,type CallbackResult,type OAuthFlowManagerOptions} from './managed-mcp-oauth.ts'
import {securityEnv} from './launch-env.ts'
import {credentialSlotStore,migrateLegacyMcpCredentials,type McpCredentialPort,type McpSlotStore} from './managed-mcp-credentials.ts'
import {isCredentialStoreLocked} from './credentials/store-state.ts'
import {getToolResourceProvenance,type ToolResourceProvenance,type ToolResourceSource} from './tool-resource-provenance.ts'

export const managedMcpConnectionEndpoints=['mcp-connections/add','mcp-connections/connect','mcp-connections/disconnect','mcp-connections/delete','mcp-connections/list','mcp-connections/get','mcp-connections/oauth-start','mcp-connections/oauth-status'] as const

const uuidPat=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const uuid=(v:unknown):v is string=>typeof v==='string'&&uuidPat.test(v)
const catalogIdPat=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
// 与契约 envVarName 文法一致（允许大小写混用）
const envVarPat=/^[A-Za-z][A-Za-z0-9_]{0,127}$/
const invalid=(msg:string)=>new WorkError('teloa/invalid-input',msg)
const conflict=(msg:string)=>new WorkError('teloa/conflict',msg)
const credentialStoreLockedMessage='密钥存储已锁定，请到设置页处理后重试'

/** RPC 回包类型：不含凭据字段；凭据只存 ctx.credentials 加密存储，不进任何回包/日志/会话 */
export type ManagedMcpConnectionRecord={
 id:string
 catalogId:string
 serverName:string
 /** saved=已保存凭据但未连接；installing=首次安装依赖中（界面显示正在安装）；connected=已连接；error=上次连接失败；pending-oauth=连接已添加，OAuth 授权尚未完成 */
 status:'saved'|'installing'|'connected'|'error'|'pending-oauth'
 errorMessage?:string
 /** 安装失败的明确错误码（可重试）；建连失败等其他错误不带 */
 errorCode?:ManagedInstallErrorCode
 /** 已连接时才有工具列表 */
 tools?:{name:string;fullName:string;readOnly:boolean}[]
 createdAt:string
 updatedAt:string
}

/** 持久化存储条目（内部，不外露） */
type PersistedConnection=ManagedMcpConnectionRecord&{_credentialsStored:boolean}
type StateFile={connections:PersistedConnection[]}

// ──────────── 路径 ────────────

function statePath(root:string){return resolve(root,'mcp','connections.json')}
function pkgDir(root:string,pkg:string,version:string){return resolve(root,'mcp','packages',`${pkg.replace(/\//g,'__')}@${version}`)}

// ──────────── 状态持久化 ────────────

async function loadState(root:string):Promise<StateFile>{
 try{
  const raw=await readFile(statePath(root),'utf8')
  const parsed=JSON.parse(raw)
  if(!isRecord(parsed)||!Array.isArray(parsed.connections))return {connections:[]}
  return {connections:parsed.connections as PersistedConnection[]}
 }catch{return {connections:[]}}
}

/**
 * 严格读取已登记的 serverName，供旧凭据迁移判孤儿：文件缺失、读不到、坏 JSON 或结构不对一律返回 undefined（不判孤儿）。
 * 缺失也按「未知」：一期 add 先写凭据后写状态，缺状态文件时擦除会不可逆地丢掉凭据，多导入一条孤儿记录代价更小。
 */
async function knownServerNames(root:string):Promise<Set<string>|undefined>{
 try{
  const parsed:unknown=JSON.parse(await readFile(statePath(root),'utf8'))
  if(!isRecord(parsed)||!Array.isArray(parsed.connections))return undefined
  const names=new Set<string>()
  for(const item of parsed.connections){if(!isRecord(item)||typeof item.serverName!=='string')return undefined;names.add(item.serverName)}
  return names
 }catch{return undefined}
}

/** 先写同目录临时文件再重命名覆盖：中途失败不会留下半截文件，且新文件从一开始就是 0600。 */
async function writeAtomic(path:string,text:string):Promise<void>{
 const temp=`${path}.${process.pid}.${randomUUID()}.tmp`
 try{await writeFile(temp,text,{encoding:'utf8',mode:0o600});await chmod(temp,0o600);await rename(temp,path)}
 catch(error){await unlink(temp).catch(()=>{});throw error}
}

async function saveState(root:string,state:StateFile):Promise<void>{
 await mkdir(resolve(root,'mcp'),{recursive:true,mode:0o700})
 await writeAtomic(statePath(root),JSON.stringify(state,null,2))
}

/** 状态文件路径 → 写入链尾（进程内）；不同 serverName 的写入也在此串行 */
const stateLocks=new Map<string,Promise<void>>()

/**
 * 状态文件唯一写入口：状态锁内读最新状态、交给 mutator 只改目标记录、原子写回，不会用旧快照覆盖其他连接的变更。
 * mutator 必须同步且不联网；加锁顺序固定为「先 serverName 锁、后状态锁」，状态锁内不取其他锁。
 */
async function updateState<T>(root:string,mutator:(state:StateFile)=>T):Promise<T>{
 const key=statePath(root)
 const run=(stateLocks.get(key)??Promise.resolve()).then(async()=>{
  const state=await loadState(root)
  const result=mutator(state)
  await saveState(root,state)
  return result
 })
 const tail=run.then(()=>{},()=>{})
 stateLocks.set(key,tail)
 void tail.then(()=>{if(stateLocks.get(key)===tail)stateLocks.delete(key)})
 return run
}

/** 建连（等待 MCP 客户端启动）上限：超时释放实例并置 error，不永久占住连接锁。首次安装另计（managedMcpInstallTimeoutMs）。 */
export const managedMcpConnectTimeoutMs=30_000
const connectTimeoutMs=managedMcpConnectTimeoutMs
/** 首次安装（npm ci + 逐条核对）上限，与建连分开；取值依据见 managed-package-install.ts managedInstallTimeoutMs。 */
export const managedMcpInstallTimeoutMs=managedInstallTimeoutMs

/** 安装失败写进连接记录的固定文案（不含 npm 原始输出），均提示可重试。 */
const installFailureMessages:Record<ManagedInstallErrorCode,string>={
 'install-timeout':`安装超时（超过 ${managedInstallTimeoutMs/1000} 秒），已清理未装完的文件；请检查网络后重试连接。`,
 'install-failed':'安装未完成，已清理未装完的文件；请重试连接。',
}

/**
 * 连接失败只给固定分类说明：第三方 MCP 客户端的原始报错可能带有令牌、请求头或环境变量值，
 * 不能进入状态文件、回包或日志。
 */
export function connectFailureReason(error:unknown):string{
 const text=error instanceof Error?`${error.name} ${(error as {code?:unknown}).code??''} ${error.message}`:String(error)
 if(/\b(401|403)\b|unauthori[sz]ed|forbidden|invalid[_ ]?(token|key|credential)/i.test(text))return '密钥或授权被拒绝：请检查密钥是否正确、授权是否已过期或权限不足。'
 if(/ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|timed? ?out|network|fetch failed/i.test(text))return '无法连接到服务：请检查网络或服务是否可用。'
 return '服务返回错误，连接未建立；请稍后重试。'
}

// ──────────── 凭据管理（ctx.credentials 的 teloa-managed-mcp/* 记录，从不出现在回包/日志） ────────────
//  凭据以「密钥材料槽」存储：{[slotKey]: string}；远程连接在每次重连时重新读取，而不是连接创建时固定。
//  删除连接时删除记录；密钥轮换只需重写槽，下次重连自动生效。存储锁定时读写抛 CredentialStoreLocked，不当作“没有凭据”。

// ──────────── npm 受管安装 ────────────
//  随附 lock 核对、npm ci 与逐条 integrity 核对见 managed-package-install.ts；此处只补 bin 路径核对。

type StdioRecipe=Extract<MarketCatalogConnectorRecipe,{transport:'stdio'}>

/** 目录连接器条目，附带工件里随附的 package-lock.json（官方快照已逐字节核对）；stdio 配方据此安装。 */
export type ManagedConnectorEntry=MarketCatalogConnectorEntry&{packageLock?:unknown}

/** 以条目随附的完整 lock `npm ci --ignore-scripts` 安装并逐条核对；lock 缺失或与配方不一致抛 teloa/forbidden。调用方负责串行。 */
export async function installMcpPackage(
 root:string,recipe:StdioRecipe,packageLock:unknown,
 npmBin='npm',
 timeoutMs=managedMcpInstallTimeoutMs,
 onInstall?:()=>unknown,
):Promise<string>{
 const dir=pkgDir(root,recipe.package,recipe.version)
 await installLockedPackage(dir,recipe,packageLock,npmBin,timeoutMs,onInstall)
 const resolvedBin=resolve(dir,'node_modules',recipe.package,recipe.bin)
 if(!existsSync(resolvedBin))throw new WorkError('teloa/dependency-unavailable',`安装包 ${recipe.package}@${recipe.version} bin 路径 ${recipe.bin} 不存在。`,{errorCode:'install-failed',retryable:true})
 return resolvedBin
}

/** onInstall：真正执行 npm 前调用（已装复核通过时不调用），受管连接据此记为 installing。 */
export type InstallFn=(root:string,recipe:StdioRecipe,packageLock:unknown,onInstall?:()=>unknown)=>Promise<string>

// ──────────── 连接配置构建 ────────────
/**
 * 第三方服务端的 `instructions` 会逐字进系统提示，DSH 上游默认上限 32768 字节，超出即拒连（不截断）。
 * 缺省取 4KB：已核对的远端里 DeepWiki 约 3.1KB、Greptile 约 2.8KB、GitHub 默认工具集约 1.9KB，都在内。
 * 条目可声明 `instructionsMaxBytes`（规格 2026-09-27 §7.2，契约限 4096 < n ≤ 32768）；宿主另以 32768 封顶（即上游默认上限），超限行为仍是 DSH 拒连不截断。
 */
const managedMcpMaxInstructionBytes=4096,managedMcpInstructionBytesCeiling=32768
//  远程连接在每次调用时重新读取凭据槽，不在 add 时固定；便于密钥轮换后重连自动生效。

// ──────────── 远端鉴权头（规格 2026-09-27 §7.1） ────────────
//  槽键确定性派生：header_<serverName>__<小写头名>、basic_user_<serverName>、basic_pass_<serverName>；与 bearer_<serverName> 同存一条凭据记录，覆盖面相同。
const headerSlotKey=(serverName:string,name:string)=>`header_${serverName}__${name.toLowerCase()}`
const basicUserKey=(serverName:string)=>`basic_user_${serverName}`
const basicPassKey=(serverName:string)=>`basic_pass_${serverName}`
/**
 * 值只允许可见 ASCII，杜绝 CR/LF 等控制字符注入。header 值按 RFC 9110 field-value 口径（主控裁定）：首尾为 field-vchar，中间可含 SP/HTAB，obs-text 不收；
 * bearer（审查修复 L-6）、用户名与密码不含空白；用户名另不含冒号（Basic 以第一个冒号分隔）。
 */
const headerSecretPat=/^[\x21-\x7e](?:[\x21-\x7e \t]{0,4094}[\x21-\x7e])?$/,bearerPat=/^[\x21-\x7e]{1,4096}$/,basicUserPat=/^[\x21-\x39\x3b-\x7e]{1,256}$/,basicPassPat=/^[\x21-\x7e]{8,4096}$/
const headerSecretMessage=(name:string)=>`请求头 ${name} 的密钥须为 1–4096 个可见 ASCII 字符（中间可含空格与制表符，首尾不能是空白）。`
const bearerMessage='Bearer Token 须为 1–4096 个可见 ASCII 字符（不含空白）。'
/** 粘了 `Bearer` 却剥不干净（只有前缀、或 `Bearer:tok` 这类带冒号／等号的写法）时不猜，拒收并提示只填令牌本身（审查 L2）。 */
const bearerPrefixMessage=bearerMessage+'只填令牌本身，不要带 Bearer 前缀。'
const basicUserMessage='用户名须为 1–256 个可见 ASCII 字符（不含空格与冒号）。'
const basicPassMessage='密码须为 8–4096 个可见 ASCII 字符（不含空格）。'

/**
 * 远端（streamable-http）鉴权头：bearer → `Authorization: Bearer <值>`；header → 名为 `name` 的头，无 scheme 为原值、scheme 以 `=` 结尾直接拼接、否则空格拼接；
 * basic → `Authorization: Basic base64(用户名:密码)`。必填缺失、值不合文法抛 teloa/invalid-input，报错只含服务名与头名，不含值。纯函数，不读存储。
 */
export function connectorAuthHeaders(auth:ConnectorAuth,serverName:string,slots:Record<string,string>):Record<string,string>{
 const headers:Record<string,string>={}
 if(auth.kind!=='secret')return headers
 for(const v of auth.vars){
  if(v.target==='bearer'){
   const token=slots[`bearer_${serverName}`]
   if(v.required&&!token)throw invalid(`受管连接 ${serverName} 缺少必填 Bearer Token。`)
   if(!token)continue
   if(!bearerPat.test(token))throw invalid(`受管连接 ${serverName} 的${bearerMessage}`)
   headers['Authorization']=`Bearer ${token}`
  }else if(v.target==='header'){
   // 纵深防御（审查修复 L-4）：头名文法、禁用集与 scheme 文法再按契约同一实现校验一次，不只依赖目录解析；报错不带头名原文（可能含控制字符）
   if(!connectorHeaderName.test(v.name)||isForbiddenConnectorHeader(v.name))throw invalid(`受管连接 ${serverName} 的鉴权头名不合文法或不允许。`)
   if(v.scheme!==undefined&&!connectorHeaderScheme.test(v.scheme))throw invalid(`受管连接 ${serverName} 的鉴权头 scheme 不合文法。`)
   const value=slots[headerSlotKey(serverName,v.name)]
   if(!value){if(v.required)throw invalid(`受管连接 ${serverName} 缺少必填请求头 ${v.name}。`);continue}
   if(!headerSecretPat.test(value))throw invalid(`受管连接 ${serverName} 的${headerSecretMessage(v.name)}`)
   headers[v.name]=v.scheme===undefined?value:v.scheme.endsWith('=')?v.scheme+value:`${v.scheme} ${value}`
  }else if(v.target==='basic'){
   const user=slots[basicUserKey(serverName)],pass=slots[basicPassKey(serverName)]
   if(!user||!pass){
    if(v.required)throw invalid(`受管连接 ${serverName} 缺少必填用户名或密码。`)
    if(user||pass)throw invalid(`受管连接 ${serverName} 的用户名与密码须同时填写。`)
    continue
   }
   if(!basicUserPat.test(user))throw invalid(`受管连接 ${serverName} 的${basicUserMessage}`)
   if(!basicPassPat.test(pass))throw invalid(`受管连接 ${serverName} 的${basicPassMessage}`)
   headers['Authorization']=`Basic ${Buffer.from(`${user}:${pass}`,'utf8').toString('base64')}`
  }
 }
 return headers
}

async function buildMcpConfig(
 recipe:MarketCatalogConnectorRecipe,
 auth:ConnectorAuth,
 serverName:string,
 runtimeRoot:string,
 install:InstallFn,
 slots:McpSlotStore,
 packageLock:unknown,
 onInstall?:()=>unknown,
):Promise<McpClient.Config>{
 if(auth.kind==='oauth'&&!auth.supported)throw new WorkError('teloa/dependency-unavailable',`连接 ${serverName} 需要 OAuth 授权，Teloa 下一版本支持。`)
 if(auth.kind==='oauth'){
  // OAuth 连接：DSH 客户端无 OAuth 钩子，始终以宿主保存的 access token 作静态 Bearer 头；每次建连重新读取
  if(recipe.transport!=='streamable-http')throw new WorkError('teloa/dependency-unavailable',`连接 ${serverName} 的 OAuth 授权仅支持远端 streamable-http。`)
  const tokens=await readTokens(slots,serverName)
  if(!tokens)throw new WorkError('teloa/invalid-input',`受管连接 ${serverName} 尚未完成 OAuth 授权，请先发起授权。`)
  return {transport:'streamable-http',serverName,url:recipe.url,headers:{Authorization:`Bearer ${tokens.accessToken}`},toolCallTimeoutMs:60_000,failOnStartupError:false}
 }
 // 每次建连时重新读取凭据槽，密钥轮换后无需重新 add；无需凭据的连接器不读存储
 const credentials=auth.kind==='secret'?await slots.read(serverName):{}
 if(recipe.transport==='stdio'){
  const binPath=await serialInstall(()=>install(runtimeRoot,recipe,packageLock,onInstall))
  const env:Record<string,string>={}
  // args 里 `${NAME}` 引用的变量（规格 §7.3）：未填时显式设为空串（审查修复 L-2），否则子进程会继承宿主同名变量并由桥接展开发往远端
  const referenced=new Set(recipe.args.flatMap(arg=>stdioArgEnvRefs(arg)??[]))
  if(auth.kind==='secret'){
   for(const v of auth.vars){
    if(v.target==='env'){
     const val=credentials[v.envVarName]
     if(v.required&&!val)throw new WorkError('teloa/invalid-input',`受管连接 ${serverName} 缺少必填密钥 ${v.envVarName}。`)
     if(val)env[v.envVarName]=val
     else if(referenced.has(v.envVarName))env[v.envVarName]=''
    }
   }
  }
  return {transport:'stdio',serverName,command:'node',args:[binPath,...recipe.args],env,cwd:runtimeRoot,toolCallTimeoutMs:60_000,failOnStartupError:false}
 }
 // streamable-http-template：密钥替换进 URL 路径；构造完整 URL 后校验主机名不变，存储密钥本身而非 URL
 if(recipe.transport==='streamable-http-template'){
  let finalUrl=recipe.urlTemplate
  if(auth.kind==='secret'){
   const urlPathVar=auth.vars.find(v=>v.target==='url-path')
   if(urlPathVar){
    const credKey=`url_path_${serverName}`
    const secret=credentials[credKey]
    if(urlPathVar.required&&!secret)throw new WorkError('teloa/invalid-input',`受管连接 ${serverName} 缺少必填 URL 路径令牌。`)
    if(secret){
     // 安全：只允许字母数字、连字符、下划线，防止路径遍历或注入
     if(!/^[A-Za-z0-9_-]{1,256}$/.test(secret))throw new WorkError('teloa/invalid-input',`受管连接 ${serverName} 的 URL 路径令牌含不允许的字符（只允许字母、数字、下划线、连字符）。`)
     const constructed=recipe.urlTemplate.replace('{secret}',secret)
     // 校验构造后的 URL 主机名与模板一致（防止令牌中嵌入 @ 等绕过主机验证）
     const templateHost=new URL(recipe.urlTemplate.replace('{secret}','placeholder')).hostname
     const finalHost=new URL(constructed).hostname
     if(finalHost!==templateHost)throw new WorkError('teloa/invalid-input',`受管连接 ${serverName} 构造的 URL 主机名与配方模板不一致。`)
     finalUrl=constructed
    }
   }
  }
  return {transport:'streamable-http',serverName,url:finalUrl,headers:{},toolCallTimeoutMs:60_000,failOnStartupError:false}
 }
 // streamable-http（固定 URL）：凭据按声明拼成 Bearer / 自定义头 / Basic；每次重连都重新读取
 return {transport:'streamable-http',serverName,url:recipe.url,headers:connectorAuthHeaders(auth,serverName,credentials),toolCallTimeoutMs:60_000,failOnStartupError:false}
}

// ──────────── OAuth 回调页与配置 ────────────

/** 宿主 HTTP 服务（`@deepseek-ai/dsh-host-webserver`）中本模块用到的部分 */
type WebServerLike={host:string;port:number;register(route:{kind:'exact';path:string;handler:(req:IncomingMessage,res:ServerResponse)=>void|Promise<void>}):()=>void}

/** 取不到（未注入或非 Web 组合）时返回 undefined：不注册回调路由，发起授权时报不可用 */
function webServerOf(ctx:Context):WebServerLike|undefined{
 try{return Reflect.get(ctx,'webServer') as WebServerLike|undefined}catch{return undefined}
}

/** 计划附录固定文案：state 不匹配或已超时 */
const callbackInvalidStateMessage='OAuth 回调验证失败（state 不匹配或已超时），请重新发起授权。'
const callbackSuccessMessage='授权成功，可返回 Teloa 工作台。'
const callbackConnectFailedMessage='授权已完成，但连接未能建立，请返回 Teloa 工作台查看。'
const callbackFailedMessage='授权处理失败，请返回 Teloa 工作台重新发起授权。'
/** 回调未带回（或带错）发起授权时下发的浏览器绑定 cookie */
/** 回调时凭据存储锁定：不改连接状态，令牌未保存（已换得的已吊销） */
const callbackStorageLockedMessage='密钥存储已锁定，授权未保存；请到设置页处理后重新授权。'
const callbackBrowserMismatchMessage='OAuth 回调验证失败（不是发起授权的浏览器），请在发起授权的同一浏览器中重新授权。'
/** 授权入口 /oauth/start 的 state 不存在或已过期 */
const oauthStartInvalidMessage='授权链接无效或已过期，请回到 Teloa 重新发起。'

/** 浏览器绑定 cookie：每个 state 一个名字，同一浏览器并行授权多个连接互不覆盖 */
const bindingCookieName=(state:string)=>`teloa_oauth_${state.slice(0,16)}`
/** cookie 与回调同目录（本地为 /oauth）；https 回调加 Secure */
function bindingCookie(state:string,value:string,redirectUri:string,maxAge:number):string{
 const url=new URL(redirectUri)
 const path=url.pathname.replace(/\/[^/]*$/,'')||'/'
 return `${bindingCookieName(state)}=${value}; HttpOnly; SameSite=Lax; Path=${path}; Max-Age=${maxAge}${url.protocol==='https:'?'; Secure':''}`
}
function readCookie(req:IncomingMessage,name:string):string|undefined{
 for(const part of (req.headers.cookie??'').split(';')){
  const at=part.indexOf('=')
  if(at>0&&part.slice(0,at).trim()===name)return part.slice(at+1).trim()
 }
 return undefined
}

/** 回调页只输出固定文案（不回显 code / state / 令牌 / 授权服务器报错），禁止缓存、嵌入、外链与 Referer 外泄 */
function sendCallbackPage(res:ServerResponse,status:number,message:string,extraHeaders:Record<string,string>={}):void{
 res.writeHead(status,{
  'Content-Type':'text/html; charset=utf-8',
  'Cache-Control':'no-store',
  'Pragma':'no-cache',
  'X-Content-Type-Options':'nosniff',
  'Referrer-Policy':'no-referrer',
  'X-Frame-Options':'DENY',
  'Content-Security-Policy':"default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ...extraHeaders,
 })
 res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Teloa</title></head><body><p>${message}</p></body></html>`)
}

/**
 * 运行目录配置文件 `config.json` 的 `oauth.publicCallbackUrl`（服务器部署的公开 https 回调地址）。
 * 文件缺失、无此项或格式不对时返回 undefined，由 OAuthFlowManager 以环境变量 TELOA_OAUTH_PUBLIC_CALLBACK_URL 兜底；
 * 地址本身的合法性（https、无用户信息与 fragment）在发起授权时校验。
 */
function configuredPublicCallbackUrl(ctx:Context,runtimeRoot:string):string|undefined{
 const path=resolve(runtimeRoot,'config.json')
 // 权限与内容取自同一文件句柄，避免检查后被替换（TOCTOU）
 let text:string,mode:number,uid:number
 let fd:number|undefined
 try{fd=openSync(path,'r');({mode,uid}=fstatSync(fd));text=readFileSync(fd,'utf8')}catch{return undefined}
 finally{if(fd!==undefined)closeSync(fd)}
 // 其他用户可写或不属于当前用户的配置能把授权码引到任意回调地址：忽略该项，回退环境变量（非 POSIX 平台无此语义）
 if(process.platform!=='win32'&&(mode&0o022)!==0){
  ctx.logger?.warn?.('运行目录配置文件 config.json 对其他用户可写，已忽略 oauth.publicCallbackUrl。')
  return undefined
 }
 if(process.platform!=='win32'&&typeof process.getuid==='function'&&uid!==process.getuid()){
  ctx.logger?.warn?.('运行目录配置文件 config.json 的所有者不是当前用户，已忽略 oauth.publicCallbackUrl。')
  return undefined
 }
 try{
  const parsed:unknown=JSON.parse(text)
  const value=isRecord(parsed)&&isRecord(parsed.oauth)?parsed.oauth.publicCallbackUrl:undefined
  if(value===undefined)return undefined
  if(typeof value==='string'&&value)return value
 }catch{}
 ctx.logger?.warn?.('运行目录配置文件 config.json 的 oauth.publicCallbackUrl 无法读取，已忽略。')
 return undefined
}

/**
 * 只注册目录声明的工具：DSH mcp-client 没有工具白名单，服务器 `tools/list` 列出的全部工具都会注册成全局工具
 * （个人会话与能力页都能看到）。这里用 Cordis 的 `ctx.extend` 给客户端一个只放行声明公开名的 `tools`，
 * 初次同步与之后的重同步都走同一个 `register`；未声明的工具不进注册表，也就无从调用。
 */
function declaredToolsOnly(declared:ReadonlyMap<string,string>,source:ToolResourceSource,provenance:()=>ToolResourceProvenance){
 return {
  name:McpClient.name,
  inject:McpClient.inject,
  Config:McpClient.Config,
  apply:(ctx:Context,config:McpClient.Config)=>{
   const tools=ctx.tools
   const register:typeof tools.register=definition=>{
    const rawToolName=declared.get(definition.name)
    return rawToolName===undefined?()=>{}:tools.register(provenance().wrapDefinition(definition,{...source,rawToolName}))
   }
   return McpClient.apply(ctx.extend({tools:new Proxy(tools,{get:(target,prop)=>prop==='register'?register:Reflect.get(target,prop)})}),config)
  },
 }
}

const isSupportedOAuth=(entry:MarketCatalogConnectorEntry)=>entry.connector.auth.kind==='oauth'&&entry.connector.auth.supported

/** 厂商只允许白名单客户端：官方白名单 client_id 尚未提供，只有要求用户自带已获批 client_id 的配方可登记 / 发起授权 */
function assertNotAllowlistBlocked(entry:MarketCatalogConnectorEntry):void{
 const auth=entry.connector.auth
 if(auth.kind==='oauth'&&auth.supported&&auth.requiresAllowlist&&!auth.requiresUserClientId){
  throw new WorkError('teloa/dependency-unavailable',`连接 ${entry.id} 暂不可用：厂商只允许白名单审批的客户端，Teloa 官方客户端尚未获批。`)
 }
}

// ──────────── 导出主函数 ────────────

export function createManagedMcpConnectionHandler(
 ctx:Context,
 runtimeRoot:string,
 getConnectorEntry:(catalogId:string)=>ManagedConnectorEntry|undefined,
 install:InstallFn=(root,recipe,packageLock,onInstall)=>installMcpPackage(root,recipe,packageLock,'npm',managedMcpInstallTimeoutMs,onInstall),
 /** 仅测试替换（例如放行本地假授权服务器）；生产始终用默认工厂 */
 createOAuthManager:(options:OAuthFlowManagerOptions)=>OAuthFlowManager=options=>new OAuthFlowManager(options),
):{
 handler:(endpoint:string,payload:unknown)=>Promise<unknown>
 restoreConnections:()=>Promise<void>
 getManagedMcpToolRules:()=>TaskToolArgumentRule[]
 /** 刷新临近到期的 OAuth 令牌并重连（定时器每分钟调用一次） */
 refreshOAuthConnections:()=>Promise<void>
 /** 撤回回调路由并停止刷新定时器 */
 dispose:()=>void
 callTool:(serverName:string,tool:string,args:Record<string,unknown>,signal:AbortSignal)=>Promise<unknown>
 isReadOnlyTool:(serverName:string,tool:string)=>boolean
 /** 该受管连接是否已建立（连接纤程在、工具目录已登记）；同步源据此把「没连上」与「不是只读工具」分开报 */
 isConnected:(serverName:string)=>boolean
 /** 建连中或已连接、目录声明为非只读的工具公开名 → 确认卡里的称呼；其余返回 undefined */
 writeToolLabel:(fullName:string)=>string|undefined
}{
 const slots=credentialSlotStore((ctx as unknown as {credentials:McpCredentialPort}).credentials,errorName=>ctx.logger?.debug?.('受管 MCP 凭据存储故障按锁定处理：%s',errorName))
 // 配置文件优先；缺省时以环境变量兜底，但只认启动时继承的进程环境（工作区 .env 被 DSH 合入 process.env，改回调即可截获授权码）。
 const publicCallbackUrl=configuredPublicCallbackUrl(ctx,runtimeRoot)??(securityEnv(ctx).TELOA_OAUTH_PUBLIC_CALLBACK_URL||undefined)
 const oauth=createOAuthManager(publicCallbackUrl?{runtimeRoot,slots,publicCallbackUrl}:{runtimeRoot,slots})
 /** serverName -> live Fiber；Fiber.dispose() 自动断开并注销工具 */
 const liveConnections=new Map<string,Fiber>()
 /** serverName -> 已注册工具列表；与 liveConnections 同进退 */
 const connectedToolsMap=new Map<string,{name:string;fullName:string;readOnly:boolean}[]>()
 /**
  * serverName -> 目录声明的全部工具（含规范化后的公开名）；建连前写入、释放时删除。
  * 写工具审批按它判断，而不是按建连时的注册快照：服务端之后经 list_changed 才公布的已声明写工具同样逐次确认。
  */
 const declaredToolsMap=new Map<string,{name:string;fullName:string;readOnly:boolean}[]>()

 /**
  * 连接级操作（connect / disconnect / delete、回调与刷新后的重连）按 serverName 串行，与令牌读写共用同一把锁；
  * 锁内重读状态文件，按最新记录决定是否继续（已删除或已断开则放弃重连）。锁内不得再调用会取同一把锁的管理器方法。
  */
 const locked=<T>(serverName:string,task:()=>Promise<T>)=>oauth.exclusive(serverName,task)

 /** 释放客户端实例并注销其工具 */
 async function releaseClient(serverName:string):Promise<void>{
  declaredToolsMap.delete(serverName)
  const fiber=liveConnections.get(serverName)
  if(!fiber)return
  liveConnections.delete(serverName);connectedToolsMap.delete(serverName)
  await Promise.resolve(fiber.dispose()).catch(()=>{})
 }

 // 同一连接同时只允许一个建立过程，避免重复安装与重复拉起进程
 const connecting=new Set<string>()
 async function connectOnce(id:string,serverName:string,entry:ManagedConnectorEntry):Promise<ManagedMcpConnectionRecord>{
  if(connecting.has(serverName))throw conflict('该连接正在建立中，请稍后再试。')
  connecting.add(serverName)
  try{
   return await locked(serverName,async()=>{
    const conn=(await loadState(runtimeRoot)).connections.find(c=>c.id===id)
    if(!conn)throw invalid('受管 MCP 连接不存在。')
    return doConnect(conn,entry)
   })
  }finally{connecting.delete(serverName)}
 }

 /** 须在连接锁内调用；状态写入只改本连接记录 */
 async function doConnect(conn:PersistedConnection,entry:ManagedConnectorEntry):Promise<ManagedMcpConnectionRecord>{
  const patch=(apply:(c:PersistedConnection)=>void)=>updateState(runtimeRoot,state=>{
   const c=state.connections.find(c=>c.id===conn.id)
   if(c){apply(c);c.updatedAt=new Date().toISOString()}
  })
  if(liveConnections.has(conn.serverName)){
   await patch(c=>{c.status='connected'})
   return toRecord(conn)
  }
  // 首次安装期间记录为 installing（界面显示「正在安装」，不算建连失败）；安装另有独立超时，建连超时从装完后才开始计
  let installing=false
  const markInstalling=async()=>{installing=true;await patch(c=>{c.status='installing';delete c.errorMessage;delete c.errorCode;delete c.tools})}
  let built:McpClient.Config
  try{built=await buildMcpConfig(entry.connector.recipe,entry.connector.auth,conn.serverName,runtimeRoot,install,slots,entry.packageLock,markInstalling)}
  catch(error){
   const errorCode=managedInstallErrorCode(error)??(installing?'install-failed':undefined)
   if(errorCode)await patch(c=>{c.status='error';c.errorMessage=installFailureMessages[errorCode];c.errorCode=errorCode;delete c.tools})
   throw error
  }
  const config={...built,maxInstructionBytes:Math.min(entry.connector.instructionsMaxBytes??managedMcpMaxInstructionBytes,managedMcpInstructionBytesCeiling)}
  const declared=entry.connector.tools.map(t=>({name:t.name,fullName:mcpToolFullName(conn.serverName,t.name),readOnly:t.readOnly}))
  // 先登记再建连：首次同步到写入快照之间、以及之后重同步新增的已声明写工具，都已在审批闸的名单里
  declaredToolsMap.set(conn.serverName,declared)
  const fiber=ctx.plugin(declaredToolsOnly(new Map(declared.map(t=>[t.fullName,t.name])),{kind:'mcp',providerId:conn.serverName,name:entry.connector.title['zh-CN']},()=>getToolResourceProvenance(ctx)),config)
  let timer:ReturnType<typeof setTimeout>|undefined
  try{
   await Promise.race([fiber,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('MCP connect timed out')),connectTimeoutMs)})])
  }catch(err){
   // 失败或超时的客户端实例立即释放，避免在后台继续重连；原始报错不落盘、不回传
   await Promise.resolve(fiber.dispose()).catch(()=>{})
   declaredToolsMap.delete(conn.serverName)
   const msg=connectFailureReason(err)
   await patch(c=>{c.status='error';c.errorMessage=msg;delete c.errorCode})
   throw new WorkError('teloa/dependency-unavailable',`MCP 连接 ${conn.serverName} 启动失败。`)
  }finally{clearTimeout(timer)}
  liveConnections.set(conn.serverName,fiber)
  const toolSchemas=ctx.tools.schemas()
  const tools=declared.filter(t=>toolSchemas.some((s:{name:string})=>s.name===t.fullName))
  connectedToolsMap.set(conn.serverName,tools)
  await patch(c=>{c.status='connected';c.tools=tools;delete c.errorMessage;delete c.errorCode})
  return toRecord({...conn,status:'connected',tools})
 }

 /** 以最新凭据重建客户端：先释放旧实例（注销工具），再按新 Bearer 头建连。须在连接锁内调用 */
 async function reconnect(conn:PersistedConnection,entry:ManagedConnectorEntry):Promise<ManagedMcpConnectionRecord>{
  await releaseClient(conn.serverName)
  return doConnect(conn,entry)
 }

 /** OAuth 刷新失败：断开并置 error，errorMessage 为固定脱敏文本。须在连接锁内调用 */
 async function markOAuthFailed(conn:PersistedConnection,errorMessage:string):Promise<void>{
  await releaseClient(conn.serverName)
  await updateState(runtimeRoot,state=>{
   const c=state.connections.find(c=>c.id===conn.id)
   if(c){c.status='error';c.errorMessage=errorMessage;delete c.tools;c.updatedAt=new Date().toISOString()}
  })
 }

 /** 回调结果落到连接状态：成功则以新令牌重连；拒绝 / 换取失败置 error（附录文案）。返回回调页状态码与固定文案 */
 async function applyCallbackResult(result:CallbackResult):Promise<{status:number;message:string}>{
  if(result.kind==='invalid-state')return {status:400,message:callbackInvalidStateMessage}
  if(result.kind==='storage-locked')return {status:503,message:callbackStorageLockedMessage}
  return locked(result.serverName,async()=>{
   const state=await loadState(runtimeRoot)
   const conn=state.connections.find(c=>c.id===result.connectionId)
   if(!conn){
    // 写入令牌后连接被删除：删除已吊销并清掉凭据；若仍有孤立令牌（且无同名新连接），先吊销再删除
    if(result.kind==='authorized'&&!state.connections.some(c=>c.serverName===result.serverName)){
     const revoke=await oauth.prepareRevoke(result.serverName)
     await slots.remove(result.serverName)
     await revoke()
    }
    return {status:400,message:callbackInvalidStateMessage}
   }
   if(result.kind!=='authorized'){
    await updateState(runtimeRoot,latest=>{
     const c=latest.connections.find(c=>c.id===result.connectionId)
     if(c){c.status='error';c.errorMessage=result.errorMessage;delete c.tools;c.updatedAt=new Date().toISOString()}
    })
    return {status:400,message:result.errorMessage}
   }
   const entry=getConnectorEntry(conn.catalogId)
   if(!entry)return {status:200,message:callbackConnectFailedMessage}
   try{await reconnect(conn,entry);return {status:200,message:callbackSuccessMessage}}
   catch{return {status:200,message:callbackConnectFailedMessage}}
  })
 }

 /** 回调换取令牌后、写入前（令牌锁内）确认连接仍是发起授权的那条 */
 async function isCurrentConnection(connectionId:string):Promise<boolean>{
  return (await loadState(runtimeRoot)).connections.some(c=>c.id===connectionId)
 }

 /** GET /oauth/callback：只认 state（128 bit 十六进制）；code / error 仅交给管理器，不写日志、不回显 */
 async function handleOAuthCallback(req:IncomingMessage,res:ServerResponse):Promise<void>{
  try{
   if(req.method!=='GET'){sendCallbackPage(res,405,callbackFailedMessage,{Allow:'GET'});return}
   const query=new URL(req.url??'/','http://127.0.0.1').searchParams
   const state=query.get('state')
   if(!state||!/^[0-9a-f]{32}$/.test(state)){sendCallbackPage(res,400,callbackInvalidStateMessage);return}
   const code=query.get('code')??undefined,error=query.get('error')??undefined,iss=query.get('iss')??undefined
   // 超长参数不交给管理器（不消耗 state、不换取）
   if((code?.length??0)>4096||(error?.length??0)>128){sendCallbackPage(res,400,callbackFailedMessage);return}
   // 浏览器绑定：必须是打开过 /oauth/start 的同一浏览器；不符时不消耗 state、不换取（未知 / 过期 state 交给管理器按无效 state 处理）
   const redirectUri=oauth.pendingFlows.get(state)?.redirectUri
   const clear:Record<string,string>=redirectUri?{'Set-Cookie':bindingCookie(state,'',redirectUri,0)}:{}
   if(redirectUri&&!oauth.browserBound(state,readCookie(req,bindingCookieName(state)))){sendCallbackPage(res,400,callbackBrowserMismatchMessage);return}
   const result=await oauth.handleCallback(state,code,error,{...(iss!==undefined?{iss}:{}),isCurrent:isCurrentConnection})
   const {status,message}=await applyCallbackResult(result)
   sendCallbackPage(res,status,message,clear)
  }catch{
   if(!res.headersSent)sendCallbackPage(res,500,callbackFailedMessage);else res.end()
  }
 }

 /**
  * GET /oauth/start：oauth-start 回包给出的授权入口。首次打开下发浏览器绑定 cookie（HttpOnly、SameSite=Lax、与回调同路径）
  * 并 302 跳转授权服务器；再次打开只跳转不下发；state 不存在或过期回 400 固定文案。
  */
 function handleOAuthStart(req:IncomingMessage,res:ServerResponse):void{
  try{
   if(req.method!=='GET'){sendCallbackPage(res,405,callbackFailedMessage,{Allow:'GET'});return}
   const state=new URL(req.url??'/','http://127.0.0.1').searchParams.get('state')
   const bound=state&&/^[0-9a-f]{32}$/.test(state)?oauth.bindBrowser(state):undefined
   if(!state||!bound){sendCallbackPage(res,400,oauthStartInvalidMessage);return}
   res.writeHead(302,{
    Location:bound.authorizationUrl,
    'Cache-Control':'no-store',
    'Referrer-Policy':'no-referrer',
    ...(bound.nonce?{'Set-Cookie':bindingCookie(state,bound.nonce,bound.redirectUri,Math.ceil(pendingFlowTtlMs/1000))}:{}),
   })
   res.end()
  }catch{
   if(!res.headersSent)sendCallbackPage(res,500,callbackFailedMessage);else res.end()
  }
 }

 /** oauth-start / oauth-status 的共同入口：UUID 校验、连接存在、连接器为可用的 OAuth */
 async function oauthConnection(payload:unknown):Promise<{state:StateFile;conn:PersistedConnection;entry:ManagedConnectorEntry}>{
  const input=taskInput(payload,['id'])
  if(!uuid(input.id))throw invalid('受管 MCP 连接身份必须是 UUID。')
  const state=await loadState(runtimeRoot)
  const conn=state.connections.find(c=>c.id===input.id)
  if(!conn)throw invalid('受管 MCP 连接不存在。')
  const entry=getConnectorEntry(conn.catalogId)
  if(!entry)throw invalid(`目录中找不到连接 ${conn.catalogId}。`)
  if(!isSupportedOAuth(entry))throw invalid('该连接不使用 OAuth 授权。')
  return {state,conn,entry}
 }

 /**
  * 断开：释放客户端。OAuth 连接另在锁内只清令牌槽、再 best-effort 吊销令牌（RFC 7009），
  * 保留 oauth_client_id / oauth_client_info，状态回到 pending-oauth（须重新授权）；未完成的授权随之作废。
  * OAuth 连接先做可写预检：存储锁定时零副作用（不作废授权、不释放客户端、不吊销、不改状态）。
  */
 async function doDisconnect(conn:PersistedConnection):Promise<ManagedMcpConnectionRecord>{
  const {id,serverName}=conn
  const entry=getConnectorEntry(conn.catalogId)
  const isOAuth=entry!==undefined&&isSupportedOAuth(entry)
  if(isOAuth)await slots.assertWritable(serverName)
  for(const [flowState,flow] of oauth.pendingFlows){if(flow.connectionId===id)oauth.pendingFlows.delete(flowState)}
  return locked(serverName,async()=>{
   const state=await loadState(runtimeRoot)
   const c=state.connections.find(c=>c.id===id)
   if(!c)throw invalid('受管 MCP 连接不存在。')
   // 先读出吊销所需（只读，锁定在此抛出）→ 写存储清令牌槽 → 释放客户端 → 最后远端吊销
   const revoke=isOAuth?await oauth.prepareRevoke(serverName):async()=>{}
   if(isOAuth)await clearTokens(slots,serverName)
   await releaseClient(serverName)
   await revoke()
   const record=await updateState(runtimeRoot,latest=>{
    const current=latest.connections.find(item=>item.id===id)
    if(!current)return undefined
    current.status=isOAuth?'pending-oauth':'saved';delete current.tools;delete current.errorMessage;delete current.errorCode;current.updatedAt=new Date().toISOString()
    return toRecord(current)
   })
   if(!record)throw invalid('受管 MCP 连接不存在。')
   return record
  })
 }

 function toRecord(conn:PersistedConnection|ManagedMcpConnectionRecord):ManagedMcpConnectionRecord{
  // 绝不含凭据字段；_credentialsStored 是内部标记，不外露
  const {id,catalogId,serverName,status,createdAt,updatedAt}=conn
  const rec:ManagedMcpConnectionRecord={id,catalogId,serverName,status,createdAt,updatedAt}
  if('errorMessage' in conn&&conn.errorMessage)rec.errorMessage=conn.errorMessage
  if('errorCode' in conn&&conn.errorCode)rec.errorCode=conn.errorCode
  if('tools' in conn&&conn.tools)rec.tools=conn.tools
  return rec
 }

 /** 凭据存储锁定：固定文案，不带原因与路径；删除随之拒绝，不留下存储里的孤儿凭据 */
 async function handler(endpoint:string,payload:unknown):Promise<unknown>{
  try{return await dispatch(endpoint,payload)}
  catch(error){if(isCredentialStoreLocked(error))throw new WorkError('teloa/storage-unavailable',credentialStoreLockedMessage);throw error}
 }

 async function dispatch(endpoint:string,payload:unknown):Promise<unknown>{
  if(!(managedMcpConnectionEndpoints as readonly string[]).includes(endpoint))throw invalid('不支持的受管 MCP 连接操作。')

  if(endpoint==='mcp-connections/list'){
   taskInput(payload,[])
   return {items:(await loadState(runtimeRoot)).connections.map(toRecord)}
  }

  if(endpoint==='mcp-connections/get'){
   const input=taskInput(payload,['id'])
   if(!uuid(input.id))throw invalid('受管 MCP 连接身份必须是 UUID。')
   const state=await loadState(runtimeRoot)
   const conn=state.connections.find(c=>c.id===input.id)
   if(!conn)throw invalid('受管 MCP 连接不存在。')
   return toRecord(conn)
  }

  if(endpoint==='mcp-connections/add'){
   // 严格白名单：只接受 catalogId 和可选的 credentials 两个字段
   const input=taskInput(payload,['catalogId','credentials'])
   if(typeof input.catalogId!=='string'||!catalogIdPat.test(input.catalogId))throw invalid('catalogId 格式不正确。')
   if(input.credentials!==undefined&&!isRecord(input.credentials))throw invalid('credentials 必须是键值对象。')
   const entry=getConnectorEntry(input.catalogId)
   if(!entry)throw invalid(`目录中找不到连接 ${input.catalogId}。`)
   if(entry.compatibility.status==='unsupported'){
    const reason=entry.connector.auth.kind==='oauth'&&!entry.connector.auth.supported?entry.connector.auth.reason:entry.compatibility.conditions.map(c=>c['zh-CN']).join('；')
    throw new WorkError('teloa/dependency-unavailable',`连接 ${input.catalogId} 不支持：${reason}`)
   }
   assertNotAllowlistBlocked(entry)
   // 凭据字段白名单验证：只接受配方 auth 声明的 envVarName，拒绝任何未声明字段
   const submitted:Record<string,unknown>=isRecord(input.credentials)?{...input.credentials}:{}
   if(entry.connector.auth.kind==='secret'){
    const server=entry.connector.serverName,vars=entry.connector.auth.vars
    const allowedEnvKeys=vars.filter(v=>v.target==='env').map(v=>v.envVarName)
    const allowedBearerKey=vars.some(v=>v.target==='bearer')?[`bearer_${server}`]:[]
    const allowedUrlPathKey=vars.some(v=>v.target==='url-path')?[`url_path_${server}`]:[]
    // header / basic（规格 2026-09-27 §7.1）：槽键按声明派生，值在保存时即校验文法（建连时 connectorAuthHeaders 再校验一次）
    const headerKeys=new Map(vars.flatMap(v=>v.target==='header'?[[headerSlotKey(server,v.name),v.name] as const]:[]))
    const basicKeys=vars.some(v=>v.target==='basic')?[basicUserKey(server),basicPassKey(server)]:[]
    const allAllowed=[...allowedEnvKeys,...allowedBearerKey,...allowedUrlPathKey,...headerKeys.keys(),...basicKeys]
    for(const key of Object.keys(submitted)){
     if(!allAllowed.includes(key))throw invalid(`密钥字段 ${key} 未在配方中声明。`)
     if(entry.connector.recipe.transport==='stdio'&&!envVarPat.test(key)&&!allowedBearerKey.includes(key))throw invalid(`密钥字段名 ${key} 格式不正确。`)
     const raw=submitted[key]
     if(typeof raw!=='string')throw invalid(`密钥值必须是字符串。`)
     // 用户从别处复制时常带首尾空白或换行，bearer 还常连着 `Bearer ` 前缀一起粘：先归一再校验，存的是归一后的值（建连时拼 `Bearer ` 只一层）
     const headerName=headerKeys.get(key)
     const value=allowedBearerKey.includes(key)?raw.trim().replace(/^bearer(?:\s+|$)/i,''):headerName!==undefined||basicKeys.includes(key)?raw.trim():raw
     submitted[key]=value
     if(headerName!==undefined&&!headerSecretPat.test(value))throw invalid(headerSecretMessage(headerName))
     if(allowedBearerKey.includes(key)&&(/^bearer(?:$|[\s:=])/i.test(raw.trim())&&(!value||/^bearer[:=]/i.test(value)||!bearerPat.test(value))))throw invalid(bearerPrefixMessage)
     if(allowedBearerKey.includes(key)&&!bearerPat.test(value))throw invalid(bearerMessage)
     if(key===basicUserKey(server)&&!basicUserPat.test(value))throw invalid(basicUserMessage)
     if(key===basicPassKey(server)&&!basicPassPat.test(value))throw invalid(basicPassMessage)
    }
    if(basicKeys.length&&(basicUserKey(server) in submitted)!==(basicPassKey(server) in submitted))throw invalid('用户名与密码须同时填写。')
   }else if(entry.connector.auth.kind==='oauth'&&entry.connector.auth.supported&&entry.connector.auth.requiresUserClientId){
    // 只接受用户自建 OAuth App 的 client_id；令牌、client 信息等 oauth_* 槽只由宿主写入
    for(const key of Object.keys(submitted)){
     if(key!=='oauth_client_id')throw invalid(`密钥字段 ${key} 未在配方中声明。`)
     const value=submitted[key]
     if(typeof value!=='string'||!/^[\x21-\x7e]{1,512}$/.test(value))throw invalid('oauth_client_id 必须是 1 到 512 个可见 ASCII 字符。')
     // 配方声明的格式（契约已校验为锚定、无分组的短正则）
     if(entry.connector.auth.clientIdPattern&&!new RegExp(entry.connector.auth.clientIdPattern,'u').test(value))throw invalid('oauth_client_id 格式与该连接要求不符。')
    }
   }else if(Object.keys(submitted).length>0){
    throw invalid(`连接 ${input.catalogId} 不需要密钥。`)
   }
   const serverName=entry.connector.serverName
   // 查重、写凭据、写状态在同一 serverName 锁内：并发 add 不会重复登记或互相覆盖凭据
   return locked(serverName,async()=>{
    const duplicate=(state:StateFile)=>{if(state.connections.some(c=>c.serverName===serverName))throw conflict(`serverName ${serverName} 已有活跃连接，不能重复添加。`)}
    duplicate(await loadState(runtimeRoot))
    const now=new Date().toISOString()
    const id=randomUUID()
    // OAuth 连接登记后等待负责人在浏览器中完成授权
    const conn:PersistedConnection={id,catalogId:input.catalogId as string,serverName,status:isSupportedOAuth(entry)?'pending-oauth':'saved',createdAt:now,updatedAt:now,_credentialsStored:false}
    if(Object.keys(submitted).length>0){
     await slots.replace(serverName,submitted as Record<string,string>)
     conn._credentialsStored=true
    }
    await updateState(runtimeRoot,state=>{duplicate(state);state.connections.push(conn)})
    return toRecord(conn)
   })
  }

  if(endpoint==='mcp-connections/connect'){
   const input=taskInput(payload,['id'])
   if(!uuid(input.id))throw invalid('受管 MCP 连接身份必须是 UUID。')
   const state=await loadState(runtimeRoot)
   const conn=state.connections.find(c=>c.id===input.id)
   if(!conn)throw invalid('受管 MCP 连接不存在。')
   const entry=getConnectorEntry(conn.catalogId)
   if(!entry)throw invalid(`目录中找不到连接 ${conn.catalogId}。`)
   return connectOnce(conn.id,conn.serverName,entry)
  }

  if(endpoint==='mcp-connections/disconnect'){
   const input=taskInput(payload,['id'])
   if(!uuid(input.id))throw invalid('受管 MCP 连接身份必须是 UUID。')
   const state=await loadState(runtimeRoot)
   const conn=state.connections.find(c=>c.id===input.id)
   if(!conn)throw invalid('受管 MCP 连接不存在。')
   return doDisconnect(conn)
  }

  if(endpoint==='mcp-connections/delete'){
   const input=taskInput(payload,['id'])
   if(!uuid(input.id))throw invalid('受管 MCP 连接身份必须是 UUID。')
   const state=await loadState(runtimeRoot)
   const idx=state.connections.findIndex(c=>c.id===input.id)
   if(idx===-1)throw invalid('受管 MCP 连接不存在。')
   const {id,serverName,catalogId}=state.connections[idx]!
   // 无需凭据的连接器没有凭据记录，删除不碰存储（锁定时也能删）；其余先做可写预检，锁定时零副作用
   const entry=getConnectorEntry(catalogId)
   const touchesStore=entry===undefined||entry.connector.auth.kind!=='none'
   if(touchesStore)await slots.assertWritable(serverName)
   // 先立即释放客户端（注销工具）；未完成的授权随连接作废
   await releaseClient(serverName)
   for(const [flowState,flow] of oauth.pendingFlows){if(flow.connectionId===id)oauth.pendingFlows.delete(flowState)}
   // 锁内：读出吊销所需（只读）→ 删凭据记录 → 删连接记录 → 再释放一次（进行中的刷新 / 回调可能已重建客户端）→ 最后 best-effort 吊销（RFC 7009，失败静默）
   await locked(serverName,async()=>{
    const revoke=touchesStore?await oauth.prepareRevoke(serverName):async()=>{}
    // 删凭据记录失败（预检之后存储才不可写）：客户端已释放，把状态对齐为 error 再上抛，connections.json 不依赖凭据存储
    if(touchesStore)await slots.remove(serverName).catch(async(error:unknown)=>{
     if(isCredentialStoreLocked(error))await updateState(runtimeRoot,latest=>{const c=latest.connections.find(item=>item.id===id);if(c){c.status='error';c.errorMessage=credentialStoreLockedMessage;delete c.tools;c.updatedAt=new Date().toISOString()}})
     throw error
    })
    await updateState(runtimeRoot,latest=>{latest.connections=latest.connections.filter(c=>c.id!==id)})
    await releaseClient(serverName)
    await revoke()
   })
   return {}
  }

  if(endpoint==='mcp-connections/oauth-start'){
   const {conn,entry}=await oauthConnection(payload)
   assertNotAllowlistBlocked(entry)
   if(conn.status==='connected')return {status:'already-connected'}
   const web=webServerOf(ctx)
   if(!web)throw new WorkError('teloa/dependency-unavailable','Teloa 的 HTTP 服务不可用，暂不能发起 OAuth 授权。')
   // startFlow 自己按 serverName 加锁写元数据 / client 信息，须在连接锁外调用
   // 客户端拿到的是宿主自己的 /oauth/start（与回调同目录）：经它下发浏览器绑定 cookie 再跳转授权服务器
   const {startUrl:authorizationUrl}=await oauth.startFlow({webServer:web},conn.id,entry)
   // 发起授权有网络往返：在 serverName 锁内重新读取状态再写，不覆盖期间的删除 / 断开等变更
   return locked(conn.serverName,async()=>{
    const found=await updateState(runtimeRoot,state=>{
     const c=state.connections.find(item=>item.id===conn.id)
     if(!c)return false
     c.status='pending-oauth';delete c.errorMessage;delete c.tools;c.updatedAt=new Date().toISOString()
     return true
    })
    if(!found){
     // 期间连接已删除：作废刚登记的授权；无同名连接时清掉 startFlow 可能写出的孤立凭据
     for(const [flowState,flow] of oauth.pendingFlows){if(flow.connectionId===conn.id)oauth.pendingFlows.delete(flowState)}
     if(!(await loadState(runtimeRoot)).connections.some(item=>item.serverName===conn.serverName))await slots.remove(conn.serverName)
     throw invalid('受管 MCP 连接不存在。')
    }
    return {authorizationUrl}
   })
  }

  if(endpoint==='mcp-connections/oauth-status'){
   const {conn}=await oauthConnection(payload)
   if(conn.status==='error')return conn.errorMessage?{status:'error',errorMessage:conn.errorMessage}:{status:'error'}
   return {status:conn.status==='connected'?'connected':'pending-oauth'}
  }

  throw invalid('不支持的受管 MCP 连接操作。')
 }

 /**
  * 宿主重启恢复：按已保存的 connected 连接自动重连；pending-oauth 等待负责人重新发起授权，不在此处理。
  * OAuth 连接先看令牌：临近到期先刷新，刷新失败（或令牌缺失）置 error，不阻塞启动。
  * 先把一期 0600 旧凭据文件逐个 serverName 在连接锁内迁入加密存储；凭据存储锁定时只跳过，不改连接状态。
  */
 async function restoreConnections():Promise<void>{
  const known=await knownServerNames(runtimeRoot)
  await migrateLegacyMcpCredentials(runtimeRoot,slots,locked,{
   info:(format,...args)=>ctx.logger?.info?.(format,...args),
   warn:(format,...args)=>ctx.logger?.warn?.(format,...args),
  },known?serverName=>known.has(serverName):()=>true).catch(()=>{ctx.logger?.warn?.('受管 MCP 旧凭据迁移未完成，下次启动重试。')})
  // 上次进程在安装中途退出：记录不能永远停在「正在安装」，改为可重试的安装失败（半装目录由启动清扫处理）
  if((await loadState(runtimeRoot)).connections.some(c=>c.status==='installing'))await updateState(runtimeRoot,state=>{
   for(const c of state.connections)if(c.status==='installing'){c.status='error';c.errorMessage=installFailureMessages['install-failed'];c.errorCode='install-failed';c.updatedAt=new Date().toISOString()}
  })
  const state=await loadState(runtimeRoot)
  let lockWarned=false
  for(const conn of state.connections.filter(c=>c.status==='connected')){
   const entry=getConnectorEntry(conn.catalogId)
   if(!entry)continue
   try{
    if(isSupportedOAuth(entry)){
     const [outcome]=await readTokens(slots,conn.serverName)
      ?await oauth.refreshIfNeeded([{id:conn.id,serverName:conn.serverName,status:conn.status,entry}])
      :[{result:'failed' as const,errorMessage:oauthExpiredMessage}]
     if(outcome?.result==='failed'){
      const errorMessage=outcome.errorMessage??oauthExpiredMessage
      await locked(conn.serverName,async()=>{
       const latest=await loadState(runtimeRoot)
       const current=latest.connections.find(c=>c.id===conn.id)
       if(current)await markOAuthFailed(current,errorMessage)
      })
      continue
     }
    }
    await connectOnce(conn.id,conn.serverName,entry)
   }
   catch(err){
    if(isCredentialStoreLocked(err)){
     if(!lockWarned){lockWarned=true;ctx.logger?.warn?.('凭据存储锁定，受管 MCP 连接暂不恢复（%s）',err.reason)}
     continue
    }
    ctx.logger?.warn?.(`受管 MCP 连接恢复失败 ${conn.serverName}：${connectFailureReason(err)}`)
   }
  }
 }

 /** 定时刷新：只处理 connected 的 OAuth 连接；刷新成功以新 Bearer 重连，失败断开并置 error；暂时性失败与凭据存储锁定留待下一轮（不改状态） */
 async function refreshOAuthConnections():Promise<void>{
  const candidates=(await loadState(runtimeRoot)).connections.flatMap(c=>{
   const entry=c.status==='connected'?getConnectorEntry(c.catalogId):undefined
   return entry&&isSupportedOAuth(entry)?[{id:c.id,serverName:c.serverName,status:c.status,entry}]:[]
  })
  if(candidates.length===0)return
  for(const outcome of await oauth.refreshIfNeeded(candidates)){
   if(outcome.result==='skipped')continue
   const entry=candidates.find(c=>c.id===outcome.connectionId)?.entry
   if(!entry)continue
   try{
    await locked(outcome.serverName,async()=>{
     // 锁内重读：刷新期间连接已删除或已断开则放弃重连
     const state=await loadState(runtimeRoot)
     const conn=state.connections.find(c=>c.id===outcome.connectionId)
     if(!conn||conn.status!=='connected')return
     if(outcome.result==='refreshed')await reconnect(conn,entry)
     else await markOAuthFailed(conn,outcome.errorMessage??oauthExpiredMessage)
    })
   }catch(err){ctx.logger?.warn?.(`受管 MCP 连接令牌刷新后重连失败 ${outcome.serverName}：${connectFailureReason(err)}`)}
  }
 }

 // 回调路由挂在宿主现有 HTTP 服务上（不另开端口），与刷新定时器一起由 dispose 撤回
 const unregisterCallback=webServerOf(ctx)?.register({kind:'exact',path:'/oauth/callback',handler:handleOAuthCallback})
 const unregisterStart=webServerOf(ctx)?.register({kind:'exact',path:'/oauth/start',handler:handleOAuthStart})
 let refreshing:Promise<void>|undefined
 const refreshTimer=setInterval(()=>{
  if(refreshing)return
  refreshing=refreshOAuthConnections()
   .catch(()=>{ctx.logger?.warn?.('受管 MCP OAuth 令牌刷新未完成，下一轮重试。')})
   .finally(()=>{refreshing=undefined})
 },60_000)
 refreshTimer.unref?.()
 function dispose():void{clearInterval(refreshTimer);unregisterCallback?.();unregisterStart?.()}

 /** 当前所有已连接受管 MCP 工具的授权规则（anyArguments=true），用于岗位授权候选与执行面校验 */
 function getManagedMcpToolRules():TaskToolArgumentRule[]{
  const rules:TaskToolArgumentRule[]=[]
  for(const tools of connectedToolsMap.values()){
   for(const tool of tools){
    rules.push({name:tool.fullName,anyArguments:true,allowed:[]})
   }
  }
  return rules
 }

 /** 该连接已建立且目录声明为只读的工具（查 connectedToolsMap，与 liveConnections 同进退）。 */
 function isReadOnlyTool(serverName:string,tool:string):boolean{
  return connectedToolsMap.get(serverName)?.find(item=>item.name===tool)?.readOnly===true
 }

 /** 连接已建立：连接纤程在且工具目录已登记（两者与 `callTool` 的「连接未建立」判据同源）。 */
 function isConnected(serverName:string):boolean{
  return liveConnections.has(serverName)&&connectedToolsMap.has(serverName)
 }

 function writeToolLabel(fullName:string):string|undefined{
  for(const [serverName,tools] of declaredToolsMap){
   const tool=tools.find(item=>item.fullName===fullName)
   if(tool)return tool.readOnly?undefined:`连接 ${serverName} 的写工具 ${tool.name}`
  }
  return undefined
 }

 /**
  * 程序化调用已连接的受管 MCP 只读工具（看板同步用，Spike A 第 8 项 (a)）：直接调 `ctx.tools.get(fullName)` 的工具定义，
  * 不经 `ctx.tools.execute`——不需要 agent、不进任何会话轮次与 token 计量、不触发会话侧观察者。
  * 回包优先取 MCP 官方结构化结果 `structuredContent`（DSH `dsh-mcp-client` 的 `McpResult` 原样透传），是对象即直接用；
  * 否则回落一期做法：取 `content[]` 里 `type==='text'` 的段拼接后 JSON.parse。工具报错、断开、解析失败一律 `teloa/source-unavailable`，原错误不透传。
  * 连接未建立与已断开（含同步源两道门判完、真正调用前恰好断开的窗口）另带 `details:{sourceState:'disconnected'}`，预览据此不说成「调用失败」。
  */
 async function callTool(serverName:string,tool:string,args:Record<string,unknown>,signal:AbortSignal):Promise<unknown>{
  const connected=connectedToolsMap.get(serverName)
  if(!liveConnections.has(serverName)||!connected)throw new WorkError('teloa/source-unavailable',`受管连接 ${serverName} 连接未建立。`,{sourceState:'disconnected'})
  const meta=connected.find(item=>item.name===tool)
  if(!meta)throw new WorkError('teloa/source-unavailable',`受管连接 ${serverName} 没有工具 ${tool}。`)
  if(!meta.readOnly)throw new WorkError('teloa/forbidden',`受管工具 ${meta.fullName} 不是只读工具，看板同步只允许只读工具。`)
  const definition=ctx.tools.get(meta.fullName)
  if(!definition)throw new WorkError('teloa/source-unavailable',`受管连接 ${serverName} 已断开。`,{sourceState:'disconnected'})
  signal.throwIfAborted()
  const callId=`teloa-business-sync-${randomUUID()}`
  // 审计：每次真正发出的调用记一条（server、tool、结果状态），不记参数值与结果内容。
  const audit=(status:'ok'|'failed'|'aborted')=>ctx.logger?.info?.('受管 MCP 只读工具调用：%s %s %s',serverName,tool,status)
  let value:unknown
  try{value=await definition.execute(args,{name:meta.fullName,arguments:args,callId,rootCallId:callId,signal} as unknown as Parameters<typeof definition.execute>[1])}
  catch(error){if(signal.aborted){audit('aborted');throw error}audit('failed');throw new WorkError('teloa/source-unavailable',`受管工具 ${meta.fullName} 调用失败。`)}
  if(isRecord(value)&&isRecord(value.structuredContent)){audit('ok');return value.structuredContent}
  const content=isRecord(value)&&Array.isArray(value.content)?value.content:[]
  const text=content.filter(item=>isRecord(item)&&item.type==='text'&&typeof item.text==='string').map(item=>(item as {text:string}).text).join('')
  try{const parsed=JSON.parse(text) as unknown;audit('ok');return parsed}catch{audit('failed');throw new WorkError('teloa/source-unavailable',`受管工具 ${meta.fullName} 返回的不是 JSON。`)}
 }

 return {handler,restoreConnections,getManagedMcpToolRules,refreshOAuthConnections,dispose,callTool,isReadOnlyTool,isConnected,writeToolLabel}
}

/**
 * 受管 MCP 写工具逐次确认：目录声明 readOnly:false 的工具在个人会话与执行态都先走 DSH 官方审批（ask），
 * 岗位授权与目录声明都不代替逐次确认。先让链上其余闸判定，拒绝原样返回；审批策略为 never 时由官方审批服务直接拒绝。
 */
export function registerManagedMcpWriteApproval(ctx:Context,writeToolLabel:(fullName:string)=>string|undefined){
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  const label=writeToolLabel(exec.name)
  if(label===undefined)return next()
  const decision=await next()
  if(decision.kind==='deny')return decision
  const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
  return {kind:'ask',reason:`${prior}确认调用${label}？它会改动外部服务的数据；员工授权不会代替逐次确认。`}
 })
}
