/**
 * 装配期复验 DSH 生效组合。原生预设已是可被补丁覆盖的插件声明，
 * 必须检查 Loader 中最终的 config.plugins，不能用磁盘原文替代生效内容。
 * 任一部署安全钉缺失或被更改都拒绝装配，业务通道不会注册。
 */

import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {parse as parseYaml} from 'yaml'
import {pendingPackageNames,profileBundles,readJsonFile,readPendingPlugins} from './pending-plugins.ts'

const record=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value)

/**
 * 生效组合树里的一行：`id` 是补丁的定位键，`config` 是补丁叠加之后的取值，
 * `name` 是该行挂载的模块（用来认出"这一行来自哪个包"）。
 */
export type CompositionRow={id:string;disabled:boolean;config:unknown;name?:unknown;isolate?:unknown;inject?:unknown;intercept?:unknown;group?:unknown}

/** 复验用的键值快照；取不到该行（缺失、重复或被关闭）时留 undefined。 */
export type CompositionSnapshot={
 telemetryMode?:unknown
 sessionLogUploadDisabled?:boolean
 sandboxMode?:unknown
 sandboxWorkspaceRoot?:unknown
 /** 执行后端 `@deepseek-ai/dsh-sandbox-local` 行是否在组合树里且未被关闭。 */
 sandboxBackendMounted?:boolean
 approvalPolicy?:unknown
 toolsMode?:unknown
 /** 宿主平面的两个工具入口也必须关闭。 */
 toolWorkflowDisabled?:boolean
 toolRalphDisabled?:boolean
 /** 官方注册器和五份核对过的声明均来自生效组合，无目录扫描或 roots 配置。 */
 agentPresetDefault?:unknown
 agentPresetRegistryPinned?:boolean
 agentPresetDeclarationPinned?:boolean
 permissionPresets?:unknown
 /** 自有预设的可读信号；全部预设摘要包含 isolate、inject、条件及全部配置。 */
 presetToolPresentationMode?:unknown
 presetToolWorkflowDisabled?:unknown
 presetToolRalphDisabled?:unknown
 presetBodyDigestMatches?:unknown
 /** rc1 实际宿主 HMR 行必须关闭，不能依赖上游已不读取的 profile 字段。 */
 hmrDisabled?:boolean
 /**
  * 待启用插件一个都没进组合：既不在 `dsh.profile.bundles` 里，也没有哪一行挂着它们的模块。
  * 取不到这件事实（undefined）与"进来了"同样判违规 —— 无从复验就不该放行。
  */
 pendingPluginsExcluded?:boolean
 /**
  * 上网的 provider 选择、检索端点与抓取边界值：`web` 行的两个 provider id、
  * `web-search-deepseek` 行的端点与凭据引用、`web-fetch-http` 行的五个上限与披露。
  *
  * **本枚钉只核对 provider 选择与边界值，它不放行任何工具**：外发工具的「默认拒、
  * 按岗位授权放行」在执行态，由 `task-tool-guard` 与 `role-tool-grants` 判定；
  * 这枚钉管的是「一旦放行，走的还是不是那套被审过的 provider 与那几个边界值」。
  *
  * 私网 / 链路本地 / 云元数据地址、非 `http(s)`、跨源重定向与重定向后复判，全部由上游
  * `dsh-web-fetch-http` 这个 provider 自己做，Teloa 不重写一份；换掉 `fetchProvider`
  * 因此等于一次性换掉那整套保护。而 `web-fetch-http` 原本**没有 config**、取的全是上游默认，
  * 第三方 bundle 在 `dsh.profile.bundles` 尾部追加一行就能把 maxRedirects 提到 50、
  * maxResponseBytes 提到 5GB。`userAgent` 一并钉住：它是每次外发对目标站点的自我披露，
  * `SECURITY.md` 逐字向本人承诺目标站点看到的是 `deepseek-harness/…`，改掉它等于让那句承诺失真。
  * 检索侧同理：上游逐字 `config.baseURL ?? $DEEPSEEK_SEARCH_BASE_URL ?? 默认`，端点不钉住
  * 就等于留着一个把检索词连同 `DEEPSEEK_API_KEY` 改投到别处的环境入口。
  *
  * 三个 `…RowName` 是「这一行挂的到底是不是那个包」：前面所有取值都只按 `id` 定位，
  * 第三方补丁把同一个 id 的 `name` 换成自己的实现时，config 逐字对得上、provider 却已被整包顶替。
  * 十二个键取不到（缺行、重复、被关闭）与被改掉同样判违规。
  */
 webRowName?:unknown
 webSearchRowName?:unknown
 webFetchRowName?:unknown
 webSearchProvider?:unknown
 webFetchProvider?:unknown
 webSearchBaseUrl?:unknown
 webSearchApiKeyEnv?:unknown
 webFetchMaxResponseBytes?:unknown
 webFetchMaxBodyChars?:unknown
 webFetchTimeoutMs?:unknown
 webFetchMaxRedirects?:unknown
 webFetchUserAgent?:unknown
 /** 官方明文凭据行停用、Teloa 加密提供方唯一挂载。 */
 credentialsPinned?:boolean
 /** 官方附件准入行停用、Teloa 提交前密钥闸唯一挂载。 */
 promptAdmissionPinned?:boolean
}

