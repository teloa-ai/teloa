import test from 'node:test'
import assert from 'node:assert/strict'
import {
 businessDashboardEndpoints,businessDashboardLimits,businessTimeRanges,businessWidgetKinds,isBusinessMatchField,isBusinessMatchValue,
 readBusinessDashboardDefinition,readBusinessDashboardPage,readBusinessDashboardSummaries,readBusinessWidgetDefinition,validateWidgetResultShape,
} from '../src/business-dashboards.ts'
import {businessDefinitionCanonicalBody} from '../src/business-definitions.ts'
import {isPendingRequestEndpoint,pendingRequestEndpoints} from '../src/pending-requests.ts'

const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const hostInvalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-host-response'
const head={format:'teloa.business-widget/v1',version:'1.0.0',domain:'SOC',title:'告警'}
const metric={...head,id:'alert-count',kind:'metric',query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
const chart={...head,id:'alert-severity',kind:'chart',query:'select severity, count(*) as n from soc_alert group by severity',chart:{engine:'vega-lite',spec:{mark:'bar',encoding:{x:{field:'severity',type:'nominal'},y:{field:'n',type:'quantitative'}}}}}
const dashboard={
 format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',
 widgets:['alert-count','alert-severity'],
 layout:[{widget:'alert-count',x:0,y:0,w:6,h:2},{widget:'alert-severity',x:6,y:0,w:6,h:4}],
 refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false,
}

test('常量与种类逐字照计划',()=>{
 assert.deepEqual([...businessWidgetKinds],['chart','metric','table','board','pipeline','list','view-ref'])
 assert.deepEqual(businessDashboardLimits,{widgetsPerDashboard:12,dashboardsPerScope:16,widgetsPerScope:64,sqlBytes:8192,resultRows:10_000,rowBytes:1_048_576,resultBytes:8_388_608,concurrencyPerScope:5,queueWaitMs:10_000,statementTimeoutMs:5_000,workMem:'256MB',tempFileLimit:'512MB',retentionDays:90,scopeRowQuota:500_000})
 assert.deepEqual([...businessDashboardEndpoints],['business-dashboards/list','business-dashboards/read','business-dashboards/refresh','business-sync/status','business-sync/runs','business-sync/run','business-sync/rules'])
})

test('组件声明：合法样例原样返回；种类与附属配置一一对应',()=>{
 assert.deepEqual(readBusinessWidgetDefinition(metric),metric)
 assert.deepEqual(readBusinessWidgetDefinition(chart),chart)
 const board={...head,id:'alert-board',kind:'board',query:'select id, title, status from soc_alert',board:{statusColumn:'status',titleColumn:'title',idColumn:'id',statuses:['new','triage','closed']},thresholds:[{field:'n',op:'gte',value:10,tone:'bad'}]}
 assert.deepEqual(readBusinessWidgetDefinition(board),board)
 const viewRef={...head,id:'alert-view',kind:'view-ref',viewRef:'soc-risk-distribution'}
 assert.deepEqual(readBusinessWidgetDefinition(viewRef),viewRef)
 const {chart:_chart,...chartless}=chart
 assert.throws(()=>readBusinessWidgetDefinition(chartless),invalid)
 assert.throws(()=>readBusinessWidgetDefinition({...metric,chart:chart.chart}),invalid)
 assert.throws(()=>readBusinessWidgetDefinition({...viewRef,query:'select 1'}),invalid)
 assert.throws(()=>readBusinessWidgetDefinition({...metric,viewRef:'x'}),invalid)
 const {query:_query,...queryless}=metric
 assert.throws(()=>readBusinessWidgetDefinition(queryless),invalid)
 assert.throws(()=>readBusinessWidgetDefinition({...metric,table:{columns:['n']}}),invalid)
 assert.deepEqual(readBusinessWidgetDefinition({...head,id:'alert-list',kind:'list',query:'select 1 as a',table:{columns:['a']}}).table,{columns:['a']})
})

test('组件声明：SQL 上限、阈值条数、看板状态去重、图表规范违规',()=>{
 assert.throws(()=>readBusinessWidgetDefinition({...metric,query:'s'.repeat(businessDashboardLimits.sqlBytes+1)}),(error:unknown)=>invalid(error)&&/8192/.test((error as Error).message))
 assert.doesNotThrow(()=>readBusinessWidgetDefinition({...metric,query:'s'.repeat(businessDashboardLimits.sqlBytes)}))
 const threshold={field:'n',op:'gte',value:1,tone:'warn'}
 assert.throws(()=>readBusinessWidgetDefinition({...metric,thresholds:Array.from({length:5},()=>threshold)}),invalid)
 const {metric:_metric,...metricless}=metric
 assert.throws(()=>readBusinessWidgetDefinition({...metricless,kind:'board',board:{statusColumn:'s',titleColumn:'t',idColumn:'i',statuses:['a','a']}}),invalid)
 assert.throws(()=>readBusinessWidgetDefinition({...chart,chart:{engine:'vega-lite',spec:{mark:'bar',data:{url:'x'}}}}),(error:unknown)=>invalid(error)&&/spec\.data\.url/.test((error as Error).message))
})

test('组件声明：refresh 与看板同口径，短周期确认位只写在顶层',()=>{
 assert.throws(()=>readBusinessWidgetDefinition({...metric,refresh:{kind:'every',seconds:30}}),invalid)
 assert.throws(()=>readBusinessWidgetDefinition({...metric,refresh:{kind:'every',seconds:30},acknowledgeShortInterval:false}),invalid)
 assert.deepEqual(readBusinessWidgetDefinition({...metric,refresh:{kind:'every',seconds:30},acknowledgeShortInterval:true}).refresh,{kind:'every',seconds:30})
 assert.throws(()=>readBusinessWidgetDefinition({...metric,refresh:{kind:'every',seconds:30,acknowledgeShortInterval:true},acknowledgeShortInterval:true}),invalid)
})

test('规范化正文幂等且不含 undefined',()=>{
 const once=businessDefinitionCanonicalBody(readBusinessWidgetDefinition(metric))
 assert.equal(businessDefinitionCanonicalBody(readBusinessWidgetDefinition(JSON.parse(once))),once)
 assert.doesNotMatch(once,/undefined/)
})

test('看板声明：合法样例原样返回',()=>{
 assert.deepEqual(readBusinessDashboardDefinition(dashboard),dashboard)
})

test('组件 drilldown：只写 objectType / idColumn / match 三种写法原样收；互斥、view-ref、metric 带列、列名与字段标识不合规、图表下钻列不在编码字段、多键缺键一律拒',()=>{
 const table={...head,id:'alert-table',kind:'table',query:'select _id, severity, host from soc_alert',table:{columns:['severity','host']}}
 const pipeline={...head,id:'alert-stages',kind:'pipeline',query:'select verdict, count(*) as n from soc_alert group by verdict',pipeline:{stageColumn:'verdict',countColumn:'n',stages:['新','已关']}}
 for(const widget of [
  {...metric,drilldown:{objectType:'alert-ticket'}},
  {...table,drilldown:{objectType:'alert-ticket',idColumn:'_id'}},
  {...table,drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}},
  {...chart,drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}},
  {...chart,drilldown:{objectType:'alert-ticket'}},
  {...pipeline,drilldown:{objectType:'alert-ticket',match:{column:'verdict',field:'verdict'}}},
 ])assert.deepEqual(readBusinessWidgetDefinition(widget),widget,JSON.stringify(widget.drilldown))
 const rejects=(widget:Record<string,unknown>,reason:RegExp)=>assert.throws(()=>readBusinessWidgetDefinition(widget),(error:unknown)=>invalid(error)&&reason.test((error as Error).message)||assert.fail(JSON.stringify(widget.drilldown)+' → '+(error as Error).message))
 rejects({...table,drilldown:{objectType:'alert-ticket',idColumn:'_id',match:{column:'severity',field:'severity'}}},/idColumn 与 match/)
 rejects({...head,id:'alert-view',kind:'view-ref',viewRef:'soc-risk-distribution',drilldown:{objectType:'alert-ticket'}},/view-ref/)
 rejects({...metric,drilldown:{objectType:'alert-ticket',idColumn:'n'}},/metric/)
 rejects({...metric,drilldown:{objectType:'alert-ticket',match:{column:'n',field:'severity'}}},/metric/)
 rejects({...chart,drilldown:{objectType:'alert-ticket',idColumn:'_id'}},/_id.*图表编码/)
 rejects({...chart,drilldown:{objectType:'alert-ticket',match:{column:'host',field:'host'}}},/host.*图表编码/)
 rejects({...pipeline,drilldown:{objectType:'alert-ticket',idColumn:'verdict'}},/pipeline/)
 rejects({...pipeline,drilldown:{objectType:'alert-ticket',match:{column:'n',field:'verdict'}}},/stageColumn/)
 for(const drilldown of [
  {objectType:'不合法'},
  {objectType:'alert_ticket'},
  {objectType:'alert-ticket',idColumn:'1bad'},
  {objectType:'alert-ticket',idColumn:'has-dash'},
  {objectType:'alert-ticket',match:{column:'severity',field:'Severity'}},
  {objectType:'alert-ticket',match:{column:'severity',field:'_id'}},
  {objectType:'alert-ticket',match:{column:'sev erity',field:'severity'}},
  {objectType:'alert-ticket',match:{column:'severity'}},
  {objectType:'alert-ticket',match:{column:'severity',field:'severity',value:'高'}},
  {objectType:'alert-ticket',kind:'objects'},
  {kind:'tasks'},
  {},
  null,
  'alert-ticket',
 ])assert.throws(()=>readBusinessWidgetDefinition({...table,drilldown}),invalid,JSON.stringify(drilldown))
})

