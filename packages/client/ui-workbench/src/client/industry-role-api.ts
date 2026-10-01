import {roleDefinition,roleInput,type DigitalRole} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(method:string,payload:unknown)=>Promise<unknown>
const requestError=(code:string,message:string,cause?:unknown)=>Object.assign(Error(message),{code,...(cause===undefined?{}:{cause})})
export type IndustryRoleRequest={requestId:string;loadId:string;itemInstanceId:string}
export type IndustryRoleInstance={id:string;ownerId:string;loadId:string;itemInstanceId:string;itemLocalId:string;scope:string;definitionHash:string;revision:number;state:'pending'|'paused'|'active'|'retired'|'failed';role:DigitalRole|null;knowledge:Array<{itemInstanceId:string;instanceId:string;resourceId:string;resourceVersion:number}>;omittedKnowledge:Array<{itemInstanceId:string;reason:'not-instantiated'|'pending'|'failed'|'withdrawn'|'skipped'}>;declarations:Array<{kind:'skill'|'mcp'|'data-source'|'execution-tool'|'model';itemInstanceId:string;status:'pending-adapter'|'skipped'}>;failure:{code:string;message:string}|null;createdAt:string;updatedAt:string}
export type IndustryRoleJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const stamp=(value:unknown):value is string=>typeof value==='string'&&new Date(value).toISOString()===value
const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw Error();return value as Record<string,unknown>}
/** 业务范围标签（模板 `domain`）取代了 `space-<id>`：只核对 1–80 的标签文本。 */
const scope=(value:unknown):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=80
function readRole(value:unknown):DigitalRole{const row=roleInput(value,['id','ownerId','version','state','createdAt','updatedAt','name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig']),{id,ownerId,version,state,createdAt,updatedAt,...fields}=row;if(!uuid(id)||!text(ownerId,128)||!positive(version)||!['active','paused','retired'].includes(String(state))||!stamp(createdAt)||!stamp(updatedAt)||updatedAt<createdAt)throw Error();return {...roleDefinition(fields),id,ownerId,version,state:state as DigitalRole['state'],createdAt,updatedAt}}
function readRequest(value:unknown):IndustryRoleRequest{try{const row=exact(value,['requestId','loadId','itemInstanceId']);if(!uuid(row.requestId)||!uuid(row.loadId)||!uuid(row.itemInstanceId))throw Error();return {requestId:row.requestId.toLowerCase(),loadId:row.loadId.toLowerCase(),itemInstanceId:row.itemInstanceId.toLowerCase()}}catch{throw Error('行业员工实例化请求格式不正确。')}}
function instance(value:unknown):IndustryRoleInstance{try{const row=exact(value,['id','ownerId','loadId','itemInstanceId','itemLocalId','scope','definitionHash','revision','state','role','knowledge','omittedKnowledge','declarations','failure','createdAt','updatedAt']);if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.loadId)||!uuid(row.itemInstanceId)||typeof row.itemLocalId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/.test(row.itemLocalId)||!scope(row.scope)||typeof row.definitionHash!=='string'||!/^[a-f0-9]{64}$/.test(row.definitionHash)||!positive(row.revision)||!['pending','paused','active','retired','failed'].includes(String(row.state))||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)throw Error()
  if(!Array.isArray(row.knowledge)||row.knowledge.length>30||!Array.isArray(row.omittedKnowledge)||row.omittedKnowledge.length>500||!Array.isArray(row.declarations)||row.declarations.length>500)throw Error()
  const knowledge=row.knowledge.map(value=>{const item=exact(value,['itemInstanceId','instanceId','resourceId','resourceVersion']);if(!uuid(item.itemInstanceId)||!uuid(item.instanceId)||!uuid(item.resourceId)||!positive(item.resourceVersion))throw Error();return item as unknown as IndustryRoleInstance['knowledge'][number]})
  const omittedKnowledge=row.omittedKnowledge.map(value=>{const item=exact(value,['itemInstanceId','reason']);if(!uuid(item.itemInstanceId)||!['not-instantiated','pending','failed','withdrawn','skipped'].includes(String(item.reason)))throw Error();return item as unknown as IndustryRoleInstance['omittedKnowledge'][number]})
  const declarations=row.declarations.map(value=>{const item=exact(value,['kind','itemInstanceId','status']);if(!['skill','mcp','data-source','execution-tool','model'].includes(String(item.kind))||!uuid(item.itemInstanceId)||item.status!=='pending-adapter'&&item.status!=='skipped'||item.kind==='model'&&item.status!=='skipped')throw Error();return item as unknown as IndustryRoleInstance['declarations'][number]})
  const dependencyIds=[...knowledge,...omittedKnowledge,...declarations].map(item=>String(item.itemInstanceId).toLowerCase());if(new Set(dependencyIds).size!==dependencyIds.length||new Set(knowledge.map(item=>String(item.instanceId).toLowerCase())).size!==knowledge.length||new Set(knowledge.map(item=>String(item.resourceId).toLowerCase())).size!==knowledge.length)throw Error()
  const role=row.role===null?null:readRole(row.role),failure=row.failure===null?null:exact(row.failure,['code','message']);if(failure&&(!(typeof failure.code==='string'&&/^teloa\/[a-z0-9-]+$/.test(failure.code))||!text(failure.message,2000)))throw Error()
  if(row.state==='paused'||row.state==='active'||row.state==='retired'){if(!role||role.ownerId!==row.ownerId||role.state!==row.state||failure!==null)throw Error()}else{if(role!==null)throw Error();if(row.state==='failed'?!failure:failure!==null)throw Error()}
  return {...row,role,knowledge,omittedKnowledge,declarations,failure} as unknown as IndustryRoleInstance
 }catch{throw requestError('teloa/invalid-host-response','行业员工实例化记录格式不正确。')}}
