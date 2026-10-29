import {readActiveGroupWorkResource} from './group-work-resources.ts'
import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,roleKnowledgeMaxReferences,taskInput,roleSupportsScope,groupDefinition,isResourceSpec,readTaskRunFlow,groupRunResultManifest,type DigitalRole,type RoleWorkDelegation,type TwinExecutionConsent} from '@teloa/contract'
import {readGroupAgentGrant} from './group-agent-grants.ts'
import {readRoleToolGrant} from './role-tool-grants.ts'
import {readStoredRoleMemoryView} from './role-memory-views.ts'
import {readActiveAttachment} from './group-attachments.ts'
import {runEvidence} from './task-run-evidence.ts'
import {readStoredTaskRun,type TaskRun} from './task-runs.ts'
import {readTaskRunOwnerSettlement} from './task-run-runtime-links.ts'
import {readStoredRunPlanReport} from './task-run-plan-context.ts'
import {readStoredGroupMessage} from './group-message-presentation.ts'
import {readTrustedGroupMessageRunSource} from './group-routing-outbox.ts'
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
 return {scope:row.scope,allowedTools:list(row.allowedTools,names,256),knowledgeIds:list(row.knowledgeIds,roleWorkUuid,roleKnowledgeMaxReferences).map(id=>id.toLowerCase()),memoryViewId:row.memoryViewId===null?null:(row.memoryViewId as string).toLowerCase(),groupIds:list(row.groupIds,roleWorkUuid,30).map(id=>id.toLowerCase()),safeRecovery:row.safeRecovery}
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
/**
 * 群交付独立于原生结束；completed 只消费原Run唯一、可信且无待送的原群回执。
 * 失败终态（error、cancelled 等）按契约没有应交付成果：`TaskRunService.record` 只在 completed 时排群发布，
 * `GroupRunMessageService` 也拒绝非 completed 的发布回执。这类 Run 只在宿主已登记收口证明（非 legacy 路径）
 * 且库中没有任何发布残留——无待发布、无结果文件、无以该 Run 为作者的群回帖、无未定案 outbox——时才算收口；
 * 零工具旧例外不对失败终态放行，不伪造成功交付。
 */
