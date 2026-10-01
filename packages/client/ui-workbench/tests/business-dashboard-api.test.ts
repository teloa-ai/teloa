import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessDashboardApi} from '../src/client/business-dashboard-api.ts'

const head={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',title:'告警'}
const metric={...head,id:'alert-count',kind:'metric',query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
const dashboard={
 format:'teloa.business-dashboard/v1',id:'soc-ops',version:'1.0.0',domain:'SOC',title:'安全运营大盘',
 widgets:['alert-count'],layout:[{widget:'alert-count',x:0,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,
}
const stamp='2026-09-25T02:00:00.000Z'
const result={widgetId:'alert-count',definitionHash:'a'.repeat(64),computedAt:stamp,status:'ok',columns:[{name:'n',type:'number'}],rows:[[3]],rowCount:1,truncated:false,bytes:3,stale:false}
const page={schema:'teloa.business-dashboard-page/v1',scope:'SOC',dashboard,widgets:[metric],results:[result],updatedAt:stamp,nextRefreshAt:null,refreshing:false,timeRange:null}
const requestId='5f0c6f1e-3d1a-4c55-9f3a-2b8e7c1d0a11'
const run={id:'5f0c6f1e-3d1a-4c55-9f3a-2b8e7c1d0a12',mappingId:'soc-alerts',scope:'SOC',startedAt:stamp,finishedAt:stamp,status:'ok',upserted:2,tombstoned:0,fetched:2,durationMs:12,trigger:'manual'}

function fake(reply:(method:string,payload:unknown)=>unknown){
 const calls:Array<{method:string;payload:unknown}>=[]
 return {calls,api:createBusinessDashboardApi(async(method,payload)=>{calls.push({method,payload});return reply(method,payload)})}
}

test('读看板：回包过契约读取器，缺 results 即拒绝',async()=>{
 const {api,calls}=fake(()=>page)
 const read=await api.read({scope:'SOC',dashboardId:'soc-ops'})
 assert.equal(read.dashboard.title,'安全运营大盘')
 assert.deepEqual(calls,[{method:'business-dashboards/read',payload:{scope:'SOC',dashboardId:'soc-ops'}}])
 const {results:_results,...missing}=page
 await assert.rejects(createBusinessDashboardApi(async()=>missing).read({scope:'SOC',dashboardId:'soc-ops'}))
 // 回包里的看板不是请求的那一张，一样按宿主回包错误拒绝。
 await assert.rejects(createBusinessDashboardApi(async()=>({...page,dashboard:{...dashboard,id:'other'}})).read({scope:'SOC',dashboardId:'soc-ops'}))
})

test('刷新与立即同步：缺请求标识先在客户端拒绝，不发请求',async()=>{
 const {api,calls}=fake(()=>page)
 await assert.rejects(api.refresh({scope:'SOC',dashboardId:'soc-ops'} as never))
 await assert.rejects(api.refresh({requestId:'not-a-uuid',scope:'SOC',dashboardId:'soc-ops'}))
 await assert.rejects(api.syncRun({scope:'SOC',mappingId:'soc-alerts'} as never))
 assert.equal(calls.length,0)
 await api.refresh({requestId,scope:'SOC',dashboardId:'soc-ops'})
 assert.deepEqual(calls[0],{method:'business-dashboards/refresh',payload:{requestId,scope:'SOC',dashboardId:'soc-ops'}})
})

test('提交载荷只含契约键：调用方多带的字段不往宿主递',async()=>{
 const {api,calls}=fake(method=>method==='business-dashboards/list'?[{id:'soc-ops',title:'安全运营大盘',widgets:1,updatedAt:null}]
  :method==='business-sync/status'?[{mappingId:'soc-alerts',lastRun:run,consecutiveFailures:0,quota:{rows:2,limit:500000}}]
  :method==='business-sync/runs'?[run]:run)
 await api.list({scope:'SOC',extra:1} as never)
 await api.read({scope:'SOC',dashboardId:'soc-ops',evil:true} as never).catch(()=>{})
 await api.syncStatus({scope:'SOC'})
 await api.syncRuns({scope:'SOC',limit:5})
 await api.syncRuns({scope:'SOC',mappingId:'soc-alerts',limit:5})
 await api.syncRun({requestId,scope:'SOC',mappingId:'soc-alerts',owner:'x'} as never)
 assert.deepEqual(calls.map(call=>[call.method,Object.keys(call.payload as object).sort()]),[
  ['business-dashboards/list',['scope']],
  ['business-dashboards/read',['dashboardId','scope']],
  ['business-sync/status',['scope']],
  ['business-sync/runs',['limit','scope']],
  ['business-sync/runs',['limit','mappingId','scope']],
  ['business-sync/run',['mappingId','requestId','scope']],
 ])
 await assert.rejects(api.read({scope:'SOC',dashboardId:'soc:ops'}))
 await assert.rejects(api.list({scope:'general'}))
})

test('同步状态与记录：回包过契约读取器，映射对不上即拒绝',async()=>{
 await assert.rejects(createBusinessDashboardApi(async()=>({...run,mappingId:'other'})).syncRun({requestId,scope:'SOC',mappingId:'soc-alerts'}))
 await assert.rejects(createBusinessDashboardApi(async()=>({})).syncStatus({scope:'SOC'}))
 const status=await createBusinessDashboardApi(async()=>[{mappingId:'soc-alerts',consecutiveFailures:2,quota:{rows:0,limit:500000}}]).syncStatus({scope:'SOC'})
 assert.equal(status[0]!.consecutiveFailures,2)
})

test('持续规则列表与启停：固定请求键，回包映射/修订核对，失败保留调用方状态',async()=>{
 const state={scope:'SOC',mappingId:'soc-alerts',definitionHash:'a'.repeat(64),enabled:false,revision:1}
 const view={...state,title:'SOC 告警同步',schedule:{kind:'every',seconds:300},running:false}
 const {api,calls}=fake(method=>method==='business-sync/rules'?[view]:state)
 assert.deepEqual(await api.syncRules({scope:'SOC'}),[view])
 assert.deepEqual(await api.setSyncRule({scope:'SOC',mappingId:'soc-alerts',enabled:false,expectedRevision:0,requestId}),state)
 assert.deepEqual(calls,[{method:'business-sync/rules',payload:{scope:'SOC'}},{method:'business-sync/rule-set',payload:{scope:'SOC',mappingId:'soc-alerts',enabled:false,expectedRevision:0,requestId}}])
 await assert.rejects(api.setSyncRule({scope:'SOC',mappingId:'soc-alerts',enabled:true,expectedRevision:1,requestId:'bad'}))
 assert.equal(calls.length,2)
 await assert.rejects(createBusinessDashboardApi(async()=>({...state,mappingId:'other'})).setSyncRule({scope:'SOC',mappingId:'soc-alerts',enabled:false,expectedRevision:0,requestId}))
 await assert.rejects(createBusinessDashboardApi(async()=>[{...view,running:true}]).syncRules({scope:'SOC'}))
})

test('业务级持续运行总开关：读取实际受管状态，写入核对预期修订与回包',async()=>{
 const state={scope:'SOC',managed:true,syncEnabled:false,revision:3}
 const {api,calls}=fake(method=>method==='business-sync/runtime'?{...state,syncEnabled:true,revision:2}:state)
 assert.deepEqual(await api.syncRuntime({scope:'SOC'}),{...state,syncEnabled:true,revision:2})
 assert.deepEqual(await api.setSyncRuntime({scope:'SOC',enabled:false,expectedRevision:2,requestId}),state)
 assert.deepEqual(calls,[{method:'business-sync/runtime',payload:{scope:'SOC'}},{method:'business-sync/runtime-set',payload:{scope:'SOC',enabled:false,expectedRevision:2,requestId}}])
 await assert.rejects(api.setSyncRuntime({scope:'SOC',enabled:true,expectedRevision:2,requestId:'bad'}))
 assert.equal(calls.length,2)
 await assert.rejects(createBusinessDashboardApi(async()=>({...state,scope:'Other'})).syncRuntime({scope:'SOC'}))
 await assert.rejects(createBusinessDashboardApi(async()=>({...state,syncEnabled:true})).setSyncRuntime({scope:'SOC',enabled:false,expectedRevision:2,requestId}))
})

test('业务范围键：与契约同一判据——合规键往返读得出，中文或带空格的范围在客户端就拒绝、不发请求',async()=>{
 const scope='quality_mgmt-2'
 const scoped={...page,scope,dashboard:{...dashboard,domain:scope},widgets:[{...metric,domain:scope}]}
 const {api,calls}=fake(()=>scoped)
 assert.deepEqual(await api.read({scope,dashboardId:'soc-ops'}),scoped)
 for(const bad of ['质量管理','quality mgmt','general']){
  await assert.rejects(api.read({scope:bad,dashboardId:'soc-ops'}),/需要明确的业务范围/)
  await assert.rejects(api.list({scope:bad}),/需要明确的业务范围/)
 }
 assert.equal(calls.length,1)
})

const rangedWidget={...metric,timeFilter:{table:'soc_alert',column:'_observed_at'}}
const rangedPage=(selected:string)=>({...page,dashboard:{...dashboard,filters:{timeRange:{options:['7d','30d'],default:'7d'}}},widgets:[rangedWidget],timeRange:{selected,options:['7d','30d']}})

test('时间范围：未选范围载荷键集不变；选了才多带 timeRange；不上传组件定义',async()=>{
 const {api,calls}=fake((_method,payload)=>rangedPage((payload as {timeRange?:string}).timeRange??'7d'))
 await api.read({scope:'SOC',dashboardId:'soc-ops'})
 await api.read({scope:'SOC',dashboardId:'soc-ops',timeRange:'30d'})
 await api.read({scope:'SOC',dashboardId:'soc-ops',timeRange:undefined})
 await api.refresh({requestId,scope:'SOC',dashboardId:'soc-ops'})
 await api.refresh({requestId,scope:'SOC',dashboardId:'soc-ops',timeRange:'30d',widgets:[rangedWidget]} as never)
 assert.deepEqual(calls.map(call=>[call.method,Object.keys(call.payload as object).sort()]),[
  ['business-dashboards/read',['dashboardId','scope']],
  ['business-dashboards/read',['dashboardId','scope','timeRange']],
  ['business-dashboards/read',['dashboardId','scope']],
  ['business-dashboards/refresh',['dashboardId','requestId','scope']],
  ['business-dashboards/refresh',['dashboardId','requestId','scope','timeRange']],
 ])
 assert.equal((calls[1]!.payload as {timeRange:string}).timeRange,'30d')
 assert.equal((calls[4]!.payload as {timeRange:string}).timeRange,'30d')
})

test('时间范围：不在五个取值里先在客户端拒绝、不发请求；回包所选范围与请求不符按宿主回包错误拒绝',async()=>{
 const {api,calls}=fake(()=>rangedPage('7d'))
 await assert.rejects(api.read({scope:'SOC',dashboardId:'soc-ops',timeRange:'1y'} as never))
 await assert.rejects(api.refresh({requestId,scope:'SOC',dashboardId:'soc-ops',timeRange:'7 days'} as never))
 assert.equal(calls.length,0)
 await assert.rejects(api.read({scope:'SOC',dashboardId:'soc-ops',timeRange:'30d'}),(error:{code?:string})=>error.code==='teloa/invalid-host-response')
 await assert.rejects(api.refresh({requestId,scope:'SOC',dashboardId:'soc-ops',timeRange:'30d'}),(error:{code?:string})=>error.code==='teloa/invalid-host-response')
})
