import {useEffect,useRef,useState,useSyncExternalStore} from 'react'
import {pendingBuilderDrafts,type BusinessBuilderFlow} from './business-builder-flow.js'
import type {BusinessConversationBinding} from '@teloa/contract'
import {openDialog} from './dialog-focus.js'
import {useI18n} from './i18n/provider.js'
import dialog from './CreateConversationDialog.module.css'
import css from './BusinessBuilderDirectory.module.css'
import {FilePenLine,RefreshCw} from 'lucide-react'
import {BusinessDraftDiscard} from './BusinessDraftDiscard.js'
import {ToolbarIconButton} from './ToolbarIconButton.js'

/** 服务端精简目录是唯一草案列表；分页不拼接另一份本地正文目录。 */
export function BusinessBuilderDirectory({flow,open,recover,ready=true}:{recover?:(requestId:string)=>void;ready?:boolean;flow:BusinessBuilderFlow;open:(binding:BusinessConversationBinding)=>void}){
 const {t,dateTime}=useI18n(),state=useSyncExternalStore(flow.subscribe,flow.getSnapshot,flow.getSnapshot)
 let pending:ReturnType<BusinessBuilderFlow['pendingCreation']>|undefined,recoveryFailed=false
 try{pending=flow.pendingCreation()}catch{recoveryFailed=true}
 const [loading,setLoading]=useState(false),[failed,setFailed]=useState(false)
 const refresh=async(cursor?:string)=>{setLoading(true);setFailed(false);try{await flow.refreshDirectory(cursor)}catch{setFailed(true)}finally{setLoading(false)}}
 useEffect(()=>{void refresh()},[flow])
 // 已应用的草案已经变成正式业务；继续呈现「继续搭建」会让用户以为还没保存。
 const drafts=pendingBuilderDrafts(state.directory)
 if(drafts.length===0&&!pending&&!recoveryFailed&&!loading&&!failed&&!state.discardedDraft&&!state.directory?.nextCursor)return null
 return <section className={css.directory} aria-label={t('business.builder.directory')}>
  <header><h2>{t('business.builder.directory')}{drafts.length>0&&<span className={css.count}>{drafts.length}</span>}</h2><ToolbarIconButton label={t('business.records.refresh')} icon={RefreshCw} disabled={loading} onClick={()=>void refresh()}/></header>
  {pending&&recover&&<div><p>{pending.title}</p><button type="button" disabled={!ready} onClick={()=>recover(pending!.requestId)}>{t('business.builder.restore')}</button></div>}
  {recoveryFailed&&<p role="alert">{t('business.builder.error')}</p>}
  {loading&&<p role="status">{t('business.builder.loading')}</p>}
  {failed&&<p role="alert">{t('business.builder.error')} <button type="button" onClick={()=>void refresh()}>{t('common.retry')}</button></p>}
  {state.discardedDraft&&<p role="status">{t('business.builder.discarded')}</p>}
  {drafts.map(({binding,draft})=><div className={css.draftRow} key={binding.requestId}><button type="button" className={css.item} disabled={!ready} key={binding.requestId} onClick={()=>open(binding)}><FilePenLine size={16} aria-hidden/><strong>{draft?.title??binding.title}</strong><time dateTime={draft?.updatedAt??binding.updatedAt}>{dateTime(new Date(draft?.updatedAt??binding.updatedAt),{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</time><span className={css.go}>{t(binding.sessionId?'business.builder.continue':'business.builder.restore')}</span></button>{draft?.status==='draft'&&<BusinessDraftDiscard flow={flow} binding={binding} draft={draft} disabled={!ready||loading}/>}</div>)}
  {state.directory?.nextCursor&&<button type="button" disabled={loading} onClick={()=>void refresh(state.directory!.nextCursor)}>{t('business.records.more')}</button>}
 </section>
}

/** 只在既有 Flow 判定为同一会话草稿时出现；pending/unknown 没有绕过按钮。 */
export function BusinessBuilderSwitchDialog({stay,create,switching=false}:{stay:()=>void;create:()=>void;switching?:boolean}){
 const {t}=useI18n(),ref=useRef<HTMLDialogElement>(null)
 useEffect(()=>openDialog(ref.current),[])
 return <dialog ref={ref} className={dialog.dialog} aria-label={t('business.builder.keepDraft')} onCancel={event=>{event.preventDefault();stay()}}><h2>{t('business.builder.keepDraft')}</h2><p>{t('business.builder.keepDraftNote')}</p><div className={css.actions}><button type="button" onClick={stay}>{t('business.builder.stay')}</button><button type="button" onClick={create}>{t(switching?'business.daily.keepAndSwitch':'business.builder.newAnyway')}</button></div></dialog>
}
