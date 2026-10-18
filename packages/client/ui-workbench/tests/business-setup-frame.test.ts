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
import {WorkbenchFrame} from '${client}WorkbenchFrame.tsx';import {createBusinessWorkResultsApi} from '${client}business-work-results-api.ts';import {createWorkbenchStore} from '${client}store.ts';
import {BusinessBuilderController} from '${client}business-builder-controller.ts';import {BindingClient} from '${client}binding-client.ts';
import {insertBusinessRecordInput} from '${client}business-record-input.ts';
import {attachWorkbenchNavigationPersistence,captureWorkbenchNavigationState,loadWorkbenchNavigationState} from '${client}workbench-navigation-state.ts';
import {ConversationManagement} from '${client}conversation-management.ts';
import {createConversationPlanDirectory} from '${client}conversation-plans.ts';
import {createAssistantCompanionActivity} from '${client}assistant-companion-activity.ts';
import {createHomeContextApi} from '${client}home-native-controller.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale,revision:1},runtime={t:(k,p)=>translateMessage(locale,k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const startup=window.frameStartup||{};const f=window.frameFixture={...startup,mounts:0,unmounts:0,creates:0,prepares:0,calls:[],identityFails:false,holdIdentity:false,blocks:{},bindingReads:0};
const listeners=new Set(),main={getSnapshot:()=>selected,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)}};let selected=startup.sessionId,releaseIdentity,releaseCreate,releaseScopes;
const stamp='2026-09-29T00:00:00.000Z',space={id:'12345678-1234-4234-8234-123456789012',name:'验收工作空间',description:'',kind:'personal',version:1,createdAt:stamp,updatedAt:stamp};
const empty=[],byId={},rows=new Map(),reservations=new Map(),contexts=new Map(),nativeListeners=new Set(),inputs=new Map();let draft;const emptyInput={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]};f.nativeReady=startup.nativeReady!==false;f.nativeNotify=()=>{for(const listener of nativeListeners)listener()};f.input=value=>{inputs.set(selected,value);f.nativeNotify()};
const homeContextApi=createHomeContextApi(async(endpoint,p)=>{if(endpoint==='work-context/read')return contexts.get(p.sessionId)||null;if(endpoint!=='work-context/set')throw Error('Unexpected context endpoint');const row={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:p.expectedVersion+1,locked:false};contexts.set(p.sessionId,row);return row},sessionStorage);
const initial=createWorkbenchStore().create();initial.actions.openBusiness({scope:'sales',section:'data',objectType:'customer',id:'customer-one',recordReference:{scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64)}});
if(startup.marketCategory)initial.actions.rememberDirectory('market',{category:JSON.stringify({category:startup.marketCategory,mobileLayer:'list'})});
const restored=startup.reload?loadWorkbenchNavigationState(sessionStorage):startup.savedNavigation??(startup.restoreRecord?captureWorkbenchNavigationState(initial.getSnapshot()):undefined);
const store=createWorkbenchStore('light',restored).create();if(!restored)store.actions.navigate('spaces');attachWorkbenchNavigationPersistence(store,sessionStorage);
const useStore=selector=>selector(useSyncExternalStore(store.subscribe,store.getSnapshot)),useSessions=selector=>selector({byId});
const work=new BindingClient({list:async()=>[...rows.values()],read:async id=>rows.get(id),ensure:async id=>rows.get(id),isNativeChild:()=>false,catalog:async()=>({skills:[],tools:[]}),block:()=>{},current:()=>selected,open:id=>{selected=id;if(f.nativeOpenView==='messages')store.actions.openMessages('native');else if(f.nativeOpenView)store.actions.navigate(f.nativeOpenView);for(const l of listeners)l()},adopt:async id=>id,create:async p=>{const prior=[...rows.values()].find(row=>row.requestId===p.requestId);if(prior)return prior;f.creates++;if(f.holdCreate)await new Promise(r=>releaseCreate=r);const row={id:crypto.randomUUID(),ownerId:'self',title:p.title,version:1,status:'ready',sessionId:crypto.randomUUID(),requestedSessionId:'fixed',requestId:p.requestId,scopeIds:['general'],createdAt:stamp,...(p.workspaceId?{requestedWorkspaceId:p.workspaceId}:{})};rows.set(row.sessionId,row);byId[row.sessionId]={...row,displayTitle:row.title};if(f.loseCreate){f.loseCreate=false;throw Error('lost native create response')}return row}});
const api={recentDaily:async({scope})=>{f.recentReads=(f.recentReads||0)+1;if(f.failRecent)throw Error('recent unavailable');return [...reservations.values()].filter(b=>b.kind==='daily'&&b.scope===scope).at(-1)||null},bySession:async({sessionId})=>{f.bindingReads++;if(f.failBinding||f.failBindingAt===f.bindingReads)throw Error('binding transient');return [...reservations.values()].find(b=>b.sessionId===sessionId||b.requestId===rows.get(sessionId)?.requestId)||null},byRequest:async({requestId})=>reservations.get(requestId),reserve:async p=>{let b=reservations.get(p.requestId);if(!b){b={...p,...(p.kind==='builder'?{draftId:crypto.randomUUID()}:{}),createdAt:stamp,updatedAt:stamp};reservations.set(p.requestId,b);draft={id:b.draftId,ownerId:'self',scope:'sales',revision:1,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[],definitions:[],pages:[]}}}return b},bind:async p=>{const b={...reservations.get(p.requestId),sessionId:p.sessionId};reservations.set(p.requestId,b);return b},draft:async()=>draft,list:async()=>({items:[...reservations.values()].filter(b=>b.kind==='builder').map(binding=>({binding,draft:{id:binding.draftId,scope:'sales',title:'验收业务',revision:1,status:'draft',updatedAt:stamp}}))}),current:async input=>{f.calls.push('current');return f.formal?{...formal,scope:input.scope,manifest:{...formal.manifest,scope:input.scope,title:input.scope==='support'?'另一业务':'验收业务'}}:null},page:async input=>{f.pageReads=(f.pageReads||0)+1;if(input.pageId==='statistics')return dashboardPage(input.scope);return ({mode:'saved',scope:input.scope,configurationVersion:1,configurationHash:'a'.repeat(64),page:{kind:'records',definition:input.pageId==='review'?{...pageDefinition,id:'review',title:'复核页'}:pageDefinition,objectType:{...objectType,domain:input.scope},emptyState:'no-records'}})}};
// 看板与记录各用真实页面种类，不能再由记录页冒充统计看板。
const dashboardDefinition={id:'statistics',title:'客户统计',kind:'dashboard',dashboardId:'review'};
const dashboardPage=scope=>({mode:'saved',scope,configurationVersion:1,configurationHash:'a'.repeat(64),page:{kind:'dashboard',definition:dashboardDefinition,dashboard:{format:'teloa.business-dashboard/v1',id:'review',version:'1.0.0',domain:scope,title:'客户统计',widgets:['customer-count'],layout:[{widget:'customer-count',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false},widgets:[{format:'teloa.business-widget/v1',id:'customer-count',version:'1.0.0',domain:scope,title:'客户总数',kind:'metric',query:'select 0 as n',metric:{valueColumn:'n'}}],viewRefs:[],timeRange:'all',results:[{widgetId:'customer-count',definitionHash:'a'.repeat(64),computedAt:stamp,status:'ok',columns:[{name:'n',type:'number'}],rows:[[0]],rowCount:1,truncated:false,bytes:1,stale:false}]}});
const pageDefinition={id:'records',title:'客户记录',kind:'records',objectType:'customer',fields:['name'],allowCreate:false,allowEdit:false,allowArchive:false};const objectType={format:'teloa.business-object-type/v1',id:'customer',domain:'sales',version:'1.0.0',title:'客户',unit:'条',lead:'客户',sourceId:'local',fields:[{name:'name',label:'名称',from:'名称',type:'text',required:false}]};const formal={scope:'sales',version:1,hash:'a'.repeat(64),createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)},{kind:'dashboard',localId:'review',version:1,definitionHash:'a'.repeat(64)},{kind:'widget',localId:'customer-count',version:1,definitionHash:'a'.repeat(64)}],pages:[pageDefinition,{...pageDefinition,id:'review',title:'复核页'},dashboardDefinition],homePageId:'records'}};
const record={scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64),title:'客户甲',source:'local',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'',fields:[]};
const controller=new BusinessBuilderController({api,work,storage:localStorage,identity:async()=>{if(f.holdIdentity)await new Promise(r=>releaseIdentity=r);if(f.identityFails)throw Error('identity failed');return space.id},subscribeNative:listener=>{nativeListeners.add(listener);return()=>nativeListeners.delete(listener)},contextCall:async(endpoint,p)=>{if(endpoint==='work-context/read')return contexts.get(p.sessionId)||null;const value={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:1,locked:false};contexts.set(p.sessionId,value);return value},switching:{read:()=>({mainSessionId:selected,bindingSessionId:selected,bindingReady:f.nativeReady,input:!f.nativeReady?undefined:selected?(inputs.get(selected)||emptyInput):null,pendingSubmissions:[],monitor:undefined})},block:(id,reason)=>{if(reason)f.blocks[id]=reason;else delete f.blocks[id]},watch:()=>()=>{},id:()=>crypto.randomUUID()});
const management=new ConversationManagement(()=>[...rows.values()]);const managementState={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]}]};management.attach({state:()=>managementState,subscribe:()=>()=>{},summary:()=>({title:'会话',running:false,blank:false})});
const noop=()=>{},generic=new Proxy({},{get:(_,key)=>key==='subscribe'?()=>noop:key==='list'?async()=>[]:key==='recoveries'||key==='recoveryItems'?()=>[]:String(key).startsWith('pending')||String(key).includes('Recovery')||key==='recoveryMessage'?()=>undefined:async()=>[]});
const pageList={...generic,list:async()=>({items:[]})};
const apiNames='planApi marketContentApi marketCatalogApi skillSecretsApi githubSourceApi industryLoadApi industryKnowledgeApi industryDataSourceApi industryExecutionToolApi industryMcpConnectionApi industryPluginApi industryRoleApi industryTaskApi industryPlanApi skillInstallApi marketPluginInstallApi bundledExtensionsApi skillAvailabilityApi skillUpgradeApi resourceApi roleApi memoryApi dailyLogApi runtimeConfigApi taskApi projectApi taskRunApi securityActionApi taskMaterialApi taskTransitions pendingRequestApi roleLifecycle roleToolGrantApi handoffApi objectConversationApi groupApi groupAttachmentApi groupReactionApi groupRoutingApi businessLedgerApi businessDashboardApi businessCustomizationApi connectorProbeApi businessTaskApi pageCreateApi preparation nativeArtifacts artifactFileApi artifactApi'.split(' ');
const props=Object.fromEntries(apiNames.map(name=>[name,generic]));
props.planDraftApi={confirm:async()=>{throw Error('Unexpected plan draft confirmation')},onOpen:()=>()=>{},openDraft:()=>{throw Error('Unexpected plan draft navigation')}};
// 新目录端口只读空页；旧场景不允许意外读取或提交来源对象。
props.workAttentionApi={list:async()=>({schema:'teloa.work-attention/v1',items:[],incomplete:[]})};props.attentionBusinessApi=createBusinessWorkResultsApi(async()=>{throw Error('Unexpected work-attention source access')});props.workAttentionConnection={getSnapshot:()=>0,subscribe:()=>noop};
props.assistantActivity=createAssistantCompanionActivity();props.conversationPlans=createConversationPlanDirectory({list:async()=>[]});for(const name of ['industryDataSourceApi','industryExecutionToolApi','industryMcpConnectionApi','industryPluginApi'])props[name]=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]});
// 业务工作区读取真实群列表契约；通用数组桩不能代替 GroupApi 的分页返回。
props.groupApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]});
props.taskApi=new Proxy(generic,{get:(target,key)=>key==='attention'?async()=>({items:[]}):target[key]});
props.businessSpaceApi={current:async()=>space};props.businessScopeApi={list:async()=>{f.scopeReads=(f.scopeReads||0)+1;if(f.holdScopes)await new Promise(r=>releaseScopes=r);if(f.failScopes)throw Error('scope unavailable');f.scopesReturned=true;return [{scope:f.otherScope?'general':'sales',title:'验收业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0},{scope:'support',title:'另一业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}]}};
props.industryLoadApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>{f.industryRead=true;if(f.failIndustry)throw Error('industry unavailable');return []}:target[key]});f.releaseScopes=()=>{f.holdScopes=false;releaseScopes?.()};
props.businessLedgerApi=new Proxy(generic,{get:(t,k)=>k==='read'?async()=>{f.calls.push('legacy');throw Error('controlled unavailable')}:t[k]});
function Probe(){useEffect(()=>{f.mounts++;return()=>{f.unmounts++}},[]);return <textarea aria-label="slot-probe" defaultValue="原生输入草稿"/>}
const renderSlot=(name,props,options)=>name==='teloa.conversation'?props.content:name==='main'&&options?.entryKey==='conversation'?<Probe/>:null;
f.openExact=()=>store.actions.openBusiness({scope:'sales',section:'dashboards',dashboardId:'review'});f.openBusiness=target=>store.actions.openBusiness(target);f.otherBusiness=()=>store.actions.openBusiness({scope:'support',section:'overview'});f.setupReads=[];
props.managedMcpConnectionApi=generic;
props.createBusinessSetup=(namespace,token)=>({read:async input=>{f.setupReads.push({namespace,sameToken:token===controller.getSnapshot().api,input});return {scope:input.scope,configurationVersion:input.expectedVersion,configurationHash:input.expectedHash,observedAt:stamp,colleagues:{status:'observed',value:{responsibility:{roleId:null,availability:'none'},roles:[],selectedRole:null}},skills:{status:'observed',value:{declared:[],executionChecked:false}},knowledge:{status:'observed',value:{assigned:[],generalResourceCount:0,businessResourceCount:0}},connections:{status:'observed',value:{items:[{id:'one',catalogId:'official-crm',serverName:'CRM',status:'connected',updatedAt:stamp}],binding:'not-declared'}}}}});
f.remember=(id,patch)=>store.actions.rememberDirectory(id,patch);f.openCapabilities=()=>store.actions.openCapabilityCatalog();f.recheck=async()=>{await controller.followSession(undefined);await controller.followSession(selected)};f.current=()=>selected;f.state=()=>store.getSnapshot();f.controller=controller;f.navigate=view=>store.actions.navigate(view);f.openFormal=()=>store.actions.openBusiness({scope:'sales',section:'overview'});f.releaseIdentity=()=>{f.holdIdentity=false;releaseIdentity?.()};f.start=()=>controller.start();f.releaseCreate=()=>{f.holdCreate=false;releaseCreate?.()};f.reconnect=()=>controller.connect({});f.select=async id=>{selected=id;for(const l of listeners)l();await controller.followSession(id)};f.native=ready=>{f.nativeReady=ready;f.nativeNotify()};f.pending=async(scope='sales')=>{const requestId=crypto.randomUUID(),p={requestId,title:'待恢复业务会话',kind:'daily',scope,workspaceId:'workspace'};await api.reserve(p);return work.create({requestId,title:p.title,workspaceId:p.workspaceId,beforeOpen:async()=>{throw Error('controlled pending')}}).catch(()=>[...rows.values()].find(r=>r.requestId===requestId));};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><WorkbenchFrame {...props} navigationStorage={sessionStorage} runtimeSettings={{attach:()=>noop}} runtimeExtensions={{getSnapshot:()=>[],subscribe:()=>noop}} resolveExtensionText={String} setTheme={noop} sidebarRightFace={()=>undefined} mainSession={main} openNativePanel={noop} useStore={useStore} useSessions={useSessions} actions={store.actions} renderSlot={renderSlot} work={work} management={management} conversationSearch={generic} businessBuilder={controller} createBusinessRecordFlow={()=>controller.createRecordFlow({list:async()=>({schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:f.records?[record]:[]}),get:async input=>{f.recordReads=[...(f.recordReads||[]),input];return record}})} insertBusinessRecord={async(reference,sessionId,token)=>{f.recordInserts=(f.recordInserts||0)+1;await insertBusinessRecordInput(reference,sessionId,{switching:controller.ports.switching,isCurrent:()=>controller.getSnapshot().api===token,verify:async()=>record,state:{getSnapshot:()=>inputs.get(selected)||emptyInput,subscribe:fn=>{nativeListeners.add(fn);return()=>nativeListeners.delete(fn)}},insert:request=>{f.inserted=request;inputs.set(selected,{...emptyInput,draft:'record chip',draftRev:1,occurrences:[{...request.reference,invalid:false}]});f.nativeNotify();return true}})}} prepareHomeSession={async()=>{f.prepares++;return selected}} homeContextApi={homeContextApi} sendConversationMessage={noop} insertConversationCapabilities={noop}/></I18nProvider>);
void controller.connect({});
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-business-setup-frame-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;if(id===join(client,'MarketPage.tsx'))return "import React,{useEffect} from 'react';export const MarketPage=props=>{const f=window.frameFixture;f.marketRequest=props.catalogEntryRequest;if(!f.marketMountCategory)f.marketMountCategory=props.navigationState?.category;f.marketProps={navigationState:props.navigationState,forceCategory:props.forceCategory,completeCategory:props.onForceCategoryHandled,managed:props.managedMcpConnectionApi,inCenter:props.inCapabilityCenter};if(props.catalogEntryRequest)(f.marketRequests??=[]).push(props.catalogEntryRequest);useEffect(()=>{f.marketMounts=(f.marketMounts||0)+1;return()=>{f.marketUnmounts=(f.marketUnmounts||0)+1}},[]);return null};";const source=await readFile(id,'utf8');const names=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>m[1]);return names.map(name=>'export const '+name+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderFrameFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output' in bundle)
 const output=bundle.output;script=output.find(item=>item.type==='chunk')!.code;styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[item.source]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-builder-frame',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale='zh-CN',startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[];let failFrame!:(error:Error)=>void;const frameError=new Promise<never>((_resolve,reject)=>{failFrame=reject});void frameError.catch(()=>{});page.on('pageerror',(e:Error)=>{errors.push(e.message);failFrame(e)});t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="'+locale+'"><body><div id="root"></div></body></html>'}):r.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>{(window as any).frameStartup=value},startup);await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui}'+styles});await page.addScriptTag({content:script})
 await Promise.race([page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main')!==null),frameError])
 return page
}

async function openSetup(page:any,en=false){
 const panel=page.getByRole('region',{name:en?'Employees and capabilities':'员工与能力'})
 if(!await panel.isVisible())await page.getByRole('button',{name:en?'Business settings':'业务设置',exact:true}).click()
 await page.getByRole('dialog',{name:en?'View setup details':'查看配置详情',exact:true}).waitFor()
 await panel.getByText(en?'Not assigned; configure later':'未设置，可稍后配置',{exact:true}).waitFor()
}

async function reloadFrame(page:any,startup:Record<string,unknown>){
 await page.addInitScript((value:Record<string,unknown>)=>{(window as any).frameStartup=value},{...startup,reload:true})
 await page.reload();await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui}'+styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main')!==null)
}

