import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupDefinition,groupRoutingListInput,isGroupRoutingDecision,groupRoutedTaskRequestId,readGroupDispatchItem,readGroupRunSource,type GroupRoutingDecision,type GroupTaskCreateInput,type WorkSource,type GroupDispatchItem,type GroupRunSource} from '@teloa/contract'
import {readStoredTaskRun} from './task-runs.ts'
import {WorkLineageService} from './work-lineage.ts'
import {lockRoleWorkRole,assertRoleWorkRole} from './twin-execution-consents.ts'
import {readRoleWorkGroupGrant} from './role-delegations.ts'
import {authorizeRoleTaskAssignment} from './role-task-authorization.ts'
import {groupRoutedTaskGoal} from './group-routing-text.ts'
import {readGroupTaskSource} from './group-tasks.ts'

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
 if(run.state!=='ended'||run.evidence?.state!=='ended'||!run.roleSnapshot||!run.lineage||run.taskId!==source.taskId||run.roleId!==source.roleId||run.roleVersion!==source.roleVersion||run.roleSnapshot.kind!==source.roleKind||run.roleSnapshot.name!==source.roleName||!isDeepStrictEqual(run.lineage,source.lineage)||run.groupContext?.groupId!==input.groupId)throw corrupt()
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
  const scope=groupDefinition(group.definition).scope
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
  actor(owner);exact(input,['groupId','messageId','decision','decisionVersion']);if(!uuid(input.groupId)||!uuid(input.messageId)||input.decisionVersion!==1||!isGroupRoutingDecision(input.decision))throw invalid()
  // xmin 是32位事务身份；当前 xid8 取低32位，避免事务号绕回时误拒新决策。
  const decision=(await db.query('select decision,xmin::text::bigint=mod(pg_current_xact_id()::text::numeric,4294967296) as created_here from teloa_group_routing_decisions where owner_id=$1 and group_id=$2 and message_id=$3',[owner,input.groupId,input.messageId])).rows[0]
  if(!decision)throw new WorkError('teloa/forbidden','投递必须和真实终态群决策同事务记录。')
  if(!isDeepStrictEqual(decision.decision,input.decision))throw new WorkError('teloa/conflict','投递不能改变已确认的群决策。')
  if(!input.decision.respond.length)return []
  const prior=(await db.query('select * from teloa_group_routing_outbox where owner_id=$1 and message_id=$2 order by role_id',[owner,input.messageId])).rows
  if(prior.length){if(prior.length!==input.decision.respond.length||prior.some(r=>!input.decision.respond.includes(r.role_id)))throw corrupt();return prior.map(item)}
  if(!decision.created_here)throw new WorkError('teloa/forbidden','历史决策没有逐接收者快照，不能按当前岗位版本补造派工。')
  const source=await readTrustedGroupMessageRunSource(db,owner,{groupId:input.groupId,messageId:input.messageId},this.pool)
  const roles=[];for(const roleId of [...input.decision.respond].sort())roles.push(await lockRoleWorkRole(db,owner,roleId))
  const group=(await db.query('select * from teloa_groups where owner_id=$1 and id=$2 for share',[owner,input.groupId])).rows[0]
  if(!group||!positive(group.version))throw corrupt()
  const saved:GroupDispatchItem[]=[]
  for(const role of roles){
   const row={id:this.identity.id(),owner_id:owner,group_id:input.groupId,message_id:input.messageId,decision_version:input.decisionVersion,role_id:role.id,role_version:role.version,request_id:groupRoutedTaskRequestId(owner,input.groupId,input.messageId,role.id),group_version:group.version,state:'pending',task_id:null,run_id:null,lineage:source?{...source.lineage,parentRunId:source.runId}:null,attempts:0,next_attempt_at:null,lease_generation:0}
   await this.authorize(db,owner,row)
   const result=await db.query(`insert into teloa_group_routing_outbox(id,owner_id,group_id,message_id,decision_version,role_id,role_version,request_id,group_version,state,lineage,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',$10,$11) returning *`,[row.id,owner,input.groupId,input.messageId,input.decisionVersion,role.id,role.version,row.request_id,group.version,row.lineage===null?null:JSON.stringify(row.lineage),this.identity.now()])
   saved.push(item(result.rows[0]))
  }
  return saved
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
 async taskInput(owner:string,input:{itemId:string}):Promise<GroupTaskCreateInput>{exact(input,['itemId']);const row=await this.stored(this.pool,owner,input.itemId),fixed=item(row);return {requestId:fixed.requestId,groupId:fixed.groupId,messageId:fixed.messageId,expectedGroupVersion:row.group_version as number,goal:groupRoutedTaskGoal,assignee:{roleId:fixed.roleId,expectedVersion:fixed.roleVersion},trigger:'routed'}}
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
  if(message.run_id!==run.id||message.task_id!==run.taskId||message.author_id!==run.roleId||run.groupContext?.groupId!==message.group_id)throw corrupt()
  if(run.roleSnapshot&&run.lineage){
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
