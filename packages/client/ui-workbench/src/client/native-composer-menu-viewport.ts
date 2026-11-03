import {composerPopoverPosition} from './composer-popover-position.js'

/** 保留原生菜单的 React DOM、combobox 焦点与控制器，只修正浮层所属的绘制层和坐标。 */
export function attachNativeComposerMenuViewport(anchor:HTMLElement,className:string,dismissCommandMenu:()=>boolean){
 const card=anchor.closest<HTMLElement>('[data-composer-card]')
 if(!card)return()=>{}
 let menu:HTMLElement|null=null,restore:(()=>void)|undefined,frame=0,disposed=false
 const viewport=window.visualViewport
 const place=()=>{
  if(!menu?.isConnected)return
  const bounds=card.getBoundingClientRect(),offsetLeft=viewport?.offsetLeft??0,offsetTop=viewport?.offsetTop??0
  const list=menu.querySelector<HTMLElement>('[role="listbox"]')
  const height=Math.min(400,menu.scrollHeight+(list?list.scrollHeight-list.clientHeight:0))
  const position=composerPopoverPosition({left:bounds.left-offsetLeft,top:bounds.top-offsetTop,bottom:bounds.bottom-offsetTop},bounds.width,height,viewport?.width??window.innerWidth,viewport?.height??window.innerHeight)
  const values={'--native-menu-left':`${position.left+offsetLeft}px`,'--native-menu-top':`${position.top+offsetTop}px`,'--native-menu-width':`${position.width}px`,'--native-menu-height':`${Math.min(400,position.maxHeight)}px`}
  for(const [name,value] of Object.entries(values))if(menu.style.getPropertyValue(name)!==value)menu.style.setProperty(name,value)
 }
 const schedule=()=>{if(!frame&&!disposed)frame=requestAnimationFrame(()=>{frame=0;refresh()})}
 const resize=new ResizeObserver(schedule)
 const refresh=()=>{
  const next=anchor.querySelector<HTMLElement>('[data-trigger-menu]')
  if(next!==menu){
   restore?.();restore=undefined;menu=next
   resize.disconnect();resize.observe(card);resize.observe(anchor)
   if(menu){
    const node=menu,previousPopover=node.getAttribute('popover')
    const names=['--native-menu-left','--native-menu-top','--native-menu-width','--native-menu-height']
    const previous=names.map(name=>[name,node.style.getPropertyValue(name),node.style.getPropertyPriority(name)] as const)
    node.classList.add(className)
    // manual 不接管轻关闭；原生 DSH 仍负责 Escape、外点、IME 和选项选择。
    if(typeof node.showPopover==='function'){node.setAttribute('popover','manual');node.showPopover()}
    resize.observe(node)
    restore=()=>{
     if(typeof node.hidePopover==='function'&&node.matches(':popover-open'))node.hidePopover()
     if(previousPopover===null)node.removeAttribute('popover');else node.setAttribute('popover',previousPopover)
     node.classList.remove(className)
     for(const [name,value,priority]of previous)if(value)node.style.setProperty(name,value,priority);else node.style.removeProperty(name)
    }
   }
  }
  place()
 }
 const mutation=new MutationObserver(schedule)
 mutation.observe(anchor,{childList:true,subtree:true,attributes:true,attributeFilter:['style']})
 refresh()
 // 原生编辑器的 focus commit 可能已清空 launcher，但菜单仍打开；关闭意图必须回控制器。
 const closeFromLauncher=(event:MouseEvent)=>{
  if(event.defaultPrevented||event.button!==0||!menu?.isConnected||!anchor.contains(menu))return
  const button=event.target instanceof Element?event.target.closest<HTMLButtonElement>('button[aria-haspopup="listbox"]'):null
  if(!button||button.closest('[data-composer-card]')!==card||!button.nextElementSibling?.matches('input[type="file"][hidden]'))return
  if(!dismissCommandMenu())return
  event.preventDefault();event.stopPropagation()
 }
 card.addEventListener('click',closeFromLauncher,true)
 window.addEventListener('resize',schedule);document.addEventListener('scroll',schedule,true)
 viewport?.addEventListener('resize',schedule);viewport?.addEventListener('scroll',schedule)
 return()=>{
  disposed=true;mutation.disconnect();resize.disconnect();cancelAnimationFrame(frame)
  card.removeEventListener('click',closeFromLauncher,true)
  window.removeEventListener('resize',schedule);document.removeEventListener('scroll',schedule,true)
  viewport?.removeEventListener('resize',schedule);viewport?.removeEventListener('scroll',schedule)
  restore?.();menu=null
 }
}
