import {marketFunctionKeys,type ConnectorAuth,type MarketCatalogCompatibility,type MarketCatalogConnectorEntry,type MarketCatalogSkillEntry,type MarketCatalogUnsupportedComponent,type MarketCatalogUpstreamSkillEntry,type MarketFunctionKey} from '@teloa/contract'
import {catalogText,type MarketCatalogItem,type MarketCatalogRanking} from './market-catalog-api.js'
import type {ManagedMcpConnectionRecord} from './mcp-connections-api.js'
import type {SkillInstallationRecord} from './skill-install-api.js'
import type {IndustryManifest} from './industry-manifest.js'
import type {IndustryLoadRecord} from './industry-load-api.js'
import {localizedIndustryResourceTitle} from './industry-template-presentation.js'

/**
 * 「连接应用」目录的呈现模型：只从官方目录条目、真实连接记录、技能安装记录与已声明的资源包推导，
 * 不改任何资源、版本、安装身份或权限语义，也不按显示名称合并。
 * - 每个目录连接器是一个应用；连接器不声明技能，故应用详情的技能为空。
 * - 技能只在同一上游仓库、同一固定提交时归为一个技能库（真实同源），否则各自成行。
 * - 目录条目声明了同一插件分组（plugin：公开 pluginId、原仓、提交与插件根一致，契约已整体核对）的技能呈现为一个应用包，可一次安装；不按名称或路径猜分组。
 * - 资源包只来自同时声明 skill 与 mcp、且不含岗位的真实包；包内连接按声明列出，不与目录应用合并。
 * - 目录里的应用一律由 Teloa 官方目录提供（publisher），原始仓库保留在 source（详情按需展开），不改写为 Teloa 原创；本人自建与本机安装的技能按原归属显示。
 */
export type AppsConnections={status:'loading'}|{status:'ready';records:readonly ManagedMcpConnectionRecord[]}|{status:'unavailable'}
export type AppsInstallState='not-added'|'added'|'installing'|'install-failed'|'unknown'
export type AppsConnectionState='not-connected'|'pending-oauth'|'connected'|'error'|'unknown'
export type AppsConnectorState={install:AppsInstallState;connection:AppsConnectionState}
export type AppsAuthRequirement='none'|'secret'|'oauth'|'allowlist'|'unsupported'
/** `added`：目录内容已添加（原目录 add 回执），与连接记录分开；已添加未建连接时直接进入连接设置，不重复添加。 */
export type AppsConnector={title:string;catalogId?:string;entry?:MarketCatalogConnectorEntry;added?:boolean;auth?:AppsAuthRequirement;tools:{name:string;description:string;readOnly:boolean}[];state?:AppsConnectorState&{record?:ManagedMcpConnectionRecord}}
export type AppsSkill={title:string;summary:string;entryId?:string;item?:MarketCatalogItem;added:boolean;installed:boolean;builtin:boolean}
export type AppsRowKind='app'|'library'|'skill'|'bundle'|'installed-skill'
/** 应用包成员：所选来源（条目与版本）与本人已添加的内容；installed 只按真实安装记录判断。 */
export type AppsPackMember={entryId:string;entry:MarketCatalogUpstreamSkillEntry;contentId:string|null;installed:boolean;supported:boolean}
/** installable：宿主提供完整安装端口且仍有可安装成员时才为 true。 */
export type AppsPack={pluginId:string;members:AppsPackMember[];unsupported:MarketCatalogUnsupportedComponent[];installable:boolean}
export type AppsRow={
 key:string
 kind:AppsRowKind
 title:string
 summary:string
 categories:MarketFunctionKey[]
 connectors:AppsConnector[]
 skills:AppsSkill[]
 entryIds:string[]
 source?:{label:string;url?:string}
 publisher?:string
 version?:string
 license?:string
 reviewedAt?:string
 compatibility?:{status:MarketCatalogCompatibility;conditions:string[]}
 packageId?:string
 installationId?:string
 nativeName?:string
 contentId?:string
 savedState?:'saved'|'saved-pending-install'|'installing'
 pack?:AppsPack
 mine:boolean
}
export type AppsDeclaredPackage={id:string;manifest:IndustryManifest;source?:{contentId:string;contentHash:string}}
export type AppsStoredContent={itemId:string;contentId:string;contentHash:string;kind:'skill'|'bundle';title:string;summary:string;version:string;publisher:string}
/** 目录视图状态：搜索、用途、我的与打开中的详情；宿主保存它即可在连接页或内容页返回后恢复原上下文。 */
export type AppsView={query:string;category:MarketFunctionKey|'all';mine:boolean;detail?:string}
export type AppsSection={id:'recommended'|'results'|'mine'|MarketFunctionKey;rows:AppsRow[];more:boolean}

