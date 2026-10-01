import {conversationTaskRequest,type ConversationTaskIdentity} from './conversation-task-request.ts'
import {initializeConversationWorkRequests,lockConversationTaskParent,assertConversationTaskOpen} from './conversation-work-task-protection.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,roleSupportsScope,taskInput,taskDefinition,roleDefinition,workTaskStates,type WorkTask} from '@teloa/contract'
import {assertBusinessScopeRegistered} from './business-scopes.ts'
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export async function initializeTasks(pool:Pool):Promise<void>{
 await initializeConversationWorkRequests(pool)
 await pool.query(`create unique index if not exists teloa_roles_identity_owner on teloa_roles(id,owner_id);
 create table if not exists teloa_tasks (
  id uuid primary key,owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  definition jsonb not null check(jsonb_typeof(definition)='object'),version integer not null check(version>0),
  state text not null check(state in ('ready','running','paused','waiting','blocked','completed','cancelled')),
  assignee_role_id uuid,assignee_role_version integer check(assignee_role_version>0),
  created_at timestamptz not null,updated_at timestamptz not null,unique(owner_id,request_id),
  foreign key(assignee_role_id,owner_id) references teloa_roles(id,owner_id),
  check((assignee_role_id is null)=(assignee_role_version is null))
 );
 create table if not exists teloa_task_edits(task_id uuid not null references teloa_tasks(id),base_version integer not null check(base_version>0),request_spec jsonb not null,result jsonb not null,primary key(task_id,base_version))`)
}
/**
 * 请求指纹：关联协作群与使用技能取默认值时不写进 request_spec。
 * 已存行（本字段上线前只有三键）与同一笔重试因此仍然判为同一请求，
 * 计划领取那侧只造三键 fields 也不会被判成「换了请求」。定义列仍写完整定义。
 */
