import {createHash,timingSafeEqual} from 'node:crypto'
import {spawn} from 'node:child_process'
import {lstat,mkdir,mkdtemp,readFile,rm,stat} from 'node:fs/promises'
import {isAbsolute,join,resolve,sep} from 'node:path'
import {tmpdir} from 'node:os'
import {
 pendingListUnreadable,
 readJsonFile,
 readPendingPlugins,
 rewriteProfileBundlesLocked,
 suppressPendingBundles,
 suppressPendingBundlesLocked,
 withProfileLock,
 writePendingPlugins,
 writeProfileManifest,
} from './pending-plugins.ts'
import {
 marketPluginPackageRef,
 readMarketPluginInstallPreview,
 readMarketPluginRegistrySource,
 type MarketPluginInstallObservation,
 type MarketPluginInstallPreview,
 type MarketPluginInstallReceipt,
 type MarketPluginPermissionSummary,
 marketPluginPermissionDescription,
 sameMarketPluginPermissions,
 type MarketPluginRegistrySource,
} from '@teloa/contract'

export type DshCommandInvocation={
 command:string
 args:string[]
 cwd:string
 env:NodeJS.ProcessEnv
 timeoutMs:number
 maxOutputBytes:number
 signal?:AbortSignal
}
export type DshCommandResult={status:'exited'|'timed-out'|'aborted'|'output-limit';exitCode?:number;output:string}
export type DshCommandRunner=(invocation:DshCommandInvocation)=>Promise<DshCommandResult>

type FetchPort=(input:string|URL|Request,init?:RequestInit)=>Promise<Response>
type AdapterOptions={
 dshHome:string
 profile:string
 registry:string
 fetch?:FetchPort
 run?:DshCommandRunner
 dshCommand?:string
 activePluginRefs:ReadonlySet<string>
 signal?:AbortSignal
 timeoutMs?:number
 maxOutputBytes?:number
 maxRegistryBytes?:number
 maxTarballBytes?:number
 /** 预览缓存与审查安装限流按本人分本；省略时按单机本人处理。 */
 ownerId?:string
}

type PackageManifest={name:string;version:string;dsh:Record<string,unknown>}
const DEFAULT_TIMEOUT=120_000,DEFAULT_OUTPUT=64*1024,DEFAULT_METADATA=1024*1024,DEFAULT_TARBALL=64*1024*1024
const genericFailure=(status:'absent'|'unknown',message:string):MarketPluginInstallObservation=>({schema:'teloa.market-plugin-install-observation/v1',status,failure:{code:status==='absent'?'observation-mismatch':'observation-unavailable',message,retryable:true}})
const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)
const nonBlank=(value:unknown,max=500):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&value===value.trim()

function bounded(value:string,max:number):string{
 const bytes=Buffer.from(value.trim()||'DSH 扩展安装未返回详细信息。')
 return bytes.byteLength<=max?bytes.toString():bytes.subarray(0,Math.max(1,max)).toString().replace(/\uFFFD+$/,'')
}

function combinedSignal(signal:AbortSignal|undefined,timeoutMs:number):AbortSignal{
 const timeout=AbortSignal.timeout(timeoutMs)
 return signal?AbortSignal.any([signal,timeout]):timeout
}

async function readResponse(response:Response,maxBytes:number):Promise<Buffer>{
 if(!response.ok)throw Error('registry-http-'+response.status)
 const declared=response.headers.get('content-length')
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>maxBytes))throw Error('registry-response-too-large')
 if(!response.body){const bytes=Buffer.from(await response.arrayBuffer());if(bytes.byteLength>maxBytes)throw Error('registry-response-too-large');return bytes}
 const reader=response.body.getReader(),chunks:Buffer[]=[]
 let total=0
 try{
  while(true){
   const next=await reader.read()
   if(next.done)break
   total+=next.value.byteLength
   if(total>maxBytes)throw Error('registry-response-too-large')
   chunks.push(Buffer.from(next.value))
  }
 }finally{reader.releaseLock()}
 return Buffer.concat(chunks,total)
}

/** registry 声明的 integrity 与实际字节逐字节比对；摘要比较用定时安全比较。 */
export function assertArtifactIntegrity(bytes:Buffer,value:string):void{
 const match=/^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/.exec(value)
 if(!match)throw Error('registry-integrity-invalid')
 const actual=createHash(match[1]!).update(bytes).digest(),expected=Buffer.from(match[2]!,'base64')
 if(actual.byteLength!==expected.byteLength||!timingSafeEqual(actual,expected))throw Error('registry-integrity-mismatch')
}

function manifestDsh(value:unknown):Record<string,unknown>{
 if(value===undefined)return {}
 if(!record(value))throw Error('registry-dsh-manifest-invalid')
 return value
}

function packageManifest(value:unknown,source:MarketPluginRegistrySource):PackageManifest{
 if(!record(value)||value.name!==source.packageName||value.version!==source.version)throw Error('registry-package-identity-mismatch')
 return {name:source.packageName,version:source.version,dsh:manifestDsh(value.dsh)}
}

/**
 * 候选包组合补丁的逐行结论：`id` 是被改动或新增的组合树行，`name` 是该行挂载的模块。
 * 只有解析出这份清单，界面才能如实写出“该插件会改动 X”，安装前也才谈得上拒绝。
 */
export type BundlePatchChange={id:string;insert:boolean;name?:string}
/** `verifiable` 为假表示补丁用了无法逐行核验的写法；此时既不列改动也一律拒绝。 */
export type BundlePatchReview={verifiable:boolean;changes:BundlePatchChange[];denied:string[]}

