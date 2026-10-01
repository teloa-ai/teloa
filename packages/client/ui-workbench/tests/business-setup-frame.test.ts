import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {mount as mountMarket,marketProps,nodes} from './market-component-harness.ts'
// @ts-expect-error Playwright helper is an existing JavaScript fixture without declarations.
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
// 真实 Frame/store/controller/BindingClient/Panel。无关产品页在组件边界隔离，slot 是挂载计数探针，不冒充官方编辑器。
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
const entry=`
import React,{useEffect,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import {WorkbenchFrame} from '${client}WorkbenchFrame.tsx';import {createWorkbenchStore} from '${client}store.ts';
import {BusinessBuilderController} from '${client}business-builder-controller.ts';import {BindingClient} from '${client}binding-client.ts';
import {insertBusinessRecordInput} from '${client}business-record-input.ts';
import {captureWorkbenchNavigationState} from '${client}workbench-navigation-state.ts';
import {ConversationManagement} from '${client}conversation-management.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale,revision:1},runtime={t:(k,p)=>translateMessage(locale,k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const startup=window.frameStartup||{};const f=window.frameFixture={...startup,mounts:0,unmounts:0,creates:0,prepares:0,calls:[],identityFails:false,holdIdentity:false,blocks:{},bindingReads:0};
const listeners=new Set(),main={getSnapshot:()=>selected,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)}};let selected=startup.sessionId,releaseIdentity,releaseCreate,releaseScopes;
const stamp='2026-09-29T00:00:00.000Z',space={id:'12345678-1234-4234-8234-123456789012',name:'验收工作空间',description:'',kind:'personal',version:1,createdAt:stamp,updatedAt:stamp};
const empty=[],byId={},rows=new Map(),reservations=new Map(),contexts=new Map(),nativeListeners=new Set(),inputs=new Map();let draft;const emptyInput={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]};f.nativeReady=startup.nativeReady!==false;f.nativeNotify=()=>{for(const listener of nativeListeners)listener()};f.input=value=>{inputs.set(selected,value);f.nativeNotify()};
const initial=createWorkbenchStore().create();initial.actions.openBusiness({scope:'sales',section:'data',objectType:'customer',id:'customer-one',recordReference:{scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64)}});
const store=createWorkbenchStore('light',startup.restoreRecord?captureWorkbenchNavigationState(initial.getSnapshot()):undefined).create();store.actions.navigate('spaces');
const useStore=selector=>selector(useSyncExternalStore(store.subscribe,store.getSnapshot)),useSessions=selector=>selector({byId});
const work=new BindingClient({list:async()=>[...rows.values()],read:async id=>rows.get(id),ensure:async id=>rows.get(id),isNativeChild:()=>false,catalog:async()=>({skills:[],tools:[]}),block:()=>{},current:()=>selected,open:id=>{selected=id;if(f.nativeOpenView==='messages')store.actions.openMessages('native');else if(f.nativeOpenView)store.actions.navigate(f.nativeOpenView);for(const l of listeners)l()},adopt:async id=>id,create:async p=>{const prior=[...rows.values()].find(row=>row.requestId===p.requestId);if(prior)return prior;f.creates++;if(f.holdCreate)await new Promise(r=>releaseCreate=r);const row={id:crypto.randomUUID(),ownerId:'self',title:p.title,version:1,status:'ready',sessionId:crypto.randomUUID(),requestedSessionId:'fixed',requestId:p.requestId,scopeIds:['general'],createdAt:stamp,...(p.workspaceId?{requestedWorkspaceId:p.workspaceId}:{})};rows.set(row.sessionId,row);byId[row.sessionId]={...row,displayTitle:row.title};if(f.loseCreate){f.loseCreate=false;throw Error('lost native create response')}return row}});
const api={recentDaily:async({scope})=>{f.recentReads=(f.recentReads||0)+1;if(f.failRecent)throw Error('recent unavailable');return [...reservations.values()].filter(b=>b.kind==='daily'&&b.scope===scope).at(-1)||null},bySession:async({sessionId})=>{f.bindingReads++;if(f.failBinding||f.failBindingAt===f.bindingReads)throw Error('binding transient');return [...reservations.values()].find(b=>b.sessionId===sessionId||b.requestId===rows.get(sessionId)?.requestId)||null},byRequest:async({requestId})=>reservations.get(requestId),reserve:async p=>{let b=reservations.get(p.requestId);if(!b){b={...p,...(p.kind==='builder'?{draftId:crypto.randomUUID()}:{}),createdAt:stamp,updatedAt:stamp};reservations.set(p.requestId,b);draft={id:b.draftId,ownerId:'self',scope:'sales',revision:1,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[],definitions:[],pages:[]}}}return b},bind:async p=>{const b={...reservations.get(p.requestId),sessionId:p.sessionId};reservations.set(p.requestId,b);return b},draft:async()=>draft,list:async()=>({items:[...reservations.values()].filter(b=>b.kind==='builder').map(binding=>({binding,draft:{id:binding.draftId,scope:'sales',title:'验收业务',revision:1,status:'draft',updatedAt:stamp}}))}),current:async input=>{f.calls.push('current');return f.formal?{...formal,scope:input.scope,manifest:{...formal.manifest,scope:input.scope,title:input.scope==='support'?'另一业务':'验收业务'}}:null},page:async input=>{f.pageReads=(f.pageReads||0)+1;return ({mode:'saved',scope:input.scope,configurationVersion:1,configurationHash:'a'.repeat(64),page:{kind:'records',definition:input.pageId==='review'?{...pageDefinition,id:'review',title:'复核页'}:pageDefinition,objectType:{...objectType,domain:input.scope},emptyState:'no-records'}})}};
const pageDefinition={id:'records',title:'客户记录',kind:'records',objectType:'customer',fields:['name'],allowCreate:false,allowEdit:false,allowArchive:false};const objectType={format:'teloa.business-object-type/v1',id:'customer',domain:'sales',version:'1.0.0',title:'客户',unit:'条',lead:'客户',sourceId:'local',fields:[{name:'name',label:'名称',from:'名称',type:'text',required:false}]};const formal={scope:'sales',version:1,hash:'a'.repeat(64),createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)}],pages:[pageDefinition,{...pageDefinition,id:'review',title:'复核页'}],homePageId:'records'}};
const record={scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64),title:'客户甲',source:'local',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'',fields:[]};
const controller=new BusinessBuilderController({api,work,storage:localStorage,identity:async()=>{if(f.holdIdentity)await new Promise(r=>releaseIdentity=r);if(f.identityFails)throw Error('identity failed');return space.id},subscribeNative:listener=>{nativeListeners.add(listener);return()=>nativeListeners.delete(listener)},contextCall:async(endpoint,p)=>{if(endpoint==='work-context/read')return contexts.get(p.sessionId)||null;const value={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:1,locked:false};contexts.set(p.sessionId,value);return value},switching:{read:()=>({mainSessionId:selected,bindingSessionId:selected,bindingReady:f.nativeReady,input:!f.nativeReady?undefined:selected?(inputs.get(selected)||emptyInput):null,pendingSubmissions:[],monitor:undefined})},block:(id,reason)=>{if(reason)f.blocks[id]=reason;else delete f.blocks[id]},watch:()=>()=>{},id:()=>crypto.randomUUID()});
const management=new ConversationManagement(()=>[...rows.values()]);const managementState={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]}]};management.attach({state:()=>managementState,subscribe:()=>()=>{},summary:()=>({title:'会话',running:false,blank:false})});
const noop=()=>{},generic=new Proxy({},{get:(_,key)=>key==='subscribe'?()=>noop:key==='list'?async()=>[]:key==='recoveries'||key==='recoveryItems'?()=>[]:String(key).startsWith('pending')||String(key).includes('Recovery')||key==='recoveryMessage'?()=>undefined:async()=>[]});
const pageList={...generic,list:async()=>({items:[]})};
const apiNames='planApi marketContentApi marketCatalogApi skillSecretsApi githubSourceApi industryLoadApi industryKnowledgeApi industryDataSourceApi industryExecutionToolApi industryMcpConnectionApi industryPluginApi industryRoleApi industryTaskApi industryPlanApi skillInstallApi marketPluginInstallApi bundledExtensionsApi skillAvailabilityApi skillUpgradeApi resourceApi roleApi memoryApi dailyLogApi runtimeConfigApi taskApi projectApi taskRunApi securityActionApi taskMaterialApi taskTransitions pendingRequestApi roleLifecycle roleToolGrantApi handoffApi objectConversationApi groupApi groupAttachmentApi groupReactionApi groupRoutingApi businessLedgerApi businessDashboardApi businessCustomizationApi connectorProbeApi businessTaskApi pageCreateApi preparation nativeArtifacts artifactFileApi artifactApi'.split(' ');
const props=Object.fromEntries(apiNames.map(name=>[name,generic]));for(const name of ['industryDataSourceApi','industryExecutionToolApi','industryMcpConnectionApi','industryPluginApi'])props[name]=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]});
props.businessSpaceApi={current:async()=>space};props.businessScopeApi={list:async()=>{f.scopeReads=(f.scopeReads||0)+1;if(f.holdScopes)await new Promise(r=>releaseScopes=r);if(f.failScopes)throw Error('scope unavailable');f.scopesReturned=true;return [{scope:f.otherScope?'general':'sales',title:'验收业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0},{scope:'support',title:'另一业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}]}};
props.industryLoadApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>{f.industryRead=true;if(f.failIndustry)throw Error('industry unavailable');return []}:target[key]});f.releaseScopes=()=>{f.holdScopes=false;releaseScopes?.()};
props.businessLedgerApi=new Proxy(generic,{get:(t,k)=>k==='read'?async()=>{f.calls.push('legacy');throw Error('controlled unavailable')}:t[k]});
function Probe(){useEffect(()=>{f.mounts++;return()=>{f.unmounts++}},[]);return <textarea aria-label="slot-probe" defaultValue="原生输入草稿"/>}
const renderSlot=(name,props,options)=>name==='teloa.conversation'?props.content:name==='main'&&options?.entryKey==='conversation'?<Probe/>:null;
f.openExact=()=>store.actions.openBusiness({scope:'sales',section:'dashboards',dashboardId:'review'});f.otherBusiness=()=>store.actions.openBusiness({scope:'support',section:'overview'});f.setupReads=[];
props.managedMcpConnectionApi=generic;
props.createBusinessSetup=(namespace,token)=>({read:async input=>{f.setupReads.push({namespace,sameToken:token===controller.getSnapshot().api,input});return {scope:input.scope,configurationVersion:input.expectedVersion,configurationHash:input.expectedHash,observedAt:stamp,colleagues:{status:'observed',value:{responsibility:{roleId:null,availability:'none'},roles:[],selectedRole:null}},skills:{status:'observed',value:{declared:[],executionChecked:false}},knowledge:{status:'observed',value:{assigned:[],generalResourceCount:0,businessResourceCount:0}},connections:{status:'observed',value:{items:[{id:'one',catalogId:'official-crm',serverName:'CRM',status:'connected',updatedAt:stamp}],binding:'not-declared'}}}}});
f.recheck=async()=>{await controller.followSession(undefined);await controller.followSession(selected)};f.current=()=>selected;f.state=()=>store.getSnapshot();f.controller=controller;f.navigate=view=>store.actions.navigate(view);f.openFormal=()=>store.actions.openBusiness({scope:'sales',section:'overview'});f.releaseIdentity=()=>{f.holdIdentity=false;releaseIdentity?.()};f.start=()=>controller.start();f.releaseCreate=()=>{f.holdCreate=false;releaseCreate?.()};f.reconnect=()=>controller.connect({});f.select=async id=>{selected=id;for(const l of listeners)l();await controller.followSession(id)};f.native=ready=>{f.nativeReady=ready;f.nativeNotify()};f.pending=async(scope='sales')=>{const requestId=crypto.randomUUID(),p={requestId,title:'待恢复业务会话',kind:'daily',scope,workspaceId:'workspace'};await api.reserve(p);return work.create({requestId,title:p.title,workspaceId:p.workspaceId,beforeOpen:async()=>{throw Error('controlled pending')}}).catch(()=>[...rows.values()].find(r=>r.requestId===requestId));};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><WorkbenchFrame {...props} runtimeSettings={{attach:()=>noop}} runtimeExtensions={{getSnapshot:()=>[],subscribe:()=>noop}} resolveExtensionText={String} setTheme={noop} sidebarRightFace={()=>undefined} mainSession={main} openNativePanel={noop} useStore={useStore} useSessions={useSessions} actions={store.actions} renderSlot={renderSlot} work={work} management={management} conversationSearch={generic} businessBuilder={controller} createBusinessRecordFlow={()=>controller.createRecordFlow({list:async()=>({schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:f.records?[record]:[]}),get:async input=>{f.recordReads=[...(f.recordReads||[]),input];return record}})} insertBusinessRecord={async(reference,sessionId,token)=>{f.recordInserts=(f.recordInserts||0)+1;await insertBusinessRecordInput(reference,sessionId,{switching:controller.ports.switching,isCurrent:()=>controller.getSnapshot().api===token,verify:async()=>record,state:{getSnapshot:()=>inputs.get(selected)||emptyInput,subscribe:fn=>{nativeListeners.add(fn);return()=>nativeListeners.delete(fn)}},insert:request=>{f.inserted=request;inputs.set(selected,{...emptyInput,draft:'record chip',draftRev:1,occurrences:[{...request.reference,invalid:false}]});f.nativeNotify();return true}})}} prepareHomeSession={async()=>{f.prepares++;return selected}} homeContextApi={generic} sendConversationMessage={noop} insertConversationCapabilities={noop}/></I18nProvider>);
void controller.connect({});
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-business-setup-frame-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;if(id===join(client,'MarketPage.tsx'))return "import React,{useEffect} from 'react';export const MarketPage=props=>{const f=window.frameFixture;f.marketRequest=props.catalogEntryRequest;if(props.catalogEntryRequest)(f.marketRequests??=[]).push(props.catalogEntryRequest);useEffect(()=>{f.marketMounts=(f.marketMounts||0)+1;return()=>{f.marketUnmounts=(f.marketUnmounts||0)+1}},[]);return null};";const source=await readFile(id,'utf8');const names=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>m[1]);return names.map(name=>'export const '+name+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderFrameFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output' in bundle)
 const output=bundle.output;script=output.find(item=>item.type==='chunk')!.code;styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[item.source]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-builder-frame',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale='zh-CN',startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="'+locale+'"><body><div id="root"></div></body></html>'}):r.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>{(window as any).frameStartup=value},startup);await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui}'+styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready')
 return page
}

for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 真实Frame配置返回精确内页、页面选择与原稿；入口不创建会话或任务',async t=>{
 const p=await mount(t,locale,{formal:true}),en=locale==='en'
 await p.setViewportSize({width,height:1000});await p.evaluate(()=>(window as any).frameFixture.openExact())
 const panel=()=>p.getByRole('region',{name:en?"Employees and capabilities":"员工与能力"})
 await panel().getByText(en?'Not assigned; configure later':'未设置，可稍后配置',{exact:true}).waitFor()
 await p.getByRole('navigation',{name:en?'Business pages':'业务页面'}).getByRole('button',{name:'复核页',exact:true}).click()
 await p.getByRole('heading',{level:2,name:'复核页',exact:true}).waitFor()
 const target=await p.evaluate(()=>(window as any).frameFixture.state().businessTarget)
 const actions=[[en?"Business employee directory":'业务员工目录','team'],[en?'Manage resources':'管理资料','resources'],[en?'Install skills':'安装技能','market'],[en?'Connection directory':'连接目录','market'],[en?'Configure CRM':'配置 CRM','market']]
 for(const [name,view] of actions){
  await panel().getByText(en?'Not assigned; configure later':'未设置，可稍后配置',{exact:true}).waitFor();await panel().locator('summary').click()
  const reads=await p.evaluate(()=>(window as any).frameFixture.pageReads)
  const control=panel().getByRole('button',{name,exact:true});await control.focus();await p.keyboard.press('Enter')
  await p.waitForFunction((view:string)=>(window as any).frameFixture.state().view===view,view)
  const back=p.getByRole('button',{name:en?'Back to 验收业务':'返回验收业务',exact:true});await back.waitFor();await back.focus();await p.keyboard.press('Enter')
  await p.getByRole('heading',{level:2,name:'复核页',exact:true}).waitFor()
  assert.deepEqual(await p.evaluate(()=>(window as any).frameFixture.state().businessTarget),target)
  assert.equal(await p.evaluate((reads:number)=>(window as any).frameFixture.pageReads>reads,reads),true)
  assert.equal(await back.count(),0);assert.equal(await p.getByRole('textbox',{name:'slot-probe',includeHidden:true}).inputValue(),'原生输入草稿')
 }
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[0,0,1,0])
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.setupReads.every((read:any)=>read.sameToken&&read.namespace.startsWith('teloa.business-builder/v1/personal-space/'))),true)
})
test('真实Frame连接代次与另一业务使旧返回入口失效，日常页不显示返回',async t=>{
 const p=await mount(t,'zh-CN',{formal:true})
 const open=async()=>{await p.evaluate(()=>(window as any).frameFixture.navigate('spaces'));await p.locator('article').getByRole('button',{name:/^验收业务/}).click();await p.evaluate(()=>(window as any).frameFixture.openExact());const panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('未设置，可稍后配置',{exact:true}).waitFor();await panel.locator('summary').click();await panel.getByRole('button',{name:"业务员工目录",exact:true}).click();await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor()}
 await open();await p.evaluate(()=>(window as any).frameFixture.reconnect());await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'})
 await open();await p.evaluate(()=>{const f=(window as any).frameFixture;f.otherBusiness()});await p.getByRole('heading',{level:1,name:'另一业务',exact:true}).waitFor();await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'});await p.evaluate(()=>(window as any).frameFixture.navigate('team'));await p.waitForFunction(()=>(window as any).frameFixture.state().view==='team');await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'});assert.equal(await p.getByRole('button',{name:'返回验收业务',exact:true}).count(),0)
 await open();await p.evaluate(()=>(window as any).frameFixture.navigate('messages'));await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'});assert.equal(await p.getByRole('button',{name:'返回验收业务',exact:true}).count(),0)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[0,0,1,0])
})

test('真实Frame消费→清请求→另一业务新请求保持单调serial并被实际MarketCatalog消费',async t=>{
 const p=await mount(t,'zh-CN',{formal:true});await p.evaluate(()=>(window as any).frameFixture.openExact())
 const configure=async()=>{const panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('未设置，可稍后配置',{exact:true}).waitFor();await panel.locator('summary').click();await panel.getByRole('button',{name:'配置 CRM',exact:true}).click();await p.getByRole('button',{name:/^返回/,exact:false}).waitFor();return p.evaluate(()=>(window as any).frameFixture.marketRequest)}
 const first=await configure();assert.equal(first.catalogId,'official-crm')
 await p.evaluate(()=>(window as any).frameFixture.otherBusiness());await p.getByRole('heading',{level:1,name:'另一业务',exact:true}).waitFor();await p.waitForFunction(()=>(window as any).frameFixture.marketRequest===undefined)
 const second=await configure();assert.equal(second.serial>first.serial,true)
 await p.evaluate(()=>(window as any).frameFixture.reconnect());await p.waitForFunction(()=>(window as any).frameFixture.marketRequest===undefined)
 await p.evaluate(()=>(window as any).frameFixture.navigate('spaces'));await p.locator('article').getByRole('button',{name:/^另一业务/}).click()
 const third=await configure();assert.equal(third.serial>second.serial,true)
 const m=mountMarket('MarketPage.tsx'),base={...marketProps({category:'connector'}),marketCatalogApi:{},managedMcpConnectionApi:{}}
 const settle=(patch:any)=>{m.render('TestCatalog',{...base,...patch});for(const effect of [...m.effects])effect();return m.render('TestCatalog',{...base,...patch})}
 assert.equal(nodes(settle({catalogEntryRequest:first})).find(n=>n.props.initialEntryId)?.props.initialEntryId,'official-crm')
 settle({catalogEntryRequest:undefined,forceCategory:{category:'connector',serial:2}})
 assert.equal(nodes(settle({catalogEntryRequest:{...second,catalogId:'next-crm'},forceCategory:{category:'connector',serial:3}})).find(n=>n.props.initialEntryId)?.props.initialEntryId,'next-crm')
 settle({catalogEntryRequest:undefined,forceCategory:{category:'connector',serial:4}})
 assert.equal(nodes(settle({catalogEntryRequest:{...third,catalogId:'identity-crm'},forceCategory:{category:'connector',serial:5}})).find(n=>n.props.initialEntryId)?.props.initialEntryId,'identity-crm')
})
test('真实Frame换API只重挂市场配置层，原生输入挂载和草稿保留',async t=>{
 const p=await mount(t,'zh-CN',{formal:true});const before=await p.evaluate(()=>{const f=(window as any).frameFixture;return {markets:f.marketMounts||0,unmounts:f.marketUnmounts||0}})
 await p.evaluate(()=>(window as any).frameFixture.reconnect());await p.waitForFunction((value:number)=>(window as any).frameFixture.marketMounts>value,before.markets)
 assert.equal(await p.evaluate((value:number)=>(window as any).frameFixture.marketUnmounts>value,before.unmounts),true)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.mounts,f.unmounts]}),[1,0]);assert.equal(await p.getByRole('textbox',{name:'slot-probe',includeHidden:true}).inputValue(),'原生输入草稿')
})
