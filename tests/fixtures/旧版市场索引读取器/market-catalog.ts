import {WorkError} from '../../../packages/contract/src/work-error.ts'
import {isRecord} from '../../../packages/contract/src/resources.ts'
import {type MarketTaxonomy,readMarketTaxonomy} from './market-taxonomy.ts'
export type {MarketTaxonomy} from './market-taxonomy.ts'
export {marketFunctionKeys,marketIndustryKeys,marketIndustryParent,isMarketIndustryRoot,readMarketTaxonomy} from './market-taxonomy.ts'
export type {MarketFunctionKey,MarketIndustryKey} from './market-taxonomy.ts'

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
export type MarketCatalogSkillEntry={
 format:'teloa.market-catalog-entry/v1'
 id:string
 kind:'skill'
 delivery:'builtin'|'install'
 version:string
 taxonomy:MarketTaxonomy
 skill:{name:string;title:MarketCatalogText;summary:MarketCatalogText}
 upstream:{ecosystem:string;author:string;repository:{host:'github.com';owner:string;repo:string};commit:string;path:string;license:string;files:{path:string;gitBlob:string;size:number}[]}
 modifications:MarketCatalogText[]
 license:{spdx:string;files:string[]}
 compatibility:{status:MarketCatalogCompatibility;teloa:string;dsh:string;conditions:MarketCatalogText[]}
 requires:{tools:string[];network:boolean;runtimes:string[]}
 review:{status:'approved';reviewedAt:string;reviewer:string}
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
/** connector 认证：none（无凭据）、secret（密钥/令牌）、oauth（下一版本支持，本期不可用）。
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
export type ConnectorAuthOAuth={kind:'oauth';reason:string}
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
}
export type MarketCatalogEntry=MarketCatalogSkillEntry|MarketCatalogSolutionEntry|MarketCatalogConnectorEntry|MarketCatalogUpstreamSkillEntry
export type MarketCatalogArtifactFile={path:string;sha256:string;size:number}
export type MarketCatalogArtifact={files:MarketCatalogArtifactFile[];treeHash:string}
/** 快照索引条目：上游条目不入快照（无 artifact），仅含 Teloa 自有条目。 */
export type MarketCatalogIndexEntry=(MarketCatalogSkillEntry|MarketCatalogSolutionEntry|MarketCatalogConnectorEntry)&{artifact:MarketCatalogArtifact}
export type MarketCatalogIndex={format:'teloa.market-catalog/v1';catalogVersion:string;entries:MarketCatalogIndexEntry[]}
/** 宿主 `market-catalog/list` 回包条目；上游条目 artifact 为 null；`addedContentId` 未添加或内置条目为 null。 */
export type MarketCatalogListItem={entry:MarketCatalogEntry;artifact:MarketCatalogArtifact|null;addedContentId:string|null}
/** 分页列表请求；不传任何字段等同于 `{}` 向后兼容（首页 Teloa 官方条目）。 */
export type MarketCatalogListRequest={cursor?:string;limit?:number;query?:string;kind?:'skill'|'solution'|'connector';marketplace?:'teloa'|'claude-code'|'codex'|'dsh'|'openclaw'|'clawhub'|'hermes';sort?:'installs'|'name'}
export type MarketCatalogListResponse={catalogVersion:string;items:MarketCatalogListItem[];nextCursor:string|null}

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
/** 与 DSH 技能名同一文法（kebab-case，≤64）。 */
export const marketCatalogSkillName=/^(?=.{1,64}$)[a-z0-9]+(?:-[a-z0-9]+)*$/
/** 方案包 id 文法（与 content-store.ts stableId 一致，1-120 位字母数字连字符）。 */
const packageIdPattern=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
/** 业务范围（与 validateManifest scope 一致）。 */
const scopePattern=/^[a-zA-Z0-9_-]{1,64}$/
const semver=/^(?=.{1,80}$)\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const hex40=/^[0-9a-f]{40}$/,hex64=/^[0-9a-f]{64}$/
const githubName=/^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/
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
function date(value:unknown,label:string):string{
 const result=pattern(value,/^\d{4}-\d{2}-\d{2}$/,label),parsed=new Date(result+'T00:00:00.000Z')
 if(!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==result)throw bad(label+'不是有效日期。')
 return result
}

// 公共字段：两种 kind 的 modifications/license/compatibility/requires/review 读法相同。
function readCommonFields(row:Record<string,unknown>,opts:{allowEmptyLicenseFiles?:boolean}={}){
 const licenseRow=exact(row.license,['spdx','files'],'许可')
 const licenseFiles=distinct(list(licenseRow.files,'许可文件',20).map(file=>path(file,'许可文件路径')),'许可文件')
 if(!licenseFiles.length&&!opts.allowEmptyLicenseFiles)throw bad('许可文件至少一项。')
 const compatibilityRow=exact(row.compatibility,['status','teloa','dsh','conditions'],'兼容声明')
 if(!(marketCatalogCompatibility as readonly unknown[]).includes(compatibilityRow.status))throw bad('兼容状态只能是 verified、needs-configuration、content-only 或 unsupported。')
 const requiresRow=exact(row.requires,['tools','network','runtimes'],'运行需求')
 if(typeof requiresRow.network!=='boolean')throw bad('联网需求必须是布尔值。')
 const reviewRow=exact(row.review,['status','reviewedAt','reviewer'],'审核记录')
 if(reviewRow.status!=='approved')throw bad('目录只收录审核通过的条目。')
 return {
  modifications:list(row.modifications,'修改说明',50).map(item=>localized(item,'修改说明',1000)),
  license:{spdx:text(licenseRow.spdx,'许可',200),files:licenseFiles},
  compatibility:{status:compatibilityRow.status as MarketCatalogCompatibility,teloa:text(compatibilityRow.teloa,'Teloa 兼容范围',120),dsh:text(compatibilityRow.dsh,'DSH 兼容范围',120),conditions:list(compatibilityRow.conditions,'兼容条件',20).map(item=>localized(item,'兼容条件'))},
  requires:{tools:distinct(list(requiresRow.tools,'所需工具',50).map(item=>pattern(item,/^[A-Za-z0-9_:.-]{1,120}$/,'工具名')),'所需工具'),network:requiresRow.network as boolean,runtimes:distinct(list(requiresRow.runtimes,'运行时',20).map(item=>text(item,'运行时',120)),'运行时')},
  review:{status:'approved' as const,reviewedAt:date(reviewRow.reviewedAt,'审核日期'),reviewer:text(reviewRow.reviewer,'审核人',200)},
 }
}

function readSkillEntry(row:Record<string,unknown>):MarketCatalogSkillEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='builtin'&&row.delivery!=='install')throw bad('目录条目交付方式只能是 builtin 或 install。')
 const skillRow=exact(row.skill,['name','title','summary'],'技能信息')
 const name=pattern(skillRow.name,marketCatalogSkillName,'技能名')
 if(row.delivery==='builtin'&&!name.startsWith('teloa-'))throw bad('内置技能名必须以 teloa- 开头。')
 if(row.delivery==='install'&&name.startsWith('teloa-'))throw bad('teloa- 前缀保留给内置技能，安装型条目不能使用。')
 const upstreamRow=exact(row.upstream,['ecosystem','author','repository','commit','path','license','files'],'上游来源')
 const repositoryRow=exact(upstreamRow.repository,['host','owner','repo'],'上游仓库')
 if(repositoryRow.host!=='github.com')throw bad('上游仓库目前只支持 github.com。')
 const upstreamFiles=list(upstreamRow.files,'上游文件',500).map(input=>{const file=exact(input,['path','gitBlob','size'],'上游文件');return {path:path(file.path,'上游文件路径'),gitBlob:pattern(file.gitBlob,hex40,'上游文件 blob 摘要'),size:size(file.size,'上游文件')}})
 if(!upstreamFiles.length)throw bad('上游文件至少一项。')
 distinct(upstreamFiles.map(file=>file.path),'上游文件路径')
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'skill',delivery:row.delivery as 'builtin'|'install',version:pattern(row.version,semver,'条目版本'),
  taxonomy:readMarketTaxonomy(row.taxonomy),
  skill:{name,title:localized(skillRow.title,'技能标题',120),summary:localized(skillRow.summary,'技能用途')},
  upstream:{ecosystem:pattern(upstreamRow.ecosystem,/^[a-z0-9-]{1,40}$/,'上游生态'),author:text(upstreamRow.author,'上游作者',200),repository:{host:'github.com',owner:pattern(repositoryRow.owner,githubName,'上游仓库 owner'),repo:pattern(repositoryRow.repo,githubName,'上游仓库名')},commit:pattern(upstreamRow.commit,hex40,'上游提交'),path:path(upstreamRow.path,'上游目录'),license:text(upstreamRow.license,'上游许可',200),files:upstreamFiles},
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
const httpsUrl=/^https:\/\/[^/].{0,1000}$/
/** connector serverName：与 dsh-mcp-client 的 SERVER_NAME_PATTERN 一致。 */
const connectorServerName=/^[A-Za-z0-9_-]{1,32}$/
/** env 变量名：允许混合大小写（部分官方包如 dingtalk-mcp 使用混合大小写变量名）。 */
const envVarName=/^[A-Za-z][A-Za-z0-9_]{0,127}$/

