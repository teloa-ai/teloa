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
const api={recentDaily:async({scope})=>{f.recentReads=(f.recentReads||0)+1;if(f.failRecent)throw Error('recent unavailable');return [...reservations.values()].filter(b=>b.kind==='daily'&&b.scope===scope).at(-1)||null},bySession:async({sessionId})=>{f.bindingReads++;if(f.failBinding||f.failBindingAt===f.bindingReads)throw Error('binding transient');return [...reservations.values()].find(b=>b.sessionId===sessionId||b.requestId===rows.get(sessionId)?.requestId)||null},byRequest:async({requestId})=>reservations.get(requestId),reserve:async p=>{let b=reservations.get(p.requestId);if(!b){b={...p,...(p.kind==='builder'?{draftId:crypto.randomUUID()}:{}),createdAt:stamp,updatedAt:stamp};reservations.set(p.requestId,b);draft={id:b.draftId,ownerId:'self',scope:'sales',revision:1,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[],definitions:[],pages:[]}}}return b},bind:async p=>{const b={...reservations.get(p.requestId),sessionId:p.sessionId};reservations.set(p.requestId,b);return b},draft:async()=>draft,list:async()=>({items:[...reservations.values()].filter(b=>b.kind==='builder').map(binding=>({binding,draft:{id:binding.draftId,scope:'sales',title:'验收业务',revision:1,status:'draft',updatedAt:stamp}}))}),current:async()=>{f.calls.push('current');return f.formal?formal:null},page:async()=>({mode:'saved',scope:'sales',configurationVersion:1,configurationHash:'a'.repeat(64),page:{kind:'records',definition:pageDefinition,objectType,emptyState:'no-records'}})};
const pageDefinition={id:'records',title:'客户记录',kind:'records',objectType:'customer',fields:['name'],allowCreate:false,allowEdit:false,allowArchive:false};const objectType={format:'teloa.business-object-type/v1',id:'customer',domain:'sales',version:'1.0.0',title:'客户',unit:'条',lead:'客户',sourceId:'local',fields:[{name:'name',label:'名称',from:'名称',type:'text',required:false}]};const formal={scope:'sales',version:1,hash:'a'.repeat(64),createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)}],pages:[pageDefinition],homePageId:'records'}};
const record={scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64),title:'客户甲',source:'local',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'',fields:[]};
const controller=new BusinessBuilderController({api,work,storage:localStorage,identity:async()=>{if(f.holdIdentity)await new Promise(r=>releaseIdentity=r);if(f.identityFails)throw Error('identity failed');return space.id},subscribeNative:listener=>{nativeListeners.add(listener);return()=>nativeListeners.delete(listener)},contextCall:async(endpoint,p)=>{if(endpoint==='work-context/read')return contexts.get(p.sessionId)||null;const value={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:1,locked:false};contexts.set(p.sessionId,value);return value},switching:{read:()=>({mainSessionId:selected,bindingSessionId:selected,bindingReady:f.nativeReady,input:!f.nativeReady?undefined:selected?(inputs.get(selected)||emptyInput):null,pendingSubmissions:[],monitor:undefined})},block:(id,reason)=>{if(reason)f.blocks[id]=reason;else delete f.blocks[id]},watch:()=>()=>{},id:()=>crypto.randomUUID()});
const management=new ConversationManagement(()=>[...rows.values()]);const managementState={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]}]};management.attach({state:()=>managementState,subscribe:()=>()=>{},summary:()=>({title:'会话',running:false,blank:false})});
const noop=()=>{},generic=new Proxy({},{get:(_,key)=>key==='subscribe'?()=>noop:key==='list'?async()=>[]:key==='recoveries'||key==='recoveryItems'?()=>[]:String(key).startsWith('pending')||String(key).includes('Recovery')||key==='recoveryMessage'?()=>undefined:async()=>[]});
const pageList={...generic,list:async()=>({items:[]})};
const apiNames='planApi marketContentApi marketCatalogApi skillSecretsApi githubSourceApi industryLoadApi industryKnowledgeApi industryDataSourceApi industryExecutionToolApi industryMcpConnectionApi industryPluginApi industryRoleApi industryTaskApi industryPlanApi skillInstallApi marketPluginInstallApi bundledExtensionsApi skillAvailabilityApi skillUpgradeApi resourceApi roleApi memoryApi dailyLogApi runtimeConfigApi taskApi projectApi taskRunApi securityActionApi taskMaterialApi taskTransitions pendingRequestApi roleLifecycle roleToolGrantApi handoffApi objectConversationApi groupApi groupAttachmentApi groupReactionApi groupRoutingApi businessLedgerApi businessDashboardApi businessCustomizationApi connectorProbeApi businessTaskApi pageCreateApi preparation nativeArtifacts artifactFileApi artifactApi'.split(' ');
const props=Object.fromEntries(apiNames.map(name=>[name,generic]));for(const name of ['industryDataSourceApi','industryExecutionToolApi','industryMcpConnectionApi','industryPluginApi'])props[name]=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]});
props.businessSpaceApi={current:async()=>space};props.businessScopeApi={list:async()=>{f.scopeReads=(f.scopeReads||0)+1;if(f.holdScopes)await new Promise(r=>releaseScopes=r);if(f.failScopes)throw Error('scope unavailable');f.scopesReturned=true;return [{scope:f.otherScope?'general':'sales',title:'验收业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}]}};
props.industryLoadApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>{f.industryRead=true;if(f.failIndustry)throw Error('industry unavailable');return []}:target[key]});f.releaseScopes=()=>{f.holdScopes=false;releaseScopes?.()};
props.businessLedgerApi=new Proxy(generic,{get:(t,k)=>k==='read'?async()=>{f.calls.push('legacy');throw Error('controlled unavailable')}:t[k]});
function Probe(){useEffect(()=>{f.mounts++;return()=>{f.unmounts++}},[]);return <textarea aria-label="slot-probe" defaultValue="原生输入草稿"/>}
const renderSlot=(name,props,options)=>name==='teloa.conversation'?props.content:name==='main'&&options?.entryKey==='conversation'?<Probe/>:null;
f.recheck=async()=>{await controller.followSession(undefined);await controller.followSession(selected)};f.current=()=>selected;f.state=()=>store.getSnapshot();f.controller=controller;f.navigate=view=>store.actions.navigate(view);f.openFormal=()=>store.actions.openBusiness({scope:'sales',section:'overview'});f.releaseIdentity=()=>{f.holdIdentity=false;releaseIdentity?.()};f.start=()=>controller.start();f.releaseCreate=()=>{f.holdCreate=false;releaseCreate?.()};f.reconnect=()=>controller.connect({});f.select=async id=>{selected=id;for(const l of listeners)l();await controller.followSession(id)};f.native=ready=>{f.nativeReady=ready;f.nativeNotify()};f.pending=async(scope='sales')=>{const requestId=crypto.randomUUID(),p={requestId,title:'待恢复业务会话',kind:'daily',scope,workspaceId:'workspace'};await api.reserve(p);return work.create({requestId,title:p.title,workspaceId:p.workspaceId,beforeOpen:async()=>{throw Error('controlled pending')}}).catch(()=>[...rows.values()].find(r=>r.requestId===requestId));};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><WorkbenchFrame {...props} runtimeSettings={{attach:()=>noop}} runtimeExtensions={{getSnapshot:()=>[],subscribe:()=>noop}} resolveExtensionText={String} setTheme={noop} sidebarRightFace={()=>undefined} mainSession={main} openNativePanel={noop} useStore={useStore} useSessions={useSessions} actions={store.actions} renderSlot={renderSlot} work={work} management={management} conversationSearch={generic} businessBuilder={controller} createBusinessRecordFlow={()=>controller.createRecordFlow({list:async()=>({schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:f.records?[record]:[]}),get:async input=>{f.recordReads=[...(f.recordReads||[]),input];return record}})} insertBusinessRecord={async(reference,sessionId,token)=>{f.recordInserts=(f.recordInserts||0)+1;await insertBusinessRecordInput(reference,sessionId,{switching:controller.ports.switching,isCurrent:()=>controller.getSnapshot().api===token,verify:async()=>record,state:{getSnapshot:()=>inputs.get(selected)||emptyInput,subscribe:fn=>{nativeListeners.add(fn);return()=>nativeListeners.delete(fn)}},insert:request=>{f.inserted=request;inputs.set(selected,{...emptyInput,draft:'record chip',draftRev:1,occurrences:[{...request.reference,invalid:false}]});f.nativeNotify();return true}})}} prepareHomeSession={async()=>{f.prepares++;return selected}} homeContextApi={generic} sendConversationMessage={noop} insertConversationCapabilities={noop}/></I18nProvider>);
void controller.connect({});
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-builder-frame-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;const source=await readFile(id,'utf8');const names=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>m[1]);return names.map(name=>'export const '+name+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderFrameFixture',formats:['iife']}}})
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
for(const locale of ['zh-CN','en'])test(locale+' 真实Frame新用户新建仅一会话，宽窄预览切换保持唯一slot和原稿',async t=>{
 const page=await mount(t,locale),en=locale==='en'
 await page.getByRole('button',{name:en?'New business':'新建业务',exact:true}).click();await page.getByRole('tab',{name:en?'Preview':'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[1,0,1,0])
 await page.screenshot({path:'/tmp/teloa-builder-frame/'+locale+'-1400.png',fullPage:true})
 await page.setViewportSize({width:390,height:900});await page.getByRole('tab',{name:en?'Preview':'预览',exact:true}).click();await page.getByRole('button',{name:en?'Save business':'保存业务',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:'/tmp/teloa-builder-frame/'+locale+'-390.png',fullPage:true})
 await page.getByRole('tab',{name:en?'Conversation':'对话',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.mounts,f.unmounts]}),[1,0])
})
test('实际Frame正式入口重连/身份失败先gate，未核对前不能调用旧台账；显式重试后恢复',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdIdentity=true;void f.reconnect();f.openFormal()})
 await page.getByRole('status').filter({hasText:'正在读取最新预览'}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.calls),[])
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.identityFails=true;f.releaseIdentity()})
 await page.getByRole('alert').waitFor();assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.calls),[])
 await page.evaluate(()=>{(window as any).frameFixture.identityFails=false})
 await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.calls.includes('current'))
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.calls.filter((x:string)=>x==='current').length),1)
})
test('实际Frame用户离开到任务后，迟到创建不得抢回导航或另建general',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).frameFixture.holdCreate=true})
 await page.getByRole('button',{name:'新建业务',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('tasks');f.releaseCreate()})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().flow.getSnapshot().phase==='idle')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.state().view,f.creates,f.prepares,f.mounts,f.unmounts]}),['tasks',1,0,1,0])
})


