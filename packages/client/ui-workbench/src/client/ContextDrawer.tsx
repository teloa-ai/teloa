import {useEffect,useId,useRef,type ReactNode,type RefObject} from 'react'
import {X} from 'lucide-react'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {useI18n} from './i18n/provider.js'
import css from './ContextDrawer.module.css'

/** 当前对象的轻详情默认采用 1.0 样板（宽 ≤480、头部 52px、标题 15/600）。复杂阅读面显式选择大视图；关闭仅恢复入口焦点。 */
export function ContextDrawer({open=true,title,close,children,className,initialFocus,canClose=true,padded=false,compact=true,titleHidden=false}:{open?:boolean;title:string;close:()=>void;children:ReactNode;className?:string;initialFocus?:RefObject<HTMLElement>;canClose?:boolean;padded?:boolean;compact?:boolean;titleHidden?:boolean}){
 const dialog=useRef<HTMLDialogElement>(null),id=useId(),{t}=useI18n(),dismissEvents=useDialogDismiss(close,canClose)
 useEffect(()=>{if(open)return openDialog(dialog.current,initialFocus?.current)},[open])
 return <dialog ref={dialog} className={[css.drawer,compact?css.compact:undefined,className].filter(Boolean).join(' ')} aria-labelledby={id}
  {...dismissEvents}>
  <header className={[css.header,titleHidden?css.identityHeader:undefined].filter(Boolean).join(' ')}><>{titleHidden?<span id={id} data-drawer-label>{title}</span>:<h2 id={id}>{title}</h2>}</><button type="button" aria-label={t('market.common.close')} disabled={!canClose} onClick={close}><X size={20}/></button></header>
  <div className={[css.content,padded?css.padded:undefined].filter(Boolean).join(' ')}>{children}</div>
 </dialog>
}
