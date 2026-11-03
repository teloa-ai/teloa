import {createHash} from 'node:crypto'
import {isDeepStrictEqual} from 'node:util'
import type {Pool,PoolClient} from 'pg'
import {WorkError,businessObjectTypeV2LegacyShape,type BusinessSourceMappingDefinition,type BusinessObjectTypeDefinition,type BusinessObjectTypeDefinitionV2} from '@teloa/contract'
import {BusinessConfigurationStore,type BusinessConfigurationCurrent} from './business-configuration-store.ts'
import {readBusinessObjectSnapshot,businessObjectSnapshotHash} from './business-data.ts'
import {objectCursorBasis,trustedObjectTimestamp,sameObjectContent} from './business-sync-object-cursor.ts'
import type {BusinessWarehouseService} from './business-warehouse.ts'
import {BusinessSnapshotReferenceService} from './business-snapshot-references.ts'

const conflict=()=>new WorkError('teloa/source-conflict','同源映射迁移的对象或工作归属无法核实；原记录和工作均已保留，请先核对来源迁移。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','来源迁移审计或固定对象快照不一致，已停止同步。')

/** 映射 ID 隔离并行来源；迁移另凭本人已采用的配置历史，不能删除这个身份维度。 */
export function businessSyncSourceIdentity(mapping:BusinessSourceMappingDefinition,sourceId:string):string{
 const source=mapping.source,argumentsKey=source.kind==='mcp-tool'?Object.entries(source.arguments).sort(([a],[b])=>a<b?-1:a>b?1:0):[]
 return createHash('sha256').update(JSON.stringify(['teloa.business-sync-source/v1',mapping.id,source.kind,sourceId,argumentsKey,source.kind==='role-result'?source.roleId??null:null])).digest('hex')
}

export async function initializeBusinessMappingMigrations(pool:Pool):Promise<void>{await pool.query(`create table if not exists teloa_business_sync_mapping_migrations(
 owner_id text not null,scope_id text not null,object_type text not null,target_source_key text not null,external_key text not null,
 canonical_object_id text not null,configuration_version integer not null,configuration_hash text not null,
 proof jsonb not null,previous_tracking jsonb not null,duplicate_tracking jsonb,created_at timestamptz not null,
 primary key(owner_id,scope_id,object_type,target_source_key,external_key,configuration_version))`)}

type Replacement={mapping:BusinessSourceMappingDefinition;configurationVersion:number;configurationHash:string}
export type MappingReplacementProof={previous:Replacement[];configurationVersion:number;configurationHash:string}
/** 增量页不会重放已成功的对象；已存前/后 namespace 的同键交集也必须进入同批迁移规划。 */
export async function storedMappingMigrationKeys(db:PoolClient,owner:string,scope:string,type:string,sourceId:string,sourceKey:string,proof:MappingReplacementProof):Promise<string[]>{
 const keys=proof.previous.map(row=>businessSyncSourceIdentity(row.mapping,sourceId))
 return (await db.query(`select distinct p.external_key from teloa_business_sync_object_ids p join teloa_business_sync_object_ids n
  on n.owner_id=p.owner_id and n.scope_id=p.scope_id and n.object_type=p.object_type and n.external_key=p.external_key
  where p.owner_id=$1 and p.scope_id=$2 and p.object_type=$3 and p.source_key=any($4::text[]) and n.source_key=$5 order by p.external_key`,[owner,scope,type,keys,sourceKey])).rows.map(row=>String(row.external_key))
}
const mappings=(configuration:BusinessConfigurationCurrent)=>configuration.leaves.filter(leaf=>leaf.kind==='source-mapping').map(leaf=>JSON.parse(leaf.body) as BusinessSourceMappingDefinition)
const objectType=(configuration:BusinessConfigurationCurrent,id:string)=>{const body=configuration.leaves.find(leaf=>leaf.kind==='object-type'&&leaf.localId===id)?.body;return body?JSON.parse(body):undefined}
const identity=(mapping:BusinessSourceMappingDefinition)=>({domain:mapping.domain,objectType:mapping.objectType,source:mapping.source,primaryKey:mapping.primaryKey,mapping:mapping.mapping})