function requestFields({groupId,skills,...base}:ReturnType<typeof taskDefinition>){
 return {...base,...(groupId===null?{}:{groupId}),...(skills.length?{skills}:{})}
}
function ownerIdentity(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function readCreate(owner:string,input:unknown){
  ownerIdentity(owner);const row=taskInput(input,['requestId','fields','assignee']),fields=taskDefinition(row.fields)
  if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','需要有效的任务请求 ID。')
  const assignee=row.assignee===undefined?null:taskInput(row.assignee,['roleId','expectedVersion'])
  if(assignee&&(!uuid(assignee.roleId)||!Number.isSafeInteger(assignee.expectedVersion)||(assignee.expectedVersion as number)<1))throw new WorkError('teloa/invalid-input','负责人身份或版本不合法。')
  return {requestId:row.requestId.toLowerCase(),fields,assignee,spec:JSON.stringify({fields:requestFields(fields),assignee})}
}
export function readStoredTask(row:Record<string,unknown>):WorkTask{
 try{
  const definition=taskDefinition(row.definition)
  if(!uuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!Number.isSafeInteger(row.version)||(row.version as number)<1||!workTaskStates.some(state=>state===row.state))throw Error()
  if(row.assignee_role_id===null?row.assignee_role_version!==null:!uuid(row.assignee_role_id)||!Number.isSafeInteger(row.assignee_role_version)||(row.assignee_role_version as number)<1)throw Error()
  const stamp=(v:unknown)=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw Error();return v.toISOString()}
  return {...definition,id:row.id,ownerId:row.owner_id,version:row.version as number,state:row.state as WorkTask['state'],assigneeRoleId:row.assignee_role_id as string|null,assigneeRoleVersion:row.assignee_role_version as number|null,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 }catch{throw new WorkError('teloa/storage-corrupt','任务记录损坏，已停止读取，请核对原记录。')}
}
export class TaskService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 async list(owner:string,input:unknown):Promise<WorkTask[]>{ownerIdentity(owner);taskInput(input,[]);return (await this.pool.query('select * from teloa_tasks where owner_id=$1 order by created_at,id',[owner])).rows.map(readStoredTask)}
 /** 原请求回执核对：不创建、不重新交办，也不暴露 request_spec。 */
 async request(owner:string,input:unknown):Promise<WorkTask|null>{
  ownerIdentity(owner);const row=taskInput(input,['requestId']);if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','任务请求身份不正确。')
  const requestId=row.requestId.toLowerCase(),db=await this.pool.connect()
  try{await db.query('begin');await lockConversationTaskParent(db,owner,requestId);const saved=(await db.query('select * from teloa_tasks where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0];await db.query('commit');return saved?readStoredTask(saved):null}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 固定父请求的内部回执口；公开 request 不能借 child ID 读取它。 */
 async requestForConversation(owner:string,identity:unknown):Promise<WorkTask|null>{
  const db=await this.pool.connect()
  try{await db.query('begin');const fixed=await conversationTaskRequest(db,owner,identity);if(fixed.business)throw new WorkError('teloa/conflict','对象交办必须同时核对固定业务来源。');const saved=await this.requestForConversationInTransaction(db,owner,fixed.identity);await db.query('commit');return saved}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 对象交办外层须在同一事务继续核对 BusinessTask 来源。 */
 async requestForConversationInTransaction(db:PoolClient,owner:string,identity:unknown):Promise<WorkTask|null>{
  const fixed=await conversationTaskRequest(db,owner,identity),request=readCreate(owner,fixed.task)
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',owner,request.requestId])])
  const saved=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_tasks where owner_id=$1 and request_id=$2',[owner,request.requestId,request.spec])).rows[0]
  if(!saved)return null
  if(!saved.same_request)throw new WorkError('teloa/conflict','原任务与固定交办依据不一致。')
  return readStoredTask(saved)
 }
 async createForConversation(owner:string,identity:unknown):Promise<WorkTask>{
  const db=await this.pool.connect()
  try{await db.query('begin');const fixed=await conversationTaskRequest(db,owner,identity);if(fixed.business)throw new WorkError('teloa/conflict','对象交办必须通过固定业务来源创建。');const task=await this.createForConversationInTransaction(db,owner,fixed.identity);await db.query('commit');return task}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 仅供对象交办共享事务；所有 fields/assignee 均从已锁定父请求推导。 */
 async createForConversationInTransaction(db:PoolClient,owner:string,identity:unknown):Promise<WorkTask>{
  const fixed=await conversationTaskRequest(db,owner,identity)
  return this.createPrepared(db,owner,readCreate(owner,fixed.task),fixed.identity)
 }
 async edit(owner:string,input:unknown):Promise<WorkTask>{
  ownerIdentity(owner);const row=taskInput(input,['taskId','expectedVersion','fields']),fields=taskInput(row.fields,['title','goal'])
  if(!uuid(row.taskId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1)throw new WorkError('teloa/invalid-input','任务身份或目标版本不正确。')
  const client=await this.pool.connect()
  try{await client.query('begin')
   const rows=await client.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,row.taskId])
   if(!rows.rows[0])throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(rows.rows[0]),definition=taskDefinition({...fields,scope:task.scope,groupId:task.groupId,skills:task.skills})
   const stored=JSON.stringify(definition),spec=JSON.stringify(requestFields(definition))
   const receipts=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_task_edits where task_id=$1 and base_version=$2',[task.id,row.expectedVersion,spec])
   if(receipts.rows[0]){
    const receipt=receipts.rows[0];if(!receipt.same_request)throw new WorkError('teloa/version-conflict','原版本已保存其他目标，请核对新版本。')
    let saved:WorkTask
    try{const raw=receipt.result;saved=readStoredTask({...raw,created_at:new Date(raw.created_at),updated_at:new Date(raw.updated_at)});if(saved.id!==task.id||saved.ownerId!==owner||saved.version!==(row.expectedVersion as number)+1||JSON.stringify(requestFields(taskDefinition({title:saved.title,goal:saved.goal,scope:saved.scope,groupId:saved.groupId,skills:saved.skills})))!==spec)throw Error()}
    catch{throw new WorkError('teloa/storage-corrupt','任务编辑回执损坏，已停止重试。')}
    await client.query('commit');return saved
   }
   if(task.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，请核对新版本。')
   if(['running','completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','执行中或已结束的任务不能修改目标。')
   if(task.title===definition.title&&task.goal===definition.goal)throw new WorkError('teloa/conflict','任务目标没有变化。')
   // 编辑沿用任务原有的业务范围：该范围若已不再登记（例如历史标签被清理），就不该继续往它名下写新版本。
   // 排在版本与状态判据之后，版本落后或任务已结束时仍先报原来的错，范围判据不抢占既有优先级；写仍未发生。
   await assertBusinessScopeRegistered(client,owner,task.scope)
   const updated=await client.query('update teloa_tasks set definition=$3,version=version+1,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,task.id,stored,this.identity.now()])
   const saved=readStoredTask(updated.rows[0])
   await client.query('insert into teloa_task_edits values($1,$2,$3,$4)',[task.id,row.expectedVersion,spec,JSON.stringify(updated.rows[0])])
   await client.query('commit');return saved
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async create(owner:string,input:unknown):Promise<WorkTask>{
  const request=readCreate(owner,input),client=await this.pool.connect()
  try{
   await client.query('begin')
   const task=await this.createPrepared(client,owner,request)
   await client.query('commit');return task
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /** 调用者须已开启事务，并负责提交、回滚和释放连接；若先取 task-create/来源/角色锁，须先取得父请求保护，内部重入不能纠正反序锁。 */
 async createInTransaction(client:PoolClient,owner:string,input:unknown):Promise<WorkTask>{
  return this.createPrepared(client,owner,readCreate(owner,input))
 }
 private async createPrepared(client:PoolClient,owner:string,{requestId,fields,assignee,spec}:ReturnType<typeof readCreate>,identity?:ConversationTaskIdentity):Promise<WorkTask>{
   const parent=await lockConversationTaskParent(client,owner,requestId,identity)
   // 先按本人请求串行，再锁负责人；重试已成功请求不重新检查岗位当前可接任务状态。
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',owner,requestId])])
   const existing=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_tasks where owner_id=$1 and request_id=$2',[owner,requestId,spec])
   if(existing.rows[0]){if(!existing.rows[0].same_request)throw new WorkError('teloa/conflict','同一请求不能创建不同任务。');return readStoredTask(existing.rows[0])}
   assertConversationTaskOpen(parent)
   // 业务范围必须已登记在标签表（规格 §3.2）；判据在任何写之前，未登记时整笔事务不留痕迹。
   await assertBusinessScopeRegistered(client,owner,fields.scope)
   // 关联协作群只认同一本人名下、未归档的群；判据同样排在任何写之前。
   if(fields.groupId!==null){
    const group=await client.query('select archived from teloa_groups where id=$1 and owner_id=$2 for share',[fields.groupId,owner])
    if(!group.rows[0]||group.rows[0].archived!==false)throw new WorkError('teloa/invalid-input','关联的协作群不存在或已归档。')
   }
   if(assignee){
    const result=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for update',[assignee.roleId,owner]),role=result.rows[0]
    if(!role)throw new WorkError('teloa/forbidden','负责人不存在或不属于当前本人。')
    let definition:ReturnType<typeof roleDefinition>;try{definition=roleDefinition(role.definition)}catch{throw new WorkError('teloa/storage-corrupt','负责人定义损坏，请核对原员工。')}
    if(role.version!==assignee.expectedVersion)throw new WorkError('teloa/version-conflict','负责人配置已变化，请核对新版本。')
    if(role.state!=='active'||definition.kind!=='employee')throw new WorkError('teloa/conflict','仅在岗员工可以接收新任务。')
    if(!roleSupportsScope(definition.scopes,fields.scope))throw new WorkError('teloa/forbidden','负责人不支持该业务范围。')
   }
   const result=await client.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,$4,$5,1,'ready',$6,$7,$8,$8) returning *",[this.identity.id(),owner,requestId,spec,JSON.stringify(fields),assignee?.roleId??null,assignee?.expectedVersion??null,this.identity.now()])
   return readStoredTask(result.rows[0])
 }
}
