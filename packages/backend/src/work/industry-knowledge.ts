import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,isRecord,isResourceSpec,type ResourceDraft,type ResourceSpec,type WorkResource} from '@teloa/contract'
import type {ResourceActor,ResourceSourceCatalog} from '../capabilities/resources.ts'
import type {IndustryLoadService} from './industry-loads.ts'
import type {ResourceService} from '../capabilities/resources.ts'
import {industryReferenceId} from '../capabilities/industry-reference-catalog.ts'

export type IndustryKnowledgeInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;title:string;scope:string;sourceId:string;sourceVersion:string;revision:number;state:'pending'|'active'|'withdrawn'|'failed';resource:WorkResource|null;failure:{code:string;message:string}|null;createdAt:string;updatedAt:string}
export type IndustryKnowledgePage={items:IndustryKnowledgeInstance[]}
type Frozen={loadId:string;itemInstanceId:string;itemLocalId:string;title:string;scope:string;sourceId:string;sourceVersion:string;spec:ResourceSpec;digest:string}
type Stored=Frozen&{id:string;ownerId:string;downstreamRequestId:string;draftId:string|null;draftVersion:number|null;resourceId:string|null;phase:'prepared'|'applying'|'needs-recovery'|'failed';revision:number;failureCode:string|null;failureMessage:string|null;createdAt:string;updatedAt:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const exact=(value:unknown,keys:readonly string[])=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const invalid=()=>new WorkError('teloa/invalid-input','行业知识实例化请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业知识实例化记录损坏，已停止读取。')
const digest=(spec:ResourceSpec)=>createHash('sha256').update(JSON.stringify({title:spec.title,sourceId:spec.sourceId,sourceVersion:spec.sourceVersion,scopeIds:spec.scopeIds})).digest('hex')
const mappingDigest=(value:{id:string;ownerId:string;loadId:string;itemInstanceId:string;downstreamRequestId:string;digest:string})=>createHash('sha256').update(JSON.stringify([value.id.toLowerCase(),value.ownerId,value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.downstreamRequestId.toLowerCase(),value.digest])).digest('hex')
const timestamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const actor=(ownerId:string,scope:string):ResourceActor=>({ownerId,kind:'human',scopeIds:[scope]})
const own=(ownerId:string)=>{if(typeof ownerId!=='string'||!ownerId)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}

export async function initializeIndustryKnowledge(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_industry_knowledge_instances(
  id uuid primary key,owner_id text not null,load_id uuid not null,item_instance_id uuid not null,downstream_request_id uuid not null,
  item_local_id text not null,title text not null,scope text not null,source_id text not null,source_version text not null,spec jsonb not null,digest text not null,mapping_digest text not null,
  draft_id uuid,draft_version integer,resource_id uuid,phase text not null check(phase in ('prepared','applying','needs-recovery','failed')),
  revision integer not null check(revision between 1 and 2147483647),failure_code text,failure_message text,created_at timestamptz not null,updated_at timestamptz not null,
  unique(owner_id,load_id,item_instance_id),check(jsonb_typeof(spec)='object'),check(digest ~ '^[0-9a-f]{64}$'),check(mapping_digest ~ '^[0-9a-f]{64}$'),
  check((draft_id is null and draft_version is null) or (draft_id is not null and draft_version is not null and draft_version>0)),
  check((phase='failed' and failure_code is not null and failure_message is not null) or (phase<>'failed' and failure_code is null and failure_message is null))
 );
 create table if not exists teloa_industry_knowledge_requests(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_knowledge_instances(id),primary key(owner_id,request_id));
 `)}

export class IndustryKnowledgeService{
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly loads:Pick<IndustryLoadService,'get'|'storedItemStatus'>
 private readonly sources:ResourceSourceCatalog
 private readonly resources:Pick<ResourceService,'create'|'apply'|'findDraft'|'getResource'>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},loads:Pick<IndustryLoadService,'get'|'storedItemStatus'>,sources:ResourceSourceCatalog,resources:Pick<ResourceService,'create'|'apply'|'findDraft'|'getResource'>){this.pool=pool;this.identity=identity;this.loads=loads;this.sources=sources;this.resources=resources}
 private stored(row:Record<string,unknown>):Stored{
  try{
   const base={id:row.id as string,ownerId:row.owner_id as string,loadId:row.load_id as string,itemInstanceId:row.item_instance_id as string,downstreamRequestId:row.downstream_request_id as string,digest:row.digest as string},spec=row.spec;if(!isResourceSpec(spec)||!uuid(base.id)||!base.ownerId||!uuid(base.loadId)||!uuid(base.itemInstanceId)||!uuid(base.downstreamRequestId)||typeof row.item_local_id!=='string'||!row.item_local_id||typeof row.title!=='string'||!row.title||typeof row.scope!=='string'||typeof row.source_id!=='string'||typeof row.source_version!=='string'||base.digest!==digest(spec)||row.mapping_digest!==mappingDigest(base)||!['prepared','applying','needs-recovery','failed'].includes(String(row.phase))||!Number.isInteger(row.revision)||(row.revision as number)<1||(row.revision as number)>2147483647||(row.draft_id!==null&&!uuid(row.draft_id))||(row.draft_id===null)!==(row.draft_version===null)||(row.draft_version!==null&&(!Number.isInteger(row.draft_version)||(row.draft_version as number)<1))||(row.resource_id!==null&&!uuid(row.resource_id))||(row.phase==='failed'?(typeof row.failure_code!=='string'||typeof row.failure_message!=='string'):(row.failure_code!==null||row.failure_message!==null)))throw Error()
   return {...base,itemLocalId:row.item_local_id,title:row.title,scope:row.scope,sourceId:row.source_id,sourceVersion:row.source_version,spec,draftId:row.draft_id as string|null,draftVersion:row.draft_version as number|null,resourceId:row.resource_id as string|null,phase:row.phase as Stored['phase'],revision:row.revision as number,failureCode:row.failure_code as string|null,failureMessage:row.failure_message as string|null,createdAt:timestamp(row.created_at),updatedAt:timestamp(row.updated_at)}
  }catch{throw corrupt()}
 }
 private async row(ownerId:string,id:string):Promise<Stored>{const result=(await this.pool.query('select * from teloa_industry_knowledge_instances where id=$1 and owner_id=$2',[id,ownerId])).rows[0];if(!result)throw new WorkError('teloa/forbidden','行业知识实例不存在或不属于当前本人。');return this.stored(result)}
 private fullRequest(value:Stored){return {loadId:value.loadId,itemInstanceId:value.itemInstanceId,downstreamRequestId:value.downstreamRequestId,spec:value.spec,digest:value.digest,mappingDigest:mappingDigest(value)}}
 private receiptTarget(receipt:Record<string,unknown>,request:{loadId:string;itemInstanceId:string}){const saved=receipt.request_spec;if(!isRecord(saved)||Object.keys(saved).length!==6||Object.keys(saved).some(key=>!['loadId','itemInstanceId','downstreamRequestId','spec','digest','mappingDigest'].includes(key))||!uuid(saved.loadId)||!uuid(saved.itemInstanceId)||!uuid(saved.downstreamRequestId)||!isResourceSpec(saved.spec)||typeof saved.digest!=='string'||digest(saved.spec)!==saved.digest||typeof saved.mappingDigest!=='string')throw corrupt();if(saved.loadId!==request.loadId||saved.itemInstanceId!==request.itemInstanceId)throw new WorkError('teloa/conflict','同一实例化请求不能更换加载项。')}
 private verifyReceipt(receipt:Record<string,unknown>,value:Stored,request:{loadId:string;itemInstanceId:string}){const saved=receipt.request_spec;if(receipt.owner_id!==value.ownerId||!isRecord(saved)||saved.loadId!==request.loadId||saved.itemInstanceId!==request.itemInstanceId||saved.loadId!==value.loadId||saved.itemInstanceId!==value.itemInstanceId||saved.downstreamRequestId!==value.downstreamRequestId||saved.digest!==value.digest||saved.mappingDigest!==mappingDigest(value)||!isResourceSpec(saved.spec)||digest(saved.spec)!==value.digest||receipt.instance_id!==value.id)throw corrupt()}
 private async validateFixed(value:Stored){
  const load=await this.loads.get(value.ownerId,{loadId:value.loadId}),item=load.items.find(row=>row.instanceId===value.itemInstanceId)
  if(!item||item.localId!==value.itemLocalId||item.kind!=='knowledge'||await this.loads.storedItemStatus(this.pool,value.ownerId,value.itemInstanceId)!=='pending-adapter'||load.space.scope!==value.scope||value.sourceId!==industryReferenceId(load.id,item.instanceId)||value.title!==item.title||value.digest!==digest({title:value.title,sourceId:value.sourceId,sourceVersion:value.sourceVersion,scopeIds:[value.scope]}))throw corrupt()
 }
 private async project(value:Stored):Promise<IndustryKnowledgeInstance>{
  await this.validateFixed(value)
  const ownerActor=actor(value.ownerId,value.scope),draft=await this.resources.findDraft(ownerActor,{requestId:value.downstreamRequestId})
  if(value.draftId&&!draft)throw corrupt()
  if(draft&&(draft.ownerId!==value.ownerId||draft.requestId!==value.downstreamRequestId||draft.id!==value.draftId&&value.draftId!==null||digest({title:draft.title,sourceId:draft.sourceId,sourceVersion:draft.sourceVersion,scopeIds:draft.scopeIds})!==value.digest||draft.status==='draft'&&draft.version!==1||draft.status==='applied'&&(draft.version!==2||!draft.resourceId)||value.resourceId!==null&&draft.resourceId!==value.resourceId))throw corrupt()
  const resourceId=value.resourceId??draft?.resourceId
  if(resourceId){const resource=await this.resources.getResource(ownerActor,{resourceId});if(resource.ownerId!==value.ownerId||resource.title!==value.title||resource.sourceId!==value.sourceId||resource.sourceVersion!==value.sourceVersion||JSON.stringify(resource.scopeIds)!==JSON.stringify([value.scope]))throw corrupt();return {...this.base(value),state:resource.status,resource,failure:null}}
  if(value.phase==='failed')return {...this.base(value),state:'failed',resource:null,failure:{code:value.failureCode!,message:value.failureMessage!}}
  return {...this.base(value),state:'pending',resource:null,failure:null}
 }
 private base(value:Stored){return {id:value.id,ownerId:value.ownerId,loadId:value.loadId,itemInstanceId:value.itemInstanceId,itemLocalId:value.itemLocalId,title:value.title,scope:value.scope,sourceId:value.sourceId,sourceVersion:value.sourceVersion,revision:value.revision,createdAt:value.createdAt,updatedAt:value.updatedAt}}
 private async update(value:Stored,fields:{phase:Stored['phase'];draft?:ResourceDraft;resourceId?:string;failure?:{code:string;message:string}}):Promise<Stored>{
  const now=this.identity.now(),result=await this.pool.query(`update teloa_industry_knowledge_instances set phase=$3,draft_id=coalesce($4,draft_id),draft_version=coalesce($5,draft_version),resource_id=coalesce($6,resource_id),failure_code=$7,failure_message=$8,revision=revision+1,updated_at=$9 where id=$1 and owner_id=$2 and revision=$10 and revision<2147483647 returning *`,[value.id,value.ownerId,fields.phase,fields.draft?.id??null,fields.draft?.version??null,fields.resourceId??null,fields.failure?.code??null,fields.failure?.message??null,now,value.revision])
  return result.rows[0]?this.stored(result.rows[0]):this.row(value.ownerId,value.id)
 }
 private async coordinate(value:Stored):Promise<IndustryKnowledgeInstance>{
  const ownerActor=actor(value.ownerId,value.scope)
  try{
   await this.validateFixed(value)
   if(value.resourceId)return this.project(value)
   let draft=value.draftId?await this.resources.findDraft(ownerActor,{requestId:value.downstreamRequestId}):null
   if(value.draftId&&!draft)throw corrupt()
   draft??=await this.resources.create(ownerActor,{requestId:value.downstreamRequestId,...value.spec})
   if(value.draftId&&value.draftId!==draft.id)throw corrupt()
   if(draft.ownerId!==value.ownerId||draft.requestId!==value.downstreamRequestId||digest({title:draft.title,sourceId:draft.sourceId,sourceVersion:draft.sourceVersion,scopeIds:draft.scopeIds})!==value.digest||draft.status==='draft'&&draft.version!==1||draft.status==='applied'&&(draft.version!==2||!draft.resourceId))throw corrupt()
   value=await this.update(value,{phase:'applying',draft})
   let resource:WorkResource
   if(draft.status==='applied')resource=await this.resources.getResource(ownerActor,{resourceId:draft.resourceId!})
   else resource=await this.resources.apply(ownerActor,{draftId:draft.id,expectedVersion:draft.version})
   value=await this.update(value,{phase:'applying',draft,resourceId:resource.id})
   return this.project(value)
  }catch(error){
   if(error instanceof WorkError&&error.code==='teloa/source-unavailable'){value=await this.update(value,{phase:'failed',failure:{code:error.code,message:error.message}});return this.project(value)}
   if(error instanceof WorkError&&!['teloa/storage-unavailable','teloa/cancelled'].includes(error.code))throw error
   value=await this.update(value,{phase:'needs-recovery'});try{return await this.project(value)}catch(probe){if(probe instanceof WorkError&&['teloa/storage-unavailable','teloa/cancelled'].includes(probe.code))return {...this.base(value),state:'pending',resource:null,failure:null};throw probe}
  }
 }
 async instantiate(ownerId:string,input:unknown):Promise<IndustryKnowledgeInstance>{
  own(ownerId);const data=exact(input,['requestId','loadId','itemInstanceId']);if(!uuid(data.requestId)||!uuid(data.loadId)||!uuid(data.itemInstanceId))throw invalid()
  const requestSpec={loadId:data.loadId.toLowerCase(),itemInstanceId:data.itemInstanceId.toLowerCase()}
  const prior=(await this.pool.query('select * from teloa_industry_knowledge_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId])).rows[0]
  if(prior){this.receiptTarget(prior,requestSpec);if(!uuid(prior.instance_id))throw corrupt();let value:Stored;try{value=await this.row(ownerId,prior.instance_id)}catch{throw corrupt()}this.verifyReceipt(prior,value,requestSpec);return this.coordinate(value)}
  const load=await this.loads.get(ownerId,{loadId:requestSpec.loadId}),item=load.items.find(row=>row.instanceId.toLowerCase()===requestSpec.itemInstanceId)
  if(!item||item.kind!=='knowledge'||await this.loads.storedItemStatus(this.pool,ownerId,item.instanceId)!=='pending-adapter')throw new WorkError('teloa/conflict','目标不是可实例化的行业知识。')
  const existing=(await this.pool.query('select * from teloa_industry_knowledge_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[ownerId,requestSpec.loadId,requestSpec.itemInstanceId])).rows[0]
  if(existing){const value=this.stored(existing),saved=this.fullRequest(value);await this.pool.query('insert into teloa_industry_knowledge_requests(owner_id,request_id,request_spec,instance_id) values($1,$2,$3,$4) on conflict(owner_id,request_id) do nothing',[ownerId,data.requestId,JSON.stringify(saved),value.id]);const receipt=(await this.pool.query('select * from teloa_industry_knowledge_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId])).rows[0];this.receiptTarget(receipt,requestSpec);this.verifyReceipt(receipt,value,requestSpec);return this.coordinate(value)}
  const scope=load.space.scope;const sourceId=industryReferenceId(load.id,item.instanceId),ownerActor=actor(ownerId,scope),reference=(await this.sources.list({actor:ownerActor})).references.find(row=>row.id===sourceId);if(!reference)throw new WorkError('teloa/source-unavailable','行业知识固定来源当前不可用。')
  const spec:ResourceSpec={title:item.title,sourceId,sourceVersion:reference.version,scopeIds:[scope]},frozen:Frozen={...requestSpec,itemLocalId:item.localId,title:item.title,scope,sourceId,sourceVersion:reference.version,spec,digest:digest(spec)}
  const client=await this.pool.connect();let value:Stored
  try{await client.query('begin');await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-knowledge-request',ownerId,data.requestId])]);await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['industry-knowledge-item',ownerId,frozen.loadId,frozen.itemInstanceId])])
   const receipt=(await client.query('select * from teloa_industry_knowledge_requests where owner_id=$1 and request_id=$2',[ownerId,data.requestId])).rows[0]
   if(receipt){this.receiptTarget(receipt,requestSpec);value=this.stored((await client.query('select * from teloa_industry_knowledge_instances where id=$1 and owner_id=$2',[receipt.instance_id,ownerId])).rows[0]);this.verifyReceipt(receipt,value,requestSpec)}
   else{let saved=(await client.query('select * from teloa_industry_knowledge_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[ownerId,frozen.loadId,frozen.itemInstanceId])).rows[0];if(!saved){const id=this.identity.id(),downstream=this.identity.id(),now=this.identity.now();if(!uuid(id)||!uuid(downstream)||!Number.isFinite(Date.parse(now)))throw invalid();const mapping=mappingDigest({id,ownerId,loadId:frozen.loadId,itemInstanceId:frozen.itemInstanceId,downstreamRequestId:downstream,digest:frozen.digest});saved=(await client.query(`insert into teloa_industry_knowledge_instances(id,owner_id,load_id,item_instance_id,downstream_request_id,item_local_id,title,scope,source_id,source_version,spec,digest,mapping_digest,draft_id,draft_version,resource_id,phase,revision,failure_code,failure_message,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,null,null,null,'prepared',1,null,null,$14,$14) returning *`,[id,ownerId,frozen.loadId,frozen.itemInstanceId,downstream,frozen.itemLocalId,frozen.title,frozen.scope,frozen.sourceId,frozen.sourceVersion,JSON.stringify(frozen.spec),frozen.digest,mapping,now])).rows[0]}value=this.stored(saved);await client.query('insert into teloa_industry_knowledge_requests values($1,$2,$3,$4)',[ownerId,data.requestId,JSON.stringify(this.fullRequest(value)),value.id])}
   await client.query('commit')
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
  return this.coordinate(value)
 }
 async get(ownerId:string,input:unknown):Promise<IndustryKnowledgeInstance>{own(ownerId);const data=exact(input,['instanceId']);if(!uuid(data.instanceId))throw invalid();return this.project(await this.row(ownerId,data.instanceId))}
 async list(ownerId:string,input:unknown):Promise<IndustryKnowledgePage>{own(ownerId);exact(input,[]);const rows=(await this.pool.query('select * from teloa_industry_knowledge_instances where owner_id=$1 order by created_at,id',[ownerId])).rows,items=[];for(const row of rows)items.push(await this.project(this.stored(row)));return {items}}
}

/**
 * 供业务空间迁移重算存量行上的两个派生列：`digest` 由固定 `spec`（含 `scopeIds`）算出，
 * `mapping_digest` 再由 `digest` 算出。迁移改写范围取值后必须按同一份算法回填，因此这里导出而不是各算一份。
 */
export const industryKnowledgeDigests={spec:digest,mapping:mappingDigest}
