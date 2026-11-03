import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {isKnowledgeCopyOrigin,isKnowledgeCopyResult,isRecord,resourceId,resourceVersion,WorkError,type KnowledgeCopyInput,type KnowledgeCopyOrigin,type KnowledgeCopyPreview,type KnowledgeCopyRef,type KnowledgeCopyResult} from '@teloa/contract'
import {authorizeResourceActor,ResourceService,type ResourceActor} from './resources.ts'
import {MarkdownKnowledgeService,normalizePasteMarkdown} from './markdown-knowledge.ts'
import {IndustryReferenceCatalog} from './industry-reference-catalog.ts'
const bad=()=>new WorkError('teloa/invalid-input','知识副本请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','知识副本来源或回执损坏。')
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const parse=(input:unknown,create=false):KnowledgeCopyRef=>{
 const keys=['resourceId','expectedResourceVersion','sourceVersion',...(create?['requestId','title','markdown']:[])]
 if(!isRecord(input)||Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||!resourceId(input.resourceId)||!resourceVersion(input.expectedResourceVersion)||typeof input.sourceVersion!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceVersion))throw bad()
 return {resourceId:input.resourceId.toLowerCase(),expectedResourceVersion:input.expectedResourceVersion,sourceVersion:input.sourceVersion}
}
export async function initializeKnowledgeCopies(pool:Pool){await pool.query([
 "create table if not exists teloa_knowledge_copies(owner_id text not null,request_id uuid not null,command_hash text not null check(command_hash ~ '^[a-f0-9]{64}$'),knowledge_id uuid not null,result jsonb not null check(jsonb_typeof(result)='object'),primary key(owner_id,request_id),unique(owner_id,knowledge_id),foreign key(owner_id,knowledge_id) references teloa_knowledge_items(owner_id,id));",
 "create or replace function teloa_reject_knowledge_copy_mutation() returns trigger language plpgsql as $$ begin raise exception 'knowledge copy provenance and receipts are immutable'; end $$;",
 "drop trigger if exists teloa_knowledge_copies_immutable on teloa_knowledge_copies;",
 "create trigger teloa_knowledge_copies_immutable before update or delete on teloa_knowledge_copies for each row execute function teloa_reject_knowledge_copy_mutation();"
].join('\n'))}
/** 固定分享来源保持原样；只有本人明确保存才产生独立知识和可引用资料。 */
export class KnowledgeCopyService{
 private readonly pool:Pool
 private readonly knowledge:MarkdownKnowledgeService
 private readonly resources:ResourceService
 private readonly industry:IndustryReferenceCatalog
 constructor(pool:Pool,knowledge:MarkdownKnowledgeService,resources:ResourceService,industry:IndustryReferenceCatalog){this.pool=pool;this.knowledge=knowledge;this.resources=resources;this.industry=industry}
 private async tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','知识副本服务暂不可用。')})
  try{await client.query('begin');const value=await operation(client);await client.query('commit');return value}catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','知识副本保存结果尚未核实，请沿原请求核对。')}finally{client.release()}
 }
 private async previewIn(client:PoolClient,actor:ResourceActor,ref:KnowledgeCopyRef):Promise<KnowledgeCopyPreview>{
  const resource=await this.resources.getResourceInTransaction(client,actor,ref.resourceId)
  if(resource.status!=='active')throw new WorkError('teloa/resource-withdrawn','原资料已撤回，不能创建新的副本。')
  if(resource.version!==ref.expectedResourceVersion||resource.sourceVersion!==ref.sourceVersion)throw new WorkError('teloa/version-conflict','原资料版本已变化，请重新读取后创建副本。')
  if(!resource.sourceId.startsWith('industry_'))throw new WorkError('teloa/invalid-input','仅固定分享资料使用此副本入口。')
  const source=await this.industry.copySource(resource.sourceId,resource.sourceVersion,{actor,client,scopeIds:resource.scopeIds})
  const origin:KnowledgeCopyOrigin={resourceId:resource.id,resourceVersion:resource.version,sourceId:resource.sourceId,sourceVersion:source.version,...source.copyOrigin}
  if(!isKnowledgeCopyOrigin(origin))throw corrupt()
  return {origin,title:resource.title,markdown:source.text,scopeIds:resource.scopeIds}
 }
 async preview(actor:ResourceActor,input:unknown):Promise<KnowledgeCopyPreview>{
  authorizeResourceActor(actor,actor.ownerId,[],true);const ref=parse(input)
  return this.tx(client=>this.previewIn(client,actor,ref))
 }
 private async receipt(client:PoolClient,actor:ResourceActor,requestId:string,commandHash:string):Promise<KnowledgeCopyResult|undefined>{
  const row=(await client.query('select command_hash,knowledge_id,result from teloa_knowledge_copies where owner_id=$1 and request_id=$2',[actor.ownerId,requestId])).rows[0]
  if(!row)return undefined
  if(row.command_hash!==commandHash)throw new WorkError('teloa/conflict','同一请求 ID 不能创建另一份知识副本。')
  if(!isKnowledgeCopyResult(row.result)||row.result.knowledge.item.id!==row.knowledge_id||row.result.knowledge.item.ownerId!==actor.ownerId)throw corrupt()
  authorizeResourceActor(actor,actor.ownerId,row.result.resource.scopeIds,true)
  await this.resources.recoverKnowledgeProjectionInTransaction(client,actor,row.result.resource)
  return row.result
 }
 async create(actor:ResourceActor,input:unknown):Promise<KnowledgeCopyResult>{
  authorizeResourceActor(actor,actor.ownerId,[],true);const ref=parse(input,true),row=input as KnowledgeCopyInput
  if(!resourceId(row.requestId)||typeof row.title!=='string'||!row.title.trim()||row.title.length>200)throw bad()
  const requestId=row.requestId.toLowerCase(),title=row.title.trim(),markdown=normalizePasteMarkdown(row.markdown),commandHash=hash(JSON.stringify({...ref,title,contentHash:hash(markdown)}))
  // 恢复已提交事实不依赖原来源仍active，但永远限定当前本人及原业务范围。
  const prior=await this.tx(client=>this.receipt(client,actor,requestId,commandHash));if(prior)return prior
  const preview=await this.tx(client=>this.previewIn(client,actor,ref))
  const result=await this.knowledge.createPasteWithTransaction(actor,{requestId,title,category:'reference',topics:[],scopeIds:preview.scopeIds,markdown},async(client,saved,replayed)=>{
   const existing=await this.receipt(client,actor,requestId,commandHash);if(existing)return existing
   if(replayed)throw new WorkError('teloa/conflict','此请求已用于其他知识创建。')
   const current=await this.previewIn(client,actor,ref)
   if(JSON.stringify(current)!==JSON.stringify(preview))throw new WorkError('teloa/version-conflict','原来源或许可已变化，请重新审阅。')
   const resource=await this.resources.createKnowledgeProjectionInTransaction(client,actor,{title:saved.item.title,sourceId:'knowledge_'+saved.item.id,sourceVersion:saved.version.contentHash,scopeIds:saved.item.scopeIds})
   const result={knowledge:saved,resource,origin:current.origin}
   if(!isKnowledgeCopyResult(result))throw corrupt()
   await client.query('insert into teloa_knowledge_copies(owner_id,request_id,command_hash,knowledge_id,result) values($1,$2,$3,$4,$5)',[actor.ownerId,requestId,commandHash,saved.item.id,JSON.stringify(result)])
   return result
  })
  return result.value
 }
 async origin(actor:ResourceActor,input:unknown):Promise<KnowledgeCopyOrigin|null>{
  authorizeResourceActor(actor);if(!isRecord(input)||Object.keys(input).length!==1||!resourceId(input.knowledgeId))throw bad()
  await this.knowledge.listVersions(actor,{knowledgeId:input.knowledgeId})
  return this.tx(async client=>{const row=(await client.query('select result from teloa_knowledge_copies where owner_id=$1 and knowledge_id=$2',[actor.ownerId,input.knowledgeId])).rows[0];if(!row)return null;if(!isKnowledgeCopyResult(row.result))throw corrupt();return row.result.origin})
 }
}
