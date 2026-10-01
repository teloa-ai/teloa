import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import {PostgreSqlContainer,type StartedPostgreSqlContainer} from '@testcontainers/postgresql'
import * as api from '../src/index.ts'
import {MarketContentStore} from '../src/market/content-store.ts'
import {BusinessConfigurationDraftService} from '../src/work/business-configuration-drafts.ts'
import {BusinessConfigurationStore} from '../src/work/business-configuration-store.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {BusinessConfigurationPageService} from '../src/work/business-configuration-page.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessDashboardResourceService} from '../src/work/business-dashboard-resource.ts'
import {dashboardBody,dashboardManifest} from './fixtures/business-dashboard.ts'
import {useLocalContainerRuntime} from './testcontainers-env.ts'

let pool:Pool,container:StartedPostgreSqlContainer
const identity={id:randomUUID,now:()=>new Date().toISOString()}
const unavailable=async():Promise<never>=>{throw Error('不得请求远端来源或模型')}
before(async()=>{
 useLocalContainerRuntime()
 container=await new PostgreSqlContainer('postgres:17-alpine').start()
 pool=new Pool({connectionString:container.getConnectionUri()})
 await api.initializeTeloaDatabase(pool)
},{timeout:180000})
after(async()=>{await pool?.end();await container?.stop()})

function services(){
 const market=new MarketContentStore(pool,identity),drafts=new BusinessConfigurationDraftService(pool,identity),store=new BusinessConfigurationStore(pool)
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
 const configuration=new BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new api.BusinessRuntimeService(pool,identity),spaces:new api.BusinessSpaceService(pool,identity)})
 const preview=new BusinessConfigurationPreviewService(pool,drafts,definitions,identity)
 const pages=new BusinessConfigurationPageService(pool,identity,{drafts,store,definitions,executor:{schema:'public',execute:unavailable}})
 const records=new api.BusinessRecordService(pool,identity,{definitions,warehouse:new api.BusinessWarehouseService(pool,identity),references:new api.BusinessSnapshotReferenceService(pool,identity)})
 const ports={market,drafts,configuration,preview,pages}
 return {...ports,records,resource:new BusinessDashboardResourceService(pool,ports)}
}
async function fixture(){
 const s=services(),actor={ownerId:'dashboard:'+randomUUID(),scopeIds:[] as string[]}
 const files=[['teloa.json',dashboardManifest()],['configuration.json',dashboardBody()]].map(([path,value])=>({path:path as string,bytes:new TextEncoder().encode(JSON.stringify(value))}))
 const {content}=await s.market.import({ownerId:actor.ownerId,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'SOC 看板'},manifestPath:'teloa.json',files,references:[]})
 const request={requestId:randomUUID(),contentId:content.id,contentHash:content.hash,resourceId:'soc-overview',target:{kind:'new',title:'我的安全运营'}}
 return {...s,actor,content,request}
}
async function adopt(f:Awaited<ReturnType<typeof fixture>>,draft:Awaited<ReturnType<BusinessDashboardResourceService['prepare']>>){
 const preview=await f.resource.preview(f.actor,{draftId:draft.id,expectedRevision:draft.revision})
 const input={requestId:randomUUID(),draftId:draft.id,expectedRevision:draft.revision,expectedBaseVersion:draft.baseVersion,previewReceipt:preview.receipt}
 const result=await f.resource.apply(f.actor,input)
 f.actor.scopeIds=(await new api.BusinessScopeService(pool).list(f.actor.ownerId)).map(scope=>scope.scope).filter(scope=>scope!=='general')
 return {result,input}
}

