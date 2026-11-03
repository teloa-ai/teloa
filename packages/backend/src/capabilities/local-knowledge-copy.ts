import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {isLocalKnowledgeCopyOrigin,isLocalKnowledgeCopyPreview,isLocalKnowledgeCopyResult,isRecord,resourceId,resourceVersion,WorkError,type LocalKnowledgeCopyInput,type LocalKnowledgeCopyRef,type LocalKnowledgeCopyOrigin,type LocalKnowledgeCopyPreview,type LocalKnowledgeCopyResult} from '@teloa/contract'
import {authorizeResourceActor,ResourceService,type ResourceActor,type ResourceSourceCatalog} from './resources.ts'
import {MarkdownKnowledgeService,normalizePasteMarkdown} from './markdown-knowledge.ts'
const bad=()=>new WorkError('teloa/invalid-input','本机知识副本请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','本机知识副本来源或回执损坏。')
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
function parse(input:unknown,create=false):LocalKnowledgeCopyRef{
 const keys=['resourceId','expectedResourceVersion','sourceVersion',...(create?['requestId','title','markdown']:[])]
 if(!isRecord(input)||Object.keys(input).length!==keys.length||keys.some(key=>!Object.hasOwn(input,key))||!resourceId(input.resourceId)||!resourceVersion(input.expectedResourceVersion)||typeof input.sourceVersion!=='string'||!/^[a-f0-9]{64}$/.test(input.sourceVersion))throw bad()
 return {resourceId:input.resourceId.toLowerCase(),expectedResourceVersion:input.expectedResourceVersion,sourceVersion:input.sourceVersion}
}
export async function initializeLocalKnowledgeCopies(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_local_knowledge_copies(
  owner_id text not null,request_id uuid not null,command_hash text not null check(command_hash ~ '^[a-f0-9]{64}$'),
  knowledge_id uuid not null,result jsonb not null check(jsonb_typeof(result)='object'),
  primary key(owner_id,request_id),unique(owner_id,knowledge_id),
  foreign key(owner_id,knowledge_id) references teloa_knowledge_items(owner_id,id)
 );
 create or replace function teloa_reject_local_knowledge_copy_mutation() returns trigger language plpgsql as $$ begin raise exception 'local knowledge copy provenance and receipts are immutable'; end $$;
 drop trigger if exists teloa_local_knowledge_copies_immutable on teloa_local_knowledge_copies;
 create trigger teloa_local_knowledge_copies_immutable before update or delete on teloa_local_knowledge_copies for each row execute function teloa_reject_local_knowledge_copy_mutation();
`)}
/** 明确保存才创建普通 paste；本机来源事实与行业包协议完全分开。 */
export class LocalKnowledgeCopyService{
 private readonly pool:Pool
 private readonly knowledge:MarkdownKnowledgeService
 private readonly resources:ResourceService
 private readonly sources:ResourceSourceCatalog
 constructor(pool:Pool,knowledge:MarkdownKnowledgeService,resources:ResourceService,sources:ResourceSourceCatalog){this.pool=pool;this.knowledge=knowledge;this.resources=resources;this.sources=sources}
 private async tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','本机知识副本服务暂不可用。')})
  try{await client.query('begin');const result=await operation(client);await client.query('commit');return result}
  catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','本机副本保存结果尚未核实，请沿原请求核对。')}finally{client.release()}
 }
 private async previewIn(client:PoolClient,actor:ResourceActor,ref:LocalKnowledgeCopyRef):Promise<LocalKnowledgeCopyPreview>{
  const resource=await this.resources.getResourceInTransaction(client,actor,ref.resourceId)
  if(resource.status!=='active')throw new WorkError('teloa/resource-withdrawn','原资料已撤回，不能创建新的本机副本。')
  if(resource.version!==ref.expectedResourceVersion||resource.sourceVersion!==ref.sourceVersion)throw new WorkError('teloa/version-conflict','原资料版本已变化，请重新读取后保存副本。')
  if(!resource.sourceId.startsWith('local_material_'))throw new WorkError('teloa/invalid-input','此副本入口只接受已登记的本机原件。')
  const source=await this.sources.read(resource.sourceId,ref.sourceVersion,{actor,client,scopeIds:resource.scopeIds})
  if(source.id!==resource.sourceId||source.version!==ref.sourceVersion||hash(source.text)!==source.version)throw corrupt()
  const result:LocalKnowledgeCopyPreview={origin:{kind:'local-material',resourceId:resource.id,resourceVersion:resource.version,sourceId:source.id,sourceTitle:source.title,sourceVersion:source.version,sourcePath:source.source,bytes:source.bytes},title:resource.title,markdown:source.text,scopeIds:resource.scopeIds}
  if(!isLocalKnowledgeCopyPreview(result))throw corrupt()
  return result
 }
 async preview(actor:ResourceActor,input:unknown):Promise<LocalKnowledgeCopyPreview>{
  authorizeResourceActor(actor,actor.ownerId,[],true);const ref=parse(input)
  return this.tx(client=>this.previewIn(client,actor,ref))
 }
 private async receipt(client:PoolClient,actor:ResourceActor,requestId:string,commandHash:string):Promise<LocalKnowledgeCopyResult|undefined>{
  const row=(await client.query('select command_hash,knowledge_id,result from teloa_local_knowledge_copies where owner_id=$1 and request_id=$2',[actor.ownerId,requestId])).rows[0]
  if(!row)return undefined
  if(row.command_hash!==commandHash)throw new WorkError('teloa/conflict','同一请求 ID 不能创建另一份本机知识副本。')
  if(!isLocalKnowledgeCopyResult(row.result)||row.result.knowledge.item.id!==row.knowledge_id||row.result.knowledge.item.ownerId!==actor.ownerId)throw corrupt()
  authorizeResourceActor(actor,actor.ownerId,row.result.resource.scopeIds,true)
  await this.resources.recoverKnowledgeProjectionInTransaction(client,actor,row.result.resource)
  return row.result
 }
 async create(actor:ResourceActor,input:unknown):Promise<LocalKnowledgeCopyResult>{
  authorizeResourceActor(actor,actor.ownerId,[],true);const ref=parse(input,true),row=input as LocalKnowledgeCopyInput
  if(!resourceId(row.requestId)||typeof row.title!=='string'||!row.title.trim()||row.title.length>200)throw bad()
  const requestId=row.requestId.toLowerCase(),title=row.title.trim(),markdown=normalizePasteMarkdown(row.markdown),commandHash=hash(JSON.stringify({...ref,title,contentHash:hash(markdown)}))
  // 已提交的独立副本按原请求恢复；不因原件后来失效重建或换身份。
  const prior=await this.tx(client=>this.receipt(client,actor,requestId,commandHash));if(prior)return prior
  const preview=await this.tx(client=>this.previewIn(client,actor,ref))
  const result=await this.knowledge.createPasteWithTransaction(actor,{requestId,title,category:'reference',topics:[],scopeIds:preview.scopeIds,markdown},async(client,saved,replayed)=>{
   const existing=await this.receipt(client,actor,requestId,commandHash);if(existing)return existing
   if(replayed)throw new WorkError('teloa/conflict','此请求已用于其他知识创建。')
   const current=await this.previewIn(client,actor,ref)
   if(JSON.stringify(current)!==JSON.stringify(preview))throw new WorkError('teloa/version-conflict','本机来源或范围已变化，请重新审阅。')
   const resource=await this.resources.createKnowledgeProjectionInTransaction(client,actor,{title:saved.item.title,sourceId:'knowledge_'+saved.item.id,sourceVersion:saved.version.contentHash,scopeIds:saved.item.scopeIds})
   const value={knowledge:saved,resource,origin:current.origin};if(!isLocalKnowledgeCopyResult(value))throw corrupt()
   await client.query('insert into teloa_local_knowledge_copies(owner_id,request_id,command_hash,knowledge_id,result) values($1,$2,$3,$4,$5)',[actor.ownerId,requestId,commandHash,saved.item.id,JSON.stringify(value)])
   return value
  })
  return result.value
 }
 async origin(actor:ResourceActor,input:unknown):Promise<LocalKnowledgeCopyOrigin|null>{
  authorizeResourceActor(actor,actor.ownerId,[],true);if(!isRecord(input)||Object.keys(input).length!==1||!resourceId(input.knowledgeId))throw bad()
  await this.knowledge.listVersions(actor,{knowledgeId:input.knowledgeId})
  return this.tx(async client=>{
   const row=(await client.query('select result from teloa_local_knowledge_copies where owner_id=$1 and knowledge_id=$2',[actor.ownerId,input.knowledgeId])).rows[0]
   if(!row)return null
   if(!isLocalKnowledgeCopyResult(row.result)||row.result.knowledge.item.id!==input.knowledgeId||row.result.knowledge.item.ownerId!==actor.ownerId||!isLocalKnowledgeCopyOrigin(row.result.origin))throw corrupt()
   return row.result.origin
  })
 }
}
