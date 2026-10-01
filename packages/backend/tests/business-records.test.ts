import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {readBusinessObjectTypeDefinitionVersioned,type BusinessObjectFieldDefinition} from '@teloa/contract'
import {businessRecordSchemaFingerprint} from '../src/work/business-record-schema.ts'
let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或远端来源')}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool)
 await api.initializeBusinessSync(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const basic:BusinessObjectFieldDefinition[]=[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]
async function fixture(fields=basic,extraTypes:string[]=[]){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'客户业务'})
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户记录',sourceId:draft.candidate.sources[0]!.sourceId,fields}
 const writable=true
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition},...extraTypes.map(id=>({kind:'object-type',definition:{...definition,id,title:id,fields:basic}}))],upsertPages:[{id:'home',title:'记录',kind:'records',objectType:'customer',fields:fields.map(f=>f.name),allowCreate:writable,allowEdit:writable,allowArchive:true}],homePageId:'home'}})
 await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 actor.scopeIds=(await new api.BusinessScopeService(pool).list(actor.ownerId)).map(row=>row.scope)
 assert.equal(typeof api.BusinessRecordService,'function','须提供统一本地记录服务')
 await api.initializeBusinessRecords(pool)
 const warehouse=new api.BusinessWarehouseService(pool,identity),references=new api.BusinessSnapshotReferenceService(pool,identity)
 const dependencies={definitions,warehouse,references},records=new api.BusinessRecordService(pool,identity,dependencies)
 const input={scope:draft.scope,type:'customer',requestId:randomUUID(),title:'第一位客户',summary:'',fields:[{name:'state',value:'待联系'}]}
 return {actor,records,input,dependencies,definition,runtime,drafts,apply,preview}
}
test('真实采用后停用runtime仍可录入，编辑归档后原请求回执固定原版本',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input)
 assert.equal(first.version,1);assert.match(first.id,/^[a-f0-9-]{36}$/);assert.deepEqual(first.fields,[{label:'状态',value:'待联系'}])
 assert.equal((await f.runtime.get(f.actor,f.input.scope)).syncEnabled,false)
 const edit={scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]}
 const second=await f.records.edit(f.actor,edit);assert.equal(second.version,2);assert.equal(second.title,first.title)
 const archived=await f.records.archive(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:2,requestId:randomUUID()})
 assert.equal(archived.version,3);assert.ok(archived.deletedAt)
 const rebuilt=new api.BusinessRecordService(pool,identity,f.dependencies)
 assert.deepEqual(await rebuilt.create(f.actor,f.input),first)
 assert.deepEqual(await rebuilt.receipt(f.actor,{requestId:edit.requestId}),second)
 assert.deepEqual(await rebuilt.get(f.actor,{scope:first.scope,type:first.type,id:first.id,version:1}),first)
 assert.equal((await rebuilt.list(f.actor,{scope:first.scope,type:first.type,limit:10})).items.length,0)
 assert.equal(await f.dependencies.warehouse.prune(f.actor.ownerId,first.scope,first.type,1),0)
 await assert.rejects(rebuilt.create(f.actor,{...f.input,title:'不同正文'}),{code:'teloa/conflict'})
})
test('严格字段语义、owner与scope隔离及重复未知字段不产生快照',async()=>{
 const fields:BusinessObjectFieldDefinition[]=[...basic,{name:'count',label:'数量',from:'数量',type:'number',required:false},{name:'stage',label:'阶段',from:'阶段',type:'enum',values:['新','旧'],required:false},{name:'date',label:'时间',from:'时间',type:'datetime',required:false},{name:'duration',label:'耗时',from:'耗时',type:'duration',required:false},{name:'enabled',label:'有效',from:'有效',type:'boolean',required:false}]
 const f=await fixture(fields)
 for(const bad of [[],[{name:'state',value:''}],[...f.input.fields,{name:'count',value:'12abc'}],[...f.input.fields,{name:'stage',value:'不存在'}],[...f.input.fields,{name:'date',value:'2026-02-31T00:00:00.000Z'}],[...f.input.fields,{name:'duration',value:'abc'}],[...f.input.fields,{name:'enabled',value:'maybe'}],[...f.input.fields,...f.input.fields],[...f.input.fields,{name:'unknown',value:'x'}]])await assert.rejects(f.records.create(f.actor,{...f.input,requestId:randomUUID(),fields:bad}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 const first=await f.records.create(f.actor,{...f.input,fields:[...f.input.fields,{name:'count',value:'1e3'},{name:'stage',value:'新'},{name:'date',value:'2026-09-29T00:00:00.000Z'},{name:'duration',value:'PT5M'},{name:'enabled',value:'是'}]})
 await assert.rejects(f.records.get({...f.actor,scopeIds:[]},{scope:first.scope,type:first.type,id:first.id}),{code:'teloa/forbidden'})
 await assert.rejects(f.records.get({...f.actor,ownerId:randomUUID()},{scope:first.scope,type:first.type,id:first.id}))
 assert.equal(await f.records.receipt({...f.actor,ownerId:randomUUID()},{requestId:f.input.requestId}),undefined)
})
import {businessObjectSnapshotHash,readBusinessObjectSnapshot} from '../src/work/business-data.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'
import type {PoolClient} from 'pg'
async function counts(owner:string){
 const result:number[]=[]
 for(const table of ['teloa_business_object_snapshots','teloa_business_record_heads','teloa_business_record_receipts','teloa_business_snapshot_references'])result.push((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[owner])).rows[0].n)
 return result
}
async function blockedBy(client:PoolClient,count=1){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid
 for(let i=0;i<4000;i++){
  if(((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount??0)>=count)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 throw Error('未观察到PG锁屏障')
}
test('同记录两请求 CAS 竞争只追加一个版本，同request并发只创建一条',async()=>{
 const f=await fixture()
 const same=await Promise.all([f.records.create(f.actor,f.input),f.records.create(f.actor,f.input)])
 assert.deepEqual(same[0],same[1])
 const first=same[0]!,block=await pool.connect();await block.query('begin')
 await block.query('select 1 from teloa_business_record_heads where owner_id=$1 and object_id=$2 for update',[f.actor.ownerId,first.id])
 const pending=[1,2].map(n=>f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'竞争'+n}]}))
 const result=Promise.allSettled(pending);await blockedBy(block);await block.query('commit');block.release()
 const settled=await result
 assert.equal(settled.filter(r=>r.status==='fulfilled').length,1)
 assert.equal(settled.filter(r=>r.status==='rejected'&&r.reason.code==='teloa/version-conflict').length,1)
 assert.deepEqual(await counts(f.actor.ownerId),[2,1,2,3])
})
test('配额拒绝与末尾引用失败回滚快照、head、回执和pin',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input),baseline=await counts(f.actor.ownerId)
 const limited=new api.BusinessWarehouseService(pool,identity)
 limited.scopeRowCount=async()=>500000
 const svc=new api.BusinessRecordService(pool,identity,{...f.dependencies,warehouse:limited})
 await assert.rejects(svc.create(f.actor,{...f.input,requestId:randomUUID()}),{code:'teloa/invalid-input'})
 await assert.rejects(svc.archive(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID()}),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const failed=new api.BusinessRecordService(pool,identity,{...f.dependencies,references:{pinInTransaction:async(db,actor,input)=>{await f.dependencies.references.pinInTransaction(db,actor,input);throw Error('pin failed')}}})
 await assert.rejects(failed.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'不可保存'}]}),/pin failed/)
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 assert.equal((await f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id})).version,1)
})
test('列表稳定keyset、绑定owner/scope/type；普通读取不写快照或联网',async()=>{
 const f=await fixture(),created=[]
 for(let n=0;n<4;n++)created.push(await f.records.create(f.actor,{...f.input,requestId:randomUUID(),title:'客户'+n}))
 created.sort((a,b)=>a.id.localeCompare(b.id))
 const before=await counts(f.actor.ownerId),query={scope:f.input.scope,type:'customer',limit:1}
 const seen:string[]=[];let cursor:string|undefined
 do{const page=await f.records.list(f.actor,{...query,...(cursor?{cursor}:{})});seen.push(...page.items.map(row=>row.id));cursor=page.nextCursor}while(cursor)
 assert.deepEqual(seen,created.map(row=>row.id));assert.deepEqual(await counts(f.actor.ownerId),before)
 const page=await f.records.list(f.actor,query)
 await assert.rejects(f.records.list({...f.actor,ownerId:randomUUID()},{...query,cursor:page.nextCursor}),{code:'teloa/invalid-input'})
 await assert.rejects(f.records.list(f.actor,{...query,type:'another',cursor:page.nextCursor}),{code:'teloa/invalid-input'})
 await assert.rejects(f.records.list({...f.actor,scopeIds:[...f.actor.scopeIds,'other']},{...query,scope:'other',cursor:page.nextCursor}),{code:'teloa/invalid-input'})
})
test('外部来源禁止本地写；历史失效reference可get/list及原样archive但编辑须重新验证',async()=>{
 const f=await fixture([{name:'related',label:'关联客户',from:'关联客户',type:'reference',referenceType:'customer',required:false}])
 await assert.rejects(f.records.create(f.actor,{...f.input,fields:[{name:'related',value:'缺失目标'}]}),{code:'teloa/invalid-input'})
 const raw={scope:f.input.scope,type:'customer',id:randomUUID(),version:1,title:'历史关联',source:'本地记录',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'',fields:[{label:'关联客户',value:'历史值'}]}
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,1,$5,$6,$7,now())',[f.actor.ownerId,raw.scope,raw.type,raw.id,businessObjectSnapshotHash(raw),JSON.stringify(raw),f.definition.sourceId])
 await pool.query('insert into teloa_business_record_heads(owner_id,scope_id,object_type,object_id,current_version,source_id,created_at) values($1,$2,$3,$4,1,$5,now())',[f.actor.ownerId,raw.scope,raw.type,raw.id,f.definition.sourceId])
 const target={scope:raw.scope,type:raw.type,id:raw.id}
 assert.deepEqual((await f.records.get(f.actor,target)).fields,raw.fields)
 assert.equal((await f.records.list(f.actor,{scope:raw.scope,type:raw.type,limit:10})).items.length,1)
 await assert.rejects(f.records.edit(f.actor,{...target,expectedVersion:1,requestId:randomUUID(),fields:[{name:'related',value:'历史值'}]}),{code:'teloa/invalid-input'})
 assert.deepEqual((await f.records.archive(f.actor,{...target,expectedVersion:1,requestId:randomUUID()})).fields,raw.fields)
 const external=new api.BusinessRecordService(pool,identity,{...f.dependencies,definitions:{forScope:async(db,owner,scope)=>(await f.dependencies.definitions.forScope(db,owner,scope)).map(bundle=>({...bundle,origin:{kind:'market' as const,loadId:'external'}}))}})
 await assert.rejects(external.create(f.actor,{...f.input,fields:[]}),{code:'teloa/invalid-input'})
 await assert.rejects(external.edit(f.actor,{...target,expectedVersion:2,requestId:randomUUID(),fields:[]}),{code:'teloa/invalid-input'})
})
test('source/hash/head/列身份损坏明确拒绝，孤立本地快照不被空列表掩盖',async()=>{
 for(const fault of ['source','hash','identity','head','orphan']){
  const f=await fixture(),first=await f.records.create(f.actor,f.input),target={scope:first.scope,type:first.type,id:first.id}
  if(fault==='source')await pool.query("update teloa_business_object_snapshots set source_id='external' where owner_id=$1",[f.actor.ownerId])
  if(fault==='hash')await pool.query("update teloa_business_object_snapshots set snapshot_hash=repeat('0',64) where owner_id=$1",[f.actor.ownerId])
  if(fault==='identity')await pool.query("update teloa_business_object_snapshots set snapshot=jsonb_set(snapshot,'{id}','\"wrong\"') where owner_id=$1",[f.actor.ownerId])
  if(fault==='head'){
   const {snapshotHash:_,...snapshot}=first;const second={...snapshot,version:2}
   await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,2,$5,$6,$7,now())',[f.actor.ownerId,first.scope,first.type,first.id,businessObjectSnapshotHash(second),JSON.stringify(second),f.definition.sourceId])
  }
  if(fault==='orphan')await pool.query('delete from teloa_business_record_heads where owner_id=$1',[f.actor.ownerId])
  await assert.rejects(f.records.get(f.actor,target),{code:'teloa/storage-corrupt'},fault)
  await assert.rejects(f.records.list(f.actor,{scope:first.scope,type:first.type,limit:10}),{code:'teloa/storage-corrupt'},fault)
 }
})
test('正式记录页只读展示已固定来源身份的同步对象，仍拒绝本地写口与篡改快照',async()=>{
 const f=await fixture(),scope=f.input.scope,owner=f.actor.ownerId,id='SOC-2026-001',source='soc-alerts/list_items'
 const snapshot={scope,type:'customer',id,version:1,title:'生产主机告警',source,observedAt:identity.now(),receivedAt:identity.now(),quality:'complete' as const,summary:'待调查',fields:[{label:'状态',value:'待调查'}]}
 await pool.query('insert into teloa_business_sync_object_ids(owner_id,scope_id,object_type,source_key,external_key,object_id,source_id) values($1,$2,$3,$4,$5,$6,$7)',[owner,scope,'customer','fixed-source-key',id,id,source])
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,1,$5,$6,$7,$8)',[owner,scope,'customer',id,businessObjectSnapshotHash(snapshot),JSON.stringify(snapshot),source,identity.now()])
 const local=await f.records.create(f.actor,{...f.input,requestId:randomUUID()})
 const page=await f.records.list(f.actor,{scope,type:'customer',limit:10})
 assert.deepEqual(page.items.map(item=>item.id),[id,local.id].sort())
 const firstPage=await f.records.list(f.actor,{scope,type:'customer',limit:1})
 assert.ok(firstPage.nextCursor)
 const nextPage=await f.records.list(f.actor,{scope,type:'customer',limit:1,cursor:firstPage.nextCursor})
 assert.deepEqual([...firstPage.items,...nextPage.items].map(item=>item.id),page.items.map(item=>item.id))
 assert.equal(nextPage.nextCursor,undefined)
 assert.equal((await f.records.get(f.actor,{scope,type:'customer',id})).snapshotHash,businessObjectSnapshotHash(snapshot))
 await assert.rejects(f.records.edit(f.actor,{scope,type:'customer',id,expectedVersion:1,requestId:randomUUID(),fields:f.input.fields}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.records.list({...f.actor,scopeIds:[]},{scope,type:'customer',limit:10}),{code:'teloa/forbidden'})
 await assert.rejects(f.records.get({...f.actor,ownerId:randomUUID()},{scope,type:'customer',id}),{code:'teloa/invalid-input'})
 await pool.query("update teloa_business_object_snapshots set snapshot_hash=repeat('0',64) where owner_id=$1 and scope_id=$2 and object_id=$3",[owner,scope,id])
 await assert.rejects(f.records.get(f.actor,{scope,type:'customer',id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.records.list(f.actor,{scope,type:'customer',limit:10}),{code:'teloa/storage-corrupt'})
})
test('同步对象历史读取先校验当前版本且固定来源不能被替换',async()=>{
 const f=await fixture(),scope=f.input.scope,owner=f.actor.ownerId,id='SOC-2026-002',source='soc-alerts/list_items'
 const stamp=identity.now(),base={scope,type:'customer',id,title:'告警',source,observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'',fields:[]}
 await pool.query('insert into teloa_business_sync_object_ids(owner_id,scope_id,object_type,source_key,external_key,object_id,source_id) values($1,$2,$3,$4,$5,$6,$7)',[owner,scope,'customer','fixed-source-key',id,id,source])
 for(const version of [1,2]){
  const snapshot=readBusinessObjectSnapshot({...base,version},scope)
  await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[owner,scope,'customer',id,version,businessObjectSnapshotHash(snapshot),JSON.stringify(snapshot),source,stamp])
 }
 assert.notEqual(source,f.definition.sourceId)
 assert.equal((await f.records.get(f.actor,{scope,type:'customer',id,version:1})).version,1)
 await pool.query("update teloa_business_object_snapshots set snapshot_hash=repeat('0',64) where owner_id=$1 and scope_id=$2 and object_id=$3 and object_version=2",[owner,scope,id])
 await assert.rejects(f.records.get(f.actor,{scope,type:'customer',id,version:1}),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_business_object_snapshots set snapshot_hash=$4 where owner_id=$1 and scope_id=$2 and object_id=$3 and object_version=2',[owner,scope,id,businessObjectSnapshotHash(readBusinessObjectSnapshot({...base,version:2},scope))])
 await pool.query("update teloa_business_object_snapshots set source_id='forged/tool' where owner_id=$1 and scope_id=$2 and object_id=$3",[owner,scope,id])
 await assert.rejects(f.records.get(f.actor,{scope,type:'customer',id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.records.list(f.actor,{scope,type:'customer',limit:10}),{code:'teloa/storage-corrupt'})
})
test('两个不同对象类型写入可同持配置共享锁，排他采用须等待完成',async()=>{
 const f=await fixture(basic,['article']),first=await f.records.create(f.actor,f.input),second=await f.records.create(f.actor,{...f.input,type:'article',requestId:randomUUID()}),block=await pool.connect()
 const draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:first.scope,title:'修改配置标题'})
 const preview=await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:1})
 await block.query('begin');await block.query('select 1 from teloa_business_record_heads where owner_id=$1 for update',[f.actor.ownerId])
 const pending=[first,second].map(row=>f.records.edit(f.actor,{scope:row.scope,type:row.type,id:row.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'并行'}]}))
 await blockedBy(block,2)
 const locks=await pool.query("select count(*)::int n from pg_locks where locktype='advisory' and mode='ShareLock' and granted")
 assert.ok(locks.rows[0].n>=2)
 const adoption=f.apply.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,expectedBaseVersion:1,previewReceipt:preview.receipt})
 let waiting=false
 for(let n=0;n<4000;n++){if((await pool.query("select 1 from pg_locks where locktype='advisory' and mode='ExclusiveLock' and not granted")).rowCount){waiting=true;break}await new Promise<void>(r=>setImmediate(r))}
 assert.ok(waiting);await block.query('commit');block.release()
 assert.equal((await Promise.all(pending)).length,2);assert.equal((await adoption).version,2)
})
test('配置排他锁持有时记录等待，释放后读取新的真实定义',async()=>{
 const f=await fixture(),block=await pool.connect();await block.query('begin');await lockBusinessConfiguration(block,f.actor.ownerId,f.input.scope)
 const pending=f.records.create(f.actor,f.input);await blockedBy(block)
 await block.query('commit');block.release();assert.equal((await pending).version,1)
})
test('标签改名保持历史fields键，操作引用保护过期历史不被清理',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input)
 const draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:first.scope,title:'客户业务'})
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,fields:[{...basic[0],label:'处理进度'}]}}]}})
 const preview=await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:revised.revision})
 await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:revised.revision,expectedBaseVersion:1,previewReceipt:preview.receipt})
 const second=await f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'完成'}]})
 assert.deepEqual(second.fields,[{label:'状态',value:'完成'}]);assert.deepEqual(await f.records.create(f.actor,f.input),first)
 await pool.query("update teloa_business_object_snapshots set first_seen_at='2000-01-01' where owner_id=$1",[f.actor.ownerId])
 assert.equal(await f.dependencies.warehouse.prune(f.actor.ownerId,first.scope,first.type,1),0)
 assert.equal((await f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id,version:1})).snapshotHash,first.snapshotHash)
})
test('同请求重试与并发编辑互斥读取head，不能跨两个提交拼出损坏假象',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input)
 let enter!:()=>void,release!:()=>void,replayPid=0
 const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve)
 const instrumented={connect:async()=>{
  const db=await pool.connect();replayPid=(await db.query('select pg_backend_pid() pid')).rows[0].pid
  return new Proxy(db,{get(target,key){if(key==='query')return async(...args:unknown[])=>{
   if(String(args[0]).startsWith('select max(object_version)')){enter();await gate}
   return (target.query as (...input:unknown[])=>unknown).apply(target,args)
  };const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value}})
 }} as unknown as Pool
 const svc=new api.BusinessRecordService(instrumented,identity,f.dependencies)
 const replay=svc.create(f.actor,f.input),replayed=Promise.allSettled([replay])
 await entered
 let finished=false
 const edit=f.records.edit(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'更新'}]}).finally(()=>finished=true)
 const edited=Promise.allSettled([edit]);let blocked=false
 try{
  for(let n=0;n<4000&&!finished;n++){
   if((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[replayPid])).rowCount){blocked=true;break}
   await new Promise<void>(resolve=>setImmediate(resolve))
  }
 }finally{release()}
 const replayResult=await replayed,editResult=await edited
 assert.ok(blocked,'回执重试应锁定head直至固定回执核验完成')
 assert.equal(replayResult[0]!.status,'fulfilled');assert.equal(editResult[0]!.status,'fulfilled')
 assert.deepEqual(await replay,first)
})
test('版本上限明确拒绝，数据库末尾失败不留下新版本或回执',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input)
 const {snapshotHash:_,...original}=first,max={...original,version:2147483647}
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,now())',[f.actor.ownerId,first.scope,first.type,first.id,max.version,businessObjectSnapshotHash(max),JSON.stringify(max),f.definition.sourceId])
 await pool.query('update teloa_business_record_heads set current_version=$2 where owner_id=$1',[f.actor.ownerId,max.version])
 const baseline=await counts(f.actor.ownerId)
 await assert.rejects(f.records.archive(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:max.version,requestId:randomUUID()}),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const other=await fixture(),requestId=randomUUID()
 await pool.query("alter table teloa_business_record_receipts add constraint task5_fail_receipt check(request_id<>'"+requestId+"'::uuid)")
 try{await assert.rejects(other.records.create(other.actor,{...other.input,requestId}),{code:'23514'});assert.deepEqual(await counts(other.actor.ownerId),[0,0,0,0])}
 finally{await pool.query('alter table teloa_business_record_receipts drop constraint task5_fail_receipt')}
})
import {spawn} from 'node:child_process'
test('独立Node进程重建服务后失回包重试仍返回归档前原快照',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input)
 await f.records.archive(f.actor,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID()})
 const code=`import {Pool} from ${JSON.stringify(import.meta.resolve('pg'))};import * as api from ${JSON.stringify(new URL('../src/index.ts',import.meta.url).href)};import {BusinessDefinitionSourceReader} from ${JSON.stringify(new URL('../src/work/business-definition-source.ts',import.meta.url).href)};
 const data=JSON.parse(process.env.TELOA_TASK5_PROBE),pool=new Pool({connectionString:data.connection}),identity={now:()=>new Date().toISOString()};
 const unavailable=async()=>{throw Error('no network')},store=new api.BusinessConfigurationStore(pool);
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store);
 const service=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)});
 try{process.stdout.write(JSON.stringify(await service.create(data.actor,data.input)))}finally{await pool.end()}`
 const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,TELOA_TASK5_PROBE:JSON.stringify({connection:container.getConnectionUri(),actor:f.actor,input:f.input})},stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v)
 const exit=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
 assert.equal(exit,0,stderr);assert.deepEqual(JSON.parse(stdout),first);assert.deepEqual(await counts(f.actor.ownerId),[2,1,2,3])
})
test('edit显式全字段替换，省略标题摘要保留；历史回执与当前head分别校验',async()=>{
 const f=await fixture([...basic,{name:'note',label:'备注',from:'备注',type:'text',required:false}])
 const first=await f.records.create(f.actor,{...f.input,summary:'原摘要',fields:[...f.input.fields,{name:'note',value:'旧备注'}]})
 const next={scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:f.input.fields}
 const second=await f.records.edit(f.actor,next)
 assert.deepEqual(second.fields,[{label:'状态',value:'待联系'}]);assert.equal(second.summary,'原摘要')
 await assert.rejects(f.records.edit(f.actor,{...next,requestId:randomUUID(),expectedVersion:2,fields:[]}),{code:'teloa/invalid-input'})
 await assert.rejects(f.records.receipt({...f.actor,scopeIds:[]},{requestId:next.requestId}),{code:'teloa/forbidden'})
 await pool.query("update teloa_business_record_receipts set result_reference=jsonb_set(result_reference,'{snapshotHash}',to_jsonb(repeat('0',64))) where owner_id=$1 and request_id=$2",[f.actor.ownerId,next.requestId])
 await assert.rejects(f.records.receipt(f.actor,{requestId:next.requestId}),{code:'teloa/storage-corrupt'})
})
test('get指定不存在的历史版本是not-found，当前记录仍可读',async()=>{
 const f=await fixture(),first=await f.records.create(f.actor,f.input)
 await assert.rejects(f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id,version:2}),{code:'teloa/not-found'})
 assert.deepEqual(await f.records.get(f.actor,{scope:first.scope,type:first.type,id:first.id}),first)
})

