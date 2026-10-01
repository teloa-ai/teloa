import {useEffect,useLayoutEffect,useId,useRef,useState,useSyncExternalStore} from 'react'
import {ContactRound,X} from 'lucide-react'
import {useDismissible} from './use-dismissible.js'
import css from './RoleConversationIdentity.module.css'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

/**
 * 原生会话头部的岗位身份说明入口（M8）：「这条对话里，它以「{name}」的岗位身份回答。」
 *
 * 工作台外壳（WorkbenchFrame）知道哪条会话绑了哪个岗位，原生会话头部的槽位是另一棵 React 树，
 * 两边没有共同的 Provider；照 `saved-collaboration-drafts.ts` 的先例用一张模块级的小表搭桥，
 * 纯内存、跨挂载存活、不跨刷新。表里只放岗位显示名，不放 roleId——界面上不出现内部身份。
 * 独立侧栏会话没有主视图桥接时，按槽位 sessionId 读取已有岗位关联；不继承父会话身份。
 *
 * 同一行保留本人手动请求重新介绍；岗位正文由宿主按当前版本投影，不再由新会话自动发送。
 * `failures` 仍用于显示手动请求失败，成功后按 sessionId 清空。
 */
const identities=new Map<string,string>()
const reintroductions=new Map<string,()=>Promise<void>>()
const failures=new Map<string,string>()
const listeners=new Set<()=>void>()
const notify=()=>{for(const listener of listeners)listener()}

export const roleConversationIdentities={
 /** name 为 undefined 即摘掉这条会话的身份行（解绑、切换对象、组件卸载）；失败文案不跟着摘，它要等本人处理。 */
 write(sessionId:string,name:string|undefined,reintroduce?:()=>Promise<void>):void{
  if(name===undefined){identities.delete(sessionId);reintroductions.delete(sessionId)}
  else{identities.set(sessionId,name);if(reintroduce)reintroductions.set(sessionId,reintroduce)}
  notify()
 },
 read:(sessionId:string):string|undefined=>identities.get(sessionId),
 /** 重新自我介绍这个动作只在点击那一刻读，不进渲染快照，省掉一次跨树订阅。 */
 readReintroduce:(sessionId:string):(()=>Promise<void>)|undefined=>reintroductions.get(sessionId),
 /** message 为 undefined 即清空这条会话的引导语失败。 */
 fail(sessionId:string,message:string|undefined):void{
  if(failures.get(sessionId)===message)return
  if(message===undefined)failures.delete(sessionId)
  else failures.set(sessionId,message)
  notify()
 },
 readFailure:(sessionId:string):string|undefined=>failures.get(sessionId),
 subscribe(listener:()=>void):()=>void{listeners.add(listener);return()=>{listeners.delete(listener)}},
}

export function RoleConversationIdentity({sessionId,readIdentity}:PropsRuntime<'conversation.session.header.utilities'>&{readIdentity:(sessionId:string)=>Promise<string|undefined>}){
 const {t,locale}=useI18n()
 const activeName=useSyncExternalStore(roleConversationIdentities.subscribe,()=>roleConversationIdentities.read(sessionId),()=>undefined)
 const retryIntroduction=useSyncExternalStore(roleConversationIdentities.subscribe,()=>roleConversationIdentities.readReintroduce(sessionId),()=>undefined)
 const [resolved,setResolved]=useState<{sessionId:string;name:string|undefined}>()
 useEffect(()=>{
  setResolved(undefined)
  if(activeName!==undefined)return
  let active=true
  void readIdentity(sessionId).then(name=>{if(active)setResolved({sessionId,name})},()=>{if(active)setResolved({sessionId,name:undefined})})
  return()=>{active=false}
 },[sessionId,readIdentity,activeName])
 const name=activeName??(resolved?.sessionId===sessionId?resolved.name:undefined)
 const failure=useSyncExternalStore(roleConversationIdentities.subscribe,()=>roleConversationIdentities.readFailure(sessionId),()=>undefined)
 const [sending,setSending]=useState(false)
 const [done,setDone]=useState(false)
 const [open,setOpen]=useState(false),panelId=useId(),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null)
 useDismissible(root,open,()=>setOpen(false),source=>{if(source==='escape')trigger.current?.focus();return true})
 const [placement,setPlacement]=useState({left:0,width:320})
 useLayoutEffect(()=>{
  if(!open)return
  const place=()=>{const rect=root.current?.getBoundingClientRect();if(!rect)return;const width=Math.min(320,window.innerWidth-32),left=Math.max(16,Math.min(rect.right-width,window.innerWidth-width-16));setPlacement({left:left-rect.left,width})}
  place();window.addEventListener('resize',place)
  return()=>window.removeEventListener('resize',place)
 },[open])
 useEffect(()=>{setDone(false);setOpen(false)},[sessionId])
 useEffect(()=>{if(failure)setOpen(true)},[sessionId,failure])
 const reintroduce=async()=>{
  const run=roleConversationIdentities.readReintroduce(sessionId)
  if(!run)return
  setSending(true);setDone(false)
  try{await run();roleConversationIdentities.fail(sessionId,undefined);setDone(true)}
  catch(cause){roleConversationIdentities.fail(sessionId,localizeWorkError(locale,cause))}
  finally{setSending(false)}
 }
 if(name===undefined)return null
 return <div ref={root} className={css.identity}>
  <button ref={trigger} type="button" className={css.trigger} aria-label={t('role.conversation.details')} title={t('role.conversation.details')} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(value=>!value)}><ContactRound size={16} aria-hidden="true"/></button>
  {open&&<section id={panelId} className={css.panel} style={placement} aria-label={t('role.conversation.details')}>
   <header><strong>{t('role.conversation.details')}</strong><button type="button" aria-label={t('role.conversation.close')} onClick={()=>{setOpen(false);trigger.current?.focus()}}><X size={15} aria-hidden="true"/></button></header>
   <p>{t('role.conversation.identity',{name})}</p>
   {retryIntroduction&&<button type="button" disabled={sending} onClick={()=>void reintroduce()}>{t('role.conversation.reintroduce')}</button>}
   {failure&&<p role="alert">{failure}</p>}
   {done&&!failure&&<p role="status">{t('role.conversation.reintroduced')}</p>}
  </section>}
 </div>
}