const connectionRank:Record<ManagedMcpConnectionRecord['status'],number>={connected:5,'pending-oauth':4,installing:3,saved:2,error:1}

/** 安装与连接分开：安装看依赖与配置是否落地，连接看账号是否可用；读不到记录时两者都是未知。 */
export function connectorState(catalogId:string,connections:AppsConnections):AppsConnectorState&{record?:ManagedMcpConnectionRecord}{
 if(connections.status!=='ready')return {install:'unknown',connection:'unknown'}
 const record=[...connections.records].filter(row=>row.catalogId===catalogId).sort((a,b)=>connectionRank[b.status]-connectionRank[a.status])[0]
 if(!record)return {install:'not-added',connection:'not-connected'}
 if(record.status==='installing')return {install:'installing',connection:'not-connected',record}
 if(record.status==='error')return record.errorCode?{install:'install-failed',connection:'not-connected',record}:{install:'added',connection:'error',record}
 return {install:'added',connection:record.status==='saved'?'not-connected':record.status,record}
}

export function authRequirement(auth:ConnectorAuth):AppsAuthRequirement{
 if(auth.kind==='none')return 'none'
 if(auth.kind==='secret')return 'secret'
 if(!auth.supported)return 'unsupported'
 return auth.requiresAllowlist&&!auth.requiresUserClientId?'allowlist':'oauth'
}

const functions=(values:readonly string[]):MarketFunctionKey[]=>marketFunctionKeys.filter(key=>values.includes(key))
function sourceOf(url:string):{label:string;url:string}|undefined{
 try{const parsed=new URL(url);if(parsed.protocol!=='https:')return undefined;return {label:(parsed.host+parsed.pathname).replace(/\/$/,''),url:parsed.href}}catch{return undefined}
}
type SkillEntry=MarketCatalogSkillEntry|MarketCatalogUpstreamSkillEntry
/**
 * 同一个包的键：上游仓库、固定提交与目录三者都相同（例如一个插件目录里的多项技能）。同仓库的不同目录是各自独立的技能，
 * 不因来自同一合集仓库而合并；ClawHub 每个条目即一个发布项，没有上游的内置技能不归组。
 */
function skillOrigin(entry:SkillEntry):{key:string;name:string;label:string;url?:string}|undefined{
 const leaf=(path:string)=>path.split('/').filter(Boolean).at(-1)??path
 if(entry.delivery==='upstream'){
  const upstream=entry.upstream
  if(upstream.kind==='github')return {key:['github',upstream.repository.owner,upstream.repository.repo,upstream.commit,upstream.path].join('\n'),name:leaf(upstream.path),label:upstream.repository.owner+'/'+upstream.repository.repo,url:'https://github.com/'+upstream.repository.owner+'/'+upstream.repository.repo}
  return {key:['clawhub',upstream.owner,upstream.slug,upstream.version].join('\n'),name:upstream.slug,label:upstream.owner}
 }
 if(!entry.upstream)return undefined
 const {repository,commit,path}=entry.upstream
 return {key:['github',repository.owner,repository.repo,commit,path].join('\n'),name:leaf(path),label:repository.owner+'/'+repository.repo,url:'https://github.com/'+repository.owner+'/'+repository.repo}
}