const batchSource=()=>({sessionId:randomUUID(),messageId:randomUUID(),seq:3})
const createOperation=(input:{type:string;title:string;summary:string;fields:Array<{name:string;value:string}>})=>({operation:'create' as const,type:input.type,title:input.title,summary:input.summary,fields:input.fields})
test('原子批次两条新增、一次配额、同请求并发和持久来源恢复',async()=>{
 const f=await fixture(),source=batchSource(),input={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input),{...createOperation(f.input),title:'第二位'}]}
 let quotaCalls=0
 const service=new api.BusinessRecordService(pool,identity,{...f.dependencies,warehouse:{tombstone:f.dependencies.warehouse.tombstone.bind(f.dependencies.warehouse),assertQuota:async(db,owner,scope,incoming)=>{quotaCalls++;assert.equal(incoming,2);await f.dependencies.warehouse.assertQuota(db,owner,scope,incoming)}}})
 const [one,two]=await Promise.all([service.batch(f.actor,input,source),service.batch(f.actor,input,source)])
 assert.deepEqual(one,two);assert.equal(one.items.length,2);assert.notEqual(one.items[0]!.id,one.items[1]!.id);assert.equal(quotaCalls,1)
 const rebuilt=new api.BusinessRecordService(pool,identity,f.dependencies),baseline=await counts(f.actor.ownerId)
 assert.deepEqual(await rebuilt.batchReceipt(f.actor,{requestId:input.requestId}),one)
 const found=await rebuilt.recentBatches(f.actor,{scope:input.scope,sessionId:source.sessionId})
 assert.equal(found.items.length,1);assert.equal(found.items[0]!.requestId,input.requestId);assert.deepEqual(found.items[0]!.source,source)
 assert.deepEqual(found.items[0]!.operations.map(row=>row.reference.snapshotHash),one.items.map(row=>row.snapshotHash));assert.deepEqual(await counts(f.actor.ownerId),baseline)
 for(const changed of [{...input,operations:[...input.operations].reverse()},{...input,operations:input.operations.slice(0,1)},{...input,operations:[{...input.operations[0]!,title:'漂移'},input.operations[1]!]}])await assert.rejects(rebuilt.batch(f.actor,changed,source),{code:'teloa/conflict'})
 await assert.rejects(rebuilt.batch(f.actor,input),{code:'teloa/conflict'})
 await assert.rejects(rebuilt.batch(f.actor,input,{...source,seq:4}),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
})
test('后项字段失败、一次总配额失败、末尾引用失败和批次回执失败均全批零写',async()=>{
 const f=await fixture(),base={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input),{...createOperation(f.input),fields:[]}]}
 await assert.rejects(f.records.batch(f.actor,base),{code:'teloa/invalid-input'});assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0])
 const input={...base,operations:[createOperation(f.input),createOperation(f.input)]}
 const limited=new api.BusinessWarehouseService(pool,identity);limited.scopeRowCount=async()=>499999
 await assert.rejects(new api.BusinessRecordService(pool,identity,{...f.dependencies,warehouse:limited}).batch(f.actor,input),{code:'teloa/invalid-input'})
 let pins=0
 const failed=new api.BusinessRecordService(pool,identity,{...f.dependencies,references:{pinInTransaction:async(db,actor,value)=>{await f.dependencies.references.pinInTransaction(db,actor,value);if(++pins===2)throw Error('second pin failed')}}})
 await assert.rejects(failed.batch(f.actor,input),/second pin failed/);assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0])
 await pool.query("alter table teloa_business_record_batches add constraint record_batch_fail check(request_id<>'"+input.requestId+"'::uuid)")
 try{await assert.rejects(f.records.batch(f.actor,input),{code:'23514'});assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0]);assert.equal(await f.records.batchReceipt(f.actor,{requestId:input.requestId}),undefined)}
 finally{await pool.query('alter table teloa_business_record_batches drop constraint record_batch_fail')}
})
test('批次编辑归档复用页面语义；后续页面修改后原批次仍返回固定快照并保留历史',async()=>{
 const f=await fixture([...basic,{name:'note',label:'备注',from:'备注',type:'text',required:false}]),a=await f.records.create(f.actor,{...f.input,fields:[...f.input.fields,{name:'note',value:'保留'}]}),b=await f.records.create(f.actor,{...f.input,requestId:randomUUID()})
 const input={requestId:randomUUID(),scope:a.scope,operations:[{operation:'edit' as const,type:a.type,id:a.id,expectedVersion:1,fields:[{name:'state',value:'完成'},{name:'note',value:'保留'}]},{operation:'archive' as const,type:b.type,id:b.id,expectedVersion:1}]}
 const result=await f.records.batch(f.actor,input);assert.deepEqual(result.items[0]!.fields,[{label:'状态',value:'完成'},{label:'备注',value:'保留'}]);assert.ok(result.items[1]!.deletedAt)
 await f.records.edit(f.actor,{scope:a.scope,type:a.type,id:a.id,expectedVersion:2,requestId:randomUUID(),fields:f.input.fields})
 assert.deepEqual(await f.records.batch(f.actor,input),result);assert.deepEqual(await f.records.batchReceipt(f.actor,{requestId:input.requestId}),result)
 await pool.query("update teloa_business_object_snapshots set first_seen_at='2000-01-01' where owner_id=$1",[f.actor.ownerId]);assert.equal(await f.dependencies.warehouse.prune(f.actor.ownerId,a.scope,a.type,1),0)
})
test('批次与页面CAS竞争、逆序批次请求的head锁次序固定',async()=>{
 const f=await fixture(),a=await f.records.create(f.actor,f.input),b=await f.records.create(f.actor,{...f.input,requestId:randomUUID()})
 const operation=(row:typeof a)=>({operation:'edit' as const,type:row.type,id:row.id,expectedVersion:1,fields:[{name:'state',value:'批次'}]})
 const block=await pool.connect();await block.query('begin');await block.query('select 1 from teloa_business_record_heads where owner_id=$1 for update',[f.actor.ownerId])
 const batch=f.records.batch(f.actor,{requestId:randomUUID(),scope:a.scope,operations:[operation(b),operation(a)]})
 const page=f.records.edit(f.actor,{scope:a.scope,type:a.type,id:a.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'页面'}]})
 const settled=Promise.allSettled([batch,page]);await blockedBy(block);await block.query('commit');block.release()
 const results=await settled;assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(results.filter(row=>row.status==='rejected'&&row.reason.code==='teloa/version-conflict').length,1)
 const x=await fixture(),one=await x.records.create(x.actor,x.input),two=await x.records.create(x.actor,{...x.input,requestId:randomUUID()})
 const competing=await Promise.allSettled([[one,two],[two,one]].map(rows=>x.records.batch(x.actor,{requestId:randomUUID(),scope:one.scope,operations:rows.map(operation)})))
 assert.equal(competing.filter(row=>row.status==='fulfilled').length,1);assert.equal(competing.filter(row=>row.status==='rejected'&&row.reason.code==='teloa/version-conflict').length,1)
})
test('最近批次稳定同时间分页及owner/scope/session边界，来源不补换，损坏不冒充空',async()=>{
 const f=await fixture(),source=batchSource(),sameTime={now:()=> '2026-09-29T20:00:00.000Z'},service=new api.BusinessRecordService(pool,sameTime,f.dependencies),ids:string[]=[]
 for(let n=0;n<3;n++){const requestId=randomUUID();ids.push(requestId);await service.batch(f.actor,{requestId,scope:f.input.scope,operations:[createOperation(f.input)]},{...source,seq:n+1})}
 const input={scope:f.input.scope,sessionId:source.sessionId,limit:1};let cursor:string|undefined;const seen:string[]=[]
 do{const page=await service.recentBatches(f.actor,{...input,...(cursor?{cursor}:{})});seen.push(...page.items.map(row=>row.requestId));cursor=page.nextCursor}while(cursor)
 assert.deepEqual(seen,[...ids].sort().reverse());const first=await service.recentBatches(f.actor,input),firstCursor=first.nextCursor;assert.ok(firstCursor)
 for(const query of [{...input,limit:21},{...input,sessionId:'other',cursor:firstCursor},{...input,scope:'other',cursor:firstCursor}])await assert.rejects(service.recentBatches({...f.actor,scopeIds:[...f.actor.scopeIds,'other']},query),{code:'teloa/invalid-input'})
 await assert.rejects(service.recentBatches({...f.actor,ownerId:randomUUID()},{...input,cursor:firstCursor}),{code:'teloa/invalid-input'})
 await assert.rejects(service.recentBatches({...f.actor,scopeIds:[]},input),{code:'teloa/forbidden'})
 assert.deepEqual((await service.recentBatches(f.actor,{...input,sessionId:'another'})).items,[])
 assert.equal(await service.batchReceipt({...f.actor,ownerId:randomUUID()},{requestId:ids[0]}),undefined)
 await pool.query("update teloa_business_record_batches set child_request_ids=array['11111111-1111-4111-8111-111111111111'::uuid] where owner_id=$1 and request_id=$2",[f.actor.ownerId,ids[0]])
 await assert.rejects(service.batchReceipt(f.actor,{requestId:ids[0]}),{code:'teloa/storage-corrupt'});await assert.rejects(service.recentBatches(f.actor,{scope:input.scope,sessionId:source.sessionId}),{code:'teloa/storage-corrupt'})
})
test('max=1连接池批次/回执/最近批次不嵌套借连接，跨类型沿同配置真源',async()=>{
 const f=await fixture(),draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.input.scope,title:'多类型'})
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,id:'article',title:'稿件'}}]}})
 await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:revised.revision,expectedBaseVersion:1,previewReceipt:(await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:revised.revision})).receipt})
 const small=new Pool({connectionString:container.getConnectionUri(),max:1,connectionTimeoutMillis:2000}),source=batchSource()
 try{const records=new api.BusinessRecordService(small,identity,f.dependencies),input={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input),{...createOperation(f.input),type:'article'}]},result=await records.batch(f.actor,input,source)
 assert.deepEqual(result.items.map(row=>row.type),['customer','article']);assert.deepEqual(await records.batch(f.actor,input,source),result);assert.deepEqual(await records.batchReceipt(f.actor,{requestId:input.requestId}),result);assert.equal((await records.recentBatches(f.actor,{scope:input.scope,sessionId:source.sessionId})).items.length,1)
 }finally{await small.end()}
})
test('可信来源严格校验且已提交无来源不可补换；单条与批次请求域不交叉领养',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input)]}
 for(const source of [{sessionId:'',messageId:'x',seq:1},{sessionId:'s',messageId:'m',seq:0},{sessionId:'s',messageId:'m',seq:1,extra:'injected'}])await assert.rejects(f.records.batch(f.actor,input,source),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0])
 await f.records.batch(f.actor,input)
 await assert.rejects(f.records.batch(f.actor,input,batchSource()),{code:'teloa/conflict'})
 await assert.rejects(f.records.create(f.actor,{...f.input,requestId:input.requestId}),{code:'teloa/conflict'})
 await f.records.create(f.actor,f.input)
 await assert.rejects(f.records.batch(f.actor,{...input,requestId:f.input.requestId}),{code:'teloa/conflict'})
 await assert.rejects(f.records.batchReceipt({...f.actor,scopeIds:[]},{requestId:input.requestId}),{code:'teloa/forbidden'})
})
test('逆序旧批次并发重放全部head先排序锁定，归档后仍读原结果',async()=>{
 const f=await fixture(),a=await f.records.create(f.actor,f.input),b=await f.records.create(f.actor,{...f.input,requestId:randomUUID()})
 const operation=(row:typeof a,expectedVersion:number)=>({operation:'edit' as const,type:row.type,id:row.id,expectedVersion,fields:f.input.fields})
 const first={requestId:randomUUID(),scope:a.scope,operations:[operation(a,1),operation(b,1)]},second={requestId:randomUUID(),scope:a.scope,operations:[operation(b,2),operation(a,2)]}
 const one=await f.records.batch(f.actor,first),two=await f.records.batch(f.actor,second)
 await f.records.archive(f.actor,{scope:a.scope,type:a.type,id:a.id,expectedVersion:3,requestId:randomUUID()})
 const replay=await Promise.all([f.records.batch(f.actor,first),f.records.batch(f.actor,second)])
 assert.deepEqual(replay,[one,two])
})

