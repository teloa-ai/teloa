import {isRecord,resourceId,resourceVersion,resourceScopes} from './resources.ts'
import {roleKnowledgeMaxReferences} from './roles.ts'

export type ResourceAdoptionInput={requestId:string;targetScope:string;resources:{id:string;version:number;sourceVersion:string}[]}
/** 本人明确指定原资料固定版本与一个目标业务；正文、来源、本人身份不由客户端提交。 */
export function isResourceAdoptionInput(value:unknown):value is ResourceAdoptionInput{
 if(!isRecord(value)||Object.keys(value).length!==3||!resourceId(value.requestId)||typeof value.targetScope!=='string'||value.targetScope==='general'||!resourceScopes([value.targetScope])||!Array.isArray(value.resources)||!value.resources.length||value.resources.length>roleKnowledgeMaxReferences)return false
 return value.resources.every(row=>isRecord(row)&&Object.keys(row).length===3&&resourceId(row.id)&&resourceVersion(row.version)&&typeof row.sourceVersion==='string'&&/^[a-f0-9]{64}$/.test(row.sourceVersion))&&new Set(value.resources.map(row=>row.id.toLowerCase())).size===value.resources.length
}
