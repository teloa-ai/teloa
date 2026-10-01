import type {Pool,PoolClient} from 'pg'
import {WorkError,groupReactionActorsMax,groupReactionListInput,groupReactionToggleInput,isGroupReactionSummary,type GroupReactionActorKind,type GroupReactionEmoji,type GroupReactionSummary,type GroupReactionToggleResult} from '@teloa/contract'

function ownerId(value:string):void{
 if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')
}

const corrupt=()=>new WorkError('teloa/storage-corrupt','群表情记录损坏，已停止读取。')

/**
 * 表情落在自己的表里，因此后端三份各自独立的 `readMessage`（`collaboration.ts` / `group-tasks.ts` /
 * `group-run-messages.ts`）一行都不用动：`GroupMessage` 没有新键，键数守卫与既有断言全部原值。
 *
 * 取消不删行：`withdrawn_at` 置位（先例 `collaboration.ts:374` 的资料撤回），聚合只数 `withdrawn_at is null` 的行，
 * 因此「某人取消了某个表情」这件事在库里留痕，而面上直接归零消失。
 */
export async function initializeGroupReactions(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_group_reactions(
  owner_id text not null,
  group_id uuid not null,
  message_id uuid not null,
  actor_kind text not null check(actor_kind in ('self','role')),
  actor_id text not null,
  emoji text not null,
  run_id uuid,
  request_id uuid not null,
  withdrawn_at timestamptz,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  primary key(owner_id,message_id,actor_kind,actor_id,emoji),
  unique(owner_id,request_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id),
  check((actor_kind='self' and actor_id='self' and run_id is null) or (actor_kind='role' and actor_id<>'self'))
 );
 create index if not exists teloa_group_reactions_message_v1 on teloa_group_reactions(owner_id,message_id);
`)}

/** 聚合只在这一处：`count` 是真实计数，`actors` 至多 64 位（超出只截断名单，不改 `count`）。 */
async function summarize(db:PoolClient,owner:string,groupId:string,messageIds:readonly string[]):Promise<GroupReactionSummary[]>{
 const rows=(await db.query('select message_id,actor_kind,actor_id,emoji from teloa_group_reactions where owner_id=$1 and group_id=$2 and message_id=any($3::uuid[]) and withdrawn_at is null order by message_id,emoji,created_at,actor_id',[owner,groupId,[...new Set(messageIds)]])).rows
 const grouped=new Map<string,GroupReactionSummary>()
 for(const row of rows){
  const messageId=String(row.message_id),emoji=row.emoji as GroupReactionEmoji,key=messageId+'|'+String(row.emoji)
  const summary=grouped.get(key)??{messageId,emoji,count:0,mine:false,actors:[]}
  summary.count+=1
  if(row.actor_kind==='self')summary.mine=true
  if(summary.actors.length<groupReactionActorsMax)summary.actors.push({actorKind:row.actor_kind as GroupReactionActorKind,actorId:String(row.actor_id)})
  grouped.set(key,summary)
 }
 const items=[...grouped.values()]
 for(const item of items)if(!isGroupReactionSummary(item))throw corrupt()
 return items
}

async function assertGroupReadable(db:PoolClient,owner:string,groupId:string):Promise<{archived:boolean}>{
 const found=(await db.query('select archived from teloa_groups where id=$1 and owner_id=$2 for share',[groupId,owner])).rows[0]
 if(!found)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
 if(typeof found.archived!=='boolean')throw new WorkError('teloa/storage-corrupt','群归档状态损坏。')
 return {archived:found.archived}
}

export class GroupReactionService{
 readonly pool:Pool
 readonly identity:{now:()=>string}

 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}

 /** messageIds ≤200 由契约入口守住；只数 `withdrawn_at is null` 的行。 */
 async list(owner:string,input:unknown):Promise<{items:GroupReactionSummary[]}>{
  ownerId(owner)
  const request=groupReactionListInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   await assertGroupReadable(client,owner,request.groupId)
   const items=await summarize(client,owner,request.groupId,request.messageIds)
   await client.query('commit')
   return {items}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 /**
  * 幂等切换。回执的唯一真源就是表本身（`unique(owner_id,request_id)`）：同一 requestId 重放先命中这一行，
  * 原样回当前聚合、不再翻面；换了内容的同 requestId 判冲突，与 `collaboration.ts:246` 的发消息口同口径。
  */
 async toggle(owner:string,input:unknown):Promise<GroupReactionToggleResult>{
  ownerId(owner)
  const request=groupReactionToggleInput(input),client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/group-reaction',owner,request.requestId])])
   const prior=(await client.query('select group_id,message_id,actor_kind,emoji from teloa_group_reactions where owner_id=$1 and request_id=$2 for update',[owner,request.requestId])).rows[0]
   if(prior){
    if(prior.group_id!==request.groupId||prior.message_id!==request.messageId||prior.actor_kind!=='self'||prior.emoji!==request.emoji)throw new WorkError('teloa/conflict','同一表情请求不能更换内容。')
    const items=await summarize(client,owner,request.groupId,[request.messageId])
    await client.query('commit')
    return {messageId:request.messageId,items}
   }
   const group=await assertGroupReadable(client,owner,request.groupId)
   if(group.archived)throw new WorkError('teloa/conflict','已归档群不能加表情。')
   if(!(await client.query('select 1 from teloa_group_messages where id=$1 and group_id=$2 and owner_id=$3 for share',[request.messageId,request.groupId,owner])).rowCount)throw new WorkError('teloa/forbidden','群消息不存在或不属于当前群。')
   const now=this.identity.now()
   await client.query(`insert into teloa_group_reactions(owner_id,group_id,message_id,actor_kind,actor_id,emoji,run_id,request_id,withdrawn_at,created_at,updated_at)
    values($1,$2,$3,'self','self',$4,null,$5,null,$6,$6)
    on conflict(owner_id,message_id,actor_kind,actor_id,emoji) do update
    set withdrawn_at=case when teloa_group_reactions.withdrawn_at is null then $6::timestamptz else null end,request_id=$5,updated_at=$6`,
    [owner,request.groupId,request.messageId,request.emoji,request.requestId,now])
   const items=await summarize(client,owner,request.groupId,[request.messageId])
   await client.query('commit')
   return {messageId:request.messageId,items}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 /**
  * 宿主内部：员工身份加表情。没有浏览器 RPC。判据由调用方过完，这里只写；重放落同一行，已撤回的不复活。
  * 冲突目标写死在主键上：requestId 撞 `unique(owner_id,request_id)` 时照常抛 23505，不被这条语句静默吞掉。
  */
 async applyRole(db:PoolClient,owner:string,params:{groupId:string;messageId:string;roleId:string;emoji:GroupReactionEmoji;runId:string|null;requestId:string}):Promise<void>{
  ownerId(owner)
  const now=this.identity.now()
  await db.query(`insert into teloa_group_reactions(owner_id,group_id,message_id,actor_kind,actor_id,emoji,run_id,request_id,withdrawn_at,created_at,updated_at)
   values($1,$2,$3,'role',$4,$5,$6,$7,null,$8,$8) on conflict(owner_id,message_id,actor_kind,actor_id,emoji) do nothing`,
   [owner,params.groupId,params.messageId,params.roleId,params.emoji,params.runId,params.requestId,now])
 }

 /** 工具侧的本话题判据：`messageId` 是否属于 `rootId` 那个话题（含根）。只读。 */
 async inTopic(db:PoolClient,owner:string,groupId:string,rootId:string,messageId:string):Promise<boolean>{
  ownerId(owner)
  return !!(await db.query('select 1 from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 and (id=$4 or root_id=$4)',[owner,groupId,messageId,rootId])).rowCount
 }
}
