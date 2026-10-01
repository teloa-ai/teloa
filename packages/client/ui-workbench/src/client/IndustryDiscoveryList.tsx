import {isIndustryManifest} from './industry-manifest.ts'
import type { IndustryDiscovery } from './industry-directory.js'
import { inspectIndustryContent } from './industry-content.js'
import css from './MarketPage.module.css'
import {useI18n} from './i18n/provider.js'
import {localizedMarketItemCopy} from './market-home-presentation.js'
export function IndustryDiscoveryList({rows,selected,change,busy}:{rows:readonly IndustryDiscovery[];selected:readonly string[];change:(paths:string[])=>void;busy:boolean}){
 const {locale,t}=useI18n()
 return <section aria-label={t('market.industry.discovery.aria')}><h3>{t('market.industry.discovery.count',{count:rows.length})}</h3><p>{t('market.industry.discovery.help')}</p>{!rows.length&&<p>{t('market.industry.discovery.empty')}</p>}{rows.map(row=>{
  const item=row.item,copy=item?localizedMarketItemCopy(item,locale):undefined,inspections=isIndustryManifest(item?.manifest)&&item.packageContent?inspectIndustryContent(item.manifest,item.packageContent):[]
  const issues=inspections.filter(value=>value.state==='invalid'||value.state==='missing'),pending=inspections.filter(value=>value.state==='pending'||value.state==='unresolved')
  return <div className={css.component} key={row.path}>{item&&copy?<><label className={css.check}><input type="checkbox" aria-label={t('market.industry.discovery.selectAria',{title:copy.title,path:row.path})} disabled={busy} checked={selected.includes(row.path)} onChange={event=>change(event.target.checked?[...selected,row.path]:selected.filter(path=>path!==row.path))}/><strong>{copy.title} · {item.version}</strong></label><span>{row.path}</span><p>{t('market.industry.discovery.summary',{count:inspections.length,issues:issues.length,pending:pending.length})}</p>{issues.length>0&&<details><summary>{t('market.industry.discovery.viewIssues')}</summary><ul>{issues.map(issue=><li key={issue.id}>{issue.id}：{issue.message}</li>)}</ul></details>}</>:<><strong>{row.path}</strong><p role="alert">{row.error}</p></>}</div>
 })}</section>
}
