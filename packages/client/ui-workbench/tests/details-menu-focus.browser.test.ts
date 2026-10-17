import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('菜单失焦关闭且不抢焦点；菜单打开保留页签的抽屉后恢复可见入口',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-menu-focus-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {DetailsMenu} from ${JSON.stringify(join(client,'DetailsMenu.tsx'))};import {ContextDrawer} from ${JSON.stringify(join(client,'ContextDrawer.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const menu=useRef(null),name=useRef(null),[open,setOpen]=useState(false);return <main id="teloa-main" tabIndex={-1}><DetailsMenu menuRef={menu}><summary>更多群操作</summary><div role="menu"><button role="menuitem" onClick={()=>{menu.current.removeAttribute('open');setOpen(true)}}>成员与群设置</button><button role="menuitem">第二个动作</button></div></DetailsMenu><button>菜单后的按钮</button><textarea aria-label="群草稿" defaultValue="保留原群输入"/>{open&&<ContextDrawer title="群设置" initialFocus={name} close={()=>setOpen(false)}><div hidden><label>群名称<input ref={name} defaultValue="原群"/></label></div><label>查找员工<input/></label></ContextDrawer>}</main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'MenuFocusTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')})
 await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const menu=page.locator('details'),summary=page.getByRole('button',{name:'更多群操作',exact:true}),outside=page.getByRole('button',{name:'菜单后的按钮',exact:true})
 await summary.click();await page.getByRole('menuitem',{name:'成员与群设置',exact:true}).focus();await page.keyboard.press('End')
 // 原生toggle事件是异步的：在受控夹具补送迟到事件，不能抢回已经选择的末项。
 await page.locator('details').evaluate((node:HTMLDetailsElement)=>node.dispatchEvent(new Event('toggle')))
 assert.equal(await page.getByRole('menuitem',{name:'第二个动作',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true,'迟到的展开事件保留方向键选中的菜单项')
 await page.keyboard.press('Escape')
 await summary.click();await page.getByRole('menuitem',{name:'成员与群设置',exact:true}).focus()
 await page.keyboard.press('Tab');await page.keyboard.press('Tab')
 assert.equal(await outside.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await menu.getAttribute('open'),null,'Tab 离开菜单后不能留下旧菜单遮挡正文')
 assert.equal(await summary.getAttribute('aria-expanded'),'false')
 for(const dismissal of ['Escape','关闭']){
  await summary.click();await page.getByRole('menuitem',{name:'成员与群设置',exact:true}).click()
  const drawer=page.getByRole('dialog',{name:'群设置',exact:true});await drawer.waitFor()
  assert.equal(await drawer.evaluate((node:HTMLElement)=>node.contains(document.activeElement)),true,'上次页签的隐藏输入不能导致抽屉留在正文焦点')
  if(dismissal==='Escape')await page.keyboard.press('Escape');else await drawer.getByRole('button',{name:'关闭',exact:true}).click()
  assert.equal(await page.locator('dialog[open]').count(),0)
  assert.equal(await summary.evaluate((node:HTMLElement)=>node===document.activeElement),true,'关闭后回群菜单入口，不落到 BODY 或不可见菜单项')
 }
 assert.equal(await page.getByRole('textbox',{name:'群草稿'}).inputValue(),'保留原群输入')
 assert.deepEqual(errors,[])
})