const relationField:BusinessObjectFieldDefinition={name:'related',label:'关联客户',from:'关联客户',type:'reference',referenceType:'customer',required:false}
test('本地单选关联可创建编辑，目标改名保持ID且归档后固定回执不失败',async()=>{
 const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input)
 const input={...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target.id}]}
 const source=await f.records.create(f.actor,input)
 assert.deepEqual(source.fields,[{label:'状态',value:'待联系'},{label:'关联客户',value:target.id}])
 const renamed=await f.records.edit(f.actor,{scope:target.scope,type:target.type,id:target.id,expectedVersion:1,requestId:randomUUID(),title:'改名客户',fields:f.input.fields})
 const edit={scope:source.scope,type:source.type,id:source.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'完成'},{name:'related',value:target.id}]}
 const updated=await f.records.edit(f.actor,edit)
 assert.equal(updated.fields[1]!.value,target.id)
 await f.records.archive(f.actor,{scope:target.scope,type:target.type,id:target.id,expectedVersion:renamed.version,requestId:randomUUID()})
 const baseline=await counts(f.actor.ownerId),rebuilt=new api.BusinessRecordService(pool,identity,f.dependencies)
 assert.deepEqual(await rebuilt.create(f.actor,input),source)
 assert.deepEqual(await rebuilt.receipt(f.actor,{requestId:edit.requestId}),updated)
 assert.deepEqual(await rebuilt.get(f.actor,{scope:source.scope,type:source.type,id:source.id,version:1}),source)
 await assert.rejects(rebuilt.edit(f.actor,{...edit,requestId:randomUUID(),expectedVersion:2}),{code:'teloa/invalid-input'})
 await assert.rejects(rebuilt.create(f.actor,{...input,fields:f.input.fields}),{code:'teloa/conflict'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
})

