import {useEffect,useRef,type ReactNode} from 'react'

type Props={children:ReactNode;className?:string|undefined;menuRef?:{current:HTMLDetailsElement|null};resetKey?:string|undefined;closeOnSelect?:boolean}

/** 保留原生 summary 的点击与键盘展开；菜单先消费 Escape，不关闭外层抽屉或资料栏。 */
export function DetailsMenu({children,className,menuRef,resetKey,closeOnSelect=false}:Props){
 const ownRef=useRef<HTMLDetailsElement>(null),ref=menuRef??ownRef
 useEffect(()=>{if(ref.current)ref.current.open=false},[resetKey])
 useEffect(()=>{
  const menu=ref.current
  if(!menu)return
  const summary=menu.querySelector('summary')
  const panel=menu.querySelector('[role="menu"]')
  const items=()=>Array.from(panel?.querySelectorAll<HTMLElement>('button,a[href],[role="menuitem"]')??[]).filter(item=>!item.matches(':disabled,[aria-disabled="true"]'))
  summary?.setAttribute('role','button')
  if(panel)summary?.setAttribute('aria-haspopup','menu')
  // toggle 可能晚于方向键到达；只从入口交接焦点，不能把已选中的菜单项拉回第一项。
  const sync=()=>{summary?.setAttribute('aria-expanded',String(menu.open));if(menu.open&&panel&&menu.ownerDocument.activeElement===summary)items()[0]?.focus()}
  const close=(restoreFocus=false)=>{menu.open=false;summary?.setAttribute('aria-expanded','false');if(restoreFocus)summary?.focus()}
  const move=(event:KeyboardEvent)=>{
   if(!panel||!menu.open||!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
   const rows=items();if(!rows.length)return
   const current=rows.indexOf(document.activeElement as HTMLElement),next=event.key==='Home'?0:event.key==='End'?rows.length-1:event.key==='ArrowDown'?(current+1)%rows.length:(current+rows.length-1)%rows.length
   event.preventDefault();rows[next]?.focus()
  }
  summary?.setAttribute('aria-expanded',String(menu.open))
  const outside=(event:PointerEvent)=>{if(menu.open&&event.target instanceof Node&&!menu.contains(event.target))close()}
  const leave=(event:FocusEvent)=>{if(panel&&menu.open&&event.relatedTarget instanceof Node&&!menu.contains(event.relatedTarget))close()}
  const escape=(event:KeyboardEvent)=>{
   if(event.key!=='Escape'||event.isComposing||event.defaultPrevented||!menu.open||!(event.target instanceof Node)||!menu.contains(event.target))return
   event.preventDefault();event.stopImmediatePropagation();close(true)
  }
  document.addEventListener('pointerdown',outside)
  document.addEventListener('keydown',escape,true)
  menu.addEventListener('toggle',sync)
  menu.addEventListener('keydown',move)
  menu.addEventListener('focusout',leave)
  return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape,true);menu.removeEventListener('toggle',sync);menu.removeEventListener('keydown',move);menu.removeEventListener('focusout',leave)}
 },[ref])
 return <details ref={ref} className={className} onClickCapture={event=>{
  if(!(event.target instanceof Element))return
  const action=event.target.closest('button,a,[role="menuitem"]'),menu=ref.current
  // 动作可能先隐藏菜单再挂载抽屉；先留下可见入口，子动作的显式焦点随后仍可覆盖。
  if(action&&menu?.querySelector('[role="menu"]')?.contains(action)&&!action.matches(':disabled,[aria-disabled="true"]'))menu.querySelector('summary')?.focus()
 }} onClick={event=>{
  if(!closeOnSelect||!(event.target instanceof Element))return
  const action=event.target.closest('button,a,[role="menuitem"]')
  const menu=ref.current
  if(action&&menu?.contains(action)&&!menu.querySelector('summary')?.contains(action)){
   menu.open=false
   queueMicrotask(()=>{const active=menu.ownerDocument.activeElement;if(menu.isConnected&&(active===action||active===menu.ownerDocument.body||menu.contains(active)))menu.querySelector('summary')?.focus()})
  }
 }}>{children}</details>
}
