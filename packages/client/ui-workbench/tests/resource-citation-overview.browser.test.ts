import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('引用事实收进概览，固定版本与原消息身份可追溯；空轮次收敛、跨会话不串数据',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-citation-overview-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ResourceCitationHistory} from ${JSON.stringify(join(client,'ResourceCitationHistory.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};const calls=[],at='2026-10-13T01:00:00Z',api={history:async(sessionId,beforeSeq,signal)=>{calls.push({sessionId,beforeSeq});return {sessionId,items:sessionId==='next'?[]:beforeSeq?[{seq:5,messageId:'older-message',turn:1,at,references:[{id:'material',version:1,metadata:{title:'处理手册',sourceId:'original-source',sourceVersion:'fixed-file-hash',scopeIds:['general']}}]}]:[{seq:11,messageId:'empty-turn',turn:3,at,references:[]},{seq:10,messageId:'original-message',turn:2,at,references:[{id:'material',version:2,metadata:{title:'处理手册',sourceId:'original-source',sourceVersion:'fixed-file-hash',scopeIds:['general']}}]}],nextBeforeSeq:sessionId==='next'||beforeSeq?null:10}}};window.citationFixture={calls};function App(){const [id,setId]=useState('owned');return <I18nProvider runtime={runtime}><button onClick={()=>setId('next')}>切换原会话</button><ResourceCitationHistory sessionId={id} api={api} revision="idle"/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'CitationFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(3000)
 await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
 assert.equal((await page.evaluate(()=>(window as any).citationFixture.calls)).length,0,'按需展开读取')
 await page.getByText('资料来源',{exact:true}).click();await page.getByText('处理手册',{exact:true}).waitFor()
 assert.doesNotMatch(await page.locator('#root').innerText(),/第 3|original-message|fixed-file-hash/)
 await page.getByText('来源与身份',{exact:true}).click();assert.match(await page.locator('#root').innerText(),/original-message/)
 await page.getByRole('button',{name:'更早的引用记录',exact:true}).click();await page.getByText('第 1 轮',{exact:true}).waitFor()
 assert.equal(await page.getByText('处理手册',{exact:true}).count(),2,'同资料不同固定版本不能丢失')
 await page.getByRole('button',{name:'切换原会话',exact:true}).click();assert.doesNotMatch(await page.locator('#root').innerText(),/处理手册/)
 await page.getByText('资料来源',{exact:true}).click();await page.getByText('还没有知识引用记录',{exact:true}).waitFor()
 const index=await readFile(join(client,'index.ts'),'utf8');assert.doesNotMatch(index,/id:'teloa-resource-history'/,'不再另挂会话顶部入口')
 assert.match(index,/resourceHistory:resourceApi/,'概览接同一真实记录服务')
})
