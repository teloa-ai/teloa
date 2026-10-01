import type {Pool,PoolClient} from 'pg'
import {WorkError,readBusinessSpaceRenameInput,type BusinessSpaceKind,type BusinessSpaceRecord} from '@teloa/contract'
import {BusinessScopeService,initializeBusinessScopes} from './business-scopes.ts'
import {initializeBusinessSpaceMigrations,migrateToPersonalSpace} from './business-space-migration.ts'
import type {IndustryLoadPlanPort} from './industry-load-retire.ts'

/** 个人空间的默认名称（用户 2026-09-15 确认）；建好后可改名，这里只是首次引导的取值。 */
const personalName='我的工作空间'
const kinds:readonly string[]=['personal','team']
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value.length<=max
const positive=(value:unknown):value is number=>Number.isSafeInteger(Number(value))&&Number(value)>0&&Number(value)<=2147483647
const invalid=()=>new WorkError('teloa/invalid-input','业务空间请求格式不正确。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','业务空间记录损坏，已停止读取。')
const owner=(value:string)=>{if(!text(value,128))throw new WorkError('teloa/forbidden','需要有效的本人身份。')}
const missing=()=>new WorkError('teloa/dependency-unavailable','本人工作空间尚未引导，请稍后重试。')
const stamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}
const read=(row:Record<string,unknown>):BusinessSpaceRecord=>{
 if(!uuid(row.id)||!text(row.name,80)||typeof row.description!=='string'||row.description.length>2000||!positive(row.version)||!kinds.includes(String(row.kind)))throw corrupt()
 return {id:row.id,name:row.name,description:row.description,version:Number(row.version),kind:row.kind as BusinessSpaceKind,createdAt:stamp(row.created_at),updatedAt:stamp(row.updated_at)}
}

/**
 * 业务空间的建表与演进：空间表本身也在这里定义，`initializeIndustryLoads` 先调用本函数再建加载表，
 * 因此只调加载初始化的既有调用方同样拿到 `kind` 列与唯一索引。所有语句幂等可重跑。
 * `kind` 默认 `team`：旧代码与存量行照旧可读，个人空间由 `ensurePersonal` 显式标注。
 */
export async function initializeBusinessSpaces(pool:Pool):Promise<void>{await pool.query(`
 create table if not exists teloa_business_spaces(id uuid primary key,owner_id text not null,name text not null,description text not null,version integer not null check(version>0),created_at timestamptz not null,updated_at timestamptz not null,unique(id,owner_id));
 alter table teloa_business_spaces add column if not exists kind text not null default 'team';
 alter table teloa_business_spaces drop constraint if exists teloa_business_spaces_kind_check;
 alter table teloa_business_spaces add constraint teloa_business_spaces_kind_check check(kind in ('personal','team'));
 create unique index if not exists teloa_business_spaces_personal on teloa_business_spaces(owner_id) where kind='personal';
 create table if not exists teloa_business_space_edits(owner_id text not null,request_id uuid not null,request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),space_id uuid not null,primary key(owner_id,request_id),foreign key(space_id,owner_id) references teloa_business_spaces(id,owner_id));
 `)
 // 范围标签表的外键指向空间表，必须在空间表之后建；与空间表同进同退，只调加载初始化的既有调用方照样拿到它。
 await initializeBusinessScopes(pool)
 // 迁移回执表与空间表同进同退：`ensurePersonal` 会在引导之后就地收敛存量多空间数据，回执表必须已经在场。
 await initializeBusinessSpaceMigrations(pool)
}