test('真实Frame刷新精确业务看板不受无关扩展目录失败阻塞，本人回首页后刷新仍留首页',async t=>{
 const startup={formal:true,failIndustry:true},p=await mount(t,'zh-CN',startup)
 await p.evaluate(()=>(window as any).frameFixture.openExact())
 await p.getByRole('heading',{level:2,name:'客户统计',exact:true}).waitFor()
 const target=await p.evaluate(()=>(window as any).frameFixture.state().businessTarget)
 await reloadFrame(p,startup)
 await p.getByRole('heading',{level:2,name:'客户统计',exact:true}).waitFor()
 assert.deepEqual(await p.evaluate(()=>(window as any).frameFixture.state().businessTarget),target)
 await p.getByRole('navigation',{name:'页面位置',exact:true}).getByRole('button',{name:'业务',exact:true}).click()
 await p.locator('article').getByRole('button',{name:/^验收业务/}).waitFor()
 await reloadFrame(p,startup)
 await p.locator('article').getByRole('button',{name:/^验收业务/}).waitFor()
 assert.equal(await p.getByRole('heading',{level:2,name:'客户统计',exact:true}).isVisible(),false)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares]}),[0,0])
})

test('真实Frame刷新对象清单下钻及固定记录保留对象类型、筛选和原版本，不产生工作',async t=>{
 const startup={formal:true,failIndustry:true},p=await mount(t,'zh-CN',startup)
 const targets=[{scope:'sales',section:'data',objectType:'customer',match:{field:'name',value:'甲:乙／丙'}},{scope:'sales',section:'data',objectType:'customer',id:'customer-one',recordReference:{scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64)}}]
 for(const target of targets){
  await p.evaluate((target:unknown)=>(window as any).frameFixture.openBusiness(target),target)
  await p.locator('h1').filter({hasText:'验收业务'}).waitFor()
  if(target.recordReference)await p.getByRole('region',{name:'客户甲',exact:true}).waitFor()
  await reloadFrame(p,startup)
  await p.locator('h1').filter({hasText:'验收业务'}).waitFor().catch(async(error:Error)=>{throw Error(error.message+'\n'+JSON.stringify(await p.evaluate(()=>({state:(window as any).frameFixture.state(),body:document.body.innerText}))))})
  assert.deepEqual(await p.evaluate(()=>(window as any).frameFixture.state().businessTarget),target)
  if(target.recordReference){await p.getByRole('region',{name:'客户甲',exact:true}).waitFor();assert.deepEqual(await p.evaluate(()=>(window as any).frameFixture.recordReads),[{scope:'sales',type:'customer',id:'customer-one',version:3}])}
 }
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares]}),[0,0])
})

