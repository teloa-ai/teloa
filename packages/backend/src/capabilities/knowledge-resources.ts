import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {isKnowledgeResourceRevision,isRecord,isWorkResource,resourceId,resourceVersion,WorkError,type KnowledgeResourceRevision,type PasteKnowledge,type WorkResource} from '@teloa/contract'
import {MarkdownKnowledgeService,normalizePasteMarkdown} from './markdown-knowledge.ts'
import {markdownKnowledgeReferenceId} from './markdown-knowledge-catalog.ts'
import {authorizeResourceActor,ResourceService,type ResourceActor} from './resources.ts'

type ReviseSpec={operation:'revise';knowledgeId:string;expectedKnowledgeVersion:number;resourceId:string;expectedResourceVersion:number;contentHash:string}
type RestoreSpec={operation:'restore';knowledgeId:string;expectedKnowledgeVersion:number;resourceId:string;expectedResourceVersion:number;restoreVersion:number}
type CommandSpec=ReviseSpec|RestoreSpec

const bad=()=>new WorkError('teloa/invalid-input','知识修订请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','知识修订与可引用资源投影记录损坏。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad();return value}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const childRequest=(requestId:string)=>{const value=hash('teloa-knowledge-resource-revision/v1\0'+requestId);return `${value.slice(0,8)}-${value.slice(8,12)}-5${value.slice(13,16)}-a${value.slice(17,20)}-${value.slice(20,32)}`}
const sameSpec=(left:CommandSpec,right:CommandSpec)=>left.operation===right.operation&&left.knowledgeId===right.knowledgeId&&left.expectedKnowledgeVersion===right.expectedKnowledgeVersion&&left.resourceId===right.resourceId&&left.expectedResourceVersion===right.expectedResourceVersion&&(left.operation==='revise'&&right.operation==='revise'?left.contentHash===right.contentHash:left.operation==='restore'&&right.operation==='restore'&&left.restoreVersion===right.restoreVersion)

function parseStoredSpec(value:unknown):CommandSpec{
 if(!isRecord(value)||!['revise','restore'].includes(String(value.operation)))throw corrupt()
 const keys=value.operation==='revise'?['operation','knowledgeId','expectedKnowledgeVersion','resourceId','expectedResourceVersion','contentHash']:['operation','knowledgeId','expectedKnowledgeVersion','resourceId','expectedResourceVersion','restoreVersion']
 if(Object.keys(value).some(key=>!keys.includes(key))||!resourceId(value.knowledgeId)||!resourceVersion(value.expectedKnowledgeVersion)||!resourceId(value.resourceId)||!resourceVersion(value.expectedResourceVersion))throw corrupt()
 if(value.operation==='revise'){
  if(typeof value.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(value.contentHash))throw corrupt()
  return {operation:'revise',knowledgeId:value.knowledgeId.toLowerCase(),expectedKnowledgeVersion:value.expectedKnowledgeVersion,resourceId:value.resourceId.toLowerCase(),expectedResourceVersion:value.expectedResourceVersion,contentHash:value.contentHash}
 }
 if(!resourceVersion(value.restoreVersion))throw corrupt()
 return {operation:'restore',knowledgeId:value.knowledgeId.toLowerCase(),expectedKnowledgeVersion:value.expectedKnowledgeVersion,resourceId:value.resourceId.toLowerCase(),expectedResourceVersion:value.expectedResourceVersion,restoreVersion:value.restoreVersion}
}

function storedResource(value:unknown):WorkResource{
 const keys=['id','ownerId','version','status','createdAt','updatedAt','title','sourceId','sourceVersion','scopeIds']
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key))||!isWorkResource(value)||value.status!=='active')throw corrupt()
 return value
}

export async function initializeKnowledgeResources(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_knowledge_resource_revisions(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  operation text not null check(operation in ('revise','restore')),knowledge_id uuid not null,knowledge_version integer not null check(knowledge_version>1),
  prior_resource_id uuid not null references teloa_resources(id),resource_id uuid not null references teloa_resources(id),
  result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,knowledge_id,knowledge_version) references teloa_knowledge_versions(owner_id,knowledge_id,number)
 );
 create or replace function teloa_reject_knowledge_resource_revision_mutation() returns trigger language plpgsql as $$
 begin raise exception 'knowledge resource revisions are immutable'; end $$;
 drop trigger if exists teloa_knowledge_resource_revisions_immutable on teloa_knowledge_resource_revisions;
 create trigger teloa_knowledge_resource_revisions_immutable before update or delete on teloa_knowledge_resource_revisions
 for each row execute function teloa_reject_knowledge_resource_revision_mutation();
