import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {TwinDraft,TwinDraftAdoption} from '@teloa/contract'
import type {TwinDraftApi} from './twin-drafts-api.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {twinDraftCopy} from './i18n/locales/twin-drafts.js'
import {twinDraftConversationErrorCodes} from './twin-draft-conversation.js'
import css from './TwinDraftWorkspace.module.css'

export type TwinDraftWorkspacePort={api:TwinDraftApi;openConversationDraft?:(sessionId:string,text:string)=>Promise<void>;openDraft?:{roleId:string;draftId:string;requestId:string}|undefined}
/** 来源与目标始终属于原稿；切换选择、关闭和重连不触发采用。 */
export function TwinDraftWorkspace({port,roleId,roleVersion,retired=false,count}:{port:TwinDraftWorkspacePort;roleId:string;roleVersion:number;retired?:boolean;count?:(value:number)=>void}){
 const {locale}=useI18n(),copy=(key:Parameters<typeof twinDraftCopy>[1])=>twinDraftCopy(locale,key),api=port.api
 const openError=(error:unknown)=>{const code=error&&typeof error==='object'&&'code'in error?error.code:undefined;return code===twinDraftConversationErrorCodes.unavailable?copy('openUnavailable'):code===twinDraftConversationErrorCodes.occupied?copy('inputOccupied'):code===twinDraftConversationErrorCodes.rejected?copy('inputRejected'):localizeWorkError(locale,error)}
 useSyncExternalStore(api.subscribe,api.getSnapshot,api.getSnapshot)
 const origin=useMemo(()=>({api,roleId,roleVersion}),[api,roleId,roleVersion]),live=useRef(origin);live.current=origin
 const [loaded,setLoaded]=useState<{origin:typeof origin;rows:TwinDraft[]}>(),[error,setError]=useState(''),[notice,setNotice]=useState(''),[selected,setSelected]=useState<string>(),[reload,setReload]=useState(0)
 const [editing,setEditing]=useState(false),[returning,setReturning]=useState(false),[reason,setReason]=useState(''),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false)
 const rows=loaded?.origin===origin?loaded.rows:[],current=rows.find(row=>row.id===selected)??rows[0],pending=api.pending(),recoveryError=api.recoveryError()
 const selectedRef=useRef(current?.id);selectedRef.current=current?.id
 useEffect(()=>{setBusy(false);setConfirmed(false)},[origin])
 useEffect(()=>{if(port.openDraft?.roleId===roleId)setSelected(port.openDraft.draftId)},[port.openDraft?.roleId,port.openDraft?.draftId,port.openDraft?.requestId,origin])
 useEffect(()=>{let active=true;setError('');void api.list(roleId).then(result=>{if(active&&live.current===origin)setLoaded({origin,rows:result.drafts})},error=>{if(active&&live.current===origin)setError(localizeWorkError(locale,error))});return()=>{active=false}},[origin,reload])
 useEffect(()=>{if(loaded?.origin===origin)count?.(rows.filter(row=>row.state==='draft').length)},[loaded,origin,count])
 useEffect(()=>{setEditing(false);setReturning(false);setReason('');setConfirmed(false);setNotice('')},[current?.id,current?.revision,origin])
 const update=(draft:TwinDraft)=>{if(live.current===origin)setLoaded(previous=>previous?.origin===origin?{origin,rows:previous.rows.map(row=>row.id===draft.id?draft:row)}:previous)}
 const act=async(operation:()=>Promise<TwinDraft|TwinDraftAdoption>,message?:string)=>{
  if(busy)return
  setBusy(true);setError('');setNotice('')
  try{const result=await operation();if(live.current!==origin)return;const draft='draft'in result?result.draft:result;update(draft);if(selectedRef.current===draft.id){setConfirmed(false);setEditing(false);setReturning(false);setReason('');if(message)setNotice(message)}}catch(error){if(live.current===origin)setError(localizeWorkError(locale,error))}finally{if(live.current===origin)setBusy(false)}
 }
 const edit=current?api.editing(current.id):undefined,body=edit?.body??current?.body??'',stale=!!current&&!!edit&&(edit.revision!==current.revision||edit.bodyHash!==current.bodyHash)
 const dirty=!!current&&body!==current.body,blocked=busy||!!pending||!!recoveryError,roleStale=retired||!!current&&current.roleVersion!==roleVersion
 const currentPending=!!pending&&'draftId'in pending.input&&pending.input.draftId===current?.id
 return <section className={css.workspace} aria-label={copy('title')}>
  <header className={css.header}><h3>{copy('title')}</h3><button type="button" disabled={busy} onClick={()=>setReload(v=>v+1)}>{copy('refresh')}</button></header>
  {error&&<p role="alert">{error}</p>}
  {notice&&<p role="status">{notice}</p>}
  {!!recoveryError&&<p role="alert">{api.hasUnsavedDraft()?copy('storageFailed'):localizeWorkError(locale,recoveryError)}</p>}
  {pending&&<div className={css.recovery}><p role="status">{copy('unknown')}</p><button type="button" disabled={busy||!!recoveryError} onClick={()=>void act(api.recover)}>{busy?copy('pending'):copy('recover')}</button></div>}
  {loaded?.origin!==origin&&!error&&<p role="status">{copy('loading')}</p>}
  {loaded?.origin===origin&&!rows.length&&<p>{copy('empty')}</p>}
  {!!rows.length&&<div className={css.columns}>
   <nav className={css.list} aria-label={copy('title')}>{rows.map(row=><button type="button" key={row.id} aria-pressed={current?.id===row.id} onClick={()=>setSelected(row.id)}><strong>{row.title}</strong><small>{copy(row.source.kind==='group'?'group':row.source.kind==='conversation'?'conversation':'provided')} · {row.source.label}</small><small>{copy(row.state)}</small></button>)}</nav>
   {current&&<article className={css.detail}>
    <header><h4>{current.title}</h4><span>{copy(current.state)} · v{current.revision}</span></header>
    <p className={css.muted}>{copy(current.source.kind==='group'?'group':current.source.kind==='conversation'?'conversation':'provided')} · {current.source.label}</p>
    <h4>{copy('original')}</h4><blockquote>{current.source.text}</blockquote>
    <h4>{copy('rewritten')}</h4>
    {editing?<label>{copy('body')}<textarea maxLength={8000} rows={7} value={body} disabled={currentPending} onChange={event=>{try{api.edit(current,event.target.value)}catch(error){setError(localizeWorkError(locale,error))}}}/></label>:<p className={css.body}>{current.body}</p>}
    {['sent','prepared'].includes(current.state)&&dirty&&<div><h4>{copy('preserved')}</h4><p className={css.body}>{body}</p><button type="button" onClick={()=>{void navigator.clipboard.writeText(body).then(()=>setNotice(copy('copied')),error=>setError(localizeWorkError(locale,error)))}}>{copy('copyPreserved')}</button></div>}
    <h4>{copy('basis')}</h4>{current.basis.length?<ul>{current.basis.map(item=><li key={item.id}>{item.title} · v{item.version}</li>)}</ul>:<p className={css.muted}>{copy('noBasis')}</p>}
    {current.returnReason&&<p>{copy('reason')}：{current.returnReason}</p>}
    {roleStale&&<p role="status">{copy('retired')}</p>}
    {stale&&<div role="status"><p>{copy('stale')}</p><button type="button" disabled={blocked} onClick={()=>api.rebase(current)}>{copy('rebase')}</button></div>}
    {['draft','returned'].includes(current.state)&&<div className={css.actions}>
     <button type="button" disabled={!editing&&(roleStale||currentPending)} onClick={()=>{setEditing(v=>!v);setConfirmed(false)}}>{copy(editing?'close':'edit')}</button>
     {editing&&<button type="button" disabled={blocked||stale||roleStale||!body.trim()} onClick={()=>void act(()=>api.revise(current,body),copy('saved'))}>{copy('save')}</button>}
     <button type="button" disabled={blocked||roleStale} onClick={()=>{setReturning(v=>!v);setConfirmed(false)}}>{copy('return')}</button>
    </div>}
    {returning&&<div className={css.returning}><label>{copy('reason')}<textarea maxLength={2000} value={reason} onChange={event=>setReason(event.target.value)}/></label><button type="button" disabled={blocked||!reason.trim()||roleStale} onClick={()=>void act(()=>api.return(current,reason))}>{copy('return')}</button></div>}
    {current.state==='draft'&&current.source.kind!=='provided'&&<div className={css.adopt}><label><input type="checkbox" checked={confirmed} disabled={blocked||dirty||stale||roleStale} onChange={event=>setConfirmed(event.target.checked)}/>{copy(current.source.kind==='group'?'confirmGroup':'confirmConversation')}</label><button className={css.primary} type="button" disabled={blocked||!confirmed||dirty||stale||roleStale} onClick={()=>void act(()=>api.adopt(current))}>{copy(current.source.kind==='group'?'send':'prepare')}</button></div>}
    {current.source.kind==='conversation'&&(current.state==='prepared'||current.state==='draft')&&<button type="button" disabled={busy||!port.openConversationDraft} onClick={()=>{setError('');void port.openConversationDraft?.(current.source.kind==='conversation'?current.source.sessionId:'',current.body).catch(error=>{if(live.current===origin)setError(openError(error))})}}>{copy('open')}</button>}
    {current.source.kind==='provided'&&<p className={css.muted}>{copy('manual')}</p>}
    <button type="button" onClick={()=>{void navigator.clipboard.writeText(current.body).then(()=>{if(live.current===origin)setNotice(copy('copied'))},error=>setError(localizeWorkError(locale,error)))}}>{copy('copy')}</button>
   </article>}
  </div>}
 </section>
}