test('结果形状：下钻用到的列并入必需列，缺了即返回缺列说明',()=>{
 const shaped=(columns:string[])=>({widgetId:'w',definitionHash:'a'.repeat(64),computedAt:'2026-09-25T00:00:00.000Z',status:'ok' as const,columns:columns.map(name=>({name,type:'text' as const})),rows:[],rowCount:0,truncated:false as const,bytes:0,stale:false})
 const byId=readBusinessWidgetDefinition({...head,id:'t',kind:'table',query:'select 1',table:{columns:['host']},drilldown:{objectType:'alert-ticket',idColumn:'_id'}})
 assert.equal(validateWidgetResultShape(byId,shaped(['host','_id'])),null)
 assert.match(String(validateWidgetResultShape(byId,shaped(['host']))),/缺少组件声明要用的列：_id/)
 const byMatch=readBusinessWidgetDefinition({...head,id:'l',kind:'list',query:'select 1',table:{columns:['host']},drilldown:{objectType:'alert-ticket',match:{column:'severity',field:'severity'}}})
 assert.match(String(validateWidgetResultShape(byMatch,shaped(['host']))),/severity/)
 assert.equal(validateWidgetResultShape(readBusinessWidgetDefinition({...metric,drilldown:{objectType:'alert-ticket'}}),{...shaped(['n']),rows:[[1]] as never,rowCount:1}),null,'只写 objectType 不要求任何列')
})

