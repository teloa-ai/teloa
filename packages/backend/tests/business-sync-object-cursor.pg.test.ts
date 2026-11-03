import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID,createHash} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {writeFileSync} from 'node:fs'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {Pool,stopTestContainer,type PoolClient} from './postgres-test-lifecycle.ts'
import {withLegacySecurityScopes} from './legacy-security-scopes.ts'
import {readBusinessSourceMappingDefinition,type BusinessObjectTypeDefinition,type BusinessSourceMappingDefinition} from '@teloa/contract'
import {BusinessSyncService,initializeBusinessSync,mapSourceItem} from '../src/work/business-sync.ts'
import {businessSyncSourceIdentity} from '../src/work/business-sync-mapping-migration.ts'
import {objectCursorBasis} from '../src/work/business-sync-object-cursor.ts'
import {initializeBusinessData,businessObjectSnapshotHash,readBusinessObjectSnapshot} from '../src/work/business-data.ts'
import {BusinessWarehouseService,initializeBusinessWarehouse} from '../src/work/business-warehouse.ts'
import {initializeBusinessRecords} from '../src/work/business-records.ts'
import {initializeBusinessDefinitions} from '../src/work/business-definition-local.ts'
import {BusinessSpaceService,initializeBusinessSpaces} from '../src/work/business-spaces.ts'
import {initializeBusinessRuntime,BusinessRuntimeService} from '../src/work/business-runtime.ts'
import {initializeBusinessSyncRules} from '../src/work/business-sync-rules.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import type {BusinessSyncSourcePort} from '../src/work/business-sync-sources.ts'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {BusinessConfigurationStore,initializeBusinessConfigurations} from '../src/work/business-configuration-store.ts'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'
import {initializeBusinessSnapshotReferences} from '../src/work/business-snapshot-references.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {TaskService,initializeTasks} from '../src/work/tasks.ts'
import {BusinessTaskService,initializeBusinessTasks} from '../src/work/business-tasks.ts'
import {initializeWorkLineage} from '../src/work/work-lineage.ts'
import {BusinessObjectWorkLinkService,initializeBusinessObjectWork} from '../src/work/business-object-work-links.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const evidencePath=process.env.TELOA_F13_TEST_EVIDENCE
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 if(evidencePath)writeFileSync(evidencePath,JSON.stringify({containerId:container.getId(),started:true,stopped:false})+'\n')
 pool=new Pool({connectionString:container.getConnectionUri()})
 for(const init of [initializeBusinessData,initializeBusinessRecords,initializeBusinessWarehouse,initializeBusinessDefinitions,initializeBusinessSpaces,initializeBusinessRuntime,initializeBusinessSyncRules,initializeBusinessSync,initializeBusinessConfigurations,initializeBusinessSnapshotReferences])await init(pool)
 for(const init of [initializeRoles,initializeTasks,initializeWorkLineage,initializeBusinessTasks,initializeBusinessObjectWork])await init(pool)
 await pool.query('create table f13_order_test_events(owner_id text,kind text,object_id text,version text)')
},{timeout:120000})
after(async()=>{await pool?.end();await stopTestContainer(container);if(evidencePath)writeFileSync(evidencePath,JSON.stringify({containerId:container.getId(),started:true,stopped:true})+'\n')})

