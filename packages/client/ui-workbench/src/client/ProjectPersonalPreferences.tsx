import {useEffect,useRef,useState} from 'react'
import {createPortal} from 'react-dom'
import {ContextDrawer} from './ContextDrawer.js'
import type {ProjectRuntimeApi} from './project-runtime-api.js'
import type {PersonalPreferenceDraft,PersonalPreferenceEntry,PersonalPreferences} from './project-personal-preferences-api.js'
import {projectRuntimeCopy} from './project-runtime-copy.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ProjectRuntimePanel.module.css'
import {projectContextCopy} from './project-context-copy.js'

type Props={api:ProjectRuntimeApi;changed?:()=>void}
export function ProjectPersonalPreferences(props:Props){
 const origin=useRef({api:props.api,personal:props.api.personal,key:0})
 if(origin.current.api!==props.api||origin.current.personal!==props.api.personal)origin.current={api:props.api,personal:props.api.personal,key:origin.current.key+1}
 return <ProjectPersonalPreferencesScope key={origin.current.key} {...props}/>
}
function ProjectPersonalPreferencesScope({api,changed}:Props){
 const personal=api.personal,{locale,t}=useI18n(),copy=projectRuntimeCopy(locale)
 const active=useRef(true)
 useEffect(()=>{active.current=true;return()=>{active.current=false}},[])
 const [open,setOpen]=useState(false),[data,setData]=useState<PersonalPreferences>(),[draft,setDraft]=useState(()=>personal.draft()),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[revision,refresh]=useState(0)
 useEffect(()=>{if(!open)return;let active=true;setLoading(true);void personal.get().then(value=>{if(active){setData(value);setLoading(false)}},cause=>{if(active){setData(undefined);setError(localizeWorkError(locale,cause));setLoading(false)}});return()=>{active=false}},[personal,open,revision,locale])
 const pending=personal.pending(),blocked=busy||loading||!!pending||!!personal.recoveryError()
 const update=(value:PersonalPreferenceDraft|undefined)=>{try{personal.setDraft(value);setDraft(value);setError('');setNotice('')}catch(cause){setError(localizeWorkError(locale,cause))}}
 const edit=(entry?:PersonalPreferenceEntry)=>{if(data)update({expectedVersion:data.version,entryId:entry?.id??null,topic:entry?.topic??'',markdown:entry?.markdown??''})}
 const act=async(run:()=>Promise<PersonalPreferences>)=>{if(busy||!active.current)return;setBusy(true);setError('');setNotice('');try{const value=await run();if(active.current){setData(value);setDraft(personal.draft());setNotice(copy.personalSaved);changed?.()}}catch(cause){if(active.current)setError(localizeWorkError(locale,cause))}finally{if(active.current)setBusy(false)}}
 const discard=()=>{if(busy)return;setNotice('');try{const had=personal.discard();setDraft(personal.draft());setError('');if(had)setNotice(t('recovery.discarded'));refresh(n=>n+1)}catch(cause){setError(localizeWorkError(locale,cause))}}
 return <><button type="button" onClick={()=>{setDraft(personal.draft());setOpen(true)}}>{copy.managePersonal}</button>{createPortal(<ContextDrawer open={open} title={copy.personalTitle} close={()=>setOpen(false)} canClose={!busy}><div className={css.dialogBody+' '+css.panel}>
  <p className={css.hint}>{copy.personalEditHint}</p>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{!!personal.recoveryError()&&<p role="alert">{copy.readError} {t('recovery.nextStep')}</p>}
  {pending&&<div className={css.notice}><p>{pending.endpoint==='publish-personal'?projectContextCopy(locale).personalPending:copy.pending}</p><button type="button" disabled={busy||!!personal.recoveryError()} onClick={()=>void act(()=>personal.recover())}>{copy.recover}</button></div>}
  {(pending||!!personal.recoveryError())&&<button type="button" disabled={busy} onClick={discard}>{t('recovery.discard')}</button>}
  {loading&&<p role="status">{copy.loading}</p>}
  <div className={css.actions}><button type="button" disabled={blocked||!!draft||!data} onClick={()=>edit()}>{copy.addPersonal}</button><button type="button" disabled={busy} onClick={()=>refresh(n=>n+1)}>{copy.refresh}</button></div>
  {draft&&<form className={css.form} onSubmit={event=>{event.preventDefault();event.stopPropagation();void act(()=>personal.save(draft))}}><label>{copy.personalTopic}<input aria-label={copy.personalTopic} maxLength={120} required value={draft.topic} disabled={busy} onChange={event=>update({...draft,topic:event.target.value})}/></label><label>{copy.personalBody}<textarea aria-label={copy.personalBody} maxLength={12000} required value={draft.markdown} disabled={busy} onChange={event=>update({...draft,markdown:event.target.value})}/></label>
   {data&&draft.expectedVersion!==data.version&&<div className={css.notice}><p>{copy.stale}</p><button type="button" disabled={blocked} onClick={()=>update({...draft,expectedVersion:data.version})}>{copy.rebase}</button></div>}
   <footer><button type="button" disabled={busy||!!pending} onClick={()=>update(undefined)}>{copy.cancel}</button><button type="submit" disabled={blocked||!data||draft.expectedVersion!==data.version}>{copy.savePersonal}</button></footer>
  </form>}
  {data&&!data.entries.length&&!draft&&<p className={css.hint}>{copy.noPersonal}</p>}
  {data?.entries.map(entry=><article className={css.entry} key={entry.id}><header><strong>{entry.topic}</strong><small>v{entry.version}</small></header>{entry.source&&<small>{projectContextCopy(locale).personalSource.replace('{version}',String(entry.source.entryVersion))}</small>}<p>{entry.markdown}</p><div className={css.actions}><button type="button" disabled={blocked||!!draft} onClick={()=>edit(entry)}>{copy.editPersonal}</button><button type="button" disabled={blocked||!!draft} onClick={()=>void act(()=>personal.withdraw({expectedVersion:data.version,entryId:entry.id}))}>{copy.withdrawPersonal}</button></div></article>)}
 </div></ContextDrawer>,document.getElementById('teloa-main')??document.body)}</>
}