/**
 * 同一原技能的重复安装记录只显示一条：原生名、正文哈希与来源资源版本都相同才算同一技能，取最近更新的记录作为打开目标；
 * 不同正文或版本的同名技能各自保留。只影响呈现，不改安装记录。
 */
export function foldInstalledSkillRecords(records:readonly SkillInstallationRecord[]):SkillInstallationRecord[]{
 const folded=new Map<string,SkillInstallationRecord>()
 for(const record of records){
  const key=[record.native.name,record.native.bodyHash,record.source.resourceId,record.source.resourceVersion].join('\n'),current=folded.get(key)
  if(!current||record.updatedAt>current.updatedAt||record.updatedAt===current.updatedAt&&record.version>current.version)folded.set(key,record)
 }
 return [...folded.values()]
}

/** 显示名只取本安装的固定包与加载映射；原生名仍用于调用和分享，不以同名资源补来源。 */
function installedSkillTitle(record:SkillInstallationRecord,packages:readonly AppsDeclaredPackage[],loads:readonly IndustryLoadRecord[],locale:string):string{
 const source=record.source
 if(source.kind==='atomic')return record.native.name
 const load=loads.find(row=>row.id===source.loadId&&row.ownerId===record.ownerId&&row.contentId===source.contentId&&row.contentHash===source.contentHash)
 const mapped=load?.items.find(row=>row.instanceId===source.itemInstanceId&&row.kind==='skill'&&row.localId===source.resourceId&&row.version===source.resourceVersion)
 const matches=packages.filter(row=>row.source?.contentId===source.contentId&&row.source.contentHash===source.contentHash)
 if(!load||!mapped||matches.length!==1)return record.native.name
 const manifest=matches[0]!.manifest
 if(manifest.id!==load.templateId||manifest.version!==load.templateVersion)return record.native.name
 const resource=manifest.resources.find(row=>row.id===source.resourceId&&row.kind==='skill'&&row.version===source.resourceVersion&&row.title===mapped.title)
 if(!resource||source.kind==='industry-local'&&resource.source.kind!=='local'||source.kind==='industry-public'&&(resource.source.kind!=='public'||resource.source.id!==source.sourceResourceId||resource.source.version!==source.sourceResourceVersion))return record.native.name
 return localizedIndustryResourceTitle(resource,locale)
}

