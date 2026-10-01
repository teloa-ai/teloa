import test from 'node:test'
import assert from 'node:assert/strict'
import type {Pool,PoolClient} from 'pg'
import {BusinessLedgerService} from '../src/work/business-view-compute.ts'
import {analyzeBusinessSql,prepareBusinessSqlParser} from '../src/work/business-sql-guard.ts'
import {rewriteBusinessSql,rewriteBusinessWidgetSql} from '../src/work/business-sql-rewrite.ts'
import {BusinessDefinitionSourceReader} from '../src/work/business-definition-source.ts'
import {BusinessConfigurationPreviewService} from '../src/work/business-configuration-preview.ts'
import {businessConfigurationHash} from '../src/work/business-configuration-store.ts'
import {BusinessConfigurationPageService} from '../src/work/business-configuration-page.ts'
import {readBusinessConfigurationPageProjection} from '@teloa/contract'
import {BusinessConfigurationService} from '../src/work/business-configuration.ts'
import {issueBusinessConfigurationPreviewReceipt,businessConfigurationDependencyHash} from '../src/work/business-configuration-preview-receipt.ts'
import {BusinessRecordService} from '../src/work/business-records.ts'
import {businessObjectSnapshotHash} from '../src/work/business-data.ts'

const type={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:'SOC',title:'客户',unit:'位',lead:'跟进',sourceId:'records',fields:[{format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'金额',currencies:['CNY']}]}
function dashboardCandidate(format:'teloa.business-configuration/v1'|'teloa.business-configuration/v2'){
 const scope='business_0123456789abcdef0123456789abcdef',stage={name:'stage',label:'阶段',type:'enum',required:true,from:'阶段',values:['新客','完成']}
 return {format,scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[
  {kind:'object-type',definition:{...type,domain:scope,format:format==='teloa.business-configuration/v2'?'teloa.business-object-type/v2':'teloa.business-object-type/v1',fields:format==='teloa.business-configuration/v2'?[stage,...type.fields]:[stage]}},
  {kind:'view',definition:{format:'teloa.business-view/v1',id:'counts',version:'1.0.0',domain:scope,title:'阶段统计',kind:'distribution',chart:'bar',objectType:'customer',dimension:{field:'stage',limit:2},measures:[{id:'total',label:'位',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:2}},
  {kind:'widget',definition:{format:'teloa.business-widget/v1',id:'widget',version:'1.0.0',domain:scope,title:'阶段统计',kind:'view-ref',viewRef:'counts'}},
  {kind:'dashboard',definition:{format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'概览',widgets:['widget'],layout:[{widget:'widget',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}},
 ],pages:[{id:'overview',title:'概览',kind:'dashboard',dashboardId:'overview'}],homePageId:'overview'}
}
function candidateReader(){
 const unavailable=async():Promise<never>=>{throw Error('不得访问外部来源')}
 return new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:unavailable},{activeSourceIds:unavailable})
}
function sqlDashboardCandidate(){
 const candidate=dashboardCandidate('teloa.business-configuration/v2')
 return {...candidate,definitions:candidate.definitions.map(item=>item.kind==='widget'?{kind:'widget',definition:{format:'teloa.business-widget/v1',id:'widget',version:'1.0.0',domain:candidate.scope,title:'SQL统计',kind:'metric',query:'select count(*) as total from customer',metric:{valueColumn:'total'}}}:item)}
}
test('旧台账即使由覆盖读口拿到富字段也明确拒绝，不能把金额当文本计算',async()=>{
 const ledger=new BusinessLedgerService({} as Pool,{now:()=>new Date().toISOString()},{forScope:async()=>[{origin:{kind:'local-configuration',configurationVersion:1,configurationHash:'0'.repeat(64)},scope:'SOC',domain:'SOC',objectTypes:[{source:{} as never,definition:type}],views:[],actions:[],mappings:[],widgets:[],dashboards:[],sources:new Map()}]} as never)
 await assert.rejects(ledger.computeInTransaction({} as PoolClient,{ownerId:'owner',scopeIds:['SOC']},{scope:'SOC'}),{code:'teloa/dependency-unavailable'})
})
test('旧 SQL 改写边界即使拿到富字段也明确拒绝，不能按未声明的 cast 回退 text',async()=>{
 await prepareBusinessSqlParser()
 const analysis=analyzeBusinessSql('select amount from customer',[type] as never)
 assert.throws(()=>rewriteBusinessSql(analysis,{ownerId:'owner',scope:'SOC'},'public'),{code:'teloa/dependency-unavailable'})
 await assert.rejects(rewriteBusinessWidgetSql({ownerId:'owner',scope:'SOC',objectTypes:[type]} as never,{query:'select amount from customer'} as never,'public'),{code:'teloa/dependency-unavailable'})
})
test('版本化来源读取器保留真实 v2 正文与富字段，旧候选读口拒收',async()=>{
 const unavailable=async():Promise<never>=>{throw Error('不得访问外部来源')}
 const reader=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:unavailable},{activeSourceIds:unavailable})
 const scope='business_0123456789abcdef0123456789abcdef'
 const definition={...type,domain:scope}
 const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition}],pages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}
 assert.equal(typeof reader.forConfigurationCandidateVersioned,'function','须提供版本化候选读取器')
 const bundles=await reader.forConfigurationCandidateVersioned({} as PoolClient,'owner',candidate)
 assert.deepEqual(bundles[0]?.objectTypes[0]?.definition,definition)
 await assert.rejects(reader.forConfigurationCandidate({} as PoolClient,'owner',candidate),{code:'teloa/invalid-input'})
})
test('v2视图看板在共同候选读取口可读，SQL组件仍拒绝且旧v1看板能力保留',async()=>{
 const reader=candidateReader(),db={} as PoolClient
 const v2=await reader.forConfigurationCandidateVersioned(db,'owner',dashboardCandidate('teloa.business-configuration/v2'))
 assert.equal(v2[0]!.dashboards[0]!.definition.id,'overview')
 assert.equal(v2[0]!.widgets[0]!.definition.viewRef,'counts')
 assert.equal(v2[0]!.objectTypes[0]!.definition.fields[1]!.type,'money')
 await assert.rejects(reader.forConfigurationCandidateVersioned(db,'owner',sqlDashboardCandidate()),{code:'teloa/invalid-input',details:{path:'configuration'}})
 const v1=dashboardCandidate('teloa.business-configuration/v1')
 for(const bundles of [await reader.forConfigurationCandidate(db,'owner',v1),await reader.forConfigurationCandidateVersioned(db,'owner',v1)]){
  assert.equal(bundles[0]!.dashboards[0]!.definition.id,'overview')
  assert.equal(bundles[0]!.views[0]!.definition.id,'counts')
 }
})
test('v2 SQL组件预览不能签出可采用回执，采用也经同一读取口在写入前拒绝',async()=>{
 const candidate=sqlDashboardCandidate(),scope=candidate.scope,draftId='12345678-1234-4567-89ab-123456789012',requestId='22345678-1234-4567-89ab-123456789012'
 const draft={id:draftId,scope,revision:2,baseVersion:0,candidate,hash:businessConfigurationHash(candidate),status:'draft'},queries:string[]=[]
 const db={query:async(sql:string)=>{queries.push(sql);return {rows:sql==='select scope_id from teloa_business_configuration_drafts where owner_id=$1 and id=$2'?[{scope_id:scope}]:sql.includes('configuration_managed')?[{managed:false}]:[]}},release:()=>{}}
 const pool={connect:async()=>db} as unknown as Pool,definitions=candidateReader(),drafts={draftInTransaction:async()=>draft},identity={now:()=>new Date().toISOString()}
 const preview=new BusinessConfigurationPreviewService(pool,drafts as never,definitions,identity)
 let receipt:string|undefined
 await assert.rejects(async()=>{receipt=(await preview.preview({ownerId:'owner',scopeIds:[]},{draftId,expectedRevision:2})).receipt},{code:'teloa/invalid-input',details:{path:'configuration'}})
 assert.equal(receipt,undefined)
 assert.ok(queries.includes('rollback'));assert.equal(queries.includes('commit'),false)
 let runtimeCalls=0,spaceCalls=0
 const service=new BusinessConfigurationService(pool,identity,{drafts,store:{currentInTransaction:async()=>undefined},definitions,runtime:{registerInTransaction:async()=>{runtimeCalls++}},spaces:{ensurePersonalInTransaction:async()=>{spaceCalls++;return {id:'space'}}}} as never)
 const binding={ownerId:'owner',draftId,scope,revision:2,candidateHash:draft.hash,baseVersion:0,dependencyHash:businessConfigurationDependencyHash(undefined)}
 await assert.rejects(service.apply({ownerId:'owner',scopeIds:[]},{requestId,draftId,expectedRevision:2,expectedBaseVersion:0,previewReceipt:issueBusinessConfigurationPreviewReceipt(binding)}),{code:'teloa/invalid-input',details:{path:'configuration'}})
 assert.equal(runtimeCalls,0);assert.equal(spaceCalls,0)
 assert.equal(queries.some(sql=>/^(insert|update|delete)\b/i.test(sql)),false)
})
test('v2视图看板预览只读使用版本化候选校验并签出原候选回执',async()=>{
 const scope='business_0123456789abcdef0123456789abcdef',draftId='12345678-1234-4567-89ab-123456789012'
 const candidate=dashboardCandidate('teloa.business-configuration/v2')
 const unavailable=async():Promise<never>=>{throw Error('不得访问外部来源')}
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:unavailable},{activeSourceIds:unavailable})
 const queries:string[]=[],db={query:async(sql:string)=>{queries.push(sql);return {rows:[{managed:false}]}},release:()=>{}}
 const draft={id:draftId,scope,revision:2,baseVersion:0,candidate,hash:businessConfigurationHash(candidate),status:'draft'}
 const preview=new BusinessConfigurationPreviewService({connect:async()=>db} as unknown as Pool,{draftInTransaction:async()=>draft} as never,definitions,{now:()=>new Date().toISOString()})
 const result=await preview.preview({ownerId:'owner',scopeIds:[]},{draftId,expectedRevision:2})
 assert.equal(result.candidateHash,draft.hash)
 assert.equal(result.baseVersion,0)
 assert.match(result.receipt,/^[a-f0-9]{64}$/)
 assert.ok(result.changes.rows.some(row=>row.after==='"money"'))
 assert.equal(queries.some(sql=>/^(insert|update|delete)\b/i.test(sql)),false)
})
test('v2 记录页面预览和正式读取返回显式 v2 正文，旧页面读取器拒收',async()=>{
 const scope='business_0123456789abcdef0123456789abcdef',draftId='12345678-1234-4567-89ab-123456789012'
 const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:{...type,domain:scope}}],pages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}
 const unavailable=async():Promise<never>=>{throw Error('不得访问外部来源')}
 const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:unavailable},{activeSourceIds:unavailable})
 const db={query:async()=>({rows:[{managed:false}]}),release:()=>{}}
 const draft={id:draftId,scope,revision:2,baseVersion:0,candidate,hash:businessConfigurationHash(candidate),status:'draft'}
 const dependencies={drafts:{draftInTransaction:async()=>draft},store:{currentInTransaction:async()=>undefined},definitions,executor:{schema:'public',execute:unavailable}}
 const pages=new BusinessConfigurationPageService({connect:async()=>db} as unknown as Pool,{now:()=>new Date().toISOString()},dependencies as never)
 const result=await pages.preview({ownerId:'owner',scopeIds:[]},{draftId,expectedRevision:2,pageId:'home'})
 assert.equal('format' in result&&result.format,'teloa.business-configuration-page/v2')
 assert.equal(result.page.kind,'records')
 assert.deepEqual(result.page.kind==='records'&&result.page.objectType,candidate.definitions[0]!.definition)
 assert.throws(()=>readBusinessConfigurationPageProjection(result),{code:'teloa/invalid-host-response'})
 const bundles=await definitions.forConfigurationCandidateVersioned({} as PoolClient,'owner',candidate)
 const saved=new BusinessConfigurationPageService({connect:async()=>db} as unknown as Pool,{now:()=>new Date().toISOString()},{...dependencies,store:{currentInTransaction:async()=>({manifest:candidate,version:1,hash:draft.hash})},definitions:{forScope:unavailable,forConfigurationCandidate:unavailable,forScopeVersioned:async()=>bundles}} as never)
 const current=await saved.read({ownerId:'owner',scopeIds:[scope]},{scope,pageId:'home'})
 assert.equal('format' in current&&current.format,'teloa.business-configuration-page/v2')
 assert.equal(current.mode,'saved')
})

