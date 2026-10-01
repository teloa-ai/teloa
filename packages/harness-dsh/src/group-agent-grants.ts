import {WorkError,groupAgentGrantChangeInput,groupAgentGrantGetInput} from '@teloa/contract'

export const groupAgentGrantEndpoints=['groups/agent-grants/get','groups/agent-grants/change'] as const

type GroupAgentGrantOperations={
 get:(owner:string,input:unknown)=>Promise<unknown>
 change:(owner:string,input:unknown)=>Promise<unknown>
}

/** 群内AI 员工授权始终固定为宿主本人签发，浏览器不能提交 owner 或越过输入解析。 */
export function createGroupAgentGrantHandler(owner:string,get:()=>Promise<GroupAgentGrantOperations|undefined>){
 return async(endpoint:string,payload:unknown)=>{
  if(!(groupAgentGrantEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此群员工授权接口。')
  if(endpoint==='groups/agent-grants/get')groupAgentGrantGetInput(payload)
  else groupAgentGrantChangeInput(payload)
  const service=await get()
  if(!service)throw new WorkError('teloa/host-unavailable','群员工授权服务尚未就绪。')
  return endpoint==='groups/agent-grants/get'?service.get(owner,payload):service.change(owner,payload)
 }
}
