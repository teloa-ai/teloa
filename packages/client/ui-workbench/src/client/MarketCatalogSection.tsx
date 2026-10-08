import {catalogAlternatives,catalogEntryTitle,catalogEntrySource,catalogText,loadCatalogListingForKinds,marketCatalogSourceLabels,marketCatalogSources} from './market-catalog-api.js'
import {formatBytes} from './local-models-api.js'
import {Children,Fragment,cloneElement,useEffect,useMemo,useRef,useState,type ReactElement,type ReactNode} from 'react'
import {type MarketCatalogCompatibility,type MarketCatalogListCounts,type MarketEntryKind} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import type {MarketCatalogApi,MarketCatalogItem,MarketCatalogCollection,MarketCatalogRanking,MarketCatalogSource} from './market-catalog-api.js'
import {skillSecretsBadge,type SkillSecretsState} from './skill-secrets-api.js'
import css from './MarketCatalogSection.module.css'
import {MarketReviews} from './MarketReviews.js'
import {MarketDerivativeChanges} from './MarketDerivativeChanges.js'
import {TeloaFeedbackForm} from './TeloaFeedback.js'
import {TeloaFeedbackModel,type FeedbackPayload,type FeedbackResult} from './TeloaFeedbackClient.js'
import type {MarketCatalogEntry,MarketRatings} from '@teloa/contract'
import clsx from 'clsx'
import {ArrowLeft,Check,MessageSquare,Plus} from 'lucide-react'
import pageCss from './MarketPage.module.css'
import staffCss from './StaffAvatar.module.css'
import {StaffAvatar} from './StaffAvatar.js'
import {staffAvatarSeed} from './staff-avatar-seed.js'
import {COMPOSITION_EXTENSION_NOTE_KEY,COMPOSITION_ROWS,composeFromCounts,composeFromManifest,compositionMethodNote,compositionSummary,connectorModeLabel,sourceConnectorMode} from './industry-composition.js'
import {officialSolutionItem,solutionMembers,solutionRowResources} from './market-solution-presentation.js'
import type {MarketItem} from './market-preview.js'
import type {MarketCatalogSolutionPackage} from './market-catalog-api.js'
import type {SolutionMark} from './market-solution-presentation.js'
import type {TeloaTranslate} from './i18n/index.js'
import {FilterRow,MarketEmpty,MarketFilterBar,MarketListRows,MarketResultLine,MoreFilters,moreFilterCss,type MarketListRow} from './MarketUnifiedList.js'
import {filterTaxonomyRows,taxonomySearchTerms,type TaxonomyFilter} from './market-taxonomy-filter.js'

import type {ConnectorAuth,MarketCatalogConnectorEntry} from '@teloa/contract'

/** `kinds` 限定显示哪类条目（技能分类只看技能、行业模板分类只看方案）；缺省全部显示。`onCounts` 回报 Teloa 官方目录全量五类计数（来源筛选只影响当前列表）。
 * `onDetailChange` 告诉页面当前是否停在某条详情上，页面据此收起工具行，详情独占正文。
 * `localRows` 给了就进入「一个页签一个列表」：本机条目（含内置示例）排在官方条目前面，共用一套行业 / 功能筛选与结果行，不再另起目录标题。 */
export type MarketCatalogSectionProps={initialEntryId?:string;onBack?:()=>void;api:MarketCatalogApi;query:string;openContent:(contentId:string)=>Promise<void>|void;openConnection?:(catalogId:string,entry:MarketCatalogConnectorEntry)=>void;openSkillSecrets?:(skill:string,title:string)=>void;describeSkillSecrets?:(skill:string)=>Promise<SkillSecretsState>;openRole?:(roleId:string)=>void;openModels?:()=>void;openLocalModels?:(entryId:string)=>void;openLocalModel?:(()=>void)|undefined;openRetrievalModel?:((catalogId:string,version:string)=>void)|undefined;onCounts?:(counts:MarketCatalogListCounts)=>void;kinds?:readonly MarketEntryKind[]|undefined;onDetailChange?:(open:boolean)=>void;localRows?:readonly MarketListRow[]|undefined;label?:string;onResetQuery?:()=>void;solutionTeam?:CatalogSolutionTeam|undefined}
/**
 * 官方方案产品页接上本机团队步骤（设计约束）：主按钮「添加到我的团队」在当前页先把官方包加到本机，再就地展开与本机方案页同一个团队确认步骤；
 * 「先问问它适不适合我」以官方包内容为依据发起问答。由市场页提供，单独使用（测试、深链）时不接，主按钮退回「添加方案」。
 */
export type CatalogSolutionTeam={
 /** 本机已有这份内容时取出本机条目；没有返回 undefined */
 find:(contentId:string)=>MarketItem|undefined
 /** 是否已加进团队：与本机方案页同一判据（按清单标识与版本对当前生效的加载记录） */
 installed:(value:{manifest?:{id?:string;version?:string}|undefined})=>boolean
 /** 已加进团队时的「看看它带进来什么 · 空间」入口，与本机方案页相同 */
 loadLinks:(value:{manifest?:{id?:string;version?:string}|undefined})=>ReactNode
 /** 刚添加后按内容编号读回本机条目（不跳页） */
 resolve:(contentId:string)=>Promise<MarketItem>
 /** 与本机方案页同一个团队确认步骤；close 收起 */
 form:(item:MarketItem,close:()=>void)=>ReactNode
 /** 以官方包内容为依据发起「先问问它适不适合我」 */
 ask:(item:MarketItem)=>Promise<void>
}

const compatibilityKeys:Record<MarketCatalogCompatibility,'market.catalog.official.compatVerified'|'market.catalog.official.compatNeedsConfiguration'|'market.catalog.official.compatContentOnly'|'market.catalog.official.compatUnsupported'>={
 verified:'market.catalog.official.compatVerified','needs-configuration':'market.catalog.official.compatNeedsConfiguration','content-only':'market.catalog.official.compatContentOnly',unsupported:'market.catalog.official.compatUnsupported',
}
const capabilityGroupKeys={
 now:'market.catalog.official.capabilitiesNow' as const,
 needs:'market.catalog.official.capabilitiesNeeds' as const,
 permissions:'market.catalog.official.capabilitiesPermissions' as const,
}
const sortKeys={
 default:'market.catalog.official.sortDefault' as const,
 installs:'market.catalog.official.sortInstalls' as const,
 popular:'market.catalog.official.sortPopular' as const,
}

export {catalogText,loadCatalogListing} from './market-catalog-api.js'

/** 厂商白名单制且不收用户自带 client_id 的 OAuth 连接器：暂不可用，卡片与连接页都不给连接入口 */
export const oauthAllowlistBlocked=(auth:ConnectorAuth):boolean=>auth.kind==='oauth'&&auth.supported&&!!auth.requiresAllowlist&&!auth.requiresUserClientId
/** 授权不限定 scope 的 OAuth 连接器：令牌为全权限，只读只能靠服务端参数（如 Supabase 的 read_only=true），添加与连接界面须显著提示 */
export const oauthFullAccessToken=(auth:ConnectorAuth):boolean=>auth.kind==='oauth'&&auth.supported&&auth.scopes.length===0

// 为词表键构建含中英文标签的搜索扩展词（来自 market-taxonomy 词表）
function taxonomyCorpus(axis:'function'|'industry',keys:string[]):string[]{
 return keys.flatMap(key=>[key,...taxonomySearchTerms(axis,key)])
}

