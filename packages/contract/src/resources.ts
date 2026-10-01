export type ResourceSpec={title:string;sourceId:string;sourceVersion:string;scopeIds:string[]}
export type ResourceDraft=ResourceSpec & {id:string;ownerId:string;requestId:string;version:number;status:'draft'|'applied';createdAt:string;updatedAt:string;resourceId?:string}
export type WorkResource=ResourceSpec & {id:string;ownerId:string;version:number;status:'active'|'withdrawn';createdAt:string;updatedAt:string}
export type ResourceReference={id:string;version:number}
export type MessageResourceSnapshot={id:string;ownerId:string;sessionId:string;messageId:string;requestId?:string;scopeIds:string[];references:ResourceReference[];createdAt:string}
export type ResourceContext={snapshot:MessageResourceSnapshot;contents:(ResourceSpec & {id:string;version:number;text:string})[]}
export type ResourceDirectory={drafts:ResourceDraft[];resources:WorkResource[]}
export type KnowledgeSourceMetadata={knowledgeId:string;knowledgeVersion:number;workspaceId:string;category:KnowledgeCategory;topics:string[];scopeIds:string[]}
export type SourceReference={id:string;title:string;source:string;version:string;bytes:number;knowledge?:KnowledgeSourceMetadata}

/** 资料或技能正文整段写进模型提示词时的上限（单份与合计同值）；更大的资料只能加入本地检索按摘录使用。 */
export const promptFullTextMaxBytes=256*1024

export const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v)
const exactKeys=(v:Record<string,unknown>,keys:readonly string[])=>Object.keys(v).every(key=>keys.includes(key))
export const resourceId=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export const resourceScopes=(v:unknown):v is string[]=>Array.isArray(v)&&v.length>0&&v.length<=16&&new Set(v).size===v.length&&v.every(scope=>typeof scope==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(scope))
export const resourceTopics=(v:unknown):v is string[]=>Array.isArray(v)&&v.length<=20&&new Set(v).size===v.length&&v.every(topic=>typeof topic==='string'&&topic.length>0&&topic===topic.trim()&&topic.length<=80)
export const resourceVersion=(v:unknown):v is number=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
/** 与已发布 ResourceSpec 保持同一合法域，包括组合 emoji、换行与零宽字符。 */
export const resourceTitle=(v:unknown):v is string=>typeof v==='string'&&v.trim().length>0&&v.length<=200
export const isResourceSpec=(v:unknown):v is ResourceSpec=>isRecord(v)&&resourceTitle(v.title)&&typeof v.sourceId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v.sourceId)&&typeof v.sourceVersion==='string'&&/^[a-f0-9]{64}$/.test(v.sourceVersion)&&resourceScopes(v.scopeIds)
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))
const base=(v:unknown)=>isRecord(v)&&resourceId(v.id)&&typeof v.ownerId==='string'&&v.ownerId.length>0&&resourceVersion(v.version)&&stamp(v.createdAt)&&stamp(v.updatedAt)&&isResourceSpec(v)
export const isResourceDraft=(v:unknown):v is ResourceDraft=>isRecord(v)&&base(v)&&resourceId(v.requestId)&&((v.status==='draft'&&v.resourceId===undefined)||(v.status==='applied'&&resourceId(v.resourceId)))
export const isWorkResource=(v:unknown):v is WorkResource=>isRecord(v)&&base(v)&&(v.status==='active'||v.status==='withdrawn')
export const isResourceDirectory=(v:unknown):v is ResourceDirectory=>isRecord(v)&&Array.isArray(v.drafts)&&v.drafts.every(isResourceDraft)&&Array.isArray(v.resources)&&v.resources.every(isWorkResource)
export const isSourceReference=(v:unknown):v is SourceReference=>isRecord(v)&&exactKeys(v,['id','title','source','version','bytes','knowledge'])&&typeof v.id==='string'&&typeof v.title==='string'&&typeof v.source==='string'&&typeof v.version==='string'&&/^[a-f0-9]{64}$/.test(v.version)&&typeof v.bytes==='number'&&Number.isSafeInteger(v.bytes)&&v.bytes>=0&&(v.knowledge===undefined||(isRecord(v.knowledge)&&exactKeys(v.knowledge,['knowledgeId','knowledgeVersion','workspaceId','category','topics','scopeIds'])&&resourceId(v.knowledge.knowledgeId)&&resourceVersion(v.knowledge.knowledgeVersion)&&typeof v.knowledge.workspaceId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v.knowledge.workspaceId)&&knowledgeCategories.includes(v.knowledge.category as KnowledgeCategory)&&resourceTopics(v.knowledge.topics)&&resourceScopes(v.knowledge.scopeIds)))

export function encodeResourceReference(ref:ResourceReference):string {
  if(!resourceId(ref.id)||!resourceVersion(ref.version))throw Error('资料引用格式不正确。')
  return '[[teloa-resource:'+ref.id+'@'+ref.version+']]'
}
export function parseResourceReferences(text:string):ResourceReference[] {
  const refs:ResourceReference[]=[],seen=new Set<string>()
  for(const segment of text.split('[[teloa-resource:').slice(1)){
    const match=/^([a-f0-9-]+)@([1-9][0-9]*)\]\]/i.exec(segment)
    if(!match||!resourceId(match[1])||!resourceVersion(Number(match[2])))throw Error('资料引用损坏，请重新从工作资料选择。')
    const ref={id:match[1],version:Number(match[2])},key=encodeResourceReference(ref)
    if(!seen.has(key)){seen.add(key);refs.push(ref)}
    if(refs.length>8)throw Error('每条消息最多引用 8 份工作资料。')
  }
  return refs
}
import {knowledgeCategories,type KnowledgeCategory} from './knowledge.ts'