export const compositionPins=['telemetry','sandbox','approval','tools','agentPresets','permission','patchReload','pendingPlugins','web','credentials','promptAdmission'] as const
export type CompositionPin=(typeof compositionPins)[number]

/** 诊断只用这张固定表里的中文标签：攻击者写进补丁的取值不得进入文案。 */
const pinLabels:Record<CompositionPin,string>={
 telemetry:'会话遥测与日志上传',
 sandbox:'沙箱默认模式',
 approval:'审批征询默认值',
 tools:'工具呈现模式与 workflow / ralph 工具入口',
 agentPresets:'Agent 预设声明与默认运行配置',
 permission:'会话权限预设表',
 patchReload:'补丁热加载禁用',
 pendingPlugins:'待启用扩展未进入组合',
 web:'上网 provider 选择与抓取边界值',
 credentials:'凭据加密存储提供方',
 promptAdmission:'对话提交前的密钥拦截',
}

/** 业务身份保持不变；声明行 id 使用 Teloa 保留前缀。 */
export const teloaAgentPresetId='teloa-standard'
export const teloaAgentPresetRowId='teloa-agent-preset'
const presetPluginName='@deepseek-ai/dsh-agent-preset'
const presetRegistryName='@deepseek-ai/dsh-agent-preset-registry'
export const shippedPresetBodyDigests={
 standard:'95f1a355c6fe6cb689c53382b3198713bbc10e109defcd6e998cf504e4b0c9ae',
 ptc:'f5701cd2cbd4740fe1c2995414d6ec1ec8b8eab77f265180230583027d431915',
 minimal:'46f29c9251390c8c34315e49259ea27eb1b973e039dba69f9627447a41fbf4cb',
 cordis:'f143d3b4be7e60de59d9b24cf8685be7628bf000e002c7faac2115b0ab293879',
} as const
const shippedPresetRowIds=Object.keys(shippedPresetBodyDigests).map(id=>'preset-'+id)
const allowedPresetIds=[teloaAgentPresetId,...Object.keys(shippedPresetBodyDigests)]
/** 仓库声明仅用于静态核对，运行期只检查生效组合。 */
export const bundledAgentPresetsRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..','..','bundle','agent-presets')
const presetBodyPath=join(bundledAgentPresetsRoot,teloaAgentPresetId,'agent.cordis.yml')

/**
 * 抓取时对目标站点的自我披露，逐字取上游 `dsh-web-fetch-http` 的 `DEFAULT_USER_AGENT`。
 * 不伪装成浏览器，也不交回上游默认：补丁按整块替换，不写这一行就等于把 `SECURITY.md`
 * 里那句「目标站点会看到 `deepseek-harness/…`」交给后加载的第三方补丁去改。
 */
const webFetchUserAgent='deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)'
/** 检索端点，逐字与 `SECURITY.md` 向本人披露的那一个一致。 */
const webSearchBaseUrl='https://api.deepseek.com/anthropic/v1'
/** 三行各自必须挂着的模块：只按 id 定位挡不住「同 id 换实现」。 */
const webRowNames={web:'@deepseek-ai/dsh-web',search:'@deepseek-ai/dsh-web-search-deepseek',fetch:'@deepseek-ai/dsh-web-fetch-http'} as const

