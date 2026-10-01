import {useEffect,useState} from 'react'
import {RefreshCw} from 'lucide-react'
import type {BusinessSyncStatus,BusinessSyncRuleView,BusinessSyncSchedule,BusinessRuntimeState} from '@teloa/contract'
import type {BusinessDashboardApi} from './business-dashboard-api.js'
import {widgetFailure} from './business-widget-presentation.js'
import {useI18n} from './i18n/provider.js'
import css from './BusinessDashboardPage.module.css'

type RuleState={status:'loading'|'failed'}|{status:'ready';rows:BusinessSyncRuleView[];runtime:BusinessRuntimeState}

function ruleSchedule(schedule:BusinessSyncSchedule,t:ReturnType<typeof useI18n>['t'],number:ReturnType<typeof useI18n>['number']):string{
 if(schedule.kind==='every')return t('business.dashboards.sync.rule.every',{seconds:number(schedule.seconds)})
 if(schedule.kind==='hourly')return t('business.dashboards.sync.rule.hourly',{minute:number(schedule.minute)})
 if(schedule.kind==='daily')return t('business.dashboards.sync.rule.daily',{time:schedule.time,timezone:schedule.timezone})
 return t('business.dashboards.sync.rule.cron',{expression:schedule.expression,timezone:schedule.timezone})
}

