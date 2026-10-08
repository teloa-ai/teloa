import type {RoleWorkAuthorization,RoleWorkDelegation,TwinExecutionConsent} from '@teloa/contract'
import {recoveryStorageError} from './recovery-error.ts'

type Call=(endpoint:string,input:unknown)=>Promise<unknown>
export type RoleDelegationFields=Pick<RoleWorkDelegation,'scope'|'allowedTools'|'knowledgeIds'|'memoryViewId'|'groupIds'|'safeRecovery'>
export type RoleDelegationChange={requestId:string;roleId:string;expectedRoleVersion:number;expectedVersion:number|null;action:'save'|'pause'|'resume'|'end';fields?:RoleDelegationFields}
export type TwinExecutionConfirm={requestId:string;roleId:string;expectedRoleVersion:number;authorization:RoleWorkAuthorization}
export type TwinExecutionRevoke={requestId:string;consentId:string;expectedVersion:number}
export type RoleDelegationRead={roleId:string;roleVersion:number;delegations:RoleWorkDelegation[];consents:TwinExecutionConsent[];canEditExecution:boolean}
export type RoleDelegationJournal={read:()=>string|null;write:(value:string)=>void;clear:()=>void}
type Pending={endpoint:'role-delegations/change';input:RoleDelegationChange}|{endpoint:'twin-execution-consents/confirm';input:TwinExecutionConfirm}|{endpoint:'twin-execution-consents/revoke';input:TwinExecutionRevoke}
const fail=(host=false):never=>{throw Object.assign(Error(host?'执行委托回执不正确，请刷新核对。':'执行委托请求格式不正确。'),{code:host?'teloa/invalid-host-response':'teloa/invalid-input'})}
const exact=(value:unknown,keys:readonly string[])=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))return fail();return value as Record<string,unknown>}
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const version=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value===value.trim()&&value.length>0&&value.length<=max&&!/[\x00-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is string=>{if(typeof value!=='string')return false;const date=new Date(value);return Number.isFinite(date.getTime())&&date.toISOString()===value}
const list=(value:unknown,ids=false):string[]=>{if(!Array.isArray(value)||value.length>100||value.some(item=>ids?!uuid(item):!text(item,160))||new Set(value).size!==value.length)return fail();return [...value]}
function authorization(value:unknown):RoleWorkAuthorization{
 const row=exact(value,['kind','taskId','taskContentVersion','delegationId','delegationVersion'])
 if(row.kind==='task'&&Object.keys(row).length===3&&uuid(row.taskId)&&version(row.taskContentVersion))return {kind:'task',taskId:row.taskId,taskContentVersion:row.taskContentVersion}
 if(row.kind==='delegation'&&Object.keys(row).length===3&&uuid(row.delegationId)&&version(row.delegationVersion))return {kind:'delegation',delegationId:row.delegationId,delegationVersion:row.delegationVersion}
 return fail()
}
function fields(value:unknown):RoleDelegationFields{
 const row=exact(value,['scope','allowedTools','knowledgeIds','memoryViewId','groupIds','safeRecovery'])
 if(!text(row.scope,80)||row.memoryViewId!==null&&!uuid(row.memoryViewId)||typeof row.safeRecovery!=='boolean')return fail()
 return {scope:row.scope,allowedTools:list(row.allowedTools),knowledgeIds:list(row.knowledgeIds,true),memoryViewId:row.memoryViewId as string|null,groupIds:list(row.groupIds,true),safeRecovery:row.safeRecovery}
}
export function readRoleWorkDelegation(value:unknown):RoleWorkDelegation{
 try{const row=exact(value,['id','ownerId','roleId','roleVersion','version','state','scope','allowedTools','knowledgeIds','memoryViewId','groupIds','safeRecovery','createdAt','updatedAt']);if(!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.roleId)||!version(row.roleVersion)||!version(row.version)||!['active','pausing','paused','ending','ended'].includes(String(row.state))||!stamp(row.createdAt)||!stamp(row.updatedAt)||row.updatedAt<row.createdAt)return fail();return {id:row.id,ownerId:row.ownerId,roleId:row.roleId,roleVersion:row.roleVersion,version:row.version,state:row.state as RoleWorkDelegation['state'],...fields(Object.fromEntries(['scope','allowedTools','knowledgeIds','memoryViewId','groupIds','safeRecovery'].map(key=>[key,row[key]]))),createdAt:row.createdAt,updatedAt:row.updatedAt}}catch{return fail(true)}
}
export function readTwinExecutionConsent(value:unknown):TwinExecutionConsent{
 try{const row=exact(value,['schema','id','ownerId','roleId','roleVersion','version','authorization','state','createdAt']);if(row.schema!=='teloa.twin-execution-consent/v1'||!uuid(row.id)||!text(row.ownerId,128)||!uuid(row.roleId)||!version(row.roleVersion)||!version(row.version)||row.state!=='active'&&row.state!=='revoked'||!stamp(row.createdAt))return fail();return {schema:row.schema,id:row.id,ownerId:row.ownerId,roleId:row.roleId,roleVersion:row.roleVersion,version:row.version,authorization:authorization(row.authorization),state:row.state,createdAt:row.createdAt}}catch{return fail(true)}
}
export function readRoleDelegationState(value:unknown,roleId:string):RoleDelegationRead{
 try{const row=exact(value,['roleId','roleVersion','delegations','consents','canEditExecution']);if(row.roleId!==roleId||!version(row.roleVersion)||typeof row.canEditExecution!=='boolean'||!Array.isArray(row.delegations)||!Array.isArray(row.consents))return fail();const roleVersion=row.roleVersion,delegations=row.delegations.map(readRoleWorkDelegation),consents=row.consents.map(readTwinExecutionConsent),records=[...delegations,...consents];if(records.some(record=>record.roleId!==roleId||record.roleVersion>roleVersion)||new Set(delegations.map(record=>record.id)).size!==delegations.length||new Set(consents.map(record=>record.id)).size!==consents.length||new Set(records.map(record=>record.ownerId)).size>1)return fail();return {roleId,roleVersion:row.roleVersion,delegations,consents,canEditExecution:row.canEditExecution}}catch{return fail(true)}
}
function command(endpoint:Pending['endpoint'],value:unknown):Pending{
 if(endpoint==='role-delegations/change'){
  const row=exact(value,['requestId','roleId','expectedRoleVersion','expectedVersion','action','fields']);if(!uuid(row.requestId)||!uuid(row.roleId)||!version(row.expectedRoleVersion)||row.expectedVersion!==null&&!version(row.expectedVersion)||!['save','pause','resume','end'].includes(String(row.action))||row.action!=='save'&&(row.expectedVersion===null||row.fields!==undefined))return fail()
  return {endpoint,input:{requestId:row.requestId,roleId:row.roleId,expectedRoleVersion:row.expectedRoleVersion,expectedVersion:row.expectedVersion as number|null,action:row.action as RoleDelegationChange['action'],...(row.action==='save'?{fields:fields(row.fields)}:{})}}
 }
 if(endpoint==='twin-execution-consents/confirm'){const row=exact(value,['requestId','roleId','expectedRoleVersion','authorization']);if(!uuid(row.requestId)||!uuid(row.roleId)||!version(row.expectedRoleVersion))return fail();return {endpoint,input:{requestId:row.requestId,roleId:row.roleId,expectedRoleVersion:row.expectedRoleVersion,authorization:authorization(row.authorization)}}}
 const row=exact(value,['requestId','consentId','expectedVersion']);if(!uuid(row.requestId)||!uuid(row.consentId)||!version(row.expectedVersion))return fail();return {endpoint,input:{requestId:row.requestId,consentId:row.consentId,expectedVersion:row.expectedVersion}}
}
export type RoleDelegationApi=ReturnType<typeof createRoleDelegationApi>
export function createRoleDelegationApi(call:Call,journal?:RoleDelegationJournal){
 let pending:Pending|undefined,recoveryError:ReturnType<typeof recoveryStorageError>|undefined,busy=false
 try{const raw=journal?.read();if(raw){const row=exact(JSON.parse(raw),['schema','endpoint','input']);if(row.schema!=='teloa.role-delegation/v1'||!['role-delegations/change','twin-execution-consents/confirm','twin-execution-consents/revoke'].includes(String(row.endpoint)))throw Error();pending=command(row.endpoint as Pending['endpoint'],row.input)}}catch{recoveryError=recoveryStorageError()}
 const send=async()=>{
  if(recoveryError)throw recoveryError;if(!pending||busy)throw Object.assign(Error('请先核对原执行委托请求。'),{code:'teloa/conflict'});busy=true
  try{journal?.write(JSON.stringify({schema:'teloa.role-delegation/v1',...pending}));const value=await call(pending.endpoint,pending.input)
   let receipt:RoleWorkDelegation|TwinExecutionConsent
   if(pending.endpoint==='role-delegations/change'){const delegationReceipt=readRoleWorkDelegation(value);receipt=delegationReceipt;const input=pending.input,states=input.action==='pause'?['pausing','paused']:input.action==='end'?['ending','ended']:['active'];if(receipt.roleId!==input.roleId||receipt.roleVersion!==input.expectedRoleVersion||receipt.version!==(input.expectedVersion??0)+1||!states.includes(receipt.state)||input.fields&&JSON.stringify(fields(Object.fromEntries(Object.keys(input.fields).map(key=>[key,delegationReceipt[key as keyof RoleWorkDelegation]]))))!==JSON.stringify(input.fields))return fail(true)}
   else{receipt=readTwinExecutionConsent(value);const input=pending.input;if(pending.endpoint==='twin-execution-consents/confirm'){const confirm=input as TwinExecutionConfirm;if(receipt.roleId!==confirm.roleId||receipt.roleVersion!==confirm.expectedRoleVersion||receipt.state!=='active'||JSON.stringify(receipt.authorization)!==JSON.stringify(confirm.authorization))return fail(true)}else{const revoke=input as TwinExecutionRevoke;if(receipt.id!==revoke.consentId||receipt.version!==revoke.expectedVersion+1||receipt.state!=='revoked')return fail(true)}}
   journal?.clear();pending=undefined;return receipt
  }catch(error){if(error&&typeof error==='object'&&'rejected'in error&&error.rejected===true&&'code'in error&&['teloa/invalid-input','teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/source-unavailable'].includes(String(error.code))){journal?.clear();pending=undefined}throw error}finally{busy=false}
 }
 const start=(endpoint:Pending['endpoint'],input:unknown)=>{if(recoveryError)throw recoveryError;const next=command(endpoint,input);if(pending&&JSON.stringify(pending)!==JSON.stringify(next))throw Object.assign(Error('请先核对原执行委托请求。'),{code:'teloa/conflict'});pending??=next;return send()}
 return {pending:()=>pending?structuredClone(pending):undefined,recoveryMessage:()=>recoveryError,recover:send,
  /** 仅清理本人选择丢弃的本地恢复记录，不撤销远端委托或执行许可。 */
  discard(){const had=!!pending||!!recoveryError;try{journal?.clear()}catch{/* 损坏的本地恢复记录不应成为第二道墙。 */}pending=undefined;recoveryError=undefined;return had},
  async get(roleId:string){if(!uuid(roleId))return fail();return readRoleDelegationState(await call('role-delegations/get',{roleId}),roleId)},
  async change(input:RoleDelegationChange){return await start('role-delegations/change',input) as RoleWorkDelegation},
  async confirm(input:TwinExecutionConfirm){return await start('twin-execution-consents/confirm',input) as TwinExecutionConsent},
  async revoke(input:TwinExecutionRevoke){return await start('twin-execution-consents/revoke',input) as TwinExecutionConsent}
 }
}
