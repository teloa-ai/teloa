import type {Pool,PoolClient} from 'pg'
import {
 WorkError,businessLedgerLimits,isBusinessMatchField,isBusinessMatchValue,parseDurationSeconds,parseBooleanValue,
 type BusinessActionRecord,type BusinessLedger,type BusinessLedgerBlock,type BusinessLedgerObject,
 type BusinessObjectFieldDefinition,type BusinessObjectTypeRecord,type BusinessTimeBucket,
 type BusinessViewDefinition,type BusinessViewFilter,type BusinessViewMeasure,type BusinessViewRecord,
 type BusinessViewResult,type BusinessViewRow,type BusinessViewWindow,
} from '@teloa/contract'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash,type BusinessObjectSnapshot} from './business-data.ts'
import {equatableFieldTypes,type BusinessDefinitionSourceReader,type BusinessLedgerOverride} from './business-definition-source.ts'

/** 试算覆盖的类型定义与合并代码放在一处（`business-definition-source.ts`），台账这一层只负责把它透过去。 */
export type {BusinessLedgerOverride}

export type BusinessLedgerActor={ownerId:string;scopeIds:string[]}
/** `match`：只过滤对象清单（list 视图）的等值条件，只能与 `objectType` 同现；`field` 为可等值声明字段或保留字 `_id`（二期规格 §4.3）。 */
export type BusinessLedgerInput={scope:string;objectType?:string;match?:{field:string;value:string}}
export type BusinessLedgerActionAvailability=(db:PoolClient,ownerId:string,action:BusinessActionRecord)=>Promise<boolean>

/**
 * 扫描去重对象标识时多取一个（5000+1）：第 5001 个只用来判 `truncated`，不参与任何计算。
 * 上限是字面量常量、不做设置项（规格 §8 第 3 条），出处 `businessLedgerLimits.scanRows`。
 */
const SCAN_LIMIT=businessLedgerLimits.scanRows+1
/**
 * 时间桶的界面文案由服务端一次算好（契约 `BusinessViewRow.label`），客户端不再推导。
 * 台账端点的入参白名单（`scope`/`objectType`/`match`）里没有语言，因此先钉死缺省语言；
 * 请求语言接进来时只改这一处，行的稳定键 `dimension` 不受语言影响。
 */
const DEFAULT_LOCALE='zh-CN'
const DAY=86400000
/** 引用取值的形状判据与 `BusinessObjectSnapshot.id` 同一条（business-data.ts 的 `safeId`），不另立一套。 */
const safeId=/^[\p{L}\p{N}][\p{L}\p{N}._:@/+ -]{0,199}$/u
const localId=/^[a-zA-Z0-9][a-zA-Z0-9-]{0,119}$/
const badMatch=()=>invalidInput('按字段取值过滤的参数不正确。')
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const invalidInput=(message:string)=>new WorkError('teloa/invalid-input',message)
const forbidden=(message:string)=>new WorkError('teloa/forbidden',message)
const unavailable=(message:string)=>new WorkError('teloa/source-unavailable',message)

/** 入参白名单键精确匹配，形状照 `readBusinessDataQuery`：多一个键就是不认识的请求，不容忍。 */
function ledgerInput(value:unknown):BusinessLedgerInput{
 if(typeof value!=='object'||value===null||Array.isArray(value))throw invalidInput('业务台账请求参数不正确。')
 const row=value as Record<string,unknown>
 if(Object.keys(row).some(key=>key!=='scope'&&key!=='objectType'&&key!=='match'))throw invalidInput('业务台账请求参数不正确。')
 // 范围标签会原样拼进错误文案、并随文案进模型上下文：允许换行等于允许在那里另起一段，是注入面（规格 §8 第 1 条）。
 if(!text(row.scope,120)||row.scope==='general'||/[\r\n]/.test(row.scope))throw invalidInput('需要明确的业务范围。')
 if(row.objectType!==undefined&&(typeof row.objectType!=='string'||!localId.test(row.objectType)))throw invalidInput('业务对象类型标识不合法。')
 if(row.match===undefined)return {scope:row.scope,...(row.objectType===undefined?{}:{objectType:row.objectType as string})}
 // 过滤值来自界面（组件结果单元格），不可信：只在内存里做等值比较，一个字节也不进 SQL（二期规格 §10 第 7 条）。
 const match=row.match as Record<string,unknown>|null
 if(row.objectType===undefined||typeof match!=='object'||match===null||Array.isArray(match)||Object.keys(match).length!==2)throw badMatch()
 // 字段为契约字段标识或 `_id`（对象标识的保留字，供按行下钻把目标对象确定地放进清单）；取值判据同契约。
 if(!isBusinessMatchField(match.field)||!isBusinessMatchValue(match.value))throw badMatch()
 return {scope:row.scope,objectType:row.objectType as string,match:{field:match.field,value:match.value}}
}

