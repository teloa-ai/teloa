import {isRecord,isWorkResource,resourceId,resourceScopes,resourceTopics,resourceVersion,type WorkResource} from './resources.ts'

export const knowledgeCategories=['business-context','policy','sop','criteria','reference','template-asset','system-data-guide'] as const
export type KnowledgeCategory=typeof knowledgeCategories[number]
export type KnowledgeItem={
 id:string;ownerId:string;sourceId:string;sourceType:'paste';workspaceId:string;title:string;category:KnowledgeCategory;topics:string[];scopeIds:string[]
 currentVersion:number;status:'active';createdAt:string;updatedAt:string
}
export type KnowledgeVersionSummary={
 knowledgeId:string;ownerId:string;sourceId:string;sourceType:'paste';version:number;contentHash:string;bytes:number;createdAt:string
}
export type KnowledgeVersion=KnowledgeVersionSummary&{markdown:string}
export type PasteKnowledge={item:KnowledgeItem;version:KnowledgeVersion}
export type KnowledgeReviseInput={requestId:string;knowledgeId:string;expectedVersion:number;markdown:string}
export type KnowledgeRestoreInput={requestId:string;knowledgeId:string;version:number;expectedVersion:number}
export type KnowledgeResourceReviseInput={requestId:string;knowledgeId:string;expectedKnowledgeVersion:number;resourceId:string;expectedResourceVersion:number;markdown:string}
export type KnowledgeResourceRestoreInput={requestId:string;knowledgeId:string;expectedKnowledgeVersion:number;resourceId:string;expectedResourceVersion:number;restoreVersion:number}
export type KnowledgeResourceRevision={knowledge:PasteKnowledge;resource:WorkResource}
export type KnowledgeSpace={
 id:string;ownerId:string;workspaceId:string;title:string;rootNodeId:string;directoryRevision:number;scopeIds:string[];createdAt:string;updatedAt:string
}
export type KnowledgeNodeBase={
 id:string;spaceId:string;parentId:string|null;type:'space'|'folder'|'page';title:string;siblingOrder:number;path:string[];createdAt:string;updatedAt:string
}
export type KnowledgeSpaceNode=KnowledgeNodeBase&{type:'space';parentId:null}
export type KnowledgeFolderNode=KnowledgeNodeBase&{type:'folder';parentId:string}
export type KnowledgePageNode=KnowledgeNodeBase&{type:'page';parentId:string;knowledgeId:string}
export type KnowledgeNode=KnowledgeSpaceNode|KnowledgeFolderNode|KnowledgePageNode
export type KnowledgeTree={space:KnowledgeSpace;nodes:KnowledgeNode[]}
export type KnowledgeTreeMutation={space:KnowledgeSpace;node:KnowledgeNode}

