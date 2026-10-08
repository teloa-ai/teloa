import {readScheduleTrigger,type TaskCompletionPolicy} from '@teloa/contract'
import type { ArtifactRef } from './artifact-preview.ts'
import type { PlanTemplate } from './plan-template.ts'
import { collaborationScopes, type CollaborationScope } from './collaboration-preview.ts'
import { canReceiveTask, type PreviewRole } from './role-preview.ts'
import type {TeloaTranslate} from './i18n/index.js'

export type PlanTrigger={kind:'schedule';cadence:'daily'|'weekly';weekday:number;time:string;timezone:string}|{kind:'event';source:string;event:string}
export const planNotificationPolicies=['always','attention','failure','silent'] as const
export type PlanNotificationPolicy=typeof planNotificationPolicies[number]
export const planNotificationPolicyKeys:Record<PlanNotificationPolicy,string>={always:'continuous.form.notification.always',attention:'continuous.form.notification.attention',failure:'continuous.form.notification.failure',silent:'continuous.form.notification.silent'}
export const planNotificationPolicyLabels:Record<PlanNotificationPolicy,string>={always:'每次都提醒',attention:'需要本人处理时提醒',failure:'仅失败时提醒',silent:'不主动提醒'}
export const isPlanNotificationPolicy=(value:unknown):value is PlanNotificationPolicy=>planNotificationPolicies.some(policy=>policy===value)
export type PlanFields={title:string;scope:CollaborationScope;goal:string;dataScope:string;delivery:string;roleId:string;trigger:PlanTrigger;notificationPolicy?:PlanNotificationPolicy;completionPolicy?:TaskCompletionPolicy}
type PlanHistory={text:string;at:string}
export type ContinuousPlan={id:string;version:number;revision:number;fields:PlanFields;template?:PlanTemplate;enabled:boolean;archived:boolean;handoff?:{fromId:string;reason:string};history:PlanHistory[]}
export type PlanRun={id:string;planId:string;occurrenceId:string;revision:number;snapshot:{version:number;fields:PlanFields;template?:PlanTemplate};actor:{id:string;name:string};input:string;state:'running'|'completed'|'failed';result:string;output:string;createdAt:string;finishedAt?:string;retryOf?:string;resolution?:{note:string;at:string};taskId?:string;artifact?:ArtifactRef}
export type ContinuousPreview={plans:ContinuousPlan[];runs:PlanRun[];loaded:boolean}
export type ContinuousTarget={kind:'plans'|'runs'|'plan'|'run';id?:string;scope?:CollaborationScope;roleId?:string}
export type ContinuousChange=(
  |{type:'save';id:string;expectedRevision?:number;fields:PlanFields;template?:PlanTemplate}
  |{type:'enabled';planId:string;expectedRevision:number;enabled:boolean}
  |{type:'archive';planId:string;expectedRevision:number;note:string}
  |{type:'handoff';planId:string;expectedRevision:number;roleId:string;note:string}
  |{type:'trigger';planId:string;id:string;occurrenceId:string;input:string}
  |{type:'finish';runId:string;expectedRevision:number;outcome:'completed'|'failed';result:string;output:string}
  |{type:'retry';runId:string;id:string}
  |{type:'resolve';runId:string;expectedRevision:number;note:string}
  |{type:'follow';runId:string;id:string}
)&{now:string}
export const emptyContinuous=():ContinuousPreview=>({plans:[],runs:[],loaded:false})
export const visiblePlanRuns=(runs:readonly PlanRun[],planId:string,persistent:boolean):PlanRun[]=>persistent?[]:runs.filter(run=>run.planId===planId)
export const continuousText=(value:string,label:string,max=8000)=>{const result=value.trim();if(!result||result.length>max)throw Error(label+'不能为空，且不能超过 '+max+' 字。');return result}
export function validatePlanFields(fields:PlanFields,roles:PreviewRole[],scopes:Readonly<Record<string,string>>=collaborationScopes,allowPausedRole=false):PlanFields{
  if(!Object.hasOwn(scopes,fields.scope))throw Error('业务范围无效。')
  const role=roles.find(role=>role.id===fields.roleId)
  if(!canReceiveTask(role,fields.scope)&&!(allowPausedRole&&role?.state==='paused'&&role.kind==='employee'&&role.scopes.includes(fields.scope)))throw Error('请选择同业务在岗且已获本人执行授权的同事或分身。')
  const trigger=validatePlanTrigger(fields.trigger)
  if(!isPlanNotificationPolicy(fields.notificationPolicy))throw Error('请本人核对并选择通知策略。')
  return {title:continuousText(fields.title,'计划名称',120),scope:fields.scope,goal:continuousText(fields.goal,'工作目标'),dataScope:continuousText(fields.dataScope,'数据范围'),delivery:continuousText(fields.delivery,'交付要求'),roleId:fields.roleId,trigger,notificationPolicy:fields.notificationPolicy}
}
const weekdayKeys=['continuous.form.weekday.monday','continuous.form.weekday.tuesday','continuous.form.weekday.wednesday','continuous.form.weekday.thursday','continuous.form.weekday.friday','continuous.form.weekday.saturday','continuous.form.weekday.sunday'] as const
export function triggerLabel(trigger:PlanTrigger,t?:TeloaTranslate):string{
  if(t)return trigger.kind==='event'?t('continuous.trigger.event',{source:trigger.source,event:trigger.event}):t(trigger.cadence==='daily'?'continuous.trigger.daily':'continuous.trigger.weekly',{weekday:t(weekdayKeys[trigger.weekday-1]??weekdayKeys[0]),time:trigger.time,timezone:trigger.timezone})
  return trigger.kind==='event'?'事件 · '+trigger.source+' · '+trigger.event:(trigger.cadence==='daily'?'每天':'每周'+['一','二','三','四','五','六','日'][trigger.weekday-1])+' '+trigger.time+' · '+trigger.timezone
}
export function planBlock(plan:ContinuousPlan,roles:PreviewRole[],t?:TeloaTranslate):string{
  if(plan.archived)return t?t('continuous.block.archived'):'计划已归档，保留历史，不接受新触发。'
  if(plan.handoff)return t?t('continuous.block.handoff'):'计划等待员工交接。'
  const role=roles.find(item=>item.id===plan.fields.roleId)
  if(role?.state==='paused')return t?t('continuous.block.rolePaused'):'负责员工已暂停，不接受新触发。'
  if(!canReceiveTask(role,plan.fields.scope))return t?t('continuous.block.roleIneligible'):'负责员工当前不具备接续资格。'
  if(!plan.enabled)return t?t('continuous.block.paused'):'计划已暂停；恢复后不补跑历史触发。'
  return ''
}
export function continuousAttention(state:ContinuousPreview){
  const handoffs=state.plans.filter(plan=>plan.handoff&&!plan.archived).map(plan=>({id:plan.id,kind:'handoff' as const,title:plan.fields.title,scope:plan.fields.scope,description:plan.handoff!.reason,target:{kind:'plan' as const,id:plan.id}}))
  const failures=state.runs.filter(run=>run.state==='failed'&&!run.resolution&&!state.runs.some(child=>child.retryOf===run.id)).map(run=>({id:run.id,kind:'error' as const,title:run.snapshot.fields.title,scope:run.snapshot.fields.scope,description:run.result,target:{kind:'run' as const,id:run.id}}))
  return [...handoffs,...failures]
}
export function retireRolePlans(state:ContinuousPreview,roleId:string,reason:string,now:string):ContinuousPreview{
  return {...state,plans:state.plans.map(plan=>plan.fields.roleId===roleId&&!plan.archived?{...plan,enabled:false,revision:plan.revision+1,handoff:{fromId:roleId,reason},history:[...plan.history,{text:'负责同事退役，停发并等待交接：'+reason,at:now}]}:plan)}
}

export function validatePlanTrigger(input:PlanTrigger):PlanTrigger{
  let trigger:PlanTrigger
  if(input.kind==='schedule'){
    trigger=readScheduleTrigger(input)
  }else if(input.kind==='event')trigger={kind:'event',source:continuousText(input.source,'事件来源',240),event:continuousText(input.event,'事件条件',1000)}
  else throw Error('触发方式无效。')
  return trigger
}
