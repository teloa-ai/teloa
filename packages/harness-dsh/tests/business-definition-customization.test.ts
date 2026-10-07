import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {businessDefinitionCanonicalBody,readBusinessObjectTypeDefinition,type BusinessDefinitionDraft,type BusinessDefinitionPreview,type BusinessCustomizationEntry,type BusinessCustomizationDirectory,type BusinessLedgerBlock} from '@teloa/contract'
import {businessDefinitionEndpoints,createBusinessDefinitionHandler,readBusinessCustomizationDirectory,readBusinessCustomizationEntry,readBusinessDefinitionCatalog,readBusinessDefinitionDraft,readBusinessDefinitionPreview} from '../src/business-definitions.ts'

const owner='local:teloa-owner',scope='AppSec',id='11111111-1111-4111-8111-111111111111',requestId='22222222-2222-5222-a222-222222222222',hash='a'.repeat(64),now='2026-09-17T00:00:00.000Z'
const definition={format:'teloa.business-object-type/v1',id:'ticket',version:'1.0.0',domain:scope,title:'工单',unit:'条',lead:'待处理的工单',sourceId:'source-http',fields:[{name:'title',label:'标题',type:'text',required:true,from:'标题'}]}
const draft=():BusinessDefinitionDraft=>({id,ownerId:owner,requestId,scope,kind:'object-type',localId:'ticket',semver:'1.0.0',definitionHash:hash,body:businessDefinitionCanonicalBody(definition),status:'draft',createdAt:now,updatedAt:now})
const version=()=>({version:1,semver:'1.0.0',definitionHash:hash,bodyHash:hash,createdAt:now,draftId:id})
const entry=():BusinessCustomizationEntry=>({scope,kind:'object-type',localId:'ticket',current:version(),versions:[version()],template:{available:true,version:'1.0.0'}})
const directory=():BusinessCustomizationDirectory=>({schema:'teloa.business-customization/v1',scope,readAt:now,drafts:[draft()],entries:[entry()]})
const preview=():BusinessDefinitionPreview=>({schema:'teloa.business-definition-preview/v1',draft:draft(),receipt:hash,base:{origin:'none'},diff:[{path:'title',before:null,after:'"工单"'}],diffTruncated:false,impact:{scope,objectType:'ticket',views:[],actions:[],fields:['title'],widgets:[],dashboards:[]},trialUnavailable:'no-objects',computedAt:now})
const invalid={code:'teloa/invalid-host-response'}
const applyInput={requestId,draftId:id,expectedDefinitionHash:hash,expectedCurrentVersion:0,previewReceipt:hash}
function setup(){
 const calls:Array<{operation:string;actor:unknown;input:unknown}>=[]
 const invoke=<T>(operation:string,result:()=>T)=>async(actor:unknown,input:unknown)=>{calls.push({operation,actor,input});return result()}
 const handler=createBusinessDefinitionHandler(owner,async()=>[scope,'general'],async()=>({read:invoke('ledger',()=>({schema:'teloa.business-ledger/v1' as const,scope,computedAt:now,blocks:[],actions:[]}))}),async()=>({local:{directory:invoke('directory',directory),apply:invoke('apply',entry),revert:invoke('revert',entry)},preview:{preview:invoke('preview',preview)}}))
 return {calls,handler}
}

