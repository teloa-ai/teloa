import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__menu_drawer_origin_fixture.tsx'
let browser:any,script:string,styles:string
before(async()=>{
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {BusinessMoreMenu} from '${client}BusinessMoreMenu.tsx';import {WorkNavigation} from '${client}WorkNavigation.tsx';import {ContextDrawer} from '${client}ContextDrawer.tsx';import {LocalRetrievalResources} from '${client}LocalRetrievalResources.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const noop=()=>{},directory={rows:[],status:'ready'},managed={ready:true,baseline:true,archived:[],workspaces:[],pending:{}},native={byId:{},ids:[]},work={subscribe:()=>noop,getDirectorySnapshot:()=>directory,getSnapshot:()=>({})},management={subscribe:()=>noop,getSnapshot:()=>managed},actions=new Proxy({},{get:()=>noop}),snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
 const retrievalStatus={items:[],enrolled:0,chunks:0,building:false},retrievalApi={status:async()=>retrievalStatus,modelStatus:async()=>({enabled:false,provider:null,building:false,guidance:null})};
 function App(){const [drawer,setDrawer]=useState(null),[drafts,setDrafts]=useState({});return <I18nProvider runtime={runtime}><div style={{display:'flex',height:900}}><WorkNavigation view="messages" colorScheme="light" actions={actions} work={work} management={management} useSessions={fn=>fn(native)} create={noop} creating={false} needCount={0} createTask={noop} createGroup={()=>setDrawer('新建协作群')} openTwin={async()=>{}} setTheme={noop}/><main id="teloa-main" tabIndex={-1} style={{flex:1}}><BusinessMoreMenu scope="SOC" choose={(action,scope)=>{if(action==='sources'&&scope==='SOC')setDrawer('业务资源')}}/><textarea aria-label="原任务输入" defaultValue="原工作草稿"/><LocalRetrievalResources api={retrievalApi} visible/></main>{drawer&&<ContextDrawer title={drawer} close={()=>setDrawer(null)}><label>当前窗口草稿<input value={drafts[drawer]??''} onChange={event=>setDrafts({...drafts,[drawer]:event.target.value})}/></label></ContextDrawer>}</div></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'menu-drawer-origin-fixture',resolveId:id=>id.endsWith('menu-drawer-origin-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'menu-drawer-origin-fixture',name:'MenuDrawerOriginFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})

test('本地检索设置从菜单打开真实设置抽屉，关闭回更多入口且不启用或修改模型',async t=>{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const trigger=page.locator('[data-retrieval-more]>summary')
 for(const dismissal of ['Escape','关闭','外点']){
  await trigger.click();await page.getByRole('button',{name:'检索设置',exact:true}).click();const drawer=page.getByRole('dialog',{name:'本地检索',exact:true});await drawer.waitFor()
  if(dismissal==='Escape')await page.keyboard.press('Escape');else if(dismissal==='关闭')await drawer.getByRole('button',{name:'关闭',exact:true}).click();else await page.mouse.click(8,450)
  assert.equal(await drawer.getByRole('alert').count(),0);await drawer.waitFor({state:'hidden'});assert.equal(await trigger.evaluate((node:HTMLElement)=>document.activeElement===node),true,'关闭设置后应返回检索更多入口')
 }
 assert.equal(await page.getByRole('textbox',{name:'原任务输入',exact:true}).inputValue(),'原工作草稿')
})
after(async()=>{await browser?.close()})

for(const origin of ['业务资源','新建协作群'])test(`${origin}菜单打开抽屉，关闭后焦点回可见入口且保留草稿`,async t=>{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/menu-origin'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/menu-origin');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const trigger=origin==='业务资源'?page.locator('main > details > summary'):page.getByRole('button',{name:'新建',exact:true})
 const choose=()=>origin==='业务资源'?page.getByRole('button',{name:origin,exact:true}).click():page.getByRole('menuitem',{name:origin,exact:true}).click()
 for(const dismissal of ['Escape','关闭','外点']){
  await trigger.click();await choose();const drawer=page.getByRole('dialog',{name:origin,exact:true});await drawer.waitFor();const draft=drawer.getByRole('textbox',{name:'当前窗口草稿',exact:true})
  if(dismissal==='Escape')await draft.fill(origin+'原草稿');else assert.equal(await draft.inputValue(),origin+'原草稿')
  if(dismissal==='Escape')await page.keyboard.press('Escape');else if(dismissal==='关闭')await drawer.getByRole('button',{name:'关闭',exact:true}).click();else await page.mouse.click(8,450)
  await drawer.waitFor({state:'hidden'});assert.equal(await trigger.evaluate((node:HTMLElement)=>document.activeElement===node),true,'关闭后必须回到可见的菜单入口，不能落到根节点或已隐藏的菜单动作')
 }
 assert.equal(await page.getByRole('textbox',{name:'原任务输入',exact:true}).inputValue(),'原工作草稿')
})
