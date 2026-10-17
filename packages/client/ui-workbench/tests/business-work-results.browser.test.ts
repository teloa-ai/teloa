import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
test('正式草稿组件：关闭保留来源上下文且零采用，拒绝保留成果，采用只请求原生意图',{timeout:60000},async()=>{
 const client=fileURLToPath(new URL('../src/client/',import.meta.url)),root=fileURLToPath(new URL('../../../../',import.meta.url));await mkdir(join(client,'../../.runtime'),{recursive:true});const temp=await mkdtemp(join(client,'../../.runtime/business-work-ui-'))
 let browser:any;const server=createServer((_req,res)=>{res.setHeader('content-type','text/html');res.end('<!doctype html><html><body><div id="root"></div></body></html>')})
 try{
  await writeFile(join(temp,'fixture.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {BusinessPendingChanges} from '${client}BusinessWorkResults.tsx';import {createBusinessWorkResultsApi} from '${client}business-work-results-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const state=window.fixture={calls:[],sent:[],resumed:[],status:'draft'};
const id='aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',requestId='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb',stamp='2026-10-13T00:00:00.000Z';
const before={scope:'sales',type:'customer',id:'one',version:1,snapshotHash:'a'.repeat(64),title:'合成客户',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',summary:'原记录',fields:[{label:'备注',value:'原备注'}]};
const draft=()=>({schema:'teloa.business-change-set/v1',id,scope:'sales',revision:1,digest:'a'.repeat(64),state:state.status,sessionId:'original',batch:{requestId,scope:'sales',operations:[{operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'note',value:'准备的备注'}]}]},preview:{fingerprint:'b'.repeat(64),definitions:[],targets:[before],operations:[{operation:'edit',type:'customer',title:'合成客户',before,fields:[{name:'note',value:'准备的备注'}]}]},createdAt:stamp,updatedAt:stamp});
const api=createBusinessWorkResultsApi(async(endpoint,input)=>{state.calls.push([endpoint,input]);if(endpoint==='business-changes/list')return {items:state.status==='rejected'&&!input.history?[]:[draft()]};if(endpoint==='business-changes/get')return draft();if(endpoint==='business-changes/reject'){state.status='rejected';return draft()}if(endpoint==='business-changes/intent')return {sessionId:'original',text:'原生采用请求'};throw Error(endpoint)},{resume:async id=>state.resumed.push(id),send:async(id,text)=>state.sent.push([id,text])});
window.reset=()=>{state.status='draft';render()};let version=0;function render(){root.render(<I18nProvider runtime={runtime}><div><label>原输入<input aria-label="原输入" defaultValue="保留的草稿"/></label><div>已有周报成果</div><BusinessPendingChanges key={version++} scope="sales" api={api}/></div></I18nProvider>)}const root=createRoot(document.getElementById('root'));render();
`)
  const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BusinessWorkFixture',formats:['iife']}}});const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
  const script=bundle.output.find(item=>item.type==='chunk')!.code,css=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port
  const {chromium}=await loadPlaywright();browser=await chromium.launch(launchOptions());const page=await browser.newPage({viewport:{width:1200,height:900}}),errors:string[]=[],remote:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>{if(route.request().url().startsWith(url))return route.continue();remote.push(route.request().url());return route.abort()})
  await page.goto(url);await page.addStyleTag({content:css});await page.addScriptTag({content:script});await page.getByRole('button',{name:/合成客户/}).click();await page.getByRole('dialog').waitFor();await page.getByRole('dialog').getByText('原备注',{exact:true}).waitFor();await page.getByRole('dialog').getByText('准备的备注',{exact:true}).waitFor()
  await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.getByRole('textbox',{name:'原输入'}).inputValue(),'保留的草稿');assert.deepEqual(await page.evaluate(()=>(window as any).fixture.sent),[])
  await page.getByRole('button',{name:/合成客户/}).click();await page.getByRole('button',{name:'拒绝这份修改',exact:true}).click();await page.getByRole('dialog').getByText(/已拒绝/).waitFor();await page.getByRole('dialog').getByRole('button',{name:'关闭',exact:true}).click();await page.getByText('已有周报成果',{exact:true}).waitFor()
  await page.evaluate(()=>(window as any).reset());await page.getByRole('button',{name:/合成客户/}).click();await page.getByRole('button',{name:'请求采用',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.sent.length===1);assert.deepEqual(await page.evaluate(()=>(window as any).fixture.resumed),['original']);assert.deepEqual(errors,[]);assert.deepEqual(remote,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 }finally{await browser?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(temp,{recursive:true,force:true})}
})
