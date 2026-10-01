import {useEffect,useRef,useState} from 'react'
import type {PlanApi} from './plan-api.js'
import {appendPlanSkipHistory,type PlanSkipHistoryPage} from './plan-skip-history.js'
import {createPlanExecutionHistoryRequestGate} from './plan-execution-history.js'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'
import pageCss from './TaskPage.module.css'
import css from './PlanSkipHistory.module.css'

type Props={planId:string;planVersion:number;api:Pick<PlanApi,'skips'>;openTask:(taskId:string)=>void;face?:'timeline';onPage?:(page:PlanSkipHistoryPage)=>void}
type ViewState={key:string;page?:PlanSkipHistoryPage;loading:boolean;more:boolean;error:string;errorPhase?:'first'|'more'}
const reasons={'previous-pending':'plan.schedule.skipPending','previous-task-unfinished':'plan.schedule.skipRunning'} as const

export function PlanSkipHistory({planId,planVersion,api,openTask,face,onPage}:Props){
 const {locale,t,dateTime}=useI18n(),stamp=(value:string)=>dateTime(value,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
 const key=planId+':'+planVersion,[reload,setReload]=useState(0)
 const [state,setState]=useState<ViewState>({key:'',loading:false,more:false,error:''}),requests=useRef(createPlanExecutionHistoryRequestGate())
 const current=state.key===key?state:undefined,page=current?.page,loading=!current||current.loading
 const onPageRef=useRef(onPage);onPageRef.current=onPage
 useEffect(()=>{if(page)onPageRef.current?.(page)},[page])
 useEffect(()=>{
  let active=true;const request=requests.current.begin()
  setState(previous=>({key,...(previous.key===key&&previous.page?{page:previous.page}:{}),loading:true,more:false,error:''}))
  void api.skips(planId).then(page=>{if(active&&requests.current.current(request))setState({key,page,loading:false,more:false,error:''})},cause=>{if(active&&requests.current.current(request))setState(previous=>({key,...(previous.key===key&&previous.page?{page:previous.page}:{}),loading:false,more:false,error:localizeWorkError(locale,cause),errorPhase:'first'}))})
  return()=>{active=false;requests.current.invalidate()}
 },[api,key,planId,reload,locale])
 const loadMore=()=>{
  if(!page?.cursor||loading||current?.more)return
  const cursor=page.cursor,request=requests.current.begin()
  setState(previous=>previous.key===key?{...previous,more:true,error:''}:previous)
  void api.skips(planId,20,cursor).then(next=>{if(requests.current.current(request))setState(previous=>{if(previous.key!==key||!previous.page)return previous;try{return {...previous,page:appendPlanSkipHistory(previous.page,next),more:false,error:''}}catch(cause){return {...previous,more:false,error:localizeWorkError(locale,cause),errorPhase:'more'}}})},cause=>{if(requests.current.current(request))setState(previous=>previous.key===key?{...previous,more:false,error:localizeWorkError(locale,cause),errorPhase:'more'}:previous)})
 }
 return <section className={pageCss.block} aria-label={t('planSkip.aria')} title={face==='timeline'?t('planSkip.description'):undefined}>
  <header>{face!=='timeline'&&<h3>{t('planSkip.title')}</h3>}<button type="button" disabled={loading||current?.more} onClick={()=>setReload(value=>value+1)}>{t('planSkip.refresh')}</button></header>
  {face!=='timeline'&&<p className={css.scope}>{t('planSkip.description')}</p>}
  {current?.error&&<p className={pageCss.error} role="alert">{current.error}<button type="button" disabled={loading||current.more} onClick={()=>current.errorPhase==='more'?loadMore():setReload(value=>value+1)}>{t('planSkip.retry')}</button></p>}
  {loading&&!page&&<p role="status">{t('planSkip.loading')}</p>}
  {!!page?.errors?.length&&<p className={css.corrupt} role="status">{t('planSkip.corrupt',{count:page.errors.length})}</p>}
  <div className={css.list}>{page?.items.map(item=><article className={css.item} key={`${item.skippedAt}:${item.configVersion}:${item.occurrenceId}`}>
   <div className={css.heading}><strong>{t(reasons[item.reason])}</strong><span>{t('plan.execution.config',{version:item.configVersion})}</span></div>
   <small>{t('planSkip.scheduled')} <time dateTime={item.scheduledAt}>{stamp(item.scheduledAt)}</time> · {t('planSkip.recorded')} <time dateTime={item.skippedAt}>{stamp(item.skippedAt)}</time></small>
   <small>{t('planSkip.ids',{occurrence:item.occurrenceId,claim:item.blockingClaimId})}</small>
   {item.taskId&&<button type="button" onClick={()=>openTask(item.taskId!)}>{t('plan.schedule.openBlockingTask')}</button>}
  </article>)}</div>
  {page&&!page.items.length&&!page.errors?.length&&!loading&&!current?.error&&<p>{t('planSkip.empty')}</p>}
  {page?.cursor&&<button className={css.more} type="button" disabled={loading||current?.more} onClick={loadMore}>{t(current?.more?'plan.execution.loadingMore':'planSkip.loadMore')}</button>}
 </section>
}