async function settledOwnerGroupDelivery(db:PoolClient,owner:string,raw:Record<string,unknown>,run:TaskRun,legacy:boolean):Promise<boolean>{
 const plan=readStoredRunPlanReport(raw),context=run.groupContext
 if(!context&&!plan)return true
 if(run.evidence?.state!=='ended'||raw.group_publication!=null||raw.group_publication_next_at!=null)return false
 const manifest=groupRunResultManifest(raw.group_result_manifest)
 if(legacy&&manifest.files.length)return false
 const schema=(await db.query("select to_regclass('teloa_group_run_sources') sources,to_regclass('teloa_group_routing_wakes') wakes,to_regclass('teloa_group_routing_outbox') outbox")).rows[0]
 if(!schema?.sources||!schema.wakes||!schema.outbox)return false
 const rows=(await db.query('select * from teloa_group_messages where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows
 if(run.evidence.reason!=='completed'){
  if(legacy||manifest.files.length||rows.length)return false
  return !(await db.query("select 1 from teloa_group_routing_outbox where owner_id=$1 and run_id=$2 and state<>'settled' limit 1 for share",[owner,run.id])).rowCount
 }
 if(rows.length!==1)return false
 const row=rows[0]!,message=readStoredGroupMessage(row),groupId=context?.groupId??plan!.reportGroup.groupId,rootId=context?.source.rootId??null,requestId=plan?.occurrenceId??run.nativeRequestId
 if(!('runId'in message)||message.runId!==run.id||message.taskId!==run.taskId||message.authorId!==run.roleId||message.groupId!==groupId||message.rootId!==rootId||row.request_id!==requestId)return false
 const source=await readTrustedGroupMessageRunSource(db,owner,{groupId,messageId:message.id})
 if(!source||source.runId!==run.id)return false
 const wake=(await db.query('select state from teloa_group_routing_wakes where owner_id=$1 and message_id=$2 for share',[owner,message.id])).rows[0]
 if(wake?.state!=='settled')return false
 return !(await db.query("select 1 from teloa_group_routing_outbox where owner_id=$1 and (run_id=$2 or (message_id=$3 and role_id=$4)) and state<>'settled' limit 1 for share",[owner,run.id,message.id,run.roleId])).rowCount
}

async function settledOwnerEffects(db:PoolClient,owner:string,taskId:string):Promise<boolean>{
 const schema=(await db.query("select to_regclass('teloa_security_actions') actions,to_regclass('teloa_security_action_executions') executions")).rows[0]
 if(!schema?.actions||!schema.executions)return false
 return !(await db.query("select 1 from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where a.owner_id=$1 and a.task_id=$2 and e.state not in ('succeeded','failed') limit 1",[owner,taskId])).rowCount
}
/** 保守核验现有持久回执；整项谱系及控制驱动在 P2.2 接入，未知关联一律不算已收口。
 * 传入 scope.taskId 时只核验该任务名下的全部执行（不限岗位），且不对回执行加共享锁：
 * 调用方须已持有该 teloa_tasks 行的 for update 锁作为串行点，与 prepare/claim/record 的「run 锁 → task 锁」次序兼容，避免反向等待。 */
export async function roleWorkOutstanding(db:PoolClient,owner:string,roleId:string,scope?:{taskId:string}):Promise<boolean>{
 const required=['teloa_task_runs','teloa_task_run_subagents','teloa_task_run_runtime_links','teloa_task_run_flows']
 const present=(await db.query('select name,to_regclass(name) is not null as present from unnest($1::text[]) name',[required])).rows
 if(present.some(row=>!row.present))throw new WorkError('teloa/unavailable','执行与子工作回执尚未就绪，不能判定已暂停。')
 const share=scope?'':' for share'
 const runs=(await db.query(scope?'select id,state,evidence from teloa_task_runs where owner_id=$1 and task_id=$2':'select id,state,evidence from teloa_task_runs where owner_id=$1 and role_id=$2 for share',[owner,scope?scope.taskId:roleId])).rows
 for(const run of runs){
  if(!['ended','withdrawn','configuration_failed'].includes(run.state))return true
  if(run.state==='ended'){try{if(runEvidence(run.evidence).state!=='ended')return true}catch{return true}}
 }
 const ids=runs.map(run=>run.id);if(!ids.length)return false
 const children=(await db.query('select run_id,reservation_id,state from teloa_task_run_subagents where owner_id=$1 and run_id=any($2::uuid[])'+share,[owner,ids])).rows
 if(children.some(child=>!['ended','abandoned'].includes(child.state)))return true
 const flows=(await db.query('select * from teloa_task_run_flows where owner_id=$1 and run_id=any($2::uuid[])'+share,[owner,ids])).rows
 for(const flow of flows){
  if(!['completed','compensated'].includes(flow.state))return true
  try{readTaskRunFlow({flowId:flow.flow_id,runId:flow.run_id,definitionVersion:flow.definition_version,state:flow.state,steps:flow.steps,createdAt:flow.created_at.toISOString(),updatedAt:flow.updated_at.toISOString()})}catch{return true}
 }
 const links=(await db.query('select run_id,native_id,session_id,kind,payload,owner_settlement from teloa_task_run_runtime_links where owner_id=$1 and run_id=any($2::uuid[])'+share,[owner,ids])).rows
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
    if(!links.some(candidate=>candidate.run_id===link.run_id&&candidate.kind==='job'&&candidate.payload?.record==='job'&&candidate.payload.runtimeId===payload.runtimeId&&candidate.payload.requestId===payload.requestId&&['completed','killed','failed'].includes(candidate.payload.status))){
     // owner 是发送前的宿主登记，并非实际 job。新宿主回执证明真实资源收口；
     // 旧零工具、零技能例外仍严格保留，群工作另外核对唯一可信交付。历史登记不删除。
     if(links.filter(row=>row.run_id===link.run_id).length!==1||children.some(row=>row.run_id===link.run_id)||flows.some(row=>row.run_id===link.run_id))return true
     const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,link.run_id])).rows[0]
     try{
      if(!Array.isArray(raw?.allowed_tools)||!Array.isArray(raw?.role_skills))return true
      const run=readStoredTaskRun(raw)
      if(run.state!=='ended'||run.evidence?.state!=='ended'||run.flowId!==undefined||run.sessionId!==link.session_id||run.nativeRequestId!==payload.requestId)return true
      if(link.owner_settlement!==null&&link.owner_settlement!==undefined){
       const proof=readTaskRunOwnerSettlement(link.owner_settlement)
       if(proof.runId!==run.id||proof.nativeId!==link.native_id||proof.sessionId!==run.sessionId||proof.nativeRequestId!==run.nativeRequestId||proof.inputSha256!==createHash('sha256').update(run.inputText).digest('hex')||!isDeepStrictEqual(proof.evidence,run.evidence)||proof.observedAt<run.createdAt)return true
       if(!await settledOwnerEffects(db,owner,run.taskId)||!await settledOwnerGroupDelivery(db,owner,raw,run,false))return true
      }else{
       if(run.allowedTools.length||run.skills.length)return true
       if(run.groupContext!==undefined||readStoredRunPlanReport(raw)){if(!await settledOwnerEffects(db,owner,run.taskId)||!await settledOwnerGroupDelivery(db,owner,raw,run,true))return true}
      }
     }catch{return true}
    }
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
 if(definition.scope!==scope&&definition.scope!=='general'||!roleSupportsScope(role.scopes,scope)||!definition.memberRoleIds.includes(role.id))throw new WorkError('teloa/forbidden','协作群不属于当前执行身份和业务范围。')
 if(!(await db.query('select 1 from teloa_group_members where owner_id=$1 and group_id=$2 and role_id=$3 for share',[owner,groupId,role.id])).rowCount)throw new WorkError('teloa/forbidden','执行身份不是当前群成员。')
 const row=(await db.query('select * from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version desc limit 1 for share',[owner,groupId,role.id])).rows[0]
 const grant=row?readGroupAgentGrant(row):null
 if(!grant||grant.state!=='active'||grant.groupVersion!==group.version||grant.roleVersion!==role.version||requireAutoRun&&!grant.canAutoRun)throw new WorkError('teloa/forbidden','当前群缺少有效的执行范围授权。')
 for(const reference of grant.resources){
  let present:boolean
  if(reference.kind==='group-resource')present=Boolean((await db.query(`select 1 from teloa_group_resource_versions v join teloa_group_resources r on r.id=v.resource_id and r.owner_id=v.owner_id and r.group_id=v.group_id
   where v.owner_id=$1 and v.group_id=$2 and v.resource_id=$3 and v.version=$4 and r.withdrawn_at is null for share of v,r`,[owner,groupId,reference.id,reference.version])).rowCount)
  else if(reference.kind==='work-resource'){await readActiveGroupWorkResource(db,owner,groupId,reference);present=true}
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
