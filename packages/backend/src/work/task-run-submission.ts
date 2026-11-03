import {createHash,randomUUID} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readTaskRunSubmissionDisposition,readTaskRunSourceFollowup,type TaskRunSourceFollowup} from '@teloa/contract'
import {readStoredTaskRun,type TaskRun,type TaskRunService} from './task-runs.ts'
import {workEventDigest} from './work-event-digest.ts'
export type TaskRunSubmissionFence={runId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string;logCut:number;logSha256:string;notPublished?:true;assertCurrent:()=>void}
/** 仅同安装维护CLI装配，不能由在线API上传；每种处置独立保留原Run的固定审计。 */
export type TaskRunMaintenanceAudit={schema:'teloa.task-run-maintenance/v1';source:'maintenance-process-exit';installId:string;requestId:string;runId:string;processReceipt:Record<string,unknown>;backupSha256:string;logFileSha256:string}

/** 仅宿主提交边界可写；未知绝不通过超时、日志缺失或旧世代自动降级。 */
export type TaskRunSubmissionAttempt=Readonly<{attemptId:string;runId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string}>
export type TaskRunSubmissionJournal={begin:(run:TaskRun)=>Promise<TaskRunSubmissionAttempt>;finish:(attempt:TaskRunSubmissionAttempt,outcome:'accepted'|'not-published')=>Promise<void>;recoverable:(run:TaskRun)=>Promise<boolean>;publicationState?:(run:TaskRun)=>Promise<'not-published'|'unknown'>;unpublishedOwnerIds?:(runId:string)=>Promise<readonly string[]>}
const denied=()=>new WorkError('teloa/conflict','执行提交仍需核对，不能重复发送。')
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const fixed=(run:TaskRun)=>({runId:run.id,sessionId:run.sessionId,nativeRequestId:run.nativeRequestId,inputSha256:createHash('sha256').update(run.inputText).digest('hex')})
function validateMaintenanceAudit(audit:TaskRunMaintenanceAudit,command:Record<string,unknown>):void{
   type Process={pid?:number;pidVersion?:number;uniqueId?:string;ppid?:number;parentUniqueId?:string;children?:number[];uid?:number}
   const proof=audit.processReceipt,supervisor=proof?.supervisor as Process|undefined,child=proof?.child as Process|undefined,reference=proof?.referenceMcp as Process|undefined
   const processes=[supervisor,child,...reference?[reference]:[]]
   if(Object.keys(audit).sort().join(',')!=='backupSha256,installId,logFileSha256,processReceipt,requestId,runId,schema,source'||audit.schema!=='teloa.task-run-maintenance/v1'||audit.source!=='maintenance-process-exit'||!uuid(audit.installId)||audit.requestId!==command.requestId||audit.runId!==command.runId||![audit.backupSha256,audit.logFileSha256,proof?.bindingSha256].every(v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v))||proof?.schema!=='teloa.maintenance-process-exit/v1'||proof.signal!=='SIGTERM'||!supervisor||!child||new Set(processes.map(v=>v?.pid)).size!==processes.length||!processes.every(v=>v&&Number.isSafeInteger(v.pid)&&v.pid!>0&&Number.isSafeInteger(v.pidVersion)&&v.pidVersion!>0&&typeof v.uniqueId==='string'&&/^\d+$/.test(v.uniqueId))||!isDeepStrictEqual(proof.exited,processes.map(v=>v?.pid).sort((a,b)=>a!-b!))||JSON.stringify(audit).length>131072)throw denied()
   // 旧双进程审计保持兼容；可选第三世代只能是已绑定runtime的唯一直属叶子。
   if(proof.referenceMcp!==undefined&&(!reference||reference.ppid!==child.pid||reference.parentUniqueId!==child.uniqueId||!Number.isSafeInteger(reference.uid)||reference.uid!==child.uid||child.uid!==supervisor.uid||child.ppid!==supervisor.pid||child.parentUniqueId!==supervisor.uniqueId||!isDeepStrictEqual(supervisor.children,[child.pid])||!isDeepStrictEqual(child.children,[reference.pid])||!isDeepStrictEqual(reference.children,[])))throw denied()
}
export async function initializeTaskRunSubmissions(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_task_run_submissions(
  owner_id text not null,run_id uuid not null,attempt integer not null check(attempt>0),attempt_id uuid not null unique,
  session_id text not null,native_request_id uuid not null,input_sha256 text not null check(input_sha256 ~ '^[a-f0-9]{64}$'),runtime_id uuid not null,
  state text not null check(state in ('dispatching','not-published','accepted')),created_at timestamptz not null default now(),settled_at timestamptz,
  primary key(owner_id,run_id,attempt),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
 await pool.query(`create table if not exists teloa_task_run_maintenance_dispositions(
  owner_id text not null,run_id uuid not null,request_id uuid not null unique,install_id uuid not null,
  audit jsonb not null,disposition jsonb not null,created_at timestamptz not null default now(),
  primary key(owner_id,run_id),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
 await pool.query('create table if not exists teloa_task_run_unpublished_cancellations(owner_id text not null,run_id uuid not null,request_id uuid not null unique,receipt jsonb not null,audit jsonb,primary key(owner_id,run_id),foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id))')
}
/** 已持有当前业务事务的只读消费者；不借连接、不提交外层事务，也不把撤回状态当作未发布证明。 */
export async function readUnpublishedCancellationSettled(db:Pick<PoolClient,'query'>,owner:string,run:TaskRun,snapshot:TaskRun=run,following?:TaskRunSourceFollowup,budgetMode:'history'|'dispatch'|'settlement'='history'):Promise<boolean>{
 return readUnpublishedCancellation(db,owner,run,snapshot,following,budgetMode,false)
}
/** 原取消身份的历史核验；不证明账户当前可发送或整项工作已经结清。 */
export async function readUnpublishedCancellationHistory(db:Pick<PoolClient,'query'>,owner:string,run:TaskRun):Promise<boolean>{
 return readUnpublishedCancellation(db,owner,run,run,undefined,'history',true)
}
async function readUnpublishedCancellation(db:Pick<PoolClient,'query'>,owner:string,run:TaskRun,snapshot:TaskRun,following:TaskRunSourceFollowup|undefined,budgetMode:'history'|'dispatch'|'settlement',historyOnly:boolean):Promise<boolean>{
 if(typeof owner!=='string'||!owner||!uuid(run.id)||run.state!=='withdrawn'||run.evidence!==null||!isDeepStrictEqual({identity:fixed(run),state:run.state,evidence:run.evidence,stop:run.stopRequestedAt},{identity:fixed(snapshot),state:snapshot.state,evidence:snapshot.evidence,stop:snapshot.stopRequestedAt}))return false
 // 调用者即使传入同形快照，仍须命中本人当前固定撤回记录；不在持Task锁时反向锁Run。
 const current=await db.query("select id from teloa_task_runs where owner_id=$1 and id=$2 and state='withdrawn' and evidence is null and session_id=$3 and native_request_id=$4 and input_text=$5 and stop_requested_at is not distinct from $6::timestamptz",[owner,run.id,run.sessionId,run.nativeRequestId,run.inputText,run.stopRequestedAt])
 if(current.rows.length!==1)return false
 const saved=(await db.query('select request_id,receipt,audit from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0],r=saved?.receipt
 const attempts=(await db.query('select * from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt for share',[owner,run.id])).rows,latest=attempts.at(-1)
 // prepared→withdrawn 的旧正常路径没有提交审计；仅零票据、零link且无后果时保持原有静止语义。
 if(!saved&&!attempts.length){const links=await db.query('select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 limit 1',[owner,run.id]),valid=links.rowCount===0&&await noUnpublishedConsequences(db,owner,run,undefined,'history',historyOnly);return valid}
 let valid=!!run.stopRequestedAt&&!!r&&r.schema==='teloa.task-run-unpublished-cancellation/v1'&&uuid(saved.request_id)&&r.requestId===saved.request_id&&isDeepStrictEqual(r.identity,fixed(run))&&r.stopRequestedAt===run.stopRequestedAt&&uuid(r.runtimeId)&&Number.isSafeInteger(r.logCut)&&r.logCut>=-1&&typeof r.logSha256==='string'&&/^[a-f0-9]{64}$/.test(r.logSha256)&&Number.isFinite(Date.parse(r.cancelledAt))&&Date.parse(r.cancelledAt)>=Date.parse(run.stopRequestedAt)&&attempts.length>0&&isDeepStrictEqual(r.attemptIds,attempts.map(a=>a.attempt_id))&&r.latestAttemptId===latest?.attempt_id&&r.runtimeId===latest?.runtime_id&&attempts.every(a=>a.state==='not-published'&&a.settled_at instanceof Date&&a.settled_at.getTime()<=Date.parse(r.cancelledAt)&&a.session_id===run.sessionId&&a.native_request_id===run.nativeRequestId&&a.input_sha256===fixed(run).inputSha256&&uuid(a.runtime_id))
 if(valid&&saved.audit!==null){try{validateMaintenanceAudit(saved.audit,{requestId:saved.request_id,runId:run.id})}catch{valid=false}}
 if(valid){const owners=await unpublishedOwners(db,owner,run),links=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[owner,run.id])).rows;valid=links.every(l=>l.kind==='job'&&l.payload.record==='owner'&&l.owner_settlement===null&&owners.includes(l.native_id))&&await noUnpublishedConsequences(db,owner,run,following,budgetMode,historyOnly)}
 return valid
}
/** 内部SQL片段：仅真实终态及持久用量时间回执，保留unknown金额/claim，不代表零消耗。别名b/c/r/n由固定服务查询提供。 */
export const terminalSourceFollowupBudgetSQL=`
 b.state='unknown' and b.kind='retry' and b.receipt is not null and b.settled_at is not null
 and b.receipt_id is not null and b.receipt->>'receiptId'=b.receipt_id
 and (b.receipt->>'provider') is not distinct from b.provider
 and (b.receipt->>'providerRequestId') is not distinct from b.provider_request_id
 and (b.receipt->>'currency') is not distinct from b.currency
 and (b.receipt->'tokens') is not distinct from coalesce(to_jsonb(b.actual_tokens),'null'::jsonb)
 and (b.receipt->'moneyMinorUnits') is not distinct from coalesce(to_jsonb(b.money_minor_units),'null'::jsonb)
 and b.receipt->>'reservationId'=b.id::text and b.receipt->>'modelRequestId'=b.model_request_id
 and n.state='ended' and n.evidence->>'state'='ended' and n.evidence->>'reason'='error' and n.stop_requested_at is null
 and n.input_text::jsonb->'lineage'->>'budgetAccountId'=b.budget_account_id::text
 and n.input_text::jsonb->'lineage'->'controlGeneration'=to_jsonb(b.control_generation)
 and b.elapsed_ended_at is not null and b.elapsed_terminal->>'schema'='teloa.work-budget-terminal/v1'
 and b.elapsed_terminal->>'runId'=n.id::text and b.elapsed_terminal->>'sessionId'=n.session_id
 and b.elapsed_terminal->>'nativeRequestId'=n.native_request_id::text
 and b.elapsed_terminal->'turn'=n.evidence->'turn' and b.elapsed_terminal->'messageSeq'=n.evidence->'messageSeq'
 and b.elapsed_terminal->'endSeq'=n.evidence->'endSeq' and not(b.elapsed_terminal ? 'inputAnchor')
 and ((b.elapsed_terminal->>'terminalKind'='turn/end' and b.elapsed_terminal->'turnEndSeq'=b.elapsed_terminal->'endSeq')
   or (b.elapsed_terminal->>'terminalKind'='session/end-seed' and (b.elapsed_terminal->>'turnEndSeq')::integer+1=(b.elapsed_terminal->>'endSeq')::integer))
 and (b.elapsed_terminal->>'endedAt')::timestamptz>=n.created_at
 and (b.elapsed_terminal->>'endedAt')::timestamptz>=b.created_at
 and (b.elapsed_terminal->>'endedAt')::timestamptz<=now()
 and b.elapsed_ended_at>=b.created_at and b.elapsed_ended_at<=(b.elapsed_terminal->>'endedAt')::timestamptz
 and not exists(select 1 from teloa_task_run_subagents child where child.owner_id=n.owner_id and child.run_id=n.id and child.child_session_id is not null)
`
async function noUnpublishedConsequences(db:Pick<PoolClient,'query'>,owner:string,run:TaskRun,following?:TaskRunSourceFollowup,budgetMode:'history'|'dispatch'|'settlement'='history',historyOnly=false):Promise<boolean>{
 for(const table of ['teloa_task_run_subagents','teloa_task_run_web_access','teloa_task_run_flows','teloa_task_run_goals','teloa_task_run_goal_revisions','teloa_task_run_goal_continuations','teloa_work_retries'])
  if((await db.query('select 1 from '+table+' where owner_id=$1 and run_id=$2 limit 1',[owner,run.id])).rowCount)return false
 // 后续同Task的新审批/账户预约不改变原取消回执；新发送和控制结算仍执行下面完整动态门。
 if(!historyOnly&&(await db.query("select 1 from teloa_security_actions where owner_id=$1 and task_id=$2 and state not in ('succeeded','rejected','withdrawn','failed') limit 1",[owner,run.taskId])).rowCount)return false
 if(run.lineage&&!historyOnly){
  let budgetRoot=run
  // 已取消的派生请求仍由原确认链结算；不能退回全账户未知判断而让旧owner重新占位。
  if(!following&&budgetMode==='history'&&run.sourceFollowup){
   following=run.sourceFollowup;budgetMode='settlement'
   const seen=new Set<string>()
   while(budgetRoot.sourceFollowup){
    if(seen.has(budgetRoot.id))return false;seen.add(budgetRoot.id)
    const parent=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,budgetRoot.sourceFollowup.originalRunId])).rows[0]
    if(!parent||parent.owner_id!==owner)return false
    budgetRoot=readStoredTaskRun(parent)
   }
  }
  // 公共取消结算与宿主暂停对账只读同一历史；后代必须唯一且完整验证，所有预算仍须有权威终态。
  if(!following&&budgetMode==='history'){
   const children=await pendingFollowingChildren(db,owner,run)
   if(children?.length===1){
    const child=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,children[0]!.run_id])).rows[0]
    following=child?readStoredTaskRun(child).sourceFollowup??undefined:undefined
    if(following)budgetMode='settlement'
   }
  }
  // 只读历史核验只区分已持久绑定的新 Run 自己的在途预算（含 markDispatched）；不授予新发布。首次准入不传 following，所有 unknown 仍拒绝。
  const scope=following?await readUnpublishedFollowingBudgetScope(db,owner,budgetRoot,following,budgetMode):undefined,leaf=budgetMode!=='settlement'&&scope?.mayOwnBudget?scope.following:undefined
  const rows=scope?await db.query(`select 1 from teloa_work_budget_reservations b where b.owner_id=$1 and b.budget_account_id=$2 and b.state in ('reserved','unknown') and not exists(
   select 1 from teloa_work_retry_claims c join teloa_work_retries r on r.owner_id=c.owner_id and r.operation_id=c.operation_id
   join teloa_task_runs n on n.owner_id=r.owner_id and n.id=r.run_id
   where c.owner_id=b.owner_id and c.model_request_id=b.model_request_id and r.budget_account_id=b.budget_account_id
    and n.id=any($10::uuid[]) and n.task_id=$6 and n.session_id=$7
    and n.role_id is not distinct from $8::uuid and n.role_version is not distinct from $9::integer
    and (${terminalSourceFollowupBudgetSQL})
  ) and (${budgetMode==='dispatch'?"b.state='unknown' or ":''}not exists(
   select 1 from teloa_work_retry_claims c join teloa_work_retries r on r.owner_id=c.owner_id and r.operation_id=c.operation_id
   join teloa_task_runs n on n.owner_id=r.owner_id and n.id=r.run_id join teloa_task_run_source_followups f on f.owner_id=n.owner_id and f.run_id=n.id
   where c.owner_id=b.owner_id and c.model_request_id=b.model_request_id and r.budget_account_id=b.budget_account_id
    and f.request_id=$3 and f.binding=$4::jsonb and f.original_run_id=$5 and n.request_id=f.request_id
    and n.task_id=$6 and n.session_id=$7 and n.role_id is not distinct from $8::uuid and n.role_version is not distinct from $9::integer
  )) limit 1`,[owner,run.lineage.budgetAccountId,leaf?.requestId??null,JSON.stringify(leaf??null),scope!.originalRunId,run.taskId,run.sessionId,run.roleId,run.roleVersion,budgetMode==='settlement'?[scope!.runId,...scope!.ancestorRunIds]:scope!.ancestorRunIds]):await db.query("select 1 from teloa_work_budget_reservations where owner_id=$1 and budget_account_id=$2 and state in ('reserved','unknown') limit 1",[owner,run.lineage.budgetAccountId])
  if(rows.rowCount)return false
 }
 return true
}
/** 正式未发布取消的同源子请求已退役；未知或有后果的分支仍参与唯一性检查。 */
async function pendingFollowingChildren(db:Pick<PoolClient,'query'>,owner:string,parent:TaskRun):Promise<{run_id:string}[]|undefined>{
 const children=(await db.query('select run_id from teloa_task_run_source_followups where owner_id=$1 and original_run_id=$2',[owner,parent.id])).rows
 const pending:{run_id:string}[]=[]
 for(const child of children){
  const row=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,child.run_id])).rows[0]
  if(!row||row.owner_id!==owner)return undefined
  const run=readStoredTaskRun(row)
  if(run.state!=='withdrawn'){pending.push(child);continue}
  const f=run.sourceFollowup,record=(await db.query('select * from teloa_task_run_source_followups where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0]
  const source=JSON.parse(parent.inputText).businessContext?.updates?.at(-1),childSource=JSON.parse(run.inputText).businessContext?.updates?.at(-1)
  if(!f||!record||record.owner_id!==owner||record.run_id!==run.id||record.request_id!==row.request_id||record.request_id!==f.requestId||record.original_run_id!==parent.id||record.source_update_id!==f.sourceUpdateId||!isDeepStrictEqual(readTaskRunSourceFollowup(record.binding),f)||!['error-recovery','stopped-continuation'].includes(f.kind)||run.taskId!==parent.taskId||run.sessionId!==parent.sessionId||run.roleId!==parent.roleId||run.roleVersion!==parent.roleVersion||run.agentPresetId!==parent.agentPresetId||run.taskVersion<=parent.taskVersion||run.nativeRequestId===parent.nativeRequestId||f.originalRunId!==parent.id||f.originalNativeRequestId!==parent.nativeRequestId||f.originalInputSha256!==fixed(parent).inputSha256||!source||!childSource||!isDeepStrictEqual(source,childSource)||!isDeepStrictEqual(f.reference,{scope:source.scope,type:source.type,id:source.id,version:source.version,snapshotHash:source.snapshotHash}))return undefined
  if(parent.state==='withdrawn'){
   const saved=(await db.query('select request_id,receipt,audit from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2',[owner,parent.id])).rows[0]
   const updates=(await db.query('select * from teloa_business_task_source_updates where owner_id=$1 and task_id=$2 and run_id=$3',[owner,parent.taskId,parent.id])).rows
   if(f.kind!=='error-recovery'||!saved||updates.length!==1||updates[0].id!==f.sourceUpdateId||updates[0].task_version!==f.sourceTaskVersion||updates[0].event_id!==f.sourceEventId||f.originalEvidenceSha256!==workEventDigest({domain:'teloa.source-followup-unpublished-cancellation/v1',receipt:saved.receipt})||!await readUnpublishedCancellationHistory(db,owner,parent))return undefined
  }else if(parent.state!=='ended'||parent.evidence?.state!=='ended'||parent.evidence.reason!=='error'||f.originalEvidenceSha256!==workEventDigest(parent.evidence)||(f.kind==='stopped-continuation'?parent.stopRequestedAt!==f.originalStopRequestedAt:parent.stopRequestedAt!==null)||!parent.sourceFollowup||f.sourceUpdateId!==parent.sourceFollowup.sourceUpdateId||f.sourceTaskVersion!==parent.sourceFollowup.sourceTaskVersion||f.sourceEventId!==parent.sourceFollowup.sourceEventId||!isDeepStrictEqual(f.reference,parent.sourceFollowup.reference))return undefined
  // 取消回执、全部提交票据及该Run自己的无后果证据缺一不可；不靠withdrawn标签跳过。
  if(!await readUnpublishedCancellationHistory(db,owner,run))return undefined
 }
 return pending
}
/** 只验证已持久的本人确认链；不授予执行。未持久的 prepare 输入不豁免新请求自身预算，仅可核验已终态祖先。 */
export async function readUnpublishedFollowingBudgetScope(db:Pick<PoolClient,'query'>,owner:string,root:TaskRun,following:TaskRunSourceFollowup,budgetMode:'history'|'dispatch'|'settlement'='dispatch'):Promise<{originalRunId:string;runId:string;following:TaskRunSourceFollowup;ancestorRunIds:string[];mayOwnBudget:boolean}|undefined>{
 try{
  const saved=(await db.query('select request_id,receipt,audit from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2',[owner,root.id])).rows[0]
  const updates=(await db.query('select * from teloa_business_task_source_updates where owner_id=$1 and task_id=$2 and run_id=$3',[owner,root.taskId,root.id])).rows
  if(root.state!=='withdrawn'||root.evidence!==null||!root.stopRequestedAt||root.sourceFollowup||!saved||updates.length!==1)return undefined
  const update=updates[0]!,reference={scope:update.scope_id,type:update.object_type,id:update.object_id,version:update.object_version,snapshotHash:update.snapshot_hash},seen=new Set<string>(),leaf=readTaskRunSourceFollowup(following)
  if(update.owner_id!==owner||update.task_id!==root.taskId||update.run_id!==root.id||update.task_version!==root.taskVersion||update.state!=='needs-user'||update.reason!=='teloa/run-not-accepted')return undefined
  let f=leaf,leafRun:TaskRun|undefined
  for(;;){
   if(!['error-recovery','stopped-continuation'].includes(f.kind)||f.taskId!==root.taskId||f.sessionId!==root.sessionId||f.sourceUpdateId!==update.id||f.sourceTaskVersion!==root.taskVersion||f.sourceEventId!==update.event_id||!isDeepStrictEqual(f.reference,reference))return undefined
   const record=(await db.query('select * from teloa_task_run_source_followups where owner_id=$1 and request_id=$2',[owner,f.requestId])).rows[0]
   if(!record&&f===leaf){
    // prepare尚未持久新请求：只能识别已验证祖先的真实terminal预算，绝不豁免新请求自身预算。
    const parentRow=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,f.originalRunId])).rows[0]
    if(!parentRow||parentRow.owner_id!==owner)return undefined
    const parent=readStoredTaskRun(parentRow)
    if(!parent.sourceFollowup||parent.taskId!==root.taskId||parent.sessionId!==root.sessionId||parent.roleId!==root.roleId||parent.roleVersion!==root.roleVersion||parent.agentPresetId!==root.agentPresetId||parent.taskVersion>=f.taskVersion||parent.nativeRequestId!==f.originalNativeRequestId||fixed(parent).inputSha256!==f.originalInputSha256||parent.state!=='ended'||parent.evidence?.state!=='ended'||parent.evidence.reason!=='error'||(f.kind==='stopped-continuation'?parent.stopRequestedAt!==f.originalStopRequestedAt:parent.stopRequestedAt!==null)||workEventDigest(parent.evidence)!==f.originalEvidenceSha256)return undefined
    const proven=await readUnpublishedFollowingBudgetScope(db,owner,root,parent.sourceFollowup,'dispatch')
    return proven?{...proven,originalRunId:parent.id,following:leaf,ancestorRunIds:[parent.id,...proven.ancestorRunIds],mayOwnBudget:false}:undefined
   }
   if(!record||record.owner_id!==owner||record.request_id!==f.requestId||record.original_run_id!==f.originalRunId||record.source_update_id!==update.id||!isDeepStrictEqual(readTaskRunSourceFollowup(record.binding),f)||seen.has(record.run_id))return undefined
   seen.add(record.run_id)
   const childRow=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,record.run_id])).rows[0],parentRow=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,f.originalRunId])).rows[0]
   if(!childRow||!parentRow||childRow.owner_id!==owner||parentRow.owner_id!==owner)return undefined
   const child=readStoredTaskRun(childRow),parent=readStoredTaskRun(parentRow)
   leafRun??=child
   if(child.taskId!==root.taskId||child.sessionId!==root.sessionId||child.roleId!==root.roleId||child.roleVersion!==root.roleVersion||child.agentPresetId!==root.agentPresetId||child.taskVersion!==f.taskVersion||childRow.request_id!==f.requestId||!isDeepStrictEqual(child.sourceFollowup,f)||parent.taskId!==root.taskId||parent.sessionId!==root.sessionId||parent.roleId!==root.roleId||parent.roleVersion!==root.roleVersion||parent.agentPresetId!==root.agentPresetId||parent.taskVersion>=child.taskVersion||parent.nativeRequestId===child.nativeRequestId||parent.nativeRequestId!==f.originalNativeRequestId||fixed(parent).inputSha256!==f.originalInputSha256)return undefined
   for(const item of[child,parent]){const input=JSON.parse(item.inputText),source=input.businessContext?.updates?.at(-1);if(!source||input.task.scope!==reference.scope||!isDeepStrictEqual({scope:source.scope,type:source.type,id:source.id,version:source.version,snapshotHash:source.snapshotHash},reference))return undefined}
   const siblings=await pendingFollowingChildren(db,owner,parent)
   if(!siblings)return undefined
   // 已取消确认仍是goal/history的固定依据，但永远不能成为拥有在途预算的leaf。
   const retired=child.state==='withdrawn'&&!siblings.some(sibling=>sibling.run_id===child.id)
   if(retired?siblings.length>1:siblings.length!==1||siblings[0]!.run_id!==child.id)return undefined
   if(f===leaf&&retired&&budgetMode!=='dispatch'&&siblings.length===1){
    const replacement=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,siblings[0]!.run_id])).rows[0]
    if(!replacement||replacement.owner_id!==owner)return undefined
    const next=readStoredTaskRun(replacement).sourceFollowup
    if(!next||next.originalRunId!==parent.id)return undefined
    return readUnpublishedFollowingBudgetScope(db,owner,root,next,budgetMode)
   }
   if(parent.id===root.id){
    if(!isDeepStrictEqual(fixed(parent),fixed(root))||f.kind!=='error-recovery'||f.originalEvidenceSha256!==workEventDigest({domain:'teloa.source-followup-unpublished-cancellation/v1',receipt:saved.receipt}))return undefined
    let scope={originalRunId:leaf.originalRunId,runId:leafRun.id,following:leaf,ancestorRunIds:[...seen].filter(id=>id!==leafRun!.id).concat(root.id),mayOwnBudget:leafRun.stopRequestedAt===null&&!['withdrawn','configuration_failed','submission_unknown'].includes(leafRun.state)}
    if(budgetMode==='dispatch')return scope
    // 历史读取沿唯一持久后代核真实当前leaf；不会把旧Run变成该后代的发送许可。
    for(;;){
     const parentRow=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,scope.runId])).rows[0]
     if(!parentRow||parentRow.owner_id!==owner)return undefined
     const descendants=await pendingFollowingChildren(db,owner,readStoredTaskRun(parentRow))
     if(!descendants)return undefined
     if(descendants.length===0)return scope
     if(descendants.length!==1)return undefined
     const descendant=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,descendants[0]!.run_id])).rows[0]
     if(!descendant||descendant.owner_id!==owner)return undefined
     const next=readStoredTaskRun(descendant).sourceFollowup
     if(!next||next.originalRunId!==scope.runId)return undefined
     const checked=await readUnpublishedFollowingBudgetScope(db,owner,root,next,'dispatch')
     if(!checked)return undefined
     scope=checked
    }
   }
   if(parent.state!=='ended'||parent.evidence?.state!=='ended'||parent.evidence.reason!=='error'||(f.kind==='stopped-continuation'?parent.stopRequestedAt!==f.originalStopRequestedAt:parent.stopRequestedAt!==null)||workEventDigest(parent.evidence)!==f.originalEvidenceSha256||!parent.sourceFollowup)return undefined
   f=parent.sourceFollowup
  }
 }catch(error){if(error instanceof WorkError)return undefined;throw error}
}
 /** 仅退役确定未发布的 owner 登记；原始审计不删除，任何实际 job/外部工作都不在此范围。 */
async function unpublishedOwners(db:Pick<PoolClient,'query'>,owner:string,run:TaskRun):Promise<string[]>{
  const owners=(await db.query("select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind='job' and payload->>'record'='owner'",[owner,run.id])).rows
  if(owners.some(row=>row.session_id!==run.sessionId||row.payload.requestId!==run.nativeRequestId||row.native_id!=='owner:'+row.payload.runtimeId+':'+run.sessionId))throw denied()
  const rows=(await db.query('select * from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt',[owner,run.id])).rows
  const runtimes=new Map<string,boolean>()
  for(const row of rows){
 if(row.session_id!==run.sessionId||row.native_request_id!==run.nativeRequestId||row.input_sha256!==fixed(run).inputSha256||!uuid(row.runtime_id))throw denied()
 runtimes.set(row.runtime_id,(runtimes.get(row.runtime_id)??true)&&row.state==='not-published')
  }
  return [...runtimes].filter(([,unpublished])=>unpublished).map(([id])=>'owner:'+id+':'+run.sessionId)
}
export class TaskRunSubmissionService{
 readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 /** 确定投递事实不因停止意图变为未知，也不表示仍可重发。 */
 async publicationState(owner:string,run:TaskRun):Promise<'not-published'|'unknown'>{
  const db=await this.pool.connect()
  try{
   await db.query('begin');const current=await this.current(db,owner,run.id,'share')
   if(!isDeepStrictEqual({identity:fixed(current),state:current.state,evidence:current.evidence,stopRequestedAt:current.stopRequestedAt},{identity:fixed(run),state:run.state,evidence:run.evidence,stopRequestedAt:run.stopRequestedAt}))throw denied()
   const rows=(await db.query('select * from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt',[owner,run.id])).rows
   const known=current.state==='submitting'&&current.evidence===null&&rows.length>0&&rows.every(row=>row.state==='not-published'&&row.settled_at instanceof Date&&row.session_id===run.sessionId&&row.native_request_id===run.nativeRequestId&&row.input_sha256===fixed(run).inputSha256&&uuid(row.runtime_id))
   await db.query('commit');return known?'not-published':'unknown'
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 可信取消的静止证明：只读原审计、全部票据及后果，不恢复旧原生会话。 */
 async unpublishedCancellationSettled(owner:string,snapshot:TaskRun):Promise<boolean>{
  const db=await this.pool.connect()
  try{
   await db.query('begin');const run=await this.current(db,owner,snapshot.id,'share')
   const valid=await readUnpublishedCancellationSettled(db,owner,run,snapshot)
   await db.query('commit');return valid
  }catch(error){await db.query('rollback');if(error instanceof WorkError)return false;throw error}finally{db.release()}
 }
 async cancelNotPublished(owner:string,input:unknown,runs:Pick<TaskRunService,'readVerifiedInTransaction'>,fence:TaskRunSubmissionFence):Promise<TaskRun>{return this.cancel(owner,input,runs,fence)}
 async cancelNotPublishedAfterMaintenance(owner:string,input:unknown,runs:Pick<TaskRunService,'readVerifiedInTransaction'>,fence:TaskRunSubmissionFence,audit:TaskRunMaintenanceAudit):Promise<TaskRun>{return this.cancel(owner,input,runs,fence,audit)}
 private async cancel(owner:string,input:unknown,runs:Pick<TaskRunService,'readVerifiedInTransaction'>,fence:TaskRunSubmissionFence,audit?:TaskRunMaintenanceAudit):Promise<TaskRun>{
  const command=taskInput(input,['requestId','runId','confirmNotPublished'])
  if(Object.keys(command).length!==3||!uuid(command.requestId)||!uuid(command.runId)||command.confirmNotPublished!==true||fence?.notPublished!==true||typeof fence?.assertCurrent!=='function'||!Number.isSafeInteger(fence.logCut)||fence.logCut< -1||!/^[a-f0-9]{64}$/.test(fence.logSha256))throw denied()
  if(audit)validateMaintenanceAudit(audit,command)
  fence.assertCurrent();const db=await this.pool.connect()
  try{
   await db.query('begin');const current=await this.current(db,owner,command.runId),run=await runs.readVerifiedInTransaction(db,owner,current.id)
   if(!isDeepStrictEqual(fixed(run),{runId:fence.runId,sessionId:fence.sessionId,nativeRequestId:fence.nativeRequestId,inputSha256:fence.inputSha256}))throw denied()
   const previous=(await db.query('select request_id,receipt,audit from teloa_task_run_unpublished_cancellations where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0]
   if(previous){
    if(run.state!=='withdrawn'||run.evidence!==null||previous.request_id!==command.requestId||previous.receipt.schema!=='teloa.task-run-unpublished-cancellation/v1'||!isDeepStrictEqual(previous.receipt.identity,fixed(run))||!isDeepStrictEqual(previous.audit,audit??null))throw denied()
    fence.assertCurrent();await db.query('commit');return run
   }
   if(run.state!=='submitting'||run.evidence!==null||!run.stopRequestedAt)throw denied()
   const attempts=(await db.query('select * from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt for share',[owner,run.id])).rows
   if(!attempts.length||attempts.some(row=>row.state!=='not-published'||!(row.settled_at instanceof Date)||row.session_id!==run.sessionId||row.native_request_id!==run.nativeRequestId||row.input_sha256!==fixed(run).inputSha256||!uuid(row.runtime_id)))throw denied()
   const latest=attempts.at(-1)!
   if(latest.runtime_id!==fence.runtimeId)throw denied()
   const owners=await unpublishedOwners(db,owner,run),links=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[owner,run.id])).rows
   if(links.some(row=>row.kind!=='job'||row.payload.record!=='owner'||row.owner_settlement!==null||!owners.includes(row.native_id)))throw denied()
   if(!await noUnpublishedConsequences(db,owner,run))throw denied()
   const receipt={schema:'teloa.task-run-unpublished-cancellation/v1',requestId:command.requestId,identity:fixed(run),runtimeId:fence.runtimeId,attemptIds:attempts.map(row=>row.attempt_id),latestAttemptId:latest.attempt_id,logCut:fence.logCut,logSha256:fence.logSha256,stopRequestedAt:run.stopRequestedAt,cancelledAt:new Date().toISOString()}
   fence.assertCurrent()
   const stored=(await db.query('select task_state_version from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.id])).rows[0]
   await db.query("update teloa_tasks set state='paused',version=version+1,updated_at=$4 where owner_id=$1 and id=$2 and version=$3 and state='running' and not exists(select 1 from teloa_task_runs r where r.owner_id=$1 and r.task_id=$2 and r.id<>$5 and r.state in ('prepared','submitting','accepted','active'))",[owner,run.taskId,stored.task_state_version,receipt.cancelledAt,run.id])
   await db.query("update teloa_task_runs set state='withdrawn' where owner_id=$1 and id=$2",[owner,run.id])
   await db.query('insert into teloa_task_run_unpublished_cancellations(owner_id,run_id,request_id,receipt,audit) values($1,$2,$3,$4,$5)',[owner,run.id,command.requestId,JSON.stringify(receipt),audit?JSON.stringify(audit):null])
   const saved=await runs.readVerifiedInTransaction(db,owner,run.id)
   fence.assertCurrent();await db.query('commit');return saved
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 明确处置未知：不声称从未发送，不生成原生结束证据，不授予重新执行。 */
 async disposeUnknown(owner:string,input:unknown,runs:Pick<TaskRunService,'readVerifiedInTransaction'>,fence:TaskRunSubmissionFence):Promise<TaskRun>{
  return this.dispose(owner,input,runs,fence)
 }
 /** 不接受维护收据替代在线宿主；调用方必须持同安装锁并在assertCurrent复核退出证据。 */
 async disposeUnknownAfterMaintenance(owner:string,input:unknown,runs:Pick<TaskRunService,'readVerifiedInTransaction'>,fence:TaskRunSubmissionFence,audit:TaskRunMaintenanceAudit):Promise<TaskRun>{
  return this.dispose(owner,input,runs,fence,audit)
 }
 private async dispose(owner:string,input:unknown,runs:Pick<TaskRunService,'readVerifiedInTransaction'>,fence:TaskRunSubmissionFence,audit?:TaskRunMaintenanceAudit):Promise<TaskRun>{
  const command=taskInput(input,['requestId','runId','acknowledgeUnknown'])
  if(Object.keys(command).length!==3||!uuid(command.requestId)||!uuid(command.runId)||command.acknowledgeUnknown!==true||typeof fence?.assertCurrent!=='function')throw denied()
  if(audit)validateMaintenanceAudit(audit,command)
  fence.assertCurrent();const db=await this.pool.connect()
  try{
   await db.query('begin');const current=await this.current(db,owner,command.runId)
   const run=await runs.readVerifiedInTransaction(db,owner,current.id)
   if(!isDeepStrictEqual(fixed(run),{runId:fence.runId,sessionId:fence.sessionId,nativeRequestId:fence.nativeRequestId,inputSha256:fence.inputSha256}))throw denied()
   if(run.state==='submission_unknown'){
    if(run.submissionDisposition?.requestId!==command.requestId)throw denied()
    if(audit){const stored=(await db.query('select audit,disposition from teloa_task_run_maintenance_dispositions where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0];if(!stored||!isDeepStrictEqual(stored.audit,audit)||!isDeepStrictEqual(stored.disposition,run.submissionDisposition))throw denied()}
    fence.assertCurrent();await db.query('commit');return run
   }
   if(run.state!=='submitting'||run.evidence!==null||!run.stopRequestedAt)throw denied()
   const latest=await this.latest(db,owner,run)
   // 已发布但原 Run 回填丢失也可能停在 submitting；处置保留 accepted 审计，绝不改成未发布。
   if(latest&&latest.state!=='dispatching'&&latest.state!=='accepted')throw denied()
   const unpublished=await unpublishedOwners(db,owner,run)
   const owners=(await db.query("select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and kind='job' and payload->>'record'='owner'",[owner,run.id])).rows.filter(row=>!unpublished.includes(row.native_id))
   if(latest?latest.runtime_id!==fence.runtimeId:owners.length!==1)throw denied()
   if(owners.some(row=>row.session_id!==run.sessionId||row.payload.runtimeId!==fence.runtimeId||row.payload.requestId!==run.nativeRequestId))throw denied()
   // 没有外部结清证据时，不能把子级或后台活动藏进未知处置。
   for(const query of [
    "select 1 from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and state in ('reserved','started') limit 1",
    "select 1 from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2 and (kind<>'job' or payload->>'record'<>'owner') limit 1",
    "select 1 from teloa_task_run_flows where owner_id=$1 and run_id=$2 limit 1",
   ])if((await db.query(query,[owner,run.id])).rows.length)throw denied()
   const receipt=readTaskRunSubmissionDisposition({schema:'teloa.task-run-submission-disposition/v1',requestId:command.requestId,...fixed(run),runtimeId:fence.runtimeId,logCut:fence.logCut,logSha256:fence.logSha256,acknowledgedUnknown:true,closedAt:new Date().toISOString()})
   fence.assertCurrent()
   const stored=(await db.query('select task_state_version from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.id])).rows[0]
   await db.query("update teloa_tasks set state='paused',version=version+1,updated_at=$4 where owner_id=$1 and id=$2 and version=$3 and state='running'",[owner,run.taskId,stored.task_state_version,receipt.closedAt])
   await db.query("update teloa_task_runs set state='submission_unknown',submission_disposition=$3 where owner_id=$1 and id=$2",[owner,run.id,JSON.stringify(receipt)])
   if(audit)await db.query('insert into teloa_task_run_maintenance_dispositions(owner_id,run_id,request_id,install_id,audit,disposition) values($1,$2,$3,$4,$5,$6)',[owner,run.id,command.requestId,audit.installId,JSON.stringify(audit),JSON.stringify(receipt)])
   const saved=await runs.readVerifiedInTransaction(db,owner,run.id)
   fence.assertCurrent();await db.query('commit');return saved
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async current(db:Pick<PoolClient,'query'>,owner:string,runId:string,lock:'update'|'share'='update'):Promise<TaskRun>{
  if(typeof owner!=='string'||!owner||!uuid(runId))throw denied()
  const row=(await db.query(`select * from teloa_task_runs where owner_id=$1 and id=$2 for ${lock}`,[owner,runId])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','提交回执不属于本人。')
  return readStoredTaskRun(row)
 }
 private async latest(db:Pick<PoolClient,'query'>,owner:string,run:TaskRun){
  const row=(await db.query('select * from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt desc limit 1',[owner,run.id])).rows[0]
  if(row&&(row.session_id!==run.sessionId||row.native_request_id!==run.nativeRequestId||row.input_sha256!==fixed(run).inputSha256))throw denied()
  return row
 }
 async unpublishedOwnerIds(owner:string,runId:string):Promise<readonly string[]>{
  const db=await this.pool.connect()
  // 续报 prepare 已共享锁定原 Run；此纯读核对不得跨连接升级排他锁。共享锁仍阻止提交写入改变核对依据。
  try{await db.query('begin');const run=await this.current(db,owner,runId,'share'),ids=await unpublishedOwners(db,owner,run);await db.query('commit');return ids}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async recoverable(owner:string,run:TaskRun):Promise<boolean>{
  const db=await this.pool.connect()
  try{await db.query('begin');const current=await this.current(db,owner,run.id);if(!isDeepStrictEqual(fixed(current),fixed(run)))throw denied();const attempts=(await db.query('select * from teloa_task_run_submissions where owner_id=$1 and run_id=$2 order by attempt',[owner,run.id])).rows;await db.query('commit');return current.state==='submitting'&&current.evidence===null&&current.stopRequestedAt===null&&attempts.length>0&&attempts.every(row=>row.state==='not-published'&&row.settled_at instanceof Date&&row.session_id===run.sessionId&&row.native_request_id===run.nativeRequestId&&row.input_sha256===fixed(run).inputSha256&&uuid(row.runtime_id))}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async begin(owner:string,run:TaskRun,runtimeId:string):Promise<TaskRunSubmissionAttempt>{
  if(!uuid(runtimeId))throw denied()
  const db=await this.pool.connect()
  try{
   await db.query('begin');const current=await this.current(db,owner,run.id)
   if(current.state!=='submitting'||current.evidence!==null||current.stopRequestedAt!==null||!isDeepStrictEqual(fixed(current),fixed(run)))throw denied()
   const latest=await this.latest(db,owner,current)
   if(latest&&latest.state!=='not-published')throw denied()
   const ticket=Object.freeze({...fixed(current),attemptId:randomUUID(),runtimeId})
   await db.query("insert into teloa_task_run_submissions(owner_id,run_id,attempt,attempt_id,session_id,native_request_id,input_sha256,runtime_id,state) values($1,$2,$3,$4,$5,$6,$7,$8,'dispatching')",[owner,current.id,(latest?.attempt??0)+1,ticket.attemptId,current.sessionId,current.nativeRequestId,ticket.inputSha256,runtimeId])
   await db.query('commit');return ticket
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async finish(owner:string,ticket:TaskRunSubmissionAttempt,outcome:'accepted'|'not-published'):Promise<void>{
  if(!['accepted','not-published'].includes(outcome)||!uuid(ticket?.attemptId)||!uuid(ticket?.runtimeId))throw denied()
  const db=await this.pool.connect()
  try{
   await db.query('begin');const run=await this.current(db,owner,ticket.runId),latest=await this.latest(db,owner,run)
   if(['withdrawn','configuration_failed','submission_unknown'].includes(run.state)||!latest||!isDeepStrictEqual(ticket,{...fixed(run),attemptId:latest.attempt_id,runtimeId:latest.runtime_id})||latest.state!=='dispatching'&&latest.state!==outcome)throw denied()
   if(latest.state==='dispatching')await db.query('update teloa_task_run_submissions set state=$4,settled_at=now() where owner_id=$1 and run_id=$2 and attempt_id=$3',[owner,run.id,ticket.attemptId,outcome])
   await db.query('commit')
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
