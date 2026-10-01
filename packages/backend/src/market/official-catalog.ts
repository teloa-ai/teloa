import {createHash} from 'node:crypto'
import {WorkError,isRecord,marketSolutionResourceKinds,mcpConnectionReadOnly,readIndustryMcpConnectionDefinition,type MarketCatalogListContents,readMarketCatalogIndex,emptyMarketCatalogCounts,type MarketCatalogModelEntry,type MarketCatalogEntry,type MarketCatalogSkillEntry,type MarketCatalogSkillSecret,type MarketCatalogText,type MarketCatalogUpstreamSkillEntry,type MarketCatalogConnectorEntry,type MarketCatalogRoleEntry,type MarketCatalogIndex,type MarketCatalogListItem,type MarketCatalogListSecretGroup,type MarketCatalogListRequest,type MarketCatalogListResponse,type MarketCatalogListCounts} from '@teloa/contract'
import {atomicContentIdentity,industryContentIdentity,marketTrustHash,normalizeMarketSourceTrust,validateManifest,type MarketActor,type MarketContent,type MarketContentStore,type MarketContentReference,type MarketImportReceipt,type MarketSourceTrust} from './content-store.ts'
import {officialCatalogFiles,officialCatalogIndex,officialCatalogIndexSha256} from './official-catalog-snapshot.ts'
import {listUpstreamEntries,getUpstreamEntry,remoteIndexSkipped} from './official-upstream.ts'
import {downloadClawHubSkill} from './clawhub-source.ts'
import {downloadGithubCatalogSkill,type GithubHttpPort} from './github-source.ts'
import {marketCatalogUpstreamTreeHash} from '@teloa/contract'

/** 随发行固定的目录快照；测试可注入篡改后的快照核对拒绝路径。 */
export type OfficialCatalogSnapshot={indexSha256:string;index:unknown;files:Readonly<Record<string,string>>}
type CatalogStore=Pick<MarketContentStore,'import'|'findByIdentity'|'findByCatalogSources'>
/** 目录列表回显本人已建岗位：一页只按条目批量查一次，结果按条目 id 归组；未接线（测试、只读 MCP 装配）时 role 条目 addedRoleId 恒为 null。 */
type CatalogRoles={catalogRoleIds:(ownerId:string,entries:MarketCatalogRoleEntry[])=>Promise<ReadonlyMap<string,string>>}
type LoadedEntry={entry:MarketCatalogIndex['entries'][number];files:{path:string;bytes:Uint8Array}[]}
type Loaded={catalogVersion:string;entries:Map<string,LoadedEntry>}

const sha256=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex')
const upstreamTreeHash=(up:MarketCatalogUpstreamSkillEntry['upstream'])=>marketCatalogUpstreamTreeHash(up,sha256)
const corrupt=()=>new WorkError('teloa/storage-corrupt','官方目录快照完整性校验失败，目录已停用。')
const bad=(message:string)=>new WorkError('teloa/invalid-input',message)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)

/** 核对索引摘要、逐文件字节与工件树摘要；任何一处不一致都让整个目录不可用，不部分放行。 */
function load(snapshot:OfficialCatalogSnapshot):Loaded{
 if(sha256(JSON.stringify(snapshot.index))!==snapshot.indexSha256)throw corrupt()
 let index:MarketCatalogIndex
 try{index=readMarketCatalogIndex(snapshot.index,sha256)}catch{throw corrupt()}
 const entries=new Map<string,LoadedEntry>(),used=new Set<string>()
 for(const entry of index.entries){
  if(entry.artifact===null){entries.set(entry.id,{entry,files:[]});continue}
  const files=entry.artifact.files.map(file=>{
   const key=entry.id+'/'+entry.version+'/'+file.path,encoded=snapshot.files[key]
   if(typeof encoded!=='string')throw corrupt()
   const bytes=Uint8Array.from(Buffer.from(encoded,'base64'))
   if(Buffer.from(bytes).toString('base64')!==encoded||bytes.byteLength!==file.size||sha256(bytes)!==file.sha256)throw corrupt()
   used.add(key)
   return {path:file.path,bytes}
  })
  entries.set(entry.id,{entry,files})
 }
 if(Object.keys(snapshot.files).some(key=>!used.has(key)))throw corrupt()
 return {catalogVersion:index.catalogVersion,entries}
}

function publicEntry(entry:LoadedEntry['entry']):MarketCatalogEntry{
 const {artifact:_,...rest}=entry
 return structuredClone(rest)
}

