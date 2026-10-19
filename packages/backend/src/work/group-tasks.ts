import {groupTaskTitle} from './task-title.ts'
import {readGroupOwnerRequest} from './group-owner-request.ts'
import {lockConversationTaskParent,assertConversationTaskOpen} from './conversation-work-task-protection.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,groupDefinition,groupTaskCreateInput,isGroupMessage,isGroupTaskSource,normalizeReferences,groupMessageRelationFields,isMessageReference,ungrantedGroupReferences,roleSupportsScope,type GroupMessage,type GroupTaskCreateInput,type GroupTaskSource,type MessageReference,type WorkTask} from '@teloa/contract'
import {groupTaskSourceDigest} from './group-task-source-digest.ts'
import {readStoredTask,type TaskService} from './tasks.ts'
import {lockRoleWorkRole,assertRoleWorkRole} from './twin-execution-consents.ts'
import {readRoleWorkGroupGrant} from './role-delegations.ts'
import {authorizeRoleTaskAssignment} from './role-task-authorization.ts'
import {readTrustedGroupMessageWorkSource} from './group-routing-outbox.ts'
import {assertBusinessScopeRegistered} from './business-scopes.ts'
import {readFixedBusinessTaskReference,type BusinessTaskSource} from './business-tasks.ts'
import {businessTaskSourceDigest} from './business-task-source-digest.ts'

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
 );
 -- 依赖交接：后序任务固定的全部必需前序可信回帖（按阶段与员工的固定顺序）。只增不改；原群来源快照与摘要不回写。
 create table if not exists teloa_group_task_handoffs (
  owner_id text not null,task_id uuid not null,position integer not null check(position>=0),group_id uuid not null,message_id uuid not null,run_id uuid not null,
  primary key(owner_id,task_id,position),unique(owner_id,task_id,message_id),
  foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),
  foreign key(message_id,group_id) references teloa_group_messages(id,group_id)
 );`)
}

/** 已入库回帖的固定引用：必须是合法引用数组，否则按记录损坏处理。 */
function storedReferences(value:unknown):MessageReference[]{
 if(!Array.isArray(value)||!value.every(isMessageReference))throw corrupt()
 return value.map(reference=>({kind:reference.kind,id:reference.id,version:reference.version}))
}

export type GroupTaskHandoff={messageId:string;runId:string;references:MessageReference[]}
/**
 * 后序任务的交接依据（唯一读取契约，上下文与文件读取共用）：按固定顺序返回全部必需前序的可信回帖及其固定引用。
 * 只认创建任务时已逐条核实并登记的回帖；早于本表登记的交接任务按谱系里那一条父回帖回落。回帖身份或 Run 不一致即拒绝。
 */
export async function readGroupTaskHandoffs(db:Pick<PoolClient,'query'>,owner:string,task:{id:string;groupId:string;messageId:string}):Promise<GroupTaskHandoff[]>{
 let rows=(await db.query('select message_id,run_id from teloa_group_task_handoffs where owner_id=$1 and task_id=$2 and group_id=$3 order by position',[owner,task.id,task.groupId])).rows as {message_id:string;run_id:string}[]
 if(!rows.length){
  const source=(await db.query('select source from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,task.id])).rows[0]?.source as {kind?:unknown;messageId?:unknown;runId?:unknown}|undefined
  if(source?.kind!=='group-run-message'||typeof source.messageId!=='string'||typeof source.runId!=='string'||source.messageId===task.messageId)return []
  rows=[{message_id:source.messageId,run_id:source.runId}]
 }
 const messages=new Map((await db.query('select id,run_id,reference_snapshot from teloa_group_messages where owner_id=$1 and group_id=$2 and id=any($3::uuid[]) for share',[owner,task.groupId,rows.map(row=>row.message_id)])).rows.map(row=>[String(row.id),row]))
 return rows.map(row=>{
  const message=messages.get(String(row.message_id))
  if(!message||String(message.run_id)!==String(row.run_id))throw new WorkError('teloa/forbidden','交接成果已不在本群或不再可信。')
  return {messageId:String(row.message_id),runId:String(row.run_id),references:storedReferences(message.reference_snapshot)}
 })
}

/** 触发来源缺省 'manual' 时不写进请求指纹，与 0a9b708 先例一致：已存行（本字段上线前）与显式传 'manual' 的重试仍判为同一请求。 */
function requestSpec(request:GroupTaskCreateInput):string{
 const trigger=request.trigger??'manual'
 // 执行策略与尝试世代只在路由派工出现；没有时指纹与旧请求逐字一致。
 return JSON.stringify({groupId:request.groupId,messageId:request.messageId,expectedGroupVersion:request.expectedGroupVersion,goal:request.goal,assignee:request.assignee??null,...(trigger==='manual'?{}:{trigger}),...(request.executionMode?{executionMode:request.executionMode,routingAttemptVersion:request.routingAttemptVersion}:{}),...(request.handoffMessageId?{handoffMessageId:request.handoffMessageId}:{}),...(request.handoffMessageIds?{handoffMessageIds:request.handoffMessageIds}:{}),...(request.businessTarget?{businessTarget:request.businessTarget}:{})})
}
function readMessage(row:Record<string,unknown>):GroupMessage{
 try{
  const base={id:row.id,groupId:row.group_id,rootId:row.root_id,authorId:row.author_id,text:row.text,references:normalizeReferences(row.reference_snapshot),createdAt:stamp(row.created_at)}
  const value=base.authorId==='self'?{...base,mentions:row.mention_snapshot,...groupMessageRelationFields(row.reply_to_message_id,row.mention_all)}:{...base,taskId:row.task_id,runId:row.run_id}
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
   // Task 创建会写负责人；在读取群前先锁角色，保持 role→group→Task 顺序。
   const role=request.assignee?await lockRoleWorkRole(client,owner,request.assignee.roleId):null
   const groupRow=(await client.query('select * from teloa_groups where id=$1 and owner_id=$2 for share',[request.groupId,owner])).rows[0]
   if(!groupRow)throw new WorkError('teloa/forbidden','群不存在或不属于当前本人。')
   let scope:string
   try{scope=groupDefinition(groupRow.definition).scope}catch{throw new WorkError('teloa/storage-corrupt','群定义记录损坏，不能创建任务。')}
   if(request.businessTarget){
    if(scope!=='general'&&scope!==request.businessTarget.scope)throw new WorkError('teloa/forbidden','业务群的工作不能跨到其他业务。')
    scope=request.businessTarget.scope
    await assertBusinessScopeRegistered(client,owner,scope)
   }
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
   // 依赖交接：全部必需前序回帖逐条按本群可信 Run 消息核实；执行父节点仍只取 handoffMessageId 那一条。
   const handoffIds=request.handoffMessageIds??(request.handoffMessageId?[request.handoffMessageId]:[])
   const handoffs:{messageId:string;runId:string;references:MessageReference[]}[]=[]
   for(const messageId of handoffIds){
    const trusted=await readTrustedGroupMessageWorkSource(client,owner,{groupId:request.groupId,messageId},this.pool)
    if(!trusted)throw new WorkError('teloa/forbidden','交接依据不是本群可信的前序阶段成果。')
    const row=(await client.query('select reference_snapshot from teloa_group_messages where owner_id=$1 and group_id=$2 and id=$3 for share',[owner,request.groupId,messageId])).rows[0]
    handoffs.push({messageId,runId:trusted.runId,references:storedReferences(row?.reference_snapshot)})
   }
   let assignment:Awaited<ReturnType<typeof authorizeRoleTaskAssignment>>|undefined
   if(role&&request.assignee){
    assertRoleWorkRole(role,request.assignee.expectedVersion)
    if(!roleSupportsScope(role.scopes,scope))throw new WorkError('teloa/forbidden','负责人不支持当前群业务范围。')
    const grant=await readRoleWorkGroupGrant(client,owner,role,request.groupId,scope,role.kind==='twin'||(request.trigger??'manual')!=='manual')
    if(ungrantedGroupReferences(message.references,grant.resources).length)throw new WorkError('teloa/forbidden','群消息包含未授予当前负责人的原件或版本。')
    // 交接成果沿同一授权契约：前序贴回的每个固定版本都须已授予当前接手者，不因交接绕过文件授权。
    if(handoffs.some(handoff=>ungrantedGroupReferences(handoff.references,grant.resources).length))throw new WorkError('teloa/forbidden','交接成果包含未授予当前负责人的原件或版本。')
    assignment=await authorizeRoleTaskAssignment(client,this.pool,owner,role,scope,request.groupId)
   }
   // 只从本条持久 v2 Run 回复派生执行父关系；本人消息及旧消息沿独立根路径，不借话题 root 猜谱系。
   // 依赖交接的后序阶段：执行父关系取前序阶段贴回本群的可信 Run 消息（继承父范围、预算与停止控制），原触发消息仍是工作来源。
   const workSource=await readTrustedGroupMessageWorkSource(client,owner,{groupId:request.groupId,messageId:request.handoffMessageId??request.messageId},this.pool)
   if(request.handoffMessageId&&!workSource)throw new WorkError('teloa/forbidden','交接依据不是本群可信的前序阶段成果。')
   if(handoffs.length&&(!role||!request.assignee))throw new WorkError('teloa/forbidden','交接工作必须有明确负责人。')
   const object=request.businessTarget?.object?await readFixedBusinessTaskReference(client,owner,request.businessTarget.object,true):undefined
   const task=await this.tasks.createInTransaction(client,owner,{requestId:request.requestId,fields:{title:groupTaskTitle(message.text),goal:request.goal,scope,groupId:request.groupId},...(request.assignee?{assignee:request.assignee}:{})},workSource??undefined)
   const createdAt=this.identity.now(),base={taskId:task.id,ownerId:owner,groupId:request.groupId,groupVersion:groupRow.version as number,messageId:message.id,rootId,messageCreatedAt:message.createdAt,messageText:message.text,references:message.references.map(reference=>({...reference})),createdAssignee:request.assignee?{roleId:request.assignee.roleId,roleVersion:request.assignee.expectedVersion}:null,trigger:request.trigger??'manual',createdAt}
   let contextMode:'main'|'thread'=message.rootId===null?'main':'thread'
   // 员工接力仍带原话题根，显示位置须继承服务端原来源，不能把非空 rootId 一律当成话题。
   if('taskId' in message){
    const prior=(await client.query('select * from teloa_group_task_sources where owner_id=$1 and task_id=$2 for share',[owner,message.taskId])).rows[0]
    if(prior){const source=readGroupTaskSource(prior);if(source.groupId!==request.groupId||source.rootId!==rootId)throw corrupt();if(source.schema==='teloa.group-task-source/v2')contextMode=source.contextMode}
   }
   // 路由派工与显式业务目标写 v2；旧入口不补新字段，原快照及幂等摘要保持兼容。
   const ownerRequest=request.executionMode==='work'?await readGroupOwnerRequest(client,owner,request.groupId,message.id,this.pool):undefined
   const source:GroupTaskSource=request.executionMode&&request.routingAttemptVersion||request.businessTarget
    ?{schema:'teloa.group-task-source/v2',...base,replyToMessageId:'replyToMessageId' in message?message.replyToMessageId??null:null,contextMode,routingAttemptVersion:request.routingAttemptVersion??1,executionMode:request.executionMode??'work',...(request.businessTarget?{businessTarget:request.businessTarget}:{}),...(ownerRequest?{ownerRequest}:{})}
    :{schema:'teloa.group-task-source/v1',...base}
   await client.query(`insert into teloa_group_task_sources(task_id,owner_id,request_id,request_spec,group_id,group_version,message_id,root_id,source_snapshot,snapshot_digest,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[task.id,owner,request.requestId,spec,request.groupId,source.groupVersion,message.id,rootId,JSON.stringify(source),groupTaskSourceDigest(source),createdAt])
   if(object){
    const reference=object.reference,businessSource:BusinessTaskSource={schema:'teloa.business-task-source/v1',taskId:task.id,ownerId:owner,sourceId:object.sourceId,reference,createdAssignee:base.createdAssignee,createdAt}
    const businessSpec={reference,goal:task.goal,assignee:request.assignee??null,title:task.title}
    await client.query(`insert into teloa_business_task_sources(task_id,owner_id,request_id,request_spec,scope_id,object_type,object_id,object_version,snapshot_hash,source_id,source_snapshot,snapshot_digest,created_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[task.id,owner,request.requestId,JSON.stringify(businessSpec),reference.scope,reference.type,reference.id,reference.version,reference.snapshotHash,object.sourceId,JSON.stringify(businessSource),businessTaskSourceDigest(businessSource),createdAt])
   }
   for(const [position,handoff] of handoffs.entries())await client.query('insert into teloa_group_task_handoffs(owner_id,task_id,position,group_id,message_id,run_id) values($1,$2,$3,$4,$5,$6)',[owner,task.id,position,request.groupId,handoff.messageId,handoff.runId])
   assignment?.assertCurrent();await client.query('commit');return {task,source}
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
