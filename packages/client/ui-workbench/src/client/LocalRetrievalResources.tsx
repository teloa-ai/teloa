import {ActionButton} from '@teloa/client-ui-kit'
import type {WorkResource} from '@teloa/contract'
import type {LocalRetrievalApi,RetrievalStatus} from './local-retrieval-api.js'
import type {RetrievalTranslate} from './LocalRetrievalModelPanel.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './LocalRetrieval.module.css'

/**
 * 资料页顶部的「本地检索」：一句用途、已加入份数、每份资料一行「名称 · 已加入/未加入 [加入]/[移出]」、底部一句说明。
 * 重建收进「更多」，整理进行中的「停止整理」就近可点；索引块数只在「详细信息」里。加入与移出仍按资料来源生效。
 */
export function LocalRetrievalResourcesPresentation({status,resource,busy,error,readFailed,t,onEnroll,onRemove,onReindex,onCancel}:{status?:RetrievalStatus|undefined;resource?:WorkResource|undefined;busy:boolean;error:string;readFailed?:boolean;t:RetrievalTranslate;onEnroll:(sourceId:string)=>void;onRemove:(sourceId:string)=>void;onReindex:()=>void;onCancel:()=>void}){
 const enrolled=!!resource&&!!status?.items.some(item=>item.sourceId===resource.sourceId)
 const listed=!!resource&&!!status?.items.some(item=>item.resourceId===resource.id)
 // 选中的资料已在已加入列表里就不再单独占一行；未加入、已撤回或只有同来源其他版本在列表里时，单独给它一行。
 const selectedRow=resource&&!listed?{title:resource.title,sourceId:resource.sourceId,label:resource.status!=='active'?t('retrieval.index.unavailable'):enrolled?t('retrieval.resources.enrolled'):t('retrieval.index.excluded')}:undefined
 const itemLabel=(state:RetrievalStatus['items'][number]['state'])=>state==='unavailable'?t('retrieval.index.unavailable'):t('retrieval.resources.enrolled')+' · '+t('retrieval.index.'+state)
 const readOnly=busy||!status||!!readFailed
 // 加入与移出按来源生效：同一来源有多份资料时写明会一起移出。
 const sourceCount=(sourceId:string)=>status?.items.filter(row=>row.sourceId===sourceId&&row.resourceId!==null).length??0
 const together=(sourceId:string)=>sourceCount(sourceId)>1&&<small className={css.together}>{t('retrieval.resources.sourceImpact',{count:sourceCount(sourceId)})}</small>
 return <section className={`${css.panel} ${css.compact} ${css.search}`} aria-label={t('retrieval.resources.title')} data-retrieval-resources>
  <header className={css.searchHeader}>
   <div className={css.searchIntro}><strong>{t('retrieval.resources.title')}</strong><p>{t('retrieval.resources.summary')}</p></div>
   <div className={css.searchTools}>
    {status?<span role="status" className={css.count}>{t('retrieval.resources.counts',{sources:status.enrolled})}</span>:<span className={css.count}>{t('retrieval.phase.checking')}</span>}
    {status?.building&&<ActionButton className={css.button} disabled={busy} onClick={onCancel}>{t(busy?'retrieval.resources.working':'retrieval.resources.cancel')}</ActionButton>}
    {status&&!status.building&&<details className={css.more} data-retrieval-more><summary>{t('retrieval.resources.more')}</summary><div className={css.moreMenu}><ActionButton className={css.menuItem} disabled={busy||status.enrolled===0||!!readFailed} onClick={(event?:{currentTarget:HTMLElement})=>{event?.currentTarget.closest('details')?.removeAttribute('open');onReindex()}}>{t(busy?'retrieval.resources.working':'retrieval.resources.rebuild')}</ActionButton></div></details>}
   </div>
  </header>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {(selectedRow||!!status?.items.length)&&<ul className={css.rows}>
   {selectedRow&&<li className={css.row} aria-current="true"><span className={css.rowText}>{selectedRow.title+' · '+selectedRow.label}{enrolled&&together(selectedRow.sourceId)}</span>{enrolled
    ?<ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title:selectedRow.title})} disabled={readOnly} onClick={()=>onRemove(selectedRow.sourceId)}>{t('retrieval.resources.remove')}</ActionButton>
    :<ActionButton className={css.button} aria-label={t('retrieval.resources.enrollAria',{title:selectedRow.title})} disabled={readOnly||resource?.status!=='active'} onClick={()=>onEnroll(selectedRow.sourceId)}>{t('retrieval.resources.enroll')}</ActionButton>}</li>}
   {status?.items.map(row=>{const title=row.title??t('retrieval.index.unavailable');return <li key={row.resourceId??row.sourceId} className={css.row} aria-current={resource&&row.resourceId===resource.id?'true':undefined}><span className={css.rowText}>{title+' · '+itemLabel(row.state)}{together(row.sourceId)}</span><ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title})} disabled={busy||!!readFailed} onClick={()=>onRemove(row.sourceId)}>{t('retrieval.resources.remove')}</ActionButton></li>})}
  </ul>}
  <p className={css.hint}>{t('retrieval.resources.hint')}</p>
  {status&&status.items.length>0&&<details className={css.info}><summary>{t('retrieval.resources.details')}</summary><ul>{status.items.map(row=><li key={row.resourceId??row.sourceId}>{row.title??t('retrieval.index.unavailable')} · {t('retrieval.index.'+row.state)}{row.chunkCount!==null&&` · ${t('retrieval.resources.chunks',{count:row.chunkCount})}`}</li>)}</ul><p>{t('retrieval.resources.totalChunks',{chunks:status.chunks})}</p></details>}
 </section>
}
export function LocalRetrievalResources({api,resource,visible}:{api:LocalRetrievalApi;resource?:WorkResource|undefined;visible:boolean}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(signal=>api.status(signal),api,visible)
 return <LocalRetrievalResourcesPresentation status={snapshot.value} resource={resource} busy={snapshot.busy} readFailed={snapshot.readFailed} error={snapshot.error?localizeWorkError(locale,snapshot.error):''} t={t as RetrievalTranslate} onEnroll={id=>void snapshot.run(signal=>api.enroll(id,signal))} onRemove={id=>void snapshot.run(signal=>api.remove(id,signal))} onReindex={()=>void snapshot.run(signal=>api.reindex(signal))} onCancel={()=>void snapshot.run(signal=>api.cancel(signal))}/>
}
