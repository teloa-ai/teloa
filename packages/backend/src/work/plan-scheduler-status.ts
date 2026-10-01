import type {Pool} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'

export type PlanSchedulerStatus={
 ownerId:string
 planId:string|null
 health:'healthy'|'failing'
 failureCode:string|null
 lastAttemptAt:string
 lastSuccessAt:string|null
}

export type PlanSchedulerAcknowledgement={
 ownerId:string
 claimId:string
 taskId:string
 reason:'task-ended'
 acknowledgedAt:string
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const safeCode=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&/^teloa\/[a-z0-9][a-z0-9.-]*$/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','调度状态请求包含未知字段或格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','调度状态或跳过确认记录损坏，已停止读取。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const actor=(value:string)=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}

function clock(value:string):string{
 const parsed=new Date(value)
 if(typeof value!=='string'||!Number.isFinite(parsed.getTime()))throw new WorkError('teloa/storage-unavailable','调度状态时钟无效。')
 return parsed.toISOString()
}

function readStatus(row:Record<string,unknown>):PlanSchedulerStatus{
 try{
  const lastAttemptAt=stamp(row.last_attempt_at),lastSuccessAt=row.last_success_at===null?null:stamp(row.last_success_at)
  if(typeof row.owner_id!=='string'||!row.owner_id||row.plan_id!==null&&!uuid(row.plan_id)||!['healthy','failing'].includes(String(row.health)))throw Error()
  if(row.health==='healthy'?(row.failure_code!==null||lastSuccessAt!==lastAttemptAt):(!safeCode(row.failure_code)||lastSuccessAt!==null&&lastSuccessAt>lastAttemptAt))throw Error()
  return {ownerId:row.owner_id,planId:row.plan_id as string|null,health:row.health as PlanSchedulerStatus['health'],failureCode:row.failure_code as string|null,lastAttemptAt,lastSuccessAt}
 }catch{throw corrupt()}
}

function readAcknowledgement(row:Record<string,unknown>):PlanSchedulerAcknowledgement{
 try{
  if(typeof row.owner_id!=='string'||!row.owner_id||!uuid(row.claim_id)||!uuid(row.task_id)||row.reason!=='task-ended')throw Error()
  return {ownerId:row.owner_id,claimId:row.claim_id,taskId:row.task_id,reason:'task-ended',acknowledgedAt:stamp(row.acknowledged_at)}
 }catch{throw corrupt()}
}

