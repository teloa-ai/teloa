import test from 'node:test'
import assert from 'node:assert/strict'
import {createBusinessBuilderApi} from '../src/client/business-builder-api.ts'
import type {BusinessTarget} from '../src/client/business-preview.ts'
import {block,ledger,ledgerObject,listView} from './business-ledger-fixtures.ts'
import {BusinessConfigurationSurfaceController} from '../src/client/business-configuration-surface.ts'
const hash='a'.repeat(64),stamp='2026-09-29T00:00:00.000Z'
const definition=(id:string)=>({id,kind:'records' as const,title:id==='orders'?'订单':'复核',objectType:'order',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true})
const objectType={format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:'sales',title:'订单',unit:'单',lead:'从第一条开始',sourceId:'local',fields:[{name:'stage',label:'阶段',from:'阶段',type:'text',required:false}]}
const current=(version=1)=>({scope:'sales',version,hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'客户订单',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'order',version:1,definitionHash:hash}],pages:[definition('orders'),definition('review')],homePageId:'orders'}})
const projection=(pageId='orders',version=1)=>({mode:'saved',scope:'sales',configurationVersion:version,configurationHash:hash,page:{kind:'records',definition:definition(pageId),objectType,emptyState:'no-records'}})
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(yes=>resolve=yes);return{promise,resolve}}
function fixture(){
 const calls:Array<{endpoint:string;input:any}>=[]
 let route=async(endpoint:string,input:any):Promise<unknown>=>endpoint.endsWith('/current')?current():projection(input.pageId)
 const api=createBusinessBuilderApi(async(endpoint,input)=>{calls.push({endpoint,input});return route(endpoint,input)})
 const controller=new BusinessConfigurationSurfaceController(api,'sales')
 return{controller,calls,api,setRoute:(next:typeof route)=>{route=next}}
}
test('只有current明确null才legacy，失败不加载旧业务或页面',async()=>{
 const f=fixture();f.setRoute(async()=>null);await f.controller.load()
 assert.equal(f.controller.getSnapshot().status,'legacy');assert.equal(f.calls.length,1)
 f.setRoute(async()=>{throw Error('private transport detail')});await f.controller.load()
 assert.equal(f.controller.getSnapshot().status,'failed');assert.equal(f.controller.getSnapshot().current,null)
 assert.equal(f.calls.length,2)
})
test('固定关联来源无正式配置或目标页时不可打开，不降级旧台账',async()=>{
 const f=fixture(),reference={scope:'sales',type:'customer',id:'customer-one',version:1,snapshotHash:hash}
 f.setRoute(async()=>null)
 const c=new BusinessConfigurationSurfaceController(f.api,'sales',undefined,reference)
 await c.load();assert.equal(c.getSnapshot().status,'failed');assert.equal(c.getSnapshot().page,null)
 f.setRoute(async()=>current());await c.load();assert.equal(c.getSnapshot().status,'failed');assert.equal(c.getSnapshot().page,null)
 assert.ok(f.calls.every(call=>call.endpoint==='business-configuration/current'))
})
test('正式页面核对scope/page/hash/version，非法回包不能进入renderer',async()=>{
 for(const patch of [{scope:'other'},{configurationVersion:2},{configurationHash:'b'.repeat(64)},{page:{...projection().page,definition:definition('review')}}]){
  const f=fixture();f.setRoute(async e=>e.endsWith('/current')?current():({...projection(),...patch}));await f.controller.load()
  assert.equal(f.controller.getSnapshot().status,'ready');assert.equal(f.controller.getSnapshot().pageStatus,'failed');assert.equal(f.controller.getSnapshot().page,null)
 }
})
test('按真实homePageId/持久pageId选页，错误或已删选择回首页且不调用旧dashboard API',async()=>{
 const f=fixture(),saved=new Map([['sales','review']]),selection={get:(scope:string)=>saved.get(scope),set:(scope:string,id:string)=>{saved.set(scope,id)}}
 const c=new BusinessConfigurationSurfaceController(f.api,'sales',selection);await c.load()
 assert.equal(c.getSnapshot().selectedId,'review');assert.equal(c.getSnapshot().page!.page.definition.id,'review')
 await c.select('orders');assert.equal(saved.get('sales'),'orders')
 await assert.rejects(c.select('missing'))
 saved.set('sales','removed');await c.load();assert.equal(c.getSnapshot().selectedId,'orders')
 assert.ok(f.calls.every(c=>['business-configuration/current','business-configuration/page'].includes(c.endpoint)))
})
test('未注入持久选择时本容器刷新仍保留已选真实页面',async()=>{
 const f=fixture();await f.controller.load();await f.controller.select('review');await f.controller.load()
 assert.equal(f.controller.getSnapshot().selectedId,'review')
})
test('业务内容与统计看板按页面种类分别列页与记忆选择，切换页签不互相覆盖',async()=>{
 const board={id:'statistics',kind:'dashboard' as const,title:'订单统计',dashboardId:'statistics'}
 const widget={format:'teloa.business-widget/v1',version:'1.0.0',domain:'sales',query:'select 1',id:'total',title:'订单总数',kind:'metric',metric:{valueColumn:'n'}}
 const config:any=current();config.manifest.pages=[board,definition('orders'),definition('review')];config.manifest.homePageId='statistics'
 config.manifest.definitions.push({kind:'dashboard',localId:'statistics',version:1,definitionHash:hash},{kind:'widget',localId:'total',version:1,definitionHash:hash})
 const dashboard={mode:'saved',scope:'sales',configurationVersion:1,configurationHash:hash,page:{kind:'dashboard',definition:board,dashboard:{format:'teloa.business-dashboard/v1',id:'statistics',version:'1.0.0',domain:'sales',title:'订单统计',widgets:['total'],layout:[{widget:'total',x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false},widgets:[widget],viewRefs:[],timeRange:'all',results:[{widgetId:'total',definitionHash:hash,computedAt:stamp,status:'ok',columns:[{name:'n',type:'number'}],rows:[[1]],rowCount:1,truncated:false,bytes:1,stale:false}]}}
 const api=createBusinessBuilderApi(async(endpoint,input:any)=>endpoint.endsWith('/current')?config:input.pageId==='statistics'?dashboard:projection(input.pageId))
 const saved=new Map<string,string>(),selection={get:(scope:string,kind?:string)=>saved.get(scope+'/'+kind),set:(scope:string,id:string,kind?:string)=>{saved.set(scope+'/'+kind,id)}}
 const records=new BusinessConfigurationSurfaceController(api,'sales',selection,undefined,'records')
 await records.load();assert.equal(records.getSnapshot().selectedId,'orders','首页是看板时，业务内容默认打开第一个记录页')
 assert.deepEqual(records.pages(records.getSnapshot().current!).map(page=>page.id),['orders','review'])
 await records.select('review');await assert.rejects(records.select('statistics'))
 const boards=new BusinessConfigurationSurfaceController(api,'sales',selection,undefined,'dashboard')
 await boards.load();assert.equal(boards.getSnapshot().selectedId,'statistics');assert.equal(boards.getSnapshot().pageStatus,'ready')
 const back=new BusinessConfigurationSurfaceController(api,'sales',selection,undefined,'records')
 await back.load();assert.equal(back.getSnapshot().selectedId,'review','回到业务内容仍是上次选的记录页')
 const none=new BusinessConfigurationSurfaceController(createBusinessBuilderApi(async(endpoint,input:any)=>endpoint.endsWith('/current')?current():projection(input.pageId)),'sales',undefined,undefined,'dashboard')
 await none.load();assert.equal(none.getSnapshot().status,'ready');assert.equal(none.getSnapshot().selectedId,null);assert.equal(none.getSnapshot().page,null)
})
test('迟到旧current/page不会覆盖后来的配置版本或页面选择',async()=>{
 const f=fixture(),gate=deferred<unknown>();let n=0
 f.setRoute(async(e,r)=>e.endsWith('/current')?(++n===1?gate.promise:current(2)):projection(r.pageId,2))
 const first=f.controller.load();await f.controller.load();gate.resolve(current(1));await first
 assert.equal(f.controller.getSnapshot().current!.version,2);assert.equal(f.controller.getSnapshot().page!.mode,'saved')
 const old=deferred<unknown>();f.setRoute(async(e,r)=>r.pageId==='orders'?old.promise:projection('review',2))
 const pending=f.controller.select('orders');await f.controller.select('review');old.resolve(projection('orders',2));await pending
 assert.equal(f.controller.getSnapshot().selectedId,'review');assert.equal(f.controller.getSnapshot().page!.page.definition.id,'review')
})

import {before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const {chromium}=loadPlaywright()
let browser:any,script:string,styles:string,temp:string
const drillLedger=ledger({scope:'sales',actions:[],blocks:[block({scope:'sales',objects:1,defaultAction:null,definition:{...objectType,defaultAction:null},views:[listView('sales','order',[ledgerObject('sales','order','record-one',{fields:[{label:'阶段',value:'ready'}]})])]})]})
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessConfigurationSurface} from '${client}BusinessConfigurationSurface.tsx';
import {BusinessPage} from '${client}BusinessPage.tsx';
import {emptyTaskPreview} from '${client}task-preview.ts';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';
import {createBusinessRecordApi} from '${client}business-record-api.ts';
import {createBusinessBuilderApi} from '${client}business-builder-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,en=locale==='en',snapshot={locale,dshLocale:en?'en':'zh',revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
let requestSequence=100;if(!crypto.randomUUID)crypto.randomUUID=()=> '00000000-0000-4000-8000-'+String(++requestSequence).padStart(12,'0');
const state=window.surfaceFixture={calls:[],actions:[],mode:'saved',owner:'A',scope:'sales',chrome:true,hold:false,release:null,holdCurrent:false,releaseCurrent:null,whole:false,workspace:false,section:'overview',talk:false,responsibility:false,taskList:false,dashboard:false,objectType:undefined,id:undefined,match:undefined};
const stamp='2026-09-29T00:00:00.000Z',hash='a'.repeat(64),choices=new Map();
const def=(id)=>({id,kind:'records',title:id==='orders'?(en?'Orders':'订单'):(en?'Review':'复核'),objectType:'order',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true});
const object=(scope)=>({format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:scope,title:en?'Order':'订单',unit:en?'items':'单',lead:en?'Start with your first order':'从第一条订单开始',sourceId:'local',fields:[{name:'stage',label:en?'Stage':'阶段',from:'阶段',type:'text',required:false}]});
const dashboardDefinition={id:'statistics',kind:'dashboard',title:'订单统计',dashboardId:'statistics'};
const widgets=[
 {id:'total',title:'订单总数',kind:'metric',metric:{valueColumn:'n'},drilldown:{objectType:'order'}},
 {id:'stages',title:'阶段统计',kind:'table',table:{columns:['stage']},drilldown:{objectType:'order',match:{field:'stage',column:'stage'}}},
 {id:'items',title:'订单明细',kind:'table',table:{columns:['id']},drilldown:{objectType:'order',idColumn:'id'}}
].map(w=>({format:'teloa.business-widget/v1',version:'1.0.0',domain:'sales',query:'select 1',...w}));
const dashboardPage=(scope)=>({scope,mode:'saved',configurationVersion:1,configurationHash:hash,page:{kind:'dashboard',definition:dashboardDefinition,dashboard:{format:'teloa.business-dashboard/v1',id:'statistics',version:'1.0.0',domain:scope,title:'订单统计',widgets:widgets.map(w=>w.id),layout:widgets.map((w,i)=>({widget:w.id,x:0,y:i*2,w:12,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false},widgets,viewRefs:[],timeRange:'all',results:widgets.map((w,i)=>({widgetId:w.id,definitionHash:hash,computedAt:stamp,status:'ok',columns:[{name:['n','stage','id'][i],type:i===0?'number':'text'}],rows:[[i===0?1:i===1?'ready':'record-one']],rowCount:1,truncated:false,bytes:1,stale:false}))}});
const configuration=(scope,owner)=>({scope,version:1,hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope,title:owner+' '+(en?'Customer orders':'客户订单'),sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'order',version:1,definitionHash:hash},...(state.dashboard?[{kind:'dashboard',localId:'statistics',version:1,definitionHash:hash},...widgets.map(w=>({kind:'widget',localId:w.id,version:1,definitionHash:hash}))]:[])],pages:state.dashboard?[dashboardDefinition,def('orders')]:[def('orders'),def('review')],homePageId:state.dashboard?'statistics':'orders'}});
const page=(scope,id)=>({scope,mode:'saved',configurationVersion:1,configurationHash:hash,page:{kind:'records',definition:def(id),objectType:object(scope),emptyState:'no-records'}});
const makeServices=owner=>{
 let rows=[],latest,request=0;const versions=new Map();
 const api=createBusinessBuilderApi(async(endpoint,input)=>{
  state.calls.push([owner,endpoint,input]);
  if(state.mode==='failed')throw Error('private host detail');
  if(endpoint.endsWith('/current')){const value=state.mode==='legacy'?null:configuration(input.scope,owner);if(state.holdCurrent)return await new Promise(resolve=>{state.releaseCurrent=()=>resolve(value)});return value;}
  const value=input.pageId==='statistics'?dashboardPage(input.scope):page(input.scope,input.pageId);
  if(state.hold&&owner==='A')return await new Promise(resolve=>{state.release=()=>resolve(value)});
  return value;
 });
 const recordApi=createBusinessRecordApi(async(endpoint,input)=>{
  state.calls.push([owner,endpoint,input]);
  if(endpoint.endsWith('/list'))return {schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:rows};
  if(endpoint.endsWith('/get')&&state.recordReference)return {scope:input.scope,type:input.type,id:input.id,version:input.version,snapshotHash:state.recordReference.snapshotHash,title:'Source order',summary:'',source:'local',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[]};
  if(endpoint.endsWith('/get'))return input.version?versions.get(input.version):latest;
  if(endpoint.endsWith('/archive')){const result={...latest,version:input.expectedVersion+1,deletedAt:'2026-09-29T00:01:00.000Z'};rows=[];latest=result;versions.set(result.version,result);return result}
  if(endpoint.endsWith('/create')||endpoint.endsWith('/edit')){const result={scope:input.scope,type:input.type,id:'record-one',version:input.expectedVersion?input.expectedVersion+1:1,snapshotHash:hash,title:input.title,summary:input.summary,source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:input.fields.map(f=>({label:f.name==='stage'?'阶段':f.name,value:f.value}))};rows=[result];latest=result;versions.set(result.version,result);return result}
  throw Error('unexpected record call');
 });
 return {api,records:new BusinessRecordFlow(recordApi,()=> '11111111-1111-4111-8111-'+String(++request).padStart(12,'0')),capabilities:{create:true,edit:true,archive:true},adjust:scope=>state.actions.push(['adjust',scope]),selection:{get:scope=>choices.get(owner+'/'+scope),set:(scope,id)=>choices.set(owner+'/'+scope,id)}};
};
let services=makeServices('A');const app=createRoot(document.getElementById('root'));
const nothing=()=>{},legacyLedger={read:async input=>{state.calls.push(['legacy','ledger',input]);if(state.dashboard)return ${JSON.stringify(drillLedger)};throw Error('legacy unavailable')}};
const legacyProps={projectApi:{list:async scope=>{state.calls.push(['legacy','projects',scope]);return []},pendingFields:()=>undefined,recoveryError:()=>undefined},openProjectItem:nothing,backHome:nothing,openStaff:nothing,manageIndustryResources:scope=>state.actions.push(['legacy-settings',scope]),industryLoads:[],dataSources:[],visible:true,state:emptyTaskPreview(),go:target=>{state.actions.push(['go',target]);Object.assign(state,{objectType:undefined,id:undefined,match:undefined},target);state.render()},openTask:nothing,openWork:nothing,openMessages:nothing,openGroups:nothing,openResources:nothing,market:nothing,capabilities:()=>null,openPlans:nothing,businessLedgerApi:legacyLedger,businessCustomizationApi:{},businessShareApi:{},pageCreate:{},businessTaskApi:{pending:()=>undefined},createBusinessTask:nothing,recoverBusinessTask:nothing,businessDashboardApi:{list:async()=>[]},colorScheme:'light'};
const workspaceServices={groups:{list:async()=>({items:[]})},attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:nothing,openGroup:nothing,createGroup:nothing,talkRole:async()=>{},openAttention:nothing,renderRole:()=>null};
const responsibilityCurrent={scope:'sales',version:0,roleId:null,selectedRoleVersion:null,currentRoleVersion:null,availability:'none'};
const responsibility={api:{reconcile:async()=>{state.responsibilityReads=(state.responsibilityReads??0)+1;const value=structuredClone(responsibilityCurrent);if(state.holdResponsibility)return await new Promise(resolve=>(state.pendingResponsibility??=[]).push(()=>resolve(value)));return value},read:async()=>responsibilityCurrent,pending:()=>null,canReselect:()=>false,read:async()=>responsibilityCurrent,set:async input=>{state.actions.push(['responsibility-set',input.scope,input.role?.id]);responsibilityCurrent.version++;responsibilityCurrent.roleId=input.role?.id??null;responsibilityCurrent.selectedRoleVersion=input.role?.expectedVersion??null;responsibilityCurrent.currentRoleVersion=input.role?.expectedVersion??null;responsibilityCurrent.availability=input.role?'ready':'none';return responsibilityCurrent}},roles:{list:async()=>[{id:'11111111-1111-4111-8111-111111111111',ownerId:'owner',name:state.colleagueName??'Mina',kind:'employee',state:state.colleagueState??'active',version:1,scopes:['sales'],duty:'Customer follow-up',dataScope:'Customers',executionScope:'Read',skills:[],knowledge:[],createdAt:stamp,updatedAt:stamp}]}};
const taskList={api:{list:async input=>{state.calls.push(['task-list',input]);return {items:[{task:{id:'22222222-2222-4222-8222-222222222222',ownerId:'owner',title:'跟进客户',scope:input.scope,version:1,state:'ready',assigneeRoleId:null,assigneeRoleVersion:null,createdAt:stamp,updatedAt:stamp},source:null,progress:null,completion:null}]}}},openTask:id=>state.actions.push(['open-task',id])};
const advancedSetup={api:{read:async input=>{state.setupReads=(state.setupReads??0)+1;return {scope:input.scope,configurationVersion:input.expectedVersion,configurationHash:input.expectedHash,observedAt:stamp,colleagues:{status:'unavailable'},skills:{status:'unavailable'},knowledge:{status:'unavailable'},connections:{status:'observed',value:{items:Array.from({length:state.detailRevision?2:1},(_,i)=>({id:'connection-'+i,catalogId:'crm',serverName:'CRM '+i,status:'connected',updatedAt:stamp})),binding:'not-declared'}}}}},open:()=>{}};
const advancedSync={syncStatus:async()=>{state.syncStatusReads=(state.syncStatusReads??0)+1;return []},syncRules:async()=>{state.syncRuleReads=(state.syncRuleReads??0)+1;return [{mappingId:'mapping-one',title:state.detailRevision?'更新后的同步规则':'原同步规则',revision:state.detailRevision??0,enabled:false,running:false,schedule:{kind:'daily',time:'10:00',timezone:'Asia/Singapore'}}]},syncRuntime:async()=>({managed:true,syncEnabled:true,revision:1})};
state.render=()=>{const supplied={...services,...(state.talk?{talk:scope=>state.actions.push(['talk',scope])}:{}),...(state.responsibility?{responsibility}:{}),...(state.advanced?{setup:advancedSetup,dashboardApi:advancedSync}:{}),...(state.taskList?{taskList}:{})};app.render(<I18nProvider runtime={runtime}>{state.whole?<BusinessPage {...legacyProps} workspace={state.workspace?workspaceServices:undefined} target={{scope:state.scope,section:state.section,...(state.objectType?{objectType:state.objectType}:{}),...(state.id?{id:state.id}:{}),...(state.match?{match:state.match}:{}),...(state.recordReference?{recordReference:state.recordReference}:{})}} configuration={supplied}/>:<BusinessConfigurationSurface chrome={state.chrome} scope={state.scope} services={supplied} colorScheme="light" backHome={()=>state.actions.push(['back'])} legacy={()=><div data-legacy>Legacy business</div>}/>}</I18nProvider>)};
state.change=patch=>{Object.assign(state,patch);if(patch.owner)services=makeServices(patch.owner);state.render()};state.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/task5-surface-'))
 await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'SurfaceFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output' in bundle)
 const output=bundle.output
 script=output.find(item=>item.type==='chunk')!.code;styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await chromium.launch(launchOptions());await mkdir('/tmp/teloa-task5-surface',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function browserFixture(t:any,locale='zh-CN',width=1400){
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{await writeFile('/tmp/teloa-task5-surface/'+locale+'-'+width+'.html',await page.content());await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-font-page:26px;--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-label:1.5;--teloa-leading-heading:1.4;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#9e4226;--teloa-on-accent:#fff}body{font-family:system-ui;margin:0}#root{height:100vh}'+styles})
 await page.addScriptTag({content:script});await page.getByRole('heading',{level:1}).waitFor();return page
}
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 正式容器显示真实名称、选页与CRUD；无daily接口不出现假入口',async t=>{
 const page=await browserFixture(t,locale,width),en=locale==='en'
 await page.getByRole('button',{name:en?'Add the first record':'新增第一条'}).waitFor()
 assert.match(await page.getByRole('heading',{level:1}).innerText(),en?/Customer orders/:/客户订单/)
 assert.equal(await page.getByRole('button',{name:en?'Ask or delegate':'询问或交办'}).count(),0)
 await page.getByRole('button',{name:en?'Adjust business':'调整业务'}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[['adjust','sales']])
 const nav=page.getByRole('navigation');await nav.getByRole('button',{name:en?'Review':'复核',exact:true}).click()
 await page.getByRole('heading',{level:2,name:en?'Review':'复核'}).waitFor()
 await page.getByRole('button',{name:en?'Add the first record':'新增第一条'}).click()
 await page.getByRole('textbox',{name:en?/^Record title/:/^记录标题/}).fill(en?'First order':'第一笔订单')
 await page.getByLabel(en?'Stage':'阶段',{exact:true}).fill('ready')
 await page.getByRole('button',{name:en?'Save record':'保存记录',exact:true}).click()
 const detail=page.getByRole('dialog',{name:en?'First order':'第一笔订单',exact:true});await detail.waitFor()
 await detail.getByRole('button',{name:en?'Refresh records':'刷新记录',exact:true}).click()
 await page.waitForFunction(()=>(window as any).surfaceFixture.calls.some((c:any)=>c[1]==='business-records/get'))
 await detail.getByRole('button',{name:en?'Edit record':'编辑记录',exact:true}).click()
 await page.getByLabel(en?'Stage':'阶段',{exact:true}).fill('closed')
 await page.getByRole('button',{name:en?'Save record':'保存记录',exact:true}).click()
 await page.getByRole('button',{name:en?/First order.*closed/:/第一笔订单.*closed/}).waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 const writes=await page.evaluate(()=>(window as any).surfaceFixture.calls.filter((c:any)=>c[1]==='business-records/create'))
 assert.equal(writes.length,1);assert.equal(writes[0][2].scope,'sales');assert.equal(writes[0][2].type,'order')
 await page.screenshot({path:'/tmp/teloa-task5-surface/'+locale+'-'+width+'.png',fullPage:true})
 await page.getByRole('button',{name:en?'Archive record':'归档记录',exact:true}).click()
 await page.getByRole('form',{name:en?'Archive record':'归档记录',exact:true}).getByRole('button',{name:en?'Archive record':'归档记录',exact:true}).click()
 await page.getByRole('button',{name:en?'Add the first record':'新增第一条',exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:en?/First order/:/第一笔订单/}).count(),0)
 const calls=await page.evaluate(()=>(window as any).surfaceFixture.calls)
 assert.ok(calls.some((c:any)=>c[1]==='business-records/get'))
 assert.equal(calls.find((c:any)=>c[1]==='business-records/edit')[2].expectedVersion,1)
 assert.equal(calls.find((c:any)=>c[1]==='business-records/archive')[2].expectedVersion,2)
})
test('失败不落legacy或加载ledger；current明确null保留旧BusinessPage入口',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({whole:true,mode:'failed'}))
 await page.getByRole('alert').waitFor();assert.doesNotMatch(await page.locator('body').innerText(),/private host detail/)
 assert.equal(await page.evaluate(()=>(window as any).surfaceFixture.calls.filter((c:any)=>c[0]==='legacy').length),0)
 await page.evaluate(()=>(window as any).surfaceFixture.change({mode:'legacy'}))
 await page.getByRole('button',{name:'重试',exact:true}).click()
 await page.waitForFunction(()=>(window as any).surfaceFixture.calls.some((c:any)=>c[0]==='legacy'))
})
test('业务看板首屏展示内容，配置在抽屉；关闭保留选页并恢复入口焦点',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({responsibility:true,dashboard:true}))
 await page.getByRole('button',{name:'手动刷新',exact:true}).click()
 await page.getByRole('navigation',{name:'业务页面'}).getByRole('button',{name:'订单统计',exact:true}).click()
 await page.getByRole('heading',{name:'订单统计',exact:true}).waitFor()
 assert.equal(await page.getByRole('region',{name:'业务负责人'}).count(),0,'看板首屏不能被配置表单占满')
 const trigger=page.getByRole('button',{name:'查看配置详情',exact:true})
 await trigger.click()
 const drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true})
 await drawer.getByRole('region',{name:'业务负责人'}).waitFor()
 await page.keyboard.press('Escape')
 assert.equal(await page.getByRole('dialog').count(),0)
 assert.equal(await trigger.evaluate((el:HTMLElement)=>el===document.activeElement),true)
 assert.equal(await page.getByRole('heading',{name:'订单统计',exact:true}).count(),1)
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[],'关闭配置不自动保存或启动工作')
})
test('业务设置在所有业务页签复用配置抽屉，关闭保留负责人草稿且不写数据',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({whole:true,workspace:true,responsibility:true,section:'employees'}))
 const settings=page.getByRole('button',{name:'业务设置',exact:true})
 for(const tab of ['总览','业务内容','统计看板','AI 员工','协作群','项目']){
  await page.getByRole('navigation',{name:'业务页面',exact:true}).first().getByRole('button',{name:tab,exact:true}).click()
  await settings.click()
  const drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true});await drawer.waitFor()
  await drawer.getByRole('button',{name:'调整业务',exact:true}).waitFor()
  const selection=drawer.getByRole('combobox',{name:'选择员工',exact:true});await selection.waitFor()
  await selection.selectOption('11111111-1111-4111-8111-111111111111')
  await drawer.getByRole('button',{name:'关闭',exact:true}).click()
  await settings.click();await drawer.waitFor()
  assert.equal(await selection.inputValue(),'11111111-1111-4111-8111-111111111111')
  await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 }
 const actions=await page.evaluate(()=>(window as any).surfaceFixture.actions)
 assert.equal(actions.some((item:any)=>['legacy-settings','responsibility-set'].includes(item[0])),false)
 const calls=await page.evaluate(()=>(window as any).surfaceFixture.calls)
 assert.equal(calls.some((item:any)=>/\/(create|edit|archive|apply|revise)$/.test(item[1])),false)
 await settings.click()
 await page.getByRole('dialog',{name:'查看配置详情',exact:true}).getByRole('button',{name:'调整业务',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions.filter((item:any)=>item[0]==='adjust')),[['adjust','sales']])
})
test('业务设置读取失败可在原业务重试，只有明确旧业务才进入模板配置',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({whole:true,workspace:true,section:'employees',mode:'failed'}))
 await page.getByRole('button',{name:'业务设置',exact:true}).click()
 const drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true});await drawer.getByRole('alert').waitFor()
 assert.doesNotMatch(await drawer.innerText(),/private host detail/)
 assert.equal(await page.evaluate(()=>(window as any).surfaceFixture.actions.some((item:any)=>item[0]==='legacy-settings')),false)
 await page.evaluate(()=>(window as any).surfaceFixture.change({mode:'saved'}))
 await drawer.getByRole('button',{name:'重试',exact:true}).click()
 await drawer.getByRole('button',{name:'调整业务',exact:true}).waitFor()
 await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(()=>(window as any).surfaceFixture.change({mode:'legacy'}))
 await page.getByRole('button',{name:'业务设置',exact:true}).click()
 await page.waitForFunction(()=>(window as any).surfaceFixture.actions.some((item:any)=>item[0]==='legacy-settings'))
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions.filter((item:any)=>item[0]==='legacy-settings')),[['legacy-settings','sales']])
 assert.equal(await drawer.count(),0)
})
test('业务设置关闭与切换范围丢弃迟到配置；通用工作没有业务设置',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({whole:true,workspace:true,section:'employees',holdCurrent:true}))
 const settings=page.getByRole('button',{name:'业务设置',exact:true})
 await settings.click()
 const drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true});await drawer.waitFor()
 await page.waitForFunction(()=>(window as any).surfaceFixture.releaseCurrent!==null)
 await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 await page.evaluate(()=>{const state=(window as any).surfaceFixture;state.releaseCurrent();state.releaseCurrent=null})
 assert.equal(await drawer.count(),0)
 await settings.click();await drawer.waitFor()
 await page.waitForFunction(()=>(window as any).surfaceFixture.releaseCurrent!==null)
 await page.evaluate(()=>(window as any).surfaceFixture.change({scope:'support',holdCurrent:false}))
 await page.evaluate(()=>(window as any).surfaceFixture.releaseCurrent())
 await page.getByRole('heading',{level:1,name:'support',exact:true}).waitFor()
 assert.equal(await drawer.count(),0)
 await page.getByRole('button',{name:'业务设置',exact:true}).click()
 await drawer.getByRole('button',{name:'调整业务',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions.filter((item:any)=>item[0]==='adjust')),[['adjust','support']])
 await page.evaluate(()=>(window as any).surfaceFixture.change({scope:'general'}))
 await settings.waitFor({state:'hidden'})
 assert.equal(await settings.count(),0)
 assert.equal(await drawer.count(),0)
 assert.equal(await page.evaluate(()=>(window as any).surfaceFixture.actions.some((item:any)=>item[0]==='legacy-settings')),false)
})
test('嵌入业务保留平台按钮尺寸与圆角，不退回浏览器默认样式',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({chrome:false}))
 const button=page.getByRole('navigation',{name:'业务页面'}).getByRole('button').first()
 const dimensions=await button.evaluate((el:HTMLElement)=>({height:el.getBoundingClientRect().height,radius:Number.parseFloat(getComputedStyle(el).borderRadius)}))
 assert.ok(dimensions.height>=36,'嵌入页面的操作目标至少 36px')
 assert.ok(dimensions.radius>=7,'嵌入和独立容器使用同一平台样式')
})
test('关闭配置抽屉不提交负责人草稿，重新打开保留未保存的选择',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({responsibility:true}))
 const trigger=page.getByRole('button',{name:'查看配置详情',exact:true})
 await trigger.click()
 const selection=page.getByRole('dialog',{name:'查看配置详情',exact:true}).getByRole('combobox',{name:'选择员工',exact:true})
 const employee='11111111-1111-4111-8111-111111111111'
 await selection.selectOption(employee)
 await page.keyboard.press('Escape')
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[])
 await trigger.click()
 assert.equal(await selection.inputValue(),employee,'关闭仅收起抽屉，不能丢弃未保存的选择')
 await page.getByRole('button',{name:'保存负责人',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[['responsibility-set','sales',employee]])
})
test('配置详情每次重开读取最新准备、负责人和同步规则，保留未提交选择且关闭不写入',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({responsibility:true,advanced:true}))
 const trigger=page.getByRole('button',{name:'查看配置详情',exact:true}),drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true})
 await trigger.click()
 const selection=drawer.getByRole('combobox',{name:'选择员工',exact:true}),employee='11111111-1111-4111-8111-111111111111'
 await selection.selectOption(employee);await drawer.getByText('原同步规则',{exact:true}).waitFor()
 const reads=await page.evaluate(()=>{const f=(window as any).surfaceFixture;return [f.setupReads,f.responsibilityReads,f.syncRuleReads,f.syncStatusReads]})
 await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).surfaceFixture.change({detailRevision:1,colleagueName:'Mina 新职责'}))
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).surfaceFixture;return [f.setupReads,f.responsibilityReads,f.syncRuleReads,f.syncStatusReads]}),reads,'关闭期间不发后台配置读取')
 await trigger.click()
 await drawer.getByText('更新后的同步规则',{exact:true}).waitFor()
 await selection.getByRole('option',{name:'Mina 新职责',exact:true}).waitFor({state:'attached'})
 assert.equal(await selection.inputValue(),employee)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).surfaceFixture;return [f.setupReads,f.responsibilityReads,f.syncRuleReads,f.syncStatusReads]}),reads.map((count:number)=>count+1))
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[])
 await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).surfaceFixture.change({colleagueState:'paused'}))
 await trigger.click();await page.waitForFunction(()=>{const select=document.querySelector('dialog[open] select') as HTMLSelectElement|null;return select&&!select.disabled})
 assert.equal(await selection.inputValue(),employee,'候选失效时仍保留本人草稿')
 assert.equal(await drawer.getByRole('button',{name:'保存负责人',exact:true}).isDisabled(),true,'重开读到已暂停员工后不得继续提交')
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[])
})
test('配置详情关闭后重开不接收上一轮迟到负责人目录',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({responsibility:true,holdResponsibility:true}))
 const trigger=page.getByRole('button',{name:'查看配置详情',exact:true}),drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true})
 await trigger.click();await page.waitForFunction(()=>(window as any).surfaceFixture.pendingResponsibility?.length===1)
 await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).surfaceFixture.change({holdResponsibility:false,colleagueName:'Mina 最新岗位'}))
 await trigger.click();const selection=drawer.getByRole('combobox',{name:'选择员工',exact:true})
 await selection.getByRole('option',{name:'Mina 最新岗位',exact:true}).waitFor({state:'attached'})
 await page.evaluate(()=>{for(const release of (window as any).surfaceFixture.pendingResponsibility)release()})
 assert.equal(await selection.getByRole('option',{name:'Mina',exact:true}).count(),0)
 assert.equal(await selection.getByRole('option',{name:'Mina 最新岗位',exact:true}).count(),1)
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[])
})
for(const width of [390,1400])test(width+' 配置抽屉标题、调整按钮与内容保持标准边距，窄窗不横溢',async t=>{
 const page=await browserFixture(t,'zh-CN',width)
 await page.evaluate(()=>(window as any).surfaceFixture.change({responsibility:true,advanced:true,whole:true,workspace:true,section:'employees'}))
 await page.getByRole('button',{name:'业务设置',exact:true}).click()
 const drawer=page.getByRole('dialog',{name:'查看配置详情',exact:true})
 await drawer.getByRole('combobox',{name:'选择员工',exact:true}).waitFor()
 const spacing=await drawer.evaluate((dialog:HTMLDialogElement)=>{
  const box=dialog.getBoundingClientRect(),heading=dialog.querySelector('header h2')!.getBoundingClientRect(),adjust=[...dialog.querySelectorAll('button')].find(button=>button.textContent?.includes('调整'))!.getBoundingClientRect(),content=dialog.querySelector('section')!.getBoundingClientRect()
  return {heading:heading.left-box.left,adjust:adjust.left-box.left,content:content.left-box.left,overflow:dialog.scrollWidth>dialog.clientWidth||document.documentElement.scrollWidth>innerWidth}
 })
 assert.ok(spacing.heading>=20,JSON.stringify(spacing));assert.ok(spacing.adjust>=20,JSON.stringify(spacing));assert.ok(spacing.content>=20,JSON.stringify(spacing));assert.equal(spacing.overflow,false)
})
test('正式业务页可选已有同事负责人，保存只写归属不启动任务',async t=>{
 const page=await browserFixture(t,'zh-CN',390)
 await page.evaluate(()=>(window as any).surfaceFixture.change({responsibility:true}))
 await page.getByRole('button',{name:'查看配置详情',exact:true}).click()
 const panel=page.getByRole('region',{name:'业务负责人'})
 await panel.getByRole('combobox',{name:"选择员工"}).selectOption('11111111-1111-4111-8111-111111111111')
 await panel.getByRole('button',{name:'保存负责人'}).click()
 await panel.getByRole('paragraph').filter({hasText:'Mina'}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[['responsibility-set','sales','11111111-1111-4111-8111-111111111111']])
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})
test('正式业务页加载真实任务目录并进入原任务详情，旧业务页不挂载目录',async t=>{
 const page=await browserFixture(t,'zh-CN',390)
 await page.evaluate(()=>(window as any).surfaceFixture.change({taskList:true}))
 const list=page.getByRole('region',{name:'业务任务进度'})
 await list.getByText('跟进客户').waitFor()
 await list.getByRole('button',{name:'查看任务与成果'}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[['open-task','22222222-2222-4222-8222-222222222222']])
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.calls.filter((row:any)=>row[0]==='task-list')), [['task-list',{scope:'sales'}]])
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.evaluate(()=>(window as any).surfaceFixture.change({mode:'legacy',owner:'B'}))
 await page.getByText('Legacy business').waitFor()
 assert.equal(await list.count(),0)
})
test('同scope更换本人API/record flow立即隔离旧页面；迟到投影不覆盖新本人',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({hold:true}))
 await page.getByRole('navigation').getByRole('button',{name:'复核',exact:true}).click()
 await page.waitForFunction(()=>typeof (window as any).surfaceFixture.release==='function')
 await page.evaluate(()=>(window as any).surfaceFixture.change({owner:'B',hold:false}))
 await page.getByRole('heading',{level:1,name:'B 客户订单'}).waitFor()
 await page.evaluate(()=>(window as any).surfaceFixture.release())
 assert.equal(await page.getByRole('heading',{level:1}).innerText(),'B 客户订单')
 assert.equal(await page.getByRole('heading',{level:2,name:'订单',exact:true}).count(),1)
 await page.evaluate(()=>(window as any).surfaceFixture.change({talk:true}))
 await page.getByRole('button',{name:'询问或交办',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions),[['talk','sales']])
})

