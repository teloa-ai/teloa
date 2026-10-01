import type {Pool,PoolClient} from 'pg'
import {WorkError,businessDashboardLimits} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from './business-data.ts'

/**
 * 快照数据仓语义（规格 §4.2）：唯一真源仍是 `teloa_business_object_snapshots`，这里只补「当前版本」「tombstone」
 * 「保留清理」「配额」四条语义与改写器要用的四个安全转换函数，不建视图、不为对象类型建表。
 *
 * 函数与表建在应用连接的当前模式（Teloa 表所在模式，个人版为 public，验收宿主为独立 schema），应用连接上的读写不限定模式名；
 * 看板计算的只读事务 `search_path=pg_temp`，改写产物里的表与函数按该模式名限定（`currentVersionSubquery` 的 schema 参数）。
 */
export const businessSafeFunctions=['teloa_safe_numeric','teloa_safe_timestamptz','teloa_safe_boolean','teloa_safe_duration_seconds'] as const

/** 每批最多删这么多行：保留清理不在一条语句里锁住整张表。 */
const pruneBatch=5000
const day=86_400_000
const invalidInput=(message:string)=>new WorkError('teloa/invalid-input',message)
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)

/**
 * 四个函数都是 `immutable strict` 纯 SQL：转换失败一律 NULL，不让一行脏值拖垮整条看板查询。
 * - 数值：正则只放行十进制与至多三位指数，且绝对值必须小于 1e308（双精度上限）——numeric 自身上限是 131072 位整数，
 *   `'1e400'` 不会溢出报错，不钳住就会把 10^400 当作有效数值交给图表。长度 ≤ 64 挡住一长串数字的 cast 开销。
 * - 时间：正则只认带时区的 ISO 8601（日期、时刻与 Z/±hh[:mm]），`pg_input_is_valid` 再挡住 `2026-02-31` 这类日历上不存在的值；
 *   CASE 在常量折叠时先判条件再折结果，因此常量实参也不会在规划期报错。带时刻但不带时区的值一律 NULL，不随会话时区漂移。
 *   纯日期 `YYYY-MM-DD` 例外：按 UTC 零点解释（拼上 `T00:00:00Z` 再转），结果与会话时区无关，函数仍是 immutable。
 * - 两条正则只写 `[0-9]` 不写 `\d`：ICU 排序规则下 `\d` 会放行非 ASCII 数字，随后的 cast 报错。
 * - 布尔：只认 true/1/是 与 false/0/否（大小写不敏感），其余 NULL。
 * - 时长：与契约 `parseDurationSeconds` 同一口径——纯秒数（`270`、`270.5`）或 ISO 8601 时长子集（`PnW`，或 `PnDTnHnMn(.n)S` 至少一段），
 *   折成秒数，上限 1e12 秒；年、月、负数、科学计数法与其余写法一律 NULL。长度 ≤ 64 在正则与 cast 之前挡住超长输入。
 */
export async function initializeBusinessWarehouse(pool:Pool):Promise<void>{
 await pool.query(`create or replace function teloa_safe_numeric(text) returns numeric language sql immutable strict as $$
   select case when length($1)<=64 and $1 ~ '^[+-]?([0-9]+\\.?[0-9]*|\\.[0-9]+)([eE][+-]?[0-9]{1,3})?$'
     then case when abs($1::numeric)<1e308 then $1::numeric end end
 $$`)
 await pool.query(`create or replace function teloa_safe_timestamptz(text) returns timestamptz language sql immutable strict as $$
   select case when $1 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' and pg_input_is_valid($1,'date')
     then ($1||'T00:00:00Z')::timestamptz
     when $1 ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}(:[0-9]{2}(\\.[0-9]{1,6})?)?(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' and pg_input_is_valid($1,'timestamptz')
     then $1::timestamptz end
 $$`)
 await pool.query(`create or replace function teloa_safe_boolean(text) returns boolean language sql immutable strict as $$
   select case when lower($1) in ('true','1','是') then true when lower($1) in ('false','0','否') then false end
 $$`)
 await pool.query(`create or replace function teloa_safe_duration_seconds(text) returns numeric language sql immutable strict as $$
   select case when seconds<=1e12 then seconds end from (
     select case
       when length($1)>64 then null
       when $1 ~ '^[0-9]+(\\.[0-9]+)?$' then $1::numeric
       when m is not null and (m[1] is not null or m[2] is not null or m[3] is not null or m[4] is not null or m[5] is not null)
         then coalesce(m[1]::numeric,0)*604800+coalesce(m[2]::numeric,0)*86400+coalesce(m[3]::numeric,0)*3600+coalesce(m[4]::numeric,0)*60+coalesce(m[5]::numeric,0)
     end as seconds
     from (select case when length($1)<=64 then regexp_match($1,'^P(?:([0-9]+)W|(?:([0-9]+)D)?(?:T(?:([0-9]+)H)?(?:([0-9]+)M)?(?:([0-9]+(?:\\.[0-9]+)?)S)?)?)$') end as m) as parsed
   ) as converted
 $$`)
 // 当前版本（distinct on … order by object_version desc）与保留清理（按 first_seen_at 扫）各一条索引。
 await pool.query('create index if not exists teloa_business_object_snapshots_current on teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version desc)')
 await pool.query('create index if not exists teloa_business_object_snapshots_first_seen on teloa_business_object_snapshots(owner_id,scope_id,first_seen_at)')
}

