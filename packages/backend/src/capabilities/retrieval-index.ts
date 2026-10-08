import {endianness} from 'node:os'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,isResourceSpec,readRetrievalSearchResult,resourceScopes,retrievalLimits,type ResourceSpec,type RetrievalCoverage,type RetrievalSearchResult} from '@teloa/contract'
import {authorizeResourceActor,type ResourceActor,type ResourceService} from './resources.ts'
import {chunkRetrievalText,retrievalChunker,type RetrievalChunk} from './retrieval-chunker.ts'
import {rankRetrievalVectors,type RankedIndex} from './retrieval-ranking.ts'

/**
 * 端侧中文检索索引（规格 §6）。
 *
 * 向量与资料元数据同存 PostgreSQL，不存分块正文：命中后经 `ResourceService.readExcerptsInTransaction`
 * 按原文区间回读。每次检索都在同一事务内重新核对主体、范围、启用状态、资料版本、加入记录与索引绑定
 * （本人、资源版本、正文版本、范围、profileHash、分块器）；撤回、改版、移出在提交后的下一次检索即生效。
 * 内存只缓存只读向量，授权过滤从不走缓存。
 */
export type Embedder={profileHash:string;embed(kind:'query'|'passage',texts:string[],signal:AbortSignal):Promise<Float32Array[]>}
export type RetrievalIndexState='ready'|'building'|'failed'|'stale'|'unavailable'
/** `unavailable`：已加入但当前没有启用版本（只对本人列出，便于移出）。`stale`：当前版本在当前配置下尚无索引。 */
export type RetrievalStatusItem={sourceId:string;resourceId:string|null;title:string|null;version:number|null;state:RetrievalIndexState;chunkCount:number|null}
/** `enrolled`/`chunks` 是本人全量计数，只回给本人主体。 */
export type RetrievalStatus={items:RetrievalStatusItem[];enrolled?:number;chunks?:number}

export const retrievalCoverageNote='仅检索已加入本地检索且当前会话有权读取的资料，不是全部资料。'
export const retrievalVectorCacheBytes=128*1024*1024
const batchSize=32
const defaultLimit=5
const dimensions=retrievalLimits.dimensions

