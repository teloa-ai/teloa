import type {Pool,PoolClient} from 'pg'
import {WorkError,taskInput,readTaskToolArgumentRules,type TaskToolArgumentRule,type DigitalRole} from '@teloa/contract'
import {readStoredRole} from './roles.ts'
import {renewRoleGrants} from './collaboration.ts'
export type RoleToolGrant={roleId:string;roleVersion:number;state:'active'|'revoked';rules:TaskToolArgumentRule[];createdAt:string}
export async function initializeRoleToolGrants(pool:Pool){await pool.query(`create table if not exists teloa_role_tool_grants(
 role_id uuid not null references teloa_roles(id),base_version integer not null check(base_version>0),
 role_version integer not null check(role_version=base_version+1),state text not null check(state in ('active','revoked')),
 rules jsonb not null,request_spec jsonb not null,created_at timestamptz not null,
 primary key(role_id,base_version))`)}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
export function readRoleToolGrant(row:Record<string,unknown>):RoleToolGrant{
 try{
  const rules=readTaskToolArgumentRules(row.rules),spec=taskInput(row.request_spec,['action','rules'])
  if(spec.action!==(row.state==='active'?'save':'revoke')||JSON.stringify(readTaskToolArgumentRules(spec.rules))!==JSON.stringify(rules))throw Error()
  if(!uuid(row.role_id)||!Number.isSafeInteger(row.role_version)||(row.role_version as number)<2||row.role_version!==(row.base_version as number)+1||!['active','revoked'].includes(String(row.state))||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||row.state==='revoked'&&rules.length)throw Error()
  return {roleId:row.role_id,roleVersion:row.role_version as number,state:row.state as 'active'|'revoked',rules,createdAt:row.created_at.toISOString()}
 }catch{throw new WorkError('teloa/storage-corrupt','员工工具授权记录损坏。')}
}
/** validate 由宿主能力目录提供，不能按客户端自报的工具风险放行。 */
export class RoleToolGrantService{
 readonly pool:Pool;readonly now:()=>string;readonly validate:(db:PoolClient,owner:string,role:DigitalRole,rules:TaskToolArgumentRule[])=>Promise<void>
 constructor(pool:Pool,now:()=>string,validate:(db:PoolClient,owner:string,role:DigitalRole,rules:TaskToolArgumentRule[])=>Promise<void>){this.pool=pool;this.now=now;this.validate=validate}
 async get(owner:string,input:unknown):Promise<{roleVersion:number;grant:RoleToolGrant|null}>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')
  const row=taskInput(input,['roleId']);if(!uuid(row.roleId))throw new WorkError('teloa/invalid-input','员工身份不正确。')
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   const found=await db.query('select * from teloa_roles where id=$1 and owner_id=$2 for share',[row.roleId,owner])
   if(!found.rows[0])throw new WorkError('teloa/forbidden','员工不属于当前本人。')
   const role=readStoredRole(found.rows[0]),rows=await db.query('select * from teloa_role_tool_grants where role_id=$1 order by role_version desc limit 1',[role.id])
   const grant=rows.rows[0]?readRoleToolGrant(rows.rows[0]):null
   if(grant&&grant.roleVersion>role.version)throw new WorkError('teloa/storage-corrupt','授权版本高于员工版本。')
   await db.query('commit');return {roleVersion:role.version,grant}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async change(owner:string,input:unknown):Promise<RoleToolGrant>{
  if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')
  const row=taskInput(input,['roleId','expectedRoleVersion','action','rules'])
  if(!uuid(row.roleId)||!Number.isSafeInteger(row.expectedRoleVersion)||(row.expectedRoleVersion as number)<1||!['save','revoke'].includes(String(row.action)))throw new WorkError('teloa/invalid-input','员工授权操作或版本不正确。')
  let rules:TaskToolArgumentRule[]
  try{rules=readTaskToolArgumentRules(row.rules)}catch{throw new WorkError('teloa/invalid-input','工具参数范围不正确。')}
  if(row.action==='revoke'&&rules.length||row.action==='save'&&!rules.length)throw new WorkError('teloa/invalid-input','保存需明确工具范围，撤销不能附带授权。')
  const spec=JSON.stringify({action:row.action,rules}),db=await this.pool.connect()
  try{
   await db.query('begin')
   const found=await db.query('select * from teloa_roles where id=$1 and owner_id=$2 for update',[row.roleId,owner])
   if(!found.rows[0])throw new WorkError('teloa/forbidden','员工不属于当前本人。')
   const role=readStoredRole(found.rows[0])
   const prior=await db.query('select *,request_spec=$3::jsonb as same_request from teloa_role_tool_grants where role_id=$1 and base_version=$2',[role.id,row.expectedRoleVersion,spec])
   if(prior.rows[0]){
    if(!prior.rows[0].same_request)throw new WorkError('teloa/version-conflict','原员工版本已保存不同授权。')
    const receipt=readRoleToolGrant(prior.rows[0]);if(receipt.roleVersion>role.version)throw new WorkError('teloa/storage-corrupt','授权版本高于员工版本。')
    await db.query('commit');return receipt
   }
   if(role.version!==row.expectedRoleVersion)throw new WorkError('teloa/version-conflict','员工已变化，请重新读取。')
   if(row.action==='save'&&(role.state!=='paused'||role.kind!=='employee'))throw new WorkError('teloa/conflict','请暂停员工后配置工具授权。')
   if(row.action==='save')await this.validate(db,owner,role,rules)
   const state=row.action==='save'?'active':'revoked',now=this.now()
   const saved=await db.query('insert into teloa_role_tool_grants(role_id,base_version,role_version,state,rules,request_spec,created_at) values($1,$2,$3,$4,$5,$6,$7) returning *',[role.id,role.version,role.version+1,state,JSON.stringify(rules),spec,now])
   const bumped=await db.query('update teloa_roles set version=version+1,updated_at=$2 where id=$1 returning *',[role.id,now])
   // 保存与撤销都把岗位版本 +1，群授权因此整体判 `invalidated`（与改岗位定义、恢复在岗同一根因）。
   // 撤销这一支在岗时也能调：不续签的话，本人在岗位详情里撤一次工具授权，就停掉了他在所有群的直接回应。
   await renewRoleGrants(db,owner,readStoredRole(bumped.rows[0]),now)
   const result=readRoleToolGrant(saved.rows[0]);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