test('四个定制端点完整装入 RPC，草案写口只在模型工具私有回调',()=>{
 assert.deepEqual(businessDefinitionEndpoints,['business-definitions/ledger','business-definitions/customization','business-definitions/preview','business-definitions/apply','business-definitions/revert'])
 const source=readFileSync(new URL('../src/index.ts',import.meta.url),'utf8')
 assert.match(source,/const endpointSet=new Set\([^\n]*\.\.\.businessDefinitionEndpoints/)
 assert.match(source,/businessDefinitionEndpoints as readonly string\[\]\)\.includes\(endpoint\)\?await businessDefinitionHandler\(endpoint,payload,signal\)/)
 assert.match(source,/new BusinessDefinitionSourceReader\(market,loads,\{activeSourceIds\},local,store\)/)
 assert.match(source,/new BusinessDefinitionPreviewService\(pool,identity,local,definitions,ledger,\{widgets,resolveSource:businessSyncSources\}\)/)
 assert.match(source,/createBusinessDefinitionHandler\(owner,businessScopeIds,[^\n]*businessDefinitionServices\)/)
 const skillRegistration=source.indexOf('registerSkillInstallTools(toolRegistrationContext,')
 assert.ok(skillRegistration>0&&source.indexOf('registerBusinessDefinitionTools(toolRegistrationContext,')>skillRegistration)
 const selfAuthorized=source.match(/registerTaskToolGuard\(ctx,readTaskToolPolicy,[\s\S]*?\[([^\]]*)\],async/)?.[1]??''
 assert.ok(selfAuthorized.length>0)
 for(const name of ['businessDefinitionToolNames','teloa_business_definitions_directory','teloa_business_definitions_draft'])assert.equal(selfAuthorized.includes(name),false)
})

test('四个端点只用本人和已登记范围；UI 输入不能覆盖身份、扩大范围或执行草案私有写口',async()=>{
 const e=setup()
 for(const [endpoint,payload] of [['customization',{scope}],['preview',{draftId:id}],['apply',applyInput],['revert',{requestId,scope,kind:'object-type',localId:'ticket',target:{kind:'template'},expectedCurrentVersion:1}]] as const)await e.handler('business-definitions/'+endpoint,payload)
 assert.deepEqual(e.calls.map(call=>call.operation),['directory','preview','apply','revert'])
 for(const call of e.calls)assert.deepEqual(call.actor,{ownerId:owner,scopeIds:[scope]})
 for(const payload of [{...applyInput,ownerId:'other'},{...applyInput,scope},{...applyInput,status:'applied'}])await assert.rejects(e.handler('business-definitions/apply',payload),{code:'teloa/invalid-input'})
 for(const key of Object.keys(applyInput)){
  const payload:Record<string,unknown>={...applyInput};delete payload[key]
  await assert.rejects(e.handler('business-definitions/apply',payload),{code:'teloa/invalid-input'})
 }
 for(const deniedScope of ['SOC','general'])await assert.rejects(e.handler('business-definitions/customization',{scope:deniedScope}),{code:'teloa/forbidden'})
 await assert.rejects(e.handler('business-definitions/draft',{scope}),{code:'teloa/not-found'})
 assert.equal(e.calls.length,4)
})

test('草案正文复用契约：未知字段、非法 JSON、超字节上限、身份错位和状态不一致均拒收',()=>{
 assert.deepEqual(readBusinessDefinitionDraft(draft(),scope),draft())
 for(const change of [
  {body:'{'},{body:JSON.stringify({...definition,sql:'select secret'})},{body:JSON.stringify({...definition,domain:'SOC'})},{body:JSON.stringify({...definition,id:'other'})},
  {body:JSON.stringify({...definition,version:'2.0.0'})},{body:'中'.repeat(50000)},{status:'applied'},{appliedVersion:1},{kind:'script'},{semver:'bad'},
  {createdAt:'2026-09-18T00:00:00.000Z'},{ownerId:'other\nowner'},{extra:'secret'},
 ])assert.throws(()=>readBusinessDefinitionDraft({...draft(),...change},scope),invalid)
})

test('版本链必须升序、当前指针属于同一份历史记录、模板可用性与版本位相符',()=>{
 assert.deepEqual(readBusinessCustomizationEntry(entry(),scope),entry())
 for(const change of [{versions:[]},{versions:[version(),version()]},{current:{...version(),definitionHash:'b'.repeat(64)}},{current:{...version(),version:2}},{template:{available:false,version:'1.0.0'}},{template:{available:true}},{scope:'SOC'},{versions:Array.from({length:51},(_,i)=>({...version(),version:i+1}))}])assert.throws(()=>readBusinessCustomizationEntry({...entry(),...change},scope),invalid)
 const missing=entry() as Partial<BusinessCustomizationEntry>;delete missing.template
 assert.throws(()=>readBusinessCustomizationEntry(missing,scope),invalid)
})

