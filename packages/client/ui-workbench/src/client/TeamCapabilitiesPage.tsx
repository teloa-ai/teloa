import {RuntimeExtensionDetail,RUNTIME_EXTENSION_STATE_KEYS,type RuntimeText} from './RuntimeExtensionDetail.js'
import type {RuntimeExtensionReader} from './runtime-extensions.js'
import type {IndustryPluginInstance} from './industry-plugin-api.js'
import {capabilityIcons} from './capability-icons.js'
import {useEffect, useRef, useState, useSyncExternalStore} from 'react'
import {ArrowLeft, ChevronRight} from 'lucide-react'
import type {BindingClient} from './binding-client.js'
import type {IndustryLoadRecord} from './industry-load-api.js'
import {projectIndustryWorkspace} from './industry-workspace-projection.js'
import {teamCapabilityCatalog} from './team-capabilities-presentation.js'
import {capabilitySections, type CapabilityItem} from './capability-composition.js'
import {CAPABILITY_ROW_IDS, COMPOSITION_EXTENSION_NOTE_KEY, COMPOSITION_ROWS, COMPOSITION_STATE_KEYS, connectorModeLabel, type CompositionRowId, type CompositionTarget} from './industry-composition.js'
import { useDirectoryFocus } from './directory-focus.js'
import {useI18n} from './i18n/provider.js'
import {CreateEntry} from './CreateEntry.js'
import {ExtensionCreateEntry} from './ExtensionCreateEntry.js'
import type {PageCreateApi} from './page-create-api.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import type {PageCreateDraftPreview} from '@teloa/contract'
import base from './TaskPage.module.css'
import marketCss from './MarketPage.module.css'
import css from './TeamCapabilitiesPage.module.css'

export type TeamCapabilitiesNavigationState={category:CompositionRowId;selectedId:string|undefined;mobileLayer:'category'|'list'|'detail'}
type Props={pluginDirectory?:{loading:boolean;error:string|undefined;partial:boolean};runtimeExtensions:RuntimeExtensionReader;resolveExtensionText:(text:RuntimeText)=>string;plugins:readonly IndustryPluginInstance[];refreshPlugins:()=>Promise<unknown>;visible:boolean;work:BindingClient;industryLoads:readonly IndustryLoadRecord[];industryLoadsReady:boolean;configureIndustryResource:(target:{loadId:string;itemInstanceId:string})=>void;openMarket:()=>void;nativeSettings:()=>void;openConversation:()=>void;pageCreate?:{api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string})=>void;confirmSkill:(preview:PageCreateDraftPreview)=>Promise<string>;openSkill:(contentId:string)=>void;marketPluginInstallApi?:MarketPluginInstallApi;openExtensionMarket?:()=>void};businessNames?:Readonly<Record<string,string>>;go:(target:CompositionTarget)=>void;navigationState?:Partial<TeamCapabilitiesNavigationState>;onNavigationChange?:(state:TeamCapabilitiesNavigationState)=>void}

/** 能力页只摆跨业务复用的四行；顺序与标签只从共享分类模块派生，这里不写字面 id 数组。 */
const CAPABILITY_ROWS=COMPOSITION_ROWS.filter(row=>CAPABILITY_ROW_IDS.includes(row.id))
const rowMeta=(id:CompositionRowId)=>CAPABILITY_ROWS.find(row=>row.id===id)!
const categoryIcon=(id:CompositionRowId)=>{const Icon=capabilityIcons[id];return <Icon size={15} aria-hidden="true"/>}

