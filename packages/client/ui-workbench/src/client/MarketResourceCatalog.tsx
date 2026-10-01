import {useEffect,useMemo,useRef,useState} from 'react'
import {ChevronRight} from 'lucide-react'
import {marketTrustPreview,type MarketItem} from './market-preview.js'
import type {IndustryResourceKind} from './industry-manifest.js'
import {marketResourceIndex,filterMarketResources,type MarketResourceOwner,type MarketResourceVisibility} from './market-resource-index.js'
import {localizedMarketItemCopy,localizedMarketResourceEntryTitle,localizedMarketResourceUseTitle,marketCatalogItemCopy,marketResourcePresentation} from './market-home-presentation.js'
import type {MarketSkillRuntime} from './market-runtime-state.js'
import {marketResourceMark} from './market-solution-presentation.js'
import {ItemArt,StateMark} from './SolutionCards.js'
import css from './MarketPage.module.css'
import own from './MarketResourceCatalog.module.css'
import {useI18n} from './i18n/provider.js'
import {filterTaxonomyRows,getTaxonomyLabel,isMarketIndustryRoot,resourceEntryTaxonomy,type FunctionFilter,type MarketIndustryKey} from './market-taxonomy-filter.js'
import {MarketEmpty,MarketFilterBar,MarketResultLine,MoreFilters,moreFilterCss} from './MarketUnifiedList.js'
import {closeDirectoryDetailOnEscape} from './directory-focus.js'

/** `industry` / `fn` 是行业 / 功能词表键（'all' 为不限），与官方目录同一套两排筛选；其余维度收在「更多筛选」。 */
export type MarketResourceFilters={visibility:MarketResourceVisibility|'all';ecosystem:MarketResourceOwner|'all';industry:MarketIndustryKey|'all';fn:FunctionFilter|'all';capability:string;resourceType:IndustryResourceKind|'all'}
export const emptyMarketResourceFilters:MarketResourceFilters={visibility:'all',ecosystem:'all',industry:'all',fn:'all',capability:'all',resourceType:'all'}

type MarketResourceCatalogProps={filters?:MarketResourceFilters;onFiltersChange?:(filters:MarketResourceFilters)=>void;items:readonly MarketItem[];kind:'skill'|'role'|'resource';resourceKinds?:IndustryResourceKind[];query?:string;onQueryChange?:(value:string)=>void;hideQuery?:boolean;selectedId?:string;detailOpen?:boolean;onSelectedChange?:(id:string|undefined,openDetail?:boolean)=>void;open:(id:string)=>void;runtime?:MarketSkillRuntime;openInstallation?:(id:string)=>void;detailOnly?:boolean}

