import type {PoolClient} from 'pg'
import {WorkError,type GroupReadingTarget} from '@teloa/contract'
/** 阅读水位、分页与搜索使用同一主群/话题归属，游标始终由原消息回查。 */
export async function groupMessageScope(db:Pick<PoolClient,'query'>,owner:string,target:GroupReadingTarget){
 const forbidden=()=>new WorkError('teloa/forbidden','消息位置不属于当前本人群或话题。')
 if(typeof owner!=='string'||!owner.trim()||owner!==owner.trim()||owner.length>128||/[\x00-\x1f\x7f]/.test(owner))throw forbidden()
 if(!(await db.query("select 1 from teloa_groups g join teloa_group_members member on member.group_id=g.id and member.owner_id=g.owner_id and member.member_key='self' and member.role_id is null where g.owner_id=$1 and g.id=$2",[owner,target.groupId])).rowCount)throw forbidden()
 if(target.rootId&&!(await db.query('select 1 from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 and root_id is null',[owner,target.groupId,target.rootId])).rowCount)throw forbidden()
 const tables=(await db.query("select to_regclass('teloa_group_task_sources') tasks,to_regclass('teloa_group_routing_outbox') replies")).rows[0]
 const join=[tables?.tasks?'left join teloa_group_task_sources task_source on task_source.owner_id=m.owner_id and task_source.group_id=m.group_id and task_source.task_id=m.task_id':'',tables?.replies?"left join teloa_group_routing_outbox reply_source on reply_source.owner_id=m.owner_id and reply_source.group_id=m.group_id and reply_source.id=m.reply_execution_id and reply_source.execution_mode='reply' and reply_source.task_id is null and reply_source.run_id is null":''].filter(Boolean).join(' ')
 // 显示归属来自同群固定执行证明；读回正文仍由 presentGroupMessages 完整核验快照摘要及发布身份。
 const replyMain=tables?.replies?" or reply_source.reply_execution->>'state'='ended' and reply_source.reply_execution->>'resultMessageId'=m.id::text and reply_source.reply_execution->>'nativeRequestId'=m.request_id::text and reply_source.reply_execution->'snapshot'->'role'->>'id'=m.author_id and reply_source.reply_execution->'evidence'->>'reason'='completed' and reply_source.reply_execution->'snapshot'->>'contextMode'='main'":''
 const main=`(m.root_id is null${tables?.tasks?" or task_source.source_snapshot->>'schema'='teloa.group-task-source/v2' and task_source.source_snapshot->>'contextMode'='main'":''}${replyMain})`
 const thread=`not coalesce(${main},false)`
 return {join,main,thread,predicate:target.rootId?`(m.id=$3 or m.root_id=$3 and ${thread})`:main,args:[owner,target.groupId,...(target.rootId?[target.rootId]:[])]}
}
