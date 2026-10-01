import {readIndustryModelObservations,type IndustryModelObservation} from '@teloa/contract'
import {isGithubRepositoryName,marketCatalogUpstreamTreeHash,MARKET_CATALOG_MAX_FILES,MARKET_CATALOG_MAX_FILE_SIZE,MARKET_CATALOG_MAX_TOTAL_SIZE} from '@teloa/contract'
import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session/types'
import {defineTool,type ParameterSchemaSpec,type PreToolDecision} from '@deepseek-ai/dsh-tools'
import {WorkError,isRecord,taskInput,isBundledExtensionId,readBundledExtensionView,type BundledExtensionId,type BundledExtensionView,skillFrontmatterName,marketFunctionKeys,marketIndustryKeys,marketIndustryParent,marketEntryKinds,type MarketCatalogEntry,type MarketCatalogConnectorEntry,type MarketCatalogListItem,type MarketCatalogSkillSecret,type MarketCatalogText,type MarketFunctionKey,type MarketIndustryKey} from '@teloa/contract'
import {authorizePlanManagement,planRequestIdentity,safePlanOperation,type PlanToolsPorts} from './plan-tools.ts'
import {resolveSkillSecretsEntry,resolvedSkillSecretBinding,type ResolvedSkillSecrets,type SkillSecretGroupMembers} from './skill-secrets.ts'
import {readSessionEvents} from './session-events.ts'
import {hasActiveUserInstruction} from './conversation-mutation.ts'
import type {createLocalModelsHandler,PullFacts} from './local-models.ts'
import {modelPrepareInput,pullCardFacts} from './model-prepare.ts'

/**
 * 会话内安装一期（计划 design specification）：
 * 八个 Agent 工具全部经 ports 直接调用既有 handler，不新增 RPC 端点；
 * 授权沿用 `authorizePlanManagement`（本人普通会话、非子 Agent、非任务执行会话）并加一道「本轮有真实用户指令」的轻量检查。
 *
 * 为什么不用 `authorizeConversationMutation`：它要求当前轮次恰好一条用户指令并由指令派生 requestId；一句自然语言常触发
 * search → resolve → add 多个工具调用，同一轮还可能添加两个条目，按指令派生的 requestId 会撞。这里改为 callId 版
 * requestId（`planRequestIdentity`）：各调用独立，同一 callId 重试幂等。双闸：`task-tool-guard.ts` 在任务会话按 allowedTools 先拒，
 * 本模块 pre 阶段再拒（岗位会话即使把八个工具名写进 allowedTools，`policy!==null` 仍拒）。业务对象关联的本人普通会话按主会话裁定放行到确认卡。
 * 密钥不进聊天：八个工具的全部参数在授权后统一扫描键名与值形态，命中即固定句拒绝、不回显。
 */
export const marketSessionToolNames=['teloa_market_search','teloa_market_resolve','teloa_market_add','teloa_mcp_connect','teloa_industry_load','teloa_industry_readiness','teloa_industry_prepare','teloa_model_prepare'] as const
export type MarketSessionToolsPorts=Pick<PlanToolsPorts,'owner'|'conversation'|'readTaskPolicy'>&{
 /** IM 通道发起的会话（终审 I-3）：`teloa_model_prepare` 对其一律拒绝，下载只能在工作台确认。 */
 isImSession?:(sessionId:string)=>boolean
 catalog:(endpoint:'market-catalog/list'|'market-catalog/add',payload:unknown)=>Promise<unknown>
 github:(endpoint:'market/github/resolve',payload:unknown)=>Promise<unknown>
 content:(endpoint:'market-content/import-github-skill'|'market-content/get',payload:unknown)=>Promise<unknown>
 skills:(endpoint:'skill-installations/preview'|'skill-installations/install',payload:unknown)=>Promise<unknown>
 mcp:(endpoint:'mcp-connections/add'|'mcp-connections/connect'|'mcp-connections/list',payload:unknown)=>Promise<unknown>
 connectorEntry:(catalogId:string)=>MarketCatalogConnectorEntry|undefined
 /** 技能条目声明的密钥，按条目 id 取；与 teloa_skill_http、密钥页、加载提示同一来源函数（审查 R1 M-1）。 */
 skillSecrets:(entryId:string)=>MarketCatalogSkillSecret[]
 /** 条目的调用指引与共享密钥组、组内全部目录条目（同上来源）：安装确认卡指纹与存储指纹同源（审查修复 R1 裁定 4）。 */
 skillSecretMeta:(entryId:string)=>{httpGuide?:MarketCatalogText;secretGroup?:string}
 skillSecretGroupMembers:(group:string)=>SkillSecretGroupMembers
 industryLoads:(endpoint:'industry-loads/create'|'industry-loads/list',payload:unknown)=>Promise<unknown>
 industryPrepare:(endpoint:'industry-loads/readiness'|'industry-loads/prepare',payload:unknown)=>Promise<unknown>
 currentSpace:()=>Promise<{id:string;name:string;version:number}>
 bundledExtensions:(endpoint:'bundled-extensions/list'|'bundled-extensions/set',payload:unknown)=>Promise<unknown>
 localModels:Pick<ReturnType<typeof createLocalModelsHandler>,'pullFacts'|'startPull'>
}
type ActiveSession={id:string;header:{origin?:string};inheritedEventCount:number;seq?:number;snapshotEvents:()=>readonly SessionEvent[]}
type Exec={agent?:{session:ActiveSession};signal:AbortSignal;callId:unknown}
type Marketplace='teloa'|'claude-code'|'codex'|'dsh'|'openclaw'|'clawhub'|'hermes'

const names=new Set<string>(marketSessionToolNames)
const label='会话内安装'
const marketplaces:readonly Marketplace[]=['teloa','claude-code','codex','dsh','openclaw','clawhub','hermes']
const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
/** 宿主 handler 回包形状不对：与各 handler 自身的 hostBad 同码同文案。 */
const hostBad=(service:string)=>new WorkError('teloa/invalid-host-response',service+'返回了无效内容。')
const output={schema:{type:'string'} as const,render:(_args:unknown,value:string)=>[{type:'text' as const,text:value}]}
const cleanText=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value)

/** 双闸之一：本人普通会话 + 本轮至少一条真实用户指令；失败一律 WorkError，pre 阶段转 deny。 */
async function authorize(ports:MarketSessionToolsPorts,exec:Exec,args:unknown,name?:string):Promise<string>{
 const sessionId=await authorizePlanManagement(ports,exec,label)
 if(!exec.agent||!hasActiveUserInstruction(exec.agent.session))throw new WorkError('teloa/forbidden','当前会话没有可核验的活跃用户指令。')
 if(containsSecretLike(args))throw new WorkError('teloa/forbidden',SECRET_DENY)
 if(name==='teloa_model_prepare'&&ports.isImSession?.(sessionId))throw new WorkError('teloa/forbidden','IM 发起的会话不能下载模型，请到工作台的 设置 · 本地模型 操作。')
 return sessionId
}

// ---- 目录条目读法（所有字段都来自经宿主 handler 复核过的目录回包） ----
const entryTitle=(entry:MarketCatalogEntry)=>entry.kind==='skill'?entry.skill.title:entry.kind==='solution'?entry.solution.title:entry.kind==='dashboard'?entry.dashboard.title:entry.kind==='connector'?entry.connector.title:entry.kind==='role'?entry.role.title:entry.model.title
const entrySummary=(entry:MarketCatalogEntry)=>entry.kind==='skill'?entry.skill.summary:entry.kind==='solution'?entry.solution.summary:entry.kind==='dashboard'?entry.dashboard.summary:entry.kind==='connector'?entry.connector.summary:entry.kind==='role'?entry.role.summary:entry.model.summary
const entryMarketplace=(entry:MarketCatalogEntry):Marketplace=>entry.kind==='skill'&&entry.delivery==='upstream'?entry.origin.marketplace:'teloa'
const entryInstalls=(entry:MarketCatalogEntry)=>entry.kind==='skill'&&entry.delivery==='upstream'?entry.origin.installs??0:0
const conditionsText=(entry:MarketCatalogEntry)=>entry.compatibility.conditions.map(item=>item['zh-CN'])
/** 可添加性：unsupported 与 builtin 不可添加并给出条目自带的中文说明；连接器可添加但走 teloa_mcp_connect；云端模型经 设置 · 模型 配置，本地语音经原生扩展准备。 */
function addability(entry:MarketCatalogEntry):{addable:boolean;reason?:string;via?:'teloa_mcp_connect'|'settings-models'|'market-local-model'|'teloa_model_prepare'}{
 if(entry.compatibility.status==='unsupported')return {addable:false,reason:conditionsText(entry).join('') || '该资源暂不支持在 Teloa 中添加。'}
 if(entry.kind==='skill'&&entry.delivery==='builtin')return {addable:false,reason:'内置资源无需添加，新建时会自动使用。'}
 if(entry.kind==='model')return {addable:true,via:entry.model.form==='local-specialist'?'market-local-model':entry.model.form==='local-general'?'teloa_model_prepare':'settings-models'}
 if(entry.kind==='connector')return {addable:true,via:'teloa_mcp_connect'}
 return {addable:true}
}
const matchesIndustry=(entry:MarketCatalogEntry,key:MarketIndustryKey)=>entry.taxonomy.industries.some(item=>item===key||marketIndustryParent(item)===key)

type ListPage={catalogVersion:string;items:MarketCatalogListItem[];nextCursor:string|null}
/** 目录回包已由 `market-catalog/list` handler 逐条复核；这里只核形状，形状不对按宿主不可用处理。 */
function listPage(value:unknown):ListPage{
 if(!isRecord(value)||typeof value.catalogVersion!=='string'||!Array.isArray(value.items)||!(value.nextCursor===null||typeof value.nextCursor==='string'))throw hostBad('官方目录服务')
 for(const item of value.items)if(!isRecord(item)||!isRecord(item.entry)||!(item.addedContentId===null||typeof item.addedContentId==='string')||!(item.addedRoleId===null||typeof item.addedRoleId==='string'))throw hostBad('官方目录服务')
 return value as ListPage
}
/** 单个来源最多翻的页数：内存目录每页 50 条，10 页足够覆盖且防止分页异常时无限请求。 */
const maxSearchPages=10
type Enough={keep:(item:MarketCatalogListItem)=>boolean;want:number}
/**
 * 跟随 nextCursor 翻页，直到命中 `keep` 的条目已满 `want` 条、来源耗尽或达到页数上限。
 * 未给 `want` 时只取一页（名称检索只需判定唯一 / 多候选）。
 */
async function listMarketplace(ports:MarketSessionToolsPorts,marketplace:Marketplace,request:{query?:string;kind?:MarketCatalogEntry['kind']},enough?:Enough):Promise<ListPage>{
 const base={...(request.query===undefined?{}:{query:request.query}),...(request.kind===undefined?{}:{kind:request.kind}),limit:50,sort:'installs',...(marketplace==='teloa'?{}:{marketplace})}
 let page=listPage(await ports.catalog('market-catalog/list',base))
 const items=[...page.items]
 for(let count=1;enough&&page.nextCursor!==null&&count<maxSearchPages&&items.filter(enough.keep).length<enough.want;count++){
  page=listPage(await ports.catalog('market-catalog/list',{...base,cursor:page.nextCursor}))
  items.push(...page.items)
 }
 return {catalogVersion:page.catalogVersion,items,nextCursor:page.nextCursor}
}
/** 对七个市场各查（内存目录，成本可忽略），合并后按 installs 降序、id 升序。 */
async function searchCatalog(ports:MarketSessionToolsPorts,request:{query?:string;kind?:MarketCatalogEntry['kind']},enough?:Enough):Promise<{catalogVersion:string;items:MarketCatalogListItem[]}>{
 const pages=await Promise.all(marketplaces.map(marketplace=>listMarketplace(ports,marketplace,request,enough)))
 const items=pages.flatMap(page=>page.items).sort((a,b)=>entryInstalls(b.entry)-entryInstalls(a.entry)||(a.entry.id<b.entry.id?-1:a.entry.id>b.entry.id?1:0))
 return {catalogVersion:pages[0]!.catalogVersion,items}
}

