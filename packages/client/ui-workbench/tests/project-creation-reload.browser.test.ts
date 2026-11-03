import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('项目新建草稿经真实页面刷新保留，提交和恢复不重复创建',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-project-reload-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {ProjectOverviewPage} from ${JSON.stringify(join(client,'ProjectOverviewPage.tsx'))};import {ProjectWorkspace} from ${JSON.stringify(join(client,'ProjectWorkspace.tsx'))};import {createProjectApi} from ${JSON.stringify(join(client,'project-api.ts'))};import {createProjectCreationDrafts} from ${JSON.stringify(join(client,'project-creation-drafts.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 let failWrites=false;window.fixture={failWrites:value=>{failWrites=value}};const storage={getItem:key=>sessionStorage.getItem(key),setItem:(key,value)=>{if(failWrites)throw Error('quota');sessionStorage.setItem(key,value)},removeItem:key=>sessionStorage.removeItem(key)};
 const drafts=createProjectCreationDrafts({storage,identity:async()=>'10000000-0000-4000-8000-000000000001',generation:()=>1});const journal={read:()=>sessionStorage.getItem('test-project-pending'),write:value=>sessionStorage.setItem('test-project-pending',value),clear:()=>sessionStorage.removeItem('test-project-pending')};const api=createProjectApi(async(endpoint,input)=>{const response=await fetch('/project-reload-rpc',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({endpoint,input})});return response.json()},journal,undefined,undefined,drafts);
 const locale='en',snapshot={locale,dshLocale:'en',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},labels=['general','SOC'].map(scope=>({scope,title:scope,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}));const opened=row=>{window.opened=row};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}>{location.search.includes('workspace')?<ProjectWorkspace api={api} scope="general" typeName="Projects" select={id=>opened({id})} back={()=>{}} openItem={()=>{}} scopeLabels={labels}/>:<ProjectOverviewPage api={api} scopeLabels={labels} labelsReady scopeName={s=>s} navigation={{state:{},change:()=>{}}} open={opened} visible/>}</I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ProjectReloadTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const setup=async(view:string)=>{
  const page=await browser.newPage({viewport:{width:1280,height:1000}});page.setDefaultTimeout(5000)
  const errors:string[]=[],calls:Array<{endpoint:string;input:any}>=[],rows:any[]=[],byRequest=new Map<string,any>();let loseReply=false
  page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',async(route:any)=>{
   const url=new URL(route.request().url());if(url.origin!=='http://127.0.0.1')return route.abort()
   if(url.pathname==='/project-reload-test')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><head><link rel="stylesheet" href="/project-reload-style"></head><body><div id="root"></div><script src="/project-reload-script"></script></body></html>'})
   if(url.pathname==='/project-reload-script')return route.fulfill({contentType:'text/javascript',body:script})
   if(url.pathname==='/project-reload-style')return route.fulfill({contentType:'text/css',body:styles})
   if(url.pathname!=='/project-reload-rpc')return route.abort()
   const request=route.request().postDataJSON();calls.push(request);const {endpoint,input}=request;let value:unknown
   if(endpoint==='projects/list')value=rows.filter(row=>row.scope===input.scope)
   else if(endpoint==='projects/overview')value={rows,nextCursor:null}
   else if(endpoint==='projects/get')value={project:rows.find(row=>row.id===input.projectId),items:[],references:[],summary:{totalTasks:0,completedTasks:0,cancelledTasks:0,attentionTasks:0}}
   else if(endpoint==='projects/create'){
    value=byRequest.get(input.requestId)
    if(!value){value={...input.fields,id:'20000000-0000-4000-8000-'+String(rows.length+1).padStart(12,'0'),ownerId:'self',version:1,createdAt:'2026-10-25T00:00:00Z',updatedAt:'2026-10-25T00:00:00Z'};byRequest.set(input.requestId,value);rows.push(value)}
    if(loseReply){loseReply=false;return route.abort()}
   }else throw Error('Unexpected fixture endpoint: '+endpoint)
   return route.fulfill({contentType:'application/json',body:JSON.stringify(value)})
  })
  const go=async(next=view)=>{await page.goto('http://127.0.0.1/project-reload-test?'+next);await page.getByRole('button',{name:'New project',exact:true}).first().waitFor()}
  await go();return {page,errors,calls,rows,go,loseReply:()=>{loseReply=true}}
 }
 for(const view of ['overview','workspace'])await t.test(view+'刷新恢复原文/手改标题/日期且不自动发送，成功仅清本入口',async()=>{
  const s=await setup(view),{page}=s
  try{
   const open=()=>page.getByRole('button',{name:'New project',exact:true}).first().click(),dialog=page.getByRole('dialog',{name:'New project',exact:true}),goal='# Draft after reload\n\nKeep **the whole** description.\n'
   await open();await dialog.getByLabel('Project description',{exact:true}).fill(goal);await dialog.getByLabel('Project name',{exact:true}).fill('Reviewed title');await dialog.locator('summary').click();await dialog.getByLabel('Due date (optional)',{exact:true}).fill('2026-10-31')
   await page.reload();await open();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),goal);assert.equal(await dialog.getByLabel('Project name',{exact:true}).inputValue(),'Reviewed title');assert.equal(await dialog.getByLabel('Due date (optional)',{exact:true}).inputValue(),'2026-10-31');assert.equal(s.calls.filter(row=>row.endpoint==='projects/create').length,0)
   await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'New project',exact:true}).first().evaluate((node:HTMLElement)=>node===document.activeElement),true,'异步恢复草稿不破坏关闭后的入口焦点');await s.go(view==='overview'?'workspace':'overview');await open();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'');await dialog.getByLabel('Project description',{exact:true}).fill('Keep other entry');await page.keyboard.press('Escape')
   await s.go();await open();await dialog.getByRole('button',{name:'New project',exact:true}).click();await dialog.waitFor({state:'detached'});assert.equal(s.rows.length,1)
   await page.reload();await open();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'');await page.keyboard.press('Escape');await s.go(view==='overview'?'workspace':'overview');await open();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'Keep other entry');assert.deepEqual(s.errors,[])
  }finally{await page.close()}
 })
 for(const view of ['overview','workspace'])for(const reload of [true,false])await t.test(view+'已创建但回包丢失，'+(reload?'刷新':'同页')+'找回后清草稿而不重复创建',async()=>{
  const s=await setup(view),{page}=s
  try{
   const open=()=>page.getByRole('button',{name:'New project',exact:true}).first().click(),dialog=page.getByRole('dialog',{name:'New project',exact:true})
   await open();await dialog.getByLabel('Project description',{exact:true}).fill('Create once');s.loseReply();await dialog.getByRole('button',{name:'New project',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal(s.rows.length,1)
   if(reload)await page.reload();else await page.keyboard.press('Escape');await page.getByRole('button',{name:'Recover project',exact:true}).click();await page.waitForFunction(()=>(window as any).opened?.id);assert.equal(s.rows.length,1);const requests=s.calls.filter(row=>row.endpoint==='projects/create');assert.equal(requests.length,2);assert.deepEqual(requests[0]!.input,requests[1]!.input)
   await open();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'');await page.reload();await open();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'');assert.deepEqual(s.errors,[])
  }finally{await page.close()}
 })
 for(const view of ['overview','workspace'])await t.test(view+'浏览器写入失败关闭重开仍保留内存草稿，并显示提示、不自动创建',async()=>{
  const s=await setup(view),{page}=s
  try{
   await page.getByRole('button',{name:'New project',exact:true}).first().click();await page.evaluate(()=>(window as any).fixture.failWrites(true));const dialog=page.getByRole('dialog',{name:'New project',exact:true});await dialog.getByLabel('Project description',{exact:true}).fill('Keep input while storage is unavailable');await dialog.getByRole('alert').waitFor();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'Keep input while storage is unavailable');await page.keyboard.press('Escape');await page.getByRole('button',{name:'New project',exact:true}).first().click();assert.equal(await dialog.getByLabel('Project description',{exact:true}).inputValue(),'Keep input while storage is unavailable');assert.equal(s.rows.length,0);assert.deepEqual(s.errors,[])
  }finally{await page.close()}
 })
})
