import {isRecord,isWorkResource,resourceId,resourceScopes,resourceVersion,type WorkResource} from './resources.ts'
import {isPasteKnowledge,type PasteKnowledge} from './knowledge.ts'
import type {KnowledgeCopyRef,KnowledgeCopyInput} from './knowledge-copy.ts'
export type LocalKnowledgeCopyRef=KnowledgeCopyRef
export type LocalKnowledgeCopyInput=KnowledgeCopyInput
/** 本机原件事实独立于行业包来源；不虚构许可、发布者或包身份。 */
export type LocalKnowledgeCopyOrigin={kind:'local-material';resourceId:string;resourceVersion:number;sourceId:string;sourceTitle:string;sourceVersion:string;sourcePath:string;bytes:number}
export type LocalKnowledgeCopyPreview={origin:LocalKnowledgeCopyOrigin;title:string;markdown:string;scopeIds:string[]}
export type LocalKnowledgeCopyResult={knowledge:PasteKnowledge;resource:WorkResource;origin:LocalKnowledgeCopyOrigin}
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const localPath=(value:unknown):value is string=>text(value,1024)&&!value.startsWith('/')&&!/^[a-z]:/i.test(value)&&!/[\\\x00-\x1f\x7f]/.test(value)&&value.split('/').every(part=>!!part&&part!=='.'&&part!=='..'&&!part.startsWith('.'))&&/\.(md|markdown)$/i.test(value)
export function isLocalKnowledgeCopyOrigin(value:unknown):value is LocalKnowledgeCopyOrigin{
 return isRecord(value)&&exact(value,['kind','resourceId','resourceVersion','sourceId','sourceTitle','sourceVersion','sourcePath','bytes'])&&value.kind==='local-material'&&resourceId(value.resourceId)&&resourceVersion(value.resourceVersion)&&typeof value.sourceId==='string'&&value.sourceId.startsWith('local_material_')&&resourceId(value.sourceId.slice('local_material_'.length))&&text(value.sourceTitle,200)&&typeof value.sourceVersion==='string'&&/^[a-f0-9]{64}$/.test(value.sourceVersion)&&localPath(value.sourcePath)&&typeof value.bytes==='number'&&Number.isSafeInteger(value.bytes)&&value.bytes>=0&&value.bytes<=128*1024
}
export function isLocalKnowledgeCopyPreview(value:unknown):value is LocalKnowledgeCopyPreview{
 return isRecord(value)&&exact(value,['origin','title','markdown','scopeIds'])&&isLocalKnowledgeCopyOrigin(value.origin)&&text(value.title,200)&&typeof value.markdown==='string'&&new TextEncoder().encode(value.markdown).byteLength===value.origin.bytes&&resourceScopes(value.scopeIds)
}
export function isLocalKnowledgeCopyResult(value:unknown):value is LocalKnowledgeCopyResult{
 if(!isRecord(value)||!exact(value,['knowledge','resource','origin'])||!isPasteKnowledge(value.knowledge)||!isWorkResource(value.resource)||!isLocalKnowledgeCopyOrigin(value.origin))return false
 const {item,version}=value.knowledge,r=value.resource
 return item.sourceType==='paste'&&item.currentVersion===1&&version.version===1&&r.status==='active'&&r.version===1&&r.ownerId===item.ownerId&&r.title===item.title&&r.sourceId==='knowledge_'+item.id&&r.sourceVersion===version.contentHash&&JSON.stringify(r.scopeIds)===JSON.stringify(item.scopeIds)
}