test('看板 filters.timeRange：1–5 个去重取值保持声明顺序、default 在内；空、重复、default 不在内、未知键、timeRange 以外的键一律拒',()=>{
 assert.deepEqual([...businessTimeRanges],['24h','7d','30d','90d','all'])
 const filtered={...dashboard,filters:{timeRange:{options:['30d','7d','all'],default:'7d'}}}
 assert.deepEqual(readBusinessDashboardDefinition(filtered),filtered)
 assert.deepEqual(readBusinessDashboardDefinition({...dashboard,filters:{timeRange:{options:['24h','7d','30d','90d','all'],default:'all'}}}).filters?.timeRange.options,['24h','7d','30d','90d','all'])
 assert.deepEqual(readBusinessDashboardDefinition({...dashboard,filters:{timeRange:{options:['90d'],default:'90d'}}}).filters,{timeRange:{options:['90d'],default:'90d'}})
 for(const filters of [
  {},
  {timeRange:{options:[],default:'7d'}},
  {timeRange:{options:['7d','7d'],default:'7d'}},
  {timeRange:{options:['7d','30d'],default:'90d'}},
  {timeRange:{options:['7d','1y'],default:'7d'}},
  {timeRange:{options:['7d'],default:'7d',custom:true}},
  {timeRange:{options:['7d']}},
  {timeRange:{relative:'last-7d'}},
  {timeRange:{options:'7d',default:'7d'}},
  {timeRange:{options:['7d'],default:'7d'},owner:'x'},
  {owner:'x'},
  null,
  [],
 ])assert.throws(()=>readBusinessDashboardDefinition({...dashboard,filters}),invalid,JSON.stringify(filters))
})

