import {WorkError,isBusinessScopeKey,readBusinessReassignmentSelection,readBusinessReassignmentReceipt,type BusinessReassignmentReceipt} from '@teloa/contract'
import {readHomeWorkStatus,type HomeWorkStatusCall} from './home-work-status.ts'
export type BusinessReassignmentOriginal={oldRequestId:string;oldSessionId:string;scope:string;title:string;oldRoleId:string;stopSubmitted:boolean}
export type BusinessReassignmentReceiptIdentity=Pick<BusinessReassignmentReceipt,'oldRequestId'|'newRequestId'|'oldSessionId'|'newSessionId'|'scope'|'snapshotHash'>
const invalid=()=>new WorkError('teloa/invalid-host-response','改派定位或回执与当前业务、会话及固定请求不一致。')
/** 只沿原 work-requests/list 的单会话授权；跨 daily 仅转交已选 oldRequestId。 */
export function createBusinessReassignmentApi(call:HomeWorkStatusCall,scope:string){
 if(!isBusinessScopeKey(scope)||scope==='general')throw invalid()
 return {async listOriginalRequests(sessionId:string,signal?:AbortSignal):Promise<BusinessReassignmentOriginal[]>{
  if(!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))throw invalid()
  const response=await call('work-requests/list',{sessionId},signal)
  if(!Array.isArray(response))throw invalid()
  const seen=new Set<string>(),items:BusinessReassignmentOriginal[]=[]
  for(const value of response){
   const row=readHomeWorkStatus(value,sessionId)
   if(row.scope!==scope||row.members.some(member=>member.scope!==scope))throw invalid()
   if(!value||typeof value!=='object'||!Object.hasOwn(value,'kind'))throw invalid()
   const kind=(value as {kind:unknown}).kind
   if(kind!=='task'&&kind!=='report')throw invalid()
   if(kind!=='task'||row.members.length!==1)continue
   const member=row.members[0]!,identity=readBusinessReassignmentSelection({oldRequestId:row.requestId,newRoleId:member.roleId,expectedNewRoleVersion:1})
   if(seen.has(identity.oldRequestId)||!row.title.trim()||row.title.length>120||row.stoppedAt!==null&&(!Number.isFinite(Date.parse(row.stoppedAt))||new Date(row.stoppedAt).toISOString()!==row.stoppedAt))throw invalid()
   seen.add(identity.oldRequestId)
   items.push({oldRequestId:identity.oldRequestId,oldSessionId:sessionId,scope,title:row.title,oldRoleId:identity.newRoleId,stopSubmitted:row.stoppedAt!==null})
  }
  return items
 }}
}
export type BusinessReassignmentApi=ReturnType<typeof createBusinessReassignmentApi>
/** 已建立只认本次原生操作的完整固定回执，旧停止时间不构成成功。 */
export function verifyBusinessReassignmentReceipt(value:unknown,expected:BusinessReassignmentReceiptIdentity):BusinessReassignmentReceipt{
 const receipt=readBusinessReassignmentReceipt(value)
 if(['oldRequestId','newRequestId','oldSessionId','newSessionId','scope','snapshotHash'].some(key=>receipt[key as keyof BusinessReassignmentReceiptIdentity]!==expected[key as keyof BusinessReassignmentReceiptIdentity]))throw invalid()
 return receipt
}
