import {useEffect,useRef,useState} from 'react'
import {X} from 'lucide-react'
import {projectStates,type ProjectDefinition} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {openDialog} from './dialog-focus.js'
import {projectStateKeys} from './project-presentation.js'
import css from './ProjectWorkspace.module.css'

export function ProjectForm({initial,editing=false,openTasks=0,close,save}:{initial:ProjectDefinition;editing?:boolean;openTasks?:number;close:()=>void;save:(fields:ProjectDefinition)=>Promise<void>}){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null)
 const [fields,setFields]=useState(initial),[busy,setBusy]=useState(false),[error,setError]=useState(''),[ack,setAck]=useState(false)
 const warning=editing&&initial.state!=='completed'&&fields.state==='completed'&&openTasks>0
 useEffect(()=>openDialog(dialog.current,input.current),[])
 const title=t(editing?'project.edit':'project.create')
 return <dialog ref={dialog} className={css.dialog} aria-label={title} onCancel={event=>{if(busy)event.preventDefault();else close()}} onClick={event=>{if(event.target===event.currentTarget&&!busy){const r=event.currentTarget.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)close()}}}><form className={css.form} onSubmit={async event=>{event.preventDefault();if(busy||(warning&&!ack))return;setBusy(true);setError('');try{await save(fields)}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}>
  <header><h2>{title}</h2><button type="button" disabled={busy} onClick={close} aria-label={t('task.form.close')}><X size={18}/></button></header>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  <label>{t('project.name')}<input aria-label={t('project.name')} ref={input} required maxLength={120} value={fields.title} disabled={busy} onChange={e=>setFields({...fields,title:e.target.value})}/></label>
  <label>{t('project.goal')}<textarea aria-label={t('project.goal')} required maxLength={8000} rows={4} value={fields.goal} disabled={busy} onChange={e=>setFields({...fields,goal:e.target.value})}/></label>
  <label>{t('project.dueDate')}<input aria-label={t('project.dueDate')} type="date" value={fields.dueDate??''} disabled={busy} onChange={e=>setFields({...fields,dueDate:e.target.value||null})}/></label>
  {editing&&<label>{t('project.status')}<select aria-label={t('project.status')} value={fields.state} disabled={busy} onChange={e=>setFields({...fields,state:e.target.value as ProjectDefinition['state']})}>{projectStates.filter(state=>state!=='archived').map(state=><option key={state} value={state}>{t(projectStateKeys[state])}</option>)}</select></label>}
  {warning&&<label className={css.check}><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/>{t('project.completeWarning',{count:openTasks})}</label>}
  <footer><button type="button" disabled={busy} onClick={close}>{t('task.form.cancel')}</button><button type="submit" className={css.primary} disabled={busy||!fields.title.trim()||!fields.goal.trim()||(warning&&!ack)}>{t(busy?'task.form.saving':editing?'project.save':'project.create')}</button></footer>
 </form></dialog>
}

export function ProjectArchiveDialog({close,save}:{close:()=>void;save:()=>Promise<void>}){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>openDialog(dialog.current),[])
 return <dialog ref={dialog} className={css.dialog} aria-label={t('project.archive')} onCancel={e=>{if(busy)e.preventDefault();else close()}}><form className={css.form} onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);try{await save()}catch(error){setError(localizeWorkError(locale,error))}finally{setBusy(false)}}}><header><h2>{t('project.archive')}</h2><button type="button" onClick={close} disabled={busy} aria-label={t('task.form.close')}><X size={18}/></button></header><p>{t('project.archiveWarning')}</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={close}>{t('task.form.cancel')}</button><button type="submit" disabled={busy}>{t(busy?'task.form.saving':'project.archive')}</button></footer></form></dialog>
}
