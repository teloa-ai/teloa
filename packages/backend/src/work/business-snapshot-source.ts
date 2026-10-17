import type {PoolClient} from 'pg'

/** 同步对象的实际来源独立于记录类型的本地来源声明；只接受已登记且历史一致的身份。 */
export async function registeredBusinessSnapshotSources(db:PoolClient,ownerId:string,scope:string,objectType:string,objectIds:readonly string[]):Promise<Map<string,string>>{
 if(!objectIds.length)return new Map()
 const table=(await db.query("select to_regclass('teloa_business_sync_object_ids') as present")).rows[0]?.present
 if(!table)return new Map()
 const rows=(await db.query(`select m.object_id,m.source_id from teloa_business_sync_object_ids m
  where m.owner_id=$1 and m.scope_id=$2 and m.object_type=$3 and m.object_id=any($4::text[]) and m.source_id is not null
  and not exists(select 1 from teloa_business_object_snapshots s
   where s.owner_id=m.owner_id and s.scope_id=m.scope_id and s.object_type=m.object_type and s.object_id=m.object_id
   and (s.source_id<>m.source_id or s.snapshot->>'source'='本地记录'))`,[ownerId,scope,objectType,objectIds])).rows as Array<{object_id:string;source_id:string}>
 return new Map(rows.map(row=>[row.object_id,row.source_id]))
}
