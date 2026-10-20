import {useEffect,useRef,type ReactNode} from 'react'
import clsx from 'clsx'
import {ChevronRight} from 'lucide-react'
import css from './SettingsShell.module.css'
import tokens from './theme-tokens.module.css'
import {mountSettingsSubdialogFocus} from './settings-subdialog-focus.js'

/**
 * 设置当前页名的只读快照：设置外壳挂在宿主座位里，与工作台顶栏不在同一棵组件树，
 * 顶栏据此显示「设置 › 页名」（参照业务内页的两级面包屑）。外壳卸载时清空。
 */
let currentPageTitle:string|undefined
const pageTitleListeners=new Set<()=>void>()
const publishPageTitle=(next:string|undefined)=>{
 if(next===currentPageTitle)return
 currentPageTitle=next
 for(const listener of [...pageTitleListeners])listener()
}
export const settingsPageTitle={
 subscribe:(listener:()=>void)=>{pageTitleListeners.add(listener);return ()=>{pageTitleListeners.delete(listener)}},
 getSnapshot:()=>currentPageTitle,
}

export type SettingsLayoutEntry=Readonly<{id:string;label:string;group?:string}>
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

/**
 * 设置的唯一呈现壳；目录、内容与动作由宿主提供，不依赖 DSH 或账号服务。
 * 1.0：目录贴左成整高一栏，页名由工作台顶栏承担，这里的标题只留给读屏；全局动作收在目录底部。
 */
export function SettingsLayout({label,heading,actions,notice,entries,selectedId,onSelect,plainContent=false,children}:SettingsLayoutProps){
 const shell=useRef<HTMLElement>(null),content=useRef<HTMLDivElement>(null)
 const selected=entries.find(row=>row.id===selectedId)??entries[0]
 useEffect(()=>{if(shell.current)return mountSettingsSubdialogFocus(shell.current)},[])
 useEffect(()=>{if(content.current)content.current.scrollTop=0},[selected?.id])
 useEffect(()=>{publishPageTitle(selected?.label)},[selected?.label])
 useEffect(()=>()=>publishPageTitle(undefined),[])
 return <section ref={shell} data-teloa-settings-layout className={clsx(tokens.tokens,css.shell)} aria-label={label}>
  <div className={css.layout}>
   <div className={css.navigationViewport}>
    <nav className={css.navigation} aria-label={label}>{entries.map((row,index)=><span className={css.navigationEntry} key={row.id}>{row.group&&row.group!==row.label&&row.group!==entries[index-1]?.group&&<span className={css.navigationGroup}>{row.group}</span>}<button type="button" key={row.id} id={`settings-entry-${row.id}`} aria-current={row.id===selected?.id?'page':undefined} aria-controls="settings-content" title={row.label} onClick={()=>onSelect(row.id)}>{row.label}</button></span>)}</nav>
    <span className={css.navigationScrollHint} aria-hidden="true"><ChevronRight size={16}/></span>
   </div>
   <header className={css.header}>
    <div className={css.heading}>{heading}</div>
    <div className={css.actions}>{actions}</div>
   </header>
   <div ref={content} id="settings-content" aria-labelledby={selected?`settings-entry-${selected.id}`:undefined} className={clsx(css.content,!plainContent&&css.page)}>{notice}{children}</div>
  </div>
 </section>
}
