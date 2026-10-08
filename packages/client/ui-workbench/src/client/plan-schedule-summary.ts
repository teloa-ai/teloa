import {isRecord,readScheduleTrigger,readTaskCompletionPolicy,readPlanWorkDefinition,taskDefinition,workTaskStates,type PlanWorkDefinition,type TaskCompletionPolicy,type ScheduleTrigger,type WorkTask} from '@teloa/contract'
import type {PlanNotificationPolicy,PlanSource} from './plan-api.ts'

export type PlanScheduleOccurrence={
 workDefinition?:PlanWorkDefinition
 id:string;ownerId:string;planId:string;planVersion:number;configVersion:number;occurrenceId:string;scheduledAt:string;claimedAt:string;taskRequestId:string
 fields:{title:string;goal:string;scope:string;dataScope:string;delivery:string;roleId:string;trigger:ScheduleTrigger;notificationPolicy?:PlanNotificationPolicy;completionPolicy?:TaskCompletionPolicy}
 source:PlanSource;roleVersion:number
 invalidated?:{reason:'plan-paused'|'plan-archived'|'plan-version-changed';observedPlanUpdatedAt:string}
 taskRequest:{requestId:string;fields:{title:string;goal:string;scope:string;completionPolicy?:TaskCompletionPolicy};assignee:{roleId:string;expectedVersion:number}}
}
export type PlanScheduleSkip={planId:string;planVersion:number;configVersion:number;occurrenceId:string;scheduledAt:string;skippedAt:string;reason:'previous-pending'|'previous-task-unfinished';blockingClaimId:string;taskId:string|null}
export type PlanSchedulerHealth={health:'healthy'|'failing';failureCode:string|null;lastAttemptAt:string;lastSuccessAt:string|null}
export type PlanScheduleOverview={planId:string;planVersion:number;state:'active'|'paused'|'archived';nextAt:string|null;latest:{occurrence:PlanScheduleOccurrence;task:{id:string;state:WorkTask['state']}|null}|null;latestSkip:PlanScheduleSkip|null}
export type PlanScheduleSummary={available:boolean;overview:PlanScheduleOverview|null;health:PlanSchedulerHealth|null}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.trim()===value&&value.length<=max
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const timestamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const scheduledOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\[(?:Asia\/Singapore|Asia\/Shanghai|UTC)\]$/.test(value)
const manualOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&/^manual:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const eventOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&value.startsWith('event:')&&uuid(value.slice(6))
const occurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&(scheduledOccurrenceIdentity(value)||manualOccurrenceIdentity(value)||eventOccurrenceIdentity(value))
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value}
const same=(left:unknown,right:unknown)=>JSON.stringify(left)===JSON.stringify(right)
const notificationPolicy=(value:unknown):value is PlanNotificationPolicy=>typeof value==='string'&&['always','attention','failure','silent'].includes(value)