test('R1 实际Frame同连接绑定失败点击重试后第二次读取并解除业务输入阻止',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'新建业务',exact:true}).click();await page.getByRole('tab',{name:'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 const before=await page.evaluate(async()=>{const f=(window as any).frameFixture;f.failBinding=true;await f.recheck();return f.bindingReads})
 await page.locator('#teloa-main').getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>{const f=(window as any).frameFixture;return !!f.blocks[f.current()]}),true)
 await page.evaluate(()=>{(window as any).frameFixture.failBinding=false})
 await page.locator('#teloa-main').getByRole('button',{name:'重试',exact:true}).click()
 await page.waitForFunction((reads:number)=>{const f=(window as any).frameFixture;return f.bindingReads>=reads+1&&f.controller.getSnapshot().error===null&&!f.blocks[f.current()]},before)
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
})

test('R1 实际Frame已有main在身份读取和失败时保持输入阻止，显式恢复核对后才解除',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'新建业务',exact:true}).click();await page.getByRole('tab',{name:'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 assert.equal(await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdIdentity=true;void f.reconnect();return !!f.blocks[f.current()]}),true)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.identityFails=true;f.releaseIdentity()})
 await page.locator('#teloa-main').getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>{const f=(window as any).frameFixture;return !!f.blocks[f.current()]}),true)
 await page.evaluate(()=>{(window as any).frameFixture.identityFails=false})
 await page.locator('#teloa-main').getByRole('button',{name:'重试',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().checkedSessionId===f.current()&&!f.blocks[f.current()]})
})


