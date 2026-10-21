import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readBusinessDashboardShareTarget,readBusinessDashboardShareSnapshot,businessDashboardShareSnapshotText,businessDashboardShareEndpoint,type BusinessWidgetResult} from '@teloa/contract'
import {createBusinessDashboardShareHandler} from '../../harness-dsh/src/business-dashboard-share.ts'
import {fixture,object,scope} from './fixtures/business-dashboard-share.ts'
const ownerId='dashboard-share-owner'

test('正式看板与原始行使用相同时间范围、视图筛选和固定配置，富字段原文不丢失',async()=>{
 const f=fixture([object('a'),object('old','2026-09-01T12:00:00.000Z'),object('other','2026-10-20T12:00:00.000Z','完成')])
 const result=await f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target)
 assert.equal(result.page.kind,'configuration');assert.equal(result.raw.status,'ready')
 if(result.page.kind!=='configuration'||result.page.projection.page.kind!=='dashboard'||result.raw.status!=='ready')throw Error('错误快照类型')
 const view=result.page.projection.page.results[0]
 assert.ok(view&&'format'in view);if(!view||!('format'in view))throw Error('须保留类型化统计')
 assert.deepEqual(view.view.rows[0]?.values,[1])
 const raw=result.raw.sections[0]!,keys=raw.columns.map(column=>column.key)
 assert.equal(raw.rows[0]![keys.indexOf('record.fields')],JSON.stringify(object('a').fields));assert.equal(raw.recordCount,1);assert.equal(raw.rows[0]![keys.indexOf('record.id')],'a')
 assert.equal(raw.rows[0]![keys.indexOf('field.amount')],'{"currency":"CNY","decimal":"9007199254740993.0001"}')
 assert.equal(raw.rows[0]![keys.indexOf('field.tags')],'["重要","续约"]')
 assert.equal(raw.rows[0]![keys.indexOf('field.title')],'=原文,\n含引号"')
 assert.notEqual(keys.indexOf('field.title'),keys.indexOf('record.title'))
 const {snapshotHash,...body}=result
 assert.equal(snapshotHash,createHash('sha256').update(businessDashboardShareSnapshotText(body)).digest('hex'))
 assert.equal(f.commands[0]?.sql,'begin isolation level repeatable read read only');assert.equal(f.commands.at(-1)?.sql,'commit')
 assert.ok(f.commands.every(command=>!/^(insert|update|delete|create|alter)/i.test(command.sql)))
})
test('原始记录不受页面50行投影限制，聚合值不能冒充原始记录',async()=>{
 const f=fixture(Array.from({length:55},(_,i)=>object('id-'+i)),{list:true})
 const result=await f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target)
 assert.equal(result.raw.status,'ready');if(result.raw.status!=='ready')throw Error('缺少原始记录')
 assert.equal(result.raw.sections[0]?.rows.length,55)
 assert.equal(result.page.kind,'configuration');if(result.page.kind!=='configuration'||result.page.projection.page.kind!=='dashboard')throw Error('错误页面')
 const view=result.page.projection.page.results[0];assert.ok(view&&'format'in view);if(!view||!('format'in view))throw Error('错误结果')
 assert.equal(view.view.rows.length,50)
})
test('跨范围、旧配置、无效范围及损坏来源均拒绝，不写入或拉来源',async()=>{
 const f=fixture([object('a')])
 await assert.rejects(f.pages.shareSnapshot({ownerId,scopeIds:[]},f.target),{code:'teloa/forbidden'})
 await assert.rejects(f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target,AbortSignal.abort()),{name:'AbortError'})
 assert.equal(f.commands.length,0)
 await assert.rejects(f.pages.shareSnapshot({ownerId,scopeIds:[scope]},{...f.target,configurationVersion:1}),{code:'teloa/version-conflict'})
 await assert.rejects(f.pages.shareSnapshot({ownerId,scopeIds:[scope]},{...f.target,timeRange:'7d'}),{code:'teloa/invalid-input'})
 const corrupt=fixture([{...object('bad'),snapshotHash:'a'.repeat(64)}])
 await assert.rejects(corrupt.pages.shareSnapshot({ownerId,scopeIds:[scope]},corrupt.target),{code:'teloa/storage-corrupt'})
})
test('超过5000条的扫描明确失败，不能被视图筛选或raw unavailable掩盖',async()=>{
 const f=fixture(Array.from({length:5001},(_,i)=>object('id-'+i)))
 await assert.rejects(f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target),{code:'teloa/dashboard-share-limit'})
 assert.equal(f.commands.at(-1)?.sql,'rollback')
})
test('旧SQL看板可取得真实固定页面，但不把聚合结果伪装成原始CSV',async()=>{
 const f=fixture([object('a'),object('b')],{legacySql:true})
 const result=await f.dashboards.shareSnapshot({ownerId,scopeIds:[scope]},f.legacy)
 assert.deepEqual(result.raw,{status:'unavailable',reason:'sql-source-lineage-unavailable'})
 assert.equal(result.page.kind,'legacy');if(result.page.kind!=='legacy')throw Error('错误旧页面')
 assert.deepEqual(result.page.page.results[0]?.rows,[[2]])
 await assert.rejects(f.dashboards.shareSnapshot({ownerId,scopeIds:[scope]},{...f.legacy,definitionHash:'b'.repeat(64)}),{code:'teloa/version-conflict'})
})
test('宿主接口严格校验目标、业务权限与全快照摘要，未知接口不会调用服务',async()=>{
 const f=fixture([object('a')]),handler=createBusinessDashboardShareHandler(ownerId,async()=>[scope],async()=>f)
 const result=await handler(businessDashboardShareEndpoint,{target:f.target})
 assert.equal(result.target.kind,'configuration')
 await assert.rejects(handler('unknown',{target:f.target}),{code:'teloa/not-found'})
 await assert.rejects(handler(businessDashboardShareEndpoint,{target:f.target,ownerId:'other'}),{code:'teloa/invalid-input'})
 const denied=createBusinessDashboardShareHandler(ownerId,async()=>[],async()=>{throw Error('不应调用服务')})
 await assert.rejects(denied(businessDashboardShareEndpoint,{target:f.target}),{code:'teloa/forbidden'})
 const tampered=createBusinessDashboardShareHandler(ownerId,async()=>[scope],async()=>({pages:{shareSnapshot:async()=>({...result,snapshotHash:'a'.repeat(64)})},dashboards:f.dashboards}))
 await assert.rejects(tampered(businessDashboardShareEndpoint,{target:f.target}),{code:'teloa/invalid-host-response'})
 assert.throws(()=>readBusinessDashboardShareTarget({...f.target,timeRange:'bad'}),{code:'teloa/invalid-input'})
 assert.throws(()=>readBusinessDashboardShareSnapshot({...result,target:{...f.target,configurationHash:'a'.repeat(64)}}),{code:'teloa/invalid-host-response'})
})