test('单选目标缺失归档错owner错scope与非法ID拒绝且四类存储零写',async()=>{
 const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input),other=await fixture([...basic,relationField]),foreign=await other.records.create(other.actor,other.input)
 const actor={...f.actor,scopeIds:[...f.actor.scopeIds,foreign.scope]}
 const invalidTargets=[randomUUID(),foreign.id,' '+target.id,target.id+' ','x'.repeat(201),'bad\nvalue']
 for(const value of invalidTargets){
  const baseline=await counts(f.actor.ownerId)
  await assert.rejects(f.records.create(actor,{...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value}]}),{code:'teloa/invalid-input'})
  assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
 const scopeInput={...f.input,scope:foreign.scope,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:foreign.id}]}
 await assert.rejects(f.records.create(actor,scopeInput),{code:'teloa/invalid-input'})
 await f.records.archive(f.actor,{scope:target.scope,type:target.type,id:target.id,expectedVersion:1,requestId:randomUUID()})
 const baseline=await counts(f.actor.ownerId)
 await assert.rejects(f.records.create(f.actor,{...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target.id}]}),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const required=await fixture([{...relationField,required:true}])
 for(const fields of [[],[{name:'related',value:''}]])await assert.rejects(required.records.create(required.actor,{...required.input,fields}),{code:'teloa/invalid-input'})
 assert.deepEqual(await counts(required.actor.ownerId),[0,0,0,0])
})
test('目标source与快照hash损坏不可关联，孤立快照保留storage-corrupt',async()=>{
 for(const fault of ['head-source','snapshot-source','hash','orphan']){
  const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input)
  if(fault==='head-source')await pool.query("update teloa_business_record_heads set source_id='external' where owner_id=$1",[f.actor.ownerId])
  if(fault==='snapshot-source')await pool.query("update teloa_business_object_snapshots set source_id='external' where owner_id=$1",[f.actor.ownerId])
  if(fault==='hash')await pool.query("update teloa_business_object_snapshots set snapshot_hash=repeat('0',64) where owner_id=$1",[f.actor.ownerId])
  if(fault==='orphan')await pool.query('delete from teloa_business_record_heads where owner_id=$1',[f.actor.ownerId])
  const baseline=await counts(f.actor.ownerId)
  await assert.rejects(f.records.create(f.actor,{...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target.id}]}),{code:'teloa/storage-corrupt'},fault)
  assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
})
test('同批关联及目标归档两种排列均原子拒绝，不留下batch或子回执',async()=>{
 const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input)
 const create={...createOperation(f.input),fields:[...f.input.fields,{name:'related',value:target.id}]},archive={operation:'archive' as const,type:target.type,id:target.id,expectedVersion:1}
 const source=await f.records.create(f.actor,{...f.input,requestId:randomUUID()}),edit={operation:'edit' as const,type:source.type,id:source.id,expectedVersion:1,fields:create.fields}
 const baseline=await counts(f.actor.ownerId)
 for(const operations of [[create,archive],[archive,create],[edit,archive],[archive,edit]]){
  const requestId=randomUUID()
  await assert.rejects(f.records.batch(f.actor,{requestId,scope:target.scope,operations}),{code:'teloa/invalid-input'})
  assert.equal(await f.records.batchReceipt(f.actor,{requestId}),undefined)
  assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
 assert.equal((await pool.query('select count(*)::int n from teloa_business_record_batches where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
})

test('双向编辑、自引用与重复目标按统一head次序完成且不死锁', {timeout:15000},async()=>{
 const f=await fixture([...basic,relationField,{...relationField,name:'related2',from:'关联客户2',label:'关联客户2'}]),a=await f.records.create(f.actor,f.input),b=await f.records.create(f.actor,{...f.input,requestId:randomUUID()})
 const edit=(row:typeof a,target:string)=>({scope:row.scope,type:row.type,id:row.id,expectedVersion:1,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target},{name:'related2',value:target}]})
 const block=await pool.connect();await block.query('begin');await block.query('select 1 from teloa_business_record_heads where owner_id=$1 order by object_type,object_id for update',[f.actor.ownerId])
 const competing=Promise.all([f.records.edit(f.actor,edit(a,b.id)),f.records.edit(f.actor,edit(b,a.id))])
 try{await blockedBy(block)}finally{await block.query('commit');block.release()}
 const results=await competing
 assert.deepEqual(results.map(row=>row.version),[2,2])
 const self=await f.records.edit(f.actor,{...edit(a,a.id),expectedVersion:2})
 assert.equal(self.fields[1]!.value,a.id);assert.equal(self.fields[2]!.value,a.id)
 const shared=await Promise.all([f.records.create(f.actor,{...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:a.id}]}),f.records.create(f.actor,{...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:a.id}]})])
 assert.equal(shared.length,2)
})

