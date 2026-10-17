import {useEffect,useId,useState,useSyncExternalStore} from 'react'
import {ContactRound} from 'lucide-react'
import {ContextDrawer} from './ContextDrawer.js'
import css from './RoleConversationIdentity.module.css'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {useI18n} from './i18n/provider.js'

/**
 * 原生会话头部的岗位身份说明入口（M8）：「这条对话里，它以「{name}」的岗位身份回答。」
 *
 * 工作台外壳（WorkbenchFrame）知道哪条会话绑了哪个岗位，原生会话头部的槽位是另一棵 React 树，
 * 两边没有共同的 Provider；照 `saved-collaboration-drafts.ts` 的先例用一张模块级的小表搭桥，
 * 纯内存、跨挂载存活、不跨刷新。表里只放岗位显示名，不放 roleId——界面上不出现内部身份。
 * 独立侧栏会话没有主视图桥接时，按槽位 sessionId 读取已有岗位关联；不继承父会话身份。
 *
 * 身份详情只读取岗位信息，不持有发送请求，也不会在打开、切换或关闭时触发模型。
 */
const identities=new Map<string,string>()
const primaryEntries=new Set<string>()
const listeners=new Set<()=>void>()
const notify=()=>{for(const listener of listeners)listener()}

export const roleConversationIdentities={
 /** name 为 undefined 即摘掉这条会话的身份行（解绑、切换对象、组件卸载）。 */
 write(sessionId:string,name:string|undefined,primaryEntry=false):void{
  if(name===undefined){identities.delete(sessionId);primaryEntries.delete(sessionId)}
  else{identities.set(sessionId,name);if(primaryEntry)primaryEntries.add(sessionId);else primaryEntries.delete(sessionId)}
  notify()
 },
 read:(sessionId:string):string|undefined=>identities.get(sessionId),
 readPrimaryEntry:(sessionId:string):boolean=>primaryEntries.has(sessionId),
 subscribe(listener:()=>void):()=>void{listeners.add(listener);return()=>{listeners.delete(listener)}},
}

export function RoleConversationIdentity({sessionId,readIdentity}:PropsRuntime<'conversation.session.header.utilities'>&{readIdentity:(sessionId:string)=>Promise<string|undefined>}){
 const {t}=useI18n()
 const activeName=useSyncExternalStore(roleConversationIdentities.subscribe,()=>roleConversationIdentities.read(sessionId),()=>undefined)
 const primaryEntry=useSyncExternalStore(roleConversationIdentities.subscribe,()=>roleConversationIdentities.readPrimaryEntry(sessionId),()=>false)
 const [resolved,setResolved]=useState<{sessionId:string;name:string|undefined}>()
 useEffect(()=>{
  setResolved(undefined)
  if(activeName!==undefined)return
  let active=true
  void readIdentity(sessionId).then(name=>{if(active)setResolved({sessionId,name})},()=>{if(active)setResolved({sessionId,name:undefined})})
  return()=>{active=false}
 },[sessionId,readIdentity,activeName])
 const name=activeName??(resolved?.sessionId===sessionId?resolved.name:undefined)
 const [open,setOpen]=useState(false),panelId=useId()
 useEffect(()=>{setOpen(false)},[sessionId])
 useEffect(()=>{if(primaryEntry)setOpen(false)},[primaryEntry])
 // 主会话已有员工头像入口；没有外壳桥接的独立侧栏仍按自身会话读取身份。
 if(name===undefined||primaryEntry)return null
 return <div className={css.identity}>
  <button type="button" className={css.trigger} aria-label={t('role.conversation.details')} title={t('role.conversation.details')} aria-expanded={open} aria-controls={panelId} onClick={()=>setOpen(true)}><ContactRound size={16} aria-hidden="true"/></button>
  {open&&<ContextDrawer title={t('role.conversation.details')} close={()=>setOpen(false)}><section id={panelId} className={css.panel}>
   <p>{t('role.conversation.identity',{name})}</p>
  </section></ContextDrawer>}
 </div>
}
