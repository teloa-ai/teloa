import {createHash,randomBytes,randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {roleSupportsScope,taskInput,WorkError} from '@teloa/contract'
import {EmployeeApiError,employeeApiEndpoint,employeeApiId,employeeApiPermissions,type EmployeeApiPermission} from '../../../sdk/contract.mjs'
import {readStoredRole} from './roles.ts'
import {assertBusinessScopeRegistered} from './business-scopes.ts'

/** 数据库只存高熵 API Key 的摘要；回调签名密钥由宿主凭据提供方加密保存。 */
export type EmployeeIntegration={id:string;name:string;employeeId:string;employeeVersion:number;scope:string;permissions:EmployeeApiPermission[];maxConcurrent:number;expiresAt:string;revokedAt:string|null;webhookUrl:string|null;createdAt:string;updatedAt:string}
export type EmployeeIntegrationIdentity=EmployeeIntegration&{ownerId:string;tokenHash:string}
export type IntegrationSecrets={write:(id:string,secret:string)=>Promise<void>;read:(id:string)=>Promise<string|undefined>;remove:(id:string)=>Promise<void>}
const digest=(text:string)=>createHash('sha256').update(text).digest('hex')
const key=()=> 'teloa_api_'+randomBytes(32).toString('base64url')
const instant=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw new WorkError('teloa/storage-corrupt','集成凭据记录损坏。');return value.toISOString()}
export async function initializeEmployeeIntegrations(pool:Pool){await pool.query(`
 create table if not exists teloa_employee_integrations(
  id uuid primary key,owner_id text not null,name text not null,role_id uuid not null,role_version integer not null check(role_version>0),
  scope text not null,permissions jsonb not null,max_concurrent integer not null check(max_concurrent between 1 and 4),
  token_hash text not null unique check(token_hash ~ '^[a-f0-9]{64}$'),expires_at timestamptz not null,revoked_at timestamptz,
  webhook_url text,created_at timestamptz not null,updated_at timestamptz not null,
  unique(owner_id,id),foreign key(role_id,owner_id) references teloa_roles(id,owner_id)
 );
 create index if not exists teloa_employee_integrations_owner on teloa_employee_integrations(owner_id,created_at);
`)}
export function readEmployeeIntegration(row:Record<string,unknown>):EmployeeIntegrationIdentity{
 try{
  const permissions=row.permissions as EmployeeApiPermission[]
  if(typeof row.name!=='string'||!row.name.trim()||typeof row.owner_id!=='string'||!row.owner_id||typeof row.scope!=='string'||!Array.isArray(permissions)||!permissions.includes('read')||new Set(permissions).size!==permissions.length||permissions.some(p=>!employeeApiPermissions.includes(p))||!Number.isSafeInteger(row.role_version)||Number(row.role_version)<1||!Number.isSafeInteger(row.max_concurrent)||Number(row.max_concurrent)<1||Number(row.max_concurrent)>4||typeof row.token_hash!=='string'||!/^[a-f0-9]{64}$/.test(row.token_hash))throw Error()
  return {id:employeeApiId(row.id),ownerId:row.owner_id,name:row.name,employeeId:employeeApiId(row.role_id),employeeVersion:Number(row.role_version),scope:row.scope,permissions,maxConcurrent:Number(row.max_concurrent),expiresAt:instant(row.expires_at),revokedAt:row.revoked_at===null?null:instant(row.revoked_at),webhookUrl:row.webhook_url===null?null:employeeApiEndpoint(String(row.webhook_url)),createdAt:instant(row.created_at),updatedAt:instant(row.updated_at),tokenHash:row.token_hash}
 }catch{throw new WorkError('teloa/storage-corrupt','集成凭据记录损坏，已停止使用。')}
}
export function publicEmployeeIntegration({ownerId:_owner,tokenHash:_hash,...value}:EmployeeIntegrationIdentity):EmployeeIntegration{return value}
export class EmployeeIntegrationService{
 readonly pool:Pool;readonly secrets:IntegrationSecrets;readonly now:()=>Date
 constructor(pool:Pool,secrets:IntegrationSecrets,now:()=>Date=()=>new Date()){this.pool=pool;this.secrets=secrets;this.now=now}
 async list(owner:string){return (await this.pool.query('select * from teloa_employee_integrations where owner_id=$1 order by created_at desc limit 100',[owner])).rows.map(row=>publicEmployeeIntegration(readEmployeeIntegration(row)))}
 /** 仅已认证本人调用，不注册为模型工具；创建凭据不会执行工作。 */
 async create(owner:string,input:unknown){
  const row=taskInput(input,['name','employeeId','expectedEmployeeVersion','scope','permissions','maxConcurrent','expiresInDays','webhookUrl'])
  const employeeId=employeeApiId(row.employeeId),permissions=row.permissions
  if(typeof row.name!=='string'||!row.name.trim()||row.name.length>80||/[\x00-\x1f\x7f]/.test(row.name)||!Number.isSafeInteger(row.expectedEmployeeVersion)||Number(row.expectedEmployeeVersion)<1||typeof row.scope!=='string'||!/^[-A-Za-z0-9_]{1,128}$/.test(row.scope)||!Array.isArray(permissions)||!permissions.includes('read')||new Set(permissions).size!==permissions.length||permissions.some(p=>!employeeApiPermissions.includes(p))||!Number.isSafeInteger(row.maxConcurrent)||Number(row.maxConcurrent)<1||Number(row.maxConcurrent)>4||!Number.isSafeInteger(row.expiresInDays)||Number(row.expiresInDays)<1||Number(row.expiresInDays)>365)throw new WorkError('teloa/invalid-input','请核对集成名称、员工版本、业务范围和授权。')
  const webhookUrl=row.webhookUrl===undefined||row.webhookUrl===''?null:employeeApiEndpoint(String(row.webhookUrl))
  const id=randomUUID(),apiKey=key(),signingSecret=webhookUrl?randomBytes(32).toString('base64url'):undefined,db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['employee-integrations:'+owner])
   const count=Number((await db.query('select count(*) from teloa_employee_integrations where owner_id=$1 and revoked_at is null',[owner])).rows[0].count)
   if(count>=100)throw new WorkError('teloa/conflict','请先撤销不再使用的集成凭据。')
   const stored=(await db.query('select * from teloa_roles where owner_id=$1 and id=$2 for share',[owner,employeeId])).rows[0]
   if(!stored)throw new WorkError('teloa/forbidden','员工不属于当前本人。')
   const role=readStoredRole(stored)
   if(role.kind!=='employee'||role.state!=='active'||!role.responsibility||role.version!==row.expectedEmployeeVersion||!roleSupportsScope(role.scopes,row.scope))throw new WorkError('teloa/version-conflict','请先核对在岗员工的完整职责、版本与业务范围。')
   await assertBusinessScopeRegistered(db,owner,row.scope)
   const now=this.now(),expires=new Date(now.getTime()+Number(row.expiresInDays)*86_400_000)
   if(signingSecret)await this.secrets.write(id,signingSecret)
   const saved=(await db.query('insert into teloa_employee_integrations(id,owner_id,name,role_id,role_version,scope,permissions,max_concurrent,token_hash,expires_at,webhook_url,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12) returning *',[id,owner,row.name.trim(),employeeId,role.version,row.scope,JSON.stringify(permissions),row.maxConcurrent,digest(apiKey),expires,webhookUrl,now])).rows[0]
   await db.query('commit');return {integration:publicEmployeeIntegration(readEmployeeIntegration(saved)),apiKey,...signingSecret?{signingSecret}:{}}
  }catch(error){await db.query('rollback');if(signingSecret)await this.secrets.remove(id);throw error}finally{db.release()}
 }
 async rotate(owner:string,input:unknown){
  const row=taskInput(input,['id']),id=employeeApiId(row.id),apiKey=key(),db=await this.pool.connect()
  try{await db.query('begin');const current=(await db.query('select * from teloa_employee_integrations where owner_id=$1 and id=$2 for update',[owner,id])).rows[0]
   if(!current||current.revoked_at!==null||current.expires_at<=this.now())throw new WorkError('teloa/forbidden','集成已失效；请重新创建并核对授权。')
   const saved=(await db.query('update teloa_employee_integrations set token_hash=$3,updated_at=$4 where owner_id=$1 and id=$2 returning *',[owner,id,digest(apiKey),this.now()])).rows[0]
   await db.query('commit');return {integration:publicEmployeeIntegration(readEmployeeIntegration(saved)),apiKey}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async revoke(owner:string,input:unknown){const row=taskInput(input,['id']),id=employeeApiId(row.id);const saved=(await this.pool.query('update teloa_employee_integrations set revoked_at=coalesce(revoked_at,$3),updated_at=$3 where owner_id=$1 and id=$2 returning *',[owner,id,this.now()])).rows[0];if(!saved)throw new WorkError('teloa/not-found','集成凭据不存在。');await this.secrets.remove(id);return publicEmployeeIntegration(readEmployeeIntegration(saved))}
 async authenticate(apiKey:string):Promise<EmployeeIntegrationIdentity>{
  if(!/^teloa_api_[A-Za-z0-9_-]{43}$/.test(apiKey))throw new EmployeeApiError('unauthorized','Invalid or expired integration key.',401)
  const row=(await this.pool.query('select * from teloa_employee_integrations where token_hash=$1 and revoked_at is null and expires_at>$2',[digest(apiKey),this.now()])).rows[0]
  if(!row)throw new EmployeeApiError('unauthorized','Invalid or expired integration key.',401)
  return readEmployeeIntegration(row)
 }
 async current(db:Pool|PoolClient,expected:EmployeeIntegrationIdentity,permission:EmployeeApiPermission,lock=false){
  const row=(await db.query('select * from teloa_employee_integrations where owner_id=$1 and id=$2'+(lock?' for share':''),[expected.ownerId,expected.id])).rows[0]
  if(!row)throw new EmployeeApiError('unauthorized','Integration key is no longer active.',401)
  const current=readEmployeeIntegration(row)
  if(current.tokenHash!==expected.tokenHash||current.revokedAt!==null||Date.parse(current.expiresAt)<=this.now().getTime())throw new EmployeeApiError('unauthorized','Integration key is no longer active.',401)
  if(!current.permissions.includes(permission))throw new EmployeeApiError('forbidden','This integration has not been granted '+permission+' permission.',403)
  return current
 }
}
