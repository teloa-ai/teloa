import {useId,useLayoutEffect,useRef,useState,type CSSProperties,type ReactNode,type RefObject} from 'react'
import {createPortal} from 'react-dom'
import {Check,ChevronDown,type LucideIcon} from 'lucide-react'
import {composerPopoverPosition,composerSubmenuPosition} from './composer-popover-position.js'
import css from './ComposerPopover.module.css'

export function ComposerPopover({anchor,id,label,children,close,width=360,role='dialog',focusKey='root',cascade=false}:{anchor:RefObject<HTMLButtonElement>;id:string;label:string;children:ReactNode;close:()=>void;width?:number;role?:'dialog'|'listbox'|'menu';focusKey?:string;cascade?:boolean}){
 const panel=useRef<HTMLDivElement>(null),closeRef=useRef(close)
 closeRef.current=close
 const [position,setPosition]=useState<ReturnType<typeof composerPopoverPosition>>()
 useLayoutEffect(()=>{
  const node=panel.current,trigger=anchor.current
  if(!node||!trigger)return
  const place=()=>setPosition(composerPopoverPosition(trigger.getBoundingClientRect(),width,node.scrollHeight,window.innerWidth,window.innerHeight))
  place()
  const observer=new ResizeObserver(place);observer.observe(node);observer.observe(trigger)
  window.addEventListener('resize',place);document.addEventListener('scroll',place,true)
  const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!node.contains(event.target)&&!trigger.contains(event.target))closeRef.current()}
  document.addEventListener('pointerdown',outside)
  return()=>{observer.disconnect();window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true);document.removeEventListener('pointerdown',outside)}
 },[anchor,width])
 const placed=position!==undefined
 useLayoutEffect(()=>{
  if(!placed)return
  const node=panel.current
  const target=node?.querySelector<HTMLElement>('input:not(:disabled)')??node?.querySelector<HTMLElement>('[aria-selected="true"]')??node?.querySelector<HTMLElement>('button:not(:disabled)')
  target?.focus({preventScroll:true})
 },[focusKey,placed])
 return createPortal(<div ref={panel} id={id} className={`${css.panel}${cascade?' '+css.cascade:''}`} role={role} aria-label={label} style={position?{...position,'--composer-menu-height':`${Math.max(0,position.maxHeight-14)}px`,visibility:'visible'} as CSSProperties:{width,visibility:'hidden'}} onBlur={event=>{if(event.relatedTarget instanceof Node&&!event.currentTarget.contains(event.relatedTarget)&&!anchor.current?.contains(event.relatedTarget))closeRef.current()}} onKeyDown={event=>{
  if(event.key==='Escape'){event.preventDefault();event.stopPropagation();closeRef.current();anchor.current?.focus({preventScroll:true})}
  if((role!=='listbox'&&role!=='menu')||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
  const options=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(role==='menu'?'[role="menuitem"]:not(:disabled)':'[role="option"]:not(:disabled)'))
  if(!options.length)return
  event.preventDefault();const current=options.indexOf(document.activeElement as HTMLButtonElement)
  const next=event.key==='Home'?0:event.key==='End'?options.length-1:(current+(event.key==='ArrowDown'?1:-1)+options.length)%options.length
  options[next]?.focus()
 }}>{children}</div>,document.body)
}

export function ComposerSubmenu({anchor,id,label,children,back,focusRequest}:{anchor:RefObject<HTMLButtonElement>;id:string;label:string;children:ReactNode;back:()=>void;focusRequest:number}){
 const panel=useRef<HTMLDivElement>(null)
 const [position,setPosition]=useState<ReturnType<typeof composerSubmenuPosition>|null>()
 useLayoutEffect(()=>{
  const node=panel.current,trigger=anchor.current,parent=trigger?.parentElement
  if(!node||!trigger||!parent)return
  const place=()=>{const rect=(parent.parentElement??parent).getBoundingClientRect();setPosition(window.innerWidth<=740?null:composerSubmenuPosition({left:rect.left,right:rect.right,top:trigger.getBoundingClientRect().top},360,node.scrollHeight,window.innerWidth,window.innerHeight))}
  place();const observer=new ResizeObserver(place);observer.observe(node);observer.observe(parent)
  // 父面板可只移动、不改变尺寸；窗口缩放后的第二次定位也要同步到子菜单。
  const movement=new MutationObserver(place);if(parent.parentElement)movement.observe(parent.parentElement,{attributes:true,attributeFilter:['style']})
  window.addEventListener('resize',place);document.addEventListener('scroll',place,true)
  return()=>{observer.disconnect();movement.disconnect();window.removeEventListener('resize',place);document.removeEventListener('scroll',place,true)}
 },[anchor])
 const placed=position!==undefined
 useLayoutEffect(()=>{
  if(placed&&focusRequest>0)(panel.current?.querySelector<HTMLElement>('input:not(:disabled)')??panel.current?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({preventScroll:true})
 },[placed,focusRequest])
 return <div ref={panel} id={id} className={`${css.panel} ${css.submenu}`} role="group" aria-label={label} style={position?{...position,visibility:'visible'}:position===null?{position:'static',width:'auto',maxHeight:480}:{visibility:'hidden'}} onKeyDown={event=>{
  if(event.key==='Escape'||event.key==='ArrowLeft'&&!(event.target instanceof HTMLInputElement)&&!(event.target instanceof HTMLTextAreaElement)){event.preventDefault();event.stopPropagation();back();anchor.current?.focus({preventScroll:true})}
 }}>{children}</div>
}

export function ComposerSelect({label,value,options,change,icon:Icon,disabled=false}:{label:string;value:string;options:readonly {value:string;label:string}[];change:(value:string)=>void;icon:LucideIcon;disabled?:boolean}){
 const [open,setOpen]=useState(false),anchor=useRef<HTMLButtonElement>(null),id=useId()
 const selected=options.find(option=>option.value===value)
 return <><button ref={anchor} type="button" className={css.trigger} aria-label={label} aria-haspopup="listbox" aria-expanded={open} aria-controls={open?id:undefined} disabled={disabled} onClick={()=>setOpen(!open)}><Icon size={16}/><span>{selected?.label??label}</span><ChevronDown size={13}/></button>{open&&<ComposerPopover anchor={anchor} id={id} label={label} role="listbox" width={260} close={()=>setOpen(false)}>{options.map(option=><button type="button" role="option" aria-selected={value===option.value} className={css.option} key={option.value} onClick={()=>{change(option.value);setOpen(false);anchor.current?.focus({preventScroll:true})}}><span>{option.label}</span>{value===option.value&&<Check size={15}/>}</button>)}</ComposerPopover>}</>
}
