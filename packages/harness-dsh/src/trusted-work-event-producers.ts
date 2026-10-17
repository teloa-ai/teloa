import type {WorkEventService} from '@teloa/backend'
import type {BusinessWorkSourceRef} from '@teloa/contract'
type PoolClient=Parameters<WorkEventService['appendSource']>[0]
/** 本机服务回调只传持久原件身份；owner、正文版本和执行世代由服务重新派生。 */
export function trustedWorkEventProducers(service:WorkEventService){return {
 businessObject:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-object'}>,version:string,origin?:{sessionId:string;messageId:string;seq:number})=>service.appendBusinessSource(db,owner,source,version,origin),
 businessSync:(db:PoolClient,owner:string,source:Extract<BusinessWorkSourceRef,{kind:'business-sync'}>,version:string)=>service.appendBusinessSource(db,owner,source,version),
 material:(db:PoolClient,resourceId:string)=>service.appendSource(db,{kind:'material-version',sourceId:resourceId}),
 groupMessage:(db:PoolClient,groupId:string,messageId:string)=>service.appendSource(db,{kind:'group-message',sourceId:groupId,receiptId:messageId}),
 childCompleted:(db:PoolClient,parentRunId:string,reservationId:string)=>service.appendSource(db,{kind:'child-completed',sourceId:parentRunId,receiptId:reservationId}),
 approvalResult:(db:PoolClient,actionId:string,approvalId:string)=>service.appendSource(db,{kind:'approval-result',sourceId:actionId,receiptId:approvalId}),
}}
