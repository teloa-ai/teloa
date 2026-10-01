import {useCallback,useEffect,useState} from 'react'
import clsx from 'clsx'
import type {BundledExtensionId,BundledExtensionState,BundledExtensionView} from '@teloa/contract'
import type {BundledExtensionsApi} from './bundled-extensions-api.js'
import {useI18n} from './i18n/provider.js'
import css from './ImChannelsSettingsPage.module.css'

type Confirming={id:BundledExtensionId;enabled:boolean}
/**
 * 启停失败按错误码与原因给固定文案：即时启停前后的安全检查不过（reason safety-check）、扩展加载或卸下失败（load-failed）；
 * 其余 forbidden 即尚未登记或来源不符（宿主 bundledSourceMismatch）。
 */
export function bundledSetErrorKey(cause:unknown):string{
 const code=cause&&typeof cause==='object'&&'code' in cause?String(cause.code):''
 const details=cause&&typeof cause==='object'&&'details' in cause&&cause.details&&typeof cause.details==='object'?cause.details as {reason?:unknown}:undefined
 if(details?.reason==='safety-check')return 'bundledExtensions.error.safetyCheck'
 if(details?.reason==='load-failed')return 'bundledExtensions.error.loadFailed'
 return code==='teloa/forbidden'?'bundledExtensions.error.unregistered':code==='teloa/storage-unavailable'?'bundledExtensions.error.storage':'bundledExtensions.error.generic'
}
const stateKey:Record<BundledExtensionState,string>={'available':'bundledExtensions.state.available','enable-pending':'bundledExtensions.state.enablePending','active':'bundledExtensions.state.active','failed':'bundledExtensions.state.failed','disable-pending':'bundledExtensions.state.disablePending'}
const enabledNow=(state:BundledExtensionState)=>state==='active'||state==='enable-pending'||state==='failed'
/** 每个随附扩展自己的名称、简介与启停确认文案；渠道数只对 IM 通道有意义。 */
const extensionText:Record<BundledExtensionId,{name:string;summary:string;enable:string;disable:string}>={
 'im-gateway':{name:'bundledExtensions.im.name',summary:'bundledExtensions.im.summary',enable:'bundledExtensions.confirm.enable',disable:'bundledExtensions.confirm.disable'},
 'local-embedding':{name:'bundledExtensions.localEmbedding.name',summary:'bundledExtensions.localEmbedding.summary',enable:'bundledExtensions.localEmbedding.confirm.enable',disable:'bundledExtensions.localEmbedding.confirm.disable'},
}
export type BundledExtensionsViewProps={rows:readonly BundledExtensionView[];busy:boolean;error:string|undefined;confirming:Confirming|undefined;onAsk:(next:Confirming)=>void;onConfirm:()=>void;onCancel:()=>void;onRetry:()=>void}

export function BundledExtensionsView(props:BundledExtensionsViewProps){
 const {t}=useI18n()
 return <section className={css.section} aria-label={t('bundledExtensions.title')}>
  <h2 className={css.title}>{t('bundledExtensions.title')}</h2>
  <p className={css.muted}>{t('bundledExtensions.description')}</p>
  {props.error&&<p className={css.alert} role="alert">{props.error} <button type="button" className={css.button} onClick={props.onRetry}>{t('bundledExtensions.retry')}</button></p>}
  <ul className={css.list}>{props.rows.map(row=>{
   const on=enabledNow(row.state),asking=props.confirming?.id===row.id,text=extensionText[row.id]
   return <li key={row.id} className={css.row}>
    <span className={css.rowText}><strong>{t(text.name as never)}</strong><span className={css.muted}>{t(text.summary as never)}</span>{row.memoryRisk&&<span className={css.notice} role="note">{t('bundledExtensions.localEmbedding.memoryRisk')}</span>}<span className={css.status}>{t(stateKey[row.state] as never)}</span></span>
    {asking?<span className={css.actions}>
      <span className={css.notice} role="status">{props.confirming!.enabled?t(text.enable as never):t(text.disable as never,{count:row.configuredChannels})}</span>
      <button type="button" className={clsx(css.button,props.confirming!.enabled?css.primary:css.danger)} disabled={props.busy} onClick={props.onConfirm}>{t('bundledExtensions.confirm.ok')}</button>
      <button type="button" className={css.button} disabled={props.busy} onClick={props.onCancel}>{t('bundledExtensions.confirm.cancel')}</button>
     </span>
     :<button type="button" className={clsx(css.button,!on&&css.primary)} disabled={props.busy} onClick={()=>props.onAsk({id:row.id,enabled:!on})}>{on?t('bundledExtensions.disable'):t('bundledExtensions.enable')}</button>}
   </li>})}</ul>
 </section>
}

export function BundledExtensionsSection({api}:{api:BundledExtensionsApi}){
 const {t}=useI18n()
 const [rows,setRows]=useState<BundledExtensionView[]>([])
 const [busy,setBusy]=useState(false)
 const [error,setError]=useState<string>()
 const [confirming,setConfirming]=useState<Confirming>()
 const load=useCallback(()=>{setError(undefined);api.list().then(setRows).catch(()=>setError(t('bundledExtensions.readFailed')))},[api,t])
 useEffect(load,[load])
 const confirm=()=>{
  if(!confirming)return
  setBusy(true);setError(undefined)
  api.set(confirming.id,confirming.enabled).then(next=>setRows(current=>current.map(row=>row.id===next.id?next:row))).catch(cause=>setError(t(bundledSetErrorKey(cause) as never))).finally(()=>{setBusy(false);setConfirming(undefined)})
 }
 return <BundledExtensionsView rows={rows} busy={busy} error={error} confirming={confirming} onAsk={setConfirming} onConfirm={confirm} onCancel={()=>setConfirming(undefined)} onRetry={load}/>
}
