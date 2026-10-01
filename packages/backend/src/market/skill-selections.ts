import type {Pool,PoolClient} from 'pg'
import {WorkError} from '@teloa/contract'

export type SkillSelection={ownerId:string;nativeName:string;installationId:string;version:number;updatedAt:string}

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const name=(value:unknown):value is string=>typeof value==='string'&&/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const corrupt=()=>new WorkError('teloa/storage-corrupt','技能当前版本选择损坏，已停止读取。')
const stamp=(value:unknown)=>{if(!(value instanceof Date)||!Number.isFinite(value.getTime()))throw corrupt();return value.toISOString()}

export function readStoredSkillSelection(row:Record<string,unknown>,ownerId:string):SkillSelection{
 if(row.owner_id!==ownerId||!name(row.native_name)||!uuid(row.installation_id)||!positive(row.version))throw corrupt()
 return {ownerId,nativeName:row.native_name,installationId:row.installation_id,version:row.version,updatedAt:stamp(row.updated_at)}
}

/** 首次迁移在旧同名唯一约束仍存在时固定当前选择，再放开不可变多版本安装。 */
export async function initializeSkillSelections(pool:Pool):Promise<void>{
 const db=await pool.connect()
 try{
  await db.query('begin')
  await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',['teloa/skill-selection-migrations'])
  await db.query(`
   create unique index if not exists teloa_skill_installations_identity_owner on teloa_skill_installations(id,owner_id);
   create table if not exists teloa_skill_selections(
    owner_id text not null,native_name text not null,installation_id uuid not null,version integer not null check(version>0),updated_at timestamptz not null,
    primary key(owner_id,native_name),foreign key(installation_id,owner_id) references teloa_skill_installations(id,owner_id)
   );
   create table if not exists teloa_skill_selection_migrations(name text primary key,applied_at timestamptz not null);
   create table if not exists teloa_skill_selection_requests(
    owner_id text not null,request_id uuid not null,native_name text not null,current_installation_id uuid not null,target_installation_id uuid not null,
    request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),impact_snapshot jsonb not null check(jsonb_typeof(impact_snapshot)='object'),
    impact_digest text not null check(impact_digest ~ '^[a-f0-9]{64}$'),result jsonb not null check(jsonb_typeof(result)='object'),
    receipt_digest text not null check(receipt_digest ~ '^[a-f0-9]{64}$'),created_at timestamptz not null,
    primary key(owner_id,request_id),
    foreign key(current_installation_id,owner_id) references teloa_skill_installations(id,owner_id),
    foreign key(target_installation_id,owner_id) references teloa_skill_installations(id,owner_id)
   );
  `)
  const first=await db.query("insert into teloa_skill_selection_migrations(name,applied_at) values('initial-installation-selection-v1',clock_timestamp()) on conflict(name) do nothing returning name")
  if(first.rowCount){
   const duplicate=await db.query('select owner_id,native_name from teloa_skill_installations group by owner_id,native_name having count(*)>1 limit 1')
   if(duplicate.rows[0])throw corrupt()
   await db.query('insert into teloa_skill_selections(owner_id,native_name,installation_id,version,updated_at) select owner_id,native_name,id,1,updated_at from teloa_skill_installations')
  }
  await db.query('alter table teloa_skill_installations drop constraint if exists teloa_skill_installations_owner_id_native_name_key')
  await db.query('create index if not exists teloa_skill_installations_owner_native_name on teloa_skill_installations(owner_id,native_name)')
  await db.query('commit')
 }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
}

export async function readSkillSelection(db:PoolClient,ownerId:string,nativeName:string):Promise<SkillSelection|undefined>{
 const row=(await db.query('select * from teloa_skill_selections where owner_id=$1 and native_name=$2',[ownerId,nativeName])).rows[0]
 return row?readStoredSkillSelection(row,ownerId):undefined
}

/** 新名称首次安装成功后成为默认；已有名称的新版本只准备，不自动切换。 */
export async function ensureInitialSkillSelection(db:PoolClient,ownerId:string,installation:{id:string;ownerId:string;state:string;native:{name:string}},updatedAt:string):Promise<SkillSelection>{
 if(installation.ownerId!==ownerId||installation.state!=='installed'||!uuid(installation.id)||!name(installation.native.name)||!Number.isFinite(Date.parse(updatedAt))||new Date(updatedAt).toISOString()!==updatedAt)throw corrupt()
 await db.query('insert into teloa_skill_selections(owner_id,native_name,installation_id,version,updated_at) values($1,$2,$3,1,$4) on conflict(owner_id,native_name) do nothing',[ownerId,installation.native.name,installation.id,updatedAt])
 const selected=await readSkillSelection(db,ownerId,installation.native.name)
 if(!selected)throw corrupt()
 const row=(await db.query('select owner_id,native_name,state from teloa_skill_installations where id=$1',[selected.installationId])).rows[0]
 if(!row||row.owner_id!==ownerId||row.native_name!==installation.native.name||row.state!=='installed')throw corrupt()
 return selected
}
