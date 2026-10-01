import type {Pool} from 'pg'
import {WorkError,taskInput} from '@teloa/contract'
export type WorkFactsActor={ownerId:string;scopeIds:readonly string[]}
export type WorkFactTask={id:string;title:string;scope:string;state:string;assigneeRoleId:string|null;createdAt:string;updatedAt:string}
export type WorkFactRun={id:string;taskId:string;state:string;createdAt:string;outcome:string|null}
export type WorkFactDelivery={artifactId:string;number:number;taskId:string;title:string;createdAt:string}
const stamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v
const date=(v:unknown):string=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw new WorkError('teloa/storage-corrupt','工作事实时间损坏。');return v.toISOString()}
/** 只投影本人业务记录的元数据；不读取岗位记忆、每日日志、执行输入或工具正文。 */
export class WorkFactsService{
 readonly pool:Pool;readonly now:()=>string
 constructor(pool:Pool,now:()=>string){this.pool=pool;this.now=now}
 async read(actor:WorkFactsActor,input:unknown){
  if(!actor.ownerId.trim()||!actor.scopeIds.length||actor.scopeIds.some(scope=>!/^[-a-zA-Z0-9_]{1,64}$/.test(scope)))throw new WorkError('teloa/forbidden','缺少可读取的本人业务范围。')
  const row=taskInput(input,['scope','from','to','timezone'])
  if(!stamp(row.from)||!stamp(row.to)||row.from>=row.to||Date.parse(row.to)-Date.parse(row.from)>366*86400000||typeof row.timezone!=='string')throw new WorkError('teloa/invalid-input','需要有效的起止时间和时区；时间窗最多 366 天。')
  try{new Intl.DateTimeFormat('en',{timeZone:row.timezone}).format()}catch{throw new WorkError('teloa/invalid-input','时区无效。')}
  if(row.scope!==undefined&&(typeof row.scope!=='string'||!actor.scopeIds.includes(row.scope)))throw new WorkError('teloa/forbidden','当前主体不能读取此业务。')
  const scopes=row.scope===undefined?[...new Set(actor.scopeIds)]:[row.scope as string],db=await this.pool.connect(),args=[actor.ownerId,scopes,row.from,row.to]
  try{
   await db.query('begin isolation level repeatable read read only')
   const tasks=(await db.query(`select id,definition->>'title' as title,definition->>'scope' as scope,state,assignee_role_id as "assigneeRoleId",created_at as "createdAt",updated_at as "updatedAt" from teloa_tasks where owner_id=$1 and definition->>'scope'=any($2::text[]) and updated_at >= $3 and updated_at < $4 order by updated_at,id limit 1001`,args)).rows.map(r=>({...r,createdAt:date(r.createdAt),updatedAt:date(r.updatedAt)})) as WorkFactTask[]
   const runs=(await db.query(`select r.id,r.task_id as "taskId",r.state,r.created_at as "createdAt",r.evidence->>'reason' as outcome from teloa_task_runs r join teloa_tasks t on t.id=r.task_id and t.owner_id=r.owner_id where r.owner_id=$1 and t.definition->>'scope'=any($2::text[]) and r.created_at >= $3 and r.created_at < $4 order by r.created_at,r.id limit 1001`,args)).rows.map(r=>({...r,createdAt:date(r.createdAt)})) as WorkFactRun[]
   const deliveries=(await db.query(`select v.artifact_id as "artifactId",v.number,v.source->>'id' as "taskId",v.content->>'title' as title,v.created_at as "createdAt" from teloa_artifact_versions v join teloa_tasks t on t.owner_id=v.owner_id and t.id::text=v.source->>'id' where v.owner_id=$1 and v.source->>'kind'='task' and t.definition->>'scope'=any($2::text[]) and v.created_at >= $3 and v.created_at < $4 order by v.created_at,v.artifact_id,v.number limit 1001`,args)).rows.map(r=>({...r,createdAt:date(r.createdAt)})) as WorkFactDelivery[]
   await db.query('commit')
   const coverage=tasks.length>1000||runs.length>1000||deliveries.length>1000?'partial' as const:'complete' as const
   const selectedTasks=tasks.slice(0,1000),selectedRuns=runs.slice(0,1000),selectedDeliveries=deliveries.slice(0,1000)
   return {from:row.from,to:row.to,timezone:row.timezone,scopes,observedAt:this.now(),coverage,basis:'时间窗为 [from,to)。任务按最近更新时间，执行按创建时间，交付按成果版本创建时间；状态为读取时现状。partial 时计数只覆盖返回记录，不代表全量。',counts:{tasksTouched:selectedTasks.length,runsStarted:selectedRuns.length,deliveriesCreated:selectedDeliveries.length,blocked:selectedTasks.filter(t=>t.state==='blocked').length,waitingReview:selectedTasks.filter(t=>t.state==='waiting').length},tasks:selectedTasks,runs:selectedRuns,deliveries:selectedDeliveries}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
