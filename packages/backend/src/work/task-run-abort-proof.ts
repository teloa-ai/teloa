import type {Pool,PoolClient} from 'pg'
import type {TaskRun} from './task-runs.ts'
import {createHash} from 'node:crypto'
import {WorkError,taskInput} from '@teloa/contract'
export type NativeRunAbortProof={runId:string;sessionId:string;nativeRequestId:string;turn:number;ownedEndTurn:number;messageSeq:number;endSeq:number;logCut:number;inheritedEventCount:number;reason:'aborted';source:'native-turn-end';eventHash:string;settlementHash:string}
export type NativeJobOwnerSettlement={nativeId:string;runtimeId:string;observedRuntimeId:string;sessionId:string;requestId:string;logCut:number;inbox:{nextTurn:string[];nextStep:string[]};jobs:Array<{id:string;status:'completed'|'killed'|'failed';startedAt:number;finishedAt:number}>}
export type NativeRunResourceSettlement={source:'native-maintenance-jobs';owners:NativeJobOwnerSettlement[]}
const conflict=()=>new WorkError('teloa/conflict','原生取消证明缺失、陈旧或关联尚未结清，请重新核对。')
const natural=(v:unknown):v is number=>Number.isSafeInteger(v)&&(v as number)>=0
const hash=(v:unknown):v is string=>typeof v==='string'&&/^[0-9a-f]{64}$/.test(v)
/** 固定对象键与数据库排序；日期使用持久时间，数组顺序不改写。 */
function canonical(value:unknown):unknown{
 if(value instanceof Date)return value.toISOString()
 if(Array.isArray(value))return value.map(canonical)
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical((value as Record<string,unknown>)[key])]))
 return value
}
export function hashNativeRunSettlement(settlement:string):string{return createHash('sha256').update(settlement).digest('hex')}
export async function initializeTaskRunAbortProofs(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_task_run_abort_proofs(
  owner_id text not null,run_id uuid not null,proof jsonb not null check(jsonb_typeof(proof)='object'),
  settlement text not null,created_at timestamptz not null default now(),primary key(owner_id,run_id),
  foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 );create table if not exists teloa_task_run_native_settlements(
  owner_id text not null,run_id uuid not null,observations jsonb not null check(jsonb_typeof(observations)='object'),
  association_hash text not null check(association_hash ~ '^[0-9a-f]{64}$'),created_at timestamptz not null default now(),
  primary key(owner_id,run_id),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
}
type Settlement={schema:string;run:Record<string,unknown>;subagents:Record<string,unknown>[];runtimeLinks:Record<string,unknown>[];resourceSettlement:{observations:NativeRunResourceSettlement;association_hash:string}|null}
export async function readNativeRunSettlement(db:PoolClient,owner:string,run:TaskRun):Promise<string>{
 const current=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,run.id])).rows[0] as Record<string,unknown>|undefined
 if(!current||current.task_id!==run.taskId||current.session_id!==run.sessionId||current.native_request_id!==run.nativeRequestId||current.state!==run.state||JSON.stringify(canonical(current.evidence))!==JSON.stringify(canonical(run.evidence))||canonical(current.stop_requested_at)!==run.stopRequestedAt)throw conflict()
 const subagents=(await db.query('select * from teloa_task_run_subagents where owner_id=$1 and run_id=$2 order by reservation_id',[owner,run.id])).rows as Record<string,unknown>[]
 const runtimeLinks=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 order by kind,native_id',[owner,run.id])).rows as Record<string,unknown>[]
 const resourceSettlement=(await db.query('select observations,association_hash from teloa_task_run_native_settlements where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0]??null
 return JSON.stringify(canonical({schema:'teloa.native-run-settlement/v1',run:current,subagents,runtimeLinks,resourceSettlement}))
}
function associationHash(snapshot:Settlement):string{return hashNativeRunSettlement(JSON.stringify(canonical({...snapshot,resourceSettlement:null})))}
function assertJobOwnerCoverage(snapshot:Settlement):void{
 const owners=snapshot.runtimeLinks.filter(link=>link.kind==='job'&&(link.payload as Record<string,unknown>)?.record==='owner')
 for(const link of snapshot.runtimeLinks){
  if(link.kind!=='job')continue
  const payload=link.payload as Record<string,unknown>|undefined
  if(!payload||!['owner','job'].includes(String(payload.record)))throw conflict()
  if(payload.record==='job'&&owners.filter(owner=>owner.session_id===link.session_id&&(owner.payload as Record<string,unknown>).runtimeId===payload.runtimeId&&(owner.payload as Record<string,unknown>).requestId===payload.requestId).length!==1)throw conflict()
 }
}
function resourceFacts(input:unknown,snapshot:Settlement):NativeRunResourceSettlement{
 assertJobOwnerCoverage(snapshot)
 const row=taskInput(input,['source','owners'])
 if(row.source!=='native-maintenance-jobs'||!Array.isArray(row.owners))throw conflict()
 const expected=snapshot.runtimeLinks.filter(link=>link.kind==='job'&&(link.payload as Record<string,unknown>).record==='owner')
 if(row.owners.length!==expected.length)throw conflict()
 const seen=new Set<string>(),owners:NativeJobOwnerSettlement[]=[]
 for(const inputOwner of row.owners){
  const owner=taskInput(inputOwner,['nativeId','runtimeId','observedRuntimeId','sessionId','requestId','logCut','inbox','jobs'])
  const link=expected.find(link=>link.native_id===owner.nativeId),payload=link?.payload as Record<string,unknown>|undefined
  if(!link||!payload||typeof owner.nativeId!=='string'||typeof owner.runtimeId!=='string'||typeof owner.observedRuntimeId!=='string'||typeof owner.sessionId!=='string'||typeof owner.requestId!=='string'||seen.has(owner.nativeId)||owner.runtimeId!==payload.runtimeId||owner.observedRuntimeId!==owner.runtimeId||owner.sessionId!==link.session_id||owner.requestId!==payload.requestId||owner.requestId!==snapshot.run.native_request_id||!natural(owner.logCut)||owner.logCut<Number((snapshot.run.evidence as {endSeq?:number})?.endSeq)||!Array.isArray(owner.jobs))throw conflict()
  const inbox=taskInput(owner.inbox,['nextTurn','nextStep'])
  if(!Array.isArray(inbox.nextTurn)||inbox.nextTurn.length||!Array.isArray(inbox.nextStep)||inbox.nextStep.length)throw conflict()
  const expectedJobs=snapshot.runtimeLinks.filter(item=>item.kind==='job'&&item.session_id===owner.sessionId&&(item.payload as Record<string,unknown>).record==='job'&&(item.payload as Record<string,unknown>).runtimeId===owner.runtimeId)
  if(expectedJobs.length!==owner.jobs.length)throw conflict()
  const jobIds=new Set<string>(),jobs:NativeJobOwnerSettlement['jobs']=[]
  for(const inputJob of owner.jobs){
   const job=taskInput(inputJob,['id','status','startedAt','finishedAt'])
   const stored=expectedJobs.find(item=>(item.payload as Record<string,unknown>).jobId===job.id)?.payload as Record<string,unknown>|undefined
   if(typeof job.id!=='string'||jobIds.has(job.id)||!stored||stored.requestId!==snapshot.run.native_request_id||job.status!==stored.status||!['completed','killed','failed'].includes(String(job.status))||!natural(job.startedAt)||!natural(job.finishedAt)||job.finishedAt<job.startedAt)throw conflict()
   jobIds.add(job.id);jobs.push(job as NativeJobOwnerSettlement['jobs'][number])
  }
  jobs.sort((a,b)=>Buffer.compare(Buffer.from(a.id),Buffer.from(b.id)))
  seen.add(owner.nativeId);owners.push({nativeId:owner.nativeId,runtimeId:owner.runtimeId,observedRuntimeId:owner.observedRuntimeId,sessionId:owner.sessionId,requestId:owner.requestId,logCut:owner.logCut,inbox:{nextTurn:[],nextStep:[]},jobs})
 }
 owners.sort((a,b)=>Buffer.compare(Buffer.from(a.nativeId),Buffer.from(b.nativeId)))
 return {source:'native-maintenance-jobs',owners}
}
/** 仅宿主维护闭包调用；不开放 RPC，也不接受模型/浏览器提交这些事实。 */
export async function recordNativeRunResourceSettlement(db:PoolClient,owner:string,run:TaskRun,before:string,observations:NativeRunResourceSettlement):Promise<void>{
 const current=await readNativeRunSettlement(db,owner,run)
 if(current!==before||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='aborted'||!run.stopRequestedAt)throw conflict()
 const snapshot=JSON.parse(current) as Settlement,fixed=resourceFacts(observations,snapshot),identityHash=associationHash(snapshot)
 if(snapshot.resourceSettlement){if(snapshot.resourceSettlement.association_hash!==identityHash||JSON.stringify(canonical(snapshot.resourceSettlement.observations))!==JSON.stringify(canonical(fixed)))throw conflict();return}
 await db.query('insert into teloa_task_run_native_settlements(owner_id,run_id,observations,association_hash) values($1,$2,$3,$4)',[owner,run.id,JSON.stringify(fixed),identityHash])
}
function assertSettled(settlement:string):void{
 const snapshot=JSON.parse(settlement) as Settlement
 // 登记结束不等于 child 的原生终态；旧 child/Team/job owner 尚无持久权威结清面，保持拒绝。
 if(snapshot.subagents.length)throw conflict()
 assertJobOwnerCoverage(snapshot)
 let facts:NativeRunResourceSettlement|undefined
 if(snapshot.runtimeLinks.some(link=>link.kind==='job')){
  if(!snapshot.resourceSettlement||snapshot.resourceSettlement.association_hash!==associationHash(snapshot))throw conflict()
  facts=resourceFacts(snapshot.resourceSettlement.observations,snapshot)
 }
 for(const link of snapshot.runtimeLinks){
  const payload=link.payload as Record<string,unknown>|undefined
  if(!payload)throw conflict()
  if(link.kind==='browser'&&payload.status==='closed')continue
  if(link.kind==='job'&&facts){
   if(payload.record==='owner'&&facts.owners.some(owner=>owner.nativeId===link.native_id))continue
   if(payload.record==='job'&&facts.owners.some(owner=>owner.runtimeId===payload.runtimeId&&owner.sessionId===link.session_id&&owner.requestId===payload.requestId&&owner.jobs.some(job=>job.id===payload.jobId&&job.status===payload.status)))continue
  }
  throw conflict()
 }
}
function readProof(input:unknown,run:TaskRun):NativeRunAbortProof{
 const p=taskInput(input,['runId','sessionId','nativeRequestId','turn','ownedEndTurn','messageSeq','endSeq','logCut','inheritedEventCount','reason','source','eventHash','settlementHash'])
 const evidence=run.evidence
 if(run.state!=='ended'||!run.stopRequestedAt||evidence?.state!=='ended'||evidence.reason!=='aborted'||p.runId!==run.id||p.sessionId!==run.sessionId||p.nativeRequestId!==run.nativeRequestId||p.turn!==evidence.turn||p.messageSeq!==evidence.messageSeq||p.endSeq!==evidence.endSeq||p.reason!=='aborted'||p.source!=='native-turn-end'||!hash(p.eventHash)||!hash(p.settlementHash))throw conflict()
 if(![p.turn,p.ownedEndTurn,p.messageSeq,p.endSeq,p.logCut,p.inheritedEventCount].every(natural)||Number(p.ownedEndTurn)<Number(p.turn)||Number(p.endSeq)<=Number(p.messageSeq)||Number(p.logCut)<Number(p.endSeq)||Number(p.messageSeq)<Number(p.inheritedEventCount))throw conflict()
 return p as NativeRunAbortProof
}
function assertResourceCut(settlement:string,proof:NativeRunAbortProof):void{
 const {resourceSettlement}=JSON.parse(settlement) as Settlement
 if(resourceSettlement?.observations.owners.some(owner=>owner.logCut!==proof.logCut))throw conflict()
}
export async function recordNativeRunAbortProof(db:PoolClient,owner:string,run:TaskRun,proof:NativeRunAbortProof):Promise<void>{
 const fixed=readProof(proof,run),settlement=await readNativeRunSettlement(db,owner,run)
 assertSettled(settlement)
 assertResourceCut(settlement,fixed)
 if(hashNativeRunSettlement(settlement)!==fixed.settlementHash)throw conflict()
 const previous=(await db.query('select proof,settlement from teloa_task_run_abort_proofs where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0]
 if(previous){if(JSON.stringify(canonical(readProof(previous.proof,run)))!==JSON.stringify(canonical(fixed))||previous.settlement!==settlement)throw conflict();return}
 await db.query('insert into teloa_task_run_abort_proofs(owner_id,run_id,proof,settlement) values($1,$2,$3,$4)',[owner,run.id,JSON.stringify(fixed),settlement])
}
export async function assertNativeRunAbortProof(db:PoolClient,owner:string,run:TaskRun):Promise<void>{
 const settlement=await readNativeRunSettlement(db,owner,run)
 assertSettled(settlement)
 const stored=(await db.query('select proof,settlement from teloa_task_run_abort_proofs where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0]
 if(!stored||stored.settlement!==settlement)throw conflict()
 const proof=readProof(stored.proof,run)
 assertResourceCut(settlement,proof)
 if(hashNativeRunSettlement(settlement)!==proof.settlementHash)throw conflict()
}
