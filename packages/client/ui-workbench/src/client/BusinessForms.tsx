import { openDialog } from './dialog-focus.js'
import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { useBusinessScopes } from './business-scope-context.js'
import { canReceiveTask, type PreviewRole } from './role-preview.js'
import type { ObjectRef } from './business-preview.js'
import type { BusinessChange } from './business-work-preview.js'
import { useI18n } from './i18n/provider.js'
import { localizeWorkError } from './i18n/errors.js'
import css from './TaskPage.module.css'

export function BusinessForm({mode,refs,roles,close,save}:{mode:'task'|'operation';refs:ObjectRef[];roles:PreviewRole[];close:()=>void;save:(command:BusinessChange,id:string)=>void}){
  const {locale,t}=useI18n()
  const collaborationScopes=useBusinessScopes()
  const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null)
  const [title,setTitle]=useState(''),[goal,setGoal]=useState(''),[assignee,setAssignee]=useState(''),[parameters,setParameters]=useState(''),[targets,setTargets]=useState(''),[risk,setRisk]=useState(''),[error,setError]=useState('')
  useEffect(()=>openDialog(dialog.current,input.current),[])
  const scope=refs[0]!.scope,candidates=roles.filter(role=>canReceiveTask(role,scope)),operation=mode==='operation'
  return <dialog ref={dialog} className={css.dialog} aria-label={t(operation?'business.form.operation.aria':'business.form.task.aria')} onCancel={close}><form className={css.form} onSubmit={event=>{event.preventDefault();try{const id=crypto.randomUUID(),now=new Date().toISOString();save(operation?{type:'propose-operation',id,refs,title,goal,parameters,targets:targets.split('\n').filter(value=>value.trim()),risk,now}:{type:'object-task',id,ref:refs[0]!,title,goal,assigneeId:assignee,now},id)}catch(error){setError(localizeWorkError(locale,error))}}}><header><h2>{t(operation?'business.form.operation.aria':'business.form.task.aria')}</h2><button type="button" aria-label={t('business.form.close')} onClick={close}><X size={18}/></button></header><p>{collaborationScopes[scope]??scope} · {refs.map(ref=>ref.title+' v'+ref.version).join(t('business.common.separator'))}<br/>{t(operation?'business.form.operation.description':'business.form.task.description')}</p>{error&&<p role="alert">{error}</p>}<label>{t(operation?'business.form.operation.name':'business.form.task.name')}<input ref={input} required maxLength={120} value={title} onChange={event=>setTitle(event.target.value)}/></label><label>{t('business.form.goal')}<textarea required rows={3} maxLength={4000} value={goal} onChange={event=>setGoal(event.target.value)}/></label>{operation?<><label>{t('business.form.targets')}<textarea required rows={3} value={targets} onChange={event=>setTargets(event.target.value)}/></label><label>{t('business.form.parameters')}<textarea required rows={3} maxLength={4000} value={parameters} onChange={event=>setParameters(event.target.value)}/></label><label>{t('business.form.risk')}<textarea required rows={2} maxLength={4000} value={risk} onChange={event=>setRisk(event.target.value)}/></label></>:<label>{t('business.form.assignee')}<select required value={assignee} onChange={event=>setAssignee(event.target.value)}><option value="">{t('business.form.selectRole')}</option>{candidates.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select>{!candidates.length&&<small>{t('business.form.noRole')}</small>}</label>}<footer className={css.buttons}><button type="button" onClick={close}>{t('business.form.cancel')}</button><button type="submit" disabled={!title.trim()||!goal.trim()||(operation?!targets.trim()||!parameters.trim()||!risk.trim():!assignee)}>{t(operation?'business.form.operation.submit':'business.form.task.submit')}</button></footer></form></dialog>
}
