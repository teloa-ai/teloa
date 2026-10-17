import type {Pool,PoolClient} from 'pg'
import {WorkError,readWorkExecutor,type WorkExecutor} from '@teloa/contract'
import {readStoredConversationWorkRequest} from './conversation-work.ts'
import {workRequestChildId} from './conversation-work-task-protection.ts'
import {ownerWorkLease} from './owner-work-epochs.ts'
import {workAccess,combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'
import type {OwnerPlanAuthority,OwnerPlanPolicy} from './owner-plan-authority.ts'
import {readStoredPlan} from './plans.ts'
import {verifyOwnerPlan} from './owner-plans.ts'
import type {TaskRun} from './task-runs.ts'
import {readOwnerTaskRun} from './owner-task-run-snapshot.ts'
import {isDeepStrictEqual} from 'node:util'

export type OwnerExecutor=Extract<WorkExecutor,{kind:'owner'}>
export type AcceptedWorkSource={sessionId:string;messageId:string;messageSeq:number;requestId:string}
export type OwnerConversationGrant={executor:OwnerExecutor;source:AcceptedWorkSource;scope:'general';plan?:never}
export type OwnerWorkGrant=OwnerConversationGrant|{executor:OwnerExecutor;source?:AcceptedWorkSource;scope:'general';plan:{planId:string;configVersion:number;policy:OwnerPlanPolicy}}
/** 原交办已持久化并核过原生受理消息；它就是不可转移的本人授权，不另建可失配的授权副本。 */
export class OwnerWorkAuthority{
 readonly pool:Pool
 readonly ownerPlans:OwnerPlanAuthority|undefined
 constructor(pool:Pool,ownerPlans?:OwnerPlanAuthority){this.pool=pool;this.ownerPlans=ownerPlans}
 async capture(owner:string,source:AcceptedWorkSource):Promise<OwnerConversationGrant>{
  const db=await this.pool.connect()
  try{await db.query('begin');const grant=await this.current(db,owner,{kind:'owner',grantId:source.requestId,grantVersion:1})
   if(grant.plan||!grant.source||JSON.stringify(grant.source)!==JSON.stringify({sessionId:source.sessionId,messageId:source.messageId,messageSeq:source.messageSeq,requestId:source.requestId}))throw new WorkError('teloa/forbidden','本人原消息与已受理交办不一致。')
   grant.admission.assertCurrent();await db.query('commit');return {executor:grant.executor,source:grant.source,scope:'general'}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async assertCurrent(owner:string,executor:OwnerExecutor,_phase:'prepare'|'start'|'resume'|'commit'):Promise<void>{
  const db=await this.pool.connect();try{await db.query('begin');(await this.current(db,owner,executor)).admission.assertCurrent();await db.query('commit')}catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 只允许原已受理并完成的计划 Run 落原成果；不会返回可用于新输入的 current 准入。 */
 async currentCompletedPlanRun(db:PoolClient,owner:string,run:TaskRun):Promise<OwnerWorkGrant&{admission:WorkAccessLease}>{
  const stored=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,run.id])).rows[0]
  if(!stored||!Number.isSafeInteger(stored.task_state_version)||stored.task_state_version<1)throw new WorkError('teloa/forbidden','未受理的工作不能使用成果落定通道。')
  const actual=readOwnerTaskRun(stored),executor=actual.executor
  if(!executor||executor.kind!=='owner'||actual.state!=='ended'||actual.evidence?.state!=='ended'||actual.evidence.reason!=='completed'||actual.stopRequestedAt!==null||actual.nativeRequestId!==run.nativeRequestId||actual.inputText!==run.inputText||actual.taskId!==run.taskId||actual.lineage?.definition?.planId!==executor.grantId||actual.lineage.definition.definitionVersion!==executor.grantVersion)throw new WorkError('teloa/forbidden','原计划完成证据不一致。')
  const plan=readStoredPlan((await db.query('select * from teloa_plans where owner_id=$1 and id=$2 for share',[owner,executor.grantId])).rows[0])
  if(plan.roleId!==null||plan.executor.grantVersion!==executor.grantVersion||plan.source.kind!=='method-reuse'||!['active','paused'].includes(plan.state))throw new WorkError('teloa/forbidden','原计划来源或配置已经变化。')
  const row=(await db.query('select o.* from teloa_plan_task_links l join teloa_plan_occurrences o on o.id=l.claim_id and o.owner_id=l.owner_id where l.owner_id=$1 and l.task_id=$2 and o.id=$3 and l.task_request_id=o.task_request_id for share of l,o',[owner,actual.taskId,stored.request_id])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','原完成工作没有固定计划领取。')
  const {readStoredPlanOccurrence}=await import('./plan-occurrences.ts'),claim=readStoredPlanOccurrence(row)
  if(claim.planId!==plan.id||claim.configVersion!==plan.configVersion||!isDeepStrictEqual(claim.workDefinition,plan.workDefinition)||!isDeepStrictEqual(claim.source,plan.source)||JSON.parse(actual.inputText).planContext?.occurrenceId!==claim.id)throw new WorkError('teloa/forbidden','完成工作不能借其他计划的授权落定成果。')
  const admission=await verifyOwnerPlan(db,owner,plan,this.ownerPlans,plan.state==='paused')
  return {executor,...(plan.source.acceptedSource?{source:plan.source.acceptedSource}:{}),scope:'general',plan:{planId:plan.id,configVersion:plan.configVersion,policy:plan.ownerGrant.policy},admission}
 }
 async current(db:PoolClient,owner:string,input:OwnerExecutor):Promise<OwnerWorkGrant&{admission:WorkAccessLease}>{
  const executor=readWorkExecutor(input)
  if(executor.kind!=='owner'||!owner)throw new WorkError('teloa/forbidden','本人执行授权不正确。')
  // 本人准入是原请求只读操作。共享行锁与停止写入串行，不与派发/目录读的 advisory 锁争用。
  const parent=(await db.query('select * from teloa_conversation_work_requests where owner_id=$1 and request_id=$2 for share',[owner,executor.grantId])).rows[0]
  const hasPlans=(await db.query("select to_regclass('teloa_plans') as relation")).rows[0]?.relation
  const storedPlan=hasPlans?(await db.query('select * from teloa_plans where owner_id=$1 and id=$2 for share',[owner,executor.grantId])).rows[0]:undefined
  // 两种 grant 来源独立，冲突身份不能降级为普通会话授权。
  if(storedPlan){
   const plan=readStoredPlan(storedPlan)
   if(parent||plan.roleId!==null||plan.executor.grantId!==executor.grantId||plan.executor.grantVersion!==executor.grantVersion||plan.source.kind!=='method-reuse')throw new WorkError('teloa/forbidden','本人计划授权身份或配置版本已变化。')
   const admission=await verifyOwnerPlan(db,owner,plan,this.ownerPlans)
   return {executor,...(plan.source.acceptedSource?{source:plan.source.acceptedSource}:{}),scope:'general',plan:{planId:plan.id,configVersion:plan.configVersion,policy:plan.ownerGrant.policy},admission}
  }
  if(executor.grantVersion!==1)throw new WorkError('teloa/forbidden','本人原会话授权版本不正确。')
  if(!parent||parent.stopped_at!==null)throw new WorkError('teloa/forbidden','原本人交办不存在或已停止，不能继续执行。')
  const request=readStoredConversationWorkRequest(parent)
  if(parent.task_child_request_id!==workRequestChildId(request.requestId,'task'))throw new WorkError('teloa/storage-corrupt','本人原交办的任务索引不一致。')
  const context=(await db.query('select * from teloa_conversation_work_contexts where owner_id=$1 and session_id=$2 for share',[owner,request.sessionId])).rows[0]
  if(request.executor!=='general'||request.kind!=='task'||request.scope!=='general'||request.targets.length||context&&(context.scope_id!=='general'||context.role_id!==null))throw new WorkError('teloa/forbidden','原通用会话的执行范围已变化。')
  const admission=combineWorkAccessLeases([await workAccess.authorize({kind:'capability',capability:'general-agent',ownerId:owner,sessionId:request.sessionId,objectId:request.requestId,operation:'run'}),ownerWorkLease(owner,request.requestId)])
  admission.assertCurrent()
  return {executor,source:{sessionId:request.sessionId,messageId:request.messageId,messageSeq:request.messageSeq,requestId:request.requestId},scope:'general',admission}
 }
}
