import {useEffect,useId,useRef,useState,type ReactNode} from 'react'
import {ListFilter} from 'lucide-react'
import {focusFirstDirectoryFilterControl,handleDirectoryFilterEscape,restoreDirectoryFilterFocus} from './directory-filter-popover.js'
import {useDismissible} from './use-dismissible.js'
import css from './DirectoryPane.module.css'

export function DirectoryFilterPopover({label,children}:{label:string;children:ReactNode}){
  const [open,setOpen]=useState(false)
  const container=useRef<HTMLDivElement>(null)
  const trigger=useRef<HTMLButtonElement>(null)
  const panel=useRef<HTMLDivElement>(null)
  const panelId=useId()
  useDismissible(container,open,()=>setOpen(false))
  useEffect(()=>{
    if(!open)return
    const frame=requestAnimationFrame(()=>focusFirstDirectoryFilterControl(panel.current as unknown as Parameters<typeof focusFirstDirectoryFilterControl>[0]))
    return()=>cancelAnimationFrame(frame)
  },[open])
  const closeAndRestore=()=>{setOpen(false);restoreDirectoryFilterFocus(trigger.current)}
  return <div ref={container} className={css.filterMenu} onKeyDown={event=>handleDirectoryFilterEscape(event,closeAndRestore)}>
    <button ref={trigger} type="button" className={css.filterTrigger} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}><ListFilter size={15}/></button>
    {open&&<div ref={panel} id={panelId} role="dialog" aria-label={label}>{children}</div>}
  </div>
}
