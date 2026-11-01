import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,readRunAnalysisScope,runAnalysisNotice,ownerTaskMemoryAnalysisNotice,type OwnerTaskRunAnalysisScope,type WorkTask,type DigitalRole,type WorkLineage} from '@teloa/contract'
import {TaskMaterialService} from './task-materials.ts'
import {readRunKnowledge,type RunKnowledge} from './task-run-knowledge.ts'
import {WorkLineageService} from './work-lineage.ts'

const hash=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const denied=()=>new WorkError('teloa/forbidden','独立分析只接受本人原任务、已授权固定资料和当前工作控制。')
const taskInput=(task:Pick<WorkTask,'id'|'version'|'title'|'goal'|'scope'>)=>({id:task.id,version:task.version,title:task.title,goal:task.goal,scope:task.scope})
const ownerLineage=(owner:string,taskId:string,lineage:WorkLineage)=>lineage.ownerId===owner&&lineage.rootTaskId===taskId&&lineage.parentRunId===null&&lineage.definition===null&&lineage.definitionControlId===null
async function source(db:PoolClient,owner:string,taskId:string){
 for(const table of ['teloa_group_task_sources','teloa_business_task_sources','teloa_industry_task_sources','teloa_plan_task_links']){
  if((await db.query('select to_regclass($1) as relation',[table])).rows[0]?.relation&&(await db.query(`select 1 from ${table} where owner_id=$1 and task_id=$2`,[owner,taskId])).rowCount)return undefined
 }
 const row=(await db.query('select t.request_id,t.request_spec,l.source from teloa_tasks t join teloa_task_work_lineage l on l.owner_id=t.owner_id and l.task_id=t.id where t.owner_id=$1 and t.id=$2 for share of t,l',[owner,taskId])).rows[0]
 if(!row||!isDeepStrictEqual(row.source,{kind:'owner-task',taskId}))return undefined
 return {requestId:row.request_id as string,digest:hash({requestId:row.request_id,request:row.request_spec,source:row.source})}
}
async function materials(db:PoolClient,owner:string,taskId:string,version:number){
 return (await db.query('select id,owner_id,task_id,task_version,resource_id,resource_version,snapshot from teloa_task_materials where task_id=$1 and task_version<=$2 order by created_at,id for share',[taskId,version])).rows.map(row=>{
  if(row.owner_id!==owner)throw denied()
  return row
 })
}
/** 仅在新准备中派生；本人原文可独立分析，附加资料仍沿正式服务验证归属、版本及撤回状态。 */
export async function deriveOwnerTaskAnalysisScope(db:PoolClient,pool:Pool,owner:string,task:WorkTask,role:DigitalRole,lineage:WorkLineage,knowledge:RunKnowledge[]):Promise<OwnerTaskRunAnalysisScope|undefined>{
 if(task.groupId!==null||!['employee','twin'].includes(role.kind)||!ownerLineage(owner,task.id,lineage))return undefined
 if(!(await db.query("select to_regclass('teloa_task_materials') as relation")).rows[0]?.relation)return undefined
 const origin=await source(db,owner,task.id);if(!origin)return undefined
 const refs=await new TaskMaterialService(pool,{id:()=>{throw denied()},now:()=>{throw denied()}}).executionRefsInTransaction(db,owner,task.id,task.version)
 const fixed=readRunKnowledge(knowledge),byId=new Map(fixed.map(item=>[item.id,item]))
 if(refs.some(ref=>byId.get(ref.id)?.version!==ref.version))throw denied()
 const saved=await materials(db,owner,task.id,task.version)
 if(saved.length!==refs.length||saved.some(row=>{const item=byId.get(row.resource_id);return !item||!isDeepStrictEqual(row.snapshot,{title:item.title,sourceId:item.sourceId,sourceVersion:item.sourceVersion,scopeIds:item.scopeIds})}))throw denied()
 const current=await new WorkLineageService(pool,{id:()=>{throw denied()},now:()=>{throw denied()}}).readInTransaction(db,owner,{taskId:task.id})
 if(!isDeepStrictEqual(current,lineage))throw denied()
 const controls=(await db.query('select id,state,generation from teloa_work_controls where owner_id=$1 and id=$2 for share',[owner,lineage.roundControlId])).rows
 if(controls.length!==1||controls[0].state!=='active'||controls[0].generation<lineage.controlGeneration)throw denied()
 // lineage保留创建时的归属世代；只有新prepare固定本人正常恢复后的当前active世代，旧Run不补权。
 return readRunAnalysisScope({schema:'teloa.run-analysis-scope/v1',kind:'owner-task-derived',ownerId:owner,taskId:task.id,taskVersion:task.version,roleId:role.id,roleVersion:role.version,requestId:origin.requestId,sourceDigest:origin.digest,materialsSha256:hash(saved),knowledgeSha256:hash(fixed),contextSha256:hash(taskInput(task)),lineageSha256:hash(lineage),controls:[{id:lineage.roundControlId,generation:controls[0].generation}],files:[],...(role.kind==='twin'?{selfAuthorizedTools:['teloa_role_memory_propose'],notice:ownerTaskMemoryAnalysisNotice}:{notice:runAnalysisNotice})}) as OwnerTaskRunAnalysisScope
}
export function assertOwnerTaskAnalysisContext(scope:OwnerTaskRunAnalysisScope,owner:string,task:Pick<WorkTask,'id'|'version'>,role:Pick<DigitalRole,'id'|'version'>,context:unknown,lineage:WorkLineage|undefined):void{
 const control=scope.controls[0]
 if(context!==undefined||scope.ownerId!==owner||scope.taskId!==task.id||scope.taskVersion!==task.version||scope.roleId!==role.id||scope.roleVersion!==role.version||!lineage||!ownerLineage(owner,task.id,lineage)||scope.lineageSha256!==hash(lineage)||scope.controls.length!==1||control?.id!==lineage.roundControlId||!Number.isSafeInteger(control.generation)||control.generation<lineage.controlGeneration)throw denied()
}
/** 快照与持久来源分开校验，读历史时不因后来的撤回而补权或改写原输入。 */
export function assertOwnerTaskAnalysisInput(scope:OwnerTaskRunAnalysisScope,task:Pick<WorkTask,'id'|'version'|'title'|'goal'|'scope'>,knowledge:RunKnowledge[]):void{
 if(scope.contextSha256!==hash(taskInput(task))||scope.knowledgeSha256!==hash(readRunKnowledge(knowledge)))throw denied()
}
export async function verifyOwnerTaskAnalysisScope(db:PoolClient,owner:string,scope:OwnerTaskRunAnalysisScope,lineage:WorkLineage|undefined):Promise<void>{
 assertOwnerTaskAnalysisContext(scope,owner,{id:scope.taskId,version:scope.taskVersion},{id:scope.roleId,version:scope.roleVersion},undefined,lineage)
 const origin=await source(db,owner,scope.taskId),fixed=await materials(db,owner,scope.taskId,scope.taskVersion)
 if(!origin||origin.requestId!==scope.requestId||origin.digest!==scope.sourceDigest||hash(fixed)!==scope.materialsSha256)throw denied()
}
