import type {Pool,PoolClient} from 'pg'
import {WorkError,groupRoutingListInput,isGroupRoutingDecision,isGroupRoutingDecisionView,type GroupRoutingDecision,type GroupRoutingDecisionView} from '@teloa/contract'

function ownerId(value:string):void{
 if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
}

const corrupt=()=>new WorkError('teloa/storage-corrupt','群内路由决策记录损坏，已停止读取。')

/**
 * 决策只追加，`kind` 是终值：一条消息路由过就不再重判，重放撞主键即空手而归。
 * 「只追加」由 DB 兜底（照 `web-access.ts:54-57` 的 `teloa_task_run_web_access_immutable` 写法）：
 * 服务类上没有 update/delete 方法只挡住本仓库的调用方，挡不住任何一条手写 SQL。
 */
export async function initializeGroupRoutingDecisions(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_group_routing_decisions(
  owner_id text not null,
  group_id uuid not null,
  message_id uuid not null,
  decision jsonb not null check(jsonb_typeof(decision)='object'),
  created_at timestamptz not null,
  primary key(owner_id,message_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id)
 );
 create index if not exists teloa_group_routing_decisions_group_v1 on teloa_group_routing_decisions(owner_id,group_id);
 create or replace function teloa_group_routing_decisions_immutable() returns trigger language plpgsql as $$ begin raise exception 'teloa_group_routing_decisions rows are append-only'; end $$;
 drop trigger if exists teloa_group_routing_decisions_immutable on teloa_group_routing_decisions;
 create trigger teloa_group_routing_decisions_immutable before update or delete on teloa_group_routing_decisions for each row execute function teloa_group_routing_decisions_immutable();
`)}

/** 话题内的有序序列：与 `collaboration.ts:277` 的话题读法逐字同序（根在最前，其余按发送先后）。 */
async function topicMessages(db:PoolClient,owner:string,groupId:string,rootId:string):Promise<{id:string;authorId:string}[]>{
 const rows=(await db.query('select id,author_id from teloa_group_messages where owner_id=$1 and group_id=$2 and (id=$3 or root_id=$3) order by (id=$3) desc,created_at,id',[owner,groupId,rootId])).rows
 return rows.map(row=>({id:String(row.id),authorId:String(row.author_id)}))
}

function view(row:Record<string,unknown>):GroupRoutingDecisionView{
 const decision=row.decision
 if(!isGroupRoutingDecision(decision))throw corrupt()
 const value={messageId:String(row.message_id),kind:decision.kind,respond:[...decision.respond],hops:decision.hops}
 if(!isGroupRoutingDecisionView(value))throw corrupt()
 return value
}

export class GroupRoutingDecisionService{
 readonly pool:Pool
 readonly identity:{now:()=>string}

 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}

 /**
  * 话题级 advisory lock。段 A 与段 C 各用它包一次；绝不跨模型调用、绝不跨建任务：
  * 锁只护住「读候选、判跳数、写决策」这几条 SQL，任何一次外部调用都必须在锁外。
  */
 async withTopicLock<T>(owner:string,groupId:string,rootId:string,fn:(db:PoolClient)=>Promise<T>):Promise<T>{
  ownerId(owner)
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-routing',owner,groupId,rootId])])
   const result=await fn(client)
   await client.query('commit')
   return result
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 /** 一次性写入终态决策。撞主键即 `undefined`（已被别人路由过）。 */
 async record(db:PoolClient,owner:string,params:{groupId:string;messageId:string;decision:GroupRoutingDecision}):Promise<GroupRoutingDecision|undefined>{
  ownerId(owner)
  if(!isGroupRoutingDecision(params.decision))throw new WorkError('teloa/invalid-input','群内路由决策格式不正确。')
  const written=await db.query('insert into teloa_group_routing_decisions(owner_id,group_id,message_id,decision,created_at) values($1,$2,$3,$4,$5) on conflict do nothing returning message_id',
   [owner,params.groupId,params.messageId,JSON.stringify(params.decision),this.identity.now()])
  return written.rowCount?params.decision:undefined
 }

 async claimed(db:PoolClient,owner:string,messageId:string):Promise<boolean>{
  ownerId(owner)
  return !!(await db.query('select 1 from teloa_group_routing_decisions where owner_id=$1 and message_id=$2',[owner,messageId])).rowCount
 }

 /** 该 messageId 是不是某条决策写出来的停下消息。 */
 async isStopMessage(db:PoolClient,owner:string,groupId:string,messageId:string):Promise<boolean>{
  ownerId(owner)
  return !!(await db.query("select 1 from teloa_group_routing_decisions where owner_id=$1 and group_id=$2 and decision->>'stopMessageId'=$3",[owner,groupId,messageId])).rowCount
 }

 /**
  * H2：本话题最近一条 `relay-stopped` 之后，有没有出现过「本人发的、且不是停下消息本身」的消息。
  * 没有停下过则恒为 true。停下消息自己不算插话——否则闸门刚落下就被自己顶开：
  * 时间戳用 `>=`（同毫秒的本人发言算插话），排除停下消息只靠 `stopMessageId` 那道闸，不靠先后。
  * 插话只认话题序（`created_at,id`）上不晚于触发消息的那些：路由是 fire-and-forget，负载下可能在
  * 本人后来的插话落库之后才跑，那条插话不能替排在它前面的员工消息开闸（与 `hops` 同样按触发位置判）。
  */
 async relayGateOpen(db:PoolClient,owner:string,groupId:string,rootId:string,messageId:string):Promise<boolean>{
  ownerId(owner)
  const stopped=(await db.query(`select d.created_at from teloa_group_routing_decisions d
   join teloa_group_messages m on m.id=d.message_id and m.group_id=d.group_id
   where d.owner_id=$1 and d.group_id=$2 and (m.id=$3 or m.root_id=$3) and d.decision->>'kind'='relay-stopped'
   order by d.created_at desc,d.message_id desc limit 1`,[owner,groupId,rootId])).rows[0]
  if(!stopped)return true
  return !!(await db.query(`select 1 from teloa_group_messages m
   join teloa_group_messages t on t.owner_id=$1 and t.group_id=$2 and t.id=$5
   where m.owner_id=$1 and m.group_id=$2 and (m.id=$3 or m.root_id=$3) and m.author_id='self' and m.created_at>=$4
   and (m.created_at,m.id)<=(t.created_at,t.id)
   and not exists(select 1 from teloa_group_routing_decisions d where d.owner_id=$1 and d.group_id=$2 and d.decision->>'stopMessageId'=m.id::text) limit 1`,
   [owner,groupId,rootId,stopped.created_at,messageId])).rowCount
 }

 /**
  * H2：本话题已有的 `relay-stopped` 决策条数，用来算停下消息 requestId 的 round 分量。
  * 规格 §2.8 的 round = 本值 + 1，且必须在写入本轮决策**之前**读——写完再读会把本轮也数进去，round 就多算一轮。
  */
 async relayStopRounds(db:PoolClient,owner:string,groupId:string,rootId:string):Promise<number>{
  ownerId(owner)
  const counted=(await db.query(`select count(*)::int as rounds from teloa_group_routing_decisions d
   join teloa_group_messages m on m.id=d.message_id and m.group_id=d.group_id
   where d.owner_id=$1 and d.group_id=$2 and (m.id=$3 or m.root_id=$3) and d.decision->>'kind'='relay-stopped'`,[owner,groupId,rootId])).rows[0]
  const rounds=counted?.rounds
  if(!Number.isSafeInteger(rounds))throw corrupt()
  return rounds as number
 }

 /** 跳数：在话题的有序序列上从触发消息往前数连续 `author_id<>'self'`，遇本人即归零。 */
 async hops(db:PoolClient,owner:string,groupId:string,rootId:string,messageId:string):Promise<number>{
  ownerId(owner)
  const messages=await topicMessages(db,owner,groupId,rootId)
  const index=messages.findIndex(message=>message.id===messageId)
  if(index<0)throw new WorkError('teloa/forbidden','群消息不存在或不属于当前话题。')
  let hops=0
  for(let cursor=index;cursor>=0;cursor-=1){
   const message=messages[cursor]
   if(!message||message.authorId==='self')break
   hops+=1
  }
  return hops
 }

 /** 下发面只回四键投影：候选集与停下消息 id 不出服务端（Global Constraints「不泄候选」）。 */
 async list(owner:string,input:unknown):Promise<{items:GroupRoutingDecisionView[]}>{
  ownerId(owner)
  const request=groupRoutingListInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   if(!(await client.query('select 1 from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])).rowCount)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
   const rows=(await client.query('select message_id,decision from teloa_group_routing_decisions where owner_id=$1 and group_id=$2 and message_id=any($3::uuid[]) order by created_at,message_id',[owner,request.groupId,[...new Set(request.messageIds)]])).rows
   await client.query('commit')
   return {items:rows.map(view)}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}
