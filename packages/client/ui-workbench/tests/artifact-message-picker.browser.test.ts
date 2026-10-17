import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('成果消息选择显示原员工与可读正文；隐藏技术编号但选取仍保留原消息身份',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-artifact-picker-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {NativeArtifactPicker} from ${JSON.stringify(join(client,'NativeArtifactPicker.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};const calls=[],message={sessionId:'owned-session',messageId:'owned-message-uuid',seq:134,role:'assistant',at:'2026-10-13T01:00:00Z',text:'## 研判结果\\n**需要调查**\\n![图片](https://outside.invalid/tracker.png)',images:[],interrupted:false,omittedBlocks:0};window.pickerFixture={calls};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><NativeArtifactPicker sessionId="owned-session" assistantName="小研" api={{read:async id=>({sessionId:id,items:[message,{...message,messageId:'second-message',seq:135,text:'第二条结果'}],nextBeforeSeq:null}),imageUrl:async()=>{throw Error('不可调用')}}} selected={[]} select={value=>calls.push(value)}/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ArtifactMessageFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:550,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 await page.getByRole('heading',{name:'研判结果',exact:true}).waitFor()
 const content=await page.locator('#root').innerText();assert.match(content,/小研/);assert.doesNotMatch(content,/模型回复|seq 134|owned-message-uuid|\*\*需要调查\*\*/)
 assert.equal(await page.locator('img').count(),0,'消息预览不外发图片请求')
 const select=page.getByRole('button',{name:/引用.*小研.*研判结果/});await select.click()
 const selected=await page.evaluate(()=>(window as any).pickerFixture.calls);assert.equal(selected.length,1);assert.equal(selected[0].sessionId,'owned-session');assert.equal(selected[0].messageId,'owned-message-uuid');assert.equal(selected[0].seq,134)
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
