import {WorkError,taskInput} from '@teloa/contract'
import type {TaskRunFlowService} from '@teloa/backend'

export const taskRunFlowEndpoints=['task-run-flows/get','task-run-flows/transition'] as const
export const confirmedTaskRunFlowEndpoints=['task-run-flows/create-confirmed','task-run-flows/wait-sources','task-run-flows/rebind-wait-confirmed'] as const
/** 只能装入已认证本人的 /teloa 分支，禁止加入 invoke/IM 的 endpointSet。 */
export function createConfirmedTaskRunFlowHandler(owner:string,get:()=>Promise<Pick<TaskRunFlowService,'createConfirmed'|'waitSources'|'rebindWaitConfirmed'>>){return async(endpoint:string,payload:unknown,signal:AbortSignal)=>{signal.throwIfAborted();const service=await get();if(endpoint==='task-run-flows/create-confirmed')return service.createConfirmed(owner,payload);if(endpoint==='task-run-flows/wait-sources')return service.waitSources(owner,payload);if(endpoint==='task-run-flows/rebind-wait-confirmed')return service.rebindWaitConfirmed(owner,payload);throw new WorkError('teloa/not-found','未提供此本人工作流程接口。')}}

export function createTaskRunFlowHandler(owner:string,get:()=>Promise<Pick<TaskRunFlowService,'get'|'transition'>>){
 return async(endpoint:string,payload:unknown,signal:AbortSignal)=>{
  if(!(taskRunFlowEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此内部 Flow 接口。')
  taskInput(payload,endpoint==='task-run-flows/get'?['runId']:['requestId','flowId','stepId','action','expectedAttempts','outputSummary','waitReason'])
  signal.throwIfAborted()
  const service=await get()
  if(endpoint==='task-run-flows/get')return service.get(owner,payload)
  return service.transition(owner,payload)
 }
}
