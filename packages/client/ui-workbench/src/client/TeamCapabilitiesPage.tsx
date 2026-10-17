import {groupCapabilityConnectors,type CapabilityCenterItem} from './capability-center-catalog.js'
import {ResourceIcon} from './ResourceIcon.js'
import {RuntimeExtensionDetail,RUNTIME_EXTENSION_STATE_KEYS,type RuntimeText} from './RuntimeExtensionDetail.js'
import type {RuntimeExtensionReader} from './runtime-extensions.js'
import type {IndustryPluginInstance} from './industry-plugin-api.js'
import {capabilityIcons} from './capability-icons.js'
import {useEffect, useRef, useState, useSyncExternalStore, type ReactNode} from 'react'
import {ArrowLeft, ChevronRight, Search, X, RefreshCw, Plus} from 'lucide-react'
import {ToolbarIconButton} from './ToolbarIconButton.js'
import type {BindingClient} from './binding-client.js'
import type {IndustryLoadRecord} from './industry-load-api.js'
import {projectIndustryWorkspace} from './industry-workspace-projection.js'
import {teamCapabilityCatalog} from './team-capabilities-presentation.js'
import {capabilitySections, type CapabilityItem} from './capability-composition.js'
import {capabilitySkillLoadsKey,loadCapabilitySkillRuntime,type CapabilitySkillRuntime} from './capability-skill-runtime.js'
import type {SkillInstallApi} from './skill-install-api.js'
import {CAPABILITY_ROW_IDS, COMPOSITION_EXTENSION_NOTE_KEY, COMPOSITION_ROWS, COMPOSITION_STATE_KEYS, connectorModeLabel, type CompositionRowId, type CompositionTarget} from './industry-composition.js'
import {ContextDrawer} from './ContextDrawer.js'
import { useDirectoryFocus } from './directory-focus.js'
import {useI18n} from './i18n/provider.js'
import {CreateEntry} from './CreateEntry.js'
import {useTemplateShare} from './EmployeeTemplateShare.js'
import {ExtensionCreateEntry} from './ExtensionCreateEntry.js'
import type {PageCreateApi} from './page-create-api.js'
import type {MarketPluginInstallApi} from './market-plugin-install-api.js'
import type {CapabilitySnapshot,PageCreateDraftPreview,PageCreateEntity} from '@teloa/contract'
import base from './TaskPage.module.css'
import css from './TeamCapabilitiesPage.module.css'

/** 我的资源分组：四行跨业务原子资源（技能、连接器、任务模板、扩展）；本机创建的任务模板由市场页并入任务模板分组。 */
export type MyResourceGroupId=CompositionRowId
export type TeamCapabilitiesNavigationState={query:string;category:MyResourceGroupId;selectedId:string|undefined;mobileLayer:'category'|'list'|'detail'}
type Props={contextual?:boolean;skillInstallApi?:SkillInstallApi;pluginDirectory?:{loading:boolean;error:string|undefined;partial:boolean};runtimeExtensions:RuntimeExtensionReader;resolveExtensionText:(text:RuntimeText)=>string;plugins:readonly IndustryPluginInstance[];refreshPlugins:()=>Promise<unknown>;visible:boolean;work:BindingClient;industryLoads:readonly IndustryLoadRecord[];industryLoadsReady:boolean;configureIndustryResource:(target:{loadId:string;itemInstanceId:string})=>void;openMarket:()=>void;nativeSettings:()=>void;openConversation:()=>void;pageCreate?:{api:PageCreateApi;prepare:(prompt:{sourceId:string;title:string;text:string})=>void|Promise<void>;confirmSkill:(preview:PageCreateDraftPreview)=>Promise<string>;openSkill:(contentId:string)=>void;marketPluginInstallApi?:MarketPluginInstallApi;openExtensionMarket?:()=>void};businessNames?:Readonly<Record<string,string>>;go:(target:CompositionTarget)=>void;navigationState?:Partial<TeamCapabilitiesNavigationState>;onNavigationChange?:(state:TeamCapabilitiesNavigationState)=>void;/** 本机创建的任务模板由市场页提供并并入「任务模板」分组：已有模板仍可查看与用作计划，新建入口已退出。 */templates?:{count:number;render:()=>ReactNode}}
/** 工作台接线部分：市场页为原对象资源补上上下文抽屉与回市场入口。 */
export type MyResourcesWiring=Omit<Props,'visible'|'openMarket'|'templates'>

