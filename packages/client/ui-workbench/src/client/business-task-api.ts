import {businessMcpSourceIdMaxLength,businessObjectReference,taskDefinition,taskInput,type BusinessLedgerBlock,type BusinessObjectReference,type WorkTask} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,payload:unknown)=>Promise<unknown>
type Assignee={roleId:string;expectedVersion:number}
export type BusinessTaskRequest={requestId:string;reference:BusinessObjectReference;goal:string;assignee?:Assignee;actionId?:string}
export type BusinessTaskSource={schema:'teloa.business-task-source/v1';taskId:string;ownerId:string;sourceId:string;reference:BusinessObjectReference;createdAssignee:{roleId:string;roleVersion:number}|null;createdAt:string}
export type BusinessTaskResult={task:WorkTask;source:BusinessTaskSource}
export type BusinessTaskJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}

/**
 * 业务页只展示服务端已经算为可用的默认动作。范围是否已登记、动作是否属于任务模板，
 * 都由台账与创建端点共同裁定；客户端不再维护任何行业或来源白名单。
 */
export function businessTaskSupports(scope:string,block:Pick<BusinessLedgerBlock,'defaultAction'>|undefined):boolean{
 return text(scope,120)&&scope!=='general'&&block?.defaultAction?.available===true
}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&new Date(value).toISOString()===value
const stable=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(value)
const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}
const sameReference=(left:BusinessObjectReference,right:BusinessObjectReference)=>left.scope===right.scope&&left.type===right.type&&left.id===right.id&&left.version===right.version&&left.snapshotHash===right.snapshotHash

function assignee(value:unknown):Assignee|undefined{
 if(value===undefined)return undefined
 const row=exact(value,['roleId','expectedVersion'])
 if(!uuid(row.roleId)||!positive(row.expectedVersion))throw Error()
 return {roleId:row.roleId,expectedVersion:row.expectedVersion as number}
}

function request(value:unknown):BusinessTaskRequest{
 try{
  const row=exact(value,['requestId','reference','goal','assignee','actionId'])
  if(!uuid(row.requestId)||!text(row.goal,8000))throw Error()
  const reference=businessObjectReference(row.reference)
  if(!text(reference.scope,120)||reference.scope==='general'||(row.actionId!==undefined&&!stable(row.actionId)))throw Error()
  const target=assignee(row.assignee),actionId=row.actionId as string|undefined
  return {requestId:row.requestId,reference,goal:row.goal,...(target?{assignee:target}:{}),...(actionId?{actionId}:{})}
 }catch{throw Error('调查任务创建请求格式不正确。')}
}

function task(value:unknown,expectedOwner:string):WorkTask{
 try{
  const row=taskInput(value,['id','ownerId','title','goal','scope','version','state','assigneeRoleId','assigneeRoleVersion','createdAt','updatedAt'].concat(['groupId','skills']))
  const {id,ownerId,version,state,assigneeRoleId,assigneeRoleVersion,createdAt,updatedAt,...definition}=row
  if(!uuid(id)||!text(ownerId,128)||!positive(version)||!['ready','running','paused','waiting','blocked','completed','cancelled'].includes(String(state))||!stamp(createdAt)||!stamp(updatedAt)||updatedAt<createdAt)throw Error()
  if(assigneeRoleId===null?assigneeRoleVersion!==null:!uuid(assigneeRoleId)||!positive(assigneeRoleVersion))throw Error()
  const parsed=taskDefinition(definition)
  if(parsed.title!==definition.title||parsed.goal!==definition.goal||parsed.scope!==definition.scope||ownerId!==expectedOwner)throw Error()
  return {...parsed,id,ownerId,version:version as number,state:state as WorkTask['state'],assigneeRoleId:assigneeRoleId===null?null:assigneeRoleId as string,assigneeRoleVersion:assigneeRoleVersion as number|null,createdAt,updatedAt}
 }catch{throw Error('调查任务格式不正确。')}
}

