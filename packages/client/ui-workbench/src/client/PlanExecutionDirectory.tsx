import {useEffect,useRef,useState} from 'react'
import {CalendarClock,Search} from 'lucide-react'
import type {WorkTask} from '@teloa/contract'
import type {PlanApi,PlanExecutionDirectoryInput,PlanExecutionRunState,SavedPlan} from './plan-api.js'
import {appendPlanExecutionHistory,createPlanExecutionHistoryRequestGate,type PlanExecutionHistoryPage} from './plan-execution-history.js'
import type {PreviewRole} from './role-preview.js'
import pageCss from './TaskPage.module.css'
import css from './PlanExecutionDirectory.module.css'
import {useI18n} from './i18n/provider.js'
import {localizeWorkError} from './i18n/errors.js'

type Props={api:Pick<PlanApi,'directory'>;plans:SavedPlan[];roles:PreviewRole[];scopes:Record<string,string>;fixedScope?:string;fixedRoleId?:string;openPlans:()=>void;openTask:(id:string)=>void}
type State={key:string;page?:PlanExecutionHistoryPage;loading:boolean;more:boolean;error:string;errorPhase?:'first'|'more'}
const taskStateKeys:Record<WorkTask['state'],'status.ready'|'status.running'|'status.waiting'|'status.paused'|'status.blocked'|'status.completed'|'status.cancelled'>={ready:'status.ready',running:'status.running',waiting:'status.waiting',paused:'status.paused',blocked:'status.blocked',completed:'status.completed',cancelled:'status.cancelled'}
const runStateKeys:Record<PlanExecutionRunState,'plan.run.prepared'|'plan.run.submitting'|'plan.run.accepted'|'plan.run.active'|'plan.run.ended'|'plan.run.withdrawn'|'plan.run.configurationFailed'|'plan.run.notStarted'>={prepared:'plan.run.prepared',submitting:'plan.run.submitting',accepted:'plan.run.accepted',active:'plan.run.active',ended:'plan.run.ended',withdrawn:'plan.run.withdrawn',configuration_failed:'plan.run.configurationFailed','not-started':'plan.run.notStarted'}