/** packInstall：宿主提供完整的原生预览 / 安装端口；只有为 true 时应用包才给出一次安装。 */
export function appsDirectoryRows(input:{items:readonly MarketCatalogItem[];connections:AppsConnections;installations?:readonly SkillInstallationRecord[];installationsKnown?:boolean;packages?:readonly AppsDeclaredPackage[];loads?:readonly IndustryLoadRecord[];storedContents?:readonly AppsStoredContent[];locale:string;packInstall?:boolean}):AppsRow[]{
 const {locale}=input,text=(value:{'zh-CN':string;en:string;'zh-TW'?:string})=>catalogText(value,locale)
 const installedContent=new Set((input.installations??[]).flatMap(row=>row.state==='installed'&&row.source.kind==='atomic'?[row.source.contentId]:[]))
 const rows:AppsRow[]=[],publisher='Teloa'
 const connectorPacks=new Map<string,Set<string>>()
 for(const {entry} of input.items)if(entry.kind==='skill'&&entry.delivery==='upstream'&&entry.plugin){
  for(const id of entry.plugin.connectors){const owners=connectorPacks.get(id)??new Set<string>();owners.add(entry.plugin.marketplace+':'+entry.plugin.id);connectorPacks.set(id,owners)}
 }
 const connectorOf=(item:MarketCatalogItem,entry:MarketCatalogConnectorEntry):AppsConnector=>({title:text(entry.connector.title),catalogId:entry.id,entry,added:item.addedContentId!==null,auth:authRequirement(entry.connector.auth),tools:entry.connector.tools.map(tool=>({name:tool.name,description:text(tool.description),readOnly:tool.readOnly})),state:connectorState(entry.id,input.connections)})
 for(const item of input.items){
  const entry=item.entry
  if(entry.kind!=='connector')continue
  // 唯一插件明确携带的连接在该应用详情管理；被多个插件共用的连接仍保留独立入口。
  if(connectorPacks.get(entry.id)?.size===1)continue
  const connector=connectorOf(item,entry),state=connector.state!,source=sourceOf(entry.connector.upstreamUrl)
  rows.push({key:'app:'+entry.id,kind:'app',title:text(entry.connector.title),summary:text(entry.connector.summary),categories:functions(entry.taxonomy.functions),entryIds:[entry.id],
   connectors:[connector],
   skills:[],...(source?{source}:{}),publisher,version:entry.version,license:entry.license.spdx,reviewedAt:entry.review.reviewedAt,compatibility:{status:entry.compatibility.status,conditions:entry.compatibility.conditions.map(text)},
   mine:item.addedContentId!==null||state.install!=='not-added'&&state.install!=='unknown'})
 }
 const groups=new Map<string,MarketCatalogItem[]>(),singles:MarketCatalogItem[]=[],plugins=new Map<string,MarketCatalogItem[]>()
 for(const item of input.items){
  if(item.entry.kind!=='skill')continue
  if(item.entry.delivery==='upstream'&&item.entry.plugin){const key=item.entry.plugin.marketplace+':'+item.entry.plugin.id;plugins.set(key,[...plugins.get(key)??[],item]);continue}
  const origin=skillOrigin(item.entry)
  if(!origin){singles.push(item);continue}
  groups.set(origin.key,[...groups.get(origin.key)??[],item])
 }
 const skillOf=(item:MarketCatalogItem):AppsSkill=>{
  const entry=item.entry as SkillEntry
  return {title:text(entry.skill.title),summary:text(entry.skill.summary),entryId:entry.id,item,added:item.addedContentId!==null,installed:item.addedContentId!==null&&installedContent.has(item.addedContentId),builtin:entry.delivery==='builtin'}
 }
 const skillInfo=(entry:SkillEntry)=>({version:entry.version,license:entry.license.spdx,reviewedAt:entry.review.reviewedAt,compatibility:{status:entry.compatibility.status,conditions:entry.compatibility.conditions.map(text)}})
 for(const [key,members] of plugins){
  const first=members[0]!.entry as MarketCatalogUpstreamSkillEntry,plugin=first.plugin!,origin=skillOrigin(first)!,skills=members.map(skillOf)
  const packMembers=members.map(item=>{const entry=item.entry as MarketCatalogUpstreamSkillEntry;return {entryId:entry.id,entry,contentId:item.addedContentId,installed:item.addedContentId!==null&&installedContent.has(item.addedContentId),supported:entry.compatibility.status!=='unsupported'}})
  // 连接只按插件声明里的精确目录条目标识关联；目录里没有的不按名称补
  const connectors=plugin.connectors.flatMap(id=>{const item=input.items.find(row=>row.entry.id===id&&row.entry.kind==='connector');return item?[connectorOf(item,item.entry as MarketCatalogConnectorEntry)]:[]})
  rows.push({key:'pack:'+key,kind:'library',title:text(plugin.title),summary:text(plugin.summary),categories:functions(members.flatMap(item=>item.entry.taxonomy.functions)),connectors,skills,entryIds:members.map(item=>item.entry.id),
   source:origin.url?{label:origin.label,url:origin.url}:{label:origin.label},publisher,...skillInfo(first),license:plugin.license.spdx,
   pack:{pluginId:plugin.id,members:packMembers,unsupported:first.unsupportedComponents,installable:!!input.packInstall&&packMembers.some(member=>member.supported&&!member.installed)},
   mine:skills.some(skill=>skill.added)||connectors.some(connector=>connector.added||connector.state&&connector.state.install!=='not-added'&&connector.state.install!=='unknown')})
 }
 for(const members of groups.values()){
  if(members.length===1){singles.push(members[0]!);continue}
  const first=members[0]!.entry as SkillEntry,origin=skillOrigin(first)!,skills=members.map(skillOf)
  rows.push({key:'library:'+origin.key,kind:'library',title:origin.name,summary:skills.map(skill=>skill.title).join('、'),categories:functions(members.flatMap(item=>item.entry.taxonomy.functions)),connectors:[],skills,entryIds:members.map(item=>item.entry.id),
   source:origin.url?{label:origin.label,url:origin.url}:{label:origin.label},publisher,...skillInfo(first),mine:skills.some(skill=>skill.added||skill.builtin)})
 }
 for(const item of singles){
  const entry=item.entry as SkillEntry,origin=skillOrigin(entry),skill=skillOf(item)
  rows.push({key:'skill:'+entry.id,kind:'skill',title:skill.title,summary:skill.summary,categories:functions(entry.taxonomy.functions),connectors:[],skills:[skill],entryIds:[entry.id],
   ...(origin?{source:origin.url?{label:origin.label,url:origin.url}:{label:origin.label}}:{}),publisher,...skillInfo(entry),mine:skill.added||skill.builtin})
 }
 const catalogContent=new Set(input.items.flatMap(item=>item.addedContentId?[item.addedContentId]:[]))
 for(const content of input.storedContents??[]){
  if(catalogContent.has(content.contentId))continue
  const matches=content.kind==='skill'?(input.installations??[]).filter(record=>record.source.kind==='atomic'&&record.source.contentId===content.contentId&&record.source.contentHash===content.contentHash):[]
  // 已安装技能保留原安装行、详情与按 installationId 分享的路径；只补尚未安装的固定内容。
  if(matches.some(record=>record.state==='installed'))continue
  rows.push({key:'stored:'+content.contentId,kind:content.kind,title:content.title,summary:content.summary,version:content.version,publisher:content.publisher,categories:[],connectors:[],entryIds:[],contentId:content.contentId,
   savedState:content.kind==='bundle'||input.installationsKnown===false?'saved':matches.some(record=>record.state==='preparing')?'installing':'saved-pending-install',
   skills:content.kind==='skill'?[{title:content.title,summary:content.summary,added:true,installed:false,builtin:false}]:[],mine:true})
 }
 for(const record of foldInstalledSkillRecords((input.installations??[]).filter(record=>record.state==='installed'&&!(record.source.kind==='atomic'&&catalogContent.has(record.source.contentId))))){
  const title=installedSkillTitle(record,input.packages??[],input.loads??[],locale)
  rows.push({key:'installed:'+record.id,kind:'installed-skill',installationId:record.id,nativeName:record.native.name,title,summary:record.native.description,categories:[],connectors:[],skills:[{title,summary:record.native.description,added:true,installed:true,builtin:false}],entryIds:[],mine:true})
 }
 for(const declared of input.packages??[]){
  if(input.storedContents?.some(content=>content.itemId===declared.id))continue
  const resources=declared.manifest.resources
  // 应用分组：不含岗位、含技能/连接/扩展任一项的真实资源包；只含岗位的包属于员工模板，不在此列。
  if(resources.some(row=>row.kind==='role')||!resources.some(row=>row.kind==='skill'||row.kind==='mcp'||row.kind==='plugin'))continue
  rows.push({key:'package:'+declared.id,kind:'bundle',title:declared.manifest.title,summary:declared.manifest.description,categories:[],entryIds:[],packageId:declared.id,version:declared.manifest.version,
   connectors:resources.filter(row=>row.kind==='mcp'||row.kind==='plugin').map(row=>({title:row.title,tools:[]})),
   skills:resources.filter(row=>row.kind==='skill').map(row=>({title:row.title,summary:'',added:false,installed:false,builtin:false})),mine:false})
 }
 return rows
}

