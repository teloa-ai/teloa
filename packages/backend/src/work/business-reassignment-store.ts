import type {PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'
import type {ConversationWorkRequest} from './conversation-work.ts'
import {workRequestChildId} from './conversation-work-task-protection.ts'
import {readStoredTask} from './tasks.ts'
import {readStoredTaskRun,type TaskRun} from './task-runs.ts'
import {assertNativeRunAbortProof} from './task-run-abort-proof.ts'

export type ReassignmentRunIdentity=Pick<TaskRun,'id'|'taskId'|'sessionId'|'nativeRequestId'>
export type ReassignmentRunTargets={oldRequestId:string;oldSessionId:string;scope:string;targets:Array<{roleId:string;taskRequestId:string;taskId:string|null;runs:ReassignmentRunIdentity[]}>}
const conflict=()=>new WorkError('teloa/conflict','原交办仍待核对或未可靠结清，尚未创建后继。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','原交办的任务或执行归属不一致，请核对原请求。')
async function taskRows(db:PoolClient,owner:string,request:ConversationWorkRequest){
 const children=request.targets.map(target=>workRequestChildId(request.requestId,'task',target.roleId))
 const rows=(await db.query('select * from teloa_tasks where owner_id=$1 and request_id=any($2::uuid[]) order by id',[owner,children])).rows as Record<string,unknown>[]
 for(const row of rows){
  const task=readStoredTask(row),target=request.targets.find(candidate=>workRequestChildId(request.requestId,'task',candidate.roleId)===row.request_id)
  if(!target||task.ownerId!==owner||task.scope!==target.scope||task.assigneeRoleId!==target.roleId||task.assigneeRoleVersion!==target.roleVersion)throw corrupt()
 }
 if(new Set(rows.map(row=>row.request_id)).size!==rows.length)throw corrupt()
 return rows
}
function tuple(request:ConversationWorkRequest,tasks:Record<string,unknown>[],runs:TaskRun[]):ReassignmentRunTargets{
 return {oldRequestId:request.requestId,oldSessionId:request.sessionId,scope:request.scope,targets:request.targets.map(target=>{
  const taskRequestId=workRequestChildId(request.requestId,'task',target.roleId),task=tasks.find(row=>row.request_id===taskRequestId),taskId=task?readStoredTask(task).id:null
  return {roleId:target.roleId,taskRequestId,taskId,runs:runs.filter(run=>run.taskId===taskId).map(({id,taskId,sessionId,nativeRequestId})=>({id,taskId,sessionId,nativeRequestId}))}
 })}
}
/** 已授权的窄枚举；不输出输入正文，也不接受调用者指定 Run/session。 */
export async function readReassignmentRunTargets(db:PoolClient,owner:string,request:ConversationWorkRequest):Promise<ReassignmentRunTargets>{
 const tasks=await taskRows(db,owner,request),ids=tasks.map(row=>readStoredTask(row).id)
 const runs=(await db.query('select * from teloa_task_runs where owner_id=$1 and task_id=any($2::uuid[]) order by id',[owner,ids])).rows.map(readStoredTaskRun)
 return tuple(request,tasks,runs)
}
/** C/P 保护由调用者先取。先全部 Run→证明/子级→全部 Task；锁后重读完整集合，绝不只查最新 Run。 */
export async function assertReassignmentRunsSettled(db:PoolClient,owner:string,request:ConversationWorkRequest):Promise<void>{
 const tasks=await taskRows(db,owner,request),ids=tasks.map(row=>readStoredTask(row).id)
 const before=tuple(request,tasks,(await db.query('select * from teloa_task_runs where owner_id=$1 and task_id=any($2::uuid[]) order by id',[owner,ids])).rows.map(readStoredTaskRun))
 const rows=(await db.query('select * from teloa_task_runs where owner_id=$1 and task_id=any($2::uuid[]) order by id for update',[owner,ids])).rows as Record<string,unknown>[]
 for(const row of rows){
  const run=readStoredTaskRun(row)
  if(run.state==='ended'){
   // 唯一原生证明 owner 负责来源与全部关联版本；停止意图或 historical reason 均不能替代。
   await assertNativeRunAbortProof(db,owner,run)
  }else if(run.state==='withdrawn'||run.state==='configuration_failed'){
   if(row.task_state_version!==null||run.evidence!==null||run.state==='configuration_failed'&&!run.configurationError)throw conflict()
   if((await db.query('select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 limit 1',[owner,run.id])).rowCount||(await db.query('select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 limit 1',[owner,run.id])).rowCount)throw conflict()
  }else throw conflict()
 }
 const locked=(await db.query('select * from teloa_tasks where owner_id=$1 and id=any($2::uuid[]) order by id for update',[owner,ids])).rows as Record<string,unknown>[]
 // record 可以在我们取得 Run 锁前完成；第一次枚举的 Task 版本有任何变化均整笔回滚。
 if(JSON.stringify(locked)!==JSON.stringify(tasks))throw conflict()
 const after=await readReassignmentRunTargets(db,owner,request)
 if(JSON.stringify(after)!==JSON.stringify(before)||JSON.stringify(tuple(request,locked,rows.map(readStoredTaskRun)))!==JSON.stringify(before))throw conflict()
}
