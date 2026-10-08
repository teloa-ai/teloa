import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readWorkLineage,readWorkSource,type WorkLineage,type WorkSource} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'
export {readWorkLineage,readWorkSource} from '@teloa/contract'

type Database=Pick<Pool,'query'>
export type WorkDescendants={taskIds:string[];runIds:string[];teamMemberIds:string[]}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const reservation=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9._:-]{1,256}$/.test(value)
const occurrence=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.trim()===value&&value.length<=100&&!/[\x00-\x1f]/.test(value)
const stamp=(value:unknown):value is Date=>value instanceof Date&&Number.isFinite(value.getTime())
const invalid=()=>new WorkError('teloa/invalid-input','工作谱系请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','工作谱系或其持久来源损坏，已停止读取。')
const forbidden=()=>new WorkError('teloa/forbidden','工作来源不存在、不属于本人或与真实执行关系不一致。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value as Record<string,unknown>}
const actor=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw forbidden()}
const hash=(lineage:WorkLineage)=>createHash('sha256').update(JSON.stringify(lineage)).digest('hex')
async function present(db:Database,table:string):Promise<boolean>{return (await db.query('select to_regclass($1)::text as relation',[table])).rows[0]?.relation!==null}

/** 只要求 tasks 已建表；这里不调用 initializeTasks，也不预设计划/Run 子表存在。 */
export async function initializeWorkLineage(pool:Pool):Promise<void>{await pool.query(`
 create unique index if not exists teloa_tasks_work_identity_owner on teloa_tasks(id,owner_id);
 -- 仅持久预算身份；额度、累计记账和常驻准入由后续预算策略实现。
 create table if not exists teloa_work_budget_accounts(
  id uuid not null,owner_id text not null,created_at timestamptz not null,primary key(owner_id,id)
 );
 create table if not exists teloa_work_controls(
  id uuid not null,owner_id text not null,kind text not null check(kind in ('round','definition')),
  root_task_id uuid,budget_account_id uuid not null,state text not null check(state in ('active','pausing','paused','ending','ended')),
  generation integer not null check(generation>0),created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,id),foreign key(root_task_id,owner_id) references teloa_tasks(id,owner_id),foreign key(owner_id,budget_account_id) references teloa_work_budget_accounts(owner_id,id),
  check((kind='round' and root_task_id is not null) or (kind='definition' and root_task_id is null))
 );
 -- 过渡绑定：config_version 对应当前定义版本；升级真实 WorkDefinition 时保留控制与预算身份。
 create table if not exists teloa_work_plan_bindings(
  owner_id text not null,plan_id uuid not null,config_version integer not null check(config_version>0),
  definition_control_id uuid not null,budget_account_id uuid not null,created_at timestamptz not null,
  primary key(owner_id,plan_id,config_version),unique(owner_id,definition_control_id),
  foreign key(owner_id,definition_control_id) references teloa_work_controls(owner_id,id),foreign key(owner_id,budget_account_id) references teloa_work_budget_accounts(owner_id,id)
 );
 create table if not exists teloa_task_work_lineage(
  owner_id text not null,task_id uuid not null,source jsonb not null check(jsonb_typeof(source)='object'),lineage jsonb not null check(jsonb_typeof(lineage)='object'),
  lineage_hash text not null check(lineage_hash ~ '^[a-f0-9]{64}$'),root_task_id uuid not null,parent_run_id uuid,definition_control_id uuid,round_control_id uuid not null,
  control_generation integer not null check(control_generation>0),budget_account_id uuid not null,created_at timestamptz not null,
  primary key(owner_id,task_id),foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),foreign key(root_task_id,owner_id) references teloa_tasks(id,owner_id),
  foreign key(owner_id,definition_control_id) references teloa_work_controls(owner_id,id),foreign key(owner_id,round_control_id) references teloa_work_controls(owner_id,id),foreign key(owner_id,budget_account_id) references teloa_work_budget_accounts(owner_id,id)
 );
 create index if not exists teloa_task_work_lineage_round on teloa_task_work_lineage(owner_id,round_control_id,task_id);
 create index if not exists teloa_task_work_lineage_definition on teloa_task_work_lineage(owner_id,definition_control_id,task_id) where definition_control_id is not null;
 create or replace function teloa_reject_work_lineage_mutation() returns trigger language plpgsql as $$ begin raise exception 'work lineage bindings are immutable'; end $$;
 drop trigger if exists teloa_task_work_lineage_immutable on teloa_task_work_lineage;
 create trigger teloa_task_work_lineage_immutable before update or delete on teloa_task_work_lineage for each row execute function teloa_reject_work_lineage_mutation();
 drop trigger if exists teloa_work_plan_bindings_immutable on teloa_work_plan_bindings;
 create trigger teloa_work_plan_bindings_immutable before update or delete on teloa_work_plan_bindings for each row execute function teloa_reject_work_lineage_mutation();
`)}

