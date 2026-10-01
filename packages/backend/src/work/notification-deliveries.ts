import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool} from 'pg'
import {WorkError,isRecord} from '@teloa/contract'
import {readStoredPlanOccurrence} from './plan-occurrences.ts'
import {readStoredTask} from './tasks.ts'
import {readStoredTaskRun} from './task-runs.ts'
import type {PlanNotificationPolicy} from './plans.ts'

export type NotificationConclusion='policy-always'|'attention-required'|'execution-failed'
export type NotificationDeliveryStatus='pending'|'delivering'|'delivered'|'failed'
export type NotificationDelivery={
 id:string;ownerId:string;claimId:string;planId:string;taskId:string;runId:string
 policy:Exclude<PlanNotificationPolicy,'silent'>;conclusion:NotificationConclusion;channel:string
 status:NotificationDeliveryStatus;attempts:number;attemptToken:string|null;leaseExpiresAt:string|null
 receipt:{receiptId:string}|null;error:{code:string}|null;createdAt:string;updatedAt:string;deliveredAt:string|null
}

const invalid=()=>new WorkError('teloa/invalid-input','通知投递请求包含未知字段或格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','通知投递或来源事实损坏，已停止处理。')
const exact=(value:unknown,keys:readonly string[]):Record<string,unknown>=>{if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalid();return value}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const channel=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9][a-z0-9.-]{0,79}$/.test(value)
const deliveryId=(value:unknown):value is string=>typeof value==='string'&&/^notification:v1:[a-f0-9]{64}$/.test(value)
const safeCode=(value:unknown):value is string=>typeof value==='string'&&/^teloa\/[a-z0-9][a-z0-9.-]{0,99}$/.test(value)
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const moment=(value:unknown):string=>{if(typeof value!=='string')throw invalid();const parsed=new Date(value);if(!Number.isFinite(parsed.getTime())||parsed.toISOString()!==value)throw invalid();return value}
const stableId=(claimId:string,runId:string,policy:string,targetChannel:string):string=>{
 const canonical=JSON.stringify(['teloa.notification-delivery/v1',['plan-occurrence',claimId],['task-run-terminal',runId],[policy,targetChannel]])
 return 'notification:v1:'+createHash('sha256').update(canonical).digest('hex')
}
const conclusion=(policy:PlanNotificationPolicy,reason:string|undefined,state:string):NotificationConclusion|undefined=>{
 const failure=state==='configuration_failed'||state==='ended'&&reason!=='completed'&&reason!=='aborted'
 const attention=state==='configuration_failed'||state==='ended'&&reason!=='aborted'
 if(policy==='always')return 'policy-always'
 if(policy==='attention'&&attention)return 'attention-required'
 if(policy==='failure'&&failure)return 'execution-failed'
 return undefined
}

