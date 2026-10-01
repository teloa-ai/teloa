import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {readBusinessConfigurationCandidate,readBusinessConfigurationManifest,readBusinessConfigurationPageProjection} from '@teloa/contract'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {BusinessConfigurationStore,businessConfigurationHash,initializeBusinessConfigurations} from '../src/work/business-configuration-store.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {prepareBusinessConfigurationDefinition} from '../src/work/business-definition-write.ts'
import {initializeBusinessDefinitions} from '../src/work/business-definition-local.ts'
import {initializeBusinessScopes,BusinessScopeService} from '../src/work/business-scopes.ts'
import {initializeBusinessSpaces,BusinessSpaceService} from '../src/work/business-spaces.ts'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {dashboardOf} from './business-widget-fixture.ts'
import {BusinessSyncService} from '../src/work/business-sync.ts'
import {initializeBusinessSyncRules} from '../src/work/business-sync-rules.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const scope='business_0123456789abcdef0123456789abcdef'
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await initializeBusinessSpaces(pool);await initializeBusinessScopes(pool);await initializeBusinessDefinitions(pool);await initializeBusinessConfigurations(pool)
 await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessRecords(pool)
 await api.initializeBusinessWidgets(pool)
 await api.initializeBusinessSync(pool);await initializeBusinessSyncRules(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const actor=()=>({ownerId:'v2-config:'+randomUUID(),scopeIds:[] as string[]})
function objectType(domain:string,sourceId:string){return {format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain,title:'客户',unit:'位',lead:'客户跟进',sourceId,fields:[{name:'state',label:'阶段',type:'enum',required:true,from:'原阶段',values:['新建','完成']},{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'原金额',currencies:['CNY']}]}}
const page={id:'customers',title:'客户记录',kind:'records',objectType:'customer',fields:['state','amount'],allowCreate:false,allowEdit:false,allowArchive:true}

test('v2 草案须显式请求格式；修订、CAS、重建读取保留原文与摘要，v1 入口拒收',async()=>{
 const a=actor(),drafts=new BusinessConfigurationDraftService(pool,identity)
 const legacy=await drafts.begin(a,{requestId:randomUUID(),title:'旧业务'})
 assert.equal(legacy.candidate.format,'teloa.business-configuration/v1')
 let draft=await drafts.begin(a,{requestId:randomUUID(),title:'客户跟进',format:'teloa.business-configuration/v2'})
 assert.equal(draft.candidate.format,'teloa.business-configuration/v2')
 const definition=objectType(draft.scope,draft.candidate.sources[0]!.sourceId)
 draft=await drafts.revise(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page],homePageId:'customers'}})
 assert.deepEqual(draft.candidate.definitions,[{kind:'object-type',definition}])
 assert.equal(draft.hash,businessConfigurationHash(draft.candidate))
 assert.deepEqual(await new BusinessConfigurationDraftService(pool,identity).get(a,{draftId:draft.id}),draft)
 assert.throws(()=>readBusinessConfigurationCandidate(draft.candidate),{code:'teloa/invalid-input'})
 await assert.rejects(drafts.revise(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{title:'过期'}}),{code:'teloa/version-conflict'})
 await assert.rejects(drafts.revise(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:2,patch:{upsertDefinitions:[{kind:'object-type',definition:{...definition,format:'teloa.business-object-type/v1'}}]}}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_scopes where owner_id=$1',[a.ownerId])).rows[0].n,0)
})

