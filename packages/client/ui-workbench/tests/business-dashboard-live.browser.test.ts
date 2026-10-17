import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无界面浏览器加载夹具为 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

/** 真 React/CSS、协议读取器与无头浏览器；数据源为隔离夹具，不访问运行实例。 */
test('看板真实界面：失败仍显示旧统计，自动读取恢复新成果，导航没有附加步骤',{timeout:60000},async()=>{
 const client=fileURLToPath(new URL('../src/client/',import.meta.url)),root=fileURLToPath(new URL('../../../../',import.meta.url))
 await mkdir(join(client,'../../.runtime'),{recursive:true})
 const temp=await mkdtemp(join(client,'../../.runtime/business-live-'))
 let browser:any
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<html lang="zh-CN"><head></head><body><div id="root"></div></body></html>')})
 try{
  const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {readBusinessDashboardPage} from '@teloa/contract';
import {BusinessDashboardPage} from '${client}BusinessDashboardPage.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const widget={format:'teloa.business-widget/v1',id:'triaged-count',version:'1.0.0',domain:'SOC',title:'已研判告警',kind:'metric',query:'select count(*) as value from triage_result',metric:{valueColumn:'value'}};
const dashboard={format:'teloa.business-dashboard/v1',id:'soc-overview',version:'1.0.0',domain:'SOC',title:'安全运营大盘',widgets:[widget.id],layout:[{widget:widget.id,x:0,y:0,w:12,h:2}],refresh:{kind:'every',seconds:300},acknowledgeShortInterval:false};
const state=window.liveFixture={phase:'initial',reads:0,refreshes:0,go:[]};
const page=()=>readBusinessDashboardPage({schema:'teloa.business-dashboard-page/v1',scope:'SOC',dashboard,widgets:[widget],results:[{widgetId:widget.id,definitionHash:'a'.repeat(64),computedAt:'2026-10-10T01:00:00.000Z',status:'ok',columns:[{name:'value',type:'number'}],rows:[[state.phase==='new'?2:1]],rowCount:1,truncated:false,bytes:3,stale:state.phase==='failed',...(state.phase==='failed'?{refreshError:{code:'teloa/source-unavailable',reason:'来源暂不可用'}}:{})}],updatedAt:'2026-10-10T01:00:00.000Z',nextRefreshAt:'2026-10-10T01:05:00.000Z',refreshing:false,timeRange:null},'SOC');
const api={read:async()=>{state.reads++;return page()},refresh:async()=>{state.refreshes++;state.phase='failed';return page()}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><BusinessDashboardPage scope="SOC" dashboardId="soc-overview" api={api} colorScheme="light" back={()=>state.go.push('back')} go={target=>state.go.push(target)}/></I18nProvider>);
`
  await writeFile(join(temp,'fixture.tsx'),entry)
  const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'DashboardLiveFixture',formats:['iife']}}})
  const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output' in bundle)
  const script=bundle.output.find(item=>item.type==='chunk')!.code,css=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
  browser=await loadPlaywright().chromium.launch(launchOptions())
  const page=await browser.newPage({viewport:{width:1440,height:900}}),errors:string[]=[],requests:string[]=[]
  page.setDefaultTimeout(8000)
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
  const url='http://127.0.0.1:'+(server.address() as {port:number}).port
  page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{if(route.request().url().startsWith(url+'/'))return route.continue();requests.push(route.request().url());return route.abort()})
  await page.goto(url)
  assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'function')
  await page.addStyleTag({content:css});await page.addScriptTag({content:script})
  await page.getByRole('heading',{name:'已研判告警'}).waitFor().catch(async (error:unknown)=>{await page.screenshot({path:'/tmp/teloa-object-live-failed.png'});throw Error(String(error)+' '+JSON.stringify(errors)+' '+await page.locator('body').innerText())})
  await page.getByRole('button',{name:'手动刷新',exact:true}).click()
  await page.locator('[data-widget-refresh-failed="triaged-count"]').waitFor().catch(async (error:unknown)=>{throw Error(String(error)+' '+JSON.stringify(errors)+' '+await page.locator('body').innerText()+' '+JSON.stringify(await page.evaluate(()=>(window as any).liveFixture)))})
  assert.match(await page.locator('body').innerText(),/上次统计/)
  await page.evaluate(()=>{(window as any).liveFixture.phase='new'})
  await page.waitForFunction(()=>!(document.querySelector('[data-widget-refresh-failed]'))&&(window as any).liveFixture.reads>=2,{},{timeout:8000})
  assert.match(await page.locator('body').innerText(),/2/)
  await page.screenshot({path:'/tmp/teloa-object-live-dashboard.png',fullPage:true})
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
  assert.equal(await page.evaluate(()=>(window as any).liveFixture.refreshes),1)
 }finally{await browser?.close();if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));await rm(temp,{recursive:true,force:true})}
})