const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const exactKeys=(value:Record<string,unknown>,keys:readonly string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key))
export function isKnowledgeItem(value:unknown):value is KnowledgeItem{
 return isRecord(value)&&resourceId(value.id)&&typeof value.ownerId==='string'&&!!value.ownerId&&resourceId(value.sourceId)&&value.sourceType==='paste'&&stable(value.workspaceId)&&typeof value.title==='string'&&!!value.title.trim()&&value.title.length<=200&&knowledgeCategories.includes(value.category as KnowledgeCategory)&&resourceTopics(value.topics)&&resourceScopes(value.scopeIds)&&resourceVersion(value.currentVersion)&&value.status==='active'&&stamp(value.createdAt)&&stamp(value.updatedAt)
}
export function isKnowledgeVersionSummary(value:unknown):value is KnowledgeVersionSummary{
 return isRecord(value)&&resourceId(value.knowledgeId)&&typeof value.ownerId==='string'&&!!value.ownerId&&resourceId(value.sourceId)&&value.sourceType==='paste'&&resourceVersion(value.version)&&hash(value.contentHash)&&typeof value.bytes==='number'&&Number.isSafeInteger(value.bytes)&&value.bytes>0&&value.bytes<=2*1024*1024&&stamp(value.createdAt)
}
/** 只校验跨边界形状与 UTF-8 字节数；正文摘要完整性使用 verifyKnowledgeVersionContent。 */
export function isKnowledgeVersion(value:unknown):value is KnowledgeVersion{
 if(!isRecord(value))return false
 const markdown=value.markdown
 if(!isKnowledgeVersionSummary(value)||typeof markdown!=='string')return false
 return new TextEncoder().encode(markdown).byteLength===value.bytes
}
export function isPasteKnowledge(value:unknown):value is PasteKnowledge{
 if(!isRecord(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'item')||!Object.hasOwn(value,'version')||!isKnowledgeItem(value.item)||!isKnowledgeVersion(value.version))return false
 return value.version.knowledgeId===value.item.id&&value.version.ownerId===value.item.ownerId&&value.version.sourceId===value.item.sourceId&&value.version.sourceType===value.item.sourceType&&value.version.version===value.item.currentVersion
}
export function isKnowledgeResourceRevision(value:unknown):value is KnowledgeResourceRevision{
 if(!isRecord(value)||Object.keys(value).length!==2||!Object.hasOwn(value,'knowledge')||!Object.hasOwn(value,'resource')||!isPasteKnowledge(value.knowledge)||!isWorkResource(value.resource))return false
 const {item,version}=value.knowledge,resource=value.resource
 return resource.status==='active'&&resource.ownerId===item.ownerId&&resource.title===item.title&&resource.sourceId==='knowledge_'+item.id.toLowerCase()&&resource.sourceVersion===version.contentHash&&JSON.stringify(resource.scopeIds)===JSON.stringify(item.scopeIds)
}
export function isKnowledgeSpace(value:unknown):value is KnowledgeSpace{
 if(!isRecord(value)||!exactKeys(value,['id','ownerId','workspaceId','title','rootNodeId','directoryRevision','scopeIds','createdAt','updatedAt']))return false
 return stable(value.id)&&typeof value.ownerId==='string'&&!!value.ownerId&&stable(value.workspaceId)&&typeof value.title==='string'&&!!value.title.trim()&&value.title.length<=200&&stable(value.rootNodeId)&&resourceVersion(value.directoryRevision)&&resourceScopes(value.scopeIds)&&stamp(value.createdAt)&&stamp(value.updatedAt)
}
export function isKnowledgeNode(value:unknown):value is KnowledgeNode{
 if(!isRecord(value))return false
 const common=['id','spaceId','parentId','type','title','siblingOrder','path','createdAt','updatedAt'],keys=value.type==='page'?[...common,'knowledgeId']:common
 if(!exactKeys(value,keys)||!stable(value.id)||!stable(value.spaceId)||typeof value.title!=='string'||!value.title.trim()||value.title.length>200||!Number.isSafeInteger(value.siblingOrder)||Number(value.siblingOrder)<0||!Array.isArray(value.path)||value.path.length===0||value.path.length>64||!value.path.every(stable)||new Set(value.path).size!==value.path.length||value.path.at(-1)!==value.id||!stamp(value.createdAt)||!stamp(value.updatedAt))return false
 if(value.type==='space')return value.parentId===null&&value.siblingOrder===0&&value.path.length===1
 if((value.type!=='folder'&&value.type!=='page')||!stable(value.parentId)||value.path.length<2||value.path.at(-2)!==value.parentId)return false
 return value.type==='folder'||resourceId(value.knowledgeId)
}
export function isKnowledgeTree(value:unknown):value is KnowledgeTree{
 if(!isRecord(value)||!exactKeys(value,['space','nodes'])||!isKnowledgeSpace(value.space)||!Array.isArray(value.nodes)||!value.nodes.every(isKnowledgeNode))return false
 const nodes=value.nodes,nodeById=new Map(nodes.map(node=>[node.id,node]))
 if(nodeById.size!==nodes.length)return false
 const root=nodeById.get(value.space.rootNodeId)
 if(!root||root.type!=='space'||root.spaceId!==value.space.id||root.title!==value.space.title)return false
 for(const node of nodes){
  if(node.spaceId!==value.space.id||node.path[0]!==value.space.rootNodeId||(node.type==='space'&&node.id!==value.space.rootNodeId))return false
  if(node.type!=='space'){
   const parent=nodeById.get(node.parentId)
   if(!parent||parent.type==='page'||node.path.length!==parent.path.length+1||node.path.some((part,index)=>index<parent.path.length&&part!==parent.path[index]))return false
  }
 }
 const siblings=new Map<string,number[]>()
 for(const node of nodes){if(node.parentId!==null){const rows=siblings.get(node.parentId)??[];rows.push(node.siblingOrder);siblings.set(node.parentId,rows)}}
 return [...siblings.values()].every(orders=>orders.sort((a,b)=>a-b).every((order,index)=>order===index))
}
export function isKnowledgeTreeMutation(value:unknown):value is KnowledgeTreeMutation{
 return isRecord(value)&&exactKeys(value,['space','node'])&&isKnowledgeSpace(value.space)&&isKnowledgeNode(value.node)&&value.node.spaceId===value.space.id&&value.node.path[0]===value.space.rootNodeId
}
/** 浏览器与 Node 均可用的正文 SHA-256 完整性校验。 */
export async function verifyKnowledgeVersionContent(value:unknown):Promise<boolean>{
 if(!isKnowledgeVersion(value))return false
 const bytes=new TextEncoder().encode(value.markdown),actual=await globalThis.crypto.subtle.digest('SHA-256',bytes)
 return [...new Uint8Array(actual)].map(byte=>byte.toString(16).padStart(2,'0')).join('')===value.contentHash
}
