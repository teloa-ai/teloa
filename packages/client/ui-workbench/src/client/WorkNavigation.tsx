import {useApplicationCapability} from './CapabilityNotice.js'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { Settings2, MessageSquare, Users, Plus, Search, X, Moon, Sun, ListTodo, CalendarClock, FolderOpen, Pin, PinOff, UserRound } from 'lucide-react'
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
import css from './WorkbenchFrame.module.css'

type Props={onSearch?:()=>void;view:WorkbenchView;colorScheme:'light'|'dark';actions:WorkbenchActions;work:BindingClient;management:ConversationManagement;useSessions:UseSessions;create:(options?:{chooseWorkspace?:boolean})=>void;creating:boolean;needCount:number;attentionKnown?:boolean;createTask:()=>void;createGroup:()=>void;openTwin:()=>Promise<void>;setTheme:(value:'light'|'dark')=>void;businessShortcuts?:readonly BusinessShortcut[];businessScopeNames?:Readonly<Record<string,string>>;businessTarget?:BusinessTarget;openBusinessShortcut?:(target:BusinessShortcut['target'])=>void;unpinBusinessShortcut?:(target:BusinessShortcut['target'])=>void;businessDashboardTitles?:Readonly<Record<string,string>>}
const shortcutSectionKey={overview:'business.home.title',projects:'business.section.projects',data:'business.section.data',work:'business.section.work',analysis:'business.section.analysis',execution:'business.section.execution',dashboards:'business.section.dashboards'} as const
/** 固定的看板在左栏显示「范围 · 看板标题」：标题表以 `businessDashboardTitleKey` 为键，没读到标题时显示看板标识。 */
export const businessDashboardTitleKey=(scope:string,dashboardId:string)=>JSON.stringify([scope,dashboardId])
export function WorkNavigation({onSearch,view,colorScheme,actions,work,management,useSessions,create,creating,needCount,attentionKnown=true,createTask,createGroup,openTwin,setTheme,businessShortcuts=[],businessScopeNames={},businessTarget,openBusinessShortcut=()=>{},unpinBusinessShortcut=()=>{},businessDashboardTitles={}}:Props){
 const groupsAllowed=useApplicationCapability('groups')
  const {locale,t}=useI18n()
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
  const startTwin=()=>{
    if(openingTwin.current||creating)return
    openingTwin.current=true;setError(undefined);setOpening(true)
    void openTwin().catch(error=>setError(localizeWorkError(locale,error))).finally(()=>{openingTwin.current=false;setOpening(false)})
  }
  const [shortcutsExpanded,setShortcutsExpanded]=useState(false)
  const [newWorkMenuOpen,setNewWorkMenuOpen]=useState(false)
  const newWorkGroup=useRef<HTMLDivElement>(null),newWorkTrigger=useRef<HTMLButtonElement>(null),newWorkMenu=useRef<HTMLDivElement>(null)
  useEffect(()=>{if(newWorkMenuOpen)newWorkMenu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus()},[newWorkMenuOpen])
  const closeNewWorkMenu=()=>{setNewWorkMenuOpen(false);newWorkTrigger.current?.focus()}
  useDismissible(newWorkGroup,newWorkMenuOpen,closeNewWorkMenu)
  const fromNewWorkMenu=(action:()=>void)=>{setNewWorkMenuOpen(false);action()}
  const rows=managed.baseline?presentConversations(directory.rows,Object.values(native),'','all').filter(row=>row.status!=='blank'&&row.conversation.status==='ready'&&!managed.archived.includes(row.conversation.sessionId)&&!hiddenRecentIds.includes(row.conversation.sessionId)).slice(0,3):[]
  const activeShortcutKey=view==='spaces'&&businessTarget?businessShortcutKey({scope:businessTarget.scope,section:businessTarget.section,...(businessTarget.section==='dashboards'&&businessTarget.dashboardId?{dashboardId:businessTarget.dashboardId}:{})}):undefined
  return <>
  <aside className={css.navigation} aria-label={t('navigation.main')}>
    <WorkbenchNavigationBrand product={application.product} colorScheme={colorScheme} onClose={actions.closeNavigation}/>
    <div ref={newWorkGroup} className={css.newWorkGroup}>
      <button ref={newWorkTrigger} type="button" className={css.newWork} aria-label={t('navigation.new')} aria-haspopup="menu" aria-expanded={newWorkMenuOpen} aria-controls="teloa-new-work-menu" disabled={creating} onClick={()=>setNewWorkMenuOpen(value=>!value)}><Plus size={16} aria-hidden/><span>{t(creating?'navigation.creating':'navigation.new')}</span></button>
      {newWorkMenuOpen&&<div ref={newWorkMenu} id="teloa-new-work-menu" className={css.newWorkMenu} role="menu" aria-label={t('navigation.moreCreate')} onKeyDown={event=>{
        if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key))return
        event.preventDefault()
        const items=Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')),current=items.indexOf(document.activeElement as HTMLButtonElement)
        const next=event.key==='Home'?0:event.key==='End'?items.length-1:(current+(event.key==='ArrowDown'?1:-1)+items.length)%items.length
        items[next]?.focus()
      }}>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>create())}><MessageSquare size={15}/><span>{t('navigation.newConversation')}</span></button>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(createTask)}><ListTodo size={15}/><span>{t('navigation.newTask')}</span></button>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>actions.openPlans())}><CalendarClock size={15}/><span>{t('navigation.newContinuous')}</span></button>
        <button type="button" role="menuitem" disabled={!groupsAllowed} onClick={()=>{if(applicationPresentation.can('groups'))fromNewWorkMenu(createGroup)}}><Users size={15}/><span>{t('home.action.newGroup')}</span></button>
        {!hostAssigned&&<>
        <div className={css.newWorkMenuDivider}/>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>create({chooseWorkspace:true}))}><FolderOpen size={15}/><span>{t('conversationDialog.otherLocation')}</span></button>
        <button type="button" role="menuitem" onClick={()=>fromNewWorkMenu(()=>actions.openDirectory())}><Settings2 size={15}/><span>{t('conversationDialog.manage')}</span></button>
        </>}
      </div>}
    </div>
    <button type="button" className={css.searchNav} aria-label={t('navigation.search')} onClick={onSearch||actions.focusConversationSearch}><Search size={15}/><span>{t('navigation.search')}</span><kbd>⌘ K</kbd></button>
    <div className={css.navScroll}>
    <WorkbenchNavigationItems view={view} needCount={needCount} attentionKnown={attentionKnown} onSelect={id=>id==='attention'?actions.openAttention():id==='plans'?actions.openPlans({kind:'plans'}):id==='messages'?actions.openConversationDirectory():id==='resources'?actions.openResources():id==='market'?actions.openMarket():actions.navigate(id)}/>
    {businessShortcuts.length>0&&<section className={css.shortcutNav} aria-label={t('navigation.shortcuts')}><div className={css.navLabel}>{t('navigation.shortcuts')}</div>{(shortcutsExpanded?businessShortcuts:businessShortcuts.slice(0,3)).map(shortcut=>{const scope=businessScopeNames[shortcut.target.scope]??shortcut.target.scope,dashboardId=shortcut.target.dashboardId,section=shortcut.target.section==='overview'?'':dashboardId?businessDashboardTitles[businessDashboardTitleKey(shortcut.target.scope,dashboardId)]??dashboardId:t(shortcutSectionKey[shortcut.target.section]),title=section?`${scope} · ${section}`:scope,key=businessShortcutKey(shortcut.target),active=key===activeShortcutKey;return <div key={key} className={clsx(css.shortcutRow,active&&css.active)}><button type="button" className={css.shortcutOpen} aria-current={active?'page':undefined} aria-label={t('navigation.shortcut.open',{title})} onClick={()=>openBusinessShortcut(shortcut.target)}><Pin size={14}/><span>{title}</span></button><button type="button" className={css.shortcutRemove} aria-label={t('navigation.shortcut.unpin')} title={t('navigation.shortcut.unpin')} onClick={()=>unpinBusinessShortcut(shortcut.target)}><PinOff size={14}/></button></div>})}{businessShortcuts.length>3&&<button type="button" className={css.shortcutMore} aria-expanded={shortcutsExpanded} onClick={()=>setShortcutsExpanded(value=>!value)}>{t('navigation.shortcuts.more',{count:businessShortcuts.length})}</button>}</section>}
    {rows.length>0&&<div className={css.recentNav}><div className={css.navLabel}>{t('navigation.recent')}</div>{rows.map(({conversation,title})=><div key={conversation.id} className={css.recentRow}><button type="button" className={css.recentOpen} disabled={!managed.ready||opening} onClick={()=>{setError(undefined);setOpening(true);void work.openConversation(conversation).then(()=>{if(work.getSnapshot().sessionId===conversation.sessionId){actions.navigate('messages');if(window.matchMedia('(max-width:740px)').matches)actions.closeSidebar()}}).catch(error=>setError(localizeWorkError(locale,error))).finally(()=>setOpening(false))}}><span className={css.recentDot}/><span>{title}</span></button><button type="button" className={css.recentRemove} aria-label={t('navigation.recent.remove')} title={t('navigation.recent.remove')} onClick={event=>{event.stopPropagation();recentWorkHidden.hide(conversation.sessionId);setHiddenRecentIds(current=>current.includes(conversation.sessionId)?current:[...current,conversation.sessionId])}}><X size={13}/></button></div>)}</div>}{error&&<p role="alert" className={css.navError}>{error}</p>}
    </div>
    <div className={css.navFooter}>
      <button type="button" className={clsx(css.navItem,view==='settings'&&css.active)} onClick={actions.openDirectory}><Settings2 size={16}/>{t('navigation.v2.settings')}</button>
      <div className={css.account}><button type="button" className={clsx(css.profileButton,css.avatar)} aria-label={t('navigation.profileAria',{name:profile.displayName})} onClick={actions.openDirectory}>{profile.initials||<UserRound size={14} aria-hidden/>}</button><span className={css.accountText}><button type="button" className={css.twinLink} disabled={opening||creating} onClick={startTwin}><small>{t('navigation.twin')}</small></button></span><button type="button" className={css.iconButton} aria-label={t(colorScheme==='light'?'navigation.themeDark':'navigation.themeLight')} onClick={()=>setTheme(colorScheme==='light'?'dark':'light')}>{colorScheme==='light'?<Moon size={16}/>:<Sun size={16}/>}</button></div>
    </div>
  </aside>
  </>
}