const CAPTURED='2026-10-29T12:00:00.000Z',T1='2026-10-28T10:01:00.000Z',T2='2026-10-28T10:02:00.000Z',T3='2026-10-28T10:03:00.000Z'
type Item={id:string;value:string;updatedAt?:string;otherTime?:string;deletedAt?:string}
type Row={object_id:string;object_version:number;snapshot_hash:string;snapshot:{title:string;summary:string;fields:Array<{label:string;value:string}>;deletedAt?:string}}
async function fixture(options:{owner?:string;mappingId?:string;sourceId?:string;scope?:string;persist?:boolean;compare?:boolean}={}){
 const owner=options.owner??randomUUID(),actor={ownerId:owner,scopeIds:[options.scope??'SOC']},clock={now:CAPTURED},identity={id:randomUUID,now:()=>clock.now},mappingId=options.mappingId??'ordered-source',sourceId=options.sourceId??'f13/list_records'
 let scope=options.scope??'SOC'
 await withLegacySecurityScopes(pool,owner,new BusinessSpaceService(pool,identity).ensurePersonal(owner))
 let objectType:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:scope,title:'订单',unit:'条',lead:'合成来源',sourceId,fields:[{name:'id',label:'编号',from:'编号',type:'text',required:true},{name:'value',label:'正文',from:'正文',type:'text',required:true}]}
 let mapping=readBusinessSourceMappingDefinition({format:'teloa.business-source-mapping/v1',id:mappingId,version:'1.0.0',domain:scope,title:'合成同步',objectType:'order',source:{kind:'mcp-tool',serverName:'f13',tool:'list_records',arguments:{},itemsPath:'$.items'},mapping:[{path:'$.id',field:'id'},{path:'$.value',field:'value'}],primaryKey:['id'],incrementalCursor:{kind:'timestamp',path:'$.updatedAt'},deletionSemantics:'tombstone',deletedAtPath:'$.deletedAt',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false})
 if(options.compare){const {deletedAtPath:_,...compare}=mapping;mapping=readBusinessSourceMappingDefinition({...compare,deletionSemantics:'compare'})}
 let mappings=[mapping],pages:Item[][]=[[]],failSync=false
 let bindingKey=createHash('sha256').update(sourceId).digest('hex')
 const source:BusinessSyncSourcePort={key:sourceId,get bindingKey(){return bindingKey},fetch:async input=>{
  const n=input.pageToken===undefined?0:Number(input.pageToken)
  return {items:pages[n]!,capturedAt:CAPTURED,...(n+1<pages.length?{nextCursor:String(n+1)}:{})}
 }}
 const declaration=(definition:unknown)=>({source:{loadId:'isolated-definition-port',scope:'SOC',localId:(definition as {id:string}).id,version:'1.0.0',contentHash:'c',fileHash:'f',definitionHash:createHash('sha256').update(JSON.stringify(definition)).digest('hex'),origin:'local'},definition})
 let definitions:Pick<BusinessDefinitionSourceReader,'forScope'>={forScope:async(_db,_owner,s)=>s===scope?[{origin:{kind:'local'},scope,domain:scope,objectTypes:[declaration(objectType)],mappings:mappings.map(declaration),views:[],actions:[],widgets:[],dashboards:[],sources:new Map()}] as never:[]}
 let rebind:((id:string)=>Promise<void>)|undefined
 let persistMapping:((next:BusinessSourceMappingDefinition,keepPrevious?:boolean)=>Promise<void>)|undefined
 if(options.persist){
  const unavailable=async():Promise<never>=>{throw Error('不得访问旧目录或外部来源')},store=new BusinessConfigurationStore(pool),drafts=new BusinessConfigurationDraftService(pool,identity)
  const reader=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
  const apply=new BusinessConfigurationService(pool,identity,{drafts,store,definitions:reader,runtime:new BusinessRuntimeService(pool,identity),spaces:new BusinessSpaceService(pool,identity)}),preview=new BusinessConfigurationPreviewService(pool,drafts,reader,identity)
  let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'时间来源迁移'})
  scope=draft.scope;objectType={...objectType,domain:scope,sourceId:draft.candidate.sources[0]!.sourceId};mapping={...mapping,domain:scope};actor.scopeIds.push(scope)
  draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:objectType},{kind:'source-mapping',definition:mapping}],upsertPages:[{id:'home',title:'同步记录',kind:'records',objectType:'order',fields:['id','value'],allowCreate:false,allowEdit:false,allowArchive:false}],homePageId:'home'}})
  await apply.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:(await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
  definitions=reader
  persistMapping=async(replacement,keepPrevious=false)=>{
   let next=await drafts.begin(actor,{requestId:randomUUID(),scope})
   next=await drafts.revise(actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:next.revision,patch:{...(replacement.id===mapping.id||keepPrevious?{}:{removeDefinitions:[{kind:'source-mapping',localId:mapping.id}]}),upsertDefinitions:[{kind:'source-mapping',definition:replacement}]}})
   await apply.apply(actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:next.revision,expectedBaseVersion:next.baseVersion,previewReceipt:(await preview.preview(actor,{draftId:next.id,expectedRevision:next.revision})).receipt})
   mapping=replacement
  }
  rebind=async id=>persistMapping!({...mapping,id,title:'本人显式新来源绑定'})
 }
 const observe=async(db:PoolClient,o:string,kind:string,id:string,version:string)=>{await db.query('insert into f13_order_test_events values($1,$2,$3,$4)',[o,kind,id,version])}
 const build=()=>new BusinessSyncService(pool,identity,definitions,new BusinessWarehouseService(pool,identity),async()=>source,{object:(db,o,s,v)=>observe(db,o,s.kind,s.id,v),sync:async(db,o,s,v)=>{await observe(db,o,s.kind,s.mappingId,v);if(failSync){failSync=false;throw Error('合成提交末端故障')}}})
 const service=build()
 const rows=async()=>((await pool.query('select object_id,object_version,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[owner])).rows as Row[])
 const events=async()=>(await pool.query('select kind,object_id,version from f13_order_test_events where owner_id=$1 order by kind,object_id,version',[owner])).rows
 const tracking=async()=>(await pool.query('select * from teloa_business_sync_object_ids where owner_id=$1 order by object_id',[owner])).rows
 const cursor=async()=>(await pool.query('select cursor from teloa_business_sync_cursors where owner_id=$1 and mapping_id=$2',[owner,mappingId])).rows[0]?.cursor as string|undefined
 const run=async(mapId=mappingId,s=service)=>{clock.now=new Date(Date.parse(clock.now)+300000).toISOString();return s.run(actor,{scope,mappingId:mapId,trigger:'manual'})}
 return {owner,actor,scope,clock,identity,source,mapping,objectType,definitions,service,build,rows,events,tracking,cursor,run,rebind,persistMapping,setObjectType:(value:BusinessObjectTypeDefinition)=>{objectType=value},setBindingKey:(value:string)=>{bindingKey=value},setPages:(value:Item[][])=>{pages=value},setMappings:(value:BusinessSourceMappingDefinition[])=>{mappings=value},failSync:()=>{failSync=true}}
}
const value=(r:Row)=>r.snapshot.fields.find(x=>x.label==='正文')!.value

test('timestamp同对象迟到正文不能覆盖较新当前值，水位与原快照保留',async()=>{
 const f=await fixture();f.setPages([[{id:'C',value:'较新v2',updatedAt:T2}]])
 assert.equal((await f.run()).status,'ok')
 const original=await f.rows(),events=await f.events()
 f.setPages([[{id:'C',value:'迟到旧v1',updatedAt:T1}]])
 const late=await f.run()
 assert.equal(late.status,'ok');assert.equal(late.upserted,0)
 assert.deepEqual(await f.rows(),original)
 assert.equal(value((await f.rows()).at(-1)!), '较新v2')
 assert.equal(await f.cursor(),T2)
 assert.deepEqual((await f.events()).filter(x=>x.kind==='business-object'),events.filter(x=>x.kind==='business-object'),'空同步收据可追加，对象变更事件不可追加')
})

test('对象独立顺序：低于全局水位的新对象和本对象较新版本仍接纳，owner及来源不混用',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'A1',updatedAt:T1},{id:'B',value:'B3',updatedAt:T3}]])
 assert.equal((await f.run()).upserted,2)
 f.setPages([[{id:'A',value:'A2',updatedAt:T2},{id:'C',value:'晚到新对象',updatedAt:T1}]])
 assert.equal((await f.run()).upserted,2);assert.equal(await f.cursor(),T3)
 const rows=await f.rows();assert.equal(value(rows.filter(r=>r.object_id==='A').at(-1)!), 'A2');assert.equal(value(rows.find(r=>r.object_id==='C')!), '晚到新对象')
 const otherOwner=await fixture();otherOwner.setPages([[{id:'A',value:'另一owner',updatedAt:T1}]])
 assert.equal((await otherOwner.run()).upserted,1)
 const otherSource=await fixture({owner:f.owner,mappingId:'another-source',sourceId:'f13/another_records'});otherSource.setPages([[{id:'A',value:'另一source',updatedAt:T1}]])
 assert.equal((await otherSource.run()).upserted,1)
 assert.equal((await f.tracking()).length,4);assert.deepEqual((await f.rows()).filter(r=>r.object_id==='A'),rows.filter(r=>r.object_id==='A'))
 const otherScope=await fixture({owner:f.owner,scope:'AppSec'});otherScope.setPages([[{id:'A',value:'另一scope',updatedAt:T1}]])
 assert.equal((await otherScope.run()).upserted,1)
 assert.equal((await f.tracking()).filter(r=>r.scope_id==='AppSec')[0].source_cursor,T1)
 await assert.rejects(f.service.run({...f.actor,scopeIds:[]},{scope:f.scope,mappingId:f.mapping.id,trigger:'manual'}),{code:'teloa/forbidden'})
})

test('同批逆序只取较新条目；等时间异正文整批冲突而非按后到覆盖',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'最新',updatedAt:T3},{id:'A',value:'旧',updatedAt:T1}]])
 assert.equal((await f.run()).upserted,1);assert.equal(value((await f.rows())[0]!), '最新')
 const before=await f.rows(),tracking=await f.tracking(),events=await f.events()
 f.setPages([[{id:'A',value:'同时间冲突',updatedAt:T3}]])
 assert.equal((await f.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await f.rows(),before);assert.deepEqual(await f.tracking(),tracking);assert.deepEqual(await f.events(),events)
 const samePage=await fixture();samePage.setPages([[{id:'A',value:'甲',updatedAt:T1},{id:'A',value:'乙',updatedAt:T1}]])
 assert.equal((await samePage.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await samePage.rows(),[]);assert.deepEqual(await samePage.tracking(),[])
})

