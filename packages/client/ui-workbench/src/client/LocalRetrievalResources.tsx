import {ActionButton} from '@teloa/client-ui-kit'
import {useEffect,useRef,useState} from 'react'
import type {RetrievalSearchResult,WorkResource} from '@teloa/contract'
import type {LocalRetrievalApi,RetrievalStatus} from './local-retrieval-api.js'
import type {RetrievalTranslate} from './LocalRetrievalModelPanel.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './LocalRetrieval.module.css'

/**
 * 资料页只呈现检索状态与资料操作；模型管理统一进入设置，不隐式准备或续办加入。
 * 重建收进「更多」，整理进行中的「停止整理」就近可点；索引块数只在「详细信息」里。加入与移出仍按资料来源生效。
 */
export function LocalRetrievalResourcesPresentation({status,resource,busy,error,readFailed,modelReady=true,modelLabel,t,onEnroll,onRemove,onReindex,onCancel,onModelSettings}:{status?:RetrievalStatus|undefined;resource?:WorkResource|undefined;busy:boolean;error:string;readFailed?:boolean;modelReady?:boolean;modelLabel?:string|undefined;t:RetrievalTranslate;onEnroll:(sourceId:string)=>void;onRemove:(sourceId:string)=>void;onReindex:()=>void;onCancel:()=>void;onModelSettings?:()=>void}){
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
   <div className={css.searchIntro}><strong>{t('retrieval.resources.title')}</strong><span role="status" className={css.count}>{modelLabel??(status?t('retrieval.resources.counts',{sources:status.enrolled}):t('retrieval.phase.checking'))}</span></div>
   <div className={css.searchTools}>
    {onModelSettings&&<ActionButton className={css.button} onClick={onModelSettings}>{t(modelReady?'retrieval.resources.localModels':'retrieval.resources.goEnable')}</ActionButton>}
    {status?.building&&<ActionButton className={css.button} disabled={busy} onClick={onCancel}>{t(busy?'retrieval.resources.working':'retrieval.resources.cancel')}</ActionButton>}
    {status&&status.enrolled>0&&!status.building&&<details className={css.more} data-retrieval-more><summary>{t('retrieval.resources.more')}</summary><div className={css.moreMenu}><ActionButton className={css.menuItem} disabled={busy||status.enrolled===0||!!readFailed} onClick={(event?:{currentTarget:HTMLElement})=>{event?.currentTarget.closest('details')?.removeAttribute('open');onReindex()}}>{t(busy?'retrieval.resources.working':'retrieval.resources.rebuild')}</ActionButton></div></details>}
   </div>
  </header>
  {error&&<p role="alert" className={css.error}>{error}</p>}

  {(selectedRow||!!status?.items.length)&&<details open={!!status?.building||!!selectedRow||status?.items.some(row=>row.state!=='ready')}><summary>{t('retrieval.resources.statusList')}</summary><ul className={css.rows}>
   {selectedRow&&<li className={css.row} aria-current="true"><span className={css.rowText}>{selectedRow.title+' · '+selectedRow.label}{enrolled&&together(selectedRow.sourceId)}</span>{enrolled
    ?<ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title:selectedRow.title})} disabled={readOnly} onClick={()=>onRemove(selectedRow.sourceId)}>{t('retrieval.resources.remove')}</ActionButton>
    :<ActionButton className={css.button} aria-label={t('retrieval.resources.enrollAria',{title:selectedRow.title})} disabled={readOnly||!modelReady||resource?.status!=='active'} onClick={()=>onEnroll(selectedRow.sourceId)}>{t('retrieval.resources.enroll')}</ActionButton>}</li>}
   {status?.items.map(row=>{const title=row.title??t('retrieval.index.unavailable');return <li key={row.resourceId??row.sourceId} className={css.row} aria-current={resource&&row.resourceId===resource.id?'true':undefined}><span className={css.rowText}>{title+' · '+itemLabel(row.state)}{together(row.sourceId)}</span><ActionButton className={css.button} aria-label={t('retrieval.resources.removeAria',{title})} disabled={busy||!!readFailed} onClick={()=>onRemove(row.sourceId)}>{t('retrieval.resources.remove')}</ActionButton></li>})}
  </ul></details>}
  {status&&status.items.length>0&&<details className={css.info}><summary>{t('retrieval.resources.details')}</summary><ul>{status.items.map(row=><li key={row.resourceId??row.sourceId}>{row.title??t('retrieval.index.unavailable')} · {t('retrieval.index.'+row.state)}{row.chunkCount!==null&&` · ${t('retrieval.resources.chunks',{count:row.chunkCount})}`}</li>)}</ul><p>{t('retrieval.resources.totalChunks',{chunks:status.chunks})}</p></details>}
 </section>
}
export function LocalRetrievalResources({api,resource,visible,onModelSettings}:{api:LocalRetrievalApi;resource?:WorkResource|undefined;visible:boolean;onModelSettings?:()=>void}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(async signal=>{const [index,model]=await Promise.all([api.status(signal),api.modelStatus(signal)]);return {index,model}},api,visible)
 const model=snapshot.value?.model,ready=!!model?.enabled&&!!model.provider&&['ready','standby'].includes(model.provider.preparation.phase)
 const modelLabel=model?(!model.enabled?t('retrieval.resources.disabled'):ready?t('retrieval.resources.counts',{sources:snapshot.value!.index.enrolled}):t('retrieval.phase.'+(model.provider?.preparation.phase??'unprepared'))):t('retrieval.phase.checking')
 const run=(action:(signal:AbortSignal)=>Promise<RetrievalStatus>)=>void snapshot.run(async signal=>({index:await action(signal),model:await api.modelStatus(signal)}))
 const enroll=(sourceId:string)=>run(async signal=>{
  const latest=await api.modelStatus(signal);signal.throwIfAborted()
  if(!latest.enabled||!latest.provider||!['ready','standby'].includes(latest.provider.preparation.phase)){onModelSettings?.();return api.status(signal)}
  return api.enroll(sourceId,signal)
 })
 return <><LocalRetrievalResourcesPresentation status={snapshot.value?.index} resource={resource} busy={snapshot.busy} readFailed={snapshot.readFailed} modelReady={ready} modelLabel={modelLabel} error={snapshot.error?localizeWorkError(locale,snapshot.error):''} t={t as RetrievalTranslate} {...(onModelSettings?{onModelSettings}:{})} onEnroll={enroll} onRemove={id=>run(signal=>api.remove(id,signal))} onReindex={()=>run(signal=>api.reindex(signal))} onCancel={()=>run(signal=>api.cancel(signal))}/>{ready&&<RetrievalTrial api={api}/>}</>
}

