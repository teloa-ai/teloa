// 完整协议夹具仅用于独立组件验收，不代表真实宿主数据。
export const typedStamp='2026-09-30T00:00:00.000Z'
export const typedHash='a'.repeat(64)
const localized=(original,en)=>({original,defaultLocale:'zh-CN',locales:{en}})
export function typedViewFixture(chart='table'){
 const kind=chart==='number'?'board-card':chart==='line'?'trend':'distribution'
 const objectType={format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:'sales',title:'客户',unit:'位',lead:'客户统计',sourceId:'records',fields:[
  {format:'teloa.business-rich-field/v2',name:'amount',label:'合同金额',from:'原金额',type:'money',required:false,currencies:['CNY','USD']},
  {format:'teloa.business-rich-field/v2',name:'tags',label:'业务方向',from:'原方向',type:'multi-enum',required:false,values:['云安全','合规','<img src=x onerror=alert(1)>']},
  {name:'at',label:'日期',from:'原日期',type:'datetime',required:false},
 ]}
 const measures=chart==='pie'||chart==='number'?[{id:'cny',label:'人民币总额',localized:{label:localized('人民币总额','CNY total')},aggregation:'sum',field:'amount',currency:'CNY'}]:[
  {id:'cny',label:'人民币总额',localized:{label:localized('人民币总额','CNY total')},aggregation:'sum',field:'amount',currency:'CNY'},
  {id:'usd',label:'美元均值',localized:{label:localized('美元均值','USD mean')},aggregation:'avg',field:'amount',currency:'USD'},
  {id:'count',label:'数量',localized:{label:localized('数量','Count')},aggregation:'count'},
 ]
 const view={format:'teloa.business-view/v2',id:'typed-'+chart,version:'1.0.0',domain:'sales',title:'客户统计',localized:{title:localized('客户统计','Customer statistics')},kind,chart,objectType:'customer',measures,filters:[],limit:chart==='number'?1:20,...(chart==='number'?{}:{dimension:{field:chart==='line'?'at':'tags',limit:20,...(chart==='line'?{bucket:'day'}:{})},sort:{by:'dimension',direction:'asc'}})}
 const widget={format:'teloa.business-widget/v1',id:'widget-'+chart,version:'1.0.0',domain:'sales',title:'客户统计',localized:{title:localized('客户统计','Customer statistics')},kind:'view-ref',viewRef:view.id}
 const money=(currency,decimal)=>({type:'money',currency,decimal})
 const rows=chart==='number'?[{dimension:'all',label:'全部',values:[money('CNY','9007199254740993.0001')]}]:[
  {dimension:chart==='line'?'2026-09-29T00:00:00.000Z':'云安全',label:chart==='line'?'2026年9月29日':'云安全',values:[money('CNY','9007199254740993.0001'),money('USD','-0.0001'),2]},
  {dimension:chart==='line'?'2026-09-30T00:00:00.000Z':'合规',label:chart==='line'?'2026年9月30日':'合规',values:[money('CNY','0'),null,1]},
  {dimension:chart==='line'?'2026-10-01T00:00:00.000Z':'<img src=x onerror=alert(1)>',label:chart==='line'?'2026年10月1日':'<img src=x onerror=alert(1)>',values:[money('CNY','-9999999999999999999999.9999'),money('USD','2.125'),1]},
 ].map(row=>({...row,values:chart==='pie'?row.values.slice(0,1):row.values}))
 const result={format:'teloa.business-view-widget-result/v2',widgetId:widget.id,definitionHash:typedHash,computedAt:typedStamp,stale:false,view:{schema:'teloa.business-view-result/v2',viewId:view.id,viewVersion:'1.0.0',definitionHash:typedHash,origin:'local',kind,chart,title:view.title,localized:view.localized,scope:'sales',objectType:'customer',computedAt:typedStamp,dimensionMode:chart==='line'||chart==='number'?'records':'membership',...(chart==='number'?{}:{dimensionField:chart==='line'?'at':'tags'}),measures:measures.map(measure=>{const {field,...rest}=measure;return {...rest,...(field?{fieldType:'money'}:{}),...(measure.aggregation==='avg'?{rounding:{scale:4,mode:'half-even'}}:{})}}),rows,dimensionValues:chart==='number'?1:8,coverage:{objects:3,latestReceivedAt:typedStamp,truncated:true},missingFields:['amount']}}
 return {widget,result,ref:{view,objectType}}
}
export function typedConfigurationFixture(){
 const fixtures=['number','table','bar','pie','line'].map(typedViewFixture)
 return {format:'teloa.business-configuration-page/v2',scope:'sales',configurationHash:typedHash,mode:'preview',draftId:'00000000-0000-4000-8000-000000000001',revision:1,page:{kind:'dashboard',definition:{id:'overview',kind:'dashboard',title:'客户统计',dashboardId:'overview'},dashboard:{format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:'sales',title:'客户统计',localized:{title:localized('客户统计','Customer statistics')},widgets:fixtures.map(f=>f.widget.id),layout:fixtures.map((f,index)=>({widget:f.widget.id,x:index%2*6,y:Math.floor(index/2)*2,w:6,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false},widgets:fixtures.map(f=>f.widget),results:fixtures.map(f=>f.result),viewRefs:fixtures.map(f=>f.ref),timeRange:'all'}}
}
