import {WorkError,taskInput} from '@teloa/contract'
import type {TaskRunFlowService} from '@teloa/backend'

export const taskRunFlowEndpoints=['task-run-flows/get','task-run-flows/transition'] as const

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