export function marketCatalogMatches(item:MarketCatalogItem,query:string):boolean{
 const needle=query.trim().toLocaleLowerCase()
 if(!needle)return true
 const {entry}=item
 const fnTerms=taxonomyCorpus('function',entry.taxonomy.functions)
 const indTerms=taxonomyCorpus('industry',entry.taxonomy.industries)
 if(entry.kind==='skill'){
  const base=[entry.skill.name,entry.skill.title['zh-CN'],entry.skill.title.en,entry.skill.summary['zh-CN'],entry.skill.summary.en,...fnTerms,...indTerms]
  if(entry.delivery==='upstream'){
   return base.some(value=>value.toLocaleLowerCase().includes(needle))
  }
  return [...base,...(entry.upstream?[entry.upstream.author]:[])].some(value=>value.toLocaleLowerCase().includes(needle))
 }
 if(entry.kind==='dashboard')return [entry.dashboard.packageId,...Object.values(entry.dashboard.title),...Object.values(entry.dashboard.summary),...fnTerms,...indTerms].some(value=>value.toLocaleLowerCase().includes(needle))
 if(entry.kind==='solution')
  return [entry.solution.packageId,entry.solution.title['zh-CN'],entry.solution.title.en,entry.solution.summary['zh-CN'],entry.solution.summary.en,...fnTerms,...indTerms].some(value=>value.toLocaleLowerCase().includes(needle))
 if(entry.kind==='connector')
  return [entry.connector.serverName,entry.connector.title['zh-CN'],entry.connector.title.en,entry.connector.summary['zh-CN'],entry.connector.summary.en,...fnTerms,...indTerms].some(value=>value.toLocaleLowerCase().includes(needle))
 if(entry.kind==='role')
  return [entry.role.roleId,entry.role.title['zh-CN'],entry.role.title.en,entry.role.summary['zh-CN'],entry.role.summary.en,entry.role.fromSolution.packageId,...fnTerms,...indTerms].some(value=>value.toLocaleLowerCase().includes(needle))
 return [entry.model.modelId,entry.model.title['zh-CN'],entry.model.title.en,entry.model.summary['zh-CN'],entry.model.summary.en,...(entry.model.form==='cloud'?entry.model.cloud.models.map(model=>model.id):entry.model.form==='local-general'?entry.model.variants.map(variant=>variant.sources[0].name):[entry.model.native.providerId,...entry.model.usage]),...fnTerms,...indTerms].some(value=>value.toLocaleLowerCase().includes(needle))
}

export function marketCatalogVisible(items:readonly MarketCatalogItem[],query:string,kinds?:readonly MarketCatalogItem['entry']['kind'][]):MarketCatalogItem[]{
 return items.filter(item=>(!kinds||kinds.includes(item.entry.kind))&&marketCatalogMatches(item,query))
}
/** newerApp>0 才显示一行提示，且只在市场首页（不限 kinds）显示：计数不分类型，放在类别页会误导；unknownKind 只记日志不显示（对本机永远不可用，提示无行动价值）。 */
export function catalogSkippedHint(skipped:{unknownKind:number;newerApp:number},kinds?:readonly MarketEntryKind[]):number|null{return !kinds&&skipped.newerApp>0?skipped.newerApp:null}

type MarketplaceFilter=MarketCatalogSource|undefined
export type MarketCatalogSort='default'|'installs'|'popular'
/** 排序只在榜单有数据时生效：安装量按累计排，热门按近 7 日排；同值保持原顺序（Array.prototype.sort 是稳定排序）。 */
export function sortCatalogItems(items:readonly MarketCatalogItem[],ranking:MarketCatalogRanking,sort:MarketCatalogSort):MarketCatalogItem[]{
 if(sort==='default'||ranking.size===0)return [...items]
 const value=(item:MarketCatalogItem)=>{const row=ranking.get(item.entry.id);return row?(sort==='installs'?row.installs:row.recent):0}
 return [...items].sort((left,right)=>value(right)-value(left))
}
/** 排序行显示条件（规格 §8）：当前类别至少一个条目有安装量才显示；模型条目不参与，模型类别因此永不显示。 */
export function catalogSortVisible(items:readonly MarketCatalogItem[],ranking:MarketCatalogRanking):boolean{
 return items.some(item=>item.entry.kind!=='model'&&(ranking.get(item.entry.id)?.installs??0)>0)
}


type RoleReceipt={roleId:string;status:'created'|'existing'}

/** 评价区只在宿主给了 reviews 接口且汇总 `enabled:true` 时显示（规格 §14）：在线市场未启用、汇总读取失败或旧宿主一律不显示、不再发评价请求。 */
export const reviewsEnabled=(api:Pick<MarketCatalogApi,'reviews'>,ratings:MarketRatings|undefined):boolean=>api.reviews!==undefined&&ratings?.enabled===true