/** 命中原片段由同一检索权限和版本校验返回；查询取消不取消后台索引。 */
function RetrievalTrial({api}:{api:LocalRetrievalApi}){
 const {locale,t}=useI18n(),[query,setQuery]=useState(''),[result,setResult]=useState<RetrievalSearchResult>(),[busy,setBusy]=useState(false),[error,setError]=useState(''),active=useRef<AbortController>()
 useEffect(()=>{setResult(undefined);setError('');setBusy(false);return()=>active.current?.abort()},[api])
 const search=async()=>{
  if(busy||!query.trim())return
  const controller=new AbortController();active.current=controller;setBusy(true);setError('');setResult(undefined)
  try{const next=await api.search(query.trim(),controller.signal);if(!controller.signal.aborted)setResult(next)}catch(cause){if(!controller.signal.aborted)setError(localizeWorkError(locale,cause))}finally{if(active.current===controller&&!controller.signal.aborted){setBusy(false);active.current=undefined}}
 }
 return <details className={css.panel}><summary>{t('retrieval.trial.title')}</summary><p>{t('retrieval.trial.boundary')}</p><form className={css.trialForm} onSubmit={event=>{event.preventDefault();void search()}}><label>{t('retrieval.trial.query')}<input value={query} maxLength={500} disabled={busy} onChange={event=>{setQuery(event.target.value);setResult(undefined);setError('')}}/></label><ActionButton className={css.button} type="submit" disabled={busy||!query.trim()}>{t(busy?'retrieval.trial.searching':'retrieval.trial.search')}</ActionButton></form>{error&&<p role="alert">{error}</p>}{result&&<div role="status"><p>{t('retrieval.trial.coverage',{searched:result.coverage.searched.length,pending:result.coverage.pending.length})}</p>{!result.results.length&&<p>{t('retrieval.trial.empty')}</p>}{result.results.map((hit,index)=><article key={index}><h4>{hit.title} · v{hit.resourceVersion}</h4><small>{t('retrieval.trial.lines',{start:hit.lines[0]+1,end:hit.lines[1]+1})}{hit.heading?' · '+hit.heading:''}</small><pre className={css.excerpt}>{hit.excerpt}</pre></article>)}</div>}</details>
}