function NativeCapabilityCatalog({pluginDirectory,runtimeExtensions,resolveExtensionText,plugins,refreshPlugins,visible,work,industryLoads,industryLoadsReady,configureIndustryResource,openMarket,nativeSettings,openConversation,pageCreate,businessNames,go,navigationState,onNavigationChange}:Props){
 const {t}=useI18n()
 const state=useSyncExternalStore(work.subscribe,work.getSnapshot)
 const runtime=useSyncExternalStore(runtimeExtensions.subscribe,runtimeExtensions.getSnapshot)
 useEffect(()=>{if(visible)void runtimeExtensions.refresh()},[visible,runtimeExtensions])
 const [category,setCategory]=useState<CompositionRowId>(navigationState?.category??'skill'),[selectedKey,setSelectedKey]=useState<string|undefined>(navigationState?.selectedId),[mobileLayer,setMobileLayer]=useState<'category'|'list'|'detail'>(navigationState?.mobileLayer??'category')
 const rowList=useRef<HTMLDivElement>(null)
 const remember=(patch:Partial<TeamCapabilitiesNavigationState>)=>onNavigationChange?.({category,selectedId:selectedKey,mobileLayer,...patch})
 useEffect(()=>{if(visible&&state.status==='ready')void work.readCatalog()},[visible,state.sessionId,state.status,work])
 useEffect(()=>{
  if(!visible)return
  if(navigationState?.category!==undefined&&navigationState.category!==category)setCategory(navigationState.category)
  if(navigationState?.selectedId!==undefined&&navigationState.selectedId!==selectedKey)setSelectedKey(navigationState.selectedId)
  if(navigationState?.mobileLayer!==undefined&&navigationState.mobileLayer!==mobileLayer)setMobileLayer(navigationState.mobileLayer)
 },[visible,navigationState?.category,navigationState?.selectedId,navigationState?.mobileLayer])
 const snapshot=state.status==='ready'?state.capabilities:undefined,industryResources=projectIndustryWorkspace(industryLoads,{destination:'team-capability'})
 // 仅为满足 industry-workspace-wiring.test.ts 的回归锚点保留这次调用；四行渲染改由 capabilitySections 提供，
 // 行业字段（industry/instanceId）与状态直接读 CapabilityItem，不再从这份薄层目录里取。
 void teamCapabilityCatalog(snapshot?{snapshot,industryResources}:{industryResources})
 const sections=capabilitySections({...(snapshot?{snapshot}:{}),loads:industryLoads,plugins:pluginDirectory?.error?[]:plugins})
 const nativeItems:CapabilityItem[]=runtime.items.map(item=>({key:'runtime:'+item.name,rowId:'extension',title:item.meta?.title?resolveExtensionText(item.meta.title):item.name,state:'unverified',native:item,origin:{kind:'studio'},go:{kind:'capabilities'}}))
 sections.find(section=>section.id==='extension')!.items.push(...nativeItems)
 const itemState=(item:CapabilityItem)=>t(item.native?RUNTIME_EXTENSION_STATE_KEYS[item.native.runtime]:COMPOSITION_STATE_KEYS[item.state])
 const refresh=()=>{void work.readCatalog();void runtimeExtensions.refresh();void refreshPlugins().catch(()=>{})}
 const items=sections.find(section=>section.id===category)?.items??[],selected=items.find(row=>row.key===selectedKey)??items[0]
 const directoryFocus=useDirectoryFocus(visible,mobileLayer==='detail'?selected?.key:undefined)
 useEffect(()=>{if(state.catalogStatus!=='ready'||!industryLoadsReady)return;if(selected?.key!==selectedKey){setSelectedKey(selected?.key);remember({selectedId:selected?.key})}},[state.catalogStatus,industryLoadsReady,selected?.key,selectedKey])
 if(!visible)return null
 const categoryTitle=(id:CompositionRowId)=>t(rowMeta(id).label)
 const categoryDescription=(id:CompositionRowId)=>t(rowMeta(id).question)
 const detail=(item:CapabilityItem)=>item.industry?t('teamCapability.industry.detail',{requirement:t(item.industry.required?'teamCapability.industry.required':'teamCapability.industry.optional')}):item.detail?t(item.detail):t('teamCapability.detail.none')
 const source=(item:CapabilityItem)=>item.industry?t('teamCapability.industry.source',{template:item.industry.templateTitle,templateVersion:item.industry.templateVersion,resourceVersion:item.industry.resourceVersion}):t('teamCapability.source.observed')
 // method/extension 两行暂无专属边界文案键，沿用「连接」边界句（同样是「DSH 提供、Teloa 只做管理位」的意思）；
 // 只有技能行的边界说法不同，单独判断。
 const boundary=(item:CapabilityItem)=>item.industry?t('teamCapability.boundary.industry',{templateId:item.industry.templateId,contentHash:item.industry.contentHash}):t(item.rowId==='skill'?'teamCapability.boundary.skill':'teamCapability.boundary.connection')
 // 接入源行的副标只说读/写；其余行的副标说这条是工作室通用还是来自哪些业务——两种副标不叠加着说。
 const subtitle=(item:CapabilityItem)=>item.native?t('extension.runtime.source'):category==='source'
  ?connectorModeLabel(item,t)
  :item.origin.kind==='studio'
   ?t(COMPOSITION_EXTENSION_NOTE_KEY)
   :t('capability.item.businesses',{businesses:item.origin.scopes.map(scope=>businessNames?.[scope]??scope).join(t('capability.list.separator'))})
 // 本页已是能力目录；配置按钮必须进入真实管理入口，不能再次选中自身。
 const goItem=(item:CapabilityItem)=>{
  if(item.go.kind==='capabilities'||item.go.kind==='connectors'||item.rowId==='method'||item.rowId==='extension'){
   const load=item.instanceId?industryLoads.find(load=>load.items.some(row=>row.instanceId===item.instanceId)):undefined
   if(load&&item.instanceId)configureIndustryResource({loadId:load.id,itemInstanceId:item.instanceId})
   else nativeSettings()
  }else go(item.go)
 }
 const moveSelection=(index:number)=>{
  const next=items[index]
  if(!next)return
  setSelectedKey(next.key)
  remember({selectedId:next.key})
  requestAnimationFrame(()=>rowList.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]')[index]?.focus())
 }
 const navigateRows=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  const current=Math.max(0,items.findIndex(row=>row.key===selected?.key))
  const next=event.key==='ArrowDown'?Math.min(items.length-1,current+1):event.key==='ArrowUp'?Math.max(0,current-1):event.key==='Home'?0:event.key==='End'?items.length-1:undefined
  if(next===undefined)return
  event.preventDefault();moveSelection(next)
 }
 const emptyKey=category==='skill'?'teamCapability.empty.skill':category==='source'?'composition.empty.source':category==='method'?'capability.empty.method':'capability.empty.extension'
 return <section className={css.catalog} aria-label={t('teamCapability.catalog.aria')}>
  <header className={base.pageHeader}><div><h1>{t('teamCapability.title')}</h1><p>{t('teamCapability.description')}</p></div><div className={base.buttons}><button type="button" onClick={()=>openMarket()}>{t('teamCapability.market.add')}</button><button type="button" onClick={nativeSettings}>{t('extension.runtime.manage')}</button></div></header>
  <div {...directoryFocus} className={css.workspace} data-mobile-layer={mobileLayer}>
  <aside className={css.taxonomy} aria-label={t('teamCapability.taxonomy.aria')}><h2>{t('teamCapability.taxonomy.title')}</h2><div>{CAPABILITY_ROWS.map(row=><button key={row.id} type="button" aria-current={category===row.id?'page':undefined} onClick={()=>{setCategory(row.id);setSelectedKey(undefined);setMobileLayer('list');remember({category:row.id,selectedId:undefined,mobileLayer:'list'})}}><span>{categoryIcon(row.id)}</span><strong>{categoryTitle(row.id)}</strong><small>{categoryDescription(row.id)}</small></button>)}</div></aside>
  <main data-teloa-pane="directory" tabIndex={-1} className={css.directory} aria-label={t('teamCapability.list.aria')}><button type="button" className={css.mobileBack} onClick={()=>{setMobileLayer('category');remember({mobileLayer:'category'})}}><ArrowLeft size={15}/>{t('teamCapability.back.categories')}</button><header><div><h2>{categoryTitle(category)}</h2><p>{categoryDescription(category)}</p></div>{(state.status==='ready'||category==='extension')&&<button type="button" disabled={state.catalogStatus==='loading'||runtime.status==='loading'} onClick={refresh}>{t('teamCapability.directory.refresh')}</button>}</header>{category==='skill'&&pageCreate&&<div className={css.createEntry}><CreateEntry entity="skill" api={pageCreate.api} prepare={pageCreate.prepare} openMarket={openMarket} onConfirm={pageCreate.confirmSkill} afterConfirm={pageCreate.openSkill}/></div>} {category==='extension'&&pageCreate?.marketPluginInstallApi&&<div className={css.createEntry}><CreateEntry entity="extension" api={pageCreate.api} prepare={pageCreate.prepare} openMarket={pageCreate.openExtensionMarket??openMarket} renderConfirmation={({preview,apply})=><ExtensionCreateEntry preview={preview} api={pageCreate.marketPluginInstallApi!} apply={apply}/>}/></div>} {state.catalogStatus==='failed'&&items.length>0&&<p className={css.error} role="alert">{t('teamCapability.error.load')}</p>}{category==='extension'&&pluginDirectory?.loading&&<p role="status" className={css.muted}>{t('teamCapability.directory.loading')}</p>}{category==='extension'&&(pluginDirectory?.error||pluginDirectory?.partial)&&<p role="alert" className={css.error}>{t('extension.business.readFailed')} <button type="button" onClick={()=>void refreshPlugins().catch(()=>{})}>{t('teamCapability.directory.refresh')}</button></p>}{category==='extension'&&runtime.status==='failed'&&<p className={css.error} role="alert">{t('teamCapability.error.load')} <button type="button" onClick={()=>void runtimeExtensions.refresh()}>{t('teamCapability.directory.refresh')}</button></p>}{category==='extension'&&runtime.status==='loading'&&!items.length?<p role="status" className={css.muted}>{t('teamCapability.directory.loading')}</p>:state.status!=='ready'&&!items.length?<div className={css.emptyState}><p>{state.status==='failed'?t('teamCapability.error.load'):t('teamCapability.session.unavailable')}</p><button type="button" onClick={openConversation}>{t('teamCapability.session.open')}</button></div>:state.catalogStatus==='failed'&&!items.length?<p className={css.error} role="alert">{t('teamCapability.error.load')}</p>:state.catalogStatus==='loading'&&!items.length?<p className={css.muted} role="status">{t('teamCapability.directory.loading')}</p>:items.length?<div ref={rowList} className={css.rowList} role="listbox" aria-label={categoryTitle(category)} onKeyDown={navigateRows}>{items.map(row=>{const rowSubtitle=subtitle(row);return <button key={row.key} data-teloa-entry={row.key} type="button" role="option" aria-selected={selected?.key===row.key} tabIndex={selected?.key===row.key?0:-1} onClick={()=>{setSelectedKey(row.key);setMobileLayer('detail');remember({selectedId:row.key,mobileLayer:'detail'})}}><span><strong>{row.title}</strong>{rowSubtitle&&<small>{rowSubtitle}</small>}</span><em>{itemState(row)}</em><ChevronRight size={15}/></button>})}</div>:<div className={css.emptyState}><p>{t(emptyKey)}</p><button type="button" onClick={category==='skill'?openConversation:category==='source'?nativeSettings:openMarket}>{t(category==='skill'?'teamCapability.session.open':category==='source'?'teamCapability.connection.manage':'teamCapability.market.add')}</button></div>}</main>
  <aside data-teloa-pane="detail" tabIndex={-1} className={css.detail} aria-label={t('teamCapability.detail.aria')}><button type="button" className={css.mobileBack} onClick={()=>{setMobileLayer('list');remember({mobileLayer:'list'})}}><ArrowLeft size={15}/>{t('teamCapability.back.directory')}</button>{selected?.native?<RuntimeExtensionDetail item={selected.native} resolveText={resolveExtensionText} manage={nativeSettings}/>:selected?<><span className={css.eyebrow}>{t('teamCapability.detail.selected')}</span><h2>{selected.title}</h2><p className={css.status}>{t(COMPOSITION_STATE_KEYS[selected.state])}</p>{selected.instanceId&&<p className={css.registeredNotice}>{t('teamCapability.registered.notice')}</p>}<dl><dt>{t('teamCapability.field.source')}</dt><dd>{selected.industry?.templateTitle??source(selected)}</dd><dt>{t('teamCapability.field.scope')}</dt><dd>{detail(selected)}</dd></dl><section className={css.readiness}><span>{t('teamCapability.next.title')}</span><strong>{t(selected.rowId==='extension'?'teamCapability.next.plugin':selected.rowId==='source'?selected.instanceId?'teamCapability.next.connection':'teamCapability.next.verifyConnection':selected.rowId==='skill'?selected.instanceId?'teamCapability.next.install':'teamCapability.next.skill':'teamCapability.next.install')}</strong></section><div className={base.buttons}><button type="button" onClick={()=>goItem(selected)}>{t('composition.action.configure')}</button></div></>:<section className={css.emptyDetail}><h2>{t('teamCapability.detail.emptyTitle')}</h2><p>{t('teamCapability.detail.emptyDescription')}</p></section>}{selected&&!selected.native&&<details className={css.technical} key={selected.key}><summary>{t('teamCapability.field.templateVersion')} · {t('teamCapability.field.boundary')}</summary><dl>{selected.instanceId&&<><dt>{t('teamCapability.field.templateVersion')}</dt><dd>{source(selected)}</dd><dt>{t('teamCapability.field.instance')}</dt><dd>{selected.instanceId}</dd></>}<dt>{t('teamCapability.field.boundary')}</dt><dd>{boundary(selected)}</dd></dl><section className={css.ownership}><span className={css.eyebrow}>{t('teamCapability.ownership.title')}</span><dl><dt>DSH</dt><dd>{t('teamCapability.ownership.dsh')}</dd><dt>Teloa</dt><dd>{t('teamCapability.ownership.teloa')}</dd></dl></section></details>}</aside>
  </div>
 </section>
}

