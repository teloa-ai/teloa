import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {WorkError,readBusinessSourceMappingDefinition,type BusinessObjectTypeDefinition,type BusinessSourceMappingDefinition} from '@teloa/contract'
import {initializeBusinessData,businessObjectSnapshotHash,readBusinessObjectSnapshot,type BusinessDataQuery,type BusinessDataSourcePort} from '../src/work/business-data.ts'
import {BusinessWarehouseService,currentVersionSubquery,initializeBusinessWarehouse} from '../src/work/business-warehouse.ts'
import {initializeBusinessRecords} from '../src/work/business-records.ts'
import {initializeBusinessDefinitions} from '../src/work/business-definition-local.ts'
import type {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessRuntimeService,initializeBusinessRuntime,lockBusinessRuntime} from '../src/work/business-runtime.ts'
import {initializeBusinessSyncRules} from '../src/work/business-sync-rules.ts'
import {initializeBusinessSpaces,BusinessSpaceService} from '../src/work/business-spaces.ts'
import {BusinessSyncService,initializeBusinessSync,mapSourceItem,type BusinessSyncActor} from '../src/work/business-sync.ts'
import {businessDataPortSyncSource,type BusinessSyncFetchInput,type BusinessSyncFetchPage,type BusinessSyncSourcePort} from '../src/work/business-sync-sources.ts'

/** 同步器真库验收：映射、游标、tombstone、退避、并发锁、配额、原样路径版本规则、到期判定、权限。 */

let container:StartedPostgreSqlContainer,pool:Pool
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessData(pool)
 await initializeBusinessRecords(pool)
 await initializeBusinessWarehouse(pool)
 await initializeBusinessDefinitions(pool)
 await initializeBusinessSync(pool)
 await initializeBusinessSync(pool)
 await initializeBusinessSpaces(pool)
 await initializeBusinessSyncRules(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const CAPTURED='2026-09-25T11:59:00.000Z'
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms))

const alertType:BusinessObjectTypeDefinition={format:'teloa.business-object-type/v1',id:'soc-alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'告警',sourceId:'security-alert-http',fields:[
 {name:'id',label:'告警编号',type:'text',required:true,from:'告警编号'},
 {name:'severity',label:'严重度',type:'text',required:true,from:'严重度'},
 {name:'host',label:'主机',type:'text',required:false,from:'主机'},
 {name:'updated',label:'更新时间',type:'text',required:false,from:'更新时间'},
]}
function mappingOf(overrides:Record<string,unknown>={}):BusinessSourceMappingDefinition{
 return readBusinessSourceMappingDefinition({
  format:'teloa.business-source-mapping/v1',id:'soc-sync',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',
  source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{},itemsPath:'$.items[*]'},
  mapping:[{path:'$.alert_id',field:'id'},{path:'$.sev',field:'severity'},{path:'$.meta.host',field:'host'},{path:'$.updated_at',field:'updated'}],
  primaryKey:['id'],incrementalCursor:{path:'$.updated_at',kind:'timestamp'},
  deletionSemantics:'tombstone',deletedAtPath:'$.deleted_at',
  schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false,
  ...overrides,
 })
}
const compareMapping=(id='soc-compare')=>{const value:Record<string,unknown>={...mappingOf({id}),deletionSemantics:'compare'};delete value.deletedAtPath;delete value.incrementalCursor;return readBusinessSourceMappingDefinition(value)}
const rawMapping=()=>readBusinessSourceMappingDefinition({format:'teloa.business-source-mapping/v1',id:'soc-port',version:'1.0.0',domain:'SOC',title:'端口原样',objectType:'soc-alert',source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[],primaryKey:['id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false})

const record=(definition:unknown)=>({source:{loadId:'load-1',scope:'SOC',localId:(definition as {id:string}).id,version:'1.0.0',contentHash:'c',fileHash:'f',definitionHash:'a'.repeat(64),origin:'local'},definition})
function definitionsOf(mappings:BusinessSourceMappingDefinition[]):Pick<BusinessDefinitionSourceReader,'forScope'>{
 return {forScope:async(_db:PoolClient,_owner:string,scope:string)=>scope!=='SOC'?[]:[{origin:{kind:'market',loadId:'load-1'},scope:'SOC',domain:'SOC',objectTypes:[record(alertType)],views:[],actions:[],mappings:mappings.map(record),widgets:[],dashboards:[],sources:new Map()}] as never}
}

/** 按页脚本返回的同步源：pageToken 以 page: 开头即续页，否则从第一页起；`cursors` 记端口视角的游标（续页标记优先，否则水位）。 */
class ScriptSource implements BusinessSyncSourcePort{
 readonly key:string
 constructor(key='soc/list_alerts'){this.key=key}
 calls=0
 cursors:Array<string|undefined>=[]
 pages:unknown[][]=[]
 fail=false
 delay=0
 async fetch(input:BusinessSyncFetchInput):Promise<BusinessSyncFetchPage>{
  this.calls+=1;this.cursors.push(input.pageToken??input.cursor)
  if(this.delay)await sleep(this.delay)
  if(this.fail)throw new WorkError('teloa/source-unavailable','数据源暂不可读。')
  const index=input.pageToken?.startsWith('page:')?Number(input.pageToken.slice(5)):0
  return {items:this.pages[index]!,capturedAt:CAPTURED,...(index+1<this.pages.length?{nextCursor:'page:'+(index+1)}:{})}
 }
}

function harness(mappings:BusinessSourceMappingDefinition[],sources:Record<string,BusinessSyncSourcePort>,options:{pool?:Pool}={}){
 const owner='sync:'+randomUUID(),actor:BusinessSyncActor={ownerId:owner,scopeIds:['SOC']}
 const clock={now:'2026-09-25T12:00:00.000Z'}
 const identity={id:randomUUID,now:()=>clock.now}
 const warehouse=new BusinessWarehouseService(options.pool??pool,identity)
 const service=new BusinessSyncService(options.pool??pool,identity,definitionsOf(mappings),warehouse,async mapping=>sources[mapping.id]!)
 const run=(mappingId:string)=>service.run(actor,{scope:'SOC',mappingId,trigger:'manual'})
 const cursor=async(mappingId:string)=>(await pool.query('select * from teloa_business_sync_cursors where owner_id=$1 and scope_id=$2 and mapping_id=$3',[owner,'SOC',mappingId])).rows[0] as Record<string,unknown>|undefined
 const versions=async(objectId:string)=>(await pool.query('select object_version,snapshot,snapshot_hash from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_id=$3 order by object_version',[owner,'SOC',objectId])).rows as Array<{object_version:number;snapshot:Record<string,unknown>;snapshot_hash:string}>
 const current=async()=>(await pool.query(`select object_id from ${currentVersionSubquery(false)} s order by object_id`,[owner,'SOC','soc-alert'])).rows.map(row=>row.object_id as string)
 return {owner,actor,clock,service,run,cursor,versions,current}
}

const item=(id:string,updated:string,extra:Record<string,unknown>={})=>({alert_id:id,sev:'高',meta:{host:'h-'+id},updated_at:updated,...extra})

test('mapSourceItem：路径取值、主键缺失跳过、删除标记、数值转文本、嵌套路径',()=>{
 const mapping=mappingOf()
 const mapped=mapSourceItem(mapping,alertType,{alert_id:42,sev:'高',meta:{host:'db-1'},updated_at:'2026-09-25T10:00:00.000Z'},CAPTURED)
 assert.ok(!('skipped' in mapped))
 assert.equal(mapped.deleted,false)
 assert.equal(mapped.snapshot.id,'42')
 assert.deepEqual(mapped.snapshot.fields,[{label:'告警编号',value:'42'},{label:'严重度',value:'高'},{label:'主机',value:'db-1'},{label:'更新时间',value:'2026-09-25T10:00:00.000Z'}])
 assert.equal(mapped.snapshot.observedAt,CAPTURED,'observedAt 缺省取 capturedAt')
 assert.equal(mapped.snapshot.receivedAt,CAPTURED)
 assert.equal(mapped.snapshot.quality,'complete')
 assert.equal(mapped.snapshot.scope,'SOC')
 assert.equal(mapped.snapshot.type,'soc-alert')
 // 映射出来的快照补上版本号即过同一个读取器。
 readBusinessObjectSnapshot({...mapped.snapshot,version:1},'SOC')
 assert.deepEqual(mapSourceItem(mapping,alertType,{sev:'高'},CAPTURED),{skipped:'missing-primary-key'})
 assert.deepEqual(mapSourceItem(mapping,alertType,'text',CAPTURED),{skipped:'not-object'})
 const deleted=mapSourceItem(mapping,alertType,{alert_id:'a',sev:'低',deleted_at:'2026-09-25T11:00:00.000Z'},CAPTURED)
 assert.ok(!('skipped' in deleted)&&deleted.deleted)
 const missing=mapSourceItem(mapping,alertType,{alert_id:'b'},CAPTURED)
 assert.ok(!('skipped' in missing)&&missing.snapshot.quality==='missing'&&missing.deleted===false)
 const multi=mapSourceItem(mappingOf({primaryKey:['id','host']}),alertType,{alert_id:'a',meta:{host:'x'}},CAPTURED)
 assert.ok(!('skipped' in multi)&&/^[a-f0-9]{32}$/.test(multi.snapshot.id),'多键拼接后取 sha256 前 32 位')
})

test('run：两页三条全量写入并记游标；再跑去重；一条变化只写一版',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 source.pages=[[item('a1','2026-09-25T10:00:00.000Z'),item('a2','2026-09-25T10:01:00.000Z')],[item('a3','2026-09-25T10:02:00.000Z')]]
 const first=await h.run('soc-sync')
 assert.deepEqual([first.status,first.fetched,first.upserted,first.tombstoned,first.trigger],['ok',3,3,0,'manual'])
 assert.equal(first.nextCursor,'2026-09-25T10:02:00.000Z')
 assert.equal((await h.cursor('soc-sync'))!.cursor,'2026-09-25T10:02:00.000Z')
 assert.deepEqual(source.cursors,[undefined,'page:1'])
 const second=await h.run('soc-sync')
 assert.deepEqual([second.status,second.fetched,second.upserted],['ok',3,0])
 assert.equal(source.cursors[2],'2026-09-25T10:02:00.000Z','增量模式首页带上次水位')
 source.pages=[[item('a1','2026-09-25T10:00:00.000Z'),item('a2','2026-09-25T10:05:00.000Z')],[item('a3','2026-09-25T10:02:00.000Z')]]
 const third=await h.run('soc-sync')
 assert.deepEqual([third.status,third.upserted],['ok',1])
 assert.deepEqual((await h.versions('a2')).map(row=>row.object_version),[1,2])
 for(const row of await h.versions('a2'))assert.equal(businessObjectSnapshotHash(readBusinessObjectSnapshot(row.snapshot,'SOC')),row.snapshot_hash)
 const listed=await h.service.runs(h.actor,{scope:'SOC',mappingId:'soc-sync',limit:10})
 assert.equal(listed.length,3)
})

test('tombstone：源给删除时刻即写 tombstone；compare 全量缺席也写',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 source.pages=[[item('t1','2026-09-25T10:00:00.000Z'),item('t2','2026-09-25T10:00:00.000Z')]]
 await h.run('soc-sync')
 source.pages=[[item('t1','2026-09-25T10:03:00.000Z',{deleted_at:'2026-09-25T10:03:00.000Z'})]]
 const deleted=await h.run('soc-sync')
 assert.deepEqual([deleted.status,deleted.tombstoned,deleted.upserted],['ok',1,0])
 assert.deepEqual(await h.current(),['t2'])
 assert.equal((await h.versions('t1')).at(-1)!.snapshot.deletedAt,'2026-09-25T12:00:00.000Z')

 const full=new ScriptSource(),c=harness([compareMapping()],{'soc-compare':full})
 full.pages=[[item('c1','x'),item('c2','x')],[item('c3','x')]]
 assert.equal((await c.run('soc-compare')).upserted,3)
 full.pages=[[item('c1','x')],[item('c3','x')]]
 const compared=await c.run('soc-compare')
 assert.deepEqual([compared.status,compared.tombstoned,compared.upserted],['ok',1,0])
 assert.deepEqual(await c.current(),['c1','c3'])
 assert.equal((await c.run('soc-compare')).tombstoned,0,'已 tombstone 的不再写')
})

test('失败退避：失败记 failed 并退避，退避内 throttled 且不调源，连续三次 240 秒，成功归零',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 source.fail=true
 const failed=await h.run('soc-sync')
 assert.equal(failed.status,'failed')
 assert.deepEqual(failed.error,{code:'teloa/source-unavailable',reason:'数据源暂不可读。'})
 let state=(await h.cursor('soc-sync'))!
 assert.equal(state.consecutive_failures,1)
 assert.equal((state.backoff_until as Date).toISOString(),'2026-09-25T12:01:00.000Z')
 const calls=source.calls
 const throttled=await h.run('soc-sync')
 assert.equal(throttled.status,'throttled')
 assert.equal(source.calls,calls,'退避期内不调源')
 h.clock.now='2026-09-25T12:01:01.000Z';await h.run('soc-sync')
 h.clock.now='2026-09-25T12:03:02.000Z';await h.run('soc-sync')
 state=(await h.cursor('soc-sync'))!
 assert.equal(state.consecutive_failures,3)
 assert.equal((state.backoff_until as Date).toISOString(),'2026-09-25T12:07:02.000Z')
 source.fail=false;source.pages=[[item('b1','2026-09-25T10:00:00.000Z')]]
 h.clock.now='2026-09-25T12:08:00.000Z'
 assert.equal((await h.run('soc-sync')).status,'ok')
 state=(await h.cursor('soc-sync'))!
 assert.deepEqual([state.consecutive_failures,state.backoff_until],[0,null])
 assert.equal((state.last_ok_at as Date).toISOString(),'2026-09-25T12:08:00.000Z')
 const status=(await h.service.status(h.actor,'SOC'))[0]!
 assert.deepEqual([status.mappingId,status.consecutiveFailures,status.lastRun?.status,status.nextRunAt],['soc-sync',0,'ok','2026-09-25T12:09:00.000Z'])
 assert.equal(status.quota.limit,500_000)
})

