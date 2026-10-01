import type {PlanScheduleSummary as ScheduleSummary} from './plan-schedule-summary.js'
import {taskStates} from './task-preview.js'
import {useI18n} from './i18n/provider.js'
import css from './TaskPage.module.css'
import own from './ContinuousPage.module.css'
import summary from './PlanScheduleSummary.module.css'

type Props={value?:ScheduleSummary;loading?:boolean;error?:string;retry?:()=>void;openTask:(id:string)=>void}

/** 展示服务端持久调度事实；不使用浏览器时间推算下一次触发。 */
export function PlanScheduleSummary({value,loading=false,error,retry,openTask}:Props){
 const {t,dateTime}=useI18n()
 const stamp=(value:string)=>dateTime(value,{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
 const overview=value?.available?value.overview:null,health=value?.available?value.health:null,latest=overview?.latest,skip=overview?.latestSkip
 const noNext=overview?.state==='active'?'plan.schedule.activeNoNext':overview?.state==='paused'?'plan.schedule.pausedNoNext':'plan.schedule.archivedNoNext'
 return <section className={css.block} aria-label={t('plan.schedule.aria')}>
  <h3>{t('plan.schedule.title')}</h3>
  {error&&<p className={`${css.error} ${summary.error}`} role="alert">{error}{retry&&<button type="button" disabled={loading} onClick={retry}>{t('plan.schedule.retry')}</button>}</p>}
  {loading&&!value&&<p role="status">{t('plan.schedule.loading')}</p>}
  {value&&!value.available&&<p className={own.notice}>{t('plan.schedule.unavailable')}</p>}
  {value?.available&&<>
   {health===null?<p className={own.notice}>{t('plan.schedule.healthUnknown')}</p>:health.health==='healthy'?<p className={own.notice}>{t('plan.schedule.healthy',{time:stamp(health.lastSuccessAt!)})}</p>:<p className={css.error} role="alert">{t('plan.schedule.failed',{code:health.failureCode??'—',time:stamp(health.lastAttemptAt)})}{health.lastSuccessAt&&<> · {t('plan.schedule.lastSuccess',{time:stamp(health.lastSuccessAt)})}</>}</p>}
   {overview===null?<p>{t('plan.schedule.overviewMissing')}</p>:<>
    <p>{overview.nextAt?t('plan.schedule.next',{time:stamp(overview.nextAt)}):t(noNext)}</p>
    {latest?<div className={summary.facts}><div className={summary.item}><strong>{t('plan.schedule.latest',{time:stamp(latest.occurrence.scheduledAt)})}</strong><small>{t('plan.execution.claimed',{time:stamp(latest.occurrence.claimedAt)})} · {t('plan.execution.config',{version:latest.occurrence.configVersion})}</small>{latest.task?<><small>{t('plan.schedule.linkedTask',{state:t(taskStates[latest.task.state])})}</small><button type="button" onClick={()=>openTask(latest.task!.id)}>{t('plan.execution.openTask')}</button></>:<small>{t('plan.schedule.noLinkedTask')}</small>}</div></div>:<p>{t('plan.schedule.empty')}</p>}
    {skip&&<div className={summary.facts}><div className={summary.item}><strong>{t('plan.schedule.latestSkip',{reason:t(skip.reason==='previous-pending'?'plan.schedule.skipPending':'plan.schedule.skipRunning')})}</strong><small><time dateTime={skip.scheduledAt}>{stamp(skip.scheduledAt)}</time> · {t('plan.schedule.recorded',{time:stamp(skip.skippedAt)})}</small>{skip.taskId&&<button type="button" onClick={()=>openTask(skip.taskId!)}>{t('plan.schedule.openBlockingTask')}</button>}</div></div>}
   </>}
  </>}
 </section>
}
