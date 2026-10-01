import {WorkError} from './work-error.ts'
import {isBusinessScopeKey} from './business-scopes.ts'
import {taskInput} from './tasks.ts'

export type BusinessResponsibilityRead={scope:string}
export type BusinessResponsibilitySet=BusinessResponsibilityRead&{requestId:string;expectedVersion:number;role:null|{id:string;expectedVersion:number}}
export type BusinessResponsibility={scope:string;version:number;roleId:string|null;selectedRoleVersion:number|null;availability:'none'|'ready'|'paused'|'retired'|'missing'|'forbidden';currentRoleVersion:number|null}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
const version=(v:unknown,min=1,max=2147483647):v is number=>Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max
const scope=(v:unknown):v is string=>isBusinessScopeKey(v)&&v!=='general'
const invalid=()=>new WorkError('teloa/invalid-input','业务负责人请求格式不正确。')
export function readBusinessResponsibilityRead(value:unknown):BusinessResponsibilityRead{
 const row=taskInput(value,['scope']);if(!scope(row.scope))throw invalid();return {scope:row.scope}
}
export function readBusinessResponsibilitySet(value:unknown):BusinessResponsibilitySet{
 const row=taskInput(value,['requestId','scope','expectedVersion','role'])
 if(!uuid(row.requestId)||!scope(row.scope)||!version(row.expectedVersion,0,2147483646))throw invalid()
 let role:BusinessResponsibilitySet['role']=null
 if(row.role!==null){const selected=taskInput(row.role,['id','expectedVersion']);if(!uuid(selected.id)||!version(selected.expectedVersion))throw invalid();role={id:selected.id.toLowerCase(),expectedVersion:selected.expectedVersion}}
 return {requestId:row.requestId.toLowerCase(),scope:row.scope,expectedVersion:row.expectedVersion,role}
}
/** 完整读取状态投影；失效不会把历史选择抹成未设置。 */
export function readBusinessResponsibility(value:unknown,expectedScope:string):BusinessResponsibility{
 try{
  const row=taskInput(value,['scope','version','roleId','selectedRoleVersion','availability','currentRoleVersion'])
  if(!scope(row.scope)||row.scope!==expectedScope||!version(row.version,0))throw Error()
  if(row.roleId===null){if(row.selectedRoleVersion!==null||row.currentRoleVersion!==null||row.availability!=='none')throw Error()}
  else{
   if(!uuid(row.roleId)||row.roleId!==row.roleId.toLowerCase()||row.version===0||!version(row.selectedRoleVersion))throw Error()
   if(row.availability==='missing'){if(row.currentRoleVersion!==null)throw Error()}
   else if(!['ready','paused','retired','forbidden'].includes(String(row.availability))||!version(row.currentRoleVersion)||row.currentRoleVersion<row.selectedRoleVersion)throw Error()
  }
  return {scope:row.scope,version:row.version,roleId:row.roleId as string|null,selectedRoleVersion:row.selectedRoleVersion as number|null,availability:row.availability as BusinessResponsibility['availability'],currentRoleVersion:row.currentRoleVersion as number|null}
 }catch{throw new WorkError('teloa/invalid-host-response','业务负责人状态不一致。')}
}
