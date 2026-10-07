import {useEffect,useLayoutEffect,useRef,useState,type CSSProperties} from 'react'
import {createRoot} from 'react-dom/client'
import {flushSync} from 'react-dom'
import clsx from 'clsx'
import {ArrowUp,Menu,Moon,Plus,Settings2,Sun,UserRound} from 'lucide-react'
import {WorkbenchNavigationBrand,WorkbenchNavigationItems,primaryNavigation} from './WorkbenchNavigationChrome.js'
import type {WorkbenchView} from './store.js'
import {I18nProvider,useI18n} from './i18n/provider.js'
import type {TeloaI18n} from './i18n/index.js'
import {resolveProductLocale} from './i18n/locale.js'
import {translateMessage} from './i18n/messages.js'
import {prototypeThemes} from '../brand/prototype-theme.js'
import {guestCopy} from './guest-copy.js'
import {personalAvatarInitials,personalDisplayName} from './personal-identity.js'
import {installGuestStyles} from './guest-styles.js'
import {SettingsLayout} from './SettingsLayout.js'
import css from './WorkbenchFrame.module.css'
import guestCss from './GuestWorkbench.module.css'
import settingsCss from './SettingsShell.module.css'
import tokens from './theme-tokens.module.css'

export type GuestWorkbenchSettings=Readonly<{
 entries:readonly Readonly<{id:string;label:string;content:HTMLElement}>[]
 onClose:()=>void|Promise<void>
 onSelect?:(id:string)=>void
}>

export type GuestWorkbenchOptions=Readonly<{
 product:'Free'|'Pro'
 initialPrompt?:string
 maxPromptLength?:number
 styleNonce?:string
 onPromptChange:(prompt:string)=>void
 onStart:()=>void|Promise<void>
 onAccount:()=>void|Promise<void>
 settings?:GuestWorkbenchSettings
}>
export type GuestWorkbenchAccount=Readonly<{displayName:string|null}>
export type GuestWorkbenchHandle=Readonly<{dispose:()=>void;update:(input:Readonly<{prompt?:string;account?:GuestWorkbenchAccount|null}>)=>void;openSettings:(id?:string)=>void;closeSettings:()=>void}>
type GuestController={setPrompt?:(value:string)=>void;setAccount?:(value:GuestWorkbenchAccount|null)=>void;openSettings?:(id?:string)=>void;closeSettings?:()=>void}

/** 保持宿主节点与事件处理器原样；退出设置后归还节点，不复制业务表单。 */
function HostSettingsContent({element}:{element:HTMLElement}){
 const container=useRef<HTMLDivElement>(null)
 useLayoutEffect(()=>{
  const target=container.current
  if(!target)return
  const parent=element.parentNode,next=element.nextSibling,hidden=element.hidden
  element.hidden=false
  target.appendChild(element)
  return ()=>{
   element.hidden=hidden
   if(element.parentNode!==target)return
   if(parent)parent.insertBefore(element,next?.parentNode===parent?next:null)
   else target.removeChild(element)
  }
 },[element])
 return <div ref={container}/>
}

function readGuestSettings(element:HTMLElement,settings:GuestWorkbenchSettings|undefined):GuestWorkbenchSettings|undefined{
 if(settings===undefined)return
 const ElementClass=element.ownerDocument.defaultView?.HTMLElement
 const ids=new Set<string>(),contents=new Set<HTMLElement>()
 if(!settings||!Array.isArray(settings.entries)||settings.entries.length===0||typeof settings.onClose!=='function'||settings.onSelect!==undefined&&typeof settings.onSelect!=='function'||!ElementClass)throw Error('设置目录无效。')
 const entries=settings.entries.map(row=>{
  if(!row||typeof row.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(row.id)||ids.has(row.id)||typeof row.label!=='string'||!row.label.trim()||row.label.length>256||/[\u0000-\u001f\u007f]/.test(row.label)||!(row.content instanceof ElementClass)||row.content.ownerDocument!==element.ownerDocument||row.content.contains(element)||element.contains(row.content)||contents.has(row.content))throw Error('设置目录无效。')
  ids.add(row.id);contents.add(row.content)
  return Object.freeze({id:row.id,label:row.label,content:row.content})
 })
 return Object.freeze({entries:Object.freeze(entries),onClose:settings.onClose,...(settings.onSelect?{onSelect:settings.onSelect}:{})})
}