test('并发：同映射一个 ok 一个立刻 throttled；不同映射互不影响',async()=>{
 const slow=new ScriptSource(),other=new ScriptSource()
 slow.delay=500;slow.pages=[[item('p1','2026-09-25T10:00:00.000Z')]]
 other.delay=200;other.pages=[[item('q1','2026-09-25T10:00:00.000Z')]]
 const h=harness([mappingOf(),compareMapping('soc-other')],{'soc-sync':slow,'soc-other':other})
 const first=h.run('soc-sync')
 while(slow.calls===0)await sleep(5)
 const started=Date.now(),second=await h.run('soc-sync'),elapsed=Date.now()-started
 assert.equal(second.status,'throttled')
 assert.ok(elapsed<100,'第二个不排队，'+elapsed+'ms 内返回')
 assert.equal(second.error?.code,'teloa/conflict')
 const [a,b]=await Promise.all([first,h.run('soc-other')])
 assert.deepEqual([a.status,b.status],['ok','ok'])
 assert.equal(slow.calls,1)
})

test('远端拉取在事务外：拉取期间同步连接不在事务中、映射锁仍持有；结束后解锁',async()=>{
 const slow=new ScriptSource();slow.delay=400;slow.pages=[[item('t1','2026-09-25T10:00:00.000Z')]]
 const h=harness([mappingOf()],{'soc-sync':slow})
 const held=async()=>(await pool.query(`select exists(select 1 from pg_locks where locktype='advisory' and classid=hashtext($1)::oid and objid=hashtext($2)::oid and objsubid=2 and granted) as held`,[h.owner,'SOC\u001fsoc-sync'])).rows[0].held as boolean
 const first=h.run('soc-sync')
 while(slow.calls===0)await sleep(5)
 const inTransaction=(await pool.query(`select count(*)::int as n from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() and state like 'idle in transaction%'`)).rows[0].n
 assert.equal(inTransaction,0,'拉取期间不应有打开的事务')
 assert.equal(await held(),true,'拉取期间映射锁仍在')
 assert.equal((await first).status,'ok')
 assert.equal(await held(),false,'结束后解锁')
 assert.deepEqual(await h.current(),['t1'])
})

