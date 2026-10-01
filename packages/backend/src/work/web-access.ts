import type {Pool,PoolClient} from 'pg'
import {WorkError,isWebAccessPolicy,readWebAccessEntry,taskInput,webAccessEntryMaxChars,webAccessKinds,webAccessPolicyChangeInput,type WebAccessEntry,type WebAccessKind,type WebAccessPolicy} from '@teloa/contract'

/** 没有任何策略行时的出厂值：上网总开关默认开，拦截名单默认空，版本从 0 起算。连同内层数组一起冻结，调用方拿到的永远是副本。 */
export const webAccessPolicyDefaults:WebAccessPolicy=Object.freeze({version:0,enabled:true,blocked:Object.freeze([] as string[]) as string[]})

const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const actor=(owner:string)=>{if(typeof owner!=='string'||!owner.trim()||owner.length>128)throw new WorkError('teloa/forbidden','需要本人身份。')}
const corrupt=()=>new WorkError('teloa/storage-corrupt','上网策略记录损坏。')
/**
 * 模型给出的参数原文只被存储与展示，不被解析；超长按**码点**截断，绝不切断代理对，不加截断标记。
 * 上限同时压住两条判据里更紧的那条：契约 `readWebAccessEntry` 数 UTF-16 码元（`.length`），
 * DB 的 `check(length(value) between 1 and 512)` 数码点。按码元收边界，两边都过。
 */
const truncate=(value:string):string=>{
 if(value.length<=webAccessEntryMaxChars)return value
 let out=''
 for(const char of value){if(out.length+char.length>webAccessEntryMaxChars)break;out+=char}
 return out
}

export async function initializeWebAccessPolicy(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_web_access_policy(
  owner_id text not null,
  base_version integer not null check(base_version>=0),
  version integer not null check(version=base_version+1),
  enabled boolean not null,
  blocked jsonb not null check(jsonb_typeof(blocked)='array'),
  request_id uuid not null,
  request_spec jsonb not null check(jsonb_typeof(request_spec)='object'),
  created_at timestamptz not null,
  primary key(owner_id,base_version),
  unique(owner_id,request_id)
 )`)
}

/**
 * 运行内上网记录表。外键 `(run_id,owner_id)` 依赖 `teloa_task_run_owner_identity` 这个唯一索引，
 * 它由 `task-run-flows.ts:10` 建出、`task-runs.ts:100` 链式调用——因此本函数只能挂在同一条链上或其后，
 * 放进 `initialize-database.ts` 的顶层会在空库首启时撞 `there is no unique constraint matching given keys`。
 */
export async function initializeTaskRunWebAccess(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_task_run_web_access(
  owner_id text not null,
  run_id uuid not null,
  seq integer not null check(seq>0),
  kind text not null check(kind in ('search','fetch')),
  value text not null check(length(value) between 1 and 512),
  created_at timestamptz not null,
  primary key(owner_id,run_id,seq),
  foreign key(run_id,owner_id) references teloa_task_runs(id,owner_id)
 )`)
 // 「只追加」由 DB 兜底：服务类上没有 update/delete 方法只挡住本仓库的调用方，挡不住任何一条手写 SQL。
 await pool.query(`create or replace function teloa_task_run_web_access_immutable() returns trigger language plpgsql as $$
 begin raise exception '运行内上网记录只追加，不能更新或删除。'; end $$`)
 await pool.query('drop trigger if exists teloa_task_run_web_access_immutable on teloa_task_run_web_access')
 await pool.query('create trigger teloa_task_run_web_access_immutable before update or delete on teloa_task_run_web_access for each row execute function teloa_task_run_web_access_immutable()')
}

