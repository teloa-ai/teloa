import {lockConversationTaskParent,assertConversationTaskOpen} from './conversation-work-task-protection.ts'
import {initializePlanSchedulerStatus} from './plan-scheduler-status.ts'
import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,nextScheduleOccurrence,readScheduleTrigger,roleDefinition,roleSupportsScope,taskDefinition,workTaskStates,type ScheduleTrigger,type WorkTask} from '@teloa/contract'
import {initializeTasks,TaskService,readStoredTask} from './tasks.ts'
import {readStoredTaskRun} from './task-runs.ts'
import {initializePlans,planNotificationPolicies,verifyPlanSource,type PlanNotificationPolicy,type PlanSource,type PlanMarketSources} from './plans.ts'

export type PlanOccurrenceFields={title:string;goal:string;scope:string;dataScope:string;delivery:string;roleId:string;trigger:ScheduleTrigger;notificationPolicy?:PlanNotificationPolicy}
export type PlanOccurrence={id:string;ownerId:string;planId:string;planVersion:number;configVersion:number;occurrenceId:string;scheduledAt:string;claimedAt:string;taskRequestId:string;fields:PlanOccurrenceFields;source:PlanSource;roleVersion:number;invalidated?:{reason:'plan-paused'|'plan-archived'|'plan-version-changed';observedPlanUpdatedAt:string};taskRequest:{requestId:string;fields:{title:string;goal:string;scope:string};assignee:{roleId:string;expectedVersion:number}}}
export type PlanScheduleSkip={planId:string;planVersion:number;configVersion:number;occurrenceId:string;scheduledAt:string;skippedAt:string;reason:'previous-pending'|'previous-task-unfinished';blockingClaimId:string;taskId:string|null}
export type PlanSkipHistoryCursor={skippedAt:string;configVersion:number;occurrenceId:string}
export type PlanSkipHistoryPage={items:PlanScheduleSkip[];errors?:Array<PlanSkipHistoryCursor&{code:'teloa/storage-corrupt'}>;cursor?:PlanSkipHistoryCursor}
export type PlanExecutionCursor={claimedAt:string;claimId:string}
export type PlanExecutionHistoryCursor={claimedAt:string;claimId:string}
export type PlanExecutionHistoryItem={
 claimId:string;planId:string;occurrenceId:string;planVersion:number;configVersion:number;scheduledAt:string;claimedAt:string
 notificationPolicy?:PlanNotificationPolicy
 task:{id:string;state:WorkTask['state']}|null
 run:{id:string;state:'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed';sessionId:string;createdAt:string}|null
}
export type PlanExecutionHistoryPage={items:PlanExecutionHistoryItem[];errors?:{claimId:string;code:'teloa/storage-corrupt'}[];cursor?:PlanExecutionHistoryCursor}
export type PlanExecutionRunState=NonNullable<PlanExecutionHistoryItem['run']>['state']|'not-started'
export type PendingPlanExecution={
 planId:string
 job:{claimId:string;taskId:string;taskCreatedVersion:1;taskTitle:string;roleId:string;roleVersion:number}
}&({action:'prepare';run:null}|{action:'skip';reason:'task-ended';run:null}|{action:'start'|'reconcile';run:{id:string;state:'prepared'|'submitting'|'accepted'|'active';sessionId:string;nativeRequestId:string}})
type CurrentPlan={id:string;ownerId:string;version:number;configVersion:number;state:'paused'|'active'|'archived';updatedAt:string;fields:PlanOccurrenceFields;source:PlanSource;roleVersion:number}
type ScheduleState={planId:string;ownerId:string;planVersion:number;configVersion:number;nextAt:string;occurrenceId:string}

const invalid=()=>new WorkError('teloa/invalid-input','持续计划日程领取请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','持续计划日程游标或领取记录损坏，已停止处理。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const hash=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{64}$/.test(value)
const stableId=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const semver=(value:unknown):value is string=>typeof value==='string'&&value.length<=80&&/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const moment=(value:unknown):string=>{if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value))throw invalid();const parsed=new Date(value),canonical=value.includes('.')?value:value.replace('Z','.000Z');if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==canonical)throw invalid();return canonical}
const scheduledOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\[(?:Asia\/Singapore|Asia\/Shanghai|UTC)\]$/.test(value)
const manualOccurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&/^manual:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const occurrenceIdentity=(value:unknown):value is string=>typeof value==='string'&&value.length<=100&&(scheduledOccurrenceIdentity(value)||manualOccurrenceIdentity(value))
const notificationPolicy=(value:unknown):value is PlanNotificationPolicy=>planNotificationPolicies.some(policy=>policy===value)