test('配额：逼近上限整批回滚、记 failed、只查一次 count(*)',async()=>{
 const source=new ScriptSource()
 source.pages=[[item('q1','x'),item('q2','x'),item('q3','x')]]
 let counts=0
 const spy=new Proxy(pool,{get(target,key){
  if(key!=='connect')return Reflect.get(target,key)
  // 连接会回到池里被别处复用：release 时还原 query，计数只落在本次同步用过的连接上。
  // pool.query 内部走回调式 connect(cb)（提交后的记录清理用它）：原样转给真池，不计数。
  return async(...args:unknown[])=>{if(args.length)return Reflect.apply(target.connect,target,args);const db=await target.connect(),original=db.query,release=db.release,query=original.bind(db) as (...args:unknown[])=>unknown
   db.query=((...args:unknown[])=>{if(typeof args[0]==='string'&&args[0].includes('count(*)'))counts+=1;return query(...args)}) as PoolClient['query']
   db.release=((...args:Parameters<PoolClient['release']>)=>{db.query=original;db.release=release;return release.apply(db,args)}) as PoolClient['release'];return db}
 }})
 const h=harness([mappingOf()],{'soc-sync':source},{pool:spy})
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   select $1,'SOC','filler','f'||n,1,repeat('a',64),'{}'::jsonb,'x',now() from generate_series(1,499999) n`,[h.owner])
 const run=await h.run('soc-sync')
 assert.equal(run.status,'failed')
 assert.equal(run.error?.code,'teloa/invalid-input')
 assert.match(run.error!.reason,/500 000/)
 assert.equal(Number((await pool.query(`select count(*) as n from teloa_business_object_snapshots where owner_id=$1 and object_type='soc-alert'`,[h.owner])).rows[0].n),0)
 assert.equal(counts,1)
 await pool.query('delete from teloa_business_object_snapshots where owner_id=$1',[h.owner])
})

test('原样路径：端口是版本权威；改写既有版本即 source-conflict；compare tombstone 取 max+1；复活再 max+1',async()=>{
 const snapshot=(id:string,version:number,severity='高')=>({scope:'SOC',type:'soc-alert',id,version,title:'告警 '+id,source:'EDR',observedAt:'2026-09-25T10:00:00.000Z',receivedAt:'2026-09-25T10:00:01.000Z',quality:'complete',summary:'摘要',fields:[{label:'严重度',value:severity}]})
 let items:unknown[]=[]
 const port:BusinessDataSourcePort={id:'security-alert-http',scopes:['SOC'],async query(input:BusinessDataQuery){return {schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:input.scope,capturedAt:CAPTURED,items}}}
 const h=harness([rawMapping()],{'soc-port':businessDataPortSyncSource(port)})
 items=[snapshot('x',3),snapshot('y',1)]
 const first=await h.run('soc-port')
 assert.deepEqual([first.status,first.upserted],['ok',2])
 assert.deepEqual((await h.versions('x')).map(row=>row.object_version),[3])
 for(const row of await h.versions('x'))readBusinessObjectSnapshot(row.snapshot,'SOC')
 assert.equal((await h.run('soc-port')).upserted,0,'同版本同摘要去重')
 const okAt=(await h.cursor('soc-port'))!.last_ok_at
 items=[snapshot('x',3,'低'),snapshot('y',2)]
 h.clock.now='2026-09-25T12:05:00.000Z'
 const conflict=await h.run('soc-port')
 assert.equal(conflict.status,'failed')
 assert.equal(conflict.error?.code,'teloa/source-conflict')
 assert.deepEqual((await h.versions('y')).map(row=>row.object_version),[1],'整批回滚')
 assert.deepEqual((await h.cursor('soc-port'))!.last_ok_at,okAt,'不推进')
 items=[snapshot('y',1)]
 h.clock.now='2026-09-25T12:10:00.000Z'
 const gone=await h.run('soc-port')
 assert.deepEqual([gone.status,gone.tombstoned],['ok',1])
 assert.deepEqual((await h.versions('x')).map(row=>row.object_version),[3,4])
 items=[snapshot('x',3),snapshot('y',1)]
 const back=await h.run('soc-port')
 assert.deepEqual([back.status,back.upserted],['ok',1])
 const revived=await h.versions('x')
 assert.deepEqual(revived.map(row=>row.object_version),[3,4,5])
 assert.equal(revived.at(-1)!.snapshot.version,5)
 assert.equal(revived.at(-1)!.snapshot.deletedAt,undefined)
 assert.equal((await h.run('soc-port')).upserted,0,'复活之后同内容去重')
 // 页壳不合约定：不写、记 failed。
 items=[{...snapshot('z',1),deletedAt:'2026-09-25T10:00:00.000Z'}]
 assert.equal((await h.run('soc-port')).error?.code,'teloa/source-unavailable')
})

/** 受管 MCP 工具式的同步源：水位（cursor）与续页（pageToken）分开收，按 pageToken 翻页；pageTokens 可脚本化游标重复。 */
class McpLikeSource implements BusinessSyncSourcePort{
 readonly key='soc/list_alerts'
 calls:Array<{cursor?:string;pageToken?:string}>=[]
 pages:unknown[][]=[]
 tokens:string[]=[]
 async fetch(input:BusinessSyncFetchInput):Promise<BusinessSyncFetchPage>{
  this.calls.push({...(input.cursor===undefined?{}:{cursor:input.cursor}),...(input.pageToken===undefined?{}:{pageToken:input.pageToken})})
  const index=input.pageToken===undefined?0:this.tokens.indexOf(input.pageToken)+1
  return {items:this.pages[index]!,capturedAt:CAPTURED,...(index<this.tokens.length?{nextCursor:this.tokens[index]!}:{})}
 }
}

test('受管 MCP 工具式分页：三页共 120 条（pageSize 50）一次同步全部落库；每页都带水位、续页另带 pageToken',async()=>{
 const source=new McpLikeSource(),h=harness([mappingOf({pageSize:50})],{'soc-sync':source})
 const minute=(n:number)=>'2026-09-25T10:'+String(Math.floor(n/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0')+'.000Z'
 const all=Array.from({length:120},(_value,index)=>item('m'+index,minute(index)))
 source.pages=[all.slice(0,50),all.slice(50,100),all.slice(100)]
 source.tokens=['p2','p3']
 const first=await h.run('soc-sync')
 assert.deepEqual([first.status,first.fetched,first.upserted],['ok',120,120])
 assert.equal((await h.current()).length,120)
 assert.deepEqual(source.calls,[{},{pageToken:'p2'},{pageToken:'p3'}],'首页不带续页标记；无水位时不带 cursor')
 source.calls=[]
 const second=await h.run('soc-sync')
 assert.deepEqual([second.status,second.fetched,second.upserted],['ok',120,0])
 const mark=minute(119)
 assert.deepEqual(source.calls,[{cursor:mark},{cursor:mark,pageToken:'p2'},{cursor:mark,pageToken:'p3'}],'水位每页都带，续页标记与水位分开')
})

test('受管 MCP 工具式分页：游标重复（与上一个 pageToken 相同或在本链出现过）即「分页游标没有前进」且未写入',async()=>{
 for(const tokens of [['p2','p2'],['p2','p3','p2']]){
  const source=new McpLikeSource(),h=harness([mappingOf()],{'soc-sync':source})
  source.pages=tokens.map((_token,index)=>[item('r'+index,'2026-09-25T10:00:00.000Z')]).concat([[item('last','2026-09-25T10:00:00.000Z')]])
  source.tokens=tokens
  const run=await h.run('soc-sync')
  assert.equal(run.status,'failed')
  assert.deepEqual(run.error,{code:'teloa/source-unavailable',reason:'数据源分页游标没有前进；未写入。'})
  assert.deepEqual(await h.current(),[],'整次未写入：'+tokens.join('→'))
 }
})

test('业务数据端口来源：续页行为与一期相同——端口只收一个 cursor，首页为水位、续页为端口回包的 nextCursor',async()=>{
 const seen:Array<string|undefined>=[]
 const pages=[[item('d1','2026-09-25T10:00:00.000Z'),item('d2','2026-09-25T10:01:00.000Z')],[item('d3','2026-09-25T10:02:00.000Z')]]
 const port:BusinessDataSourcePort={id:'security-alert-http',scopes:['SOC'],async query(input:BusinessDataQuery){
  seen.push(input.cursor)
  const index=input.cursor==='page:1'?1:0
  return {schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:input.scope,capturedAt:CAPTURED,items:pages[index]!,...(index===0?{nextCursor:'page:1'}:{})}
 }}
 const h=harness([mappingOf({id:'soc-port-mapped',source:{kind:'business-data-port',sourceId:'security-alert-http'}})],{'soc-port-mapped':businessDataPortSyncSource(port)})
 const first=await h.run('soc-port-mapped')
 assert.deepEqual([first.status,first.fetched,first.upserted],['ok',3,3])
 const second=await h.run('soc-port-mapped')
 assert.deepEqual([second.status,second.fetched,second.upserted],['ok',3,0])
 assert.deepEqual(seen,[undefined,'page:1','2026-09-25T10:02:00.000Z','page:1'],'端口看到的 cursor 序列与一期逐字相同')
})

test('映射改版：只有来源与 incrementalCursor 都没变才沿用上次水位；去掉或改了 incrementalCursor 即不带水位从头拉，成功后按新声明记水位',async()=>{
 const source=new ScriptSource(),mappings=[mappingOf()],h=harness(mappings,{'soc-sync':source})
 source.pages=[[item('v1','2026-09-25T10:00:00.000Z')]]
 await h.run('soc-sync')
 assert.equal((await h.cursor('soc-sync'))!.cursor,'2026-09-25T10:00:00.000Z')
 // 只改标题与版本：水位照旧沿用。
 mappings[0]=mappingOf({version:'1.0.1',title:'告警同步（改名）'})
 await h.run('soc-sync')
 assert.equal(source.cursors.at(-1),'2026-09-25T10:00:00.000Z')
 // 改了增量游标的种类：旧水位按旧口径算出，不再沿用。
 mappings[0]=mappingOf({version:'1.1.0',incrementalCursor:{path:'$.updated_at',kind:'sequence'}})
 const changed=await h.run('soc-sync')
 assert.equal(changed.status,'ok')
 assert.equal(source.cursors.at(-1),undefined,'改了 incrementalCursor 的首页不带旧水位')
 // 去掉增量游标（全量 + compare）：旧水位一概不带，失败了下次也不会再带。
 const full={...mappingOf({version:'2.0.0'}),deletionSemantics:'compare'} as Record<string,unknown>
 delete full.incrementalCursor;delete full.deletedAtPath
 mappings[0]=readBusinessSourceMappingDefinition(full)
 await pool.query('update teloa_business_sync_cursors set cursor=$2 where owner_id=$1',[h.owner,'stale-watermark'])
 source.fail=true
 assert.equal((await h.run('soc-sync')).status,'failed')
 assert.equal(source.cursors.at(-1),undefined)
 source.fail=false
 await pool.query('update teloa_business_sync_cursors set backoff_until=null where owner_id=$1',[h.owner])
 const ok=await h.run('soc-sync')
 assert.deepEqual([ok.status,ok.fetched],['ok',1])
 assert.equal(source.cursors.at(-1),undefined)
 assert.equal((await h.cursor('soc-sync'))!.cursor,null,'全量映射成功后不留水位')
})

test('业务数据端口首页就回 nextCursor===水位：直接报「分页游标没有前进」，端口只调一次',async()=>{
 const cursors:Array<string|undefined>=[]
 const port:BusinessDataSourcePort={id:'security-alert-http',scopes:['SOC'],async query(input:BusinessDataQuery){
  cursors.push(input.cursor)
  return {schema:'teloa.data-source-page/v1',sourceId:'security-alert-http',scope:input.scope,capturedAt:CAPTURED,items:[item('w1','2026-09-25T10:00:00.000Z')],...(input.cursor===undefined?{}:{nextCursor:input.cursor})}
 }}
 const h=harness([mappingOf({id:'soc-port-stuck',source:{kind:'business-data-port',sourceId:'security-alert-http'}})],{'soc-port-stuck':businessDataPortSyncSource(port)})
 assert.equal((await h.run('soc-port-stuck')).status,'ok')
 const stuck=await h.run('soc-port-stuck')
 assert.deepEqual(stuck.error,{code:'teloa/source-unavailable',reason:'数据源分页游标没有前进；未写入。'})
 assert.deepEqual(cursors,[undefined,'2026-09-25T10:00:00.000Z'],'第二次同步首页即判出，不再多调一次端口')
})

test('due：周期未到、已到、退避中',async()=>{
 const h=harness([mappingOf()],{'soc-sync':new ScriptSource()})
 await new BusinessSpaceService(pool,{id:randomUUID,now:()=>CAPTURED}).ensurePersonal(h.owner)
 await pool.query(`insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-sync',1,1,now())`,[h.owner])
 const now='2026-09-25T12:00:00.000Z'
 assert.deepEqual(await h.service.due(h.owner,now),[{scope:'SOC',mappingId:'soc-sync'}],'从未成功过即到期')
 const put=(lastOk:string,backoff:string|null)=>pool.query(`insert into teloa_business_sync_cursors(owner_id,scope_id,mapping_id,cursor,consecutive_failures,backoff_until,last_ok_at,updated_at) values($1,'SOC','soc-sync',null,0,$2,$3,now())
   on conflict(owner_id,scope_id,mapping_id) do update set backoff_until=excluded.backoff_until,last_ok_at=excluded.last_ok_at`,[h.owner,backoff,lastOk])
 await put('2026-09-25T11:59:30.000Z',null)
 assert.deepEqual(await h.service.due(h.owner,now),[])
 await put('2026-09-25T11:58:30.000Z',null)
 assert.deepEqual(await h.service.due(h.owner,now),[{scope:'SOC',mappingId:'soc-sync'}])
 await put('2026-09-25T11:58:30.000Z','2026-09-25T12:00:30.000Z')
 assert.deepEqual(await h.service.due(h.owner,now),[])
})