test('Task3 原生未就绪禁用新建，官方就绪通知后可用；不预备general会话',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).frameFixture.native(false)})
 const button=page.getByRole('button',{name:'新建业务',exact:true});await page.waitForFunction(()=>!(window as any).frameFixture.controller.getSnapshot().nativeReady)
 assert.equal(await button.isEnabled(),false)
 await page.evaluate(()=>{(window as any).frameFixture.native(true)})
 await button.click();await page.getByRole('tab',{name:'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.prepares),0)
})

test('Task3 create受理丢回包：首页可显式恢复原builder，不需手动刷新目录或再建',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).frameFixture.loseCreate=true})
 await page.getByRole('button',{name:'新建业务',exact:true}).click()
 await page.getByRole('button',{name:'恢复搭建会话',exact:true}).click()
 await page.getByRole('tab',{name:'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[1,0,1,0])
})

for(const locale of ['zh-CN','en'])test('Task3 '+locale+'正式业务继续/另建与全局pending恢复，390/1400唯一输入不重挂',async t=>{
 const page=await mount(t,locale),en=locale==='en'
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.openFormal()})
 const talk=()=>page.getByRole('button',{name:en?'Ask or delegate':'询问或交办',exact:true})
 await talk().click();await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().sessionKind==='daily'})
 const first=await page.evaluate(()=>(window as any).frameFixture.current())
 await page.evaluate(()=>{(window as any).frameFixture.navigate('spaces')});await page.locator('article').getByRole('button',{name:/^验收业务/}).click();await talk().click()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),first)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 await page.evaluate(()=>{(window as any).frameFixture.navigate('spaces')});await page.locator('article').getByRole('button',{name:/^验收业务/}).click();await talk().waitFor()
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
 await page.screenshot({path:'/tmp/teloa-builder-frame/daily-'+locale+'-1400.png',fullPage:true})
 await page.setViewportSize({width:390,height:900})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
 await page.screenshot({path:'/tmp/teloa-builder-frame/daily-'+locale+'-390.png',fullPage:true})
 await page.locator('#teloa-main').getByRole('button',{name:en?'New work session':'新建工作会话',exact:true}).click()
 await page.waitForFunction((id:string)=>(window as any).frameFixture.current()!==id,first)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),2)
 const pending=await page.evaluate(async()=>{const f=(window as any).frameFixture,row=await f.pending('support');await f.select(row.sessionId);f.navigate('home');return row.sessionId})
 await page.getByRole('button',{name:en?'Restore business conversation':'恢复业务会话',exact:true}).click()
 await page.waitForFunction((id:string)=>{const f=(window as any).frameFixture;return f.current()===id&&!f.blocks[id]},pending)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[3,0,1,0])
})


