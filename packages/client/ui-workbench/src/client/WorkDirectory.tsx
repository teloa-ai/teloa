import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUp, ArrowDown, Bot, RefreshCw, Search, Users, Pin, Plus, X } from 'lucide-react'
import clsx from 'clsx'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { Conversation } from '@teloa/contract'
import type { BindingClient } from './binding-client.js'
import type { ConversationManagement } from './conversation-management.js'
import { searchPhase,type ConversationSearch } from './conversation-search.js'
import { ConversationActions, ConversationActionMenu, type ConversationActionTarget } from './ConversationActions.js'
import css from './WorkDirectory.module.css'
import { AdoptConversationDialog } from './AdoptConversationDialog.js'
import { presentConversations,organizeConversations,type DirectoryWorkspace } from './work-presentation.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import directoryCss from './DirectoryPane.module.css'
import {DirectoryFilterPopover} from './DirectoryFilterPopover.js'

import type {ConversationGroupDirectory} from './conversation-group-directory.js'
import {visibleSavedGroups} from './saved-collaboration-state.js'
import {useBusinessScopes} from './business-scope-context.js'

type Target=ConversationActionTarget
export function WorkDirectory({work,management,search,current,useSessions,onOpened,focusRequest,onClose,groups,selectedGroup,openGroup,createGroup,onCreateConversation,creating=false}:{work:BindingClient;management:ConversationManagement;search:ConversationSearch;current:string|undefined;useSessions:UseSessions;onOpened:()=>void;focusRequest:number;onClose:()=>void;groups:ConversationGroupDirectory;selectedGroup:string|undefined;openGroup:(id:string)=>void;createGroup:()=>void;onCreateConversation?:()=>void;creating?:boolean}) {
 const groupsAllowed=useApplicationCapability('groups')
  const {t,locale,dateTime}=useI18n()
  const scopes=useBusinessScopes(),archiveRadioName=useId()
  const groupDirectory=useSyncExternalStore(groups.subscribe,groups.getSnapshot)
  const searchInput=useRef<HTMLInputElement>(null),createMenu=useRef<HTMLDetailsElement>(null)
  useEffect(()=>{if(focusRequest>0)searchInput.current?.focus()},[focusRequest])
  const directory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot)
  const managed=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const content=useSyncExternalStore(search.subscribe,search.getSnapshot)
  const native=useSessions(value=>value.byId)
  const nativeIds=useSessions(value=>value.ids)
  const [adopting,setAdopting]=useState(false)
  const [query,setQuery]=useState(''),[archived,setArchived]=useState(false),[target,setTarget]=useState<Target>()
  const [workspace,setWorkspace]=useState<DirectoryWorkspace>({kind:'all'}),[order,setOrder]=useState<'recent'|'manual'>('recent')
  const [drafts,setDrafts]=useState<Record<string,string>>({})
  const needle=query.trim(),available=managed.ready&&directory.status==='ready'
  const membership=JSON.stringify(directory.rows.filter(row=>row.status==='ready').map(row=>row.sessionId).sort())
  const phase=searchPhase(needle,available,content)
  const hits=phase==='ready'?new Map(content.items.map(item=>[item.sessionId,item.snippet])):undefined
  const selected=workspace.kind==='workspace'?managed.workspaces.find(row=>row.workspaceId===workspace.id):undefined
  const missing=workspace.kind==='workspace'&&managed.baseline&&!selected
  const rows=managed.baseline?organizeConversations(presentConversations(directory.rows,Object.values(native),query,'all',hits).filter(item=>item.status!=='blank'&&managed.archived.includes(item.conversation.sessionId)===archived),managed.workspaces,workspace,order):[]
  const groupRows=visibleSavedGroups(groupDirectory.items,query,'all',archived)
  const manual=workspace.kind==='workspace'&&order==='manual'&&!archived
  const unifiedRows=[
    ...rows.map(item=>({kind:'direct' as const,key:'direct:'+item.conversation.id,updatedAt:item.updatedAt,pinned:false,item})),
    ...groupRows.map(item=>({kind:'group' as const,key:'group:'+item.id,updatedAt:Date.parse(item.updatedAt),pinned:item.pinned,item})),
  ]
  if(!manual)unifiedRows.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt||a.key.localeCompare(b.key))
  const movable=rows.filter(item=>item.conversation.status==='ready').map(item=>item.conversation.sessionId)
  const moving=Object.values(managed.pending).includes('move')
  const workspaceLabel=workspace.kind==='all'?t('workDirectory.workspace.all'):workspace.kind==='unassigned'?t('workDirectory.workspace.unassigned'):selected?.title??t('workDirectory.workspace.removed')
  const orderLabel=t(workspace.kind==='workspace'&&order==='manual'?'workDirectory.order.manual':'workDirectory.order.recent')
  useEffect(()=>{
    if(!needle||!available){search.clear();return}
    const timer=setTimeout(()=>void search.run(needle),200)
    return ()=>{clearTimeout(timer);search.clear()}
  },[needle,available,membership,search])
  const [error,setError]=useState<string>(),[notice,setNotice]=useState<string>()
  const move=async(id:string,direction:'up'|'down')=>{
    if(workspace.kind!=='workspace'||needle)return
    setError(undefined);setNotice(undefined)
    try{await management.move(id,workspace.id,direction,movable);setNotice(t('workDirectory.order.saved'))}catch(error){setError(localizeWorkError(locale,error))}
  }
  const open=async(row:Conversation)=>{setError(undefined);try{await work.openConversation(row);if(work.getSnapshot().sessionId===row.sessionId)onOpened()}catch(error){setError(localizeWorkError(locale,error))}}
  const statusLabel=(status:Parameters<typeof workStatusKey>[0])=>t(workStatusKey(status))
  return <section data-teloa-pane="directory" className={clsx(css.directory,directoryCss.pane)} aria-label={t('shell.conversationDirectory')}>
    <header className={clsx(directoryCss.header,css.compactHeader)}><div><h2>{t('navigation.v2.conversations')}</h2><span>{t('conversationDirectory.subtitle')}</span></div><details ref={createMenu} className={css.createMenu} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();if(createMenu.current){createMenu.current.open=false;createMenu.current.querySelector('summary')?.focus()}}}}><summary aria-label={t('conversationDirectory.new')} title={t('conversationDirectory.new')}><Plus size={18}/></summary><div>{onCreateConversation&&<button type="button" disabled={creating} onClick={()=>{if(createMenu.current){createMenu.current.querySelector('summary')?.focus();createMenu.current.open=false;}onCreateConversation()}}>{t('navigation.newConversation')}</button>}<button type="button" disabled={!groupsAllowed} onClick={()=>{if(!applicationPresentation.can('groups'))return;if(createMenu.current){createMenu.current.querySelector('summary')?.focus();createMenu.current.open=false;}createGroup()}}>{t('collaboration.action.new')}</button></div></details></header>
    <div className={css.searchRow}>
    <label className={clsx(css.search,directoryCss.search)}><Search size={14}/><input ref={searchInput} aria-label={t('workDirectory.search.aria')} placeholder={t('conversationDirectory.search')} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button type="button" aria-label={t('workDirectory.search.clear')} onClick={()=>setQuery('')}><X size={14}/></button>}</label>
