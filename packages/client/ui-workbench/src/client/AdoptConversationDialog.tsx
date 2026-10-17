import { useEffect,useRef,useState,useSyncExternalStore } from 'react'
import { ChevronRight, LoaderCircle, MessageSquare, Search, X } from 'lucide-react'
import type { ConversationManagement } from './conversation-management.js'
import { openDialog } from './dialog-focus.js'
import { localizeWorkError } from './i18n/errors.js'
import { useI18n } from './i18n/provider.js'
import { useDialogDismiss } from './use-dialog-dismiss.js'
import css from './AdoptConversationDialog.module.css'

type Candidate={id:string;title:string;workspace:string}
/** 只展示原生摘要，由本人明确选择后建立工作绑定，不读取历史正文。 */
export function AdoptConversationDialog({management,candidates,available,close}:{management:ConversationManagement;candidates:readonly Candidate[];available:boolean;close:()=>void}){
  const {locale,t}=useI18n()
  const state=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const dialog=useRef<HTMLDialogElement>(null),search=useRef<HTMLInputElement>(null),pending=useRef(false),active=useRef(false)
  const [query,setQuery]=useState(''),[busy,setBusy]=useState<string>(),[error,setError]=useState<string>()
  useEffect(()=>{active.current=true;const release=openDialog(dialog.current,search.current);return()=>{active.current=false;release()}},[])
  const needle=query.trim().toLocaleLowerCase()
  const rows=candidates.filter(row=>[row.title,row.workspace,row.id].some(value=>value.toLocaleLowerCase().includes(needle)))
  const dismissEvents=useDialogDismiss(close)
  const submit=async(target:Candidate)=>{
    if(pending.current||!available||!state.ready||state.pending[target.id])return
    pending.current=true;setBusy(target.id);setError(undefined)
    try{await management.adopt(target.id,t('adoptDialog.fallbackTitle'));if(active.current)close()}
    catch(error){if(active.current)setError(localizeWorkError(locale,error))}
    finally{pending.current=false;if(active.current)setBusy(undefined)}
  }
  return <dialog ref={dialog} className={css.dialog} aria-label={t('adoptDialog.title')} {...dismissEvents}>
    <header><h2>{t('adoptDialog.title')}</h2><button type="button" aria-label={t('adoptDialog.closeAria')} onClick={close}><X size={18}/></button></header>
    <label className={css.search}><Search size={16} aria-hidden/><input ref={search} aria-label={t('adoptDialog.search')} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('adoptDialog.placeholder')}/></label>
    {!available||!state.ready?<p role="status">{t('adoptDialog.waiting')}</p>:<div className={css.list} role="group" aria-label={t('adoptDialog.available')}>
      {rows.length===0?<p>{t(needle?'adoptDialog.noMatches':'adoptDialog.noneAvailable')}</p>:rows.map(row=><button type="button" className={css.row} key={row.id} disabled={!!busy||!!state.pending[row.id]} aria-busy={busy===row.id||undefined} onClick={()=>void submit(row)}><MessageSquare size={18} aria-hidden/><span><strong>{row.title}</strong><small>{row.workspace}</small></span>{busy===row.id?<LoaderCircle className={css.loading} size={16} aria-label={t('adoptDialog.adopting')}/>:<ChevronRight className={css.open} size={16} aria-hidden/>}</button>)}
    </div>}
    {error&&<p role="alert">{error}</p>}
  </dialog>
}
