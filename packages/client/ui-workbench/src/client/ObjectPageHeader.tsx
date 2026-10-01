import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react'
import {ArrowLeft,ArrowUpRight,ChevronRight,Ellipsis,Pencil,UserRound} from 'lucide-react'
import {StatusLabel} from './StatusLabel.js'
import type {StatusMark} from './status-presentation.js'
import {useDismissible} from './use-dismissible.js'
import css from './ObjectPage.module.css'

export type ObjectMenuItem={id:string;label:string;onSelect:()=>void;disabled?:boolean}
export type ObjectBadge={id:string;label:string;onOpen?:()=>void}

/** 对象页页头：返回、标题（可点开编辑）、状态标记、对象属性、负责人与 ··· 菜单（`role="menu"`，↑↓/Home/End/Esc 可达）。 */
export function ObjectPageHeader(props:{
 title:string;onEditTitle?:()=>void;editTitleLabel?:string
 status:{label:string;tone:'info'|'warn'|'good'|'muted';mark?:StatusMark}
 badges?:readonly ObjectBadge[]
 owner?:{label:string;name:string;onOpen?:()=>void}
 menu?:readonly ObjectMenuItem[];menuLabel:string
 back?:()=>void;backLabel?:string;backHidden?:boolean
 trailing?:ReactNode
 meta?:string
}):JSX.Element{
 const {title,onEditTitle,editTitleLabel,status,badges,owner,menu,menuLabel,back,backLabel,backHidden,meta}=props
 const [open,setOpen]=useState(false),menuId=useId(),menuRef=useRef<HTMLDivElement>(null),triggerRef=useRef<HTMLButtonElement>(null)
 const close=()=>{setOpen(false);triggerRef.current?.focus()}
 useDismissible(menuRef,open,close)
 useEffect(()=>{
  if(!open)return
  const frame=requestAnimationFrame(()=>menuRef.current?.querySelector<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')?.focus())
  return ()=>cancelAnimationFrame(frame)
 },[open])
 const onMenuKeyDown=(event:KeyboardEvent<HTMLDivElement>)=>{
  const items=Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)')??[])
  if(items.length===0)return
  const index=items.findIndex(item=>item===document.activeElement)
  const focusAt=(next:number)=>{event.preventDefault();items[(next+items.length)%items.length]?.focus()}
  if(event.key==='ArrowDown')focusAt(index+1)
  else if(event.key==='ArrowUp')focusAt(index-1)
  else if(event.key==='Home')focusAt(0)
  else if(event.key==='End')focusAt(items.length-1)
  else if(event.key==='Escape'){event.preventDefault();close()}
  else if(event.key==='Tab')close()
 }
 return <header className={css.header}>
  {back&&!backHidden&&<button type="button" className={css.back} onClick={back}><ArrowLeft size={14}/>{backLabel}</button>}
  <div className={css.titleRow}>
   {onEditTitle?<h2 aria-label={title}><button type="button" className={css.titleButton} aria-label={editTitleLabel} onClick={onEditTitle}><span className={css.titleText} title={title}>{title}</span><Pencil size={14}/></button></h2>:<h2 className={css.titleText} title={title}>{title}</h2>}
   {props.trailing}
   {menu&&menu.length>0&&<div ref={menuRef}>
    <button ref={triggerRef} type="button" className={css.menuTrigger} aria-haspopup="menu" aria-expanded={open} aria-controls={menuId} aria-label={menuLabel} onClick={()=>setOpen(value=>!value)}><Ellipsis size={16}/></button>
    {open&&<div id={menuId} role="menu" className={css.menu} aria-label={menuLabel} onKeyDown={onMenuKeyDown}>
     {menu.map(item=><button key={item.id} type="button" role="menuitem" disabled={item.disabled} onClick={()=>{item.onSelect();close()}}>{item.label}</button>)}
    </div>}
   </div>}
  </div>
  <div className={css.badges}>
   <StatusLabel {...status}/>
   {badges?.map(badge=>badge.onOpen?<button key={badge.id} type="button" className={css.objectLink} onClick={badge.onOpen}>{badge.label}<ChevronRight size={12} aria-hidden="true"/></button>:<span key={badge.id} className={css.metadata}>{badge.label}</span>)}
   {owner&&<span className={css.owner}><UserRound size={13} aria-hidden="true"/>{owner.label}{owner.onOpen?<button type="button" onClick={owner.onOpen}>{owner.name}<ArrowUpRight size={12}/></button>:<strong>{owner.name}</strong>}</span>}
   {meta&&<small className={css.muted}>{meta}</small>}
  </div>
 </header>
}