test('BusinessPage自主总览不读取ledger，项目和历史任务入口保留原路径',async t=>{
 const page=await browserFixture(t)
 await page.evaluate(()=>(window as any).surfaceFixture.change({whole:true}))
 await page.getByRole('button',{name:'新增第一条',exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).surfaceFixture.calls.some((c:any)=>c[0]==='legacy')),false)
 const before=await page.evaluate(()=>(window as any).surfaceFixture.calls.filter((c:any)=>c[1]==='business-configuration/current').length)
 await page.evaluate(()=>(window as any).surfaceFixture.change({section:'work'}))
 await page.waitForFunction(()=>(window as any).surfaceFixture.calls.some((c:any)=>c[1]==='ledger'))
 await page.evaluate(()=>(window as any).surfaceFixture.change({section:'projects'}))
 await page.waitForFunction(()=>(window as any).surfaceFixture.calls.some((c:any)=>c[1]==='projects'&&c[2]==='sales'))
 assert.equal(await page.evaluate(()=>(window as any).surfaceFixture.calls.filter((c:any)=>c[1]==='business-configuration/current').length),before)
})

test('正式看板经真实go打开对象清单、匹配清单和固定对象，不被正式首页吞回',async t=>{
 const page=await browserFixture(t)
 const openDashboard=async()=>{
  await page.evaluate(()=>(window as any).surfaceFixture.change({whole:true,dashboard:true,owner:'A',section:'overview',objectType:undefined,id:undefined,match:undefined}))
  await page.getByRole('navigation').getByRole('button',{name:'订单统计',exact:true}).click()
  await page.getByRole('heading',{level:2,name:'订单统计',exact:true}).waitFor()
 }
 for(const kind of ['all','match','id']){
  await openDashboard()
  const before=await page.evaluate(()=>(window as any).surfaceFixture.calls.filter((c:any)=>c[1]==='business-configuration/current').length)
  if(kind==='all')await page.getByRole('button',{name:'查看对象',exact:true}).first().click()
  else await page.getByRole('button',{name:kind==='match'?'查看 ready':'查看 record-one',exact:true}).click()
  const expected:BusinessTarget={scope:'sales',section:'data',objectType:'order',...(kind==='match'?{match:{field:'stage',value:'ready'}}:kind==='id'?{id:'record-one',match:{field:'_id',value:'record-one'}}:{})}
  await page.waitForFunction(()=> (window as any).surfaceFixture.calls.some((c:any)=>c[1]==='ledger'&&c[2].objectType==='order'))
  assert.deepEqual(await page.evaluate(()=>(window as any).surfaceFixture.actions.filter((a:any)=>a[0]==='go').at(-1)[1]),expected)
  await page.getByRole('button',{name:'工单 record-one',exact:true}).waitFor()
  if(kind==='match')assert.match(await page.locator('[data-ledger-match]').innerText(),/ready/)
  if(kind==='id'){const drawer=page.getByRole('dialog',{name:'工单 record-one',exact:true});await drawer.waitFor();await drawer.getByRole('heading',{level:3,name:'工单 record-one',exact:true}).waitFor();await drawer.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await drawer.count(),0);await page.getByRole('button',{name:'工单 record-one',exact:true}).waitFor()}
  const calls=await page.evaluate(()=>(window as any).surfaceFixture.calls)
  assert.ok(calls.some((c:any)=>c[1]==='ledger'&&c[2].objectType==='order'&&JSON.stringify(c[2].match)===JSON.stringify(expected.match)))
  assert.equal(calls.filter((c:any)=>c[1]==='business-configuration/current').length,before)
  assert.equal(await page.getByRole('heading',{level:2,name:'订单统计',exact:true}).count(),0)
 }
})

