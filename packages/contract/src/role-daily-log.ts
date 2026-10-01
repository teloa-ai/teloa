import {WorkError} from './work-error.ts'

export const roleDailyLogKinds=['daily-digest','habit-digest'] as const
export type RoleDailyLogKind=typeof roleDailyLogKinds[number]
export const roleDailyLogStates=['kept','discarded'] as const
export type RoleDailyLogState=typeof roleDailyLogStates[number]
export const roleDailyLogEvidenceKinds=['run','artifact','approval','revision','group-message'] as const
export type RoleDailyLogEvidenceKind=typeof roleDailyLogEvidenceKinds[number]
export type RoleDailyLogEvidence={kind:RoleDailyLogEvidenceKind;id:string;version:number;title:string}
export type RoleDailyLogPruneHint={memoryId:string;memoryStateVersion:number;reason:string}
export type RoleDailyLog={
 id:string;ownerId:string;roleId:string;roleVersion:number;kind:RoleDailyLogKind;day:string
 state:RoleDailyLogState;runId:string|null;title:string;markdown:string
 scopeIds:string[];evidence:RoleDailyLogEvidence[];pruneHints:RoleDailyLogPruneHint[]
 createdAt:string;discardedAt:string|null
}
export type RoleDailyLogSummary=Pick<RoleDailyLog,'id'|'kind'|'day'|'state'|'title'|'createdAt'>
export type RoleDailyLogListInput={roleId:string}
export type RoleDailyLogGetInput={roleId:string;logId:string}
export type RoleDailyLogDiscardInput={requestId:string;logId:string;expectedState:'kept'}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const scope=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const day=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&new Date(value+'T00:00:00.000Z').toISOString().slice(0,10)===value
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const date=new Date(value);return Number.isFinite(date.getTime())&&date.toISOString()===value}
const fail=():never=>{throw new WorkError('teloa/invalid-input','每日日志请求包含未知字段或格式不正确。')}
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))fail()
 return value as Record<string,unknown>
}
const text=(value:unknown,max:number):string=>{if(typeof value!=='string'||!value.trim()||value.length>max)fail();return (value as string).trim()}

export function roleDailyLogEvidence(value:unknown):RoleDailyLogEvidence{
 const row=exact(value,['kind','id','version','title'])
 if(!roleDailyLogEvidenceKinds.includes(row.kind as RoleDailyLogEvidenceKind)||typeof row.id!=='string'||!row.id.trim()||row.id.length>128||!positive(row.version))fail()
 return {kind:row.kind as RoleDailyLogEvidenceKind,id:row.id as string,version:row.version as number,title:text(row.title,200)}
}

export function roleDailyLogPruneHint(value:unknown):RoleDailyLogPruneHint{
 const row=exact(value,['memoryId','memoryStateVersion','reason'])
 if(!uuid(row.memoryId)||!positive(row.memoryStateVersion))fail()
 return {memoryId:row.memoryId as string,memoryStateVersion:row.memoryStateVersion as number,reason:text(row.reason,2000)}
}

/** 15 键；`day` 为 `YYYY-MM-DD`；`markdown` 上限 16000 字节；证据 60 条按 `kind+id` 去重；建议 3 条；范围 30 条去重升序。 */
export function isRoleDailyLog(value:unknown):value is RoleDailyLog{
 try{
  const row=exact(value,['id','ownerId','roleId','roleVersion','kind','day','state','runId','title','markdown','scopeIds','evidence','pruneHints','createdAt','discardedAt'])
  if(!uuid(row.id)||typeof row.ownerId!=='string'||!row.ownerId.trim()||row.ownerId.length>128||!uuid(row.roleId)||!positive(row.roleVersion))return false
  if(!roleDailyLogKinds.includes(row.kind as RoleDailyLogKind)||!day(row.day)||!roleDailyLogStates.includes(row.state as RoleDailyLogState))return false
  if(row.kind==='habit-digest'?row.runId!==null:!uuid(row.runId))return false
  if(typeof row.title!=='string'||!row.title.trim()||row.title.length>120)return false
  if(typeof row.markdown!=='string'||!row.markdown.trim()||new TextEncoder().encode(row.markdown).byteLength>16000)return false
  if(!Array.isArray(row.scopeIds)||row.scopeIds.length>30||!row.scopeIds.every(scope)||new Set(row.scopeIds).size!==row.scopeIds.length||JSON.stringify(row.scopeIds)!==JSON.stringify([...row.scopeIds].sort()))return false
  if(!Array.isArray(row.evidence)||row.evidence.length>60)return false
  const evidence=row.evidence.map(roleDailyLogEvidence)
  if(new Set(evidence.map(item=>item.kind+'\0'+item.id)).size!==evidence.length)return false
  if(!Array.isArray(row.pruneHints)||row.pruneHints.length>3)return false
  const hints=row.pruneHints.map(roleDailyLogPruneHint)
  if(new Set(hints.map(item=>item.memoryId)).size!==hints.length)return false
  if(!stamp(row.createdAt))return false
  if(row.state==='discarded'?!stamp(row.discardedAt)||String(row.discardedAt)<String(row.createdAt):row.discardedAt!==null)return false
  return true
 }catch{return false}
}

export function isRoleDailyLogSummary(value:unknown):value is RoleDailyLogSummary{
 const row=value as Record<string,unknown>
 return !!row&&typeof row==='object'&&!Array.isArray(row)&&Object.keys(row).length===6&&uuid(row.id)&&roleDailyLogKinds.includes(row.kind as RoleDailyLogKind)&&day(row.day)&&roleDailyLogStates.includes(row.state as RoleDailyLogState)&&typeof row.title==='string'&&!!row.title.trim()&&row.title.length<=120&&stamp(row.createdAt)
}

export function roleDailyLogListInput(value:unknown):RoleDailyLogListInput{
 const row=exact(value,['roleId']);if(!uuid(row.roleId))fail()
 return {roleId:row.roleId as string}
}
export function roleDailyLogGetInput(value:unknown):RoleDailyLogGetInput{
 const row=exact(value,['roleId','logId']);if(!uuid(row.roleId)||!uuid(row.logId))fail()
 return {roleId:row.roleId as string,logId:row.logId as string}
}
export function roleDailyLogDiscardInput(value:unknown):RoleDailyLogDiscardInput{
 const row=exact(value,['requestId','logId','expectedState'])
 if(!uuid(row.requestId)||!uuid(row.logId)||row.expectedState!=='kept')fail()
 return {requestId:row.requestId as string,logId:row.logId as string,expectedState:'kept'}
}
