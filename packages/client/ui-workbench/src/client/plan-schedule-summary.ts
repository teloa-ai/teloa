import {readOwnerPlanFields,type OwnerPlanFields,isRecord,readScheduleTrigger,readTaskCompletionPolicy,readPlanWorkDefinition,readRunPlanEventContext,type RunPlanEventContext,taskDefinition,workTaskStates,type PlanWorkDefinition,type TaskCompletionPolicy,type ScheduleTrigger,type WorkTask} from '@teloa/contract'
import {readPlanSource,type PlanNotificationPolicy,type PlanSource} from './plan-api.ts'

type PlanScheduleFields={groupId?:string|null;title:string;goal:string;scope:string;dataScope:string;delivery:string;roleId:string;trigger:ScheduleTrigger;notificationPolicy?:PlanNotificationPolicy;completionPolicy?:TaskCompletionPolicy}
export type PlanScheduleOccurrence={
 event?:RunPlanEventContext
 workDefinition?:PlanWorkDefinition
 reportGroup?:{groupId:string;groupVersion:number;grantVersion:number}
 id:string;ownerId:string;planId:string;planVersion:number;configVersion:number;occurrenceId:string;scheduledAt:string;claimedAt:string;taskRequestId:string
 fields:PlanScheduleFields|OwnerPlanFields
 source:PlanSource;roleVersion:number|null
 invalidated?:{reason:'plan-paused'|'plan-archived'|'plan-version-changed';observedPlanUpdatedAt:string}
 taskRequest:{requestId:string;fields:{groupId?:string|null;title:string;goal:string;scope:string;completionPolicy?:TaskCompletionPolicy};assignee?:{roleId:string;expectedVersion:number}}
}
export type PlanScheduleSkip={planId:string;planVersion:number;configVersion:number;occurrenceId:string;scheduledAt:string;skippedAt:string;reason:'previous-pending'|'previous-task-unfinished';blockingClaimId:string;taskId:string|null}
export type PlanSchedulerHealth={health:'healthy'|'failing';failureCode:string|null;lastAttemptAt:string;lastSuccessAt:string|null}
export type PlanScheduleOverview={planId:string;planVersion:number;state:'active'|'paused'|'archived';nextAt:string|null;latest:{occurrence:PlanScheduleOccurrence;task:{id:string;state:WorkTask['state']}|null}|null;latestSkip:PlanScheduleSkip|null}
export type PlanScheduleSummary={available:boolean;overview:PlanScheduleOverview|null;health:PlanSchedulerHealth|null}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.trim()===value&&value.length<=max
const timestamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const scheduledOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\[(?:Asia\/Singapore|Asia\/Shanghai|UTC)\]$/.test(value)
const manualOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&/^manual:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const eventOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('event:')&&uuid(value.slice(6))
const occurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&(scheduledOccurrenceIdentity(value)||manualOccurrenceIdentity(value)||eventOccurrenceIdentity(value))
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value}
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const notificationPolicy=(value:unknown):value is PlanNotificationPolicy=>typeof value==='string'&&['always','attention','failure','silent'].includes(value)

