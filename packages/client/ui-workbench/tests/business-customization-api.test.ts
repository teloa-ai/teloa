import assert from 'node:assert/strict'
import test from 'node:test'
import {businessDefinitionCanonicalBody} from '@teloa/contract'
import {createBusinessCustomizationApi,readBusinessCustomizationDirectory,readBusinessDefinitionPreview} from '../src/client/business-customization-api.ts'
import {block} from './business-ledger-fixtures.ts'

const hash='a'.repeat(64),now='2026-09-17T00:00:00.000Z',draftId='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-4222-8222-222222222222'
const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:'SOC',title:'工单',unit:'条',lead:'待处理的工单',sourceId:'source-http',fields:[{name:'title',label:'标题',type:'text',required:true,from:'标题'}]} as const
const draft=()=>({id:draftId,ownerId:'local:teloa-owner',requestId,scope:'SOC',kind:'object-type',localId:'ticket',semver:'1.0.0',definitionHash:hash,body:businessDefinitionCanonicalBody(definition),status:'draft',createdAt:now,updatedAt:now})
const version=()=>({version:1,semver:'1.0.0',definitionHash:hash,bodyHash:hash,createdAt:now,draftId})
const entry=()=>({scope:'SOC',kind:'object-type',localId:'ticket',current:version(),versions:[version()],template:{available:true,version:'1.0.0'}})
const directory=()=>({schema:'teloa.business-customization/v1',scope:'SOC',readAt:now,drafts:[draft()],entries:[entry()]})
const preview=()=>({schema:'teloa.business-definition-preview/v1',draft:draft(),receipt:hash,base:{origin:'none'},diff:[{path:'$.id',before:null,after:'"ticket"'}],diffTruncated:false,impact:{scope:'SOC',objectType:'ticket',views:[],actions:[],fields:[],widgets:[],dashboards:[]},trialUnavailable:'no-objects',computedAt:now})

test('会话定制目录逐条固定范围、草案正文和版本链，不接受额外字段',()=>{
 const result=readBusinessCustomizationDirectory(directory(),'SOC')
 assert.equal(result.drafts[0]!.localId,'ticket')
 assert.equal(result.entries[0]!.current!.version,1)
 const extra=directory() as Record<string,unknown>;extra.note='unexpected'
 assert.throws(()=>readBusinessCustomizationDirectory(extra,'SOC'))
 const foreign=directory();foreign.drafts[0]!.scope='AppSec'
 assert.throws(()=>readBusinessCustomizationDirectory(foreign,'SOC'))
 const forged=directory();forged.entries[0]!.current!.definitionHash='b'.repeat(64)
 assert.throws(()=>readBusinessCustomizationDirectory(forged,'SOC'),'current 必须逐字对应版本链，不只看整数版本')
})

test('目录、确认和回退各自只调用固定端点与白名单参数',async()=>{
 const calls:unknown[][]=[]
 const api=createBusinessCustomizationApi(async(method,payload)=>{calls.push([method,payload]);return method==='business-definitions/customization'?directory():entry()})
 await api.directory({scope:'SOC'})
 await api.apply({requestId:'33333333-3333-4333-8333-333333333333',draftId,expectedDefinitionHash:hash,expectedCurrentVersion:0,previewReceipt:hash})
 await api.revert({requestId:'44444444-4444-4444-8444-444444444444',scope:'SOC',kind:'object-type',localId:'ticket',target:{kind:'template'},expectedCurrentVersion:1})
 // 调用方即使多带了字段（如确认判据里的 ok、草案正文），也只递契约白名单五个键。
 await api.apply({requestId:'55555555-5555-4555-8555-555555555555',draftId,expectedDefinitionHash:hash,expectedCurrentVersion:0,previewReceipt:hash,ok:true,body:'{}'} as never)
 assert.deepEqual(Object.keys(calls.pop()![1] as object).sort(),['draftId','expectedCurrentVersion','expectedDefinitionHash','previewReceipt','requestId'])
 assert.deepEqual(calls,[
  ['business-definitions/customization',{scope:'SOC'}],
  ['business-definitions/apply',{requestId:'33333333-3333-4333-8333-333333333333',draftId,expectedDefinitionHash:hash,expectedCurrentVersion:0,previewReceipt:hash}],
  ['business-definitions/revert',{requestId:'44444444-4444-4444-8444-444444444444',scope:'SOC',kind:'object-type',localId:'ticket',target:{kind:'template'},expectedCurrentVersion:1}],
 ])
})