test('目标归档先取得锁则并发关联拒绝零写，关联先取得锁则归档保留成功回执', {timeout:15000},async()=>{
 for(const archiveFirst of [true,false]){
  const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input)
  let enter!:()=>void,release!:()=>void,pid=0,paused=false
  const entered=new Promise<void>(resolve=>enter=resolve),gate=new Promise<void>(resolve=>release=resolve)
  const instrumented={connect:async()=>{
   const db=await pool.connect();pid=(await db.query('select pg_backend_pid() pid')).rows[0].pid
   return new Proxy(db,{get(client,key){if(key==='query')return async(...args:unknown[])=>{
    const result=await (client.query as (...input:unknown[])=>Promise<unknown>).apply(client,args)
    if(!paused&&String(args[0]).startsWith('select source_id,current_version,created_at')&&String(args[0]).endsWith(' for update')){paused=true;enter();await gate}
    return result
   };const value=Reflect.get(client,key);return typeof value==='function'?value.bind(client):value}})
  }} as unknown as Pool
  const service=new api.BusinessRecordService(instrumented,identity,f.dependencies)
  const input={...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target.id}]},archive={scope:target.scope,type:target.type,id:target.id,expectedVersion:1,requestId:randomUUID()}
  const baseline=await counts(f.actor.ownerId)
  const first=archiveFirst?service.archive(f.actor,archive):service.create(f.actor,input),firstSettled=Promise.allSettled([first])
  await entered
  const second=archiveFirst?f.records.create(f.actor,input):f.records.archive(f.actor,archive),secondSettled=Promise.allSettled([second])
  let blocked=false
  try{
   for(let n=0;n<4000;n++){
    if((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount){blocked=true;break}
    await new Promise<void>(resolve=>setImmediate(resolve))
   }
  }finally{release()}
  assert.ok(blocked,'竞争事务必须等待目标head锁')
  assert.equal((await firstSettled)[0]!.status,'fulfilled')
  const result=(await secondSettled)[0]!
  if(archiveFirst){assert.equal(result.status,'rejected');if(result.status==='rejected')assert.equal(result.reason.code,'teloa/invalid-input');assert.deepEqual(await counts(f.actor.ownerId),baseline.map((n,i)=>n+[1,0,1,2][i]!))}
  else{
   assert.equal(result.status,'fulfilled')
   const source=await first
   assert.deepEqual(await f.records.create(f.actor,input),source)
   assert.deepEqual(await f.records.receipt(f.actor,{requestId:input.requestId}),source)
   assert.equal((await f.records.list(f.actor,{scope:target.scope,type:target.type,limit:10})).items.length,1)
  }
 }
})

