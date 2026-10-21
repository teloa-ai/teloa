import {ToolbarIconButton} from './ToolbarIconButton.js'
import type {BusinessObjectReference,LocalizedMetadata} from '@teloa/contract'
import {useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react'
import {ArrowLeft,ArrowUpRight,MessageSquare,PencilRuler,RefreshCw,Share2,SlidersHorizontal} from 'lucide-react'
import {businessWorkspaceText} from './business-workspace-copy.js'
import type {BusinessBuilderApi} from './business-builder-api.js'
import type {BusinessRecordFlow,BusinessRecordCapabilities} from './business-record-flow.js'
import type {BusinessImportTargetFactory} from './business-import-integration.js'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import type {BusinessTarget} from './business-preview.js'
import {BusinessConfigurationSurfaceController,businessReferencePageUnavailable,type BusinessConfigurationPageKind,type BusinessConfigurationSelection} from './business-configuration-surface.js'
import {BusinessConfigurationPage} from './BusinessConfigurationPage.js'
import {localizedBusinessPageTitle} from './business-definition-localization.js'
import {BusinessResponsibility,type BusinessResponsibilityProps} from './BusinessResponsibility.js'
import {BusinessSetup,type BusinessSetupServices} from './BusinessSetup.js'
import {BusinessTaskList,type BusinessTaskListProps} from './BusinessTaskList.js'
import {BusinessSyncControls} from './BusinessSyncControls.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessConfigurationSurface.module.css'
import light from './light-actions.module.css'
import {BusinessPendingChanges} from './BusinessWorkResults.js'
export type BusinessConfigurationServices={importFlow?:BusinessImportTargetFactory|undefined;dashboardApi?:BusinessDashboardApi|undefined;onDispatch?:((reference:BusinessObjectReference)=>void)|undefined;api:BusinessBuilderApi;records:BusinessRecordFlow;capabilities:BusinessRecordCapabilities;adjust:(scope:string)=>void;talk?:(scope:string,title:string)=>void;newConversation?:(scope:string,title:string)=>void;actionReady?:boolean;conversationStatus?:ReactNode;share?:((scope:string)=>ReactNode)|undefined;reviewSetup?:((scope:string)=>ReactNode)|undefined;manualSetup?:((scope:string)=>void)|undefined;selection?:BusinessConfigurationSelection;setup?:BusinessSetupServices;responsibility?:Pick<BusinessResponsibilityProps,'api'|'roles'>;taskList?:Pick<BusinessTaskListProps,'api'|'roleName'|'openTask'|'openArtifact'|'openSource'>}
type Props={refreshKey?:number|undefined;chrome?:boolean|undefined;pageKind?:BusinessConfigurationPageKind|undefined;recordReference?:BusinessObjectReference|undefined;scope:string;services:BusinessConfigurationServices;colorScheme:'light'|'dark';legacy:()=>ReactNode;backHome:()=>void;go?:((target:BusinessTarget)=>void)|undefined;embedded?:boolean;openFull?:()=>void}
const rangeLabels={'24h':'business.dashboards.range.24h','7d':'business.dashboards.range.7d','30d':'business.dashboards.range.30d','90d':'business.dashboards.range.90d',all:'business.dashboards.range.all'} as const
type ConfigurationCurrent=NonNullable<Awaited<ReturnType<BusinessBuilderApi['current']>>>
type DetailsRead={identity:object;status:'loading'|'failed'|'ready';current?:ConfigurationCurrent}

/**
 * 两个业务入口共用配置详情；未知或失败留在原上下文，仅明确缺失才交回模板配置。
 * includeShare：业务工作区的页签不再各摆一排业务级按钮，「分享业务配置」随「调整业务」收在这里。
 */
export function BusinessConfigurationDetails({scope,services,current,open,close,legacy,includeShare=false,initialSection='definition'}:{scope:string;services:BusinessConfigurationServices;current?:ConfigurationCurrent;open:boolean;close:()=>void;legacy?:()=>void;includeShare?:boolean;initialSection?:'definition'|'members'|'resources'|'connections'|'advanced'}){
 const {t,locale}=useI18n(),identity=useMemo(()=>({}),[scope,services.api]),[sharing,setSharing]=useState(false),[section,setSection]=useState(initialSection)
 const text=(cn:string,hant:string,en:string)=>locale==='zh-CN'?cn:locale.startsWith('zh')?hant:en
 const [read,setRead]=useState<DetailsRead>({identity,status:'loading'}),[readRevision,setReadRevision]=useState(0),[setupRefresh,setSetupRefresh]=useState(0),[saving,setSaving]=useState(false)
 const callbacks=useRef({close,legacy});callbacks.current={close,legacy}
 useEffect(()=>{
  if(current!==undefined||!open)return
  const controller=new AbortController(),{signal}=controller
  setRead(previous=>({identity,status:'loading',...(previous.identity===identity&&previous.current?{current:previous.current}:{})}))
  void services.api.current({scope},signal).then(value=>{
   if(signal.aborted)return
   if(value===null){setRead({identity,status:'ready'});callbacks.current.close();callbacks.current.legacy?.();return}
   if(value.scope!==scope)throw Error('正式业务配置与当前业务不一致。')
   setRead({identity,status:'ready',current:value})
  }).catch(()=>{if(!signal.aborted)setRead(previous=>({...previous,identity,status:'failed'}))})
  return()=>controller.abort()
 },[identity,scope,services.api,current,open,readRevision])
 const visible=read.identity===identity?read:undefined,selected=current??visible?.current,ready=current!==undefined||visible?.status==='ready'
 return <ContextDrawer open={open} title={t('business.setup.details')} close={close} canClose={!saving} className={css.settingsDrawer??''}>
  <div className={css.detailsBody}>
  {!ready&&(visible?.status==='failed'?<p role="alert">{t('business.configuration.readFailed')} <button type="button" onClick={()=>setReadRevision(value=>value+1)}>{t('business.records.retry')}</button></p>:<p role="status">{t('business.configuration.loading')}</p>)}
  <div hidden={!ready} className={css.settingsLayout}>
   <nav className={css.settingsNav} aria-label={t('business.setup.details')}>{([['definition',text('业务定义','業務定義','Business definition')],['members',text('员工与能力','員工與能力','Employees and capabilities')],['resources',t('business.setup.knowledge')],['connections',t('business.setup.connections')],['advanced',text('高级设置','進階設定','Advanced')]] as const).map(([id,label])=><button type="button" key={id} aria-current={section===id?'page':undefined} onClick={()=>setSection(id)}>{label}</button>)}</nav>
   <div className={css.settingsPanel}>
   {selected&&<>
    <section hidden={section!=='definition'}><h2>{selected.manifest.title}</h2><p className={css.settingsHint}>{text('修改先成为搭建草案，核对后再应用到业务。','修改會先成為搭建草案，核對後再套用至業務。','Changes become a draft for review before they are applied.')}</p>
    <div className={css.detailsActions}>
     <button type="button" className={css.actionCard} aria-label={t('business.configuration.adjust')} disabled={services.actionReady===false} onClick={()=>{close();services.adjust(scope)}}><PencilRuler size={16} aria-hidden/><span><strong>{t('business.configuration.adjust')}</strong><small>{businessWorkspaceText(locale,'adjustHint')}</small></span></button>
     {includeShare&&services.share&&<button type="button" className={css.actionCard} aria-label={t('business.share.title')} disabled={services.actionReady===false} aria-expanded={sharing} onClick={()=>setSharing(value=>!value)}><Share2 size={16} aria-hidden/><span><strong>{t('business.share.title')}</strong><small>{businessWorkspaceText(locale,'shareHint')}</small></span></button>}
    </div>
    {includeShare&&sharing&&services.share?.(scope)}</section>
    <div hidden={section==='advanced'}>{services.setup&&<BusinessSetup scope={scope} title={selected.manifest.title} configurationVersion={selected.version} configurationHash={selected.hash} services={services.setup} refreshKey={setupRefresh} visible={open&&ready&&section!=='advanced'} sections={section==='definition'?['colleagues','skills','knowledge','connections']:section==='members'?['colleagues','skills']:section==='resources'?['knowledge']:section==='connections'?['connections']:[]}/>}</div>
    <div hidden={section!=='members'}>{services.responsibility&&<BusinessResponsibility scope={scope} {...services.responsibility} visible={open&&ready&&section==='members'} onSavingChange={setSaving} onChanged={()=>setSetupRefresh(value=>value+1)}/>}</div>
    <div hidden={section!=='advanced'}>{services.dashboardApi&&<BusinessSyncControls key={scope} scope={scope} api={services.dashboardApi} visible={open&&ready&&section==='advanced'} showEmpty/>}</div>
   </>}
  </div></div>
  </div>
 </ContextDrawer>
}
/** 宿主随 current 附上的页名本地化元数据（只在页名仍是定义原文时提供）。 */
const pageTitleSource=(title:string,metadata:LocalizedMetadata|undefined)=>metadata?{title,localized:{title:metadata}}:undefined

/**
 * current明确缺失才挂载旧业务；失败、认证实例变化和读取在途均不展示旧范围内容。
 * chrome=false 时嵌在业务工作区页签里：开始工作、另建会话、业务设置（含调整与分享）、刷新由工作区页头统一提供，
 * 这里只保留本页签自己的内容；pageKind 让「业务内容」只列记录页、「统计看板」只列看板页。
 */
export function BusinessConfigurationSurface({refreshKey=0,chrome=true,pageKind,scope,services,colorScheme,legacy,backHome,go,recordReference,embedded=false,openFull}:Props){
 const {t,locale}=useI18n()
 const [sharing,setSharing]=useState(false),[configuring,setConfiguring]=useState(false)
 useEffect(()=>{setConfiguring(false);setSharing(false)},[scope])
 const referenceKey=JSON.stringify(recordReference)
 const controller=useMemo(()=>new BusinessConfigurationSurfaceController(services.api,scope,services.selection,recordReference,pageKind),[services.api,services.records,services.selection,scope,referenceKey,pageKind])
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot)
 useEffect(()=>{void controller.load()},[controller,refreshKey])
 useEffect(()=>()=>controller.dispose(),[controller])
 if(state.status==='legacy')return <>{legacy()}</>
 const current=state.current,page=state.page,ranges=page?.page.kind==='dashboard'?page.page.dashboard.filters?.timeRange.options:undefined
 const pages=current?controller.pages(current):[],recordsVisible=pageKind!=='dashboard'
 return <section className={chrome?css.page:css.contentOnly} aria-label={t('business.scope.pageAria')} aria-busy={state.status==='loading'}>
  <div className={css.scroll}><div className={css.container}>
   {chrome&&<header className={css.header}>
    <div>{!embedded&&<button type="button" className={css.back} onClick={backHome}><ArrowLeft size={14}/>{t('business.scope.backHome')}</button>}{current&&<h1>{current.manifest.title}</h1>}</div>
    {current&&<div className={css.actions}>
     <button type="button" disabled={services.actionReady===false} onClick={()=>services.adjust(scope)}><SlidersHorizontal size={15}/>{t('business.configuration.adjust')}</button>
     {services.talk&&<button type="button" className={css.primary} disabled={services.actionReady===false} onClick={()=>services.talk!(scope,current.manifest.title)}><MessageSquare size={15}/>{t('business.configuration.talk')}</button>}
     {services.newConversation&&<button type="button" disabled={services.actionReady===false} onClick={()=>services.newConversation!(scope,current.manifest.title)}>{t('navigation.newConversation')}</button>}
     {services.share&&<button type="button" disabled={services.actionReady===false} aria-expanded={sharing} onClick={()=>setSharing(value=>!value)}>{t('business.share.title')}</button>}
     {(services.setup||services.responsibility||services.dashboardApi)&&<button type="button" aria-expanded={configuring} onClick={()=>setConfiguring(true)}><SlidersHorizontal size={15}/>{t('business.setup.details')}</button>}
     <ToolbarIconButton label={t('business.dashboards.refresh')} icon={RefreshCw} disabled={state.pageStatus==='loading'} onClick={()=>void controller.load()}/>
     {embedded&&openFull&&<button type="button" className={light.link} onClick={openFull}>{t('business.scope.openFull')}<ArrowUpRight size={13} aria-hidden/></button>}
    </div>}
   </header>}
   {services.actionReady===false&&<p role="status">{t('business.daily.readyWaiting')}</p>}
   {services.conversationStatus}
   {recordsVisible&&services.records.api.work?.enabled&&<BusinessPendingChanges key={scope} scope={scope} api={services.records.api.work}/>}
   {state.status==='loading'&&<p className={css.notice} role="status">{t('business.configuration.loading')}</p>}
   {state.status==='failed'&&<p className={css.notice} role="alert">{t(businessReferencePageUnavailable(state.error)?'business.records.reference.noPage':'business.configuration.readFailed')} <button type="button" onClick={()=>void controller.load()}>{t('business.records.retry')}</button></p>}
   {current&&<>
    {chrome&&sharing&&services.share?.(scope)}
    {chrome&&(services.setup||services.responsibility||services.dashboardApi)&&<BusinessConfigurationDetails key={scope} scope={scope} services={services} current={current} open={configuring} close={()=>setConfiguring(false)}/>}
    {(!pageKind||pages.length>1)&&<nav className={css.navigation} aria-label={t('business.configuration.pages')}>{pages.map(item=><button key={item.id} type="button" aria-current={state.selectedId===item.id?'page':undefined} onClick={()=>void controller.select(item.id)}>{localizedBusinessPageTitle(item,pageTitleSource(item.title,current.pageTitles?.[item.id]),locale)}</button>)}</nav>}
    <div className={css.content} aria-busy={state.pageStatus==='loading'}>
     {state.pageStatus==='loading'&&<p className={css.notice} role="status">{t('business.configuration.loading')}</p>}
     {state.pageStatus==='failed'&&<p className={css.notice} role="alert">{t('business.configuration.readFailed')} <button type="button" onClick={()=>void controller.load()}>{t('business.records.retry')}</button></p>}
     {state.status==='ready'&&!state.selectedId&&pageKind&&<div className={css.notice} role="status"><span>{t(pageKind==='dashboard'?'business.configuration.noDashboardPages':'business.configuration.noRecordPages')}</span><button type="button" disabled={services.actionReady===false} onClick={()=>services.adjust(scope)}>{t('business.configuration.adjust')}</button></div>}
     {page&&state.pageStatus==='ready'&&<>
      {page.page.kind==='dashboard'&&(ranges||!chrome)&&<div className={css.range}>{ranges&&<label>{t('business.dashboards.range.label')}<select value={page.page.timeRange} onChange={event=>{const next=ranges.find(value=>value===event.target.value);if(next&&state.selectedId)void controller.select(state.selectedId,next)}}>{ranges.map(value=><option key={value} value={value}>{t(rangeLabels[value])}</option>)}</select></label>}{!chrome&&<ToolbarIconButton label={t('business.dashboards.refresh')} icon={RefreshCw} onClick={()=>void controller.load()}/>}</div>}
      <BusinessConfigurationPage projection={page} recordFlow={services.records} capabilities={services.capabilities} importFlow={services.importFlow} colorScheme={colorScheme} go={go} onDispatch={services.onDispatch} taskList={services.taskList} recordReference={recordReference} recordSource={{api:services.api,current}}/>
     </>}
    </div>
    {recordsVisible&&services.taskList&&<BusinessTaskList scope={scope} {...services.taskList}/>}
   </>}
  </div></div>
 </section>
}
