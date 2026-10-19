import type {Pool,PoolClient} from 'pg'
import {WorkError,businessObjectReference,type BusinessObjectReference,type WorkEventV2} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot,type BusinessObjectSnapshot} from './business-data.ts'
import {workRequestChildId} from './conversation-work-task-protection.ts'

type Database=Pick<PoolClient,'query'>
export type BusinessTaskSourceUpdateState='pending'|'continued'|'accepted'|'needs-user'|'rejected'
export type BusinessTaskSourceUpdate={id:string;ownerId:string;taskId:string;planId:string;eventId:string;reference:BusinessObjectReference;state:BusinessTaskSourceUpdateState;taskVersion:number|null;runId:string|null;reason:string|null;createdAt:string;updatedAt:string}
const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务来源更新账本损坏，已停止读取。')
const settledRun=['ended','withdrawn','configuration_failed']
/** 续办可继续的任务状态：已完成/已取消的任务不自动复活（needs-user）；本人暂停的任务保持排队，不改为 ready。 */
const continuable=['waiting','blocked','ready']

/**
 * 同一计划、同一业务对象（scope/type/id）在既有任务未结束时的后续版本账本。
 * 每个任务对同一对象版本至多一条；行身份与来源列不可改，终态不可改，由触发器兜底。
 * `pending` 等原 Run 收敛 → `continued`（同一 taskId 升版本，新 Run 读 原固定对象 + updates）→ `accepted`；
 * 任务已完成/已取消、计划/委托/员工版本不再当前时记 `needs-user`，不复活、不无关联新建。
 */
export async function initializeBusinessTaskSourceUpdates(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_business_task_source_updates(
  id uuid primary key,owner_id text not null,task_id uuid not null,plan_id uuid not null,event_id uuid not null,
  scope_id text not null,object_type text not null,object_id text not null,object_version integer not null check(object_version>0),snapshot_hash text not null check(snapshot_hash~'^[a-f0-9]{64}$'),
  state text not null check(state in ('pending','continued','accepted','needs-user','rejected')),task_version integer check(task_version>0),run_id uuid,reason text,
  created_at timestamptz not null,updated_at timestamptz not null,
  unique(owner_id,task_id,object_version),
  foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),
  foreign key(owner_id,event_id) references teloa_work_events(owner_id,id),
  foreign key(owner_id,scope_id,object_type,object_id,object_version) references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version)
 );
 create index if not exists teloa_business_task_source_updates_open on teloa_business_task_source_updates(owner_id,created_at) where state in ('pending','continued');
 create or replace function teloa_business_task_source_updates_guard() returns trigger language plpgsql as $$ begin
  if tg_op='DELETE' or (new.id,new.owner_id,new.task_id,new.plan_id,new.event_id,new.scope_id,new.object_type,new.object_id,new.object_version,new.snapshot_hash,new.created_at)
   is distinct from (old.id,old.owner_id,old.task_id,old.plan_id,old.event_id,old.scope_id,old.object_type,old.object_id,old.object_version,old.snapshot_hash,old.created_at)
   or old.state in ('accepted','rejected') and new.state<>old.state
   or old.task_version is not null and new.task_version is distinct from old.task_version
   or old.run_id is not null and new.run_id is distinct from old.run_id
  then raise exception 'teloa_business_task_source_updates identity is immutable'; end if;
  return new;
 end $$;
 drop trigger if exists teloa_business_task_source_updates_guard on teloa_business_task_source_updates;
 create trigger teloa_business_task_source_updates_guard before update or delete on teloa_business_task_source_updates for each row execute function teloa_business_task_source_updates_guard();
