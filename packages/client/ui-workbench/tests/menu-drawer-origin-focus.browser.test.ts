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
 const menuFixture=window.menuFixture={calls:[],modelNavigations:0},write=name=>{menuFixture.calls.push(name);throw Error('Unexpected write')},retrievalStatus={items:[],enrolled:0,chunks:0,building:false},retrievalApi={status:async()=>retrievalStatus,modelStatus:async()=>({enabled:false,provider:null,building:false,guidance:null}),enroll:()=>write('enroll'),remove:()=>write('remove'),reindex:()=>write('reindex'),cancel:()=>write('cancel'),prepare:()=>write('prepare')};
 function App(){const [drawer,setDrawer]=useState(null),[drafts,setDrafts]=useState({}),[scope,setScope]=useState('SOC');menuFixture.scope=setScope;return <I18nProvider runtime={runtime}><div style={{display:'flex',height:900}}><WorkNavigation view="messages" colorScheme="light" actions={actions} work={work} management={management} useSessions={fn=>fn(native)} create={noop} creating={false} needCount={0} createTask={noop} createGroup={()=>setDrawer('新建协作群')} openTwin={async()=>{}} setTheme={noop}/><main id="teloa-main" tabIndex={-1} style={{flex:1}}><BusinessMoreMenu scope={scope} choose={(action,scope)=>{if(action==='sources'&&scope==='SOC')setDrawer('业务资源')}}/><textarea aria-label="原任务输入" defaultValue="原工作草稿"/><LocalRetrievalResources api={retrievalApi} visible onModelSettings={()=>{menuFixture.modelNavigations++}}/></main>{drawer&&<ContextDrawer title={drawer} close={()=>setDrawer(null)}><label>当前窗口草稿<input value={drafts[drawer]??''} onChange={event=>setDrafts({...drafts,[drawer]:event.target.value})}/></label></ContextDrawer>}</div></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'menu-drawer-origin-fixture',resolveId:id=>id.endsWith('menu-drawer-origin-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'menu-drawer-origin-fixture',name:'MenuDrawerOriginFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(row=>row.type==='chunk')!.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})

test('资料状态入口请求统一本地模型设置，保留原草稿且不启用或修改模型',async t=>{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const panel=page.locator('[data-retrieval-resources]'),trigger=panel.getByRole('button',{name:'去启用',exact:true})
 await trigger.waitFor();await panel.getByText('未启用',{exact:true}).waitFor();assert.equal(await panel.locator('[data-retrieval-more]').count(),0,'未加入资料时不显示无用更多菜单')
 await trigger.click();await page.waitForFunction(()=>(window as any).menuFixture.modelNavigations===1)
 assert.deepEqual(await page.evaluate(()=>(window as any).menuFixture.calls),[],'设置导航不启用、下载、重建或加入资料')
 assert.equal(await page.getByRole('dialog').count(),0,'不复活旧本地检索抽屉；实际设置页面由统一导航端口承接')
 assert.equal(await panel.getByRole('button',{name:'检索设置',exact:true}).count(),0)
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

test('通用工作菜单三项与正式业务九项顺序一致，Escape不选择动作',async t=>{
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(4000);t.after(()=>page.close())
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const menu=page.locator('main > details'),trigger=menu.locator(':scope > summary')
 await page.evaluate(()=>(window as any).menuFixture.scope('general'));await trigger.click()
 assert.deepEqual(await menu.getByRole('button').allTextContents(),['当前业务任务','已完成任务','自动化'])
 await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('main > details')?.hasAttribute('open'))
 assert.equal(await page.getByRole('dialog').count(),0)
 await page.evaluate(()=>(window as any).menuFixture.scope('SOC'));await trigger.click()
 assert.deepEqual(await menu.getByRole('button').allTextContents(),['调整业务定义','数据连接','业务资源','手动定义','分享业务配置','已完成任务','当前业务任务','变更集复核','业务团队'])
 assert.equal(await menu.getByRole('button',{name:'业务看板',exact:true}).count(),0,'看板按正式业务页面进入，不保留旧第十项')
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('dialog').count(),0)
})
