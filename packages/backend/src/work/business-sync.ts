import {createHash,randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {
 WorkError,businessScopeKeyRule,isBusinessScopeKey,isRecord,evaluateJsonPath,nextBusinessSyncOccurrence,readBusinessSyncRun,
 businessDashboardLimits,businessSourceMappingLimits,businessSyncTriggers,
 businessObjectTypeV2LegacyShape,
 type BusinessObjectTypeDefinition,type BusinessSourceMappingDefinition,type BusinessSyncRun,type BusinessSyncStatus,type WorkErrorCode,
} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot,type BusinessObjectSnapshot} from './business-data.ts'
import type {BusinessDefinitionSourceReader} from './business-definition-source.ts'
import type {BusinessWarehouseService} from './business-warehouse.ts'
import {BusinessRuntimeGateError,assertScheduledSync,scheduledSyncAllowed,invokeScheduledSync,lockBusinessRuntime,businessRuntimeStateInTransaction} from './business-runtime.ts'
import {BusinessSyncRuleService} from './business-sync-rules.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import type {BusinessSyncFetchPage} from './business-sync-sources.ts'
import type {BusinessSyncSourceResolver} from './business-sync-sources.ts'

export type {BusinessSyncRun,BusinessSyncStatus} from '@teloa/contract'
export type BusinessSyncActor={ownerId:string;scopeIds:string[]}
export type BusinessSyncTrigger='schedule'|'manual'|'tool'

type MappedSnapshot=Omit<BusinessObjectSnapshot,'snapshotHash'|'version'>
type Snapshot=Omit<BusinessObjectSnapshot,'snapshotHash'>
type ResolvedMapping={mapping:BusinessSourceMappingDefinition;objectType:BusinessObjectTypeDefinition;definitionHash:string}
type CursorState={cursor?:string;cursorBasis?:string;consecutiveFailures:number;backoffUntil?:string;lastOkAt?:string}
type Outcome={fetched:number;upserted:number;tombstoned:number;nextCursor?:string}
type Fetched={key:string;entries:Array<{item:unknown;capturedAt:string}>}

const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const safeId=/^[\p{L}\p{N}][\p{L}\p{N}._:@/+ -]{0,199}$/u
const epoch='1970-01-01T00:00:00.000Z'
/** 单次同步最多翻这么多页：防来源分页不收敛（游标每页都变却永不结束）让一次同步无限跑下去；取 1000 是因为每页 ≤100 条，1000 页即单次至多 10 万条，已远超一个映射的正常增量，再多应改增量水位。 */
const maxPages=1000
/** 每个映射只留最近这么多条同步记录：简报与契约没有给同步记录的保留参数，按条数封顶。 */
const runsPerMapping=200
/** 退避：第 n 次连续失败等 60 秒·2^(n-1)，上限 1 小时。 */
const backoffBaseMs=60_000,backoffMaxMs=3_600_000
const invalidInput=(message:string)=>new WorkError('teloa/invalid-input',message)
const forbidden=()=>new WorkError('teloa/forbidden','当前主体未获准读取此业务范围。')
const unavailable=(message:string)=>new WorkError('teloa/source-unavailable',message)
const corrupt=(message:string)=>new WorkError('teloa/storage-corrupt',message)
const iso=(value:unknown):string|undefined=>value instanceof Date?value.toISOString():value===null||value===undefined?undefined:new Date(String(value)).toISOString()

/** 控制字符换空格、去首尾空白、按上限截断；截断后再去一次尾部空白，保证过得了快照读取器的 trim 判据。 */
function clean(value:string,max:number):string{return value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,max).trim()}
/** 源里取出的值变成字段文本：数值、布尔 String()，对象与数组 JSON；null / 缺失 / 空白视为没有。 */
function valueText(value:unknown,max:number):string|undefined{
 if(value===undefined||value===null)return undefined
 const raw=typeof value==='object'?JSON.stringify(value):String(value)
 const cleaned=clean(raw,max)
 return cleaned||undefined
}
function sourceLabel(mapping:BusinessSourceMappingDefinition):string{
 const source=mapping.source
 return clean(source.kind==='business-data-port'?source.sourceId:source.kind==='mcp-tool'?source.serverName+'/'+source.tool:'role-result',120)
}
/** 映射 ID 固定逻辑来源；MCP 同工具的不同参数仍是不同连接范围。参数顺序不改变身份。 */
function sourceIdentity(mapping:BusinessSourceMappingDefinition,sourceId:string):string{
 const source=mapping.source
 const argumentsKey=source.kind==='mcp-tool'?Object.entries(source.arguments).sort(([a],[b])=>a<b?-1:a>b?1:0):[]
 return createHash('sha256').update(JSON.stringify(['teloa.business-sync-source/v1',mapping.id,source.kind,sourceId,argumentsKey,source.kind==='role-result'?source.roleId??null:null])).digest('hex')
}

/**
 * 纯函数：一条原始条目 → 快照（不含 version/hash）。字段取值全部转文本（数值 42 → "42"，对象与数组取 JSON）；
 * 快照 `fields[].label` 取对象类型字段的 `from`（台账与改写器都按它匹配）。缺主键 → 跳过；observedAt 缺省 capturedAt，
 * 晚于 capturedAt 的钳到 capturedAt（快照读取器要求 receivedAt ≥ observedAt）。必填字段缺任一即 quality 'missing'。
 */
export function mapSourceItem(mapping:BusinessSourceMappingDefinition,objectType:BusinessObjectTypeDefinition,item:unknown,capturedAt:string):{snapshot:MappedSnapshot;deleted:boolean}|{skipped:'missing-primary-key'|'not-object'}{
 if(!isRecord(item))return {skipped:'not-object'}
 const values=new Map<string,string>()
 for(const {path,field} of mapping.mapping){
  const value=valueText(evaluateJsonPath(item,path),field==='summary'?4000:2000)
  if(value!==undefined)values.set(field,value)
 }
 const keys=mapping.primaryKey.map(key=>values.get(key))
 if(keys.some(key=>key===undefined))return {skipped:'missing-primary-key'}
 const parts=keys as string[]
 const id=parts.length===1&&safeId.test(parts[0]!)?parts[0]!:createHash('sha256').update(parts.join('\u001f')).digest('hex').slice(0,32)
 const labels=new Set<string>(),fields:Array<{label:string;value:string}>=[]
 for(const field of objectType.fields){
  const value=values.get(field.name)
  if(value===undefined||labels.has(field.from))continue
  labels.add(field.from);fields.push({label:field.from,value})
 }
 const observed=values.get('observedAt'),parsed=observed===undefined?Number.NaN:Date.parse(observed)
 const observedAt=Number.isFinite(parsed)&&new Date(parsed).toISOString()<capturedAt?new Date(parsed).toISOString():capturedAt
 const deletedValue=mapping.deletionSemantics==='tombstone'&&mapping.deletedAtPath!==undefined?evaluateJsonPath(item,mapping.deletedAtPath):undefined
 return {
  snapshot:{
   scope:mapping.domain,type:objectType.id,id,
   title:clean(values.get('title')??parts.join(' · '),240)||id,
   source:sourceLabel(mapping),observedAt,receivedAt:capturedAt,
   quality:objectType.fields.every(field=>!field.required||values.has(field.name))?'complete':'missing',
   summary:values.get('summary')??'',fields,
  },
  deleted:deletedValue!==undefined&&deletedValue!==null&&deletedValue!==''&&deletedValue!==false,
 }
}