test('固定资源只准备草案，两个业务采用后记录、来源与实时看板隔离；回执重建不重放',async()=>{
 const f=await fixture()
 const [draft,same]=await Promise.all([f.resource.prepare(f.actor,f.request),f.resource.prepare(f.actor,f.request)])
 assert.equal(draft.id,same.id);assert.equal(draft.hash,same.hash)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_scopes where owner_id=$1',[f.actor.ownerId])).rows[0].n,0)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_dashboard_preparations where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
 const page=await f.resource.page(f.actor,{draftId:draft.id,expectedRevision:draft.revision,pageId:draft.candidate.homePageId})
 assert.equal(page.mode,'preview')
 const first=await adopt(f,draft)
 assert.deepEqual(await f.resource.adoption(f.actor,{draftId:draft.id}),{draftId:draft.id,scope:draft.scope,version:1,configurationHash:first.result.configurationHash})
 const record=await f.records.create(f.actor,{scope:draft.scope,type:'alert',requestId:randomUUID(),title:'生产主机告警',summary:'',fields:[{name:'state',value:'待核对'}]})
 const before=await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[f.actor.ownerId])
 const second=await f.resource.prepare(f.actor,{...f.request,requestId:randomUUID(),target:{kind:'new',title:'另一安全运营'}})
 await adopt(f,second)
 assert.notEqual(draft.scope,second.scope)
 assert.notEqual(draft.candidate.sources[0]!.sourceId,second.candidate.sources[0]!.sourceId)
 assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[f.actor.ownerId])).rows,before.rows)
 assert.equal(record.scope,draft.scope)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_object_snapshots where owner_id=$1 and scope_id=$2',[f.actor.ownerId,second.scope])).rows[0].n,0)
 assert.deepEqual(await services().configuration.receipt(f.actor,{requestId:first.input.requestId}),first.result)
 assert.deepEqual(await services().resource.apply(f.actor,first.input),first.result)
 await assert.rejects(services().resource.apply({...f.actor,scopeIds:[]},first.input),{code:'teloa/forbidden'})
 assert.equal((await services().resource.prepare(f.actor,f.request)).status,'applied')
 assert.equal((await pool.query('select count(*)::int n from teloa_business_configuration_heads where owner_id=$1',[f.actor.ownerId])).rows[0].n,2)
})

test('追加修订失回包后业务版本推进，同请求仍接回原草案但不能采用过期基线',async()=>{
 const f=await fixture(),original=await f.resource.prepare(f.actor,f.request)
 await adopt(f,original)
 const request={...f.request,requestId:randomUUID(),target:{kind:'existing',scope:original.scope,expectedVersion:1}}
 let fail=true
 const resource=new BusinessDashboardResourceService(pool,{market:f.market,configuration:f.configuration,preview:f.preview,pages:f.pages,drafts:{begin:f.drafts.begin.bind(f.drafts),get:f.drafts.get.bind(f.drafts),revise:async(...args)=>{
  const result=await f.drafts.revise(...args);if(fail){fail=false;throw Error('修订已提交失回包')}return result
 }}})
 await assert.rejects(resource.prepare(f.actor,request),/失回包/)
 const other=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:original.scope,title:'业务新名称',format:'teloa.business-configuration/v2'})
 const preview=await f.preview.preview(f.actor,{draftId:other.id,expectedRevision:1})
 await f.configuration.apply(f.actor,{requestId:randomUUID(),draftId:other.id,expectedRevision:1,expectedBaseVersion:1,previewReceipt:preview.receipt})
 const resumed=await services().resource.prepare(f.actor,request)
 assert.equal(resumed.baseVersion,1);assert.equal(resumed.candidate.title,'我的安全运营')
 await assert.rejects(f.resource.preview(f.actor,{draftId:resumed.id,expectedRevision:resumed.revision}),{code:'teloa/version-conflict'})
 assert.equal((await pool.query('select count(*)::int n from teloa_business_dashboard_preparations where owner_id=$1 and request_id=$2 and draft_id is not null',[f.actor.ownerId,request.requestId])).rows[0].n,1)
})