test('v2 固定 Manifest 与真实叶子正文同 hash 读取；旧 Manifest reader 与篡改正文拒收',async()=>{
 const a=actor(),store=new BusinessConfigurationStore(pool),space=await new BusinessSpaceService(pool,identity).ensurePersonal(a.ownerId)
 const definition=objectType(scope,'records'),leaf=prepareBusinessConfigurationDefinition(scope,'object-type',definition,'teloa.business-configuration/v2')
 const manifest={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:leaf.definitionHash}],pages:[page],homePageId:'customers'}
 const db=await pool.connect()
 try{
  await db.query('begin')
  await BusinessScopeService.ensure(db,a.ownerId,{scope,title:'客户跟进',kind:'domain',spaceId:space.id})
  await db.query('insert into teloa_business_local_definitions(owner_id,scope_id,kind,local_id,version,semver,definition_hash,body_hash,body,draft_id,created_at) values($1,$2,$3,$4,1,$5,$6,$7,$8,$9,now())',[a.ownerId,scope,'object-type','customer',leaf.semver,leaf.definitionHash,leaf.bodyHash,leaf.body,randomUUID()])
  await db.query('insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,$2,$3,$4,1,1,now())',[a.ownerId,scope,'object-type','customer'])
  await db.query('insert into teloa_business_configuration_versions(owner_id,scope_id,version,manifest,hash,created_at) values($1,$2,1,$3,$4,now())',[a.ownerId,scope,JSON.stringify(manifest),businessConfigurationHash(manifest)])
  await db.query('insert into teloa_business_configuration_heads(owner_id,scope_id,version,updated_at) values($1,$2,1,now())',[a.ownerId,scope])
  await db.query('update teloa_business_scopes set configuration_managed=true where owner_id=$1 and scope=$2',[a.ownerId,scope])
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
 const read=await pool.connect()
 try{
  const current=await store.currentInTransaction(read,a.ownerId,scope)
  assert.deepEqual(current?.manifest,manifest)
  assert.equal(current?.leaves[0]?.body,leaf.body)
 }finally{read.release()}
 assert.throws(()=>readBusinessConfigurationManifest(manifest),{code:'teloa/invalid-input'})
 await pool.query("update teloa_business_local_definitions set body=jsonb_set(body::jsonb,'{title}',to_jsonb('已篡改'::text))::text where owner_id=$1",[a.ownerId])
 const damaged=await pool.connect()
 try{await assert.rejects(store.currentInTransaction(damaged,a.ownerId,scope),{code:'teloa/storage-corrupt'})}finally{damaged.release()}
})

