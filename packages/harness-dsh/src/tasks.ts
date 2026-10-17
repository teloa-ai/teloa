import {WorkError,taskInput} from '@teloa/contract'
import type {TaskService,TaskTransitions} from '@teloa/backend'
export const confirmedTaskEndpoint='tasks/create-confirmed'
export const taskEndpoints=['tasks/list','tasks/create','tasks/edit','tasks/configure','tasks/configuration-request','tasks/create-configuration','tasks/create-configuration-request','tasks/transition','tasks/completion']
export function createTaskHandler(owner:string,get:()=>Promise<Pick<TaskService,'list'|'create'|'edit'>&Partial<Pick<TaskService,'createConfirmed'|'configure'|'configurationRequest'|'createConfiguration'|'createConfigurationRequest'>>>,transitions?:()=>Promise<Pick<TaskTransitions,'change'>&Partial<Pick<TaskTransitions,'completion'>>>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
  if(!taskEndpoints.includes(endpoint)&&endpoint!==confirmedTaskEndpoint)throw new WorkError('teloa/not-found','未提供此任务接口。')
  if(endpoint==='tasks/completion'){taskInput(payload,['taskId']);const service=await transitions?.();if(!service?.completion)throw new WorkError('teloa/conflict','结项服务尚未就绪。');return service.completion(owner,payload)}
  if(endpoint==='tasks/transition'){taskInput(payload,['taskId','requestId','expectedVersion','action','artifact','note']);if(!transitions)throw new WorkError('teloa/conflict','任务状态服务尚未就绪。');return (await transitions()).change(owner,payload)}
  taskInput(payload,endpoint==='tasks/list'?[]:endpoint==='tasks/edit'?['taskId','expectedVersion','fields']:endpoint==='tasks/configure'?['requestId','taskId','expectedVersion','fields','taskName','groupName']:endpoint==='tasks/configuration-request'||endpoint==='tasks/create-configuration-request'?['requestId']:endpoint==='tasks/create-configuration'?['requestId','sessionId','fields','groupName','businessName']:['requestId','fields','assignee'])
  const service=await get()
  if(endpoint==='tasks/configure'){if(!service.configure)throw new WorkError('teloa/unavailable','任务配置服务尚未就绪。');return service.configure(owner,payload,signal)}
  if(endpoint==='tasks/configuration-request'){if(!service.configurationRequest)throw new WorkError('teloa/unavailable','任务配置回执尚未就绪。');return service.configurationRequest(owner,payload)}
  if(endpoint==='tasks/create-configuration'){if(!service.createConfiguration)throw new WorkError('teloa/unavailable','任务草稿创建服务尚未就绪。');return service.createConfiguration(owner,payload,signal)}
  if(endpoint==='tasks/create-configuration-request'){if(!service.createConfigurationRequest)throw new WorkError('teloa/unavailable','任务草稿创建回执尚未就绪。');return service.createConfigurationRequest(owner,payload)}
  if(endpoint==='tasks/create-confirmed'){if(!service.createConfirmed)throw new WorkError('teloa/forbidden','此入口不提供本人执行确认。');return service.createConfirmed(owner,payload)}
  return endpoint==='tasks/list'?service.list(owner,payload):endpoint==='tasks/edit'?service.edit(owner,payload):service.create(owner,payload,signal)
 }
}