`)}

function read(row:Record<string,unknown>):BusinessTaskSourceUpdate{
 try{
  const reference=businessObjectReference({scope:row.scope_id,type:row.object_type,id:row.object_id,version:row.object_version,snapshotHash:row.snapshot_hash})
  if(typeof row.id!=='string'||typeof row.owner_id!=='string'||typeof row.task_id!=='string'||typeof row.plan_id!=='string'||typeof row.event_id!=='string'||!['pending','continued','accepted','needs-user','rejected'].includes(String(row.state))||!(row.created_at instanceof Date)||!(row.updated_at instanceof Date))throw Error()
  return {id:row.id,ownerId:row.owner_id,taskId:row.task_id,planId:row.plan_id,eventId:row.event_id,reference,state:row.state as BusinessTaskSourceUpdateState,taskVersion:row.task_version===null?null:Number(row.task_version),runId:row.run_id===null?null:String(row.run_id),reason:row.reason===null?null:String(row.reason),createdAt:row.created_at.toISOString(),updatedAt:row.updated_at.toISOString()}
 }catch{throw corrupt()}
}

/** 从事件事实里的完整固定快照投影出对象引用（只取五个身份键），其余正文不进引用。 */
export function businessObjectReferenceOf(object:unknown):BusinessObjectReference{
 if(!object||typeof object!=='object')throw new WorkError('teloa/invalid-input','业务事件缺少固定对象快照。')
 const value=object as Record<string,unknown>
 return businessObjectReference({scope:value.scope,type:value.type,id:value.id,version:value.version,snapshotHash:value.snapshotHash})
}

/** 续办 Run 的准备请求身份：复用会话工作的子请求派生（版本位 5，TaskRunService 接受），由账本行派生，崩溃重放回到同一 Run。 */
export function businessTaskSourceUpdateRunRequestId(_owner:string,updateId:string):string{
 return workRequestChildId(updateId,'business-source-update-run')
}

/**
 * 对象级事件到达同一计划时：该对象已有本计划领取的任务 → 不再新建任务，按任务状态记 `pending`（未结束）或 `needs-user`（已完成/取消或来源撤回）；
 * 已有领取但任务尚未派发 → `wait`（事件保持待定，下一轮再核）；没有既有领取 → `none`（按原路径新建）。
 * 判据只认持久领取快照里的事件来源与任务关联，不读事件正文。
 */
export async function routeBusinessObjectEventToExistingTask(db:Database,owner:string,planId:string,event:WorkEventV2,object:BusinessObjectReference,inactive:boolean,identity:{id:()=>string;now:()=>string}):Promise<'none'|'wait'|'queued'>{
 if(event.sourceRef.kind!=='business-object'||event.sourceRef.scope!==object.scope||event.sourceRef.type!==object.type||event.sourceRef.id!==object.id)throw new WorkError('teloa/invalid-input','业务对象事件与固定对象不一致。')
 const prior=(await db.query(`select o.id as claim_id,l.task_id,t.state from teloa_plan_occurrences o
  left join teloa_plan_task_links l on l.claim_id=o.id and l.owner_id=o.owner_id
  left join teloa_tasks t on t.id=l.task_id and t.owner_id=o.owner_id
  where o.owner_id=$1 and o.plan_id=$2 and o.snapshot->'event'->'event'->'sourceRef'=$3::jsonb
  order by o.claimed_at desc,o.id desc limit 1`,[owner,planId,JSON.stringify(event.sourceRef)])).rows[0]
 if(!prior)return 'none'
 if(!prior.task_id)return 'wait'
 const state:BusinessTaskSourceUpdateState=inactive||['completed','cancelled'].includes(String(prior.state))?'needs-user':'pending'
 const reason=inactive?'teloa/source-withdrawn':state==='needs-user'?'teloa/task-ended':null,now=identity.now()
 await db.query(`insert into teloa_business_task_source_updates(id,owner_id,task_id,plan_id,event_id,scope_id,object_type,object_id,object_version,snapshot_hash,state,reason,created_at,updated_at)
  values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13) on conflict(owner_id,task_id,object_version) do nothing`,[identity.id(),owner,prior.task_id,planId,event.id,object.scope,object.type,object.id,object.version,object.snapshotHash,state,reason,now])
 return 'queued'
}

/** 该任务是否已有（未被拒绝的）来源更新：计划复核据此只核对原事件固定版本原件，不再要求其后无实质变化。 */
export async function hasBusinessTaskSourceUpdates(db:Database,owner:string,taskId:string):Promise<boolean>{
 if(!(await db.query("select to_regclass('teloa_business_task_source_updates') as relation")).rows[0]?.relation)return false
 return !!(await db.query("select 1 from teloa_business_task_source_updates where owner_id=$1 and task_id=$2 and state<>'rejected' limit 1",[owner,taskId])).rowCount
}

/** 新 Run 输入里的 updates：只给已续办到该任务版本（含）的更新，按对象版本升序；每条都重新核对快照摘要。 */
export async function readBusinessTaskSourceUpdatesForRun(db:Database,owner:string,taskId:string,taskVersion:number):Promise<BusinessObjectSnapshot[]>{
 if(!(await db.query("select to_regclass('teloa_business_task_source_updates') as relation")).rows[0]?.relation)return []
 const rows=(await db.query(`select u.scope_id,u.object_type,u.object_id,u.object_version,u.snapshot_hash,s.snapshot from teloa_business_task_source_updates u
  join teloa_business_object_snapshots s on s.owner_id=u.owner_id and s.scope_id=u.scope_id and s.object_type=u.object_type and s.object_id=u.object_id and s.object_version=u.object_version
  where u.owner_id=$1 and u.task_id=$2 and u.state in ('continued','accepted') and u.task_version is not null and u.task_version<=$3 order by u.object_version`,[owner,taskId,taskVersion])).rows
 return rows.map(row=>{
  let snapshot:Omit<BusinessObjectSnapshot,'snapshotHash'>
  try{snapshot=readBusinessObjectSnapshot(row.snapshot,String(row.scope_id))}catch{throw corrupt()}
  if(snapshot.type!==row.object_type||snapshot.id!==row.object_id||snapshot.version!==Number(row.object_version)||businessObjectSnapshotHash(snapshot)!==row.snapshot_hash)throw corrupt()
  return {...snapshot,snapshotHash:String(row.snapshot_hash)}
 })
}

export class BusinessTaskSourceUpdateService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async transaction<T>(fn:(db:PoolClient)=>Promise<T>):Promise<T>{const db=await this.pool.connect();try{await db.query('begin');const result=await fn(db);await db.query('commit');return result}catch(error){await db.query('rollback');throw error}finally{db.release()}}
 async get(owner:string,id:string):Promise<BusinessTaskSourceUpdate>{
  ownerId(owner)
  const row=(await this.pool.query('select * from teloa_business_task_source_updates where owner_id=$1 and id=$2',[owner,id])).rows[0]
  if(!row)throw new WorkError('teloa/forbidden','业务来源更新不属于当前本人。')
  return read(row)
 }
 /** 待处理账本（已排队或已升版本未送达），供常驻驱动恢复；不重新登记。 */
 async pending(owner:string):Promise<BusinessTaskSourceUpdate[]>{
  ownerId(owner)
  return (await this.pool.query("select * from teloa_business_task_source_updates where owner_id=$1 and state in ('pending','continued') order by created_at,id limit 50",[owner])).rows.map(read)
 }
 /**
  * 原 Run 收敛后续办原任务：同一 taskId 升版本回到可准备状态；旧 Run、原来源与历史不变。
  * 计划/控制不再 active、委托失效、员工版本高于任务固定负责人版本、任务已完成/取消 → `needs-user`，不自动续签、不空升版本。
  */
 async continueTask(owner:string,id:string):Promise<BusinessTaskSourceUpdate>{
  ownerId(owner)
  return this.transaction(async db=>{
   const row=(await db.query('select * from teloa_business_task_source_updates where owner_id=$1 and id=$2 for update',[owner,id])).rows[0]
   if(!row)throw new WorkError('teloa/forbidden','业务来源更新不属于当前本人。')
   if(row.state!=='pending')return read(row)
   const now=this.identity.now(),settle=async(state:BusinessTaskSourceUpdateState,reason:string)=>read((await db.query('update teloa_business_task_source_updates set state=$3,reason=$4,updated_at=$5 where owner_id=$1 and id=$2 returning *',[owner,id,state,reason,now])).rows[0]!)
   const task=(await db.query(`select t.state,t.version,t.assignee_role_id,t.assignee_role_version,r.version as role_version,r.state as role_state from teloa_tasks t
    left join teloa_roles r on r.owner_id=t.owner_id and r.id=t.assignee_role_id where t.owner_id=$1 and t.id=$2 for update of t`,[owner,row.task_id])).rows[0]
   if(!task)return settle('rejected','teloa/forbidden')
   const latest=(await db.query('select state from teloa_task_runs where owner_id=$1 and task_id=$2 order by created_at desc,id desc limit 1',[owner,row.task_id])).rows[0]
   if(latest&&!settledRun.includes(String(latest.state)))return read(row)
   if(['completed','cancelled'].includes(String(task.state)))return settle('needs-user','teloa/task-ended')
   const plan=(await db.query(`select p.state,p.work_definition,c.state as control_state from teloa_plans p
    left join teloa_work_controls c on c.owner_id=p.owner_id and c.id=(p.work_definition->>'definitionControlId')::uuid where p.owner_id=$1 and p.id=$2 for share of p`,[owner,row.plan_id])).rows[0]
   if(!plan||plan.state!=='active'||plan.control_state!=='active')return settle('needs-user','teloa/plan-inactive')
   const authorization=plan.work_definition?.authorization
   if(authorization?.kind==='delegation'){
    const delegation=(await db.query('select state,version from teloa_role_work_delegations where owner_id=$1 and id=$2',[owner,authorization.delegationId])).rows[0]
    if(!delegation||delegation.state!=='active'||delegation.version!==authorization.delegationVersion)return settle('needs-user','teloa/delegation-inactive')
   }
   if(task.assignee_role_id===null||task.role_state!=='active'||task.role_version!==task.assignee_role_version)return settle('needs-user','teloa/version-conflict')
   const snapshot=(await db.query('select snapshot_hash from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5',[owner,row.scope_id,row.object_type,row.object_id,row.object_version])).rows[0]
   if(!snapshot||snapshot.snapshot_hash!==row.snapshot_hash)return settle('rejected','teloa/storage-corrupt')
   // 本任务自己的本轮工作控制：已停止/已结束 → needs-user；本人暂停 → 保持排队，不改为 ready、不升版本。
   const lineage=(await db.query('select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,row.task_id])).rows[0]?.lineage as {roundControlId?:unknown}|undefined
   const control=typeof lineage?.roundControlId==='string'?(await db.query('select state from teloa_work_controls where owner_id=$1 and id=$2',[owner,lineage.roundControlId])).rows[0]:undefined
   if(!control)return settle('needs-user','teloa/control-unavailable')
   if(control&&control.state!=='active'){if(['ending','ended','stopping','stopped'].includes(String(control.state)))return settle('needs-user','teloa/control-inactive');return read(row)}
   if(!continuable.includes(String(task.state)))return read(row)
   const updated=(await db.query("update teloa_tasks set state='ready',version=version+1,updated_at=$3 where owner_id=$1 and id=$2 returning version",[owner,row.task_id,now])).rows[0]
   return read((await db.query("update teloa_business_task_source_updates set state='continued',task_version=$3,updated_at=$4 where owner_id=$1 and id=$2 returning *",[owner,id,updated!.version,now])).rows[0]!)
  })
 }
 /** 分阶段回填：continued 只记 Run 身份；accepted 在核实原生受理后写；失败按确定性记 needs-user。绑定的 Run 身份一经写入不可更换。 */
 async settle(owner:string,input:{id:string;state:Exclude<BusinessTaskSourceUpdateState,'pending'>;runId:string|null;reason:string|null}):Promise<BusinessTaskSourceUpdate>{
  ownerId(owner)
  const from=input.state==='continued'||input.state==='accepted'?['continued']:['pending','continued']
  const row=(await this.pool.query(`update teloa_business_task_source_updates set state=$3,run_id=coalesce(run_id,$4),reason=$5,updated_at=$6
   where owner_id=$1 and id=$2 and state=any($7::text[]) and (run_id is null or $4::uuid is null or run_id=$4) returning *`,[owner,input.id,input.state,input.runId,input.reason,this.identity.now(),from])).rows[0]
  if(!row)return this.get(owner,input.id)
  return read(row)
 }
}