/** 本人空间的读写：个人版恒为一个 `kind='personal'` 的空间，创建与改名都只认本人身份。 */
export class BusinessSpaceService{
 readonly pool:Pool;readonly identity:{id:()=>string;now:()=>string}
 /** 只有存量迁移里退役重复加载时需要：它要按卸载协议暂停那条加载创建的持续计划。未接入时确有在效计划即显式失败。 */
 readonly plans:IndustryLoadPlanPort|undefined
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},plans?:IndustryLoadPlanPort){this.pool=pool;this.identity=identity;this.plans=plans}
 /**
  * 宿主装配时调用一次；并发调用由事务级咨询锁与 `(owner_id) where kind='personal'` 唯一索引共同保证只落一行。
  * 引导之后在同一事务里跑一次存量多空间迁移：旧库上启动即收敛，新库上是纯无操作。
  * 迁移只放在这个入口，`ensurePersonalInTransaction` 保持成纯引导，不在别人的事务里夹带搬数据。
  */
 async ensurePersonal(ownerId:string):Promise<BusinessSpaceRecord>{
  const db=await this.pool.connect()
  try{await db.query('begin');const result=await this.ensurePersonalInTransaction(db,ownerId);await migrateToPersonalSpace(db,ownerId,{plans:this.plans});await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 /**
  * 引导本人空间并登记内置范围标签。
  * 存量 ≥2 行时其余行保持 `team`，加载归属不动——合并加载与登记 `scope` 标签是迁移任务的事，这里只保证本人空间与内置范围就位。
  */
 async ensurePersonalInTransaction(db:PoolClient,ownerId:string):Promise<BusinessSpaceRecord>{
  owner(ownerId)
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['business-space-personal',ownerId])])
  const space=await this.personalInTransaction(db,ownerId)
  // 本人空间一存在就登记内置范围：此后任何写入校验都能在标签表里找到 general/SOC/AppSec，
  // 存量 `Design` 也在这里补成历史标签，校验不必为"还没登记过"开特例。
  await BusinessScopeService.ensureBuiltin(db,ownerId,space.id)
  return space
 }
 /** 引导本身：已有 `personal` 行直接返回；存量 0 行新建；否则把 `created_at` 最早的一行标为 `personal`。 */
 private async personalInTransaction(db:PoolClient,ownerId:string):Promise<BusinessSpaceRecord>{
  const existing=(await db.query("select * from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0]
  if(existing)return read(existing)
  const earliest=(await db.query('select id from teloa_business_spaces where owner_id=$1 order by created_at,id limit 1',[ownerId])).rows[0]
  if(earliest)return read((await db.query("update teloa_business_spaces set kind='personal' where id=$1 and owner_id=$2 returning *",[earliest.id,ownerId])).rows[0])
  const id=this.identity.id(),now=this.identity.now()
  if(!uuid(id)||!Number.isFinite(Date.parse(now)))throw invalid()
  // 部分唯一索引兜底：咨询锁之外若仍有并发抢先落行，这里不报错而是回读那一行。
  const inserted=(await db.query("insert into teloa_business_spaces(id,owner_id,name,description,version,created_at,updated_at,kind) values($1,$2,$3,'',1,$4,$4,'personal') on conflict (owner_id) where kind='personal' do nothing returning *",[id.toLowerCase(),ownerId,personalName,now])).rows[0]
  if(inserted)return read(inserted)
  const settled=(await db.query("select * from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0]
  if(!settled)throw corrupt()
  return read(settled)
 }
 /** 读本人空间；尚未引导时是装配顺序问题，显式失败而不是凭空造一行。 */
 async current(ownerId:string):Promise<BusinessSpaceRecord>{
  owner(ownerId)
  const row=(await this.pool.query("select * from teloa_business_spaces where owner_id=$1 and kind='personal'",[ownerId])).rows[0]
  if(!row)throw missing()
  return read(row)
 }
 /**
  * 改本人空间的名称与描述：先按 (本人,请求) 复放回执，同请求异内容一律 `teloa/conflict`；
  * 通过后在同一事务里 `for update` 锁住空间行核对期望版本，版本不符 `teloa/version-conflict`。
  * 入参不合法（名称空或超长）在任何写之前就被拒，回执与空间行都不会留下痕迹。
  */
 async rename(ownerId:string,value:unknown):Promise<BusinessSpaceRecord>{
  owner(ownerId);const data=readBusinessSpaceRenameInput(value)
  const spec={expectedVersion:data.expectedVersion,name:data.name,description:data.description}
  const query='select *,request_spec=$3::jsonb as same_request from teloa_business_space_edits where owner_id=$1 and request_id=$2'
  const replay=async(db:Pool|PoolClient,receipt:Record<string,unknown>):Promise<BusinessSpaceRecord>=>{
   if(!receipt.same_request)throw new WorkError('teloa/conflict','同一改名请求不能更换名称、描述或期望版本。')
   const row=(await db.query('select * from teloa_business_spaces where id=$1 and owner_id=$2',[receipt.space_id,ownerId])).rows[0]
   if(!row)throw corrupt()
   const result=read(row)
   // 回执只证明那一次改名已落库；此后可能还有别的改名，因此只核对版本确实越过了当时的期望版本。
   if(result.version<=data.expectedVersion)throw corrupt()
   return result
  }
  const initial=(await this.pool.query(query,[ownerId,data.requestId,JSON.stringify(spec)])).rows[0]
  if(initial)return replay(this.pool,initial)
  const now=this.identity.now();if(!Number.isFinite(Date.parse(now)))throw invalid()
  const db=await this.pool.connect()
  try{
   await db.query('begin');await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['business-space-rename',ownerId,data.requestId])])
   const receipt=(await db.query(query,[ownerId,data.requestId,JSON.stringify(spec)])).rows[0]
   if(receipt){const result=await replay(db,receipt);await db.query('commit');return result}
   const locked=(await db.query("select * from teloa_business_spaces where owner_id=$1 and kind='personal' for update",[ownerId])).rows[0]
   if(!locked)throw missing()
   if(Number(locked.version)!==data.expectedVersion)throw new WorkError('teloa/version-conflict','业务空间已被更新，请重新核对后再改名。')
   const updated=(await db.query('update teloa_business_spaces set name=$3,description=$4,version=version+1,updated_at=$5 where id=$1 and owner_id=$2 returning *',[locked.id,ownerId,data.name,data.description,now])).rows[0]
   await db.query('insert into teloa_business_space_edits values($1,$2,$3,$4)',[ownerId,data.requestId,JSON.stringify(spec),locked.id])
   const result=read(updated);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}
