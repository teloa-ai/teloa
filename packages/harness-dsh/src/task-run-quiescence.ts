import {isDeepStrictEqual} from 'node:util'
import type {Context} from '@deepseek-ai/cordis'
import type {TaskRun,TaskRunService} from '@teloa/backend'
import {inspectTaskRunQuiescence} from './task-run-source-followup.ts'

type Reader={pool:TaskRunService['pool'];readRun:TaskRunService['readVerifiedInTransaction']}
/** 窄的暂停冷证明：只读原日志及逐 Run 持久归属，不借整项 live 计划准入，也不签署成功或资源结算。 */
export async function taskRunQuiescentSettlement(ctx:Context,owner:string,run:TaskRun,reader:Reader,signal:AbortSignal):Promise<boolean>{
 if(run.state!=='ended'&&run.state!=='submission_unknown'||run.state==='submission_unknown'&&!run.submissionDisposition)return false
 const db=await reader.pool.connect()
 try{
  await db.query('begin')
  // claim/record 先 Run 后 Task；先锁全任务的既有 Run，避免持 Task 后等原 Run 的反向等待。
  const lockedIds=(await db.query('select id from teloa_task_runs where owner_id=$1 and task_id=$2 order by id for share',[owner,run.taskId])).rows.map(row=>String(row.id))
  await db.query('select 1 from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,run.taskId])
  const currentIds=(await db.query('select id from teloa_task_runs where owner_id=$1 and task_id=$2 order by id',[owner,run.taskId])).rows.map(row=>String(row.id))
  if(!isDeepStrictEqual(currentIds,lockedIds))return false
  const frame=async()=>{
   const ids=(await db.query('select id from teloa_task_runs where owner_id=$1 and task_id=$2 and session_id=$3 order by task_version,created_at,id for share',[owner,run.taskId,run.sessionId])).rows.map(row=>String(row.id))
   const history:TaskRun[]=[]
   for(const id of ids)history.push(await reader.readRun(db,owner,id))
   if(!history.some(item=>isDeepStrictEqual(item,run)))return null
   for(const item of history){
    const input=JSON.parse(item.inputText)
    if(item.groupContext||item.flowId||input.planContext?.reportGroup||item.state!=='ended'&&item.state!=='submission_unknown')return null
   }
   // 已有持久终态结算优先；这个窄 fallback 不接管团队、Goal、流程或浏览器恢复。
   for(const table of ['teloa_task_run_subagents','teloa_task_run_flows','teloa_task_run_web_access','teloa_task_run_goals','teloa_task_run_goal_continuations']){
    if((await db.query(`select 1 from ${table} where owner_id=$1 and run_id=any($2::uuid[]) limit 1`,[owner,ids])).rowCount)return null
   }
   if((await db.query("select 1 from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where a.owner_id=$1 and a.task_id=$2 and e.state not in ('succeeded','failed') limit 1",[owner,run.taskId])).rowCount)return null
   const links=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=any($2::uuid[]) order by run_id,kind,native_id for share',[owner,ids])).rows
   for(const item of history){
    const own=links.filter(link=>link.run_id===item.id),link=own[0],payload=link?.payload
    if(own.length!==1||link.kind!=='job'||link.session_id!==item.sessionId||payload?.record!=='owner'||typeof payload.runtimeId!=='string'||!payload.runtimeId||Object.keys(payload).length!==3||payload.requestId!==item.nativeRequestId||link.native_id!==`owner:${payload.runtimeId}:${item.sessionId}`||item.submissionDisposition&&payload.runtimeId!==item.submissionDisposition.runtimeId)return null
   }
   return {history,links}
  }
  const before=await frame();if(!before)return false
  await inspectTaskRunQuiescence(ctx,run,signal,before.history)
  const after=await frame();if(!after||!isDeepStrictEqual(after,before))return false
  signal.throwIfAborted();await db.query('commit');return true
 }catch{return false}
 finally{await db.query('rollback').catch(()=>{});db.release()}
}
