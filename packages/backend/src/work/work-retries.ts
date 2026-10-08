import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readWorkBudgetPolicy,readGoalContinuationReceipt,readRecoveryCandidate,readGoalRunBinding,type WorkBudgetPolicy} from '@teloa/contract'
import {WorkControlService} from './work-control.ts'
import {WorkLineageService} from './work-lineage.ts'
import {defaultWorkBudgetPolicy} from './work-budget.ts'
import {roleWorkOwner,roleWorkTransaction} from './twin-execution-consents.ts'
import {combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'

export type WorkRetry={operationId:string;attempts:number;maxAttempts:number;nextAttemptAt:string|null;state:'ready'|'backoff'|'owner-wait'|'unknown'|'exhausted';lastReason:string;completed:boolean}
export type ProgressEvidence={runId:string;seq:number;kind:'tool-receipt'|'artifact'|'step-transition'|'wait-condition';referenceId:string}
export type WorkStagnationState={runId:string;goalId:string;lastRound:number;roundsWithoutProgress:number;shouldWait:boolean;reason:string|null;evidence:ProgressEvidence[]}
export type WorkRetryPorts={controls:WorkControlService;authorizeAttempt?:(db:PoolClient,owner:string,input:{runId:string;operationId:string;attempt:number;modelRequestId:string;controlGeneration:number})=>Promise<WorkAccessLease>;/** 读取真实完整原生日志与资源/业务回执；模型文本或自报 kind 不构成证据。 */inspectProgressRound?:(owner:string,input:{runId:string;goalId:string;revision:number;round:number})=>Promise<{completed:boolean;evidence:readonly ProgressEvidence[]}>}
type Failure={operationId:string;attempt:number;receiptId:string;outcome:'success'|'transient'|'authentication'|'permission'|'conflict'|'unknown';reason:string}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=512&&!/[\x00-\x1f]/.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const invalid=()=>new WorkError('teloa/invalid-input','工作重试或进展请求不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','工作重试或进展记录损坏。')
const denied=()=>new WorkError('teloa/forbidden','重试或进展不属于本人的当前工作。')
export const progressEvidenceKey=(e:ProgressEvidence)=>JSON.stringify([e.runId,e.kind,e.referenceId])
function readRetry(row:any):WorkRetry{
 if(!row||!text(row.operation_id)||!Number.isSafeInteger(row.attempts)||row.attempts<0||!positive(row.max_attempts)||row.attempts>row.max_attempts||!['ready','backoff','owner-wait','unknown','exhausted'].includes(row.state)||typeof row.completed!=='boolean'||!text(row.last_reason)||row.next_attempt_at!==null&&!(row.next_attempt_at instanceof Date))throw corrupt()
 return {operationId:row.operation_id,attempts:row.attempts,maxAttempts:row.max_attempts,nextAttemptAt:row.next_attempt_at?.toISOString()??null,state:row.state,lastReason:row.last_reason,completed:row.completed}
}
export function readProgressEvidence(value:unknown):ProgressEvidence[]{
 if(!Array.isArray(value))throw corrupt()
 return value.map(v=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length!==4||Object.keys(v).some(k=>!['runId','seq','kind','referenceId'].includes(k))||!text(v.runId)||!Number.isSafeInteger(v.seq)||v.seq<0||!['tool-receipt','artifact','step-transition','wait-condition'].includes(v.kind)||!text(v.referenceId))throw corrupt();return {...v} as ProgressEvidence})
}