`)}

export class KnowledgeResourceService{
 private readonly knowledge:MarkdownKnowledgeService
 private readonly resources:ResourceService
 constructor(_pool:Pool,knowledge:MarkdownKnowledgeService,resources:ResourceService){this.knowledge=knowledge;this.resources=resources}
 private async project(client:PoolClient,actor:ResourceActor,requestId:string,spec:CommandSpec,saved:PasteKnowledge):Promise<KnowledgeResourceRevision>{
  await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['knowledge-resource-revision',actor.ownerId,requestId])])
  const prior=(await client.query('select * from teloa_knowledge_resource_revisions where owner_id=$1 and request_id=$2 for update',[actor.ownerId,requestId])).rows[0] as Record<string,unknown>|undefined
  if(prior){
   const stored=parseStoredSpec(prior.request_spec)
   if(!sameSpec(stored,spec)||prior.operation!==spec.operation||prior.knowledge_id!==spec.knowledgeId||prior.knowledge_version!==saved.version.version||prior.prior_resource_id!==spec.resourceId)throw new WorkError('teloa/conflict','同一请求 ID 不能发布另一份知识修订。')
   const resource=await this.resources.recoverKnowledgeProjectionInTransaction(client,actor,storedResource(prior.result))
   const result={knowledge:saved,resource}
   if(prior.resource_id!==resource.id||!isKnowledgeResourceRevision(result))throw corrupt()
   return result
  }
  if(saved.item.id!==spec.knowledgeId||saved.item.currentVersion!==spec.expectedKnowledgeVersion+1||saved.version.version!==saved.item.currentVersion)throw corrupt()
  const previous=(await client.query('select source_id,content_hash from teloa_knowledge_versions where owner_id=$1 and knowledge_id=$2 and number=$3',[actor.ownerId,spec.knowledgeId,spec.expectedKnowledgeVersion])).rows[0] as Record<string,unknown>|undefined
  if(!previous||previous.source_id!==saved.item.sourceId||typeof previous.content_hash!=='string'||!/^[a-f0-9]{64}$/.test(previous.content_hash))throw corrupt()
  const resource=await this.resources.replaceKnowledgeProjectionInTransaction(client,actor,{resourceId:spec.resourceId,expectedVersion:spec.expectedResourceVersion,expectedSourceId:markdownKnowledgeReferenceId(saved.item.id),expectedSourceVersion:previous.content_hash,nextSourceVersion:saved.version.contentHash,title:saved.item.title,scopeIds:saved.item.scopeIds})
  const result={knowledge:saved,resource}
  if(!isKnowledgeResourceRevision(result))throw corrupt()
  await client.query('insert into teloa_knowledge_resource_revisions(owner_id,request_id,request_spec,operation,knowledge_id,knowledge_version,prior_resource_id,resource_id,result,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',[actor.ownerId,requestId,JSON.stringify(spec),spec.operation,saved.item.id,saved.version.version,spec.resourceId,resource.id,JSON.stringify(resource),saved.item.updatedAt])
  return result
 }
 async revise(actor:ResourceActor,input:unknown):Promise<KnowledgeResourceRevision>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const row=exact(input,['requestId','knowledgeId','expectedKnowledgeVersion','resourceId','expectedResourceVersion','markdown'])
  if(!resourceId(row.requestId)||!resourceId(row.knowledgeId)||!resourceVersion(row.expectedKnowledgeVersion)||!resourceId(row.resourceId)||!resourceVersion(row.expectedResourceVersion))throw bad()
  const markdown=normalizePasteMarkdown(row.markdown),spec:ReviseSpec={operation:'revise',knowledgeId:(row.knowledgeId as string).toLowerCase(),expectedKnowledgeVersion:row.expectedKnowledgeVersion as number,resourceId:(row.resourceId as string).toLowerCase(),expectedResourceVersion:row.expectedResourceVersion as number,contentHash:hash(markdown)}
  const value=await this.knowledge.reviseWithTransaction(actor,{requestId:childRequest(row.requestId as string),knowledgeId:spec.knowledgeId,expectedVersion:spec.expectedKnowledgeVersion,markdown},(client,saved)=>this.project(client,actor,(row.requestId as string).toLowerCase(),spec,saved))
  return value.value
 }
 async restore(actor:ResourceActor,input:unknown):Promise<KnowledgeResourceRevision>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const row=exact(input,['requestId','knowledgeId','expectedKnowledgeVersion','resourceId','expectedResourceVersion','restoreVersion'])
  if(!resourceId(row.requestId)||!resourceId(row.knowledgeId)||!resourceVersion(row.expectedKnowledgeVersion)||!resourceId(row.resourceId)||!resourceVersion(row.expectedResourceVersion)||!resourceVersion(row.restoreVersion))throw bad()
  const spec:RestoreSpec={operation:'restore',knowledgeId:(row.knowledgeId as string).toLowerCase(),expectedKnowledgeVersion:row.expectedKnowledgeVersion as number,resourceId:(row.resourceId as string).toLowerCase(),expectedResourceVersion:row.expectedResourceVersion as number,restoreVersion:row.restoreVersion as number}
  const value=await this.knowledge.restoreWithTransaction(actor,{requestId:childRequest(row.requestId as string),knowledgeId:spec.knowledgeId,expectedVersion:spec.expectedKnowledgeVersion,version:spec.restoreVersion},(client,saved)=>this.project(client,actor,(row.requestId as string).toLowerCase(),spec,saved))
  return value.value
 }
}
