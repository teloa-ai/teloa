import type {Pool,PoolClient} from 'pg'
import {WorkError,groupRoutingRetryInput,isGroupMention,isGroupRoutingDecision,type GroupMention,type GroupRoutingDecision} from '@teloa/contract'
import {workAccess} from './work-access.ts'

type Database=Pick<PoolClient,'query'>
const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群路由尝试记录损坏，已停止读取。')

/**
 * 原消息重试的尝试历史（规格 §5、§6.4）。第一尝试就是原决策行（`teloa_group_routing_decisions`，保留为旧审计）；
 * 每次显式重试追加一行 `attempt_version>=2`，终态决策只写一次。行不可删除、终态不可改写，由数据库触发器兜底。
 */
export async function initializeGroupRoutingAttempts(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_group_routing_attempts(
  owner_id text not null,message_id uuid not null,group_id uuid not null,
  attempt_version integer not null check(attempt_version>1),
  request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  group_version integer not null check(group_version>0),
  override_recipients jsonb check(override_recipients is null or jsonb_typeof(override_recipients)='array'),
  decision jsonb check(decision is null or jsonb_typeof(decision)='object'),
  created_at timestamptz not null,settled_at timestamptz,
  primary key(owner_id,message_id,attempt_version),unique(owner_id,request_id),
  foreign key(owner_id,message_id) references teloa_group_routing_decisions(owner_id,message_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id),
  check((decision is null)=(settled_at is null))
 );
 create or replace function teloa_group_routing_attempts_append_only() returns trigger language plpgsql as $$ begin
  if tg_op='DELETE' or old.decision is not null or new.decision is null
   or (new.owner_id,new.message_id,new.group_id,new.attempt_version,new.request_id,new.request_spec,new.group_version,new.override_recipients,new.created_at)
   is distinct from (old.owner_id,old.message_id,old.group_id,old.attempt_version,old.request_id,old.request_spec,old.group_version,old.override_recipients,old.created_at)
  then raise exception 'teloa_group_routing_attempts rows are append-only'; end if;
  return new;
 end $$;
 drop trigger if exists teloa_group_routing_attempts_append_only on teloa_group_routing_attempts;
 create trigger teloa_group_routing_attempts_append_only before update or delete on teloa_group_routing_attempts for each row execute function teloa_group_routing_attempts_append_only();
`)}

export type GroupRoutingAttempt={attemptVersion:number;decision:GroupRoutingDecision|null;overrideRecipients:GroupMention[]|null}

/** 只有没有派出任何接收者的退化、解析失败、无候选与直接目标不可用可以沿原消息重新安排。 */
export const groupRoutingRetryableKinds:readonly GroupRoutingDecision['kind'][]=['degraded','parse-failed','no-candidate','blocked']
export function groupRoutingRetryable(decision:GroupRoutingDecision|null,delivered:boolean):boolean{
 return !!decision&&!delivered&&decision.respond.length===0&&groupRoutingRetryableKinds.includes(decision.kind)
}

function readAttempt(row:Record<string,unknown>):GroupRoutingAttempt{
 const version=row.attempt_version,decision=row.decision??null,override=row.override_recipients??null
 if(!Number.isSafeInteger(version)||(version as number)<2||decision!==null&&!isGroupRoutingDecision(decision)||override!==null&&(!Array.isArray(override)||!override.every(isGroupMention)))throw corrupt()
 return {attemptVersion:version as number,decision:decision as GroupRoutingDecision|null,overrideRecipients:override===null?null:(override as GroupMention[]).map(item=>({...item}))}
}

/** 本消息当前尝试：有重试行时取最高版本，否则是第一尝试（原决策行，尚未路由时决策为 null）。 */
export async function readCurrentGroupRoutingAttempt(db:Database,owner:string,messageId:string):Promise<GroupRoutingAttempt>{
 const latest=(await db.query('select * from teloa_group_routing_attempts where owner_id=$1 and message_id=$2 order by attempt_version desc limit 1',[owner,messageId])).rows[0]
 if(latest)return readAttempt(latest)
 const original=(await db.query('select decision from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,messageId])).rows[0]
 if(original&&!isGroupRoutingDecision(original.decision))throw corrupt()
 return {attemptVersion:1,decision:original?original.decision as GroupRoutingDecision:null,overrideRecipients:null}
}

export class GroupRoutingAttemptService{
 readonly pool:Pool
 readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}

 /** 锁内调用：仍待路由的重试尝试。原决策尚未写入时没有重试行，由原第一尝试路径负责。 */
 async pending(db:PoolClient,owner:string,messageId:string):Promise<GroupRoutingAttempt|undefined>{
  ownerId(owner)
  const current=await readCurrentGroupRoutingAttempt(db,owner,messageId)
  return current.attemptVersion>1&&current.decision===null?current:undefined
 }

 /**
  * 锁内一次性写入尝试终态。只认仍是最新且尚未定案的那一版：旧尝试迟到的回答、并发的第二次写入都空手而归。
  */
 async settle(db:PoolClient,owner:string,input:{messageId:string;attemptVersion:number;decision:GroupRoutingDecision}):Promise<GroupRoutingDecision|undefined>{
  ownerId(owner)
  if(!isGroupRoutingDecision(input.decision)||!Number.isSafeInteger(input.attemptVersion)||input.attemptVersion<2)throw new WorkError('teloa/invalid-input','群路由尝试决策格式不正确。')
  const written=await db.query(`update teloa_group_routing_attempts set decision=$4,settled_at=$5 where owner_id=$1 and message_id=$2 and attempt_version=$3 and decision is null
   and attempt_version=(select max(attempt_version) from teloa_group_routing_attempts where owner_id=$1 and message_id=$2) returning attempt_version`,[owner,input.messageId,input.attemptVersion,JSON.stringify(input.decision),this.identity.now()])
  return written.rowCount?input.decision:undefined
 }

 /**
  * 沿原 messageId 重新安排（规格 §5）：不重新保存正文，旧决策与旧回执保留。
  * 已有任何派工（含未知提交）时拒绝重新选人，只能核对原对象；同一 requestId 重放回同一尝试。
  */
 async retry(owner:string,input:unknown):Promise<{messageId:string;attemptVersion:number}>{
  ownerId(owner)
  const request=groupRoutingRetryInput(input),spec=JSON.stringify(request)
  const message=(await this.pool.query('select id,group_id,root_id,author_id from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3',[owner,request.groupId,request.messageId])).rows[0]
  if(!message)throw new WorkError('teloa/forbidden','群消息不属于当前本人或当前群。')
  if(message.author_id!=='self')throw new WorkError('teloa/forbidden','只能重新安排本人发出的消息。')
  const rootId=message.root_id===null?String(message.id):String(message.root_id)
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   // 与路由编排段 A/段 C 同一把话题锁：重试登记与终态决策、接收者投递互斥。
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-routing',owner,request.groupId,rootId])])
   const prior=(await client.query('select attempt_version,request_spec=$3::jsonb as same_request,message_id from teloa_group_routing_attempts where owner_id=$1 and request_id=$2',[owner,request.requestId,spec])).rows[0]
   if(prior){
    if(!prior.same_request||prior.message_id!==request.messageId)throw new WorkError('teloa/conflict','同一重试请求不能更换内容。')
    await client.query('commit')
    return {messageId:request.messageId,attemptVersion:prior.attempt_version as number}
   }
   const group=(await client.query('select version,archived from teloa_groups where owner_id=$1 and id=$2 for share',[owner,request.groupId])).rows[0]
   if(!group)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
   if(group.archived)throw new WorkError('teloa/conflict','已归档群不能重新安排回应。')
   if(group.version!==request.expectedGroupVersion)throw new WorkError('teloa/version-conflict','群设置已变化，请刷新后再重新安排。')
   const current=await readCurrentGroupRoutingAttempt(client,owner,request.messageId)
   if(current.decision===null)throw new WorkError('teloa/conflict','原消息仍在安排中，请稍后查看。')
   if(current.attemptVersion!==request.expectedAttempt)throw new WorkError('teloa/version-conflict','原消息的安排已变化，请刷新后核对。')
   const delivered=!!(await client.query('select 1 from teloa_group_routing_outbox where owner_id=$1 and message_id=$2 limit 1',[owner,request.messageId])).rowCount
   if(!groupRoutingRetryable(current.decision,delivered))throw new WorkError('teloa/conflict','这条消息已有员工接手或不需要重新安排，请查看原工作。')
   for(const recipient of request.overrideRecipients??[]){
    const role=(await client.query(`select roles.version,roles.state from teloa_group_members members join teloa_roles roles on roles.id=members.role_id and roles.owner_id=members.owner_id
     where members.owner_id=$1 and members.group_id=$2 and members.role_id=$3 for share of members,roles`,[owner,request.groupId,recipient.roleId])).rows[0]
    if(!role||role.state!=='active')throw new WorkError('teloa/forbidden','选择的员工不在本群或不可回应。')
    if(role.version!==recipient.expectedVersion)throw new WorkError('teloa/version-conflict','选择的员工已变化，请刷新后重试。')
   }
   const admission=await workAccess.authorize({kind:'capability',capability:'groups',ownerId:owner,sessionId:null,objectId:request.groupId,operation:'run'})
   admission.assertCurrent()
   const attemptVersion=current.attemptVersion+1,now=this.identity.now()
   await client.query(`insert into teloa_group_routing_attempts(owner_id,message_id,group_id,attempt_version,request_id,request_spec,group_version,override_recipients,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[owner,request.messageId,request.groupId,attemptVersion,request.requestId,spec,group.version,request.overrideRecipients?JSON.stringify(request.overrideRecipients):null,now])
   // 沿原消息重新唤醒：不新建消息、不复制正文；已结算的唤醒回到待处理，由常驻恢复与即时编排共同接手。
   await client.query(`insert into teloa_group_routing_wakes(owner_id,group_id,message_id,created_at) values($1,$2,$3,$4)
    on conflict(owner_id,message_id) do update set state='pending',next_attempt_at=null`,[owner,request.groupId,request.messageId,now])
   admission.assertCurrent()
   await client.query('commit')
   return {messageId:request.messageId,attemptVersion}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}
