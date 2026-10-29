import {useEffect,useState} from 'react'
import type {WorkBudgetPolicy} from '@teloa/contract'
import type {ConversationBudgetApi,ConversationBudgetSettings as Settings} from './conversation-budget-api.js'
import {WorkBudgetFields,isWorkBudgetPolicyValid} from './WorkBudgetFields.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationBudgetSettings.module.css'

/** 页设只影响本会话之后经原生确认的新任务；从不修改既有 Run。 */
export function ConversationBudgetSettings({sessionId,api}:{sessionId:string;api:ConversationBudgetApi}){
 const {t,locale}=useI18n(),[expanded,setExpanded]=useState(false),[current,setCurrent]=useState<Settings>(),[draft,setDraft]=useState<WorkBudgetPolicy>(),[valid,setValid]=useState(true),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(false),[revision,setRevision]=useState(0),[unavailable,setUnavailable]=useState(false)
 useEffect(()=>{
  let live=true
  setBusy(true);setError('')
  void api.read(sessionId).then(value=>{if(live){setUnavailable(false);setCurrent(value);setDraft(prior=>prior??value.policy);setConfirmed(false)}},cause=>{if(live){if(cause&&typeof cause==='object'&&'code'in cause&&cause.code==='teloa/forbidden')setUnavailable(true);else setError(localizeWorkError(locale,cause))}}).finally(()=>{if(live)setBusy(false)})
  return()=>{live=false}
 },[api,sessionId,revision,locale])
 const save=async(recover=false)=>{
  if(busy||!current||!draft||!recover&&(!confirmed||!valid||!isWorkBudgetPolicyValid(draft)))return
  setBusy(true);setError('');setSaved(false)
  try{
   const value=await(recover?api.recover(sessionId):api.configure(current,draft))
   setCurrent(value);setDraft(value.policy);setConfirmed(false);setSaved(true)
  }catch(cause){
   setConfirmed(false)
   setError(cause&&typeof cause==='object'&&'code'in cause&&cause.code==='teloa/version-conflict'?t('planWork.budget.newConflict'):localizeWorkError(locale,cause))
  }finally{setBusy(false)}
 }
 const pending=api.pending(sessionId)
 if(unavailable)return null
 return <details className={css.settings} onToggle={event=>setExpanded(event.currentTarget.open)}>
  <summary>{t('planWork.budget.newTitle')}</summary>
  {expanded&&<div className={css.body}>
   <p>{t('planWork.budget.newHelp')}</p>
   {current&&<p className={css.status}>{t(current.configured?'planWork.budget.newConfigured':'planWork.budget.newDefault')}</p>}
   {error&&<p role="alert">{error}</p>}{saved&&<p role="status">{t('planWork.budget.newSaved')}</p>}
   {pending&&!busy&&<p role="status">{t('planWork.budget.newUnknown')} <button type="button" onClick={()=>void save(true)}>{t('planWork.budget.newRecover')}</button></p>}
   {busy&&!current&&<p role="status">{t('planWork.budget.newLoading')}</p>}
   {current&&draft&&<form onSubmit={event=>{event.preventDefault();void save()}}>
    <WorkBudgetFields value={draft} onChange={value=>{setDraft(value);setConfirmed(false);setSaved(false)}} onValidityChange={setValid} disabled={busy||pending}/>
    <p>{t('planWork.budget.unlimitedBoundary')}</p>
    <label className={css.confirm}><input type="checkbox" checked={confirmed} disabled={busy||pending} onChange={event=>setConfirmed(event.target.checked)}/>{t('planWork.budget.newConfirm')}</label>
    <div className={css.actions}><button type="submit" disabled={busy||pending||!confirmed||!valid||!isWorkBudgetPolicyValid(draft)}>{t(busy?'continuous.common.saving':'planWork.budget.newSave')}</button><button type="button" disabled={busy||pending} onClick={()=>{setSaved(false);setRevision(value=>value+1)}}>{t('planWork.budget.newRefresh')}</button></div>
   </form>}
   {!current&&!busy&&<button type="button" onClick={()=>setRevision(value=>value+1)}>{t('planWork.budget.newRefresh')}</button>}
  </div>}
 </details>
}
