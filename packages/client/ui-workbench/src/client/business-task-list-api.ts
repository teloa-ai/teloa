import {businessObjectReference,isBusinessScopeKey,workTaskStates,type WorkTask} from '@teloa/contract'
import {readBusinessTaskSource,type BusinessTaskSource} from './business-task-api.ts'

export type BusinessTaskSummary=Pick<WorkTask,'id'|'ownerId'|'title'|'scope'|'version'|'state'|'assigneeRoleId'|'assigneeRoleVersion'|'createdAt'|'updatedAt'>
export type BusinessTaskProgress={runId:string;state:'prepared'|'submitting'|'accepted'|'active'|'ended'|'withdrawn'|'configuration_failed';reason:string|null;stopRequestedAt:string|null}
export type BusinessTaskCompletion={artifactId:string;version:number;title:string;completedAt:string}
export type BusinessTaskListItem={task:BusinessTaskSummary;source:BusinessTaskSource|null;progress:BusinessTaskProgress|null;completion:BusinessTaskCompletion|null}
export type BusinessTaskListPage={items:BusinessTaskListItem[];nextCursor?:string}
export type BusinessTaskListQuery={scope:string;object?:{type:string;id:string};limit?:number;cursor?:string}
type Call=(endpoint:string,payload:unknown,signal?:AbortSignal)=>Promise<unknown>
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const invalid=()=>Error('业务任务目录与当前本人、业务或对象不一致。')
function progress(value:unknown):BusinessTaskProgress|null{
 if(value===null)return null
 const row=exact(value,['runId','state','reason','stopRequestedAt'])
 if(!uuid(row.runId)||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(row.state as string)||(row.state==='ended'?!text(row.reason,128):row.reason!==null)||(row.stopRequestedAt!==null&&!stamp(row.stopRequestedAt)))throw invalid()
 return row as BusinessTaskProgress
}
function completion(value:unknown,task:BusinessTaskSummary):BusinessTaskCompletion|null{
 if(value===null){if(task.state==='completed')throw invalid();return null}
 const row=exact(value,['artifactId','version','title','completedAt'])
 if(task.state!=='completed'||!uuid(row.artifactId)||!positive(row.version)||!text(row.title,200)||!stamp(row.completedAt))throw invalid()
 return row as BusinessTaskCompletion
}
function exact(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value)||required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw invalid()
 return value as Record<string,unknown>
}

/** 只读目录。本人来自当前宿主装配；切换宿主或本人时必须重建本实例。 */
export function createBusinessTaskListApi(call:Call,expectedOwner:string){
 if(!text(expectedOwner,128))throw invalid()
 return {async list(query:BusinessTaskListQuery,signal?:AbortSignal):Promise<BusinessTaskListPage>{
  const input=exact(query,['scope'],['object','limit','cursor']),scope=input.scope,limit=input.limit===undefined?20:input.limit,cursor=input.cursor
  if(!isBusinessScopeKey(scope)||scope==='general'||!Number.isInteger(limit)||Number(limit)<1||Number(limit)>50||(cursor!==undefined&&!text(cursor,2048)))throw invalid()
  let object:{type:string;id:string}|undefined
  if(input.object!==undefined){
   const row=exact(input.object,['type','id']),reference=businessObjectReference({scope,type:row.type,id:row.id,version:1,snapshotHash:'0'.repeat(64)})
   object={type:reference.type,id:reference.id}
  }
  const payload={scope,...object,limit,...(cursor!==undefined?{cursor}:{})}
  const response=exact(await call(object?'business-tasks/list-for-object':'business-tasks/list-for-scope',payload,signal),['items'],['nextCursor'])
  if(!Array.isArray(response.items)||response.items.length>Number(limit)||(response.nextCursor!==undefined&&(!text(response.nextCursor,2048)||response.items.length===0)))throw invalid()
  const seen=new Set<string>(),items=response.items.map(value=>{
   const item=exact(value,['task','source','progress','completion']),task=exact(item.task,['id','ownerId','title','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'])
   if(!uuid(task.id)||task.ownerId!==expectedOwner||task.scope!==scope||!text(task.title,120)||!positive(task.version)||!workTaskStates.some(state=>state===task.state)||!stamp(task.createdAt)||!stamp(task.updatedAt)||task.updatedAt<task.createdAt||(task.assigneeRoleId===null?task.assigneeRoleVersion!==null:!uuid(task.assigneeRoleId)||!positive(task.assigneeRoleVersion)))throw invalid()
   const source=item.source===null?null:readBusinessTaskSource(item.source,expectedOwner),id=task.id.toLowerCase()
   if(seen.has(id)||(source&&(source.taskId.toLowerCase()!==id||source.reference.scope!==scope))||(object&&(!source||source.reference.type!==object.type||source.reference.id!==object.id)))throw invalid()
   seen.add(id)
   const summary=structuredClone(task) as BusinessTaskSummary
   return {task:summary,source,progress:progress(item.progress),completion:completion(item.completion,summary)}
  })
  return {items,...(response.nextCursor!==undefined?{nextCursor:response.nextCursor as string}:{})}
 }}
}
export type BusinessTaskListApi=ReturnType<typeof createBusinessTaskListApi>