export function MarketCatalogSection({initialEntryId,onBack,api,query,openContent,openConnection,openSkillSecrets,describeSkillSecrets,openRole,openModels,openLocalModels,openLocalModel,openRetrievalModel,onCounts,kinds,onDetailChange,localRows,label,onResetQuery,solutionTeam}:MarketCatalogSectionProps){
 const {t,locale,number}=useI18n()
 const [marketplace,setMarketplace]=useState<MarketplaceFilter>(undefined)
 const [listing,setListing]=useState<MarketCatalogCollection>()
 const [readError,setReadError]=useState<string>()
 const [entryHistory,setEntryHistory]=useState<Array<{entryId:string;fromId?:string}>>(()=>initialEntryId?[{entryId:initialEntryId}]:[])
 const selectedEntryId=entryHistory.at(-1)?.entryId
 const sectionRef=useRef<HTMLElement>(null)
 const pendingFocus=useRef<{kind:'detail'}|{kind:'back';targetId:string;originId:string|undefined}|undefined>(initialEntryId?{kind:'detail'}:undefined)
 useEffect(()=>{
  const intent=pendingFocus.current,root=sectionRef.current
  if(!intent||!root||(!listing&&!readError))return
  // 从列表行进的详情（没有来源条目）返回时聚焦那一行；从「推荐改用」链接进的返回时聚焦那条链接
  const target=intent.kind==='detail'?root.querySelector<HTMLElement>('[data-catalog-detail-title]'):intent.originId===undefined?[...root.querySelectorAll<HTMLElement>('[data-catalog-row]')].find(row=>row.dataset.catalogRow===intent.targetId):[...root.querySelectorAll<HTMLButtonElement>('[data-catalog-target]')].find(button=>button.dataset.catalogTarget===intent.targetId&&button.dataset.catalogOrigin===intent.originId)
  target?.focus();pendingFocus.current=undefined
 },[selectedEntryId,entryHistory.length,listing,readError])
 const openEntry=(entryId:string,fromId?:string)=>{
  if(!listing?.items.some(item=>item.entry.id===entryId))return
  pendingFocus.current={kind:'detail'}
  setEntryHistory(history=>[...history,fromId===undefined?{entryId}:{entryId,fromId}])
 }
 const detailOpen=selectedEntryId!==undefined
 useEffect(()=>{onDetailChange?.(detailOpen)},[detailOpen])
 useEffect(()=>()=>onDetailChange?.(false),[])
 const backFromEntry=()=>{
  if(entryHistory.length===1&&initialEntryId&&onBack){onBack();return}
  const last=entryHistory.at(-1)!
  pendingFocus.current={kind:'back',targetId:last.entryId,originId:last.fromId}
  setEntryHistory(history=>history.slice(0,-1))
 }
 const [busy,setBusy]=useState<string>()
 const [addErrors,setAddErrors]=useState<Record<string,string>>({})
 const [roleReceipts,setRoleReceipts]=useState<Record<string,RoleReceipt>>({})
 const [revision,setRevision]=useState(0)
 const [taxonomy,setTaxonomy]=useState<TaxonomyFilter>({industry:null,fn:null})
 const [ratings,setRatings]=useState<MarketRatings>()
 // 评分汇总与目录并行读取；读取失败或在线市场未启用（enabled:false）时不显示评价，也不再发评价请求
 useEffect(()=>{
  let active=true
  if(!api.reviews)return
  void api.reviews.summary().then(value=>{if(active)setRatings(value)},()=>{})
  return()=>{active=false}
 },[api])
 const reviewsApi=api.reviews
 const ratingById=useMemo(()=>new Map((ratings?.entries??[]).map(row=>[row.id,row] as const)),[ratings])
 const reviewSlot=reviewsApi&&reviewsEnabled(api,ratings)?(entry:MarketCatalogEntry)=><MarketReviews api={reviewsApi} entryId={entry.id} rating={ratingById.get(entry.id)}/>:undefined
 const [ranking,setRanking]=useState<MarketCatalogRanking>(new Map())
 const [sort,setSort]=useState<MarketCatalogSort>('default')
 // 榜单与目录并行读取；api.ranking 从不拒绝，失败即返回空表（不显示排序与安装量）
 useEffect(()=>{
  let active=true
  void api.ranking().then(value=>{if(active)setRanking(value)})
  return()=>{active=false}
 },[api])
 useEffect(()=>{
  let active=true
  setListing(undefined);setReadError(undefined)
  void loadCatalogListingForKinds(api,kinds).then(value=>{if(active){setListing(value);onCounts?.(value.counts)}},error=>{if(active)setReadError(localizeWorkError(locale,error))})
  return()=>{active=false}
 },[api,revision,kinds?.join()])
 // 停在官方方案详情时读方案包清单，产品页据此列「添加后你会得到」；换条目或重试时重读
 const selectedSolution=listing?.items.find(item=>item.entry.id===selectedEntryId&&item.entry.kind==='solution')?.entry.id
 const [solutionPackage,setSolutionPackage]=useState<{entryId:string;state:CatalogSolutionPackageState}>()
 const [solutionRevision,setSolutionRevision]=useState(0)
 useEffect(()=>{
  if(!selectedSolution)return
  let active=true
  setSolutionPackage({entryId:selectedSolution,state:{status:'loading'}})
  api.solutionPackage(selectedSolution).then(value=>{if(active)setSolutionPackage({entryId:selectedSolution,state:{status:'ready',...value}})},()=>{if(active)setSolutionPackage({entryId:selectedSolution,state:{status:'failed'}})})
  return()=>{active=false}
 },[api,selectedSolution,solutionRevision])
 // 团队确认步骤：就地展开的本机条目，与「先问问」进行中
 const [teamPanel,setTeamPanel]=useState<{entryId:string;item:MarketItem}>()
 const [asking,setAsking]=useState(false)
 const addToTeam=async(item:MarketCatalogItem)=>{
  const id=item.entry.id
  if(!solutionTeam)return
  setBusy(id);setAddErrors(current=>{const {[id]:_,...rest}=current;return rest})
  let contentId=item.addedContentId
  try{
   if(!contentId){
    const added=(await api.add(id)).contentId
    contentId=added
    setListing(current=>current&&{...current,items:current.items.map(row=>row.entry.id===id?{...row,addedContentId:added}:row)})
   }
  }catch(error){setAddErrors(current=>({...current,[id]:t('market.catalog.official.addFailed',{reason:localizeWorkError(locale,error)})}));setBusy(undefined);return}
  try{
   const local=solutionTeam.find(contentId)??await solutionTeam.resolve(contentId)
   // 读回后再判断一次：已经在团队里（例如别处刚加过）就不再展开确认步骤
   if(!solutionTeam.installed(local))setTeamPanel({entryId:id,item:local})
  }catch(error){setAddErrors(current=>({...current,[id]:t('market.catalog.solution.teamOpenFailed',{reason:localizeWorkError(locale,error)})}))}
  finally{setBusy(undefined)}
 }
 const askFit=async(item:MarketCatalogItem,state:CatalogSolutionPackageState)=>{
  if(!solutionTeam||item.entry.kind!=='solution'||state.status!=='ready')return
  const id=item.entry.id
  setAsking(true);setAddErrors(current=>{const {[id]:_,...rest}=current;return rest})
  // 同步抛出（例如草稿保存校验失败）与异步失败一样复位并给出原因
  try{await solutionTeam.ask(officialSolutionItem(item.entry,state.manifest))}
  catch(error){setAddErrors(current=>({...current,[id]:localizeWorkError(locale,error)}))}
  finally{setAsking(false)}
 }
 const add=async(item:MarketCatalogItem)=>{
  const id=item.entry.id
  if(item.entry.kind==='role'||item.entry.kind==='model')return
  setBusy(id);setAddErrors(current=>{const {[id]:_,...rest}=current;return rest})
  let contentId:string
  try{
   contentId=(await api.add(id)).contentId
   setListing(current=>current&&{...current,items:current.items.map(row=>row.entry.id===id?{...row,addedContentId:contentId}:row)})
  }catch(error){setAddErrors(current=>({...current,[id]:t('market.catalog.official.addFailed',{reason:localizeWorkError(locale,error)})}));setBusy(undefined);return}
  if(item.entry.kind==='connector'&&openConnection){openConnection(id,item.entry as MarketCatalogConnectorEntry);setBusy(undefined);return}
  try{await openContent(contentId)}catch(error){setAddErrors(current=>({...current,[id]:t('market.catalog.official.openFailed',{reason:localizeWorkError(locale,error)})}))}
  finally{setBusy(undefined)}
 }
 const addRole=async(item:MarketCatalogItem)=>{
  const id=item.entry.id
  if(item.entry.kind!=='role')return
  setBusy(id);setAddErrors(current=>{const {[id]:_,...rest}=current;return rest})
  try{
   const receipt=await api.addRole(id,item.entry.version)
   setRoleReceipts(current=>({...current,[id]:{roleId:receipt.roleId,status:receipt.status}}))
   // 已添加（existing）同样跳转到该岗位：不重复建岗
   openRole?.(receipt.roleId)
  }catch(error){setAddErrors(current=>({...current,[id]:t('market.catalog.official.addFailed',{reason:localizeWorkError(locale,error)})}))}
  finally{setBusy(undefined)}
 }
 const skippedHint=listing?catalogSkippedHint(listing.skipped,kinds):null
 // kinds + query + 来源过滤后的官方条目；本机条目只在「全部来源」下出现（它们不属于任何外部来源）
 const baseItems=marketCatalogVisible((listing?.items??[]).filter(item=>!marketplace||catalogEntrySource(item.entry)===marketplace),query,kinds)
 const unavailableSources=listing?.unavailableSources.filter(source=>!marketplace||source===marketplace)??[]
 // 从官方目录添加过的条目在本机也有一份内容：只留官方那一行（带「已添加」记号），不重复列出
 const addedContent=new Set((listing?.items??[]).flatMap(item=>item.addedContentId?[item.addedContentId]:[]))
 // 目录读完前先不显示带内容编号的本机行（可能是已添加的官方条目，读完就会被合并掉），避免闪现；读取失败时照常显示
 const local=marketplace?[]:(localRows??[]).filter(row=>!row.contentId||(listing?!addedContent.has(row.contentId):!!readError))
 // 本机条目（含内置示例）排在前面，官方条目按排序方式排在后面；两者同一套行业 / 功能筛选
 const officialRows=sortCatalogItems(baseItems,ranking,sort).map(item=>catalogListRow(item,{t,locale,number,ranking,roleReceipt:roleReceipts[item.entry.id],openEntry,after:<CatalogAlternativeLinks entry={item.entry} items={listing?.items??[]} openEntry={openEntry}/>}))
 const allRows=[...local,...officialRows]
 const rows=filterTaxonomyRows(allRows,row=>row.taxonomy,taxonomy)
 const openAdded=async(contentId:string)=>{
  const entryId=listing?.items.find(item=>item.addedContentId===contentId)?.entry.id
  try{await openContent(contentId)}
  catch(error){if(entryId)setAddErrors(current=>({...current,[entryId]:t('market.catalog.official.openFailed',{reason:localizeWorkError(locale,error)})}))}
 }
 const renderCards=(rows:readonly MarketCatalogItem[])=><MarketCatalogCards items={rows} catalogItems={listing?.items??[]} openEntry={openEntry} ranking={ranking} busy={busy} addErrors={addErrors} add={item=>void add(item)} open={contentId=>void openAdded(contentId)} addRole={item=>void addRole(item)} roleReceipts={roleReceipts} {...(openConnection?{openConnection}:{})} {...(openSkillSecrets?{openSkillSecrets}:{})} {...(describeSkillSecrets?{describeSkillSecrets}:{})} {...(openRole?{openRole}:{})} {...(openModels?{openModels}:{})} {...(openLocalModels?{openLocalModels}:{})} {...(reviewSlot?{reviewSlot}:{})} openLocalModel={openLocalModel} openRetrievalModel={openRetrievalModel}/>
 if(selectedEntryId){
  const selected=listing?.items.find(item=>item.entry.id===selectedEntryId)
  if(selected?.entry.kind==='solution'){
   const id=selected.entry.id
   const pkg:CatalogSolutionPackageState=solutionPackage?.entryId===id?solutionPackage.state:{status:'loading'}
   // 是否已在团队：方案包读到后按清单标识与版本判断，与本机方案页同一判据（不依赖本机列表是否已读回这份内容）
   const loaded=pkg.status==='ready'&&!!solutionTeam?.installed({manifest:pkg.manifest})
   return <section ref={sectionRef} className={css.section} aria-label={t('market.catalog.official.detailTitle')}>
    <CatalogSolutionProduct item={selected} pkg={pkg} busy={busy} error={addErrors[id]} add={()=>void add(selected)} {...(solutionTeam?{team:{loaded,links:loaded&&pkg.status==='ready'?solutionTeam.loadLinks({manifest:pkg.manifest}):null,panel:!loaded&&teamPanel?.entryId===id?solutionTeam.form(teamPanel.item,()=>setTeamPanel(undefined)):null,addToTeam:()=>void addToTeam(selected)},ask:{busy:asking,run:()=>void askFit(selected,pkg)}}:{})} open={contentId=>void openAdded(contentId)} back={backFromEntry} retry={()=>setSolutionRevision(value=>value+1)} after={<><CatalogAlternativeLinks entry={selected.entry} items={listing?.items??[]} openEntry={openEntry}/>{reviewSlot?.(selected.entry)}</>}/>
   </section>
  }
  return <section ref={sectionRef} className={clsx(css.section,css.detailView)} aria-label={t('market.catalog.official.detailTitle')}>
   <button type="button" className={css.backLink} onClick={backFromEntry}><ArrowLeft size={15}/>{t('market.catalog.connector.back')}</button>
   <header className={css.header}><h2 tabIndex={-1} data-catalog-detail-title>{t('market.catalog.official.detailTitle')}</h2></header>
   {!listing&&!readError&&<p className={css.status} role="status">{t('market.catalog.official.loading')}</p>}
   {selected?renderCards([selected]):(listing||readError)&&<p className={css.error} role="status">{t('market.catalog.official.entryUnavailable')}<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('market.catalog.official.retry')}</button></p>}
  </section>
 }
 const merged=localRows!==undefined
 const filtered=!!query.trim()||marketplace!==undefined||taxonomy.industry!==null||taxonomy.fn!==null
 const layout=kinds?.length===1&&kinds[0]==='solution'?'grid':'list'
 const version=listing?t('market.catalog.official.version',{version:listing.catalogVersion}):undefined
 return <section ref={sectionRef} className={css.section} aria-label={label??t('market.catalog.official.title')}>
  {/* 单独使用（连接页深链等）时保留目录标题；页面里与本机条目合成一个列表时不再另起标题，只写结果行 */}
  {!merged&&<header className={css.header}><h2>{t('market.catalog.official.title')}</h2>{version&&<span>{version}</span>}</header>}
  <MarketFilterBar rows={allRows} tags={row=>row.taxonomy} filter={taxonomy} onChange={setTaxonomy}>
   {catalogSortVisible(baseItems,ranking)&&<FilterRow label={t('market.catalog.official.sortLabel')} aria={t('market.catalog.official.sortAria')}>
    {(['default','installs','popular'] as const).map(value=><button key={value} type="button" aria-pressed={sort===value} onClick={()=>setSort(value)}>{t(sortKeys[value])}</button>)}
   </FilterRow>}
   <MoreFilters label={t('market.catalog.official.moreFilters')}>
    <div className={moreFilterCss.chips} role="group" aria-label={t('market.catalog.official.sourceFilterAria')}>
     <button type="button" onClick={()=>setMarketplace(undefined)} aria-pressed={marketplace===undefined}>{t('market.catalog.official.filterAll')}</button>
     {marketCatalogSources.map(source=><button key={source} type="button" onClick={()=>setMarketplace(source)} aria-pressed={marketplace===source}>{source==='teloa'?t('market.catalog.official.filterTeloa'):source==='clawhub'?t('market.catalog.official.filterClawHub'):marketCatalogSourceLabels[source]}</button>)}
    </div>
   </MoreFilters>
  </MarketFilterBar>
  {readError&&<p className={css.error} role="alert">{t('market.catalog.official.readFailed',{reason:readError})}<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('market.catalog.official.retry')}</button></p>}
  {unavailableSources.length>0&&<p className={css.error} role="status">{t('market.catalog.official.sourcesUnavailable',{sources:unavailableSources.map(source=>marketCatalogSourceLabels[source]).join(', ')})}<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('market.catalog.official.retry')}</button></p>}
  {!listing&&!readError&&<p className={css.status} role="status">{t('market.catalog.official.loading')}</p>}
  {(listing||local.length>0)&&!(marketplace&&unavailableSources.length)&&<>
   <MarketResultLine count={rows.length} {...(merged&&version?{suffix:version}:{})}/>
   {rows.length?<MarketListRows rows={rows} layout={layout}/>:merged?<MarketEmpty filtered={filtered} onReset={()=>{setTaxonomy({industry:null,fn:null});setMarketplace(undefined);onResetQuery?.()}}/>:<p className={css.status}>{t('market.catalog.official.empty')}</p>}
  </>}
  {skippedHint!==null&&<p className={css.status} role="status">{t('market.catalog.official.newerApp',{count:skippedHint})}</p>}
 </section>
}

