import {readBusinessConfigurationApplyResult,readBusinessConfigurationDraftResponseVersioned,type BusinessConfigurationDraftResponseVersioned,type BusinessConfigurationApplyResult} from '@teloa/contract'
import {readDashboardAdoptionIdentity,type DashboardAdoptionIdentity,type DashboardApplyInput,type DashboardPrepareInput,type DashboardUpgradeInput} from './business-dashboard-resource-api.ts'
export type DashboardMarketAdoption=BusinessConfigurationApplyResult|DashboardAdoptionIdentity
export type DashboardMarketPending={upgrade?:{request:DashboardUpgradeInput;candidateVersion:string;draftId?:string};resourceId?:string;result?:DashboardMarketAdoption;prepare?:DashboardPrepareInput;draft?:BusinessConfigurationDraftResponseVersioned;apply?:DashboardApplyInput}
/** 原请求先保存再投递；按本人/宿主命名空间隔离，只恢复同一固定内容。 */
export function createDashboardMarketJournal(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,namespace:string){
 const key=(contentId:string)=>'teloa:dashboard-market:v1:'+encodeURIComponent(namespace)+':'+contentId
 return {
  read(contentId:string):DashboardMarketPending|undefined{
   const raw=storage.getItem(key(contentId));if(raw===null)return undefined
   const row=JSON.parse(raw) as DashboardMarketPending
   if(!row||typeof row!=='object'||Object.keys(row).some(k=>!['upgrade','resourceId','result','prepare','draft','apply'].includes(k))||!row.prepare&&!row.draft)throw Error('看板恢复记录格式不正确。')
   if(row.prepare&&(row.prepare.contentId!==contentId||typeof row.prepare.requestId!=='string'||typeof row.prepare.resourceId!=='string'||!row.prepare.target))throw Error('看板恢复内容身份不一致。')
   if(row.draft)row.draft=readBusinessConfigurationDraftResponseVersioned(row.draft)
   if(row.upgrade&&(!row.draft||!row.result||row.upgrade.request.adoptionId!==row.draft.id||typeof row.upgrade.request.candidateContentId!=='string'||typeof row.upgrade.request.candidateContentHash!=='string'||typeof row.upgrade.candidateVersion!=='string'))throw Error('看板升级恢复来源不一致。')
   if(row.resourceId!==undefined&&!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(row.resourceId))throw Error('看板恢复资源身份不正确。')
   if(row.result){row.result='requestId' in row.result?readBusinessConfigurationApplyResult(row.result):readDashboardAdoptionIdentity(row.result);if(!row.draft||row.result.scope!==row.draft.scope||row.result.version!==row.draft.baseVersion+1||'draftId' in row.result&&(row.result.draftId!==row.draft.id||row.draft.status!=='applied'))throw Error('看板采用记录身份不一致。')}
   if(row.apply&&(!row.draft||row.apply.draftId!==row.draft.id||row.apply.expectedRevision!==row.draft.revision||row.apply.expectedBaseVersion!==row.draft.baseVersion))throw Error('看板恢复草案身份不一致。')
   return row
  },
  write(contentId:string,value:DashboardMarketPending){storage.setItem(key(contentId),JSON.stringify(value))},
  clear(contentId:string){storage.removeItem(key(contentId))},
 }
}
export type DashboardMarketJournal=ReturnType<typeof createDashboardMarketJournal>
