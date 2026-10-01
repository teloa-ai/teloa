import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import * as api from '../src/index.ts'
import {startDatabase,riskView,dashboardOf} from './business-widget-fixture.ts'
import {BusinessSqlExecutor} from '../src/work/business-sql-executor.ts'
let state:Awaited<ReturnType<typeof startDatabase>>
const identity={id:randomUUID,now:()=>new Date().toISOString()}
before(async()=>{state=await startDatabase()},{timeout:120000})
after(async()=>{await state?.reader.end();await state?.pool.end();await state?.container.stop()})
async function fixture(){
 const pool=state.pool,actor={ownerId:randomUUID(),scopeIds:[] as string[]}
 const drafts=new api.BusinessConfigurationDraftService(pool,identity),store=new api.BusinessConfigurationStore(pool)
 let remote=0
 const unavailable=async():Promise<never>=>{remote++;throw Error('不应拉取来源')}
 const definitions=new api.BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const executor=new BusinessSqlExecutor(state.reader,identity,'role')
 const runtime=new api.BusinessRuntimeService(pool,identity),spaces=new api.BusinessSpaceService(pool,identity)
 const apply=new api.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime,spaces}),preview=new api.BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'客户业务'})
 const type={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'位',lead:'客户记录',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'stage',label:'阶段',type:'text',required:true,from:'阶段'}]}
 const view={...riskView,id:'stages',domain:draft.scope,objectType:'customer',title:'阶段统计',dimension:{field:'stage',limit:10}}
 const widget={format:'teloa.business-widget/v1',id:'stage-widget',version:'1.0.0',domain:draft.scope,title:'阶段统计',kind:'view-ref',viewRef:'stages'}
 const board={...dashboardOf(['stage-widget']),id:'overview',domain:draft.scope}
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:type},{kind:'view',definition:view},{kind:'widget',definition:widget},{kind:'dashboard',definition:board}],upsertPages:[{id:'records',title:'客户清单',kind:'records',objectType:'customer',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true},{id:'overview',title:'客户统计',kind:'dashboard',dashboardId:'overview'}],homePageId:'records'}})
 assert.equal(typeof api.BusinessConfigurationPageService,'function','须提供真实配置页面投影服务')
 const pages=new api.BusinessConfigurationPageService(pool,identity,{drafts,store,definitions,executor})
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 return {pool,actor,drafts,store,definitions,executor,apply,preview,draft,type,view,widget,board,pages,records,remote:()=>remote}
}
async function adopt(f:Awaited<ReturnType<typeof fixture>>){
 const p=await f.preview.preview(f.actor,{draftId:f.draft.id,expectedRevision:f.draft.revision})
 const result=await f.apply.apply(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:f.draft.revision,expectedBaseVersion:f.draft.baseVersion,previewReceipt:p.receipt})
 f.actor.scopeIds=[result.scope];return result
}
test('preview_and_saved_page_use_same_candidate_semantics',async()=>{
 const f=await fixture()
 const before=await f.pool.query('select count(*)::int n from teloa_business_widget_results where owner_id=$1',[f.actor.ownerId])
 const trial=await f.pages.preview(f.actor,{draftId:f.draft.id,expectedRevision:2,pageId:'overview'})
 assert.equal(trial.mode,'preview');assert.equal(trial.page.kind,'dashboard')
 if(trial.page.kind!=='dashboard'||'format' in trial)throw Error('旧配置须返回旧看板投影')
 assert.deepEqual(trial.page.results[0]!.rows,[])
 assert.equal(trial.page.viewRefs[0]!.view.chart,'bar')
 await adopt(f)
 await f.records.create(f.actor,{scope:f.draft.scope,type:'customer',requestId:randomUUID(),title:'甲客户',summary:'',fields:[{name:'stage',value:'洽谈'}]})
 const saved=await f.pages.read(f.actor,{scope:f.draft.scope,pageId:'overview'})
 if(saved.page.kind!=='dashboard'||'format' in saved)throw Error('旧配置须返回旧看板投影')
 assert.deepEqual(saved.page.results[0]!.rows,[['洽谈','洽谈',1]])
 const next=await f.drafts.begin(f.actor,{requestId:randomUUID(),title:'改版',scope:f.draft.scope})
 const changed=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:next.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{...f.type,fields:[{...f.type.fields[0],label:'销售阶段'}]}},{kind:'view',definition:{...f.view,chart:'pie',filters:[{field:'stage',op:'eq',values:['已成交']}]}}]}})
 const updated=await f.pages.preview(f.actor,{draftId:changed.id,expectedRevision:2,pageId:'overview'})
 if(updated.page.kind!=='dashboard'||'format' in updated)throw Error('旧配置须返回旧看板投影')
 assert.deepEqual(updated.page.results[0]!.rows,[],'必须使用候选筛选，不能读正式旧view')
 assert.equal(updated.page.viewRefs[0]!.view.chart,'pie')
 assert.equal(updated.page.viewRefs[0]!.objectType.fields[0]!.label,'销售阶段')
 assert.equal((await f.pool.query('select count(*)::int n from teloa_business_widget_results where owner_id=$1',[f.actor.ownerId])).rows[0].n,before.rows[0].n)
 assert.equal(f.remote(),0)
 const ledger=await new api.BusinessLedgerService(f.pool,identity,f.definitions).read(f.actor,{scope:f.draft.scope})
 assert.equal(ledger.blocks[0]!.objects,1)
 const dashboards=new api.BusinessDashboardService(f.pool,identity,f.definitions,new api.BusinessWidgetService(f.pool,identity,f.executor,new api.BusinessLedgerService(f.pool,identity,f.definitions)))
 assert.equal((await dashboards.list(f.actor,{scope:f.draft.scope})).length,1)
})
test('版本、撤权、取消和非法候选均不伪造成功页面',async()=>{
 const f=await fixture()
 await assert.rejects(f.pages.preview(f.actor,{draftId:f.draft.id,expectedRevision:1,pageId:'records'}),{code:'teloa/version-conflict'})
 await assert.rejects(f.pages.preview({...f.actor,ownerId:randomUUID()},{draftId:f.draft.id,expectedRevision:2,pageId:'records'}),{code:'teloa/forbidden'})
 await assert.rejects(f.pages.preview(f.actor,{draftId:f.draft.id,expectedRevision:2,pageId:'records'},AbortSignal.abort()),{name:'AbortError'})
 await adopt(f)
 await assert.rejects(f.pages.read({...f.actor,scopeIds:[]},{scope:f.draft.scope,pageId:'overview'}),{code:'teloa/forbidden'})
 assert.equal(f.remote(),0)
})
test('自主候选最多16对象/每型8视图，不扩大旧执行容量',async()=>{
 const f=await fixture(),db=await f.pool.connect()
 try{
  const candidate={...f.draft.candidate,definitions:[...f.draft.candidate.definitions,...Array.from({length:15},(_,i)=>({kind:'object-type',definition:{...f.type,id:'type-'+i}})),...Array.from({length:7},(_,i)=>({kind:'view',definition:{...f.view,id:'view-'+i}}))]}
  assert.equal((await f.definitions.forConfigurationCandidate(db,f.actor.ownerId,candidate))[0]!.objectTypes.length,16)
  await assert.rejects(f.definitions.forConfigurationCandidate(db,f.actor.ownerId,{...candidate,definitions:[...candidate.definitions,{kind:'object-type',definition:{...f.type,id:'extra'}}]}),{code:'teloa/invalid-input'})
  await assert.rejects(f.definitions.forConfigurationCandidate(db,f.actor.ownerId,{...candidate,definitions:[...candidate.definitions,{kind:'view',definition:{...f.view,id:'extra'}}]}),{code:'teloa/invalid-input'})
 }finally{db.release()}
})
test('本地SQL组件真实试算截到50行，单组件失败保留computedAt且不写快照',async()=>{
 const f=await fixture()
 const widgets=[
  {format:'teloa.business-widget/v1',id:'rows',version:'1.0.0',domain:f.draft.scope,title:'客户阶段',kind:'table',query:'select stage from customer'},
  {format:'teloa.business-widget/v1',id:'invalid-metric',version:'1.0.0',domain:f.draft.scope,title:'错误数字',kind:'metric',query:'select count(*) / 0 as value from customer',metric:{valueColumn:'value'}},
 ]
 f.draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:2,patch:{upsertDefinitions:[...widgets.map(definition=>({kind:'widget',definition})),{kind:'dashboard',definition:{...f.board,widgets:['stage-widget','rows','invalid-metric'],layout:[{widget:'stage-widget',x:0,y:0,w:12,h:2},{widget:'rows',x:0,y:2,w:12,h:2},{widget:'invalid-metric',x:0,y:4,w:12,h:2}]}}]}})
 await adopt(f)
 for(let n=0;n<51;n++)await f.records.create(f.actor,{scope:f.draft.scope,type:'customer',requestId:randomUUID(),title:'客户'+n,summary:'',fields:[{name:'stage',value:'洽谈'}]})
 const next=await f.drafts.begin(f.actor,{requestId:randomUUID(),title:'当前版',scope:f.draft.scope})
 let executions=0
 const execute=f.executor.execute.bind(f.executor)
 f.executor.execute=async(...args)=>{executions++;return execute(...args)}
 const result=await f.pages.preview(f.actor,{draftId:next.id,expectedRevision:1,pageId:'overview'})
 if(result.page.kind!=='dashboard'||'format' in result)throw Error('旧配置须返回旧看板投影')
 assert.equal(result.page.results[0]!.rows[0]![2],51)
 assert.equal(result.page.results[1]!.rowCount,50)
 assert.equal(result.page.results[2]!.status,'failed')
 assert.ok(result.page.results.every(r=>Number.isFinite(Date.parse(r.computedAt))))
 assert.equal(executions,2)
 await assert.rejects(f.pages.read({...f.actor,scopeIds:[]},{scope:f.draft.scope,pageId:'overview'}),{code:'teloa/forbidden'})
 await assert.rejects(f.pages.read(f.actor,{scope:'../invalid',pageId:'overview'}),{code:'teloa/invalid-input'})
 assert.equal(executions,2,'无权和非法范围不执行SQL')
 const abort=new AbortController()
 f.executor.execute=async(...args)=>{executions++;const result=await execute(...args);abort.abort();return result}
 await assert.rejects(f.pages.preview(f.actor,{draftId:next.id,expectedRevision:1,pageId:'overview'},abort.signal),{name:'AbortError'})
 assert.equal(executions,3,'正在试算时取消，下一组件不再执行')

 assert.equal((await f.pool.query('select count(*)::int n from teloa_business_widget_results where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 assert.equal(f.remote(),0)
})
test('非法候选整体失败，不返回看似已更新的旧页；有效旧投影身份仍可明确显示',async()=>{
 const f=await fixture(),lastGood=await f.pages.preview(f.actor,{draftId:f.draft.id,expectedRevision:2,pageId:'overview'})
 const draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:2,patch:{upsertDefinitions:[{kind:'view',definition:{...f.view,dimension:{field:'missing',limit:10}}}]}})
 await assert.rejects(f.pages.preview(f.actor,{draftId:draft.id,expectedRevision:3,pageId:'overview'}))
 assert.equal(lastGood.mode,'preview')
 assert.equal(lastGood.mode==='preview'&&lastGood.revision,2)
 assert.notEqual(lastGood.configurationHash,draft.hash)
})
import {insertBusinessDefinitionVersion} from '../src/work/business-definition-write.ts'
import {businessConfigurationHash} from '../src/work/business-configuration-store.ts'
test('正式自主存储超限时明确拒读；漏Store接线不能伪空；16/8边界实际ledger可读',async()=>{
 const f=await fixture()
 f.draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:f.draft.id,expectedRevision:2,patch:{upsertDefinitions:[...Array.from({length:15},(_,i)=>({kind:'object-type',definition:{...f.type,id:'type-'+i}})),...Array.from({length:7},(_,i)=>({kind:'view',definition:{...f.view,id:'view-'+i}}))]}})
 await adopt(f)
 const ledger=new api.BusinessLedgerService(f.pool,identity,f.definitions)
 const result=await ledger.read(f.actor,{scope:f.draft.scope})
 assert.equal(result.blocks.length,16);assert.equal(result.blocks[0]!.views.length,8)
 const unavailable=async():Promise<never>=>{throw Error('不读取市场')}
 const unbound=new api.BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:unavailable},{activeSourceIds:unavailable})
 await assert.rejects(new api.BusinessLedgerService(f.pool,identity,unbound).read(f.actor,{scope:f.draft.scope}),{code:'teloa/dependency-unavailable'})
 const db=await f.pool.connect()
 try{
  await db.query('begin')
  const current=(await f.store.currentInTransaction(db,f.actor.ownerId,f.draft.scope))!
  const leaf=await insertBusinessDefinitionVersion(db,{ownerId:f.actor.ownerId,scope:f.draft.scope,kind:'object-type',definition:{...f.type,id:'excess'},draftId:f.draft.id,now:identity.now()})
  await db.query('insert into teloa_business_local_definition_heads(owner_id,scope_id,kind,local_id,version,revision,updated_at) values($1,$2,$3,$4,$5,1,$6)',[f.actor.ownerId,f.draft.scope,leaf.kind,leaf.localId,leaf.version,identity.now()])
  const manifest={...current.manifest,definitions:[...current.manifest.definitions,{kind:'object-type',localId:leaf.localId,version:leaf.version,definitionHash:leaf.definitionHash}]}
  await db.query('update teloa_business_configuration_versions set manifest=$3,hash=$4 where owner_id=$1 and scope_id=$2',[f.actor.ownerId,f.draft.scope,JSON.stringify(manifest),businessConfigurationHash(manifest)])
  await db.query('commit')
 }catch(error){await db.query('rollback');throw error}finally{db.release()}
 await assert.rejects(ledger.read(f.actor,{scope:f.draft.scope}),{code:'teloa/source-unavailable'})
})
import {createBusinessBuilderHandler} from '../../harness-dsh/src/business-builder.ts'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('真实绑定端点采用失回包后重建服务刷新授权，原请求回执和旧端点保持同业务',async()=>{
 const f=await fixture(),path=await mkdtemp(join(tmpdir(),'teloa-builder-page-'))
 const repository=new api.FileConversationRepository(join(path,'conversations.json')),sessions=new Set<string>()
 const conversations=new api.ConversationService(repository,{create:async id=>{sessions.add(id);return id},inspect:async id=>{assert.ok(sessions.has(id))}},identity)
 const contexts=new api.ConversationWorkService(f.pool,identity.now,async(owner,id)=>({...await conversations.bySession(owner,id),submitted:false}))
 const services=()=>({bindings:new api.BusinessConversationBindingService(f.pool,identity,{drafts:f.drafts,conversations,contexts}),drafts:f.drafts,configuration:f.apply,preview:f.preview,pages:f.pages,records:f.records})
 const scopeIds=async()=>(await new api.BusinessScopeService(f.pool).list(f.actor.ownerId)).map(r=>r.scope)
 const handler=()=>createBusinessBuilderHandler(f.actor.ownerId,scopeIds,async()=>services())
 try{
  const request={requestId:randomUUID(),title:'实际搭建',kind:'builder'}
  const binding=await handler()('business-conversations/reserve',request) as import('@teloa/contract').BusinessConversationBinding
  const native=await conversations.create(f.actor.ownerId,{requestId:request.requestId,title:request.title})
  const recovering=await handler()('business-conversations/by-session',{sessionId:native.sessionId}) as import('@teloa/contract').BusinessConversationBinding
  assert.equal(recovering.requestId,request.requestId);assert.equal(recovering.sessionId,undefined)
  await assert.rejects(handler()('business-configuration/draft',{sessionId:native.sessionId,draftId:binding.draftId}),{code:'teloa/forbidden'})
  await handler()('business-conversations/bind',{requestId:request.requestId,sessionId:native.sessionId})
  let draft=await f.drafts.get(f.actor,{draftId:binding.draftId})
  const type={...f.type,domain:draft.scope,sourceId:draft.candidate.sources[0]!.sourceId}
  draft=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:type}],upsertPages:[{id:'records',title:'客户',kind:'records',objectType:type.id,fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'records'}})
  const preview=await handler()('business-configuration/preview',{sessionId:native.sessionId,draftId:draft.id,expectedRevision:2}) as import('@teloa/contract').BusinessConfigurationPreviewResponse
  const input={sessionId:native.sessionId,requestId:randomUUID(),draftId:draft.id,expectedRevision:2,expectedBaseVersion:0,previewReceipt:preview.receipt}
  const first=await handler()('business-configuration/apply',input)
  assert.deepEqual(await handler()('business-configuration/receipt',{requestId:input.requestId}),first)
  assert.deepEqual(await handler()('business-configuration/apply',input),first)
  const record=await handler()('business-records/create',{scope:draft.scope,type:type.id,requestId:randomUUID(),title:'真实客户',summary:'',fields:[{name:'stage',value:'洽谈'}]}) as import('@teloa/contract').BusinessObjectSnapshot
  assert.equal(record.version,1)
  const page=await handler()('business-records/list',{scope:draft.scope,type:type.id,limit:20}) as import('@teloa/contract').BusinessDataPage
  assert.equal(page.items[0]!.id,record.id)
  assert.equal((await handler()('business-configuration/draft',{sessionId:native.sessionId,draftId:draft.id}) as {status:string}).status,'applied')
 }finally{await rm(path,{recursive:true,force:true})}
})
test('隔时归档端点保留原receivedAt，get/receipt/同请求重试返回唯一tombstone',async()=>{
 const f=await fixture();await adopt(f)
 let now='2026-09-29T00:00:00.000Z'
 const clock={now:()=>now}
 const records=new api.BusinessRecordService(f.pool,clock,{definitions:f.definitions,warehouse:new api.BusinessWarehouseService(f.pool,clock),references:new api.BusinessSnapshotReferenceService(f.pool,clock)})
 const unused=async():Promise<never>=>{throw Error('记录端点不应访问会话绑定')}
 const handler=createBusinessBuilderHandler(f.actor.ownerId,async()=>f.actor.scopeIds,async()=>({
  bindings:{reserve:unused,bind:unused,byRequest:unused,bySession:unused,list:unused,recentDaily:unused},
  drafts:f.drafts,configuration:f.apply,preview:f.preview,pages:f.pages,records,
 }))
 const created=await handler('business-records/create',{scope:f.draft.scope,type:'customer',requestId:randomUUID(),title:'待归档客户',summary:'原始内容',fields:[{name:'stage',value:'洽谈'}]}) as import('@teloa/contract').BusinessObjectSnapshot
 now='2026-09-29T00:01:00.000Z'
 const input={scope:created.scope,type:created.type,id:created.id,requestId:randomUUID(),expectedVersion:1}
 const archived=await handler('business-records/archive',input) as import('@teloa/contract').BusinessObjectSnapshot
 assert.equal(archived.version,2);assert.equal(archived.deletedAt,now)
 assert.equal(archived.receivedAt,created.receivedAt);assert.equal(archived.observedAt,created.observedAt)
 assert.deepEqual(archived.fields,created.fields)
 assert.deepEqual(await handler('business-records/get',{scope:created.scope,type:created.type,id:created.id}),archived)
 assert.deepEqual(await handler('business-records/get',{scope:created.scope,type:created.type,id:created.id,version:2}),archived)
 assert.deepEqual(await handler('business-records/receipt',{requestId:input.requestId}),archived)
 now='2026-09-29T00:02:00.000Z'
 assert.deepEqual(await handler('business-records/archive',input),archived)
 assert.deepEqual(await handler('business-records/get',{scope:created.scope,type:created.type,id:created.id,version:1}),created)
 const versions=await f.pool.query('select object_version,snapshot_hash,snapshot from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$4 order by object_version',[f.actor.ownerId,created.scope,created.type,created.id])
 assert.deepEqual(versions.rows.map(row=>row.object_version),[1,2])
 assert.equal(versions.rows.filter(row=>row.snapshot.deletedAt!==undefined).length,1)
 assert.equal(versions.rows[1]!.snapshot_hash,archived.snapshotHash)
 assert.equal(versions.rows[1]!.snapshot.receivedAt,created.receivedAt)
})