const catalogSummary=(entry:MarketCatalogEntry)=>entry.kind==='skill'?entry.skill.summary:entry.kind==='solution'?entry.solution.summary:entry.kind==='dashboard'?entry.dashboard.summary:entry.kind==='role'?entry.role.summary:entry.kind==='connector'?entry.connector.summary:entry.model.summary
const catalogArtKind=(kind:MarketEntryKind)=>kind==='role'?'agent' as const:kind==='solution'?'industry' as const:kind

/** 条目记号与本机条目卡同一套：已添加（含内置、已建同事）/ 可添加；模型走「去配置」、不支持或不能添加的不给记号。 */
export function catalogItemMark(item:MarketCatalogItem,receipt?:RoleReceipt):SolutionMark|null{
 const {entry}=item
 if(entry.kind==='model')return null
 if(item.addedContentId||item.addedRoleId||receipt||entry.delivery==='builtin')return 'added'
 if(entry.compatibility.status==='unsupported')return null
 if(entry.kind==='skill'&&entry.license.spdx==='NOASSERTION')return null
 if(entry.kind==='connector'&&oauthAllowlistBlocked(entry.connector.auth))return null
 return 'available'
}

/** 官方条目换成统一列表行：第三行小字是「兼容状态 · 来源 · 安装量」；点开进入目录详情。 */
export function catalogListRow(item:MarketCatalogItem,{t,locale,number,ranking,roleReceipt,openEntry,after}:{t:TeloaTranslate;locale:string;number:(value:number)=>string;ranking?:MarketCatalogRanking|undefined;roleReceipt?:RoleReceipt|undefined;openEntry:(entryId:string)=>void;after?:ReactNode}):MarketListRow{
 const {entry}=item,installs=ranking?.get(entry.id)?.installs??0
 const state=entry.kind==='model'
  ?t(entry.model.form==='cloud'?(entry.model.cnReachable==='direct'?'market.catalog.official.modelReachDirect':entry.model.cnReachable==='mirror'?'market.catalog.official.modelReachMirror':'market.catalog.official.modelReachProxy'):entry.model.form==='local-general'?'market.catalog.official.modelLocalBadge':'market.catalog.official.localModelBadge')
  :t(compatibilityKeys[entry.compatibility.status])
 const source=entry.delivery==='upstream'?marketCatalogSourceLabels[catalogEntrySource(entry)]:'Teloa'
 const contains=item.contents?compositionSummary(composeFromCounts(item.contents),t,number):''
 return {
  key:'catalog:'+entry.id,catalogId:entry.id,title:catalogText(catalogEntryTitle(entry),locale),summary:catalogText(catalogSummary(entry),locale),
  // 官方方案带了包含计数时照原型方案卡写「包含：…」，与本机方案卡同一套摘要
  facts:contains?t('market.solution.contains',{list:contains}):[state,source,...(installs>0?[t('market.catalog.official.installs',{count:number(installs)})]:[])].join(' · '),
  mark:catalogItemMark(item,roleReceipt),art:{kind:catalogArtKind(entry.kind),seed:entry.id},taxonomy:entry.taxonomy,open:()=>openEntry(entry.id),
  ...(after?{after}:{}),
 }
}

export type MarketCatalogCardsProps={catalogItems?:readonly MarketCatalogItem[];openEntry?:(entryId:string,fromId:string)=>void;items:readonly MarketCatalogItem[];busy:string|undefined;addErrors:Readonly<Record<string,string>>;add:(item:MarketCatalogItem)=>void;open:(contentId:string)=>void;openConnection?:(catalogId:string,entry:MarketCatalogConnectorEntry)=>void;openSkillSecrets?:(skill:string,title:string)=>void;describeSkillSecrets?:(skill:string)=>Promise<SkillSecretsState>;addRole?:(item:MarketCatalogItem)=>void;openRole?:(roleId:string)=>void;openModels?:()=>void;openLocalModels?:(entryId:string)=>void;openLocalModel?:(()=>void)|undefined;openRetrievalModel?:((catalogId:string,version:string)=>void)|undefined;roleReceipts?:Readonly<Record<string,RoleReceipt>>;ranking?:MarketCatalogRanking;reviewSlot?:(entry:MarketCatalogEntry)=>ReactNode}

