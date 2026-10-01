// 夹具：main 4fdb16f4（packages/* 版本 0.2.0-alpha.6）的 v2 索引读取器原样复制（仅把 work-error / resources / roles 的导入改指当前契约），
// 代表已发行旧版应用：逐条严格解析，已知 kind 且版本范围满足本机的条目出现未知字段即整份拒收。不要修改。
import {WorkError} from '../../../packages/contract/src/work-error.ts'
import {isRecord} from '../../../packages/contract/src/resources.ts'
import {type MarketTaxonomy,type MarketEntryKind,readMarketTaxonomy} from './market-taxonomy.ts'
import {roleDefinition,type RoleResponsibility} from '../../../packages/contract/src/roles.ts'
import {parseTeloaRange,teloaRangeSatisfies} from './semver-range.ts'
export type {MarketTaxonomy} from './market-taxonomy.ts'
export {marketFunctionKeys,marketIndustryKeys,marketIndustryParent,isMarketIndustryRoot,readMarketTaxonomy,marketEntryKinds} from './market-taxonomy.ts'
export type {MarketFunctionKey,MarketIndustryKey,MarketEntryKind} from './market-taxonomy.ts'

/**
 * Teloa 官方市场目录格式（规格 2026-09-25 全球使用统计与官方生态建设 §4.1）。
 *
 * 条目由目录仓作者书写，快照索引由 `scripts/构建市场目录.mjs` 生成并随发行固定。
 * 「官方」只表示 Teloa 目录收录并审核；上游作者、许可与适配修改分字段记录，不合并成一个认证。
 * 兼容状态只有四值，具体条件放在 `compatibility.conditions`。
 */
export const marketCatalogCompatibility=['verified','needs-configuration','content-only','unsupported'] as const
export type MarketCatalogCompatibility=typeof marketCatalogCompatibility[number]
export type MarketCatalogText={'zh-CN':string;en:string}
export const skillSecretMethods=['GET','POST','PUT','PATCH','DELETE'] as const
export type SkillSecretMethod=typeof skillSecretMethods[number]
export type MarketCatalogSkillSecretEndpoint={origin:string;pathPrefixes:string[]}
export type MarketCatalogSkillSecret={envVarName:string;label:MarketCatalogText;required:boolean;target:'bearer'|'header'|'query';name?:string;endpoints:MarketCatalogSkillSecretEndpoint[];methods:SkillSecretMethod[]}
/** 记录里保存声明指纹的保留槽：不是密钥值，契约禁止声明同名变量，known-values 排除它。 */
export const skillSecretBindingSlot='TELOA_BINDING_SHA256'
/** 带 `secrets` 的条目依赖的宿主工具（计划关键决定 9）。 */
export const skillSecretHttpTool='teloa_skill_http'
/** 带 `secrets` 的条目 `compatibility.teloa` 不得接受的最后一个旧版：旧应用不认识 secrets，读到会当作未知字段整份拒绝。 */
export const skillSecretLastUnsupportedTeloa='0.2.0-alpha.6'
export type MarketCatalogSkillEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'skill'
 delivery:'builtin'|'install'
 version:string
 taxonomy:MarketTaxonomy
 skill:{name:string;title:MarketCatalogText;summary:MarketCatalogText}
 /** Teloa 自编的内置技能（`delivery:'builtin'`、`teloa-` 前缀）没有外部上游，为 null；这类条目只随发行快照提供，不进在线索引。 */
 upstream:{ecosystem:string;author:string;repository:{host:'github.com';owner:string;repo:string};commit:string;path:string;license:string;files:{path:string;gitBlob:string;size:number}[]}|null
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[]}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
 secrets?:MarketCatalogSkillSecret[]
}
export type MarketCatalogSolutionCapabilities={now:MarketCatalogText[];needs:MarketCatalogText[];permissions:MarketCatalogText[]}
export type MarketCatalogSolutionEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'solution'
 delivery:'install'
 version:string
 upstream:null
 taxonomy:MarketTaxonomy
 solution:{packageId:string;title:MarketCatalogText;summary:MarketCatalogText;scope:string;capabilities:MarketCatalogSolutionCapabilities}
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[]}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
}
/** connector 认证：none（无凭据）、secret（密钥/令牌）、oauth（宿主主导的 OAuth 授权，见 ConnectorAuthOAuth）。
 *  凭据存储按「一个连接对应一组可轮换的密钥材料」设计：vars 每项对应一个独立密钥槽。
 *  远程连接重连时重新读取凭据文件，而不是连接创建时固定。
 */
export type ConnectorAuthSecretVar=
 | {target:'env';envVarName:string;label:MarketCatalogText;required:boolean}
 | {target:'bearer';label:MarketCatalogText;required:boolean}
 /** url-path：密钥替换进 streamable-http-template 配方的 URL 模板；只对 streamable-http-template 有意义。 */
 | {target:'url-path';label:MarketCatalogText;required:boolean}
export type ConnectorAuthNone={kind:'none'}
export type ConnectorAuthSecret={kind:'secret';vars:ConnectorAuthSecretVar[]}
/** oauth 认证：supported:true 为可发起授权的连接器（PKCE public client）；supported:false 只作「不支持」标记并附原因。 */
export type ConnectorAuthOAuth=
 | {
   kind:'oauth'
   supported:true
   /** 授权时请求的 scope 列表（最小权限原则） */
   scopes:string[]
   /** DCR 不支持时，用户需提供其自注册 OAuth App 的 client_id（凭据槽名 oauth_client_id） */
   requiresUserClientId?:boolean
   /** 仅随 requiresUserClientId:true：用户 client_id 须匹配的正则（首尾锚定，无分组 / 选择 / 反向引用，≤100 字符，按 u 标志编译） */
   clientIdPattern?:string
   /** true = 厂商只允许白名单 / 人工审批的客户端；条目兼容状态须为 needs-configuration 并在 conditions 写明 */
   requiresAllowlist?:boolean
  }
 | {
   kind:'oauth'
   supported:false
   /** 不支持的人类可读原因 */
   reason:string
  }
export type ConnectorAuth=ConnectorAuthNone|ConnectorAuthSecret|ConnectorAuthOAuth

/** connector 配方：stdio（npm 包）、streamable-http（固定 https 地址）或 streamable-http-template（每用户 URL，{secret} 占位符）；认证独立建模在 auth 字段。 */
export type MarketCatalogConnectorRecipe=
 | {transport:'stdio';package:string;version:string;integrity:string;bin:string;args:string[]}
 | {transport:'streamable-http';url:string}
 /** streamable-http-template：URL 模板含一个 {secret} 占位符，由 url-path 凭据变量提供密钥；主机端替换后验证主机名不变，存储密钥而非完整 URL。 */
 | {transport:'streamable-http-template';urlTemplate:string}