/**
 * 上网的三行是否仍是那套被审过的 provider、端点与边界值。
 *
 * 判据只认字面量：取不到（缺行、重复、被关闭、`name` 对不上）与被改掉同样为假。
 * 这里不判「能不能上网」——那是执行态 `task-tool-guard` / `role-tool-grants` 的事。
 */
function webPinned(snapshot:CompositionSnapshot):boolean{
 if(snapshot.webRowName!==webRowNames.web||snapshot.webSearchRowName!==webRowNames.search||snapshot.webFetchRowName!==webRowNames.fetch)return false
 if(snapshot.webSearchProvider!=='deepseek-official'||snapshot.webFetchProvider!=='http')return false
 if(snapshot.webSearchBaseUrl!==webSearchBaseUrl||snapshot.webSearchApiKeyEnv!=='DEEPSEEK_API_KEY')return false
 return snapshot.webFetchMaxResponseBytes===5000000&&snapshot.webFetchMaxBodyChars===100000&&snapshot.webFetchTimeoutMs===30000&&snapshot.webFetchMaxRedirects===3&&snapshot.webFetchUserAgent===webFetchUserAgent
}

const unreadable='无法读取 DSH 生效组合配置，宿主拒绝启动：部署安全钉无从复验。'
const sandboxModes=['read-only','workspace-write']

/**
 * `workspaceRoot` 是沙箱写范围的兜底根。补丁按整个 config 替换，
 * 漏写或改写这一行就把兜底范围交回上游默认值，`mode: workspace-write` 也就管不住范围。
 * 组合树里它是 `!!js process.cwd()` 表达式节点（`{__jsExpr}`），
 * 真实宿主的 cwd 由启动器保证就是专用工作区。
 */
function workspaceRootPinned(value:unknown):boolean{
 if(record(value)&&typeof value.__jsExpr==='string')return value.__jsExpr.replace(/\s+/g,'')==='process.cwd()'
 return typeof value==='string'&&value===process.cwd()
}

/** 预设表里任何一条放行全盘写或把征询钉成 never，都等于绕过部署默认值。 */
function presetsSafe(value:unknown):boolean{
 if(!record(value))return false
 const presets=Object.values(value)
 if(!presets.length)return false
 return presets.every(preset=>record(preset)&&preset.approval==='ask'&&sandboxModes.includes(String(preset.sandbox)))
}

/** 纯函数：键值快照 → 违规钉子列表。钉子测试与装配期复验共用这一份判据。 */
export function compositionViolations(snapshot:CompositionSnapshot):CompositionPin[]{
 const violations:CompositionPin[]=[]
 if(snapshot.telemetryMode!=='DISABLED'||snapshot.sessionLogUploadDisabled!==true)violations.push('telemetry')
 if(snapshot.sandboxMode!=='workspace-write'||!workspaceRootPinned(snapshot.sandboxWorkspaceRoot)||snapshot.sandboxBackendMounted!==true)violations.push('sandbox')
 if(snapshot.approvalPolicy!=='ask')violations.push('approval')
 if(snapshot.toolsMode!=='native'||snapshot.toolWorkflowDisabled!==true||snapshot.toolRalphDisabled!==true||snapshot.presetToolPresentationMode!=='native'||snapshot.presetToolWorkflowDisabled!==false||snapshot.presetToolRalphDisabled!==false||snapshot.presetBodyDigestMatches!==true)violations.push('tools')
 if(snapshot.agentPresetDefault!==teloaAgentPresetId||snapshot.agentPresetRegistryPinned!==true||snapshot.agentPresetDeclarationPinned!==true)violations.push('agentPresets')
 if(!presetsSafe(snapshot.permissionPresets))violations.push('permission')
 if(snapshot.hmrDisabled!==true)violations.push('patchReload')
 if(snapshot.pendingPluginsExcluded!==true)violations.push('pendingPlugins')
 if(!webPinned(snapshot))violations.push('web')
 if(snapshot.credentialsPinned!==true)violations.push('credentials')
 if(snapshot.promptAdmissionPinned!==true)violations.push('promptAdmission')
 return violations
}

