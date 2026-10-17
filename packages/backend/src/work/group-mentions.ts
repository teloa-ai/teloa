import type {Pool} from 'pg'
import {WorkError,groupListInput,groupMentionsInput,readGroupAttention,readGroupMentionsPage} from '@teloa/contract'
import {groupMessageScope} from './group-message-scope.ts'
import {groupMessageListColumns} from './group-message-body.ts'
import {presentGroupMessages,readStoredGroupMessage} from './group-message-presentation.ts'

const forbidden=()=>new WorkError('teloa/forbidden','提及不属于当前本人群或话题。')
/** 本人提及只认原运行持久声明；主群和话题分别沿已读水位，绝不解析姓名。 */
export class GroupMentionService{
 private readonly pool:Pool
 constructor(pool:Pool){this.pool=pool}
 private cursors(scope:Awaited<ReturnType<typeof groupMessageScope>>){
  return `left join teloa_group_read_cursors c on c.owner_id=m.owner_id and c.group_id=m.group_id and c.channel_key=case when ${scope.main} then 'main' else 'topic:'||m.root_id::text end`
 }
 private unread=`(c.message_id is null or (m.created_at,m.id)>(c.message_created_at,c.message_id))`
 async summary(owner:string,input:unknown){
  groupListInput(input)
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw forbidden()
   const groups=(await db.query("select g.id from teloa_groups g join teloa_group_members member on member.group_id=g.id and member.owner_id=g.owner_id and member.member_key='self' and member.role_id is null where g.owner_id=$1 order by g.id",[owner])).rows
   if(!groups.length){await db.query('commit');return readGroupAttention({schema:'teloa.group-attention/v1',items:[]})}
   const scope=await groupMessageScope(db,owner,{groupId:String(groups[0]!.id)})
   const counts=(await db.query(`select m.group_id,count(*)::int unread,count(*) filter(where m.mention_self)::int mentions from teloa_group_messages m ${scope.join} ${this.cursors(scope)} where m.owner_id=$1 and m.group_id=any($2::uuid[]) and m.author_id<>'self' and ${this.unread} group by m.group_id`,[owner,groups.map(row=>row.id)])).rows
   const result=readGroupAttention({schema:'teloa.group-attention/v1',items:groups.map(row=>{const count=counts.find(item=>item.group_id===row.id);return {groupId:row.id,unreadCount:count?.unread??0,mentionCount:count?.mentions??0}})})
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async list(owner:string,input:unknown){
  const request=groupMentionsInput(input),db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const scope=await groupMessageScope(db,owner,request),args:unknown[]=[...scope.args]
   let condition=(request.rootId?` and ${scope.predicate}`:'')+(request.unreadOnly?` and ${this.unread}`:'')
   if(request.before){
    const anchor=(await db.query(`select m.id,m.created_at from teloa_group_messages m ${scope.join} where m.owner_id=$1 and m.group_id=$2${request.rootId?` and ${scope.predicate}`:''} and m.mention_self and m.id=$${args.length+1}`,[...args,request.before])).rows[0]
    if(!anchor)throw forbidden()
    args.push(anchor.created_at,anchor.id);condition+=` and (m.created_at,m.id)<($${args.length-1}::timestamptz,$${args.length}::uuid)`
   }
   args.push(request.limit+1)
   const columns=groupMessageListColumns.split(',').map(name=>'m.'+name).join(',')
   const rows=(await db.query(`select ${columns},${scope.main} main_channel,${this.unread} unread from teloa_group_messages m ${scope.join} ${this.cursors(scope)} where m.owner_id=$1 and m.group_id=$2 and m.author_id<>'self' and m.mention_self${condition} order by m.created_at desc,m.id desc limit $${args.length}`,args)).rows
   const selected=rows.slice(0,request.limit),messages=await presentGroupMessages(db,owner,selected.map(readStoredGroupMessage))
   const result=readGroupMentionsPage({schema:'teloa.group-mentions/v1',groupId:request.groupId,rootId:request.rootId??null,unreadOnly:request.unreadOnly,items:messages.map((message,index)=>({message,rootId:selected[index]!.main_channel?null:message.rootId,excerpt:message.text.slice(0,400),unread:selected[index]!.unread})),next:rows.length>request.limit?messages.at(-1)!.id:null})
   await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