test('组件 timeFilter：表名 / 列名合规即收；view-ref、metric.previousColumn 同现即拒；表名 / 列名不合规、多键缺键即拒',()=>{
 const bound={...metric,timeFilter:{table:'soc_alert',column:'alerted-at'}}
 assert.deepEqual(readBusinessWidgetDefinition(bound),bound)
 for(const column of ['_observed_at','_synced_at','first_seen_at'])assert.deepEqual(readBusinessWidgetDefinition({...chart,timeFilter:{table:'soc_alert',column}}).timeFilter,{table:'soc_alert',column})
 assert.throws(()=>readBusinessWidgetDefinition({...head,id:'alert-view',kind:'view-ref',viewRef:'soc-risk-distribution',timeFilter:{table:'soc_alert',column:'_observed_at'}}),(error:unknown)=>invalid(error)&&/view-ref/.test((error as Error).message))
 assert.throws(()=>readBusinessWidgetDefinition({...metric,metric:{valueColumn:'n',previousColumn:'p'},timeFilter:{table:'soc_alert',column:'_observed_at'}}),(error:unknown)=>invalid(error)&&/previousColumn/.test((error as Error).message))
 for(const timeFilter of [
  {table:'soc-alert',column:'_observed_at'},
  {table:'soc_alert x',column:'_observed_at'},
  {table:'public.soc_alert',column:'_observed_at'},
  {table:'"soc_alert"',column:'_observed_at'},
  {table:'',column:'_observed_at'},
  {table:'soc_alert',column:'_deleted_at'},
  {table:'soc_alert',column:'_id'},
  {table:'soc_alert',column:'Alerted'},
  {table:'soc_alert',column:'a"b'},
  {table:'soc_alert',column:'a b'},
  {table:'soc_alert',column:'x'.repeat(64)},
  {table:'soc_alert'},
  {table:'soc_alert',column:'_observed_at',interval:'7 days'},
  {table:1,column:'_observed_at'},
  'soc_alert._observed_at',
 ])assert.throws(()=>readBusinessWidgetDefinition({...metric,timeFilter}),invalid,JSON.stringify(timeFilter))
})

