import {WorkError} from './work-error.ts'
import {readScheduleTrigger,type ScheduleTrigger} from './plan-schedule.ts'
import {readTaskCompletionPolicy,type TaskCompletionPolicy} from './task-completion.ts'
import {readRoleWorkAuthorization,type RoleWorkAuthorization,type WorkBudgetPolicy} from './role-work.ts'
import {readWorkBudgetPolicy} from './work-budget.ts'
import {workObject,workUuid,workEventKinds,type WorkEvent} from './work-events.ts'
export type PlanWorkTrigger={kind:'schedule';schedule:ScheduleTrigger}|{kind:'local-event';eventKind:WorkEvent['kind'];sourceId:string;coalesce:'latest'|'none'}
export type PlanWorkConfiguration={completion:TaskCompletionPolicy;triggers:PlanWorkTrigger[];budget:WorkBudgetPolicy;overlap:'forbid'|'independent';missed:'coalesce';safeRecovery:boolean}
export type PlanWorkDefinition=PlanWorkConfiguration&{schema:'teloa.plan-work/v2';definitionVersion:number;definitionControlId:string;budgetAccountId:string;authorization:RoleWorkAuthorization}
export function readPlanWorkTrigger(value:unknown):PlanWorkTrigger{
 if(value&&typeof value==='object'&&'kind' in value&&value.kind==='schedule'){const v=workObject(value,['kind','schedule']);return {kind:'schedule',schedule:readScheduleTrigger(v.schedule)}}
 const v=workObject(value,['kind','eventKind','sourceId','coalesce'])
 if(v.kind!=='local-event'||!workEventKinds.includes(v.eventKind as WorkEvent['kind'])||!workUuid(v.sourceId)||!['latest','none'].includes(String(v.coalesce)))throw new WorkError('teloa/invalid-input','长期工作触发来源尚未支持。')
 return {kind:'local-event',eventKind:v.eventKind as WorkEvent['kind'],sourceId:v.sourceId,coalesce:v.coalesce as 'latest'|'none'}
}
export function readPlanWorkConfiguration(value:unknown):PlanWorkConfiguration{
 const v=workObject(value,['completion','triggers','budget','overlap','missed','safeRecovery'])
 if(!Array.isArray(v.triggers)||!v.triggers.length||v.triggers.length>16||!['forbid','independent'].includes(String(v.overlap))||v.missed!=='coalesce'||typeof v.safeRecovery!=='boolean')throw new WorkError('teloa/invalid-input','长期工作策略不完整。')
 const triggers=v.triggers.map(readPlanWorkTrigger)
 if(new Set(triggers.map(v=>JSON.stringify(v))).size!==triggers.length||triggers.filter(v=>v.kind==='schedule').length>1)throw new WorkError('teloa/invalid-input','长期工作触发重复。')
 return {completion:readTaskCompletionPolicy(v.completion),triggers,budget:readWorkBudgetPolicy(v.budget),overlap:v.overlap as PlanWorkConfiguration['overlap'],missed:'coalesce',safeRecovery:v.safeRecovery}
}
export function readPlanWorkDefinition(value:unknown):PlanWorkDefinition{
 const v=workObject(value,['schema','definitionVersion','definitionControlId','budgetAccountId','authorization','completion','triggers','budget','overlap','missed','safeRecovery']),{schema,definitionVersion,definitionControlId,budgetAccountId,authorization,...config}=v
 if(schema!=='teloa.plan-work/v2'||!Number.isSafeInteger(definitionVersion)||Number(definitionVersion)<1||!workUuid(definitionControlId)||!workUuid(budgetAccountId))throw new WorkError('teloa/invalid-input','长期工作定义身份或版本不正确。')
 const auth=readRoleWorkAuthorization(authorization);if(auth.kind!=='delegation')throw new WorkError('teloa/invalid-input','长期工作必须绑定本人明确委托。')
 return {schema,definitionVersion:Number(definitionVersion),definitionControlId,budgetAccountId,authorization:auth,...readPlanWorkConfiguration(config)}
}
