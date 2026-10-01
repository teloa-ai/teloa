import {WorkError} from './work-error.ts'
import {isRecord} from './resources.ts'
import {industryUpdateCanonical} from './industry-update-compare.ts'
import {readBusinessObjectTypeDefinition,readBusinessViewDefinition,readBusinessActionDefinition,businessDefinitionPaths,type BusinessDefinitionPreview} from './business-definitions.ts'
import {roleWriteDefinition} from './roles.ts'
import {readIndustryDataSourceDefinition,readIndustryMcpConnectionDefinition} from './industry-definitions.ts'
import {readMarketPluginRegistrySource,type MarketPluginRegistrySource} from './market-plugin-installation.ts'

export const pageCreateEntities=['business-definition','business-domain','role','skill','connector','extension'] as const
export type PageCreateEntity=typeof pageCreateEntities[number]

/** 一条页内新建草案。两态照 `ResourceDraft`（`resources.ts`）；模型侧没有任何路径能写出 applied。 */
export type PageCreateDraft={
 id:string;ownerId:string;requestId:string;entity:PageCreateEntity
 /** 业务与连接器必填（目标业务范围）；员工、技能、扩展缺省。general 一律拒绝。 */
 scope?:string
 /** 草案正文的规范化 JSON（`industryUpdateCanonical` 的输出，≤128 KiB）。 */
 body:string;bodyHash:string
 /** 界面列表用的一行摘要，全是标识与计数，不含取值样例（规格 §五第 5 条）。 */
 title:string
 status:'draft'|'applied'|'discarded'
 createdAt:string;updatedAt:string
 /** status==='applied' 才有：落地成的实体身份（岗位 id / 内容 id / 实例 id / 本地声明版本号的字符串形态）。 */
 appliedRef?:string
}

/** 预览三块。`business-definition` 一支另带第二期那三块（差异 / 影响范围 / 试算），其余五支只有这三块。 */
export type PageCreateDraftPreview={
 schema:'teloa.page-create-draft-preview/v1'
 draft:PageCreateDraft
 /** ① 要建什么：逐条字段名 + 取值文本，叶子一律 JSON.stringify，数组保序。 */
 fields:{path:string;value:string}[]
 fieldsTruncated:boolean
 /** ② 会带来什么：权限 / 外发 / 凭据需求 / 会影响哪些既有东西，全是标识与固定词条键，不拼正文。 */
 consequences:{kind:'permission'|'egress'|'credential'|'impact';id:string;required:boolean}[]
 /** ③ 下一步落到哪里：逐字的既有端点名与需要本人另行同意的项。客户端据此摆按钮，不自己判断。 */
 next:{endpoint:string;consentKeys:string[]}
 /** `business-definition` 那一支复用第二期的预览（差异 / 影响范围 / 试算），这一位就是它的回包，本层不重算。 */
 businessPreview?:BusinessDefinitionPreview
 computedAt:string
}

export type PageCreateDraftDirectory={
 schema:'teloa.page-create-drafts/v1';entity:PageCreateEntity;scope?:string;readAt:string
 drafts:PageCreateDraft[]
}

/** 页内新建的资源上限，与 `businessCustomizationLimits` 同规矩：全是字面量常量，不做设置项（规格 §五第 9 条）。 */
export const pageCreateLimits={bodyBytes:131072,draftsPerEntity:16,fieldRows:200,consequences:64} as const

/**
 * 官方扩展白名单（D6）：产品底座只用官方插件，当前没有任何第三方扩展通过评审，因此表为空。
 * 曾经钉过的 `dsh-visualize`（第三方、非 `@deepseek-ai/*`）已整体下线：它做的会话内可视化在
 * Teloa 里非必要（业务看板图表已原生实现），且与「只用官方插件」的约束冲突。
 * 白名单为空时：`matchOfficialExtensions` 一律回空数组；`readPageCreateBody('extension',...)`
 * 对任何包一律拒绝（见下方判据）；`teloa_create_directory entity=extension` 回空清单。
 * 不做设置项、不调网络。表里的包名与版本仍要过 `readMarketPluginRegistrySource`，
 * 免得白名单自己写错还悄悄生效。
 */
export const officialExtensionPackages:readonly {packageName:string;version:string;keywords:readonly string[]}[]=[]

const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const exact=(value:unknown,keys:readonly string[],message:string):Record<string,unknown>=>{
 if(!isRecord(value)||Object.keys(value).length!==keys.length||keys.some(key=>!(key in value)))throw bad(message)
 return value
}

