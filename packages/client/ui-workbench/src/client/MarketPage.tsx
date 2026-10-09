import {BusinessDashboardUpgradePanel} from './BusinessDashboardUpgradePanel.js'
import {BusinessDashboardMarketPanel} from './BusinessDashboardMarketPanel.js'
import type {BusinessDashboardResourceApi} from './business-dashboard-resource-api.js'
import {LocalRetrievalModelPanel} from './LocalRetrievalModelPanel.js'
import type {LocalRetrievalApi} from './local-retrieval-api.js'
import {isIndustryManifest} from './industry-manifest.ts'
import type {SkillUpgradeApi} from './skill-upgrade-api.js'
import type {SkillAvailabilityApi} from './skill-availability-api.js'
import { AtomicSkillImport } from './AtomicSkillImport.js'
import { MarketResourceCatalog, emptyMarketResourceFilters, type MarketResourceFilters } from './MarketResourceCatalog.js'
import { IndustryExport } from './IndustryExport.js'
import { IndustryUpdatePreview, type IndustryReviewProps } from './IndustryUpdatePreview.js'
import { IndustryReferences } from './IndustryReferences.js'
import { IndustryLoadForm } from './IndustryLoadForm.js'
import type { IndustryLoadApi,IndustryLoadCreateInput,IndustryLoadRecord } from './industry-load-api.js'
import type { BusinessScopeLabel,BusinessSpaceRecord } from './business-directory.js'
import { IndustryContents } from './IndustryContents.js'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowLeft, Check, ChevronRight, Download, MessageSquare, Plus, Search } from 'lucide-react'
import { builtinSolutionCatalog, filterMarket, marketVisibility, saveMarketIntent, sourceLabel, type MarketIntent, type MarketItem, type MarketState } from './market-preview.js'
import { checkMarketTarget, marketTargetKey, marketTargetKinds, type MarketTarget, type MarketTargetRef } from './market-target.js'
import {RealSkillInstallations} from './RealSkillInstallations.js'
import { MarketImportForm, TemplateForm, type TemplateSeed } from './MarketForms.js'
import type {SkillInstallApi} from './skill-install-api.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import type {BundledExtensionsApi} from './bundled-extensions-api.js'
import {BundledExtensionsSection} from './BundledExtensionsSection.js'
import {MarketPluginInstallControl,MarketPluginInstallations} from './MarketPluginInstallations.js'
import {marketPluginInstallSource} from './market-plugin-source.js'
import {marketSkillInstallationSelection} from './market-installation-selection.js'
import {SkillInstallControl} from './SkillInstallControl.js'
import type { MarketContentApi } from './market-content-api.js'
import type {GithubSourceApi} from './github-source-api.js'
import { GuidedSetup } from './GuidedSetup.js'
import { marketPageGuidance } from './market-page-guidance.js'
import {localizedMarketItemCopy,localizedMarketItemDetailCopy,localizedMarketResourceEntryTitle,localizedMarketResourceUseTitle,marketCatalogItemCopy,marketCategoryKind,marketCategoryLabel,marketCategoryOf,marketItemPresentation,marketResourcePresentation,marketVisibilityLabel,restoredMarketCategory,showMarketGuide,visibleMarketCategories,type MarketCategory} from './market-home-presentation.js'
import { ItemArt, SolutionCards, StateMark } from './SolutionCards.js'
import {currentSolutionCatalog,localReadOnlyConnections,marketItemMark,marketResourceMark,solutionInstalled,solutionInstalledCount,solutionMark,solutionMembers,solutionRowResources} from './market-solution-presentation.js'
import {COMPOSITION_EXTENSION_NOTE_KEY,COMPOSITION_ROWS,composeFromManifest,compositionMethodNote,compositionSummary,connectorModeLabel,sourceConnectorMode} from './industry-composition.js'
import {StaffAvatar} from './StaffAvatar.js'
import {staffAvatarSeed} from './staff-avatar-seed.js'
import {loadMarketSkillRuntime,type MarketSkillRuntime} from './market-runtime-state.js'
import { useDirectoryFocus } from './directory-focus.js'
import {useDismissible} from './use-dismissible.js'
import {filterMarketResources,marketResourceIndex} from './market-resource-index.js'
import {filterTaxonomyRows,marketItemTaxonomy,resourceEntryTaxonomy,type TaxonomyFilter} from './market-taxonomy-filter.js'
import {MarketEmpty,MarketFilterBar,MarketResultLine,type MarketListRow} from './MarketUnifiedList.js'
import base from './TaskPage.module.css'
import staffCss from './StaffAvatar.module.css'
import { useI18n } from './i18n/provider.js'
import { MarketCatalogSection, type CatalogSolutionTeam } from './MarketCatalogSection.js'
import { loadCatalogListing, type MarketCatalogApi } from './market-catalog-api.js'
import {McpConnectionView} from './McpConnectionView.js'
import type {ManagedMcpConnectionApi} from './mcp-connections-api.js'
import {SkillSecretsView} from './SkillSecretsView.js'
import type {SkillSecretsApi} from './skill-secrets-api.js'
import type {MarketCatalogConnectorEntry,MarketCatalogListCounts} from '@teloa/contract'
import { useBusinessScopes } from './business-scope-context.js'
import type {TeloaTranslate} from './i18n/index.js'
import {localizeWorkError} from './i18n/errors.js'
import {marketTargetCheckLabel,marketTargetKindLabel} from './i18n/market-target.js'
import {marketCountText} from './i18n/market-count.js'
import css from './MarketPage.module.css'

type MarketMaintenanceProps={visible:boolean;selected:string|null;open:(id?:string)=>void;market:(id?:string)=>void}
export type MarketPageNavigationState={category:MarketCategory|'home'|'intents';query:string;selectedId:string|undefined;mobileLayer:'category'|'list'|'detail'}
export type MarketProps={inCapabilityCenter?:boolean;refreshScopes?:(()=>Promise<unknown>)|undefined;dashboardResources?:BusinessDashboardResourceApi|undefined;colorScheme?:'light'|'dark'|undefined;openBusiness?:((scope:string)=>void)|undefined;localRetrievalApi?:LocalRetrievalApi|undefined;marketCatalogApi?:MarketCatalogApi;managedMcpConnectionApi?:ManagedMcpConnectionApi;skillSecretsApi?:SkillSecretsApi;githubSourceApi:GithubSourceApi;skillInstallApi:SkillInstallApi;marketPluginInstallApi:MarketPluginInstallApi;bundledExtensionsApi?:BundledExtensionsApi;skillAvailabilityApi?:SkillAvailabilityApi;skillUpgradeApi?:SkillUpgradeApi;contentApi?:MarketContentApi;industryLoads:{api:IndustryLoadApi;loads:readonly IndustryLoadRecord[];error:string|undefined;save:(input:IndustryLoadCreateInput)=>Promise<void>;recover:()=>Promise<void>};industryReview:IndustryReviewProps;saveResolved:(item:MarketItem)=>void;spaces:readonly BusinessScopeLabel[];space?:BusinessSpaceRecord;planFromTemplate:(item:MarketItem)=>void;manageIndustryLoad:(loadId:string)=>void;installations:MarketMaintenanceProps;industryResources?:ReactNode;visible:boolean;state:MarketState;itemId:string|null;intentId:string|null;open:(itemId?:string,intentId?:string)=>void;change:(state:MarketState)=>void;update:(id:string,version:number,purpose:string,visibility:'personal'|'team',withdraw?:boolean)=>void;prepare:(item:MarketItem,draft?:MarketIntent)=>Promise<void>;capabilities:()=>void;nativeSettings:()=>void;nativeModels:()=>void;openLocalModels?:(entryId:string)=>void;openLocalModel?:()=>void;openRole:(roleId:string)=>void;seed:TemplateSeed|null;clearSeed:()=>void;forceCategory?:{category:MarketCategory|'home';serial:number};catalogEntryRequest?:{catalogId:string;serial:number};configureBinding:(intentId:string)=>void;targets:MarketTarget[];openTarget:(target:MarketTargetRef)=>void;navigationState?:Partial<MarketPageNavigationState>;onNavigationChange?:(state:MarketPageNavigationState)=>void;onCatalogReady?:(availableIds:string[])=>void}
export function MarketPage(props:MarketProps){
  const {t}=useI18n()
  const [installationQuery,setInstallationQuery]=useState(''),[installationFilter,setInstallationFilter]=useState<'all'|'installed'|'preparing'>('all')
  const [runtimeRevision,setRuntimeRevision]=useState(0)
  const [runtime,setRuntime]=useState<MarketSkillRuntime>({state:'loading',facts:[]})
  const selected=props.installations.selected
  const mode=selected?.startsWith('plugin:')?'plugins':'skills'
  useEffect(()=>{
    if(!props.visible||props.installations.visible)return
    let active=true
    setRuntime(current=>current.facts.length?current:{state:'loading',facts:[]})
    void loadMarketSkillRuntime(props.skillInstallApi,props.skillAvailabilityApi).then(value=>{if(active)setRuntime(value)})
    return()=>{active=false}
  },[props.visible,props.installations.visible,props.skillInstallApi,props.skillAvailabilityApi,runtimeRevision])
  return <>{props.visible&&props.industryResources&&<section className={clsx(base.page,css.page,props.inCapabilityCenter&&css.center)} aria-label={t('market.workspace.aria')}><div className={css.content}><div className={css.container}>{props.industryResources}</div></div></section>}{props.visible&&props.installations.visible&&<section className={clsx(base.page,css.page,props.inCapabilityCenter&&css.center)} aria-label={t('market.installation.title')}><nav className={clsx(css.categories,css.maintenanceTabs)} aria-label={t('market.installation.categoryAria')}><button type="button" aria-current={mode==='skills'?'page':undefined} onClick={()=>props.installations.open('skill:directory')}>{t('market.installation.installedSkills')}</button><button type="button" aria-current={mode==='plugins'?'page':undefined} onClick={()=>props.installations.open('plugin:directory')}>{t('market.plugin.install.title')}</button></nav><div className={css.maintenanceBody}>{mode==='plugins'?<MarketPluginInstallations api={props.marketPluginInstallApi} selected={selected?.startsWith('plugin:')&&selected!=='plugin:directory'?selected.slice(7):null} select={id=>props.installations.open(id?'plugin:'+id:'plugin:directory')} onBrowse={()=>props.installations.market(props.itemId??undefined)}/>:<RealSkillInstallations {...(props.skillUpgradeApi?{upgradeApi:props.skillUpgradeApi}:{})} {...(props.contentApi?{marketContentApi:props.contentApi}:{})} {...(props.skillAvailabilityApi?{availabilityApi:props.skillAvailabilityApi}:{})} filters={{query:installationQuery,filter:installationFilter,change:(query,filter)=>{setInstallationQuery(query);setInstallationFilter(filter)}}} api={props.skillInstallApi} selected={marketSkillInstallationSelection(selected)} select={id=>props.installations.open(id?'skill:'+id:'skill:directory')} onBrowse={()=>props.installations.market(props.itemId??undefined)}/>}</div></section>}{!props.industryResources&&<MarketCatalog {...props} runtime={runtime} runtimeChanged={()=>setRuntimeRevision(value=>value+1)}/>}</>
}
const categoryResourceKinds:Partial<Record<MarketCategory,Array<'role'|'skill'|'knowledge'|'mcp'|'plugin'|'data-source'|'execution-tool'>>>={
  agent:['role'],skill:['skill'],plugin:['plugin'],connector:['mcp','data-source','execution-tool'],knowledge:['knowledge'],model:[],
}

