import {EmployeeAvatar} from './EmployeeAvatar.js'
import {ConversationPlanClock} from './ConversationPlanCard.js'
import type {ConversationPlanDirectory} from './conversation-plans.js'
import {useApplicationCapability} from './CapabilityNotice.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Settings2, MessageSquarePlus, Users, Plus, Search, X, ListPlus, Zap, FolderSync, FolderCog, Pin, PinOff, UserRound, Eye, EyeOff } from 'lucide-react'
import type { UseSessions } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkbenchActions, WorkbenchView } from './store.js'
import type { BindingClient } from './binding-client.js'
import type { ConversationManagement } from './conversation-management.js'
import { presentConversations } from './work-presentation.js'
import {WorkbenchNavigationBrand,WorkbenchNavigationItems} from './WorkbenchNavigationChrome.js'
import {usePersonalProfile} from './use-personal-profile.js'
import {applicationPresentation} from './application-presentation.js'
import {businessShortcutKey,type BusinessShortcut} from './personal-business-shortcuts.js'
import type {BusinessTarget} from './business-preview.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import {useDismissible} from './use-dismissible.js'
import {browserRecentWorkHiddenStore} from './recent-work-hidden.js'
import {dialogueCopy,dialogueErrorCopy} from './dialogue-copy.js'
import css from './WorkbenchFrame.module.css'

