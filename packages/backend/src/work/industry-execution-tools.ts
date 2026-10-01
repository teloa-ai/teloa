import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import {createIndustryInstanceKit,industryBindingSpec,industryDetachedState,type IndustryInstanceKit,industryPredicates,type IndustryInstanceListError,type IndustryInstanceStored} from './industry-instance-kit.ts'
import type {IndustryExecutionToolSource,IndustryExecutionToolSourceSnapshot} from './industry-execution-tool-source.ts'
import type {IndustryLoadService} from './industry-loads.ts'

export type IndustryExecutionToolBinding={adapterId:'security-action-http';tools:['security.endpoint.isolate'];definitionHash:string}
/** `drift` 只出现在读路径投影上：固定来源已变化时状态回落为初始态，已冻结的绑定仍保留供核对。 */
export type IndustryExecutionToolInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;state:'needs_authorization'|'active'|'detached';revision:number;binding:IndustryExecutionToolBinding|null;createdAt:string;updatedAt:string;drift?:true}
export type IndustryExecutionToolPage={items:IndustryExecutionToolInstance[];errors?:IndustryInstanceListError[]}
export type IndustryExecutionToolReadiness={ready:(tool:string,signal:AbortSignal)=>Promise<{ready:true}|{ready:false;reason:string}>}
type Stored=IndustryExecutionToolInstance&{mappingDigest:string;bindingHash:string|null}&IndustryInstanceStored

const {hash,exact,same}=industryPredicates
const invalid=()=>new WorkError('teloa/invalid-input','行业执行工具请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业执行工具实例记录损坏，已停止读取。')
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const definitionHash=(value:IndustryExecutionToolSourceSnapshot)=>createHash('sha256').update(JSON.stringify([value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.itemLocalId,value.contentId.toLowerCase(),value.contentHash,value.itemVersion,value.fileHash,value.definition])).digest('hex')
const binding=(value:IndustryExecutionToolSourceSnapshot):IndustryExecutionToolBinding=>({adapterId:value.definition.adapterId,tools:[...value.definition.tools],definitionHash:definitionHash(value)})

function readBinding(value:unknown):IndustryExecutionToolBinding{
 const row=exact(value,['adapterId','tools','definitionHash'],invalid)
 if(row.adapterId!=='security-action-http'||!Array.isArray(row.tools)||row.tools.length!==1||row.tools[0]!=='security.endpoint.isolate'||!hash(row.definitionHash))throw corrupt()
 return {adapterId:'security-action-http',tools:['security.endpoint.isolate'],definitionHash:row.definitionHash}
}

