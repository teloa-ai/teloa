import {conversationTaskRequest} from './conversation-task-request.ts'
import {lockConversationTaskParent,assertConversationTaskOpen} from './conversation-work-task-protection.ts'
import {businessTaskSourceDigest} from './business-task-source-digest.ts'
import {businessTaskActionSourceDigest} from './business-task-action-source-digest.ts'
import type {Pool,PoolClient} from 'pg'
import {WorkError,artifactContent,savedArtifactSource,businessMcpSourceIdMaxLength,businessObjectReference,isBusinessScopeKey,isRecord,taskInput,type BusinessActionInput,type BusinessActionRecord,type BusinessDefinitionSource,type BusinessObjectReference,type BusinessObjectSnapshot,type BusinessObjectTypeRecord,type WorkTask} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from './business-data.ts'
import {readStoredTask,type TaskService} from './tasks.ts'
import {runEvidence} from './task-run-evidence.ts'
import type {BusinessDefinitionBundle,BusinessDefinitionSourceReader} from './business-definition-source.ts'
import type {IndustryLoadService} from './industry-loads.ts'
import type {IndustryWorkSnapshot,IndustryWorkSource} from './industry-work-source.ts'

export type BusinessTaskActor={ownerId:string;scopeIds:string[]}
export type BusinessTaskSource={
 schema:'teloa.business-task-source/v1'
 taskId:string
 ownerId:string
 sourceId:string
 reference:BusinessObjectReference
 createdAssignee:{roleId:string;roleVersion:number}|null
 createdAt:string
}
export type BusinessTaskRecord={task:WorkTask;source:BusinessTaskSource}
export type BusinessTaskProgress={runId:string;state:'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed';reason:string|null;stopRequestedAt:string|null}
export type BusinessTaskCompletion={artifactId:string;version:number;title:string;completedAt:string}
export type BusinessTaskListItem={task:Pick<WorkTask,'id'|'ownerId'|'title'|'scope'|'version'|'state'|'assigneeRoleId'|'assigneeRoleVersion'|'createdAt'|'updatedAt'>;source:BusinessTaskSource|null;progress:BusinessTaskProgress|null;completion:BusinessTaskCompletion|null}
export type BusinessTaskListPage={items:BusinessTaskListItem[];nextCursor?:string}
export type BusinessTaskActionSource={
 schema:'teloa.business-task-action-source/v1'
 taskId:string
 ownerId:string
 action:{id:string;version:string;definitionHash:string;source:BusinessDefinitionSource;title:string;objectType:string}
 template:IndustryWorkSnapshot
 inputs:string[]
 createdAt:string
}
export type BusinessTaskContext={source:BusinessTaskSource;object:BusinessObjectSnapshot;action?:BusinessTaskActionSource}
export type BusinessTaskReferenceSnapshot={reference:BusinessObjectReference;object:BusinessObjectSnapshot;sourceId:string}
export type BusinessTaskActionDependencies={
 definitions:Pick<BusinessDefinitionSourceReader,'forScope'>
 loads:Pick<IndustryLoadService,'getInTransaction'>
 works:Pick<IndustryWorkSource,'read'|'assertModelsReady'>
 executions?:Pick<import('./industry-execution-tools.ts').IndustryExecutionToolService,'activeBindingForItemInTransaction'>
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const corrupt=()=>new WorkError('teloa/storage-corrupt','任务的业务对象来源记录损坏，已停止读取。')

export async function initializeBusinessTasks(pool:Pool):Promise<void>{
 await pool.query(`create unique index if not exists teloa_tasks_identity_owner on teloa_tasks(id,owner_id);
 create table if not exists teloa_business_task_sources (
  task_id uuid primary key,owner_id text not null,request_id uuid not null,
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  scope_id text not null,object_type text not null,object_id text not null,object_version integer not null check(object_version>0),
  snapshot_hash text not null check(snapshot_hash~'^[a-f0-9]{64}$'),source_id text not null,
  source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),snapshot_digest text not null check(snapshot_digest~'^[a-f0-9]{64}$'),created_at timestamptz not null,
  unique(owner_id,request_id),foreign key(task_id,owner_id) references teloa_tasks(id,owner_id),
  foreign key(owner_id,scope_id,object_type,object_id,object_version) references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version)
 );
 create unique index if not exists teloa_business_task_sources_identity_owner on teloa_business_task_sources(task_id,owner_id);
 create table if not exists teloa_business_task_action_sources (
  task_id uuid primary key,owner_id text not null,
  source_snapshot jsonb not null check(jsonb_typeof(source_snapshot)='object'),snapshot_digest text not null check(snapshot_digest~'^[a-f0-9]{64}$'),created_at timestamptz not null,
  foreign key(task_id,owner_id) references teloa_business_task_sources(task_id,owner_id)
 )`)
}

function actorIdentity(actor:BusinessTaskActor):void{
 if(!text(actor.ownerId,128)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)||scope==='general'))throw new WorkError('teloa/forbidden','需要有效的本人身份与业务范围。')
}

