import type {BusinessConfigurationPageProjectionVersioned as BusinessConfigurationPageProjection,BusinessObjectReference} from '@teloa/contract'
import {BusinessDashboardGrid} from './BusinessDashboardGrid.js'
import {BusinessRecordPage,type BusinessRecordTaskList} from './BusinessRecordPage.js'
import type {BusinessRecordFlow,BusinessRecordCapabilities} from './business-record-flow.js'
import type {BusinessImportTargetFactory} from './business-import-integration.js'
import type {BusinessTarget} from './business-preview.js'
import {localizedBusinessViewTitle} from './business-definition-localization.js'
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
}
/** 候选预览与正式页面共享展示；仅正式页面接入记录操作和下钻。 */
export function BusinessConfigurationPage({projection,recordFlow,importFlow,capabilities,colorScheme,go,onDispatch,taskList,recordReference}:BusinessConfigurationPageProps){
 const {locale}=useI18n(),{page}=projection
 if(page.kind==='records')return projection.mode==='preview'?<BusinessRecordPage projection={projection}/>:<BusinessRecordPage projection={projection} {...(recordFlow?{flow:recordFlow}:{})} {...(capabilities?{capabilities}:{})} importFlow={importFlow} onDispatch={onDispatch} go={go} taskList={taskList} recordReference={recordReference?.type===page.objectType.id?recordReference:undefined}/>
 const title=localizedBusinessViewTitle(page.dashboard,locale)
 return <section className={css.surface} aria-label={title} data-dashboard={page.dashboard.id}>
  <header className={css.header}><h2>{title}</h2></header>
  <BusinessDashboardGrid dashboard={page.dashboard} widgets={page.widgets} results={page.results} viewRefs={page.viewRefs} colorScheme={colorScheme} ranged={page.dashboard.filters!==undefined} go={projection.mode==='saved'?go:undefined}/>
 </section>
}