test('固定来源按真实records类型选页，不被首页或旧偏好劫回；错scope/无类型明确失败',async()=>{
 const f=fixture(),reference={scope:'sales',type:'order',id:'one',version:3,snapshotHash:hash}
 const config=current();config.manifest.pages[0]={...definition('orders'),objectType:'customer'};config.manifest.definitions.push({kind:'object-type',localId:'customer',version:1,definitionHash:hash})
 f.setRoute(async(e,r)=>e.endsWith('/current')?config:projection(r.pageId))
 const controller=new BusinessConfigurationSurfaceController(f.api,'sales',{get:()=> 'orders',set:()=>{}},reference)
 await controller.load();assert.equal(controller.getSnapshot().selectedId,'review')
 for(const ref of [{...reference,scope:'other'},{...reference,type:'missing'}]){
  const wrong=new BusinessConfigurationSurfaceController(f.api,'sales',undefined,ref);await wrong.load()
  assert.equal(wrong.getSnapshot().status,'failed');assert.equal(wrong.getSnapshot().page,null)
 }
})

test('正式BusinessPage固定来源走配置records页与精确历史get，不调用旧ledger',async t=>{
 const p=await browserFixture(t)
 const reference={scope:'sales',type:'order',id:'source-one',version:3,snapshotHash:hash}
 await p.evaluate((ref:typeof reference)=>(window as any).surfaceFixture.change({whole:true,section:'data',objectType:ref.type,id:ref.id,recordReference:ref}),reference)
 await p.getByRole('heading',{name:'Source order',exact:true}).waitFor()
 await p.getByRole('button',{name:'返回当前版本',exact:true}).waitFor()
 const calls=await p.evaluate(()=>(window as any).surfaceFixture.calls)
 assert.ok(calls.some((c:any)=>c[1]==='business-records/get'&&c[2].id==='source-one'&&c[2].version===3))
 assert.equal(calls.some((c:any)=>c[0]==='legacy'),false)
})

test('带固定引用但没有正式目标页时显示明确提示，旧台账不挂载',async t=>{
 const page=await browserFixture(t),reference={scope:'sales',type:'order',id:'source-one',version:3,snapshotHash:hash}
 await page.evaluate((ref:typeof reference)=>(window as any).surfaceFixture.change({whole:true,section:'data',objectType:ref.type,id:ref.id,recordReference:ref,mode:'legacy'}),reference)
 await page.getByRole('alert').filter({hasText:'此关联记录没有已配置的正式记录页，暂时无法打开。'}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).surfaceFixture.calls.some((call:any)=>call[0]==='legacy')),false)
})