function assigneeValue(value:unknown):{roleId:string;expectedVersion:number}|undefined{
 if(value===undefined)return undefined
 const row=taskInput(value,['roleId','expectedVersion'])
 if(!uuid(row.roleId)||!Number.isSafeInteger(row.expectedVersion)||Number(row.expectedVersion)<1)throw new WorkError('teloa/invalid-input','负责人身份或版本不合法。')
 return {roleId:row.roleId.toLowerCase(),expectedVersion:row.expectedVersion as number}
}

function stable(value:unknown):value is string{return typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)}
function createInput(input:unknown){
 const row=taskInput(input,['requestId','reference','goal','assignee','actionId','title'])
 if(!uuid(row.requestId)||!text(row.goal,8000))throw new WorkError('teloa/invalid-input','调查任务的请求身份或目标不正确。')
 if(row.actionId!==undefined&&!stable(row.actionId))throw new WorkError('teloa/invalid-input','业务动作身份不正确。')
 if(row.title!==undefined&&(!text(row.title,120)||row.actionId!==undefined))throw new WorkError('teloa/invalid-input','通用交办标题不合法或与固定业务动作冲突。')
 const reference=businessObjectReference(row.reference),assignee=assigneeValue(row.assignee),actionId=row.actionId as string|undefined,title=row.title as string|undefined
 return {requestId:row.requestId.toLowerCase(),reference,goal:row.goal,assignee,actionId,title,spec:{reference,goal:row.goal,assignee:assignee??null,...(actionId?{actionId}: {}),...(title?{title}:{})}}
}

function taskTitle(title:string):string{return ('调查：'+title).slice(0,120)}

type ResolvedBusinessAction={record:BusinessActionRecord;template:IndustryWorkSnapshot;inputs:string[]}

function mappedActionInput(input:BusinessActionInput,snapshot:Omit<BusinessObjectSnapshot,'snapshotHash'>,objectType:BusinessObjectTypeRecord):string{
 if(input.from==='literal')return input.value
 if(input.from==='object')return snapshot[input.part]
 const field=objectType.definition.fields.find(candidate=>candidate.name===input.field)
 if(!field)throw new WorkError('teloa/source-unavailable','业务动作引用的对象字段不在当前声明里。')
 const value=snapshot.fields.find(candidate=>candidate.label===field.from)?.value
 if(value===undefined)throw new WorkError('teloa/invalid-input','固定业务对象缺少业务动作所需字段。')
 return value
}

