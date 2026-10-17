import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

/**
 * 业务总览「统计看板」摘要：整体配置管理的业务与「统计看板」分区同源（current + 正式看板页），旧看板服务按真实拒收返回
 * dependency-unavailable 也不再出现「暂时无法加载 / 重试」；current===null 的旧业务仍走旧 dashboardApi。真组件、真实 effect 与只读夹具。
 */
test('总览统计摘要：正式配置业务读同源看板页且不调用会拒收的旧看板，旧业务仍读旧看板',{timeout:60000},async()=>{
 const client=fileURLToPath(new URL('../src/client/',import.meta.url)),root=fileURLToPath(new URL('../../../../',import.meta.url))
 await mkdir(join(client,'../../.runtime'),{recursive:true})
 const temp=await mkdtemp(join(client,'../../.runtime/overview-dashboard-summary-'))
 let browser:any
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<html lang="zh-CN"><body><div id="root"></div></body></html>')})
 try{
  await writeFile(join(temp,'fixture.tsx'),`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {BusinessWorkspace} from '${client}BusinessWorkspace.tsx';import {createBusinessBuilderApi} from '${client}business-builder-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const evidence=window.summaryFixture={calls:[],mode:'configured'};
const stamp='2026-09-29T00:00:00.000Z',hash='a'.repeat(64);
const records={id:'orders',kind:'records',title:'订单',objectType:'order',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true};
const dashboardDefinition={id:'statistics',kind:'dashboard',title:'订单统计',dashboardId:'statistics'};
const widgets=[{id:'total',title:'订单总数',kind:'metric',metric:{valueColumn:'n'}},{id:'stages',title:'阶段统计',kind:'table',table:{columns:['stage']}}].map(w=>({format:'teloa.business-widget/v1',version:'1.0.0',domain:'sales',query:'select 1',...w}));
const configuration={scope:'sales',version:1,hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:'sales',title:'客户订单',sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'order',version:1,definitionHash:hash},{kind:'dashboard',localId:'statistics',version:1,definitionHash:hash},...widgets.map(w=>({kind:'widget',localId:w.id,version:1,definitionHash:hash}))],pages:[records,dashboardDefinition],homePageId:'orders'}};
const dashboardPage={scope:'sales',mode:'saved',configurationVersion:1,configurationHash:hash,page:{kind:'dashboard',definition:dashboardDefinition,dashboard:{format:'teloa.business-dashboard/v1',id:'statistics',version:'1.0.0',domain:'sales',title:'订单统计',widgets:widgets.map(w=>w.id),layout:widgets.map((w,i)=>({widget:w.id,x:0,y:i*2,w:12,h:2})),refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false},widgets,viewRefs:[],timeRange:'all',results:widgets.map((w,i)=>({widgetId:w.id,definitionHash:hash,computedAt:stamp,status:'ok',columns:[{name:i===0?'n':'stage',type:i===0?'number':'text'}],rows:[[i===0?0:'none']],rowCount:1,truncated:false,bytes:1,stale:false}))}};
const configurationApi=createBusinessBuilderApi(async(endpoint,input)=>{evidence.calls.push(endpoint+(input.pageId?':'+input.pageId:''));if(endpoint.endsWith('/current'))return evidence.mode==='configured'?configuration:null;return dashboardPage});
const unsupported=()=>{throw {code:'teloa/dependency-unavailable',message:'旧业务台账与 SQL 尚不支持富字段配置，请使用记录页面。'}};
const dashboardApi={list:async({scope})=>{evidence.calls.push('legacy-list:'+scope);if(evidence.mode!=='legacy-empty')unsupported();return []}};
const services={groups:{list:async()=>({items:[]})},attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:true,tasksFailed:false,attentionKnown:true,attentionFailed:false,refresh:()=>{},openGroup:()=>{},createGroup:()=>{},talkRole:async()=>{},openAttention:()=>{},renderRole:()=>null};
const state={tasks:[],roles:[]};
function App(){const [mode,setMode]=useState('configured');return <I18nProvider runtime={runtime}><aside><button onClick={()=>{evidence.mode='legacy-empty';evidence.calls.length=0;setMode('legacy-empty')}}>测试旧业务</button></aside><BusinessWorkspace key={mode} scope="sales" title="客户订单" target={{scope:'sales',section:'overview'}} state={state} services={services} dashboardApi={dashboardApi} configurationApi={configurationApi} go={()=>{}} back={()=>{}} start={()=>{}} configure={()=>{}} staff={()=>{}} openTask={()=>{}} openWork={()=>{}} colorScheme="light"><p>业务内容</p></BusinessWorkspace></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`)
  const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'OverviewDashboardSummaryFixture',formats:['iife']}}})
  const output=Array.isArray(result)?result[0]:result;assert.ok(output&&'output' in output)
  const script=output.output.find(item=>item.type==='chunk')!.code,styles=output.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
  browser=await loadPlaywright().chromium.launch(launchOptions())
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors:string[]=[]
  page.setDefaultTimeout(6000)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port
  page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>route.request().url().startsWith(url+'/')?route.continue():route.abort())
  await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
  const panel=page.locator('section').filter({has:page.getByRole('heading',{name:'统计看板',exact:true})}).last()
  const calls=()=>page.evaluate(()=>(window as any).summaryFixture.calls)

  // 整体配置管理：与「统计看板」分区同源读取正式看板页（首页是记录页时取第一张看板页），不调用旧看板服务。
  await panel.getByRole('heading',{name:'订单统计',exact:true}).waitFor()
  for(const title of ['订单总数','阶段统计'])await panel.getByRole('heading',{name:title,exact:true}).waitFor()
  assert.deepEqual(await calls(),['business-configuration/current','business-configuration/page:statistics'],'只读 current 与看板页；不读首页记录页，不调旧 list')
  assert.doesNotMatch(await panel.innerText(),/暂时无法加载|读取失败|重试/)
  assert.equal(await panel.locator('nav').count(),0,'摘要不重复完整配置页的页面导航')
  assert.equal(await panel.locator('h1').count(),0,'摘要不重复完整页头部')
  if(process.env.TELOA_SCREENSHOT_DIR)await panel.screenshot({path:join(process.env.TELOA_SCREENSHOT_DIR,'overview-configured-summary.png')})

  // current===null 的旧业务：仍走旧 dashboardApi。
  await page.getByRole('button',{name:'测试旧业务',exact:true}).click()
  await panel.getByText('尚未配置统计看板',{exact:true}).waitFor()
  assert.deepEqual(await calls(),['business-configuration/current','legacy-list:sales'])
  assert.deepEqual(errors,[])
 }finally{
  await browser?.close();server.close();await rm(temp,{recursive:true,force:true})
 }
})
