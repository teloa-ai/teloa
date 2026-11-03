import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,businessObjectReference,readTaskRunSourceFollowup,readTaskRunSourceFollowupCandidate,readTaskRunSubmissionDisposition,runEvidence,type TaskRunSourceFollowup,type TaskRunSourceFollowupCandidate} from '@teloa/contract'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import {businessTaskSourceUpdateRunRequestId} from './business-task-source-updates.ts'
import {readStoredTaskRun,type TaskRun} from './task-runs.ts'
import {readUnpublishedCancellationSettled,readUnpublishedCancellationHistory,terminalSourceFollowupBudgetSQL} from './task-run-submission.ts'

const evidenceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex')
const denied=()=>new WorkError('teloa/conflict','原未知提交、告警来源或本次确认已变化，请回到原任务核对。')
/** 只由同事务持久票据核验创建；不属于 TaskRun/RPC JSON，模型或调用者不能自行上传。 */
export type SourceFollowupUnpublishedProof=Readonly<{sha256:string;receipt:Readonly<{schema:'teloa.task-run-unpublished-cancellation/v1';requestId:string;identity:Readonly<{runId:string;sessionId:string;nativeRequestId:string;inputSha256:string}>;runtimeId:string;attemptIds:readonly string[];latestAttemptId:string;logCut:number;logSha256:string;stopRequestedAt:string;cancelledAt:string}>}>
const unpublishedProofs=new WeakMap<TaskRun,SourceFollowupUnpublishedProof>()
const stoppedProofs=new WeakMap<TaskRun,Readonly<{stopRequestedAt:string;evidenceSha256:string;identitySha256:string}>>()
const stoppedIdentity=(run:TaskRun)=>evidenceHash({id:run.id,taskId:run.taskId,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,roleId:run.roleId,roleVersion:run.roleVersion,agentPresetId:run.agentPresetId,inputText:run.inputText})
const grantStopped=(run:TaskRun,stopRequestedAt:string,evidenceSha256:string)=>stoppedProofs.set(run,Object.freeze({stopRequestedAt,evidenceSha256,identitySha256:stoppedIdentity(run)}))
/** 只由可信候选/持久确认核验授予；JSON字段或停止标记本身不能授权恢复。 */
export const sourceFollowupStoppedProof=(run:TaskRun)=>{const proof=stoppedProofs.get(run);return proof&&run.state==='ended'&&run.evidence?.state==='ended'&&run.evidence.reason==='error'&&run.stopRequestedAt===proof.stopRequestedAt&&evidenceHash(run.evidence)===proof.evidenceSha256&&stoppedIdentity(run)===proof.identitySha256?proof:undefined}
const recoveryKind=(kind:string)=>kind==='error-recovery'||kind==='stopped-continuation'
const stopTime=(value:unknown)=>value instanceof Date?value.toISOString():value

/** 同事务的本人单次续办证明；不落库、不接受 RPC 上传，不改变计划开关。 */
export type SourceFollowupPlanAdmission=Readonly<{kind:'owner-source-followup'}>
type PlanAdmissionBinding={db:PoolClient;owner:string;run:TaskRun;identity:string;occurrenceId:string}
const planAdmissions=new WeakMap<SourceFollowupPlanAdmission,PlanAdmissionBinding>()
const runPlanAdmissions=new WeakMap<TaskRun,SourceFollowupPlanAdmission>()
const planAdmissionIdentity=(run:TaskRun)=>evidenceHash({identity:stoppedIdentity(run),state:run.state,evidence:run.evidence,stop:run.stopRequestedAt,following:run.sourceFollowup})
function revokePlanAdmission(run:TaskRun){
 const previous=runPlanAdmissions.get(run)
 if(previous)planAdmissions.delete(previous)
 runPlanAdmissions.delete(run)
}
function grantPlanAdmission(db:PoolClient,owner:string,run:TaskRun){
 revokePlanAdmission(run)
 const occurrenceId=JSON.parse(run.inputText).planContext?.occurrenceId
 if(typeof occurrenceId!=='string')return
 const proof=Object.freeze({kind:'owner-source-followup' as const})
 planAdmissions.set(proof,{db,owner,run,identity:planAdmissionIdentity(run),occurrenceId});runPlanAdmissions.set(run,proof)
}
export function sourceFollowupPlanAdmission(run:TaskRun):SourceFollowupPlanAdmission|undefined{
 const proof=runPlanAdmissions.get(run),binding=proof&&planAdmissions.get(proof)
 return binding&&binding.identity===planAdmissionIdentity(run)?proof:undefined
}
export function assertSourceFollowupPlanAdmission(proof:SourceFollowupPlanAdmission,db:PoolClient,owner:string,taskId:string,occurrenceId:string,roleId:string|null,roleVersion:number|null):void{
 const binding=planAdmissions.get(proof)
 if(!binding||binding.db!==db||binding.owner!==owner||binding.run.taskId!==taskId||binding.occurrenceId!==occurrenceId||binding.run.roleId!==roleId||binding.run.roleVersion!==roleVersion||binding.identity!==planAdmissionIdentity(binding.run))throw denied()
}