export type MarketCatalogConnectorTool={name:string;description:MarketCatalogText;readOnly:boolean}
export type MarketCatalogConnectorEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'connector'
 delivery:'managed'
 version:string
 upstream:null
 taxonomy:MarketTaxonomy
 connector:{serverName:string;title:MarketCatalogText;summary:MarketCatalogText;auth:ConnectorAuth;recipe:MarketCatalogConnectorRecipe;tools:MarketCatalogConnectorTool[];upstreamUrl:string}
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[]}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
}
/** 上游来源：GitHub 固定提交子目录。 */
export type MarketCatalogUpstreamGithub={
 kind:'github'
 repository:{host:'github.com';owner:string;repo:string}
 commit:string
 path:string
 files:{path:string;gitBlob:string;size:number|null}[]
}
/** 上游来源：ClawHub 技能，按版本和逐文件 sha256 固定。 */
export type MarketCatalogUpstreamClawHub={
 kind:'clawhub'
 owner:string
 slug:string
 version:string
 files:{path:string;sha256:string;size:number}[]
}
export type MarketCatalogUpstreamSource=MarketCatalogUpstreamGithub|MarketCatalogUpstreamClawHub
export type MarketCatalogOrigin={marketplace:'claude-code'|'codex'|'dsh'|'openclaw'|'clawhub'|'hermes';installs:number|null;installsLabel:string;countedAt:string}
export type MarketCatalogAlternative={entryId:string;marketplace:'claude-code'|'codex'|'dsh'|'openclaw'|'clawhub'|'hermes'|'teloa';installs:number|null}
export type MarketCatalogUnsupportedComponent={kind:'agents'|'commands'|'hooks'|'lsp'|'scripts'|'mcp';count:number}
/** 上游固定来源技能条目：不含工件字节，用户添加时按 `upstream` 固定来源拉取并逐文件核对。 */
export type MarketCatalogUpstreamSkillEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'skill'
 delivery:'upstream'
 version:string
 taxonomy:MarketTaxonomy
 skill:{name:string;title:MarketCatalogText;summary:MarketCatalogText}
 upstream:MarketCatalogUpstreamSource
 origin:MarketCatalogOrigin
 alternatives:MarketCatalogAlternative[]
 unsupportedComponents:MarketCatalogUnsupportedComponent[]
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[]}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
 secrets?:MarketCatalogSkillSecret[]
}
/** AI 同事条目（规格 §5）：真源仍是方案 roles/<id>.json；definition = 该文件去掉 format；skills 来自方案 role-skill 关联。 */
export type MarketCatalogRoleDefinition={name:string;kind:'employee'|'twin';duty:string;dataScope:string;executionScope:string;responsibility:RoleResponsibility}
export type MarketCatalogRoleEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'role'
 delivery:'install'
 version:string
 upstream:null
 taxonomy:MarketTaxonomy
 role:{roleId:string;title:MarketCatalogText;summary:MarketCatalogText;definition:MarketCatalogRoleDefinition;skills:string[];scope:string;preferredModel:{entryId:string;fallback:'default'|'refuse'}|null;fromSolution:{packageId:string;version:string;path:string}}
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[];url:string}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
}
/** 模型目录只保存引用；权重和准备状态由对应原生服务管理，不进内容仓。 */
export type MarketCatalogModelApi='openai-completions'|'openai-responses'|'anthropic-messages'
export type MarketCatalogModelCloud={provider:{kind:'pi-ai';id:string}|{kind:'custom';api:MarketCatalogModelApi;baseURL:string};models:{id:string;name:string;contextWindow:number|null;maxTokens:number|null;input:('text'|'image')[]}[];priceBand:'low'|'mid'|'high'|null;credentialLabel:MarketCatalogText;signupUrl:string}
export type MarketCatalogModelLicense={spdx:string;name:string;url:string;tier:'commercial'|'restricted';restrictions:MarketCatalogText[]}
/** 二期本机模型（模型二期规格 §4）：Ollama 唯一运行时；名称必须带 tag，digest 为 registry 清单摘要或 null（发布前由脚本填写）。 */
export const ollamaModelNamePattern=/^[a-z0-9][a-z0-9._-]*:[a-z0-9._-]+$/
export const ollamaDigestPattern=/^sha256:[0-9a-f]{64}$/
export type MarketCatalogModelVariant={quant:string;format:'gguf';sizeBytes:number;sources:[{kind:'ollama';name:string;digest:string|null}];hardware:{minRamGb:number;recommendedRamGb:number;vramGb:number|null};models:{id:string;contextWindow:number;maxTokens:number;input:('text'|'image')[]}}
type MarketCatalogModelBase={modelId:string;title:MarketCatalogText;summary:MarketCatalogText;capabilities:{tools:boolean;vision:boolean;reasoning:boolean;structured:boolean};contextWindow:number|null;license:MarketCatalogModelLicense;cnReachable:'direct'|'mirror'|'proxy-required';support:'experimental'|'supported';notes:MarketCatalogText[]}
type MarketCatalogModelCommon=MarketCatalogModelBase&{usage:('chat'|'embedding'|'tool')[]}
/** 三种形态：cloud（云端路由）、local-general（本机 Ollama 通用聊天模型，带 variants）、local-specialist（DSH 本地语音或 Teloa 本地检索）。 */
export type MarketCatalogModelInfo=
 |(MarketCatalogModelCommon&{form:'cloud';cloud:MarketCatalogModelCloud;local:null;variants:null})
 |(MarketCatalogModelCommon&{form:'local-general';cloud:null;local:{runtime:'ollama'};variants:MarketCatalogModelVariant[]})
 |(MarketCatalogModelBase&{form:'local-specialist';usage:['speech-to-text'];native:{kind:'dsh-speech';providerId:'sensevoice-local'}})
 |(MarketCatalogModelBase&{form:'local-specialist';usage:['embedding'];native:{kind:'teloa-embedding';providerId:'qwen3-embedding-0.6b'}})
