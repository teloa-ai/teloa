import {useRef,useState,type CSSProperties} from 'react'
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
import css from './WorkbenchFrame.module.css'
import guestCss from './GuestWorkbench.module.css'

export type GuestWorkbenchOptions=Readonly<{
 product:'Free'|'Pro'
 initialPrompt?:string
 maxPromptLength?:number
 styleNonce?:string
 onPromptChange:(prompt:string)=>void
 onStart:()=>void|Promise<void>
 onAccount:()=>void|Promise<void>
}>
export type GuestWorkbenchAccount=Readonly<{displayName:string|null}>
export type GuestWorkbenchHandle=Readonly<{dispose:()=>void;update:(input:Readonly<{prompt?:string;account?:GuestWorkbenchAccount|null}>)=>void}>
type GuestController={setPrompt?:(value:string)=>void;setAccount?:(value:GuestWorkbenchAccount|null)=>void}

/** 只复用工作台的呈现层；不装配本人资料、导航存储、RPC 或执行服务。 */
function GuestWorkbench({options,controller}:{options:GuestWorkbenchOptions;controller:GuestController}){
 const {locale,t}=useI18n(),copy=guestCopy(locale)
 const [view,setView]=useState<WorkbenchView>('home'),[prompt,setPrompt]=useState(options.initialPrompt??'')
 const [colorScheme,setColorScheme]=useState<'light'|'dark'>(()=>globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches?'dark':'light')
 const [navOpen,setNavOpen]=useState(false),[pending,setPending]=useState(false),[notice,setNotice]=useState<string>()
 const [account,setAccount]=useState<GuestWorkbenchAccount|null>(null)
 const active=useRef(false)
 controller.setPrompt=setPrompt
 controller.setAccount=setAccount
 const accountName=account?personalDisplayName(account.displayName??'',copy.account):copy.guest
 const initials=account?personalAvatarInitials(account.displayName??''):''
 const accountLabel=account?copy.account:copy.login
 const select=(view:WorkbenchView)=>{setView(view);setNavOpen(false);setNotice(undefined)}
 const request=(kind:'start'|'account')=>{
  if(active.current)return
  if(kind==='start'&&!prompt.trim()){setNotice(copy.emptyPrompt);return}
  active.current=true;setPending(true);setNotice(undefined)
  Promise.resolve().then(()=>kind==='start'?options.onStart():options.onAccount()).catch(()=>setNotice(copy.failed)).finally(()=>{active.current=false;setPending(false)})
 }
 const row=primaryNavigation.find(([id])=>id===view),title=row?t(row[1]):t('navigation.v2.settings'),Icon=row?.[2]??Settings2
 return <div data-guest-workbench data-theme={colorScheme} className={clsx(css.frame,guestCss.guest,navOpen&&css.navOpen)} style={{...prototypeThemes[colorScheme],colorScheme} as CSSProperties}>
  <aside className={css.navigation} aria-label={t('navigation.main')}>
   <WorkbenchNavigationBrand product={options.product} colorScheme={colorScheme} onClose={()=>setNavOpen(false)}/>
   <button type="button" className={css.newWork} onClick={()=>select('home')}><Plus size={16}/><span>{t('navigation.new')}</span></button>
   <div className={css.navScroll}><WorkbenchNavigationItems view={view} onSelect={select}/></div>
   <div className={css.navFooter}>
    <button type="button" className={css.navItem} aria-current={view==='settings'?'page':undefined} onClick={()=>select('settings')}><Settings2 size={16}/><span>{t('navigation.v2.settings')}</span></button>
    <button type="button" className={css.navItem} onClick={()=>setColorScheme(value=>value==='dark'?'light':'dark')} aria-label={t(colorScheme==='dark'?'navigation.themeLight':'navigation.themeDark')}>{colorScheme==='dark'?<Sun size={16}/>:<Moon size={16}/>}<span>{t(colorScheme==='dark'?'navigation.themeLight':'navigation.themeDark')}</span></button>
    <div className={css.account}><span className={css.avatar}>{initials||<UserRound size={15}/>}</span><span className={css.accountText}><strong>{accountName}</strong></span><button type="button" className={css.button} disabled={pending} onClick={()=>request('account')}>{accountLabel}</button></div>
   </div>
  </aside>
  {navOpen&&<button type="button" className={css.navMask} aria-label={t('shell.navigation.close')} onClick={()=>setNavOpen(false)}/>}
  <div className={css.workspace}>
   <header className={css.topbar}><button type="button" className={css.mobileNavigation} aria-label={t('shell.navigation.open')} onClick={()=>setNavOpen(true)}><Menu size={17}/></button><strong>{title}</strong><button type="button" className={clsx(css.button,guestCss.headerAccount)} aria-label={accountLabel} disabled={pending} onClick={()=>request('account')}>{account?(initials||<UserRound size={15}/>):copy.login}</button></header>
   <main className={css.main}>
    <div className={guestCss.content}>{view==='home'?<section className={guestCss.home}>
     <h1>{copy.title}</h1><form className={guestCss.composer} onSubmit={event=>{event.preventDefault();request('start')}}>
      <textarea aria-label={copy.prompt} placeholder={copy.placeholder} maxLength={options.maxPromptLength} value={prompt} onChange={event=>{setPrompt(event.target.value);options.onPromptChange(event.target.value)}}/>
      <div className={guestCss.composerActions}><button type="submit" className={guestCss.primary} disabled={pending}><span>{pending?copy.waiting:copy.start}</span><ArrowUp size={16}/></button></div>
     </form><p className={guestCss.hint}>{copy.hint}</p>
    </section>:<section className={guestCss.empty}><Icon size={32}/><h1>{title}</h1><p>{copy.description[view]}</p><button type="button" className={guestCss.primary} disabled={pending} onClick={()=>request('account')}>{accountLabel}</button></section>}{notice&&<p className={guestCss.notice} role="status">{notice}</p>}</div>
   </main>
  </div>
 </div>
}

/** 可脱离 DSH 宿主挂载的公共工作台浏览入口。登录取消时保留此实例即可保留输入和导航。 */
export function mountGuestWorkbench(element:HTMLElement,options:GuestWorkbenchOptions):GuestWorkbenchHandle{
 const locale=resolveProductLocale(element.ownerDocument.documentElement.lang||element.ownerDocument.defaultView?.navigator.language||'en')
 const snapshot=Object.freeze({locale,dshLocale:locale,revision:0})
 const runtime:TeloaI18n={t:(key,params)=>translateMessage(locale,key,params),getSnapshot:()=>snapshot,subscribe:()=>()=>{}}
 installGuestStyles(element.ownerDocument,options.styleNonce)
 const root=createRoot(element),controller:GuestController={}
 flushSync(()=>root.render(<I18nProvider runtime={runtime}><GuestWorkbench options={options} controller={controller}/></I18nProvider>))
 let disposed=false
 return {dispose:()=>{if(disposed)return;disposed=true;delete controller.setPrompt;delete controller.setAccount;root.unmount()},update:input=>{if(!disposed)flushSync(()=>{if(input.prompt!==undefined)controller.setPrompt?.(input.prompt);if(input.account!==undefined)controller.setAccount?.(input.account)})}}
}