/**
 * 待启用插件是否一个都没进组合。
 *
 * 两条独立判据，任一不成立即为假：
 * ①包名不在 `dsh.profile.bundles` 里 —— 上游 `reconcilePlugins` 会在任何一次
 *   `dsh plugin add` 之后把声明了 `dsh.bundle` 的包补回去，这是最常见的失守方式；
 * ②生效组合树里没有哪一行挂着这些包 —— 包名被从 bundles 摘掉之后，
 *   仍可能有别的补丁把同一个模块当成一行插进来。
 */
export function pendingPluginsExcluded(rows:readonly CompositionRow[],bundles:readonly string[],pending:readonly string[]):boolean{
 if(!pending.length)return true
 const names=new Set(pending)
 if(bundles.some(name=>names.has(name)))return false
 return !rows.some(row=>typeof row.name==='string'&&names.has(row.name))
}

/** 原生声明子插件的可读信号及完整结构摘要。 */
export type PresetBodyFacts={toolPresentationMode:unknown;toolWorkflowDisabled:unknown;toolRalphDisabled:unknown;digestMatches:boolean}

function presetBodyReadableFacts(document:unknown):Omit<PresetBodyFacts,'digestMatches'>{
 const rows:Record<string,unknown>[]=[]
 const visit=(nodes:unknown,depth:number):void=>{
  if(depth>16||!Array.isArray(nodes))return
  for(const node of nodes){
   if(!record(node))continue
   rows.push(node)
   if(node.group===true)visit(node.config,depth+1)
  }
 }
 visit(document,0)
 const rowOf=(id:string)=>{const matched=rows.filter(row=>row.id===id);return matched.length===1?matched[0]:undefined}
 const presentation=rowOf('tool-presentation')?.config
 return {
  toolPresentationMode:record(presentation)?presentation.mode:undefined,
  toolWorkflowDisabled:rowOf('tool-workflow')?.disabled,
  toolRalphDisabled:rowOf('tool-ralph')?.disabled,
 }
}

/** 对象键序无关，保留数组顺序和所有 Loader 字段，不能遗漏 isolate 或 !!js 条件。 */
function canonicalValue(value:unknown):unknown{
 if(Array.isArray(value))return value.map(canonicalValue)
 if(record(value))return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonicalValue(value[key])]))
 return value
}

/** 插件行顺序同样参与摘要：插件注册顺序会影响运行语义。 */
export function presetBodyNormalizedDigest(document:unknown):string{
 return createHash('sha256').update(JSON.stringify(canonicalValue(document))).digest('hex')
}

/** 复核过的声明：standard 换受管派发，带压缩的预设接本地预算薄适配，其余沿用官方。 */
export const presetBodyDigest='fbeccb5307adb13243f6188adc306fc78bd9e57e3e04a4a464f978e6eda25166'

function presetBodyFacts(document:unknown):PresetBodyFacts{
 return {...presetBodyReadableFacts(document),digestMatches:Array.isArray(document)&&presetBodyNormalizedDigest(document)===presetBodyDigest}
}

/** 静态核对仓库声明，保留 !!js 为 Loader 使用的表达式对象，不执行其中代码。 */
export async function readPresetBodyFacts():Promise<PresetBodyFacts|undefined>{
 try{
  const document=parseYaml(await readFile(presetBodyPath,'utf8'),{customTags:[{tag:'tag:yaml.org,2002:js',resolve:(source:string)=>({__jsExpr:source})}]})
  if(!Array.isArray(document)||document.length!==1||!record(document[0]))return undefined
  const declarations=document[0].insert
  if(!Array.isArray(declarations)||declarations.length!==1)return undefined
  const declaration=declarations[0]
  if(!record(declaration)||declaration.id!==teloaAgentPresetRowId||declaration.name!==presetPluginName||!record(declaration.config)||declaration.config.id!==teloaAgentPresetId)return undefined
  return presetBodyFacts(declaration.config.plugins)
 }catch{return undefined}
}

