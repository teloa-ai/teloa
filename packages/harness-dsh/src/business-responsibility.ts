import {WorkError,readBusinessResponsibilityRead,readBusinessResponsibilitySet,readBusinessResponsibility,type BusinessResponsibility,type BusinessResponsibilitySet} from '@teloa/contract'
import type {BusinessResponsibilityService} from '@teloa/backend'
export const businessResponsibilityEndpoints=['business-responsibility/read','business-responsibility/set','business-responsibility/receipt'] as const
export type BusinessResponsibilityServices={responsibility:Pick<BusinessResponsibilityService,'read'|'set'|'receipt'>}
const invalid=()=>new WorkError('teloa/invalid-host-response','业务负责人原请求回执与本次选择不一致。')
/** 回执表示原请求结果，不能把其中当时的岗位可用性当成当前授权。 */
export function readBusinessResponsibilityResult(value:unknown,input:BusinessResponsibilitySet):BusinessResponsibility{
 const result=readBusinessResponsibility(value,input.scope)
 if(result.version!==input.expectedVersion+1||result.roleId!==(input.role?.id??null)||result.selectedRoleVersion!==(input.role?.expectedVersion??null)||result.currentRoleVersion!==result.selectedRoleVersion||result.availability!==(input.role?'ready':'none'))throw invalid()
 return result
}
export function createBusinessResponsibilityHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<BusinessResponsibilityServices>){
 return async(endpoint:string,payload:unknown,signal?:AbortSignal):Promise<unknown>=>{
  if(!(businessResponsibilityEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此业务负责人接口。')
  const input=endpoint==='business-responsibility/read'?readBusinessResponsibilityRead(payload):readBusinessResponsibilitySet(payload)
  signal?.throwIfAborted()
  const scopes=await scopeIds()
  if(!scopes.includes(input.scope))throw new WorkError('teloa/forbidden','当前本人无权管理此业务负责人。')
  const actor={ownerId:owner,scopeIds:[input.scope]},service=(await get()).responsibility
  signal?.throwIfAborted()
  if(endpoint==='business-responsibility/read')return readBusinessResponsibility(await service.read(actor,input),input.scope)
  const request=readBusinessResponsibilitySet(input),value=await(endpoint==='business-responsibility/set'?service.set(actor,request):service.receipt(actor,request))
  if(endpoint==='business-responsibility/receipt'&&value===null)return null
  return readBusinessResponsibilityResult(value,request)
 }
}
