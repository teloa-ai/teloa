import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// N31：去往具体对象的跳转是轻量文字链接，标题内返回是弱化文字加箭头，刷新是带名称与提示的图标；
// 都放在任务页真实容器（.page 与 .dialog）里，确认不被容器的描边按钮样式覆盖，原跳转回调不变。
test('轻量跳转、标题内返回与图标刷新在任务页容器中保持轻量且可键盘使用',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-light-actions-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {ArrowLeft,RefreshCw} from 'lucide-react';
 import {TaskCompletion} from ${JSON.stringify(join(client,'TaskCompletion.tsx'))};import {ToolbarIconButton} from ${JSON.stringify(join(client,'ToolbarIconButton.tsx'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import page from ${JSON.stringify(join(client,'TaskPage.module.css'))};import light from ${JSON.stringify(join(client,'light-actions.module.css'))};import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const calls=window.lightFixture=[];
 const task={id:'task-1',storage:'persistent',state:'completed',version:2,title:'整理周报',assigneeId:'self',updatedAt:'2026-10-15T00:00:00Z'};
 const api={list:async()=>[],read:async()=>({taskId:'task-1',taskVersion:2,artifactId:'artifact-1',artifactVersion:3,note:'已交付周报',completedAt:'2026-10-15T01:00:00Z'}),complete:async()=>{}};
 const sample=label=><>
  <button type="button" className={light.back} onClick={()=>calls.push(['back',label])}><ArrowLeft size={14} aria-hidden/>返回所属计划</button>
  <ToolbarIconButton label={'刷新 · '+label} icon={RefreshCw} onClick={()=>calls.push(['refresh',label])}/>
 </>;
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}>
  <main className={page.page} aria-label="页面容器">{sample('page')}<TaskCompletion task={task} api={api} open={ref=>calls.push(['open',ref.id,ref.version])}/></main>
  <section className={page.dialog} aria-label="对话框容器">{sample('dialog')}</section>
 </I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'LightActionsTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/light-actions'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/light-actions');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const style=(locator:any)=>locator.evaluate((node:HTMLElement)=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return {border:s.borderTopWidth,background:s.backgroundColor,paddingLeft:s.paddingLeft,width:r.width,height:r.height,title:node.getAttribute('title'),text:node.innerText.trim()}})
 for(const container of ['页面容器','对话框容器']){
  const region=page.getByRole(container==='页面容器'?'main':'region',{name:container})
  const back=await style(region.getByRole('button',{name:'返回所属计划',exact:true}))
  assert.equal(back.border,'0px',container+'：标题内返回不画描边');assert.equal(back.paddingLeft,'0px');assert.equal(back.background,'rgba(0, 0, 0, 0)')
  const refresh=region.getByRole('button',{name:/^刷新 · /}),facts=await style(refresh)
  assert.deepEqual([facts.width,facts.height,facts.text],[32,32,''],container+'：刷新是 32px 图标');assert.match(facts.title??'',/^刷新 · /,'图标有悬停提示')
  await refresh.focus();await page.keyboard.press('Enter')
 }
 const view=page.getByRole('button',{name:'查看成果',exact:true});await view.waitFor()
 const link=await style(view);assert.equal(link.border,'0px','去往具体对象的跳转是轻量链接');assert.equal(link.paddingLeft,'0px');assert.equal(link.background,'rgba(0, 0, 0, 0)')
 assert.equal(await view.locator('svg').count(),1,'带去往箭头')
 await view.focus();await page.keyboard.press('Enter')
 assert.deepEqual(await page.evaluate(()=>(window as any).lightFixture),[['refresh','page'],['refresh','dialog'],['open','artifact-1',3]])
 assert.deepEqual(errors,[])
})
