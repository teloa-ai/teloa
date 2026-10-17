import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

/** 正式配置/记录组件和严格 API 解码器；两行业数据是协议夹具，不冒充真实宿主或 PG。 */
test('行业看板清单打开固定记录，关闭回原看板；旧业务/API/已关闭读取均不能抢开详情',{timeout:60000},async()=>{
 const client=fileURLToPath(new URL('../src/client/',import.meta.url)),root=fileURLToPath(new URL('../../../../',import.meta.url))
 await mkdir(join(client,'../../.runtime'),{recursive:true});const temp=await mkdtemp(join(client,'../../.runtime/industry-drilldown-'))
 let browser:any
 try{
  await writeFile(join(temp,'fixture.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';
import {BusinessConfigurationSurface} from '${client}BusinessConfigurationSurface.tsx';import {BusinessWorkspace} from '${client}BusinessWorkspace.tsx';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';import {createBusinessRecordApi} from '${client}business-record-api.ts';
import {createBusinessBuilderApi} from '${client}business-builder-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const stamp='2026-10-14T00:00:00.000Z',hash='a'.repeat(64),snapshotHash='b'.repeat(64);
const state=window.industryFixture={scope:'content-ops',owner:'A',workspace:false,calls:[],navigation:[],choices:new Map(),holdPage:false,holdRecord:false,releases:[],corrupt:false};
const localeSnapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,p)=>translateMessage('zh-CN',key,p),subscribe:()=>()=>{},getSnapshot:()=>localeSnapshot};
function fixture(scope){
 const content=scope==='content-ops',type=content?'content':'opportunity',title=content?'原内容待审批':'原商机待跟进';
 const objectType={format:'teloa.business-object-type/v2',id:type,domain:scope,version:'1.0.0',title:content?'内容':'商机',unit:'项',lead:'原业务记录',sourceId:'records',fields:[{name:'owner',label:'负责人',from:'负责人',type:'text',required:false},{name:'due',label:'截止',from:'截止',type:'datetime',required:false}]};
 const view={format:'teloa.business-view/v2',id:'pending-list',domain:scope,version:'1.0.0',title:'待处理清单',kind:'list',chart:'table',objectType:type,filters:[],sort:{by:'dimension',direction:'asc'},limit:20,measures:[{id:'at',label:'截止',aggregation:'min',field:'due'}]};
 const widget={format:'teloa.business-widget/v1',id:'pending',version:'1.0.0',domain:scope,title:'待处理清单',kind:'view-ref',viewRef:view.id};
 const dashboard={format:'teloa.business-dashboard/v1',id:'overview',version:'1.0.0',domain:scope,title:content?'内容运营总览':'客户跟进总览',widgets:[widget.id],layout:[{widget:widget.id,x:0,y:0,w:12,h:3}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false};
 const records={id:'records',kind:'records',title:objectType.title,objectType:type,fields:['owner','due'],allowCreate:true,allowEdit:true,allowArchive:true},home={id:'home',kind:'dashboard',title:dashboard.title,dashboardId:dashboard.id};
 const object={id:content?'content-one':'opportunity-one',title,version:3,snapshotHash,source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'missing',summary:'固定来源的原摘要',fields:[{label:'负责人',value:'原负责人'}]};
 const current={scope,version:2,hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v2',scope,title:dashboard.title,sources:[{sourceId:'records',kind:'local-records'}],definitions:[['object-type',objectType],['view',view],['widget',widget],['dashboard',dashboard]].map(([kind,d])=>({kind,localId:d.id,version:1,definitionHash:hash})),pages:[home,records],homePageId:'home'}};
 const base={format:'teloa.business-configuration-page/v2',scope,configurationHash:hash,mode:'saved',configurationVersion:2};
 const recordPage={...base,page:{kind:'records',definition:records,objectType,emptyState:'no-records'}};
 const dashboardPage={...base,page:{kind:'dashboard',definition:home,dashboard,widgets:[widget],viewRefs:[{view,objectType}],timeRange:'all',results:[{format:'teloa.business-view-widget-result/v2',widgetId:widget.id,definitionHash:hash,computedAt:stamp,stale:false,view:{schema:'teloa.business-view-result/v2',viewId:view.id,viewVersion:view.version,definitionHash:hash,origin:'local',kind:'list',chart:'table',title:view.title,scope,objectType:type,computedAt:stamp,dimensionMode:'records',measures:[{id:'at',label:'截止',aggregation:'min',fieldType:'datetime'}],rows:[{dimension:object.id,label:title,values:[null]}],objects:[object],dimensionValues:1,coverage:{objects:1,latestReceivedAt:stamp,truncated:false},missingFields:['due']}}]}};
 return {current,recordPage,dashboardPage,object:{scope,type,...object}};
}
function services(owner){
 const api=createBusinessBuilderApi(async(endpoint,input)=>{state.calls.push([owner,endpoint,input]);const f=fixture(input.scope);if(endpoint.endsWith('/current'))return f.current;const result=input.pageId==='home'?f.dashboardPage:f.recordPage;if(input.pageId==='records'&&state.holdPage)return await new Promise(resolve=>state.releases.push(()=>resolve(result)));return result});
 const records=new BusinessRecordFlow(createBusinessRecordApi(async(endpoint,input)=>{state.calls.push([owner,endpoint,input]);if(endpoint!=='business-records/get')throw Error('非预期记录操作 '+endpoint);const value={...fixture(input.scope).object,...(state.corrupt?{snapshotHash:'c'.repeat(64)}:{})};if(state.holdRecord)return await new Promise(resolve=>state.releases.push(()=>resolve(value)));return value}));
 return {api,records,capabilities:{create:true,edit:true,archive:true},adjust:()=>{},selection:{get:s=>state.choices.get(s),set:(s,id)=>state.choices.set(s,id)}};
}
let ports=services(state.owner);const app=createRoot(document.getElementById('root'));
const workspaceServices={groups:{list:async()=>({items:[]})},attention:[],tasksKnown:true,tasksFailed:false,rolesKnown:true,rolesFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{},openGroup:()=>{},createGroup:()=>{},talkRole:async()=>{},openAttention:()=>{},renderRole:()=>null};
state.change=patch=>{const previous=state.owner;Object.assign(state,patch);if(state.owner!==previous)ports=services(state.owner);flushSync(()=>app.render(<I18nProvider runtime={runtime}>{state.workspace?<BusinessWorkspace scope={state.scope} title={fixture(state.scope).current.manifest.title} target={{scope:state.scope,section:'overview'}} state={{tasks:[],roles:[]}} services={workspaceServices} dashboardApi={{list:async()=>{throw Error('不应读旧看板')}}} configurationApi={ports.api} configurationServices={ports} go={target=>state.navigation.push(target)} back={()=>{}} start={()=>{}} configure={()=>{}} staff={()=>{}} openTask={()=>{}} openWork={()=>{}} colorScheme="light">{null}</BusinessWorkspace>:<BusinessConfigurationSurface scope={state.scope} services={ports} colorScheme="light" backHome={()=>{}} go={target=>state.navigation.push(target)} legacy={()=>null}/>}</I18nProvider>))};state.release=()=>{const callbacks=state.releases.splice(0);callbacks.forEach(done=>done())};state.change({});
`)
  const bundle=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'IndustryDrilldownFixture',formats:['iife']}}})
  const result=Array.isArray(bundle)?bundle[0]:bundle;assert.ok(result&&'output'in result)
  const script=result.output.find(item=>item.type==='chunk')!.code,styles=result.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
  browser=await loadPlaywright().chromium.launch(launchOptions());const page=await browser.newPage({viewport:{width:1360,height:900}});page.setDefaultTimeout(3000)
  const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
  await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#475e55;--teloa-font-caption:13px;--teloa-font-body:14px}body{margin:0;font-family:system-ui}#root{height:100vh}'+styles});await page.addScriptTag({content:script})
  const change=(patch:unknown)=>page.evaluate((p:unknown)=>(window as any).industryFixture.change(p),patch),release=()=>page.evaluate(()=>(window as any).industryFixture.release())
  const calls=()=>page.evaluate(()=>(window as any).industryFixture.calls)
  for(const [scope,title] of [['content-ops','原内容待审批'],['b2b-sales','原商机待跟进']]){
   await change({scope,holdPage:false,holdRecord:false,corrupt:false});const button=page.getByRole('button',{name:title,exact:true});await page.getByRole('rowheader',{name:title,exact:true}).waitFor().catch(async(error:Error)=>{await writeFile('/tmp/teloa-industry-drilldown-stopped.json',JSON.stringify({body:await page.locator('body').innerText(),errors,calls:await calls()}));throw error});await button.waitFor()
   assert.equal(await page.locator('[data-typed-view] td').innerText(),'—')
   await button.click();const drawer=page.getByRole('dialog',{name:title,exact:true});await drawer.waitFor();await drawer.getByText('原负责人',{exact:true}).waitFor()
   assert.equal(await drawer.getByRole('button',{name:'查看当前版本',exact:true}).count(),0)
   assert.equal(await drawer.getByRole('button',{name:'编辑',exact:true}).count(),0)
   await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'});await button.waitFor();assert.equal(await button.evaluate((node:HTMLElement)=>document.activeElement===node),true)
   assert.equal(await page.getByRole('button',{name:scope==='content-ops'?'内容运营总览':'客户跟进总览',exact:true}).getAttribute('aria-current'),'page')
  }
  // 采用后默认业务总览的真实 DashboardSummary 也走同一固定详情，关闭仍留在摘要。
  await change({scope:'content-ops',workspace:true});const summary=page.getByRole('button',{name:'原内容待审批',exact:true});await summary.waitFor();await summary.click();const summaryDrawer=page.getByRole('dialog',{name:'原内容待审批',exact:true});await summaryDrawer.getByText('原负责人',{exact:true}).waitFor();await page.keyboard.press('Escape');await summaryDrawer.waitFor({state:'hidden'});await summary.waitFor();assert.equal(await summary.evaluate((node:HTMLElement)=>document.activeElement===node),true);assert.equal(await page.getByRole('button',{name:'总览',exact:true}).getAttribute('aria-current'),'page');await change({workspace:false});
  // 关闭尚未完成的正式记录页读取，不能在迟答后重新打开；同业务 API 换代也不能沿旧读取开详情。
  await change({scope:'content-ops',holdPage:true});await page.getByRole('button',{name:'原内容待审批',exact:true}).click()
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await release();assert.equal(await page.getByRole('dialog').count(),0)
  await page.getByRole('button',{name:'原内容待审批',exact:true}).click();await change({owner:'B',holdPage:false});await release();await page.getByRole('button',{name:'原内容待审批',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0)
  // 同一对象的旧版本 hash 不符只显示读取失败，绝不降级 latest 或泄露该快照正文。
  await change({corrupt:true});await page.getByRole('button',{name:'原内容待审批',exact:true}).click();const failed=page.getByRole('dialog');await failed.getByRole('alert').waitFor();assert.doesNotMatch(await failed.innerText(),/固定来源的原摘要|原负责人/);await page.keyboard.press('Escape')
  // 对象读取在途切业务：即使旧服务忽略 AbortSignal，也不会把旧记录带到新业务。
  await change({corrupt:false,holdRecord:true});await page.getByRole('button',{name:'原内容待审批',exact:true}).click();await page.getByRole('dialog').getByRole('status').waitFor();await change({scope:'b2b-sales',holdRecord:false});await release();await page.getByRole('button',{name:'原商机待跟进',exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0)
  const actual=await calls(),gets=actual.filter(([,endpoint]:any)=>endpoint==='business-records/get');assert.ok(gets.length>=4);assert.ok(gets.every(([, ,input]:any)=>input.version===3));assert.ok(actual.every(([,endpoint]:any)=>['business-configuration/current','business-configuration/page','business-records/get'].includes(endpoint)))
  assert.deepEqual(await page.evaluate(()=>(window as any).industryFixture.navigation),[]);assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
 }finally{await browser?.close();await rm(temp,{recursive:true,force:true})}
})
