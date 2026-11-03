import {isDeepStrictEqual} from 'node:util'
import type {PoolClient} from 'pg'
import {WorkError,businessObjectReference,readWorkSourceTaskResume,type WorkSourceTaskResume,type WorkControl,type DigitalRole,type WorkTask} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
import {readStoredRole} from './roles.ts'
import {roleWorkOutstanding} from './role-delegations.ts'
import type {TaskRun} from './task-runs.ts'
import {combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'

type Ports={readRun:(db:PoolClient,owner:string,id:string)=>Promise<TaskRun>;inspect:(owner:string,sessionId:string)=>Promise<{id:string;sessionId:string;ownerId:string;status:string}>;assertSettled:(run:TaskRun)=>Promise<void>;authorize:(db:PoolClient,owner:string,task:WorkTask,role:DigitalRole,run:TaskRun)=>Promise<WorkAccessLease>;now:()=>string}
const changed=()=>new WorkError('teloa/version-conflict','原任务、会话、角色或工作控制已变化，请重新核对。')
const blocked=()=>new WorkError('teloa/execution-pending','原任务仍有未知或未收口的执行，不能恢复接收更新。')

/** 与正常控制恢复共用事务；只把本人指定的已暂停来源任务恢复为 ready，不创建 Run/SID 或改旧输入。 */
export async function resumePausedSourceTask(db:PoolClient,owner:string,input:WorkSourceTaskResume,control:WorkControl,approval:WorkAccessLease,ports:Ports):Promise<WorkAccessLease>{
 const command=readWorkSourceTaskResume(input)
 approval.assertCurrent()
 if(control.ownerId!==owner||control.generation!==command.expectedControlGeneration||!['active','paused'].includes(control.state)||control.pendingRunIds.length||control.unknownOperationIds.length)throw changed()
 // 与岗位和任务变更保持角色→任务锁序；持有任务串行锁后只读已结束执行，避免与 record 的执行→任务锁反向等待。
 const roleRow=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,command.roleId])).rows[0]
 const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,command.taskId])).rows[0]
 if(!roleRow||!taskRow)throw changed()
 const role=readStoredRole(roleRow),task=readStoredTask(taskRow)
 if(task.ownerId!==owner||role.ownerId!==owner||task.state!=='paused'||task.version!==command.expectedTaskVersion||role.state!=='active'||role.version!==command.expectedRoleVersion||role.id!==task.assigneeRoleId||role.version!==task.assigneeRoleVersion||role.kind!=='employee')throw changed()
 const lineage=(await db.query('select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$2 for share',[owner,task.id])).rows[0]?.lineage
 if(!lineage||lineage.ownerId!==owner||lineage.rootTaskId!==task.id||!lineage.definition||!lineage.definitionControlId||![lineage.roundControlId,lineage.definitionControlId].includes(control.id))throw changed()
 const others=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) for share',[owner,[lineage.roundControlId,lineage.definitionControlId].filter(id=>id!==control.id)])).rows
 if(others.length!==1||others.some(row=>row.state!=='active'||!Number.isSafeInteger(row.generation)||row.generation<1))throw changed()
 // active 不是进展已清的存储契约；同事务锁住另一控制的原进展，不能只依赖客户端禁用。
 const other=others[0],progress=(await db.query('select control_id,generation,pending_run_ids,unknown_operation_ids from teloa_work_control_progress where owner_id=$1 and control_id=$2 for share',[owner,other.id])).rows
 // 正常创建的初代 active 控制尚未生成 progress；经历暂停/恢复后的缺失记录则不可推断为空。
 if(progress.length===0){if(other.generation!==1)throw changed()}
 else{
  const row=progress[0]
  if(progress.length!==1||row.control_id!==other.id||row.generation!==other.generation||!Array.isArray(row.pending_run_ids)||!Array.isArray(row.unknown_operation_ids))throw changed()
  if(row.pending_run_ids.length||row.unknown_operation_ids.length)throw blocked()
 }
 const source=(await db.query('select source_snapshot from teloa_business_task_sources where owner_id=$1 and task_id=$2 for share',[owner,task.id])).rows[0]?.source_snapshot
 if(!source||source.ownerId!==owner||source.taskId!==task.id||source.schema!=='teloa.business-task-source/v1')throw changed()
 const reference=businessObjectReference(source.reference)
 if(reference.scope!==task.scope)throw changed()
 if((await db.query("select 1 from teloa_task_runs where owner_id=$1 and task_id=$2 and state in ('prepared','submitting','accepted','active','submission_unknown') limit 1",[owner,task.id])).rows.length)throw blocked()
 const latest=(await db.query("select id from teloa_task_runs where owner_id=$1 and task_id=$2 and state not in ('withdrawn','configuration_failed') order by task_version desc,created_at desc,id desc limit 1",[owner,task.id])).rows[0]
 if(!latest)throw changed()
 const run=await ports.readRun(db,owner,latest.id)
 if(run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||run.taskId!==task.id||run.roleId!==role.id||run.roleVersion!==role.version||run.sessionId!==command.sessionId||!run.roleSnapshot||!run.lineage||run.lineage.definitionControlId!==lineage.definitionControlId||run.lineage.roundControlId!==lineage.roundControlId)throw changed()
 const frozen=JSON.parse(run.inputText),object=frozen.businessContext?.object
 if(frozen.task?.id!==task.id||frozen.task.goal!==task.goal||frozen.task.scope!==task.scope||!object||frozen.businessContext.sourceId!==source.sourceId||!isDeepStrictEqual(businessObjectReference({scope:object.scope,type:object.type,id:object.id,version:object.version,snapshotHash:object.snapshotHash}),reference))throw changed()
 const link=(await db.query("select * from teloa_object_conversations where owner_id=$1 and kind='task' and object_id=$2 and session_id=$3 for share",[owner,task.id,command.sessionId])).rows[0]
 const conversation=await ports.inspect(owner,command.sessionId)
 if(!link?.active||link.source_only===true||link.version!==run.linkVersion||conversation.ownerId!==owner||conversation.sessionId!==command.sessionId||conversation.status!=='ready'||conversation.id!==link.conversation_id)throw changed()
 if(await roleWorkOutstanding(db,owner,role.id,{taskId:task.id}))throw blocked()
 if((await db.query("select 1 from teloa_task_run_goal_continuations c join teloa_task_runs r on r.owner_id=c.owner_id and r.id=c.run_id where r.owner_id=$1 and r.task_id=$2 and c.receipt->>'state' in ('reserved','unknown') limit 1",[owner,task.id])).rows.length)throw blocked()
 await ports.assertSettled(run)
 const effects=await db.query("select 1 from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where a.owner_id=$1 and a.task_id=$2 and e.state not in ('succeeded','failed') limit 1",[owner,task.id])
 if(effects.rows.length)throw blocked()
 const lease=combineWorkAccessLeases([approval,await ports.authorize(db,owner,task,role,run)])
 lease.assertCurrent()
 const result=await db.query("update teloa_tasks set state='ready',version=version+1,updated_at=$4 where owner_id=$1 and id=$2 and version=$3 and state='paused' returning id",[owner,task.id,command.expectedTaskVersion,ports.now()])
 if(result.rows.length!==1)throw changed()
 lease.assertCurrent();return lease
}
