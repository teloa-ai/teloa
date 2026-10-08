import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,taskDefinition,roleWriteDefinition,roleSupportsScope,type DigitalRole,type RoleWorkAuthorization,type TwinExecutionConsent} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import {readRoleWorkAuthorization as parseAuthorization} from './run-role-snapshot.ts'
import {workAccess,combineWorkAccessLeases,type WorkAccessLease} from './work-access.ts'

export type RoleWorkIdentity={id:()=>string;now:()=>string}
/** 由本人交互装配持有，不能与模型工具、自动群路由共用授予端口。 */
export type OwnerWorkAuthority={authorize:(owner:string,request:Readonly<{requestId:string;roleId:string;operation:'confirm'|'save'|'resume'}>)=>Promise<WorkAccessLease>}
export type TwinConsentConfirmInput={requestId:string;roleId:string;expectedRoleVersion:number;authorization:RoleWorkAuthorization}
export const roleWorkUuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export const roleWorkVersion=(v:unknown):v is number=>Number.isSafeInteger(v)&&Number(v)>0&&Number(v)<=2147483647
export function roleWorkOwner(owner:string):void{if(typeof owner!=='string'||!owner.trim()||owner.length>128||owner!==owner.trim())throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
export const roleWorkInvalid=()=>new WorkError('teloa/invalid-input','执行授权请求包含未知字段或身份、版本不正确。')
export function readRoleWorkAuthorization(value:unknown):RoleWorkAuthorization{
 const parsed=parseAuthorization(value)
 if(parsed.kind==='task'){
  if(!roleWorkVersion(parsed.taskContentVersion))throw roleWorkInvalid()
  return {...parsed,taskId:parsed.taskId.toLowerCase()}
 }
 if(!roleWorkVersion(parsed.delegationVersion))throw roleWorkInvalid()
 return {...parsed,delegationId:parsed.delegationId.toLowerCase()}
}
const epochs=new Map<string,number>(),key=(owner:string,roleId:string)=>JSON.stringify([owner,roleId.toLowerCase()])
/** 修改执行定义/工具后由集成者调用；只封旧租约，不授予新权限。 */
export function invalidateRoleWorkEligibility(owner:string,roleId:string):void{const id=key(owner,roleId);epochs.set(id,(epochs.get(id)??0)+1)}
export function roleWorkEpoch(owner:string,roleId:string):number{return epochs.get(key(owner,roleId))??0}
export async function roleWorkTransaction<T>(pool:Pool,work:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect()
 try{await db.query('begin');const value=await work(db);await db.query('commit');return value}
 catch(error){await db.query('rollback');throw error}finally{db.release()}
}
export async function lockRoleWorkRole(db:PoolClient,owner:string,roleId:string,mode:'share'|'update'='update'):Promise<DigitalRole>{
 if(mode!=='share'&&mode!=='update')throw roleWorkInvalid()
 const row=(await db.query(`select * from teloa_roles where owner_id=$1 and id=$2 for ${mode}`,[owner,roleId])).rows[0]
 if(!row)throw new WorkError('teloa/forbidden','执行身份不存在或不属于本人。')
 return readStoredRole(row)
}
export function assertRoleWorkRole(role:DigitalRole,expectedVersion:number):void{
 if(role.version!==expectedVersion)throw new WorkError('teloa/version-conflict','执行身份已变化，请本人复核新版本。')
 if(role.state!=='active')throw new WorkError('teloa/conflict','执行身份当前未在岗。')
 const {id,ownerId,version,state,createdAt,updatedAt,...fields}=role
 try{roleWriteDefinition(fields)}catch(error){
  if(!(error instanceof WorkError)||error.code!=='teloa/invalid-input')throw error
  throw new WorkError('teloa/conflict','执行身份尚未补齐完整职责，请本人先配置后再接手新工作。')
 }
}
export async function authorizeOwnerWork(authority:OwnerWorkAuthority|undefined,owner:string,request:{requestId:string;roleId:string;operation:'confirm'|'save'|'resume'}):Promise<WorkAccessLease>{
 if(!authority||typeof authority.authorize!=='function')throw new WorkError('teloa/forbidden','需要本人明确确认执行授权。')
 let ownerLease:WorkAccessLease
 try{ownerLease=await authority.authorize(owner,Object.freeze({...request}));if(typeof ownerLease?.assertCurrent!=='function')throw Error()}
 catch{throw new WorkError('teloa/forbidden','本人执行确认已失效，请重新复核。')}
 const capability=await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:request.roleId,operation:'edit'})
 const lease=combineWorkAccessLeases([ownerLease,capability]);lease.assertCurrent();return lease
}
/** 调用方已锁 role，随后按 role→task/delegation 的顺序核对持久来源。 */
export async function assertRoleWorkAuthorizationTarget(db:PoolClient,owner:string,role:DigitalRole,authorization:RoleWorkAuthorization):Promise<{scope:string;groupId:string|null}>{
 if(authorization.kind==='task'){
  const task=(await db.query('select * from teloa_tasks where owner_id=$1 and id=$2 for share',[owner,authorization.taskId])).rows[0]
  if(!task||task.assignee_role_id!==role.id)throw new WorkError('teloa/forbidden','任务不属于本人或未交给当前执行身份。')
  if((task.content_version??1)!==authorization.taskContentVersion||task.assignee_role_version!==role.version)throw new WorkError('teloa/version-conflict','任务内容或负责人版本已变化，请本人重新确认。')
  if(['completed','cancelled'].includes(task.state))throw new WorkError('teloa/conflict','已结束任务不能授予新执行。')
  const fields=taskDefinition(task.definition)
  if(!roleSupportsScope(role.scopes,fields.scope))throw new WorkError('teloa/forbidden','任务超出当前执行身份的业务范围。')
  return {scope:fields.scope,groupId:fields.groupId}
 }
 const delegation=(await db.query('select * from teloa_role_work_delegations where owner_id=$1 and id=$2 for share',[owner,authorization.delegationId])).rows[0]
 if(!delegation||delegation.role_id!==role.id)throw new WorkError('teloa/forbidden','委托不属于本人或当前执行身份。')
 if(delegation.role_version!==role.version||delegation.version!==authorization.delegationVersion)throw new WorkError('teloa/version-conflict','委托或执行身份版本已变化，请本人重新确认。')
 if(delegation.state!=='active')throw new WorkError('teloa/forbidden','当前委托已暂停或结束。')
 const fields=taskInput(delegation.fields,['scope','allowedTools','knowledgeIds','memoryViewId','groupIds','safeRecovery'])
 if(typeof fields.scope!=='string'||!roleSupportsScope(role.scopes,fields.scope))throw new WorkError('teloa/forbidden','委托超出当前执行身份的范围。')
 return {scope:fields.scope,groupId:null}
}
export async function initializeTwinExecutionConsents(pool:Pool):Promise<void>{await pool.query(`
 create unique index if not exists teloa_roles_identity_owner on teloa_roles(id,owner_id);
 create table if not exists teloa_twin_execution_consents(
  id uuid primary key,owner_id text not null,role_id uuid not null,role_version integer not null check(role_version>0),
  version integer not null check(version>0),execution_authorization jsonb not null check(jsonb_typeof(execution_authorization)='object'),
  state text not null check(state in ('active','revoked')),request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  created_at timestamptz not null,foreign key(role_id,owner_id) references teloa_roles(id,owner_id)
 );
 create unique index if not exists teloa_twin_execution_consent_active on teloa_twin_execution_consents(owner_id,role_id,role_version,execution_authorization) where state='active';
 create table if not exists teloa_twin_execution_consent_requests(
  owner_id text not null,request_id uuid not null,consent_id uuid not null references teloa_twin_execution_consents(id),
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),primary key(owner_id,request_id)
 );
`)}
export function readStoredTwinExecutionConsent(row:Record<string,unknown>):TwinExecutionConsent{
 try{
  const authorization=readRoleWorkAuthorization(row.execution_authorization),spec=taskInput(row.request_spec,['roleId','expectedRoleVersion','authorization'])
  if(!roleWorkUuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!roleWorkUuid(row.role_id)||!roleWorkVersion(row.role_version)||!roleWorkVersion(row.version)||!['active','revoked'].includes(String(row.state))||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||spec.roleId!==row.role_id||spec.expectedRoleVersion!==row.role_version||JSON.stringify(readRoleWorkAuthorization(spec.authorization))!==JSON.stringify(authorization))throw Error()
  return {schema:'teloa.twin-execution-consent/v1',id:row.id,ownerId:row.owner_id,roleId:row.role_id,roleVersion:row.role_version,version:row.version,authorization,state:row.state as TwinExecutionConsent['state'],createdAt:row.created_at.toISOString()}
 }catch{throw new WorkError('teloa/storage-corrupt','分身本人授权回执损坏，已停止使用。')}
}
function confirmInput(owner:string,input:unknown):TwinConsentConfirmInput{
 roleWorkOwner(owner);const row=taskInput(input,['requestId','roleId','expectedRoleVersion','authorization'])
 if(!roleWorkUuid(row.requestId)||!roleWorkUuid(row.roleId)||!roleWorkVersion(row.expectedRoleVersion))throw roleWorkInvalid()
 return {requestId:row.requestId.toLowerCase(),roleId:row.roleId.toLowerCase(),expectedRoleVersion:row.expectedRoleVersion,authorization:readRoleWorkAuthorization(row.authorization)}
}
export class TwinExecutionConsentService{
 readonly pool:Pool
 readonly identity:RoleWorkIdentity
 readonly ownerAuthority:OwnerWorkAuthority|undefined
 constructor(pool:Pool,identity:RoleWorkIdentity,ownerAuthority?:OwnerWorkAuthority){this.pool=pool;this.identity=identity;this.ownerAuthority=ownerAuthority}
 async get(owner:string,input:{roleId:string}):Promise<TwinExecutionConsent[]>{
  roleWorkOwner(owner);const row=taskInput(input,['roleId']);if(!roleWorkUuid(row.roleId))throw roleWorkInvalid()
  return roleWorkTransaction(this.pool,async db=>{await lockRoleWorkRole(db,owner,row.roleId as string);return (await db.query('select * from teloa_twin_execution_consents where owner_id=$1 and role_id=$2 order by created_at,id',[owner,row.roleId])).rows.map(readStoredTwinExecutionConsent)})
 }
 async confirm(owner:string,input:TwinConsentConfirmInput):Promise<TwinExecutionConsent>{
  confirmInput(owner,input);return roleWorkTransaction(this.pool,db=>this.confirmInTransaction(db,owner,input))
 }
 async confirmInTransaction(db:PoolClient,owner:string,input:TwinConsentConfirmInput):Promise<TwinExecutionConsent>{
  const command=confirmInput(owner,input),{requestId,...fields}=command,spec=JSON.stringify({operation:'confirm',...fields})
  const role=await lockRoleWorkRole(db,owner,command.roleId)
  // FOR UPDATE 已在本事务分配 XID；若调用方漏了 BEGIN，上一查询自动提交，此处会读到 null。
  if(!(await db.query('select pg_current_xact_id_if_assigned() is not null as in_transaction')).rows[0]?.in_transaction)throw new WorkError('teloa/conflict','分身确认必须和任务写入处于同一事务。')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/twin-consent-request',owner,requestId])])
  const prior=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_twin_execution_consent_requests where owner_id=$1 and request_id=$2',[owner,requestId,spec])).rows[0]
  if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一分身确认请求不能更换授权内容。');return this.receipt(db,owner,prior.consent_id)}
  assertRoleWorkRole(role,command.expectedRoleVersion)
  if(role.kind!=='twin')throw new WorkError('teloa/forbidden','本人执行回执仅适用于分身身份。')
  await assertRoleWorkAuthorizationTarget(db,owner,role,command.authorization)
  const lease=await authorizeOwnerWork(this.ownerAuthority,owner,{requestId,roleId:role.id,operation:'confirm'})
  const existing=(await db.query("select * from teloa_twin_execution_consents where owner_id=$1 and role_id=$2 and role_version=$3 and execution_authorization=$4::jsonb and state='active' for update",[owner,role.id,role.version,JSON.stringify(command.authorization)])).rows[0]
  const saved=existing??(await db.query(`insert into teloa_twin_execution_consents(id,owner_id,role_id,role_version,version,execution_authorization,state,request_spec,created_at)
   values($1,$2,$3,$4,1,$5,'active',$6,$7) returning *`,[this.identity.id(),owner,role.id,role.version,JSON.stringify(command.authorization),JSON.stringify(fields),this.identity.now()])).rows[0]
  const result=readStoredTwinExecutionConsent(saved);lease.assertCurrent()
  await db.query('insert into teloa_twin_execution_consent_requests(owner_id,request_id,consent_id,request_spec) values($1,$2,$3,$4)',[owner,requestId,result.id,spec])
  invalidateRoleWorkEligibility(owner,role.id);lease.assertCurrent();return result
 }
 async revoke(owner:string,input:{requestId:string;consentId:string;expectedVersion:number}):Promise<TwinExecutionConsent>{
  roleWorkOwner(owner);const row=taskInput(input,['requestId','consentId','expectedVersion'])
  if(!roleWorkUuid(row.requestId)||!roleWorkUuid(row.consentId)||!roleWorkVersion(row.expectedVersion))throw roleWorkInvalid()
  const spec=JSON.stringify({operation:'revoke',consentId:row.consentId.toLowerCase(),expectedVersion:row.expectedVersion})
  return roleWorkTransaction(this.pool,async db=>{
   const source=(await db.query('select role_id from teloa_twin_execution_consents where owner_id=$1 and id=$2',[owner,row.consentId])).rows[0]
   if(!source)throw new WorkError('teloa/forbidden','分身授权回执不存在或不属于本人。')
   await lockRoleWorkRole(db,owner,source.role_id)
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa/twin-consent-request',owner,(row.requestId as string).toLowerCase()])])
   const prior=(await db.query('select *,request_spec=$3::jsonb as same_request from teloa_twin_execution_consent_requests where owner_id=$1 and request_id=$2',[owner,row.requestId,spec])).rows[0]
   if(prior){if(!prior.same_request)throw new WorkError('teloa/conflict','同一撤销请求不能更换内容。');return this.receipt(db,owner,prior.consent_id)}
   const current=await this.receipt(db,owner,row.consentId as string)
   if(current.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','分身授权回执已变化。')
   const updated=current.state==='revoked'?current:readStoredTwinExecutionConsent((await db.query("update teloa_twin_execution_consents set state='revoked',version=version+1 where owner_id=$1 and id=$2 returning *",[owner,current.id])).rows[0])
   await db.query('insert into teloa_twin_execution_consent_requests(owner_id,request_id,consent_id,request_spec) values($1,$2,$3,$4)',[owner,(row.requestId as string).toLowerCase(),updated.id,spec])
   invalidateRoleWorkEligibility(owner,current.roleId);return updated
  })
 }
 private async receipt(db:PoolClient,owner:string,consentId:string):Promise<TwinExecutionConsent>{
  const row=(await db.query('select * from teloa_twin_execution_consents where owner_id=$1 and id=$2 for update',[owner,consentId])).rows[0]
  if(!row)throw new WorkError('teloa/storage-corrupt','分身请求回执的固定授权记录缺失。')
  return readStoredTwinExecutionConsent(row)
 }
}