test('预览必须带回执，草案仍是 draft，且差异路径不能重复或等值',()=>{
 assert.equal(readBusinessDefinitionPreview(preview()).receipt,hash)
 const missingReceipt=preview() as Record<string,unknown>;delete missingReceipt.receipt
 assert.throws(()=>readBusinessDefinitionPreview(missingReceipt))
 const duplicated=preview();duplicated.diff.push({...duplicated.diff[0]!})
 assert.throws(()=>readBusinessDefinitionPreview(duplicated))
 const same=preview() as {diff:Array<{before:string|null;after:string}>};same.diff[0]!.before='"ticket"'
 assert.throws(()=>readBusinessDefinitionPreview(same))
})

test('试算块缺少本地/模板来源，或来源不在白名单时，预览在进入组件前失败',()=>{
 const value=preview() as Record<string,unknown>
 delete value.trialUnavailable
 value.trial=block({definition:{...definition}})
 assert.doesNotThrow(()=>readBusinessDefinitionPreview(value))
 const missing=structuredClone(value) as {trial:{objectType:{source:Record<string,unknown>}}};delete missing.trial.objectType.source.origin
 assert.throws(()=>readBusinessDefinitionPreview(missing))
 const malformed=structuredClone(value) as {trial:{views:Array<Record<string,unknown>>}};malformed.trial.views[0]!.origin='draft'
 assert.throws(()=>readBusinessDefinitionPreview(malformed))
})