function readSource(value:unknown):PlanSource{
 const row=exact(value,['kind','contentId','contentHash','resourceId','resourceVersion','roleId'])
 if(row.kind==='manual'){if(Object.keys(row).length!==1)throw invalid();return {kind:'manual'}}
 if(row.kind==='system-digest'){if(Object.keys(row).length!==2||!uuid(row.roleId))throw invalid();return {kind:'system-digest',roleId:row.roleId}}
 if(row.kind!=='market-content'||Object.keys(row).length!==5||!uuid(row.contentId)||!hash(row.contentHash)||!stableId(row.resourceId)||!semver(row.resourceVersion))throw invalid()
 return {kind:'market-content',contentId:row.contentId,contentHash:row.contentHash,resourceId:row.resourceId,resourceVersion:row.resourceVersion}
}
function readFields(value:unknown):PlanOccurrenceFields{
 const row=exact(value,['title','goal','scope','dataScope','delivery','roleId','trigger','notificationPolicy']),base=taskDefinition({title:row.title,goal:row.goal,scope:row.scope})
 if(!text(row.dataScope,8000)||!text(row.delivery,8000)||!uuid(row.roleId))throw invalid()
 if(row.notificationPolicy!==undefined&&!notificationPolicy(row.notificationPolicy))throw invalid()
 let trigger:ScheduleTrigger;try{trigger=readScheduleTrigger(row.trigger)}catch{throw invalid()}
 return {title:base.title,goal:base.goal,scope:base.scope,dataScope:row.dataScope.trim(),delivery:row.delivery.trim(),roleId:row.roleId,trigger,...(row.notificationPolicy===undefined?{}:{notificationPolicy:row.notificationPolicy})}
}
function readSnapshot(value:unknown):{fields:PlanOccurrenceFields;source:PlanSource;roleVersion:number}{
 const row=exact(value,['fields','source','roleVersion']);if(!positive(row.roleVersion))throw invalid()
 return {fields:readFields(row.fields),source:readSource(row.source),roleVersion:row.roleVersion}
}
function snapshotHash(value:ReturnType<typeof readSnapshot>):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex')}
function same(a:unknown,b:unknown):boolean{return JSON.stringify(a)===JSON.stringify(b)}
function readPlan(row:Record<string,unknown>):CurrentPlan{
 try{
  const fields=readFields(row.definition),source=readSource(row.source)
  if(!uuid(row.id)||!text(row.owner_id,128)||row.role_id!==fields.roleId||row.scope!==fields.scope||row.notification_policy!==(fields.notificationPolicy??null)||!positive(row.role_version)||!positive(row.version)||!positive(row.config_version)||!['paused','active','archived'].includes(String(row.state)))throw Error()
  const request=exact(row.request_spec,['fields','source']),requestFields=exact(request.fields,['title','goal','scope','dataScope','delivery','roleId','expectedRoleVersion','trigger','notificationPolicy']),{expectedRoleVersion,...definition}=requestFields
  if(!positive(expectedRoleVersion)||expectedRoleVersion!==row.role_version||definition.roleId!==fields.roleId||definition.scope!==fields.scope||!same(readSource(request.source),source)||(Number(row.config_version)===1&&!same(readFields(definition),fields)))throw Error()
  return {id:row.id,ownerId:row.owner_id,version:row.version,configVersion:row.config_version,state:row.state as CurrentPlan['state'],updatedAt:stamp(row.updated_at),fields,source,roleVersion:row.role_version}
 }catch(error){if(error instanceof WorkError&&error.code==='teloa/storage-corrupt')throw error;throw corrupt()}
}
function expectedOccurrence(trigger:ScheduleTrigger,scheduledAt:string){return nextScheduleOccurrence(trigger,new Date(Date.parse(scheduledAt)-1).toISOString())}
function readState(row:Record<string,unknown>,plan:CurrentPlan):ScheduleState{
 try{
  const nextAt=stamp(row.next_at)
  if(!uuid(row.plan_id)||row.plan_id!==plan.id||row.owner_id!==plan.ownerId||!positive(row.plan_version)||!positive(row.config_version)||!occurrenceIdentity(row.occurrence_id))throw Error()
  if(row.plan_version===plan.version&&row.config_version===plan.configVersion){const expected=expectedOccurrence(plan.fields.trigger,nextAt);if(expected.at!==nextAt||expected.occurrenceId!==row.occurrence_id)throw Error()}
  return {planId:row.plan_id,ownerId:row.owner_id,planVersion:row.plan_version,configVersion:row.config_version,nextAt,occurrenceId:row.occurrence_id}
 }catch{throw corrupt()}
}
function readOccurrence(row:Record<string,unknown>):PlanOccurrence{
 try{
  const snapshot=readSnapshot(row.snapshot),scheduledAt=stamp(row.scheduled_at),claimedAt=stamp(row.claimed_at)
  const scheduled=scheduledOccurrenceIdentity(row.occurrence_id),manual=manualOccurrenceIdentity(row.occurrence_id)
  const expected=scheduled?expectedOccurrence(snapshot.fields.trigger,scheduledAt):undefined
  if(!hash(row.snapshot_hash)||row.snapshot_hash!==snapshotHash(snapshot)||!uuid(row.id)||!uuid(row.plan_id)||!text(row.owner_id,128)||!positive(row.plan_version)||!positive(row.config_version)||!uuid(row.task_request_id)||!occurrenceIdentity(row.occurrence_id)||scheduled&&(!expected||expected.at!==scheduledAt||expected.occurrenceId!==row.occurrence_id||claimedAt<scheduledAt)||manual&&(row.occurrence_id!=='manual:'+row.task_request_id||claimedAt!==scheduledAt))throw Error()
  return {id:row.id,ownerId:row.owner_id,planId:row.plan_id,planVersion:row.plan_version,configVersion:row.config_version,occurrenceId:row.occurrence_id,scheduledAt,claimedAt,taskRequestId:row.task_request_id,fields:snapshot.fields,source:snapshot.source,roleVersion:snapshot.roleVersion,taskRequest:{requestId:row.task_request_id,fields:{title:snapshot.fields.title,goal:snapshot.fields.goal,scope:snapshot.fields.scope},assignee:{roleId:snapshot.fields.roleId,expectedVersion:snapshot.roleVersion}}}
 }catch{throw corrupt()}
}

const occurrenceOverview=`select o.*,p.version as current_plan_version,p.config_version as current_config_version,p.state as current_plan_state,p.updated_at as current_plan_updated_at,
 t.id as actual_task_id,t.state as actual_task_state from teloa_plan_occurrences o
 join teloa_plans p on p.id=o.plan_id and p.owner_id=o.owner_id
 left join teloa_tasks t on t.owner_id=o.owner_id and t.request_id=o.task_request_id`
function observedOccurrence(row:Record<string,unknown>):{occurrence:PlanOccurrence;task:{id:string;state:WorkTask['state']}|null}{
 const occurrence=readOccurrence(row)
 if(!positive(row.current_plan_version)||!positive(row.current_config_version)||!['active','paused','archived'].includes(String(row.current_plan_state)))throw corrupt()
 let task:{id:string;state:WorkTask['state']}|null=null
 if(row.actual_task_id!==null){
  if(!uuid(row.actual_task_id)||!workTaskStates.some(state=>state===row.actual_task_state))throw corrupt()
  task={id:row.actual_task_id,state:row.actual_task_state as WorkTask['state']}
 }else if(row.actual_task_state!==null)throw corrupt()
 // 这是当前计划依据的观察时间，不是首次失效时间；已经创建的任务仍可恢复原关联。
 if(!task&&(row.current_plan_state!=='active'||row.current_plan_version!==occurrence.planVersion||row.current_config_version!==occurrence.configVersion)){
  occurrence.invalidated={reason:row.current_plan_state==='paused'?'plan-paused':row.current_plan_state==='archived'?'plan-archived':'plan-version-changed',observedPlanUpdatedAt:stamp(row.current_plan_updated_at)}
 }
 return {occurrence,task}
}
const skipOverview=`select s.*,o.owner_id as blocking_owner_id,o.plan_id as blocking_plan_id,o.task_request_id as blocking_task_request_id,
 t.owner_id as task_owner_id,t.request_id as actual_request_id from teloa_plan_schedule_skips s
 left join teloa_plan_occurrences o on o.id=s.blocking_claim_id left join teloa_tasks t on t.id=s.task_id`
function readSkip(row:Record<string,unknown>):PlanScheduleSkip{
 if(!uuid(row.plan_id)||!text(row.owner_id,128)||!positive(row.plan_version)||!positive(row.config_version)||!occurrenceIdentity(row.occurrence_id)||!uuid(row.blocking_claim_id)||row.blocking_owner_id!==row.owner_id||row.blocking_plan_id!==row.plan_id)throw corrupt()
 if(row.reason==='previous-pending'){if(row.task_id!==null)throw corrupt()}
 else if(row.reason==='previous-task-unfinished'){if(!uuid(row.task_id)||row.task_owner_id!==row.owner_id||row.actual_request_id!==row.blocking_task_request_id)throw corrupt()}
 else throw corrupt()
 const scheduledAt=stamp(row.scheduled_at),skippedAt=stamp(row.skipped_at)
 if(skippedAt<scheduledAt)throw corrupt()
 return {planId:row.plan_id,planVersion:row.plan_version,configVersion:row.config_version,occurrenceId:row.occurrence_id,scheduledAt,skippedAt,reason:row.reason,blockingClaimId:row.blocking_claim_id,taskId:row.task_id as string|null}
}

