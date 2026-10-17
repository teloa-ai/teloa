import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupDefinition,groupRoutingListInput,isGroupRoutingDecision,readGroupDispatchItem,readGroupRunSource,isMessageReference,ungrantedGroupReferences,type MessageReference,groupRoutedAttemptTaskRequestId,type GroupRoutingDecision,type GroupTaskCreateInput,type WorkSource,type GroupDispatchItem,type GroupRunSource} from '@teloa/contract'
import {readStoredRunPlanReport} from './task-run-plan-context.ts'
import {readStoredTaskRun} from './task-runs.ts'
import {WorkLineageService} from './work-lineage.ts'
import {lockRoleWorkRole,assertRoleWorkRole} from './twin-execution-consents.ts'
import {readRoleWorkGroupGrant} from './role-delegations.ts'
import {authorizeRoleTaskAssignment} from './role-task-authorization.ts'
import {groupRoutedTaskGoal,groupRoutedWorkGoal} from './group-routing-text.ts'
import {readGroupTaskSource} from './group-tasks.ts'
import {groupTaskBusinessTarget} from '@teloa/contract'

export type GroupDispatchReceipt={taskId:string|null;runId:string|null;state:string|null}
export type GroupRoutingWake={messageId:string;groupId:string;leaseGeneration:number}
type Database=Pick<Pool,'query'>
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const positive=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0
const actor=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const invalid=()=>new WorkError('teloa/invalid-input','群派工请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','群派工持久回执与真实来源不一致。')
const exact=(v:unknown,keys:string[])=>{if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!keys.includes(k)))throw invalid()}
const stamp=(v:unknown):string=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw corrupt();return v.toISOString()}
const digest=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex')
const lineageService=(pool:Pool)=>new WorkLineageService(pool,{id:()=>{throw corrupt()},now:()=>{throw corrupt()}})
const present=async(db:Database)=>(await db.query("select to_regclass('teloa_group_run_sources') as relation")).rows[0]?.relation!==null

/** 只读取本轮真实消息的运行来源。旧消息缺少快照时不猜父根。 */
export async function readTrustedGroupMessageRunSource(db:Database,owner:string,input:{groupId:string;messageId:string},pool?:Pool):Promise<GroupRunSource|null>{
 actor(owner);exact(input,['groupId','messageId']);if(!uuid(input.groupId)||!uuid(input.messageId))throw invalid()
 const message=(await db.query('select * from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,input.groupId,input.messageId])).rows[0]
 if(!message)throw new WorkError('teloa/forbidden','群消息不属于当前本人或当前群。')
 if(!await present(db))return null
 const row=(await db.query('select * from teloa_group_run_sources where owner_id=$1 and message_id=$2',[owner,input.messageId])).rows[0]
 if(!row)return null
 const source=readGroupRunSource(row.source)
 if(row.group_id!==input.groupId||row.source_hash!==digest(source)||source.ownerId!==owner||message.task_id!==source.taskId||message.run_id!==source.runId||message.author_id!==source.roleId)throw corrupt()
 const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,source.runId])).rows[0]
 if(!raw)throw corrupt();const run=readStoredTaskRun(raw)
 if(run.state!=='ended'||run.evidence?.state!=='ended'||!run.roleSnapshot||!run.lineage||run.taskId!==source.taskId||run.roleId!==source.roleId||run.roleVersion!==source.roleVersion||run.roleSnapshot.kind!==source.roleKind||run.roleSnapshot.name!==source.roleName||!isDeepStrictEqual(run.lineage,source.lineage)||(run.groupContext?.groupId??readStoredRunPlanReport(raw)?.reportGroup.groupId)!==input.groupId)throw corrupt()
 if(pool){const fixed=await lineageService(pool).readInTransaction(db as PoolClient,owner,{taskId:source.taskId});if(!fixed||!isDeepStrictEqual(fixed,source.lineage))throw corrupt()}
 return source
}
export async function readTrustedGroupMessageWorkSource(db:PoolClient,owner:string,input:{groupId:string;messageId:string},pool?:Pool):Promise<Extract<WorkSource,{kind:'group-run-message'}>|null>{
 const source=await readTrustedGroupMessageRunSource(db,owner,input,pool);return source?{kind:'group-run-message',messageId:input.messageId,runId:source.runId}:null
}