test('完整v2视图看板页面预览与正式读口计算固定快照，绕过候选的SQL组件仍拒绝',async()=>{
 const candidate=dashboardCandidate('teloa.business-configuration/v2'),scope=candidate.scope,draftId='12345678-1234-4567-89ab-123456789012',stamp='2026-09-30T00:00:00.000Z'
 const snapshot={scope,type:'customer',id:'one',version:1,title:'客户',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'',fields:[{label:'阶段',value:'新客'},{label:'金额',value:'{"currency":"CNY","decimal":"12.0000"}'}]}
 const queries:string[]=[],db={query:async(sql:string,params:unknown[]=[])=>{
  queries.push(sql)
  if(sql.startsWith('with ids as (')){assert.deepEqual(params.slice(0,3),['owner',scope,'customer']);return {rows:[{object_id:'one',object_version:1,source_id:'records',snapshot,snapshot_hash:businessObjectSnapshotHash(snapshot)}]}}
  return {rows:[{managed:false}]}
 },release:()=>{}}
 const pool={connect:async()=>db} as unknown as Pool,definitions=candidateReader()
 const draft={id:draftId,scope,revision:2,baseVersion:0,candidate,hash:businessConfigurationHash(candidate),status:'draft'}
 const dependencies={drafts:{draftInTransaction:async()=>draft},store:{currentInTransaction:async()=>undefined},definitions,executor:{schema:'public',execute:async()=>{throw Error('视图组件不得使用SQL执行器')}}}
 const pages=new BusinessConfigurationPageService(pool,{now:()=>stamp},dependencies as never)
 const preview=await pages.preview({ownerId:'owner',scopeIds:[]},{draftId,expectedRevision:2,pageId:'overview'})
 assert.equal(preview.page.kind,'dashboard')
 if(preview.page.kind!=='dashboard')assert.fail('须返回视图看板')
 assert.deepEqual(preview.page.dashboard,candidate.definitions.find(item=>item.kind==='dashboard')!.definition)
 const widgetResult=preview.page.results[0]!
 if(!('view' in widgetResult))assert.fail('须返回类型化视图组件结果')
 assert.deepEqual(widgetResult.view.rows,[{dimension:'新客',label:'新客',values:[1]}])
 assert.equal(queries.some(sql=>/^(insert|update|delete)\b/i.test(sql)),false)
 const bundles=await definitions.forConfigurationCandidateVersioned(db as unknown as PoolClient,'owner',candidate)
 const saved=new BusinessConfigurationPageService(pool,{now:()=>stamp},{...dependencies,store:{currentInTransaction:async()=>({manifest:candidate,version:1,hash:draft.hash})},definitions:{forScopeVersioned:async()=>bundles}} as never)
 const current=await saved.read({ownerId:'owner',scopeIds:[scope]},{scope,pageId:'overview'})
 assert.deepEqual(current.page,preview.page)
 assert.equal(current.mode,'saved')
 const sqlCandidate=sqlDashboardCandidate(),sqlBundles=[{...bundles[0]!,widgets:[{...bundles[0]!.widgets[0]!,definition:sqlCandidate.definitions.find(item=>item.kind==='widget')!.definition}]}]
 const unsupported=new BusinessConfigurationPageService(pool,{now:()=>stamp},{...dependencies,drafts:{draftInTransaction:async()=>({...draft,candidate:sqlCandidate,hash:businessConfigurationHash(sqlCandidate)})},definitions:{forConfigurationCandidateVersioned:async()=>sqlBundles}} as never)
 await assert.rejects(unsupported.preview({ownerId:'owner',scopeIds:[]},{draftId,expectedRevision:2,pageId:'overview'}),{code:'teloa/dependency-unavailable'})
 assert.equal(queries.some(sql=>/^(insert|update|delete)\b/i.test(sql)),false)
})
test('v2 采用使用真实 v2 正文插入固定叶子，不经过独立 v1 定义入口',async()=>{
 const scope='business_0123456789abcdef0123456789abcdef',draftId='12345678-1234-4567-89ab-123456789012',requestId='22345678-1234-4567-89ab-123456789012'
 const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:{...type,domain:scope}}],pages:[{id:'home',title:'客户',kind:'records',objectType:'customer',fields:['amount'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'home'}
 const current={version:1,hash:'0'.repeat(64),leaves:[]},draft={id:draftId,scope,revision:2,baseVersion:1,candidate,hash:businessConfigurationHash(candidate),status:'draft'}
 let body:unknown,manifest:unknown
 const db={query:async(sql:string,params:unknown[]=[])=>{
  if(sql==='select scope_id from teloa_business_configuration_drafts where owner_id=$1 and id=$2')return {rows:[{scope_id:scope}]}
  if(sql.startsWith('insert into teloa_business_local_definitions'))body=JSON.parse(String(params[8]))
  if(sql.startsWith('insert into teloa_business_configuration_versions'))manifest=JSON.parse(String(params[3]))
  return {rows:[]}
 },release:()=>{}}
 const unavailable=async():Promise<never>=>{throw Error('不得使用旧读取器')}
 const service=new BusinessConfigurationService({connect:async()=>db} as unknown as Pool,{now:()=>new Date().toISOString()},{drafts:{draftInTransaction:async()=>draft},store:{currentInTransaction:async()=>current},definitions:{forScope:unavailable,forConfigurationCandidate:unavailable,forConfigurationCandidateVersioned:async()=>[],forScopeVersioned:async()=>[]},runtime:{registerInTransaction:async()=>{}},spaces:{ensurePersonalInTransaction:unavailable}} as never)
 const binding={ownerId:'owner',draftId,scope,revision:2,candidateHash:draft.hash,baseVersion:1,dependencyHash:businessConfigurationDependencyHash(current as never)}
 const result=await service.apply({ownerId:'owner',scopeIds:[scope]},{requestId,draftId,expectedRevision:2,expectedBaseVersion:1,previewReceipt:issueBusinessConfigurationPreviewReceipt(binding)})
 assert.equal(result.version,2)
 assert.deepEqual(body,candidate.definitions[0]!.definition)
 assert.equal((manifest as {format:string}).format,'teloa.business-configuration/v2')
})
test('同一记录读取器使用版本化固定定义保留金额规范串，不调用旧 v1 来源读口',async()=>{
 const scope='business_0123456789abcdef0123456789abcdef',stamp='2026-09-30T00:00:00.000Z',money='{"currency":"CNY","decimal":"9007199254740993.0001"}'
 const snapshot={scope,type:'customer',id:'one',version:1,title:'客户',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete' as const,summary:'',fields:[{label:'金额',value:money}]}
 const snapshotHash=businessObjectSnapshotHash(snapshot)
 const db={query:async(sql:string)=>{
  if(sql.startsWith('select 1 from teloa_business_record_heads'))return {rows:[{one:1}],rowCount:1}
  if(sql.startsWith('select source_id,current_version'))return {rows:[{source_id:'records',current_version:1,created_at:new Date(stamp)}]}
  if(sql.startsWith('select max(object_version)'))return {rows:[{v:1}]}
  if(sql.startsWith('select object_version,source_id'))return {rows:[{object_version:1,source_id:'records',snapshot_hash:snapshotHash,snapshot}]}
  return {rows:[]}
 },release:()=>{}}
 const unavailable=async():Promise<never>=>{throw Error('不得使用旧读取器')}
 const definitions={forScope:unavailable,forScopeVersioned:async()=>[{origin:{kind:'local-configuration',configurationVersion:1,configurationHash:'0'.repeat(64)},objectTypes:[{definition:{...type,domain:scope}}],sources:new Map([['records',{connected:true}]])}]}
 const records=new BusinessRecordService({connect:async()=>db} as unknown as Pool,{now:()=>stamp},{definitions,warehouse:{},references:{}} as never)
 assert.deepEqual(await records.get({ownerId:'owner',scopeIds:[scope]},{scope,type:'customer',id:'one'}),{...snapshot,snapshotHash})
})
