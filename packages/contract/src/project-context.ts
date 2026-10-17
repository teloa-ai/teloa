import {WorkError} from './index.ts'
import {projectInput,projectUuid} from './projects.ts'

export type ProjectContextChange=
 |{kind:'save-brief';brief:string}
 |{kind:'save-entry';entryId:string|null;entryKind:'rule'|'memory';topic:string;markdown:string}
 |{kind:'withdraw-entry';entryId:string}
 |{kind:'share';entryId:string;entryVersion:number;targetProjectId:string}
 |{kind:'revoke-share';shareId:string}
 |{kind:'update-share';shareId:string;entryVersion:number}
export type ProjectContextMutation={projectId:string;requestId:string;expectedVersion:number;change:ProjectContextChange}
export type ProjectContextReceipt={projectId:string;requestId:string;version:number}
export type ProjectContextEntry={id:string;kind:'rule'|'memory';topic:string;version:number;state:'active'|'withdrawn';markdown:string|null;hash:string|null}
export type ProjectContextShare={id:string;sourceProjectId:string;targetProjectId:string;sourceTitle:string|null;targetTitle:string|null;entryId:string;entryVersion:number;currentVersion?:number;topic:string|null;markdown:string|null;hash:string|null;status:'active'|'revoked'|'withdrawn'|'unavailable'}
export type ProjectContextDetail={projectId:string;version:number;brief:string;entries:ProjectContextEntry[];shares:ProjectContextShare[]}
const invalid=()=>new WorkError('teloa/invalid-input','项目上下文内容或字段格式不正确。')
function uuid(value:unknown){if(!projectUuid(value))throw invalid();return value.toLowerCase()}
function version(value:unknown,min=0){if(!Number.isSafeInteger(value)||Number(value)<min)throw invalid();return Number(value)}
function text(value:unknown,max:number,empty=false){if(typeof value!=='string'||value.length>max||(!empty&&!value.trim())||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw invalid();return value.trim()}
export function projectContextRead(value:unknown){const row=projectInput(value,['projectId']);return {projectId:uuid(row.projectId)}}
export function projectContextMutation(value:unknown):ProjectContextMutation{
 const row=projectInput(value,['projectId','requestId','expectedVersion','change']),base={projectId:uuid(row.projectId),requestId:uuid(row.requestId),expectedVersion:version(row.expectedVersion)}
 const raw=projectInput(row.change,['kind','brief','entryId','entryKind','topic','markdown','entryVersion','targetProjectId','shareId'])
 switch(raw.kind){
  case 'save-brief':{const c=projectInput(raw,['kind','brief']);return {...base,change:{kind:raw.kind,brief:text(c.brief,16000,true)}}}
  case 'save-entry':{const c=projectInput(raw,['kind','entryId','entryKind','topic','markdown']);if(c.entryKind!=='rule'&&c.entryKind!=='memory')throw invalid();return {...base,change:{kind:raw.kind,entryId:c.entryId===null?null:uuid(c.entryId),entryKind:c.entryKind,topic:text(c.topic,120),markdown:text(c.markdown,16000)}}}
  case 'withdraw-entry':{const c=projectInput(raw,['kind','entryId']);return {...base,change:{kind:raw.kind,entryId:uuid(c.entryId)}}}
  case 'share':{const c=projectInput(raw,['kind','entryId','entryVersion','targetProjectId']);const targetProjectId=uuid(c.targetProjectId);if(targetProjectId===base.projectId)throw invalid();return {...base,change:{kind:raw.kind,entryId:uuid(c.entryId),entryVersion:version(c.entryVersion,1),targetProjectId}}}
  case 'revoke-share':{const c=projectInput(raw,['kind','shareId']);return {...base,change:{kind:raw.kind,shareId:uuid(c.shareId)}}}
  case 'update-share':{const c=projectInput(raw,['kind','shareId','entryVersion']);return {...base,change:{kind:raw.kind,shareId:uuid(c.shareId),entryVersion:version(c.entryVersion,1)}}}
  default:throw invalid()
 }
}
function hash(value:unknown){if(typeof value!=='string'||! /^[a-f0-9]{64}$/.test(value))throw invalid();return value}
export function readProjectContext(value:unknown):ProjectContextDetail{
 const row=projectInput(value,['projectId','version','brief','entries','shares'])
 if(!Array.isArray(row.entries)||row.entries.length>200||!Array.isArray(row.shares)||row.shares.length>1000)throw invalid()
 const entries:ProjectContextEntry[]=row.entries.map(value=>{
  const r=projectInput(value,['id','kind','topic','version','state','markdown','hash'])
  if((r.kind!=='rule'&&r.kind!=='memory')||(r.state!=='active'&&r.state!=='withdrawn'))throw invalid()
  if(r.state==='withdrawn'&&(r.markdown!==null||r.hash!==null))throw invalid()
  return {id:uuid(r.id),kind:r.kind,topic:text(r.topic,120),version:version(r.version,1),state:r.state,markdown:r.state==='active'?text(r.markdown,16000):null,hash:r.state==='active'?hash(r.hash):null}
 })
 const shares:ProjectContextShare[]=row.shares.map(value=>{
  const r=projectInput(value,['id','sourceProjectId','targetProjectId','sourceTitle','targetTitle','entryId','entryVersion','currentVersion','topic','markdown','hash','status'])
  if(!['active','revoked','withdrawn','unavailable'].includes(String(r.status)))throw invalid()
  if(r.status!=='active'&&(r.markdown!==null||r.hash!==null||r.topic!==null))throw invalid()
  const status=r.status as ProjectContextShare['status']
  return {id:uuid(r.id),sourceProjectId:uuid(r.sourceProjectId),targetProjectId:uuid(r.targetProjectId),sourceTitle:r.sourceTitle===null?null:text(r.sourceTitle,120),targetTitle:r.targetTitle===null?null:text(r.targetTitle,120),entryId:uuid(r.entryId),entryVersion:version(r.entryVersion,1),...(r.currentVersion!==undefined?{currentVersion:version(r.currentVersion,1)}:{}),topic:status==='active'?text(r.topic,120):null,markdown:status==='active'?text(r.markdown,16000):null,hash:status==='active'?hash(r.hash):null,status}
 })
 const projectId=uuid(row.projectId)
 if(new Set(entries.map(e=>e.id)).size!==entries.length||new Set(shares.map(e=>e.id)).size!==shares.length||shares.some(s=>s.sourceProjectId!==projectId&&s.targetProjectId!==projectId))throw invalid()
 return {projectId,version:version(row.version),brief:text(row.brief,16000,true),entries,shares}
}
export function readProjectContextReceipt(value:unknown):ProjectContextReceipt{const row=projectInput(value,['projectId','requestId','version']);return {projectId:uuid(row.projectId),requestId:uuid(row.requestId),version:version(row.version,1)}}