/**
 * 当前版本子查询文本（供改写器与视图计算共用），带外层括号，调用方写 `from ${…} s`。
 * 参数占位符固定 `$1`=owner_id、`$2`=scope_id，object_type 默认 `$3`；看板改写器一条 SQL 里有多张逻辑表时按表依次传 `$3`、`$4`…，由平台注入。
 * schema：给出时快照表按 `<schema>.` 限定（改写产物在 `search_path=pg_temp` 下执行）；不给时不限定（应用连接按自身 search_path 解析）。
 * tombstone 过滤必须在取最大版本**之后**：先滤掉 tombstone 再取最大，会让被删对象的上一版本重新冒出来。
 */
export function currentVersionSubquery(includeDeleted:boolean,objectTypeParam:number=3,schema?:string):string{
 if(!Number.isSafeInteger(objectTypeParam)||objectTypeParam<3)throw Error('对象类型参数序号不合法。')
 if(schema!==undefined&&!/^[a-z_][a-z0-9_]{0,62}$/.test(schema))throw Error('快照表模式名不合法。')
 const latest='select distinct on (object_id) * from '+(schema===undefined?'':schema+'.')+'teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$'+objectTypeParam+' order by object_id,object_version desc'
 return includeDeleted?'('+latest+')':"(select * from ("+latest+") as latest where latest.snapshot->>'deletedAt' is null)"
}

/**
 * 以外键钉住某个对象版本的表：清理若删到它们引用的历史版本会整批 23503 失败，因此逐表排除。
 * 表名只取这里的常量；不存在的表（只装了业务数据那几张的库）直接跳过。
 */
const referencingTables=['teloa_business_task_sources','teloa_security_actions','teloa_business_snapshot_references'] as const

