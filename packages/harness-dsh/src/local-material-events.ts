import {WorkError} from '@teloa/contract'
import type {PlanOccurrenceService} from '@teloa/backend'
type Pool=PlanOccurrenceService['pool']
import type {ResourceService,ResourceActor} from '@teloa/backend'
import {readStoredPlan} from '@teloa/backend'
import {RoleWorkEligibilityService} from '@teloa/backend'
import type {WorkEventService} from '@teloa/backend'
import type {TaskRunService,WorkControlService} from '@teloa/backend'
/** 复用计划宿主的唤醒；没有另建 timer，也不调用模型。仅刷新当前已授权本机材料。 */
export async function collectLocalMaterialEvents(pool:Pool,owner:string,resources:Pick<ResourceService,'refreshAuthorizedLocalVersionInTransaction'>,events:WorkEventService,actor:(owner:string,scope:string)=>Promise<ResourceActor>,signal:AbortSignal,flowPorts?:{runs:()=>Promise<Pick<TaskRunService,'executionAdmissionInTransaction'|'readVerifiedInTransaction'>>;controls:Pick<WorkControlService,'acquireForRun'>}):Promise<void>{
 const plans=(await pool.query("select * from teloa_plans where owner_id=$1 and state<>'archived' and work_definition is not null",[owner])).rows.map(readStoredPlan)
 const seen=new Set<string>()
 for(const plan of plans){for(const trigger of plan.workDefinition!.triggers){if(trigger.kind!=='local-event'||trigger.eventKind!=='material-version'||seen.has(trigger.sourceId))continue
  signal.throwIfAborted();const db=await pool.connect()
  try{await db.query('begin')
   const admission=await new RoleWorkEligibilityService(pool).authorize(owner,{roleId:plan.roleId,expectedRoleVersion:plan.roleVersion,scope:plan.scope,inputSchema:'teloa.task-run-input/v2',authorization:plan.workDefinition!.authorization,groupId:null},db)
   const currentRow=(await db.query("select p.* from teloa_plans p join teloa_work_controls c on c.owner_id=p.owner_id and c.id=(p.work_definition->>'definitionControlId')::uuid where p.owner_id=$1 and p.id=$2 and p.state<>'archived' and c.state in ('active','pausing','paused') for share of p,c",[owner,plan.id])).rows[0]
   if(!currentRow)throw new WorkError('teloa/forbidden','长期定义已结束，停止监听原材料。')
   const current=readStoredPlan(currentRow)
   if(current.configVersion!==plan.configVersion||current.roleVersion!==plan.roleVersion||current.workDefinition?.definitionControlId!==plan.workDefinition!.definitionControlId)throw new WorkError('teloa/version-conflict','材料监听定义已变化。')
   // 已升级定义必须有明确资料集合；null 旧 Task 边界不能成为监听材料的许可。
   if(!admission.limits.knowledgeIds?.includes(trigger.sourceId))throw new WorkError('teloa/forbidden','材料未包含在当前委托中。')
   await resources.refreshAuthorizedLocalVersionInTransaction(db,await actor(owner,plan.scope),trigger.sourceId)
   await events.appendSource(db,{kind:'material-version',sourceId:trigger.sourceId})
   signal.throwIfAborted();admission.assertCurrent();await db.query('commit');seen.add(trigger.sourceId)
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }}
 if(!flowPorts)return
 const waits=(await pool.query(`select distinct on(f.run_id,w.step_id) f.run_id,w.step_id,w.binding from teloa_task_run_flows f join teloa_task_run_flow_waits w on w.owner_id=f.owner_id and w.flow_id=f.flow_id join teloa_task_runs r on r.id=f.run_id and r.owner_id=f.owner_id where f.owner_id=$1 and f.confirmed_request is not null and f.state='waiting' and r.state in ('accepted','active') order by f.run_id,w.step_id,w.binding_version desc`,[owner])).rows
 for(const wait of waits){const source=wait.binding;if(source.sourceKind!=='material-version'||seen.has(source.sourceId))continue;signal.throwIfAborted();const db=await pool.connect();try{await db.query('begin');const runs=await flowPorts.runs(),admission=await runs.executionAdmissionInTransaction(db,owner,wait.run_id),run=await runs.readVerifiedInTransaction(db,owner,wait.run_id),control=await flowPorts.controls.acquireForRun(owner,{runId:run.id,mode:'new-input'},db)
   const flow=(await db.query('select steps from teloa_task_run_flows where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows[0],step=flow?.steps.find((s:{id:string})=>s.id===wait.step_id)
   if(!step||step.state!=='waiting'||step.attempts!==source.attempt||source.runId!==run.id||source.roundControlId!==run.lineage?.roundControlId||source.controlGeneration!==control.control.generation||!run.knowledge.some(k=>k.id===source.sourceId))throw new WorkError('teloa/forbidden','材料等待缺少当前执行和控制世代。')
   const scope=JSON.parse(run.inputText).task.scope;await resources.refreshAuthorizedLocalVersionInTransaction(db,await actor(owner,scope),source.sourceId);await events.appendSource(db,{kind:'material-version',sourceId:source.sourceId});signal.throwIfAborted();admission.assertCurrent();control.lease.assertCurrent();await db.query('commit');seen.add(source.sourceId)
  }catch(cause){await db.query('rollback');if(!(cause instanceof WorkError)||!['teloa/forbidden','teloa/version-conflict','teloa/conflict'].includes(cause.code))throw cause}finally{db.release()}}
}
