import type {ReactNode} from 'react'
import {Info} from 'lucide-react'
import clsx from 'clsx'
import css from './ObjectPage.module.css'

export type StatusBoxAction={label:string;onSelect:()=>void;disabled?:boolean}

/** 对象页顶部状态框：一句话说明现在卡在哪，配唯一主按钮（`data-teloa-primary`）与可选次级按钮。 */
export function StatusBox(props:{ariaLabel:string;tone:'info'|'warn'|'good'|'muted';sentence:string;hint?:string;hintLabel?:string;primary?:StatusBoxAction;secondary?:StatusBoxAction;children?:ReactNode}):JSX.Element{
 const {ariaLabel,tone,sentence,hint,hintLabel,primary,secondary,children}=props
 return <section className={clsx(css.statusBox,css[tone])} aria-label={ariaLabel} data-teloa-status-box>
  <p className={css.sentence}>{sentence}{hint&&<span className={css.hint} title={hint} aria-label={hintLabel}><Info size={13}/></span>}</p>
  {children}
  {(primary||secondary)&&<div className={css.statusActions}>
   {primary&&<button type="button" className={css.primary} data-teloa-primary disabled={primary.disabled} onClick={primary.onSelect}>{primary.label}</button>}
   {secondary&&<button type="button" className={css.secondary} disabled={secondary.disabled} onClick={secondary.onSelect}>{secondary.label}</button>}
  </div>}
 </section>
}
