import {useEffect,useId,useRef,useState} from 'react'
import {MoreHorizontal,X} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {ComposerPopover} from './ComposerPopover.js'
import {useI18n} from './i18n/provider.js'
import {dialogueCopy,dialogueErrorCopy} from './dialogue-copy.js'
import {useLightDraft} from './light-dialog-drafts.js'
import type {DialogueEntry,DialogueOrganization} from './dialogue-organization.js'
import base from './dialog-base.module.css'
import css from './ConversationActions.module.css'

export function DialogueNameDialog({title,value,hint,allowEmpty=false,close,save}:{title:string;value:string;hint?:string;allowEmpty?:boolean;close:(draft?:string)=>void;save:(name:string)=>void}){
 const {t,locale}=useI18n(),dialog=useRef<HTMLDialogElement>(null),input=useRef<HTMLInputElement>(null),id=useId(),[draft,setDraft]=useState(value),[error,setError]=useState('')
 const dismiss=()=>close(draft),dismissEvents=useDialogDismiss(dismiss)
 useEffect(()=>openDialog(dialog.current,input.current),[])
 return <dialog ref={dialog} className={base.dialog+' '+css.dialog} aria-labelledby={id} {...dismissEvents}><div className={css.content}>
  <header className={css.header}><h2 id={id}>{title}</h2><button type="button" className={css.close} aria-label={t('market.common.close')} onClick={dismiss}><X size={18}/></button></header>
  <form onSubmit={event=>{event.preventDefault();try{save(draft);close()}catch(cause){setError(dialogueErrorCopy(locale,cause))}}}>
   <label className={css.field}>{dialogueCopy(locale,'name')}<input ref={input} value={draft} maxLength={80} required={!allowEmpty} onChange={event=>{setDraft(event.target.value);setError('')}}/></label>
   {hint&&<p className={css.description}>{hint}</p>}{error&&<p role="alert" className={css.error}>{error}</p>}
   <footer className={css.footer}><button type="button" onClick={dismiss}>{t('market.common.cancel')}</button><button type="submit" className={css.primary}>{dialogueCopy(locale,'save')}</button></footer>
  </form>
 </div></dialog>
}
export function DialogueFolderMoveDialog({entry,title,organization,close}:{entry:DialogueEntry;title:string;organization:DialogueOrganization;close:()=>void}){
 const {locale,t}=useI18n(),dialog=useRef<HTMLDialogElement>(null),select=useRef<HTMLSelectElement>(null),id=useId(),state=organization.getSnapshot()
 const [folder,setFolder,clearFolder]=useLightDraft('dialogue-move:'+JSON.stringify([entry.kind,entry.id]),()=>state.placements[JSON.stringify([entry.kind,entry.id])]??''),[error,setError]=useState(''),dismissEvents=useDialogDismiss(close)
 useEffect(()=>openDialog(dialog.current,select.current),[])
 return <dialog ref={dialog} className={base.dialog+' '+css.dialog} aria-labelledby={id} {...dismissEvents}><div className={css.content}>
  <header className={css.header}><h2 id={id}>{dialogueCopy(locale,'move')}</h2><button type="button" className={css.close} aria-label={t('market.common.close')} onClick={close}><X size={18}/></button></header><p className={css.subject}>{title}</p>
  <form onSubmit={event=>{event.preventDefault();try{organization.move(entry,folder||null);clearFolder();close()}catch(cause){setError(dialogueErrorCopy(locale,cause))}}}><label className={css.field}>{dialogueCopy(locale,'folders')}<select ref={select} value={folder} onChange={event=>setFolder(event.target.value)}><option value="">{dialogueCopy(locale,'unfiled')}</option>{state.folders.map(row=><option key={row.id} value={row.id}>{row.name}</option>)}</select></label>{error&&<p role="alert" className={css.error}>{error}</p>}<footer className={css.footer}><button type="button" onClick={close}>{t('market.common.cancel')}</button><button type="submit" className={css.primary}>{dialogueCopy(locale,'save')}</button></footer></form>
 </div></dialog>
}
export function DialogueFolderAction({title,className,onMove,kind='session'}:{title:string;className?:string|undefined;onMove:()=>void;kind?:'session'|'group'}){
 const {locale,t}=useI18n(),anchor=useRef<HTMLButtonElement>(null),[open,setOpen]=useState(false),id=useId()
 return <><button type="button" ref={anchor} className={className} aria-label={kind==='group'?t('group.directory.manage',{name:title}):t('workDirectory.action.manageAria',{title})} aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={16}/></button>{open&&<ComposerPopover anchor={anchor} id={id} role="menu" label={title} width={220} close={()=>setOpen(false)}><button type="button" role="menuitem" className={css.menuItem} onClick={()=>{anchor.current?.focus();setOpen(false);onMove()}}>{dialogueCopy(locale,'move')}</button></ComposerPopover>}</>
}