/** 本地垂类模型的已审绑定：用法决定唯一的原生准备器；`teloa-embedding` 是 Teloa 扩展而非 DSH 原生能力。 */
export type MarketCatalogLocalSpecialist=Extract<MarketCatalogModelInfo,{form:'local-specialist'}>
type LocalSpecialistBinding<T=MarketCatalogLocalSpecialist>=T extends {form:'local-specialist';usage:unknown;native:unknown}?Pick<T,'usage'|'native'>:never
export type MarketCatalogModelEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'model'
 delivery:'reference'
 version:string
 upstream:null
 taxonomy:MarketTaxonomy
 model:MarketCatalogModelInfo
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[];url:string}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
}
export type MarketCatalogEntry=MarketCatalogSkillEntry|MarketCatalogSolutionEntry|MarketCatalogConnectorEntry|MarketCatalogUpstreamSkillEntry|MarketCatalogRoleEntry|MarketCatalogModelEntry
export type MarketCatalogArtifactFile={path:string;sha256:string;size:number}
export type MarketCatalogArtifact={files:MarketCatalogArtifactFile[];treeHash:string}
/** 快照索引条目：上游条目不入快照；model 条目无工件（artifact 为 null）。 */
export type MarketCatalogIndexEntry=((MarketCatalogSkillEntry|MarketCatalogSolutionEntry|MarketCatalogConnectorEntry|MarketCatalogRoleEntry)&{artifact:MarketCatalogArtifact})|(MarketCatalogModelEntry&{artifact:null})
export type MarketCatalogIndex={format:'teloa.market-catalog/v1';catalogVersion:string;entries:MarketCatalogIndexEntry[]}
/** 宿主 `market-catalog/list` 回包条目；上游条目 artifact 为 null；`addedContentId` 未添加或内置条目为 null；`addedRoleId` 是本人按该 role 条目版本已建的岗位，非 role 条目恒为 null。 */
export type MarketCatalogListItem={entry:MarketCatalogEntry;artifact:MarketCatalogArtifact|null;addedContentId:string|null;addedRoleId:string|null}
/** 分页列表请求；不传任何字段等同于 `{}` 向后兼容（首页 Teloa 官方条目）。 */
export type MarketCatalogListRequest={cursor?:string;limit?:number;query?:string;kind?:MarketEntryKind;marketplace?:'teloa'|'claude-code'|'codex'|'dsh'|'openclaw'|'clawhub'|'hermes';sort?:'installs'|'name'}
/** counts 在过滤前对全量条目一次算出；skipped 来自最近一次采用的 v2 在线索引（无在线索引时全 0）。 */
export type MarketCatalogListCounts=Record<MarketEntryKind,number>
export type MarketCatalogListSkipped={unknownKind:number;newerApp:number}
export type MarketCatalogListResponse={catalogVersion:string;items:MarketCatalogListItem[];nextCursor:string|null;counts:MarketCatalogListCounts;skipped:MarketCatalogListSkipped}
export const emptyMarketCatalogCounts=():MarketCatalogListCounts=>({solution:0,role:0,skill:0,connector:0,model:0})

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const exact=(value:unknown,keys:readonly string[],label:string):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!Object.hasOwn(value,key)))throw bad(label+'格式不正确或包含未知字段。')
 return value
}
const text=(value:unknown,label:string,max=500):string=>{
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw bad(label+'必须填写且不超过 '+max+' 字。')
 return value
}
const list=(value:unknown,label:string,max:number):unknown[]=>{if(!Array.isArray(value)||value.length>max)throw bad(label+'最多 '+max+' 项。');return value}
const distinct=<T>(values:T[],label:string):T[]=>{if(new Set(values).size!==values.length)throw bad(label+'不能重复。');return values}
const pattern=(value:unknown,regex:RegExp,label:string):string=>{if(typeof value!=='string'||!regex.test(value))throw bad(label+'格式不正确。');return value}
const catalogId=/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,2}$/
// 只有 model 条目放宽到四段（teloa.model.local.<Ollama 名称去 tag>，如 teloa.model.local.llama3.1）；其余 kind 与冻结的 v1 读取器同为两段，v1 索引也不收 model。
/** 模型条目标识允许最多四段（如 `teloa.model.local.llama3.1`）；其余 kind 仍用两段 `catalogId`。 */
export const modelCatalogIdPattern=/^(?=.{1,120}$)[a-z0-9]+(?:-[a-z0-9]+)*(?:\.[a-z0-9]+(?:-[a-z0-9]+)*){1,4}$/
const modelCatalogId=modelCatalogIdPattern
/** 与 DSH 技能名同一文法（kebab-case，≤64）。 */
export const marketCatalogSkillName=/^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 方案包 id 文法（与 content-store.ts stableId 一致，1-120 位字母数字连字符）。 */
const packageIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
/** 业务范围（与 validateManifest scope 一致）。 */
const scopePattern=/^[a-zA-Z0-9_-]{1,64}$/
const semver=/^(?=.{1,80}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const hex40=/^[0-9a-f]{40}$/,hex64=/^[0-9a-f]{64}$/
const githubName=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
const httpsUrl=/^https:\/\/[^/].{0,1000}$/
export const MARKET_CATALOG_MAX_FILE_SIZE=2*1024*1024
export const MARKET_CATALOG_MAX_TOTAL_SIZE=20*1024*1024
export const MARKET_CATALOG_MAX_FILES=500
export const MARKET_CATALOG_FORBIDDEN_EXTENSIONS=/\.(?:py|sh|bash|zsh|js|mjs|cjs|ts|mts|cts|exe|bat|cmd|ps1|rb|pl|php)$/i
const MAX_FILE=MARKET_CATALOG_MAX_FILE_SIZE,MAX_TOTAL=MARKET_CATALOG_MAX_TOTAL_SIZE
const size=(value:unknown,label:string):number=>{if(!Number.isSafeInteger(value)||(value as number)<0||(value as number)>MAX_FILE)throw bad(label+'大小不正确。');return value as number}
function path(value:unknown,label:string):string{
 const result=text(value,label,500)
 if(result.startsWith('/')||result.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#]/.test(result))throw bad(label+'必须是安全的相对路径。')
 return result
}
function localized(value:unknown,label:string,max=500):MarketCatalogText{
 const row=exact(value,['zh-CN','en'],label)
 return {'zh-CN':text(row['zh-CN'],label+'（简体中文）',max),en:text(row.en,label+'（英文）',max)}
}
const secretEnvVar=/^[A-Z][A-Z0-9_]{1,63}$/
const secretHeaderName=/^[A-Za-z][A-Za-z0-9-]{0,63}$/
const secretQueryName=/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/
const secretSkillName=/^[a-z][a-z0-9-]{0,63}$/
// 精确 origin：https、小写主机名、至少两段、末段字母；端口、路径、账号、通配、IPv4/IPv6 字面量、localhost 均不匹配。
const secretOrigin=/^https:\/\/(?=[a-z0-9.-]{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/
// 特殊用途 / 本地顶级域（RFC 6761、RFC 6762、RFC 8375、RFC 7686 与常见内网后缀）：运行时另有公网单播校验兜底，这里在声明期先拒。
const secretForbiddenTlds=new Set(['localhost','local','internal','arpa','test','invalid','example','onion','lan','home','corp','localdomain','intranet','private'])
// 与规格 §5.1-5 模型请求头禁用集同源：注入头名不得占用这些头。
const forbiddenSecretHeaders=new Set(['authorization','cookie','host','proxy-authorization','content-length','transfer-encoding','connection','te','upgrade','keep-alive','expect','trailer','forwarded'])
const forbiddenSecretHeaderPrefixes=['proxy-','x-forwarded-']
export function isForbiddenSecretHeader(name:string):boolean{
 const lower=name.toLowerCase()
 return forbiddenSecretHeaders.has(lower)||forbiddenSecretHeaderPrefixes.some(prefix=>lower.startsWith(prefix))
}
export const skillSecretMaxPathLength=2048
// 路径只收 RFC 3986 pchar（去掉 `;` 参数段）与 `/`；百分号只允许编码「非分隔、非点、非 %、非控制、ASCII」字节。
const secretSafePath=/^\/[A-Za-z0-9\-._~!$&'()*+,=:@\/%]*$/
const secretBadEncoding=/%(?![2-7][0-9a-f])|%(?:2f|5c|2e|25|3b|3f|23|7f)/i
/**
 * 声明期与运行期共用的路径守卫：拒绝编码分隔（%2F %5C）、编码点（%2E）、双重编码（%25xx）、编码控制 / 非 ASCII 字节、
 * 反斜杠、`;` 参数段、`.`/`..` 段、连续斜杠、非 ASCII、空段以外的怪形态与超长路径；WHATWG 规范化后必须与原文一致。
 */
export function skillSecretPathSafe(pathname:string):boolean{
 if(typeof pathname!=='string'||pathname.length>skillSecretMaxPathLength||!secretSafePath.test(pathname)||secretBadEncoding.test(pathname))return false
 if(pathname.includes('//')||pathname.split('/').some(seg=>seg==='.'||seg==='..'))return false
 try{return new URL('https://h'+pathname).pathname===pathname}catch{return false}
}
function readSecretPathPrefix(value:unknown):string{
 if(typeof value!=='string'||value.length>256||!skillSecretPathSafe(value))throw bad('技能密钥路径前缀格式不正确。')
 return value
}
/**
 * 入参须为 `new URL(url).pathname`。先过 skillSecretPathSafe（服务端规范化差异一律不放行），再按段匹配：
 * `/` 匹配整个 origin；`/v1` 匹配 `/v1` 与 `/v1/x`，不匹配 `/v10`、`/v1x`。
 */
export function skillSecretPathAllowed(pathname:string,prefixes:readonly string[]):boolean{
 if(!skillSecretPathSafe(pathname))return false
 return prefixes.some(prefix=>prefix==='/'||pathname===prefix||pathname.startsWith(prefix.endsWith('/')?prefix:prefix+'/'))
}
/** 技能密钥声明：只声明变量名、注入位置与目标地址，绝不含值。 */
export function readSkillSecrets(value:unknown,skillName:string):MarketCatalogSkillSecret[]{
 const rows=list(value,'技能密钥声明',8)
 if(!rows.length)throw bad('技能密钥声明至少一项。')
 if(!secretSkillName.test(skillName))throw bad('声明密钥的技能名必须是小写字母开头的连字符标识。')
 const secrets=rows.map(input=>{
  const named=isRecord(input)&&(input.target==='header'||input.target==='query')
  const keys=['envVarName','label','required','target','endpoints',...(named?['name']:[]),...(isRecord(input)&&input.methods!==undefined?['methods']:[])]
  const row=exact(input,keys,'技能密钥声明')
  if(row.target!=='bearer'&&row.target!=='header'&&row.target!=='query')throw bad('技能密钥注入位置只能是 bearer、header 或 query。')
  if(typeof row.required!=='boolean')throw bad('技能密钥 required 必须是布尔值。')
  const endpointRows=list(row.endpoints,'技能密钥目标地址',4)
  if(!endpointRows.length)throw bad('技能密钥目标地址至少一项。')
  const endpoints=endpointRows.map(item=>{
   const ep=exact(item,['origin','pathPrefixes'],'技能密钥目标地址')
   const origin=pattern(ep.origin,secretOrigin,'技能密钥目标地址 origin')
   if(secretForbiddenTlds.has(origin.slice(origin.lastIndexOf('.')+1)))throw bad('技能密钥目标地址 origin 不能是本地或特殊用途域名。')
   const prefixes=distinct(list(ep.pathPrefixes,'技能密钥路径前缀',8).map(readSecretPathPrefix),'技能密钥路径前缀')
   if(!prefixes.length)throw bad('技能密钥路径前缀至少一项。')
   return {origin,pathPrefixes:prefixes}
  })
  distinct(endpoints.map(ep=>ep.origin),'技能密钥目标地址 origin')
  const methods=row.methods===undefined?['GET','POST'] as SkillSecretMethod[]:distinct(list(row.methods,'技能密钥方法',5).map(m=>{if(!(skillSecretMethods as readonly unknown[]).includes(m))throw bad('技能密钥方法只能是 GET、POST、PUT、PATCH、DELETE。');return m as SkillSecretMethod}),'技能密钥方法')
  if(!methods.length)throw bad('技能密钥方法至少一项。')
  const envVarName=pattern(row.envVarName,secretEnvVar,'技能密钥变量名')
  if(envVarName===skillSecretBindingSlot)throw bad('技能密钥变量名为保留名。')
  const secret:MarketCatalogSkillSecret={envVarName,label:localized(row.label,'技能密钥名称',120),required:row.required,target:row.target,endpoints,methods}
  if(named){
   const name=pattern(row.name,row.target==='header'?secretHeaderName:secretQueryName,'技能密钥注入名')
   if(row.target==='header'&&isForbiddenSecretHeader(name))throw bad('技能密钥注入头名不允许。')
   secret.name=name
  }
  return secret
 })
 distinct(secrets.map(secret=>secret.envVarName),'技能密钥变量名')
 distinct(secrets.map(secret=>secret.target==='bearer'?'header:authorization':secret.target==='header'?'header:'+secret.name!.toLowerCase():'query:'+secret.name!),'技能密钥注入位置')
 return secrets
}
/** 带 `secrets` 的条目版本闸（计划关键决定 9）：旧应用不认识 secrets，条目必须把不认识的版本排除在兼容范围外，并声明依赖宿主工具。 */
function readSkillSecretGate(entry:{compatibility:{status:MarketCatalogCompatibility;teloa:string};requires:{tools:string[]}}):void{
 if(entry.compatibility.status!=='needs-configuration')throw bad('声明密钥的技能条目兼容状态必须是 needs-configuration。')
 if(teloaRangeSatisfies(entry.compatibility.teloa,skillSecretLastUnsupportedTeloa))throw bad('声明密钥的技能条目 Teloa 兼容范围不能包含 '+skillSecretLastUnsupportedTeloa+' 及更早版本。')
 if(!entry.requires.tools.includes(skillSecretHttpTool))throw bad('声明密钥的技能条目 requires.tools 必须包含 '+skillSecretHttpTool+'。')
}
function date(value:unknown,label:string):string{
 const result=pattern(value,/^\d{4}-\d{2}-\d{2}$/,label),parsed=new Date(result+'T00:00:00.000Z')
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==result)throw bad(label+'不是有效日期。')
 return result
}

// 公共字段：两种 kind 的 modifications/license/compatibility/requires/review 读法相同。
function readCommonFields(row:Record<string,unknown>,opts:{allowEmptyLicenseFiles?:boolean;licenseUrl?:boolean}={}){
 const licenseRow=exact(row.license,opts.licenseUrl?['spdx','files','url']:['spdx','files'],'许可')
 const licenseFiles=distinct(list(licenseRow.files,'许可文件',20).map(file=>path(file,'许可文件路径')),'许可文件')
 if(!licenseFiles.length&&!opts.allowEmptyLicenseFiles)throw bad('许可文件至少一项。')
 const compatibilityRow=exact(row.compatibility,['status','teloa','dsh','conditions'],'兼容声明')
 if(!(marketCatalogCompatibility as readonly unknown[]).includes(compatibilityRow.status))throw bad('兼容状态只能是 verified、needs-configuration、content-only 或 unsupported。')
 // 范围在收录时就要能解析；否则应用端 teloaRangeSatisfies 会静默 false，把条目误计入「需更新应用」。
 const teloaRange=text(compatibilityRow.teloa,'Teloa 兼容范围',120)
 try{parseTeloaRange(teloaRange)}catch{throw bad('Teloa 兼容范围格式不正确：'+teloaRange)}
 const requiresRow=exact(row.requires,['tools','network','runtimes'],'运行需求')
 if(typeof requiresRow.network!=='boolean')throw bad('联网需求必须是布尔值。')
 const reviewRow=exact(row.review,['status','reviewedAt','reviewer'],'审核记录')
 if(reviewRow.status!=='approved')throw bad('目录只收录审核通过的条目。')
 return {
  modifications:list(row.modifications,'修改说明',50).map(item=>localized(item,'修改说明',1000)),
  license:{spdx:text(licenseRow.spdx,'许可',200),files:licenseFiles,...(opts.licenseUrl?{url:pattern(licenseRow.url,httpsUrl,'许可链接')}:{})},
  compatibility:{status:compatibilityRow.status as MarketCatalogCompatibility,teloa:teloaRange,dsh:text(compatibilityRow.dsh,'DSH 兼容范围',120),conditions:list(compatibilityRow.conditions,'兼容条件',20).map(item=>localized(item,'兼容条件'))},
  requires:{tools:distinct(list(requiresRow.tools,'所需工具',50).map(item=>pattern(item,/^[A-Za-z0-9_:.-]{1,120}$/,'工具名')),'所需工具'),network:requiresRow.network as boolean,runtimes:distinct(list(requiresRow.runtimes,'运行时',20).map(item=>text(item,'运行时',120)),'运行时')},
  review:{status:'approved' as const,reviewedAt:date(reviewRow.reviewedAt,'审核日期'),reviewer:text(reviewRow.reviewer,'审核人',200)},
 }
}

function readSkillUpstream(value:unknown):NonNullable<MarketCatalogSkillEntry['upstream']>{
 const upstreamRow=exact(value,['ecosystem','author','repository','commit','path','license','files'],'上游来源')
 const repositoryRow=exact(upstreamRow.repository,['host','owner','repo'],'上游仓库')
 if(repositoryRow.host!=='github.com')throw bad('上游仓库目前只支持 github.com。')
 const upstreamFiles=list(upstreamRow.files,'上游文件',500).map(input=>{const file=exact(input,['path','gitBlob','size'],'上游文件');return {path:path(file.path,'上游文件路径'),gitBlob:pattern(file.gitBlob,hex40,'上游文件 blob 摘要'),size:size(file.size,'上游文件')}})
 if(!upstreamFiles.length)throw bad('上游文件至少一项。')
 distinct(upstreamFiles.map(file=>file.path),'上游文件路径')
 return {ecosystem:pattern(upstreamRow.ecosystem,/^[a-z0-9-]{1,40}$/,'上游生态'),author:text(upstreamRow.author,'上游作者',200),repository:{host:'github.com',owner:pattern(repositoryRow.owner,githubName,'上游仓库 owner'),repo:pattern(repositoryRow.repo,githubName,'上游仓库名')},commit:pattern(upstreamRow.commit,hex40,'上游提交'),path:path(upstreamRow.path,'上游目录'),license:text(upstreamRow.license,'上游许可',200),files:upstreamFiles}
}

function readSkillEntry(row:Record<string,unknown>):MarketCatalogSkillEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='builtin'&&row.delivery!=='install')throw bad('目录条目交付方式只能是 builtin 或 install。')
 const skillRow=exact(row.skill,['name','title','summary'],'技能信息')
 const name=pattern(skillRow.name,marketCatalogSkillName,'技能名')
 if(row.delivery==='builtin'&&!name.startsWith('teloa-'))throw bad('内置技能名必须以 teloa- 开头。')
 if(row.delivery==='install'&&name.startsWith('teloa-'))throw bad('teloa- 前缀保留给内置技能，安装型条目不能使用。')
 if(row.upstream===null&&row.delivery!=='builtin')throw bad('只有 Teloa 内置技能的 upstream 可以为 null。')
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'skill',delivery:row.delivery as 'builtin'|'install',version:pattern(row.version,semver,'条目版本'),
  taxonomy:readMarketTaxonomy(row.taxonomy),
  skill:{name,title:localized(skillRow.title,'技能标题',120),summary:localized(skillRow.summary,'技能用途')},
  upstream:row.upstream===null?null:readSkillUpstream(row.upstream),
  ...readCommonFields(row),
 }
}

function readSolutionEntry(row:Record<string,unknown>):MarketCatalogSolutionEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='install')throw bad('方案条目只能以 install 方式交付。')
 if(row.upstream!==null)throw bad('方案条目的 upstream 必须为 null。')
 const solutionRow=exact(row.solution,['packageId','title','summary','scope','capabilities'],'方案信息')
 const packageId=pattern(solutionRow.packageId,packageIdPattern,'方案包标识')
 const capabilitiesRow=exact(solutionRow.capabilities,['now','needs','permissions'],'方案能力说明')
 const capabilityList=(value:unknown,label:string)=>{const items=list(value,label,20);if(!items.length)throw bad(label+'至少一项。');return items.map(item=>localized(item,label,300))}
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'solution',delivery:'install',version:pattern(row.version,semver,'条目版本'),upstream:null,
  taxonomy:readMarketTaxonomy(row.taxonomy),
  solution:{packageId,title:localized(solutionRow.title,'方案标题',120),summary:localized(solutionRow.summary,'方案用途'),scope:pattern(solutionRow.scope,scopePattern,'业务范围'),capabilities:{now:capabilityList(capabilitiesRow.now,'现在可做'),needs:capabilityList(capabilitiesRow.needs,'还需提供'),permissions:capabilityList(capabilitiesRow.permissions,'会请求的权限')}},
  ...readCommonFields(row),
 }
}

