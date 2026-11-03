import {WorkError} from './work-error.ts'

export const roleMemoryStates=['candidate','confirmed','withdrawn'] as const
export type RoleMemoryState=typeof roleMemoryStates[number]
export const roleMemorySourceKinds=['task','run','artifact','knowledge','self-feedback','daily-digest','habit-digest'] as const
export type RoleMemorySourceKind=typeof roleMemorySourceKinds[number]
export type RoleMemorySource={kind:RoleMemorySourceKind;id:string;version:number}
export type RoleMemoryVisibility={kind:'role';scopeIds:string[]}|{kind:'private';scopeIds:[]}
export type RoleMemoryProposer={kind:'self'}|{kind:'role';roleId:string;roleVersion:number}
export type RoleMemoryPreferenceKind='preference'|'one-off'|'correction'|'counterexample'
export type RoleMemoryPreferenceReference={memoryId:string;version:number;contentHash:string}
/** 显式提议参数，与用户 Markdown 正文独立；分类不授予任何读取或执行权限。 */
export type RoleMemoryPreference={schema:'teloa.preference-candidate/v1';kind:RoleMemoryPreferenceKind;scope:string;taskId?:string;basis:{kind:'owner-input';quote:string}|{kind:'owner-confirmation'}|({kind:'habit-observation';quote:string;evidenceId:string}&RoleMemoryPreferenceReference)|{kind:'owner-revision';artifactId:string;version:number;quote:string};against?:RoleMemoryPreferenceReference}
export type RoleMemoryContent={version:number;contentHash:string;bytes:number;markdown:string;createdAt:string;editedBy?:'self'}
export type RoleMemory={
 id:string;ownerId:string;roleId:string;roleVersion:number;title:string;state:RoleMemoryState;stateVersion:number
 source:RoleMemorySource;sourceTitle:string;sourceAvailable:boolean;visibility:RoleMemoryVisibility;proposedBy:RoleMemoryProposer
 content:RoleMemoryContent;candidateAt:string;confirmedAt:string|null;withdrawnAt:string|null
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
/** 只生成比较键；原请求、来源快照与不可变回执保留原始编码。 */
export const roleMemoryIdentityKey=(value:string):string=>uuid(value)?value.toLowerCase():value
export const roleMemoryTitleKey=(value:string):string=>value.normalize('NFKC').trim().replace(/\s+/gu,' ').toLocaleLowerCase('en-US')
export const roleMemorySourceKey=(source:RoleMemorySource):string=>JSON.stringify([source.kind,roleMemoryIdentityKey(source.id),source.version])
export const roleMemoryProposerKey=(value:RoleMemoryProposer):string=>value.kind==='self'?'self':JSON.stringify([value.kind,roleMemoryIdentityKey(value.roleId),value.roleVersion])

const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const scope=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const date=new Date(value);return Number.isFinite(date.getTime())&&date.toISOString()===value}
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new WorkError('teloa/invalid-input','员工记忆请求格式不正确或包含未知字段。')
 return value as Record<string,unknown>
}

export function roleMemoryPreference(value:unknown):RoleMemoryPreference{
 const bad=()=>new WorkError('teloa/invalid-input','偏好提议类型、适用范围或固定依据不正确。')
 const r=exact(value,['schema','kind','scope','taskId','basis','against']),b=exact(r.basis,['kind','quote','memoryId','version','contentHash','evidenceId','artifactId'])
 if(r.schema!=='teloa.preference-candidate/v1'||!['preference','one-off','correction','counterexample'].includes(String(r.kind))||!scope(r.scope))throw bad()
 const temporary=r.kind==='one-off'||r.kind==='counterexample',related=r.kind==='correction'||r.kind==='counterexample'
 if(r.taskId!==undefined&&(!temporary||!uuid(r.taskId)))throw bad()
 if(related!==(r.against!==undefined))throw bad()
 let reference:RoleMemoryPreferenceReference|undefined
 if(r.against!==undefined){const a=exact(r.against,['memoryId','version','contentHash']);if(!uuid(a.memoryId)||!positive(a.version)||typeof a.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(a.contentHash))throw bad();reference={memoryId:a.memoryId.toLowerCase(),version:a.version,contentHash:a.contentHash}}
 if(b.kind==='owner-confirmation'){if(Object.keys(b).length!==1)throw bad()}
 else if(typeof b.quote!=='string'||!b.quote.trim()||b.quote.length>8000)throw bad()
 if(b.kind==='owner-input'){if(Object.keys(b).some(k=>!['kind','quote'].includes(k)))throw bad()}
 else if(b.kind==='habit-observation'){if(Object.keys(b).some(k=>!['kind','quote','memoryId','version','contentHash','evidenceId'].includes(k))||!uuid(b.memoryId)||!positive(b.version)||typeof b.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(b.contentHash)||!uuid(b.evidenceId))throw bad()}
 else if(b.kind==='owner-revision'){if(Object.keys(b).some(k=>!['kind','quote','artifactId','version'].includes(k))||!uuid(b.artifactId)||!positive(b.version)||b.version<2)throw bad()}
 else if(b.kind!=='owner-confirmation')throw bad()
 return {schema:r.schema,kind:r.kind as RoleMemoryPreferenceKind,scope:r.scope,...(r.taskId?{taskId:(r.taskId as string).toLowerCase()}:{}),basis:{...b} as RoleMemoryPreference['basis'],...(reference?{against:reference}:{})}
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
  else if(proposed.kind!=='role'||!uuid(proposed.roleId)||roleMemoryIdentityKey(proposed.roleId)!==roleMemoryIdentityKey(row.roleId)||!positive(proposed.roleVersion))return false
  const content=exact(row.content,['version','contentHash','bytes','markdown','createdAt','editedBy'])
  const candidateAt=row.candidateAt
  if(!positive(content.version)||typeof content.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(content.contentHash)||!positive(content.bytes)||content.bytes>128*1024||typeof content.markdown!=='string'||!content.markdown.trim()||new TextEncoder().encode(content.markdown).byteLength!==content.bytes||!stamp(content.createdAt)||!stamp(candidateAt)||content.createdAt<candidateAt)return false
  if(content.version===1?(content.createdAt!==candidateAt||Object.hasOwn(content,'editedBy')):content.editedBy!=='self')return false
  const confirmed=row.confirmedAt,withdrawn=row.withdrawnAt
  if(confirmed!==null&&!stamp(confirmed)||withdrawn!==null&&!stamp(withdrawn))return false
  if(row.state==='candidate'&&(row.stateVersion!==content.version||confirmed!==null||withdrawn!==null))return false
  if(row.state==='confirmed'&&(row.stateVersion!==content.version+1||confirmed===null||withdrawn!==null))return false
  if(row.state==='withdrawn'&&(withdrawn===null||row.stateVersion!==content.version+(confirmed===null?1:2)))return false
  return [confirmed,withdrawn].filter((item):item is string=>item!==null).every(item=>item>=candidateAt)
 }catch{return false}
}
