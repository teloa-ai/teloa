import {businessObjectReference,type BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection,type BusinessObjectReference,type BusinessConfigurationViewRefVersioned} from '@teloa/contract'
import {useEffect,useMemo,useState} from 'react'
import {BusinessDashboardGrid} from './BusinessDashboardGrid.js'
import {BusinessRecordPage,type BusinessRecordTaskList} from './BusinessRecordPage.js'
import type {BusinessRecordFlow,BusinessRecordCapabilities} from './business-record-flow.js'
import type {BusinessImportTargetFactory} from './business-import-integration.js'
import type {BusinessTarget} from './business-preview.js'
import {localizedBusinessViewTitle} from './business-definition-localization.js'
import type {BusinessBuilderApi} from './business-builder-api.js'
import {readBusinessConfigurationSavedPage} from './business-configuration-surface.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessDashboardPage.module.css'

export type BusinessConfigurationPageProps={
 recordReference?:BusinessObjectReference|undefined
 taskList?:BusinessRecordTaskList|undefined
 projection:BusinessConfigurationPageProjection
 recordFlow?:BusinessRecordFlow
 importFlow?:BusinessImportTargetFactory|undefined
 capabilities?:BusinessRecordCapabilities
 onDispatch?:((reference:BusinessObjectReference)=>void)|undefined
 colorScheme:'light'|'dark'
 go?:((target:BusinessTarget)=>void)|undefined
 recordSource?:{api:Pick<BusinessBuilderApi,'page'>;current:NonNullable<Awaited<ReturnType<BusinessBuilderApi['current']>>>}|undefined
}
type RecordPreview={origin:object;reference:BusinessObjectReference;title:string;objectType:BusinessConfigurationViewRefVersioned['objectType']}
/** 两个看板入口共用原固定记录内容；正式记录页和快照各自核验，不改首页选页。 */
function DashboardRecordPreview({preview,source,flow,taskList,close,go}:{preview:RecordPreview;source:NonNullable<BusinessConfigurationPageProps['recordSource']>;flow:BusinessRecordFlow;taskList:BusinessConfigurationPageProps['taskList'];close:()=>void;go:BusinessConfigurationPageProps['go']}){
 const {t}=useI18n(),[read,setRead]=useState<{status:'loading'|'failed'|'ready';page?:BusinessConfigurationPageProjection}>({status:'loading'}),[revision,setRevision]=useState(0)
 useEffect(()=>{
  const abort=new AbortController(),reference=preview.reference,{current,api}=source
  setRead({status:'loading'})
  void (async()=>{
   const definition=current.manifest.pages.find(page=>page.kind==='records'&&page.objectType===reference.type)
   if(!definition||reference.scope!==current.scope)throw Error('记录不属于当前业务配置。')
   const page=await readBusinessConfigurationSavedPage(api,reference.scope,current,definition.id,abort.signal)
   if(abort.signal.aborted)return
   if(page.page.kind!=='records'||JSON.stringify(page.page.objectType)!==JSON.stringify(preview.objectType))throw Error('记录类型与看板来源不一致。')
   setRead({status:'ready',page})
  })().catch(()=>{if(!abort.signal.aborted)setRead({status:'failed'})})
  return()=>abort.abort()
 },[preview,source.api,source.current,revision])
 return <ContextDrawer title={preview.title} close={close}>
  {read.status==='loading'&&<p role="status">{t('business.records.loading')}</p>}
  {read.status==='failed'&&<p role="alert">{t('business.records.readError')} <button type="button" onClick={()=>setRevision(value=>value+1)}>{t('business.records.retry')}</button></p>}
  {read.status==='ready'&&read.page&&<BusinessRecordPage projection={read.page} flow={flow} recordReference={preview.reference} referenceOnly go={go} taskList={taskList}/>}
 </ContextDrawer>
}
/** 候选预览与正式页面共享展示；仅正式页面接入记录操作和下钻。 */
export function BusinessConfigurationPage({projection,recordFlow,importFlow,capabilities,colorScheme,go,onDispatch,taskList,recordReference,recordSource}:BusinessConfigurationPageProps){
 const {locale}=useI18n(),{page}=projection
 const origin=useMemo(()=>({}),[projection,recordFlow,recordSource?.api,recordSource?.current]),[preview,setPreview]=useState<RecordPreview>()
 if(page.kind==='records')return projection.mode==='preview'?<BusinessRecordPage projection={projection}/>:<BusinessRecordPage projection={projection} {...(recordFlow?{flow:recordFlow}:{})} {...(capabilities?{capabilities}:{})} importFlow={importFlow} onDispatch={onDispatch} go={go} taskList={taskList} recordReference={recordReference?.type===page.objectType.id?recordReference:undefined}/>
 const openRecord=(value:BusinessObjectReference)=>{
  if(projection.mode!=='saved'||!recordFlow||!recordSource||recordSource.current.scope!==projection.scope||recordSource.current.version!==projection.configurationVersion||recordSource.current.hash!==projection.configurationHash)return
  const reference=businessObjectReference(value)
  if(reference.scope!==projection.scope)return
  for(const result of page.results){
   if(!('format'in result)||result.view.kind!=='list'||result.view.scope!==reference.scope||result.view.objectType!==reference.type)continue
   const object=result.view.objects?.find(object=>object.id===reference.id&&object.version===reference.version&&object.snapshotHash===reference.snapshotHash)
   const ref=page.viewRefs.find(ref=>ref.view.id===result.view.viewId&&ref.objectType.id===reference.type&&ref.objectType.domain===reference.scope)
   if(object&&ref){setPreview({origin,reference,title:object.title,objectType:ref.objectType});return}
  }
 }
 const title=localizedBusinessViewTitle(page.dashboard,locale)
 return <><section className={css.surface} aria-label={title} data-dashboard={page.dashboard.id}>
  <header className={css.header}><h2>{title}</h2></header>
  <BusinessDashboardGrid dashboard={page.dashboard} widgets={page.widgets} results={page.results} viewRefs={page.viewRefs} colorScheme={colorScheme} ranged={page.dashboard.filters!==undefined} go={projection.mode==='saved'?go:undefined} openRecord={projection.mode==='saved'&&recordFlow&&recordSource?openRecord:undefined}/>
 </section>{preview?.origin===origin&&recordFlow&&recordSource&&<DashboardRecordPreview key={JSON.stringify(preview.reference)} preview={preview} source={recordSource} flow={recordFlow} taskList={taskList} close={()=>setPreview(undefined)} go={go}/>}</>
}