const npmPackageName=/^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const sha512Integrity=/^sha512-[A-Za-z0-9+/]+=*$/
/** connector serverName：在 dsh-mcp-client 的 SERVER_NAME_PATTERN 之内，另禁 `__`（公开名 `mcp__<server>__<tool>` 按 `__` 分段）。 */
const connectorServerName=/^(?!.*__)[A-Za-z0-9_-]{1,32}$/
/** env 变量名：允许混合大小写（部分官方包如 dingtalk-mcp 使用混合大小写变量名）。 */
const envVarName=/^[A-Za-z][A-Za-z0-9_]{0,127}$/
/** 宿主写入的 OAuth 凭据槽前缀：env 变量名不得占用，避免与 oauth_* 槽同名 */
const reservedEnvVarPrefix=/^oauth_/i
/** OAuth scope 记号：RFC 6749 §3.3 scope-token 字符集（不含空格、引号、反斜杠）。 */
const oauthScope=/^[\x21\x23-\x5B\x5D-\x7E]{1,200}$/

function unreservedEnvVarName(name:string):string{
 if(reservedEnvVarPrefix.test(name))throw bad('环境变量名不得以 oauth_ 开头（为宿主 OAuth 凭据槽保留）。')
 return name
}

// clientIdPattern 的原子：字面字符、`.`、\d \w \s 及大写、转义的语法字符，或不嵌套的字符类
const clientIdPatternAtom=/^(?:[^\\^$.|?*+()[\]{}]|\.|\\[dDwWsS]|\\[-\\^$.|?*+()[\]{}/]|\[\^?(?:[^\\[\]]|\\[dDwWsS]|\\[-\\^$.|?*+()[\]{}/])+\])/
// 单层贪婪量词：* + ? {n} {n,} {n,m}（n、m 至多三位）
const clientIdPatternQuantifier=/^(?:[*+?]|\{\d{1,3}(,(\d{1,3})?)?\})/

/** 配方声明的 client_id 正则：首尾锚定的短正则，只由简单原子加至多一层贪婪量词组成，可变长量词至多 2 个，避免回溯爆炸 */
function safeClientIdPattern(value:unknown):string{
 if(typeof value!=='string'||value.length<3||value.length>100)throw bad('clientIdPattern 必须是 3 到 100 个字符的正则。')
 if(!value.startsWith('^')||!value.endsWith('$')||value.endsWith('\\$'))throw bad('clientIdPattern 必须首尾锚定（^…$）。')
 let rest=value.slice(1,-1),variable=0
 while(rest){
  const atom=clientIdPatternAtom.exec(rest)
  if(!atom)throw bad('clientIdPattern 只能由字面字符、\\d \\w \\s、字符类加单层量词组成（不得使用分组、选择、反向引用或嵌套 / 相邻量词）。')
  rest=rest.slice(atom[0].length)
  const quantifier=clientIdPatternQuantifier.exec(rest)
  if(!quantifier)continue
  rest=rest.slice(quantifier[0].length)
  if(!quantifier[0].startsWith('{')||quantifier[1]!==undefined)variable++
  if(variable>2)throw bad('clientIdPattern 的可变长量词不得超过 2 个。')
 }
 try{new RegExp(value,'u')}catch{throw bad('clientIdPattern 不是合法正则。')}
 return value
}