/** 来源记录身份、同步记录与游标；追加写，同步记录不改写。 */
export async function initializeBusinessSync(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_sync_object_ids (
   owner_id text not null,scope_id text not null,object_type text not null,source_key text not null,external_key text not null,object_id text not null,source_id text,
   primary key(owner_id,scope_id,object_type,source_key,external_key),
   unique(owner_id,scope_id,object_type,object_id)
 )`)
 // 旧试点身份未固定实际来源时保持不可读；下次受管同步核验后补上，不猜来源。
 await pool.query('alter table teloa_business_sync_object_ids add column if not exists source_id text')
 await pool.query(`create table if not exists teloa_business_sync_runs (
   owner_id text not null, scope_id text not null, mapping_id text not null, run_id uuid not null,
   trigger text not null check(trigger in ('schedule','manual','tool')),
   started_at timestamptz not null, finished_at timestamptz not null,
   status text not null check(status in ('ok','failed','throttled')),
   fetched integer not null check(fetched>=0), upserted integer not null check(upserted>=0), tombstoned integer not null check(tombstoned>=0),
   duration_ms integer not null check(duration_ms>=0), error_code text, error_reason text, next_cursor text, throttled boolean not null,
   primary key(owner_id,scope_id,mapping_id,run_id)
 )`)
 await pool.query('create index if not exists teloa_business_sync_runs_recent on teloa_business_sync_runs(owner_id,scope_id,mapping_id,started_at desc)')
 await pool.query(`create table if not exists teloa_business_sync_cursors (
   owner_id text not null, scope_id text not null, mapping_id text not null, cursor text,
   consecutive_failures integer not null default 0 check(consecutive_failures>=0), backoff_until timestamptz, last_ok_at timestamptz, updated_at timestamptz not null,
   primary key(owner_id,scope_id,mapping_id)
 )`)
 // 水位口径：算出水位时的来源与 incrementalCursor 摘要（见 `cursorBasis`）。旧行没有这一列即视为口径不明，下次从头拉一次。
 await pool.query('alter table teloa_business_sync_cursors add column if not exists cursor_basis text')
}

function actorOf(actor:BusinessSyncActor):void{
 if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)))throw new WorkError('teloa/forbidden','需要有效的同步主体。')
}
function exactInput(value:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
 if(!isRecord(value)||required.some(key=>!(key in value))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key)))throw invalidInput('业务同步参数不正确。')
 return value
}
function scopeOf(actor:BusinessSyncActor,scope:unknown):string{
 if(!isBusinessScopeKey(scope)||scope==='general')throw invalidInput('需要明确的业务数据范围：'+businessScopeKeyRule+'，general 一律拒绝。')
 if(!actor.scopeIds.includes(scope))throw forbidden()
 return scope
}
function mappingIdOf(value:unknown):string{
 if(typeof value!=='string'||!localId.test(value))throw invalidInput('数据源映射标识不合法。')
 return value
}
function failureOf(error:unknown):{code:WorkErrorCode;reason:string}{
 if(error instanceof WorkError){
  // 旧读取器的 source-invalid 不扩散：同步记录只落八个正式码与既有 source-conflict。
  if(error.code==='teloa/source-invalid')return {code:'teloa/source-unavailable',reason:'数据源返回了不符合约定的数据；未写入。'}
  return {code:error.code,reason:clean(error.message,2000)||'同步失败。'}
 }
 return {code:'teloa/dependency-unavailable',reason:'同步暂时失败，请稍后再试。'}
}
/** 增量水位比较：timestamp 按时刻、sequence 按整数（长度优先，免大数失真）。取不出、不可比或超长的值不推进水位（多拉不丢）。 */
function watermark(kind:'timestamp'|'sequence',current:string|undefined,value:unknown):string|undefined{
 if(typeof value!=='string'&&typeof value!=='number')return current
 const candidate=String(value)
 if(!text(candidate,512))return current
 if(kind==='timestamp'){
  if(!Number.isFinite(Date.parse(candidate)))return current
  return current===undefined||!Number.isFinite(Date.parse(current))||Date.parse(candidate)>Date.parse(current)?candidate:current
 }
 if(!/^\d+$/.test(candidate))return current
 const a=candidate.replace(/^0+(?=\d)/,''),b=current?.replace(/^0+(?=\d)/,'')
 return b===undefined||!/^\d+$/.test(b)||a.length>b.length||(a.length===b.length&&a>b)?candidate:current
}

/**
 * 业务数据同步器（规格 §4.1）：按数据源映射把来源条目落到唯一真源快照表（追加版本、tombstone 版本），
 * 并写同步记录与游标。同一映射同时只跑一次（advisory 锁：同步用会话级、成果写入用事务级，取不到即 throttled / conflict，不排队）；
 * 失败只记录与退避，不推进游标——快照表本就追加，上一次成功的快照原样留着。
 */
export class BusinessSyncService{
 readonly rules:BusinessSyncRuleService
 private readonly pool:Pool
 private readonly identity:{id:()=>string;now:()=>string}
 private readonly definitions:Pick<BusinessDefinitionSourceReader,'forScope'>&Partial<Pick<BusinessDefinitionSourceReader,'forScopeVersioned'>>
 private readonly warehouse:BusinessWarehouseService
 private readonly resolve:BusinessSyncSourceResolver
 constructor(pool:Pool,identity:{id:()=>string;now:()=>string},definitions:Pick<BusinessDefinitionSourceReader,'forScope'>&Partial<Pick<BusinessDefinitionSourceReader,'forScopeVersioned'>>,warehouse:BusinessWarehouseService,resolve:BusinessSyncSourceResolver){
  this.pool=pool;this.identity=identity;this.definitions=definitions;this.warehouse=warehouse;this.resolve=resolve
  this.rules=new BusinessSyncRuleService(pool,identity,async(db,owner,scope,mappingId)=>{
   const known=(await db.query('select 1 from teloa_business_scopes where owner_id=$1 and scope=$2',[owner,scope])).rowCount
   if(!known)return undefined
   const runtime=await businessRuntimeStateInTransaction(db,owner,scope)
   const mapping=(await this.scopeMappings(db,owner,scope)).find(row=>row.mapping.id===mappingId)
   return mapping&&mapping.mapping.source.kind!=='role-result'?{definitionHash:mapping.definitionHash,managed:runtime.managed}:undefined
  })
 }

 /** 列出范围内生效的 source-mapping 声明（模板 + 本地当前版本，同 forScope 口径）。 */
 async mappings(actor:BusinessSyncActor,scope:string):Promise<BusinessSourceMappingDefinition[]>{
  actorOf(actor)
  const checked=scopeOf(actor,scope)
  return (await this.readOnly(db=>this.scopeMappings(db,actor.ownerId,checked))).map(row=>row.mapping)
 }

 /**
  * 跑一次同步：见类注释。锁键双参 `(hashtext(owner),hashtext(scope‖\u001f‖mappingId))`，与刷新锁、既有单参锁键不撞。
  * 远端拉取在事务之外完成：锁用会话级 advisory 锁，跨过「读游标 → 拉取 → 写入」三段；拉取期间只占这一条空闲连接，
  * 不开事务（不持快照、不持行锁）。读游标与写入各是一个短事务；写入失败回到保存点记录失败与退避。结束一律解锁。
  */
 async run(actor:BusinessSyncActor,input:{scope:string;mappingId:string;trigger:BusinessSyncTrigger},signal?:AbortSignal):Promise<BusinessSyncRun>{
  actorOf(actor)
  const row=exactInput(input,['scope','mappingId','trigger'])
  const scope=scopeOf(actor,row.scope),mappingId=mappingIdOf(row.mappingId)
  if(!(businessSyncTriggers as readonly string[]).includes(row.trigger as string))throw invalidInput('同步触发方式不合法。')
  const trigger=row.trigger as BusinessSyncTrigger,owner=actor.ownerId
  signal?.throwIfAborted()
  const runId=this.identity.id(),startedAt=this.identity.now()
  const db=await this.pool.connect()
  let locked=false,broken:unknown
  try{
   locked=await this.tryLock(db,owner,scope,mappingId,'session')
   if(!locked){
    await db.query('begin')
    const run=await this.record(db,owner,scope,mappingId,{runId,trigger,startedAt,status:'throttled',outcome:{fetched:0,upserted:0,tombstoned:0},error:{code:'teloa/conflict',reason:'同一数据源映射正在同步，本次跳过。'}})
    await db.query('commit')
    await this.settle(owner,scope,mappingId)
    return run
   }
   await db.query('begin')
   const resolved=await this.resolveMapping(db,owner,scope,mappingId)
   if(resolved.mapping.source.kind==='role-result')throw invalidInput('AI 员工成果映射只由成果工具写入，不参与同步。')
   const runtime=trigger==='schedule'?await assertScheduledSync(db,owner,scope):undefined
   const rule=runtime===undefined?undefined:await this.rules.assertEnabled(db,owner,scope,mappingId)
   if(rule&&resolved.definitionHash!==rule.definitionHash)throw new BusinessRuntimeGateError('teloa/conflict','业务映射声明与启用规则不一致，本次执行已停止。')
   const state=await this.cursorState(db,owner,scope,mappingId)
   if(state?.backoffUntil!==undefined&&state.backoffUntil>startedAt){
    const run=await this.record(db,owner,scope,mappingId,{runId,trigger,startedAt,status:'throttled',outcome:{fetched:0,upserted:0,tombstoned:0},error:{code:'teloa/source-unavailable',reason:'数据源连续失败，退避至 '+state.backoffUntil+' 后再试。'}})
    await db.query('commit')
    await this.settle(owner,scope,mappingId)
    return run
   }
   await db.query('commit')
   // 只沿用同一口径下算出的水位（见 `cursorBasis`）；口径变了或映射不再增量即从头拉，失败也不会反复带着旧值重试。
   const basis=cursorBasis(resolved.mapping),cursor=basis!==undefined&&state?.cursorBasis===basis?state.cursor:undefined
   // 失败只记录与退避：锁仍在本会话手里，记录与退避不会被另一次同步插队。
   const fail=async(error:unknown)=>{
    // 暂停先于来源失败返回时同样丢弃旧请求，不把主动停用计入退避。
    if(runtime!==undefined){
     await lockBusinessRuntime(db,owner,scope,'shared')
     await assertScheduledSync(db,owner,scope,runtime.revision)
     await this.rules.assertEnabled(db,owner,scope,mappingId,rule!.revision,rule!.definitionHash)
    }
    signal?.throwIfAborted()
    const failure=failureOf(error),failures=(state?.consecutiveFailures??0)+1,finishedAt=this.identity.now()
    const backoffUntil=new Date(Date.parse(finishedAt)+Math.min(backoffBaseMs*2**(failures-1),backoffMaxMs)).toISOString()
    await db.query(`insert into teloa_business_sync_cursors(owner_id,scope_id,mapping_id,cursor,consecutive_failures,backoff_until,last_ok_at,updated_at) values($1,$2,$3,null,$4,$5,null,$6)
      on conflict(owner_id,scope_id,mapping_id) do update set consecutive_failures=excluded.consecutive_failures,backoff_until=excluded.backoff_until,updated_at=excluded.updated_at`,[owner,scope,mappingId,failures,backoffUntil,finishedAt])
    const run=await this.record(db,owner,scope,mappingId,{runId,trigger,startedAt,finishedAt,status:'failed',outcome:{fetched:0,upserted:0,tombstoned:0},error:failure})
    await db.query('commit')
    await this.settle(owner,scope,mappingId)
    return run
   }
   let fetched:Fetched
   try{fetched=await this.fetchAll(scope,resolved,cursor,signal,runtime===undefined?undefined:invoke=>invokeScheduledSync(db,owner,scope,runtime.revision,invoke,error=>{broken=error},()=>this.rules.assertEnabled(db,owner,scope,mappingId,rule!.revision,rule!.definitionHash).then(()=>{})))}
   catch(error){
    if(signal?.aborted||error instanceof BusinessRuntimeGateError)throw error
    await db.query('begin')
    await this.assertCurrentMapping(db,owner,scope,mappingId,resolved)
    return await fail(error)
   }
   await db.query('begin')
   await this.assertCurrentMapping(db,owner,scope,mappingId,resolved)
   if(runtime!==undefined){
    await lockBusinessRuntime(db,owner,scope,'shared')
    await assertScheduledSync(db,owner,scope,runtime.revision)
    await this.rules.assertEnabled(db,owner,scope,mappingId,rule!.revision,rule!.definitionHash)
   }
   await db.query('savepoint teloa_business_sync')
   let outcome:Outcome
   try{outcome=await this.apply(db,owner,scope,resolved,cursor,fetched,signal)}
   catch(error){
    if(signal?.aborted||error instanceof BusinessRuntimeGateError)throw error
    await db.query('rollback to savepoint teloa_business_sync')
    return await fail(error)
   }
   const finishedAt=this.identity.now()
   await db.query(`insert into teloa_business_sync_cursors(owner_id,scope_id,mapping_id,cursor,cursor_basis,consecutive_failures,backoff_until,last_ok_at,updated_at) values($1,$2,$3,$4,$6,0,null,$5,$5)
     on conflict(owner_id,scope_id,mapping_id) do update set cursor=excluded.cursor,cursor_basis=excluded.cursor_basis,consecutive_failures=0,backoff_until=null,last_ok_at=excluded.last_ok_at,updated_at=excluded.updated_at`,[owner,scope,mappingId,outcome.nextCursor??null,finishedAt,outcome.nextCursor===undefined?null:basis??null])
   const run=await this.record(db,owner,scope,mappingId,{runId,trigger,startedAt,finishedAt,status:'ok',outcome})
   await db.query('commit')
   // 保留清理在提交之后单独跑：它按批删、可取消，不占着这次写入的事务。
   await this.settle(owner,scope,mappingId,{objectType:resolved.objectType.id,retentionDays:resolved.mapping.retentionDays??businessDashboardLimits.retentionDays},signal)
   return run
  }catch(error){await db.query('rollback').catch(()=>{});throw error}
  finally{
   // 会话级锁不随事务结束释放：解锁失败的连接直接销毁（连接关闭即释放锁），不带着锁回池。
   if(locked&&!broken)await db.query('select pg_advisory_unlock(hashtext($1),hashtext($2))',[owner,scope+'\u001f'+mappingId]).catch((error:unknown)=>{broken=error instanceof Error?error:Error('解锁失败')})
   db.release(broken as Error|undefined)
  }
 }

 /** 直接写入一批已映射前的原始条目（AI 员工成果工具用）；同一事务内映射 + 配额 + 落库，记一条 trigger 'tool' 的同步记录。 */
 async ingest(actor:BusinessSyncActor,input:{scope:string;mappingId:string;items:unknown[];sourceId:string},signal?:AbortSignal):Promise<{upserted:number;tombstoned:number}>{
  actorOf(actor)
  const row=exactInput(input,['scope','mappingId','items','sourceId'])
  const scope=scopeOf(actor,row.scope),mappingId=mappingIdOf(row.mappingId),owner=actor.ownerId
  if(!Array.isArray(row.items)||!row.items.length||row.items.length>100)throw invalidInput('成果条目必须是 1 到 100 条。')
  if(!text(row.sourceId,120))throw invalidInput('成果来源标识不合法。')
  const items=row.items as unknown[],sourceId=row.sourceId
  signal?.throwIfAborted()
  const runId=this.identity.id(),startedAt=this.identity.now()
  const db=await this.pool.connect()
  try{
   await db.query('begin')
   await lockBusinessConfiguration(db,owner,scope,'shared')
   if(!await this.tryLock(db,owner,scope,mappingId))throw new WorkError('teloa/conflict','同一数据源映射正在写入，请稍后再记录。')
   const resolved=await this.resolveMapping(db,owner,scope,mappingId)
   if(resolved.mapping.source.kind!=='role-result')throw invalidInput('只有 AI 员工成果映射接受直接写入。')
   const outcome=await this.write(db,owner,scope,resolved,sourceId,items.map(item=>({item,capturedAt:startedAt})),false,signal)
   await this.record(db,owner,scope,mappingId,{runId,trigger:'tool',startedAt,status:'ok',outcome})
   await db.query('commit')
   await this.settle(owner,scope,mappingId)
   return {upserted:outcome.upserted,tombstoned:outcome.tombstoned}
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /** 外部拉取不持配置锁；落库或记录退避前锁住当前配置并拒绝过期映射。 */
 private async assertCurrentMapping(db:PoolClient,owner:string,scope:string,mappingId:string,original:ResolvedMapping):Promise<void>{
  await lockBusinessConfiguration(db,owner,scope,'shared')
  const current=(await this.scopeMappings(db,owner,scope)).find(row=>row.mapping.id===mappingId)
  if(!current||current.definitionHash!==original.definitionHash||JSON.stringify(current.mapping)!==JSON.stringify(original.mapping)||JSON.stringify(current.objectType)!==JSON.stringify(original.objectType))throw new BusinessRuntimeGateError('teloa/conflict','业务映射在拉取期间已变更，本次同步未写入。')
 }

 async status(actor:BusinessSyncActor,scope:string):Promise<BusinessSyncStatus[]>{
  actorOf(actor)
  const checked=scopeOf(actor,scope),owner=actor.ownerId
  return this.readOnly(async db=>{
   const mappings=await this.scopeMappings(db,owner,checked)
   const runs=(await db.query(`select distinct on (mapping_id) * from teloa_business_sync_runs where owner_id=$1 and scope_id=$2 order by mapping_id,started_at desc,run_id`,[owner,checked])).rows as Array<Record<string,unknown>>
   const cursors=new Map<string,CursorState>()
   for(const row of (await db.query('select * from teloa_business_sync_cursors where owner_id=$1 and scope_id=$2',[owner,checked])).rows as Array<Record<string,unknown>>)cursors.set(String(row.mapping_id),cursorOf(row))
   const rows=await this.warehouse.scopeRowCount(db,owner,checked)
   return mappings.map(({mapping})=>{
    const lastRow=runs.find(row=>row.mapping_id===mapping.id),state=cursors.get(mapping.id)
    let nextRunAt:string|undefined
    if(mapping.source.kind!=='role-result'){
     // 算不出下一次（如闰日 cron 碰上不闰的世纪年）只让这一条不带 nextRunAt，不拖垮整个范围的状态页。
     try{nextRunAt=nextBusinessSyncOccurrence(mapping.schedule,state?.lastOkAt??epoch)}catch(error){if(!(error instanceof WorkError))throw error}
     if(nextRunAt!==undefined&&state?.backoffUntil!==undefined&&state.backoffUntil>nextRunAt)nextRunAt=state.backoffUntil
    }
    return {
     mappingId:mapping.id,...(lastRow?{lastRun:runOf(lastRow,checked)}:{}),...(nextRunAt!==undefined?{nextRunAt}:{}),
     consecutiveFailures:state?.consecutiveFailures??0,...(state?.backoffUntil!==undefined?{backoffUntil:state.backoffUntil}:{}),
     quota:{rows,limit:businessDashboardLimits.scopeRowQuota},
    }
   })
  })
 }

 async runs(actor:BusinessSyncActor,input:{scope:string;mappingId?:string;limit:number}):Promise<BusinessSyncRun[]>{
  actorOf(actor)
  const row=exactInput(input,['scope','limit'],['mappingId'])
  const scope=scopeOf(actor,row.scope),mappingId=row.mappingId===undefined?undefined:mappingIdOf(row.mappingId)
  if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>100)throw invalidInput('同步记录条数必须在 1 到 100 之间。')
  const rows=(await this.pool.query(`select * from teloa_business_sync_runs where owner_id=$1 and scope_id=$2 and ($3::text is null or mapping_id=$3) order by started_at desc,run_id limit $4`,[actor.ownerId,scope,mappingId??null,row.limit])).rows as Array<Record<string,unknown>>
  return rows.map(item=>runOf(item,scope))
 }

 /**
  * 调度器用：返回 backoff 已过、且 nextBusinessSyncOccurrence(schedule,last_ok_at ?? epoch) <= now 的映射。
  * 哪些范围有映射：一期映射只来自本地声明（模板来源恒空），因此取本地当前指针里的 source-mapping 所在范围，
  * 再并上已有游标的范围；每个范围仍按 forScope 口径读出生效映射。某个范围读不出（声明损坏、超出映射上限）
  * 只跳过这一个范围——它的状态页会直接报出原因，不拖住其它范围的同步。AI 员工成果映射不参与调度。
  */
 async due(ownerId:string,now:string):Promise<Array<{scope:string;mappingId:string}>>{
  if(!text(ownerId,128)||!Number.isFinite(Date.parse(now)))throw invalidInput('到期判定参数不合法。')
  const scopes=(await this.pool.query(`select scope_id from teloa_business_local_definition_heads where owner_id=$1 and kind='source-mapping' and version is not null
    union select scope_id from teloa_business_sync_cursors where owner_id=$1 order by scope_id`,[ownerId])).rows.map(row=>String(row.scope_id))
  const result:Array<{scope:string;mappingId:string}>=[]
  for(const scope of scopes){
   let rows:Array<{mappingId:string;due:boolean}>
   try{
    rows=await this.readOnly(async db=>{
     if(!await scheduledSyncAllowed(db,ownerId,scope))return []
     const mappings=await this.scopeMappings(db,ownerId,scope),states=new Map<string,CursorState>()
     for(const row of (await db.query('select * from teloa_business_sync_cursors where owner_id=$1 and scope_id=$2',[ownerId,scope])).rows as Array<Record<string,unknown>>)states.set(String(row.mapping_id),cursorOf(row))
     const due:Array<{mappingId:string;due:boolean}>=[]
     for(const {mapping} of mappings.filter(({mapping})=>mapping.source.kind!=='role-result')){
      if(!await this.rules.allowed(db,ownerId,scope,mapping.id))continue
      const state=states.get(mapping.id)
      if(state?.backoffUntil!==undefined&&state.backoffUntil>now){due.push({mappingId:mapping.id,due:false});continue}
      // 单条映射算不出下一次只跳过这一条，同范围其它映射照常调度。
      try{due.push({mappingId:mapping.id,due:nextBusinessSyncOccurrence(mapping.schedule,state?.lastOkAt??epoch)<=now})}
      catch(error){if(error instanceof WorkError)due.push({mappingId:mapping.id,due:false});else throw error}
     }
     return due
    })
   }catch(error){if(error instanceof WorkError)continue;throw error}
   for(const row of rows)if(row.due)result.push({scope,mappingId:row.mappingId})
  }
  return result
 }

 /**
  * 提交之后的清理：成功那次按映射保留天数清对象历史版本，每次都把本映射的同步记录截到最近 200 条。
  * 同步本身已经提交，清理失败不改变这次同步的结论：不抛给调用方，只按既有码记一行日志（不带表名与约束名），下次再清。
  */
 private async settle(owner:string,scope:string,mappingId:string,objects?:{objectType:string;retentionDays:number},signal?:AbortSignal):Promise<void>{
  const quietly=async(work:()=>Promise<unknown>)=>{
   try{await work()}catch(error){console.warn('[teloa] 业务同步已提交，提交后的保留清理失败（'+failureOf(error).code+'），下次同步再清：范围 '+scope+'，映射 '+mappingId+'。')}
  }
  if(objects)await quietly(()=>this.warehouse.prune(owner,scope,objects.objectType,objects.retentionDays,signal))
  await quietly(()=>this.pool.query(`delete from teloa_business_sync_runs where owner_id=$1 and scope_id=$2 and mapping_id=$3 and run_id in (
    select run_id from teloa_business_sync_runs where owner_id=$1 and scope_id=$2 and mapping_id=$3 order by started_at desc,run_id offset ${runsPerMapping})`,[owner,scope,mappingId]))
 }

 /** 事务级（ingest）与会话级（run）同属一个锁空间：任一方持有，另一方即取不到。 */
 private async tryLock(db:PoolClient,owner:string,scope:string,mappingId:string,mode:'xact'|'session'='xact'):Promise<boolean>{
  return (await db.query(`select ${mode==='xact'?'pg_try_advisory_xact_lock':'pg_try_advisory_lock'}(hashtext($1),hashtext($2)) as locked`,[owner,scope+'\u001f'+mappingId])).rows[0].locked===true
 }

 private async readOnly<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query('begin isolation level repeatable read read only');const result=await run(db);await db.query('commit');return result}
  catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /** 范围内生效映射与其目标对象类型；超过 `mappingsPerScope` 不截断，整范围拒绝同步（生效时已拦，这里是兜底）。 */
 private async scopeMappings(db:PoolClient,owner:string,scope:string):Promise<ResolvedMapping[]>{
  const bundles=this.definitions.forScopeVersioned?await this.definitions.forScopeVersioned(db,owner,scope):await this.definitions.forScope(db,owner,scope)
  const result:ResolvedMapping[]=[]
  for(const bundle of bundles)for(const record of bundle.mappings){
   const objectType=bundle.objectTypes.find(row=>row.definition.id===record.definition.objectType)
   if(!objectType)throw unavailable('数据源映射引用的对象类型不在同一加载内。')
   const definition=objectType.definition
   if(definition.format==='teloa.business-object-type/v2'&&definition.fields.some(field=>'format' in field))throw unavailable('旧数据源映射尚不支持富字段对象类型，已停止同步。')
   result.push({mapping:record.definition,objectType:definition.format==='teloa.business-object-type/v2'?businessObjectTypeV2LegacyShape(definition):definition,definitionHash:record.source.definitionHash})
  }
  if(result.length>businessSourceMappingLimits.mappingsPerScope)throw invalidInput('业务范围 '+scope+' 的数据源映射超过 '+businessSourceMappingLimits.mappingsPerScope+' 个，已停止同步；请先回退多出的映射。')
  return result
 }

 private async resolveMapping(db:PoolClient,owner:string,scope:string,mappingId:string):Promise<ResolvedMapping>{
  const found=(await this.scopeMappings(db,owner,scope)).find(row=>row.mapping.id===mappingId)
  if(!found)throw invalidInput('数据源映射不存在于本业务范围。')
  return found
 }

 private async cursorState(db:PoolClient,owner:string,scope:string,mappingId:string):Promise<CursorState|undefined>{
  const row=(await db.query('select * from teloa_business_sync_cursors where owner_id=$1 and scope_id=$2 and mapping_id=$3 for update',[owner,scope,mappingId])).rows[0] as Record<string,unknown>|undefined
  return row?cursorOf(row):undefined
 }

 /**
  * 拉取在事务外进行；自动同步每页经短共享运行锁核验后发起请求，再解锁等待。每页都带上次水位 `cursor`（无水位即全量）；续页另带上一页回包的 nextCursor 作 `pageToken`，穷尽分页。
  * 「不前进」= 回包游标已在本条分页链出现过（含刚带出的 pageToken）；业务数据端口的水位与续页共用端口的同一个 cursor 参数，
  * 所以端口来源的水位也算「出现过」，首页就回水位即判出。受管 MCP 工具的水位与续页是两个参数、两套取值，不混比。页数上限见 `maxPages`。
  */
 private async fetchAll(scope:string,resolved:ResolvedMapping,cursor:string|undefined,signal?:AbortSignal,invoke?:(fetch:()=>Promise<BusinessSyncFetchPage>)=>Promise<BusinessSyncFetchPage>):Promise<Fetched>{
  const source=await this.resolve(resolved.mapping)
  const pageSize=resolved.mapping.pageSize??50,entries:Array<{item:unknown;capturedAt:string}>=[],seen=new Set<string>()
  if(cursor!==undefined&&resolved.mapping.source.kind==='business-data-port')seen.add(cursor)
  let next:string|undefined
  for(let page=1;;page+=1){
   signal?.throwIfAborted()
   const fetch=()=>{signal?.throwIfAborted();return source.fetch({scope,pageSize,...(cursor===undefined?{}:{cursor}),...(next===undefined?{}:{pageToken:next}),...(signal?{signal}:{})})}
   const result=await (invoke?invoke(fetch):fetch())
   if(!isRecord(result)||!Array.isArray(result.items)||result.items.length>pageSize||typeof result.capturedAt!=='string'||!Number.isFinite(Date.parse(result.capturedAt))||new Date(result.capturedAt).toISOString()!==result.capturedAt||(result.nextCursor!==undefined&&!text(result.nextCursor,1024)))
    throw unavailable('数据源返回了不符合约定的数据；未写入。')
   for(const item of result.items)entries.push({item,capturedAt:result.capturedAt})
   if(result.nextCursor===undefined)break
   if(seen.has(result.nextCursor))throw unavailable('数据源分页游标没有前进；未写入。')
   if(page>=maxPages)throw unavailable('数据源分页超过 '+maxPages+' 页；未写入。')
   seen.add(result.nextCursor);next=result.nextCursor
  }
  return {key:source.key,entries}
 }

 /** 写入（在调用方事务内）：全量 + compare 才对比缺席；增量映射按本批条目推进水位。 */
 private async apply(db:PoolClient,owner:string,scope:string,resolved:ResolvedMapping,cursor:string|undefined,fetched:Fetched,signal?:AbortSignal):Promise<Outcome>{
  const {key,entries}=fetched
  const outcome=await this.write(db,owner,scope,resolved,key,entries,cursor===undefined&&resolved.mapping.deletionSemantics==='compare',signal)
  const incremental=resolved.mapping.incrementalCursor
  if(!incremental)return outcome
  let mark=cursor
  for(const entry of entries)mark=watermark(incremental.kind,mark,isRecord(entry.item)?evaluateJsonPath(entry.item,incremental.path):undefined)
  return {...outcome,...(mark===undefined?{}:{nextCursor:mark})}
 }

 /** 只有端口原样来源能由旧 source_id 证明归属；MCP 参数与成果来源的旧行均保守留存。 */
 private async objectId(db:PoolClient,owner:string,scope:string,type:string,sourceKey:string,sourceId:string,externalKey:string,allowLegacy:boolean):Promise<string>{
  // 不同映射可能同时拉到同一外部键；按键锁并由调用方按键排序，避免双写和交叉死锁。
  await db.query("select pg_advisory_xact_lock(hashtext($1),hashtext($2))",[owner+'\u001f'+scope+'\u001f'+type,externalKey])
  const params=[owner,scope,type,sourceKey,externalKey]
  const found=(await db.query(`select object_id,source_id from teloa_business_sync_object_ids
    where owner_id=$1 and scope_id=$2 and object_type=$3 and source_key=$4 and external_key=$5`,params)).rows[0] as {object_id:string;source_id:string|null}|undefined
  if(found){
   if(found.source_id!==null&&found.source_id!==sourceId)throw new WorkError('teloa/source-conflict','来源身份与已有固定快照归属冲突；已停止同步。')
   const foreign=await db.query(`select 1 from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and (source_id<>$5 or snapshot->>'source'='本地记录') limit 1`,[owner,scope,type,found.object_id,sourceId])
   if(!safeId.test(found.object_id)||foreign.rowCount)throw new WorkError('teloa/source-conflict','来源身份与已有固定快照归属冲突；已停止同步。')
   if(found.source_id===null)await db.query('update teloa_business_sync_object_ids set source_id=$6 where owner_id=$1 and scope_id=$2 and object_type=$3 and source_key=$4 and external_key=$5',[...params,sourceId])
   return found.object_id
  }
  const available=async(id:string)=>{
   const reserved=await db.query(`select 1 from teloa_business_sync_object_ids where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1`,[owner,scope,type,id])
   if(reserved.rowCount)return false
   const foreign=await db.query(`select 1 from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and ($6::boolean=false or source_id<>$5 or snapshot->>'source'='本地记录') limit 1`,[owner,scope,type,id,sourceId,allowLegacy])
   return !foreign.rowCount
  }
  let id=externalKey
  if(!await available(id)){do{id=randomUUID()}while(!await available(id))}
  await db.query(`insert into teloa_business_sync_object_ids(owner_id,scope_id,object_type,source_key,external_key,object_id,source_id)
    values($1,$2,$3,$4,$5,$6,$7)`,[...params,id,sourceId])
  return id
 }

 /**
  * 一批条目落库：先全部规划（读当前版本、判去重与冲突），配额按"将新增的行数"只查一次，再写。
  * 两条版本路径：映射路径同对象 max+1、内容与当前版本相同不写；原样路径（business-data-port 且映射为空）
  * 端口是版本权威，(对象,版本) 已在且摘要相同跳过、摘要不同 source-conflict、不在则直接插入端口版本；
  * 对象一旦有过 tombstone 即与端口版本号脱钩，此后按内容去重、max+1 写入。
  */
 private async write(db:PoolClient,owner:string,scope:string,resolved:ResolvedMapping,sourceId:string,entries:Array<{item:unknown;capturedAt:string}>,compare:boolean,signal?:AbortSignal):Promise<Omit<Outcome,'nextCursor'>>{
  const {mapping,objectType}=resolved,raw=mapping.mapping.length===0,type=objectType.id,sourceKey=sourceIdentity(mapping,sourceId)
  const external=new Map<string,{snapshot:MappedSnapshot&{version?:number};deleted:boolean;capturedAt:string}>()
  for(const {item,capturedAt} of entries){
   if(raw){
    let parsed:Snapshot
    try{parsed=readBusinessObjectSnapshot(item,scope)}catch{throw unavailable('数据源返回了不符合约定的数据；未写入。')}
    if(parsed.deletedAt!==undefined||parsed.type!==type||parsed.receivedAt>capturedAt)throw unavailable('数据源返回了不符合约定的数据；未写入。')
    external.set(parsed.id,{snapshot:parsed,deleted:false,capturedAt})
   }else{
    const mapped=mapSourceItem(mapping,objectType,item,capturedAt)
    if('skipped' in mapped)continue
    external.set(mapped.snapshot.id,{...mapped,capturedAt})
   }
  }
  signal?.throwIfAborted()
  const candidates=new Map<string,{snapshot:MappedSnapshot&{version?:number};deleted:boolean;capturedAt:string}>()
  for(const externalId of [...external.keys()].sort()){
   const candidate=external.get(externalId)!
   const id=await this.objectId(db,owner,scope,type,sourceKey,sourceId,externalId,mapping.source.kind==='business-data-port')
   candidates.set(id,{...candidate,snapshot:id===externalId?candidate.snapshot:{...candidate.snapshot,id}})
  }
  const ids=[...candidates.keys()]
  const latest=new Map<string,{version:number;hash:string;snapshot:Snapshot}>()
  for(const row of (await db.query(`select distinct on (object_id) object_id,object_version,snapshot_hash,snapshot from teloa_business_object_snapshots
    where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=any($4::text[]) order by object_id,object_version desc`,[owner,scope,type,ids])).rows as Array<Record<string,unknown>>){
   latest.set(String(row.object_id),{version:Number(row.object_version),hash:String(row.snapshot_hash),snapshot:storedSnapshot(row,scope,type)})
  }
  const exact=new Map<string,string>(),decoupled=new Set<string>()
  if(raw&&ids.length){
   const versions=ids.map(id=>candidates.get(id)!.snapshot.version!)
   for(const row of (await db.query(`select s.object_id,s.snapshot_hash from teloa_business_object_snapshots s join unnest($4::text[],$5::int[]) as w(object_id,object_version) on w.object_id=s.object_id and w.object_version=s.object_version
     where s.owner_id=$1 and s.scope_id=$2 and s.object_type=$3`,[owner,scope,type,ids,versions])).rows)exact.set(String(row.object_id),String(row.snapshot_hash))
   for(const row of (await db.query(`select distinct object_id from teloa_business_object_snapshots
     where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=any($4::text[]) and snapshot->>'deletedAt' is not null`,[owner,scope,type,ids])).rows)decoupled.add(String(row.object_id))
  }
  const inserts:Array<{item:Snapshot;capturedAt:string}>=[],tombstones:string[]=[]
  for(const [id,candidate] of candidates){
   const current=latest.get(id),alive=current!==undefined&&current.snapshot.deletedAt===undefined
   if(candidate.deleted){if(alive)tombstones.push(id);continue}
   const next=(current?.version??0)+1
   if(raw&&!decoupled.has(id)){
    const snapshot=candidate.snapshot as Snapshot,stored=exact.get(id)
    if(stored!==undefined){
     if(stored===businessObjectSnapshotHash(snapshot))continue
     throw new WorkError('teloa/source-conflict','来源改写了既有对象版本；已拒绝覆盖固定快照。')
    }
    inserts.push({item:snapshot,capturedAt:candidate.capturedAt})
   }else if(raw){
    if(alive&&businessObjectSnapshotHash(readBusinessObjectSnapshot({...candidate.snapshot,version:current.version},scope))===current.hash)continue
    inserts.push({item:readBusinessObjectSnapshot({...candidate.snapshot,version:next},scope),capturedAt:candidate.capturedAt})
   }else{
    const same=alive&&current.snapshot.title===candidate.snapshot.title&&current.snapshot.summary===candidate.snapshot.summary&&JSON.stringify(current.snapshot.fields)===JSON.stringify(candidate.snapshot.fields)
    if(same)continue
    inserts.push({item:readBusinessObjectSnapshot({...candidate.snapshot,version:next},scope),capturedAt:candidate.capturedAt})
   }
  }
  // 全量一条有效条目也没有：多半是来源故障而非真的清空，不拿它去对比缺席（否则整类对象一次全被 tombstone）。
  if(compare&&!candidates.size)console.warn('[teloa] 业务同步全量拉取没有得到有效条目（0 条），已跳过缺席对比：范围 '+scope+'，映射 '+mapping.id+'。')
  else if(compare){
   // 只对比本映射已固定身份的当前版本；旧记录归属未可证时留存，不据缺席推断删除。
   const present=(await db.query(`select c.object_id from ${currentVersionOf()} as c join teloa_business_sync_object_ids m
     on m.owner_id=$1 and m.scope_id=$2 and m.object_type=$3 and m.object_id=c.object_id
     where c.snapshot->>'deletedAt' is null and m.source_key=$4 and m.source_id=$5 and c.source_id=$5 order by c.object_id`,[owner,scope,type,sourceKey,sourceId])).rows.map(row=>String(row.object_id))
   for(const id of present)if(!candidates.has(id))tombstones.push(id)
  }
  signal?.throwIfAborted()
  await this.warehouse.assertQuota(db,owner,scope,inserts.length+tombstones.length)
  for(const {item,capturedAt} of inserts){
   const inserted=await db.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,[owner,scope,type,item.id,item.version,businessObjectSnapshotHash(item),JSON.stringify(item),sourceId,capturedAt])
   if(inserted.rowCount!==1)throw new WorkError('teloa/conflict','业务对象版本被并发写入；本次同步未写入。')
  }
  let tombstoned=0
  for(const id of tombstones)if(await this.warehouse.tombstone(db,owner,scope,type,id,sourceId))tombstoned+=1
  return {fetched:entries.length,upserted:inserts.length,tombstoned}
 }

 private async record(db:PoolClient,owner:string,scope:string,mappingId:string,run:{runId:string;trigger:BusinessSyncTrigger;startedAt:string;finishedAt?:string;status:BusinessSyncRun['status'];outcome:Omit<Outcome,'nextCursor'>&{nextCursor?:string};error?:{code:WorkErrorCode;reason:string}}):Promise<BusinessSyncRun>{
  const finishedAt=run.finishedAt??this.identity.now(),durationMs=Math.max(0,Date.parse(finishedAt)-Date.parse(run.startedAt))
  const row=(await db.query(`insert into teloa_business_sync_runs(owner_id,scope_id,mapping_id,run_id,trigger,started_at,finished_at,status,fetched,upserted,tombstoned,duration_ms,error_code,error_reason,next_cursor,throttled)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) returning *`,
   [owner,scope,mappingId,run.runId,run.trigger,run.startedAt,finishedAt,run.status,run.outcome.fetched,run.outcome.upserted,run.outcome.tombstoned,durationMs,run.error?.code??null,run.error?.reason??null,run.outcome.nextCursor??null,run.status==='throttled'])).rows[0] as Record<string,unknown>
  return runOf(row,scope)
 }
}

/** 当前版本（含 tombstone）子查询：compare 需要先取最大版本再看是否已删、是否本来源写入，与 `currentVersionSubquery` 同一口径。 */
function currentVersionOf():string{
 return '(select distinct on (object_id) object_id,snapshot,source_id from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 order by object_id,object_version desc)'
}

function storedSnapshot(row:Record<string,unknown>,scope:string,type:string):Snapshot{
 let stored:Snapshot
 try{stored=readBusinessObjectSnapshot(row.snapshot,scope)}catch{throw corrupt('固定业务对象快照格式不正确。')}
 if(stored.type!==type||stored.id!==row.object_id||stored.version!==Number(row.object_version)||businessObjectSnapshotHash(stored)!==row.snapshot_hash)throw corrupt('固定业务对象快照与摘要不一致。')
 return stored
}

/**
 * 水位口径：映射声明了 incrementalCursor 才有水位，口径 = 来源（含工具、参数、分页）与 incrementalCursor 的摘要。
 * 映射改版只改标题、版本等不影响取数的字段时口径不变、水位沿用；改了来源或游标声明（含去掉 incrementalCursor）即口径不同，
 * 旧水位按旧口径算出，不再带出——否则会被当成新口径下的参数（如同名续页参数）发给来源，拉到半截或每次都失败。
 * 选口径摘要而不是映射版本号：版本号每次改版都变，按它隔离会让无关改版也丢水位、整量重拉。
 */
function cursorBasis(mapping:BusinessSourceMappingDefinition):string|undefined{
 return mapping.incrementalCursor?createHash('sha256').update(JSON.stringify([mapping.source,mapping.incrementalCursor])).digest('hex').slice(0,32):undefined
}
function cursorOf(row:Record<string,unknown>):CursorState{
 const failures=Number(row.consecutive_failures)
 if(!Number.isSafeInteger(failures)||failures<0||(row.cursor!==null&&typeof row.cursor!=='string')||(row.cursor_basis!==null&&row.cursor_basis!==undefined&&typeof row.cursor_basis!=='string'))throw corrupt('同步游标记录损坏，已停止读取。')
 const backoffUntil=iso(row.backoff_until),lastOkAt=iso(row.last_ok_at)
 return {...(typeof row.cursor==='string'?{cursor:row.cursor}:{}),...(typeof row.cursor_basis==='string'?{cursorBasis:row.cursor_basis}:{}),consecutiveFailures:failures,...(backoffUntil===undefined?{}:{backoffUntil}),...(lastOkAt===undefined?{}:{lastOkAt})}
}

/** 库里读出的同步记录过契约读取器；读取器的回包码在这里一律改成 storage-corrupt（坏的是存储，不是宿主）。 */
function runOf(row:Record<string,unknown>,scope:string):BusinessSyncRun{
 try{
  return readBusinessSyncRun({
   id:row.run_id,mappingId:row.mapping_id,scope:row.scope_id,startedAt:iso(row.started_at),finishedAt:iso(row.finished_at),status:row.status,
   upserted:row.upserted,tombstoned:row.tombstoned,fetched:row.fetched,durationMs:row.duration_ms,
   ...(row.error_code===null?{}:{error:{code:row.error_code,reason:row.error_reason}}),
   ...(row.next_cursor===null?{}:{nextCursor:row.next_cursor}),trigger:row.trigger,
  },scope)
 }catch{throw corrupt('同步记录损坏，已停止读取。')}
}
