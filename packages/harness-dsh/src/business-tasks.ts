import {WorkError,businessMcpSourceIdMaxLength,businessObjectReference,isBusinessScopeKey,isRecord,taskDefinition,taskInput,workTaskStates,type BusinessObjectReference,type WorkTask} from '@teloa/contract'
import type {BusinessObjectSnapshot,BusinessTaskActionSource,BusinessTaskRecord,BusinessTaskListItem,BusinessTaskListPage,BusinessTaskService,BusinessTaskSource} from '@teloa/backend'

export const businessTaskEndpoints=['business-tasks/create','business-tasks/source','business-tasks/list-for-scope','business-tasks/list-for-object'] as const
/** 通用工作范围，不是业务范围：业务对象、业务任务来源都不会登记在它下面。 */
const generalScope='general'
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const sourceId=(value:unknown):value is string=>text(value,businessMcpSourceIdMaxLength)
const invalid=()=>new WorkError('teloa/invalid-host-response','调查任务回包的本人、范围或固定来源不一致。')
const exact=(value:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>=>{if(!isRecord(value)||keys.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!keys.includes(key)&&!optional.includes(key)))throw invalid();return value}

function sameReference(a:BusinessObjectReference,b:BusinessObjectReference):boolean{return a.scope===b.scope&&a.type===b.type&&a.id===b.id&&a.version===b.version&&a.snapshotHash===b.snapshotHash}

/**
 * 一键执行与持续计划派发在准备 Run 时都会问一次业务依据。
 * 业务任务来源只登记在真实业务范围里；`general`（通用工作）从来没有，而业务服务的身份闸
 * 明确拒绝 `general`，直接拿它去问会以 `teloa/forbidden` 把整次执行准备一起带失败。
 * 因此通用工作在问之前就按"没有业务依据"收口。
 */
export async function readRunBusinessTaskContext(
 owner:string,
 task:Pick<WorkTask,'id'|'scope'>,
 read:(actor:{ownerId:string;scopeIds:string[]},input:{taskId:string})=>Promise<{source:BusinessTaskSource;object:BusinessObjectSnapshot;action?:BusinessTaskActionSource}|null>,
):Promise<{taskId:string;sourceId:string;object:BusinessObjectSnapshot;action?:BusinessTaskActionSource}|undefined>{
 if(task.scope===generalScope)return undefined
 const context=await read({ownerId:owner,scopeIds:[task.scope]},{taskId:task.id})
 return context?{taskId:context.source.taskId,sourceId:context.source.sourceId,object:context.object,...(context.action?{action:context.action}:{})}:undefined
}

/**
 * 来源身份由后端从固定对象快照的 `source_id` 取回并与快照核对；Harness 只核对它属于已授权范围，
 * 不能再拿某个行业示例的数据源名冒充所有对象类型的来源判据。
 */
function readSource(value:unknown,owner:string,scopeIds:readonly string[]):BusinessTaskSource{
 const row=exact(value,['schema','taskId','ownerId','sourceId','reference','createdAssignee','createdAt'])
 let reference:BusinessObjectReference
 try{reference=businessObjectReference(row.reference)}catch{throw invalid()}
 if(row.schema!=='teloa.business-task-source/v1'||!uuid(row.taskId)||row.ownerId!==owner||!sourceId(row.sourceId)||!scopeIds.includes(reference.scope)||!stamp(row.createdAt))throw invalid()
 let createdAssignee:BusinessTaskSource['createdAssignee']=null
 if(row.createdAssignee!==null){const assignee=exact(row.createdAssignee,['roleId','roleVersion']);if(!uuid(assignee.roleId)||!positive(assignee.roleVersion))throw invalid();createdAssignee={roleId:assignee.roleId,roleVersion:assignee.roleVersion}}
 return {schema:'teloa.business-task-source/v1',taskId:row.taskId,ownerId:owner,sourceId:row.sourceId,reference,createdAssignee,createdAt:row.createdAt}
}