test('目标类型和本地来源身份分别验证，外部目标或未声明source不能写',async()=>{
 const f=await fixture([...basic,{...relationField,referenceType:'article'}],['article'])
 const wrongType=await f.records.create(f.actor,f.input),target=await f.records.create(f.actor,{...f.input,type:'article',requestId:randomUUID()})
 const input={...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target.id}]}
 const baseline=await counts(f.actor.ownerId)
 await assert.rejects(f.records.create(f.actor,{...input,fields:[...f.input.fields,{name:'related',value:wrongType.id}]}),{code:'teloa/invalid-input'})
 for(const fault of ['external','source-missing','duplicate']){
  const records=new api.BusinessRecordService(pool,identity,{...f.dependencies,definitions:{forScope:async(db,owner,scope)=>{
   const bundles=await f.dependencies.definitions.forScope(db,owner,scope)
   return bundles.flatMap(bundle=>{
    const source={...bundle,objectTypes:bundle.objectTypes.filter(row=>row.definition.id==='customer')},target={...bundle,objectTypes:bundle.objectTypes.filter(row=>row.definition.id==='article')}
    if(fault==='external')return [source,{...target,origin:{kind:'market' as const,loadId:'external-target'}}]
    if(fault==='source-missing')return [source,{...target,sources:new Map()}]
    return [source,target,target]
   })
  }}})
  await assert.rejects(records.create(f.actor,input),{code:'teloa/invalid-input'},fault)
  assert.deepEqual(await counts(f.actor.ownerId),baseline)
 }
 const result=await f.records.create(f.actor,input)
 assert.equal(result.fields[1]!.value,target.id)
})