/** 目录条目推出的信任声明；客户端不能提交 trust，宿主也不接受外部改写。 */
export function officialCatalogTrust(entry:MarketCatalogEntry):MarketSourceTrust{
 // 上游条目信任：来源为上游市场，非 Teloa 官方目录直接出品
 if(entry.kind==='skill'&&entry.delivery==='upstream'){
  const up=entry.upstream
  const repository=up.kind==='github'?{host:'github.com' as const,owner:up.repository.owner,repo:up.repository.repo}:null
  const source=up.kind==='github'?`GitHub ${up.repository.owner}/${up.repository.repo}`:`ClawHub ${up.owner}/${up.slug}`
  return {
   publisher:entry.origin.marketplace,repository,
   license:{status:'declared',value:entry.license.spdx},signature:{status:'unverified',signer:null},
   compatibility:{teloa:entry.compatibility.teloa,dsh:entry.compatibility.dsh},plugins:[],externalCapabilities:[],
   permissions:[...entry.requires.tools.map(id=>({id:'tool:'+id,description:'使用工具 '+id,required:true})),...(entry.requires.network?[{id:'network',description:'需要联网',required:true}]:[])],
   review:{conclusion:'approved',summary:`从 ${source} 机器固定收录（${entry.id}@${entry.version}）；来源 ${entry.origin.marketplace}，许可 ${entry.license.spdx}；Teloa 官方目录脚本核验摘要，未逐行审核。`},
  }
 }
 // 非上游条目（Teloa 官方出品 / builtin / install）：after the return above TypeScript narrows away MarketCatalogUpstreamSkillEntry
 const repository=entry.upstream===null?null:{host:'github.com' as const,owner:entry.upstream.repository.owner,repo:entry.upstream.repository.repo}
 const reviewSummary=entry.upstream===null
  ?'Teloa 官方目录收录（资源 '+entry.id+'@'+entry.version+'）；Teloa 官方方案，许可 '+entry.license.spdx+'；兼容状态 '+entry.compatibility.status
  :entry.kind==='skill'&&entry.derivation
   ?'Teloa 官方目录收录（资源 '+entry.id+'@'+entry.version+'）；二次开发自 '+entry.upstream.author+'，修改清单 '+entry.derivation.changes.length+' 项；许可 '+entry.license.spdx+'；兼容状态 '+entry.compatibility.status
   :'Teloa 官方目录收录（资源 '+entry.id+'@'+entry.version+'）；上游 '+entry.upstream.author+'，许可 '+entry.license.spdx+'；兼容状态 '+entry.compatibility.status
 return {
  publisher:'Teloa 官方目录',repository,
  license:{status:'declared',value:entry.license.spdx},signature:{status:'unverified',signer:null},
  compatibility:{teloa:entry.compatibility.teloa,dsh:entry.compatibility.dsh},plugins:[],externalCapabilities:[],
  permissions:[...entry.requires.tools.map(id=>({id:'tool:'+id,description:'使用工具 '+id,required:true})),...(entry.requires.network?[{id:'network',description:'需要联网',required:true}]:[])],
  review:{conclusion:'approved',summary:reviewSummary},
 }
}

// 技能条目导入输入（atomic-skill）
function importSkillInput(entry:MarketCatalogSkillEntry,files:LoadedEntry['files']){
 const title=entry.skill.title['zh-CN']
 return {
  metadata:{id:entry.skill.name,title,version:entry.version,categories:[...entry.taxonomy.functions],localized:{title:{original:title,defaultLocale:'en',locales:{'zh-CN':title,en:entry.skill.title.en}}}},
  trust:officialCatalogTrust(entry),
  files:files.map(file=>({path:entry.skill.name+'/'+file.path,bytes:Uint8Array.from(file.bytes)})),
 }
}

// 上游技能条目导入输入（atomic-skill），文件来自实时拉取
function importUpstreamSkillInput(entry:MarketCatalogUpstreamSkillEntry,files:{path:string;bytes:Uint8Array}[]){
 const title=entry.skill.title['zh-CN']
 return {
  metadata:{id:entry.skill.name,title,version:entry.version,categories:[...entry.taxonomy.functions],localized:{title:{original:title,defaultLocale:'en',locales:{'zh-CN':title,en:entry.skill.title.en}}}},
  trust:officialCatalogTrust(entry),
  files:files.map(file=>({path:entry.skill.name+'/'+file.path,bytes:Uint8Array.from(file.bytes)})),
 }
}

const defaultSnapshot=():OfficialCatalogSnapshot=>({indexSha256:officialCatalogIndexSha256,index:officialCatalogIndex,files:officialCatalogFiles})
function builtinOf(catalog:Loaded,name:string):{entry:MarketCatalogEntry;treeHash:string;files:{path:string;bytes:Uint8Array}[]}{
 const found=[...catalog.entries.values()].find(item=>item.entry.kind==='skill'&&item.entry.delivery==='builtin'&&item.entry.skill.name===name)
 if(!found||found.entry.artifact===null)throw new WorkError('teloa/source-unavailable','官方目录中没有这个内置技能。')
 return {entry:publicEntry(found.entry),treeHash:found.entry.artifact.treeHash,files:found.files.map(file=>({path:file.path,bytes:Uint8Array.from(file.bytes)}))}
}
/** 宿主启动时取内置条目字节，不需要内容仓；快照核验与目录服务同一套。 */
export function officialCatalogBuiltin(name:string,snapshot:OfficialCatalogSnapshot=defaultSnapshot()){return builtinOf(load(snapshot),name)}

