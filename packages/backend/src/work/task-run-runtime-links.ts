import type {Pool} from 'pg'
import {WorkError,taskInput} from '@teloa/contract'

type JobStatus='running'|'stopping'|'completed'|'killed'|'failed'
type JobOwner={record:'owner';runtimeId:string;requestId:string}
type JobRecord={record:'job';runtimeId:string;requestId:string;jobId:string;status:JobStatus}
type TeamRecord={requestId:string;reservationId:string;name:string}
type BrowserRecord={runtimeId:string;requestId:string;dispatchId:string;status:'dirty'|'closed'}
export type TaskRunRuntimeLink={runId:string;nativeId:string;sessionId:string}&({kind:'job';payload:JobOwner|JobRecord}|{kind:'team';payload:TeamRecord}|{kind:'browser';payload:BrowserRecord})
export type TaskRunRuntimeLinks={list:(input:{runId:string;kind?:TaskRunRuntimeLink['kind']})=>Promise<readonly TaskRunRuntimeLink[]>;put:(input:TaskRunRuntimeLink)=>Promise<void>}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/[\u0000-\u001f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','原生执行关联格式不正确。')
const actor=(owner:string)=>{if(!text(owner)||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')}
const statuses:readonly JobStatus[]=['running','stopping','completed','killed','failed']
function parse(input:unknown):TaskRunRuntimeLink{
 const row=taskInput(input,['runId','kind','nativeId','sessionId','payload'])
 if(!uuid(row.runId)||!text(row.nativeId)||!text(row.sessionId)||row.sessionId.length>128)throw invalid()
 const base={runId:row.runId,nativeId:row.nativeId,sessionId:row.sessionId}
 if(row.kind==='browser'){
  const p=taskInput(row.payload,['runtimeId','requestId','dispatchId','status'])
  if(!text(p.runtimeId)||!uuid(p.requestId)||!text(p.dispatchId)||!['dirty','closed'].includes(p.status as string)||row.nativeId!==`${p.runtimeId}:${p.dispatchId}`)throw invalid()
  return {...base,kind:'browser',payload:{runtimeId:p.runtimeId,requestId:p.requestId,dispatchId:p.dispatchId,status:p.status as BrowserRecord['status']}}
 }
 if(row.kind==='team'){
  const p=taskInput(row.payload,['requestId','reservationId','name'])
  if(!uuid(p.requestId)||!text(p.reservationId)||!text(p.name)||row.nativeId!==p.reservationId)throw invalid()
  return {...base,kind:'team',payload:{requestId:p.requestId,reservationId:p.reservationId,name:p.name}}
 }
 if(row.kind!=='job')throw invalid()
 const p=taskInput(row.payload,['record','runtimeId','requestId','jobId','status'])
 if(!text(p.runtimeId)||!uuid(p.requestId))throw invalid()
 if(p.record==='owner'){
  if(Object.hasOwn(p,'jobId')||Object.hasOwn(p,'status')||row.nativeId!==`owner:${p.runtimeId}:${row.sessionId}`)throw invalid()
  return {...base,kind:'job',payload:{record:'owner',runtimeId:p.runtimeId,requestId:p.requestId}}
 }
 if(p.record!=='job'||!text(p.jobId)||!statuses.includes(p.status as JobStatus)||row.nativeId!==`${p.runtimeId}:${p.jobId}`)throw invalid()
 return {...base,kind:'job',payload:{record:'job',runtimeId:p.runtimeId,requestId:p.requestId,jobId:p.jobId,status:p.status as JobStatus}}
}
function stored(row:Record<string,unknown>):TaskRunRuntimeLink{
 try{return parse({runId:row.run_id,kind:row.kind,nativeId:row.native_id,sessionId:row.session_id,payload:row.payload})}
 catch{throw new WorkError('teloa/storage-corrupt','原生执行关联损坏，已停止读取。')}
}
export async function initializeTaskRunRuntimeLinks(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_task_run_runtime_links(
  owner_id text not null,run_id uuid not null,kind text not null check(kind in ('job','team','browser')),
  native_id text not null,session_id text not null,payload jsonb not null check(jsonb_typeof(payload)='object'),
  primary key(owner_id,run_id,kind,native_id),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
 // RC 隔离宿主可能已经建过只含 job/team 的表。单条 DDL 原子替换 CHECK，保留所有关联。
 await pool.query(`alter table teloa_task_run_runtime_links
  drop constraint if exists teloa_task_run_runtime_links_kind_check,
  add constraint teloa_task_run_runtime_links_kind_check check(kind in ('job','team','browser'))`)
}
/** 仅保存业务 Run 与官方运行身份的关联；不复制 jobs、Team 任务板或消息队列。 */
export class TaskRunRuntimeLinkService{
 readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 async put(owner:string,input:unknown):Promise<void>{
  actor(owner);const link=parse(input),db=await this.pool.connect()
  try{
   await db.query('begin')
   // 同一个 Run 内串行核验/更新关联，不以 upsert 覆盖旧身份。
   const run=(await db.query('select session_id,native_request_id,state,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,link.runId])).rows[0]
   if(!run)throw new WorkError('teloa/forbidden','执行不属于本人。')
   const previous=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind=$3 and native_id=$4',[owner,link.runId,link.kind,link.nativeId])).rows[0]
   // 原有关联仍可登记真实收尾；终态或停止后的 Run 不能追加新运行身份。
   if(!previous&&(!['submitting','accepted','active'].includes(String(run.state))||run.stop_requested_at!==null))throw new WorkError('teloa/conflict','当前 Run 已停止或结束，不能登记新的原生运行关联。')
   if(!previous&&link.kind==='browser'&&link.payload.status!=='dirty')throw new WorkError('teloa/conflict','浏览器收尾必须先有持久派发记录。')
   if(previous){
    const prior=stored(previous)
    if(prior.kind==='job'&&link.kind==='job'&&prior.payload.record==='job'&&link.payload.record==='job'){
     const {status:oldStatus,...oldIdentity}=prior.payload,{status,...identity}=link.payload
     if(prior.sessionId!==link.sessionId||JSON.stringify(oldIdentity)!==JSON.stringify(identity))throw new WorkError('teloa/conflict','原生执行身份不能改写。')
     if(oldStatus!==status&&(oldStatus==='completed'||oldStatus==='killed'||oldStatus==='failed'||oldStatus==='stopping'&&status==='running'))throw new WorkError('teloa/conflict','原生执行终态不能回退或改写。')
    }else if(prior.kind==='browser'&&link.kind==='browser'){
     const {status:oldStatus,...oldIdentity}=prior.payload,{status,...identity}=link.payload
     if(prior.sessionId!==link.sessionId||JSON.stringify(oldIdentity)!==JSON.stringify(identity))throw new WorkError('teloa/conflict','原生执行身份不能改写。')
     if(oldStatus==='closed'&&status!=='closed')throw new WorkError('teloa/conflict','原生执行终态不能回退或改写。')
    }else if(JSON.stringify(prior)!==JSON.stringify(link))throw new WorkError('teloa/conflict','原生执行身份不能改写。')
   }
   if(run.native_request_id!==link.payload.requestId)throw new WorkError('teloa/forbidden','原生请求不属于本次执行。')
   if(run.session_id!==link.sessionId){
    const child=(link.kind==='job'||link.kind==='browser')&&(await db.query('select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and child_session_id=$3',[owner,link.runId,link.sessionId])).rowCount
    if(!child)throw new WorkError('teloa/forbidden','原生会话不属于本次执行。')
   }
   await db.query('insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,$3,$4,$5,$6) on conflict(owner_id,run_id,kind,native_id) do update set payload=excluded.payload',[owner,link.runId,link.kind,link.nativeId,link.sessionId,JSON.stringify(link.payload)])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(owner:string,input:unknown):Promise<TaskRunRuntimeLink[]>{
  actor(owner);const row=taskInput(input,['runId','kind'])
  if(!uuid(row.runId)||(row.kind!==undefined&&row.kind!=='job'&&row.kind!=='team'&&row.kind!=='browser'))throw invalid()
  const run=await this.pool.query('select 1 from teloa_task_runs where owner_id=$1 and id=$2',[owner,row.runId])
  if(!run.rowCount)throw new WorkError('teloa/forbidden','执行不属于本人。')
  return (await this.pool.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and ($3::text is null or kind=$3) order by kind,native_id',[owner,row.runId,row.kind??null])).rows.map(stored)
 }
}
