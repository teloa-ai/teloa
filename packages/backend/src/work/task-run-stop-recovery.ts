import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput} from '@teloa/contract'
import type {TaskRun,TaskRunService} from './task-runs.ts'
import {TaskRunRuntimeLinkService} from './task-run-runtime-links.ts'
import {combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'
import {roleWorkOwner,roleWorkUuid,type OwnerWorkAuthority} from './twin-execution-consents.ts'
import {readStoredTask} from './tasks.ts'
import {readGroupTaskSource} from './group-tasks.ts'

/** 只由维护装配提供；客户端不能提交宿主退出事实或原生日志。 */
export type StoppedUnacceptedNativeProof={schema:'teloa.stopped-unaccepted-native/v1';mode:'official-session-initial-inbox-no-commands';runId:string;sessionId:string;nativeRequestId:string;agentPresetId:string;logCut:number;logSha256:string}
export type StoppedTaskRunRecoveryPorts={
 ownerAuthority:OwnerWorkAuthority
 acquireHostStopped:(run:Readonly<TaskRun>,signal:AbortSignal)=>Promise<WorkAccessLease>
 inspectNative:(run:Readonly<TaskRun>,signal:AbortSignal)=>Promise<StoppedUnacceptedNativeProof>
}
export type StoppedTaskRunRecoveryReceipt={schema:'teloa.stopped-unaccepted-recovery/v1';requestId:string;runId:string;sessionId:string;nativeRequestId:string;beforeSha256:string;factsSha256:string;native:StoppedUnacceptedNativeProof;task:{taskId:string;changed:boolean;before:{state:string;version:number};after:{state:string;version:number}};withdrawnAt:string}
const denied=()=>new WorkError('teloa/conflict','尚未证实本次已停止的提交从未准入，请保留原记录并核对。')
const invalid=()=>new WorkError('teloa/invalid-input','停止恢复只接受固定请求和执行身份。')
const canonical=(v:unknown):unknown=>v instanceof Date?v.toISOString():Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b)).map(([k,x])=>[k,canonical(x)])):v
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
function proof(value:unknown,run:TaskRun):StoppedUnacceptedNativeProof{
 const p=taskInput(value,['schema','mode','runId','sessionId','nativeRequestId','agentPresetId','logCut','logSha256'])
 if(Object.keys(p).length!==8||p.schema!=='teloa.stopped-unaccepted-native/v1'||p.mode!=='official-session-initial-inbox-no-commands'||p.runId!==run.id||p.sessionId!==run.sessionId||p.nativeRequestId!==run.nativeRequestId||!run.agentPresetId||p.agentPresetId!==run.agentPresetId||!Number.isSafeInteger(p.logCut)||Number(p.logCut)<-1||Number(p.logCut)>15||!sha(p.logSha256))throw denied()
 return {...p} as StoppedUnacceptedNativeProof
}
function assertCandidate(run:TaskRun):void{
 if(run.state!=='submitting'||run.evidence!==null||!run.stopRequestedAt||!run.roleSnapshot||!run.lineage||run.flowId!==undefined)throw denied()
}
export async function initializeTaskRunStopRecovery(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_task_run_stop_recoveries(
  owner_id text not null,request_id uuid not null,run_id uuid not null,receipt jsonb not null check(jsonb_typeof(receipt)='object'),
  created_at timestamptz not null,
  primary key(owner_id,request_id),unique(owner_id,run_id),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
}
/** 独立维护服务；没有默认 RPC，也不改变提交未知的常规 reconcile/stop 判据。 */
export class StoppedUnacceptedTaskRunService{
 readonly pool:Pool;readonly runs:Pick<TaskRunService,'get'|'readVerifiedInTransaction'>;readonly identity:{now:()=>string};readonly ports:StoppedTaskRunRecoveryPorts
 constructor(pool:Pool,runs:Pick<TaskRunService,'get'|'readVerifiedInTransaction'>,identity:{now:()=>string},ports:StoppedTaskRunRecoveryPorts){this.pool=pool;this.runs=runs;this.identity=identity;this.ports=ports}
 /** 仅本人新消息建立的独立群轮；不把接力、已有成果或后续输入解释为未准入。 */
 private async groupFacts(db:PoolClient,owner:string,run:TaskRun,task:Record<string,unknown>):Promise<unknown>{
  const context=run.groupContext,lineage=run.lineage
  if(!context)return null
  if(!lineage||lineage.parentRunId!==null||lineage.rootTaskId!==run.taskId||lineage.definitionControlId!==null||lineage.definition!==null)throw denied()
  const sources=(await db.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,run.taskId])).rows
  if(sources.length!==1)throw denied()
  const source=readGroupTaskSource(sources[0]),stored=(await db.query('select request_id,group_publication from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.id])).rows[0]
  if(source.schema!=='teloa.group-task-source/v2'||source.trigger!=='routed'||source.executionMode!=='work'||source.groupId!==context.groupId||source.groupVersion!==context.groupVersion||source.createdAssignee?.roleId!==run.roleId||source.createdAssignee.roleVersion!==run.roleVersion||sources[0].request_id!==stored?.request_id||task.request_id!==stored.request_id||stored.group_publication!==null||readStoredTask(task).groupId!==context.groupId||!isDeepStrictEqual(context.source,{messageId:source.messageId,rootId:source.rootId,createdAt:source.messageCreatedAt,text:source.messageText}))throw denied()
  const message=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 for share',[owner,context.groupId,source.messageId])).rows[0]
  if(!message||message.author_id!=='self'||message.task_id!==null||message.run_id!==null||message.text!==source.messageText||!(message.created_at instanceof Date)||message.created_at.toISOString()!==source.messageCreatedAt||(message.root_id??message.id)!==source.rootId||(message.root_id===null?'main':'thread')!==source.contextMode||(message.reply_to_message_id??null)!==source.replyToMessageId||!isDeepStrictEqual(message.reference_snapshot,source.references))throw denied()
  const round=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,lineage.roundControlId])).rows[0]
  const progress=(await db.query('select * from teloa_work_control_progress where owner_id=$1 and control_id=$2 for share',[owner,lineage.roundControlId])).rows[0]
  if(!round||round.kind!=='round'||round.root_task_id!==run.taskId||round.budget_account_id!==lineage.budgetAccountId||round.state!=='ended'||!Number.isSafeInteger(round.generation)||round.generation<=lineage.controlGeneration||!progress||progress.generation!==round.generation||!Array.isArray(progress.pending_run_ids)||progress.pending_run_ids.length||!Array.isArray(progress.unknown_operation_ids)||progress.unknown_operation_ids.length)throw denied()
  const dispatches=(await db.query('select * from teloa_group_routing_outbox where owner_id=$1 and task_id=$2 for share',[owner,run.taskId])).rows,dispatch=dispatches[0]
  if(dispatches.length!==1||dispatch.run_id!==run.id||dispatch.group_id!==context.groupId||dispatch.message_id!==source.messageId||dispatch.request_id!==stored.request_id||dispatch.role_id!==run.roleId||dispatch.role_version!==run.roleVersion||dispatch.group_version!==context.groupVersion||dispatch.decision_version!==source.routingAttemptVersion||dispatch.execution_mode!=='work'||dispatch.stage!==1||dispatch.handoff_message_id!==null||dispatch.handoff_message_ids!==null||!['unknown','submitted','settled','blocked'].includes(dispatch.state)||!isDeepStrictEqual(dispatch.lineage,lineage))throw denied()
  // 已有群回帖、发布或本人续办都不属于本维护口；不自动 ACK/settle 原派工。
  const results=(await db.query('select id from teloa_group_messages where owner_id=$1 and (task_id=$2 or run_id=$3)',[owner,run.taskId,run.id])).rows
  const inputs=(await db.query('select * from teloa_group_work_inputs where owner_id=$1 and task_id=$2',[owner,run.taskId])).rows
  if(results.length||inputs.length)throw denied()
  return {source:sources[0],message,round,progress,dispatch,results,inputs}
 }
 private async facts(db:PoolClient,owner:string,run:TaskRun):Promise<string>{
  const rows=await new TaskRunRuntimeLinkService(this.pool).listInTransaction(db,owner,{runId:run.id}),row=rows[0]
  if(rows.length!==1||row?.kind!=='job'||row.payload.record!=='owner'||row.runId!==run.id||row.sessionId!==run.sessionId||row.payload.requestId!==run.nativeRequestId||row.nativeId!=='owner:'+row.payload.runtimeId+':'+run.sessionId)throw denied()
  // 当前宿主已退出，所有实际外部身份都必须为空；已完成 job/child 也不能当作未准入。
  const facts:Record<string,unknown>={owner:row}
  for(const table of ['teloa_task_run_subagents','teloa_task_run_web_access','teloa_task_run_flows','teloa_task_run_goals','teloa_task_run_goal_revisions','teloa_task_run_goal_continuations']){
   const records=(await db.query(`select * from ${table} where owner_id=$1 and run_id=$2`,[owner,run.id])).rows
   if(records.length)throw denied();facts[table]=records
  }
  const actions=(await db.query('select * from teloa_security_actions where owner_id=$1 and task_id=$2',[owner,run.taskId])).rows
  const executions=(await db.query('select e.* from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where a.owner_id=$1 and a.task_id=$2',[owner,run.taskId])).rows
  const plugins=(await db.query("select * from teloa_plugin_installations where owner_id=$1 and state in ('preparing','unknown') order by id",[owner])).rows
  if(actions.length||executions.length||plugins.length)throw denied()
  const task=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,run.taskId])).rows[0]
  if(!task)throw denied()
  return digest({...facts,actions,executions,plugins,task,group:await this.groupFacts(db,owner,run,task)})
 }
 async withdraw(owner:string,input:unknown,signal:AbortSignal):Promise<{run:TaskRun;receipt:StoppedTaskRunRecoveryReceipt}>{
  roleWorkOwner(owner);const command=taskInput(input,['requestId','runId'])
  if(Object.keys(command).length!==2||!roleWorkUuid(command.requestId)||!roleWorkUuid(command.runId))throw invalid()
  const requestId=command.requestId.toLowerCase(),runId=command.runId.toLowerCase();signal.throwIfAborted()
  const before=await this.runs.get(owner,{runId})
  // 停止证明是实际宿主身份租约；stopped:true、空活动读数或调用方声称都不能代替。
  const ownerLease=await this.ports.ownerAuthority.authorize(owner,Object.freeze({requestId,roleId:before.roleId??before.taskId,operation:'confirm'})),hostLease=await this.ports.acquireHostStopped(Object.freeze(structuredClone(before)),signal)
  if(typeof ownerLease?.assertCurrent!=='function'||typeof hostLease?.assertCurrent!=='function')throw new WorkError('teloa/forbidden','本人或宿主停止许可未完成核对。')
  // 取消既有工作不授予新执行权限，也不因新的高级工作权益不足被锁住。
  const lease=combineWorkAccessLeases([ownerLease,hostLease])
  signal.throwIfAborted();lease.assertCurrent()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/stopped-task-run-recovery',owner,requestId])])
   const currentRole=(await db.query('select version,state from teloa_roles where owner_id=$1 and id=$2 for share',[owner,before.roleId])).rows[0]
   await db.query('select id from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,before.taskId])
   await db.query('select id from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,runId])
   const run=await this.runs.readVerifiedInTransaction(db,owner,runId)
   if(!isDeepStrictEqual(run,before))throw denied()
   const currentRow=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,runId])).rows[0]
   const previous=(await db.query('select * from teloa_task_run_stop_recoveries where owner_id=$1 and (request_id=$2 or run_id=$3)',[owner,requestId,runId])).rows
   if(previous.length){
    const record=previous[0],receipt=record?.receipt as StoppedTaskRunRecoveryReceipt|undefined
    if(previous.length!==1||record.request_id!==requestId||record.run_id!==runId||run.state!=='withdrawn'||run.evidence!==null||!run.stopRequestedAt||!receipt||receipt.schema!=='teloa.stopped-unaccepted-recovery/v1'||receipt.requestId!==requestId||receipt.runId!==runId||receipt.sessionId!==run.sessionId||receipt.nativeRequestId!==run.nativeRequestId||!sha(receipt.factsSha256)||receipt.beforeSha256!==digest({...currentRow,state:'submitting'}))throw denied()
    proof(receipt.native,run)
    signal.throwIfAborted();lease.assertCurrent();await db.query('commit');return {run,receipt}
   }
   assertCandidate(run)
   const firstFacts=await this.facts(db,owner,run),native=proof(await this.ports.inspectNative(run,signal),run)
   signal.throwIfAborted();lease.assertCurrent()
   const afterNative=proof(await this.ports.inspectNative(run,signal),run),afterFacts=await this.facts(db,owner,run)
   if(!isDeepStrictEqual(native,afterNative)||firstFacts!==afterFacts)throw denied()
   const latest=await this.runs.readVerifiedInTransaction(db,owner,runId)
   if(!isDeepStrictEqual(latest,run))throw denied()
   signal.throwIfAborted();lease.assertCurrent()
   const withdrawnAt=this.identity.now(),taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,run.taskId])).rows[0],task=readStoredTask(taskRow)
   const taskChange:StoppedTaskRunRecoveryReceipt['task']={taskId:task.id,changed:false,before:{state:task.state,version:task.version},after:{state:task.state,version:task.version}}
   const pause=run.groupContext&&run.roleVersion!==null&&currentRole?.state==='paused'&&currentRole.version===run.roleVersion+1?(await db.query('select request_spec from teloa_role_transitions where role_id=$1 and base_version=$2 for share',[run.roleId,run.roleVersion])).rows[0]?.request_spec:undefined
   const originalRolePaused=pause?.action==='pause'&&typeof pause.reason==='string'&&!!pause.reason.trim()&&Object.keys(pause).length===2
   if(task.state==='running'&&task.version===currentRow.task_state_version&&task.assigneeRoleId===run.roleId&&task.assigneeRoleVersion===run.roleVersion&&(currentRole?.version===run.roleVersion||originalRolePaused)){
    const active=(await db.query("select id from teloa_task_runs where owner_id=$1 and task_id=$2 and state in ('prepared','submitting','accepted','active')",[owner,run.taskId])).rows
    if(active.length===1&&active[0].id===run.id){
     await db.query("update teloa_tasks set state='paused',version=version+1,updated_at=$3 where owner_id=$1 and id=$2",[owner,task.id,withdrawnAt])
     taskChange.changed=true;taskChange.after={state:'paused',version:task.version+1}
    }
   }
   const receipt:StoppedTaskRunRecoveryReceipt={schema:'teloa.stopped-unaccepted-recovery/v1',requestId,runId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,beforeSha256:digest(currentRow),factsSha256:firstFacts,native,task:taskChange,withdrawnAt}
   const updated=await db.query("update teloa_task_runs set state='withdrawn' where owner_id=$1 and id=$2 and state='submitting' and evidence is null and stop_requested_at is not null",[owner,runId])
   if(updated.rowCount!==1)throw denied()
   await db.query('insert into teloa_task_run_stop_recoveries(owner_id,request_id,run_id,receipt,created_at) values($1,$2,$3,$4,$5)',[owner,requestId,runId,JSON.stringify(receipt),withdrawnAt])
   const result=await this.runs.readVerifiedInTransaction(db,owner,runId)
   signal.throwIfAborted();lease.assertCurrent();await db.query('commit');return {run:result,receipt}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
