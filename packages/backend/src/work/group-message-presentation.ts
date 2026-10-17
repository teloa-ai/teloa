import {createHash} from 'node:crypto'
import type {PoolClient} from 'pg'
import {WorkError,isGroupMessage,readGroupRunSource,normalizeReferences,groupMessageRelationFields,type GroupMessage} from '@teloa/contract'
import {readGroupTaskSource} from './group-tasks.ts'
import {groupMessageBodyFields} from './group-message-body.ts'

const corrupt=()=>new WorkError('teloa/storage-corrupt','群消息的显示来源与原运行不一致。')

export function readStoredGroupMessage(row:Record<string,unknown>):GroupMessage{
 try{
  if(!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw Error()
  const base={id:row.id,groupId:row.group_id,rootId:row.root_id,authorId:row.author_id,text:row.text,references:normalizeReferences(row.reference_snapshot),createdAt:row.created_at.toISOString()}
  const value=base.authorId==='self'?{...base,mentions:row.mention_snapshot,...groupMessageRelationFields(row.reply_to_message_id,row.mention_all)}:{...base,taskId:row.task_id,runId:row.run_id,...groupMessageBodyFields(row),...(row.mention_self===true?{mentionSelf:true as const}:{})}
  if(!isGroupMessage(value))throw Error()
  return value
 }catch{throw new WorkError('teloa/storage-corrupt','群消息记录损坏，已停止读取。')}
}

/** 只投影已持久化的发起面及作者快照；不修改 rootId、执行谱系或任何授权。旧消息缺少快照时保留旧契约。 */
export async function presentGroupMessages(db:Pick<PoolClient,'query'>,owner:string,messages:GroupMessage[]):Promise<GroupMessage[]>{
 const employees=messages.filter(message=>'runId' in message)
 if(!employees.length)return messages
 const schema=(await db.query("select to_regclass('teloa_group_task_sources') tasks,to_regclass('teloa_group_run_sources') runs")).rows[0]
 const tasks=schema?.tasks?(await db.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=any($2::uuid[])',[owner,[...new Set(employees.map(message=>message.taskId))]])).rows:[]
 const sources=schema?.runs?(await db.query('select * from teloa_group_run_sources where owner_id=$1 and message_id=any($2::uuid[])',[owner,employees.map(message=>message.id)])).rows:[]
 const byTask=new Map(tasks.map(row=>[String(row.task_id),readGroupTaskSource(row)])),byMessage=new Map(sources.map(row=>[String(row.message_id),row]))
 return messages.map(message=>{
  if(!('runId' in message))return message
  let value={...message}
  const task=byTask.get(message.taskId)
  if(task){
   if(task.groupId!==message.groupId||task.rootId!==message.rootId)throw corrupt()
   if(task.schema==='teloa.group-task-source/v2')value={...value,contextMode:task.contextMode,replyToMessageId:task.messageId}
  }
  const row=byMessage.get(message.id)
  if(row){
   const source=readGroupRunSource(row.source)
   if(row.group_id!==message.groupId||source.ownerId!==owner||source.taskId!==message.taskId||source.runId!==message.runId||source.roleId!==message.authorId||row.source_hash!==createHash('sha256').update(JSON.stringify(source)).digest('hex'))throw corrupt()
   value={...value,author:{name:source.roleName,kind:source.roleKind,version:source.roleVersion}}
  }
  if(!isGroupMessage(value))throw corrupt()
  return value
 })
}