const legacyBusinessNavigation={schema:'teloa.workbench-navigation/v1',view:'spaces',messageMode:'native',capabilityMode:'catalog',marketMode:'catalog',selected:{},directories:{spaces:{category:'sales:dashboards:review'}},detail:{open:false,target:null}}
test('真实Frame兼容无首页标记的旧精确看板记录',async t=>{
 const p=await mount(t,'zh-CN',{formal:true,failIndustry:true,savedNavigation:legacyBusinessNavigation})
 await p.getByRole('heading',{level:2,name:'客户统计',exact:true}).waitFor()
 assert.deepEqual(await p.evaluate(()=>(window as any).frameFixture.state().businessTarget),{scope:'sales',section:'dashboards',dashboardId:'review'})
})

test('真实Frame正式业务页签刷新恢复原pageId，切业务不借用另一范围的页签',async t=>{
 const startup={formal:true},p=await mount(t,'zh-CN',startup)
 await p.evaluate(()=>(window as any).frameFixture.openExact())
 await p.getByRole('navigation',{name:'业务页面',exact:true}).getByRole('button',{name:'业务内容',exact:true}).click()
 await p.getByRole('navigation',{name:'业务页面',exact:true}).getByRole('button',{name:'复核页',exact:true}).click()
 await p.getByRole('heading',{level:2,name:'复核页',exact:true}).waitFor()
 await reloadFrame(p,startup)
 await p.getByRole('heading',{level:2,name:'复核页',exact:true}).waitFor()
 assert.equal(await p.getByRole('navigation',{name:'业务页面',exact:true}).getByRole('button',{name:'复核页',exact:true}).getAttribute('aria-current'),'page')
 assert.deepEqual(await p.evaluate(()=>(window as any).frameFixture.state().navigationDirectories.spaces.businessPage),{scope:'sales',pageId:'review'})
 await p.evaluate(()=>(window as any).frameFixture.openBusiness({scope:'support',section:'data'}))
 await p.getByRole('heading',{level:2,name:'客户记录',exact:true}).waitFor()
})