/** 能力页只摆跨业务复用的四行；顺序与标签只从共享分类模块派生，这里不写字面 id 数组。 */
const CAPABILITY_ROWS=COMPOSITION_ROWS.filter(row=>CAPABILITY_ROW_IDS.includes(row.id))
const rowMeta=(id:CompositionRowId)=>CAPABILITY_ROWS.find(row=>row.id===id)!
const categoryIcon=(id:CompositionRowId)=>{const Icon=capabilityIcons[id];return <Icon size={15} aria-hidden="true"/>}
const createEntity=(id:MyResourceGroupId):PageCreateEntity|undefined=>id==='skill'?'skill':id==='extension'?'extension':undefined

/**
 * 市场「已添加」页签内的「我的资源」：技能、连接器、角色方法、扩展与任务模板按需分组，轻列表加右侧抽屉。
 * 2026-10-14 用户明确退出独立「我的能力」页：这里不再有自己的页标题、分类侧栏与常驻「新建／等你确认」区块。
 */
export function TeamCapabilitiesPage({contextual=false,skillInstallApi,pluginDirectory,runtimeExtensions,resolveExtensionText,plugins,refreshPlugins,visible,work,industryLoads,industryLoadsReady,configureIndustryResource,openMarket,nativeSettings,openConversation,pageCreate,businessNames,go,navigationState,onNavigationChange,templates}:Props){
 const {t}=useI18n(),sharing=useTemplateShare()
 const state=useSyncExternalStore(work.subscribe,work.getSnapshot)
 const runtime=useSyncExternalStore(runtimeExtensions.subscribe,runtimeExtensions.getSnapshot)
 useEffect(()=>{if(visible)void runtimeExtensions.refresh()},[visible,runtimeExtensions])
 const [category,setCategory]=useState<MyResourceGroupId>(navigationState?.category??'skill'),[selectedKey,setSelectedKey]=useState<string|undefined>(navigationState?.selectedId),[mobileLayer,setMobileLayer]=useState<'category'|'list'|'detail'>(navigationState?.mobileLayer??'category')
 const [query,setQuery]=useState(navigationState?.query??''),[detailOpen,setDetailOpen]=useState(navigationState?.mobileLayer==='detail')
 const [skillRuntime,setSkillRuntime]=useState<CapabilitySkillRuntime>({loadsKey:'',state:'loading',facts:[]}),[skillRevision,setSkillRevision]=useState(0)
 const [studioSkills,setStudioSkills]=useState<{status:'loading'|'ready'|'failed';items:CapabilitySnapshot['skills']}>({status:'loading',items:[]}),[studioRevision,setStudioRevision]=useState(0)
 // 新建与待确认草案按需展开：只读草案数量作提示，不常驻整块入口；展开后由 CreateEntry 自己读目录与预览。
 const [createOpen,setCreateOpen]=useState(false),[pendingDrafts,setPendingDrafts]=useState<Partial<Record<PageCreateEntity,number>>>({})
 useEffect(()=>{
  if(!visible)return
  let active=true
  const controller=new AbortController()
  setStudioSkills({status:'loading',items:[]})
  void work.readHomeSkills(controller.signal).then(items=>{if(active)setStudioSkills({status:'ready',items})},()=>{if(active)setStudioSkills({status:'failed',items:[]})})
  return()=>{active=false;controller.abort()}
 },[visible,work,studioRevision])
 const skillLoadsKey=capabilitySkillLoadsKey(industryLoads)
 useEffect(()=>{
  if(!visible||!industryLoadsReady)return
  let active=true
  setSkillRuntime({loadsKey:skillLoadsKey,state:'loading',facts:[]})
  if(!skillInstallApi){setSkillRuntime({loadsKey:skillLoadsKey,state:'error',facts:[]});return}
  void loadCapabilitySkillRuntime(skillInstallApi,industryLoads).then(value=>{if(active)setSkillRuntime(value)})
  return()=>{active=false}
 },[visible,industryLoadsReady,skillInstallApi,skillLoadsKey,skillRevision])
 const entity=createEntity(category),createAvailable=!!pageCreate&&(entity==='skill'||entity==='extension'&&!!pageCreate.marketPluginInstallApi)
 useEffect(()=>{
  if(!visible||!pageCreate||!entity||createOpen)return
  let active=true
  const controller=new AbortController()
  void pageCreate.api.directory({entity},controller.signal).then(directory=>{if(active)setPendingDrafts(current=>({...current,[entity]:directory.drafts.filter(draft=>draft.status==='draft').length}))},()=>{})
  return()=>{active=false;controller.abort()}
 },[visible,pageCreate,entity,createOpen])
 const rowList=useRef<HTMLDivElement>(null)
 const remember=(patch:Partial<TeamCapabilitiesNavigationState>)=>onNavigationChange?.({query,category,selectedId:selectedKey,mobileLayer,...patch})
 useEffect(()=>{if(visible&&state.status==='ready'&&state.conversation?.purpose!=='task-run')void work.readCatalog()},[visible,state.sessionId,state.status,state.conversation?.purpose,work])
 useEffect(()=>{
  if(!visible)return
  if(navigationState?.query!==undefined&&navigationState.query!==query)setQuery(navigationState.query)
  if(navigationState?.category!==undefined&&navigationState.category!==category)setCategory(navigationState.category)
  if(navigationState?.selectedId!==undefined&&navigationState.selectedId!==selectedKey)setSelectedKey(navigationState.selectedId)
  if(navigationState?.mobileLayer!==undefined&&navigationState.mobileLayer!==mobileLayer){setMobileLayer(navigationState.mobileLayer);setDetailOpen(navigationState.mobileLayer==='detail')}
 },[visible,navigationState?.category,navigationState?.selectedId,navigationState?.mobileLayer,navigationState?.query])
 const snapshot=state.status==='ready'&&state.conversation?.purpose!=='task-run'?state.capabilities:undefined,industryResources=projectIndustryWorkspace(industryLoads,{destination:'team-capability'})
 // 仅为满足 industry-workspace-wiring.test.ts 的回归锚点保留这次调用；四行渲染改由 capabilitySections 提供，
 // 行业字段（industry/instanceId）与状态直接读 CapabilityItem，不再从这份薄层目录里取。
 void teamCapabilityCatalog(snapshot?{snapshot,industryResources}:{industryResources})
 const sections=capabilitySections({...(snapshot?{snapshot}:{}),studioSkills:studioSkills.status==='ready'?studioSkills.items:[],loads:industryLoads,plugins:pluginDirectory?.error?[]:plugins,skillRuntime:industryLoadsReady&&skillRuntime.loadsKey===skillLoadsKey?skillRuntime:{loadsKey:skillLoadsKey,state:'loading',facts:[]}})
 const nativeItems:CapabilityItem[]=runtime.items.map(item=>({key:'runtime:'+item.name,rowId:'extension',title:item.meta?.title?resolveExtensionText(item.meta.title):item.name,state:'unverified',native:item,origin:{kind:'studio'},go:{kind:'capabilities'}}))
 sections.find(section=>section.id==='extension')!.items.push(...nativeItems)
 const itemState=(item:CapabilityItem)=>t(item.native?RUNTIME_EXTENSION_STATE_KEYS[item.native.runtime]:item.skillStatus?`capabilityCenter.skill.${item.skillStatus}`:COMPOSITION_STATE_KEYS[item.state])
 const refresh=()=>{setSkillRevision(value=>value+1);setStudioRevision(value=>value+1);if(state.conversation?.purpose!=='task-run')void work.readCatalog();void runtimeExtensions.refresh();void refreshPlugins().catch(()=>{})}
 const sectionItems=sections.find(section=>section.id===category)?.items??[]
 const allItems:CapabilityCenterItem[]=category==='source'?groupCapabilityConnectors(sectionItems):sectionItems
 const items=allItems.filter(item=>[item.title,item.key,item.industry?.templateTitle??'',...(item.toolKeys??[])].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
 const selected=items.find(row=>row.key===selectedKey||!!selectedKey&&row.toolKeys?.includes(selectedKey))
 // 抽屉负责焦点往返；目录仍保持共享滚动容器与入口记账，不再把焦点移到第三张卡片。
 const directoryFocus=useDirectoryFocus(visible,undefined,false)
 if(!visible)return null
 const groupTitle=(id:MyResourceGroupId)=>t(contextual&&id==='extension'?'market.apps.title':id==='source'?'capabilityCenter.connectors':rowMeta(id).label)
 const groupDescription=(id:MyResourceGroupId)=>t(rowMeta(id).question)
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
 const selectGroup=(id:MyResourceGroupId)=>{setCategory(id);setSelectedKey(undefined);setDetailOpen(false);setCreateOpen(false);setMobileLayer('list');remember({category:id,selectedId:undefined,mobileLayer:'list'})}
 const moveSelection=(index:number)=>{
  const next=items[index]
  if(!next)return
  setSelectedKey(next.key)
  remember({selectedId:next.key})
  requestAnimationFrame(()=>rowList.current?.querySelectorAll<HTMLButtonElement>('button[role="option"]')[index]?.focus())
 }
 const navigateRows=(event:React.KeyboardEvent<HTMLDivElement>)=>{
  const current=items.findIndex(row=>row.key===selected?.key)
  const next=event.key==='ArrowDown'?Math.min(items.length-1,current+1):event.key==='ArrowUp'?Math.max(0,current-1):event.key==='Home'?0:event.key==='End'?items.length-1:undefined
  if(next===undefined)return
  event.preventDefault();moveSelection(next)
 }
 const emptyKey=category==='skill'?'teamCapability.empty.skill':category==='source'?'composition.empty.source':category==='method'?'capability.empty.method':contextual?'market.apps.mineEmpty':'capability.empty.extension'
 const pendingCount=entity?pendingDrafts[entity]??0:0
 const groups:MyResourceGroupId[]=CAPABILITY_ROWS.map(row=>row.id)
 // 任务模板分组：方案里的任务模板与本机创建的模板同组呈现；列表为空而本机模板存在时不再出空态。
 const localTemplates=category==='method'&&!!templates?.count
 const directory=<main data-teloa-pane="directory" tabIndex={-1} className={css.directory} aria-label={t('teamCapability.list.aria')}>{!contextual&&<button type="button" className={css.mobileBack} onClick={()=>{setMobileLayer('category');remember({mobileLayer:'category'})}}><ArrowLeft size={15}/>{t('teamCapability.back.categories')}</button>}<header><div>{!contextual&&<h2>{groupTitle(category)}</h2>}</div><div className={css.directoryActions}>{createAvailable&&<button type="button" className={css.createToggle} aria-expanded={createOpen} onClick={()=>setCreateOpen(value=>!value)}><Plus size={14} aria-hidden="true"/>{t('capabilityCenter.create')}{pendingCount>0&&<em>{t('capabilityCenter.pendingDrafts',{count:pendingCount})}</em>}</button>}{(state.status==='ready'||category==='extension'||category==='skill')&&<ToolbarIconButton label={t('teamCapability.directory.refresh')} icon={RefreshCw} disabled={category==='skill'?studioSkills.status==='loading':state.catalogStatus==='loading'||runtime.status==='loading'} onClick={refresh}/>}</div></header><label className={css.search}><Search size={16}/><input value={query} aria-label={t('capabilityCenter.search')} placeholder={t('capabilityCenter.search')} onChange={event=>{setQuery(event.target.value);remember({query:event.target.value})}}/>{query&&<ToolbarIconButton label={t('capabilityCenter.clear')} icon={X} onClick={()=>{setQuery('');remember({query:''})}}/>}</label>{createOpen&&category==='skill'&&pageCreate&&<div className={css.createEntry}><CreateEntry entity="skill" directSentence {...(sharing?{sentenceDraft:{key:'teloa.my-resource-creation-input/v1/skill',storage:sharing.storage}}:{})} api={pageCreate.api} prepare={pageCreate.prepare} openMarket={openMarket} onConfirm={pageCreate.confirmSkill} afterConfirm={pageCreate.openSkill}/></div>} {createOpen&&category==='extension'&&pageCreate?.marketPluginInstallApi&&<div className={css.createEntry}><CreateEntry entity="extension" directSentence descriptionPlaceholderKey="create.sentence.placeholder.app" {...(sharing?{sentenceDraft:{key:'teloa.my-resource-creation-input/v1/extension',storage:sharing.storage}}:{})} api={pageCreate.api} prepare={pageCreate.prepare} openMarket={pageCreate.openExtensionMarket??openMarket} renderConfirmation={({preview,apply})=><ExtensionCreateEntry preview={preview} api={pageCreate.marketPluginInstallApi!} apply={apply}/>}/></div>} {category==='skill'&&studioSkills.status!=='ready'&&<p className={studioSkills.status==='failed'?css.error:css.muted} role={studioSkills.status==='failed'?'alert':'status'}>{t(studioSkills.status==='failed'?'teamCapability.error.load':'teamCapability.directory.loading')}{studioSkills.status==='failed'&&<button type="button" onClick={()=>setStudioRevision(value=>value+1)}>{t('teamCapability.directory.refresh')}</button>}</p>}{category!=='skill'&&state.catalogStatus==='failed'&&items.length>0&&<p className={css.error} role="alert">{t('teamCapability.error.load')}</p>}{category==='extension'&&pluginDirectory?.loading&&<p role="status" className={css.muted}>{t('teamCapability.directory.loading')}</p>}{category==='extension'&&(pluginDirectory?.error||pluginDirectory?.partial)&&<p role="alert" className={css.error}>{t('extension.business.readFailed')} <button type="button" onClick={()=>void refreshPlugins().catch(()=>{})}>{t('teamCapability.directory.refresh')}</button></p>}{category==='extension'&&runtime.status==='failed'&&<p className={css.error} role="alert">{t('teamCapability.error.load')} <button type="button" onClick={()=>void runtimeExtensions.refresh()}>{t('teamCapability.directory.refresh')}</button></p>}{category==='skill'&&studioSkills.status!=='ready'&&!items.length?null:category==='extension'&&runtime.status==='loading'&&!items.length?<p role="status" className={css.muted}>{t('teamCapability.directory.loading')}</p>:category!=='skill'&&state.status!=='ready'&&!items.length?<div className={css.emptyState}><p>{state.status==='failed'?t('teamCapability.error.load'):t('teamCapability.session.unavailable')}</p><button type="button" onClick={openConversation}>{t('teamCapability.session.open')}</button></div>:category!=='skill'&&state.catalogStatus==='failed'&&!items.length?<p className={css.error} role="alert">{t('teamCapability.error.load')}</p>:category!=='skill'&&state.catalogStatus==='loading'&&!items.length?<p className={css.muted} role="status">{t('teamCapability.directory.loading')}</p>:!items.length&&localTemplates?null:items.length?<div ref={rowList} className={css.rowList} role="listbox" aria-label={groupTitle(category)} onKeyDown={navigateRows}>{items.map((row,index)=>{const rowSubtitle=row.toolKeys?t('capabilityCenter.tools',{count:row.toolKeys.length}):subtitle(row);return <button key={row.key} data-teloa-entry={row.key} type="button" role="option" aria-selected={selected?.key===row.key} tabIndex={selected?.key===row.key||(!selected&&index===0)?0:-1} onClick={()=>{setSelectedKey(row.key);setDetailOpen(true);setMobileLayer('detail');remember({selectedId:row.key,mobileLayer:'detail'})}}><ResourceIcon kind={row.rowId} id={row.key} title={row.title}/><span><strong>{row.title}</strong>{rowSubtitle&&<small>{rowSubtitle}</small>}</span><em>{itemState(row)}</em><ChevronRight size={15}/></button>})}</div>:<div className={css.emptyState}><p>{t(query.trim()?'capabilityCenter.noMatch':emptyKey)}</p><button type="button" onClick={category==='skill'?openConversation:category==='source'?nativeSettings:openMarket}>{t(category==='skill'?'teamCapability.session.open':category==='source'?'teamCapability.connection.manage':'teamCapability.market.add')}</button></div>}{localTemplates&&templates!.render()}</main>
 const selectedDetails=<section data-teloa-pane="detail" className={css.detail}>{contextual&&<ToolbarIconButton label={t('teamCapability.back.directory')} icon={ArrowLeft} onClick={()=>{setDetailOpen(false);setMobileLayer('list');remember({mobileLayer:'list'})}}/>}{selected?.native?<RuntimeExtensionDetail item={selected.native} resolveText={resolveExtensionText} manage={nativeSettings}/>:selected?<><h2>{selected.title}</h2><p className={css.status}>{itemState(selected)}</p>{selected.instanceId&&!selected.skillStatus&&<p className={css.registeredNotice}>{t('teamCapability.registered.notice')}</p>}<dl><dt>{t('teamCapability.field.source')}</dt><dd>{selected.industry?.templateTitle??source(selected)}</dd><dt>{t('teamCapability.field.scope')}</dt><dd>{selected.toolKeys?t('capabilityCenter.tools',{count:selected.toolKeys.length}):detail(selected)}</dd></dl><section className={css.readiness}><span>{t('teamCapability.next.title')}</span><strong>{t(selected.rowId==='extension'?'teamCapability.next.plugin':selected.rowId==='source'?selected.instanceId?'teamCapability.next.connection':'teamCapability.next.verifyConnection':selected.rowId==='skill'?selected.skillStatus==='installed'?'capabilityCenter.skill.next.installed':selected.skillStatus==='unlinked'?'capabilityCenter.skill.next.unlinked':selected.instanceId?'teamCapability.next.install':'teamCapability.next.skill':'teamCapability.next.install')}</strong></section><div className={base.buttons}><button type="button" onClick={()=>goItem(selected)}>{t('composition.action.configure')}</button></div></>:<section className={css.emptyDetail}><h2>{t('teamCapability.detail.emptyTitle')}</h2><p>{t('teamCapability.detail.emptyDescription')}</p></section>}{selected&&!selected.native&&<details className={css.technical} key={selected.key}><summary>{t('teamCapability.field.templateVersion')} · {t('teamCapability.field.boundary')}</summary>{selected.toolKeys&&<ul className={css.tools}>{selected.toolKeys.map(key=><li key={key}>{key.replace(/^source:mcp__.+?__/,'')}</li>)}</ul>}<dl>{selected.instanceId&&<><dt>{t('teamCapability.field.templateVersion')}</dt><dd>{source(selected)}</dd><dt>{t('teamCapability.field.instance')}</dt><dd>{selected.instanceId}</dd></>}<dt>{t('teamCapability.field.boundary')}</dt><dd>{boundary(selected)}</dd></dl><section className={css.ownership}><span className={css.eyebrow}>{t('teamCapability.ownership.title')}</span><dl><dt>DSH</dt><dd>{t('teamCapability.ownership.dsh')}</dd><dt>Teloa</dt><dd>{t('teamCapability.ownership.teloa')}</dd></dl></section></details>}</section>
 if(contextual)return <div>{detailOpen&&selected?selectedDetails:directory}</div>
 return <section className={css.catalog} aria-label={t('capabilityCenter.myResources')}>
  <header className={css.groupHeader}><h2>{t('capabilityCenter.myResources')}</h2></header>
  <div {...directoryFocus} className={css.workspace} data-detail-open={detailOpen&&!!selected} data-mobile-layer={mobileLayer}>
  <nav className={css.taxonomy} aria-label={t('capabilityCenter.groupsAria')}><h2>{t('capabilityCenter.groupsAria')}</h2><div>{groups.map(id=><button key={id} type="button" aria-current={category===id?'page':undefined} onClick={()=>selectGroup(id)}><span>{categoryIcon(id)}</span><strong>{groupTitle(id)}</strong><small>{groupDescription(id)}</small></button>)}</div></nav>
  {directory}
  </div>
  {detailOpen&&selected&&<ContextDrawer title={t('teamCapability.detail.aria')} close={()=>{setDetailOpen(false);setMobileLayer('list');remember({mobileLayer:'list'})}}>{selectedDetails}</ContextDrawer>}
 </section>
}
