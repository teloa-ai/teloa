import {useEffect,useState,useSyncExternalStore,type ReactNode} from 'react'
import type {PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import {visibleSecondaryViews,type TeloaTabKind,type TeloaTabSecondaryView} from './sidebar-right-tabs.js'
import {subscribeTeloaTabHost,teloaTabHost,teloaTabHostRevision} from './sidebar-right-tab-host.js'
import {useI18n} from './i18n/provider.js'
import css from './SidebarRightTab.module.css'

export type SidebarRightTabInjected={
 /** 这个座位画的是哪个页类型；座位要拿它去回报自己的 tab id。 */
 kind:TeloaTabKind
 render:(view:TeloaTabSecondaryView,params:unknown)=>ReactNode
 /** 这个对象此刻有没有可核对的依据；没有就不挂切换条，正文即对象本身。 */
 hasEvidence:(params:unknown)=>boolean
}

/**
 * DSH 的页签是“并置的独立内容”，原型的三栏页签是“同一对象的三个视图”。
 * 两种模型不能混：外层 DSH 页签表示打开了哪些对象，二级页签留在 tab 内部。
 *
 * 正文由 Teloa 外壳经注册表提供，所以这里必须订阅注册表版本号：
 * 外壳那边任务改了状态，页签里的详情要跟着变，而不是停在开页时的快照。
 */
export function SidebarRightTabBody({useTabInfo,sessionId,kind,render,hasEvidence}:PropsRuntime<'sidebar.right.pane.tab'>&SidebarRightTabInjected){
 const {t}=useI18n()
 const info=useTabInfo()
 const [view,setView]=useState<TeloaTabSecondaryView>('report')
 const revision=useSyncExternalStore(subscribeTeloaTabHost,teloaTabHostRevision,teloaTabHostRevision)
 // 只有座位自己知道这个页签的真实 id：openTab 不回传，active() 只反映上一次提交。
 // 外壳换人（revision 前进）后重新登记一次，免得外壳重挂后记账里空着 id 关不掉页签。
 // 刻意不返回清理：DockKit 每个 pane 只挂载活动页签的正文，用户点一下终端页签这个座位就卸载了，
 // 而页签还在条上——卸载时把 id 注销掉，之后就再也收不起这个页签。
 // 连自己所在的会话一起报：tab id 是每个会话自己铸的，跨会话必然重号。
 const tabId=info.tab.id
 useEffect(()=>{teloaTabHost()?.bindTab(sessionId,kind,tabId)},[sessionId,kind,tabId,revision])
 const params=info.tab.navigation.params
 const views=visibleSecondaryViews(hasEvidence(params))
 const active=views.includes(view)?view:views[0]!
 const body=render(active,params)
 // 稳态提示，不是刚发生的错误：用 status，免得每次重绘都打断屏幕阅读器。
 if(body===null||body===undefined)return <p role="status" className={css.missing}>{t('sidebarRight.tab.missingTarget')}</p>
 return <div className={css.tab}>
  {views.length>1&&<nav className={css.views} aria-label={t('sidebarRight.tab.views')}>
   {views.map(item=><button key={item} type="button" aria-current={active===item?'page':undefined} onClick={()=>setView(item)}>{t(('sidebarRight.tab.view.'+item) as 'sidebarRight.tab.view.report')}</button>)}
  </nav>}
  <div className={css.body}>{body}</div>
 </div>
}