/**
 * 一句话 → 官方包的匹配：只按 `keywords` 逐字子串命中，命中 0 个就回空数组（界面据此只留「去市场挑」）。
 * 不折叠大小写、不做同义词与模糊匹配、不调网络：宁可一个都不推荐，也不猜包名（规格 §四第 6 行）。
 * 上限 3 条同规格 §四第 6 行的「0–3 个推荐」，表将来变长也不会一屏推一堆。
 */
export function matchOfficialExtensions(sentence:string):readonly MarketPluginRegistrySource[]{
 if(typeof sentence!=='string'||!sentence.trim())return []
 return officialExtensionPackages
  .filter(row=>row.keywords.some(keyword=>sentence.includes(keyword)))
  .slice(0,3)
  .map(row=>readMarketPluginRegistrySource({registry:'npm',packageName:row.packageName,version:row.version}))
}

/**
 * 规范化正文：`industryUpdateCanonical` 的输出，同一份草案必得同一个字节串（`bodyHash` 与字段表都取它）。
 * 入参必须是 `readPageCreateBody` 的返回值——那些 `read*` 的返回里没有取值为 `undefined` 的键，
 * 因此输出一定是合法 JSON；超过 `bodyBytes` 即 `teloa/invalid-input`，不静默截断。
 */
export function pageCreateCanonicalBody(value:unknown):string{
 const body=industryUpdateCanonical(value)
 if(new TextEncoder().encode(body).byteLength>pageCreateLimits.bodyBytes)throw bad('页内新建草案正文超过 128 KiB。')
 return body
}

/**
 * 规范化正文 → 路径 → 叶子值文本，预览第一块用。路径展开与第二期共用 `businessDefinitionPaths`
 * 那一处实现，不复制一份：两处各写一遍口径迟早会漂（数组下标、缺省键是否进表）。
 * 超过 `fieldRows` 由调用方截断并置 `fieldsTruncated`，本函数不静默丢行（规格 §五第 7 条）。
 */
export function pageCreateFieldRows(value:unknown):{path:string;value:string}[]{
 return [...businessDefinitionPaths(value)].map(([path,text])=>({path,value:text}))
}

const credentialKey=/(token|secret|password|apikey|api_key|bearer)/i

/**
 * 凭据守卫（规格 §五第 4 条）：命中 `/(token|secret|password|apikey|api_key|bearer)/i` 的键名一律拒绝。
 * 只看键名不看取值：正常的业务文本里逐字出现「password」一类词是可能的，按取值判会把合法草案判死。
 */
export function assertNoCredentialKeys(value:unknown):void{
 const walk=(node:unknown):void=>{
  if(Array.isArray(node)){node.forEach(walk);return}
  if(!isRecord(node))return
  for(const [key,item] of Object.entries(node)){
   if(credentialKey.test(key))throw bad('草案正文不得出现凭据字段「'+key+'」；凭据在既有授权那一步由本人输入。')
   walk(item)
  }
 }
 walk(value)
}

/**
 * 清单与原子 Skill 的判据都不在契约层：v2 清单判据在客户端 `validateIndustryManifest` 与后端
 * `validateManifest`，原子 Skill 判据在客户端 `readAtomicSkill`（异步、吃文件清单）。契约层
 * 既不复制一份（两份判据迟早会漂），也不放它们过去——由调用方注入，缺省即那一支直接
 * `teloa/dependency-unavailable`（与 T3 预览服务可选注入同一做法），而不是悄悄少校验一层。
 */
export type PageCreateAtomicSkillDraft={
 id:string;title:string;version:string;categories:string[];files:{path:string;base64:string}[]
}

