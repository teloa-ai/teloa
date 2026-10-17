import {WorkError,taskInput,readBusinessChangeSetApply,readBusinessRecordGet,readBusinessRecordReceipt,readBusinessWorkCursor,readBusinessResultCursor} from '@teloa/contract'
import type {BusinessChangeSetService,BusinessObjectWorkLinkService} from '@teloa/backend'
export const businessWorkEndpoints=['business-work/link','business-work/list','business-work/results','business-work/open','business-changes/list','business-changes/get','business-changes/reject','business-changes/intent'] as const
type Services={changes:BusinessChangeSetService;objectWork:BusinessObjectWorkLinkService}
/** 对外只有读取、拒绝及原生意图；故意没有 apply/approved RPC。 */
export function createBusinessWorkHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<Services>,authorizeSession:(scope:string,sessionId:string,signal:AbortSignal)=>Promise<void>){
 return async(endpoint:string,payload:unknown,signal=new AbortController().signal)=>{
  if(!(businessWorkEndpoints as readonly string[]).includes(endpoint))throw new WorkError('teloa/not-found','未提供此业务工作接口。')
  const actor={ownerId:owner,scopeIds:[...await scopeIds()]},services=await get();signal.throwIfAborted()
  if(endpoint==='business-work/open'){const row=taskInput(payload,['scope','sessionId']);if(typeof row.scope!=='string'||typeof row.sessionId!=='string'||!actor.scopeIds.includes(row.scope))throw new WorkError('teloa/forbidden','原工作业务归属尚未确认。');await authorizeSession(row.scope,row.sessionId,signal);return {sessionId:row.sessionId}}
  if(endpoint==='business-work/link')return services.objectWork.link(actor,payload)
  if(endpoint==='business-work/list'){const row=taskInput(payload,['scope','type','id','cursor']),target=readBusinessRecordGet({scope:row.scope,type:row.type,id:row.id}),page=await services.objectWork.listPage(actor,{...target,cursor:readBusinessWorkCursor(row.cursor)});return {...page,taskResults:await services.objectWork.taskResults(actor,target)}}
  if(endpoint==='business-work/results'){const row=taskInput(payload,['workLinkId','cursor']);readBusinessRecordReceipt({requestId:row.workLinkId});return services.objectWork.resultsPage(actor,{workLinkId:row.workLinkId as string,cursor:readBusinessResultCursor(row.cursor)})}
  if(endpoint==='business-changes/list'){const row=taskInput(payload,['scope','history','cursor']);if(typeof row.scope!=='string'||row.history!==undefined&&typeof row.history!=='boolean')throw new WorkError('teloa/invalid-input','需要业务范围。');return services.changes.listPage(actor,{scope:row.scope,history:row.history===true,cursor:readBusinessWorkCursor(row.cursor)})}
  if(endpoint==='business-changes/get'){const row=taskInput(payload,['changeSetId']);readBusinessRecordReceipt({requestId:row.changeSetId});return services.changes.get(actor,{changeSetId:row.changeSetId as string})}
  if(endpoint==='business-changes/reject'){const row=taskInput(payload,['changeSetId','expectedRevision']);readBusinessChangeSetApply({...row,expectedDigest:'a'.repeat(64)});return services.changes.reject(actor,row as {changeSetId:string;expectedRevision:number})}
  const input=readBusinessChangeSetApply(payload),draft=await services.changes.get(actor,input)
  if(draft.digest!==input.expectedDigest||draft.revision!==input.expectedRevision||!['draft','awaiting-approval'].includes(draft.state))throw new WorkError('teloa/version-conflict','草稿已经改变，请重新审阅。')
  await authorizeSession(draft.scope,draft.sessionId,signal);signal.throwIfAborted()
  return {sessionId:draft.sessionId,text:'请采用我已审阅的这份本地业务修改。先读取并核对原草稿，只使用 teloa_business_change_apply 请求原生审批，不重建批次或改写其他记录。固定参数：'+JSON.stringify(input)}
 }
}
