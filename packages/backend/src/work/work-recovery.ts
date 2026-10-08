import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readRecoveryCandidate,readGoalRunBinding,readWorkControl,type RecoveryCandidate,type WorkControl} from '@teloa/contract'
import {WorkControlService} from './work-control.ts'
import {WorkLineageService} from './work-lineage.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'
import {readRunRoleSnapshot} from './run-role-snapshot.ts'
import {roleWorkOwner,roleWorkTransaction} from './twin-execution-consents.ts'
import {combineWorkAccessLeases,workAccess,type WorkAccessLease} from './work-access.ts'

export type WorkResumeInput={requestId:string;controlId:string;expectedVersion:number;candidateRunIds:string[]}
export type WorkRecoveryCheckpoint={reason:RecoveryCandidate['reason'];checkpointSha256:string;hasPendingInput:boolean;unknownOperationIds:string[]}
export type WorkRecoveryPorts={hostGeneration:()=>number;ownerAuthority?:{authorize:(owner:string,request:Readonly<WorkResumeInput>)=>Promise<WorkAccessLease>};inspectCheckpoint?:(owner:string,input:{runId:string;sessionId:string;nativeRequestId:string},db?:PoolClient)=>Promise<WorkRecoveryCheckpoint>;/** 当前真实预算/权益准入；缺席拒绝恢复。 */authorizeResume?:(db:PoolClient,owner:string,input:{candidate:RecoveryCandidate;hostGeneration:number})=>Promise<WorkAccessLease>}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const sha=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v)
const forbidden=()=>new WorkError('teloa/forbidden','需要本人复核当前角色、授权、预算和恢复许可。')
const conflict=()=>new WorkError('teloa/version-conflict','恢复候选、检查点或宿主世代已变化。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','工作恢复记录不完整。')
const invalid=()=>new WorkError('teloa/invalid-input','恢复请求不正确或包含未知字段。')

export async function initializeWorkRecovery(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_work_recovery_requests(
  owner_id text not null,request_id uuid not null,control_id uuid not null,spec jsonb not null,result jsonb not null,created_at timestamptz not null,
  primary key(owner_id,request_id),foreign key(owner_id,control_id) references teloa_work_controls(owner_id,id)
 );
 create table if not exists teloa_work_recovery_tickets(
  owner_id text not null,request_id uuid not null,run_id uuid not null,candidate jsonb not null,checkpoint_sha256 text not null check(checkpoint_sha256 ~ '^[a-f0-9]{64}$'),host_generation integer not null check(host_generation>0),
  state text not null check(state in ('reserved','applying','applied','unknown')),created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,request_id,run_id),foreign key(owner_id,request_id) references teloa_work_recovery_requests(owner_id,request_id),foreign key(run_id) references teloa_task_runs(id)
 );