// ---- teloa_market_search ----
type SearchInput={query?:string;kind?:MarketCatalogEntry['kind'];industry?:MarketIndustryKey;function?:MarketFunctionKey;limit:number}
function searchInput(args:unknown):SearchInput{
 const row=taskInput(args,['query','kind','industry','function','limit'])
 if(row.query!==undefined&&!cleanText(row.query,120))throw bad('query 必须是不超过 120 字的文本。')
 if(row.kind!==undefined&&!(marketEntryKinds as readonly unknown[]).includes(row.kind))throw bad('kind 只能是 solution、dashboard、role、skill、connector 或 model。')
 if(row.industry!==undefined&&!(marketIndustryKeys as readonly unknown[]).includes(row.industry))throw bad('industry 不是已知的行业键。')
 if(row.function!==undefined&&!(marketFunctionKeys as readonly unknown[]).includes(row.function))throw bad('function 不是已知的功能键。')
 if(row.limit!==undefined&&(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>20))throw bad('limit 必须是 1 到 20 的整数。')
 if(row.query===undefined&&row.industry===undefined&&row.function===undefined)throw bad('请至少给出 query、industry 或 function 之一。')
 return {...(row.query===undefined?{}:{query:(row.query as string).trim()}),...(row.kind===undefined?{}:{kind:row.kind as MarketCatalogEntry['kind']}),...(row.industry===undefined?{}:{industry:row.industry as MarketIndustryKey}),...(row.function===undefined?{}:{function:row.function as MarketFunctionKey}),limit:row.limit===undefined?10:Number(row.limit)}
}
function searchItem(item:MarketCatalogListItem){
 const {entry}=item
 return {entryId:entry.id,kind:entry.kind,marketplace:entryMarketplace(entry),title:entryTitle(entry),summary:entrySummary(entry),version:entry.version,compatibility:{status:entry.compatibility.status,conditions:conditionsText(entry)},license:entry.license.spdx,requires:entry.requires,taxonomy:entry.taxonomy,addedContentId:item.addedContentId,...addability(entry),
  ...(entry.kind==='role'?{fromSolution:{packageId:entry.role.fromSolution.packageId,version:entry.role.fromSolution.version},skills:entry.role.skills,addedRoleId:item.addedRoleId}:{}),
  ...(entry.kind==='model'?{form:entry.model.form,support:entry.model.support,cnReachable:entry.model.cnReachable,priceBand:entry.model.form==='cloud'?entry.model.cloud.priceBand:null,licenseTier:entry.model.license.tier}:{}),
 }
}
async function search(ports:MarketSessionToolsPorts,input:SearchInput){
 const keep=(item:MarketCatalogListItem)=>(input.industry===undefined||matchesIndustry(item.entry,input.industry))&&(input.function===undefined||item.entry.taxonomy.functions.includes(input.function))
 const {catalogVersion,items}=await searchCatalog(ports,{...(input.query===undefined?{}:{query:input.query}),...(input.kind===undefined?{}:{kind:input.kind})},{keep,want:input.limit})
 const filtered=items.filter(keep)
 return {items:filtered.slice(0,input.limit).map(searchItem),observed:{catalogVersion}}
}

// ---- teloa_market_resolve：引用解析 ----
export type MarketReference=
 |{kind:'catalog';entryId:string;strict?:true}
 |{kind:'github';owner:string;repo:string;ref:string;path?:string;skillPath?:string}
 |{kind:'name';query:string}
