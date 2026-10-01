import { useEffect,useRef,useState,useSyncExternalStore } from 'react'
import { Folder,X } from 'lucide-react'
import type { ConversationManagement } from './conversation-management.js'
import { openDialog } from './dialog-focus.js'
import { localizeWorkError } from './i18n/errors.js'
import { useI18n } from './i18n/provider.js'
import css from './CreateConversationDialog.module.css'

type Props={management:ConversationManagement;current:string|undefined;initialWorkspaceId:string|undefined;pendingRequestId:string|undefined;restart:(requestId:string)=>void;locked:boolean;busy:boolean;goal:string|undefined;notice?:string|undefined;initialError?:string|undefined;mode?:'create'|'chooseWorkspace';create:(workspaceId?:string)=>Promise<void>;close:()=>void;settings:()=>void}

/** 选择原生登记身份，不把执行位置显示名或任意路径作为创建参数。`mode==='chooseWorkspace'` 对应左栏「更换执行位置」入口，标题、说明与主按钮换成对应文案；常规新建路径不受影响。 */
export function CreateConversationDialog({management,current,initialWorkspaceId,pendingRequestId,restart,locked,busy,goal,notice,initialError,mode='create',create,close,settings}:Props){
  const {locale,t}=useI18n()
  const changingLocation=mode==='chooseWorkspace'
  const native=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const [selected,setSelected]=useState(initialWorkspaceId??''),[error,setError]=useState<string|undefined>(initialError)
  const dialog=useRef<HTMLDialogElement>(null),select=useRef<HTMLSelectElement>(null),pending=useRef(false)
  const initialized=useRef(initialWorkspaceId!==undefined),focusAfterUnlock=useRef(false)
  useEffect(()=>{if(!locked&&focusAfterUnlock.current){focusAfterUnlock.current=false;select.current?.focus()}},[locked])
  const defaultRecovery=locked&&initialWorkspaceId===undefined
  useEffect(()=>openDialog(dialog.current,select.current),[])
  useEffect(()=>{
    if(initialized.current||!native.ready||defaultRecovery)return
    const preferred=native.workspaces.find(row=>current&&row.sessionIds.includes(current))??native.workspaces[0]
    if(preferred){initialized.current=true;setSelected(preferred.workspaceId)}
  },[native.ready,native.workspaces,current,defaultRecovery])
  const workspace=native.workspaces.find(row=>row.workspaceId===selected)
  const startNew=()=>{
    if(pending.current||busy||!pendingRequestId)return
    try{restart(pendingRequestId);initialized.current=true;focusAfterUnlock.current=true;setSelected('');setError(undefined)}
    catch(error){setError(localizeWorkError(locale,error))}
  }
  const submit=async()=>{
    if(pending.current||!native.ready||!defaultRecovery&&(!selected||!workspace&&!locked))return
    pending.current=true;setError(undefined)
    try{await create(defaultRecovery?undefined:selected)}catch(error){setError(localizeWorkError(locale,error))}
    finally{pending.current=false}
  }
  const titleKey=changingLocation?'conversationDialog.changeLocationTitle':'conversationDialog.title'
  return <dialog ref={dialog} className={css.dialog} aria-label={t(titleKey)} onCancel={event=>{event.preventDefault();if(!busy&&!pending.current)close()}}>
    <form onSubmit={event=>{event.preventDefault();void submit()}}>
      <header><div><h2>{t(titleKey)}</h2><p>{t(changingLocation?'conversationDialog.changeLocationDescription':'conversationDialog.description')}</p></div><button type="button" className={css.icon} aria-label={t('conversationDialog.close')} disabled={busy} onClick={close}><X size={18}/></button></header>
      {notice&&<p role="status">{notice}</p>}
      {goal&&<div className={css.goal}><strong>{t('conversationDialog.goal')}</strong><p>{goal}</p></div>}
      <label htmlFor="teloa-create-workspace">{t('conversationDialog.workspace')}</label>
      <select id="teloa-create-workspace" ref={select} value={defaultRecovery?'__original__':selected} aria-describedby={workspace&&!defaultRecovery?'teloa-create-workspace-path':undefined} disabled={busy||locked||!native.ready} onChange={event=>{initialized.current=true;setSelected(event.target.value);setError(undefined)}}>
        {defaultRecovery&&<option value="__original__">{t('conversationDialog.recoverOriginal')}</option>}
        {!selected&&<option value="">{t(native.ready?'conversationDialog.select':'conversationDialog.loading')}</option>}
        {selected&&!workspace&&<option value={selected}>{t('conversationDialog.unavailable')}</option>}
        {native.workspaces.map(row=><option key={row.workspaceId} value={row.workspaceId}>{row.title}</option>)}
      </select>
      {workspace&&!defaultRecovery&&<div id="teloa-create-workspace-path" className={css.path}><Folder size={16}/><span><strong>{workspace.title}</strong><small>{t('conversationDialog.path')} · {workspace.path}</small></span></div>}
      {!native.ready&&<p role="status">{t('conversationDialog.waiting')}</p>}
      {native.ready&&native.workspaces.length===0&&<p>{t('conversationDialog.empty')}</p>}
      {selected&&!workspace&&native.ready&&!defaultRecovery&&<p role="alert">{t('conversationDialog.removed')}</p>}
      {locked&&!busy&&<div><p>{t('conversationDialog.locked')}</p><button type="button" onClick={startNew}>{t('conversationDialog.startNew')}</button></div>}
      {error&&<p role="alert" className={css.error}>{error}</p>}
      <footer><button type="button" disabled={busy||locked} onClick={settings}>{t('conversationDialog.manage')}</button><span/><button type="button" disabled={busy} onClick={close}>{t('conversationDialog.cancel')}</button><button type="submit" className={css.primary} disabled={busy||!native.ready||!defaultRecovery&&(!selected||!workspace&&!locked)}>{t(busy?'conversationDialog.creating':locked?'conversationDialog.retry':changingLocation?'conversationDialog.useLocation':'conversationDialog.create')}</button></footer>
    </form>
  </dialog>
}