test('升级三方保留自建页面，未裁决不建草案；本地修改冲突明确裁决后采用且记录不改',async()=>{
 const f=await fixture(),original=await f.resource.prepare(f.actor,f.request)
 await adopt(f,original)
 await f.records.create(f.actor,{scope:original.scope,type:'alert',requestId:randomUUID(),title:'升级不改记录',summary:'',fields:[{name:'state',value:'待核对'}]})
 const local=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:original.scope,title:'我的运营团队',format:'teloa.business-configuration/v2'})
 const localView=local.candidate.definitions.find(item=>item.kind==='view')!
 const revised=await f.drafts.revise(f.actor,{requestId:randomUUID(),draftId:local.id,expectedRevision:1,patch:{upsertDefinitions:[{...localView,definition:{...localView.definition,title:'本地状态说明'}}],upsertPages:[{id:'my-alerts',title:'自建记录页面',kind:'records',objectType:'alert',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:true}],pageOrder:[...local.candidate.pages.map(page=>page.id),'my-alerts']}})
 const localPreview=await f.preview.preview(f.actor,{draftId:local.id,expectedRevision:revised.revision})
 await f.configuration.apply(f.actor,{requestId:randomUUID(),draftId:local.id,expectedRevision:revised.revision,expectedBaseVersion:1,previewReceipt:localPreview.receipt})
 const manifest={...dashboardManifest(),version:'1.1.0',resources:dashboardManifest().resources.map(item=>({...item,version:'1.1.0'}))}
 const body=dashboardBody();body.version='1.1.0';body.configuration.definitions=body.configuration.definitions.map(item=>item.kind==='view'?{...item,definition:{...item.definition,title:'新版状态说明'}}:item)
 const {content}=await f.market.import({ownerId:f.actor.ownerId,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'新版SOC'},manifestPath:'teloa.json',references:[],files:[['teloa.json',manifest],['configuration.json',body]].map(([path,value])=>({path:path as string,bytes:new TextEncoder().encode(JSON.stringify(value))}))})
 const request={requestId:randomUUID(),adoptionId:original.id,candidateContentId:content.id,candidateContentHash:content.hash,resourceId:'soc-overview',expectedConfigurationVersion:2}
 const before=(await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1',[f.actor.ownerId])).rows
 const proposal=await f.resource.prepareUpgrade(f.actor,request)
 assert.equal(proposal.draft,null);assert.equal(proposal.conflicts.length,1)
 const chosen=await f.resource.prepareUpgrade(f.actor,{...request,choices:{[proposal.conflicts[0]!.key]:'keep-local'}})
 assert.ok(chosen.draft);assert.ok(chosen.draft.candidate.pages.some(page=>page.id==='my-alerts'))
 assert.equal(chosen.draft.candidate.definitions.find(item=>item.kind==='view')!.definition.title,'本地状态说明')
 assert.equal(chosen.draft.candidate.title,'我的运营团队')
 await adopt(f,chosen.draft)
 assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1',[f.actor.ownerId])).rows,before)
 const same=await services().resource.prepareUpgrade(f.actor,{...request,choices:{[proposal.conflicts[0]!.key]:'keep-local'}})
 assert.equal(same.draft?.id,chosen.draft.id);assert.equal(same.draft?.status,'applied')
})

