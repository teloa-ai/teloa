import test from 'node:test'
import assert from 'node:assert/strict'
import type {BusinessConfigurationViewRef,BusinessLedger,BusinessWidgetDefinition,BusinessWidgetResult} from '@teloa/contract'
import {viewRefPresentation} from '../src/client/business-widget-presentation.ts'
import {localizedBusinessView} from '../src/client/business-definition-localization.ts'

const localized=(original:string,en:string)=>({original,defaultLocale:'zh-CN',locales:{en}})
const widget:BusinessWidgetDefinition={format:'teloa.business-widget/v1',id:'card',version:'1.0.0',domain:'sales',title:'完成情况',kind:'view-ref',viewRef:'completion'}
const result:BusinessWidgetResult={widgetId:'card',definitionHash:'a'.repeat(64),computedAt:'2026-09-29T00:00:00.000Z',status:'ok',columns:[{name:'dimension',type:'text'},{name:'label',type:'text'},{name:'count',type:'number'}],rows:[['true','true',3],['false','false',2]],rowCount:2,truncated:false,bytes:1,stale:false}
const metadata:BusinessConfigurationViewRef={
 objectType:{format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:'sales',title:'订单',unit:'单',lead:'订单进展',sourceId:'local',fields:[{name:'done',label:'完成',from:'完成',type:'boolean',required:true},{name:'elapsed',label:'耗时',from:'耗时',type:'duration',required:false}]},
 view:{format:'teloa.business-view/v1',id:'completion',version:'2.0.0',domain:'sales',title:'完成情况',kind:'distribution',chart:'pie',objectType:'order',dimension:{field:'done',limit:20},sort:{by:'dimension',direction:'asc'},measures:[{id:'count',label:'数量',localized:{label:localized('数量','Count')},aggregation:'count'}],filters:[],limit:20},
}
const ledger={blocks:[{objectType:{definition:metadata.objectType},views:[{viewId:'completion',kind:'distribution',chart:'table',measures:[{id:'count',label:'旧数量'}]}]}]} as unknown as BusinessLedger

test('配置元数据按当前 viewRef 选取，优先于旧台账；真实画法、对象类型、维度和度量本地化保留',()=>{
 const other={...metadata,view:{...metadata.view,id:'other',chart:'bar' as const}}
 const selected=viewRefPresentation(widget,result,'完成情况',{ledger,viewRefs:[other,metadata]})!
 assert.equal(selected.view.chart,'pie')
 assert.equal(selected.view.viewId,'completion')
 assert.equal(selected.view.viewVersion,'2.0.0')
 assert.equal(selected.view.objectType,'order')
 assert.equal(selected.view.dimensionField,'done')
 assert.equal(selected.objectType,metadata.objectType)
 const english=localizedBusinessView(selected.view,selected.objectType!,'en',{yes:'Yes',no:'No'})
 assert.deepEqual(english.rows.map(row=>row.label),['Yes','No'])
 assert.deepEqual(english.measures.map(measure=>measure.label),['Count'])
 const chinese=localizedBusinessView(selected.view,selected.objectType!,'zh-CN',{yes:'是',no:'否'})
 assert.deepEqual(chinese.rows.map(row=>row.label),['是','否'])
})

test('配置声明五种绘图与耗时字段类型不退化成默认表格',()=>{
 for(const [kind,chart] of [['board-card','number'],['distribution','pie'],['trend','line'],['distribution','bar'],['distribution','table']] as const){
  const ref={...metadata,view:{...metadata.view,kind,chart,measures:[{id:'count',label:'耗时',aggregation:'max' as const,field:'elapsed'}]}}
  const projected=viewRefPresentation(widget,result,'完成情况',{viewRefs:[ref]})!.view
  assert.equal(projected.kind,kind);assert.equal(projected.chart,chart)
  assert.equal(projected.measures[0]!.fieldType,'duration')
 }
})

test('显式配置元数据缺失或范围/对象类型不匹配时拒绝，不借旧台账或默认表格掩盖',()=>{
 for(const viewRefs of [[],[{...metadata,view:{...metadata.view,id:'other'}}],[{...metadata,view:{...metadata.view,domain:'other'}}],[{...metadata,objectType:{...metadata.objectType,domain:'other'}}],[{...metadata,view:{...metadata.view,objectType:'other'}}]]){
  assert.equal(viewRefPresentation(widget,result,'完成情况',{ledger,viewRefs}),undefined)
 }
})

test('既有台账保持画法和标签；未提供配置元数据的旧调用保持原表格兼容',()=>{
 assert.equal(viewRefPresentation(widget,result,'完成情况',{ledger})!.view.measures[0]!.label,'旧数量')
 assert.equal(viewRefPresentation(widget,result,'完成情况',{})!.view.chart,'table')
})

test('结果度量与配置元数据不一致时不能伪造度量标签或省略声明',()=>{
 const unknown={...result,columns:[...result.columns.slice(0,2),{name:'unknown',type:'number' as const}]}
 assert.equal(viewRefPresentation(widget,unknown,'完成情况',{viewRefs:[metadata]}),undefined)
 const incomplete={...result,columns:result.columns.slice(0,2),rows:result.rows.map(row=>row.slice(0,2))}
 assert.equal(viewRefPresentation(widget,incomplete,'完成情况',{viewRefs:[metadata]}),undefined)
})

test('对象类型的枚举本地化只作用于真正的维度字段',()=>{
 const objectType={...metadata.objectType,fields:[{name:'done',label:'状态',from:'状态',type:'enum' as const,required:false,values:['true','false'],localized:{values:[localized('true','Complete'),localized('false','Pending')]}}]}
 const selected=viewRefPresentation(widget,result,'完成情况',{viewRefs:[{...metadata,objectType}]})!
 assert.deepEqual(localizedBusinessView(selected.view,selected.objectType!,'en').rows.map(row=>row.label),['Complete','Pending'])
})
