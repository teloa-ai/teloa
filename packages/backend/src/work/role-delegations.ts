import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,roleSupportsScope,groupDefinition,isResourceSpec,readTaskRunFlow,type DigitalRole,type RoleWorkDelegation,type TwinExecutionConsent} from '@teloa/contract'
import {readGroupAgentGrant} from './group-agent-grants.ts'
import {readRoleToolGrant} from './role-tool-grants.ts'
import {readStoredRoleMemoryView} from './role-memory-views.ts'
import {readActiveAttachment} from './group-attachments.ts'
import {runEvidence} from './task-run-evidence.ts'
import type {WorkAccessLease} from './work-access.ts'
import {roleWorkOwner,roleWorkUuid,roleWorkVersion,roleWorkInvalid,roleWorkTransaction,lockRoleWorkRole,assertRoleWorkRole,authorizeOwnerWork,invalidateRoleWorkEligibility,readStoredTwinExecutionConsent,initializeTwinExecutionConsents,type RoleWorkIdentity,type OwnerWorkAuthority} from './twin-execution-consents.ts'

export type RoleDelegationFields=Omit<RoleWorkDelegation,'id'|'ownerId'|'roleId'|'roleVersion'|'version'|'state'|'createdAt'|'updatedAt'>
export type RoleDelegationChangeInput={requestId:string;roleId:string;expectedRoleVersion:number;expectedVersion:number|null;action:'save'|'pause'|'resume'|'end';fields?:RoleDelegationFields}
export type RoleExecutionConfiguration={roleId:string;roleVersion:number;delegations:RoleWorkDelegation[];consents:TwinExecutionConsent[];canEditExecution:boolean}
const fieldKeys=['scope','allowedTools','knowledgeIds','memoryViewId','groupIds','safeRecovery']
const corrupt=()=>new WorkError('teloa/storage-corrupt','执行委托记录损坏，已停止使用。')
function readFields(value:unknown):RoleDelegationFields{
 const row=taskInput(value,fieldKeys)
 const list=(v:unknown,valid:(item:unknown)=>item is string,max:number):string[]=>{
  if(!Array.isArray(v)||v.length>max||!v.every(valid)||new Set(v).size!==v.length)throw roleWorkInvalid()
  const result=v.map(item=>valid===roleWorkUuid?item.toLowerCase():item)
  if(new Set(result).size!==result.length)throw roleWorkInvalid()
  return result
 }
 if(typeof row.scope!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.scope)||row.memoryViewId!==null&&!roleWorkUuid(row.memoryViewId)||typeof row.safeRecovery!=='boolean')throw roleWorkInvalid()
 const names=(v:unknown):v is string=>typeof v==='string'&&/^[-a-zA-Z0-9_.]{1,128}$/.test(v)
 return {scope:row.scope,allowedTools:list(row.allowedTools,names,256),knowledgeIds:list(row.knowledgeIds,roleWorkUuid,8).map(id=>id.toLowerCase()),memoryViewId:row.memoryViewId===null?null:(row.memoryViewId as string).toLowerCase(),groupIds:list(row.groupIds,roleWorkUuid,30).map(id=>id.toLowerCase()),safeRecovery:row.safeRecovery}
}
export function readStoredRoleWorkDelegation(row:Record<string,unknown>):RoleWorkDelegation{
 try{
  const fields=readFields(row.fields)
  if(!roleWorkUuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!roleWorkUuid(row.role_id)||!roleWorkVersion(row.role_version)||!roleWorkVersion(row.version)||!['active','pausing','paused','ending','ended'].includes(String(row.state))||!(row.created_at instanceof Date)||!(row.updated_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||!Number.isFinite(row.updated_at.getTime())||row.updated_at<row.created_at)throw Error()
  return {...fields,id:row.id,ownerId:row.owner_id,roleId:row.role_id,roleVersion:row.role_version,version:row.version,state:row.state as RoleWorkDelegation['state'],createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}
 }catch{throw corrupt()}
}
export async function initializeRoleDelegations(pool:Pool):Promise<void>{
 await initializeTwinExecutionConsents(pool)
 await pool.query(`
  create table if not exists teloa_role_work_delegations(
   id uuid primary key,owner_id text not null,role_id uuid not null,role_version integer not null check(role_version>0),
   version integer not null check(version>0),state text not null check(state in ('active','pausing','paused','ending','ended')),
   fields jsonb not null check(jsonb_typeof(fields)='object'),created_at timestamptz not null,updated_at timestamptz not null,
   unique(role_id,role_version),foreign key(role_id,owner_id) references teloa_roles(id,owner_id)
  );
  create table if not exists teloa_role_work_delegation_requests(
   owner_id text not null,request_id uuid not null,delegation_id uuid not null references teloa_role_work_delegations(id),
   request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),result jsonb not null check(jsonb_typeof(result)='object'),
   primary key(owner_id,request_id)
  );
 `)
}
/** 保守核验现有持久回执；整项谱系及控制驱动在 P2.2 接入，未知关联一律不算已收口。 */
export async function roleWorkOutstanding(db:PoolClient,owner:string,roleId:string):Promise<boolean>{
 const required=['teloa_task_runs','teloa_task_run_subagents','teloa_task_run_runtime_links','teloa_task_run_flows']
 const present=(await db.query('select name,to_regclass(name) is not null as present from unnest($1::text[]) name',[required])).rows
 if(present.some(row=>!row.present))throw new WorkError('teloa/unavailable','执行与子工作回执尚未就绪，不能判定已暂停。')
 const runs=(await db.query('select id,state,evidence from teloa_task_runs where owner_id=$1 and role_id=$2 for share',[owner,roleId])).rows
 for(const run of runs){
  if(!['ended','withdrawn','configuration_failed'].includes(run.state))return true
  if(run.state==='ended'){try{if(runEvidence(run.evidence).state!=='ended')return true}catch{return true}}
 }
 const ids=runs.map(run=>run.id);if(!ids.length)return false
 const children=(await db.query('select run_id,reservation_id,state from teloa_task_run_subagents where owner_id=$1 and run_id=any($2::uuid[]) for share',[owner,ids])).rows
 if(children.some(child=>!['ended','abandoned'].includes(child.state)))return true
 const flows=(await db.query('select * from teloa_task_run_flows where owner_id=$1 and run_id=any($2::uuid[]) for share',[owner,ids])).rows
 for(const flow of flows){
  if(!['completed','compensated'].includes(flow.state))return true
  try{readTaskRunFlow({flowId:flow.flow_id,runId:flow.run_id,definitionVersion:flow.definition_version,state:flow.state,steps:flow.steps,createdAt:flow.created_at.toISOString(),updatedAt:flow.updated_at.toISOString()})}catch{return true}
 }
 const links=(await db.query('select run_id,native_id,session_id,kind,payload from teloa_task_run_runtime_links where owner_id=$1 and run_id=any($2::uuid[]) for share',[owner,ids])).rows
 for(const link of links){
  const payload=link.payload
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||typeof payload.runtimeId!=='string'&&link.kind!=='team'||!roleWorkUuid(payload.requestId))return true
  const keys=Object.keys(payload)
  if(link.kind==='browser'){
   if(keys.length!==4||!['runtimeId','requestId','dispatchId','status'].every(key=>keys.includes(key))||typeof payload.dispatchId!=='string'||!payload.runtimeId||!payload.dispatchId||link.native_id!==`${payload.runtimeId}:${payload.dispatchId}`||payload.status!=='closed')return true
  }
  else if(link.kind==='team'){
   if(keys.length!==3||!['requestId','reservationId','name'].every(key=>keys.includes(key))||typeof payload.reservationId!=='string'||!payload.reservationId||typeof payload.name!=='string'||!payload.name||link.native_id!==payload.reservationId)return true
   if(!children.some(child=>child.run_id===link.run_id&&child.reservation_id===payload.reservationId&&['ended','abandoned'].includes(child.state)))return true
  }else if(link.kind==='job'){
   if(!payload.runtimeId)return true
   if(payload.record==='job'){
    if(keys.length!==5||!['record','runtimeId','requestId','jobId','status'].every(key=>keys.includes(key))||typeof payload.jobId!=='string'||!payload.jobId||link.native_id!==`${payload.runtimeId}:${payload.jobId}`||!['completed','killed','failed'].includes(payload.status))return true
   }
   else if(payload.record==='owner'){
    if(keys.length!==3||!['record','runtimeId','requestId'].every(key=>keys.includes(key))||link.native_id!==`owner:${payload.runtimeId}:${link.session_id}`)return true
    if(!links.some(candidate=>candidate.run_id===link.run_id&&candidate.kind==='job'&&candidate.payload?.record==='job'&&candidate.payload.runtimeId===payload.runtimeId&&candidate.payload.requestId===payload.requestId&&['completed','killed','failed'].includes(candidate.payload.status)))return true
   }else return true
  }else return true
 }
 return false
}
/** 调用者保持角色行锁直到工具/定义变更提交；此函数不改变默认分身身份。 */
export async function assertRoleDelegationsInactive(db:PoolClient,owner:string,role:DigitalRole):Promise<void>{
 roleWorkOwner(owner)
 const current=await lockRoleWorkRole(db,owner,role.id)
 if(current.version!==role.version)throw new WorkError('teloa/version-conflict','执行身份已变化，请核对新版本。')
 const active=(await db.query("select 1 from teloa_role_work_delegations where owner_id=$1 and role_id=$2 and role_version=$3 and state in ('active','pausing','ending') limit 1",[owner,role.id,role.version])).rowCount
 if(active||await roleWorkOutstanding(db,owner,role.id))throw new WorkError('teloa/conflict','请先停用执行委托并等待运行及子工作收口，再配置执行权限。')
}
export async function assertRoleDelegationFields(db:PoolClient,owner:string,role:DigitalRole,fields:RoleDelegationFields):Promise<void>{
 if(!roleSupportsScope(role.scopes,fields.scope))throw new WorkError('teloa/forbidden','委托超出当前角色业务范围。')
 if(fields.allowedTools.length){
  const row=(await db.query('select * from teloa_role_tool_grants where role_id=$1 order by role_version desc limit 1 for share',[role.id])).rows[0]
  const grant=row?readRoleToolGrant(row):null
  if(!grant||grant.state!=='active'||grant.roleVersion>role.version||fields.allowedTools.some(name=>!grant.rules.some(rule=>rule.name===name)))throw new WorkError('teloa/forbidden','委托工具必须收窄到本人已授予的工具范围。')
 }
 for(const resourceId of fields.knowledgeIds){
  if(!role.knowledge.includes(resourceId))throw new WorkError('teloa/forbidden','委托资料必须属于当前角色已配置知识。')
  const row=(await db.query('select * from teloa_resources where owner_id=$1 and id=$2 for share',[owner,resourceId])).rows[0]
  if(!row||row.status!=='active'||!isResourceSpec(row.spec)||!row.spec.scopeIds.includes(fields.scope))throw new WorkError('teloa/forbidden','委托资料不属于本人当前可用业务范围。')
 }
 for(const groupId of fields.groupIds){
  await readRoleWorkGroupGrant(db,owner,role,groupId,fields.scope,false)
  // 同一职责可分别处理本人资料与群协作；实际群目标由统一资格服务强制 knowledgeIds=[]。
  // 群原件仍只由当前群授权提供，私人资料 ID 不会变成群可见来源。
 }
 if(fields.memoryViewId!==null){
  const present=(await db.query("select to_regclass('teloa_role_memory_views') is not null as present")).rows[0].present
  if(!present)throw new WorkError('teloa/forbidden','群记忆视图尚未就绪。')
  const view=await readStoredRoleMemoryView(db,owner,fields.memoryViewId)
  if(view.roleId!==role.id||view.roleVersion!==role.version||!fields.groupIds.includes(view.groupId))throw new WorkError('teloa/forbidden','记忆视图不属于当前角色版本及委托群范围。')
 }
}
export async function readRoleWorkGroupGrant(db:PoolClient,owner:string,role:DigitalRole,groupId:string,scope:string,requireAutoRun=true){
 const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,groupId])).rows[0]
 if(!group||group.archived)throw new WorkError('teloa/forbidden','协作群不属于本人当前业务范围。')
 const definition=groupDefinition(group.definition)
 if(definition.scope!==scope||!definition.memberRoleIds.includes(role.id))throw new WorkError('teloa/forbidden','协作群不属于当前执行身份和业务范围。')
 if(!(await db.query('select 1 from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3 for share',[owner,groupId,role.id])).rowCount)throw new WorkError('teloa/forbidden','执行身份不是当前群成员。')
 const row=(await db.query('select * from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version desc limit 1 for share',[owner,groupId,role.id])).rows[0]
 const grant=row?readGroupAgentGrant(row):null
 if(!grant||grant.state!=='active'||grant.groupVersion!==group.version||grant.roleVersion!==role.version||requireAutoRun&&!grant.canAutoRun)throw new WorkError('teloa/forbidden','当前群缺少有效的执行范围授权。')
 for(const reference of grant.resources){
  let present:boolean
  if(reference.kind==='group-resource')present=Boolean((await db.query(`select 1 from teloa_group_resource_versions v join teloa_group_resources r on r.id=v.resource_id and r.owner_id=v.owner_id and r.group_id=v.group_id
   where v.owner_id=$1 and v.group_id=$2 and v.resource_id=$3 and v.version=$4 and r.withdrawn_at is null for share of v,r`,[owner,groupId,reference.id,reference.version])).rowCount)
  else if(reference.kind==='attachment')present=Boolean(await readActiveAttachment(db,owner,reference.id))
  else present=roleWorkUuid(reference.id)&&Boolean((await db.query('select 1 from teloa_artifact_versions where owner_id=$1 and artifact_id=$2 and number=$3 for share',[owner,reference.id,reference.version])).rowCount)
  if(!present)throw new WorkError('teloa/forbidden','群执行授权的原件已撤回或不再可见。')
 }
 return grant
}
function changeInput(owner:string,input:unknown):RoleDelegationChangeInput{
 roleWorkOwner(owner);const row=taskInput(input,['requestId','roleId','expectedRoleVersion','expectedVersion','action','fields'])
 if(!roleWorkUuid(row.requestId)||!roleWorkUuid(row.roleId)||!roleWorkVersion(row.expectedRoleVersion)||row.expectedVersion!==null&&!roleWorkVersion(row.expectedVersion)||!['save','pause','resume','end'].includes(String(row.action)))throw roleWorkInvalid()
 if(row.action==='save'?row.fields===undefined:row.fields!==undefined)throw roleWorkInvalid()
 return {requestId:row.requestId.toLowerCase(),roleId:row.roleId.toLowerCase(),expectedRoleVersion:row.expectedRoleVersion,expectedVersion:row.expectedVersion as number|null,action:row.action as RoleDelegationChangeInput['action'],...(row.fields===undefined?{}:{fields:readFields(row.fields)})}
}
export class RoleDelegationService{
 readonly pool:Pool
 readonly identity:RoleWorkIdentity
 readonly ownerAuthority:OwnerWorkAuthority|undefined
 constructor(pool:Pool,identity:RoleWorkIdentity,ownerAuthority?:OwnerWorkAuthority){this.pool=pool;this.identity=identity;this.ownerAuthority=ownerAuthority}
 async get(owner:string,input:{roleId:string}):Promise<RoleExecutionConfiguration>{
  roleWorkOwner(owner);const row=taskInput(input,['roleId']);if(!roleWorkUuid(row.roleId))throw roleWorkInvalid()
  return roleWorkTransaction(this.pool,async db=>{
   const role=await lockRoleWorkRole(db,owner,row.roleId as string)
   const delegations=(await db.query('select * from teloa_role_work_delegations where owner_id=$1 and role_id=$2 order by role_version desc,created_at,id',[owner,role.id])).rows.map(readStoredRoleWorkDelegation)
   const consents=(await db.query('select * from teloa_twin_execution_consents where owner_id=$1 and role_id=$2 order by role_version desc,created_at,id',[owner,role.id])).rows.map(readStoredTwinExecutionConsent)
   let canEditExecution=false
   if(role.kind==='twin'?role.state==='active':role.state==='paused'){
    try{await assertRoleDelegationsInactive(db,owner,role);canEditExecution=true}catch(error){if(!(error instanceof WorkError)||!['teloa/conflict','teloa/unavailable'].includes(error.code))throw error}
   }
   return {roleId:role.id,roleVersion:role.version,delegations,consents,canEditExecution}
  })
 }
 async change(owner:string,input:RoleDelegationChangeInput):Promise<RoleWorkDelegation>{
  const command=changeInput(owner,input),{requestId,...fields}=command,spec=JSON.stringify(fields)
  return roleWorkTransaction(this.pool,async db=>{
   const role=await lockRoleWorkRole(db,owner,command.roleId)
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/role-delegation-request',owner,requestId])])
   const prior=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_role_work_delegation_requests where owner_id=$1 and request_id=$2',[owner,requestId,spec])).rows[0]
   if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一委托请求不能更换操作或范围。');return this.priorResult(prior,owner,role.id)}
   if(role.version!==command.expectedRoleVersion)throw new WorkError('teloa/version-conflict','角色版本已变化，请本人复核新范围。')
   const row=(await db.query('select * from teloa_role_work_delegations where owner_id=$1 and role_id=$2 order by role_version desc limit 1 for update',[owner,role.id])).rows[0]
   const latest=row?readStoredRoleWorkDelegation(row):null,current=latest?.roleVersion===role.version?latest:null
   if(command.action!=='save'&&latest&&latest.roleVersion!==role.version)throw new WorkError('teloa/version-conflict','旧角色版本的委托不能自动续签。')
   if(current?command.expectedVersion!==current.version:command.expectedVersion!==null)throw new WorkError('teloa/version-conflict','执行委托版本已变化。')
   if(command.action!=='save'&&!current)throw new WorkError('teloa/not-found','当前角色尚无执行委托。')
   let state:RoleWorkDelegation['state'],nextFields:RoleDelegationFields,lease:WorkAccessLease|undefined
   if(command.action==='save'||command.action==='resume'){
    assertRoleWorkRole(role,command.expectedRoleVersion)
    if(current&&(command.action==='resume'?current.state!=='paused':!['paused','ended'].includes(current.state)))throw new WorkError('teloa/conflict','请先停用委托再修改或恢复执行范围。')
    if(await roleWorkOutstanding(db,owner,role.id))throw new WorkError('teloa/conflict','执行及子工作尚未收口，不能授予新委托。')
    nextFields=command.fields??readFields(row.fields);await assertRoleDelegationFields(db,owner,role,nextFields)
    lease=await authorizeOwnerWork(this.ownerAuthority,owner,{requestId,roleId:role.id,operation:command.action});state='active'
   }else{
    nextFields=readFields(row.fields)
    if(command.action==='pause'){
     if(current!.state==='ending'||current!.state==='ended')throw new WorkError('teloa/conflict','正在结束或已结束的委托不能暂停。')
     state=await roleWorkOutstanding(db,owner,role.id)?'pausing':'paused'
    }else state=current!.state==='ended'?'ended':await roleWorkOutstanding(db,owner,role.id)?'ending':'ended'
   }
   const now=this.identity.now(),saved=current?(await db.query('update teloa_role_work_delegations set fields=$3,state=$4,version=version+1,updated_at=$5 where owner_id=$1 and id=$2 returning *',[owner,current.id,JSON.stringify(nextFields),state,now])).rows[0]:(await db.query('insert into teloa_role_work_delegations(id,owner_id,role_id,role_version,version,state,fields,created_at,updated_at) values($1,$2,$3,$4,1,$5,$6,$7,$7) returning *',[this.identity.id(),owner,role.id,role.version,state,JSON.stringify(nextFields),now])).rows[0]
   const result=readStoredRoleWorkDelegation(saved);lease?.assertCurrent()
   await db.query('insert into teloa_role_work_delegation_requests(owner_id,request_id,delegation_id,request_spec,result) values($1,$2,$3,$4,$5)',[owner,requestId,result.id,spec,JSON.stringify(result)])
   invalidateRoleWorkEligibility(owner,role.id);lease?.assertCurrent();return result
  })
 }
 /** 由停止回执驱动调用，读取接口绝不自行把 pausing/ending 改成终态。 */
 async reconcile(owner:string,input:{roleId:string;expectedVersion:number}):Promise<RoleWorkDelegation>{
  roleWorkOwner(owner);const row=taskInput(input,['roleId','expectedVersion']);if(!roleWorkUuid(row.roleId)||!roleWorkVersion(row.expectedVersion))throw roleWorkInvalid()
  return roleWorkTransaction(this.pool,async db=>{
   const role=await lockRoleWorkRole(db,owner,row.roleId as string)
   const stored=(await db.query('select * from teloa_role_work_delegations where owner_id=$1 and role_id=$2 order by role_version desc limit 1 for update',[owner,role.id])).rows[0]
   if(!stored)throw new WorkError('teloa/not-found','执行委托不存在。')
   const current=readStoredRoleWorkDelegation(stored)
   if(current.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','委托版本已变化。')
   if(!['pausing','ending'].includes(current.state)||await roleWorkOutstanding(db,owner,role.id))return current
   const result=readStoredRoleWorkDelegation((await db.query('update teloa_role_work_delegations set state=$3,version=version+1,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,current.id,current.state==='pausing'?'paused':'ended',this.identity.now()])).rows[0])
   invalidateRoleWorkEligibility(owner,role.id);return result
  })
 }
 private priorResult(row:Record<string,unknown>,owner:string,roleId:string):RoleWorkDelegation{
  try{
   const result=taskInput(row.result,['id','ownerId','roleId','roleVersion','version','state','createdAt','updatedAt',...fieldKeys])
   if(result.ownerId!==owner||result.roleId!==roleId||result.id!==row.delegation_id)throw Error()
   const {id,ownerId,roleId:fixedRoleId,roleVersion,version,state,createdAt,updatedAt,...fields}=result
   return readStoredRoleWorkDelegation({id,owner_id:ownerId,role_id:fixedRoleId,role_version:roleVersion,version,state,fields,created_at:new Date(createdAt as string),updated_at:new Date(updatedAt as string)})
  }catch{throw corrupt()}
 }
}