const inCategory=(row:AppsRow,key:MarketFunctionKey)=>row.categories.includes(key)||key==='other'&&!row.categories.length
/** 不在 Teloa 官方目录里的本机安装技能只属于「我的应用」：不进入浏览目录、用途分类与推荐。 */
const catalogBrowsable=(row:AppsRow)=>row.kind!=='installed-skill'&&!row.contentId
export function appsCategories(rows:readonly AppsRow[]):MarketFunctionKey[]{
 return marketFunctionKeys.filter(key=>rows.some(row=>catalogBrowsable(row)&&inCategory(row,key)))
}

function searchable(row:AppsRow):string{
 return [row.title,row.summary,row.source?.label??'',...row.connectors.flatMap(connector=>[connector.title,...connector.tools.flatMap(tool=>[tool.name,tool.description])]),...row.skills.flatMap(skill=>[skill.title,skill.summary])].join('\n').toLocaleLowerCase()
}
export function filterAppsRows(rows:readonly AppsRow[],view:AppsView):AppsRow[]{
 const words=view.query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
 return rows.filter(row=>(view.mine?row.mine:catalogBrowsable(row))&&(view.category==='all'||inCategory(row,view.category))&&words.every(word=>searchable(row).includes(word)))
}

const sectionLimit=6
/** 默认按用途分区，每个应用只出现在它的首个用途里；推荐只用真实安装量榜单，没有榜单就不出现。 */
export function appsSections(rows:readonly AppsRow[],view:AppsView,ranking:MarketCatalogRanking):AppsSection[]{
 const visible=filterAppsRows(rows,view)
 if(view.mine)return visible.length?[{id:'mine',rows:visible,more:false}]:[]
 if(view.query.trim())return visible.length?[{id:'results',rows:visible,more:false}]:[]
 if(view.category!=='all')return visible.length?[{id:view.category,rows:visible,more:false}]:[]
 const installs=(row:AppsRow)=>Math.max(0,...row.entryIds.map(id=>ranking.get(id)?.installs??0))
 const recommended=visible.filter(row=>installs(row)>0).sort((a,b)=>installs(b)-installs(a)).slice(0,4)
 const sections:AppsSection[]=recommended.length?[{id:'recommended',rows:recommended,more:false}]:[]
 // 没有用途的行（例如资源包、本机安装的技能）归入目录用途表里的「其他」，不另起分区。
 const primary=(row:AppsRow):MarketFunctionKey=>row.categories[0]??'other'
 for(const key of marketFunctionKeys){
  const members=visible.filter(row=>primary(row)===key)
  if(members.length)sections.push({id:key,rows:members.slice(0,sectionLimit),more:members.length>sectionLimit})
 }
 return sections
}

