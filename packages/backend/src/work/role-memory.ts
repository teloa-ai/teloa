import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,artifactContent,isRoleMemory,roleMemorySource,roleMemoryVisibility,roleSupportsScope,savedArtifactSource,taskDefinition,type DigitalRole,type RoleMemory,type RoleMemoryProposer,type RoleMemorySource,type RoleMemoryVisibility,type RoleMemoryView} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import {readStoredRoleMemoryView,roleMemoryViewEntries} from './role-memory-views.ts'

export type RoleMemoryActor={ownerId:string;kind:'human'}|{ownerId:string;kind:'agent';roleId:string}
export type RunRoleMemory={id:string;version:number;title:string;contentHash:string;markdown:string;source:RoleMemorySource;visibility:RoleMemoryVisibility}
export type RoleMemoryRunTarget={scope:string;memoryViewId?:string|null;groupId?:string|null}
/** 每次运行读取的上下文窗口上限；Auto Dream 保存的历史条数不受此值限制。 */
export const roleMemoryRunLimit=30

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex')
const bad=()=>new WorkError('teloa/invalid-input','员工记忆请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','员工记忆记录损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw bad();return value as Record<string,unknown>}
const actor=(value:RoleMemoryActor)=>{
 if(!value||typeof value.ownerId!=='string'||!value.ownerId.trim()||value.ownerId.length>128||!['human','agent'].includes(value.kind)||value.kind==='agent'&&!uuid(value.roleId))throw new WorkError('teloa/forbidden','需要可核验的本人或员工身份。')
 return value
}
const markdown=(value:unknown)=>{
 if(typeof value!=='string')throw bad()
 const normalized=value.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n'),bytes=Buffer.from(normalized,'utf8')
 if(!normalized.trim()||bytes.length>128*1024||bytes.toString('utf8')!==normalized)throw bad()
 return {markdown:normalized,bytes:bytes.length,contentHash:hash(normalized)}
}

type SourceSnapshot={source:RoleMemorySource;title:string;scopeIds:string[]}
const sourceSnapshot=(value:unknown):SourceSnapshot=>{
 try{
  const row=exact(value,['source','title','scopeIds']),source=roleMemorySource(row.source)
  if(typeof row.title!=='string'||!row.title.trim()||row.title.length>200||!Array.isArray(row.scopeIds)||row.scopeIds.length>30||row.scopeIds.some(item=>typeof item!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(item))||new Set(row.scopeIds).size!==row.scopeIds.length)throw Error()
  return {source,title:row.title,scopeIds:[...row.scopeIds].sort()}
 }catch(error){if(error instanceof WorkError&&error.code==='teloa/storage-corrupt')throw error;throw corrupt()}
}

function proposer(value:unknown,roleId:string):RoleMemoryProposer{
 try{
  const row=exact(value,['kind','roleId','roleVersion'])
  if(row.kind==='self'&&Object.keys(row).length===1)return {kind:'self'}
  if(row.kind==='role'&&uuid(row.roleId)&&row.roleId===roleId&&positive(row.roleVersion))return {kind:'role',roleId:row.roleId,roleVersion:row.roleVersion}
  throw Error()
 }catch{throw corrupt()}
}

export function readRunRoleMemories(value:unknown):RunRoleMemory[]{
 try{
  if(!Array.isArray(value)||value.length>30)throw Error()
  const rows=value.map(item=>{
   const row=exact(item,['id','version','title','contentHash','markdown','source','visibility']),source=roleMemorySource(row.source),visibility=roleMemoryVisibility(row.visibility)
   if(!uuid(row.id)||!positive(row.version)||typeof row.title!=='string'||!row.title.trim()||row.title.length>120||typeof row.contentHash!=='string'||!/^[a-f0-9]{64}$/.test(row.contentHash)||typeof row.markdown!=='string'||hash(row.markdown)!==row.contentHash)throw Error()
   return {id:row.id,version:row.version,title:row.title,contentHash:row.contentHash,markdown:row.markdown,source,visibility}
  })
  if(new Set(rows.map(row=>row.id)).size!==rows.length)return (()=>{throw Error()})()
  return rows
 }catch{throw new WorkError('teloa/storage-corrupt','执行员工记忆快照损坏或正文摘要不一致。')}
}

export async function initializeRoleMemory(pool:Pool):Promise<void>{await pool.query(`
 create unique index if not exists teloa_roles_owner_identity on teloa_roles(id,owner_id);
 create table if not exists teloa_role_memories(
  id uuid not null,owner_id text not null,role_id uuid not null,role_version integer not null check(role_version>0),request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  title text not null,current_version integer not null check(current_version>0),state text not null check(state in ('candidate','confirmed','withdrawn')),state_version integer not null check(state_version>0),
  source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),visibility jsonb not null check(jsonb_typeof(visibility)='object'),proposed_by jsonb not null check(jsonb_typeof(proposed_by)='object'),
  candidate_at timestamptz not null,confirmed_at timestamptz,withdrawn_at timestamptz,
  primary key(owner_id,id),unique(owner_id,request_id),foreign key(role_id,owner_id) references teloa_roles(id,owner_id),
  check((state='candidate' and state_version=1 and confirmed_at is null and withdrawn_at is null) or (state='confirmed' and state_version=2 and confirmed_at is not null and withdrawn_at is null) or (state='withdrawn' and withdrawn_at is not null and state_version=case when confirmed_at is null then 2 else 3 end))
 );
 create table if not exists teloa_role_memory_versions(
  owner_id text not null,memory_id uuid not null,number integer not null check(number>0),content_hash text not null check(content_hash ~ '^[a-f0-9]{64}$'),bytes integer not null check(bytes>0 and bytes<=131072),markdown text not null,created_at timestamptz not null,
  primary key(owner_id,memory_id,number),foreign key(owner_id,memory_id) references teloa_role_memories(owner_id,id)
 );
 create table if not exists teloa_role_memory_changes(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),memory_id uuid not null,result_state_version integer not null check(result_state_version>1),result jsonb check(result is null or jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,memory_id) references teloa_role_memories(owner_id,id)
 );
 alter table teloa_role_memory_changes add column if not exists result jsonb;
 alter table teloa_role_memory_changes alter column result drop not null;
 create table if not exists teloa_role_memory_creations(
  owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),memory_id uuid not null,result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,memory_id) references teloa_role_memories(owner_id,id)
 );
 insert into teloa_role_memory_creations(owner_id,request_id,request_spec,memory_id,result,created_at)
 select m.owner_id,m.request_id,m.request_spec,m.id,jsonb_build_object(
  'id',m.id,'ownerId',m.owner_id,'roleId',m.role_id,'roleVersion',m.role_version,'title',m.title,
  'state','candidate','stateVersion',1,'source',m.source_snapshot->'source','sourceTitle',m.source_snapshot->>'title','sourceAvailable',true,
  'visibility',m.visibility,'proposedBy',m.proposed_by,
  'content',jsonb_build_object('version',v.number,'contentHash',v.content_hash,'bytes',v.bytes,'markdown',v.markdown,'createdAt',to_char(v.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
  'candidateAt',to_char(m.candidate_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'confirmedAt',null,'withdrawnAt',null
 ),m.candidate_at
 from teloa_role_memories m join teloa_role_memory_versions v on v.owner_id=m.owner_id and v.memory_id=m.id and v.number=1
 on conflict(owner_id,request_id) do nothing;
 create or replace function teloa_reject_role_memory_version_mutation() returns trigger language plpgsql as $$ begin raise exception 'role memory versions are immutable'; end $$;
 drop trigger if exists teloa_role_memory_versions_immutable on teloa_role_memory_versions;
 create trigger teloa_role_memory_versions_immutable before update or delete on teloa_role_memory_versions for each row execute function teloa_reject_role_memory_version_mutation();
 create or replace function teloa_reject_role_memory_change_mutation() returns trigger language plpgsql as $$ begin raise exception 'role memory changes are immutable'; end $$;
 drop trigger if exists teloa_role_memory_changes_immutable on teloa_role_memory_changes;
 create trigger teloa_role_memory_changes_immutable before update or delete on teloa_role_memory_changes for each row execute function teloa_reject_role_memory_change_mutation();
 create or replace function teloa_reject_role_memory_creation_mutation() returns trigger language plpgsql as $$ begin raise exception 'role memory creations are immutable'; end $$;
 drop trigger if exists teloa_role_memory_creations_immutable on teloa_role_memory_creations;
 create trigger teloa_role_memory_creations_immutable before update or delete on teloa_role_memory_creations for each row execute function teloa_reject_role_memory_creation_mutation();
 alter table teloa_task_runs add column if not exists role_memory jsonb not null default '[]'::jsonb;
`)}

export class RoleMemoryService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async role(db:Pick<Pool,'query'>,ownerId:string,roleId:string,lock=false):Promise<DigitalRole>{
  const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2'+(lock?' for share':''),[ownerId,roleId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
  return readStoredRole(row)
 }
 private async resolveSource(db:Pick<Pool,'query'>,ownerId:string,source:RoleMemorySource,roleId:string):Promise<SourceSnapshot>{
  if(source.kind==='self-feedback')return {source,title:'本人反馈',scopeIds:[]}
  if(source.kind==='daily-digest'||source.kind==='habit-digest'){
   const row=(await db.query('select role_id,kind,day,title,scope_ids,state from teloa_role_daily_logs where owner_id=$1 and id=$2',[ownerId,source.id])).rows[0]
   if(!row)throw new WorkError('teloa/forbidden','每日日志来源不存在或不属于当前本人。')
   // 日志所属岗位必须与记忆所属岗位一致：跨岗位引用同一份日志等于把别人的范围搬进来。
   if(row.role_id!==roleId)throw new WorkError('teloa/forbidden','每日日志来源不属于该员工。')
   if(source.version!==1||row.kind!==source.kind||row.state!=='kept')throw new WorkError('teloa/version-conflict','每日日志来源已丢弃或类别不一致。')
   if(typeof row.title!=='string'||!Array.isArray(row.scope_ids))throw corrupt()
   return {source,title:row.title,scopeIds:[...row.scope_ids as string[]].sort()}
  }
  if(source.kind==='task'){
   const row=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[ownerId,source.id])).rows[0]
   if(!row)throw new WorkError('teloa/forbidden','任务来源不存在或不属于当前本人。')
   const definition=taskDefinition(row.definition)
   if(row.version!==source.version||row.state==='cancelled')throw new WorkError('teloa/version-conflict','任务来源版本已变化或已撤回。')
   return {source,title:definition.title,scopeIds:[definition.scope]}
  }
  if(source.kind==='run'){
   const row=(await db.query('select task_version,state,input_text from teloa_task_runs where owner_id=$1 and id=$2',[ownerId,source.id])).rows[0]
   if(!row)throw new WorkError('teloa/forbidden','运行来源不存在或不属于当前本人。')
   if(source.version!==1||['withdrawn','configuration_failed'].includes(String(row.state)))throw new WorkError('teloa/version-conflict','运行来源已撤回或版本不一致。')
   try{const snapshot=JSON.parse(row.input_text),task=exact(snapshot.task,['id','version','title','goal','scope']);if(!uuid(task.id)||task.version!==row.task_version||typeof task.title!=='string'||typeof task.scope!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(task.scope))throw Error();return {source,title:'运行：'+task.title,scopeIds:[task.scope]}}catch{throw corrupt()}
  }
  if(source.kind==='artifact'){
   const head=(await db.query('select current_version from teloa_artifacts where owner_id=$1 and id=$2',[ownerId,source.id])).rows[0]
   if(!head)throw new WorkError('teloa/forbidden','成果来源不存在或不属于当前本人。')
   if(head.current_version!==source.version)throw new WorkError('teloa/version-conflict','成果来源版本已变化。')
   const row=(await db.query('select source,content from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3',[ownerId,source.id,source.version])).rows[0]
   if(!row)throw corrupt()
   try{const fixed=savedArtifactSource(row.source),content=artifactContent(row.content);return {source,title:content.title,scopeIds:[fixed.scope]}}catch{throw corrupt()}
  }
  const row=(await db.query(`select i.title,i.scope_ids,i.current_version,i.status,v.source_id as version_source_id
   from teloa_knowledge_items i left join teloa_knowledge_versions v on v.owner_id=i.owner_id and v.knowledge_id=i.id and v.number=$3
   where i.owner_id=$1 and i.id=$2`,[ownerId,source.id,source.version])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','知识来源不存在或不属于当前本人。')
  if(row.current_version!==source.version||row.status!=='active'||!uuid(row.version_source_id))throw new WorkError('teloa/version-conflict','知识来源版本已变化或已撤回。')
  if(typeof row.title!=='string'||!Array.isArray(row.scope_ids)||row.scope_ids.some((item:unknown)=>typeof item!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(item)))throw corrupt()
  return {source,title:row.title,scopeIds:[...row.scope_ids].sort()}
 }
 private async available(db:Pick<Pool,'query'>,ownerId:string,snapshot:SourceSnapshot,roleId:string):Promise<boolean>{
  if(snapshot.source.kind==='self-feedback')return snapshot.title==='本人反馈'
  try{const current=await this.resolveSource(db,ownerId,snapshot.source,roleId);return current.title===snapshot.title&&JSON.stringify(current.scopeIds)===JSON.stringify(snapshot.scopeIds)}
  catch(error){if(error instanceof WorkError&&['teloa/forbidden','teloa/version-conflict','teloa/not-found'].includes(error.code))return false;throw error}
 }
 private async read(db:Pick<Pool,'query'>,ownerId:string,row:Record<string,unknown>,sourceAvailable?:boolean):Promise<RoleMemory>{
  try{
   const snapshot=sourceSnapshot(row.source_snapshot),visibility=roleMemoryVisibility(row.visibility),proposedBy=proposer(row.proposed_by,row.role_id as string)
   if(!uuid(row.id)||row.owner_id!==ownerId||!uuid(row.role_id)||!positive(row.role_version)||typeof row.title!=='string'||!row.title.trim()||row.title.length>120||!positive(row.current_version)||!['candidate','confirmed','withdrawn'].includes(String(row.state))||!positive(row.state_version))throw Error()
   const version=(await db.query('select * from teloa_role_memory_versions where owner_id=$1 and memory_id=$2 and number=$3',[ownerId,row.id,row.current_version])).rows[0]
   if(!version||typeof version.markdown!=='string'||hash(version.markdown)!==version.content_hash||Buffer.byteLength(version.markdown)!==version.bytes)throw Error()
   const candidateAt=stamp(row.candidate_at),confirmedAt=row.confirmed_at===null?null:stamp(row.confirmed_at),withdrawnAt=row.withdrawn_at===null?null:stamp(row.withdrawn_at)
   const request=exact(row.request_spec,['roleId','expectedRoleVersion','title','contentHash','source','visibility','proposedBy'])
   if(request.roleId!==row.role_id||request.expectedRoleVersion!==row.role_version||request.title!==row.title||request.contentHash!==version.content_hash||JSON.stringify(roleMemorySource(request.source))!==JSON.stringify(snapshot.source)||JSON.stringify(roleMemoryVisibility(request.visibility))!==JSON.stringify(visibility)||JSON.stringify(proposer(request.proposedBy,row.role_id as string))!==JSON.stringify(proposedBy))throw Error()
   const value:RoleMemory={id:row.id,ownerId:row.owner_id,roleId:row.role_id,roleVersion:row.role_version,title:row.title,state:row.state as RoleMemory['state'],stateVersion:row.state_version,source:snapshot.source,sourceTitle:snapshot.title,sourceAvailable:sourceAvailable??await this.available(db,ownerId,snapshot,row.role_id as string),visibility,proposedBy,content:{version:version.number,contentHash:version.content_hash,bytes:version.bytes,markdown:version.markdown,createdAt:stamp(version.created_at)},candidateAt,confirmedAt,withdrawnAt}
   return value
  }catch(error){if(error instanceof WorkError&&error.code!=='teloa/invalid-input')throw error;throw corrupt()}
 }
 async create(principal:RoleMemoryActor,input:unknown):Promise<RoleMemory>{
  const who=actor(principal),row=exact(input,['requestId','roleId','expectedRoleVersion','title','markdown','source','visibility'])
  if(!uuid(row.requestId)||!uuid(row.roleId)||!positive(row.expectedRoleVersion)||typeof row.title!=='string'||!row.title.trim()||row.title.length>120)throw bad()
  const title=row.title.trim(),content=markdown(row.markdown),source=roleMemorySource(row.source),visibility=roleMemoryVisibility(row.visibility),db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-memory-create',who.ownerId,row.requestId])])
   const proposedBy:RoleMemoryProposer=who.kind==='human'?{kind:'self'}:{kind:'role',roleId:row.roleId as string,roleVersion:row.expectedRoleVersion as number}
   const spec={roleId:row.roleId,expectedRoleVersion:row.expectedRoleVersion,title,contentHash:content.contentHash,source,visibility,proposedBy}
   const receipt=(await db.query('select *,request_spec=$3::jsonb as same from teloa_role_memory_creations where owner_id=$1 and request_id=$2',[who.ownerId,row.requestId,JSON.stringify(spec)])).rows[0]
   if(receipt){if(!receipt.same)throw new WorkError('teloa/conflict','同一请求不能创建不同的记忆候选。');if(!isRoleMemory(receipt.result)||receipt.result.ownerId!==who.ownerId||receipt.result.id!==receipt.memory_id||receipt.result.state!=='candidate'||receipt.result.stateVersion!==1)throw corrupt();await db.query('commit');return receipt.result}
   const legacy=(await db.query('select *,request_spec=$3::jsonb as same from teloa_role_memories where owner_id=$1 and request_id=$2',[who.ownerId,row.requestId,JSON.stringify(spec)])).rows[0]
   if(legacy){
    if(!legacy.same)throw new WorkError('teloa/conflict','同一请求不能创建不同的记忆候选。')
    const current=await this.read(db,who.ownerId,legacy,true),result:RoleMemory={...current,state:'candidate',stateVersion:1,sourceAvailable:true,confirmedAt:null,withdrawnAt:null}
    if(!isRoleMemory(result))throw corrupt()
    await db.query('insert into teloa_role_memory_creations(owner_id,request_id,request_spec,memory_id,result,created_at) values($1,$2,$3,$4,$5,$6)',[who.ownerId,row.requestId,JSON.stringify(spec),result.id,JSON.stringify(result),result.candidateAt])
    await db.query('commit');return result
   }
   const role=await this.role(db,who.ownerId,row.roleId as string,true)
   if(role.version!==row.expectedRoleVersion)throw new WorkError('teloa/version-conflict','员工版本已变化，请刷新后记录候选。')
   if(role.state==='retired')throw new WorkError('teloa/conflict','已退役员工不能新增记忆候选。')
   if(role.kind==='employee'&&visibility.kind!=='role'||role.kind==='twin'&&visibility.kind!=='private')throw bad()
   if(who.kind==='agent'&&who.roleId!==role.id)throw new WorkError('teloa/forbidden','只能为当前运行岗位提出候选。')
   if(who.kind==='agent'&&role.kind==='twin'){
    if(source.kind!=='run')throw new WorkError('teloa/forbidden','分身候选必须引用自身的真实运行。')
    const run=(await db.query('select role_id,role_version,state from teloa_task_runs where owner_id=$1 and id=$2 for share',[who.ownerId,source.id])).rows[0]
    if(!run||run.role_id!==role.id||run.role_version!==role.version||!['accepted','active'].includes(run.state)||source.version!==1)throw new WorkError('teloa/forbidden','分身经验来源与当前运行岗位不一致。')
   }
   if(who.kind==='agent'&&source.kind==='self-feedback')throw new WorkError('teloa/forbidden','员工候选必须引用可核验的任务、运行、成果或知识来源。')
   let resolved=await this.resolveSource(db,who.ownerId,source,role.id)
   if(source.kind==='self-feedback')resolved={...resolved,scopeIds:visibility.scopeIds}
   if(visibility.kind==='role'&&(!visibility.scopeIds.every(scope=>role.scopes.includes(scope))||!visibility.scopeIds.every(scope=>resolved.scopeIds.includes(scope))))throw new WorkError('teloa/forbidden','记忆范围必须同时属于当前员工与来源可见范围。')
   // C1：一份习惯观察最多手工提升 3 条候选，与状态无关（候选/确认/撤回都算数），超出整次拒绝。
   if(source.kind==='habit-digest'){
    const promoted=Number((await db.query("select count(*) from teloa_role_memories where owner_id=$1 and source_snapshot->'source'->>'id'=$2",[who.ownerId,source.id])).rows[0]?.count)
    if(!Number.isSafeInteger(promoted))throw corrupt()
    if(promoted>=3)throw new WorkError('teloa/conflict','一份观察最多记下 3 条。')
   }
   const id=this.identity.id(),now=this.identity.now();if(!uuid(id)||!Number.isFinite(Date.parse(now)))throw corrupt()
   await db.query("insert into teloa_role_memories(id,owner_id,role_id,role_version,request_id,request_spec,title,current_version,state,state_version,source_snapshot,visibility,proposed_by,candidate_at,confirmed_at,withdrawn_at) values($1,$2,$3,$4,$5,$6,$7,1,'candidate',1,$8,$9,$10,$11,null,null)",[id,who.ownerId,role.id,role.version,row.requestId,JSON.stringify(spec),title,JSON.stringify(resolved),JSON.stringify(visibility),JSON.stringify(proposedBy),now])
   await db.query('insert into teloa_role_memory_versions(owner_id,memory_id,number,content_hash,bytes,markdown,created_at) values($1,$2,1,$3,$4,$5,$6)',[who.ownerId,id,content.contentHash,content.bytes,content.markdown,now])
   const saved=(await db.query('select * from teloa_role_memories where owner_id=$1 and id=$2',[who.ownerId,id])).rows[0],result=await this.read(db,who.ownerId,saved,true)
   await db.query('insert into teloa_role_memory_creations(owner_id,request_id,request_spec,memory_id,result,created_at) values($1,$2,$3,$4,$5,$6)',[who.ownerId,row.requestId,JSON.stringify(spec),id,JSON.stringify(result),now])
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** Auto Dream 专用写口，不暴露为浏览器或通用模型工具；创建回执不变，重试只补保存，绝不恢复已撤回项。 */
 async remember(principal:RoleMemoryActor,input:unknown):Promise<RoleMemory>{
  const who=actor(principal),row=exact(input,['requestId','roleId','expectedRoleVersion','title','markdown','source','visibility'])
  const source=roleMemorySource(row.source)
  if(source.kind!=='daily-digest'&&source.kind!=='habit-digest')throw bad()
  const created=await this.create(who,input),db=await this.pool.connect()
  try{
   await db.query('begin')
   const stored=(await db.query('select * from teloa_role_memories where owner_id=$1 and id=$2 for update',[who.ownerId,created.id])).rows[0]
   const current=await this.read(db,who.ownerId,stored)
   if(current.state!=='candidate'){await db.query('commit');return current}
   const role=await this.role(db,who.ownerId,current.roleId,true)
   if(role.version!==current.roleVersion||role.state==='retired'||!current.sourceAvailable)throw new WorkError('teloa/version-conflict','记忆来源或员工已变化，未自动保存。')
   const now=this.identity.now()
   const saved=(await db.query("update teloa_role_memories set state='confirmed',state_version=state_version+1,confirmed_at=$3 where owner_id=$1 and id=$2 returning *",[who.ownerId,current.id,now])).rows[0]
   const result=await this.read(db,who.ownerId,saved)
   await db.query('insert into teloa_role_memory_changes(owner_id,request_id,request_spec,memory_id,result_state_version,result,created_at) values($1,$2,$3,$4,$5,$6,$7)',[who.ownerId,this.identity.id(),JSON.stringify({action:'auto-save',memoryId:current.id,expectedStateVersion:current.stateVersion}),current.id,result.stateVersion,JSON.stringify(result),now])
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(principal:RoleMemoryActor,input:unknown):Promise<RoleMemory[]>{
  const who=actor(principal),row=exact(input,['roleId']);if(!uuid(row.roleId)||who.kind!=='human')throw new WorkError('teloa/forbidden','员工记忆目录只对本人开放。')
  await this.role(this.pool,who.ownerId,row.roleId as string)
  const rows=(await this.pool.query('select * from teloa_role_memories where owner_id=$1 and role_id=$2 order by candidate_at,id',[who.ownerId,row.roleId])).rows,result:RoleMemory[]=[]
  for(const stored of rows)result.push(await this.read(this.pool,who.ownerId,stored));return result
 }
 private async change(principal:RoleMemoryActor,input:unknown,action:'confirm'|'withdraw'):Promise<RoleMemory>{
  const who=actor(principal);if(who.kind!=='human')throw new WorkError('teloa/forbidden','只有本人可以确认或撤回员工记忆。')
  const row=exact(input,['requestId','memoryId','expectedStateVersion']);if(!uuid(row.requestId)||!uuid(row.memoryId)||!positive(row.expectedStateVersion))throw bad()
  const spec={action,memoryId:row.memoryId,expectedStateVersion:row.expectedStateVersion},db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-memory-change',who.ownerId,row.requestId])])
   const previous=(await db.query('select *,request_spec=$3::jsonb as same from teloa_role_memory_changes where owner_id=$1 and request_id=$2',[who.ownerId,row.requestId,JSON.stringify(spec)])).rows[0]
   if(previous){if(!previous.same)throw new WorkError('teloa/conflict','同一请求不能执行不同的记忆决定。');if(previous.result===null)throw new WorkError('teloa/conflict','该旧请求缺少当时的完整回执，无法安全重放；请刷新员工记忆目录核对当前状态。');if(!isRoleMemory(previous.result)||previous.result.ownerId!==who.ownerId||previous.result.id!==previous.memory_id||previous.result.stateVersion!==previous.result_state_version)throw corrupt();await db.query('commit');return previous.result}
   const stored=(await db.query('select * from teloa_role_memories where owner_id=$1 and id=$2 for update',[who.ownerId,row.memoryId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','员工记忆不存在或不属于当前本人。')
   const current=await this.read(db,who.ownerId,stored)
   if(current.stateVersion!==row.expectedStateVersion)throw new WorkError('teloa/version-conflict','员工记忆状态已变化，请刷新后核对。')
   if(action==='confirm'){
    if(current.state!=='candidate')throw new WorkError('teloa/conflict','只有候选记忆可以确认。')
    if(!current.sourceAvailable)throw new WorkError('teloa/version-conflict','记忆来源已变化或不可见，不能确认。')
    await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-memory-confirm',who.ownerId,current.roleId])])
    if(current.visibility.kind==='role'){
     for(const scope of current.visibility.scopeIds){
      const count=Number((await db.query("select count(*) from teloa_role_memories where owner_id=$1 and role_id=$2 and state='confirmed' and source_snapshot->'source'->>'kind' not in ('daily-digest','habit-digest') and visibility->>'kind'='role' and visibility->'scopeIds' ? $3",[who.ownerId,current.roleId,scope])).rows[0]?.count)
      if(!Number.isSafeInteger(count))throw corrupt()
      if(count>=roleMemoryRunLimit)throw new WorkError('teloa/conflict',`员工在“${scope}”范围最多确认 ${roleMemoryRunLimit} 条记忆；请先撤回不再适用的记忆。`)
     }
    }else{
     // 私有记忆的 scopeIds 恒为空数组，逐范围计数对它永远不执行；按 owner + role + private 单独计一次。
     const count=Number((await db.query("select count(*) from teloa_role_memories where owner_id=$1 and role_id=$2 and state='confirmed' and source_snapshot->'source'->>'kind' not in ('daily-digest','habit-digest') and visibility->>'kind'='private'",[who.ownerId,current.roleId])).rows[0]?.count)
     if(!Number.isSafeInteger(count))throw corrupt()
     if(count>=roleMemoryRunLimit)throw new WorkError('teloa/conflict',`分身私有记忆最多确认 ${roleMemoryRunLimit} 条；请先撤回不再适用的记忆。`)
    }
   }else if(current.state==='withdrawn')throw new WorkError('teloa/conflict','员工记忆已经撤回。')
   const now=this.identity.now(),next=current.stateVersion+1
   const saved=(await db.query(`update teloa_role_memories set state=$3,state_version=$4,confirmed_at=case when $3='confirmed' then $5 else confirmed_at end,withdrawn_at=case when $3='withdrawn' then $5 else null end where owner_id=$1 and id=$2 returning *`,[who.ownerId,current.id,action==='confirm'?'confirmed':'withdrawn',next,now])).rows[0]
   const result=await this.read(db,who.ownerId,saved)
   await db.query('insert into teloa_role_memory_changes(owner_id,request_id,request_spec,memory_id,result_state_version,result,created_at) values($1,$2,$3,$4,$5,$6,$7)',[who.ownerId,row.requestId,JSON.stringify(spec),current.id,next,JSON.stringify(result),now])
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 confirm(principal:RoleMemoryActor,input:unknown){return this.change(principal,input,'confirm')}
 withdraw(principal:RoleMemoryActor,input:unknown){return this.change(principal,input,'withdraw')}
 // 项目引用不改变此处范围判定；见 2026-09-25 计划 Task 3。
 async confirmedForRun(db:Pick<Pool,'query'>,ownerId:string,target:string|RoleMemoryRunTarget,role:DigitalRole):Promise<RunRoleMemory[]>{
  actor({ownerId,kind:'human'})
  const selection=typeof target==='string'?{scope:target}:target,scope=selection?.scope
  if(role.ownerId!==ownerId||typeof scope!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(scope)||!roleSupportsScope(role.scopes,scope))throw new WorkError('teloa/forbidden','运行岗位与记忆读取范围不一致。')
  if(role.kind==='twin'){
   // 历史调用没有群与共享视图选择，不能据此授予读取私有记忆的许可。
   if(typeof target==='string'||Object.keys(selection).some(key=>!['scope','groupId','memoryViewId'].includes(key))||!Object.hasOwn(selection,'groupId')||!Object.hasOwn(selection,'memoryViewId')||selection.groupId!==null&&!uuid(selection.groupId)||selection.memoryViewId!==null&&!uuid(selection.memoryViewId))throw new WorkError('teloa/forbidden','分身记忆读取需要明确的群与视图选择。')
   if(selection.groupId!==null){
    if(selection.memoryViewId===null)return []
    const view=await readStoredRoleMemoryView(db,ownerId,selection.memoryViewId!)
    if(view.roleId!==role.id||view.roleVersion!==role.version||view.groupId!==selection.groupId)throw new WorkError('teloa/forbidden','共享记忆视图与当前运行岗位或群不一致。')
    const group=(await db.query("select definition->>'scope' as scope from teloa_groups where owner_id=$1 and id=$2",[ownerId,selection.groupId])).rows[0]
    if(group?.scope!==scope)throw new WorkError('teloa/forbidden','共享记忆视图与当前运行范围不一致。')
    return this.confirmedViewEntries(db,ownerId,role,view.entries)
   }
   if(selection.memoryViewId!==null)throw new WorkError('teloa/forbidden','共享记忆视图只用于指定群。')
  }
  const rows=(await db.query(`select * from teloa_role_memories where owner_id=$1 and role_id=$2 and state='confirmed' and visibility->>'kind'=$3 ${role.kind==='employee'?"and visibility->'scopeIds' ? $4":''} order by confirmed_at desc,candidate_at desc,id`,role.kind==='employee'?[ownerId,role.id,'role',scope]:[ownerId,role.id,'private'])).rows,result:RunRoleMemory[]=[]
  for(const stored of rows){const memory=await this.read(db,ownerId,stored);if(!memory.sourceAvailable)continue;result.push(this.runMemory(memory));if(result.length===roleMemoryRunLimit)break}
  return readRunRoleMemories(result)
 }
 private runMemory(memory:RoleMemory):RunRoleMemory{return {id:memory.id,version:memory.content.version,title:memory.title,contentHash:memory.content.contentHash,markdown:memory.content.markdown,source:memory.source,visibility:memory.visibility}}
 /** 只读取本人指定的固定项，任何撤回、改版或来源变化都会使整个视图失效。 */
 async confirmedViewEntries(db:Pick<Pool,'query'>,ownerId:string,role:DigitalRole,entries:RoleMemoryView['entries']):Promise<RunRoleMemory[]>{
  entries=roleMemoryViewEntries(entries)
  if(role.ownerId!==ownerId||role.kind!=='twin'||!Array.isArray(entries)||entries.length===0||entries.length>roleMemoryRunLimit)throw new WorkError('teloa/forbidden','共享记忆视图需要本人分身的明确固定项。')
  const rows=(await db.query("select * from teloa_role_memories where owner_id=$1 and role_id=$2 and state='confirmed' and visibility->>'kind'='private' and id=any($3::uuid[]) for share",[ownerId,role.id,entries.map(entry=>entry.memoryId)])).rows
  if(rows.length!==entries.length)throw new WorkError('teloa/version-conflict','共享记忆已撤回或不属于当前分身。')
  const result:RunRoleMemory[]=[]
  for(const entry of entries){
   const row=rows.find(row=>row.id===entry.memoryId)
   if(!row||row.current_version!==entry.memoryVersion)throw new WorkError('teloa/version-conflict','共享记忆固定版本已变化。')
   const memory=await this.read(db,ownerId,row)
   if(memory.content.contentHash!==entry.contentSha256||!memory.sourceAvailable||memory.visibility.kind!=='private')throw new WorkError('teloa/version-conflict','共享记忆摘要或来源已变化。')
   result.push(this.runMemory(memory))
  }
  return readRunRoleMemories(result)
 }
}