/** 条目的可检索文本：id、名称 / 标题（zh-CN 与 en）、用途摘要与分类键；与来源（Teloa 快照或在线上游索引）无关。 */
function searchableText(entry:MarketCatalogEntry):string[]{
 const head=entry.kind==='skill'?[entry.skill.name,entry.skill.title['zh-CN'],entry.skill.title.en,entry.skill.summary['zh-CN'],entry.skill.summary.en]
  :entry.kind==='solution'?[entry.solution.packageId,entry.solution.title['zh-CN'],entry.solution.title.en,entry.solution.summary['zh-CN'],entry.solution.summary.en]
  :entry.kind==='dashboard'?[entry.dashboard.packageId,entry.dashboard.title['zh-CN'],entry.dashboard.title.en,entry.dashboard.summary['zh-CN'],entry.dashboard.summary.en]
  :entry.kind==='connector'?[entry.connector.serverName,entry.connector.title['zh-CN'],entry.connector.title.en,entry.connector.summary['zh-CN'],entry.connector.summary.en]
  :entry.kind==='role'?[entry.role.roleId,entry.role.title['zh-CN'],entry.role.title.en,entry.role.summary['zh-CN'],entry.role.summary.en]
  :[entry.model.modelId,entry.model.title['zh-CN'],entry.model.title.en,entry.model.summary['zh-CN'],entry.model.summary.en]
 return [entry.id,...head,...entry.taxonomy.functions,...entry.taxonomy.industries]
}
/** 目录列表过滤纯函数：query 小写包含、kind 精确匹配；上游分支与 Teloa 分支共用。 */
export function filterCatalogEntries<T extends MarketCatalogEntry>(entries:readonly T[],request:{query?:string;kind?:MarketCatalogEntry['kind']}):T[]{
 const query=(request.query??'').trim().toLowerCase()
 return entries.filter(entry=>(request.kind===undefined||entry.kind===request.kind)&&(!query||searchableText(entry).some(text=>text.toLowerCase().includes(query))))
}
const sortName=(entry:MarketCatalogEntry)=>entry.kind==='skill'?entry.skill.name:entry.kind==='solution'?entry.solution.title.en:entry.kind==='dashboard'?entry.dashboard.title.en:entry.kind==='connector'?entry.connector.serverName:entry.kind==='role'?entry.role.roleId:entry.model.modelId
const installsOf=(entry:MarketCatalogEntry)=>entry.kind==='skill'&&entry.delivery==='upstream'?entry.origin.installs??0:0
/** 目录列表排序纯函数：installs 降序（Teloa 条目视为 0）再按 id 升序；name 按技能名 / 方案英文标题 / 连接器服务名。 */
export function sortCatalogEntries<T extends MarketCatalogEntry>(entries:readonly T[],sort:'installs'|'name'):T[]{
 const byId=(a:T,b:T)=>a.id<b.id?-1:a.id>b.id?1:0
 if(sort==='name')return [...entries].sort((a,b)=>{const left=sortName(a),right=sortName(b);return left<right?-1:left>right?1:byId(a,b)})
 return [...entries].sort((a,b)=>installsOf(b)-installsOf(a)||byId(a,b))
}
/** 过滤前对全量条目一次算出五类计数；为 0 的类型两端都不渲染。 */
export function countCatalogEntries(entries:readonly MarketCatalogEntry[]):MarketCatalogListCounts{
 const counts=emptyMarketCatalogCounts()
 for(const entry of entries)counts[entry.kind]+=1
 return counts
}
/** 读方案包里的 JSON 文件（字节已随快照核验）；缺文件或解析不了按快照损坏处理。 */
function packageJson(found:LoadedEntry,path:string):unknown{
 const file=found.files.find(item=>item.path===path)
 if(!file)throw corrupt()
 try{return JSON.parse(new TextDecoder().decode(file.bytes))}catch{throw corrupt()}
}
type SolutionManifest={manifest:unknown;resources:ReturnType<typeof validateManifest>['resources']}
/** 方案包清单原文与复核后的资源表；产品页七行与列表「包含」计数读同一份。 */
function solutionManifest(found:LoadedEntry):SolutionManifest{
 const manifest=packageJson(found,'teloa.json')
 try{
  const parsed=validateManifest(manifest),metadata=found.entry.kind==='solution'?found.entry.solution:found.entry.kind==='dashboard'?found.entry.dashboard:undefined
  if(!metadata||parsed.id!==metadata.packageId||parsed.version!==found.entry.version||parsed.scope!==metadata.scope)throw corrupt()
  industryContentIdentity({manifestPath:'teloa.json',files:found.files,sourceLabel:'Teloa 官方目录 '+found.entry.id,trust:officialCatalogTrust(found.entry)})
  return {manifest,resources:parsed.resources}
 }catch{throw corrupt()}
}
/** 派生来源固定请求，重复添加方案不重复产生依赖导入回执。 */
const referenceRequestId=(requestId:string,entryId:string,version:string):string=>{
 const hex=sha256(JSON.stringify(['catalog-reference',requestId.toLowerCase(),entryId,version]))
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-8${hex.slice(17,20)}-${hex.slice(20,32)}`
}
/** 列表可选字段 contents：方案包内各类资源数量，只列大于 0 的类型。 */
function solutionContents({resources}:SolutionManifest):MarketCatalogListContents{
 const contents:MarketCatalogListContents={}
 for(const kind of marketSolutionResourceKinds){const count=resources.filter(resource=>resource.kind===kind).length;if(count)contents[kind]=count}
 return contents
}

export class OfficialCatalogService{
 private readonly store:CatalogStore
 private readonly loaded:Loaded|WorkError
 private readonly roles:CatalogRoles|undefined
 private readonly githubHttp:GithubHttpPort|undefined
 /** 方案包解析与复核结果按 entryId@version 缓存（快照随发行固定，同一版本内容不变）；复核失败也缓存，不反复解析。 */
 private readonly solutions=new Map<string,SolutionManifest|WorkError>()
 constructor(store:CatalogStore,snapshot:OfficialCatalogSnapshot=defaultSnapshot(),roles?:CatalogRoles,githubHttp?:GithubHttpPort){
  this.store=store;this.roles=roles;this.githubHttp=githubHttp
  try{this.loaded=load(snapshot)}catch(error){this.loaded=error instanceof WorkError?error:corrupt()}
 }
 private catalog():Loaded{if(this.loaded instanceof WorkError)throw this.loaded;return this.loaded}
 async list(actor:MarketActor,request?:MarketCatalogListRequest):Promise<MarketCatalogListResponse>{
  const catalog=this.catalog()
  const mp=request?.marketplace
  // 上游条目（带来源筛选）
  if(mp&&mp!=='teloa'){
   const all=listUpstreamEntries().filter(e=>e.origin.marketplace===mp)
   const sorted=sortCatalogEntries(filterCatalogEntries(all,{...(request?.query===undefined?{}:{query:request.query}),...(request?.kind===undefined?{}:{kind:request.kind})}),request?.sort??'installs')
   const limit=Math.min(request?.limit??50,50)
   let cursorIdx=0
   if(request?.cursor){
    const idx=sorted.findIndex(e=>e.id===request.cursor)
    if(idx<0)throw bad('分页游标无效。')
    cursorIdx=idx+1
   }
   const page=sorted.slice(cursorIdx,cursorIdx+limit)
   const nextCursor=cursorIdx+limit<sorted.length?page.at(-1)?.id??null:null
   const sources=page.map(e=>({entryId:e.id,entryVersion:e.version,treeHash:upstreamTreeHash(e.upstream),logicalId:e.skill.name,trustHash:marketTrustHash(normalizeMarketSourceTrust(officialCatalogTrust(e)))}))
   // 组成员在 await 之前取：在线索引可能在查询内容仓期间整份替换，之后重读会与本页条目不同源
   const groupOf=this.secretGroupsForList()
   const added=sources.length?await this.store.findByCatalogSources(actor,sources):new Map<string,string>()
   const items:MarketCatalogListItem[]=page.map(e=>({entry:structuredClone(e),artifact:null,addedContentId:added.get(e.id)??null,addedRoleId:null,secretGroup:groupOf(e)}))
   return {catalogVersion:catalog.catalogVersion,items,nextCursor,counts:countCatalogEntries(all),skipped:remoteIndexSkipped()}
  }
  // Teloa 官方条目（向后兼容：不传 marketplace 或 marketplace='teloa'）；过滤排序后再分页
  const everything=[...catalog.entries.values()].map(({entry})=>entry)
  const allEntries=sortCatalogEntries(filterCatalogEntries(everything,{...(request?.query===undefined?{}:{query:request.query}),...(request?.kind===undefined?{}:{kind:request.kind})}),request?.sort??'installs').map(entry=>catalog.entries.get(entry.id)!)
  const teloaLimit=Math.min(request?.limit??50,50)
  let teloaCursorIdx=0
  if(request?.cursor){
   const idx=allEntries.findIndex(({entry:e})=>e.id===request.cursor)
   if(idx<0)throw bad('分页游标无效。')
   teloaCursorIdx=idx+1
  }
  const teloaPage=allEntries.slice(teloaCursorIdx,teloaCursorIdx+teloaLimit)
  const teloaNextCursor=teloaCursorIdx+teloaLimit<allEntries.length?teloaPage.at(-1)?.entry.id??null:null
  const items:MarketCatalogListItem[]=[]
  const pageRoles=teloaPage.flatMap(({entry})=>entry.kind==='role'?[entry]:[])
  const roleIds=this.roles&&pageRoles.length?await this.roles.catalogRoleIds(actor.ownerId,pageRoles):new Map<string,string>()
  const groupOf=this.secretGroupsForList()
  for(const {entry,files} of teloaPage){
   let addedContentId:string|null=null
   if(entry.delivery==='install'&&(entry.kind==='skill'||entry.kind==='solution'||entry.kind==='dashboard')){
    const label='Teloa 官方目录 '+entry.id
    let identity
    if(entry.kind==='skill'){
     const input=importSkillInput(entry,files)
     identity=atomicContentIdentity({...input,sourceLabel:label})
    }else{
     // 单个方案包复核不过时这一条按未添加列出（也不带包含计数），不让整页列表失败；添加与产品页读取仍会明确拒绝
     try{
      const references=this.referenceSources({entry,files}).map(({resource,identity})=>({resourceId:resource.id,sourceContentId:'00000000-0000-4000-8000-000000000000',sourceItemId:(resource.kind==='skill'?'atomic-':'directory-')+identity.contentHash,sourceResourceId:resource.source.kind==='public'?resource.source.id:'',sourceHash:identity.contentHash}))
      identity=industryContentIdentity({manifestPath:'teloa.json',trust:officialCatalogTrust(entry),files:files.map(f=>({path:f.path,bytes:f.bytes})),sourceLabel:label,references})
     }catch{identity=undefined}
    }
    addedContentId=identity?await this.store.findByIdentity(actor,identity):null
   }
   const addedRoleId=entry.kind==='role'?roleIds.get(entry.id)??null:null
   items.push({entry:publicEntry(entry),artifact:entry.artifact===null?null:structuredClone(entry.artifact),addedContentId,addedRoleId,secretGroup:groupOf(entry),...(entry.kind==='solution'?this.listContents({entry,files}):{})})
  }
  return {catalogVersion:catalog.catalogVersion,items,nextCursor:teloaNextCursor,counts:countCatalogEntries(everything),skipped:remoteIndexSkipped()}
 }
 async add(actor:MarketActor,input:unknown):Promise<{receipt:MarketImportReceipt;content:MarketContent}>{
  if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId||actor.kind!=='human')throw new WorkError('teloa/forbidden','当前主体无权添加官方目录资源。')
  if(!isRecord(input)||Object.keys(input).some(key=>!['requestId','entryId','expectedTreeHash'].includes(key))||!uuid(input.requestId)||typeof input.entryId!=='string'||input.expectedTreeHash!==undefined&&(typeof input.expectedTreeHash!=='string'||!/^[0-9a-f]{64}$/.test(input.expectedTreeHash)))throw bad('官方目录添加请求格式不正确或包含未知字段。')
  // 会话内添加把预览时的指纹带回来；条目在预览后更新则拒绝，让本人重新预览
  const expectTree=(treeHash:string)=>{if(input.expectedTreeHash!==undefined&&input.expectedTreeHash!==treeHash)throw new WorkError('teloa/version-conflict','资源已更新，请重新预览后再添加。')}
  // 先查上游条目
  const upstreamEntry=getUpstreamEntry(input.entryId)
  if(upstreamEntry){
   if(upstreamEntry.compatibility.status==='unsupported')throw bad('该资源暂不支持在 Teloa 中添加。')
   const up=upstreamEntry.upstream
   // 指纹核对在下载前完成；GitHub 与 ClawHub 都保留目录身份，进入同一内容导入。
   const treeHash=upstreamTreeHash(up)
   expectTree(treeHash)
   const catalog=this.catalog()
   if(up.kind==='github'&&!this.githubHttp)throw new WorkError('teloa/dependency-unavailable','GitHub 来源读取尚未接通。')
   const files=up.kind==='clawhub'?await downloadClawHubSkill(up):await downloadGithubCatalogSkill(up,this.githubHttp!)
   const source={kind:'catalog' as const,catalog:'teloa-official' as const,catalogVersion:catalog.catalogVersion,entryId:upstreamEntry.id,entryVersion:upstreamEntry.version,treeHash}
   const value=importUpstreamSkillInput(upstreamEntry,files)
   return this.store.import(actor,{kind:'atomic-skill',requestId:input.requestId.toLowerCase(),source,...value})
  }
  // 再查 Teloa 官方快照条目
  const catalog=this.catalog(),found=catalog.entries.get(input.entryId)
  if(!found)throw bad('官方目录中没有这个资源。')
  if(found.entry.delivery==='builtin')throw bad('内置资源无需添加，新建时会自动使用。')
  if(found.entry.compatibility.status==='unsupported')throw bad('该资源暂不支持在 Teloa 中添加。')
  if(found.entry.kind==='connector')throw bad('连接不能添加为内容，请用 teloa_mcp_connect 或 市场 > 连接 添加。')
  if(found.entry.kind==='role')throw bad('AI 员工资源请以 kind:"role" 添加（market-catalog/add），将直接创建员工。')
  if(found.entry.kind==='model')throw bad(found.entry.model.form!=='local-specialist'?'模型无需添加，请到 设置 · 模型 配置。':(found.entry.model.usage as readonly string[]).includes('embedding')?'本地检索模型由 Teloa 本地中文检索扩展准备，请从市场模型详情进入「准备本地检索」。':'本地语音由原生扩展准备，请从市场模型详情进入设置。')
  expectTree(found.entry.artifact.treeHash)
  const source={kind:'catalog' as const,catalog:'teloa-official' as const,catalogVersion:catalog.catalogVersion,entryId:found.entry.id,entryVersion:found.entry.version,treeHash:found.entry.artifact.treeHash}
  if(found.entry.kind==='skill'){
   const value=importSkillInput(found.entry,found.files)
   return this.store.import(actor,{kind:'atomic-skill',requestId:input.requestId.toLowerCase(),source,...value})
  }
  // 所有引用先从同一固定目录核对完毕，再保存来源；不使用客户端提交的字节或解析结果。
  const references:MarketContentReference[]=[]
  for(const {resource,found:dependency} of this.referenceSources(found)){
   const entry=dependency.entry
   if(entry.artifact===null)throw corrupt()
   const fixedSource={kind:'catalog' as const,catalog:'teloa-official' as const,catalogVersion:catalog.catalogVersion,entryId:entry.id,entryVersion:entry.version,treeHash:entry.artifact.treeHash}
   const requestId=referenceRequestId(input.requestId,entry.id,entry.version)
   const added=entry.kind==='skill'
    ?await this.store.import(actor,{kind:'atomic-skill',requestId,source:fixedSource,...importSkillInput(entry,dependency.files)})
    :await this.store.import(actor,{kind:'industry-template',requestId,source:fixedSource,manifestPath:'teloa.json',trust:officialCatalogTrust(entry),files:dependency.files.map(f=>({path:f.path,bytes:Uint8Array.from(f.bytes)})),references:[]})
   references.push({resourceId:resource.id,sourceContentId:added.content.id,sourceItemId:(resource.kind==='skill'?'atomic-':'directory-')+added.content.hash,sourceResourceId:resource.source.kind==='public'?resource.source.id:'',sourceHash:added.content.hash})
  }
  return this.store.import(actor,{kind:'industry-template',requestId:input.requestId.toLowerCase(),source,manifestPath:'teloa.json',trust:officialCatalogTrust(found.entry),files:found.files.map(f=>({path:f.path,bytes:Uint8Array.from(f.bytes)})),references})
 }
 private referenceSources(found:LoadedEntry):{resource:SolutionManifest['resources'][number];found:LoadedEntry;identity:ReturnType<typeof industryContentIdentity>}[]{
  const {resources}=this.solutionOf(found),scope=validateManifest(packageJson(found,'teloa.json')).scope
  return resources.filter(resource=>resource.source.kind==='public').map(resource=>{
   const source=resource.source
   if(source.kind!=='public'||!['skill','business-configuration'].includes(resource.kind))throw new WorkError('teloa/source-unavailable','官方方案公共引用的资源类型尚不支持。')
   const candidates=[...this.catalog().entries.values()].filter(candidate=>{
    const entry=candidate.entry
    if(entry.compatibility.status==='unsupported'||entry.version!==resource.version)return false
    if(resource.kind==='skill')return entry.kind==='skill'&&entry.skill.name===source.id
    if(entry.kind!=='dashboard')return false
    const packageSource=this.solutionOf(candidate),manifest=validateManifest(packageSource.manifest)
    // 配置来源不得再引用另一个包；本地资源闭合后才可供方案引用。
    return (manifest.scope==='template'||manifest.scope===scope)&&!manifest.resources.some(row=>row.source.kind==='public')&&packageSource.resources.some(row=>row.id===source.id&&row.kind===resource.kind&&row.version===resource.version&&row.source.kind==='local')
   })
   if(candidates.length!==1)throw new WorkError('teloa/source-unavailable','官方方案的公共资源未找到唯一、可读取的固定来源。')
   const dependency=candidates[0]!,entry=dependency.entry,label='Teloa 官方目录 '+entry.id
   const identity=entry.kind==='skill'?atomicContentIdentity({...importSkillInput(entry,dependency.files),sourceLabel:label}):industryContentIdentity({manifestPath:'teloa.json',files:dependency.files,trust:officialCatalogTrust(entry),sourceLabel:label})
   return {resource,found:dependency,identity}
  })
 }
 /** 内置条目的文件字节，供宿主物化内置技能；不经过内容仓。 */
 builtin(name:string):{entry:MarketCatalogEntry;treeHash:string;files:{path:string;bytes:Uint8Array}[]}{return builtinOf(this.catalog(),name)}
 /** 目录中是否有这个条目（任意类型，含已采用的上游索引条目，与 list/add 同源）；目录损坏时一律为 false。供安装量榜单剔除已下架或不存在的条目。 */
 hasEntry(id:string):boolean{return !(this.loaded instanceof WorkError)&&(this.loaded.entries.has(id)||getUpstreamEntry(id)!==undefined)}
 /** 按 catalogId 查询连接器条目；目录损坏或条目不存在时返回 undefined。 */
 getConnectorEntry(id:string):MarketCatalogConnectorEntry|undefined{
  if(this.loaded instanceof WorkError)return undefined
  const found=this.loaded.entries.get(id)
  if(!found||found.entry.kind!=='connector')return undefined
  return publicEntry(found.entry) as MarketCatalogConnectorEntry
 }
 /** 本机模型条目（kind:'model' 且 form:'local-general'），供宿主 local-models/*；目录损坏时为空。 */
 listLocalModelEntries():MarketCatalogModelEntry[]{
  if(this.loaded instanceof WorkError)return []
  return [...this.loaded.entries.values()].flatMap(({entry})=>entry.kind==='model'&&entry.model.form==='local-general'?[publicEntry(entry) as MarketCatalogModelEntry]:[])
 }
 /** stdio 连接器工件随附的 package-lock.json（已随快照逐字节核对）；非 stdio 连接器、条目不存在或目录损坏时返回 undefined。与配方的一致性由安装方核对。 */
 getConnectorPackageLock(id:string):unknown{
  if(this.loaded instanceof WorkError)return undefined
  const found=this.loaded.entries.get(id)
  if(!found||found.entry.kind!=='connector'||found.entry.connector.recipe.transport!=='stdio')return undefined
  const file=found.files.find(item=>item.path==='package-lock.json')
  return file&&JSON.parse(new TextDecoder().decode(file.bytes))
 }
 /** 按 catalogId 查询 AI 员工条目；目录损坏或条目不存在时返回 undefined。 */
 getRoleEntry(id:string):MarketCatalogRoleEntry|undefined{
  if(this.loaded instanceof WorkError)return undefined
  const found=this.loaded.entries.get(id)
  if(!found||found.entry.kind!=='role')return undefined
  return publicEntry(found.entry) as MarketCatalogRoleEntry
 }
 /** 目录全部技能条目：签名快照 + 上游缓存（clawhub.* 只在后者）；快照或上游任一损坏时仍返回另一部分。 */
 private skillEntries():(MarketCatalogSkillEntry|MarketCatalogUpstreamSkillEntry)[]{
  const local=this.loaded instanceof WorkError?[]:[...this.loaded.entries.values()].map(({entry})=>entry).filter((entry):entry is MarketCatalogSkillEntry&LoadedEntry['entry']=>entry.kind==='skill')
  // 密钥声明、同名条目查询按条目降级：上游索引不可读时只用快照部分（上游来源列表本身另行报错）
  let upstream:MarketCatalogUpstreamSkillEntry[]=[]
  try{upstream=listUpstreamEntries()}catch{}
  return [...local,...upstream]
 }
 /** 按条目 id 取目录声明的密钥（确认卡、代发、密钥页、加载提示的唯一来源）；非技能条目、条目不存在或未声明返回空数组。不按技能名取首个同名条目。 */
 getSkillSecretsByEntry(entryId:string):MarketCatalogSkillSecret[]{
  const entry=this.skillEntries().find(item=>item.id===entryId)
  return structuredClone(entry?.secrets??[])
 }
 /** 按条目 id 取代发调用指引与共享密钥组（规格 2026-09-27 §4.1、§4.5）；未声明的键省略，条目不存在回空对象。 */
 getSkillSecretMetaByEntry(entryId:string):{httpGuide?:MarketCatalogText;secretGroup?:string}{
  const entry=this.skillEntries().find(item=>item.id===entryId)
  return {...(entry?.httpGuide?{httpGuide:structuredClone(entry.httpGuide)}:{}),...(entry?.secretGroup?{secretGroup:entry.secretGroup}:{})}
 }
 /** 目录内同组的全部技能条目（快照 + 上游，不按安装过滤），按技能名、再按条目 id 排序；组指纹与一致性复核的唯一来源。 */
 skillSecretGroupMembers(group:string):{entryId:string;skill:string;secrets:MarketCatalogSkillSecret[];httpGuide?:MarketCatalogText}[]{
  return this.skillEntries().filter(entry=>entry.secretGroup===group&&entry.secrets!==undefined)
   .map(entry=>({entryId:entry.id,skill:entry.skill.name,secrets:structuredClone(entry.secrets!),...(entry.httpGuide?{httpGuide:structuredClone(entry.httpGuide)}:{})}))
   .sort((a,b)=>a.skill<b.skill?-1:a.skill>b.skill?1:a.entryId<b.entryId?-1:1)
 }
 /**
  * 列表回包的共享密钥组（规格 2026-09-28 D18）：一次列表只取一遍目录技能条目，按组收集成员（含自身、按 entryId 升序），
  * 成员集合与 skillSecretGroupMembers 同源同筛选；非技能或未分组条目为 null。上游缓存不可读时只用快照部分（skillEntries 降级）。
  */
 private secretGroupsForList():(entry:MarketCatalogEntry)=>MarketCatalogListSecretGroup|null{
  // 调用时立即取一遍目录（不延迟到首个条目），同一页条目共用这一份
  const groups=new Map<string,MarketCatalogListSecretGroup['members']>()
  for(const item of this.skillEntries()){
   if(item.secretGroup===undefined||item.secrets===undefined)continue
   const members=groups.get(item.secretGroup)??[]
   if(!members.some(member=>member.entryId===item.id))members.push({entryId:item.id,title:structuredClone(item.skill.title)})
   groups.set(item.secretGroup,members)
  }
  return entry=>{
   if(entry.kind!=='skill'||entry.secretGroup===undefined)return null
   const members=[...(groups.get(entry.secretGroup)??[])]
   // 兜底：目录与本页条目不同源时成员可能缺自身，读取器要求含自身，缺了整页列表会被拒收
   if(!members.some(member=>member.entryId===entry.id))members.push({entryId:entry.id,title:entry.skill.title})
   members.sort((a,b)=>a.entryId<b.entryId?-1:a.entryId>b.entryId?1:0)
   return {id:entry.secretGroup,members:structuredClone(members)}
  }
 }
 /** 同名技能的全部目录条目 id（快照 + 上游，去重）；多于一个时调用方须按当前安装绑定的条目 id 取声明。 */
 skillEntryIdsByName(name:string):string[]{
  return [...new Set(this.skillEntries().filter(entry=>entry.skill.name===name).map(entry=>entry.id))]
 }
 /**
  * 官方方案产品页「添加后你会得到」的数据：方案包清单 teloa.json 原文（随快照逐字节核对过），界面据此按七行分类法算出员工、技能、资料、接入源、看板、任务模板与扩展，
  * 目录条目不另存一份。接入源的读写按包内连接声明逐个工具对照官方连接器目录的 readOnly：全部只读才列入 readOnlyResources，查不到或有写工具的仍按保守口径算写。
  */
 solutionPackage(entryId:string):{entryId:string;version:string;manifest:unknown;readOnlyResources:string[]}{
  const catalog=this.catalog(),found=catalog.entries.get(entryId)
  if(!found||(found.entry.kind!=='solution'&&found.entry.kind!=='dashboard'))throw bad('官方目录中没有这个方案或看板。')
  const {manifest,resources}=this.solutionOf(found)
  const connectors=[...catalog.entries.values()].flatMap(({entry})=>entry.kind==='connector'?[entry]:[])
  const readOnlyResources=resources.filter(resource=>{
   if(resource.kind!=='mcp'||resource.source.kind!=='local')return false
   let definition:ReturnType<typeof readIndustryMcpConnectionDefinition>
   try{definition=readIndustryMcpConnectionDefinition(packageJson(found,resource.source.path))}catch{throw corrupt()}
   return mcpConnectionReadOnly(definition,connectors)
  }).map(resource=>resource.id)
  return {entryId:found.entry.id,version:found.entry.version,manifest,readOnlyResources}
 }
 private solutionOf(found:LoadedEntry):SolutionManifest{
  const key=found.entry.id+'@'+found.entry.version
  let cached=this.solutions.get(key)
  if(!cached){try{cached=solutionManifest(found)}catch(error){cached=error instanceof WorkError?error:corrupt()}this.solutions.set(key,cached)}
  if(cached instanceof WorkError)throw cached
  return cached
 }
 /** 列表里的包含计数：单个方案包复核失败时这一条不带 contents，不让整页列表失败。 */
 private listContents(found:LoadedEntry):{contents?:MarketCatalogListContents}{
  try{const contents=solutionContents(this.solutionOf(found));return Object.keys(contents).length?{contents}:{}}catch{return {}}
 }
 /** 建岗前取条目：与 add() 同一套拒绝（未知条目、unsupported）。 */
 roleEntryForAdd(id:string):MarketCatalogRoleEntry{
  const entry=this.catalog().entries.get(id)?.entry
  if(!entry||entry.kind!=='role')throw new WorkError('teloa/source-unavailable','官方目录中没有这个 AI 员工资源。')
  if(entry.compatibility.status==='unsupported')throw bad('该资源暂不支持在 Teloa 中添加。')
  return publicEntry(entry) as MarketCatalogRoleEntry
 }
}

/** 固定发行目录中的模型元数据；依赖解析不触发内容导入、下载或配置写入。 */
let modelCatalog:Loaded|undefined
export function officialCatalogModelEntry(id:string):MarketCatalogModelEntry|undefined{
 modelCatalog??=load(defaultSnapshot())
 const entry=modelCatalog.entries.get(id)?.entry
 return entry?.kind==='model'?publicEntry(entry) as MarketCatalogModelEntry:undefined
}
