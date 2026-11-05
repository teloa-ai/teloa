import {useEffect,useId,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react'
import {ListFilter} from 'lucide-react'
import {directoryFilterPosition,focusFirstDirectoryFilterControl,handleDirectoryFilterEscape,restoreDirectoryFilterFocus} from './directory-filter-popover.js'
import {useDismissible} from './use-dismissible.js'
import css from './DirectoryPane.module.css'

export function DirectoryFilterPopover({label,children,icon,showLabel=false,closeOnSelect=false,panelClassName}:{label:string;children:ReactNode;icon?:ReactNode;showLabel?:boolean;closeOnSelect?:boolean;panelClassName?:string|undefined}){
  const [open,setOpen]=useState(false)
  const [placement,setPlacement]=useState<ReturnType<typeof directoryFilterPosition>>()
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
  useLayoutEffect(()=>{
    if(!open)return
    const place=()=>{
      if(window.matchMedia('(max-width:760px)').matches){setPlacement(undefined);return}
      const box=trigger.current?.getBoundingClientRect(),node=panel.current
      if(!box||!node)return
      const rect=node.getBoundingClientRect(),height=Math.min(node.scrollHeight+2,window.innerHeight*.7,560)
      const next=directoryFilterPosition(box,rect.width,height,window.innerWidth,window.innerHeight)
      setPlacement(previous=>previous&&previous.left===next.left&&previous.top===next.top&&previous.maxHeight===next.maxHeight?previous:next)
    }
    place()
    const observer=new ResizeObserver(place)
    if(panel.current)observer.observe(panel.current)
    if(trigger.current)observer.observe(trigger.current)
    window.addEventListener('resize',place)
    document.addEventListener('scroll',place,true)
    return()=>{observer.disconnect();window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true)}
  },[open])
  // 子动作可能立刻打开模态；先回到稳定入口，让模态记录正确的返回焦点。
  const closeAndRestore=()=>{trigger.current?.focus({preventScroll:true});setOpen(false);restoreDirectoryFilterFocus(trigger.current)}
  return <div ref={container} className={css.filterMenu} onKeyDown={event=>handleDirectoryFilterEscape(event,closeAndRestore)}>
    <button ref={trigger} type="button" className={css.filterTrigger} title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}>{icon??<ListFilter size={16}/>} {showLabel&&<span>{label}</span>}</button>
    {open&&<div ref={panel} id={panelId} className={[css.filterPanel,panelClassName].filter(Boolean).join(' ')} role="dialog" aria-label={label} style={placement?({position:'fixed',...placement,right:'auto',bottom:'auto'} satisfies CSSProperties):undefined} onClick={event=>{if(closeOnSelect&&event.target instanceof Element&&event.target.closest('button'))closeAndRestore()}}>{children}</div>}
  </div>
}
