import {isRecord,isWorkResource,resourceId,resourceVersion,type WorkResource} from './resources.ts'

export type EmployeeKnowledgeIndexState='not-enrolled'|'pending'|'ready'|'failed'
export type EmployeeKnowledgeOrigin={resourceId:string;sourceId:string;sourceVersion:string}
/** resourceId 始终指员工原知识引用；内容修订不改变员工的授权版本。 */
export type EmployeeKnowledgeDocument={
 roleId:string;resourceId:string;documentId:string;knowledgeId:string|null;title:string;bodyVersion:number;contentHash:string;bytes:number
 resource:WorkResource;origin:EmployeeKnowledgeOrigin;editing:'fork-on-write'|'employee-copy';indexState:EmployeeKnowledgeIndexState
}
export type EmployeeKnowledgeContent=EmployeeKnowledgeDocument&{markdown:string}
export type EmployeeKnowledgeVersion={version:number;contentHash:string;bytes:number;createdAt:string;resourceId:string}
export type EmployeeKnowledgeTarget={roleId:string;resourceId:string}
export type EmployeeKnowledgeReviseInput=EmployeeKnowledgeTarget&{requestId:string;expectedBodyVersion:number;expectedContentHash:string;markdown:string}
export type EmployeeKnowledgeRestoreInput=EmployeeKnowledgeTarget&{requestId:string;expectedBodyVersion:number;expectedContentHash:string;restoreVersion:number}
export type EmployeeKnowledgeRevision={requestId:string;operation:'revise'|'restore';forked:boolean;document:EmployeeKnowledgeContent}
export type EmployeeKnowledgeImportResetDocument={roleId:string;resourceId:string;knowledgeId:string;bodyVersion:number;contentHash:string;title:string}
export type EmployeeKnowledgeImportResetPreview={digest:string;documents:EmployeeKnowledgeImportResetDocument[]}

const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const bytes=(value:unknown)=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2*1024*1024
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
const documentKeys=['roleId','resourceId','documentId','knowledgeId','title','bodyVersion','contentHash','bytes','resource','origin','editing','indexState']
export function isEmployeeKnowledgeDocument(value:unknown):value is EmployeeKnowledgeDocument{
 if(!isRecord(value)||!resourceId(value.roleId)||!resourceId(value.resourceId)||typeof value.documentId!=='string'||!value.documentId||value.documentId.length>128||(value.knowledgeId!==null&&!resourceId(value.knowledgeId))||typeof value.title!=='string'||!value.title.trim()||value.title.length>200||!resourceVersion(value.bodyVersion)||!hash(value.contentHash)||!bytes(value.bytes)||!isWorkResource(value.resource)||!isRecord(value.origin)||!exact(value.origin,['resourceId','sourceId','sourceVersion'])||!resourceId(value.origin.resourceId)||typeof value.origin.sourceId!=='string'||!hash(value.origin.sourceVersion)||!['fork-on-write','employee-copy'].includes(String(value.editing))||!['not-enrolled','pending','ready','failed'].includes(String(value.indexState)))return false
 const managedCopy=value.knowledgeId!==null&&value.resource.sourceId==='knowledge_'+value.knowledgeId.toLowerCase()
 // 首次 COW 的 v1 可复用固定原资源；仅这一版允许原来源，来源身份和摘要必须同时匹配。
 const originalBaseline=value.bodyVersion===1&&value.resource.sourceId===value.origin.sourceId&&value.resource.sourceVersion===value.origin.sourceVersion
 return value.origin.resourceId===value.resourceId&&value.resource.title===value.title&&value.resource.sourceVersion===value.contentHash&&(value.editing==='employee-copy'?value.knowledgeId!==null&&(managedCopy||originalBaseline):value.knowledgeId===null&&value.resource.sourceId===value.origin.sourceId)
}
export function isEmployeeKnowledgeContent(value:unknown):value is EmployeeKnowledgeContent{
 if(!isRecord(value))return false
 const markdown=value.markdown
 return exact(value,[...documentKeys,'markdown'])&&isEmployeeKnowledgeDocument(value)&&typeof markdown==='string'&&new TextEncoder().encode(markdown).byteLength===value.bytes
}
export function isEmployeeKnowledgeVersion(value:unknown):value is EmployeeKnowledgeVersion{
 return isRecord(value)&&exact(value,['version','contentHash','bytes','createdAt','resourceId'])&&resourceVersion(value.version)&&hash(value.contentHash)&&bytes(value.bytes)&&typeof value.createdAt==='string'&&Number.isFinite(Date.parse(value.createdAt))&&resourceId(value.resourceId)
}
export function isEmployeeKnowledgeRevision(value:unknown):value is EmployeeKnowledgeRevision{
 return isRecord(value)&&exact(value,['requestId','operation','forked','document'])&&resourceId(value.requestId)&&['revise','restore'].includes(String(value.operation))&&typeof value.forked==='boolean'&&isEmployeeKnowledgeContent(value.document)
}