function readConnectorEntry(row:Record<string,unknown>):MarketCatalogConnectorEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='managed')throw bad('连接器条目只能以 managed 方式交付。')
 if(row.upstream!==null)throw bad('连接器条目的 upstream 必须为 null。')
 const connRow=exact(row.connector,['serverName','title','summary','auth','recipe','tools','upstreamUrl'],'连接器信息')
 const serverName=pattern(connRow.serverName,connectorServerName,'连接器服务名')
 // 认证建模：none、secret（env/bearer）、oauth（supported 必填：true 带 scopes，false 带 reason）
 const authRow=isRecord(connRow.auth)?connRow.auth:null
 if(!authRow)throw bad('连接器认证格式不正确。')
 let auth:ConnectorAuth
 if(authRow.kind==='none'){
  exact(connRow.auth,['kind'],'none 认证');auth={kind:'none'}
 }else if(authRow.kind==='secret'){
  const ar=exact(connRow.auth,['kind','vars'],'secret 认证')
  const vars=list(ar.vars,'凭据变量',20).map(v=>{
   const vRow=isRecord(v)?v:null
   if(!vRow)throw bad('凭据变量格式不正确。')
   if(typeof vRow.required!=='boolean')throw bad('凭据 required 必须是布尔值。')
   if(vRow.target==='env'){
    const vr=exact(v,['target','envVarName','label','required'],'env 凭据变量')
    return {target:'env' as const,envVarName:unreservedEnvVarName(pattern(vr.envVarName,envVarName,'环境变量名')),label:localized(vr.label,'凭据说明'),required:vr.required as boolean}
   }else if(vRow.target==='bearer'){
    const vr=exact(v,['target','label','required'],'bearer 凭据变量')
    return {target:'bearer' as const,label:localized(vr.label,'凭据说明'),required:vr.required as boolean}
   }else if(vRow.target==='url-path'){
    const vr=exact(v,['target','label','required'],'url-path 凭据变量')
    return {target:'url-path' as const,label:localized(vr.label,'凭据说明'),required:vr.required as boolean}
   }throw bad('凭据变量 target 只支持 env、bearer 或 url-path。')
  })
  auth={kind:'secret',vars:vars as ConnectorAuthSecretVar[]}
 }else if(authRow.kind==='oauth'){
  if(typeof authRow.supported!=='boolean')throw bad('oauth 认证的 supported 必须是布尔值。')
  if(authRow.supported){
   // requiresUserClientId / requiresAllowlist 可选：键必须在白名单内，但不要求齐全
   const ar=authRow
   if(Object.keys(ar).some(key=>!['kind','supported','scopes','requiresUserClientId','requiresAllowlist','clientIdPattern'].includes(key)))throw bad('oauth 认证格式不正确或包含未知字段。')
   const scopes=list(ar.scopes,'OAuth scope',50).map(s=>pattern(s,oauthScope,'OAuth scope'))
   if(new Set(scopes).size!==scopes.length)throw bad('OAuth scope 不能重复。')
   const oauth:ConnectorAuthOAuth={kind:'oauth',supported:true,scopes}
   if(ar.requiresUserClientId!==undefined){if(typeof ar.requiresUserClientId!=='boolean')throw bad('requiresUserClientId 必须是布尔值。');oauth.requiresUserClientId=ar.requiresUserClientId}
   if(ar.clientIdPattern!==undefined){
    if(oauth.requiresUserClientId!==true)throw bad('clientIdPattern 只能用于 requiresUserClientId:true 的连接器。')
    oauth.clientIdPattern=safeClientIdPattern(ar.clientIdPattern)
   }
   if(ar.requiresAllowlist!==undefined){if(typeof ar.requiresAllowlist!=='boolean')throw bad('requiresAllowlist 必须是布尔值。');oauth.requiresAllowlist=ar.requiresAllowlist}
   auth=oauth
  }else{
   const ar=exact(connRow.auth,['kind','supported','reason'],'oauth 认证')
   auth={kind:'oauth',supported:false,reason:text(ar.reason,'OAuth 不支持原因',500)}
  }
 }else{throw bad('连接器认证类型只支持 none、secret 或 oauth。')}
 const recipeRow=isRecord(connRow.recipe)?connRow.recipe:null
 if(!recipeRow)throw bad('连接器配方格式不正确。')
 let recipe:MarketCatalogConnectorRecipe
 if(recipeRow.transport==='stdio'){
  const r=exact(connRow.recipe,['transport','package','version','integrity','bin','args'],'stdio 配方')
  const pkg=pattern(r.package,npmPackageName,'npm 包名')
  const ver=pattern(r.version,semver,'npm 包版本')
  const integ=pattern(r.integrity,sha512Integrity,'npm 包 integrity')
  const binPath=path(r.bin,'bin 路径')
  const args=list(r.args,'固定参数',50).map(a=>text(a,'参数',1000))
  recipe={transport:'stdio',package:pkg,version:ver,integrity:integ,bin:binPath,args}
 }else if(recipeRow.transport==='streamable-http'){
  const r=exact(connRow.recipe,['transport','url'],'streamable-http 配方')
  const url=pattern(r.url,httpsUrl,'远程地址')
  recipe={transport:'streamable-http',url}
 }else if(recipeRow.transport==='streamable-http-template'){
  const r=exact(connRow.recipe,['transport','urlTemplate'],'streamable-http-template 配方')
  const tmpl=text(r.urlTemplate,'URL 模板',500)
  const parts=tmpl.split('{secret}')
  if(parts.length!==2)throw bad('URL 模板必须恰好包含一个 {secret} 占位符。')
  const prefix=parts[0]!
  if(!/^https:\/\/[^/]/.test(prefix))throw bad('URL 模板的固定前缀必须以有效的 https:// 主机名开头。')
  recipe={transport:'streamable-http-template',urlTemplate:tmpl}
 }else{throw bad('连接器传输类型只支持 stdio、streamable-http 或 streamable-http-template。')}
 // 传输类型与凭据类型交叉验证：env 只能用于 stdio；bearer 只能用于 streamable-http；url-path 只能用于 streamable-http-template
 if(auth.kind==='secret'){
  for(const v of auth.vars){
   if(v.target==='env'&&recipe.transport!=='stdio')throw bad(`env 凭据变量只对 stdio 传输有意义（当前传输：${recipe.transport}）。`)
   if(v.target==='bearer'&&recipe.transport==='stdio')throw bad('bearer 凭据变量对 stdio 传输无意义（stdio 通过环境变量传递凭据）。')
   if(v.target==='bearer'&&recipe.transport==='streamable-http-template')throw bad('bearer 凭据变量对 streamable-http-template 无意义，请改用 url-path。')
   if(v.target==='url-path'&&recipe.transport!=='streamable-http-template')throw bad(`url-path 凭据变量只对 streamable-http-template 传输有意义（当前传输：${recipe.transport}）。`)
  }
 }
 const tools=list(connRow.tools,'工具列表',200).map(t=>{
  const tr=exact(t,['name','description','readOnly'],'工具')
  if(typeof tr.readOnly!=='boolean')throw bad('工具 readOnly 必须是布尔值。')
  return {name:text(tr.name,'工具名',120),description:localized(tr.description,'工具说明'),readOnly:tr.readOnly as boolean}
 })
 const upstreamUrl=text(connRow.upstreamUrl,'上游地址',500)
 const common=readCommonFields(row)
 // OAuth 与兼容状态交叉校验：白名单制条目须 needs-configuration 并写明条件；不支持 OAuth 的条目须 unsupported
 if(auth.kind==='oauth'&&auth.supported&&auth.requiresAllowlist&&(common.compatibility.status!=='needs-configuration'||common.compatibility.conditions.length===0))throw bad('requiresAllowlist 的连接器兼容状态必须是 needs-configuration，并在兼容条件中写明白名单要求。')
 if(auth.kind==='oauth'&&auth.supported&&recipe.transport!=='streamable-http')throw bad('supported:true 的 OAuth 连接器配方必须是 streamable-http（固定 https 地址）。')
 if(auth.kind==='oauth'&&!auth.supported&&common.compatibility.status!=='unsupported')throw bad('supported:false 的 OAuth 连接器兼容状态必须是 unsupported。')
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'connector',delivery:'managed',version:pattern(row.version,semver,'条目版本'),upstream:null,
  taxonomy:readMarketTaxonomy(row.taxonomy),
  connector:{serverName,title:localized(connRow.title,'连接器标题',120),summary:localized(connRow.summary,'连接器用途'),auth,recipe,tools,upstreamUrl},
  ...common,
 }
}

