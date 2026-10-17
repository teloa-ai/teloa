import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import type {Pool} from 'pg'
import type {StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import {readBusinessConfigurationCandidateVersioned} from '@teloa/contract'
import {MarketContentStore,IndustryLoadService,createIndustryLoadSource,BusinessDefinitionSourceReader,BusinessLocalDefinitionService,BusinessConfigurationStore,BusinessConfigurationDraftService,BusinessConfigurationPreviewService,BusinessConfigurationService,BusinessRuntimeService,BusinessSpaceService,BusinessLedgerService,BusinessSyncService,BusinessWarehouseService,BusinessSnapshotReferenceService,BusinessRecordService,BusinessSqlExecutor,BusinessWidgetService,BusinessDashboardService} from '../src/index.ts'
import {startDatabase} from './business-widget-fixture.ts'

let pool:Pool,reader:Pool,container:StartedPostgreSqlContainer
before(async()=>{({pool,reader,container}=await startDatabase())},{timeout:120000})
after(async()=>{await reader?.end();await pool?.end();await container?.stop()})

test('真实配置采用、员工结果改版与六个 SOC 看板保持对象分母和核验口径',{timeout:120000},async()=>{
 const ownerId='local:'+randomUUID(),actor={ownerId,scopeIds:['SOC']},identity={id:randomUUID,now:()=>new Date().toISOString()}
 const market=new MarketContentStore(pool,identity),loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market))
 const store=new BusinessConfigurationStore(pool),local=new BusinessLocalDefinitionService(pool,identity)
 const definitions=new BusinessDefinitionSourceReader(market,loads,{activeSourceIds:async()=>new Set<string>()},local,store)
 const drafts=new BusinessConfigurationDraftService(pool,identity),preview=new BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const configuration=new BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new BusinessRuntimeService(pool,identity),spaces:new BusinessSpaceService(pool,identity)})
 let draft=await drafts.begin(actor,{requestId:randomUUID(),title:'AI SOC 契约验收'})
 const raw=JSON.parse(await readFile(new URL('../../../examples/business/ai-soc-configuration.json',import.meta.url),'utf8'))
 raw.scope=draft.scope;raw.title='AI SOC 契约验收';raw.sources=draft.candidate.sources
 for(const item of raw.definitions){item.definition.domain=draft.scope;if(item.kind==='object-type')item.definition.sourceId=raw.sources[0].sourceId}
 const candidate=readBusinessConfigurationCandidateVersioned(raw)
 draft=await drafts.revise(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,patch:{upsertDefinitions:candidate.definitions,upsertPages:candidate.pages,homePageId:candidate.homePageId}})
 const inspected=await preview.preview(actor,{draftId:draft.id,expectedRevision:draft.revision})
 assert.deepEqual(inspected.issues,[],'声明、映射、字段、组件和看板需通过真实服务跨引用校验')
 await configuration.apply(actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:0,previewReceipt:inspected.receipt})
 const authorized={ownerId,scopeIds:[draft.scope]},scope=draft.scope
 const ledger=new BusinessLedgerService(pool,identity,definitions),warehouse=new BusinessWarehouseService(pool,identity)
 const sync=new BusinessSyncService(pool,identity,definitions,warehouse,async()=>{throw new Error('验收不能拉取外部来源')})
 const records=new BusinessRecordService(pool,identity,{definitions,warehouse,references:new BusinessSnapshotReferenceService(pool,identity)})
 const original=async(id:string,category:string)=>records.create(authorized,{scope,type:'ai-soc-work-item',requestId:randomUUID(),title:'合成 '+id,summary:'测试原始事实',fields:[{name:'ticket_id',value:id},{name:'category',value:category},{name:'severity',value:'高'},{name:'created_at',value:identity.now()}]})
 const first=await original('INC-A','深度调查'),second=await original('INC-B','深度调查'),response=await original('RES-A','响应核验')
 const employeeId=randomUUID(),taskId=randomUUID()
 const execution=(snapshot:typeof first)=>({runId:randomUUID(),taskId,sessionId:'synthetic-session',roleId:employeeId,createdAt:identity.now(),reference:{scope,type:snapshot.type,id:snapshot.id,version:snapshot.version,snapshotHash:snapshot.snapshotHash!}})
 const result=(lifecycle:string,duration?:number)=>({title:'合成调查结果',summary:'测试数据，不代表 AI 执行',lifecycle,outcome:lifecycle==='已关闭'?'非入侵':'待确认',work_status:'已完成',severity:'高',employee:'不能伪造此员工',source_task:'不能伪造来源',created_at:identity.now(),...(duration===undefined?{}:{duration}),evidence:'合成证据'})
 for(const mapping of candidate.definitions.filter(item=>item.kind==='source-mapping')){
  await assert.rejects(sync.ingest(authorized,{scope,mappingId:mapping.definition.id,sourceId:'role-result:model-session',items:[{object:{id:first.id},employee:{id:'FAKE-EMPLOYEE'},task:{id:'FAKE-TASK'},result:result('调查中',120)}]}),{code:'teloa/forbidden'},'批量成果入口不能伪造固定对象执行上下文')
 }
 assert.equal((await pool.query('select count(*)::int n from teloa_business_task_result_receipts where owner_id=$1',[ownerId])).rows[0].n,0)
 const ingest=(type:string,payload:Record<string,unknown>,run:ReturnType<typeof execution>)=>sync.ingestTaskResult(authorized,{scope,mappingId:'ai-soc-'+type+'-result',result:payload},async()=>run)
 await ingest('incident',result('调查中',120),execution(first))
 await ingest('incident',result('已关闭'),execution(second))
 await ingest('response',{...result('已批准'),outcome:'未核验'},execution(response))
 const recorded=await records.list(authorized,{scope,type:'ai-soc-incident',limit:10})
 assert.ok(recorded.items.every(item=>item.fields.find(field=>field.label==='负责员工')?.value===employeeId),'负责员工来自平台执行身份')
 assert.ok(recorded.items.every(item=>item.fields.find(field=>field.label==='来源任务')?.value===taskId),'来源任务来自平台执行身份')
 assert.equal((await records.get(authorized,{scope,type:first.type,id:first.id})).version,1,'结果不覆盖原始事实')
 const views=async()=>{
  const value=await ledger.read(authorized,{scope})
  return new Map(value.blocks.flatMap(block=>block.views.map(view=>[view.viewId,view] as const)))
 }
 let computed=await views()
 const scalar=(id:string)=>computed.get('ai-soc-'+id)?.rows[0]?.values[0]
 assert.equal(scalar('incident-total'),2)
 assert.equal(scalar('incident-active'),1,'员工已完成不等于案件已关闭')
 assert.equal(scalar('response-active'),1,'受理或批准动作不等于效果已核验')
 assert.equal(scalar('incident-latency'),120,'缺失时长不作为零参与平均')
 assert.deepEqual(computed.get('ai-soc-incident-latency')?.missingFields,['duration'])
 assert.equal(scalar('response-latency'),null,'全部缺失时长显示未知')
 const updated=result('已关闭',180),newRun=execution(first)
 newRun.createdAt=new Date(Date.now()+1000).toISOString()
 assert.equal((await ingest('incident',updated,newRun)).upserted,1)
 assert.equal((await ingest('incident',updated,newRun)).upserted,1,'幂等回执返回原结果，不追加版本')
 computed=await views()
 assert.equal(scalar('incident-total'),2,'更新版本不增加业务对象分母')
 assert.equal(scalar('incident-active'),0)
 assert.equal(scalar('incident-latency'),180)
 const snapshots=(await pool.query('select object_id,count(*)::int versions from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 group by object_id order by versions desc',[ownerId,scope,'ai-soc-incident'])).rows
 assert.deepEqual(snapshots.map(row=>row.versions),[2,1])
 // 展示层调整必须保留同步来源与全部历史；未登记来源仍不得放行。
 const historyQuery='select object_type,object_id,object_version,snapshot_hash,snapshot,source_id from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 order by object_type,object_id,object_version'
 const history=(await pool.query(historyQuery,[ownerId,scope])).rows
 const adjustPages=async()=>{
  let edit=await drafts.begin(authorized,{requestId:randomUUID(),scope,title:candidate.title})
  edit=await drafts.revise(authorized,{requestId:randomUUID(),draftId:edit.id,expectedRevision:edit.revision,patch:{upsertPages:candidate.pages.map(page=>({...page,title:page.id==='incident-records'?'案件明细':page.title}))}})
  const checked=await preview.preview(authorized,{draftId:edit.id,expectedRevision:edit.revision})
  return configuration.apply(authorized,{requestId:randomUUID(),draftId:edit.id,expectedRevision:edit.revision,expectedBaseVersion:edit.baseVersion,previewReceipt:checked.receipt})
 }
 assert.equal((await adjustPages()).version,2,'已写入合法员工成果后仍可调整业务展示')
 assert.deepEqual((await pool.query(historyQuery,[ownerId,scope])).rows,history,'展示调整不改写任何原始记录或结果版本')
 const receipt=(await pool.query('select object_id,source_id from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2 and object_type=$3 limit 1',[ownerId,scope,'ai-soc-incident'])).rows[0]
 await pool.query('update teloa_business_object_snapshots set source_id=$4 where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$5',[ownerId,scope,'ai-soc-incident','unregistered-source',receipt.object_id])
 await assert.rejects(adjustPages(),{code:'teloa/conflict'},'未登记同步来源不能靠展示变更绕过迁移约束')
 await pool.query('update teloa_business_object_snapshots set source_id=$4 where owner_id=$1 and scope_id=$2 and object_type=$3 and object_id=$5',[ownerId,scope,'ai-soc-incident',receipt.source_id,receipt.object_id])
 assert.deepEqual((await pool.query(historyQuery,[ownerId,scope])).rows,history)
 const widgets=new BusinessWidgetService(pool,identity,new BusinessSqlExecutor(pool,identity,'unavailable'),ledger)
 const dashboards=new BusinessDashboardService(pool,identity,definitions,widgets)
 for(const page of candidate.pages.filter(page=>page.kind==='dashboard')){
  const board=await dashboards.refresh(authorized,{requestId:randomUUID(),scope,dashboardId:page.dashboardId})
  assert.equal(board.results.length,8)
  assert.ok(board.results.every(result=>result.status==='ok'),page.title)
 }
 const tasks=(await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[ownerId])).rows[0].n
 assert.equal(tasks,0,'配置与合成结果不能伪装成员工执行')
})
