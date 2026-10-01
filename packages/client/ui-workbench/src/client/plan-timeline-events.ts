import {createElement,Fragment,type ReactNode} from 'react'
import type {WorkTask} from '@teloa/contract'
import type {SavedPlan} from './plan-api.js'
import type {PlanScheduleSkip} from './plan-schedule-summary.js'
import type {PlanExecutionHistoryItem} from './plan-execution-history.js'
import type {TeloaTranslate} from './i18n/index.js'
import {sortTimeline,type TimelineEvent} from './object-timeline.ts'

export type PlanTimelineFaces={executions:ReactNode;execution:(item:PlanExecutionHistoryItem)=>ReactNode;skips:ReactNode;source:ReactNode}
export type PlanTimelineInput={
 plan:Pick<SavedPlan,'id'|'version'|'configVersion'|'createdAt'|'updatedAt'|'source'>
 executions:readonly PlanExecutionHistoryItem[];skips:readonly PlanScheduleSkip[]
 sourceLabel:string
 faces:PlanTimelineFaces;stamp:(at:string)=>string;t:TeloaTranslate
 taskStateLabel:(state:WorkTask['state'])=>string;runStateLabel:(state:NonNullable<PlanExecutionHistoryItem['run']>['state'])=>string
}

/** 把每次触发、每次跳过、配置修订与计划来源投成统一事件；at 一律沿用宿主给的 UTC ISO 字串，最后交给 sortTimeline 倒序。
 * 最新触发槽保持同一身份与内容树，避免空页、损坏页或刷新改变首条记录时重挂分页组件；没有跳过时 faces.skips 并入该槽。 */
export function planTimelineEvents(input:PlanTimelineInput):TimelineEvent[]{
 const {plan,executions,skips,sourceLabel,faces,stamp,t,taskStateLabel,runStateLabel}=input
 const events:TimelineEvent[]=[]
 const latestId='trigger:latest:'+plan.id
 const executionsFace=createElement(Fragment,null,faces.executions,skips.length===0?faces.skips:null)
 if(executions.length===0)events.push({id:latestId,kind:'trigger',at:plan.updatedAt,title:t('plan.timeline.noTrigger'),detail:createElement(Fragment,null,executionsFace,null),anchor:'trigger'})
 executions.forEach((item,index)=>{
  events.push({
   id:index===0?latestId:'trigger:'+item.claimId,kind:'trigger',at:item.claimedAt,
   title:t('plan.timeline.trigger',{time:stamp(item.scheduledAt)}),
   meta:t('plan.execution.task',{state:item.task?taskStateLabel(item.task.state):t('plan.execution.unlinked')})+' · '+t('plan.execution.run',{state:item.run?runStateLabel(item.run.state):t('plan.execution.notStarted')}),
   detail:createElement(Fragment,null,index===0?executionsFace:null,faces.execution(item)),
   ...(index===0?{anchor:'trigger'}:{}),
   ...(item.run?.state==='configuration_failed'?{pending:true}:{}),
  })
 })
 skips.forEach((skip,index)=>{
  events.push({
   id:'skip:'+skip.skippedAt+':'+skip.occurrenceId,kind:'skip',at:skip.skippedAt,
   title:t('plan.timeline.skip',{reason:t(skip.reason==='previous-pending'?'plan.schedule.skipPending':'plan.schedule.skipRunning')}),
   meta:stamp(skip.scheduledAt),
   foldKey:'skip:'+skip.reason,
   ...(index===0?{detail:faces.skips,anchor:'skip'}:{}),
  })
 })
 if(plan.configVersion>1)events.push({id:'revision',kind:'revision',at:plan.updatedAt,title:t('plan.timeline.revision',{version:plan.configVersion,revision:plan.version})})
 events.push({id:'source',kind:'source',at:plan.createdAt,title:t('plan.timeline.source',{label:sourceLabel}),detail:faces.source})
 return sortTimeline(events)
}
