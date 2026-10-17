import {useEffect,useRef,useState} from 'react'
import {X} from 'lucide-react'
import {projectStates,type ProjectDefinition} from '@teloa/contract'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {projectStateKeys} from './project-presentation.js'
import css from './ProjectWorkspace.module.css'

export type ProjectFormDraft={fields:ProjectDefinition;ack:boolean;titleEdited?:boolean}
// 只拟定可核对的名称；完整描述仍是目标，不从自然语言推断日期、状态或授权。
function descriptionTitle(value:string){
 const line=value.split(/\r?\n/).map(line=>line.trim()).find(line=>line&&!/^[#*\-_=\s]+$/.test(line))??''
 const text=line.replace(/^#{1,6}\s+/,'').replace(/\s+#+$/,'').replace(/^(?:[-*+]\s+|\d+[.)]\s+)/,'')
 return (text.split(/(?<=[。！？])|(?<=[.!?])\s+/)[0]??'').trim().slice(0,120).replace(/[\uD800-\uDBFF]$/,'')
}
export function ProjectForm({initial,draft,changeDraft,pending,editing=false,openTasks=0,scopeName,close,save}:{initial:ProjectDefinition;draft?:ProjectFormDraft;changeDraft?:(draft:ProjectFormDraft)=>void;pending?:Promise<void>|undefined;editing?:boolean;openTasks?:number;scopeName?:string;close:()=>void;save:(fields:ProjectDefinition)=>Promise<void>}){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),description=useRef<HTMLTextAreaElement>(null)
 const [fields,updateFields]=useState(draft?.fields??initial),[busy,setBusy]=useState(!!pending),[error,setError]=useState(''),[ack,updateAck]=useState(draft?.ack??false),[titleEdited,updateTitleEdited]=useState(draft?.titleEdited??!!(draft?.fields.title??initial.title))
 const setFields=(fields:ProjectDefinition,edited=titleEdited)=>{updateFields(fields);updateTitleEdited(edited);changeDraft?.({fields,ack,titleEdited:edited})},setAck=(ack:boolean)=>{updateAck(ack);changeDraft?.({fields,ack,titleEdited})},dismiss=useDialogDismiss(close,!busy)
 const warning=editing&&initial.state!=='completed'&&fields.state==='completed'&&openTasks>0
 useEffect(()=>openDialog(dialog.current,editing?input.current:description.current),[])
 useEffect(()=>{if(!pending)return;let active=true;void pending.then(()=>{if(active)setBusy(false)},e=>{if(active){setError(localizeWorkError(locale,e));setBusy(false)}});return()=>{active=false}},[pending,locale])
 const title=t(editing?'project.edit':'project.create')
 return <dialog ref={dialog} className={css.dialog} aria-label={title} {...dismiss}><form className={css.form} onSubmit={async event=>{event.preventDefault();if(busy||(warning&&!ack))return;setBusy(true);setError('');try{await save(fields)}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}>
  <header><h2>{title}</h2><button type="button" disabled={busy} onClick={close} aria-label={t('project.dialog.close')}><X size={18}/></button></header>
  {error&&<p role="alert" className={css.error}>{error}</p>}
  {editing?<>
   <label>{t('project.name')}<input aria-label={t('project.name')} ref={input} required maxLength={120} value={fields.title} disabled={busy} onChange={e=>setFields({...fields,title:e.target.value})}/></label>
   <label>{t('project.goal')}<textarea aria-label={t('project.goal')} required maxLength={8000} rows={4} value={fields.goal} disabled={busy} onChange={e=>setFields({...fields,goal:e.target.value})}/></label>
   <label>{t('project.dueDate')}<input aria-label={t('project.dueDate')} type="date" value={fields.dueDate??''} disabled={busy} onChange={e=>setFields({...fields,dueDate:e.target.value||null})}/></label>
  </>:<>
   <p className={css.createScope}>{t('project.create.scope',{name:scopeName??initial.scope})}</p>
   <label>{t('project.create.description')}<textarea ref={description} className={css.createDescription} aria-label={t('project.create.description')} aria-describedby="project-description-hint" required maxLength={8000} rows={8} placeholder={t('project.create.example')} value={fields.goal} disabled={busy} onChange={e=>setFields({...fields,goal:e.target.value,...(!titleEdited?{title:descriptionTitle(e.target.value)}:{})})}/></label>
   <p id="project-description-hint">{t('project.create.hint')}</p>
   {(fields.goal.trim()||fields.title)&&<label className={css.proposedTitle}>{t('project.name')}<input aria-label={t('project.name')} required maxLength={120} value={fields.title} disabled={busy} onChange={e=>setFields({...fields,title:e.target.value},true)}/></label>}
   <details className={css.optionalFields}><summary>{t('project.dueDate')}</summary><label>{t('project.dueDate')}<input aria-label={t('project.dueDate')} type="date" value={fields.dueDate??''} disabled={busy} onChange={e=>setFields({...fields,dueDate:e.target.value||null})}/></label></details>
  </>}
  {editing&&<label>{t('project.status')}<select aria-label={t('project.status')} value={fields.state} disabled={busy} onChange={e=>setFields({...fields,state:e.target.value as ProjectDefinition['state']})}>{projectStates.filter(state=>state!=='archived').map(state=><option key={state} value={state}>{t(projectStateKeys[state])}</option>)}</select></label>}
  {warning&&<label className={css.check}><input type="checkbox" checked={ack} disabled={busy} onChange={e=>setAck(e.target.checked)}/>{t('project.completeWarning',{count:openTasks})}</label>}
  <footer><button type="button" disabled={busy} onClick={close}>{t('task.form.cancel')}</button><button type="submit" className={css.primary} disabled={busy||!fields.title.trim()||!fields.goal.trim()||(warning&&!ack)}>{t(busy?'task.form.saving':editing?'project.save':'project.create')}</button></footer>
 </form></dialog>
}

export function ProjectArchiveDialog({close,save}:{close:()=>void;save:()=>Promise<void>}){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>openDialog(dialog.current),[])
 return <dialog ref={dialog} className={css.dialog} aria-label={t('project.archive')} onCancel={e=>{if(busy)e.preventDefault();else close()}}><form className={css.form} onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);try{await save()}catch(error){setError(localizeWorkError(locale,error))}finally{setBusy(false)}}}><header><h2>{t('project.archive')}</h2><button type="button" onClick={close} disabled={busy} aria-label={t('project.dialog.close')}><X size={18}/></button></header><p>{t('project.archiveWarning')}</p>{error&&<p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={close}>{t('task.form.cancel')}</button><button type="submit" disabled={busy}>{t(busy?'task.form.saving':'project.archive')}</button></footer></form></dialog>
}