const GITHUB_OWNER=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/,GITHUB_REF=/^[A-Za-z0-9][A-Za-z0-9._-]*$/
const ENTRY_ID=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const safeSegments=(parts:string[])=>parts.every(part=>part&&part!=='.'&&part!=='..'&&!/[\\:?%#\u0000-\u001f\u007f]/.test(part))
/** 只认 https 且无用户名 / 端口 / 查询 / 片段的链接；其余形态一律拒绝而不是当作名称去搜。 */
function parseUrl(input:string):URL{
 let url:URL
 try{url=new URL(input)}catch{throw bad('链接格式不正确。')}
 if(url.protocol!=='https:'||url.username||url.password||url.port||url.search||url.hash)throw bad('只接受不带用户名、端口、查询与片段的 https 链接。')
 return url
}
export function parseMarketReference(input:string):MarketReference{
 const value=input.trim()
 if(!value||value.length>500||/[\u0000-\u001f\u007f]/.test(value))throw bad('引用不能为空、不能超过 500 字。')
 if(/^[a-z][a-z0-9+.-]*:\/\//i.test(value)){
  // `new URL` 会把 `..` 段折叠掉，先按原文拒绝，避免路径被归一化后混进来
  if(value.split(/[/?#]/).some(part=>part==='..'||part==='.'))throw bad('链接路径不能包含 . 或 .. 段。')
  const url=parseUrl(value),parts=url.pathname.split('/').filter(Boolean)
  if(url.hostname==='github.com'){
   if(parts.length<2||!safeSegments(parts))throw bad('GitHub 链接必须是 https://github.com/<owner>/<repo>[/tree|blob/<ref>/<path>]。')
   const [owner,repo,mode,ref,...rest]=parts as [string,string,string?,string?,...string[]]
   if(!GITHUB_OWNER.test(owner)||owner.includes('--')||!isGithubRepositoryName(repo))throw bad('GitHub 仓库 owner 或名称格式不正确。')
   if(mode===undefined)return {kind:'github',owner,repo,ref:'HEAD'}
   if((mode!=='tree'&&mode!=='blob')||ref===undefined||!GITHUB_REF.test(ref)||ref.endsWith('.')||ref.endsWith('.lock'))throw bad('GitHub 链接只支持 /tree/<ref>/<path> 或 /blob/<ref>/<path>/SKILL.md。')
   if(mode==='tree')return {kind:'github',owner,repo,ref,...(rest.length?{path:rest.join('/')}:{})}
   if(rest.at(-1)!=='SKILL.md')throw bad('GitHub blob 链接必须指向 SKILL.md。')
   const dir=rest.slice(0,-1)
   return {kind:'github',owner,repo,ref,...(dir.length?{path:dir.join('/')}:{}),skillPath:rest.join('/')}
  }
  if(url.hostname==='market.teloa.ai'){
   const ids=parts[0]==='en'?parts.slice(1):parts
   if(ids.length!==1||!ENTRY_ID.test(ids[0]!))throw bad('市场链接必须是 https://market.teloa.ai/<资源 id>/ 或 /en/<资源 id>/。')
   return {kind:'catalog',entryId:ids[0]!,strict:true}
  }
  throw bad('只支持 github.com 与 market.teloa.ai 链接。')
 }
 if(ENTRY_ID.test(value))return {kind:'catalog',entryId:value}
 return {kind:'name',query:value}
}

// ---- 分级与预览 ----
/**
 * `secretLabels` / `secretTargets`：技能条目声明的密钥中文名与「注入位置 → 发往 origin+路径前缀」一行一条（目录公开声明，不含值），供确认卡如实列出。
 * `secretSharedWith`：共享密钥组内除本技能外的其他技能名（按名排序），只在条目属于共享密钥组时出现。
 */
export type MarketPreview={source:string;license:string|null;files:{path:string;hash:string;size?:number;sha256?:string}[];tier:'content-only'|'network-or-script'|'connector'|'solution';domains:string[];tools:string[];dataEgress:boolean;requiredSecrets:string[];secretLabels:string[];secretTargets:string[];secretSharedWith?:string[];compatibility:{status:string;conditions:string[]}}
const secretWhere=(s:MarketCatalogSkillSecret)=>s.target==='bearer'?'Authorization: Bearer 请求头':s.target==='header'?`请求头 ${s.name}`:`查询参数 ${s.name}`
const secretTarget=(s:MarketCatalogSkillSecret)=>`${s.label['zh-CN']}：${secretWhere(s)}，发往 ${s.endpoints.flatMap(ep=>ep.pathPrefixes.map(prefix=>ep.origin+prefix)).join('、')}`
type CandidateBase={fingerprint:string;addable:boolean;reason?:string;name:string;preview:MarketPreview}
export type MarketCandidate=
 |CandidateBase&{kind:'catalog';entryId:string;entryKind:MarketCatalogEntry['kind'];version:string;treeHash:string;addedContentId:string|null;fileHashAlgorithm?:'git-blob';roleSkills?:string[];modelForm?:'cloud'|'local-general'|'local-specialist';modelUsage?:readonly string[]}
 |CandidateBase&{kind:'github';githubRequestId:string;owner:string;repo:string;ref:string;resolvedCommit:string;skillPaths:string[];skillPath?:string}
const SCRIPT_EXT=/\.(?:sh|py|js|mjs|ts|ps1)$/i
/** 只按正文与文件清单「声明性」分级：不是运行时网络监控。 */
export function classifyTier(input:{kind:MarketCatalogEntry['kind'];network:boolean;files:readonly {path:string}[];bodies:readonly string[]}):{tier:MarketPreview['tier'];domains:string[]}{
 const domains=[...new Set(input.bodies.flatMap(body=>[...body.matchAll(/https?:\/\/([A-Za-z0-9.-]+)/g)].map(match=>match[1]!.toLowerCase())))].slice(0,20)
 if(input.kind==='connector')return {tier:'connector',domains}
 if(input.kind==='solution')return {tier:'solution',domains}
 if(input.kind==='role')return {tier:'solution',domains}
 if(input.kind==='model')return {tier:'connector',domains}
 const scripted=input.network||input.files.some(file=>SCRIPT_EXT.test(file.path))||domains.length>0
 return {tier:scripted?'network-or-script':'content-only',domains}
}
const fileList=(files:readonly {path:string;sha256:string;size:number}[])=>files.map(file=>({path:file.path,hash:file.sha256,size:file.size}))
const skillNameOf=(body:string)=>skillFrontmatterName(body)
const shortCommit=(commit:string)=>commit.slice(0,12)

/** 目录来源始终保留目录身份；treeHash 交后端核对，密钥声明变化也使确认指纹失效。GitHub 文件先展示 blob，添加后以真实字节核对安装摘要。 */
type SecretPorts=Pick<MarketSessionToolsPorts,'skillSecrets'|'skillSecretMeta'|'skillSecretGroupMembers'>
/** 技能条目生效声明（含指引与组）；组成员声明不一致回 inconsistent（候选不可添加，不抛出以免整页搜索失败）。 */
function catalogDeclaration(ports:SecretPorts,entryId:string):{declared?:ResolvedSkillSecrets;inconsistent:boolean}{
 const secrets=ports.skillSecrets(entryId)
 if(!secrets.length)return {inconsistent:false}
 try{return {declared:resolveSkillSecretsEntry({getSkillSecretMetaByEntry:ports.skillSecretMeta,skillSecretGroupMembers:ports.skillSecretGroupMembers},entryId,secrets),inconsistent:false}}
 catch(error){if(error instanceof WorkError&&error.code==='teloa/invalid-input')return {declared:{secrets},inconsistent:true};throw error}
}
function catalogCandidate(item:MarketCatalogListItem,secretPorts:SecretPorts):MarketCandidate&{kind:'catalog'}{
 const {entry}=item
 let treeHash:string,files:MarketPreview['files'],source:string
 if(entry.kind==='skill'&&entry.delivery==='upstream'){
  const up=entry.upstream
  treeHash=marketCatalogUpstreamTreeHash(up,text=>createHash('sha256').update(text).digest('hex'))
  if(up.kind==='clawhub'){
   files=fileList(up.files);source=`官方目录资源 ${entry.id}@${entry.version}（ClawHub ${up.owner}/${up.slug} ${up.version}）`
  }else{
   files=up.files.map(file=>({path:file.path,hash:file.gitBlob,sha256:file.sha256,...(file.size===null?{}:{size:file.size})}))
   source=`官方目录资源 ${entry.id}@${entry.version}（GitHub ${up.repository.owner}/${up.repository.repo}@${shortCommit(up.commit)}，目录 ${up.path}）`
  }
 }else if(entry.kind==='model'){
  // 模型条目无工件（artifact 恒为 null）：指纹取条目本身
  treeHash=createHash('sha256').update(JSON.stringify(entry)).digest('hex');files=[];source=`Teloa 官方目录模型资源 ${entry.id}@${entry.version}`
 }else{
  if(!item.artifact)throw hostBad('官方目录服务')
  treeHash=item.artifact.treeHash;files=fileList(item.artifact.files);source=entry.kind==='role'?`Teloa 官方目录 AI 员工资源 ${entry.id}@${entry.version}（来自方案 ${entry.role.fromSolution.packageId}@${entry.role.fromSolution.version}）`:`Teloa 官方目录资源 ${entry.id}@${entry.version}`
 }
 const {tier,domains}=classifyTier({kind:entry.kind,network:entry.requires.network,files,bodies:[]})
 const {declared,inconsistent}=entry.kind==='skill'?catalogDeclaration(secretPorts,entry.id):{inconsistent:false}
 const secrets=declared?.secrets??[]
 // 指纹拌入存储指纹（含调用指引；有组时为组指纹）：卡片与执行之间任一变化即 version-conflict。无新字段时与旧公式逐字相同。
 const fingerprint=declared?createHash('sha256').update(treeHash+'\n'+resolvedSkillSecretBinding(declared)).digest('hex'):treeHash
 const sharedWith=declared?.group?declared.group.members.filter(member=>member!==(entry.kind==='skill'?entry.skill.name:'')):undefined
 const requiredSecrets=entry.kind==='connector'&&entry.connector.auth.kind==='secret'?entry.connector.auth.vars.flatMap(v=>v.target==='env'?[v.envVarName]:[]):secrets.map(s=>s.envVarName)
 const secretLabels=secrets.map(s=>s.label['zh-CN']),secretTargets=secrets.map(secretTarget)
 const tools=entry.kind==='connector'?entry.connector.tools.map(tool=>tool.name):entry.requires.tools
 const name=entry.kind==='skill'?entry.skill.name:entry.kind==='solution'?entry.solution.title['zh-CN']:entry.kind==='dashboard'?entry.dashboard.title['zh-CN']:entry.kind==='role'?entry.role.title['zh-CN']:entry.kind==='model'?entry.model.title['zh-CN']:entry.connector.serverName
 const state=entry.kind==='connector'&&entry.compatibility.status!=='unsupported'?{addable:false,reason:'连接不能添加为内容，请用 teloa_mcp_connect 连接。'}:inconsistent?{addable:false,reason:'该技能的共享密钥说明不一致，请更新目录后重试。'}:addability(entry)
 return {kind:'catalog',entryId:entry.id,entryKind:entry.kind,version:entry.version,treeHash,addedContentId:item.addedContentId,...(entry.delivery==='upstream'&&entry.upstream.kind==='github'?{fileHashAlgorithm:'git-blob' as const}:{}),...(entry.kind==='role'?{roleSkills:entry.role.skills}:{}),...(entry.kind==='model'?{modelForm:entry.model.form,modelUsage:[...entry.model.usage]}:{}),fingerprint,addable:state.addable,...(state.reason===undefined?{}:{reason:state.reason}),name,
  preview:{source,license:entry.license.spdx,files,tier,domains,tools,dataEgress:domains.length>0||entry.requires.network,requiredSecrets,secretLabels,secretTargets,...(sharedWith?{secretSharedWith:sharedWith}:{}),compatibility:{status:entry.compatibility.status,conditions:conditionsText(entry)}}}
}

/** 每个用户轮每会话最多 3 次真实 GitHub 解析；同一来源坐标派生同一 requestId，不计新次数。 */
const HOUR=60*60*1000
/** 有界的会话级状态表：过期（默认 1 小时）与超额（默认 500 会话）的条目按最久未用清理，不随宿主运行无限增长。 */
function boundedSessionMap<T>(maxSessions=500,ttl=HOUR){
 const state=new Map<string,{at:number;value:T}>()
 const sweep=(now:number)=>{
  for(const [key,entry] of state)if(now-entry.at>ttl)state.delete(key)
  while(state.size>maxSessions){const oldest=state.keys().next().value;if(oldest===undefined)break;state.delete(oldest)}
 }
 return {
  get(key:string,now=Date.now()):T|undefined{sweep(now);const entry=state.get(key);if(!entry)return undefined;state.delete(key);state.set(key,{at:now,value:entry.value});return entry.value},
  set(key:string,value:T,now=Date.now()){state.delete(key);state.set(key,{at:now,value});sweep(now)},
 }
}
export function githubResolveQuota(limit=3){
 const state=boundedSessionMap<{turn:number;ids:Set<string>}>()
 return {admit(sessionId:string,turn:number,requestId:string):boolean{
  let entry=state.get(sessionId)
  if(!entry||entry.turn!==turn){entry={turn,ids:new Set()};state.set(sessionId,entry)}
  if(entry.ids.has(requestId))return true
  if(entry.ids.size>=limit)return false
  entry.ids.add(requestId);return true
 }}
}
/** 已解析 GitHub 来源的坐标登记：按会话分桶（每会话最多 20 条），供 teloa_market_add 按 githubRequestId 回查；读取时用当前会话重派生 id 核对，不接受别的会话的解析结果。 */
export function githubSourceRegistry(owner:string,perSession=20){
 const state=boundedSessionMap<Map<string,GithubSource>>()
 const derive=(sessionId:string,source:GithubSource)=>planRequestIdentity(owner,sessionId,'teloa_market_resolve',`${source.owner}/${source.repo}/${source.ref}/${source.path??''}`)
 return {
  remember(sessionId:string,id:string,source:GithubSource){
   const bucket=state.get(sessionId)??new Map<string,GithubSource>()
   bucket.delete(id);bucket.set(id,source)
   while(bucket.size>perSession){const oldest=bucket.keys().next().value;if(oldest===undefined)break;bucket.delete(oldest)}
   state.set(sessionId,bucket)
  },
  lookup(sessionId:string,id:string):GithubSource|undefined{
   const source=state.get(sessionId)?.get(id)
   return source&&derive(sessionId,source)===id?source:undefined
  },
 }
}
const currentTurn=(session:ActiveSession)=>readSessionEvents(session).filter(event=>event.type==='turn/start').at(-1)?.seq??-1

type GithubSource={owner:string;repo:string;ref:string;path?:string}
type GithubReceipt={provenance:{requestedRef:string;resolvedCommit:string};files:{path:string;hash:string;base64:string}[]}
function githubReceipt(value:unknown):GithubReceipt{
 if(!isRecord(value)||!isRecord(value.provenance)||typeof value.provenance.resolvedCommit!=='string'||typeof value.provenance.requestedRef!=='string'||!Array.isArray(value.files))throw hostBad('GitHub 来源服务')
 for(const file of value.files)if(!isRecord(file)||typeof file.path!=='string'||typeof file.hash!=='string'||typeof file.base64!=='string')throw hostBad('GitHub 来源服务')
 return value as GithubReceipt
}
type GithubContext={ports:MarketSessionToolsPorts;sessionId:string;turn:number;quota:ReturnType<typeof githubResolveQuota>;remember:(id:string,source:GithubSource)=>void}
/** 解析并固定 GitHub 来源；回包剥离 base64，只留 path / hash / size。 */
async function resolveGithubCandidate(ctx:GithubContext,source:GithubSource,skillPath:string|undefined,label?:string):Promise<MarketCandidate&{kind:'github'}>{
 const githubRequestId=planRequestIdentity(ctx.ports.owner,ctx.sessionId,'teloa_market_resolve',`${source.owner}/${source.repo}/${source.ref}/${source.path??''}`)
 if(!ctx.quota.admit(ctx.sessionId,ctx.turn,githubRequestId))throw new WorkError('teloa/forbidden','本轮 GitHub 解析次数已达上限，请先处理已解析的来源。')
 const receipt=githubReceipt(await ctx.ports.github('market/github/resolve',{requestId:githubRequestId,owner:source.owner,repo:source.repo,ref:source.ref,...(source.path===undefined?{}:{path:source.path})}))
 ctx.remember(githubRequestId,source)
 const prefix=source.path===undefined?'':source.path+'/'
 const inScope=receipt.files.filter(file=>file.path.startsWith(prefix))
 const allSkills=inScope.filter(file=>file.path.split('/').at(-1)==='SKILL.md').map(file=>file.path).sort()
 const skillPaths=skillPath===undefined?allSkills:allSkills.filter(path=>path===skillPath)
 const chosen=skillPaths.length===1?skillPaths[0]!:undefined,root=chosen===undefined?undefined:chosen.slice(0,chosen.length-'SKILL.md'.length)
 const scoped=root===undefined?inScope:inScope.filter(file=>file.path.startsWith(root))
 const decode=(file:{base64:string})=>Buffer.from(file.base64,'base64')
 const files=scoped.map(file=>({path:root===undefined?file.path:file.path.slice(root.length),hash:file.hash,size:decode(file).byteLength})).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 const bodies=scoped.filter(file=>file.path.split('/').at(-1)==='SKILL.md'||SCRIPT_EXT.test(file.path)).map(file=>decode(file).toString('utf8'))
 const entry=chosen===undefined?undefined:scoped.find(file=>file.path===chosen)
 const name=(entry&&skillNameOf(decode(entry).toString('utf8')))??(root?root.split('/').filter(Boolean).at(-1)!:`${source.repo}`)
 const {tier,domains}=classifyTier({kind:'skill',network:false,files,bodies})
 const commit=receipt.provenance.resolvedCommit
 const where=/^[0-9a-f]{40}$/.test(source.ref)?`${source.owner}/${source.repo}@${shortCommit(commit)}`:`${source.owner}/${source.repo}@${receipt.provenance.requestedRef}（提交 ${shortCommit(commit)}）`
 const sourceText=`${label?label+'：':''}GitHub ${where}${source.path===undefined?'':`（目录 ${source.path}）`}`
 const state=skillPaths.length===0?{addable:false,reason:'未找到 SKILL.md，无法作为技能添加。'}:skillPaths.length>1?{addable:false,reason:'目录内有多个 SKILL.md，请指定其一：'+skillPaths.join('、')}:{addable:true}
 return {kind:'github',githubRequestId,owner:source.owner,repo:source.repo,ref:source.ref,resolvedCommit:commit,skillPaths,...(chosen===undefined?{}:{skillPath:chosen}),fingerprint:commit,name,...state,
  preview:{source:sourceText,license:null,files,tier,domains,tools:[],dataEgress:domains.length>0,requiredSecrets:[],secretLabels:[],secretTargets:[],compatibility:{status:'unreviewed',conditions:[]}}}
}

/** 按 id 精确查找：对七个市场用 id 作 query 查询并跟随分页（目录在内存，页数有上限）。 */
async function findCatalogItem(ports:MarketSessionToolsPorts,entryId:string):Promise<MarketCatalogListItem|undefined>{
 for(const marketplace of marketplaces){
  let cursor:string|null=null
  for(let page=0;page<20;page++){
   const payload={query:entryId,limit:50,sort:'installs',...(marketplace==='teloa'?{}:{marketplace}),...(cursor===null?{}:{cursor})}
   const result=listPage(await ports.catalog('market-catalog/list',payload))
   const found=result.items.find(item=>item.entry.id===entryId)
   if(found)return found
   cursor=result.nextCursor;if(cursor===null)break
  }
 }
 return undefined
}
const briefItem=(item:MarketCatalogListItem)=>({entryId:item.entry.id,kind:item.entry.kind,marketplace:entryMarketplace(item.entry),title:entryTitle(item.entry)})
async function resolveCatalogCandidate(ctx:GithubContext,item:MarketCatalogListItem):Promise<MarketCandidate>{
 return catalogCandidate(item,ctx.ports)
}
async function resolve(ctx:GithubContext,reference:MarketReference):Promise<{candidate:MarketCandidate}|{ambiguous:true;candidates:ReturnType<typeof briefItem>[]}>{
 if(reference.kind==='github')return {candidate:await resolveGithubCandidate(ctx,{owner:reference.owner,repo:reference.repo,ref:reference.ref,...(reference.path===undefined?{}:{path:reference.path})},reference.skillPath)}
 if(reference.kind==='catalog'){
  const item=await findCatalogItem(ctx.ports,reference.entryId)
  if(item)return {candidate:await resolveCatalogCandidate(ctx,item)}
  // market.teloa.ai 链接指向的就是一个确定条目：未命中不回落名称检索
  if(reference.strict)throw new WorkError('teloa/source-unavailable','官方目录中没有这个资源，请核对 market.teloa.ai 链接或先用 teloa_market_search 查找。')
 }
 const query=reference.kind==='catalog'?reference.entryId:reference.query
 const {items}=await searchCatalog(ctx.ports,{query:query.slice(0,120)})
 if(items.length===1)return {candidate:await resolveCatalogCandidate(ctx,items[0]!)}
 if(items.length===0)throw new WorkError('teloa/source-unavailable','未找到匹配的目录资源，请换个说法、给出 GitHub 链接或 market.teloa.ai 链接。')
 return {ambiguous:true,candidates:items.slice(0,10).map(briefItem)}
}
function resolveInput(args:unknown):MarketReference{
 const row=taskInput(args,['reference'])
 if(!cleanText(row.reference,500))throw bad('reference 必须是不超过 500 字的文本。')
 return parseMarketReference(row.reference)
}

// ---- 随附官方扩展（IM 通道）：候选来自编译期常量，不经目录解析与指纹 ----
export function bundledAddInput(args:unknown):BundledExtensionId|undefined{
 if(!isRecord(args)||!isRecord(args.candidate)||args.candidate.kind!=='bundled-extension')return undefined
 const row=taskInput(args,['candidate','expectedFingerprint','install'])
 const raw=taskInput(row.candidate,['kind','extensionId'])
 // 会话内启用卡的文案与去向只针对 IM 通道；其它随附扩展（本地中文检索）只在市场「扩展」启停。
 if(!isBundledExtensionId(raw.extensionId)||raw.extensionId!=='im-gateway')throw bad('官方扩展 id 不正确；会话内目前只能启用 im-gateway。')
 return raw.extensionId
}
/** 契约读取器对形状不对的回包抛 invalid-input；这里是宿主回包，按本文件惯例归为 invalid-host-response。 */
function hostView(value:unknown):BundledExtensionView{
 try{return readBundledExtensionView(value)}catch{throw hostBad('官方扩展服务')}
}
function bundledView(rows:unknown,id:BundledExtensionId):BundledExtensionView{
 if(!Array.isArray(rows))throw hostBad('官方扩展服务')
 const view=rows.map(hostView).find(row=>row.id===id)
 if(!view)throw hostBad('官方扩展服务')
 return view
}
/** 卡片文案不随预检状态变：预检到执行之间状态可能被市场页改动，执行按当时状态决定写不写，卡片两种结果都写明。 */
export function bundledAddReason(view:BundledExtensionView,prior:string):string{
 return `${prior}启用官方扩展「IM 通道」（${view.packageName} ${view.version}，随 Teloa 提供，不从网络下载）。未启用时立即启用并加载，不需要重启 Teloa；已启用则不做改动。之后到 设置 · IM 通道 配置飞书、Lark、Telegram 或 Slack，密钥只在设置页填写、不经聊天。`
}
/** 会话内启用官方扩展：预检一律出卡。decision 的类型沿用本文件预检分支已有的原生判定类型。 */
export function bundledAddDecision(view:BundledExtensionView,decision:{kind:string;reason?:string}):{kind:'ask';reason:string}{
 return {kind:'ask',reason:bundledAddReason(view,decision.kind==='ask'&&decision.reason?`原生规则同时要求确认：${decision.reason} `:'')}
}
export async function executeBundledAdd(ports:Pick<MarketSessionToolsPorts,'bundledExtensions'>,id:BundledExtensionId):Promise<{extensionId:BundledExtensionId;state:BundledExtensionView['state'];guidance:string;next:{page:string}}>{
 let view=bundledView(await ports.bundledExtensions('bundled-extensions/list',{}),id)
 if(view.state==='available'||view.state==='disable-pending')view=hostView(await ports.bundledExtensions('bundled-extensions/set',{extensionId:id,enabled:true}))
 const guidance=view.state==='active'?'IM 通道已启用，现在就可以到 设置 · IM 通道 配置渠道（密钥只在设置页填写，不经聊天）。'
  :view.state==='failed'?'IM 通道已启用，但本次启动没有加载成功，请到 设置 · 系统组件 查看原因。'
  // 即时启用没能套用时（例如本机配置另有未生效的改动）才会回到「重启后生效」。
  :'IM 通道已启用，重启 Teloa 后生效；之后到 设置 · IM 通道 配置渠道（密钥只在设置页填写，不经聊天）。'
 return {extensionId:id,state:view.state,guidance,next:{page:'settings/teloa-im-channels'}}
}

// ---- teloa_market_add ----
type AddInput={candidate:{kind:'catalog';entryId:string}|{kind:'github';githubRequestId:string;skillPath:string};expectedFingerprint:string;install:boolean;installExplicit:boolean}
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const safePath=(value:unknown):value is string=>typeof value==='string'&&!!value&&value.length<=500&&!value.startsWith('/')&&safeSegments(value.split('/'))
function addInput(args:unknown):AddInput{
 const row=taskInput(args,['candidate','expectedFingerprint','install'])
 const raw=taskInput(row.candidate,['kind','entryId','githubRequestId','skillPath'])
 let candidate:AddInput['candidate']
 if(raw.kind==='catalog'){
  taskInput(raw,['kind','entryId'])
  if(typeof raw.entryId!=='string'||!ENTRY_ID.test(raw.entryId))throw bad('候选资源 id 格式不正确。')
  candidate={kind:'catalog',entryId:raw.entryId}
 }else if(raw.kind==='github'){
  taskInput(raw,['kind','githubRequestId','skillPath'])
  if(typeof raw.githubRequestId!=='string'||!UUID.test(raw.githubRequestId)||!safePath(raw.skillPath)||raw.skillPath.split('/').at(-1)!=='SKILL.md')throw bad('GitHub 候选必须带解析得到的 githubRequestId 与指向 SKILL.md 的路径。')
  candidate={kind:'github',githubRequestId:raw.githubRequestId.toLowerCase(),skillPath:raw.skillPath}
 }else throw bad('候选类型只能是 catalog 或 github。')
 if(typeof row.expectedFingerprint!=='string'||!/^(?:[0-9a-f]{64}|[0-9a-f]{40})$/.test(row.expectedFingerprint))throw bad('expectedFingerprint 必须是解析返回的校验值。')
 if(row.install!==undefined&&typeof row.install!=='boolean')throw bad('install 只能是布尔值。')
 return {candidate,expectedFingerprint:row.expectedFingerprint,install:row.install!==false,installExplicit:row.install!==undefined}
}
type AddContext=GithubContext&{lookup:(githubRequestId:string)=>GithubSource|undefined}
/** 按候选重新解析并核对：指纹变化、不可添加、连接器、方案带 install 都在这里拒绝；pre 与 execute 共用同一份核对。 */
async function checkedCandidate(ctx:AddContext,input:AddInput):Promise<MarketCandidate>{
 let candidate:MarketCandidate
 if(input.candidate.kind==='catalog'){
  const item=await findCatalogItem(ctx.ports,input.candidate.entryId)
  if(!item)throw new WorkError('teloa/source-unavailable','官方目录中没有这个资源，请先用 teloa_market_resolve 解析。')
  candidate=await resolveCatalogCandidate(ctx,item)
 }else{
  const source=ctx.lookup(input.candidate.githubRequestId)
  if(!source)throw new WorkError('teloa/source-unavailable','没有这个 GitHub 解析结果，请先用 teloa_market_resolve 解析来源。')
  candidate=await resolveGithubCandidate(ctx,source,input.candidate.skillPath)
 }
 if(candidate.fingerprint!==input.expectedFingerprint)throw new WorkError('teloa/version-conflict','来源已变化，请重新解析后再添加。')
 if(!candidate.addable)throw new WorkError('teloa/source-unavailable',candidate.reason??'该来源不可添加。')
 if(candidate.kind==='catalog'&&candidate.entryKind==='solution'&&input.installExplicit&&input.install)throw bad('行业方案添加后请用 teloa_industry_load 加载，install 只能缺省或为 false。')
 if(candidate.kind==='catalog'&&(candidate.entryKind==='role'||candidate.entryKind==='model')&&input.installExplicit&&input.install)throw bad('AI 员工/模型资源不安装，install 只能缺省或为 false。')
 return candidate
}
const isSkill=(candidate:MarketCandidate)=>candidate.kind==='github'||candidate.entryKind==='skill'
type InstallPreview={bundleHash:string;trustHash?:string;native:{name:string};files:{path:string;hash:string}[]}
function installPreview(value:unknown):InstallPreview{
 if(!isRecord(value)||typeof value.bundleHash!=='string'||!isRecord(value.native)||typeof value.native.name!=='string'||!Array.isArray(value.files)||value.trustHash!==undefined&&typeof value.trustHash!=='string')throw hostBad('技能安装服务')
 for(const file of value.files)if(!isRecord(file)||typeof file.path!=='string'||typeof file.hash!=='string')throw hostBad('技能安装服务')
 return value as InstallPreview
}
const fileKeys=(files:readonly {path:string;hash:string}[])=>files.map(file=>file.path+'\u0000'+file.hash).sort().join('\n')
/** Git blob 不是 SHA-256；从内容仓真实字节核对清单（blob 与目录钉的 sha256），再与原生安装预览比较 SHA-256，不能直接比较两种摘要。 */
function installedFileKeys(candidate:MarketCandidate,value:unknown):string|null{
 if(candidate.kind!=='catalog'||candidate.fileHashAlgorithm!=='git-blob')return fileKeys(candidate.preview.files)
 const content=isRecord(value)&&isRecord(value.content)?value.content:value
 if(!isRecord(content)||!Array.isArray(content.files)||content.files.length!==candidate.preview.files.length||content.files.length>MARKET_CATALOG_MAX_FILES)return null
 const expected=new Map(candidate.preview.files.map(file=>[candidate.name+'/'+file.path,file])),seen=new Set<string>(),actual:{path:string;hash:string}[]=[];let total=0
 for(const file of content.files){
  if(!isRecord(file)||typeof file.path!=='string'||typeof file.base64!=='string'||file.base64.length>Math.ceil(MARKET_CATALOG_MAX_FILE_SIZE/3)*4||seen.has(file.path))return null
  const fixed=expected.get(file.path);if(!fixed)return null
  const bytes=Buffer.from(file.base64,'base64');total+=bytes.byteLength
  if(bytes.toString('base64')!==file.base64||bytes.byteLength>MARKET_CATALOG_MAX_FILE_SIZE||total>MARKET_CATALOG_MAX_TOTAL_SIZE||fixed.size!==undefined&&bytes.byteLength!==fixed.size)return null
  const blob=createHash('sha1').update('blob '+bytes.byteLength+'\0').update(bytes).digest('hex'),hash=createHash('sha256').update(bytes).digest('hex')
  // 三者都按真实字节核对：git blob（定位）、目录钉的 sha256、内容仓回报的 sha256
  if(blob!==fixed.hash||hash!==file.hash||hash!==fixed.sha256)return null
  seen.add(file.path);actual.push({path:fixed.path,hash})
 }
 return fileKeys(actual)
}
/** 确认卡文案：全部字段来自目录条目 / 解析回包 / 真实安装预览，不含模型传入的任何自由文本。 */
function addReason(candidate:MarketCandidate,install:boolean,preview:InstallPreview|undefined,prior:string):string{
 const {preview:p}=candidate,paths=p.files.map(file=>file.path),files=`${paths.length} 个文件：${paths.slice(0,10).join('、')}${paths.length>10?'…':''}`
 const license=p.license??'未注明'
 if(candidate.kind==='catalog'&&candidate.entryKind==='role'){
  const skills=candidate.roleSkills??[]
  return `${prior}确认创建 AI 员工“${candidate.name}”（${p.source}，许可 ${license}，校验值 ${candidate.fingerprint}）？此员工需要的技能：${skills.length?skills.join('、'):'无'}（可在市场添加或加载所属方案）。员工创建后默认暂停，可在 团队 页恢复；不创建方案加载。`
 }
 if(!isSkill(candidate)){
  return `${prior}确认添加行业方案“${candidate.name}”（${p.source}，许可 ${license}，校验值 ${candidate.fingerprint}）到本人内容库？加载到空间时会再次确认将创建的对象。`
 }
 const digest=preview?`；安装包校验值（bundleHash）${preview.bundleHash}${preview.trustHash?`；信任信息校验值（trustHash）${preview.trustHash}`:''}`:''
 const egress=p.dataEgress?`是（${p.domains.length?p.domains.join('、'):'联网'}）`:'否'
 const tier=p.tier==='network-or-script'?`按技能说明，它会访问：${p.domains.length?p.domains.join('、'):'（未列出主机）'}；需要工具：${p.tools.length?p.tools.join('、'):'无'}；数据出境：${egress}。`:''
 const head=install?`确认添加并安装技能“${candidate.name}”到当前 Teloa？`:`确认添加技能“${candidate.name}”到本人内容库？安装另需确认。`
 const note=install&&!preview?'安装校验值将在添加后由 Teloa 核对：预览文件清单必须与本卡一致，否则不安装。':''
 const shared=p.secretSharedWith?.length?`密钥与 ${p.secretSharedWith.join('、')} 共用（保存或删除对这些技能同时生效）；`:''
 const secretNote=p.secretLabels.length?`需要密钥 ${p.secretLabels.join('、')}；密钥由 Teloa 保管，只发往技能说明中写明的地址：${p.secretTargets.join('；')}。${shared}添加后请到 市场 > 技能 > 该技能 > 密钥 填写，不要发到会话。`:''
 return `${prior}${head}来源 ${p.source}；许可 ${license}；${files}；校验值 ${candidate.fingerprint}${digest}。${tier}${secretNote}${note}添加与安装都不会执行正文或附件。`
}
type ContentReceipt={id:string;kind:'atomic-skill'|'industry-template';hash:string}
function contentReceipt(value:unknown):ContentReceipt{
 const content=isRecord(value)&&isRecord(value.content)?value.content:value
 if(!isRecord(content)||typeof content.id!=='string'||!UUID.test(content.id)||(content.kind!=='atomic-skill'&&content.kind!=='industry-template')||typeof content.hash!=='string')throw hostBad('市场内容服务')
 return {id:content.id.toLowerCase(),kind:content.kind,hash:content.hash}
}
const undoOf=(kind:ContentReceipt['kind'])=>kind==='atomic-skill'?'能力 > 技能安装 中可停用（卸载与删除内容库资源为二期）':'内容库资源删除为二期；方案加载后可在 空间 > 行业方案 卸载'
/** execute：添加（已添加则跳过）→ 真实预览逐文件核对 → 安装；核对失败时内容已添加但不安装，回执如实写 installed:false。 */
async function executeAdd(ctx:AddContext,input:AddInput,requestId:string){
 const candidate=await checkedCandidate(ctx,input)
 if(candidate.kind==='catalog'&&candidate.entryKind==='model'){
  if(candidate.modelForm==='local-general')return {entryId:candidate.entryId,guidance:'本机模型请用 teloa_model_prepare 发起下载申请，或到 设置 · 本地模型 操作。',next:{page:'settings/local-models',entryId:candidate.entryId}}
  // 本地专用模型按 usage 分支引导（规格 §5.1、§7.3）：会话里只给引导，不下载、不启用扩展。
  if(candidate.modelForm==='local-specialist')return {entryId:candidate.entryId,guidance:candidate.modelUsage?.includes('embedding')
   ?'在市场「模型」中打开“'+candidate.name+'”的「准备本地检索」。未启用时先到市场「扩展」启用「本地中文检索」并重启，再在确认卡确认下载推理程序与模型。嵌入计算在运行 Teloa 的设备上执行，检索摘录仍会进入当前会话使用的模型；无需聊天 API 密钥，不改变聊天模型。'
   :'在市场「模型」中打开“'+candidate.name+'”的「准备本地语音」。未启用时先到设置启用「语音输入」并重启，再在原生准备界面确认下载。识别在运行 Teloa 的设备上执行；无需聊天 API 密钥，不改变聊天模型。',next:{page:'market/models',entryId:candidate.entryId}}
  return {entryId:candidate.entryId,guidance:`模型不在会话里添加：请到 设置 · 模型 配置“${candidate.name}”（新建路由并填写密钥，密钥不经聊天）。`,next:{page:'settings/models'}}
 }
 if(candidate.kind==='catalog'&&candidate.entryKind==='role'){
  // 不传 requestId：宿主按（本人, 条目, 版本）派生，重复添加同一条目返回 existing 与同一岗位
  const receipt=await ctx.ports.catalog('market-catalog/add',{entryId:candidate.entryId,version:candidate.version,kind:'role'})
  if(!isRecord(receipt)||typeof receipt.roleId!=='string'||!UUID.test(receipt.roleId)||(receipt.status!=='created'&&receipt.status!=='existing')||!Array.isArray(receipt.skills)||receipt.skills.some(item=>typeof item!=='string'))throw hostBad('官方目录服务')
  return {roleId:receipt.roleId,status:receipt.status,skills:receipt.skills as string[],next:{page:'team',roleId:receipt.roleId},undo:'团队 > 员工 > 暂停或退役'}
 }
 let contentValue:unknown
 if(candidate.kind==='catalog'){
  if(candidate.addedContentId)contentValue=await ctx.ports.content('market-content/get',{contentId:candidate.addedContentId})
  else contentValue=await ctx.ports.catalog('market-catalog/add',{requestId,entryId:candidate.entryId,expectedTreeHash:candidate.treeHash})
 }else contentValue=await ctx.ports.content('market-content/import-github-skill',{requestId,githubRequestId:candidate.githubRequestId,skillPath:input.candidate.kind==='github'?input.candidate.skillPath:candidate.skillPath})
 const content=contentReceipt(contentValue)
 const source={kind:'atomic' as const,contentId:content.id}
 let installation:{id:string;bundleHash:string;trustHash?:string;state:string}|undefined
 if(content.kind==='atomic-skill'&&input.install){
  const preview=installPreview(await ctx.ports.skills('skill-installations/preview',{source}))
  if(preview.native.name!==candidate.name||fileKeys(preview.files)!==installedFileKeys(candidate,contentValue))throw new WorkError('teloa/source-unavailable',`添加后的文件与确认卡不一致，未安装。操作记录：${JSON.stringify({requestId,contentId:content.id,kind:content.kind,installed:false})}`)
  const installed=await ctx.ports.skills('skill-installations/install',{requestId,source,expectedBundleHash:preview.bundleHash,...(preview.trustHash?{expectedTrustHash:preview.trustHash}:{})})
  const record=isRecord(installed)&&isRecord(installed.installation)?installed.installation:undefined
  if(!record||typeof record.id!=='string'||typeof record.bundleHash!=='string'||typeof record.state!=='string')throw hostBad('技能安装服务')
  installation={id:record.id,bundleHash:record.bundleHash,...(typeof record.trustHash==='string'?{trustHash:record.trustHash}:{}),state:record.state}
 }
 const next=content.kind==='industry-template'?{tool:'teloa_industry_load',contentId:content.id,expectedContentHash:content.hash}:installation?{tool:'teloa_skills_observe',installationId:installation.id}:{tool:'teloa_skills_preview',source}
 return {requestId,contentId:content.id,kind:content.kind,source:candidate.preview.source,...(installation?{installation}:{}),installed:installation!==undefined,next,undo:undoOf(content.kind),
  ...(content.kind==='atomic-skill'&&candidate.preview.requiredSecrets.length?{configure:{page:'market/skill-secrets',skill:candidate.name,vars:candidate.preview.requiredSecrets}}:{})}
}

// ---- 密钥不进聊天：八个工具的全部参数（键名与字符串值）统一扫描 ----
export const secretLikeKey=/token|secret|password|passwd|api[-_]?key|credential|bearer|authorization|cookie/i
/** 常见令牌前缀：出现在值的开头或分隔符之后即视为密钥。 */
export const secretLikePrefix=/(?:^|[\s"'=:,;(\[{])(?:sk-|ghp_|github_pat_|xox[a-z]-|AKIA|Bearer )/
const SECRET_DENY='密钥不进聊天：请在 市场 > 连接 > 连接设置 里填写，不要把令牌发到会话。若不是密钥，请改用描述或链接。'
/** 结构化标识字段：后续都有格式 / 路径 / 回包校验，伪装值只会查无此项，故只做前缀检测、不做熵判定（避免误伤 ≥32 字符的 skillPath 等）。 */
const structuredKeys=new Set(['expectedFingerprint','githubRequestId','contentId','expectedContentHash','entryId','catalogId','skillPath'])
/** 可读标识：两个以上纯英文单词由下划线 / 连字符连接（如 PDF_Table_Extraction_Tool），不按高熵串处理。 */
const readableIdentifier=/^[A-Za-z]+(?:[_-][A-Za-z]+)+$/
export function shannonEntropy(value:string):number{
 if(!value)return 0
 const counts=new Map<string,number>()
 for(const char of value)counts.set(char,(counts.get(char)??0)+1)
 let entropy=0
 for(const count of counts.values()){const p=count/value.length;entropy-=p*Math.log2(p)}
 return entropy
}
/** 明显不是密钥的结构化取值：指纹 / uuid、白名单 https 链接、小写目录 id、可读英文标识；其余 ≥32 位无空白 ASCII 高熵串按密钥处理（启发式，不保证识别所有形态；误伤时固定句引导改用描述或链接）。 */
function structuredValue(value:string):boolean{
 if(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)||UUID.test(value))return true
 if(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(value)||readableIdentifier.test(value))return true
 if(/^https:\/\//.test(value)){try{const url=new URL(value);return url.hostname==='github.com'||url.hostname==='market.teloa.ai'}catch{return false}}
 return false
}
/** `structured` 为真（结构化标识字段）时只做前缀检测，不做熵判定。 */
export function secretLikeValue(value:string,structured=false):boolean{
 if(secretLikePrefix.test(value))return true
 if(structured||value.length<32||!/^[\x21-\x7e]+$/.test(value)||structuredValue(value))return false
 return shannonEntropy(value)>=3.5
}
/** 递归扫描参数：任一键名或字符串值像密钥即为真；不返回命中的内容。结构化标识字段按键名豁免熵判定。 */
export function containsSecretLike(value:unknown,structured=false):boolean{
 if(typeof value==='string')return secretLikeValue(value,structured)
 if(Array.isArray(value))return value.some(item=>containsSecretLike(item,structured))
 if(isRecord(value))return Object.entries(value).some(([key,item])=>secretLikeKey.test(key)||containsSecretLike(item,structuredKeys.has(key)))
 return false
}

// ---- teloa_mcp_connect ----
type ConnectionRecord={id:string;catalogId:string;serverName:string;status:string;errorMessage?:string;tools?:unknown[];createdAt:string;updatedAt:string}
function connectionRecord(value:unknown):ConnectionRecord{
 if(!isRecord(value)||typeof value.id!=='string'||!UUID.test(value.id)||typeof value.catalogId!=='string'||typeof value.serverName!=='string'||typeof value.status!=='string'||typeof value.createdAt!=='string'||typeof value.updatedAt!=='string')throw hostBad('受管 MCP 连接服务')
 return {id:value.id,catalogId:value.catalogId,serverName:value.serverName,status:value.status,...(typeof value.errorMessage==='string'?{errorMessage:value.errorMessage}:{}),...(Array.isArray(value.tools)?{tools:value.tools}:{}),createdAt:value.createdAt,updatedAt:value.updatedAt}
}
const hostnameOf=(url:string)=>{try{return new URL(url).hostname}catch{return '（地址无效）'}}
const secretNames=(entry:MarketCatalogConnectorEntry)=>entry.connector.auth.kind==='secret'?entry.connector.auth.vars.map(v=>v.target==='env'?v.envVarName:v.target==='bearer'?'Bearer Token':'URL 路径令牌'):[]
/** 连接器入参只有 catalogId；条目不存在用固定句，不回显传入值。 */
async function connectorFor(ports:MarketSessionToolsPorts,args:unknown,checkExisting=true):Promise<MarketCatalogConnectorEntry>{
 const catalogId=isRecord(args)?args.catalogId:undefined
 const entry=typeof catalogId==='string'&&catalogId.length<=120?ports.connectorEntry(catalogId):undefined
 if(!entry)throw new WorkError('teloa/source-unavailable','目录中没有这个连接，请先用 teloa_market_search 查找。')
 taskInput(args,['catalogId'])
 if(entry.compatibility.status==='unsupported')throw new WorkError('teloa/source-unavailable',entry.connector.auth.kind==='oauth'&&!entry.connector.auth.supported?entry.connector.auth.reason:conditionsText(entry).join('')||'该连接暂不支持在 Teloa 中添加。')
 if(checkExisting){
  const listed=await ports.mcp('mcp-connections/list',{})
  if(!isRecord(listed)||!Array.isArray(listed.items))throw hostBad('受管 MCP 连接服务')
  if(listed.items.some(item=>isRecord(item)&&item.serverName===entry.connector.serverName))throw new WorkError('teloa/conflict','该连接已添加，请到 市场 > 连接 操作。')
 }
 return entry
}
/** 确认卡：全部字段来自目录条目配方；stdio 配方明说会安装 npm 包并在本机启动进程（授权分级表「执行代码」档）。 */
function connectReason(entry:MarketCatalogConnectorEntry,prior:string):string{
 const c=entry.connector,title=c.title['zh-CN'],tools=c.tools.length?c.tools.map(tool=>`${tool.name}（${tool.readOnly?'只读':'写'}）`).join('、'):'无'
 const secrets=c.auth.kind==='secret'?`需要密钥 ${secretNames(entry).join('、')}；本次只登记连接，密钥请到连接设置页填写后再连接。`
  :c.auth.kind==='oauth'?'需要 OAuth 授权；本次只登记连接，请到 市场 > 连接 页由本人在浏览器中完成授权后再使用。'+(c.auth.supported&&c.auth.scopes.length===0?'注意：该连接授权不限定权限范围，令牌为全权限，只读仅依赖服务端参数（如 read_only=true）。':''):''
 if(c.recipe.transport==='stdio'){
  return `${prior}确认添加 MCP 连接“${title}”？将安装 npm 包 ${c.recipe.package}@${c.recipe.version}（忽略安装脚本，核对 integrity）并在本机启动进程 ${c.recipe.bin}；原始来源 ${c.upstreamUrl}，许可 ${entry.license.spdx}。提供工具：${tools}；数据出境：按安装方式说明为无。${secrets}`
 }
 const host=hostnameOf(c.recipe.transport==='streamable-http'?c.recipe.url:c.recipe.urlTemplate.split('{secret}')[0]!)
 return `${prior}确认添加 MCP 连接“${title}”（HTTP：${host}，原始来源 ${c.upstreamUrl}，许可 ${entry.license.spdx}）？提供工具：${tools}；数据出境：${host}。${secrets}`
}
/**
 * execute：add 不传 credentials；无凭据配方接着 connect（stdio 此刻安装并启动），需凭据的只登记并引导到连接设置页。
 * OAuth 配方同样只登记：授权必须由本人在连接页发起并在浏览器中完成，会话侧不发起授权流程。
 */
async function executeConnect(ports:MarketSessionToolsPorts,args:unknown){
 // 同 serverName 的重复添加由 add handler 自己按 conflict 拒绝，execute 不再多查一次列表
 const entry=await connectorFor(ports,args,false)
 let connection=connectionRecord(await ports.mcp('mcp-connections/add',{catalogId:entry.id}))
 const secret=entry.connector.auth.kind==='secret',oauth=entry.connector.auth.kind==='oauth'
 if(!secret&&!oauth)connection=connectionRecord(await ports.mcp('mcp-connections/connect',{id:connection.id}))
 const next=secret?{page:'market/connections',connectionId:connection.id,action:'fill-credentials-and-connect',secrets:secretNames(entry)}
  :oauth?{page:'market/connections',connectionId:connection.id,action:'authorize-oauth'}
  :{page:'capabilities',connectionId:connection.id}
 return {connection,next,undo:'市场 > 连接 > 删除'}
}

// ---- teloa_industry_load ----
type LoadInput={contentId:string;expectedContentHash:string}
function loadInput(args:unknown):LoadInput{
 const row=taskInput(args,['contentId','expectedContentHash'])
 if(typeof row.contentId!=='string'||!UUID.test(row.contentId)||typeof row.expectedContentHash!=='string'||!/^[0-9a-f]{64}$/.test(row.expectedContentHash))throw bad('contentId 必须是 UUID，expectedContentHash 必须是 64 位十六进制摘要。')
 return {contentId:row.contentId.toLowerCase(),expectedContentHash:row.expectedContentHash}
}
type LoadContent={id:string;kind:string;hash:string;title:string;version:string;provides:{resourceId:string;kind:string}[]}
function loadContent(value:unknown):LoadContent{
 if(!isRecord(value)||typeof value.id!=='string'||typeof value.kind!=='string'||typeof value.hash!=='string'||typeof value.logicalId!=='string'||typeof value.version!=='string'||!Array.isArray(value.provides))throw hostBad('市场内容服务')
 const provides=value.provides.map(item=>{if(!isRecord(item)||typeof item.resourceId!=='string'||typeof item.kind!=='string')throw hostBad('市场内容服务');return {resourceId:item.resourceId,kind:item.kind}})
 const title=isRecord(value.metadata)&&typeof value.metadata.title==='string'&&value.metadata.title.trim()?value.metadata.title:value.logicalId
 return {id:value.id,kind:value.kind,hash:value.hash,title,version:value.version,provides}
}
type Space={id:string;name:string;version:number}
function spaceRecord(value:unknown):Space{
 if(!isRecord(value)||typeof value.id!=='string'||!UUID.test(value.id)||typeof value.name!=='string'||!Number.isSafeInteger(value.version)||Number(value.version)<1)throw hostBad('业务空间服务')
 return {id:value.id,name:value.name,version:Number(value.version)}
}
/** pre 与 execute 共用：内容必须是行业方案且摘要与本人核对过的一致，再读当前空间的版本作为加载目标。 */
async function checkedLoad(ports:MarketSessionToolsPorts,input:LoadInput):Promise<{content:LoadContent;space:Space}>{
 const content=loadContent(await ports.content('market-content/get',{contentId:input.contentId}))
 if(content.kind!=='industry-template')throw new WorkError('teloa/source-unavailable','该内容不是行业方案，不能加载到空间。')
 if(content.hash!==input.expectedContentHash)throw new WorkError('teloa/version-conflict','内容已变化，请重新核对后再加载。')
 return {content,space:spaceRecord(await ports.currentSpace())}
}
const loadGroups:[string,string[]][]=[['员工',['role']],['知识',['knowledge']],['技能',['skill']],['数据源',['data-source']],['MCP 连接',['mcp']],['执行工具',['execution-tool']],['工作模板/计划',['work-template','plan']],['其他',['plugin','object-type','business-view','business-action']]]
/** 确认卡：按 provides.kind 分组列出数量与标识（每组最多 5 个），全部来自内容仓记录。 */
function loadReason(content:LoadContent,space:Space,prior:string):string{
 const groups=loadGroups.map(([label,kinds])=>{const ids=content.provides.filter(item=>kinds.includes(item.kind)).map(item=>item.resourceId);return ids.length?`${label} ${ids.length}（${ids.slice(0,5).join('、')}${ids.length>5?'…':''}）`:''}).filter(Boolean)
 return `${prior}确认把行业方案“${content.title} ${content.version}”加载到本人空间“${space.name}”？将创建：${groups.length?groups.join('、'):'无'}。数据源 / 连接 / 扩展加载后仍需在页面单独授权。`
}
type LoadRecord={id:string;space:{id:string;name:string;version:number;scope:string};items:{kind:string;title:string;status:string}[]}
function loadRecord(value:unknown):LoadRecord{
 if(!isRecord(value)||typeof value.id!=='string'||!UUID.test(value.id)||!isRecord(value.space)||typeof value.space.id!=='string'||typeof value.space.name!=='string'||typeof value.space.version!=='number'||typeof value.space.scope!=='string'||!Array.isArray(value.items))throw hostBad('行业方案加载服务')
 const items=value.items.map(item=>{if(!isRecord(item)||typeof item.kind!=='string'||typeof item.title!=='string'||typeof item.status!=='string')throw hostBad('行业方案加载服务');return {kind:item.kind,title:item.title,status:item.status}})
 return {id:value.id,space:{id:value.space.id,name:value.space.name,version:value.space.version,scope:value.space.scope},items}
}
/** execute：目标固定为本人当前空间（existing + 读到的版本）；空间版本冲突由 handler 抛 version-conflict 原样透传，重试会重新读取版本。 */
async function executeLoad(ports:MarketSessionToolsPorts,input:LoadInput,requestId:string){
 const {content,space}=await checkedLoad(ports,input)
 const record=loadRecord(await ports.industryLoads('industry-loads/create',{requestId,contentId:content.id,contentHash:content.hash,target:{kind:'existing',spaceId:space.id,expectedVersion:space.version}}))
 return {requestId,loadId:record.id,space:record.space,items:record.items,next:{tool:'teloa_industry_readiness',load:record.id},undo:'空间 > 行业方案 > 卸载（industry-loads/unload）'}
}

// ---- teloa_industry_readiness / teloa_industry_prepare（规格 2026-09-26-方案一键准备 §5） ----
type Readiness={loadId:string;status:string;title:string;version:string;digest:string;counts:{ready:number;auto:number;needsUser:number;optional:number;pending:number};rows:{itemInstanceId:string;kind:string;title:string;state:string;step:string|null;entry:string|null;trust?:{publisher:string;license:string|null};models?:IndustryModelObservation[]}[]}
function readinessRecord(value:unknown):Readiness{
 if(!isRecord(value)||typeof value.loadId!=='string'||typeof value.status!=='string'||typeof value.title!=='string'||typeof value.version!=='string'||typeof value.digest!=='string'||!/^[0-9a-f]{64}$/.test(value.digest)||!isRecord(value.counts)||!Array.isArray(value.rows))throw hostBad('方案准备服务')
 const counts=value.counts
 if((['ready','auto','needsUser','optional','pending'] as const).some(key=>!Number.isSafeInteger(counts[key])))throw hostBad('方案准备服务')
 const rows=value.rows.map(row=>{
  if(!isRecord(row)||typeof row.itemInstanceId!=='string'||typeof row.kind!=='string'||typeof row.title!=='string'||typeof row.state!=='string'||(row.step!==null&&typeof row.step!=='string')||(row.entry!==null&&typeof row.entry!=='string'))throw hostBad('方案准备服务')
  if(row.trust!==undefined&&(!isRecord(row.trust)||typeof row.trust.publisher!=='string'||(row.trust.license!==null&&typeof row.trust.license!=='string')))throw hostBad('方案准备服务')
  const trust=isRecord(row.trust)?{trust:{publisher:String(row.trust.publisher),license:row.trust.license===null?null:String(row.trust.license)}}:{}
  return {itemInstanceId:row.itemInstanceId,kind:row.kind,title:row.title,state:row.state,step:row.step as string|null,entry:row.entry as string|null,...trust,...(row.models===undefined?{}:{models:readIndustryModelObservations(row.models)})}
 })
 return {loadId:value.loadId,status:value.status,title:value.title,version:value.version,digest:value.digest,counts:{ready:Number(counts.ready),auto:Number(counts.auto),needsUser:Number(counts.needsUser),optional:Number(counts.optional),pending:Number(counts.pending)},rows}
}
const PREPARE_GUIDE='在行业方案页该方案卡片的「准备就绪」里点「去处理」完成其余项；密钥与授权只在页面填写，不要发到会话。'
function readinessLoadInput(args:unknown):string{
 const row=taskInput(args,['load'])
 if(!cleanText(row.load,200))throw bad('load 必须是加载 UUID 或方案名称片段。')
 return row.load.trim()
}
async function readinessLookup(ports:MarketSessionToolsPorts,load:string){
 const listed=await ports.industryLoads('industry-loads/list',{})
 if(!isRecord(listed)||!Array.isArray(listed.items))throw hostBad('行业方案加载服务')
 const loads=listed.items.filter(isRecord).filter(row=>row.status==='active'&&typeof row.id==='string'&&typeof row.templateTitle==='string')
 const needle=load.toLowerCase()
 const matches=UUID.test(load)?loads.filter(row=>String(row.id).toLowerCase()===needle):loads.filter(row=>String(row.templateTitle).toLowerCase().includes(needle)||String(row.templateId??'').toLowerCase().includes(needle))
 if(matches.length===0)throw new WorkError('teloa/source-unavailable','没有找到匹配的已加载方案，请先用 teloa_industry_load 加载，或换个名称。')
 if(matches.length>1)return {candidates:matches.map(row=>({loadId:row.id,title:row.templateTitle,version:row.templateVersion}))}
 const readiness=readinessRecord(await ports.industryPrepare('industry-loads/readiness',{loadId:String(matches[0]!.id).toLowerCase()}))
 return {...readiness,expectedDigest:readiness.digest,next:readiness.counts.auto>0?{tool:'teloa_industry_prepare',loadId:readiness.loadId,expectedDigest:readiness.digest}:null,guide:PREPARE_GUIDE}
}
type PrepareInput={loadId:string;expectedDigest:string}
function prepareInput(args:unknown):PrepareInput{
 const row=taskInput(args,['loadId','expectedDigest'])
 if(typeof row.loadId!=='string'||!UUID.test(row.loadId)||typeof row.expectedDigest!=='string'||!/^[0-9a-f]{64}$/.test(row.expectedDigest))throw bad('loadId 必须是 UUID，expectedDigest 必须是 64 位十六进制摘要。')
 return {loadId:row.loadId.toLowerCase(),expectedDigest:row.expectedDigest}
}
/** pre 阶段复核：清单读自宿主 handler，摘要须与本人核对过的一致且至少有一项可自动完成，否则拒绝、不弹卡、不执行。 */
async function checkedPrepare(ports:MarketSessionToolsPorts,input:PrepareInput):Promise<Readiness>{
 const readiness=readinessRecord(await ports.industryPrepare('industry-loads/readiness',{loadId:input.loadId}))
 if(readiness.loadId.toLowerCase()!==input.loadId)throw hostBad('方案准备服务')
 if(readiness.status!=='active')throw new WorkError('teloa/conflict','方案已卸载或已被升级替代，不能准备。')
 if(readiness.digest!==input.expectedDigest)throw new WorkError('teloa/version-conflict','方案状态已变化，请先用 teloa_industry_readiness 重新读取后再确认。')
 if(readiness.counts.auto===0)throw new WorkError('teloa/conflict','该方案当前没有可一键完成的项，其余项请到行业方案页「准备就绪」里处理。')
 // 随一键安装的技能必须在卡上全部逐项列出；太多放不下时不出卡，改到面板确认（面板逐行全部列出）
 if(readiness.rows.filter(row=>row.state==='auto'&&row.trust).length>MAX_TRUSTED_ON_CARD)throw new WorkError('teloa/conflict',`随一键安装的技能超过 ${MAX_TRUSTED_ON_CARD} 个，确认卡放不下逐项清单，请到行业方案页「准备就绪」里核对后点「一键准备」。`)
 return readiness
}
const stepLabels:Record<string,string>={knowledge:'启用资料',skill:'安装技能',mcp:'登记连接','data-source':'登记连接','execution-tool':'登记连接',role:'创建员工'}
const entryLabels:Record<string,string>={'connector-settings':'连接设置','skill-confirm':'逐个确认技能（联网、执行权限、非官方来源或脚本）',plugin:'扩展安装确认','knowledge-retry':'资料启用失败待重试','role-retry':'员工创建失败待重试','role-resume':'恢复暂停的员工','task-form':'按模板建任务','plan-form':'启用周期计划'}
/** 卡片里的宿主文本（方案标题、版本、条目标题）：去掉控制与格式字符（含双向覆盖 U+202A–202E、U+2066–2069），合并空白，截到 30 字，外包「」。 */
function cardText(value:string):string{
 const flat=[...value.replace(/[\p{Cc}\p{Cf}]/gu,ch=>/\s/.test(ch)?' ':'').replace(/\s+/g,' ').trim()]
 return `「${flat.length>30?flat.slice(0,30).join('')+'…':flat.join('')}」`
}
// 整张卡片里条目标题的总字数预算：放不下的组只写「等 N 项」（随一键安装的技能不在此列，见 trustedListing）
const MAX_TRUSTED_ON_CARD=12
const CARD_TITLE_BUDGET=480
/** 按组列出宿主清单里的条目标题（每组最多 10 个、共用总字数预算，超出写「等 N 项」）；卡片文案全由宿主固定模板拼成，不经模型。 */
function listing(rows:Readiness['rows'],state:string,key:'step'|'entry',labels:Record<string,string>,budget:{left:number}):string{
 const groups=new Map<string,string[]>()
 for(const row of rows){const value=row[key];const label=row.state===state&&value?labels[value]:undefined;if(label)groups.set(label,[...(groups.get(label)??[]),row.title])}
 return [...groups].map(([label,titles])=>{
  const shown:string[]=[]
  for(const title of titles.slice(0,10)){const text=cardText(title);if(text.length>budget.left)break;shown.push(text);budget.left-=text.length}
  return `${label}：${shown.join('、')}${shown.length<titles.length?`${shown.length?' ':''}等 ${titles.length} 项`:''}`
 }).join('；')||'无'
}
/** 随一键安装、带信任声明的技能全部逐项列出名称与信任摘要（本人点确认即是对它们的一次确认），不截断、不占其他组的字数预算；超过上限在 pre 阶段就拒绝出卡。 */
function trustedListing(rows:Readiness['rows']):string{
 const trusted=rows.filter(row=>row.state==='auto'&&row.trust).map(row=>`${cardText(row.title)}（发布者${cardText(row.trust!.publisher)}，许可${cardText(row.trust!.license??'未注明')}）`)
 return trusted.length?`将随一键安装的技能（官方目录已审核、纯内容、无联网或执行权限）：${trusted.join('、')}。`:''
}
function prepareReason(r:Readiness,prior:string):string{
 const budget={left:CARD_TITLE_BUDGET},trusted=trustedListing(r.rows)
 // 固定声明放在清单之前：清单只含清洗后的宿主标题，不能伪造成声明
 return `${prior}确认为行业方案${cardText(r.title)}版本${cardText(r.version)}一键准备？新建员工只在关联的资料、技能、连接都已就绪时上岗，上岗会一并启用该员工的每日小结；原本暂停的员工不会自动恢复。密钥与授权只在页面填写，不要发到会话。将自动完成：${listing(r.rows,'auto','step',stepLabels,budget)}。${trusted}需要你到页面处理（不在此处完成）：${listing(r.rows,'needs-user','entry',entryLabels,budget)}。按需使用：${listing(r.rows,'optional','entry',entryLabels,budget)}。`
}
async function executePrepare(ports:MarketSessionToolsPorts,input:PrepareInput){
 const receipt=await ports.industryPrepare('industry-loads/prepare',{loadId:input.loadId,expectedDigest:input.expectedDigest})
 if(!isRecord(receipt)||!Array.isArray(receipt.results))throw hostBad('方案准备服务')
 // 最终清单读取失败时宿主回 null：结果照常返回，计数待刷新
 if(receipt.readiness===null)return {loadId:input.loadId,results:receipt.results,counts:null,guide:`已执行，但最新清单暂未读到，请稍后用 teloa_industry_readiness 重新读取。${PREPARE_GUIDE}`}
 return {loadId:input.loadId,results:receipt.results,counts:readinessRecord(receipt.readiness).counts,guide:PREPARE_GUIDE}
}

const searchParameters={query:{type:'string'},kind:{type:'string',enum:[...marketEntryKinds]},industry:{type:'string',enum:[...marketIndustryKeys]},function:{type:'string',enum:[...marketFunctionKeys]},limit:{type:'integer'}} as const
const resolveParameters={reference:{type:'string',required:true}} as const
const catalogCandidateSchema={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['catalog'],required:true},entryId:{type:'string',required:true}}} as const
const githubCandidateSchema={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['github'],required:true},githubRequestId:{type:'string',required:true},skillPath:{type:'string',required:true}}} as const
const bundledCandidateSchema={type:'object',additionalProperties:false,properties:{kind:{type:'string',enum:['bundled-extension'],required:true},extensionId:{type:'string',enum:['im-gateway'],required:true}}} as const
const addParameters={candidate:{oneOf:[catalogCandidateSchema,githubCandidateSchema,bundledCandidateSchema],required:true},expectedFingerprint:{type:'string'},install:{type:'boolean'}} as const
const mcpParameters={catalogId:{type:'string',required:true}} as const
const loadParameters={contentId:{type:'string',required:true},expectedContentHash:{type:'string',required:true}} as const
const readinessParameters={load:{type:'string',required:true}} as const
const prepareParameters={loadId:{type:'string',required:true},expectedDigest:{type:'string',required:true}} as const
const modelPrepareParameters={entryId:{type:'string',required:true},variant:{type:'integer'}} as const

/** 注册八个会话内市场工具；search / resolve / readiness 只读无确认，add / connect / load / prepare 必经本人原生确认卡。 */
export function registerMarketSessionTools(ctx:Context,ports:MarketSessionToolsPorts){
 // 原生审批前固定事实；执行只使用本次调用的批准快照，下载服务在写锁内再核对目标。
 const approvedModels=new WeakMap<Exec,PullFacts>()
 const definitions=[
  {name:'teloa_model_prepare' as const,description:'将官方市场中的本机模型下载到已配置的 Ollama；本人确认后才开始，进度与取消入口在 设置 · 本地模型。仅接受本机模型资源，不能传地址或密钥；云端模型请到 设置 · 模型 配置。',parameters:modelPrepareParameters},
  {name:'teloa_market_search' as const,description:'按自然语言关键词、资源类型、行业或功能检索 Teloa 官方市场目录（含 Claude Code、Codex、DSH、OpenClaw、ClawHub、Hermes 等外部来源的资源）。只读；结果标明是否可添加（unsupported / 内置不可添加，连接请用 teloa_mcp_connect）。',parameters:searchParameters},
  {name:'teloa_market_resolve' as const,description:'把 GitHub 链接、market.teloa.ai 链接、目录资源 id 或资源名解析为待添加来源，返回预览（来源、许可、文件清单、校验值、按技能说明的网络访问）。只读，不添加；名称有歧义时返回候选列表。',parameters:resolveParameters},
  {name:'teloa_market_add' as const,description:'添加并安装一个已解析的技能到当前 Teloa（一张确认卡；install 缺省为 true）；把行业方案添加到本人内容库（加载另用 teloa_industry_load）；把 AI 员工资源直接创建为暂停员工（一张确认卡）；模型资源不添加：本机通用模型引导到 teloa_model_prepare，云端模型引导到 设置 · 模型，本地语音返回市场原生准备入口。必须先用 teloa_market_resolve 取得 expectedFingerprint。IM 通道等随 Teloa 提供的官方扩展：candidate 传 {kind:\'bundled-extension\',extensionId:\'im-gateway\'}，不需要 expectedFingerprint（官方扩展候选不看 expectedFingerprint 与 install，传了也会忽略）；只能启用（一张确认卡，即时生效，成功后引导本人到 设置 · IM 通道 配置渠道），停用在市场「扩展」里操作。技能停用入口在能力页；卸载与删除内容库资源为二期。',parameters:addParameters},
  {name:'teloa_mcp_connect' as const,description:'按官方目录连接配方添加受管 MCP 连接；无需密钥的直接连接，需要密钥的只登记，密钥请在 市场 > 连接 > 连接设置 里填写，不要发到会话。撤销入口：市场 > 连接 > 删除。',parameters:mcpParameters},
  {name:'teloa_industry_load' as const,description:'把已添加到本人内容库的行业方案加载到本人当前空间；确认卡会列出将创建的员工、知识、技能等对象。撤销入口：空间 > 行业方案 > 卸载。',parameters:loadParameters},
  {name:'teloa_industry_readiness' as const,description:'读取本人某个已加载行业方案的「准备就绪」清单：哪些可一键完成、哪些要到页面处理（连接设置、技能信任、扩展）、哪些按需使用（任务模板、周期计划）。只读；load 为加载 UUID 或方案名称片段，命中多个时返回候选。',parameters:readinessParameters},
  {name:'teloa_industry_prepare' as const,description:'把已加载行业方案中能自动完成的项一次做完：启用资料、安装官方目录已审核、纯内容、无联网与执行权限的技能（确认卡逐项列出）、登记连接、创建员工并只让关联资料、技能、连接都就绪的新员工上岗（上岗会一并启用每日小结，原本暂停的员工不恢复），一张确认卡。必须先用 teloa_industry_readiness 取得 expectedDigest。密钥、授权、扩展、任务与计划不在此完成，结果里会给出页面入口。',parameters:prepareParameters},
 ] as const
 const quota=githubResolveQuota(),githubSources=githubSourceRegistry(ports.owner)
 const githubContext=(sessionId:string,exec:Exec):AddContext=>({ports,sessionId,turn:currentTurn(exec.agent!.session),quota,remember:(id,source)=>githubSources.remember(sessionId,id,source),lookup:id=>githubSources.lookup(sessionId,id)})
 const execute=async(name:typeof marketSessionToolNames[number],args:unknown,exec:Exec)=>{
  const sessionId=await authorize(ports,exec,args,name)
  return safePlanOperation(async()=>{
   if(name==='teloa_model_prepare'){
    const input=modelPrepareInput(args),facts=approvedModels.get(exec)
    if(!facts||input.entryId!==facts.entryId||input.variant!==facts.variant)throw new WorkError('teloa/forbidden','缺少本次模型下载的确认，请重新发起。')
    exec.signal.throwIfAborted()
    const job=await ports.localModels.startPull({entryId:facts.entryId,version:facts.version,variant:facts.variant,acknowledgeRestrictions:true,requestId:planRequestIdentity(ports.owner,sessionId,name,String(exec.callId))},facts,exec.signal)
    return JSON.stringify({pullId:job.pullId,name:job.name,next:{page:'settings/local-models',entryId:facts.entryId}})
   }
   if(name==='teloa_market_search')return JSON.stringify(await search(ports,searchInput(args)))
   if(name==='teloa_market_resolve'){const reference=resolveInput(args);return JSON.stringify(await resolve(githubContext(sessionId,exec),reference))}
   if(name==='teloa_market_add'){const bundled=bundledAddInput(args);if(bundled)return JSON.stringify(await executeBundledAdd(ports,bundled));const input=addInput(args);return JSON.stringify(await executeAdd(githubContext(sessionId,exec),input,planRequestIdentity(ports.owner,sessionId,name,String(exec.callId))))}
   if(name==='teloa_mcp_connect')return JSON.stringify(await executeConnect(ports,args))
   if(name==='teloa_industry_readiness')return JSON.stringify(await readinessLookup(ports,readinessLoadInput(args)))
   if(name==='teloa_industry_prepare')return JSON.stringify(await executePrepare(ports,prepareInput(args)))
   return JSON.stringify(await executeLoad(ports,loadInput(args),planRequestIdentity(ports.owner,sessionId,name,String(exec.callId))))
  },label)
 }
 // 八个定义参数形状各不相同，按通用参数规格注册；参数校验在各自的 *Input 里做 exact 键校验
 for(const definition of definitions as readonly {name:typeof marketSessionToolNames[number];description:string;parameters:ParameterSchemaSpec}[])ctx.tools.register(defineTool({...definition,output,execute:(args,exec)=>execute(definition.name,args,exec)}))
 return ctx.on('tools/pre-execute',async(exec,next):Promise<PreToolDecision>=>{
  if(!names.has(exec.name))return next()
  let sessionId:string
  try{sessionId=await authorize(ports,exec,exec.arguments,exec.name)}catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法核对会话内安装身份。'}}
  const decision=await next()
  if(decision.kind==='deny'||exec.name==='teloa_market_search'||exec.name==='teloa_market_resolve'||exec.name==='teloa_industry_readiness')return decision
  if(exec.name==='teloa_model_prepare'){
   try{
    const input=modelPrepareInput(exec.arguments),item=await findCatalogItem(ports,input.entryId)
    if(!item||item.entry.kind!=='model')throw bad('官方目录中没有这个本机模型资源。')
    if(item.entry.model.form!=='local-general')throw bad('云端模型请到 设置 · 模型 配置。')
    if(item.entry.compatibility.status==='unsupported')throw bad(conditionsText(item.entry).join('')||'该模型暂不支持接入。')
    const facts=await ports.localModels.pullFacts(input.entryId,input.variant)
    if(facts.runtime==='missing')throw bad('未检测到 Ollama，请到 https://ollama.com/download 安装并启动后再试。')
    approvedModels.set(exec,structuredClone(facts))
    return {kind:'ask',reason:pullCardFacts(facts,decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:'')}
   }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取本机模型信息，请稍后重试。'}}
  }
  if(exec.name==='teloa_market_add'){
   try{
    const bundled=bundledAddInput(exec.arguments)
    if(bundled){
     // 一律出卡、不看当前状态：预检与执行之间状态可能被市场页改动，按状态放行会留下未经确认的写入窗口。
     const view=bundledView(await safePlanOperation(()=>ports.bundledExtensions('bundled-extensions/list',{}),label),bundled)
     return bundledAddDecision(view,decision)
    }
    const input=addInput(exec.arguments),ctx=githubContext(sessionId,exec)
    const candidate=await safePlanOperation(()=>checkedCandidate(ctx,input),label)
    // 模型条目只回设置页引导、不调用任何写端口：沿用原生判定，不另弹卡
    if(candidate.kind==='catalog'&&candidate.entryKind==='model')return decision
    // 已添加且要安装：此刻就能取到真实 bundleHash / trustHash，写进卡片
    const preview=candidate.kind==='catalog'&&candidate.addedContentId&&input.install&&isSkill(candidate)?installPreview(await safePlanOperation(()=>ports.skills('skill-installations/preview',{source:{kind:'atomic',contentId:candidate.addedContentId}}),label)):undefined
    const prior=decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:''
    return {kind:'ask',reason:addReason(candidate,input.install&&isSkill(candidate),preview,prior)}
   }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取待添加来源的预览，已拒绝添加。'}}
  }
  if(exec.name==='teloa_mcp_connect'){
   try{
    const entry=await safePlanOperation(()=>connectorFor(ports,exec.arguments),label)
    return {kind:'ask',reason:connectReason(entry,decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:'')}
   }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取连接配方，已拒绝添加。'}}
  }
  if(exec.name==='teloa_industry_prepare'){
   try{
    const input=prepareInput(exec.arguments),readiness=await safePlanOperation(()=>checkedPrepare(ports,input),label)
    return {kind:'ask',reason:prepareReason(readiness,decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:'')}
   }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取方案准备清单，已拒绝执行。'}}
  }
  try{
   const input=loadInput(exec.arguments),{content,space}=await safePlanOperation(()=>checkedLoad(ports,input),label)
   return {kind:'ask',reason:loadReason(content,space,decision.kind==='ask'?`原生规则同时要求确认：${decision.reason} `:'')}
  }catch(error){return {kind:'deny',reason:error instanceof WorkError?error.message:'无法读取行业方案内容，已拒绝加载。'}}
 })
}
