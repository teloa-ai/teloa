import type {BusinessObjectReference} from '@teloa/contract'
import {useEffect,useMemo,useState,useSyncExternalStore,type ReactNode} from 'react'
import {ArrowLeft,MessageSquare,RefreshCw,SlidersHorizontal} from 'lucide-react'
import type {BusinessBuilderApi} from './business-builder-api.js'
import type {BusinessRecordFlow,BusinessRecordCapabilities} from './business-record-flow.js'
import type {BusinessImportTargetFactory} from './business-import-integration.js'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import type {BusinessTarget} from './business-preview.js'
import {BusinessConfigurationSurfaceController,businessReferencePageUnavailable,type BusinessConfigurationSelection} from './business-configuration-surface.js'
import {BusinessConfigurationPage} from './BusinessConfigurationPage.js'
import {BusinessResponsibility,type BusinessResponsibilityProps} from './BusinessResponsibility.js'
import {BusinessSetup,type BusinessSetupServices} from './BusinessSetup.js'
import {BusinessTaskList,type BusinessTaskListProps} from './BusinessTaskList.js'
import {BusinessSyncControls} from './BusinessSyncControls.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessConfigurationSurface.module.css'
export type BusinessConfigurationServices={importFlow?:BusinessImportTargetFactory|undefined;dashboardApi?:BusinessDashboardApi|undefined;onDispatch?:((reference:BusinessObjectReference)=>void)|undefined;api:BusinessBuilderApi;records:BusinessRecordFlow;capabilities:BusinessRecordCapabilities;adjust:(scope:string)=>void;talk?:(scope:string,title:string)=>void;newConversation?:(scope:string,title:string)=>void;actionReady?:boolean;conversationStatus?:ReactNode;share?:((scope:string)=>ReactNode)|undefined;selection?:BusinessConfigurationSelection;setup?:BusinessSetupServices;responsibility?:Pick<BusinessResponsibilityProps,'api'|'roles'>;taskList?:Pick<BusinessTaskListProps,'api'|'roleName'|'openTask'|'openArtifact'|'openSource'>}
type Props={recordReference?:BusinessObjectReference|undefined;scope:string;services:BusinessConfigurationServices;colorScheme:'light'|'dark';legacy:()=>ReactNode;backHome:()=>void;go?:((target:BusinessTarget)=>void)|undefined;embedded?:boolean;openFull?:()=>void}
const rangeLabels={'24h':'business.dashboards.range.24h','7d':'business.dashboards.range.7d','30d':'business.dashboards.range.30d','90d':'business.dashboards.range.90d',all:'business.dashboards.range.all'} as const
/** current明确缺失才挂载旧业务；失败、认证实例变化和读取在途均不展示旧范围内容。 */
export function BusinessConfigurationSurface({scope,services,colorScheme,legacy,backHome,go,recordReference,embedded=false,openFull}:Props){
 const {t}=useI18n()
 const [setupRefresh,setSetupRefresh]=useState(0),[sharing,setSharing]=useState(false)
 const referenceKey=JSON.stringify(recordReference)
 const controller=useMemo(()=>new BusinessConfigurationSurfaceController(services.api,scope,services.selection,recordReference),[services.api,services.records,services.selection,scope,referenceKey])
 const state=useSyncExternalStore(controller.subscribe,controller.getSnapshot,controller.getSnapshot)
 useEffect(()=>{void controller.load();return()=>controller.dispose()},[controller])
 if(state.status==='legacy')return <>{legacy()}</>
 const current=state.current,page=state.page,ranges=page?.page.kind==='dashboard'?page.page.dashboard.filters?.timeRange.options:undefined
 return <section className={css.page} aria-label={t('business.scope.pageAria')} aria-busy={state.status==='loading'}>
  <div className={css.scroll}><div className={css.container}>
   <header className={css.header}>
    <div>{!embedded&&<button type="button" className={css.back} onClick={backHome}><ArrowLeft size={14}/>{t('business.scope.backHome')}</button>}{current&&<h1>{current.manifest.title}</h1>}</div>
    {current&&<div className={css.actions}>
     <button type="button" disabled={services.actionReady===false} onClick={()=>services.adjust(scope)}><SlidersHorizontal size={15}/>{t('business.configuration.adjust')}</button>
     {services.talk&&<button type="button" className={css.primary} disabled={services.actionReady===false} onClick={()=>services.talk!(scope,current.manifest.title)}><MessageSquare size={15}/>{t('business.configuration.talk')}</button>}
     {services.newConversation&&<button type="button" disabled={services.actionReady===false} onClick={()=>services.newConversation!(scope,current.manifest.title)}>{t('navigation.newConversation')}</button>}
     {services.share&&<button type="button" disabled={services.actionReady===false} aria-expanded={sharing} onClick={()=>setSharing(value=>!value)}>{t('business.share.title')}</button>}
     <button type="button" disabled={state.pageStatus==='loading'} onClick={()=>void controller.load()}><RefreshCw size={15}/>{t('business.dashboards.refresh')}</button>
     {embedded&&openFull&&<button type="button" onClick={openFull}>{t('business.scope.openFull')}</button>}
    </div>}
   </header>
   {services.actionReady===false&&<p role="status">{t('business.daily.readyWaiting')}</p>}
   {services.conversationStatus}
   {state.status==='loading'&&<p className={css.notice} role="status">{t('business.configuration.loading')}</p>}
   {state.status==='failed'&&<p className={css.notice} role="alert">{t(businessReferencePageUnavailable(state.error)?'business.records.reference.noPage':'business.configuration.readFailed')} <button type="button" onClick={()=>void controller.load()}>{t('business.records.retry')}</button></p>}
   {current&&<>
    {sharing&&services.share?.(scope)}
    {services.setup&&<BusinessSetup scope={scope} title={current.manifest.title} configurationVersion={current.version} configurationHash={current.hash} services={services.setup} refreshKey={setupRefresh}/>}
    {services.responsibility&&<BusinessResponsibility scope={scope} {...services.responsibility} onChanged={()=>setSetupRefresh(value=>value+1)}/>}
    {services.dashboardApi&&<BusinessSyncControls key={scope} scope={scope} api={services.dashboardApi}/>}
    <nav className={css.navigation} aria-label={t('business.configuration.pages')}>{current.manifest.pages.map(item=><button key={item.id} type="button" aria-current={state.selectedId===item.id?'page':undefined} onClick={()=>void controller.select(item.id)}>{item.title}</button>)}</nav>
    <div className={css.content} aria-busy={state.pageStatus==='loading'}>
     {state.pageStatus==='loading'&&<p className={css.notice} role="status">{t('business.configuration.loading')}</p>}
     {state.pageStatus==='failed'&&<p className={css.notice} role="alert">{t('business.configuration.readFailed')} <button type="button" onClick={()=>void controller.load()}>{t('business.records.retry')}</button></p>}
     {page&&state.pageStatus==='ready'&&<>
      {ranges&&page.page.kind==='dashboard'&&<label className={css.range}>{t('business.dashboards.range.label')}<select value={page.page.timeRange} onChange={event=>{const next=ranges.find(value=>value===event.target.value);if(next&&state.selectedId)void controller.select(state.selectedId,next)}}>{ranges.map(value=><option key={value} value={value}>{t(rangeLabels[value])}</option>)}</select></label>}
      <BusinessConfigurationPage projection={page} recordFlow={services.records} capabilities={services.capabilities} importFlow={services.importFlow} colorScheme={colorScheme} go={go} onDispatch={services.onDispatch} taskList={services.taskList} recordReference={recordReference}/>
     </>}
    </div>
    {services.taskList&&<BusinessTaskList scope={scope} {...services.taskList}/>}
   </>}
  </div></div>
 </section>
}