/** 注册器仅接受官方配置；被替换、重复或含旧扫描字段均不能放行。 */
function registryPinned(row:CompositionRow|undefined):boolean{
 if(!row||row.disabled||row.name!==presetRegistryName||!record(row.config)||!presetWiringPinned(row))return false
 return Object.keys(row.config).every(key=>['default','selectedDefault','modeSelectionEnabled'].includes(key))
  &&(row.config.selectedDefault===undefined||typeof row.config.selectedDefault==='string'&&allowedPresetIds.includes(row.config.selectedDefault))
  &&(row.config.modeSelectionEnabled===undefined||typeof row.config.modeSelectionEnabled==='boolean')
}

/** 注册器与预设声明使用官方默认作用域与注入，不能被补丁接到别的服务。 */
function presetWiringPinned(row:CompositionRow):boolean{
 return row.isolate===undefined&&row.inject===undefined&&row.intercept===undefined&&row.group===undefined
}

/** 五份已核对声明必须唯一、启用且身份一致；不能用别名或额外声明扩张工具面。 */
function declarationPinned(rows:readonly CompositionRow[],declaration:CompositionRow|undefined):boolean{
 if(!declaration||declaration.disabled||declaration.name!==presetPluginName||!record(declaration.config)||declaration.config.id!==teloaAgentPresetId||!Array.isArray(declaration.config.plugins)||!presetWiringPinned(declaration))return false
 if(Object.keys(declaration.config).some(key=>!['id','name','description','order','plugins'].includes(key)))return false
 const declarations=rows.filter(row=>!row.disabled&&(row.name===presetPluginName||row.id===teloaAgentPresetRowId||shippedPresetRowIds.includes(row.id)||(record(row.config)&&('plugins' in row.config||row.config.id===teloaAgentPresetId))))
 if(declarations.length!==allowedPresetIds.length)return false
 return allowedPresetIds.every(id=>{
  const rowId=id===teloaAgentPresetId?teloaAgentPresetRowId:'preset-'+id
  const matches=rows.filter(row=>row.id===rowId)
  if(matches.length!==1)return false
  const row=matches[0]!
  return !row.disabled&&row.name===presetPluginName&&record(row.config)&&row.config.id===id&&Array.isArray(row.config.plugins)&&presetWiringPinned(row)
   &&Object.keys(row.config).every(key=>['id','name','description','order','plugins'].includes(key))
 })
}

/** 官方行停用且未被他行复挂、Teloa 行唯一启用：只按 id 定位挡不住同 id 换实现，所以连 name 一起钉。 */
function replacementPinned(rows:readonly CompositionRow[],pin:{officialId:string;officialName:string;teloaId:string;teloaName:string}):boolean{
 const official=rows.filter(row=>row.id===pin.officialId),teloa=rows.filter(row=>row.id===pin.teloaId)
 return official.length===1&&official[0]!.disabled===true&&official[0]!.name===pin.officialName
  &&teloa.length===1&&teloa[0]!.disabled===false&&teloa[0]!.name===pin.teloaName
  &&rows.every(row=>row.disabled||row.name!==pin.officialName)
  &&rows.filter(row=>!row.disabled&&row.name===pin.teloaName).length===1
}

/**
 * 纯函数：组合树行列表 → 键值快照。同名行出现多次或被关闭时按取不到处理。
 * `pending` 省略时 `pendingPluginsExcluded` 留 undefined，复验随之判违规 ——
 * 这一项必须由调用方如实给出；预设事实直接从生效声明读取。
 */