export class BusinessWarehouseService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 constructor(pool:Pool,identity:{now:()=>string}){this.pool=pool;this.identity=identity}

 /** 范围内版本行数（所有 object_type 合计）。 */
 async scopeRowCount(db:PoolClient,ownerId:string,scope:string):Promise<number>{
  return Number((await db.query('select count(*) as total from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2',[ownerId,scope])).rows[0].total)
 }

 /**
  * 配额检查，**每事务只调一次**：调用方在批量写入前算出本事务将新增的行数（去重后的 upsert 数 + tombstone 数，
  * 或按页大小的上界）一次传入，不逐行查 count。超配只拒绝新增，既有数据照常可查。
  * count 前先取（本人,范围）级事务锁、持到提交：并发两个写入者不会各自数到上限以内再合计超额。
  */
 async assertQuota(db:PoolClient,ownerId:string,scope:string,incoming:number):Promise<void>{
  if(!Number.isSafeInteger(incoming)||incoming<0)throw invalidInput('本次新增的对象版本数不合法。')
  if(!incoming)return
  await db.query("select pg_advisory_xact_lock(hashtext('teloa.business-quota'),hashtext($1||chr(31)||$2))",[ownerId,scope])
  if(await this.scopeRowCount(db,ownerId,scope)+incoming>businessDashboardLimits.scopeRowQuota)throw invalidInput('范围对象版本数已达 500 000 上限，已拒绝新增；既有数据仍可查询。')
 }

 /**
  * 写 tombstone：复制当前版本（fields 等一并沿用），version+1，snapshot.deletedAt=now。
  * 对象不存在或当前版本已是 tombstone 则不写，返回 false；并发两次写同一版本号时后到的一方同样返回 false。
  */
 async tombstone(db:PoolClient,ownerId:string,scope:string,objectType:string,objectId:string,sourceId:string):Promise<boolean>{
  const row=(await db.query(`select object_version,snapshot_hash,snapshot from teloa_business_object_snapshots
    where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version desc limit 1 for update`,[ownerId,scope,objectType,objectId])).rows[0] as {object_version:number;snapshot_hash:string;snapshot:unknown}|undefined
  if(!row)return false
  let stored
  try{stored=readBusinessObjectSnapshot(row.snapshot,scope)}catch{throw corrupt('固定业务对象快照格式不正确。')}
  if(businessObjectSnapshotHash(stored)!==row.snapshot_hash||stored.type!==objectType||stored.id!==objectId||stored.version!==row.object_version)throw corrupt('固定业务对象快照与摘要不一致。')
  if(stored.deletedAt!==undefined)return false
  const now=this.identity.now()
  // 再过一遍读取器：键序与校验与读回时逐字相同，摘要因此可重算。
  const item=readBusinessObjectSnapshot({...stored,version:stored.version+1,deletedAt:now},scope)
  const inserted=await db.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,[ownerId,scope,objectType,objectId,item.version,businessObjectSnapshotHash(item),JSON.stringify(item),sourceId,now])
  return inserted.rowCount===1
 }

 /**
  * 保留清理：删除 first_seen_at 早于 now-retentionDays 且不是当前版本（该对象最大 object_version）的行；
  * 当前版本哪怕早已过期也保留，它是这个对象唯一的现状。每批 ≤ 5000 行，批间可取消；返回删除数。
  * retentionDays 按映射覆盖（功能验证 传入），缺省 90。
  */
 async prune(ownerId:string,scope:string,objectType:string,retentionDays:number=businessDashboardLimits.retentionDays,signal?:AbortSignal):Promise<number>{
  if(!Number.isSafeInteger(retentionDays)||retentionDays<1||retentionDays>365)throw invalidInput('保留天数必须是 1 到 365 之间的整数。')
  signal?.throwIfAborted()
  const cutoff=new Date(Date.parse(this.identity.now())-retentionDays*day).toISOString()
  const present=(await this.pool.query('select name from unnest($1::text[]) as name where to_regclass(name) is not null',[[...referencingTables]])).rows.map(row=>row.name as string)
  const guards=referencingTables.filter(name=>present.includes(name)).map(name=>
   ` and not exists(select 1 from ${name} r where r.owner_id=s.owner_id and r.scope_id=s.scope_id and r.object_type=s.object_type and r.object_id=s.object_id and r.object_version=s.object_version)`).join('')
  let total=0
  let fkRetries=0
  for(;;){
   signal?.throwIfAborted()
   let deleted:number
   try{deleted=(await this.pool.query(`delete from teloa_business_object_snapshots t using (
     select s.object_id,s.object_version from teloa_business_object_snapshots s
     where s.owner_id=$1 and s.scope_id=$2 and s.object_type=$3 and s.first_seen_at<$4
      and s.object_version<(select max(m.object_version) from teloa_business_object_snapshots m
       where m.owner_id=s.owner_id and m.scope_id=s.scope_id and m.object_type=s.object_type and m.object_id=s.object_id)${guards}
     limit ${pruneBatch} for update of s skip locked) d
    where t.owner_id=$1 and t.scope_id=$2 and t.object_type=$3 and t.object_id=d.object_id and t.object_version=d.object_version`,[ownerId,scope,objectType,cutoff])).rowCount??0}
   catch(error){
    // READ COMMITTED 语句快照可能早于 pin 提交；行锁待取得时 pin 已提交，FK 会拒绝删除。
    // 下一语句得到新快照再检查引用；上限防止意外 FK 持续失败时空转。
    if((error as {code?:string}).code!=='23503'||++fkRetries>3)throw error
    signal?.throwIfAborted()
    continue
   }
   fkRetries=0
   total+=deleted
   if(deleted<pruneBatch)return total
  }
 }
}
