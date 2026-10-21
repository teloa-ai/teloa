import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createRequire} from 'node:module'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
import * as backend from '../../../backend/src/index.ts'
import {BusinessDefinitionSourceReader} from '../../../backend/src/work/business-definition-source.ts'
import {MarketContentStore} from '../../../backend/src/market/content-store.ts'
import {createMarketContentHandler} from '../../../harness-dsh/src/market-content.ts'
import {createBusinessBuilderHandler} from '../../../harness-dsh/src/business-builder.ts'
import {createBusinessDashboardResourceHandler} from '../../../harness-dsh/src/business-dashboard-resource.ts'
import {useLocalContainerRuntime} from '../../../backend/tests/testcontainers-env.ts'
import {Pool} from '../../../backend/tests/postgres-test-lifecycle.ts'
import {packageBusinessDashboardResource} from '../src/client/business-dashboard-resource-api.ts'
import {readIndustryArchive} from '../src/client/industry-archive.ts'
import {inspectBusinessShareContent,type BusinessViewDefinition} from '@teloa/contract'
// @ts-expect-error 现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('正式分享、导入、本人记录、升级和恢复组件连接真实PG完成模板往返',{timeout:120000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client/'),require=createRequire(join(root,'packages/backend/package.json'))
 const {PostgreSqlContainer}=require('@testcontainers/postgresql')
 await mkdir(join(root,'packages/client/ui-workbench/.runtime'),{recursive:true})
 const temp=await mkdtemp(join(root,'packages/client/ui-workbench/.runtime/template-roundtrip-')),identity={id:randomUUID,now:()=>new Date().toISOString()},unavailable=async()=>{throw Error('本轮不调用外部来源或模型')}
 let container:any,pool:any,browser:any,server:any
 const evidence=process.env.TELOA_TEMPLATE_EVIDENCE
 try{
  useLocalContainerRuntime();container=await new PostgreSqlContainer('postgres:17-alpine').start();pool=new Pool({connectionString:container.getConnectionUri()});await backend.initializeTeloaDatabase(pool,{businessSqlSecretPath:join(temp,'sql-role')})
  const make=(ownerId:string)=>{
   const actor={ownerId,scopeIds:[] as string[]},market=new MarketContentStore(pool,identity),drafts=new backend.BusinessConfigurationDraftService(pool,identity),store=new backend.BusinessConfigurationStore(pool)
   const definitions=new BusinessDefinitionSourceReader({get:unavailable,getInTransaction:unavailable},{get:unavailable,getInTransaction:unavailable,listInTransaction:async()=>({items:[],hasMore:false})},{activeSourceIds:unavailable},undefined,store)
   const configuration=new backend.BusinessConfigurationService(pool,identity,{drafts,store,definitions,runtime:new backend.BusinessRuntimeService(pool,identity),spaces:new backend.BusinessSpaceService(pool,identity)}),preview=new backend.BusinessConfigurationPreviewService(pool,drafts,definitions,identity),pages=new backend.BusinessConfigurationPageService(pool,identity,{drafts,store,definitions,executor:{schema:'public',execute:unavailable}}),records=new backend.BusinessRecordService(pool,identity,{definitions,warehouse:new backend.BusinessWarehouseService(pool,identity),references:new backend.BusinessSnapshotReferenceService(pool,identity)})
   const resource=new backend.BusinessDashboardResourceService(pool,{market,configuration,preview,pages,drafts}),scopes=async()=>{actor.scopeIds=(await new backend.BusinessScopeService(pool).list(ownerId)).map(row=>row.scope);return actor.scopeIds}
   const marketHandler=createMarketContentHandler(ownerId,async()=>({import:market.import.bind(market),get:market.get.bind(market),getImport:market.getImport.bind(market),list:market.list.bind(market),importGithub:unavailable,importGithubSkill:unavailable})),builder=createBusinessBuilderHandler(ownerId,scopes,async()=>({drafts,configuration,preview,pages,records,bindings:{} as never})),dashboard=createBusinessDashboardResourceHandler(ownerId,scopes,async()=>resource)
   return {actor,market,drafts,configuration,preview,pages,records,scopes,call:(endpoint:string,input:unknown)=>endpoint.startsWith('market-content/')?marketHandler(endpoint,input):endpoint.startsWith('business-dashboard-resources/')?dashboard(endpoint,input):builder(endpoint,input)}
  }
  let publisher=make('publisher:'+randomUUID()),receiver=make('receiver:'+randomUUID())
  let draft=await publisher.drafts.begin(publisher.actor,{requestId:randomUUID(),title:'销售验收',format:'teloa.business-configuration/v2'})
  draft=await publisher.drafts.revise(publisher.actor,{requestId:randomUUID(),draftId:draft.id,expectedRevision:1,patch:{upsertDefinitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v2',id:'customer',version:'1.0.0',domain:draft.scope,title:'客户',unit:'条',lead:'客户核实',sourceId:draft.candidate.sources[0]!.sourceId,fields:[{name:'stage',label:'阶段',from:'阶段',type:'enum',required:true,values:['待联系','已核实']},{name:'note',label:'备注',from:'备注',type:'text',required:false}]}},
   {kind:'view',definition:{format:'teloa.business-view/v1',id:'stages',version:'1.0.0',domain:draft.scope,title:'客户阶段',kind:'distribution',chart:'bar',objectType:'customer',dimension:{field:'stage',limit:10},measures:[{id:'count',label:'数量',aggregation:'count'}],filters:[],sort:{by:'dimension',direction:'asc'},limit:10}},
   {kind:'widget',definition:{format:'teloa.business-widget/v1',id:'customer-summary',version:'1.0.0',domain:draft.scope,title:'客户统计',kind:'view-ref',viewRef:'stages'}},
   {kind:'dashboard',definition:{format:'teloa.business-dashboard/v1',id:'customer-overview',version:'1.0.0',domain:draft.scope,title:'客户总览',widgets:['customer-summary'],layout:[{widget:'customer-summary',x:0,y:0,w:12,h:3}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false}},
  ],upsertPages:[{id:'customers',title:'客户记录',kind:'records',objectType:'customer',fields:['stage','note'],allowCreate:true,allowEdit:true,allowArchive:true},{id:'overview',title:'客户总览',kind:'dashboard',dashboardId:'customer-overview'}],homePageId:'customers'}})
  const apply=async(s:typeof publisher,d:typeof draft)=>s.configuration.apply(s.actor,{requestId:randomUUID(),draftId:d.id,expectedRevision:d.revision,expectedBaseVersion:d.baseVersion,previewReceipt:(await s.preview.preview(s.actor,{draftId:d.id,expectedRevision:d.revision})).receipt})
  await apply(publisher,draft);await publisher.scopes()
  await publisher.records.create(publisher.actor,{requestId:randomUUID(),scope:draft.scope,type:'customer',title:'发布者私人客户',summary:'不能随模板导出',fields:[{name:'stage',value:'已核实'},{name:'note',value:'发布者私人记录内容'}]})
  const exported=await publisher.call('business-dashboard-resources/export',{scope:draft.scope,id:'sales-method',version:'1.0.0'}) as {resource:Parameters<typeof packageBusinessDashboardResource>[0]}
  await packageBusinessDashboardResource(exported.resource,{title:'销售业务模板',description:'分享客户核实方法'})
  let firstApply=true,expiredRecovery=false,firstPreserve=true
  const sourceScope=draft.scope,publisherId=publisher.actor.ownerId,receiverId=receiver.actor.ownerId,calls:string[]=[]
  server=createServer(async(req:any,res:any)=>{
   if(req.method!=='POST'){res.setHeader('content-type','text/html');res.end('<!doctype html><div id="root"></div>');return}
   try{
    let body='';for await(const chunk of req)body+=chunk
    const row=JSON.parse(body),s=row.owner==='publisher'?publisher:receiver;calls.push(row.owner+':'+row.endpoint)
    let value
    if(row.endpoint==='qa/update-source'){
     let changed=await publisher.drafts.begin(publisher.actor,{requestId:randomUUID(),scope:sourceScope,title:'销售验收',format:'teloa.business-configuration/v2'})
     const page=changed.candidate.pages[0]!
     changed=await publisher.drafts.revise(publisher.actor,{requestId:randomUUID(),draftId:changed.id,expectedRevision:changed.revision,patch:{upsertPages:[{...page,title:'新版客户记录'}]}});value=await apply(publisher,changed)
    }else{
     if(row.owner==='receiver'&&row.endpoint==='business-dashboard-resources/apply'){
      if(firstApply){firstApply=false;expiredRecovery=true;throw Error('隔离验收模拟请求未派发的网络中断')}
      if(expiredRecovery){expiredRecovery=false;row.input={...row.input,previewReceipt:'0'.repeat(64)}}
     }
     value=await s.call(row.endpoint,row.input)
     if(row.owner==='receiver'&&row.endpoint==='business-dashboard-resources/prepare-upgrade'&&row.input.preserveDataShape===true&&firstPreserve){firstPreserve=false;throw Error('隔离验收模拟保留字段草案已生成但回执丢失')}
    }
    res.setHeader('content-type','application/json');res.end(JSON.stringify({value}))
   }catch(error:any){console.error('隔离RPC拒绝：',error.code,error.message);res.statusCode=400;res.setHeader('content-type','application/json');res.end(JSON.stringify({error:{code:error.code,message:error.message,details:error.details}}))}
  })
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url='http://127.0.0.1:'+server.address().port
  const fixture=join(temp,'fixture.tsx')
  const source=`import React from 'react';import {createRoot} from 'react-dom/client';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessDashboardShareForm} from '${client}BusinessDashboardShareForm.tsx';import {BusinessDashboardMarketPanel} from '${client}BusinessDashboardMarketPanel.tsx';import {BusinessDashboardUpgradePanel} from '${client}BusinessDashboardUpgradePanel.tsx';import {createBusinessDashboardResourceApi} from '${client}business-dashboard-resource-api.ts';import {createDashboardMarketJournal} from '${client}business-dashboard-market-journal.ts';import {createBusinessShareApi} from '${client}business-share-flow.ts';import {createMarketContentApi} from '${client}market-content-api.ts';import {packageBusinessDashboardResource} from '${client}business-dashboard-resource-api.ts'
import {readIndustryArchive} from '${client}industry-archive.ts';import {BusinessRecordPage} from '${client}BusinessRecordPage.tsx';import {BusinessRecordFlow} from '${client}business-record-flow.ts';import {createBusinessRecordApi} from '${client}business-record-api.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};const state=window.fixture={items:[],inspection:undefined,projection:undefined,previewScope:undefined,dashboardPages:[],connectionRequests:[],preserveRequests:[],debugErrors:[]};
const call=owner=>async(endpoint,input)=>{const res=await fetch('/rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({owner,endpoint,input})});const row=await res.json();if(endpoint==='business-dashboard-resources/prepare-upgrade'&&input.preserveDataShape===true)state.preserveRequests.push(input);if(row.error)throw Object.assign(Error(row.error.message),row.error);if(endpoint==='business-dashboard-resources/page'&&row.value?.page?.kind==='dashboard')state.dashboardPages.push(row.value);return row.value};
const pcall=call('publisher'),rcall=call('receiver'),papi=createBusinessDashboardResourceApi(pcall),rapi=createBusinessDashboardResourceApi(rcall,createDashboardMarketJournal(localStorage,'qa.receiver')),market=createMarketContentApi(rcall),share=createBusinessShareApi({read:async()=>{throw Error('unused')}},createMarketContentApi(pcall)),original=share.inspect;share.inspect=async(...args)=>{state.inspection=await original(...args);return state.inspection};for(const key of ['current','prepareUpgrade']){const original=rapi[key];rapi[key]=async(...args)=>{try{return await original(...args)}catch(error){state.debugErrors.push(key+': '+error.message);throw error}}}const hydrate=market.hydrate;market.hydrate=async(...args)=>{try{return await hydrate(...args)}catch(error){state.debugErrors.push('hydrate: '+error.message);throw error}};const jr=rapi.journal.read;rapi.journal.read=(...args)=>{try{return jr(...args)}catch(error){state.debugErrors.push('journal: '+error.message);throw error}};const recordFlow=new BusinessRecordFlow(createBusinessRecordApi(rcall));
const open=async scope=>{const head=await rcall('business-configuration/current',{scope});state.projection=await rcall('business-configuration/page',{scope,pageId:head.manifest.homePageId??head.manifest.pages[0].id});render()};const upload=async file=>{const found=await readIndustryArchive(new Uint8Array(await file.arrayBuffer()),file.name);const item=await market.importIndustry(found[0].item);state.items.push(item);render()};window.updateSource=()=>pcall('qa/update-source',{});window.previewDashboard=async scope=>{const exported=await papi.export({scope:'${sourceScope}',id:'market-sales-dashboard',version:'1.0.0'}),resource=exported.resource,view=resource.configuration.definitions.find(row=>row.kind==='view'),widget=resource.configuration.definitions.find(row=>row.kind==='widget'),dashboard=resource.configuration.definitions.find(row=>row.kind==='dashboard');view.definition.id='market-stages';widget.definition.id='market-summary';widget.definition.viewRef='market-stages';dashboard.definition.id='market-customer-overview';dashboard.definition.widgets=['market-summary'];dashboard.definition.layout=[{widget:'market-summary',x:0,y:0,w:12,h:3}];dashboard.definition.title='市场客户总览';resource.configuration.pages=[{id:'market-overview',title:'市场客户总览',kind:'dashboard',dashboardId:'market-customer-overview'}];resource.configuration.homePageId='market-overview';state.previewItem=await market.importIndustry(await packageBusinessDashboardResource(resource,{title:'客户阶段看板',description:'本人现有记录上的独立市场看板夹具'}));state.previewScope=scope;state.projection=undefined;render()};window.addBreakingDashboard=async()=>{const exported=await papi.export({scope:'${sourceScope}',id:'sales-method',version:'1.2.0'}),resource=exported.resource,object=resource.configuration.definitions.find(row=>row.kind==='object-type');object.definition.fields.push({name:'channel',label:'渠道',from:'渠道',type:'enum',required:true,values:['官网','线下']});const view=resource.configuration.definitions.find(row=>row.kind==='view');view.definition.dimension.field='channel';const item=await market.importIndustry(await packageBusinessDashboardResource(resource,{title:'按渠道看板',description:'新增渠道维度的固定市场夹具'}));state.items.push(item);render();return item.contentStorage.contentId};
let root=createRoot(document.getElementById('root'));window.remount=()=>{root.unmount();root=createRoot(document.getElementById('root'));render()};function render(){root.render(<I18nProvider runtime={runtime}><BusinessDashboardShareForm scope='${sourceScope}' api={papi} share={share} openMarket={()=>{}}/><label>接收者导入模板<input type='file' aria-label='接收者导入模板' onChange={e=>void upload(e.target.files[0])}/></label>{state.previewScope?<BusinessDashboardMarketPanel key='market-60d' journalKey='qa-market-60d' item={state.previewItem} api={rapi} spaces={[{scope:state.previewScope,title:'本人业务',kind:'business',loads:0,activeLoads:0,tasks:0,groups:0}]} colorScheme='light' openSaved={()=>{state.previewScope=undefined;render()}} onDiscardDraft={()=>{state.previewScope=undefined;render()}}/>:state.items[0]&&<BusinessDashboardMarketPanel item={state.items[0]} api={rapi} spaces={[]} colorScheme='light' openSaved={open} upgrade={adoption=><BusinessDashboardUpgradePanel item={state.items[0]} candidates={state.items} api={rapi} adoption={adoption} hydrate={market.hydrate} spaces={[]} colorScheme='light' openSaved={open} openConnections={scope=>state.connectionRequests.push(scope)}/>}/>} {state.projection&&<BusinessRecordPage projection={state.projection} flow={recordFlow} capabilities={{create:true,edit:true,archive:true}}/>}</I18nProvider>)}render();`
  await writeFile(fixture,source)
  const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:fixture,name:'TemplateRoundtrip',formats:['iife']}}});const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
  const script=bundle.output.find(row=>row.type==='chunk')!.code,css=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
  t.signal.throwIfAborted()
  const {chromium}=await loadPlaywright();browser=await chromium.launch(launchOptions());const closeBrowser=()=>browser.close();t.after(closeBrowser);t.signal.addEventListener('abort',closeBrowser,{once:true});if(t.signal.aborted){await closeBrowser();t.signal.throwIfAborted()}
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[];page.setDefaultTimeout(8000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(url)?route.continue():route.abort())
  await page.goto(url);await page.addStyleTag({content:css});await page.addScriptTag({content:script})
  const sharePanel=page.getByRole('region',{name:'分享业务配置',exact:true})
  await sharePanel.getByLabel('包标识').fill('sales-method');await sharePanel.getByLabel('名称',{exact:true}).fill('销售业务模板');const token='gh'+'p_'+'Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2'
  await sharePanel.getByLabel('说明',{exact:true}).fill(token);await sharePanel.getByRole('button',{name:'生成预览'}).click();await page.getByRole('region',{name:'分享内容检查'}).waitFor();assert.ok(!(await page.locator('body').innerText()).includes(token));assert.equal(await sharePanel.getByRole('button',{name:'下载 ZIP'}).isDisabled(),true);await sharePanel.getByRole('button',{name:'返回编辑'}).click();assert.equal(await sharePanel.getByLabel('说明',{exact:true}).inputValue(),token);await sharePanel.getByLabel('说明',{exact:true}).fill('分享客户核实方法')
  await sharePanel.getByRole('button',{name:'生成预览'}).click();await page.getByRole('region',{name:'分享内容检查'}).waitFor()
  const pending=page.waitForEvent('download');await sharePanel.getByRole('button',{name:'下载 ZIP'}).click();const download=await pending,file=join(temp,'sales-method.zip');await download.saveAs(file)
  const inspection=await page.evaluate(()=>(window as any).fixture.inspection);assert.equal(inspection.findings.length,0)
  const archive=await readIndustryArchive(new Uint8Array(await readFile(file)),'sales-method.zip'),actual=await inspectBusinessShareContent({files:archive[0]!.item!.packageContent!.files,purpose:'分享客户核实方法'});assert.equal(actual.digest,inspection.digest);assert.ok(!archive[0]!.item!.packageContent!.files.some(row=>new TextDecoder().decode(row.bytes).includes('发布者私人记录内容')))
  await page.getByLabel('接收者导入模板').setInputFiles(file)
  await page.getByRole('button',{name:'生成配置草稿',exact:true}).click();await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).click();await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await page.getByRole('button',{name:'刷新预览',exact:true}).waitFor();assert.equal((await pool.query('select count(*)::int n from teloa_business_configuration_heads where owner_id=$1',[receiverId])).rows[0].n,0);await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).click();await page.getByRole('button',{name:'打开业务',exact:true}).click()
  await receiver.scopes();const adoptedScopes=(await pool.query('select scope_id from teloa_business_configuration_heads where owner_id=$1',[receiverId])).rows
  assert.equal(adoptedScopes.length,1)
  const receiverScope=adoptedScopes[0].scope_id as string
  assert.equal((await receiver.records.list(receiver.actor,{scope:receiverScope,type:'customer',limit:20})).items.length,0)
  const saved=await receiver.configuration.current(receiver.actor,{scope:receiverScope});assert.notEqual(saved!.manifest.sources[0]!.sourceId,draft.candidate.sources[0]!.sourceId)
  await page.getByRole('button',{name:/新增第一条|新增记录/}).first().click();await page.getByLabel('记录标题').fill('接收者本人客户');await page.getByLabel(/^阶段/).selectOption('待联系');await page.getByLabel('备注',{exact:true}).fill('本人新增的记录');await page.getByRole('button',{name:'保存记录',exact:true}).click();await page.getByText('接收者本人客户',{exact:true}).first().waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click()
  const before=(await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[receiverId])).rows
  await page.evaluate(()=>(window as any).updateSource());await sharePanel.getByRole('button',{name:'返回编辑'}).click();await sharePanel.getByLabel('版本').fill('1.1.0');await sharePanel.getByRole('button',{name:'生成预览'}).click()
  const next=page.waitForEvent('download');await sharePanel.getByRole('button',{name:'下载 ZIP'}).click();const newer=await next,file2=join(temp,'sales-method-1.1.zip');await newer.saveAs(file2);await page.getByLabel('接收者导入模板').setInputFiles(file2)
  // 60d：同一固定市场资源先在本人已有记录上预览；取消不新增配置版本或改变记录。
  await page.waitForFunction(()=>(window as any).fixture.items.length===2)
  await page.evaluate((scope:string)=>(window as any).previewDashboard(scope),receiverScope)
  await page.getByRole('combobox',{name:'采用到业务',exact:true}).selectOption(receiverScope)
  await page.getByRole('combobox',{name:/^客户/}).selectOption('customer')
  await page.getByRole('button',{name:'生成配置草稿',exact:true}).click();await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('button',{name:'市场客户总览',exact:true}).last().click()
  await page.locator('[data-dashboard] [data-widget]').waitFor()
  const dashboardPreview=await page.evaluate(()=>(window as any).fixture.dashboardPages.at(-1))
  assert.equal(dashboardPreview.scope,receiverScope);assert.equal(dashboardPreview.mode,'preview');assert.equal(dashboardPreview.page.widgets.length,1)
  assert.ok(dashboardPreview.page.results.every((result:any)=>result.view.coverage.objects===1))
  assert.ok(dashboardPreview.page.results.every((result:any)=>result.view.rows.some((row:any)=>row.dimension==='待联系'&&row.values[0]===1)),'看板只读到接收者本人的真实记录，而不是发布者或假汇总')
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'market-dashboard-current-records.png')});await writeFile(join(evidence,'market-dashboard-preview.json'),JSON.stringify(dashboardPreview,null,2)+'\n')}
  await page.getByRole('button',{name:'放弃草案',exact:true}).click();assert.equal((await receiver.configuration.current(receiver.actor,{scope:receiverScope}))!.version,1)
  assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[receiverId])).rows,before)
  // 同一入口再次预览后明确采用；当前业务的数据和本地页面继续保留。
  await page.evaluate((scope:string)=>(window as any).previewDashboard(scope),receiverScope)
  await page.getByRole('combobox',{name:'采用到业务',exact:true}).selectOption(receiverScope);await page.getByRole('combobox',{name:/^客户/}).selectOption('customer')
  await page.getByRole('button',{name:'生成配置草稿',exact:true}).click();await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('button',{name:'市场客户总览',exact:true}).last().click();await page.locator('[data-dashboard] [data-widget]').waitFor()
  await page.getByRole('button',{name:'保存业务',exact:true}).click();await page.getByRole('button',{name:'打开业务',exact:true}).click()
  const marketAdopted=(await receiver.configuration.current(receiver.actor,{scope:receiverScope}))!;assert.equal(marketAdopted.version,2);assert.ok(marketAdopted.manifest.pages.some(row=>row.kind==='dashboard'&&row.title==='市场客户总览'))
  assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[receiverId])).rows,before)
  await page.getByRole('button',{name:'升级业务看板',exact:true}).click();await page.getByRole('combobox',{name:/^已保存的(新|旧)版本$/}).selectOption({index:1});await page.getByRole('button',{name:'生成配置草稿',exact:true}).click();await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).click()
  await page.getByRole('button',{name:'恢复模板配置',exact:true}).waitFor()
  const originalContentId=await page.evaluate(()=>(window as any).fixture.items.find((item:any)=>item.version==='1.0.0')?.contentStorage?.contentId);assert.equal(typeof originalContentId,'string')
  await page.evaluate(()=>{for(const key of Object.keys(localStorage)){const raw=localStorage.getItem(key);if(!raw)continue;const saved=JSON.parse(raw);if(saved.upgrade){delete saved.upgrade.request.mode;localStorage.setItem(key,JSON.stringify(saved))}}(window as any).fixture.projection=undefined;(window as any).remount()})
  // 先恢复无 mode 的旧升级记录，再从已采用的 1.1.0 明确发起恢复，不按按钮或选项位置猜测阶段。
  await page.getByRole('button',{name:'恢复模板配置',exact:true}).click();await page.getByRole('button',{name:'恢复模板配置',exact:true}).click()
  const restorePanel=page.getByRole('region',{name:'升级业务看板',exact:true})
  await restorePanel.getByRole('heading',{name:'恢复模板配置',exact:true}).waitFor();await restorePanel.getByText(/^sales-method · v1\.1\.0/).waitFor()
  await restorePanel.getByRole('combobox',{name:'已保存的旧版本',exact:true}).selectOption(originalContentId)
  const restorePrepared=page.waitForResponse((response:any)=>{if(response.request().method()!=='POST')return false;const row=response.request().postDataJSON();return row.endpoint==='business-dashboard-resources/prepare-upgrade'&&row.input.mode==='restore'&&row.input.candidateContentId===originalContentId})
  await restorePanel.getByRole('button',{name:'生成配置草稿',exact:true}).click()
  const prepared=(await (await restorePrepared).json()).value;assert.ok(prepared?.draft);assert.equal(prepared.draft.scope,receiverScope);assert.equal(prepared.draft.baseVersion,3);assert.equal(prepared.draft.status,'draft');assert.deepEqual(prepared.conflicts,[])
  await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).click()
  await page.getByRole('button',{name:'恢复模板配置',exact:true}).waitFor()
  assert.equal((await receiver.configuration.current(receiver.actor,{scope:receiverScope}))!.version,4)
  assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[receiverId])).rows,before)
  receiver=make(receiverId);await receiver.scopes();assert.equal((await receiver.records.list(receiver.actor,{scope:receiverScope,type:'customer',limit:20})).items[0]!.title,'接收者本人客户')
  assert.equal((await publisher.records.list(publisher.actor,{scope:sourceScope,type:'customer',limit:20})).items[0]!.title,'发布者私人客户')
  assert.equal(await page.getByRole('button',{name:'打开业务',exact:true}).count(),1)
  // 60c 的真实缺字段阻断：升级候选包含完整看板 graph，现有本人记录没有新必填渠道。
  const breakingId=await page.evaluate(()=>(window as any).addBreakingDashboard())
  await page.getByRole('button',{name:'升级业务看板',exact:true}).click();await page.getByRole('combobox',{name:'已保存的新版本',exact:true}).selectOption(breakingId);await page.getByRole('button',{name:'生成配置草稿',exact:true}).click();await page.getByRole('button',{name:'刷新预览',exact:true}).click()
  await page.getByRole('alert').filter({hasText:'此变化影响现有历史记录，已阻止采用'}).waitFor()
  assert.equal(await page.getByRole('button',{name:'保存业务',exact:true}).isDisabled(),true)
  await page.getByText(/customer \/ channel/).waitFor();assert.equal((await receiver.configuration.current(receiver.actor,{scope:receiverScope}))!.version,4)
  assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[receiverId])).rows,before)
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'upgrade-missing-channel-blocked.png')})}
  const blockedDraft=(await pool.query("select d.id from teloa_business_dashboard_preparations p join teloa_business_configuration_drafts d on d.id=p.draft_id where p.owner_id=$1 and p.source->'resource'->>'version'='1.2.0'",[receiverId])).rows[0].id
  await page.getByRole('button',{name:'去连接新数据源',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.connectionRequests),[receiverScope]);assert.equal((await receiver.configuration.current(receiver.actor,{scope:receiverScope}))!.version,4)
  const preserve=page.getByRole('button',{name:'保持现有字段与维度生成草案',exact:true})
  await preserve.click();await page.getByRole('alert').filter({hasText:'暂时无法完成操作'}).waitFor();await preserve.click()
  await page.getByRole('button',{name:'刷新预览',exact:true}).click();await page.getByRole('region',{name:'本次暂缓的配置',exact:true}).waitFor()
  const kept=await page.evaluate(()=>(window as any).fixture.preserveRequests);assert.equal(kept.length,2);assert.deepEqual(kept[0],kept[1],'未知回执只恢复同一保留意图')
  await assert.rejects(receiver.call('business-dashboard-resources/prepare-upgrade',{...kept[0],preserveDataShape:'true'}),{code:'teloa/invalid-input'})
  await assert.rejects(receiver.call('business-dashboard-resources/prepare-upgrade',{...kept[0],preserveDataShape:false}),{code:'teloa/conflict'})
  const blockedValue=await receiver.drafts.get(receiver.actor,{draftId:blockedDraft}),blockedView=blockedValue.candidate.definitions.find(row=>row.kind==='view'&&(row.definition as BusinessViewDefinition).dimension?.field==='channel')!
  const preserveDraft=(await pool.query("select d.id,d.status from teloa_business_dashboard_preparations p join teloa_business_configuration_drafts d on d.id=p.draft_id where p.owner_id=$1 and p.request_id=$2",[receiverId,kept[0].requestId])).rows[0]
  assert.notEqual(preserveDraft.id,blockedDraft);assert.equal((await receiver.drafts.get(receiver.actor,{draftId:blockedDraft})).status,'draft')
  await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='保存业务'&&!button.disabled))
  if(evidence){await page.screenshot({path:join(evidence,'upgrade-preserved-fields-preview.png')})}
  await page.getByRole('button',{name:'保存业务',exact:true}).click();await page.getByRole('button',{name:'恢复模板配置',exact:true}).waitFor()
  const preserved=(await receiver.configuration.current(receiver.actor,{scope:receiverScope}))!;assert.equal(preserved.version,5)
  const preservedObject=preserved.leaves.find(leaf=>leaf.kind==='object-type')!,preservedView=preserved.leaves.find(leaf=>leaf.kind==='view'&&leaf.localId===blockedView.definition.id)!
  assert.ok(!JSON.parse(preservedObject.body).fields.some((field:any)=>field.name==='channel'));assert.equal(JSON.parse(preservedView.body).dimension.field,'stage')
  assert.deepEqual((await pool.query('select snapshot from teloa_business_object_snapshots where owner_id=$1 order by object_id,object_version',[receiverId])).rows,before)
  assert.deepEqual(errors,[])
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'template-restored.png')});await writeFile(join(evidence,'summary.json'),JSON.stringify({status:'passed',realPg:true,formalComponents:true,ownersIsolated:true,sourceRebound:true,recordPreserved:true,restartedRead:true,checks:calls.length,inspectionDigest:inspection.digest,graph:['object-type','view','widget','dashboard'],marketDashboardUsesCurrentRecords:true,marketCancelPreservesVersion:true,marketDashboardExplicitlyAdopted:true,upgradeMissingFieldBlocked:true,upgradeRemediationActions:'passed',preservedDataShapeExplicitlyAdopted:true,preservedUnknownReceiptSameRequest:true},null,2)+'\n')}
 }catch(error){if(evidence&&browser){await mkdir(evidence,{recursive:true});const page=browser.contexts()[0]?.pages()[0];await page?.screenshot({path:join(evidence,'failed.png')});await writeFile(join(evidence,'failed.txt'),await page?.locator('body').innerText()??'');await writeFile(join(evidence,'failed-state.json'),JSON.stringify(await page?.evaluate(()=>({errors:(window as any).fixture.debugErrors,requests:(window as any).fixture.preserveRequests})),null,2))}throw error}
 finally{await browser?.close();if(server)await new Promise<void>(done=>server.close(()=>done()));await pool?.end();await container?.stop();await rm(temp,{recursive:true,force:true})}
})
