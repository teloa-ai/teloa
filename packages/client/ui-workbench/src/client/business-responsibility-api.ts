import {
 WorkError,readBusinessResponsibilityRead,readBusinessResponsibilitySet,readBusinessResponsibility,
 type BusinessResponsibility,type BusinessResponsibilitySet,type BusinessResponsibilityRead,
} from '@teloa/contract'
import {createRoleApi} from './role-api.ts'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(method:string,input:unknown)=>Promise<unknown>
type Options={storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>;personalSpaceId:string;isCurrent:()=>boolean}
const schema='teloa.business-responsibility/v1'
export type BusinessResponsibilityApi=ReturnType<typeof createBusinessResponsibilityApi>

/** 只持久化固定设置请求。本人/连接代次由装配层的 isCurrent 失效闸核对。 */
export function createBusinessResponsibilityApi(call:Call,options:Options){
 if(!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(options.personalSpaceId))throw recoveryStorageError()
 const prefix=`${schema}/personal-space/${options.personalSpaceId.toLowerCase()}/`,busy=new Set<string>(),rejected=new Map<string,string>()
 const current=()=>{if(!options.isCurrent())throw new WorkError('teloa/conflict','Business identity changed.',{reason:'changed'})}
 const conflict=()=>new WorkError('teloa/conflict','Resolve the pending responsibility request first.')
 function pending(scope:string):BusinessResponsibilitySet|null{
  current();readBusinessResponsibilityRead({scope})
  try{
   const raw=options.storage.getItem(prefix+scope)
   if(raw===null)return null
   if(!raw||raw.length>16384)throw Error()
   const row=JSON.parse(raw)
   if(!row||typeof row!=='object'||Object.keys(row).sort().join(',')!=='request,schema'||row.schema!==schema)throw Error()
   const request=readBusinessResponsibilitySet(row.request)
   if(request.scope!==scope||JSON.stringify(request)!==JSON.stringify(row.request))throw Error()
   return request
  }catch{throw recoveryStorageError()}
 }
 function persist(request:BusinessResponsibilitySet){
  current()
  const previous=pending(request.scope)
  if(previous&&JSON.stringify(previous)!==JSON.stringify(request))throw conflict()
  const raw=JSON.stringify({schema,request})
  try{options.storage.setItem(prefix+request.scope,raw);if(options.storage.getItem(prefix+request.scope)!==raw)throw Error()}catch{throw recoveryStorageError()}
 }
 function clear(request:BusinessResponsibilitySet){
  current()
  const previous=pending(request.scope)
  if(previous&&JSON.stringify(previous)!==JSON.stringify(request))throw conflict()
  try{options.storage.removeItem(prefix+request.scope);if(options.storage.getItem(prefix+request.scope)!==null)throw Error()}catch{throw recoveryStorageError()}
  rejected.delete(request.scope)
 }
 async function guardedCall(method:string,input:unknown){current();const value=await call(method,input);current();return value}
 const invoke=(method:string,input:unknown)=>guardedCall(`business-responsibility/${method}`,input)
 function receiptValue(value:unknown,input:BusinessResponsibilitySet):BusinessResponsibility{
  const result=readBusinessResponsibility(value,input.scope),role=input.role
  if(result.version!==input.expectedVersion+1||result.roleId!==(role?.id??null)||result.selectedRoleVersion!==(role?.expectedVersion??null)||result.currentRoleVersion!==(role?.expectedVersion??null)||result.availability!==(role?'ready':'none'))throw new WorkError('teloa/invalid-host-response','Responsibility receipt does not match the request.')
  return result
 }
 async function read(input:BusinessResponsibilityRead){const request=readBusinessResponsibilityRead(input);return readBusinessResponsibility(await invoke('read',request),request.scope)}
 async function receipt(input:BusinessResponsibilitySet){const request=readBusinessResponsibilitySet(input),value=await invoke('receipt',request);return value===null?null:receiptValue(value,request)}
 async function exclusive<T>(scope:string,action:()=>Promise<T>):Promise<T>{
  current();if(busy.has(scope))throw conflict();busy.add(scope)
  try{return await action()}finally{busy.delete(scope)}
 }
 async function send(request:BusinessResponsibilitySet){
  persist(request);rejected.delete(request.scope)
  let raw:unknown
  try{raw=await invoke('set',request)}catch(error){
   current()
   // 只有真实宿主明确拒绝才记录证明；网络错误或单独 code 不能证明未写入。
   if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&error.code==='teloa/version-conflict')rejected.set(request.scope,JSON.stringify(request))
   throw error
  }
  const value=receiptValue(raw,request);clear(request);return value
 }
 function canReselect(scope:string){const saved=pending(scope);return !!saved&&!busy.has(scope)&&rejected.get(scope)===JSON.stringify(saved)}
 async function reselect(input:BusinessResponsibilityRead){
  const request=readBusinessResponsibilityRead(input)
  return exclusive(request.scope,async()=>{
   const saved=pending(request.scope)
   if(!saved||rejected.get(request.scope)!==JSON.stringify(saved))throw conflict()
   if(await receipt(saved)){clear(saved);return read(request)}
   const value=await read(request)
   let obsolete=value.version>saved.expectedVersion
   if(!obsolete&&saved.role){
    const directory=await createRoleApi(guardedCall).list()
    obsolete=directory.some(role=>role.id===saved.role!.id&&role.version>saved.role!.expectedVersion)
   }
   // 空回执本身不足以丢弃：原固定版本必须已经永远不可执行。
   if(!obsolete)throw conflict()
   clear(saved);return value
  })
 }
 async function set(input:BusinessResponsibilitySet){const request=readBusinessResponsibilitySet(input);return exclusive(request.scope,()=>{if(pending(request.scope))throw conflict();return send(request)})}
 async function reconcile(input:BusinessResponsibilityRead){
  const request=readBusinessResponsibilityRead(input)
  return exclusive(request.scope,async()=>{const saved=pending(request.scope);if(saved&&await receipt(saved))clear(saved);return read(request)})
 }
 async function recover(input:BusinessResponsibilityRead){
  const request=readBusinessResponsibilityRead(input)
  return exclusive(request.scope,async()=>{
   const saved=pending(request.scope)
   if(saved){if(await receipt(saved))clear(saved);else await send(saved)}
   // 回执是旧设置时刻的结果，不能覆盖此后其他页面提交的当前选择。
   return read(request)
  })
 }
 return {read,set,receipt,pending,reconcile,recover,canReselect,reselect}
}