export function PlanExecutionDirectory({api,plans,roles,scopes,fixedScope,fixedRoleId,openPlans,openTask}:Props){
 const {locale,t,dateTime}=useI18n(),stamp=(value:string)=>dateTime(value,{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
 const [scope,setScope]=useState(fixedScope??''),[roleId,setRoleId]=useState(fixedRoleId??''),[query,setQuery]=useState(''),[runState,setRunState]=useState<PlanExecutionRunState|''>(''),[reload,setReload]=useState(0)
 const [state,setState]=useState<State>({key:'',loading:false,more:false,error:''}),requests=useRef(createPlanExecutionHistoryRequestGate())
 const input:PlanExecutionDirectoryInput={limit:20,...(scope?{scope}:{}),...(roleId?{roleId}:{}),...(query.trim()?{query}:{}),...(runState?{runState}:{})}
 const key=JSON.stringify(input),current=state.key===key?state:undefined,page=current?.page,loading=!current||current.loading
 useEffect(()=>{setScope(fixedScope??'')},[fixedScope])
 useEffect(()=>{setRoleId(fixedRoleId??'')},[fixedRoleId])
 useEffect(()=>{
  let active=true;const request=requests.current.begin()
  setState(previous=>({key,...(previous.key===key&&previous.page?{page:previous.page}:{}),loading:true,more:false,error:''}))
  void api.directory(input).then(page=>{if(active&&requests.current.current(request))setState({key,page,loading:false,more:false,error:''})},cause=>{if(active&&requests.current.current(request))setState(previous=>({key,...(previous.key===key&&previous.page?{page:previous.page}:{}),loading:false,more:false,error:localizeWorkError(locale,cause),errorPhase:'first'}))})
  return()=>{active=false;requests.current.invalidate()}
 },[api,key,reload,locale])
 const loadMore=()=>{
  if(!page?.cursor||loading||current?.more)return
  const request=requests.current.begin(),cursor=page.cursor
  setState(previous=>previous.key===key?{...previous,more:true,error:''}:previous)
  void api.directory({...input,cursor}).then(next=>{if(requests.current.current(request))setState(previous=>{if(previous.key!==key||!previous.page)return previous;try{return {...previous,page:appendPlanExecutionHistory(previous.page,next),more:false,error:''}}catch(cause){return {...previous,more:false,error:localizeWorkError(locale,cause),errorPhase:'more'}}})},cause=>{if(requests.current.current(request))setState(previous=>previous.key===key?{...previous,more:false,error:localizeWorkError(locale,cause),errorPhase:'more'}:previous)})
 }
 const titles=new Map(plans.map(plan=>[plan.id,plan.title])),roleOptions=roles.filter(role=>role.storage==='persistent')
 return <section className={css.layout} aria-label={t('plan.directory.aria')}>
  <aside className={css.filters}>
   <h2>{t('plan.directory.filters')}</h2>
   <div className={pageCss.tabs}><button type="button" aria-pressed={false} onClick={openPlans}>{t('continuous.tab.plans')}</button><button type="button" aria-pressed={true}>{t('continuous.tab.runs')}</button></div>
   <label className={`${pageCss.search} ${css.search}`}><Search size={16}/><input maxLength={240} aria-label={t('plan.directory.search')} value={query} onChange={event=>setQuery(event.target.value)} placeholder={t('plan.directory.searchPlaceholder')}/></label>
   <label>{t('plan.directory.scope')}<select disabled={!!fixedScope} value={scope} onChange={event=>setScope(event.target.value)}><option value="">{t('common.allBusiness')}</option>{Object.entries(scopes).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
   <label>{t('plan.directory.role')}<select disabled={!!fixedRoleId} value={roleId} onChange={event=>setRoleId(event.target.value)}><option value="">{t('plan.directory.allRoles')}</option>{roleOptions.map(role=><option key={role.id} value={role.id}>{role.name}</option>)}</select></label>
   <label>{t('plan.directory.state')}<select value={runState} onChange={event=>setRunState(event.target.value as PlanExecutionRunState|'')}><option value="">{t('plan.directory.allStates')}</option>{Object.entries(runStateKeys).map(([id,key])=><option key={id} value={id}>{t(key)}</option>)}</select></label>
   <button type="button" onClick={()=>{setScope(fixedScope??'');setRoleId(fixedRoleId??'');setQuery('');setRunState('')}}>{t('plan.directory.clear')}</button>
  </aside>
  <main className={css.content}>
   <header><div><h2>{t('plan.directory.title')}</h2><p>{t('plan.directory.description')}</p></div><button type="button" disabled={loading||current?.more} onClick={()=>setReload(value=>value+1)}>{t('plan.directory.refresh')}</button></header>
   {current?.error&&<p className={pageCss.error} role="alert">{current.error}<button type="button" disabled={loading||current.more} onClick={()=>current.errorPhase==='more'?loadMore():setReload(value=>value+1)}>{t('common.retry')}</button></p>}
   {loading&&!page&&<p role="status">{t('plan.directory.loading')}</p>}
   {!!page?.errors?.length&&<p className={css.corrupt} role="status">{t('plan.directory.corrupt',{count:page.errors.length})}</p>}
   <div className={css.records}>{page?.items.map(item=><article key={item.claimId} className={css.record} data-teloa-claim={item.claimId}>
    <div className={css.recordHeading}><div><strong>{titles.get(item.planId)??item.planId}</strong><small>{t('plan.directory.planId',{id:item.planId})}</small></div><span>{t(runStateKeys[item.run?.state??'not-started'])}</span></div>
    <p>{t('plan.directory.meta',{time:stamp(item.scheduledAt),version:item.configVersion,claim:item.claimId})}</p>
    <div className={css.facts}><span>{t('plan.directory.task',{state:item.task?t(taskStateKeys[item.task.state]):t('plan.directory.taskUnlinked')})}</span><span>{t('plan.directory.revision',{version:item.planVersion})}</span></div>
    {item.task&&<button type="button" onClick={()=>openTask(item.task!.id)}>{t('plan.directory.openTask')}</button>}
   </article>)}</div>
   {page&&!page.items.length&&!page.errors?.length&&!loading&&!current?.error&&<div className={css.empty}><CalendarClock size={28}/><h3>{t('plan.directory.empty')}</h3><p>{t('plan.directory.emptyHint')}</p></div>}
   {page?.cursor&&<button type="button" disabled={loading||current?.more} onClick={loadMore}>{t(current?.more?'plan.directory.moreLoading':'plan.directory.more')}</button>}
  </main>
 </section>
}
