import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('原生双层对话框一次 Escape 只关闭员工编辑，焦点回详情入口，再一次才关闭抽屉',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-nested-drawer-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 // 使用实际员工表单容器，避免在测试里重写其 cancel 行为而掩盖 React 冒泡。
 const source=await readFile(join(client,'TeamPage.tsx'),'utf8'),file=ts.createSourceFile('TeamPage.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const dialog=file.statements.find(statement=>ts.isFunctionDeclaration(statement)&&statement.name?.text==='Dialog')
 assert.ok(dialog,'员工编辑使用的 Dialog 必须存在')
 await writeFile(join(temp,'fixture.tsx'),`import React,{Children,isValidElement,useEffect,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {X} from 'lucide-react';import clsx from 'clsx';import {ContextDrawer} from ${JSON.stringify(join(client,'ContextDrawer.tsx'))};import taskCss from ${JSON.stringify(join(client,'TaskPage.module.css'))};import {openDialog} from ${JSON.stringify(join(client,'dialog-focus.ts'))};import {useDialogDismiss} from ${JSON.stringify(join(client,'use-dialog-dismiss.ts'))};import {I18nProvider,useI18n} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const css={},teamCss={},useApplicationCapability=()=>true,applicationPresentation={can:()=>true},localizeWorkError=()=>'',CapabilityNotice=()=>null,CapabilityFields=({children})=><>{children}</>;
 ${dialog.getText(file)}
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [drawer,setDrawer]=useState(false),[edit,setEdit]=useState(false),[busy,setBusy]=useState(false);return <main className={taskCss.page} id="teloa-main" tabIndex={-1}><button onClick={()=>setDrawer(true)}>打开员工</button>{drawer&&<ContextDrawer title="员工详情" close={()=>setDrawer(false)}><button onClick={()=>setEdit(true)}>编辑员工</button>{edit&&<Dialog title="员工编辑" close={()=>setEdit(false)} submit={()=>busy?new Promise(()=>{}):undefined}><label>姓名<input defaultValue="原员工"/></label><button type="button" onClick={()=>setBusy(true)}>阻止保存结束</button><button type="submit">保存</button></Dialog>}</ContextDrawer>}</main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'NestedDrawerTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'打开员工',exact:true}).click();
 const close=page.getByRole('dialog',{name:'员工详情',exact:true}).getByRole('button',{name:'关闭',exact:true})
 assert.equal(await close.evaluate((el:HTMLElement)=>getComputedStyle(el).padding),'0px','宿主页样式不能压缩共同抽屉关闭图标')
 assert.equal(await close.locator('svg').evaluate((el:SVGElement)=>el.getBoundingClientRect().width),20)
 await page.getByRole('button',{name:'编辑员工',exact:true}).click()
 await page.getByRole('dialog',{name:'员工编辑',exact:true}).waitFor()
 await page.keyboard.press('Escape')
 assert.equal(await page.getByRole('dialog',{name:'员工编辑',exact:true}).count(),0)
 assert.equal(await page.getByRole('dialog',{name:'员工详情',exact:true}).count(),1,'员工详情不接收子表单的 cancel')
 assert.equal(await page.getByRole('button',{name:'编辑员工',exact:true}).evaluate((element:HTMLElement)=>element===document.activeElement),true)
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await page.getByRole('button',{name:'打开员工',exact:true}).evaluate((element:HTMLElement)=>element===document.activeElement),true)
 await page.getByRole('button',{name:'打开员工',exact:true}).click()
 await page.getByRole('button',{name:'编辑员工',exact:true}).click();await page.getByRole('button',{name:'阻止保存结束',exact:true}).click();await page.getByRole('button',{name:'保存',exact:true}).click()
 await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),2,'保存中的子表单阻止取消时也不能关闭外层')
 assert.deepEqual(errors,[])
})
