import type {Pool} from 'pg'
import {WorkError,taskInput} from '@teloa/contract'

export const taskRunSubagentStates=['reserved','started','ended','abandoned'] as const
export type TaskRunSubagentState=typeof taskRunSubagentStates[number]
export type TaskRunSubagent={runId:string;reservationId:string;childSessionId?:string;depth?:number;state:TaskRunSubagentState;createdAt:string;startedAt?:string;endedAt?:string;stopReason?:string;tokenEstimate?:number}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const session=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value)
const reservation=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&(value as number)>0
const tokenEstimate=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<=2147483647
const actor=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')}
const timestamp=(value:unknown)=>value instanceof Date?value.toISOString():typeof value==='string'&&Number.isFinite(Date.parse(value))?new Date(value).toISOString():null
const stopped=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=256
const corrupt=()=>new WorkError('teloa/storage-corrupt','子 Agent 执行登记损坏，已停止读取。')

export async function initializeTaskRunSubagents(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_task_run_subagents(
   owner_id text not null,run_id uuid not null,reservation_id text not null,
   child_session_id text,depth integer,
   state text not null,
   created_at timestamptz not null,started_at timestamptz,ended_at timestamptz,stop_reason text,token_estimate integer,
   primary key(owner_id,reservation_id),unique(child_session_id),
   foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
  );
  alter table teloa_task_run_subagents add column if not exists token_estimate integer;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_depth_check;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_state_check;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_check;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_check1;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_check2;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_token_estimate_nonnegative;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_token_estimate_state;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_depth_positive;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_state_valid;
  alter table teloa_task_run_subagents drop constraint if exists teloa_task_run_subagents_lifecycle;
  alter table teloa_task_run_subagents add constraint teloa_task_run_subagents_depth_positive check(depth is null or depth>0);
  alter table teloa_task_run_subagents add constraint teloa_task_run_subagents_state_valid check(state in ('reserved','started','ended','abandoned'));
  alter table teloa_task_run_subagents add constraint teloa_task_run_subagents_lifecycle check(
   (state='reserved' and child_session_id is null and depth is null and started_at is null and ended_at is null and stop_reason is null)
   or (state='started' and child_session_id is not null and depth is not null and started_at is not null and ended_at is null and stop_reason is null)
   or (state='ended' and child_session_id is not null and depth is not null and started_at is not null and ended_at is not null and stop_reason is not null)
   or (state='abandoned' and ended_at is not null and stop_reason is not null and ((child_session_id is null and depth is null and started_at is null) or (child_session_id is not null and depth is not null and started_at is not null)))
  );
  alter table teloa_task_run_subagents add constraint teloa_task_run_subagents_token_estimate_nonnegative check(token_estimate is null or token_estimate>=0);
  alter table teloa_task_run_subagents add constraint teloa_task_run_subagents_token_estimate_state check(token_estimate is null or state='ended');
  create index if not exists teloa_task_run_subagents_owner_run on teloa_task_run_subagents(owner_id,run_id,created_at,reservation_id);
  drop index if exists teloa_task_run_subagents_one_reserved_per_run;
 `)
}

function read(row:Record<string,unknown>):TaskRunSubagent{
 const createdAt=timestamp(row.created_at),startedAt=row.started_at===null?undefined:timestamp(row.started_at),endedAt=row.ended_at===null?undefined:timestamp(row.ended_at)
 if(!uuid(row.run_id)||!reservation(row.reservation_id)||!taskRunSubagentStates.includes(row.state as TaskRunSubagentState)||!createdAt||startedAt===null||endedAt===null)throw corrupt()
 if(row.child_session_id!==null&&!session(row.child_session_id))throw corrupt()
 if(row.depth!==null&&!positive(row.depth))throw corrupt()
 if(row.stop_reason!==null&&!stopped(row.stop_reason))throw corrupt()
 if(row.token_estimate!==null&&!tokenEstimate(row.token_estimate))throw corrupt()
 const fixed={runId:row.run_id,reservationId:row.reservation_id,state:row.state as TaskRunSubagentState,createdAt,...(row.child_session_id===null?{}:{childSessionId:row.child_session_id}),...(row.depth===null?{}:{depth:row.depth}),...(startedAt===undefined?{}:{startedAt}),...(endedAt===undefined?{}:{endedAt}),...(row.stop_reason===null?{}:{stopReason:row.stop_reason}),...(row.token_estimate===null?{}:{tokenEstimate:row.token_estimate})}
 if(fixed.state==='reserved'&&('childSessionId'in fixed||'depth'in fixed||'startedAt'in fixed||'endedAt'in fixed||'stopReason'in fixed))throw corrupt()
 if(fixed.state==='started'&&(!('childSessionId'in fixed)||!('depth'in fixed)||!('startedAt'in fixed)||'endedAt'in fixed||'stopReason'in fixed))throw corrupt()
 if(fixed.state==='ended'&&(!('childSessionId'in fixed)||!('depth'in fixed)||!('startedAt'in fixed)||!('endedAt'in fixed)||!('stopReason'in fixed)))throw corrupt()
 if(fixed.state==='abandoned'){
  const published='childSessionId'in fixed||'depth'in fixed||'startedAt'in fixed
  if(!('endedAt'in fixed)||!('stopReason'in fixed)||(published&&(!('childSessionId'in fixed)||!('depth'in fixed)||!('startedAt'in fixed)))||(!published&&('childSessionId'in fixed||'depth'in fixed||'startedAt'in fixed)))throw corrupt()
 }
 if(fixed.state!=='ended'&&'tokenEstimate'in fixed)throw corrupt()
 return fixed
}

export class TaskRunSubagentService{
 readonly pool:Pool;readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 async reserve(owner:string,input:unknown):Promise<{reservation:TaskRunSubagent;count:number}>{
  actor(owner);const row=taskInput(input,['runId','reservationId','limit'])
  if(!uuid(row.runId)||!reservation(row.reservationId)||!positive(row.limit)||row.limit>32)throw new WorkError('teloa/invalid-input','子 Agent 预留参数不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const run=(await db.query('select state,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,row.runId])).rows[0]
   if(!run)throw new WorkError('teloa/forbidden','执行不属于本人。')
   if(run.stop_requested_at!==null)throw new WorkError('teloa/conflict','本次执行已请求停止，不能派发子 Agent。')
   if(!['submitting','accepted','active'].includes(String(run.state)))throw new WorkError('teloa/conflict','当前 Run 生命周期不能派发子 Agent。')
   const prior=(await db.query('select * from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2 for update',[owner,row.reservationId])).rows[0]
   const count=Number((await db.query('select count(*)::integer count from teloa_task_run_subagents where owner_id=$1 and run_id=$2',[owner,row.runId])).rows[0]?.count)
   if(prior){const fixed=read(prior);if(fixed.runId!==row.runId)throw new WorkError('teloa/conflict','同一子 Agent 预留不能归属其他 Run。');await db.query('commit');return {reservation:fixed,count}}
   if(count>=row.limit)throw new WorkError('teloa/conflict','本次 Run 已达到子 Agent 累计上限。')
   const saved=(await db.query("insert into teloa_task_run_subagents(owner_id,run_id,reservation_id,state,created_at) values($1,$2,$3,'reserved',$4) returning *",[owner,row.runId,row.reservationId,this.identity.now()])).rows[0]
   const fixed=read(saved);await db.query('commit');return {reservation:fixed,count:count+1}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async release(owner:string,input:unknown):Promise<void>{
  actor(owner);const row=taskInput(input,['reservationId'])
  if(!reservation(row.reservationId))throw new WorkError('teloa/invalid-input','子 Agent 预留参数不正确。')
  const result=await this.pool.query("delete from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2 and state='reserved'",[owner,row.reservationId])
  if(result.rowCount===0){
   const stored=(await this.pool.query('select * from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2',[owner,row.reservationId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','子 Agent 预留不属于本人。')
   if(read(stored).state==='reserved')throw corrupt()
  }
 }
 async bind(owner:string,input:unknown):Promise<TaskRunSubagent>{
  actor(owner);const row=taskInput(input,['reservationId','childSessionId','depth'])
  if(!reservation(row.reservationId)||!session(row.childSessionId)||!positive(row.depth)||row.depth>32)throw new WorkError('teloa/invalid-input','子 Agent 启动登记参数不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   // 与 reserve、requestStop 同按父 Run → 子登记加锁，停止落库后不允许迟到的启动绑定。
   const run=(await db.query('select r.stop_requested_at,r.state from teloa_task_runs r join teloa_task_run_subagents s on s.run_id=r.id and s.owner_id=r.owner_id where s.owner_id=$1 and s.reservation_id=$2 for share of r',[owner,row.reservationId])).rows[0]
   if(!run)throw new WorkError('teloa/forbidden','子 Agent 预留不属于本人。')
   const stored=(await db.query('select * from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2 for update',[owner,row.reservationId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','子 Agent 预留不属于本人。')
   const current=read(stored)
   if(['started','ended','abandoned'].includes(current.state)&&current.childSessionId===row.childSessionId&&current.depth===row.depth){await db.query('commit');return current}
   if(!['submitting','accepted','active'].includes(String(run.state)))throw new WorkError('teloa/conflict','当前 Run 生命周期不能绑定新子 Agent。')
   if(run.stop_requested_at!==null)throw new WorkError('teloa/conflict','本次执行已请求停止，不能绑定新子 Agent。')
   if(current.state!=='reserved')throw new WorkError('teloa/conflict','子 Agent 预留已被使用或结束。')
   const saved=(await db.query("update teloa_task_run_subagents set child_session_id=$3,depth=$4,state='started',started_at=$5 where owner_id=$1 and reservation_id=$2 returning *",[owner,row.reservationId,row.childSessionId,row.depth,this.identity.now()])).rows[0]
   const fixed=read(saved);await db.query('commit');return fixed
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async settle(owner:string,input:unknown):Promise<TaskRunSubagent>{
  actor(owner);const row=taskInput(input,['childSessionId','stopReason','tokenEstimate'])
  if(!session(row.childSessionId)||!stopped(row.stopReason)||(row.tokenEstimate!==undefined&&!tokenEstimate(row.tokenEstimate)))throw new WorkError('teloa/invalid-input','子 Agent 结束登记参数不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const stored=(await db.query('select * from teloa_task_run_subagents where owner_id=$1 and child_session_id=$2 for update',[owner,row.childSessionId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','子 Agent 不属于本人。')
   const current=read(stored)
   if(current.state==='ended'||current.state==='abandoned'){
    if(current.state==='ended'&&row.tokenEstimate!==undefined&&current.tokenEstimate===undefined){
     const saved=(await db.query('update teloa_task_run_subagents set token_estimate=$3 where owner_id=$1 and reservation_id=$2 returning *',[owner,current.reservationId,row.tokenEstimate])).rows[0]
     const fixed=read(saved);await db.query('commit');return fixed
    }
    if(row.tokenEstimate!==undefined&&current.tokenEstimate!==undefined&&row.tokenEstimate!==current.tokenEstimate)throw new WorkError('teloa/conflict','子 Agent 令牌估算与已保存结果不一致。')
    await db.query('commit');return current
   }
   if(current.state!=='started')throw corrupt()
   const saved=(await db.query("update teloa_task_run_subagents set state='ended',ended_at=$3,stop_reason=$4,token_estimate=$5 where owner_id=$1 and reservation_id=$2 returning *",[owner,current.reservationId,this.identity.now(),row.stopReason,row.tokenEstimate??null])).rows[0]
   const fixed=read(saved);await db.query('commit');return fixed
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 已发布子会话却未能正常结算时，保留真实身份并结束该条登记。 */
 async abandon(owner:string,input:unknown):Promise<TaskRunSubagent>{
  actor(owner);const row=taskInput(input,['reservationId','childSessionId','depth','stopReason'])
  if(!reservation(row.reservationId)||!session(row.childSessionId)||!positive(row.depth)||row.depth>32||!stopped(row.stopReason))throw new WorkError('teloa/invalid-input','子 Agent 中止登记参数不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const stored=(await db.query('select * from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2 for update',[owner,row.reservationId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','子 Agent 预留不属于本人。')
   const current=read(stored)
   if(current.state==='ended'||current.state==='abandoned'){await db.query('commit');return current}
   if(current.childSessionId!==undefined&&(current.childSessionId!==row.childSessionId||current.depth!==row.depth))throw new WorkError('teloa/conflict','子 Agent 中止登记与已绑定身份不一致。')
   const now=this.identity.now(),saved=(await db.query("update teloa_task_run_subagents set child_session_id=$3,depth=$4,state='abandoned',started_at=coalesce(started_at,$5),ended_at=$5,stop_reason=$6 where owner_id=$1 and reservation_id=$2 returning *",[owner,row.reservationId,row.childSessionId,row.depth,now,row.stopReason])).rows[0]
   const fixed=read(saved);await db.query('commit');return fixed
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /**
  * 人工取消尚未发布子会话的预留。已启动子任务仍可能持有原生工具，必须保持 fail-closed，
  * 等原生会话结束后由正常结算路径核对；父 Run 在此之前继续受 outstanding 守卫阻塞。
  */
 async recover(owner:string,input:unknown):Promise<TaskRunSubagent>{
  actor(owner);const row=taskInput(input,['runId','reservationId'])
  if(!uuid(row.runId)||!reservation(row.reservationId))throw new WorkError('teloa/invalid-input','子 Agent 恢复参数不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const stored=(await db.query('select * from teloa_task_run_subagents where owner_id=$1 and reservation_id=$2 for update',[owner,row.reservationId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','子 Agent 预留不属于本人。')
   const current=read(stored)
   if(current.runId!==row.runId)throw new WorkError('teloa/conflict','子 Agent 预留不属于该执行。')
   if(current.state==='started')throw new WorkError('teloa/conflict','子 Agent 已启动，请先在原生会话结束后再核对。')
   if(current.state!=='reserved')throw new WorkError('teloa/conflict','子 Agent 已有结局，不能重复恢复。')
   const saved=(await db.query("update teloa_task_run_subagents set state='abandoned',ended_at=$3,stop_reason='manual-recovery' where owner_id=$1 and reservation_id=$2 returning *",[owner,row.reservationId,this.identity.now()])).rows[0]
   const fixed=read(saved);await db.query('commit');return fixed
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async outstanding(owner:string,runId:string):Promise<TaskRunSubagent[]>{
  actor(owner);if(!uuid(runId))throw new WorkError('teloa/invalid-input','执行身份不正确。')
  const result=await this.pool.query("select * from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and state in ('reserved','started') order by created_at,reservation_id",[owner,runId])
  return result.rows.map(read)
 }
 async list(owner:string,runId:string):Promise<TaskRunSubagent[]>{
  actor(owner);if(!uuid(runId))throw new WorkError('teloa/invalid-input','执行身份不正确。')
  const result=await this.pool.query('select * from teloa_task_run_subagents where owner_id=$1 and run_id=$2 order by created_at,reservation_id',[owner,runId])
  return result.rows.map(read)
 }
 async listMany(owner:string,runIds:readonly string[]):Promise<Map<string,TaskRunSubagent[]>>{
  actor(owner);if(runIds.some(id=>!uuid(id))||new Set(runIds).size!==runIds.length)throw new WorkError('teloa/invalid-input','执行身份不正确。')
  const grouped=new Map<string,TaskRunSubagent[]>();if(!runIds.length)return grouped
  const owned=await this.pool.query('select id from teloa_task_runs where owner_id=$1 and id=any($2::uuid[])',[owner,runIds])
  if(owned.rows.length!==runIds.length)throw new WorkError('teloa/forbidden','执行不属于本人。')
  const rows=await this.pool.query('select * from teloa_task_run_subagents where owner_id=$1 and run_id=any($2::uuid[]) order by run_id,created_at,reservation_id',[owner,runIds])
  for(const row of rows.rows){const fixed=read(row),items=grouped.get(fixed.runId)??[];items.push(fixed);grouped.set(fixed.runId,items)}
  return grouped
 }
}