/** 初始化在真实群、任务、Run、决策和工作谱系表之后；不反向初始化其他模块。 */
export async function initializeGroupRoutingOutbox(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_group_run_sources(
  owner_id text not null,message_id uuid not null,group_id uuid not null,source jsonb not null,source_hash text not null check(source_hash~'^[a-f0-9]{64}$'),
  primary key(owner_id,message_id),foreign key(message_id,group_id) references teloa_group_messages(id,group_id)
 );
 create table if not exists teloa_group_routing_wakes(
  owner_id text not null,message_id uuid not null,group_id uuid not null,state text not null default 'pending' check(state in ('pending','leased','settled')),
  lease_generation integer not null default 0 check(lease_generation>=0),next_attempt_at timestamptz,created_at timestamptz not null,
  primary key(owner_id,message_id),foreign key(message_id,group_id) references teloa_group_messages(id,group_id)
 );
 create table if not exists teloa_group_routing_outbox(
  id uuid primary key,owner_id text not null,group_id uuid not null,message_id uuid not null,decision_version integer not null check(decision_version>0),
  role_id uuid not null,role_version integer not null check(role_version>0),request_id uuid not null,group_version integer not null check(group_version>0),
  state text not null check(state in ('pending','leased','submitted','unknown','settled','blocked')),
  task_id uuid,run_id uuid,lineage jsonb,attempts integer not null default 0 check(attempts>=0),next_attempt_at timestamptz,lease_generation integer not null default 0 check(lease_generation>=0),reason text,created_at timestamptz not null,
  unique(owner_id,group_id,message_id,decision_version,role_id,role_version),unique(owner_id,request_id),
  foreign key(owner_id,message_id) references teloa_group_routing_decisions(owner_id,message_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id),check(run_id is null or task_id is not null)
 );
 -- 逐接收者执行策略（规格 §4.2）：work 只给 v2 决策中实际接手工作的员工，并固定其本人原文范围；其余为交流回应。
 alter table teloa_group_routing_outbox add column if not exists execution_mode text not null default 'reply' check(execution_mode in ('reply','work'));
 alter table teloa_group_routing_outbox add column if not exists instruction_range jsonb;
 alter table teloa_group_routing_outbox add column if not exists business_target jsonb;
 -- 依赖交接（规格 §4.3/§4.5）：后序阶段以 waiting 登记，前序阶段的可信成果贴回本群后才释放，并以那条可信 Run 消息作执行父关系。
 alter table teloa_group_routing_outbox add column if not exists stage integer not null default 1 check(stage between 1 and 5);
 alter table teloa_group_routing_outbox add column if not exists handoff_message_id uuid;
 alter table teloa_group_routing_outbox add column if not exists handoff_message_ids jsonb;
 do $$ declare item record; begin
  for item in select conname from pg_constraint where conrelid='teloa_group_routing_outbox'::regclass and contype='c' and pg_get_constraintdef(oid) like '%state%pending%' and pg_get_constraintdef(oid) not like '%waiting%' loop
   execute format('alter table teloa_group_routing_outbox drop constraint %I',item.conname);
  end loop;
  if not exists(select 1 from pg_constraint where conrelid='teloa_group_routing_outbox'::regclass and conname='teloa_group_routing_outbox_state_v2') then
   alter table teloa_group_routing_outbox add constraint teloa_group_routing_outbox_state_v2 check(state in ('waiting','pending','leased','submitted','unknown','settled','blocked'));
  end if;
 end $$;
 create index if not exists teloa_group_routing_outbox_due on teloa_group_routing_outbox(owner_id,next_attempt_at) where state in ('pending','leased','unknown','submitted');
 create or replace function teloa_reject_group_run_source_mutation() returns trigger language plpgsql as $$ begin raise exception 'group run sources are immutable'; end $$;
 drop trigger if exists teloa_group_run_sources_immutable on teloa_group_run_sources;
 create trigger teloa_group_run_sources_immutable before update or delete on teloa_group_run_sources for each row execute function teloa_reject_group_run_source_mutation();
`)}

function item(row:Record<string,unknown>):GroupDispatchItem{return readGroupDispatchItem({id:row.id,ownerId:row.owner_id,groupId:row.group_id,messageId:row.message_id,decisionVersion:row.decision_version,roleId:row.role_id,roleVersion:row.role_version,requestId:row.request_id,state:row.state,taskId:row.task_id,runId:row.run_id,lineage:row.lineage,attempts:row.attempts,nextAttemptAt:row.next_attempt_at===null?null:stamp(row.next_attempt_at),leaseGeneration:row.lease_generation})}
export class GroupRoutingOutboxService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 private async stored(db:Database,owner:string,itemId:string){actor(owner);if(!uuid(itemId))throw invalid();const row=(await db.query('select * from teloa_group_routing_outbox where owner_id=$1 and id=$2',[owner,itemId])).rows[0];if(!row)throw new WorkError('teloa/forbidden','群派工待办不属于当前本人。');item(row);return row}
 private async authorize(db:PoolClient,owner:string,row:Record<string,unknown>){
  const fixed=item(row),role=await lockRoleWorkRole(db,owner,fixed.roleId);assertRoleWorkRole(role,fixed.roleVersion)
  const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,fixed.groupId])).rows[0]
  if(!group||group.archived)throw new WorkError('teloa/forbidden','群已归档或不属于本人。')
  if(group.version!==row.group_version)throw new WorkError('teloa/version-conflict','群设置已变化，原派工没有扩大到新范围。')
  const groupScope=groupDefinition(group.definition).scope,target=row.business_target?groupTaskBusinessTarget(row.business_target):undefined
  if(target&&groupScope!=='general'&&groupScope!==target.scope)throw new WorkError('teloa/forbidden','业务群的派工不能跨到其他业务。')
  const scope=target?.scope??groupScope
  await readRoleWorkGroupGrant(db,owner,role,fixed.groupId,scope,true)
  const admission=await authorizeRoleTaskAssignment(db,this.pool,owner,role,scope,fixed.groupId)
  const created=(await db.query('select id,assignee_role_id,assignee_role_version from teloa_tasks where owner_id=$1 and request_id=$2',[owner,fixed.requestId])).rows[0]
  if(created&&(created.assignee_role_id!==fixed.roleId||created.assignee_role_version!==fixed.roleVersion))throw new WorkError('teloa/version-conflict','原群任务负责人已变化，不能继续旧派工。')
  const lineage=fixed.lineage??(created?await lineageService(this.pool).readInTransaction(db,owner,{taskId:created.id}):null)
  if(lineage){
   const controls=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=any($2::uuid[]) for share',[owner,[lineage.roundControlId,...(lineage.definitionControlId?[lineage.definitionControlId]:[])]] )).rows
   if(controls.length!==(lineage.definitionControlId?2:1)||controls.some(c=>c.state!=='active')||controls.find(c=>c.id===lineage.roundControlId)?.generation!==lineage.controlGeneration)throw new WorkError('teloa/forbidden','父工作已经暂停或结束，不能补派新的群工作。')
  }
  admission.assertCurrent()
 }
 async recordRecipients(db:PoolClient,owner:string,input:{groupId:string;messageId:string;decision:GroupRoutingDecision;decisionVersion:number}):Promise<GroupDispatchItem[]>{
  actor(owner);exact(input,['groupId','messageId','decision','decisionVersion']);if(!uuid(input.groupId)||!uuid(input.messageId)||!positive(input.decisionVersion)||!isGroupRoutingDecision(input.decision))throw invalid()
  // 第一尝试对应原决策行；重试尝试对应 teloa_group_routing_attempts 的同版本终态行（规格 §6.5 尝试绑定）。
  // xmin 是32位事务身份；当前 xid8 取低32位，避免事务号绕回时误拒新决策。
  const decision=(input.decisionVersion===1
   ?await db.query('select decision,xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296) as created_here from teloa_group_routing_decisions where owner_id=$1 and group_id=$2 and message_id=$3',[owner,input.groupId,input.messageId])
   :await db.query('select decision,xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296) as created_here from teloa_group_routing_attempts where owner_id=$1 and group_id=$2 and message_id=$3 and attempt_version=$4 and decision is not null',[owner,input.groupId,input.messageId,input.decisionVersion])).rows[0]
  if(!decision)throw new WorkError('teloa/forbidden','投递必须和真实终态群决策同事务记录。')
  if(!isDeepStrictEqual(decision.decision,input.decision))throw new WorkError('teloa/conflict','投递不能改变已确认的群决策。')
  if(!input.decision.respond.length)return []
  const prior=(await db.query('select * from teloa_group_routing_outbox where owner_id=$1 and message_id=$2 and decision_version=$3 order by role_id',[owner,input.messageId,input.decisionVersion])).rows
  if(prior.length){if(prior.length!==input.decision.respond.length||prior.some(r=>!input.decision.respond.includes(r.role_id)))throw corrupt();return prior.map(item)}
  if(!decision.created_here)throw new WorkError('teloa/forbidden','历史决策没有逐接收者快照，不能按当前岗位版本补造派工。')
  const source=await readTrustedGroupMessageRunSource(db,owner,{groupId:input.groupId,messageId:input.messageId},this.pool)
  const roles=[];for(const roleId of [...input.decision.respond].sort())roles.push(await lockRoleWorkRole(db,owner,roleId))
  const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,input.groupId])).rows[0]
  if(!group||!positive(group.version))throw corrupt()
  const assigned=input.decision.intent==='work'?input.decision.assignments??[]:[]
  const saved:GroupDispatchItem[]=[],work=new Map(assigned.map(item=>[item.roleId,item.instructionRange])),stages=new Map(assigned.map(item=>[item.roleId,item.stage??1]))
  for(const role of roles){
   const businessTarget=assigned.find(assignment=>assignment.roleId===role.id)?.businessTarget
   const row={id:this.identity.id(),owner_id:owner,group_id:input.groupId,message_id:input.messageId,decision_version:input.decisionVersion,role_id:role.id,role_version:role.version,request_id:groupRoutedAttemptTaskRequestId(owner,input.groupId,input.messageId,role.id,input.decisionVersion),group_version:group.version,state:'pending',task_id:null,run_id:null,lineage:source?{...source.lineage,parentRunId:source.runId}:null,attempts:0,next_attempt_at:null,lease_generation:0,business_target:businessTarget??null}
   await this.authorize(db,owner,row)
   const range=work.get(role.id),stage=stages.get(role.id)??1
   // 后序阶段先不派发：没有前序可信成果前不能提前生成无依据的后序成果。
   const result=await db.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,lineage,created_at,execution_mode,instruction_range,stage,business_target)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$14,$10,$11,$12,$13,$15,$16) returning *`,[row.id,owner,input.groupId,input.messageId,input.decisionVersion,role.id,role.version,row.request_id,group.version,row.lineage===null?null:JSON.stringify(row.lineage),this.identity.now(),range?'work':'reply',range?JSON.stringify(range):null,stage>1?'waiting':'pending',stage,businessTarget?JSON.stringify(businessTarget):null])
   saved.push(item(result.rows[0]))
  }
  return saved
 }
 /**
  * 依赖交接的就绪判据（规格 §4.3/§4.5）：同一定案里更早阶段的每一位都已有原生结束的 Run，且该 Run 的成果已作为可信回帖贴回本群。
  * 就绪时以最近一位前序的可信回帖作执行父关系（继承父范围、预算与停止控制），转为 pending 交由既有投递；
  * 前序被拦下、撤回、配置失败或父控制已停止时本阶段不再启动（blocked），父控制暂停时继续等待；不提前生成无依据的后序成果。只处理 waiting 行，幂等。
  */
 async releaseStages(owner:string,input:{messageId?:string}={}):Promise<number>{
  actor(owner);exact(input,['messageId']);if(input.messageId!==undefined&&!uuid(input.messageId))throw invalid()
  const waiting=(await this.pool.query("select * from teloa_group_routing_outbox where owner_id=$1 and state='waiting' and ($2::uuid is null or message_id=$2) order by created_at,id limit 50",[owner,input.messageId??null])).rows
  let released=0
  for(const row of waiting)released+=await this.transaction(async db=>{
   const current=(await db.query("select * from teloa_group_routing_outbox where owner_id=$1 and id=$2 and state='waiting' for update",[owner,row.id])).rows[0]
   if(!current)return 0
   const priors=(await db.query('select o.*,r.state as run_state,r.evidence as run_evidence from teloa_group_routing_outbox o left join teloa_task_runs r on r.owner_id=o.owner_id and r.id=o.run_id where o.owner_id=$1 and o.message_id=$2 and o.decision_version=$3 and o.stage<$4 order by o.stage desc,o.role_id',[owner,current.message_id,current.decision_version,current.stage])).rows
   const blocked=(reason:string)=>db.query("update teloa_group_routing_outbox set state='blocked',reason=$3 where owner_id=$1 and id=$2 and state='waiting'",[owner,current.id,reason]).then(()=>0)
   if(!priors.length)return blocked('teloa/storage-corrupt')
   if(priors.some(prior=>prior.state==='blocked'||['withdrawn','configuration_failed'].includes(String(prior.run_state))))return blocked('teloa/conflict')
   // 原生轮次以错误／中断结束不是前序成果就绪；已贴回的失败说明也不能据此启动后序工作。
   if(priors.some(prior=>prior.run_state==='ended'&&(prior.run_evidence?.state!=='ended'||prior.run_evidence?.reason!=='completed')))return blocked('teloa/conflict')
   if(priors.some(prior=>prior.run_state!=='ended'))return 0
   const results=(await db.query('select m.id,m.run_id,m.reference_snapshot from teloa_group_messages m join teloa_group_run_sources s on s.owner_id=m.owner_id and s.message_id=m.id where m.owner_id=$1 and m.group_id=$2 and m.run_id=any($3::uuid[]) order by m.created_at desc,m.id',[owner,current.group_id,priors.map(prior=>prior.run_id)])).rows
   if(priors.some(prior=>!results.some(message=>message.run_id===prior.run_id)))return 0
   // 全部必需前序（按阶段、员工的固定顺序）各取其最近一条可信回帖，逐条核实；执行父节点取最近阶段的第一位，继承其谱系、预算与控制。
   const ordered=[...priors].sort((a,b)=>a.stage-b.stage||String(a.role_id).localeCompare(String(b.role_id)))
   const handoffs:{id:string;run_id:string;reference_snapshot:unknown}[]=[]
   for(const prior of ordered){
    const message=results.find(row=>row.run_id===prior.run_id)!
    if(!await readTrustedGroupMessageRunSource(db,owner,{groupId:current.group_id,messageId:message.id},this.pool))return blocked('teloa/storage-corrupt')
    handoffs.push(message)
   }
   const handoff=results.find(message=>message.run_id===priors[0]!.run_id)!
   const source=await readTrustedGroupMessageRunSource(db,owner,{groupId:current.group_id,messageId:handoff.id},this.pool)
   if(!source)return blocked('teloa/storage-corrupt')
   // 后序继承前序的轮次控制与预算：本人已停止（或控制已换代）时不再交接；暂停时保持等待，恢复后再交接。
   const control=(await db.query('select state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,source.lineage.roundControlId])).rows[0]
   if(!control||['ending','ended'].includes(String(control.state))||control.generation!==source.lineage.controlGeneration)return blocked('teloa/conflict')
   if(control.state!=='active')return 0
   // 交接成果沿群成员授权契约：前序贴回的每个固定版本都须已授予后序接手者。未授予时保持可恢复等待并提示需要授予资料，
   // 本人在成员授权里授予该固定版本后由原投递恢复一次；不阻断、不重编阶段、不扩大授权。
   const grant=(await db.query('select state,resources from teloa_group_agent_grants where owner_id=$1 and group_id=$2 and role_id=$3 order by grant_version desc limit 1 for share',[owner,current.group_id,current.role_id])).rows[0]
   const granted=grant?.state==='active'&&Array.isArray(grant.resources)?(grant.resources as unknown[]).filter(isMessageReference):[]
   if(handoffs.some(message=>!Array.isArray(message.reference_snapshot)||!(message.reference_snapshot as unknown[]).every(isMessageReference)))return blocked('teloa/storage-corrupt')
   if(handoffs.some(message=>ungrantedGroupReferences(message.reference_snapshot as MessageReference[],granted).length)){
    await db.query("update teloa_group_routing_outbox set reason='teloa/resource-required' where owner_id=$1 and id=$2 and state='waiting'",[owner,current.id]);return 0
   }
   await db.query("update teloa_group_routing_outbox set state='pending',reason=null,handoff_message_id=$3,handoff_message_ids=$4,lineage=$5,next_attempt_at=null where owner_id=$1 and id=$2 and state='waiting'",[owner,current.id,handoff.id,JSON.stringify(handoffs.map(message=>String(message.id))),JSON.stringify({...source.lineage,parentRunId:source.runId})])
   return 1
  })
  return released
 }
 async pending(owner:string,input:{messageId?:string}={}):Promise<GroupDispatchItem[]>{actor(owner);exact(input,['messageId']);if(input.messageId!==undefined&&!uuid(input.messageId))throw invalid();return (await this.pool.query("select * from teloa_group_routing_outbox where owner_id=$1 and ($2::uuid is null or message_id=$2) and state in ('pending','leased','unknown','submitted') and (next_attempt_at is null or next_attempt_at<=$3) order by created_at,id limit 100",[owner,input.messageId??null,this.identity.now()])).rows.map(item)}
 /** 本人群历史所需的全状态读口；不接受执行来源或 nativeRequestId 等授权字段。 */
 async list(owner:string,input:unknown):Promise<GroupDispatchItem[]>{actor(owner);const request=groupRoutingListInput(input);if(!(await this.pool.query('select 1 from teloa_groups where owner_id=$1 and id=$2',[owner,request.groupId])).rowCount)throw new WorkError('teloa/forbidden','群不属于当前本人。');return (await this.pool.query('select * from teloa_group_routing_outbox where owner_id=$1 and group_id=$2 and message_id=any($3::uuid[]) order by message_id,role_id',[owner,request.groupId,request.messageIds])).rows.map(item)}
 async claim(owner:string,input:{itemId:string;expectedLeaseGeneration:number}):Promise<GroupDispatchItem|null>{
  actor(owner);exact(input,['itemId','expectedLeaseGeneration']);if(!uuid(input.itemId)||!Number.isSafeInteger(input.expectedLeaseGeneration)||input.expectedLeaseGeneration<0)throw invalid()
  return this.transaction(async db=>{const row=(await db.query(`update teloa_group_routing_outbox set state='leased',attempts=attempts+1,lease_generation=lease_generation+1,next_attempt_at=$4::timestamptz+interval '30 seconds'
   where owner_id=$1 and id=$2 and lease_generation=$3 and state in ('pending','leased','unknown','submitted') and (next_attempt_at is null or next_attempt_at<=$4) returning *`,[owner,input.itemId,input.expectedLeaseGeneration,this.identity.now()])).rows[0];return row?item(row):null})
 }
 async assertDispatch(owner:string,input:{itemId:string;leaseGeneration:number}):Promise<void>{
  exact(input,['itemId','leaseGeneration']);await this.transaction(async db=>{const row=await this.stored(db,owner,input.itemId);await this.authorize(db,owner,row);if(row.lease_generation!==input.leaseGeneration||!row.next_attempt_at||stamp(row.next_attempt_at)<=this.identity.now()||!['leased','unknown'].includes(String(row.state)))throw new WorkError('teloa/version-conflict','群投递租约已变化，不能继续派发。')})
 }
 async taskInput(owner:string,input:{itemId:string}):Promise<GroupTaskCreateInput>{
  exact(input,['itemId']);const row=await this.stored(this.pool,owner,input.itemId),fixed=item(row),work=row.execution_mode==='work'
  // 工作目标只由宿主固定说明与本人原文范围构成；范围在决策入库时已按原文校验，这里再按原文切取，不读路由模型的任何生成文本。
  let goal=groupRoutedTaskGoal
  if(work){const text=(await this.pool.query('select text from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,fixed.groupId,fixed.messageId])).rows[0]?.text,range=row.instruction_range as {start?:unknown;end?:unknown}|null;if(typeof text!=='string'||!range||!Number.isSafeInteger(range.start)||!Number.isSafeInteger(range.end)||(range.end as number)>text.length||(range.start as number)>=(range.end as number))throw corrupt();goal=groupRoutedWorkGoal(text.slice(range.start as number,range.end as number))}
  return {requestId:fixed.requestId,groupId:fixed.groupId,messageId:fixed.messageId,expectedGroupVersion:row.group_version as number,goal,assignee:{roleId:fixed.roleId,expectedVersion:fixed.roleVersion},trigger:'routed',executionMode:work?'work':'reply',routingAttemptVersion:fixed.decisionVersion,...(row.handoff_message_id?{handoffMessageId:String(row.handoff_message_id)}:{}),...(Array.isArray(row.handoff_message_ids)?{handoffMessageIds:(row.handoff_message_ids as unknown[]).map(String)}:{}),...(row.business_target?{businessTarget:groupTaskBusinessTarget(row.business_target)}:{})}
 }
 async receipt(owner:string,input:{itemId:string}):Promise<GroupDispatchReceipt>{
  exact(input,['itemId']);return this.transaction(async db=>{const fixed=item(await this.stored(db,owner,input.itemId)),task=(await db.query('select t.id,s.* from teloa_tasks t join teloa_group_task_sources s on s.owner_id=t.owner_id and s.task_id=t.id and s.request_id=t.request_id where t.owner_id=$1 and t.request_id=$2',[owner,fixed.requestId])).rows[0]
   if(!task){if(fixed.taskId||fixed.runId)throw corrupt();return {taskId:null,runId:null,state:null}}
   const source=readGroupTaskSource(task)
   if(source.createdAssignee?.roleId!==fixed.roleId||source.createdAssignee.roleVersion!==fixed.roleVersion||source.messageId!==fixed.messageId||source.groupId!==fixed.groupId||fixed.taskId&&fixed.taskId!==task.id)throw corrupt()
   const lineage=await lineageService(this.pool).readInTransaction(db,owner,{taskId:task.id})
   if(!lineage||fixed.lineage&&!isDeepStrictEqual(lineage,fixed.lineage)||!fixed.lineage&&(lineage.rootTaskId!==task.id||lineage.parentRunId!==null||lineage.definition!==null))throw corrupt()
   const raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and request_id=$2',[owner,fixed.requestId])).rows[0]
   if(!raw){if(fixed.runId)throw corrupt();return {taskId:task.id,runId:null,state:null}}
   const run=readStoredTaskRun(raw)
   if(run.taskId!==task.id||run.roleId!==fixed.roleId||run.roleVersion!==fixed.roleVersion||fixed.runId&&fixed.runId!==run.id||!run.lineage||!isDeepStrictEqual(run.lineage,lineage))throw corrupt()
   return {taskId:task.id,runId:run.id,state:run.state}
  })
 }
 async settle(owner:string,input:{itemId:string;leaseGeneration:number;taskId:string|null;runId:string|null;state:'submitted'|'unknown'|'settled'|'blocked';reason:string|null}):Promise<GroupDispatchItem>{
  actor(owner);exact(input,['itemId','leaseGeneration','taskId','runId','state','reason']);if(!uuid(input.itemId)||!positive(input.leaseGeneration)||input.taskId!==null&&!uuid(input.taskId)||input.runId!==null&&!uuid(input.runId)||input.runId!==null&&input.taskId===null||!['submitted','unknown','settled','blocked'].includes(input.state)||input.reason!==null&&(typeof input.reason!=='string'||input.reason.length>200))throw invalid()
  const receipt=await this.receipt(owner,{itemId:input.itemId})
  if(input.taskId!==receipt.taskId||input.runId!==receipt.runId)throw corrupt()
  if(input.state==='settled'&&!['accepted','active','ended','withdrawn','configuration_failed'].includes(receipt.state??''))throw corrupt()
  const row=(await this.pool.query(`update teloa_group_routing_outbox set state=$4,task_id=$5,run_id=$6,reason=$7,lineage=coalesce(lineage,(select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$5)),next_attempt_at=case when $4 in ('unknown','submitted') then $8::timestamptz+interval '5 seconds' else null end
   where owner_id=$1 and id=$2 and lease_generation=$3 and state in ('leased','unknown') returning *`,[owner,input.itemId,input.leaseGeneration,input.state,input.taskId,input.runId,input.reason,this.identity.now()])).rows[0]
  if(!row)throw new WorkError('teloa/version-conflict','群投递租约已变化，旧worker不能回写。');return item(row)
 }
 /** 原生提交前先落未知；保留当前租约截止，不让另一个worker立即领取。 */
 async reserveSubmission(owner:string,input:{itemId:string;leaseGeneration:number;taskId:string;runId:string}):Promise<void>{
  exact(input,['itemId','leaseGeneration','taskId','runId']);const receipt=await this.receipt(owner,{itemId:input.itemId});if(receipt.taskId!==input.taskId||receipt.runId!==input.runId||receipt.state!=='prepared')throw corrupt()
  await this.assertDispatch(owner,{itemId:input.itemId,leaseGeneration:input.leaseGeneration})
  const result=await this.pool.query("update teloa_group_routing_outbox set state='unknown',task_id=$4,run_id=$5,lineage=coalesce(lineage,(select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$4)) where owner_id=$1 and id=$2 and lease_generation=$3 and state='leased' and next_attempt_at>$6 returning id",[owner,input.itemId,input.leaseGeneration,input.taskId,input.runId,this.identity.now()]);if(!result.rowCount)throw new WorkError('teloa/version-conflict','群投递租约已变化。')
 }
 async recordWake(db:PoolClient,owner:string,input:{groupId:string;messageId:string}):Promise<void>{
  actor(owner);exact(input,['groupId','messageId']);if(!uuid(input.groupId)||!uuid(input.messageId))throw invalid();if(!(await db.query('select 1 from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,input.groupId,input.messageId])).rowCount)throw new WorkError('teloa/forbidden','不能为其他本人的消息登记唤醒。')
  await db.query("insert into teloa_group_routing_wakes(owner_id,group_id,message_id,created_at) values($1,$2,$3,$4) on conflict(owner_id,message_id) do nothing",[owner,input.groupId,input.messageId,this.identity.now()])
 }
 /** 回复与冻结作者/谱系及路由唤醒同事务，不依赖发布器再次 post。 */
 async recordRunMessage(db:PoolClient,owner:string,input:{messageId:string;runId:string}):Promise<void>{
  actor(owner);exact(input,['messageId','runId']);if(!uuid(input.messageId)||!uuid(input.runId))throw invalid()
  const message=(await db.query('select * from teloa_group_messages where owner_id=$1 and id=$2',[owner,input.messageId])).rows[0],raw=(await db.query('select * from teloa_task_runs where owner_id=$1 and id=$2',[owner,input.runId])).rows[0]
  if(!message||!raw)throw new WorkError('teloa/forbidden','群回复或真实运行不属于本人。');const run=readStoredTaskRun(raw)
  if(run.state!=='ended'||run.evidence?.state!=='ended')throw new WorkError('teloa/conflict','可信群回复必须来自已原生结束的真实运行。')
  if(message.run_id!==run.id||message.task_id!==run.taskId||message.author_id!==run.roleId||(run.groupContext?.groupId??readStoredRunPlanReport(raw)?.reportGroup.groupId)!==message.group_id)throw corrupt()
  if(run.roleSnapshot&&run.lineage&&run.roleId!==null&&run.roleVersion!==null){
   const fixed=await lineageService(this.pool).readInTransaction(db,owner,{taskId:run.taskId});if(!fixed||!isDeepStrictEqual(fixed,run.lineage))throw corrupt()
   const source:GroupRunSource={schema:'teloa.group-run-source/v2',ownerId:owner,taskId:run.taskId,runId:run.id,roleId:run.roleId,roleVersion:run.roleVersion,roleKind:run.roleSnapshot.kind,roleName:run.roleSnapshot.name,lineage:run.lineage}
   await db.query('insert into teloa_group_run_sources(owner_id,message_id,group_id,source,source_hash) values($1,$2,$3,$4,$5) on conflict(owner_id,message_id) do nothing',[owner,input.messageId,message.group_id,JSON.stringify(source),digest(source)])
   const saved=await readTrustedGroupMessageRunSource(db,owner,{groupId:message.group_id,messageId:message.id},this.pool);if(!saved||!isDeepStrictEqual(saved,source))throw corrupt()
  }
  await this.recordWake(db,owner,{groupId:message.group_id,messageId:message.id})
 }
 async claimWake(owner:string):Promise<GroupRoutingWake|null>{actor(owner);const row=(await this.pool.query(`update teloa_group_routing_wakes set state='leased',lease_generation=lease_generation+1,next_attempt_at=$2::timestamptz+interval '30 seconds' where (owner_id,message_id)=(select owner_id,message_id from teloa_group_routing_wakes where owner_id=$1 and state in ('pending','leased') and (next_attempt_at is null or next_attempt_at<=$2) order by created_at,message_id for update skip locked limit 1) returning *`,[owner,this.identity.now()])).rows[0];return row?{messageId:row.message_id,groupId:row.group_id,leaseGeneration:row.lease_generation}:null}
 async settleWake(owner:string,input:{messageId:string;leaseGeneration:number;settled:boolean}):Promise<void>{actor(owner);exact(input,['messageId','leaseGeneration','settled']);if(!uuid(input.messageId)||!positive(input.leaseGeneration)||typeof input.settled!=='boolean')throw invalid();const result=await this.pool.query("update teloa_group_routing_wakes set state=$4,next_attempt_at=case when $4='pending' then $5::timestamptz+interval '5 seconds' else null end where owner_id=$1 and message_id=$2 and lease_generation=$3 and state='leased'",[owner,input.messageId,input.leaseGeneration,input.settled?'settled':'pending',this.identity.now()]);if(!result.rowCount)throw new WorkError('teloa/version-conflict','群唤醒租约已变化。')}
}