export class BusinessTaskService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly tasks:Pick<TaskService,'createInTransaction'|'createForConversationInTransaction'|'requestForConversationInTransaction'>
 private readonly actionDependencies:BusinessTaskActionDependencies|undefined
 constructor(pool:Pool,identity:{now:()=>string},tasks:Pick<TaskService,'createInTransaction'|'createForConversationInTransaction'|'requestForConversationInTransaction'>,actionDependencies?:BusinessTaskActionDependencies){this.pool=pool;this.identity=identity;this.tasks=tasks;this.actionDependencies=actionDependencies}

 /** 交办预备与最终创建共用同一固定快照判据；只读入口不会创建任务或改变引用。 */
 private async fixedObject(db:PoolClient,owner:string,reference:BusinessObjectReference,lock:boolean):Promise<BusinessTaskReferenceSnapshot>{
  const found=(await db.query(`select snapshot_hash,snapshot,source_id from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5${lock?' for share':''}`,[owner,reference.scope,reference.type,reference.id,reference.version])).rows[0]
  if(!found){const other=(await db.query('select 1 from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[owner,reference.scope,reference.type,reference.id])).rows[0];throw new WorkError(other?'teloa/version-conflict':'teloa/forbidden',other?'业务对象版本已变化，请重新选择固定快照。':'业务对象不存在或不属于本人。')}
  let snapshot:ReturnType<typeof readBusinessObjectSnapshot>;try{snapshot=readBusinessObjectSnapshot(found.snapshot,reference.scope)}catch{throw new WorkError('teloa/storage-corrupt','固定业务对象快照格式不正确。')}
  if(snapshot.type!==reference.type||snapshot.id!==reference.id||snapshot.version!==reference.version||businessObjectSnapshotHash(snapshot)!==found.snapshot_hash||!text(found.source_id,businessMcpSourceIdMaxLength))throw new WorkError('teloa/storage-corrupt','固定业务对象快照与摘要不一致。')
  if(found.snapshot_hash!==reference.snapshotHash)throw new WorkError('teloa/version-conflict','业务对象固定快照已变化，请重新核对。')
  return {reference,object:{...snapshot,snapshotHash:found.snapshot_hash},sourceId:found.source_id}
 }

 async reference(actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskReferenceSnapshot>{
  actorIdentity(actor)
  const reference=businessObjectReference(input)
  if(!actor.scopeIds.includes(reference.scope))throw new WorkError('teloa/forbidden','当前主体无权读取此业务对象。')
  const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const fixed=await this.fixedObject(db,actor.ownerId,reference,false);await db.query('commit');return fixed}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /** 改派的短事务复用同一固定对象判据；不借连接，不切换到最新版本。 */
 async referenceInTransaction(db:PoolClient,actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskReferenceSnapshot>{
  actorIdentity(actor);const reference=businessObjectReference(input)
  if(!actor.scopeIds.includes(reference.scope))throw new WorkError('teloa/forbidden','当前主体无权读取此业务对象。')
  return this.fixedObject(db,actor.ownerId,reference,true)
 }

 private async resolveAction(db:PoolClient,owner:string,scope:string,snapshot:Omit<BusinessObjectSnapshot,'snapshotHash'>,actionId:string):Promise<ResolvedBusinessAction>{
  if(!this.actionDependencies)throw new WorkError('teloa/dependency-unavailable','业务动作任务来源读取尚未接入。')
  const bundles=await this.actionDependencies.definitions.forScope(db,owner,scope)
  let found:{bundle:BusinessDefinitionBundle;record:BusinessActionRecord}|undefined
  for(const bundle of bundles){
   const record=bundle.actions.find(candidate=>candidate.definition.id===actionId)
   if(record){found={bundle,record};break}
  }
  if(!found)throw new WorkError('teloa/forbidden','业务动作不存在、已更新或不属于当前业务范围。')
  const objectType=found.bundle.objectTypes.find(candidate=>candidate.definition.id===found.record.definition.objectType)
  if(!objectType||objectType.definition.id!==snapshot.type)throw new WorkError('teloa/forbidden','业务动作不适用于当前业务对象。')
  if(found.bundle.origin.kind!=='market')throw new WorkError('teloa/forbidden','本地业务配置不支持市场动作。')
  const target=found.record.definition.target
  const load=await this.actionDependencies.loads.getInTransaction(db,owner,{loadId:found.bundle.origin.loadId})
  const templateLocalId=target.kind==='work-template'?target.localId:target.workTemplate
  const item=load.items.find(candidate=>candidate.localId===templateLocalId)
  if(!item||item.kind!=='work-template'||item.status!=='pending-adapter')throw new WorkError('teloa/source-unavailable','业务动作引用的工作模板当前不可用。')
  const template=await this.actionDependencies.works.read(owner,load.id,item.instanceId,db)
  if(template.scope!==scope||template.requirements.length!==found.record.definition.inputs.length)throw new WorkError('teloa/source-unavailable','业务动作与工作模板的固定要求不一致。')
  const inputs=found.record.definition.inputs.map(input=>mappedActionInput(input,snapshot,objectType))
  if(inputs.some(value=>!text(value,4000)))throw new WorkError('teloa/invalid-input','固定业务对象无法满足业务动作的输入要求。')
  if(target.kind==='execution-tool'){
   const executionItem=load.items.find(candidate=>candidate.localId===target.localId)
   if(!executionItem||executionItem.kind!=='execution-tool'||executionItem.status!=='pending-adapter')throw new WorkError('teloa/source-unavailable','业务动作引用的执行工具当前不可用。')
   if(!this.actionDependencies.executions)throw new WorkError('teloa/dependency-unavailable','执行工具任务入口尚未接入。')
   const binding=await this.actionDependencies.executions.activeBindingForItemInTransaction(db,owner,{loadId:load.id,itemInstanceId:executionItem.instanceId,tool:target.tool})
   if(binding===null)throw new WorkError('teloa/dependency-unavailable','执行工具尚未完成授权或连接核验。')
   const executionTarget=mappedActionInput(target.targetFrom,snapshot,objectType)
   if(!text(executionTarget,4000))throw new WorkError('teloa/invalid-input','固定业务对象无法提供执行目标。')
  }
  return {record:found.record,template,inputs}
 }


 private async row(db:Pool|PoolClient,owner:string,taskId:string):Promise<BusinessTaskContext|null>{
  const row=(await db.query(`select s.*,t.request_id task_request_id,t.request_spec task_request_spec,b.snapshot business_snapshot,b.snapshot_hash business_snapshot_hash,b.source_id business_source_id,
   a.source_snapshot action_source_snapshot,a.snapshot_digest action_snapshot_digest,a.created_at action_created_at
   from teloa_business_task_sources s join teloa_tasks t on t.id=s.task_id and t.owner_id=s.owner_id
   join teloa_business_object_snapshots b on b.owner_id=s.owner_id and b.scope_id=s.scope_id and b.object_type=s.object_type and b.object_id=s.object_id and b.object_version=s.object_version
   left join teloa_business_task_action_sources a on a.task_id=s.task_id and a.owner_id=s.owner_id
   where s.task_id=$1 and s.owner_id=$2`,[taskId,owner])).rows[0]
  if(!row)return null
  const action=readBusinessTaskActionSource(row)
  const source=readBusinessTaskSource(row,action),object=readBusinessObjectSnapshot(row.business_snapshot,source.reference.scope)
  return {source,object:{...object,snapshotHash:row.business_snapshot_hash},...(action?{action}: {})}
 }

 /**
  * 该会话是否关联过带业务对象来源的任务。
  *
  * 判据只看关联是否**存在过**，不看 `active`：告警正文一旦随任务快照进过这条会话的
  * user turn，事后解除关联并不会把那段文字从历史里拿走。查询不带 scope 过滤 ——
  * 这里只回答"有没有外部来源"，不回答"谁有权读它"，读权限由各业务接口自己把关。
  * 调用方（`task-tool-guard` 的外发闸）在本方法抛出时按"绑定了"处理。
  */
 async hasBusinessSource(ownerId:string,sessionId:string):Promise<boolean>{
  return (await this.businessSourceScope(ownerId,sessionId))!==null
 }

 /** 任务会话绑定的业务范围：该会话所属任务的业务来源对象所在范围；会话不属于任何带业务来源的任务时为 null。 */
 async businessSourceScope(ownerId:string,sessionId:string):Promise<string|null>{
  if(!text(ownerId,128)||typeof sessionId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId))throw new WorkError('teloa/invalid-input','本人身份或会话身份不正确。')
  const found=await this.pool.query<{scope_id:string}>(`select s.scope_id from teloa_business_task_sources s
   join teloa_object_conversations c on c.owner_id=s.owner_id and c.kind='task' and c.object_id=s.task_id
   where s.owner_id=$1 and c.session_id=$2 limit 1`,[ownerId,sessionId])
  return found.rows[0]?.scope_id??null
 }

 async source(actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskSource|null>{
  actorIdentity(actor);const row=taskInput(input,['taskId']);if(!uuid(row.taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
  const task=(await this.pool.query('select definition from teloa_tasks where id=$1 and owner_id=$2',[row.taskId,actor.ownerId])).rows[0]
  if(!task)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
  const context=await this.row(this.pool,actor.ownerId,row.taskId.toLowerCase())
  if(context&&!actor.scopeIds.includes(context.source.reference.scope))throw new WorkError('teloa/forbidden','当前主体无权读取此任务的业务对象来源。')
  return context?.source??null
 }

 async context(actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskContext|null>{
  return this.contextInTransaction(this.pool,actor,input)
 }

 async contextInTransaction(db:PoolClient|Pool,actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskContext|null>{
  actorIdentity(actor);const row=taskInput(input,['taskId']);if(!uuid(row.taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
  const task=(await db.query('select definition from teloa_tasks where id=$1 and owner_id=$2',[row.taskId,actor.ownerId])).rows[0]
  if(!task)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
  const context=await this.row(db,actor.ownerId,row.taskId.toLowerCase())
  if(context&&!actor.scopeIds.includes(context.source.reference.scope))throw new WorkError('teloa/forbidden','当前主体无权读取此任务的业务对象来源。')
  return context
 }

 /** 执行入口只重验创建时固定工作模板的模型依赖；历史查阅继续使用只读 context，不受当前模型状态影响。 */
 async executionContextInTransaction(db:PoolClient,actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskContext|null>{
  const context=await this.contextInTransaction(db,actor,input)
  if(context?.action){
   if(!this.actionDependencies)throw new WorkError('teloa/dependency-unavailable','业务动作任务来源读取尚未接入。')
   await this.actionDependencies.works.assertModelsReady(actor.ownerId,context.action.template,db)
  }
  return context
 }

 /** 范围列表从真实任务出发，不能用对象来源inner join漏掉普通业务交办。 */
 async listForScope(actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskListPage>{return this.list(actor,input,false)}
 /** 按稳定对象身份查任务，来源仍保留每次创建时的固定历史版本与摘要。 */
 async listForObject(actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskListPage>{return this.list(actor,input,true)}
 private async list(actor:BusinessTaskActor,input:unknown,object:boolean):Promise<BusinessTaskListPage>{
  actorIdentity(actor)
  const query=taskInput(input,object?['scope','type','id','limit','cursor']:['scope','limit','cursor'])
  const invalid=()=>new WorkError('teloa/invalid-input','业务任务分页范围或游标不正确。')
  if(!isBusinessScopeKey(query.scope)||query.scope==='general')throw invalid()
  const scope=query.scope
  if(!actor.scopeIds.includes(scope))throw new WorkError('teloa/forbidden','当前主体无权读取此业务的任务。')
  // 用已有引用reader校验对象身份；占位版本/摘要仅用于结构校验，不成为业务事实。
  const target=object?businessObjectReference({scope,type:query.type,id:query.id,version:1,snapshotHash:'0'.repeat(64)}):undefined
  const limit=query.limit===undefined?20:query.limit
  if(!Number.isSafeInteger(limit)||Number(limit)<1||Number(limit)>50)throw invalid()
  const key=['teloa.business-task-list/v1',actor.ownerId,scope,target?.type??null,target?.id??null]
  let after:{time:string;id:string}|undefined
  if(query.cursor!==undefined){
   try{
    if(typeof query.cursor!=='string'||query.cursor.length>2048)throw Error()
    const value:unknown=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'))
    if(!Array.isArray(value)||value.length!==7||JSON.stringify(value.slice(0,5))!==JSON.stringify(key)||typeof value[5]!=='string'||new Date(value[5]).toISOString()!==value[5]||!uuid(value[6]))throw Error()
    after={time:value[5],id:value[6]}
   }catch{throw invalid()}
  }
  const db=await this.pool.connect()
  try{
   await db.query('begin isolation level repeatable read read only')
   const parameters:unknown[]=[actor.ownerId,scope]
   let filter="t.owner_id=$1 and t.definition->>'scope'=$2"
   if(target){parameters.push(target.type,target.id);filter+=' and exists(select 1 from teloa_business_task_sources s where s.owner_id=t.owner_id and s.task_id=t.id and s.scope_id=$2 and s.object_type=$3 and s.object_id=$4)'}
   if(after){parameters.push(after.time,after.id);filter+=' and (t.created_at,t.id)>($'+(parameters.length-1)+'::timestamptz,$'+parameters.length+'::uuid)'}
   parameters.push(Number(limit)+1)
   const rows=(await db.query('select t.*,exists(select 1 from teloa_business_task_sources s where s.owner_id=t.owner_id and s.task_id=t.id) has_source from teloa_tasks t where '+filter+' order by t.created_at,t.id limit $'+parameters.length,parameters)).rows
   const ids=rows.slice(0,Number(limit)).map(row=>row.id as string)
   // 只为当前页批量读取两类既有事实；相同只读快照避免状态与成果跨版本拼接。
   const runRows=ids.length?(await db.query(`select distinct on (task_id) task_id,id,state,evidence,stop_requested_at from teloa_task_runs
    where owner_id=$1 and task_id=any($2::uuid[]) order by task_id,created_at desc,id desc`,[actor.ownerId,ids])).rows:[]
   const completionRows=ids.length?(await db.query(`select c.*,v.source artifact_source,v.content artifact_content,v.number artifact_number,h.current_version
    from teloa_task_completions c left join teloa_artifact_versions v on v.owner_id=c.owner_id and v.artifact_id=c.artifact_id and v.number=c.artifact_version
    left join teloa_artifacts h on h.owner_id=c.owner_id and h.id=c.artifact_id
    where c.owner_id=$1 and c.task_id=any($2::uuid[])`,[actor.ownerId,ids])).rows:[]
   const runs=new Map<string,BusinessTaskProgress>(),completions=new Map<string,BusinessTaskCompletion>()
   for(const row of runRows){
    try{
     if(!uuid(row.task_id)||!uuid(row.id)||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(row.state)||row.stop_requested_at!==null&&!(row.stop_requested_at instanceof Date))throw Error()
     const evidence=row.evidence===null?null:runEvidence(row.evidence)
     if(['accepted','active','ended'].includes(row.state)?evidence?.state!==row.state:evidence!==null)throw Error()
     runs.set(row.task_id,{runId:row.id,state:row.state,reason:evidence?.state==='ended'?evidence.reason:null,stopRequestedAt:row.stop_requested_at?.toISOString()??null})
    }catch{throw corrupt()}
   }
   for(const row of completionRows){
    try{
     if(!uuid(row.task_id)||!uuid(row.artifact_id)||!Number.isSafeInteger(row.task_version)||!Number.isSafeInteger(row.artifact_version)||row.artifact_version<1||row.artifact_number!==row.artifact_version||!Number.isSafeInteger(row.current_version)||row.current_version<row.artifact_version||!(row.completed_at instanceof Date))throw Error()
     const source=savedArtifactSource(row.artifact_source),content=artifactContent(row.artifact_content)
     if(source.kind!=='task'||source.id!==row.task_id||source.scope!==scope)throw Error()
     completions.set(row.task_id,{artifactId:row.artifact_id,version:row.artifact_version,title:content.title,completedAt:row.completed_at.toISOString()})
    }catch{throw corrupt()}
   }
   const items:BusinessTaskListItem[]=[]
   for(const row of rows.slice(0,Number(limit))){
    const task=readStoredTask(row)
    if(task.ownerId!==actor.ownerId||task.scope!==scope)throw corrupt()
    const context=row.has_source?await this.row(db,actor.ownerId,task.id):null
    if(row.has_source&&!context||context&&(context.source.reference.scope!==scope||target&&(context.source.reference.type!==target.type||context.source.reference.id!==target.id)))throw corrupt()
    const {id,ownerId,title,version,state,assigneeRoleId,assigneeRoleVersion,createdAt,updatedAt}=task
    const progress=runs.get(id)??null,completion=completions.get(id)??null
    if(completion?(state!=='completed'||completionRows.find(candidate=>candidate.task_id===id)?.task_version!==version):state==='completed')throw corrupt()
    items.push({task:{id,ownerId,title,scope,version,state,assigneeRoleId,assigneeRoleVersion,createdAt,updatedAt},source:context?.source??null,progress,completion})
   }
   const last=items.at(-1),nextCursor=rows.length>Number(limit)&&last?Buffer.from(JSON.stringify([...key,last.task.createdAt,last.task.id])).toString('base64url'):undefined
   await db.query('commit');return {items,...(nextCursor?{nextCursor}:{})}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 async create(actor:BusinessTaskActor,input:unknown):Promise<BusinessTaskRecord>{
  actorIdentity(actor);const request=createInput(input)
  if(!actor.scopeIds.includes(request.reference.scope))throw new WorkError('teloa/forbidden','当前主体无权在此业务范围创建调查任务。')
  return this.createPrepared(actor,request)
 }
 /** 内部交办入口只接父身份；不接调用方的目标、负责人或对象引用。 */
 async createForConversation(actor:BusinessTaskActor,identity:unknown):Promise<BusinessTaskRecord>{
  actorIdentity(actor);return this.createPrepared(actor,undefined,identity)
 }
 async requestForConversation(actor:BusinessTaskActor,identity:unknown):Promise<WorkTask|null>{
  actorIdentity(actor);const db=await this.pool.connect()
  try{
   await db.query('begin');const fixed=await conversationTaskRequest(db,actor.ownerId,identity)
   if(!fixed.business)throw new WorkError('teloa/conflict','原交办没有固定业务对象来源。')
   if(!actor.scopeIds.includes(fixed.business.reference.scope))throw new WorkError('teloa/forbidden','当前主体无权读取原交办的业务来源。')
   const request=createInput(fixed.business),task=await this.tasks.requestForConversationInTransaction(db,actor.ownerId,fixed.identity)
   if(task){
    const prior=(await db.query('select task_id,request_spec=$3::jsonb same_request from teloa_business_task_sources where owner_id=$1 and request_id=$2',[actor.ownerId,request.requestId,JSON.stringify(request.spec)])).rows[0]
    if(!prior||prior.task_id!==task.id||!prior.same_request)throw new WorkError('teloa/conflict','原任务的固定业务来源与交办不一致。')
    const context=await this.row(db,actor.ownerId,task.id)
    if(!context||!sameReference(context.source.reference,request.reference))throw corrupt()
   }
   await db.query('commit');return task
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async createPrepared(actor:BusinessTaskActor,prepared:ReturnType<typeof createInput>|undefined,identity?:unknown):Promise<BusinessTaskRecord>{
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   const fixed=prepared?undefined:await conversationTaskRequest(client,actor.ownerId,identity)
   if(fixed&&!fixed.business)throw new WorkError('teloa/conflict','原交办没有固定业务对象来源。')
   const request=prepared??createInput(fixed!.business)
   if(!actor.scopeIds.includes(request.reference.scope))throw new WorkError('teloa/forbidden','当前主体无权在此业务范围创建调查任务。')
   const parent=await lockConversationTaskParent(client,actor.ownerId,request.requestId,fixed?.identity);await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/task-create',actor.ownerId,request.requestId])])
   const prior=(await client.query('select task_id,request_spec=$3::jsonb same_request from teloa_business_task_sources where owner_id=$1 and request_id=$2',[actor.ownerId,request.requestId,JSON.stringify(request.spec)])).rows[0]
   if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一请求不能创建不同的调查任务。');const context=await this.row(client,actor.ownerId,prior.task_id);const task=(await client.query('select * from teloa_tasks where id=$1 and owner_id=$2',[prior.task_id,actor.ownerId])).rows[0];if(!context||!task)throw corrupt();if(fixed){const receipt=await this.tasks.requestForConversationInTransaction(client,actor.ownerId,fixed.identity);if(!receipt||receipt.id!==prior.task_id||!sameReference(context.source.reference,request.reference))throw corrupt()}await client.query('commit');return {task:readStoredTask(task),source:context.source}}
   if((await client.query('select id from teloa_tasks where owner_id=$1 and request_id=$2',[actor.ownerId,request.requestId])).rows[0])throw new WorkError('teloa/conflict','该请求已被其他任务使用。')
   assertConversationTaskOpen(parent)
   const object=await this.fixedObject(client,actor.ownerId,request.reference,true),snapshot=object.object
   const resolved=request.actionId?await this.resolveAction(client,actor.ownerId,request.reference.scope,snapshot,request.actionId):undefined
   const task=fixed?await this.tasks.createForConversationInTransaction(client,actor.ownerId,fixed.identity):await this.tasks.createInTransaction(client,actor.ownerId,{requestId:request.requestId,fields:{title:resolved?resolved.template.title:request.title??taskTitle(snapshot.title),goal:request.goal,scope:request.reference.scope},...(request.assignee?{assignee:request.assignee}:{})})
   const createdAt=this.identity.now(),source:BusinessTaskSource={schema:'teloa.business-task-source/v1',taskId:task.id,ownerId:actor.ownerId,sourceId:object.sourceId,reference:request.reference,createdAssignee:request.assignee?{roleId:request.assignee.roleId,roleVersion:request.assignee.expectedVersion}:null,createdAt}
   await client.query(`insert into teloa_business_task_sources(task_id,owner_id,request_id,request_spec,scope_id,object_type,object_id,object_version,snapshot_hash,source_id,source_snapshot,snapshot_digest,created_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[task.id,actor.ownerId,request.requestId,JSON.stringify(request.spec),request.reference.scope,request.reference.type,request.reference.id,request.reference.version,request.reference.snapshotHash,object.sourceId,JSON.stringify(source),businessTaskSourceDigest(source),createdAt])
   if(resolved){
    const action:BusinessTaskActionSource={schema:'teloa.business-task-action-source/v1',taskId:task.id,ownerId:actor.ownerId,action:{id:resolved.record.definition.id,version:resolved.record.definition.version,definitionHash:resolved.record.source.definitionHash,source:resolved.record.source,title:resolved.record.definition.title,objectType:resolved.record.definition.objectType},template:resolved.template,inputs:resolved.inputs,createdAt}
    await client.query('insert into teloa_business_task_action_sources(task_id,owner_id,source_snapshot,snapshot_digest,created_at) values($1,$2,$3,$4,$5)',[task.id,actor.ownerId,JSON.stringify(action),businessTaskActionSourceDigest(action),createdAt])
   }
   await client.query('commit');return {task,source}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
}

function taskSpecGoal(value:unknown):unknown{return isRecord(value)&&isRecord(value.fields)?value.fields.goal:undefined}
function taskSpecAssignee(value:unknown):{roleId:string;expectedVersion:number}|null{return readStoredAssignee(isRecord(value)?value.assignee??null:undefined)}
function readStoredAssignee(value:unknown):{roleId:string;expectedVersion:number}|null{if(value===null)return null;if(!isRecord(value)||Object.keys(value).length!==2||Object.keys(value).some(key=>!['roleId','expectedVersion'].includes(key))||!uuid(value.roleId)||!Number.isSafeInteger(value.expectedVersion)||Number(value.expectedVersion)<1)throw Error();return {roleId:value.roleId,expectedVersion:value.expectedVersion as number}}
function sameReference(a:BusinessObjectReference,b:BusinessObjectReference):boolean{return a.scope===b.scope&&a.type===b.type&&a.id===b.id&&a.version===b.version&&a.snapshotHash===b.snapshotHash}
function sameAssignee(a:{roleId:string;expectedVersion:number}|null,b:{roleId:string;expectedVersion:number}|null):boolean{return a===null?b===null:b!==null&&a.roleId===b.roleId&&a.expectedVersion===b.expectedVersion}

function readActionSource(value:unknown):BusinessTaskActionSource{
 if(!isRecord(value)||Object.keys(value).length!==7||Object.keys(value).some(key=>!['schema','taskId','ownerId','action','template','inputs','createdAt'].includes(key))||value.schema!=='teloa.business-task-action-source/v1'||!uuid(value.taskId)||!text(value.ownerId,128)||!text(value.createdAt,64)||!Number.isFinite(Date.parse(value.createdAt))||!isRecord(value.action)||!isRecord(value.template)||!Array.isArray(value.inputs))throw Error()
 const action=value.action,template=value.template
 if(Object.keys(action).length!==6||Object.keys(action).some(key=>!['id','version','definitionHash','source','title','objectType'].includes(key))||!stable(action.id)||!text(action.version,80)||!/^[a-f0-9]{64}$/.test(String(action.definitionHash))||!text(action.title,120)||!stable(action.objectType)||!isRecord(action.source))throw Error()
 const definitionSource=action.source
 if(Object.keys(definitionSource).length!==8||Object.keys(definitionSource).some(key=>!['loadId','scope','localId','version','contentHash','fileHash','definitionHash','origin'].includes(key))||!text(definitionSource.loadId,120)||!text(definitionSource.scope,120)||definitionSource.scope==='general'||!stable(definitionSource.localId)||!text(definitionSource.version,80)||!/^[a-f0-9]{64}$/.test(String(definitionSource.contentHash))||!/^[a-f0-9]{64}$/.test(String(definitionSource.fileHash))||definitionSource.definitionHash!==action.definitionHash||!(definitionSource.origin==='template'||definitionSource.origin==='local'))throw Error()
 const fields=['loadId','itemInstanceId','itemLocalId','contentId','contentHash','templateId','templateVersion','fileHash','title','method','requirements','output','skills','scope']
 if(Object.keys(template).length!==fields.length||Object.keys(template).some(key=>!fields.includes(key))||!uuid(template.loadId)||!uuid(template.itemInstanceId)||!stable(template.itemLocalId)||!uuid(template.contentId)||!/^[a-f0-9]{64}$/.test(String(template.contentHash))||!stable(template.templateId)||!text(template.templateVersion,80)||!/^[a-f0-9]{64}$/.test(String(template.fileHash))||!text(template.title,120)||!text(template.method,2000)||!text(template.output,2000)||!text(template.scope,120)||template.scope==='general'||!Array.isArray(template.requirements)||template.requirements.length<1||template.requirements.length>100||template.requirements.some(item=>!text(item,500))||!Array.isArray(template.skills)||template.skills.length>100||template.skills.some(skill=>!isRecord(skill)||Object.keys(skill).length!==3||Object.keys(skill).some(key=>!['id','title','version'].includes(key))||!stable(skill.id)||!text(skill.title,120)||!text(skill.version,80)))throw Error()
 if(value.inputs.length!==template.requirements.length||value.inputs.some(item=>!text(item,4000)))throw Error()
 return {schema:'teloa.business-task-action-source/v1',taskId:value.taskId,ownerId:value.ownerId,action:{id:action.id,version:action.version,definitionHash:action.definitionHash as string,source:definitionSource as unknown as BusinessDefinitionSource,title:action.title,objectType:action.objectType},template:template as unknown as IndustryWorkSnapshot,inputs:[...value.inputs as string[]],createdAt:new Date(value.createdAt).toISOString()}
}

export function readBusinessTaskActionSource(row:Record<string,unknown>):BusinessTaskActionSource|undefined{
 try{
  if(row.action_source_snapshot===null||row.action_source_snapshot===undefined){if(row.action_snapshot_digest!==null&&row.action_snapshot_digest!==undefined||row.action_created_at!==null&&row.action_created_at!==undefined)throw Error();return undefined}
  const source=readActionSource(row.action_source_snapshot)
  if(!uuid(row.task_id)||row.task_id!==source.taskId||row.owner_id!==source.ownerId||row.action_snapshot_digest!==businessTaskActionSourceDigest(source)||!(row.action_created_at instanceof Date)||row.action_created_at.toISOString()!==source.createdAt)throw Error()
  return source
 }catch{throw corrupt()}
}

export function readBusinessTaskSource(row:Record<string,unknown>,action?:BusinessTaskActionSource):BusinessTaskSource{
  try{
   const source=row.source_snapshot
   if(!isRecord(source)||Object.keys(source).length!==7||Object.keys(source).some(key=>!['schema','taskId','ownerId','sourceId','reference','createdAssignee','createdAt'].includes(key))||source.schema!=='teloa.business-task-source/v1'||!uuid(source.taskId)||!text(source.ownerId,128)||!text(source.sourceId,businessMcpSourceIdMaxLength)||!text(source.createdAt,64)||!Number.isFinite(Date.parse(source.createdAt)))throw Error()
   const reference=businessObjectReference(source.reference),createdAssignee=source.createdAssignee===null?null:(()=>{if(!isRecord(source.createdAssignee)||Object.keys(source.createdAssignee).length!==2||!uuid(source.createdAssignee.roleId)||!Number.isSafeInteger(source.createdAssignee.roleVersion)||Number(source.createdAssignee.roleVersion)<1)throw Error();return {roleId:source.createdAssignee.roleId,roleVersion:source.createdAssignee.roleVersion as number}})()
   const parsed:BusinessTaskSource={schema:source.schema,taskId:source.taskId,ownerId:source.ownerId,sourceId:source.sourceId,reference,createdAssignee,createdAt:new Date(source.createdAt).toISOString()}
   if(!uuid(row.task_id)||row.task_id!==parsed.taskId||row.owner_id!==parsed.ownerId||!uuid(row.request_id)||row.scope_id!==reference.scope||row.object_type!==reference.type||row.object_id!==reference.id||row.object_version!==reference.version||row.snapshot_hash!==reference.snapshotHash||row.source_id!==parsed.sourceId||row.snapshot_digest!==businessTaskSourceDigest(parsed)||!(row.created_at instanceof Date)||row.created_at.toISOString()!==parsed.createdAt)throw Error()
   const stored=readBusinessObjectSnapshot(row.business_snapshot,reference.scope)
   if(stored.type!==reference.type||stored.id!==reference.id||stored.version!==reference.version||row.business_snapshot_hash!==reference.snapshotHash||businessObjectSnapshotHash(stored)!==reference.snapshotHash||row.business_source_id!==parsed.sourceId)throw Error()
   const taskSpec=row.task_request_spec,requestSpec=row.request_spec,actionId=isRecord(requestSpec)?requestSpec.actionId:undefined
   if(row.task_request_id!==row.request_id||!isRecord(requestSpec)||!([3,4].includes(Object.keys(requestSpec).length))||Object.keys(requestSpec).some(key=>!['reference','goal','assignee','actionId','title'].includes(key))||!isRecord(taskSpec)||Object.keys(taskSpec).length!==2||Object.keys(taskSpec).some(key=>!['fields','assignee'].includes(key))||!sameReference(businessObjectReference(requestSpec.reference),reference)||!text(requestSpec.goal,8000)||!sameAssignee(readStoredAssignee(requestSpec.assignee),taskSpecAssignee(taskSpec))||requestSpec.goal!==taskSpecGoal(taskSpec)||!isRecord(taskSpec.fields)||taskSpec.fields.scope!==reference.scope)throw Error()
   if(actionId===undefined){if(action||requestSpec.title!==undefined&&!text(requestSpec.title,120)||taskSpec.fields.title!==(requestSpec.title??taskTitle(stored.title)))throw Error()}
   else if(requestSpec.title!==undefined||!stable(actionId)||!text(taskSpec.fields.title,120)||(action&&(action.action.id!==actionId||action.template.scope!==reference.scope||taskSpec.fields.title!==action.template.title)))throw Error()
   return parsed
  }catch{throw corrupt()}
 }