test('关联batch成功后目标归档，重建服务的batchReceipt与recentBatches仍保留成功历史',async()=>{
 const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input),source=batchSource()
 const input={requestId:randomUUID(),scope:target.scope,operations:[{...createOperation(f.input),fields:[...f.input.fields,{name:'related',value:target.id}]}]}
 const result=await f.records.batch(f.actor,input,source)
 await f.records.archive(f.actor,{scope:target.scope,type:target.type,id:target.id,expectedVersion:1,requestId:randomUUID()})
 const baseline=await counts(f.actor.ownerId),records=new api.BusinessRecordService(pool,identity,f.dependencies)
 assert.deepEqual(await records.batch(f.actor,input,source),result)
 assert.deepEqual(await records.batchReceipt(f.actor,{requestId:input.requestId}),result)
 const recent=await records.recentBatches(f.actor,{scope:target.scope,sessionId:source.sessionId})
 assert.equal(recent.items[0]!.operations[0]!.reference.snapshotHash,result.items[0]!.snapshotHash)
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 const archived=await records.archive(f.actor,{scope:target.scope,type:result.items[0]!.type,id:result.items[0]!.id,expectedVersion:1,requestId:randomUUID()})
 assert.deepEqual(archived.fields,result.items[0]!.fields)
})

test('目标正常归档后只改中文label的配置仍可采用，历史单ID字段保持原样',async()=>{
 const f=await fixture([...basic,relationField]),target=await f.records.create(f.actor,f.input)
 const source=await f.records.create(f.actor,{...f.input,requestId:randomUUID(),fields:[...f.input.fields,{name:'related',value:target.id}]})
 await f.records.archive(f.actor,{scope:target.scope,type:target.type,id:target.id,expectedVersion:1,requestId:randomUUID()})
 const draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:target.scope,title:'关联显示名称调整'})
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,fields:[basic[0],{...relationField,label:'关联对象'}]}}]}})
 const preview=await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:revised.revision})
 await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:revised.revision,expectedBaseVersion:1,previewReceipt:preview.receipt})
 assert.deepEqual(await f.records.get(f.actor,{scope:source.scope,type:source.type,id:source.id}),source)
})