for(const mode of ['failed','missing'])test('真实Frame恢复业务内页仍核对本人目录 '+mode,async t=>{
 const p=await mount(t,'zh-CN',{formal:true,savedNavigation:{...legacyBusinessNavigation,directories:{spaces:{...legacyBusinessNavigation.directories.spaces,businessHome:false}}},failScopes:mode==='failed',otherScope:mode==='missing'})
 if(mode==='failed')await p.getByRole('alert').first().waitFor()
 else await p.waitForFunction(()=>{const state=(window as any).frameFixture.state();return state.businessTarget.scope==='general'&&state.navigationDirectories.spaces?.businessHome===true})
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.calls,f.recordReads||[],f.creates,f.prepares]}),[[],[],0,0])
})

for(const locale of ['zh-CN','en'])for(const width of [1000,1400])test(locale+'/'+width+' 真实Frame配置返回精确内页、页面选择与原稿；入口不创建会话或任务',async t=>{
 const p=await mount(t,locale,{formal:true}),en=locale==='en'
 await p.setViewportSize({width,height:1000});await p.evaluate(()=>(window as any).frameFixture.openExact())
 const panel=()=>p.getByRole('region',{name:en?"Employees and capabilities":"员工与能力"})
 await p.getByRole('navigation',{name:en?'Business pages':'业务页面'}).getByRole('button',{name:en?'Records':'业务内容',exact:true}).click()
 await p.getByRole('navigation',{name:en?'Business pages':'业务页面'}).getByRole('button',{name:'复核页',exact:true}).click()
 await p.getByRole('heading',{level:2,name:'复核页',exact:true}).waitFor()
 const target=await p.evaluate(()=>(window as any).frameFixture.state().businessTarget)
 const actions=[[en?"Business employee directory":'业务员工目录','team',en?'Responsible employee':'负责人'],[en?'Manage resources':'管理资料','resources',en?'Resources':'资料'],[en?'Install skills':'安装技能','market',en?'Skills':'技能'],[en?'Connection directory':'连接目录','market',en?'Local connections':'本机连接'],[en?'Configure CRM':'配置 CRM','market',en?'Local connections':'本机连接']]
 for(const [name,view,section] of actions){
  await openSetup(p,en);await panel().locator('summary').filter({has:p.getByText(section,{exact:true})}).click()
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
 const open=async()=>{await p.evaluate(()=>(window as any).frameFixture.navigate('spaces'));await p.locator('article').getByRole('button',{name:/^验收业务/}).click();await p.evaluate(()=>(window as any).frameFixture.openExact());const panel=p.getByRole('region',{name:"员工与能力"});await openSetup(p);await panel.locator('summary').filter({has:p.getByText('负责人',{exact:true})}).click();await panel.getByRole('button',{name:"业务员工目录",exact:true}).click();await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor()}
 await open();await p.evaluate(()=>(window as any).frameFixture.reconnect());await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'})
 await open();await p.evaluate(()=>{const f=(window as any).frameFixture;f.otherBusiness()});await p.getByRole('heading',{level:1,name:'另一业务',exact:true}).waitFor();await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'});await p.evaluate(()=>(window as any).frameFixture.navigate('team'));await p.waitForFunction(()=>(window as any).frameFixture.state().view==='team');await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'});assert.equal(await p.getByRole('button',{name:'返回验收业务',exact:true}).count(),0)
 await open();await p.evaluate(()=>(window as any).frameFixture.navigate('messages'));await p.getByRole('button',{name:'返回验收业务',exact:true}).waitFor({state:'detached'});assert.equal(await p.getByRole('button',{name:'返回验收业务',exact:true}).count(),0)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[0,0,1,0])
})

