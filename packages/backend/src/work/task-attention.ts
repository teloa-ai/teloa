import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,type WorkTask} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
import {readStoredTaskRun,type TaskRun} from './task-runs.ts'

export type TaskAttention={kind:'error'|'review';reason:'task-blocked'|'execution-failed'|'execution-configuration-failed'|'execution-completed'|'task-waiting'}
export type TaskAttentionItem={task:WorkTask;attention:TaskAttention|null}
export type TaskAttentionPage={items:TaskAttentionItem[]}

function ownerIdentity(owner:string):void{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','任务注意目录记录损坏，已停止读取。')
const active=(state:string)=>!['ended','withdrawn','configuration_failed'].includes(state)

export class TaskAttentionService{
 readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 async list(owner:string,input:unknown):Promise<TaskAttentionPage>{
  ownerIdentity(owner);taskInput(input,[])
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const result=await this.readInTransaction(db,owner)
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 项目只汇总关联任务，并与项目/关系保持同一数据库快照；判定与全局「需要你」共用。 */
 async readInTransaction(db:PoolClient,owner:string,ids?:readonly string[]):Promise<TaskAttentionPage>{
   ownerIdentity(owner)
   const taskRows=(await db.query('select * from teloa_tasks where owner_id=$1 and ($2::uuid[] is null or id=any($2)) order by created_at,id',[owner,ids??null])).rows,tasks=taskRows.map(readStoredTask),taskIds=new Set(tasks.map(task=>task.id))
   // 只解析会影响注意判定的任务执行；已结束及普通状态任务的旧执行不是本目录的判断依据。
   const runRows=(await db.query("select r.* from teloa_task_runs r join teloa_tasks t on t.id=r.task_id and t.owner_id=r.owner_id where r.owner_id=$1 and t.id=any($2::uuid[]) and t.state in ('ready','paused','blocked','waiting') order by r.task_id,r.task_version desc,r.created_at desc,r.id desc",[owner,[...taskIds]])).rows
   const rawRuns=new Map<string,Record<string,unknown>[]>()
   for(const row of runRows){if(!taskIds.has(row.task_id))throw corrupt();const entries=rawRuns.get(row.task_id)??[];entries.push(row);rawRuns.set(row.task_id,entries)}
   const items=tasks.map(task=>{
    const raw=rawRuns.get(task.id)??[],selected=raw.filter((row,index)=>index===0||!['ended','withdrawn','configuration_failed'].includes(String(row.state))||row.role_id===task.assigneeRoleId&&(row.task_state_version===task.version-1||row.state==='configuration_failed'&&row.task_version===task.version))
    const history=selected.map(row=>{const run=readStoredTaskRun(row),stateVersion=row.task_state_version??null;if(stateVersion!==null&&(!Number.isSafeInteger(stateVersion)||Number(stateVersion)<1))throw corrupt();return {run,taskStateVersion:stateVersion as number|null}})
    if(history.filter(({run})=>active(run.state)).length>1)throw corrupt()
    const current=history.filter(({run,taskStateVersion})=>run.state==='ended'&&run.roleId===task.assigneeRoleId&&taskStateVersion===task.version-1)
    if(current.length>1)throw corrupt()
    const latest=history[0],hasCurrentAttempt=history.some(({run})=>run.taskVersion===task.version&&['prepared','submitting','accepted','active','withdrawn'].includes(run.state)),configurationFailed=!hasCurrentAttempt&&latest?.run.state==='configuration_failed'&&latest.run.taskVersion===task.version&&latest.run.roleId===task.assigneeRoleId,currentLatest=!hasCurrentAttempt&&current.length===1&&latest?.run.id===current[0]!.run.id?current[0]:undefined
    let attention:TaskAttention|null=null
    if(configurationFailed){attention={kind:'error',reason:'execution-configuration-failed'}}
    else if(task.state==='blocked'){
     const evidence=currentLatest?.run.evidence
     attention=evidence?.state==='ended'&&!['completed','aborted'].includes(evidence.reason)?{kind:'error',reason:'execution-failed'}:{kind:'error',reason:'task-blocked'}
    }else if(task.state==='waiting'){
     const evidence=currentLatest?.run.evidence
     attention=evidence?.state==='ended'&&evidence.reason==='completed'?{kind:'review',reason:'execution-completed'}:{kind:'review',reason:'task-waiting'}
    }
    return {task,attention}
   })
   return {items}
 }
}
