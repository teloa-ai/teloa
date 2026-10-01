import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'
test('页面回包严格约束模式和候选身份；不允许额外正文/owner',()=>{
 assert.equal(typeof api.readBusinessConfigurationPageProjection,'function')
 for(const input of [{},{mode:'preview',scope:'sales',configurationHash:'a'.repeat(64),page:{}},{mode:'saved',scope:'sales',configurationHash:'a'.repeat(64),configurationVersion:1,owner:'other',page:{}}])assert.throws(()=>api.readBusinessConfigurationPageProjection(input),{code:'teloa/invalid-host-response'})
})
test('配置端点严格输入禁止owner、替代候选和公开revise',()=>{
 assert.equal(typeof api.readBusinessBuilderRequest,'function')
 assert.throws(()=>api.readBusinessBuilderRequest('business-configuration/revise',{}),{code:'teloa/not-found'})
 assert.throws(()=>api.readBusinessBuilderRequest('business-configuration/current',{scope:'sales',owner:'other'}),{code:'teloa/invalid-input'})
 assert.throws(()=>api.readBusinessBuilderRequest('business-configuration/page',{scope:'sales',pageId:'home',candidate:{}}),{code:'teloa/invalid-input'})
})
test('真实看板投影保留view-ref表示元数据，拒绝跨范围、错组件和伪结果',()=>{
 const objectType={format:'teloa.business-object-type/v1',id:'customer',version:'1.0.0',domain:'sales',title:'客户',unit:'位',lead:'客户',sourceId:'records',fields:[{name:'stage',label:'阶段',type:'text',from:'阶段',required:true}]}
 const view={format:'teloa.business-view/v1',id:'stages',version:'1.0.0',domain:'sales',title:'阶段',kind:'distribution',chart:'pie',objectType:'customer',dimension:{field:'stage',limit:10},measures:[{id:'total',label:'客户数',aggregation:'count'}],filters:[],sort:{by:'measure',measureId:'total',direction:'desc'},limit:10}
 const widget={format:'teloa.business-widget/v1',id:'widget',version:'1.0.0',domain:'sales',title:'统计',kind:'view-ref',viewRef:'stages'}
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:'sales',title:'客户统计',widgets:['widget'],layout:[{widget:'widget',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const result={widgetId:'widget',definitionHash:'a'.repeat(64),computedAt:'2026-09-29T00:00:00.000Z',status:'ok',columns:[{name:'dimension',type:'text'},{name:'label',type:'text'},{name:'total',type:'number'}],rows:[],rowCount:0,truncated:false,bytes:0,stale:false}
 const page={kind:'dashboard',definition:{id:'stats',title:'客户统计',kind:'dashboard',dashboardId:'overview'},dashboard,widgets:[widget],results:[result],viewRefs:[{view,objectType}],timeRange:'all'}
 const projection={mode:'preview',scope:'sales',configurationHash:'b'.repeat(64),draftId:'11111111-1111-4111-8111-111111111111',revision:2,page}
 assert.deepEqual(api.readBusinessConfigurationPageProjection(projection),projection)
 for(const changed of [{...page,viewRefs:[]},{...page,viewRefs:[{view,objectType:{...objectType,domain:'other'}}]},{...page,results:[{...result,widgetId:'other'}]},{...page,results:[{...result,stale:true}]},{...page,ledger:{}}])assert.throws(()=>api.readBusinessConfigurationPageProjection({...projection,page:changed}),{code:'teloa/invalid-host-response'})
})
test('配置回包严格区分draft/current/receipt身份，缺失和额外字段不算成功',()=>{
 const receipt={scope:'sales',version:1,configurationHash:'a'.repeat(64),requestId:'11111111-1111-4111-8111-111111111111'}
 assert.deepEqual(api.readBusinessConfigurationApplyResult(receipt),receipt)
 for(const v of [{...receipt,version:0},{...receipt,extra:true},null,undefined])assert.throws(()=>api.readBusinessConfigurationApplyResult(v),{code:'teloa/invalid-host-response'})
 assert.throws(()=>api.readBusinessConfigurationPreviewResponse({draftId:receipt.requestId,revision:1,candidateHash:receipt.configurationHash,baseVersion:0,dependencyHash:receipt.configurationHash,receipt:receipt.configurationHash,changes:{rows:[],truncated:false},issues:['silenced']}),{code:'teloa/invalid-host-response'})
})
