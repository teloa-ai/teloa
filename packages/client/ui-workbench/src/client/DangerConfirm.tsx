import {useEffect,useId,useRef,useState,type ReactNode} from 'react'
import {LoaderCircle,type LucideIcon} from 'lucide-react'
import clsx from 'clsx'
import {openDialog} from './dialog-focus.js'
import {useDialogDismiss} from './use-dialog-dismiss.js'
import {useI18n} from './i18n/provider.js'
import base from './dialog-base.module.css'
import css from './DangerConfirm.module.css'

/** 影响清单的一行：数字必须来自真实数据；拿不到数字时写「其下所有…」之类的如实表述，不估算。 */
export type DangerImpact={icon?:LucideIcon|undefined;text:string}

/**
 * 危险确认（B8，对标报告第 4 节）按爆炸半径与可逆性分级：
 * - L1 可撤销（归档、移出列表）：不用本组件，直接执行并给 toast「撤销」。
 * - L2 不可逆、单个对象：不传 confirmName，标题 + 一句后果 +「取消」与红色终按钮。
 * - L3 不可逆、影响多人或整个容器：传 confirmName，列出真实影响，输入对象名称后红色终按钮才可用。
 * 红色只用于最终执行按钮；默认焦点落在输入框（L3）或「取消」（L2），回车不直接执行。
 */
export function DangerConfirm({title,intro,impacts=[],note,confirmName,confirmLabel,busy=false,ready=true,error,children,confirm,close}:{
 title:string
 intro?:string|undefined
 impacts?:readonly DangerImpact[]
 /** 不可逆说明等收尾一句。 */
 note?:string|undefined
 /** L3：要求输入的对象名称；不传即 L2。 */
 confirmName?:string|undefined
 confirmLabel:string
 busy?:boolean
 /** 附加字段（如原因）是否已填好。 */
 ready?:boolean
 error?:string|undefined
 children?:ReactNode
 confirm:()=>void
 close:()=>void
}){
 const {t}=useI18n(),heading=useId(),description=useId(),inputId=useId()
 const ref=useRef<HTMLDialogElement>(null),body=useRef<HTMLDivElement>(null),cancel=useRef<HTMLButtonElement>(null)
 const [typed,setTyped]=useState('')
 const matched=confirmName===undefined||typed.trim()===confirmName.trim()
 const disabled=busy||!ready||!matched
 useEffect(()=>openDialog(ref.current,confirmName!==undefined?body.current?.querySelector<HTMLElement>('textarea,input'):cancel.current),[])
 const dismiss=useDialogDismiss(close,!busy)
 return <dialog ref={ref} className={clsx(base.dialog,css.dialog)} aria-labelledby={heading} aria-describedby={description} aria-busy={busy} {...dismiss}>
  <div ref={body} className={css.body}>
   <h2 id={heading} className={css.title}>{title}</h2>
   <div id={description}>
    {intro&&<p className={css.intro}>{intro}</p>}
    {impacts.length>0&&<ul className={css.impacts}>{impacts.map(({icon:Icon,text})=><li key={text}>{Icon&&<Icon size={14} aria-hidden="true"/>}<span>{text}</span></li>)}</ul>}
    {note&&<p className={css.note}>{note}</p>}
   </div>
   {children}
   {confirmName!==undefined&&<div className={css.field}><label htmlFor={inputId}>{t('dangerConfirm.typeName',{name:confirmName})}</label><input id={inputId} value={typed} placeholder={confirmName} autoComplete="off" spellCheck={false} disabled={busy} onChange={event=>setTyped(event.target.value)} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault()}}/></div>}
   {error&&<p className={css.error} role="alert">{error}</p>}
  </div>
  <footer className={css.footer}>
   <button ref={cancel} type="button" className={css.cancel} disabled={busy} onClick={close}>{t('dangerConfirm.cancel')}</button>
   <button type="button" className={css.danger} disabled={disabled} onClick={()=>{if(!disabled)confirm()}}>{busy&&<LoaderCircle size={14} className={css.spinner} aria-hidden="true"/>}{confirmLabel}</button>
  </footer>
 </dialog>
}