export async function initializeWorkRetries(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_work_retries(
  owner_id text not null,operation_id text not null,run_id uuid not null,budget_account_id uuid not null,attempts integer not null default 0 check(attempts>=0),max_attempts integer not null check(max_attempts>0),
  next_attempt_at timestamptz,state text not null check(state in ('ready','backoff','owner-wait','unknown','exhausted')),last_reason text not null,completed boolean not null default false,created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,operation_id),foreign key(run_id) references teloa_task_runs(id),foreign key(owner_id,budget_account_id) references teloa_work_budget_accounts(owner_id,id),check(attempts<=max_attempts)
 );
 create table if not exists teloa_work_retry_claims(owner_id text not null,request_id uuid not null,operation_id text not null,attempt integer not null,model_request_id text not null,spec jsonb not null,primary key(owner_id,request_id),unique(owner_id,operation_id,attempt),foreign key(owner_id,operation_id) references teloa_work_retries(owner_id,operation_id));
 create table if not exists teloa_work_retry_receipts(owner_id text not null,receipt_id text not null,operation_id text not null,attempt integer not null,spec jsonb not null,result jsonb not null,primary key(owner_id,receipt_id),unique(owner_id,operation_id,attempt),foreign key(owner_id,operation_id) references teloa_work_retries(owner_id,operation_id));
 create table if not exists teloa_work_stagnation(owner_id text not null,run_id uuid not null,goal_id text not null,last_round integer not null,rounds_without_progress integer not null,seen_evidence jsonb not null,primary key(owner_id,run_id,goal_id),foreign key(run_id) references teloa_task_runs(id));
 create table if not exists teloa_work_progress_rounds(owner_id text not null,run_id uuid not null,goal_id text not null,revision integer not null,round integer not null,result jsonb not null,primary key(owner_id,run_id,goal_id,round),foreign key(owner_id,run_id,goal_id) references teloa_work_stagnation(owner_id,run_id,goal_id));
 create table if not exists teloa_work_stagnation_allowances(owner_id text not null,run_id uuid not null,goal_id text not null,request_id uuid not null,control_generation integer not null check(control_generation>0),through_round integer not null check(through_round>0),consumed_round integer,primary key(owner_id,run_id,goal_id,request_id),foreign key(owner_id,run_id,goal_id) references teloa_work_stagnation(owner_id,run_id,goal_id),check(consumed_round is null or consumed_round=through_round+1));