/** 一个对象：固定快照本身，加上按声明解析过一遍的字段取值（解析不出来的键直接不存在）。 */
/** 解析后的字段取值：text/enum/reference/datetime 是字符串，number/duration 是数字（duration 已归一为秒），boolean 是布尔。 */
export type BusinessBasicFieldValue=string|number|boolean
type LedgerObject={snapshot:BusinessObjectSnapshot;values:Map<string,BusinessBasicFieldValue>}
type LedgerBatch={objects:LedgerObject[];truncated:boolean;latestReceivedAt:string|null}

/**
 * 一个视图真正引用到的字段名：缺失披露只覆盖它们，别的字段读不出来与这张图无关（规格 §5.4 第 4 档）。
 * 预览的影响范围（"这份声明引用到哪些字段"）用的是同一个判据，因此导出共用，不在预览那边再抄一遍。
 */
export function viewFields(view:BusinessViewDefinition):Set<string>{
 const names=new Set<string>()
 if(view.dimension)names.add(view.dimension.field)
 if(view.window)names.add(view.window.field)
 for(const filter of view.filters)names.add(filter.field)
 for(const measure of view.measures){
  if(measure.field!==undefined)names.add(measure.field)
  if(measure.where)names.add(measure.where.field)
 }
 return names
}

/**
 * 七种字段的解析（规格 §4.1、§4.2）。解析失败不报错、不猜、不回退零值：该对象在该字段上"缺失"，
 * 度量计入 null，字段名进 `missingFields`。这与数据源自报的 `quality:'missing'` 是两回事——
 * 那一路是来源说自己不全，这一路是本层按声明读不出来；两者都算缺失，但 `quality` 不由本层改写（规格 §5.4 第 4 档）。
 */
export function parseBusinessBasicField(field:BusinessObjectFieldDefinition,raw:string|undefined,known:Map<string,Set<string>>):BusinessBasicFieldValue|undefined{
 if(raw===undefined)return undefined
 if(field.type==='text')return raw
 if(field.type==='enum')return field.values?.includes(raw)?raw:undefined
 if(field.type==='number'){const value=Number.parseFloat(raw);return Number.isFinite(value)&&Math.abs(value)<=1e15?value:undefined}
 if(field.type==='datetime')return Number.isFinite(Date.parse(raw))&&new Date(raw).toISOString()===raw?raw:undefined
 // duration 归一为秒、boolean 归一为真假：解析规则在契约包里，与 SQL 改写器共用同一份（规格 §4.2）。
 if(field.type==='duration')return parseDurationSeconds(raw)
 if(field.type==='boolean')return parseBooleanValue(raw)
 // reference：形状先过 safeId，再要求目标落在同一次取数的同一个 scope 里——跨范围一律视为缺失（规格 §8 第 4 条）。
 return safeId.test(raw)&&known.get(field.referenceType??'')?.has(raw)?raw:undefined
}

/** 把声明里的字面量与解析后的取值放在同一把尺子上比；比不了（字面量本身不合法）即不成立。 */
export function compareBusinessBasicField(field:BusinessObjectFieldDefinition,value:BusinessBasicFieldValue,literal:string):number|undefined{
 if(field.type==='number'){const bound=Number.parseFloat(literal);return Number.isFinite(bound)?Math.sign((value as number)-bound):undefined}
 if(field.type==='datetime'){const bound=Date.parse(literal);return Number.isFinite(bound)?Math.sign(Date.parse(value as string)-bound):undefined}
 // duration 的字面量与取值同走 parseDurationSeconds（`PT1H` 与 `3600` 等价）；boolean 只有相等/不等，能力表不放行 gte/lte。
 if(field.type==='duration'){const bound=parseDurationSeconds(literal);return bound===undefined?undefined:Math.sign((value as number)-bound)}
 if(field.type==='boolean'){const bound=parseBooleanValue(literal);return bound===undefined?undefined:value===bound?0:1}
 return value===literal?0:String(value)<literal?-1:1
}

/**
 * 一条筛选。取值缺失即不成立——包括 `ne`：读不出来的字段不能拿来断言"它不等于某个值"，
 * 否则缺失就会被悄悄算进"其他"那一侧（规格 §4.1"不落其他桶"的同一条口径）。
 */
