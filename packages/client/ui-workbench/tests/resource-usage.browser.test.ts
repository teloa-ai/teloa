import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('资料反向引用：失败不伪装空态，分页保留事实，切换连接丢弃旧回包，原工作可达',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-resource-usage-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ResourceUsage} from ${JSON.stringify(join(client,'ResourceUsage.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={t:(key,params)=>translateMessage('en',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const resource={id:'11111111-1111-4111-a111-111111111111',ownerId:'owner',version:3,scopeIds:['general']};
 const fixture={calls:[],pending:[],opened:[]};window.usageFixture=fixture;
 const first={usage:(row,cursor,signal)=>new Promise((resolve,reject)=>{fixture.calls.push({cursor,aborted:()=>signal.aborted});fixture.pending.push({resolve,reject})})};
 const second={usage:async()=>({resourceId:resource.id,version:3,scanned:1,unavailable:0,nextCursor:null,related:[],relatedMore:false,items:[{sessionId:'new',title:'New connection citation',messageId:'new-message',version:2,at:'2026-10-21T01:00:00Z'}]})};
 function App(){const [api,setApi]=useState(first);return <I18nProvider runtime={runtime}><button onClick={()=>setApi(second)}>Switch connection</button><div style={{width:280}}><ResourceUsage api={api} resource={resource} open={target=>fixture.opened.push(target)}/></div></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false},input:join(temp,'fixture.tsx'),output:{format:'iife',inlineDynamicImports:true}}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(4000)
 await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')||'body{font-family:system-ui}'} );await page.addScriptTag({content:bundle.output.filter(x=>x.type==='chunk').map(x=>x.code).join('\n')})
 await page.getByRole('status').waitFor();assert.doesNotMatch(await page.locator('#root').innerText(),/No conversation citations found/)
 await page.evaluate(()=>{(window as any).usageFixture.pending.shift().reject(Error('History unavailable'))});await page.getByRole('alert').waitFor();assert.doesNotMatch(await page.locator('#root').innerText(),/No conversation citations found/)
 await page.getByRole('button',{name:'Retry',exact:true}).click()
 await page.evaluate(()=>{(window as any).usageFixture.pending.shift().resolve({resourceId:'11111111-1111-4111-a111-111111111111',version:3,scanned:20,unavailable:1,nextCursor:'cursor',related:[{kind:'task',id:'22222222-2222-4222-a222-222222222222',title:'Related task'},{kind:'group',id:'33333333-3333-4333-a333-333333333333',scope:'general',title:'Original group citation',messageId:'group-message',rootId:null,version:1,count:2}],relatedMore:false,items:[{sessionId:'old',title:'Original citation',messageId:'old-message',version:1,at:'2026-10-20T01:00:00Z'}]})})
 await page.getByRole('button',{name:'Original citation',exact:true}).waitFor();assert.match(await page.locator('#root').innerText(),/v1/);assert.match(await page.locator('#root').innerText(),/1 histories unavailable/)
 await page.getByRole('button',{name:'Related task',exact:true}).click();assert.equal((await page.evaluate(()=>(window as any).usageFixture.opened))[0].kind,'task')
 await page.getByRole('button',{name:'Original citation',exact:true}).click();assert.deepEqual((await page.evaluate(()=>(window as any).usageFixture.opened))[1],{kind:'conversation',id:'old',messageId:'old-message'})
 assert.match(await page.locator('#root').innerText(),/Group citation · v1 · 2 messages/)
 await page.getByRole('button',{name:'Original group citation',exact:true}).click();assert.deepEqual((await page.evaluate(()=>(window as any).usageFixture.opened))[2],{kind:'group',id:'33333333-3333-4333-a333-333333333333',scope:'general',title:'Original group citation',messageId:'group-message',rootId:null,version:1,count:2})
 await page.getByRole('button',{name:'Check more histories',exact:true}).click();await page.getByRole('button',{name:'Switch connection',exact:true}).click();await page.getByRole('button',{name:'New connection citation',exact:true}).waitFor()
 await page.evaluate(()=>{(window as any).usageFixture.pending.shift().resolve({items:[{title:'Late old history'}]})})
 assert.doesNotMatch(await page.locator('#root').innerText(),/Original citation|Late old history|Related task/)
 assert.equal(await page.evaluate(()=>(window as any).usageFixture.calls.at(-1).aborted()),true)
})