function readTask(value:unknown,owner:string):WorkTask{
 const row=exact(value,['id','ownerId','title','goal','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'],['groupId','skills'])
 let definition:ReturnType<typeof taskDefinition>
 try{definition=taskDefinition({title:row.title,goal:row.goal,scope:row.scope,groupId:row.groupId,skills:row.skills})}catch{throw invalid()}
 if(!uuid(row.id)||row.ownerId!==owner||definition.title!==row.title||definition.goal!==row.goal||definition.scope!==row.scope||!positive(row.version)||!workTaskStates.some(state=>state===row.state)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt||(row.assigneeRoleId===null?row.assigneeRoleVersion!==null:!uuid(row.assigneeRoleId)||!positive(row.assigneeRoleVersion)))throw invalid()
 return {...definition,id:row.id,ownerId:owner,version:row.version,state:row.state as WorkTask['state'],assigneeRoleId:row.assigneeRoleId as string|null,assigneeRoleVersion:row.assigneeRoleVersion as number|null,createdAt:row.createdAt,updatedAt:row.updatedAt}
}

function readSummary(value:unknown,owner:string,scope:string):BusinessTaskListItem['task']{
 const row=exact(value,['id','ownerId','title','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'])
 if(!uuid(row.id)||row.ownerId!==owner||row.scope!==scope||!text(row.title,120)||!positive(row.version)||!workTaskStates.some(state=>state===row.state)||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt||(row.assigneeRoleId===null?row.assigneeRoleVersion!==null:!uuid(row.assigneeRoleId)||!positive(row.assigneeRoleVersion)))throw invalid()
 return row as BusinessTaskListItem['task']
}
function readProgress(value:unknown):BusinessTaskListItem['progress']{
 if(value===null)return null
 const row=exact(value,['runId','state','reason','stopRequestedAt'])
 if(!uuid(row.runId)||!['prepared','submitting','accepted','active','ended','withdrawn','configuration_failed'].includes(row.state as string)||(row.state==='ended'?!text(row.reason,128):row.reason!==null)||(row.stopRequestedAt!==null&&!stamp(row.stopRequestedAt)))throw invalid()
 return row as BusinessTaskListItem['progress']
}
function readCompletion(value:unknown,task:BusinessTaskListItem['task']):BusinessTaskListItem['completion']{
 if(value===null){if(task.state==='completed')throw invalid();return null}
 const row=exact(value,['artifactId','version','title','completedAt'])
 if(task.state!=='completed'||!uuid(row.artifactId)||!positive(row.version)||!text(row.title,200)||!stamp(row.completedAt))throw invalid()
 return row as BusinessTaskListItem['completion']
}