export type IndustryRoleApi=ReturnType<typeof createIndustryRoleApi>
export function createIndustryRoleApi(call:Call,journal?:IndustryRoleJournal){let pending:IndustryRoleRequest|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false;try{const raw=journal?.read();if(raw){if(raw.length>1000)throw Error();const saved=exact(JSON.parse(raw),['schema','request']);if(saved.schema!=='teloa.industry-role/v1')throw Error();pending=readRequest(saved.request)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{
  if(recoveryError)throw recoveryError
  if(!pending)throw requestError('teloa/invalid-input','没有待核对的行业员工实例化请求。')
  if(busy)throw requestError('teloa/role-create-busy','行业员工实例化正在核对。')
  busy=true
  try{
   try{journal?.write(JSON.stringify({schema:'teloa.industry-role/v1',request:pending}))}catch(error){throw requestError('teloa/recovery-write-failed',error instanceof Error?error.message:'恢复记录保存失败。',error)}
   let response:unknown
   // 服务可能先提交中间实例再建岗，任何拒绝均不能据此丢弃原请求。
   try{response=await call('industry-roles/instantiate',pending)}catch(error){throw requestError('teloa/industry-role-pending',error instanceof Error?error.message:'行业员工结果尚待核对。',error)}
   const result=instance(response)
   if(result.loadId.toLowerCase()!==pending.loadId||result.itemInstanceId.toLowerCase()!==pending.itemInstanceId)throw requestError('teloa/invalid-host-response','行业员工实例化响应与原请求不一致。')
   if(['paused','active','retired'].includes(result.state)){try{journal?.clear()}catch(error){throw requestError('teloa/recovery-clear-failed',error instanceof Error?error.message:'恢复记录清理失败。',error)}pending=undefined}
   return result
  }finally{busy=false}
 }
 return {pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>recoveryError,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=pending!==undefined||recoveryError!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}pending=undefined;recoveryError=undefined;return had},
  recover:send,async instantiate(value:IndustryRoleRequest){if(recoveryError)throw recoveryError;const normalized=readRequest(value);if(pending&&JSON.stringify(pending)!==JSON.stringify(normalized))throw requestError('teloa/industry-role-pending','请先核对原行业员工实例化请求。');pending??=normalized;return send()},async get(instanceId:string){if(!uuid(instanceId))throw Error('行业员工实例身份不正确。');const normalized=instanceId.toLowerCase(),result=instance(await call('industry-roles/get',{instanceId:normalized}));if(result.id.toLowerCase()!==normalized)throw Error('行业员工实例响应与目标身份不一致。');return result},async list(){const response=await call('industry-roles/list',{});let row:Record<string,unknown>;try{row=exact(response,['items']);if(!Array.isArray(row.items))throw Error()}catch{throw Error('行业员工实例目录格式不正确。')}const items=row.items.map(instance),keys=(fn:(item:IndustryRoleInstance)=>string)=>new Set(items.map(fn)).size===items.length,roleIds=items.flatMap(item=>item.role?[item.role.id.toLowerCase()]:[]);if(!keys(item=>item.id.toLowerCase())||!keys(item=>item.loadId.toLowerCase()+':'+item.itemInstanceId.toLowerCase())||new Set(roleIds).size!==roleIds.length)throw Error('行业员工实例目录身份重复。');return items}}
}