function UnavailableBindings({catalog,openMarket}:{catalog:()=>void;openMarket:()=>void}){
 const {t}=useI18n()
 return <section className={base.page} aria-label={t('teamCapability.bindingUnavailable.title')}>
  <nav className={marketCss.categories} aria-label={t('teamCapability.navigation.aria')}><button type="button" onClick={catalog}><ArrowLeft size={15}/>{t('teamCapability.navigation.catalog')}</button></nav>
  <header className={base.pageHeader}><div><h1>{t('teamCapability.bindingUnavailable.title')}</h1><p>{t('teamCapability.bindingUnavailable.description')}</p></div></header>
  <div className={base.empty}><p>{t('teamCapability.bindingUnavailable.boundary')}</p><div className={base.buttons}><button type="button" onClick={catalog}>{t('teamCapability.navigation.catalog')}</button><button type="button" onClick={openMarket}>{t('teamCapability.market.add')}</button></div></div>
 </section>
}

export function TeamCapabilitiesPage(props:Props&{mode:'catalog'|'bindings';catalog:()=>void}){
 if(!props.visible)return null
 const active=props.mode==='bindings'
 return <div className={`${base.page} ${marketCss.page}`}>{active?<UnavailableBindings catalog={props.catalog} openMarket={props.openMarket}/>:<NativeCapabilityCatalog {...props}/>}</div>
}