function source(value:unknown):PlanSource{
 return readPlanSource(value)
}
function fields(value:unknown):PlanScheduleOccurrence['fields']{
 if(isRecord(value)&&Object.hasOwn(value,'executor'))return readOwnerPlanFields(value)
 const row=exact(value,['title','goal','scope','dataScope','delivery','roleId','trigger','notificationPolicy','completionPolicy','groupId']),base=taskDefinition({title:row.title,goal:row.goal,scope:row.scope}),trigger=readScheduleTrigger(row.trigger)
 if(base.title!==row.title||base.goal!==row.goal||base.scope!==row.scope||!text(row.dataScope,8000)||!text(row.delivery,8000)||!uuid(row.roleId)||row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy))throw Error()
 if(Object.hasOwn(row,'groupId')&&row.groupId!==null&&!uuid(row.groupId))throw Error()
 return {...(Object.hasOwn(row,'groupId')?{groupId:row.groupId as string|null}:{}),title:base.title,goal:base.goal,scope:base.scope,dataScope:row.dataScope,delivery:row.delivery,roleId:row.roleId,trigger,...(row.notificationPolicy===undefined?{}:{notificationPolicy:row.notificationPolicy}),...(row.completionPolicy===undefined?{}:{completionPolicy:readTaskCompletionPolicy(row.completionPolicy)})}
}
function occurrence(value:unknown):PlanScheduleOccurrence{
 const row=exact(value,['id','ownerId','planId','planVersion','configVersion','occurrenceId','scheduledAt','claimedAt','taskRequestId','fields','source','roleVersion','invalidated','taskRequest','workDefinition','reportGroup','event'])
 const fixedFields=fields(row.fields),fixedSource=source(row.source),request=exact(row.taskRequest,['requestId','fields','assignee']),requestFields=taskDefinition(exact(request.fields,['title','goal','scope','completionPolicy','groupId'])),assignee=request.assignee===undefined?undefined:exact(request.assignee,['roleId','expectedVersion'])
 let reportGroup:PlanScheduleOccurrence['reportGroup']
 if(row.reportGroup!==undefined){const v=exact(row.reportGroup,['groupId','groupVersion','grantVersion']);if(!uuid(v.groupId)||v.groupId!==fixedFields.groupId||!positive(v.groupVersion)||!positive(v.grantVersion))throw Error();reportGroup={groupId:v.groupId,groupVersion:v.groupVersion,grantVersion:v.grantVersion}}
 if(!!fixedFields.groupId!==!!reportGroup)throw Error()
 const workDefinition=row.workDefinition===undefined?undefined:readPlanWorkDefinition(row.workDefinition)
 const event=row.event===undefined?undefined:readRunPlanEventContext(row.event)
 if(event&&(event.event.ownerId!==row.ownerId||event.event.sourceRef.scope!==fixedFields.scope||row.occurrenceId!=='event:'+event.event.id||!workDefinition||workDefinition.schema!=='teloa.plan-work/v3'||!workDefinition.triggers.some(trigger=>trigger.kind==='local-event'&&'sourceRef'in trigger&&trigger.eventKind===event.event.kind&&same(trigger.sourceRef,event.event.sourceRef))))throw Error()
 if(workDefinition&&(workDefinition.definitionVersion!==row.configVersion||!same(workDefinition.completion,fixedFields.completionPolicy))||eventOccurrenceIdentity(row.occurrenceId)&&!workDefinition)throw Error()
 if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.planId)||!positive(row.planVersion)||!positive(row.configVersion)||row.configVersion>row.planVersion||!occurrenceIdentity(row.occurrenceId)||!timestamp(row.scheduledAt)||!timestamp(row.claimedAt)||row.claimedAt<row.scheduledAt||manualOccurrenceIdentity(row.occurrenceId)&&(row.occurrenceId!=='manual:'+row.taskRequestId||row.claimedAt!==row.scheduledAt)||!uuid(row.taskRequestId)||request.requestId!==row.taskRequestId||!same(requestFields,taskDefinition({title:fixedFields.title,goal:fixedFields.goal,scope:fixedFields.scope,groupId:fixedFields.groupId??null,...(fixedFields.completionPolicy?{completionPolicy:fixedFields.completionPolicy}:{})})))throw Error()
 if(fixedFields.roleId===null){
  const auth=workDefinition?.authorization
  if(row.roleVersion!==null||assignee!==undefined||fixedSource.kind!=='method-reuse'||!workDefinition||auth?.kind!=='owner'||auth.grantId!==row.planId||auth.grantVersion!==row.configVersion||workDefinition.budget.money!==null||workDefinition.triggers.length!==1||workDefinition.triggers[0]?.kind!=='schedule'||!same(workDefinition.triggers[0].schedule,fixedFields.trigger))throw Error()
 }else if(!assignee||assignee.roleId!==fixedFields.roleId||!positive(assignee.expectedVersion)||!positive(row.roleVersion)||assignee.expectedVersion!==row.roleVersion||workDefinition?.authorization.kind==='owner')throw Error()
 let invalidated:PlanScheduleOccurrence['invalidated']
 if(row.invalidated!==undefined){const item=exact(row.invalidated,['reason','observedPlanUpdatedAt']);if(!['plan-paused','plan-archived','plan-version-changed'].includes(String(item.reason))||!timestamp(item.observedPlanUpdatedAt))throw Error();invalidated={reason:item.reason as NonNullable<PlanScheduleOccurrence['invalidated']>['reason'],observedPlanUpdatedAt:item.observedPlanUpdatedAt}}
 return {...(event?{event}:{}),...(reportGroup?{reportGroup}:{}),...(workDefinition?{workDefinition}:{}),id:row.id,ownerId:row.ownerId,planId:row.planId,planVersion:row.planVersion,configVersion:row.configVersion,occurrenceId:row.occurrenceId,scheduledAt:row.scheduledAt,claimedAt:row.claimedAt,taskRequestId:row.taskRequestId,fields:fixedFields,source:fixedSource,roleVersion:row.roleVersion as number|null,...(invalidated?{invalidated}:{}),taskRequest:{requestId:request.requestId as string,fields:{...(Object.hasOwn(request.fields as object,'groupId')?{groupId:requestFields.groupId}:{}),title:requestFields.title,goal:requestFields.goal,scope:requestFields.scope,...(requestFields.completionPolicy?{completionPolicy:requestFields.completionPolicy}:{})},...(assignee?{assignee:{roleId:assignee.roleId as string,expectedVersion:assignee.expectedVersion as number}}:{})}}
}
function skip(value:unknown,planId:string,planVersion:number):PlanScheduleSkip{
 const row=exact(value,['planId','planVersion','configVersion','occurrenceId','scheduledAt','skippedAt','reason','blockingClaimId','taskId'])
 if(row.planId!==planId||!positive(row.planVersion)||row.planVersion>planVersion||!positive(row.configVersion)||row.configVersion>row.planVersion||!occurrenceIdentity(row.occurrenceId)||!timestamp(row.scheduledAt)||!timestamp(row.skippedAt)||row.skippedAt<row.scheduledAt||!uuid(row.blockingClaimId)||!['previous-pending','previous-task-unfinished'].includes(String(row.reason)))throw Error()
 if(row.reason==='previous-pending'?row.taskId!==null:!uuid(row.taskId))throw Error()
 return {planId:row.planId,planVersion:row.planVersion,configVersion:row.configVersion,occurrenceId:row.occurrenceId,scheduledAt:row.scheduledAt,skippedAt:row.skippedAt,reason:row.reason as PlanScheduleSkip['reason'],blockingClaimId:row.blockingClaimId,taskId:row.taskId as string|null}
}
function health(value:unknown):PlanSchedulerHealth{
 const row=exact(value,['health','failureCode','lastAttemptAt','lastSuccessAt'])
 if(!['healthy','failing'].includes(String(row.health))||!timestamp(row.lastAttemptAt)||(row.lastSuccessAt!==null&&!timestamp(row.lastSuccessAt))||typeof row.lastSuccessAt==='string'&&row.lastSuccessAt>row.lastAttemptAt)throw Error()
 if(row.health==='healthy'?row.failureCode!==null:typeof row.failureCode!=='string'||!/^teloa\/[a-z0-9-]{1,100}$/.test(row.failureCode))throw Error()
 return {health:row.health as PlanSchedulerHealth['health'],failureCode:row.failureCode as string|null,lastAttemptAt:row.lastAttemptAt,lastSuccessAt:row.lastSuccessAt as string|null}
}

