import {WorkError,taskInput} from '@teloa/contract'
import type {RoleDelegationService,TwinExecutionConsentService} from '@teloa/backend'

export const roleDelegationEndpoints=['role-delegations/get','role-delegations/change','twin-execution-consents/confirm','twin-execution-consents/revoke'] as const
/** 只装配本人 RPC；执行工具和群自动派发不持有授予服务实例。 */
export function createRoleDelegationHandler(owner:string,get:()=>Promise<Pick<RoleDelegationService,'get'|'change'>>,consents:()=>Promise<Pick<TwinExecutionConsentService,'confirm'|'revoke'>>){
 return async(endpoint:string,payload:unknown)=>{
  if(endpoint==='role-delegations/get'){taskInput(payload,['roleId']);return (await get()).get(owner,payload as Parameters<RoleDelegationService['get']>[1])}
  if(endpoint==='role-delegations/change'){taskInput(payload,['requestId','roleId','expectedRoleVersion','expectedVersion','action','fields']);return (await get()).change(owner,payload as Parameters<RoleDelegationService['change']>[1])}
  if(endpoint==='twin-execution-consents/confirm'){taskInput(payload,['requestId','roleId','expectedRoleVersion','authorization']);return (await consents()).confirm(owner,payload as Parameters<TwinExecutionConsentService['confirm']>[1])}
  if(endpoint==='twin-execution-consents/revoke'){taskInput(payload,['requestId','consentId','expectedVersion']);return (await consents()).revoke(owner,payload as Parameters<TwinExecutionConsentService['revoke']>[1])}
  throw new WorkError('teloa/not-found','未提供此执行委托接口。')
 }
}