export async function initializePlanOccurrences(pool:Pool):Promise<void>{
 await initializePlans(pool)
 await initializeTasks(pool)
 await pool.query(`create table if not exists teloa_plan_schedule_state(
  plan_id uuid primary key,owner_id text not null,plan_version integer not null check(plan_version>0),config_version integer not null check(config_version>0),
  next_at timestamptz not null,occurrence_id text not null check(length(occurrence_id) between 1 and 100),updated_at timestamptz not null,
  unique(plan_id,owner_id),foreign key(plan_id,owner_id) references teloa_plans(id,owner_id)
 );
 create table if not exists teloa_plan_occurrences(
  id uuid primary key,owner_id text not null,plan_id uuid not null,plan_version integer not null check(plan_version>0),config_version integer not null check(config_version>0),
  occurrence_id text not null check(length(occurrence_id) between 1 and 100),scheduled_at timestamptz not null,claimed_at timestamptz not null,
  task_request_id uuid not null unique,snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),snapshot_hash text not null check(snapshot_hash ~ '^[0-9a-f]{64}$'),
  unique(plan_id,config_version,occurrence_id),foreign key(plan_id,owner_id) references teloa_plans(id,owner_id)
 );
 create table if not exists teloa_plan_task_links(
  claim_id uuid primary key references teloa_plan_occurrences(id),owner_id text not null,
  task_request_id uuid not null unique,task_id uuid not null unique references teloa_tasks(id)
 );
 create index if not exists teloa_plan_occurrences_recovery_order on teloa_plan_occurrences(owner_id,claimed_at,id);
 create table if not exists teloa_plan_schedule_skips(
  plan_id uuid not null,owner_id text not null,plan_version integer not null check(plan_version>0),config_version integer not null check(config_version>0),
  occurrence_id text not null,scheduled_at timestamptz not null,skipped_at timestamptz not null check(skipped_at>=scheduled_at),
  reason text not null check(reason in ('previous-pending','previous-task-unfinished')),blocking_claim_id uuid not null references teloa_plan_occurrences(id),task_id uuid references teloa_tasks(id),
  check((reason='previous-pending' and task_id is null) or (reason='previous-task-unfinished' and task_id is not null)),
  primary key(plan_id,config_version,occurrence_id),foreign key(plan_id,owner_id) references teloa_plans(id,owner_id)
 )`)
 await initializePlanSchedulerStatus(pool)
}

