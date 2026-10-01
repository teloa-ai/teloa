import {createHash} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isRecord,type BusinessObjectSnapshot,type BusinessDataPage} from '@teloa/contract'
// 与 business-warehouse.ts 互相引用：两边都只在函数体与构造函数里用到对方，模块求值期不触碰，ESM 循环安全。
import {BusinessWarehouseService} from './business-warehouse.ts'

export type {BusinessObjectSnapshot,BusinessDataPage} from '@teloa/contract'

export type BusinessDataQuery={scope:string;text?:string;source?:string;quality?:'complete'|'missing';observedAfter?:string;limit:number;cursor?:string}
export type BusinessDataSourcePage={schema:'teloa.data-source-page/v1';sourceId:string;scope:string;capturedAt:string;items:unknown[];nextCursor?:string}
export type BusinessDataActor={ownerId:string;scopeIds:string[]}
export interface BusinessDataSourcePort {readonly id:string;readonly scopes:readonly string[];query(input:BusinessDataQuery,signal?:AbortSignal):Promise<unknown>}

const safeId=/^[\p{L}\p{N}][\p{L}\p{N}._:@/+ -]{0,199}$/u
const sourceId=/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&!!value.trim()&&value===value.trim()&&value.length<=max&&!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
const stamp=(value:unknown):value is string=>typeof value==='string'&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString()===value
const positive=(value:unknown):value is number=>Number.isSafeInteger(value)&&Number(value)>0&&Number(value)<=2147483647
const cursor=(value:unknown):value is string=>text(value,1024)
const invalidInput=(message:string)=>new WorkError('teloa/invalid-input',message)
const invalidSource=()=>new WorkError('teloa/source-invalid','安全告警来源返回了不符合约定的数据；未以空结果或旧数据替代。')

function exact(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalidSource()
 return value
}

function queryInput(value:unknown):BusinessDataQuery{
 const row=exactInput(value,['scope','text','source','quality','observedAfter','limit','cursor'])
 if(!text(row.scope,120)||row.scope==='general')throw invalidInput('需要明确的业务数据范围。')
 if(row.text!==undefined&&(typeof row.text!=='string'||row.text!==row.text.trim()||row.text.length>200))throw invalidInput('查询文字不合法。')
 if(row.source!==undefined&&!text(row.source,120))throw invalidInput('数据来源筛选不合法。')
 if(row.quality!==undefined&&!['complete','missing'].includes(String(row.quality)))throw invalidInput('数据完整性筛选不合法。')
 if(row.observedAfter!==undefined&&!stamp(row.observedAfter))throw invalidInput('查询时间边界不合法。')
 if(!Number.isSafeInteger(row.limit)||Number(row.limit)<1||Number(row.limit)>100)throw invalidInput('查询数量必须在 1 到 100 之间。')
 if(row.cursor!==undefined&&!cursor(row.cursor))throw invalidInput('数据来源游标不合法。')
 return row as unknown as BusinessDataQuery
}

function exactInput(value:unknown,keys:readonly string[]):Record<string,unknown>{
 if(!isRecord(value)||Object.keys(value).some(key=>!keys.includes(key)))throw invalidInput('业务数据查询参数不正确。')
 return value
}

export function readBusinessObjectSnapshot(value:unknown,scope:string):Omit<BusinessObjectSnapshot,'snapshotHash'>{
 const row=exact(value,['scope','type','id','version','title','source','observedAt','receivedAt','quality','summary','fields','deletedAt'])
 if(row.deletedAt!==undefined&&!stamp(row.deletedAt))throw invalidSource()
 if(row.scope!==scope||!text(row.type,80)||typeof row.id!=='string'||!safeId.test(row.id)||!positive(row.version)||!text(row.title,240)||!text(row.source,120)||!stamp(row.observedAt)||!stamp(row.receivedAt)||String(row.receivedAt)<String(row.observedAt)||!['complete','missing'].includes(String(row.quality))||typeof row.summary!=='string'||row.summary!==row.summary.trim()||row.summary.length>4000||!Array.isArray(row.fields)||row.fields.length>50)throw invalidSource()
 const fields=row.fields.map(value=>{const field=exact(value,['label','value']);if(!text(field.label,120)||typeof field.value!=='string'||field.value!==field.value.trim()||field.value.length>2000)throw invalidSource();return {label:field.label,value:field.value}})
 if(new Set(fields.map(field=>field.label)).size!==fields.length)throw invalidSource()
 // deletedAt 只在 tombstone 版本出现，且放在末尾：旧快照没有这个键，重算出的摘要与入库时逐字相同。
 return {scope,type:row.type as string,id:row.id as string,version:row.version as number,title:row.title as string,source:row.source as string,observedAt:row.observedAt as string,receivedAt:row.receivedAt as string,quality:row.quality as 'complete'|'missing',summary:row.summary as string,fields,...(row.deletedAt===undefined?{}:{deletedAt:row.deletedAt as string})}
}