function matches(filter:BusinessViewFilter,fields:Map<string,BusinessObjectFieldDefinition>,values:Map<string,BusinessBasicFieldValue>):boolean{
 const field=fields.get(filter.field),value=values.get(filter.field)
 if(!field||value===undefined)return false
 if(filter.op==='in')return filter.values.some(literal=>compareBusinessBasicField(field,value,literal)===0)
 const order=compareBusinessBasicField(field,value,filter.values[0]!)
 if(order===undefined)return false
 if(filter.op==='eq')return order===0
 if(filter.op==='ne')return order!==0
 if(filter.op==='gte')return order>=0
 return order<=0
}

/** 相对时间窗按白名单枚举翻成区间，没有算术参数；`overdue` 固定为「该字段早于计算时刻」（契约 businessViewWindows）。 */
export function businessViewWindowRange(relative:BusinessViewWindow['relative'],now:number):{from:number;to:number;inclusive:boolean}{
 if(relative==='last-24h')return {from:now-DAY,to:now,inclusive:true}
 if(relative==='last-7d')return {from:now-7*DAY,to:now,inclusive:true}
 if(relative==='last-30d')return {from:now-30*DAY,to:now,inclusive:true}
 if(relative==='next-7d')return {from:now,to:now+7*DAY,inclusive:true}
 if(relative==='next-30d')return {from:now,to:now+30*DAY,inclusive:true}
 return {from:Number.NEGATIVE_INFINITY,to:now,inclusive:false}
}

/** 桶起点一律按 UTC 取：`dimension` 要当稳定键与回传筛选用，不能随读的人所在时区变。 */
export function businessViewBucketStart(iso:string,bucket:BusinessTimeBucket):string{
 const date=new Date(iso)
 if(bucket==='hour')date.setUTCMinutes(0,0,0)
 else{
  date.setUTCHours(0,0,0,0)
  if(bucket==='week')date.setUTCDate(date.getUTCDate()-((date.getUTCDay()+6)%7))
  else if(bucket==='month')date.setUTCDate(1)
 }
 return date.toISOString()
}