export function compositionSnapshot(rows:readonly CompositionRow[],pending?:{bundles:readonly string[];packages:readonly string[]}):CompositionSnapshot{
 const rowOf=(id:string):CompositionRow|undefined=>{
  const matched=rows.filter(row=>row.id===id)
  return matched.length===1?matched[0]:undefined
 }
 const configOf=(id:string):Record<string,unknown>|undefined=>{
  const matched=rowOf(id)
  if(!matched||matched.disabled)return undefined
  return record(matched.config)?matched.config:undefined
 }
 const sandbox=configOf('sandbox-policy'),agentPresets=configOf('agent-preset-registry')
 const declaration=rowOf(teloaAgentPresetRowId)
 const presetBody=presetBodyFacts(configOf(teloaAgentPresetRowId)?.plugins)
 const web=configOf('web'),webSearch=configOf('web-search-deepseek'),webFetch=configOf('web-fetch-http')
 /** 缺行同样判违规：取不到这一行就无从证明那个工具入口没被挂上去。 */
 const rowDisabled=(id:string):boolean=>{const row=rowOf(id);return row!==undefined&&row.disabled===true}
 const sessionLog=rowOf('session-log-deepseek'),sessionLogModule='@deepseek-ai/dsh-session-log-deepseek'
 const logDisabled=(row:CompositionRow)=>row.disabled||(record(row.config)&&row.config.enabled===false)
 return {
  telemetryMode:configOf('session-telemetry-otel')?.mode,
  sessionLogUploadDisabled:sessionLog!==undefined&&sessionLog.name===sessionLogModule&&logDisabled(sessionLog)&&rows.filter(row=>row.name===sessionLogModule).every(logDisabled),
  sandboxMode:sandbox?.mode,
  sandboxWorkspaceRoot:sandbox?.workspaceRoot,
  // 执行后端缺席时上游的 bash 执行器因 inject 悬挂而不装载，但显式钉住这一行更省心。
  sandboxBackendMounted:rowOf('sandbox')!==undefined&&rowOf('sandbox')?.disabled===false,
  approvalPolicy:configOf('approval')?.policy,
  toolsMode:configOf('tools')?.mode,
  toolWorkflowDisabled:rowDisabled('tool-workflow'),
  toolRalphDisabled:rowDisabled('tool-ralph'),
  agentPresetDefault:agentPresets?.default,
  agentPresetRegistryPinned:registryPinned(rowOf('agent-preset-registry')),
  agentPresetDeclarationPinned:declarationPinned(rows,declaration),
  permissionPresets:configOf('permission')?.presets,
  webRowName:rowOf('web')?.name,
  webSearchRowName:rowOf('web-search-deepseek')?.name,
  webFetchRowName:rowOf('web-fetch-http')?.name,
  webSearchProvider:web?.searchProvider,
  webFetchProvider:web?.fetchProvider,
  webSearchBaseUrl:webSearch?.baseURL,
  webSearchApiKeyEnv:webSearch?.apiKeyEnv,
  webFetchMaxResponseBytes:webFetch?.maxResponseBytes,
  webFetchMaxBodyChars:webFetch?.maxBodyChars,
  webFetchTimeoutMs:webFetch?.timeoutMs,
  webFetchMaxRedirects:webFetch?.maxRedirects,
  webFetchUserAgent:webFetch?.userAgent,
  credentialsPinned:replacementPinned(rows,{officialId:'credentials',officialName:'@deepseek-ai/dsh-credentials-local',teloaId:'teloa-credentials',teloaName:'@teloa/harness-dsh/credentials'}),
  promptAdmissionPinned:replacementPinned(rows,{officialId:'attachment-local',officialName:'@deepseek-ai/dsh-attachment-local',teloaId:'teloa-attachment-guard',teloaName:'@teloa/harness-dsh/attachment-guard'}),
  hmrDisabled:rowDisabled('hmr')&&rowOf('hmr')?.name==='@deepseek-ai/dsh-hmr'&&rows.every(row=>row.name!=='@deepseek-ai/dsh-hmr'||row.disabled===true),
  ...(pending===undefined?{}:{pendingPluginsExcluded:pendingPluginsExcluded(rows,pending.bundles,pending.packages)}),
  presetToolPresentationMode:presetBody.toolPresentationMode,
  presetToolWorkflowDisabled:presetBody.toolWorkflowDisabled,
  presetToolRalphDisabled:presetBody.toolRalphDisabled,
  presetBodyDigestMatches:presetBody.digestMatches&&Object.entries(shippedPresetBodyDigests).every(([id,digest])=>{
   const plugins=configOf('preset-'+id)?.plugins
   return Array.isArray(plugins)&&presetBodyNormalizedDigest(plugins)===digest
  }),
 }
}