export function MarketResourceCatalog({filters:controlledFilters,onFiltersChange,items,kind,resourceKinds,query:controlledQuery,onQueryChange,hideQuery=false,selectedId,detailOpen,onSelectedChange,open,runtime,openInstallation,detailOnly=false}:MarketResourceCatalogProps){
 const {locale,t,list}=useI18n(),kindLabel=(value:IndustryResourceKind)=>t(`market.industry.resource.${value}` as Parameters<typeof t>[0])
 const index=useMemo(()=>marketResourceIndex(items),[items])
 const [localFilters,setLocalFilters]=useState<MarketResourceFilters>(emptyMarketResourceFilters)
 const {visibility,ecosystem,industry,fn,capability,resourceType}=controlledFilters??localFilters
 const updateFilters=onFiltersChange??setLocalFilters
 const setFilter=<K extends keyof MarketResourceFilters>(key:K,value:MarketResourceFilters[K])=>updateFilters({...(controlledFilters??localFilters),[key]:value})
 const [localQuery,setLocalQuery]=useState(''),[localSelected,setLocalSelected]=useState<string>()
 const query=controlledQuery??localQuery,setQuery=onQueryChange??setLocalQuery
 const selected=onSelectedChange?selectedId:localSelected
 const select=(id:string|undefined,openDetail=true)=>{setLocalSelected(id);onSelectedChange?.(id,openDetail)}
 const kinds:IndustryResourceKind[]=resourceKinds??(kind==='resource'?['knowledge','mcp','plugin','data-source','execution-tool']:[kind])
 const applicable=index.filter(row=>kinds.includes(row.kind))
 const itemOf=(row:{itemId?:string})=>row.itemId?items.find(item=>item.id===row.itemId):undefined
 const tagsOf=(row:typeof applicable[number])=>resourceEntryTaxonomy(row,itemOf(row),id=>items.find(item=>item.id===id))
 // 行业 / 功能之外的条件先过滤，两排筛选的计数在此基础上统计
 const preTaxonomy=filterMarketResources(applicable,{kind:kind==='resource'?resourceType:kind,query,referencedIndustry:'all',capability,visibility,owner:ecosystem,searchValues:row=>[localizedMarketResourceEntryTitle(row,locale),...row.uses.map(use=>localizedMarketResourceUseTitle(use,locale))]})
 const taxonomy={industry:industry==='all'?null:industry,fn:fn==='all'?null:fn}
 const rows=filterTaxonomyRows(preTaxonomy,tagsOf,taxonomy)
 const selectedRow=rows.find(row=>row.key===selected)
 const detail=detailOpen===false||selectedRow?.itemId&&selectedRow.status!=='conflict'?undefined:selectedRow
 const detailItem=detail?.itemId?items.find(item=>item.id===detail.itemId):undefined
 const detailCopy=detailItem?localizedMarketItemCopy(detailItem,locale):detail?{title:localizedMarketResourceEntryTitle(detail,locale),summary:''}:undefined
 const detailPresentation=detail?marketResourcePresentation(detail,detailItem,runtime,t):undefined
 const trustPreview=detailItem?marketTrustPreview(detailItem,t):undefined
 const visibilityLabel=(value:MarketResourceVisibility)=>t(`market.catalog.visibility.${value}` as Parameters<typeof t>[0])
 const activeFilters=[ecosystem!=='all'?`${t('market.catalog.ecosystem')}: ${ecosystem==='unknown'?t('market.catalog.ownerPending'):t(ecosystem==='DSH'?'market.presentation.ecosystem.dsh':'market.presentation.ecosystem.teloa')}`:'',visibility!=='all'?`${t('market.catalog.visibility')}: ${visibilityLabel(visibility)}`:'',capability!=='all'?`${t('market.catalog.capability')}: ${capability}`:'',resourceType!=='all'?`${t('market.catalog.resourceType')}: ${kindLabel(resourceType)}`:''].filter(Boolean)
 const clearFilters=()=>{setQuery('');updateFilters(emptyMarketResourceFilters)}
 const openRow=(row:typeof rows[number])=>{if(row.itemId&&row.status!=='conflict'){select(row.key,false);open(row.itemId)}else select(row.key)}
 const detailRef=useRef<HTMLElement>(null),rowList=useRef<HTMLDivElement>(null)
 useEffect(()=>{detailRef.current?.scrollIntoView({block:'nearest'})},[selected])
 const moveSelection=(index:number)=>{
  const next=rows[index]
  if(!next)return
  select(next.key,false)
  requestAnimationFrame(()=>rowList.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]')[index]?.focus())
 }
 const navigateRows=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  const current=Math.max(0,rows.findIndex(row=>row.key===selected))
  const next=event.key==='ArrowDown'?Math.min(rows.length-1,current+1):event.key==='ArrowUp'?Math.max(0,current-1):event.key==='Home'?0:event.key==='End'?rows.length-1:undefined
  if(next===undefined)return
  event.preventDefault();moveSelection(next)
 }
 const detailNode=detail&&detailPresentation&&detailCopy&&<section ref={detailRef} data-teloa-pane="detail" tabIndex={-1} className={`${css.sheet} ${css.resourceDetail}`} aria-label={t('market.catalog.detailAria')} onKeyDown={event=>closeDirectoryDetailOnEscape(event,()=>select(undefined))}><button type="button" className={css.resourceBack} onClick={()=>select(undefined)}>{t('market.back')}</button><h3>{detailCopy.title}</h3>{detailCopy.summary&&<p>{detailCopy.summary}</p>}<p>{detailPresentation.type} · {detail.version} · {visibilityLabel(detail.visibility)}</p><p>{t('market.catalog.scope')}: {detailPresentation.scope} · {t('market.catalog.source')}: {detailPresentation.source}</p><p>{t('market.catalog.ecosystem')}: {detailPresentation.ecosystem} · {detailPresentation.runtime}</p><p>{t('market.catalog.currentStatus')}: {detailPresentation.status}</p><p>{detail.capabilities.length?t('market.catalog.capabilityValues',{values:list(detail.capabilities)}):t('market.catalog.noCapability')}</p>
   {detail.status==='conflict'?<p role="alert">{t('market.catalog.conflict')}</p>:detail.itemId?<div className={css.detailActions}><button type="button" onClick={()=>open(detail.itemId!)}>{t('market.catalog.viewUsage')}</button>{detailPresentation.installationId&&openInstallation&&<button type="button" onClick={()=>openInstallation(detailPresentation.installationId!)}>{detailPresentation.action}</button>}</div>:<p>{t('market.catalog.referenceOnly')}</p>}
   <h4>{t('market.catalog.usedBy')}</h4>{detail.uses.length?<ul>{detail.uses.map(use=><li key={use.templateId+':'+use.resourceId}><button type="button" onClick={()=>open(use.templateId)}>{localizedMarketResourceUseTitle(use,locale)}</button> · {isMarketIndustryRoot(use.industry)?getTaxonomyLabel('industry',use.industry,locale)??use.industry:t('market.taxonomy.industry.other' as Parameters<typeof t>[0])+(use.industry!=='other'?` (${use.industry})`:'')} · {use.resourceId}</li>)}</ul>:<p>{t('market.catalog.noUses')}</p>}
   {trustPreview&&<><h4>{t('market.catalog.trustTitle')}</h4><dl><dt>{t('market.catalog.publisher')}</dt><dd>{trustPreview.publisher}</dd><dt>{t('market.catalog.license')}</dt><dd>{trustPreview.license}</dd><dt>{t('market.catalog.signature')}</dt><dd>{trustPreview.signature}</dd><dt>{t('market.catalog.compatibility')}</dt><dd>{trustPreview.compatibility}</dd><dt>{t('market.catalog.review')}</dt><dd>{trustPreview.review}</dd></dl><p>{t('market.industry.resource.skill')}: {list(trustPreview.skills)||t('market.catalog.none')}</p><p>{t('market.catalog.plugins')}: {list(trustPreview.plugins)||t('market.catalog.none')}</p><p>{t('market.catalog.connections')}: {list(trustPreview.connections)||t('market.catalog.none')}</p><p>{t('market.catalog.permissions')}: {list(trustPreview.permissions)||t('market.catalog.none')}</p>{!trustPreview.installable&&<p role="alert">{t('market.catalog.untrusted')}</p>}</>}
   <small>{t('market.catalog.boundary')}</small>
  </section>
 // 详情独占：页面把本机资源并进统一列表后，引用条目与冲突条目的摘要仍由这里给出，只是不再重复一份列表
 if(detailOnly)return detailNode||null
 return <section className={css.resourceCatalog} data-resource-layer={detail?'detail':'list'} aria-label={t('market.catalog.resourceAria')}>
  {!hideQuery&&<label>{t('market.industry.browser.search')}<input aria-label={t('market.catalog.atomicSearchAria')} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('market.catalog.searchPlaceholder')}/></label>}
  {/* 与官方目录同一套：两排行业 / 功能筛选；来源生态、可见范围、能力分类或资源类型收进「更多筛选」 */}
  {!detail&&applicable.length>0&&<MarketFilterBar rows={preTaxonomy} tags={tagsOf} filter={taxonomy} onChange={next=>updateFilters({...(controlledFilters??localFilters),industry:next.industry??'all',fn:next.fn??'all'})}>
   <MoreFilters label={t('market.catalog.official.moreFilters')}><div className={moreFilterCss.fields}>
   <label>{t('market.catalog.ecosystem')}<select aria-label={t('market.catalog.ecosystem')} value={ecosystem} onChange={event=>setFilter('ecosystem',event.target.value as MarketResourceOwner|'all')}><option value="all">{t('market.catalog.allEcosystems')}</option><option value="Teloa">{t('market.presentation.ecosystem.teloa')}</option><option value="DSH">{t('market.presentation.ecosystem.dsh')}</option><option value="unknown">{t('market.catalog.ownerPending')}</option></select></label>
   <label>{t('market.catalog.visibility')}<select aria-label={t('market.catalog.visibility')} value={visibility} onChange={event=>setFilter('visibility',event.target.value as MarketResourceVisibility|'all')}><option value="all">{t('market.catalog.allVisibility')}</option>{(['public','personal','team','unknown'] as const).map(value=><option key={value} value={value}>{visibilityLabel(value)}</option>)}</select></label>
   {kind==='skill'?<label>{t('market.catalog.capability')}<select aria-label={t('market.catalog.capability')} value={capability} onChange={event=>setFilter('capability',event.target.value)}><option value="all">{t('market.catalog.allCapabilities')}</option>{[...new Set(applicable.flatMap(row=>row.capabilities))].map(value=><option key={value}>{value}</option>)}</select></label>:kind==='resource'&&kinds.length>1?<label>{t('market.catalog.resourceType')}<select aria-label={t('market.catalog.atomicTypeAria')} value={resourceType} onChange={event=>setFilter('resourceType',event.target.value as IndustryResourceKind|'all')}><option value="all">{t('market.catalog.allTypes')}</option>{kinds.map(value=><option key={value} value={value}>{kindLabel(value)}</option>)}</select></label>:null}
   </div></MoreFilters>
  </MarketFilterBar>}
  {!detail&&(activeFilters.length>0||query.trim())&&<div className={own.filterSummary}><span>{list(activeFilters)}</span><button type="button" onClick={clearFilters}>{t('market.catalog.clear')}</button></div>}
  {!detail&&rows.length>0&&<MarketResultLine count={rows.length}/>}
  {rows.length>0&&<div ref={rowList} className={css.itemList} role="listbox" aria-label={t('market.catalog.resultsAria')} onKeyDown={navigateRows}>{rows.map(row=>{const item=row.itemId?items.find(item=>item.id===row.itemId):undefined,presentation=marketResourcePresentation(row,item,runtime,t),copy=item?marketCatalogItemCopy(item,locale):{title:localizedMarketResourceEntryTitle(row,locale),summary:'',localFixed:false};return <button type="button" key={row.key} data-teloa-entry={row.key} className={css.itemCard} role="option" aria-selected={selected===row.key} tabIndex={selected===row.key||!selectedRow&&row===rows[0]?0:-1} onClick={()=>openRow(row)}><ItemArt kind={row.kind} title={copy.title} seed={row.key}/><span className={css.itemMain}><strong className={css.resourceTitle}>{copy.title}</strong>{copy.summary&&<span className={css.resourceDescription}>{copy.summary}</span>}<span className={css.resourceFacts}>{presentation.scope} · {presentation.source}</span></span><StateMark mark={marketResourceMark(row,item,runtime)} t={t}/><ChevronRight size={16}/></button>})}</div>}
  {!rows.length&&!detail&&<MarketEmpty filtered={applicable.length>0} onReset={clearFilters}/>}
  {detailNode}
 </section>
}
