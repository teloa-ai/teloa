import {lockConversationTaskParent,assertConversationTaskOpen} from './conversation-work-task-protection.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupDefinition,groupTaskCreateInput,isGroupMessage,isGroupTaskSource,normalizeReferences,type GroupMessage,type GroupTaskCreateInput,type GroupTaskSource,type WorkTask} from '@teloa/contract'
import {groupTaskSourceDigest} from './group-task-source-digest.ts'
import {readStoredTask,type TaskService} from './tasks.ts'

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const ownerId=(value:string):void=>{if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const stamp=(value:unknown):string=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw Error();return value.toISOString()}
const corrupt=()=>new WorkError('teloa/storage-corrupt','群消息任务来源记录损坏，已停止读取。')

export type GroupTaskRecord={task:WorkTask;source:GroupTaskSource}

export async function initializeGroupTasks(pool:Pool):Promise<void>{
 await pool.query(`create unique index if not exists teloa_tasks_identity_owner on teloa_tasks(id,owner_id);
 create table if not exists teloa_group_task_sources (
  task_id uuid primary key,owner_id text not null,request_id uuid not null,
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  group_id uuid not null,group_version integer not null check(group_version>0),
  message_id uuid not null,root_id uuid not null,
  source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),snapshot_digest text not null check(snapshot_digest~'^[a-f0-9]{64}$'),created_at timestamptz not null,
  unique(owner_id,request_id),unique(task_id,owner_id),
  foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),
  foreign key(group_id,owner_id) references teloa_groups(id,owner_id) on delete cascade,
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id),
  foreign key(root_id,group_id) references teloa_group_messages(id,group_id)
 );`)
}

/** 触发来源缺省 'manual' 时不写进请求指纹，与 0a9b708 先例一致：已存行（本字段上线前）与显式传 'manual' 的重试仍判为同一请求。 */
function requestSpec(request:GroupTaskCreateInput):string{
 const trigger=request.trigger??'manual'
 return JSON.stringify({groupId:request.groupId,messageId:request.messageId,expectedGroupVersion:request.expectedGroupVersion,goal:request.goal,assignee:request.assignee??null,...(trigger==='manual'?{}:{trigger})})
}
function title(text:string):string{return ('群任务：'+text.replace(/\s+/g,' ').trim()).slice(0,120)}
function readMessage(row:Record<string,unknown>):GroupMessage{
 try{
  const base={id:row.id,groupId:row.group_id,rootId:row.root_id,authorId:row.author_id,text:row.text,references:normalizeReferences(row.reference_snapshot),createdAt:stamp(row.created_at)}
  const value=base.authorId==='self'?{...base,mentions:row.mention_snapshot}:{...base,taskId:row.task_id,runId:row.run_id}
  if(!isGroupMessage(value))throw Error()
  return value
 }catch{throw new WorkError('teloa/storage-corrupt','群消息记录损坏，不能创建任务。')}
}

export function readGroupTaskSource(row:Record<string,unknown>):GroupTaskSource{
 try{
  const raw=row.source_snapshot
  // 老行（本字段上线前只有 12 键）没有 trigger；按 'manual' 补齐后再判定与摘要比对。
  // 老行的引用还是旧二元组，一并按群资料归一化：`references` 只在本来就有这个键时才覆盖，
  // 既不改变键序也不给损坏行凭空补一个 undefined 键。
  // 摘要函数本就不覆盖 trigger 字段，group-resource 引用也仍投影二元组，两处补齐都不改变摘要值，因此老行仍可通过完整性校验。
  const source=raw&&typeof raw==='object'&&!Array.isArray(raw)?{...raw,...('trigger' in raw?{}:{trigger:'manual'}),...('references' in raw?{references:normalizeReferences((raw as Record<string,unknown>).references)}:{})}:raw
  if(!isGroupTaskSource(source)||!uuid(row.task_id)||!uuid(row.request_id)||row.task_id!==source.taskId||row.owner_id!==source.ownerId||row.group_id!==source.groupId||row.group_version!==source.groupVersion||row.message_id!==source.messageId||row.root_id!==source.rootId||row.snapshot_digest!==groupTaskSourceDigest(source)||!(row.created_at instanceof Date)||row.created_at.toISOString()!==source.createdAt)throw Error()
  return source
 }catch{throw corrupt()}
}

export class GroupTaskService{
 readonly pool:Pool
 readonly identity:{now:()=>string}
 readonly tasks:Pick<TaskService,'createInTransaction'>
 constructor(pool:Pool,identity:{now:()=>string},tasks:Pick<TaskService,'createInTransaction'>){this.pool=pool;this.identity=identity;this.tasks=tasks}

