import {useEffect,useRef,useState} from 'react'
import {ArrowLeft,RefreshCw} from 'lucide-react'
import {businessSyncScheduleWarning,type BusinessDashboardPage as DashboardPage,type BusinessLedger,type BusinessTimeRange} from '@teloa/contract'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import type {BusinessTarget} from './business-preview.js'
import {localizedBusinessViewTitle} from './business-definition-localization.js'
import {widgetFailure,type WidgetFailureKey} from './business-widget-presentation.js'
import {BusinessDashboardGrid} from './BusinessDashboardGrid.js'
import {useI18n} from './i18n/provider.js'
import base from './TaskPage.module.css'
import css from './BusinessDashboardPage.module.css'

type State={status:'loading'}|{status:'failed';reason:{key:WidgetFailureKey|'business.dashboards.readFailed';params?:{reason:string}}}|{status:'ready';page:DashboardPage}
/** 打开时调度器正在刷新（page.refreshing）：隔这么久静默重读一次，直到刷新结束，按钮不会一直停在「更新中」。 */
const dashboardRefreshingPollMs=3000
const rangeLabels={'24h':'business.dashboards.range.24h','7d':'business.dashboards.range.7d','30d':'business.dashboards.range.30d','90d':'business.dashboards.range.90d',all:'business.dashboards.range.all'} as const satisfies Record<BusinessTimeRange,string>

/** 页面级读取失败：无权与不存在同一句（防枚举），格式坏说格式坏，其余一律「读不出来」。 */
function pageFailure(error:unknown):{key:WidgetFailureKey|'business.dashboards.readFailed'}{
 const {key}=widgetFailure(error)
 return key==='business.dashboards.error.forbidden'||key==='business.dashboards.error.corrupt'?{key}:{key:'business.dashboards.readFailed'}
}

/**
 * 看板页：标题、「更新于」、下一次刷新、时间范围（看板声明了才有）、手动刷新（刷新中禁用并写「更新中」）、12 列网格；固定入口在业务页页头（带看板标识）。
 * 页面只读结果快照，打开页面不现算；失败的组件只写固定词条，原始 message 不上屏。没有编辑器。
 * 所选时间范围只存在本页状态里，重开看板回到默认范围；离开页面或再次切换时，在途的范围读取与自动补算一并中止，回包不再改页面。
 * 组件点击下钻经 `go` 走业务页既有导航（打开对象清单或对象详情）。
 */
