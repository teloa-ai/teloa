import {roleInput} from '@teloa/contract'
import {readSavedRole,type RoleRequestJournal} from './role-api.ts'
import {recoveryStorageError} from './recovery-error.ts'
const states={pause:'paused',resume:'active',retire:'retired'} as const
export type RoleAction=keyof typeof states
type Request={roleId:string;expectedVersion:number;action:RoleAction;reason:string}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
function checked(value:unknown):Request{
 const row=roleInput(value,['roleId','expectedVersion','action','reason'])
 if(!uuid(row.roleId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1||typeof row.action!=='string'||!Object.hasOwn(states,row.action)||typeof row.reason!=='string'||!row.reason.trim()||row.reason.length>4000)throw Error('员工状态请求格式不正确。')
 return {roleId:row.roleId,expectedVersion:row.expectedVersion as number,action:row.action as RoleAction,reason:row.reason.trim()}
}
export type RoleLifecycleApi=ReturnType<typeof createRoleLifecycleApi>
export function createRoleLifecycleApi(call:(method:string,payload:unknown)=>Promise<unknown>,journal?:RoleRequestJournal){
 let request:Request|undefined,error:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){if(raw.length>30000)throw Error();const value=roleInput(JSON.parse(raw),['schema','request']);if(value.schema!=='teloa.role-lifecycle/v1')throw Error();request=checked(value.request)}}catch{error=recoveryStorageError()}
 const send=async()=>{
  if(error)throw error;if(busy)throw Error('员工状态正在核对。');if(!request)throw Error('没有待核对的员工状态。')
  busy=true
  try{
   journal?.write(JSON.stringify({schema:'teloa.role-lifecycle/v1',request}))
   const result=roleInput(await call('roles/lifecycle',request),['role','appliedVersion','handoffTaskIds'])
   const role=readSavedRole(result.role),appliedVersion=request.expectedVersion+1,ids=result.handoffTaskIds
   // 回执同时返回当前岗位；旧请求核对可能已晚于后续暂停或退役，不能把当前状态回退。
   if(role.id!==request.roleId||result.appliedVersion!==appliedVersion||role.version<appliedVersion||role.version===appliedVersion&&role.state!==states[request.action]||!Array.isArray(ids)||!ids.every(uuid)||new Set(ids).size!==ids.length||request.action!=='retire'&&ids.length>0)throw Error('员工状态响应不一致，请核对原请求。')
   journal?.clear();request=undefined;return {role,appliedVersion,handoffTaskIds:ids as string[]}
  }catch(cause){if(cause&&typeof cause==='object'&&'rejected' in cause&&cause.rejected===true&&'code' in cause&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict'].includes(String(cause.code))){journal?.clear();request=undefined}throw cause}finally{busy=false}
 }
 return {pending:()=>request?{...request}:undefined,recoveryMessage:()=>error,
  /** 丢弃只清本地恢复记录，不通知服务端（规格 §二 D4）。 */
  discard(){const had=request!==undefined||error!==undefined;try{journal?.clear()}catch{/* 清不掉不该变成第二道墙 */}request=undefined;error=undefined;return had},
  recover:send,
  async change(roleId:string,expectedVersion:number,action:RoleAction,reason:string){
   if(error)throw error
   const proposed=checked({roleId,expectedVersion,action,reason})
   if(request&&JSON.stringify(request)!==JSON.stringify(proposed))throw Error('请先核对原请求，再执行其他员工状态操作。')
   request??=proposed;return send()
  }
 }
}
