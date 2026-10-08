import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readWorkLineage} from '@teloa/contract'
import {readGoalRunBinding,readGoalContinuationReceipt,type GoalRunBinding,type GoalContinuationReceipt} from '@teloa/contract'
import {readRunRoleSnapshot} from './run-role-snapshot.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'
import {lockRoleWorkRole,roleWorkTransaction,roleWorkOwner,roleWorkUuid} from './twin-execution-consents.ts'
import {WorkLineageService} from './work-lineage.ts'
import {readStoredTask} from './tasks.ts'
import {combineWorkAccessLeases,workAccess,type WorkAccessLease} from './work-access.ts'

export type TaskRunGoalView={goalId:string;revision:number;phase:'active'|'paused'|'blocked'|'complete';activation:'armed'|'disarmed';roundsStarted:number;maxGoalRounds:number}
export type TaskRunGoalPorts={hostGeneration:()=>number;inspectGoal:(sessionId:string)=>Promise<TaskRunGoalView|null>;/** P2 的真实控制/累计预算实现。按 run/goal/revision/round 幂等预约；reserve 和最终 acquire 不重复扣账。缺席或不能判断时拒绝。 */admitRound:(db:PoolClient,owner:string,input:{binding:GoalRunBinding;round:number})=>Promise<WorkAccessLease>}
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const text=(v:unknown):v is string=>typeof v==='string'&&!!v.trim()&&v===v.trim()&&v.length<=256&&!/[\x00-\x1f]/.test(v)
const invalid=()=>new WorkError('teloa/invalid-input','Goal 请求格式不正确或含未知字段。')
const forbidden=()=>new WorkError('teloa/forbidden','Goal 不属于当前获准执行的本人任务。')
const conflict=()=>new WorkError('teloa/version-conflict','Goal、执行控制或宿主世代已变化，请重新核对。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','Goal 持久绑定或续轮票据不完整。')
const storedBinding=(row:any):GoalRunBinding=>{try{return readGoalRunBinding(row.binding)}catch{throw corrupt()}}
const storedReceipt=(row:any):GoalContinuationReceipt=>{try{return readGoalContinuationReceipt(row.receipt)}catch{throw corrupt()}}

/** 依赖真实 tasks/Run/lineage；不创建默认无限预算或恢复后的自动唤醒。 */
export async function initializeTaskRunGoals(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_task_run_goals(
  owner_id text not null,run_id uuid not null,goal_id text not null,binding jsonb not null,updated_at timestamptz not null,
  primary key(owner_id,run_id),unique(owner_id,goal_id),foreign key(run_id) references teloa_task_runs(id)
 );
 create table if not exists teloa_task_run_goal_revisions(
  owner_id text not null,run_id uuid not null,goal_id text not null,revision integer not null check(revision>0),binding jsonb not null,
  primary key(owner_id,run_id,goal_id,revision),foreign key(owner_id,run_id) references teloa_task_run_goals(owner_id,run_id)
 );
 create table if not exists teloa_task_run_goal_continuations(
  owner_id text not null,run_id uuid not null,goal_id text not null,revision integer not null check(revision>0),round integer not null check(round>0),
  native_request_id text not null,message_id text not null,receipt jsonb not null,created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,run_id,goal_id,revision,round),unique(owner_id,native_request_id),unique(owner_id,run_id,message_id),
  foreign key(owner_id,run_id,goal_id,revision) references teloa_task_run_goal_revisions(owner_id,run_id,goal_id,revision)
 );
