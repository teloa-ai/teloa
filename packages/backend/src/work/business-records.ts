import {createHash,randomUUID} from 'node:crypto'
import type {Pool,PoolClient} from 'pg'
import {WorkError,isBusinessScopeKey,businessObjectReference,readBusinessRecordCreate,readBusinessRecordEdit,readBusinessRecordArchive,readBusinessRecordGet,readBusinessRecordList,readBusinessRecordReceipt,readBusinessRecordBatch,readBusinessRichFieldValue,type BusinessRecordBatchResult,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,type BusinessObjectReference,type BusinessObjectSnapshot,type BusinessDataPage,type BusinessRecordCreate,type BusinessRecordEdit,type BusinessRecordArchive,type BusinessRecordTarget} from '@teloa/contract'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import type {BusinessDefinitionSourceReader} from './business-definition-source.ts'
import type {BusinessWarehouseService} from './business-warehouse.ts'
import type {BusinessSnapshotReferenceService} from './business-snapshot-references.ts'
import {assertBusinessRecordFieldValue,assertBusinessRecordUniqueState} from './business-record-values.ts'
import {lockBusinessConfiguration} from './business-configuration-lock.ts'
import {hasBusinessRecordUniqueConstraints,lockBusinessRecordTypes,readBusinessRecordConstraintState} from './business-record-constraints.ts'
import {businessRecordSchemaFingerprint,type BusinessRecordBatchDefinitionGuard} from './business-record-schema.ts'
type Actor={ownerId:string;scopeIds:string[]}
type Dependencies={definitions:Pick<BusinessDefinitionSourceReader,'forScope'>&Partial<Pick<BusinessDefinitionSourceReader,'forScopeVersioned'>>;warehouse:Pick<BusinessWarehouseService,'assertQuota'|'tombstone'>;references:Pick<BusinessSnapshotReferenceService,'pinInTransaction'>}
type Head={source_id:string;current_version:number;created_at:Date}
type SnapshotRow={object_version:number;source_id:string;snapshot_hash:string;snapshot:unknown}
type Operation='create'|'edit'|'archive'
type WriteInput=BusinessRecordCreate|BusinessRecordEdit|BusinessRecordArchive
type Prepared={operation:Operation;input:WriteInput;requestHash:string;definition:BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2;before:BusinessObjectSnapshot|undefined;snapshot:ReturnType<typeof readBusinessObjectSnapshot>|undefined;now:string}
export type BusinessRecordBatchSource={sessionId:string;messageId:string;seq:number}
type BatchRow={request_id:string;request_hash:string;scope_id:string;child_request_ids:string[];source:unknown;created_at:Date}
export type BusinessRecordRecentBatch={requestId:string;scope:string;source:BusinessRecordBatchSource;createdAt:string;operations:Array<{requestId:string;operation:Operation;reference:BusinessObjectReference}>}
type ReceiptRow={request_hash:string;operation:string;scope_id:string;result_reference:unknown;previous_reference:unknown}
const invalid=()=>new WorkError('teloa/invalid-input','本地业务记录参数或字段值不合法。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','本地业务记录、固定快照或回执不一致，已停止读取。')
const conflict=()=>new WorkError('teloa/conflict','请求标识已用于不同的记录操作。')
function referenceIds(field:Prepared['definition']['fields'][number],value:string|undefined):string[]{
 if(field.type==='reference')return value===undefined||value===''?[]:[value]
 if(field.type==='multi-reference'){
  const parsed=readBusinessRichFieldValue(field,value)
  return parsed?.type==='multi-reference'?parsed.ids:[]
 }
 return []
}
function authorize(actor:Actor,scope?:string){
 if(!actor||typeof actor.ownerId!=='string'||!actor.ownerId.trim()||actor.ownerId!==actor.ownerId.trim()||actor.ownerId.length>128||/[\x00-\x1f\x7f]/.test(actor.ownerId)||!Array.isArray(actor.scopeIds)||new Set(actor.scopeIds).size!==actor.scopeIds.length||actor.scopeIds.some(s=>!isBusinessScopeKey(s))||(scope!==undefined&&!actor.scopeIds.includes(scope)))throw new WorkError('teloa/forbidden','当前主体无权访问此业务范围。')
}
function reference(item:BusinessObjectSnapshot):BusinessObjectReference{return {scope:item.scope,type:item.type,id:item.id,version:item.version,snapshotHash:item.snapshotHash}}
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
function childRequest(requestId:string,index:number):string{
 const bytes=createHash('sha256').update(JSON.stringify(['teloa.business-record-batch-child/v1',requestId,index])).digest().subarray(0,16)
 bytes[6]=(bytes[6]!&15)|128;bytes[8]=(bytes[8]!&63)|128
 const hex=bytes.toString('hex');return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
function sourceIdentity(value:unknown):BusinessRecordBatchSource|undefined{
 if(value===undefined)return undefined
 if(value===null||typeof value!=='object'||Array.isArray(value))throw invalid()
 const row=value as Record<string,unknown>
 const identity=(v:unknown):v is string=>typeof v==='string'&&v.length>0&&v.length<=200&&v===v.trim()&&!/[\x00-\x1f\x7f]/.test(v)
 if(Object.keys(row).length!==3||!identity(row.sessionId)||!identity(row.messageId)||!Number.isSafeInteger(row.seq)||Number(row.seq)<1)throw invalid()
 return {sessionId:row.sessionId,messageId:row.messageId,seq:Number(row.seq)}
}
export async function initializeBusinessRecords(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_record_heads(
 owner_id text not null,scope_id text not null,object_type text not null,object_id text not null,current_version integer not null check(current_version>0),
 source_id text not null,created_at timestamptz not null,
 primary key(owner_id,scope_id,object_type,object_id),
 foreign key(owner_id,scope_id,object_type,object_id,current_version) references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version))`)
 await pool.query(`create table if not exists teloa_business_record_receipts(
 owner_id text not null,request_id uuid not null,request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),
 operation text not null check(operation in ('create','edit','archive')),scope_id text not null,
 result_reference jsonb not null,previous_reference jsonb,created_at timestamptz not null,
 primary key(owner_id,request_id))`)
 await pool.query(`create table if not exists teloa_business_record_batches(
 owner_id text not null,request_id uuid not null,request_hash text not null check(request_hash~'^[a-f0-9]{64}$'),scope_id text not null,
 child_request_ids uuid[] not null check(cardinality(child_request_ids) between 1 and 50),source jsonb,created_at timestamptz not null,
 primary key(owner_id,request_id))`)
 await pool.query("create index if not exists teloa_business_record_batches_recent on teloa_business_record_batches(owner_id,scope_id,(source->>'sessionId'),created_at desc,request_id desc) where source is not null")
}
/** 本人手动记录统一入口；快照是唯一字段真源，元数据及回执只保留身份与固定版本。 */
export class BusinessRecordService{
 private readonly pool:Pool
 private readonly identity:{now:()=>string}
 private readonly dependencies:Dependencies
 constructor(pool:Pool,identity:{now:()=>string},dependencies:Dependencies){this.pool=pool;this.identity=identity;this.dependencies=dependencies}
 private async transaction<T>(write:boolean,run:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.pool.connect()
  try{await db.query(write?'begin':'begin isolation level repeatable read read only');const result=await run(db);await db.query('commit');return result}
  catch(error){await db.query('rollback');throw error}finally{db.release()}
 }
 private async definition(db:PoolClient,actor:Actor,target:BusinessRecordTarget){
  const reader=this.dependencies.definitions
  const bundles=reader.forScopeVersioned?await reader.forScopeVersioned(db,actor.ownerId,target.scope):await reader.forScope(db,actor.ownerId,target.scope)
  const matches=bundles.flatMap(bundle=>bundle.objectTypes.filter(row=>row.definition.id===target.type).map(row=>({bundle,definition:row.definition})))
  if(matches.length!==1||matches[0]!.bundle.origin.kind!=='local-configuration'||!matches[0]!.bundle.sources.has(matches[0]!.definition.sourceId))throw invalid()
  return matches[0]!.definition
 }
 private async head(db:PoolClient,actor:Actor,target:BusinessRecordTarget&{id:string},sourceId:string,lock=false):Promise<Head>{
  const row=(await db.query('select source_id,current_version,created_at from teloa_business_record_heads where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4'+(lock?' for update':''),[actor.ownerId,target.scope,target.type,target.id])).rows[0] as Head|undefined
  if(!row){
   if((await db.query('select 1 from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[actor.ownerId,target.scope,target.type,target.id])).rowCount)throw corrupt()
   throw invalid()
  }
  const latest=(await db.query('select max(object_version) v from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4',[actor.ownerId,target.scope,target.type,target.id])).rows[0]?.v
  if(!Number.isSafeInteger(row.current_version)||row.current_version<1||row.current_version!==latest||row.source_id!==sourceId||!(row.created_at instanceof Date))throw corrupt()
  return row
 }
 private async snapshot(db:PoolClient,actor:Actor,target:BusinessRecordTarget&{id:string;version:number},sourceId:string,requestedHistory=false):Promise<BusinessObjectSnapshot>{
  const row=(await db.query('select object_version,source_id,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5',[actor.ownerId,target.scope,target.type,target.id,target.version])).rows[0] as SnapshotRow|undefined
  if(!row)throw requestedHistory?new WorkError('teloa/not-found','指定的历史记录版本不存在或已按保留规则清理。'):corrupt()
  let stored:ReturnType<typeof readBusinessObjectSnapshot>
  try{stored=readBusinessObjectSnapshot(row.snapshot,target.scope)}catch{throw corrupt()}
  if(row.source_id!==sourceId||stored.source!=='本地记录'||stored.type!==target.type||stored.id!==target.id||stored.version!==target.version||row.object_version!==target.version||businessObjectSnapshotHash(stored)!==row.snapshot_hash)throw corrupt()
  return {...stored,snapshotHash:row.snapshot_hash}
 }
 /** 同步来源拥有独立的固定身份；只读快照，绝不借本地 head 获得写权限。 */
 private async sourcedSnapshot(db:PoolClient,actor:Actor,target:BusinessRecordTarget&{id:string},localSourceId:string,version?:number):Promise<BusinessObjectSnapshot>{
  const identity=(await db.query('select source_id from teloa_business_sync_object_ids where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[actor.ownerId,target.scope,target.type,target.id])).rows[0] as {source_id:string|null}|undefined
  if(!identity)throw invalid()
  const current=(await db.query('select object_version,source_id,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version desc limit 1',[actor.ownerId,target.scope,target.type,target.id])).rows[0] as SnapshotRow|undefined
  if(!current||!identity.source_id||current.source_id===localSourceId||identity.source_id!==current.source_id)throw corrupt()
  const foreign=await db.query("select 1 from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and (source_id<>$5 or snapshot->>'source'='本地记录') limit 1",[actor.ownerId,target.scope,target.type,target.id,current.source_id])
  if(foreign.rowCount)throw corrupt()
  const decode=(row:SnapshotRow):BusinessObjectSnapshot=>{
   let stored:ReturnType<typeof readBusinessObjectSnapshot>
   try{stored=readBusinessObjectSnapshot(row.snapshot,target.scope)}catch{throw corrupt()}
   if(stored.type!==target.type||stored.id!==target.id||stored.version!==row.object_version||businessObjectSnapshotHash(stored)!==row.snapshot_hash)throw corrupt()
   return {...stored,snapshotHash:row.snapshot_hash}
  }
  const verifiedCurrent=decode(current)
  const row=version===undefined||version===current.object_version?current:(await db.query('select object_version,source_id,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5',[actor.ownerId,target.scope,target.type,target.id,version])).rows[0] as SnapshotRow|undefined
  if(!row)throw new WorkError('teloa/not-found','指定的历史记录版本不存在或已按保留规则清理。')
  return row===current?verifiedCurrent:decode(row)
 }
 private async receiptRow(db:PoolClient,owner:string,requestId:string):Promise<ReceiptRow|undefined>{
  return (await db.query('select request_hash,operation,scope_id,result_reference,previous_reference from teloa_business_record_receipts where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
 }
 private async replay(db:PoolClient,actor:Actor,row:ReceiptRow,lock=false):Promise<BusinessObjectSnapshot>{
  authorize(actor,row.scope_id)
  let result:BusinessObjectReference,previous:BusinessObjectReference|undefined
  try{result=businessObjectReference(row.result_reference);previous=row.previous_reference===null?undefined:businessObjectReference(row.previous_reference)}catch{throw corrupt()}
  if(!/^[a-f0-9]{64}$/.test(row.request_hash)||result.scope!==row.scope_id||!['create','edit','archive'].includes(row.operation)||(row.operation==='create'?(previous!==undefined||result.version!==1):(!previous||previous.scope!==result.scope||previous.type!==result.type||previous.id!==result.id||previous.version+1!==result.version)))throw corrupt()
  if(lock)await lockBusinessConfiguration(db,actor.ownerId,result.scope,'shared')
  const definition=await this.definition(db,actor,result)
  // 只核对 head 自洽；原回执的版本无需等于当前 head。
  const head=await this.head(db,actor,result,definition.sourceId,lock)
  await this.snapshot(db,actor,{...result,version:head.current_version},definition.sourceId)
  const stored=await this.snapshot(db,actor,result,definition.sourceId)
  if(stored.snapshotHash!==result.snapshotHash||(row.operation==='archive')!==(stored.deletedAt!==undefined))throw corrupt()
  if(previous){const before=await this.snapshot(db,actor,previous,definition.sourceId);if(before.snapshotHash!==previous.snapshotHash||before.deletedAt!==undefined)throw corrupt()}
  return stored
 }
 async receipt(actor:Actor,input:unknown):Promise<BusinessObjectSnapshot|undefined>{
  authorize(actor);const {requestId}=readBusinessRecordReceipt(input)
  return this.transaction(false,async db=>{const row=await this.receiptRow(db,actor.ownerId,requestId);return row?this.replay(db,actor,row):undefined})
 }
 async get(actor:Actor,input:unknown):Promise<BusinessObjectSnapshot>{
  const target=readBusinessRecordGet(input);authorize(actor,target.scope)
  return this.transaction(false,async db=>{
   const definition=await this.definition(db,actor,target)
   const local=(await db.query('select 1 from teloa_business_record_heads where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[actor.ownerId,target.scope,target.type,target.id])).rowCount
   if(!local){
    const sourced=(await db.query('select 1 from teloa_business_sync_object_ids where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[actor.ownerId,target.scope,target.type,target.id])).rowCount
    if(sourced)return this.sourcedSnapshot(db,actor,target,definition.sourceId,target.version)
    const orphan=(await db.query('select 1 from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[actor.ownerId,target.scope,target.type,target.id])).rowCount
    if(orphan)throw corrupt()
    throw invalid()
   }
   const head=await this.head(db,actor,target,definition.sourceId)
   const current=await this.snapshot(db,actor,{...target,version:head.current_version},definition.sourceId)
   return target.version===undefined||target.version===head.current_version?current:this.snapshot(db,actor,{...target,version:target.version},definition.sourceId,true)
  })
 }
 async list(actor:Actor,input:unknown):Promise<BusinessDataPage>{
  const target=readBusinessRecordList(input);authorize(actor,target.scope)
  let after=''
  if(target.cursor!==undefined){
   try{
    const cursor=JSON.parse(Buffer.from(target.cursor,'base64url').toString('utf8')) as unknown
    if(!Array.isArray(cursor)||cursor.length!==5||cursor[0]!=='teloa.local-records/v1'||cursor[1]!==actor.ownerId||cursor[2]!==target.scope||cursor[3]!==target.type||typeof cursor[4]!=='string'||cursor[4].length>200)throw invalid()
    after=cursor[4]
   }catch{throw invalid()}
  }
  return this.transaction(false,async db=>{
   const definition=await this.definition(db,actor,target),items:BusinessObjectSnapshot[]=[]
   const orphan=await db.query("select 1 from teloa_business_object_snapshots s where s.owner_id=$1 and s.scope_id=$2 and s.object_type=$3 and (s.source_id=$4 or s.snapshot->>'source'='本地记录') and not exists(select 1 from teloa_business_record_heads h where h.owner_id=s.owner_id and h.scope_id=s.scope_id and h.object_type=s.object_type and h.object_id=s.object_id) limit 1",[actor.ownerId,target.scope,target.type,definition.sourceId])
   if(orphan.rowCount)throw corrupt()
   // 同一 ID 游标扫描本地 head 与已固定身份的同步来源；先验最高版本再过滤 tombstone。
   let position=after,more=false
   for(;;){
    const rows=(await db.query(`select object_id from (
      select object_id from teloa_business_record_heads where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id>$4
      union
      select object_id from teloa_business_sync_object_ids where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id>$4
     ) known order by object_id limit 100`,[actor.ownerId,target.scope,target.type,position])).rows as Array<{object_id:string}>
    for(const row of rows){
     const key={...target,id:row.object_id}
     const local=(await db.query('select 1 from teloa_business_record_heads where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1',[actor.ownerId,target.scope,target.type,row.object_id])).rowCount
     const item=local?await (async()=>{const head=await this.head(db,actor,key,definition.sourceId);return this.snapshot(db,actor,{...key,version:head.current_version},definition.sourceId)})():await this.sourcedSnapshot(db,actor,key,definition.sourceId)
     if(!item.deletedAt){
      if(items.length===target.limit){more=true;break}
      items.push(item)
     }
     position=row.object_id
    }
    if(more||rows.length<100)break
   }
   return {schema:'teloa.business-data-page/v1',sourceId:definition.sourceId,capturedAt:this.identity.now(),items,...(more?{nextCursor:Buffer.from(JSON.stringify(['teloa.local-records/v1',actor.ownerId,target.scope,target.type,position])).toString('base64url')}:{})}
  })
 }
 async create(actor:Actor,input:unknown):Promise<BusinessObjectSnapshot>{return this.write(actor,'create',readBusinessRecordCreate(input))}
 async edit(actor:Actor,input:unknown):Promise<BusinessObjectSnapshot>{return this.write(actor,'edit',readBusinessRecordEdit(input))}
 async archive(actor:Actor,input:unknown):Promise<BusinessObjectSnapshot>{return this.write(actor,'archive',readBusinessRecordArchive(input))}
 private async lockRequests(db:PoolClient,actor:Actor,ids:string[]){
  // 父请求和所有子请求一并排序；页面若恰好使用子ID也遵循同一锁域。
  for(const id of [...new Set(ids)].sort())await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-record-request',actor.ownerId,id])])
 }
 private async lockHeads(db:PoolClient,actor:Actor,targets:Array<BusinessRecordTarget&{id:string}>){
  const sorted=[...new Map(targets.map(target=>[JSON.stringify([target.type,target.id]),target])).values()].sort((a,b)=>a.type<b.type?-1:a.type>b.type?1:a.id<b.id?-1:a.id>b.id?1:0)
  for(const target of sorted){const definition=await this.definition(db,actor,target);await this.head(db,actor,target,definition.sourceId,true)}
 }
 private async writeTargets(db:PoolClient,actor:Actor,writes:Array<{operation:Operation;input:WriteInput}>){
  const targets:Array<BusinessRecordTarget&{id:string}>=[]
  // 先收集全部源与目标，再一次排序锁定；自引用和重复目标共用同一head。
  for(const {operation,input} of writes){
   if('id' in input)targets.push(input)
   if(operation==='archive'||!('fields' in input))continue
   const definition=await this.definition(db,actor,input)
   for(const field of definition.fields){
    if(field.type!=='reference'&&field.type!=='multi-reference')continue
    const target={scope:input.scope,type:field.referenceType!}
    await this.definition(db,actor,target)
    const value=input.fields.find(row=>row.name===field.name)?.value
    for(const id of referenceIds(field,value))targets.push(readBusinessRecordGet({...target,id}))
   }
  }
  return targets
 }
 private async prepare(db:PoolClient,actor:Actor,operation:Operation,input:WriteInput,archivingTargets:ReadonlySet<string>=new Set()):Promise<Prepared>{
   const definition=await this.definition(db,actor,input)
   let before:BusinessObjectSnapshot|undefined
   if('id' in input){
    const head=await this.head(db,actor,input,definition.sourceId)
    before=await this.snapshot(db,actor,{...input,version:head.current_version},definition.sourceId)
    if(before.version!==input.expectedVersion)throw new WorkError('teloa/version-conflict','记录已被修改，请重新读取后再提交。')
    if(before.deletedAt||before.version>=2147483647)throw new WorkError('teloa/conflict','记录已归档或版本数已达上限。')
   }
   const now=this.identity.now()
   let snapshot:ReturnType<typeof readBusinessObjectSnapshot>|undefined
   if(operation!=='archive'){
    if(!('fields' in input))throw invalid()
    const supplied=new Map(input.fields.map(field=>[field.name,field.value]))
    if(input.fields.some(field=>!definition.fields.some(defined=>defined.name===field.name)))throw invalid()
    const fields:Array<{label:string;value:string}>=[]
    for(const field of definition.fields){
     const value=supplied.get(field.name);assertBusinessRecordFieldValue(field,value)
     for(const id of referenceIds(field,value)){
      const target=readBusinessRecordGet({scope:input.scope,type:'referenceType' in field?field.referenceType:undefined,id})
      if(archivingTargets.has(JSON.stringify([target.type,target.id])))throw invalid()
      const targetDefinition=await this.definition(db,actor,target),head=await this.head(db,actor,target,targetDefinition.sourceId)
      const current=await this.snapshot(db,actor,{...target,version:head.current_version},targetDefinition.sourceId)
      if(current.deletedAt)throw invalid()
     }
     if(value!==undefined&&value!=='')fields.push({label:field.from,value})
    }

    try{snapshot=readBusinessObjectSnapshot({scope:input.scope,type:input.type,id:before?.id??randomUUID(),version:(before?.version??0)+1,title:input.title??before?.title,source:'本地记录',observedAt:before?.observedAt??now,receivedAt:now,quality:'complete',summary:input.summary??before?.summary,fields},input.scope)}catch{throw invalid()}
   }
   return {operation,input,requestHash:hash({operation,...input}),definition,before,snapshot,now}
 }
 private async assertUniqueWrites(db:PoolClient,actor:Actor,prepared:Prepared[]):Promise<void>{
  const definitions=new Map(prepared.map(row=>[row.definition.id,row.definition]))
  for(const definition of definitions.values()){
   if(!hasBusinessRecordUniqueConstraints(definition))continue
   const records=new Map((await readBusinessRecordConstraintState(db,actor.ownerId,prepared[0]!.input.scope,definition)).map(row=>[row.id,row]))
   // 先覆盖全部后态，归档直接释放；交换不受批次排列影响。
   for(const row of prepared){
    if(row.definition.id!==definition.id)continue
    if(row.operation==='archive'){if(!row.before)throw corrupt();records.delete(row.before.id)}
    else if(row.snapshot)records.set(row.snapshot.id,{...row.snapshot,snapshotHash:businessObjectSnapshotHash(row.snapshot)})
    else throw corrupt()
   }
   assertBusinessRecordUniqueState(definition,[...records.values()])
  }
 }
 /** 已取得全部head锁并一次性通过配额后写入；单条和批次唯一的快照/引用/回执原语。 */
 private async persist(db:PoolClient,actor:Actor,prepared:Prepared):Promise<BusinessObjectSnapshot>{
   const {operation,input,requestHash,definition,before,snapshot,now}=prepared
   let item:BusinessObjectSnapshot
   if(operation==='archive'){
    if(!before)throw invalid()
    if(!await this.dependencies.warehouse.tombstone(db,actor.ownerId,input.scope,input.type,before.id,definition.sourceId))throw corrupt()
    item=await this.snapshot(db,actor,{...input,id:before.id,version:before.version+1},definition.sourceId)
   }else{
    const snapshotHash=businessObjectSnapshotHash(snapshot!)
    await db.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[actor.ownerId,input.scope,input.type,snapshot!.id,snapshot!.version,snapshotHash,JSON.stringify(snapshot),definition.sourceId,now])
    item={...snapshot!,snapshotHash}
   }
   if(before)await db.query('update teloa_business_record_heads set current_version=$5 where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4',[actor.ownerId,input.scope,input.type,item.id,item.version])
   else await db.query('insert into teloa_business_record_heads(owner_id,scope_id,object_type,object_id,current_version,source_id,created_at) values($1,$2,$3,$4,$5,$6,$7)',[actor.ownerId,input.scope,input.type,item.id,item.version,definition.sourceId,now])
   for(const snapshot of before?[before,item]:[item])await this.dependencies.references.pinInTransaction(db,actor,{reference:reference(snapshot),kind:'record-operation',referenceId:input.requestId})
   await db.query('insert into teloa_business_record_receipts(owner_id,request_id,request_hash,operation,scope_id,result_reference,previous_reference,created_at) values($1,$2,$3,$4,$5,$6,$7,$8)',[actor.ownerId,input.requestId,requestHash,operation,input.scope,JSON.stringify(reference(item)),before?JSON.stringify(reference(before)):null,now])
   return item
 }
 private async write(actor:Actor,operation:Operation,input:WriteInput):Promise<BusinessObjectSnapshot>{
  authorize(actor,input.scope)
  return this.transaction(true,async db=>{
   await this.lockRequests(db,actor,[input.requestId])
   if(await this.batchRow(db,actor.ownerId,input.requestId))throw conflict()
   const receipt=await this.receiptRow(db,actor.ownerId,input.requestId)
   if(receipt){if(receipt.request_hash!==hash({operation,...input}))throw conflict();return this.replay(db,actor,receipt,true)}
   await lockBusinessConfiguration(db,actor.ownerId,input.scope,'shared')
   await lockBusinessRecordTypes(db,actor.ownerId,input.scope,[input.type])
   await this.lockHeads(db,actor,await this.writeTargets(db,actor,[{operation,input}]))
   const prepared=await this.prepare(db,actor,operation,input)
   await this.assertUniqueWrites(db,actor,[prepared])
   await this.dependencies.warehouse.assertQuota(db,actor.ownerId,input.scope,1)
   return this.persist(db,actor,prepared)
  })
 }
 private async batchRow(db:PoolClient,owner:string,requestId:string):Promise<BatchRow|undefined>{
  return (await db.query('select request_id,request_hash,scope_id,child_request_ids,source,created_at from teloa_business_record_batches where owner_id=$1 and request_id=$2',[owner,requestId])).rows[0]
 }
 private async replayBatch(db:PoolClient,actor:Actor,row:BatchRow,lock=false):Promise<{result:BusinessRecordBatchResult;operations:BusinessRecordRecentBatch['operations'];source:BusinessRecordBatchSource|undefined}>{
  authorize(actor,row.scope_id)
  let source:BusinessRecordBatchSource|undefined
  try{source=sourceIdentity(row.source===null?undefined:row.source);readBusinessRecordReceipt({requestId:row.request_id})}catch{throw corrupt()}
  if(!/^[a-f0-9]{64}$/.test(row.request_hash)||!isBusinessScopeKey(row.scope_id)||row.scope_id==='general'||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||!Array.isArray(row.child_request_ids)||row.child_request_ids.length<1||row.child_request_ids.length>50||row.child_request_ids.some((id,index)=>id!==childRequest(row.request_id,index)))throw corrupt()
  const receipts:ReceiptRow[]=[],operations:BusinessRecordRecentBatch['operations']=[]
  for(const requestId of row.child_request_ids){
   const receipt=await this.receiptRow(db,actor.ownerId,requestId);if(!receipt||receipt.scope_id!==row.scope_id)throw corrupt()
   let target:BusinessObjectReference;try{target=businessObjectReference(receipt.result_reference)}catch{throw corrupt()}
   if(target.scope!==row.scope_id)throw corrupt()
   receipts.push(receipt);operations.push({requestId,operation:receipt.operation as Operation,reference:target})
  }
  if(new Set(operations.map(row=>JSON.stringify([row.reference.type,row.reference.id]))).size!==operations.length)throw corrupt()
  if(lock){await lockBusinessConfiguration(db,actor.ownerId,row.scope_id,'shared');await this.lockHeads(db,actor,operations.map(row=>row.reference))}
  const items:BusinessObjectSnapshot[]=[]
  for(const receipt of receipts)items.push(await this.replay(db,actor,receipt))
  return {result:{requestId:row.request_id,scope:row.scope_id,items},operations,source}
 }
 async batch(actor:Actor,value:unknown,sourceValue?:BusinessRecordBatchSource):Promise<BusinessRecordBatchResult>{
  return this.transaction(true,db=>this.batchInTransaction(db,actor,value,sourceValue))
 }
 /** 调用方拥有事务；仍沿记录请求→配置→类型→head顺序取得原有锁。 */
 async batchInTransaction(db:PoolClient,actor:Actor,value:unknown,sourceValue?:BusinessRecordBatchSource,expected?:BusinessRecordBatchDefinitionGuard):Promise<BusinessRecordBatchResult>{
  const input=readBusinessRecordBatch(value),source=sourceIdentity(sourceValue);authorize(actor,input.scope)
  if(expected!==undefined){
   if(expected===null||typeof expected!=='object'||Array.isArray(expected)||Object.keys(expected).length<3||Object.keys(expected).length>4||Object.keys(expected).some(key=>!['scope','type','schemaFingerprint','receiptPolicy'].includes(key))||'receiptPolicy' in expected&&expected.receiptPolicy!=='new-only'||expected.scope!==input.scope||typeof expected.type!=='string'||!input.operations.every(row=>row.type===expected.type)||typeof expected.schemaFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(expected.schemaFingerprint))throw invalid()
  }
  const requestHash=hash({input,source:source??null}),children=input.operations.map((_,index)=>childRequest(input.requestId,index))
  await this.lockRequests(db,actor,[input.requestId,...children])
  const prior=await this.batchRow(db,actor.ownerId,input.requestId)
  // 导入会在同一事务提交自己的来源与回执；没有导入回执的既有普通批次不能被收养。
  if(prior&&expected?.receiptPolicy==='new-only')throw conflict()
  if(prior){if(prior.request_hash!==requestHash||JSON.stringify(sourceIdentity(prior.source===null?undefined:prior.source))!==JSON.stringify(source))throw conflict();if(JSON.stringify(prior.child_request_ids)!==JSON.stringify(children))throw corrupt();return (await this.replayBatch(db,actor,prior,true)).result}
  for(const requestId of [input.requestId,...children])if(await this.receiptRow(db,actor.ownerId,requestId)||requestId!==input.requestId&&await this.batchRow(db,actor.ownerId,requestId))throw conflict()
  await lockBusinessConfiguration(db,actor.ownerId,input.scope,'shared')
  if(expected&&businessRecordSchemaFingerprint(await this.definition(db,actor,expected))!==expected.schemaFingerprint)throw new WorkError('teloa/version-conflict','业务对象定义已改变，请重新预览后再提交。')
  const writes=input.operations.map(({operation,...body},index)=>({operation,input:{...body,scope:input.scope,requestId:children[index]!} as WriteInput}))
  await lockBusinessRecordTypes(db,actor.ownerId,input.scope,writes.map(row=>row.input.type))
  await this.lockHeads(db,actor,await this.writeTargets(db,actor,writes))
  const archivingTargets=new Set(writes.flatMap(row=>row.operation==='archive'&&'id' in row.input?[JSON.stringify([row.input.type,row.input.id])]:[]))
  const prepared:Prepared[]=[]
  for(const row of writes)prepared.push(await this.prepare(db,actor,row.operation,row.input,archivingTargets))
  await this.assertUniqueWrites(db,actor,prepared)
  await this.dependencies.warehouse.assertQuota(db,actor.ownerId,input.scope,prepared.length)
  const items:BusinessObjectSnapshot[]=[]
  for(const row of prepared)items.push(await this.persist(db,actor,row))
  await db.query('insert into teloa_business_record_batches(owner_id,request_id,request_hash,scope_id,child_request_ids,source,created_at) values($1,$2,$3,$4,$5,$6,$7)',[actor.ownerId,input.requestId,requestHash,input.scope,children,source?JSON.stringify(source):null,this.identity.now()])
  return {requestId:input.requestId,scope:input.scope,items}
 }
 async batchReceipt(actor:Actor,input:unknown):Promise<BusinessRecordBatchResult|undefined>{
  authorize(actor);const {requestId}=readBusinessRecordReceipt(input)
  return this.transaction(false,async db=>{const row=await this.batchRow(db,actor.ownerId,requestId);return row?(await this.replayBatch(db,actor,row)).result:undefined})
 }
 /** 宿主内部按已授权当前会话发现已提交批次；空结果不证明没有在途或失败请求。 */
 async recentBatches(actor:Actor,input:{scope:string;sessionId:string;limit?:number;cursor?:string}):Promise<{items:BusinessRecordRecentBatch[];nextCursor?:string}>{
  if(!input||Object.keys(input).some(key=>!['scope','sessionId','limit','cursor'].includes(key))||!isBusinessScopeKey(input.scope)||input.scope==='general')throw invalid()
  sourceIdentity({sessionId:input.sessionId,messageId:'validation',seq:1});authorize(actor,input.scope)
  const limit=input.limit??20
  if(!Number.isSafeInteger(limit)||limit<1||limit>20)throw invalid()
  let after:{time:string;requestId:string}|undefined
  if(input.cursor!==undefined){
   try{
    if(typeof input.cursor!=='string'||input.cursor.length>2048)throw invalid()
    const cursor:unknown=JSON.parse(Buffer.from(input.cursor,'base64url').toString('utf8'))
    if(!Array.isArray(cursor)||cursor.length!==6||cursor[0]!=='teloa.record-batches/v1'||cursor[1]!==actor.ownerId||cursor[2]!==input.scope||cursor[3]!==input.sessionId||typeof cursor[4]!=='string'||new Date(cursor[4]).toISOString()!==cursor[4])throw invalid()
    after={time:cursor[4],requestId:readBusinessRecordReceipt({requestId:cursor[5]}).requestId}
   }catch{throw invalid()}
  }
  return this.transaction(false,async db=>{
   const rows=(await db.query(`select request_id,request_hash,scope_id,child_request_ids,source,created_at from teloa_business_record_batches
    where owner_id=$1 and scope_id=$2 and source is not null and source->>'sessionId'=$3 ${after?'and (created_at,request_id)<($5::timestamptz,$6::uuid)':''}
    order by created_at desc,request_id desc limit $4`,[actor.ownerId,input.scope,input.sessionId,limit+1,...(after?[after.time,after.requestId]:[])])).rows as BatchRow[]
   const items:BusinessRecordRecentBatch[]=[]
   for(const row of rows.slice(0,limit)){
    const replayed=await this.replayBatch(db,actor,row)
    if(!replayed.source||replayed.source.sessionId!==input.sessionId)throw corrupt()
    items.push({requestId:row.request_id,scope:row.scope_id,source:replayed.source,createdAt:row.created_at.toISOString(),operations:replayed.operations})
   }
   const last=items.at(-1)
   return {items,...(rows.length>limit&&last?{nextCursor:Buffer.from(JSON.stringify(['teloa.record-batches/v1',actor.ownerId,input.scope,input.sessionId,last.createdAt,last.requestId])).toString('base64url')}:{})}
  })
 }
}