/** 只读取宿主返回的持久调度事实；不在浏览器计算或补造 nextAt。 */
export function readPlanScheduleSummary(value:unknown,expectedPlanId:string):PlanScheduleSummary{
 try{
  if(!uuid(expectedPlanId))throw Error()
  const row=exact(value,['available','overview','health'])
  if(typeof row.available!=='boolean')throw Error()
  if(!row.available){if(row.overview!==null||row.health!==null)throw Error();return {available:false,overview:null,health:null}}
  let overview:PlanScheduleOverview|null=null
  if(row.overview!==null){
   const item=exact(row.overview,['planId','planVersion','state','nextAt','latest','latestSkip'])
   if(item.planId!==expectedPlanId||!positive(item.planVersion)||!['active','paused','archived'].includes(String(item.state))||(item.nextAt!==null&&!timestamp(item.nextAt))||item.state!=='active'&&item.nextAt!==null)throw Error()
   let latest:PlanScheduleOverview['latest']=null
   if(item.latest!==null){const result=exact(item.latest,['occurrence','task']),fixed=occurrence(result.occurrence);if(fixed.planId!==expectedPlanId||fixed.planVersion>item.planVersion)throw Error();let task:NonNullable<PlanScheduleOverview['latest']>['task']=null;if(result.task!==null){const candidate=exact(result.task,['id','state']);if(!uuid(candidate.id)||!workTaskStates.some(state=>state===candidate.state))throw Error();task={id:candidate.id,state:candidate.state as WorkTask['state']}}latest={occurrence:fixed,task}}
   overview={planId:item.planId,planVersion:item.planVersion,state:item.state as PlanScheduleOverview['state'],nextAt:item.nextAt as string|null,latest,latestSkip:item.latestSkip===null?null:skip(item.latestSkip,expectedPlanId,item.planVersion)}
  }
  return {available:true,overview,health:row.health===null?null:health(row.health)}
 }catch{throw Error('持续计划调度摘要格式不正确。')}
}