/**
 * 补丁正文一旦改动这些行，部署安全钉就在下次启动时被整段掀翻：
 * 遥测改回上传、沙箱放行全盘、审批判成 never、模型可见面换成 run_code、
 * 或者顶掉 Teloa 自己的通道与插件行。`sandbox` 是执行后端行，`ptc-runtime` 是 run_code 工具面的运行时前提，
 * `connection` 是 `/teloa` RPC 的挂载点。
 *
 * 2026-09-16 安全审查第二遍补齐**预设平面与委派平面**（此前只覆盖宿主平面的那几行）：
 * - `agent-preset-registry` 决定默认声明，`preset-*` 提供官方运行组合 —— 模型可见工具面的真正所在。
 *   把 `includeUserRoot` 改回 true 或加一个根，就等于绕过 Teloa 自带的只读预设；
 * - `subagent`/`subagent-spawn-in-process`/`subagent-fork-in-process` 是子 Agent 注册表与两个执行后端；
 * - `agent-default-model`/`llm-deepseek` 决定模型路由，改掉等于把会话正文换一个出口发出去；
 * - `tool-workflow`/`tool-ralph`/`workflow-ptc`/`tool-subagent*` 是编排与委派的工具入口与引擎；
 * - `tool-bash`/`tool-pwsh`/`tool-fs`/`tool-web` 是宿主平面上执行与外发的工具行。
 *
 * 复审第二遍再补一批：都用 `--dump-config` 核过确实存在于生效组合树上，覆盖执行后端、
 * 联网、文件系统、口令与模型接线、系统提示、会话落盘与外发这几类此前没点到名的行——
 * 逐项都是"改了就能让第三方补丁绕开某道部署默认值"的候选，没有改动它们的正当理由：
 * - `bash-sandbox`/`pwsh-sandbox`/`subprocess`/`fs-sandbox` 是 `tool-bash`/`tool-pwsh`/`tool-fs`
 *   实际落地执行与文件系统操作的沙箱执行器行；
 * - `web`/`web-search-deepseek`/`web-fetch-http` 是 `tool-web` 背后的联网服务与两个执行后端；
 * - `fs-observation-policy` 是文件系统只读观测的口径行；
 * - `credentials`/`llm`/`llm-retry`/`api-remotes`/`deepseek-llm-api-extensions` 是口令存取与模型
 *   请求/重试/远程网关的接线，改掉即可把会话正文换个出口、或换一套口令来源；
 * - `system-prompt`/`agent-instructions` 是系统提示与 Agent 级指令的拼装行；
 * - `webserver`/`web-runtime` 是 `/teloa` 通道赖以注册的 HTTP 服务与运行时；
 * - `mcp-resources` 是上游默认放行的三个共享 MCP 资源工具的注册行，`role-tool-grants.ts` 的
 *   拒绝闸管的是执行面，这行管的是它还在不在组合树上；
 * - `session-persistence-jsonl`/`session-log-download` 是会话落盘格式与导出通道；
 * - `tool-subagent-list-agents` 补齐 `tool-subagent*` 家族里漏掉的这一个列举类工具行。
 * 这些行在 Teloa 的组合里都已按安全方向定好取值，第三方补丁没有改动它们的正当理由。
 *
 * 复审二再补一批（同样逐项用 `--dump-config` 核过确实存在于生效组合树上）：
 * - `shell-env` 是 `tool-bash`/`tool-pwsh` 执行时的环境变量来源——预设正文对模型开着
 *   `tool-bash`，改这一行能在 `approval: ask` 审批文案完全看不出来的情况下注入
 *   `PATH`/`NODE_OPTIONS` 之类的变量，是这批里最该先补的一条；
 * - `session-log-deepseek` 是会话日志的另一条导出通道，与已拒的 `session-log-download` 同类；
 * - `llm-pi-ai` 是第二模型提供方接线，与已拒的 `llm-deepseek`/`llm`/`llm-retry`/`api-remotes` 同类；
 * - `open-in-app` 是宿主侧拉起本机程序的入口；
 * - `tool-skill`/`skill-filesystem`/`tool-jobs`/`tool-fs-search` 是与已拒的
 *   `tool-bash`/`tool-pwsh`/`tool-fs`/`tool-web` 同属工具面、此前漏掉的几个工具与执行器行；
 * - `web-startup` 与已拒的 `webserver`/`web-runtime` 同类，都是 `/teloa` 通道赖以注册的服务；
 * - `session-query-sqlite`/`client-hmr`/`ui-layout`/`ui-sidebar`/`ui-settings-general` 是
 *   Teloa 自己在 `cordis.patch.yml` 打了补丁、却此前不在这张清单里的五行——第三方补丁本可以
 *   静默顶掉它们（比如把 `session-query-sqlite.config.path` 换到 `DSH_HOME` 之外）。
 * 下面 `assertOwnPatchRowsDenied`（`tests/DSH组合安全钉.test.js` 调用）把这条道理钉成不变式：
 * Teloa 自己在 `cordis.patch.yml` 里打了补丁的每一个非 `teloa-` 前缀 id，都必须在这张清单里——
 * 以后新钉一行忘了同步这张清单，那条测试会先红。
 */
export const deniedPatchRowIds=new Set([
 // DSH 0.2 新增产品遥测与账号模型路由，沿用既有外发与模型接线保护。
 'session-telemetry-otel','desktop-product-telemetry','product-analytics','otel','llm-deepseek-account','sandbox-policy','sandbox','approval','permission','tools','ptc-runtime','connection',
 'agent-presets','agent-preset-registry','preset-standard','preset-ptc','preset-minimal','preset-cordis','subagent','subagent-spawn-in-process','subagent-fork-in-process','agent-default-model','llm-deepseek',
 'tool-workflow','tool-ralph','workflow-ptc','tool-subagent','tool-subagent-fork','tool-subagent-control',
 'tool-bash','tool-pwsh','tool-fs','tool-web',
 'bash-sandbox','pwsh-sandbox','subprocess','fs-sandbox','fs-observation-policy',
 'web','web-search-deepseek','web-fetch-http',
 'credentials','attachment-local','llm','llm-retry','api-remotes','deepseek-llm-api-extensions',
 'system-prompt','agent-instructions','webserver','web-runtime','mcp-resources',
 'session-persistence-jsonl','session-log-download','tool-subagent-list-agents',
 'shell-env','session-log-deepseek','llm-pi-ai','open-in-app',
 'tool-skill','skill-filesystem','tool-jobs','tool-fs-search','web-startup',
 'session-query-sqlite','hmr','client-hmr','ui-layout','ui-sidebar','ui-settings-general','ui-settings-plugins','plugin-manager',
])
/** 任何 `dsh-mcp-client` 行都能带一条 `transport: stdio` 的任意命令，宿主启动即执行。 */
const deniedPatchRowName='@deepseek-ai/dsh-mcp-client'
// 行 id 收紧到"字母开头的普通标识符"：数字型（1/0755/1e3）与带 `:`、`/` 的写法一律不接受。
const patchRowIdPattern=/^[A-Za-z][A-Za-z0-9._-]{0,63}$/
const patchRowNamePattern=/^[@A-Za-z0-9][A-Za-z0-9._/@-]{0,213}$/
const MAX_PATCH_BYTES=256*1024,MAX_PATCH_ROWS=40,MAX_PATCH_DEPTH=8
/** 审查用的一次性 profile：装在临时 DSH_HOME 里，审完就整个删掉。 */
const STAGE_PROFILE='teloa-review'
/** 唯一允许的插件来源；市场安装不接受任意 registry。 */
const ALLOWED_REGISTRIES=['https://registry.npmjs.org']
const STAGE_CACHE_MS=10*60_000,STAGE_INTERVAL_MS=60_000,ARTIFACT_CACHE_MS=10*60_000

/**
 * 带 TTL 的小缓存。键一律以本人身份开头：一个人的审查结果与限流窗口不该被另一个人复用，
 * 否则缓存本身就成了跨本人的旁路（既能省掉别人的限流，也能泄露"谁预览过哪个包"）。
 * 每次写入顺手清掉过期项，表不会随预览次数无上限地长。
 */