 async create(owner:string,input:unknown):Promise<GroupTaskRecord>{
  ownerId(owner)
  const request=groupTaskCreateInput(input),spec=requestSpec(request),client=await this.pool.connect()
  try{
   await client.query('begin')
   const parent=await lockConversationTaskParent(client,owner,request.requestId)
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',owner,request.requestId])])
   const prior=(await client.query('select * ,request_spec=$3::jsonb as same_request from teloa_group_task_sources where owner_id=$1 and request_id=$2 for update',[owner,request.requestId,spec])).rows[0]
   if(prior){
    if(!prior.same_request)throw new WorkError('teloa/conflict','同一群消息任务请求不能更换内容。')
    const source=readGroupTaskSource(prior),taskRow=(await client.query('select * from teloa_tasks where id=$1 and owner_id=$2',[source.taskId,owner])).rows[0]
    if(!taskRow)throw corrupt()
    await client.query('commit');return {task:readStoredTask(taskRow),source}
   }
   if((await client.query('select 1 from teloa_tasks where owner_id=$1 and request_id=$2',[owner,request.requestId])).rows[0])throw new WorkError('teloa/conflict','该请求已被其他任务使用。')
   assertConversationTaskOpen(parent)
   const groupRow=(await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])).rows[0]
   if(!groupRow)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
   let scope:string
   try{scope=groupDefinition(groupRow.definition).scope}catch{throw new WorkError('teloa/storage-corrupt','群定义记录损坏，不能创建任务。')}
   if(!Number.isSafeInteger(groupRow.version)||(groupRow.version as number)<1||typeof groupRow.archived!=='boolean')throw new WorkError('teloa/storage-corrupt','群版本或归档状态损坏。')
   if(groupRow.version!==request.expectedGroupVersion)throw new WorkError('teloa/version-conflict','群设置已变化，请刷新后再创建任务。')
   if(groupRow.archived)throw new WorkError('teloa/conflict','已归档群不能创建新任务。')
   const messageRow=(await client.query('select * from teloa_group_messages where id=$1 and group_id=$2 and owner_id=$3 for share',[request.messageId,request.groupId,owner])).rows[0]
   if(!messageRow)throw new WorkError('teloa/forbidden','群消息不存在或不属于当前群。')
   const message=readMessage(messageRow),rootId=message.rootId??message.id
   if(message.rootId!==null){
    const root=(await client.query('select id,root_id from teloa_group_messages where id=$1 and group_id=$2 and owner_id=$3 for share',[rootId,request.groupId,owner])).rows[0]
    if(!root||root.root_id!==null)throw new WorkError('teloa/storage-corrupt','群话题根记录损坏，不能创建任务。')
   }
   if(request.assignee){
    const member=(await client.query('select 1 from teloa_group_members where group_id=$1 and owner_id=$2 and role_id=$3 for share',[request.groupId,owner,request.assignee.roleId])).rows[0]
    if(!member)throw new WorkError('teloa/forbidden','负责人不是当前群的员工成员。')
   }
   const task=await this.tasks.createInTransaction(client,owner,{requestId:request.requestId,fields:{title:title(message.text),goal:request.goal,scope},...(request.assignee?{assignee:request.assignee}:{})})
   const createdAt=this.identity.now(),source:GroupTaskSource={schema:'teloa.group-task-source/v1',taskId:task.id,ownerId:owner,groupId:request.groupId,groupVersion:groupRow.version as number,messageId:message.id,rootId,messageCreatedAt:message.createdAt,messageText:message.text,references:message.references.map(reference=>({...reference})),createdAssignee:request.assignee?{roleId:request.assignee.roleId,roleVersion:request.assignee.expectedVersion}:null,trigger:request.trigger??'manual',createdAt}
   await client.query(`insert into teloa_group_task_sources(task_id,owner_id,request_id,request_spec,group_id,group_version,message_id,root_id,source_snapshot,snapshot_digest,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[task.id,owner,request.requestId,spec,request.groupId,source.groupVersion,message.id,rootId,JSON.stringify(source),groupTaskSourceDigest(source),createdAt])
   await client.query('commit');return {task,source}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }

 async source(owner:string,input:unknown):Promise<GroupTaskSource|null>{
  ownerId(owner)
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length!==1||!uuid((input as Record<string,unknown>).taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
  const taskId=(input as {taskId:string}).taskId
  const row=(await this.pool.query('select * from teloa_group_task_sources where task_id=$1 and owner_id=$2',[taskId,owner])).rows[0]
  return row?readGroupTaskSource(row):null
 }
}