/** 「已添加」技能卡片的密钥入口：挂载时查一次状态（不轮询）作按钮文字，失败或未提供查询时只写「密钥」；点击进入技能密钥页。 */
function SkillSecretsBadgeButton({skill,title,describe,open}:{skill:string;title:string;describe:((skill:string)=>Promise<SkillSecretsState>)|undefined;open:(skill:string,title:string)=>void}){
 const {t}=useI18n()
 const [label,setLabel]=useState(()=>t('market.skillSecrets.open'))
 useEffect(()=>{
  let active=true
  describe?.(skill).then(state=>{if(active)setLabel(skillSecretsBadge(state,t))},()=>{})
  return()=>{active=false}
 },[describe,skill])
 return <button type="button" onClick={()=>open(skill,title)}>{label}</button>
}

/** GitHub 固定提交目录链接：路径逐段编码（空格、非 ASCII 等），前缀固定为 github.com。 */
function githubTreeUrl(repository:{owner:string;repo:string},commit:string,path:string):string{
 return 'https://github.com/'+[repository.owner,repository.repo,'tree',commit,...path.split('/')].map(encodeURIComponent).join('/')
}

/** 端点只显示主机名；解析不了（目录校验只查 https 前缀）时显示原文，不让整张列表抛错。 */
function endpointHost(baseURL:string):string{try{return new URL(baseURL).hostname}catch{return baseURL}}

/** 把评价折叠区追加为卡片的最后一个子节点；没有评价区时原样返回。 */
function appendSlot(card:ReactElement<{children?:ReactNode}>,slot:ReactNode):ReactElement{
 return slot?cloneElement(card,undefined,...Children.toArray(card.props.children),slot):card
}