export type AppsRowAction=
 | {kind:'add-connector';entryId:string;entry:MarketCatalogConnectorEntry}
 | {kind:'open-connection';entryId:string;entry:MarketCatalogConnectorEntry}
 | {kind:'add-skill';entryId:string;item:MarketCatalogItem}
 | {kind:'open-content';entryId:string;contentId:string}
 | {kind:'open-package';packageId:string}
 | {kind:'install-pack';key:string;members:{entryId:string;entry:MarketCatalogUpstreamSkillEntry;contentId:string|null}[]}
 | {kind:'detail'}

/** 厂商尚未开放的接入不给新增动作；保留已有真实连接的管理入口。 */
function appUnavailable(row:AppsRow):boolean{
 const connector=row.connectors[0]
 return row.compatibility?.status==='unsupported'||connector?.auth==='unsupported'||connector?.auth==='allowlist'&&connector.state?.connection!=='connected'
}

/** 行上的主动作与真实状态一致：应用直接进入原连接设置，由本人明确连接；技能先添加为内容，状态未知或不支持时只打开详情。 */
export function appsRowAction(row:AppsRow):AppsRowAction{
 if(row.contentId)return {kind:'open-content',entryId:row.key,contentId:row.contentId}
 if(row.kind==='app'){
  const connector=row.connectors[0]!,state=connector.state
  if(!connector.entry||!connector.catalogId||!state||state.install==='unknown'||appUnavailable(row))return {kind:'detail'}
  return state.install==='not-added'&&!connector.added?{kind:'add-connector',entryId:connector.catalogId,entry:connector.entry}:{kind:'open-connection',entryId:connector.catalogId,entry:connector.entry}
 }
 if(row.kind==='skill')return skillAction(row.skills[0]!)
 if(row.pack)return row.pack.installable?{kind:'install-pack',key:row.key,members:row.pack.members.filter(member=>member.supported&&!member.installed).map(({entryId,entry,contentId})=>({entryId,entry,contentId}))}:{kind:'detail'}
 if(row.kind==='bundle'&&row.packageId)return {kind:'open-package',packageId:row.packageId}
 return {kind:'detail'}
}
export function skillAction(skill:AppsSkill):AppsRowAction{
 if(!skill.item||!skill.entryId||skill.builtin||skill.item.entry.kind!=='skill'||skill.item.entry.compatibility.status==='unsupported')return {kind:'detail'}
 return skill.item.addedContentId?{kind:'open-content',entryId:skill.entryId,contentId:skill.item.addedContentId}:{kind:'add-skill',entryId:skill.entryId,item:skill.item}
}

