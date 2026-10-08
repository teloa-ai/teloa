import type {Pool} from 'pg'
import {WorkError,groupDefinition,roleSupportsScope,type DigitalRole,type RoleMemoryView} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import type {RoleMemoryService} from './role-memory.ts'

type Database=Pick<Pool,'query'>
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const invalid=()=>new WorkError('teloa/invalid-input','共享记忆视图请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','共享记忆视图记录损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid()
 return value as Record<string,unknown>
}
const owner=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','共享记忆需要可核验的本人身份。');return value}

export function roleMemoryViewEntries(value:unknown):RoleMemoryView['entries']{
 if(!Array.isArray(value)||value.length===0||value.length>30)throw invalid()
 const entries=value.map(item=>{
  const row=exact(item,['memoryId','memoryVersion','contentSha256'])
  if(!uuid(row.memoryId)||!positive(row.memoryVersion)||typeof row.contentSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.contentSha256))throw invalid()
  return {memoryId:row.memoryId,memoryVersion:row.memoryVersion,contentSha256:row.contentSha256}
 })
 if(new Set(entries.map(entry=>entry.memoryId)).size!==entries.length)throw invalid()
 return entries.sort((a,b)=>a.memoryId.localeCompare(b.memoryId))
}

function storedView(row:Record<string,unknown>,ownerId:string):RoleMemoryView{
 try{
  if(row.owner_id!==ownerId||!uuid(row.id)||!uuid(row.role_id)||!positive(row.role_version)||!uuid(row.group_id)||row.version!==1||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw Error()
  const entries=roleMemoryViewEntries(row.entries),request=exact(row.request_spec,['roleId','expectedRoleVersion','groupId','entries'])
  if(request.roleId!==row.role_id||request.expectedRoleVersion!==row.role_version||request.groupId!==row.group_id||JSON.stringify(roleMemoryViewEntries(request.entries))!==JSON.stringify(entries))throw Error()
  return {id:row.id,ownerId,roleId:row.role_id,roleVersion:row.role_version,groupId:row.group_id,version:1,entries,createdAt:row.created_at.toISOString()}
 }catch{throw corrupt()}
}

async function binding(db:Database,ownerId:string,roleId:string,roleVersion:number,groupId:string):Promise<DigitalRole>{
 const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[ownerId,roleId])).rows[0]
 if(!row)throw new WorkError('teloa/forbidden','共享记忆的分身不属于当前本人。')
 const role=readStoredRole(row)
 if(role.kind!=='twin'||role.state==='retired')throw new WorkError('teloa/forbidden','只有本人未退役的分身可以提供私有记忆视图。')
 if(role.version!==roleVersion)throw new WorkError('teloa/version-conflict','共享记忆视图绑定的分身版本已变化。')
 const group=(await db.query('select definition,archived from teloa_groups where owner_id=$1 and id=$2 for share',[ownerId,groupId])).rows[0]
 if(!group||group.archived)throw new WorkError('teloa/forbidden','共享记忆的群不存在、已归档或不属于当前本人。')
 let definition
 try{definition=groupDefinition(group.definition)}catch{throw corrupt()}
 const member=(await db.query('select 1 from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3 for share',[ownerId,groupId,roleId])).rows[0]
 if(!member||!definition.memberRoleIds.includes(roleId)||!roleSupportsScope(role.scopes,definition.scope))throw new WorkError('teloa/forbidden','共享记忆的分身不在该群或与群范围不相容。')
 return role
}

/** 运行消费时也重新核对当前岗位和群关系；固定项正文由 RoleMemoryService 单独读取。 */
export async function readStoredRoleMemoryView(db:Database,ownerId:string,viewId:string):Promise<RoleMemoryView>{
 owner(ownerId);if(!uuid(viewId))throw invalid()
 const row=(await db.query('select * from teloa_role_memory_views where owner_id=$1 and id=$2',[ownerId,viewId])).rows[0]
 if(!row)throw new WorkError('teloa/forbidden','共享记忆视图不存在或不属于当前本人。')
 const view=storedView(row,ownerId)
 await binding(db,ownerId,view.roleId,view.roleVersion,view.groupId)
 return view
}

/** 初始化顺序：roles、collaboration、role-memory 完成之后调用。 */
export async function initializeRoleMemoryViews(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_role_memory_views(
  id uuid not null,owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  role_id uuid not null,role_version integer not null check(role_version>0),group_id uuid not null,version integer not null check(version=1),
  entries jsonb not null check(jsonb_typeof(entries)='array' and jsonb_array_length(entries) between 1 and 30),created_at timestamptz not null,
  primary key(owner_id,id),unique(owner_id,request_id),foreign key(role_id,owner_id) references teloa_roles(id,owner_id),foreign key(group_id,owner_id) references teloa_groups(id,owner_id)
 );
 create or replace function teloa_reject_role_memory_view_mutation() returns trigger language plpgsql as $$ begin raise exception 'role memory views are immutable'; end $$;
 drop trigger if exists teloa_role_memory_views_immutable on teloa_role_memory_views;
 create trigger teloa_role_memory_views_immutable before update or delete on teloa_role_memory_views for each row execute function teloa_reject_role_memory_view_mutation();
`)}

/** 仅供已认证的本人 API 调用；视图不会修改或复制原记忆的可见性。 */
export class RoleMemoryViewService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly memories:RoleMemoryService
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},memories:RoleMemoryService){this.pool=pool;this.identity=identity;this.memories=memories}
 async create(ownerId:string,input:unknown):Promise<RoleMemoryView>{
  owner(ownerId)
  const request=exact(input,['requestId','roleId','expectedRoleVersion','groupId','entries'])
  if(!uuid(request.requestId)||!uuid(request.roleId)||!positive(request.expectedRoleVersion)||!uuid(request.groupId))throw invalid()
  const entries=roleMemoryViewEntries(request.entries),spec={roleId:request.roleId,expectedRoleVersion:request.expectedRoleVersion,groupId:request.groupId,entries},db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-memory-view',ownerId,request.requestId])])
   const replay=(await db.query('select *,request_spec=$3::jsonb as same from teloa_role_memory_views where owner_id=$1 and request_id=$2',[ownerId,request.requestId,JSON.stringify(spec)])).rows[0]
   if(replay){if(!replay.same)throw new WorkError('teloa/conflict','同一请求不能创建不同的共享记忆视图。');const result=storedView(replay,ownerId);await db.query('commit');return result}
   const role=await binding(db,ownerId,request.roleId,request.expectedRoleVersion,request.groupId)
   await this.memories.confirmedViewEntries(db,ownerId,role,entries)
   const id=this.identity.id(),now=this.identity.now()
   if(!uuid(id)||!Number.isFinite(Date.parse(now)))throw corrupt()
   const row=(await db.query('insert into teloa_role_memory_views(id,owner_id,request_id,request_spec,role_id,role_version,group_id,version,entries,created_at) values($1,$2,$3,$4,$5,$6,$7,1,$8,$9) returning *',[id,ownerId,request.requestId,JSON.stringify(spec),role.id,role.version,request.groupId,JSON.stringify(entries),now])).rows[0]
   const result=storedView(row,ownerId);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async read(ownerId:string,input:unknown):Promise<RoleMemoryView>{
  owner(ownerId);const request=exact(input,['viewId']);if(!uuid(request.viewId))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin');const view=await readStoredRoleMemoryView(db,ownerId,request.viewId)
   const role=await binding(db,ownerId,view.roleId,view.roleVersion,view.groupId)
   await this.memories.confirmedViewEntries(db,ownerId,role,view.entries)
   await db.query('commit');return view
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
