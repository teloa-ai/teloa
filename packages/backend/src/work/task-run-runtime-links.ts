import type {Pool} from 'pg'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {isAbsolute,normalize} from 'node:path'
import {WorkError,taskInput} from '@teloa/contract'
import {runEvidence,type TaskRunEvidence} from './task-run-evidence.ts'
import {readStoredTaskRun} from './task-runs.ts'

/** 宿主核对原生终态及实际资源后保存；不进入模型或浏览器写接口。 */
export type TaskRunOwnerSettlement={schema:'teloa.task-run-owner-settlement/v1';runId:string;nativeId:string;sessionId:string;nativeRequestId:string;inputSha256:string;evidence:Extract<TaskRunEvidence,{state:'ended'}>;prefixLength:number;prefixSha256:string;observedAt:string}

type JobStatus='running'|'stopping'|'completed'|'killed'|'failed'
type JobOwner={record:'owner';runtimeId:string;requestId:string}
type JobRecord={record:'job';runtimeId:string;requestId:string;jobId:string;status:JobStatus}
type TeamRecord={requestId:string;reservationId:string;name:string}
type BrowserRecord={runtimeId:string;requestId:string;dispatchId:string;status:'dirty'|'closed'}
export type ExternalHarnessProvider='codex'|'claude-code'
export type ExternalHarnessStatus='reserved'|'running'|'stopping'|'completed'|'failed'|'aborted'|'unknown'
type ExternalRecord={provider:ExternalHarnessProvider;runtimeId:string;requestId:string;reservationId:string;workspaceRoot:string;activationId?:string;status:ExternalHarnessStatus}
export type ExternalHarnessReservation=Omit<ExternalRecord,'activationId'|'status'>&{runId:string;maxPerRun:number}
export type TaskRunRuntimeLink={runId:string;nativeId:string;sessionId:string}&({kind:'job';payload:JobOwner|JobRecord}|{kind:'team';payload:TeamRecord}|{kind:'browser';payload:BrowserRecord}|{kind:'external';payload:ExternalRecord})
export type TaskRunRuntimeLinks={list:(input:{runId:string;kind?:TaskRunRuntimeLink['kind']})=>Promise<readonly TaskRunRuntimeLink[]>;put:(input:TaskRunRuntimeLink)=>Promise<void>}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const text=(value:unknown):value is string=>typeof value==='string'&&value.trim().length>0&&value.length<=512&&!/[\u0000-\u001f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','原生执行关联格式不正确。')
export function readTaskRunOwnerSettlement(value:unknown):TaskRunOwnerSettlement{
 const row=taskInput(value,['schema','runId','nativeId','sessionId','nativeRequestId','inputSha256','evidence','prefixLength','prefixSha256','observedAt']),evidence=runEvidence(row.evidence)
 if(row.schema!=='teloa.task-run-owner-settlement/v1'||!uuid(row.runId)||!text(row.nativeId)||!text(row.sessionId)||row.sessionId.length>128||!uuid(row.nativeRequestId)||typeof row.inputSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.inputSha256)||typeof row.prefixSha256!=='string'||!/^[a-f0-9]{64}$/.test(row.prefixSha256)||evidence.state!=='ended'||row.prefixLength!==evidence.endSeq+1||typeof row.observedAt!=='string'||!Number.isFinite(Date.parse(row.observedAt))||new Date(row.observedAt).toISOString()!==row.observedAt||Date.parse(row.observedAt)>Date.now())throw invalid()
 return {schema:'teloa.task-run-owner-settlement/v1',runId:row.runId,nativeId:row.nativeId,sessionId:row.sessionId,nativeRequestId:row.nativeRequestId,inputSha256:row.inputSha256,evidence,prefixLength:row.prefixLength as number,prefixSha256:row.prefixSha256,observedAt:row.observedAt}
}
const actor=(owner:string)=>{if(!text(owner)||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')}
const statuses:readonly JobStatus[]=['running','stopping','completed','killed','failed']
const externalStatuses:readonly ExternalHarnessStatus[]=['reserved','running','stopping','completed','failed','aborted','unknown']
const externalTerminal=(status:ExternalHarnessStatus)=>['completed','failed','aborted','unknown'].includes(status)
function externalPayload(value:unknown):ExternalRecord{
 const p=taskInput(value,['provider','runtimeId','requestId','reservationId','workspaceRoot','activationId','status'])
 if(!['codex','claude-code'].includes(p.provider as string)||!text(p.runtimeId)||!uuid(p.requestId)||!text(p.reservationId)||!text(p.workspaceRoot)||!isAbsolute(p.workspaceRoot)||normalize(p.workspaceRoot)!==p.workspaceRoot||!externalStatuses.includes(p.status as ExternalHarnessStatus)||(p.activationId!==undefined&&!text(p.activationId))||(['running','stopping','completed'].includes(p.status as string)&&p.activationId===undefined))throw invalid()
 return {provider:p.provider as ExternalHarnessProvider,runtimeId:p.runtimeId,requestId:p.requestId,reservationId:p.reservationId,workspaceRoot:p.workspaceRoot,...(p.activationId===undefined?{}:{activationId:p.activationId as string}),status:p.status as ExternalHarnessStatus}
}
function parse(input:unknown):TaskRunRuntimeLink{
 const row=taskInput(input,['runId','kind','nativeId','sessionId','payload'])
 if(!uuid(row.runId)||!text(row.nativeId)||!text(row.sessionId)||row.sessionId.length>128)throw invalid()
 const base={runId:row.runId,nativeId:row.nativeId,sessionId:row.sessionId}
 if(row.kind==='external'){
  const payload=externalPayload(row.payload)
  if(row.nativeId!==payload.reservationId)throw invalid()
  return {...base,kind:'external',payload}
 }
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
  owner_id text not null,run_id uuid not null,kind text not null check(kind in ('job','team','browser','external')),
  native_id text not null,session_id text not null,payload jsonb not null check(jsonb_typeof(payload)='object'),
  primary key(owner_id,run_id,kind,native_id),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
 await pool.query('alter table teloa_task_run_runtime_links add column if not exists owner_settlement jsonb')
 // RC 隔离宿主可能已经建过只含 job/team 的表。单条 DDL 原子替换 CHECK，保留所有关联。
 await pool.query(`alter table teloa_task_run_runtime_links
  drop constraint if exists teloa_task_run_runtime_links_kind_check,
  add constraint teloa_task_run_runtime_links_kind_check check(kind in ('job','team','browser','external'))`)
}
/** 调用者已持有父 Run 行锁，本地与外部预留因此共享同一个串行额度。 */
export async function countTaskRunDelegations(db:Pick<Pool,'query'>,owner:string,runId:string):Promise<number>{
 const count=Number((await db.query("select ((select count(*) from teloa_task_run_subagents where owner_id=$1 and run_id=$2)+(select count(*) from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind='external'))::integer count",[owner,runId])).rows[0]?.count)
 if(!Number.isSafeInteger(count)||count<0)throw new WorkError('teloa/storage-corrupt','无法核对本次委派额度。')
 return count
}
/** 仅保存业务 Run 与官方运行身份的关联；不复制 jobs、Team 任务板或消息队列。 */
export class TaskRunRuntimeLinkService{
 readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 /** 只供已核验原生会话和实际资源的宿主调用；不提供浏览器或模型写入口。 */
 async recordOwnerSettlement(owner:string,input:TaskRunOwnerSettlement):Promise<void>{
  actor(owner);const proof=readTaskRunOwnerSettlement(input),db=await this.pool.connect()
  try{
   await db.query('begin')
   const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,proof.runId])).rows[0]
   if(!raw)throw new WorkError('teloa/forbidden','宿主收口回执不属于本人原运行。')
   const run=readStoredTaskRun(raw),link=(await db.query("select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind='job' and native_id=$3 for update",[owner,run.id,proof.nativeId])).rows[0]
   if(!link)throw new WorkError('teloa/forbidden','没有原运行的宿主登记，不能补造收口回执。')
   const fixed=stored(link)
   if(fixed.kind!=='job'||fixed.payload.record!=='owner'||fixed.sessionId!==run.sessionId||fixed.payload.requestId!==run.nativeRequestId||proof.sessionId!==run.sessionId||proof.nativeRequestId!==run.nativeRequestId||run.state!=='ended'||!isDeepStrictEqual(run.evidence,proof.evidence)||proof.inputSha256!==createHash('sha256').update(run.inputText).digest('hex')||proof.observedAt<run.createdAt)throw new WorkError('teloa/conflict','宿主收口回执与原运行、输入或终态不一致。')
   if(link.owner_settlement!==null&&link.owner_settlement!==undefined){
    const previous=readTaskRunOwnerSettlement(link.owner_settlement),{observedAt:_previousAt,...before}=previous,{observedAt:_nextAt,...after}=proof
    if(!isDeepStrictEqual(before,after))throw new WorkError('teloa/conflict','原宿主收口回执不能改写。')
   }else await db.query("update teloa_task_run_runtime_links set owner_settlement=$4 where owner_id=$1 and run_id=$2 and kind='job' and native_id=$3",[owner,run.id,proof.nativeId,JSON.stringify(proof)])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 与本地子任务共用父 Run 行锁；同一预留只给一位调用者启动许可。 */
 async reserveExternal(owner:string,input:unknown):Promise<void>{
  actor(owner)
  const row=taskInput(input,['runId','requestId','reservationId','runtimeId','workspaceRoot','provider','maxPerRun'])
  if(!uuid(row.runId)||!Number.isSafeInteger(row.maxPerRun)||(row.maxPerRun as number)<1||(row.maxPerRun as number)>32)throw invalid()
  const runId=row.runId,limit=row.maxPerRun as number
  const payload=externalPayload({provider:row.provider,runtimeId:row.runtimeId,requestId:row.requestId,reservationId:row.reservationId,workspaceRoot:row.workspaceRoot,status:'reserved'}),db=await this.pool.connect()
  try{
   await db.query('begin')
   const run=(await db.query('select session_id,native_request_id,state,stop_requested_at,allowed_tools from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,runId])).rows[0]
   if(!run||run.native_request_id!==payload.requestId)throw new WorkError('teloa/forbidden','外部执行不属于本人或当前请求。')
   if(run.stop_requested_at!==null||!['submitting','accepted','active'].includes(String(run.state)))throw new WorkError('teloa/conflict','本次执行已停止或结束，不能派发外部工作。')
   const tool=payload.provider==='codex'?'subagent_codex':'subagent_claude_code'
   if(!Array.isArray(run.allowed_tools)||!run.allowed_tools.includes(tool))throw new WorkError('teloa/forbidden','本次执行未授权此外部引擎。')
   const prior=await db.query("select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind='external' and native_id=$3",[owner,runId,payload.reservationId])
   if(prior.rowCount)throw new WorkError('teloa/execution-pending','外部工作已有预留，请核对原回执，不能重新派发。')
   if(await countTaskRunDelegations(db,owner,runId)>=limit)throw new WorkError('teloa/conflict','本次 Run 已达到委派累计上限。')
   await db.query("insert into teloa_task_run_runtime_links(owner_id,run_id,kind,native_id,session_id,payload) values($1,$2,'external',$3,$4,$5)",[owner,runId,payload.reservationId,run.session_id,JSON.stringify(payload)])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async put(owner:string,input:unknown):Promise<void>{
  actor(owner);const link=parse(input),db=await this.pool.connect()
  try{
   await db.query('begin')
   // 同一个 Run 内串行核验/更新关联，不以 upsert 覆盖旧身份。
   const run=(await db.query('select session_id,native_request_id,state,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,link.runId])).rows[0]
   if(!run)throw new WorkError('teloa/forbidden','执行不属于本人。')
   const previous=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind=$3 and native_id=$4',[owner,link.runId,link.kind,link.nativeId])).rows[0]
   if(!previous&&link.kind==='external')throw new WorkError('teloa/conflict','外部执行必须先取得持久预留。')
   // 原有关联仍可登记真实收尾；终态或停止后的 Run 不能追加新运行身份。
   if(!previous&&(!['submitting','accepted','active'].includes(String(run.state))||run.stop_requested_at!==null))throw new WorkError('teloa/conflict','当前 Run 已停止或结束，不能登记新的原生运行关联。')
   if(!previous&&link.kind==='browser'&&link.payload.status!=='dirty')throw new WorkError('teloa/conflict','浏览器收尾必须先有持久派发记录。')
   if(previous){
    const prior=stored(previous)
    if(prior.kind==='external'&&link.kind==='external'){
     const {status:oldStatus,activationId:oldActivation,...oldIdentity}=prior.payload,{status,activationId,...identity}=link.payload
     if(prior.sessionId!==link.sessionId||JSON.stringify(oldIdentity)!==JSON.stringify(identity)||oldActivation!==undefined&&activationId!==oldActivation)throw new WorkError('teloa/conflict','外部执行身份不能改写。')
     if(status!==oldStatus&&(externalTerminal(oldStatus)||oldStatus==='stopping'&&status==='running'||oldStatus!=='reserved'&&status==='reserved'))throw new WorkError('teloa/conflict','外部执行终态不能回退或改写。')
     if(status==='running'&&(run.stop_requested_at!==null||!['submitting','accepted','active'].includes(String(run.state))))throw new WorkError('teloa/conflict','本次执行已停止，不能绑定新的运行活动。')
    }else if(prior.kind==='job'&&link.kind==='job'&&prior.payload.record==='job'&&link.payload.record==='job'){
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
  return this.listInTransaction(this.pool,owner,input)
 }
 async listInTransaction(db:Pick<Pool,'query'>,owner:string,input:unknown):Promise<TaskRunRuntimeLink[]>{
  actor(owner);const row=taskInput(input,['runId','kind'])
  if(!uuid(row.runId)||(row.kind!==undefined&&row.kind!=='job'&&row.kind!=='team'&&row.kind!=='browser'&&row.kind!=='external'))throw invalid()
  const run=await db.query('select 1 from teloa_task_runs where owner_id=$1 and id=$2',[owner,row.runId])
  if(!run.rowCount)throw new WorkError('teloa/forbidden','执行不属于本人。')
  return (await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and ($3::text is null or kind=$3) order by kind,native_id',[owner,row.runId,row.kind??null])).rows.map(stored)
 }
}