/** 纯函数：违规列表 → 固定中文诊断（只含钉子标签，不含路径与补丁取值）。 */
export function compositionRefusalMessage(violations:readonly CompositionPin[]):string{
 const labels=compositionPins.filter(pin=>violations.includes(pin)).map(pin=>pinLabels[pin]).join('、')
 return 'DSH 生效组合配置的部署安全钉已被改动，宿主拒绝启动：'+labels+'。请在 DSH profile 里移除会改动这些配置的第三方扩展或补丁后重新启动。'
}

/**
 * 从 Cordis 上下文读出生效组合树的行。
 *
 * 取的是 Loader 的条目表：补丁（bundle 层与用户层）在 Include 解析阶段就已叠加完，
 * `entry.options.config` 就是 `dsh --dump-config` 打印的那份取值；
 * 同一批条目在启动时同步建好，本插件装配时兄弟行的 `options` 已经齐备。
 * 读不到就返回 undefined，由调用方按“无从复验”拒绝启动。
 */
export function readCompositionRows(ctx:unknown):CompositionRow[]|undefined{
 try{
  const loader=record(ctx)?Reflect.get(ctx,'loader'):undefined
  if(!record(loader)||typeof loader.entries!=='function')return undefined
  const entries=(loader.entries as ()=>unknown)()
  if(entries===null||typeof entries!=='object'||typeof (entries as Iterable<unknown>)[Symbol.iterator]!=='function')return undefined
  const rows:CompositionRow[]=[]
  for(const entry of entries as Iterable<unknown>){
   if(!record(entry))return undefined
   const options=record(entry.options)?entry.options:undefined
   // 取条目自己声明的 id，不是 `entry.id`：后者会带上所属子树的前缀
   // （根 Include 的条目 id + `:`），与补丁和 `--dump-config` 里的定位键对不上。
   const id=typeof options?.id==='string'?options.id:undefined
   if(id===undefined)return undefined
   rows.push({...options,id,disabled:entry.disabled===true,config:options?.config,name:options?.name})
  }
  return rows.length?rows:undefined
 }catch{return undefined}
}

/** 装配期闸：读不到生效组合或任一钉子不符即抛出，宿主不会注册 `/teloa` 通道。 */
export function assertCompositionSafety(ctx:unknown,profile?:ProfileFacts):void{
 const rows=readCompositionRows(ctx)
 if(!rows)throw Error(unreadable)
 const snapshot=compositionSnapshot(rows,profile===undefined?undefined:{bundles:profile.bundles,packages:profile.pendingPackages})
 // rc1 HMR 直接监听 profile 与补丁。组合行关闭之外还要核对服务事实，
 // 防止其他插件已经提供了 HMR；读取失败也不能证明热加载已关闭。
 try{
  const get=record(ctx)?Reflect.get(ctx,'get'):undefined
  const hmr=typeof get==='function'?get.call(ctx,'hmr'):record(ctx)?Reflect.get(ctx,'hmr'):undefined
  if(hmr!==undefined)snapshot.hmrDisabled=false
 }catch{snapshot.hmrDisabled=false}
 const violations=compositionViolations(snapshot)
 if(violations.length)throw Error(compositionRefusalMessage(violations))
}

/**
 * profile 清单里那些不在组合树上、但同样决定"下次启动会加载什么"的事实。
 * 读不到就整体返回 undefined，复验随之把 `pendingPlugins` 判违规。
 */
export type ProfileFacts={bundles:string[];pendingPackages:string[]}

/**
 * 读 profile 清单与待启用清单：
 * - `dsh.profile.bundles` 与待启用清单一起回答"本人没点过启用的插件是不是已经进了组合" ——
 *   上游 `reconcilePlugins` 会在任何一次 `dsh plugin add` 之后把它们补回 bundles。
 */
export async function readProfileFacts(dshHome:string,profileName:string):Promise<ProfileFacts|undefined>{
 const profileDir=join(resolve(dshHome),'profiles',profileName)
 try{
  const manifest=await readJsonFile(join(profileDir,'package.json'))
  return {
   bundles:profileBundles(manifest),
   pendingPackages:pendingPackageNames(await readPendingPlugins(profileDir)),
  }
 }catch{return undefined}
}
