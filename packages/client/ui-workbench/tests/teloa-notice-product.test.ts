import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {TeloaNotice} from '${client}TeloaNotice.tsx';import {applicationPresentation} from '${client}application-presentation.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const values=new Map(),fixture=window.noticeFixture={completed:0,reads:[],writes:[]};
Object.defineProperty(window,'localStorage',{configurable:true,value:{getItem:key=>{fixture.reads.push(key);return values.get(key)??null},setItem:(key,value)=>{fixture.writes.push({key,value});values.set(key,value)}}});
const view=createRoot(document.getElementById('root'));let generation=0;
fixture.mount=async product=>{await applicationPresentation.configure(product==='Free'?undefined:{presentation:async()=>({schema:'teloa.application-presentation/v1',product,account:{displayName:'Alice',email:'alice@example.test'}}),openAccount:async()=>{}});fixture.completed=0;fixture.reads=[];fixture.writes=[];view.render(<I18nProvider runtime={runtime}><TeloaNotice key={++generation} complete={()=>fixture.completed++}/></I18nProvider>)};
`

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-notice-product-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"',__TELOA_VERSION__:'"0.2.0-alpha.7"'},build:{write:false,minify:false,rollupOptions:{treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'NoticeProductFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage(),errors:string[]=[];page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addScriptTag({content:script});return page
}

test('Pro 与 Enterprise 跳过 Free 预览声明并完成引导，不读取或写入 Free 确认',async t=>{
 const page=await mount(t)
 for(const product of ['Pro','Enterprise']){
  await page.evaluate(product=>(window as any).noticeFixture.mount(product),product)
  await page.waitForFunction(()=>(window as any).noticeFixture.completed===1)
  assert.equal(await page.getByRole('dialog').count(),0)
  assert.deepEqual(await page.evaluate(()=>({reads:(window as any).noticeFixture.reads,writes:(window as any).noticeFixture.writes})),{reads:[],writes:[]})
 }
})

test('默认 Free 保留预览内容、首次显式确认和同版本记忆；Pro 跳过不替它确认',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).noticeFixture.mount('Pro'))
 await page.waitForFunction(()=>(window as any).noticeFixture.completed===1)
 await page.evaluate(()=>(window as any).noticeFixture.mount('Free'))
 const dialog=page.getByRole('dialog',{name:'个人版预览声明'});await dialog.waitFor()
 assert.match(await dialog.textContent(),/当前为个人单机版预览/)
 assert.equal(await page.evaluate(()=>(window as any).noticeFixture.completed),0)
 assert.equal(await page.locator(':focus').getAttribute('id'),'teloa-notice-title')
 await dialog.getByRole('button',{name:'我知道了'}).click()
 await page.waitForFunction(()=>(window as any).noticeFixture.completed===1)
 assert.deepEqual(await page.evaluate(()=>(window as any).noticeFixture.writes),[{key:'teloa.notice/v1',value:'2026-09-14.1'}])
 await page.evaluate(()=>(window as any).noticeFixture.mount('Free'))
 await page.waitForFunction(()=>(window as any).noticeFixture.completed===1)
 assert.equal(await page.getByRole('dialog').count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).noticeFixture.writes),[])
})
