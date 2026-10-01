import type {Pool,PoolClient} from 'pg'
import {WorkError,businessObjectReference,type BusinessObjectReference} from '@teloa/contract'
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from './business-data.ts'

export type BusinessSnapshotReferenceKind='configuration'|'handoff'|'record-operation'|'import'
type Actor={ownerId:string;scopeIds:string[]}
type PinInput={reference:BusinessObjectReference;kind:BusinessSnapshotReferenceKind;referenceId:string}
type ReleaseInput={scope:string;kind:BusinessSnapshotReferenceKind;referenceId:string}
const kinds=['configuration','handoff','record-operation','import'] as const
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&value.trim()===value&&!/[\x00-\x1f\x7f]/.test(value)
const invalid=()=>new WorkError('teloa/invalid-input','固定业务对象引用不合法或不可用。')
const corrupt=()=>new WorkError('teloa/storage-corrupt','固定业务对象快照与存储摘要不一致。')

export async function initializeBusinessSnapshotReferences(pool:Pool):Promise<void>{
 await pool.query(`create table if not exists teloa_business_snapshot_references (
  owner_id text not null, scope_id text not null, kind text not null check(kind in ('configuration','handoff','record-operation','import')),
  reference_id text not null, object_type text not null, object_id text not null, object_version integer not null,
  created_at timestamptz not null,
  primary key(owner_id,scope_id,kind,reference_id,object_type,object_id,object_version),
  foreign key(owner_id,scope_id,object_type,object_id,object_version)
   references teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version)
 )`)
}

export class BusinessSnapshotReferenceService{
 private readonly identity:{now:()=>string}
 constructor(_pool:Pool,identity:{now:()=>string}){this.identity=identity}
 async pinInTransaction(db:PoolClient,actor:Actor,input:PinInput):Promise<void>{
  const reference=businessObjectReference(input?.reference)
  if(!text(actor?.ownerId,200)||!actor.scopeIds?.includes(reference.scope)||!kinds.includes(input.kind)||!text(input.referenceId,200))throw invalid()
  // 与 prune 对同一快照行的删除互斥；锁保持到调用方提交，随后 FK 继续保护引用。
  const row=(await db.query(`select snapshot_hash,snapshot from teloa_business_object_snapshots
   where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 and object_version=$5 for key share`,
   [actor.ownerId,reference.scope,reference.type,reference.id,reference.version])).rows[0] as {snapshot_hash:string;snapshot:unknown}|undefined
  if(!row)throw invalid()
  let stored:ReturnType<typeof readBusinessObjectSnapshot>
  try{stored=readBusinessObjectSnapshot(row.snapshot,reference.scope)}catch{throw corrupt()}
  if(stored.type!==reference.type||stored.id!==reference.id||stored.version!==reference.version||businessObjectSnapshotHash(stored)!==row.snapshot_hash)throw corrupt()
  if(row.snapshot_hash!==reference.snapshotHash)throw invalid()
  await db.query(`insert into teloa_business_snapshot_references
   (owner_id,scope_id,kind,reference_id,object_type,object_id,object_version,created_at)
   values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing`,
   [actor.ownerId,reference.scope,input.kind,input.referenceId,reference.type,reference.id,reference.version,this.identity.now()])
 }
 async releaseInTransaction(db:PoolClient,actor:Actor,input:ReleaseInput):Promise<void>{
  if(!text(actor?.ownerId,200)||!text(input?.scope,120)||!actor.scopeIds?.includes(input.scope)||!kinds.includes(input.kind)||!text(input.referenceId,200))throw invalid()
  await db.query('delete from teloa_business_snapshot_references where owner_id=$1 and scope_id=$2 and kind=$3 and reference_id=$4',[actor.ownerId,input.scope,input.kind,input.referenceId])
 }
}
