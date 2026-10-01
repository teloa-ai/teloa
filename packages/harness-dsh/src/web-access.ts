import {WorkError,taskInput,isWebAccessPolicy} from '@teloa/contract'
import type {WebAccessPolicyService} from '@teloa/backend'

export const webAccessEndpoints=['web-access/get','web-access/change'] as const

const invalidResponse=()=>new WorkError('teloa/invalid-host-response','上网设置服务返回了无效结果。')

/** 上网设置只由认证后的工作台 RPC 调用；本人身份由宿主固定。 */
export function createWebAccessHandler(owner:string,get:()=>Promise<Pick<WebAccessPolicyService,'get'|'change'>>){
 return async(endpoint:string,payload:unknown):Promise<unknown>=>{
  if(!(webAccessEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此上网设置接口。')
  // 先过契约解析器再开服务：未经逐字解析的入参一个字段都不许到达服务层。
  taskInput(payload,endpoint==='web-access/change'?['requestId','expectedVersion','enabled','blocked']:[])
  const service=await get()
  const result=endpoint==='web-access/change'?await service.change(owner,payload):await service.get(owner,payload)
  // 回包过契约判定器再核形状：不是精确三键的策略对象一律不交给浏览器。
  if(!isWebAccessPolicy(result))throw invalidResponse()
  return result
 }
}