/** 只承接正式配置中一对一移除/新增且身份提取相同的映射；并行、外来和歧义定义不迁移。 */
export async function mappingReplacementProof(db:PoolClient,pool:Pool,owner:string,scope:string,mapping:BusinessSourceMappingDefinition,type:BusinessObjectTypeDefinition):Promise<MappingReplacementProof|undefined>{
 if(!(await db.query('select configuration_managed from teloa_business_scopes where owner_id=$1 and scope=$2',[owner,scope])).rows[0]?.configuration_managed)return undefined
 const store=new BusinessConfigurationStore(pool),current=await store.currentInTransaction(db,owner,scope)
 if(!current)return undefined
 const currentType=objectType(current,type.id)
 if(!currentType||!isDeepStrictEqual(currentType.format==='teloa.business-object-type/v2'?businessObjectTypeV2LegacyShape(currentType as BusinessObjectTypeDefinitionV2):currentType,type))return undefined
 const currentMappings=mappings(current),present=currentMappings.find(item=>item.id===mapping.id)
 if(!present||!isDeepStrictEqual(present,mapping))return undefined
 const active=new Set(currentMappings.map(item=>item.id)),previous:Replacement[]=[],seen=new Set<string>([mapping.id])
 let after=current,selected=mapping
 while(after.version>1){
  const before=await store.versionInTransaction(db,owner,scope,after.version-1)
  if(!before)throw corrupt()
  const old=mappings(before),next=mappings(after),same=old.find(item=>item.id===selected.id)
  if(same){if(!isDeepStrictEqual(identity(same),identity(selected)))break;selected=same;after=before;continue}
  const removed=old.filter(item=>!next.some(value=>value.id===item.id)&&isDeepStrictEqual(identity(item),identity(selected)))
  const added=next.filter(item=>!old.some(value=>value.id===item.id)&&isDeepStrictEqual(identity(item),identity(selected)))
  if(removed.length&&(removed.length!==1||added.length!==1))throw conflict()
  if(removed.length!==1||added[0]?.id!==selected.id||!isDeepStrictEqual(objectType(before,type.id),objectType(after,type.id)))break
  const predecessor=removed[0]!
  if(active.has(predecessor.id)||seen.has(predecessor.id))break
  previous.push({mapping:predecessor,configurationVersion:after.version,configurationHash:after.hash});seen.add(predecessor.id)
  selected=predecessor;after=before
 }
 return previous.length?{previous,configurationVersion:current.version,configurationHash:current.hash}:undefined
}

type Tracking={owner_id:string;scope_id:string;object_type:string;source_key:string;external_key:string;object_id:string;source_id:string|null;source_cursor:unknown;source_cursor_basis:unknown}
type Head={version:number;hash:string;snapshot:ReturnType<typeof readBusinessObjectSnapshot>}
async function head(db:PoolClient,owner:string,scope:string,type:string,id:string,sourceId:string):Promise<Head>{
 const rows=(await db.query('select object_version,snapshot_hash,snapshot,source_id from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version desc for update',[owner,scope,type,id])).rows
 if(!rows.length||rows.some(row=>row.source_id!==sourceId||row.snapshot?.source==='本地记录'))throw conflict()
 const row=rows[0]!,snapshot=readBusinessObjectSnapshot(row.snapshot,scope)
 if(snapshot.type!==type||snapshot.id!==id||snapshot.version!==row.object_version||businessObjectSnapshotHash(snapshot)!==row.snapshot_hash)throw corrupt()
 return {version:row.object_version,hash:row.snapshot_hash,snapshot}
}

/** 固定引用继续指向原版本；有独立工作的重复对象不能被自动合并或归档。 */
async function assertNoDuplicateWork(db:PoolClient,owner:string,scope:string,type:string,id:string):Promise<void>{
 for(const table of ['teloa_business_task_sources','teloa_business_object_work_links']){
  if(!(await db.query('select to_regclass($1) present',[table])).rows[0]?.present)continue
  if((await db.query(`select 1 from ${table} where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 limit 1`,[owner,scope,type,id])).rowCount)throw conflict()
 }
 if((await db.query("select to_regclass('teloa_group_task_sources') present")).rows[0]?.present){
  if((await db.query("select 1 from teloa_group_task_sources where owner_id=$1 and source_snapshot->'businessTarget'->'object' @> $2::jsonb limit 1",[owner,JSON.stringify({scope,type,id})])).rowCount)throw conflict()
 }
}

type MappingMigrationInput={db:PoolClient;pool:Pool;owner:string;scope:string;type:string;externalKey:string;sourceId:string;sourceKey:string;timestampBasis:string;proof:MappingReplacementProof;now:string}
export type PreparedMappingObjectMigration={input:MappingMigrationInput;canonical:Tracking;original:Head;duplicate:{tracking:Tracking;head:Head}|undefined;selected:Head;copy:Head|undefined;canonicalId:string;resetBaseline:boolean;cursor:{source_cursor:string|null;source_cursor_basis:string|null};upserted:number;tombstoned:number}

