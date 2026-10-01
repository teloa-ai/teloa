import type {PoolClient} from 'pg'
import {WorkError,readBusinessObjectTypeDefinitionVersioned,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2,type BusinessObjectSnapshot,type BusinessConfigurationCandidate,type BusinessConfigurationCandidateV2} from '@teloa/contract'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import {assertBusinessRecordUniqueState} from './business-record-values.ts'

type Definition=BusinessObjectTypeDefinition|BusinessObjectTypeDefinitionV2
const corrupt=()=>new WorkError('teloa/storage-corrupt','本地业务记录的当前版本、来源或固定快照损坏，已停止检查。')
export const hasBusinessRecordUniqueConstraints=(definition:Definition):boolean=>'constraints' in definition&&definition.constraints!==undefined
/** 配置共享锁之后、任何 head 锁之前；归档与无约束写也进入相同锁域。 */
export async function lockBusinessRecordTypes(db:PoolClient,ownerId:string,scope:string,types:readonly string[]):Promise<void>{
 for(const type of [...new Set(types)].sort())await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify(['teloa.business-record-type',ownerId,scope,type])])
}
/** 分页核所有本地 head 和最高快照，不按字段另存事实，也不截断唯一占用检查。 */
export async function readBusinessRecordConstraintState(db:PoolClient,ownerId:string,scope:string,definition:Definition,signal?:AbortSignal):Promise<BusinessObjectSnapshot[]>{
 const orphan=await db.query('select 1 from teloa_business_object_snapshots s where s.owner_id=$1 and s.scope_id=$2 and s.object_type=$3 and not exists(select 1 from teloa_business_record_heads h where h.owner_id=s.owner_id and h.scope_id=s.scope_id and h.object_type=s.object_type and h.object_id=s.object_id) limit 1',[ownerId,scope,definition.id])
 if(orphan.rowCount)throw corrupt()
 let after='';const records:BusinessObjectSnapshot[]=[]
 for(;;){
  signal?.throwIfAborted()
  const rows=(await db.query(`select h.object_id,h.current_version,h.source_id,h.created_at,s.object_version,s.source_id snapshot_source_id,s.snapshot_hash,s.snapshot,
   (select max(x.object_version) from teloa_business_object_snapshots x where x.owner_id=h.owner_id and x.scope_id=h.scope_id and x.object_type=h.object_type and x.object_id=h.object_id) latest_version
   from teloa_business_record_heads h left join teloa_business_object_snapshots s on s.owner_id=h.owner_id and s.scope_id=h.scope_id and s.object_type=h.object_type and s.object_id=h.object_id and s.object_version=h.current_version
   where h.owner_id=$1 and h.scope_id=$2 and h.object_type=$3 and h.object_id>$4 order by h.object_id limit 200`,[ownerId,scope,definition.id,after])).rows
  for(const row of rows){
   let snapshot:ReturnType<typeof readBusinessObjectSnapshot>
   try{snapshot=readBusinessObjectSnapshot(row.snapshot,scope)}catch{throw corrupt()}
   if(!Number.isSafeInteger(row.current_version)||row.current_version<1||row.current_version!==row.latest_version||row.current_version!==row.object_version||!(row.created_at instanceof Date)||!Number.isFinite(row.created_at.getTime())||row.source_id!==definition.sourceId||row.snapshot_source_id!==definition.sourceId||snapshot.type!==definition.id||snapshot.id!==row.object_id||snapshot.version!==row.current_version||snapshot.source!=='本地记录'||businessObjectSnapshotHash(snapshot)!==row.snapshot_hash)throw corrupt()
   records.push({...snapshot,snapshotHash:row.snapshot_hash})
  }
  if(rows.length<200)break
  after=rows.at(-1)!.object_id
 }
 return records
}
/** 预览只读；采用由配置独占锁隔离所有本地写后重查，重复绝不产生可采用回执。 */
export async function assertBusinessConfigurationUniqueRecords(db:PoolClient,ownerId:string,candidate:BusinessConfigurationCandidate|BusinessConfigurationCandidateV2,signal?:AbortSignal):Promise<void>{
 for(const item of candidate.definitions){
  if(item.kind!=='object-type')continue
  const definition=readBusinessObjectTypeDefinitionVersioned(item.definition)
  if(!hasBusinessRecordUniqueConstraints(definition))continue
  signal?.throwIfAborted()
  const records=await readBusinessRecordConstraintState(db,ownerId,candidate.scope,definition,signal)
  try{assertBusinessRecordUniqueState(definition,records)}catch(error){
   if(error instanceof WorkError&&error.code==='teloa/storage-corrupt')throw new WorkError('teloa/conflict','配置的唯一字段与现存记录不兼容，需要先处理数据。')
   throw error
  }
 }
}
