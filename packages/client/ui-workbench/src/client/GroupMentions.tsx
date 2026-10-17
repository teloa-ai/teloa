import {useEffect,useId,useRef,useState} from 'react'
import {AtSign,X} from 'lucide-react'
import type {GroupAttention,GroupMentionItem,GroupMentionsPage} from '@teloa/contract'
import type {GroupApi} from './group-api.ts'
import {useI18n} from './i18n/provider.tsx'
import css from './CollaborationPage.module.css'

/** 原群内的阅读筛选；打开和关闭不标已读，只有原消息进入可见窗口才沿既有水位推进。 */
export function GroupMentions({api,groupId,active,locate,author,time}:{api:Pick<GroupApi,'attention'|'mentions'>;groupId:string;active:boolean;locate:(item:GroupMentionItem)=>boolean|void|Promise<boolean|void>;author:(item:GroupMentionItem)=>string;time:(value:string)=>string}){
 const {t}=useI18n(),panelId=useId(),toggle=useRef<HTMLButtonElement>(null),filter=useRef<HTMLInputElement>(null)
 const [open,setOpen]=useState(false),[unreadOnly,setUnreadOnly]=useState(true),[summary,setSummary]=useState<GroupAttention>(),[summaryFailed,setSummaryFailed]=useState(false)
 const [page,setPage]=useState<GroupMentionsPage>(),[busy,setBusy]=useState(false),[failed,setFailed]=useState(false)
 const [locating,setLocating]=useState<string>(),[locationFailure,setLocationFailure]=useState<GroupMentionItem>()
 const reading=useRef(0),summarizing=useRef(0),navigating=useRef(0),alive=useRef(true)
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;++reading.current;++summarizing.current;++navigating.current}},[api,groupId])
 const refresh=async()=>{
  const version=++summarizing.current
  try{const result=await api.attention();if(alive.current&&version===summarizing.current){setSummary(result.items.find(item=>item.groupId===groupId));setSummaryFailed(false)}}
  catch{if(alive.current&&version===summarizing.current){setSummary(undefined);setSummaryFailed(true)}}
 }
 useEffect(()=>{if(!active)return;void refresh();const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void refresh()},4000);return()=>{clearInterval(timer);++summarizing.current;++reading.current;++navigating.current}},[api,groupId,active])
 const load=async(more=false)=>{
  if(!active||more&&!page?.next)return
  const version=++reading.current,before=more?page?.next??undefined:undefined
  setBusy(true);setFailed(false);setLocationFailure(undefined);if(!more)setPage(undefined)
  try{const result=await api.mentions(groupId,unreadOnly,before);if(alive.current&&version===reading.current)setPage(previous=>more&&previous?{...result,items:[...previous.items,...result.items.filter(item=>!previous.items.some(old=>old.message.id===item.message.id))]}:result)}
  catch{if(alive.current&&version===reading.current)setFailed(true)}
  finally{if(alive.current&&version===reading.current)setBusy(false)}
 }
 useEffect(()=>{if(open&&active){void load();filter.current?.focus()}},[api,groupId,open,unreadOnly,active])
 const dismiss=(restoreFocus:boolean)=>{++reading.current;++navigating.current;setBusy(false);setLocating(undefined);setLocationFailure(undefined);setOpen(false);if(restoreFocus)requestAnimationFrame(()=>toggle.current?.focus())}
 const close=()=>dismiss(true)
 const locateItem=async(item:GroupMentionItem)=>{
  const version=++navigating.current
  setLocating(item.message.id);setLocationFailure(undefined)
  try{
   const located=await locate(item)
   if(!alive.current||version!==navigating.current)return
   // 原定位器拥有目标消息焦点；成功折叠列表不能再把它抢回入口。
   if(located===false)setLocationFailure(item)
   else dismiss(false)
  }catch{if(alive.current&&version===navigating.current)setLocationFailure(item)}
  finally{if(alive.current&&version===navigating.current)setLocating(undefined)}
 }
 return <div onKeyDown={event=>{if(open&&event.key==='Escape'){event.preventDefault();event.stopPropagation();close()}}}>
  <div className={css.mentionSummary}><button ref={toggle} type="button" className={css.replyButton} aria-expanded={open} aria-controls={panelId} onClick={()=>{if(open)close();else setOpen(true)}}><AtSign size={14} aria-hidden/>{t('group.mentions.title')}{summary&&' '+summary.mentionCount}</button>{summary&&summary.unreadCount>0&&<small>{t('group.mentions.unread',{count:summary.unreadCount})}</small>}{summaryFailed&&<span role="status">{t('group.mentions.summaryFailed')} <button type="button" className={css.replyButton} onClick={()=>void refresh()}>{t('group.mentions.retry')}</button></span>}</div>
  {open&&<section id={panelId} className={css.messageSearchResults} aria-label={t('group.mentions.title')}><header><label><input ref={filter} type="checkbox" checked={unreadOnly} disabled={!!locating} onChange={event=>setUnreadOnly(event.target.checked)}/>{t('group.mentions.unreadOnly')}</label><button type="button" className={css.iconButton} aria-label={t('group.mentions.close')} onClick={close}><X size={15}/></button></header>
   {locationFailure&&<p role="status">{t('group.mentions.locateFailed')} <button type="button" disabled={!!locating} onClick={()=>void locateItem(locationFailure)}>{t('group.mentions.retry')}</button></p>}
   {failed?<p role="status">{t('group.mentions.failed')} <button type="button" onClick={()=>void load()}>{t('group.mentions.retry')}</button></p>:busy&&!page?<p role="status">{t('group.mentions.loading')}</p>:page?.items.length===0?<p role="status">{t(unreadOnly?'group.mentions.noUnread':'group.mentions.empty')}</p>:page?.items.map(item=><button type="button" key={item.message.id} disabled={busy||!!locating} onClick={()=>void locateItem(item)}><span>{author(item)} · {time(item.message.createdAt)} · {t(item.rootId?'collaboration.panel.topic':'collaboration.view.discussion')}{item.unread&&' · '+t('group.mentions.new')}</span><strong>{item.excerpt}</strong></button>)}
   {page?.next&&!failed&&<button type="button" disabled={busy||!!locating} onClick={()=>void load(true)}>{t('group.mentions.more')}</button>}
  </section>}
 </div>
}
