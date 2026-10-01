import {createHash} from 'node:crypto'
import type {Pool} from 'pg'
import {WorkError,type IndustryDataSourceDefinition} from '@teloa/contract'
import {createIndustryInstanceKit,industryBindingSpec,industryDetachedState,type IndustryInstanceKit,industryPredicates,type IndustryInstanceListError,type IndustryInstanceStored} from './industry-instance-kit.ts'
import type {IndustryDataSourceSource,IndustryDataSourceSourceSnapshot} from './industry-data-source-source.ts'
import type {IndustryLoadService} from './industry-loads.ts'

export type IndustryDataSourceBinding={sourceId:string;scopes:string[];definitionHash:string;probedAt:string}
/** `drift` 只出现在读路径投影上：固定来源已变化时状态回落为初始态，已冻结的绑定仍保留供核对。 */
export type IndustryDataSourceInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;state:'needs_authorization'|'active'|'detached';revision:number;binding:IndustryDataSourceBinding|null;createdAt:string;updatedAt:string;drift?:true}
export type IndustryDataSourcePage={items:IndustryDataSourceInstance[];errors?:IndustryInstanceListError[]}
export type IndustryDataSourceReadiness={ready:(definition:IndustryDataSourceDefinition,scope:string,signal:AbortSignal)=>Promise<{ready:true;probedAt:string}|{ready:false;reason:string}>}
type Stored=IndustryDataSourceInstance&{mappingDigest:string;bindingHash:string|null}&IndustryInstanceStored

const {hash,exact,same}=industryPredicates
const invalid=()=>new WorkError('teloa/invalid-input','行业数据源实例请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业数据源实例记录损坏，已停止读取。')
const definitionHash=(value:IndustryDataSourceSourceSnapshot)=>createHash('sha256').update(JSON.stringify([value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.itemLocalId,value.contentId.toLowerCase(),value.contentHash,value.itemVersion,value.fileHash,value.definition])).digest('hex')
const binding=(value:IndustryDataSourceSourceSnapshot,probedAt:string):IndustryDataSourceBinding=>({sourceId:value.definition.sourceId,scopes:[...value.definition.scopes],definitionHash:definitionHash(value),probedAt})
const sameBinding=(left:IndustryDataSourceBinding,right:IndustryDataSourceBinding)=>left.sourceId===right.sourceId&&same(left.scopes,right.scopes)&&left.definitionHash===right.definitionHash
const scoped=(definition:IndustryDataSourceDefinition,domain:string)=>{if(!definition.scopes.includes(domain))throw new WorkError('teloa/invalid-input','数据源定义范围不包含当前行业空间。')}

function readBinding(value:unknown):IndustryDataSourceBinding{
 const row=exact(value,['sourceId','scopes','definitionHash','probedAt'],invalid)
 if(typeof row.sourceId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(row.sourceId)||!Array.isArray(row.scopes)||!row.scopes.length||row.scopes.some(scope=>typeof scope!=='string')||!hash(row.definitionHash)||typeof row.probedAt!=='string'||!Number.isFinite(Date.parse(row.probedAt)))throw corrupt()
 return {sourceId:row.sourceId,scopes:[...row.scopes] as string[],definitionHash:row.definitionHash,probedAt:row.probedAt}
}

