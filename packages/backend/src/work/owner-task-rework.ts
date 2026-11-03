import type {PoolClient} from 'pg'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,readWorkSource,taskDefinition,type WorkTask} from '@teloa/contract'
import {readStoredTask,taskRequestSpec} from './tasks.ts'
import {readStoredTaskRun} from './task-runs.ts'
import {WorkLineageService} from './work-lineage.ts'
import {roleWorkOutstanding} from './role-delegations.ts'

/** 同一资格供纯读展示与行锁内状态变更使用；不授予执行、恢复控制或修改历史运行。 */
export async function ownerTaskReworkBasis(db:PoolClient,owner:string,task:WorkTask,lineages:WorkLineageService,lock=false):Promise<{controlId:string}|null>{
 if(!['waiting','ready'].includes(task.state)||!task.assigneeRoleId||task.executor||task.groupId!==null||task.completionPolicy?.kind==='verified')return null
 const sourceRow=(await db.query('select source from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,task.id])).rows[0]
 if(!sourceRow)return null
 const source=readWorkSource(sourceRow.source)
 if(source.kind!=='owner-task'||source.taskId!==task.id)return null
 // owner-task 根谱系也可能附带后续固定业务来源，不能借本入口重做其既有授权。
 for(const table of ['teloa_group_task_sources','teloa_business_task_sources','teloa_industry_task_sources','teloa_plan_task_links'] as const){
  if((await db.query('select to_regclass($1) as relation',[table])).rows[0]?.relation&&(await db.query(`select 1 from ${table} where owner_id=$1 and task_id=$2 limit 1`,[owner,task.id])).rowCount)return null
 }
 const role=(await db.query('select state,version from teloa_roles where owner_id=$1 and id=$2'+(lock?' for share':''),[owner,task.assigneeRoleId])).rows[0]
 if(!role||role.state!=='active'||role.version!==task.assigneeRoleVersion)return null
 const history=(await db.query('select * from teloa_task_runs where owner_id=$1 and task_id=$2 order by created_at desc,id desc',[owner,task.id])).rows.map(readStoredTaskRun)
 // 未知受理和来源续办不能由修改目标这一动作掩盖。
 if(history.some(run=>run.state==='submission_unknown'||run.sourceFollowup))return null
 const run=history[0]
 if(!run)return null
 if(run.roleId!==task.assigneeRoleId||run.roleVersion!==task.assigneeRoleVersion||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.stopRequestedAt!==null||run.sourceFollowup)return null
 const snapshot=JSON.parse(run.inputText) as {task?:{goal?:unknown}}
 if(typeof snapshot.task?.goal!=='string'||snapshot.task.goal===task.goal)return null
 const edits=(await db.query('select base_version,request_spec,result from teloa_task_edits where task_id=$1 order by base_version desc',[task.id])).rows
 const edited=edits.some(row=>{
  try{
   const r=row.result,saved=readStoredTask({...r,created_at:new Date(r.created_at),updated_at:new Date(r.updated_at)})
   const definition=taskDefinition({title:saved.title,goal:saved.goal,scope:saved.scope,groupId:saved.groupId,skills:saved.skills,...(saved.completionPolicy?{completionPolicy:saved.completionPolicy}:{})})
   if(saved.id!==task.id||saved.ownerId!==owner||saved.version!==row.base_version+1||!isDeepStrictEqual(row.request_spec,taskRequestSpec(definition,undefined).fields))throw Error()
   return saved.contentVersion===task.contentVersion&&saved.goal===task.goal&&saved.version>run.taskVersion&&saved.state==='waiting'
  }catch{throw new WorkError('teloa/storage-corrupt','原目标修改回执损坏，不能继续。')}
 })
 if(!edited||await roleWorkOutstanding(db,owner,task.assigneeRoleId,{taskId:task.id}))return null
 const lineage=await lineages.readInTransaction(db,owner,{taskId:task.id})
 if(!lineage||lineage.rootTaskId!==task.id||lineage.parentRunId!==null||lineage.definition!==null)return null
 const control=(await db.query('select state from teloa_work_controls where owner_id=$1 and id=$2',[owner,lineage.roundControlId])).rows[0]
 if(!control||!['active','paused'].includes(control.state))return null
 return {controlId:lineage.roundControlId}
}
