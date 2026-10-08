import {useCallback,useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {Download,HardDrive,RefreshCw,ExternalLink} from 'lucide-react'
import {OLLAMA_MIN_VERSION,readOllamaAddress,type LocalModelsOverview,type LocalModelRow,type LocalModelStatus,type PullJobView} from '@teloa/contract'
import type {LocalModelsApi,LocalModelsFocus} from './local-models-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {catalogText} from './market-catalog-api.js'
import {subscribeSettingsPanelVisible} from './AutoDreamSettingsPage.js'
import css from './LocalModelsSettings.module.css'

const active=(job:PullJobView|null|undefined)=>job?.phase==='pulling'||job?.phase==='verifying'
export const fitLabelKey=(fit:LocalModelRow['fit'])=>`localModels.fit.${fit}` as const
const statusKeys={
 'runtime-missing':'localModels.runtime.missing','not-pulled':'localModels.status.notPulled',pulling:'localModels.status.pulling',verifying:'localModels.status.verifying',ready:'localModels.status.ready',unverified:'localModels.status.unverified','route-pending':'localModels.status.routePending',missing:'localModels.status.missing',attached:'localModels.status.attached',
} as const
export const statusLabelKey=(status:LocalModelStatus)=>statusKeys[status]
export {formatBytes} from './local-models-api.js'
import {formatBytes} from './local-models-api.js'
type Confirmation={kind:'pull';row:LocalModelRow;overview:LocalModelsOverview}|{kind:'attach'|'remove';name:string;overview:LocalModelsOverview}
const noSubscribe=()=>()=>{},noFocus=()=>undefined
export function LocalModelsSettings({api,focus}:{api:LocalModelsApi;focus?:LocalModelsFocus}){
 const {locale,t}=useI18n(),target=useSyncExternalStore(focus?.subscribe??noSubscribe,focus?.getSnapshot??noFocus,noFocus)
 const [overview,setOverview]=useState<LocalModelsOverview>(),[error,setError]=useState<string>(),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[visible,setVisible]=useState(true)
 const [confirmation,setConfirmation]=useState<Confirmation>(),[acknowledged,setAcknowledged]=useState(false)
 const mounted=useRef(false),generation=useRef(0),locked=useRef(false),returnFocus=useRef<HTMLElement|null>(null)
 const refresh=useCallback(async()=>{
  const token=++generation.current;setLoading(true)
  try{const value=await api.overview();if(mounted.current&&token===generation.current){setOverview(value);setError(undefined)}}
  catch(cause){if(mounted.current&&token===generation.current)setError(localizeWorkError(locale,cause))}
  finally{if(mounted.current&&token===generation.current)setLoading(false)}
 },[api,locale])
 useEffect(()=>{mounted.current=true;void refresh();const off=subscribeSettingsPanelVisible(next=>{setVisible(next);if(next)void refresh()});return()=>{mounted.current=false;generation.current++;off()}},[refresh])
 // 单次请求完成后才排下一次；切走、取消或终态立即清理，不产生重叠轮询。
 const running=active(overview?.pull),pullId=overview?.pull?.pullId
 useEffect(()=>{
  if(!running||!visible)return
  let stopped=false,timer:ReturnType<typeof setTimeout>
  const poll=async()=>{
   const token=generation.current
   try{
    const job=await api.pullStatus()
    if(stopped)return
    if(token!==generation.current){timer=setTimeout(()=>void poll(),1000);return}
    setOverview(current=>current?{...current,pull:job}:current)
    if(!active(job)){await refresh();return}
   }catch(cause){if(!stopped)setError(localizeWorkError(locale,cause))}
   if(!stopped)timer=setTimeout(()=>void poll(),1000)
  }
  timer=setTimeout(()=>void poll(),1000)
  return()=>{stopped=true;clearTimeout(timer)}
 },[api,running,pullId,visible,locale,refresh])
 const mutate=async(operation:()=>Promise<void>)=>{
  if(locked.current)return
  locked.current=true;generation.current++;setBusy(true);setError(undefined)
  try{await operation()}catch(cause){if(mounted.current)setError(localizeWorkError(locale,cause))}
  finally{locked.current=false;if(mounted.current)setBusy(false)}
 }
 const ask=(next:Confirmation)=>{returnFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setAcknowledged(false);setConfirmation(next)}
 const close=()=>{setConfirmation(undefined);returnFocus.current?.focus()}
 const confirm=()=>void mutate(async()=>{
  if(!confirmation)return
  const expectedAddress=confirmation.overview.runtime.address.baseURL
  if(confirmation.kind==='pull'){
   if(confirmation.row.licenseTier==='restricted'&&!acknowledged)return
   const row=confirmation.row,pull=await api.pull({entryId:row.entryId,version:row.version,variant:row.variant,acknowledgeRestrictions:acknowledged,expectedAddress})
   if(mounted.current)setOverview(current=>current?{...current,pull}:current)
  }else{
   const next=await api[confirmation.kind](confirmation.name,expectedAddress)
   if(mounted.current)setOverview(next)
  }
  if(mounted.current)close()
 })
 return <LocalModelsView overview={overview} error={error} busy={busy} loading={loading} confirmation={confirmation} acknowledged={acknowledged} focus={target} onRefresh={()=>void refresh()} onAsk={ask} onClose={close} onAcknowledge={setAcknowledged} onConfirm={confirm} onCancelPull={name=>void mutate(async()=>{const pull=await api.pullCancel(name);if(mounted.current)setOverview(current=>current?{...current,pull}:current);await refresh()})} onAddress={value=>void mutate(async()=>{if(value!==null){try{readOllamaAddress(value)}catch{throw Error(t('localModels.address.invalid'))}}const next=await api.address(value);if(mounted.current){setOverview(next);setConfirmation(undefined)}})}/>
}

export type LocalModelsViewProps={overview:LocalModelsOverview|undefined;error:string|undefined;busy:boolean;loading:boolean;confirmation:Confirmation|undefined;acknowledged:boolean;focus:{entryId:string;serial:number}|undefined;onRefresh:()=>void;onAsk:(value:Confirmation)=>void;onClose:()=>void;onAcknowledge:(value:boolean)=>void;onConfirm:()=>void;onCancelPull:(name:string)=>void;onAddress:(value:string|null)=>void}
export function LocalModelsView({overview,error,busy,loading,confirmation,acknowledged,focus,onRefresh,onAsk,onClose,onAcknowledge,onConfirm,onCancelPull,onAddress}:LocalModelsViewProps){
 const {locale,t}=useI18n(),root=useRef<HTMLElement>(null),confirmRef=useRef<HTMLElement>(null)
 const [address,setAddress]=useState('')
 useEffect(()=>{if(overview)setAddress(overview.runtime.address.baseURL)},[overview?.runtime.address.baseURL])
 useEffect(()=>{if(!overview||!focus)return;const row=[...root.current!.querySelectorAll<HTMLElement>('[data-entry-id]')].find(item=>item.dataset.entryId===focus.entryId);row?.focus();row?.scrollIntoView?.({block:'nearest'})},[focus,!!overview])
 useEffect(()=>{if(confirmation){confirmRef.current?.focus();confirmRef.current?.scrollIntoView?.({block:'nearest'})}},[confirmation])
 const pull=overview?.pull,inProgress=active(pull),operable=overview?.runtime.state==='running'&&!overview.runtime.outdated
 const percent=pull?.total?Math.min(100,Math.floor(pull.completed/pull.total*100)):null
 const memoryFit=(row:LocalModelRow)=>row.memoryEstimate?t(row.memoryEstimate.contextSupported?'localModels.memoryFit.'+row.memoryEstimate.fit:'localModels.contextUnsupported'):t(fitLabelKey(row.fit))
 const estimate=(row:LocalModelRow)=>overview?.runtime.address.local&&row.memoryEstimate?<p>{t('localModels.memoryEstimate',{context:new Intl.NumberFormat(locale).format(row.memoryEstimate.contextTokens),size:formatBytes(row.memoryEstimate.requiredMemoryBytes)})}</p>:null
 const context=(row:{loaded:boolean;runtimeContextLength?:number|null})=>row.loaded?<p>{row.runtimeContextLength?t('localModels.context.allocated',{tokens:new Intl.NumberFormat(locale).format(row.runtimeContextLength)}):t('localModels.context.unknown')}</p>:null
 const groups=new Map<string,LocalModelRow[]>()
 for(const row of overview?.rows??[])groups.set(row.entryId,[...(groups.get(row.entryId)??[]),row])
 const rowActions=(row:LocalModelRow)=>{
  if(!overview||!operable)return null
  if(inProgress&&pull?.name===row.name)return null
  if(row.status==='ready'||row.status==='attached')return <button type="button" disabled={busy||inProgress} onClick={()=>onAsk({kind:'remove',name:row.name,overview})}>{t('localModels.action.remove')}</button>
  if(row.status==='unverified')return <button type="button" disabled={busy||inProgress} onClick={()=>onAsk({kind:'attach',name:row.name,overview})}>{t('localModels.action.attach')}</button>
  return <button type="button" disabled={busy||inProgress} onClick={()=>onAsk({kind:'pull',row,overview})}><Download size={14} aria-hidden="true"/>{t(row.status==='route-pending'?'localModels.action.retry':'localModels.action.pull')}</button>
 }
 return <section className={css.page} ref={root} aria-label={t('localModels.title')}>
  <header className={css.header}><h2>{t('localModels.title')}</h2><button type="button" disabled={busy||loading} onClick={onRefresh}><RefreshCw size={14} aria-hidden="true"/>{t('collaboration.action.refresh')}</button></header>
  {error&&<p className={css.error} role="alert">{error}</p>}
  {!overview&&loading&&<p role="status">{t('localModels.loading')}</p>}
  {overview&&<>
   <div className={css.runtime}><HardDrive size={20} aria-hidden="true"/><div><strong>{overview.runtime.state==='running'?t('localModels.runtime.running',{version:overview.runtime.version??'—'}):t('localModels.runtime.missing')}</strong>
    {overview.runtime.state==='missing'&&<a href="https://ollama.com/download" target="_blank" rel="noreferrer">{t('localModels.install')} <ExternalLink size={12} aria-hidden="true"/></a>}
    {overview.runtime.outdated&&<p className={css.error}>{t('localModels.runtime.outdated',{min:OLLAMA_MIN_VERSION})}</p>}
    <p>{overview.runtime.address.local?t('localModels.hardware',{ram:overview.hardware.totalMemGb,unified:overview.hardware.unified?t('localModels.hardware.unified'):'',disk:formatBytes(overview.hardware.diskFreeBytes)}):t('localModels.runtime.external',{host:overview.runtime.address.baseURL})}</p>
   </div></div>
   <details className={css.address}><summary>{t('localModels.address.label')}</summary><form onSubmit={event=>{event.preventDefault();onAddress(address)}}><label>{t('localModels.target')}<input type="url" value={address} disabled={busy||inProgress} onChange={event=>setAddress(event.target.value)} spellCheck={false} autoComplete="off" required/></label><div className={css.actions}><button type="submit" disabled={busy||inProgress||address===overview.runtime.address.baseURL}>{t('localModels.save')}</button>{overview.runtime.address.custom&&<button type="button" disabled={busy||inProgress} onClick={()=>onAddress(null)}>{t('localModels.resetAddress')}</button>}</div></form></details>
   {pull&&<div className={css.progress} aria-label={t('localModels.downloadProgress')}><div className={css.rowHeader}><strong>{pull.name}</strong><span role="status">{t(pull.phase==='pulling'?(percent===null?'localModels.downloading':'localModels.status.pulling'):pull.phase==='verifying'?'localModels.status.verifying':pull.phase==='done'?'localModels.downloaded':pull.phase==='cancelled'?'localModels.cancelled':'localModels.failed',{percent:percent??0})}</span></div>{inProgress&&<><progress aria-label={t('localModels.downloadProgress')} max={100} {...(percent===null?{}:{value:percent})}/><div className={css.rowHeader}><small>{formatBytes(pull.completed)}{pull.total!==null?' / '+formatBytes(pull.total):''}</small><button type="button" disabled={busy} onClick={()=>onCancelPull(pull.name)}>{t('localModels.action.cancel')}</button></div></>}{pull.error&&<p className={css.error} role="alert">{pull.error}</p>}</div>}
   {confirmation&&<section className={css.confirm} tabIndex={-1} ref={confirmRef} aria-label={t('localModels.confirmation')} onKeyDown={event=>{if(event.key==='Escape'&&!busy){event.stopPropagation();onClose()}}}>
    {confirmation.kind==='pull'?<>
     <h3>{t('localModels.confirm.title',{name:confirmation.row.name})}</h3>
     <dl><dt>{t('localModels.target')}</dt><dd>{confirmation.overview.runtime.address.baseURL}</dd><dt>{t('localModels.size')}</dt><dd>{formatBytes(confirmation.row.sizeBytes)} · {confirmation.row.quant}</dd><dt>{t('localModels.disk')}</dt><dd>{formatBytes(confirmation.overview.hardware.diskFreeBytes)}</dd><dt>{t('localModels.fit')}</dt><dd>{confirmation.overview.runtime.address.local?memoryFit(confirmation.row):t('localModels.hardware.diskUnknown')}</dd><dt>{t('localModels.license')}</dt><dd><a href={confirmation.row.licenseURL} target="_blank" rel="noreferrer">{confirmation.row.licenseName}</a> · {t(confirmation.row.licenseTier==='commercial'?'market.catalog.official.modelTierCommercial':'market.catalog.official.modelTierRestricted')}</dd></dl>{estimate(confirmation.row)}
     {confirmation.row.restrictions.map((text,i)=><p key={i}>{catalogText(text,locale)}</p>)}
     <details><summary>{t('localModels.digest')}</summary><code>{confirmation.row.catalogDigest??t('localModels.confirm.digestNone')}</code></details>
     {confirmation.row.licenseTier==='restricted'&&<label className={css.checkbox}><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event=>onAcknowledge(event.target.checked)}/>{t('localModels.confirm.acknowledge')}</label>}
    </>:<><h3>{t(confirmation.kind==='attach'?'localModels.confirm.attach':'localModels.confirm.remove',{name:confirmation.name})}</h3><p>{t('localModels.target')} · {confirmation.overview.runtime.address.baseURL}</p>{confirmation.kind==='remove'&&<p>{t('localModels.confirm.removeRoute')}</p>}</>}
    {confirmation.kind!=='remove'&&<p>{t('localModels.confirm.load')}</p>}
    <div className={css.actions}><button className={css.primary} type="button" disabled={busy||(confirmation.kind==='pull'&&confirmation.row.licenseTier==='restricted'&&!acknowledged)} onClick={onConfirm}>{busy?t('localModels.working'):t(confirmation.kind==='pull'?'localModels.confirm.pull':confirmation.kind==='attach'?'localModels.action.attach':'localModels.action.remove')}</button><button type="button" disabled={busy} onClick={onClose}>{t('market.common.cancel')}</button></div>
   </section>}
   <div className={css.models}>{[...groups].map(([id,rows])=><section key={id} data-entry-id={id} tabIndex={-1} className={css.model}><h3>{catalogText(rows[0]!.title,locale)}</h3>{rows.map(row=><div className={css.modelRow} key={row.variant} data-model-name={row.name}><div><strong>{row.name}</strong><p>{row.quant} · {formatBytes(row.sizeBytes)}{overview.runtime.address.local?' · '+memoryFit(row):''}</p>{row.status!=='runtime-missing'&&<span className={css.status}>{t(statusLabelKey(row.status),{percent:percent??0})}{row.loaded?' · '+t('localModels.loaded'):''}</span>}{estimate(row)}{context(row)}</div><div className={css.actions}>{rowActions(row)}</div></div>)}</section>)}</div>
   {overview.offCatalog.length>0&&<section className={css.model}><h3>{t('localModels.offCatalog.title')}</h3>{overview.offCatalog.map(row=><div className={css.modelRow} key={row.name}><div><strong>{row.name}</strong><p>{formatBytes(row.sizeBytes)}{row.parameterSize?' · '+row.parameterSize:''}{row.loaded?' · '+t('localModels.loaded'):''}</p>{row.status==='attached'&&<span className={css.status}>{t('localModels.status.attached')}</span>}{context(row)}</div><div className={css.actions}><button type="button" disabled={busy||inProgress||!operable} onClick={()=>onAsk({kind:row.status==='attached'?'remove':'attach',name:row.name,overview})}>{t(row.status==='attached'?'localModels.action.remove':'localModels.action.attach')}</button></div></div>)}</section>}
  </>}
 </section>
}
