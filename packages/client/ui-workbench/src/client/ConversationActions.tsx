import {useEffect,useId,useRef,useState,useSyncExternalStore} from 'react'
import {Archive,Check,Copy,History,LoaderCircle,MoreHorizontal,Pencil,RefreshCw,X} from 'lucide-react'
import type {Conversation} from '@teloa/contract'
import type {ConversationManagement} from './conversation-management.js'
import {ComposerPopover} from './ComposerPopover.js'
import {openDialog} from './dialog-focus.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ConversationActions.module.css'

export type ConversationAction='rename'|'copy'|'archive'
export type ConversationActionTarget={row:Conversation;title:string;blank:boolean;action:ConversationAction}
const actionKeys={rename:'workDirectory.rename.title',copy:'workDirectory.copy.title',archive:'workDirectory.archive.title'} as const

export function ConversationActionMenu({title,disabled,className,choose}:{title:string;disabled:boolean;className?:string|undefined;choose:(action:ConversationAction)=>void}){
 const {t}=useI18n(),anchor=useRef<HTMLButtonElement>(null),id=useId()
 const [opened,setOpened]=useState(false)
 const select=(action:ConversationAction)=>{anchor.current?.focus({preventScroll:true});setOpened(false);choose(action)}
 return <>
  <button ref={anchor} type="button" className={className} aria-label={t('workDirectory.action.manageAria',{title})} aria-haspopup="menu" aria-expanded={opened&&!disabled} aria-controls={opened&&!disabled?id:undefined} disabled={disabled} onClick={()=>setOpened(!opened)}><MoreHorizontal size={16}/></button>
  {opened&&!disabled&&<ComposerPopover anchor={anchor} id={id} label={t('workDirectory.management.aria',{title})} role="menu" width={220} close={()=>setOpened(false)}>
   <button className={css.menuItem} type="button" role="menuitem" onClick={()=>select('rename')}><Pencil size={16}/><span>{t(actionKeys.rename)}</span></button>
   <button className={css.menuItem} type="button" role="menuitem" onClick={()=>select('copy')}><Copy size={16}/><span>{t(actionKeys.copy)}</span></button>
   <div role="separator" className={css.separator}/>
   <button className={css.menuItem} type="button" role="menuitem" onClick={()=>select('archive')}><Archive size={16}/><span>{t(actionKeys.archive)}</span></button>
  </ComposerPopover>}
 </>
}

