import {useEffect,useRef,useState} from 'react'
import {ActionButton} from '@teloa/client-ui-kit'
import type {EmbeddingDownloadSource,RetrievalPreparationDetails,RetrievalPreparationExpected} from '@teloa/contract'
import {WorkError,captureRetrievalPreparation,sameRetrievalPreparation} from '@teloa/contract'
import type {LocalRetrievalApi,RetrievalModelStatus} from './local-retrieval-api.js'
import {useRetrievalSnapshot} from './use-retrieval-snapshot.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './LocalRetrieval.module.css'

export type RetrievalTranslate=(key:string,params?:Record<string,string|number>)=>string
export const retrievalBytes=(bytes:number)=>bytes>=1024**3?`${(bytes/1024**3).toFixed(1)} GiB`:`${(bytes/1024**2).toFixed(1)} MiB`
export const preparationBusy=(phase:string)=>['checking','downloading','loading','cancelling'].includes(phase)
/** 确认仅适用于当前固定工件；等待重读期间取消/离开不能再提交准备。 */
export async function prepareConfirmedModel(api:LocalRetrievalApi,confirmation:RetrievalPreparationExpected|undefined,target:{catalogId:string;catalogVersion:string},signal:AbortSignal,source?:EmbeddingDownloadSource){
 if(!confirmation)throw new WorkError('teloa/conflict','')
 const latest=await api.modelStatus(signal),p=latest.provider
 signal.throwIfAborted()
 if(!p||!p.preparationDetails||!sameRetrievalPreparation(captureRetrievalPreparation(p),confirmation)||p.catalogId!==target.catalogId||p.catalogVersion!==target.catalogVersion||p.variant!=='fp32'||preparationBusy(p.preparation.phase))throw new WorkError('teloa/conflict','')
 return api.prepare(confirmation,signal,source)
}
/** 下载来源单选：来源表来自固定清单；选择只用于本次准备，不保存。准备进行中或状态读取失败时禁用。 */
function RetrievalSourceChoice({details,source,disabled,onSource,t}:{details:RetrievalPreparationDetails;source:EmbeddingDownloadSource;disabled:boolean;onSource:(source:EmbeddingDownloadSource)=>void;t:RetrievalTranslate}){
 const sources=details.downloadSources??[]
 if(sources.length<2)return null
 const mirror=source==='official'?undefined:sources.find(row=>row.id===source)
 return <fieldset className={css.sources}><legend>{t('retrieval.confirm.source')}</legend>{sources.map(row=><p key={row.id}><label><input type="radio" name="retrieval-download-source" value={row.id} checked={source===row.id} disabled={disabled} onChange={()=>onSource(row.id)}/><span>{row.id==='official'?t('retrieval.confirm.sourceOfficial'):t('retrieval.confirm.sourceMirror',{host:row.host})}</span></label></p>)}{mirror&&<p>{t('retrieval.confirm.sourceMirrorNote',{host:mirror.host})}</p>}</fieldset>
}
export function RetrievalDownloadDetails({details:d,variant,t}:{details:RetrievalPreparationDetails;variant:string;t:RetrievalTranslate}){
 const assets=d.files.reduce((n,f)=>n+f.bytes,0),weights=d.files.filter(f=>!f.shared).reduce((n,f)=>n+f.bytes,0)
 const exactBytes=(bytes:number)=>`${retrievalBytes(bytes)} (${bytes.toLocaleString('en-US')} B)`
 return <div className={css.details}>
  <p>{t('retrieval.confirm.network')}</p><p>{t('retrieval.confirm.cancel')}</p>
  <dl><dt>{t('retrieval.confirm.runtime')}</dt><dd>{d.runtime.package}@{d.runtime.version} · {d.runtime.source}<br/>{t('retrieval.confirm.unpacked',{size:retrievalBytes(d.runtime.unpackedBytesEstimate)})}</dd>
   <dt>{t('retrieval.confirm.assets')}</dt><dd>{d.modelName} · {variant.toUpperCase()} · {[...new Set(d.files.map(f=>f.source))].join(', ')}<br/>{t('retrieval.confirm.sizes',{weights:exactBytes(weights),tokenizer:exactBytes(assets-weights),total:exactBytes(assets)})}</dd>
   <dt>{t('retrieval.confirm.license')}</dt><dd>{d.license} · {d.upstreamRepo}<br/>{t('retrieval.confirm.community',{repo:d.conversionRepo})}</dd>
   <dt>{t('retrieval.confirm.capacity')}</dt><dd>{t('retrieval.confirm.disk',{size:retrievalBytes(assets+d.runtime.unpackedBytesEstimate+d.reserveBytes),reserve:retrievalBytes(d.reserveBytes)})}<br/>{t('retrieval.confirm.memory',{min:retrievalBytes(d.memoryBytesEstimate[0]),max:retrievalBytes(d.memoryBytesEstimate[1])})}</dd>
   <dt>{t('retrieval.confirm.paths')}</dt><dd><code>{d.modelDirectory}</code><br/><code>{d.runtimeDirectory}</code></dd></dl>
  <details><summary>{t('retrieval.confirm.files')}</summary><ul>{d.files.map(f=><li key={f.path}><code>{f.path}</code> · {f.source} · {f.bytes.toLocaleString('en-US')} B<br/><code title={f.sha256}>SHA-256 {f.sha256.slice(0,12)}…</code></li>)}</ul><p><code>{d.runtime.integrity}</code></p></details>
 </div>
}
export type RetrievalModelPresentationProps={status?:RetrievalModelStatus|undefined;catalogId:string;catalogVersion:string;confirming:boolean;busy:boolean;error:string;readFailed?:boolean;source?:EmbeddingDownloadSource;onSource?:(source:EmbeddingDownloadSource)=>void;t:RetrievalTranslate;onAsk:()=>void;onConfirm:()=>void;onDismiss:()=>void;onCancel:()=>void;onBack:()=>void;onExtensions:()=>void}
export function LocalRetrievalModelPresentation(p:RetrievalModelPresentationProps){
 const confirmationHeading=useRef<HTMLHeadingElement>(null),wasConfirming=useRef(false)
 useEffect(()=>{if(p.confirming&&!wasConfirming.current)confirmationHeading.current?.focus();wasConfirming.current=p.confirming},[p.confirming])
 const {status,t}=p,provider=status?.provider,state=provider?.preparation
 const matches=provider?.catalogId===p.catalogId&&provider.catalogVersion===p.catalogVersion
 const canPrepare=!!matches&&provider?.variant==='fp32'&&!!provider.preparationDetails
 const active=!!state&&preparationBusy(state.phase)
 // 镜像来源的文件校验不符：提示改用官方来源，而不是只说重新准备。
 const mirrorIntegrity=state?.phase==='failed'&&state.download?.reason==='integrity'&&!!provider?.preparationDetails?.downloadSources?.some(row=>row.id!=='official'&&row.host===state.download?.source)
 return <section className={`${css.panel} ${css.model}`} aria-label={t('retrieval.model.title')} data-retrieval-model>
  <ActionButton className={css.button} onClick={p.onBack}>{t('knowledge.manager.back')}</ActionButton>
  <h2>{t('retrieval.model.title')}</h2><p>{t('retrieval.model.summary')}</p>
  {p.error&&<p role="alert" className={css.error}>{p.error}</p>}
  {!status?<p role="status">{t('retrieval.phase.checking')}</p>:!status.enabled||!provider?<><p>{t('retrieval.model.disabled')}</p><ActionButton className={css.button} onClick={p.onExtensions}>{t('retrieval.model.extensions')}</ActionButton></>:<>
   <p role="status">{t('retrieval.phase.'+state!.phase)}{provider.memoryRisk&&<span className={css.warning}> · {t('retrieval.model.memoryRisk')}</span>}</p>
   {state?.phase==='downloading'&&<div className={css.progress}><strong>{t('retrieval.stage.'+state.stage)}</strong><span>{state.resource}</span><progress aria-label={t('retrieval.stage.'+state.stage)} {...(state.totalBytes&&state.totalBytes>0?{value:state.completedBytes,max:state.totalBytes}:{})}/><span>{state.completedBytes.toLocaleString()} B{state.totalBytes?` / ${state.totalBytes.toLocaleString()} B`:''}</span></div>}
   {state?.phase==='failed'&&<p role="alert" className={css.error}>{state.download?<>{state.download.resource} · {state.download.source} · {mirrorIntegrity?t('retrieval.failure.mirrorIntegrity'):t('retrieval.failure.'+state.download.reason)}</>:t('retrieval.failure.unknown')}</p>}
   {!canPrepare&&<p role="alert">{t('retrieval.model.mismatch')}</p>}
   {active?<ActionButton className={css.button} disabled={p.busy||state?.phase==='cancelling'} onClick={p.onCancel}>{t(p.busy?'retrieval.phase.cancelling':'retrieval.model.cancel')}</ActionButton>:!p.confirming&&state?.phase!=='ready'&&state?.phase!=='standby'&&<ActionButton className={css.primary} disabled={!canPrepare||p.busy||p.readFailed} onClick={p.onAsk}>{t('retrieval.model.prepare')}</ActionButton>}
   {(state?.phase==='ready'||state?.phase==='standby')&&<p>{t('retrieval.model.readyHint')}</p>}
   {p.confirming&&canPrepare&&!active&&<section className={css.confirm} aria-label={t('retrieval.confirm.title')}><h3 ref={confirmationHeading} tabIndex={-1}>{t('retrieval.confirm.title')}</h3><RetrievalDownloadDetails details={provider.preparationDetails!} variant={provider.variant} t={t}/><RetrievalSourceChoice details={provider.preparationDetails!} source={p.source??'official'} disabled={p.busy||!!p.readFailed} onSource={source=>p.onSource?.(source)} t={t}/><div className={css.actions}><ActionButton className={css.primary} disabled={p.busy||p.readFailed} onClick={p.onConfirm}>{t('retrieval.confirm.accept')}</ActionButton><ActionButton className={css.button} disabled={p.busy} onClick={p.onDismiss}>{t('market.industry.prepare.cancel')}</ActionButton></div></section>}
  </>}
 </section>
}
export function LocalRetrievalModelPanel({api,catalogId,catalogVersion,onBack,onExtensions}:{api:LocalRetrievalApi;catalogId:string;catalogVersion:string;onBack:()=>void;onExtensions:()=>void}){
 const {locale,t}=useI18n(),snapshot=useRetrievalSnapshot(signal=>api.modelStatus(signal),api)
 const [confirmation,setConfirmation]=useState<RetrievalPreparationExpected>()
 const [source,setSource]=useState<EmbeddingDownloadSource>('official')
 const confirm=()=>void snapshot.run(async signal=>{
  const accepted=confirmation;setConfirmation(undefined)
  return prepareConfirmedModel(api,accepted,{catalogId,catalogVersion},signal,source==='official'?undefined:source)
 })
 return <LocalRetrievalModelPresentation status={snapshot.value} catalogId={catalogId} catalogVersion={catalogVersion} confirming={!!confirmation} busy={snapshot.busy} readFailed={snapshot.readFailed} source={source} onSource={setSource} error={snapshot.error?localizeWorkError(locale,snapshot.error):''} t={t as RetrievalTranslate} onAsk={()=>{if(snapshot.value?.provider){setSource('official');setConfirmation(captureRetrievalPreparation(snapshot.value.provider))}}} onConfirm={confirm} onDismiss={()=>setConfirmation(undefined)} onCancel={()=>void snapshot.run(signal=>api.cancelPreparation(signal))} onBack={onBack} onExtensions={onExtensions}/>
}