// 通用目录卡与方案卡同一套语汇：状态用 StateMark 记号，不再摆「方案 · Teloa 生态」这类系统词与状态句。
// 记号由 marketItemMark 统一判：方案看加载记录，技能看实测安装状态，扩展一律「需重启」。
// 版面照原型 `市场方案.jsx:83` 的 ItemCard 单列列表：一行一条，适用范围与来源并进行内第二行，不再各占一列。
function MarketCards({items,loads,runtime,selectedId,open}:{items:readonly MarketItem[];loads:readonly IndustryLoadRecord[];runtime:MarketSkillRuntime;selectedId:string|undefined;open:(id:string)=>void}){
  const {locale,t}=useI18n()
  return <div className={css.itemList}>{items.map(item=>{const display=marketItemPresentation(item,loads,runtime,t),copy=marketCatalogItemCopy(item,locale);return <button type="button" key={item.id} data-teloa-entry={item.id} className={css.itemCard} aria-label={copy.title} aria-current={selectedId===item.id?'page':undefined} onClick={()=>open(item.id)}><ItemArt kind={marketCategoryOf(item)} title={copy.title} seed={item.id}/><span className={css.itemMain}><strong className={css.resourceTitle}>{copy.title}</strong>{copy.summary&&<span className={css.resourceDescription}>{copy.summary}</span>}<span className={css.resourceFacts}>{display.scope} · {display.source}</span></span><StateMark mark={marketItemMark(item,loads,runtime)} t={t}/><ChevronRight size={16}/></button>})}</div>
}