test('权限、映射上限、ingest、坏记录',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 await assert.rejects(h.service.run({ownerId:h.owner,scopeIds:['AppSec']},{scope:'SOC',mappingId:'soc-sync',trigger:'manual'}),{code:'teloa/forbidden'})
 await assert.rejects(h.service.status({ownerId:h.owner,scopeIds:['AppSec']},'SOC'),{code:'teloa/forbidden'})
 await assert.rejects(h.service.run(h.actor,{scope:'SOC',mappingId:'soc-sync',trigger:'manual',extra:1} as never),{code:'teloa/invalid-input'})
 await assert.rejects(h.run('missing'),{code:'teloa/invalid-input'})
 assert.equal(source.calls,0)

 const many=Array.from({length:33},(_value,index)=>mappingOf({id:'m'+index}))
 const crowded=harness(many,{})
 await assert.rejects(crowded.service.mappings(crowded.actor,'SOC'),(error:WorkError)=>error.code==='teloa/invalid-input'&&/32/.test(error.message))
 assert.equal((await harness(many.slice(0,32),{}).service.mappings(crowded.actor,'SOC')).length,32)

 const role=mappingOf({id:'role-notes',source:{kind:'role-result'}}),r=harness([role,mappingOf()],{'soc-sync':source})
 const ingested=await r.service.ingest(r.actor,{scope:'SOC',mappingId:'role-notes',items:[item('r1','x'),item('r2','x'),{sev:'高'}],sourceId:'role-result:abcd1234'})
 assert.deepEqual(ingested,{upserted:2,tombstoned:0})
 assert.equal((await r.versions('r1'))[0]!.snapshot.source,'role-result')
 assert.equal((await r.service.runs(r.actor,{scope:'SOC',limit:5}))[0]!.trigger,'tool')
 await assert.rejects(r.service.ingest(r.actor,{scope:'SOC',mappingId:'soc-sync',items:[item('r3','x')],sourceId:'role-result:abcd1234'}),{code:'teloa/invalid-input'})
 await assert.rejects(r.run('role-notes'),{code:'teloa/invalid-input'})

 await pool.query(`update teloa_business_sync_runs set error_code='teloa/nope',status='failed' where owner_id=$1`,[r.owner])
 await assert.rejects(r.service.runs(r.actor,{scope:'SOC',limit:5}),{code:'teloa/storage-corrupt'})
})

