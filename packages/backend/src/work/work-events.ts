import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isResourceSpec} from '@teloa/contract'
import {readWorkEvent,workObject,workUuid,type WorkEvent} from '@teloa/contract'
import {readStoredPlan} from './plans.ts'
import {PlanOccurrenceService,type PlanOccurrence,} from './plan-occurrences.ts'
import type {PlanMarketSources} from './plans.ts'
import {readStoredSecurityApproval} from '../security/approvals.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'

export type TrustedMaterialVersion={sourceVersion:string;contentSha256:string}
export type WorkEventPorts={material:(db:PoolClient,owner:string,resourceId:string)=>Promise<TrustedMaterialVersion>;approval?:(db:PoolClient,owner:string,actionId:string,actionVersion:number,approvalId:string)=>Promise<void>}
const denied=()=>new WorkError('teloa/forbidden','工作事件缺少当前真实来源或执行边界。')
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>[k,canonical(v)])):value
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
const date=(v:Date)=>v.toISOString()
export async function initializeWorkEvents(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_work_events(id uuid not null,owner_id text not null,source_event_id text not null,event jsonb not null,payload jsonb not null,payload_hash text not null,created_at timestamptz not null,primary key(owner_id,id),unique(owner_id,source_event_id));
 create table if not exists teloa_plan_work_events(owner_id text not null,plan_id uuid not null,definition_version integer not null,event_id uuid not null,source_event_id text not null,state text not null check(state in ('pending','superseded','claimed')),claim_id uuid,created_at timestamptz not null,primary key(owner_id,plan_id,definition_version,source_event_id),foreign key(owner_id,event_id) references teloa_work_events(owner_id,id),foreign key(plan_id,owner_id) references teloa_plans(id,owner_id));
 create index if not exists teloa_plan_work_events_pending on teloa_plan_work_events(owner_id,created_at,event_id) where state='pending';
 create or replace function teloa_work_event_immutable() returns trigger language plpgsql as $$ begin raise exception 'work event source is immutable'; end $$;
 create or replace trigger teloa_work_events_immutable before update or delete on teloa_work_events for each row execute function teloa_work_event_immutable();
`)}
export class WorkEventService{
 readonly pool:Pool;readonly clock:{id:()=>string;now:()=>string};readonly ports:WorkEventPorts|undefined;readonly market:PlanMarketSources|undefined
 constructor(pool:Pool,clock:{id:()=>string;now:()=>string},ports?:WorkEventPorts,market?:PlanMarketSources){this.pool=pool;this.clock=clock;this.ports=ports;this.market=market}
 private read(row:Record<string,any>):WorkEvent{try{const event=readWorkEvent(row.event);if(event.id!==row.id||event.ownerId!==row.owner_id||event.sourceEventId!==row.source_event_id||event.createdAt!==date(row.created_at)||row.payload_hash!==digest(row.payload))throw Error();return event}catch{throw new WorkError('teloa/storage-corrupt','工作事件或真实来源摘要损坏。')}}
 /** Flow 收据复用事件原件与真实来源检查；不接受模型上传事件正文。 */
 async verifiedSourceInTransaction(db:PoolClient,owner:string,eventId:string):Promise<{event:WorkEvent;payload:Record<string,any>}>{
  const row=(await db.query('select * from teloa_work_events where owner_id=$1 and id=$2',[owner,eventId])).rows[0];if(!row)throw denied();const event=this.read(row),payload=row.payload
  if(event.kind==='material-version'){const actual=(await db.query("select * from teloa_resources where owner_id=$1 and id=$2 and status='active' for share",[owner,event.sourceId])).rows[0];if(!actual||!isResourceSpec(actual.spec)||!this.ports)throw denied();const current=await this.ports.material(db,owner,event.sourceId);if(actual.revision!==payload.revision||current.sourceVersion!==payload.sourceVersion||current.contentSha256!==payload.contentSha256)throw denied()}
  else if(event.kind==='group-message'){if(!(await db.query('select 1 from teloa_group_messages m join teloa_groups g on g.id=m.group_id and g.owner_id=m.owner_id where m.owner_id=$1 and m.id=$2 and m.group_id=$3 and not g.archived for share of m,g',[owner,payload.messageId,event.sourceId])).rows[0])throw denied()}
  else if(event.kind==='child-completed'){const child=(await db.query("select * from teloa_task_run_subagents where owner_id=$1 and run_id=$2 and reservation_id=$3 for share",[owner,event.sourceId,payload.reservationId])).rows[0];if(!child||child.state!=='ended'||!child.ended_at||date(child.ended_at)!==event.sourceVersion)throw denied()}
  else{const approval=(await db.query('select p.*,a.version as current_version,a.state as action_state,(select request_id from teloa_security_action_requests ar where ar.owner_id=a.owner_id and ar.result_action_id=a.id order by ar.result_action_version limit 1) as operation_request_id from teloa_security_approvals p join teloa_security_actions a on a.id=p.action_id and a.owner_id=p.owner_id where p.owner_id=$1 and p.id=$2 for share of p,a',[owner,payload.approvalId])).rows[0],control=(await db.query('select state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,payload.roundControlId])).rows[0];if(!approval||readStoredSecurityApproval(approval).decision!=='approved'||approval.current_version!==payload.actionVersion+1||approval.action_state!=='approved'||approval.operation_request_id!==payload.operationRequestId||date(approval.expires_at)<=this.clock.now()||!control||control.state!=='active'||control.generation!==payload.controlGeneration||!this.ports?.approval)throw denied();await this.ports.approval(db,owner,event.sourceId,approval.current_version,payload.approvalId)}
  return {event,payload}
 }
 /** 只能由宿主真实来源回调调用；事件 owner/source/version 从持久原件派生。 */
 async appendSource(db:PoolClient,input:{kind:WorkEvent['kind'];sourceId:string;receiptId?:string}):Promise<WorkEvent>{
  if(!workUuid(input.sourceId))throw denied()
  let owner:string,version:string,sourceEventId:string,payload:Record<string,unknown>
  if(input.kind==='material-version'){
   const row=(await db.query('select * from teloa_resources where id=$1 for share',[input.sourceId])).rows[0];if(!row||row.status!=='active'||!isResourceSpec(row.spec)||!this.ports)throw denied()
   owner=row.owner_id;const current=await this.ports.material(db,owner,row.id);if(current.sourceVersion!==row.spec.sourceVersion||!/^[0-9a-f]{64}$/.test(current.contentSha256))throw denied()
   version=String(row.revision)+':'+current.sourceVersion;sourceEventId='material:'+row.id+':'+version+':'+current.contentSha256;payload={kind:input.kind,scopeIds:row.spec.scopeIds,resourceId:row.id,revision:row.revision,sourceVersion:current.sourceVersion,contentSha256:current.contentSha256}
  }else if(input.kind==='group-message'){
   if(!workUuid(input.receiptId))throw denied();const row=(await db.query('select m.*,g.archived from teloa_group_messages m join teloa_groups g on g.id=m.group_id and g.owner_id=m.owner_id where m.id=$1 and m.group_id=$2 for share of m,g',[input.receiptId,input.sourceId])).rows[0];if(!row||row.archived)throw denied();owner=row.owner_id;version=date(row.created_at);sourceEventId='group-message:'+row.id;payload={kind:input.kind,messageId:row.id,groupId:row.group_id,taskId:row.task_id??null,runId:row.run_id??null}
  }else if(input.kind==='child-completed'){
   if(typeof input.receiptId!=='string')throw denied();const row=(await db.query("select s.*,r.task_id from teloa_task_run_subagents s join teloa_task_runs r on r.id=s.run_id and r.owner_id=s.owner_id where s.run_id=$1 and s.reservation_id=$2 and s.state='ended' for share of s,r",[input.sourceId,input.receiptId])).rows[0];if(!row||!row.ended_at)throw denied();owner=row.owner_id;version=date(row.ended_at);sourceEventId='child:'+row.run_id+':'+row.reservation_id+':'+version;payload={kind:input.kind,parentRunId:row.run_id,reservationId:row.reservation_id,taskId:row.task_id}
  }else if(input.kind==='approval-result'){
   if(!workUuid(input.receiptId))throw denied();const row=(await db.query('select p.*,a.version as current_action_version,a.task_id,a.state as action_state,(select request_id from teloa_security_action_requests ar where ar.owner_id=a.owner_id and ar.result_action_id=a.id order by ar.result_action_version limit 1) as operation_request_id from teloa_security_approvals p join teloa_security_actions a on a.id=p.action_id and a.owner_id=p.owner_id where p.id=$1 and p.action_id=$2 for share of p,a',[input.receiptId,input.sourceId])).rows[0];if(!row)throw denied();const approval=readStoredSecurityApproval(row);if(approval.decision!=='approved'||approval.actionVersion!==row.current_action_version-1||row.action_state!=='approved'||date(row.expires_at)<=this.clock.now()||!workUuid(row.task_id))throw denied();if(!this.ports?.approval||!workUuid(row.operation_request_id))throw denied();await this.ports.approval(db,row.owner_id,row.action_id,row.current_action_version,approval.id);const lineage=(await db.query('select lineage from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[row.owner_id,row.task_id])).rows[0]?.lineage;if(!lineage)throw denied();const control=(await db.query('select state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[row.owner_id,lineage.roundControlId])).rows[0];if(!control||control.state!=='active')throw denied();owner=row.owner_id;version=String(approval.actionVersion);sourceEventId='approval:'+approval.id;payload={kind:input.kind,approvalId:approval.id,actionId:approval.actionId,actionVersion:approval.actionVersion,operationRequestId:row.operation_request_id,taskId:row.task_id,roundControlId:lineage.roundControlId,controlGeneration:control.generation,expiresAt:date(row.expires_at)}
  }else throw denied()
  const event=readWorkEvent({schema:'teloa.work-event/v1',id:this.clock.id(),ownerId:owner,sourceEventId,kind:input.kind,sourceId:input.sourceId,sourceVersion:version,createdAt:this.clock.now()})
  return this.save(db,event,payload)
 }
 /** 兼容服务端已有来源事件；仍重新核对真实记录，不信任参数中的 owner/version。 */
 async appendTrusted(db:PoolClient,owner:string,value:WorkEvent):Promise<WorkEvent>{const event=readWorkEvent(value);if(event.ownerId!==owner)throw denied();const receiptId=event.kind==='group-message'?event.sourceEventId.replace(/^group-message:/,''):event.kind==='approval-result'?event.sourceEventId.replace(/^approval:/,''):event.kind==='child-completed'?event.sourceEventId.split(':')[2]:undefined;const saved=await this.appendSource(db,{kind:event.kind,sourceId:event.sourceId,...(receiptId?{receiptId}:{})});if(saved.ownerId!==owner||saved.sourceEventId!==event.sourceEventId||saved.sourceVersion!==event.sourceVersion)throw denied();return saved}
 private async save(db:PoolClient,event:WorkEvent,payload:Record<string,unknown>):Promise<WorkEvent>{
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/work-event/'+event.ownerId+'/'+event.sourceEventId])
  const prior=(await db.query('select * from teloa_work_events where owner_id=$1 and source_event_id=$2',[event.ownerId,event.sourceEventId])).rows[0]
  if(prior){const saved=this.read(prior);if(saved.kind!==event.kind||saved.sourceId!==event.sourceId||saved.sourceVersion!==event.sourceVersion||!isDeepStrictEqual(prior.payload,payload))throw new WorkError('teloa/conflict','原来源事件已保存其他内容。');return saved}
  await db.query('insert into teloa_work_events(id,owner_id,source_event_id,event,payload,payload_hash,created_at) values($1,$2,$3,$4,$5,$6,$7)',[event.id,event.ownerId,event.sourceEventId,JSON.stringify(event),JSON.stringify(payload),digest(payload),event.createdAt])
  const plans=(await db.query("select * from teloa_plans where owner_id=$1 and state<>'archived' and work_definition is not null",[event.ownerId])).rows.map(readStoredPlan)
  for(const plan of plans){const trigger=plan.workDefinition!.triggers.find(t=>t.kind==='local-event'&&t.eventKind===event.kind&&t.sourceId===event.sourceId);if(!trigger||trigger.kind!=='local-event')continue
   if(trigger.coalesce==='latest')await db.query("update teloa_plan_work_events q set state='superseded' from teloa_work_events e where q.owner_id=$1 and q.plan_id=$2 and q.definition_version=$3 and q.state='pending' and e.owner_id=q.owner_id and e.id=q.event_id and e.event->>'kind'=$4 and e.event->>'sourceId'=$5",[event.ownerId,plan.id,plan.configVersion,event.kind,event.sourceId])
   await db.query("insert into teloa_plan_work_events(owner_id,plan_id,definition_version,event_id,source_event_id,state,created_at) values($1,$2,$3,$4,$5,'pending',$6) on conflict do nothing",[event.ownerId,plan.id,plan.configVersion,event.id,event.sourceEventId,event.createdAt])
  }return event
 }
 async claim(owner:string,value:unknown):Promise<PlanOccurrence|null>{
  const v=workObject(value,['planId','definitionVersion','eventId','controlGeneration']);if(!workUuid(v.planId)||!workUuid(v.eventId)||!Number.isSafeInteger(v.definitionVersion)||Number(v.definitionVersion)<1||!Number.isSafeInteger(v.controlGeneration)||Number(v.controlGeneration)<1)throw denied()
  const db=await this.pool.connect();try{await db.query('begin')
   const stored=(await db.query('select * from teloa_work_events where owner_id=$1 and id=$2',[owner,v.eventId])).rows[0];if(!stored)throw denied();const event=this.read(stored)
   const result=await new PlanOccurrenceService(this.pool,this.clock,this.market).claimEventInTransaction(db,owner,{planId:v.planId,definitionVersion:Number(v.definitionVersion),event,controlGeneration:Number(v.controlGeneration),now:this.clock.now()},async()=>{
    if(event.kind==='material-version'){const actual=(await db.query("select * from teloa_resources where owner_id=$1 and id=$2 and status='active' for share",[owner,event.sourceId])).rows[0];if(!actual||!isResourceSpec(actual.spec)||!this.ports)throw denied();const current=await this.ports.material(db,owner,event.sourceId);if(actual.revision!==stored.payload.revision||current.sourceVersion!==stored.payload.sourceVersion||current.contentSha256!==stored.payload.contentSha256)throw new WorkError('teloa/version-conflict','资料事件已被新版本替代。')}
    else if(event.kind==='group-message'){
     const row=(await db.query('select m.id from teloa_group_messages m join teloa_groups g on g.id=m.group_id and g.owner_id=m.owner_id where m.owner_id=$1 and m.id=$2 and m.group_id=$3 and not g.archived for share of m,g',[owner,stored.payload.messageId,event.sourceId])).rows[0],plan=readStoredPlan((await db.query('select * from teloa_plans where owner_id=$1 and id=$2',[owner,v.planId])).rows[0])
     if(!row||!plan.workDefinition)throw denied()
     const grant=await new RoleWorkEligibilityService(this.pool).authorize(owner,{roleId:plan.roleId,expectedRoleVersion:plan.roleVersion,scope:plan.scope,inputSchema:'teloa.task-run-input/v2',authorization:plan.workDefinition.authorization,groupId:event.sourceId},db);grant.assertCurrent()
    }else if(event.kind==='child-completed'){
     const child=(await db.query("select s.*,r.task_id from teloa_task_run_subagents s join teloa_task_runs r on r.id=s.run_id and r.owner_id=s.owner_id where s.owner_id=$1 and s.run_id=$2 and s.reservation_id=$3 for share of s,r",[owner,event.sourceId,stored.payload.reservationId])).rows[0]
     if(!child||child.state!=='ended'||!child.ended_at||date(child.ended_at)!==event.sourceVersion||child.task_id!==stored.payload.taskId)throw denied()
    }else if(event.kind==='approval-result'){const row=(await db.query('select p.*,a.version as current_version,a.state as action_state,(select request_id from teloa_security_action_requests ar where ar.owner_id=a.owner_id and ar.result_action_id=a.id order by ar.result_action_version limit 1) as operation_request_id from teloa_security_approvals p join teloa_security_actions a on a.id=p.action_id and a.owner_id=p.owner_id where p.owner_id=$1 and p.id=$2 for share of p,a',[owner,stored.payload.approvalId])).rows[0],control=(await db.query('select generation,state from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,stored.payload.roundControlId])).rows[0];if(!row||readStoredSecurityApproval(row).decision!=='approved'||row.current_version!==stored.payload.actionVersion+1||row.action_state!=='approved'||row.operation_request_id!==stored.payload.operationRequestId||date(row.expires_at)<=this.clock.now()||!control||control.generation!==stored.payload.controlGeneration||control.state!=='active'||!this.ports?.approval)throw denied();await this.ports.approval(db,owner,event.sourceId,row.current_version,stored.payload.approvalId)}
   })
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async pending(owner:string):Promise<{event:WorkEvent;planId:string;definitionVersion:number;controlGeneration:number}[]>{
  const rows=(await this.pool.query("select e.*,q.plan_id,q.definition_version,c.generation as control_generation from teloa_plan_work_events q join teloa_work_events e on e.owner_id=q.owner_id and e.id=q.event_id join teloa_plans p on p.id=q.plan_id and p.owner_id=q.owner_id and p.config_version=q.definition_version join teloa_work_controls c on c.id=(p.work_definition->>'definitionControlId')::uuid and c.owner_id=p.owner_id where q.owner_id=$1 and q.state='pending' and p.state='active' and c.state='active' order by q.created_at,q.event_id limit 100",[owner])).rows
  return rows.map(row=>({event:this.read(row),planId:row.plan_id,definitionVersion:row.definition_version,controlGeneration:row.control_generation}))
 }
}