export const businessViewBucketFormat:Record<BusinessTimeBucket,Intl.DateTimeFormatOptions>={
 hour:{year:'numeric',month:'short',day:'numeric',hour:'2-digit',timeZone:'UTC'},
 day:{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'},
 week:{year:'numeric',month:'long',day:'numeric',timeZone:'UTC'},
 month:{year:'numeric',month:'long',timeZone:'UTC'},
}

/**
 * 一项度量在一组对象上的取值。`count` 不绑字段、恒有数；其余四项在没有一个对象解析出取值时是 null，不是 0——
 * "没有可计的对象"与"算出来是零"在界面上是两件事（规格 §4.1）。
 * `datetime` 的 min/max 回的是毫秒时刻：契约 `BusinessViewRow.values` 只收数字，客户端按度量声明的字段类型还原。
 */
function aggregate(measure:BusinessViewMeasure,fields:Map<string,BusinessObjectFieldDefinition>,group:LedgerObject[]):number|null{
 const subset=measure.where?group.filter(object=>matches(measure.where!,fields,object.values)):group
 if(measure.aggregation==='count')return subset.length
 const field=fields.get(measure.field??'')
 if(!field)return null
 const numbers:number[]=[]
 for(const object of subset){
  const value=object.values.get(measure.field!)
  if(value===undefined)continue
  numbers.push(field.type==='datetime'?Date.parse(value as string):value as number)
 }
 if(!numbers.length)return null
 if(measure.aggregation==='sum')return numbers.reduce((total,value)=>total+value,0)
 if(measure.aggregation==='avg')return numbers.reduce((total,value)=>total+value,0)/numbers.length
 if(measure.aggregation==='min')return Math.min(...numbers)
 return Math.max(...numbers)
}

/** owner/scope/type 内取最大版本后再排除 tombstone，硬截 5000；可选 sourceId 进一步核对真实来源归属。 */
export async function loadBusinessViewSnapshots(db:PoolClient,ownerId:string,scope:string,objectType:string,sourceId?:string):Promise<Array<{snapshot:BusinessObjectSnapshot}>&{truncated:boolean}>{
  const sql=`with ids as (
   select distinct object_id from teloa_business_object_snapshots
   where owner_id=$1 and scope_id=$2 and object_type=$3 order by object_id limit $4
  ), current as (
   select distinct on (s.object_id) s.object_id,s.object_version,s.source_id,s.snapshot,s.snapshot_hash
   from teloa_business_object_snapshots s join ids on ids.object_id=s.object_id
   where s.owner_id=$1 and s.scope_id=$2 and s.object_type=$3
   order by s.object_id,s.object_version desc
  ) select object_id,object_version,source_id,snapshot,snapshot_hash from current order by object_id`
  const rows=(await db.query(sql,[ownerId,scope,objectType,SCAN_LIMIT])).rows as Array<{object_id:string;object_version:number;source_id:string;snapshot:unknown;snapshot_hash:string}>
  const truncated=rows.length>businessLedgerLimits.scanRows
  const kept=truncated?rows.slice(0,businessLedgerLimits.scanRows):rows
  /**
   * 当前版本是 tombstone 的对象不进台账（取最大版本之后再滤，否则被删对象的上一版本会重新冒出来）：
   * 它已不在来源里，且回包快照带 deletedAt 会被宿主严格键集拒绝。截断仍按滤前行数判，与扫描上限同一口径。
   */
  const objects=kept.flatMap(row=>{
   let stored:Omit<BusinessObjectSnapshot,'snapshotHash'>
   try{stored=readBusinessObjectSnapshot(row.snapshot,scope)}catch{throw new WorkError('teloa/storage-corrupt','固定业务对象快照格式不正确。')}
   if(stored.id!==row.object_id||stored.version!==Number(row.object_version)||(sourceId!==undefined&&row.source_id!==sourceId)||stored.type!==objectType||businessObjectSnapshotHash(stored)!==row.snapshot_hash)throw new WorkError('teloa/storage-corrupt','固定业务对象快照与摘要不一致。')
   return stored.deletedAt===undefined?[{snapshot:{...stored,snapshotHash:row.snapshot_hash}}]:[]
  })
  return Object.assign(objects,{truncated})
}

/**
 * 按已固定快照表算出一个业务范围的台账。
 *
 * 聚合放在服务端 TypeScript 里、SQL 只负责"取当前版本 + 硬截 5000 行"：数据源端口没有聚合接口，
 * 在源上算一次分布要翻页到穷尽，外部系统会被业务人员的每一次点击放大打一遍（规格 §4.2）。
 * 代价是统计的分母只是"已同步的对象"，由 `BusinessViewCoverage` 三项如实回报，不藏。
 */
export class BusinessLedgerService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly definitions:Pick<BusinessDefinitionSourceReader,'forScope'>
 private readonly actionAvailability:BusinessLedgerActionAvailability|undefined
 constructor(pool:Pool,identity:{now:()=>string},definitions:Pick<BusinessDefinitionSourceReader,'forScope'>,actionAvailability?:BusinessLedgerActionAvailability){this.pool=pool;this.identity=identity;this.definitions=definitions;this.actionAvailability=actionAvailability}

 /**
  * 取每个对象的当前版本：先按 (owner,scope,type) 取去重对象标识并硬截 5001 个（多出的那一个只用来判 truncated，
  * 不参与任何计算），再按 object_version 倒序取每个标识的第一行。
  * 表名与列名是代码内常量，object_type 与每个取值都是占位符——声明里的任何字符串都不拼进 SQL 文本
  *（与 industry-instance-kit.ts 里"表名只取代码内常量、值全走占位符"的既有做法同规矩）。
  */
 private load=loadBusinessViewSnapshots

 /**
  * 某个对象类型在本范围内的去重标识集，只用来判 `reference` 的同范围约束，因此不回读整份快照。
  * 它与块的取数各走各的：块会被 5000 行硬截且有 `coverage.truncated` 披露；这条判据没有对应的披露出口，
  * 因此超过上限一律拒绝整条台账计算而不截断——截断会让同一条引用因为"这次扫到第几个"时而成立时而缺失，
  * 且用户看到的会是一个无从解释的缺失（复审 MEDIUM-2，规格 §8 第 7 条「失败不静默」）。
  * 被引用但没有被选中计算的对象类型，也在同一个只读可重复读事务里单取这一趟。
  */
 private async loadIds(db:PoolClient,ownerId:string,scope:string,objectType:string):Promise<Set<string>>{
  // 被 tombstone 的对象不算引用目标：先取每个对象的最大版本，再滤掉其中的 tombstone。
  const rows=(await db.query(`select object_id from (select distinct on (object_id) object_id,snapshot from teloa_business_object_snapshots
   where owner_id=$1 and scope_id=$2 and object_type=$3 order by object_id,object_version desc) as latest
   where latest.snapshot->>'deletedAt' is null order by object_id limit $4`,[ownerId,scope,objectType,SCAN_LIMIT])).rows as Array<{object_id:string}>
  if(rows.length>businessLedgerLimits.scanRows)throw unavailable('业务范围 '+scope+' 的对象类型 '+objectType+' 引用目标超过 '+businessLedgerLimits.scanRows+' 个，台账不予截断计算。')
  return new Set(rows.map(row=>row.object_id))
 }

 /** 一个范围一次请求：同一个只读可重复读事务、同一批行里算完全部视图（规格 §4.3）。 */
 async read(actor:BusinessLedgerActor,input:unknown,signal?:AbortSignal,override?:BusinessLedgerOverride):Promise<BusinessLedger>{
  const db=await this.pool.connect()
  try{
   /**
    * 只读 + 可重复读：同一次台账请求里的每个块、每个视图都读同一份 MVCC 快照，块与块之间不会出现
    * 互相矛盾的数字；`read only` 让"这条路径一个字节也不写"由数据库自己担保，而不是靠读代码确认。
    * `forScope` 经由 `MarketContentStore` 读固定内容时走的是不取锁的读口（`getInTransaction(...,false)`，
    * 见 `business-definition-source.ts` 构造函数）——`for share` 与 `read only` 在 Postgres 里不能共存（25006）。
    * 快照表本身是"读过即固定"的追加表（`business-data.ts` 的 persist 拒绝改写既有版本），不需要另取行锁。
    */
   await db.query('begin isolation level repeatable read read only')
   const ledger=await this.computeInTransaction(db,actor,input,signal,override)
   await db.query('commit')
   return ledger
  }catch(error){await db.query('rollback').catch(()=>{});throw error}finally{db.release()}
 }

 /**
  * 同一次只读事务里算一份台账：`read` 只是"自己开一个事务"的外壳，判据与计算全在这里，两条路径不各写一遍。
  * 预览要把差异、影响范围与试算算在**同一份 MVCC 快照**上（否则差异的基准与试算的底稿可能来自两个时间点，
  * 用户看到的"改动前"与"改动后"就不是同一件事），因此它自己开事务并调这一个方法。
  * 事务仍由调用方按 `repeatable read read only` 开——试算写不进任何东西由数据库担保，不靠读代码确认。
  */
 async computeInTransaction(db:PoolClient,actor:BusinessLedgerActor,input:unknown,signal?:AbortSignal,override?:BusinessLedgerOverride):Promise<BusinessLedger>{
  if(!text(actor?.ownerId,128)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)))throw forbidden('需要有效的台账读取主体。')
  const query=ledgerInput(input)
  if(!actor.scopeIds.includes(query.scope))throw forbidden('当前主体未获准读取此业务范围。')
  signal?.throwIfAborted()
  return this.compute(db,actor,query,signal,override)
 }

 private async compute(db:PoolClient,actor:BusinessLedgerActor,query:BusinessLedgerInput,signal?:AbortSignal,override?:BusinessLedgerOverride):Promise<BusinessLedger>{
  const bundles=await this.definitions.forScope(db,actor.ownerId,query.scope,override)
  if(bundles.some(bundle=>bundle.objectTypes.some(row=>row.definition.format!=='teloa.business-object-type/v1'||row.definition.fields.some(field=>'format' in field))))throw new WorkError('teloa/dependency-unavailable','旧业务台账尚不支持富字段配置，请使用记录页面。')
  signal?.throwIfAborted()
  const objectTypes:BusinessObjectTypeRecord[]=[],views:BusinessViewRecord[]=[],actions:BusinessActionRecord[]=[]
  const connected=new Map<string,Omit<BusinessLedgerBlock['source'],'sourceId'>>()
  for(const bundle of bundles){
   objectTypes.push(...bundle.objectTypes);views.push(...bundle.views);actions.push(...bundle.actions)
   // 名称只是称呼：取已连接的加载优先；连接状态相同时保留加载目录顺序中的第一份。
   // 不拼接异名、不为异名阻断台账，也不让未连接加载盖掉已连接的来源。
   for(const [sourceId,source] of bundle.sources){
    const previous=connected.get(sourceId)
    if(!previous||source.connected&&!previous.connected)connected.set(sourceId,source)
   }
  }
  // 超出上限不截断、不静默丢弃：读不出来就说读不出来，不以少一块的台账替代（规格 §8 第 7 条）。
  if(objectTypes.length>businessLedgerLimits.objectTypes)throw unavailable('业务范围 '+query.scope+' 的对象类型声明超过 '+businessLedgerLimits.objectTypes+' 个，台账不予截断计算。')
  const selected=query.objectType===undefined?objectTypes:objectTypes.filter(row=>row.definition.id===query.objectType)
  if(query.objectType!==undefined&&!selected.length)throw unavailable('业务范围 '+query.scope+' 内没有对象类型声明 '+query.objectType+'。')
  const match=query.match
  if(match&&match.field!=='_id'&&!selected[0]!.definition.fields.some(field=>field.name===match.field&&equatableFieldTypes.has(field.type)))throw badMatch()

  /**
   * 引用目标的标识集按**范围**建，而不是按"这次选中算哪几个块"建：否则同一条 `reference`
   * 会因为调用方带没带 `objectType` 而时而成立时而缺失，同范围约束就不是一条稳定判据了。
   * 只收选中块真正声明了的 `referenceType`，不为无人引用的对象类型白跑一趟。
   */
  const known=new Map<string,Set<string>>()
  for(const record of selected)for(const field of record.definition.fields){
   if(field.type!=='reference'||field.referenceType===undefined||known.has(field.referenceType))continue
   known.set(field.referenceType,await this.loadIds(db,actor.ownerId,query.scope,field.referenceType))
   signal?.throwIfAborted()
  }

  const batches=new Map<string,LedgerBatch>()
  for(const record of selected){
   const rows=await this.load(db,actor.ownerId,query.scope,record.definition.id)
   signal?.throwIfAborted()
   const objects=rows.map(row=>{
    // 快照字段先按标签建索引：一个对象类型最多 50 个声明字段 × 50 个快照字段，逐个 find 是没必要的二次方扫描。
    const byLabel=new Map(row.snapshot.fields.map(field=>[field.label,field.value]))
    const values=new Map<string,BusinessBasicFieldValue>()
    for(const field of record.definition.fields){
     const parsed=parseBusinessBasicField(field,byLabel.get(field.from),known)
     if(parsed!==undefined)values.set(field.name,parsed)
    }
    return {snapshot:row.snapshot,values}
   })
   batches.set(record.definition.id,{
    objects,truncated:rows.truncated,
    latestReceivedAt:objects.length?objects.map(object=>object.snapshot.receivedAt).reduce((latest,value)=>value>latest?value:latest):null,
   })
  }

  const computedAt=this.identity.now()
  const actionsById=new Map(actions.map(row=>[row.definition.id,row]))
  const blocks:BusinessLedgerBlock[]=await Promise.all(selected.map(async record=>{
   const batch=batches.get(record.definition.id)!
   const declared=views.filter(row=>row.definition.objectType===record.definition.id)
   if(declared.length>businessLedgerLimits.viewsPerType)throw unavailable('业务范围 '+query.scope+' 的对象类型 '+record.definition.id+' 声明了超过 '+businessLedgerLimits.viewsPerType+' 个视图，台账不予截断计算。')
   // 清单视图逐条列对象，只在指名了对象类型时才算：不指名就等于把全部块都按对象逐条展开，是另一个量级的读。
   const usable=query.objectType===undefined?declared.filter(row=>row.definition.kind!=='list'):declared
   const fields=new Map(record.definition.fields.map(field=>[field.name,field]))
   const defaultAction=record.definition.defaultAction===undefined?undefined:actionsById.get(record.definition.defaultAction)
   const declaration=record.definition.progress
   // 阶段和最近变化都只认对象类型声明里指明的字段。没有声明就整段缺省，不能从字段名称、行业或同步时刻猜一份出来。
   const progress=declaration===undefined?undefined:{
    unfinished:batch.objects.filter(object=>{const value=object.values.get(declaration.stageField);return typeof value==='string'&&declaration.unfinished.includes(value)}).length,
    waitingForYou:batch.objects.filter(object=>{const value=object.values.get(declaration.stageField);return typeof value==='string'&&declaration.waitingForYou.includes(value)}).length,
    latestChangedAt:declaration.changedAtField===undefined?null:batch.objects.reduce<string|null>((latest,object)=>{
     const value=object.values.get(declaration.changedAtField!)
     if(typeof value!=='string')return latest
     return latest===null||value>latest?value:latest
    },null),
   }
   return {
    objectType:record,
    objects:batch.objects.length,
    source:{sourceId:record.definition.sourceId,...(connected.get(record.definition.sourceId)??{connected:false})},
    // 块级覆盖面：一张视图都没声明的块也要有分母交代，不能只挂在某一张视图上（复审 HIGH-2）。
    coverage:{objects:batch.objects.length,latestReceivedAt:batch.latestReceivedAt,truncated:batch.truncated},
    ...(progress?{progress}:{}),
    // 块级缺失披露是全量的：不按视图收窄，按对象类型的声明顺序列出"至少有一个对象读不出取值"的字段。
    missingFields:record.definition.fields.filter(field=>batch.objects.some(object=>object.values.get(field.name)===undefined)).map(field=>field.name),
    ...(defaultAction?{defaultAction:{
     actionId:defaultAction.definition.id,title:defaultAction.definition.title,targetKind:defaultAction.definition.target.kind,
     // 执行面动作只有实际连接已授权、来源未漂移时才出现入口；客户端不得自行判断连接状态。
     available:defaultAction.definition.target.kind==='work-template'||(await this.actionAvailability?.(db,actor.ownerId,defaultAction))===true,
    }}:{}),
    views:usable.map(view=>this.computeView(view,record,fields,batch,query.scope,computedAt,match)),
   }
  }))
  const selectedIds=new Set(selected.map(record=>record.definition.id))
  return {
   schema:'teloa.business-ledger/v1',scope:query.scope,computedAt,blocks,
   actions:actions.filter(row=>selectedIds.has(row.definition.objectType)),
  }
 }

 private computeView(record:BusinessViewRecord,objectType:BusinessObjectTypeRecord,fields:Map<string,BusinessObjectFieldDefinition>,batch:LedgerBatch,scope:string,computedAt:string,match?:BusinessLedgerInput['match']):BusinessViewResult{
  const view=record.definition,names=viewFields(view)
  // 下钻的等值过滤只作用于对象清单，且在取前 N 行之前：分析视图保持全量，与视图筛选用同一把比较尺（`matches`）。
  const matched=view.kind!=='list'||!match?undefined:match.field==='_id'
   ?(object:LedgerObject)=>object.snapshot.id===match.value
   :(object:LedgerObject)=>matches({field:match.field,op:'eq',values:[match.value]},fields,object.values)
  // 时间窗、视图筛选、度量各自的 where 是与关系：前两者先把参与计算的对象筛出来，度量的 where 再在组内收一次。
  const range=view.window?businessViewWindowRange(view.window.relative,Date.parse(computedAt)):undefined
  const eligible=batch.objects.filter(object=>{
   if(view.window&&range){
    const value=object.values.get(view.window.field)
    if(value===undefined)return false
    const at=Date.parse(value as string)
    if(at<range.from||(range.inclusive?at>range.to:at>=range.to))return false
   }
   return view.filters.every(filter=>matches(filter,fields,object.values))&&(matched===undefined||matched(object))
  })

  const rows=view.kind==='board-card'?this.boardRows(view,fields,eligible)
   :view.kind==='list'?this.listRows(view,fields,eligible)
   :this.groupRows(view,fields,eligible)
  const ordered=this.order(view,rows)
  const limit=view.dimension?Math.min(view.limit,view.dimension.limit):view.limit
  const kept=view.kind==='board-card'?ordered:ordered.slice(0,limit)
  return {
   schema:'teloa.business-view-result/v1',
   viewId:view.id,viewVersion:view.version,definitionHash:record.source.definitionHash,
   // 这一份结果算的是模板声明还是本地定制声明，取该视图声明的 source.origin，不另判断（D3）。
   origin:record.source.origin,
   // 形态、图表与标题逐字照声明带出去：界面不从行的形状反推，也不拿 rows[0].label 当标题（复审 HIGH-1、MEDIUM-3）。
   kind:view.kind,chart:view.chart,title:view.title,...(view.localized?{localized:view.localized}:{}),...(view.dimension?{dimensionField:view.dimension.field}:{}),
   scope,objectType:objectType.definition.id,computedAt,
   /**
    * 度量绑定字段的声明类型随结果一起带出去：`datetime` 的 min/max 回的是毫秒时刻，界面据此还原成时间。
    * `count` 不绑字段，这一位缺省——此前界面只能拿度量标识去撞同名字段声明，一个 count 度量
    * 恰好与某个 datetime 字段同名就会被画成 1970 年（复审 MEDIUM-2）。
    */
   measures:view.measures.map(measure=>{
    const type=measure.field===undefined?undefined:fields.get(measure.field)?.type
    return {id:measure.id,label:measure.label,...(measure.localized?{localized:measure.localized}:{}),...(type?{fieldType:type}:{})}
   }),
   rows:kept.map(row=>row.row),
   // 截断前的组数：界面据此只在真的截断时才说"共几项、显示前几项"（复审 MEDIUM-1）。
   dimensionValues:ordered.length,
   coverage:{objects:batch.objects.length,latestReceivedAt:batch.latestReceivedAt,truncated:batch.truncated},
   /**
    * 缺失披露按规格 §4.1：本视图引用到的字段里，只要有一个参与计算的对象读不出取值就列出来——
    * 部分缺失正是要给用户看的那一档（§5.4 第 4 档"N 条缺少 <字段名>，未计入"），等到全批次都读不出来才说已经太晚。
    * 判据落在整批对象上而不是筛完剩下的：被这个字段筛掉的对象恰恰是要被交代的那几条。
    * 按对象类型的声明顺序输出，每个视图各自一份数组。
    */
   missingFields:objectType.definition.fields.filter(field=>names.has(field.name)&&batch.objects.some(object=>object.values.get(field.name)===undefined)).map(field=>field.name),
   ...(view.kind==='list'?{objects:kept.map(row=>ledgerObject(row.objects![0]!.snapshot))}:{}),
  }
 }

 /** 大盘卡没有维度：恒定一行，`dimension` 空串占住稳定键的位置，`label` 用声明标题当卡面文案。 */
 private boardRows(view:BusinessViewDefinition,fields:Map<string,BusinessObjectFieldDefinition>,eligible:LedgerObject[]):RowDraft[]{
  return [{row:{dimension:'',label:view.title,values:view.measures.map(measure=>aggregate(measure,fields,eligible))}}]
 }

 /** 清单视图一行一个对象：`dimension` 取对象标识当稳定键，度量按"这一个对象"算。 */
 private listRows(view:BusinessViewDefinition,fields:Map<string,BusinessObjectFieldDefinition>,eligible:LedgerObject[]):RowDraft[]{
  return eligible.map(object=>({
   row:{dimension:object.snapshot.id,label:object.snapshot.title,values:view.measures.map(measure=>aggregate(measure,fields,[object]))},
   objects:[object],
  }))
 }

 /** 分布与趋势：按维度取值分组；解析不出维度取值的对象既不成桶也不落"其他"（规格 §4.1）。 */
 private groupRows(view:BusinessViewDefinition,fields:Map<string,BusinessObjectFieldDefinition>,eligible:LedgerObject[]):RowDraft[]{
  const dimension=view.dimension!
  const groups=new Map<string,LedgerObject[]>()
  for(const object of eligible){
   const value=object.values.get(dimension.field)
   if(value===undefined)continue
   const key=dimension.bucket?businessViewBucketStart(value as string,dimension.bucket):String(value)
   const group=groups.get(key)
   if(group)group.push(object)
   else groups.set(key,[object])
  }
  const format=dimension.bucket?new Intl.DateTimeFormat(DEFAULT_LOCALE,businessViewBucketFormat[dimension.bucket]):undefined
  return [...groups].map(([key,group])=>({
   row:{dimension:key,label:format?format.format(new Date(key)):key,values:view.measures.map(measure=>aggregate(measure,fields,group))},
  }))
 }

 /** 排序按声明走；没有取值的度量一律排在后面，空值不冒充最小值。 */
 private order(view:BusinessViewDefinition,rows:RowDraft[]):RowDraft[]{
  if(!view.sort)return rows
  const direction=view.sort.direction==='asc'?1:-1
  const byMeasure=view.sort.by==='measure'
  const index=byMeasure?view.measures.findIndex(measure=>measure.id===view.sort!.measureId):-1
  // 契约的 sortDefinition 已经要求 measureId 指向本视图的度量：这里对不上只可能是固定内容被改坏了，不能悄悄退回按维度排。
  if(byMeasure&&index<0)throw new WorkError('teloa/storage-corrupt','业务视图排序依据的度量不在本视图声明里。')
  return [...rows].sort((left,right)=>{
   if(index<0)return left.row.dimension<right.row.dimension?-direction:left.row.dimension>right.row.dimension?direction:0
   const a=left.row.values[index],b=right.row.values[index]
   if(a===null||a===undefined)return b===null||b===undefined?0:1
   if(b===null||b===undefined)return -1
   return a===b?0:a<b?-direction:direction
  })
 }
}

type RowDraft={row:BusinessViewRow;objects?:LedgerObject[]}

/** 清单视图的 objects 段：平台四列与对象详情全部来自固定快照本身，本层不添一个字段。 */
function ledgerObject(snapshot:BusinessObjectSnapshot):BusinessLedgerObject{
 return {
  id:snapshot.id,title:snapshot.title,source:snapshot.source,observedAt:snapshot.observedAt,receivedAt:snapshot.receivedAt,
  quality:snapshot.quality,version:snapshot.version,snapshotHash:snapshot.snapshotHash,summary:snapshot.summary,fields:snapshot.fields,
 }
}
