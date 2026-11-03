import {isRecord,isWorkResource,resourceId,resourceScopes,resourceVersion,type WorkResource} from './resources.ts'
import {isPasteKnowledge,type PasteKnowledge} from './knowledge.ts'
export type KnowledgeCopyRef={resourceId:string;expectedResourceVersion:number;sourceVersion:string}
export type KnowledgeCopyInput=KnowledgeCopyRef&{requestId:string;title:string;markdown:string}
/** 固定来源的事实记录；正文修订不会覆盖它，许可是来源声明而非平台背书。 */
export type KnowledgeCopyOrigin={resourceId:string;resourceVersion:number;sourceId:string;sourceTitle:string;sourceVersion:string;contentId:string;contentHash:string;packageVersion:string;localId:string;publisher:string;license:{status:'declared';value:string}|{status:'missing'}}
export type KnowledgeCopyPreview={origin:KnowledgeCopyOrigin;title:string;markdown:string;scopeIds:string[]}
export type KnowledgeCopyResult={knowledge:PasteKnowledge;resource:WorkResource;origin:KnowledgeCopyOrigin}
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
export function isKnowledgeCopyOrigin(value:unknown):value is KnowledgeCopyOrigin{
 if(!isRecord(value)||!exact(value,['resourceId','resourceVersion','sourceId','sourceTitle','sourceVersion','contentId','contentHash','packageVersion','localId','publisher','license'])||!isRecord(value.license))return false
 return resourceId(value.resourceId)&&resourceVersion(value.resourceVersion)&&text(value.sourceId,200)&&text(value.sourceTitle,200)&&hash(value.sourceVersion)&&resourceId(value.contentId)&&hash(value.contentHash)&&text(value.packageVersion,120)&&text(value.localId,128)&&text(value.publisher,200)&&(value.license.status==='missing'?exact(value.license,['status']):value.license.status==='declared'&&exact(value.license,['status','value'])&&text(value.license.value,200))
}
export function isKnowledgeCopyPreview(value:unknown):value is KnowledgeCopyPreview{return isRecord(value)&&exact(value,['origin','title','markdown','scopeIds'])&&isKnowledgeCopyOrigin(value.origin)&&text(value.title,200)&&typeof value.markdown==='string'&&new TextEncoder().encode(value.markdown).byteLength<=128*1024&&resourceScopes(value.scopeIds)}
export function isKnowledgeCopyResult(value:unknown):value is KnowledgeCopyResult{
 if(!isRecord(value)||!exact(value,['knowledge','resource','origin'])||!isPasteKnowledge(value.knowledge)||!isWorkResource(value.resource)||!isKnowledgeCopyOrigin(value.origin))return false
 const {item,version}=value.knowledge,r=value.resource
 return item.currentVersion===1&&r.status==='active'&&r.version===1&&r.ownerId===item.ownerId&&r.title===item.title&&r.sourceId==='knowledge_'+item.id&&r.sourceVersion===version.contentHash&&JSON.stringify(r.scopeIds)===JSON.stringify(item.scopeIds)
}

export function sameKnowledgeCopyOrigin(left:KnowledgeCopyOrigin,right:KnowledgeCopyOrigin):boolean{
 const keys=['resourceId','resourceVersion','sourceId','sourceTitle','sourceVersion','contentId','contentHash','packageVersion','localId','publisher'] as const
 return keys.every(key=>left[key]===right[key])&&left.license.status===right.license.status&&(left.license.status==='missing'||right.license.status==='declared'&&left.license.value===right.license.value)
}
