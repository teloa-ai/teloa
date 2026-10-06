import type {Pool,PoolClient} from 'pg'
import {WorkError,roleSupportsScope,groupAgentGrantChangeInput,groupAgentGrantGetInput,groupDefinition,isGroupAgentGrant,isGroupAgentGrantRead,normalizeReferences,type GroupAgentGrant,type GroupAgentGrantRead,type GroupAgentResourceGrant} from '@teloa/contract'
import {readActiveAttachment} from './group-attachments.ts'
import {readStoredRole} from './roles.ts'
import {workAccess} from './work-access.ts'

/** 只保证这个值能进 uuid 列，不限版本位与变体位（与 `group-run-messages.ts:9` 同口径）。 */
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)
const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw Error();return value.toISOString()}

export async function initializeGroupAgentGrants(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_group_agent_grants (
  group_id uuid not null, owner_id text not null, role_id uuid not null,
  grant_version integer not null check(grant_version>0), group_version integer not null check(group_version>0), role_version integer not null check(role_version>0),
  state text not null check(state in ('active','revoked')), resources jsonb not null check(jsonb_typeof(resources)='array'), can_post boolean not null,
  request_id uuid not null, request_spec jsonb not null check(jsonb_typeof(request_spec)='object'), created_at timestamptz not null,
  primary key(group_id,role_id,grant_version), unique(owner_id,request_id),
  foreign key(group_id,owner_id) references teloa_groups(id,owner_id) on delete cascade,
  foreign key(role_id,owner_id) references teloa_roles(id,owner_id),
  check((state='active') or (jsonb_array_length(resources)=0 and can_post=false))
 );
 -- can_auto_run 是建表后追加的列，内联 check 引用不到它；撤销分支的完整判据由下面这条具名约束给出（幂等重建）。
 alter table teloa_group_agent_grants add column if not exists can_auto_run boolean not null default false;
 alter table teloa_group_agent_grants drop constraint if exists teloa_group_agent_grants_revoked_empty;
 alter table teloa_group_agent_grants add constraint teloa_group_agent_grants_revoked_empty
  check((state='active') or (jsonb_array_length(resources)=0 and can_post=false and can_auto_run=false));`)
}

export function readGroupAgentGrant(row:Record<string,unknown>):GroupAgentGrant{
 try{
  const value={groupId:row.group_id,roleId:row.role_id,groupVersion:row.group_version,roleVersion:row.role_version,grantVersion:row.grant_version,state:row.state,resources:normalizeReferences(row.resources),canPost:row.can_post,canAutoRun:row.can_auto_run,createdAt:stamp(row.created_at)}
  if(!isGroupAgentGrant(value))throw Error()
  return value
 }catch{throw new WorkError('teloa/storage-corrupt','群员工授权记录损坏，已停止读取。')}
}

function requestSpec(input:ReturnType<typeof groupAgentGrantChangeInput>):string{
 return JSON.stringify({groupId:input.groupId,roleId:input.roleId,expectedGroupVersion:input.expectedGroupVersion,expectedRoleVersion:input.expectedRoleVersion,action:input.action,resources:input.resources,canPost:input.canPost,canAutoRun:input.canAutoRun})
}

/**
 * 群内AI 员工授权只保存本人审批过的快照；它不替代任务运行、岗位工具许可或外部动作审批。
 */
export class GroupAgentGrantService{
 readonly pool:Pool
 readonly now:()=>string
 constructor(pool:Pool,now:()=>string){this.pool=pool;this.now=now}

 async get(owner:string,input:unknown):Promise<GroupAgentGrantRead>{
  ownerId(owner)
  const request=groupAgentGrantGetInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   const context=await this.context(client,owner,request.groupId,request.roleId,'share')
   // 范围不支持时照常回读最新一行：有行就按「有行但不作数」给 `invalidated`（契约 `isGroupAgentGrantRead` 要求
   // `not-granted` 必须配 `grant:null`，`contract/src/collaboration.ts:295`），没有行才是 `not-granted`；本人因此看得到、也撤得掉历史遗留行。
   const row=(await client.query('select * from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version desc limit 1 for share',[request.groupId,request.roleId])).rows[0]
   const grant=row?readGroupAgentGrant(row):null
   const status=context.scopeSupported?this.status(context,grant,grant?await this.resourcesAvailable(client,owner,request.groupId,grant.resources):true):grant?'invalidated':'not-granted'
   const result={groupVersion:context.groupVersion,roleVersion:context.roleVersion,grant,status}
   if(!isGroupAgentGrantRead(result))throw new WorkError('teloa/storage-corrupt','群员工授权状态损坏。')
   await client.query('commit')
   return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 async change(owner:string,input:unknown):Promise<GroupAgentGrant>{
  ownerId(owner)
  const request=groupAgentGrantChangeInput(input),spec=requestSpec(request),client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-agent-grant',owner,request.requestId])])
   const receipt=(await client.query('select *,request_spec=$3::jsonb as same_request from teloa_group_agent_grants where owner_id=$1 and request_id=$2 for update',[owner,request.requestId,spec])).rows[0]
   if(receipt){
    if(!receipt.same_request)throw new WorkError('teloa/conflict','同一群员工授权请求不能更换内容。')
    const result=readGroupAgentGrant(receipt)
    await client.query('commit')
    return result
   }
   const context=await this.context(client,owner,request.groupId,request.roleId,'update')
   if(context.groupVersion!==request.expectedGroupVersion||context.roleVersion!==request.expectedRoleVersion)throw new WorkError('teloa/version-conflict','群或员工已变化，请重新核对授权。')
   if(request.action==='save'){
    if(!context.scopeSupported)throw new WorkError('teloa/forbidden','员工不在本群业务范围内，不能授权。')
    if(context.archived)throw new WorkError('teloa/conflict','已归档群不能新增员工授权。')
    if(context.roleState!=='active'||context.roleKind!=='employee')throw new WorkError('teloa/conflict','只有当前在岗的员工可以获得群授权。')
    await this.assertResources(client,owner,request.groupId,request.resources)
   }else if(!context.scopeSupported&&!(await client.query('select 1 from teloa_group_agent_grants where group_id=$1 and role_id=$2 limit 1 for update',[request.groupId,request.roleId])).rows[0]){
    // 本群授权不了的岗位本来就没有落点：不给它凭空落一行 `revoked`。已有行（历史遗留）照常可撤。
    throw new WorkError('teloa/forbidden','员工不在本群业务范围内，没有可撤销的授权。')
   }
   const previous=(await client.query('select grant_version from teloa_group_agent_grants where group_id=$1 and role_id=$2 order by grant_version desc limit 1 for update',[request.groupId,request.roleId])).rows[0]
   const grantVersion=previous?(previous.grant_version as number)+1:1
   const admission=request.action==='save'?await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:request.groupId,operation:'edit'}):undefined
   admission?.assertCurrent()
   const saved=await client.query(`insert into teloa_group_agent_grants(group_id,owner_id,role_id,grant_version,group_version,role_version,state,resources,can_post,can_auto_run,request_id,request_spec,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,[request.groupId,owner,request.roleId,grantVersion,context.groupVersion,context.roleVersion,request.action==='save'?'active':'revoked',JSON.stringify(request.resources),request.canPost,request.canAutoRun,request.requestId,spec,this.now()])
   const result=readGroupAgentGrant(saved.rows[0])
   admission?.assertCurrent()
   await client.query('commit')
   return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 private async context(client:PoolClient,owner:string,groupId:string,roleId:string,lock:'share'|'update'){
  const groupRow=(await client.query(`select * from teloa_groups where id=$1 and owner_id=$2 for ${lock}`,[groupId,owner])).rows[0]
  if(!groupRow)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
  let scope:string
  try{scope=groupDefinition(groupRow.definition).scope}catch{throw new WorkError('teloa/storage-corrupt','群定义记录损坏，不能读取授权。')}
  if(!Number.isSafeInteger(groupRow.version)||(groupRow.version as number)<1||typeof groupRow.archived!=='boolean')throw new WorkError('teloa/storage-corrupt','群版本或归档状态损坏。')
  const roleRow=(await client.query(`select * from teloa_roles where id=$1 and owner_id=$2 for ${lock}`,[roleId,owner])).rows[0]
  if(!roleRow)throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
  const role=readStoredRole(roleRow)
  const member=(await client.query('select 1 from teloa_group_members where group_id=$1 and owner_id=$2 and role_id=$3 for share',[groupId,owner,roleId])).rows[0]
  if(!member)throw new WorkError('teloa/forbidden','员工不是当前群成员。')
  // 范围不支持不是数据损坏：群成员可以来自任何业务范围（`collaboration.ts` 的 `validateMembers`，用户裁定 B），
  // 只是这位员工在本群拿不到授权。读口据此呈现「未授权」，写口据此拒绝保存，都不再把合法数据当损坏。
  return {groupVersion:groupRow.version as number,roleVersion:role.version,archived:groupRow.archived as boolean,roleState:role.state,roleKind:role.kind,scopeSupported:roleSupportsScope(role.scopes,scope)}
 }

 private status(context:{groupVersion:number;roleVersion:number;archived:boolean;roleState:string;roleKind:string},grant:GroupAgentGrant|null,resourcesAvailable:boolean):GroupAgentGrantRead['status']{
  if(!grant)return 'not-granted'
  if(grant.state==='revoked')return 'revoked'
  if(grant.groupVersion!==context.groupVersion||grant.roleVersion!==context.roleVersion||context.archived||context.roleState!=='active'||context.roleKind!=='employee'||!resourcesAvailable)return 'invalidated'
  return 'active'
 }

 /**
  * 与消息引用同一套原件处判权限（用户引用口径裁定）：`group-resource` 仍限本群，
  * `attachment` / `artifact` 是本人级原件、允许跨群授权；三种不可见共用同一个 `teloa/forbidden`。
  */
 private async assertResources(client:PoolClient,owner:string,groupId:string,resources:readonly GroupAgentResourceGrant[]):Promise<void>{
  for(const resource of resources){
   if(resource.kind==='group-resource'){
    const found=(await client.query(`select 1 from teloa_group_resource_versions versions join teloa_group_resources resources
     on resources.id=versions.resource_id and resources.owner_id=versions.owner_id and resources.group_id=versions.group_id
     where versions.resource_id=$1 and versions.owner_id=$2 and versions.group_id=$3 and versions.version=$4 and resources.withdrawn_at is null for share of versions,resources`,[resource.id,owner,groupId,resource.version])).rows[0]
    if(!found)throw new WorkError('teloa/forbidden','授权资料版本不存在、已撤回或不属于当前群。')
   }else if(resource.kind==='attachment'){
    if(!await readActiveAttachment(client,owner,resource.id))throw new WorkError('teloa/forbidden','授权的原件不存在、已撤回或不属于当前本人。')
   }else{
    // 契约只保证 36 位十六进制与连字符，未必是合法 uuid；先判形状再查，避免把格式问题变成数据库异常。
    const found=uuid(resource.id)?(await client.query('select 1 from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3 for share',[owner,resource.id,resource.version])).rows[0]:undefined
    if(!found)throw new WorkError('teloa/forbidden','授权的原件不存在、已撤回或不属于当前本人。')
   }
  }
 }

 private async resourcesAvailable(client:PoolClient,owner:string,groupId:string,resources:readonly GroupAgentResourceGrant[]):Promise<boolean>{
  try{await this.assertResources(client,owner,groupId,resources);return true}catch(error){if(error instanceof WorkError&&error.code==='teloa/forbidden')return false;throw error}
 }
}