export class PlanOccurrenceService{
 readonly pool:Pool
 readonly identity:{id:()=>string}
 readonly marketSources:PlanMarketSources|undefined
 constructor(pool:Pool,identity:{id:()=>string},marketSources?:PlanMarketSources){this.pool=pool;this.identity=identity;this.marketSources=marketSources}
 private input(owner:string,value:unknown):{planId:string;now:string}{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const row=exact(value,['planId','now']);if(!uuid(row.planId))throw invalid();return {planId:row.planId,now:moment(row.now)}
 }
 private async current(db:PoolClient,owner:string,planId:string,exclusiveRole=false):Promise<CurrentPlan>{
  const preview=(await db.query('select * from teloa_plans where id=$1 and owner_id=$2',[planId,owner])).rows[0] as Record<string,unknown>|undefined
  if(!preview)throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  const observed=readPlan(preview),role=(await db.query(exclusiveRole?'select * from teloa_roles where id=$1 and owner_id=$2 for update':'select * from teloa_roles where id=$1 and owner_id=$2 for share',[observed.fields.roleId,owner])).rows[0] as Record<string,unknown>|undefined
  if(!role)throw corrupt()
  const locked=readPlan((await db.query('select * from teloa_plans where id=$1 and owner_id=$2 for update',[planId,owner])).rows[0])
  if(locked.fields.roleId!==observed.fields.roleId)throw corrupt()
  if(locked.state!=='active')throw new WorkError('teloa/conflict','只有已启用的持续计划可以领取日程。')
  let definition:ReturnType<typeof roleDefinition>;try{definition=roleDefinition(role.definition)}catch{throw corrupt()}
  /**
   * 用户建的计划按创建时固定的岗位版本领取：岗位改过就该由本人重新核对。
   * Auto Dream 的系统计划相反——它随岗位生命周期走，而暂停与复岗本身各把岗位版本加一，
   * 按固定版本核对会让复岗后的小结永远领不到日程（计划回到 active 却次次 version-conflict）。
   * 与 `plans.ts` 的 `enable` 判据同一口径：只放宽版本这一条，紧随其后的在岗、AI 员工、
   * 范围仍覆盖计划所属业务三条一字不变。
   */
  if(locked.source.kind!=='system-digest'&&role.version!==locked.roleVersion)throw new WorkError('teloa/version-conflict','负责员工版本已变化，停止领取计划日程。')
  if(role.state!=='active'||definition.kind!=='employee')throw new WorkError('teloa/conflict','负责员工当前不能领取计划日程。')
  if(!roleSupportsScope(definition.scopes,locked.fields.scope))throw new WorkError('teloa/forbidden','负责员工不再支持计划所属业务。')
  await verifyPlanSource(owner,locked.source,this.marketSources)
  // 系统计划跟随岗位，但本次领取必须固定当前岗位版本；后续建任务及重放都使用这份快照。
  return locked.source.kind==='system-digest'?{...locked,roleVersion:Number(role.version)}:locked
 }
 private async saveState(db:PoolClient,plan:CurrentPlan,after:string):Promise<ScheduleState>{
  const next=nextScheduleOccurrence(plan.fields.trigger,after)
  const row=(await db.query(`insert into teloa_plan_schedule_state(plan_id,owner_id,plan_version,config_version,next_at,occurrence_id,updated_at)
   values($1,$2,$3,$4,$5,$6,$7) on conflict(plan_id) do update set owner_id=excluded.owner_id,plan_version=excluded.plan_version,config_version=excluded.config_version,next_at=excluded.next_at,occurrence_id=excluded.occurrence_id,updated_at=excluded.updated_at returning *`,[plan.id,plan.ownerId,plan.version,plan.configVersion,next.at,next.occurrenceId,after])).rows[0]
  return readState(row,plan)
 }
 async recover(owner:string,input:unknown):Promise<{nextAt:string;occurrenceId:string}>{
  const value=this.input(owner,input),db=await this.pool.connect()
  try{await db.query('begin');const plan=await this.current(db,owner,value.planId),state=await this.saveState(db,plan,value.now);await db.query('commit');return {nextAt:state.nextAt,occurrenceId:state.occurrenceId}}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async claim(owner:string,input:unknown):Promise<{occurrence:PlanOccurrence|null;dispatch:boolean;skip?:PlanScheduleSkip}>{
  const value=this.input(owner,input),db=await this.pool.connect()
  try{
   await db.query('begin');const plan=await this.current(db,owner,value.planId)
   const row=(await db.query('select * from teloa_plan_schedule_state where plan_id=$1 and owner_id=$2 for update',[plan.id,owner])).rows[0] as Record<string,unknown>|undefined
   let state=row?readState(row,plan):await this.saveState(db,plan,plan.updatedAt)
   if(state.planVersion!==plan.version||state.configVersion!==plan.configVersion)state=await this.saveState(db,plan,plan.updatedAt)
   if(state.nextAt>value.now){await db.query('commit');return {occurrence:null,dispatch:false}}
   // 只取尚未结束的候选；未知状态仍落入候选，由读取白名单显式拒绝。
   const history=(await db.query(occurrenceOverview+` where o.owner_id=$1 and o.plan_id=$2 and (
    (t.id is not null and t.state not in ('completed','cancelled')) or
    (t.id is null and p.state='active' and o.plan_version=p.version and o.config_version=p.config_version)
   ) order by o.scheduled_at,o.id limit 1`,[owner,plan.id])).rows.map(observedOccurrence)
   const blocking=history.find(({occurrence,task})=>task?!['completed','cancelled'].includes(task.state):!occurrence.invalidated)
   if(blocking){
    const reason=blocking.task?'previous-task-unfinished':'previous-pending'
    await db.query(`insert into teloa_plan_schedule_skips(plan_id,owner_id,plan_version,config_version,occurrence_id,scheduled_at,skipped_at,reason,blocking_claim_id,task_id)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(plan_id,config_version,occurrence_id) do nothing`,[plan.id,owner,plan.version,plan.configVersion,state.occurrenceId,state.nextAt,value.now,reason,blocking.occurrence.id,blocking.task?.id??null])
    const skip=readSkip((await db.query(skipOverview+' where s.plan_id=$1 and s.config_version=$2 and s.occurrence_id=$3',[plan.id,plan.configVersion,state.occurrenceId])).rows[0])
    await this.saveState(db,plan,value.now)
    await db.query('commit');return {occurrence:null,dispatch:false,skip}
   }
   const occurrenceId=this.identity.id(),taskRequestId=this.identity.id()
   if(!uuid(occurrenceId)||!uuid(taskRequestId))throw new WorkError('teloa/storage-unavailable','无法生成稳定的日程领取身份。')
   const snapshot={fields:plan.fields,source:plan.source,roleVersion:plan.roleVersion}
   const inserted=(await db.query(`insert into teloa_plan_occurrences(id,owner_id,plan_id,plan_version,config_version,occurrence_id,scheduled_at,claimed_at,task_request_id,snapshot,snapshot_hash)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) on conflict(plan_id,config_version,occurrence_id) do nothing returning *`,[occurrenceId,owner,plan.id,plan.version,plan.configVersion,state.occurrenceId,state.nextAt,value.now,taskRequestId,JSON.stringify(snapshot),snapshotHash(snapshot)])).rows[0] as Record<string,unknown>|undefined
   const saved=inserted??(await db.query('select * from teloa_plan_occurrences where plan_id=$1 and config_version=$2 and occurrence_id=$3 for share',[plan.id,plan.configVersion,state.occurrenceId])).rows[0]
   const occurrence=readOccurrence(saved),next=nextScheduleOccurrence(plan.fields.trigger,value.now)
   await db.query('update teloa_plan_schedule_state set plan_version=$2,config_version=$3,next_at=$4,occurrence_id=$5,updated_at=$6 where plan_id=$1',[plan.id,plan.version,plan.configVersion,next.at,next.occurrenceId,value.now])
   await db.query('commit');return {occurrence,dispatch:!!inserted}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 本人明确点“立即运行”时创建一次独立领取；不前移或改写下一次日程游标。 */
 async trigger(owner:string,input:unknown):Promise<{occurrence:PlanOccurrence;dispatch:boolean}>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const row=exact(input,['planId','requestId','expectedVersion','expectedConfigVersion','now'])
  if(!uuid(row.planId)||!uuid(row.requestId)||!positive(row.expectedVersion)||!positive(row.expectedConfigVersion))throw invalid()
  const now=moment(row.now),occurrenceId='manual:'+row.requestId,db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/plan-manual-trigger',owner,row.planId])])
   // task_request_id 全局唯一：先按请求身份读取，才能把旧版本重放明确报为冲突，
   // 而不是让唯一索引异常穿透成存储故障。
   const priorByRequest=(await db.query('select * from teloa_plan_occurrences where owner_id=$1 and plan_id=$2 and task_request_id=$3 for share',[owner,row.planId,row.requestId])).rows[0] as Record<string,unknown>|undefined
   if(priorByRequest){
    const occurrence=readOccurrence(priorByRequest)
    if(occurrence.occurrenceId!==occurrenceId||occurrence.planVersion!==row.expectedVersion||occurrence.configVersion!==row.expectedConfigVersion)throw new WorkError('teloa/conflict','同一立即运行请求不能更换计划版本或内容。')
    await db.query('commit');return {occurrence,dispatch:false}
   }
   const prior=(await db.query('select * from teloa_plan_occurrences where owner_id=$1 and plan_id=$2 and config_version=$3 and occurrence_id=$4 for share',[owner,row.planId,row.expectedConfigVersion,occurrenceId])).rows[0] as Record<string,unknown>|undefined
   if(prior){
    const occurrence=readOccurrence(prior)
    if(occurrence.planVersion!==row.expectedVersion||occurrence.taskRequestId!==row.requestId)throw new WorkError('teloa/conflict','同一立即运行请求不能更换计划版本或内容。')
    await db.query('commit');return {occurrence,dispatch:false}
   }
   const plan=await this.current(db,owner,row.planId,true)
   if(plan.version!==row.expectedVersion||plan.configVersion!==row.expectedConfigVersion)throw new WorkError('teloa/version-conflict','持续计划已变化，请刷新后再立即运行。')
   const history=(await db.query(occurrenceOverview+` where o.owner_id=$1 and o.plan_id=$2 and (
    (t.id is not null and t.state not in ('completed','cancelled')) or
    (t.id is null and p.state='active' and o.plan_version=p.version and o.config_version=p.config_version)
   ) order by o.claimed_at,o.id limit 1`,[owner,plan.id])).rows.map(observedOccurrence)
   if(history.find(({occurrence,task})=>task?!['completed','cancelled'].includes(task.state):!occurrence.invalidated))throw new WorkError('teloa/conflict','当前计划已有未结束执行，不能再次立即运行。')
   const id=this.identity.id()
   if(!uuid(id))throw new WorkError('teloa/storage-unavailable','无法生成稳定的立即运行身份。')
   const snapshot={fields:plan.fields,source:plan.source,roleVersion:plan.roleVersion}
   const saved=(await db.query(`insert into teloa_plan_occurrences(id,owner_id,plan_id,plan_version,config_version,occurrence_id,scheduled_at,claimed_at,task_request_id,snapshot,snapshot_hash)
    values($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10) returning *`,[id,owner,plan.id,plan.version,plan.configVersion,occurrenceId,now,row.requestId,JSON.stringify(snapshot),snapshotHash(snapshot)])).rows[0]
   const occurrence=readOccurrence(saved)
   await db.query('commit');return {occurrence,dispatch:true}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private claimIdentity(input:unknown,withTask=false):{claimId:string;taskRequestId:string;taskId?:string}{
  const row=exact(input,withTask?['claimId','taskRequestId','taskId']:['claimId','taskRequestId'])
  if(!uuid(row.claimId)||!uuid(row.taskRequestId)||withTask&&!uuid(row.taskId))throw invalid()
  return {claimId:row.claimId,taskRequestId:row.taskRequestId,...(withTask?{taskId:row.taskId as string}:{})}
 }
 private async storedClaim(db:Pool|PoolClient,owner:string,value:{claimId:string;taskRequestId:string}):Promise<PlanOccurrence>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const row=(await db.query('select * from teloa_plan_occurrences where id=$1 and owner_id=$2',[value.claimId,owner])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','领取记录不存在或不属于当前本人。')
  const claim=readOccurrence(row)
  if(claim.taskRequestId!==value.taskRequestId)throw new WorkError('teloa/conflict','领取请求身份不一致。')
  return claim
 }
 async revalidate(owner:string,input:unknown):Promise<PlanOccurrence>{
  const value=this.claimIdentity(input),db=await this.pool.connect()
  try{
   await db.query('begin');const claim=await this.storedClaim(db,owner,value),plan=await this.current(db,owner,claim.planId)
   if(plan.version!==claim.planVersion||plan.configVersion!==claim.configVersion||!same(plan.fields,claim.fields)||!same(plan.source,claim.source)||plan.roleVersion!==claim.roleVersion)throw new WorkError('teloa/version-conflict','计划或员工依据已变化，停止派发。')
   await db.query('commit');return claim
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async pending(owner:string):Promise<PlanOccurrence[]>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const rows=await this.pool.query(occurrenceOverview+' where o.owner_id=$1 and not exists(select 1 from teloa_plan_task_links l where l.claim_id=o.id) order by o.scheduled_at,o.id',[owner])
  return rows.rows.map(observedOccurrence).filter(({occurrence})=>!occurrence.invalidated).map(({occurrence})=>occurrence)
 }
 async executionHistory(owner:string,input:unknown):Promise<PlanExecutionHistoryPage>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['planId','limit','cursor','scope','roleId','query','runState'])
  if(value.planId!==undefined&&!uuid(value.planId)||!positive(value.limit)||value.limit>50)throw invalid()
  const scope=value.scope===undefined?undefined:typeof value.scope==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(value.scope)?value.scope:undefined
  if(value.scope!==undefined&&scope===undefined)throw invalid()
  const roleId=value.roleId===undefined?undefined:uuid(value.roleId)?value.roleId:undefined
  if(value.roleId!==undefined&&roleId===undefined)throw invalid()
  const query=value.query===undefined?undefined:typeof value.query==='string'&&!!value.query.trim()&&value.query.trim().length<=240?value.query.trim():undefined
  if(value.query!==undefined&&query===undefined)throw invalid()
  const runStates:readonly PlanExecutionRunState[]=['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed','not-started']
  const runState=value.runState===undefined?undefined:runStates.includes(value.runState as PlanExecutionRunState)?value.runState as PlanExecutionRunState:undefined
  if(value.runState!==undefined&&runState===undefined)throw invalid()
  let cursor:PlanExecutionHistoryCursor|undefined
  if(value.cursor!==undefined){const row=exact(value.cursor,['claimedAt','claimId']);if(!uuid(row.claimId))throw invalid();cursor={claimId:row.claimId,claimedAt:moment(row.claimedAt)}}
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   if(value.planId!==undefined&&!(await db.query('select 1 from teloa_plans where id=$1 and owner_id=$2',[value.planId,owner])).rows[0])throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
   if(cursor){
    const prior=(await db.query('select claimed_at from teloa_plan_occurrences where id=$1 and owner_id=$2 and ($3::uuid is null or plan_id=$3)',[cursor.claimId,owner,value.planId??null])).rows[0]
    if(!prior)throw new WorkError('teloa/forbidden',value.planId===undefined?'执行历史游标不存在或不属于当前本人。':'执行历史游标不存在或不属于当前计划。')
    if(stamp(prior.claimed_at)!==cursor.claimedAt)throw invalid()
   }
   const rows=(await db.query(`with page as materialized (
    select o.*,l.owner_id as linked_owner_id,l.task_request_id as linked_request_id,l.task_id as linked_task_id
    from teloa_plan_occurrences o left join teloa_plan_task_links l on l.claim_id=o.id
    where o.owner_id=$1 and ($2::uuid is null or o.plan_id=$2)
      and ($3::timestamptz is null or (o.claimed_at,o.id)<($3::timestamptz,$4::uuid))
      and ($5::text is null or o.snapshot #>> '{fields,scope}'=$5)
      and ($6::uuid is null or o.snapshot #>> '{fields,roleId}'=$6::text)
      and ($7::text is null or position(lower($7) in lower(concat_ws(' ',o.snapshot #>> '{fields,title}',o.plan_id::text,o.id::text,l.task_id::text)))>0)
      and ($8::text is null
       or ($8='not-started' and not exists(select 1 from teloa_task_runs candidate where candidate.owner_id=o.owner_id and candidate.request_id=o.id))
       or ($8<>'not-started' and exists(select 1 from teloa_task_runs candidate where candidate.owner_id=o.owner_id and candidate.request_id=o.id and candidate.state=$8)))
    order by o.claimed_at desc,o.id desc limit $9
   ) select page.*,
    row_to_json(t) as task_record,t.created_at as task_created_at,t.updated_at as task_updated_at,
    row_to_json(r) as run_record,r.created_at as run_created_at
    from page left join teloa_tasks t on t.id=page.linked_task_id
    left join teloa_task_runs r on r.owner_id=page.owner_id and r.request_id=page.id
    order by page.claimed_at desc,page.id desc`,[owner,value.planId??null,cursor?.claimedAt??null,cursor?.claimId??null,scope??null,roleId??null,query??null,runState??null,value.limit+1])).rows
   const page=rows.slice(0,value.limit),items:PlanExecutionHistoryItem[]=[],errors:{claimId:string;code:'teloa/storage-corrupt'}[]=[]
   let next:PlanExecutionHistoryCursor|undefined
   for(const row of page){
    if(!uuid(row.id)||row.owner_id!==owner||value.planId!==undefined&&row.plan_id!==value.planId)throw corrupt()
    next={claimId:row.id,claimedAt:stamp(row.claimed_at)}
    try{
     const occurrence=readOccurrence(row)
     const hasLink=row.linked_owner_id!==null||row.linked_request_id!==null||row.linked_task_id!==null
     let task:PlanExecutionHistoryItem['task']=null,run:PlanExecutionHistoryItem['run']=null
     if(hasLink){
      if(row.linked_owner_id!==owner||row.linked_request_id!==occurrence.taskRequestId||!uuid(row.linked_task_id)||!isRecord(row.task_record))throw corrupt()
      const storedTask=readStoredTask({...row.task_record,created_at:row.task_created_at,updated_at:row.task_updated_at})
      const fixedRequest={fields:occurrence.taskRequest.fields,assignee:occurrence.taskRequest.assignee}
      if(storedTask.ownerId!==owner||storedTask.id!==row.linked_task_id||row.task_record.request_id!==occurrence.taskRequestId||!isDeepStrictEqual(row.task_record.request_spec,fixedRequest))throw corrupt()
      task={id:storedTask.id,state:storedTask.state}
     }else if(row.task_record!==null)throw corrupt()
     if(row.run_record!==null){
      if(!task||!isRecord(row.run_record))throw corrupt()
      const storedRun=readStoredTaskRun({...row.run_record,created_at:row.run_created_at})
      if(row.run_record.owner_id!==owner||row.run_record.request_id!==occurrence.id||storedRun.taskId!==task.id)throw corrupt()
      run={id:storedRun.id,state:storedRun.state as 'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed',sessionId:storedRun.sessionId,createdAt:storedRun.createdAt}
     }
     items.push({claimId:occurrence.id,planId:occurrence.planId,occurrenceId:occurrence.occurrenceId,planVersion:occurrence.planVersion,configVersion:occurrence.configVersion,scheduledAt:occurrence.scheduledAt,claimedAt:occurrence.claimedAt,...(occurrence.fields.notificationPolicy===undefined?{}:{notificationPolicy:occurrence.fields.notificationPolicy}),task,run})
    }catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt')throw error;errors.push({claimId:row.id,code:'teloa/storage-corrupt'})}
   }
   await db.query('commit')
   return {items,...(errors.length?{errors}:{}),...(rows.length>value.limit&&next?{cursor:next}:{})}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async recoveryPending(owner:string,input:unknown):Promise<{items:PlanOccurrence[];errors?:{claimId:string;planId?:string;code:'teloa/storage-corrupt'}[];cursor?:PlanExecutionCursor}>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['limit','cursor'])
  if(!positive(value.limit)||value.limit>100)throw invalid()
  let cursor:PlanExecutionCursor|undefined
  if(value.cursor!==undefined){
   const row=exact(value.cursor,['claimedAt','claimId']);if(!uuid(row.claimId))throw invalid()
   cursor={claimId:row.claimId,claimedAt:moment(row.claimedAt)}
   const prior=(await this.pool.query('select claimed_at from teloa_plan_occurrences where id=$1 and owner_id=$2',[cursor.claimId,owner])).rows[0]
   if(!prior)throw new WorkError('teloa/forbidden','恢复游标不存在或不属于当前本人。')
   if(stamp(prior.claimed_at)!==cursor.claimedAt)throw invalid()
  }
  const rows=(await this.pool.query(occurrenceOverview+` where o.owner_id=$1 and not exists(select 1 from teloa_plan_task_links l where l.claim_id=o.id)
   and ($2::timestamptz is null or (o.claimed_at,o.id)>($2::timestamptz,$3::uuid)) order by o.claimed_at,o.id limit $4`,[owner,cursor?.claimedAt??null,cursor?.claimId??null,value.limit+1])).rows
  const items:PlanOccurrence[]=[],errors:{claimId:string;planId?:string;code:'teloa/storage-corrupt'}[]=[],page=rows.slice(0,value.limit)
  let next:PlanExecutionCursor|undefined
  for(const row of page){
   if(!uuid(row.id)||row.owner_id!==owner)throw corrupt()
   next={claimId:row.id,claimedAt:stamp(row.claimed_at)}
   try{const {occurrence}=observedOccurrence(row);if(!occurrence.invalidated)items.push(occurrence)}
   catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt')throw error;errors.push({claimId:row.id,...(uuid(row.plan_id)?{planId:row.plan_id}:{}),code:'teloa/storage-corrupt'})}
  }
  return {items,...(errors.length?{errors}:{}),...(rows.length>value.limit&&next?{cursor:next}:{})}
 }
 /** 只读恢复目录。task-ended 的持久确认由协调器负责，否则后续扫描仍会返回显式 skip。 */
 async pendingExecutions(owner:string,input:unknown):Promise<{items:PendingPlanExecution[];errors?:{claimId:string;planId?:string;code:'teloa/storage-corrupt'}[];cursor?:PlanExecutionCursor}>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['limit','cursor'])
  if(!positive(value.limit)||value.limit>100)throw invalid()
  let cursor:PlanExecutionCursor|undefined
  if(value.cursor!==undefined){
   const row=exact(value.cursor,['claimedAt','claimId']);if(!uuid(row.claimId))throw invalid()
   cursor={claimId:row.claimId,claimedAt:moment(row.claimedAt)}
   const prior=(await this.pool.query('select claimed_at from teloa_plan_occurrences where id=$1 and owner_id=$2',[cursor.claimId,owner])).rows[0]
   if(!prior)throw new WorkError('teloa/forbidden','恢复游标不存在或不属于当前本人。')
   if(stamp(prior.claimed_at)!==cursor.claimedAt)throw invalid()
  }
  // 以请求身份找执行，再核对 task_id；不能把错配任务的执行通过 JOIN 条件悄悄滤掉。
  // 先截取有界原始页，再检查执行阶段；结束行也消耗页额度并推进游标，避免扫描全部历史。
  const rows=(await this.pool.query(`with page as materialized (
   select o.*,l.owner_id as linked_owner_id,l.task_request_id as linked_request_id,l.task_id as linked_task_id
   from teloa_plan_occurrences o join teloa_plan_task_links l on l.claim_id=o.id
   where o.owner_id=$1 and ($2::timestamptz is null or (o.claimed_at,o.id)>($2::timestamptz,$3::uuid))
   order by o.claimed_at,o.id limit $4
  ) select page.*,
   row_to_json(t) as task_record,t.created_at as task_created_at,t.updated_at as task_updated_at,
   row_to_json(r) as run_record,r.created_at as run_created_at,row_to_json(a) as ack_record,a.acknowledged_at as ack_at
   from page left join teloa_tasks t on t.id=page.linked_task_id
   left join teloa_task_runs r on r.owner_id=page.owner_id and r.request_id=page.id
   left join teloa_plan_scheduler_acks a on a.claim_id=page.id
   order by page.claimed_at,page.id`,[owner,cursor?.claimedAt??null,cursor?.claimId??null,value.limit+1])).rows
  const entries=rows.slice(0,value.limit).map(row=>{
   if(!uuid(row.id)||row.owner_id!==owner)throw corrupt()
   const pageCursor={claimId:row.id,claimedAt:stamp(row.claimed_at)}
   try{
   const occurrence=readOccurrence(row)
   if(row.linked_owner_id!==owner||row.linked_request_id!==occurrence.taskRequestId||!isRecord(row.task_record))throw corrupt()
   const task=readStoredTask({...row.task_record,created_at:row.task_created_at,updated_at:row.task_updated_at})
   const spec={fields:occurrence.taskRequest.fields,assignee:occurrence.taskRequest.assignee}
   if(task.id!==row.linked_task_id||task.ownerId!==owner||row.task_record.request_id!==occurrence.taskRequestId||!isDeepStrictEqual(row.task_record.request_spec,spec))throw corrupt()
   const job={claimId:occurrence.id,taskId:task.id,taskCreatedVersion:1 as const,taskTitle:occurrence.fields.title,roleId:occurrence.fields.roleId,roleVersion:occurrence.roleVersion}
   let item:PendingPlanExecution|null
   if(row.run_record===null){
    item=['completed','cancelled'].includes(task.state)?{planId:occurrence.planId,job,action:'skip',reason:'task-ended',run:null}:{planId:occurrence.planId,job,action:'prepare',run:null}
   }else{
    if(!isRecord(row.run_record))throw corrupt()
    const run=readStoredTaskRun({...row.run_record,created_at:row.run_created_at})
    if(row.run_record.owner_id!==owner||row.run_record.request_id!==occurrence.id||run.taskId!==task.id||run.taskVersion!==1||run.roleId!==job.roleId||run.roleVersion!==job.roleVersion)throw corrupt()
    if(run.state==='configuration_failed')item=null
    else{
     const snapshot=JSON.parse(run.inputText),context=snapshot.planContext
     if(snapshot.task.title!==job.taskTitle||snapshot.task.goal!==occurrence.fields.goal||snapshot.task.scope!==occurrence.fields.scope||!isRecord(context)||context.occurrenceId!==occurrence.id||context.goal!==occurrence.fields.goal||context.dataScope!==occurrence.fields.dataScope||context.delivery!==occurrence.fields.delivery)throw corrupt()
     item=['ended','withdrawn'].includes(run.state)?null:{planId:occurrence.planId,job,action:run.state==='prepared'?'start':'reconcile',run:{id:run.id,state:run.state as 'prepared'|'submitting'|'accepted'|'active',sessionId:run.sessionId,nativeRequestId:run.nativeRequestId}}
    }
   }
   if(row.ack_record!==null){
    const ack=exact(row.ack_record,['owner_id','claim_id','task_id','reason','acknowledged_at'])
    if(ack.owner_id!==owner||ack.claim_id!==occurrence.id||ack.task_id!==task.id||ack.reason!=='task-ended'||!['completed','cancelled'].includes(task.state)||row.run_record!==null)throw corrupt()
    stamp(row.ack_at)
    item=null
   }
   return {item,cursor:pageCursor}
   }catch(error){
    if(!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt')throw error
    return {item:null,cursor:pageCursor,error:{claimId:row.id,...(uuid(row.plan_id)?{planId:row.plan_id}:{}),code:'teloa/storage-corrupt' as const}}
   }
  })
  const errors=entries.flatMap(entry=>entry.error?[entry.error]:[])
  return {items:entries.flatMap(entry=>entry.item?[entry.item]:[]),...(errors.length?{errors}:{}),...(rows.length>value.limit?{cursor:entries.at(-1)!.cursor}:{})}
 }
 async linkTask(owner:string,input:unknown):Promise<{claimId:string;taskRequestId:string;taskId:string}>{
  const value=this.claimIdentity(input,true),db=await this.pool.connect()
  try{
   await db.query('begin');const claim=await this.storedClaim(db,owner,value)
   const association=await this.associate(db,owner,claim,value.taskId!)
   await db.query('commit');return association
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async associate(db:PoolClient,owner:string,claim:PlanOccurrence,taskId:string):Promise<{claimId:string;taskRequestId:string;taskId:string}>{
   await db.query('select id from teloa_plan_occurrences where id=$1 for update',[claim.id])
   const task=(await db.query('select * from teloa_tasks where id=$1 and owner_id=$2 for share',[taskId,owner])).rows[0]
   const spec={fields:claim.taskRequest.fields,assignee:claim.taskRequest.assignee}
   const matches=task&&task.request_id===claim.taskRequestId&&(await db.query('select request_spec=$2::jsonb as matches from teloa_tasks where id=$1',[task.id,JSON.stringify(spec)])).rows[0]?.matches
   if(!matches)throw new WorkError('teloa/conflict','任务不属于该次固定领取请求。')
   const prior=(await db.query('select * from teloa_plan_task_links where claim_id=$1',[claim.id])).rows[0]
   if(prior&&(prior.owner_id!==owner||prior.task_request_id!==claim.taskRequestId||prior.task_id!==taskId))throw new WorkError('teloa/conflict','领取记录已关联其他任务。')
   if(!prior)await db.query('insert into teloa_plan_task_links(claim_id,owner_id,task_request_id,task_id) values($1,$2,$3,$4)',[claim.id,owner,claim.taskRequestId,taskId])
  return {claimId:claim.id,taskRequestId:claim.taskRequestId,taskId}
 }
 // 校验、创建与关联共享事务；重试只能找回同一任务，不授予再次执行权限。
 async dispatchTask(owner:string,input:unknown){
  const row=exact(input,['claimId','taskRequestId','now']),value=this.claimIdentity({claimId:row.claimId,taskRequestId:row.taskRequestId}),now=moment(row.now),db=await this.pool.connect()
  try{
   await db.query('begin')
   const occurrence=await this.storedClaim(db,owner,value)
   const parent=await lockConversationTaskParent(db,owner,occurrence.taskRequestId)
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',owner,occurrence.taskRequestId])])
   const existing=(await db.query('select id from teloa_tasks where owner_id=$1 and request_id=$2',[owner,occurrence.taskRequestId])).rows[0]
   if(!existing){
    assertConversationTaskOpen(parent)
    const plan=await this.current(db,owner,occurrence.planId,true)
    if(plan.version!==occurrence.planVersion||plan.configVersion!==occurrence.configVersion||!same(plan.fields,occurrence.fields)||!same(plan.source,occurrence.source)||plan.roleVersion!==occurrence.roleVersion)throw new WorkError('teloa/version-conflict','计划或员工依据已变化，停止派发。')
   }
   const tasks=new TaskService(this.pool,{id:this.identity.id,now:()=>now})
   const task=await tasks.createInTransaction(db,owner,occurrence.taskRequest)
   const association=await this.associate(db,owner,occurrence,task.id)
   await db.query('commit');return {occurrence,task,association}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 // 调用者已持有任务执行所需的锁；这里只读取固定来源，不再反向锁岗位或计划。
 async executionContext(db:PoolClient,owner:string,taskId:string):Promise<{occurrenceId:string;goal:string;dataScope:string;delivery:string}|undefined>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  if(!uuid(taskId))throw invalid()
  const taskRow=(await db.query('select * from teloa_tasks where id=$1 and owner_id=$2',[taskId,owner])).rows[0]
  if(!taskRow)throw new WorkError('teloa/forbidden','任务不存在或不属于当前本人。')
  const task=readStoredTask(taskRow),link=(await db.query('select * from teloa_plan_task_links where task_id=$1',[taskId])).rows[0]
  if(!link){
   if((await db.query('select id from teloa_plan_occurrences where task_request_id=$1',[taskRow.request_id])).rowCount)throw corrupt()
   return undefined
  }
  if(link.owner_id!==owner||link.task_id!==task.id||link.task_request_id!==taskRow.request_id||!uuid(link.claim_id))throw corrupt()
  const stored=(await db.query('select * from teloa_plan_occurrences where id=$1',[link.claim_id])).rows[0]
  if(!stored)throw corrupt()
  const occurrence=readOccurrence(stored)
  if(occurrence.ownerId!==owner||occurrence.taskRequestId!==taskRow.request_id||task.goal!==occurrence.fields.goal||task.scope!==occurrence.fields.scope)throw corrupt()
  const spec={fields:occurrence.taskRequest.fields,assignee:occurrence.taskRequest.assignee}
  if(!(await db.query('select request_spec=$2::jsonb as matches from teloa_tasks where id=$1',[task.id,JSON.stringify(spec)])).rows[0]?.matches)throw corrupt()
  return {occurrenceId:occurrence.id,goal:occurrence.fields.goal,dataScope:occurrence.fields.dataScope,delivery:occurrence.fields.delivery}
 }
 async list(owner:string,input:unknown):Promise<PlanOccurrence[]>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const row=exact(input,['planId']);if(row.planId!==undefined&&!uuid(row.planId))throw invalid()
  if(row.planId!==undefined&&!((await this.pool.query('select 1 from teloa_plans where id=$1 and owner_id=$2',[row.planId,owner])).rows[0]))throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  const rows=await this.pool.query(occurrenceOverview+' where o.owner_id=$1 and ($2::uuid is null or o.plan_id=$2) order by o.scheduled_at,o.id',[owner,row.planId??null])
  return rows.rows.map(observedOccurrence).map(({occurrence})=>occurrence)
 }
 async overview(owner:string,input:unknown){
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['planId']);if(!uuid(value.planId))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const stored=(await db.query('select * from teloa_plans where id=$1 and owner_id=$2',[value.planId,owner])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
   const plan=readPlan(stored),cursorRow=(await db.query('select * from teloa_plan_schedule_state where plan_id=$1 and owner_id=$2',[plan.id,owner])).rows[0]
   const cursor=cursorRow?readState(cursorRow,plan):null
   const nextAt=plan.state==='active'&&cursor?.planVersion===plan.version&&cursor.configVersion===plan.configVersion?cursor.nextAt:null
   const recent=(await db.query(occurrenceOverview+' where o.owner_id=$1 and o.plan_id=$2 order by o.scheduled_at desc,o.id desc limit 1',[owner,plan.id])).rows[0]
   const skipped=(await db.query(skipOverview+' where s.owner_id=$1 and s.plan_id=$2 order by s.scheduled_at desc,s.occurrence_id desc limit 1',[owner,plan.id])).rows[0]
   const result={planId:plan.id,planVersion:plan.version,state:plan.state,nextAt,latest:recent?observedOccurrence(recent):null,latestSkip:skipped?readSkip(skipped):null}
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async skips(owner:string,input:unknown):Promise<PlanScheduleSkip[]>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const row=exact(input,['planId']);if(row.planId!==undefined&&!uuid(row.planId))throw invalid()
  if(row.planId!==undefined&&!((await this.pool.query('select 1 from teloa_plans where id=$1 and owner_id=$2',[row.planId,owner])).rows[0]))throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
  const rows=await this.pool.query(skipOverview+' where s.owner_id=$1 and ($2::uuid is null or s.plan_id=$2) order by s.scheduled_at,s.occurrence_id',[owner,row.planId??null])
  return rows.rows.map(readSkip)
 }
 async skipHistory(owner:string,input:unknown):Promise<PlanSkipHistoryPage>{
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['planId','limit','cursor'])
  if(!uuid(value.planId)||!positive(value.limit)||value.limit>50)throw invalid()
  let cursor:PlanSkipHistoryCursor|undefined
  if(value.cursor!==undefined){
   const row=exact(value.cursor,['skippedAt','configVersion','occurrenceId'])
   if(!positive(row.configVersion)||row.configVersion>2147483647||!occurrenceIdentity(row.occurrenceId))throw invalid()
   cursor={skippedAt:moment(row.skippedAt),configVersion:row.configVersion,occurrenceId:row.occurrenceId}
  }
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   if(!(await db.query('select 1 from teloa_plans where id=$1 and owner_id=$2',[value.planId,owner])).rows[0])throw new WorkError('teloa/forbidden','持续计划不存在或不属于当前本人。')
   if(cursor){
    const prior=(await db.query('select skipped_at from teloa_plan_schedule_skips where plan_id=$1 and owner_id=$2 and config_version=$3 and occurrence_id=$4',[value.planId,owner,cursor.configVersion,cursor.occurrenceId])).rows[0]
    if(!prior)throw new WorkError('teloa/forbidden','跳过历史游标不存在或不属于当前计划。')
    if(stamp(prior.skipped_at)!==cursor.skippedAt)throw invalid()
   }
   const rows=(await db.query(skipOverview+` where s.owner_id=$1 and s.plan_id=$2
    and ($3::timestamptz is null or (s.skipped_at,s.config_version,s.occurrence_id collate "C")<($3::timestamptz,$4::integer,$5::text collate "C"))
    order by s.skipped_at desc,s.config_version desc,s.occurrence_id collate "C" desc limit $6`,[owner,value.planId,cursor?.skippedAt??null,cursor?.configVersion??null,cursor?.occurrenceId??null,value.limit+1])).rows
   const page=rows.slice(0,value.limit),items:PlanScheduleSkip[]=[],errors:Array<PlanSkipHistoryCursor&{code:'teloa/storage-corrupt'}>=[]
   let next:PlanSkipHistoryCursor|undefined
   for(const row of page){
    if(row.owner_id!==owner||row.plan_id!==value.planId||!positive(row.config_version)||!occurrenceIdentity(row.occurrence_id))throw corrupt()
    next={skippedAt:stamp(row.skipped_at),configVersion:row.config_version,occurrenceId:row.occurrence_id}
    try{items.push(readSkip(row))}
    catch(error){if(!(error instanceof WorkError)||error.code!=='teloa/storage-corrupt')throw error;errors.push({...next,code:'teloa/storage-corrupt'})}
   }
   await db.query('commit')
   return {items,...(errors.length?{errors}:{}),...(rows.length>value.limit&&next?{cursor:next}:{})}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

export {readOccurrence as readStoredPlanOccurrence}