test('目录拒绝重复草案和重复声明，以及缺键和跨范围草案',()=>{
 assert.deepEqual(readBusinessCustomizationDirectory(directory(),scope),directory())
 for(const change of [{drafts:[draft(),draft()]},{entries:[entry(),entry()]},{drafts:[{...draft(),scope:'SOC'}]},{entries:undefined},{readAt:undefined}])assert.throws(()=>readBusinessCustomizationDirectory({...directory(),...change},scope),invalid)
})

test('预览严格核对差异、影响范围及不可用状态，拒绝快照字段混入影响范围',()=>{
 assert.deepEqual(readBusinessDefinitionPreview(preview()),preview())
 // 字段标识至多 63 字符（与契约一致，PG 标识符截断）。
 assert.equal(readBusinessDefinitionPreview({...preview(),impact:{...preview().impact,fields:['x'.repeat(63)]}}).impact.fields[0]!.length,63)
 for(const change of [
  {base:{origin:'local'}},{base:{origin:'none',definitionHash:hash}},{diffTruncated:true},{diff:[{path:'title',before:'same',after:'same'}]},
  {diff:[{path:'title\n命令',before:null,after:'x'}]},{impact:{...preview().impact,scope:'SOC'}},{impact:{...preview().impact,objectType:'other'}},
  {impact:{...preview().impact,fields:['title','title']}},{impact:{...preview().impact,fields:['x'.repeat(64)]}},{impact:{...preview().impact,values:['secret']}},{impact:{...preview().impact,widgets:['a','a']}},{trialUnavailable:'broken'},
  {trialUnavailable:undefined},{trial:{}},{draft:{...draft(),status:'applied',appliedVersion:1}},
 ])assert.throws(()=>readBusinessDefinitionPreview({...preview(),...change}),invalid)
})

test('有数据的试算复用台账块核对，origin 缺位、来源错位与覆盖面不一致都拒收',()=>{
 const coverage={objects:1,latestReceivedAt:now,truncated:false}
 const trial:BusinessLedgerBlock={objectType:{definition:readBusinessObjectTypeDefinition(definition),source:{loadId:'local',scope,localId:'ticket',version:'1.0.0',contentHash:hash,fileHash:hash,definitionHash:hash,origin:'local'}},objects:1,source:{sourceId:'source-http',connected:true},coverage,missingFields:[],views:[{schema:'teloa.business-view-result/v1',viewId:'count',viewVersion:'1.0.0',kind:'board-card',chart:'number',title:'工单数',scope,objectType:'ticket',computedAt:now,measures:[{id:'total',label:'总数'}],rows:[{dimension:'all',label:'全部',values:[1]}],dimensionValues:1,coverage,missingFields:[],definitionHash:hash,origin:'local'}]}
 const {trialUnavailable,...available}=preview(),value={...available,trial}
 assert.deepEqual(readBusinessDefinitionPreview(value),value)
 const missingSource=structuredClone(value);delete (missingSource.trial.objectType.source as Partial<typeof trial.objectType.source>).origin
 const missingView=structuredClone(value);delete (missingView.trial.views[0] as Partial<typeof trial.views[number]>).origin
 for(const corrupted of [missingSource,missingView,{...value,trial:{...trial,source:{...trial.source,sourceId:'other'}}},{...value,trial:{...trial,views:[{...trial.views[0],origin:'draft'}]}},{...value,trial:{...trial,views:[{...trial.views[0],coverage:{...coverage,objects:2}}]}},{...value,trialUnavailable}])assert.throws(()=>readBusinessDefinitionPreview(corrupted),invalid)
})