export function MarketCatalogCards({items,catalogItems=items,openEntry,busy,addErrors,add,open,openConnection,openSkillSecrets,describeSkillSecrets,addRole,openRole,openModels,openLocalModels,openLocalModel,openRetrievalModel,roleReceipts,ranking,reviewSlot}:MarketCatalogCardsProps){
 const {t,locale,number}=useI18n()
 return items.length?<ul className={css.list}>{items.map(item=>appendSlot((()=>{
   const {entry}=item
   const installs=ranking?.get(entry.id)?.installs??0
   const installsBadge=installs>0?<span className={css.badge}>{t('market.catalog.official.installs',{count:number(installs)})}</span>:null
   const actions=<div className={css.actions}>{entry.delivery==='builtin'?<span>{t('market.catalog.official.builtin')}</span>:item.addedContentId?<><span>{t('market.catalog.official.added')}</span><button type="button" onClick={()=>entry.kind==='connector'&&openConnection?openConnection(entry.id,entry as MarketCatalogConnectorEntry):open(item.addedContentId!)}>{t('market.catalog.official.view')}</button>{entry.kind==='skill'&&entry.secrets?.length&&openSkillSecrets?<SkillSecretsBadgeButton skill={entry.skill.name} title={catalogText(entry.skill.title,locale)} describe={describeSkillSecrets} open={openSkillSecrets}/>:null}</>:<button type="button" className={css.primary} disabled={busy!==undefined} onClick={()=>add(item)}>{busy===entry.id?t('market.catalog.official.adding'):entry.kind==='solution'?t('market.catalog.official.addSolution'):entry.kind==='connector'?t('market.catalog.official.addConnector'):t('market.catalog.official.add')}</button>}</div>
   const errorNode=addErrors[entry.id]&&<p className={css.error} role="alert">{addErrors[entry.id]}</p>
   const feedback=<MarketResourceFeedback entry={entry}/>
   if(entry.kind==='skill'){
    // 上游来源条目（delivery:'upstream'）
    if(entry.delivery==='upstream'){
     const up=entry.upstream,installsSource=entry.origin.installsSource
     const sourceLabel=up.kind==='clawhub'?t('market.catalog.official.upstreamClawHub',{owner:up.owner}):t('market.catalog.official.upstreamGitHub',{owner:up.repository.owner,repo:up.repository.repo})
     const unsupported=entry.unsupportedComponents.length?t('market.catalog.official.unsupportedComponents',{kinds:entry.unsupportedComponents.map(c=>c.kind+'('+c.count+')').join(', ')}):null
     const effectiveActions=entry.license.spdx==='NOASSERTION'?<p className={css.status}>{t('market.catalog.official.provenanceOnly')}</p>:entry.compatibility.status==='unsupported'
      ?<div className={css.actions}><span>{entry.compatibility.conditions[0]?catalogText(entry.compatibility.conditions[0],locale):t('market.catalog.official.unsupportedFallback')}</span></div>
      :actions
     return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
      <div className={css.top}><h3 className={css.name}>{catalogText(entry.skill.title,locale)}</h3><span className={css.badge}>{t(compatibilityKeys[entry.compatibility.status])}</span>{installsBadge}</div>
      <p className={css.summary}>{catalogText(entry.skill.summary,locale)}</p>
      <p className={css.meta}>{sourceLabel} · {t('market.catalog.official.matchesOriginal')}</p>
      <SecretGroupLine group={item.secretGroup} entryId={entry.id}/>
      {unsupported&&<p className={css.meta}>{unsupported}</p>}
      {effectiveActions}{errorNode}
      <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
       {up.kind==='github'&&<p><a href={githubTreeUrl(up.repository,up.commit,up.path)} target="_blank" rel="noreferrer">{t('market.catalog.official.openUpstream')}</a></p>}
       {installsSource&&entry.origin.installs!==null&&<p>{t('market.catalog.official.originInstalls',{count:number(entry.origin.installs)})} · <a href={installsSource.url} target="_blank" rel="noreferrer">{t(installsSource.scope==='plugin'?'market.catalog.official.installsSourcePlugin':'market.catalog.official.installsSource',{site:endpointHost(installsSource.url),date:entry.origin.countedAt})}</a></p>}
       {entry.modifications.length?<ul>{entry.modifications.map((change,index)=><li key={index}>{catalogText(change,locale)}</li>)}</ul>:<p>{t('market.catalog.official.noModifications')}</p>}
       <SecretGroupDetails group={item.secretGroup} entryId={entry.id}/>
       {entry.compatibility.conditions.length>0&&<ul>{entry.compatibility.conditions.map((condition,index)=><li key={index}>{catalogText(condition,locale)}</li>)}</ul>}
       <p>{entry.requires.tools.length?t('market.catalog.official.tools',{tools:entry.requires.tools.join(', ')}):t('market.catalog.official.noTools')} · {entry.requires.network?t('market.catalog.official.networkYes'):t('market.catalog.official.networkNo')}</p>
       <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
       <p className={css.mono}>{entry.id}@{entry.version}</p>
       {feedback}
      </details>
     </li>
    }
    // 旧格式条目（delivery:'builtin'|'install'）
    // Teloa 自编内置技能没有外部上游（upstream 为 null）：不出上游链接与提交。
    const upstream=entry.upstream,derivation=entry.derivation
    const upstreamUrl=upstream&&githubTreeUrl(upstream.repository,upstream.commit,upstream.path)
    return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
     <div className={css.top}><h3 className={css.name}>{catalogText(entry.skill.title,locale)}</h3><span className={css.badge}>{t(compatibilityKeys[entry.compatibility.status])}</span>{installsBadge}</div>
     <p className={css.summary}>{catalogText(entry.skill.summary,locale)}</p>
     <p className={css.meta}>{upstream&&derivation?t('market.catalog.official.derivedFrom',{author:upstream.author,owner:upstream.repository.owner,repo:upstream.repository.repo,license:entry.license.spdx}):upstream?t('market.catalog.official.upstream',{author:upstream.author,license:entry.license.spdx}):t('market.catalog.official.builtinSource',{license:entry.license.spdx})}</p>
     <SecretGroupLine group={item.secretGroup} entryId={entry.id}/>
     {actions}{errorNode}
     <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
      {upstream&&upstreamUrl&&<p><a href={upstreamUrl} target="_blank" rel="noreferrer">{t('market.catalog.official.openUpstream')}</a> · {t('market.catalog.official.commit',{commit:upstream.commit.slice(0,12)})}</p>}
      {upstream&&derivation?<MarketDerivativeChanges derivation={derivation} repository={upstream.repository} commit={upstream.commit}/>:<><p>{t('market.catalog.official.modifications')}</p>
      {entry.modifications.length?<ul>{entry.modifications.map((change,index)=><li key={index}>{catalogText(change,locale)}</li>)}</ul>:<p>{t('market.catalog.official.noModifications')}</p>}</>}
      <SecretGroupDetails group={item.secretGroup} entryId={entry.id}/>
      {entry.compatibility.conditions.length>0&&<ul>{entry.compatibility.conditions.map((condition,index)=><li key={index}>{catalogText(condition,locale)}</li>)}</ul>}
      <p>{entry.requires.tools.length?t('market.catalog.official.tools',{tools:entry.requires.tools.join(', ')}):t('market.catalog.official.noTools')} · {entry.requires.network?t('market.catalog.official.networkYes'):t('market.catalog.official.networkNo')}</p>
      <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
      <p className={css.mono}>{entry.id}@{entry.version}{upstream?' · '+upstream.commit:''}</p>
      {feedback}
     </details>
    </li>
   }
   if(entry.kind==='role'){
    // 本次会话的回执优先；否则按列表回显的已建岗位初始化为「已添加」
    const receipt=roleReceipts?.[entry.id]??(item.addedRoleId?{roleId:item.addedRoleId,status:'existing' as const}:undefined)
    return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
     <div className={css.top}><h3 className={css.name}>{catalogText(entry.role.title,locale)}</h3><span className={css.badge}>{t(compatibilityKeys[entry.compatibility.status])}</span>{installsBadge}<span className={css.badge}>{t('market.catalog.official.roleBadge')}</span></div>
     <p className={css.summary}>{catalogText(entry.role.summary,locale)}</p>
     <p className={css.meta}>{t('market.catalog.official.roleFromSolution',{packageId:entry.role.fromSolution.packageId,version:entry.role.fromSolution.version})}</p>
     <p className={css.meta}>{t('market.catalog.official.roleSkills',{skills:entry.role.skills.length?entry.role.skills.join(', '):'—'})}{entry.role.skills.length>0&&<> · {t('market.catalog.official.roleSkillsHint')}</>}</p>
     <div className={css.actions}>{receipt?<><span>{t(receipt.status==='created'?'market.catalog.official.roleCreated':'market.catalog.official.roleExisting')}</span>{openRole&&<button type="button" onClick={()=>openRole(receipt.roleId)}>{t('market.catalog.official.view')}</button>}</>:entry.compatibility.status==='unsupported'?<span>{entry.compatibility.conditions[0]?catalogText(entry.compatibility.conditions[0],locale):t('market.catalog.official.unsupportedFallback')}</span>:<button type="button" className={css.primary} disabled={busy!==undefined} onClick={()=>addRole?.(item)}>{busy===entry.id?t('market.catalog.official.adding'):t('market.catalog.official.addRole')}</button>}</div>
     {errorNode}
     <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
      <p>{entry.role.definition.duty}</p>
      <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
      <p className={css.mono}>{entry.id}@{entry.version}</p>
      {feedback}
     </details>
    </li>
   }
   if(entry.kind==='model'){
    if(entry.model.form==='local-specialist'){
     const embedding=entry.model.usage.some(usage=>usage==='embedding')&&entry.model.native.kind==='teloa-embedding'
     const prepare=embedding?(openRetrievalModel?()=>openRetrievalModel(entry.id,entry.version):undefined):openLocalModel
     return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
      <div className={css.top}><h3 className={css.name}>{catalogText(entry.model.title,locale)}</h3><span className={css.badge}>{t(embedding?'retrieval.resources.title':'market.catalog.official.localModelBadge')}</span>{entry.model.support==='experimental'&&<span className={css.badge}>{t('market.catalog.official.modelExperimental')}</span>}</div>
      <p className={css.summary}>{catalogText(entry.model.summary,locale)}</p>
      <p className={css.meta}>{t('market.catalog.official.localModelHost')}</p>
      {entry.model.license.tier==='restricted'&&<p className={css.error} role="note">{entry.model.license.restrictions.map(item=>catalogText(item,locale)).join(' ')}</p>}
      <p className={css.meta}>{t(embedding?'retrieval.model.summary':'market.catalog.official.localModelEnable')}</p>
      {entry.compatibility.status!=='unsupported'&&prepare&&<div className={css.actions}><button type="button" className={css.primary} onClick={prepare}>{t(embedding?'retrieval.model.prepare':'market.catalog.official.localModelPrepare')}</button></div>}
      <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
       {entry.model.notes.map((note,index)=><p key={index}>{catalogText(note,locale)}</p>)}
       {entry.compatibility.conditions.map((note,index)=><p key={index}>{catalogText(note,locale)}</p>)}
       <p><a href={entry.model.license.url} target="_blank" rel="noreferrer">{entry.model.license.name}</a></p>
       <p className={css.mono}>{entry.id}@{entry.version}</p>
       {feedback}
      </details>
     </li>
    }
    const reachKey=entry.model.cnReachable==='direct'?'market.catalog.official.modelReachDirect' as const:entry.model.cnReachable==='mirror'?'market.catalog.official.modelReachMirror' as const:'market.catalog.official.modelReachProxy' as const
    const cloud=entry.model.form==='cloud'?entry.model.cloud:null
    const priceKey=cloud?.priceBand==='low'?'market.catalog.official.modelPriceLow' as const:cloud?.priceBand==='mid'?'market.catalog.official.modelPriceMid' as const:cloud?.priceBand==='high'?'market.catalog.official.modelPriceHigh' as const:'market.catalog.official.modelPriceVaries' as const
    const provider=cloud?.provider??null
    const modelIds=entry.model.form==='cloud'?entry.model.cloud.models.map(model=>model.id):entry.model.variants.map(variant=>variant.sources[0].name)
    return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
     <div className={css.top}><h3 className={css.name}>{catalogText(entry.model.title,locale)}</h3><span className={css.badge}>{t('market.catalog.official.modelBadge')}</span><span className={css.badge}>{t(cloud?reachKey:'market.catalog.official.modelLocalBadge')}</span>{entry.model.support==='experimental'&&<span className={css.badge}>{t('market.catalog.official.modelExperimental')}</span>}</div>
     <p className={css.summary}>{catalogText(entry.model.summary,locale)}</p>
     {entry.model.license.tier==='restricted'&&<p className={css.error} role="note"><strong>{t('market.catalog.official.modelRestricted')}</strong> {entry.model.license.restrictions.map(item=>catalogText(item,locale)).join(' ')}</p>}
     {entry.model.form==='cloud'?<p className={css.meta}>{t(priceKey)} · {modelIds.join(', ')}</p>:entry.model.variants.map((variant,i)=><p key={i} className={css.meta}>{variant.sources[0].name} · {t('market.catalog.official.modelLocalVariant',{quant:variant.quant,size:formatBytes(variant.sizeBytes),min:variant.hardware.minRamGb,rec:variant.hardware.recommendedRamGb})}</p>)}
     {!cloud&&openLocalModels&&<div className={css.actions}><button type="button" className={css.primary} onClick={()=>openLocalModels(entry.id)}>{t('market.catalog.official.modelLocalOpen')}</button></div>}
     {cloud&&openModels&&<div className={css.actions}><button type="button" className={css.primary} onClick={openModels}>{t('market.catalog.official.modelConfigure')}</button></div>}
     <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
      <p>{provider===null?'Ollama':provider.kind==='pi-ai'?'pi-ai '+provider.id:provider.api+' · '+provider.baseURL}</p>
      <p><a href={entry.model.license.url} target="_blank" rel="noreferrer">{entry.model.license.name}</a> · {t(entry.model.license.tier==='commercial'?'market.catalog.official.modelTierCommercial':'market.catalog.official.modelTierRestricted')}</p>
      <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
      <p className={css.mono}>{entry.id}@{entry.version}</p>
      {feedback}
     </details>
    </li>
   }
   if(entry.kind==='solution') return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
    <div className={css.top}><h3 className={css.name}>{catalogText(entry.solution.title,locale)}</h3><span className={css.badge}>{t(compatibilityKeys[entry.compatibility.status])}</span>{installsBadge}<span className={css.badge}>{t('market.catalog.official.solutionBadge')}</span></div>
    <p className={css.summary}>{catalogText(entry.solution.summary,locale)}</p>
    {(['now','needs','permissions'] as const).map(group=><div key={group}><strong>{t(capabilityGroupKeys[group])}</strong><ul>{entry.solution.capabilities[group].slice(0,2).map((cap,i)=><li key={i}>{catalogText(cap,locale)}</li>)}</ul></div>)}
    {actions}{errorNode}
    <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
     <p>{t('market.catalog.official.modifications')}</p>
     {entry.modifications.length?<ul>{entry.modifications.map((change,index)=><li key={index}>{catalogText(change,locale)}</li>)}</ul>:<p>{t('market.catalog.official.noModifications')}</p>}
     {entry.compatibility.conditions.length>0&&<ul>{entry.compatibility.conditions.map((condition,index)=><li key={index}>{catalogText(condition,locale)}</li>)}</ul>}
     <p>{entry.requires.tools.length?t('market.catalog.official.tools',{tools:entry.requires.tools.join(', ')}):t('market.catalog.official.noTools')} · {entry.requires.network?t('market.catalog.official.networkYes'):t('market.catalog.official.networkNo')}</p>
     <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
     <p className={css.mono}>{entry.id}@{entry.version}</p>
     {feedback}
    </details>
   </li>
   if(entry.kind==='dashboard') return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
    <div className={css.top}><h3 className={css.name}>{catalogText(entry.dashboard.title,locale)}</h3><span className={css.badge}>{t(compatibilityKeys[entry.compatibility.status])}</span>{installsBadge}<span className={css.badge}>{t('market.presentation.category.dashboard')}</span></div>
    <p className={css.summary}>{catalogText(entry.dashboard.summary,locale)}</p>
    {(['now','needs','permissions'] as const).map(group=><div key={group}><strong>{t(capabilityGroupKeys[group])}</strong><ul>{entry.dashboard.capabilities[group].slice(0,2).map((cap,i)=><li key={i}>{catalogText(cap,locale)}</li>)}</ul></div>)}
    {actions}{errorNode}
    <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
     <p>{t('market.catalog.official.modifications')}</p>
     {entry.modifications.length?<ul>{entry.modifications.map((change,index)=><li key={index}>{catalogText(change,locale)}</li>)}</ul>:<p>{t('market.catalog.official.noModifications')}</p>}
     {entry.compatibility.conditions.length>0&&<ul>{entry.compatibility.conditions.map((condition,index)=><li key={index}>{catalogText(condition,locale)}</li>)}</ul>}
     <p>{entry.requires.tools.length?t('market.catalog.official.tools',{tools:entry.requires.tools.join(', ')}):t('market.catalog.official.noTools')} · {entry.requires.network?t('market.catalog.official.networkYes'):t('market.catalog.official.networkNo')}</p>
     <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
     <p className={css.mono}>{entry.id}@{entry.version}</p>
     {feedback}
    </details>
   </li>
   const authBadgeKey=entry.connector.auth.kind==='none'?'market.catalog.official.connectorAuthNone' as const:entry.connector.auth.kind==='oauth'?'market.catalog.official.connectorAuthOAuth' as const:'market.catalog.official.connectorAuthSecret' as const
   const previewTools=entry.connector.tools.slice(0,3)
   const connectorActions=!item.addedContentId&&oauthAllowlistBlocked(entry.connector.auth)?<div className={css.actions}><span>{t('market.catalog.connector.oauthErrorAllowlist')}</span></div>:actions
   return <li key={entry.id} className={css.card} data-teloa-catalog-entry={entry.id}>
    <div className={css.top}><h3 className={css.name}>{catalogText(entry.connector.title,locale)}</h3><span className={css.badge}>{t(compatibilityKeys[entry.compatibility.status])}</span>{installsBadge}<span className={css.badge}>{t('market.catalog.official.connectorBadge')}</span><span className={css.badge}>{t(authBadgeKey)}</span></div>
    <p className={css.summary}>{catalogText(entry.connector.summary,locale)}</p>
    {oauthFullAccessToken(entry.connector.auth)&&<p className={css.error} role="note">{t('market.catalog.connector.oauthFullAccess')}</p>}
    {previewTools.length>0&&<ul>{previewTools.map(tool=><li key={tool.name}>{catalogText(tool.description,locale)}</li>)}</ul>}
    {connectorActions}{errorNode}
    <details className={css.details}><summary>{t('market.catalog.official.sourceDetails')}</summary>
     {entry.compatibility.conditions.length>0&&<ul>{entry.compatibility.conditions.map((condition,index)=><li key={index}>{catalogText(condition,locale)}</li>)}</ul>}
     <p>{entry.requires.network?t('market.catalog.official.networkYes'):t('market.catalog.official.networkNo')}</p>
     <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})}</p>
     <p className={css.mono}>{entry.id}@{entry.version} · {entry.connector.serverName}</p>
     {feedback}
    </details>
   </li>
  })() as ReactElement<{children?:ReactNode}>,<><CatalogAlternativeLinks entry={item.entry} items={catalogItems} openEntry={openEntry}/>{reviewSlot?.(item.entry)}</>))}</ul>:<p className={css.status}>{t('market.catalog.official.empty')}</p>
}