test('看板声明：布局重叠、越界、缺项、超量、短周期无确认一律拒绝',()=>{
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,layout:[{widget:'alert-count',x:0,y:0,w:6,h:2},{widget:'alert-severity',x:5,y:1,w:2,h:1}]}),invalid)
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,layout:[{widget:'alert-count',x:0,y:0,w:6,h:2},{widget:'alert-severity',x:7,y:0,w:6,h:4}]}),invalid)
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,layout:[dashboard.layout[0]]}),invalid)
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,layout:[...dashboard.layout,{widget:'alert-count',x:0,y:4,w:6,h:2}]}),invalid)
 const widgets=Array.from({length:13},(_,index)=>'w'+index)
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,widgets,layout:widgets.map((widget,index)=>({widget,x:0,y:index,w:1,h:1}))}),invalid)
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,refresh:{kind:'every',seconds:30}}),invalid)
 assert.deepEqual(readBusinessDashboardDefinition({...dashboard,refresh:{kind:'every',seconds:30},acknowledgeShortInterval:true}).refresh,{kind:'every',seconds:30})
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,widgets:['alert-count','alert-count']}),invalid)
 assert.throws(()=>readBusinessDashboardDefinition({...dashboard,layout:[{...dashboard.layout[0],h:13},dashboard.layout[1]]}),invalid)
})

const hash='a'.repeat(64),stamp='2026-09-25T02:00:00.000Z'
const result={widgetId:'alert-count',definitionHash:hash,computedAt:stamp,status:'ok',columns:[{name:'n',type:'number'}],rows:[[3]],rowCount:1,truncated:false,bytes:3,stale:false}
const page={schema:'teloa.business-dashboard-page/v1',scope:'SOC',dashboard,widgets:[metric,chart],results:[result],updatedAt:stamp,nextRefreshAt:'2026-09-25T02:05:00.000Z',refreshing:false,timeRange:null}

