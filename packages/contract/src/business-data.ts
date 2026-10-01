import {WorkError,isRecord} from './index.ts'

export type BusinessObjectReference={
 scope:string
 type:string
 id:string
 version:number
 snapshotHash:string
}

export type BusinessObjectSnapshot=BusinessObjectReference&{
 title:string
 source:string
 observedAt:string
 receivedAt:string
 quality:'complete'|'missing'
 summary:string
 fields:Array<{label:string;value:string}>
 /** 仅 tombstone 版本带：源侧删除时刻（ISO）；fields 沿用上一版本。旧快照没有这个键。 */
 deletedAt?:string
}

export type BusinessDataPage={
 schema:'teloa.business-data-page/v1'
 sourceId:string
 capturedAt:string
 items:BusinessObjectSnapshot[]
 nextCursor?:string
}

const safeId=/^[\p{L}\p{N}][\p{L}\p{N}._:@/+ -]{0,199}$/u
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)

export function businessObjectReference(input:unknown):BusinessObjectReference{
 if(!isRecord(input)||Object.keys(input).some(key=>!['scope','type','id','version','snapshotHash'].includes(key)))throw new WorkError('teloa/invalid-input','业务对象引用格式不正确。')
 if(!text(input.scope,120)||input.scope==='general'||!/^[a-zA-Z0-9_-]+$/.test(input.scope)||!text(input.type,80)||typeof input.id!=='string'||!safeId.test(input.id)||!Number.isSafeInteger(input.version)||Number(input.version)<1||Number(input.version)>2147483647||typeof input.snapshotHash!=='string'||!/^[a-f0-9]{64}$/.test(input.snapshotHash))throw new WorkError('teloa/invalid-input','业务对象引用的范围、身份、版本或摘要不正确。')
 return {scope:input.scope,type:input.type,id:input.id as string,version:input.version as number,snapshotHash:input.snapshotHash}
}

const businessRecordMarker='[[teloa-business-record:'
const invalidBusinessRecordMarker=()=>new WorkError('teloa/invalid-reference','业务记录引用损坏，请从记录页重新选择。')

/** 原生输入引用仅携带固定身份；对象权限与历史快照仍须在执行端重新核验。 */
export function encodeBusinessRecordReference(input:BusinessObjectReference):string{
 const ref=businessObjectReference(input)
 return businessRecordMarker+[ref.scope,encodeURIComponent(ref.type),encodeURIComponent(ref.id),ref.version,ref.snapshotHash].join('|')+']]'
}

export function parseBusinessRecordReferences(text:string):BusinessObjectReference[]{
 if(typeof text!=='string')throw invalidBusinessRecordMarker()
 const segments=text.split(businessRecordMarker).slice(1)
 if(segments.length>1)throw invalidBusinessRecordMarker()
 if(!segments.length)return []
 const segment=segments[0]!,end=segment.indexOf(']]')
 if(end<0||end>4096)throw invalidBusinessRecordMarker()
 const token=businessRecordMarker+segment.slice(0,end)+']]',parts=segment.slice(0,end).split('|')
 if(parts.length!==5||!/^\d+$/.test(parts[3]!))throw invalidBusinessRecordMarker()
 try{
  const ref=businessObjectReference({scope:parts[0],type:decodeURIComponent(parts[1]!),id:decodeURIComponent(parts[2]!),version:Number(parts[3]),snapshotHash:parts[4]})
  if(encodeBusinessRecordReference(ref)!==token)throw invalidBusinessRecordMarker()
  return [ref]
 }catch{throw invalidBusinessRecordMarker()}
}