/** 策略行 → `WebAccessPolicy`；任何一项判据不过即存储损坏，不做就地修补。 */
export function readWebAccessPolicyRow(row:Record<string,unknown>):WebAccessPolicy{
 const policy={version:row.version,enabled:row.enabled,blocked:row.blocked}
 if(!isWebAccessPolicy(policy))throw corrupt()
 if(!Number.isSafeInteger(row.base_version)||policy.version!==(row.base_version as number)+1)throw corrupt()
 if(!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw corrupt()
 return policy
}

/** 总开关与拦截名单：追加式版本流水，幂等与版本冲突照 `role-tool-grants.ts:37-64` 同法。 */
export class WebAccessPolicyService{
 readonly pool:Pool;readonly now:()=>string
 constructor(pool:Pool,now:()=>string){this.pool=pool;this.now=now}
 async get(owner:string,input:unknown):Promise<WebAccessPolicy>{
  actor(owner);taskInput(input,[])
  return this.getInTransaction(this.pool,owner)
 }
 /**
  * 同一条读法的「调用方已持有连接」版本：运行准备与岗位授权保存都在事务里调这个读口，
  * 在那里走 `this.pool.query` 等于在持锁的事务内再从池里取第二条连接——池 `max:6`、
  * `connectionTimeoutMillis:5000`，六个并发运行准备会互相等到集体超时。判据与 `get` 完全一致。
  */
 async getInTransaction(db:Pool|PoolClient,owner:string):Promise<WebAccessPolicy>{
  actor(owner)
  const rows=await db.query('select * from teloa_web_access_policy where owner_id=$1 order by base_version desc limit 1',[owner])
  return rows.rows[0]?readWebAccessPolicyRow(rows.rows[0]):{...webAccessPolicyDefaults,blocked:[]}
 }
 async change(owner:string,input:unknown):Promise<WebAccessPolicy>{
  actor(owner)
  const request=webAccessPolicyChangeInput(input)
  const spec=JSON.stringify({enabled:request.enabled,blocked:request.blocked}),db=await this.pool.connect()
  try{
   await db.query('begin')
   // 同一位本人的版本流水串行化：主键 (owner_id,base_version) 是兜底，锁是为了让重放走回执而不是撞主键。
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['web-access-policy',owner])])
   const prior=await db.query('select *,request_spec=$4::jsonb as same_request from teloa_web_access_policy where owner_id=$1 and (base_version=$2 or request_id=$3)',[owner,request.expectedVersion,request.requestId,spec])
   // 同一个 requestId 已经用过：内容或版本换了即 `teloa/conflict`，与仓内 `unique(owner_id,request_id)` 九处同口径。
   const used=prior.rows.find(row=>row.request_id===request.requestId)
   if(used){
    if(used.base_version!==request.expectedVersion||!used.same_request)throw new WorkError('teloa/conflict','同一上网策略请求不能更换内容。')
    const receipt=readWebAccessPolicyRow(used);await db.query('commit');return receipt
   }
   // 那个版本已经被别的请求写过：这是版本冲突，不是同请求换内容。
   if(prior.rows.length)throw new WorkError('teloa/version-conflict','原版本已保存不同的上网策略。')
   // 当前版本从最新那一行读出而不是取 max(version)：顺带把损坏行挡在追加之前，不让新版本盖住坏账。
   const latest=await db.query('select * from teloa_web_access_policy where owner_id=$1 order by base_version desc limit 1',[owner])
   const version=latest.rows[0]?readWebAccessPolicyRow(latest.rows[0]).version:0
   if(version!==request.expectedVersion)throw new WorkError('teloa/version-conflict','上网策略已变化，请重新读取。')
   const saved=await db.query('insert into teloa_web_access_policy(owner_id,base_version,version,enabled,blocked,request_id,request_spec,created_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[owner,request.expectedVersion,request.expectedVersion+1,request.enabled,JSON.stringify(request.blocked),request.requestId,spec,this.now()])
   const result=readWebAccessPolicyRow(saved.rows[0]);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

/** 运行内上网记录：派发前逐条写入，只追加，无更新、无删除——运行记录是证据，不是可编辑数据。 */
export class TaskRunWebAccessService{
 readonly pool:Pool;readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}
 async append(owner:string,runId:string,entry:{kind:WebAccessKind;value:string}):Promise<WebAccessEntry>{
  actor(owner)
  if(!uuid(runId))throw new WorkError('teloa/invalid-input','执行身份不正确。')
  if(!(webAccessKinds as readonly string[]).includes(String(entry?.kind)))throw new WorkError('teloa/invalid-input','上网记录类别不正确。')
  if(typeof entry?.value!=='string'||!entry.value)throw new WorkError('teloa/invalid-input','上网记录内容不能为空。')
  const value=truncate(entry.value),db=await this.pool.connect()
  try{
   await db.query('begin')
   await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['task-run-web-access',owner,runId])])
   const run=await db.query('select id from teloa_task_runs where id=$1 and owner_id=$2 for share',[runId,owner])
   if(!run.rows[0])throw new WorkError('teloa/forbidden','执行不属于本人。')
   const saved=await db.query('insert into teloa_task_run_web_access(owner_id,run_id,seq,kind,value,created_at) select $1,$2,coalesce(max(seq),0)+1,$3,$4,$5 from teloa_task_run_web_access where owner_id=$1 and run_id=$2 returning *',[owner,runId,entry.kind,value,this.identity.now()])
   const result=read(saved.rows[0]);await db.query('commit');return result
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 async listMany(owner:string,runIds:readonly string[]):Promise<Map<string,WebAccessEntry[]>>{
  actor(owner)
  if(runIds.some(id=>!uuid(id))||new Set(runIds).size!==runIds.length)throw new WorkError('teloa/invalid-input','执行身份不正确。')
  const grouped=new Map<string,WebAccessEntry[]>();if(!runIds.length)return grouped
  const owned=await this.pool.query('select id from teloa_task_runs where owner_id=$1 and id=any($2::uuid[])',[owner,runIds])
  if(owned.rows.length!==runIds.length)throw new WorkError('teloa/forbidden','执行不属于本人。')
  const rows=await this.pool.query('select * from teloa_task_run_web_access where owner_id=$1 and run_id=any($2::uuid[]) order by run_id,seq',[owner,runIds])
  for(const row of rows.rows){const items=grouped.get(String(row.run_id))??[];items.push(read(row));grouped.set(String(row.run_id),items)}
  return grouped
 }
}

function read(row:Record<string,unknown>):WebAccessEntry{
 if(!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime()))throw new WorkError('teloa/storage-corrupt','上网记录损坏，已停止读取。')
 try{return readWebAccessEntry({kind:row.kind,value:row.value,at:row.created_at.toISOString()})}
 catch{throw new WorkError('teloa/storage-corrupt','上网记录损坏，已停止读取。')}
}
