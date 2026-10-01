import {WorkError,isRecord,workTaskStates} from '@teloa/contract'
import type {PlanExecutionHistoryPage,PlanSkipHistoryPage} from '@teloa/backend'
import {planExecutionHistoryInput,planExecutionHistoryResponse,type PlanExecutionHistoryInput} from './plan-execution-history.ts'
import {planSkipHistoryInput,planSkipHistoryResponse,type PlanSkipHistoryInput} from './plan-skip-history.ts'

export const planScheduleEndpoints=['plans/schedule','plans/executions','plans/skips'] as const

export type PlanSchedulePorts={
 isAvailable:()=>boolean
 overview:(owner:string,input:{planId:string})=>Promise<unknown>
 getStatus:(owner:string,input:{planId?:string})=>Promise<unknown>
 executionHistory:(owner:string,input:PlanExecutionHistoryInput)=>Promise<unknown>
 skipHistory:(owner:string,input:PlanSkipHistoryInput)=>Promise<unknown>
}

export type PlanScheduleHealth={health:'healthy'|'failing';failureCode:string|null;lastAttemptAt:string;lastSuccessAt:string|null}
export type PlanScheduleResponse={available:false;overview:null;health:null}|{available:true;overview:Record<string,unknown>;health:PlanScheduleHealth|null}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const timestamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const parsed=new Date(value);return Number.isFinite(parsed.getTime())&&parsed.toISOString()===value}
const safeCode=(value:unknown):value is string=>typeof value==='string'&&/^teloa\/[a-z0-9-]{1,100}$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','持续计划调度查询格式不正确或包含未知字段。')
const invalidResponse=()=>new WorkError('teloa/invalid-host-response','持续计划调度服务返回了无效或跨本人的结果。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const response=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalidResponse();return value}

function overview(value:unknown,owner:string,planId:string):Record<string,unknown>{
 const row=response(value,['planId','planVersion','state','nextAt','latest','latestSkip'])
 if(row.planId!==planId||!positive(row.planVersion)||!['active','paused','archived'].includes(String(row.state))||row.nextAt!==null&&!timestamp(row.nextAt)||row.state!=='active'&&row.nextAt!==null)throw invalidResponse()
 if(row.latest!==null){
  const latest=response(row.latest,['occurrence','task']),occurrence=response(latest.occurrence,['id','ownerId','planId','planVersion','configVersion','occurrenceId','scheduledAt','claimedAt','taskRequestId','fields','source','roleVersion','invalidated','taskRequest'])
  if(occurrence.ownerId!==owner||occurrence.planId!==planId||!positive(occurrence.planVersion)||(occurrence.planVersion as number)>(row.planVersion as number))throw invalidResponse()
  if(latest.task!==null){const task=response(latest.task,['id','state']);if(!uuid(task.id)||!workTaskStates.some(state=>state===task.state))throw invalidResponse()}
 }
 if(row.latestSkip!==null){const skip=response(row.latestSkip,['planId','planVersion','configVersion','occurrenceId','scheduledAt','skippedAt','reason','blockingClaimId','taskId']);if(skip.planId!==planId||!positive(skip.planVersion)||(skip.planVersion as number)>(row.planVersion as number))throw invalidResponse()}
 return row
}

function health(value:unknown,owner:string,planId:string|null):PlanScheduleHealth{
 const row=response(value,['ownerId','planId','health','failureCode','lastAttemptAt','lastSuccessAt'])
 if(row.ownerId!==owner||row.planId!==planId||!['healthy','failing'].includes(String(row.health))||!timestamp(row.lastAttemptAt)||(row.lastSuccessAt!==null&&!timestamp(row.lastSuccessAt))||typeof row.lastSuccessAt==='string'&&row.lastSuccessAt>row.lastAttemptAt)throw invalidResponse()
 if(row.health==='healthy'?row.failureCode!==null:!safeCode(row.failureCode))throw invalidResponse()
 return {health:row.health as PlanScheduleHealth['health'],failureCode:row.failureCode as string|null,lastAttemptAt:row.lastAttemptAt,lastSuccessAt:row.lastSuccessAt as string|null}
}

/** 认证后的只读工作台 RPC；不可用时不访问持久服务，也不推导任何调度事实。 */
export function createPlanScheduleHandler(owner:string,ports:PlanSchedulePorts){
  return async(endpoint:string,payload:unknown):Promise<PlanScheduleResponse|PlanExecutionHistoryPage|PlanSkipHistoryPage>=>{
  if(endpoint==='plans/skips'){
   const input=planSkipHistoryInput(payload)
   return planSkipHistoryResponse(await ports.skipHistory(owner,input),input)
  }
  if(endpoint==='plans/executions'){
   const input=planExecutionHistoryInput(payload)
   return planExecutionHistoryResponse(await ports.executionHistory(owner,input),input)
  }
  if(endpoint!=='plans/schedule')throw new WorkError('teloa/not-found','未提供此持续计划调度接口。')
  const input=exact(payload,['planId']);if(!uuid(input.planId))throw invalid()
  const available=ports.isAvailable();if(typeof available!=='boolean')throw invalidResponse()
  if(!available)return {available:false,overview:null,health:null}
  const request={planId:input.planId}
  const [rawOverview,planStatus]=await Promise.all([ports.overview(owner,request),ports.getStatus(owner,request)])
  const fixedOverview=overview(rawOverview,owner,input.planId)
  if(planStatus!==null)return {available:true,overview:fixedOverview,health:health(planStatus,owner,input.planId)}
  const ownerStatus=await ports.getStatus(owner,{})
  return {available:true,overview:fixedOverview,health:ownerStatus===null?null:health(ownerStatus,owner,null)}
 }
}
