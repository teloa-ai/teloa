import {WorkError,taskInput,readBusinessRecordReceipt} from './index.ts'
export type BusinessWorkPage<T,C>={items:T[];nextCursor?:C}
export type BusinessWorkCursor={at:string;id:string}
export type BusinessResultCursor={slot:string;revision:number}
export function readBusinessWorkCursor(value:unknown):BusinessWorkCursor|undefined{
 if(value===undefined)return undefined
 const row=taskInput(value,['at','id']);readBusinessRecordReceipt({requestId:row.id})
 if(typeof row.at!=='string'||!Number.isFinite(Date.parse(row.at))||new Date(row.at).toISOString()!==row.at)throw new WorkError('teloa/invalid-input','工作列表游标无效。')
 return row as BusinessWorkCursor
}
export function readBusinessResultCursor(value:unknown):BusinessResultCursor|undefined{
 if(value===undefined)return undefined
 const row=taskInput(value,['slot','revision'])
 if(typeof row.slot!=='string'||row.slot.length<1||row.slot.length>160||!Number.isSafeInteger(row.revision)||Number(row.revision)<1)throw new WorkError('teloa/invalid-input','成果列表游标无效。')
 return row as BusinessResultCursor
}
