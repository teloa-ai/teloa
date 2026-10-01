import test from 'node:test'
import assert from 'node:assert/strict'
import * as api from '../src/index.ts'

const invalid=(error:unknown)=>(error as {code?:string}).code==='teloa/invalid-input'
const read=(value:unknown)=>{
 assert.equal(typeof api.readBusinessDashboardResource,'function','必须提供完整业务配置资源读取器')
 return api.readBusinessDashboardResource(value)
}
export const dashboardResourceFixture=()=>({
 format:'teloa.business-dashboard-resource/v1',id:'soc-overview',version:'1.0.0',
 configuration:{
  format:'teloa.business-configuration/v2',scope:'SOC',title:'安全运营',sources:[{sourceId:'records',kind:'local-records'}],
  definitions:[
   {kind:'object-type',definition:{format:'teloa.business-object-type/v2',id:'alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'跟进告警',sourceId:'records',fields:[{name:'state',label:'状态',type:'enum',required:true,from:'状态',values:['待核对','已处理']}]}},
   {kind:'view',definition:{format:'teloa.business-view/v1',id:'states',version:'1.0.0',domain:'SOC',title:'告警状态',kind:'distribution',chart:'bar',objectType:'alert',dimension:{field:'state',limit:10},measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:10}},
   {kind:'widget',definition:{format:'teloa.business-widget/v1',id:'state-widget',version:'1.0.0',domain:'SOC',title:'告警状态',kind:'view-ref',viewRef:'states'}},
   {kind:'dashboard',definition:{format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:'SOC',title:'告警总览',widgets:['state-widget'],layout:[{widget:'state-widget',x:0,y:0,w:12,h:3}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}},
  ],
  pages:[{id:'alerts',title:'告警记录',kind:'records',objectType:'alert',fields:['state'],allowCreate:true,allowEdit:true,allowArchive:false},{id:'home',title:'告警总览',kind:'dashboard',dashboardId:'overview'}],homePageId:'home',
 },
})

test('业务看板资源保留完整 v2 配置与稳定资源身份，解析结果不共用输入对象',()=>{
 const value=dashboardResourceFixture(),parsed=read(value)
 assert.deepEqual(parsed,value)
 assert.notEqual(parsed.configuration,value.configuration)
 assert.deepEqual(parsed.configuration.definitions.map(row=>row.kind),['object-type','view','widget','dashboard'])
 assert.equal(api.industryUpdateCanonical(read(parsed)),api.industryUpdateCanonical(parsed))
})

test('业务看板资源拒绝未知格式、浮动版本、隐藏运行数据及多余字段',()=>{
 const fixture=dashboardResourceFixture()
 for(const value of [null,{}, {...fixture,format:'teloa.business-dashboard-resource/v2'},{...fixture,id:'../secret'},{...fixture,version:'latest'},{...fixture,records:[{customer:'private'}]},{...fixture,ownerId:'private'},{...fixture,configuration:{...fixture.configuration,format:'teloa.business-configuration/v1'}},{...fixture,configuration:{...fixture.configuration,secret:'private'}},{...fixture,configuration:{...fixture.configuration,sources:[{sourceId:'records',kind:'local-records',path:'/Users/private'}]}}])assert.throws(()=>read(value),invalid)
})

test('业务看板资源必须有可预览的看板页，所有对象与页面引用闭合',()=>{
 const fixture=dashboardResourceFixture()
 for(const configuration of [
  {...fixture.configuration,pages:[fixture.configuration.pages[0]],homePageId:'alerts'},
  {...fixture.configuration,definitions:fixture.configuration.definitions.filter(row=>row.kind!=='view')},
  {...fixture.configuration,scope:'OTHER'},
  {...fixture.configuration,pages:[fixture.configuration.pages[0],{...fixture.configuration.pages[1],dashboardId:'missing'}]},
 ])assert.throws(()=>read({...fixture,configuration}),invalid)
})

test('业务看板资源不携带已有同步绑定及工具参数；必须由接收方另行准备',()=>{
 const fixture=dashboardResourceFixture()
 const mapping={kind:'source-mapping',definition:{format:'teloa.business-source-mapping/v1',id:'alert-sync',version:'1.0.0',domain:'SOC',title:'同步',objectType:'alert',source:{kind:'mcp-tool',serverName:'private',tool:'alerts',arguments:{token:'private'},itemsPath:'$.items'},mapping:[{path:'$.state',field:'state'}],primaryKey:['state'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false}}
 assert.throws(()=>read({...fixture,configuration:{...fixture.configuration,definitions:[...fixture.configuration.definitions,mapping]}}),(error:unknown)=>invalid(error)&&/同步|绑定/.test((error as Error).message))
})

test('完整配置资源的方案格式闸只放行 v4，v2/v3 行为不隐式改变',()=>{
 assert.equal(api.isIndustryPackageFormat('teloa.business-package/v4'),true)
 assert.equal(typeof api.assertIndustryConfigurationResourceFormat,'function')
 for(const format of ['teloa.business-package/v1','teloa.business-package/v2','teloa.business-package/v3'])assert.throws(()=>api.assertIndustryConfigurationResourceFormat(format,'business-configuration'),invalid)
 assert.doesNotThrow(()=>api.assertIndustryConfigurationResourceFormat('teloa.business-package/v4','business-configuration'))
 assert.doesNotThrow(()=>api.assertIndustryConfigurationResourceFormat('teloa.business-package/v2','skill'))
})

test('配置资源不继承未随包交付的业务默认动作身份',()=>{
 const fixture=dashboardResourceFixture()
 const definitions=fixture.configuration.definitions.map(row=>row.kind==='object-type'?{...row,definition:{...row.definition,defaultAction:'host-private-task'}}:row)
 assert.throws(()=>read({...fixture,configuration:{...fixture.configuration,definitions}}),(error:unknown)=>invalid(error)&&/默认动作/.test((error as Error).message))
})
