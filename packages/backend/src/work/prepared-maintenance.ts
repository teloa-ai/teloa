import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readRunTextCapability,readRunAnalysisScope,groupWorkContinuationRunRequestId,type GroupTaskSource} from '@teloa/contract'
import {combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'
import {readStoredTaskRun} from './task-runs.ts'

export const preparedMaintenanceHash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item)).digest('hex')
const sha=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const denied=()=>new WorkError('teloa/conflict','原准备执行或维护证明已变化，保持暂停；不能重新创建或自动派发。')
export type PreparedMaintenanceAudit={schema:'teloa.prepared-maintenance/v1';requestId:string;installId:string;ownerId:string;runId:string;taskId:string;sessionId:string;nativeRequestId:string;inputSha256:string;runtimeId:string|null;sourceVersion:string;targetVersion:string;pauseRequestId:string;controlId:string;controlGeneration:number;nativeSnapshotSha256:string;nativeFileSha256:string;processReceiptSha256:string;backupManifestSha256:string}
export type PreparedMaintenancePrevious={requestId:string;auditSha256:string}
function audit(value:unknown):PreparedMaintenanceAudit{
 const row=taskInput(value,['schema','requestId','installId','ownerId','runId','taskId','sessionId','nativeRequestId','inputSha256','runtimeId','sourceVersion','targetVersion','pauseRequestId','controlId','controlGeneration','nativeSnapshotSha256','nativeFileSha256','processReceiptSha256','backupManifestSha256'])
 if(row.schema!=='teloa.prepared-maintenance/v1'||!['requestId','installId','runId','taskId','nativeRequestId','pauseRequestId','controlId'].every(key=>uuid(row[key]))||row.runtimeId!==null&&!uuid(row.runtimeId)||typeof row.ownerId!=='string'||!row.ownerId||typeof row.sessionId!=='string'||!row.sessionId||!['inputSha256','nativeSnapshotSha256','nativeFileSha256','processReceiptSha256','backupManifestSha256'].every(key=>sha(row[key]))||!Number.isSafeInteger(row.controlGeneration)||Number(row.controlGeneration)<1||!['sourceVersion','targetVersion'].every(key=>typeof row[key]==='string'&&/^\d+\.\d+\.\d+$/.test(String(row[key]))))throw denied()
 return row as PreparedMaintenanceAudit
}
export async function initializePreparedMaintenance(pool:Pool):Promise<void>{await pool.query(`create table if not exists teloa_prepared_run_maintenance(
 owner_id text not null,run_id uuid not null,request_id uuid not null,audit jsonb not null,resume jsonb,dispatch jsonb,created_at timestamptz not null,
 primary key(owner_id,run_id),unique(owner_id,request_id),foreign key(owner_id,run_id) references teloa_task_runs(owner_id,id)
 );
 create table if not exists teloa_prepared_run_maintenance_cycles(
  owner_id text not null,run_id uuid not null,request_id uuid not null,previous_request_id uuid not null,previous_audit_sha256 text not null check(previous_audit_sha256~'^[a-f0-9]{64}$'),
  audit jsonb not null,dispatch jsonb,created_at timestamptz not null,
  primary key(owner_id,request_id),unique(owner_id,run_id,previous_request_id),
  foreign key(owner_id,run_id) references teloa_prepared_run_maintenance(owner_id,run_id)
 )`)}
