import {WorkError,taskInput,isRecord,readBusinessDashboardResource,readBusinessConfigurationDraftResponseVersioned,readBusinessConfigurationPreviewResponse,readBusinessConfigurationApplyResult,readBusinessConfigurationPageProjectionVersioned} from '@teloa/contract'
import type {BusinessDashboardResourceService} from '@teloa/backend'

export const businessDashboardResourceEndpoints=['business-dashboard-resources/export','business-dashboard-resources/prepare','business-dashboard-resources/prepare-upgrade','business-dashboard-resources/adoption','business-dashboard-resources/preview','business-dashboard-resources/apply','business-dashboard-resources/page'] as const
const inputKeys:Record<string,readonly string[]>={
 'business-dashboard-resources/export':['scope','id','version'],
 'business-dashboard-resources/prepare':['requestId','contentId','contentHash','resourceId','target','objectMapping'],
 'business-dashboard-resources/prepare-upgrade':['requestId','adoptionId','candidateContentId','candidateContentHash','resourceId','expectedConfigurationVersion','choices'],
 'business-dashboard-resources/adoption':['draftId'],
 'business-dashboard-resources/preview':['draftId','expectedRevision'],
 'business-dashboard-resources/apply':['requestId','draftId','expectedRevision','expectedBaseVersion','previewReceipt'],
 'business-dashboard-resources/page':['draftId','expectedRevision','pageId','timeRange'],
}
/** 本人入口只准备配置；采用继续走业务预览与 apply 的真实授权边界。 */
export function createBusinessDashboardResourceHandler(ownerId:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<Pick<BusinessDashboardResourceService,'exportCurrent'|'prepare'|'prepareUpgrade'|'adoption'|'preview'|'apply'|'page'>>):(endpoint:string,input:unknown,signal?:AbortSignal)=>Promise<unknown>{
 return async(endpoint:string,input:unknown,signal?:AbortSignal)=>{
  if(!(businessDashboardResourceEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此业务看板资源接口。')
  signal?.throwIfAborted()
  const payload=taskInput(input,inputKeys[endpoint]!)
  const actor={ownerId,scopeIds:[...await scopeIds()].filter(scope=>scope!=='general')}
  signal?.throwIfAborted()
  const service=await get()
  signal?.throwIfAborted()
  if(endpoint==='business-dashboard-resources/adoption'){
   const result=await service.adoption(actor,payload)
   if(result===null)return null
   if(!isRecord(result)||Object.keys(result).length!==4||result.draftId!==String(payload.draftId).toLowerCase()||typeof result.scope!=='string'||!actor.scopeIds.includes(result.scope)||!Number.isSafeInteger(result.version)||result.version<1||typeof result.configurationHash!=='string'||!/^[a-f0-9]{64}$/.test(result.configurationHash))throw new WorkError('teloa/invalid-host-response','看板采用身份回包不正确。')
   return result
  }
  if(endpoint==='business-dashboard-resources/prepare-upgrade'){
   const result=await service.prepareUpgrade(actor,payload)
   if(!Array.isArray(result.conflicts)||!Array.isArray(result.changed)||result.changed.some(key=>typeof key!=='string')||result.conflicts.some(row=>!isRecord(row)||typeof row.key!=='string'||!['definition','page','home-page'].includes(row.entity)||typeof row.id!=='string')||result.draft!==null&&result.conflicts.length)throw new WorkError('teloa/invalid-host-response','升级差异回包格式不正确。')
   const draft=result.draft===null?null:readBusinessConfigurationDraftResponseVersioned(result.draft)
   if(draft&&draft.ownerId!==ownerId)throw new WorkError('teloa/invalid-host-response','升级草案不属于当前本人。')
   return {...result,draft}
  }
  if(endpoint==='business-dashboard-resources/preview')return readBusinessConfigurationPreviewResponse(await service.preview(actor,payload))
  if(endpoint==='business-dashboard-resources/apply')return readBusinessConfigurationApplyResult(await service.apply(actor,payload,signal))
  if(endpoint==='business-dashboard-resources/page')return readBusinessConfigurationPageProjectionVersioned(await service.page(actor,payload,signal))
  if(endpoint==='business-dashboard-resources/prepare'){
   const result=readBusinessConfigurationDraftResponseVersioned(await service.prepare(actor,payload))
   if(result.ownerId!==ownerId)throw new WorkError('teloa/invalid-host-response','看板准备结果不属于当前本人。')
   return result
  }
  const result=await service.exportCurrent(actor,payload)
  try{return {...result,resource:readBusinessDashboardResource(result.resource)}}catch{throw new WorkError('teloa/invalid-host-response','看板导出结果不是有效的固定业务配置资源。')}
 }
}
