import React,{useLayoutEffect,useRef,useState} from 'react'
import {ChevronDown} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import {useDismissible} from './use-dismissible.js'
import css from './BusinessPage.module.css'

import {businessMoreActions,businessMoreActionTitles,type BusinessMoreAction} from './business-more-actions.js'
export type {BusinessMoreAction} from './business-more-actions.js'

/** 旧业务范围的已存在页面入口；选中动作时把当前范围原样交给调用方。 */
export function BusinessMoreMenu({scope,choose,unavailable={}}:{scope:string;choose:(action:BusinessMoreAction,scope:string)=>void;unavailable?:Partial<Record<BusinessMoreAction,string>>}){
 const {t}=useI18n()
 const [open,setOpen]=useState(false)
 const [above,setAbove]=useState(false)
 const ref=useRef<HTMLDetailsElement>(null)
 useDismissible(ref,open,()=>setOpen(false))
 useLayoutEffect(()=>{
  if(!open)return
  const position=()=>{
   const details=ref.current,trigger=details?.querySelector('summary')
   if(!details||!trigger)return
   const bounds=trigger.getBoundingClientRect()
   let top=12,bottom=window.innerHeight-12,left=12,right=window.innerWidth-12
   // 菜单也会挂在工作区页签和嵌入分栏，按真实裁切祖先定位，不能只认旧内容容器。
   for(let parent=details.parentElement;parent;parent=parent.parentElement){
    const style=getComputedStyle(parent),rect=parent.getBoundingClientRect()
    if(style.display==='contents'||!rect.width||!rect.height)continue
    if(/auto|scroll|hidden|clip/.test(style.overflowY)){top=Math.max(top,rect.top+parent.clientTop+8);bottom=Math.min(bottom,rect.top+parent.clientTop+parent.clientHeight-8)}
    if(/auto|scroll|hidden|clip/.test(style.overflowX)){left=Math.max(left,rect.left+parent.clientLeft+8);right=Math.min(right,rect.left+parent.clientLeft+parent.clientWidth-8)}
   }
   const below=bottom-bounds.bottom-7,above= bounds.top-top-7
   const panelHeight=details.querySelector('[role="group"]')?.scrollHeight??320
   const placeAbove=below<panelHeight&&above>below
   const width=Math.max(0,Math.min(264,right-left))
   const panelLeft=Math.max(left,Math.min(details.getBoundingClientRect().right-width,right-width))
   details.style.setProperty('--scope-menu-available',`${Math.max(0,Math.floor(placeAbove?above:below))}px`)
   details.style.setProperty('--scope-menu-width',`${Math.floor(width)}px`)
   details.style.setProperty('--scope-menu-right',`${Math.floor(details.getBoundingClientRect().right-panelLeft-width)}px`)
   setAbove(placeAbove)
  }
  position()
  window.addEventListener('resize',position)
  document.addEventListener('scroll',position,true)
  return ()=>{window.removeEventListener('resize',position);document.removeEventListener('scroll',position,true)}
 },[open])
 const pick=(action:BusinessMoreAction)=>{ref.current?.querySelector('summary')?.focus();setOpen(false);choose(action,scope)}
 return <details ref={ref} className={css.scopeMore} data-placement={above?'above':'below'} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary onClick={event=>{event.preventDefault();setOpen(value=>!value)}}>{t('business.section.more')}<ChevronDown size={13}/></summary>
  <div role="group" aria-label={t('business.section.more.aria')} className={css.scopeMorePanel}>
   <section>{businessMoreActions(scope).map(action=><button key={action} type="button" disabled={unavailable[action]!==undefined} title={unavailable[action]} onClick={()=>pick(action)}>{t(businessMoreActionTitles[action])}</button>)}</section>
  </div>
 </details>
}
