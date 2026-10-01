import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessSyncService,initializeBusinessSync} from '../src/work/business-sync.ts'
import {initializeBusinessSyncRules} from '../src/work/business-sync-rules.ts'
import {BusinessWarehouseService,initializeBusinessWarehouse} from '../src/work/business-warehouse.ts'
let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool);await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await initializeBusinessWarehouse(pool);await initializeBusinessSync(pool);await initializeBusinessSyncRules(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})
const unavailable=async():Promise<never>=>{throw Error('不得访问市场或来源')}
function services(){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 assert.equal(typeof api.BusinessConfigurationService,'function','须提供原子配置采用服务')
 return {drafts,store,definitions,runtime,spaces,apply:new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview:new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)}
}
async function fixture(){
 const s=services(),actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 let draft=await s.drafts.begin(actor,{requestId:randomUUID(),title:'工单'})
 const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:draft.scope,title:'工单',unit:'条',lead:'跟进事项',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'状态',type:'text',required:true,from:'状态'}]}
 draft=await s.drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[{id:'home',title:'记录',kind:'records',objectType:'ticket',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}})
 const preview=await s.preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})
 const input={requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:preview.receipt}
 return {...s,actor,draft,definition,input}
}
test('首次采用原子登记空间、范围、停用runtime和完整配置；同请求返回原回执',async()=>{
 const f=await fixture(),result=await f.apply.apply(f.actor,f.input)
 assert.equal(result.version,1);assert.equal(result.scope,f.draft.scope)
 await assert.rejects(f.apply.receipt(f.actor,{requestId:f.input.requestId}),{code:'teloa/forbidden'})
 await assert.rejects(f.apply.apply(f.actor,f.input),{code:'teloa/forbidden'})
 f.actor.scopeIds=(await new api.BusinessScopeService(pool).list(f.actor.ownerId)).map(item=>item.scope)
 assert.deepEqual(await f.apply.receipt(f.actor,{requestId:f.input.requestId}),result)
 assert.deepEqual(await services().apply.apply(f.actor,f.input),result)
 assert.equal((await f.runtime.get(f.actor,result.scope)).syncEnabled,false)
 assert.equal((await f.apply.current(f.actor,{scope:result.scope}))?.leaves.length,1)
 assert.equal((await f.drafts.get(f.actor,{draftId:f.draft.id})).status,'applied')
 await assert.rejects(f.apply.apply(f.actor,{...f.input,previewReceipt:'changed'}),{code:'teloa/conflict',details:undefined})
})
test('正式整体配置预览并采用 source-mapping 后同一 Reader 可读，运行授权默认暂停',async()=>{
 const f=await fixture(),scope=f.draft.scope
 const mapping={format:'teloa.business-source-mapping/v1',id:'ticket-sync',version:'1.0.0',domain:scope,title:'工单同步',objectType:'ticket',source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
 const candidate=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{upsertDefinitions:[{kind:'source-mapping',definition:mapping}]}})
 const before=(await pool.query('select count(*)::int n from teloa_business_local_definitions where owner_id=$1',[f.actor.ownerId])).rows[0].n
 const preview=await f.preview.preview(f.actor,{draftId:candidate.id,expectedRevision:candidate.revision})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_local_definitions where owner_id=$1',[f.actor.ownerId])).rows[0].n,before)
 const adopted=await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:candidate.id,expectedRevision:candidate.revision,expectedBaseVersion:candidate.baseVersion,previewReceipt:preview.receipt})
 f.actor.scopeIds=[scope]
 const current=await f.apply.current(f.actor,{scope})
 assert.equal(current?.version,adopted.version)
 assert.equal(current?.leaves.find(leaf=>leaf.kind==='source-mapping')?.localId,mapping.id)
 let calls=0
 const sync=new BusinessSyncService(pool,identity,f.definitions,new BusinessWarehouseService(pool,identity),async()=>({key:'security-alert-http',fetch:async()=>{calls++;return {items:[{state:'新建'}],capturedAt:identity.now()}}}))
 assert.deepEqual(await sync.mappings(f.actor,scope),[mapping])
 assert.deepEqual(await sync.rules.get(f.actor,{scope,mappingId:mapping.id}),{scope,mappingId:mapping.id,definitionHash:current!.leaves.find(leaf=>leaf.kind==='source-mapping')!.definitionHash,enabled:false,revision:0})
 assert.equal((await f.runtime.get(f.actor,scope)).syncEnabled,false)
 assert.deepEqual(await sync.due(f.actor.ownerId,identity.now()),[])
 await f.runtime.setSync(f.actor,{scope,enabled:true,expectedRevision:1,requestId:randomUUID()})
 assert.deepEqual(await sync.due(f.actor.ownerId,identity.now()),[])
 await sync.rules.set(f.actor,{scope,mappingId:mapping.id,enabled:true,expectedRevision:0,requestId:randomUUID()})
 assert.deepEqual(await sync.due(f.actor.ownerId,identity.now()),[{scope,mappingId:mapping.id}])
 assert.equal((await sync.run(f.actor,{scope,mappingId:mapping.id,trigger:'schedule'})).status,'ok')
 assert.equal(calls,1)
})
test('仅未提交的失效预览凭证带精确原因，版本冲突不误标且失败无写入',async()=>{
 const f=await fixture(),before=await f.drafts.get(f.actor,{draftId:f.draft.id})
 await assert.rejects(f.apply.apply(f.actor,{...f.input,expectedRevision:f.input.expectedRevision+1,previewReceipt:'0'.repeat(64)}),{code:'teloa/version-conflict',details:undefined})
 await assert.rejects(f.apply.apply(f.actor,{...f.input,previewReceipt:'0'.repeat(64)}),{code:'teloa/conflict',details:{reason:'preview-receipt-invalid'}})
 assert.deepEqual(await f.drafts.get(f.actor,{draftId:f.draft.id}),before)
 assert.equal(await f.apply.receipt(f.actor,{requestId:f.input.requestId}),undefined)
 for(const table of ['teloa_business_scopes','teloa_business_runtime','teloa_business_configuration_heads','teloa_business_configuration_versions','teloa_business_local_definition_heads','teloa_business_local_definitions'])assert.equal((await pool.query(`select count(*)::int n from ${table} where owner_id=$1`,[f.actor.ownerId])).rows[0].n,0,table)
})
test('末尾正式读取失败回滚所有登记和回执',async()=>{
 const f=await fixture()
 f.definitions.forScope=async()=>{throw Error('final validation failed')}
 await assert.rejects(f.apply.apply(f.actor,f.input))
 for(const [table,col] of [['teloa_business_scopes','scope'],['teloa_business_runtime','scope_id'],['teloa_business_configuration_heads','scope_id'],['teloa_business_local_definition_heads','scope_id'],['teloa_business_local_definitions','scope_id']])assert.equal((await pool.query(`select count(*)::int n from ${table} where owner_id=$1 and ${col}=$2`,[f.actor.ownerId,f.draft.scope])).rows[0].n,0)
 assert.equal(await f.apply.receipt(f.actor,{requestId:f.input.requestId}),undefined)
 assert.equal((await f.drafts.get(f.actor,{draftId:f.draft.id})).status,'draft')
})
async function adoptNext(f:Awaited<ReturnType<typeof fixture>>,patch:unknown){
 const next=await f.drafts.begin(f.actor,{requestId:randomUUID(),title:'改名',scope:f.draft.scope})
 const changed=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:1,patch})
 const preview=await f.preview.preview(f.actor,{draftId:changed.id,expectedRevision:changed.revision})
 return f.apply.apply(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:changed.revision,expectedBaseVersion:next.baseVersion,previewReceipt:preview.receipt})
}
async function historical(f:Awaited<ReturnType<typeof fixture>>){
 const snapshot={scope:f.draft.scope,type:'ticket',id:'one',version:1,title:'旧记录',source:'本地',observedAt:identity.now(),receivedAt:identity.now(),quality:'complete',summary:'',fields:[{label:'状态',value:'旧值'}],deletedAt:identity.now()}
 await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,1,$5,$6,$7,now())',[f.actor.ownerId,f.draft.scope,'ticket','one',businessObjectSnapshotHash(snapshot as never),JSON.stringify(snapshot),f.definition.sourceId])
}
test('历史归档记录阻止字段重映射和必填新增，中文label改名保留取值身份',async()=>{
 const f=await fixture(),first=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[first.scope];await historical(f)
 await assert.rejects(adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,fields:[{...f.definition.fields[0],from:'新键'}]}}]}),{code:'teloa/conflict',details:undefined})
 await assert.rejects(adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,fields:[...f.definition.fields,{name:'extra',label:'必填',type:'text',required:true,from:'新增'}]}}]}),{code:'teloa/conflict'})
 assert.equal((await f.apply.current(f.actor,{scope:first.scope}))?.version,1)
 const renamed=await adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,fields:[{...f.definition.fields[0],label:'处理状态'}]}}]})
 assert.equal(renamed.version,2)
 assert.deepEqual(await f.apply.apply(f.actor,f.input),first)
})
test('标题修改复用叶子版本且owner/scope授权不因回执绕过',async()=>{
 const f=await fixture(),first=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[first.scope]
 await adoptNext(f,{title:'新业务名称'})
 assert.equal((await f.apply.current(f.actor,{scope:first.scope}))?.leaves[0]?.version,1)
 assert.equal((await pool.query('select title from teloa_business_scopes where owner_id=$1 and scope=$2',[f.actor.ownerId,first.scope])).rows[0].title,'新业务名称')
 await assert.rejects(f.apply.apply({...f.actor,scopeIds:[]},f.input),{code:'teloa/forbidden'})
 await assert.rejects(f.apply.apply({...f.actor,ownerId:randomUUID()},f.input),{code:'teloa/forbidden'})
})
import {lockBusinessConfigurationRequests} from '../src/work/business-configuration-drafts.ts'
import {spawn} from 'node:child_process'
async function blockedBy(client:import('pg').PoolClient,count=1){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid
 for(let n=0;n<2000;n++){
  if(((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount??0)>=count)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 throw Error('未观察到PG锁屏障')
}
test('等待本人锁期间取消：解除屏障后整笔回滚，无成功回执',async()=>{
 const f=await fixture(),block=await pool.connect(),controller=new AbortController()
 await block.query('begin');await lockBusinessConfigurationRequests(block,f.actor.ownerId)
 const pending=f.apply.apply(f.actor,f.input,controller.signal)
 const rejected=assert.rejects(pending,{name:'AbortError'})
 await blockedBy(block);controller.abort();await block.query('commit');block.release();await rejected
 assert.equal(await f.apply.receipt(f.actor,{requestId:f.input.requestId}),undefined)
 assert.equal((await pool.query('select 1 from teloa_business_scopes where owner_id=$1 and scope=$2',[f.actor.ownerId,f.draft.scope])).rowCount,0)
})
test('两个同base草案在PG锁屏障后竞争，只有一个完整采用',async()=>{
 const f=await fixture(),first=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[first.scope]
 const drafts=await Promise.all([1,2].map(n=>f.drafts.begin(f.actor,{requestId:randomUUID(),title:'版本'+n,scope:first.scope})))
 const inputs=await Promise.all(drafts.map(async d=>({requestId:randomUUID(),draftId:d.id,expectedRevision:1,expectedBaseVersion:1,previewReceipt:(await f.preview.preview(f.actor,{draftId:d.id,expectedRevision:1})).receipt})))
 const block=await pool.connect();await block.query('begin');await lockBusinessConfigurationRequests(block,f.actor.ownerId)
 const pending=inputs.map(input=>f.apply.apply(f.actor,input));const results=Promise.allSettled(pending)
 await blockedBy(block);await block.query('commit');block.release()
 const settled=await results
 assert.equal(settled.filter(r=>r.status==='fulfilled').length,1)
 assert.equal(settled.filter(r=>r.status==='rejected'&&(r.reason as {code:string}).code==='teloa/version-conflict').length,1)
 assert.equal((await f.apply.current(f.actor,{scope:first.scope}))?.version,2)
})
test('独立进程secret重置后旧成功请求仍返当时版本，未采用旧预览无效',async()=>{
 const f=await fixture(),result=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[result.scope]
 await adoptNext(f,{title:'后续版本'})
 const unsaved=await fixture()
 const code=`import {Pool} from ${JSON.stringify(import.meta.resolve('pg'))};import * as api from ${JSON.stringify(new URL('../src/index.ts',import.meta.url).href)};import {BusinessDefinitionSourceReader} from ${JSON.stringify(new URL('../src/work/business-definition-source.ts',import.meta.url).href)};
 const data=JSON.parse(process.env.TELOA_TASK4_PROBE);const pool=new Pool({connectionString:data.connection});const identity={now:()=>new Date().toISOString()};
 const store=new api.BusinessConfigurationStore(pool);const drafts=new api.BusinessConfigurationDraftService(pool,{...identity,id:()=>{throw Error()}});const unavailable=async()=>{throw Error()};
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store);
 const svc=new api.BusinessConfigurationService(pool,identity,{store,drafts,definitions,runtime:new api.BusinessRuntimeService(pool,identity),spaces:new api.BusinessSpaceService(pool,{...identity,id:()=>{throw Error()}})});
 try{const invalidSavedReceipt=!api.verifiesBusinessConfigurationPreviewReceipt(data.input.previewReceipt,data.savedBinding);const result=await svc.apply(data.actor,data.input);let rejected;try{await svc.apply(data.unsavedActor,data.unsavedInput)}catch(error){rejected={code:error.code,reason:error.details?.reason}}process.stdout.write(JSON.stringify({result,rejected,invalidSavedReceipt}))}finally{await pool.end()}`
 const child=spawn(process.execPath,['--input-type=module','-e',code],{cwd:process.cwd(),env:{...process.env,TELOA_TASK4_PROBE:JSON.stringify({connection:container.getConnectionUri(),actor:f.actor,input:f.input,savedBinding:{ownerId:f.actor.ownerId,draftId:f.draft.id,scope:f.draft.scope,revision:f.draft.revision,candidateHash:f.draft.hash,baseVersion:0,dependencyHash:api.businessConfigurationDependencyHash(undefined)},unsavedActor:unsaved.actor,unsavedInput:unsaved.input})},stdio:['ignore','pipe','pipe']})
 let stdout='',stderr='';child.stdout.on('data',v=>stdout+=v);child.stderr.on('data',v=>stderr+=v)
 const exit=await new Promise<number|null>((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve)})
 assert.equal(exit,0,stderr);assert.deepEqual(JSON.parse(stdout),{result,rejected:{code:'teloa/conflict',reason:'preview-receipt-invalid'},invalidSavedReceipt:true})
})
test('新scope被其它登记抢先插入时拒绝接管',async()=>{
 const f=await fixture(),space=await f.spaces.ensurePersonal(f.actor.ownerId)
 await api.BusinessScopeService.ensure(pool,f.actor.ownerId,{scope:f.draft.scope,title:'已有',kind:'domain',spaceId:space.id})
 await assert.rejects(f.apply.apply(f.actor,f.input),{code:'teloa/conflict'})
 assert.equal((await pool.query('select title,configuration_managed from teloa_business_scopes where owner_id=$1 and scope=$2',[f.actor.ownerId,f.draft.scope])).rows[0].title,'已有')
})
import {prepareBusinessDefinition} from '../src/work/business-definition-write.ts'
test('32条独立pending不占整体配额，40叶子完整采用，257叶子整体拒绝',async()=>{
 const f=await fixture(),prepared=prepareBusinessDefinition(f.draft.scope,'object-type',f.definition)
 for(let i=0;i<32;i++)await pool.query("insert into teloa_business_definition_drafts(owner_id,id,request_id,scope_id,kind,local_id,semver,definition_hash,body,status,created_at,updated_at) values($1,$2,$3,$4,'object-type',$5,$6,$7,$8,'draft',now(),now())",[f.actor.ownerId,randomUUID(),randomUUID(),f.draft.scope,prepared.localId,prepared.semver,prepared.definitionHash,prepared.body])
 const view={format:'teloa.business-view/v1',id:'by-state',version:'1.0.0',domain:f.draft.scope,title:'状态统计',kind:'distribution',chart:'bar',objectType:'ticket',dimension:{field:'state',limit:10},measures:[{id:'total',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:10}
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:f.draft.scope,title:'总览',widgets:['widget-36'],layout:[{widget:'widget-36',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const leaves=[{kind:'view',definition:view},...Array.from({length:37},(_,n)=>({kind:'widget',definition:{format:'teloa.business-widget/v1',id:'widget-'+n,version:'1.0.0',domain:f.draft.scope,title:'统计'+n,kind:'view-ref',viewRef:'by-state'}})),{kind:'dashboard',definition:dashboard}]
 const draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{upsertDefinitions:leaves,upsertPages:[{id:'stats',title:'统计',kind:'dashboard',dashboardId:'overview'}]}})
 const preview=await f.preview.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision})
 const result=await f.apply.apply(f.actor,{...f.input,expectedRevision:draft.revision,previewReceipt:preview.receipt});f.actor.scopeIds=[result.scope]
 assert.equal((await f.apply.current(f.actor,{scope:result.scope}))?.leaves.length,40)
 assert.equal((await new api.BusinessLedgerService(pool,identity,f.definitions).read(f.actor,{scope:result.scope})).blocks[0]?.objectType.definition.id,'ticket')
 const pages=new api.BusinessConfigurationPageService(pool,identity,{drafts:f.drafts,store:f.store,definitions:f.definitions,executor:{schema:'public',execute:unavailable}})
 const page=await pages.read(f.actor,{scope:result.scope,pageId:'stats'})
 assert.equal(page.page.kind,'dashboard')
 if(page.page.kind!=='dashboard'||'format' in page)throw Error('旧配置须返回旧看板投影')
 assert.equal(page.page.results[0]?.widgetId,'widget-36');assert.equal(page.page.results[0]?.status,'ok')

 assert.equal((await pool.query("select count(*)::int n from teloa_business_definition_drafts where owner_id=$1 and status='draft'",[f.actor.ownerId])).rows[0].n,32)
 const next=await f.drafts.begin(f.actor,{requestId:randomUUID(),title:'超限',scope:result.scope})
 await assert.rejects(f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:1,patch:{upsertDefinitions:Array.from({length:257},(_,n)=>({kind:'object-type',definition:{...f.definition,id:'huge-'+n}}))}}),{code:'teloa/invalid-input'})
 assert.equal((await f.apply.current(f.actor,{scope:result.scope}))?.version,1)
})
test('第二叶子真实SQL约束失败，前一叶子与所有新范围登记回滚',async()=>{
 const f=await fixture()
 const changed=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,id:'fail-leaf'}}]}})
 const preview=await f.preview.preview(f.actor,{draftId:changed.id,expectedRevision:changed.revision})
 await pool.query("alter table teloa_business_local_definitions add constraint task4_fail_leaf check(local_id<>'fail-leaf')")
 try{
  await assert.rejects(f.apply.apply(f.actor,{...f.input,expectedRevision:changed.revision,previewReceipt:preview.receipt}),{code:'23514'})
  for(const table of ['teloa_business_scopes','teloa_business_runtime','teloa_business_configuration_heads','teloa_business_local_definitions'])assert.equal((await pool.query(`select 1 from ${table} where owner_id=$1`,[f.actor.ownerId])).rowCount,0)
 }finally{await pool.query('alter table teloa_business_local_definitions drop constraint task4_fail_leaf')}
})
test('采用再次执行完整候选校验，预览后草案变更需新凭证',async()=>{
 const f=await fixture(),original=f.definitions.forConfigurationCandidate.bind(f.definitions)
 let checks=0;f.definitions.forConfigurationCandidate=async(...args)=>{checks++;return original(...args)}
 await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{title:'新标题'}})
 await assert.rejects(f.apply.apply(f.actor,f.input),{code:'teloa/version-conflict'})
 const preview=await f.preview.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.draft.revision+1})
 await f.apply.apply(f.actor,{...f.input,expectedRevision:f.draft.revision+1,previewReceipt:preview.receipt})
 assert.equal(checks,2)
})
test('采用事务持配置锁时旧叶子和市场加载竞争均等待，并在提交后拒绝',async()=>{
 const f=await fixture(),legacyId=randomUUID(),prepared=prepareBusinessDefinition(f.draft.scope,'object-type',f.definition)
 await api.initializeIndustryLoads(pool)
 const personal=await f.spaces.ensurePersonal(f.actor.ownerId)
 await pool.query("insert into teloa_business_definition_drafts(owner_id,id,request_id,scope_id,kind,local_id,semver,definition_hash,body,status,created_at,updated_at) values($1,$2,$3,$4,'object-type',$5,$6,$7,$8,'draft',now(),now())",[f.actor.ownerId,legacyId,randomUUID(),f.draft.scope,prepared.localId,prepared.semver,prepared.definitionHash,prepared.body])
 let release!:()=>void,ready!:(db:import('pg').PoolClient)=>void
 const gate=new Promise<void>(resolve=>release=resolve),reached=new Promise<import('pg').PoolClient>(resolve=>ready=resolve),read=f.definitions.forScope.bind(f.definitions)
 f.definitions.forScope=async(db,...args)=>{const value=await read(db,...args);ready(db);await gate;return value}
 const applying=f.apply.apply(f.actor,f.input),db=await reached
 const legacy=new api.BusinessLocalDefinitionService(pool,identity)
 const old=legacy.apply({...f.actor,scopeIds:[f.draft.scope]},{requestId:randomUUID(),draftId:legacyId,expectedDefinitionHash:prepared.definitionHash,expectedCurrentVersion:0,previewReceipt:'a'.repeat(64)}).then(()=>({code:'unexpected-success'}),error=>error)
 const market=new api.IndustryLoadService(pool,identity,{read:async()=>({templateId:'fixture',templateVersion:'1.0.0',title:'模板',domain:f.draft.scope,description:'测试',resources:[{localId:'notes',kind:'knowledge' as const,title:'资料',version:'1.0.0',required:false,available:true}],relations:[],entrypoints:[]})})
 const marketResult=market.create(f.actor.ownerId,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'b'.repeat(64),target:{kind:'existing',spaceId:personal.id,expectedVersion:personal.version}}).then(()=>({code:'unexpected-success'}),error=>error)
 try{await blockedBy(db,2)}finally{release()}
 const result=await applying
 assert.equal((await old).code,'teloa/conflict');assert.equal((await marketResult).code,'teloa/conflict')
 f.actor.scopeIds=[result.scope];assert.equal((await f.apply.current(f.actor,{scope:result.scope}))?.version,1)
 assert.equal((await pool.query('select 1 from teloa_industry_loads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})
test('历史兼容检查翻页覆盖第201条，非法快照摘要与迁移冲突分开',async()=>{
 const f=await fixture(),first=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[first.scope]
 for(let n=0;n<201;n++){
  const now=identity.now(),snapshot={scope:first.scope,type:'ticket',id:String(n).padStart(3,'0'),version:1,title:'记录',source:'本地',observedAt:now,receivedAt:now,quality:'complete',summary:'',fields:[{label:'状态',value:'旧值'}]}
  await pool.query('insert into teloa_business_object_snapshots(owner_id,scope_id,object_type,object_id,object_version,snapshot_hash,snapshot,source_id,first_seen_at) values($1,$2,$3,$4,1,$5,$6,$7,now())',[f.actor.ownerId,first.scope,'ticket',snapshot.id,n===200?'0'.repeat(64):businessObjectSnapshotHash(snapshot as never),JSON.stringify(snapshot),f.definition.sourceId])
 }
 await assert.rejects(adoptNext(f,{title:'新标题'}),{code:'teloa/storage-corrupt'})
 assert.equal((await f.apply.current(f.actor,{scope:first.scope}))?.version,1)
})
test('已有数据时enum缩减拒绝、扩展允许；optional收紧required严格验证旧值',async()=>{
 const f=await fixture(),first=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[first.scope]
 const enumDefinition={...f.definition,fields:[{...f.definition.fields[0],type:'enum',values:['旧值','新值','将删除'],required:false}]}
 await adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:enumDefinition}]});await historical(f)
 await assert.rejects(adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...enumDefinition,fields:[{...enumDefinition.fields[0],values:['旧值','新值']}]}}]}),{code:'teloa/conflict'})
 await adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...enumDefinition,fields:[{...enumDefinition.fields[0],values:['旧值','新值','将删除','扩展'],required:true}]}}]})
 const next={...f.definition,fields:[{...enumDefinition.fields[0],values:['旧值','新值','将删除','扩展'],required:true},{name:'optional',label:'选填',from:'选填',type:'number',required:false}]}
 await adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:next}]})
 await assert.rejects(adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...next,fields:next.fields.map(field=>({...field,required:true}))}}]}),{code:'teloa/conflict'})
})
test('最终读取后取消仍回滚，不留下已采用草案或回执',async()=>{
 const f=await fixture(),controller=new AbortController(),read=f.definitions.forScope.bind(f.definitions)
 f.definitions.forScope=async(...args)=>{const result=await read(...args);controller.abort();return result}
 await assert.rejects(f.apply.apply(f.actor,f.input,controller.signal),{name:'AbortError'})
 assert.equal((await pool.query('select 1 from teloa_business_configuration_heads where owner_id=$1',[f.actor.ownerId])).rowCount,0)
 assert.equal((await f.drafts.get(f.actor,{draftId:f.draft.id})).status,'draft')
 assert.equal(await f.apply.receipt(f.actor,{requestId:f.input.requestId}),undefined)
})
test('具有合法绑定凭证的非法SQL候选仍在采用时重新拒绝',async()=>{
 const f=await fixture()
 const draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{upsertDefinitions:[{kind:'widget',definition:{format:'teloa.business-widget/v1',id:'bad-sql',version:'1.0.0',domain:f.draft.scope,title:'统计',kind:'metric',query:'select * from pg_catalog.pg_class',metric:{valueColumn:'total'}}}]}})
 const token=api.issueBusinessConfigurationPreviewReceipt({ownerId:f.actor.ownerId,draftId:draft.id,scope:draft.scope,revision:draft.revision,candidateHash:draft.hash,baseVersion:0,dependencyHash:api.businessConfigurationDependencyHash(undefined)})
 await assert.rejects(f.apply.apply(f.actor,{...f.input,expectedRevision:draft.revision,previewReceipt:token}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select 1 from teloa_business_scopes where owner_id=$1',[f.actor.ownerId])).rowCount,0)
})
test('显式移除无数据叶子只清head，重加追加历史版本，改配置不重置已启用runtime',async()=>{
 const f=await fixture(),first=await f.apply.apply(f.actor,f.input);f.actor.scopeIds=[first.scope]
 const extra={...f.definition,id:'unused'}
 await adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:extra}]})
 await f.runtime.setSync(f.actor,{requestId:randomUUID(),scope:first.scope,enabled:true,expectedRevision:1})
 await adoptNext(f,{removeDefinitions:[{kind:'object-type',localId:'unused'}]})
 const head=(await pool.query("select version,revision from teloa_business_local_definition_heads where owner_id=$1 and local_id='unused'",[f.actor.ownerId])).rows[0]
 assert.deepEqual(head,{version:null,revision:2})
 await adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:extra}]})
 assert.equal((await f.apply.current(f.actor,{scope:first.scope}))?.leaves.find(leaf=>leaf.localId==='unused')?.version,2)
 assert.equal((await f.runtime.get(f.actor,first.scope)).syncEnabled,true)
 assert.equal((await pool.query("select count(*)::int n from teloa_business_local_definitions where owner_id=$1 and local_id='unused'",[f.actor.ownerId])).rows[0].n,2)
})
test('归档历史仍阻止reference目标、类型、字段身份改变和对象类型删除',async()=>{
 const f=await fixture(),reference={...f.definition,fields:[{...f.definition.fields[0],type:'reference',referenceType:'ticket'}]},other={...f.definition,id:'other'}
 const page={...f.draft.candidate.pages[0],allowCreate:false,allowEdit:false}
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition:reference},{kind:'object-type',definition:other}],upsertPages:[page]}})
 const preview=await f.preview.preview(f.actor,{draftId:revised.id,expectedRevision:revised.revision})
 const first=await f.apply.apply(f.actor,{...f.input,expectedRevision:revised.revision,previewReceipt:preview.receipt});f.actor.scopeIds=[first.scope];await historical(f)
 for(const field of [{...reference.fields[0],referenceType:'other'},{...f.definition.fields[0]},{...reference.fields[0],name:'renamed'}]){
  await assert.rejects(adoptNext(f,{upsertDefinitions:[{kind:'object-type',definition:{...reference,fields:[field]}}],upsertPages:[{...page,fields:[field.name]}]}),{code:'teloa/conflict'})
 }
 await assert.rejects(adoptNext(f,{removeDefinitions:[{kind:'object-type',localId:'ticket'}],upsertPages:[{...page,objectType:'other'}]}),{code:'teloa/conflict'})
 assert.equal((await f.apply.current(f.actor,{scope:first.scope}))?.version,1)
})
