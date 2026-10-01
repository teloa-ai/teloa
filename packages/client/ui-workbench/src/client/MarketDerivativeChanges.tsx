import {marketDerivativeChangeTypes,type MarketCatalogDerivation,type MarketCatalogDerivativeChange,type MarketDerivativeChangeType} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {catalogText} from './market-catalog-api.js'
import css from './MarketDerivativeChanges.module.css'

const typeKeys:Record<MarketDerivativeChangeType,`market.catalog.derivative.type.${MarketDerivativeChangeType}`>={
 security:'market.catalog.derivative.type.security',fixed:'market.catalog.derivative.type.fixed',removed:'market.catalog.derivative.type.removed',adapted:'market.catalog.derivative.type.adapted',
 added:'market.catalog.derivative.type.added',improved:'market.catalog.derivative.type.improved',localized:'market.catalog.derivative.type.localized',
}
// 与契约 D5 同一文法：`<owner>/<repo>@<40位提交>:<仓库内路径>`
const upstreamPattern=/^([^/@:\s]+)\/([^/@:\s]+)@([0-9a-f]{40}):(.+)$/

/** 原版文件链接：只认指向条目锁定仓库与提交的出处（契约已核对，这里再防一次），路径含空段、`.`、`..` 时不给链接；逐段编码，前缀固定 github.com。 */
function originalFileUrl(upstream:string,repository:{owner:string;repo:string},commit:string):string|null{
 const match=upstreamPattern.exec(upstream)
 if(!match||match[1]!==repository.owner||match[2]!==repository.repo||match[3]!==commit)return null
 const segments=match[4]!.split('/')
 if(segments.some(segment=>segment===''||segment==='.'||segment==='..'))return null
 return 'https://github.com/'+[repository.owner,repository.repo,'blob',commit,...segments].map(encodeURIComponent).join('/')
}

export type MarketDerivativeChangesProps={derivation:MarketCatalogDerivation;repository:{owner:string;repo:string};commit:string}

/** 二次开发资源的修改清单：按契约七类优先级分组，每组默认收起，组内按 id 升序；组下写未修改文件数量。纯渲染，不发请求。 */
export function MarketDerivativeChanges({derivation,repository,commit}:MarketDerivativeChangesProps){
 const {t,locale}=useI18n()
 const groups=marketDerivativeChangeTypes.flatMap(type=>{
  const rows=derivation.changes.filter(change=>change.type===type).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0)
  return rows.length?[[type,rows] as const]:[]
 })
 const unchanged=derivation.unchangedFiles.length
 const item=(change:MarketCatalogDerivativeChange)=>{
  const url=change.upstream===null?null:originalFileUrl(change.upstream,repository,commit)
  return <li key={change.id} className={css.item}>
   <p className={css.summary}>{catalogText(change.summary,locale)}</p>
   <p>{t('market.catalog.derivative.reason',{reason:catalogText(change.reason,locale)})}</p>
   <p className={css.where}><code className={css.path}>{change.section?change.path+' · '+change.section:change.path}</code><span className={css.id}>{change.id}</span>{url?<a href={url} target="_blank" rel="noreferrer">{t('market.catalog.derivative.viewOriginal')}</a>:change.upstream===null?<span>{t('market.catalog.derivative.newFile')}</span>:null}</p>
  </li>
 }
 return <div className={css.changes}>
  <p className={css.title}>{t('market.catalog.derivative.title',{count:derivation.changes.length})}</p>
  {groups.map(([type,rows])=><details key={type} className={css.group}>
   <summary>{t('market.catalog.derivative.group',{type:t(typeKeys[type]),count:rows.length})}</summary>
   <ul>{rows.map(item)}</ul>
  </details>)}
  {unchanged>0&&<p>{t(unchanged===1?'market.catalog.derivative.unchangedOne':'market.catalog.derivative.unchangedMany',{count:unchanged})}</p>}
 </div>
}
