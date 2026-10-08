import type {Pool,PoolClient} from 'pg'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,taskInput,groupDefinition,type DigitalRole,type RoleWorkAuthorization,type RunRoleSnapshot,type TwinExecutionConsent,type GroupTaskSource} from '@teloa/contract'
import {createRunRoleSnapshot} from './run-role-snapshot.ts'
import {workAccess,combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'
import {roleWorkOwner,roleWorkUuid,roleWorkVersion,roleWorkInvalid,roleWorkTransaction,lockRoleWorkRole,assertRoleWorkRole,readRoleWorkAuthorization,assertRoleWorkAuthorizationTarget,readStoredTwinExecutionConsent,roleWorkEpoch} from './twin-execution-consents.ts'
import {readStoredRoleWorkDelegation,assertRoleDelegationFields,readRoleWorkGroupGrant} from './role-delegations.ts'
import {readGroupTaskSource} from './group-tasks.ts'
import {readTrustedGroupMessageRunSource} from './group-routing-outbox.ts'
import {readStoredTaskRun} from './task-runs.ts'
import {readStoredTask} from './tasks.ts'

export type RoleWorkEligibilityInput={roleId:string;expectedRoleVersion:number;scope:string;inputSchema:'teloa.task-run-input/v2';authorization:RoleWorkAuthorization;groupId:string|null}
/** null 表示沿已有 Task 工具/知识授权判据；数组表示本次必须取交集，空数组不能回落成全部。 */
export type RoleWorkExecutionLimits={allowedTools:string[]|null;knowledgeIds:string[]|null;memoryViewId:string|null;groupIds:string[]|null}
export type RoleWorkAdmission={role:DigitalRole;snapshot:RunRoleSnapshot;limits:RoleWorkExecutionLimits;assertCurrent:()=>void}
export class RoleWorkEligibilityService{
 readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 async authorize(owner:string,input:RoleWorkEligibilityInput,client?:PoolClient):Promise<RoleWorkAdmission>{
  return this.authorizeFixed(owner,input,client)
 }
 /** 已完成 Task 只证明原消息来源；真实当前群自动许可仍须独立核验，不能转回普通执行授权。 */
 async authorizeGroupRoutingSource(owner:string,input:{groupId:string;messageId:string},client?:PoolClient):Promise<RoleWorkAdmission>{
  roleWorkOwner(owner);const row=taskInput(input,['groupId','messageId']);if(!roleWorkUuid(row.groupId)||!roleWorkUuid(row.messageId))throw roleWorkInvalid()
  const authorize=async(db:PoolClient)=>{
   // 初读只取不可变消息/Run 候选；完整谱系读取可能锁 Plan，必须排在当前 Role 之后。
   const groupId=(row.groupId as string).toLowerCase(),messageId=(row.messageId as string).toLowerCase(),source=await readTrustedGroupMessageRunSource(db,owner,{groupId,messageId})
   if(!source)throw new WorkError('teloa/forbidden','群消息没有可信的已完成运行来源。')
   const role=await lockRoleWorkRole(db,owner,source.roleId,'share');assertRoleWorkRole(role,source.roleVersion)
   const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,source.runId])).rows[0]
   if(!raw)throw new WorkError('teloa/forbidden','源运行不属于本人。')
   const fixed=await readTrustedGroupMessageRunSource(db,owner,{groupId,messageId},this.pool);if(!fixed||!isDeepStrictEqual(fixed,source))throw new WorkError('teloa/storage-corrupt','原群消息来源已变化。')
   const run=readStoredTaskRun(raw),snapshot=run.roleSnapshot
   if(!snapshot||!run.lineage||run.state!=='ended'||run.groupContext?.groupId!==groupId||run.id!==source.runId||run.taskId!==source.taskId||run.roleId!==source.roleId||run.roleVersion!==source.roleVersion||!isDeepStrictEqual(run.lineage,source.lineage))throw new WorkError('teloa/storage-corrupt','群路由来源与原运行快照不一致。')
   if(role.id!==snapshot.id||role.version!==snapshot.version)throw new WorkError('teloa/storage-corrupt','原运行职责快照与来源身份不一致。')
   const stored=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,run.taskId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','原任务不属于该运行来源。')
   if(stored.state==='cancelled')throw new WorkError('teloa/conflict','已取消的任务不能继续群接力。')
   const task=readStoredTask(stored),original=JSON.parse(run.inputText).task
   if(task.assigneeRoleId!==role.id||task.assigneeRoleVersion!==role.version||task.scope!==original.scope||task.title!==original.title||task.goal!==original.goal)throw new WorkError('teloa/version-conflict','原任务内容或执行身份已变化，不能继续原消息接力。')
   let completedTarget:{scope:string;groupId:string|null}|undefined
   if(snapshot.authorization.kind==='task'){
    if(snapshot.authorization.taskId!==run.taskId)throw new WorkError('teloa/forbidden','原任务不属于该运行来源。')
    if(stored.state==='completed'){
     if((stored.content_version??1)!==snapshot.authorization.taskContentVersion)throw new WorkError('teloa/version-conflict','已完成来源的内容或身份版本已变化。')
     completedTarget={scope:task.scope,groupId:task.groupId??null}
    }
   }
   const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,groupId])).rows[0]
   if(!group||group.archived)throw new WorkError('teloa/forbidden','当前协作群已不可执行。')
   const scope=groupDefinition(group.definition).scope
   await readRoleWorkGroupGrant(db,owner,role,groupId,scope,true)
   const admission=await this.authorizeFixed(owner,{roleId:role.id,expectedRoleVersion:snapshot.version,scope,inputSchema:'teloa.task-run-input/v2',authorization:snapshot.authorization,groupId},db,completedTarget)
   if(admission.role.kind!==snapshot.kind||!isDeepStrictEqual(admission.snapshot.twinConsent,snapshot.twinConsent))throw new WorkError('teloa/version-conflict','原执行身份或分身本人回执已变化，不能继续原消息接力。')
   admission.assertCurrent();return admission
  }
  return client?authorize(client):roleWorkTransaction(this.pool,authorize)
 }
 private async authorizeFixed(owner:string,input:RoleWorkEligibilityInput,client?:PoolClient,completedTarget?:{scope:string;groupId:string|null}):Promise<RoleWorkAdmission>{
  roleWorkOwner(owner);const row=taskInput(input,['roleId','expectedRoleVersion','scope','inputSchema','authorization','groupId'])
  if(!roleWorkUuid(row.roleId)||!roleWorkVersion(row.expectedRoleVersion)||typeof row.scope!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(row.scope)||row.inputSchema!=='teloa.task-run-input/v2'||row.groupId!==null&&!roleWorkUuid(row.groupId))throw roleWorkInvalid()
  const authorization=readRoleWorkAuthorization(row.authorization),roleId=row.roleId.toLowerCase(),groupId=row.groupId===null?null:(row.groupId as string).toLowerCase(),scope=row.scope,expectedVersion=row.expectedRoleVersion
  const authorize=async(db:PoolClient):Promise<RoleWorkAdmission>=>{
   const role=await lockRoleWorkRole(db,owner,roleId,'share');assertRoleWorkRole(role,expectedVersion)
   const target=completedTarget??await assertRoleWorkAuthorizationTarget(db,owner,role,authorization)
   let groupSource:GroupTaskSource|null=null
   if(authorization.kind==='task'){
    const present=(await db.query("select to_regclass('teloa_group_task_sources') is not null as present")).rows[0].present
    if(present){
     const stored=(await db.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,authorization.taskId])).rows[0]
     if(stored){
      groupSource=readGroupTaskSource(stored)
      if(groupSource.ownerId!==owner||groupSource.taskId!==authorization.taskId||target.groupId!==null&&target.groupId!==groupSource.groupId)throw new WorkError('teloa/storage-corrupt','群任务定义与固定来源不一致，已停止核验执行。')
     }
    }
   }
   // 老群 Task 定义可能没有 groupId；真实固定来源仍决定隔离及本轮授权范围。
   const effectiveGroupId=groupSource?.groupId??target.groupId
   if(target.scope!==scope||authorization.kind==='task'&&effectiveGroupId!==groupId)throw new WorkError('teloa/forbidden','执行范围与持久任务或委托不一致。')
   let limits:RoleWorkExecutionLimits={allowedTools:null,knowledgeIds:null,memoryViewId:null,groupIds:groupId?[groupId]:null}
   if(authorization.kind==='delegation'){
    const stored=(await db.query('select * from teloa_role_work_delegations where owner_id=$1 and id=$2 for share',[owner,authorization.delegationId])).rows[0]
    const delegation=readStoredRoleWorkDelegation(stored)
    await assertRoleDelegationFields(db,owner,role,delegation)
    if(groupId!==null&&!delegation.groupIds.includes(groupId))throw new WorkError('teloa/forbidden','当前协作群未包含在本人委托范围。')
    if(delegation.memoryViewId!==null&&groupId!==null){
     const view=(await db.query('select group_id from teloa_role_memory_views where owner_id=$1 and id=$2',[owner,delegation.memoryViewId])).rows[0]
     if(!view||view.group_id!==groupId)throw new WorkError('teloa/forbidden','群记忆视图不属于本次执行群。')
    }
    limits={allowedTools:[...delegation.allowedTools],knowledgeIds:[...delegation.knowledgeIds],memoryViewId:groupId===null?null:delegation.memoryViewId,groupIds:[...delegation.groupIds]}
   }
   if(groupId!==null){
    // 客户端不能通过本轮输入把服务端固定的自动群任务声明成手动。
    const requireAutoRun=role.kind==='twin'||authorization.kind==='delegation'||groupSource!==null&&groupSource.trigger!=='manual'
    await readRoleWorkGroupGrant(db,owner,role,groupId,scope,requireAutoRun)
    // 群资料由 readRunGroupContext 按固定原件及版本加载；不能把私人资料中心知识带入群。
    limits.knowledgeIds=[]
   }
   let consent:TwinExecutionConsent|null=null
   if(role.kind==='twin'){
    const stored=(await db.query("select * from teloa_twin_execution_consents where owner_id=$1 and role_id=$2 and role_version=$3 and execution_authorization=$4::jsonb and state='active' for share",[owner,role.id,role.version,JSON.stringify(authorization)])).rows[0]
    if(!stored)throw new WorkError('teloa/forbidden','分身当前仅可代拟，请本人明确确认执行范围。')
    consent=readStoredTwinExecutionConsent(stored)
   }
   const leases:WorkAccessLease[]=[await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:role.id,operation:'run'})]
   if(groupId!==null)leases.push(await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:groupId,operation:'run'}))
   if(authorization.kind==='delegation')leases.push(await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:null,objectId:authorization.delegationId,operation:'run'}))
   const lease=combineWorkAccessLeases(leases),epoch=roleWorkEpoch(owner,role.id),snapshot=createRunRoleSnapshot(role,authorization,consent)
   const assertCurrent=()=>{
    if(roleWorkEpoch(owner,role.id)!==epoch)throw new WorkError('teloa/forbidden','执行授权已变化，请重新核对。')
    lease.assertCurrent()
   }
   assertCurrent();return {role,snapshot,limits,assertCurrent}
  }
  return client?authorize(client):roleWorkTransaction(this.pool,authorize)
 }
}
