import {useEffect,useId,useRef,useState,type CSSProperties,type ReactNode} from 'react'
import {ListFilter} from 'lucide-react'
import {focusFirstDirectoryFilterControl,handleDirectoryFilterEscape,restoreDirectoryFilterFocus} from './directory-filter-popover.js'
import {useDismissible} from './use-dismissible.js'
import css from './DirectoryPane.module.css'

export function DirectoryFilterPopover({label,children,icon,closeOnSelect=false}:{label:string;children:ReactNode;icon?:ReactNode;closeOnSelect?:boolean}){
  const [open,setOpen]=useState(false)
  const [placement,setPlacement]=useState<{left:number;top:number}>()
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
  // 桌面弹层用 fixed 定位，避开左栏 overflow-x:hidden 的裁切；移动端继续由样式表贴底铺满。
  useEffect(()=>{
    if(!open)return
    const place=()=>{
      if(window.matchMedia('(max-width:760px)').matches){setPlacement(undefined);return}
      const box=trigger.current?.getBoundingClientRect(),panelRect=panel.current?.getBoundingClientRect()
      if(!box)return
      const width=panelRect?.width??244,height=panelRect?.height??0
      setPlacement({left:Math.max(8,Math.min(box.right-width,window.innerWidth-width-8)),top:Math.min(box.bottom+6,window.innerHeight-height-8)})
    }
    const frame=requestAnimationFrame(place)
    window.addEventListener('resize',place)
    return()=>{cancelAnimationFrame(frame);window.removeEventListener('resize',place)}
  },[open])
  // 子动作可能立刻打开模态；先回到稳定入口，让模态记录正确的返回焦点。
  const closeAndRestore=()=>{trigger.current?.focus();setOpen(false);restoreDirectoryFilterFocus(trigger.current)}
  return <div ref={container} className={css.filterMenu} onKeyDown={event=>handleDirectoryFilterEscape(event,closeAndRestore)}>
    <button ref={trigger} type="button" className={css.filterTrigger} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>{icon??<ListFilter size={15}/>}</button>
    {open&&<div ref={panel} id={panelId} role="dialog" aria-label={label} style={placement?({position:'fixed',left:placement.left,top:placement.top,right:'auto',bottom:'auto'} satisfies CSSProperties):undefined} onClick={event=>{if(closeOnSelect&&event.target instanceof Element&&event.target.closest('button'))closeAndRestore()}}>{children}</div>}
  </div>
}