/** 只复用工作台的呈现层；不装配本人资料、导航存储、RPC 或执行服务。 */
function GuestWorkbench({options,controller}:{options:GuestWorkbenchOptions;controller:GuestController}){
 const {locale,t}=useI18n(),copy=guestCopy(locale)
 const [view,setView]=useState<WorkbenchView>('home'),[prompt,setPrompt]=useState(options.initialPrompt??'')
 const [colorScheme,setColorScheme]=useState<'light'|'dark'>(()=>globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light')
 const [navOpen,setNavOpen]=useState(false),[pending,setPending]=useState(false),[notice,setNotice]=useState<string>()
 const [account,setAccount]=useState<GuestWorkbenchAccount|null>(null)
 const [selectedSettings,setSelectedSettings]=useState(options.settings?.entries[0]?.id)
 const active=useRef(false),closing=useRef(false),pendingNavigation=useRef<WorkbenchView>(),previousView=useRef<WorkbenchView>('home'),currentView=useRef(view),frame=useRef<HTMLDivElement>(null)
 currentView.current=view
 controller.setPrompt=setPrompt
 controller.setAccount=setAccount
 const accountName=account?personalDisplayName(account.displayName??'',copy.account):copy.guest
 const initials=account?personalAvatarInitials(account.displayName??''):''
 const accountLabel=account?copy.account:copy.login
 const openSettings=(id?:string)=>{
  const entries=options.settings?.entries
  const selected=id??selectedSettings??entries?.[0]?.id
  if(!entries||!entries.some(row=>row.id===selected))throw Error('设置目录不可用。')
  if(currentView.current!=='settings')previousView.current=currentView.current
  currentView.current='settings';setSelectedSettings(selected);setView('settings');setNavOpen(false);setNotice(undefined)
  if(selected!==undefined)options.settings?.onSelect?.(selected)
 }
 const closeSettings=()=>{
  if(currentView.current!=='settings'||!options.settings)return
  const next=pendingNavigation.current??previousView.current
  pendingNavigation.current=undefined;closing.current=false
  currentView.current=next;setView(next);setNavOpen(false);setNotice(undefined);setPending(false)
 }
 controller.openSettings=openSettings
 controller.closeSettings=closeSettings
 const select=(next:WorkbenchView)=>{
  if(next==='settings'&&options.settings){openSettings();return}
  if(currentView.current==='settings'&&options.settings){
   if(active.current||closing.current)return
   pendingNavigation.current=next;request('settings-close');return
  }
  currentView.current=next;setView(next);setNavOpen(false);setNotice(undefined)
 }
 const request=(kind:'start'|'account'|'settings-close')=>{
  if(active.current||closing.current)return
  if(kind==='start'&&!prompt.trim()){setNotice(copy.emptyPrompt);return}
  if(kind==='settings-close')closing.current=true
  active.current=true;setPending(true);setNotice(undefined)
  Promise.resolve().then(()=>kind==='start'?options.onStart():kind==='account'?options.onAccount():options.settings?.onClose()).catch(()=>{
   if(kind==='settings-close'){closing.current=false;pendingNavigation.current=undefined}
   setNotice(copy.failed)
  }).finally(()=>{active.current=false;setPending(closing.current)})
 }
 useEffect(()=>{
  if(view!=='settings'||!options.settings||!frame.current)return
  const document=frame.current.ownerDocument
  const escape=(event:KeyboardEvent)=>{
   if(event.key!=='Escape'||event.defaultPrevented||!frame.current?.contains(event.target as Node)||event.target instanceof Element&&event.target.closest('dialog[open],[role="dialog"][aria-modal="true"]'))return
   event.preventDefault();request('settings-close')
  }
  document.addEventListener('keydown',escape)
  return ()=>document.removeEventListener('keydown',escape)
 })
 const row=primaryNavigation.find(([id])=>id===view),title=row?t(row[1]):t('navigation.v2.settings'),Icon=row?.[2]??Settings2
 const settingsEntry=options.settings?.entries.find(row=>row.id===selectedSettings)??options.settings?.entries[0]
 return <div ref={frame} data-guest-workbench data-theme={colorScheme} className={clsx(tokens.tokens,css.frame,guestCss.guest,navOpen&&css.navOpen)} style={{...prototypeThemes[colorScheme],colorScheme} as CSSProperties}>
  <aside className={css.navigation} aria-label={t('navigation.main')}>
   <WorkbenchNavigationBrand product={options.product} colorScheme={colorScheme} onClose={()=>setNavOpen(false)}/>
   <button type="button" className={css.newWork} onClick={()=>select('home')}><Plus size={16}/><span>{t('navigation.new')}</span></button>
   <div className={css.navScroll}><WorkbenchNavigationItems view={view} onSelect={select}/></div>
   <div className={css.navFooter}>
    <button type="button" className={css.navItem} aria-current={view==='settings'?'page':undefined} onClick={()=>select('settings')}><Settings2 size={16}/><span>{t('navigation.v2.settings')}</span></button>
    <div className={css.account}><span className={css.avatar} aria-hidden="true">{initials||<UserRound size={15}/>}</span><span className={css.accountText}><strong>{accountName}</strong></span><button type="button" className={css.iconButton} onClick={()=>setColorScheme(value=>value==='dark'?'light':'dark')} aria-label={t(colorScheme==='dark'?'navigation.themeLight':'navigation.themeDark')} title={t(colorScheme==='dark'?'navigation.themeLight':'navigation.themeDark')}>{colorScheme==='dark'?<Sun size={16}/>:<Moon size={16}/>}</button><button type="button" className={css.button} disabled={pending} onClick={()=>request('account')}>{accountLabel}</button></div>
   </div>
  </aside>
  {navOpen&&<button type="button" className={css.navMask} aria-label={t('shell.navigation.close')} onClick={()=>setNavOpen(false)}/>}
  <div className={css.workspace}>
   <header className={css.topbar}><button type="button" className={css.mobileNavigation} aria-label={t('shell.navigation.open')} onClick={()=>setNavOpen(true)}><Menu size={17}/></button><strong>{title}</strong><button type="button" className={clsx(css.button,guestCss.headerAccount)} aria-label={accountLabel} disabled={pending} onClick={()=>request('account')}>{account?(initials||<UserRound size={15}/>):copy.login}</button></header>
   <main className={clsx(css.main,view==='settings'&&options.settings&&guestCss.settingsMain)}>
    {view==='settings'&&options.settings&&settingsEntry?<SettingsLayout label={t('shell.settings')} heading={<span>{t('shell.settings')}</span>} actions={<div className={settingsCss.documentAction}><button type="button" disabled={pending} onClick={()=>request('settings-close')}>{copy.closeSettings}</button></div>} entries={options.settings.entries} selectedId={settingsEntry.id} onSelect={openSettings} notice={notice?<p className={settingsCss.connection} role="status">{notice}</p>:null}>
     <HostSettingsContent element={settingsEntry.content}/>
    </SettingsLayout>:<div className={guestCss.content}>{view==='home'?<section className={guestCss.home}>
     <h1>{copy.title}</h1><form className={guestCss.composer} onSubmit={event=>{event.preventDefault();request('start')}}>
      <textarea aria-label={copy.prompt} placeholder={copy.placeholder} maxLength={options.maxPromptLength} value={prompt} onChange={event=>{setPrompt(event.target.value);options.onPromptChange(event.target.value)}}/>
      <div className={guestCss.composerActions}><button type="submit" className={guestCss.primary} disabled={pending}><span>{pending?copy.waiting:copy.start}</span><ArrowUp size={16}/></button></div>
     </form><p className={guestCss.hint}>{copy.hint}</p>
    </section>:<section className={guestCss.empty}><Icon size={32}/><h1>{title}</h1><p>{copy.description[view]}</p><button type="button" className={guestCss.primary} disabled={pending} onClick={()=>request('account')}>{accountLabel}</button></section>}{notice&&<p className={guestCss.notice} role="status">{notice}</p>}</div>}
   </main>
  </div>
 </div>
}

/** 可脱离 DSH 宿主挂载的公共工作台浏览入口。登录取消时保留此实例即可保留输入和导航。 */
export function mountGuestWorkbench(element:HTMLElement,options:GuestWorkbenchOptions):GuestWorkbenchHandle{
 const settings=readGuestSettings(element,options.settings)
 options={...options,...(settings?{settings}:{})}
 const locale=resolveProductLocale(element.ownerDocument.documentElement.lang||element.ownerDocument.defaultView?.navigator.language||'en')
 const snapshot=Object.freeze({locale,dshLocale:locale,revision:0})
 const runtime:TeloaI18n={t:(key,params)=>translateMessage(locale,key,params),getSnapshot:()=>snapshot,subscribe:()=>()=>{}}
 installGuestStyles(element.ownerDocument,options.styleNonce)
 const root=createRoot(element),controller:GuestController={}
 flushSync(()=>root.render(<I18nProvider runtime={runtime}><GuestWorkbench options={options} controller={controller}/></I18nProvider>))
 let disposed=false
 return {dispose:()=>{if(disposed)return;disposed=true;delete controller.setPrompt;delete controller.setAccount;delete controller.openSettings;delete controller.closeSettings;root.unmount()},update:input=>{if(!disposed)flushSync(()=>{if(input.prompt!==undefined)controller.setPrompt?.(input.prompt);if(input.account!==undefined)controller.setAccount?.(input.account)})},openSettings:id=>{if(!disposed)flushSync(()=>controller.openSettings?.(id))},closeSettings:()=>{if(!disposed)flushSync(()=>controller.closeSettings?.())}}
}
