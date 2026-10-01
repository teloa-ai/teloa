import {WorkError,type KnowledgeItem,type KnowledgeVersion,type KnowledgeVersionSummary} from '@teloa/contract'
import type {ResourceActor,ResourceSourceCatalog,ResourceSourceContext} from './resources.ts'

const pattern=/^knowledge_([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i
const forbidden=()=>new WorkError('teloa/forbidden','当前主体、工作空间或范围无权读取此工作资料。')
export const markdownKnowledgeReferenceId=(knowledgeId:string)=>`knowledge_${knowledgeId.toLowerCase()}`

type KnowledgePort={
 list(actor:ResourceActor,input:unknown):Promise<KnowledgeItem[]>
 listVersions(actor:ResourceActor,input:unknown):Promise<KnowledgeVersionSummary[]>
 readVersion(actor:ResourceActor,input:unknown):Promise<KnowledgeVersion>
}

export class MarkdownKnowledgeCatalog implements ResourceSourceCatalog{
 private readonly knowledge:KnowledgePort
 constructor(knowledge:KnowledgePort){this.knowledge=knowledge}
 private actor(context?:ResourceSourceContext):ResourceActor{const actor=context?.actor;if(!actor)throw forbidden();return actor}
 private allowed(item:KnowledgeItem,context:ResourceSourceContext):void{
  if(item.workspaceId!=='default'||item.ownerId!==context.actor.ownerId||item.status!=='active'||item.scopeIds.some(scope=>!context.actor.scopeIds.includes(scope)||!context.scopeIds?.includes(scope)))throw forbidden()
 }
 async list(context?:ResourceSourceContext){
  const actor=this.actor(context),items=await this.knowledge.list(actor,{}),references=[]
  for(const item of items){
   if(item.workspaceId!=='default'||item.ownerId!==actor.ownerId||item.status!=='active'||item.scopeIds.some(scope=>!actor.scopeIds.includes(scope)))continue
   const versions=await this.knowledge.listVersions(actor,{knowledgeId:item.id}),version=versions.find(row=>row.version===item.currentVersion)
   if(!version||version.ownerId!==actor.ownerId||version.knowledgeId!==item.id||version.sourceId!==item.sourceId)throw new WorkError('teloa/storage-corrupt','工作资料知识目录与正文版本不一致。')
   references.push({id:markdownKnowledgeReferenceId(item.id),title:item.title,source:`knowledge:${item.id}@${version.version}`,version:version.contentHash,bytes:version.bytes,knowledge:{knowledgeId:item.id,knowledgeVersion:version.version,workspaceId:item.workspaceId,category:item.category,topics:[...item.topics],scopeIds:[...item.scopeIds]}})
  }
  return {schema:'teloa.reference-list/v1' as const,references}
 }
 /** 不读正文：按知识版本登记的字节数给出体积；主体无权、非当前工作空间或版本不符的不给。 */
 async sizes(refs:readonly {id:string;version:string}[],context:ResourceSourceContext){
  const actor=this.actor(context),result=new Map<string,number>(),wanted=refs.filter(ref=>pattern.test(ref.id))
  if(!wanted.length)return result
  const items=await this.knowledge.list(actor,{})
  for(const ref of wanted){
   const knowledgeId=pattern.exec(ref.id)![1]!.toLowerCase(),item=items.find(row=>row.id.toLowerCase()===knowledgeId)
   if(!item)continue
   try{this.allowed(item,context)}catch{continue}
   const summary=(await this.knowledge.listVersions(actor,{knowledgeId:item.id})).find(row=>row.contentHash===ref.version)
   if(summary)result.set(ref.id+'@'+ref.version,summary.bytes)
  }
  return result
 }
 async read(id:string,version:string,context?:ResourceSourceContext){
  const actor=this.actor(context),match=pattern.exec(id);if(!match)throw new WorkError('teloa/source-unavailable','工作资料知识来源身份不存在。')
  const items=await this.knowledge.list(actor,{}),item=items.find(row=>row.id.toLowerCase()===match[1]!.toLowerCase())
  if(!item)throw forbidden();this.allowed(item,context!)
  const versions=await this.knowledge.listVersions(actor,{knowledgeId:item.id}),summary=versions.find(row=>row.contentHash===version)
  if(!summary)throw new WorkError('teloa/version-conflict','工作资料正文版本已变化或不存在。')
  const fixed=await this.knowledge.readVersion(actor,{knowledgeId:item.id,version:summary.version})
  if(fixed.contentHash!==version||fixed.ownerId!==actor.ownerId||fixed.knowledgeId!==item.id||fixed.sourceId!==item.sourceId)throw new WorkError('teloa/storage-corrupt','工作资料固定正文与目录身份不一致。')
  return {schema:'teloa.reference/v1' as const,id,title:item.title,source:`knowledge:${item.id}@${fixed.version}`,version:fixed.contentHash,bytes:fixed.bytes,text:fixed.markdown}
 }
}