test('Task3 键盘确认保留原稿；确认期间的新编辑不能借旧批准另建',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.openFormal()})
 await page.getByRole('button',{name:'询问或交办',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().sessionKind==='daily')
 const first=await page.evaluate(()=>{const f=(window as any).frameFixture;f.input({draft:'保留的原稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]});f.navigate('spaces');return f.current()})
 await page.locator('article').getByRole('button',{name:/^验收业务/}).click()
 await page.locator('#teloa-main').getByRole('button',{name:'新建工作会话',exact:true}).click()
 const confirm=page.getByRole('dialog').getByRole('button',{name:'保留草稿并新开',exact:true})
 await confirm.waitFor()
 await page.evaluate(()=>{(window as any).frameFixture.input({draft:'确认前的新编辑',draftRev:2,phase:'plain',attachmentIds:[],occurrences:[],queue:[]})})
 await confirm.focus();await page.keyboard.press('Enter')
 await page.locator('#teloa-main').getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),first)
 await page.locator('#teloa-main').getByRole('button',{name:'新建工作会话',exact:true}).click()
 await confirm.waitFor();await confirm.focus();await page.keyboard.press('Enter')
 await page.waitForFunction((id:string)=>(window as any).frameFixture.current()!==id,first)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[2,0,1,0])
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
})


