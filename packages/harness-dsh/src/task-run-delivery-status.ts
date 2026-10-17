import {isDeepStrictEqual} from 'node:util'
import type {TaskRun} from '@teloa/backend'
import {WorkError,type GoalObservationContext} from '@teloa/contract'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {observeTaskRun} from './task-run-observation.ts'
import {readTaskRunGroupResult} from './task-run-group-result.ts'

export type TaskRunDeliveryCheck=Readonly<{state:'saved'|'review-required'|'unknown'}>
export type TaskRunDeliveryReader={read:(owner:string,run:TaskRun)=>Promise<TaskRunDeliveryCheck|undefined>}
type DeliveryReadPorts={
 receipt:(owner:string,run:TaskRun)=>Promise<boolean>
 events:(run:TaskRun)=>Promise<readonly SessionEvent[]>
 continuations?:(run:TaskRun,events:readonly SessionEvent[])=>Promise<ReadonlySet<string>>
 goalObservation?:(run:TaskRun,events:readonly SessionEvent[])=>Promise<GoalObservationContext|undefined>
}
const unavailableCodes:ReadonlySet<string>=new Set(['teloa/dependency-unavailable','teloa/storage-unavailable','teloa/source-unavailable','teloa/session-unavailable','teloa/unavailable','teloa/storage-corrupt'])

/** 只读原运行的正式交付证明；saved 不代表本人认可，也不启动发布、复核或重试。 */
export function createTaskRunDeliveryReader(ports:DeliveryReadPorts):TaskRunDeliveryReader{
 return {async read(owner,run){
  if(run.executor?.kind!=='owner'||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null)return undefined
  try{
   if(await ports.receipt(owner,run))return {state:'saved'}
   const events=(await ports.events(run)).slice(0,run.evidence.endSeq+1)
   const continuations=await ports.continuations?.(run,events),goal=await ports.goalObservation?.(run,events)
   if(!isDeepStrictEqual(observeTaskRun(events,run.nativeRequestId,continuations,goal),run.evidence))return {state:'unknown'}
   const result=readTaskRunGroupResult(events,run.nativeRequestId,continuations,goal,{requireReview:true,runId:run.id})
   // 有完整复核仍不等于正式成果已经保存，不能用正文推定保存成功。
   return {state:result===undefined?'review-required':'unknown'}
  }catch(error){
   if(error instanceof WorkError&&unavailableCodes.has(error.code))return {state:'unknown'}
   throw error
  }
 }}
}