test('同正文新时间只推进对象metadata，后续较旧异正文不新增对象版本或事件',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'相同正文',updatedAt:T1}]]);assert.equal((await f.run()).upserted,1)
 const before=await f.rows(),objects=(await f.events()).filter(x=>x.kind==='business-object')
 f.setPages([[{id:'A',value:'相同正文',updatedAt:T3}]]);assert.equal((await f.run()).upserted,0)
 assert.equal((await f.tracking())[0].source_cursor,T3);assert.deepEqual(await f.rows(),before)
 f.setPages([[{id:'A',value:'过期正文',updatedAt:T2}]]);assert.equal((await f.run()).upserted,0)
 assert.deepEqual(await f.rows(),before);assert.deepEqual((await f.events()).filter(x=>x.kind==='business-object'),objects)
})

test('过期删除与复活不覆盖当前头；合法较新删除与复活仍追加固定版本',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'原文',updatedAt:T2}]]);await f.run();const original=await f.rows()
 f.setPages([[{id:'A',value:'原文',updatedAt:T1,deletedAt:T1}]]);assert.equal((await f.run()).tombstoned,0);assert.deepEqual(await f.rows(),original)
 f.setPages([[{id:'A',value:'原文',updatedAt:T3,deletedAt:T3}]]);assert.equal((await f.run()).tombstoned,1);const deleted=await f.rows();assert.ok(deleted.at(-1)!.snapshot.deletedAt)
 f.setPages([[{id:'A',value:'旧复活',updatedAt:T2}]]);assert.equal((await f.run()).upserted,0);assert.deepEqual(await f.rows(),deleted)
 f.setPages([[{id:'A',value:'正式复活',updatedAt:'2026-10-28T10:04:00.000Z'}]]);assert.equal((await f.run()).upserted,1);assert.equal(value((await f.rows()).at(-1)!), '正式复活')
 assert.deepEqual((await f.rows()).slice(0,2),deleted)
})

