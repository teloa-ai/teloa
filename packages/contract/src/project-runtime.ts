import {WorkError} from './work-error.ts'
import {projectInput,projectUuid} from './projects.ts'

export type ProjectMemoryMode='enabled'|'off'
export type ProjectAutomaticMemory='decisions'|'verified'|'paused'
export type ProjectRuntimeResource={resourceId:string;required:boolean}
export type ProjectRuntimeSettings={projectId:string;version:number;automatic:ProjectAutomaticMemory;readPersonal:boolean;resources:ProjectRuntimeResource[]}
export type ProjectConversationMembership={sessionId:string;projectId:string|null;version:number;memoryMode:ProjectMemoryMode;generation:number;title:string}
export type ProjectContextUseSource={kind:'project'|'brief'|'rule'|'memory'|'share'|'resource'|'personal'|'role';id:string;version:number;hash:string;title:string}
export type ProjectContextUseManifest={id:string;sessionId:string;messageId:string;projectId:string;bindingVersion:number;generation:number;memoryMode:ProjectMemoryMode;createdAt:string;sources:ProjectContextUseSource[];omitted:Array<{reason:string}>}
export type ProjectRuntimeSettingsMutation=Omit<ProjectRuntimeSettings,'version'>&{requestId:string;expectedVersion:number}
export type ProjectMembershipMutation={requestId:string;sessionId:string;projectId:string|null;expectedVersion:number;memoryMode:ProjectMemoryMode}
const invalid=()=>new WorkError('teloa/invalid-input','项目运行设置或会话归属格式不正确。')
export function projectRuntimeUuid(value:unknown){if(!projectUuid(value))throw invalid();return value.toLowerCase()}
export function projectRuntimeVersion(value:unknown,min=0){if(!Number.isSafeInteger(value)||Number(value)<min)throw invalid();return Number(value)}
export function projectRuntimeSession(value:unknown){if(typeof value!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw invalid();return value}
export function projectRuntimeText(value:unknown,max=16000){if(typeof value!=='string'||value.length>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value))throw invalid();return value}
function mode(value:unknown):ProjectMemoryMode{if(value!=='enabled'&&value!=='off')throw invalid();return value}
function automatic(value:unknown):ProjectAutomaticMemory{if(value!=='decisions'&&value!=='verified'&&value!=='paused')throw invalid();return value}
function boolean(value:unknown){if(typeof value!=='boolean')throw invalid();return value}
function resources(value:unknown):ProjectRuntimeResource[]{
 if(!Array.isArray(value)||value.length>100)throw invalid()
 const rows=value.map(v=>{const row=projectInput(v,['resourceId','required']);return {resourceId:projectRuntimeUuid(row.resourceId),required:boolean(row.required)}})
 if(new Set(rows.map(r=>r.resourceId)).size!==rows.length)throw invalid()
 return rows
}
export function projectRuntimeSettingsInput(value:unknown):ProjectRuntimeSettingsMutation{
 const r=projectInput(value,['projectId','requestId','expectedVersion','automatic','readPersonal','resources'])
 return {projectId:projectRuntimeUuid(r.projectId),requestId:projectRuntimeUuid(r.requestId),expectedVersion:projectRuntimeVersion(r.expectedVersion),automatic:automatic(r.automatic),readPersonal:boolean(r.readPersonal),resources:resources(r.resources)}
}
export function readProjectRuntimeSettings(value:unknown):ProjectRuntimeSettings{
 const r=projectInput(value,['projectId','version','automatic','readPersonal','resources'])
 return {projectId:projectRuntimeUuid(r.projectId),version:projectRuntimeVersion(r.version),automatic:automatic(r.automatic),readPersonal:boolean(r.readPersonal),resources:resources(r.resources)}
}
export function projectMembershipInput(value:unknown):ProjectMembershipMutation{
 const r=projectInput(value,['requestId','sessionId','projectId','expectedVersion','memoryMode'])
 return {requestId:projectRuntimeUuid(r.requestId),sessionId:projectRuntimeSession(r.sessionId),projectId:r.projectId===null?null:projectRuntimeUuid(r.projectId),expectedVersion:projectRuntimeVersion(r.expectedVersion),memoryMode:mode(r.memoryMode)}
}
export function readProjectMembership(value:unknown):ProjectConversationMembership{
 const r=projectInput(value,['sessionId','projectId','version','memoryMode','generation','title'])
 return {sessionId:projectRuntimeSession(r.sessionId),projectId:r.projectId===null?null:projectRuntimeUuid(r.projectId),version:projectRuntimeVersion(r.version),memoryMode:mode(r.memoryMode),generation:projectRuntimeVersion(r.generation,1),title:projectRuntimeText(r.title,240)}
}
export function readContextUseManifest(value:unknown):ProjectContextUseManifest{
 const r=projectInput(value,['id','sessionId','messageId','projectId','bindingVersion','generation','memoryMode','createdAt','sources','omitted'])
 if(!Array.isArray(r.sources)||r.sources.length>500||!Array.isArray(r.omitted)||r.omitted.length>500||typeof r.createdAt!=='string'||!Number.isFinite(Date.parse(r.createdAt)))throw invalid()
 const sources=r.sources.map(v=>{const s=projectInput(v,['kind','id','version','hash','title']);if(!['project','brief','rule','memory','share','resource','personal','role'].includes(String(s.kind))||typeof s.hash!=='string'||!/^[a-f0-9]{64}$/.test(s.hash))throw invalid();return {kind:s.kind as ProjectContextUseSource['kind'],id:projectRuntimeText(s.id,128),version:projectRuntimeVersion(s.version),hash:s.hash,title:projectRuntimeText(s.title,240)}})
 return {id:projectRuntimeUuid(r.id),sessionId:projectRuntimeSession(r.sessionId),messageId:projectRuntimeText(r.messageId,128),projectId:projectRuntimeUuid(r.projectId),bindingVersion:projectRuntimeVersion(r.bindingVersion),generation:projectRuntimeVersion(r.generation,1),memoryMode:mode(r.memoryMode),createdAt:r.createdAt,sources,omitted:r.omitted.map(v=>{const o=projectInput(v,['reason']);return {reason:projectRuntimeText(o.reason,240)}})}
}