export class WorkLineageService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async task(db:Database,owner:string,taskId:string,lock=false){
  const row=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2'+(lock?' for update':''),[owner,taskId])).rows[0]
  if(!row)throw forbidden();readStoredTask(row);if(!uuid(row.request_id))throw corrupt();return row
 }
 private async control(db:Database,owner:string,id:string){
  const row=(await db.query('select * from teloa_work_controls where owner_id=$1 and id=$2',[owner,id])).rows[0]
  if(!row||row.owner_id!==owner||!uuid(row.id)||!uuid(row.budget_account_id)||!positive(row.generation)||!['active','pausing','paused','ending','ended'].includes(row.state)||!['round','definition'].includes(row.kind)||!stamp(row.created_at)||!stamp(row.updated_at)||row.kind==='round'&&!uuid(row.root_task_id)||row.kind==='definition'&&row.root_task_id!==null)throw corrupt()
  return row
 }
 private async parent(db:Database,owner:string,source:Extract<WorkSource,{kind:'group-run-message'|'team-child'}>):Promise<{runId:string;taskId:string}>{
  if(!await present(db,'teloa_task_runs'))throw forbidden()
  const runId=source.kind==='team-child'?source.parentRunId:source.runId
  const run=(await db.query('select r.id,r.owner_id,r.task_id,r.role_id,r.state from teloa_task_runs r join teloa_roles role on role.id=r.role_id and role.owner_id=r.owner_id where r.owner_id=$1 and r.id=$2',[owner,runId])).rows[0]
  // 当前 Run 结局不抹掉已发生的派生关系；执行许可和停止准入由上层负责。
  if(!run||!uuid(run.task_id)||!uuid(run.role_id)||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(run.state))throw forbidden()
  await this.task(db,owner,run.task_id)
  if(source.kind==='group-run-message'){
   if(!await present(db,'teloa_group_messages'))throw forbidden()
   const message=(await db.query('select owner_id,task_id,run_id,author_id from teloa_group_messages where owner_id=$1 and id=$2 for share',[owner,source.messageId])).rows[0]
   if(!message||message.owner_id!==owner||message.run_id!==run.id||message.task_id!==run.task_id||message.author_id!==run.role_id)throw forbidden()
  }else{
   if(!await present(db,'teloa_task_run_subagents'))throw forbidden()
   const child=(await db.query('select owner_id,run_id,reservation_id,state from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and reservation_id=$3 for share',[owner,runId,source.memberId])).rows[0]
   if(!child||child.owner_id!==owner||child.run_id!==run.id||child.reservation_id!==source.memberId||!['reserved','started','ended','abandoned'].includes(child.state))throw forbidden()
  }
  return {runId:run.id,taskId:run.task_id}
 }
 private async plan(db:Database,owner:string,task:Record<string,unknown>,claimId:string):Promise<NonNullable<WorkLineage['definition']>>{
  if(!await present(db,'teloa_plan_occurrences')||!await present(db,'teloa_plans'))throw forbidden()
  const row=(await db.query('select o.*,p.owner_id as plan_owner_id from teloa_plan_occurrences o join teloa_plans p on p.id=o.plan_id and p.owner_id=o.owner_id where o.owner_id=$1 and o.id=$2 for share of o,p',[owner,claimId])).rows[0]
  if(!row||row.owner_id!==owner||row.plan_owner_id!==owner||row.task_request_id!==task.request_id)throw forbidden()
  if(!uuid(row.plan_id)||!positive(row.plan_version)||!positive(row.config_version)||!occurrence(row.occurrence_id)||!stamp(row.scheduled_at)||!stamp(row.claimed_at)||row.claimed_at<row.scheduled_at)throw corrupt()
  if(await present(db,'teloa_plan_task_links')){
   const link=(await db.query('select owner_id,task_request_id,task_id from teloa_plan_task_links where claim_id=$1',[claimId])).rows[0]
   if(link&&(link.owner_id!==owner||link.task_request_id!==task.request_id||link.task_id!==task.id))throw corrupt()
  }
  return {planId:row.plan_id,definitionVersion:row.config_version,occurrenceId:row.occurrence_id}
 }
 private async stored(db:Database,owner:string,task:Record<string,unknown>,row:Record<string,unknown>,path=new Set<string>()):Promise<WorkLineage>{
  try{
   if(path.has(task.id as string))throw Error();path.add(task.id as string)
   const lineage=readWorkLineage(row.lineage),source=readWorkSource(row.source)
   if(row.owner_id!==owner||row.task_id!==task.id||lineage.ownerId!==owner||hash(lineage)!==row.lineage_hash||!stamp(row.created_at)||row.root_task_id!==lineage.rootTaskId||row.parent_run_id!==lineage.parentRunId||row.definition_control_id!==lineage.definitionControlId||row.round_control_id!==lineage.roundControlId||row.control_generation!==lineage.controlGeneration||row.budget_account_id!==lineage.budgetAccountId)throw Error()
   const round=await this.control(db,owner,lineage.roundControlId),budget=(await db.query('select id,owner_id,created_at from teloa_work_budget_accounts where owner_id=$1 and id=$2',[owner,lineage.budgetAccountId])).rows[0]
   if(round.kind!=='round'||round.root_task_id!==lineage.rootTaskId||round.budget_account_id!==lineage.budgetAccountId||round.generation<lineage.controlGeneration||!budget||budget.owner_id!==owner||!stamp(budget.created_at))throw Error()
   await this.task(db,owner,lineage.rootTaskId)
   if(lineage.definition!==null){
    const definition=await this.control(db,owner,lineage.definitionControlId!),binding=(await db.query('select * from teloa_work_plan_bindings where owner_id=$1 and plan_id=$2 and config_version=$3',[owner,lineage.definition.planId,lineage.definition.definitionVersion])).rows[0]
    if(definition.kind!=='definition'||definition.budget_account_id!==lineage.budgetAccountId||!binding||binding.definition_control_id!==lineage.definitionControlId||binding.budget_account_id!==lineage.budgetAccountId||!stamp(binding.created_at))throw Error()
   }
   if(source.kind==='owner-task'){
    if(source.taskId!==task.id||lineage.rootTaskId!==task.id||lineage.parentRunId!==null||lineage.definition!==null)throw Error()
   }else if(source.kind==='plan-occurrence'){
    const definition=await this.plan(db,owner,task,source.claimId)
    if(lineage.rootTaskId!==task.id||lineage.parentRunId!==null||!isDeepStrictEqual(definition,lineage.definition))throw Error()
   }else{
    const parent=await this.parent(db,owner,source),parentTask=await this.task(db,owner,parent.taskId),parentRow=(await db.query('select * from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,parent.taskId])).rows[0]
    if(!parentRow)throw Error()
    const inherited=await this.stored(db,owner,parentTask,parentRow,path)
    if(!isDeepStrictEqual(lineage,{...inherited,parentRunId:parent.runId}))throw Error()
   }
   return lineage
  }catch{throw corrupt()}
 }
 private fresh(){const id=this.identity.id();if(!uuid(id))throw corrupt();return id.toLowerCase()}
 private async newBudget(db:Database,owner:string,now:string){const id=this.fresh();await db.query('insert into teloa_work_budget_accounts(id,owner_id,created_at) values($1,$2,$3)',[id,owner,now]);return id}
 private async newControl(db:Database,owner:string,kind:'round'|'definition',root:string|null,budget:string,now:string){
  const id=this.fresh();await db.query("insert into teloa_work_controls(id,owner_id,kind,root_task_id,budget_account_id,state,generation,created_at,updated_at) values($1,$2,$3,$4,$5,'active',1,$6,$6)",[id,owner,kind,root,budget,now]);return id
 }
 /** 必须使用调用方已启动的 Task 创建事务；本服务不提交或回滚外层事务。 */
 async bindTask(client:PoolClient,owner:string,input:{taskId:string;source:WorkSource}):Promise<WorkLineage>{
  actor(owner);const request=exact(input,['taskId','source']);if(!uuid(request.taskId))throw invalid()
  const source=readWorkSource(request.source),task=await this.task(client,owner,request.taskId.toLowerCase(),true)
  const prior=(await client.query('select * from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,task.id])).rows[0]
  if(prior){let fixed:WorkSource;try{fixed=readWorkSource(prior.source)}catch{throw corrupt()};if(!isDeepStrictEqual(fixed,source))throw new WorkError('teloa/conflict','任务已有固定工作来源，不能覆盖。');return this.stored(client,owner,task,prior)}
  let lineage:WorkLineage
  const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw corrupt()
  if(source.kind==='owner-task'||source.kind==='plan-occurrence'){
   if(source.kind==='owner-task'&&source.taskId!==task.id)throw forbidden()
   const definition=source.kind==='plan-occurrence'?await this.plan(client,owner,task,source.claimId):null
   let budget:string,definitionControl:string|null=null
   if(definition){
    await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/work-definition',owner,definition.planId,definition.definitionVersion])])
    const binding=(await client.query('select * from teloa_work_plan_bindings where owner_id=$1 and plan_id=$2 and config_version=$3',[owner,definition.planId,definition.definitionVersion])).rows[0]
    if(binding){const control=await this.control(client,owner,binding.definition_control_id);if(control.kind!=='definition'||control.budget_account_id!==binding.budget_account_id||!stamp(binding.created_at))throw corrupt();budget=binding.budget_account_id;definitionControl=binding.definition_control_id}
    else{budget=await this.newBudget(client,owner,now);definitionControl=await this.newControl(client,owner,'definition',null,budget,now);await client.query('insert into teloa_work_plan_bindings(owner_id,plan_id,config_version,definition_control_id,budget_account_id,created_at) values($1,$2,$3,$4,$5,$6)',[owner,definition.planId,definition.definitionVersion,definitionControl,budget,now])}
   }else budget=await this.newBudget(client,owner,now)
   const round=await this.newControl(client,owner,'round',task.id,budget,now)
   lineage={schema:'teloa.work-lineage/v1',ownerId:owner,rootTaskId:task.id,definition,parentRunId:null,definitionControlId:definitionControl,roundControlId:round,controlGeneration:1,budgetAccountId:budget}
  }else{
   const parent=await this.parent(client,owner,source),parentTask=await this.task(client,owner,parent.taskId),parentRow=(await client.query('select * from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,parent.taskId])).rows[0]
   if(!parentRow)throw new WorkError('teloa/conflict','父任务没有已保存的工作谱系，不能推断控制与预算。')
   const inherited=await this.stored(client,owner,parentTask,parentRow)
   lineage={...inherited,parentRunId:parent.runId}
  }
  await client.query('insert into teloa_task_work_lineage(owner_id,task_id,source,lineage,lineage_hash,root_task_id,parent_run_id,definition_control_id,round_control_id,control_generation,budget_account_id,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[owner,task.id,JSON.stringify(source),JSON.stringify(lineage),hash(lineage),lineage.rootTaskId,lineage.parentRunId,lineage.definitionControlId,lineage.roundControlId,lineage.controlGeneration,lineage.budgetAccountId,now])
  return lineage
 }
 async read(owner:string,input:{taskId:string}):Promise<WorkLineage|null>{
  return this.readInTransaction(this.pool,owner,input)
 }
 /** Task/Run 固定输入使用调用方事务，能看见同事务刚写入的根与预算身份。 */
 async readInTransaction(db:Database,owner:string,input:{taskId:string}):Promise<WorkLineage|null>{
  actor(owner);const request=exact(input,['taskId']);if(!uuid(request.taskId))throw invalid()
  const task=await this.task(db,owner,request.taskId.toLowerCase())
  if(!await present(db,'teloa_task_work_lineage'))return null
  const row=(await db.query('select * from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,task.id])).rows[0]
  return row?this.stored(db,owner,task,row):null
 }
 async descendants(owner:string,input:{controlId:string}):Promise<WorkDescendants>{return this.descendantsUsing(this.pool,owner,input)}
 /** 已持有外层事务时复用同一连接，不能再次从池中借连接。 */
 async descendantsInTransaction(db:PoolClient,owner:string,input:{controlId:string}):Promise<WorkDescendants>{return this.descendantsUsing(db,owner,input)}
 private async descendantsUsing(db:Database,owner:string,input:{controlId:string}):Promise<WorkDescendants>{
  actor(owner);const request=exact(input,['controlId']);if(!uuid(request.controlId))throw invalid()
  const empty:WorkDescendants={taskIds:[],runIds:[],teamMemberIds:[]}
  if(!await present(db,'teloa_work_controls')||!await present(db,'teloa_task_work_lineage'))return empty
  const exists=(await db.query('select id from teloa_work_controls where owner_id=$1 and id=$2',[owner,request.controlId])).rows[0]
  if(!exists)throw forbidden()
  const control=await this.control(db,owner,request.controlId),rows=(await db.query(`select * from teloa_task_work_lineage where owner_id=$1 and ${control.kind==='definition'?'definition_control_id':'round_control_id'}=$2 order by task_id`,[owner,control.id])).rows
  const taskIds:string[]=[]
  for(const row of rows){const task=await this.task(db,owner,row.task_id);await this.stored(db,owner,task,row);taskIds.push(task.id)}
  if(!taskIds.length||!await present(db,'teloa_task_runs'))return {...empty,taskIds}
  const runs=(await db.query('select r.id,r.task_id,r.owner_id from teloa_task_runs r join teloa_tasks t on t.id=r.task_id and t.owner_id=r.owner_id where r.owner_id=$1 and r.task_id=any($2::uuid[]) order by r.id',[owner,taskIds])).rows
  if(runs.some(row=>!uuid(row.id)||row.owner_id!==owner||!taskIds.includes(row.task_id)))throw corrupt()
  const runIds:string[]=runs.map(row=>row.id)
  if(!runIds.length||!await present(db,'teloa_task_run_subagents'))return {taskIds,runIds,teamMemberIds:[]}
  const members=(await db.query("select owner_id,run_id,reservation_id,state,created_at from teloa_task_run_subagents where owner_id=$1 and run_id=any($2::uuid[]) and state in ('reserved','started') order by reservation_id",[owner,runIds])).rows
  if(members.some(row=>row.owner_id!==owner||!runIds.includes(row.run_id)||!reservation(row.reservation_id)||!stamp(row.created_at)||!['reserved','started'].includes(row.state)))throw corrupt()
  return {taskIds,runIds,teamMemberIds:members.map(row=>row.reservation_id)}
 }
}
