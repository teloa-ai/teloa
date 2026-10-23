import {findMarketItem,matchingMarketItems,mergeMarketItems,sameMarketItem,marketItemNavigationIds} from './market-item-identity.ts'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import {BusinessDashboardUpgradePanel} from './BusinessDashboardUpgradePanel.js'
import {BusinessDashboardMarketPanel} from './BusinessDashboardMarketPanel.js'
import type {BusinessDashboardResourceApi} from './business-dashboard-resource-api.js'
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
import { ArrowLeft, Check, ChevronRight, MessageSquare, Plus, Search } from 'lucide-react'
import { filterMarket, marketVisibility, saveMarketIntent, sourceLabel, type MarketIntent, type MarketItem, type MarketState } from './market-preview.js'
import { checkMarketTarget, marketTargetKey, marketTargetKinds, type MarketTarget, type MarketTargetRef } from './market-target.js'
import {RealSkillInstallations} from './RealSkillInstallations.js'
import { MarketImportForm, TemplateForm, type MarketImportDraft, type MarketImportMode, type TemplateInputDraft, type TemplateSeed } from './MarketForms.js'
import type {SkillInstallApi} from './skill-install-api.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import {MarketPluginInstallControl,MarketPluginInstallations} from './MarketPluginInstallations.js'
import {marketPluginInstallSource} from './market-plugin-source.js'
import {marketSkillInstallationSelection} from './market-installation-selection.js'
import {SkillInstallControl} from './SkillInstallControl.js'
import type { MarketContentApi } from './market-content-api.js'
import type {GithubSourceApi} from './github-source-api.js'
import {localizedMarketItemCopy,localizedMarketItemDetailCopy,localizedMarketResourceEntryTitle,localizedMarketResourceUseTitle,marketCatalogItemCopy,marketCategoryKind,marketCategoryLabel,marketCategoryOf,marketItemPresentation,marketResourcePresentation,marketVisibilityLabel,restoredMarketCategory,marketPrimaryItem,marketItemGroup,marketResourceGroup,solutionRoleCount,type MarketBrowseKind,type MarketPrimaryView,type MarketCategory} from './market-home-presentation.js'
import { ItemArt, SolutionCards, StateMark } from './SolutionCards.js'
import {currentSolutionCatalog,localReadOnlyConnections,marketItemMark,marketResourceMark,solutionInstalled,solutionAdded,solutionMark,solutionMembers,solutionRowResources} from './market-solution-presentation.js'
import {COMPOSITION_EXTENSION_NOTE_KEY,COMPOSITION_ROWS,composeFromManifest,compositionCountText,compositionMethodNote,compositionSummary,connectorModeLabel,sourceConnectorMode} from './industry-composition.js'
import {ContextDrawer} from './ContextDrawer.js'
import {StaffAvatar} from './StaffAvatar.js'
import {loadMarketSkillRuntime,type MarketSkillRuntime} from './market-runtime-state.js'
import { useDirectoryFocus } from './directory-focus.js'
import {useDismissible} from './use-dismissible.js'
import {filterMarketResources,marketResourceIndex} from './market-resource-index.js'
import {filterTaxonomyRows,marketItemTaxonomy,resourceEntryTaxonomy,type TaxonomyFilter} from './market-taxonomy-filter.js'
import {MarketEmpty,MarketFilterBar,MarketListRows,MarketTemplateDetails,MarketResultLine,type MarketListRow} from './MarketUnifiedList.js'
import base from './TaskPage.module.css'
import { useI18n } from './i18n/provider.js'
import { MarketCatalogSection, type CatalogSolutionTeam } from './MarketCatalogSection.js'
import { catalogText, loadCatalogListing, type MarketCatalogApi } from './market-catalog-api.js'
import {McpConnectionView} from './McpConnectionView.js'
import type {ManagedMcpConnectionApi} from './mcp-connections-api.js'
import {SkillSecretsView} from './SkillSecretsView.js'
import type {SkillSecretsApi} from './skill-secrets-api.js'
import type {MarketCatalogConnectorEntry,MarketCatalogListCounts} from '@teloa/contract'
import { useBusinessScopes } from './business-scope-context.js'
import {localizeWorkError} from './i18n/errors.js'
import type {AppsStoredContent} from './market-apps-presentation.js'
import {marketTargetCheckLabel,marketTargetKindLabel} from './i18n/market-target.js'
import {marketCountText} from './i18n/market-count.js'
import {MarketAppsDirectory,initialAppsView} from './MarketAppsDirectory.js'
import {TeamCapabilitiesPage,type MyResourcesWiring} from './TeamCapabilitiesPage.js'
import {useTemplateShare} from './EmployeeTemplateShare.js'
import {MarketTemplateCreator,type MarketTemplateKind} from './MarketTemplateCreator.js'
import {MarketResourceCreator,type MarketResourceKind} from './MarketResourceCreator.js'
import type {AppsView} from './market-apps-presentation.js'
import css from './MarketPage.module.css'

