import {createHash} from 'node:crypto'
import {WorkError,businessDashboardShareEndpoint,businessDashboardShareSnapshotText,readBusinessDashboardShareTarget,readBusinessDashboardShareSnapshot,taskInput} from '@teloa/contract'
import type {BusinessConfigurationPageService,BusinessDashboardService} from '@teloa/backend'
export {businessDashboardShareEndpoint} from '@teloa/contract'
/** 只读本人界面入口：主体与范围来自宿主，模型参数不能指定或扩大权限。 */
export function createBusinessDashboardShareHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<{pages:Pick<BusinessConfigurationPageService,'shareSnapshot'>;dashboards:Pick<BusinessDashboardService,'shareSnapshot'>}>){
 return async(endpoint:string,input:unknown,signal?:AbortSignal)=>{
  if(endpoint!==businessDashboardShareEndpoint)throw new WorkError('teloa/not-found','未提供此看板分享接口。')
  const target=readBusinessDashboardShareTarget(taskInput(input,['target']).target)
  signal?.throwIfAborted()
  const allowed=await scopeIds()
  if(!owner||!allowed.includes(target.scope))throw new WorkError('teloa/forbidden','当前主体未获准分享此业务看板。')
  const services=await get(),actor={ownerId:owner,scopeIds:[...allowed]}
  const result=readBusinessDashboardShareSnapshot(await(target.kind==='configuration'?services.pages:services.dashboards).shareSnapshot(actor,target,signal))
  const {snapshotHash,...body}=result
  if(JSON.stringify(result.target)!==JSON.stringify(target)||createHash('sha256').update(businessDashboardShareSnapshotText(body)).digest('hex')!==snapshotHash)throw new WorkError('teloa/invalid-host-response','看板分享快照与原业务、版本或范围不一致。')
  signal?.throwIfAborted()
  return result
 }
}