test('compare 只对比本来源写入的对象；全量拉取 0 条不做缺席对比',async t=>{
 const warn=t.mock.method(console,'warn',()=>{})
 const full=new ScriptSource(),c=harness([compareMapping()],{'soc-compare':full})
 const other=readBusinessObjectSnapshot({scope:'SOC',type:'soc-alert',id:'o1',version:1,title:'告警 o1',source:'EDR',observedAt:'2026-09-25T10:00:00.000Z',receivedAt:'2026-09-25T10:00:01.000Z',quality:'complete',summary:'摘要',fields:[{label:'严重度',value:'高'}]},'SOC')
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at)
   values($1,'SOC','soc-alert','o1',1,$2,$3,'role-result:abcd1234',$4)`,[c.owner,businessObjectSnapshotHash(other),JSON.stringify(other),CAPTURED])
 full.pages=[[item('c1','x'),item('c2','x')]]
 await c.run('soc-compare')
 full.pages=[[item('c1','x')]]
 assert.equal((await c.run('soc-compare')).tombstoned,1)
 assert.deepEqual(await c.current(),['c1','o1'],'别的来源写入的对象不被本映射的缺席对比删除')
 full.pages=[[]]
 const empty=await c.run('soc-compare')
 assert.deepEqual([empty.status,empty.fetched,empty.tombstoned],['ok',0,0])
 assert.deepEqual(await c.current(),['c1','o1'],'全量 0 条不清空整类对象')
 assert.ok(warn.mock.calls.some(call=>/0 条/.test(String(call.arguments[0]))),'跳过缺席对比要记日志')
})

test('同对象类型的两个来源共享外部编号时各有稳定记录，重放和全量缺席只影响自身',async()=>{
 const mapped=new ScriptSource('crm/list_customers')
 const portItems:{value:unknown[]}={value:[]}
 const port:BusinessDataSourcePort={id:'security-alert-http',scopes:['SOC'],async query(input:BusinessDataQuery){return {schema:'teloa.data-source-page/v1',sourceId:this.id,scope:input.scope,capturedAt:CAPTURED,items:portItems.value}}}
 const crm=readBusinessSourceMappingDefinition({...compareMapping('crm-customers'),source:{kind:'mcp-tool',serverName:'crm',tool:'list_customers',arguments:{},itemsPath:'$.items[*]'}})
 const h=harness([crm,rawMapping()],{'crm-customers':mapped,'soc-port':businessDataPortSyncSource(port)})
 const external='same-123'
 const raw=(id:string)=>({scope:'SOC',type:'soc-alert',id,version:1,title:'端口 '+id,source:'端口',observedAt:'2026-09-25T10:00:00.000Z',receivedAt:'2026-09-25T10:00:01.000Z',quality:'complete',summary:'端口原文',fields:[{label:'严重度',value:'低'}]})
 mapped.pages=[[item(external,'2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('crm-customers')).upserted,1)
 const before=(await h.versions(external))[0]!
 portItems.value=[raw(external),raw('raw-survivor')]
 assert.equal((await h.run('soc-port')).upserted,2)
 const rows=async()=> (await pool.query(`select object_id,object_version,source_id,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id='SOC' and object_type='soc-alert' order by object_id,object_version`,[h.owner])).rows as Array<{object_id:string;object_version:number;source_id:string;snapshot_hash:string;snapshot:Record<string,unknown>}>
 const first=await rows(),crmRow=first.find(row=>row.source_id===mapped.key)!,rawSame=first.find(row=>row.source_id===port.id&&row.snapshot.title==='端口 '+external)!
 assert.ok(crmRow&&rawSame)
 assert.notEqual(crmRow.object_id,rawSame.object_id,'同号的第二来源须得到独立内部身份')
 assert.equal(crmRow.object_id,external,'既有来源记录 ID 与引用保持不变')
 assert.equal(rawSame.snapshot.id,rawSame.object_id,'固定快照须使用内部身份')
 assert.equal((await h.run('soc-port')).upserted,0,'相同批次重放不生成新版本')
 portItems.value=[raw('raw-survivor')]
 assert.deepEqual([(await h.run('soc-port')).tombstoned,(await h.run('soc-port')).tombstoned],[1,0])
 const after=await rows()
 assert.equal(after.find(row=>row.object_id===crmRow.object_id)!.snapshot_hash,before.snapshot_hash,'其他来源的既有固定引用保持可解析')
 assert.equal(after.filter(row=>row.object_id===rawSame.object_id).at(-1)!.snapshot.deletedAt,'2026-09-25T12:00:00.000Z')
 assert.deepEqual(after.filter(row=>row.object_id===crmRow.object_id).map(row=>row.object_version),[1])
})

test('同一 MCP 工具的不同连接参数属于不同来源，compare 不能跨映射归档',async()=>{
 const mapping=(id:string,tenant:string)=>readBusinessSourceMappingDefinition({...compareMapping(id),source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{tenant},itemsPath:'$.items[*]'}})
 const a=new ScriptSource(),b=new ScriptSource()
 const h=harness([mapping('tenant-a','A'),mapping('tenant-b','B')],{'tenant-a':a,'tenant-b':b})
 a.pages=[[item('shared','2026-09-25T10:00:00.000Z',{meta:{host:'tenant A'}})]]
 b.pages=[[item('shared','2026-09-25T10:00:00.000Z',{meta:{host:'tenant B'}})]]
 assert.equal((await h.run('tenant-a')).upserted,1)
 assert.equal((await h.run('tenant-b')).upserted,1)
 const rows=async()=> (await pool.query(`select object_id,object_version,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id='SOC' and object_type='soc-alert' order by object_id,object_version`,[h.owner])).rows as Array<{object_id:string;object_version:number;snapshot:{fields:Array<{label:string;value:string}>;deletedAt?:string}}>
 const first=await rows()
 assert.equal(new Set(first.map(row=>row.object_id)).size,2)
 const idOf=(tenant:string)=>first.find(row=>row.snapshot.fields.some(field=>field.label==='主机'&&field.value===tenant))!.object_id
 const aId=idOf('tenant A'),bId=idOf('tenant B')
 assert.notEqual(aId,bId)
 a.pages=[[item('survivor','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('tenant-a')).tombstoned,1)
 assert.equal((await h.run('tenant-b')).upserted,0)
 const after=await rows()
 assert.equal(after.filter(row=>row.object_id===aId).at(-1)!.snapshot.deletedAt,'2026-09-25T12:00:00.000Z')
 assert.deepEqual(after.filter(row=>row.object_id===bId).map(row=>row.object_version),[1])
})

test('旧未绑定的同工具快照无法证明连接参数归属，当前映射不沿用其 ID 或归档它',async()=>{
 const mapping=readBusinessSourceMappingDefinition({...compareMapping('tenant-b'),source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{tenant:'B'},itemsPath:'$.items[*]'}})
 const source=new ScriptSource(),h=harness([mapping],{'tenant-b':source})
 const legacy=readBusinessObjectSnapshot({scope:'SOC',type:'soc-alert',id:'legacy-123',version:1,title:'旧租户快照',source:source.key,observedAt:CAPTURED,receivedAt:CAPTURED,quality:'complete',summary:'旧版无参数归属绑定',fields:[{label:'主机',value:'tenant A'}]},'SOC')
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,'SOC','soc-alert',$2,1,$3,$4,$5,$6)`,[h.owner,legacy.id,businessObjectSnapshotHash(legacy),JSON.stringify(legacy),source.key,CAPTURED])
 source.pages=[[item(legacy.id,'2026-09-25T10:00:00.000Z',{meta:{host:'tenant B'}}),item('survivor','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('tenant-b')).upserted,2)
 const rows=async()=> (await pool.query(`select object_id,object_version,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id='SOC' and object_type='soc-alert' order by object_id,object_version`,[h.owner])).rows as Array<{object_id:string;object_version:number;snapshot_hash:string;snapshot:{fields:Array<{label:string;value:string}>;deletedAt?:string}}>
 const first=await rows(),current=first.find(row=>row.snapshot.fields.some(field=>field.label==='主机'&&field.value==='tenant B'))!
 assert.ok(current)
 assert.notEqual(current.object_id,legacy.id)
 assert.deepEqual(first.filter(row=>row.object_id===legacy.id).map(row=>row.object_version),[1])
 source.pages=[[item('survivor','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('tenant-b')).tombstoned,1)
 const after=await rows()
 assert.deepEqual(after.filter(row=>row.object_id===legacy.id).map(row=>row.object_version),[1])
 assert.equal(after.find(row=>row.object_id===legacy.id)!.snapshot_hash,businessObjectSnapshotHash(legacy))
 assert.equal(after.filter(row=>row.object_id===current.object_id).at(-1)!.snapshot.deletedAt,'2026-09-25T12:00:00.000Z')
})

test('旧身份行未固定实际 source_id 时，缺席对比不得归档其快照',async()=>{
 const source=new ScriptSource(),h=harness([compareMapping()],{'soc-compare':source})
 source.pages=[[item('legacy','2026-09-25T10:00:00.000Z'),item('survivor','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('soc-compare')).upserted,2)
 const legacy=(await pool.query(`select object_id from teloa_business_sync_object_ids where owner_id=$1 and scope_id='SOC' and object_type='soc-alert' and external_key='legacy'`,[h.owner])).rows[0].object_id as string
 await pool.query(`update teloa_business_sync_object_ids set source_id=null where owner_id=$1 and scope_id='SOC' and object_type='soc-alert' and object_id=$2`,[h.owner,legacy])
 source.pages=[[item('survivor','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('soc-compare')).tombstoned,0)
 const versions=(await pool.query(`select object_version from teloa_business_object_snapshots where owner_id=$1 and scope_id='SOC' and object_type='soc-alert' and object_id=$2 order by object_version`,[h.owner,legacy])).rows
 assert.deepEqual(versions.map(row=>Number(row.object_version)),[1])
})

test('拉取期间映射被新配置移除后，旧映射不得写入快照或游标',async()=>{
 const mappings=[mappingOf()],source=new ScriptSource(),h=harness(mappings,{'soc-sync':source})
 let release!:()=>void,notify!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const entered=new Promise<void>(resolve=>{notify=resolve})
 const original=source.fetch.bind(source)
 source.fetch=async input=>{notify();await gate;return original(input)}
 source.pages=[[item('stale','2026-09-25T10:00:00.000Z')]]
 const pending=h.run('soc-sync')
 await entered
 mappings.splice(0,1)
 release()
 await assert.rejects(pending,(error:unknown)=>error instanceof WorkError&&error.code==='teloa/conflict')
 assert.deepEqual(await h.current(),[])
 assert.equal(await h.cursor('soc-sync'),undefined)
})

test('外部同步撞上本地记录 ID 时保留本地记录，来源缺席不归档本地记录',async()=>{
 const source=new ScriptSource(),h=harness([compareMapping()],{'soc-compare':source})
 const local=readBusinessObjectSnapshot({scope:'SOC',type:'soc-alert',id:'local-123',version:1,title:'本地客户',source:'本地记录',observedAt:CAPTURED,receivedAt:CAPTURED,quality:'complete',summary:'手工维护',fields:[]},'SOC')
 await pool.query(`insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,'SOC','soc-alert',$2,1,$3,$4,$5,$6)`,[h.owner,local.id,businessObjectSnapshotHash(local),JSON.stringify(local),source.key,CAPTURED])
 await pool.query(`insert into teloa_business_record_heads(owner_id,scope_id,object_type,object_id,current_version,source_id,created_at) values($1,'SOC','soc-alert',$2,1,$3,$4)`,[h.owner,local.id,source.key,CAPTURED])
 source.pages=[[item(local.id,'2026-09-25T10:00:00.000Z'),item('other','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('soc-compare')).upserted,2)
 const external=(await pool.query(`select object_id from teloa_business_object_snapshots where owner_id=$1 and source_id=$2 and snapshot->'fields'->0->>'value'=$3`,[h.owner,source.key,local.id])).rows[0].object_id as string
 assert.notEqual(external,local.id)
 source.pages=[[item('other','2026-09-25T10:00:00.000Z')]]
 assert.equal((await h.run('soc-compare')).tombstoned,1)
 const rows=(await pool.query(`select object_id,object_version,source_id,snapshot from teloa_business_object_snapshots where owner_id=$1 and object_id=any($2::text[]) order by object_id,object_version`,[h.owner,[local.id,external]])).rows
 assert.deepEqual(rows.filter(row=>row.object_id===local.id).map(row=>row.object_version),[1])
 assert.equal(rows.find(row=>row.object_id===local.id)!.snapshot.title,'本地客户')
 assert.equal(rows.filter(row=>row.object_id===external).at(-1)!.snapshot.deletedAt,'2026-09-25T12:00:00.000Z')
})

test('同步记录保留：每个映射只留最近 200 条，别的映射不动',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 source.pages=[[item('k1','2026-09-25T10:00:00.000Z')]]
 const fill=(mappingId:string,n:number)=>pool.query(`insert into teloa_business_sync_runs(owner_id,scope_id,mapping_id,run_id,trigger,started_at,finished_at,status,fetched,upserted,tombstoned,duration_ms,error_code,error_reason,next_cursor,throttled)
   select $1,'SOC',$2,gen_random_uuid(),'schedule',t,t,'ok',0,0,0,0,null,null,null,false from (select timestamptz '2026-01-01T00:00:00Z'+g*interval '1 minute' as t from generate_series(1,$3::int) g) s`,[h.owner,mappingId,n])
 await fill('soc-sync',230);await fill('soc-other',230)
 const run=await h.run('soc-sync')
 const count=async(mappingId:string)=>Number((await pool.query('select count(*) as n from teloa_business_sync_runs where owner_id=$1 and mapping_id=$2',[h.owner,mappingId])).rows[0].n)
 assert.equal(await count('soc-sync'),200)
 assert.equal(await count('soc-other'),230,'只清本次同步的映射')
 assert.equal((await h.service.runs(h.actor,{scope:'SOC',mappingId:'soc-sync',limit:1}))[0]!.id,run.id,'刚跑的这一条留着')
 const oldest=(await pool.query(`select min(started_at) as m from teloa_business_sync_runs where owner_id=$1 and mapping_id='soc-sync'`,[h.owner])).rows[0].m as Date
 assert.equal(oldest.toISOString(),'2026-01-01T00:32:00.000Z','删的是最旧的 31 条')
})

test('提交后的保留清理失败不抛给调用方：返回成功的 run，只记日志且不带表名与约束名',async t=>{
 const warn=t.mock.method(console,'warn',()=>{})
 const source=new ScriptSource();source.pages=[[item('p1','2026-09-25T10:00:00.000Z')]]
 const owner='sync:'+randomUUID(),actor:BusinessSyncActor={ownerId:owner,scopeIds:['SOC']},identity={id:randomUUID,now:()=>'2026-09-25T12:00:00.000Z'}
 const warehouse=new BusinessWarehouseService(pool,identity)
 warehouse.prune=async()=>{throw Object.assign(new Error('update or delete on table "teloa_business_object_snapshots" violates foreign key constraint "teloa_x_fk"'),{code:'23503'})}
 const service=new BusinessSyncService(pool,identity,definitionsOf([mappingOf()]),warehouse,async()=>source)
 const run=await service.run(actor,{scope:'SOC',mappingId:'soc-sync',trigger:'manual'})
 assert.deepEqual([run.status,run.upserted],['ok',1])
 const logged=warn.mock.calls.map(call=>call.arguments.map(String).join(' ')).join('\n')
 assert.match(logged,/teloa\/dependency-unavailable/)
 assert.doesNotMatch(logged,/teloa_business|_fk|constraint|violates/i)
})

test('状态与到期：单个映射算不出下一次只降级这一个，不拖垮整个范围',async()=>{
 const leap=mappingOf({id:'soc-leap',schedule:{kind:'cron',expression:'0 0 29 2 *',timezone:'UTC'}})
 const h=harness([leap,mappingOf()],{})
 await new BusinessSpaceService(pool,{id:randomUUID,now:()=>CAPTURED}).ensurePersonal(h.owner)
 await pool.query(`insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-leap',1,1,now())`,[h.owner])
 // 2096-03-01 之后四年内没有 2 月 29 日（2100 年不闰）：这一条算不出下一次。
 await pool.query(`insert into teloa_business_sync_cursors(owner_id,scope_id,mapping_id,cursor,consecutive_failures,backoff_until,last_ok_at,updated_at) values($1,'SOC','soc-leap',null,0,null,'2096-03-01T00:00:00Z',now())`,[h.owner])
 const status=await h.service.status(h.actor,'SOC')
 assert.deepEqual(status.map(row=>[row.mappingId,row.nextRunAt]),[['soc-leap',undefined],['soc-sync','1970-01-01T00:01:00.000Z']])
 assert.deepEqual(await h.service.due(h.owner,'2026-09-25T12:00:00.000Z'),[{scope:'SOC',mappingId:'soc-sync'}])
})

test('旧已登记但未受管范围继续 due 与 schedule',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 await new BusinessSpaceService(pool,{id:randomUUID,now:()=>CAPTURED}).ensurePersonal(h.owner)
 source.pages=[[]]
 await pool.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-sync',1,1,now())",[h.owner])
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[{scope:'SOC',mappingId:'soc-sync'}])
 assert.equal((await h.service.run(h.actor,{scope:'SOC',mappingId:'soc-sync',trigger:'schedule'})).status,'ok')
 assert.equal(source.calls,1)
})

test('受管默认暂停：已有生效 mapping 也不到期，schedule 不触达来源；手动不改变暂停',async()=>{
 await initializeBusinessSpaces(pool)
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 source.pages=[[item('managed','2026-09-25T10:00:00.000Z')]]
 await new BusinessSpaceService(pool,{id:randomUUID,now:()=>CAPTURED}).ensurePersonal(h.owner)
 await initializeBusinessRuntime(pool)
 const runtime=new BusinessRuntimeService(pool,{now:()=>CAPTURED}),db=await pool.connect()
 try{await db.query('begin');await runtime.registerInTransaction(db,h.owner,'SOC');await db.query('commit')}finally{db.release()}
 await pool.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-sync',1,1,now())",[h.owner])
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[])
 await assert.rejects(h.service.run(h.actor,{scope:'SOC',mappingId:'soc-sync',trigger:'schedule'}),{code:'teloa/conflict'})
 assert.equal(source.calls,0)
 assert.equal((await h.run('soc-sync')).status,'ok')
 assert.equal((await pool.query("select sync_enabled from teloa_business_runtime where owner_id=$1",[h.owner])).rows[0].sync_enabled,false)
})

test('业务总开关已开但单条规则未启用：due 和直接 schedule 均停，手动一次不启用周期',async()=>{
 const source=new ScriptSource(),h=harness([mappingOf()],{'soc-sync':source})
 source.pages=[[]]
 await initializeBusinessSpaces(pool);await initializeBusinessRuntime(pool)
 await new BusinessSpaceService(pool,{id:randomUUID,now:()=>CAPTURED}).ensurePersonal(h.owner)
 const runtime=new BusinessRuntimeService(pool,{now:()=>CAPTURED}),db=await pool.connect()
 try{await db.query('begin');await runtime.registerInTransaction(db,h.owner,'SOC');await db.query('commit')}finally{db.release()}
 await runtime.setSync(h.actor,{scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID()})
 await pool.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-sync',1,1,now())",[h.owner])
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[])
 await assert.rejects(h.service.run(h.actor,{scope:'SOC',mappingId:'soc-sync',trigger:'schedule'}),{code:'teloa/conflict'})
 assert.equal(source.calls,0)
 assert.equal((await h.run('soc-sync')).status,'ok')
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[])
 await h.service.rules.set(h.actor,{scope:'SOC',mappingId:'soc-sync',enabled:true,expectedRevision:0,requestId:randomUUID()})
 assert.deepEqual(await h.service.due(h.owner,'2026-09-25T12:02:00.000Z'),[{scope:'SOC',mappingId:'soc-sync'}])
})


async function managedHarness(source:BusinessSyncSourcePort,overridePool?:Pool){
 await initializeBusinessSpaces(pool);await initializeBusinessRuntime(pool)
 const h=harness([mappingOf()],{'soc-sync':source},overridePool?{pool:overridePool}:{})
 await new BusinessSpaceService(pool,{id:randomUUID,now:()=>CAPTURED}).ensurePersonal(h.owner)
 const runtime=new BusinessRuntimeService(pool,{now:()=>CAPTURED}),db=await pool.connect()
 try{await db.query('begin');await runtime.registerInTransaction(db,h.owner,'SOC');await db.query('commit')}finally{db.release()}
 const enabled=await runtime.setSync(h.actor,{scope:'SOC',enabled:true,expectedRevision:1,requestId:randomUUID()})
 await h.service.rules.set(h.actor,{scope:'SOC',mappingId:'soc-sync',enabled:true,expectedRevision:0,requestId:randomUUID()})
 const pause=()=>runtime.setSync(h.actor,{scope:'SOC',enabled:false,expectedRevision:enabled.revision,requestId:randomUUID()})
 const schedule=(signal?:AbortSignal)=>h.service.run(h.actor,{scope:'SOC',mappingId:'soc-sync',trigger:'schedule'},signal)
 return {...h,runtime,pause,schedule}
}
function latch<T=void>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
async function waiting(query:string){
 const deadline=Date.now()+5000
 while(Date.now()<deadline){
  if((await pool.query("select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query=$1",[query])).rowCount)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 throw Error('未观察到预期锁等待：'+query)
}

test('due 后暂停再 schedule：重建服务仍拒绝，不改映射修订',async()=>{
 const source=new ScriptSource(),h=await managedHarness(source)
 source.pages=[[]]
 await pool.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-sync',1,1,now())",[h.owner])
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[{scope:'SOC',mappingId:'soc-sync'}])
 await h.pause()
 await assert.rejects(h.schedule(),{code:'teloa/conflict'})
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[])
 const reloaded=new BusinessRuntimeService(pool,{now:()=>CAPTURED})
 assert.deepEqual(await reloaded.get(h.actor,'SOC'),{scope:'SOC',managed:true,syncEnabled:false,revision:3})
 assert.equal(source.calls,0)
 assert.deepEqual((await pool.query('select version,revision from teloa_business_local_definition_heads where owner_id=$1',[h.owner])).rows,[{version:1,revision:1}])
})

test('单条规则已入到期队列后暂停：来源下一页与旧结果采用都停止，重启后仍暂停',async()=>{
 const started=latch(),response=latch<BusinessSyncFetchPage>();let calls=0
 const source={key:'soc/list_alerts',fetch:()=>{calls++;started.resolve();return response.promise}}
 const h=await managedHarness(source)
 const running=assert.rejects(h.schedule(),{code:'teloa/conflict'})
 await started.promise
 const paused=await h.service.rules.set(h.actor,{scope:'SOC',mappingId:'soc-sync',enabled:false,expectedRevision:1,requestId:randomUUID()})
 response.resolve({items:[item('late','2026-09-25T10:00:00.000Z')],capturedAt:CAPTURED,nextCursor:'page2'})
 await running
 assert.equal(calls,1)
 assert.deepEqual(await h.current(),[])
 assert.equal(await h.cursor('soc-sync'),undefined)
 assert.equal((await h.service.rules.get(h.actor,{scope:'SOC',mappingId:'soc-sync'})).revision,paused.revision)
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[])
})

test('领取执行时若映射声明与规则授权摘要错位，旧映射不能借新授权调用来源',async()=>{
 let calls=0,reads=0
 const source={key:'soc/list_alerts',fetch:async()=>{calls++;return {items:[],capturedAt:CAPTURED}}}
 const h=await managedHarness(source)
 const base=definitionsOf([mappingOf()])
 const definitions:Pick<BusinessDefinitionSourceReader,'forScope'>={forScope:async(db,owner,scope)=>{
  const bundles=await base.forScope(db,owner,scope),hash=++reads===1?'b'.repeat(64):'a'.repeat(64)
  return bundles.map(bundle=>({...bundle,mappings:bundle.mappings.map(row=>({...row,source:{...row.source,definitionHash:hash}}))}))
 }}
 const identity={id:randomUUID,now:()=>CAPTURED}
 const service=new BusinessSyncService(pool,identity,definitions,new BusinessWarehouseService(pool,identity),async()=>source)
 await assert.rejects(service.run(h.actor,{scope:'SOC',mappingId:'soc-sync',trigger:'schedule'}),{code:'teloa/conflict'})
 assert.equal(calls,0)
})

test('已发首请求期间暂停不等网络，后续页不发且整批不采用；暂停再启用也不能采用旧修订',async()=>{
 for(const resume of [false,true]){
  const started=latch(),response=latch<BusinessSyncFetchPage>();let calls=0
  const h=await managedHarness({key:'source',fetch:()=>{calls++;started.resolve();return response.promise}})
  const running=assert.rejects(h.schedule(),{code:'teloa/conflict'})
  await started.promise
  try{
   const paused=await h.pause()
   assert.equal((await pool.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state like 'idle in transaction%'")).rows[0].n,0,'暂停返回时来源仍未返回，但没有悬挂事务')
   if(resume)await h.runtime.setSync(h.actor,{scope:'SOC',enabled:true,expectedRevision:paused.revision,requestId:randomUUID()})
  }finally{response.resolve({items:[item('old','2026-09-25T10:00:00.000Z')],capturedAt:CAPTURED,nextCursor:'page2'})}
  await running
  assert.equal(calls,1)
  assert.deepEqual(await h.current(),[])
  assert.equal(await h.cursor('soc-sync'),undefined,'暂停不增加退避或游标')
 }
})

test('最后一页在暂停后返回：写入边界拒绝，不推进既有游标',async()=>{
 const started=latch(),response=latch<BusinessSyncFetchPage>()
 const h=await managedHarness({key:'source',fetch:()=>{started.resolve();return response.promise}})
 await pool.query("insert into teloa_business_sync_cursors(owner_id,scope_id,mapping_id,cursor,consecutive_failures,updated_at) values($1,'SOC','soc-sync','prior',0,now())",[h.owner])
 const before=await h.cursor('soc-sync'),running=assert.rejects(h.schedule(),{code:'teloa/conflict'})
 await started.promise
 try{await h.pause()}finally{response.resolve({items:[item('late','2026-09-25T10:00:00.000Z')],capturedAt:CAPTURED})}
 await running
 assert.deepEqual(await h.cursor('soc-sync'),before)
 assert.deepEqual(await h.current(),[])
})

test('暂停后来源拒绝不应记录来源失败或退避',async()=>{
 const started=latch(),response=latch<BusinessSyncFetchPage>()
 const h=await managedHarness({key:'source',fetch:()=>{started.resolve();return response.promise}})
 const running=assert.rejects(h.schedule(),{code:'teloa/conflict'})
 await started.promise
 try{await h.pause()}finally{response.reject(new Error('source disconnected'))}
 await running
 assert.equal(await h.cursor('soc-sync'),undefined)
 assert.deepEqual(await h.service.runs(h.actor,{scope:'SOC',limit:10}),[])
})

test('首请求竞争：暂停先拿排他锁则 source.fetch 从未发起',async()=>{
 const source=new ScriptSource(),h=await managedHarness(source),holder=await pool.connect()
 source.pages=[[]]
 let paused:ReturnType<typeof h.pause>|undefined,running:Promise<void>|undefined
 try{
  await holder.query('begin');await lockBusinessRuntime(holder,h.owner,'SOC','exclusive')
  paused=h.pause()
  await waiting('select pg_advisory_xact_lock(hashtextextended($1,0)) as locked')
  running=assert.rejects(h.schedule(),{code:'teloa/conflict'})
  await waiting('select pg_advisory_lock_shared(hashtextextended($1,0)) as locked')
  await holder.query('commit')
  await paused;await running
  assert.equal(source.calls,0)
 }finally{await holder.query('rollback');holder.release()}
})

test('受管 schedule 取消：当前请求保留 AbortSignal，下一页不发、不记退避',async()=>{
 const started=latch(),response=latch<BusinessSyncFetchPage>(),controller=new AbortController();let calls=0
 const h=await managedHarness({key:'source',fetch:input=>{assert.equal(input.signal,controller.signal);calls++;started.resolve();return response.promise}})
 const running=assert.rejects(h.schedule(controller.signal),{name:'AbortError'})
 await started.promise
 controller.abort()
 response.resolve({items:[],capturedAt:CAPTURED,nextCursor:'next'})
 await running
 assert.equal(calls,1)
 assert.equal(await h.cursor('soc-sync'),undefined)
})

/** 仍走真实 PG，只在指定查询边界插入屏障/故障；归还前复原方法。 */
function instrumentedPool(intercept:(sql:string,db:PoolClient)=>Promise<void>,released?:(error:Error|boolean|undefined,db:PoolClient)=>void,afterQuery?:(sql:string,db:PoolClient)=>Promise<void>):Pool{
 return new Proxy(pool,{get(target,key){
  if(key!=='connect')return Reflect.get(target,key)
  return async(...args:unknown[])=>{
   if(args.length)return Reflect.apply(target.connect,target,args)
   const db=await target.connect(),original=db.query,release=db.release,query=original.bind(db) as (...args:unknown[])=>unknown
   db.query=(async(...params:unknown[])=>{if(typeof params[0]==='string')await intercept(params[0],db);const result=await query(...params);if(typeof params[0]==='string')await afterQuery?.(params[0],db);return result}) as PoolClient['query']
   db.release=((error?:Error|boolean)=>{db.query=original;db.release=release;released?.(error,db);return release.call(db,error)}) as PoolClient['release']
   return db
  }
 }})
}
test('写入先取得共享事务锁：暂停等待该批提交，之后不再调用来源',async()=>{
 const writing=latch(),proceed=latch()
 const spy=instrumentedPool(async sql=>{if(sql.startsWith('insert into teloa_business_object_snapshots')){writing.resolve();await proceed.promise}})
 const source=new ScriptSource(),h=await managedHarness(source,spy)
 source.pages=[[item('accepted','2026-09-25T10:00:00.000Z')]]
 const running=h.schedule()
 await writing.promise
 const paused=h.pause()
 try{await waiting('select pg_advisory_xact_lock(hashtextextended($1,0)) as locked')}finally{proceed.resolve()}
 assert.equal((await running).status,'ok')
 assert.equal((await paused).syncEnabled,false)
 assert.deepEqual(await h.current(),['accepted'])
 assert.equal((await h.cursor('soc-sync'))!.consecutive_failures,0)
 await assert.rejects(h.schedule(),{code:'teloa/conflict'})
 assert.equal(source.calls,1)
})

test('来源立即拒绝且解锁有延迟：拒绝立即接住，只记录一次真正来源失败',async()=>{
 const spy=instrumentedPool(async sql=>{if(sql.includes('pg_advisory_unlock_shared'))await sleep(30)})
 const h=await managedHarness({key:'source',fetch:()=>Promise.reject(new Error('source error'))},spy)
 const result=await h.schedule()
 assert.equal(result.status,'failed')
 assert.equal((await h.cursor('soc-sync'))!.consecutive_failures,1)
})

test('共享 session 解锁失败销毁连接，不把运行锁或映射锁带回池',async()=>{
 let broken:Error|boolean|undefined,failedPid:number|undefined
 const spy=instrumentedPool(async(sql,db)=>{
  if(sql.includes('pg_advisory_unlock_shared')){
   // 锁仍在真实连接上，模拟解锁查询无法送达；release(error) 必须关闭该连接。
   failedPid=(db as PoolClient&{processID:number}).processID
   throw Error('injected unlock failure')
  }
 },error=>{if(error)broken=error})
 const h=await managedHarness({key:'source',fetch:()=>Promise.reject(new Error('immediate source rejection'))},spy)
 await assert.rejects(h.schedule(),{code:'teloa/dependency-unavailable'})
 assert.ok(broken instanceof Error)
 const deadline=Date.now()+5000
 while((await pool.query('select 1 from pg_stat_activity where pid=$1',[failedPid])).rowCount){
  assert.ok(Date.now()<deadline,'损坏连接必须从数据库退出')
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 assert.equal(await h.cursor('soc-sync'),undefined)
 await h.pause()
})

test('受管运行状态丢失：due 不返回，schedule 报损坏且不记来源退避',async()=>{
 const source=new ScriptSource(),h=await managedHarness(source)
 source.pages=[[]]
 await pool.query("insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,'SOC','source-mapping','soc-sync',1,1,now())",[h.owner])
 await pool.query('delete from teloa_business_runtime where owner_id=$1',[h.owner])
 assert.deepEqual(await h.service.due(h.owner,h.clock.now),[])
 await assert.rejects(h.schedule(),{code:'teloa/storage-corrupt'})
 assert.equal(source.calls,0)
 assert.equal(await h.cursor('soc-sync'),undefined)
})

test('共享 session 加锁回包丢失：连接隔离，不泄漏锁或新增来源退避',async()=>{
 let broken:Error|boolean|undefined,calls=0
 const spy=instrumentedPool(async()=>{},error=>{if(error)broken=error},async sql=>{
  if(sql.includes('pg_advisory_lock_shared'))throw Error('injected lost lock acknowledgement')
 })
 const h=await managedHarness({key:'source',fetch:async()=>{calls++;return {items:[],capturedAt:CAPTURED}}},spy)
 await assert.rejects(h.schedule(),{code:'teloa/dependency-unavailable'})
 assert.ok(broken instanceof Error)
 assert.equal(calls,0)
 assert.equal(await h.cursor('soc-sync'),undefined)
 await h.pause()
})
