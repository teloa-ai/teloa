import { useEffect,useRef,useState,useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import type { ConversationManagement } from './conversation-management.js'
import { openDialog } from './dialog-focus.js'
import { localizeWorkError } from './i18n/errors.js'
import { useI18n } from './i18n/provider.js'
import css from './AdoptConversationDialog.module.css'

type Candidate={id:string;title:string;workspace:string}
/** 只展示原生摘要，由本人明确选择后建立工作绑定，不读取历史正文。 */
export function AdoptConversationDialog({management,candidates,available,close}:{management:ConversationManagement;candidates:readonly Candidate[];available:boolean;close:()=>void}){
  const {locale,t}=useI18n()
  const state=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const dialog=useRef<HTMLDialogElement>(null),search=useRef<HTMLInputElement>(null),pending=useRef(false)
  const [query,setQuery]=useState(''),[selected,setSelected]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
  useEffect(()=>openDialog(dialog.current,search.current),[])
  const target=candidates.find(row=>row.id===selected),needle=query.trim().toLocaleLowerCase()
  const rows=candidates.filter(row=>[row.title,row.workspace,row.id].some(value=>value.toLocaleLowerCase().includes(needle)))
  const done=()=>{if(!pending.current)close()}
  const submit=async()=>{
    if(pending.current||!target||!available||!state.ready)return
    pending.current=true;setBusy(true);setError(undefined);setNotice(undefined)
    try{await management.adopt(target.id,t('adoptDialog.fallbackTitle'));setSelected('');setNotice(t('adoptDialog.success',{title:target.title}))}
    catch(error){setError(localizeWorkError(locale,error))}
    finally{pending.current=false;setBusy(false)}
  }
  return <dialog ref={dialog} className={css.dialog} aria-label={t('adoptDialog.title')} onCancel={event=>{event.preventDefault();done()}}>
    <header><h2>{t('adoptDialog.title')}</h2><button type="button" aria-label={t('adoptDialog.closeAria')} disabled={busy} onClick={done}><X size={18}/></button></header>
    <p>{t('adoptDialog.description')}</p>
    <label>{t('adoptDialog.search')}<input ref={search} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('adoptDialog.placeholder')}/></label>
    {!available||!state.ready?<p role="status">{t('adoptDialog.waiting')}</p>:<div className={css.list} role="group" aria-label={t('adoptDialog.available')}>
      {rows.length===0?<p>{t(needle?'adoptDialog.noMatches':'adoptDialog.noneAvailable')}</p>:rows.map(row=><label className={css.row} key={row.id}><input type="radio" name="teloa-adopt-session" value={row.id} checked={selected===row.id} disabled={busy} onChange={()=>{setSelected(row.id);setError(undefined);setNotice(undefined)}}/><span><strong>{row.title}</strong><small>{row.workspace}</small><small>{row.id}</small></span></label>)}
    </div>}
    {selected&&!target&&!busy&&<p role="alert">{t('adoptDialog.changed')}</p>}
    {target&&<p>{t('adoptDialog.selected',{title:target.title})}</p>}
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
    <footer><button type="button" disabled={busy} onClick={done}>{t('adoptDialog.close')}</button><button type="button" disabled={busy||!target||!available||!state.ready} onClick={()=>void submit()}>{t(busy?'adoptDialog.adopting':'adoptDialog.adopt')}</button></footer>
  </dialog>
}
