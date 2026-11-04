import {isDeepStrictEqual} from 'node:util'
import type {PoolClient} from 'pg'
import {WorkError,roleSupportsScope,type TaskToolArgumentRule} from '@teloa/contract'
import {workAccess,combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'
import {readStoredTask} from './tasks.ts'
import {readStoredRole} from './roles.ts'
import {readRoleToolGrant} from './role-tool-grants.ts'
import {roleWorkOutstanding,settledOwnerGroupDelivery,settledOwnerEffects} from './role-delegations.ts'
import {createFixedRunKnowledgeRead} from '../capabilities/fixed-run-knowledge-read.ts'
import type {TaskRun,TaskRunService,TaskExecutionScope} from './task-runs.ts'

export type TaskRunInteraction={run:TaskRun;target:TaskExecutionScope;allowedTools:readonly string[];originalRules:readonly TaskToolArgumentRule[]|undefined;currentRules:readonly TaskToolArgumentRule[]|undefined;lease:WorkAccessLease}
const denied=()=>new WorkError('teloa/conflict','原任务、正式结果或后台工作尚未收口，暂不能在原会话追问。')

/** 独立本人交互许可；不恢复原Run、修改Task、领取自动工作控制或记入旧额度。 */
export class TaskRunInteractionService{
 readonly runs:TaskRunService
 readonly inspectCompleted:(run:TaskRun,db:PoolClient)=>Promise<void>
 constructor(runs:TaskRunService,inspectCompleted:(run:TaskRun,db:PoolClient)=>Promise<void>){this.runs=runs;this.inspectCompleted=inspectCompleted}
 async read(owner:string,sessionId:string,transaction?:PoolClient):Promise<TaskRunInteraction|null>{
  if(typeof sessionId!=='string'||!/^[-a-zA-Z0-9_]{1,128}$/.test(sessionId))throw new WorkError('teloa/invalid-input','会话身份不正确。')
  const db=transaction??await this.runs.pool.connect()
  try{
   if(!transaction)await db.query('begin')
   const hint=(await db.query('select id,owner_id,role_id from teloa_task_runs where session_id=$1 order by created_at desc,id desc limit 1',[sessionId])).rows[0]
   if(hint?.owner_id!==undefined&&hint.owner_id!==owner)throw new WorkError('teloa/forbidden','原运行会话不属于本人。')
   if(hint?.role_id)await db.query('select id from teloa_roles where owner_id=$1 and id=$2 for share',[owner,hint.role_id])
   const rows=(await db.query('select id,owner_id from teloa_task_runs where session_id=$1 order by created_at desc,id desc for share',[sessionId])).rows
   if(!rows.length){if(!transaction)await db.query('commit');return null}
   if(rows.some(row=>row.owner_id!==owner))throw new WorkError('teloa/forbidden','原运行会话不属于本人。')
   const run=await this.runs.readVerifiedInTransaction(db,owner,rows[0].id)
   if(run.id!==hint?.id||run.roleId!==(hint.role_id??null))throw denied()
   if(run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null)throw denied()
   const stored=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,run.id])).rows[0]
   if(!stored||stored.owner_result_pending!==false||!await settledOwnerGroupDelivery(db,owner,stored,run,false)||!await settledOwnerEffects(db,owner,run.taskId))throw denied()
   const binding=await this.runs.inspect(owner,sessionId)
   if(binding.ownerId!==owner||binding.sessionId!==sessionId||binding.status!=='ready')throw denied()
   const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,run.taskId])).rows[0]
   if(!taskRow)throw denied()
   const task=readStoredTask(taskRow),fixed=JSON.parse(run.inputText).task
   if(task.state!=='completed'||!isDeepStrictEqual(fixed,{id:task.id,version:run.taskVersion,title:task.title,goal:task.goal,scope:task.scope}))throw denied()
   if(run.executor?.kind==='owner'?!isDeepStrictEqual(task.executor,run.executor):!run.roleSnapshot||task.assigneeRoleId!==run.roleId||task.assigneeRoleVersion!==run.roleVersion)throw denied()
   const link=(await db.query("select * from teloa_object_conversations where owner_id=$1 and kind='task' and object_id=$2 and session_id=$3 for share",[owner,run.taskId,sessionId])).rows[0]
   if(!link||!link.active||link.source_only||link.conversation_id!==binding.id||link.version!==run.linkVersion)throw denied()
   const completion=(await db.query('select * from teloa_task_completions where owner_id=$1 and task_id=$2 for share',[owner,run.taskId])).rows[0]
   if(!completion||!Number.isSafeInteger(completion.task_version)||completion.task_version>task.version||await roleWorkOutstanding(db,owner,run.roleId??'',{taskId:run.taskId}))throw denied()
   const apiPresent=(await db.query("select to_regclass('teloa_employee_api_rounds') is not null as present")).rows[0]?.present===true
   if(apiPresent){
    const pending=(await db.query(`select 1 from teloa_employee_api_rounds r join teloa_employee_api_work w on w.id=r.work_id
     left join teloa_employee_api_round_deliveries d on d.work_id=r.work_id and d.round=r.round
     left join teloa_employee_api_results result on result.work_id=d.work_id and result.version=d.result_version and result.round=r.round
     where w.owner_id=$1 and r.run_id=$2 and (d.task_id is distinct from r.task_id or result.work_id is null or (w.round=r.round and (w.state<>'succeeded' or w.delivery_required))) limit 1`,[owner,run.id])).rows.length
    if(pending)throw denied()
   }
   let allowedTools=[...run.allowedTools],currentRules:readonly TaskToolArgumentRule[]|undefined
   // 原生输入在事务外核对会话能力；这里逐项取当前能力，避免持有任务事务时反借同一连接池。
   const leases:WorkAccessLease[]=[]
   if(run.groupContext)leases.push(await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId,objectId:run.groupContext.groupId,operation:'run'}))
   if(JSON.parse(run.inputText).planContext)leases.push(await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId,objectId:run.id,operation:'run'}))
   if(run.executor?.kind==='owner')leases.push(await workAccess.authorize({kind:'capability',capability:'general-agent',ownerId:owner,sessionId,objectId:run.id,operation:'run'}))
   else{
    const roleRow=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,run.roleId])).rows[0]
    if(!roleRow)throw new WorkError('teloa/forbidden','原员工已不可用。')
    const role=readStoredRole(roleRow)
    if(role.state!=='active'||role.kind!==run.roleSnapshot?.kind||run.roleVersion===null||role.version<run.roleVersion||!roleSupportsScope(role.scopes,task.scope))throw new WorkError('teloa/forbidden','原员工身份或业务授权已变化。')
    const storedGrant=(await db.query('select * from teloa_role_tool_grants where role_id=$1 order by role_version desc limit 1 for share',[role.id])).rows[0]
    const grant=storedGrant?readRoleToolGrant(storedGrant):null
    if(grant&&grant.roleVersion>role.version)throw new WorkError('teloa/storage-corrupt','员工工具授权版本不一致。')
    currentRules=grant?.state==='active'?grant.rules:[]
    const current=new Set(currentRules.map(rule=>rule.name));allowedTools=allowedTools.filter(name=>current.has(name))
    leases.push(await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId,objectId:role.id,operation:'run'}))
   }
   await this.inspectCompleted(run,db)
   const lease=combineWorkAccessLeases(leases);lease.assertCurrent()
   const target:TaskExecutionScope={taskId:run.taskId,taskVersion:run.taskVersion,sessionId,linkVersion:run.linkVersion,scope:task.scope,groupId:run.groupContext?.groupId??null,knowledgeIds:run.knowledge.map(item=>item.id),fixedKnowledgeRead:createFixedRunKnowledgeRead(owner,run.id,run.knowledge)}
   if(!transaction)await db.query('commit')
   return {run,target,allowedTools,originalRules:run.argumentRules,currentRules,lease}
  }catch(error){if(!transaction)await db.query('rollback');throw error}finally{if(!transaction)db.release()}
 }
}
