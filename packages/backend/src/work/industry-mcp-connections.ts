import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,mcpToolFullName,type IndustryMcpConnectionDefinition} from '@teloa/contract'
import {createIndustryInstanceKit,industryBindingSpec,industryDetachedState,type IndustryInstanceKit,industryPredicates,type IndustryInstanceListError,type IndustryInstanceStored} from './industry-instance-kit.ts'
import type {IndustryMcpConnectionSource,IndustryMcpConnectionSourceSnapshot} from './industry-mcp-connection-source.ts'
import type {IndustryLoadService} from './industry-loads.ts'
import {readIndustryRoleDeclarations} from './industry-roles.ts'

export type IndustryMcpConnectionBinding={serverName:string;tools:{raw:string;fullName:string}[];definitionHash:string;observedAt:string}
/** `drift` 只出现在读路径投影上：固定来源已变化时状态回落为初始态，已冻结的绑定仍保留供核对。 */
export type IndustryMcpConnectionInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;contentId:string;contentHash:string;itemVersion:string;scope:string;state:'needs_connection'|'active'|'detached';revision:number;binding:IndustryMcpConnectionBinding|null;createdAt:string;updatedAt:string;drift?:true}
export type IndustryMcpConnectionPage={items:IndustryMcpConnectionInstance[];errors?:IndustryInstanceListError[]}
export type IndustryMcpConnectionReadiness={ready:(definition:IndustryMcpConnectionDefinition,signal:AbortSignal)=>Promise<{ready:true;observedAt:string}|{ready:false;reason:string}>}
type Stored=IndustryMcpConnectionInstance&{mappingDigest:string;bindingHash:string|null}&IndustryInstanceStored

const {hash,exact,same}=industryPredicates
const invalid=()=>new WorkError('teloa/invalid-input','行业 MCP 连接实例请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','行业 MCP 连接实例记录损坏，已停止读取。')
const definitionHash=(value:IndustryMcpConnectionSourceSnapshot)=>createHash('sha256').update(JSON.stringify([value.loadId.toLowerCase(),value.itemInstanceId.toLowerCase(),value.itemLocalId,value.contentId.toLowerCase(),value.contentHash,value.itemVersion,value.fileHash,value.definition])).digest('hex')
const binding=(value:IndustryMcpConnectionSourceSnapshot,observedAt:string):IndustryMcpConnectionBinding=>({serverName:value.definition.serverName,tools:value.definition.tools.map(raw=>({raw,fullName:mcpToolFullName(value.definition.serverName,raw)})),definitionHash:definitionHash(value),observedAt})
const sameBinding=(left:IndustryMcpConnectionBinding,right:IndustryMcpConnectionBinding)=>left.serverName===right.serverName&&same(left.tools,right.tools)&&left.definitionHash===right.definitionHash

export function readIndustryMcpConnectionBinding(value:unknown):IndustryMcpConnectionBinding{
 const row=exact(value,['serverName','tools','definitionHash','observedAt'],invalid)
 if(typeof row.serverName!=='string'||!/^[A-Za-z0-9_-]{1,32}$/.test(row.serverName)||!Array.isArray(row.tools)||!row.tools.length||!hash(row.definitionHash)||typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt)))throw corrupt()
 const tools=row.tools.map(item=>{const tool=exact(item,['raw','fullName'],invalid);if(typeof tool.raw!=='string'||tool.fullName!==mcpToolFullName(row.serverName as string,tool.raw))throw corrupt();return {raw:tool.raw,fullName:tool.fullName as string}})
 return {serverName:row.serverName,tools,definitionHash:row.definitionHash,observedAt:row.observedAt}
}

