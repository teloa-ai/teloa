import {ActionButton} from '@teloa/client-ui-kit'
import {useState} from 'react'
import {WorkError,embeddingProviderForCatalog,type EmbeddingProviderId,type WorkResource} from '@teloa/contract'
import type {LocalRetrievalApi,RetrievalStatus} from './local-retrieval-api.js'
import {LocalRetrievalModelPanel,type RetrievalTranslate} from './LocalRetrievalModelPanel.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './LocalRetrieval.module.css'

/**
 * 资料页顶部只呈现用途、份数与每份资料的状态；首次准备按加入意图就地完成。
 * 重建收进「更多」，整理进行中的「停止整理」就近可点；索引块数只在「详细信息」里。加入与移出仍按资料来源生效。
 */
export function LocalRetrievalResourcesPresentation({status,resource,busy,error,readFailed,t,onEnroll,onRemove,onReindex,onCancel,onModelSettings}:{status?:RetrievalStatus|undefined;resource?:WorkResource|undefined;busy:boolean;error:string;readFailed?:boolean;t:RetrievalTranslate;onEnroll:(sourceId:string)=>void;onRemove:(sourceId:string)=>void;onReindex:()=>void;onCancel:()=>void;onModelSettings?:()=>void}){
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
    {status&&!status.building&&<details className={css.more} data-retrieval-more><summary>{t('retrieval.resources.more')}</summary><div className={css.moreMenu}>{onModelSettings&&<ActionButton className={css.menuItem} disabled={busy||!!readFailed} onClick={(event?:{currentTarget:HTMLElement})=>{event?.currentTarget.closest('details')?.removeAttribute('open');onModelSettings()}}>{t('retrieval.resources.model')}</ActionButton>}<ActionButton className={css.menuItem} disabled={busy||status.enrolled===0||!!readFailed} onClick={(event?:{currentTarget:HTMLElement})=>{event?.currentTarget.closest('details')?.removeAttribute('open');onReindex()}}>{t(busy?'retrieval.resources.working':'retrieval.resources.rebuild')}</ActionButton></div></details>}
   </div>
  </header>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {(selectedRow||!!status?.items.length)&&<ul className={css.rows}>
   {selectedRow&&<li className={css.row} aria-current="true"><span className={css.rowText}>{selectedRow.title+' · '+selectedRow.label}{enrolled&&together(selectedRow.sourceId)}</span>{enrolled
    ?<ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title:selectedRow.title})} disabled={readOnly} onClick={()=>onRemove(selectedRow.sourceId)}>{t('retrieval.resources.remove')}</ActionButton>
    :<ActionButton className={css.button} aria-label={t('retrieval.resources.enrollAria',{title:selectedRow.title})} disabled={readOnly||resource?.status!=='active'} onClick={()=>onEnroll(selectedRow.sourceId)}>{t('retrieval.resources.enroll')}</ActionButton>}</li>}
   {status?.items.map(row=>{const title=row.title??t('retrieval.index.unavailable');return <li key={row.resourceId??row.sourceId} className={css.row} aria-current={resource&&row.resourceId===resource.id?'true':undefined}><span className={css.rowText}>{title+' · '+itemLabel(row.state)}{together(row.sourceId)}</span><ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title})} disabled={busy||!!readFailed} onClick={()=>onRemove(row.sourceId)}>{t('retrieval.resources.remove')}</ActionButton></li>})}
  </ul>}
  {status&&status.items.length>0&&<details className={css.info}><summary>{t('retrieval.resources.details')}</summary><ul>{status.items.map(row=><li key={row.resourceId??row.sourceId}>{row.title??t('retrieval.index.unavailable')} · {t('retrieval.index.'+row.state)}{row.chunkCount!==null&&` · ${t('retrieval.resources.chunks',{count:row.chunkCount})}`}</li>)}</ul><p>{t('retrieval.resources.totalChunks',{chunks:status.chunks})}</p></details>}
 </section>
}
export function LocalRetrievalResources({api,resource,visible,onExtensions}:{api:LocalRetrievalApi;resource?:WorkResource|undefined;visible:boolean;onExtensions?:(()=>void)|undefined}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(signal=>api.status(signal),api,visible)
 const [setup,setSetup]=useState<{catalogId:string;catalogVersion:string;profileHash:string;sourceId?:string}>(),[unavailable,setUnavailable]=useState(false)
 const openSettings=(providerId?:EmbeddingProviderId)=>void snapshot.run(async signal=>{const model=await api.modelStatus(signal,providerId);signal.throwIfAborted();if(!model.enabled||!model.provider){setUnavailable(true);throw new WorkError('teloa/dependency-unavailable','')}setUnavailable(false);setSetup({catalogId:model.provider.catalogId,catalogVersion:model.provider.catalogVersion,profileHash:model.provider.profileHash});return api.status(signal)})
 const enroll=(sourceId:string)=>void snapshot.run(async signal=>{
  const model=await api.modelStatus(signal)
  signal.throwIfAborted()
  if(!model.enabled||!model.provider){setUnavailable(true);throw new WorkError('teloa/dependency-unavailable','')}
  setUnavailable(false)
  if(['ready','standby'].includes(model.provider.preparation.phase))return api.enroll(sourceId,signal)
  setSetup({catalogId:model.provider.catalogId,catalogVersion:model.provider.catalogVersion,profileHash:model.provider.profileHash,sourceId})
  return api.status(signal)
 })
 // 一次续办只属于原资料；准备期间不能让另一个加入动作覆盖它。
 return <><LocalRetrievalResourcesPresentation status={snapshot.value} resource={resource} busy={snapshot.busy||!!setup?.sourceId} readFailed={snapshot.readFailed} error={snapshot.error?localizeWorkError(locale,snapshot.error):''} t={t as RetrievalTranslate} onModelSettings={()=>openSettings()} onEnroll={enroll} onRemove={id=>void snapshot.run(signal=>api.remove(id,signal))} onReindex={()=>void snapshot.run(signal=>api.reindex(signal))} onCancel={()=>void snapshot.run(signal=>api.cancel(signal))}/>
 {unavailable&&onExtensions&&<ActionButton className={css.button} onClick={onExtensions}>{t('retrieval.model.extensions')}</ActionButton>}
 {setup&&visible&&<><div className={css.settingsHeader}>{!setup.sourceId&&<label>{t('retrieval.resources.model')} <select value={embeddingProviderForCatalog(setup.catalogId)} disabled={snapshot.busy} onChange={event=>openSettings(event.target.value as EmbeddingProviderId)}><option value="qwen3-embedding-0.6b">Qwen3 Embedding 0.6B</option><option value="embeddinggemma-2">EmbeddingGemma 2</option></select></label>}</div><LocalRetrievalModelPanel key={setup.catalogId+':'+(setup.sourceId??'settings')} api={api} catalogId={setup.catalogId} catalogVersion={setup.catalogVersion} compact onBack={()=>setSetup(undefined)} onExtensions={()=>{setSetup(undefined);onExtensions?.()}} onReady={setup.sourceId?async signal=>{const current=await api.modelStatus(signal);if(current.provider?.catalogId!==setup.catalogId||current.provider.catalogVersion!==setup.catalogVersion||current.provider.profileHash!==setup.profileHash)throw new WorkError('teloa/conflict','');signal.throwIfAborted();await api.enroll(setup.sourceId!,signal);signal.throwIfAborted();setSetup(undefined)}:undefined}/></>}</>
}