test('多个组件的原始CSV合计超过5000条，及超过8MiB正文均整体失败',async()=>{
 const many=fixture(Array.from({length:2501},(_,i)=>object('id-'+i)),{widgetCount:2})
 await assert.rejects(many.pages.shareSnapshot({ownerId,scopeIds:[scope]},many.target),{code:'teloa/dashboard-share-limit'})
 assert.equal(many.commands.at(-1)?.sql,'rollback')
 const bytes=fixture(Array.from({length:800},(_,i)=>object('id-'+i,undefined,undefined,{summary:'汉'.repeat(4000)})))
 await assert.rejects(bytes.pages.shareSnapshot({ownerId,scopeIds:[scope]},bytes.target),{code:'teloa/dashboard-share-limit'})
 assert.equal(bytes.commands.at(-1)?.sql,'rollback')
})
test('旧view-ref与v1正式看板均从原始来源重算，同范围且无缓存陈旧值',async()=>{
 const f=fixture([object('a'),object('b')],{v1:true})
 const saved=await f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target)
 assert.equal(saved.page.kind,'configuration');if(saved.page.kind!=='configuration'||saved.page.projection.page.kind!=='dashboard')throw Error('错误页面')
 assert.deepEqual((saved.page.projection.page.results[0] as BusinessWidgetResult|undefined)?.rows,[['','客户数量',2]])
 const legacy=await f.dashboards.shareSnapshot({ownerId,scopeIds:[scope]},f.legacy)
 assert.equal(legacy.page.kind,'legacy');if(legacy.page.kind!=='legacy'||legacy.raw.status!=='ready')throw Error('错误页面')
 assert.deepEqual(legacy.page.page.results[0]?.rows,[['','客户数量',2]])
 assert.equal(legacy.raw.sections[0]?.rows.length,2)
 assert.equal(legacy.page.page.results[0]?.stale,false)
})
test('原始未知字段完整保留；宿主错误行数、列形状和其他widget引用不通过契约',async()=>{
 const source=object('a',undefined,undefined,{fields:[...object('a').fields,{label:'未映射原值',value:'额外来源值'}]})
 const f=fixture([source]),result=await f.pages.shareSnapshot({ownerId,scopeIds:[scope]},f.target)
 if(result.raw.status!=='ready')throw Error('缺少原始记录')
 assert.throws(()=>readBusinessDashboardShareSnapshot({...result,raw:{status:'unavailable',reason:'sql-source-lineage-unavailable'}}),{code:'teloa/invalid-host-response'})
 const section=result.raw.sections[0]!,raw=section.rows[0]![section.columns.findIndex(column=>column.key==='record.fields')]
 assert.equal(raw,JSON.stringify(source.fields))
 for(const sectionPatch of [{recordCount:2},{widgetId:'wrong-widget'},{rows:[[]]},{columns:[{key:'not-namespaced',label:'坏字段'}]}]){
  assert.throws(()=>readBusinessDashboardShareSnapshot({...result,raw:{status:'ready',sections:[{...section,...sectionPatch}]}}),{code:'teloa/invalid-host-response'})
 }
})
