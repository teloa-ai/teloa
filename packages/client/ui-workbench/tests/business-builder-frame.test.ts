import {businessMenuItem} from './business-header-menu.ts'
import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import type {BusinessTarget} from '../src/client/business-preview.ts'
// @ts-expect-error Playwright helper is an existing JavaScript fixture without declarations.
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
// 真实 Frame/store/controller/BindingClient/Panel。无关产品页在组件边界隔离，slot 是挂载计数探针，不冒充官方编辑器。
const isolated=['WorkDirectory','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
const entry=`
import React,{useEffect,useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import {WorkbenchFrame} from '${client}WorkbenchFrame.tsx';import {createBusinessWorkResultsApi} from '${client}business-work-results-api.ts';import {createWorkbenchStore} from '${client}store.ts';
import {BusinessBuilderController} from '${client}business-builder-controller.ts';import {BindingClient} from '${client}binding-client.ts';
import {insertAssistantVoiceDraft} from '${client}home-native-capabilities.ts';
import {insertBusinessRecordInput} from '${client}business-record-input.ts';
import {captureWorkbenchNavigationState} from '${client}workbench-navigation-state.ts';
import {ConversationManagement} from '${client}conversation-management.ts';
import {RoleConversationIdentity} from '${client}RoleConversationIdentity.tsx';
import {createConversationPlanDirectory} from '${client}conversation-plans.ts';
import {createAssistantCompanionActivity} from '${client}assistant-companion-activity.ts';
import {createHomeContextApi} from '${client}home-native-controller.ts';
import {createProjectContextApi} from '${client}project-context-api.ts';
import {createProjectRuntimeApi} from '${client}project-runtime-api.ts';
import {PromptPreparation} from '${client}prompt-preparation.ts';
import {TaskRunConversationTitle} from '${client}TaskRunChatPresentation.tsx';
import {TaskRunChatPresentationDirectory} from '${client}task-run-chat-presentation.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale,revision:1},runtime={t:(k,p)=>translateMessage(locale,k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const startup=window.frameStartup||{};const f=window.frameFixture={...startup,mounts:0,unmounts:0,creates:0,prepares:0,calls:[],identityFails:false,holdIdentity:false,blocks:{},bindingReads:0};
const listeners=new Set(),main={getSnapshot:()=>selected,subscribe:l=>{listeners.add(l);return()=>listeners.delete(l)}};let nativeNavigation=new AbortController();const beginNativeNavigation=()=>{nativeNavigation.abort();nativeNavigation=new AbortController();return nativeNavigation.signal};f.holdRestore=()=>{const signal=nativeNavigation.signal;f.releaseRestore=()=>{if(!signal.aborted){selected='restored-original';for(const l of listeners)l();void work.select(selected)}}};let selected=startup.sessionId,releaseIdentity,releaseCreate,releaseScopes,releaseAssistantOpen;
const stamp='2026-09-29T00:00:00.000Z',space={id:'12345678-1234-4234-8234-123456789012',name:'验收工作空间',description:'',kind:'personal',version:1,createdAt:stamp,updatedAt:stamp};
const empty=[],byId={},rows=new Map(),reservations=new Map(),contexts=new Map(),nativeListeners=new Set(),inputs=new Map();let draft;const emptyInput={draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]};f.nativeReady=startup.nativeReady!==false;f.nativeNotify=()=>{for(const listener of nativeListeners)listener()};f.input=value=>{inputs.set(selected,value);f.nativeNotify()};
const homeContextApi=createHomeContextApi(async(endpoint,p)=>{if(endpoint==='work-context/read'){if(f.holdVoiceContext&&p.sessionId==='assistant-original'){f.voicePreparePending=true;await new Promise(resolve=>{(f.voicePrepareResolvers??=[]).push(resolve);f.releaseVoicePrepare=()=>{f.holdVoiceContext=false;f.voicePrepareResolvers.splice(0).forEach(resolve=>resolve())}})}return contexts.get(p.sessionId)||null;}if(endpoint!=='work-context/set')throw Error('Unexpected context endpoint');if(f.loseAssistantContext){f.loseAssistantContext=false;throw Error('lost context response')}const row={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:p.expectedVersion+1,locked:false};contexts.set(p.sessionId,row);return row},sessionStorage);
const initial=createWorkbenchStore().create();initial.actions.openBusiness({scope:'sales',section:'data',objectType:'customer',id:'customer-one',recordReference:{scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64)}});
const store=createWorkbenchStore('light',startup.restoreRecord?captureWorkbenchNavigationState(initial.getSnapshot()):undefined).create();if(!startup.restoreRecord)store.actions.navigate(startup.ensureHandshake?'home':'spaces');
const useStore=selector=>selector(useSyncExternalStore(store.subscribe,store.getSnapshot)),useSessions=selector=>selector({byId});
const work=new BindingClient({list:async()=>{if(f.holdVoiceDirectory){f.voicePreparePending=true;await new Promise(resolve=>{f.releaseVoicePrepare=()=>{f.holdVoiceDirectory=false;resolve()}})}return [...rows.values()]},read:async id=>{if(f.holdAssistantOpen){f.assistantReading=true;await new Promise(r=>releaseAssistantOpen=r)}return rows.get(id)},ensure:async id=>{if(f.holdEnsure){f.ensureStarted=true;await new Promise(resolve=>{f.releaseEnsure=()=>{f.holdEnsure=false;resolve()}})}return rows.get(id)},isNativeChild:()=>false,catalog:async()=>({skills:[],tools:[]}),block:()=>{},current:()=>selected,open:id=>{selected=id;if(f.nativeOpenView==='messages')store.actions.openMessages('native');else if(f.nativeOpenView)store.actions.navigate(f.nativeOpenView);for(const l of listeners)l()},adopt:async id=>id,assistant:async p=>{if(f.holdAssistantOpen){f.assistantReading=true;await new Promise(r=>releaseAssistantOpen=r)}let row=[...rows.values()].find(r=>r.purpose==='assistant'||r.title==='Teloa 小松鼠助手');if(!row){f.creates++;if(f.holdCreate)await new Promise(r=>releaseCreate=r);const id=crypto.randomUUID();row={id:crypto.randomUUID(),ownerId:'self',title:'Teloa 小松鼠助手',purpose:'assistant',version:1,status:'ready',sessionId:id,requestedSessionId:id,requestId:crypto.randomUUID(),scopeIds:['general'],createdAt:stamp,...(p.workspaceId?{requestedWorkspaceId:p.workspaceId}:{})};rows.set(id,row)}else{row={...row,purpose:'assistant'};rows.set(row.sessionId,row)}byId[row.sessionId]={...row,displayTitle:row.title};if(f.loseCreate){f.loseCreate=false;throw Error('lost native create response')}return row},create:async p=>{const prior=[...rows.values()].find(row=>row.requestId===p.requestId);if(prior)return prior;f.creates++;if(f.holdCreate)await new Promise(r=>releaseCreate=r);const row={id:crypto.randomUUID(),ownerId:'self',title:p.title||'工作会话',version:1,status:'ready',sessionId:crypto.randomUUID(),requestedSessionId:'fixed',requestId:p.requestId,scopeIds:['general'],createdAt:stamp,...(p.workspaceId?{requestedWorkspaceId:p.workspaceId}:{})};rows.set(row.sessionId,row);byId[row.sessionId]={...row,displayTitle:row.title};if(f.loseCreate){f.loseCreate=false;throw Error('lost native create response')}return row}});
if(startup.ensureHandshake){const row={id:crypto.randomUUID(),ownerId:'self',title:'首页待用会话',version:1,status:'ready',sessionId:selected,requestedSessionId:selected,scopeIds:['general'],createdAt:stamp};rows.set(selected,row);byId[selected]={...row,displayTitle:row.title};void work.select(selected)}
const api={recentDaily:async({scope})=>{f.recentReads=(f.recentReads||0)+1;if(f.failRecent)throw Error('recent unavailable');return [...reservations.values()].filter(b=>b.kind==='daily'&&b.scope===scope).at(-1)||null},bySession:async({sessionId})=>{f.bindingReads++;if(startup.ensureHandshake&&work.getSnapshot().status!=='ready')throw Object.assign(Error('not yet bound'),{code:'teloa/not-bound'});if(f.failBinding||f.failBindingAt===f.bindingReads)throw Error('binding transient');return [...reservations.values()].find(b=>b.sessionId===sessionId||b.requestId===rows.get(sessionId)?.requestId)||null},byRequest:async({requestId})=>reservations.get(requestId),reserve:async p=>{let b=reservations.get(p.requestId);if(!b){b={...p,...(p.kind==='builder'?{draftId:crypto.randomUUID()}:{}),createdAt:stamp,updatedAt:stamp};reservations.set(p.requestId,b);draft={id:b.draftId,ownerId:'self',scope:'sales',revision:1,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[],definitions:[],pages:[]}}}return b},bind:async p=>{const b={...reservations.get(p.requestId),sessionId:p.sessionId};reservations.set(p.requestId,b);return b},draft:async()=>draft,list:async()=>({items:[...reservations.values()].filter(b=>b.kind==='builder').map(binding=>({binding,draft:{id:binding.draftId,scope:'sales',title:'验收业务',revision:1,status:'draft',updatedAt:stamp}}))}),current:async()=>{f.calls.push('current');return f.formal?formal:null},page:async()=>({mode:'saved',scope:'sales',configurationVersion:1,configurationHash:'a'.repeat(64),page:{kind:'records',definition:pageDefinition,objectType,emptyState:'no-records'}})};
const pageDefinition={id:'records',title:'客户记录',kind:'records',objectType:'customer',fields:['name'],allowCreate:false,allowEdit:false,allowArchive:false};const objectType={format:'teloa.business-object-type/v1',id:'customer',domain:'sales',version:'1.0.0',title:'客户',unit:'条',lead:'客户',sourceId:'local',fields:[{name:'name',label:'名称',from:'名称',type:'text',required:false}]};const formal={scope:'sales',version:1,hash:'a'.repeat(64),createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'验收业务',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'customer',version:1,definitionHash:'a'.repeat(64)}],pages:[pageDefinition],homePageId:'records'}};
const record={scope:'sales',type:'customer',id:'customer-one',version:3,snapshotHash:'b'.repeat(64),title:'客户甲',source:'local',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'',fields:[]};
const controller=new BusinessBuilderController({api,work,storage:localStorage,identity:async()=>{if(f.holdIdentity)await new Promise(r=>releaseIdentity=r);if(f.identityFails)throw Error('identity failed');return space.id},subscribeNative:listener=>{nativeListeners.add(listener);return()=>nativeListeners.delete(listener)},contextCall:async(endpoint,p)=>{if(endpoint==='work-context/read')return contexts.get(p.sessionId)||null;const value={sessionId:p.sessionId,scopeId:p.scopeId,roleId:p.roleId,version:1,locked:false};contexts.set(p.sessionId,value);return value},switching:{read:()=>({mainSessionId:selected,bindingSessionId:startup.ensureHandshake?work.getSnapshot().sessionId:selected,bindingReady:f.nativeReady&&(!startup.ensureHandshake||work.getSnapshot().status==='ready'),input:!f.nativeReady?undefined:selected?(inputs.get(selected)||emptyInput):null,pendingSubmissions:[],monitor:undefined})},block:(id,reason)=>{if(reason)f.blocks[id]=reason;else delete f.blocks[id]},watch:()=>()=>{},id:()=>crypto.randomUUID()});
const management=new ConversationManagement(()=>[...rows.values()]);const managementState={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]}]};management.attach({state:()=>managementState,subscribe:()=>()=>{},summary:()=>({title:'会话',running:false,blank:false})});
const noop=()=>{},generic=new Proxy({},{get:(_,key)=>key==='subscribe'?()=>noop:key==='list'?async()=>[]:key==='recoveries'||key==='recoveryItems'?()=>[]:String(key).startsWith('pending')||String(key).includes('Recovery')||key==='recoveryMessage'?()=>undefined:async()=>[]});
const pageList={...generic,list:async()=>({items:[]})};
const apiNames='planApi marketContentApi marketCatalogApi skillSecretsApi githubSourceApi industryLoadApi industryKnowledgeApi industryDataSourceApi industryExecutionToolApi industryMcpConnectionApi industryPluginApi industryRoleApi industryTaskApi industryPlanApi skillInstallApi marketPluginInstallApi bundledExtensionsApi skillAvailabilityApi skillUpgradeApi resourceApi roleApi memoryApi dailyLogApi runtimeConfigApi taskApi projectApi taskRunApi securityActionApi taskMaterialApi taskTransitions pendingRequestApi roleLifecycle roleToolGrantApi handoffApi objectConversationApi groupApi groupAttachmentApi groupReactionApi groupRoutingApi businessLedgerApi businessDashboardApi businessCustomizationApi connectorProbeApi businessTaskApi pageCreateApi preparation nativeArtifacts artifactFileApi artifactApi'.split(' ');
const props=Object.fromEntries(apiNames.map(name=>[name,generic]));
props.planDraftApi={confirm:async()=>{throw Error('Unexpected plan draft confirmation')},onOpen:()=>()=>{},openDraft:()=>{throw Error('Unexpected plan draft navigation')}};
// 新目录端口只读空页；旧场景不允许意外读取或提交来源对象。
props.workAttentionApi={list:async()=>({schema:'teloa.work-attention/v1',items:[],incomplete:[]})};props.attentionBusinessApi=createBusinessWorkResultsApi(async()=>{throw Error('Unexpected work-attention source access')});props.workAttentionConnection={getSnapshot:()=>0,subscribe:()=>noop};
props.assistantActivity=createAssistantCompanionActivity();props.conversationPlans=createConversationPlanDirectory({list:async()=>[]});for(const name of ['industryDataSourceApi','industryExecutionToolApi','industryMcpConnectionApi','industryPluginApi'])props[name]=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]});
if(startup.assistantTitleProbe){props.skillInstallApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[],usages:[]}):target[key]});props.marketPluginInstallApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]})}
// 业务工作区读取真实群列表契约；通用数组桩不能代替 GroupApi 的分页返回。
props.groupApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>({items:[]}):target[key]});
// TaskApi.attention 返回带任务与待处理事实的目录，正确空值仍须保留 items。
props.taskApi=new Proxy(generic,{get:(target,key)=>key==='attention'?async()=>({items:[]}):target[key]});
f.sent=[];const employee={id:'r-profile',name:'原姓名',avatarKey:'general',kind:startup.roleKind||'employee',state:'active',version:3,scopes:startup.roleScopes||['general'],duty:'整理资料',dataScope:'提供的资料',executionScope:'获准范围',skills:[],knowledge:[],createdAt:stamp,updatedAt:stamp};
if(startup.roleSession){const row={id:crypto.randomUUID(),ownerId:'self',title:'原员工单聊',version:1,status:'ready',sessionId:selected,requestedSessionId:selected,requestId:crypto.randomUUID(),scopeIds:employee.scopes,createdAt:stamp};rows.set(selected,row);byId[selected]={...row,displayTitle:row.title};void work.select(selected);const links=[{kind:'role',objectId:employee.id,objectVersion:employee.version,conversationId:row.id,sessionId:selected,scopeId:employee.scopes[0],version:1,active:true,updatedAt:stamp}];f.links=links;props.objectConversationApi=new Proxy(generic,{get:(target,key)=>key==='bySession'?async id=>links.filter(link=>link.sessionId===id):key==='list'?async()=>links:key==='change'?async input=>{const link={kind:input.kind,objectId:input.objectId,objectVersion:input.expectedObjectVersion,conversationId:rows.get(input.sessionId).id,sessionId:input.sessionId,scopeId:input.scopeId,version:1,active:true,updatedAt:stamp};links.push(link);return link}:target[key]})}
f.employee=employee;f.roleReads=0;f.releaseRoles=()=>f.roleRelease?.();
props.roleApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>{f.roleReads++;const saved=(f.roleRows??(f.withRole?[f.employee]:[])).map(row=>({...row,scopes:[...row.scopes]}));if(f.holdRoles)await new Promise(resolve=>f.roleRelease=resolve);return saved}:key==='updateProfile'?async(id,version,baseline,fields)=>{f.employee={...f.employee,...fields,updatedAt:f.profileStamp||stamp};return f.employee}:key==='edit'?async()=>f.oldReceipt||f.employee:target[key]});
props.roleDelegationApi=new Proxy(generic,{get:(target,key)=>key==='get'?async roleId=>({roleId,roleVersion:f.employee.version,delegations:[],consents:[],canEditExecution:true}):target[key]});
// 原对象卡入口走真实 store；项目读口保留同一身份，模拟后续模型只修改目标和关联。
f.projectGoal='原项目目标';f.projectItems=[];f.projectReads=0;
const projectContext=createProjectContextApi(async(endpoint,input)=>{if(endpoint==='project-context/get')return {projectId:input.projectId,version:0,brief:'',entries:[],shares:[]};throw Error('Unexpected project context mutation')});
props.projectApi=new Proxy(generic,{get:(target,key)=>key==='runtime'||key==='preferences'?undefined:key==='context'?projectContext:key==='get'?async id=>{f.projectReads++;return {project:{id,ownerId:'self',scope:'sales',title:'原项目',goal:f.projectGoal,dueDate:null,state:'running',links:f.projectItems.map(item=>({kind:item.kind,id:item.id})),references:[],version:f.projectVersion??f.projectReads,createdAt:stamp,updatedAt:stamp},items:f.projectItems,summary:{totalTasks:f.projectItems.length,completedTasks:0,cancelledTasks:0,attentionTasks:0},references:[]}}:target[key]});
if(startup.projectConversation){
 f.projectVersion=3;f.projectBindings=[];f.projectRuntimeCalls=[];
 const projectRuntime=createProjectRuntimeApi(async(endpoint,input)=>{f.projectRuntimeCalls.push([endpoint,input]);if(endpoint==='project-runtime/members')return {rows:f.projectBindings.filter(row=>row.projectId===input.projectId)};if(endpoint==='project-runtime/binding')return f.projectBindings.find(row=>row.sessionId===input.sessionId)||null;if(endpoint==='project-runtime/bind'){const row={sessionId:input.sessionId,projectId:input.projectId,memoryMode:input.memoryMode,version:input.expectedVersion+1,generation:1,title:'项目工作'};f.projectBindings.push(row);return row}throw Error('Unexpected project runtime endpoint: '+endpoint)},{read:()=>sessionStorage.getItem('project-runtime'),write:value=>sessionStorage.setItem('project-runtime',value),clear:()=>sessionStorage.removeItem('project-runtime')});
 const original=props.projectApi;props.projectApi=new Proxy(original,{get:(target,key)=>key==='runtime'?projectRuntime:Reflect.get(target,key)});
 props.preparation=new PromptPreparation();f.projectPreparation=()=>props.preparation.getSnapshot();f.projectCreation=id=>projectRuntime.creation(id);
}
props.businessSpaceApi={current:async()=>space};props.businessScopeApi={list:async()=>{f.scopeReads=(f.scopeReads||0)+1;if(f.holdScopes)await new Promise(r=>releaseScopes=r);if(f.failScopes)throw Error('scope unavailable');f.scopesReturned=true;return f.scopeRows??[{scope:f.otherScope?'general':'sales',title:'验收业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}]}};
props.industryLoadApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>{f.industryRead=true;if(f.failIndustry)throw Error('industry unavailable');return []}:target[key]});f.releaseScopes=()=>{f.holdScopes=false;releaseScopes?.()};
props.businessLedgerApi=new Proxy(generic,{get:(t,k)=>k==='read'?async()=>{f.calls.push('legacy');throw Error('controlled unavailable')}:t[k]});
 const titleDirectory=new TaskRunChatPresentationDirectory(async()=>null);
 if(startup.assistantTitleProbe){for(const [id,title] of [['assistant-original','Teloa 小松鼠助手'],['ordinary-topic','本人自定义话题']]){const row={id:crypto.randomUUID(),ownerId:'self',title,version:1,status:'ready',sessionId:id,requestedSessionId:id,requestId:crypto.randomUUID(),scopeIds:['general'],createdAt:stamp,...(id==='assistant-original'?{purpose:'assistant'}:{})};rows.set(id,row);byId[id]={...row,displayTitle:title};contexts.set(id,{sessionId:id,scopeId:'general',roleId:null,version:1,locked:false})}sessionStorage.setItem('teloa.personal-assistant-session/v1','assistant-original');f.openTitleSession=id=>work.openSession(id)}
 // 会话头部 utilities 是 session 作用域槽位：没有当前会话时宿主不渲染，探针保持同一契约。
 function Probe(){const sessionId=useSyncExternalStore(main.subscribe,main.getSnapshot);useEffect(()=>{f.mounts++;return()=>{f.unmounts++}},[]);return <>{startup.roleSession&&selected&&<RoleConversationIdentity sessionId={selected} readIdentity={async id=>id===startup.sessionId?employee.name:undefined}/>}<textarea aria-label="slot-probe" defaultValue="原生输入草稿"/>{startup.assistantTitleProbe&&sessionId&&<output aria-label="原生会话标题"><TaskRunConversationTitle lineageSessionId={sessionId} displayTitle={byId[sessionId]?.displayTitle??''} directory={titleDirectory}/></output>}</>}
const renderSlot=(name,props,options)=>name==='teloa.conversation'?<>{props.home&&props.overview}{props.content}</>:name==='main'&&options?.entryKey==='conversation'?<Probe/>:null;
f.recheck=async()=>{await controller.followSession(undefined);await controller.followSession(selected)};f.releaseAssistantOpen=()=>{f.holdAssistantOpen=false;releaseAssistantOpen?.()};f.releaseCreation=()=>work.releaseCreationForNewWork(work.getPendingCreation().requestId);f.current=()=>selected;f.contexts=()=>[...contexts.values()];f.rows=()=>[...rows.values()];f.state=()=>store.getSnapshot();f.controller=controller;f.navigate=view=>store.actions.navigate(view);f.openBusiness=target=>store.actions.openBusiness(target);f.rememberDirectory=(id,patch)=>store.actions.rememberDirectory(id,patch);f.openFormal=(section='overview')=>store.actions.openBusiness({scope:'sales',section});f.releaseIdentity=()=>{f.holdIdentity=false;releaseIdentity?.()};f.start=()=>controller.start();f.releaseCreate=()=>{f.holdCreate=false;releaseCreate?.()};f.reconnect=()=>controller.connect({});f.select=async id=>{selected=id;for(const l of listeners)l();await controller.followSession(id)};f.native=ready=>{f.nativeReady=ready;f.nativeNotify()};f.pending=async(scope='sales')=>{const requestId=crypto.randomUUID(),p={requestId,title:'待恢复业务会话',kind:'daily',scope,workspaceId:'workspace'};await api.reserve(p);return work.create({requestId,title:p.title,workspaceId:p.workspaceId,beforeOpen:async()=>{throw Error('controlled pending')}}).catch(()=>[...rows.values()].find(r=>r.requestId===requestId));};
// 小松鼠语音使用同一真实 Frame；只替换网络端口和系统麦克风为隔离夹具。
if(startup.voice){f.voiceMicrophones=0;const getUserMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=input=>{f.voiceMicrophones++;return getUserMedia(input)};const original='assistant-original';for(const id of [original,'business-original']){const row={id:crypto.randomUUID(),ownerId:'self',title:id===original?'Teloa 小松鼠助手':'业务会话',version:1,status:'ready',sessionId:id,requestedSessionId:id,requestId:crypto.randomUUID(),scopeIds:id===original?['general']:['sales'],createdAt:stamp};rows.set(id,row);byId[id]={...row,displayTitle:row.title};contexts.set(id,{sessionId:id,scopeId:id===original?'general':'sales',roleId:null,version:2,locked:true})}sessionStorage.setItem('teloa.personal-assistant-session/v1',original);inputs.set(original,{...emptyInput,draft:'原正文',draftRev:2,attachmentIds:['original-image'],occurrences:[{source:'teloa-resources',ref:'original-resource',invalid:false}]});f.voiceStarts=[];f.voiceEnds=0;let call;const identity={id:'30000000-0000-4000-8000-000000000001',callGeneration:'40000000-0000-4000-8000-000000000001'},token='50000000-0000-4000-8000-000000000001';props.employeeVoiceApi={readiness:async()=>({status:'ready',providerId:'minimax'}),start:async input=>{f.voiceStarts.push(input);call={...input,...identity,state:'connecting',failure:null,playbackGeneration:0};return call},read:async()=>call||null,media:async()=>({token,closing:false,muted:false,playbackGeneration:0,speech:null}),ready:async()=>{call.state='connected'},closed:async()=>{},end:async()=>{f.voiceEnds++;if(call)call.state='ended';return {call}},muted:async()=>{},interrupt:async()=>call,audio:async()=>({text:null,receipt:null}),transcribe:async(input,signal)=>{f.asr={input,signal};return new Promise(resolve=>f.releaseAsr=()=>resolve({requestId:input.requestId,sessionId:input.sessionId,contextVersion:input.expectedContextVersion,text:'核对报告'}))}};props.insertAssistantVoiceText=async draft=>{if(draft.signal.aborted||selected!==draft.sessionId)throw Error('stale');await insertAssistantVoiceDraft(draft.text,{state:{getSnapshot:()=>inputs.get(selected),subscribe:l=>{nativeListeners.add(l);return()=>nativeListeners.delete(l)}},verify:async()=>{if(selected!==draft.sessionId||draft.signal.aborted)throw Error('stale')},text:request=>{f.nativeInsert=request;const before=inputs.get(selected);inputs.set(selected,{...before,draft:before.draft+request.text,draftRev:before.draftRev+1});f.nativeNotify();return true}})};f.voiceInput=()=>inputs.get(original);f.voiceBinding=()=>work.getSnapshot()}
const frameRoot=createRoot(document.getElementById('root'));const renderFrame=()=>frameRoot.render(<I18nProvider runtime={runtime}><WorkbenchFrame {...props} runtimeSettings={{attach:()=>noop}} runtimeExtensions={{getSnapshot:()=>[],subscribe:()=>noop}} resolveExtensionText={String} setTheme={noop} sidebarRightFace={()=>undefined} mainSession={main} beginNativeNavigation={beginNativeNavigation} openNativePanel={noop} useStore={useStore} useSessions={useSessions} actions={store.actions} renderSlot={renderSlot} work={work} management={management} conversationSearch={generic} businessBuilder={controller} createBusinessRecordFlow={()=>controller.createRecordFlow({list:async()=>({schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:f.records?[record]:[]}),get:async input=>{f.recordReads=[...(f.recordReads||[]),input];return record}})} insertBusinessRecord={async(reference,sessionId,token)=>{f.recordInserts=(f.recordInserts||0)+1;await insertBusinessRecordInput(reference,sessionId,{switching:controller.ports.switching,isCurrent:()=>controller.getSnapshot().api===token,verify:async()=>record,state:{getSnapshot:()=>inputs.get(selected)||emptyInput,subscribe:fn=>{nativeListeners.add(fn);return()=>nativeListeners.delete(fn)}},insert:request=>{f.inserted=request;inputs.set(selected,{...emptyInput,draft:'record chip',draftRev:1,occurrences:[{...request.reference,invalid:false}]});f.nativeNotify();return true}})}} navigationStorage={sessionStorage} prepareHomeSession={async()=>{f.prepares++;return selected}} homeContextApi={homeContextApi} sendConversationMessage={(id,text)=>{f.sent.push([id,text])}} insertConversationCapabilities={noop}/></I18nProvider>);
f.replaceRoleApi=()=>{const saved=f.nextOwnerRoles.map(row=>({...row,scopes:[...row.scopes]}));props.roleApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>saved:target[key]});renderFrame()};renderFrame();
void controller.connect({});
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-builder-frame-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;if(id===join(client,'TeamPage.tsx'))return "export const RoleForm=()=>null;export const TeamPage=props=>{window.frameFixture.teamProps=props;return null};";const source=await readFile(id,'utf8');const names=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>m[1]);return names.map(name=>'export const '+name+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderFrameFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output' in bundle)
 const output=bundle.output;script=output.find(item=>item.type==='chunk')!.code;styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[item.source]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch({...launchOptions(),args:['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});await mkdir('/tmp/teloa-builder-frame',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale='zh-CN',startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[];let failFrame!:(error:Error)=>void;const frameError=new Promise<never>((_resolve,reject)=>{failFrame=reject});void frameError.catch(()=>{});page.on('pageerror',(e:Error)=>{errors.push(e.message);failFrame(e)});t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="'+locale+'"><body><div id="root"></div></body></html>'}):r.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>{if(value.voice)sessionStorage.setItem('teloa.assistant-visible/v1','true');(window as any).frameStartup=value},startup);await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui}'+styles});await page.addScriptTag({content:script})
 await Promise.race([page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main')!==null),frameError])
 return page
}
for(const locale of ['zh-CN','en'])test(locale+' 真实Frame新用户新建仅一会话，桌面并栏缩放保持唯一slot和原稿',async t=>{
 const page=await mount(t,locale),en=locale==='en'
 await page.getByRole('button',{name:en?'New business':'新建业务',exact:true}).click();await page.getByRole('button',{name:en?'Save business':'保存业务',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[1,0,1,0])
 await page.screenshot({path:'/tmp/teloa-builder-frame/'+locale+'-1400.png',fullPage:true})
 await page.setViewportSize({width:1000,height:900});await page.getByRole('button',{name:en?'Save business':'保存业务',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:'/tmp/teloa-builder-frame/'+locale+'-1000.png',fullPage:true})
 assert.equal(await page.getByRole('tab',{name:en?'Conversation':'对话',exact:true}).count(),0);assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.mounts,f.unmounts]}),[1,0])
})
test('实际Frame正式入口重连/身份失败先gate，未核对前不能调用旧台账；显式重试后恢复',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdIdentity=true;void f.reconnect();f.openFormal('data')})
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
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().flow.getSnapshot().phase==='idle').catch(async(error:unknown)=>{t.diagnostic(JSON.stringify(await page.evaluate(()=>{const f=(window as any).frameFixture,controller=f.controller.getSnapshot(),flow=controller.flow?.getSnapshot(),native=f.controller.ports.switching.read();return {controller:{status:controller.status,error:String(controller.error),checkedSessionId:controller.checkedSessionId,sessionKind:controller.sessionKind},flow:{phase:flow?.phase,error:String(flow?.error),binding:flow?.binding,pendingCreation:controller.flow?.pendingCreation()},current:f.current(),native,blocked:f.blocks,view:f.state().view,rows:f.rows()}})));throw error})
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.state().view,f.creates,f.prepares,f.mounts,f.unmounts]}),['tasks',1,0,1,0])
})


test('R1 实际Frame同连接绑定失败点击重试后第二次读取并解除业务输入阻止',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'新建业务',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
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
 await page.getByRole('button',{name:'新建业务',exact:true}).click();await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
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
 await button.click();await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.prepares),0)
})

test('Task3 create受理丢回包：首页可显式恢复原builder，不需手动刷新目录或再建',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).frameFixture.loseCreate=true})
 await page.getByRole('button',{name:'新建业务',exact:true}).click()
 await page.getByRole('button',{name:'恢复搭建会话',exact:true}).click()
 await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[1,0,1,0])
})

for(const locale of ['zh-CN','en'])test('Task3 '+locale+'正式业务继续/另建与全局pending恢复，1000/1400唯一输入不重挂',async t=>{
 const page=await mount(t,locale),en=locale==='en'
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.openFormal()})
 const talk=()=>page.locator('header').getByRole('button',{name:en?'Start work':'开始工作',exact:true})
 await talk().click();await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().sessionKind==='daily'})
 const first=await page.evaluate(()=>(window as any).frameFixture.current())
 await page.evaluate(()=>{(window as any).frameFixture.navigate('spaces')});await page.locator('article').getByRole('button',{name:/^验收业务/}).click();await talk().click()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),first)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 await page.evaluate(()=>{(window as any).frameFixture.navigate('spaces')});await page.locator('article').getByRole('button',{name:/^验收业务/}).click();await talk().waitFor()
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
 await page.screenshot({path:'/tmp/teloa-builder-frame/daily-'+locale+'-1400.png',fullPage:true})
 await page.setViewportSize({width:1000,height:900})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
 await page.screenshot({path:'/tmp/teloa-builder-frame/daily-'+locale+'-1000.png',fullPage:true})
 await businessMenuItem(page.locator('#teloa-main'),en?'New conversation':'另建会话').click()
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
 await page.locator('header').getByRole('button',{name:'开始工作',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().sessionKind==='daily')
 const first=await page.evaluate(()=>{const f=(window as any).frameFixture;f.input({draft:'保留的原稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]});f.navigate('spaces');return f.current()})
 await page.locator('article').getByRole('button',{name:/^验收业务/}).click()
 await businessMenuItem(page.locator('#teloa-main'),'另建会话').click()
 const confirm=page.getByRole('dialog').getByRole('button',{name:'保留草稿并新开',exact:true})
 await confirm.waitFor()
 await page.evaluate(()=>{(window as any).frameFixture.input({draft:'确认前的新编辑',draftRev:2,phase:'plain',attachmentIds:[],occurrences:[],queue:[]})})
 await confirm.focus();await page.keyboard.press('Enter')
 await page.locator('#teloa-main').getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),first)
 await businessMenuItem(page.locator('#teloa-main'),'另建会话').click()
 await confirm.waitFor();await confirm.focus();await page.keyboard.press('Enter')
 await page.waitForFunction((id:string)=>(window as any).frameFixture.current()!==id,first)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[2,0,1,0])
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
})


test('Task3 最近会话读取失败可在正式页重试，错误不当空值另建',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.failRecent=true;f.openFormal()})
 await page.locator('header').getByRole('button',{name:'开始工作',exact:true}).click()
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
  await page.locator('header').getByRole('button',{name:'开始工作',exact:true}).click()
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
 await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 const before=await page.evaluate(async()=>{const f=(window as any).frameFixture;f.input({draft:'已核对unknown后保留的原稿',draftRev:1,phase:'plain',attachmentIds:[],occurrences:[],queue:[]});await f.reconnect();f.navigate('spaces');return f.current()})
 await page.getByRole('region',{name:'继续搭建',exact:true}).getByRole('button').filter({hasText:'验收业务'}).click()
 await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 assert.equal(await page.getByRole('dialog',{name:'当前会话有待发送内容',exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),before)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.prepares,f.mounts,f.unmounts]}),[1,0,1,0])
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
})

test('业务草案保留后离开到工作台显示总览和自动化，回原入口仍是同一原稿',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'新建业务',exact:true}).click()
 await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 await page.getByRole('textbox',{name:'slot-probe'}).fill('业务搭建原会话未发送输入')
 const original=await page.evaluate(()=>{const f=(window as any).frameFixture;return {session:f.current(),draft:f.controller.getSnapshot().flow.getSnapshot().binding.draftId}})
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:/工作台/}).click()
 // 首次手动入口产生的 revision 1 尚未保存，不需要确认，也不能因此覆盖工作台。
 assert.equal(await page.getByRole('button',{name:'保留草案离开',exact:true}).count(),0)
 await page.getByRole('navigation',{name:'工作台',exact:true}).getByRole('button',{name:'自动化',exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'保存业务',exact:true}).count(),0)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return {view:f.state().view,session:f.current(),draft:f.controller.getSnapshot().flow.getSnapshot().binding.draftId,status:f.controller.getSnapshot().flow.getSnapshot().draft.status,creates:f.creates}}),{view:'home',...original,status:'draft',creates:1})
 await page.getByRole('navigation',{name:'主导航',exact:true}).getByRole('button',{name:'业务',exact:true}).click()
 await page.getByRole('region',{name:'继续搭建',exact:true}).getByRole('button').filter({hasText:'验收业务'}).click()
 await page.getByRole('button',{name:'保存业务',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return {view:f.state().view,session:f.current(),draft:f.controller.getSnapshot().flow.getSnapshot().binding.draftId,creates:f.creates}}),{view:'messages',...original,creates:1})
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'业务搭建原会话未发送输入')
})

for(const locale of ['zh-CN','en'])test(locale+' 记录交办只准备引用；原稿保留并通过确认在新daily带入，不直接发送',async t=>{
 const page=await mount(t,locale),en=locale==='en'
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.formal=true;f.records=true;f.openFormal()})
 // 从业务总览进入真实业务内容列表，再选择原记录。
 await page.getByRole('navigation',{name:en?'Business pages':'业务页面'}).getByRole('button',{name:en?'Records':'业务内容',exact:true}).click()
 await page.getByRole('button',{name:/客户甲/}).click()
 await page.getByRole('button',{name:en?'Delegate this record':'交办此记录',exact:true}).click()
 const insert=()=>page.getByRole('button',{name:en?'Insert record reference':'带入记录引用',exact:true})
 await insert().waitFor()
 for(const width of [1400,1000]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/teloa-record-dispatch/prepared-'+locale+'-'+width+'.png',fullPage:true})}
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
 await page.locator('header').getByRole('button',{name:'开始工作',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().sessionKind==='daily'&&f.state().view==='messages'})
 const session=await page.evaluate(()=>{const f=(window as any).frameFixture;f.nativeOpenView='messages';f.navigate('spaces');return f.current()})
 await page.locator('article').getByRole('button',{name:/^验收业务/}).click()
 // 从业务总览进入真实业务内容列表，再选择原记录。
 await page.getByRole('navigation',{name:'业务页面'}).getByRole('button',{name:'业务内容',exact:true}).click()
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
 await page.locator('header').getByRole('button',{name:'开始工作',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().sessionKind==='daily'&&f.state().view==='messages'})
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nativeOpenView='tasks';f.navigate('spaces')})
 await page.locator('article').getByRole('button',{name:/^验收业务/}).click()
 // 从业务总览进入真实业务内容列表，再选择原记录。
 await page.getByRole('navigation',{name:'业务页面'}).getByRole('button',{name:'业务内容',exact:true}).click()
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

test('真实Frame小松鼠从业务打开通用原会话，重复入口不另建，迟到创建不抢导航',async t=>{
 const page=await mount(t,'zh-CN',{nativeOpenView:'messages'})
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 const original=await page.evaluate(()=>{const f=(window as any).frameFixture;return {id:f.current(),creates:f.creates,contexts:f.contexts()}})
 assert.equal(original.creates,1);assert.equal(original.contexts[0].scopeId,'general');assert.equal(original.contexts[0].roleId,null)
 await page.getByRole('heading',{name:'Teloa',exact:true}).waitFor()
 assert.match(await page.title(),/^Teloa ·/)
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.rows()[0].purpose),'assistant')
 await page.evaluate(()=>(window as any).frameFixture.navigate('spaces'))
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.current(),f.creates]}),[original.id,1])
 const other=await mount(t)
 await other.evaluate(()=>{(window as any).frameFixture.holdCreate=true})
 await other.locator('button[aria-label="Teloa"]').click()
 await other.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await other.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('resources');f.releaseCreate()})
 await other.waitForFunction(()=>sessionStorage.getItem('teloa.personal-assistant-session/v1')!==null)
 assert.equal(await other.evaluate(()=>(window as any).frameFixture.state().view),'resources')
})

test('真实Frame助手改名同步原生标题，刷新读回偏好且普通话题不继承昵称',async t=>{
 const startup={nativeOpenView:'messages',assistantTitleProbe:true},page=await mount(t,'zh-CN',startup)
 await page.locator('button[aria-label="Teloa"]').click()
 const title=page.getByLabel('原生会话标题',{exact:true})
 await title.getByText('Teloa',{exact:true}).waitFor()
 const assistant=page.locator('button[aria-label="Teloa"]');await assistant.focus();await page.keyboard.press('F2')
 const name=page.getByRole('textbox',{name:'给助手命名',exact:true});await name.fill('小罗同学');await name.press('Enter')
 await title.getByText('小罗同学',{exact:true}).waitFor()
 await page.getByRole('heading',{name:'小罗同学',exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.current(),f.creates,f.rows().find((row:any)=>row.purpose==='assistant').title,f.sent]}),['assistant-original',0,'Teloa 小松鼠助手',[]],'改名只更新显示偏好，不改原会话或创建另一会话')
 await page.getByRole('button',{name:'搜索',exact:true}).click()
 const search=page.getByRole('dialog',{name:'搜索',exact:true});await search.getByRole('combobox',{name:'全局搜索',exact:true}).fill('小罗同学')
 const result=search.getByRole('option').filter({has:page.getByText('小罗同学',{exact:true})});await result.waitFor()
 assert.equal(await result.locator('strong').innerText(),'小罗同学');assert.match(await result.innerText(),/会话/)
 assert.doesNotMatch(await result.innerText(),/Teloa 小松鼠助手/)
 await result.click();await search.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.current(),f.creates]}),['assistant-original',0],'全局搜索打开原助手，不创建新会话')
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'))
 const recent=page.getByRole('region',{name:'继续工作',exact:true});await recent.getByRole('button',{name:'继续：小罗同学',exact:true}).waitFor()
 await recent.getByRole('button',{name:'继续：小罗同学',exact:true}).click();await title.getByText('小罗同学',{exact:true}).waitFor()
 await page.reload()
 await page.evaluate((value:Record<string,unknown>)=>{(window as any).frameStartup=value},startup)
 await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui}'+styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main')!==null)
 await page.locator('button[aria-label="小罗同学"]').click()
 await title.getByText('小罗同学',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'))
 await recent.getByRole('button',{name:'继续：小罗同学',exact:true}).waitFor()
 await page.evaluate(async()=>{await (window as any).frameFixture.openTitleSession('ordinary-topic')})
 await title.getByText('本人自定义话题',{exact:true}).waitFor()
 assert.equal(await title.innerText(),'本人自定义话题')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.current(),f.creates,f.rows().map((row:any)=>[row.sessionId,row.title]),f.sent]}),['ordinary-topic',0,[['assistant-original','Teloa 小松鼠助手'],['ordinary-topic','本人自定义话题']],[]])
})

test('助手已经是当前会话，打开期间离开后取消不能抢回用户页面',async t=>{
 const page=await mount(t,'zh-CN',{nativeOpenView:'messages'})
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 await page.evaluate(()=>{(window as any).frameFixture.holdAssistantOpen=true})
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.assistantReading===true)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('resources');f.releaseAssistantOpen()})
 await page.locator('button[aria-label="Teloa"]').waitFor({state:'visible'})
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="Teloa"]')?.hasAttribute('disabled'))
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().view),'resources')
})
test('助手上下文写入未知，清除浏览器缓存后恢复服务端原身份，不能被pending守卫卡住',async t=>{
 const page=await mount(t,'zh-CN',{nativeOpenView:'messages'})
 await page.evaluate(()=>{(window as any).frameFixture.loseAssistantContext=true})
 await page.locator('button[aria-label="Teloa"]').click()
 const dialog=page.getByRole('dialog');await dialog.waitFor()
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="Teloa"]')?.hasAttribute('disabled'))
 await page.getByRole('button',{name:'取消',exact:true}).click()
 const original=await page.evaluate(()=>(window as any).frameFixture.rows()[0].sessionId)
 await page.evaluate(()=>{sessionStorage.removeItem('teloa.personal-assistant-session/v1');if((window as any).frameFixture.rows()[0].purpose!=='assistant')throw Error('canonical identity missing')})
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),original)
 assert.equal(await page.getByRole('dialog').count(),0,'已登记主聊恢复上下文不重复选择工作区')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),1)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.contexts()[0].scopeId),'general')
})

test('助手显式导航取消未完成的启动恢复，旧恢复不得覆盖原助手会话',async t=>{
 const page=await mount(t,'zh-CN',{nativeOpenView:'messages'})
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 const original=await page.evaluate(()=>(window as any).frameFixture.current())
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('spaces');f.holdRestore();f.holdAssistantOpen=true})
 await page.locator('button[aria-label="Teloa"]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.assistantReading===true)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.releaseRestore();f.releaseAssistantOpen()})
 await page.waitForFunction(()=>!document.querySelector('button[aria-label="Teloa"]')?.hasAttribute('disabled'))
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.state().view,f.current(),f.creates]}),['messages',original,1])
})

test('员工资料保存使旧目录失效；同版本旧编辑回执不能覆盖新姓名头像',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true})
 await page.evaluate(()=>{(window as any).frameFixture.navigate('team')})
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((r:any)=>r.id==='r-profile'))
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.teamProps.persistence.load()})
 await page.waitForFunction(()=>!!(window as any).frameFixture.roleRelease)
 await page.evaluate(async()=>{const f=(window as any).frameFixture,r=f.teamProps.state.roles.find((r:any)=>r.id==='r-profile');await f.teamProps.persistence.updateProfile(r,{name:'新姓名',avatarKey:'security-analyst'});f.holdRoles=false;f.releaseRoles()})
 await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.teamProps.state.roles.find((r:any)=>r.id==='r-profile').name),'新姓名')
 await page.evaluate(async()=>{const f=(window as any).frameFixture,r=f.teamProps.state.roles.find((r:any)=>r.id==='r-profile');f.profileStamp='2026-10-11T01:00:00.000Z';await f.teamProps.persistence.updateProfile(r,{name:'最新姓名',avatarKey:'general'})})
 await page.evaluate(async()=>{const f=(window as any).frameFixture,r=f.teamProps.state.roles.find((r:any)=>r.id==='r-profile');f.oldReceipt={...f.employee,name:'原姓名',updatedAt:'2026-09-29T00:00:00.000Z'};await f.teamProps.persistence.edit(r,r)})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.teamProps.state.roles.find((r:any)=>r.id==='r-profile').name),'最新姓名')
})

for(const roleKind of ['employee','twin'])test(roleKind+' 原会话头部身份唯一、来源文字链接和低频菜单保留同会话草稿',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true,roleKind,roleSession:true,roleScopes:['sales'],sessionId:'role-original'})
 const consoleErrors:string[]=[];page.on('console',(message:any)=>{if(message.type()==='error')consoleErrors.push(message.text())})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((role:any)=>role.id==='r-profile'))
 await page.evaluate(()=>(window as any).frameFixture.select(undefined))
 await page.evaluate(async()=>{const f=(window as any).frameFixture;await f.select('role-original');f.navigate('messages')})
 const context=page.getByRole('region',{name:'当前会话来源',exact:true}),draft=page.getByRole('textbox',{name:'slot-probe'})
 await context.waitFor().catch(async (error:unknown)=>{t.diagnostic(JSON.stringify(await page.evaluate(()=>{const f=(window as any).frameFixture;return {current:f.current(),view:f.state().view,messageMode:f.state().messageMode,roles:f.teamProps?.state.roles,body:document.body.innerText.slice(-1200)}})));throw error});await draft.fill('员工原会话待发送草稿')
 assert.equal(await page.getByRole('button',{name:/^查看档案/}).count(),1)
 assert.equal(await context.getByRole('button',{name:'新建工作会话',exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'会话身份',exact:true}).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[])
 const source=context.getByRole('button',{name:'验收业务',exact:true})
 assert.equal(await source.evaluate((node:HTMLElement)=>getComputedStyle(node).borderTopWidth),'0px')
 await source.click();assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.state().view,f.current(),f.state().detail.target?.objectKind]}),['messages','role-original','business'])
 await page.getByRole('button',{name:/^查看档案/}).click()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.state().view,f.current(),f.state().detail.target?.objectKind,f.state().detail.target?.id]}),['messages','role-original','role','r-profile'])
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[],'打开身份不自动发送介绍')
 await page.getByRole('button',{name:'关闭员工详情',exact:true}).click()
 await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')?.startsWith('查看档案 · '))
 assert.equal(await draft.inputValue(),'员工原会话待发送草稿')
 assert.equal(await page.getByRole('menuitem',{name:'让它重新自我介绍',exact:true,includeHidden:true}).count(),0)
 const menu=page.locator('details').filter({has:page.getByRole('menuitem',{name:'新建工作会话',exact:true,includeHidden:true})})
 await menu.locator('summary').click()
 assert.equal(await menu.getByRole('menuitem',{name:'新建工作会话',exact:true}).isEnabled(),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[],'打开低频菜单不自动发送介绍')
 await menu.getByRole('menuitem',{name:'新建工作会话',exact:true}).click()
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.creates===1&&f.current()!=='role-original'&&f.state().view==='messages'})
 assert.equal(await page.locator('textarea[aria-label="slot-probe"]').inputValue().catch(async (error:unknown)=>{t.diagnostic(JSON.stringify({consoleErrors,...await page.evaluate(()=>{const f=(window as any).frameFixture;return {body:document.body.innerText.slice(-1600),mounts:f.mounts,unmounts:f.unmounts,detail:f.state().detail}})}));throw error}),'员工原会话待发送草稿')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.mounts,f.unmounts]}),[1,1,0])
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.links.map((link:any)=>[link.kind,link.objectId,link.scopeId])),[['role','r-profile','sales'],['role','r-profile','sales']])
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[],'另建工作会话不自动发送介绍或复制员工')
 assert.equal(await page.locator('textarea[aria-label="slot-probe"]').inputValue(),'员工原会话待发送草稿')
 await page.setViewportSize({width:1000,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 assert.deepEqual(consoleErrors,[])
})

test('业务目录迟到时等待真实范围，随后自动载入员工，不把有效业务成员显示为历史成员',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true,roleScopes:['sales'],holdScopes:true})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>!!(window as any).frameFixture.teamProps)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.roleReads),0)
 await page.evaluate(()=>(window as any).frameFixture.releaseScopes())
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps.state.roles.some((role:any)=>role.id==='r-profile'))
 assert.deepEqual(await page.evaluate(()=>{const props=(window as any).frameFixture.teamProps;return [props.state.roles.find((role:any)=>role.id==='r-profile').scopes,props.persistence.error]}),[['sales'],undefined])
})

test('业务目录首读失败后，员工页刷新直接重试依赖并恢复成员，不要求用户换页',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true,roleScopes:['sales'],failScopes:true})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>!!(window as any).frameFixture.teamProps?.persistence.error)
 const previous=await page.evaluate(()=>(window as any).frameFixture.scopeReads)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.failScopes=false;f.teamProps.persistence.load()})
 await page.waitForFunction(()=>(window as any).frameFixture.scopeReads>1)
 assert.ok(await page.evaluate(()=>(window as any).frameFixture.scopeReads)>previous)
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps.state.roles.some((role:any)=>role.id==='r-profile'))
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.teamProps.persistence.error),undefined)
})


test('原对象入口从任务会话再次打开同一项目，仍显示更新目标与关联并保留目录和草稿',async t=>{
 const page=await mount(t,'zh-CN',{formal:true})
 const target:BusinessTarget={scope:'sales',section:'projects',id:'11111111-1111-4111-8111-111111111111'}
 await page.evaluate((target:BusinessTarget)=>{const f=(window as any).frameFixture;f.rememberDirectory('spaces',{query:'保留业务筛选',scrollTop:240});f.openBusiness(target)},target)
 await page.getByRole('heading',{name:'原项目',exact:true}).waitFor()
 assert.equal(await page.getByText('原项目目标',{exact:true}).isVisible(),true)
 for(const goal of ['修改后的目标','再次更新后的目标']){
  await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('tasks');f.navigate('messages')})
  await page.getByRole('textbox',{name:'slot-probe'}).fill('原会话未发送草稿')
  await page.evaluate(({target,goal}:{target:BusinessTarget;goal:string})=>{const f=(window as any).frameFixture;f.projectGoal=goal;f.projectItems=[{kind:'task',id:'22222222-2222-4222-8222-222222222222',title:'关联的原任务',state:'ready',version:2,available:true,origin:'direct',attention:null}];f.openBusiness(target)},{target,goal})
  await page.getByRole('heading',{name:'原项目',exact:true}).waitFor()
  assert.equal(await page.getByText(goal,{exact:true}).isVisible(),true)
  assert.equal(await page.getByRole('button',{name:'关联的原任务',exact:true}).isVisible(),true)
  assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return f.state().navigationDirectories.spaces}),{query:'保留业务筛选',scrollTop:240,selectedId:target.id,businessHome:false})
  assert.equal(await page.locator('textarea[aria-label="slot-probe"]').inputValue(),'原会话未发送草稿')
 }
 await page.evaluate(()=>(window as any).frameFixture.navigate('messages'))
 await page.getByRole('navigation',{name:'主导航'}).getByRole('button',{name:'业务',exact:true}).click()
 await page.getByRole('button',{name:'新建业务',exact:true}).waitFor()
 assert.equal(await page.getByRole('heading',{name:'原项目',exact:true}).count(),0,'普通业务导航保持回到首页')
 await page.evaluate((target:BusinessTarget)=>(window as any).frameFixture.openBusiness(target),target)
 await page.getByRole('heading',{name:'原项目',exact:true}).waitFor()
 assert.equal(await page.getByText('再次更新后的目标',{exact:true}).isVisible(),true,'同一业务视图回首页后，相同对象卡仍重新进入原详情')
})

test('真实Frame小松鼠复用原助手会话，隐藏及导航保留通话，留言只追加原生富草稿',{timeout:30000},async t=>{
 const page=await mount(t,'zh-CN',{voice:true,sessionId:'business-original'})
 await page.getByRole('button',{name:'实时通话',exact:true}).click()
 await page.getByText('正在听，请说话',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;const input=f.voiceStarts[0];return [f.creates,f.current(),input.target,input.expectedContextVersion,Object.keys(input).sort()]}),[0,'assistant-original','assistant',2,['requestId','sessionId','target','expectedContextVersion'].sort()])
 await page.getByRole('button',{name:'语音留言',exact:true}).click()
 await page.getByRole('button',{name:'开始录音',exact:true}).click()
 await page.getByText('请先挂断当前通话，再录制留言。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.voiceMicrophones,f.sent.length,f.asr||null,f.voiceStarts.length]}),[1,0,null,1])

 await page.getByRole('button',{name:'隐藏助手',exact:true}).click()
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('team')})
 await page.getByRole('button',{name:'挂断',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.voiceEnds),0)
 await page.getByRole('button',{name:'挂断',exact:true}).click();await page.getByText('通话已结束',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.voiceEnds,f.sent.length,f.voiceInput().draft,f.voiceInput().attachmentIds]}),[1,0,'原正文',['original-image']])
 const display=page.getByRole('button',{name:'显示页面助手',exact:true})
 assert.equal(await display.getAttribute('aria-pressed'),'false')
 assert.equal(await page.getByRole('button',{name:'小松鼠选项',exact:true}).count(),0)
 await page.getByRole('button',{name:'新建',exact:true}).press('Enter')
 assert.equal(await page.getByRole('menu').count(),1,'显示助手不需要第二层菜单，原新建菜单仍可独立操作')
 assert.equal(await display.count(),1)
 await page.keyboard.press('Escape')
 await display.press('Enter')
 const hideAssistant=page.getByRole('button',{name:'隐藏页面助手',exact:true})
 assert.equal(await hideAssistant.getAttribute('aria-pressed'),'true')
 assert.equal(await page.getByRole('menu').count(),0)
 await page.getByRole('button',{name:'语音留言',exact:true}).click()
 await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.getByText('正在录音，最多 15 秒',{exact:true}).waitFor();await page.waitForTimeout(400)
 await page.getByRole('button',{name:'完成录音',exact:true}).click();await page.waitForFunction(()=>!!(window as any).frameFixture.releaseAsr)
 await page.evaluate(()=>(window as any).frameFixture.releaseAsr())
 await page.getByText('已添加到原会话草稿，请核对后发送。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.sent.length,f.voiceInput().draft,f.voiceInput().attachmentIds,f.voiceInput().occurrences[0].ref,f.nativeInsert]}),[0,0,'原正文\n核对报告',['original-image'],'original-resource',{text:'\n核对报告',span:{start:3,end:3,draftRev:2}}])
 await page.screenshot({path:'/tmp/teloa-builder-frame/assistant-voice.png',fullPage:true})
 await page.getByRole('button',{name:'开始录音',exact:true}).click();await page.getByText('正在录音，最多 15 秒',{exact:true}).waitFor();await page.waitForTimeout(300)
 await page.getByRole('button',{name:'完成录音',exact:true}).click();await page.getByText('正在转写…',{exact:true}).waitFor()
 await page.getByRole('region',{name:'语音留言',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.asr.signal.aborted),true)
 await page.evaluate(()=>(window as any).frameFixture.releaseAsr())
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.voiceInput().draft,f.sent.length]}),['原正文\n核对报告',0])

})

for(const phase of ['directory','context','open'] as const)for(const action of ['cancel','close'] as const)test('留言准备取消 '+phase+' '+action+' 后迟到回包不打开会话或抢导航',async t=>{
 const page=await mount(t,'zh-CN',{voice:true,sessionId:'business-original'})
 await page.getByRole('button',{name:'语音留言',exact:true}).click()
 await page.evaluate((phase:string)=>{const f=(window as any).frameFixture;if(phase==='directory')f.holdVoiceDirectory=true;else if(phase==='context')f.holdVoiceContext=true;else f.holdAssistantOpen=true},phase)
 await page.getByRole('button',{name:'开始录音',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.voicePreparePending||(window as any).frameFixture.assistantReading)
 const before=await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.current(),f.state().view,f.creates,f.voiceStarts.length,f.voiceInput()]})
 if(action==='cancel')await page.getByRole('button',{name:'取消',exact:true}).click()
 else await page.getByRole('region',{name:'语音留言',exact:true}).getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(async(phase:string)=>{const f=(window as any).frameFixture;if(phase==='open')f.releaseAssistantOpen();else f.releaseVoicePrepare();await new Promise(resolve=>setTimeout(resolve,50))},phase)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.current(),f.state().view,f.creates,f.voiceStarts.length,f.voiceInput()]}),before)
 assert.equal(await page.getByText('正在录音，最多 15 秒',{exact:true}).count(),0)
})

test('留言准备读取在途时开始通话，await 后核验最新状态，不启动第二个麦克风',async t=>{
 const page=await mount(t,'zh-CN',{voice:true,sessionId:'assistant-original'})
 await page.getByRole('button',{name:'继续对话',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.voiceBinding().status==='ready')
 await page.getByRole('button',{name:'语音留言',exact:true}).click()
 await page.evaluate(()=>{(window as any).frameFixture.holdVoiceContext=true})
 await page.getByRole('button',{name:'开始录音',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.voicePreparePending)
 await page.getByRole('button',{name:'实时通话',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.voicePrepareResolvers.length>=2)
 await page.evaluate(()=>(window as any).frameFixture.releaseVoicePrepare())
 await page.getByText('正在听，请说话',{exact:true}).waitFor()
 await page.getByText('请先挂断当前通话，再录制留言。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.voiceMicrophones,f.sent.length,f.asr||null,f.voiceStarts.length]}),[1,0,null,1])
 await page.getByRole('button',{name:'挂断',exact:true}).click()
 await page.getByText('通话已结束',{exact:true}).waitFor()
})


test('项目本次工作通过真实Frame创建与准备，固定版本保全文且不会自动发送',async t=>{
 const page=await mount(t,'zh-CN',{projectConversation:true}),projectId='11111111-1111-4111-8111-111111111111'
 await page.evaluate((id:string)=>(window as any).frameFixture.openBusiness({scope:'sales',section:'projects',id}),projectId)
 await page.getByRole('heading',{name:'原项目',exact:true}).waitFor()
 await page.getByRole('button',{name:'新建会话',exact:true}).click()
 const text='# 核对交付\n\n- 保留 **原始说明**\n- 只准备，不执行\n'
 await page.getByLabel('本次工作',{exact:true}).fill(text)
 await page.getByLabel('长期记忆',{exact:true}).selectOption('off')
 await page.getByRole('button',{name:'开始会话',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.projectPreparation().length===1)
 const result=await page.evaluate((id:string)=>{const f=(window as any).frameFixture;return {prepared:f.projectPreparation(),current:f.current(),rows:f.rows(),creates:f.creates,bindings:f.projectBindings,creation:f.projectCreation(id),sent:f.sent,context:f.contexts()}},projectId)
 assert.equal(result.creates,1);assert.equal(result.rows.length,1);assert.equal(result.bindings.length,1);assert.equal(result.current,result.rows[0].sessionId)
 assert.equal(result.prepared[0].sessionId,result.current);assert.equal(result.prepared[0].sourceId,'project:'+projectId);assert.equal(result.prepared[0].sourceVersion,3);assert.ok(result.prepared[0].text.endsWith(text.trim()))
 assert.equal(result.rows[0].title,'核对交付');assert.equal(result.bindings[0].memoryMode,'off');assert.equal(result.context[0].scopeId,'sales')
 assert.equal(result.creation,undefined);assert.deepEqual(result.sent,[]);assert.equal(result.prepared[0].status,'pending')
})


test('首次工作绑定 实际Frame等待ensure成功才核业务并开放原首页输入',async t=>{
 const page=await mount(t,'zh-CN',{ensureHandshake:true,sessionId:'home-handshake',holdEnsure:true})
 await page.waitForFunction(()=>(window as any).frameFixture.ensureStarted===true)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.bindingReads,f.prepares,f.controller.getSnapshot().error]}),[0,0,null])
 await page.evaluate(()=>(window as any).frameFixture.releaseEnsure())
 await page.waitForFunction(()=>{const f=(window as any).frameFixture;return f.controller.getSnapshot().checkedSessionId==='home-handshake'&&f.prepares>0})
 assert.equal(await page.locator('#teloa-main').getByRole('alert').count(),0)
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原生输入草稿')
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.bindingReads,f.creates,f.current(),f.mounts,f.unmounts]}),[1,0,'home-handshake',1,0])
})


test('员工刷新遇到另一窗口新建合法业务，重读目录并合并已保存版本，不把成功写入显示失败',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((role:any)=>role.id==='r-profile'))
 const before=await page.evaluate(()=>{const f=(window as any).frameFixture;f.scopeRows=[{scope:'sales',title:'验收业务',kind:'domain'},{scope:'new-owned',title:'另一窗口新业务',kind:'domain'}];f.employee={...f.employee,version:4};f.roleRows=[f.employee,{...f.employee,id:'r-other-scope',scopes:['new-owned']}];f.teamProps.persistence.load();return f.scopeReads})
 await page.waitForFunction(()=>{const p=(window as any).frameFixture.teamProps;return p.state.roles.some((role:any)=>role.id==='r-profile'&&role.version===4)&&p.state.roles.some((role:any)=>role.id==='r-other-scope')&&!p.persistence.error})
 assert.ok(await page.evaluate(()=>(window as any).frameFixture.scopeReads)>before)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.teamProps.persistence.lifecycle.error),undefined)
})

test('员工未知业务经重读仍不存在时拒绝整批，不能过滤归属或合并半批成功',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((role:any)=>role.id==='r-profile'))
 const before=await page.evaluate(()=>{const f=(window as any).frameFixture;f.employee={...f.employee,version:4};f.roleRows=[f.employee,{...f.employee,id:'r-unregistered',scopes:['not-owned']}];f.teamProps.persistence.load();return f.scopeReads})
 await page.waitForFunction(()=>{const p=(window as any).frameFixture.teamProps.persistence;return !!p.error&&!p.loading})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.scopeReads),before+1)
 assert.deepEqual(await page.evaluate(()=>{const p=(window as any).frameFixture.teamProps;return [p.state.roles.find((role:any)=>role.id==='r-profile').version,p.state.roles.some((role:any)=>role.id==='r-unregistered')]}),[3,false])
})

test('员工刷新旧API迟答不能落入切换后的本人或覆盖新版本',async t=>{
 const page=await mount(t,'zh-CN',{withRole:true})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((role:any)=>role.id==='r-profile'))
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=true;f.roleRows=[{...f.employee,id:'old-owner-late',scopes:['new-owned']}];f.teamProps.persistence.load()})
 await page.waitForFunction(()=>!!(window as any).frameFixture.roleRelease)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.nextOwnerRoles=[{...f.employee,id:'new-owner-role',version:7,scopes:['general']}];f.replaceRoleApi()})
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps.state.roles.some((role:any)=>role.id==='new-owner-role'&&role.version===7))
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.holdRoles=false;f.releaseRoles()})
 await page.waitForFunction(()=>!(window as any).frameFixture.teamProps.persistence.loading)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.teamProps.state.roles.some((role:any)=>role.id==='old-owner-late')),false)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.teamProps.persistence.error),undefined)
})