export async function initializeIndustryMcpConnections(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_industry_mcp_instances(
   id uuid primary key,owner_id text not null,load_id uuid not null references teloa_industry_loads(id),item_instance_id uuid not null,item_local_id text not null,
   content_id uuid not null,content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),item_version text not null,scope text not null,
   state text not null check(state in ('needs_connection','active','detached')),revision integer not null check(revision>=1),binding jsonb,binding_hash text,
   mapping_digest text not null check(mapping_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(owner_id,load_id,item_instance_id),
   constraint teloa_industry_mcp_instances_binding_check check(
    (state='needs_connection' and binding is null and binding_hash is null) or
    (state='active' and jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$')
   )
  );
  alter table teloa_industry_mcp_instances drop constraint if exists teloa_industry_mcp_instances_state_check;
  alter table teloa_industry_mcp_instances drop constraint if exists teloa_industry_mcp_instances_binding_check;
  alter table teloa_industry_mcp_instances add constraint teloa_industry_mcp_instances_state_check check(state in ('needs_connection','active','detached'));
  alter table teloa_industry_mcp_instances add constraint teloa_industry_mcp_instances_binding_check check(
   (state='needs_connection' and binding is null and binding_hash is null) or
   (state='active' and jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$') or
   (state='detached' and ((binding is null and binding_hash is null) or (jsonb_typeof(binding)='object' and binding_hash ~ '^[a-f0-9]{64}$')))
  );
  create table if not exists teloa_industry_mcp_create_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_mcp_instances(id),primary key(owner_id,request_id)
  );
  create table if not exists teloa_industry_mcp_connect_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),instance_id uuid not null references teloa_industry_mcp_instances(id),result_revision integer not null check(result_revision>=2),primary key(owner_id,request_id)
  );
 `)
}

export class IndustryMcpConnectionService{
 private readonly source:Pick<IndustryMcpConnectionSource,'read'>
 private readonly readiness:IndustryMcpConnectionReadiness
 private readonly kit:IndustryInstanceKit<Stored,IndustryMcpConnectionInstance,IndustryMcpConnectionSourceSnapshot>
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},loads:Pick<IndustryLoadService,'get'|'getInTransaction'|'storedItemStatus'>,source:Pick<IndustryMcpConnectionSource,'read'>,readiness:IndustryMcpConnectionReadiness){
  this.source=source;this.readiness=readiness
  this.kit=createIndustryInstanceKit<Stored,IndustryMcpConnectionInstance,IndustryMcpConnectionSourceSnapshot>({
   kind:'mcp',table:'teloa_industry_mcp_instances',createRequests:'teloa_industry_mcp_create_requests',advanceRequests:'teloa_industry_mcp_connect_requests',
   lockPrefix:'industry-mcp',advanceName:'connect',initialState:'needs_connection',states:['needs_connection','active',industryDetachedState],
   messages:{forbidden:'行业 MCP 连接实例不存在或不属于当前本人。',conflictCreate:'同一请求不能实例化不同的行业 MCP 连接。',notInstantiable:'目标不是可实例化的行业 MCP 连接。',conflictAdvance:'同一请求不能连接不同的行业 MCP 连接。',versionConflict:'行业 MCP 连接状态已变化，请刷新后重试。',drift:'MCP 连接固定来源已变化，停止使用当前连接。'},
   invalid,corrupt,
   ...industryBindingSpec<IndustryMcpConnectionBinding,Stored>(readIndustryMcpConnectionBinding),
   sameSource:(value,fixed)=>sameBinding(value.binding!,binding(fixed,value.binding!.observedAt)),
  },{pool,identity,loads,source})
 }

 async instantiate(ownerId:string,input:unknown):Promise<IndustryMcpConnectionInstance>{
  return this.kit.instantiate(ownerId,input,{
   preview:async(db,context)=>{await this.source.read(db,context.ownerId,{loadId:context.loadId,itemInstanceId:context.itemInstanceId})},
   columns:()=>({binding:null,binding_hash:null}),
  })
 }

 async connect(ownerId:string,input:unknown,signal:AbortSignal):Promise<IndustryMcpConnectionInstance>{
  return this.kit.advance<IndustryMcpConnectionSourceSnapshot,{ready:true;observedAt:string}>(ownerId,input,signal,{
   preview:async(db,current)=>this.source.read(db,current.ownerId,{loadId:current.loadId,itemInstanceId:current.itemInstanceId}),
   probe:async preview=>{
    const result=await this.readiness.ready(preview.definition,signal)
    if(!result.ready)throw new WorkError('teloa/dependency-unavailable','MCP 服务尚未连接或缺少声明的工具：'+result.reason)
    return result
   },
   write:async(db,context)=>{
    const fresh=await this.source.read(db,context.ownerId,{loadId:context.current.loadId,itemInstanceId:context.current.itemInstanceId})
    if(definitionHash(fresh)!==definitionHash(context.preview))throw new WorkError('teloa/source-unavailable','MCP 连接固定来源在核验期间发生变化，请重新连接。')
    const fixed=binding(fresh,context.probe.observedAt)
    return (await db.query("update teloa_industry_mcp_instances set state='active',revision=revision+1,binding=$3,binding_hash=$4,updated_at=$5 where id=$1 and owner_id=$2 and state='needs_connection' and revision=$6 returning *",[context.instanceId,context.ownerId,JSON.stringify(fixed),definitionHash(fresh),context.now(),context.expectedRevision])).rows[0]
   },
  })
 }

 /**
  * 运行态只从已实例化岗位的冻结声明中取工具：未连接、已解绑、来源漂移或不属于该岗位的 MCP 一律不给候选。
  * 凭据与服务器安装仍完全由 DSH 的全局连接配置负责；这里仅把已验证的精确工具名交给岗位授权闸。
  */
 async activeToolRulesForRoleInTransaction(db:PoolClient,ownerId:string,roleId:string):Promise<{name:string;anyArguments:true;allowed:[]}[]>{
  const role=(await db.query('select load_id,declarations from teloa_industry_role_instances where owner_id=$1 and role_id=$2 for share',[ownerId,roleId])).rows[0]
  if(!role)return []
  const declarations=readIndustryRoleDeclarations(role.declarations).filter(item=>item.kind==='mcp'&&item.status==='pending-adapter')
  const rules:{name:string;anyArguments:true;allowed:[]}[]=[]
  for(const declaration of declarations){
   const row=(await db.query("select * from teloa_industry_mcp_instances where owner_id=$1 and load_id=$2 and item_instance_id=$3 and state='active' for share",[ownerId,role.load_id,declaration.itemInstanceId])).rows[0]
   if(!row)continue
   const stored=this.kit.stored(row)
   const fresh=await this.source.read(db,ownerId,{loadId:stored.loadId,itemInstanceId:stored.itemInstanceId})
   if(!stored.binding||!sameBinding(stored.binding,binding(fresh,stored.binding.observedAt)))throw new WorkError('teloa/source-unavailable','MCP 连接固定来源已变化，停止使用当前连接。')
   for(const tool of stored.binding.tools)rules.push({name:tool.fullName,anyArguments:true,allowed:[]})
  }
  return Array.from(new Map(rules.map(rule=>[rule.name,rule])).values())
 }
 async get(ownerId:string,input:unknown):Promise<IndustryMcpConnectionInstance>{return this.kit.get(ownerId,input)}
 async list(ownerId:string,input:unknown):Promise<IndustryMcpConnectionPage>{return this.kit.list(ownerId,input)}
}