export async function initializeIndustryExecutionTools(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_industry_execution_tool_instances(
   id uuid primary key,owner_id text not null,load_id uuid not null references teloa_industry_loads(id),item_instance_id uuid not null,item_local_id text not null,
   content_id uuid not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),item_version text not null,scope text not null,
   state text not null,revision integer not null,binding jsonb,binding_hash text,mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(owner_id,load_id,item_instance_id)
  );
  alter table teloa_industry_execution_tool_instances add column if not exists binding jsonb;
  alter table teloa_industry_execution_tool_instances add column if not exists binding_hash text;
  alter table teloa_industry_execution_tool_instances drop constraint if exists teloa_industry_execution_tool_instances_state_check;
  alter table teloa_industry_execution_tool_instances drop constraint if exists teloa_industry_execution_tool_instances_revision_check;
  alter table teloa_industry_execution_tool_instances drop constraint if exists teloa_industry_execution_tool_instances_binding_check;
  alter table teloa_industry_execution_tool_instances add constraint teloa_industry_execution_tool_instances_state_check check(state in ('needs_authorization','active','detached'));
  alter table teloa_industry_execution_tool_instances add constraint teloa_industry_execution_tool_instances_revision_check check(revision>=1);
  alter table teloa_industry_execution_tool_instances add constraint teloa_industry_execution_tool_instances_binding_check check(
   (state='needs_authorization' and binding is null and binding_hash is null) or
   (state='active' and jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$') or
   (state='detached' and ((binding is null and binding_hash is null) or (jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$')))
  );
  create table if not exists teloa_industry_execution_tool_create_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_execution_tool_instances(id),primary key(owner_id,request_id)
  );
  create table if not exists teloa_industry_execution_tool_authorize_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_execution_tool_instances(id),result_revision integer not null check(result_revision>=2),primary key(owner_id,request_id)
  );
 `)
}

export class IndustryExecutionToolService{
 private readonly source:Pick<IndustryExecutionToolSource,'read'>
 private readonly readiness:IndustryExecutionToolReadiness
 private readonly kit:IndustryInstanceKit<Stored,IndustryExecutionToolInstance,IndustryExecutionToolSourceSnapshot>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'storedItemStatus'>,source:Pick<IndustryExecutionToolSource,'read'>,readiness:IndustryExecutionToolReadiness){
  this.source=source;this.readiness=readiness
  this.kit=createIndustryInstanceKit<Stored,IndustryExecutionToolInstance,IndustryExecutionToolSourceSnapshot>({
   kind:'execution-tool',table:'teloa_industry_execution_tool_instances',createRequests:'teloa_industry_execution_tool_create_requests',advanceRequests:'teloa_industry_execution_tool_authorize_requests',
   lockPrefix:'industry-execution-tool',advanceName:'authorize',initialState:'needs_authorization',states:['needs_authorization','active',industryDetachedState],
   messages:{forbidden:'行业执行工具实例不存在或不属于当前本人。',conflictCreate:'同一请求不能登记不同的行业执行工具。',notInstantiable:'目标不是可登记的行业执行工具。',conflictAdvance:'同一请求不能授权不同的行业执行工具状态。',versionConflict:'行业执行工具授权状态已变化，请刷新后重试。',drift:'执行工具固定来源已变化，停止使用当前授权。'},
   invalid,corrupt,
   ...industryBindingSpec<IndustryExecutionToolBinding,Stored>(readBinding),
   sameSource:(value,fixed)=>same(value.binding,binding(fixed)),
  },{pool,identity,loads,source})
 }

 async instantiate(ownerId:string,input:unknown):Promise<IndustryExecutionToolInstance>{
  return this.kit.instantiate(ownerId,input,{columns:()=>({binding:null,binding_hash:null})})
 }

 async authorize(ownerId:string,input:unknown,signal:AbortSignal):Promise<IndustryExecutionToolInstance>{
  return this.kit.advance<IndustryExecutionToolBinding,void>(ownerId,input,signal,{
   preview:async(db,current)=>binding(await this.source.read(db,current.ownerId,{loadId:current.loadId,itemInstanceId:current.itemInstanceId})),
   probe:async preview=>{
    for(const tool of preview.tools){signal.throwIfAborted();const result=await this.readiness.ready(tool,signal);if(!result.ready)throw new WorkError('teloa/dependency-unavailable','执行器尚未连接或未通过就绪核验：'+result.reason)}
   },
   write:async(db,context)=>{
    const fresh=binding(await this.source.read(db,context.ownerId,{loadId:context.current.loadId,itemInstanceId:context.current.itemInstanceId}))
    if(!same(fresh,context.preview))throw new WorkError('teloa/source-unavailable','执行工具固定来源在核验期间发生变化，请重新授权。')
    return (await db.query("update teloa_industry_execution_tool_instances set state='active',revision=revision+1,binding=$3,binding_hash=$4,updated_at=$5 where id=$1 and owner_id=$2 and state='needs_authorization' and revision=$6 returning *",[context.instanceId,context.ownerId,JSON.stringify(fresh),fresh.definitionHash,context.now(),context.expectedRevision])).rows[0]
   },
  })
 }

 /**
  * 业务动作创建任务前的同事务闸门。它不执行工具，只确认此加载中的这一个工具仍是
  * 已授权、来源未漂移且声明中确实允许的工具；返回 null 表示尚未具备入口条件。
  */
 async activeBindingForItemInTransaction(db:PoolClient,ownerId:string,input:{loadId:string;itemInstanceId:string;tool:string}):Promise<IndustryExecutionToolBinding|null>{
  if(!uuid(input.loadId)||!uuid(input.itemInstanceId)||input.tool!=='security.endpoint.isolate')throw invalid()
  const row=(await db.query('select * from teloa_industry_execution_tool_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3',[ownerId,input.loadId.toLowerCase(),input.itemInstanceId.toLowerCase()])).rows[0]
  if(!row)return null
  const stored=this.kit.stored(row)
  const projected=await this.kit.project(db,stored)
  if(projected.state!=='active'||projected.binding===null||!projected.binding.tools.includes(input.tool))return null
  return projected.binding
 }

 async get(ownerId:string,input:unknown):Promise<IndustryExecutionToolInstance>{return this.kit.get(ownerId,input)}
 async list(ownerId:string,input:unknown):Promise<IndustryExecutionToolPage>{return this.kit.list(ownerId,input)}
}
