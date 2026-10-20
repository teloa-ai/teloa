import {browserDialogueOrganization,dialogueEntryKey,type DialogueOrganization,type DialogueEntry,type DialogueType} from './dialogue-organization.js'
import {dialogueCopy,dialogueErrorCopy} from './dialogue-copy.js'
import {dialogueDragType,encodeDialogueDrag,resolveDialogueDrop} from './dialogue-directory-drag.js'
import {DialogueNameDialog,DialogueFolderMoveDialog,DialogueFolderAction} from './DialogueOrganizationDialogs.js'
import folderCss from './DialogueDirectory.module.css'
import type {ObjectConversationApi} from './object-conversation-api.js'
import type {PreviewRole} from './role-preview.js'
import {readDirectoryRoleIdentities} from './session-role-identity.js'
import {EmployeeAvatar} from './EmployeeAvatar.js'
import {TwinAvatar} from './TwinAvatar.js'
import {assistantConversationTitle} from './assistant-conversation.js'
import {twinDisplayName} from './team-presentation.js'
import {usePersonalProfile} from './use-personal-profile.js'
import {ConversationPlanClock} from './ConversationPlanCard.js'
import type {ConversationPlanDirectory} from './conversation-plans.js'
import {useApplicationCapability} from './CapabilityNotice.js'
import {applicationPresentation} from './application-presentation.js'
import {useToast} from './Toast.js'
import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { ArrowUp, ArrowDown, ArchiveRestore, Bot, ChevronRight, RefreshCw, Search, Users, Pin, Plus, X, MoreHorizontal } from 'lucide-react'
import clsx from 'clsx'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import {isReservedExecutionSessionId,type Conversation} from '@teloa/contract'
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
export function WorkDirectory({organization:providedOrganization,work,management,search,current,useSessions,onOpened,openResults,focusRequest,focusQuery,onFocusHandled,onClose,conversationPlans,groups,selectedGroup,openGroup,createGroup,onCreateConversation,creating=false,objectApi,roles=[]}:{organization?:DialogueOrganization;work:BindingClient;management:ConversationManagement;search:ConversationSearch;current:string|undefined;useSessions:UseSessions;onOpened:()=>void;openResults?:(sessionId:string)=>void;focusRequest:number;focusQuery?:string|undefined;onFocusHandled?:((request:number)=>void)|undefined;onClose:()=>void;conversationPlans?:ConversationPlanDirectory;groups:ConversationGroupDirectory;selectedGroup:string|undefined;openGroup:(id:string)=>void;createGroup:()=>void;onCreateConversation?:()=>void;creating?:boolean;objectApi?:Pick<ObjectConversationApi,'bySession'>;roles?:readonly PreviewRole[]}) {
 const groupsAllowed=useApplicationCapability('groups')
  const {t,locale,dateTime}=useI18n()
  const profile=usePersonalProfile()
  const [organization]=useState(()=>providedOrganization??browserDialogueOrganization())
  const preferences=useSyncExternalStore(organization.subscribe,organization.getSnapshot)
  const [folderNaming,setFolderNaming]=useState<{id?:string;name:string}>(),[folderMove,setFolderMove]=useState<{entry:DialogueEntry;title:string}>()
  const [folderNameDrafts,setFolderNameDrafts]=useState<Record<string,string>>({})
  const folderDraftKey=(id?:string)=>JSON.stringify(id??null)
  const beginFolderName=(name:string,id?:string)=>{const draft=folderNameDrafts[folderDraftKey(id)]??name;setFolderNaming(id===undefined?{name:draft}:{id,name:draft})}
  const dismissFolderName=(draft?:string)=>{
    if(draft!==undefined&&folderNaming)setFolderNameDrafts(previous=>({...previous,[folderDraftKey(folderNaming.id)]:draft}))
    setFolderNaming(undefined)
  }
  const [draggedKey,setDraggedKey]=useState<string>(),[dropFolder,setDropFolder]=useState<string>()
  const dragging=useRef<DialogueEntry>(),lastDrag=useRef(0),hoverFolder=useRef<string>(),expandTimer=useRef<ReturnType<typeof setTimeout>>()
  const clearHover=()=>{clearTimeout(expandTimer.current);expandTimer.current=undefined;hoverFolder.current=undefined;setDropFolder(undefined)}
  useEffect(()=>()=>clearTimeout(expandTimer.current),[])
  const directoryType=preferences.type
  const scopes=useBusinessScopes(),archiveRadioName=useId()
  const groupDirectory=useSyncExternalStore(groups.subscribe,groups.getSnapshot)
  useEffect(()=>{
    void groups.refreshAttention?.()
    const timer=setInterval(()=>{if(document.visibilityState!=='hidden')void groups.refreshAttention?.()},4000)
    return()=>clearInterval(timer)
  },[groups])
  const searchInput=useRef<HTMLInputElement>(null)
  const directory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot)
  const managed=useSyncExternalStore(management.subscribe,management.getSnapshot)
  // 宿主分配执行位置时不按执行位置筛选或手动排序，目录保持全部会话按最近活动排列。
  const hostAssigned=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getExecutionPlacement,applicationPresentation.getExecutionPlacement)==='host-assigned'
  const content=useSyncExternalStore(search.subscribe,search.getSnapshot)
  const native=useSessions(value=>value.byId)
  const nativeIds=useSessions(value=>value.ids)
  const [adopting,setAdopting]=useState(false)
  const [query,setQuery]=useState(''),[archived,setArchived]=useState(false),[target,setTarget]=useState<Target>()
  const [workspace,setWorkspace]=useState<DirectoryWorkspace>({kind:'all'}),[order,setOrder]=useState<'recent'|'manual'>('recent')
  const handledFocus=useRef(0)
  useEffect(()=>{
    if(focusRequest<=0||handledFocus.current===focusRequest)return
    handledFocus.current=focusRequest
    if(focusQuery!==undefined){setQuery(focusQuery);setArchived(false);setWorkspace({kind:'all'});setOrder('recent')}
    searchInput.current?.focus();onFocusHandled?.(focusRequest)
  },[focusRequest,focusQuery,onFocusHandled])
  const [drafts,setDrafts]=useState<Record<string,string>>({})
  const needle=query.trim(),available=managed.ready&&directory.status==='ready'
  const membership=JSON.stringify(directory.rows.filter(row=>row.status==='ready').map(row=>row.sessionId).sort())
  const phase=searchPhase(needle,available,content)
  const hits=phase==='ready'?new Map(content.items.map(item=>[item.sessionId,item.snippet])):undefined
  const selected=workspace.kind==='workspace'?managed.workspaces.find(row=>row.workspaceId===workspace.id):undefined
  const missing=workspace.kind==='workspace'&&managed.baseline&&!selected
  // 先以同一显示标题检索，再还原可信绑定；昵称不进入打开、重命名或排序写入的原会话对象。
  const originalRows=new Map<Conversation,Conversation>()
  const displayRows=directory.rows.map(row=>{
    if(row.purpose!=='assistant'||row.title!==assistantConversationTitle)return row
    const display={...row,title:preferences.assistantName};originalRows.set(display,row);return display
  })
  // 明确搜索仍保留已绑定的空消息会话；其保存成果不能因 DSH blank 提示被隐藏。
  const rows=managed.baseline?organizeConversations(presentConversations(displayRows,Object.values(native),query,'all',hits).map(item=>{const original=originalRows.get(item.conversation);return original?{...item,conversation:original}:item}).filter(item=>(item.status!=='blank'||!!needle)&&managed.archived.includes(item.conversation.sessionId)===archived),managed.workspaces,workspace,order):[]
  // 只读取当前可展示的单聊；同一目录代次按需补读尚未核验的身份，筛选回切不重复请求。
  // 真正刷新或读取端口变化仍重建核验代次，不跨代共用旧回包。
  const directoryRows=directory.rows
  // 仅群分类下不读隐藏单聊；当前打开的单聊仍核验一次，包括首条消息前尚未入列表的空白会话。
  const readyIds=rows.filter(row=>row.conversation.status==='ready').map(row=>row.conversation.sessionId)
  const currentReadId=current!==undefined&&directoryRows.some(row=>row.sessionId===current&&row.status==='ready')?current:undefined
  const roleReadIds=directoryType==='group'?(currentReadId?[currentReadId]:[]):[...new Set([...readyIds,...(currentReadId?[currentReadId]:[])])].sort(),roleIdsKey=JSON.stringify(roleReadIds),roleReadKey=JSON.stringify(roles.map(role=>[role.id,role.name,role.avatarKey,role.kind]))
  const [directoryRoles,setDirectoryRoles]=useState<{key:string;rows:typeof directoryRows|null;api:typeof objectApi;items:Record<string,PreviewRole>;checked:Record<string,true>}>({key:'',rows:null,api:undefined,items:{},checked:{}})
  const roleRead=useRef<{key:string;rows:typeof directoryRows;api:typeof objectApi;requested:Set<string>}>()
  useEffect(()=>{
    if(!objectApi||!available||!roles.length)return
    let read=roleRead.current
    if(!read||read.rows!==directoryRows||read.key!==roleReadKey||read.api!==objectApi){read={key:roleReadKey,rows:directoryRows,api:objectApi,requested:new Set()};roleRead.current=read}
    const ids=roleReadIds.filter(id=>!read.requested.has(id));if(!ids.length)return
    for(const id of ids)read.requested.add(id)
    const currentRead=read
    void readDirectoryRoleIdentities(ids,sessionId=>objectApi.bySession(sessionId),roles).then(items=>{
      if(roleRead.current!==currentRead)return
      setDirectoryRoles(previous=>{const same=previous.rows===currentRead.rows&&previous.key===currentRead.key&&previous.api===currentRead.api;return {key:currentRead.key,rows:currentRead.rows,api:currentRead.api,items:{...(same?previous.items:{}),...items},checked:{...(same?previous.checked:{}),...Object.fromEntries(ids.map(id=>[id,true] as const))}}})
    })
  },[objectApi,roleReadKey,roleIdsKey,directoryRows,available])
  useEffect(()=>()=>{roleRead.current=undefined},[])
  const currentRoles=directoryRoles.rows===directoryRows&&directoryRoles.key===roleReadKey&&directoryRoles.api===objectApi
  const roleIdentities=currentRoles?directoryRoles.items:{},roleChecked=currentRoles?directoryRoles.checked:{}
  // N48 分类只按真实员工会话关联（object-conversations 的 active role 链接）：有关联即员工单聊，未核实或无关联留在会话，不按标题猜身份。
  const directCategory=(sessionId:string):'session'|'employee'=>roleIdentities[sessionId]?'employee':'session'
  const groupRows=visibleSavedGroups(groupDirectory.items,query,'all',archived)
  const manual=workspace.kind==='workspace'&&order==='manual'&&!archived
  const unifiedRows=[
    ...rows.map(item=>({kind:'direct' as const,key:'direct:'+item.conversation.id,updatedAt:item.updatedAt,pinned:false,item})),
    ...groupRows.map(item=>({kind:'group' as const,key:'group:'+item.id,updatedAt:Date.parse(item.updatedAt),pinned:item.pinned,item})),
  ]
  const typedRows=unifiedRows.filter(entry=>directoryType===(entry.kind==='direct'?directCategory(entry.item.conversation.sessionId):'group'))
  if(!manual)typedRows.sort((a,b)=>Number(b.pinned)-Number(a.pinned)||b.updatedAt-a.updatedAt||a.key.localeCompare(b.key))
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
  const open=async(row:Conversation)=>{setError(undefined);try{if(await work.openConversation(row)==='opened')onOpened()}catch(error){setError(localizeWorkError(locale,error))}}
  const toast=useToast(),rowsRef=useRef<HTMLDivElement>(null)
  // L1 可撤销（B8）：归档不弹确认，原行收起后给「已归档 · 撤销」；撤销恢复原会话，分组归属与当前选中随之回到原处。
  const archive=async(row:Conversation,title:string)=>{
    setError(undefined);setNotice(undefined)
    if(Object.values(native).find(item=>item.id===row.sessionId)?.running){setError(t('workDirectory.archive.running'));return}
    try{await management.archive(row.sessionId)}catch(cause){setError(localizeWorkError(locale,cause));return}
    searchInput.current?.focus()
    toast.show({message:t('workDirectory.archive.toast',{title}),action:{label:t('workDirectory.archive.undo'),run:async()=>{
      try{await management.restore(row.sessionId)}catch(cause){toast.show({tone:'error',message:t('workDirectory.archive.undoFailed',{reason:localizeWorkError(locale,cause)})});return}
      requestAnimationFrame(()=>rowsRef.current?.querySelector<HTMLButtonElement>(`[data-session-id="${CSS.escape(row.sessionId)}"] button`)?.focus())
    }}})
  }
  const restore=async(id:string)=>{setError(undefined);setNotice(undefined);try{await management.restore(id);setNotice(dialogueCopy(locale,'restored'));searchInput.current?.focus()}catch(cause){setError(localizeWorkError(locale,cause))}}
  const statusLabel=(status:Parameters<typeof workStatusKey>[0])=>t(workStatusKey(status))
  const shortTime=(value:string|number)=>{
    const date=new Date(value),now=new Date()
    return dateTime(value,date.toDateString()===now.toDateString()?{hour:'2-digit',minute:'2-digit'}:{month:'numeric',day:'numeric',...(date.getFullYear()===now.getFullYear()?{}:{year:'2-digit'})})
  }
  const fullTime=(value:string|number)=>dateTime(value,{year:'numeric',month:'long',day:'numeric',hour:'2-digit',minute:'2-digit'})
  const selectType=(type:DialogueType)=>{try{organization.selectType(type)}catch(cause){setError(dialogueErrorCopy(locale,cause))}}
  // 跳到具体员工会话或群时选中对应分类，避免当前对象被分类隐藏；同一当前对象只跟随一次，之后本人可自行切换。
  const followedCurrent=useRef<string>()
  // 实际可见的单聊优先于残留的群目标；单聊身份读取结束（含读取失败或歧义，按未确认员工留在会话）后才跟随，群只在没有可见单聊时跟随。
  const currentCategory:DialogueType|undefined=current!==undefined?(roleIdentities[current]||roleChecked[current]||!roles.length||!objectApi?directCategory(current):undefined):selectedGroup!==undefined?'group':undefined
  const followKey=currentCategory&&JSON.stringify([selectedGroup??null,current??null,currentCategory])
  useEffect(()=>{
    if(!followKey||followedCurrent.current===followKey)return
    followedCurrent.current=followKey
    if(currentCategory&&currentCategory!==directoryType)selectType(currentCategory)
  },[followKey])
  const entryIdentity=(entry:typeof unifiedRows[number]):DialogueEntry=>entry.kind==='group'?{kind:'group',id:entry.item.id}:{kind:'session',id:entry.item.conversation.sessionId}
  const finishDrag=()=>{lastDrag.current=Date.now();dragging.current=undefined;setDraggedKey(undefined);clearHover()}
  const dragEntry=(entry:typeof unifiedRows[number])=>({
    draggable:!preferences.error,
    'data-dragging':draggedKey===entry.key?true:undefined,
    onDragStart:(event:React.DragEvent<HTMLDivElement>)=>{
      const button=event.target instanceof Element?event.target.closest('button'):null
      if(preferences.error||button&&!button.classList.contains(css.open??'')){event.preventDefault();return}
      dragging.current=entryIdentity(entry);setDraggedKey(entry.key)
      event.dataTransfer.effectAllowed='move';event.dataTransfer.setData(dialogueDragType,encodeDialogueDrag(dragging.current))
    },
    onDragEnd:finishDrag,
    onClickCapture:(event:React.MouseEvent<HTMLDivElement>)=>{if(dragging.current||Date.now()-lastDrag.current<200){event.preventDefault();event.stopPropagation()}},
  })
  const dropTarget=(id:string|null)=>({
    'data-dialogue-folder':id??'unfiled',
    'data-drop-target':dropFolder===(id??'unfiled')?true:undefined,
    onDragOver:(event:React.DragEvent<HTMLElement>)=>{
      const active=dragging.current
      if(preferences.error||!active||!typedRows.some(entry=>dialogueEntryKey(entryIdentity(entry))===dialogueEntryKey(active)))return
      event.preventDefault();event.dataTransfer.dropEffect='move'
      const key=id??'unfiled';if(hoverFolder.current===key)return
      clearHover();hoverFolder.current=key;setDropFolder(key)
      if(id&&organization.getSnapshot().folders.find(folder=>folder.id===id)?.collapsed)expandTimer.current=setTimeout(()=>{
        if(hoverFolder.current!==id)return
        try{if(organization.getSnapshot().folders.find(folder=>folder.id===id)?.collapsed)organization.toggleFolder(id)}catch(cause){setError(dialogueErrorCopy(locale,cause))}
      },450)
    },
    onDragLeave:(event:React.DragEvent<HTMLElement>)=>{if(!(event.relatedTarget instanceof Node)||!event.currentTarget.contains(event.relatedTarget))clearHover()},
    onDrop:(event:React.DragEvent<HTMLElement>)=>{
      const entry=resolveDialogueDrop(event.dataTransfer.getData(dialogueDragType),dragging.current,typedRows.map(entryIdentity))
      if(preferences.error||!entry)return
      event.preventDefault();event.stopPropagation();setError(undefined);setNotice(undefined)
      try{
        if((preferences.placements[dialogueEntryKey(entry)]??null)!==id)organization.move(entry,id)
        if(id&&organization.getSnapshot().folders.find(folder=>folder.id===id)?.collapsed)organization.toggleFolder(id)
      }catch(cause){setError(dialogueErrorCopy(locale,cause))}finally{finishDrag()}
    },
  })
  const renderEntry=(entry:typeof unifiedRows[number])=>{
      if(entry.kind==='group'){const group=entry.item,details=[scopes[group.scope]??group.scope,group.memberCount===undefined?undefined:t('collaboration.members.savedCount',{count:group.memberCount}),group.archived?t('status.archived'):undefined].filter(Boolean).join(' · ');return <div {...dragEntry(entry)} key={entry.key} className={clsx(css.row,directoryCss.row)} data-group-id={group.id} data-active={selectedGroup===group.id?true:undefined}><button type="button" className={css.open} aria-current={selectedGroup===group.id?'page':undefined} title={details} onClick={()=>openGroup(group.id)}><span className={css.mailRow}><span className={css.groupAvatar} aria-hidden="true"><Users size={16}/></span><span className={clsx(css.mailBody,directoryCss.rowBody)}><span className={css.rowTop}><strong>{group.name}</strong>{group.pinned&&<Pin size={12} aria-label={t('collaboration.action.pin')}/>}<time dateTime={group.updatedAt} title={fullTime(group.updatedAt)}>{shortTime(group.updatedAt)}</time></span><small className={directoryCss.summary}>{group.purpose||group.announcement||details}</small>{groupDirectory.attention?.filter(item=>item.groupId===group.id&&item.unreadCount>0).map(item=><small key={item.groupId} className={directoryCss.metadata}>{t('group.mentions.unread',{count:item.unreadCount})}{item.mentionCount>0&&' · '+t('group.mentions.badge',{count:item.mentionCount})}</small>)}</span></span></button><DialogueFolderAction kind="group" title={group.name} className={css.more} onMove={()=>setFolderMove({entry:{kind:'group',id:group.id},title:group.name})}/></div>}
      const {conversation:row,title,status,updatedAt,snippet}=entry.item
      const role=roleIdentities[row.sessionId],displayTitle=role?t('conversationDirectory.employeeTitle',{name:role.kind==='twin'?twinDisplayName(profile.displayName,t):role.name}):title
      const detail=[role?title:undefined,status==='idle'?undefined:status==='pending'?t('workDirectory.status.pendingRetry'):statusLabel(status)].filter(Boolean).join(' · ')
      return <div {...dragEntry(entry)} className={clsx(css.row,directoryCss.row)} data-session-id={row.sessionId} data-active={!archived&&row.sessionId===current?true:undefined} key={entry.key}>
        {archived?<><div className={clsx(css.archived,directoryCss.rowBody)}><span>{displayTitle}</span><small className={directoryCss.metadata}>{t('status.archived')}</small>{snippet!==undefined&&<small className={directoryCss.summary}>{t('workDirectory.contentMatch',{snippet})}</small>}</div><button type="button" className={css.more} aria-label={dialogueCopy(locale,'restore')+' · '+displayTitle} title={dialogueCopy(locale,'restore')} disabled={!managed.ready||!!managed.pending[row.sessionId]} onClick={()=>void restore(row.sessionId)}><ArchiveRestore size={16}/></button></>:<><button className={css.open} disabled={!managed.ready} type="button" title={role?displayTitle+' · '+title:displayTitle} aria-current={row.sessionId===current?'page':undefined} onClick={()=>void open(row)}>
          <span className={css.mailRow}>{role?.kind==='twin'?<TwinAvatar initials={profile.initials} size="sm"/>:role?.kind==='employee'?<EmployeeAvatar avatarKey={role.avatarKey} size="sm"/>:row.purpose==='assistant'?<EmployeeAvatar assistant size="sm"/>:<span className={css.avatar} aria-hidden="true">{(role?.name??title).slice(0,1)}<Bot size={10}/></span>}<span className={clsx(css.mailBody,directoryCss.rowBody)}><span className={css.rowTop}><strong>{displayTitle}</strong><time dateTime={new Date(updatedAt).toISOString()} title={fullTime(updatedAt)}>{shortTime(updatedAt)}</time></span>{detail&&<small className={directoryCss.metadata}>{detail}</small>}{snippet!==undefined&&<small className={directoryCss.summary}>{t('workDirectory.contentMatch',{snippet})}</small>}</span></span>
        </button>{conversationPlans&&<ConversationPlanClock sessionId={row.sessionId} directory={conversationPlans}/>}<ConversationActionMenu className={css.more} title={title} disabled={!managed.ready||row.status!=='ready'||status==='unknown'} results={openResults?()=>openResults(row.sessionId):undefined} choose={action=>{if(action==='archive')void archive(row,displayTitle);else setTarget({row,title:row.purpose==='assistant'?row.title:title,blank:status==='blank',action})}} organize={()=>setFolderMove({entry:{kind:'session',id:row.sessionId},title:displayTitle})}/>{manual&&<div className={css.orderButtons}><button type="button" aria-label={t('workDirectory.action.moveUpAria',{title})} disabled={!managed.ready||moving||!!managed.pending[row.sessionId]||row.status!=='ready'||!!needle||movable.indexOf(row.sessionId)<=0} onClick={()=>void move(row.sessionId,'up')}><ArrowUp size={14}/></button><button type="button" aria-label={t('workDirectory.action.moveDownAria',{title})} disabled={!managed.ready||moving||!!managed.pending[row.sessionId]||row.status!=='ready'||!!needle||movable.indexOf(row.sessionId)===movable.length-1} onClick={()=>void move(row.sessionId,'down')}><ArrowDown size={14}/></button></div>}</>}
      </div>
  }
  return <section data-teloa-pane="directory" className={clsx(css.directory,directoryCss.pane)} aria-label={t('shell.conversationDirectory')}>
    <div className={css.searchRow}>
    <label className={clsx(css.search,directoryCss.search)}><Search size={14}/><input ref={searchInput} aria-label={t('workDirectory.search.aria')} placeholder={t('conversationDirectory.search')} value={query} onChange={event=>setQuery(event.target.value)}/>{query&&<button type="button" aria-label={t('workDirectory.search.clear')} onClick={()=>setQuery('')}><X size={14}/></button>}</label>
    <DirectoryFilterPopover label={t('conversationDirectory.new')} icon={<Plus size={18}/>} closeOnSelect><div className={clsx(directoryCss.filterPanel,css.createPanel)}>
      {onCreateConversation&&<button type="button" disabled={creating} onClick={onCreateConversation}>{t('navigation.newConversation')}</button>}
      <button type="button" disabled={!groupsAllowed} onClick={()=>{if(applicationPresentation.can('groups'))createGroup()}}>{t('collaboration.action.new')}</button>
      <button type="button" disabled={!!preferences.error} onClick={()=>beginFolderName('')}>{dialogueCopy(locale,'createFolder')}</button>
      <button type="button" disabled={!available} onClick={()=>setAdopting(true)}>{t('workDirectory.adopt')}</button>
    </div></DirectoryFilterPopover>
