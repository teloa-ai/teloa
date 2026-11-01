import type {Pool,PoolClient} from 'pg'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import {WorkError,businessObjectReference,readTaskRunSourceFollowup,readTaskRunSourceFollowupCandidate,readTaskRunSubmissionDisposition,type TaskRunSourceFollowup,type TaskRunSourceFollowupCandidate} from '@teloa/contract'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import {businessTaskSourceUpdateRunRequestId} from './business-task-source-updates.ts'
import type {TaskRun} from './task-runs.ts'

const evidenceHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex')
const denied=()=>new WorkError('teloa/conflict','原未知提交、告警来源或本次确认已变化，请回到原任务核对。')
async function assertBoundaries(db:PoolClient,owner:string,run:TaskRun):Promise<void>{
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

/** 独立确认引用原 update；绝不改绑其 run_id/task_version。 */
export async function sourceFollowupCandidate(db:PoolClient,owner:string,run:TaskRun,taskVersion:number):Promise<TaskRunSourceFollowupCandidate>{
 const unknown=run.state==='submission_unknown',completed=run.state==='ended'&&run.evidence?.state==='ended'&&run.evidence.reason==='completed'&&run.stopRequestedAt===null
 if(!unknown&&!completed||unknown&&(!run.submissionDisposition||!run.stopRequestedAt||run.evidence!==null)||run.executor||!run.roleSnapshot||!run.agentPresetId||run.sourceFollowup)throw denied()
 await assertBoundaries(db,owner,run)
 const updates=(await db.query('select * from teloa_business_task_source_updates where owner_id=$1 and task_id=$2 and run_id=$3 for share',[owner,run.taskId,run.id])).rows
 if(updates.length!==1)throw denied()
 const u=updates[0]!
 if((unknown?(u.state!=='needs-user'||u.reason!=='teloa/submission-unknown'):u.state!=='accepted')||u.task_version!==run.taskVersion||businessTaskSourceUpdateRunRequestId(owner,u.id)!==(await db.query('select request_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,run.id])).rows[0]?.request_id)throw denied()
 const reference=businessObjectReference({scope:u.scope_id,type:u.object_type,id:u.object_id,version:u.object_version,snapshotHash:u.snapshot_hash})
 const sources=(await db.query(`select s.* from teloa_business_task_sources s join teloa_plan_task_links l on l.owner_id=s.owner_id and l.task_id=s.task_id join teloa_plan_occurrences o on o.owner_id=l.owner_id and o.id=l.claim_id where s.owner_id=$1 and s.task_id=$2 and o.plan_id=$3`,[owner,run.taskId,u.plan_id])).rows
 if(sources.length!==1||sources[0].scope_id!==reference.scope||sources[0].object_type!==reference.type||sources[0].object_id!==reference.id||sources[0].object_version>=reference.version)throw denied()
 const context=JSON.parse(run.inputText).businessContext
 if(!context||!context.updates?.length||!isDeepStrictEqual(businessObjectReference(Object.fromEntries(Object.entries(context.updates.at(-1)).filter(([key])=>['scope','type','id','version','snapshotHash'].includes(key)))),reference))throw denied()
 if(!unknown&&(await db.query('select max(object_version) as version from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4',[owner,reference.scope,reference.type,reference.id])).rows[0]?.version!==reference.version)throw denied()
 return readTaskRunSourceFollowupCandidate({schema:'teloa.task-run-source-followup-candidate/v1',kind:unknown?'unknown-verification':'result-verification',originalNativeRequestId:run.nativeRequestId,originalInputSha256:createHash('sha256').update(run.inputText).digest('hex'),originalEvidenceSha256:unknown?null:evidenceHash(run.evidence),taskId:run.taskId,expectedTaskVersion:taskVersion,runId:run.id,sessionId:run.sessionId,...(unknown?{disposition:run.submissionDisposition}:{}),sourceUpdateId:u.id,sourceTaskVersion:u.task_version,sourceEventId:u.event_id,reference})
}
export async function exactSourceFollowupSnapshot(db:PoolClient,owner:string,f:TaskRunSourceFollowup){
 const rows=(await db.query(`select u.*,s.snapshot from teloa_business_task_source_updates u join teloa_business_object_snapshots s on s.owner_id=u.owner_id and s.scope_id=u.scope_id and s.object_type=u.object_type and s.object_id=u.object_id and s.object_version=u.object_version where u.owner_id=$1 and u.id=$2 for share of u,s`,[owner,f.sourceUpdateId])).rows
 if(rows.length!==1)throw denied();const row=rows[0]!,snapshot=readBusinessObjectSnapshot(row.snapshot,f.reference.scope)
 if((f.kind==='unknown-verification'?(row.state!=='needs-user'||row.reason!=='teloa/submission-unknown'):row.state!=='accepted')||row.task_id!==f.taskId||row.run_id!==f.originalRunId||row.task_version!==f.sourceTaskVersion||row.event_id!==f.sourceEventId||!isDeepStrictEqual(businessObjectReference({scope:row.scope_id,type:row.object_type,id:row.object_id,version:row.object_version,snapshotHash:row.snapshot_hash}),f.reference)||businessObjectSnapshotHash(snapshot)!==f.reference.snapshotHash)throw denied()
 return {...snapshot,snapshotHash:f.reference.snapshotHash}
}
export async function verifySourceFollowup(db:PoolClient,owner:string,run:TaskRun):Promise<Record<string,unknown>|null>{
 const f=run.sourceFollowup
 if(!f)return null
 const row=(await db.query('select * from teloa_task_run_source_followups where owner_id=$1 and run_id=$2 for share',[owner,run.id])).rows[0]
 if(!row||row.request_id!==f.requestId||row.original_run_id!==f.originalRunId||row.source_update_id!==f.sourceUpdateId||!isDeepStrictEqual(readTaskRunSourceFollowup(row.binding),f))throw denied()
 const original=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,f.originalRunId])).rows[0]
 if(!original||(f.kind==='unknown-verification'?(original.state!=='submission_unknown'||original.evidence!==null||!isDeepStrictEqual(readTaskRunSubmissionDisposition(original.submission_disposition),f.disposition)):(original.state!=='ended'||original.evidence?.reason!=='completed'||original.stop_requested_at!==null||evidenceHash(original.evidence)!==f.originalEvidenceSha256))||original.session_id!==f.sessionId||original.task_id!==f.taskId||original.role_id!==run.roleId||original.role_version!==run.roleVersion||original.agent_preset_id!==run.agentPresetId||createHash('sha256').update(original.input_text).digest('hex')!==f.originalInputSha256||original.native_request_id!==f.originalNativeRequestId||original.native_request_id===run.nativeRequestId)throw denied()
 const snapshot=await exactSourceFollowupSnapshot(db,owner,f),input=JSON.parse(run.inputText)
 if(!isDeepStrictEqual(input.businessContext?.updates,[snapshot]))throw denied()
 return original
}
export async function writeSourceFollowup(db:PoolClient,owner:string,run:TaskRun):Promise<void>{
 const f=run.sourceFollowup;if(!f)return
 await db.query('insert into teloa_task_run_source_followups(owner_id,request_id,run_id,original_run_id,source_update_id,binding,created_at) values($1,$2,$3,$4,$5,$6,$7)',[owner,f.requestId,run.id,f.originalRunId,f.sourceUpdateId,JSON.stringify(f),f.confirmedAt])
}
