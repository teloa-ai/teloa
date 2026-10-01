import {WorkError,taskInput} from '@teloa/contract'
import type {TaskService,TaskTransitions} from '@teloa/backend'
export const taskEndpoints=['tasks/list','tasks/create','tasks/edit','tasks/transition','tasks/completion']
export function createTaskHandler(owner:string,get:()=>Promise<Pick<TaskService,'list'|'create'|'edit'>>,transitions?:()=>Promise<Pick<TaskTransitions,'change'>&Partial<Pick<TaskTransitions,'completion'>>>){
 return async(endpoint:string,payload:unknown)=>{
  if(!taskEndpoints.includes(endpoint))throw new WorkError('teloa/not-found','未提供此任务接口。')
  if(endpoint==='tasks/completion'){taskInput(payload,['taskId']);const service=await transitions?.();if(!service?.completion)throw new WorkError('teloa/conflict','结项服务尚未就绪。');return service.completion(owner,payload)}
  if(endpoint==='tasks/transition'){taskInput(payload,['taskId','requestId','expectedVersion','action','artifact','note']);if(!transitions)throw new WorkError('teloa/conflict','任务状态服务尚未就绪。');return (await transitions()).change(owner,payload)}
  taskInput(payload,endpoint==='tasks/list'?[]:endpoint==='tasks/edit'?['taskId','expectedVersion','fields']:['requestId','fields','assignee'])
  const service=await get();return endpoint==='tasks/list'?service.list(owner,payload):endpoint==='tasks/edit'?service.edit(owner,payload):service.create(owner,payload)
 }
}
