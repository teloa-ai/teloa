import {WorkError} from './work-error.ts'
import {readScheduleTrigger,type ScheduleTrigger} from './plan-schedule.ts'
import {readTaskCompletionPolicy,type TaskCompletionPolicy} from './task-completion.ts'
import {readRoleWorkAuthorization,type RoleWorkAuthorization,type WorkBudgetPolicy} from './role-work.ts'
import {readWorkBudgetPolicy} from './work-budget.ts'
import {workObject,workUuid,workEventKinds,businessWorkEventKinds,readBusinessWorkSourceRef,businessWorkSourceKey,type WorkEvent,type WorkEventV1,type BusinessWorkSourceRef} from './work-events.ts'
import {taskDefinition} from './tasks.ts'
import {readWorkExecutor,type WorkExecutor} from './tasks.ts'
export type PlanDraftCommon={title:string;goal:string;scope:string;dataScope:string;delivery:string;trigger:ScheduleTrigger;notificationPolicy:'always'|'attention'|'failure'|'silent';completionPolicy?:TaskCompletionPolicy;groupId?:string|null}
export type OwnerPlanFields=PlanDraftCommon&{scope:'general';roleId:null;executor:{kind:'owner'}}
export type RolePlanDraftFields=PlanDraftCommon&{roleId:string;expectedRoleVersion:number}
function planDraftCommon(v:Record<string,unknown>):PlanDraftCommon{
 const task=taskDefinition({title:v.title,goal:v.goal,scope:v.scope})
 if(typeof v.dataScope!=='string'||!v.dataScope.trim()||v.dataScope.length>8000||typeof v.delivery!=='string'||!v.delivery.trim()||v.delivery.length>8000||!['always','attention','failure','silent'].includes(String(v.notificationPolicy))||v.groupId!==undefined&&v.groupId!==null&&!workUuid(v.groupId))throw new WorkError('teloa/invalid-input','计划目标、资料范围或通知设置不完整。')
 return {title:task.title,goal:task.goal,scope:task.scope,dataScope:v.dataScope.trim(),delivery:v.delivery.trim(),trigger:readScheduleTrigger(v.trigger),notificationPolicy:v.notificationPolicy as PlanDraftCommon['notificationPolicy'],...(v.completionPolicy===undefined?{}:{completionPolicy:readTaskCompletionPolicy(v.completionPolicy)}),...(v.groupId===undefined?{}:{groupId:v.groupId as string|null})}
}
const planDraftKeys=['title','goal','scope','dataScope','delivery','trigger','notificationPolicy']
const optionalPlanKeys=(value:unknown)=>value&&typeof value==='object'?['completionPolicy','groupId'].filter(key=>Object.hasOwn(value,key)):[]
export function readOwnerPlanFields(value:unknown):OwnerPlanFields{
 const v=workObject(value,[...planDraftKeys,...optionalPlanKeys(value),'roleId','executor']),executor=workObject(v.executor,['kind']),fields=planDraftCommon(v)
 if(executor.kind!=='owner'||v.roleId!==null||fields.scope!=='general'||fields.groupId!=null)throw new WorkError('teloa/forbidden','本人计划仅在通用范围内执行，不继承员工或群授权。')
 return {...fields,scope:'general',roleId:null,executor:{kind:'owner'}}
}
export function readRolePlanDraftFields(value:unknown):RolePlanDraftFields{
 const v=workObject(value,[...planDraftKeys,...optionalPlanKeys(value),'roleId','expectedRoleVersion'])
 if(!workUuid(v.roleId)||!Number.isSafeInteger(v.expectedRoleVersion)||Number(v.expectedRoleVersion)<1)throw new WorkError('teloa/invalid-input','计划员工身份或版本不正确。')
 return {...planDraftCommon(v),roleId:v.roleId,expectedRoleVersion:Number(v.expectedRoleVersion)}
}
export type PlanWorkTrigger={kind:'schedule';schedule:ScheduleTrigger}|{kind:'local-event';eventKind:WorkEventV1['kind'];sourceId:string;coalesce:'latest'|'none'}|{kind:'local-event';eventKind:typeof businessWorkEventKinds[number];sourceRef:BusinessWorkSourceRef;coalesce:'latest'|'none'}
export type PlanWorkConfiguration={completion:TaskCompletionPolicy;triggers:PlanWorkTrigger[];budget:WorkBudgetPolicy;overlap:'forbid'|'independent';missed:'coalesce';safeRecovery:boolean}
export type PlanWorkAuthorization=RoleWorkAuthorization|Extract<WorkExecutor,{kind:'owner'}>
export type PlanWorkDefinition=PlanWorkConfiguration&{schema:'teloa.plan-work/v2'|'teloa.plan-work/v3';definitionVersion:number;definitionControlId:string;budgetAccountId:string;authorization:PlanWorkAuthorization}
export function planWorkEventMatches(trigger:PlanWorkTrigger,event:WorkEvent):boolean{
 return trigger.kind==='local-event'&&trigger.eventKind===event.kind&&(event.schema==='teloa.work-event/v1'?'sourceId'in trigger&&trigger.sourceId===event.sourceId:'sourceRef'in trigger&&businessWorkSourceKey(trigger.sourceRef)===businessWorkSourceKey(event.sourceRef))
}
export function readPlanWorkTrigger(value:unknown):PlanWorkTrigger{
 if(value&&typeof value==='object'&&'sourceRef'in value){
  const v=workObject(value,['kind','eventKind','sourceRef','coalesce']),sourceRef=readBusinessWorkSourceRef(v.sourceRef)
  if(v.kind!=='local-event'||v.eventKind!==(sourceRef.kind==='business-object'?'business-object-version':'business-sync-result')||!['latest','none'].includes(String(v.coalesce)))throw new WorkError('teloa/invalid-input','业务变化触发来源不正确。')
  return {kind:'local-event',eventKind:v.eventKind as typeof businessWorkEventKinds[number],sourceRef,coalesce:v.coalesce as 'latest'|'none'}
 }
 if(value&&typeof value==='object'&&'kind' in value&&value.kind==='schedule'){const v=workObject(value,['kind','schedule']);return {kind:'schedule',schedule:readScheduleTrigger(v.schedule)}}
 const v=workObject(value,['kind','eventKind','sourceId','coalesce'])
 if(v.kind!=='local-event'||!workEventKinds.includes(v.eventKind as WorkEventV1['kind'])||!workUuid(v.sourceId)||!['latest','none'].includes(String(v.coalesce)))throw new WorkError('teloa/invalid-input','长期工作触发来源尚未支持。')
 return {kind:'local-event',eventKind:v.eventKind as WorkEventV1['kind'],sourceId:v.sourceId,coalesce:v.coalesce as 'latest'|'none'}
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
 if(!['teloa.plan-work/v2','teloa.plan-work/v3'].includes(String(schema))||!Number.isSafeInteger(definitionVersion)||Number(definitionVersion)<1||!workUuid(definitionControlId)||!workUuid(budgetAccountId))throw new WorkError('teloa/invalid-input','长期工作定义身份或版本不正确。')
 const auth=authorization&&typeof authorization==='object'&&'kind'in authorization&&authorization.kind==='owner'?readWorkExecutor(authorization):readRoleWorkAuthorization(authorization);if(auth.kind!=='delegation'&&auth.kind!=='owner')throw new WorkError('teloa/invalid-input','长期工作必须绑定本人明确委托。')
 const configuration=readPlanWorkConfiguration(config)
 if(schema==='teloa.plan-work/v2'&&configuration.triggers.some(t=>'sourceRef'in t))throw new WorkError('teloa/invalid-input','旧计划不能冒用业务变化来源。')
 if(auth.kind==='owner'&&(schema!=='teloa.plan-work/v3'||auth.grantVersion!==definitionVersion||configuration.triggers.some(t=>t.kind!=='schedule')))throw new WorkError('teloa/forbidden','本人计划只能使用已明确批准的当前日程定义。')
 return {schema:schema as PlanWorkDefinition['schema'],definitionVersion:Number(definitionVersion),definitionControlId,budgetAccountId,authorization:auth,...configuration}
}