test('看板三种草案的预览：试算键按种类互斥，组件与看板的 impact.objectType 为空串',()=>{
 const boardDraft=(kind:'widget'|'dashboard'|'source-mapping',body:{id:string}):BusinessDefinitionDraft=>({...draft(),kind,localId:body.id,body:businessDefinitionCanonicalBody(body as never)})
 const widget={format:'teloa.business-widget/v1',id:'open-count',version:'1.0.0',domain:scope,title:'未关闭工单',kind:'metric',query:'select count(*) as n from ticket',metric:{valueColumn:'n'}}
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:'总览',widgets:['open-count'],layout:[{widget:'open-count',x:0,y:0,w:4,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const mapping={format:'teloa.business-source-mapping/v1',id:'ticket-sync',version:'1.0.0',domain:scope,title:'工单同步',objectType:'ticket',source:{kind:'mcp-tool',serverName:'tickets',tool:'list_tickets',arguments:{},itemsPath:'$.items[*]'},mapping:[{path:'$.title',field:'title'}],primaryKey:['title'],deletionSemantics:'compare',schedule:{kind:'every',seconds:300},acknowledgeShortInterval:false}
 const empty={scope,objectType:'',views:[],actions:[],fields:[],widgets:[] as string[],dashboards:[] as string[]}
 const {trialUnavailable:_unused,...head}=preview()
 const widgetTrial={widgetId:'open-count',definitionHash:hash,computedAt:now,status:'ok' as const,columns:[{name:'n',type:'number' as const}],rows:[[3]],rowCount:1,truncated:false as const,bytes:1,stale:false}
 const widgetPreview={...head,draft:boardDraft('widget',widget),impact:{...empty,widgets:['open-count'],dashboards:['overview']},widgetTrial}
 assert.deepEqual(readBusinessDefinitionPreview(widgetPreview),widgetPreview)
 const failed={...widgetTrial,status:'failed' as const,columns:[],rows:[],rowCount:0,bytes:0,error:{code:'teloa/invalid-input' as const,reason:'不允许的函数 pg_sleep'}}
 assert.equal(readBusinessDefinitionPreview({...widgetPreview,widgetTrial:failed}).widgetTrial?.status,'failed')
 const dashboardPreview={...head,draft:boardDraft('dashboard',dashboard),impact:{...empty,widgets:['open-count'],dashboards:['overview']},dashboardTrial:{layout:dashboard.layout}}
 assert.deepEqual(readBusinessDefinitionPreview(dashboardPreview),dashboardPreview)
 const mappingPreview={...head,draft:boardDraft('source-mapping',mapping),impact:{...empty,objectType:'ticket',fields:['title']},mappingTrial:{fetched:2,objects:[{objectId:'t-1',fields:[{field:'title',value:'打印机'}]}]}}
 assert.deepEqual(readBusinessDefinitionPreview(mappingPreview),mappingPreview)
 const disconnected={...head,draft:boardDraft('source-mapping',mapping),impact:{...empty,objectType:'ticket',fields:['title']},trialUnavailable:'source-disconnected'}
 assert.deepEqual(readBusinessDefinitionPreview(disconnected),disconnected)
 // 受管 MCP 来源的映射：打开预览不试拉，回 pull-required；其余种类不许出现这个取值。
 const awaiting={...disconnected,trialUnavailable:'pull-required'}
 assert.deepEqual(readBusinessDefinitionPreview(awaiting),awaiting)
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),trialUnavailable:'pull-required'}),invalid)
 // pull-failed 只属于映射草案（来源不限 mcp-tool）；对象类型 / 组件草案不许出现。
 const failedPull={...disconnected,trialUnavailable:'pull-failed'}
 assert.deepEqual(readBusinessDefinitionPreview(failedPull),failedPull)
 assert.deepEqual(readBusinessDefinitionPreview({...failedPull,draft:boardDraft('source-mapping',{...mapping,source:{kind:'business-data-port',sourceId:'source-http'}} as unknown as typeof mapping)}).trialUnavailable,'pull-failed')
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),trialUnavailable:'pull-failed'}),invalid)
 assert.throws(()=>readBusinessDefinitionPreview({...widgetPreview,trialUnavailable:'pull-failed'}),invalid)
 // config-unreadable 同样只属于映射草案（数据源配置文件存在却读不了）。
 const configUnreadable={...disconnected,trialUnavailable:'config-unreadable'}
 assert.deepEqual(readBusinessDefinitionPreview(configUnreadable),configUnreadable)
 assert.throws(()=>readBusinessDefinitionPreview({...preview(),trialUnavailable:'config-unreadable'}),invalid)
 assert.throws(()=>readBusinessDefinitionPreview({...widgetPreview,trialUnavailable:'config-unreadable'}),invalid)
 assert.throws(()=>readBusinessDefinitionPreview({...awaiting,draft:boardDraft('source-mapping',{...mapping,source:{kind:'business-data-port',sourceId:'source-http'}} as unknown as typeof mapping)}),invalid)
 for(const bad of [
  {...widgetPreview,impact:{...widgetPreview.impact,objectType:'ticket'}},{...widgetPreview,trialUnavailable:'no-objects'},{...widgetPreview,widgetTrial:{...widgetTrial,widgetId:'other'}},{...widgetPreview,widgetTrial:{...widgetTrial,secret:1}},{...head,draft:boardDraft('widget',widget),impact:widgetPreview.impact},
  {...dashboardPreview,dashboardTrial:{layout:[{...dashboard.layout[0],w:5}]}},{...dashboardPreview,widgetTrial},{...dashboardPreview,impact:{...dashboardPreview.impact,objectType:'ticket'}},
  {...mappingPreview,impact:{...mappingPreview.impact,objectType:''}},{...mappingPreview,trialUnavailable:'no-objects'},{...mappingPreview,mappingTrial:{fetched:0,objects:[{objectId:'t-1',fields:[]}]}},{...mappingPreview,mappingTrial:{fetched:1,objects:[{objectId:'t-1',fields:[{field:'title',value:'a',raw:'x'}]}]}},
  {...preview(),widgetTrial},
 ])assert.throws(()=>readBusinessDefinitionPreview(bad),invalid)
})