export async function initializeIndustryDataSources(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_industry_data_source_instances(
   id uuid primary key,owner_id text not null,load_id uuid not null references teloa_industry_loads(id),item_instance_id uuid not null,item_local_id text not null,
   content_id uuid not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),item_version text not null,scope text not null,
   state text not null check(state in ('needs_authorization','active','detached')),revision integer not null check(revision>0),mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(owner_id,load_id,item_instance_id)
  );
  alter table teloa_industry_data_source_instances add column if not exists binding jsonb;
  alter table teloa_industry_data_source_instances add column if not exists binding_hash text;
  create table if not exists teloa_industry_data_source_create_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_data_source_instances(id),primary key(owner_id,request_id)
  );
  create table if not exists teloa_industry_data_source_authorize_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_data_source_instances(id),result_revision integer not null check(result_revision>0),primary key(owner_id,request_id)
  );
  delete from teloa_industry_data_source_authorize_requests r using teloa_industry_data_source_instances i where r.instance_id=i.id and i.state='active' and i.binding is null;
  -- updated_at 取 greatest：库时钟落后于写入 created_at 的那台机器时，直接用 now() 会写出早于创建时刻的更新时刻，读取核验会判记录损坏。
  update teloa_industry_data_source_instances set state='needs_authorization',revision=1,updated_at=greatest(created_at,now()) where state='active' and binding is null;
  alter table teloa_industry_data_source_instances drop constraint if exists teloa_industry_data_source_instances_state_check;
  alter table teloa_industry_data_source_instances drop constraint if exists teloa_industry_data_source_instances_revision_check;
  alter table teloa_industry_data_source_instances drop constraint if exists teloa_industry_data_source_instances_binding_check;
  alter table teloa_industry_data_source_instances add constraint teloa_industry_data_source_instances_state_check check(state in ('needs_authorization','active','detached'));
  alter table teloa_industry_data_source_instances add constraint teloa_industry_data_source_instances_revision_check check(revision>=1);
  alter table teloa_industry_data_source_instances add constraint teloa_industry_data_source_instances_binding_check check(
   (state='needs_authorization' and binding is null and binding_hash is null) or
   (state='active' and jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$') or
   (state='detached' and ((binding is null and binding_hash is null) or (jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$')))
  );
  alter table teloa_industry_data_source_authorize_requests drop constraint if exists teloa_industry_data_source_authorize_requests_result_revision_check;
  alter table teloa_industry_data_source_authorize_requests add constraint teloa_industry_data_source_authorize_requests_result_revision_check check(result_revision>=2);
 `)
}

export class IndustryDataSourceService{
 private readonly loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'storedItemStatus'>
 private readonly source:Pick<IndustryDataSourceSource,'read'>
 private readonly readiness:IndustryDataSourceReadiness
 private readonly kit:IndustryInstanceKit<Stored,IndustryDataSourceInstance,IndustryDataSourceSourceSnapshot>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'storedItemStatus'>,source:Pick<IndustryDataSourceSource,'read'>,readiness:IndustryDataSourceReadiness){
  this.loads=loads;this.source=source;this.readiness=readiness
  this.kit=createIndustryInstanceKit<Stored,IndustryDataSourceInstance,IndustryDataSourceSourceSnapshot>({
   kind:'data-source',table:'teloa_industry_data_source_instances',createRequests:'teloa_industry_data_source_create_requests',advanceRequests:'teloa_industry_data_source_authorize_requests',
   lockPrefix:'industry-data-source',advanceName:'authorize',initialState:'needs_authorization',states:['needs_authorization','active',industryDetachedState],
   messages:{forbidden:'行业数据源实例不存在或不属于当前本人。',conflictCreate:'同一请求不能实例化不同的行业数据源。',notInstantiable:'目标不是可实例化的行业数据源。',conflictAdvance:'同一请求不能授权不同的行业数据源。',versionConflict:'行业数据源授权状态已变化，请刷新后重试。',drift:'数据源固定来源已变化，停止使用当前连接。'},
   invalid,corrupt,
   ...industryBindingSpec<IndustryDataSourceBinding,Stored>(readBinding),
   sameSource:(value,fixed)=>sameBinding(value.binding!,binding(fixed,value.binding!.probedAt)),
  },{pool,identity,loads,source})
 }

 async instantiate(ownerId:string,input:unknown):Promise<IndustryDataSourceInstance>{
  return this.kit.instantiate(ownerId,input,{
   preview:async(db,context)=>scoped((await this.source.read(db,context.ownerId,{loadId:context.loadId,itemInstanceId:context.itemInstanceId})).definition,context.load.scope),
   columns:()=>({binding:null,binding_hash:null}),
  })
 }

 async authorize(ownerId:string,input:unknown,signal:AbortSignal):Promise<IndustryDataSourceInstance>{
  return this.kit.advance<{snapshot:IndustryDataSourceSourceSnapshot;domain:string},{ready:true;probedAt:string}>(ownerId,input,signal,{
   preview:async(db,current)=>{
    const snapshot=await this.source.read(db,current.ownerId,{loadId:current.loadId,itemInstanceId:current.itemInstanceId}),domain=(await this.loads.getInTransaction(db,current.ownerId,{loadId:current.loadId})).scope
    scoped(snapshot.definition,domain);return {snapshot,domain}
   },
   probe:async preview=>{
    const result=await this.readiness.ready(preview.snapshot.definition,preview.domain,signal)
    if(!result.ready)throw new WorkError('teloa/dependency-unavailable','数据源尚未连接或未通过就绪核验：'+result.reason)
    return result
   },
   write:async(db,context)=>{
    const fresh=await this.source.read(db,context.ownerId,{loadId:context.current.loadId,itemInstanceId:context.current.itemInstanceId})
    if(definitionHash(fresh)!==definitionHash(context.preview.snapshot))throw new WorkError('teloa/source-unavailable','数据源固定来源在核验期间发生变化，请重新连接。')
    const fixed=binding(fresh,context.probe.probedAt)
    return (await db.query("update teloa_industry_data_source_instances set state='active',revision=revision+1,binding=$3,binding_hash=$4,updated_at=$5 where id=$1 and owner_id=$2 and state='needs_authorization' and revision=$6 returning *",[context.instanceId,context.ownerId,JSON.stringify(fixed),definitionHash(fresh),context.now(),context.expectedRevision])).rows[0]
   },
  })
 }

 async get(ownerId:string,input:unknown):Promise<IndustryDataSourceInstance>{return this.kit.get(ownerId,input)}
 async list(ownerId:string,input:unknown):Promise<IndustryDataSourcePage>{return this.kit.list(ownerId,input)}
}