test('看板页回包：合法样例原样返回，形状不符为 invalid-host-response',()=>{
 assert.deepEqual(readBusinessDashboardPage(page,'SOC'),page)
 assert.throws(()=>readBusinessDashboardPage(page,'OTHER'),hostInvalid)
 assert.throws(()=>readBusinessDashboardPage({...page,extra:1},'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardPage({...page,results:[{...result,rows:[[3,4]]}]},'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardPage({...page,results:[{...result,truncated:true}]},'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardPage({...page,results:[{...result,status:'failed'}]},'SOC'),hostInvalid)
 const failed={...result,status:'failed',columns:[],rows:[],rowCount:0,bytes:0,error:{code:'teloa/invalid-input',reason:'SQL 不符合规则'}}
 assert.deepEqual(readBusinessDashboardPage({...page,results:[failed]},'SOC').results[0],failed)
 assert.throws(()=>readBusinessDashboardPage({...page,results:[{...failed,error:{code:'teloa/nope',reason:'x'}}]},'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardPage({...page,widgets:[{...metric,id:'other'}]},'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardPage({...page,dashboard:{...dashboard,layout:[]}},'SOC'),hostInvalid)
 const {timeRange:_timeRange,...rangeless}=page
 assert.throws(()=>readBusinessDashboardPage(rangeless,'SOC'),hostInvalid,'timeRange 必填（无 filters 时为 null）')
})

test('看板页 timeRange：与声明一致才收；无 filters 必为 null；options 与声明不一致、selected 不在内即 invalid-host-response',()=>{
 const filtered={...dashboard,filters:{timeRange:{options:['7d','30d','all'],default:'7d'}}}
 const ranged={...page,dashboard:filtered,timeRange:{selected:'30d',options:['7d','30d','all']}}
 assert.deepEqual(readBusinessDashboardPage(ranged,'SOC'),ranged)
 assert.throws(()=>readBusinessDashboardPage({...page,timeRange:{selected:'all',options:['all']}},'SOC'),hostInvalid,'无 filters 却给了范围')
 for(const timeRange of [
  null,
  {selected:'90d',options:['7d','30d','all']},
  {selected:'7d',options:['7d','30d']},
  {selected:'7d',options:['30d','7d','all']},
  {selected:'7d',options:['7d','30d','all','90d']},
  {selected:'7d',options:['7d','30d','all'],default:'7d'},
  {selected:'1y',options:['7d','30d','all']},
  {options:['7d','30d','all']},
 ])assert.throws(()=>readBusinessDashboardPage({...ranged,timeRange},'SOC'),hostInvalid,JSON.stringify(timeRange))
})

test('看板摘要回包',()=>{
 const summary={id:'soc-overview',title:'安全运营大盘',widgets:2,updatedAt:null}
 assert.deepEqual(readBusinessDashboardSummaries([summary],'SOC'),[summary])
 assert.throws(()=>readBusinessDashboardSummaries([summary,summary],'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardSummaries([{...summary,widgets:13}],'SOC'),hostInvalid)
 assert.throws(()=>readBusinessDashboardSummaries([summary],'bad scope'),hostInvalid)
})

test('待恢复目录白名单：看板刷新与手动同步入目录，只读端点不入，两边都不许默默漂移',()=>{
 for(const endpoint of ['business-dashboards/refresh','business-sync/run'])assert.ok((pendingRequestEndpoints as readonly string[]).includes(endpoint),endpoint)
 for(const endpoint of ['business-dashboards/list','business-dashboards/read','business-sync/status','business-sync/runs'])assert.equal(isPendingRequestEndpoint(endpoint),false,endpoint)
})

test('枚举报错回显原值截断到 80 字',()=>{
 const long='x'.repeat(500)
 assert.throws(()=>readBusinessWidgetDefinition({...metric,kind:long}),(error:unknown)=>{
  const message=(error as Error).message,echoed=/当前为「([^」]*)」/.exec(message)?.[1]??''
  return (error as {code?:string}).code==='teloa/invalid-input'&&echoed.length<=81&&echoed.startsWith('x'.repeat(80))
 })
})

test('原生组件结果形状：metric 恰 1 行且含取值列，board/pipeline/table 列存在，chart 编码字段存在，阈值列存在；只看列不看取值',()=>{
 const result=(columns:string[],rows:unknown[][])=>({widgetId:'w',definitionHash:'a'.repeat(64),computedAt:'2026-09-25T00:00:00.000Z',status:'ok' as const,columns:columns.map(name=>({name,type:'text' as const})),rows:rows as never,rowCount:rows.length,truncated:false as const,bytes:0,stale:false})
 const m=readBusinessWidgetDefinition({...metric,metric:{valueColumn:'value',previousColumn:'previous'}})
 assert.equal(validateWidgetResultShape(m,result(['value','previous'],[[12,10]])),null)
 assert.match(String(validateWidgetResultShape(m,result(['value','previous'],[[12,10],[1,1]]))),/恰好 1 行/)
 assert.match(String(validateWidgetResultShape(m,result(['value','previous'],[]))),/恰好 1 行/)
 assert.match(String(validateWidgetResultShape(m,result(['n','previous'],[[1,1]]))),/value/)
 assert.match(String(validateWidgetResultShape(m,result(['value'],[[1]]))),/previous/)
 const board=readBusinessWidgetDefinition({...head,id:'b',kind:'board',query:'select 1',board:{statusColumn:'status',titleColumn:'title',idColumn:'_id',statuses:['新']}})
 assert.equal(validateWidgetResultShape(board,result(['status','title','_id'],[['不在列表里的状态','t','1']])),null)
 assert.match(String(validateWidgetResultShape(board,result(['status','_id'],[]))),/title/)
 const pipeline=readBusinessWidgetDefinition({...head,id:'p',kind:'pipeline',query:'select 1',pipeline:{stageColumn:'stage',countColumn:'n',durationColumn:'d',stages:['a']}})
 assert.equal(validateWidgetResultShape(pipeline,result(['stage','n','d'],[])),null)
 assert.match(String(validateWidgetResultShape(pipeline,result(['stage','n'],[]))),/d/)
 const table=readBusinessWidgetDefinition({...head,id:'t',kind:'table',query:'select 1',table:{columns:['a','b']},thresholds:[{field:'c',op:'gte',value:1,tone:'bad'}]})
 assert.equal(validateWidgetResultShape(table,result(['a','b','c'],[])),null)
 assert.match(String(validateWidgetResultShape(table,result(['a','c'],[]))),/b/)
 assert.match(String(validateWidgetResultShape(table,result(['a','b'],[]))),/c/)
 assert.equal(validateWidgetResultShape(readBusinessWidgetDefinition({...head,id:'l',kind:'list',query:'select 1'}),result(['x'],[])),null)
 const c=readBusinessWidgetDefinition(chart)
 assert.equal(validateWidgetResultShape(c,result(['severity','n'],[])),null)
 assert.match(String(validateWidgetResultShape(c,result(['severity'],[]))),/n/)
 // transform 产出的列（as）不要求出现在结果里。
 const folded=readBusinessWidgetDefinition({...chart,chart:{engine:'vega-lite',spec:{mark:'bar',transform:[{aggregate:[{op:'sum',field:'n',as:'total'}],groupby:['severity']}],encoding:{x:{field:'severity',type:'nominal'},y:{field:'total',type:'quantitative'}}}}})
 assert.equal(validateWidgetResultShape(folded,result(['severity','n'],[])),null)
 // 失败结果与 view-ref 不做列核对。
 assert.equal(validateWidgetResultShape(readBusinessWidgetDefinition({...head,id:'v',kind:'view-ref',viewRef:'x'}),result([],[])),null)
 assert.equal(validateWidgetResultShape(m,{...result([],[]),status:'failed',error:{code:'teloa/invalid-input',reason:'x'}}),null)
})

test('业务范围键：声明 domain 与看板读侧同一判据；中文、空格、超长在声明处拒收，合规键往返读得出',()=>{
 const rule=(error:unknown)=>invalid(error)&&/业务范围只能是 1–64 位字母、数字、下划线或连字符/.test((error as Error).message)
 for(const domain of ['质量管理','quality mgmt','q'.repeat(65),'general']){
  assert.throws(()=>readBusinessWidgetDefinition({...metric,domain}),domain==='general'?invalid:rule)
  assert.throws(()=>readBusinessDashboardDefinition({...dashboard,domain}),domain==='general'?invalid:rule)
 }
 const scope='quality_mgmt-2'
 const scoped={...page,scope,dashboard:{...dashboard,domain:scope},widgets:[{...metric,domain:scope},{...chart,domain:scope}]}
 assert.deepEqual(readBusinessDashboardPage(scoped,scope),scoped)
 assert.deepEqual(readBusinessDashboardSummaries([],scope),[])
 assert.throws(()=>readBusinessDashboardSummaries([],'质量管理'),hostInvalid)
})

test('按字段取值过滤的共用判据：字段为对象字段标识或 _id，取值 1–200 字无控制字符；客户端与宿主五处都引用这一份',async()=>{
 for(const field of ['_id','severity','first-seen-at','a1_b'])assert.equal(isBusinessMatchField(field),true,field)
 for(const field of ['','_ID','Severity','_observed_at','-a','a'.repeat(64),1,null])assert.equal(isBusinessMatchField(field),false,String(field))
 for(const value of ['高','x','x'.repeat(200),'a b'])assert.equal(isBusinessMatchValue(value),true,value)
 for(const value of ['','x'.repeat(201),'a\nb','a\u007fb',1,true,null])assert.equal(isBusinessMatchValue(value),false,String(value))
 const {readFile}=await import('node:fs/promises')
 for(const file of ['../../backend/src/work/business-view-compute.ts','../../client/ui-workbench/src/client/business-ledger-api.ts','../../client/ui-workbench/src/client/workbench-navigation-state.ts','../../client/ui-workbench/src/client/sidebar-right-tabs.ts','../../client/ui-workbench/src/client/business-widget-presentation.ts']){
  const source=await readFile(new URL(file,import.meta.url),'utf8')
  assert.match(source,/isBusinessMatchValue\(/,file+' 引用契约取值判据')
  assert.doesNotMatch(source,/length>200|length<=200|\[a-z0-9\]\[a-z0-9_-\]\{0,62\}/,file+' 不再自写一份判据')
 }
})
