import type {Pool,PoolClient} from 'pg'
import {
 WorkError,
 isResourceSpec,
 isTaskMaterialAddInput,
 isTaskMaterialList,
 isTaskMaterialRef,
 isTaskMaterialResult,
 resourceId,
 resourceVersion,
 type ResourceReference,
 type ResourceSpec,
 type TaskMaterialAddInput,
 type TaskMaterialRef,
 type TaskMaterialResult,
} from '@teloa/contract'
import {readStoredTask} from './tasks.ts'

const editableStates=['ready','paused','blocked','waiting'] as const
const bad=()=>new WorkError('teloa/invalid-input','任务知识请求格式不正确或包含未知字段。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','任务知识记录损坏，已停止读取。')
const stable=(value:unknown):unknown=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([left],[right])=>left.localeCompare(right)).map(([key,item])=>[key,stable(item)])):value
const same=(left:unknown,right:unknown)=>JSON.stringify(stable(left))===JSON.stringify(stable(right))
function actor(owner:string){if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
function stamp(value:unknown):string{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
function request(input:unknown):TaskMaterialAddInput{if(!isTaskMaterialAddInput(input))throw bad();return {...input,requestId:input.requestId.toLowerCase(),taskId:input.taskId.toLowerCase(),resourceId:input.resourceId.toLowerCase()}}
function snapshot(value:unknown):ResourceSpec{if(!isResourceSpec(value)||Object.keys(value).length!==4||Object.keys(value).some(key=>!['title','sourceId','sourceVersion','scopeIds'].includes(key)))throw corrupt();return {title:value.title.trim(),sourceId:value.sourceId,sourceVersion:value.sourceVersion,scopeIds:[...value.scopeIds]}}
function resource(row:Record<string,unknown>):ResourceSpec&{id:string;ownerId:string;version:number;status:'active'|'withdrawn'}{
 const spec=snapshot(row.spec)
 if(!resourceId(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!resourceVersion(row.revision)||!['active','withdrawn'].includes(String(row.status)))throw corrupt()
 return {...spec,id:row.id,ownerId:row.owner_id,version:row.revision as number,status:row.status as 'active'|'withdrawn'}
}
function material(row:Record<string,unknown>,available:boolean,owner?:string):TaskMaterialRef{
 if(owner!==undefined&&row.owner_id!==owner)throw corrupt()
 const spec=snapshot(row.snapshot)
 const value={...spec,id:row.id,taskId:row.task_id,taskVersion:row.task_version,resourceId:row.resource_id,resourceVersion:row.resource_version,available,createdAt:stamp(row.created_at)}
 if(!isTaskMaterialRef(value))throw corrupt()
 return value
}
function currentMatches(row:Record<string,unknown>,fixed:ResourceSpec):boolean{
 const value=resource(row);return value.status==='active'&&value.version===row.resource_version&&same({title:value.title,sourceId:value.sourceId,sourceVersion:value.sourceVersion,scopeIds:value.scopeIds},fixed)
}

export async function initializeTaskMaterials(pool:Pool):Promise<void>{
 await pool.query(`
  create table if not exists teloa_task_materials(
   id uuid primary key,owner_id text not null,task_id uuid not null references teloa_tasks(id),task_version integer not null check(task_version>1),
   resource_id uuid not null references teloa_resources(id),resource_version integer not null check(resource_version>0),
   snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),created_at timestamptz not null,
   unique(task_id,resource_id),unique(task_id,task_version)
  );
  create table if not exists teloa_task_material_requests(
   owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
   task_id uuid not null references teloa_tasks(id),material_id uuid not null references teloa_task_materials(id),
   result jsonb not null check(jsonb_typeof(result)='object'),created_at timestamptz not null,primary key(owner_id,request_id)
  );
 `)
}

export class TaskMaterialService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string}){this.pool=pool;this.identity=identity}
 private async tx<T>(operation:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect().catch(()=>{throw new WorkError('teloa/storage-unavailable','任务知识数据库暂不可用。')})
  try{await db.query('begin');const result=await operation(db);await db.query('commit');return result}catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 private async recover(db:PoolClient,owner:string,row:Record<string,unknown>):Promise<TaskMaterialResult>{
  if(!isTaskMaterialResult(row.result)||row.result.task.ownerId!==owner||row.result.task.id!==row.task_id||row.result.material.id!==row.material_id||row.result.material.taskId!==row.task_id)throw corrupt()
  const stored=(await db.query('select * from teloa_task_materials where id=$1',[row.material_id])).rows[0] as Record<string,unknown>|undefined
  if(!stored)throw corrupt()
  const fixed=material(stored,true,owner)
  if(!same(fixed,row.result.material))throw corrupt()
  return row.result
 }
 async list(owner:string,input:unknown):Promise<TaskMaterialRef[]>{
  actor(owner)
  if(typeof input!=='object'||input===null||Array.isArray(input)||Object.keys(input).length!==1||!Object.hasOwn(input,'taskId')||!resourceId((input as {taskId?:unknown}).taskId))throw bad()
  const taskId=(input as {taskId:string}).taskId.toLowerCase()
  return this.tx(async db=>{
   const taskRow=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2',[owner,taskId])).rows[0]
   if(!taskRow)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(taskRow)
   const rows=await db.query(`select m.*,r.owner_id resource_owner_id,r.revision current_resource_version,r.status resource_status,r.spec resource_spec
    from teloa_task_materials m left join teloa_resources r on r.id=m.resource_id where m.task_id=$1 order by m.created_at,m.id`,[taskId])
   const items=rows.rows.map(row=>{
    const fixed=snapshot(row.snapshot),current={id:row.resource_id,owner_id:row.resource_owner_id,revision:row.current_resource_version,status:row.resource_status,spec:row.resource_spec,resource_version:row.resource_version}
    const saved=material(row,row.resource_owner_id===owner&&currentMatches(current,fixed),owner)
    if(saved.taskVersion>task.version)throw corrupt()
    return saved
   })
   if(!isTaskMaterialList(items))throw corrupt()
   return items
  })
 }
 async add(owner:string,input:unknown):Promise<TaskMaterialResult>{
  actor(owner);const value=request(input),spec=JSON.stringify(value)
  return this.tx(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-material-request',owner,value.requestId])])
   const previous=(await db.query('select *,request_spec=$3::jsonb same_request from teloa_task_material_requests where owner_id=$1 and request_id=$2',[owner,value.requestId,spec])).rows[0]
   if(previous){if(previous.same_request!==true)throw new WorkError('teloa/conflict','同一请求 ID 已添加其他任务知识。');return this.recover(db,owner,previous)}
   const taskRow=(await db.query('select * from teloa_tasks where id=$1 for update',[value.taskId])).rows[0]
   if(!taskRow||taskRow.owner_id!==owner)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
   const task=readStoredTask(taskRow)
   if(task.version!==value.expectedTaskVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，请刷新后重新选择知识。')
   if(!editableStates.some(state=>state===task.state))throw new WorkError('teloa/conflict','当前任务状态不能添加任务知识。')
   if((await db.query("select id from teloa_task_runs where owner_id=$1 and task_id=$2 and state not in ('ended','withdrawn','configuration_failed') limit 1",[owner,task.id])).rows[0])throw new WorkError('teloa/conflict','任务仍有未结束的执行，不能修改任务知识。')
   const resourceRow=(await db.query('select * from teloa_resources where id=$1 for share',[value.resourceId])).rows[0]
   if(!resourceRow||resourceRow.owner_id!==owner)throw new WorkError('teloa/forbidden','工作资料不存在或不属于本人。')
   const selected=resource(resourceRow)
   if(selected.status!=='active')throw new WorkError('teloa/resource-withdrawn','知识已撤回，请重新选择。')
   if(selected.version!==value.expectedResourceVersion)throw new WorkError('teloa/version-conflict','知识版本已变化，请刷新后重新选择。')
   // 项目引用不改变此处范围判定；见 2026-09-25 计划 功能验证。
   if(!selected.scopeIds.every(scope=>scope===task.scope))throw new WorkError('teloa/forbidden','当前任务业务范围无权使用这份知识。')
   if((await db.query('select id from teloa_task_materials where task_id=$1 and resource_id=$2',[task.id,selected.id])).rows[0])throw new WorkError('teloa/conflict','这份知识已加入当前任务。')
   const now=this.identity.now(),id=this.identity.id(),fixed={title:selected.title,sourceId:selected.sourceId,sourceVersion:selected.sourceVersion,scopeIds:selected.scopeIds}
   const updated=readStoredTask((await db.query('update teloa_tasks set version=version+1,updated_at=$3 where owner_id=$1 and id=$2 returning *',[owner,task.id,now])).rows[0])
   await db.query('insert into teloa_task_materials(id,owner_id,task_id,task_version,resource_id,resource_version,snapshot,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[id,owner,task.id,updated.version,selected.id,selected.version,JSON.stringify(fixed),now])
   const savedMaterial=material((await db.query('select * from teloa_task_materials where id=$1',[id])).rows[0],true,owner),result={task:updated,material:savedMaterial}
   if(!isTaskMaterialResult(result))throw corrupt()
   await db.query('insert into teloa_task_material_requests(owner_id,request_id,request_spec,task_id,material_id,result,created_at) values($1,$2,$3,$4,$5,$6,$7)',[owner,value.requestId,spec,task.id,id,JSON.stringify(result),now])
   return result
  })
 }
 async executionRefsInTransaction(db:PoolClient,owner:string,taskId:string,expectedTaskVersion:number):Promise<ResourceReference[]>{
  actor(owner);if(!resourceId(taskId)||!resourceVersion(expectedTaskVersion))throw bad()
  const taskRow=(await db.query('select * from teloa_tasks where id=$1 for share',[taskId])).rows[0]
  if(!taskRow||taskRow.owner_id!==owner)throw new WorkError('teloa/forbidden','任务不存在或不属于本人。')
  const task=readStoredTask(taskRow)
  if(task.version!==expectedTaskVersion)throw new WorkError('teloa/version-conflict','任务版本已变化，不能准备旧任务知识。')
  const rows=await db.query('select * from teloa_task_materials where task_id=$1 order by created_at,id',[task.id])
  const fixed=rows.rows.map(row=>material(row,true,owner))
  if(!isTaskMaterialList(fixed)||fixed.some(item=>item.taskVersion>expectedTaskVersion))throw corrupt()
  const byResource=new Map(fixed.map(item=>[item.resourceId,item]))
  const resources=new Map<string,ReturnType<typeof resource>>()
  for(const id of [...byResource.keys()].sort()){
   const row=(await db.query('select * from teloa_resources where id=$1 for share',[id])).rows[0]
   if(!row||row.owner_id!==owner)throw corrupt()
   resources.set(id,resource(row))
  }
  return fixed.map(item=>{
   const current=resources.get(item.resourceId)!
   if(current.status!=='active')throw new WorkError('teloa/resource-withdrawn','任务知识已撤回，请重新选择。')
   if(current.version!==item.resourceVersion||!same({title:current.title,sourceId:current.sourceId,sourceVersion:current.sourceVersion,scopeIds:current.scopeIds},{title:item.title,sourceId:item.sourceId,sourceVersion:item.sourceVersion,scopeIds:item.scopeIds}))throw new WorkError('teloa/version-conflict','任务知识固定版本已变化，请重新选择。')
   if(!current.scopeIds.every(scope=>scope===task.scope))throw new WorkError('teloa/forbidden','任务业务范围无权继续使用固定知识。')
   return {id:item.resourceId,version:item.resourceVersion}
  })
 }
 async executionRefs(owner:string,taskId:string,expectedTaskVersion:number):Promise<ResourceReference[]>{return this.tx(db=>this.executionRefsInTransaction(db,owner,taskId,expectedTaskVersion))}
}
