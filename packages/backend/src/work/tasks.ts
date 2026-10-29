import {bindArtifactRevisionTask} from './artifact-revision-requests.ts'
import {isDeepStrictEqual} from 'node:util'
import {initializeWorkLineage,WorkLineageService} from './work-lineage.ts'
import type {WorkSource} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import {RoleWorkEligibilityService} from './role-work-eligibility.ts'
import {initializeRoleDelegations,readStoredRoleWorkDelegation} from './role-delegations.ts'
import {TwinExecutionConsentService,authorizeOwnerWork,type OwnerWorkAuthority} from './twin-execution-consents.ts'
import type {RoleWorkAuthorization,DigitalRole,WorkExecutor} from '@teloa/contract'
import type {WorkAccessLease} from './work-access.ts'
import {conversationTaskRequest,type ConversationTaskIdentity} from './conversation-task-request.ts'
import {initializeConversationWorkRequests,lockConversationTaskParent,assertConversationTaskOpen} from './conversation-work-task-protection.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readWorkExecutor,roleSupportsScope,taskInput,taskDefinition,taskConfigurationFields,roleDefinition,workTaskStates,type WorkTask,type TaskDraftCreateInput,type TaskDraftCreateReceipt} from '@teloa/contract'
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
 alter table teloa_tasks add column if not exists execution_authorization jsonb;
 alter table teloa_tasks add column if not exists owner_executor jsonb check(owner_executor is null or (jsonb_typeof(owner_executor)='object' and assignee_role_id is null and assignee_role_version is null));
 alter table teloa_tasks add column if not exists content_version integer not null default 1 check(content_version>0);
 create table if not exists teloa_task_edits(task_id uuid not null references teloa_tasks(id),base_version integer not null check(base_version>0),request_spec jsonb not null,result jsonb not null,primary key(task_id,base_version));
 create table if not exists teloa_task_configuration_requests(owner_id text not null,request_id uuid not null,task_id uuid not null references teloa_tasks(id),request_spec jsonb not null,result jsonb not null,primary key(owner_id,request_id));
 create table if not exists teloa_task_draft_requests(owner_id text not null,request_id uuid not null,task_id uuid not null references teloa_tasks(id),request_spec jsonb not null,result jsonb not null,primary key(owner_id,request_id))`)
 await initializeRoleDelegations(pool)
 await initializeWorkLineage(pool)
}
/**
 * 请求指纹：关联协作群与使用技能取默认值时不写进 request_spec。
 * 已存行（本字段上线前只有三键）与同一笔重试因此仍然判为同一请求，
 * 计划领取那侧只造三键 fields 也不会被判成「换了请求」。定义列仍写完整定义。
 */
function requestFields({groupId,skills,...base}:ReturnType<typeof taskDefinition>){
 return {...base,...(groupId===null?{}:{groupId}),...(skills.length?{skills}:{})}
}
/** 创建请求指纹的唯一规范形：创建重试与计划领取核对共用，默认 groupId/skills 显式或省略视为同一请求。 */
export function taskRequestSpec(definition:ReturnType<typeof taskDefinition>,assignee:unknown){
 return {fields:requestFields(definition),assignee}
}
function configurationGroupName(fields:ReturnType<typeof taskConfigurationFields>,value:unknown):string|null|undefined{
 if(value===undefined)return undefined
 if(fields.groupId===undefined||value===null&&fields.groupId!==null||value!==null&&(typeof value!=='string'||!value.trim()||value.length>120||fields.groupId===null))throw new WorkError('teloa/invalid-input','原群名称与任务配置的群身份不一致。')
 return value as string|null
}
function readDraftCreate(input:unknown):TaskDraftCreateInput{
 const row=taskInput(input,['requestId','sessionId','fields','groupName','businessName']),fields=taskDefinition(row.fields)
 if(!uuid(row.requestId)||typeof row.sessionId!=='string'||!row.sessionId.trim()||row.sessionId.length>256||/[\x00-\x1f\x7f]/.test(row.sessionId)||fields.completionPolicy!==undefined)throw new WorkError('teloa/invalid-input','任务草稿来源、定义或请求身份不正确。')
 for(const key of ['groupName','businessName'])if(row[key]!==undefined&&(typeof row[key]!=='string'||!(row[key] as string).trim()||(row[key] as string).length>120))throw new WorkError('teloa/invalid-input','任务草稿的原选择名称不正确。')
 configurationGroupName(fields,row.groupName)
 return {requestId:row.requestId.toLowerCase(),sessionId:row.sessionId,fields,...(row.groupName===undefined?{}:{groupName:row.groupName as string}),...(row.businessName===undefined?{}:{businessName:row.businessName as string})}
}
function readDraftReceipt(owner:string,row:Record<string,any>):TaskDraftCreateReceipt{
 try{
  const input=readDraftCreate(row.request_spec),raw=row.result,task=readStoredTask({...raw,created_at:new Date(raw.created_at),updated_at:new Date(raw.updated_at)})
  if(row.owner_id!==owner||row.request_id!==input.requestId||task.ownerId!==owner||task.id!==row.task_id||task.version!==1||(task.contentVersion??1)!==1||task.state!=='ready'||task.assigneeRoleId!==null||!isDeepStrictEqual(taskDefinition({title:task.title,goal:task.goal,scope:task.scope,groupId:task.groupId,skills:task.skills,...(task.completionPolicy?{completionPolicy:task.completionPolicy}:{})}),input.fields))throw Error()
  return {...input,task}
 }catch{throw new WorkError('teloa/storage-corrupt','任务草稿创建回执损坏，请核对原任务。')}
}
function ownerIdentity(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function readCreate(owner:string,input:unknown){
  ownerIdentity(owner);const row=taskInput(input,['requestId','fields','assignee']),fields=taskDefinition(row.fields)
  if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','需要有效的任务请求 ID。')
  const assignee=row.assignee===undefined?null:taskInput(row.assignee,['roleId','expectedVersion'])
  if(assignee&&(!uuid(assignee.roleId)||!Number.isSafeInteger(assignee.expectedVersion)||(assignee.expectedVersion as number)<1))throw new WorkError('teloa/invalid-input','负责人身份或版本不合法。')
  return {requestId:row.requestId.toLowerCase(),fields,assignee,spec:JSON.stringify(taskRequestSpec(fields,assignee))}
}
export function readStoredTask(row:Record<string,unknown>):WorkTask{
 try{
  const definition=taskDefinition(row.definition)
  if(row.content_version!==undefined&&(!Number.isSafeInteger(row.content_version)||(row.content_version as number)<1))throw Error()
  if(!uuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!Number.isSafeInteger(row.version)||(row.version as number)<1||!workTaskStates.some(state=>state===row.state))throw Error()
  if(row.assignee_role_id===null?row.assignee_role_version!==null:!uuid(row.assignee_role_id)||!Number.isSafeInteger(row.assignee_role_version)||(row.assignee_role_version as number)<1)throw Error()
  const executor=row.owner_executor==null?undefined:readWorkExecutor(row.owner_executor)
  if(executor&&(executor.kind!=='owner'||row.assignee_role_id!==null||definition.scope!=='general'||definition.groupId!==null))throw Error()
  const stamp=(v:unknown)=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw Error();return v.toISOString()}
  return {...definition,...(executor?{executor}:{}),id:row.id,ownerId:row.owner_id,version:row.version as number,contentVersion:row.content_version===undefined?1:row.content_version as number,state:row.state as WorkTask['state'],assigneeRoleId:row.assignee_role_id as string|null,assigneeRoleVersion:row.assignee_role_version as number|null,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
 }catch{throw new WorkError('teloa/storage-corrupt','任务记录损坏，已停止读取，请核对原记录。')}
}
export class TaskService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 readonly ownerAuthority:OwnerWorkAuthority|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},ownerAuthority?:OwnerWorkAuthority){this.pool=pool;this.identity=identity;this.ownerAuthority=ownerAuthority}
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
  // 只传 title 或只传 goal 时另一字段沿用基线任务；显式 undefined、空对象与非法值在读库前拒绝，不当作「沿用」。
  if(!Object.keys(fields).length||Object.values(fields).some(value=>value===undefined))throw new WorkError('teloa/invalid-input','请提供实际需要修改的任务名称或目标。')
  const normalized=taskDefinition({title:'任务',goal:'目标',scope:'general',...fields}),changes:Partial<Pick<WorkTask,'title'|'goal'>>={...(fields.title===undefined?{}:{title:normalized.title}),...(fields.goal===undefined?{}:{goal:normalized.goal})}
  // 业务、群、技能与完成策略始终沿用基线，不由本接口改写。
  const complete=(base:WorkTask)=>taskDefinition({title:base.title,goal:base.goal,...changes,scope:base.scope,groupId:base.groupId,skills:base.skills,...(base.completionPolicy?{completionPolicy:base.completionPolicy}:{})})
  const client=await this.pool.connect()
  try{await client.query('begin')
   const rows=await client.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,row.taskId])
   if(!rows.rows[0])throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(rows.rows[0])
   // 旧版本回执按 (task, base_version) 固定；补全字段只能来自回执的固定结果，不能取最新 Task，否则标题后续变化会让 goal-only 重试被误判为其他目标。
   const receipt=(await client.query('select * from teloa_task_edits where task_id=$1 and base_version=$2',[task.id,row.expectedVersion])).rows[0]
   if(receipt){
    let saved:WorkTask
    try{const raw=receipt.result;saved=readStoredTask({...raw,created_at:new Date(raw.created_at),updated_at:new Date(raw.updated_at)});if(saved.id!==task.id||saved.ownerId!==owner||saved.version!==(row.expectedVersion as number)+1||!isDeepStrictEqual(receipt.request_spec,requestFields(taskDefinition({title:saved.title,goal:saved.goal,scope:saved.scope,groupId:saved.groupId,skills:saved.skills,...(saved.completionPolicy?{completionPolicy:saved.completionPolicy}:{})}))))throw Error()}
    catch{throw new WorkError('teloa/storage-corrupt','任务编辑回执损坏，已停止重试。')}
    // 提供的每个字段都须与固定结果一致；省略字段视为沿用，异值重放不得借原回执通过。
    if(!Object.entries(changes).every(([key,value])=>saved[key as 'title'|'goal']===value))throw new WorkError('teloa/version-conflict','原版本已保存其他目标，请核对新版本。')
    await client.query('commit');return saved
   }
   if(task.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，请核对新版本。')
   // 无回执且版本相等：当前 Task 就是本次编辑的基线。
   const definition=complete(task),stored=JSON.stringify(definition),spec=JSON.stringify(requestFields(definition))
   if(['running','completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','执行中或已结束的任务不能修改目标。')
   if(task.title===definition.title&&task.goal===definition.goal)throw new WorkError('teloa/conflict','任务目标没有变化。')
   // 编辑沿用任务原有的业务范围：该范围若已不再登记（例如历史标签被清理），就不该继续往它名下写新版本。
   // 排在版本与状态判据之后，版本落后或任务已结束时仍先报原来的错，范围判据不抢占既有优先级；写仍未发生。
   await assertBusinessScopeRegistered(client,owner,task.scope)
   const updated=await client.query('update teloa_tasks set definition=$3,version=version+1,content_version=content_version+1,execution_authorization=null,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,task.id,stored,this.identity.now()])
   const saved=readStoredTask(updated.rows[0])
   await client.query('insert into teloa_task_edits values($1,$2,$3,$4)',[task.id,row.expectedVersion,spec,JSON.stringify(updated.rows[0])])
   await client.query('commit');return saved
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /** 自然语言配置沿用原任务；请求回执独立于读取到的版本，断线重放不产生新版本。 */
 async configure(owner:string,input:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>):Promise<WorkTask>{
  ownerIdentity(owner);const row=taskInput(input,['requestId','taskId','expectedVersion','fields','taskName','groupName']),fields=taskConfigurationFields(row.fields),groupName=configurationGroupName(fields,row.groupName)
  if(!uuid(row.requestId)||!uuid(row.taskId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1)throw new WorkError('teloa/invalid-input','任务配置身份或版本不正确。')
  if(row.taskName!==undefined&&(typeof row.taskName!=='string'||!row.taskName.trim()||row.taskName.length>120))throw new WorkError('teloa/invalid-input','原任务名称不正确。')
  const requestId=row.requestId.toLowerCase(),taskId=row.taskId.toLowerCase(),spec=JSON.stringify({taskId,fields,...(row.taskName===undefined?{}:{taskName:row.taskName}),...(groupName===undefined?{}:{groupName})}),db=await this.pool.connect()
  try{
   signal?.throwIfAborted();await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-configuration',owner,requestId])])
   const prior=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_task_configuration_requests where owner_id=$1 and request_id=$2',[owner,requestId,spec])).rows[0]
   if(prior){
    if(!prior.same_request)throw new WorkError('teloa/conflict','同一任务配置请求不能改变内容。')
    let saved:WorkTask
    try{const raw=prior.result;saved=readStoredTask({...raw,created_at:new Date(raw.created_at),updated_at:new Date(raw.updated_at)});if(saved.id!==taskId||saved.ownerId!==owner||!Object.entries(fields).every(([key,value])=>isDeepStrictEqual(saved[key as keyof WorkTask],value)))throw Error()}
    catch{throw new WorkError('teloa/storage-corrupt','任务配置回执损坏，请核对原任务。')}
    await revalidate?.();signal?.throwIfAborted();await db.query('commit');return saved
   }
   const raw=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for update',[owner,taskId])).rows[0]
   if(!raw)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(raw),definition=taskDefinition({title:task.title,goal:task.goal,scope:task.scope,groupId:task.groupId,skills:task.skills,...(task.completionPolicy?{completionPolicy:task.completionPolicy}:{}),...fields})
   if(task.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','任务定义已变化，请核对原任务。')
   if(definition.scope!==task.scope)throw new WorkError('teloa/forbidden','原任务的业务来源固定，不能通过修改定义迁移到另一业务。')
   if(['running','completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','执行中或已结束的任务不能修改定义。')
   const hasRuns=(await db.query("select to_regclass('teloa_task_runs') as relation")).rows[0]?.relation
   const runs=hasRuns?(await db.query('select state from teloa_task_runs where owner_id=$1 and task_id=$2',[owner,taskId])).rows:[]
   if(runs.some(run=>['prepared','submitting','accepted','active'].includes(run.state)))throw new WorkError('teloa/conflict','任务已有冻结执行上下文，请先停止或撤销该轮执行。')
   const linksChanged=definition.groupId!==task.groupId||!isDeepStrictEqual(definition.skills,task.skills)
   if(linksChanged){
    const source=(await db.query('select source from teloa_task_work_lineage where owner_id=$1 and task_id=$2',[owner,taskId])).rows[0]
    if(task.state!=='ready'||runs.length||source?.source?.kind!=='owner-task')throw new WorkError('teloa/conflict','群和技能声明只能调整尚未启动的本人任务草稿；固定来源与历史运行保持原关联。')
    // 行业、业务对象、群消息和计划还保有自己的固定来源；owner-task 谱系本身不能证明是无来源草稿。
    for(const table of ['teloa_industry_task_sources','teloa_business_task_sources','teloa_group_task_sources','teloa_plan_task_links'] as const){
     const present=(await db.query('select to_regclass($1) as relation',[table])).rows[0]?.relation
     if(present&&(await db.query(`select 1 from ${table} where owner_id=$1 and task_id=$2 limit 1`,[owner,taskId])).rowCount)throw new WorkError('teloa/conflict','原任务有固定工作来源，不能通过草稿配置替换关联群或技能声明。')
    }
   }
   if(task.title===definition.title&&task.goal===definition.goal&&!linksChanged)throw new WorkError('teloa/conflict','任务定义没有变化。')
   await assertBusinessScopeRegistered(db,owner,task.scope)
   if(definition.groupId!==null){
    const group=(await db.query("select archived,definition->>'scope' as scope from teloa_groups where id=$1 and owner_id=$2 for share",[definition.groupId,owner])).rows[0]
    if(!group||group.archived!==false||group.scope!==task.scope)throw new WorkError('teloa/forbidden','关联群必须属于本人、未归档并与任务业务一致；保存不会授予群访问或执行权限。')
   }
   await revalidate?.();signal?.throwIfAborted()
   const updated=(await db.query('update teloa_tasks set definition=$3,version=version+1,content_version=content_version+1,execution_authorization=null,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,taskId,JSON.stringify(definition),this.identity.now()])).rows[0],saved=readStoredTask(updated)
   // 与旧目标编辑共享版本回执，旧接口重放不会覆盖本次保存。
   await db.query('insert into teloa_task_edits values($1,$2,$3,$4)',[taskId,task.version,JSON.stringify(requestFields(definition)),JSON.stringify(updated)])
   await db.query('insert into teloa_task_configuration_requests values($1,$2,$3,$4,$5)',[owner,requestId,taskId,spec,JSON.stringify(updated)])
   await revalidate?.();signal?.throwIfAborted();await db.query('commit');return saved
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /** 原工具请求的恢复只读口：改名后也能找回原任务，不依赖进程内缓存。 */
 async configurationRequest(owner:string,input:unknown):Promise<{task:WorkTask;fields:ReturnType<typeof taskConfigurationFields>;taskName?:string;groupName?:string|null}|null>{
  ownerIdentity(owner);const row=taskInput(input,['requestId']);if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','任务配置请求身份不正确。')
  const receipt=(await this.pool.query('select * from teloa_task_configuration_requests where owner_id=$1 and request_id=$2',[owner,row.requestId.toLowerCase()])).rows[0]
  if(!receipt)return null
  try{
   const spec=taskInput(receipt.request_spec,['taskId','fields','taskName','groupName']),raw=receipt.result,task=readStoredTask({...raw,created_at:new Date(raw.created_at),updated_at:new Date(raw.updated_at)}),fields=taskConfigurationFields(spec.fields),groupName=configurationGroupName(fields,spec.groupName)
   if(task.ownerId!==owner||task.id!==receipt.task_id||task.id!==spec.taskId||spec.taskName!==undefined&&(typeof spec.taskName!=='string'||!spec.taskName.trim()||spec.taskName.length>120)||!Object.entries(fields).every(([key,value])=>isDeepStrictEqual(task[key as keyof WorkTask],value)))throw Error()
   return {task,fields,...(spec.taskName===undefined?{}:{taskName:spec.taskName as string}),...(groupName===undefined?{}:{groupName})}
  }catch{throw new WorkError('teloa/storage-corrupt','任务配置回执损坏，请核对原任务。')}
 }
 /** NL 草稿独立创建回执；返回首次创建的 v1，而不是后续修改后的 current Task。 */
 async createConfiguration(owner:string,input:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>):Promise<WorkTask>{
  ownerIdentity(owner);const fixed=readDraftCreate(input),spec=JSON.stringify(fixed),db=await this.pool.connect()
  try{
   signal?.throwIfAborted();await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-draft',owner,fixed.requestId])])
   const prior=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_task_draft_requests where owner_id=$1 and request_id=$2',[owner,fixed.requestId,spec])).rows[0]
   if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一任务草稿创建请求不能改变原选择或内容。');const saved=readDraftReceipt(owner,prior).task;await revalidate?.();signal?.throwIfAborted();await db.query('commit');return saved}
   // 只保存本人草稿，不接负责人，也不建立任何可执行会话关联。
   const task=await this.createPrepared(db,owner,readCreate(owner,{requestId:fixed.requestId,fields:fixed.fields}))
   if(fixed.fields.groupId!==null){const group=(await db.query("select definition->>'scope' as scope from teloa_groups where owner_id=$1 and id=$2 for share",[owner,fixed.fields.groupId])).rows[0];if(!group||group.scope!==fixed.fields.scope)throw new WorkError('teloa/forbidden','任务草稿的协作群必须与任务业务一致。')}
   if(task.version!==1||task.state!=='ready'||task.assigneeRoleId!==null||!isDeepStrictEqual(taskDefinition({title:task.title,goal:task.goal,scope:task.scope,groupId:task.groupId,skills:task.skills}),fixed.fields))throw new WorkError('teloa/conflict','原请求已对应其他任务状态，请核对原任务，不能补造创建回执。')
   const raw=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,task.id])).rows[0]
   await revalidate?.();signal?.throwIfAborted()
   await db.query('insert into teloa_task_draft_requests values($1,$2,$3,$4,$5)',[owner,fixed.requestId,task.id,spec,JSON.stringify(raw)])
   await revalidate?.();signal?.throwIfAborted();await db.query('commit');return task
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async createConfigurationRequest(owner:string,input:unknown):Promise<TaskDraftCreateReceipt|null>{
  ownerIdentity(owner);const row=taskInput(input,['requestId']);if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','任务草稿创建请求身份不正确。')
  const prior=(await this.pool.query('select * from teloa_task_draft_requests where owner_id=$1 and request_id=$2',[owner,row.requestId.toLowerCase()])).rows[0]
  return prior?readDraftReceipt(owner,prior):null
 }
 async create(owner:string,input:unknown,signal?:AbortSignal,revalidate?:()=>Promise<void>):Promise<WorkTask>{
  const request=readCreate(owner,input)
  if(request.fields.completionPolicy?.kind==='verified')throw new WorkError('teloa/forbidden','自动结项只能使用已确认的计划或系统工作。')
  const client=await this.pool.connect()
  try{
   signal?.throwIfAborted()
   await client.query('begin')
   const task=await this.createPrepared(client,owner,request)
   await revalidate?.();signal?.throwIfAborted()
   await client.query('commit');return task
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /** 仅本人 RPC 装配的授权实例可调用；创建、本人回执和谱系同事务。 */
 async createConfirmed(owner:string,input:unknown):Promise<WorkTask>{
  const request=readCreate(owner,input)
  if(request.fields.completionPolicy?.kind==='verified')throw new WorkError('teloa/forbidden','本次确认不包含自动结项策略。')
  if(!request.assignee||!this.ownerAuthority)throw new WorkError('teloa/forbidden','需要本人明确确认分身的执行任务。')
  const fixed={...request,spec:JSON.stringify({...JSON.parse(request.spec),ownerConfirmation:true})},client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',owner,request.requestId])])
   const prior=(await client.query('select *,request_spec=$3::jsonb as same_request from teloa_tasks where owner_id=$1 and request_id=$2',[owner,request.requestId,fixed.spec])).rows[0]
   // 已提交请求只读恢复，不因当前权益或委托变化重新授予执行许可。
   if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一请求不能创建不同任务。');const result=readStoredTask(prior);await client.query('commit');return result}
   const admission=await authorizeOwnerWork(this.ownerAuthority,owner,{requestId:request.requestId,roleId:request.assignee.roleId as string,operation:'confirm'})
   admission.assertCurrent();const task=await this.createPrepared(client,owner,fixed,undefined,admission)
   admission.assertCurrent();await client.query('commit');return task
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /** 调用者须已开启事务，并负责提交、回滚和释放连接；若先取 task-create/来源/角色锁，须先取得父请求保护，内部重入不能纠正反序锁。 */
 async createInTransaction(client:PoolClient,owner:string,input:unknown,source?:WorkSource):Promise<WorkTask>{
  const request=readCreate(owner,input)
  if(request.fields.completionPolicy?.kind==='verified'){
   if(source?.kind!=='plan-occurrence')throw new WorkError('teloa/forbidden','自动结项必须来自已确认的持久计划。')
   const plan=(await client.query('select p.definition from teloa_plan_occurrences o join teloa_plans p on p.owner_id=o.owner_id and p.id=o.plan_id where o.owner_id=$1 and o.id=$2 for share of o,p',[owner,source.claimId])).rows[0]
   if(!plan||!isDeepStrictEqual(plan.definition.completionPolicy,request.fields.completionPolicy))throw new WorkError('teloa/forbidden','本轮自动结项策略与已确认计划不一致。')
  }
  return this.createPrepared(client,owner,request,undefined,undefined,source)
 }
 private async createPrepared(client:PoolClient,owner:string,{requestId,fields,assignee,spec}:ReturnType<typeof readCreate>,identity?:ConversationTaskIdentity,confirmed?:WorkAccessLease,source?:WorkSource):Promise<WorkTask>{
   const parent=await lockConversationTaskParent(client,owner,requestId,identity)
   // 先按本人请求串行，再锁负责人；重试已成功请求不重新检查岗位当前可接任务状态。
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',owner,requestId])])
   const existing=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_tasks where owner_id=$1 and request_id=$2',[owner,requestId,spec])
   if(existing.rows[0]){if(!existing.rows[0].same_request)throw new WorkError('teloa/conflict','同一请求不能创建不同任务。');return readStoredTask(existing.rows[0])}
   assertConversationTaskOpen(parent)
   // 业务范围必须已登记在标签表（规格 §3.2）；判据在任何写之前，未登记时整笔事务不留痕迹。
   await assertBusinessScopeRegistered(client,owner,fields.scope)
   let assigned:DigitalRole|undefined,authorization:RoleWorkAuthorization|undefined,ownerPlanExecutor:Extract<WorkExecutor,{kind:'owner'}>|undefined
   if(source?.kind==='plan-occurrence'){
    const row=(await client.query('select o.*,p.work_definition as current_work_definition from teloa_plan_occurrences o join teloa_plans p on p.owner_id=o.owner_id and p.id=o.plan_id where o.owner_id=$1 and o.id=$2 for share of o,p',[owner,source.claimId])).rows[0]
    if(!row)throw new WorkError('teloa/forbidden','计划本轮来源不存在。')
    const {readStoredPlanOccurrence}=await import('./plan-occurrences.ts'),occurrence=readStoredPlanOccurrence(row)
    if(occurrence.taskRequestId!==requestId||!isDeepStrictEqual(taskDefinition(occurrence.taskRequest.fields),fields)||(occurrence.fields.roleId===null?assignee!==null:occurrence.roleVersion!==assignee?.expectedVersion||occurrence.fields.roleId!==assignee?.roleId))throw new WorkError('teloa/forbidden','任务与固定计划本轮不一致。')
    if(occurrence.workDefinition){
     if(!isDeepStrictEqual(occurrence.workDefinition,row.current_work_definition))throw new WorkError('teloa/version-conflict','长期工作定义已变化，请重新领取当前轮次。')
     const definition=occurrence.workDefinition,binding=(await client.query('select * from teloa_work_plan_bindings where owner_id=$1 and plan_id=$2 and config_version=$3',[owner,occurrence.planId,occurrence.configVersion])).rows[0]
     const control=(await client.query('select * from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,definition.definitionControlId])).rows[0]
     if(!binding||binding.definition_control_id!==definition.definitionControlId||binding.budget_account_id!==definition.budgetAccountId||!control||control.state!=='active'||control.kind!=='definition'||control.budget_account_id!==definition.budgetAccountId)throw new WorkError('teloa/forbidden','长期工作控制或额度归属不一致。')
     if(definition.authorization.kind==='owner'){
      const {readStoredPlan}=await import('./plans.ts'),plan=readStoredPlan((await client.query('select * from teloa_plans where owner_id=$1 and id=$2 for share',[owner,occurrence.planId])).rows[0])
      if(plan.roleId!==null||plan.state!=='active'||plan.version!==occurrence.planVersion||plan.configVersion!==occurrence.configVersion||!isDeepStrictEqual(plan.executor,definition.authorization)||fields.scope!=='general'||fields.groupId!==null)throw new WorkError('teloa/forbidden','本人计划来源或执行范围已变化。')
      ownerPlanExecutor=definition.authorization
     }else authorization=definition.authorization
    }
   }
   if(assignee){
    const result=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for update',[assignee.roleId,owner]),role=result.rows[0]
    if(!role)throw new WorkError('teloa/forbidden','负责人不存在或不属于当前本人。')
    let definition:ReturnType<typeof roleDefinition>;try{definition=roleDefinition(role.definition)}catch{throw new WorkError('teloa/storage-corrupt','负责人定义损坏，请核对原员工。')}
    if(role.version!==assignee.expectedVersion)throw new WorkError('teloa/version-conflict','负责人配置已变化，请核对新版本。')
    if(role.state!=='active'||!definition.responsibility)throw new WorkError('teloa/conflict','请先确认负责角色的完整职责。')
    assigned=readStoredRole(role)
    if(definition.kind==='twin'&&!confirmed&&!authorization){
     const roleIdentity=assigned
     const rows=await client.query("select * from teloa_role_work_delegations where owner_id=$1 and role_id=$2 and role_version=$3 and state='active' for share",[owner,roleIdentity.id,roleIdentity.version])
     const matching=rows.rows.map(readStoredRoleWorkDelegation).filter(d=>d.scope===fields.scope&&(fields.groupId===null||d.groupIds.includes(fields.groupId)))
     const selected=matching[0]
     if(!selected||matching.length!==1)throw new WorkError('teloa/forbidden','请本人确认分身的执行委托，再交办任务。')
     authorization={kind:'delegation',delegationId:selected.id,delegationVersion:selected.version}
    }
    if(!roleSupportsScope(definition.scopes,fields.scope))throw new WorkError('teloa/forbidden','负责人不支持该业务范围。')
   }
   // 关联协作群只认同一本人名下、未归档的群；判据同样排在任何写之前。
   if(fields.groupId!==null){
    const group=await client.query('select archived from teloa_groups where id=$1 and owner_id=$2 for share',[fields.groupId,owner])
    if(!group.rows[0]||group.rows[0].archived!==false)throw new WorkError('teloa/invalid-input','关联的协作群不存在或已归档。')
   }
   const taskId=this.identity.id()
   confirmed?.assertCurrent()
   const result=await client.query("insert into teloa_tasks(id,owner_id,request_id,request_spec,definition,version,state,assignee_role_id,assignee_role_version,created_at,updated_at) values($1,$2,$3,$4,$5,1,'ready',$6,$7,$8,$8) returning *",[taskId,owner,requestId,spec,JSON.stringify(fields),assignee?.roleId??null,assignee?.expectedVersion??null,this.identity.now()])
   if(identity?.executor==='general'){
    await client.query('update teloa_tasks set owner_executor=$3 where owner_id=$1 and id=$2 returning *',[owner,taskId,JSON.stringify({kind:'owner',grantId:identity.requestId,grantVersion:1})]).then(updated=>{result.rows[0]=updated.rows[0]})
   }
   if(ownerPlanExecutor)await client.query('update teloa_tasks set owner_executor=$3 where owner_id=$1 and id=$2 returning *',[owner,taskId,JSON.stringify(ownerPlanExecutor)]).then(updated=>{result.rows[0]=updated.rows[0]})
   const task=readStoredTask(result.rows[0])
   if(assigned&&(assigned.kind==='twin'||authorization)){
    if(confirmed){authorization={kind:'task',taskId:task.id,taskContentVersion:task.contentVersion??1};await new TwinExecutionConsentService(this.pool,this.identity,this.ownerAuthority).confirmInTransaction(client,owner,{requestId,roleId:assigned.id,expectedRoleVersion:assigned.version,authorization})}
    if(!authorization)throw new WorkError('teloa/forbidden','缺少分身执行授权。')
    const admission=await new RoleWorkEligibilityService(this.pool).authorize(owner,{roleId:assigned.id,expectedRoleVersion:assigned.version,scope:task.scope,inputSchema:'teloa.task-run-input/v2',authorization,groupId:task.groupId},client)
    await client.query('update teloa_tasks set execution_authorization=$3 where owner_id=$1 and id=$2',[owner,task.id,JSON.stringify(authorization)]);admission.assertCurrent()
   }
   await new WorkLineageService(this.pool,this.identity).bindTask(client,owner,{taskId:task.id,source:source??{kind:'owner-task',taskId:task.id}},identity)
   if(identity?.executor==='general')await bindArtifactRevisionTask(client,owner,identity.requestId,task.id)
   confirmed?.assertCurrent();return task
 }
}