function MarketCatalog(props:MarketProps&{runtime:MarketSkillRuntime;runtimeChanged?:()=>void}){
  const {locale,t}=useI18n()
  const {contentApi,visible,state,itemId,intentId,open,change,seed,clearSeed,navigationState,onNavigationChange}=props
  const [atomicImport,setAtomicImport]=useState(false)
  const [kind,setKind]=useState<MarketCategory|'home'|'intents'>(navigationState?.category??'home'),[templateTaxonomy,setTemplateTaxonomy]=useState<TaxonomyFilter>({industry:null,fn:null}),[query,setQuery]=useState(navigationState?.query??''),[importMode,setImportMode]=useState<'upload'|'paste'|'github'|'conversation'|null>(null),[template,setTemplate]=useState(false),[error,setError]=useState(''),[recovering,setRecovering]=useState(false),[lastSelectedId,setLastSelectedId]=useState<string|undefined>(navigationState?.selectedId),[resourceDetailOpen,setResourceDetailOpen]=useState(navigationState?.mobileLayer==='detail')
  const [resourceFilters,setResourceFilters]=useState<MarketResourceFilters>(emptyMarketResourceFilters)
  const [retrievalView,setRetrievalView]=useState<{catalogId:string;version:string}|null>(null)
  const [catalogNavigation,setCatalogNavigation]=useState<Array<{kind:'connection';catalogId:string;entry:MarketCatalogConnectorEntry}|{kind:'entry';catalogId:string}>>([])
  const catalogRoute=catalogNavigation.at(-1)
  const openCatalogConnection=(catalogId:string,entry:MarketCatalogConnectorEntry)=>setCatalogNavigation(history=>[...history,{kind:'connection',catalogId,entry}])
  const backCatalog=()=>setCatalogNavigation(history=>history.slice(0,-1))
  const [skillSecretsView,setSkillSecretsView]=useState<{skill:string;title:string}|null>(null)
  const [importMenuOpen,setImportMenuOpen]=useState(false),[createMenuOpen,setCreateMenuOpen]=useState(false)
  // 类别计数由页内目录区块读完目录后经 onCounts 回传，不另发请求
  const [catalogCounts,setCatalogCounts]=useState<MarketCatalogListCounts>()
  // 官方目录停在某条详情上时，本机列表与工具行收起，详情独占正文
  const [catalogDetailOpen,setCatalogDetailOpen]=useState(false)
  const visibleCategories=visibleMarketCategories(catalogCounts)
  const importMenuRef=useRef<HTMLDetailsElement>(null),createMenuRef=useRef<HTMLDetailsElement>(null)
  useDismissible(importMenuRef,importMenuOpen,()=>setImportMenuOpen(false))
  useDismissible(createMenuRef,createMenuOpen,()=>setCreateMenuOpen(false))
  const stateRef=useRef(state),changeRef=useRef(change),catalogReadyRef=useRef(props.onCatalogReady)
  /**
   * 受控页签请求：调用方（如业务台账「再加一类业务」）按 serial 递增表达「这一次要落在哪个页签」。
   * 与 `seed`/`clearSeed` 同一模式——只认新 serial，不干扰用户在市场页里自己切的页签与搜索词。
   */
  const forcedCategorySerial=useRef(props.catalogEntryRequest?undefined:props.forceCategory?.serial)
  useEffect(()=>{
    const forced=props.forceCategory
    if(!forced||forcedCategorySerial.current===forced.serial)return
    forcedCategorySerial.current=forced.serial
    setKind(forced.category)
    setRetrievalView(null)
    setCatalogNavigation([])
    setSkillSecretsView(null)
    setCatalogDetailOpen(false)
    setLastSelectedId(undefined)
    setResourceDetailOpen(false)
    setResourceFilters(emptyMarketResourceFilters)
    setQuery('')
    onNavigationChange?.({category:forced.category,query:'',selectedId:undefined,mobileLayer:'category'})
  },[props.forceCategory?.serial])
  // 官方条目与本机内容 id 分开；同批类别重置先执行，再消费一次详情请求。
  const catalogEntrySerial=useRef<number>()
  useEffect(()=>{
    const request=props.catalogEntryRequest
    if(!visible||!request||catalogEntrySerial.current===request.serial)return
    catalogEntrySerial.current=request.serial
    setRetrievalView(null)
    setSkillSecretsView(null)
    setCatalogNavigation([{kind:'entry',catalogId:request.catalogId}])
  },[visible,props.catalogEntryRequest?.serial])
  stateRef.current=state;changeRef.current=change;catalogReadyRef.current=props.onCatalogReady
  // 市场保留历史版本用于审计，但目录、计数和方案内资源只投影每个模板的当前版本。
  const currentCatalog=currentSolutionCatalog(state.items)
  // 空库兜底：内置行业示例包只经 `pnpm setup:workspace` 写进后端内容库，全新安装时正式目录一条方案都没有。
  // 目录里没有任何方案时改渲染 Teloa 内置清单（标「Teloa 内置示例」），添加仍走既有 IndustryLoadForm 两段式知情同意。
  const builtinSolutions=currentCatalog.some(row=>marketCategoryOf(row)==='industry')?[]:builtinSolutionCatalog()
  // 导入回执、已加载资源与草稿都固定到具体内容；目录去重不能让这些历史来源的详情失效。
  const draft=state.intents.find(item=>item.id===intentId),item=[...state.items,...builtinSolutions].find(item=>item.id===(draft?.itemId||itemId))
  // 旧链接和已保存的 `industry` 筛选仍可恢复，但正式一级只表现为“方案”。
  const allCategory=!!props.inCapabilityCenter&&kind==='home'
  const solutionCategory=(!props.inCapabilityCenter&&kind==='home')||kind==='industry'
  const atomicCategory=solutionCategory||kind==='intents'||kind==='home'?'agent':kind
  const resourceKinds=!allCategory&&!solutionCategory&&kind!=='intents'?categoryResourceKinds[atomicCategory]:undefined
  const resourceSelectedRow=lastSelectedId&&resourceKinds?marketResourceIndex(currentCatalog).find(row=>row.key===lastSelectedId&&resourceKinds.some(kind=>kind===row.kind)):undefined
  const resourceSelectedKey=resourceSelectedRow?.key
  const inlineSelectedId=!item&&resourceDetailOpen&&(!resourceSelectedRow?.itemId||resourceSelectedRow.status==='conflict')?resourceSelectedKey:undefined
  const directoryFocus=useDirectoryFocus(visible,item?.id??inlineSelectedId)
  // 左栏进入市场落在 home：home 与旧链接恢复的 industry 都是「方案」页签；搜索仍只在方案中查找。
  // solutionView 是「正文就是方案卡」这一件事的唯一判据：页签高亮、窄屏分层、内容分支三处共用，不许各算各的。
  const solutionLanding=solutionCategory&&!query
  const solutionView=solutionLanding
  const mobileLayer:MarketPageNavigationState['mobileLayer']=item||inlineSelectedId?'detail':solutionView?'category':'list'
  const rememberNavigation=(patch:Partial<MarketPageNavigationState>)=>onNavigationChange?.({category:kind,query,selectedId:lastSelectedId,mobileLayer,...patch})
  useEffect(()=>{if(item?.id&&!resourceSelectedKey){setLastSelectedId(item.id);rememberNavigation({selectedId:item.id,mobileLayer:'detail'})}},[item?.id,resourceSelectedKey])
  const merge=(incoming:MarketItem[])=>{
    const current=stateRef.current,next=[...current.items]
    for(const row of incoming){const index=next.findIndex(item=>item.contentStorage?.contentId===row.contentStorage?.contentId||item.id===row.id);if(index<0)next.push(row);else if(!next[index]?.contentStorage?.loaded)next[index]=row}
    changeRef.current({...current,items:next})
    return next
  }
  useEffect(()=>{
    if(!visible||!contentApi)return
    let active=true
    void contentApi.list().then(rows=>{if(active){const next=merge(rows);catalogReadyRef.current?.(next.map(item=>item.id))}},()=>{if(active)setError(t('market.content.directoryReadFailed'))})
    return()=>{active=false}
  },[visible,contentApi])
  useEffect(()=>{
    const storage=item?.contentStorage;if(!visible||!contentApi||!storage||storage.loaded)return
    let active=true
    void contentApi.hydrate(item).then(row=>{if(active)merge([row])},()=>{if(active)setError(t('market.content.detailReadFailed'))})
    return()=>{active=false}
  },[visible,contentApi,item?.contentStorage?.contentId,item?.contentStorage?.loaded])
  // Hook 与其依赖的 selectKind 须在下方提前 return 之前，否则 visible 切换时 Hook 数量变化（React #310）
  const selectKind=(next:MarketCategory|'home'|'intents')=>{const normalized=!props.inCapabilityCenter&&next==='industry'?'home':next;setKind(normalized);setCatalogNavigation([]);setSkillSecretsView(null);setRetrievalView(null);setCatalogDetailOpen(false);setResourceFilters(emptyMarketResourceFilters);setTemplateTaxonomy({industry:null,fn:null});setLastSelectedId(undefined);setResourceDetailOpen(false);open();setError('');rememberNavigation({category:normalized,selectedId:undefined,mobileLayer:normalized==='home'?'category':'list'})}
  // 导航恢复到 model 而目录已无模型条目时回退首页，不留空白类别页
  useEffect(()=>{if(restoredMarketCategory(kind,catalogCounts)!==kind)selectKind('home')},[kind,catalogCounts])
  // 连接、资料、扩展等页面没有目录区块，计数等不到 onCounts 回传：挂载时补取一次（counts 按全量计算，一条即可），
  // 有目录区块的页面由区块读完目录后回传，不另发请求；读取失败只是暂不显示「模型」，区块页会再报错。
  // 每个类型页签只接同类型的官方目录：方案只列方案、连接只列连接器；资料、任务模板、扩展没有官方条目。
  const catalogKind=kind==='intents'?undefined:marketCategoryKind[solutionCategory?'industry':atomicCategory]
  const catalogSectionShown=!item&&!itemId&&!intentId&&(allCategory||catalogKind!==undefined)
  useEffect(()=>{
    const api=props.marketCatalogApi
    if(!visible||!api||catalogCounts||catalogSectionShown)return
    let active=true
    void api.list({limit:1}).then(value=>{if(active)setCatalogCounts(current=>current??value.counts)},()=>{})
    return()=>{active=false}
  },[visible,props.marketCatalogApi,catalogCounts,catalogSectionShown])
  const openItem=(id:string)=>{setLastSelectedId(id);open(id);rememberNavigation({selectedId:id,mobileLayer:'detail'})}
  // 官方目录添加后重读本人内容，按固定内容 id 打开详情，安装仍由详情里的既有安装控件完成。
  const openCatalogContent=async(contentId:string)=>{
    if(!contentApi)throw Error('teloa/source-unavailable')
    const found=merge(await contentApi.list()).find(row=>row.contentStorage?.contentId===contentId)
    if(!found)throw Error('teloa/source-unavailable')
    openItem(found.id)
  }
  // 官方方案产品页接上本机团队步骤：先加到本机再就地展开同一个团队确认步骤，问答以官方包内容为依据（设计约束）
  const solutionTeam:CatalogSolutionTeam={
    find:contentId=>state.items.find(row=>row.contentStorage?.contentId===contentId),
    installed:value=>solutionInstalled(value,props.industryLoads.loads),
    loadLinks:value=><SolutionLoadLinks loads={props.industryLoads.loads.filter(load=>solutionInstalled(value,[load]))} manage={props.manageIndustryLoad}/>,
    resolve:async contentId=>{
      if(!contentApi)throw Error('teloa/source-unavailable')
      const found=merge(await contentApi.list()).find(row=>row.contentStorage?.contentId===contentId)
      if(!found)throw Error('teloa/source-unavailable')
      return found
    },
    form:(target,close)=><SolutionLoadPanel {...props} item={target} close={close}/>,
    ask:target=>{
      const current=stateRef.current,base=current.items.some(row=>row.id===target.id)?current:{...current,items:[...current.items,target]}
      const id=crypto.randomUUID()
      const next=saveMarketIntent(base,{id,itemId:target.id,scope:target.scope,target:t('market.workspace.current'),purpose:t('market.solution.askFitDraft',{name:marketCatalogItemCopy(target,locale).title}),visibility:'personal',now:new Date().toISOString()})
      change(next)
      const draft=next.intents.find(row=>row.id===id)??next.intents.find(row=>row.itemId===target.id&&row.itemVersion===target.version&&row.status==='draft'&&!row.targetRef)
      return props.prepare(target,draft)
    },
  }
  const catalogActions={
    solutionTeam,
    openRole:props.openRole,openModels:props.nativeModels,openLocalModel:props.openLocalModel,
    ...(props.openLocalModels?{openLocalModels:props.openLocalModels}:{}),
    ...(props.managedMcpConnectionApi?{openConnection:openCatalogConnection}:{}),
    ...(props.skillSecretsApi?{openSkillSecrets:(skill:string,title:string)=>{setSkillSecretsView({skill,title});setCatalogNavigation([])},describeSkillSecrets:props.skillSecretsApi.describe}:{}),
    ...(props.localRetrievalApi?{openRetrievalModel:(catalogId:string,version:string)=>setRetrievalView({catalogId,version})}:{}),
  }
  if(!visible)return null
  if(retrievalView&&props.localRetrievalApi)return <LocalRetrievalModelPanel api={props.localRetrievalApi} catalogId={retrievalView.catalogId} catalogVersion={retrievalView.version} onBack={()=>setRetrievalView(null)} onExtensions={()=>{setRetrievalView(null);selectKind('plugin')}}/>
  if(catalogRoute?.kind==='entry'&&props.marketCatalogApi)return <MarketCatalogSection key={catalogRoute.catalogId} api={props.marketCatalogApi} onCounts={setCatalogCounts} {...catalogActions} initialEntryId={catalogRoute.catalogId} onBack={backCatalog} query="" openContent={async contentId=>{await openCatalogContent(contentId);setCatalogNavigation([])}}/>
  if(catalogRoute?.kind==='connection'&&props.managedMcpConnectionApi)return <McpConnectionView key={catalogRoute.catalogId} catalogId={catalogRoute.catalogId} entry={catalogRoute.entry} api={props.managedMcpConnectionApi} {...(props.marketCatalogApi?{catalogApi:props.marketCatalogApi,onOpenCatalog:(catalogId:string)=>setCatalogNavigation(history=>[...history,{kind:'entry',catalogId}])}:{})} onBack={backCatalog}/>
  if(skillSecretsView&&props.skillSecretsApi)return <SkillSecretsView skill={skillSecretsView.skill} title={skillSecretsView.title} api={props.skillSecretsApi} onBack={()=>setSkillSecretsView(null)}/>
  if(props.installations.visible)return null
  // 搜索限定当前顶部分类，分类切换保留关键词，方便横向查找不同类型的资源。
  const listKind:MarketCategory=solutionCategory?'industry':atomicCategory
  const categoryItems=[...currentCatalog,...builtinSolutions].filter(item=>allCategory||marketCategoryOf(item)===listKind)
  const rows=filterMarket(categoryItems,{kind:'all',scope:'all',visibility:'all',query,searchValues:item=>Object.values(localizedMarketItemCopy(item,locale))})
  // 本机条目：方案页是本机方案（库里没有自己的方案时是内置示例），其余页签是按类型汇总的本机资源行
  const localResourceRows=resourceKinds?.length?marketResourceIndex(currentCatalog).filter(row=>resourceKinds.some(kind=>kind===row.kind)):[]
  const itemById=(id:string|undefined)=>id?currentCatalog.find(item=>item.id===id):undefined
  const tabLocalItems=resourceKinds?localResourceRows.flatMap(row=>currentCatalog.filter(item=>item.id===row.itemId)):rows
  // 「本机自带示例」说明只在当前页签确实列出了这类条目时出现
  // 正文停在详情上（官方条目详情，或统一列表里本机引用条目的摘要）时收起搜索行与常驻说明，免得详情上方留一块空白
  const inDetail=catalogDetailOpen||(!!catalogKind&&!!props.marketCatalogApi&&!!inlineSelectedId)
  const hasLocalFixedContent=!inDetail&&kind!=='intents'&&tabLocalItems.some(item=>marketCatalogItemCopy(item,locale).localFixed)
  // 有官方目录的页签只有一个列表：本机条目换成统一列表行排在前面，与官方条目共用一套行业 / 功能筛选（原型 `市场方案.jsx`）
  const builtinIds=new Set(builtinSolutions.map(item=>item.id))
  const solutionListRows=():MarketListRow[]=>rows.map(item=>{
    const copy=marketCatalogItemCopy(item,locale),manifest=isIndustryManifest(item.manifest)?item.manifest:undefined
    const contains=manifest?compositionSummary(composeFromManifest(manifest),t,value=>value.toLocaleString(locale)):''
    return {key:item.id,title:copy.title,summary:copy.summary,facts:contains?t('market.solution.contains' as Parameters<typeof t>[0],{list:contains}):marketItemPresentation(item,props.industryLoads.loads,props.runtime,t).source,
      tag:builtinIds.has(item.id)?t('market.solution.builtinTag'):t('market.catalog.localTag'),mark:allCategory?marketItemMark(item,props.industryLoads.loads,props.runtime):solutionMark({loaded:solutionInstalled(item,props.industryLoads.loads),restartRequired:false}),
      art:{kind:allCategory?marketCategoryOf(item):'industry',seed:item.id},taxonomy:marketItemTaxonomy(item),open:()=>openItem(item.id),current:lastSelectedId===item.id,...(item.contentStorage?{contentId:item.contentStorage.contentId}:{})}
  })
  const resourceListRows=():MarketListRow[]=>filterMarketResources(localResourceRows,{kind:'all',query,referencedIndustry:'all',capability:'all',searchValues:row=>[localizedMarketResourceEntryTitle(row,locale),...row.uses.map(use=>localizedMarketResourceUseTitle(use,locale))]}).map(row=>{
    const item=itemById(row.itemId),copy=item?marketCatalogItemCopy(item,locale):{title:localizedMarketResourceEntryTitle(row,locale),summary:''},presentation=marketResourcePresentation(row,item,props.runtime,t)
    // 实体条目直达正式详情；只被方案引用的条目与身份冲突的条目仍先看摘要（由本机资源目录的详情给出）
    return {key:row.key,title:copy.title,summary:copy.summary,facts:presentation.scope+' · '+presentation.source,tag:t('market.catalog.localTag'),mark:marketResourceMark(row,item,props.runtime),
      art:{kind:row.kind,seed:row.key},taxonomy:resourceEntryTaxonomy(row,item,itemById),open:()=>row.itemId&&row.status!=='conflict'?openResourceItem(row.itemId):selectResource(row.key,true),current:lastSelectedId===row.key,...(item?.contentStorage?{contentId:item.contentStorage.contentId}:{})}
  })
  const officialSection=(allCategory||catalogKind)&&props.marketCatalogApi?<MarketCatalogSection cardLayout={!!props.inCapabilityCenter} key={allCategory?'all':catalogKind} api={props.marketCatalogApi} onCounts={setCatalogCounts} {...catalogActions} query={query} openContent={openCatalogContent} kinds={allCategory?undefined:catalogKind?[catalogKind]:undefined} onDetailChange={setCatalogDetailOpen} onResetQuery={()=>{setQuery('');rememberNavigation({query:''})}} localRows={allCategory||solutionCategory?solutionListRows():resourceListRows()} label={allCategory?t('capabilityCenter.all'):marketCategoryLabel(t,listKind)}/>:null
  const templateRows=filterTaxonomyRows(rows,marketItemTaxonomy,templateTaxonomy)
  const addedCount=solutionInstalledCount(currentCatalog,props.industryLoads.loads)
  const addedSolutions=currentCatalog.filter(item=>marketCategoryOf(item)==='industry'&&solutionInstalled(item,props.industryLoads.loads))
  // 「先问问」临时带进来的官方方案与它的问答草稿不算本人来源与待应用方案
  const transientIds=new Set(state.items.filter(row=>row.source.kind==='catalog').map(row=>row.id))
  const guideSteps=marketPageGuidance({items:state.items.filter(row=>!transientIds.has(row.id)),intents:state.intents.filter(intent=>!transientIds.has(intent.itemId)),industryLoadCount:props.industryLoads.loads.length,contentPending:!!contentApi?.pending(),skillInstallPending:!!props.skillInstallApi.pending()})
  // 引导块只在首页出现，其余页签（skill/resource/connector/work-template/intents…）一律不挂：
  // 判据抽成纯函数 showMarketGuide，见 market-home-presentation.ts。
  const showGuide=showMarketGuide({hasItem:!!item,itemId,intentId,kind,solutionView})
  const saveItem=(incoming:MarketItem,chat=false)=>{
    const current=stateRef.current,existing=incoming.contentStorage?current.items.find(item=>item.contentStorage?.contentId===incoming.contentStorage?.contentId):incoming.hash?current.items.find(item=>item.hash===incoming.hash&&item.packageContent?.hash===incoming.packageContent?.hash):undefined,item=existing?.contentStorage?.loaded?existing:incoming
    const next=existing?{...current,items:current.items.map(row=>row===existing?item:row)}:{...current,items:[...current.items,item]};change(next);setImportMode(null);setAtomicImport(false);setTemplate(false);clearSeed();open(item.id)
    if(chat)void props.prepare(item).catch(error=>setError(localizeWorkError(locale,error)))
  }
  const selectResource=(id:string|undefined,openDetail=true)=>{if(id){setLastSelectedId(id);setResourceDetailOpen(openDetail);rememberNavigation({selectedId:id,mobileLayer:openDetail?'detail':'list'});return}setResourceDetailOpen(false);rememberNavigation({selectedId:lastSelectedId,mobileLayer:'list'})}
  const openResourceItem=(id:string)=>{const selectedId=marketResourceIndex(currentCatalog).find(row=>row.itemId===id&&row.status!=='conflict')?.key??resourceSelectedKey;setLastSelectedId(selectedId);open(id);rememberNavigation({selectedId,mobileLayer:'detail'})}
  // 首页「问一问」与产品页「先问问它适不适合我」走同一条路：先按草稿文案落一份 draft，再交给既有 props.prepare 起会话。
  // props.prepare 必须绑定一条具体方案，首页就拿当前结果里排最前的那条当提问对象；一条结果都没有时不出这个按钮。
  const solutionCards=<SolutionCards items={rows} loads={props.industryLoads.loads} selectedId={lastSelectedId} open={openItem}/>
  // 「问一问」给的是方案推荐，不把某一项 Skill 或连接器误当成完整方案来准备会话。
  const askItem=solutionCategory?rows[0]:undefined
  const ask=(target:MarketItem)=>{
    try{
      const id=crypto.randomUUID(),trimmed=query.trim()
      const purpose=trimmed?t('market.solution.askDraft',{query:trimmed}):t('market.solution.askDraftEmpty')
      const next=saveMarketIntent(stateRef.current,{id,itemId:target.id,scope:target.scope,target:t('market.workspace.current'),purpose,visibility:'personal',now:new Date().toISOString()})
      change(next)
      // saveMarketIntent 遇到同一份等价草稿会原样返回旧状态，这时取那条既有草稿，不新开一条。
      const draft=next.intents.find(row=>row.id===id)??next.intents.find(row=>row.itemId===target.id&&row.itemVersion===target.version&&row.status==='draft'&&!row.targetRef)
      setLastSelectedId(target.id);open(target.id,draft?.id)
      void props.prepare(target,draft).catch(error=>setError(localizeWorkError(locale,error)))
    }catch(error){setError(localizeWorkError(locale,error))}
  }
  return <section className={clsx(base.page,css.page,props.inCapabilityCenter&&css.center)} data-mobile-layer={mobileLayer} aria-label={t('market.workspace.aria')}><div {...directoryFocus} className={css.content}><div className={css.container}>
    {!props.inCapabilityCenter&&<header className={css.pageHeader}><div><span className={css.eyebrow}>{t('market.home.heroTitle')}</span><h1>{t('market.title')}</h1></div><div className={css.headerActions}><button type="button" className={css.addedBadge} onClick={()=>selectKind('intents')}><Check size={15}/>{t('market.addedCount',{count:addedCount})}</button></div></header>}
    <div className={css.categoryViewport}><nav className={css.categories} aria-label={t('market.category.aria')}>{props.inCapabilityCenter&&<button type="button" aria-current={allCategory?'page':undefined} onClick={()=>selectKind('home')}>{t('capabilityCenter.all')}</button>}{visibleCategories.map(category=><button key={category} type="button" aria-current={(category==='industry'?solutionCategory:kind===category)?'page':undefined} onClick={()=>selectKind(category)}>{props.inCapabilityCenter&&category==='connector'?t('capabilityCenter.connectors'):marketCategoryLabel(t,category)}</button>)}{!props.inCapabilityCenter&&<button type="button" aria-current={kind==='intents'?'page':undefined} onClick={()=>selectKind('intents')}>{t('market.solution.addedTab' as Parameters<TeloaTranslate>[0])}</button>}</nav><span className={css.categoryScrollHint} aria-hidden="true"><ChevronRight size={16}/></span></div>
    {hasLocalFixedContent&&<p className={css.catalogBoundary} role="note">{t('market.catalog.localFixedBoundary')}</p>}
    {!item&&kind!=='intents'&&!inDetail&&<div className={css.toolRow}><label className={css.globalSearch}><Search size={16}/><input aria-label={t('market.search.aria')} value={query} onChange={event=>{setQuery(event.target.value);rememberNavigation({query:event.target.value})}} placeholder={t(props.inCapabilityCenter?'capabilityCenter.searchDiscover':'market.search.placeholder')}/>{query&&<button type="button" onClick={()=>{setQuery('');rememberNavigation({query:''})}}>{t('market.search.clear')}</button>}</label>{props.inCapabilityCenter&&<button type="button" onClick={()=>selectKind('intents')}>{t('market.solution.addedTab' as Parameters<TeloaTranslate>[0])}</button>}{askItem&&<button type="button" className={css.askAction} onClick={()=>ask(askItem)}><MessageSquare size={15}/>{t('market.solution.ask')}</button>}<details ref={importMenuRef} className={css.toolMenu} open={importMenuOpen} onToggle={event=>setImportMenuOpen(event.currentTarget.open)}><summary><Download size={16}/>{t('market.tool.import')}</summary><div><button type="button" onClick={()=>{importMenuRef.current?.querySelector('summary')?.focus();setImportMenuOpen(false);setImportMode('upload')}}>{t('market.import.industry')}</button><button type="button" onClick={()=>{importMenuRef.current?.querySelector('summary')?.focus();setImportMenuOpen(false);setAtomicImport(true)}}>{t('market.import.skill')}</button><button type="button" onClick={()=>{importMenuRef.current?.querySelector('summary')?.focus();setImportMenuOpen(false);setImportMode('github')}}>{t('market.import.github')}</button><button type="button" onClick={()=>{importMenuRef.current?.querySelector('summary')?.focus();setImportMenuOpen(false);setImportMode('paste')}}>{t('market.import.pasteManifest')}</button></div></details><details ref={createMenuRef} className={css.toolMenu} open={createMenuOpen} onToggle={event=>setCreateMenuOpen(event.currentTarget.open)}><summary><Plus size={16}/>{t('market.tool.create')}</summary><div><button type="button" onClick={()=>{createMenuRef.current?.querySelector('summary')?.focus();setCreateMenuOpen(false);setTemplate(true)}}>{t('market.template.create')}</button><button type="button" onClick={()=>{createMenuRef.current?.querySelector('summary')?.focus();setCreateMenuOpen(false);setImportMode('conversation')}}>{t('market.template.createFromConversation')}</button></div></details></div>}
    {/* 原型 `市场方案.jsx` 工具行下方的常驻说明：内容从哪来、添加意味着什么 */}
    {!item&&kind!=='intents'&&!inDetail&&<p className={css.catalogNotice} role="note">{t('market.catalog.notice')}</p>}
    {error&&<div className={base.error} role="alert">{error}<button type="button" onClick={()=>setError('')}>{t('market.error.close')}</button></div>}
    <div data-teloa-pane={item||inlineSelectedId?'detail':'directory'} tabIndex={-1} className={css.catalogBody}>{item?<MarketDetail key={draft?.id||item.id} {...props} item={item} draft={draft} back={()=>{const selected=resourceSelectedKey?marketResourceIndex(currentCatalog).find(row=>row.key===resourceSelectedKey):undefined,showSummary=!!selected&&(!selected.itemId||selected.status==='conflict');open();setResourceDetailOpen(showSummary);rememberNavigation({selectedId:resourceSelectedKey??lastSelectedId,mobileLayer:showSummary?'detail':solutionCategory?'category':'list'})}}/>:itemId||intentId?<div className={base.empty}><h2>{t('market.content.notFound')}</h2><button type="button" onClick={()=>open()}>{t('market.back')}</button></div>:kind==='intents'?<section className={css.collection}><header><div><h2>{t('market.solution.addedTab' as Parameters<typeof t>[0])}</h2><p>{t('market.solution.addedDescription' as Parameters<typeof t>[0])}</p></div><button type="button" onClick={()=>props.installations.open()}>{t('market.installation.title')}</button></header>{addedSolutions.length?<SolutionCards items={addedSolutions} loads={props.industryLoads.loads} selectedId={lastSelectedId} open={openItem}/>:<div className={base.empty}><h2>{t('market.solution.addedEmptyTitle' as Parameters<typeof t>[0])}</h2><p>{t('market.solution.addedEmptyDescription' as Parameters<typeof t>[0])}</p><button type="button" onClick={()=>selectKind('home')}>{t('market.solution.browseSolutions' as Parameters<typeof t>[0])}</button></div>}</section>:allCategory?<section className={css.sectionStack}>{officialSection??<MarketCards items={rows} loads={props.industryLoads.loads} runtime={props.runtime} selectedId={lastSelectedId} open={openItem}/>}</section>:solutionCategory?<section className={css.sectionStack}>{officialSection??<div className={css.collection}>{query&&<header><div><h2>{t('market.search.resultsTitle')}</h2><p>{marketCountText(t,locale,'search',rows.length)}</p></div></header>}{!query&&!!builtinSolutions.length&&<header><div><h2>{t('market.solution.builtinTitle')}</h2><p>{t('market.solution.builtinNotice')}</p></div></header>}{solutionCards}{query&&!rows.length&&<div className={base.empty}><h2>{t('market.search.empty')}</h2><p>{t('market.search.emptyHint')}</p></div>}</div>}</section>:<div className={css.sectionStack}>{officialSection?<>{inlineSelectedId&&resourceKinds?.length?<MarketResourceCatalog detailOnly filters={resourceFilters} onFiltersChange={setResourceFilters} key={atomicCategory} items={currentCatalog} kind={atomicCategory==='agent'?'role':atomicCategory==='skill'?'skill':'resource'} resourceKinds={resourceKinds} query={query} onQueryChange={value=>{setQuery(value);rememberNavigation({query:value})}} hideQuery {...(resourceSelectedKey?{selectedId:resourceSelectedKey}:{})} detailOpen={resourceDetailOpen} onSelectedChange={selectResource} open={openResourceItem} runtime={props.runtime} openInstallation={id=>props.installations.open('skill:'+id)}/>:null}<div hidden={!!inlineSelectedId}>{officialSection}</div></>:resourceKinds?.length===0?null:resourceKinds?<div className={css.collection}>{atomicCategory==='plugin'&&props.bundledExtensionsApi&&<BundledExtensionsSection api={props.bundledExtensionsApi}/>}<MarketResourceCatalog filters={resourceFilters} onFiltersChange={setResourceFilters} key={atomicCategory} items={currentCatalog} kind={atomicCategory==='agent'?'role':atomicCategory==='skill'?'skill':'resource'} resourceKinds={resourceKinds} query={query} onQueryChange={value=>{setQuery(value);rememberNavigation({query:value})}} hideQuery {...(resourceSelectedKey?{selectedId:resourceSelectedKey}:{})} detailOpen={resourceDetailOpen} onSelectedChange={selectResource} open={openResourceItem} runtime={props.runtime} openInstallation={id=>props.installations.open('skill:'+id)}/></div>:<div className={css.listStack}><MarketFilterBar rows={rows} tags={marketItemTaxonomy} filter={templateTaxonomy} onChange={setTemplateTaxonomy}/>{templateRows.length>0&&<><MarketResultLine count={templateRows.length}/><MarketCards items={templateRows} loads={props.industryLoads.loads} runtime={props.runtime} selectedId={lastSelectedId} open={openItem}/></>}{!templateRows.length&&<MarketEmpty filtered={categoryItems.length>0} onReset={()=>{setTemplateTaxonomy({industry:null,fn:null});setQuery('');rememberNavigation({query:''})}}/>}</div>}</div>} </div>
    {showGuide&&<details className={css.guideDisclosure}><summary>{t('market.guide.summary')}</summary><GuidedSetup title={t('market.guide.title')} description={t('market.guide.description')} steps={guideSteps}/></details>}{(contentApi?.pending()||contentApi?.pendingGithubImport())&&<section className={css.contextBar} aria-label={t('market.content.pendingImport')}><strong>{t('market.content.pendingImport')}</strong><div className={css.contextBody}>{contentApi?.pending()&&<button type="button" disabled={recovering} onClick={()=>{setRecovering(true);setError('');void contentApi.recover().then(row=>saveItem(row),()=>setError(t('market.content.importVerificationFailed'))).finally(()=>setRecovering(false))}}>{recovering?t('market.content.verifyingImport'):t('market.import.reviewIncomplete')}</button>}{contentApi?.pendingGithubImport()&&<><span>{t('market.content.pendingGithubImport')}{contentApi.pendingGithubImport()!.manifestPath}</span><button type="button" disabled={recovering} onClick={()=>{setRecovering(true);setError('');void contentApi.recoverGithubImport().then(row=>saveItem(row),error=>setError(localizeWorkError(locale,error))).finally(()=>setRecovering(false))}}>{recovering?t('market.content.verifyingImport'):t('market.content.reviewGithubImport')}</button></>}</div></section>}
  </div></div>{atomicImport&&<AtomicSkillImport {...(contentApi?{contentApi}:{})} close={()=>setAtomicImport(false)} save={item=>saveItem(item)}/>} {importMode&&<MarketImportForm githubSourceApi={props.githubSourceApi} items={state.items} {...(contentApi?{contentApi}:{})} saveMany={incoming=>{const current=stateRef.current,next=[...current.items];for(const item of incoming){const index=next.findIndex(existing=>existing.contentStorage?.contentId===item.contentStorage?.contentId||existing.id===item.id);if(index<0)next.push(item);else next[index]=item}change({...current,items:next});setImportMode(null);setKind('home');setQuery('');setTemplateTaxonomy({industry:null,fn:null});open()}} mode={importMode} close={()=>setImportMode(null)} save={saveItem}/>} {(template||seed)&&<TemplateForm seed={seed||undefined} spaces={props.spaces} close={()=>{setTemplate(false);clearSeed()}} save={saveItem}/>}</section>
}
function MarketDetail({item,draft,back,...props}:MarketProps&{runtime:MarketSkillRuntime;runtimeChanged?:()=>void;item:MarketItem;draft:MarketIntent|undefined;back:()=>void}){
  const {locale,t}=useI18n()
  const copy=localizedMarketItemDetailCopy(item,locale)
  const [purpose,setPurpose]=useState(draft?.purpose||copy.summary),[selectedTarget,setSelectedTarget]=useState(''),[scope,setScope]=useState(item.scope),[visibility,setVisibility]=useState<'personal'|'team'>(draft?.visibility||'personal'),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[actionPanel,setActionPanel]=useState<'load'|'intent'|null>(draft?'intent':null)
  const selected=props.targets.find(value=>marketTargetKey(value)===selectedTarget)
  const target=selected?.title||t('market.workspace.current')
  const check=checkMarketTarget(draft?.targetRef,props.targets)
  const targetBlocked=!!draft?.targetRef&&check.status!=='current'
  const itemPresentation=marketItemPresentation(item,props.industryLoads.loads,props.runtime,t)
  // 接入源读写与官方方案页同一口径：包内连接声明对照官方连接器目录，只在方案带连接且有包内文件时读一次目录
  const [catalogConnectors,setCatalogConnectors]=useState<MarketCatalogConnectorEntry[]>([])
  const needsConnectors=isIndustryManifest(item.manifest)&&!!item.packageContent&&item.manifest.resources.some(resource=>resource.kind==='mcp')
  useEffect(()=>{
    if(!needsConnectors||!props.marketCatalogApi)return
    let active=true
    void loadCatalogListing(props.marketCatalogApi,'teloa').then(value=>{if(active)setCatalogConnectors(value.items.flatMap(row=>row.entry.kind==='connector'?[row.entry]:[]))},()=>{})
    return()=>{active=false}
  },[props.marketCatalogApi,needsConnectors])
  const createIntent=(purposeOverride?:string)=>{
    if(selectedTarget&&!selected)throw Error(t('market.intent.targetUnavailable'))
    const next=saveMarketIntent(props.state,{id:crypto.randomUUID(),itemId:item.id,scope:selected?.scope||scope,target,...(selected?{targetRef:selected}:{}),targets:props.targets,purpose:purposeOverride??purpose,visibility,now:new Date().toISOString()})
    props.change(next)
    return next.intents.find(value=>value.itemId===item.id&&value.itemVersion===item.version&&value.scope===(selected?.scope||scope.trim())&&value.status==='draft'&&(selected?(!!value.targetRef&&marketTargetKey(value.targetRef)===marketTargetKey(selected)&&value.targetRef.version===selected.version):(!value.targetRef&&value.target===target)))!
  }
  // 「先问问它适不适合我」需要用一段专属草稿文案发起准备，而不是当前 purpose 输入框的内容；
  // 可选参数 purposeOverride 让调用方在不改动既有 purpose 状态的情况下临时指定文案，默认行为不变。
  const prepare=async(purposeOverride?:string)=>{
    setBusy(true);setError('')
    try{
      const effectivePurpose=purposeOverride??purpose
      let prepared=draft
      if(!prepared){
        prepared=createIntent(purposeOverride)
      }else if(effectivePurpose!==prepared.purpose||visibility!==prepared.visibility){
        props.update(prepared.id,prepared.version,effectivePurpose,visibility)
        prepared={...prepared,purpose:effectivePurpose.trim(),visibility,version:prepared.version+1}
      }
      if(!prepared)throw Error(t('market.intent.notFound'))
      if(purposeOverride!==undefined)setPurpose(purposeOverride)
      props.open(item.id,prepared.id)
      await props.prepare(item,prepared)
    }catch(error){setError(localizeWorkError(locale,error))}finally{setBusy(false)}
  }
  const save=()=>{try{setError('');if(draft){props.update(draft.id,draft.version,purpose,visibility);setNotice(t('market.intent.updatedNotApplied'))}else{const result=createIntent();props.open(item.id,result.id)}}catch(error){setError(localizeWorkError(locale,error))}}
  const exportDefinition=()=>{if(!item.manifest)return;const blob=new Blob([JSON.stringify(item.manifest,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');anchor.href=url;anchor.download=item.manifest.id+'.json';anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);setNotice(t('market.manifest.exportedNotice'))}
  const intent=<IndustryIntentPanel item={item} draft={draft} market={props} selectedTarget={selectedTarget} setSelectedTarget={setSelectedTarget} selected={selected} scope={scope} setScope={setScope} purpose={purpose} setPurpose={setPurpose} visibility={visibility} setVisibility={setVisibility} check={check} targetBlocked={targetBlocked} save={save} setError={setError}/>
  const message=error||draft?.preparation?.status==='failed'?error||t('market.conversation.prepareFailed'):''
  if(isIndustryManifest(item.manifest)){
    const manifest=item.manifest
    // 与方案卡共用 solutionInstalled：逐条过一遍，既拿到「是否已添加」，也保留要列出的那几条生效加载。
    const matchingLoads=props.industryLoads.loads.filter(load=>solutionInstalled(item,[load]))
    const currentStatus=matchingLoads.length?t('market.workspace.loadedPersonal'):item.contentStorage?.loaded?t('market.content.fixedNotLoaded'):item.packageContent?t('market.content.readNotFixed'):item.hash?t('market.manifest.parsedContentPending'):item.source.kind==='builtin'?t('market.source.builtinNotLoaded'):t('market.source.savedContentUnavailable')
    // 「添加后你会得到」按业务结构七行分节：顺序、主标签、副标、计数单位与附注全部来自共享模块，不在这里另写一份分类。
    const rows=composeFromManifest(manifest)
    const members=solutionMembers(manifest,locale,manifest.id)
    const readOnlyConnections=localReadOnlyConnections(manifest,item.packageContent,catalogConnectors)
    const number=(value:number)=>value.toLocaleString(locale)
    return <article className={clsx(css.detail,css.industryDetail)} aria-label={t('market.detail.aria')}>
      <button className={css.backLink} type="button" onClick={back}><ArrowLeft size={15}/>{t('market.solution.back')}</button>
      <header className={css.solutionHero} aria-label={t('market.industry.overviewAria')}>
        <span className={clsx(css.bundleArt,css.heroArt,staffCss['tone'+staffAvatarSeed(item.id).tone])} aria-hidden="true"><span/><span/><span/></span>
        <h1>{copy.title}</h1>
        <p>{copy.summary}</p>
        {/* 一键添加就是今天 industryLoads.loadWorkspace 那个按钮：只换文案与位置，展开逻辑一字不改（走既有 IndustryLoadForm 两段式）。 */}
        {!manifest.resources.every(row=>row.kind==='business-configuration')&&<button className={css.primaryAction} type="button" disabled={!!matchingLoads.length} aria-expanded={actionPanel==='load'} onClick={()=>setActionPanel('load')}>{matchingLoads.length?t('market.solution.added'):t('market.industry.loadWorkspace')}{matchingLoads.length?<Check size={15}/>:<Plus size={15}/>}</button>}
        <SolutionLoadLinks loads={matchingLoads} manage={props.manageIndustryLoad}/>
        <button type="button" disabled={busy||targetBlocked||draft?.status==='withdrawn'||draft?.preparation?.status==='pending'} onClick={()=>void prepare(t('market.solution.askFitDraft',{name:copy.title}))}><MessageSquare size={13}/>{t('market.solution.askFit')}</button>
      </header>
      {message&&<p role="alert" className={css.notice}>{message}</p>}{notice&&<p role="status">{notice}</p>}
      {props.dashboardResources&&manifest.resources.some(row=>row.kind==='business-configuration')&&<BusinessDashboardMarketPanel key={item.id} item={item} api={props.dashboardResources} refreshScopes={props.refreshScopes} spaces={props.spaces} colorScheme={props.colorScheme??'light'} {...(props.contentApi?{upgrade:(adoption:Parameters<NonNullable<import('./BusinessDashboardMarketPanel.js').BusinessDashboardMarketPanelProps['upgrade']>>[0])=><BusinessDashboardUpgradePanel item={item} candidates={props.state.items} api={props.dashboardResources!} refreshScopes={props.refreshScopes} adoption={adoption} hydrate={value=>props.contentApi!.hydrate(value)} spaces={props.spaces} colorScheme={props.colorScheme??'light'} {...(props.openBusiness?{openSaved:props.openBusiness}:{})}/>}:{})} {...(props.openBusiness?{openSaved:props.openBusiness}:{})}/>}
      {actionPanel==='load'?<SolutionLoadPanel {...props} item={item} close={()=>setActionPanel(null)}/>:actionPanel?<section className={css.actionWorkspace} aria-label={t('market.intent.configurePanelAria')}>
        <header><div><span className={css.eyebrow}>{t('market.template.useEyebrow')}</span><h3>{draft?t('market.intent.view'):t('market.intent.create')}</h3></div><button type="button" onClick={()=>setActionPanel(null)}><ArrowLeft size={15}/>{t('market.template.backToContent')}</button></header>
        <IndustryIntentPanel item={item} draft={draft} market={props} selectedTarget={selectedTarget} setSelectedTarget={setSelectedTarget} selected={selected} scope={scope} setScope={setScope} purpose={purpose} setPurpose={setPurpose} visibility={visibility} setVisibility={setVisibility} check={check} targetBlocked={targetBlocked} save={save} setError={setError}/>
      </section>:<>
        <h2>{t('market.solution.youGet')}</h2>
        <div className={css.youGet}>{rows.map(row=>{
          const meta=COMPOSITION_ROWS.find(value=>value.id===row.id)!
          // 附注只有两行有：任务模板说自动化与动作的分布，扩展说它是工作室通用的。
          const note=row.id==='method'?compositionMethodNote(row.detail,t,number):row.id==='extension'?t(COMPOSITION_EXTENSION_NOTE_KEY):''
          return <div key={row.id}>
          <h3>{t(meta.label)}<em className={css.solutionGroupQuestion}>{t(meta.question)}</em><span className={css.solutionGroupCount}>{row.detail?.configurations?t('market.dashboard.count',{count:number(row.detail.configurations)}):t(meta.unit,{count:number(row.count),views:number(row.detail?.views??0)})}</span></h3>
          {row.id==='staff'
            ?<div className={css.memberCards}>{members.map(member=><span key={member.id}><StaffAvatar initial={member.initial} seed={member.seed} size="md"/><strong>{member.title}</strong></span>)}</div>
            :<ul>{solutionRowResources(manifest,row.id,locale).map(resource=>{
              const label=row.id==='source'?connectorModeLabel(sourceConnectorMode(resource,readOnlyConnections)??{},t):undefined
              return <li key={resource.id}><Check size={13} aria-hidden="true"/><span>{resource.title}</span>{label&&<small className={css.solutionResourceType}>{label}</small>}</li>
            })}</ul>}
          {note&&<p className={css.solutionGroupNote}>{note}</p>}
        </div>})}</div>
        {/* 六组之后只留这一个折叠：原来的「其他使用方式」「它到底带进来哪些东西」「来源、运行环境与版本」
            全部压进「来源与版本」的小字正文，一条信息、一个动作都没丢，只是不再各占一个页尾折叠。 */}
        <details className={css.provenance}>
          <summary>{t('market.solution.provenance')}</summary>
          <dl><dt>{t('market.catalog.source')}</dt><dd>{sourceLabel(item.source,t)}</dd><dt>{t('market.industry.templateLabel')}</dt><dd>v{item.version}</dd><dt>{t('market.industry.status')}</dt><dd>{currentStatus}</dd><dt>{t('market.industry.resourceSummary')}</dt><dd>{marketCountText(t,locale,'resource',manifest.resources.length)} · {marketCountText(t,locale,'entrypoint',manifest.entrypoints.length)}</dd></dl>
          <p>{t('market.solution.provenance.notice')}</p>
          <div className={css.provenanceBody}>
            <section className={css.sheet} aria-label={t('market.industry.otherUsage')}><h3>{t('market.industry.otherUsage')}</h3><div className={base.buttons}>
              <button type="button" aria-label={draft?t('market.intent.view'):t('market.intent.create')} aria-expanded={actionPanel==='intent'} onClick={()=>setActionPanel('intent')}>{draft?t('market.intent.view'):t('market.intent.create')}</button>
              <button type="button" aria-label={t('market.conversation.use')} disabled={busy||targetBlocked||draft?.status==='withdrawn'||draft?.preparation?.status==='pending'} onClick={()=>void prepare()}>{busy||draft?.preparation?.status==='pending'?t('market.conversation.preparing'):t('market.conversation.use')}</button>
            </div></section>
            <section className={css.sheet} aria-label={t('market.solution.contents')}><h3>{t('market.solution.contents')}</h3><IndustryContents manifest={manifest} content={item.packageContent} persisted={!!item.contentStorage?.loaded}/></section>
            <section className={css.sheet} aria-label={t('market.template.sourceRuntimeAria')}><h3>{t('market.template.sourceRuntime.title')}</h3><dl><dt>{t('market.catalog.source')}</dt><dd>{sourceLabel(item.source,t)}</dd><dt>{t('market.template.author')}</dt><dd>{copy.author}</dd><dt>{t('market.template.license')}</dt><dd>{copy.license}</dd><dt>{t('market.template.runtimeOwnership')}</dt><dd>{t('market.template.runtimeOwnershipDescription')}</dd></dl><button type="button" onClick={props.nativeSettings}>{t('market.template.connectionsRuntime')}</button></section>
            {/* 治理三件套自己就渲染 .sheet 卡，这里只给一层带标题的分组，不再套一层卡中卡。 */}
            <section className={css.provenanceGroup} aria-label={t('market.template.governance.title')}><h3>{t('market.template.governance.title')}</h3><small>{t('market.template.governance.description')}</small>
              <IndustryReferences item={item} items={props.state.items} save={props.saveResolved}/>
              <IndustryUpdatePreview item={item} items={props.state.items} spaces={props.spaces} {...props.industryReview}/>
              <IndustryExport item={item}/>
            </section>
            {item.raw&&<section className={css.sheet}><h3>{t('market.template.manifestValidation')}</h3><details><summary>{t('market.template.viewRaw')}</summary><pre>{item.raw}</pre><small>SHA-256：{item.hash}</small></details><button type="button" onClick={exportDefinition}>{t('market.template.exportDefinition')}</button></section>}
          </div>
        </details>
      </>}
    </article>
  }
  return <article className={css.detail} aria-label={t('market.detail.aria')}>
    <button type="button" onClick={back}><ArrowLeft size={15}/>{t('market.catalog.back')}</button><h2>{copy.title}</h2>
    <div className={css.tags}><span>{marketCategoryLabel(t,marketCategoryOf(item))}</span><span>{itemPresentation.ecosystem}</span><span>{item.scope==='general'?t('market.scope.general'):item.scope}</span><span>{marketVisibilityLabel(t,item.visibility)}</span><span>{item.version}</span>{draft&&<span>{t('market.intent.detailVersionPrefix')}{draft.version} · {draft.status==='withdrawn'?t('market.intent.withdrawn'):t('market.intent.awaitingConfiguration')}</span>}</div>
    <p>{copy.summary}</p>{message&&<p role="alert" className={css.notice}>{message}</p>}{notice&&<p role="status">{notice}</p>}
    {item.kind==='skill'&&item.contentStorage?.loaded&&<SkillInstallControl key={'atomic-'+item.contentStorage.contentId} {...(props.runtimeChanged?{changed:props.runtimeChanged}:{})} api={props.skillInstallApi} source={{kind:'atomic',contentId:item.contentStorage.contentId}} title={copy.title}/>}
    {item.resourceKind==='plugin'&&(marketPluginInstallSource(item)?<MarketPluginInstallControl api={props.marketPluginInstallApi} source={marketPluginInstallSource(item)!} title={copy.title}/>:<section className={css.sheet} aria-label={t('market.plugin.install.title')}><h3>{t('market.plugin.install.title')}</h3><p role="alert">{t('market.plugin.install.unavailable')}</p>{item.source.kind==='github'&&<p>{t('market.plugin.install.source.githubOnly')}</p>}</section>)}
    {item.atomicSkill&&<section className={css.sheet} aria-label={t('market.skill.atomicContentAria')}><h3>{t('market.skill.contentTitle')}</h3><p>{t('market.skill.originalContentSavedNotice')}</p><p>{t('market.skill.resourceIdentifierPrefix')}{item.atomicSkill.id} · {item.atomicSkill.version}</p><pre>{item.atomicSkill.text}</pre><details><summary>{marketCountText(t,locale,'attachment',item.atomicSkill.files.length)}</summary><ul>{item.atomicSkill.files.map(file=><li key={file.path}>{file.path} · {file.bytes.length} {t('market.skill.fileSizeBytesUnit')}</li>)}</ul></details></section>}
    <div className={css.columns}><div><section className={css.sheet}><h3>{t('market.template.requirementsAndDeliverables')}</h3><ul>{copy.requirements.map((value,index)=><li key={index}>{value}</li>)}</ul><p>{copy.output}</p><div className={base.buttons}><button type="button" disabled={busy||targetBlocked||draft?.status==='withdrawn'||draft?.preparation?.status==='pending'} onClick={()=>void prepare()}>{busy||draft?.preparation?.status==='pending'?t('market.conversation.preparing'):item.kind==='template'?t('market.conversation.use'):t('market.template.refineInConversation')}</button>{item.kind==='template'&&<button type="button" disabled={busy||draft?.status==='withdrawn'||targetBlocked} onClick={()=>{try{props.planFromTemplate(item)}catch(error){setError(localizeWorkError(locale,error))}}}>{t('market.template.createRecurringPlan')}</button>}{item.manifest&&<button type="button" onClick={exportDefinition}>{t('market.template.exportDefinition')}</button>}</div><small>{t('market.template.nativeConversationPreparationNotice')}</small></section><section className={css.sheet}><h3>{t('market.template.componentsAndDependencies')}</h3>{copy.components.length?copy.components.map((component,index)=><div key={index} className={css.component}><strong>{component.name}</strong><span>{component.required?t('market.template.dependencyRequired'):t('market.template.dependencyOptional')} · {component.status}</span></div>):<p>{item.manifest?.format==='teloa.work-template/v1'?t('market.template.noAdditionalSkillDependencies'):t('market.template.componentDefinitionsUnreadNotice')}</p>}<div className={css.notice}>{copy.compatibility}</div><p>{t('market.template.readinessVerificationGuidance')}</p></section>{item.raw&&<section className={css.sheet}><h3>{t('market.template.manifestReadStatus')}</h3><details><summary>{t('market.template.viewRaw')}</summary><pre>{item.raw}</pre><small>SHA-256：{item.hash}</small></details></section>}</div><aside><section className={css.sheet}><h3>{t('market.template.sourceAndRuntimeOwnership')}</h3><dl><dt>{t('market.catalog.source')}</dt><dd>{sourceLabel(item.source,t)}</dd><dt>{t('market.template.author')}</dt><dd>{copy.author}</dd><dt>{t('market.template.license')}</dt><dd>{copy.license}</dd><dt>{t('market.template.runtimeConfigurationOwner')}</dt><dd>{itemPresentation.runtime}</dd><dt>{t('market.detail.currentStatus')}</dt><dd>{itemPresentation.status}</dd></dl><div className={base.buttons}>{itemPresentation.installationId&&<button type="button" onClick={()=>props.installations.open('skill:'+itemPresentation.installationId!)}>{itemPresentation.action}</button>}<button type="button" onClick={props.nativeSettings}>{t('market.template.connectionsRuntime')}</button></div></section>{intent}</aside></div>
  </article>
}

/** 已加进团队时的「看看它带进来什么 · 空间」入口（本机方案产品页与官方方案页共用）。 */
function SolutionLoadLinks({loads,manage}:{loads:readonly IndustryLoadRecord[];manage:(loadId:string)=>void}){
  const {t}=useI18n()
  // 个人版只有一个空间，空间名恒为后端常量「我的工作空间」，界面不显示它；这里按业务范围说话。
  const scopeNames=useBusinessScopes()
  return <>{loads.map(load=><button type="button" key={load.id} onClick={()=>manage(load.id)}>{t('market.solution.openLoad')} · {scopeNames[load.space.scope]??load.space.scope}</button>)}</>
}

/** 团队确认步骤（本机方案产品页与官方方案页共用）：IndustryLoadForm 两段式确认，外框、放弃草稿与「已放弃」提示都在这里。 */
function SolutionLoadPanel({item,close,...props}:MarketProps&{item:MarketItem;close:()=>void}){
  const {t}=useI18n()
  const [loadDiscarded,setLoadDiscarded]=useState(false)
  return <section className={css.actionWorkspace} aria-label={t('market.industry.loadPanelAria')}>
    <header><div><span className={css.eyebrow}>{t('market.industry.loadEyebrow')}</span><h3>{t('market.industry.loadWorkspace')}</h3></div><button type="button" onClick={close}><ArrowLeft size={15}/>{t('market.template.backToContent')}</button></header>
    <IndustryLoadForm embedded item={item} space={props.space} pending={props.industryLoads.api.pending()} recoveryError={props.industryLoads.api.recoveryMessage()??props.industryLoads.error} load={props.industryLoads.save} recover={props.industryLoads.recover}/>
    {props.industryLoads.api.recoveryMessage()&&<button type="button" onClick={()=>{props.industryLoads.api.discard();setLoadDiscarded(true)}}>{t('recovery.discard')}</button>}
    {loadDiscarded&&<p role="status">{t('recovery.discarded')}</p>}
  </section>
}

type IntentPanelProps={item:MarketItem;draft:MarketIntent|undefined;market:MarketProps;selectedTarget:string;setSelectedTarget:(value:string)=>void;selected:MarketTarget|undefined;scope:string;setScope:(value:string)=>void;purpose:string;setPurpose:(value:string)=>void;visibility:'personal'|'team';setVisibility:(value:'personal'|'team')=>void;check:ReturnType<typeof checkMarketTarget>;targetBlocked:boolean;save:()=>void;setError:(value:string)=>void}
function IndustryIntentPanel({item,draft,market,selectedTarget,setSelectedTarget,selected,scope,setScope,purpose,setPurpose,visibility,setVisibility,check,targetBlocked,save,setError}:IntentPanelProps){
 const {locale,t}=useI18n()
 return <section className={clsx(css.sheet,css.actionPanel)} aria-label={t('market.intent.title')}>
  <span className={css.eyebrow}>{draft?t('market.intent.savedEyebrow'):t('market.intent.configureEyebrow')}</span><h3>{draft?t('market.intent.title'):t('market.intent.create')}</h3>{draft&&<small>{draft.id}</small>}
  <form className={base.form} onSubmit={event=>{event.preventDefault();save()}}>
   {!draft&&<><label>{t('market.intent.targetLabel')}<select aria-label={t('market.intent.targetSelectAria')} value={selectedTarget} onChange={event=>setSelectedTarget(event.target.value)}><option value="">{t('market.intent.currentNeedOption')}</option>{marketTargetKinds.map(kind=><optgroup key={kind} label={marketTargetKindLabel(t,kind)}>{market.targets.filter(value=>value.kind===kind).map(value=><option key={marketTargetKey(value)} value={marketTargetKey(value)} disabled={value.availability!=='active'}>{value.title} · {value.scope}{market.targets.some(other=>other.kind===value.kind&&other.scope===value.scope&&other.title===value.title&&other.id!==value.id)?' · '+value.id:''} · v{value.version}{value.availability!=='active'?t('market.intent.targetUnavailableSuffix'):''}</option>)}</optgroup>)}</select></label>{selected?<small>{marketTargetKindLabel(t,selected.kind)} · {selected.id} · {selected.scope} · v{selected.version}{t('market.intent.authorizationMissingSuffix')}</small>:<label>{t('market.intent.requestedBusinessLabel')}<input required maxLength={80} value={scope} onChange={event=>setScope(event.target.value)}/></label>}</>}
   {draft&&<><p>{draft.target} · {draft.scope} {t('market.intent.pinnedContentVersionPrefix')}{draft.itemVersion}</p>{draft.targetRef&&<><small>{marketTargetKindLabel(t,draft.targetRef.kind)} · {draft.targetRef.id} {t('market.intent.detailTargetVersionPrefix')}{draft.targetRef.version}</small><p role={targetBlocked?'status':undefined}>{marketTargetCheckLabel(t,check)}</p><div className={base.buttons}><button type="button" onClick={()=>market.openTarget(draft.targetRef!)}>{t('market.intent.openTarget')}</button><button type="button" onClick={()=>market.open(item.id)}>{t('market.intent.chooseAnotherTarget')}</button></div></>}</>}
   <label>{t('market.intent.requirementLabel')}<textarea required rows={4} maxLength={4000} disabled={draft?.status==='withdrawn'} value={purpose} onChange={event=>setPurpose(event.target.value)}/></label>
   <label>{t('market.intent.visibilityLabel')}<select disabled={draft?.status==='withdrawn'} value={visibility} onChange={event=>setVisibility(event.target.value as 'personal'|'team')}><option value="personal">{t('market.intent.visibilityPersonal')}</option><option value="team">{t('market.intent.visibilityTeamDemo')}</option></select></label>
   <button type="submit" disabled={draft?.status==='withdrawn'}>{draft?t('market.intent.saveChanges'):t('market.intent.save')}</button>
  </form>
  <p className={css.actionHint}>{item.kind==='template'?t('market.intent.templateConversationBoundary'):t('market.intent.saveBoundary')}</p>
  {['skill','resource'].includes(item.kind)&&<div className={base.buttons}><button type="button" disabled={!draft?.targetRef||draft.status==='withdrawn'||targetBlocked} onClick={()=>{try{if(draft)market.configureBinding(draft.id)}catch(error){setError(localizeWorkError(locale,error))}}}>{t('market.binding.preview')}</button>{!draft?.targetRef&&<small>{t('market.binding.targetRequired')}</small>}</div>}
  {draft?.status==='draft'&&<div className={base.buttons}><button type="button" onClick={()=>{try{market.update(draft.id,draft.version,purpose,visibility,true)}catch(error){setError(localizeWorkError(locale,error))}}}>{t('market.intent.withdraw')}</button></div>}
  <div className={base.buttons}><button type="button" onClick={market.capabilities}>{t('market.capabilities.openTeamPlans')}</button></div>
 </section>
}
