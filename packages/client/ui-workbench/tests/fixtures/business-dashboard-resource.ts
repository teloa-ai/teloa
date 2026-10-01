import type {BusinessDashboardResourceDefinition} from '@teloa/contract'
export const dashboardResourceFixture=():BusinessDashboardResourceDefinition=>({
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