type MarketMaintenanceProps={visible:boolean;selected:string|null;open:(id?:string)=>void;market:(id?:string)=>void}
export type MarketPageNavigationState={category:MarketBrowseKind;query:string;selectedId:string|undefined;mobileLayer:'category'|'list'|'detail';appsMine?:boolean;appsCategory?:AppsView['category']}
export type MarketProps={inCapabilityCenter?:boolean;refreshScopes?:(()=>Promise<unknown>)|undefined;dashboardResources?:BusinessDashboardResourceApi|undefined;colorScheme?:'light'|'dark'|undefined;openBusiness?:((scope:string)=>void)|undefined;openConnections?:((scope:string)=>void)|undefined;marketCatalogApi?:MarketCatalogApi;managedMcpConnectionApi?:ManagedMcpConnectionApi;skillSecretsApi?:SkillSecretsApi;githubSourceApi:GithubSourceApi;skillInstallApi:SkillInstallApi;marketPluginInstallApi:MarketPluginInstallApi;skillAvailabilityApi?:SkillAvailabilityApi;skillUpgradeApi?:SkillUpgradeApi;contentApi?:MarketContentApi;industryLoads:{api:IndustryLoadApi;loads:readonly IndustryLoadRecord[];error:string|undefined;save:(input:IndustryLoadCreateInput)=>Promise<void>;recover:()=>Promise<void>};industryReview:IndustryReviewProps;saveResolved:(item:MarketItem)=>void;spaces:readonly BusinessScopeLabel[];space?:BusinessSpaceRecord;planFromTemplate:(item:MarketItem)=>void;manageIndustryLoad:(loadId:string)=>void;installations:MarketMaintenanceProps;industryResources?:ReactNode;visible:boolean;state:MarketState;itemId:string|null;intentId:string|null;open:(itemId?:string,intentId?:string)=>void;change:(state:MarketState)=>void;update:(id:string,version:number,purpose:string,visibility:'personal'|'team',withdraw?:boolean)=>void;prepare:(item:MarketItem,draft?:MarketIntent)=>Promise<void>;capabilities:()=>void;/** 原对象资源的上下文读取和管理端口，不再常驻市场目录。 */mine?:MyResourcesWiring;nativeSettings:()=>void;nativeModels:()=>void;openLocalModels?:(entryId:string)=>void;openLocalModel?:()=>void;openRole:(roleId:string)=>void;seed:TemplateSeed|null;clearSeed:()=>void;forceCategory?:{category:MarketBrowseKind;serial:number};onForceCategoryHandled?:((serial:number)=>void)|undefined;catalogEntryRequest?:{catalogId:string;serial:number};configureBinding:(intentId:string)=>void;targets:MarketTarget[];openTarget:(target:MarketTargetRef)=>void;navigationState?:Partial<MarketPageNavigationState>;onNavigationChange?:(state:MarketPageNavigationState)=>void;onCatalogReady?:(availableIds:string[])=>void}
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
    // 浏览目录只读安装事实；逐项运行诊断留给安装管理，避免每次进入扫描全部技能。
    void loadMarketSkillRuntime(props.skillInstallApi,props.skillAvailabilityApi,{verify:false}).then(value=>{if(active)setRuntime(value)})
    return()=>{active=false}
  },[props.visible,props.installations.visible,props.skillInstallApi,props.skillAvailabilityApi,runtimeRevision])
  return <>{props.visible&&props.industryResources&&<section className={clsx(base.page,css.page,props.inCapabilityCenter&&css.center)} aria-label={t('market.workspace.aria')}><div className={css.content}><div className={css.container}>{props.industryResources}</div></div></section>}{props.visible&&props.installations.visible&&<section className={clsx(base.page,css.page,css.maintenance,props.inCapabilityCenter&&css.center)} aria-label={t('market.installation.title')}>
    <div className={css.maintenanceShell}>
      <header className={css.maintenanceHeader}><ToolbarIconButton label={t('market.back')} icon={ArrowLeft} onClick={()=>props.installations.market(props.itemId??undefined)}/><h1>{t('market.installation.title')}</h1></header>
      <nav className={clsx(css.categories,css.maintenanceTabs)} aria-label={t('market.installation.categoryAria')}><button type="button" aria-current={mode==='skills'?'page':undefined} onClick={()=>props.installations.open('skill:directory')}>{t('composition.row.skill')}</button><button type="button" aria-current={mode==='plugins'?'page':undefined} onClick={()=>props.installations.open('plugin:directory')}>{t('market.apps.title')}</button></nav>
      <div className={css.maintenanceBody}>{mode==='plugins'?<MarketPluginInstallations embedded api={props.marketPluginInstallApi} selected={selected?.startsWith('plugin:')&&selected!=='plugin:directory'?selected.slice(7):null} select={id=>props.installations.open(id?'plugin:'+id:'plugin:directory')} onBrowse={()=>props.installations.market(props.itemId??undefined)}/>:<RealSkillInstallations embedded {...(props.skillUpgradeApi?{upgradeApi:props.skillUpgradeApi}:{})} {...(props.contentApi?{marketContentApi:props.contentApi}:{})} {...(props.skillAvailabilityApi?{availabilityApi:props.skillAvailabilityApi}:{})} filters={{query:installationQuery,filter:installationFilter,change:(query,filter)=>{setInstallationQuery(query);setInstallationFilter(filter)}}} api={props.skillInstallApi} selected={marketSkillInstallationSelection(selected)} select={id=>props.installations.open(id?'skill:'+id:'skill:directory')} onBrowse={()=>props.installations.market(props.itemId??undefined)}/>}</div>
    </div>
  </section>}{!props.industryResources&&<MarketCatalog {...props} runtime={runtime} runtimeChanged={()=>setRuntimeRevision(value=>value+1)}/>}</>
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
  const templateSharing=useTemplateShare(),templateCreation=props.mine?.pageCreate?{...props.mine.pageCreate,...(props.managedMcpConnectionApi?{mcp:props.managedMcpConnectionApi}:{})}:undefined
  const [creationKind,setCreationKind]=useState<MarketTemplateKind|null>(null),[creationVisited,setCreationVisited]=useState<MarketTemplateKind[]>([])
  const [resourceCreation,setResourceCreation]=useState<MarketResourceKind|null>(null),[resourceCreations,setResourceCreations]=useState<MarketResourceKind[]>([])
  const createResource=(kind:MarketResourceKind)=>{setResourceCreations(current=>current.includes(kind)?current:[...current,kind]);setResourceCreation(kind)}
  const {contentApi,visible,state,itemId,intentId,open,change,seed,clearSeed,navigationState,onNavigationChange}=props
  // 准备会话会先离开市场并卸载入口；收起窗口状态，原输入与待确认草案仍按原键保留。
  useEffect(()=>{if(!visible)setCreationKind(null)},[visible])
  const [atomicImport,setAtomicImport]=useState<'apps'|'market'|null>(null),atomicImportOwner=useRef({})
  const importOwners=useRef(new WeakMap<object,Map<MarketImportMode,MarketImportDraft>>()),templateDraft=useRef<TemplateInputDraft>()
  const importOwner=contentApi??props.githubSourceApi??atomicImportOwner.current,importDrafts=importOwners.current.get(importOwner)??new Map<MarketImportMode,MarketImportDraft>()
  importOwners.current.set(importOwner,importDrafts)
  const importOrigin=useRef({owner:importOwner,epoch:0});if(importOrigin.current.owner!==importOwner)importOrigin.current={owner:importOwner,epoch:importOrigin.current.epoch+1}
  const [kind,setKind]=useState<MarketBrowseKind>(navigationState?.category==='plugin'?'apps':navigationState?.category??'home'),[templateTaxonomy,setTemplateTaxonomy]=useState<TaxonomyFilter>({industry:null,fn:null}),[query,setQuery]=useState(navigationState?.query??''),[importMode,setImportMode]=useState<'upload'|'paste'|'github'|'conversation'|null>(null),[template,setTemplate]=useState(false),[error,setError]=useState(''),[recovering,setRecovering]=useState(false),[lastSelectedId,setLastSelectedId]=useState<string|undefined>(navigationState?.selectedId),[resourceDetailOpen,setResourceDetailOpen]=useState(navigationState?.mobileLayer==='detail')
  const [resourceFilters,setResourceFilters]=useState<MarketResourceFilters>(emptyMarketResourceFilters)
  const [detailReadFailed,setDetailReadFailed]=useState<string>()
  const [appsView,setAppsView]=useState<AppsView>(()=>({...initialAppsView,mine:navigationState?.appsMine??navigationState?.category==='resources',category:navigationState?.appsCategory??'all',query:navigationState?.category==='apps'?navigationState.query??'':''}))
  useEffect(()=>{if(kind==='apps')setAppsView(current=>current.query===query?current:{...current,query})},[kind,query])
  const [catalogNavigation,setCatalogNavigation]=useState<Array<{kind:'connection';catalogId:string;entry:MarketCatalogConnectorEntry}|{kind:'entry';catalogId:string}>>([])
  const catalogRoute=catalogNavigation.at(-1)
  const openCatalogConnection=(catalogId:string,entry:MarketCatalogConnectorEntry)=>setCatalogNavigation(history=>[...history,{kind:'connection',catalogId,entry}])
  const backCatalog=()=>setCatalogNavigation(history=>history.slice(0,-1))
  const [skillSecretsView,setSkillSecretsView]=useState<{skill:string;title:string}|null>(null)
  const [importMenuOpen,setImportMenuOpen]=useState(false)
  // 类别计数由页内目录区块读完目录后经 onCounts 回传，不另发请求
  const [catalogCounts,setCatalogCounts]=useState<MarketCatalogListCounts>()
  // 官方目录停在某条详情上时，本机列表与工具行收起，详情独占正文
  // 详情使用抽屉，列表与工具行保持原位置。
  const importMenuRef=useRef<HTMLDetailsElement>(null)
  useDismissible(importMenuRef,importMenuOpen,()=>setImportMenuOpen(false))
  const stateRef=useRef(state),changeRef=useRef(change),catalogReadyRef=useRef(props.onCatalogReady)
  /**
   * 受控页签请求：调用方（如业务台账「再加一类业务」）按 serial 递增表达「这一次要落在哪个页签」。
   * 与 `seed`/`clearSeed` 同一模式——只认新 serial，不干扰用户在市场页里自己切的页签与搜索词。
   */
  // 重挂载也必须消费当前请求；不能在实际应用类别之前就把 serial 标为已处理。
  const forcedCategorySerial=useRef<number|undefined>(props.forceCategory?.serial===0?0:undefined)
  useEffect(()=>{
    const forced=props.forceCategory
    if(!forced||forcedCategorySerial.current===forced.serial)return
    forcedCategorySerial.current=forced.serial
    props.onForceCategoryHandled?.(forced.serial)
    setKind(forced.category==='plugin'?'apps':forced.category)
    if(forced.category==='resources')setAppsView(current=>({...current,mine:true}))
    setCatalogNavigation([])
    setSkillSecretsView(null)
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
    setSkillSecretsView(null)
    setCatalogNavigation([{kind:'entry',catalogId:request.catalogId}])
  },[visible,props.catalogEntryRequest?.serial])
  stateRef.current=state;changeRef.current=change;catalogReadyRef.current=props.onCatalogReady
  // 市场保留历史版本用于审计，但目录、计数和方案内资源只投影每个模板的当前版本。
  const marketItems=mergeMarketItems([],state.items),currentCatalog=currentSolutionCatalog(marketItems)
  // 来源收口后的空目录保持真实空态，不重新补回已退出的旧行业推荐。本人已导入的原内容仍在 state.items。
  const builtinSolutions:MarketItem[]=[]
  // 导入回执、已加载资源与草稿都固定到具体内容；目录去重不能让这些历史来源的详情失效。
  const draft=state.intents.find(item=>item.id===intentId),selectedItemId=draft?.itemId||itemId,item=findMarketItem([...marketItems,...builtinSolutions],selectedItemId)
  const ambiguousItems=!item?matchingMarketItems(marketItems,selectedItemId):[]
  // 旧类别链接保留原资源范围；主入口只重组呈现，不改变对象与动作。首页即「AI 员工」；应用经工作台常驻入口到达。
  const primaryView:MarketPrimaryView|undefined=kind==='resources'?'apps':kind==='home'?'employees':kind==='all'||kind==='employees'||kind==='teams'||kind==='apps'?kind:undefined
  const directoryView=primaryView==='employees'||primaryView==='teams'
  const primarySearch=!!primaryView&&!!query.trim()
  const allCategory=primarySearch
  const solutionCategory=kind==='industry'
  const atomicCategory:MarketCategory=kind==='home'||kind==='all'||kind==='employees'||kind==='intents'?'agent':kind==='teams'?'industry':kind==='apps'||kind==='resources'?'connector':kind
  const resourceKinds:Array<'role'|'skill'|'knowledge'|'mcp'|'plugin'|'data-source'|'execution-tool'>|undefined=allCategory?['role','skill','knowledge','mcp','plugin','data-source','execution-tool']:primaryView==='apps'?['mcp','data-source','execution-tool']:primaryView==='teams'?[]:!solutionCategory&&kind!=='intents'?categoryResourceKinds[atomicCategory]:undefined
  const resourceSelectedRow=lastSelectedId&&resourceKinds?marketResourceIndex(currentCatalog).find(row=>row.key===lastSelectedId&&resourceKinds.some(kind=>kind===row.kind)):undefined
  const resourceSelectedKey=resourceSelectedRow?.key
  const inlineSelectedId=!item&&resourceDetailOpen&&(!resourceSelectedRow?.itemId||resourceSelectedRow.status==='conflict')?resourceSelectedKey:undefined
  const directoryFocus=useDirectoryFocus(visible,item?.id??inlineSelectedId)
  // 首页进入应用；主入口搜索覆盖原目录，旧类别链接仍限定原类型。
  // solutionView 是「正文就是方案卡」这一件事的唯一判据：页签高亮、窄屏分层、内容分支三处共用，不许各算各的。
  const solutionLanding=solutionCategory&&!query
  const solutionView=solutionLanding
  const mobileLayer:MarketPageNavigationState['mobileLayer']=item||inlineSelectedId?'detail':solutionView?'category':'list'
  const rememberNavigation=(patch:Partial<MarketPageNavigationState>)=>onNavigationChange?.({category:kind,query,selectedId:lastSelectedId,mobileLayer,appsMine:appsView.mine,appsCategory:appsView.category,...patch})
  useEffect(()=>{if(item?.id&&!resourceSelectedKey){setLastSelectedId(item.id);rememberNavigation({selectedId:item.id,mobileLayer:'detail'})}},[item?.id,resourceSelectedKey])
  const merge=(incoming:MarketItem[])=>{
    const current=stateRef.current,next=mergeMarketItems(current.items,incoming)
    changeRef.current({...current,items:next})
    return next
  }
  useEffect(()=>{
    if(!visible||!contentApi)return
    let active=true
    void contentApi.list().then(rows=>{if(active){const next=merge(rows);catalogReadyRef.current?.(marketItemNavigationIds(next))}}).catch(()=>{if(active)setError(t('market.content.directoryReadFailed'))})
    return()=>{active=false}
  },[visible,contentApi])
  useEffect(()=>{
    const storage=item?.contentStorage;if(!visible||!contentApi||!storage||storage.loaded)return
    let active=true
    setDetailReadFailed(undefined)
    void contentApi.hydrate(item).then(row=>{if(active)merge([row])}).catch(()=>{if(active){setDetailReadFailed(storage.contentId);setError(t('market.content.detailReadFailed'))}})
    return()=>{active=false}
  },[visible,contentApi,item?.contentStorage?.contentId,item?.contentStorage?.loaded])
  // Hook 与其依赖的 selectKind 须在下方提前 return 之前，否则 visible 切换时 Hook 数量变化（React #310）
  const selectKind=(next:MarketBrowseKind,apps?:Pick<MarketPageNavigationState,'appsMine'|'appsCategory'>)=>{const normalized=next==='plugin'?'apps':next;setKind(normalized);setCatalogNavigation([]);setSkillSecretsView(null);setResourceFilters(emptyMarketResourceFilters);setTemplateTaxonomy({industry:null,fn:null});setLastSelectedId(undefined);setResourceDetailOpen(false);open();setError('');rememberNavigation({category:normalized,selectedId:undefined,mobileLayer:normalized==='home'?'category':'list',...apps})}
  // 导航恢复到 model 而目录已无模型条目时回退首页，不留空白类别页
  useEffect(()=>{if(restoredMarketCategory(kind,catalogCounts)!==kind)selectKind('home')},[kind,catalogCounts])
  // 连接、资料、扩展等页面没有目录区块，计数等不到 onCounts 回传：挂载时补取一次（counts 按全量计算，一条即可），
  // 有目录区块的页面由区块读完目录后回传，不另发请求；读取失败只是暂不显示「模型」，区块页会再报错。
  // 每个类型页签只接同类型的官方目录：方案只列方案、连接只列连接器；资料、任务模板、扩展没有官方条目。
  const catalogKind=kind==='intents'?undefined:marketCategoryKind[solutionCategory?'industry':atomicCategory]
  const catalogKinds=primarySearch?undefined:primaryView==='all'?['role','solution','dashboard','connector','skill'] as const:primaryView==='apps'?['connector'] as const:primaryView==='employees'?['role','solution'] as const:primaryView==='teams'?['solution','dashboard'] as const:catalogKind?[catalogKind]:undefined
  const catalogSectionShown=!!primaryView||catalogKind!==undefined
  useEffect(()=>{
    const api=props.marketCatalogApi
    if(!visible||!api||catalogCounts||catalogSectionShown)return
    let active=true
    void api.list({marketplace:'teloa',limit:1}).then(value=>{if(active)setCatalogCounts(current=>current??value.counts)},()=>{})
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
      const current=stateRef.current,base={...current,items:mergeMarketItems(current.items,[target])}
      const id=crypto.randomUUID()
      const next=saveMarketIntent(base,{id,itemId:target.id,scope:target.scope,target:t('market.workspace.current'),purpose:t('market.solution.askFitDraft',{name:marketCatalogItemCopy(target,locale).title}),visibility:'personal',now:new Date().toISOString()})
      change(next)
      const draft=next.intents.find(row=>row.id===id)??next.intents.find(row=>row.itemId===target.id&&row.itemVersion===target.version&&row.status==='draft'&&!row.targetRef)
      return props.prepare(target,draft)
    },
  }
  const openSkillSecrets=(skill:string,title:string)=>setSkillSecretsView({skill,title})
  const skillSecrets=props.skillSecretsApi?{describe:props.skillSecretsApi.describe,open:openSkillSecrets}:undefined
  const skillSecretsDrawer=skillSecretsView&&props.skillSecretsApi?<ContextDrawer title={skillSecretsView.title} close={()=>setSkillSecretsView(null)}><SkillSecretsView key={skillSecretsView.skill} embedded skill={skillSecretsView.skill} title={skillSecretsView.title} api={props.skillSecretsApi} onBack={()=>setSkillSecretsView(null)}/></ContextDrawer>:null
  const catalogActions={
    solutionTeam,
    openRole:props.openRole,openModels:props.nativeModels,openLocalModel:props.openLocalModel,
    ...(props.openLocalModels?{openLocalModels:props.openLocalModels}:{}),
    ...(props.managedMcpConnectionApi?{openConnection:openCatalogConnection}:{}),
    ...(props.skillSecretsApi?{openSkillSecrets,describeSkillSecrets:props.skillSecretsApi.describe}:{}),
    ...(props.openLocalModels?{openRetrievalModel:(catalogId:string)=>props.openLocalModels!(catalogId)}:{}),
  }
  if(!visible)return null
  if(catalogRoute?.kind==='entry'&&props.marketCatalogApi)return <><MarketCatalogSection key={catalogRoute.catalogId} api={props.marketCatalogApi} onCounts={setCatalogCounts} {...catalogActions} initialEntryId={catalogRoute.catalogId} onBack={backCatalog} query="" openContent={async contentId=>{await openCatalogContent(contentId);setCatalogNavigation([])}}/>{skillSecretsDrawer}</>
  if(catalogRoute?.kind==='connection'&&props.managedMcpConnectionApi)return <McpConnectionView key={catalogRoute.catalogId} catalogId={catalogRoute.catalogId} entry={catalogRoute.entry} api={props.managedMcpConnectionApi} {...(props.marketCatalogApi?{catalogApi:props.marketCatalogApi,onOpenCatalog:(catalogId:string)=>setCatalogNavigation(history=>[...history,{kind:'entry',catalogId}])}:{})} onBack={backCatalog}/>
  if(props.installations.visible)return null
  // 搜索限定当前顶部分类，分类切换保留关键词，方便横向查找不同类型的资源。
  const listKind:MarketCategory=solutionCategory?'industry':atomicCategory
  const categoryItems=[...currentCatalog,...builtinSolutions].filter(item=>allCategory||(primaryView?marketPrimaryItem(item,primaryView):marketCategoryOf(item)===listKind))
  const rows=filterMarket(categoryItems,{kind:'all',scope:'all',visibility:'all',query,searchValues:item=>Object.values(localizedMarketItemCopy(item,locale))})
  // 本机条目：方案页是本机方案（库里没有自己的方案时是内置示例），其余页签是按类型汇总的本机资源行
  const localResourceRows=resourceKinds?.length?marketResourceIndex(currentCatalog).filter(row=>resourceKinds.some(kind=>kind===row.kind)):[]
  const itemById=(id:string|undefined)=>findMarketItem(currentCatalog,id)
  const tabLocalItems=resourceKinds?localResourceRows.flatMap(row=>currentCatalog.filter(item=>item.id===row.itemId)):rows
  // 「本机自带示例」说明只在当前页签确实列出了这类条目时出现
  // 正文停在详情上（官方条目详情，或统一列表里本机引用条目的摘要）时收起搜索行与常驻说明，免得详情上方留一块空白
  const inDetail=!primaryView&&!!inlineSelectedId
  const hasLocalFixedContent=!inDetail&&kind!=='intents'&&tabLocalItems.some(item=>marketCatalogItemCopy(item,locale).localFixed)
  // 官方推荐只读 Teloa 目录；本人导入和历史内容留在「已添加」及原深链，不能补进推荐列表。
  const builtinIds=new Set(builtinSolutions.map(item=>item.id))
  const solutionListRows=(items=rows):MarketListRow[]=>items.map(item=>{
    const copy=marketCatalogItemCopy(item,locale),manifest=isIndustryManifest(item.manifest)?item.manifest:undefined
    const contains=manifest?compositionSummary(composeFromManifest(manifest),t,value=>value.toLocaleString(locale)):''
    // 团队方案卡第三行先写「N 位 AI 员工」（原型 B card-meta），员工卡写作者
    const members=solutionRoleCount(item)??0
    return {key:item.id,title:copy.title,summary:copy.summary,credit:members>1?t('market.primary.teamMembers',{count:members.toLocaleString(locale)}):item.author,group:t(marketItemGroup(item)),facts:contains?t('market.solution.contains' as Parameters<typeof t>[0],{list:contains}):marketItemPresentation(item,props.industryLoads.loads,props.runtime,t).source,
      tag:builtinIds.has(item.id)?t('market.solution.builtinTag'):t('market.catalog.localTag'),mark:allCategory||primaryView?marketItemMark(item,props.industryLoads.loads,props.runtime):solutionMark({loaded:solutionAdded(item,props.industryLoads.loads),restartRequired:false}),
      art:{kind:allCategory||primaryView?marketCategoryOf(item):'industry',seed:item.id},taxonomy:marketItemTaxonomy(item),open:()=>openItem(item.id),current:lastSelectedId===item.id,...(item.contentStorage?{contentId:item.contentStorage.contentId}:{})}
  })
  const resourceListRows=():MarketListRow[]=>filterMarketResources(localResourceRows,{kind:'all',query,referencedIndustry:'all',capability:'all',searchValues:row=>[localizedMarketResourceEntryTitle(row,locale),...row.uses.map(use=>localizedMarketResourceUseTitle(use,locale))]}).map(row=>{
    const item=itemById(row.itemId),copy=item?marketCatalogItemCopy(item,locale):{title:localizedMarketResourceEntryTitle(row,locale),summary:''},presentation=marketResourcePresentation(row,item,props.runtime,t)
    // 实体条目直达正式详情；只被方案引用的条目与身份冲突的条目仍先看摘要（由本机资源目录的详情给出）
    return {key:row.key,title:copy.title,summary:copy.summary,credit:item?.author??presentation.source,group:t(marketResourceGroup(row.kind)),facts:presentation.scope+' · '+presentation.source,tag:t('market.catalog.localTag'),addable:row.status!=='reference'&&row.status!=='conflict',mark:row.status==='reference'?null:marketResourceMark(row,item,props.runtime),
      art:{kind:row.kind,seed:row.key},taxonomy:resourceEntryTaxonomy(row,item,itemById),open:()=>row.itemId&&row.status!=='conflict'?openResourceItem(row.itemId):selectResource(row.key,true),current:lastSelectedId===row.key,...(item?.contentStorage?{contentId:item.contentStorage.contentId}:{})}
  })
  // 主目录已经呈现完整员工包时，不再把其内部引用画成第二张卡；搜索未覆盖的引用与原资源目录仍保留。
  const primaryRows=[...solutionListRows(),...resourceListRows().filter(row=>{
    const entry=localResourceRows.find(entry=>entry.key===row.key)
    return !rows.some(item=>item.id===entry?.itemId||entry?.status==='reference'&&entry.uses.some(use=>use.templateId===item.id))
  })]
  const searchControl=<label className={clsx(css.globalSearch,(primaryView||kind==='skill')&&css.lightSearch)}><Search size={16}/><input aria-label={t('market.search.aria')} value={query} onChange={event=>{setQuery(event.target.value);rememberNavigation({query:event.target.value})}} placeholder={t(directoryView?'market.primary.directorySearch':primaryView?'market.primary.search':props.inCapabilityCenter?'capabilityCenter.searchDiscover':'market.search.placeholder')}/>{query&&<button type="button" onClick={()=>{setQuery('');rememberNavigation({query:''})}}>{t('market.search.clear')}</button>}</label>
  const officialSection=(primaryView||allCategory||catalogKind)&&props.marketCatalogApi?<MarketCatalogSection search={primaryView?searchControl:undefined} presentation={primarySearch?undefined:primaryView} cardLayout={!!primaryView||!!props.inCapabilityCenter} key={primarySearch?'search':primaryView??catalogKind} api={props.marketCatalogApi} onCounts={setCatalogCounts} {...catalogActions} query={query} openContent={openCatalogContent} kinds={catalogKinds} onResetQuery={()=>{setQuery('');rememberNavigation({query:''})}} localRows={[]} label={primaryView?t(primaryView==='all'?'market.primary.all':primaryView==='apps'?'market.primary.apps':primaryView==='employees'?'market.primary.employees':'market.primary.teams'):allCategory?t('market.primary.all'):marketCategoryLabel(t,listKind)}/>:null
  const templateRows=filterTaxonomyRows(rows,marketItemTaxonomy,templateTaxonomy)
  const primaryFilteredRows=filterTaxonomyRows(primaryRows,row=>row.taxonomy,templateTaxonomy)
  const localTemplates=currentCatalog.filter(item=>marketCategoryOf(item)==='work-template')
  const nativeApps=currentCatalog.filter(item=>item.resourceKind==='plugin'&&(!query.trim()||[localizedMarketItemCopy(item,locale).title,item.summary].some(value=>value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))))
  const addedSolutions=currentCatalog.filter(item=>solutionAdded(item,props.industryLoads.loads))
  const addedCount=addedSolutions.length
  const storedAppContents=marketItems.flatMap<AppsStoredContent>(item=>{
    const contentId=item.contentStorage?.contentId,contentHash=item.packageContent?.hash??item.hash
    if(item.source.kind!=='stored'||!contentId||!contentHash)return []
    const atomic=item.kind==='skill',manifest=isIndustryManifest(item.manifest)?item.manifest:undefined
    if(!atomic&&(!manifest||manifest.resources.some(resource=>resource.kind==='role')||!manifest.resources.some(resource=>['skill','mcp','plugin'].includes(resource.kind))))return []
    const copy=localizedMarketItemCopy(item,locale)
    return [{itemId:item.id,contentId,contentHash,kind:atomic?'skill':'bundle',title:copy.title,summary:copy.summary,version:item.version,publisher:item.author}]
  })
  const saveItem=(incoming:MarketItem,chat=false)=>{
    if(importMode)importDrafts.delete(importMode)
    if(template&&!seed)templateDraft.current=undefined
    const current=stateRef.current,items=mergeMarketItems(current.items,[incoming]),item=items.find(row=>sameMarketItem(row,incoming))!
    change({...current,items});setImportMode(null);setAtomicImport(null);setTemplate(false);clearSeed();open(item.id)
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
      // 空库内置示例也须先带上原对象，问答草稿才能绑定原版本；这一步不加载、安装或授权。
      const current=stateRef.current,base={...current,items:mergeMarketItems(current.items,[target])}
      const next=saveMarketIntent(base,{id,itemId:target.id,scope:target.scope,target:t('market.workspace.current'),purpose,visibility:'personal',now:new Date().toISOString()})
      change(next)
      // saveMarketIntent 遇到同一份等价草稿会原样返回旧状态，这时取那条既有草稿，不新开一条。
      const draft=next.intents.find(row=>row.id===id)??next.intents.find(row=>row.itemId===target.id&&row.itemVersion===target.version&&row.status==='draft'&&!row.targetRef)
      setLastSelectedId(target.id);open(target.id,draft?.id)
      void props.prepare(target,draft).catch(error=>setError(localizeWorkError(locale,error)))
    }catch(error){setError(localizeWorkError(locale,error))}
  }
  const resourceDrawer=primaryView&&inlineSelectedId&&resourceSelectedRow&&resourceKinds?.length?<ContextDrawer title={localizedMarketResourceEntryTitle(resourceSelectedRow,locale)} close={()=>selectResource(undefined)} className={css.detailDrawer??''}><MarketResourceCatalog detailOnly hideTitle filters={resourceFilters} onFiltersChange={setResourceFilters} items={currentCatalog} kind={atomicCategory==='agent'?'role':atomicCategory==='skill'?'skill':'resource'} resourceKinds={resourceKinds} query={query} hideQuery selectedId={resourceSelectedRow.key} detailOpen onSelectedChange={selectResource} open={openResourceItem} runtime={props.runtime} openInstallation={id=>props.installations.open('skill:'+id)}/></ContextDrawer>:null
  const itemDrawer=item?<ContextDrawer title={localizedMarketItemCopy(item,locale).title} close={()=>{open();setResourceDetailOpen(false);rememberNavigation({selectedId:lastSelectedId,mobileLayer:'list'})}} className={css.detailDrawer??''}><MarketDetail key={draft?.id||item.id} {...props} item={item} draft={draft} contentReadFailed={!!item.contentStorage&&detailReadFailed===item.contentStorage.contentId} back={()=>{const selected=resourceSelectedKey?marketResourceIndex(currentCatalog).find(row=>row.key===resourceSelectedKey):undefined,showSummary=!!selected&&(!selected.itemId||selected.status==='conflict');open();setResourceDetailOpen(showSummary);rememberNavigation({selectedId:resourceSelectedKey??lastSelectedId,mobileLayer:showSummary?'detail':solutionCategory?'category':'list'})}}/></ContextDrawer>:null
  // 新入口按用户想创建的对象分层；兼容的文件格式只在导入内按需选择。
  const fromCreateMenu=(action:()=>void)=>{importMenuRef.current?.querySelector('summary')?.focus();setImportMenuOpen(false);action()}
  const createTemplate=(kind:MarketTemplateKind)=>fromCreateMenu(()=>{setCreationVisited(current=>current.includes(kind)?current:[...current,kind]);setCreationKind(kind)})
  const importTools=<details ref={importMenuRef} className={css.toolMenu} open={importMenuOpen} onToggle={event=>setImportMenuOpen(event.currentTarget.open)}><summary aria-label={t('capabilityCenter.createOrImport')} title={t('capabilityCenter.createOrImport')}>{t('market.create.action')}</summary><div>{templateSharing&&templateCreation&&<><button type="button" onClick={()=>createTemplate('employee')}>{t('market.create.employee')}</button><button type="button" onClick={()=>createTemplate('team')}>{t('market.create.team')}</button></>}<button type="button" onClick={()=>fromCreateMenu(()=>setImportMode('upload'))}>{t('market.import.industry')}</button><button type="button" onClick={()=>fromCreateMenu(()=>setAtomicImport('market'))}>{t('market.import.skill')}</button></div></details>
  return <section className={clsx(base.page,css.page,props.inCapabilityCenter&&css.center)} data-mobile-layer={mobileLayer} aria-label={t('market.workspace.aria')}><div {...directoryFocus} className={css.content}><div className={css.container}>
    {/* 1.0 页头（设计稿 10）：标题与一句说明；右侧「已添加 · N」为文字入口，「创建」为主按钮并展开创建或导入菜单。「我的应用与技能」在页头作为次要入口。 */}
    <header className={css.pageHeader}><div><h1>{t('market.title')}</h1><p className={css.subtitle}>{t('market.subtitle')}</p></div><div className={css.headerActions}><button type="button" className={css.addedBadge} aria-pressed={primaryView==='apps'&&appsView.mine} onClick={()=>{setAppsView(current=>({...current,mine:true}));selectKind('apps',{appsMine:true,appsCategory:appsView.category})}}>{t('market.apps.mineTitle')}</button><button type="button" className={css.addedBadge} onClick={()=>selectKind('intents')}>{t('market.addedCount',{count:addedCount})}</button>{kind!=='intents'&&!inDetail&&importTools}</div></header>
    {/* 1.0：分类页签为 全部 / AI 员工 / AI 团队 / 应用 / 技能（2026-10-20 用户定稿，不另设「行业模板」页签）；进入应用仍保留市场页头与分类，技术类别保留对象深链。 */}
    <div className={css.primaryNavigation}><nav className={css.categories} aria-label={t('market.category.aria')}><button type="button" aria-current={primaryView==='all'?'page':undefined} onClick={()=>selectKind('all')}>{t('market.primary.all')}</button><button type="button" aria-current={primaryView==='employees'||kind==='agent'?'page':undefined} onClick={()=>selectKind('employees')}>{t('market.primary.employees')}</button><button type="button" aria-current={primaryView==='teams'?'page':undefined} onClick={()=>selectKind('teams')}>{t('market.primary.teams')}</button><button type="button" aria-current={primaryView==='apps'?'page':undefined} onClick={()=>selectKind('apps')}>{t('market.apps.title')}</button><button type="button" aria-current={kind==='skill'?'page':undefined} onClick={()=>selectKind('skill')}>{marketCategoryLabel(t,'skill')}</button></nav></div>
    {!primaryView&&kind!=='intents'&&kind!=='skill'&&<h2 className={css.secondaryTitle}>{marketCategoryLabel(t,atomicCategory)}</h2>}
    {kind==='skill'&&<p className={css.catalogNotice}>{t('market.primary.skillHint')}</p>}
    {hasLocalFixedContent&&<p className={css.catalogBoundary} role="note">{t('market.catalog.localFixedBoundary')}</p>}
    {kind!=='intents'&&!inDetail&&!primaryView&&<div className={css.toolRow}>{searchControl}{askItem&&<button type="button" className={css.askAction} onClick={()=>ask(askItem)}><MessageSquare size={15}/>{t('market.solution.ask')}</button>}</div>}
    {/* 原型 `市场方案.jsx` 工具行下方的常驻说明：内容从哪来、添加意味着什么 */}
    {error&&<div className={base.error} role="alert">{error}<button type="button" onClick={()=>setError('')}>{t('market.error.close')}</button></div>}
    <div data-teloa-pane={inlineSelectedId&&!primaryView?'detail':'directory'} tabIndex={-1} className={css.catalogBody}>{!item&&(itemId||intentId)?<div className={base.empty}><h2>{t(ambiguousItems.length?'market.catalog.source':'market.content.notFound')}</h2>{ambiguousItems.map(row=><button type="button" key={row.id} onClick={()=>openItem(row.id)}>{localizedMarketItemCopy(row,locale).title} · {row.author} · {row.license}</button>)}<ToolbarIconButton label={t('market.back')} icon={ArrowLeft} onClick={()=>open()}/></div>:kind==='intents'?<section className={css.collection}><header><h2>{t('market.solution.addedTab' as Parameters<typeof t>[0])}</h2></header>
            {/* UI-012：已添加的包/员工要能从这里直接进入真实加载详情做更新与卸载，并看清当前加载版本。 */}
            {props.industryLoads.loads.filter(load=>load.status==='active').map(load=>{const latest=addedSolutions.find(item=>isIndustryManifest(item.manifest)&&item.manifest.id===load.templateId)?.version,newer=latest!==undefined&&latest!==load.templateVersion;return <div className={base.buttons} key={load.id}><button type="button" onClick={()=>props.manageIndustryLoad(load.id)}>{t('market.solution.manageLoaded')}</button><small>{load.templateTitle} · v{load.templateVersion}{newer?' · '+t('market.solution.catalogNewerVersion',{version:latest}):''}</small></div>})}
            {addedSolutions.length?<MarketListRows rows={solutionListRows(addedSolutions).map(row=>({...row,requirements:row.facts}))} layout="cards"/>:!localTemplates.length&&!storedAppContents.length?<div className={base.empty}><h2>{t('market.solution.addedEmptyTitle' as Parameters<typeof t>[0])}</h2><p>{t('market.solution.addedEmptyDescription' as Parameters<typeof t>[0])}</p><button type="button" onClick={()=>selectKind('home')}>{t('market.solution.browseSolutions' as Parameters<typeof t>[0])}</button></div>:null}{localTemplates.length>0&&<section className={css.localTemplates} aria-label={t('capabilityCenter.localTemplates')}><h3>{t('capabilityCenter.localTemplates')}</h3><MarketCards items={localTemplates} loads={props.industryLoads.loads} runtime={props.runtime} selectedId={lastSelectedId} open={openItem}/></section>}</section>:primaryView==='apps'&&props.marketCatalogApi?<MarketAppsDirectory skillSecrets={skillSecrets} catalogApi={props.marketCatalogApi} connectionApi={props.managedMcpConnectionApi} installationApi={props.skillInstallApi} storedContents={storedAppContents} loads={props.industryLoads.loads} packages={currentCatalog.flatMap(item=>{if(!isIndustryManifest(item.manifest))return [];const contentHash=item.packageContent?.hash??(item.contentStorage?.loaded===false?item.hash:undefined);return [{id:item.id,manifest:item.manifest,...(item.contentStorage&&contentHash?{source:{contentId:item.contentStorage.contentId,contentHash}}:{}),...(item.packageContent?{content:item.packageContent}:{})}]})} view={appsView} onViewChange={next=>{setAppsView(next);setQuery(next.query);rememberNavigation({query:next.query,appsMine:next.mine,appsCategory:next.category})}} openConnection={openCatalogConnection} openContent={async contentId=>{await openCatalogContent(contentId);setAppsView(({detail,...rest})=>rest)}} openPackage={id=>{openItem(id);setAppsView(({detail,...rest})=>rest)}} onImportSkill={()=>setAtomicImport('apps')} {...(templateCreation?{onCreateSkill:()=>createResource('skill'),onCreateApp:()=>createResource('app')}:{})} {...(nativeApps.length&&appsView.category==='all'&&!appsView.mine?{nativeApps:<MarketCards items={nativeApps} loads={props.industryLoads.loads} runtime={props.runtime} selectedId={lastSelectedId} open={openItem}/>}:{})} onManagePlugins={()=>props.installations.open('plugin:directory')}/>:primaryView?<section className={css.sectionStack}>{officialSection??<><MarketFilterBar compact simple rows={primaryRows} tags={row=>row.taxonomy} filter={templateTaxonomy} onChange={setTemplateTaxonomy}/>{searchControl}{(!!query.trim()||templateTaxonomy.fn!==null||templateTaxonomy.industry!==null)&&<MarketResultLine count={primaryFilteredRows.length}/>}{primaryFilteredRows.length?<MarketListRows rows={primaryFilteredRows} layout="cards" showGroups={!!query.trim()}/>:<MarketEmpty filtered={!!query.trim()||templateTaxonomy.fn!==null||templateTaxonomy.industry!==null} onReset={()=>{setTemplateTaxonomy({industry:null,fn:null});setQuery('');rememberNavigation({query:''})}}/>}</>}</section>:allCategory?<section className={css.sectionStack}>{officialSection??<MarketCards items={rows} loads={props.industryLoads.loads} runtime={props.runtime} selectedId={lastSelectedId} open={openItem}/>}</section>:solutionCategory?<section className={css.sectionStack}>{officialSection??<div className={css.collection}>{query&&<header><div><h2>{t('market.search.resultsTitle')}</h2><p>{marketCountText(t,locale,'search',rows.length)}</p></div></header>}{!query&&!!builtinSolutions.length&&<header><div><h2>{t('market.solution.builtinTitle')}</h2><p>{t('market.solution.builtinNotice')}</p></div></header>}{solutionCards}{!rows.length&&<div className={base.empty}><h2>{t('market.search.empty')}</h2><p>{t('market.search.emptyHint')}</p></div>}</div>}</section>:<div className={css.sectionStack}>{officialSection?<>{inlineSelectedId&&resourceKinds?.length?<MarketResourceCatalog detailOnly filters={resourceFilters} onFiltersChange={setResourceFilters} key={atomicCategory} items={currentCatalog} kind={atomicCategory==='agent'?'role':atomicCategory==='skill'?'skill':'resource'} resourceKinds={resourceKinds} query={query} onQueryChange={value=>{setQuery(value);rememberNavigation({query:value})}} hideQuery {...(resourceSelectedKey?{selectedId:resourceSelectedKey}:{})} detailOpen={resourceDetailOpen} onSelectedChange={selectResource} open={openResourceItem} runtime={props.runtime} openInstallation={id=>props.installations.open('skill:'+id)}/>:null}<div hidden={!!inlineSelectedId}>{officialSection}</div></>:resourceKinds?.length===0?null:resourceKinds?<div className={css.collection}><MarketResourceCatalog filters={resourceFilters} onFiltersChange={setResourceFilters} key={atomicCategory} items={currentCatalog} kind={atomicCategory==='agent'?'role':atomicCategory==='skill'?'skill':'resource'} resourceKinds={resourceKinds} query={query} onQueryChange={value=>{setQuery(value);rememberNavigation({query:value})}} hideQuery {...(resourceSelectedKey?{selectedId:resourceSelectedKey}:{})} detailOpen={resourceDetailOpen} onSelectedChange={selectResource} open={openResourceItem} runtime={props.runtime} openInstallation={id=>props.installations.open('skill:'+id)}/></div>:<div className={css.listStack}><MarketFilterBar rows={rows} tags={marketItemTaxonomy} filter={templateTaxonomy} onChange={setTemplateTaxonomy}/>{templateRows.length>0&&<><MarketResultLine count={templateRows.length}/><MarketCards items={templateRows} loads={props.industryLoads.loads} runtime={props.runtime} selectedId={lastSelectedId} open={openItem}/></>}{!templateRows.length&&<MarketEmpty filtered={categoryItems.length>0} onReset={()=>{setTemplateTaxonomy({industry:null,fn:null});setQuery('');rememberNavigation({query:''})}}/>}</div>}</div>} </div>
    {kind==='resources'&&props.mine&&<ContextDrawer title={t(props.mine.navigationState?.category==='source'?'capabilityCenter.connectors':props.mine.navigationState?.category==='extension'?'market.apps.title':props.mine.navigationState?.category==='method'?'composition.row.method':'composition.row.skill')} close={()=>selectKind('apps')}><TeamCapabilitiesPage key={props.forceCategory?.serial} {...props.mine} contextual visible openMarket={()=>selectKind('home')}/></ContextDrawer>}
    {(contentApi?.pending()||contentApi?.pendingGithubImport())&&<section className={css.contextBar} aria-label={t('market.content.pendingImport')}><strong>{t('market.content.pendingImport')}</strong><div className={css.contextBody}>{contentApi?.pending()&&<button type="button" disabled={recovering} onClick={()=>{setRecovering(true);setError('');void contentApi.recover().then(row=>saveItem(row)).catch(()=>setError(t('market.content.importVerificationFailed'))).finally(()=>setRecovering(false))}}>{recovering?t('market.content.verifyingImport'):t('market.import.reviewIncomplete')}</button>}{contentApi?.pendingGithubImport()&&<><span>{t('market.content.pendingGithubImport')}{contentApi.pendingGithubImport()!.manifestPath}</span><button type="button" disabled={recovering} onClick={()=>{setRecovering(true);setError('');void contentApi.recoverGithubImport().then(row=>saveItem(row)).catch(error=>setError(localizeWorkError(locale,error))).finally(()=>setRecovering(false))}}>{recovering?t('market.content.verifyingImport'):t('market.content.reviewGithubImport')}</button></>}</div></section>}
  </div></div>{itemDrawer}{resourceDrawer}{skillSecretsDrawer}{templateCreation&&creationVisited.map(kind=><MarketTemplateCreator key={kind} kind={kind} open={creationKind===kind} close={()=>setCreationKind(null)} creation={templateCreation}/>)}{templateCreation&&resourceCreations.map(kind=><MarketResourceCreator key={kind} kind={kind} open={resourceCreation===kind} close={()=>setResourceCreation(null)} creation={templateCreation} browse={()=>{setResourceCreation(null);selectKind('apps')}}/>)}{atomicImport&&<AtomicSkillImport entryKey={atomicImport} draftOwner={atomicImportOwner.current} {...(contentApi?{contentApi}:{})} close={()=>setAtomicImport(null)} save={item=>saveItem(item)}/>} {importMode&&<MarketImportForm key={importOrigin.current.epoch+':'+importMode} githubSourceApi={props.githubSourceApi} marketCatalogApi={props.marketCatalogApi} openConnection={props.managedMcpConnectionApi?(catalogId,entry)=>{setImportMode(null);openCatalogConnection(catalogId,entry)}:undefined} draft={importDrafts.get(importMode)} onDraft={draft=>importDrafts.set(importMode,draft)} items={state.items} {...(contentApi?{contentApi}:{})} saveMany={incoming=>{importDrafts.delete(importMode);const current=stateRef.current;change({...current,items:mergeMarketItems(current.items,incoming)});setImportMode(null);setKind('home');setQuery('');setTemplateTaxonomy({industry:null,fn:null});open()}} mode={importMode} close={()=>setImportMode(null)} save={saveItem}/>} {(template||seed)&&<TemplateForm seed={seed||undefined} draft={seed?undefined:templateDraft.current} onDraft={seed?undefined:draft=>{templateDraft.current=draft}} spaces={props.spaces} close={()=>{setTemplate(false);clearSeed()}} save={saveItem}/>}</section>
}
function MarketDetail({item,draft,back,contentReadFailed,...props}:MarketProps&{runtime:MarketSkillRuntime;runtimeChanged?:()=>void;item:MarketItem;draft:MarketIntent|undefined;back:()=>void;contentReadFailed?:boolean}){
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
  // 官方看板包的安装包只有原文标题；新建业务的默认名称取同一官方目录条目（包 id 与版本均一致）的多语言标题。
  const [catalogDashboardTitle,setCatalogDashboardTitle]=useState<Parameters<typeof catalogText>[0]>()
  const needsConnectors=isIndustryManifest(item.manifest)&&!!item.packageContent&&item.manifest.resources.some(resource=>resource.kind==='mcp')
  const dashboardPackageId=isIndustryManifest(item.manifest)&&item.manifest.resources.some(resource=>resource.kind==='business-configuration')?item.manifest.id:undefined
  const dashboardPackageVersion=dashboardPackageId&&isIndustryManifest(item.manifest)?item.manifest.version:undefined
  useEffect(()=>{
    if((!needsConnectors&&!dashboardPackageId)||!props.marketCatalogApi)return
    let active=true
    void loadCatalogListing(props.marketCatalogApi,'teloa').then(value=>{
      if(!active)return
      setCatalogConnectors(value.items.flatMap(row=>row.entry.kind==='connector'?[row.entry]:[]))
      const dashboard=value.items.find(row=>row.entry.kind==='dashboard'&&row.entry.dashboard.packageId===dashboardPackageId&&row.entry.version===dashboardPackageVersion)?.entry
      if(dashboard?.kind==='dashboard')setCatalogDashboardTitle(dashboard.dashboard.title)
    },()=>{})
    return()=>{active=false}
  },[props.marketCatalogApi,needsConnectors,dashboardPackageId,dashboardPackageVersion])
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
  const intent=draft?<IndustryIntentPanel item={item} draft={draft} market={props} selectedTarget={selectedTarget} setSelectedTarget={setSelectedTarget} selected={selected} scope={scope} setScope={setScope} purpose={purpose} setPurpose={setPurpose} visibility={visibility} setVisibility={setVisibility} check={check} targetBlocked={targetBlocked} save={save} setError={setError}/>:null
  const message=error||draft?.preparation?.status==='failed'?error||t('market.conversation.prepareFailed'):''
  if(item.atomicSkill||item.kind==='skill'&&item.contentStorage){
    const skill=item.atomicSkill,repository=item.trust?.repository,readFailed=contentReadFailed||!props.contentApi
    const presentation=marketItemPresentation(item,props.industryLoads.loads,props.runtime,t)
    return <article className={css.detail} aria-label={t('market.detail.aria')}>
      <ToolbarIconButton label={t('market.catalog.back')} icon={ArrowLeft} onClick={back}/>
      <p>{copy.summary}</p>
      {skill&&item.contentStorage?.loaded&&<SkillInstallControl key={'atomic-'+item.contentStorage.contentId} {...(props.runtimeChanged?{changed:props.runtimeChanged}:{})} api={props.skillInstallApi} source={{kind:'atomic',contentId:item.contentStorage.contentId}} title={copy.title}/>}
      {/* BIZ-006：装好的技能不能只停在对可用性一次核对；用观测到的真实安装身份进入安装管理，查看版本、升级目标与影响。 */}
      {(item.kind==='skill'||!!item.atomicSkill)&&<div className={base.buttons}><button type="button" onClick={()=>props.installations.open(presentation.installationId?'skill:'+presentation.installationId:'skill:directory')}>{t('market.skill.manageInstalled')}</button></div>}
      {skill?<section className={css.sheet} aria-label={t('market.skill.atomicContentAria')}><h3>{t('market.skill.contentTitle')}</h3><p>{t('market.skill.originalContentSavedNotice')}</p><pre>{skill.text}</pre><details><summary>{marketCountText(t,locale,'attachment',skill.files.length)}</summary><ul>{skill.files.map(file=><li key={file.path}>{file.path} · {file.bytes.length} {t('market.skill.fileSizeBytesUnit')}</li>)}</ul></details></section>:<p role={readFailed?'alert':'status'}>{t(readFailed?'market.content.detailReadFailed':'market.apps.readingSkillContent')}</p>}
      <details className={css.provenance}><summary>{t('market.solution.provenance')}</summary><dl>
        <dt>{t('market.template.author')}</dt><dd>{copy.author}</dd><dt>{t('market.template.license')}</dt><dd>{copy.license}</dd>
        <dt>{t('market.industry.templateLabel')}</dt><dd>v{item.version}</dd><dt>{t('market.catalog.source')}</dt><dd>{repository?<a href={'https://github.com/'+repository.owner+'/'+repository.repo} target="_blank" rel="noreferrer">{repository.owner+'/'+repository.repo}</a>:sourceLabel(item.source,t)}</dd>
      </dl></details>
    </article>
  }
  if(isIndustryManifest(item.manifest)){
    const manifest=item.manifest
    const pendingLoad=props.industryLoads.api?.pending()
    // 未知回执属于原固定内容；已有加载不能遮住核对入口，也不能借另一份同名模板替换原请求。
    const recoveringCurrentLoad=!!pendingLoad&&pendingLoad.contentId===item.contentStorage?.contentId&&pendingLoad.contentHash===(item.packageContent?.hash??item.hash)
    // 与方案卡共用 solutionInstalled：逐条过一遍，既拿到「是否已添加」，也保留要列出的那几条生效加载。
    const matchingLoads=props.industryLoads.loads.filter(load=>solutionInstalled(item,[load]))
    const currentStatus=matchingLoads.length?t('market.workspace.loadedPersonal'):item.contentStorage?.loaded?t('market.content.fixedNotLoaded'):item.packageContent?t('market.content.readNotFixed'):item.hash?t('market.manifest.parsedContentPending'):item.source.kind==='builtin'?t('market.source.builtinNotLoaded'):t('market.source.savedContentUnavailable')
    // 「添加后你会得到」按业务结构七行分节：顺序、主标签、副标、计数单位与附注全部来自共享模块，不在这里另写一份分类。
    const rows=composeFromManifest(manifest)
    const members=solutionMembers(manifest,locale,manifest.id)
    const readOnlyConnections=localReadOnlyConnections(manifest,item.packageContent,catalogConnectors)
    const number=(value:number)=>value.toLocaleString(locale)
    return <article className={clsx(css.detail,css.industryDetail)} aria-label={t('market.detail.aria')}>
      <ToolbarIconButton className={css.backLink} label={t('market.solution.back')} icon={ArrowLeft} onClick={back}/>
      <header className={css.solutionHero} aria-label={t('market.industry.overviewAria')}>
        <p>{copy.summary}</p>
        {/* 一键添加就是今天 industryLoads.loadWorkspace 那个按钮：只换文案与位置，展开逻辑一字不改（走既有 IndustryLoadForm 两段式）。 */}
        {(recoveringCurrentLoad||!manifest.resources.every(row=>row.kind==='business-configuration'))&&<button className={css.primaryAction} type="button" disabled={!!matchingLoads.length&&!recoveringCurrentLoad} aria-expanded={actionPanel==='load'} onClick={()=>setActionPanel('load')}>{recoveringCurrentLoad?t('market.industry.load.reviewResult'):matchingLoads.length?t('market.solution.added'):t('market.industry.loadWorkspace')}{matchingLoads.length&&!recoveringCurrentLoad?<Check size={15}/>:<Plus size={15}/>}</button>}
        <SolutionLoadLinks loads={matchingLoads} manage={props.manageIndustryLoad}/>
        <button type="button" disabled={busy||targetBlocked||draft?.status==='withdrawn'||draft?.preparation?.status==='pending'} onClick={()=>void prepare(t('market.solution.askFitDraft',{name:copy.title}))}><MessageSquare size={13}/>{t('market.solution.askFit')}</button>
      </header>
      {message&&<p role="alert" className={css.notice}>{message}</p>}{notice&&<p role="status">{notice}</p>}
      {props.dashboardResources&&manifest.resources.some(row=>row.kind==='business-configuration')&&<BusinessDashboardMarketPanel key={item.id} item={item} {...(catalogDashboardTitle?{defaultTitle:catalogText(catalogDashboardTitle,locale)}:{})} api={props.dashboardResources} {...(props.openConnections?{openConnections:props.openConnections}:{})} refreshScopes={props.refreshScopes} spaces={props.spaces} colorScheme={props.colorScheme??'light'} {...(props.contentApi?{upgrade:(adoption:Parameters<NonNullable<import('./BusinessDashboardMarketPanel.js').BusinessDashboardMarketPanelProps['upgrade']>>[0])=><BusinessDashboardUpgradePanel item={item} candidates={props.state.items} api={props.dashboardResources!} {...(props.openConnections?{openConnections:props.openConnections}:{})} refreshScopes={props.refreshScopes} adoption={adoption} hydrate={value=>props.contentApi!.hydrate(value)} spaces={props.spaces} colorScheme={props.colorScheme??'light'} {...(props.openBusiness?{openSaved:props.openBusiness}:{})}/>}:{})} {...(props.openBusiness?{openSaved:props.openBusiness}:{})}/>}
      {actionPanel==='load'?<SolutionLoadPanel {...props} item={item} close={()=>setActionPanel(null)}/>:actionPanel?<section className={css.actionWorkspace} aria-label={t('market.intent.configurePanelAria')}>
        <header><div><span className={css.eyebrow}>{t('market.template.useEyebrow')}</span><h3>{draft?t('market.intent.view'):t('market.intent.create')}</h3></div><ToolbarIconButton label={t('market.template.backToContent')} icon={ArrowLeft} onClick={()=>setActionPanel(null)}/></header>
        <IndustryIntentPanel item={item} draft={draft} market={props} selectedTarget={selectedTarget} setSelectedTarget={setSelectedTarget} selected={selected} scope={scope} setScope={setScope} purpose={purpose} setPurpose={setPurpose} visibility={visibility} setVisibility={setVisibility} check={check} targetBlocked={targetBlocked} save={save} setError={setError}/>
      </section>:<>
        <h2>{t('market.solution.youGet')}</h2>
        <MarketTemplateDetails sections={rows.filter(row=>row.count>0).map(row=>{
          const meta=COMPOSITION_ROWS.find(value=>value.id===row.id)!
          // 附注只有两行有：任务模板说自动化与动作的分布，扩展说它是工作室通用的。
          const note=row.id==='method'?compositionMethodNote(row.detail,t,number):row.id==='extension'?t(COMPOSITION_EXTENSION_NOTE_KEY):''
          return {id:row.id,title:t(meta.label),content:<div className={css.youGet}><div>
          <h3>{t(meta.label)}<em className={css.solutionGroupQuestion}>{t(meta.question)}</em><span className={css.solutionGroupCount}>{compositionCountText(row,t,number)}</span></h3>
          {row.id==='staff'
            ?<div className={css.memberCards}>{members.map(member=><span key={member.id}><StaffAvatar initial={member.initial} seed={member.seed} size="md"/><strong>{member.title}</strong></span>)}</div>
            :<ul>{solutionRowResources(manifest,row.id,locale).map(resource=>{
              const label=row.id==='source'?connectorModeLabel(sourceConnectorMode(resource,readOnlyConnections)??{},t):undefined
              return <li key={resource.id}><Check size={13} aria-hidden="true"/><span>{resource.title}</span>{label&&<small className={css.solutionResourceType}>{label}</small>}</li>
            })}</ul>}
          {note&&<p className={css.solutionGroupNote}>{note}</p>}{row.id==='method'&&<p className={css.solutionGroupNote}>{t('market.primary.templateBoundary')}</p>}
        </div></div>}
        })}/>
        <section className={css.contentSection} aria-label={t('market.solution.contents')}><h3>{t('market.solution.contents')}</h3><IndustryContents manifest={manifest} content={item.packageContent} persisted={!!item.contentStorage?.loaded}/></section>
        <section className={css.useOptions} aria-label={t('market.industry.otherUsage')}><h3>{t('market.industry.otherUsage')}</h3><div className={base.buttons}>
              {draft&&<button type="button" aria-label={t('market.intent.view')} aria-expanded={actionPanel==='intent'} onClick={()=>setActionPanel('intent')}>{t('market.intent.view')}</button>}
              <button type="button" aria-label={t('market.conversation.use')} disabled={busy||targetBlocked||draft?.status==='withdrawn'||draft?.preparation?.status==='pending'} onClick={()=>void prepare()}>{busy||draft?.preparation?.status==='pending'?t('market.conversation.preparing'):t('market.conversation.use')}</button>
            </div></section>
        <details className={css.provenance}>
          <summary>{t('market.solution.provenance')}</summary>
          <dl><dt>{t('market.catalog.source')}</dt><dd>{sourceLabel(item.source,t)}</dd><dt>{t('market.industry.templateLabel')}</dt><dd>v{item.version}</dd><dt>{t('market.industry.status')}</dt><dd>{currentStatus}</dd><dt>{t('market.industry.resourceSummary')}</dt><dd>{marketCountText(t,locale,'resource',manifest.resources.length)} · {marketCountText(t,locale,'entrypoint',manifest.entrypoints.length)}</dd></dl>
          <p>{t('market.solution.provenance.notice')}</p>
          <div className={css.provenanceBody}>
            <section className={css.sourceSection} aria-label={t('market.template.sourceRuntimeAria')}><h3>{t('market.template.sourceRuntime.title')}</h3><dl><dt>{t('market.catalog.source')}</dt><dd>{sourceLabel(item.source,t)}</dd><dt>{t('market.template.author')}</dt><dd>{copy.author}</dd><dt>{t('market.template.license')}</dt><dd>{copy.license}</dd><dt>{t('market.template.runtimeOwnership')}</dt><dd>{t('market.template.runtimeOwnershipDescription')}</dd></dl><button type="button" onClick={props.nativeSettings}>{t('market.template.connectionsRuntime')}</button></section>
            <section className={css.provenanceGroup} aria-label={t('market.template.governance.title')}><h3>{t('market.template.governance.title')}</h3><small>{t('market.template.governance.description')}</small>
              <IndustryReferences item={item} items={props.state.items} save={props.saveResolved}/>
              <IndustryUpdatePreview item={item} items={props.state.items} spaces={props.spaces} {...props.industryReview}/>
              <IndustryExport item={item}/>
            </section>
            {item.raw&&<section className={css.sourceSection}><h3>{t('market.template.manifestValidation')}</h3><details><summary>{t('market.template.viewRaw')}</summary><pre>{item.raw}</pre><small>SHA-256：{item.hash}</small></details><button type="button" onClick={exportDefinition}>{t('market.template.exportDefinition')}</button></section>}
          </div>
        </details>
      </>}
    </article>
  }
  return <article className={css.detail} aria-label={t('market.detail.aria')}>
    <ToolbarIconButton label={t('market.catalog.back')} icon={ArrowLeft} onClick={back}/>
    <div className={css.tags}><span>{marketCategoryLabel(t,marketCategoryOf(item))}</span><span>{itemPresentation.ecosystem}</span><span>{item.scope==='general'?t('market.scope.general'):item.scope}</span><span>{marketVisibilityLabel(t,item.visibility)}</span><span>{item.version}</span>{draft&&<span>{t('market.intent.detailVersionPrefix')}{draft.version} · {draft.status==='withdrawn'?t('market.intent.withdrawn'):t('market.intent.awaitingConfiguration')}</span>}</div>
    <p>{copy.summary}</p>{message&&<p role="alert" className={css.notice}>{message}</p>}{notice&&<p role="status">{notice}</p>}
    {item.kind==='skill'&&item.contentStorage?.loaded&&<SkillInstallControl key={'atomic-'+item.contentStorage.contentId} {...(props.runtimeChanged?{changed:props.runtimeChanged}:{})} api={props.skillInstallApi} source={{kind:'atomic',contentId:item.contentStorage.contentId}} title={copy.title}/>}
    {item.resourceKind==='plugin'&&(marketPluginInstallSource(item)?<MarketPluginInstallControl api={props.marketPluginInstallApi} source={marketPluginInstallSource(item)!} title={copy.title}/>:<section className={css.sheet} aria-label={t('market.plugin.install.title')}><h3>{t('market.plugin.install.title')}</h3><p role="alert">{t('market.plugin.install.unavailable')}</p>{item.source.kind==='github'&&<p>{t('market.plugin.install.source.githubOnly')}</p>}</section>)}
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
    {/* 标题与说明只由 IndustryLoadForm 显示一次；外层只留返回 */}
    <header><ToolbarIconButton label={t('market.template.backToContent')} icon={ArrowLeft} onClick={close}/></header>
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
