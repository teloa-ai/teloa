import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import type { CollaborationScope } from './collaboration-preview.js'
import { openDialog } from './dialog-focus.js'
import { useI18n } from './i18n/provider.js'
import css from './CreateConversationDialog.module.css'

type ScopeOption={id:CollaborationScope;label:string}
type Props={name:string;options:readonly ScopeOption[];close:()=>void;select:(scope:CollaborationScope)=>void}

/** 只有数字员工横跨多个业务范围时才出现；先消除业务语境歧义，再沿用默认执行位置。默认选中第一个范围，不留占位项。 */
export function ConversationScopeDialog({name,options,close,select}:Props){
  const {t}=useI18n()
  const [selected,setSelected]=useState<CollaborationScope>(options[0]?.id??'')
  const dialog=useRef<HTMLDialogElement>(null),control=useRef<HTMLSelectElement>(null)
  useEffect(()=>openDialog(dialog.current,control.current),[])
  return <dialog ref={dialog} className={css.dialog} aria-label={t('conversationDialog.scopeTitle')} onCancel={event=>{event.preventDefault();close()}}>
    <form onSubmit={event=>{event.preventDefault();if(selected)select(selected)}}>
      <header><div><h2>{t('conversationDialog.scopeTitle')}</h2><p>{t('conversationDialog.scopeDescription',{name})}</p></div><button type="button" className={css.icon} aria-label={t('conversationDialog.close')} onClick={close}><X size={18}/></button></header>
      <label htmlFor="teloa-create-scope">{t('conversationDialog.scope')}</label>
      <select id="teloa-create-scope" ref={control} required value={selected} onChange={event=>setSelected(event.target.value)}>
        {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
      </select>
      <footer><span/><button type="button" onClick={close}>{t('conversationDialog.cancel')}</button><button type="submit" className={css.primary} disabled={!selected}>{t('conversationDialog.startConversation')}</button></footer>
    </form>
  </dialog>
}
