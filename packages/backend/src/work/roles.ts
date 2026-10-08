import type { Pool,PoolClient } from 'pg'
import { WorkError,roleInput,roleDefinition,roleWriteDefinition,type DigitalRole } from '@teloa/contract'
import { ensureAutoDreamPlan,type AutoDreamPorts } from './auto-dream-plans.ts'
import { renewRoleGrants } from './collaboration.ts'
import {workAccess} from './work-access.ts'
import {assertRoleDelegationsInactive} from './role-delegations.ts'
import {invalidateRoleWorkEligibility} from './twin-execution-consents.ts'

export async function initializeRoles(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_roles (
  id uuid primary key,owner_id text not null,request_id uuid not null,
  request_spec jsonb not null,definition jsonb not null,
  version integer not null check(version>0),state text not null check(state in ('active','paused','retired')),
  created_at timestamptz not null,updated_at timestamptz not null,
  unique(owner_id,request_id),check(jsonb_typeof(definition)='object'),check(jsonb_typeof(request_spec)='object')
 );
 create table if not exists teloa_role_edits (
  role_id uuid not null references teloa_roles(id),base_version integer not null check(base_version>0),
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  result jsonb not null check(jsonb_typeof(result)='object'),primary key(role_id,base_version)
 )`)
}
const uuid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(v)
function ownerId(value:string){if(typeof value!=='string'||!value.trim()||value.length>128)throw new WorkError('teloa/forbidden','需要有效的本人身份。');return value}
/**
 * 分身是个人空间固有的本人代拟入口，而不是用户招聘的岗位。
 * 固定 requestId 让首启、重启和并发装配都收敛到同一条记录。
 */
const personalTwinRequestId='00000000-0000-4000-8000-000000000001'
const personalTwinFields={
 name:'我的分身',kind:'twin' as const,scopes:['general'],
 duty:'按本人确认的偏好整理资料、代拟回复和判断建议。正式批准由本人完成。',
 dataScope:'本人可见且明确提供的资料；私人偏好不自动共享。',
 executionScope:'仅代拟；不能代批、冒充本人或直接外发。',
 // `knowledge` 保存的是资料中心资源 ID，不能用一句说明文字冒充资料引用。
 // 分身的本人偏好由判断力样本承载；未显式保存为资料时保持为空。
 // 代拟与判断属于职责，不伪装成尚未安装的原生 Skill；本人可另行选择真实技能。
 skills:[],knowledge:[],
 responsibility:{
  triggers:['本人需要整理资料、代拟回复或判断建议'],
  autonomousActions:['整理已明确提供的资料并形成候选稿'],
  confirmationPoints:['保存、发送或影响外部对象前交回本人确认'],
  escalationRules:['资料不足、偏好冲突或结论不确定时说明阻塞'],
  deliveryChecks:['候选稿标明依据、待确认事项与不可代替的本人决定'],
 },
}
export function readStoredRole(row:Record<string,unknown>):DigitalRole{
 try{
  const fields=roleDefinition(row.definition)
  if(!uuid(row.id)||typeof row.owner_id!=='string'||!row.owner_id||!Number.isSafeInteger(row.version)||(row.version as number)<1||!['active','paused','retired'].includes(String(row.state)))throw Error('invalid')
  const date=(v:unknown)=>{if(!(v instanceof Date)||!Number.isFinite(v.getTime()))throw Error('invalid');return v.toISOString()}
  return {...fields,id:row.id,ownerId:row.owner_id,version:row.version as number,state:row.state as DigitalRole['state'],createdAt:date(row.created_at),updatedAt:date(row.updated_at)}
 }catch{throw new WorkError('teloa/storage-corrupt','员工记录损坏，已停止读取；请核对原记录。')}
}
/** 编辑入参的四步校验：`edit` 在取连接前先跑一遍，`editInTransaction` 自己也跑，两个入口的拒绝完全一致。 */
function editInput(owner:string,input:unknown){
 ownerId(owner);const row=roleInput(input,['roleId','expectedVersion','fields']),definition=roleWriteDefinition(row.fields)
 if(!uuid(row.roleId)||!Number.isSafeInteger(row.expectedVersion)||(row.expectedVersion as number)<1)throw new WorkError('teloa/invalid-input','员工身份或版本不合法。')
 return {row,definition}
}
export class RoleService{
 readonly pool:Pool
 readonly identity:{id:()=>string;now:()=>string}
 /** Auto Dream 的系统计划端口：装配期接上才建计划，未接线的装配（行业模板、旧测试）照旧只写岗位。 */
 readonly autoDream:AutoDreamPorts|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},autoDream?:AutoDreamPorts){this.pool=pool;this.identity=identity;this.autoDream=autoDream}
 async findByRequest(owner:string,input:unknown):Promise<DigitalRole|null>{
  ownerId(owner);const row=roleInput(input,['requestId','expectedFields']);if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','需要有效的创建请求 ID。');const expected=roleDefinition(row.expectedFields)
  const found=(await this.pool.query('select *,request_spec=$3::jsonb as same_request from teloa_roles where owner_id=$1 and request_id=$2',[owner,row.requestId,JSON.stringify(expected)])).rows[0]
  if(!found)return null;if(!found.same_request)throw new WorkError('teloa/storage-corrupt','员工创建请求与固定定义不一致。');return readStoredRole(found)
 }
 async list(owner:string,input:unknown):Promise<DigitalRole[]>{
  ownerId(owner);roleInput(input,[])
  const result=await this.pool.query('select * from teloa_roles where owner_id=$1 order by created_at,id',[owner]);return result.rows.map(readStoredRole)
 }
 async get(owner:string,roleId:string):Promise<DigitalRole|null>{
  ownerId(owner)
  if(!uuid(roleId))throw new WorkError('teloa/invalid-input','员工身份不合法。')
  const row=(await this.pool.query('select * from teloa_roles where owner_id=$1 and id=$2',[owner,roleId])).rows[0]
  return row?readStoredRole(row):null
 }
 /** 个人空间初始化时确保默认分身存在；历史数据已有分身时复用最早一条，以保留其个人记录。 */
 async ensurePersonalTwin(owner:string):Promise<DigitalRole>{
  ownerId(owner)
  const existing=await this.pool.query("select * from teloa_roles where owner_id=$1 and definition->>'kind'='twin' order by created_at,id limit 1",[owner])
  if(existing.rows[0])return readStoredRole(existing.rows[0])
  return (await this.createOrExistingWithAdmission(owner,{requestId:personalTwinRequestId,fields:personalTwinFields},undefined,true)).role
 }
 /**
  * 用户亲手招聘的岗位创建后直接 `active`：新员工直接在岗，不再要求先恢复一次。
  * `options.state` 只留给行业模板实例化这类**非用户亲手**的创建路径显式要求 `paused`，
  * 它不在 `roleInput` 允许键里，所以 `roles/create` 端点无法从外部指定初始状态。
  */
 async create(owner:string,input:unknown,options?:{state?:'active'|'paused'}):Promise<DigitalRole>{return (await this.createOrExisting(owner,input,options)).role}
 /** 同 `create`，另带出本次是否命中同一请求已建的岗位：判定在创建锁内完成，并发同请求恰有一个拿到 `existing:false`。 */
 async createOrExisting(owner:string,input:unknown,options?:{state?:'active'|'paused'}):Promise<{role:DigitalRole;existing:boolean}>{return this.createOrExistingWithAdmission(owner,input,options)}
 private async createOrExistingWithAdmission(owner:string,input:unknown,options?:{state?:'active'|'paused'},systemTwin=false):Promise<{role:DigitalRole;existing:boolean}>{
  ownerId(owner);const row=roleInput(input,['requestId','fields'])
  if(!uuid(row.requestId))throw new WorkError('teloa/invalid-input','需要有效的创建请求 ID。')
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   await client.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['role-create',owner,row.requestId])])
   const existing=(await client.query('select * from teloa_roles where owner_id=$1 and request_id=$2 for update',[owner,row.requestId])).rows[0]
   if(existing){
    let expected:ReturnType<typeof roleDefinition>,stored:ReturnType<typeof roleDefinition>
    try{expected=roleDefinition(row.fields)}catch{throw new WorkError('teloa/invalid-input','员工职责、范围或能力声明不合法。')}
    try{stored=roleDefinition(existing.request_spec)}catch{throw new WorkError('teloa/storage-corrupt','员工创建请求与固定定义不一致。')}
    if(JSON.stringify(stored)!==JSON.stringify(expected))throw new WorkError('teloa/conflict','同一请求不能创建不同的员工。')
    const role=readStoredRole(existing);await client.query('commit');return {role,existing:true}
   }
   const definition=roleWriteDefinition(row.fields),now=this.identity.now()
   // 唯一默认分身初始化不授予使用权；人类招聘、模板建岗均按 people 核对。
   const admission=systemTwin?undefined:await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:row.requestId as string,operation:'create'})
   admission?.assertCurrent()
   const result=await client.query('insert into teloa_roles(id,owner_id,request_id,request_spec,definition,version,state,created_at,updated_at) values($1,$2,$3,$4,$4,1,$6,$5,$5) returning *',[this.identity.id(),owner,row.requestId,JSON.stringify(definition),now,options?.state??'active'])
   const role=readStoredRole(result.rows[0])
   // 接线失败一律回滚整笔岗位创建：不能留下一位没有每日小结的在岗员工。
   if(this.autoDream)await ensureAutoDreamPlan(client,this.autoDream,owner,role)
   admission?.assertCurrent();await client.query('commit');return {role,existing:false}
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 async edit(owner:string,input:unknown):Promise<DigitalRole>{
  editInput(owner,input) // 入参不合法就不占用连接
  const client=await this.pool.connect()
  try{
   await client.query('begin')
   const value=await this.editInTransaction(client,owner,input)
   await client.query('commit');return value
  }catch(error){await client.query('rollback');throw error}finally{client.release()}
 }
 /**
  * 与 `edit` 同一判定、同一编辑回执，只是事务由调用方提供：
  * 行业模板升级按 `use-template` 重放模板字段时，岗位改动必须与继任加载同生共死。
  */
 async editInTransaction(client:PoolClient,owner:string,input:unknown):Promise<DigitalRole>{
  const {row,definition}=editInput(owner,input)
  const result=await client.query('select * from teloa_roles where id=$1 and owner_id=$2 for update',[row.roleId,owner])
  if(!result.rows[0])throw new WorkError('teloa/forbidden','员工不存在或不属于当前本人。')
  const role=readStoredRole(result.rows[0])
  const receipts=await client.query('select *,request_spec=$3::jsonb as same_request from teloa_role_edits where role_id=$1 and base_version=$2',[role.id,row.expectedVersion,JSON.stringify(definition)])
  if(receipts.rows[0]){
   if(!receipts.rows[0].same_request)throw new WorkError('teloa/version-conflict','原版本已保存不同修改，请读取新版本后复核。')
   try{
    const {id,ownerId,version,state,createdAt,updatedAt,...fields}=roleInput(receipts.rows[0].result,['id','ownerId','version','state','createdAt','updatedAt','name','kind','scopes','duty','dataScope','executionScope','skills','knowledge','responsibility','runtimeConfig'])
    if(typeof createdAt!=='string'||typeof updatedAt!=='string')throw Error()
    const saved=readStoredRole({id,owner_id:ownerId,version,state,created_at:new Date(createdAt),updated_at:new Date(updatedAt),definition:fields})
    if(saved.id!==role.id||saved.ownerId!==owner||saved.version!==(row.expectedVersion as number)+1||saved.version>role.version||JSON.stringify(roleWriteDefinition(fields))!==JSON.stringify(definition))throw Error()
    return saved
   }catch{throw new WorkError('teloa/storage-corrupt','员工编辑回执损坏，已停止返回结果，请核对记录。')}
  }
  if(role.version!==row.expectedVersion)throw new WorkError('teloa/version-conflict','员工已被修改，请读取新版本后复核。')
  if(role.state==='retired'||role.kind!==definition.kind)throw new WorkError('teloa/conflict','已退役员工不能修改，员工身份类型不能变更。')
  // 默认个人身份保持 active；停用执行委托与运行收口后才可改分身定义。
  if(role.kind==='twin'){
   if(role.state!=='active')throw new WorkError('teloa/conflict','个人分身身份当前不可配置。')
   await assertRoleDelegationsInactive(client,owner,role)
  }else if(role.state!=='paused')throw new WorkError('teloa/conflict','请先暂停员工并核对关联工作。')
  const admission=await workAccess.authorize({kind:'capability',capability:'people',ownerId:owner,sessionId:null,objectId:role.id,operation:'edit'})
  admission.assertCurrent()
  const now=this.identity.now()
  const updated=await client.query('update teloa_roles set definition=$3,version=version+1,updated_at=$4 where id=$1 and owner_id=$2 returning *',[role.id,owner,JSON.stringify(definition),now])
  const value=readStoredRole(updated.rows[0]);await client.query('insert into teloa_role_edits(role_id,base_version,request_spec,result) values($1,$2,$3,$4)',[role.id,row.expectedVersion,JSON.stringify(definition),JSON.stringify(value)])
  // 岗位版本 +1 会让这位员工在各群的授权整体判 `invalidated`：同一笔事务里按新版本续签，
  // 否则改一次使命就让他在所有群里的「直接回应」静默停摆。
  await renewRoleGrants(client,owner,value,now)
  invalidateRoleWorkEligibility(owner,role.id)
  admission.assertCurrent()
  return value
 }
}
