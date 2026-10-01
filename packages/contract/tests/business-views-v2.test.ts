import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import * as api from '../src/index.ts'

const scope='business_0123456789abcdef0123456789abcdef',stamp='2026-09-30T00:00:00.000Z'
const invalid={code:'teloa/invalid-input'},bad={code:'teloa/invalid-host-response'}
const money={format:'teloa.business-rich-field/v2',name:'amount',label:'金额',type:'money',required:false,from:'金额',currencies:['CNY','USD']}
const multi={format:'teloa.business-rich-field/v2',name:'tags',label:'标签',type:'multi-enum',required:false,from:'标签',values:['重点','续约']}
const state={name:'state',label:'阶段',type:'enum',required:true,from:'阶段',values:['新建','完成']}
const object={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:scope,title:'客户',unit:'位',lead:'客户跟进',sourceId:'records',fields:[state,money,multi,{name:'received',label:'日期',type:'datetime',required:false,from:'日期'}]}
const view={format:'teloa.business-view/v2',id:'amounts',version:'1.0.0',domain:scope,title:'标签金额',kind:'distribution',chart:'bar',objectType:'customer',dimension:{field:'tags',limit:10},measures:[{id:'amount',label:'人民币总额',aggregation:'sum',field:'amount',currency:'CNY'},{id:'mean',label:'平均金额',aggregation:'avg',field:'amount',currency:'CNY',where:{field:'tags',op:'contains',values:['重点']}}],filters:[{field:'tags',op:'overlaps',values:['重点','续约']}],sort:{by:'measure',measureId:'amount',direction:'desc'},limit:10}
const widget={format:'teloa.business-widget/v1',id:'amount-widget',version:'1.0.0',domain:scope,title:'金额',kind:'view-ref',viewRef:'amounts'}
const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'总览',widgets:['amount-widget'],layout:[{widget:'amount-widget',x:0,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
const definition={id:'home',title:'总览',kind:'dashboard',dashboardId:'overview'}
const candidate={format:'teloa.business-configuration/v2',scope,title:'客户跟进',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:object},{kind:'view',definition:view},{kind:'widget',definition:widget},{kind:'dashboard',definition:dashboard}],pages:[definition],homePageId:'home'}
const result={schema:'teloa.business-view-result/v2',viewId:'amounts',viewVersion:'1.0.0',definitionHash:'b'.repeat(64),origin:'local',kind:'distribution',chart:'bar',title:'标签金额',dimensionField:'tags',dimensionMode:'membership',scope,objectType:'customer',computedAt:stamp,measures:[{id:'amount',label:'人民币总额',aggregation:'sum',fieldType:'money',currency:'CNY'},{id:'mean',label:'平均金额',aggregation:'avg',fieldType:'money',currency:'CNY',rounding:{scale:4,mode:'half-even'}}],rows:[{dimension:'重点',label:'重点',values:[{type:'money',currency:'CNY',decimal:'9999999999999999999999.9999'},{type:'money',currency:'CNY',decimal:'-0.0002'}]},{dimension:'续约',label:'续约',values:[{type:'money',currency:'CNY',decimal:'0'},null]}],dimensionValues:2,coverage:{objects:3,latestReceivedAt:stamp,truncated:false},missingFields:['amount']}
const widgetResult={format:'teloa.business-view-widget-result/v2',widgetId:'amount-widget',definitionHash:'c'.repeat(64),computedAt:stamp,view:result,stale:false}
const projection={format:'teloa.business-configuration-page/v2',mode:'saved',scope,configurationHash:'a'.repeat(64),configurationVersion:1,page:{kind:'dashboard',definition,dashboard,widgets:[widget],results:[widgetResult],viewRefs:[{view,objectType:object}],timeRange:'all'}}