<DirectoryFilterPopover label={t('conversationDirectory.filters')}><div className={directoryCss.filterPanel}><fieldset><legend>{t('conversationDirectory.state')}</legend><label><input type="radio" name={archiveRadioName} checked={!archived} onChange={()=>setArchived(false)}/>{t('workDirectory.tab.active')}</label><label><input type="radio" name={archiveRadioName} checked={archived} onChange={()=>setArchived(true)}/>{t('workDirectory.tab.archived')}</label></fieldset>{directoryType!=='group'&&!hostAssigned&&<><p className={css.filterScope}>{t('conversationDirectory.direct')}</p><fieldset><legend>{t('workDirectory.workspace.label')}</legend><select aria-label={t('workDirectory.workspace.filterAria')} value={workspace.kind==='workspace'?'workspace:'+workspace.id:workspace.kind} onChange={event=>{const value=event.target.value;setWorkspace(value==='all'?{kind:'all'}:value==='unassigned'?{kind:'unassigned'}:{kind:'workspace',id:value.slice(10)});setError(undefined);setNotice(undefined)}}><option value="all">{t('workDirectory.workspace.all')}</option><option value="unassigned">{t('workDirectory.workspace.unassigned')}</option>{managed.workspaces.map(row=><option key={row.workspaceId} value={'workspace:'+row.workspaceId}>{row.title}</option>)}{missing&&workspace.kind==='workspace'&&<option value={'workspace:'+workspace.id}>{t('workDirectory.workspace.removed')}</option>}</select></fieldset><fieldset><legend>{t('workDirectory.order.label')}</legend><select aria-label={t('workDirectory.order.aria')} value={workspace.kind==='workspace'?order:'recent'} disabled={workspace.kind!=='workspace'||missing} onChange={event=>setOrder(event.target.value as 'recent'|'manual')}><option value="recent">{t('workDirectory.order.recent')}</option><option value="manual">{t('workDirectory.order.manual')}</option></select></fieldset></>}<div className={css.panelActions}><button type="button" onClick={()=>{void work.refreshDirectory();void groups.refresh()}} disabled={directory.status==='loading'||groupDirectory.status==='loading'}><RefreshCw size={15}/>{t('workDirectory.refresh')}</button><button type="button" onClick={onClose}><X size={15}/>{t('workDirectory.close')}</button></div></div></DirectoryFilterPopover>
    </div>
    <div className={folderCss.types} role="group" aria-label={dialogueCopy(locale,'type')} onKeyDown={event=>{
      if(!['ArrowRight','ArrowLeft','Home','End'].includes(event.key))return
      const buttons=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button')),index=buttons.indexOf(event.target as HTMLButtonElement)
      if(index<0)return
      event.preventDefault()
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowRight'?1:-1)+buttons.length)%buttons.length
      selectType((['session','employee','group'] as const)[next]!);buttons[next]?.focus()
    }}>{(['session','employee','group'] as const).map(type=><button key={type} type="button" aria-pressed={directoryType===type} onClick={()=>selectType(type)}>{dialogueCopy(locale,type)}</button>)}</div>
    {preferences.error&&<p role="alert">{dialogueCopy(locale,'unavailable')} <button type="button" onClick={organization.refresh}>{t('common.retry')}</button></p>}
    {(archived||workspace.kind!=='all'||order==='manual')&&<p className={css.activeFilters}>{archived&&<span>{t('workDirectory.tab.archived')}</span>}{(workspace.kind!=='all'||order==='manual')&&<span>{t('conversationDirectory.direct')}: {workspaceLabel} · {orderLabel}</span>}</p>}
    <div className={css.directoryScroll}>
    {selected&&<small className={css.path}>{selected.path}</small>}
    {missing&&<p role="status">{t('workDirectory.workspace.removedNotice')}</p>}
    {manual&&<p>{t('workDirectory.order.scope')} {t(needle?'workDirectory.order.clearSearch':'workDirectory.order.instructions')}</p>}
    {notice&&<p role="status">{notice}</p>}
    {Boolean(error||directory.error)&&<p role="alert">{error??localizeWorkError(locale,directory.error)}</p>}
    {archived&&<p>{dialogueCopy(locale,'archiveHint')}</p>}
    {!managed.baseline?<p role="status">{t('workDirectory.syncing')}</p>:!managed.ready&&<p role="status">{t('workDirectory.managementUnavailable')}</p>}
    {phase==='loading'&&<p role="status">{t('workDirectory.contentSearch.loading')}</p>}
    {phase==='waiting'&&<p role="status">{t('workDirectory.contentSearch.waiting')}</p>}
    {phase==='failed'&&<p role="alert">{t('workDirectory.contentSearch.failed')} <button type="button" disabled={!available} onClick={()=>void search.run(needle)}>{t('workDirectory.contentSearch.retry')}</button></p>}
    {phase==='ready'&&content.hasMore&&<p role="status">{t('workDirectory.contentSearch.truncated')}</p>}
    {(groupDirectory.status==='idle'||groupDirectory.status==='loading')&&<p role="status">{t('collaboration.directory.loading')}</p>}
    {groupDirectory.status==='failed'&&<p role="alert">{t('conversationDirectory.groupFailed')} {localizeWorkError(locale,groupDirectory.error)} <button type="button" onClick={()=>void groups.refresh()}>{t('collaboration.action.refresh')}</button></p>}
    {groupDirectory.attentionFailed&&<p role="status">{t('group.mentions.summaryFailed')} <button type="button" onClick={()=>void groups.refreshAttention()}>{t('group.mentions.retry')}</button></p>}
    <div ref={rowsRef} className={clsx(css.rows,directoryCss.rows)} aria-label={t('navigation.v2.conversations')}>
     {preferences.folders.map(folder=>{const members=typedRows.filter(entry=>preferences.placements[dialogueEntryKey(entryIdentity(entry))]===folder.id);if(needle&&!members.length&&!draggedKey)return null;const expanded=!!needle||!folder.collapsed;return <section {...dropTarget(folder.id)} className={folderCss.folder} key={folder.id} aria-label={folder.name}><header><button type="button" aria-label={dialogueCopy(locale,expanded?'collapseFolder':'expandFolder')+' · '+folder.name} aria-expanded={expanded} disabled={!!needle} title={needle?dialogueCopy(locale,'searchExpanded'):undefined} onClick={()=>{try{organization.toggleFolder(folder.id)}catch(cause){setError(dialogueErrorCopy(locale,cause))}}}><ChevronRight size={14} aria-hidden className={expanded?folderCss.expanded:undefined}/><strong>{folder.name}</strong>{members.length>0&&<small>{members.length}</small>}</button><DirectoryFilterPopover label={folder.name} icon={<MoreHorizontal size={15}/>} closeOnSelect><div className={clsx(directoryCss.filterPanel,folderCss.folderMenu)}><button type="button" onClick={()=>beginFolderName(folder.name,folder.id)}>{dialogueCopy(locale,'renameFolder')}</button><button type="button" title={dialogueCopy(locale,'removeHint')} onClick={()=>{try{organization.removeFolder(folder.id);searchInput.current?.focus()}catch(cause){setError(dialogueErrorCopy(locale,cause))}}}>{dialogueCopy(locale,'removeFolder')}</button><small>{dialogueCopy(locale,'removeHint')}</small></div></DirectoryFilterPopover></header>{expanded&&<div>{members.map(renderEntry)}{members.length===0&&<p className={folderCss.empty}>{dialogueCopy(locale,!needle&&!archived?'dropHere':'emptyFilter')}</p>}</div>}</section>})}
     <section {...dropTarget(null)} className={folderCss.unfiledSection} aria-label={dialogueCopy(locale,'unfiled')}>
      {preferences.folders.length>0&&<div className={folderCss.unfiled}>{dialogueCopy(locale,'unfiled')}</div>}
      {typedRows.filter(entry=>!preferences.placements[dialogueEntryKey(entryIdentity(entry))]).map(renderEntry)}
      {draggedKey&&typedRows.every(entry=>preferences.placements[dialogueEntryKey(entryIdentity(entry))])&&<p className={folderCss.empty}>{dialogueCopy(locale,'move')}</p>}
     </section>
    </div>
    {managed.baseline&&!missing&&directory.status==='ready'&&groupDirectory.status==='ready'&&typedRows.length===0&&(phase==='idle'||phase==='ready'||phase==='failed')&&<p>{t(needle?(phase==='failed'?'workDirectory.empty.nameUnknown':content.hasMore?'workDirectory.empty.currentRange':'workDirectory.empty.noMatch'):archived?'workDirectory.empty.archived':workspace.kind==='all'?'workDirectory.empty.all':'workDirectory.empty.scope')}</p>}
    </div>
    {folderNaming&&<DialogueNameDialog title={dialogueCopy(locale,folderNaming.id?'renameFolder':'createFolder')} value={folderNaming.name} close={dismissFolderName} save={value=>{if(folderNaming.id)organization.renameFolder(folderNaming.id,value);else organization.createFolder(value);setFolderNameDrafts(previous=>{const next={...previous};delete next[folderDraftKey(folderNaming.id)];return next})}}/>}
    {folderMove&&<DialogueFolderMoveDialog {...folderMove} organization={organization} close={()=>setFolderMove(undefined)}/>}
    {adopting&&<AdoptConversationDialog management={management} available={available} close={()=>setAdopting(false)} candidates={nativeIds.flatMap(id=>native[id]?[native[id]!]:[]).filter(row=>row.origin!=='subagent'&&!isReservedExecutionSessionId(row.id)&&!directory.rows.some(item=>item.sessionId===row.id)&&!managed.archived.includes(row.id)).sort((a,b)=>b.updatedAt-a.updatedAt).map(row=>({id:row.id,title:row.title?.trim()||row.displayTitle?.trim()||t('workDirectory.untitledConversation'),workspace:managed.workspaces.find(item=>item.sessionIds.includes(row.id))?.title||t('workDirectory.workspace.unassigned')}))}/>}
    {target&&<ConversationActions key={target.row.id} target={target} candidates={nativeIds.flatMap(id=>native[id]?[native[id]!]:[]).filter(row=>row.parentId===target.row.sessionId&&row.origin!=='subagent'&&!managed.archived.includes(row.id)).map(row=>({id:row.id,title:row.title?.trim()||row.displayTitle?.trim()||t('workDirectory.untitledCopy')}))} management={management} title={drafts[target.row.id]??target.title} changeTitle={value=>setDrafts(previous=>({...previous,[target.row.id]:value}))} close={()=>setTarget(previous=>previous===target?undefined:previous)} open={async(row,signal)=>{const result=await work.openConversation(row,signal);if(signal.aborted)return;if(result!=='opened')throw Error(t('workDirectory.copy.switched'));setTarget(previous=>previous===target?undefined:previous);setQuery('');setArchived(false);onOpened()}}/>}
  </section>
}

const workStatusKey=(status:'pending'|'running'|'blank'|'idle'|'unknown')=>`workDirectory.status.${status}` as const