test('Task3 最近会话读取失败可在正式页重试，错误不当空值另建',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.failRecent=true;f.openFormal()})
 await page.getByRole('button',{name:'询问或交办',exact:true}).click()
 await page.locator('#teloa-main').getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),0)
 await page.evaluate(()=>{(window as any).frameFixture.failRecent=false})
 await page.locator('#teloa-main').getByRole('button',{name:'重试',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().sessionKind==='daily')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares]}),[1,0])
})


for(const previous of ['none','success','failed'])test('R1 全局daily第二次归属读取失败仅保留当前控制器重试 previous='+previous,async t=>{
 const page=await mount(t)
 if(previous!=='none'){
  await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.openFormal()})
  if(previous==='failed')await page.evaluate(()=>{(window as any).frameFixture.failRecent=true})
  await page.getByRole('button',{name:'询问或交办',exact:true}).click()
  if(previous==='failed'){await page.locator('#teloa-main').getByRole('alert').waitFor();await page.evaluate(()=>{(window as any).frameFixture.failRecent=false})}
  else await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().sessionKind==='daily')
 }
 await page.evaluate(async()=>{const f=(window as any).frameFixture,row=await f.pending('support');await f.select(row.sessionId);f.navigate('home')})
 await page.getByRole('button',{name:'恢复业务会话',exact:true}).waitFor()
 const before=await page.evaluate(async()=>{const f=(window as any).frameFixture;f.failBindingAt=f.bindingReads+2;await f.controller.retry();return {reads:f.bindingReads,creates:f.creates,recent:f.recentReads||0,current:f.current()}})
 await page.waitForFunction(()=>{const f=(window as any).frameFixture,s=f.controller.getSnapshot();return s.sessionKind==='daily'&&!!s.error&&!!s.daily.getSnapshot().error&&f.blocks[f.current()]==='checking'})
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),1)
 assert.equal(await page.locator('#teloa-main').getByRole('button',{name:'重试',exact:true}).count(),1)
 await page.locator('#teloa-main').getByRole('button',{name:'重试',exact:true}).click()
 await page.waitForFunction((reads:number)=>{const f=(window as any).frameFixture,s=f.controller.getSnapshot();return f.bindingReads>=reads+2&&s.error===null&&s.daily.getSnapshot().phase==='pending'},before.reads)
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return {creates:f.creates,recent:f.recentReads||0,current:f.current()}}),{creates:before.creates,recent:before.recent,current:before.current})
 await page.getByRole('button',{name:'恢复业务会话',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return !f.blocks[f.current()]})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.controller.getSnapshot().daily.getSnapshot().binding.scope),'support')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.prepares),0)
})


test('R2 刷新保留原稿后从业务首页继续当前builder不弹无意义切换确认',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'新建业务',exact:true}).click()
 await page.getByRole('tab',{name:'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 const before=await page.evaluate(async()=>{const f=(window as any).frameFixture;f.input({draft:'已核对unknown后保留的原稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]});await f.reconnect();f.navigate('spaces');return f.current()})
 await page.getByRole('region',{name:'继续搭建',exact:true}).getByRole('button').filter({hasText:'验收业务'}).click()
 await page.getByRole('tab',{name:'预览',exact:true,includeHidden:true}).waitFor({state:'attached'})
 assert.equal(await page.getByRole('dialog',{name:'当前会话有待发送内容',exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),before)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[1,0,1,0])
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
})