test('v2 视图严格读取币种及多选算子，版本分派保留真实正文且旧入口拒收',()=>{
 assert.deepEqual(api.readBusinessViewDefinitionVersioned(view),view)
 assert.deepEqual(api.readBusinessViewDefinitionV2(view),view)
 assert.throws(()=>api.readBusinessViewDefinition(view),invalid)
 const old={...view,format:'teloa.business-view/v1',dimension:{field:'state',limit:10},measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'}}
 const before=api.businessDefinitionCanonicalBody(api.readBusinessViewDefinition(old))
 assert.deepEqual(api.readBusinessViewDefinitionVersioned(old),api.readBusinessViewDefinition(old))
 assert.equal(api.businessDefinitionCanonicalBody(api.readBusinessViewDefinitionVersioned(old)),before)
 for(const v of [{...view,format:'teloa.business-view/v3'},{...view,extra:true},{...view,filters:[{field:'tags',op:'contains',values:['重点','续约']}]},{...view,filters:[{field:'tags',op:'overlaps',values:['重点','重点']}]},{...view,measures:[{id:'count',label:'数量',aggregation:'count',currency:'CNY'}]},{...view,measures:[{...view.measures[0],currency:'cny'}]}])assert.throws(()=>api.readBusinessViewDefinitionVersioned(v),invalid)
})

test('共享能力核对真实字段、聚合、币种及多选成员，v1 只能引用基础字段',()=>{
 const parsed=api.readBusinessObjectTypeDefinitionV2(object)
 api.assertBusinessViewV2References(api.readBusinessViewDefinitionV2(view),parsed)
 for(const change of [
  {dimension:{field:'amount',limit:10}},
  {dimension:{field:'missing',limit:10}},
  {measures:[{id:'amount',label:'总额',aggregation:'sum',field:'amount'}]},
  {measures:[{...view.measures[0],currency:'EUR'}]},
  {measures:[{id:'tags',label:'标签',aggregation:'sum',field:'tags'}]},
  {filters:[{field:'tags',op:'eq',values:['重点']}]},
  {filters:[{field:'tags',op:'contains',values:['未知']}]},
  {filters:[{field:'amount',op:'gte',values:['10']}]},
  {window:{field:'amount',relative:'last-7d'}},
  {kind:'trend',chart:'line',dimension:{field:'tags',bucket:'day',limit:10}},
 ])assert.throws(()=>api.assertBusinessViewV2References(api.readBusinessViewDefinitionV2({...view,...change,sort:{by:'dimension',direction:'asc'}}),parsed),invalid)
 api.assertBusinessViewV2References(api.readBusinessViewDefinitionV2({...view,filters:[{field:'amount',op:'gte',values:['{"currency":"CNY","decimal":"10"}']}]}),parsed)
 const old=api.readBusinessViewDefinition({...view,format:'teloa.business-view/v1',measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'}})
 assert.throws(()=>api.assertBusinessViewV2References(old,parsed),invalid)
 api.assertBusinessViewV2References({...old,dimension:{field:'state',limit:10}},parsed)
 assert.throws(()=>api.assertBusinessViewV2References({...old,dimension:{field:'state',limit:10},filters:[{field:'state',op:'gte',values:['新建']}]},parsed),invalid)
})

test('v2 金额结果保留22位整数和四位小数、真实零及空值，旧SQL结果读取器拒收',()=>{
 assert.deepEqual(api.readBusinessViewResultV2(result),result)
 assert.deepEqual(api.readBusinessViewWidgetResultV2(widgetResult),widgetResult)
 assert.throws(()=>api.readBusinessWidgetResult(widgetResult),bad)
 for(const decimal of ['10000000000000000000000','1.00001','-0','0.0','01','1e20','1.20']){
  const value={...result,rows:[{dimension:'重点',label:'重点',values:[{type:'money',currency:'CNY',decimal},null]}]}
  assert.throws(()=>api.readBusinessViewResultV2(value),bad)
 }
 assert.throws(()=>api.readBusinessRichFieldValue(api.readBusinessRichFieldDefinition(money),'{"currency":"CNY","decimal":"1000000000000000000"}'),invalid)
})

test('v2 严格回包拒绝币种/类型/舍入漂移及伪造覆盖与额外键',()=>{
 for(const value of [
  {...result,schema:'teloa.business-view-result/v1'}, {...result,extra:true},
  {...result,rows:[{dimension:'重点',label:'重点',values:[1,null]}]},
  {...result,rows:[{dimension:'重点',label:'重点',values:[{type:'money',currency:'USD',decimal:'1'},null]}]},
  {...result,rows:[{dimension:'重点',label:'重点',values:[{type:'money',currency:'CNY',decimal:'1',extra:true},null]}]},
  {...result,measures:[result.measures[0],{...result.measures[1],rounding:{scale:2,mode:'half-up'}}]},
  {...result,measures:[result.measures[0],{id:'mean',label:'平均金额',aggregation:'avg',fieldType:'money',currency:'CNY'}]},
  {...result,coverage:{objects:5001,latestReceivedAt:stamp,truncated:false}},
  {...result,dimensionValues:1}, {...result,computedAt:'yesterday'},
  {...result,dimensionMode:'records',kind:'board-card',chart:'number'},
 ])assert.throws(()=>api.readBusinessViewResultV2(value),bad)
 for(const value of [{...widgetResult,stale:true},{...widgetResult,format:'teloa.business-view-widget-result/v1'},{...widgetResult,computedAt:'2026-09-30T00:00:01.000Z'},{...widgetResult,extra:true}])assert.throws(()=>api.readBusinessViewWidgetResultV2(value),bad)
})

test('v2 配置与patch保留类型化视图正文及哈希，v1配置继续严格拒收',()=>{
 const read=api.readBusinessConfigurationCandidateV2(candidate)
 assert.deepEqual(read,candidate)
 const body=api.businessDefinitionCanonicalBody(read.definitions[1]!.definition)
 assert.match(body,/"format":"teloa\.business-view\/v2"/)
 assert.match(body,/"currency":"CNY"/)
 assert.match(body,/"op":"overlaps"/)
 const hash=createHash('sha256').update(body).digest('hex')
 assert.notEqual(hash,createHash('sha256').update(api.businessDefinitionCanonicalBody({...view,format:'teloa.business-view/v1'})).digest('hex'))
 assert.deepEqual(api.readBusinessConfigurationPatchVersioned({upsertDefinitions:[{kind:'view',definition:view}]},candidate.format),{upsertDefinitions:[{kind:'view',definition:view}]})
 assert.throws(()=>api.readBusinessConfigurationCandidate({...candidate,format:'teloa.business-configuration/v1'}),invalid)
 assert.throws(()=>api.readBusinessConfigurationCandidateV2({...candidate,definitions:candidate.definitions.map(item=>item.kind==='view'?{kind:'view',definition:{...view,measures:[{...view.measures[0],currency:'EUR'}]}}:item)}),invalid)
})

test('v2 看板投影仅接类型化view-ref结果并保留versioned refs，旧投影拒收',()=>{
 assert.deepEqual(api.readBusinessConfigurationPageProjectionVersioned(projection),projection)
 assert.throws(()=>api.readBusinessConfigurationPageProjection(projection),bad)
 for(const page of [
  {...projection.page,results:[{...widgetResult,widgetId:'other'}]},
  {...projection.page,results:[{...widgetResult,view:{...result,scope:'other'}}]},
  {...projection.page,viewRefs:[]},
  {...projection.page,viewRefs:[{view:{...view,id:'other'},objectType:object}]},
  {...projection.page,viewRefs:[{view:{...view,dimension:{field:'amount',limit:10}},objectType:object}]},
  {...projection.page,results:[{...widgetResult,view:{...result,measures:[{...result.measures[0],currency:'USD'},result.measures[1]],rows:[]}}]},
  {...projection.page,widgets:[{...widget,kind:'metric',viewRef:undefined,query:'select 1 as n',metric:{valueColumn:'n'}}]},
 ])assert.throws(()=>api.readBusinessConfigurationPageProjectionVersioned({...projection,page}),bad)
 const basicView={...view,format:'teloa.business-view/v1',dimension:{field:'state',limit:10},measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'}}
 const basicResult={...result,title:basicView.title,dimensionField:'state',dimensionMode:'records',measures:[{id:'count',label:'数量',aggregation:'count'}],rows:[{dimension:'新建',label:'新建',values:[3]}],dimensionValues:1,missingFields:[]}
 const basic={...projection,page:{...projection.page,viewRefs:[{view:basicView,objectType:object}],results:[{...widgetResult,view:basicResult}]}}
 assert.deepEqual(api.readBusinessConfigurationPageProjectionVersioned(basic),basic)
})

test('v2 计数不能缺值或超过覆盖记录数，分页结果不得超过固定视图边界',()=>{
 const countResult={...result,measures:[{id:'count',label:'数量',aggregation:'count'}],rows:[{dimension:'重点',label:'重点',values:[3]}],dimensionValues:1}
 assert.deepEqual(api.readBusinessViewResultV2(countResult),countResult)
 for(const values of [[null],[4],[-1],[1.5],[Infinity]])assert.throws(()=>api.readBusinessViewResultV2({...countResult,rows:[{dimension:'重点',label:'重点',values}]}),bad)
 const tooMany=Array.from({length:51},(_,index)=>({dimension:String(index),label:String(index),values:[1]}))
 assert.throws(()=>api.readBusinessViewResultV2({...countResult,rows:tooMany,dimensionValues:51}),bad)
 for(const measure of [{id:'n',label:'数量',aggregation:'count',fieldType:'number'},{id:'n',label:'数量',aggregation:'sum'},{id:'n',label:'数量',aggregation:'sum',fieldType:'multi-enum'},{id:'n',label:'数量',aggregation:'sum',fieldType:'number',currency:'CNY'}])assert.throws(()=>api.readBusinessViewResultV2({...countResult,measures:[measure]}),bad)
})

test('v2 页面校验真实字段缺失披露、成员口径和度量身份，允许相同视图被多组件引用',()=>{
 for(const view of [{...result,missingFields:['missing']},{...result,dimensionMode:'records'},{...result,viewVersion:'2.0.0'},{...result,title:'其他标题'},{...result,measures:[{...result.measures[0],id:'wrong'},result.measures[1]]}])assert.throws(()=>api.readBusinessConfigurationPageProjectionVersioned({...projection,page:{...projection.page,results:[{...widgetResult,view}]}}),bad)
 const second={...widget,id:'second'}
 const twice={...projection,page:{...projection.page,dashboard:{...dashboard,widgets:['amount-widget','second'],layout:[...dashboard.layout,{widget:'second',x:6,y:0,w:6,h:2}]},widgets:[widget,second],results:[widgetResult,{...widgetResult,widgetId:'second'}]}}
 assert.deepEqual(api.readBusinessConfigurationPageProjectionVersioned(twice),twice)
})
