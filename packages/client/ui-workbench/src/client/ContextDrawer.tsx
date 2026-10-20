import {useEffect,useId,useRef,type ReactNode,type RefObject} from 'react'
import {X} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {useI18n} from './i18n/provider.js'
import css from './ContextDrawer.module.css'

/** 当前对象的轻详情；关闭只恢复入口焦点，业务动作由内容自己明确提交。compact 为 1.0 抽屉样板（宽 ≤480、头部 52px、标题 15/600），只给轻量详情显式选用。 */
export function ContextDrawer({open=true,title,close,children,className,initialFocus,canClose=true,padded=false,compact=false}:{open?:boolean;title:string;close:()=>void;children:ReactNode;className?:string;initialFocus?:RefObject<HTMLElement>;canClose?:boolean;padded?:boolean;compact?:boolean}){
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),{t}=useI18n(),dismissEvents=useDialogDismiss(close,canClose)
 useEffect(()=>{if(open)return openDialog(dialog.current,initialFocus?.current)},[open])
 return <dialog ref={dialog} className={[css.drawer,compact?css.compact:undefined,className].filter(Boolean).join(' ')} aria-labelledby={id}
  {...dismissEvents}>
  <header className={css.header}><h2 id={id}>{title}</h2><button type="button" aria-label={t('market.common.close')} disabled={!canClose} onClick={close}><X size={20}/></button></header>
  <div className={[css.content,padded?css.padded:undefined].filter(Boolean).join(' ')}>{children}</div>
 </dialog>
}