/** 全批先 prepare：只锁身份/真实 head 并固定必要原件，不取 quota、不追加业务版本。 */
export async function prepareMappingObjectMigration(input:MappingMigrationInput):Promise<PreparedMappingObjectMigration|undefined>{
 const {db,owner,scope,type,externalKey,sourceId,sourceKey,timestampBasis,proof}=input
 const keys=proof.previous.map(row=>businessSyncSourceIdentity(row.mapping,sourceId))
 const old=(await db.query('select * from teloa_business_sync_object_ids where owner_id=$1 and scope_id=$2 and object_type=$3 and source_key=any($4::text[]) and external_key=$5 for update',[owner,scope,type,keys,externalKey])).rows as Tracking[]
 if(!old.length)return undefined
 if(old.length!==1||old[0]!.source_id!==sourceId)throw conflict()
 const canonical=old[0]!,original=await head(db,owner,scope,type,canonical.object_id,sourceId)
 if(original.snapshot.deletedAt!==undefined)throw conflict()
 const references=new BusinessSnapshotReferenceService(input.pool,{now:()=>input.now}),referenceId='sync-migration/v1/'+sourceKey+'/'+createHash('sha256').update(externalKey).digest('hex')
 const pin=(value:Head)=>references.pinInTransaction(db,{ownerId:owner,scopeIds:[scope]},{kind:'configuration',referenceId,reference:{scope,type,id:value.snapshot.id,version:value.version,snapshotHash:value.hash}})
 await pin(original)
 const tracking=(await db.query('select * from teloa_business_sync_object_ids where owner_id=$1 and scope_id=$2 and object_type=$3 and source_key=$4 and external_key=$5 for update',[owner,scope,type,sourceKey,externalKey])).rows[0] as Tracking|undefined
 let selected=original,copy:Head|undefined,duplicate:PreparedMappingObjectMigration['duplicate'],baseline:ReturnType<typeof trustedObjectTimestamp>
 const predecessor=proof.previous.find(row=>businessSyncSourceIdentity(row.mapping,sourceId)===canonical.source_key)!
 const oldBasis=(await db.query('select cursor_basis from teloa_business_sync_cursors where owner_id=$1 and scope_id=$2 and mapping_id=$3',[owner,scope,predecessor.mapping.id])).rows[0]?.cursor_basis
 if(oldBasis===timestampBasis)baseline=trustedObjectTimestamp(canonical,objectCursorBasis(canonical.source_key,timestampBasis,original))
 if(tracking){
  if(tracking.source_id!==sourceId)throw conflict()
  const latest=await head(db,owner,scope,type,tracking.object_id,sourceId)
  await assertNoDuplicateWork(db,owner,scope,type,tracking.object_id)
  const time=trustedObjectTimestamp(tracking,objectCursorBasis(sourceKey,timestampBasis,latest))
  if(latest.snapshot.deletedAt!==undefined||!time)throw conflict()
  await pin(latest);duplicate={tracking,head:latest}
  if(baseline&&time.time===baseline.time&&!sameObjectContent(original.snapshot,false,latest.snapshot))throw conflict()
  if(!baseline||time.time>baseline.time){
   baseline=time
   if(!sameObjectContent(original.snapshot,false,latest.snapshot)){
    const snapshot=readBusinessObjectSnapshot({...latest.snapshot,id:canonical.object_id,version:original.version+1},scope)
    copy={version:snapshot.version,hash:businessObjectSnapshotHash(snapshot),snapshot};selected=copy
   }
  }
 }
 return {input,canonical,original,duplicate,selected,copy,canonicalId:canonical.object_id,resetBaseline:baseline===undefined,cursor:{source_cursor:baseline?.value??null,source_cursor_basis:baseline?objectCursorBasis(sourceKey,timestampBasis,selected):null},upserted:copy?1:0,tombstoned:duplicate?1:0}
}

/** 调用方已锁齐整批必要行并核一次总 quota；apply 不再领取其他对象的 head/pin 锁。 */
export async function applyMappingObjectMigration(plan:PreparedMappingObjectMigration,warehouse:Pick<BusinessWarehouseService,'tombstone'>,objectEvent?:((id:string,version:number)=>Promise<void>)):Promise<void>{
 const {db,owner,scope,type,externalKey,sourceId,sourceKey,proof,now}=plan.input,{canonical,duplicate,copy}=plan
 if(copy){
  await db.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,scope,type,canonical.object_id,copy.version,copy.hash,JSON.stringify(copy.snapshot),sourceId,now])
  await objectEvent?.(canonical.object_id,copy.version)
 }
 if(duplicate){
  // tombstone 重验的是 prepare 已锁住的同一真实 head，不在 quota 之后寻找下一对象。
  if(!await warehouse.tombstone(db,owner,scope,type,duplicate.tracking.object_id,sourceId))throw conflict()
  await objectEvent?.(duplicate.tracking.object_id,duplicate.head.version+1)
  const historicalKey=createHash('sha256').update(JSON.stringify(['teloa.business-sync-retired-duplicate/v1',sourceKey,canonical.object_id,duplicate.tracking.object_id])).digest('hex')
  await db.query('update teloa_business_sync_object_ids set source_key=$6 where owner_id=$1 and scope_id=$2 and object_type=$3 and source_key=$4 and external_key=$5',[owner,scope,type,sourceKey,externalKey,historicalKey])
 }
 await db.query('insert into teloa_business_sync_mapping_migrations(owner_id,scope_id,object_type,target_source_key,external_key,canonical_object_id,configuration_version,configuration_hash,proof,previous_tracking,duplicate_tracking,created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[owner,scope,type,sourceKey,externalKey,canonical.object_id,proof.configurationVersion,proof.configurationHash,JSON.stringify(proof),JSON.stringify(canonical),duplicate?JSON.stringify(duplicate.tracking):null,now])
 await db.query('update teloa_business_sync_object_ids set source_key=$6,source_cursor=$7,source_cursor_basis=$8 where owner_id=$1 and scope_id=$2 and object_type=$3 and source_key=$4 and external_key=$5',[owner,scope,type,canonical.source_key,externalKey,sourceKey,plan.cursor.source_cursor,plan.cursor.source_cursor_basis])
}