test('旧NULL或失配head不从observedAt/首个响应/全局水位补基线；缺失时间不能危险改写',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await f.run()
 await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 const before=await f.rows();f.setPages([[{id:'A',value:'原文',updatedAt:T3}]]);assert.equal((await f.run()).upserted,0);assert.equal((await f.tracking())[0].source_cursor,null)
 f.setPages([[{id:'A',value:'危险改写',updatedAt:T3}]]);assert.equal((await f.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await f.rows(),before)
 f.setPages([[{id:'A',value:'原文',updatedAt:T3,deletedAt:T3}]]);assert.equal((await f.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await f.rows(),before)
 const head=await fixture();head.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await head.run();const row=(await head.rows())[0]!
 const next=readBusinessObjectSnapshot({...row.snapshot,version:2,summary:'合成的另一路合法头'},head.scope)
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[head.owner,head.scope,'order',row.object_id,2,businessObjectSnapshotHash(next),JSON.stringify(next),head.source.key,CAPTURED])
 const heads=await head.rows();head.setPages([[{id:'A',value:'危险更新',updatedAt:T3}]]);assert.equal((await head.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await head.rows(),heads)
 const missing=await fixture();missing.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await missing.run();const saved=await missing.rows()
 missing.setPages([[{id:'A',value:'无时间改写'}]]);assert.equal((await missing.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await missing.rows(),saved)
})

test('旧来源冲突后经正式草案/预览/采用新映射恢复，旧配置与全部旧对象快照保留',async()=>{
 const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧来源原文',updatedAt:T1}]]);assert.equal((await f.run()).upserted,1)
 await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 const old=await f.rows(),oldTracking=await f.tracking(),oldDefinitions=(await pool.query('select * from teloa_business_local_definitions where owner_id=$1 order by kind,local_id,version',[f.owner])).rows
 f.setPages([[{id:'A',value:'本人采用的新来源正文',updatedAt:T2}]]);const conflict=await f.run();assert.equal(conflict.error?.code,'teloa/source-conflict');assert.match(conflict.error!.reason,/新映射/)
 await f.rebind!('explicit-rebound-source')
 assert.equal((await f.run('explicit-rebound-source',f.build())).upserted,1)
 for(const row of old)assert.deepEqual((await f.rows()).find(r=>r.object_id===row.object_id&&r.object_version===row.object_version),row)
 assert.equal((await f.tracking())[0].object_id,old[0]!.object_id,'采用新映射仍沿用原业务对象')
 assert.deepEqual((await pool.query('select previous_tracking from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rows[0].previous_tracking,oldTracking[0])
 const db=await pool.connect()
 let current
 try{current=await new BusinessConfigurationStore(pool).currentInTransaction(db,f.owner,f.scope)}finally{db.release()}
 assert.equal(current?.version,2)
 assert.deepEqual((await pool.query('select * from teloa_business_local_definitions where owner_id=$1 order by kind,local_id,version',[f.owner])).rows.filter(r=>oldDefinitions.some(old=>old.kind===r.kind&&old.local_id===r.local_id&&old.version===r.version)),oldDefinitions)
 f.setPages([[{id:'A',value:'新来源正常后续更新',updatedAt:T3}]]);assert.equal((await f.run('explicit-rebound-source',f.build())).upserted,1)
 assert.equal((await f.rows()).length,3);assert.ok((await f.rows()).every(r=>r.object_id===old[0]!.object_id));for(const row of old)assert.deepEqual((await f.rows()).find(r=>r.object_version===row.object_version),row)
 await assert.rejects(f.run(f.mapping.id),{code:'teloa/invalid-input'},'原映射已从正式配置移除；历史仍保留，不能继续运行')
})

test('时间声明口径与来源授权改变不能借旧对象基线危险覆盖',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await f.run();const before=await f.rows(),tracking=await f.tracking()
 f.setMappings([{...f.mapping,incrementalCursor:{kind:'timestamp',path:'$.otherTime'}}])
 f.setPages([[{id:'A',value:'原文',otherTime:T3}]]);assert.equal((await f.run()).upserted,0);assert.deepEqual(await f.tracking(),tracking)
 f.setPages([[{id:'A',value:'危险更新',otherTime:T3}]]);assert.equal((await f.run()).error?.code,'teloa/source-conflict');assert.deepEqual(await f.rows(),before)
 const auth=await fixture();auth.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await auth.run();const authRows=await auth.rows(),authTracking=await auth.tracking()
 auth.setBindingKey('b'.repeat(64));auth.setPages([[{id:'A',value:'换授权更新',updatedAt:T3}]]);assert.equal((await auth.run()).error?.code,'teloa/source-conflict')
 assert.deepEqual(await auth.rows(),authRows);assert.deepEqual(await auth.tracking(),authTracking)
})

test('末端失败同事务回滚对象游标/快照/事件/全局水位；正常重建续办不重复事件',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await f.run()
 const before=await f.rows(),tracking=await f.tracking(),events=await f.events(),cursor=await f.cursor()
 f.setPages([[{id:'A',value:'较新正文',updatedAt:T2}]]);f.failSync()
 await assert.rejects(f.run(),/合成提交末端故障/)
 assert.deepEqual(await f.rows(),before);assert.deepEqual(await f.tracking(),tracking);assert.deepEqual(await f.events(),events);assert.equal(await f.cursor(),cursor)
 assert.equal((await f.run(f.mapping.id,f.build())).upserted,1);const committed=await f.rows(),objects=(await f.events()).filter(x=>x.kind==='business-object')
 assert.equal((await f.tracking())[0].source_cursor,T2);assert.equal((await f.run()).upserted,0);assert.deepEqual(await f.rows(),committed);assert.deepEqual((await f.events()).filter(x=>x.kind==='business-object'),objects)
})

test('ordered compare旧NULL缺席删除须冲突；正常新映射采用后继续且旧对象保留',async()=>{
 const f=await fixture({compare:true,persist:true});f.setPages([[{id:'A',value:'升级前原文',updatedAt:T1}]]);assert.equal((await f.run()).upserted,1)
 await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 await f.persistMapping!({...f.mapping,incrementalCursor:{kind:'timestamp',path:'$.otherTime'}})
 const rows=await f.rows(),tracking=await f.tracking(),events=await f.events(),cursor=await f.cursor()
 f.setPages([[{id:'B',value:'非空全量中的新对象',otherTime:T2}]])
 const result=await f.run();assert.equal(result.tombstoned,0,'无可信对象基线的缺席不能新增tombstone');assert.equal(result.error?.code,'teloa/source-conflict')
 assert.deepEqual(await f.rows(),rows);assert.deepEqual(await f.tracking(),tracking);assert.deepEqual(await f.events(),events);assert.equal(await f.cursor(),cursor)
 await f.rebind!('explicit-new-compare')
 assert.equal((await f.run('explicit-new-compare')).upserted,1)
 f.setPages([[{id:'B',value:'新绑定正常后续',otherTime:T3}]]);assert.equal((await f.run('explicit-new-compare')).upserted,1)
 assert.deepEqual((await f.rows()).filter(r=>r.object_id==='A'),rows);assert.deepEqual((await f.tracking()).find(r=>r.object_id==='A'),tracking[0])
})

test('ordered compare新时间声明full fetch不得缺席删除旧basis对象',async()=>{
 const f=await fixture({compare:true});f.setPages([[{id:'A',value:'原文',updatedAt:T1}]]);await f.run()
 const rows=await f.rows(),tracking=await f.tracking(),events=await f.events(),cursor=await f.cursor()
 f.setMappings([{...f.mapping,incrementalCursor:{kind:'timestamp',path:'$.otherTime'}}]);f.setPages([[{id:'B',value:'新对象',otherTime:T2}]])
 const result=await f.run();assert.equal(result.tombstoned,0,'声明失配对象不能据缺席删除');assert.equal(result.error?.code,'teloa/source-conflict')
 assert.deepEqual(await f.rows(),rows);assert.deepEqual(await f.tracking(),tracking);assert.deepEqual(await f.events(),events);assert.equal(await f.cursor(),cursor)
})

test('ordered compare同时间声明但head失配时不得缺席删除',async()=>{
 const f=await fixture({compare:true});f.setPages([[{id:'A',value:'A原文',updatedAt:T1},{id:'B',value:'B原文',updatedAt:T2}]]);await f.run()
 const {incrementalCursor:_,...full}=f.mapping
 f.setMappings([full]);await f.run();f.setMappings([f.mapping])
 const first=(await f.rows()).find(r=>r.object_id==='A')!,changed=readBusinessObjectSnapshot({...first.snapshot,version:2,summary:'合成的另一合法快照头'},f.scope)
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.owner,f.scope,'order','A',2,businessObjectSnapshotHash(changed),JSON.stringify(changed),f.source.key,CAPTURED])
 const rows=await f.rows(),tracking=await f.tracking(),events=await f.events()
 f.setPages([[{id:'B',value:'B原文',updatedAt:T2}]])
 const result=await f.run();assert.equal(result.tombstoned,0,'旧head基线不能用于删除新head');assert.equal(result.error?.code,'teloa/source-conflict')
 assert.deepEqual(await f.rows(),rows);assert.deepEqual(await f.tracking(),tracking);assert.deepEqual(await f.events(),events);assert.equal(await f.cursor(),null)
})

test('ordered compare同口径可信head可缺席删除且cursor不推进；较新条目可正常恢复',async()=>{
 const f=await fixture({compare:true});f.setPages([[{id:'A',value:'A原文',updatedAt:T1},{id:'B',value:'B原文',updatedAt:T2}]]);await f.run()
 const original=await f.rows(),tracking=await f.tracking(),objectEvents=(await f.events()).filter(r=>r.kind==='business-object')
 // 正常临时改为全量再恢复同一timestamp声明，产生同口径的full fetch；不伪造时间或修改游标表。
 const {incrementalCursor:_,...full}=f.mapping
 f.setMappings([full]);assert.equal((await f.run()).upserted,0);assert.equal(await f.cursor(),null)
 f.setMappings([f.mapping]);f.setPages([[{id:'B',value:'B原文',updatedAt:T2}]])
 const deleted=await f.run();assert.equal(deleted.status,'ok');assert.equal(deleted.tombstoned,1)
 const after=await f.rows(),afterTracking=await f.tracking(),a=afterTracking.find(r=>r.object_id==='A')!
 assert.equal(a.source_cursor,T1,'缺席删除不能发明新来源时间');assert.notEqual(a.source_cursor_basis,tracking.find(r=>r.object_id==='A')!.source_cursor_basis,'basis仅绑定真实tombstone head')
 assert.deepEqual(after.filter(r=>r.object_version===1),original);assert.ok(after.find(r=>r.object_id==='A'&&r.object_version===2)!.snapshot.deletedAt)
 assert.equal((await f.events()).filter(r=>r.kind==='business-object').length,objectEvents.length+1)
 assert.equal((await f.run()).tombstoned,0)
 f.setPages([[{id:'A',value:'A正常恢复',updatedAt:T3}]])
 assert.equal((await f.run()).upserted,1);assert.equal(value((await f.rows()).find(r=>r.object_id==='A'&&r.object_version===3)!), 'A正常恢复')
})


test('显式同源映射迁移只保留canonical旧对象，原任务工作和固定版本仍可核验',async()=>{
 const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧值',updatedAt:T1}]]);assert.equal((await f.run()).status,'ok')
 await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 const old=await f.rows(),oldTracking=await f.tracking()
 const ref={scope:f.scope,type:'order',id:old[0]!.object_id,version:old[0]!.object_version,snapshotHash:old[0]!.snapshot_hash}
 const role=await new RoleService(pool,f.identity).create(f.owner,{requestId:randomUUID(),fields:{name:'原对象负责人',kind:'employee',scopes:[f.scope],duty:'处理原对象',dataScope:'本轮合成记录',executionScope:'只读',skills:[],knowledge:[],responsibility:{triggers:['收到原对象'],autonomousActions:['核对原文'],confirmationPoints:['修改前由本人确认'],escalationRules:['冲突交回本人'],deliveryChecks:['保留固定来源']}}})
 const tasks=new BusinessTaskService(pool,f.identity,new TaskService(pool,f.identity)),task=await tasks.create(f.actor,{requestId:randomUUID(),reference:ref,goal:'继续原业务工作',assignee:{roleId:role.id,expectedVersion:role.version}})
 const links=new BusinessObjectWorkLinkService(pool,f.identity,{authorizeSession:async()=>{}}),link=await links.link(f.actor,{requestId:randomUUID(),reference:ref,sessionId:randomUUID(),title:'原工作与成果入口'})
 const result=await links.publish(f.actor,{requestId:randomUUID(),workLinkId:link.id,slot:'original-result',expectedRevision:0,summary:'原固定来源的已存成果',state:'working',artifactVersions:[]},{sessionId:link.sessionId,messageId:randomUUID(),seq:1,fingerprint:createHash('sha256').update('本轮原工作合成指令').digest('hex')})
 const context=await tasks.context(f.actor,{taskId:task.task.id})
 const originalTask=(await pool.query('select * from teloa_tasks where id=$1',[task.task.id])).rows[0],originalSource=(await pool.query('select * from teloa_business_task_sources where task_id=$1',[task.task.id])).rows[0]
 await f.rebind!('migration-new-source');f.setPages([[{id:'A',value:'新值',updatedAt:T2}]])
 assert.equal((await f.run('migration-new-source',f.build())).status,'ok')
 const all=await f.rows(),heads=new Map(all.map(row=>[row.object_id,row]))
 assert.equal([...heads.values()].filter(row=>row.snapshot.deletedAt===undefined).length,1,'旧mapping移除并明确采用同源新mapping后，不能保留两个当前A')
 assert.equal([...heads.values()].find(row=>row.snapshot.deletedAt===undefined)!.object_id,old[0]!.object_id,'当前入口沿用canonical旧objectId，原工作不换对象')
 for(const row of old)assert.deepEqual(all.find(next=>next.object_id===row.object_id&&next.object_version===row.object_version),row,'原固定版本必须逐字保留')
 assert.deepEqual((await pool.query('select previous_tracking from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rows[0].previous_tracking,oldTracking[0],'旧来源tracking完整前像追加审计')
 assert.deepEqual((await pool.query('select * from teloa_tasks where id=$1',[task.task.id])).rows[0],originalTask)
 assert.deepEqual((await pool.query('select * from teloa_business_task_sources where task_id=$1',[task.task.id])).rows[0],originalSource)
 assert.equal(originalTask.assignee_role_id,role.id);assert.equal(originalTask.assignee_role_version,role.version)
 assert.deepEqual(await tasks.context(f.actor,{taskId:task.task.id}),context,'原Task继续读取创建时固定来源，不能偷换当前正文')
 assert.deepEqual(await links.read(f.actor,{workLinkId:link.id}),link)
 assert.deepEqual(await links.results(f.actor,{workLinkId:link.id}),[result])
 assert.equal(value([...heads.values()].find(row=>row.snapshot.deletedAt===undefined)!), '新值')
 // 同一组映射 ID 可在之后的正常配置版本再次采用；审计不能把合法配置轮次当成旧请求重放。
 await f.rebind!(f.mapping.id);f.setPages([[{id:'A',value:'继续原工作T3',updatedAt:T3}]]);assert.equal((await f.run(f.mapping.id,f.build())).status,'ok')
 await f.rebind!('migration-new-source');assert.equal((await f.run('migration-new-source',f.build())).status,'ok')
 assert.equal(currentRows(await f.rows())[0]!.object_id,ref.id);assert.equal((await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rowCount,3)
 assert.deepEqual(await tasks.context(f.actor,{taskId:task.task.id}),context)
})


// 仅隔离 PG 的 88 兼容夹具：复原当时已成功新 namespace 的重复行，不代表新版正常创建流程。
async function legacyDuplicate(f:Awaited<ReturnType<typeof fixture>>,newId='legacy-replacement',persistCursor=false,externalId='A',rebind=true){
 if(rebind)await f.rebind!(newId)
 const db=await pool.connect();let current
 try{current=await new BusinessConfigurationStore(pool).currentInTransaction(db,f.owner,f.scope)}finally{db.release()}
 const mapping=readBusinessSourceMappingDefinition(JSON.parse(current!.leaves.find(row=>row.kind==='source-mapping'&&row.localId===newId)!.body))
 const mapped=mapSourceItem(mapping,f.objectType,{id:externalId,value:'已成功新来源T2',updatedAt:T2},CAPTURED);assert.ok(!('skipped' in mapped))
 const id=randomUUID(),snapshot=readBusinessObjectSnapshot({...mapped.snapshot,id,version:1},f.scope),hash=businessObjectSnapshotHash(snapshot),key=businessSyncSourceIdentity(mapping,f.source.key)
 const basis='binding/'+f.source.bindingKey+'/'+createHash('sha256').update(JSON.stringify([mapping.source,mapping.incrementalCursor])).digest('hex').slice(0,32)
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,1,$5,$6,$7,$8)',[f.owner,f.scope,'order',id,hash,JSON.stringify(snapshot),f.source.key,CAPTURED])
 await pool.query('insert into teloa_business_sync_object_ids(owner_id,scope_id,object_type,source_key,external_key,object_id,source_id,source_cursor,source_cursor_basis) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',[f.owner,f.scope,'order',key,externalId,id,f.source.key,T2,objectCursorBasis(key,basis,{version:1,hash})])
 if(persistCursor)await pool.query('insert into teloa_business_sync_cursors(owner_id,scope_id,mapping_id,cursor,cursor_basis,consecutive_failures,backoff_until,last_ok_at,updated_at) values($1,$2,$3,$4,$5,0,null,$6,$6)',[f.owner,f.scope,mapping.id,T2,basis,CAPTURED])
 return {id,mapping,snapshot,ref:{scope:f.scope,type:'order',id,version:1,snapshotHash:hash}}
}
const currentRows=(rows:Row[])=>[...new Map(rows.map(row=>[row.object_id,row])).values()].filter(row=>row.snapshot.deletedAt===undefined)

test('88既有同源双活收敛保留canonical与两个原件，lateA不倒退/newB可入且回滚幂等',async()=>{
 const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧原件',updatedAt:T1}]]);await f.run()
 await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 const original=(await f.rows())[0]!,duplicate=await legacyDuplicate(f),before=await f.rows(),tracking=await f.tracking()
 f.setPages([[{id:'A',value:'迟到A1',updatedAt:T1},{id:'B',value:'新B1',updatedAt:T1}]]);f.failSync()
 await assert.rejects(f.run(duplicate.mapping.id,f.build()),/合成提交末端故障/)
 assert.deepEqual(await f.rows(),before);assert.deepEqual(await f.tracking(),tracking);assert.equal((await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rowCount,0)
 const result=await f.run(duplicate.mapping.id,f.build());assert.equal(result.status,'ok',JSON.stringify(result));assert.equal(result.tombstoned,1)
 const rows=await f.rows(),alive=currentRows(rows);assert.equal(alive.length,2)
 assert.equal(value(alive.find(row=>row.object_id===original.object_id)!), '已成功新来源T2');assert.ok(alive.some(row=>value(row)==='新B1'))
 for(const row of before)assert.deepEqual(rows.find(next=>next.object_id===row.object_id&&next.object_version===row.object_version),row,'两个原件固定版本均保持')
 const receipt=(await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rows[0];assert.equal(receipt.canonical_object_id,original.object_id);assert.deepEqual(receipt.duplicate_tracking,tracking.find(row=>row.object_id===duplicate.id))
 assert.deepEqual((await pool.query('select object_id,object_version from teloa_business_snapshot_references where owner_id=$1 order by object_id',[f.owner])).rows.sort((a,b)=>a.object_id.localeCompare(b.object_id)),[{object_id:original.object_id,object_version:original.object_version},{object_id:duplicate.id,object_version:1}].sort((a,b)=>a.object_id.localeCompare(b.object_id)),'两个原件通过正式固定引用抵御正常保留清理')
 const saved=await f.rows(),audit=await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner]);const repeat=await f.run(duplicate.mapping.id,f.build());assert.equal(repeat.upserted,0);assert.equal(repeat.tombstoned,0);assert.deepEqual(await f.rows(),saved);assert.deepEqual((await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rows,audit.rows)
})

test('不同连接参数与并行有效映射的同键记录不自动合并',async()=>{
 for(const parallel of [false,true]){
  const f=await fixture({persist:true});f.setPages([[{id:'A',value:'来源一',updatedAt:T1}]]);await f.run();const original=await f.rows()
  const replacement=readBusinessSourceMappingDefinition({...f.mapping,domain:f.scope,id:parallel?'parallel-source':'another-tenant',...(parallel?{}:{source:{...f.mapping.source,arguments:{tenant:'B'}}})})
  await f.persistMapping!(replacement,parallel);f.setPages([[{id:'A',value:'来源二',updatedAt:T2}]])
  assert.equal((await f.run(replacement.id,f.build())).status,'ok');assert.equal(currentRows(await f.rows()).length,2)
  for(const row of original)assert.deepEqual((await f.rows()).find(next=>next.object_id===row.object_id&&next.object_version===row.object_version),row)
  assert.equal((await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rowCount,0)
 }
})

test('重复UUID已有独立任务或工作时拒绝隐式合并，全部原件/工作/审计不变',async()=>{
 for(const kind of ['task','work']){
  const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧原件',updatedAt:T1}]]);await f.run();const duplicate=await legacyDuplicate(f)
  if(kind==='task')await new BusinessTaskService(pool,f.identity,new TaskService(pool,f.identity)).create(f.actor,{requestId:randomUUID(),reference:duplicate.ref,goal:'重复记录上已存在的独立工作'})
  else await new BusinessObjectWorkLinkService(pool,f.identity,{authorizeSession:async()=>{}}).link(f.actor,{requestId:randomUUID(),reference:duplicate.ref,sessionId:randomUUID(),title:'独立成果入口'})
  const before=await f.rows(),tracking=await f.tracking();f.setPages([[{id:'A',value:'后续来源',updatedAt:T3}]])
  assert.equal((await f.run(duplicate.mapping.id,f.build())).error?.code,'teloa/source-conflict');assert.deepEqual(await f.rows(),before);assert.deepEqual(await f.tracking(),tracking)
  assert.equal((await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rowCount,0)
 }
})

test('迁移无来源时间则完整回滚，可信同口径旧时间跨新映射仍不倒退',async()=>{
 const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧原件',updatedAt:T1}]]);await f.run();await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner]);const before=await f.rows(),tracking=await f.tracking()
 await f.rebind!('missing-time-migration');f.setPages([[{id:'A',value:'无时间新值'}]])
 assert.equal((await f.run('missing-time-migration',f.build())).error?.code,'teloa/source-conflict');assert.deepEqual(await f.rows(),before);assert.deepEqual(await f.tracking(),tracking);assert.equal((await pool.query('select * from teloa_business_sync_mapping_migrations where owner_id=$1',[f.owner])).rowCount,0)
 const trusted=await fixture({persist:true});trusted.setPages([[{id:'A',value:'可信T3',updatedAt:T3}]]);await trusted.run();const original=await trusted.rows();await trusted.rebind!('trusted-time-migration');trusted.setPages([[{id:'A',value:'迟到T2',updatedAt:T2}]])
 const result=await trusted.run('trusted-time-migration',trusted.build());assert.equal(result.status,'ok');assert.equal(result.upserted,0);assert.deepEqual(await trusted.rows(),original);assert.equal((await trusted.tracking())[0].source_cursor,T3)
})

test('结构化员工成果正式ingestTaskResult保存字符串对象ID和固定引用，同轮幂等与权限不退化',async()=>{
 const f=await fixture();f.setPages([[{id:'A',value:'原始事实',updatedAt:T1}]]);assert.equal((await f.run()).status,'ok')
 const original=(await f.rows())[0]!,roleId=randomUUID(),type={...f.objectType,id:'order-result'}
 const mapping=readBusinessSourceMappingDefinition({...f.mapping,id:'structured-result',objectType:type.id,source:{kind:'role-result',roleId},mapping:[{path:'$.object.id',field:'id'},{path:'$.result.value',field:'value'}]})
 f.setObjectType(type);f.setMappings([mapping])
 const reference={scope:f.scope,type:'order',id:original.object_id,version:original.object_version,snapshotHash:original.snapshot_hash}
 const execution={runId:randomUUID(),taskId:randomUUID(),sessionId:randomUUID(),roleId,createdAt:CAPTURED,reference}
 const input={scope:f.scope,mappingId:mapping.id,result:{value:'结构化成果'}}
 const result=await f.service.ingestTaskResult(f.actor,input,async()=>execution);assert.deepEqual(result,{upserted:1,tombstoned:0})
 const receipt=(await pool.query('select * from teloa_business_task_result_receipts where owner_id=$1 and run_id=$2',[f.owner,execution.runId])).rows[0]
 const refs=receipt.execution.resultReferences;assert.equal(refs.length,1);assert.equal(typeof refs[0].id,'string');assert.equal(refs[0].type,type.id)
 const saved=(await pool.query('select object_id,object_version,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and object_type=$2',[f.owner,type.id])).rows
 assert.equal(saved.length,1);assert.equal(saved[0].object_id,refs[0].id);assert.equal(saved[0].snapshot_hash,refs[0].snapshotHash);assert.equal(saved[0].object_version,refs[0].version)
 assert.equal((await pool.query('select * from teloa_business_task_result_references where owner_id=$1 and run_id=$2',[f.owner,execution.runId])).rows[0].object_id,refs[0].id)
 assert.deepEqual(await f.service.ingestTaskResult(f.actor,input,async()=>execution),result);assert.equal((await f.rows()).length,2)
 await assert.rejects(f.service.ingestTaskResult(f.actor,input,async()=>({...execution,roleId:randomUUID()})),{code:'teloa/forbidden'})
 await assert.rejects(f.service.ingestTaskResult(f.actor,{...input,result:{value:'换一个成果'}},async()=>execution),{code:'teloa/conflict'})
 assert.deepEqual((await pool.query('select object_id,object_version,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and object_type=$2',[f.owner,'order'])).rows[0],original)
})


for(const empty of [false,true])test('88已持T2全局cursor仍收敛已存双活并保留水位：'+(empty?'空页':'仅newB'),async()=>{
  const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧原件',updatedAt:T1}]]);await f.run();const original=(await f.rows())[0]!
  await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
  const duplicate=await legacyDuplicate(f,'incremental-replacement',true),before=await f.rows(),fetch=f.source.fetch,cursors:Array<string|undefined>=[]
  f.source.fetch=async input=>{cursors.push(input.cursor);return fetch(input)};f.setPages([empty?[]:[{id:'B',value:'新B1',updatedAt:T1}]])
  const result=await f.run(duplicate.mapping.id,f.build());assert.equal(result.status,'ok',JSON.stringify(result));assert.deepEqual(cursors,[T2],'沿用原正式成功水位，不强制full fetch')
  const alive=currentRows(await f.rows());assert.equal(alive.length,empty?1:2,'没有再次返回A也必须收敛原双活')
  assert.equal(value(alive.find(row=>row.object_id===original.object_id)!), '已成功新来源T2')
  assert.equal((await pool.query('select cursor from teloa_business_sync_cursors where owner_id=$1 and mapping_id=$2',[f.owner,duplicate.mapping.id])).rows[0].cursor,T2)
  for(const row of before)assert.deepEqual((await f.rows()).find(next=>next.object_id===row.object_id&&next.object_version===row.object_version),row)
})

test('双活迁移先锁齐全批外部键再取quota，与另一映射B键写入无锁序倒置', {timeout:20000},async()=>{
 const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧A',updatedAt:T1}]]);await f.run();await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 const duplicate=await legacyDuplicate(f),other=readBusinessSourceMappingDefinition({...duplicate.mapping,id:'competing-source',source:{...duplicate.mapping.source,arguments:{tenant:'independent'}}})
 await f.persistMapping!(other,true);f.setPages([[{id:'A',value:'迟到A1',updatedAt:T1},{id:'B',value:'迁移B',updatedAt:T1}]])
 const label='f13-migrate-'+randomUUID(),migrationPool=new Pool({connectionString:container.getConnectionUri(),application_name:label}),otherPool=new Pool({connectionString:container.getConnectionUri(),application_name:label+'-other'})
 let release!:()=>void,quotaEntered!:()=>void;const hold=new Promise<void>(resolve=>{release=resolve}),entered=new Promise<void>(resolve=>{quotaEntered=resolve})
 const warehouse=new BusinessWarehouseService(otherPool,f.identity),realQuota=warehouse.assertQuota.bind(warehouse);let once=false
 warehouse.assertQuota=async(db,owner,scope,incoming)=>{if(incoming&&!once){once=true;quotaEntered();await hold}await realQuota(db,owner,scope,incoming)}
 const bindingKey=f.source.bindingKey;assert.ok(bindingKey)
 const competing=new BusinessSyncService(otherPool,f.identity,f.definitions,warehouse,async()=>({key:f.source.key,bindingKey,fetch:async()=>({items:[{id:'B',value:'另一来源B',updatedAt:T1}],capturedAt:CAPTURED})}))
 const migrating=new BusinessSyncService(migrationPool,f.identity,f.definitions,new BusinessWarehouseService(migrationPool,f.identity),async()=>f.source)
 let a:Promise<unknown>|undefined,b:Promise<unknown>|undefined
 try{
  b=competing.run(f.actor,{scope:f.scope,mappingId:other.id,trigger:'manual'});await entered
  a=migrating.run(f.actor,{scope:f.scope,mappingId:duplicate.mapping.id,trigger:'manual'})
  let waiting:Record<string,unknown>|undefined
  const until=Date.now()+5000
  while(Date.now()<until){
   waiting=(await pool.query(`select a.pid,exists(select 1 from pg_locks q where q.pid=a.pid and q.locktype='advisory' and q.granted and q.classid::bigint=(hashtext('teloa.business-quota')::bigint & 4294967295) and q.objid::bigint=(hashtext($2||chr(31)||$3)::bigint & 4294967295)) quota_held
    from pg_stat_activity a join pg_locks l on l.pid=a.pid where a.application_name=$1 and l.locktype='advisory' and not l.granted and l.classid::bigint=(hashtext($4)::bigint & 4294967295) and l.objid::bigint=(hashtext('B')::bigint & 4294967295)`,[label,f.owner,f.scope,f.owner+'\u001f'+f.scope+'\u001f'+'order'])).rows[0]
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.ok(waiting,'真实PG观察到迁移事务等待另一映射持有的B键')
  release();const settled=await Promise.allSettled([a,b]);const states=settled.map(item=>item.status==='fulfilled'?{status:item.status,value:item.value}:{status:item.status,code:Reflect.get(item.reason,'code'),message:String(item.reason)})
  if(evidencePath)writeFileSync(evidencePath+'.locks.json',JSON.stringify({waiting,states})+'\n')
  assert.equal(waiting.quota_held,false,'等待B键时不可已持quota；否则另一事务B→quota构成真实死锁')
  assert.ok(states.every(item=>item.status==='fulfilled'&&(item.value as {status:string}).status==='ok'),JSON.stringify(states))
 }finally{release();await Promise.allSettled([a,b].filter(Boolean));await migrationPool.end();await otherPool.end()}
})


test('整批迁移等待C来源head时尚未持quota，正常ingestTaskResult与迁移首次均可完成', {timeout:20000},async()=>{
 const f=await fixture({persist:true});f.setPages([[{id:'A',value:'旧A',updatedAt:T1},{id:'C',value:'旧C',updatedAt:T1}]]);await f.run()
 const originalC=(await f.rows()).find(row=>row.object_id==='C')!;await pool.query('update teloa_business_sync_object_ids set source_cursor=null,source_cursor_basis=null where owner_id=$1',[f.owner])
 const aDuplicate=await legacyDuplicate(f);await legacyDuplicate(f,aDuplicate.mapping.id,false,'C',false)
 const roleId=randomUUID(),resultType={...f.objectType,id:'head-lock-result'},resultMapping=readBusinessSourceMappingDefinition({...f.mapping,id:'head-lock-result-map',objectType:resultType.id,source:{kind:'role-result',roleId},mapping:[{path:'$.object.id',field:'id'},{path:'$.result.value',field:'value'}]})
 const drafts=new BusinessConfigurationDraftService(pool,f.identity),store=new BusinessConfigurationStore(pool),definitions=f.definitions as BusinessDefinitionSourceReader
 assert.equal(typeof definitions.forConfigurationCandidate,'function')
 const configuration=new BusinessConfigurationService(pool,f.identity,{drafts,store,definitions,runtime:new BusinessRuntimeService(pool,f.identity),spaces:new BusinessSpaceService(pool,f.identity)}),preview=new BusinessConfigurationPreviewService(pool,drafts,definitions,f.identity)
 let draft=await drafts.begin(f.actor,{requestId:randomUUID(),scope:f.scope});draft=await drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:resultType},{kind:'source-mapping',definition:resultMapping}]}})
 await configuration.apply(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:(await preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision})).receipt})
 f.setPages([[{id:'A',value:'迟到A',updatedAt:T1},{id:'C',value:'迟到C',updatedAt:T1}]])
 const label='f13-head-lock-'+randomUUID(),migrationPool=new Pool({connectionString:container.getConnectionUri(),application_name:label}),ingestPool=new Pool({connectionString:container.getConnectionUri(),application_name:label+'-ingest'})
 let release!:()=>void,entered!:()=>void,sourcePid:number|undefined;const hold=new Promise<void>(resolve=>{release=resolve}),ready=new Promise<void>(resolve=>{entered=resolve})
 const warehouse=new BusinessWarehouseService(ingestPool,f.identity),realQuota=warehouse.assertQuota.bind(warehouse);let once=false
 warehouse.assertQuota=async(db,owner,scope,incoming)=>{if(incoming&&!once){once=true;sourcePid=(await db.query('select pg_backend_pid() pid')).rows[0].pid;entered();await hold}await realQuota(db,owner,scope,incoming)}
 const migrationWarehouse=new BusinessWarehouseService(migrationPool,f.identity),migrationQuota=migrationWarehouse.assertQuota.bind(migrationWarehouse);let migrationQuotaChecks=0
 migrationWarehouse.assertQuota=async(db,owner,scope,incoming)=>{migrationQuotaChecks++;await migrationQuota(db,owner,scope,incoming)}
 const ingester=new BusinessSyncService(ingestPool,f.identity,f.definitions,warehouse,async()=>f.source),migrator=new BusinessSyncService(migrationPool,f.identity,f.definitions,migrationWarehouse,async()=>f.source)
 const reference={scope:f.scope,type:'order',id:'C',version:originalC.object_version,snapshotHash:originalC.snapshot_hash},execution={runId:randomUUID(),taskId:randomUUID(),sessionId:randomUUID(),roleId,createdAt:CAPTURED,reference}
 let migration:Promise<unknown>|undefined,ingest:Promise<unknown>|undefined
 try{
  ingest=ingester.ingestTaskResult(f.actor,{scope:f.scope,mappingId:resultMapping.id,result:{value:'原C固定事实的成果'}},async()=>execution);await ready
  migration=migrator.run(f.actor,{scope:f.scope,mappingId:aDuplicate.mapping.id,trigger:'manual'})
  let waiting:Record<string,unknown>|undefined;const until=Date.now()+5000
  while(Date.now()<until){
   waiting=(await pool.query(`select a.pid,pg_blocking_pids(a.pid) blockers,a.wait_event,position('teloa_business_object_snapshots' in a.query)>0 snapshot_head_wait,exists(select 1 from pg_locks q where q.pid=a.pid and q.locktype='advisory' and q.granted and q.classid::bigint=(hashtext('teloa.business-quota')::bigint & 4294967295) and q.objid::bigint=(hashtext($2||chr(31)||$3)::bigint & 4294967295)) quota_held from pg_stat_activity a where a.application_name=$1 and $4=any(pg_blocking_pids(a.pid))`,[label,f.owner,f.scope,sourcePid])).rows[0]
   if(waiting)break;await new Promise(resolve=>setTimeout(resolve,10))
  }
  assert.ok(waiting,'正常ingest持C来源FOR SHARE时，真实迁移在C快照FOR UPDATE等待')
  release();const settled=await Promise.allSettled([migration,ingest]),states=settled.map(item=>item.status==='fulfilled'?{status:item.status,value:item.value}:{status:item.status,code:Reflect.get(item.reason,'code'),message:String(item.reason)})
  if(evidencePath)writeFileSync(evidencePath+'.heads.json',JSON.stringify({sourcePid,waiting,states})+'\n')
  assert.equal(waiting.snapshot_head_wait,true);assert.equal(waiting.quota_held,false,'等待C来源head时不能先持scope quota，否则与ingest形成锁环')
  assert.equal(settled[0]!.status,'fulfilled');assert.equal((settled[0] as PromiseFulfilledResult<{status:string}>).value.status,'ok',JSON.stringify(states))
  assert.equal(settled[1]!.status,'fulfilled');assert.deepEqual((settled[1] as PromiseFulfilledResult<unknown>).value,{upserted:1,tombstoned:0})
  assert.equal(migrationQuotaChecks,1,'整批迁移及普通版本合计只核一次quota')
  const receipt=(await pool.query('select execution from teloa_business_task_result_receipts where owner_id=$1 and run_id=$2',[f.owner,execution.runId])).rows[0].execution
  assert.deepEqual(receipt.reference,reference,'正常结构化成果仍固定真实原C版本，不偷换迁移后的新正文');assert.equal(typeof receipt.resultReferences[0].id,'string')
  assert.equal(currentRows((await f.rows()).filter(row=>row.snapshot.fields.some(field=>field.value==='已成功新来源T2'))).length,2)
 }finally{release();await Promise.allSettled([migration,ingest].filter(Boolean));await migrationPool.end();await ingestPool.end()}
})
