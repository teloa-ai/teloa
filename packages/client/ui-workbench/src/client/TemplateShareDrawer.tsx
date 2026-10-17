import {useEffect,useRef,useId,type ReactNode} from 'react'
import {X} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import {useI18n} from './i18n/provider.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import css from './TemplateShareDrawer.module.css'
export function TemplateShareDrawer({open,title,close,children}:{open:boolean;title:string;close:()=>void;children:ReactNode}){
 const ref=useRef<HTMLDialogElement>(null),{t}=useI18n(),id=useId()
 const dismissEvents=useDialogDismiss(close)
 useEffect(()=>{if(open)return openDialog(ref.current)},[open])
 return <dialog ref={ref} className={css.drawer} aria-labelledby={id} {...dismissEvents}><header className={css.header}><h2 id={id}>{title}</h2><button type="button" aria-label={t('templateShare.close')} onClick={close}><X size={20}/></button></header><div className={css.body}>{children}</div></dialog>
}
