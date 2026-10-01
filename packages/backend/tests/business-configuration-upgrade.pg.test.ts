import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {homedir} from 'node:os'
import {join} from 'node:path'
import {Pool,type PoolClient} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {businessConfigurationHash} from '../src/work/business-configuration-store.ts'
import {lockBusinessConfigurationRequests} from '../src/work/business-configuration-drafts.ts'
import {lockBusinessConfiguration} from '../src/work/business-configuration-lock.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock')
 process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeBusinessSpaces(pool);await api.initializeBusinessScopes(pool);await api.initializeBusinessDefinitions(pool);await api.initializeBusinessConfigurations(pool)
 await api.initializeBusinessRuntime(pool);await api.initializeBusinessData(pool);await api.initializeBusinessWarehouse(pool);await api.initializeBusinessSnapshotReferences(pool);await api.initializeBusinessRecords(pool)
},{timeout:120000})
after(async()=>{await pool?.end();await container?.stop()})

const actor=()=>({ownerId:'upgrade-config:'+randomUUID(),scopeIds:[] as string[]})
const unavailable=async():Promise<never>=>{throw Error('配置草案不得读取外部来源')}
function services(){
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 return {drafts,records,preview:new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity),apply:new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces})}
}
async function upgrade(drafts:api.BusinessConfigurationDraftService,a:ReturnType<typeof actor>,input:unknown){
 assert.equal(typeof drafts.upgradeFormat,'function','须提供显式 v1 草案升级入口')
 return drafts.upgradeFormat(a,input)
}
async function reviseReceipt(drafts:api.BusinessConfigurationDraftService,a:ReturnType<typeof actor>,input:unknown){
 assert.equal(typeof drafts.reviseReceipt,'function','须提供按冻结格式核验的只读修订回执入口')
 return drafts.reviseReceipt(a,input)
}
async function fixture(){
 const s=services(),a=actor(),initial=await s.drafts.begin(a,{requestId:randomUUID(),title:'客户跟进'})
 const definition={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:initial.scope,title:'客户',unit:'位',lead:'持续跟进客户',sourceId:initial.candidate.sources[0]!.sourceId,fields:[{name:'state',label:'阶段',type:'enum',required:true,from:'原阶段',values:['新建','完成']},{name:'amount',label:'原金额',type:'number',required:false,from:'原金额'},{name:'note',label:'备注',type:'text',required:false,from:'原备注'}],progress:{stageField:'state',unfinished:['新建'],waitingForYou:['新建']}}
 const page={id:'customers',title:'客户记录',kind:'records',objectType:'customer',fields:['state','amount','note'],allowCreate:true,allowEdit:true,allowArchive:true}
 const reviseInput={requestId:randomUUID(),draftId:initial.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[page],homePageId:'customers'}}
 const draft=await s.drafts.revise(a,reviseInput)
 return {...s,a,draft,definition,page,reviseInput}
}
async function adopt(f:Awaited<ReturnType<typeof fixture>>,draft=f.draft){
 const preview=await f.preview.preview(f.a,{draftId:draft.id,expectedRevision:draft.revision})
 const result=await f.apply.apply(f.a,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:preview.receipt})
 f.a.scopeIds=[result.scope]
 return result
}
const inputFor=(draft:api.BusinessConfigurationDraft)=>({draftId:draft.id,expectedRevision:draft.revision,requestId:randomUUID()})
async function officialState(ownerId:string){
 const result:Record<string,unknown>={}
 for(const table of ['teloa_business_spaces','teloa_business_scopes','teloa_business_runtime','teloa_business_configuration_heads','teloa_business_configuration_versions','teloa_business_local_definition_heads','teloa_business_local_definitions','teloa_business_object_snapshots','teloa_business_record_receipts'])result[table]=(await pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${table} t where owner_id=$1`,[ownerId])).rows[0].rows
 return result
}

test('显式升级只改同一草案格式、revision 与真实 v2 hash，基础字段语义和全部身份保留',async()=>{
 const f=await fixture(),before=await officialState(f.a.ownerId),input=inputFor(f.draft)
 const result=await upgrade(f.drafts,f.a,input)
 assert.deepEqual(result.candidate,{...f.draft.candidate,format:'teloa.business-configuration/v2',definitions:[{kind:'object-type',definition:{...f.definition,format:'teloa.business-object-type/v2'}}]})
 assert.equal(result.id,f.draft.id);assert.equal(result.ownerId,f.a.ownerId);assert.equal(result.scope,f.draft.scope);assert.equal(result.baseVersion,0)
 assert.equal(result.status,'draft');assert.equal(result.revision,3);assert.equal(result.createdAt,f.draft.createdAt)
 assert.notEqual(result.hash,f.draft.hash);assert.equal(result.hash,businessConfigurationHash(result.candidate))
 assert.deepEqual(await services().drafts.get(f.a,{draftId:result.id}),result)
 assert.deepEqual(await officialState(f.a.ownerId),before)
 const receipt=(await pool.query('select kind,result from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[f.a.ownerId,input.requestId])).rows[0]
 assert.equal(receipt.kind,'upgrade-format');assert.deepEqual(receipt.result,result)
})

test('升级后旧 v1 成功 revise 按冻结回执格式核验并返回原结果，原 spec_hash 字节不变',async()=>{
 const f=await fixture(),prior=(await pool.query('select spec_hash,result from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[f.a.ownerId,f.reviseInput.requestId])).rows[0]
 const upgraded=await upgrade(f.drafts,f.a,inputFor(f.draft))
 assert.deepEqual(await services().drafts.revise(f.a,f.reviseInput),f.draft)
 assert.deepEqual((await pool.query('select spec_hash,result from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[f.a.ownerId,f.reviseInput.requestId])).rows[0],prior)
 await assert.rejects(f.drafts.revise(f.a,{...f.reviseInput,patch:{...f.reviseInput.patch,upsertDefinitions:[{kind:'object-type',definition:{...f.definition,title:'不同客户'}}]}}),{code:'teloa/conflict'})
 await assert.rejects(f.drafts.revise(f.a,{...f.reviseInput,requestId:randomUUID(),expectedRevision:upgraded.revision}),{code:'teloa/invalid-input'})
 assert.deepEqual(await f.drafts.get(f.a,{draftId:f.draft.id}),upgraded)
})

test('升级回执跨服务重建和后续 v2 修订保持冻结；新升级请求拒绝已是 v2 的草案',async()=>{
 const f=await fixture(),input=inputFor(f.draft),result=await upgrade(f.drafts,f.a,input)
 await f.drafts.revise(f.a,{draftId:f.draft.id,expectedRevision:result.revision,requestId:randomUUID(),patch:{title:'继续设计'}})
 assert.deepEqual(await upgrade(services().drafts,f.a,{...input,draftId:input.draftId.toUpperCase(),requestId:input.requestId.toUpperCase()}),result)
 await assert.rejects(upgrade(f.drafts,f.a,{...input,expectedRevision:input.expectedRevision+1}),{code:'teloa/conflict'})
 const next=inputFor(await f.drafts.get(f.a,{draftId:f.draft.id}))
 await assert.rejects(upgrade(f.drafts,f.a,next),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select 1 from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[f.a.ownerId,next.requestId])).rowCount,0)
 assert.equal((await f.drafts.get(f.a,{draftId:f.draft.id})).revision,4)
})

test('升级入口严格验证三键、归属与 CAS，失败不增加 revision 或回执',async()=>{
 const f=await fixture(),input=inputFor(f.draft)
 for(const value of [null,[],{...input,format:'teloa.business-configuration/v2'},{draftId:input.draftId,requestId:input.requestId},{...input,draftId:'bad'},{...input,requestId:'bad'},{...input,expectedRevision:0},{...input,expectedRevision:1.1}])await assert.rejects(upgrade(f.drafts,f.a,value),{code:'teloa/invalid-input'})
 await assert.rejects(upgrade(f.drafts,actor(),input),{code:'teloa/forbidden'})
 await assert.rejects(upgrade(f.drafts,f.a,{...input,expectedRevision:1}),{code:'teloa/version-conflict'})
 await assert.rejects(upgrade(f.drafts,f.a,{...input,requestId:f.reviseInput.requestId}),{code:'teloa/conflict'})
 assert.deepEqual(await f.drafts.get(f.a,{draftId:f.draft.id}),f.draft)
 assert.equal((await pool.query('select 1 from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[f.a.ownerId,input.requestId])).rowCount,0)
})

test('修改已采用业务的 v1 草案可升级且不改正式配置，失去授权后不得读取升级或旧修订回执',async()=>{
 const f=await fixture();await adopt(f)
 const draft=await f.drafts.begin(f.a,{requestId:randomUUID(),scope:f.draft.scope,title:'继续调整'})
 const revisedInput={draftId:draft.id,expectedRevision:1,requestId:randomUUID(),patch:{title:'保持语义'}}
 const revised=await f.drafts.revise(f.a,revisedInput),before=await officialState(f.a.ownerId),input=inputFor(revised)
 const result=await upgrade(f.drafts,f.a,input)
 assert.equal(result.baseVersion,1);assert.equal(result.scope,draft.scope)
 assert.deepEqual(result.candidate.sources,draft.candidate.sources);assert.deepEqual(result.candidate.pages,draft.candidate.pages)
 assert.deepEqual(await officialState(f.a.ownerId),before)
 await assert.rejects(upgrade(f.drafts,{...f.a,scopeIds:[]},input),{code:'teloa/forbidden'})
 await assert.rejects(f.drafts.revise({...f.a,scopeIds:[]},revisedInput),{code:'teloa/forbidden'})
 await assert.rejects(upgrade(f.drafts,{...f.a,scopeIds:[]},{...input,requestId:randomUUID(),expectedRevision:result.revision}),{code:'teloa/forbidden'})
})

test('已采用草案的新升级请求拒绝，首次新建的成功升级回执在采用后仍受当前范围授权约束',async()=>{
 const f=await fixture(),input=inputFor(f.draft),result=await upgrade(f.drafts,f.a,input)
 await adopt(f,result)
 assert.deepEqual(await upgrade(f.drafts,f.a,input),result)
 await assert.rejects(upgrade(f.drafts,{...f.a,scopeIds:[]},input),{code:'teloa/forbidden'})
 await assert.rejects(f.drafts.revise({...f.a,scopeIds:[]},f.reviseInput),{code:'teloa/forbidden'})
 const next={...input,requestId:randomUUID(),expectedRevision:result.revision}
 await assert.rejects(upgrade(f.drafts,f.a,next),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select 1 from teloa_business_configuration_receipts where owner_id=$1 and request_id=$2',[f.a.ownerId,next.requestId])).rowCount,0)
 const legacy=await fixture();await adopt(legacy)
 await assert.rejects(upgrade(legacy.drafts,legacy.a,inputFor(legacy.draft)),{code:'teloa/version-conflict'})
})

async function blockedBy(client:PoolClient,count=1){
 const pid=(await client.query('select pg_backend_pid() pid')).rows[0].pid
 for(let n=0;n<2000;n++){
  if(((await pool.query('select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))',[pid])).rowCount??0)>=count)return
  await new Promise<void>(resolve=>setImmediate(resolve))
 }
 throw Error('未观察到 PG 锁屏障')
}
test('同请求并发升级在本人锁后只写一次；升级与修订在范围锁后共享 CAS',async()=>{
 const f=await fixture(),input=inputFor(f.draft),block=await pool.connect()
 try{
  await block.query('begin');await lockBusinessConfigurationRequests(block,f.a.ownerId)
  const pending=Promise.all([upgrade(f.drafts,f.a,input),upgrade(services().drafts,f.a,input)])
  await blockedBy(block,2);await block.query('commit')
  const results=await pending;assert.deepEqual(results[0],results[1]);assert.equal(results[0]!.revision,3)
 }finally{await block.query('rollback').catch(()=>{});block.release()}
 assert.equal((await pool.query("select count(*)::int n from teloa_business_configuration_receipts where owner_id=$1 and kind='upgrade-format'",[f.a.ownerId])).rows[0].n,1)
 const race=await fixture(),scopeBlock=await pool.connect()
 try{
  await scopeBlock.query('begin');await lockBusinessConfiguration(scopeBlock,race.a.ownerId,race.draft.scope)
  const first=upgrade(race.drafts,race.a,inputFor(race.draft))
  await blockedBy(scopeBlock)
  const second=race.drafts.revise(race.a,{draftId:race.draft.id,expectedRevision:race.draft.revision,requestId:randomUUID(),patch:{title:'竞争修订'}})
  const pending=Promise.allSettled([first,second]);await scopeBlock.query('commit')
  const results=await pending
  assert.equal(results[0]!.status,'fulfilled');assert.equal(results[1]!.status,'rejected')
  assert.equal(results[1]!.status==='rejected'&&results[1]!.reason.code,'teloa/version-conflict')
  assert.equal((await race.drafts.get(race.a,{draftId:race.draft.id})).revision,3)
 }finally{await scopeBlock.query('rollback').catch(()=>{});scopeBlock.release()}
})

test('升级保留既有看板、组件与首页；尚不支持的 v2 SQL组件预览拒绝且不写正式状态',async()=>{
 const f=await fixture(),widget={format:'teloa.business-widget/v1',id:'count',version:'1.0.0',domain:f.draft.scope,title:'客户数',kind:'metric',query:'select count(*) as count from customer',metric:{valueColumn:'count'}}
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:f.draft.scope,title:'总览',widgets:['count'],layout:[{widget:'count',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:3600},acknowledgeShortInterval:false}
 const draft=await f.drafts.revise(f.a,{draftId:f.draft.id,expectedRevision:f.draft.revision,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'widget',definition:widget},{kind:'dashboard',definition:dashboard}],upsertPages:[{id:'overview',title:'总览',kind:'dashboard',dashboardId:'overview'}],homePageId:'overview'}})
 const result=await upgrade(f.drafts,f.a,inputFor(draft))
 assert.deepEqual(result.candidate.pages,draft.candidate.pages);assert.equal(result.candidate.homePageId,'overview')
 assert.deepEqual(result.candidate.definitions.filter(item=>item.kind!=='object-type'),draft.candidate.definitions.filter(item=>item.kind!=='object-type'))
 const before=await draftState(f.a.ownerId)
 await assert.rejects(f.preview.preview(f.a,{draftId:result.id,expectedRevision:result.revision}),{code:'teloa/dependency-unavailable',details:{path:'definitions.widget.count'}})
 assert.deepEqual(await f.drafts.get(f.a,{draftId:result.id}),result)
 assert.deepEqual(await draftState(f.a.ownerId),before)
})

test('升级后的v2视图看板可预览和采用，SQL组件候选仍拒绝并保留全部正式状态',async()=>{
 const f=await fixture(),scope=f.draft.scope
 const view={format:'teloa.business-view/v1',id:'counts',version:'1.0.0',domain:scope,title:'阶段统计',kind:'distribution',chart:'bar',objectType:'customer',dimension:{field:'state',limit:2},measures:[{id:'total',label:'位',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:2}
 const widget={format:'teloa.business-widget/v1',id:'count',version:'1.0.0',domain:scope,title:'阶段统计',kind:'view-ref',viewRef:'counts'}
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'总览',widgets:['count'],layout:[{widget:'count',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:3600},acknowledgeShortInterval:false}
 const draft=await f.drafts.revise(f.a,{draftId:f.draft.id,expectedRevision:f.draft.revision,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'view',definition:view},{kind:'widget',definition:widget},{kind:'dashboard',definition:dashboard}],upsertPages:[{id:'overview',title:'总览',kind:'dashboard',dashboardId:'overview'}],homePageId:'overview'}})
 const upgraded=await upgrade(f.drafts,f.a,inputFor(draft)),adopted=await adopt(f,upgraded)
 assert.equal(adopted.version,1)
 const sqlDraft=await f.drafts.begin(f.a,{requestId:randomUUID(),scope,title:'不支持的SQL组件'})
 const revised=await f.drafts.revise(f.a,{requestId:randomUUID(),draftId:sqlDraft.id,expectedRevision:sqlDraft.revision,patch:{upsertDefinitions:[{kind:'widget',definition:{format:widget.format,id:widget.id,version:widget.version,domain:scope,title:widget.title,kind:'metric',query:'select count(*) as count from customer',metric:{valueColumn:'count'}}}]}})
 const before=await draftState(f.a.ownerId)
 await assert.rejects(f.preview.preview(f.a,{draftId:revised.id,expectedRevision:revised.revision}),{code:'teloa/dependency-unavailable',details:{path:'definitions.widget.count'}})
 assert.deepEqual(await draftState(f.a.ownerId),before)
})

async function draftState(ownerId:string){
 const result:Record<string,unknown>=await officialState(ownerId)
 for(const table of ['teloa_business_configuration_drafts','teloa_business_configuration_receipts'])result[table]=(await pool.query(`select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text),'[]'::jsonb) rows from ${table} t where owner_id=$1`,[ownerId])).rows[0].rows
 return result
}
test('只读修订回执在升级后返回冻结 v1 结果，未命中返回 undefined 且不解析猜测格式或写入',async()=>{
 const f=await fixture();await upgrade(f.drafts,f.a,inputFor(f.draft))
 const before=await draftState(f.a.ownerId)
 assert.deepEqual(await reviseReceipt(services().drafts,f.a,{...f.reviseInput,draftId:f.reviseInput.draftId.toUpperCase(),requestId:f.reviseInput.requestId.toUpperCase()}),f.draft)
 assert.equal(await reviseReceipt(f.drafts,f.a,{...f.reviseInput,requestId:randomUUID()}),undefined)
 assert.equal(await reviseReceipt(f.drafts,actor(),f.reviseInput),undefined)
 assert.deepEqual(await draftState(f.a.ownerId),before)
})

test('只读修订回执严格验证四键身份和原 spec_hash，跨操作或异内容冲突',async()=>{
 const f=await fixture(),input=f.reviseInput
 for(const value of [null,[],{...input,format:'teloa.business-configuration/v1'},{draftId:input.draftId,expectedRevision:1,requestId:input.requestId},{...input,draftId:'bad'},{...input,requestId:'bad'},{...input,expectedRevision:0},{...input,expectedRevision:1.1}])await assert.rejects(reviseReceipt(f.drafts,f.a,value),{code:'teloa/invalid-input'})
 await assert.rejects(reviseReceipt(f.drafts,{...f.a,ownerId:'  bad'},input),{code:'teloa/forbidden'})
 const upgradeInput=inputFor(f.draft);await upgrade(f.drafts,f.a,upgradeInput)
 await assert.rejects(reviseReceipt(f.drafts,f.a,{...input,requestId:upgradeInput.requestId}),{code:'teloa/conflict'})
 await assert.rejects(reviseReceipt(f.drafts,f.a,{...input,expectedRevision:2}),{code:'teloa/conflict'})
 await assert.rejects(reviseReceipt(f.drafts,f.a,{...input,draftId:randomUUID()}),{code:'teloa/conflict'})
 await assert.rejects(reviseReceipt(f.drafts,f.a,{...input,patch:{title:'异内容'}}),{code:'teloa/conflict'})
})

test('只读修订回执核对冻结结果的草案身份、revision、scope 与真实 candidate hash',async()=>{
 const f=await fixture(),before=await draftState(f.a.ownerId)
 const wrongScope='business_0123456789abcdef0123456789abcdef'
 const candidate={...f.draft.candidate,scope:wrongScope,definitions:f.draft.candidate.definitions.map(item=>({...item,definition:{...item.definition,domain:wrongScope}}))}
 const cases=[{...f.draft,id:randomUUID()},{...f.draft,revision:3},{...f.draft,scope:wrongScope,candidate,hash:businessConfigurationHash(candidate)},{...f.draft,hash:'a'.repeat(64)}]
 for(const result of cases){
  await pool.query('update teloa_business_configuration_receipts set result=$3 where owner_id=$1 and request_id=$2',[f.a.ownerId,f.reviseInput.requestId,JSON.stringify(result)])
  await assert.rejects(reviseReceipt(f.drafts,f.a,f.reviseInput),{code:'teloa/storage-corrupt'})
 }
 await pool.query('update teloa_business_configuration_receipts set result=$3 where owner_id=$1 and request_id=$2',[f.a.ownerId,f.reviseInput.requestId,JSON.stringify(f.draft)])
 assert.deepEqual(await draftState(f.a.ownerId),before)
})

test('只读修订回执重新核对当前草案授权与 hash，不因首次草案曾无范围授权而绕过',async()=>{
 const f=await fixture(),upgraded=await upgrade(f.drafts,f.a,inputFor(f.draft));await adopt(f,upgraded)
 assert.deepEqual(await reviseReceipt(f.drafts,f.a,f.reviseInput),f.draft)
 await assert.rejects(reviseReceipt(f.drafts,{...f.a,scopeIds:[]},f.reviseInput),{code:'teloa/forbidden'})
 await pool.query("update teloa_business_configuration_drafts set hash=repeat('a',64) where owner_id=$1 and id=$2",[f.a.ownerId,f.draft.id])
 await assert.rejects(reviseReceipt(f.drafts,f.a,f.reviseInput),{code:'teloa/storage-corrupt'})
})

test('真实 v1 记录经同草案升级与可选富字段采用后原快照不变，同 RecordService 编辑大金额、多选并保留旧历史',async()=>{
 const f=await fixture();await adopt(f)
 const createInput={scope:f.draft.scope,type:'customer',requestId:randomUUID(),title:'已有客户',summary:'原业务记录',fields:[{name:'state',value:'新建'},{name:'amount',value:'42.5'},{name:'note',value:'旧备注'}]}
 const first=await f.records.create(f.a,createInput)
 const originalRows=(await pool.query('select * from teloa_business_object_snapshots where owner_id=$1 and object_id=$2 order by object_version',[f.a.ownerId,first.id])).rows
 let draft=await f.drafts.begin(f.a,{requestId:randomUUID(),scope:f.draft.scope,title:'客户跟进'})
 assert.equal(draft.candidate.format,'teloa.business-configuration/v1');assert.equal(draft.baseVersion,1)
 const originalId=draft.id,originalSources=draft.candidate.sources
 draft=await upgrade(f.drafts,f.a,inputFor(draft))
 assert.equal(draft.id,originalId);assert.equal(draft.scope,first.scope);assert.equal(draft.baseVersion,1);assert.deepEqual(draft.candidate.sources,originalSources)
 const payment={format:'teloa.business-rich-field/v2',name:'payment',label:'付款金额',type:'money',required:false,from:'新付款金额',currencies:['CNY']}
 const tags={format:'teloa.business-rich-field/v2',name:'tags',label:'客户标签',type:'multi-enum',required:false,from:'新客户标签',values:['重要','需回访','续约']}
 const definition={...f.definition,format:'teloa.business-object-type/v2',fields:[...f.definition.fields,payment,tags]}
 draft=await f.drafts.revise(f.a,{draftId:draft.id,expectedRevision:draft.revision,requestId:randomUUID(),patch:{upsertDefinitions:[{kind:'object-type',definition}],upsertPages:[{...f.page,fields:[...f.page.fields,'payment','tags']}]}})
 const adopted=await adopt(f,draft)
 assert.equal(adopted.version,2)
 assert.deepEqual((await pool.query('select * from teloa_business_object_snapshots where owner_id=$1 and object_id=$2 order by object_version',[f.a.ownerId,first.id])).rows,originalRows)
 assert.deepEqual(await f.records.get(f.a,{scope:first.scope,type:first.type,id:first.id}),first)
 assert.deepEqual(first.fields,[{label:'原阶段',value:'新建'},{label:'原金额',value:'42.5'},{label:'原备注',value:'旧备注'}])
 assert.equal(first.fields.some(field=>field.label==='新付款金额'||field.label==='新客户标签'),false)
 const money='{"currency":"CNY","decimal":"9007199254740993.0001"}',multi='["重要","续约"]'
 const second=await f.records.edit(f.a,{scope:first.scope,type:first.type,id:first.id,expectedVersion:1,requestId:randomUUID(),fields:[...createInput.fields,{name:'payment',value:money},{name:'tags',value:multi}]})
 assert.equal(second.id,first.id);assert.equal(second.version,2)
 assert.deepEqual(second.fields,[...first.fields,{label:'新付款金额',value:money},{label:'新客户标签',value:multi}])
 assert.deepEqual(await services().records.get(f.a,{scope:first.scope,type:first.type,id:first.id}),second)
 assert.deepEqual(await services().records.get(f.a,{scope:first.scope,type:first.type,id:first.id,version:1}),first)
 assert.deepEqual(await f.records.create(f.a,createInput),first)
 assert.deepEqual((await pool.query('select * from teloa_business_object_snapshots where owner_id=$1 and object_id=$2 and object_version=1',[f.a.ownerId,first.id])).rows,originalRows)
})