test('看板三种新声明的预览：试算键按种类互斥，组件与看板的对象类型为空串，严格键集不变',()=>{
 const widget={format:'teloa.business-widget/v1',id:'alert-count',version:'1.0.0',domain:'SOC',title:'告警数',kind:'metric',query:'select count(*) as n from soc_alert',metric:{valueColumn:'n'}}
 const dashboard={format:'teloa.business-dashboard/v1',id:'soc-ops',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets:['alert-count'],layout:[{widget:'alert-count',x:0,y:0,w:6,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const draftOf=(kind:string,body:Record<string,unknown>)=>({...draft(),kind,localId:body.id,body:businessDefinitionCanonicalBody(body as never)})
 const impact={scope:'SOC',objectType:'',views:[],actions:[],fields:[],widgets:['alert-count'],dashboards:[]}
 const widgetTrial={widgetId:'alert-count',definitionHash:hash,computedAt:now,status:'ok',columns:[{name:'n',type:'number'}],rows:[[3]],rowCount:1,truncated:false,bytes:3,stale:false}
 const {trialUnavailable:_unavailable,...head}=preview()
 const widgetPreview={...head,draft:draftOf('widget',widget),impact,widgetTrial}
 assert.equal(readBusinessDefinitionPreview(widgetPreview).widgetTrial?.rows[0]?.[0],3)
 assert.throws(()=>readBusinessDefinitionPreview({...widgetPreview,impact:{...impact,objectType:'soc-alert'}}))
 assert.throws(()=>readBusinessDefinitionPreview({...widgetPreview,trialUnavailable:'no-objects'}))
 assert.throws(()=>readBusinessDefinitionPreview({...widgetPreview,widgetTrial:{...widgetTrial,widgetId:'other'}}))
 const {widgetTrial:_trial,...noTrial}=widgetPreview
 assert.throws(()=>readBusinessDefinitionPreview({...noTrial,trialUnavailable:'no-objects'}))
 const dashboardPreview={...head,draft:draftOf('dashboard',dashboard),impact:{...impact,widgets:[],dashboards:['soc-ops']},dashboardTrial:{layout:dashboard.layout}}
 assert.deepEqual(readBusinessDefinitionPreview(dashboardPreview).dashboardTrial,{layout:dashboard.layout})
 assert.throws(()=>readBusinessDefinitionPreview({...dashboardPreview,dashboardTrial:{layout:[{...dashboard.layout[0],w:12}]}}))
 assert.throws(()=>readBusinessDefinitionPreview({...dashboardPreview,dashboardTrial:{layout:dashboard.layout,extra:1}}))
 const mapping={format:'teloa.business-source-mapping/v1',id:'soc-alerts',version:'1.0.0',domain:'SOC',title:'告警同步',objectType:'soc-alert',source:{kind:'business-data-port',sourceId:'security-alerts'},mapping:[{path:'$.id',field:'alert-id'}],primaryKey:['alert-id'],deletionSemantics:'compare',schedule:{kind:'every',seconds:600},acknowledgeShortInterval:false}
 const mappingPreview={...head,draft:draftOf('source-mapping',mapping),impact:{...impact,objectType:'soc-alert',widgets:[]},mappingTrial:{fetched:1,objects:[{objectId:'a1',fields:[{field:'alert-id',value:'a1'}]}]}}
 assert.equal(readBusinessDefinitionPreview(mappingPreview).mappingTrial?.fetched,1)
 const {mappingTrial:_mapping,...mappingHead}=mappingPreview
 assert.equal(readBusinessDefinitionPreview({...mappingHead,trialUnavailable:'source-disconnected'}).trialUnavailable,'source-disconnected')
 assert.throws(()=>readBusinessDefinitionPreview({...mappingPreview,impact:{...mappingPreview.impact,objectType:''}}))
 assert.throws(()=>readBusinessDefinitionPreview({...mappingPreview,mappingTrial:{fetched:0,objects:[{objectId:'a1',fields:[]}]}}))
 // 受管 MCP 来源的映射：pull-required 只认这一种；试拉请求只多带 pull:true。
 const mcpMapping={...mapping,source:{kind:'mcp-tool',serverName:'soc',tool:'list_alerts',arguments:{status:'open'},itemsPath:'$.items'}}
 const awaiting={...mappingHead,draft:draftOf('source-mapping',mcpMapping),trialUnavailable:'pull-required'}
 assert.equal(readBusinessDefinitionPreview(awaiting).trialUnavailable,'pull-required')
 assert.throws(()=>readBusinessDefinitionPreview({...mappingHead,trialUnavailable:'pull-required'}))
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),trialUnavailable:'pull-required'}))
 // pull-failed 只在 source-mapping 草案上放行（来源不限）；widget / object-type 草案上即 invalid-host-response。
 assert.equal(readBusinessDefinitionPreview({...mappingHead,trialUnavailable:'pull-failed'}).trialUnavailable,'pull-failed')
 assert.equal(readBusinessDefinitionPreview({...awaiting,trialUnavailable:'pull-failed'}).trialUnavailable,'pull-failed')
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),trialUnavailable:'pull-failed'}),{code:'teloa/invalid-host-response'})
 const {widgetTrial:_widgetTrial,...widgetHead}=widgetPreview
 assert.throws(()=>readBusinessDefinitionPreview({...widgetHead,trialUnavailable:'pull-failed'}),{code:'teloa/invalid-host-response'})
 // config-unreadable 同样只在 source-mapping 草案上放行。
 assert.equal(readBusinessDefinitionPreview({...mappingHead,trialUnavailable:'config-unreadable'}).trialUnavailable,'config-unreadable')
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),trialUnavailable:'config-unreadable'}),{code:'teloa/invalid-host-response'})
 assert.throws(()=>readBusinessDefinitionPreview({...widgetHead,trialUnavailable:'config-unreadable'}),{code:'teloa/invalid-host-response'})
 // 对象类型声明仍须带本类型标识，空串不放行。
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),impact:{...preview().impact,objectType:''}}))
})

test('预览请求：缺省只带 draftId，试拉时只多带 pull:true',async()=>{
 const calls:unknown[]=[]
 const api=createBusinessCustomizationApi(async(_method,payload)=>{calls.push(payload);return preview()})
 await api.preview({draftId})
 await api.preview({draftId,pull:true})
 await api.preview({draftId,pull:false,extra:1} as never)
 assert.deepEqual(calls,[{draftId},{draftId,pull:true},{draftId}])
})
