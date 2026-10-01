import React,{useId,useLayoutEffect,useRef,useState} from 'react'
import {ChevronDown} from 'lucide-react'
import {useI18n} from './i18n/provider.js'
import {useDismissible} from './use-dismissible.js'
import css from './BusinessPage.module.css'

export type BusinessMoreAction='work'|'completed'|'dashboards'|'automations'|'adjustment'|'connector'|'sources'|'manual-definition'|'share'

/** 旧业务范围的已存在页面入口；选中动作时把当前范围原样交给调用方。 */
export function BusinessMoreMenu({scope,choose}:{scope:string;choose:(action:BusinessMoreAction,scope:string)=>void}){
 const {t}=useI18n()
 const [open,setOpen]=useState(false)
 const [above,setAbove]=useState(false)
 const ref=useRef<HTMLDetailsElement>(null)
 const id=useId()
 useDismissible(ref,open,()=>setOpen(false))
 useLayoutEffect(()=>{
  if(!open)return
  const position=()=>{
   const details=ref.current,trigger=details?.querySelector('summary')
   if(!details||!trigger)return
   const bounds=trigger.getBoundingClientRect(),content=details.closest(`.${css.content}`) as HTMLElement|null
   const clip=content&&{rect:content.getBoundingClientRect(),top:content.clientTop,left:content.clientLeft,width:content.clientWidth,height:content.clientHeight}
   const top=Math.max(12,clip?clip.rect.top+clip.top+8:12)
   const bottom=Math.min(window.innerHeight-12,clip?clip.rect.top+clip.top+clip.height-8:window.innerHeight-12)
   const left=Math.max(12,clip?clip.rect.left+clip.left+8:12)
   const right=Math.min(window.innerWidth-12,clip?clip.rect.left+clip.left+clip.width-8:window.innerWidth-12)
   const below=bottom-bounds.bottom-7,above= bounds.top-top-7
   const placeAbove=below<260&&above>below
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
 const pick=(action:BusinessMoreAction)=>{setOpen(false);choose(action,scope)}
 return <details ref={ref} className={css.scopeMore} data-placement={above?'above':'below'} open={open} onToggle={event=>setOpen(event.currentTarget.open)}>
  <summary>{t('business.section.more')}<ChevronDown size={13}/></summary>
  <div role="group" aria-label={t('business.section.more.aria')} className={css.scopeMorePanel}>
   <section aria-labelledby={`${id}-view`}><h3 id={`${id}-view`}>{t('business.more.view')}</h3>
    <button type="button" onClick={()=>pick('work')}>{t('business.more.currentTasks')}</button>
    <button type="button" onClick={()=>pick('completed')}>{t('business.done.title')}</button>
    <button type="button" onClick={()=>pick('dashboards')}>{t('business.more.dashboards')}</button>
    <button type="button" onClick={()=>pick('automations')}>{t('business.section.continuous')}</button>
   </section>
   <section aria-labelledby={`${id}-configure`}><h3 id={`${id}-configure`}>{t('business.more.configure')}</h3>
    <button type="button" onClick={()=>pick('adjustment')}>{t('business.more.adjustment')}</button>
    <button type="button" onClick={()=>pick('connector')}>{t('business.more.connector')}</button>
    <button type="button" onClick={()=>pick('sources')}>{t('business.more.sources')}</button>
    <details className={css.scopeMoreAdvanced}><summary>{t('business.more.advanced')}</summary><button type="button" onClick={()=>pick('manual-definition')}>{t('business.more.manualDefinition')}</button></details>
   </section>
   <section aria-labelledby={`${id}-share`}><h3 id={`${id}-share`}>{t('business.more.share')}</h3>
    <button type="button" onClick={()=>pick('share')}>{t('business.more.shareBusiness')}</button>
   </section>
  </div>
 </details>
}
