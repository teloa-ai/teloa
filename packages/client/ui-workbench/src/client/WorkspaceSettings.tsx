import { useEffect,useRef,useState,useSyncExternalStore } from 'react'
import { ArrowUp,ArrowDown,Folder } from 'lucide-react'
import {isWorkspaceManagementMessage,type WorkspaceManagement} from './workspace-management.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './WorkspaceSettings.module.css'

export function WorkspaceSettings({management}:{management:WorkspaceManagement}){
  const {locale,t}=useI18n()
  const state=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const [removing,setRemoving]=useState<string>(),[confirmed,setConfirmed]=useState(false)
  const heading=useRef<HTMLHeadingElement>(null),editButtons=useRef(new Map<string,HTMLButtonElement>()),removeButtons=useRef(new Map<string,HTMLButtonElement>())
  const busy=!!state.pending||!state.ready
  const missingEdit=state.editing&&!state.rows.some(row=>row.workspaceId===state.editing)
  const operationError=state.error
  useEffect(()=>{if(removing&&!state.rows.some(row=>row.workspaceId===removing)&&!state.pending){setRemoving(undefined);setConfirmed(false);heading.current?.focus()}},[removing,state.rows,state.pending])
  return <section className={css.page} aria-label={t('workspaceSettings.title')}>
    <h2 ref={heading} tabIndex={-1}>{t('workspaceSettings.title')}</h2><p>{t('workspaceSettings.description')}</p>
    {!state.ready&&<p role="status">{t('workspaceSettings.waiting')}</p>}
    {operationError!==undefined&&operationError!==null&&<p role="alert">{isWorkspaceManagementMessage(operationError)?t(operationError.key,operationError.params):localizeWorkError(locale,operationError)}</p>}
    {(operationError===undefined||operationError===null)&&state.sourceError&&<p role="alert">{localizeWorkError(locale,state.sourceError)}</p>}
    {state.notice&&<p role="status">{t(state.notice.key,state.notice.params)}</p>}
    <form className={css.add} onSubmit={event=>{event.preventDefault();void management.create()}}>
      <label>{t('workspaceSettings.addExisting')}<input aria-label={t('workspaceSettings.pathAria')} placeholder="/path/to/project" value={state.path} onChange={event=>management.setPath(event.target.value)} disabled={busy}/></label>
      <button type="submit" disabled={busy||!state.path.trim()}>{state.pending?.kind==='create'?t('workspaceSettings.adding'):t('workspaceSettings.add')}</button>
    </form>
    {state.ready&&state.rows.length===0&&<p>{t('workspaceSettings.empty')}</p>}
    {missingEdit&&state.editing&&<div className={css.editor}>
      <p role="status">{t('workspaceSettings.removedDraft')}</p>
      <label>{t('workspaceSettings.removedDraftLabel')}<input readOnly value={state.drafts[state.editing]?.value??''}/></label>
      <small>{t('workspaceSettings.originalId',{id:state.editing})}</small>
      <button type="button" onClick={()=>{management.closeEditor();heading.current?.focus()}}>{t('workspaceSettings.collapseDraft')}</button>
    </div>}
    <ol className={css.list} aria-label={t('workspaceSettings.directoryAria')}>{state.rows.map((row,index)=>{
      const id=row.workspaceId,draft=state.drafts[id],conflict=draft&&draft.baseTitle!==row.title
      return <li className={css.row} key={id}>
        <div className={css.summary}><Folder size={18}/><div><strong>{row.title}</strong><code>{row.path}</code><small>{t('workspaceSettings.linkedSessions',{count:row.sessionIds.length})}</small></div></div>
        <div className={css.actions}><button ref={node=>{if(node)editButtons.current.set(id,node);else editButtons.current.delete(id)}} type="button" onClick={()=>management.edit(id)} disabled={busy}>{t('workspaceSettings.rename')}<span className={css.hidden}> {row.title}</span></button><button type="button" aria-label={t('workspaceSettings.moveUp',{title:row.title})} disabled={busy||index===0} onClick={()=>void management.move(id,'up')}><ArrowUp size={15}/></button><button type="button" aria-label={t('workspaceSettings.moveDown',{title:row.title})} disabled={busy||index===state.rows.length-1} onClick={()=>void management.move(id,'down')}><ArrowDown size={15}/></button><button ref={node=>{if(node)removeButtons.current.set(id,node);else removeButtons.current.delete(id)}} type="button" onClick={()=>{setRemoving(id);setConfirmed(false)}} disabled={busy}>{t('workspaceSettings.remove')}<span className={css.hidden}> {row.title}</span></button></div>
        {state.editing===id&&draft&&<form className={css.editor} onSubmit={event=>{event.preventDefault();void management.rename(id)}}>
          <label>{t('workspaceSettings.name')}<input autoFocus aria-label={t('workspaceSettings.nameAria',{title:row.title})} value={draft.value} maxLength={200} disabled={busy} onChange={event=>management.setTitle(event.target.value)}/></label>
          {conflict&&<p role="alert">{t('workspaceSettings.nameConflict',{title:row.title})}<button type="button" disabled={busy} onClick={()=>management.acceptCurrentTitle(id)}>{t('workspaceSettings.reviewedName')}</button></p>}
          <div className={css.actions}><button type="submit" disabled={busy||conflict||!draft.value.trim()}>{t('workspaceSettings.saveName')}</button><button type="button" onClick={()=>{management.closeEditor();editButtons.current.get(id)?.focus()}}>{t('workspaceSettings.collapse')}</button></div>
        </form>}
        {removing===id&&<div className={css.editor}><p>{t('workspaceSettings.removeDescription',{title:row.title})}</p><label className={css.confirm}><input type="checkbox" checked={confirmed} onChange={event=>setConfirmed(event.target.checked)} disabled={busy}/>{t('workspaceSettings.confirmRegistrationRemoval')}</label><div className={css.actions}><button type="button" disabled={busy||!confirmed} onClick={()=>void management.remove(id,confirmed)}>{t('workspaceSettings.confirmRemove')}</button><button type="button" onClick={()=>{setRemoving(undefined);setConfirmed(false);removeButtons.current.get(id)?.focus()}}>{t('workspaceSettings.cancel')}</button></div></div>}
      </li>
    })}</ol>
  </section>
}