test('追加现有业务保留业务名、页面和原记录，版本变化或字段冲突拒绝覆盖',async()=>{
 const f=await fixture(),draft=await f.resource.prepare(f.actor,f.request)
 await adopt(f,draft)
 await f.records.create(f.actor,{scope:draft.scope,type:'alert',requestId:randomUUID(),title:'固定历史',summary:'',fields:[{name:'state',value:'已处理'}]})
 const saved=(await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1',[f.actor.ownerId])).rows
 const input={...f.request,requestId:randomUUID(),target:{kind:'existing',scope:draft.scope,expectedVersion:1}}
 const addition=await f.resource.prepare(f.actor,input)
 assert.equal(addition.candidate.title,'我的安全运营')
 assert.deepEqual(addition.candidate.pages,draft.candidate.pages)
 await adopt(f,addition)
 assert.equal((await f.resource.adoption(f.actor,{draftId:draft.id}))?.version,1)
 assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1',[f.actor.ownerId])).rows,saved)
 await assert.rejects(f.resource.prepare(f.actor,{...input,requestId:randomUUID()}),{code:'teloa/version-conflict'})
})

test('已有对象由业务所有，资源复用后新版换对象不会将它删除',async()=>{
 const f=await fixture(),original=await f.resource.prepare(f.actor,f.request)
 await adopt(f,original)
 const added=await f.resource.prepare(f.actor,{...f.request,requestId:randomUUID(),target:{kind:'existing',scope:original.scope,expectedVersion:1}})
 await adopt(f,added)
 const body=dashboardBody();body.version='1.1.0'
 body.configuration.definitions=body.configuration.definitions.map(item=>item.kind==='object-type'?{...item,definition:{...item.definition,id:'incident'}}:item.kind==='view'?{...item,definition:{...item.definition,objectType:'incident'}}:item)
 body.configuration.pages=body.configuration.pages.map(page=>page.kind==='records'?{...page,objectType:'incident'}:page)
 const manifest={...dashboardManifest(),version:'1.1.0',resources:dashboardManifest().resources.map(item=>({...item,version:'1.1.0'}))}
 const {content}=await f.market.import({ownerId:f.actor.ownerId,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'事件看板新版'},manifestPath:'teloa.json',references:[],files:[['teloa.json',manifest],['configuration.json',body]].map(([path,value])=>({path:path as string,bytes:new TextEncoder().encode(JSON.stringify(value))}))})
 const upgraded=await f.resource.prepareUpgrade(f.actor,{requestId:randomUUID(),adoptionId:added.id,candidateContentId:content.id,candidateContentHash:content.hash,resourceId:'soc-overview',expectedConfigurationVersion:2})
 assert.ok(upgraded.draft);assert.deepEqual(upgraded.conflicts,[])
 assert.ok(upgraded.draft.candidate.definitions.some(item=>item.kind==='object-type'&&item.definition.id==='alert'))
 assert.ok(upgraded.draft.candidate.definitions.some(item=>item.kind==='object-type'&&item.definition.id==='incident'))
 await adopt(f,upgraded.draft)
})

test('升级修订已提交失回包，业务随后推进仍可恢复原草案且不能覆盖新版本',async()=>{
 const f=await fixture(),original=await f.resource.prepare(f.actor,f.request)
 await adopt(f,original)
 const body=dashboardBody();body.version='1.1.0'
 const manifest={...dashboardManifest(),version:'1.1.0',resources:dashboardManifest().resources.map(item=>({...item,version:'1.1.0'}))}
 const {content}=await f.market.import({ownerId:f.actor.ownerId,kind:'human'},{kind:'industry-template',requestId:randomUUID(),source:{kind:'upload',name:'看板新版'},manifestPath:'teloa.json',references:[],files:[['teloa.json',manifest],['configuration.json',body]].map(([path,value])=>({path:path as string,bytes:new TextEncoder().encode(JSON.stringify(value))}))})
 const request={requestId:randomUUID(),adoptionId:original.id,candidateContentId:content.id,candidateContentHash:content.hash,resourceId:'soc-overview',expectedConfigurationVersion:1}
 let fail=true
 const faulty=new BusinessDashboardResourceService(pool,{market:f.market,configuration:f.configuration,preview:f.preview,pages:f.pages,drafts:{begin:f.drafts.begin.bind(f.drafts),get:f.drafts.get.bind(f.drafts),revise:async(...args)=>{const result=await f.drafts.revise(...args);if(fail){fail=false;throw Error('升级修订失回包')}return result}}})
 await assert.rejects(faulty.prepareUpgrade(f.actor,request),/失回包/)
 const other=await f.drafts.begin(f.actor,{requestId:randomUUID(),scope:original.scope,title:'本人最新名称',format:'teloa.business-configuration/v2'})
 const preview=await f.preview.preview(f.actor,{draftId:other.id,expectedRevision:1})
 await f.configuration.apply(f.actor,{requestId:randomUUID(),draftId:other.id,expectedRevision:1,expectedBaseVersion:1,previewReceipt:preview.receipt})
 const resumed=await services().resource.prepareUpgrade(f.actor,request)
 assert.ok(resumed.draft);assert.equal(resumed.draft.baseVersion,1)
 await assert.rejects(f.resource.preview(f.actor,{draftId:resumed.draft.id,expectedRevision:resumed.draft.revision}),{code:'teloa/version-conflict'})
 assert.equal((await f.configuration.current(f.actor,{scope:original.scope}))?.manifest.title,'本人最新名称')
})

