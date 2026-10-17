import {WorkError,projectContextRead,projectContextMutation} from '@teloa/contract'
import type {ProjectContextService} from '@teloa/backend'
export const projectContextEndpoints=['project-context/get','project-context/mutate'] as const
/** 仅本人工作台 RPC；不注册模型工具，不从 payload 接收本人身份。 */
export function createProjectContextHandler(owner:string,get:()=>Promise<Pick<ProjectContextService,'get'|'mutate'>>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal)=>{
  if(!(projectContextEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此项目上下文接口。')
  const input=endpoint==='project-context/get'?projectContextRead(payload):projectContextMutation(payload)
  signal?.throwIfAborted();const service=await get();signal?.throwIfAborted()
  return endpoint==='project-context/get'?service.get(owner,input):service.mutate(owner,input,signal)
 }
}