test('真实Frame消费→清请求→另一业务新请求保持单调serial并被实际MarketCatalog消费',async t=>{
 const p=await mount(t,'zh-CN',{formal:true});await p.evaluate(()=>(window as any).frameFixture.openExact())
 const configure=async()=>{
  const panel=p.getByRole('region',{name:"员工与能力"})
  await openSetup(p);await panel.locator('summary').filter({has:p.getByText('本机连接',{exact:true})}).click();await panel.getByRole('button',{name:'配置 CRM',exact:true}).click();await p.getByRole('button',{name:/^返回/,exact:false}).waitFor();return p.evaluate(()=>(window as any).frameFixture.marketRequest)
 }
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
test('真实Frame市场入口：左栏市场与应用并列打开同一市场，父层只有市场面包屑，我的能力归属市场，应用目录取得受管连接',async t=>{
 const p=await mount(t,'zh-CN',{formal:true}),nav=p.getByRole('navigation',{name:'主导航',exact:true})
 const market=nav.getByRole('button',{name:'市场',exact:true}),apps=nav.getByRole('button',{name:'应用',exact:true})
 assert.equal(await nav.getByRole('button',{name:'能力中心',exact:true}).count(),0)
 await market.click();await p.waitForFunction(()=>(window as any).frameFixture.state().view==='market')
 const crumbs=p.getByRole('navigation',{name:'页面位置',exact:true})
 assert.equal(await crumbs.getByRole('button',{name:'市场',exact:true}).getAttribute('aria-current'),'page')
 assert.equal(await p.getByRole('heading',{name:'能力中心',exact:true}).count(),0,'父层不再套能力中心标题')
 assert.equal(await p.getByRole('button',{name:/^(我的|发现)$/}).count(),0,'父层不再有我的／发现切换')
 assert.equal(await market.getAttribute('aria-current'),'page');assert.equal(await apps.getAttribute('aria-current'),null)
 let props=await p.evaluate(()=>{const v=(window as any).frameFixture.marketProps;return {category:v.navigationState.category,managed:!!v.managed,inCenter:v.inCenter}})
 assert.deepEqual(props,{category:'home',managed:true,inCenter:true},'默认进入 AI 员工目录，应用目录有受管连接')
 const before=await p.evaluate(()=>(window as any).frameFixture.state().marketCategoryRequest.serial)
 await apps.click()
 await p.waitForFunction((serial:number)=>{const f=(window as any).frameFixture;return f.state().marketCategoryRequest.serial>serial&&f.marketProps.forceCategory?.category==='apps'},before)
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.state().view),'market','应用复用同一市场视图，不另建页面')
 // 市场页把所在类别写回目录后，左栏高亮切到应用
 await p.evaluate(()=>(window as any).frameFixture.remember('market',{category:JSON.stringify({category:'apps',mobileLayer:'list'})}))
 await p.waitForFunction(()=>document.querySelector('nav[aria-label="主导航"] button[aria-current="page"]')?.textContent?.includes('应用'))
 assert.equal(await market.getAttribute('aria-current'),null)
 // 在应用里点「市场」回到 AI 员工目录，而不是停在应用视图
 const appsSerial=await p.evaluate(()=>(window as any).frameFixture.state().marketCategoryRequest.serial)
 await market.click();await p.waitForFunction((serial:number)=>{const request=(window as any).frameFixture.state().marketCategoryRequest;return request.serial>serial&&request.category==='home'},appsSerial)
 await p.evaluate(()=>(window as any).frameFixture.remember('market',{category:JSON.stringify({category:'home',mobileLayer:'category'})}))
 // 原「我的能力」入口：独立页已退出，落到同一市场的「已添加」页签，面包屑与左栏都只有市场
 const mineSerial=await p.evaluate(()=>(window as any).frameFixture.state().marketCategoryRequest.serial)
 await p.evaluate(()=>(window as any).frameFixture.openCapabilities())
 await p.waitForFunction((serial:number)=>{const f=(window as any).frameFixture;return f.state().view==='market'&&f.state().marketCategoryRequest.serial>serial&&f.state().marketCategoryRequest.category==='resources'},mineSerial)
 assert.equal(await crumbs.getByRole('button',{name:'我的能力',exact:true}).count(),0)
 assert.equal(await crumbs.getByRole('button',{name:'市场',exact:true}).getAttribute('aria-current'),'page')
 assert.equal(await market.getAttribute('aria-current'),'page','我的资源归属市场')
 await crumbs.getByRole('button',{name:'市场',exact:true}).click()
 await p.waitForFunction(()=>(window as any).frameFixture.state().view==='market')
 const shot=process.env.TELOA_CENTER_EVIDENCE;if(shot)await p.screenshot({path:shot+'/真实Frame-市场入口.png'})
})
for(const [saved,entry] of [['industry','teams'],['skill','home'],['connector','apps'],['teams','teams']] as const)test('真实Frame启动恢复旧市场类别 '+saved+' 只落回方案 B 主目录 '+entry+'，并改写存下的类别',async t=>{
 const p=await mount(t,'zh-CN',{formal:true,restoreRecord:true,marketCategory:saved})
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.marketMountCategory),entry,'首次挂载即为方案 B 主目录')
 await p.waitForFunction((entry:string)=>JSON.parse((window as any).frameFixture.state().navigationDirectories.market?.category??'{}').category===entry,entry)
})