/** 行上显示的状态词：应用取连接进度，技能取添加 / 安装，技能库取已添加数量。 */
export function appsRowStatus(row:AppsRow):{key:string;params?:Record<string,number>}{
 if(row.savedState)return {key:row.savedState}
 if(row.kind==='app'){
  const state=row.connectors[0]?.state
  if(appUnavailable(row))return {key:'unsupported'}
  if(!state||state.install==='unknown')return {key:'unknown'}
  if(state.install==='not-added')return {key:row.connectors[0]?.added?'not-connected':'not-added'}
  if(state.install==='installing'||state.install==='install-failed')return {key:state.install}
  return {key:state.connection}
 }
 if(row.pack){const installed=row.pack.members.filter(member=>member.installed).length;return installed?{key:'installedCount',params:{installed,total:row.pack.members.length}}:row.connectors.length===1&&row.mine?{key:row.connectors[0]!.state?.connection??'unknown'}:{key:'not-added'}}
 if(row.kind==='library'){const added=row.skills.filter(skill=>skill.added||skill.builtin).length;return added?{key:'addedCount',params:{added,total:row.skills.length}}:{key:'not-added'}}
 if(row.kind==='bundle')return {key:'not-added'}
 return {key:skillStatus(row.skills[0]!)}
}
export function skillStatus(skill:AppsSkill):string{
 return skill.builtin?'builtin':skill.installed?'installed':skill.added?'added':skill.item?.entry.kind==='skill'&&skill.item.entry.compatibility.status==='unsupported'?'unsupported':'not-added'
}

/**
 * 从目录行解析可单独分享的能力：官方目录技能按条目 id 与版本固定引用，连接器按声明的 serverName 与工具列表；
 * 本机安装技能与声明资源包没有可读静态正文，由调用方经分享来源端口解析或如实标注不可用。
 */
export type AppsShareSource={subject:'skill'|'app'|'mcp';skills:{name:string;title:string;resourceId:string;version:string;publicId:string}[];connections:{serverName:string;title:string;tools:string[]}[]}
export function appsRowShareSource(row:AppsRow):AppsShareSource|undefined{
 // 公共引用写原技能名与固定版本（契约 localId），不写含点的目录 id；接收方按「名 + 版本」唯一解析回目录条目。
 const skills=row.skills.flatMap(skill=>skill.item?.entry.kind==='skill'&&skill.entryId&&!skill.builtin?[{name:skill.item.entry.skill.name,title:skill.title,resourceId:skill.item.entry.skill.name,version:skill.item.entry.version,publicId:skill.item.entry.skill.name}]:[])
 const connections=row.connectors.flatMap(connector=>connector.entry&&connector.tools.length?[{serverName:connector.entry.connector.serverName,title:connector.title,tools:connector.tools.map(tool=>tool.name)}]:[])
 if(!skills.length&&!connections.length)return undefined
 if(skills.length===1&&!connections.length)return {subject:'skill',skills,connections}
 if(!skills.length&&connections.length===1)return {subject:'mcp',skills,connections}
 return {subject:'app',skills,connections}
}
