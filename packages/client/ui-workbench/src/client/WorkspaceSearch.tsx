import {useEffect,useRef,useState} from 'react'
import clsx from 'clsx'
import {ArrowUpRight,Search,X} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import {searchWorkspace,workspaceSearchKinds,type WorkspaceSearchSource,type WorkspaceSearchResult} from './workspace-search.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import base from './TaskPage.module.css'
import css from './WorkspaceSearch.module.css'

export function WorkspaceSearch({visible,source,conversationStatus,knowledgeStatus,capabilityStatus,close,open,searchMessages}:{visible:boolean;source:WorkspaceSearchSource;conversationStatus:string;knowledgeStatus:string;capabilityStatus:string;close:()=>void;open:(row:WorkspaceSearchResult)=>Promise<void>;searchMessages:()=>void}){
 const {locale,t}=useI18n()
 const [query,setQuery]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 const dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),pending=useRef(false)
 useEffect(()=>{if(visible)return openDialog(dialog.current,input.current)},[visible])
 const trimmedQuery=query.trim()
 const visibleResults=searchWorkspace(source,query)
 const choose=async(row:WorkspaceSearchResult)=>{
  if(pending.current)return
  pending.current=true;setBusy(true);setError('')
  try{await open(row);close()}catch(caught){setError(localizeWorkError(locale,caught))}finally{pending.current=false;setBusy(false)}
 }
 if(!visible)return null
 // 点在卡片外面（真正的 backdrop，含 dialog 自身的内边距区域按仍是卡片处理）才关闭；用几何范围判断，而不是 target===dialog——
 // 后者会把卡片内边距也算作「外面」，点在卡片留白处会被误关。
 const closeFromBackdrop=(event:React.MouseEvent<HTMLDialogElement>)=>{
  if(busy)return
  const rect=event.currentTarget.getBoundingClientRect()
  const inside=event.clientX>=rect.left&&event.clientX<=rect.right&&event.clientY>=rect.top&&event.clientY<=rect.bottom
  if(!inside)close()
 }
 return <dialog ref={dialog} className={clsx(base.dialog,base.alignedDialog,css.dialog)} aria-label={t('workspaceSearch.title')} onCancel={event=>{if(busy)event.preventDefault();else close()}} onClick={closeFromBackdrop}>
 <header><h2>{t('workspaceSearch.title')}</h2><button className={css.close} type="button" aria-label={t('workspaceSearch.closeAria')} disabled={busy} onClick={close}><X size={20}/></button></header>
 <div className={css.body}>
  <label className={css.search}><Search size={19}/><input ref={input} aria-label={t('workspaceSearch.inputAria')} value={query} onChange={event=>{setQuery(event.target.value);setError('')}} placeholder={t('workspaceSearch.placeholder')}/></label>
  {conversationStatus&&<p role="status" className={css.note}>{conversationStatus}</p>}
  {knowledgeStatus&&<p role="status" className={css.note}>{knowledgeStatus}</p>}
  {capabilityStatus&&<p role="status" className={css.note}>{capabilityStatus}</p>}
  {error&&<p role="alert">{error}</p>}
  <div className={css.results}>
   {visibleResults.length===0&&<div className={css.empty}><h3>{t('workspaceSearch.emptyTitle')}</h3><p>{t('workspaceSearch.emptyDescription')}</p></div>}
   {visibleResults.map(row=><button type="button" key={row.key} disabled={busy} onClick={()=>void choose(row)}><div><strong>{row.title}</strong><span>{t(workspaceSearchKinds[row.kind])} · {t(row.detailKey)}</span></div><ArrowUpRight size={14}/></button>)}
   {trimmedQuery!==''&&<button type="button" disabled={busy} onClick={()=>{close();searchMessages()}}><div><strong>{t('workspaceSearch.searchMessagesTitle',{query:trimmedQuery})}</strong><span>{t('workspaceSearch.detail.messages')}</span></div><ArrowUpRight size={14}/></button>}
  </div>
 </div>
 </dialog>
}