export function BusinessDashboardPage({scope,dashboardId,api,ledger,colorScheme,back,go}:{scope:string;dashboardId:string;api:BusinessDashboardApi;ledger?:BusinessLedger|undefined;colorScheme:'light'|'dark';back:()=>void;go:(target:BusinessTarget)=>void}){
 const {t,locale,dateTime}=useI18n()
 const [state,setState]=useState<State>({status:'loading'}),[attempt,setAttempt]=useState(0)
 const [refreshing,setRefreshing]=useState(false),[refreshError,setRefreshError]=useState<ReturnType<typeof widgetFailure>|undefined>(undefined)
 const [range,setRange]=useState<BusinessTimeRange|undefined>(undefined)
 useEffect(()=>{
  const controller=new AbortController()
  setState({status:'loading'});setRefreshError(undefined);setRange(undefined)
  void api.read({scope,dashboardId},controller.signal).then(
   page=>{if(!controller.signal.aborted)setState({status:'ready',page})},
   error=>{if(!controller.signal.aborted)setState({status:'failed',reason:pageFailure(error)})},
  )
  return ()=>controller.abort()
 },[api,scope,dashboardId,attempt])
 const [poll,setPoll]=useState(0),serverRefreshing=state.status==='ready'&&state.page.refreshing
 useEffect(()=>{
  if(!serverRefreshing||refreshing)return
  const controller=new AbortController()
  const timer=setTimeout(()=>void api.read({scope,dashboardId,timeRange:range},controller.signal).then(
   page=>{if(!controller.signal.aborted)setState({status:'ready',page})},
   ()=>{if(!controller.signal.aborted)setPoll(value=>value+1)},
  ),dashboardRefreshingPollMs)
  return ()=>{clearTimeout(timer);controller.abort()}
 },[api,scope,dashboardId,range,serverRefreshing,refreshing,state,poll])
 const refresh=async()=>{
  setRefreshing(true);setRefreshError(undefined)
  try{setState({status:'ready',page:await api.refresh({requestId:crypto.randomUUID(),scope,dashboardId,timeRange:range})})}
  catch(error){setRefreshError(widgetFailure(error))}
  finally{setRefreshing(false)}
 }
 const choosing=useRef<AbortController|undefined>(undefined)
 useEffect(()=>()=>choosing.current?.abort(),[])
 const choose=async(next:BusinessTimeRange)=>{
  if(state.status!=='ready'||state.page.timeRange?.selected===next)return
  choosing.current?.abort()
  const controller=new AbortController(),{signal}=controller
  choosing.current=controller
  setRefreshing(true);setRefreshError(undefined)
  try{
   const page=await api.read({scope,dashboardId,timeRange:next},signal)
   if(signal.aborted)return
   setRange(next);setState({status:'ready',page})
   // 非默认范围按需算：接入范围的组件在这个范围下还没有结果，就带这个范围刷新一次（新请求标识）；失败只提示，不重试。
   // 宿主对没有结果的组件回一条「尚未计算」占位（status failed + teloa/not-found），与缺席同样算缺结果。
   const computed=(widgetId:string)=>page.results.some(result=>result.widgetId===widgetId&&!(result.status==='failed'&&widgetFailure(result.error).key==='business.dashboards.error.notComputed'))
   const missing=page.widgets.some(widget=>widget.timeFilter!==undefined&&!computed(widget.id))
   if(missing&&next!==page.dashboard.filters?.timeRange.default){
    const refreshed=await api.refresh({requestId:crypto.randomUUID(),scope,dashboardId,timeRange:next},signal)
    if(!signal.aborted)setState({status:'ready',page:refreshed})
   }
  }catch(error){if(!signal.aborted)setRefreshError(widgetFailure(error))}
  finally{if(!signal.aborted)setRefreshing(false)}
 }
 const backButton=<button type="button" onClick={back}><ArrowLeft size={14}/>{t('business.dashboards.back')}</button>
 if(state.status==='loading')return <section className={css.surface} aria-busy="true"><div className={base.empty}><h3>{t('business.dashboards.loading')}</h3></div></section>
 if(state.status==='failed')return <section className={css.surface}><div className={base.error} role="alert"><span>{t(state.reason.key,state.reason.params)}</span><span className={css.actions}>{backButton}<button type="button" onClick={()=>setAttempt(value=>value+1)}>{t('business.ledger.retry')}</button></span></div></section>
 const {page}=state,dashboard=page.dashboard,busy=refreshing||page.refreshing,ranges=page.timeRange
 const title=localizedBusinessViewTitle(dashboard,locale)
 const warning=businessSyncScheduleWarning(dashboard.refresh)
 return <section className={css.surface} aria-label={title} data-dashboard={dashboard.id}>
  <header className={css.header}>
   <div>
    <h2>{title}</h2>
    <p className={css.meta}>
     <span data-dashboard-updated>{page.updatedAt===null?t('business.dashboards.neverUpdated'):t('business.dashboards.updatedAt',{time:dateTime(new Date(page.updatedAt),{dateStyle:'medium',timeStyle:'short'})})}</span>
     {page.nextRefreshAt!==null&&<span>{t('business.dashboards.nextRefresh',{time:dateTime(new Date(page.nextRefreshAt),{dateStyle:'medium',timeStyle:'short'})})}</span>}
    </p>
   </div>
   <div className={css.actions}>
    {ranges&&<div className={css.range}>
     <span className={css.rangeGroup} role="radiogroup" aria-label={t('business.dashboards.range.label')}>{ranges.options.map(option=><button key={option} type="button" role="radio" aria-checked={option===ranges.selected} disabled={refreshing} onClick={()=>void choose(option)}>{t(rangeLabels[option])}</button>)}</span>
     <select className={css.rangeSelect} aria-label={t('business.dashboards.range.label')} value={ranges.selected} disabled={refreshing} onChange={event=>{const next=ranges.options.find(option=>option===event.target.value);if(next)void choose(next)}}>{ranges.options.map(option=><option key={option} value={option}>{t(rangeLabels[option])}</option>)}</select>
    </div>}
    {backButton}
    <button type="button" disabled={busy} aria-busy={busy} onClick={()=>void refresh()}><RefreshCw size={14}/>{t(busy?'business.dashboards.refreshing':'business.dashboards.refresh')}</button>
   </div>
  </header>
  {warning==='short-interval'&&<p className={css.notice}>{t('business.dashboards.sync.shortInterval')}</p>}
  {warning==='very-short-interval'&&dashboard.acknowledgeShortInterval&&<p className={css.notice}>{t('business.dashboards.sync.veryShortInterval')}</p>}
  {refreshError&&<p className={css.notice} role="alert">{t(refreshError.key,refreshError.params)}</p>}
  <BusinessDashboardGrid dashboard={dashboard} widgets={page.widgets} results={page.results} ledger={ledger} colorScheme={colorScheme} ranged={ranges!==null} go={go}/>
 </section>
}
