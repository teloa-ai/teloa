import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('员工优先页头保留原员工入口和话题；紧凑品牌按需查看版本，关闭回原焦点',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-employee-first-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {DetailsMenu} from ${JSON.stringify(join(client,'DetailsMenu.tsx'))};import {EmployeeConversationHeader} from ${JSON.stringify(join(client,'EmployeeConversationHeader.tsx'))};import {WorkbenchNavigationBrand} from ${JSON.stringify(join(client,'WorkbenchNavigationChrome.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},calls=[];
 window.employeeFirst={calls};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><aside id="brand" style={{width:204}}><WorkbenchNavigationBrand product="Free" colorScheme="light" onClose={()=>{}}/></aside><header id="conversation" style={{width:400}}><EmployeeConversationHeader name="小研" avatar={<span aria-hidden>原头像</span>} topic="本轮原始工作话题" viewProfile={()=>calls.push(['profile','original-role'])}/></header><DetailsMenu closeOnSelect><summary aria-label="会话选项">…</summary><div role="menu"><button role="menuitem" type="button">新会话</button><button role="menuitem" type="button" disabled>不可用</button><button role="menuitem" type="button">工作成果</button></div></DetailsMenu><textarea aria-label="原会话草稿" defaultValue="保留当前工作"/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"',__TELOA_VERSION__:'"0.2.0-test"'},build:{write:false,minify:false,rollupOptions:{treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'EmployeeFirstFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1430,height:983}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 const brand=page.locator('#brand'),header=page.locator('#conversation')
 await header.getByRole('heading',{name:'小研',exact:true}).waitFor()
 assert.match(await header.innerText(),/本轮原始工作话题/)
 assert.doesNotMatch(await brand.innerText(),/AI-Native Team Studio|0\.2\.0-test/,'持续工作区不重复营销和构建信息')
 assert.equal(await brand.getByRole('button',{name:'品牌与版本',exact:true}).count(),0,'顶部品牌区不再弹出介绍/版本卡');assert.match(await brand.innerText(),/社区版/)
 await header.getByRole('button',{name:'查看档案 · 小研',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).employeeFirst.calls),[['profile','original-role']])
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'保留当前工作')
 assert.equal(await header.evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth),true)
 const menu=page.getByRole('button',{name:'会话选项',exact:true});assert.equal(await menu.getAttribute('aria-haspopup'),'menu');await menu.click()
 await page.waitForFunction(()=>document.activeElement?.textContent==='新会话')
 assert.equal(await menu.getAttribute('aria-expanded'),'true');await page.keyboard.press('ArrowDown');assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'工作成果')
 await page.keyboard.press('Escape');assert.equal(await menu.getAttribute('aria-expanded'),'false');assert.equal(await menu.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await menu.click();await page.getByRole('menuitem',{name:'工作成果',exact:true}).click()
 assert.equal(await menu.evaluate((node:HTMLElement)=>node===document.activeElement),true,'菜单轻动作关闭后保留可见入口焦点')
 await menu.click();await page.waitForFunction(()=>document.querySelector('[aria-label="会话选项"]')?.getAttribute('aria-expanded')==='true');await page.getByRole('textbox',{name:'原会话草稿'}).focus();await page.keyboard.press('Escape')
 assert.equal(await menu.getAttribute('aria-expanded'),'false','失焦已收起菜单，外部输入框的 Esc 不再留下遮挡正文的弹层')
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).evaluate((node:HTMLElement)=>node===document.activeElement),true,'菜单失焦与外部 Esc 都不能抢走输入焦点')
 assert.deepEqual(errors,[])
})