/** 官方方案产品页的方案包读取状态：读取中、读取失败（可重试）、已读到清单与只读接入源。 */
export type CatalogSolutionPackageState={status:'loading'}|{status:'failed'}|({status:'ready'}&MarketCatalogSolutionPackage)

/**
 * 官方方案详情 = 原型 `市场方案.jsx` 的产品页：hero（插画、标题、一句话、一个主按钮）→「添加后你会得到」七行 → 小字折叠「来源与版本」。
 * 七行与本机方案产品页同一套算法与词条（composeFromManifest / COMPOSITION_ROWS / solutionRowResources），数据是宿主从随发行固定的方案包清单读出的；
 * 读不到时只给一句白话说明，不出空标题。目录条目自带的「现在可做 / 还需你提供 / 会请求的权限」与使用条件全部收进「来源与版本」。
 */
export function CatalogSolutionProduct({item,pkg,busy,error,add,open,back,retry,after,team,ask}:{item:MarketCatalogItem;pkg:CatalogSolutionPackageState;busy:string|undefined;error?:string|undefined;add:()=>void;open:(contentId:string)=>void;back:()=>void;retry:()=>void;after?:ReactNode;team?:{loaded:boolean;links?:ReactNode;panel:ReactNode;addToTeam:()=>void}|undefined;ask?:{busy:boolean;run:()=>void}|undefined}){
 const {t,locale,number}=useI18n()
 const entry=item.entry
 if(entry.kind!=='solution')return null
 const title=catalogText(entry.solution.title,locale)
 const conditions=entry.compatibility.conditions.map(condition=>catalogText(condition,locale))
 // 接上团队步骤时照原型只有一个主按钮「添加到我的团队」：加到本机与团队确认合成一步；没接时（单独使用）退回「添加方案」
 const action=team
  ?team.loaded
   ?<><button type="button" className={pageCss.primaryAction} disabled>{t('market.solution.added')}<Check size={15}/></button>{team.links}</>
   :entry.compatibility.status==='unsupported'
    ?<p>{conditions[0]??t('market.catalog.official.unsupportedFallback')}</p>
    :<button type="button" className={pageCss.primaryAction} disabled={busy!==undefined} aria-expanded={!!team.panel} onClick={team.addToTeam}>{busy===entry.id?t('market.catalog.official.adding'):t('market.industry.loadWorkspace')}<Plus size={15}/></button>
  :item.addedContentId
  ?<><button type="button" className={pageCss.primaryAction} disabled>{t('market.catalog.official.added')}<Check size={15}/></button><button type="button" onClick={()=>open(item.addedContentId!)}>{t('market.catalog.official.view')}</button></>
  :entry.compatibility.status==='unsupported'
   ?<p>{conditions[0]??t('market.catalog.official.unsupportedFallback')}</p>
   :<button type="button" className={pageCss.primaryAction} disabled={busy!==undefined} onClick={add}>{busy===entry.id?t('market.catalog.official.adding'):t('market.catalog.official.addSolution')}<Plus size={15}/></button>
 const rows=pkg.status==='ready'?composeFromManifest(pkg.manifest):[]
 const capabilities=(['now','needs','permissions'] as const).map(group=>[t(capabilityGroupKeys[group]),entry.solution.capabilities[group].map(value=>catalogText(value,locale))] as const)
 return <article className={clsx(pageCss.detail,pageCss.industryDetail)} data-teloa-catalog-entry={entry.id} aria-label={title}>
  <button type="button" className={css.backLink} onClick={back}><ArrowLeft size={15}/>{t('market.solution.back')}</button>
  <header className={pageCss.solutionHero}>
   <span className={clsx(pageCss.bundleArt,pageCss.heroArt,staffCss['tone'+staffAvatarSeed(entry.id).tone])} aria-hidden="true"><span/><span/><span/></span>
   <h1 tabIndex={-1} data-catalog-detail-title>{title}</h1>
   <p>{catalogText(entry.solution.summary,locale)}</p>
   {action}
   {ask&&<button type="button" disabled={ask.busy||pkg.status!=='ready'} onClick={ask.run}><MessageSquare size={13}/>{t('market.solution.askFit')}</button>}
  </header>
  {error&&<p className={css.error} role="alert">{error}</p>}
  {team?.panel}
  {!team?.panel&&pkg.status==='loading'&&<p className={css.status} role="status">{t('market.catalog.solution.loading')}</p>}
  {!team?.panel&&pkg.status==='failed'&&<p className={css.error} role="alert">{t('market.catalog.solution.unavailable')}<button type="button" onClick={retry}>{t('market.catalog.official.retry')}</button></p>}
  {!team?.panel&&pkg.status==='ready'&&rows.length>0&&<>
   <h2>{t('market.solution.youGet')}</h2>
   <div className={pageCss.youGet}>{rows.map(row=>{
    const meta=COMPOSITION_ROWS.find(value=>value.id===row.id)!
    const note=row.id==='method'?compositionMethodNote(row.detail,t,number):row.id==='extension'?t(COMPOSITION_EXTENSION_NOTE_KEY):''
    return <div key={row.id}>
     <h3>{t(meta.label)}<em className={pageCss.solutionGroupQuestion}>{t(meta.question)}</em><span className={pageCss.solutionGroupCount}>{row.detail?.configurations?t('market.dashboard.count',{count:number(row.detail.configurations)}):t(meta.unit,{count:number(row.count),views:number(row.detail?.views??0)})}</span></h3>
     {row.id==='staff'
      ?<div className={pageCss.memberCards}>{solutionMembers(pkg.manifest,locale,pkg.manifest.id).map(member=><span key={member.id}><StaffAvatar initial={member.initial} seed={member.seed} size="md"/><strong>{member.title}</strong></span>)}</div>
      :<ul>{solutionRowResources(pkg.manifest,row.id,locale).map(resource=>{
       // 只读判定来自宿主按 mcpConnectionReadOnly 的结果（与本机方案页同一口径）；判定不了的连接仍按保守口径
       const label=row.id==='source'?connectorModeLabel(sourceConnectorMode(resource,pkg.readOnlyResources)??{},t):undefined
       return <li key={resource.id}><Check size={13} aria-hidden="true"/><span>{resource.title}</span>{label&&<small className={pageCss.solutionResourceType}>{label}</small>}</li>
      })}</ul>}
     {note&&<p className={pageCss.solutionGroupNote}>{note}</p>}
    </div>
   })}</div>
  </>}
  <details className={pageCss.provenance}>
   <summary>{t('market.solution.provenance')}</summary>
   <dl>
    <dt>{t('market.catalog.source')}</dt><dd>{t('market.catalog.solution.source',{license:entry.license.spdx})}</dd>
    <dt>{t('market.catalog.solution.version')}</dt><dd>v{entry.version}</dd>
    <dt>{t('market.catalog.solution.conditions')}</dt><dd>{t(compatibilityKeys[entry.compatibility.status])}{conditions.length>0&&<ul>{conditions.map((value,index)=><li key={index}>{value}</li>)}</ul>}</dd>
    {capabilities.map(([label,values])=><Fragment key={label}><dt>{label}</dt><dd><ul>{values.map((value,index)=><li key={index}>{value}</li>)}</ul></dd></Fragment>)}
   </dl>
   <p>{t('market.solution.provenance.notice')}</p>
   <p>{t('market.catalog.official.reviewed',{date:entry.review.reviewedAt})} · <span className={css.mono}>{entry.id}@{entry.version}</span></p>
   <MarketResourceFeedback entry={entry}/>
  </details>
  {after}
 </article>
}

