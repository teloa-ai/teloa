import {WorkError} from './work-error.ts'

export const roleMemoryStates=['candidate','confirmed','withdrawn'] as const
export type RoleMemoryState=typeof roleMemoryStates[number]
export const roleMemorySourceKinds=['task','run','artifact','knowledge','self-feedback','daily-digest','habit-digest'] as const
export type RoleMemorySourceKind=typeof roleMemorySourceKinds[number]
export type RoleMemorySource={kind:RoleMemorySourceKind;id:string;version:number}
export type RoleMemoryVisibility={kind:'role';scopeIds:string[]}|{kind:'private';scopeIds:[]}
export type RoleMemoryProposer={kind:'self'}|{kind:'role';roleId:string;roleVersion:number}
export type RoleMemoryContent={version:number;contentHash:string;bytes:number;markdown:string;createdAt:string}
export type RoleMemory={
 id:string;ownerId:string;roleId:string;roleVersion:number;title:string;state:RoleMemoryState;stateVersion:number
 source:RoleMemorySource;sourceTitle:string;sourceAvailable:boolean;visibility:RoleMemoryVisibility;proposedBy:RoleMemoryProposer
 content:RoleMemoryContent;candidateAt:string;confirmedAt:string|null;withdrawnAt:string|null
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const scope=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const date=new Date(value);return Number.isFinite(date.getTime())&&date.toISOString()===value}
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','员工记忆请求格式不正确或包含未知字段。')
 return value as Record<string,unknown>
}

export function roleMemorySource(value:unknown):RoleMemorySource{
 const row=exact(value,['kind','id','version'])
 // daily-digest / habit-digest 与 self-feedback 同口径：版本恒 1，来源对象是当天那份日志。
 const fixedVersion=['self-feedback','daily-digest','habit-digest'].includes(String(row.kind))
 if(!roleMemorySourceKinds.includes(row.kind as RoleMemorySourceKind)||!uuid(row.id)||!positive(row.version)||fixedVersion&&row.version!==1)throw new WorkError('teloa/invalid-input','员工记忆来源身份或版本不正确。')
 return {kind:row.kind as RoleMemorySourceKind,id:row.id,version:row.version}
}

export function roleMemoryVisibility(value:unknown):RoleMemoryVisibility{
 const row=exact(value,['kind','scopeIds'])
 if(!Array.isArray(row.scopeIds)||row.scopeIds.length>30||!row.scopeIds.every(scope)||new Set(row.scopeIds).size!==row.scopeIds.length)throw new WorkError('teloa/invalid-input','员工记忆可见范围不正确。')
 if(row.kind==='private'&&row.scopeIds.length===0)return {kind:'private',scopeIds:[]}
 if(row.kind==='role'&&row.scopeIds.length>0)return {kind:'role',scopeIds:[...row.scopeIds]}
 throw new WorkError('teloa/invalid-input','员工记忆可见范围不正确。')
}

export function isRoleMemory(value:unknown):value is RoleMemory{
 try{
  const row=exact(value,['id','ownerId','roleId','roleVersion','title','state','stateVersion','source','sourceTitle','sourceAvailable','visibility','proposedBy','content','candidateAt','confirmedAt','withdrawnAt'])
  if(!uuid(row.id)||typeof row.ownerId!=='string'||!row.ownerId.trim()||row.ownerId.length>128||!uuid(row.roleId)||!positive(row.roleVersion)||typeof row.title!=='string'||!row.title.trim()||row.title.length>120||!roleMemoryStates.includes(row.state as RoleMemoryState)||!positive(row.stateVersion)||typeof row.sourceTitle!=='string'||!row.sourceTitle.trim()||row.sourceTitle.length>200||typeof row.sourceAvailable!=='boolean')return false
  roleMemorySource(row.source);roleMemoryVisibility(row.visibility)
  const proposed=exact(row.proposedBy,['kind','roleId','roleVersion'])
  if(proposed.kind==='self'){if(Object.keys(proposed).length!==1)return false}
  else if(proposed.kind!=='role'||!uuid(proposed.roleId)||proposed.roleId!==row.roleId||!positive(proposed.roleVersion))return false
  const content=exact(row.content,['version','contentHash','bytes','markdown','createdAt'])
  const candidateAt=row.candidateAt
  if(!positive(content.version)||typeof content.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(content.contentHash)||!positive(content.bytes)||content.bytes>128*1024||typeof content.markdown!=='string'||!content.markdown.trim()||new TextEncoder().encode(content.markdown).byteLength!==content.bytes||!stamp(content.createdAt)||!stamp(candidateAt)||content.createdAt!==candidateAt)return false
  const confirmed=row.confirmedAt,withdrawn=row.withdrawnAt
  if(confirmed!==null&&!stamp(confirmed)||withdrawn!==null&&!stamp(withdrawn))return false
  if(row.state==='candidate'&&(row.stateVersion!==1||confirmed!==null||withdrawn!==null))return false
  if(row.state==='confirmed'&&(row.stateVersion!==2||confirmed===null||withdrawn!==null))return false
  if(row.state==='withdrawn'&&(withdrawn===null||row.stateVersion!==(confirmed===null?2:3)))return false
  return [confirmed,withdrawn].filter((item):item is string=>item!==null).every(item=>item>=candidateAt)
 }catch{return false}
}