`)}

export class TaskRunGoalService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string};readonly ports:TaskRunGoalPorts
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ports:TaskRunGoalPorts){this.pool=pool;this.identity=identity;this.ports=ports}
 private async run(db:PoolClient,owner:string,runId:string,live=true){
  roleWorkOwner(owner);if(!roleWorkUuid(runId))throw invalid()
  const hint=(await db.query('select role_id,task_id from teloa_task_runs where owner_id=$1 and id=$2',[owner,runId])).rows[0]
  if(!hint)throw forbidden()
  // 与 TaskRun.current/claim 同序：role -> task -> run。不会升级 SHARE 锁。
  await lockRoleWorkRole(db,owner,hint.role_id,'share')
  const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,hint.task_id])).rows[0]
  if(!taskRow)throw forbidden()
  const run=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2 for update',[owner,runId])).rows[0]
  if(!run||run.role_id!==hint.role_id||run.task_id!==hint.task_id)throw corrupt()
  if(live&&(!['accepted','active'].includes(run.state)||run.stop_requested_at!==null))throw forbidden()
  const task=readStoredTask(taskRow)
  let snapshot:any
  try{snapshot=JSON.parse(run.input_text);if(snapshot.schema!=='teloa.task-run-input/v2')throw Error();snapshot.role=readRunRoleSnapshot(snapshot.role)}catch{throw new WorkError('teloa/conflict','旧执行缺少完整职责和 Goal 归属，请本人创建新的执行。')}
  if(live&&(snapshot.task?.id!==task.id||snapshot.task?.version!==run.task_version||snapshot.task?.scope!==task.scope||snapshot.task?.title!==task.title||snapshot.task?.goal!==task.goal||task.assigneeRoleId!==run.role_id))throw conflict()
  const lineage=await new WorkLineageService(this.pool,this.identity).readInTransaction(db,owner,{taskId:task.id})
  if(!lineage||!isDeepStrictEqual(lineage,readWorkLineage(snapshot.lineage)))throw corrupt()
  const control=(await db.query('select state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,lineage.roundControlId])).rows[0]
  if(!control||!positive(control.generation))throw corrupt()
  if(live&&control.state!=='active')throw forbidden()
  // 即便父服务在暂停后刷新了旧快照，续轮仍重新核本人、当前职责与收窄范围。
  let lease:WorkAccessLease={assertCurrent(){}}
  if(live){
   const admission=await new RoleWorkEligibilityService(this.pool).authorize(owner,{roleId:run.role_id,expectedRoleVersion:run.role_version,scope:task.scope,inputSchema:'teloa.task-run-input/v2',authorization:snapshot.role.authorization,groupId:snapshot.groupContext?.groupId??task.groupId},db)
   if(admission.snapshot.id!==snapshot.role.id||admission.snapshot.version!==snapshot.role.version||!isDeepStrictEqual(admission.snapshot.authorization,snapshot.role.authorization)||!isDeepStrictEqual(admission.snapshot.twinConsent,snapshot.role.twinConsent))throw conflict()
   if(admission.limits.allowedTools!==null&&(run.allowed_tools??[]).some((name:string)=>!admission.limits.allowedTools!.includes(name)))throw forbidden()
   lease={assertCurrent:admission.assertCurrent}
  }
  return {run,lineage,control,lease}
 }
 private async view(sessionId:string,goalId:string,revision:number,round?:number){
  const g=await this.ports.inspectGoal(sessionId)
  if(!g||g.goalId!==goalId||g.revision!==revision)throw conflict()
  if(round!==undefined&&(g.phase!=='active'||g.activation!=='armed'||g.roundsStarted+1!==round||round>g.maxGoalRounds))throw forbidden()
  return g
 }
 private async current(db:PoolClient,owner:string,binding:GoalRunBinding,round?:number){
  const facts=await this.run(db,owner,binding.runId),row=(await db.query('select binding from teloa_task_run_goals where owner_id=$1 and run_id=$2 for update',[owner,binding.runId])).rows[0]
  if(!row||!isDeepStrictEqual(storedBinding(row),binding)||binding.ownerId!==owner||binding.sessionId!==facts.run.session_id||binding.controlId!==facts.lineage.roundControlId||binding.controlGeneration!==facts.control.generation||binding.hostGeneration!==this.ports.hostGeneration())throw conflict()
  await this.view(binding.sessionId,binding.goalId,binding.revision,round)
  return facts
 }
 async bind(owner:string,input:unknown):Promise<GoalRunBinding>{
  const a=taskInput(input,['runId','goalId','revision','hostGeneration']);if(!roleWorkUuid(a.runId)||!text(a.goalId)||!positive(a.revision)||!positive(a.hostGeneration))throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   const {run,lineage,control}=await this.run(db,owner,a.runId as string)
   if(a.hostGeneration!==this.ports.hostGeneration())throw conflict()
   await this.view(run.session_id,a.goalId as string,a.revision as number)
   const binding:GoalRunBinding={ownerId:owner,runId:run.id,sessionId:run.session_id,goalId:a.goalId as string,revision:a.revision as number,hostGeneration:a.hostGeneration as number,controlId:lineage.roundControlId,controlGeneration:control.generation}
   const old=(await db.query('select binding from teloa_task_run_goals where owner_id=$1 and run_id=$2 for update',[owner,run.id])).rows[0]
   if(old){if(!isDeepStrictEqual(storedBinding(old),binding))throw conflict();return binding}
   await db.query('insert into teloa_task_run_goals(owner_id,run_id,goal_id,binding,updated_at) values($1,$2,$3,$4,$5)',[owner,run.id,binding.goalId,JSON.stringify(binding),this.identity.now()])
   await db.query('insert into teloa_task_run_goal_revisions(owner_id,run_id,goal_id,revision,binding) values($1,$2,$3,$4,$5)',[owner,run.id,binding.goalId,binding.revision,JSON.stringify(binding)])
   return binding
  })
 }
 async updateRef(owner:string,input:unknown):Promise<GoalRunBinding>{
  const a=taskInput(input,['runId','goalId','previousRevision','revision']);if(!roleWorkUuid(a.runId)||!text(a.goalId)||!positive(a.previousRevision)||!positive(a.revision)||a.revision<=a.previousRevision)throw invalid()
  return roleWorkTransaction(this.pool,async db=>{
   const facts=await this.run(db,owner,a.runId as string,false),row=(await db.query('select binding from teloa_task_run_goals where owner_id=$1 and run_id=$2 for update',[owner,a.runId])).rows[0]
   if(!['accepted','active'].includes(facts.run.state))throw forbidden()
   if(!row)throw forbidden();const old=storedBinding(row)
   if(old.goalId!==a.goalId)throw conflict()
   await this.view(old.sessionId,old.goalId,a.revision as number)
   if(old.revision===a.revision)return old
   if(old.revision!==a.previousRevision)throw conflict()
   const binding={...old,revision:a.revision as number,hostGeneration:this.ports.hostGeneration(),controlGeneration:facts.control.generation}
   await db.query('update teloa_task_run_goals set binding=$3,updated_at=$4 where owner_id=$1 and run_id=$2',[owner,old.runId,JSON.stringify(binding),this.identity.now()])
   await db.query('insert into teloa_task_run_goal_revisions(owner_id,run_id,goal_id,revision,binding) values($1,$2,$3,$4,$5)',[owner,old.runId,old.goalId,binding.revision,JSON.stringify(binding)])
   return binding
  })
 }
 async reserve(owner:string,input:unknown):Promise<GoalContinuationReceipt>{
  const a=taskInput(input,['binding','round','messageId','nativeRequestId','payloadSha256']),binding=readGoalRunBinding(a.binding)
  const receipt=readGoalContinuationReceipt({...binding,round:a.round,messageId:a.messageId,nativeRequestId:a.nativeRequestId,payloadSha256:a.payloadSha256,acceptedSeq:null,state:'reserved'})
  if(owner!==binding.ownerId)throw forbidden()
  return roleWorkTransaction(this.pool,async db=>{
   // 已受理/未知只回同一票据，不再次准入或生成新的 messageId。
   const old=(await db.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 and goal_id=$3 and revision=$4 and round=$5',[owner,binding.runId,binding.goalId,binding.revision,receipt.round])).rows[0]
   if(old){const saved=storedReceipt(old);if(!isDeepStrictEqual({...saved,state:'reserved',acceptedSeq:null},receipt))throw new WorkError('teloa/conflict','本轮 Goal 已有不同提交身份，不能重复派发。');return saved}
   const facts=await this.current(db,owner,binding,receipt.round)
   const concurrent=(await db.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 and goal_id=$3 and revision=$4 and round=$5',[owner,binding.runId,binding.goalId,binding.revision,receipt.round])).rows[0]
   if(concurrent){const saved=storedReceipt(concurrent);if(!isDeepStrictEqual({...saved,state:'reserved',acceptedSeq:null},receipt))throw new WorkError('teloa/conflict','Goal 本轮已有不同提交身份。');return saved}
   if(typeof this.ports.admitRound!=='function')throw new WorkError('teloa/unavailable','Goal 控制与预算准入尚未装配。')
   const lease=combineWorkAccessLeases([facts.lease,await this.ports.admitRound(db,owner,{binding,round:receipt.round})]);lease.assertCurrent()
   await db.query('insert into teloa_task_run_goal_continuations(owner_id,run_id,goal_id,revision,round,native_request_id,message_id,receipt,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',[owner,binding.runId,binding.goalId,binding.revision,receipt.round,receipt.nativeRequestId,receipt.messageId,JSON.stringify(receipt),this.identity.now()])
   return receipt
  })
 }
 /** 仅可信宿主在最终原生发布前调用；同步 lease 必须由当前控制/预算策略提供。 */
 async acquire(owner:string,input:{binding:GoalRunBinding;round:number}):Promise<WorkAccessLease>{
  const a=taskInput(input,['binding','round']),binding=readGoalRunBinding(a.binding);if(owner!==binding.ownerId||!positive(a.round))throw forbidden()
  return roleWorkTransaction(this.pool,async db=>{const facts=await this.current(db,owner,binding,a.round as number),row=(await db.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and run_id=$2 and goal_id=$3 and revision=$4 and round=$5',[owner,binding.runId,binding.goalId,binding.revision,a.round])).rows[0];if(!row)throw forbidden();if(storedReceipt(row).state!=='reserved')throw new WorkError('teloa/execution-pending','Goal 本轮受理或未知结果不能重复派发。');if(typeof this.ports.admitRound!=='function')throw new WorkError('teloa/unavailable','Goal 控制与预算准入尚未装配。');return combineWorkAccessLeases([facts.lease,await this.ports.admitRound(db,owner,{binding,round:a.round as number})])})
 }
 /** 内部工具入口复用真实 Run 资格；不会为 create_goal 创建虚构 Goal 或续轮票据。 */
 async authorizeMutation(owner:string,runId:string):Promise<WorkAccessLease>{return roleWorkTransaction(this.pool,async db=>{const facts=await this.run(db,owner,runId);return combineWorkAccessLeases([facts.lease,await workAccess.authorize({kind:'capability',capability:'automation',ownerId:owner,sessionId:facts.run.session_id,objectId:runId,operation:'run'})])})}
 async findRun(owner:string,sessionId:string):Promise<{id:string;sessionId:string;nativeRequestId:string}|null>{
  // 与 TaskRun 会话判据一致；一键运行的 task-run-<requestId> 不是业务 UUID。
  roleWorkOwner(owner);if(typeof sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))throw invalid()
  const rows=(await this.pool.query("select id,session_id,native_request_id from teloa_task_runs where owner_id=$1 and session_id=$2 and state in ('accepted','active')",[owner,sessionId])).rows
  if(rows.length>1)throw corrupt();const row=rows[0];return row?{id:row.id,sessionId:row.session_id,nativeRequestId:row.native_request_id}:null
 }
 async confirm(owner:string,input:unknown):Promise<GoalContinuationReceipt>{
  const a=taskInput(input,['nativeRequestId','acceptedSeq']);roleWorkOwner(owner);if(!text(a.nativeRequestId)||!Number.isSafeInteger(a.acceptedSeq)||Number(a.acceptedSeq)<0)throw invalid()
  // 此口仅装配于宿主，绝不注册浏览器/模型 handler。seq 来自精确已提交 Inbox 事件。
  return roleWorkTransaction(this.pool,async db=>{
   const row=(await db.query('select receipt from teloa_task_run_goal_continuations where owner_id=$1 and native_request_id=$2 for update',[owner,a.nativeRequestId])).rows[0]
   if(!row)throw forbidden();const old=storedReceipt(row)
   if(old.state==='accepted'){if(old.acceptedSeq!==a.acceptedSeq)throw new WorkError('teloa/conflict','Goal 本轮受理证据已落定。');return old}
   if(old.state==='withdrawn')throw forbidden()
   const saved:GoalContinuationReceipt={...old,state:'accepted',acceptedSeq:a.acceptedSeq as number}
   await db.query('update teloa_task_run_goal_continuations set receipt=$3,updated_at=$4 where owner_id=$1 and native_request_id=$2',[owner,old.nativeRequestId,JSON.stringify(saved),this.identity.now()]);return saved
  })
 }
 async markUnknown(owner:string,nativeRequestId:string):Promise<void>{roleWorkOwner(owner);await this.pool.query("update teloa_task_run_goal_continuations set receipt=jsonb_set(receipt,'{state}','\"unknown\"'),updated_at=$3 where owner_id=$1 and native_request_id=$2 and receipt->>'state'='reserved'",[owner,nativeRequestId,this.identity.now()])}
 /** 宿主已 disarm 并核对完整持久 Inbox 日志不存在此消息后调用；不注册远程/模型口，不撤销已受理证据。 */
 async withdrawUnpublished(owner:string,nativeRequestId:string):Promise<void>{roleWorkOwner(owner);if(!text(nativeRequestId))throw invalid();await this.pool.query("update teloa_task_run_goal_continuations set receipt=jsonb_set(receipt,'{state}','\"withdrawn\"'),updated_at=$3 where owner_id=$1 and native_request_id=$2 and receipt->>'state' in ('reserved','unknown')",[owner,nativeRequestId,this.identity.now()])}
 async read(owner:string,input:unknown):Promise<{binding:GoalRunBinding|null;continuations:GoalContinuationReceipt[]}>{
  roleWorkOwner(owner);const a=taskInput(input,['runId']);if(!roleWorkUuid(a.runId))throw invalid()
  const known=(await this.pool.query('select id from teloa_task_runs where owner_id=$1 and id=$2',[owner,a.runId])).rows[0];if(!known)throw forbidden()
  const row=(await this.pool.query('select binding from teloa_task_run_goals where owner_id=$1 and run_id=$2',[owner,a.runId])).rows[0]
  if(!row)return {binding:null,continuations:[]}
  const binding=storedBinding(row),rows=(await this.pool.query('select c.receipt,r.binding as revision_binding from teloa_task_run_goal_continuations c join teloa_task_run_goal_revisions r using(owner_id,run_id,goal_id,revision) where c.owner_id=$1 and c.run_id=$2 order by c.revision,c.round',[owner,a.runId])).rows
  const continuations=rows.map(row=>{const receipt=storedReceipt(row),ref=storedBinding({binding:row.revision_binding}),{round,messageId,nativeRequestId,payloadSha256,acceptedSeq,state,...origin}=receipt;if(!isDeepStrictEqual(origin,ref)||ref.ownerId!==owner||ref.runId!==binding.runId||ref.goalId!==binding.goalId||ref.sessionId!==binding.sessionId||ref.controlId!==binding.controlId||ref.revision>binding.revision)throw corrupt();return receipt})
  return {binding,continuations}
 }
}