function readUpstreamSkillEntry(row:Record<string,unknown>):MarketCatalogUpstreamSkillEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='upstream')throw bad('上游条目交付方式必须是 upstream。')
 const skillRow=exact(row.skill,['name','title','summary'],'技能信息')
 const name=pattern(skillRow.name,marketCatalogSkillName,'技能名')
 if(name.startsWith('teloa-'))throw bad('teloa- 前缀保留给内置技能，上游条目不能使用。')
 const upRow=isRecord(row.upstream)?row.upstream:null
 if(!upRow)throw bad('上游来源格式不正确。')
 let upstream:MarketCatalogUpstreamSource
 if(upRow.kind==='github'){
  const u=exact(row.upstream,['kind','repository','commit','path','files'],'GitHub 上游')
  const repoRow=exact(u.repository,['host','owner','repo'],'上游仓库')
  if(repoRow.host!=='github.com')throw bad('上游仓库目前只支持 github.com。')
  const files=list(u.files,'上游文件',500).map(input=>{
   const file=exact(input,['path','gitBlob','size'],'上游文件')
   return {path:path(file.path,'上游文件路径'),gitBlob:pattern(file.gitBlob,hex40,'上游文件 blob 摘要'),size:file.size===null?null:size(file.size,'上游文件')}
  })
  distinct(files.map(f=>f.path),'上游文件路径')
  upstream={kind:'github',repository:{host:'github.com',owner:pattern(repoRow.owner,githubName,'上游仓库 owner'),repo:pattern(repoRow.repo,githubName,'上游仓库名')},commit:pattern(u.commit,hex40,'上游提交'),path:path(u.path,'上游目录'),files}
 }else if(upRow.kind==='clawhub'){
  const u=exact(row.upstream,['kind','owner','slug','version','files'],'ClawHub 上游')
  const files=list(u.files,'上游文件',500).map(input=>{
   const file=exact(input,['path','sha256','size'],'上游文件')
   return {path:path(file.path,'上游文件路径'),sha256:pattern(file.sha256,hex64,'上游文件摘要'),size:size(file.size,'上游文件')}
  })
  distinct(files.map(f=>f.path),'上游文件路径')
  upstream={kind:'clawhub',owner:text(u.owner,'ClawHub 作者',200),slug:pattern(u.slug,marketCatalogSkillName,'ClawHub 技能名'),version:text(u.version,'ClawHub 版本',80),files}
 }else{throw bad('上游来源类型只支持 github 或 clawhub。')}
 const origRow=exact(row.origin,['marketplace','installs','installsLabel','countedAt'],'来源信息')
 const marketplaces=['claude-code','codex','dsh','openclaw','clawhub','hermes'] as const
 if(!(marketplaces as readonly unknown[]).includes(origRow.marketplace))throw bad('来源市场不支持。')
 if(origRow.installs!==null&&(!Number.isSafeInteger(origRow.installs)||(origRow.installs as number)<0))throw bad('安装量必须是非负整数或 null。')
 const origin:MarketCatalogOrigin={marketplace:origRow.marketplace as MarketCatalogOrigin['marketplace'],installs:origRow.installs as number|null,installsLabel:text(origRow.installsLabel,'安装量显示文本',200),countedAt:date(origRow.countedAt,'统计日期')}
 const altMarketplaces=[...marketplaces,'teloa'] as const
 const alternatives=list(row.alternatives,'其他来源',50).map(input=>{
  const alt=exact(input,['entryId','marketplace','installs'],'替代条目')
  if(!(altMarketplaces as readonly unknown[]).includes(alt.marketplace))throw bad('替代条目来源不支持。')
  if(alt.installs!==null&&(!Number.isSafeInteger(alt.installs)||(alt.installs as number)<0))throw bad('替代安装量必须是非负整数或 null。')
  return {entryId:pattern(alt.entryId,catalogId,'替代条目标识'),marketplace:alt.marketplace as MarketCatalogAlternative['marketplace'],installs:alt.installs as number|null}
 })
 const unsupportedKinds=['agents','commands','hooks','lsp','scripts','mcp'] as const
 const unsupportedComponents=list(row.unsupportedComponents,'不支持的组件',20).map(input=>{
  const comp=exact(input,['kind','count'],'不支持的组件')
  if(!(unsupportedKinds as readonly unknown[]).includes(comp.kind))throw bad('不支持的组件类型不正确。')
  if(!Number.isSafeInteger(comp.count)||(comp.count as number)<1)throw bad('不支持的组件数量必须是正整数。')
  return {kind:comp.kind as MarketCatalogUnsupportedComponent['kind'],count:comp.count as number}
 })
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'skill',delivery:'upstream',version:pattern(row.version,semver,'条目版本'),
  taxonomy:readMarketTaxonomy(row.taxonomy),
  skill:{name,title:localized(skillRow.title,'技能标题',120),summary:localized(skillRow.summary,'技能用途')},
  upstream,origin,alternatives,unsupportedComponents,
  ...readCommonFields(row,{allowEmptyLicenseFiles:true}),
 }
}

const roleIdPattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
function readRoleEntry(row:Record<string,unknown>):MarketCatalogRoleEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='install')throw bad('AI 同事条目只能以 install 方式交付。')
 if(row.upstream!==null)throw bad('AI 同事条目的 upstream 必须为 null。')
 const roleRow=exact(row.role,['roleId','title','summary','definition','skills','scope','preferredModel','fromSolution'],'岗位信息')
 const definitionRow=exact(roleRow.definition,['name','kind','duty','dataScope','executionScope','responsibility'],'岗位定义')
 // 用契约的岗位读法校验字段边界；scopes/skills/knowledge 不属于条目，创建时才补。
 let checked
 try{checked=roleDefinition({...definitionRow,scopes:['general'],skills:[],knowledge:[]})}catch{throw bad('岗位定义不合法。')}
 if(!checked.responsibility)throw bad('岗位定义必须包含结构化职责。')
 const definition:MarketCatalogRoleDefinition={name:checked.name,kind:checked.kind,duty:checked.duty,dataScope:checked.dataScope,executionScope:checked.executionScope,responsibility:checked.responsibility}
 const skills=distinct(list(roleRow.skills,'依赖技能',30).map(item=>pattern(item,marketCatalogSkillName,'技能名')),'依赖技能')
 let preferredModel:MarketCatalogRoleEntry['role']['preferredModel']=null
 if(roleRow.preferredModel!==null){
  const pm=exact(roleRow.preferredModel,['entryId','fallback'],'首选模型')
  if(pm.fallback!=='default'&&pm.fallback!=='refuse')throw bad('首选模型回退策略只能是 default 或 refuse。')
  preferredModel={entryId:pattern(pm.entryId,catalogId,'首选模型条目标识'),fallback:pm.fallback}
 }
 const fromRow=exact(roleRow.fromSolution,['packageId','version','path'],'来源方案')
 const fromSolution={packageId:pattern(fromRow.packageId,packageIdPattern,'来源方案包标识'),version:pattern(fromRow.version,semver,'来源方案版本'),path:path(fromRow.path,'来源方案内路径')}
 if(!/^roles\/[a-z0-9-]+\.json$/.test(fromSolution.path))throw bad('来源方案内路径必须是 roles/<id>.json。')
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'role',delivery:'install',version:pattern(row.version,semver,'条目版本'),upstream:null,
  taxonomy:readMarketTaxonomy(row.taxonomy),
  role:{roleId:pattern(roleRow.roleId,roleIdPattern,'岗位标识'),title:localized(roleRow.title,'岗位标题',120),summary:localized(roleRow.summary,'岗位用途'),definition,skills,scope:pattern(roleRow.scope,scopePattern,'业务范围'),preferredModel,fromSolution},
  ...(readCommonFields(row,{allowEmptyLicenseFiles:true,licenseUrl:true}) as ReturnType<typeof readCommonFields>&{license:{spdx:string;files:string[];url:string}}),
 }
}

