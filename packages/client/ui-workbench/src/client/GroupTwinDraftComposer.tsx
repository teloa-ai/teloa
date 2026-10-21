import {useEffect,useMemo,useRef,useState,useSyncExternalStore} from 'react'
import type {TwinDraftApi} from './twin-drafts-api.js'
import {ContextDrawer} from './ContextDrawer.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {twinDraftCopy} from './i18n/locales/twin-drafts.js'
import css from './GroupTwinDraftComposer.module.css'

export type GroupTwinDraftComposerProps={api:TwinDraftApi;role:{id:string;version:number};group:{id:string;name:string};message:{id:string;text:string};close:()=>void;openWorkspace:(roleId:string,draftId:string)=>void}
/** 本人准备正文并明确保存；原群消息只是来源，绝不默认复制为回复或自动发送。 */
export function GroupTwinDraftComposer({api,role,group,message,close,openWorkspace}:GroupTwinDraftComposerProps){
 const {locale}=useI18n(),copy=(key:Parameters<typeof twinDraftCopy>[1])=>twinDraftCopy(locale,key)
 useSyncExternalStore(api.subscribe,api.getSnapshot,api.getSnapshot)
 const target=useMemo(()=>({roleId:role.id,roleVersion:role.version,groupId:group.id,messageId:message.id}),[role.id,role.version,group.id,message.id])
 const origin=useMemo(()=>({api,target}),[api,target]),live=useRef(origin),mounted=useRef(true);live.current=origin
 const [busy,setBusy]=useState(false),[error,setError]=useState('')
 useEffect(()=>{mounted.current=true;setBusy(false);setError('');return()=>{mounted.current=false}},[origin])
 const saved=api.groupReply(target),body=saved?.body??'',pending=api.pending(),failure=api.recoveryError(),draft=saved?.draft
 const ours=pending?.operation==='create'&&pending.input.roleId===role.id&&pending.input.source.kind==='group'&&pending.input.source.groupId===group.id&&pending.input.source.messageId===message.id
 const stale=!!saved&&saved.roleVersion!==role.version
 const act=async(recover=false)=>{
  if(busy)return;setBusy(true);setError('')
  try{if(recover)await api.recover();else await api.saveGroupReply(target,group.name+' · '+copy('replyTitle'))}catch(error){if(mounted.current&&live.current===origin)setError(localizeWorkError(locale,error))}finally{if(mounted.current&&live.current===origin)setBusy(false)}
 }
 return <ContextDrawer title={copy('prepareReply')} close={()=>{mounted.current=false;close()}} padded>
  <div className={css.composer}>
   <p>{copy('prepareReplyHint')}</p>
   <p className={css.source}>{copy('group')} · {group.name}</p>
   <details><summary>{copy('sourcePreview')}</summary><blockquote>{message.text}</blockquote></details>
   {error&&<p role="alert">{error}</p>}
   {!!failure&&<p role="alert">{api.hasUnsavedDraft()?copy('storageFailed'):localizeWorkError(locale,failure)}</p>}
   {pending&&<p role="status">{copy(ours?'unknown':'otherPending')}</p>}
   {stale&&<div><p role="status">{copy('retired')}</p><button type="button" disabled={!!pending||busy||!!failure} onClick={()=>api.rebaseGroupReply(target)}>{copy('rebase')}</button></div>}
   <label>{copy('replyBody')}<textarea autoFocus rows={10} maxLength={8000} placeholder={copy('replyPlaceholder')} value={body} disabled={!!ours||busy} onChange={event=>{try{api.editGroupReply(target,event.target.value);setError('')}catch(error){setError(localizeWorkError(locale,error))}}}/></label>
   {draft&&<div role="status"><p>{copy('replySaved')}</p><button type="button" onClick={()=>openWorkspace(role.id,draft.id)}>{copy('openWorkspace')}</button></div>}
   <footer><button type="button" onClick={()=>{mounted.current=false;close()}}>{copy('closeReply')}</button>
    {ours?<button type="button" disabled={busy||!!failure} onClick={()=>void act(true)}>{copy('recover')}</button>:<button className={css.primary} type="button" disabled={!body.trim()||busy||!!pending||!!failure||stale||!!draft} onClick={()=>void act()}>{copy('saveReply')}</button>}
   </footer>
  </div>
 </ContextDrawer>
}