export async function initializeNotificationDeliveries(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_notification_deliveries(
  id text primary key check(id ~ '^notification:v1:[a-f0-9]{64}$'),owner_id text not null,
  claim_id uuid not null references teloa_plan_occurrences(id),plan_id uuid not null references teloa_plans(id),
  task_id uuid not null references teloa_tasks(id),run_id uuid not null references teloa_task_runs(id),
  policy text not null check(policy in ('always','attention','failure')),
  conclusion text not null check(conclusion in ('policy-always','attention-required','execution-failed')),
  channel text not null check(channel ~ '^[a-z0-9][a-z0-9.-]{0,79}$'),
  status text not null check(status in ('pending','delivering','delivered','failed')),
  attempts integer not null check(attempts>=0),attempt_token uuid,lease_expires_at timestamptz,
  receipt jsonb,error jsonb,created_at timestamptz not null,updated_at timestamptz not null,delivered_at timestamptz,
  unique(owner_id,claim_id,run_id,policy,channel),
  check(receipt is null or jsonb_typeof(receipt)='object'),check(error is null or jsonb_typeof(error)='object'),
  check(
   (status='pending' and attempts=0 and attempt_token is null and lease_expires_at is null and receipt is null and error is null and delivered_at is null) or
   (status='delivering' and attempts>0 and attempt_token is not null and lease_expires_at is not null and receipt is null and error is null and delivered_at is null) or
   (status='failed' and attempts>0 and attempt_token is null and lease_expires_at is null and receipt is null and error is not null and delivered_at is null) or
   (status='delivered' and attempts>0 and attempt_token is null and lease_expires_at is null and receipt is not null and error is null and delivered_at is not null)
  )
 );
 create index if not exists teloa_notification_delivery_claimable on teloa_notification_deliveries(owner_id,channel,created_at,id) where status<>'delivered'`)
}

function read(row:Record<string,unknown>):NotificationDelivery{
 try{
  if(!deliveryId(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!uuid(row.claim_id)||!uuid(row.plan_id)||!uuid(row.task_id)||!uuid(row.run_id)||!['always','attention','failure'].includes(String(row.policy))||!['policy-always','attention-required','execution-failed'].includes(String(row.conclusion))||!channel(row.channel)||!['pending','delivering','delivered','failed'].includes(String(row.status))||!Number.isSafeInteger(row.attempts)||Number(row.attempts)<0)throw Error()
  const expected=stableId(row.claim_id,row.run_id,String(row.policy),row.channel)
  if(row.id!==expected)throw Error()
  const attemptToken=row.attempt_token===null?null:uuid(row.attempt_token)?row.attempt_token:null
  if(row.attempt_token!==null&&attemptToken===null)throw Error()
  const leaseExpiresAt=row.lease_expires_at===null?null:stamp(row.lease_expires_at),deliveredAt=row.delivered_at===null?null:stamp(row.delivered_at)
  let receipt:NotificationDelivery['receipt']=null,error:NotificationDelivery['error']=null
  if(row.receipt!==null){const value=exact(row.receipt,['receiptId']);if(typeof value.receiptId!=='string'||!value.receiptId.trim()||value.receiptId.length>240)throw Error();receipt={receiptId:value.receiptId}}
  if(row.error!==null){const value=exact(row.error,['code']);if(!safeCode(value.code))throw Error();error={code:value.code}}
  const status=row.status as NotificationDeliveryStatus,attempts=Number(row.attempts)
  if(status==='pending'?(attempts!==0||attemptToken!==null||leaseExpiresAt!==null||receipt!==null||error!==null||deliveredAt!==null):status==='delivering'?(attempts<1||attemptToken===null||leaseExpiresAt===null||receipt!==null||error!==null||deliveredAt!==null):status==='failed'?(attempts<1||attemptToken!==null||leaseExpiresAt!==null||receipt!==null||error===null||deliveredAt!==null):(attempts<1||attemptToken!==null||leaseExpiresAt!==null||receipt===null||error!==null||deliveredAt===null))throw Error()
  return {id:row.id,ownerId:row.owner_id,claimId:row.claim_id,planId:row.plan_id,taskId:row.task_id,runId:row.run_id,policy:row.policy as NotificationDelivery['policy'],conclusion:row.conclusion as NotificationConclusion,channel:row.channel,status,attempts,attemptToken,leaseExpiresAt,receipt,error,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at),deliveredAt}
 }catch(error){if(error instanceof WorkError&&error.code==='teloa/storage-corrupt')throw error;throw corrupt()}
}

export class NotificationDeliveryService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 async materialize(owner:string,input:unknown):Promise<{deliveryIds:string[]}>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['channel','limit','now']);if(!channel(value.channel)||!Number.isSafeInteger(value.limit)||Number(value.limit)<1||Number(value.limit)>100)throw invalid();const now=moment(value.now),limit=Number(value.limit)
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read')
   const rows=(await db.query(`select o.*,l.owner_id linked_owner_id,l.task_request_id linked_request_id,l.task_id linked_task_id,
    row_to_json(t) task_record,t.created_at task_created_at,t.updated_at task_updated_at,
    row_to_json(r) run_record,r.created_at run_created_at
    from teloa_plan_occurrences o join teloa_plan_task_links l on l.claim_id=o.id
    join teloa_tasks t on t.id=l.task_id join teloa_task_runs r on r.owner_id=o.owner_id and r.request_id=o.id
    where o.owner_id=$1 and r.state in ('ended','configuration_failed')
      and ((o.snapshot #> '{fields,notificationPolicy}') is not null and
           (jsonb_typeof(o.snapshot #> '{fields,notificationPolicy}')<>'string' or o.snapshot #>> '{fields,notificationPolicy}' not in ('always','attention','failure','silent'))
       or o.snapshot #>> '{fields,notificationPolicy}'='always'
       or o.snapshot #>> '{fields,notificationPolicy}'='attention' and (r.state='configuration_failed' or r.evidence->>'reason' is null or r.evidence->>'reason'<>'aborted')
       or o.snapshot #>> '{fields,notificationPolicy}'='failure' and (r.state='configuration_failed' or r.evidence->>'reason' is null or r.evidence->>'reason' not in ('completed','aborted')))
      and not exists(select 1 from teloa_notification_deliveries d where d.owner_id=o.owner_id and d.claim_id=o.id and d.run_id=r.id and d.policy=o.snapshot #>> '{fields,notificationPolicy}' and d.channel=$2 and d.status='delivered')
    order by r.created_at,r.id limit $3`,[owner,value.channel,limit])).rows
   const ids:string[]=[]
   for(const row of rows){
    const occurrence=readStoredPlanOccurrence(row)
    if(occurrence.ownerId!==owner||row.linked_owner_id!==owner||row.linked_request_id!==occurrence.taskRequestId||!uuid(row.linked_task_id)||!isRecord(row.task_record)||!isRecord(row.run_record))throw corrupt()
    const task=readStoredTask({...row.task_record,created_at:row.task_created_at,updated_at:row.task_updated_at}),run=readStoredTaskRun({...row.run_record,created_at:row.run_created_at})
    const fixedTaskRequest={fields:occurrence.taskRequest.fields,assignee:occurrence.taskRequest.assignee}
    if(task.id!==row.linked_task_id||task.ownerId!==owner||row.task_record.request_id!==occurrence.taskRequestId||!isDeepStrictEqual(row.task_record.request_spec,fixedTaskRequest)||row.run_record.owner_id!==owner||row.run_record.request_id!==occurrence.id||run.taskId!==task.id)throw corrupt()
    const policy=occurrence.fields.notificationPolicy,reason=run.evidence?.state==='ended'?run.evidence.reason:undefined,fixedConclusion=policy&&conclusion(policy,reason,run.state)
    if(!policy||policy==='silent'||!fixedConclusion)continue
    const id=stableId(occurrence.id,run.id,policy,value.channel),created=(await db.query(`insert into teloa_notification_deliveries(id,owner_id,claim_id,plan_id,task_id,run_id,policy,conclusion,channel,status,attempts,attempt_token,lease_expires_at,receipt,error,created_at,updated_at,delivered_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',0,null,null,null,null,$10,$10,null)
     on conflict(id) do nothing returning *`,[id,owner,occurrence.id,occurrence.planId,task.id,run.id,policy,fixedConclusion,value.channel,now])).rows[0]
    const stored=created??(await db.query('select * from teloa_notification_deliveries where id=$1 and owner_id=$2',[id,owner])).rows[0]
    const delivery=read(stored)
    if(delivery.claimId!==occurrence.id||delivery.planId!==occurrence.planId||delivery.taskId!==task.id||delivery.runId!==run.id||delivery.policy!==policy||delivery.conclusion!==fixedConclusion||delivery.channel!==value.channel)throw corrupt()
    ids.push(id)
   }
   await db.query('commit');return {deliveryIds:ids}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(owner:string,input:unknown):Promise<NotificationDelivery[]>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。');exact(input,[])
  return (await this.pool.query('select * from teloa_notification_deliveries where owner_id=$1 order by created_at,id',[owner])).rows.map(read)
 }
 async claim(owner:string,input:unknown):Promise<NotificationDelivery|null>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const value=exact(input,['deliveryId','now']);if(!deliveryId(value.deliveryId))throw invalid();const now=moment(value.now),attemptToken=this.identity.id()
  if(!uuid(attemptToken))throw new WorkError('teloa/storage-unavailable','无法生成通知投递尝试身份。')
  const leaseExpiresAt=new Date(Date.parse(now)+30_000).toISOString(),db=await this.pool.connect()
  try{
   await db.query('begin')
   const updated=(await db.query(`update teloa_notification_deliveries set status='delivering',attempts=attempts+1,attempt_token=$4,lease_expires_at=$5,receipt=null,error=null,updated_at=$3
    where id=$1 and owner_id=$2 and (status in ('pending','failed') or status='delivering' and lease_expires_at<=$3) returning *`,[value.deliveryId,owner,now,attemptToken,leaseExpiresAt])).rows[0]
   if(updated){const result=read(updated);await db.query('commit');return result}
   const stored=(await db.query('select * from teloa_notification_deliveries where id=$1',[value.deliveryId])).rows[0]
   if(!stored||stored.owner_id!==owner)throw new WorkError('teloa/forbidden','通知投递不存在或不属于当前本人。')
   read(stored);await db.query('commit');return null
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async complete(owner:string,input:unknown):Promise<NotificationDelivery>{
  return this.finish(owner,input,'delivered')
 }
 async fail(owner:string,input:unknown):Promise<NotificationDelivery>{
  return this.finish(owner,input,'failed')
 }
 private async finish(owner:string,input:unknown,status:'delivered'|'failed'):Promise<NotificationDelivery>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const keys=status==='delivered'?['deliveryId','attemptToken','receiptId','now']:['deliveryId','attemptToken','code','now'],value=exact(input,keys)
  if(!deliveryId(value.deliveryId)||!uuid(value.attemptToken))throw invalid()
  const now=moment(value.now)
  let payload:{receiptId:string}|{code:string}
  if(status==='delivered'){
   if(typeof value.receiptId!=='string'||!value.receiptId.trim()||value.receiptId.length>240||/[\x00-\x1f\x7f]/.test(value.receiptId))throw invalid()
   payload={receiptId:value.receiptId}
  }else{if(!safeCode(value.code))throw invalid();payload={code:value.code}}
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const updated=(await db.query(`update teloa_notification_deliveries set status=$4,attempt_token=null,lease_expires_at=null,
    receipt=case when $4='delivered' then $5::jsonb else null end,error=case when $4='failed' then $5::jsonb else null end,
    updated_at=$6,delivered_at=case when $4='delivered' then $6::timestamptz else null end
    where id=$1 and owner_id=$2 and status='delivering' and attempt_token=$3 returning *`,[value.deliveryId,owner,value.attemptToken,status,JSON.stringify(payload),now])).rows[0]
   if(!updated){const stored=(await db.query('select * from teloa_notification_deliveries where id=$1',[value.deliveryId])).rows[0];if(!stored||stored.owner_id!==owner)throw new WorkError('teloa/forbidden','通知投递不存在或不属于当前本人。');read(stored);throw new WorkError('teloa/conflict','通知投递尝试已过期或已被其他尝试接管。')}
   const result=read(updated);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
