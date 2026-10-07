import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {businessDashboardEndpoints,type BusinessDashboardPage} from '@teloa/contract'
import {createBusinessDashboardHandler} from '../src/business-dashboards.ts'

const owner='local:teloa-owner',scope='SOC',now='2026-09-26T00:00:00.000Z',hash='a'.repeat(64),requestId='11111111-1111-4111-8111-111111111111'
const widget={format:'teloa.business-widget/v1' as const,id:'open-count',version:'1.0.0',domain:scope,title:'未关闭告警',kind:'metric' as const,query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
const dashboard={format:'teloa.business-dashboard/v1' as const,id:'overview',version:'1.0.0',domain:scope,title:'总览',widgets:['open-count'],layout:[{widget:'open-count',x:0,y:0,w:4,h:2}],refresh:{kind:'every' as const,seconds:300},acknowledgeShortInterval:false}
const page=():BusinessDashboardPage=>({schema:'teloa.business-dashboard-page/v1',scope,dashboard,widgets:[widget],results:[{widgetId:'open-count',definitionHash:hash,computedAt:now,status:'ok',columns:[{name:'n',type:'number'}],rows:[[3]],rowCount:1,truncated:false,bytes:1,stale:false}],updatedAt:now,nextRefreshAt:'2026-09-26T00:05:00.000Z',refreshing:false,timeRange:null})
const run={id:'22222222-2222-4222-8222-222222222222',mappingId:'alerts',scope,startedAt:now,finishedAt:now,status:'ok',upserted:1,tombstoned:0,fetched:1,durationMs:0,trigger:'manual'}

function setup(overrides:{page?:unknown}={}){
 const calls:Array<{operation:string;actor:unknown;input:unknown}>=[]
 const dashboards={
  list:async(actor:unknown,input:unknown)=>{calls.push({operation:'list',actor,input});return [{id:'overview',title:'总览',widgets:1,updatedAt:now}]},
  read:async(actor:unknown,input:unknown)=>{calls.push({operation:'read',actor,input});return overrides.page??page()},
  refresh:async(actor:unknown,input:unknown)=>{calls.push({operation:'refresh',actor,input});return overrides.page??page()},
 }
 const sync={
  mappings:async()=>[{id:'alerts',title:'告警同步',schedule:{kind:'every',seconds:300},source:{kind:'business-data-port'}}],
  status:async(actor:unknown,input:unknown)=>{calls.push({operation:'status',actor,input});return [{mappingId:'alerts',lastRun:run,consecutiveFailures:0,quota:{rows:1,limit:500000}}]},
  runs:async(actor:unknown,input:unknown)=>{calls.push({operation:'runs',actor,input});return [run]},
  run:async(actor:unknown,input:unknown)=>{calls.push({operation:'run',actor,input});return run},
 }
 const rules={
  get:async(actor:unknown,input:unknown)=>{calls.push({operation:'rule-get',actor,input});return {scope,mappingId:'alerts',definitionHash:hash,enabled:true,revision:2}},
  set:async(actor:unknown,input:unknown)=>{calls.push({operation:'rule-set',actor,input});return {scope,mappingId:'alerts',definitionHash:hash,enabled:false,revision:3}},
 }
 const runtime={
  get:async(actor:unknown,input:unknown)=>{calls.push({operation:'runtime-get',actor,input});return {scope,managed:true,syncEnabled:true,revision:2}},
  setSync:async(actor:unknown,input:unknown)=>{calls.push({operation:'runtime-set',actor,input});return {scope,managed:true,syncEnabled:false,revision:3}},
 }
 const handler=createBusinessDashboardHandler(owner,async()=>[scope,'AppSec'],async()=>({dashboards,sync,rules,runtime}) as never)
 return {calls,handler}
}

test('看板与同步端点：键集严格、主体与范围只取可信来源，回包过契约读取器',async()=>{
 assert.deepEqual([...businessDashboardEndpoints],['business-dashboards/list','business-dashboards/read','business-dashboards/refresh','business-sync/status','business-sync/runs','business-sync/run','business-sync/rules'])
 const e=setup()
 assert.deepEqual(await e.handler('business-dashboards/read',{scope,dashboardId:'overview'}),page())
 assert.equal((await e.handler('business-dashboards/list',{scope}) as unknown[]).length,1)
 await e.handler('business-dashboards/refresh',{requestId,scope,dashboardId:'overview'})
 assert.equal((await e.handler('business-sync/status',{scope}) as unknown[]).length,1)
 assert.equal((await e.handler('business-sync/runs',{scope,mappingId:'alerts',limit:10}) as unknown[]).length,1)
 assert.deepEqual(await e.handler('business-sync/run',{requestId,scope,mappingId:'alerts'}),run)
 assert.deepEqual(e.calls.map(call=>call.operation),['read','list','refresh','status','runs','run'])
 for(const call of e.calls)assert.deepEqual(call.actor,{ownerId:owner,scopeIds:[scope,'AppSec']})
 assert.deepEqual(e.calls.at(-1)?.input,{scope,mappingId:'alerts',trigger:'manual'})
})

test('持续规则列表显示真实周期和实际运行；启停只用本人身份、独立请求及预期修订',async()=>{
 const e=setup()
 assert.deepEqual(await e.handler('business-sync/rules',{scope}),[{scope,mappingId:'alerts',definitionHash:hash,enabled:true,revision:2,title:'告警同步',schedule:{kind:'every',seconds:300},running:true}])
 assert.deepEqual(await e.handler('business-sync/rule-set',{scope,mappingId:'alerts',enabled:false,expectedRevision:2,requestId}),{scope,mappingId:'alerts',definitionHash:hash,enabled:false,revision:3})
 assert.deepEqual(e.calls.map(call=>call.operation),['runtime-get','rule-get','rule-set'])
 assert.deepEqual(e.calls.at(-1)?.actor,{ownerId:owner,scopeIds:[scope,'AppSec']})
 assert.deepEqual(e.calls.at(-1)?.input,{scope,mappingId:'alerts',enabled:false,expectedRevision:2,requestId})
 for(const payload of [{scope,mappingId:'alerts',enabled:true,expectedRevision:2,requestId,ownerId:'other'},{scope,mappingId:'alerts',enabled:true,expectedRevision:2,requestId:'bad'}])
  await assert.rejects(e.handler('business-sync/rule-set',payload),{code:'teloa/invalid-input'})
 await assert.rejects(e.handler('business-sync/rule-set',{scope:'Finance',mappingId:'alerts',enabled:true,expectedRevision:2,requestId}),{code:'teloa/forbidden'})
})

test('业务级持续运行总开关只在本人浏览器端点写入，严格核对请求与结果',async()=>{
 const e=setup()
 assert.deepEqual(await e.handler('business-sync/runtime',{scope}),{scope,managed:true,syncEnabled:true,revision:2})
 assert.deepEqual(await e.handler('business-sync/runtime-set',{scope,enabled:false,expectedRevision:2,requestId}),{scope,managed:true,syncEnabled:false,revision:3})
 assert.deepEqual(e.calls.map(call=>call.operation),['runtime-get','runtime-set'])
 assert.deepEqual(e.calls.at(-1)?.input,{scope,enabled:false,expectedRevision:2,requestId})
 for(const payload of [{scope,enabled:true,expectedRevision:2,requestId,ownerId:'other'},{scope,enabled:true,expectedRevision:2,requestId:'bad'}])
  await assert.rejects(e.handler('business-sync/runtime-set',payload),{code:'teloa/invalid-input'})
 await assert.rejects(e.handler('business-sync/runtime-set',{scope:'Finance',enabled:true,expectedRevision:2,requestId}),{code:'teloa/forbidden'})
})

test('read 多字段 invalid-input；范围不在登记范围 forbidden；回包缺 updatedAt 或看板错位 invalid-host-response',async()=>{
 const e=setup()
 await assert.rejects(e.handler('business-dashboards/read',{scope,dashboardId:'overview',ownerId:'other'}),{code:'teloa/invalid-input'})
 await assert.rejects(e.handler('business-dashboards/read',{scope:'Finance',dashboardId:'overview'}),{code:'teloa/forbidden'})
 await assert.rejects(e.handler('business-dashboards/refresh',{requestId:'not-a-uuid',scope,dashboardId:'overview'}),{code:'teloa/invalid-input'})
 await assert.rejects(e.handler('business-dashboards/delete',{scope}),{code:'teloa/not-found'})
 assert.equal(e.calls.length,0)
 const {updatedAt:_missing,...broken}=page()
 await assert.rejects(setup({page:broken}).handler('business-dashboards/read',{scope,dashboardId:'overview'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(setup().handler('business-dashboards/read',{scope,dashboardId:'other'}),{code:'teloa/invalid-host-response'})
})

test('timeRange：read / refresh 键集为「固定键 + 可选 timeRange」，取值须是平台枚举；透传给服务；回包所选范围与请求不符 invalid-host-response',async()=>{
 const ranged={...dashboard,filters:{timeRange:{options:['7d','30d','all'] as Array<'7d'|'30d'|'all'>,default:'7d' as const}}}
 const rangedWidget={...widget,timeFilter:{table:'soc_alert',column:'_observed_at'}}
 const pageAt=(selected:'7d'|'30d'|'all'):BusinessDashboardPage=>({...page(),dashboard:ranged,widgets:[rangedWidget],timeRange:{selected,options:['7d','30d','all']}})
 const e=setup({page:pageAt('30d')})
 assert.deepEqual(await e.handler('business-dashboards/read',{scope,dashboardId:'overview',timeRange:'30d'}),pageAt('30d'))
 await e.handler('business-dashboards/refresh',{requestId,scope,dashboardId:'overview',timeRange:'30d'})
 assert.deepEqual(e.calls.map(call=>call.input),[{scope,dashboardId:'overview',timeRange:'30d'},{requestId,scope,dashboardId:'overview',timeRange:'30d'}])
 // 不带 timeRange 时不往服务里塞这个键。
 const d=setup({page:pageAt('7d')})
 await d.handler('business-dashboards/read',{scope,dashboardId:'overview'})
 await d.handler('business-dashboards/refresh',{requestId,scope,dashboardId:'overview'})
 assert.deepEqual(d.calls.map(call=>call.input),[{scope,dashboardId:'overview'},{requestId,scope,dashboardId:'overview'}])
 const bad=setup()
 for(const endpoint of ['business-dashboards/read','business-dashboards/refresh']){
  const base=endpoint==='business-dashboards/read'?{scope,dashboardId:'overview'}:{requestId,scope,dashboardId:'overview'}
  for(const timeRange of ['1y','7 days',null,7,['7d'],'']) await assert.rejects(bad.handler(endpoint,{...base,timeRange}),{code:'teloa/invalid-input'},endpoint+' '+JSON.stringify(timeRange))
  await assert.rejects(bad.handler(endpoint,{...base,timeRange:'7d',filters:{}}),{code:'teloa/invalid-input'},'多键')
 }
 await assert.rejects(bad.handler('business-dashboards/list',{scope,timeRange:'7d'}),{code:'teloa/invalid-input'},'list 不收 timeRange')
 assert.equal(bad.calls.length,0)
 // 回包的所选范围与请求不符（含不带 timeRange 时回包不是默认范围）→ 宿主回包错误。
 await assert.rejects(setup({page:pageAt('7d')}).handler('business-dashboards/read',{scope,dashboardId:'overview',timeRange:'30d'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(setup({page:pageAt('7d')}).handler('business-dashboards/refresh',{requestId,scope,dashboardId:'overview',timeRange:'all'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(setup({page:pageAt('30d')}).handler('business-dashboards/read',{scope,dashboardId:'overview'}),{code:'teloa/invalid-host-response'})
 await assert.rejects(setup({page:{...pageAt('7d'),timeRange:null}}).handler('business-dashboards/read',{scope,dashboardId:'overview'}),{code:'teloa/invalid-host-response'})
})

test('宿主接线：端点进 RPC 分发；执行器专用池以只读角色口令文件建立、记错误码、关闭时结束；预览装第 6 参',()=>{
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/const endpointSet=new Set\([^\n]*\.\.\.businessDashboardEndpoints/)
 assert.match(source,/businessDashboardEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await businessDashboardHandler\(endpoint,payload,signal\)/)
 assert.match(source,/const businessSqlSecretPath=resolve\(runtimeRoot,'business-sql-reader\.json'\)/)
 assert.match(source,/await initializeTeloaDatabase\(database\.pool,\{businessSqlSecretPath\}\)/)
 assert.match(source,/await businessSqlPoolConfig\(database\.pool\.options,businessSqlRole,businessSqlSecretPath\)/)
 assert.match(source,/businessSqlPool\.on\('error',/)
 assert.match(source,/ctx\.effect\(\(\)=>\(\)=>\{void businessSqlPool\.end\(\)/)
 assert.match(source,/new BusinessSqlExecutor\(businessSqlPool,/)
 assert.match(source,/new BusinessDefinitionPreviewService\(pool,identity,local,definitions,ledger,\{widgets,resolveSource:businessSyncSources\}\)/)
 assert.match(source,/const toolRegistrationContext=toolResourceProvenance\.wrapContext\(ctx,\{kind:'plugin',providerId:'@teloa\/harness-dsh',name:'Teloa'\}\)/)
 assert.match(source,/registerBusinessResultTools\(toolRegistrationContext,/)
 assert.doesNotMatch(source,/business-sql-reader\.json'[^\n]*logger/)
})