async function available(db:PoolClient):Promise<boolean>{return typeof(await db.query("select to_regclass('teloa_prepared_run_maintenance') as name")).rows[0]?.name==='string'}
function continuesAudit(previous:PreparedMaintenanceAudit,next:PreparedMaintenanceAudit):boolean{
 const fixed=(a:PreparedMaintenanceAudit)=>{const {requestId,sourceVersion,targetVersion,processReceiptSha256,backupManifestSha256,...rest}=a;return rest}
 return previous.requestId!==next.requestId&&next.sourceVersion===previous.targetVersion&&next.sourceVersion!==next.targetVersion&&isDeepStrictEqual(fixed(previous),fixed(next))
}
/** 原审计保持不变；后续只接受无分叉、摘要相接且仍冻结同一Run/暂停/原生输入的追加链。旧数据没有追加表时只读原记录。 */
export async function readPreparedMaintenance(db:PoolClient,owner:string,runId:string,lock=false){
 if(!await available(db))return undefined
 const root=(await db.query('select * from teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2'+(lock?' for update':''),[owner,runId])).rows[0]
 if(!root)return undefined
 let current=audit(root.audit),requestId=root.request_id,dispatch=root.dispatch
 if(current.ownerId!==owner||current.runId!==runId||current.requestId!==requestId)throw denied()
 if((await db.query("select to_regclass('teloa_prepared_run_maintenance_cycles') as name")).rows[0]?.name){
  const rows=(await db.query('select * from teloa_prepared_run_maintenance_cycles where owner_id=$1 and run_id=$2',[owner,runId])).rows,pending=new Map<string,typeof rows[number]>(),seen=new Set<string>([requestId])
  for(const row of rows){if(pending.has(row.previous_request_id))throw denied();pending.set(row.previous_request_id,row)}
  while(pending.has(requestId)){
   const row=pending.get(requestId)!,next=audit(row.audit);pending.delete(requestId)
   if(seen.has(row.request_id)||row.request_id!==next.requestId||row.previous_audit_sha256!==preparedMaintenanceHash(current)||!continuesAudit(current,next)||preparedMaintenanceHash(row.dispatch)!==preparedMaintenanceHash(dispatch))throw denied()
   seen.add(row.request_id);current=next;requestId=row.request_id;dispatch=row.dispatch
  }
  if(pending.size)throw denied()
 }
 return {...root,root_request_id:root.request_id,request_id:requestId,audit:current,dispatch}
}
export async function hasPreparedMaintenance(db:PoolClient,owner:string,runId:string):Promise<boolean>{return await available(db)&&(await db.query('select 1 from teloa_prepared_run_maintenance where owner_id=$1 and run_id=$2',[owner,runId])).rows.length===1}
async function recoveryRun(db:PoolClient,owner:string,row:Record<string,unknown>){
 if(row.resume!==null)return null
 const a=audit(row.audit),raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,row.run_id])).rows[0]
 if(!raw||raw.state!=='prepared'||raw.evidence!==null||raw.stop_requested_at!==null)return null
 const run=readStoredTaskRun(raw)
 if(a.ownerId!==owner||a.runId!==run.id||row.request_id!==a.requestId||run.taskId!==a.taskId||run.sessionId!==a.sessionId||run.nativeRequestId!==a.nativeRequestId||digestInput(run.inputText)!==a.inputSha256||run.lineage?.roundControlId!==a.controlId||run.lineage.definitionControlId!==null)return null
 return {a,raw,run}
}
async function recoveryControl(db:PoolClient,owner:string,a:PreparedMaintenanceAudit):Promise<string|null>{
 const control=(await db.query('select state,generation,pause_origin from teloa_work_controls where owner_id=$1 and id=$2',[owner,a.controlId])).rows[0],progress=(await db.query('select generation,pending_run_ids,unknown_operation_ids from teloa_work_control_progress where owner_id=$1 and control_id=$2',[owner,a.controlId])).rows[0],pause=(await db.query('select spec,result from teloa_work_control_requests where owner_id=$1 and request_id=$2',[owner,a.pauseRequestId])).rows[0]
 if(control?.state!=='paused'||control.generation!==a.controlGeneration||control.pause_origin!=='owner'||progress?.generation!==a.controlGeneration||progress.pending_run_ids.length||progress.unknown_operation_ids.length||pause?.spec?.controlId!==a.controlId||pause.spec.action!=='pause'||pause.spec.scope!=='round'||pause.spec.roundControlId!==null||pause.result?.state!=='pausing'||pause.result.generation!==a.controlGeneration)return null
 return a.controlId
}
/** 状态页只展示具名保全的原投递恢复入口；不授予恢复、不修改原投递或控制。 */
export async function preparedMaintenanceRecoveryControl(db:PoolClient,owner:string,outbox:Record<string,unknown>):Promise<string|null>{
 if(outbox.owner_id!==owner||outbox.state!=='blocked'||outbox.execution_mode!=='work'||!uuid(outbox.run_id)||!await available(db))return null
 const row=await readPreparedMaintenance(db,owner,outbox.run_id)
 if(!row||row.resume!==null||row.dispatch===null||preparedMaintenanceHash(row.dispatch)!==preparedMaintenanceHash(outbox))return null
 const original=await recoveryRun(db,owner,row);if(!original)return null
 const {a,raw,run}=original,context=run.groupContext
 if(run.taskId!==outbox.task_id||run.roleId!==outbox.role_id||raw.request_id!==outbox.request_id||!context||context.groupId!==outbox.group_id||context.source.messageId!==outbox.message_id)return null
 return recoveryControl(db,owner,a)
}
/** 手动工作没有投递行；调用方先验证来源摘要，再核对原维护审计和当前负责人最新 Run。 */
export async function preparedMaintenanceManualRecoveryControl(db:PoolClient,owner:string,source:GroupTaskSource,runId:string):Promise<string|null>{
 if(source.ownerId!==owner||source.trigger!=='manual'||!uuid(runId)||!await available(db))return null
 const row=await readPreparedMaintenance(db,owner,runId)
 if(!row||row.dispatch!==null)return null
 const original=await recoveryRun(db,owner,row);if(!original)return null
 const {a,run}=original,context=run.groupContext
 if(run.taskId!==source.taskId||!context||context.groupId!==source.groupId||context.source.messageId!==source.messageId||context.source.rootId!==source.rootId||context.source.createdAt!==source.messageCreatedAt||context.source.text!==source.messageText)return null
 const latest=(await db.query(`select r.id from teloa_task_runs r join teloa_tasks t on t.owner_id=r.owner_id and t.id=r.task_id
  where r.owner_id=$1 and r.task_id=$2 and t.state<>'cancelled' and r.role_id=t.assignee_role_id and r.role_version=t.assignee_role_version
  order by r.created_at desc,r.id desc limit 1`,[owner,source.taskId])).rows[0]
 if(latest?.id!==runId)return null
 return recoveryControl(db,owner,a)
}
async function original(db:PoolClient,owner:string,a:PreparedMaintenanceAudit,starting=false){
 const row=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,a.runId])).rows[0]
 if(!row)throw denied()
 const run=readStoredTaskRun(row)
 if(owner!==a.ownerId||run.id!==a.runId||run.taskId!==a.taskId||run.sessionId!==a.sessionId||run.nativeRequestId!==a.nativeRequestId||!(starting?['prepared','submitting','accepted','active'].includes(run.state):run.state==='prepared')||!starting&&run.evidence!==null||run.stopRequestedAt!==null||createHash('sha256').update(run.inputText).digest('hex')!==a.inputSha256||run.lineage?.roundControlId!==a.controlId||run.lineage.definitionControlId!==null)throw denied()
 return run
}
/** 仅具名 CLI 在认证旧宿主退出、完整原生冷读和同安装专用备份之后调用，不注册 RPC。 */
export async function preservePreparedRun(pool:Pool,value:PreparedMaintenanceAudit,proof:WorkAccessLease,now:string,previous?:PreparedMaintenancePrevious):Promise<void>{
 const a=audit(value);proof=combineWorkAccessLeases([proof]);proof.assertCurrent()
 const db=await pool.connect();try{
  await db.query('begin');const prior=await readPreparedMaintenance(db,a.ownerId,a.runId,true),run=await original(db,a.ownerId,a)
  if(prior&&prior.resume!==null)throw denied()
  const repeated=!!prior&&isDeepStrictEqual(prior.audit,a)
  if(!prior&&previous!==undefined||prior&&!repeated&&(!previous||previous.requestId!==prior.request_id||previous.auditSha256!==preparedMaintenanceHash(prior.audit)||!continuesAudit(audit(prior.audit),a)))throw denied()
  const pause=(await db.query('select spec,result from teloa_work_control_requests where owner_id=$1 and request_id=$2',[a.ownerId,a.pauseRequestId])).rows[0]
  const control=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2 for update',[a.ownerId,a.controlId])).rows[0]
  const progress=(await db.query('select * from teloa_work_control_progress where owner_id=$1 and control_id=$2',[a.ownerId,a.controlId])).rows[0]
  if(!pause||pause.spec?.controlId!==a.controlId||pause.spec.action!=='pause'||pause.spec.scope!=='round'||pause.spec.roundControlId!==null||pause.result?.generation!==a.controlGeneration||pause.result.state!=='pausing'||!control||!['pausing','paused'].includes(control.state)||control.generation!==a.controlGeneration||control.pause_origin!=='owner'||!progress||progress.generation!==a.controlGeneration||progress.pending_run_ids.some((id:string)=>id!==run.id)||progress.unknown_operation_ids.some((id:string)=>id!=='runtime-owner:'+run.id))throw denied()
  const links=(await db.query('select * from teloa_task_run_runtime_links where owner_id=$1 and run_id=$2',[a.ownerId,a.runId])).rows
  // check 在 claim 前失败时从未登记 runtime owner；不得为满足维护而给 prepared 补造关联。
  if(a.runtimeId===null?links.length!==0:links.length!==1||links[0].kind!=='job'||links[0].payload?.record!=='owner'||links[0].session_id!==a.sessionId||links[0].payload.runtimeId!==a.runtimeId||links[0].payload.requestId!==a.nativeRequestId||links[0].native_id!=='owner:'+a.runtimeId+':'+a.sessionId)throw denied()
  // 旧 owner 足迹保持历史原件；独立维护审计证明其进程世代已退出，不伪造 Run 受理或原生终态。
  const hasOutbox=(await db.query("select to_regclass('teloa_group_routing_outbox') as name")).rows[0]?.name
  const dispatches=hasOutbox?(await db.query('select o.* from teloa_group_routing_outbox o join teloa_task_runs r on r.owner_id=o.owner_id and r.request_id=o.request_id where r.owner_id=$1 and r.id=$2 for share of o',[a.ownerId,a.runId])).rows:[]
  if(dispatches.length>1||run.textCapability&&(dispatches.length!==1||dispatches[0].task_id!==a.taskId||dispatches[0].run_id!==null&&dispatches[0].run_id!==a.runId||dispatches[0].state!=='blocked'))throw denied()
  const dispatch=dispatches[0]??null
  if(prior){
   if(control.state!=='paused'||progress.pending_run_ids.length||progress.unknown_operation_ids.length||preparedMaintenanceHash(dispatch)!==preparedMaintenanceHash(prior.dispatch))throw denied()
   if(repeated){proof.assertCurrent();await db.query('commit');return}
   if((await db.query('select 1 from teloa_prepared_run_maintenance where owner_id=$1 and request_id=$2',[a.ownerId,a.requestId])).rows.length)throw denied()
   await db.query('insert into teloa_prepared_run_maintenance_cycles(owner_id,run_id,request_id,previous_request_id,previous_audit_sha256,audit,dispatch,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[a.ownerId,a.runId,a.requestId,prior.request_id,previous!.auditSha256,JSON.stringify(a),dispatch?JSON.stringify(dispatch):null,now])
  }else await db.query('insert into teloa_prepared_run_maintenance(owner_id,run_id,request_id,audit,dispatch,created_at) values($1,$2,$3,$4,$5,$6)',[a.ownerId,a.runId,a.requestId,JSON.stringify(a),dispatch?JSON.stringify(dispatch):null,now])
  if(control.state==='pausing')await db.query("update teloa_work_controls set state='paused',version=version+1,updated_at=$3 where owner_id=$1 and id=$2",[a.ownerId,a.controlId,now])
  await db.query("update teloa_work_control_progress set pending_run_ids='{}',unknown_operation_ids='{}' where owner_id=$1 and control_id=$2 and generation=$3",[a.ownerId,a.controlId,a.controlGeneration])
  proof.assertCurrent();await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
}
/** 复用既有本人整项恢复的 seal、角色/资料/预算复核；自动计划恢复不得认领维护 Run。 */
export async function resumePreparedMaintenance(db:PoolClient,owner:string,input:{runId:string;requestId:string;hostGeneration:number;checkpointSha256:string;automatic:boolean},seal:WorkAccessLease):Promise<void>{
 if(!await available(db))return
 const row=await readPreparedMaintenance(db,owner,input.runId,true);if(!row)return
 const a=audit(row.audit),run=await original(db,owner,a)
 if(input.automatic||row.resume!==null||input.checkpointSha256!==a.nativeSnapshotSha256||!uuid(input.requestId)||!Number.isSafeInteger(input.hostGeneration)||input.hostGeneration<1)throw denied()
 const controls=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,a.controlId])).rows
 if(controls.length!==1||controls[0].state!=='active'||controls[0].generation!==a.controlGeneration+1)throw denied()
 seal.assertCurrent();await db.query('update teloa_prepared_run_maintenance set resume=$3 where owner_id=$1 and run_id=$2',[owner,run.id,JSON.stringify({requestId:input.requestId,maintenanceRequestId:a.requestId,hostGeneration:input.hostGeneration,controls,inputSha256:a.inputSha256,textCapabilitySha256:run.textCapability?preparedMaintenanceHash(run.textCapability):null,...(run.analysisScope?{analysisScopeSha256:preparedMaintenanceHash(run.analysisScope)}:{})})])
}
/** 仅原 Run 在本人显式恢复后使用的新控制许可；不改写旧 capability 或其原审批历史。 */
export async function preparedMaintenanceControlsCurrent(db:PoolClient,owner:string,runId:string|undefined,capability:unknown,current:unknown,trustedContinuation=false):Promise<boolean>{
 if(!await available(db))return false
 const analysis=typeof capability==='object'&&capability!==null&&'schema' in capability&&capability.schema==='teloa.run-analysis-scope/v1'
 const cap=analysis?readRunAnalysisScope(capability):readRunTextCapability(capability)
 const rows=(await db.query("select * from teloa_prepared_run_maintenance where owner_id=$1 and audit->>'taskId'=$2",[owner,cap.taskId])).rows
 if(rows.length!==1||!rows[0].resume)return false
 const row=await readPreparedMaintenance(db,owner,String(rows[0].run_id));if(!row)return false
 const a=audit(row.audit),r=row.resume,raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,a.runId])).rows[0]
 if(row.root_request_id!==a.requestId&&r.maintenanceRequestId!==a.requestId)return false
 if(!raw)return false
 const originalRun=readStoredTaskRun(raw),host=(await db.query('select generation from teloa_work_control_hosts where owner_id=$1',[owner])).rows[0]
 const originalCapability=analysis?originalRun.analysisScope:originalRun.textCapability,fingerprint=analysis?r.analysisScopeSha256:r.textCapabilitySha256
 if(!originalCapability||!sha(fingerprint)||host?.generation!==r.hostGeneration||digestInput(originalRun.inputText)!==a.inputSha256||r.inputSha256!==a.inputSha256||preparedMaintenanceHash(originalCapability)!==fingerprint||!isDeepStrictEqual(current,r.controls))return false
 // 原Run的scope全等；后继只允许正式本人反馈使任务版本与固定上下文变化，其他来源/角色/文件/控制仍逐字固定。
 const continuedAnalysis=analysis&&runId!==a.runId
 const fixed={...cap,taskVersion:originalCapability.taskVersion,...(continuedAnalysis?{contextSha256:originalRun.analysisScope!.contextSha256}:{})}
 if(preparedMaintenanceHash(fixed)!==fingerprint)return false
 // 新控制许可必须仍有既有本人恢复的原受理回执及精确原 Run 票据，不能凭孤立 json 恢复旧能力。
 if(!uuid(r.requestId))return false
 const receipt=(await db.query('select * from teloa_work_recovery_requests where owner_id=$1 and request_id=$2',[owner,r.requestId])).rows[0],ticket=(await db.query('select * from teloa_work_recovery_tickets where owner_id=$1 and request_id=$2 and run_id=$3',[owner,r.requestId,a.runId])).rows[0]
 if(!receipt||receipt.control_id!==a.controlId||receipt.spec?.controlId!==a.controlId||!isDeepStrictEqual(receipt.spec.candidateRunIds,[a.runId])||receipt.result?.id!==a.controlId||receipt.result.state!=='active'||receipt.result.generation!==a.controlGeneration+1||!ticket||ticket.host_generation!==r.hostGeneration||ticket.checkpoint_sha256!==a.nativeSnapshotSha256||ticket.candidate?.reason!=='unaccepted'||ticket.candidate.runId!==a.runId||ticket.candidate.controlId!==a.controlId||ticket.candidate.expectedGeneration!==a.controlGeneration+1||ticket.candidate.nativeRequestId!==a.nativeRequestId)return false
 if(runId===a.runId)return ['prepared','submitting','accepted','active'].includes(originalRun.state)&&originalRun.stopRequestedAt===null&&cap.taskVersion===originalRun.taskVersion
 // 后继只接受正式本人同 Task 的继续记录；不是给任意新 Run 或自动化复用旧能力。
 if(!trustedContinuation&&!runId||originalRun.state!=='ended'||originalRun.evidence?.state!=='ended'||originalRun.evidence.reason!=='completed'||cap.taskVersion<=originalRun.taskVersion)return false
 const continuedRaw=runId?(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,runId])).rows[0]:undefined
 const continued=continuedRaw?readStoredTaskRun(continuedRaw):undefined,feedback=continued?JSON.parse(continued.inputText).groupContinuation:undefined
 if(runId&&(!continued||continued.taskId!==cap.taskId||continued.taskVersion!==cap.taskVersion||continued.stopRequestedAt!==null||!['prepared','submitting','accepted','active'].includes(continued.state)||!feedback))return false
 if(analysis&&continued&&(!continued.analysisScope||preparedMaintenanceHash(continued.analysisScope)!==preparedMaintenanceHash(cap)))return false
 const ledger=(await db.query("select i.*,m.text,m.author_id from teloa_group_work_inputs i join teloa_group_messages m on m.owner_id=i.owner_id and m.group_id=i.group_id and m.id=i.message_id where i.owner_id=$1 and i.task_id=$2 and i.task_version=$3 and i.operation='continue' and i.state in ('continued','accepted','unknown') and i.group_id=$4",[owner,cap.taskId,cap.taskVersion,cap.groupId])).rows
 return ledger.length===1&&ledger[0].author_id==='self'&&(!continuedRaw||ledger[0].message_id===feedback.messageId&&ledger[0].text===feedback.text&&groupWorkContinuationRunRequestId(owner,ledger[0].request_id)===continuedRaw.request_id)
}
const digestInput=(input:string)=>createHash('sha256').update(input).digest('hex')