const unavailable=async():Promise<never>=>{throw Error('不得访问市场或远端来源')}
function services(){
 const drafts=new BusinessConfigurationDraftService(pool,identity),store=new BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new BusinessSpaceService(pool,identity)
 const preview=new BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const apply=new BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces})
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 return {drafts,store,definitions,runtime,spaces,preview,apply,records}
}
async function fixture(){
 const a=actor(),s=services(),{drafts}=s
 let draft=await drafts.begin(a,{requestId:randomUUID(),title:'客户跟进',format:'teloa.business-configuration/v2'})
 const definition={...objectType(draft.scope,draft.candidate.sources[0]!.sourceId),fields:[...objectType(draft.scope,draft.candidate.sources[0]!.sourceId).fields,{format:'teloa.business-rich-field/v2',name:'tags',label:'标签',type:'multi-enum',required:false,from:'原标签',values:['重要','需回访','续约']}]}
 draft=await drafts.revise(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[{...page,fields:['state','amount','tags'],allowCreate:true,allowEdit:true}],homePageId:'customers'}})
 const preview=await s.preview.preview(a,{draftId:draft.id,expectedRevision:draft.revision})
 const input={requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:preview.receipt}
 return {...s,a,draft,definition,input,previewResult:preview}
}
async function adopt(f:Pick<Awaited<ReturnType<typeof fixture>>,'a'|'apply'|'input'>){
 const result=await f.apply.apply(f.a,f.input);f.a.scopeIds=[result.scope];return result
}
const money='{"currency":"CNY","decimal":"9007199254740993.0001"}'
const tags='["重要","续约"]'
function createInput(scope:string){return {scope,type:'customer',requestId:randomUUID(),title:'客户一',summary:'',fields:[{name:'state',value:'新建'},{name:'amount',value:money},{name:'tags',value:tags}]}}
test('v2 真实预览、原子采用、重建回执保留真实正文，旧来源读取明确拒收',async()=>{
 const f=await fixture(),result=await adopt(f)
 assert.equal(f.previewResult.candidateHash,f.draft.hash)
 assert.equal(result.version,1)
 assert.deepEqual(await services().apply.receipt(f.a,{requestId:f.input.requestId}),result)
 assert.deepEqual(await services().apply.apply(f.a,f.input),result)
 const current=await f.apply.current(f.a,{scope:result.scope})
 assert.equal(current?.manifest.format,'teloa.business-configuration/v2')
 assert.deepEqual(JSON.parse(current!.leaves[0]!.body),f.definition)
 const db=await pool.connect()
 try{
  await assert.rejects(f.definitions.forScope(db,f.a.ownerId,result.scope),{code:'teloa/dependency-unavailable'})
  await assert.rejects(f.definitions.forConfigurationCandidate(db,f.a.ownerId,f.draft.candidate),{code:'teloa/invalid-input'})
 }finally{db.release()}
 assert.equal((await f.runtime.get(f.a,result.scope)).syncEnabled,false)
})
test('v2 普通字段映射经正式预览采用后由同一 Reader 与调度读取，默认暂停',async()=>{
 const a=actor(),s=services()
 let draft=await s.drafts.begin(a,{requestId:randomUUID(),title:'普通客户同步',format:'teloa.business-configuration/v2'})
 const object={...objectType(draft.scope,draft.candidate.sources[0]!.sourceId),fields:[objectType(draft.scope,draft.candidate.sources[0]!.sourceId).fields[0]]}
 const mapping={format:'teloa.business-source-mapping/v1',id:'customer-sync',version:'1.0.0',domain:draft.scope,title:'客户同步',objectType:'customer',source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
 draft=await s.drafts.revise(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:object},{kind:'source-mapping',definition:mapping}],upsertPages:[{...page,fields:['state']}],homePageId:'customers'}})
 const preview=await s.preview.preview(a,{draftId:draft.id,expectedRevision:draft.revision})
 const result=await s.apply.apply(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:preview.receipt})
 a.scopeIds=[result.scope]
 const current=await s.apply.current(a,{scope:result.scope})
 assert.ok(current?.leaves.some(leaf=>leaf.kind==='source-mapping'))
 let calls=0
 const sync=new BusinessSyncService(pool,identity,s.definitions,new api.BusinessWarehouseService(pool,identity),async()=>({key:'security-alert-http',fetch:async()=>{calls++;return {items:[{state:'新建'}],capturedAt:identity.now()}}}))
 assert.deepEqual(await sync.mappings(a,result.scope),[mapping])
 assert.equal((await sync.rules.get(a,{scope:result.scope,mappingId:mapping.id})).enabled,false)
 assert.deepEqual(await sync.due(a.ownerId,identity.now()),[])
 await s.runtime.setSync(a,{scope:result.scope,enabled:true,expectedRevision:1,requestId:randomUUID()})
 await sync.rules.set(a,{scope:result.scope,mappingId:mapping.id,enabled:true,expectedRevision:0,requestId:randomUUID()})
 assert.deepEqual(await sync.due(a.ownerId,identity.now()),[{scope:result.scope,mappingId:mapping.id}])
 assert.equal((await sync.run(a,{scope:result.scope,mappingId:mapping.id,trigger:'schedule'})).status,'ok')
 assert.equal(calls,1)
})
test('v2 富字段目标映射在预览拒绝，正式配置与运行状态零写',async()=>{
 const a=actor(),s=services()
 let draft=await s.drafts.begin(a,{requestId:randomUUID(),title:'富字段不得旧同步',format:'teloa.business-configuration/v2'})
 const object=objectType(draft.scope,draft.candidate.sources[0]!.sourceId)
 const mapping={format:'teloa.business-source-mapping/v1',id:'customer-sync',version:'1.0.0',domain:draft.scope,title:'客户同步',objectType:'customer',source:{kind:'business-data-port',sourceId:'security-alert-http'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:60},acknowledgeShortInterval:false}
 draft=await s.drafts.revise(a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:object},{kind:'source-mapping',definition:mapping}],upsertPages:[page],homePageId:'customers'}})
 await assert.rejects(s.preview.preview(a,{draftId:draft.id,expectedRevision:draft.revision}),{code:'teloa/invalid-input'})
 for(const table of ['teloa_business_scopes','teloa_business_runtime','teloa_business_configuration_heads','teloa_business_local_definitions'])assert.equal((await pool.query(`select count(*)::int n from ${table} where owner_id=$1`,[a.ownerId])).rows[0].n,0,table)
})
test('v2 采用末尾失败将 scope、固定叶子、head、草案状态与回执全部回滚',async()=>{
 const f=await fixture()
 f.definitions.forScopeVersioned=async()=>{throw Error('固定正文复核失败')}
 await assert.rejects(f.apply.apply(f.a,f.input),/固定正文复核失败/)
 for(const table of ['teloa_business_scopes','teloa_business_runtime','teloa_business_configuration_heads','teloa_business_configuration_versions','teloa_business_local_definition_heads','teloa_business_local_definitions'])assert.equal((await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[f.a.ownerId])).rows[0].n,0,table)
 assert.equal(await f.apply.receipt(f.a,{requestId:f.input.requestId}),undefined)
 assert.equal((await f.drafts.get(f.a,{draftId:f.draft.id})).status,'draft')
})
test('同一 RecordService 保留超安全整数金额、多选原值，重试、历史、列表、归档与重建不改写',async()=>{
 const f=await fixture();await adopt(f)
 const input=createInput(f.draft.scope),first=await f.records.create(f.a,input)
 assert.deepEqual(first.fields,[{label:'原阶段',value:'新建'},{label:'原金额',value:money},{label:'原标签',value:tags}])
 assert.deepEqual(await services().records.create(f.a,input),first)
 assert.deepEqual((await f.records.list(f.a,{scope:first.scope,type:first.type,limit:10})).items,[first])
 const edit={scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'完成'},{name:'amount',value:'{"currency":"CNY","decimal":"-1.25"}'},{name:'tags',value:'["需回访"]'}]}
 const second=await f.records.edit(f.a,edit)
 assert.equal(second.version,2)
 assert.equal(second.fields[1]?.value,'{"currency":"CNY","decimal":"-1.25"}')
 const archived=await f.records.archive(f.a,{scope:first.scope,type:first.type,id:first.id,expectedVersion:2,requestId:randomUUID()})
 assert.equal(archived.version,3);assert.ok(archived.deletedAt)
 assert.deepEqual(await services().records.get(f.a,{scope:first.scope,type:first.type,id:first.id,version:1}),first)
 assert.deepEqual(await services().records.receipt(f.a,{requestId:edit.requestId}),second)
 assert.equal((await f.records.list(f.a,{scope:first.scope,type:first.type,limit:10})).items.length,0)
})
test('v2 非规范金额和多选写入拒收；同请求与编辑 CAS 竞争不重复快照',async()=>{
 const f=await fixture();await adopt(f)
 const input=createInput(f.draft.scope)
 for(const fields of [input.fields.map(field=>field.name==='amount'?{...field,value:'{"currency":"CNY","decimal":"1.00"}'}:field),input.fields.map(field=>field.name==='tags'?{...field,value:'["续约","重要"]'}:field),input.fields.map(field=>field.name==='tags'?{...field,value:'["重要","重要"]'}:field)])await assert.rejects(f.records.create(f.a,{...input,requestId:randomUUID(),fields}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[f.a.ownerId])).rows[0].n,0)
 const repeated=await Promise.all([f.records.create(f.a,input),f.records.create(f.a,input)])
 assert.deepEqual(repeated[0],repeated[1])
 const first=repeated[0]!,edit={scope:first.scope,type:first.type,id:first.id,expectedVersion:1,fields:input.fields}
 const results=await Promise.allSettled([f.records.edit(f.a,{...edit,requestId:randomUUID()}),f.records.edit(f.a,{...edit,requestId:randomUUID()})])
 assert.equal(results.filter(result=>result.status==='fulfilled').length,1)
 assert.equal(results.filter(result=>result.status==='rejected'&&result.reason.code==='teloa/version-conflict').length,1)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[f.a.ownerId])).rows[0].n,2)
})
test('v2 采用复核全部固定历史：币种移除和选项重排不可让旧原值失效',async()=>{
 const f=await fixture();await adopt(f);await f.records.create(f.a,createInput(f.draft.scope))
 for(const fields of [f.definition.fields.map(field=>field.type==='money'?{...field,currencies:['USD']}:field),f.definition.fields.map(field=>field.type==='multi-enum'?{...field,values:['续约','需回访','重要']}:field)]){
  let draft=await f.drafts.begin(f.a,{requestId:randomUUID(),title:'客户跟进',scope:f.draft.scope,format:'teloa.business-configuration/v2'})
  draft=await f.drafts.revise(f.a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.definition,fields}}]}})
  const preview=await f.preview.preview(f.a,{draftId:draft.id,expectedRevision:draft.revision})
  await assert.rejects(f.apply.apply(f.a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:1,previewReceipt:preview.receipt}),{code:'teloa/conflict'})
 }
 assert.equal((await f.apply.current(f.a,{scope:f.draft.scope}))?.version,1)
})
test('真实固定配置的 v2 记录页预览与正式页面读取保留金额、多选定义，旧投影拒收',async()=>{
 const f=await fixture(),pages=new api.BusinessConfigurationPageService(pool,identity,{drafts:f.drafts,store:f.store,definitions:f.definitions,executor:{schema:'public',execute:unavailable}} as never)
 const preview=await pages.preview(f.a,{draftId:f.draft.id,expectedRevision:f.draft.revision,pageId:'customers'})
 assert.equal('format' in preview&&preview.format,'teloa.business-configuration-page/v2')
 assert.deepEqual(preview.page.kind==='records'&&preview.page.objectType,f.definition)
 const adopted=await adopt(f),saved=await pages.read(f.a,{scope:adopted.scope,pageId:'customers'})
 assert.equal('format' in saved&&saved.format,'teloa.business-configuration-page/v2')
 assert.equal(saved.configurationHash,adopted.configurationHash)
 assert.deepEqual(saved.page.kind==='records'&&saved.page.objectType,f.definition)
 assert.throws(()=>readBusinessConfigurationPageProjection(saved),{code:'teloa/invalid-host-response'})
})
test('v2 批次复用统一写入口：后项非法全批回滚；已保存金额快照被篡改即拒读',async()=>{
 const f=await fixture();await adopt(f)
 const input=createInput(f.draft.scope),{scope:_,type,requestId:__,...body}=input
 await assert.rejects(f.records.batch(f.a,{scope:input.scope,requestId:randomUUID(),operations:[{operation:'create',type,...body},{operation:'create',type,...body,fields:body.fields.map(field=>field.name==='amount'?{...field,value:'{"currency":"CNY","decimal":"1e3"}'}:field)}]}),{code:'teloa/invalid-input'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1',[f.a.ownerId])).rows[0].n,0)
 const first=await f.records.create(f.a,input)
 await pool.query("update teloa_business_object_snapshots set snapshot=jsonb_set(snapshot,'{fields,1,value}',to_jsonb('已篡改'::text)) where owner_id=$1",[f.a.ownerId])
 await assert.rejects(f.records.get(f.a,{scope:first.scope,type:first.type,id:first.id}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.records.list(f.a,{scope:first.scope,type:first.type,limit:10}),{code:'teloa/storage-corrupt'})
 await assert.rejects(f.records.receipt(f.a,{requestId:input.requestId}),{code:'teloa/storage-corrupt'})
})

async function statisticsFixture(){
 const f=await fixture(),scope=f.draft.scope
 const definition={...f.definition,fields:f.definition.fields.map(field=>field.type==='money'?{...field,currencies:['CNY','USD']}:field)}
 const head={format:'teloa.business-view/v2',version:'1.0.0',domain:scope,objectType:'customer',filters:[],kind:'board-card',chart:'number',limit:1}
 const views=[
  {...head,id:'cny',title:'人民币合计',measures:[{id:'amount',label:'人民币',aggregation:'sum',field:'amount',currency:'CNY'}]},
  {...head,id:'usd',title:'美元合计',measures:[{id:'amount',label:'美元',aggregation:'sum',field:'amount',currency:'USD'}]},
  {...head,id:'members',title:'客户标签',kind:'distribution',chart:'bar',dimension:{field:'tags',limit:10},measures:[{id:'count',label:'客户数',aggregation:'count'}],sort:{by:'dimension',direction:'asc'},limit:10},
  {...head,format:'teloa.business-view/v1',id:'states',title:'客户阶段',kind:'distribution',chart:'table',dimension:{field:'state',limit:10},measures:[{id:'count',label:'客户数',aggregation:'count'}],sort:{by:'dimension',direction:'asc'},limit:10},
 ]
 const widgets=views.map(view=>({format:'teloa.business-widget/v1',id:view.id+'-widget',version:'1.0.0',domain:scope,title:view.title,kind:'view-ref',viewRef:view.id}))
 const dashboard={...dashboardOf(widgets.map(w=>w.id)),domain:scope,id:'statistics',title:'客户统计'}
 f.draft=await f.drafts.revise(f.a,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,patch:{upsertDefinitions:[{kind:'object-type',definition},...views.map(definition=>({kind:'view',definition})),...widgets.map(definition=>({kind:'widget',definition})),{kind:'dashboard',definition:dashboard}],upsertPages:[{id:'statistics',kind:'dashboard',title:'客户统计',dashboardId:'statistics'}]}})
 const preview=await f.preview.preview(f.a,{draftId:f.draft.id,expectedRevision:f.draft.revision})
 f.input={requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,expectedBaseVersion:0,previewReceipt:preview.receipt}
 const pages=new api.BusinessConfigurationPageService(pool,identity,{drafts:f.drafts,store:f.store,definitions:f.definitions,executor:{schema:'public',execute:unavailable}} as never)
 return {...f,pages,definition}
}
function typedDashboard(projection:Awaited<ReturnType<api.BusinessConfigurationPageService['read']>>){
 assert.equal('format' in projection&&projection.format,'teloa.business-configuration-page/v2')
 assert.equal(projection.page.kind,'dashboard')
 if(projection.page.kind!=='dashboard'||!('format' in projection))throw Error('须返回真实类型化看板')
 return projection.page
}
test('真实 v2 看板预览无写、原子采用后同配置计算精确币种与多选，编辑归档及旧历史保持',async()=>{
 const f=await statisticsFixture()
 const counts=async()=>Promise.all(['teloa_business_object_snapshots','teloa_business_widget_results','teloa_business_configuration_versions'].map(async table=>(await pool.query('select count(*)::int n from '+table+' where owner_id=$1',[f.a.ownerId])).rows[0].n))
 const before=await counts(),trial=typedDashboard(await f.pages.preview(f.a,{draftId:f.draft.id,expectedRevision:f.draft.revision,pageId:'statistics'}))
 assert.deepEqual(trial.results.slice(0,2).map(r=>r.view.rows[0]!.values[0]),[null,null])
 assert.deepEqual(await counts(),before)
 const applied=await adopt(f)
 const cny=await f.records.create(f.a,{...createInput(applied.scope),fields:[{name:'state',value:'新建'},{name:'amount',value:'{"currency":"CNY","decimal":"9007199254740993.0001"}'},{name:'tags',value:tags}]})
 const usd=await f.records.create(f.a,{...createInput(applied.scope),fields:[{name:'state',value:'完成'},{name:'amount',value:'{"currency":"USD","decimal":"9007199254740993.0002"}'},{name:'tags',value:tags}]})
 const read=async()=>typedDashboard(await f.pages.read(f.a,{scope:applied.scope,pageId:'statistics'}))
 const first=await read()
 assert.deepEqual(first.results.slice(0,2).map(r=>r.view.rows[0]!.values[0]),[{type:'money',currency:'CNY',decimal:'9007199254740993.0001'},{type:'money',currency:'USD',decimal:'9007199254740993.0002'}])
 assert.deepEqual(first.results[2]!.view.rows.map(r=>[r.dimension,r.values[0]]),[['续约',2],['重要',2]])
 assert.equal(first.results[2]!.view.dimensionMode,'membership')
 assert.ok(first.results.every(r=>r.view.coverage.objects===2))
 assert.equal(first.viewRefs[3]!.view.format,'teloa.business-view/v1','基础字段 v1 视图保留真实格式')
 const edit=await f.records.edit(f.a,{scope:cny.scope,type:cny.type,id:cny.id,expectedVersion:1,requestId:randomUUID(),fields:[{name:'state',value:'完成'},{name:'amount',value:'{"currency":"CNY","decimal":"9007199254740993.0003"}'},{name:'tags',value:'["需回访"]'}]})
 assert.deepEqual((await read()).results[0]!.view.rows[0]!.values[0],{type:'money',currency:'CNY',decimal:'9007199254740993.0003'})
 await f.records.archive(f.a,{scope:cny.scope,type:cny.type,id:cny.id,expectedVersion:edit.version,requestId:randomUUID()})
 const archived=await read()
 assert.equal(archived.results[0]!.view.rows[0]!.values[0],null)
 assert.deepEqual(archived.results[1]!.view.rows[0]!.values[0],{type:'money',currency:'USD',decimal:'9007199254740993.0002'})
 assert.deepEqual(archived.results[2]!.view.rows.map(r=>[r.dimension,r.values[0]]),[['续约',1],['重要',1]])
 assert.deepEqual(await services().records.get(f.a,{scope:cny.scope,type:cny.type,id:cny.id,version:1}),cny)
 assert.deepEqual(await services().records.get(f.a,{scope:usd.scope,type:usd.type,id:usd.id}),usd)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_widget_results where owner_id=$1',[f.a.ownerId])).rows[0].n,0)
})
test('类型化配置与快照身份损坏拒读，owner/scope/source 隔离及撤权保持',async()=>{
 const f=await statisticsFixture();await adopt(f)
 const first=await f.records.create(f.a,createInput(f.draft.scope))
 const other=await statisticsFixture();await adopt(other);await other.records.create(other.a,createInput(other.draft.scope))
 const input={scope:f.draft.scope,pageId:'statistics'}
 assert.equal(typedDashboard(await f.pages.read(f.a,input)).results[0]!.view.coverage.objects,1)
 await assert.rejects(f.pages.read({...f.a,scopeIds:[]},input),{code:'teloa/forbidden'})
 await assert.rejects(f.pages.read(other.a,input),{code:'teloa/forbidden'})
 await assert.rejects(f.pages.read(f.a,input,AbortSignal.abort()),{name:'AbortError'})
 await pool.query('update teloa_business_object_snapshots set source_id=$2 where owner_id=$1',[f.a.ownerId,'unrelated'])
 await assert.rejects(f.pages.read(f.a,input),{code:'teloa/storage-corrupt'})
 await pool.query('update teloa_business_object_snapshots set source_id=$2 where owner_id=$1',[f.a.ownerId,f.definition.sourceId])
 await pool.query("update teloa_business_local_definitions set body=jsonb_set(body::jsonb,'{title}',to_jsonb('损坏定义'::text))::text where owner_id=$1 and kind='view'",[f.a.ownerId])
 await assert.rejects(f.pages.read(f.a,input),{code:'teloa/storage-corrupt'})
 assert.equal(typedDashboard(await other.pages.read(other.a,{scope:other.draft.scope,pageId:'statistics'})).results[0]!.view.coverage.objects,1)
})
