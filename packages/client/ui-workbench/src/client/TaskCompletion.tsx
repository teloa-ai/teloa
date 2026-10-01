import {useEffect,useRef,useState} from 'react'
import type {Artifact,ArtifactRef} from './artifact-preview.js'
import type {PreviewTask} from './task-preview.js'
import type {TaskCompletionRecord} from './task-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './TaskPage.module.css'
export type TaskCompletionPort={list:(id:string)=>Promise<Artifact[]>;read:(id:string)=>Promise<TaskCompletionRecord|null>;complete:(task:PreviewTask,ref:ArtifactRef,note:string)=>Promise<void>}
export function TaskCompletion({task,api,open,face,onRecord}:{task:PreviewTask;api:TaskCompletionPort;open:(ref:ArtifactRef)=>void;face?:'timeline';onRecord?:(record:TaskCompletionRecord|null)=>void}){
 const {locale,t,dateTime}=useI18n()
 const [retry,setRetry]=useState(0)
 const [rows,setRows]=useState<Artifact[]>([]),[record,setRecord]=useState<TaskCompletionRecord|null>(null),[selected,setSelected]=useState(''),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>{let active=true;setRecord(null);setRows([]);setSelected('');setError('');if(task.state==='completed'){void api.read(task.id).then(value=>{if(active){if(!value||value.taskVersion!==task.version){setError(t('taskCompletion.versionMismatch'));return}setRecord(value)}}).catch(cause=>{if(active)setError(localizeWorkError(locale,cause))})}return()=>{active=false}},[task.id,task.version,task.state,retry,locale,t,api])
 const onRecordRef=useRef(onRecord);onRecordRef.current=onRecord
 useEffect(()=>{onRecordRef.current?.(record)},[record])
 if(task.storage!=='persistent'||!(task.state==='completed'||(task.assigneeId==='self'?task.state==='running':task.state==='waiting')))return null
 const options=rows.flatMap(row=>row.versions.filter(v=>v.source.ref.kind==='task'&&v.source.ref.id===task.id&&v.source.version===`${task.version} · ${task.updatedAt}`).map(v=>({key:row.id+':'+v.number,id:row.id,version:v.number,title:v.title})))
 const choice=options.find(row=>row.key===selected)
 return <section className={css.block} aria-label={t('taskCompletion.aria')} title={face==='timeline'&&task.state!=='completed'?t('taskCompletion.description'):undefined}>{face!=='timeline'&&<h3>{t(task.state==='completed'?'taskCompletion.record':'taskCompletion.confirm')}</h3>}{error&&<p role="alert">{error}</p>}
 {task.state==='completed'?record?<><p>{record.note}</p><p className={css.muted}>{t('taskCompletion.completedMeta',{at:dateTime(record.completedAt),version:record.artifactVersion})}</p><button type="button" onClick={()=>open({id:record.artifactId,version:record.artifactVersion})}>{t('taskCompletion.view')}</button></>:error?<button type="button" onClick={()=>setRetry(value=>value+1)}>{t('taskCompletion.retry')}</button>:<p>{t('taskCompletion.loading')}</p>:<>
 {face!=='timeline'&&<p>{t('taskCompletion.description')}</p>}
 <button type="button" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{setRows(await api.list(task.id));setSelected('')}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}}>{t('taskCompletion.load')}</button>
 <form className={css.form} onSubmit={async event=>{event.preventDefault();if(!choice||busy)return;setBusy(true);setError('');try{await api.complete(task,{id:choice.id,version:choice.version},note)}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}}><label>{t('taskCompletion.versionLabel')}<select disabled={busy} value={selected} onChange={event=>setSelected(event.target.value)}><option value="">{t('taskCompletion.versionPlaceholder')}</option>{options.map(row=><option key={row.key} value={row.key}>{row.title} · v{row.version}</option>)}</select></label>{choice&&<button type="button" onClick={()=>open({id:choice.id,version:choice.version})}>{t('taskCompletion.review')}</button>}<label>{t('taskCompletion.note')}<textarea required maxLength={4000} rows={3} disabled={busy} value={note} onChange={event=>setNote(event.target.value)}/></label><button type="submit" disabled={busy||!choice||!note.trim()}>{t('taskCompletion.submit')}</button></form>
 </>}
 </section>
}