/** 来源由服务端固定；客户端只核对本人、引用与格式，不以静态行业表替代服务端授权。 */
export function readBusinessTaskSource(value:unknown,expectedOwner:string):BusinessTaskSource{
 try{
  const row=exact(value,['schema','taskId','ownerId','sourceId','reference','createdAssignee','createdAt'])
  const reference=businessObjectReference(row.reference)
  if(row.schema!=='teloa.business-task-source/v1'||!uuid(row.taskId)||!text(row.ownerId,128)||row.ownerId!==expectedOwner||!text(row.sourceId,businessMcpSourceIdMaxLength)||reference.scope==='general'||!stamp(row.createdAt))throw Error()
  let createdAssignee:BusinessTaskSource['createdAssignee']=null
  if(row.createdAssignee!==null){const target=exact(row.createdAssignee,['roleId','roleVersion']);if(!uuid(target.roleId)||!positive(target.roleVersion))throw Error();createdAssignee={roleId:target.roleId as string,roleVersion:target.roleVersion as number}}
  return {schema:'teloa.business-task-source/v1',taskId:row.taskId as string,ownerId:row.ownerId as string,sourceId:row.sourceId as string,reference,createdAssignee,createdAt:row.createdAt as string}
 }catch{throw Error('调查任务来源格式不正确。')}
}

function result(value:unknown,pending:BusinessTaskRequest,expectedOwner:string):BusinessTaskResult{
 try{
  const row=exact(value,['task','source']),savedTask=task(row.task,expectedOwner),savedSource=readBusinessTaskSource(row.source,expectedOwner),assigned=pending.assignee
  if(savedTask.id!==savedSource.taskId||savedTask.ownerId!==savedSource.ownerId||savedTask.scope!==pending.reference.scope||!sameReference(savedSource.reference,pending.reference)||(savedTask.version===1&&savedTask.goal!==pending.goal))throw Error()
  if(assigned===undefined){if(savedSource.createdAssignee!==null||(savedTask.version===1&&(savedTask.assigneeRoleId!==null||savedTask.assigneeRoleVersion!==null)))throw Error()}
  else if(savedSource.createdAssignee?.roleId!==assigned.roleId||savedSource.createdAssignee?.roleVersion!==assigned.expectedVersion||(savedTask.version===1&&(savedTask.assigneeRoleId!==assigned.roleId||savedTask.assigneeRoleVersion!==assigned.expectedVersion)))throw Error()
  return {task:savedTask,source:savedSource}
 }catch{throw Error('调查任务响应与固定业务对象、负责人或来源不一致。')}
}

const noSideEffect=(error:unknown)=>error!==null&&typeof error==='object'&&'rejected' in error&&error.rejected===true&&'code' in error&&['teloa/invalid-input','teloa/forbidden','teloa/version-conflict','teloa/source-unavailable','teloa/conflict'].includes(String(error.code))

export function createBusinessTaskApi(call:Call,journal:BusinessTaskJournal|undefined,expectedOwner:string='local:teloa-owner'){
 if(!text(expectedOwner,128))throw Error('调查任务本人身份不正确。')
 let pending:BusinessTaskRequest|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>100000)throw Error();const row=exact(JSON.parse(raw),['schema','request']);if(row.schema!=='teloa.business-task/v1')throw Error();pending=request(row.request)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{
  if(recoveryError)throw recoveryError
  if(!pending)throw Error('没有待核对的调查任务创建请求。')
  if(busy)throw Error('调查任务正在核对。')
  busy=true
  try{
   journal?.write(JSON.stringify({schema:'teloa.business-task/v1',request:pending}))
   let value:unknown
   try{value=await call('business-tasks/create',pending)}catch(error){if(noSideEffect(error)){journal?.clear();pending=undefined}throw error}
   const created=result(value,pending,expectedOwner)
   journal?.clear();pending=undefined
   return created
  }finally{busy=false}
 }
 return {
  pending:()=>pending?structuredClone(pending):undefined,
  recoveryMessage:()=>recoveryError,
  // 丢弃只清本地记录，不通知服务端：requestId 一丢就没有可靠的撤销面了（规格 §二 D4）。
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:send,
  async create(value:BusinessTaskRequest){const normalized=request(value);if(recoveryError)throw recoveryError;if(pending&&JSON.stringify(pending)!==JSON.stringify(normalized))throw Error('上次调查任务创建结果尚待核对，请先恢复原请求。');pending??=normalized;return send()},
  async source(taskId:string){if(!uuid(taskId))throw Error('任务身份不正确。');const saved=await call('business-tasks/source',{taskId});if(saved===null)return null;const value=readBusinessTaskSource(saved,expectedOwner);if(value.taskId!==taskId)throw Error('调查任务来源与目标任务不一致。');return value},
}
}

export type BusinessTaskApi=ReturnType<typeof createBusinessTaskApi>
