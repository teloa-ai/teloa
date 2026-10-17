import clsx from 'clsx'
import {LayoutGrid,Globe2,MessageSquare,Bot,Library,FolderKanban,Store,Link2,X} from 'lucide-react'
import type {WorkbenchView} from './store.js'
import {useI18n} from './i18n/provider.js'
import {applicationProductName,type ApplicationPresentation} from './application-presentation.js'
import lightLogo from '../brand/teloa-light.svg'
import darkLogo from '../brand/teloa-dark.svg'
import css from './WorkbenchFrame.module.css'

/** 导航定义和呈现由在线工作台与无宿主浏览状态共同复用。 */
export const primaryNavigation=[
 ['home','navigation.home',LayoutGrid],['messages','navigation.v2.conversations',MessageSquare],['projects','navigation.projects',FolderKanban],
 ['team','navigation.v2.colleagues',Bot],['spaces','navigation.v2.business',Globe2],
 ['resources','navigation.v2.library',Library],['market','market.title',Store],
] as const
const primaryNavigationGroupKeys={home:'navigation.group.work',team:'navigation.group.team',resources:'navigation.group.resources'} as const

export const workbenchHubNavigation=[['home','workbench.hub.overview'],['attention','navigation.attention'],['tasks','navigation.tasks'],['plans','navigation.plans']] as const
export type WorkbenchHubView=typeof workbenchHubNavigation[number][0]
export const isWorkbenchHubView=(view:WorkbenchView):view is WorkbenchHubView=>workbenchHubNavigation.some(([id])=>id===view)

/** 导航继续使用原对象与原动作；只有呈现层级收敛，不另建任务或计划副本。 */
export function WorkbenchHubNavigation({view,onSelect,needCount=0,attentionKnown=true}:{view:WorkbenchView;onSelect:(view:WorkbenchHubView)=>void;needCount?:number;attentionKnown?:boolean}){
 const {t}=useI18n()
 if(!isWorkbenchHubView(view))return null
 return <nav className={css.hubNavigation} aria-label={t('navigation.home')}>{workbenchHubNavigation.map(([id,key])=><button type="button" key={id} className={clsx(css.hubTab,view===id&&css.hubTabActive)} aria-current={view===id?'page':undefined} onClick={()=>onSelect(id)}>{t(key)}{id==='attention'&&needCount>0&&<span className={css.count} aria-label={attentionKnown?undefined:t('attention.count.partial',{count:needCount})}>{needCount}{!attentionKnown&&'+'}</span>}</button>)}</nav>
}

/** 品牌区只保留字标与版本名；产品介绍与构建号统一在「关于」页，不再在顶部弹出重复卡片。 */
export function WorkbenchNavigationBrand({product,colorScheme,onClose}:{product:ApplicationPresentation['product'];colorScheme:'light'|'dark';onClose:()=>void}){
 const {locale,t}=useI18n()
 return <div className={css.brand}><div className={css.brandIdentity}><div className={css.brandHeading}><img src={colorScheme==='dark'?darkLogo:lightLogo} alt="Teloa"/><span className={css.brandTier}>{applicationProductName(product,locale)}</span></div></div><button type="button" className={css.mobileClose} aria-label={t('shell.navigation.close')} onClick={onClose}><X size={17}/></button></div>
}

/** 方案 B：资源组里「市场」与「应用」并列；应用打开同一市场目录的应用视图，不另建页面。 */
export function WorkbenchNavigationItems({view,onSelect,needCount=0,attentionKnown=true,marketApps=false,onApps}:{view:WorkbenchView;onSelect:(view:WorkbenchView)=>void;needCount?:number;attentionKnown?:boolean;marketApps?:boolean;onApps?:()=>void}){
 const {t}=useI18n()
 const appsActive=view==='market'&&marketApps
 return <nav aria-label={t('navigation.main')}>{primaryNavigation.map(([id,key,Icon])=>{const active=id==='market'?view==='market'&&!appsActive:view===id||(id==='home'&&isWorkbenchHubView(view));const groupKey=primaryNavigationGroupKeys[id as keyof typeof primaryNavigationGroupKeys];return <div key={id}>{groupKey&&<div className={clsx(css.navLabel,css.navGroupLabel)}>{t(groupKey)}</div>}<button type="button" className={clsx(css.navItem,active&&css.active)} aria-current={active?'page':undefined} onClick={()=>onSelect(id)}><Icon size={16}/><span>{t(key)}</span>{id==='home'&&needCount>0&&<span className={css.count} aria-label={attentionKnown?undefined:t('attention.count.partial',{count:needCount})}>{needCount}{!attentionKnown&&'+'}</span>}</button>{id==='market'&&onApps&&<button type="button" className={clsx(css.navItem,appsActive&&css.active)} aria-current={appsActive?'page':undefined} onClick={onApps}><Link2 size={16}/><span>{t('market.apps.title')}</span></button>}</div>})}</nav>
}