`)}

/** 只装配于真实发布/回执服务；不注册模型或浏览器重试、失败分类、进展写口。 */
export class WorkRetryService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:WorkRetryPorts
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:WorkRetryPorts){this.pool=pool;this.identity=identity;this.ports=ports}
 private now(){const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw corrupt();return now}
 private async facts(db:PoolClient,owner:string,runId:string){
  const run=(await db.query('select task_id,state,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2',[owner,runId])).rows[0];if(!run)throw denied()
  const lineage=await new WorkLineageService(this.pool,this.identity).readInTransaction(db,owner,{taskId:run.task_id});if(!lineage)throw new WorkError('teloa/conflict','历史工作没有可信谱系，不能自动重试。')
  const account=(await db.query('select policy from teloa_work_budget_accounts where owner_id=$1 and id=$2',[owner,lineage.budgetAccountId])).rows[0];if(!account)throw corrupt()
  const policy:WorkBudgetPolicy=account.policy===null?defaultWorkBudgetPolicy:readWorkBudgetPolicy(account.policy)
  return {run,lineage,policy}
 }
 async register(owner:string,value:{runId:string;operationId:string}):Promise<WorkRetry>{
  roleWorkOwner(owner);const a=taskInput(value,['runId','operationId']);if(!uuid(a.runId)||!text(a.operationId))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{const {lineage,policy}=await this.facts(db,owner,a.runId as string);await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-retry',owner,a.operationId])]);const prior=(await db.query('select * from teloa_work_retries where owner_id=$1 and operation_id=$2',[owner,a.operationId])).rows[0];if(prior){if(prior.run_id!==a.runId||prior.budget_account_id!==lineage.budgetAccountId)throw new WorkError('teloa/conflict','原操作身份已绑定另一项工作。');return readRetry(prior)}
   return readRetry((await db.query("insert into teloa_work_retries(owner_id,operation_id,run_id,budget_account_id,max_attempts,state,last_reason,created_at,updated_at) values($1,$2,$3,$4,$5,'ready','等待首次执行',$6,$6) returning *",[owner,a.operationId,a.runId,lineage.budgetAccountId,policy.maxRetries+1,this.now()])).rows[0])})
 }
 async read(owner:string,value:{operationId:string}):Promise<WorkRetry>{roleWorkOwner(owner);const a=taskInput(value,['operationId']);if(!text(a.operationId))throw invalid();const row=(await this.pool.query('select * from teloa_work_retries where owner_id=$1 and operation_id=$2',[owner,a.operationId])).rows[0];if(!row)throw denied();return readRetry(row)}
 async claim(owner:string,value:{operationId:string;requestId:string;expectedGeneration:number}):Promise<{retry:WorkRetry;dispatch:boolean;attempt:number;modelRequestId:string;lease:WorkAccessLease}>{
  roleWorkOwner(owner);const a=taskInput(value,['operationId','requestId','expectedGeneration']);if(!text(a.operationId)||!uuid(a.requestId)||!positive(a.expectedGeneration))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   const row=(await db.query('select * from teloa_work_retries where owner_id=$1 and operation_id=$2 for update',[owner,a.operationId])).rows[0];if(!row)throw denied()
   const retry=readRetry(row),prior=(await db.query('select * from teloa_work_retry_claims where owner_id=$1 and request_id=$2',[owner,a.requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.spec,a))throw new WorkError('teloa/conflict','原重试领取请求已用于其他操作。');return {retry,dispatch:false,attempt:prior.attempt,modelRequestId:prior.model_request_id,lease:{assertCurrent:()=>{throw denied()}}}}
   if(row.completed)return {retry,dispatch:false,attempt:retry.attempts,modelRequestId:'',lease:{assertCurrent:()=>{throw denied()}}}
   if(retry.state==='unknown')throw new WorkError('teloa/execution-pending','原操作结果未知，不能自动重试。')
   if(['owner-wait','exhausted'].includes(retry.state)||retry.attempts>=retry.maxAttempts)throw new WorkError('teloa/conflict','本次操作需要本人处理或已用完有限尝试次数。')
   if(retry.nextAttemptAt!==null&&Date.parse(retry.nextAttemptAt)>Date.parse(this.now()))throw new WorkError('teloa/conflict','尚未到下一次重试时间。')
   const {lineage,policy}=await this.facts(db,owner,row.run_id);if(lineage.budgetAccountId!==row.budget_account_id)throw corrupt()
   if(retry.attempts>=policy.maxRetries+1)throw new WorkError('teloa/conflict','当前本人策略已收窄有限尝试次数。')
   const controlled=await this.ports.controls.acquireForRun(owner,{runId:row.run_id,expectedGeneration:a.expectedGeneration as number,mode:'new-input'},db)
   if(!this.ports.authorizeAttempt)throw new WorkError('teloa/unavailable','真实重试预算准入尚未装配。')
   const attempt=retry.attempts+1,modelRequestId='retry:'+createHash('sha256').update(JSON.stringify([owner,a.operationId,attempt])).digest('hex'),lease=combineWorkAccessLeases([controlled.lease,await this.ports.authorizeAttempt(db,owner,{runId:row.run_id,operationId:row.operation_id,attempt,modelRequestId,controlGeneration:controlled.control.generation})]);lease.assertCurrent()
   const saved=readRetry((await db.query("update teloa_work_retries set attempts=$3,state='unknown',next_attempt_at=null,last_reason='本次操作已领取，等待真实受理回执',updated_at=$4 where owner_id=$1 and operation_id=$2 returning *",[owner,a.operationId,attempt,this.now()])).rows[0])
   await db.query('insert into teloa_work_retry_claims(owner_id,request_id,operation_id,attempt,model_request_id,spec) values($1,$2,$3,$4,$5,$6)',[owner,a.requestId,a.operationId,attempt,modelRequestId,JSON.stringify(a)])
   return {retry:saved,dispatch:true,attempt,modelRequestId,lease}
  })
 }
 async record(owner:string,value:Failure):Promise<WorkRetry>{
  roleWorkOwner(owner);const a=taskInput(value,['operationId','attempt','receiptId','outcome','reason']) as Failure;if(!text(a.operationId)||!positive(a.attempt)||!text(a.receiptId)||!text(a.reason)||!['success','transient','authentication','permission','conflict','unknown'].includes(a.outcome))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   const row=(await db.query('select * from teloa_work_retries where owner_id=$1 and operation_id=$2 for update',[owner,a.operationId])).rows[0];if(!row)throw denied();const retry=readRetry(row)
   const prior=(await db.query('select spec,result from teloa_work_retry_receipts where owner_id=$1 and receipt_id=$2',[owner,a.receiptId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.spec,a))throw new WorkError('teloa/conflict','原真实回执已绑定其他操作结果。');return prior.result as WorkRetry}
   if(row.completed||row.state!=='unknown'||row.attempts!==a.attempt)throw new WorkError('teloa/version-conflict','回执不是当前已领取尝试，旧结果不能改变新重试。')
   const known=(await db.query('select attempt from teloa_work_retry_claims where owner_id=$1 and operation_id=$2 and attempt=$3',[owner,a.operationId,a.attempt])).rows[0];if(!known)throw corrupt()
   const state=a.outcome==='success'?'ready':a.outcome==='unknown'?'unknown':a.outcome==='transient'?(retry.attempts>=retry.maxAttempts?'exhausted':'backoff'):'owner-wait',next=state==='backoff'?new Date(Date.parse(this.now())+Math.min(60_000,500*2**Math.min(a.attempt-1,10))).toISOString():null
   const result=readRetry((await db.query('update teloa_work_retries set state=$3,next_attempt_at=$4,last_reason=$5,completed=$6,updated_at=$7 where owner_id=$1 and operation_id=$2 returning *',[owner,a.operationId,state,next,a.reason,a.outcome==='success',this.now()])).rows[0])
   await db.query('insert into teloa_work_retry_receipts(owner_id,receipt_id,operation_id,attempt,spec,result) values($1,$2,$3,$4,$5,$6)',[owner,a.receiptId,a.operationId,a.attempt,JSON.stringify(a),JSON.stringify(result)]);return result
  })
 }
 async readStagnation(owner:string,value:{runId:string;goalId:string}):Promise<WorkStagnationState>{
  roleWorkOwner(owner);const a=taskInput(value,['runId','goalId']);if(!uuid(a.runId)||!text(a.goalId))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   const {policy}=await this.facts(db,owner,a.runId as string),goal=(await db.query('select goal_id from teloa_task_run_goals where owner_id=$1 and run_id=$2',[owner,a.runId])).rows[0]
   if(!goal||goal.goal_id!==a.goalId)throw denied()
   const row=(await db.query('select * from teloa_work_stagnation where owner_id=$1 and run_id=$2 and goal_id=$3',[owner,a.runId,a.goalId])).rows[0]
   const lastRound=row?.last_round??0,roundsWithoutProgress=row?.rounds_without_progress??0
   if(!Number.isSafeInteger(lastRound)||lastRound<0||!Number.isSafeInteger(roundsWithoutProgress)||roundsWithoutProgress<0||roundsWithoutProgress>lastRound)throw corrupt()
   const shouldWait=roundsWithoutProgress>=policy.stagnationRounds
   return {runId:a.runId as string,goalId:a.goalId as string,lastRound,roundsWithoutProgress,shouldWait,reason:shouldWait?'连续多轮没有新的可信业务进展，等待本人调整目标或资料。':null,evidence:readProgressEvidence(row?.seen_evidence??[])}
  })
 }
 /** 只供本人已批准的恢复协调器装配；不注册模型/浏览器写口。授权事实来自持久 recovery ticket。 */
 async acknowledgeStagnation(owner:string,value:{requestId:string;runId:string;goalId:string;controlGeneration:number}):Promise<void>{
  roleWorkOwner(owner);const a=taskInput(value,['requestId','runId','goalId','controlGeneration']);if(!uuid(a.requestId)||!uuid(a.runId)||!text(a.goalId)||!positive(a.controlGeneration))throw invalid()
  await roleWorkTransaction(this.pool,async db=>{
   const {lineage,policy}=await this.facts(db,owner,a.runId as string),row=(await db.query('select candidate,state from teloa_work_recovery_tickets where owner_id=$1 and request_id=$2 and run_id=$3',[owner,a.requestId,a.runId])).rows[0]
   if(!row||!['applying','applied'].includes(row.state))throw denied()
   const candidate=readRecoveryCandidate(row.candidate),bindingRow=(await db.query('select binding from teloa_task_run_goals where owner_id=$1 and run_id=$2',[owner,a.runId])).rows[0]
   if(!bindingRow||candidate.runId!==a.runId||candidate.goal?.goalId!==a.goalId||readGoalRunBinding(bindingRow.binding).goalId!==a.goalId||![lineage.roundControlId,lineage.definitionControlId].includes(candidate.controlId))throw denied()
   const source=await this.ports.controls.getInTransaction(db,owner,{controlId:candidate.controlId});if(source.state!=='active'||source.generation!==candidate.expectedGeneration)throw denied()
   const current=await this.ports.controls.acquireForRun(owner,{runId:a.runId as string,expectedGeneration:a.controlGeneration as number,mode:'continuation'},db)
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-progress',owner,a.runId,a.goalId])])
   const state=(await db.query('select last_round,rounds_without_progress from teloa_work_stagnation where owner_id=$1 and run_id=$2 and goal_id=$3 for update',[owner,a.runId,a.goalId])).rows[0]
   if(!state||state.rounds_without_progress<policy.stagnationRounds)return
   const prior=(await db.query('select control_generation from teloa_work_stagnation_allowances where owner_id=$1 and run_id=$2 and goal_id=$3 and request_id=$4',[owner,a.runId,a.goalId,a.requestId])).rows[0]
   if(prior){if(prior.control_generation!==a.controlGeneration)throw denied();return}
   current.lease.assertCurrent()
   await db.query('insert into teloa_work_stagnation_allowances(owner_id,run_id,goal_id,request_id,control_generation,through_round) values($1,$2,$3,$4,$5,$6)',[owner,a.runId,a.goalId,a.requestId,a.controlGeneration,state.last_round])
  })
 }
 async consumeStagnationAllowance(owner:string,value:{runId:string;goalId:string;controlGeneration:number;round:number}):Promise<boolean>{
  roleWorkOwner(owner);const a=taskInput(value,['runId','goalId','controlGeneration','round']);if(!uuid(a.runId)||!text(a.goalId)||!positive(a.controlGeneration)||!positive(a.round))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   await this.facts(db,owner,a.runId as string);const controlled=await this.ports.controls.acquireForRun(owner,{runId:a.runId as string,expectedGeneration:a.controlGeneration as number,mode:'new-input'},db)
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-progress',owner,a.runId,a.goalId])])
   const state=(await db.query('select last_round from teloa_work_stagnation where owner_id=$1 and run_id=$2 and goal_id=$3',[owner,a.runId,a.goalId])).rows[0];if(!state||state.last_round+1!==a.round)return false
   const row=(await db.query('select request_id,consumed_round from teloa_work_stagnation_allowances where owner_id=$1 and run_id=$2 and goal_id=$3 and control_generation=$4 and through_round=$5 for update',[owner,a.runId,a.goalId,a.controlGeneration,state.last_round])).rows[0]
   if(!row||row.consumed_round!==null&&row.consumed_round!==a.round)return false
   controlled.lease.assertCurrent()
   if(row.consumed_round===null)await db.query('update teloa_work_stagnation_allowances set consumed_round=$5 where owner_id=$1 and run_id=$2 and goal_id=$3 and request_id=$4',[owner,a.runId,a.goalId,row.request_id,a.round])
   return true
  })
 }
 async recordProgressRound(owner:string,value:{runId:string;goalId:string;revision:number;round:number}):Promise<WorkStagnationState>{
  roleWorkOwner(owner);const a=taskInput(value,['runId','goalId','revision','round']);if(!uuid(a.runId)||!text(a.goalId)||!positive(a.revision)||!positive(a.round))throw invalid()
  if(!this.ports.inspectProgressRound)throw new WorkError('teloa/unavailable','真实工作进展检查器尚未装配。')
  const observed=await this.ports.inspectProgressRound(owner,a as {runId:string;goalId:string;revision:number;round:number});if(!observed?.completed)throw new WorkError('teloa/execution-pending','本轮尚无可信原生完成证据。')
  const current=readProgressEvidence(observed.evidence)
  return roleWorkTransaction(this.pool,async db=>{
   const {policy,lineage}=await this.facts(db,owner,a.runId as string),row=(await db.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 and goal_id=$3 and revision=$4 and round=$5',[owner,a.runId,a.goalId,a.revision,a.round])).rows[0]
   if(!row)throw denied();const receipt=readGoalContinuationReceipt(row.receipt);if(receipt.state!=='accepted'||receipt.ownerId!==owner||receipt.runId!==a.runId||receipt.goalId!==a.goalId||receipt.revision!==a.revision||receipt.round!==a.round)throw denied()
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-progress',owner,a.runId,a.goalId])])
   const prior=(await db.query('select revision,result from teloa_work_progress_rounds where owner_id=$1 and run_id=$2 and goal_id=$3 and round=$4',[owner,a.runId,a.goalId,a.round])).rows[0]
   if(prior){if(prior.revision!==a.revision)throw new WorkError('teloa/conflict','同一 Goal 本轮已有另一版本进展记录。');return prior.result as WorkStagnationState}
   const state=(await db.query('select * from teloa_work_stagnation where owner_id=$1 and run_id=$2 and goal_id=$3 for update',[owner,a.runId,a.goalId])).rows[0]
   if((state?.last_round??0)+1!==a.round)throw new WorkError('teloa/version-conflict','工作进展必须按真实 Goal 轮次顺序登记。')
   const previous=readProgressEvidence(state?.seen_evidence??[]),seen=new Set(previous.map(progressEvidenceKey)),added=current.filter(e=>!seen.has(progressEvidenceKey(e))),merged=[...previous]
   for(const sourceRunId of new Set([...previous,...current].map(e=>e.runId))){if(sourceRunId===a.runId)continue;if(!uuid(sourceRunId))throw denied();const child=await this.facts(db,owner,sourceRunId);if(child.lineage.roundControlId!==lineage.roundControlId||child.lineage.budgetAccountId!==lineage.budgetAccountId)throw denied()}
   for(const e of added)if(!seen.has(progressEvidenceKey(e))){seen.add(progressEvidenceKey(e));merged.push(e)}
   const roundsWithoutProgress=added.length?0:(state?.rounds_without_progress??0)+1,shouldWait=roundsWithoutProgress>=policy.stagnationRounds,result:WorkStagnationState={runId:a.runId,goalId:a.goalId as string,lastRound:a.round,roundsWithoutProgress,shouldWait,reason:shouldWait?'连续多轮没有新的可信业务进展，等待本人调整目标或资料。':null,evidence:merged}
   await db.query('insert into teloa_work_stagnation(owner_id,run_id,goal_id,last_round,rounds_without_progress,seen_evidence) values($1,$2,$3,$4,$5,$6) on conflict(owner_id,run_id,goal_id) do update set last_round=excluded.last_round,rounds_without_progress=excluded.rounds_without_progress,seen_evidence=excluded.seen_evidence',[owner,a.runId,a.goalId,a.round,roundsWithoutProgress,JSON.stringify(merged)])
   await db.query('insert into teloa_work_progress_rounds(owner_id,run_id,goal_id,revision,round,result) values($1,$2,$3,$4,$5,$6)',[owner,a.runId,a.goalId,a.revision,a.round,JSON.stringify(result)]);return result
  })
 }
}