// 资源反馈草稿只留在本进程：按条目 id 缓存模型，卡片重绘、关闭再开都沿用同一草稿；条目换了版本才换新模型。
const resourceFeedbackModels=new Map<string,TeloaFeedbackModel>()

/** 条目「来源详情」末尾的「问题反馈」：弹出应用内反馈表单，提交时带上资源标识、版本与应用版本（规格 D17）。
 * `send` 只供测试替换：给了 `send` 的模型只留在本组件，不进进程级缓存，免得替身串到其他挂载。 */
export function MarketResourceFeedback({entry,send}:{entry:MarketCatalogEntry;send?:((payload:FeedbackPayload)=>Promise<FeedbackResult>)|undefined}){
 const {t,locale}=useI18n()
 const [model,setModel]=useState<TeloaFeedbackModel>()
 const own=useRef<TeloaFeedbackModel|undefined>(undefined)
 const open=()=>{
  let cached=send===undefined?resourceFeedbackModels.get(entry.id):own.current
  if(cached?.resource?.entryId!==entry.id||cached.resource.version!==entry.version){
   cached=new TeloaFeedbackModel(send,__TELOA_VERSION__,{entryId:entry.id,version:entry.version})
   if(send===undefined)resourceFeedbackModels.set(entry.id,cached)
   else own.current=cached
  }
  setModel(cached)
 }
 return <>
  <p><button type="button" aria-haspopup="dialog" onClick={open}>{t('market.catalog.official.reportProblem')}</button></p>
  {model&&<TeloaFeedbackForm model={model} resourceTitle={catalogText(catalogEntryTitle(entry),locale)} onClose={()=>setModel(undefined)}/>}
 </>
}

/** 共享密钥组（规格 2026-09-28 D18）：卡片一行写与几个技能共用；组内只有自身（其余成员未收录）时不显示。 */
function SecretGroupLine({group,entryId}:{group:MarketCatalogItem['secretGroup'];entryId:string}){
 const {t,number}=useI18n()
 const others=group?.members.filter(member=>member.entryId!==entryId).length??0
 return others>0?<p className={css.meta}>{t(others===1?'market.catalog.secretGroup.cardOne':'market.catalog.secretGroup.cardMany',{count:number(others)})}</p>:null
}
/** 来源详情里列出同组其余技能（不含自身，与卡片的 N 一致；按 entryId 升序）并说明填写与删除都作用于整组；没有其余成员不显示。 */
function SecretGroupDetails({group,entryId}:{group:MarketCatalogItem['secretGroup'];entryId:string}){
 const {t,locale,list}=useI18n()
 const others=group?.members.filter(member=>member.entryId!==entryId)??[]
 if(!others.length)return null
 return <>
  <p>{t('market.catalog.secretGroup.members',{skills:list(others.map(member=>catalogText(member.title,locale)))})}</p>
  <p>{t('market.catalog.secretGroup.note')}</p>
 </>
}

/** 推荐入口只查看目录详情，不添加、安装或连接。 */
function CatalogAlternativeLinks({entry,items,openEntry}:{entry:MarketCatalogEntry;items:readonly MarketCatalogItem[];openEntry:MarketCatalogCardsProps['openEntry']}){
 const {t,locale}=useI18n()
 const alternatives=catalogAlternatives(entry,items)
 if(!alternatives.length||!openEntry)return null
 return <div className={css.alternatives} role="group" aria-label={t('market.catalog.official.alternativesTitle')}>
  <span>{t('market.catalog.official.alternativesTitle')}</span>
  {alternatives.map(({item,recommended})=><button key={item.entry.id} type="button" data-catalog-origin={entry.id} data-catalog-target={item.entry.id} onClick={()=>openEntry(item.entry.id,entry.id)}>{t(recommended?'market.catalog.official.alternativeRecommended':'market.catalog.official.alternativeOpen',{title:catalogText(catalogEntryTitle(item.entry),locale)})}</button>)}
 </div>
}