const modelApis:readonly MarketCatalogModelApi[]=['openai-completions','openai-responses','anthropic-messages']
const piAiProviderId=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const bool=(value:unknown,label:string):boolean=>{if(typeof value!=='boolean')throw bad(label+'必须是布尔值。');return value}
const nullableInt=(value:unknown,label:string):number|null=>{if(value===null)return null;if(!Number.isSafeInteger(value)||(value as number)<1)throw bad(label+'必须是正整数或 null。');return value as number}
const localSpecialistBindings:readonly LocalSpecialistBinding[]=[
 {usage:['speech-to-text'],native:{kind:'dsh-speech',providerId:'sensevoice-local'}},
 {usage:['embedding'],native:{kind:'teloa-embedding',providerId:'qwen3-embedding-0.6b'}},
]
function readNativeModel(value:unknown,usage:readonly string[]):LocalSpecialistBinding{
 const native=exact(value,['kind','providerId'],'原生模型')
 // 只开放已核对的原生准备器；目录不能指定任意代码、下载地址或安装命令。用法与绑定一一对应，错配即拒。
 const binding=localSpecialistBindings.find(item=>item.native.kind===native.kind&&item.native.providerId===native.providerId)
 if(!binding)throw bad('尚不支持这个原生模型准备器。')
 if(usage.length!==1||usage[0]!==binding.usage[0])throw bad('模型用法与原生模型准备器不匹配。')
 return structuredClone(binding)
}
function readModelEntry(row:Record<string,unknown>):MarketCatalogModelEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='reference')throw bad('模型条目只能以 reference 方式交付，准备过程由原生服务管理。')
 if(row.upstream!==null)throw bad('模型条目的 upstream 必须为 null。')
 if(!isRecord(row.model))throw bad('模型信息格式不正确。')
 if(row.model.form==='local-vertical')throw bad('form local-vertical 属三期，本期不收。')
 if(!['cloud','local-general','local-specialist'].includes(String(row.model.form)))throw bad('模型形态只支持 cloud、local-general 或 local-specialist。')
 const specialist=row.model.form==='local-specialist'
 // 容缺：本契约之前发布的云端条目没有 local / variants 键（在线 v2 索引与旧快照仍在流通），缺失按 null 读；本机通用条目仍须显式给出。原生垂类条目只带 native，不带 cloud/local/variants。
 const m=specialist
  ?exact(row.model,['modelId','title','summary','form','usage','capabilities','contextWindow','license','cnReachable','support','notes','native'],'模型信息')
  :exact({local:null,variants:null,...row.model},['modelId','title','summary','form','usage','capabilities','contextWindow','license','cnReachable','support','notes','cloud','local','variants'],'模型信息')
 const usage=distinct(list(m.usage,'模型用法',3).map(item=>{if(specialist?item!=='speech-to-text'&&item!=='embedding':item!=='chat'&&item!=='embedding'&&item!=='tool')throw bad(specialist?'模型用法与运行形态不匹配。':'模型用法只能是 chat、embedding 或 tool。');return item}),'模型用法')
 if(!usage.length)throw bad('模型用法至少一项。')
 const cap=exact(m.capabilities,['tools','vision','reasoning','structured'],'模型能力')
 const lic=exact(m.license,['spdx','name','url','tier','restrictions'],'模型许可')
 if(lic.tier!=='commercial'&&lic.tier!=='restricted')throw bad('许可层级只收 commercial 或 restricted，不收 non-commercial。')
 const restrictions=list(lic.restrictions,'许可限制',10).map(item=>localized(item,'许可限制',300))
 if(lic.tier==='restricted'&&!restrictions.length)throw bad('restricted 许可必须列出至少一条限制。')
 if(!['direct','mirror','proxy-required'].includes(String(m.cnReachable)))throw bad('国内可达性只能是 direct、mirror 或 proxy-required。')
 if(m.support!=='experimental'&&m.support!=='supported')throw bad('支持状态只能是 experimental 或 supported。')
 if(specialist&&(m.contextWindow!==null||Object.values(cap).some(value=>value!==false)))throw bad('本地垂类模型不声明聊天上下文或聊天能力。')
 const base:MarketCatalogModelBase={modelId:pattern(m.modelId,roleIdPattern,'模型标识'),title:localized(m.title,'模型标题',120),summary:localized(m.summary,'模型用途'),
  capabilities:{tools:bool(cap.tools,'工具调用'),vision:bool(cap.vision,'视觉'),reasoning:bool(cap.reasoning,'推理'),structured:bool(cap.structured,'结构化输出')},
  contextWindow:nullableInt(m.contextWindow,'上下文窗口'),
  license:{spdx:text(lic.spdx,'许可标识',200),name:text(lic.name,'许可名称',200),url:pattern(lic.url,httpsUrl,'许可链接'),tier:lic.tier,restrictions},
  cnReachable:m.cnReachable as MarketCatalogModelBase['cnReachable'],support:m.support,notes:list(m.notes,'说明',10).map(item=>localized(item,'说明',500))}
 const commonFields=readCommonFields(row,{allowEmptyLicenseFiles:true,licenseUrl:true}) as ReturnType<typeof readCommonFields>&{license:{spdx:string;files:string[];url:string}}
 const head={format:'teloa.market-catalog-entry/v1' as const,id:pattern(row.id,modelCatalogId,'目录条目标识'),kind:'model' as const,delivery:'reference' as const,version:pattern(row.version,semver,'条目版本'),upstream:null,taxonomy:readMarketTaxonomy(row.taxonomy)}
 if(specialist)return {...head,model:{...base,form:'local-specialist',...readNativeModel(m.native,usage as string[])},...commonFields}
 const common:MarketCatalogModelCommon={...base,usage:usage as ('chat'|'embedding'|'tool')[]}
 if(m.form==='cloud'){
  if(m.local!==null||m.variants!==null)throw bad('云端模型的 local 与 variants 必须为 null。')
  return {...head,model:{...common,form:'cloud',cloud:readModelCloud(m.cloud),local:null,variants:null},...commonFields}
 }
 if(m.cloud!==null)throw bad('本机模型的 cloud 必须为 null。')
 const local=exact(m.local,['runtime'],'本机运行时');if(local.runtime!=='ollama')throw bad('本机运行时只支持 ollama。')
 if(!commonFields.requires.runtimes.includes('ollama'))throw bad('本机模型的 requires.runtimes 必须包含 ollama。')
 const gb=(x:unknown,label:string):number=>{if(!Number.isInteger(x)||(x as number)<1||(x as number)>1024)throw bad(label+'须为 1–1024 的整数。');return x as number}
 const gb2=(x:unknown,label:string):number=>{if(!Number.isInteger(x)||(x as number)<256||(x as number)>2_000_000)throw bad(label+'须为 256–2000000 的整数。');return x as number}
 const variants=list(m.variants,'模型变体',6).map((item):MarketCatalogModelVariant=>{
  const v=exact(item,['quant','format','sizeBytes','sources','hardware','models'],'模型变体')
  if(v.format!=='gguf')throw bad('模型变体格式只收 gguf。')
  const sources=list(v.sources,'来源',1).map(item=>{
   if(!isRecord(item)||item.kind!=='ollama')throw bad('本期来源只支持 ollama。')
   const s=exact(item,['kind','name','digest'],'来源')
   const name=pattern(s.name,ollamaModelNamePattern,'Ollama 模型名称（必须带 tag）')
   if(s.digest!==null&&(typeof s.digest!=='string'||!ollamaDigestPattern.test(s.digest)))throw bad('来源摘要必须为 sha256:64 位十六进制或 null。')
   return {kind:'ollama' as const,name,digest:s.digest as string|null}
  })
  if(!sources.length)throw bad('来源至少一项。')
  const hardware=exact(v.hardware,['minRamGb','recommendedRamGb','vramGb'],'硬件条件')
  const models=exact(v.models,['id','contextWindow','maxTokens','input'],'路由模型')
  if(models.id!==sources[0]!.name)throw bad('路由模型 id 必须与 Ollama 名称一致。')
  const input=distinct(list(models.input,'输入类型',2).map(t=>{if(t!=='text'&&t!=='image')throw bad('输入类型只支持 text/image。');return t as 'text'|'image'}),'输入类型')
  if(!input.includes('text'))throw bad('输入类型必须包含 text。')
  if(!Number.isSafeInteger(v.sizeBytes)||(v.sizeBytes as number)<=0)throw bad('sizeBytes 须为正整数。')
  if((hardware.minRamGb as number)>(hardware.recommendedRamGb as number))throw bad('最低内存不能高于推荐内存。')
  if((models.maxTokens as number)>(models.contextWindow as number))throw bad('最大输出不能超过上下文窗口。')
  return {quant:pattern(v.quant,/^[A-Za-z0-9_]{1,16}$/,'量化标识'),format:'gguf',sizeBytes:v.sizeBytes as number,sources:[sources[0]!],
   hardware:{minRamGb:gb(hardware.minRamGb,'最低内存'),recommendedRamGb:gb(hardware.recommendedRamGb,'推荐内存'),vramGb:hardware.vramGb===null?null:gb(hardware.vramGb,'显存')},
   models:{id:models.id as string,contextWindow:gb2(models.contextWindow,'上下文'),maxTokens:gb2(models.maxTokens,'最大输出'),input}}
 })
 if(!variants.length)throw bad('模型变体至少一项。')
 distinct(variants.map(v=>v.sources[0].name),'Ollama 模型名称')
 return {...head,model:{...common,form:'local-general',cloud:null,local:{runtime:'ollama'},variants},...commonFields}
}
function readModelCloud(value:unknown):MarketCatalogModelCloud{
 const cloud=exact(value,['provider','models','priceBand','credentialLabel','signupUrl'],'云端接入')
 const providerRow=isRecord(cloud.provider)?cloud.provider:null
 if(!providerRow)throw bad('云端 provider 格式不正确。')
 let provider:MarketCatalogModelCloud['provider']
 if(providerRow.kind==='pi-ai'){
  const p=exact(cloud.provider,['kind','id'],'pi-ai provider');provider={kind:'pi-ai',id:pattern(p.id,piAiProviderId,'pi-ai provider 标识')}
 }else if(providerRow.kind==='custom'){
  const p=exact(cloud.provider,['kind','api','baseURL'],'自定义 provider')
  if(!(modelApis as readonly unknown[]).includes(p.api))throw bad('自定义 provider 协议只支持 openai-completions、openai-responses 或 anthropic-messages。')
  provider={kind:'custom',api:p.api as MarketCatalogModelApi,baseURL:pattern(p.baseURL,httpsUrl,'自定义端点（必须 https）')}
 }else throw bad('云端 provider 类型只支持 pi-ai 或 custom。')
 const models=list(cloud.models,'起始模型列表',50).map(input=>{
  const r=exact(input,['id','name','contextWindow','maxTokens','input'],'模型')
  const inputs=distinct(list(r.input,'模型输入类型',2).map(item=>{if(item!=='text'&&item!=='image')throw bad('模型输入类型只能是 text 或 image。');return item}),'模型输入类型')
  return {id:text(r.id,'模型 id',120),name:text(r.name,'模型名称',120),contextWindow:nullableInt(r.contextWindow,'上下文窗口'),maxTokens:nullableInt(r.maxTokens,'最大输出'),input:inputs}
 })
 if(!models.length)throw bad('起始模型列表至少一项。')
 distinct(models.map(item=>item.id),'模型 id')
 if(cloud.priceBand!==null&&!['low','mid','high'].includes(String(cloud.priceBand)))throw bad('价格档只能是 low、mid、high 或 null。')
 return {provider,models,priceBand:cloud.priceBand as MarketCatalogModelCloud['priceBand'],credentialLabel:localized(cloud.credentialLabel,'凭据说明',120),signupUrl:pattern(cloud.signupUrl,httpsUrl,'注册链接')}
}