function readConnectorEntry(row:Record<string,unknown>):MarketCatalogConnectorEntry{
 if(row.format!=='teloa.market-catalog-entry/v1')throw bad('目录条目格式版本不受支持。')
 if(row.delivery!=='managed')throw bad('连接器条目只能以 managed 方式交付。')
 if(row.upstream!==null)throw bad('连接器条目的 upstream 必须为 null。')
 const connRow=exact(row.connector,['serverName','title','summary','auth','recipe','tools','upstreamUrl'],'连接器信息')
 const serverName=pattern(connRow.serverName,connectorServerName,'连接器服务名')
 // 认证建模：none、secret（env/bearer）、oauth（预留，本期不可连接）
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
    return {target:'env' as const,envVarName:pattern(vr.envVarName,envVarName,'环境变量名'),label:localized(vr.label,'凭据说明'),required:vr.required as boolean}
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
  const ar=exact(connRow.auth,['kind','reason'],'oauth 认证')
  auth={kind:'oauth',reason:text(ar.reason,'OAuth 不支持原因',500)}
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
 return {
  format:'teloa.market-catalog-entry/v1',id:pattern(row.id,catalogId,'目录条目标识'),kind:'connector',delivery:'managed',version:pattern(row.version,semver,'条目版本'),upstream:null,
  taxonomy:readMarketTaxonomy(row.taxonomy),
  connector:{serverName,title:localized(connRow.title,'连接器标题',120),summary:localized(connRow.summary,'连接器用途'),auth,recipe,tools,upstreamUrl},
  ...readCommonFields(row),
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

export function readMarketCatalogEntry(value:unknown):MarketCatalogEntry{
 if(!isRecord(value))throw bad('目录条目格式不正确或包含未知字段。')
 if(value.kind==='skill'){
  if(value.delivery==='upstream')return readUpstreamSkillEntry(exact(value,['format','id','kind','delivery','version','taxonomy','skill','upstream','origin','alternatives','unsupportedComponents','modifications','license','compatibility','requires','review'],'上游技能条目'))
  return readSkillEntry(exact(value,['format','id','kind','delivery','version','taxonomy','skill','upstream','modifications','license','compatibility','requires','review'],'技能条目'))
 }
 if(value.kind==='solution')return readSolutionEntry(exact(value,['format','id','kind','delivery','version','taxonomy','solution','upstream','modifications','license','compatibility','requires','review'],'方案条目'))
 if(value.kind==='connector')return readConnectorEntry(exact(value,['format','id','kind','delivery','version','taxonomy','upstream','connector','modifications','license','compatibility','requires','review'],'连接器条目'))
 throw bad('目录条目类型只支持 skill、solution 或 connector。')
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
  return {...entry,artifact:readMarketCatalogArtifact(artifact,entry,sha256)}
 })
 distinct(entries.map(entry=>entry.id),'目录条目标识')
 // 技能去重按技能名；方案去重按包 id
 distinct(entries.filter(e=>e.kind==='skill').map(e=>(e as MarketCatalogSkillEntry).skill.name),'目录技能名')
 distinct(entries.filter(e=>e.kind==='solution').map(e=>(e as MarketCatalogSolutionEntry).solution.packageId),'方案包标识')
 distinct(entries.filter(e=>e.kind==='connector').map(e=>(e as MarketCatalogConnectorEntry).connector.serverName),'连接器服务名')
 // 上游条目无 artifact，readMarketCatalogArtifact 会拒绝它们；断言安全。
 return {format:'teloa.market-catalog/v1',catalogVersion,entries:entries as MarketCatalogIndexEntry[]}
}
