import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// 同时加载真实市场父容器与安装子页，避免孤立组件通过后仍被父级按钮规则撑大。
test('安装目录共用紧凑页头；空态留白、筛选返回和扩展状态保持',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-installation-layout-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';import {MarketPage} from ${JSON.stringify(join(client,'MarketPage.tsx'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import {BusinessScopeProvider} from ${JSON.stringify(join(client,'business-scope-context.tsx'))};
 import {ThemePresenter} from ${JSON.stringify(join(client,'theme-presenter.ts'))};import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};
 document.body.classList.add(tokens.tokens);const theme=new ThemePresenter();theme.apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14,code:11,terminal:13}});
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const fixture=window.installationFixture={writes:0,browses:0,plugins:[],fail:false};window.setInstallationTheme=scheme=>theme.apply({active:{colorScheme:scheme,tokens:{}},fontSizes:{text:14,code:11,terminal:13}});
 const row={id:'11111111-1111-4111-8111-111111111111',ownerId:'fixture',source:{kind:'atomic',contentId:'22222222-2222-4222-8222-222222222222',contentHash:'a'.repeat(64),resourceId:'method',resourceVersion:'1.0.0'},bundleHash:'b'.repeat(64),native:{name:'研究与事实核查方法',description:'核对资料。',modelInvocable:true,userInvocable:true,bodyHash:'c'.repeat(64)},state:'installed',version:2,createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z'};
 const write=async()=>{fixture.writes++;throw Error('本用例禁止安装或启用')};
 const skills={list:async()=>({items:[row],usages:[]}),get:async()=>row,pending:()=>undefined,recoveryMessage:()=>undefined,install:write};
 const plugins={list:async()=>{if(fixture.fail)throw {code:'teloa/source-unavailable'};return {items:fixture.plugins}},pending:()=>undefined,recoveryMessage:()=>undefined,preview:write,install:write,reconcile:write};
 window.addInstallationRecord=()=>{fixture.plugins=[{id:'33333333-3333-4333-8333-333333333333',ownerId:'fixture',preview:{schema:'teloa.market-plugin-install-preview/v1',source:{registry:'npm',packageName:'@example/extension-with-a-long-but-complete-package-name',version:'1.2.3'},trust:{status:'unverified',publisher:'Example',integrity:'sha512-fixture'},bundleHash:'d'.repeat(64),permissionSummary:{permissions:[]}},state:'unknown',attempt:1,createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z'}]};
 function App(){const [selected,setSelected]=React.useState('plugin:directory'),[state,setState]=React.useState({items:[],intents:[]});return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[]}><MarketPage visible state={state} change={setState} itemId={null} intentId={null} open={()=>{}} seed={null} clearSeed={()=>{}} installations={{visible:true,selected,open:id=>setSelected(id??'skill:directory'),market:()=>fixture.browses++}} skillInstallApi={skills} marketPluginInstallApi={plugins} industryLoads={{loads:[],error:undefined,save:write,recover:write}} industryReview={{loads:[],upgrade:write,rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:()=>{}}} saveResolved={()=>{}} spaces={[]} targets={[]} planFromTemplate={()=>{}} manageIndustryLoad={()=>{}} update={()=>{}} prepare={write} capabilities={()=>{}} nativeSettings={()=>{}} nativeModels={()=>{}} openRole={()=>{}} configureBinding={()=>{}} openTarget={()=>{}} githubSourceApi={{pending:()=>undefined,recoveryMessage:()=>undefined}}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'InstallationLayout',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:'body{margin:0;font:14px system-ui}#root{height:100vh}*{box-sizing:border-box}'+styles});await page.addScriptTag({content:script})
 const shell=page.getByRole('region',{name:'已安装',exact:true}),nav=shell.getByRole('navigation',{name:'安装维护分类'})
 const empty=shell.getByRole('heading',{name:'暂无应用安装记录',exact:true});await empty.waitFor().catch(async(error:unknown)=>{console.error(JSON.stringify({body:(await page.locator('body').innerText()).slice(0,3000),errors}));throw error})
 assert.equal(await shell.locator('h1').count(),1);assert.deepEqual(await nav.getByRole('button').allTextContents(),['技能','应用'])
 const back=shell.getByRole('button',{name:'返回市场',exact:true}),refresh=shell.getByRole('button',{name:'刷新',exact:true})
 for(const control of [back,refresh]){
  const f=await control.evaluate((e:HTMLElement)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {width:r.width,height:r.height,border:s.borderTopWidth,text:e.innerText}})
  assert.deepEqual(f,{width:32,height:32,border:'0px',text:''},'父子容器不覆盖共同图标按钮')
 }
 const ebox=await empty.boundingBox(),sbox=await shell.boundingBox();assert.ok(ebox&&sbox)
 assert.ok(ebox.x-sbox.x>=24,'空态不得贴左边');assert.ok(Math.abs(ebox.x+ebox.width/2-(sbox.x+sbox.width/2))<2,'空态与内容居中')
 assert.ok(ebox.y<450,'页头不堆成大幅横幅');await shell.getByRole('button',{name:'浏览市场',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).installationFixture.browses),1)
 await nav.getByRole('button',{name:'技能',exact:true}).click();const search=shell.getByRole('textbox',{name:'搜索真实技能安装'});await search.fill('无匹配内容')
 await shell.getByRole('heading',{name:'没有匹配记录',exact:true}).waitFor();assert.equal(await shell.getByRole('button',{name:'浏览市场',exact:true}).count(),0)
 await nav.getByRole('button',{name:'应用',exact:true}).click();await empty.waitFor();await nav.getByRole('button',{name:'技能',exact:true}).click();assert.equal(await search.inputValue(),'无匹配内容','切换分类保留筛选')
 await search.fill('研究');await shell.getByRole('button',{name:'打开真实技能安装：研究与事实核查方法'}).waitFor()
 await nav.getByRole('button',{name:'应用',exact:true}).click();await page.evaluate(()=>{(window as any).addInstallationRecord();(window as any).setInstallationTheme('dark')});await refresh.click()
 const record=shell.getByRole('button',{name:/@example\/extension-with-a-long/});await record.waitFor();assert.match(await record.innerText(),/1\.2\.3/);assert.match(await record.innerText(),/未确认|未知/)
 await page.setViewportSize({width:800,height:800});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await page.evaluate(()=>(window as any).installationFixture.fail=true);await refresh.click();await shell.getByRole('alert').waitFor();assert.equal(await record.count(),1,'刷新失败仍保留原记录');assert.equal(await empty.count(),0,'失败不冒充空目录')
 await page.evaluate(()=>(window as any).installationFixture.fail=false);await refresh.click();await record.click();await shell.getByRole('button',{name:'返回安装目录',exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).installationFixture.writes),0)
 await shell.getByRole('button',{name:'返回安装目录',exact:true}).press('Enter');await record.waitFor();assert.equal(await page.evaluate(()=>(window as any).installationFixture.writes),0);assert.deepEqual(errors,[])
})
