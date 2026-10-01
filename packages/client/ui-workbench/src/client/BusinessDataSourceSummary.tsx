import { Database } from 'lucide-react'
import type { BusinessObject } from './business-preview.js'
import type { CollaborationScope } from './collaboration-preview.js'
import { summarizeBusinessSources } from './business-data-summary.js'
import { useI18n } from './i18n/provider.js'
import css from './BusinessPage.module.css'

export function BusinessDataSourceSummary({scope,objects,onSelect}:{scope:CollaborationScope;objects:readonly BusinessObject[];onSelect:(source:string)=>void}){
  const {locale,t,dateTime,number}=useI18n()
  const rows=summarizeBusinessSources(objects,scope,locale)
  if(!rows.length)return null
  return <section className={css.sourceSummary} aria-label={t('business.source.aria')}>
    <header><div><Database size={17}/><div><h3>{t('business.source.title')}</h3><p>{t('business.source.description')}</p></div></div><span>{t('business.source.count',{count:number(rows.length)})}</span></header>
    <div className={css.sourceSummaryRows}>{rows.map(row=><button key={row.source} type="button" aria-label={t('business.source.filter',{source:row.source})} onClick={()=>onSelect(row.source)}><span><strong>{row.source}</strong><small>{t('business.source.objects',{count:number(row.total),types:row.types.join(t('business.common.separator'))})}</small></span><span><small>{t('business.source.latest')}</small><strong>{dateTime(row.latestReceivedAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</strong>{row.missing>0&&<em>{t('business.source.missing',{count:number(row.missing)})}</em>}</span></button>)}</div>
  </section>
}
