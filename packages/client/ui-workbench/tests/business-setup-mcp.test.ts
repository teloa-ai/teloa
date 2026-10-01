import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error Playwright helper is an existing JavaScript fixture without declarations.
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
// 真实 Frame/store/controller/BindingClient/Panel。无关产品页在组件边界隔离，slot 是挂载计数探针，不冒充官方编辑器。
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
const entry=`
import React,{useEffect,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import {WorkbenchFrame} from '${client}WorkbenchFrame.tsx';import {createWorkbenchStore} from '${client}store.ts';
import {BusinessBuilderController} from '${client}business-builder-controller.ts';import {BindingClient} from '${client}binding-client.ts';
import {createManagedMcpConnectionApi} from '${client}mcp-connections-api.ts';import {createGenerationGuardedCall} from '${client}business-setup-navigation.ts';
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
const controller=new BusinessBuilderController({api,work,storage:localStorage,identity:async()=>{if(f.holdIdentity)await new Promise(r=>releaseIdentity=r);if(f.identityFails)throw Error('identity failed');return f.personalSpaceId??space.id},subscribeNative:listener=>{nativeListeners.add(listener);return()=>nativeListeners.delete(listener)},contextCall:async(endpoint,p)=>{if(endpoint==='work-context/read')return contexts.get(p.sessionId)||null;const value={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:1,locked:false};contexts.set(p.sessionId,value);return value},switching:{read:()=>({mainSessionId:selected,bindingSessionId:selected,bindingReady:f.nativeReady,input:!f.nativeReady?undefined:selected?(inputs.get(selected)||emptyInput):null,pendingSubmissions:[],monitor:undefined})},block:(id,reason)=>{if(reason)f.blocks[id]=reason;else delete f.blocks[id]},watch:()=>()=>{},id:()=>crypto.randomUUID()});
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
f.generation='one';f.mcpCalls=[];f.mcpApis=[];
const mcpId='11111111-1111-4111-8111-111111111111',mcpRecord=()=>({id:mcpId,catalogId:'official-crm',serverName:'crm',status:'connected',createdAt:stamp,updatedAt:stamp,tools:[{name:'read',fullName:'mcp.read',readOnly:true}]});
f.mcpRows=startup.mcpMode==='connected'?[mcpRecord()]:[];
props.createBusinessMcpConnection=(namespace,token)=>{const api=createManagedMcpConnectionApi(createGenerationGuardedCall(()=>f.generation,async(method,payload)=>{f.mcpCalls.push([method,payload,f.generation]);if(method==='mcp-connections/list')return {items:f.mcpRows};if(method==='mcp-connections/add'){const value={...mcpRecord(),status:'saved'};if(f.holdAdd)await new Promise(resolve=>f.releaseAdd=resolve);return value}if(method==='mcp-connections/oauth-start')return {authorizationUrl:'https://example.invalid/authorize?state=old'};if(method==='mcp-connections/oauth-status')return {status:'pending-oauth'};return mcpRecord()},()=>{const now=controller.getSnapshot();return now.status==='ready'&&now.namespace===namespace&&now.api===token}));f.mcpApis.push(api);return api};
f.changeMcpIdentity=async(options={})=>{f.mcpRows=[];if(!options.sameGeneration)f.generation='two';if(options.newOwner)f.personalSpaceId='22345678-1234-4234-8234-123456789012';await controller.connect({})};
props.createBusinessSetup=(namespace,token)=>({read:async input=>{f.setupReads.push({namespace,sameToken:token===controller.getSnapshot().api,input});return {scope:input.scope,configurationVersion:input.expectedVersion,configurationHash:input.expectedHash,observedAt:stamp,colleagues:{status:'observed',value:{responsibility:{roleId:null,availability:'none'},roles:[],selectedRole:null}},skills:{status:'observed',value:{declared:[],executionChecked:false}},knowledge:{status:'observed',value:{assigned:[],generalResourceCount:0,businessResourceCount:0}},connections:{status:'observed',value:{items:[{id:'one',catalogId:'official-crm',serverName:'CRM',status:'connected',updatedAt:stamp}],binding:'not-declared'}}}}});
f.recheck=async()=>{await controller.followSession(undefined);await controller.followSession(selected)};f.current=()=>selected;f.state=()=>store.getSnapshot();f.controller=controller;f.navigate=view=>store.actions.navigate(view);f.openFormal=()=>store.actions.openBusiness({scope:'sales',section:'overview'});f.releaseIdentity=()=>{f.holdIdentity=false;releaseIdentity?.()};f.start=()=>controller.start();f.releaseCreate=()=>{f.holdCreate=false;releaseCreate?.()};f.reconnect=()=>controller.connect({});f.select=async id=>{selected=id;for(const l of listeners)l();await controller.followSession(id)};f.native=ready=>{f.nativeReady=ready;f.nativeNotify()};f.pending=async(scope='sales')=>{const requestId=crypto.randomUUID(),p={requestId,title:'待恢复业务会话',kind:'daily',scope,workspaceId:'workspace'};await api.reserve(p);return work.create({requestId,title:p.title,workspaceId:p.workspaceId,beforeOpen:async()=>{throw Error('controlled pending')}}).catch(()=>[...rows.values()].find(r=>r.requestId===requestId));};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><WorkbenchFrame {...props} runtimeSettings={{attach:()=>noop}} runtimeExtensions={{getSnapshot:()=>[],subscribe:()=>noop}} resolveExtensionText={String} setTheme={noop} sidebarRightFace={()=>undefined} mainSession={main} openNativePanel={noop} useStore={useStore} useSessions={useSessions} actions={store.actions} renderSlot={renderSlot} work={work} management={management} conversationSearch={generic} businessBuilder={controller} createBusinessRecordFlow={()=>controller.createRecordFlow({list:async()=>({schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:f.records?[record]:[]}),get:async input=>{f.recordReads=[...(f.recordReads||[]),input];return record}})} insertBusinessRecord={async(reference,sessionId,token)=>{f.recordInserts=(f.recordInserts||0)+1;await insertBusinessRecordInput(reference,sessionId,{switching:controller.ports.switching,isCurrent:()=>controller.getSnapshot().api===token,verify:async()=>record,state:{getSnapshot:()=>inputs.get(selected)||emptyInput,subscribe:fn=>{nativeListeners.add(fn);return()=>nativeListeners.delete(fn)}},insert:request=>{f.inserted=request;inputs.set(selected,{...emptyInput,draft:'record chip',draftRev:1,occurrences:[{...request.reference,invalid:false}]});f.nativeNotify();return true}})}} prepareHomeSession={async()=>{f.prepares++;return selected}} homeContextApi={generic} sendConversationMessage={noop} insertConversationCapabilities={noop}/></I18nProvider>);
void controller.connect({});
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-business-setup-mcp-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{
if(id===join(client,'MarketCatalogSection.tsx')){const source=await readFile(id,'utf8');return source.replace('export function MarketCatalogSection(','function OriginalMarketCatalogSection(')+`
export const MarketCatalogSection=props=>{const mode=window.frameFixture.mcpMode;const auth=mode==='oauth'?{kind:'oauth',supported:true,requiresUserClientId:false,scopes:[]}:mode==='secret'?{kind:'secret',vars:[{target:'env',envVarName:'CRM_TOKEN',label:{'zh-CN':'令牌',en:'Token'}}]}:{kind:'none'};const entry={id:'official-crm',kind:'connector',connector:{title:{'zh-CN':'测试连接',en:'Test connection'},serverName:'crm',auth},compatibility:{status:'needs-configuration'}};return <section aria-label="受控官方目录"><button type="button" onClick={()=>props.openConnection('official-crm',entry)}>打开连接配置</button></section>};`}
if(!stubbed.has(id))return;const source=await readFile(id,'utf8');const names=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>m[1]);return names.map(name=>'export const '+name+'=()=>null;').join('\n')
}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderFrameFixture',formats:['iife']}}})
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


async function connection(t:any,mode:string){
 const p=await mount(t,'zh-CN',{formal:true,mcpMode:mode});await p.evaluate(()=>(window as any).frameFixture.openExact())
 const panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('未设置，可稍后配置',{exact:true}).waitFor();await panel.locator('summary').click();await panel.getByRole('button',{name:'配置 CRM',exact:true}).click();await p.getByRole('button',{name:'打开连接配置',exact:true}).click();await p.getByRole('heading',{name:'测试连接',exact:true}).waitFor();return p
}
for(const mode of ['connected','secret','oauth'])test('真实McpConnectionView '+mode+' 跨身份配置状态清空，原API旧实例拒绝，新视图重读',async t=>{
 const p=await connection(t,mode)
 if(mode==='connected')await p.getByRole('button',{name:'断开',exact:true}).waitFor()
 if(mode==='secret')await p.locator('input[type=password]').fill('fixture-only-secret')
 if(mode==='oauth'){await p.getByRole('button',{name:'去授权',exact:true}).click();await p.locator('a[href^="https://example.invalid/authorize"]').waitFor()}
 const before=await p.evaluate(()=>{const f=(window as any).frameFixture;f.previousMcpApi=f.mcpApis.at(-1);return f.mcpCalls.length})
 await p.evaluate(()=>(window as any).frameFixture.changeMcpIdentity())
 await p.getByRole('heading',{name:'测试连接',exact:true}).waitFor({state:'detached'})
 assert.equal(await p.locator('a[href^="https://example.invalid/authorize"]').count(),0)
 assert.equal(await p.locator('input[type=password]').count(),0)
 assert.equal(await p.evaluate(async()=>{try{await(window as any).frameFixture.previousMcpApi.list();return false}catch{return true}}),true)
 await p.getByRole('button',{name:'打开连接配置',exact:true}).click();await p.getByRole('heading',{name:'测试连接',exact:true}).waitFor()
 if(mode==='secret')assert.equal(await p.locator('input[type=password]').inputValue(),'')
 assert.equal(await p.locator('a[href^="https://example.invalid/authorize"]').count(),0)
 assert.equal(await p.evaluate((before:number)=>(window as any).frameFixture.mcpCalls.slice(before).some((call:any)=>call[0]==='mcp-connections/list'&&call[2]==='two'),before),true)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.mounts,f.unmounts]}),[1,0]);assert.equal(await p.getByRole('textbox',{name:'slot-probe',includeHidden:true}).inputValue(),'原生输入草稿')
})
test('真实MCP多步骤连接在add迟到时换身份，旧回包不得继续connect或读取新本人',async t=>{
 const p=await connection(t,'secret');await p.locator('input[type=password]').fill('fixture-only-secret');await p.evaluate(()=>(window as any).frameFixture.holdAdd=true)
 await p.getByRole('button',{name:'测试连接',exact:true}).click();await p.waitForFunction(()=>typeof(window as any).frameFixture.releaseAdd==='function')
 await p.evaluate(()=>(window as any).frameFixture.changeMcpIdentity());await p.getByRole('heading',{name:'测试连接',exact:true}).waitFor({state:'detached'})
 await p.evaluate(async()=>{(window as any).frameFixture.releaseAdd();await Promise.resolve();await Promise.resolve()})
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.mcpCalls.some((call:any)=>call[0]==='mcp-connections/connect')),false)
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.mcpCalls.some((call:any)=>call[0]==='mcp-connections/get'&&call[2]==='two')),false)
})

test('同连接代次换本人namespace与API：真实旧连接视图退出，旧实例拒绝，新本人重新读取',async t=>{
 const p=await connection(t,'connected');await p.getByRole('button',{name:'断开',exact:true}).waitFor()
 const before=await p.evaluate(()=>{const f=(window as any).frameFixture;f.previousMcpApi=f.mcpApis.at(-1);return {namespace:f.controller.getSnapshot().namespace,calls:f.mcpCalls.length}})
 await p.evaluate(()=>(window as any).frameFixture.changeMcpIdentity({sameGeneration:true,newOwner:true}));await p.getByRole('heading',{name:'测试连接',exact:true}).waitFor({state:'detached'})
 assert.equal(await p.evaluate((namespace:string)=>(window as any).frameFixture.controller.getSnapshot().namespace!==namespace,before.namespace),true)
 assert.equal(await p.evaluate(()=>(window as any).frameFixture.generation),'one')
 assert.equal(await p.evaluate(async()=>{try{await(window as any).frameFixture.previousMcpApi.oauthStart('11111111-1111-4111-8111-111111111111');return false}catch{return true}}),true)
 await p.getByRole('button',{name:'打开连接配置',exact:true}).click();await p.getByRole('heading',{name:'测试连接',exact:true}).waitFor();await p.getByRole('button',{name:'测试连接',exact:true}).waitFor()
 assert.equal(await p.evaluate((before:number)=>(window as any).frameFixture.mcpCalls.slice(before).filter((call:any)=>call[0]==='mcp-connections/list').length>0,before.calls),true)
 assert.equal(await p.evaluate((before:number)=>(window as any).frameFixture.mcpCalls.slice(before).some((call:any)=>call[0]==='mcp-connections/oauth-start'),before.calls),false)
 assert.deepEqual(await p.evaluate(()=>{const f=(window as any).frameFixture;return [f.mounts,f.unmounts]}),[1,0])
})
