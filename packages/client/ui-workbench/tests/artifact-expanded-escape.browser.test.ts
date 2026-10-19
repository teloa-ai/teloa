import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import type {ArtifactWorkChange} from '../src/client/artifact-work.js'

declare global {
 interface Window {
  expandedEscapeFixture:{calls:ArtifactWorkChange[];finishSave?:()=>void}
 }
}
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

type Probe={open:boolean;modal:boolean;active:string;heading:string;textboxes:number}

/**
 * 对应 QA 报告 D126 / D117：工作概览放大视图里焦点落到 body 后按 Esc。
 * 既有语义：放大视图为模态，Esc 先退回窄栏（不关闭面板、不改内容与整理态），再按 Esc 才返回工作概览；
 * 退回窄栏后焦点必须回到发起放大的「放大」按钮，而不是被默认焦点交接拽进名称输入框。
 */
test('放大视图在 body 焦点、内部焦点与保存中按 Esc 只退回窄栏并把焦点还给「放大」，不改结果预览、不丢会话草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-expanded-escape-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useLayoutEffect,useRef,useState} from 'react';import {createRoot} from 'react-dom/client';import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const source={kind:'task',id:'overview-task'},calls=[],state={...emptyTaskPreview(),tasks:[{id:'overview-task',title:'原任务',scope:'general',version:1,updatedAt:'2026-10-16T00:00:00Z',assigneeId:'role',evidence:[],result:'尚未保存的原结果',storage:'persistent',state:'running'}]};window.expandedEscapeFixture={calls};
 // 与 ConversationOverviewTab 一致：面板打开期间概览首页 hidden，关闭时宿主把焦点还给触发入口。
 function App(){const [open,setOpen]=useState(false),[target,setTarget]=useState({source}),trigger=useRef(null);useLayoutEffect(()=>{if(!open&&trigger.current?.isConnected)trigger.current.focus()},[open]);const enter=(event,next)=>{trigger.current=event.currentTarget;setTarget(next);setOpen(true)};return <main><div hidden={open}><button onClick={event=>enter(event,{source,initialAction:'prepare'})}>整理成果入口</button><button onClick={event=>enter(event,{source})}>查看成果入口</button></div><textarea aria-label="会话草稿" defaultValue="保留原输入"/><aside style={{width:546,height:820}}><ArtifactPanel inline open={open} target={target} state={state} conversation={{id:source.id,title:'原会话',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={command=>{calls.push(command);return new Promise(resolve=>{window.expandedEscapeFixture.finishSave=()=>resolve(undefined)})}} openSource={()=>{throw Error('不应导航')}} openTask={()=>{}}/></aside></main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactExpandedEscapeTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 // about:blank 不是安全上下文，没有 crypto.randomUUID；保存按钮的提交处理依赖它，只在夹具里补齐。
 await page.evaluate(()=>{if(!crypto.randomUUID)Object.assign(crypto,{randomUUID:()=>'00000000-0000-4000-8000-'+String(Date.now()).padStart(12,'0')})})
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const probe=():Promise<Probe>=>page.evaluate(()=>{const dialog=document.querySelector('dialog'),active=document.activeElement;return {open:!!dialog?.open,modal:!!dialog?.matches(':modal'),active:!active||active===document.body?'BODY':(active.getAttribute('aria-label')||active.textContent||active.tagName).trim().slice(0,20),heading:dialog?.querySelector('h3')?.textContent?.trim()||'',textboxes:dialog?dialog.querySelectorAll('input,textarea').length:0}})
 // 概览首页在面板打开期间与真实宿主一样处于 hidden，入口不可聚焦；焦点丢失只在测试夹具里制造，真实页面的 evaluate 保持只读。
 const dropFocus=async()=>{await page.evaluate(()=>(document.activeElement as HTMLElement|null)?.blur?.());assert.equal((await probe()).active,'BODY')}
 const panel=page.getByRole('dialog'),expand=panel.getByRole('button',{name:'放大',exact:true}),collapse=panel.getByRole('button',{name:'收起',exact:true}),body=panel.getByText('尚未保存的原结果',{exact:true})
 const prepareEntry=page.getByRole('button',{name:'整理成果入口',exact:true}),viewEntry=page.getByRole('button',{name:'查看成果入口',exact:true})

 // 1. D126 原路径：整理态 + 放大 + 焦点落 body + Esc。
 await prepareEntry.click();await body.waitFor();assert.equal(await panel.getByRole('textbox').count(),0)
 await expand.click();await collapse.waitFor()
 const magnified=await probe();assert.deepEqual([magnified.open,magnified.modal,magnified.active],[true,true,'收起'])
 await dropFocus();await page.keyboard.press('Escape')
 const afterBody=await probe()
 assert.equal(afterBody.open,true,'第一次 Esc 只退回窄栏，不关闭成果面板');assert.equal(afterBody.modal,false,'第一次 Esc 退出放大模态')
 assert.equal(afterBody.heading,magnified.heading,'退回窄栏不改变整理态/查看态');assert.equal(afterBody.textboxes,magnified.textboxes,'退回窄栏不新建或移除表单')
 assert.equal(await body.innerText(),'尚未保存的原结果')
 assert.equal(afterBody.active,'放大','body 焦点下 Esc 退出放大后焦点回到发起放大的「放大」按钮，而不是名称输入框')
 await page.keyboard.press('Escape');assert.equal(await panel.count(),0,'第二次 Esc 返回工作概览')
 assert.equal(await prepareEntry.evaluate((node:HTMLElement)=>node===document.activeElement),true,'关闭后焦点回到原发起入口')
 assert.equal(await page.getByRole('textbox',{name:'会话草稿'}).inputValue(),'保留原输入')

 // 2. 查看态（空成果、未进入整理）：body 焦点 Esc 不得切成整理态。
 await viewEntry.click();await panel.waitFor();assert.equal(await panel.getByRole('textbox').count(),0)
 await expand.click();await collapse.waitFor();const viewing=await probe();await dropFocus();await page.keyboard.press('Escape')
 const afterView=await probe()
 assert.deepEqual([afterView.open,afterView.modal,afterView.heading,afterView.textboxes],[true,false,viewing.heading,0],'查看态退出放大不得进入整理')
 assert.equal(afterView.active,'放大')
 await page.keyboard.press('Escape');assert.equal(await panel.count(),0)
 assert.equal(await viewEntry.evaluate((node:HTMLElement)=>node===document.activeElement),true)

 // 3. 内部焦点（正文输入框）Esc：同样只退回窄栏并回到「放大」，草稿保留。
 await prepareEntry.click();await body.waitFor();assert.equal(await body.innerText(),'尚未保存的原结果','重新打开保持原结果')
 await expand.click();await collapse.waitFor();await panel.getByRole('button',{name:'保存工作成果',exact:true}).focus();await page.keyboard.press('Escape')
 const afterInner=await probe();assert.deepEqual([afterInner.open,afterInner.modal,afterInner.active],[true,false,'放大'])
 assert.equal(await body.innerText(),'尚未保存的原结果')

 // 4. 保存中：Esc 不退出放大、不关闭；保存完成后 Esc 恢复既有退出路径。
 await expand.click();await collapse.waitFor();await panel.getByRole('button',{name:'保存工作成果',exact:true}).click()
 await panel.getByRole('status').filter({hasText:'保存'}).first().waitFor()
 await dropFocus();await page.keyboard.press('Escape')
 const whileBusy=await probe();assert.deepEqual([whileBusy.open,whileBusy.modal],[true,true],'保存中 Esc 不退出放大视图')
 await page.keyboard.press('Escape');await page.waitForTimeout(100)
 const whileBusyAgain=await probe();assert.deepEqual([whileBusyAgain.open,whileBusyAgain.modal],[true,true],'保存中连按 Esc 也不能让对话框被浏览器原生关闭而状态失同步')
 await page.evaluate(()=>window.expandedEscapeFixture.finishSave!());await panel.getByRole('button',{name:'关闭产物面板',exact:true}).and(page.locator(':enabled')).waitFor()
 await page.keyboard.press('Escape');const afterSave=await probe();assert.deepEqual([afterSave.open,afterSave.modal,afterSave.active],[true,false,'放大'],'保存完成后 Esc 退回窄栏并回到「放大」')
 assert.equal((await page.evaluate(()=>window.expandedEscapeFixture.calls)).length,1,'整个过程只有显式点击的一次保存')
 assert.deepEqual(errors,[])
})
