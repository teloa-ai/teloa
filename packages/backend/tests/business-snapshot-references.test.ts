import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {businessObjectSnapshotHash,initializeBusinessData} from '../src/work/business-data.ts'
import {BusinessWarehouseService} from '../src/work/business-warehouse.ts'
import {BusinessSnapshotReferenceService,initializeBusinessSnapshotReferences} from '../src/work/business-snapshot-references.ts'

let container:StartedPostgreSqlContainer,pool:Pool
const NOW='2026-09-29T12:00:00.000Z'
const old='2026-06-01T12:00:00.000Z'
const actor=(ownerId:string)=>({ownerId,scopeIds:['SOC']})
const snapshot=(id:string,version:number)=>({scope:'SOC',type:'alert',id,version,title:'告警',source:'EDR',observedAt:old,receivedAt:old,quality:'complete' as const,summary:'摘要',fields:[{label:'严重度',value:'高'}]})
const reference=(id:string,version:number)=>({scope:'SOC',type:'alert',id,version,snapshotHash:businessObjectSnapshotHash(snapshot(id,version))})
const service=()=>new BusinessSnapshotReferenceService(pool,{now:()=>NOW})
const warehouse=()=>new BusinessWarehouseService(pool,{now:()=>NOW})

before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessData(pool)
 await initializeBusinessSnapshotReferences(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

async function put(owner:string,id:string,version:number,at=old):Promise<void>{
 const item=snapshot(id,version)
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
 values($1,'SOC','alert',$2,$3,$4,$5,'EDR',$6)`,[owner,id,version,businessObjectSnapshotHash(item),JSON.stringify(item),at])
}
async function transaction<T>(run:(db:PoolClient)=>Promise<T>):Promise<T>{
 const db=await pool.connect()
 try{await db.query('begin');const value=await run(db);await db.query('commit');return value}
 catch(error){await db.query('rollback');throw error}finally{db.release()}
}
const versions=async(owner:string,id:string)=>(await pool.query('select object_version from teloa_business_object_snapshots where owner_id=$1 and object_id=$2 order by object_version',[owner,id])).rows.map(row=>row.object_version as number)

test('固定旧版保留、未引用旧版清理，释放后可清理；当前版始终保留',async()=>{
 const owner=randomUUID()
 for(const id of ['pinned','free']){await put(owner,id,1);await put(owner,id,2,NOW)}
 await transaction(db=>service().pinInTransaction(db,actor(owner),{reference:reference('pinned',1),kind:'configuration',referenceId:'config-1'}))
 assert.equal(await warehouse().prune(owner,'SOC','alert',90),1)
 assert.deepEqual(await versions(owner,'pinned'),[1,2])
 assert.deepEqual(await versions(owner,'free'),[2])
 await transaction(db=>service().releaseInTransaction(db,actor(owner),{scope:'SOC',kind:'configuration',referenceId:'config-1'}))
 assert.equal(await warehouse().prune(owner,'SOC','alert',90),1)
 assert.deepEqual(await versions(owner,'pinned'),[2])
})

test('引用重试幂等，单个 referenceId 可固定多个版本；其他 owner 不可释放',async()=>{
 const owner=randomUUID(),id='multi'
 for(const version of [1,2,3])await put(owner,id,version,version===3?NOW:old)
 for(const version of [1,2,1])await transaction(db=>service().pinInTransaction(db,actor(owner),{reference:reference(id,version),kind:'handoff',referenceId:'handoff-1'}))
 assert.equal((await pool.query('select count(*)::int n from teloa_business_snapshot_references where owner_id=$1',[owner])).rows[0].n,2)
 await transaction(db=>service().releaseInTransaction(db,actor(randomUUID()),{scope:'SOC',kind:'handoff',referenceId:'handoff-1'}))
 assert.equal(await warehouse().prune(owner,'SOC','alert',90),0)
 await transaction(db=>service().releaseInTransaction(db,actor(owner),{scope:'SOC',kind:'handoff',referenceId:'handoff-1'}))
 await transaction(db=>service().releaseInTransaction(db,actor(owner),{scope:'SOC',kind:'handoff',referenceId:'handoff-1'}))
 assert.equal(await warehouse().prune(owner,'SOC','alert',90),2)
 assert.deepEqual(await versions(owner,id),[3])
})

test('拒绝越权、缺失、摘要冲突与损坏快照；错误不含正文',async()=>{
 const owner=randomUUID(),id='invalid'
 await put(owner,id,1)
 const pin=(who:ReturnType<typeof actor>,ref=reference(id,1),referenceId='record-1')=>transaction(db=>service().pinInTransaction(db,who,{reference:ref,kind:'record-operation',referenceId}))
 await assert.rejects(pin(actor(owner),reference('missing',1)),{code:'teloa/invalid-input'})
 await assert.rejects(pin(actor(randomUUID())),{code:'teloa/invalid-input'})
 await assert.rejects(pin({ownerId:owner,scopeIds:['AppSec']}),{code:'teloa/invalid-input'})
 await assert.rejects(pin(actor(owner),{...reference(id,1),snapshotHash:'a'.repeat(64)}),{code:'teloa/invalid-input'})
 for(const referenceId of ['', 'x'.repeat(201),'bad\nline'])await assert.rejects(pin(actor(owner),reference(id,1),referenceId),{code:'teloa/invalid-input'})
 await pool.query(`update teloa_business_object_snapshots set snapshot='{}'::jsonb where owner_id=$1 and object_id=$2`,[owner,id])
 await assert.rejects(pin(actor(owner)),(error:{code?:string;message?:string})=>error.code==='teloa/storage-corrupt'&&!error.message?.includes('告警'))
})

test('pin 已取得行锁时 prune 跳过该版本；提交后引用有效',async()=>{
 const owner=randomUUID(),id='race'
 await put(owner,id,1);await put(owner,id,2,NOW)
 const db=await pool.connect()
 try{
  await db.query('begin')
  await service().pinInTransaction(db,actor(owner),{reference:reference(id,1),kind:'import',referenceId:'import-1'})
  const pid=(await db.query('select pg_backend_pid() as pid')).rows[0].pid
  const relation=(await pool.query("select oid from pg_class where relname='teloa_business_object_snapshots'")).rows[0].oid
  const locks=(await pool.query("select count(*)::int n from pg_locks where pid=$1 and relation=$2 and mode='RowShareLock' and granted",[pid,relation])).rows[0].n
  assert.ok(locks>0,'pin 在提交前确实持有快照行锁')
  assert.equal(await warehouse().prune(owner,'SOC','alert',90),0)
  await db.query('commit')
  assert.equal(await warehouse().prune(owner,'SOC','alert',90),0)
  assert.deepEqual(await versions(owner,id),[1,2])
 }finally{await db.query('rollback').catch(()=>{});db.release()}
})

test('prune 遇到真实 PG 的旧快照 FK 冲突后重试，不计为已清理',{timeout:30000},async()=>{
 const owner=randomUUID(),id='mvcc'
 await put(owner,id,1);await put(owner,id,2,NOW)
 const stale=await pool.connect()
 try{
  await stale.query('begin isolation level repeatable read')
  await stale.query('select 1 from teloa_business_snapshot_references')
  await transaction(db=>service().pinInTransaction(db,actor(owner),{reference:reference(id,1),kind:'import',referenceId:'race-2'}))
  let staleDeletes=0
  const retryPool={query:async(sql:string,params?:unknown[])=>{
   if(sql.startsWith('delete from teloa_business_object_snapshots')&&staleDeletes++===0){
    try{return await stale.query(sql,params)}finally{await stale.query('rollback')}
   }
   return pool.query(sql,params)
  }} as unknown as Pool
  const retryService=new BusinessWarehouseService(retryPool,{now:()=>NOW})
  assert.equal(await retryService.prune(owner,'SOC','alert',90),0)
  assert.equal(staleDeletes,2,'首次旧快照查询遭 FK 拒绝，第二次重新读取后跳过')
  assert.deepEqual(await versions(owner,id),[1,2])
 }finally{await stale.query('rollback').catch(()=>{});stale.release()}
})