type Props={beforeNavigate?:(()=>Promise<boolean>)|undefined;marketApps?:boolean;assistantName?:string;renameAssistant?:(name:string)=>void;conversationPlans?:ConversationPlanDirectory;openAssistant?:()=>Promise<void>;assistantSelected?:boolean;assistantActive?:boolean;setAssistantActive?:(active:boolean)=>void;onSearch?:()=>void;view:WorkbenchView;colorScheme:'light'|'dark';actions:WorkbenchActions;work:BindingClient;management:ConversationManagement;useSessions:UseSessions;create:(options?:{chooseWorkspace?:boolean})=>void;creating:boolean;needCount:number;attentionKnown?:boolean;createTask:()=>void;createGroup:()=>void;openTwin:()=>Promise<void>;setTheme:(value:'light'|'dark')=>void;businessShortcuts?:readonly BusinessShortcut[];businessScopeNames?:Readonly<Record<string,string>>;businessTarget?:BusinessTarget;openBusinessShortcut?:(target:BusinessShortcut['target'])=>void;unpinBusinessShortcut?:(target:BusinessShortcut['target'])=>void;businessDashboardTitles?:Readonly<Record<string,string>>}
const shortcutSectionKey={overview:'business.home.title',projects:'business.section.projects',data:'business.section.data',work:'business.section.work',analysis:'business.section.analysis',execution:'business.section.execution',dashboards:'business.section.dashboards',employees:'navigation.team',groups:'collaboration.saved.title'} as const
/** 固定的看板在左栏显示「范围 · 看板标题」：标题表以 `businessDashboardTitleKey` 为键，没读到标题时显示看板标识。 */
export const businessDashboardTitleKey=(scope:string,dashboardId:string)=>JSON.stringify([scope,dashboardId])
export function WorkNavigation({beforeNavigate,marketApps=false,assistantName='Teloa',renameAssistant,conversationPlans,openAssistant,assistantSelected=false,assistantActive=false,setAssistantActive,onSearch,view,colorScheme,actions,work,management,useSessions,create,creating,needCount,attentionKnown=true,createTask,createGroup,openTwin,setTheme,businessShortcuts=[],businessScopeNames={},businessTarget,openBusinessShortcut=()=>{},unpinBusinessShortcut=()=>{},businessDashboardTitles={}}:Props){
 const groupsAllowed=useApplicationCapability('groups')
  const {locale,t}=useI18n()
  const navigate=(run:()=>void)=>{if(!beforeNavigate){run();return}void beforeNavigate().then(allowed=>{if(allowed)run()},error=>setError(localizeWorkError(locale,error)))}
  const assistantShortName=assistantName
  const assistantOptions=locale==='zh-Hant'?'小松鼠選項':locale.startsWith('zh')?'小松鼠选项':'Assistant options'
  const companionLabel=assistantActive?(locale==='zh-Hant'?'隱藏頁面助手':locale.startsWith('zh')?'隐藏页面助手':'Hide companion'):(locale==='zh-Hant'?'顯示頁面助手':locale.startsWith('zh')?'显示页面助手':'Show companion')
  const directory=useSyncExternalStore(work.subscribe,work.getDirectorySnapshot)
  const managed=useSyncExternalStore(management.subscribe,management.getSnapshot)
  const native=useSessions(value=>value.byId)
  const profile=usePersonalProfile()
  const application=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getSnapshot,applicationPresentation.getSnapshot)
  // 宿主分配执行位置时不提供更换与管理执行位置入口。
  const hostAssigned=useSyncExternalStore(applicationPresentation.subscribe,applicationPresentation.getExecutionPlacement,applicationPresentation.getExecutionPlacement)==='host-assigned'
  const [error,setError]=useState<string>(),[opening,setOpening]=useState(false)
  const recentWorkHidden=browserRecentWorkHiddenStore()
  const [hiddenRecentIds,setHiddenRecentIds]=useState<readonly string[]>(()=>recentWorkHidden.read())
  // state 要等下一次渲染才会反映到 disabled；ref 同步挡住同一帧内的双击，避免重复发起零历史会话创建。
  const openingTwin=useRef(false)
  const startTwin=()=>navigate(()=>{
    if(openingTwin.current||creating)return
    openingTwin.current=true;setError(undefined);setOpening(true)
    void openTwin().catch(error=>setError(localizeWorkError(locale,error))).finally(()=>{openingTwin.current=false;setOpening(false)})
  })
  const [shortcutsExpanded,setShortcutsExpanded]=useState(false)
  const [newWorkMenuOpen,setNewWorkMenuOpen]=useState(false)
  const newWorkGroup=useRef<HTMLDivElement>(null),newWorkTrigger=useRef<HTMLButtonElement>(null),newWorkMenu=useRef<HTMLDivElement>(null)
  useEffect(()=>{
    if(!newWorkMenuOpen)return
    const place=()=>{const menu=newWorkMenu.current,trigger=newWorkTrigger.current;if(!menu||!trigger)return;const box=trigger.getBoundingClientRect(),width=Math.min(240,window.innerWidth-24);menu.style.left=Math.max(12,Math.min(box.right-width,window.innerWidth-width-12))+'px';menu.style.top=Math.max(12,Math.min(box.bottom+6,window.innerHeight-menu.offsetHeight-12))+'px'}
    place();newWorkMenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus({preventScroll:true})
    const frame=requestAnimationFrame(place),observer=new ResizeObserver(place)
    if(newWorkMenu.current)observer.observe(newWorkMenu.current)
    window.addEventListener('resize',place);return()=>{cancelAnimationFrame(frame);observer.disconnect();window.removeEventListener('resize',place)}
  },[newWorkMenuOpen])
  const [assistantMenuOpen,setAssistantMenuOpen]=useState(false)
  const [assistantNaming,setAssistantNaming]=useState(false),[nameDraft,setNameDraft]=useState(assistantName),[nameError,setNameError]=useState('')
  const assistantNameAnchor=useRef<HTMLButtonElement>(null),nameInput=useRef<HTMLInputElement>(null),naming=useRef(false),openingAssistant=useRef(false),restoreNameFocus=useRef(false)
  const beginNaming=()=>{if(!renameAssistant)return;setAssistantMenuOpen(false);setNewWorkMenuOpen(false);setNameDraft(assistantName);setNameError('');naming.current=true;setAssistantNaming(true)}
  const cancelNaming=()=>{naming.current=false;restoreNameFocus.current=true;setAssistantNaming(false);setNameError('')}
  const saveName=(restoreFocus=false)=>{if(!naming.current)return;try{renameAssistant?.(nameDraft);naming.current=false;restoreNameFocus.current=restoreFocus;setAssistantNaming(false);setNameError('')}catch(cause){setNameError(dialogueErrorCopy(locale,cause))}}
  useEffect(()=>{if(assistantNaming){nameInput.current?.focus();nameInput.current?.select()}else if(restoreNameFocus.current){restoreNameFocus.current=false;assistantNameAnchor.current?.focus()}},[assistantNaming])
  const contextMenu=()=>{setNewWorkMenuOpen(false);setAssistantNaming(false);setAssistantMenuOpen(true)}
  const assistantGroup=useRef<HTMLDivElement>(null),assistantMenu=useRef<HTMLDivElement>(null)
  const closeAssistantMenu=()=>{setAssistantMenuOpen(false);assistantNameAnchor.current?.focus()}
  useDismissible(assistantGroup,assistantMenuOpen,closeAssistantMenu)
  useEffect(()=>{if(assistantMenuOpen)assistantMenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()},[assistantMenuOpen])
  const closeNewWorkMenu=()=>{setNewWorkMenuOpen(false);newWorkTrigger.current?.focus()}
  useDismissible(newWorkGroup,newWorkMenuOpen,closeNewWorkMenu)
  const fromNewWorkMenu=(action:()=>void)=>{newWorkTrigger.current?.focus();setNewWorkMenuOpen(false);navigate(action)}
  const rows=managed.baseline?presentConversations(directory.rows,Object.values(native),'','all').filter(row=>row.status!=='blank'&&row.conversation.status==='ready'&&!managed.archived.includes(row.conversation.sessionId)&&!hiddenRecentIds.includes(row.conversation.sessionId)).slice(0,3):[]
  const activeShortcutKey=view==='spaces'&&businessTarget?businessShortcutKey({scope:businessTarget.scope,section:businessTarget.section,...(businessTarget.section==='dashboards'&&businessTarget.dashboardId?{dashboardId:businessTarget.dashboardId}:{})}):undefined
  return <>
  <aside className={css.navigation} aria-label={t('navigation.main')}>
    <div className={css.navHeader}><WorkbenchNavigationBrand product={application.product} colorScheme={colorScheme} onClose={actions.closeNavigation}/>
    <div className={css.quickActions}><div ref={newWorkGroup} className={css.newWorkGroup}>
      <button ref={newWorkTrigger} type="button" className={css.newWork} aria-label={t('navigation.new')} title={t(creating?'navigation.creating':'navigation.new')} aria-haspopup="menu" aria-expanded={newWorkMenuOpen} aria-controls="teloa-new-work-menu" disabled={creating} onClick={()=>{setAssistantMenuOpen(false);setNewWorkMenuOpen(value=>!value)}}><Plus size={17} aria-hidden/></button>
      {newWorkMenuOpen&&<div ref={newWorkMenu} id="teloa-new-work-menu" className={css.newWorkMenu} role="menu" aria-label={t('navigation.moreCreate')} onKeyDown={event=>{
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
        event.preventDefault()
        const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')),current=items.indexOf(document.activeElement as HTMLButtonElement)
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
        items[next]?.focus()
      }}>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>create())}><MessageSquarePlus size={15}/><span>{t('navigation.newConversation')}</span></button>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(createTask)}><ListPlus size={15}/><span>{t('navigation.newTask')}</span></button>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>actions.openPlans())}><Zap size={15}/><span>{t('navigation.newContinuous')}</span></button>
        <button type="button" role="menuitem" disabled={!groupsAllowed} onClick={()=>{if(applicationPresentation.can('groups'))fromNewWorkMenu(createGroup)}}><Users size={15}/><span>{t('home.action.newGroup')}</span></button>
        {!hostAssigned&&<>
        <div className={css.newWorkMenuDivider}/>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>create({chooseWorkspace:true}))}><FolderSync size={15}/><span>{t('conversationDialog.otherLocation')}</span></button>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>actions.openDirectory())}><FolderCog size={15}/><span>{t('conversationDialog.manage')}</span></button>
        </>}
      </div>}
    </div>
    <button type="button" className={css.iconButton} aria-label={t('navigation.search')} title={t('navigation.search')+' · ⌘ K'} onClick={onSearch||(()=>actions.focusConversationSearch())}><Search size={17} aria-hidden/></button></div></div>
    <div ref={assistantGroup} className={css.assistantEntry}>
      {assistantNaming?<div className={clsx(css.assistantPrimary,css.assistantEditor,assistantSelected&&css.active)}><EmployeeAvatar assistant size="sm"/><input ref={nameInput} className={css.assistantNameInput} aria-label={dialogueCopy(locale,'renameAssistant')} aria-invalid={!!nameError} value={nameDraft} placeholder="Teloa" maxLength={40} onChange={event=>{setNameDraft(event.target.value);setNameError('')}} onBlur={()=>saveName()} onKeyDown={event=>{if(event.nativeEvent.isComposing)return;if(event.key==='Enter'){event.preventDefault();saveName(true)}else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();cancelNaming()}}}/></div>:<button ref={assistantNameAnchor} type="button" onDoubleClick={beginNaming} onContextMenu={event=>{event.preventDefault();contextMenu()}} onKeyDown={event=>{if(event.key==='F2'){event.preventDefault();beginNaming()}else if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10'){event.preventDefault();contextMenu()}}} className={clsx(css.assistantPrimary,assistantSelected&&css.active)} aria-current={assistantSelected?'page':undefined} disabled={creating||!managed.ready} aria-busy={openingAssistant.current} onClick={event=>{if(event?.detail>1||openingAssistant.current||creating||!managed.ready)return;navigate(()=>{if(!openAssistant){actions.navigate('home');return}openingAssistant.current=true;setError(undefined);setOpening(true);void openAssistant().catch(cause=>setError(localizeWorkError(locale,cause))).finally(()=>{openingAssistant.current=false;setOpening(false)})})}} aria-label={assistantName} title={assistantName}><EmployeeAvatar assistant size="sm"/><span>{assistantShortName}</span></button>}
      {setAssistantActive&&<button type="button" className={clsx(css.iconButton,css.assistantToggle)} aria-label={companionLabel} title={companionLabel} aria-pressed={assistantActive} onClick={()=>{setNewWorkMenuOpen(false);setAssistantMenuOpen(false);setAssistantActive(!assistantActive)}}>{assistantActive?<Eye size={16} aria-hidden/>:<EyeOff size={16} aria-hidden/>}</button>}
      {assistantMenuOpen&&renameAssistant&&<div ref={assistantMenu} id="teloa-assistant-menu" className={css.newWorkMenu} role="menu" aria-label={assistantOptions}><button type="button" role="menuitem" onClick={beginNaming}>{dialogueCopy(locale,'renameAssistant')}</button></div>}
      {nameError&&<p className={css.assistantNameError} role="alert">{nameError}</p>}
    </div>
    <div className={css.navScroll}>
    <WorkbenchNavigationItems view={view} needCount={needCount} attentionKnown={attentionKnown} onSelect={id=>navigate(()=>id==='attention'?actions.openAttention():id==='plans'?actions.openPlans({kind:'plans'}):id==='messages'?actions.openConversationDirectory():id==='resources'?actions.openResources():id==='market'?marketApps?actions.openMarketCategory('home'):actions.openMarket():actions.navigate(id))}/>
    {businessShortcuts.length>0&&<section className={css.shortcutNav} aria-label={t('navigation.shortcuts')}><div className={css.navLabel}>{t('navigation.shortcuts')}</div>{(shortcutsExpanded?businessShortcuts:businessShortcuts.slice(0,3)).map(shortcut=>{const scope=businessScopeNames[shortcut.target.scope]??shortcut.target.scope,dashboardId=shortcut.target.dashboardId,section=shortcut.target.section==='overview'?'':dashboardId?businessDashboardTitles[businessDashboardTitleKey(shortcut.target.scope,dashboardId)]??dashboardId:t(shortcutSectionKey[shortcut.target.section]),title=section?`${scope} · ${section}`:scope,key=businessShortcutKey(shortcut.target),active=key===activeShortcutKey;return <div key={key} className={clsx(css.shortcutRow,active&&css.active)}><button type="button" className={css.shortcutOpen} aria-current={active?'page':undefined} aria-label={t('navigation.shortcut.open',{title})} onClick={()=>navigate(()=>openBusinessShortcut(shortcut.target))}><Pin size={14}/><span>{title}</span></button><button type="button" className={css.shortcutRemove} aria-label={t('navigation.shortcut.unpin')} title={t('navigation.shortcut.unpin')} onClick={()=>unpinBusinessShortcut(shortcut.target)}><PinOff size={14}/></button></div>})}{businessShortcuts.length>3&&<button type="button" className={css.shortcutMore} aria-expanded={shortcutsExpanded} onClick={()=>setShortcutsExpanded(value=>!value)}>{t('navigation.shortcuts.more',{count:businessShortcuts.length})}</button>}</section>}
    {rows.length>0&&<div className={css.recentNav}><div className={css.navLabel}>{t('navigation.recent')}</div>{rows.map(({conversation,title})=><div key={conversation.id} className={css.recentRow}><button type="button" className={css.recentOpen} disabled={!managed.ready||opening} onClick={()=>navigate(()=>{setError(undefined);setOpening(true);void work.openConversation(conversation).then(()=>{if(work.getSnapshot().sessionId===conversation.sessionId){actions.navigate('messages');if(window.matchMedia('(max-width:740px)').matches)actions.closeSidebar()}}).catch(error=>setError(localizeWorkError(locale,error))).finally(()=>setOpening(false))})}><span className={css.recentDot}/><span>{conversation.purpose==='assistant'?assistantName:title}</span></button>{conversationPlans&&<ConversationPlanClock sessionId={conversation.sessionId} directory={conversationPlans}/>}<button type="button" className={css.recentRemove} aria-label={t('navigation.recent.remove')} title={t('navigation.recent.remove')} onClick={event=>{event.stopPropagation();recentWorkHidden.hide(conversation.sessionId);setHiddenRecentIds(current=>current.includes(conversation.sessionId)?current:[...current,conversation.sessionId])}}><X size={13}/></button></div>)}</div>}{error&&<p role="alert" className={css.navError}>{error}</p>}
    </div>
    {/* 个人头像进入我的分身；设置保留独立入口，个人资料仍在设置内管理。 */}
    <div className={css.navFooter}><div className={css.footerTools}>
      <button type="button" className={clsx(css.profileButton,css.avatar)} aria-label={t('navigation.twin')} title={profile.displayName+' · '+t('navigation.twin')} disabled={opening||creating} onClick={startTwin}>{profile.initials||<UserRound size={14} aria-hidden/>}</button><span className={css.footerSpacer}/>
      <button type="button" className={clsx(css.iconButton,view==='settings'&&css.active)} aria-label={t('navigation.v2.settings')} title={t('navigation.profileAria',{name:profile.displayName})} onClick={()=>navigate(actions.openDirectory)}><Settings2 size={16} aria-hidden/></button></div>
    </div>
  </aside>
  </>
}