export async function initializePlanSchedulerStatus(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_plan_scheduler_status(
  owner_id text not null,plan_id uuid,health text not null constraint teloa_plan_scheduler_status_health_check check(health in ('healthy','failing')),
  failure_code text,last_attempt_at timestamptz not null,last_success_at timestamptz,
  foreign key(plan_id,owner_id) references teloa_plans(id,owner_id),
  check((health='healthy' and failure_code is null and last_success_at=last_attempt_at) or (health='failing' and failure_code ~ '^teloa/[a-z0-9][a-z0-9.-]*$' and length(failure_code)<=100 and (last_success_at is null or last_success_at<=last_attempt_at)))
 );
 create unique index if not exists teloa_plan_scheduler_owner_status on teloa_plan_scheduler_status(owner_id) where plan_id is null;
 create unique index if not exists teloa_plan_scheduler_plan_status on teloa_plan_scheduler_status(owner_id,plan_id) where plan_id is not null;
 create table if not exists teloa_plan_scheduler_acks(
  claim_id uuid primary key references teloa_plan_occurrences(id),owner_id text not null,task_id uuid not null unique references teloa_tasks(id),
  reason text not null constraint teloa_plan_scheduler_acks_reason_check check(reason='task-ended'),acknowledged_at timestamptz not null
 )`)
}

export class PlanSchedulerStatusService{
 readonly pool:Pool
 readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}

 private async verifyPlan(owner:string,planId:unknown):Promise<string|undefined>{
  if(planId===undefined)return undefined
  if(!uuid(planId))throw invalid()
  if(!(await this.pool.query('select 1 from teloa_plans where id=$1 and owner_id=$2',[planId,owner])).rows[0])throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  return planId
 }

 async record(owner:string,input:unknown):Promise<PlanSchedulerStatus>{
  actor(owner)
  const row=exact(input,['planId','outcome','code']),planId=await this.verifyPlan(owner,row.planId)
  if(!['success','failed'].includes(String(row.outcome)))throw invalid()
  if(row.outcome==='success'?row.code!==undefined:!safeCode(row.code))throw invalid()
  const attemptedAt=clock(this.identity.now()),client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/plan-scheduler-status',owner,planId??null])])
   const stored=(await client.query('select * from teloa_plan_scheduler_status where owner_id=$1 and plan_id is not distinct from $2::uuid for update',[owner,planId??null])).rows[0] as Record<string,unknown>|undefined
   const prior=stored?readStatus(stored):undefined
   let next:{health:'healthy'|'failing';failureCode:string|null;lastSuccessAt:string|null}|undefined
   if(!prior||attemptedAt>prior.lastAttemptAt){
    next=row.outcome==='success'?{health:'healthy',failureCode:null,lastSuccessAt:attemptedAt}:{health:'failing',failureCode:row.code as string,lastSuccessAt:prior?.lastSuccessAt??null}
   }else if(attemptedAt===prior.lastAttemptAt){
    const lastSuccessAt=row.outcome==='success'?attemptedAt:prior.lastSuccessAt
    if(row.outcome==='failed')next={health:'failing',failureCode:prior.health==='failing'&&prior.failureCode!<String(row.code)?prior.failureCode:String(row.code),lastSuccessAt}
    else if(prior.health==='failing')next={health:'failing',failureCode:prior.failureCode,lastSuccessAt}
    else next={health:'healthy',failureCode:null,lastSuccessAt}
   }
   if(next){
    if(stored)await client.query('update teloa_plan_scheduler_status set health=$3,failure_code=$4,last_attempt_at=$5,last_success_at=$6 where owner_id=$1 and plan_id is not distinct from $2::uuid',[owner,planId??null,next.health,next.failureCode,attemptedAt,next.lastSuccessAt])
    else await client.query('insert into teloa_plan_scheduler_status(owner_id,plan_id,health,failure_code,last_attempt_at,last_success_at) values($1,$2,$3,$4,$5,$6)',[owner,planId??null,next.health,next.failureCode,attemptedAt,next.lastSuccessAt])
   }
   const saved=(await client.query('select * from teloa_plan_scheduler_status where owner_id=$1 and plan_id is not distinct from $2::uuid',[owner,planId??null])).rows[0]
   const result=readStatus(saved);await client.query('commit');return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 async get(owner:string,input:unknown):Promise<PlanSchedulerStatus|null>{
  actor(owner);const row=exact(input,['planId']),planId=await this.verifyPlan(owner,row.planId)
  const stored=(await this.pool.query('select * from teloa_plan_scheduler_status where owner_id=$1 and plan_id is not distinct from $2::uuid',[owner,planId??null])).rows[0]
  return stored?readStatus(stored):null
 }

 async list(owner:string,input:unknown):Promise<PlanSchedulerStatus[]>{
  actor(owner);exact(input,[])
  return (await this.pool.query('select * from teloa_plan_scheduler_status where owner_id=$1 order by plan_id nulls first',[owner])).rows.map(readStatus)
 }

 async acknowledge(owner:string,input:unknown):Promise<PlanSchedulerAcknowledgement>{
  actor(owner);const row=exact(input,['claimId','taskId','reason'])
  if(!uuid(row.claimId)||!uuid(row.taskId)||row.reason!=='task-ended')throw invalid()
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   if(!(await client.query('select 1 from teloa_tasks where id=$1 and owner_id=$2',[row.taskId,owner])).rows[0])throw new WorkError('teloa/forbidden','任务不存在或不属于当前本人。')
   const occurrence=(await client.query('select * from teloa_plan_occurrences where id=$1 and owner_id=$2 for share',[row.claimId,owner])).rows[0]
   if(!occurrence)throw new WorkError('teloa/forbidden','领取记录不存在或不属于当前本人。')
   const task=(await client.query('select * from teloa_tasks where id=$1 and owner_id=$2 for update',[row.taskId,owner])).rows[0]
   if(!task)throw new WorkError('teloa/forbidden','任务不存在或不属于当前本人。')
   const fixedTask=readStoredTask(task)
   if(!uuid(occurrence.id)||occurrence.owner_id!==owner||!uuid(occurrence.task_request_id)||!uuid(task.request_id)||fixedTask.id!==row.taskId||fixedTask.ownerId!==owner)throw corrupt()
   if(task.request_id!==occurrence.task_request_id)throw new WorkError('teloa/conflict','任务不属于该次固定领取。')
   const link=(await client.query('select * from teloa_plan_task_links where claim_id=$1 for share',[row.claimId])).rows[0]
   if(!link||!uuid(link.claim_id)||!uuid(link.task_id)||!uuid(link.task_request_id)||link.owner_id!==owner||link.task_id!==row.taskId||link.task_request_id!==occurrence.task_request_id)throw corrupt()
   if(!['completed','cancelled'].includes(fixedTask.state))throw new WorkError('teloa/conflict','只有已终止任务可以确认跳过。')
   if((await client.query('select 1 from teloa_task_runs where owner_id=$1 and request_id=$2 limit 1 for share',[owner,row.claimId])).rows[0])throw new WorkError('teloa/conflict','已有执行记录的领取不能确认无执行跳过。')
   const existing=(await client.query('select * from teloa_plan_scheduler_acks where claim_id=$1 for share',[row.claimId])).rows[0]
   if(existing){const result=readAcknowledgement(existing);if(result.ownerId!==owner||result.taskId!==row.taskId)throw corrupt();await client.query('commit');return result}
   const saved=(await client.query("insert into teloa_plan_scheduler_acks(claim_id,owner_id,task_id,reason,acknowledged_at) values($1,$2,$3,'task-ended',$4) returning *",[row.claimId,owner,row.taskId,clock(this.identity.now())])).rows[0]
   const result=readAcknowledgement(saved);await client.query('commit');return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 async acknowledgement(owner:string,input:unknown):Promise<PlanSchedulerAcknowledgement>{
  actor(owner);const row=exact(input,['claimId']);if(!uuid(row.claimId))throw invalid()
  const stored=(await this.pool.query('select * from teloa_plan_scheduler_acks where claim_id=$1 and owner_id=$2',[row.claimId,owner])).rows[0]
  if(!stored)throw new WorkError('teloa/forbidden','跳过确认不存在或不属于当前本人。')
  return readAcknowledgement(stored)
 }
}
