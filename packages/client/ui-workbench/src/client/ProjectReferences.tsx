import {useEffect,useRef,useState} from 'react'
import {X} from 'lucide-react'
import {projectLinkKinds,type ProjectItem,type ProjectLinkKind,type ProjectReference,type WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import type {BusinessScopeLabel} from './business-directory.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {projectKindKeys,referenceScopeName} from './project-presentation.js'
import css from './ProjectWorkspace.module.css'

export type ProjectReferencesDraft={scope:string;kind:ProjectLinkKind;query:string;selected:ProjectReference[]}
type Props={project:WorkProject;api:ProjectApi;draft?:ProjectReferencesDraft;changeDraft?:(draft:ProjectReferencesDraft)=>void;pending?:Promise<void>|undefined;scopeLabels:readonly BusinessScopeLabel[];scopeName?:(scope:string)=>string;close:()=>void;save:(references:ProjectReference[])=>Promise<void>}
/** 引用其他业务的条目：比本业务关联多一步「选择业务」，候选查询复用同一 candidates 端点，只是换了 scope。 */
export function ProjectReferences({project,api,draft,changeDraft,pending,scopeLabels,scopeName=scope=>scope,close,save}:Props){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null)
 const others=scopeLabels.filter(label=>label.scope!==project.scope)
 const [value,setValue]=useState<ProjectReferencesDraft>(draft??{scope:others[0]?.scope??'',kind:'task',query:'',selected:[]}),{scope,kind,query,selected}=value
 const change=(next:ProjectReferencesDraft)=>{setValue(next);changeDraft?.(next)}
 const [rows,setRows]=useState<ProjectItem[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(!!pending),[error,setError]=useState(''),[retry,setRetry]=useState(0),dismiss=useDialogDismiss(close,!busy)
 useEffect(()=>openDialog(dialog.current,input.current),[])
 useEffect(()=>{if(!pending)return;let active=true;void pending.then(()=>{if(active)setBusy(false)},e=>{if(active){setError(localizeWorkError(locale,e));setBusy(false)}});return()=>{active=false}},[pending,locale])
 useEffect(()=>{let active=true;setLoading(true);setError('');setRows([]);if(!scope||!others.some(label=>label.scope===scope)){setLoading(false);return}const timer=setTimeout(()=>{void api.candidates(scope,kind,query).then(value=>{if(active){setRows(value);setLoading(false)}},e=>{if(active){setError(localizeWorkError(locale,e));setLoading(false)}})},180);return()=>{active=false;clearTimeout(timer)}},[api,scope,kind,query,retry,locale,scopeLabels])
 const options=rows.filter(row=>!project.references.some(ref=>ref.scope===scope&&ref.kind===row.kind&&ref.id===row.id))
 return <dialog ref={dialog} className={css.dialog} aria-label={t('project.reference.add')} {...dismiss}><form className={css.form} onSubmit={async e=>{e.preventDefault();if(busy||loading||error||!selected.length||!others.some(label=>label.scope===scope))return;setBusy(true);setError('');try{await save(selected)}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}>
  <header><h2>{t('project.reference.add')}</h2><button type="button" disabled={busy} onClick={close} aria-label={t('project.dialog.close')}><X size={18}/></button></header>
  <p>{t('project.reference.hint')}</p>
  <label>{t('project.reference.business')}<select aria-label={t('project.reference.business')} disabled={busy||!others.length} value={scope} onChange={e=>change({...value,scope:e.target.value,selected:[],query:''})}>{others.map(label=><option key={label.scope} value={label.scope}>{referenceScopeName(label,scopeLabels,scopeName)}</option>)}</select></label>
  <label>{t('project.relationType')}<select aria-label={t('project.relationType')} disabled={busy} value={kind} onChange={e=>change({...value,kind:e.target.value as ProjectLinkKind,selected:[],query:''})}>{projectLinkKinds.map(value=><option key={value} value={value}>{t(projectKindKeys[value])}</option>)}</select></label>
  <label>{t('project.search')}<input ref={input} value={query} disabled={busy||!scope} maxLength={120} onChange={e=>change({...value,query:e.target.value})}/></label>
  {error&&<div role="alert" className={css.error}>{error}<button type="button" disabled={busy} onClick={()=>setRetry(n=>n+1)}>{t('project.refresh')}</button></div>}
  <div className={css.candidates} aria-busy={loading}>{loading?<p role="status">{t('project.loading')}</p>:error?null:!scope||!others.some(label=>label.scope===scope)?<p>{t('project.reference.noBusiness')}</p>:!options.length?<p>{t('project.noCandidates')}</p>:options.map(item=><label className={css.check} key={item.id}><input type="checkbox" disabled={busy} checked={selected.some(ref=>ref.id===item.id)} onChange={e=>change({...value,selected:e.target.checked?[...selected,{kind:item.kind,id:item.id,scope}]:selected.filter(ref=>ref.id!==item.id)})}/><span>{item.title}</span></label>)}</div>
  {rows.length===100&&<small>{t('project.refineSearch')}</small>}
  <footer><button type="button" onClick={close} disabled={busy}>{t('task.form.cancel')}</button><button type="submit" className={css.primary} disabled={busy||loading||!!error||!selected.length||!others.some(label=>label.scope===scope)}>{busy?t('task.form.saving'):t('project.reference.addSelected',{count:selected.length})}</button></footer>
 </form></dialog>
}