`)}

/** 候选来自部署拥有者的真实 checkpoint。读候选不授予执行；恢复不回写原 Run input/lineage。 */
export class WorkRecoveryService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly controls:WorkControlService;readonly ports:WorkRecoveryPorts
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},controls:WorkControlService,ports:WorkRecoveryPorts){this.pool=pool;this.identity=identity;this.controls=controls;this.ports=ports}
 private async checkpoint(owner:string,run:any,db?:PoolClient):Promise<WorkRecoveryCheckpoint>{
  let value:WorkRecoveryCheckpoint|undefined
  try{value=await this.ports.inspectCheckpoint?.(owner,{runId:run.id,sessionId:run.session_id,nativeRequestId:run.native_request_id},db)}catch{}
  if(!value||!sha(value.checkpointSha256)||!['unaccepted','accepted','unknown'].includes(value.reason)||typeof value.hasPendingInput!=='boolean'||!Array.isArray(value.unknownOperationIds)||value.unknownOperationIds.some(id=>typeof id!=='string'||!id.trim()||id.length>512||/[\x00-\x1f]/.test(id)))return {reason:'unknown',checkpointSha256:'0'.repeat(64),hasPendingInput:false,unknownOperationIds:['checkpoint:unavailable']}
  if(value.unknownOperationIds.length||value.reason==='unaccepted'&&!['prepared','submitting'].includes(run.state)||value.reason==='accepted'&&!['accepted','active'].includes(run.state))return {...value,reason:'unknown'}
  return value
 }
 private async authorization(db:PoolClient,owner:string,run:any):Promise<{lease:WorkAccessLease;safeRecovery:boolean}>{
  let snapshot:any
  try{snapshot=JSON.parse(run.input_text);if(snapshot.schema!=='teloa.task-run-input/v2')throw Error();snapshot.role=readRunRoleSnapshot(snapshot.role)}catch{throw new WorkError('teloa/conflict','旧执行缺少完整职责和执行授权，需要本人建立新工作。')}
  const task=(await db.query('select definition,assignee_role_id from teloa_tasks where owner_id=$1 and id=$2',[owner,run.task_id])).rows[0]
  if(!task||task.assignee_role_id!==run.role_id)throw forbidden()
  const admission=await new RoleWorkEligibilityService(this.pool).authorize(owner,{roleId:run.role_id,expectedRoleVersion:run.role_version,scope:task.definition.scope,inputSchema:'teloa.task-run-input/v2',authorization:snapshot.role.authorization,groupId:snapshot.groupContext?.groupId??task.definition.groupId??null},db)
  if(!isDeepStrictEqual(admission.snapshot.authorization,snapshot.role.authorization)||!isDeepStrictEqual(admission.snapshot.twinConsent,snapshot.role.twinConsent)||admission.limits.allowedTools!==null&&(run.allowed_tools??[]).some((name:string)=>!admission.limits.allowedTools!.includes(name)))throw forbidden()
  const current=(await db.query('select state,stop_requested_at from teloa_task_runs where owner_id=$1 and id=$2 for share',[owner,run.id])).rows[0]
  if(!current||!['prepared','submitting','accepted','active'].includes(current.state)||current.stop_requested_at!==null)throw forbidden()
  let safeRecovery=false
  if(snapshot.role.authorization.kind==='delegation'){
   const row=(await db.query("select fields from teloa_role_work_delegations where owner_id=$1 and id=$2 and version=$3 and role_version=$4 and state='active'",[owner,snapshot.role.authorization.delegationId,snapshot.role.authorization.delegationVersion,run.role_version])).rows[0]
   safeRecovery=row?.fields?.safeRecovery===true
  }
  return {lease:{assertCurrent:admission.assertCurrent},safeRecovery}
 }
 private async candidates(owner:string,controlId:string,db?:PoolClient){
  const lineageService=new WorkLineageService(this.pool,this.identity),control=db?await this.controls.getInTransaction(db,owner,{controlId}):await this.controls.get(owner,{controlId}),{runIds}=db?await lineageService.descendantsInTransaction(db,owner,{controlId}):await lineageService.descendants(owner,{controlId}),results:Array<{candidate:RecoveryCandidate;checkpoint:WorkRecoveryCheckpoint;run:any}>=[]
  for(const runId of runIds){
   const run=(await (db??this.pool).query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,runId])).rows[0]
   if(!run||!['prepared','submitting','accepted','active'].includes(run.state)||run.stop_requested_at!==null)continue
   const round=(await (db??this.pool).query('select round_control_id from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,run.task_id])).rows[0]
   if(!round)throw corrupt()
   const roundControl=db?await this.controls.getInTransaction(db,owner,{controlId:round.round_control_id}):await this.controls.get(owner,{controlId:round.round_control_id})
   if(['stopping','stopped'].includes(roundControl.state))continue
   const checkpoint=await this.checkpoint(owner,run,db);let goal=null
   if((await (db??this.pool).query("select to_regclass('teloa_task_run_goals') as relation")).rows[0]?.relation){const row=(await (db??this.pool).query('select binding from teloa_task_run_goals where owner_id=$1 and run_id=$2',[owner,run.id])).rows[0];if(row)try{goal=readGoalRunBinding(row.binding);if(goal.ownerId!==owner||goal.runId!==run.id||goal.sessionId!==run.session_id||goal.controlId!==round.round_control_id)throw Error()}catch{throw corrupt()}}
   let safeRecovery=false
   try{safeRecovery=db?(await this.authorization(db,owner,run)).safeRecovery:await roleWorkTransaction(this.pool,async c=>(await this.authorization(c,owner,run)).safeRecovery)}catch{}
   const resumable=checkpoint.reason==='unaccepted'&&run.state==='prepared'||checkpoint.reason==='accepted'&&(checkpoint.hasPendingInput||goal!==null)
   const candidate=readRecoveryCandidate({controlId,expectedGeneration:control.generation,runId:run.id,nativeRequestId:run.native_request_id,goal,reason:checkpoint.reason,safeRecovery:safeRecovery&&resumable&&!checkpoint.unknownOperationIds.length})
   results.push({candidate,checkpoint,run})
  }
  return {control,results}
 }
 async inspect(owner:string,value:{controlId:string}):Promise<RecoveryCandidate[]>{roleWorkOwner(owner);const a=taskInput(value,['controlId']);if(!uuid(a.controlId))throw invalid();return (await this.candidates(owner,a.controlId)).results.map(r=>r.candidate)}
 async resume(owner:string,value:WorkResumeInput):Promise<WorkControl>{
  roleWorkOwner(owner);const a=taskInput(value,['requestId','controlId','expectedVersion','candidateRunIds'])
  if(!uuid(a.requestId)||!uuid(a.controlId)||!positive(a.expectedVersion)||!Array.isArray(a.candidateRunIds)||a.candidateRunIds.some(id=>!uuid(id))||new Set(a.candidateRunIds).size!==a.candidateRunIds.length)throw invalid()
  const request={requestId:a.requestId,controlId:a.controlId,expectedVersion:a.expectedVersion,candidateRunIds:[...a.candidateRunIds].sort()} as WorkResumeInput
  // seal 必须在读取候选和任何写操作前完成，恢复工具不能自报本人批准。
  if(typeof this.ports.ownerAuthority?.authorize!=='function')throw forbidden()
  const ownerLease=await this.ports.ownerAuthority.authorize(owner,Object.freeze({...request,candidateRunIds:Object.freeze([...request.candidateRunIds]) as unknown as string[]}))
  if(typeof ownerLease?.assertCurrent!=='function')throw forbidden()
  const seal=combineWorkAccessLeases([ownerLease,await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:null,objectId:request.controlId,operation:'resume'})]);seal.assertCurrent()
  const host=this.ports.hostGeneration();if(!positive(host))throw forbidden()
  const result=await roleWorkTransaction(this.pool,async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-recovery-request',owner,request.requestId])])
   const prior=(await db.query('select spec,result from teloa_work_recovery_requests where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0]
   if(prior){if(!isDeepStrictEqual(prior.spec,request))throw new WorkError('teloa/conflict','恢复请求身份已用于不同候选。');try{return {control:readWorkControl(prior.result),changed:false}}catch{throw corrupt()}}
   const {control,results}=await this.candidates(owner,request.controlId,db)
   if(control.version!==request.expectedVersion)throw conflict()
   if(!isDeepStrictEqual(results.map(r=>r.candidate.runId).sort(),request.candidateRunIds))throw conflict()
   if(results.some(r=>r.checkpoint.reason==='unknown'||r.checkpoint.unknownOperationIds.length))throw new WorkError('teloa/execution-pending','外部受理或检查点结果未知，请先核对，不能重放。')
   if(!this.ports.authorizeResume)throw new WorkError('teloa/unavailable','真实恢复预算与宿主准入尚未装配。')
   const leases=[seal]
   for(const {candidate,run,checkpoint} of results){
    if(candidate.reason==='accepted'&&!checkpoint.hasPendingInput&&!candidate.goal)throw new WorkError('teloa/conflict','已受理执行没有可核验的待办或 Goal，不能重放原请求。')
    leases.push((await this.authorization(db,owner,run)).lease,await this.ports.authorizeResume(db,owner,{candidate,hostGeneration:host}))
   }
   const approval=combineWorkAccessLeases(leases);approval.assertCurrent();if(host!==this.ports.hostGeneration())throw conflict()
   const roundIds=control.scope==='definition'?results.map(r=>r.run.task_id):[],rounds=roundIds.length?(await db.query('select distinct round_control_id from teloa_task_work_lineage where owner_id=$1 and task_id=any($2::uuid[])',[owner,roundIds])).rows.map(row=>row.round_control_id as string):[]
   // 与准入同序锁全部控制；整项恢复只包含本次本人明确列出的、已结清暂停的 round。
   await db.query('select id from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) order by id for update',[owner,[control.id,...rounds]])
   for(const id of [...new Set(rounds)].sort()){
    const child=await this.controls.getInTransaction(db,owner,{controlId:id})
    if(child.state==='paused')await this.controls.resumeInTransaction(db,owner,{controlId:id,expectedVersion:child.version},approval)
    else if(child.state!=='active')throw new WorkError('teloa/conflict','所属本轮尚未结清或已停止，不能整项恢复。')
   }
   const active=await this.controls.resumeInTransaction(db,owner,{controlId:control.id,expectedVersion:control.version},approval)
   await db.query('insert into teloa_work_recovery_requests(owner_id,request_id,control_id,spec,result,created_at) values($1,$2,$3,$4,$5,$6)',[owner,request.requestId,control.id,JSON.stringify(request),JSON.stringify(active),this.identity.now()])
   for(const {candidate,checkpoint} of results)await db.query("insert into teloa_work_recovery_tickets(owner_id,request_id,run_id,candidate,checkpoint_sha256,host_generation,state,created_at,updated_at) values($1,$2,$3,$4,$5,$6,'reserved',$7,$7)",[owner,request.requestId,candidate.runId,JSON.stringify({...candidate,expectedGeneration:active.generation}),checkpoint.checkpointSha256,host,this.identity.now()])
   return {control:active,changed:true}
  })
  if(result.changed)await this.controls.publishResume(owner,result.control)
  return result.control
 }
 async acquire(owner:string,value:{requestId:string;runId:string}):Promise<{candidate:RecoveryCandidate;checkpointSha256:string;hostGeneration:number;lease:WorkAccessLease}>{
  roleWorkOwner(owner);const a=taskInput(value,['requestId','runId']);if(!uuid(a.requestId)||!uuid(a.runId))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   const row=(await db.query('select * from teloa_work_recovery_tickets where owner_id=$1 and request_id=$2 and run_id=$3',[owner,a.requestId,a.runId])).rows[0]
   if(!row||!['reserved','applying'].includes(row.state))throw forbidden()
   const candidate=readRecoveryCandidate(row.candidate),run=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,a.runId])).rows[0]
   if(!run||row.host_generation!==this.ports.hostGeneration())throw conflict()
   const authorization=await this.authorization(db,owner,run),checkpoint=await this.checkpoint(owner,run,db),control=await this.controls.getInTransaction(db,owner,{controlId:candidate.controlId})
   if(control.state!=='active'||control.generation!==candidate.expectedGeneration||checkpoint.reason!==candidate.reason||checkpoint.unknownOperationIds.length||checkpoint.checkpointSha256!==row.checkpoint_sha256)throw conflict()
   if(!this.ports.authorizeResume)throw forbidden()
   const controlled=await this.controls.acquireForRun(owner,{runId:run.id,mode:'continuation'},db),host=row.host_generation
   const lease=combineWorkAccessLeases([authorization.lease,controlled.lease,await this.ports.authorizeResume(db,owner,{candidate,hostGeneration:host}),{assertCurrent:()=>{if(host!==this.ports.hostGeneration())throw forbidden()}}])
   lease.assertCurrent();return {candidate,checkpointSha256:row.checkpoint_sha256,hostGeneration:host,lease}
  })
 }
 /** 一次恢复领取只给一个真实宿主；崩溃后的 applying/unknown 不自动再次派发。 */
 async begin(owner:string,value:{requestId:string;runId:string}){
  roleWorkOwner(owner);const a=taskInput(value,['requestId','runId']);if(!uuid(a.requestId)||!uuid(a.runId))throw invalid()
  const row=(await this.pool.query('select * from teloa_work_recovery_tickets where owner_id=$1 and request_id=$2 and run_id=$3',[owner,a.requestId,a.runId])).rows[0]
  if(row?.state==='unknown')throw new WorkError('teloa/execution-pending','本次恢复结果未知，不能重复派发。')
  if(row&&['applying','applied'].includes(row.state))return {candidate:readRecoveryCandidate(row.candidate),checkpointSha256:row.checkpoint_sha256 as string,hostGeneration:row.host_generation as number,lease:{assertCurrent:()=>{throw forbidden()}},dispatch:false}
  const request={requestId:a.requestId,runId:a.runId},permit=await this.acquire(owner,request);permit.lease.assertCurrent()
  const result=await this.pool.query("update teloa_work_recovery_tickets set state='applying',updated_at=$4 where owner_id=$1 and request_id=$2 and run_id=$3 and state='reserved'",[owner,request.requestId,request.runId,this.identity.now()]);return {...permit,dispatch:result.rowCount===1}
 }
 /** 仅由持有当前票据的宿主装配调用，不注册浏览器/模型方法。 */
 async record(owner:string,input:{requestId:string;runId:string;checkpointSha256:string;state:'applied'|'unknown'}):Promise<void>{roleWorkOwner(owner);const a=taskInput(input,['requestId','runId','checkpointSha256','state']);if(!uuid(a.requestId)||!uuid(a.runId)||!sha(a.checkpointSha256)||!['applied','unknown'].includes(a.state as string))throw invalid();const result=await this.pool.query("update teloa_work_recovery_tickets set state=$5,updated_at=$6 where owner_id=$1 and request_id=$2 and run_id=$3 and checkpoint_sha256=$4 and state='applying'",[owner,a.requestId,a.runId,a.checkpointSha256,a.state,this.identity.now()]);if(result.rowCount!==1)throw conflict()}
}