class ExpiringCache<T>{
 private readonly entries=new Map<string,{value:T;until:number}>()
 get(key:string):T|undefined{
  const found=this.entries.get(key)
  if(!found)return undefined
  if(found.until<=Date.now()){this.entries.delete(key);return undefined}
  return found.value
 }
 set(key:string,value:T,ttlMs:number):void{
  this.prune()
  this.entries.set(key,{value,until:Date.now()+ttlMs})
 }
 prune():void{
  const now=Date.now()
  for(const [existing,item] of this.entries)if(item.until<=now)this.entries.delete(existing)
 }
}
/** 按 `本人|包@版本|integrity` 缓存审查结果：同一次安装只真装一遍审查用的包。 */
const reviewCache=new ExpiringCache<InstalledBundle>()
/** 按 `本人|包@版本|integrity` 记住"这份工件的字节已经按 integrity 校过"：同一工件不重复下载。 */
const artifactCache=new ExpiringCache<true>()
/** 同一本人、同一包名两次审查安装之间的最小间隔；过期窗口随写入清理。 */
const stageAttempts=new ExpiringCache<true>()

const unverifiableCode='registry-bundle-patch-unverifiable'
const unverifiablePatch=()=>Error(unverifiableCode)

type PatchNode=string|PatchNode[]|{[key:string]:PatchNode}
type PatchLine={indent:number;rest:string}

/**
 * 受限 YAML：只认块序列、块映射与纯量。引号、标签（含会被 Loader 求值的 `!!js`）、
 * 锚点、别名、流式集合、块标量、制表符与多文档一律拒绝——看不懂就不能声称核验过，
 * 而一个 `!!js` 表达式本身就是宿主内的任意代码执行。
 */
