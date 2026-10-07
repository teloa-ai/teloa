import {useEffect,useRef,type ReactNode} from 'react'
import clsx from 'clsx'
import {ChevronRight} from 'lucide-react'
import css from './SettingsShell.module.css'
import tokens from './theme-tokens.module.css'
import {mountSettingsSubdialogFocus} from './settings-subdialog-focus.js'

export type SettingsLayoutEntry=Readonly<{id:string;label:string}>
export type SettingsLayoutProps=Readonly<{
 label:string
 heading:ReactNode
 actions?:ReactNode
 notice?:ReactNode
 entries:readonly SettingsLayoutEntry[]
 selectedId:string|undefined
 onSelect:(id:string)=>void
 plainContent?:boolean
 children:ReactNode
}>

/** 设置的唯一呈现壳；目录、内容与动作由宿主提供，不依赖 DSH 或账号服务。 */
export function SettingsLayout({label,heading,actions,notice,entries,selectedId,onSelect,plainContent=false,children}:SettingsLayoutProps){
 const shell=useRef<HTMLElement>(null),content=useRef<HTMLDivElement>(null)
 const selected=entries.find(row=>row.id===selectedId)??entries[0]
 useEffect(()=>{if(shell.current)return mountSettingsSubdialogFocus(shell.current)},[])
 useEffect(()=>{if(content.current)content.current.scrollTop=0},[selected?.id])
 return <section ref={shell} data-teloa-settings-layout className={clsx(tokens.tokens,css.shell)} aria-label={label}>
  <header className={css.header}>
   <div className={css.heading}>{heading}</div>
   <div className={css.actions}>{actions}</div>
  </header>
  {notice}
  <div className={css.layout}>
   <div className={css.navigationViewport}>
    <nav className={css.navigation} aria-label={label}>{entries.map(row=><button type="button" key={row.id} id={`settings-entry-${row.id}`} aria-current={row.id===selected?.id?'page':undefined} aria-controls="settings-content" title={row.label} onClick={()=>onSelect(row.id)}>{row.label}</button>)}</nav>
    <span className={css.navigationScrollHint} aria-hidden="true"><ChevronRight size={16}/></span>
   </div>
   <div ref={content} id="settings-content" aria-labelledby={selected?`settings-entry-${selected.id}`:undefined} className={clsx(css.content,!plainContent&&css.page)}>{children}</div>
  </div>
 </section>
}