test('真实Frame只派发未消费类别请求：默认0保留冷恢复，业务API重挂不重放已确认应用请求',async t=>{
 const p=await mount(t,'zh-CN',{formal:true,marketCategory:'apps'})
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.marketProps.forceCategory),undefined)
 const nav=p.getByRole('navigation',{name:'主导航',exact:true})
 await nav.getByRole('button',{name:'应用',exact:true}).click()
 await p.waitForFunction(()=>(window as any).frameFixture.marketProps.forceCategory?.category==='apps')
 const original=await p.evaluate(()=>{const f=(window as any).frameFixture,serial=f.marketProps.forceCategory.serial;f.marketProps.completeCategory(serial);f.remember('market',{category:JSON.stringify({category:'apps',mobileLayer:'list'}),query:'原应用搜索'});return {serial,mounts:f.marketMounts}})
 await p.waitForFunction(()=>(window as any).frameFixture.marketProps.forceCategory===undefined)
 await p.evaluate(()=>(window as any).frameFixture.reconnect())
 await p.waitForFunction((count:number)=>(window as any).frameFixture.marketMounts>count,original.mounts)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return {force:f.marketProps.forceCategory,category:f.marketProps.navigationState.category,query:f.marketProps.navigationState.query}}),{force:undefined,category:'apps',query:'原应用搜索'})
 await nav.getByRole('button',{name:'应用',exact:true}).click()
 await p.waitForFunction((serial:number)=>(window as any).frameFixture.marketProps.forceCategory?.serial>serial,original.serial)
})
