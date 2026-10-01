const dialogSelector='[role="dialog"][aria-modal="true"],dialog[open]'
const controlSelector='button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]'

/** 仅协调从可见设置页打开的标准子弹窗；不接管设置页或其它模块。 */
export function mountSettingsSubdialogFocus(page:HTMLElement):()=>void{
  const doc=page.ownerDocument
  let active:HTMLElement|undefined,opener:HTMLElement|undefined,lastPageFocus:HTMLElement|undefined
  const visible=(element:HTMLElement)=>element.isConnected&&element.getClientRects().length>0&&!element.closest('[inert]')
  const pageVisible=()=>visible(page)
  const controls=(dialog:HTMLElement)=>Array.from(dialog.querySelectorAll<HTMLElement>(controlSelector)).filter(control=>visible(control)&&control.tabIndex>=0)
  const topDialog=()=>Array.from(doc.querySelectorAll<HTMLElement>(dialogSelector)).filter(dialog=>!page.contains(dialog)&&visible(dialog)).at(-1)
  const popup=(target:Element|null)=>!!target?.closest('[role="menu"],[role="listbox"]')
  const focusDialog=(dialog:HTMLElement,backward=false)=>{const items=controls(dialog),target=backward?items.at(-1):items[0];(target??dialog).focus()}
  const release=(restore:boolean)=>{
    const target=opener
    active=undefined;opener=undefined
    if(restore&&target&&pageVisible()&&visible(target))target.focus({preventScroll:true})
  }
  const sync=()=>{
    if(!pageVisible()){release(false);lastPageFocus=undefined;return}
    const next=topDialog()
    if(next===active)return
    if(!next){if(active)release(true);return}
    const focused=doc.activeElement instanceof HTMLElement?doc.activeElement:undefined
    if(!active){
      const origin=focused&&page.contains(focused)?focused:lastPageFocus
      if(!origin||!page.contains(origin)||!visible(origin))return
      opener=origin
    }
    active=next
    if(!focused||!next.contains(focused))focusDialog(next)
  }
  const remember=(event:Event)=>{
    const target=event.target instanceof Element?event.target.closest<HTMLElement>(controlSelector):undefined
    if(pageVisible()&&target&&page.contains(target))lastPageFocus=target
  }
  const onFocus=(event:FocusEvent)=>{
    remember(event);sync()
    const target=event.target instanceof HTMLElement?event.target:undefined
    if(active&&target&&!active.contains(target)&&!popup(target))focusDialog(active)
  }
  const onKey=(event:KeyboardEvent)=>{
    sync()
    if(!active||event.defaultPrevented||event.key!=='Tab'||popup(event.target instanceof Element?event.target:null))return
    const items=controls(active),first=items[0],last=items.at(-1)
    if(!first){event.preventDefault();active.focus();return}
    if(event.shiftKey&&(doc.activeElement===first||!active.contains(doc.activeElement))){event.preventDefault();last?.focus()}
    else if(!event.shiftKey&&(doc.activeElement===last||!active.contains(doc.activeElement))){event.preventDefault();first.focus()}
  }
  page.addEventListener('click',remember,true)
  doc.addEventListener('focusin',onFocus)
  doc.addEventListener('keydown',onKey,true)
  const observer=new MutationObserver(sync)
  observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['open','hidden','aria-hidden']})
  return ()=>{observer.disconnect();page.removeEventListener('click',remember,true);doc.removeEventListener('focusin',onFocus);doc.removeEventListener('keydown',onKey,true);release(false)}
}