function parsePatchDocument(text:string):PatchNode[]{
 if(text.includes('\t')||text.includes('\0'))throw unverifiablePatch()
 const lines:PatchLine[]=[]
 for(const raw of text.replace(/\r\n?/g,'\n').split('\n')){
  const stripped=raw.replace(/(^|\s)#.*$/,'$1').replace(/\s+$/,'')
  if(!stripped.trim())continue
  if(stripped==='---'||stripped==='...')throw unverifiablePatch()
  const indent=stripped.length-stripped.trimStart().length
  lines.push({indent,rest:stripped.slice(indent)})
 }
 // 空文件与 `[]` 都是"这个 bundle 不打补丁"的常规写法。
 if(!lines.length)return []
 if(lines.length===1&&lines[0]!.indent===0&&lines[0]!.rest==='[]')return []
 const [value,next]=parsePatchBlock(lines,0,0)
 if(next!==lines.length||!Array.isArray(value))throw unverifiablePatch()
 return value
}

function parsePatchScalar(value:string):string{
 const trimmed=value.trim()
 if(!trimmed.length||trimmed.length>500)throw unverifiablePatch()
 // 单引号纯量只有 '' 一种转义，逐字还原即可；落单的引号说明这不是一个完整纯量。
 if(trimmed.startsWith("'")){
  const inner=trimmed.slice(1,-1)
  if(trimmed.length<2||!trimmed.endsWith("'")||inner.replace(/''/g,'').includes("'"))throw unverifiablePatch()
  return inner.replace(/''/g,"'")
 }
 // 双引号纯量允许反斜杠转义，`sandbox\x2Dpolicy` 能把拒绝清单绕过去，所以带反斜杠一律拒绝。
 if(trimmed.startsWith('"')){
  const inner=trimmed.slice(1,-1)
  if(trimmed.length<2||!trimmed.endsWith('"')||inner.includes('\\')||inner.includes('"'))throw unverifiablePatch()
  return inner
 }
 // 其余保留字符（标签、锚点、别名、流式集合、块标量、指令）都不在可核验子集里。
 if(/["'#&*!|>%@`{}[\],\\]/.test(trimmed))throw unverifiablePatch()
 return trimmed
}

function parsePatchBlock(lines:PatchLine[],index:number,indent:number):[PatchNode,number]{
 const first=lines[index]
 if(!first||first.indent!==indent)throw unverifiablePatch()
 return first.rest.startsWith('- ')?parsePatchSequence(lines,index,indent):parsePatchMapping(lines,index,indent)
}

function parsePatchSequence(lines:PatchLine[],index:number,indent:number):[PatchNode[],number]{
 const items:PatchNode[]=[]
 let cursor=index
 while(cursor<lines.length&&lines[cursor]!.indent===indent&&lines[cursor]!.rest.startsWith('- ')){
  const rest=lines[cursor]!.rest.slice(2),extra=rest.length-rest.trimStart().length,inner=indent+2+extra
  lines[cursor]={indent:inner,rest:rest.slice(extra)}
  const [item,next]=parsePatchBlock(lines,cursor,inner)
  items.push(item);cursor=next
 }
 if(!items.length)throw unverifiablePatch()
 return [items,cursor]
}

function parsePatchMapping(lines:PatchLine[],index:number,indent:number):[Record<string,PatchNode>,number]{
 const map:Record<string,PatchNode>={}
 let cursor=index
 while(cursor<lines.length&&lines[cursor]!.indent===indent&&!lines[cursor]!.rest.startsWith('- ')){
  const match=/^([A-Za-z0-9_][A-Za-z0-9_.-]{0,63}):(?:\s+(\S.*))?$/.exec(lines[cursor]!.rest)
  if(!match)throw unverifiablePatch()
  const key=match[1]!
  if(key==='__proto__'||key==='constructor'||key==='prototype'||Object.prototype.hasOwnProperty.call(map,key))throw unverifiablePatch()
  cursor++
  if(match[2]!==undefined){map[key]=parsePatchScalar(match[2]);continue}
  if(cursor<lines.length&&lines[cursor]!.indent>indent){
   const [value,next]=parsePatchBlock(lines,cursor,lines[cursor]!.indent)
   map[key]=value;cursor=next;continue
  }
  map[key]=''
 }
 if(!Object.keys(map).length)throw unverifiablePatch()
 return [map,cursor]
}

/** YAML 会把这些裸词解析成布尔/空值而不是字符串；当作行 id 就不再是我们读到的那个东西。 */
const yamlNonStringWords=/^(?:true|false|yes|no|on|off|null|~)$/i

function patchRowId(value:unknown):string{
 if(typeof value!=='string'||!patchRowIdPattern.test(value)||yamlNonStringWords.test(value))throw unverifiablePatch()
 return value
}

function patchRowName(value:unknown):string{
 if(typeof value!=='string'||!patchRowNamePattern.test(value)||yamlNonStringWords.test(value))throw unverifiablePatch()
 return value
}

/**
 * 解析补丁正文，列出它改动或新增的每一行，并挑出命中拒绝清单的那些。
 * 写法超出可核验子集时不抛给调用方，而是返回 `verifiable:false`：
 * 预览照旧出得来，本人能看到"无法逐行核验"，安装侧再据此拒绝。
 */
export function reviewBundlePatch(text:string):BundlePatchReview{
 try{return verifiedBundlePatch(text)}
 catch(error){
  if(error instanceof Error&&error.message===unverifiableCode)return {verifiable:false,changes:[],denied:[]}
  throw error
 }
}

/**
 * 收下一行，然后按 `group` 语义递归它的子条目表。
 *
 * cordis 的条目树是嵌套的：`applyEntryPatches` 的 `buildMap` 在
 * `group && Array.isArray(config)` 时把 `config` 当成子条目表继续索引，
 * Loader 的 `Group` 也把它挂进同一棵 store。只看顶层的 `id`/`name` 会漏掉
 * `- insert: [{id: x, group: true, config: [{name: '@deepseek-ai/dsh-mcp-client', …}]}]`
 * 这种写法——子条目一样能插原生命令行，也一样能用 `id: sandbox-policy` 顶掉安全钉。
 */
function collectPatchRows(entry:Record<string,unknown>,insert:boolean,depth:number,out:BundlePatchChange[]):void{
 if(depth>MAX_PATCH_DEPTH||out.length>=MAX_PATCH_ROWS)throw unverifiablePatch()
 out.push({id:patchRowId(entry.id),insert,...(entry.name===undefined?{}:{name:patchRowName(entry.name)})})
 const config=entry.config
 // 声明成 group 却没有条目表，或者条目表不是数组：归不到具体行上，按看不懂处理。
 if(entry.group!==undefined&&config!==undefined&&!Array.isArray(config))throw unverifiablePatch()
 if(!Array.isArray(config))return
 if(!config.length||config.length>MAX_PATCH_ROWS)throw unverifiablePatch()
 for(const child of config){
  if(!record(child))throw unverifiablePatch()
  collectPatchRows(child,true,depth+1,out)
 }
}

function verifiedBundlePatch(text:string):BundlePatchReview{
 const document=parsePatchDocument(text)
 if(document.length>MAX_PATCH_ROWS)throw unverifiablePatch()
 const changes:BundlePatchChange[]=[]
 for(const item of document){
  if(!record(item))throw unverifiablePatch()
  if(item.insert!==undefined){
   // `insert` 与定位改动混写时无法逐项归因，按看不懂处理。
   if(Object.keys(item).length!==1||!Array.isArray(item.insert)||!item.insert.length||item.insert.length>MAX_PATCH_ROWS)throw unverifiablePatch()
   for(const entry of item.insert){
    if(!record(entry))throw unverifiablePatch()
    collectPatchRows(entry,true,0,changes)
   }
   continue
  }
  // 定位改动同样要递归：目标行是 group 时，`config` 整块替换就是一张新的子条目表。
  collectPatchRows(item,false,0,changes)
 }
 if(changes.length>MAX_PATCH_ROWS)throw unverifiablePatch()
 const denied=changes.filter(change=>deniedPatchRowIds.has(change.id)||change.id.startsWith('teloa-')||change.name?.toLowerCase()===deniedPatchRowName)
 return {verifiable:true,changes,denied:[...new Set(denied.map(change=>change.id))]}
}

/** 无补丁或只做新增且不命中拒绝清单才算已核验；命中或核验不了即拒绝，其余保持未核验。 */
function trustStatus(review:BundlePatchReview):'verified'|'unverified'|'rejected'{
 if(!review.verifiable||review.denied.length)return 'rejected'
 return review.changes.every(change=>change.insert)?'verified':'unverified'
}

/** 说明文字由 id 决定（契约里的同一份函数），界面与比对都以 id 为准。 */
function permission(id:string):MarketPluginPermissionSummary['permissions'][number]{return {id,description:marketPluginPermissionDescription(id)!,required:true}}

function permissionSummary(dsh:Record<string,unknown>,review:BundlePatchReview):MarketPluginPermissionSummary{
 const permissions:MarketPluginPermissionSummary['permissions']=[]
 if(dsh.bundle!==undefined){
  if(!record(dsh.bundle)||!nonBlank(dsh.bundle.patch))throw Error('registry-bundle-manifest-invalid')
  permissions.push(permission('dsh.bundle'))
  // 逐行披露：界面必须把"会改动哪一行"写出来，而不是只说"将加载配置层"。
  if(!review.verifiable)permissions.push(permission('dsh.bundle.unverifiable'))
  for(const change of review.changes)permissions.push(change.insert
   ?permission('dsh.bundle.insert:'+change.id)
   :permission('dsh.bundle.patch:'+change.id))
 }
 if(dsh.client!==undefined){
  if(!record(dsh.client)||!nonBlank(dsh.client.platform,100)||!/^[A-Za-z0-9._-]+$/.test(dsh.client.platform))throw Error('registry-client-manifest-invalid')
  permissions.push(permission('dsh.client:'+dsh.client.platform))
 }
 if(dsh.configTrees!==undefined){
  if(!Array.isArray(dsh.configTrees)||dsh.configTrees.length>98)throw Error('registry-config-tree-manifest-invalid')
  for(const value of dsh.configTrees){
   if(!record(value)||!nonBlank(value.mount,100)||!nonBlank(value.path)||!/^[A-Za-z0-9._/-]+$/.test(value.mount))throw Error('registry-config-tree-manifest-invalid')
   permissions.push(permission('dsh.config-tree:'+value.mount))
  }
 }
 permissions.sort((a,b)=>a.id.localeCompare(b.id))
 if(new Set(permissions.map(item=>item.id)).size!==permissions.length)throw Error('registry-permission-duplicate')
 // 合同上限 100 条；越界就没法把能力摘要如实呈现给本人，按不可核验拒绝。
 if(permissions.length>100)throw Error('registry-permission-overflow')
 return {permissions}
}

/**
 * 能力摘要比对：只比每项的 id 与 required（`sameMarketPluginPermissions`）。说明文字由 id 决定、
 * 只用于展示；改版前存进安装记录的旧说明（「该插件会新增…」）不能因此被判成权限变化。
 * 安装后与启用前都要比：补丁摘要只覆盖组合补丁正文，`dsh.client` / `dsh.configTrees`
 * 这些同样会加载代码的声明不在其中，装出来的那份被换掉时只有这道比对拦得住。
 */
function samePermissionSummary(left:MarketPluginPermissionSummary,right:MarketPluginPermissionSummary):boolean{
 return sameMarketPluginPermissions(left,right)
}

/**
 * 发布者：预览里最该被本人看清的一行事实（"这段会进宿主的代码是谁发的"）。
 *
 * 复审曾提议"只接受 @scope 包"，未采纳——社区常用的插件多是 unscoped，那条规则挡不住坏人
 * 却把正常插件全挡在外面。改为如实、醒目地把发布者带出来。它由 registry 提供、由发布者控制，
 * 所以先把它收进"可安全呈现"的形状：控制字符、换行与双向文本控制符一律不接受，
 * 越界就退回包名——宁可显示得保守，也不让一个精心构造的名字在界面上冒充成别的东西。
 * 这个值不进 `permissionSummary`：那份摘要要在装后与启用前按权限 id 与 required 比对，而磁盘上读不到发布者。
 */
function publisher(value:Record<string,unknown>,fallback:string):string{
 const npmUser=record(value._npmUser)?value._npmUser.name:undefined
 const author=typeof value.author==='string'?value.author:record(value.author)?value.author.name:undefined
 for(const candidate of [npmUser,value.publisher,author])
  if(nonBlank(candidate,200)&&!/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(candidate))return candidate
 return fallback
}

function childKill(pid:number|undefined):void{
 if(pid===undefined)return
 try{if(process.platform==='win32')process.kill(pid,'SIGTERM');else process.kill(-pid,'SIGTERM')}catch{}
}

/** 无 shell 执行并限制生命周期与可保留输出；被终止后结果必须按未知处理。 */
export function runDshCommand(invocation:DshCommandInvocation):Promise<DshCommandResult>{
 return new Promise(resolveResult=>{
  if(invocation.signal?.aborted){resolveResult({status:'aborted',output:''});return}
  const child=spawn(invocation.command,invocation.args,{cwd:invocation.cwd,env:invocation.env,stdio:['ignore','pipe','pipe'],shell:false,detached:process.platform!=='win32'})
  let output=Buffer.alloc(0),settled=false,forced:DshCommandResult['status']|undefined
  const finish=(result:DshCommandResult)=>{if(settled)return;settled=true;clearTimeout(timer);invocation.signal?.removeEventListener('abort',abort);resolveResult(result)}
  const stop=(status:Exclude<DshCommandResult['status'],'exited'>)=>{if(settled||forced)return;forced=status;childKill(child.pid);setTimeout(()=>childKill(child.pid),500).unref()}
  const append=(chunk:Buffer|string)=>{
   const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk)
   const remaining=Math.max(0,invocation.maxOutputBytes-output.byteLength)
   if(remaining)output=Buffer.concat([output,bytes.subarray(0,remaining)])
   if(bytes.byteLength>remaining)stop('output-limit')
  }
  child.stdout?.on('data',append);child.stderr?.on('data',append)
  child.once('error',error=>finish({status:forced??'exited',...(forced?{}:{exitCode:127}),output:bounded(output.toString()+'\n'+String(error),invocation.maxOutputBytes)}))
  child.once('close',code=>finish({status:forced??'exited',...(forced?{}:{exitCode:code??1}),output:bounded(output.toString(),invocation.maxOutputBytes)}))
  const timer=setTimeout(()=>stop('timed-out'),invocation.timeoutMs);timer.unref()
  const abort=()=>stop('aborted')
  invocation.signal?.addEventListener('abort',abort,{once:true})
 })
}

function safePatch(root:string,value:unknown):string|undefined{
 if(!nonBlank(value)||isAbsolute(value))return undefined
 const target=resolve(root,value),prefix=root.endsWith(sep)?root:root+sep
 return target.startsWith(prefix)?target:undefined
}

type InstalledBundle={dsh:Record<string,unknown>;review:BundlePatchReview;bundleHash:string}

/**
 * 待启用清单与 profile 清单的读写收在 `./pending-plugins.ts`：
 * 安装适配器、启动器与 `pnpm setup:dsh` 共用同一份压制函数、同一把 profile 级互斥与同一套原子写。
 * 这里只按包引用再导出读取入口，方便调用方与测试直接核对事实。
 */
export {readPendingPlugins} from './pending-plugins.ts'

/**
 * 安装后核对失败时的回滚：摘 bundles、摘 dependencies、删包目录、清掉待启用记录。
 * 调用方必须已经持有 `withProfileLock`（`install()` 全程都在锁里）。
 */
async function rollbackInstallLocked(profileDir:string,source:MarketPluginRegistrySource,packageRef:string):Promise<void>{
 await rewriteProfileBundlesLocked(profileDir,bundles=>bundles.filter(name=>name!==source.packageName)).catch(()=>{})
 const manifest=await readJsonFile(join(profileDir,'package.json')).catch(()=>undefined)
 if(manifest&&record(manifest.dependencies)&&manifest.dependencies[source.packageName]!==undefined){
  const dependencies={...manifest.dependencies}
  delete dependencies[source.packageName]
  await writeProfileManifest(profileDir,{...manifest,dependencies})
 }
 await rm(join(profileDir,'node_modules',...source.packageName.split('/')),{recursive:true,force:true}).catch(()=>{})
 const pending=await readPendingPlugins(profileDir).catch(()=>undefined)
 if(pending&&packageRef in pending){delete pending[packageRef];await writePendingPlugins(profileDir,pending).catch(()=>{})}
 // 回滚本身也是一次 profile 清单改写：把还在待启用的别的插件再压一次，别让这条路径成为缺口。
 await suppressPendingBundlesLocked(profileDir).catch(()=>{})
}

export class DshPluginInstallAdapter{
 private readonly options:Required<Pick<AdapterOptions,'dshHome'|'profile'|'registry'|'dshCommand'|'timeoutMs'|'maxOutputBytes'|'maxRegistryBytes'|'maxTarballBytes'|'activePluginRefs'|'ownerId'>>&{signal:AbortSignal|undefined}
 private readonly fetcher:FetchPort
 private readonly runner:DshCommandRunner
 constructor(options:AdapterOptions){
  this.options={dshHome:resolve(options.dshHome),profile:options.profile,registry:options.registry.replace(/\/+$/,''),dshCommand:options.dshCommand??'dsh',timeoutMs:options.timeoutMs??DEFAULT_TIMEOUT,maxOutputBytes:options.maxOutputBytes??DEFAULT_OUTPUT,maxRegistryBytes:options.maxRegistryBytes??DEFAULT_METADATA,maxTarballBytes:options.maxTarballBytes??DEFAULT_TARBALL,activePluginRefs:options.activePluginRefs,ownerId:options.ownerId??'local',signal:options.signal}
  this.fetcher=options.fetch??fetch
  this.runner=options.run??runDshCommand
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/.test(this.options.profile))throw Error('invalid-dsh-profile')
  if(!ALLOWED_REGISTRIES.includes(this.options.registry))throw Error('invalid-plugin-registry')
 }

 private get profileDir():string{return join(this.options.dshHome,'profiles',this.options.profile)}
 /** 缓存与限流一律按本人分本：一个人的审查结果与限流窗口不被另一个人复用。 */
 private cacheKey(...parts:string[]):string{return [this.options.ownerId,...parts].join('|')}

 private async registryBytes(url:string,max:number):Promise<Buffer>{return readResponse(await this.fetcher(url,{headers:{accept:'application/json'},redirect:'error',signal:combinedSignal(this.options.signal,this.options.timeoutMs)}),max)}

 /** 只取 registry 元数据：包身份、`dsh` 声明、`dist.integrity` 与 tarball 来源，不下载字节。 */
 private async metadata(source:MarketPluginRegistrySource):Promise<{metadata:Record<string,unknown>;dsh:Record<string,unknown>;integrity:string;tarball:string}>{
  const encoded=source.packageName.startsWith('@')?source.packageName.replace('/','%2F'):encodeURIComponent(source.packageName)
  const raw=await this.registryBytes(this.options.registry+'/'+encoded+'/'+encodeURIComponent(source.version),this.options.maxRegistryBytes)
  let metadata:Record<string,unknown>
  try{const parsed=JSON.parse(raw.toString('utf8'));if(!record(parsed))throw Error();metadata=parsed}catch{throw Error('registry-metadata-invalid')}
  const manifest=packageManifest(metadata,source),dist=metadata.dist
  if(!record(manifest.dsh.bundle))throw Error('registry-package-declares-no-dsh-bundle')
  if(!record(dist)||!nonBlank(dist.integrity,1000)||!nonBlank(dist.tarball,2000))throw Error('registry-dist-invalid')
  const tarballUrl=new URL(dist.tarball),registryUrl=new URL(this.options.registry)
  if(tarballUrl.protocol!=='https:'||tarballUrl.origin!==registryUrl.origin)throw Error('registry-tarball-origin-invalid')
  return {metadata,dsh:manifest.dsh,integrity:dist.integrity,tarball:tarballUrl.toString()}
 }

 /**
  * 元数据 + 按 `dist.integrity` 逐字节校验一次 tarball：pnpm 之外的一道独立证据。
  *
  * 字节校验按 `本人|包@版本|integrity` 去重：同一份工件在 TTL 内只下载一次。
  * 声明的 integrity 一变，键就变，必然重新下载重新校 —— 缓存省的是重复下载，不是这道证据本身。
  * 安装之后的复核走 `metadata()`：那一步只需要确认 registry 没换过工件，比对 integrity 字符串就够，
  * 真正装上的字节由 pnpm 按同一个 integrity 校，再下载 64MB 只是重复劳动。
  */
 private async artifact(source:MarketPluginRegistrySource):Promise<{metadata:Record<string,unknown>;dsh:Record<string,unknown>;integrity:string}>{
  const found=await this.metadata(source)
  const key=this.cacheKey(marketPluginPackageRef(source),found.integrity)
  if(!artifactCache.get(key)){
   assertArtifactIntegrity(await this.registryBytes(found.tarball,this.options.maxTarballBytes),found.integrity)
   artifactCache.set(key,true,ARTIFACT_CACHE_MS)
  }
  return {metadata:found.metadata,dsh:found.dsh,integrity:found.integrity}
 }

 /**
  * 把候选包装进一次性的临时 profile，交给回调审查磁盘上的实际结果，随后整棵删掉。
  *
  * 之所以不再自己解 tar：pnpm 的解包语义与任何手写解析器都会有出入
  * （条目名截断到首个 `/` 之后、同名后者覆盖前者、PAX/GNU 长名改写路径、硬链接当普通文件），
  * 审过的就不是装上的。改成"用同一个 `dsh plugin add` 装一遍再审磁盘"，
  * 审查对象与正式 profile 里最终落盘的内容由同一套解包代码产生。
  */
 private async staged(source:MarketPluginRegistrySource):Promise<InstalledBundle>{
  const home=await mkdtemp(join(tmpdir(),'teloa-plugin-review-'))
  try{
   const result=await this.run(home,STAGE_PROFILE,source,home)
   if(result.status!=='exited')throw Error('registry-stage-install-'+result.status)
   if(result.exitCode!==0)throw Error('registry-stage-install-failed')
   return await this.installedBundle(join(home,'profiles',STAGE_PROFILE),source)
  }finally{await rm(home,{recursive:true,force:true}).catch(()=>{})}
 }

 /** 唯一的安装命令构造点：审查用的临时 profile 与正式 profile 逐字同参。 */
 private run(dshHome:string,profileName:string,source:MarketPluginRegistrySource,cwd:string):Promise<DshCommandResult>{
  return this.runner({
   command:this.options.dshCommand,
   // `dsh plugin` 把余下参数逐字转交 pnpm：`--ignore-scripts` 关掉安装期生命周期脚本
   //（profile 目录不在工作区 allowBuilds 的管辖范围内），`--registry` 把解析来源钉到预览用的同一 origin。
   args:['plugin','--profile',profileName,'add',marketPluginPackageRef(source),'--save-exact','--ignore-scripts','--registry',this.options.registry],
   cwd,env:{...process.env,DSH_HOME:dshHome},timeoutMs:this.options.timeoutMs,maxOutputBytes:this.options.maxOutputBytes,
   ...(this.options.signal?{signal:this.options.signal}:{}),
  })
 }

 /**
  * 读磁盘上已安装包的 DSH 声明与组合补丁正文，逐行核验并按正文算 sha256。
  * 补丁文件必须是普通文件：包里可以塞一条指向包外的符号链接，`lstat` 才拦得住。
  */
 private async installedBundle(profileDir:string,source:MarketPluginRegistrySource):Promise<InstalledBundle>{
  const packageRoot=join(profileDir,'node_modules',...source.packageName.split('/'))
  const installed=await readJsonFile(join(packageRoot,'package.json'))
  if(installed.name!==source.packageName||installed.version!==source.version)throw Error('installed-identity-mismatch')
  const dsh=manifestDsh(installed.dsh),bundle=dsh.bundle
  if(!record(bundle))throw Error('installed-declares-no-dsh-bundle')
  const patch=safePatch(packageRoot,bundle.patch)
  if(!patch)throw Error('installed-bundle-patch-path-invalid')
  const info=await lstat(patch)
  if(!info.isFile())throw Error('installed-bundle-patch-not-a-file')
  if(info.size>MAX_PATCH_BYTES)throw Error('installed-bundle-patch-too-large')
  const text=await readFile(patch,'utf8')
  return {dsh,review:reviewBundlePatch(text),bundleHash:createHash('sha256').update(text,'utf8').digest('hex')}
 }

 async preview(value:MarketPluginRegistrySource):Promise<MarketPluginInstallPreview>{
  const source=readMarketPluginRegistrySource(value),ref=marketPluginPackageRef(source)
  const {metadata,integrity:digest}=await this.artifact(source)
  // 审的是"装出来的那份"。同一包同一版本同一 integrity 的审查结果按 TTL 复用：
  // 一次安装只真装一遍审查用的包，也让重复预览不再是随意触发任意包安装的入口。
  const key=this.cacheKey(ref,digest)
  const staged=reviewCache.get(key)??await this.stagedOnce(key,source)
  // 能力摘要取**临时 profile 磁盘上**的 `dsh` 声明，不取 registry 元数据：
  // 审的是装出来的那份，摘要也必须来自同一份，否则 registry 可以在元数据里少写一项能力。
  return readMarketPluginInstallPreview({schema:'teloa.market-plugin-install-preview/v1',source,trust:{status:trustStatus(staged.review),publisher:publisher(metadata,source.packageName),integrity:digest},bundleHash:staged.bundleHash,permissionSummary:permissionSummary(staged.dsh,staged.review)})
 }

 /** 未命中缓存才真装：同一本人同一包名的审查安装做最小间隔限流，避免被当成任意包的安装入口。 */
 private async stagedOnce(key:string,source:MarketPluginRegistrySource):Promise<InstalledBundle>{
  const attempt=this.cacheKey('stage',source.packageName)
  if(stageAttempts.get(attempt))throw Error('registry-preview-rate-limited')
  stageAttempts.set(attempt,true,STAGE_INTERVAL_MS)
  const staged=await this.staged(source)
  reviewCache.set(key,staged,STAGE_CACHE_MS)
  return staged
 }

 async install(value:MarketPluginInstallPreview):Promise<MarketPluginInstallReceipt>{
  const preview=readMarketPluginInstallPreview(value),profileDir=this.profileDir
  const ref=marketPluginPackageRef(preview.source)
  // 整条安装路径（写记录 → 跑 pnpm → 核对 → 收尾/回滚）都握着同一把 profile 锁：
  // 两个不同包的安装同时进行时，两个 pnpm 会各自改同一份 profile 清单与同一棵 node_modules，
  // 后写的一方会把前一方的结果整段覆盖掉。锁里一律调 `*Locked` 变体，避免自锁。
  return withProfileLock(profileDir,()=>this.installLocked(preview,ref,profileDir))
 }

 private async installLocked(preview:MarketPluginInstallPreview,ref:string,profileDir:string):Promise<MarketPluginInstallReceipt>{
  // **先写待启用记录，再装。**
  //
  // 反过来（先装后写）会开出一个窗口：`dsh plugin add` 的 reconcile 已经把包追进了 bundles，
  // 而待启用清单里还没有它，于是这段时间里磁盘上的事实是"在 bundles 且无记录" ——
  // 启动器的交集判据、装配期的 pendingPlugins 钉、`observe()` 三道**全部放行**，
  // 而这段时间要跨过一次子进程、一次磁盘核对和一次网络取元数据（恶意 registry 能把它拖到超时上限）。
  // 后端在窗口里被杀，包就永久留在 bundles 里，下一次 reconcile 还会把它读成"已启用 · 待重启"。
  //
  // 先写记录之后，`finally` 的无条件压制天然覆盖这个新包，任何时刻崩溃留下的都是
  // "在 bundles 且有记录" —— 启动器拒绝、装配期拒绝、`observe()` 报响并重新压制。
  try{
   // profile 目录理应已经由启动器建好；`dsh plugin` 自己也会建。这里兜一手，
   // 免得"记录先写"这件事在一个还没落地的 profile 上直接失败。
   await mkdir(profileDir,{recursive:true,mode:0o700})
   await writePendingPlugins(profileDir,{...await readPendingPlugins(profileDir),[ref]:preview.bundleHash})
  }catch{
   return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{code:'install-failed',message:'DSH profile 的待启用扩展清单不可写，未开始安装。',retryable:true}}
  }
  let result:DshCommandResult,suppressed=true
  // 上游 reconcilePlugins 在**任何**一次成功的 `dsh plugin add` 之后都会把声明了 dsh.bundle
  // 而不在 bundles 里的包补回去——本次这个包，以及此刻别的待启用插件。所以子进程一结束就无条件重新压制：
  // 成功、失败、超时、中止、连 runner 自己抛出的那条路径都算。
  try{result=await this.run(this.options.dshHome,this.options.profile,preview.source,profileDir)}
  finally{await suppressPendingBundlesLocked(profileDir).catch(()=>{suppressed=false})}
  // 压制没跑成就不能声称安装成功：此刻包可能正躺在 bundles 里。
  // **不回滚**——待启用记录正是三道钉认出"这是没确认过的包"的凭据，这时候删掉它才是真危险。
  // 按未知回执交给上层去 reconcile：`observe()` 读的是磁盘现状，包真进了组合它会报响。
  if(!suppressed)return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:{code:'install-unknown',message:'DSH 扩展装入后未能确认它没有进入组合，需要重新核对。',retryable:true}}
  // 超时/中止/输出越界：子进程装到哪一步无从判断，同样不回滚（半装的产物由 reconcile 按磁盘现状认定）。
  // 留下的待启用记录是无害的：它只会让压制从 bundles 里少放一个名字，包没装上时 `observe()` 直接报 absent。
  if(result.status!=='exited')return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'unknown',failure:{code:'install-unknown',message:bounded(result.status==='timed-out'?'DSH 原生扩展安装命令超时，结果需要重新核对。':result.status==='aborted'?'DSH 原生扩展安装命令被中止，结果需要重新核对。':'DSH 原生扩展安装输出超过上限，结果需要重新核对。',this.options.maxOutputBytes),retryable:true}}
  if(result.exitCode!==0){
   // 命令**确定**失败：记录留着没有意义，清掉它与半装的产物，回到安装前。
   await rollbackInstallLocked(profileDir,preview.source,ref).catch(()=>{})
   return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{code:'install-failed',message:bounded('DSH 原生扩展安装命令失败（退出码 '+String(result.exitCode??1)+'）。',this.options.maxOutputBytes),retryable:true}}
  }
  try{
   // 装完先核对：包身份、磁盘补丁摘要与能力摘要必须等于预览批准的值，registry 工件也要还是同一份。
   const installed=await this.installedBundle(profileDir,preview.source)
   if(installed.bundleHash!==preview.bundleHash)throw Error('installed-bundle-hash-mismatch')
   if(!samePermissionSummary(permissionSummary(installed.dsh,installed.review),preview.permissionSummary))throw Error('installed-permission-summary-mismatch')
   // 只重取元数据比对 integrity 字符串：确认 registry 没在中途换过工件。字节由 pnpm 按同一个值校过。
   // 这一步要联网，可能被拖满超时上限——记录已经在清单里了，拖多久都不开窗口。
   const {integrity:digest}=await this.metadata(preview.source)
   if(digest!==preview.trust.integrity)throw Error('installed-artifact-integrity-mismatch')
   // 安装完成 ≠ 启用：包留在 dependencies 与 node_modules 里，但不进 bundles，
   // 它的 bundle 补丁层在本人显式启用前完全不参与组合。再压一次收口。
   await suppressPendingBundlesLocked(profileDir)
   return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'succeeded'}
  }catch{
   await rollbackInstallLocked(profileDir,preview.source,ref).catch(()=>{})
   return {schema:'teloa.market-plugin-install-receipt/v1',outcome:'failed',failure:{code:'install-failed',message:'DSH 扩展装入后与安装前固定的包身份、补丁摘要、能力摘要或来源工件不一致，已从 profile 回滚。',retryable:false}}
  }
 }

 /**
  * 本人显式启用：先按固定预览核对磁盘现状，通过才把包加回 bundles，下次启动生效。
  *
  * 写序是"先加回 bundles，再删待启用记录"。反过来写，中途崩溃就留下"记录没了且不在 bundles"，
  * 而上游的下一次 reconcile 会把它直接补成已启用——本人没点过第二次确认，代码却进了组合。
  * 现在这个顺序的崩溃窗口留下的是"在 bundles 且仍有记录"，`observe()` 会把它判成响并当场重新压制。
  */
 async enable(value:MarketPluginInstallPreview):Promise<void>{
  const preview=readMarketPluginInstallPreview(value),profileDir=this.profileDir
  const ref=marketPluginPackageRef(preview.source)
  await withProfileLock(profileDir,async()=>{
   // 待启用记录是"这个包正等着本人确认"的唯一凭据。没有它就不该把包加进 bundles：
   // 那要么是这个包根本没走过 Teloa 的安装路径（记录从未写过），要么是已经启用过一次
   // （记录在上一次 enable 里删掉了）。两种都不是"放行一次待启用"，一律按找不到处理。
   const pending=await readPendingPlugins(profileDir)
   if(pending[ref]===undefined)throw Error('enable-not-pending')
   if(pending[ref]!==preview.bundleHash)throw Error('enable-verification-failed')
   // 磁盘核对也在锁里：放到锁外做，核对与加回 bundles 之间就留了一段别人能改盘的时间。
   let installed:InstalledBundle
   try{installed=await this.installedBundle(profileDir,preview.source)}catch{throw Error('enable-verification-failed')}
   if(installed.bundleHash!==preview.bundleHash)throw Error('enable-verification-failed')
   if(!samePermissionSummary(permissionSummary(installed.dsh,installed.review),preview.permissionSummary))throw Error('enable-verification-failed')
   await rewriteProfileBundlesLocked(profileDir,bundles=>bundles.includes(preview.source.packageName)?bundles:[...bundles,preview.source.packageName])
   delete pending[ref]
   await writePendingPlugins(profileDir,pending)
  })
 }

 /** 调用方不得持 profile 锁（`withProfileLock` 不可重入）：命中"待启用但已入组合"分支时本函数内部会自己去拿锁重新压制。 */
 async observe(value:MarketPluginRegistrySource):Promise<MarketPluginInstallObservation>{
  const source=readMarketPluginRegistrySource(value),profileDir=this.profileDir
  try{
   const profile=await readJsonFile(join(profileDir,'package.json')),dependencies=profile.dependencies
   if(!record(dependencies)||dependencies[source.packageName]!==source.version)return genericFailure('absent','DSH profile 未固定安装此精确包版本。')
   const profileDsh=record(profile.dsh)?profile.dsh:undefined,profileConfig=profileDsh&&record(profileDsh.profile)?profileDsh.profile:undefined
   if(!profileConfig||!Array.isArray(profileConfig.bundles))return genericFailure('absent','DSH 原生 profile 配置不可读。')
   const ref=marketPluginPackageRef(source),pending=(await readPendingPlugins(profileDir))[ref]!==undefined
   const enrolled=profileConfig.bundles.includes(source.packageName)
   // 记录还在、包却已经进了组合：上游 reconcile 把它补回去了，或者有人手工改过 profile 清单。
   // 这不是"待启用"，是钉子失守——当场重新压制，并如实报响让上层落 failed，不掩蔽成 pending-enable。
   if(enrolled&&pending){
    await suppressPendingBundles(profileDir).catch(()=>{})
    return genericFailure('absent','待启用扩展已进入组合，已停止并需重新核对。')
   }
   if(!enrolled&&!pending)return genericFailure('absent','DSH 原生 profile 配置未启用此扩展 bundle。')
   const installed=await this.installedBundle(profileDir,source)
   // 状态就是"在不在 bundles 里"这件事实：不在 = 待启用，在但本进程没加载 = 需重启。
   const status=!enrolled?'pending-enable':this.options.activePluginRefs.has(ref)?'active':'restart-required'
   return {schema:'teloa.market-plugin-install-observation/v1',status,source,bundleHash:installed.bundleHash,permissionSummary:permissionSummary(installed.dsh,installed.review)}
  }catch(error){
   // 待启用清单读不出来 ≠ 没有待启用插件：按响处理，让上层落 failed 去重新核对。
   if(error instanceof Error&&error.message===pendingListUnreadable)return genericFailure('absent',pendingListUnreadable)
   if(error instanceof SyntaxError)return genericFailure('unknown','DSH 原生配置格式损坏，暂时无法确认扩展状态。')
   const code=record(error)?error.code:undefined
   if(code==='ENOENT')return genericFailure('absent','DSH profile、已安装包或原生配置不存在。')
   if(error instanceof Error&&error.message.startsWith('installed-'))return genericFailure('absent','已安装包的身份、DSH 声明或组合补丁不可核验。')
   return genericFailure('unknown','DSH 原生扩展状态暂时无法读取。')
  }
 }
}

