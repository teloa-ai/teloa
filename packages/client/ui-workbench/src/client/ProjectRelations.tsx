import {useEffect,useRef,useState} from 'react'
import {X} from 'lucide-react'
import {projectLinkKinds,type ProjectItem,type ProjectLink,type ProjectLinkKind,type WorkProject} from '@teloa/contract'
import type {ProjectApi} from './project-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {openDialog} from './dialog-focus.js'
import {projectKindKeys} from './project-presentation.js'
import css from './ProjectWorkspace.module.css'

export function ProjectRelations({project,api,close,save}:{project:WorkProject;api:ProjectApi;close:()=>void;save:(links:ProjectLink[])=>Promise<void>}){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null)
 const [kind,setKind]=useState<ProjectLinkKind>('task'),[query,setQuery]=useState(''),[rows,setRows]=useState<ProjectItem[]>([]),[selected,setSelected]=useState<ProjectLink[]>([]),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[retry,setRetry]=useState(0)
 useEffect(()=>openDialog(dialog.current,input.current),[])
 useEffect(()=>{let active=true;setLoading(true);setError('');setRows([]);setSelected([]);const timer=setTimeout(()=>{void api.candidates(project.scope,kind,query).then(value=>{if(active){setRows(value);setLoading(false)}},e=>{if(active){setError(localizeWorkError(locale,e));setLoading(false)}})},180);return()=>{active=false;clearTimeout(timer)}},[api,project.scope,kind,query,retry,locale])
 const options=rows.filter(row=>!project.links.some(link=>link.kind===row.kind&&link.id===row.id))
 return <dialog ref={dialog} className={css.dialog} aria-label={t('project.add')} onCancel={e=>{if(busy)e.preventDefault();else close()}}><form className={css.form} onSubmit={async e=>{e.preventDefault();if(busy||loading||error||!selected.length)return;setBusy(true);setError('');try{await save(selected)}catch(e){setError(localizeWorkError(locale,e))}finally{setBusy(false)}}}>
  <header><h2>{t('project.add')}</h2><button type="button" disabled={busy} onClick={close} aria-label={t('task.form.close')}><X size={18}/></button></header>
  <p>{t('project.addHint')}</p><label>{t('project.relationType')}<select aria-label={t('project.relationType')} disabled={busy} value={kind} onChange={e=>{setKind(e.target.value as ProjectLinkKind);setSelected([]);setQuery('')}}>{projectLinkKinds.map(value=><option key={value} value={value}>{t(projectKindKeys[value])}</option>)}</select></label>
  <label>{t('project.search')}<input ref={input} value={query} disabled={busy} maxLength={120} onChange={e=>setQuery(e.target.value)}/></label>
  {error&&<div role="alert" className={css.error}>{error}<button type="button" disabled={busy} onClick={()=>setRetry(n=>n+1)}>{t('project.refresh')}</button></div>}
  <div className={css.candidates} aria-busy={loading}>{loading?<p role="status">{t('project.loading')}</p>:error?null:!options.length?<p>{t('project.noCandidates')}</p>:options.map(item=><label className={css.check} key={item.id}><input type="checkbox" disabled={busy} checked={selected.some(link=>link.id===item.id)} onChange={e=>setSelected(current=>e.target.checked?[...current,{kind:item.kind,id:item.id}]:current.filter(link=>link.id!==item.id))}/><span>{item.title}</span></label>)}</div>
  {rows.length===100&&<small>{t('project.refineSearch')}</small>}
  <footer><button type="button" onClick={close} disabled={busy}>{t('task.form.cancel')}</button><button type="submit" className={css.primary} disabled={busy||loading||!!error||!selected.length}>{busy?t('task.form.saving'):t('project.addSelected',{count:selected.length})}</button></footer>
 </form></dialog>
}
