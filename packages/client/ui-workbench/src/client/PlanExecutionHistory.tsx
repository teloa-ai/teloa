import {useEffect,useRef,useState} from 'react'
import type {PlanApi} from './plan-api.js'
import {appendPlanExecutionHistory,createPlanExecutionHistoryRequestGate,type PlanExecutionHistoryPage,type PlanExecutionHistoryItem} from './plan-execution-history.js'
import {taskStates} from './task-preview.js'
import {localizeWorkError} from './i18n/errors.js'
import {useI18n} from './i18n/provider.js'
import pageCss from './TaskPage.module.css'
import css from './PlanExecutionHistory.module.css'

type Props={planId:string;planVersion:number;api:Pick<PlanApi,'executions'>;openTask:(taskId:string)=>void;face?:'timeline';onPage?:(page:PlanExecutionHistoryPage)=>void}
type ViewState={key:string;page?:PlanExecutionHistoryPage;loading:boolean;more:boolean;error:string;errorPhase?:'first'|'more'}
const runStates={prepared:'plan.run.prepared',submitting:'plan.run.submitting',accepted:'plan.run.accepted',active:'plan.run.active',ended:'plan.run.ended',withdrawn:'plan.run.withdrawn',configuration_failed:'plan.run.configurationFailed'} as const

export function PlanExecutionHistory({planId,planVersion,api,openTask,face,onPage}:Props){
 const {locale,t}=useI18n()
 const key=planId+':'+planVersion,[reload,setReload]=useState(0)
 const [state,setState]=useState<ViewState>({key:'',loading:false,more:false,error:''})
 const requests=useRef(createPlanExecutionHistoryRequestGate())
 const current=state.key===key?state:undefined
 useEffect(()=>{
  let active=true
  const request=requests.current.begin()
  setState(previous=>({key,...(previous.key===key&&previous.page?{page:previous.page}:{}),loading:true,more:false,error:''}))
  void api.executions(planId).then(page=>{if(active&&requests.current.current(request))setState({key,page,loading:false,more:false,error:''})},cause=>{if(active&&requests.current.current(request))setState(previous=>({key,...(previous.key===key&&previous.page?{page:previous.page}:{}),loading:false,more:false,error:localizeWorkError(locale,cause),errorPhase:'first'}))})
  return()=>{active=false;requests.current.invalidate()}
 },[api,key,locale,planId,reload])
 const page=current?.page,error=current?.error??'',loading=!current||current.loading
 const onPageRef=useRef(onPage);onPageRef.current=onPage
 useEffect(()=>{if(page)onPageRef.current?.(page)},[page])
 const loadMore=()=>{
  if(!page?.cursor||loading||current?.more)return
  const cursor=page.cursor
  const request=requests.current.begin()
  setState(previous=>previous.key===key?{...previous,more:true,error:''}:previous)
  void api.executions(planId,20,cursor).then(next=>{
   if(!requests.current.current(request))return
   setState(previous=>{
    if(previous.key!==key||!previous.page)return previous
    try{return {...previous,page:appendPlanExecutionHistory(previous.page,next),more:false,error:''}}
    catch(cause){return {...previous,more:false,error:localizeWorkError(locale,cause),errorPhase:'more'}}
   })
  },cause=>{
   if(!requests.current.current(request))return
   setState(previous=>previous.key===key?{...previous,more:false,error:localizeWorkError(locale,cause),errorPhase:'more'}:previous)
  })
 }
 return <section className={pageCss.block} aria-label={t('plan.execution.aria')} title={face==='timeline'?t('plan.execution.description'):undefined}>
  <header>{face!=='timeline'&&<h3>{t('plan.execution.title')}</h3>}<button type="button" disabled={loading||current?.more} onClick={()=>setReload(value=>value+1)}>{t('plan.execution.refresh')}</button></header>
  {face!=='timeline'&&<p className={css.scope}>{t('plan.execution.description')}</p>}
  {error&&<p className={pageCss.error} role="alert">{error}<button type="button" disabled={loading||current?.more} onClick={()=>current?.errorPhase==='more'?loadMore():setReload(value=>value+1)}>{t('plan.execution.retry')}</button></p>}
  {loading&&!page&&<p role="status">{t('plan.execution.loading')}</p>}
  {!!page?.errors?.length&&<p className={css.corrupt} role="status">{t('plan.execution.corrupt',{count:page.errors.length})}</p>}
  {face!=='timeline'&&<div className={css.list}>{page?.items.map(item=><PlanExecutionRecord key={item.claimId} item={item} openTask={openTask}/>)}</div>}
  {page&&page.items.length===0&&(page.errors?.length??0)===0&&!loading&&!error&&<p>{t('plan.execution.empty')}</p>}
  {page?.cursor&&<button className={css.more} type="button" disabled={loading||current?.more} onClick={loadMore}>{t(current?.more?'plan.execution.loadingMore':'plan.execution.loadMore')}</button>}
 </section>
}

/** 单次触发的内容面；时间线摘要已显示时间与结果时，只补固定版本与关联任务。 */
export function PlanExecutionRecord({item,openTask,compact=false}:{item:PlanExecutionHistoryItem;openTask:(taskId:string)=>void;compact?:boolean}){
 const {t,dateTime}=useI18n()
 const stamp=(value:string)=>dateTime(value,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
 return <article className={compact?css.record:css.item} data-teloa-claim={item.claimId}>
   {!compact&&<div className={css.heading}><strong><time dateTime={item.scheduledAt}>{stamp(item.scheduledAt)}</time></strong><span>{t('plan.execution.config',{version:item.configVersion})}</span></div>}
   {compact&&<small>{t('plan.execution.config',{version:item.configVersion})}</small>}
   <small>{t('plan.execution.claimed',{time:stamp(item.claimedAt)})} · {t('plan.execution.revision',{version:item.planVersion})}</small>
   {!compact&&<div className={css.facts}><span>{t('plan.execution.task',{state:item.task?t(taskStates[item.task.state]):t('plan.execution.unlinked')})}</span><span>{t('plan.execution.run',{state:item.run?t(runStates[item.run.state]):t('plan.execution.notStarted')})}</span></div>}
   {item.run&&<small>{t('plan.execution.runHint')}</small>}
   {item.task&&<button type="button" onClick={()=>openTask(item.task!.id)}>{t('plan.execution.openTask')}</button>}
  </article>
}
