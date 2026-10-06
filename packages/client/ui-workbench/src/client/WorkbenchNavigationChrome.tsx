import clsx from 'clsx'
import {LayoutGrid,CheckCheck,CheckSquare,Globe2,MessageSquare,Bot,Blocks,Library,CalendarClock,FolderKanban,Sparkles,X} from 'lucide-react'
import type {WorkbenchView} from './store.js'
import {useI18n} from './i18n/provider.js'
import lightLogo from '../brand/teloa-light.svg'
import darkLogo from '../brand/teloa-dark.svg'
import css from './WorkbenchFrame.module.css'

/** 导航定义和呈现由在线工作台与无宿主浏览状态共同复用。 */
export const primaryNavigation=[
 ['home','navigation.home',LayoutGrid],['attention','navigation.attention',CheckCheck],['messages','navigation.v2.conversations',MessageSquare],['tasks','navigation.tasks',CheckSquare],['projects','navigation.projects',FolderKanban],['plans','navigation.plans',CalendarClock],
 ['team','navigation.v2.colleagues',Bot],['spaces','navigation.v2.business',Globe2],
 ['resources','navigation.v2.library',Library],['capabilities','navigation.capabilities',Sparkles],['market','navigation.v2.market',Blocks],
] as const

export function WorkbenchNavigationBrand({product,colorScheme,onClose}:{product:'Free'|'Pro'|'Enterprise';colorScheme:'light'|'dark';onClose:()=>void}){
 const {t}=useI18n()
 return <div className={css.brand}><div className={css.brandIdentity}><div className={css.brandHeading}><img src={colorScheme==='dark'?darkLogo:lightLogo} alt="Teloa"/><span className={css.brandTier}>{product}</span></div><span className={css.brandStudio}>AI-Native Team Studio</span></div><button type="button" className={css.mobileClose} aria-label={t('shell.navigation.close')} onClick={onClose}><X size={17}/></button></div>
}

export function WorkbenchNavigationItems({view,onSelect,needCount=0,attentionKnown=true}:{view:WorkbenchView;onSelect:(view:WorkbenchView)=>void;needCount?:number;attentionKnown?:boolean}){
 const {t}=useI18n()
 return <nav aria-label={t('navigation.main')}>{primaryNavigation.map(([id,key,Icon])=>{const active=view===id;return <div key={id}>{(id==='team'||id==='resources')&&<div className={clsx(css.navLabel,css.navGroupLabel)}>{t(id==='team'?'navigation.group.team':'navigation.group.resources')}</div>}<button type="button" className={clsx(css.navItem,active&&css.active)} aria-current={active?'page':undefined} onClick={()=>onSelect(id)}><Icon size={16}/><span>{t(key)}</span>{id==='attention'&&needCount>0&&<span className={css.count} aria-label={attentionKnown?undefined:t('attention.count.partial',{count:needCount})}>{needCount}{!attentionKnown&&'+'}</span>}</button></div>})}</nav>
}