test('模型声明目录拒绝任何对象数据和跨范围声明',()=>{
 const value={scope,objectTypes:[definition],views:[],actions:[]}
 assert.equal(readBusinessDefinitionCatalog(value,scope).objectTypes[0]?.id,'ticket')
 for(const change of [{objects:[{title:'secret'}]},{trial:{}},{objectTypes:[{...definition,domain:'SOC'}]},{objectTypes:[{...definition,fields:[{...definition.fields[0],example:'secret'}]}]}])assert.throws(()=>readBusinessDefinitionCatalog({...value,...change},scope),invalid)
})

test('形状合法的另一人草案、另一请求预览与生效回执也不能通过',async()=>{
 for(const change of [{ownerId:'other'},{id:requestId},{scope:'SOC',body:businessDefinitionCanonicalBody({...definition,domain:'SOC'})}]){
  const handler=createBusinessDefinitionHandler(owner,async()=>[scope],async()=>{throw Error('unused')},async()=>({local:{directory:async()=>directory(),apply:async()=>entry(),revert:async()=>entry()},preview:{preview:async()=>({...preview(),draft:{...draft(),...change}})}}))
  await assert.rejects(handler('business-definitions/preview',{draftId:id}),invalid)
 }
 const handler=createBusinessDefinitionHandler(owner,async()=>[scope],async()=>{throw Error('unused')},async()=>({local:{directory:async()=>({...directory(),drafts:[{...draft(),ownerId:'other'}]}),apply:async()=>({...entry(),current:{...version(),draftId:requestId},versions:[{...version(),draftId:requestId}]}),revert:async()=>entry()},preview:{preview:async()=>preview()}}))
 await assert.rejects(handler('business-definitions/customization',{scope}),invalid)
 await assert.rejects(handler('business-definitions/apply',applyInput),invalid)
})

test('预览端点：pull 只收 true 并原样交给服务，缺省不带',async()=>{
 const e=setup()
 await e.handler('business-definitions/preview',{draftId:id})
 await e.handler('business-definitions/preview',{draftId:id,pull:true})
 assert.deepEqual(e.calls.map(call=>call.input),[{draftId:id},{draftId:id,pull:true}])
 for(const pull of [false,'true',1])await assert.rejects(e.handler('business-definitions/preview',{draftId:id,pull}),{code:'teloa/invalid-input'})
 await assert.rejects(e.handler('business-definitions/preview',{pull:true}),{code:'teloa/invalid-input'})
 assert.equal(e.calls.length,2)
})