export function createBusinessTaskHandler(owner:string,scopeIds:()=>Promise<readonly string[]>,get:()=>Promise<Pick<BusinessTaskService,'create'|'source'|'listForScope'|'listForObject'>>){
 const actor=async()=>{
  const scopes=[...await scopeIds()]
  if(!scopes.length||new Set(scopes).size!==scopes.length||scopes.some(scope=>!text(scope,120)||scope===generalScope))throw new WorkError('teloa/forbidden','当前主体未获准有效的业务范围。')
  return {ownerId:owner,scopeIds:scopes}
 }
 return async(endpoint:string,payload:unknown):Promise<BusinessTaskRecord|BusinessTaskSource|BusinessTaskListPage|null>=>{
  if(!businessTaskEndpoints.some(value=>value===endpoint))throw new WorkError('teloa/not-found','未提供此业务对象任务接口。')
  if(!text(owner,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')
  const principal=await actor()
  const service=await get()
  if(endpoint==='business-tasks/list-for-scope'||endpoint==='business-tasks/list-for-object'){
   const object=endpoint==='business-tasks/list-for-object',input=taskInput(payload,object?['scope','type','id','limit','cursor']:['scope','limit','cursor'])
   if(!isBusinessScopeKey(input.scope)||input.scope===generalScope||(input.limit!==undefined&&(!Number.isSafeInteger(input.limit)||Number(input.limit)<1||Number(input.limit)>50))||(input.cursor!==undefined&&!text(input.cursor,2048)))throw new WorkError('teloa/invalid-input','业务任务目录的范围或分页参数不正确。')
   if(!principal.scopeIds.includes(input.scope))throw new WorkError('teloa/forbidden','当前宿主未授权此业务范围。')
   if(object)businessObjectReference({scope:input.scope,type:input.type,id:input.id,version:1,snapshotHash:'0'.repeat(64)})
   const scoped={ownerId:owner,scopeIds:[input.scope]},response=exact(await (object?service.listForObject(scoped,payload):service.listForScope(scoped,payload)),['items'],['nextCursor'])
   if(!Array.isArray(response.items)||response.items.length>Number(input.limit??20)||(response.nextCursor!==undefined&&(!text(response.nextCursor,2048)||!response.items.length)))throw invalid()
   const seen=new Set<string>(),items=response.items.map(value=>{
    const item=exact(value,['task','source','progress','completion']),task=readSummary(item.task,owner,input.scope as string),source=item.source===null?null:readSource(item.source,owner,[input.scope as string]),progress=readProgress(item.progress),completion=readCompletion(item.completion,task)
    if(seen.has(task.id.toLowerCase())||(source&&source.taskId.toLowerCase()!==task.id.toLowerCase())||(object&&(!source||source.reference.type!==input.type||source.reference.id!==input.id)))throw invalid()
    seen.add(task.id.toLowerCase());return {task,source,progress,completion}
   })
   return {items,...(response.nextCursor!==undefined?{nextCursor:response.nextCursor as string}:{})}
  }
  if(endpoint==='business-tasks/source'){
   const input=taskInput(payload,['taskId']);if(!uuid(input.taskId))throw new WorkError('teloa/invalid-input','任务身份不正确。')
   const response=await service.source(principal,payload);if(response===null)return null
   const source=readSource(response,owner,principal.scopeIds);if(source.taskId.toLowerCase()!==input.taskId.toLowerCase())throw invalid();return source
  }
  const input=taskInput(payload,['requestId','reference','goal','assignee','actionId','title'])
  if(!uuid(input.requestId)||!text(input.goal,8000)||(input.title!==undefined&&(!text(input.title,120)||input.actionId!==undefined)))throw new WorkError('teloa/invalid-input','调查任务的请求身份或目标不正确。')
  let reference:BusinessObjectReference
  try{reference=businessObjectReference(input.reference)}catch(error){if(error instanceof WorkError)throw error;throw new WorkError('teloa/invalid-input','业务对象引用不正确。')}
  if(!principal.scopeIds.includes(reference.scope))throw new WorkError('teloa/forbidden','当前宿主未授权此业务范围。')
  let requestedAssignee:{roleId:string;expectedVersion:number}|null=null
  if(input.assignee!==undefined){const assignee=taskInput(input.assignee,['roleId','expectedVersion']);if(!uuid(assignee.roleId)||!positive(assignee.expectedVersion))throw new WorkError('teloa/invalid-input','负责人身份或版本不合法。');requestedAssignee={roleId:assignee.roleId.toLowerCase(),expectedVersion:assignee.expectedVersion}}
  const response=exact(await service.create(principal,payload),['task','source']),task=readTask(response.task,owner),source=readSource(response.source,owner,principal.scopeIds)
  if((input.title!==undefined&&task.title!==input.title)||task.id.toLowerCase()!==source.taskId.toLowerCase()||task.scope!==reference.scope||!sameReference(source.reference,reference)||(requestedAssignee===null?source.createdAssignee!==null:source.createdAssignee===null||source.createdAssignee.roleId.toLowerCase()!==requestedAssignee.roleId||source.createdAssignee.roleVersion!==requestedAssignee.expectedVersion)||(source.createdAssignee===null?task.assigneeRoleId!==null||task.assigneeRoleVersion!==null:task.assigneeRoleId?.toLowerCase()!==source.createdAssignee.roleId.toLowerCase()||task.assigneeRoleVersion!==source.createdAssignee.roleVersion))throw invalid()
  return {task,source}
 }
}