test('batch_in_transaction_rolls_back_all_rows_and_receipts',async()=>{
 const f=await fixture(),db=await pool.connect(),requestId=randomUUID()
 const input={requestId,scope:f.input.scope,operations:[createOperation(f.input),{...createOperation(f.input),title:'第二位客户'}]}
 try{
  await db.query('begin')
  const result=await f.records.batchInTransaction(db,f.actor,input,undefined,{scope:f.input.scope,type:f.input.type,schemaFingerprint:businessRecordSchemaFingerprint(readBusinessObjectTypeDefinitionVersioned(f.definition))})
  assert.equal(result.items.length,2)
  for(const table of ['teloa_business_object_snapshots','teloa_business_record_heads','teloa_business_record_receipts'])assert.equal((await db.query('select count(*)::int n from '+table+' where owner_id=$1',[f.actor.ownerId])).rows[0].n,2)
  assert.equal((await db.query('select count(*)::int n from teloa_business_record_batches where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
  await db.query('rollback')
 }finally{await db.query('rollback');db.release()}
 assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0])
 assert.equal(await f.records.batchReceipt(f.actor,{requestId}),undefined)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_record_batches where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
})

test('no_nested_begin_or_commit且调用方PoolClient不连接释放',async()=>{
 const transactionControl=/^\s*(begin|commit|rollback)\b/i
 for(const sql of ['begin','commit','rollback','  BEGIN transaction'])assert.equal(transactionControl.test(sql),true,'检测器必须识别事务控制：'+sql)
 assert.equal(transactionControl.test('select 1'),false)
 const f=await fixture(),db=await pool.connect(),controls:string[]=[]
 const unavailable=()=>{throw Error('同事务记录原语不得取得或释放连接')}
 const records=new api.BusinessRecordService({connect:unavailable} as unknown as Pool,identity,f.dependencies)
 const transactionClient=new Proxy(db,{get(client,key){
  if(key==='release')return unavailable
  if(key==='query')return async(...args:unknown[])=>{
   const sql=String(args[0]);if(transactionControl.test(sql))controls.push(sql)
   return (client.query as (...input:unknown[])=>Promise<unknown>).apply(client,args)
  }
  const value=Reflect.get(client,key);return typeof value==='function'?value.bind(client):value
 }})
 try{
  await db.query('begin')
  const result=await records.batchInTransaction(transactionClient,f.actor,{requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input)]})
  assert.equal(result.items.length,1);assert.deepEqual(controls,[])
  await db.query('rollback')
 }finally{await db.query('rollback');db.release()}
 assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0])
})

test('guard_rejects_schema_drift_without_writes',async()=>{
 const f=await fixture(),schemaFingerprint=businessRecordSchemaFingerprint(readBusinessObjectTypeDefinitionVersioned(f.definition))
 const draft=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:f.input.scope,title:'调整客户显示名称'})
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,title:'客户档案'}}]}})
 const preview=await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:revised.revision})
 await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:revised.revision,expectedBaseVersion:1,previewReceipt:preview.receipt})
 const db=await pool.connect(),requestId=randomUUID()
 try{
  await db.query('begin')
  await assert.rejects(f.records.batchInTransaction(db,f.actor,{requestId,scope:f.input.scope,operations:[createOperation(f.input)]},undefined,{scope:f.input.scope,type:f.input.type,schemaFingerprint}),{code:'teloa/version-conflict'})
  await db.query('rollback')
 }finally{await db.query('rollback');db.release()}
 assert.deepEqual(await counts(f.actor.ownerId),[0,0,0,0]);assert.equal(await f.records.batchReceipt(f.actor,{requestId}),undefined)
})

test('legacy_batch_receipt_replays_unchanged且新guard不覆写已成功事实',async()=>{
 const f=await fixture(),source=batchSource(),input={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input)]}
 const original=await f.records.batch(f.actor,input,source),item=original.items[0]!
 await f.records.edit(f.actor,{scope:item.scope,type:item.type,id:item.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'已联系'}]})
 const baseline=await counts(f.actor.ownerId),db=await pool.connect()
 try{
  await db.query('begin')
  assert.deepEqual(await f.records.batchInTransaction(db,f.actor,input,source,{scope:item.scope,type:item.type,schemaFingerprint:'0'.repeat(64)}),original)
  await db.query('commit')
 }finally{await db.query('rollback');db.release()}
 assert.deepEqual(await f.records.batch(f.actor,input,source),original)
 assert.deepEqual(await f.records.batchReceipt(f.actor,{requestId:input.requestId}),original)
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
})

test('new-only事务调用拒绝收养已有普通批次，默认仍可读取原成功事实',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input)]}
 const original=await f.records.batch(f.actor,input),baseline=await counts(f.actor.ownerId),db=await pool.connect()
 try{
  await db.query('begin')
  await assert.rejects(f.records.batchInTransaction(db,f.actor,input,undefined,{scope:f.input.scope,type:'customer',schemaFingerprint:businessRecordSchemaFingerprint(readBusinessObjectTypeDefinitionVersioned(f.definition)),receiptPolicy:'new-only'}),{code:'teloa/conflict'})
  await db.query('rollback')
 }finally{db.release()}
 assert.deepEqual(await counts(f.actor.ownerId),baseline)
 assert.deepEqual(await f.records.batch(f.actor,input),original)
})

test('new-only事务新批次照常写入、完整定义守卫照常核对',async()=>{
 const f=await fixture(),input={requestId:randomUUID(),scope:f.input.scope,operations:[createOperation(f.input)]},db=await pool.connect()
 try{
  await db.query('begin')
  const result=await f.records.batchInTransaction(db,f.actor,input,undefined,{scope:f.input.scope,type:'customer',schemaFingerprint:businessRecordSchemaFingerprint(readBusinessObjectTypeDefinitionVersioned(f.definition)),receiptPolicy:'new-only'})
  assert.equal(result.items.length,1)
  await db.query('commit')
 }finally{await db.query('rollback');db.release()}
 assert.equal((await f.records.batchReceipt(f.actor,{requestId:input.requestId}))!.items.length,1)
})