test('准备失败后同请求重试只修复原草案，固定身份、本人及采用来源不能绕过',async()=>{
 const f=await fixture();let fail=true
 const faulty=new BusinessDashboardResourceService(pool,{market:f.market,configuration:f.configuration,preview:f.preview,pages:f.pages,drafts:{begin:f.drafts.begin.bind(f.drafts),get:f.drafts.get.bind(f.drafts),revise:async(...args)=>{
  const result=await f.drafts.revise(...args)
  if(fail){fail=false;throw Error('模拟修订成功失回包')}
  return result
 }}})
 await assert.rejects(faulty.prepare(f.actor,f.request),/失回包/)
 const restored=await services().resource.prepare(f.actor,f.request)
 assert.equal(restored.revision,2)
 assert.equal((await pool.query('select count(*)::int n from teloa_business_configuration_drafts where owner_id=$1',[f.actor.ownerId])).rows[0].n,1)
 assert.equal((await f.resource.prepare(f.actor,{...f.request,requestId:f.request.requestId.toUpperCase(),contentId:f.request.contentId.toUpperCase()})).id,restored.id)
 await assert.rejects(f.resource.prepare(f.actor,{...f.request,target:{kind:'new',title:'改变目标'}}),{code:'teloa/conflict'})
 await assert.rejects(f.resource.prepare(f.actor,{...f.request,requestId:randomUUID(),contentHash:'0'.repeat(64)}),{code:'teloa/source-unavailable'})
 await assert.rejects(f.resource.preview({ownerId:'other',scopeIds:[]},{draftId:restored.id,expectedRevision:2}),{code:'teloa/forbidden'})
 const unrelated=await f.drafts.begin(f.actor,{requestId:randomUUID(),title:'会话草案',format:'teloa.business-configuration/v2'})
 await assert.rejects(f.resource.preview(f.actor,{draftId:unrelated.id,expectedRevision:1}),{code:'teloa/forbidden'})
})

test('导出权威当前配置全图但不读取记录，不包含本人范围、来源身份和真实记录',async()=>{
 const f=await fixture(),draft=await f.resource.prepare(f.actor,f.request)
 await adopt(f,draft)
 await f.records.create(f.actor,{scope:draft.scope,type:'alert',requestId:randomUUID(),title:'不能分享的真实记录',summary:'',fields:[{name:'state',value:'待核对'}]})
 const exported=await f.resource.exportCurrent(f.actor,{scope:draft.scope,id:'shared-soc',version:'1.0.0'})
 assert.equal(exported.resource.configuration.scope,'template')
 assert.equal(exported.resource.configuration.definitions.length,4)
 assert.equal(exported.resource.configuration.pages.length,2)
 assert.deepEqual(exported.resource.configuration.sources,[{sourceId:'records',kind:'local-records'}])
 const json=JSON.stringify(exported.resource)
 for(const value of [f.actor.ownerId,draft.scope,draft.candidate.sources[0]!.sourceId,'不能分享的真实记录'])assert.equal(json.includes(value),false)
 assert.deepEqual(exported.excluded,[])
 assert.equal(exported.configurationHash,(await f.configuration.current(f.actor,{scope:draft.scope}))!.hash)
 await assert.rejects(f.resource.exportCurrent({ownerId:'other',scopeIds:[draft.scope]},{scope:draft.scope,id:'shared-soc',version:'1.0.0'}),{code:'teloa/not-found'})
})