function source(value:unknown):PlanSource{
 const row=exact(value,['kind','contentId','contentHash','resourceId','resourceVersion','roleId'])
 if(row.kind==='manual'){if(Object.keys(row).length!==1)throw Error();return {kind:'manual'}}
 // 与 plan-api.ts 的 readSource 逐字同口径：Auto Dream 的系统计划来源只有两键。
 if(row.kind==='system-digest'){if(Object.keys(row).length!==2||!uuid(row.roleId))throw Error();return {kind:'system-digest',roleId:row.roleId}}
 if(row.kind!=='market-content'||!uuid(row.contentId)||!hash(row.contentHash)||!stableId(row.resourceId)||!semver(row.resourceVersion))throw Error()
 return {kind:'market-content',contentId:row.contentId,contentHash:row.contentHash,resourceId:row.resourceId,resourceVersion:row.resourceVersion}
}
function fields(value:unknown):PlanScheduleOccurrence['fields']{
 const row=exact(value,['title','goal','scope','dataScope','delivery','roleId','trigger','notificationPolicy','completionPolicy']),base=taskDefinition({title:row.title,goal:row.goal,scope:row.scope}),trigger=readScheduleTrigger(row.trigger)
 if(base.title!==row.title||base.goal!==row.goal||base.scope!==row.scope||!text(row.dataScope,8000)||!text(row.delivery,8000)||!uuid(row.roleId)||row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy))throw Error()
 return {title:base.title,goal:base.goal,scope:base.scope,dataScope:row.dataScope,delivery:row.delivery,roleId:row.roleId,trigger,...(row.notificationPolicy===undefined?{}:{notificationPolicy:row.notificationPolicy}),...(row.completionPolicy===undefined?{}:{completionPolicy:readTaskCompletionPolicy(row.completionPolicy)})}
}
function occurrence(value:unknown):PlanScheduleOccurrence{
 const row=exact(value,['id','ownerId','planId','planVersion','configVersion','occurrenceId','scheduledAt','claimedAt','taskRequestId','fields','source','roleVersion','invalidated','taskRequest','workDefinition'])
 const fixedFields=fields(row.fields),fixedSource=source(row.source),request=exact(row.taskRequest,['requestId','fields','assignee']),requestFields=taskDefinition(exact(request.fields,['title','goal','scope','completionPolicy'])),assignee=exact(request.assignee,['roleId','expectedVersion'])
 const workDefinition=row.workDefinition===undefined?undefined:readPlanWorkDefinition(row.workDefinition)
 if(workDefinition&&(workDefinition.definitionVersion!==row.configVersion||!same(workDefinition.completion,fixedFields.completionPolicy))||eventOccurrenceIdentity(row.occurrenceId)&&!workDefinition)throw Error()
 if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.planId)||!positive(row.planVersion)||!positive(row.configVersion)||row.configVersion>row.planVersion||!occurrenceIdentity(row.occurrenceId)||!timestamp(row.scheduledAt)||!timestamp(row.claimedAt)||row.claimedAt<row.scheduledAt||manualOccurrenceIdentity(row.occurrenceId)&&(row.occurrenceId!=='manual:'+row.taskRequestId||row.claimedAt!==row.scheduledAt)||!uuid(row.taskRequestId)||request.requestId!==row.taskRequestId||!same(requestFields,taskDefinition({title:fixedFields.title,goal:fixedFields.goal,scope:fixedFields.scope,...(fixedFields.completionPolicy?{completionPolicy:fixedFields.completionPolicy}:{})}))||assignee.roleId!==fixedFields.roleId||!positive(assignee.expectedVersion)||!positive(row.roleVersion)||assignee.expectedVersion!==row.roleVersion)throw Error()
 let invalidated:PlanScheduleOccurrence['invalidated']
 if(row.invalidated!==undefined){const item=exact(row.invalidated,['reason','observedPlanUpdatedAt']);if(!['plan-paused','plan-archived','plan-version-changed'].includes(String(item.reason))||!timestamp(item.observedPlanUpdatedAt))throw Error();invalidated={reason:item.reason as NonNullable<PlanScheduleOccurrence['invalidated']>['reason'],observedPlanUpdatedAt:item.observedPlanUpdatedAt}}
 return {...(workDefinition?{workDefinition}:{}),id:row.id,ownerId:row.ownerId,planId:row.planId,planVersion:row.planVersion,configVersion:row.configVersion,occurrenceId:row.occurrenceId,scheduledAt:row.scheduledAt,claimedAt:row.claimedAt,taskRequestId:row.taskRequestId,fields:fixedFields,source:fixedSource,roleVersion:row.roleVersion,...(invalidated?{invalidated}:{}),taskRequest:{requestId:request.requestId as string,fields:{title:requestFields.title,goal:requestFields.goal,scope:requestFields.scope,...(requestFields.completionPolicy?{completionPolicy:requestFields.completionPolicy}:{})},assignee:{roleId:assignee.roleId as string,expectedVersion:assignee.expectedVersion}}}
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