export function ConversationActions({target,candidates,management,title,changeTitle,close,open,running=false}:{target:ConversationActionTarget;candidates:readonly {id:string;title:string}[];management:ConversationManagement;title:string;changeTitle:(value:string)=>void;close:()=>void;open:(row:Conversation,signal:AbortSignal)=>Promise<void>;running?:boolean}){
 const {t,locale,dateTime}=useI18n(),heading=useId(),description=useId()
 const ref=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),cancel=useRef<HTMLButtonElement>(null)
 const state=useSyncExternalStore(management.subscribe,management.getSnapshot)
 const [error,setError]=useState<string>(),[notice,setNotice]=useState<string>(),[copy,setCopy]=useState<Conversation>()
 const [historyReady,setHistoryReady]=useState(false),[historyError,setHistoryError]=useState<string>(),[historyOpen,setHistoryOpen]=useState(false)
 const [choices,setChoices]=useState<Record<string,string>>({}),[allowIndependent,setAllowIndependent]=useState<Record<string,boolean>>({})
 const operation=useRef(false),[working,setWorking]=useState(false),opening=useRef<AbortController>(),historyGeneration=useRef(0)
 const backdropStart=useRef(false)
 const id=target.row.sessionId,busy=working||!!state.pending[id],archived=state.archived.includes(id),action=target.action
 const attempts=state.copyHistory.filter(row=>row.sourceSessionId===id),uncertain=state.uncertain.includes(id)
 const canRename=!busy&&state.ready&&!!title.trim()&&title.trim()!==target.title.trim()
 const canCopy=!busy&&state.ready&&historyReady&&!target.blank&&!uncertain
 useEffect(()=>openDialog(ref.current,action==='rename'?input.current:cancel.current),[])
 useEffect(()=>()=>{opening.current?.abort();historyGeneration.current++},[])
 const refreshHistory=async()=>{
  const generation=++historyGeneration.current
  setHistoryReady(false);setHistoryError(undefined)
  try{await management.refreshCopyHistory();if(generation===historyGeneration.current)setHistoryReady(true)}
  catch(error){if(generation===historyGeneration.current)setHistoryError(localizeWorkError(locale,error))}
 }
 useEffect(()=>{if(action==='copy')void refreshHistory()},[])
 useEffect(()=>{if(uncertain)setHistoryOpen(true)},[uncertain])
 const done=()=>{if(operation.current||busy)return;if(copy)management.acknowledgeCopy(id,copy.sessionId);close()}
 const perform=async(run:()=>Promise<void>)=>{
  if(operation.current||busy||!state.ready||archived)return
  operation.current=true;setWorking(true);setError(undefined);setNotice(undefined)
  try{await run()}catch(error){setError(localizeWorkError(locale,error))}finally{operation.current=false;setWorking(false)}
 }
 const cancelButton=<button ref={cancel} type="button" disabled={busy} onClick={done}>{t('workDirectory.action.cancel')}</button>
 return <dialog ref={ref} className={css.dialog} aria-labelledby={heading} aria-describedby={action==='rename'?undefined:description} aria-busy={busy} onCancel={event=>{event.preventDefault();done()}} onPointerDown={event=>{backdropStart.current=event.target===event.currentTarget}} onClick={event=>{if(backdropStart.current&&event.target===event.currentTarget)done();backdropStart.current=false}}>
  <div className={css.content}>
   <header className={css.header}><h2 id={heading}>{t(actionKeys[action])}</h2><button className={css.close} type="button" aria-label={t('workDirectory.management.close')} disabled={busy} onClick={done}><X size={18}/></button></header>
   {action!=='rename'&&<p className={css.subject} title={target.title}>{target.title}</p>}
   {error&&<p className={css.error} role="alert">{error}</p>}{notice&&<p className={css.notice} role="status">{notice}</p>}
   {archived?<><p role="status">{t('workDirectory.management.archived')}</p><footer className={css.footer}>{cancelButton}</footer></>:action==='rename'?
    <form onSubmit={event=>{event.preventDefault();if(canRename)void perform(async()=>{await management.rename(id,title.trim());changeTitle(title.trim());close()})}}>
     <label className={css.field}>{t('workDirectory.rename.label')}<input ref={input} value={title} maxLength={200} disabled={busy} onChange={event=>changeTitle(event.target.value)} required/></label>
     <footer className={css.footer}>{cancelButton}<button className={css.primary} type="submit" disabled={!canRename}>{busy&&<LoaderCircle size={15} className={css.spinner}/>}<span>{t('workDirectory.rename.save')}</span></button></footer>
    </form>:action==='archive'?<>
     <p id={description} className={css.description}>{t('workDirectory.archive.explanation')}</p>
     <p className={css.warning}>{t('workDirectory.archive.noRestore')}</p>
     {running&&<p role="status" className={css.description}>{t('workDirectory.archive.running')}</p>}
     <footer className={css.footer}>{cancelButton}<button className={css.primary} type="button" disabled={busy||!state.ready||running} onClick={()=>{if(!running)void perform(async()=>{await management.archive(id);close()})}}>{busy&&<LoaderCircle size={15} className={css.spinner}/>}<span>{t('workDirectory.archive.action')}</span></button></footer>
    </>:<>
     <p id={description} className={css.description}>{t('workDirectory.copy.description')}</p>
     {target.blank&&<p className={css.description}>{t('workDirectory.copy.blank')}</p>}
     {!historyReady&&!historyError&&<p role="status" className={css.inlineStatus}><LoaderCircle size={14} className={css.spinner}/>{t('workDirectory.copy.checking')}</p>}
     {historyError&&<div className={css.historyError}><p role="alert">{historyError}</p><button type="button" disabled={busy||!state.ready} onClick={()=>void refreshHistory()}><RefreshCw size={14}/>{t('workDirectory.copy.refresh')}</button></div>}
     {copy&&<p role="status" className={css.inlineStatus}><Check size={16}/>{t('workDirectory.copy.created')}</p>}
     {attempts.length>0&&<details className={css.history} open={historyOpen} onToggle={event=>setHistoryOpen(event.currentTarget.open)}>
      <summary><History size={15}/>{t('workDirectory.copy.history')}<span>{attempts.length}</span></summary>
      <div className={css.historyTools}><button type="button" disabled={busy||!state.ready||!historyReady&&!historyError} onClick={()=>void refreshHistory()}><RefreshCw size={14}/>{t('workDirectory.copy.refresh')}</button></div>
      {attempts.map(attempt=><div className={css.copyAttempt} key={attempt.requestId}>
       <p className={css.attemptHeading}>{t(attempt.state==='pending'?(attempt.releasedAt?'workDirectory.copy.state.released':'workDirectory.copy.state.pending'):attempt.state==='ready'?'workDirectory.copy.state.ready':'workDirectory.copy.state.rejected')}<time dateTime={attempt.createdAt}>{dateTime(attempt.createdAt)}</time></p>
       {attempt.state==='ready'&&attempt.childSessionId?<><small>{attempt.childSessionId}</small><button disabled={busy||!state.ready} onClick={()=>void perform(async()=>{setCopy(await management.recoverCopy(id,attempt.requestId,attempt.childSessionId!))})}>{t('workDirectory.copy.continue')}</button></>:attempt.state==='pending'?<>
        <p>{t(attempt.releasedAt?'workDirectory.copy.releasedDescription':'workDirectory.copy.pendingDescription')} {t('workDirectory.copy.noAutoMatch')}</p>
        {attempt.childSessionId&&<p>{t('workDirectory.copy.knownIdentity',{id:attempt.childSessionId})}</p>}
        <label className={css.field}>{t('workDirectory.copy.existingLabel')}<select value={choices[attempt.requestId]??''} disabled={busy} onChange={event=>setChoices(previous=>({...previous,[attempt.requestId]:event.target.value}))}><option value="">{t('workDirectory.copy.choose')}</option>{candidates.filter(row=>!attempt.childSessionId||row.id===attempt.childSessionId).map(row=><option key={row.id} value={row.id}>{row.title} · {row.id}</option>)}</select></label>
        <button disabled={busy||!state.ready||!choices[attempt.requestId]} onClick={()=>void perform(async()=>{setCopy(await management.recoverCopy(id,attempt.requestId,choices[attempt.requestId]!))})}>{t('workDirectory.copy.confirm')}</button>
        {!attempt.releasedAt&&<div className={css.independent}><label className={css.confirm}><input type="checkbox" checked={!!allowIndependent[attempt.requestId]} disabled={busy} onChange={event=>setAllowIndependent(previous=>({...previous,[attempt.requestId]:event.target.checked}))}/>{t('workDirectory.copy.acceptDuplicate')}</label><button disabled={busy||!state.ready||!allowIndependent[attempt.requestId]} onClick={()=>void perform(async()=>{await management.releaseCopy(id,attempt.requestId);setAllowIndependent(previous=>({...previous,[attempt.requestId]:false}));setNotice(t('workDirectory.copy.releaseSaved'))})}>{t('workDirectory.copy.allowIndependent')}</button></div>}
       </>:null}
      </div>)}
     </details>}
     <footer className={css.footer}>{cancelButton}{copy?<button className={css.primary} disabled={busy||!state.ready} onClick={()=>void perform(async()=>{const controller=new AbortController();opening.current=controller;await open(copy,controller.signal);if(!controller.signal.aborted)management.acknowledgeCopy(id,copy.sessionId)})}>{busy&&<LoaderCircle size={15} className={css.spinner}/>}<span>{t('workDirectory.copy.open')}</span></button>:<button className={css.primary} disabled={!canCopy} onClick={()=>{if(canCopy)void perform(async()=>{try{setCopy(await management.fork(id))}finally{await refreshHistory()}})}}>{busy&&<LoaderCircle size={15} className={css.spinner}/>}<span>{t(state.copies[id]?'workDirectory.copy.linkExisting':attempts.some(row=>row.state==='ready'||row.releasedAt)?'workDirectory.copy.createNew':'workDirectory.copy.create')}</span></button>}</footer>
    </>}
  </div>
 </dialog>
}