export async function initializeRetrievalIndex(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_retrieval_enrollments(
  owner_id text not null check(char_length(owner_id)>0),
  source_id text not null check(source_id ~ '^[a-zA-Z0-9_-]{1,128}$'),
  created_at timestamptz not null,
  primary key(owner_id,source_id)
 );
 create table if not exists teloa_retrieval_indexes(
  id uuid primary key,owner_id text not null,resource_id uuid not null references teloa_resources(id),
  resource_version integer not null check(resource_version>0),source_id text not null,
  source_version text not null check(source_version ~ '^[a-f0-9]{64}$'),
  scope_ids jsonb not null check(jsonb_typeof(scope_ids)='array' and jsonb_array_length(scope_ids)>0),
  profile_hash text not null check(profile_hash ~ '^[a-f0-9]{64}$'),
  chunker text not null check(char_length(chunker) between 1 and 200),
  state text not null check(state in ('building','ready','failed')),
  chunk_count integer not null check(chunk_count between 0 and ${retrievalLimits.maxChunks}),
  failure jsonb,created_at timestamptz not null,
  unique(owner_id,resource_id,resource_version,profile_hash,chunker),
  foreign key(owner_id,source_id) references teloa_retrieval_enrollments(owner_id,source_id) on delete cascade,
  check((state='failed' and failure is not null and jsonb_typeof(failure)='object') or (state<>'failed' and failure is null))
 );
 create index if not exists teloa_retrieval_indexes_owner_profile on teloa_retrieval_indexes(owner_id,profile_hash);
 create index if not exists teloa_retrieval_indexes_resource on teloa_retrieval_indexes(resource_id);
 create table if not exists teloa_retrieval_chunks(
  index_id uuid not null references teloa_retrieval_indexes(id) on delete cascade,
  ordinal integer not null check(ordinal>=0),
  start_char integer not null check(start_char>=0),end_char integer not null check(end_char>start_char),
  start_line integer not null check(start_line>=0),end_line integer not null check(end_line>=start_line),
  heading text check(heading is null or char_length(heading) between 1 and 200),
  text_sha256 text not null check(text_sha256 ~ '^[a-f0-9]{64}$'),
  vector bytea not null check(octet_length(vector)=${retrievalLimits.vectorBytes}),
  primary key(index_id,ordinal)
 );
 create index if not exists teloa_retrieval_chunks_text on teloa_retrieval_chunks(text_sha256);
`)}

export type CachedIndex=RankedIndex

/** 按 `index_id` 缓存只读向量；就绪索引的分块不再变化（改版即新索引），缓存只省读库，不参与授权。 */
export class RetrievalVectorCache{
 private readonly limit:number
 private readonly entries=new Map<string,{value:CachedIndex;bytes:number}>()
 private used=0
 constructor(limit=retrievalVectorCacheBytes){this.limit=limit}
 get bytes(){return this.used}
 get(id:string):CachedIndex|undefined{
  const entry=this.entries.get(id)
  if(!entry)return undefined
  this.entries.delete(id);this.entries.set(id,entry)
  return entry.value
 }
 set(id:string,value:CachedIndex):void{
  this.delete(id)
  // 每块元数据按 96 B 估，标题路径（≤200 字）按 UTF-16 另计（审查 LOW-1）。
  const bytes=value.vectors.byteLength+value.norms.byteLength+value.chunks.reduce((sum,chunk)=>sum+96+(chunk.heading?.length??0)*2,0)
  if(bytes>this.limit)return
  this.entries.set(id,{value,bytes});this.used+=bytes
  for(const key of this.entries.keys()){if(this.used<=this.limit)break;this.delete(key)}
 }
 delete(id:string):void{const entry=this.entries.get(id);if(entry){this.entries.delete(id);this.used-=entry.bytes}}
}

const bad=(message='本地检索请求格式不正确或包含未知字段。')=>new WorkError('teloa/invalid-input',message)
const corrupt=()=>new WorkError('teloa/storage-corrupt','本地检索索引记录损坏，已停止读取。')
const cancelled=()=>new WorkError('teloa/cancelled','本地检索操作已取消。')
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const hex64=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const littleEndian=endianness()==='LE'
const checkAbort=(signal:AbortSignal)=>{if(signal.aborted)throw cancelled()}
const yieldTurn=()=>new Promise<void>(resolve=>setImmediate(resolve))

function exact(input:unknown,keys:string[]):Record<string,unknown>{if(!isRecord(input)||Object.keys(input).some(key=>!keys.includes(key)))throw bad();return input}
function sourceIds(input:unknown):string[]{
 const ids=exact(input,['sourceIds']).sourceIds
 if(!Array.isArray(ids)||ids.length<1||ids.length>retrievalLimits.maxEnrollments||!ids.every(stableId)||new Set(ids).size!==ids.length)throw bad()
 return ids
}
function profile(embedder:Embedder):string{if(!isRecord(embedder)||!hex64(embedder.profileHash)||typeof embedder.embed!=='function')throw bad('本地检索模型配置摘要不正确。');return embedder.profileHash}
const within=(scopes:string[],allowed:readonly string[])=>scopes.every(scope=>allowed.includes(scope))
/** 仅接受执行服务固定的资料许可；null沿原范围，空数组没有资料候选。 */
function permittedKnowledgeIds(input:readonly string[]|null):string[]|null{
 if(input===null)return null
 if(!Array.isArray(input)||!input.every(id=>typeof id==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(id)))throw bad('本次检索资料许可不正确。')
 const ids=input.map(id=>id.toLowerCase())
 if(new Set(ids).size!==ids.length)throw bad('本次检索资料许可不能重复。')
 return ids
}

function encode(vector:Float32Array):Buffer{
 const buffer=Buffer.alloc(retrievalLimits.vectorBytes),view=new DataView(buffer.buffer,buffer.byteOffset,buffer.byteLength)
 for(let index=0;index<dimensions;index++)view.setFloat32(index*4,vector[index]!,true)
 return buffer
}

/** 候选行：本人已加入、当前启用的资料，连同当前绑定（配置摘要 + 分块器）下的索引。 */
type Candidate={resourceId:string;version:number;spec:ResourceSpec;indexId:string|null;state:'building'|'ready'|'failed'|null;chunkCount:number|null}
function candidate(row:Record<string,unknown>):Candidate{
 if(typeof row.id!=='string'||!Number.isSafeInteger(row.revision)||!isResourceSpec(row.spec))throw corrupt()
 const spec=row.spec
 if(row.index_id!==null&&(typeof row.index_id!=='string'||!['building','ready','failed'].includes(String(row.state))||!Number.isSafeInteger(row.chunk_count)))throw corrupt()
 return {resourceId:row.id,version:row.revision as number,spec:{title:spec.title,sourceId:spec.sourceId,sourceVersion:spec.sourceVersion,scopeIds:[...spec.scopeIds]},indexId:row.index_id as string|null,state:row.index_id===null?null:row.state as Candidate['state'],chunkCount:row.index_id===null?null:row.chunk_count as number}
}
const candidateSql=(lock:boolean)=>`
 select r.id,r.revision,r.spec,i.id as index_id,i.state,i.chunk_count
 from teloa_retrieval_enrollments e
 join teloa_resources r on r.owner_id=e.owner_id and r.status='active' and r.spec->>'sourceId'=e.source_id
 left join teloa_retrieval_indexes i on i.owner_id=r.owner_id and i.resource_id=r.id and i.resource_version=r.revision
  and i.source_id=e.source_id and i.source_version=r.spec->>'sourceVersion' and i.scope_ids=r.spec->'scopeIds'
  and i.profile_hash=$2 and i.chunker=$3
 where e.owner_id=$1 and ($4::uuid[] is null or r.id=any($4::uuid[])) order by r.id${lock?' for share of r':''}`

export class RetrievalIndexService{
 private readonly pool:Pool
 private readonly resources:ResourceService
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly cache=new RetrievalVectorCache()
 constructor(pool:Pool,resources:ResourceService,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.resources=resources;this.identity=identity}
 private async tx<T>(operation:(client:PoolClient)=>Promise<T>):Promise<T>{
  const client=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','本地检索数据库暂不可用。')})
  try{await client.query('begin');const value=await operation(client);await client.query('commit');return value}
  catch(error){await client.query('rollback').catch(()=>{});if(error instanceof WorkError)throw error;throw new WorkError('teloa/storage-unavailable','本地检索事务未完成，请检查数据库连接与结构。')}
  finally{client.release()}
 }
 private lockOwner(client:PoolClient,ownerId:string){return client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['retrieval-index',ownerId])])}
 private async candidates(client:PoolClient,ownerId:string,profileHash:string|null,lock=false,knowledgeIds:readonly string[]|null=null):Promise<Candidate[]>{
  return (await client.query(candidateSql(lock),[ownerId,profileHash,retrievalChunker,knowledgeIds])).rows.map(candidate)
 }
 private async embed(embedder:Embedder,kind:'query'|'passage',texts:string[],signal:AbortSignal):Promise<Float32Array[]>{
  let vectors:unknown
  try{vectors=await embedder.embed(kind,texts,signal)}
  catch(error){if(signal.aborted)throw cancelled();if(error instanceof WorkError)throw error;throw new WorkError('teloa/dependency-unavailable','本地检索模型暂不可用。')}
  if(!Array.isArray(vectors)||vectors.length!==texts.length||!vectors.every(vector=>vector instanceof Float32Array&&vector.length===dimensions&&vector.every(Number.isFinite)))throw new WorkError('teloa/dependency-unavailable','本地检索模型返回的向量格式不正确，已停止写入。')
  return vectors as Float32Array[]
 }

 /** 逐份显式加入（规格 §6.2）：只接受本人主体，来源须有本人可见的启用资料，每人最多 500 份。 */
 async enroll(actor:ResourceActor,input:unknown):Promise<void>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const ids=sourceIds(input)
  await this.tx(async client=>{
   await this.lockOwner(client,actor.ownerId)
   const visible=new Set((await client.query(`select spec->>'sourceId' as source_id,spec->'scopeIds' as scope_ids from teloa_resources where owner_id=$1 and status='active' and spec->>'sourceId'=any($2::text[])`,[actor.ownerId,ids])).rows
    .filter(row=>resourceScopes(row.scope_ids)&&within(row.scope_ids,actor.scopeIds)).map(row=>row.source_id as string))
   if(ids.some(id=>!visible.has(id)))throw new WorkError('teloa/not-found','资料不存在或当前无权加入本地检索。')
   const existing=(await client.query('select source_id from teloa_retrieval_enrollments where owner_id=$1',[actor.ownerId])).rows.map(row=>row.source_id as string)
   if(new Set([...existing,...ids]).size>retrievalLimits.maxEnrollments)throw bad('每人最多加入 500 份资料到本地检索。')
   await client.query('insert into teloa_retrieval_enrollments(owner_id,source_id,created_at) select $1::text,unnest($2::text[]),$3::timestamptz on conflict do nothing',[actor.ownerId,ids,this.identity.now()])
  })
 }

 /** 移出检索：同一事务内删除加入记录、索引与向量（外键级联）。 */
 async remove(actor:ResourceActor,input:unknown):Promise<void>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const ids=sourceIds(input)
  const removed=await this.tx(async client=>{
   await this.lockOwner(client,actor.ownerId)
   const indexes=(await client.query('delete from teloa_retrieval_indexes where owner_id=$1 and source_id=any($2::text[]) returning id',[actor.ownerId,ids])).rows.map(row=>row.id as string)
   await client.query('delete from teloa_retrieval_enrollments where owner_id=$1 and source_id=any($2::text[])',[actor.ownerId,ids])
   return indexes
  })
  for(const id of removed)this.cache.delete(id)
 }

 /** `profileHash` 为 null（模型配置未知）时没有可用索引，已加入的启用资料一律为 stale。 */
 async status(actor:ResourceActor,profileHash:string|null,knowledgeIds:readonly string[]|null=null):Promise<RetrievalStatus>{
  authorizeResourceActor(actor)
  if(profileHash!==null&&!hex64(profileHash))throw bad('本地检索模型配置摘要不正确。')
  const permitted=permittedKnowledgeIds(knowledgeIds)
  return this.tx(async client=>{
   const rows=(await this.candidates(client,actor.ownerId,profileHash,false,permitted)).filter(row=>within(row.spec.scopeIds,actor.scopeIds))
   const items:RetrievalStatusItem[]=rows.map(row=>({sourceId:row.spec.sourceId,resourceId:row.resourceId,title:row.spec.title,version:row.version,state:row.state??'stale',chunkCount:row.chunkCount}))
   if(actor.kind!=='human'||permitted!==null)return {items}
   const enrolled=(await client.query('select source_id from teloa_retrieval_enrollments where owner_id=$1 order by source_id',[actor.ownerId])).rows.map(row=>row.source_id as string)
   const active=new Set((await client.query(`select distinct spec->>'sourceId' as source_id from teloa_resources where owner_id=$1 and status='active'`,[actor.ownerId])).rows.map(row=>row.source_id as string))
   for(const sourceId of enrolled)if(!active.has(sourceId))items.push({sourceId,resourceId:null,title:null,version:null,state:'unavailable',chunkCount:null})
   const chunks=profileHash===null?0:await this.validChunkCount(client,actor.ownerId,profileHash,null)
   return {items,enrolled:enrolled.length,chunks}
  })
 }

 /** 当前绑定仍有效、未失败的索引块数之和（本人级 5 万块上限的计数口径）。 */
 private async validChunkCount(client:PoolClient,ownerId:string,profileHash:string,except:string|null):Promise<number>{
  return (await client.query(`
   select coalesce(sum(i.chunk_count),0)::int as total from teloa_retrieval_indexes i
   join teloa_resources r on r.id=i.resource_id and r.owner_id=i.owner_id and r.status='active' and r.revision=i.resource_version
    and r.spec->>'sourceId'=i.source_id and r.spec->>'sourceVersion'=i.source_version and r.spec->'scopeIds'=i.scope_ids
   where i.owner_id=$1 and i.profile_hash=$2 and i.chunker=$3 and i.state<>'failed' and ($4::uuid is null or i.id<>$4::uuid)`,[ownerId,profileHash,retrievalChunker,except])).rows[0].total as number
 }

 /**
  * 逐份建索引：每次只提交一个不超过 32 块的批并让出；按 (本人, profileHash, text_sha256) 复用已有向量，
  * 只为新增或变更的分块推理。取消在批间生效，已提交的批留给下次续建复用。失败的资料不在每次任务中反复重试，
  * `retryFailed` 为真时（重建请求）才重新建。结束后清理本人的失效索引。
  */
 async buildPending(actor:ResourceActor,embedder:Embedder,signal:AbortSignal,options:{retryFailed?:boolean}={}):Promise<{ready:number;failed:number}>{
  authorizeResourceActor(actor,actor.ownerId,[],true)
  const profileHash=profile(embedder)
  checkAbort(signal)
  const targets=(await this.tx(client=>this.candidates(client,actor.ownerId,profileHash)))
   .filter(row=>within(row.spec.scopeIds,actor.scopeIds)&&row.state!=='ready'&&(row.state!=='failed'||options.retryFailed===true))
  let ready=0,failed=0
  for(const target of targets){
   checkAbort(signal)
   const outcome=await this.buildOne(actor,embedder,profileHash,target,signal)
   if(outcome==='ready')ready++
   if(outcome==='failed')failed++
  }
  await this.purge(actor.ownerId,profileHash)
  return {ready,failed}
 }

 private async fail(ownerId:string,target:Candidate,profileHash:string,error:WorkError):Promise<void>{
  await this.tx(async client=>{
   const indexes=(await client.query('delete from teloa_retrieval_indexes where owner_id=$1 and resource_id=$2 and resource_version=$3 and profile_hash=$4 and chunker=$5 returning id',[ownerId,target.resourceId,target.version,profileHash,retrievalChunker])).rows
   for(const row of indexes)this.cache.delete(row.id as string)
   await client.query(`insert into teloa_retrieval_indexes(id,owner_id,resource_id,resource_version,source_id,source_version,scope_ids,profile_hash,chunker,state,chunk_count,failure,created_at)
    select $1::uuid,$2::text,$3::uuid,$4::int,$5::text,$6::text,$7::jsonb,$8::text,$9::text,'failed',0,$10::jsonb,$11::timestamptz where exists(select 1 from teloa_retrieval_enrollments where owner_id=$2::text and source_id=$5::text)`,
   [this.identity.id(),ownerId,target.resourceId,target.version,target.spec.sourceId,target.spec.sourceVersion,JSON.stringify(target.spec.scopeIds),profileHash,retrievalChunker,JSON.stringify({code:error.code,message:error.message}),this.identity.now()])
  })
 }

 private async buildOne(actor:ResourceActor,embedder:Embedder,profileHash:string,target:Candidate,signal:AbortSignal):Promise<'ready'|'failed'|'skipped'>{
  const prepared=await this.tx(async client=>{
   await this.lockOwner(client,actor.ownerId)
   let read:{text:string;version:number;sourceVersion:string}
   try{
    const value=await this.resources.readForIndexInTransaction(client,actor,target.resourceId)
    read={text:value.text,version:value.resource.version,sourceVersion:value.resource.sourceVersion}
   }catch(error){
    if(!(error instanceof WorkError)||['teloa/storage-unavailable','teloa/storage-corrupt'].includes(error.code))throw error
    // 来源暂不可读（瞬时文件错误）只跳过，下次任务自动重试（审查 LOW-2）；超限与版本冲突记为 failed，须本人重建。
    return {skip:!['teloa/invalid-input','teloa/version-conflict'].includes(error.code),error}
   }
   if(read.version!==target.version||read.sourceVersion!==target.spec.sourceVersion)return {skip:true}
   const chunks=chunkRetrievalText(read.text)
   const current=(await client.query('select id,state,chunk_count from teloa_retrieval_indexes where owner_id=$1 and resource_id=$2 and resource_version=$3 and profile_hash=$4 and chunker=$5 for update',[actor.ownerId,target.resourceId,target.version,profileHash,retrievalChunker])).rows[0] as Record<string,unknown>|undefined
   if(current?.state==='ready')return {skip:true}
   if(current&&(current.state==='failed'||current.chunk_count!==chunks.length)){await client.query('delete from teloa_retrieval_indexes where id=$1',[current.id]);this.cache.delete(current.id as string)}
   const reuse=current&&current.state==='building'&&current.chunk_count===chunks.length?current.id as string:null
   if(chunks.length+await this.validChunkCount(client,actor.ownerId,profileHash,reuse)>retrievalLimits.maxChunks)return {skip:false,error:bad('本地检索总分块超过 50,000，请先移出部分资料。')}
   const indexId=reuse??this.identity.id()
   if(!reuse)await client.query(`insert into teloa_retrieval_indexes(id,owner_id,resource_id,resource_version,source_id,source_version,scope_ids,profile_hash,chunker,state,chunk_count,failure,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,'building',$10,null,$11)`,
    [indexId,actor.ownerId,target.resourceId,target.version,target.spec.sourceId,target.spec.sourceVersion,JSON.stringify(target.spec.scopeIds),profileHash,retrievalChunker,chunks.length,this.identity.now()])
   const written=new Set((await client.query('select ordinal from teloa_retrieval_chunks where index_id=$1',[indexId])).rows.map(row=>row.ordinal as number))
   return {indexId,chunks:chunks.filter(chunk=>!written.has(chunk.ordinal))}
  })
  if('skip' in prepared){
   if(prepared.skip||!prepared.error)return 'skipped'
   await this.fail(actor.ownerId,target,profileHash,prepared.error)
   return 'failed'
  }
  for(let offset=0;offset<prepared.chunks.length;offset+=batchSize){
   checkAbort(signal)
   if(!await this.writeBatch(actor.ownerId,profileHash,prepared.indexId,prepared.chunks.slice(offset,offset+batchSize),embedder,signal))return 'skipped'
   await yieldTurn()
  }
  const done=await this.tx(async client=>(await client.query(`update teloa_retrieval_indexes set state='ready' where id=$1 and state='building' and chunk_count=(select count(*) from teloa_retrieval_chunks where index_id=$1)`,[prepared.indexId])).rowCount===1)
  return done?'ready':'skipped'
 }

 private async writeBatch(ownerId:string,profileHash:string,indexId:string,batch:RetrievalChunk[],embedder:Embedder,signal:AbortSignal):Promise<boolean>{
  const hashes=[...new Set(batch.map(chunk=>chunk.textSha256))]
  const vectors=new Map<string,Buffer>()
  await this.tx(async client=>{
   for(const row of (await client.query(`select distinct on (c.text_sha256) c.text_sha256,c.vector from teloa_retrieval_chunks c join teloa_retrieval_indexes i on i.id=c.index_id
    where i.owner_id=$1 and i.profile_hash=$2 and c.text_sha256=any($3::text[])`,[ownerId,profileHash,hashes])).rows){
    if(!Buffer.isBuffer(row.vector)||row.vector.byteLength!==retrievalLimits.vectorBytes)throw corrupt()
    vectors.set(row.text_sha256 as string,row.vector)
   }
  })
  const missing=hashes.filter(hash=>!vectors.has(hash)).map(hash=>batch.find(chunk=>chunk.textSha256===hash)!)
  if(missing.length){
   const embedded=await this.embed(embedder,'passage',missing.map(chunk=>chunk.text),signal)
   missing.forEach((chunk,index)=>vectors.set(chunk.textSha256,encode(embedded[index]!)))
  }
  return this.tx(async client=>{
   const index=(await client.query('select state from teloa_retrieval_indexes where id=$1 for update',[indexId])).rows[0]
   if(index?.state!=='building')return false
   await client.query(`insert into teloa_retrieval_chunks(index_id,ordinal,start_char,end_char,start_line,end_line,heading,text_sha256,vector)
    select $1::uuid,* from unnest($2::int[],$3::int[],$4::int[],$5::int[],$6::int[],$7::text[],$8::text[],$9::bytea[]) on conflict do nothing`,
   [indexId,batch.map(chunk=>chunk.ordinal),batch.map(chunk=>chunk.start),batch.map(chunk=>chunk.end),batch.map(chunk=>chunk.startLine),batch.map(chunk=>chunk.endLine),batch.map(chunk=>chunk.heading),batch.map(chunk=>chunk.textSha256),batch.map(chunk=>vectors.get(chunk.textSha256)!)])
   return true
  })
 }

 /** 物理清理失效绑定与旧配置未完成索引；合法的旧配置就绪索引保留，切回时可复用。 */
 private async purge(ownerId:string|null,profileHash:string|null):Promise<number>{
  const rows=await this.tx(async client=>(await client.query(`
   delete from teloa_retrieval_indexes i
   where ($1::text is null or i.owner_id=$1) and (i.chunker<>$2 or ($3::text is not null and i.profile_hash<>$3 and i.state<>'ready')
    or not exists(select 1 from teloa_resources r where r.id=i.resource_id and r.owner_id=i.owner_id and r.status='active' and r.revision=i.resource_version
     and r.spec->>'sourceId'=i.source_id and r.spec->>'sourceVersion'=i.source_version and r.spec->'scopeIds'=i.scope_ids))
   returning i.id`,[ownerId,retrievalChunker,profileHash])).rows)
  for(const row of rows)this.cache.delete(row.id as string)
  return rows.length
 }

 /** 宿主启动时的对账：清理全部本人的失效绑定；给出当前配置摘要时一并清理其他配置的未完成索引。 */
 async reconcile(profileHash?:string):Promise<{removed:number}>{
  if(profileHash!==undefined&&!hex64(profileHash))throw bad('本地检索模型配置摘要不正确。')
  return {removed:await this.purge(null,profileHash??null)}
 }

 private async vectors(client:PoolClient,indexes:{id:string;chunkCount:number}[]):Promise<Map<string,CachedIndex>>{
  const loaded=new Map<string,CachedIndex>(),missing:typeof indexes=[]
  for(const index of indexes){const cached=this.cache.get(index.id);if(cached&&cached.chunks.length===index.chunkCount)loaded.set(index.id,cached);else missing.push(index)}
  if(!missing.length)return loaded
  const rows=(await client.query('select index_id,ordinal,start_char,end_char,start_line,end_line,heading,vector from teloa_retrieval_chunks where index_id=any($1::uuid[]) order by index_id,ordinal',[missing.map(index=>index.id)])).rows
  const grouped=new Map<string,Record<string,unknown>[]>()
  for(const row of rows){const list=grouped.get(row.index_id as string)??[];list.push(row);grouped.set(row.index_id as string,list)}
  for(const index of missing){
   const list=grouped.get(index.id)??[]
   if(list.length!==index.chunkCount)throw corrupt()
   const value:CachedIndex={vectors:new Float32Array(list.length*dimensions),norms:new Float32Array(list.length),chunks:[]}
   list.forEach((row,position)=>{
    const vector=row.vector
    if(row.ordinal!==position||!Buffer.isBuffer(vector)||vector.byteLength!==retrievalLimits.vectorBytes)throw corrupt()
    if(littleEndian)new Uint8Array(value.vectors.buffer,position*retrievalLimits.vectorBytes,retrievalLimits.vectorBytes).set(vector)
    else for(let d=0;d<dimensions;d++)value.vectors[position*dimensions+d]=vector.readFloatLE(d*4)
    let norm=0
    for(let d=0;d<dimensions;d++){const x=value.vectors[position*dimensions+d]!;norm+=x*x}
    value.norms[position]=Math.sqrt(norm)
    value.chunks.push({ordinal:position,start:row.start_char as number,end:row.end_char as number,startLine:row.start_line as number,endLine:row.end_line as number,heading:row.heading as string|null})
   })
   this.cache.set(index.id,value);loaded.set(index.id,value)
  }
  return loaded
 }

 /**
  * 检索（规格 §7.1 的后端部分）：检索集为本人已加入、当前启用、范围同时属于主体与目标范围、
  * 当前绑定下索引就绪的资料。暴力余弦取 top-K，再在同一事务内经 ResourceService 回读有界摘录。
  * 范围外资料既不进入 searched 也不进入 pending。
  */
 async search(actor:ResourceActor,targetScopes:string[],input:unknown,embedder:Embedder,signal:AbortSignal,knowledgeIds:readonly string[]|null=null):Promise<RetrievalSearchResult>{
  authorizeResourceActor(actor)
  // limit 只认缺省（undefined）：null 不是缺省，按格式错误拒绝（审查 LOW-3）。
  const row=exact(input,['query','limit']),query=row.query,limit=row.limit===undefined?defaultLimit:row.limit
  if(!resourceScopes(targetScopes)||typeof query!=='string'||!query.trim()||[...query].length>retrievalLimits.maxQueryChars||typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>retrievalLimits.maxResults)throw bad()
  profile(embedder)
  checkAbort(signal)
  const permitted=permittedKnowledgeIds(knowledgeIds)
  const visible=(rows:Candidate[])=>rows.filter(row=>within(row.spec.scopeIds,actor.scopeIds)&&within(row.spec.scopeIds,targetScopes))
  const split=(rows:Candidate[])=>{
   const coverage:RetrievalCoverage={searched:[],pending:[],note:retrievalCoverageNote},ready:Candidate[]=[]
   for(const row of rows){
    if(row.state==='ready'){ready.push(row);coverage.searched.push({resourceId:row.resourceId,title:row.spec.title,version:row.version})}
    else coverage.pending.push({resourceId:row.resourceId,title:row.spec.title,reason:row.state??'stale'})
   }
   return {coverage,ready}
  }
  // 主体与范围核验之后、推理之前先看候选：范围内没有就绪索引就不推理（审查 LOW-3），覆盖说明照常给出。
  const preview=split(visible(await this.tx(client=>this.candidates(client,actor.ownerId,embedder.profileHash,false,permitted))))
  if(!preview.ready.length)return readRetrievalSearchResult({coverage:preview.coverage,results:[]})
  const [queryVector]=await this.embed(embedder,'query',[query],signal)
  checkAbort(signal)
  return this.tx(async client=>{
   // 推理期间不持有事务；进事务后按锁定行重读候选，撤回或改版以这次读到的为准。
   const {coverage,ready}=split(visible(await this.candidates(client,actor.ownerId,embedder.profileHash,true,permitted)))
   const loaded=await this.vectors(client,ready.map(row=>({id:row.indexId!,chunkCount:row.chunkCount!})))
   const top=rankRetrievalVectors(queryVector!,ready.map(row=>({row,index:loaded.get(row.indexId!)!})),limit)
   const excerpts=await this.resources.readExcerptsInTransaction(client,actor,targetScopes,top.map(hit=>({resourceId:hit.row.resourceId,resourceVersion:hit.row.version,sourceVersion:hit.row.spec.sourceVersion,chars:[hit.chunk.start,hit.chunk.end]})))
   return readRetrievalSearchResult({coverage,results:excerpts.map(({excerpt},index)=>{
    const hit=top[index]!
    return {resourceId:hit.row.resourceId,resourceVersion:hit.row.version,title:hit.row.spec.title,sourceId:hit.row.spec.sourceId,sourceVersion:hit.row.spec.sourceVersion,lines:[hit.chunk.startLine,hit.chunk.endLine],chars:[hit.chunk.start,hit.chunk.end],heading:hit.chunk.heading,score:hit.score,excerpt}
   })})
  })
 }
}
