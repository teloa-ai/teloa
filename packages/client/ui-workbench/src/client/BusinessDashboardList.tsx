import {useEffect,useState} from 'react'
import {ArrowRight} from 'lucide-react'
import type {BusinessDashboardSummary} from '@teloa/contract'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import type {BusinessCustomizationApi} from './business-customization-api.js'
import {localizedBusinessViewTitle} from './business-definition-localization.js'
import {useI18n} from './i18n/provider.js'
import base from './TaskPage.module.css'
import css from './BusinessDashboardPage.module.css'
import {BusinessSyncControls} from './BusinessSyncControls.js'
import {businessLibraryText} from './business-library-presentation.js'
import {businessDashboardReadFailure} from './business-dashboard-errors.js'

/** 看板相关的三种声明：待确认草案只数这三种，其余定制草案仍在「会话里定制这个业务」里。 */
const boardKinds=new Set(['source-mapping','widget','dashboard'])

type State={status:'loading'}|{status:'failed';failure:ReturnType<typeof businessDashboardReadFailure>}|{status:'ready';dashboards:BusinessDashboardSummary[]}


/**
 * 看板分区首页：看板卡片列表、「待确认草案」入口（跳到会话定制面板）与数据同步一行。
 * 看板由会话里的「看板设计」技能起草、在定制面板确认，这里不提供编辑器。
 */
export function BusinessDashboardList({scope,api,customization,open,openDrafts,prepare}:{scope:string;api:BusinessDashboardApi;customization:BusinessCustomizationApi;open:(dashboardId:string)=>void;openDrafts:()=>void;prepare?:()=>void}){
 const {t,locale,dateTime,number}=useI18n()
 const copy=businessLibraryText(locale)
 const [state,setState]=useState<State>({status:'loading'}),[attempt,setAttempt]=useState(0),[drafts,setDrafts]=useState(0)
 useEffect(()=>{
  const controller=new AbortController()
  setState({status:'loading'})
  void api.list({scope},controller.signal).then(dashboards=>{if(!controller.signal.aborted)setState({status:'ready',dashboards})},error=>{if(!controller.signal.aborted)setState({status:'failed',failure:businessDashboardReadFailure(error,'business.dashboards.readFailed')})})
  void customization.directory({scope},controller.signal).then(directory=>{if(!controller.signal.aborted)setDrafts(directory.drafts.filter(draft=>draft.status==='draft'&&boardKinds.has(draft.kind)).length)},()=>{if(!controller.signal.aborted)setDrafts(0)})
  return ()=>controller.abort()
 },[api,customization,scope,attempt])
 return <section className={css.surface} aria-label={t('business.section.dashboards')}>
  <header className={css.header}>
   <div><h2>{t('business.section.dashboards')}</h2></div>
   {drafts>0&&<div className={css.actions}><button type="button" onClick={openDrafts}>{t('business.dashboards.drafts',{count:number(drafts)})}<ArrowRight size={14}/></button></div>}
  </header>
  {state.status==='ready'&&<BusinessSyncControls key={scope} scope={scope} api={api}/>}
  {state.status==='loading'&&<div className={base.empty}><h3>{t('business.dashboards.loading')}</h3></div>}
  {state.status==='failed'&&<div className={base.error} role="alert"><span>{t(state.failure.key,'params' in state.failure?state.failure.params:undefined)}</span>{state.failure.retryable&&<button type="button" onClick={()=>setAttempt(value=>value+1)}>{t('business.ledger.retry')}</button>}</div>}
  {state.status==='ready'&&(state.dashboards.length
   ?<div className={css.cards}>{state.dashboards.map(dashboard=><button type="button" key={dashboard.id} className={css.card} data-dashboard-card={dashboard.id} onClick={()=>open(dashboard.id)}>
     <strong>{localizedBusinessViewTitle(dashboard,locale)}</strong>
     <small>{dashboard.updatedAt===null?t('business.dashboards.neverUpdated'):t('business.dashboards.updatedAt',{time:dateTime(new Date(dashboard.updatedAt),{dateStyle:'medium',timeStyle:'short'})})}</small>
     <small>{t('business.dashboards.widgets',{count:number(dashboard.widgets)})}</small>
    </button>)}</div>
   :<div className={base.empty}><h2>{t('business.dashboards.empty.title')}</h2><p>{prepare?copy.dashboardHint:t('business.dashboards.empty.description')}</p>{prepare&&<button type="button" onClick={prepare}>{copy.prepareDashboard}</button>}</div>)}
 </section>
}