for(const locale of ['zh-CN','en'])test(locale+' 记录交办只准备引用；原稿保留并通过确认在新daily带入，不直接发送',async t=>{
 const page=await mount(t,locale),en=locale==='en'
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.records=true;f.openFormal()})
 await page.getByRole('button',{name:/客户甲/}).click()
 await page.getByRole('button',{name:en?'Delegate this record':'交办此记录',exact:true}).click()
 const insert=()=>page.getByRole('button',{name:en?'Insert record reference':'带入记录引用',exact:true})
 await insert().waitFor()
 for(const width of [1400,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/teloa-record-dispatch/prepared-'+locale+'-'+width+'.png',fullPage:true})}
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.recordInserts||0),0)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.input({draft:'保留原稿',draftRev:2,phase:'plain',attachmentIds:[],occurrences:[],queue:[]})})
 await insert().click()
 await page.getByRole('region',{name:en?'Selected record':'已选记录',exact:true}).getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.inserted),undefined)
 await page.getByRole('button',{name:en?'Use a new conversation':'在新会话处理',exact:true}).click()
 await page.getByRole('dialog').getByRole('button',{name:en?'Keep this conversation':'继续原会话',exact:true}).click()
 await insert().waitFor();assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 await page.getByRole('button',{name:en?'Use a new conversation':'在新会话处理',exact:true}).click()
 await page.getByRole('dialog').getByRole('button',{name:en?'Keep draft and open new':'保留草稿并新开',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.creates===2)
 await insert().click()
 await insert().waitFor({state:'detached'})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.inserted.reference.ref),'[[teloa-business-record:sales|customer|customer-one|3|'+ 'b'.repeat(64)+']]')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.prepares),0)
})

test('记录页复用当前daily：原生openSession先切messages仍保留固定引用准备条',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.records=true;f.openFormal()})
 await page.getByRole('button',{name:'询问或交办',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().sessionKind==='daily'&&f.state().view==='messages'})
 const session=await page.evaluate(()=>{const f=(window as any).frameFixture;f.nativeOpenView='messages';f.navigate('spaces');return f.current()})
 await page.locator('article').getByRole('button',{name:/^验收业务/}).click()
 await page.getByRole('button',{name:/客户甲/}).click()
 await page.getByRole('button',{name:'交办此记录',exact:true}).click()
 await page.getByRole('region',{name:'已选记录',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),session)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 await page.getByRole('button',{name:'带入记录引用',exact:true}).click()
 assert.match(await page.evaluate(()=>(window as any).frameFixture.inserted.reference.ref),/customer-one\|3\|/)
})
test('原生打开返回期间用户已去其它页面，不展示准备条或抢回daily',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.records=true;f.openFormal()})
 await page.getByRole('button',{name:'询问或交办',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().sessionKind==='daily'&&f.state().view==='messages'})
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nativeOpenView='tasks';f.navigate('spaces')})
 await page.locator('article').getByRole('button',{name:/^验收业务/}).click()
 await page.getByRole('button',{name:/客户甲/}).click()
 await page.getByRole('button',{name:'交办此记录',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='tasks')
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().checkedSessionId===(window as any).frameFixture.current())
 assert.equal(await page.getByRole('region',{name:'已选记录',exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.recordInserts||0),0)
})

for(const failIndustry of [false,true])test('R3 刷新固定来源保留 Run 会话，以本人目录核验恢复'+(failIndustry?'，不依赖行业目录成功':'，订阅迟到目录'),async t=>{
 const page=await mount(t,'zh-CN',{restoreRecord:true,formal:true,sessionId:'task-run-source',nativeReady:false,holdScopes:true,failIndustry})
 await page.waitForFunction(()=>(window as any).frameFixture.industryRead)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.calls),[])
 await page.evaluate(()=>(window as any).frameFixture.releaseScopes())
 await page.getByRole('region',{name:'客户甲',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return {session:f.current(),nativeReady:f.controller.getSnapshot().nativeReady,creates:f.creates,prepares:f.prepares,reference:f.state().businessTarget.recordReference,reads:f.recordReads}}),{session:'task-run-source',nativeReady:false,creates:0,prepares:0,reference:{scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64)},reads:[{scope:'sales',type:'customer',id:'customer-one',version:3}]})
})

for(const mode of ['failed','missing'])test('R3 固定来源不能越过本人目录'+mode,async t=>{
 const page=await mount(t,'zh-CN',{restoreRecord:true,formal:true,sessionId:'task-run-source',nativeReady:false,failScopes:mode==='failed',otherScope:mode==='missing'})
 if(mode==='failed')await page.getByRole('alert').first().waitFor()
 else await page.waitForFunction(()=>(window as any).frameFixture.state().businessTarget.scope==='general')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.calls,f.recordReads||[],f.current(),f.creates,f.prepares]}),[[],[],'task-run-source',0,0])
})
