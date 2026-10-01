import test from 'node:test'
import assert from 'node:assert/strict'
import {businessDefinitionKinds,readBusinessDefinitionBody,businessDefinitionCanonicalBody,businessDefinitionPaths,businessCustomizationLimits,type BusinessDefinitionPreview} from '../src/business-definitions.ts'

const view={format:'teloa.business-view/v1',id:'soc-risk-distribution',version:'1.0.0',domain:'SOC',title:'风险分布',kind:'distribution',chart:'bar',objectType:'alert-ticket',dimension:{field:'severity',limit:10},measures:[{id:'count',label:'条数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'count',direction:'desc'},limit:10}

const widget={format:'teloa.business-widget/v1',id:'alert-count',version:'1.0.0',domain:'SOC',title:'告警数',kind:'metric',query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
const dashboard={format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets:['alert-count'],layout:[{widget:'alert-count',x:0,y:0,w:12,h:2}],refresh:{kind:'hourly',minute:5},acknowledgeShortInterval:false}
const mapping={format:'teloa.business-source-mapping/v1',id:'soc-alerts',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',source:{kind:'business-data-port',sourceId:'security-alerts'},mapping:[{path:'$.id',field:'alert-id'}],primaryKey:['alert-id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:600},acknowledgeShortInterval:false}
const invalidInput=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'

test('六种 kind 各自分派到对应 read*，kind 与正文 format 不符即 invalid-input',()=>{
 assert.equal(readBusinessDefinitionBody('view',view).id,'soc-risk-distribution')
 assert.throws(()=>readBusinessDefinitionBody('action',view),/teloa\/invalid-input|业务动作/)
 assert.deepEqual([...businessDefinitionKinds],['object-type','view','action','source-mapping','widget','dashboard'])
 assert.deepEqual(readBusinessDefinitionBody('widget',widget),widget)
 assert.deepEqual(readBusinessDefinitionBody('dashboard',dashboard),dashboard)
 assert.deepEqual(readBusinessDefinitionBody('source-mapping',mapping),mapping)
 assert.throws(()=>readBusinessDefinitionBody('widget',dashboard),invalidInput)
 assert.throws(()=>readBusinessDefinitionBody('dashboard',widget),invalidInput)
 const {domain:_domain,...domainless}=mapping
 assert.throws(()=>readBusinessDefinitionBody('source-mapping',domainless),invalidInput)
})

test('新种类的规范化正文与路径表沿用泛型遍历：幂等、无 undefined、嵌套键按路径展开',()=>{
 for(const [kind,definition] of [['widget',widget],['dashboard',dashboard],['source-mapping',mapping]] as const){
  const once=businessDefinitionCanonicalBody(readBusinessDefinitionBody(kind,definition))
  assert.equal(businessDefinitionCanonicalBody(readBusinessDefinitionBody(kind,JSON.parse(once))),once)
  assert.doesNotMatch(once,/undefined/)
 }
 const paths=businessDefinitionPaths(readBusinessDefinitionBody('dashboard',dashboard))
 assert.equal(paths.get('layout[0].w'),'12')
 assert.equal(paths.get('refresh.minute'),'5')
 assert.equal(businessDefinitionPaths(readBusinessDefinitionBody('widget',widget)).get('metric.valueColumn'),'"n"')
})

test('规范化正文稳定且可再解析：键序打乱后逐字相同，再规范化一次不变',()=>{
 const shuffled={...view,measures:[...view.measures],chart:view.chart,format:view.format}
 const once=businessDefinitionCanonicalBody(view)
 assert.equal(businessDefinitionCanonicalBody(shuffled),once)
 assert.equal(businessDefinitionCanonicalBody(JSON.parse(once)),once)
 assert.ok(Buffer.byteLength(once)<=businessCustomizationLimits.bodyBytes)
})

test('路径表按数组下标与嵌套键展开，数组保序',()=>{
 const paths=businessDefinitionPaths(view)
 assert.equal(paths.get('measures[0].aggregation'),'"count"')
 assert.equal(paths.get('dimension.limit'),'10')
 assert.equal(paths.has('dimension.bucket'),false)
})

test('正文超过 128 KiB 即 invalid-input，不静默入库',()=>{
 const oversized={...view,title:'风'.repeat(businessCustomizationLimits.bodyBytes)}
 assert.throws(()=>businessDefinitionCanonicalBody(oversized),(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input')
})

test('预览 trialUnavailable 增加 pull-failed 与 config-unreadable（只用于 source-mapping 草案：试拉调用失败 / 数据源配置文件读不了）',()=>{
 // 类型层的正负例由 pnpm typecheck 把关（node --test 只做类型擦除，不提供保护）：pull-failed / config-unreadable 可赋值，未列出的取值不可。
 const values:Array<NonNullable<BusinessDefinitionPreview['trialUnavailable']>>=['source-disconnected','no-objects','pull-required','pull-failed','config-unreadable']
 // @ts-expect-error 未列出的取值不属于 trialUnavailable
 const unknown:BusinessDefinitionPreview['trialUnavailable']='pull-timeout'
 assert.deepEqual(values,['source-disconnected','no-objects','pull-required','pull-failed','config-unreadable'])
 assert.equal(unknown,'pull-timeout')
})