function sourcePage(value:unknown,source:BusinessDataSourcePort,query:BusinessDataQuery):{capturedAt:string;items:Array<Omit<BusinessObjectSnapshot,'snapshotHash'>>;nextCursor?:string}{
 const row=exact(value,['schema','sourceId','scope','capturedAt','items','nextCursor'])
 if(row.schema!=='teloa.data-source-page/v1'||row.sourceId!==source.id||row.scope!==query.scope||!stamp(row.capturedAt)||!Array.isArray(row.items)||row.items.length>query.limit||(row.nextCursor!==undefined&&!cursor(row.nextCursor)))throw invalidSource()
 const capturedAt=row.capturedAt as string,items=row.items.map(value=>readBusinessObjectSnapshot(value,query.scope)),keys=items.map(item=>item.type+'\0'+item.id),needle=query.text?.toLocaleLowerCase()
 // 即时查询这条路径不接收 tombstone：删除只由同步器按映射的删除语义写入，来源页里带 deletedAt 即不符合约定。
 if(new Set(keys).size!==keys.length||items.some(item=>item.deletedAt!==undefined)||row.nextCursor!==undefined&&row.nextCursor===query.cursor||items.some(item=>item.receivedAt>capturedAt||(query.source!==undefined&&item.source!==query.source)||(query.quality!==undefined&&item.quality!==query.quality)||(query.observedAfter!==undefined&&item.observedAt<query.observedAfter)||(needle!==undefined&&![item.title,item.id,item.type,item.summary,...item.fields.flatMap(field=>[field.label,field.value])].some(value=>value.toLocaleLowerCase().includes(needle)))))throw invalidSource()
 return {capturedAt,items,...(row.nextCursor===undefined?{}:{nextCursor:row.nextCursor as string})}
}

export function businessObjectSnapshotHash(value:Omit<BusinessObjectSnapshot,'snapshotHash'>):string{return createHash('sha256').update(JSON.stringify(value)).digest('hex')}

/** 快照表本身；三个安全转换函数与两条索引由 `initializeBusinessWarehouse` 建（`initialize-database.ts` 紧随其后调用）。 */
export async function initializeBusinessData(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_object_snapshots (
   owner_id text not null, scope_id text not null, object_type text not null, object_id text not null,
   object_version integer not null check(object_version>0), snapshot_hash text not null check(snapshot_hash~'^[a-f0-9]{64}$'),
   snapshot jsonb not null check(jsonb_typeof(snapshot)='object'), source_id text not null, first_seen_at timestamptz not null,
   primary key(owner_id,scope_id,object_type,object_id,object_version)
 )`)
}

async function persist(db:PoolClient,actor:BusinessDataActor,source:BusinessDataSourcePort,capturedAt:string,item:Omit<BusinessObjectSnapshot,'snapshotHash'>):Promise<BusinessObjectSnapshot>{
 const hash=businessObjectSnapshotHash(item)
 await db.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict do nothing`,[actor.ownerId,item.scope,item.type,item.id,item.version,hash,JSON.stringify(item),source.id,capturedAt])
 const row=(await db.query(`select snapshot_hash,snapshot,source_id from teloa_business_object_snapshots
   where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5 for share`,[actor.ownerId,item.scope,item.type,item.id,item.version])).rows[0]
 if(!row||row.snapshot_hash!==hash||row.source_id!==source.id)throw new WorkError('teloa/source-conflict','安全告警来源改写了既有对象版本；已拒绝覆盖固定快照。')
 let stored:Omit<BusinessObjectSnapshot,'snapshotHash'>
 try{stored=readBusinessObjectSnapshot(row.snapshot,item.scope)}catch{throw new WorkError('teloa/storage-corrupt','固定业务对象快照格式不正确。')}
 if(businessObjectSnapshotHash(stored)!==row.snapshot_hash)throw new WorkError('teloa/storage-corrupt','固定业务对象快照与摘要不一致。')
 return {...item,snapshotHash:hash}
}

export class BusinessDataService{
 private readonly pool:Pool
 private readonly source:BusinessDataSourcePort
 private readonly warehouse:BusinessWarehouseService
 constructor(pool:Pool,source:BusinessDataSourcePort){this.pool=pool;this.source=source;this.warehouse=new BusinessWarehouseService(pool,{now:()=>new Date().toISOString()});if(!sourceId.test(source.id)||!source.scopes.length||new Set(source.scopes).size!==source.scopes.length||source.scopes.some(scope=>!text(scope,120)||scope==='general'))throw Error('业务数据源定义不合法。')}
 async query(actor:BusinessDataActor,input:unknown,signal?:AbortSignal):Promise<BusinessDataPage>{
  if(!text(actor.ownerId,128)||!Array.isArray(actor.scopeIds)||!actor.scopeIds.length||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(scope=>!text(scope,120)))throw new WorkError('teloa/forbidden','需要有效的数据读取主体。')
  const query=queryInput(input)
  if(!actor.scopeIds.includes(query.scope)||!this.source.scopes.includes(query.scope))throw new WorkError('teloa/forbidden','当前主体或数据源未获准读取此业务范围。')
  signal?.throwIfAborted()
  let raw:unknown
  try{raw=await this.source.query(query,signal)}catch(error){if(signal?.aborted)throw error;if(error instanceof WorkError)throw error;throw new WorkError('teloa/source-unavailable','安全告警来源当前不可读取；未以空结果或旧数据替代。')}
  signal?.throwIfAborted()
  const page=sourcePage(raw,this.source,query),db=await this.pool.connect()
  try{
   await db.query('begin')
   // 配额每事务一次、按页条数计上界（宁严勿松）；persist 本身不再查 count。
   await this.warehouse.assertQuota(db,actor.ownerId,query.scope,page.items.length)
   const items:BusinessObjectSnapshot[]=[]
   for(const item of page.items)items.push(await persist(db,actor,this.source,page.capturedAt,item))
   await db.query('commit')
   return {schema:'teloa.business-data-page/v1',sourceId:this.source.id,capturedAt:page.capturedAt,items,...(page.nextCursor===undefined?{}:{nextCursor:page.nextCursor})}
  }catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
}

export {queryInput as readBusinessDataQuery}
