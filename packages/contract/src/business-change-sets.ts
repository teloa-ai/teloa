import {WorkError,isRecord} from './index.ts'
import {readBusinessRecordBatch,readBusinessRecordReceipt,type BusinessRecordBatch,type BusinessRecordBatchResult} from './business-records.ts'
import type {BusinessObjectSnapshot} from './business-data.ts'
export type BusinessRecordBatchPreview={fingerprint:string;definitions:readonly {type:string;schemaFingerprint:string}[];targets:readonly BusinessObjectSnapshot[];operations:readonly {operation:string;type:string;title:string;before?:BusinessObjectSnapshot;fields?:readonly {name:string;label?:string;value:string}[];summary?:string}[]}
export type BusinessChangeSetPrepare=BusinessRecordBatch&{changeSetId?:string;expectedRevision?:number}
export type BusinessChangeSetApply={changeSetId:string;expectedRevision:number;expectedDigest:string}
export type BusinessChangeSet={schema:'teloa.business-change-set/v1';id:string;scope:string;revision:number;digest:string;state:'draft'|'awaiting-approval'|'applied'|'rejected'|'stale';sessionId:string;batch:BusinessRecordBatch;preview:BusinessRecordBatchPreview;createdAt:string;updatedAt:string;receipt?:BusinessRecordBatchResult}
export type BusinessRecordBatchDefinitionGuardSet={scope:string;guards:readonly {type:string;schemaFingerprint:string}[];previewFingerprint:string;receiptPolicy:'new-only'}
const bad=()=>new WorkError('teloa/invalid-input','业务修改草稿参数不正确。')
const revision=(v:unknown)=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
export function readBusinessChangeSetApply(value:unknown):BusinessChangeSetApply{
 if(!isRecord(value)||Object.keys(value).some(k=>!['changeSetId','expectedRevision','expectedDigest'].includes(k))||!revision(value.expectedRevision)||typeof value.expectedDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.expectedDigest))throw bad()
 const {requestId}=readBusinessRecordReceipt({requestId:value.changeSetId})
 return {changeSetId:requestId,expectedRevision:Number(value.expectedRevision),expectedDigest:value.expectedDigest}
}
export function readBusinessChangeSetPrepare(value:unknown):BusinessChangeSetPrepare{
 if(!isRecord(value)||Object.keys(value).some(k=>!['requestId','scope','operations','changeSetId','expectedRevision'].includes(k)))throw bad()
 const batch=readBusinessRecordBatch({requestId:value.requestId,scope:value.scope,operations:value.operations})
 if(new TextEncoder().encode(JSON.stringify(batch)).byteLength>131072)throw bad()
 if(value.changeSetId===undefined&&value.expectedRevision===undefined)return batch
 if(!revision(value.expectedRevision))throw bad()
 const {requestId}=readBusinessRecordReceipt({requestId:value.changeSetId})
 return {...batch,changeSetId:requestId,expectedRevision:Number(value.expectedRevision)}
}