<DirectoryFilterPopover label={t('conversationDirectory.filters')}><div className={directoryCss.filterPanel}><fieldset><legend>{t('conversationDirectory.state')}</legend><label><input type="radio" name={archiveRadioName} checked={!archived} onChange={()=>setArchived(false)}/>{t('workDirectory.tab.active')}</label><label><input type="radio" name={archiveRadioName} checked={archived} onChange={()=>setArchived(true)}/>{t('workDirectory.tab.archived')}</label></fieldset><p className={css.filterScope}>{t('conversationDirectory.direct')}</p><fieldset><legend>{t('workDirectory.workspace.label')}</legend><select aria-label={t('workDirectory.workspace.filterAria')} value={workspace.kind==='workspace'?'workspace:'+workspace.id:workspace.kind} onChange={event=>{const value=event.target.value;setWorkspace(value==='all'?{kind:'all'}:value==='unassigned'?{kind:'unassigned'}:{kind:'workspace',id:value.slice(10)});setError(undefined);setNotice(undefined)}}><option value="all">{t('workDirectory.workspace.all')}</option><option value="unassigned">{t('workDirectory.workspace.unassigned')}</option>{managed.workspaces.map(row=><option key={row.workspaceId} value={'workspace:'+row.workspaceId}>{row.title}</option>)}{missing&&workspace.kind==='workspace'&&<option value={'workspace:'+workspace.id}>{t('workDirectory.workspace.removed')}</option>}</select></fieldset><fieldset><legend>{t('workDirectory.order.label')}</legend><select aria-label={t('workDirectory.order.aria')} value={workspace.kind==='workspace'?order:'recent'} disabled={workspace.kind!=='workspace'||missing} onChange={event=>setOrder(event.target.value as 'recent'|'manual')}><option value="recent">{t('workDirectory.order.recent')}</option><option value="manual">{t('workDirectory.order.manual')}</option></select></fieldset><div className={css.panelActions}><button type="button" onClick={()=>{void work.refreshDirectory();void groups.refresh()}} disabled={directory.status==='loading'||groupDirectory.status==='loading'}><RefreshCw size={15}/>{t('workDirectory.refresh')}</button><button type="button" onClick={onClose}><X size={15}/>{t('workDirectory.close')}</button></div></div></DirectoryFilterPopover>
    </div>
    {(archived||workspace.kind!=='all'||order==='manual')&&<p className={css.activeFilters}>{archived&&<span>{t('workDirectory.tab.archived')}</span>}{(workspace.kind!=='all'||order==='manual')&&<span>{t('conversationDirectory.direct')}: {workspaceLabel} · {orderLabel}</span>}</p>}
    <div className={css.directoryScroll}>
    {selected&&<small className={css.path}>{selected.path}</small>}
    {missing&&<p role="status">{t('workDirectory.workspace.removedNotice')}</p>}
    {manual&&<p>{t('workDirectory.order.scope')} {t(needle?'workDirectory.order.clearSearch':'workDirectory.order.instructions')}</p>}
    {notice&&<p role="status">{notice}</p>}
    {Boolean(error||directory.error)&&<p role="alert">{error??localizeWorkError(locale,directory.error)}</p>}
    {archived&&<p>{t('workDirectory.archive.notice')}</p>}
    {!managed.baseline?<p role="status">{t('workDirectory.syncing')}</p>:!managed.ready&&<p role="status">{t('workDirectory.managementUnavailable')}</p>}
    {phase==='loading'&&<p role="status">{t('workDirectory.contentSearch.loading')}</p>}
    {phase==='waiting'&&<p role="status">{t('workDirectory.contentSearch.waiting')}</p>}
    {phase==='failed'&&<p role="alert">{t('workDirectory.contentSearch.failed')} <button type="button" disabled={!available} onClick={()=>void search.run(needle)}>{t('workDirectory.contentSearch.retry')}</button></p>}
    {phase==='ready'&&content.hasMore&&<p role="status">{t('workDirectory.contentSearch.truncated')}</p>}
    {(groupDirectory.status==='idle'||groupDirectory.status==='loading')&&<p role="status">{t('collaboration.directory.loading')}</p>}
    {groupDirectory.status==='failed'&&<p role="alert">{t('conversationDirectory.groupFailed')} {localizeWorkError(locale,groupDirectory.error)} <button type="button" onClick={()=>void groups.refresh()}>{t('collaboration.action.refresh')}</button></p>}
    <div className={clsx(css.rows,directoryCss.rows)} aria-label={t('navigation.v2.conversations')}>{unifiedRows.map(entry=>{
      if(entry.kind==='group'){const group=entry.item;return <div key={entry.key} className={clsx(css.row,directoryCss.row)} data-group-id={group.id} data-active={selectedGroup===group.id?true:undefined}><button type="button" className={css.open} aria-current={selectedGroup===group.id?'page':undefined} onClick={()=>openGroup(group.id)}><span className={css.mailRow}><span className={css.groupAvatar} aria-hidden="true"><Users size={16}/></span><span className={clsx(css.mailBody,directoryCss.rowBody)}><span className={css.rowTop}><strong>{group.name}</strong>{group.pinned&&<Pin size={12} aria-label={t('collaboration.action.pin')}/>}<time dateTime={group.updatedAt}>{dateTime(group.updatedAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time></span><small className={directoryCss.summary}>{group.announcement||t('collaboration.directory.noAnnouncement')}</small><small className={directoryCss.metadata}>{scopes[group.scope]??group.scope}{group.archived&&' · '+t('status.archived')}</small></span></span></button></div>}
      const {conversation:row,title,status,updatedAt,snippet}=entry.item
      return <div className={clsx(css.row,directoryCss.row)} data-session-id={row.sessionId} data-active={!archived&&row.sessionId===current?true:undefined} key={entry.key}>
        {archived?<div className={clsx(css.archived,directoryCss.rowBody)}><span>{title}</span><small className={directoryCss.metadata}>{t('status.archived')} · {row.sessionId}</small>{snippet!==undefined&&<small className={directoryCss.summary}>{t('workDirectory.contentMatch',{snippet})}</small>}</div>:<><button className={css.open} disabled={!managed.ready} type="button" aria-current={row.sessionId===current?'page':undefined} onClick={()=>void open(row)}>
          <span className={css.mailRow}><span className={css.avatar} aria-hidden="true">{title.slice(0,1)}<Bot size={10}/></span><span className={clsx(css.mailBody,directoryCss.rowBody)}><span className={css.rowTop}><strong>{title}</strong><time dateTime={new Date(updatedAt).toISOString()}>{dateTime(updatedAt,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</time></span><small className={directoryCss.metadata}>{status==='pending'?t('workDirectory.status.pendingRetry'):statusLabel(status)}</small>{snippet!==undefined&&<small className={directoryCss.summary}>{t('workDirectory.contentMatch',{snippet})}</small>}</span></span>
        </button><ConversationActionMenu className={css.more} title={title} disabled={!managed.ready||row.status!=='ready'||status==='unknown'} choose={action=>setTarget({row,title,blank:status==='blank',action})}/>{manual&&<div className={css.orderButtons}><button type="button" aria-label={t('workDirectory.action.moveUpAria',{title})} disabled={!managed.ready||moving||!!managed.pending[row.sessionId]||row.status!=='ready'||!!needle||movable.indexOf(row.sessionId)<=0} onClick={()=>void move(row.sessionId,'up')}><ArrowUp size={14}/></button><button type="button" aria-label={t('workDirectory.action.moveDownAria',{title})} disabled={!managed.ready||moving||!!managed.pending[row.sessionId]||row.status!=='ready'||!!needle||movable.indexOf(row.sessionId)===movable.length-1} onClick={()=>void move(row.sessionId,'down')}><ArrowDown size={14}/></button></div>}</>}
      </div>
    })}</div>
    {managed.baseline&&!missing&&directory.status==='ready'&&groupDirectory.status==='ready'&&unifiedRows.length===0&&(phase==='idle'||phase==='ready'||phase==='failed')&&<p>{t(needle?(phase==='failed'?'workDirectory.empty.nameUnknown':content.hasMore?'workDirectory.empty.currentRange':'workDirectory.empty.noMatch'):archived?'workDirectory.empty.archived':workspace.kind==='all'?'workDirectory.empty.all':'workDirectory.empty.scope')}</p>}
    </div>
    <footer className={clsx(css.directoryFoot,directoryCss.footer)}><button type="button" disabled={!available} onClick={()=>setAdopting(true)}>{t('workDirectory.adopt')}</button></footer>
    {adopting&&<AdoptConversationDialog management={management} available={available} close={()=>setAdopting(false)} candidates={nativeIds.flatMap(id=>native[id]?[native[id]!]:[]).filter(row=>!directory.rows.some(item=>item.sessionId===row.id)&&!managed.archived.includes(row.id)).sort((a,b)=>b.updatedAt-a.updatedAt).map(row=>({id:row.id,title:row.title?.trim()||row.displayTitle?.trim()||t('workDirectory.untitledConversation'),workspace:managed.workspaces.find(item=>item.sessionIds.includes(row.id))?.title||t('workDirectory.workspace.unassigned')}))}/>} 
    {target&&<ConversationActions key={target.row.id} target={target} running={Object.values(native).find(row=>row.id===target.row.sessionId)?.running??false} candidates={nativeIds.flatMap(id=>native[id]?[native[id]!]:[]).filter(row=>row.parentId===target.row.sessionId&&row.origin!=='subagent'&&!managed.archived.includes(row.id)).map(row=>({id:row.id,title:row.title?.trim()||row.displayTitle?.trim()||t('workDirectory.untitledCopy')}))} management={management} title={drafts[target.row.id]??target.title} changeTitle={value=>setDrafts(previous=>({...previous,[target.row.id]:value}))} close={()=>setTarget(previous=>previous===target?undefined:previous)} open={async(row,signal)=>{await work.openConversation(row,signal);if(signal.aborted)return;if(work.getSnapshot().sessionId!==row.sessionId)throw Error(t('workDirectory.copy.switched'));setTarget(previous=>previous===target?undefined:previous);setQuery('');setArchived(false);onOpened()}}/>}
  </section>
}

const workStatusKey=(status:'pending'|'running'|'blank'|'idle'|'unknown')=>`workDirectory.status.${status}` as const
