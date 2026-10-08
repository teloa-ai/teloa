import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readCompletionCandidate,readTaskCompletionPolicy,type CompletionCandidate,type TaskCompletionPolicy,type WorkTask,type WorkLineage} from '@teloa/contract'
import type {TaskRun} from './task-runs.ts'
import {readStoredTask} from './tasks.ts'
import {TaskTransitions} from './task-transitions.ts'

export type CompletionVerifierInput={ownerId:string;task:WorkTask;run:TaskRun;policy:Extract<TaskCompletionPolicy,{kind:'verified'}>;candidate:CompletionCandidate;lineage:WorkLineage;db:PoolClient}
export type CompletionVerification={verified:boolean;reason:string|null;receiptIds:string[];artifact?:{id:string;version:number}}
export type CompletionVerifier=(input:CompletionVerifierInput)=>Promise<CompletionVerification>
export type TaskCompletionPorts={
 readRun:(db:PoolClient,owner:string,runId:string)=>Promise<TaskRun>
 readLineage:(db:PoolClient,owner:string,taskId:string)=>Promise<WorkLineage|null>
 /** Goal、孩子、审批、工具与未知副作用来自实际宿主；缺席或无法确定不结项。 */
 settlement?:(db:PoolClient,owner:string,run:TaskRun)=>Promise<{verified:boolean;reason:string|null}>
 verifiers:Partial<Record<Extract<TaskCompletionPolicy,{kind:'verified'}>['verifier'],CompletionVerifier>>
}
export type TaskCompletionInput={requestId:string;taskId:string;expectedVersion:number;candidate:CompletionCandidate}
export type TaskCompletionResult={task:WorkTask;applied:boolean;reason:string|null}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','本轮结项请求格式不正确。')

/** 只在既有结项事务内补齐可信证明，回执仍唯一写在 task_transitions/task_completions。 */
export class TaskCompletionService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:TaskCompletionPorts
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:TaskCompletionPorts){this.pool=pool;this.identity=identity;this.ports=ports}
 async complete(owner:string,input:TaskCompletionInput):Promise<TaskCompletionResult>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')
  const row=taskInput(input,['requestId','taskId','expectedVersion','candidate']),candidate=readCompletionCandidate(row.candidate)
  if(!uuid(row.requestId)||!uuid(row.taskId)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1)throw invalid()
  const db=await this.pool.connect(),transitions=new TaskTransitions(this.pool,this.identity)
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-transition',owner,row.requestId])])
   const observed=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,row.taskId])).rows[0]
   if(!observed)throw new WorkError('teloa/forbidden','任务不属于本人。')
   const prior=(await db.query('select * from teloa_task_transitions where owner_id=$1 and request_id=$2',[owner,row.requestId])).rows[0]
   // 未知回包恢复先消费原事务回执，不拿当前委托或成果重新授予结项。
   if(prior){
    const spec=taskInput(prior.request_spec,['taskId','requestId','expectedVersion','action','artifact','note','verifiedCompletion']),proof=spec.verifiedCompletion as {candidate?:unknown;policy?:unknown;receiptIds?:string[]}|undefined
    if(prior.task_id!==row.taskId||spec.taskId!==row.taskId||spec.requestId!==row.requestId||spec.expectedVersion!==row.expectedVersion||spec.action!=='complete'||!proof||!isDeepStrictEqual(proof.candidate,candidate))throw new WorkError('teloa/conflict','原请求已经记录其他结项或证据。')
    const {verifiedCompletion:_,...command}=spec
    const saved=await transitions.changeInTransaction(db,owner,command,proof as {candidate:unknown;policy:unknown;receiptIds:string[]});await db.query('commit');return {task:saved,applied:false,reason:null}
   }
   // 与执行/配置保持 role → task 顺序；完成事务的日志读取也会锁该角色。
   if(observed.assignee_role_id)await db.query('select id from teloa_roles where owner_id=$1 and id=$2 for share',[owner,observed.assignee_role_id])
   const stored=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,row.taskId])).rows[0]
   if(!stored||stored.assignee_role_id!==observed.assignee_role_id)throw new WorkError('teloa/version-conflict','任务负责人已变化，请重新核对。')
   const task=readStoredTask(stored)
   const reject=async(reason:string):Promise<TaskCompletionResult>=>{await db.query('rollback');return {task,applied:false,reason}}
   const policy=readTaskCompletionPolicy(task.completionPolicy)
   if(policy.kind==='manual')return await reject('manual-review')
   if(task.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，请重新核对。')
   if(policy.verifierVersion!==1||policy.authorizationVersion!==1||!this.ports.verifiers[policy.verifier])return await reject('verifier-unavailable')
   if(task.state!=='waiting'||!task.assigneeRoleId)return await reject('run-not-complete')
   const run=await this.ports.readRun(db,owner,candidate.runId)
   if(run.taskId!==task.id||run.roleId!==task.assigneeRoleId||run.roleVersion!==task.assigneeRoleVersion||run.state!=='ended'||run.evidence?.state!=='ended'||run.evidence.reason!=='completed'||run.evidence.endSeq!==candidate.terminalEventSeq)return await reject('run-not-complete')
   const fixed=(await db.query('select task_state_version from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,run.id])).rows[0]
   if(fixed?.task_state_version!==task.version-1)return await reject('run-not-current')
   const active=(await db.query("select 1 from teloa_task_runs where owner_id=$1 and task_id=$2 and state not in ('ended','withdrawn','configuration_failed') limit 1 for share",[owner,task.id])).rows
   if(active.length)return await reject('work-unsettled')
   const children=(await db.query("select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and state in ('reserved','started') limit 1 for share",[owner,run.id])).rows
   if(children.length)return await reject('children-unsettled')
   const lineage=await this.ports.readLineage(db,owner,task.id)
   if(!lineage||lineage.ownerId!==owner||!run.lineage||!isDeepStrictEqual(lineage,run.lineage))return await reject('lineage-unverified')
   if(!this.ports.settlement)return await reject('settlement-unavailable')
   const settlement=await this.ports.settlement(db,owner,run)
   if(!settlement.verified)return await reject(settlement.reason??'work-unsettled')
   const result=await this.ports.verifiers[policy.verifier]!({ownerId:owner,task,run,policy,candidate,lineage,db})
   if(!result.verified||!result.artifact||!uuid(result.artifact.id)||!Number.isSafeInteger(result.artifact.version)||result.artifact.version<1||!Array.isArray(result.receiptIds)||result.receiptIds.length===0||result.receiptIds.some(id=>!uuid(id)))return await reject(result.reason??'delivery-unverified')
   const proof={candidate,policy,receiptIds:result.receiptIds}
   const saved=await transitions.changeInTransaction(db,owner,{taskId:task.id,requestId:row.requestId,expectedVersion:task.version,action:'complete',artifact:result.artifact,note:`可信本轮结项 · ${policy.verifier} v${policy.verifierVersion}`},proof)
   await db.query('commit');return {task:saved,applied:true,reason:null}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