/** 在宿主启动时固定实际已加载的 bundle；之后磁盘新增只能判为需重启。 */
export async function readActiveDshPluginRefs(dshHome:string,profileName:string):Promise<Set<string>>{
 const refs=new Set<string>(),profileDir=join(resolve(dshHome),'profiles',profileName)
 let profile:Record<string,unknown>
 try{profile=await readJsonFile(join(profileDir,'package.json'))}catch{return refs}
 const dependencies=record(profile.dependencies)?profile.dependencies:{},dsh=record(profile.dsh)?profile.dsh:{},settings=record(dsh.profile)?dsh.profile:{},bundles=Array.isArray(settings.bundles)?settings.bundles:[]
 for(const packageName of bundles){
  if(typeof packageName!=='string'||typeof dependencies[packageName]!=='string')continue
  try{
   const source=readMarketPluginRegistrySource({registry:'npm',packageName,version:dependencies[packageName]})
   const installed=await readJsonFile(join(profileDir,'node_modules',...packageName.split('/'),'package.json')),installedDsh=manifestDsh(installed.dsh),bundle=installedDsh.bundle
   if(installed.name!==packageName||installed.version!==source.version||!record(bundle))continue
   const root=join(profileDir,'node_modules',...packageName.split('/')),patch=safePatch(root,bundle.patch)
   if(patch&&(await stat(patch)).isFile())refs.add(marketPluginPackageRef(source))
  }catch{}
 }
 return refs
}