export function readMarketCatalogEntry(value:unknown):MarketCatalogEntry{
 if(!isRecord(value))throw bad('目录条目格式不正确或包含未知字段。')
 if(value.kind==='skill'){
  const {secrets,...rest}=value
  const entry=rest.delivery==='upstream'
   ?readUpstreamSkillEntry(exact(rest,['format','id','kind','delivery','version','taxonomy','skill','upstream','origin','alternatives','unsupportedComponents','modifications','license','compatibility','requires','review'],'上游技能条目'))
   :readSkillEntry(exact(rest,['format','id','kind','delivery','version','taxonomy','skill','upstream','modifications','license','compatibility','requires','review'],'技能条目'))
  if(secrets===undefined)return entry
  readSkillSecretGate(entry)
  return {...entry,secrets:readSkillSecrets(secrets,entry.skill.name)}
 }
 if(value.kind==='solution')return readSolutionEntry(exact(value,['format','id','kind','delivery','version','taxonomy','solution','upstream','modifications','license','compatibility','requires','review'],'方案条目'))
 if(value.kind==='connector')return readConnectorEntry(exact(value,['format','id','kind','delivery','version','taxonomy','upstream','connector','modifications','license','compatibility','requires','review'],'连接器条目'))
 if(value.kind==='role')return readRoleEntry(exact(value,['format','id','kind','delivery','version','taxonomy','upstream','role','modifications','license','compatibility','requires','review'],'AI 同事条目'))
 if(value.kind==='model')return readModelEntry(exact(value,['format','id','kind','delivery','version','taxonomy','upstream','model','modifications','license','compatibility','requires','review'],'模型条目'))
 throw bad('目录条目类型只支持 solution、role、skill、connector 或 model。')
}

/**
 * 读取 SKILL.md 首个 frontmatter 块里的顶层 `name`（去引号、去前后空白）；没有则返回 undefined。
 * 不在此校验技能名文法，调用方按各自规则复核。宿主会话内预览与后端 GitHub 导入共用，保证两边解析出同一个名字。
 */
export function skillFrontmatterName(text:string):string|undefined{
 const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text),line=match?.[1]?.split(/\r?\n/).find(item=>/^name:\s*/.test(item))
 const name=line?.replace(/^name:\s*/,'').trim().replace(/^(["'])(.*)\1$/,'$2')
 return name||undefined
}

/** 工件树摘要：按路径排序后对 [path,sha256,size] 序列求摘要；由调用方提供 sha256，契约包不依赖运行时加密库。 */
export function marketCatalogTreeHash(files:readonly MarketCatalogArtifactFile[],sha256:(text:string)=>string):string{
 const ordered=[...files].sort((left,right)=>left.path<right.path?-1:left.path>right.path?1:0)
 return sha256(JSON.stringify(ordered.map(file=>[file.path,file.sha256,file.size])))
}

/** 读取条目工件清单并核对入口、许可与树摘要；不接触字节，字节摘要由持有字节的一方核对。 */
export function readMarketCatalogArtifact(value:unknown,entry:MarketCatalogEntry,sha256:(text:string)=>string):MarketCatalogArtifact{
 const row=exact(value,['files','treeHash'],'条目工件')
 const files=list(row.files,'工件文件',500).map(input=>{const file=exact(input,['path','sha256','size'],'工件文件');return {path:path(file.path,'工件文件路径'),sha256:pattern(file.sha256,hex64,'工件文件摘要'),size:size(file.size,'工件文件')}})
 distinct(files.map(file=>file.path),'工件文件路径')
 if(entry.kind==='skill'&&entry.delivery!=='upstream'){
  // 技能条目：根目录恰有一个 SKILL.md
  const skillEntries=files.filter(file=>file.path.split('/').at(-1)==='SKILL.md')
  if(skillEntries.length!==1||skillEntries[0]!.path!=='SKILL.md')throw bad('条目工件必须恰有一个位于根目录的 SKILL.md。')
 }else if(entry.kind==='solution'){
  // 方案条目：根目录必须有 teloa.json，子目录 SKILL.md 数量不限
  if(!files.some(file=>file.path==='teloa.json'))throw bad('方案条目工件必须包含根目录的 teloa.json。')
 }else if(entry.kind==='role'){
  // AI 同事条目：工件只有 role.json（必有）、README.md（可选）与许可文件 LICENSE / LICENSE.txt（市场仓托管工件各自带许可）
  if(!files.some(file=>file.path==='role.json'))throw bad('AI 同事条目工件必须包含根目录的 role.json。')
  if(files.some(file=>!['role.json','README.md','LICENSE','LICENSE.txt'].includes(file.path)))throw bad('AI 同事条目工件只允许 role.json、README.md 与许可文件（LICENSE 或 LICENSE.txt）。')
 }else if(entry.kind==='model'){
  throw bad('模型条目没有工件。')
 }else{
  // 连接器条目：只需包含至少一个许可证文件，无需 SKILL.md 或 teloa.json
  // 许可文件已在下方的通用检查中验证（entry.license.files）
 }
 if(entry.license.files.some(license=>!files.some(file=>file.path===license)))throw bad('许可文件必须包含在条目工件中。')
 if(files.reduce((total,file)=>total+file.size,0)>MAX_TOTAL)throw bad('条目工件总大小不能超过 20 MiB。')
 const treeHash=pattern(row.treeHash,hex64,'工件树摘要')
 if(marketCatalogTreeHash(files,sha256)!==treeHash)throw bad('工件树摘要与文件清单不一致。')
 return {files,treeHash}
}

export function readMarketCatalogIndex(value:unknown,sha256:(text:string)=>string):MarketCatalogIndex{
 const row=exact(value,['format','catalogVersion','entries'],'目录快照')
 if(row.format!=='teloa.market-catalog/v1')throw bad('目录快照格式版本不受支持。')
 const catalogVersion=pattern(row.catalogVersion,/^[0-9A-Za-z][0-9A-Za-z.-]{0,39}$/,'目录版本')
 const entries=list(row.entries,'目录条目',500).map(input=>{
  if(!isRecord(input))throw bad('目录条目格式不正确。')
  const {artifact,...rest}=input,entry=readMarketCatalogEntry(rest)
  if(entry.kind==='model'){if(artifact!==null)throw bad('模型条目的 artifact 必须为 null。');return {...entry,artifact:null}}
  return {...entry,artifact:readMarketCatalogArtifact(artifact,entry,sha256)}
 })
 distinct(entries.map(entry=>entry.id),'目录条目标识')
 // 技能去重按技能名；方案按包 id；连接器按服务名；岗位按 roleId；模型按 modelId
 distinct(entries.filter(e=>e.kind==='skill').map(e=>(e as MarketCatalogSkillEntry).skill.name),'目录技能名')
 distinct(entries.filter(e=>e.kind==='solution').map(e=>(e as MarketCatalogSolutionEntry).solution.packageId),'方案包标识')
 distinct(entries.filter(e=>e.kind==='connector').map(e=>(e as MarketCatalogConnectorEntry).connector.serverName),'连接器服务名')
 distinct(entries.filter(e=>e.kind==='role').map(e=>(e as MarketCatalogRoleEntry).role.roleId),'岗位标识')
 distinct(entries.filter(e=>e.kind==='model').map(e=>(e as MarketCatalogModelEntry).model.modelId),'模型标识')
 // 上游条目无 artifact，readMarketCatalogArtifact 会拒绝它们；断言安全。
 return {format:'teloa.market-catalog/v1',catalogVersion,entries:entries as MarketCatalogIndexEntry[]}
}
