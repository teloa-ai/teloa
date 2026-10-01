import type {CSSProperties} from 'react'
import type {BusinessConfigurationViewRef,BusinessConfigurationViewRefVersioned,BusinessDashboardDefinition,BusinessLedger,BusinessWidgetDefinition,BusinessWidgetResult,BusinessViewWidgetResultV2} from '@teloa/contract'
import {BusinessWidget} from './BusinessWidgets.js'
import {BusinessTypedViewWidget} from './BusinessTypedViewWidget.js'
import type {BusinessTarget} from './business-preview.js'
import css from './BusinessDashboardPage.module.css'

export type BusinessDashboardGridProps={
 dashboard:Pick<BusinessDashboardDefinition,'layout'>
 widgets:readonly BusinessWidgetDefinition[]
 results:readonly BusinessWidgetResult[]|readonly BusinessViewWidgetResultV2[]
 ledger?:BusinessLedger|undefined
 viewRefs?:readonly BusinessConfigurationViewRefVersioned[]|undefined
 colorScheme:'light'|'dark'
 ranged?:boolean
 go?:((target:BusinessTarget)=>void)|undefined
}
/** 共用原有十二列布局和组件，不持有请求、刷新或保存逻辑。 */
export function BusinessDashboardGrid({dashboard,widgets,results,ledger,viewRefs,colorScheme,ranged=false,go}:BusinessDashboardGridProps){
 return <div className={css.grid}>{dashboard.layout.map(item=>{
  const widget=widgets.find(entry=>entry.id===item.widget)
  if(!widget)return null
  const style={'--widget-column':`${item.x+1} / span ${item.w}`,'--widget-row':`${item.y+1} / span ${item.h}`} as CSSProperties
  const result=results.find(result=>result.widgetId===item.widget)
  const legacyRefs=viewRefs?.filter((ref):ref is BusinessConfigurationViewRef=>ref.view.format==='teloa.business-view/v1'&&ref.objectType.format==='teloa.business-object-type/v1')
  return <article key={item.widget} className={css.widget} style={style} data-widget={item.widget}>
   {result&&'format'in result?<BusinessTypedViewWidget widget={widget} result={result} viewRefs={viewRefs}/>:<BusinessWidget widget={widget} result={result} ledger={ledger} viewRefs={legacyRefs} colorScheme={colorScheme} ranged={ranged} go={go}/>}
  </article>
 })}</div>
}
