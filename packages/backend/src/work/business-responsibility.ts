import type {Pool,PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,roleSupportsScope,readBusinessResponsibilityRead,readBusinessResponsibilitySet,readBusinessResponsibility,type BusinessResponsibility,type BusinessResponsibilitySet} from '@teloa/contract'
import {BusinessConfigurationStore} from './business-configuration-store.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {readStoredRole} from './roles.ts'
import {authorizeRoleTaskAssignment,readCurrentTwinDelegationAuthorization} from './role-task-authorization.ts'

export type BusinessResponsibilityActor={ownerId:string;scopeIds:readonly string[]}
const forbidden=()=>new WorkError('teloa/forbidden','业务不存在、尚未采用配置或当前主体无权管理负责人。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务负责人存储不一致，请核对原记录。')
function authorize(actor:BusinessResponsibilityActor,scope:string){
 if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId.trim()||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||/[\x00-\x1f\x7f]/.test(actor.ownerId)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(value=>!isBusinessScopeKey(value))||!actor.scopeIds.includes(scope))throw forbidden()
}
const empty=(scope:string):BusinessResponsibility=>({scope,version:0,roleId:null,selectedRoleVersion:null,availability:'none',currentRoleVersion:null})
export async function initializeBusinessResponsibilities(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_business_responsibilities(
 owner_id text not null,scope_id text not null,version integer not null check(version>0),role_id uuid,selected_role_version integer,
 updated_at timestamptz not null default now(),primary key(owner_id,scope_id),
 check((role_id is null and selected_role_version is null) or (role_id is not null and selected_role_version is not null and selected_role_version>0)),
 foreign key(owner_id,scope_id) references teloa_business_scopes(owner_id,scope));
 create table if not exists teloa_business_responsibility_requests(
 owner_id text not null,request_id uuid not null,scope_id text not null,request_spec jsonb not null,result jsonb not null,
 created_at timestamptz not null default now(),primary key(owner_id,request_id),
 foreign key(owner_id,scope_id) references teloa_business_responsibilities(owner_id,scope_id));
 `)}
/** 只读持久选择；角色可用性来自当前真实岗位，不能由旧回执推断。 */
function selection(row:Record<string,unknown>|undefined,owner:string,scope:string):BusinessResponsibility{
 if(!row)return empty(scope)
 try{
  if(row.owner_id!==owner||row.scope_id!==scope||!(row.updated_at instanceof Date)||!Number.isFinite(row.updated_at.getTime())||!Number.isSafeInteger(row.version)||Number(row.version)<1)throw Error()
  return readBusinessResponsibility({scope,version:row.version,roleId:row.role_id,selectedRoleVersion:row.selected_role_version,availability:row.role_id===null?'none':'ready',currentRoleVersion:row.selected_role_version},scope)
 }catch{throw corrupt()}
}

export class BusinessResponsibilityService{
 readonly pool:Pool
 readonly store:BusinessConfigurationStore
 constructor(pool:Pool){this.pool=pool;this.store=new BusinessConfigurationStore(pool)}
 private async transaction<T>(work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query('begin');const result=await work(db);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }
 /** 配置共享锁先于scope行，保持整体采用的配置→scope锁序；缺行也由负责人范围锁串行。 */
 private async lockScope(db:PoolClient,actor:BusinessResponsibilityActor,scope:string,write:boolean){
  authorize(actor,scope)
  await lockBusinessConfiguration(db,actor.ownerId,scope,'shared')
  if(!(await db.query('select 1 from teloa_business_scopes where owner_id=$1 and scope=$2 for share',[actor.ownerId,scope])).rowCount)throw forbidden()
  if(!await this.store.currentInTransaction(db,actor.ownerId,scope))throw forbidden()
  await db.query('select '+(write?'pg_advisory_xact_lock':'pg_advisory_xact_lock_shared')+'(hashtextextended($1,0))',[JSON.stringify(['teloa.business-responsibility',actor.ownerId,scope])])
 }
 private async selected(db:PoolClient,actor:BusinessResponsibilityActor,scope:string,write=false){
  const row=(await db.query('select * from teloa_business_responsibilities where owner_id=$1 and scope_id=$2 for '+(write?'update':'share'),[actor.ownerId,scope])).rows[0]
  return selection(row,actor.ownerId,scope)
 }
 private async role(db:PoolClient,owner:string,id:string,lock:'share'|'update'='share'){
  const row=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for '+lock,[owner,id])).rows[0]
  return row?readStoredRole(row):undefined
 }
 private async project(db:PoolClient,actor:BusinessResponsibilityActor,value:BusinessResponsibility):Promise<BusinessResponsibility>{
  if(value.roleId===null)return value
  const role=await this.role(db,actor.ownerId,value.roleId)
  if(!role)return {...value,availability:'missing',currentRoleVersion:null}
  let availability:BusinessResponsibility['availability']=!roleSupportsScope(role.scopes,value.scope)?'forbidden':role.state==='active'?'ready':role.state
  if(role.kind==='twin'&&availability==='ready'){try{await readCurrentTwinDelegationAuthorization(db,actor.ownerId,role,value.scope)}catch(error){if(!(error instanceof WorkError)||!['teloa/forbidden','teloa/conflict','teloa/version-conflict','teloa/invalid-input'].includes(error.code))throw error;availability='forbidden'}}
  try{return readBusinessResponsibility({...value,availability,currentRoleVersion:role.version},value.scope)}catch{throw corrupt()}
 }
 async read(actor:BusinessResponsibilityActor,input:unknown):Promise<BusinessResponsibility>{
  const {scope}=readBusinessResponsibilityRead(input);authorize(actor,scope)
  return this.transaction(db=>this.readInTransaction(db,actor,{scope}))
 }
 /** 调用方持有事务；所有配置/负责人/岗位读取只用这个连接，不另开事务或借池。 */
 async readInTransaction(db:PoolClient,actor:BusinessResponsibilityActor,input:unknown):Promise<BusinessResponsibility>{
  const {scope}=readBusinessResponsibilityRead(input);await this.lockScope(db,actor,scope,false)
  return this.project(db,actor,await this.selected(db,actor,scope))
 }
 async set(actor:BusinessResponsibilityActor,input:unknown):Promise<BusinessResponsibility>{
  const request=readBusinessResponsibilitySet(input);authorize(actor,request.scope)
  return this.transaction(async db=>{
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-responsibility-request',actor.ownerId,request.requestId])])
   await this.lockScope(db,actor,request.scope,true)
   const current=await this.selected(db,actor,request.scope,true)
   const receipt=(await db.query('select * from teloa_business_responsibility_requests where owner_id=$1 and request_id=$2',[actor.ownerId,request.requestId])).rows[0]
   if(receipt)return this.readReceipt(receipt,request,current)
   if(current.version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','业务负责人已变化，请刷新后核对。')
   const selected={scope:request.scope,version:current.version+1,roleId:request.role?.id??null,selectedRoleVersion:request.role?.expectedVersion??null,availability:request.role?'ready' as const:'none' as const,currentRoleVersion:request.role?.expectedVersion??null}
   let execution:Awaited<ReturnType<typeof authorizeRoleTaskAssignment>>|undefined
   if(request.role){
    const role=await this.role(db,actor.ownerId,request.role.id,'update')
    if(!role||!roleSupportsScope(role.scopes,request.scope))throw new WorkError('teloa/forbidden','指定同事不存在或不支持此业务。')
    if(role.version!==request.role.expectedVersion)throw new WorkError('teloa/version-conflict','指定员工版本已变化，请重新核对。')
    if(role.state!=='active')throw new WorkError('teloa/conflict','指定员工已暂停或退役，不能设为业务负责人。')
    execution=await authorizeRoleTaskAssignment(db,this.pool,actor.ownerId,role,request.scope)
   }
   const result=selected
   execution?.assertCurrent()
   await db.query('insert into teloa_business_responsibilities(owner_id,scope_id,version,role_id,selected_role_version) values($1,$2,$3,$4,$5) on conflict(owner_id,scope_id) do update set version=excluded.version,role_id=excluded.role_id,selected_role_version=excluded.selected_role_version,updated_at=now()',[actor.ownerId,request.scope,result.version,result.roleId,result.selectedRoleVersion])
   await db.query('insert into teloa_business_responsibility_requests(owner_id,request_id,scope_id,request_spec,result) values($1,$2,$3,$4,$5)',[actor.ownerId,request.requestId,request.scope,JSON.stringify(request),JSON.stringify(result)])
   execution?.assertCurrent();return result
  })
 }
 /** 只核对完整原请求；原结果不代表岗位当前可执行，也不能恢复已变更选择。 */
 async receipt(actor:BusinessResponsibilityActor,input:unknown):Promise<BusinessResponsibility|null>{
  const request=readBusinessResponsibilitySet(input);authorize(actor,request.scope)
  return this.transaction(async db=>{
   await db.query('select pg_advisory_xact_lock_shared(hashtextextended($1,0))',[JSON.stringify(['teloa.business-responsibility-request',actor.ownerId,request.requestId])])
   await this.lockScope(db,actor,request.scope,false)
   const current=await this.selected(db,actor,request.scope)
   const row=(await db.query('select * from teloa_business_responsibility_requests where owner_id=$1 and request_id=$2',[actor.ownerId,request.requestId])).rows[0]
   return row?this.readReceipt(row,request,current):null
  })
 }
 private readReceipt(row:Record<string,unknown>,request:BusinessResponsibilitySet,current:BusinessResponsibility):BusinessResponsibility{
  let spec:BusinessResponsibilitySet,result:BusinessResponsibility
  try{
   spec=readBusinessResponsibilitySet(row.request_spec);result=readBusinessResponsibility(row.result,spec.scope)
   if(spec.requestId!==row.request_id||spec.scope!==row.scope_id||result.version!==spec.expectedVersion+1||result.roleId!==(spec.role?.id??null)||result.selectedRoleVersion!==(spec.role?.expectedVersion??null)||result.currentRoleVersion!==result.selectedRoleVersion||result.availability!==(spec.role?'ready':'none')||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw Error()
  }catch{throw corrupt()}
  if(JSON.stringify(spec)!==JSON.stringify(request))throw new WorkError('teloa/conflict','同一请求不能修改业务负责人选择。')
  if(result.version>current.version||result.version===current.version&&(result.roleId!==current.roleId||result.selectedRoleVersion!==current.selectedRoleVersion))throw corrupt()
  return result
 }
}
