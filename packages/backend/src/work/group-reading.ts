import type {Pool,PoolClient} from 'pg'
import {WorkError,groupMarkReadInput,groupReadingInput,readGroupReadingState,type GroupReadingTarget,type GroupReadingState} from '@teloa/contract'
import {groupMessageScope} from './group-message-scope.ts'

const forbidden=()=>new WorkError('teloa/forbidden','阅读位置不属于当前本人群或话题。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','群阅读位置存储不一致。')
const ownerValid=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw forbidden()}
const channel=(target:GroupReadingTarget)=>target.rootId?'topic:'+target.rootId:'main'

export async function initializeGroupReading(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_group_read_cursors (
  owner_id text not null,group_id uuid not null,channel_key text not null,root_id uuid,
  message_id uuid not null,message_created_at timestamptz not null,updated_at timestamptz not null,
  primary key(owner_id,group_id,channel_key),
  foreign key(group_id,owner_id) references teloa_groups(id,owner_id) on delete cascade,
  foreign key(root_id,group_id) references teloa_group_messages(id,group_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id),
  check((root_id is null and channel_key='main') or (root_id is not null and channel_key='topic:'||root_id::text))
 )`)
}

/** 仅记录认证本人实际看见的水位；不发送消息、改变路由或推断员工身份。 */
export class GroupReadingService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 private async scope(db:PoolClient,owner:string,target:GroupReadingTarget){
  return groupMessageScope(db,owner,target)
 }
 private async state(db:PoolClient,owner:string,target:GroupReadingTarget,scope:Awaited<ReturnType<GroupReadingService['scope']>>):Promise<GroupReadingState>{
  const saved=(await db.query('select c.message_id,c.message_created_at,m.created_at from teloa_group_read_cursors c join teloa_group_messages m on m.id=c.message_id and m.group_id=c.group_id and m.owner_id=c.owner_id where c.owner_id=$1 and c.group_id=$2 and c.channel_key=$3',[owner,target.groupId,channel(target)])).rows[0]
  if(saved&&saved.message_created_at.toISOString()!==saved.created_at.toISOString())throw corrupt()
  const latest=(await db.query(`select m.id,m.created_at from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and ${scope.predicate} order by m.created_at desc,m.id desc limit 1`,scope.args)).rows[0]
  const values=[...scope.args,...(saved?[saved.message_created_at,saved.message_id]:[])]
  const after=saved?` and (m.created_at,m.id)>($${scope.args.length+1}::timestamptz,$${scope.args.length+2}::uuid)`:''
  const count=(await db.query(`select count(*)::text n from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and ${scope.predicate} and m.author_id<>'self'${after}`,values)).rows[0].n
  return readGroupReadingState({schema:'teloa.group-reading/v1',groupId:target.groupId,rootId:target.rootId??null,cursor:saved?{messageId:saved.message_id,createdAt:saved.created_at.toISOString()}:null,latest:latest?{messageId:latest.id,createdAt:latest.created_at.toISOString()}:null,unreadCount:Number(count)})
 }
 async read(owner:string,input:unknown):Promise<GroupReadingState>{
  ownerValid(owner);const target=groupReadingInput(input),db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const scope=await this.scope(db,owner,target),result=await this.state(db,owner,target,scope);await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async mark(owner:string,input:unknown):Promise<GroupReadingState>{
  ownerValid(owner);const target=groupMarkReadInput(input),db=await this.pool.connect()
  try{
   await db.query('begin');const scope=await this.scope(db,owner,target)
   const message=(await db.query(`select m.id,m.created_at from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2 and ${scope.predicate} and m.id=$${scope.args.length+1}`, [...scope.args,target.messageId])).rows[0]
   if(!message)throw forbidden()
   await db.query(`insert into teloa_group_read_cursors(owner_id,group_id,channel_key,root_id,message_id,message_created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7)
    on conflict(owner_id,group_id,channel_key) do update set message_id=excluded.message_id,message_created_at=excluded.message_created_at,updated_at=excluded.updated_at
    where (teloa_group_read_cursors.message_created_at,teloa_group_read_cursors.message_id)<(excluded.message_created_at,excluded.message_id)`,[owner,target.groupId,channel(target),target.rootId??null,message.id,message.created_at,this.identity.now()])
   const result=await this.state(db,owner,target,scope);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