export const sourceFollowupUnpublishedProof=(run:TaskRun):SourceFollowupUnpublishedProof|undefined=>unpublishedProofs.get(run)
function unpublishedProof(receipt:SourceFollowupUnpublishedProof['receipt']):SourceFollowupUnpublishedProof{
 const copy=structuredClone(receipt)
 Object.freeze(copy.identity);Object.freeze(copy.attemptIds);Object.freeze(copy)
 return Object.freeze({sha256:evidenceHash({domain:'teloa.source-followup-unpublished-cancellation/v1',receipt:copy}),receipt:copy})
}
/** 暂停冷读的历史资格；复用完整取消验证（含正常维护审计），不授予计划准入或新发送。 */
export async function readSourceFollowupUnpublishedHistory(db:PoolClient,owner:string,run:TaskRun):Promise<SourceFollowupUnpublishedProof|undefined>{
 unpublishedProofs.delete(run)
 const saved=(await db.query('select receipt from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows[0]
 // 旧prepared直接withdraw的布尔静止资格不等于有原生prefix；不能据此编造取消回执。
 if(!saved||!await readUnpublishedCancellationHistory(db,owner,run))return undefined
 const proof=unpublishedProof(saved.receipt)
 unpublishedProofs.set(run,proof)
 return proof
}
/** 暂停只可保留本会话已有权威终态的未知费用；不结算金额，也不授予新发送。 */
export async function readSourceFollowupQuiescentBudgets(db:PoolClient,owner:string,history:readonly TaskRun[]):Promise<boolean>{
 const original=history[0];if(!original)return false
 const ids=history.map(run=>run.id),accounts=[...new Set(history.flatMap(run=>run.lineage?[run.lineage.budgetAccountId]:[]))]
 for(const account of accounts){
  const pending=await db.query(`select 1 from teloa_work_budget_reservations b where b.owner_id=$1 and b.budget_account_id=$2 and b.state in ('reserved','unknown') and not exists(
   select 1 from teloa_work_retry_claims c join teloa_work_retries r on r.owner_id=c.owner_id and r.operation_id=c.operation_id
   join teloa_task_runs n on n.owner_id=r.owner_id and n.id=r.run_id
   where c.owner_id=b.owner_id and c.model_request_id=b.model_request_id and r.budget_account_id=b.budget_account_id
    and n.id=any($3::uuid[]) and n.task_id=$4 and n.session_id=$5
    and n.role_id is not distinct from $6::uuid and n.role_version is not distinct from $7::integer
    and (${terminalSourceFollowupBudgetSQL})
  ) limit 1`,[owner,account,ids,original.taskId,original.sessionId,original.roleId,original.roleVersion])
  if(pending.rowCount)return false
 }
 return true
}
async function verifyUnpublished(db:PoolClient,owner:string,run:TaskRun,following?:TaskRunSourceFollowup,budgetMode:'history'|'dispatch'='history'):Promise<SourceFollowupUnpublishedProof>{
 const saved=(await db.query('select request_id,receipt,audit from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows[0]
 if(!saved||saved.audit!==null||saved.receipt?.schema!=='teloa.task-run-unpublished-cancellation/v1'||!await(budgetMode==='history'?readUnpublishedCancellationHistory(db,owner,run):readUnpublishedCancellationSettled(db,owner,run,run,following,budgetMode)))throw denied()
 // 与原生 ended evidence 明确分域，不能拿取消回执冒充原执行 error。
 return unpublishedProof(saved.receipt)
}
function sourceUpdateEligible(u:Record<string,unknown>,unknown:boolean,unpublished:boolean):boolean{
 return unknown?u.state==='needs-user'&&u.reason==='teloa/submission-unknown':unpublished?u.state==='needs-user'&&u.reason==='teloa/run-not-accepted':u.state==='accepted'
}
async function assertBoundaries(db:PoolClient,owner:string,run:Pick<TaskRun,'id'|'taskId'|'sessionId'|'nativeRequestId'|'submissionDisposition'>):Promise<void>{
 const d=run.submissionDisposition
 const links=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows
 if(d&&(links.length!==1||links[0].kind!=='job'||links[0].payload?.record!=='owner'||links[0].session_id!==run.sessionId||links[0].payload.runtimeId!==d.runtimeId||links[0].payload.requestId!==run.nativeRequestId||links[0].native_id!=='owner:'+d.runtimeId+':'+run.sessionId))throw denied()
 if(!d&&links.some(row=>row.kind==='job'&&row.payload?.record==='job'&&['running','stopping'].includes(row.payload.status)||row.kind==='external'&&['reserved','running','stopping','unknown'].includes(row.payload?.status)||row.kind==='browser'&&row.payload?.status!=='closed'))throw denied()
 for(const query of [
  "select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and state in ('reserved','started') limit 1",
  'select 1 from teloa_task_run_flows where owner_id=$1 and run_id=$2 limit 1',
  "select 1 from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 and receipt->>'state' in ('reserved','unknown') limit 1",
 ])if((await db.query(query,[owner,run.id])).rows.length)throw denied()
 if((await db.query("select 1 from teloa_security_action_executions e join teloa_security_actions a on a.owner_id=e.owner_id and a.id=e.action_id where e.owner_id=$1 and a.task_id=$2 and e.state not in ('succeeded','failed') limit 1",[owner,run.taskId])).rows.length)throw denied()
}
export async function initializeTaskRunSourceFollowups(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_task_run_source_followups(
  owner_id text not null,request_id uuid not null,run_id uuid not null,original_run_id uuid not null,source_update_id uuid not null,binding jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id),unique(owner_id,run_id),
  foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id),
  foreign key(original_run_id,owner_id) references teloa_task_runs(id,owner_id),
  foreign key(source_update_id) references teloa_business_task_source_updates(id)
 );
 create index if not exists teloa_source_followup_original on teloa_task_run_source_followups(owner_id,original_run_id);
 create or replace function teloa_source_followup_guard() returns trigger language plpgsql as $$ begin raise exception 'teloa unknown followup confirmation is immutable'; end $$;
 drop trigger if exists teloa_source_followup_guard on teloa_task_run_source_followups;
 create trigger teloa_source_followup_guard before update or delete on teloa_task_run_source_followups for each row execute function teloa_source_followup_guard();
`)}

type StoredRun=Record<string,unknown>
/** 只沿已持久且不可改的明确确认链找原来源，不把后续 Run 写回 update.run_id。 */
async function sourceFollowupOriginal(db:PoolClient,owner:string,f:TaskRunSourceFollowup,seen=new Set<string>(),leaf:TaskRunSourceFollowup=f):Promise<{original:StoredRun;root:StoredRun;ancestors:StoredRun[]}>{
 if(seen.has(f.originalRunId))throw denied();seen.add(f.originalRunId)
 const original:StoredRun|undefined=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,f.originalRunId])).rows[0]
 if(!original||typeof original.input_text!=='string'||original.task_id!==f.taskId||original.session_id!==f.sessionId||original.native_request_id!==f.originalNativeRequestId||createHash('sha256').update(original.input_text).digest('hex')!==f.originalInputSha256)throw denied()
 if(f.kind==='unknown-verification'){
  if(original.state!=='submission_unknown'||original.evidence!==null||!isDeepStrictEqual(readTaskRunSubmissionDisposition(original.submission_disposition),f.disposition))throw denied()
 }else if(original.state==='withdrawn'&&f.kind==='error-recovery'){
  if((await verifyUnpublished(db,owner,readStoredTaskRun(original),leaf)).sha256!==f.originalEvidenceSha256)throw denied()
 }else{
  const evidence=runEvidence(original.evidence)
  if(original.state!=='ended'||evidence.state!=='ended'||evidence.reason!==(recoveryKind(f.kind)?'error':'completed')||(f.kind==='stopped-continuation'?stopTime(original.stop_requested_at)!==f.originalStopRequestedAt:original.stop_requested_at!==null)||evidenceHash(evidence)!==f.originalEvidenceSha256)throw denied()
 }
 const input=JSON.parse(original.input_text),parent=input.sourceFollowup===undefined?undefined:readTaskRunSourceFollowup(input.sourceFollowup)
 if(parent===undefined)return {original,root:original,ancestors:[original]}
 // 只有已经明确纠错的 error 再次失败可继续；unknown/成果重核验不借此扩为循环执行。
 if(!recoveryKind(f.kind)||!recoveryKind(parent.kind)||parent.requestId!==original.request_id||parent.taskId!==original.task_id||parent.taskVersion!==original.task_version||parent.sessionId!==original.session_id||parent.sourceUpdateId!==f.sourceUpdateId||parent.sourceTaskVersion!==f.sourceTaskVersion||parent.sourceEventId!==f.sourceEventId||!isDeepStrictEqual(parent.reference,f.reference)||!isDeepStrictEqual((original.request_spec as {sourceFollowup?:unknown}|undefined)?.sourceFollowup,parent))throw denied()
 const record=(await db.query('select * from teloa_task_run_source_followups where owner_id=$1 and run_id=$2 for share',[owner,original.id])).rows[0]
 if(!record||record.request_id!==parent.requestId||record.original_run_id!==parent.originalRunId||record.source_update_id!==parent.sourceUpdateId||!isDeepStrictEqual(readTaskRunSourceFollowup(record.binding),parent))throw denied()
 const previous=await sourceFollowupOriginal(db,owner,parent,seen,leaf)
 if(previous.original.role_id!==original.role_id||previous.original.role_version!==original.role_version||previous.original.agent_preset_id!==original.agent_preset_id||Number(previous.original.task_version)>=Number(original.task_version)||previous.original.native_request_id===original.native_request_id)throw denied()
 return {original,root:previous.root,ancestors:[original,...previous.ancestors]}
}
/** 独立确认引用原 update；绝不改绑其 run_id/task_version。 */
export async function sourceFollowupCandidate(db:PoolClient,owner:string,run:TaskRun,taskVersion:number,following?:TaskRunSourceFollowup):Promise<TaskRunSourceFollowupCandidate>{
 stoppedProofs.delete(run)
 revokePlanAdmission(run)
 const stopped=run.state==='ended'&&run.evidence?.state==='ended'&&run.evidence.reason==='error'&&run.stopRequestedAt!==null
 const unpublished=run.state==='withdrawn'&&run.evidence===null&&run.stopRequestedAt!==null&&!run.sourceFollowup,unknown=run.state==='submission_unknown',error=run.state==='ended'&&run.evidence?.state==='ended'&&run.evidence.reason==='error'&&run.stopRequestedAt===null,completed=run.state==='ended'&&run.evidence?.state==='ended'&&run.evidence.reason==='completed'&&run.stopRequestedAt===null
 if(!unknown&&!completed&&!error&&!unpublished&&!stopped||unknown&&(!run.submissionDisposition||!run.stopRequestedAt||run.evidence!==null)||run.executor||!run.roleSnapshot||!run.agentPresetId||run.sourceFollowup&&(!(error||stopped)||!recoveryKind(run.sourceFollowup.kind)))throw denied()
 if(stopped){
  const stored=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,run.id])).rows[0]
  if(!stored||stored.state!=='ended'||stopTime(stored.stop_requested_at)!==run.stopRequestedAt||evidenceHash(runEvidence(stored.evidence))!==evidenceHash(run.evidence)||stored.task_id!==run.taskId||stored.session_id!==run.sessionId||stored.native_request_id!==run.nativeRequestId||stored.input_text!==run.inputText||stored.role_id!==run.roleId||stored.role_version!==run.roleVersion)throw denied()
 }
 const unpublishedProof=unpublished?await verifyUnpublished(db,owner,run,following,'dispatch'):undefined
 await assertBoundaries(db,owner,run)
 if(error||stopped)for(const query of [
  `select 1 from teloa_work_budget_reservations b join teloa_work_retry_claims c on c.owner_id=b.owner_id and c.model_request_id=b.model_request_id join teloa_work_retries r on r.owner_id=c.owner_id and r.operation_id=c.operation_id join teloa_task_runs n on n.owner_id=r.owner_id and n.id=r.run_id where b.owner_id=$1 and r.run_id=$2 and b.state in ('reserved','unknown') and not coalesce((${terminalSourceFollowupBudgetSQL}),false) limit 1`,
 ])if((await db.query(query,[owner,run.id])).rows.length)throw denied()
 if(run.sourceFollowup){await verifySourceFollowup(db,owner,run);revokePlanAdmission(run)}
 const chain=run.sourceFollowup?await sourceFollowupOriginal(db,owner,run.sourceFollowup):null
 if(chain)for(const row of chain.ancestors){
  await assertBoundaries(db,owner,{id:String(row.id),taskId:String(row.task_id),sessionId:String(row.session_id),nativeRequestId:String(row.native_request_id),...(row.submission_disposition==null?{}:{submissionDisposition:readTaskRunSubmissionDisposition(row.submission_disposition)})})
  if((await db.query(`select 1 from teloa_work_budget_reservations b join teloa_work_retry_claims c on c.owner_id=b.owner_id and c.model_request_id=b.model_request_id join teloa_work_retries r on r.owner_id=c.owner_id and r.operation_id=c.operation_id join teloa_task_runs n on n.owner_id=r.owner_id and n.id=r.run_id where b.owner_id=$1 and r.run_id=$2 and b.state in ('reserved','unknown') and not coalesce((${terminalSourceFollowupBudgetSQL}),false) limit 1`,[owner,row.id])).rows.length)throw denied()
 }
 const root=chain?.root,rootRunId=root?.id??run.id,rootTaskVersion=root?.task_version??run.taskVersion
 const updates=(await db.query('select * from teloa_business_task_source_updates where owner_id=$1 and task_id=$2 and run_id=$3 for share',[owner,run.taskId,rootRunId])).rows
 if(updates.length!==1)throw denied()
 const u=updates[0]!
 if(!sourceUpdateEligible(u,unknown,unpublished||root?.state==='withdrawn')||u.task_version!==rootTaskVersion||businessTaskSourceUpdateRunRequestId(owner,u.id)!==(await db.query('select request_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,rootRunId])).rows[0]?.request_id)throw denied()
 const reference=businessObjectReference({scope:u.scope_id,type:u.object_type,id:u.object_id,version:u.object_version,snapshotHash:u.snapshot_hash})
 const sources=(await db.query(`select s.* from teloa_business_task_sources s join teloa_plan_task_links l on l.owner_id=s.owner_id and l.task_id=s.task_id join teloa_plan_occurrences o on o.owner_id=l.owner_id and o.id=l.claim_id where s.owner_id=$1 and s.task_id=$2 and o.plan_id=$3`,[owner,run.taskId,u.plan_id])).rows
 if(sources.length!==1||sources[0].scope_id!==reference.scope||sources[0].object_type!==reference.type||sources[0].object_id!==reference.id||sources[0].object_version>=reference.version)throw denied()
 const context=JSON.parse(run.inputText).businessContext
 if(!context||!context.updates?.length||!isDeepStrictEqual(businessObjectReference(Object.fromEntries(Object.entries(context.updates.at(-1)).filter(([key])=>['scope','type','id','version','snapshotHash'].includes(key)))),reference))throw denied()
 if(!unknown&&(await db.query('select max(object_version) as version from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4',[owner,reference.scope,reference.type,reference.id])).rows[0]?.version!==reference.version)throw denied()
 const candidate=readTaskRunSourceFollowupCandidate({schema:'teloa.task-run-source-followup-candidate/v1',kind:unknown?'unknown-verification':stopped?'stopped-continuation':error||unpublished?'error-recovery':'result-verification',originalNativeRequestId:run.nativeRequestId,originalInputSha256:createHash('sha256').update(run.inputText).digest('hex'),originalEvidenceSha256:unknown?null:unpublishedProof?.sha256??evidenceHash(run.evidence),...(stopped?{originalStopRequestedAt:run.stopRequestedAt}:{}),taskId:run.taskId,expectedTaskVersion:taskVersion,runId:run.id,sessionId:run.sessionId,...(unknown?{disposition:run.submissionDisposition}:{}),sourceUpdateId:u.id,sourceTaskVersion:u.task_version,sourceEventId:u.event_id,reference})
 if(stopped)grantStopped(run,run.stopRequestedAt!,candidate.originalEvidenceSha256!)
 if(error||stopped)grantPlanAdmission(db,owner,run)
 if(unpublishedProof)unpublishedProofs.set(run,unpublishedProof)
 return candidate
}
export async function exactSourceFollowupSnapshot(db:PoolClient,owner:string,f:TaskRunSourceFollowup){
 const rows=(await db.query(`select u.*,s.snapshot from teloa_business_task_source_updates u join teloa_business_object_snapshots s on s.owner_id=u.owner_id and s.scope_id=u.scope_id and s.object_type=u.object_type and s.object_id=u.object_id and s.object_version=u.object_version where u.owner_id=$1 and u.id=$2 for share of u,s`,[owner,f.sourceUpdateId])).rows
 if(rows.length!==1)throw denied();const row=rows[0]!,snapshot=readBusinessObjectSnapshot(row.snapshot,f.reference.scope)
 const root=(await sourceFollowupOriginal(db,owner,f)).root
 if(!sourceUpdateEligible(row,f.kind==='unknown-verification',root.state==='withdrawn')||row.task_id!==f.taskId||row.run_id!==root.id||row.task_version!==f.sourceTaskVersion||row.event_id!==f.sourceEventId||!isDeepStrictEqual(businessObjectReference({scope:row.scope_id,type:row.object_type,id:row.object_id,version:row.object_version,snapshotHash:row.snapshot_hash}),f.reference)||businessObjectSnapshotHash(snapshot)!==f.reference.snapshotHash)throw denied()
 return {...snapshot,snapshotHash:f.reference.snapshotHash}
}
export async function verifySourceFollowup(db:PoolClient,owner:string,run:TaskRun):Promise<Record<string,unknown>|null>{
 revokePlanAdmission(run)
 const f=run.sourceFollowup
 if(!f)return null
 const row=(await db.query('select * from teloa_task_run_source_followups where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows[0]
 if(!row||row.request_id!==f.requestId||row.original_run_id!==f.originalRunId||row.source_update_id!==f.sourceUpdateId||!isDeepStrictEqual(readTaskRunSourceFollowup(row.binding),f))throw denied()
 const {original}=await sourceFollowupOriginal(db,owner,f)
 if(original.role_id!==run.roleId||original.role_version!==run.roleVersion||original.agent_preset_id!==run.agentPresetId||original.native_request_id===run.nativeRequestId)throw denied()
 const snapshot=await exactSourceFollowupSnapshot(db,owner,f),input=JSON.parse(run.inputText)
 if(!isDeepStrictEqual(input.businessContext?.updates,[snapshot]))throw denied()
 if(recoveryKind(f.kind)&&original.state==='ended'&&run.stopRequestedAt===null)grantPlanAdmission(db,owner,run)
 return original
}
/** 正常内部读取返回的新对象也携带已核历史资格；不经过动态 candidate，不产生发送许可。 */
export async function readSourceFollowupOriginal(db:PoolClient,owner:string,run:TaskRun):Promise<TaskRun|null>{
 const original=await verifySourceFollowup(db,owner,run)
 if(!original)return null
 const source=readStoredTaskRun(original)
 if(run.sourceFollowup?.kind==='stopped-continuation')grantStopped(source,run.sourceFollowup.originalStopRequestedAt!,run.sourceFollowup.originalEvidenceSha256!)
 if(source.state==='withdrawn'){
  const proof=await verifyUnpublished(db,owner,source,run.sourceFollowup,'history')
  if(proof.sha256!==run.sourceFollowup?.originalEvidenceSha256)throw denied()
  unpublishedProofs.set(source,proof)
 }
 return source
}
export async function writeSourceFollowup(db:PoolClient,owner:string,run:TaskRun):Promise<void>{
 const f=run.sourceFollowup;if(!f)return
 await db.query('insert into teloa_task_run_source_followups(owner_id,request_id,run_id,original_run_id,source_update_id,binding,created_at) values($1,$2,$3,$4,$5,$6,$7)',[owner,f.requestId,run.id,f.originalRunId,f.sourceUpdateId,JSON.stringify(f),f.confirmedAt])
}

/** 只读历史证明不等于发送资格；新发布/恢复必须重新执行 dispatch 动态门。 */
export async function assertSourceFollowupDispatch(db:PoolClient,owner:string,run:TaskRun):Promise<void>{
 if(!run.sourceFollowup)return
 const original=await verifySourceFollowup(db,owner,run)
 if(original&&(original.state==='withdrawn'||recoveryKind(run.sourceFollowup.kind)))await sourceFollowupCandidate(db,owner,readStoredTaskRun(original),run.taskVersion,run.sourceFollowup)
 // 本人paused单次证明与预算发送闸分开；error分支不能跳过typed根的unknown/foreign检查。
 const root=(await sourceFollowupOriginal(db,owner,run.sourceFollowup)).root
 if(root.state==='withdrawn')await verifyUnpublished(db,owner,readStoredTaskRun(root),run.sourceFollowup,'dispatch')
}
