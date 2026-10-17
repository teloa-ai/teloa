/** 为固定 DSH 的公开 DOM 标记补足键盘与页签可见性；不修改页签或运行对象。 */
export function leaseNativeSidebarAccessibility(root:HTMLElement,options:{closeLabel:string;exitFullscreen:(panel:HTMLElement,target:Element)=>void;collapsePanel?:((panel:HTMLElement,target:Element)=>void)|undefined}):()=>void{
  const document=root.ownerDocument
  const inertBefore=new Map<HTMLElement,boolean>()
  const titlesBefore=new Map<HTMLElement,string|null>()
  const labelsBefore=new Map<HTMLElement,string|null>()
  const panels=new Map<HTMLElement,{open:boolean;fullscreen:boolean;origin:HTMLElement|null;fullOrigin:HTMLElement|null}>()
  const strips=new Map<HTMLElement,{active:Element|null;width:number}>()
  const connected=(node:HTMLElement|null)=>{
    if(!node?.isConnected||node.closest('[inert],[hidden],[aria-hidden="true"]')||node.getClientRects().length===0)return false
    const closed=node.closest('details:not([open])')
    if(closed&&!closed.querySelector('summary')?.contains(node))return false
    return document.defaultView?.getComputedStyle(node).visibility!=='hidden'
  }
  const fallback=()=>root.querySelector<HTMLElement>('[data-conversation-header-corner] button,[data-teloa-conversation-options]')
  const restore=(node:HTMLElement|null)=>{const target=connected(node)?node:fallback();if(connected(target))target!.focus({preventScroll:true})}
  const setInert=(node:HTMLElement,value:boolean)=>{if(!inertBefore.has(node))inertBefore.set(node,node.inert);node.inert=value||inertBefore.get(node)===true}
  const setTitle=(node:HTMLElement,title:string)=>{if(!titlesBefore.has(node))titlesBefore.set(node,node.getAttribute('title'));node.setAttribute('title',title)}
  const focusPanel=(panel:HTMLElement)=>{
    const target=panel.querySelector<HTMLElement>('[data-dockkit-tab][aria-selected="true"]')??panel.querySelector<HTMLElement>('button:not(:disabled)')
    target?.focus({preventScroll:true})
  }
  const sync=()=>{
    for(const panel of root.querySelectorAll<HTMLElement>('[data-sidebar-right-panel]')){
      const open=panel.hasAttribute('data-sidebar-right-open')&&!panel.closest('[hidden]')
      const fullscreen=open&&panel.getAttribute('data-sidebar-right-panel')==='fullscreen'
      const active=document.activeElement instanceof HTMLElement?document.activeElement:null
      const previous=panels.get(panel)??{open:false,fullscreen:false,origin:active&&!panel.contains(active)?active:null,fullOrigin:null}
      if(open&&!previous.open&&active&&!panel.contains(active))previous.origin=active
      if(fullscreen&&!previous.fullscreen)previous.fullOrigin=active
      const collapsedFocus=!open&&previous.open&&active!==null&&panel.contains(active)
      for(const dock of panel.querySelectorAll<HTMLElement>('[data-dockkit-host="dock"],[data-dockkit-empty],[data-dockkit-divider]'))setInert(dock,!open)
      if(fullscreen&&!previous.fullscreen)focusPanel(panel)
      else if(previous.fullscreen&&!fullscreen)restore(previous.fullOrigin)
      else if(collapsedFocus)restore(previous.origin)
      panels.set(panel,{...previous,open,fullscreen})
      for(const tab of panel.querySelectorAll<HTMLElement>('[data-dockkit-tab]')){
        const title=tab.querySelector('[data-dockkit-tab-title]')?.textContent?.trim()
        if(!title)continue
        setTitle(tab,title)
        const close=tab.querySelector<HTMLElement>('[data-dockkit-tab-close]')
        if(close){setTitle(close,`${options.closeLabel} · ${title}`);if(!labelsBefore.has(close))labelsBefore.set(close,close.getAttribute('aria-label'));close.setAttribute('aria-label',`${options.closeLabel} · ${title}`)}
      }
      for(const strip of panel.querySelectorAll<HTMLElement>('[data-dockkit-strip-tabs]')){
        resize.observe(strip)
        const activeTab=strip.querySelector<HTMLElement>('[data-dockkit-tab][aria-selected="true"]'),old=strips.get(strip)
        if(activeTab&&(old?.active!==activeTab||old.width!==strip.clientWidth)){
          const tabBox=activeTab.getBoundingClientRect(),box=strip.getBoundingClientRect()
          if(tabBox.left<box.left)strip.scrollLeft-=box.left-tabBox.left
          else if(tabBox.right>box.right)strip.scrollLeft+=tabBox.right-box.right
        }
        strips.set(strip,{active:activeTab,width:strip.clientWidth})
      }
    }
  }
  const escape=(event:KeyboardEvent)=>{
    if(!['Escape','Tab'].includes(event.key)||event.isComposing||event.keyCode===229||event.defaultPrevented||!(event.target instanceof Element))return
    // 抽屉和菜单先消费自己的 Escape；正文的 Escape 仍交回原 Harness。
    if(event.target.closest('dialog[open],[role="dialog"],[role="menu"],[role="listbox"],details[open]'))return
    if(event.key==='Escape'&&event.target.closest('input,textarea,[contenteditable="true"],[role="textbox"],.xterm'))return
    const panel=event.target.closest<HTMLElement>('[data-sidebar-right-open]')
    if(!panel||!root.contains(panel))return
    const fullscreen=panel.getAttribute('data-sidebar-right-panel')==='fullscreen'
    if(event.key==='Tab'){
      if(!fullscreen)return
      const nodes=Array.from(panel.querySelectorAll<HTMLElement>('button:not(:disabled),a[href],input,select,textarea,[tabindex]:not([tabindex="-1"])')).filter(node=>connected(node)&&node.tabIndex>=0)
      const next=event.shiftKey&&document.activeElement===nodes[0]?nodes.at(-1):!event.shiftKey&&document.activeElement===nodes.at(-1)?nodes[0]:undefined
      if(next){event.preventDefault();next.focus()}
      return
    }
    if(!fullscreen&&!options.collapsePanel)return
    event.preventDefault();event.stopImmediatePropagation()
    if(fullscreen)options.exitFullscreen(panel,event.target)
    else{
      const origin=panels.get(panel)?.origin??null
      options.collapsePanel?.(panel,event.target)
      // 在隐藏提交前移出焦点；提交后浏览器可能先移到 body，观察器已无法识别原焦点。
      restore(origin)
    }
  }
  const resize=new ResizeObserver(sync)
  const observer=new MutationObserver(sync)
  observer.observe(root,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['data-sidebar-right-open','data-sidebar-right-panel','aria-selected','hidden']})
  // 先让正文、编辑器与原生菜单消费自己的键盘事件，再处理外层呈现。
  document.addEventListener('keydown',escape)
  sync()
  return()=>{observer.disconnect();resize.disconnect();document.removeEventListener('keydown',escape);for(const [node,value]of inertBefore)node.inert=value;for(const [node,title]of titlesBefore){if(title===null)node.removeAttribute('title');else node.setAttribute('title',title)}for(const [node,label]of labelsBefore){if(label===null)node.removeAttribute('aria-label');else node.setAttribute('aria-label',label)}}
}