/** 数据同步一行：映射数、最近一次同步、连续失败次数，外加「立即同步」。没有映射就整行不摆。 */
export function BusinessSyncControls({scope,api}:{scope:string;api:BusinessDashboardApi}){
 const {t,number,dateTime}=useI18n()
 const [statuses,setStatuses]=useState<BusinessSyncStatus[]>([]),[running,setRunning]=useState(false),[revision,setRevision]=useState(0),[error,setError]=useState<ReturnType<typeof widgetFailure>|undefined>(undefined)
 const [rules,setRules]=useState<RuleState>({status:'loading'}),[ruleRevision,setRuleRevision]=useState(0),[ruleBusy,setRuleBusy]=useState<string|undefined>(),[scopeBusy,setScopeBusy]=useState(false),[ruleError,setRuleError]=useState(false)
 useEffect(()=>{
  const controller=new AbortController()
  void api.syncStatus({scope},controller.signal).then(value=>{if(!controller.signal.aborted)setStatuses(value)},()=>{if(!controller.signal.aborted)setStatuses([])})
  return ()=>controller.abort()
 },[api,scope,revision])
 useEffect(()=>{
  const controller=new AbortController()
  setRules({status:'loading'})
  void Promise.all([api.syncRules({scope},controller.signal),api.syncRuntime({scope},controller.signal)]).then(([rows,runtime])=>{if(!controller.signal.aborted)setRules({status:'ready',rows,runtime})},()=>{if(!controller.signal.aborted)setRules({status:'failed'})})
  return ()=>controller.abort()
 },[api,scope,ruleRevision])
 if(!statuses.length&&rules.status==='ready'&&!rules.rows.length)return null
 const last=statuses.map(status=>status.lastRun?.finishedAt).filter((value):value is string=>!!value).sort().at(-1)
 const failures=statuses.reduce((sum,status)=>sum+status.consecutiveFailures,0)
 const run=async()=>{
  setRunning(true);setError(undefined)
  try{for(const status of statuses)await api.syncRun({requestId:crypto.randomUUID(),scope,mappingId:status.mappingId})}
  catch(failure){setError(widgetFailure(failure))}
  finally{setRunning(false);setRevision(value=>value+1)}
 }
 const changeRule=async(rule:BusinessSyncRuleView)=>{
  setRuleBusy(rule.mappingId);setRuleError(false)
  try{
   await api.setSyncRule({scope,mappingId:rule.mappingId,enabled:!rule.enabled,expectedRevision:rule.revision,requestId:crypto.randomUUID()})
   const [rows,runtime]=await Promise.all([api.syncRules({scope}),api.syncRuntime({scope})]);setRules({status:'ready',rows,runtime})
  }catch{
   setRuleError(true)
   try{const [rows,runtime]=await Promise.all([api.syncRules({scope}),api.syncRuntime({scope})]);setRules({status:'ready',rows,runtime})}catch{setRules({status:'failed'})}
  }finally{setRuleBusy(undefined)}
 }
 const changeScope=async(runtime:BusinessRuntimeState)=>{
  setScopeBusy(true);setRuleError(false)
  try{
   await api.setSyncRuntime({scope,enabled:!runtime.syncEnabled,expectedRevision:runtime.revision,requestId:crypto.randomUUID()})
   const [rows,current]=await Promise.all([api.syncRules({scope}),api.syncRuntime({scope})]);setRules({status:'ready',rows,runtime:current})
  }catch{
   setRuleError(true)
   try{const [rows,current]=await Promise.all([api.syncRules({scope}),api.syncRuntime({scope})]);setRules({status:'ready',rows,runtime:current})}catch{setRules({status:'failed'})}
  }finally{setScopeBusy(false)}
 }
 return <section className={css.sync} aria-label={t('business.dashboards.sync.title')}>
  <strong>{t('business.dashboards.sync.title')}</strong>
  <span>{t('business.dashboards.sync.mappings',{count:number(statuses.length)})}</span>
  {last&&<span>{t('business.dashboards.sync.lastRun',{time:dateTime(new Date(last),{dateStyle:'medium',timeStyle:'short'})})}</span>}
  {failures>0&&<span data-failed>{t('business.dashboards.sync.failed',{count:number(failures)})}</span>}
  {error&&<span data-failed role="alert">{t(error.key,error.params)}</span>}
  {statuses.length>0&&<button type="button" disabled={running} onClick={()=>void run()}><RefreshCw size={14}/>{t(running?'business.dashboards.refreshing':'business.dashboards.sync.run')}</button>}
  {rules.status==='loading'&&<span role="status">{t('business.dashboards.sync.rule.loading')}</span>}
  {rules.status==='failed'&&<span data-failed role="alert">{t('business.dashboards.sync.rule.readFailed')} <button type="button" onClick={()=>setRuleRevision(value=>value+1)}>{t('business.ledger.retry')}</button></span>}
  {ruleError&&<span data-failed role="alert">{t('business.dashboards.sync.rule.updateUnknown')}</span>}
  {rules.status==='ready'&&rules.rows.length>0&&rules.runtime.managed&&<div className={css.syncRule}>
   <span><strong>{t('business.dashboards.sync.scope.title')}</strong><small>{t(rules.runtime.syncEnabled?'business.dashboards.sync.scope.running':'business.dashboards.sync.scope.paused')}</small></span>
   <button type="button" disabled={scopeBusy||ruleBusy!==undefined} onClick={()=>void changeScope(rules.runtime)}>{t(rules.runtime.syncEnabled?'business.dashboards.sync.scope.pause':'business.dashboards.sync.scope.start')}</button>
  </div>}
  {rules.status==='ready'&&rules.rows.length>0&&<div className={css.syncRules}>
   {rules.rows.map(rule=><div className={css.syncRule} key={rule.mappingId}>
    <span><strong>{rule.title}</strong><small>{ruleSchedule(rule.schedule,t,number)}</small></span>
    <span>{t(rule.running?'business.dashboards.sync.rule.running':rule.enabled?'business.dashboards.sync.rule.scopePaused':'business.dashboards.sync.rule.paused')}</span>
    <button type="button" disabled={scopeBusy||ruleBusy!==undefined} onClick={()=>void changeRule(rule)}>{t(rule.enabled?'business.dashboards.sync.rule.pause':'business.dashboards.sync.rule.enable')}</button>
   </div>)}
  </div>}
 </section>
}
