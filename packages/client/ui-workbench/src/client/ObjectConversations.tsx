import {useEffect,useState,useSyncExternalStore} from 'react'
import type {Conversation,WorkError} from '@teloa/contract'
import type {UseSessions} from '@deepseek-ai/dsh-client-ui-session/client'
import {presentConversations} from './work-presentation.js'
import type {BindingClient} from './binding-client.js'
import type {ConversationManagement} from './conversation-management.js'
import type {ConversationObject,ObjectConversationLink} from './object-conversations.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import css from './ObjectConversations.module.css'

export function ObjectConversations({prepare,persistence,object,links,work,management,useSessions,link,unlink,open,create}:{prepare?:((conversation:Conversation)=>Promise<void>)|undefined;persistence?:{load:()=>Promise<void>;recover:()=>Promise<void>;pending:boolean;error:WorkError|undefined}|undefined;object:ConversationObject;links:readonly ObjectConversationLink[];work:BindingClient;management:ConversationManagement;useSessions:UseSessions;link:(conversation:Conversation)=>void|Promise<void>;unlink:(id:string)=>void|Promise<void>;open:(sessionId:string)=>Promise<void>;create:()=>void}){
 const {locale,t}=useI18n()
 const directory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot),managed=useSyncExternalStore(management.subscribe,management.getSnapshot)
 const native=useSessions(value=>value.byId)
 const titles=new Map(presentConversations(directory.rows,Object.values(native)).map(row=>[row.conversation.id,row.title]))
 const [loaded,setLoaded]=useState(!persistence)
 const [chosen,setChosen]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false)
 useEffect(()=>{let active=true;if(persistence){setLoaded(false);persistence.load().then(()=>{if(active)setLoaded(true)}).catch(cause=>{if(active)setError(localizeWorkError(locale,cause))})}return()=>{active=false}},[object.kind,object.id,locale])
 const blocked=busy||!loaded||!!persistence?.pending||!!persistence?.error
 const rows=links.filter(row=>row.kind===object.kind&&row.objectId===object.id)
 const candidates=directory.rows.filter(row=>row.status==='ready'&&!managed.archived.includes(row.sessionId)&&!rows.some(item=>item.conversationId===row.id))
 const act=async(run:()=>void|Promise<void>)=>{setBusy(true);setError('');try{await run()}catch(cause){setError(localizeWorkError(locale,cause))}finally{setBusy(false)}}
 return <section className={css.panel} aria-label={t('objectConversations.aria')}><header><h3>{t('objectConversations.title',{count:rows.length})}</h3><button type="button" disabled={!object.canStart||blocked} onClick={create}>{t(object.kind==='task'&&!rows.length?'objectConversations.continue':'objectConversations.create')}</button></header><p>{t(persistence?'objectConversations.saved':'objectConversations.preview')} {t('objectConversations.boundary')}</p>{persistence?.pending&&<button type="button" disabled={busy} onClick={()=>void act(persistence.recover)}>{t('objectConversations.recover')}</button>}{persistence?.error&&<p role="alert">{localizeWorkError(locale,persistence.error)} {t('recovery.nextStep')}</p>}
 {error&&<p role="alert">{error}</p>}{Boolean(directory.error)&&<p role="alert">{localizeWorkError(locale,directory.error)}</p>}
 <div className={css.controls}><label>{t('objectConversations.existing')}<select value={chosen} onChange={event=>setChosen(event.target.value)} disabled={!object.canStart||blocked}><option value="">{t('objectConversations.choose')}</option>{candidates.map(row=><option key={row.id} value={row.id}>{titles.get(row.id)||row.title} · {row.id.slice(0,8)}</option>)}</select></label><button type="button" disabled={!object.canStart||blocked||!chosen} onClick={()=>void act(async()=>{const row=candidates.find(value=>value.id===chosen);if(!row)throw Object.assign(Error(),{code:'teloa/source-unavailable'});await link(row);setChosen('')})}>{t('objectConversations.link')}</button><button type="button" disabled={busy} onClick={()=>void act(async()=>{await work.refreshDirectory();if(persistence){await persistence.load();setLoaded(true)}})}>{t('objectConversations.refresh')}</button></div>
 {!object.canStart&&<p>{t('objectConversations.readOnly')}</p>}
 {!rows.length&&<p>{t('objectConversations.empty')}</p>}
 <ul>{rows.map(row=>{const conversation=directory.rows.find(value=>value.id===row.conversationId&&value.sessionId===row.sessionId),taskRun=row.sessionId.startsWith('task-run-'),archived=managed.archived.includes(row.sessionId);return <li key={row.conversationId}><div><strong>{conversation?(titles.get(conversation.id)||conversation.title):taskRun?t('taskExecution.title'):t('objectConversations.unavailable')}</strong><small>{t(archived?'objectConversations.archived':row.objectVersion!==object.version?'objectConversations.changed':'objectConversations.independent')}</small></div><button type="button" disabled={busy||archived||(!conversation&&!taskRun)} onClick={()=>void act(()=>open(row.sessionId))}>{t('objectConversations.open')}</button>{prepare&&<button type="button" disabled={blocked||!object.canStart||!conversation||archived} onClick={()=>conversation&&void act(()=>prepare(conversation))}>{t('objectConversations.prepare')}</button>}<button type="button" disabled={blocked||!object.canStart} onClick={()=>void act(()=>unlink(row.conversationId))}>{t('objectConversations.unlink')}</button></li>})}</ul>
 </section>
}