const skillText=(value:unknown,label:string,max:number):string=>{
 if(typeof value!=='string'||!value.trim()||value!==value.trim()||value.length>max||/[\x00-\x1f\x7f]/.test(value))throw bad(label+'不正确。')
 return value
}
const skillPath=(value:unknown):string=>{
 const path=skillText(value,'技能文件路径',500)
 if(path.startsWith('/')||path.split('/').some(part=>!part||part==='.'||part==='..')||/[\\:?%#]/.test(path))throw bad('技能文件路径不正确。')
 return path
}
const skillBase64=(value:unknown):string=>{
 if(typeof value!=='string'||value.length===0||value.length%4!==0||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))throw bad('技能文件内容不是有效的 Base64。')
 // Base64 每四位最多三字节；上限先按编码长度收窄，实际读取端仍逐字节核对。
 if(value.length>Math.ceil(2*1024*1024/3)*4)throw bad('技能单个文件超过 2 MiB。')
 return value
}

const skillNamePattern=/^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * DSH 原生解析器（`@deepseek-ai/dsh-skill` 的 `isSkillName`）只认 `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`；
 * frontmatter `name` 不合规的 SKILL.md 会被原生解析器整个忽略，安装时才炸（`teloa/invalid-input`
 * 「Skill 入口缺失…」）。这条判据本该在落库前就拦下，因此把入口 SKILL.md 的 frontmatter 解出来核对，
 * 不等到安装那一步。只看入口 SKILL.md 一份，不解析其余文件。
 */
const assertSkillEntryFrontmatter=(id:string,base64:string):void=>{
 let bytes:Uint8Array
 try{
  bytes=Uint8Array.from(atob(base64),character=>character.charCodeAt(0))
 }catch{
  throw bad('SKILL.md 内容解码失败。')
 }
 let text:string
 try{
  text=new TextDecoder('utf-8',{fatal:true}).decode(bytes)
 }catch{
  throw bad('SKILL.md 内容不是有效的 UTF-8 文本。')
 }
 const lines=text.replace(/\r\n/g,'\n').split('\n')
 const closeIndex=lines[0]==='---'?lines.indexOf('---',1):-1
 if(closeIndex===-1)throw bad('SKILL.md 缺少 frontmatter（须以 --- 开头并以 --- 闭合）。')
 const frontmatter:Record<string,string>={}
 for(const line of lines.slice(1,closeIndex)){
  const match=/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line)
  if(!match)continue
  frontmatter[match[1]!]=match[2]!.trim().replace(/^(['"])(.*)\1$/,'$2')
 }
 if(!frontmatter.name)throw bad('SKILL.md 的 frontmatter 缺少 name。')
 if(!frontmatter.description)throw bad('SKILL.md 的 frontmatter 缺少 description。')
 if(!skillNamePattern.test(frontmatter.name)||frontmatter.name!==id)throw bad('SKILL.md 的 frontmatter name 必须与草案 id 相同，且只能是小写字母、数字和连字符（DSH 规则），当前为「'+frontmatter.name+'」。')
}

/**
 * 会话侧 Skill 草案的可序列化正文。正文只保存元数据与文本文件的 Base64，
 * 不含本地路径、凭据或任何可执行动作；确认页再按既有 `readAtomicSkill` 读取字节并固定摘要。
 */
export function readPageCreateAtomicSkillDraft(value:unknown):PageCreateAtomicSkillDraft{
 const row=exact(value,['id','title','version','categories','files'],'技能草案正文格式不正确。')
 const id=skillText(row.id,'技能标识',120)
 if(!/^[a-zA-Z0-9][a-zA-Z0-9-]*$/.test(id))throw bad('技能标识仅允许字母、数字和连字符。')
 if(id.toLowerCase().startsWith('teloa-'))throw bad('以 teloa- 开头的技能名保留给 Teloa 内置技能，请换一个名称。')
 const title=skillText(row.title,'技能名称',120),version=skillText(row.version,'技能版本',80)
 if(!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version))throw bad('技能版本必须是固定的三段版本号。')
 if(!Array.isArray(row.categories)||row.categories.length>20)throw bad('技能分类最多 20 项。')
 const categories=row.categories.map(value=>skillText(value,'技能分类',80))
 if(new Set(categories).size!==categories.length)throw bad('技能分类不能重复。')
 if(!Array.isArray(row.files)||!row.files.length||row.files.length>500)throw bad('技能草案需要 1～500 个文件。')
 let total=0
 const files=row.files.map(value=>{
  const item=exact(value,['path','base64'],'技能文件格式不正确。'),path=skillPath(item.path),base64=skillBase64(item.base64)
  const padding=base64.endsWith('==')?2:base64.endsWith('=')?1:0,size=base64.length/4*3-padding
  total+=size
  return {path,base64}
 })
 if(new Set(files.map(file=>file.path)).size!==files.length)throw bad('技能文件路径重复。')
 if(total>20*1024*1024)throw bad('技能文件总大小超过 20 MiB。')
 const entries=files.filter(file=>file.path.split('/').at(-1)==='SKILL.md')
 if(entries.length!==1)throw bad('技能草案必须恰好包含一个 SKILL.md。')
 const root=entries[0]!.path.slice(0,entries[0]!.path.lastIndexOf('/')+1)
 if(!files.every(file=>file.path.startsWith(root)))throw bad('技能文件必须位于 SKILL.md 所在目录。')
 assertSkillEntryFrontmatter(id,entries[0]!.base64)
 return {id,title,version,categories,files}
}

export type PageCreateBodyReaders={manifest?:(value:unknown)=>unknown;skill?:(value:unknown)=>unknown}

/** 三份业务声明按 `format` 认领各自第一期的 `read*`；本文件一条判据都不新写。 */
const businessDeclaration=(value:unknown):unknown=>{
 const format=isRecord(value)?value.format:undefined
 if(format==='teloa.business-object-type/v1')return readBusinessObjectTypeDefinition(value)
 if(format==='teloa.business-view/v1')return readBusinessViewDefinition(value)
 if(format==='teloa.business-action/v1')return readBusinessActionDefinition(value)
 throw bad('业务声明草案正文的 format 必须是业务对象类型、业务视图或业务动作三者之一。')
}

const connectorResource=(value:unknown):unknown=>{
 const format=isRecord(value)?value.format:undefined
 if(format==='teloa.data-source/v1')return readIndustryDataSourceDefinition(value)
 if(format==='teloa.mcp-connection/v1')return readIndustryMcpConnectionDefinition(value)
 throw bad('连接草案正文的资源 format 必须是行业数据源或行业 MCP 连接。')
}

/**
 * 按 `entity` 分派到各自已经存在的校验函数，本文件一条判据都不新写；六个 `entity` 只有这唯一一处分派。
 * `entity` 与正文形状不符时由被分派到的那个 `read*` 抛 `teloa/invalid-input`，不在这里另判一遍。
 */
export function readPageCreateBody(entity:PageCreateEntity,value:unknown,readers:PageCreateBodyReaders={}):unknown{
 // 「角色」页内新建只对应AI 员工。分身是个人空间初始化的单例身份，
 // 不能让一句话草案先预览、再在真正落库时才被 roles/create 拒绝。
 if(entity==='role'){
  const role=roleWriteDefinition(value)
  if(role.kind==='twin')throw new WorkError('teloa/conflict','分身随个人空间默认提供，无需创建。')
  return role
 }
 // 扩展一支不生成任何正文：正文就是一条官方包引用（D6）。产品底座只用官方插件，
 // 白名单外的包一律拒绝——形状先过 `readMarketPluginRegistrySource`，再核对是否在白名单里，
 // 免得「形状对但没审过」的包悄悄建出草案。
 if(entity==='extension'){
  const source=readMarketPluginRegistrySource(value)
  if(!officialExtensionPackages.some(row=>row.packageName===source.packageName&&row.version===source.version))throw bad('没有匹配的官方扩展。')
  return source
 }
 if(entity==='business-definition')return businessDeclaration(value)
 if(entity==='skill'){
  const readSkill=readers.skill
  if(!readSkill)throw new WorkError('teloa/dependency-unavailable','原子技能判据在客户端，契约层不复制一份：请由调用方注入 skill 读取器。')
  return readSkill(value)
 }
 const readManifest=readers.manifest
 if(!readManifest)throw new WorkError('teloa/dependency-unavailable','v2 清单判据在客户端与后端，契约层不复制一份：请由调用方注入 manifest 读取器。')
 if(entity==='business-domain'){
  const row=exact(value,['manifest','definitions'],'新建业务的草案正文必须是一份 v2 清单加一组业务声明。')
  // 非空一条与清单自己的「行业资源集合不能为空」同一条理由：一个声明都没有的模板包落地也建不出业务。
  if(!Array.isArray(row.definitions)||!row.definitions.length)throw bad('新建业务的草案正文必须带至少一份业务声明。')
  return {manifest:readManifest(row.manifest),definitions:row.definitions.map(businessDeclaration)}
 }
 const row=exact(value,['manifest','resource'],'新建连接的草案正文必须是一份 v2 清单加一份资源定义。')
 // 凭据不入草案正文：连接器一支在既有 authorize/connect 那一步才输入凭据（规格 §五第 4 条）。
 assertNoCredentialKeys(row)
 return {manifest:readManifest(row.manifest),resource:connectorResource(row.resource)}
}
