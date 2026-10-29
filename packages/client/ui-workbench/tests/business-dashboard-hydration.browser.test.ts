import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {createServer} from 'node:http'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {packageBusinessDashboardResource} from '../src/client/business-dashboard-resource-api.ts'
import {dashboardResourceFixture} from './fixtures/business-dashboard-resource.ts'
// @ts-expect-error 复用本工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('看板详情先挂载后异步取得正文，首次生成使用实际选中的资源身份',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-dashboard-hydration-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 const resource=dashboardResourceFixture(),item=await packageBusinessDashboardResource(resource,{title:'行业看板',description:'异步加载验收'})
 const serialized=JSON.stringify({...item,contentStorage:{contentId:'11111111-1111-4111-8111-111111111111'}},(_key,value)=>value instanceof Uint8Array?{bytes:[...value]}:value)
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {BusinessDashboardMarketPanel} from '${client}/BusinessDashboardMarketPanel.tsx';import {I18nProvider} from '${client}/i18n/provider.tsx';import {translateMessage} from '${client}/i18n/messages.ts';
 const item=JSON.parse(${JSON.stringify(serialized)},(_key,value)=>value&&Object.keys(value).length===1&&Array.isArray(value.bytes)?new Uint8Array(value.bytes):value),calls=[];window.calls=calls;
 const runtime={t:(key,params)=>translateMessage('zh-CN',key,params),getSnapshot:()=>snapshot,subscribe:()=>()=>{}},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};
 const api={current:async()=>null,prepare:async input=>{calls.push(input);return {id:'22222222-2222-4222-8222-222222222222',status:'draft',revision:1,baseVersion:0,hash:'a'.repeat(64),scope:'business_test',candidate:${JSON.stringify(resource.configuration)}}}};
 function App(){const [hydrated,setHydrated]=React.useState(false),[defaultTitle,setDefaultTitle]=React.useState(undefined);window.hydrate=()=>setHydrated(true);window.setDefaultTitle=setDefaultTitle;return <I18nProvider runtime={runtime}><BusinessDashboardMarketPanel item={hydrated?item:{...item,packageContent:undefined}} defaultTitle={defaultTitle} api={api} spaces={[{scope:'legacy',title:'旧业务'}]} openSaved={scope=>{window.openedBusiness=scope}} colorScheme='light'/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 await writeFile(join(temp,'entry.tsx'),entry)
 const result=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),formats:['iife'],name:'DashboardHydration'},rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code
 const server=createServer((_req,res)=>res.end('<!doctype html><div id="root"></div>'));await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const address=server.address();assert.ok(address&&typeof address!=='string');const origin='http://127.0.0.1:'+address.port
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage(),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(origin)?route.continue():route.abort())
 await page.goto(origin);await page.addScriptTag({content:script});await page.waitForFunction(()=>typeof (window as any).hydrate==='function')
 assert.equal(await page.getByRole('button',{name:'生成配置草稿',exact:true}).count(),0)
 await page.evaluate(()=>(window as any).hydrate());const prepare=page.getByRole('button',{name:'生成配置草稿',exact:true});await prepare.waitFor()
 assert.equal(await page.getByRole('combobox',{name:'看板',exact:true}).inputValue(),resource.id)
 // 默认名称：目录多语言标题异步到达时，本人未改名则采用；本人改过的名称不被覆盖。
 const name=page.getByLabel('名称',{exact:true})
 assert.equal(await name.inputValue(),'行业看板')
 await page.evaluate(()=>(window as any).setDefaultTitle('Industry dashboard'));await page.waitForFunction(()=>(document.querySelector('label input') as HTMLInputElement|null)?.value==='Industry dashboard')
 await name.fill('行业看板');await page.evaluate(()=>(window as any).setDefaultTitle('Another title'));await page.waitForTimeout(100)
 assert.equal(await name.inputValue(),'行业看板')
 // 旧业务缺少正式配置时提供可执行迁移起点，并明确原对象保留。
 await page.getByRole('combobox',{name:'采用到业务',exact:true}).selectOption('legacy')
 await page.getByText('此旧业务尚未采用正式配置。',{exact:false}).waitFor()
 assert.equal(await prepare.isDisabled(),true)
 await page.getByRole('button',{name:'打开业务',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).openedBusiness),'legacy')
 await page.getByRole('button',{name:'新建业务',exact:true}).click()
 assert.equal(await page.getByRole('combobox',{name:'采用到业务',exact:true}).inputValue(),'')
 assert.equal(await prepare.isEnabled(),true)
 await prepare.click();await page.waitForFunction(()=>(window as any).calls.length===1,{},{timeout:2000})
 const calls=await page.evaluate(()=>(window as any).calls);assert.equal(calls[0].resourceId,resource.id);assert.equal(calls[0].contentId,'11111111-1111-4111-8111-111111111111');assert.equal(calls[0].contentHash,item.packageContent!.hash);assert.deepEqual(calls[0].target,{kind:'new',title:'行业看板'});assert.deepEqual(errors,[])
})
