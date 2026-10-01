import type {SavedPlan} from './plan-api.js'
import type {PlanScheduleSummary,PlanScheduleSkip} from './plan-schedule-summary.js'
import type {PlanExecutionHistoryItem} from './plan-execution-history.js'
import {triggerLabel,type PlanTrigger} from './continuous-preview.ts'
import type {TeloaTranslate} from './i18n/index.js'

export type PlanStatusAction={kind:'trigger'}|{kind:'pause'}|{kind:'resume'}|{kind:'open-task';taskId:string}
export type PlanStatusButton={label:string;action:PlanStatusAction}
export type PlanStatusBoxModel={tone:'info'|'warn'|'good'|'muted';sentence:string;detail?:string;hint?:string;primary?:PlanStatusButton;secondary?:PlanStatusButton}
export type PlanStatusInput={
 plan:{state:SavedPlan['state'];trigger:PlanTrigger}
 schedule:PlanScheduleSummary|undefined
 skips:readonly PlanScheduleSkip[]
 latestExecution:PlanExecutionHistoryItem|null
 stamp:(at:string)=>string;t:TeloaTranslate
}

/** 从最新一条起数连续、reason 相同、blockingClaimId 相同的跳过条数；skips 为空或首条与 latestSkip 不同则用 latestSkip 计 1。 */
export function consecutiveSkips(skips:readonly PlanScheduleSkip[],latestSkip:PlanScheduleSkip|null):number{
 if(!latestSkip)return 0
 const first=skips[0]
 if(!first||first.occurrenceId!==latestSkip.occurrenceId||first.skippedAt!==latestSkip.skippedAt)return 1
 let count=0
 for(const skip of skips){
  if(skip.reason!==latestSkip.reason||skip.blockingClaimId!==latestSkip.blockingClaimId)break
  count++
 }
 return count
}

/** 六态映射：自上而下第一条命中即返回；只读宿主给的调度事实，不在浏览器补造下次时间。 */
export function planStatusBox(input:PlanStatusInput):PlanStatusBoxModel{
 const {plan,schedule,skips,latestExecution,stamp,t}=input
 const timezone=plan.trigger.kind==='schedule'?plan.trigger.timezone:''
 const trigger:PlanStatusButton={label:t('continuous.detail.triggerOnce'),action:{kind:'trigger'}}
 const pause:PlanStatusButton={label:t('continuous.detail.pause'),action:{kind:'pause'}}
 if(plan.state==='archived')return {tone:'muted',sentence:t('plan.status.archived'),detail:t('continuous.detail.status.archived')}
 if(schedule&&!schedule.available)return {tone:'warn',sentence:t('plan.status.unavailable'),detail:t('plan.schedule.unavailable'),primary:trigger}
 if(plan.state==='paused')return {tone:'muted',sentence:t('plan.status.paused',{trigger:triggerLabel(plan.trigger,t)}),...(schedule?.available?{detail:t('continuous.detail.status.pausedConnected')}:{}),primary:{label:t('continuous.detail.resume'),action:{kind:'resume'}}}
 const overview=schedule?.overview
 const latestSkip=overview?.latestSkip
 // 跳过晚于最近一次成功领取才算「当前被卡住」；更早的跳过已被后来的领取解开，落到第 5–7 行。
 if(overview&&latestSkip&&(!overview.latest||latestSkip.scheduledAt>overview.latest.occurrence.scheduledAt)){
  const taskId=latestSkip.taskId??overview.latest?.task?.id
  return {
   tone:'warn',
   sentence:t('plan.status.blocked',{date:stamp(latestSkip.scheduledAt),count:consecutiveSkips(skips,latestSkip)}),
   detail:t(latestSkip.reason==='previous-pending'?'plan.schedule.skipPending':'plan.schedule.skipRunning'),
   hint:t('plan.status.blockedHint'),
   ...(taskId?{primary:{label:t('plan.status.action.openTask'),action:{kind:'open-task',taskId}}}:{}),
  }
 }
 if(latestExecution?.run?.state==='configuration_failed'&&latestExecution.task)return {tone:'warn',sentence:t('plan.status.configFailed'),detail:t('plan.run.configurationFailed'),primary:{label:t('plan.status.action.rePrepare'),action:{kind:'open-task',taskId:latestExecution.task.id}}}
 if(overview?.nextAt)return {tone:'good',sentence:t('plan.status.active',{time:stamp(overview.nextAt),timezone}),primary:trigger,secondary:pause}
 return {tone:'info',sentence:t('plan.status.activeNoNext'),...(schedule?.available?{detail:t('continuous.detail.status.noSummary')}:{}),primary:trigger,secondary:pause}
}
