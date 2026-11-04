import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string,styles:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {SessionContinuationButton} from '${client}SessionContinuationButton.tsx';import {createSessionContinuation} from '${client}session-continuation.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=window.continuationLocale??'zh-CN',snapshot={locale,dshLocale:locale==='en'?'en':'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const listeners=new Set(),facts={identity:{},current:true,ready:true,running:false,pending:false,blocked:false},prefix='a'.repeat(64),fixture={inspects:0,resumed:[],release:null,reject:null,received:false};window.continuationFixture=fixture;
const port=createSessionContinuation({sessionId:'original',facts:()=>facts,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},inspect:async()=>{fixture.inspects++;return {sessionId:'original',available:!fixture.received,prefixSha256:prefix}},resume:value=>{fixture.resumed.push(value);return new Promise((resolve,reject)=>{fixture.release=()=>{fixture.received=true;resolve({accepted:true})};fixture.reject=()=>reject(Error('response unknown'))})}});
window.continuationReadOnly=()=>{for(const listener of listeners)listener()};window.continuationNavigate=()=>{facts.current=false;facts.identity={};for(const listener of listeners)listener()};
const labels=locale==='en'?['Original conversation','Completed report','Your next draft','Send']:locale==='zh-CN'?['原会话','已完成的报告','下一条草稿','发送']:['原對話','已完成的報告','下一則草稿','傳送'];
function App(){return <I18nProvider runtime={runtime}><main><h1>{labels[0]}</h1><article><h2>{labels[1]}</h2><p id="fixed-result">Evidence and original results stay in this conversation.</p></article><section className="composer"><textarea aria-label={labels[2]} defaultValue="保留这份尚未提交的草稿"/><div className="attachment">draft.txt</div><div className="toolbar"><span className="model">BYOK · DeepSeek</span><div className="actions"><SessionContinuationButton port={port}/><button type="button" className="submit" aria-label={labels[3]}>↑</button></div></div></section><aside><h2>{locale==='en'?'Search coverage':locale==='zh-CN'?'检索范围':'檢索範圍'}</h2><p id="retrieval-boundary">{translateMessage(locale,'retrieval.trial.boundary')}</p></aside></main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-session-continuation-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'SessionContinuationFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,locale:string,width=1100){
 const page=await browser.newPage({viewport:{width,height:720}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-surface:#fff;--teloa-subtle:#f4f4f1;--teloa-border:#dddeda;--teloa-font-caption:12px;--dsw-alias-label-primary:#242624;--dsw-alias-label-secondary:#666c64}*{box-sizing:border-box}body{font:14px system-ui;margin:0;background:#fafaf8;color:#242624}main{max-width:800px;margin:46px auto;padding:0 24px}h1{font-size:20px;font-weight:600}h2{font-size:14px;font-weight:600}article{margin:28px 0 42px}article p{line-height:1.6;color:#666c64}.composer{background:#fff;border:1px solid #dddeda;border-radius:16px;padding:14px 14px 10px}textarea{width:100%;height:72px;resize:none;border:0;outline:none;font:14px/1.5 system-ui;background:transparent;color:inherit}.attachment{display:inline-flex;border:1px solid #e2e3de;border-radius:6px;font-size:12px;padding:4px 8px}.toolbar{display:flex;align-items:center;justify-content:space-between;margin-top:10px;gap:12px}.model{font-size:12px;color:#666c64}.actions{display:flex;align-items:center;gap:8px}.submit{border:0;border-radius:50%;background:#262824;color:white;width:30px;height:30px;font-size:20px}aside{margin-top:44px;color:#666c64;font-size:12px;line-height:1.65}'+styles})
 await page.addScriptTag({content:'window.continuationLocale='+JSON.stringify(locale)});await page.addScriptTag({content:script});return page
}

for(const [locale,label,errorText] of [['zh-CN','继续未完成的工作','恢复尚未确认，请核对原会话后重试'],['zh-TW','繼續未完成的工作','尚未確認恢復，請核對原對話後再試'],['en','Continue unfinished work','Continuation is unconfirmed. Check this conversation and retry']])test(locale+'：本人点击才恢复，忙碌和未知响应可见，原草稿、附件、报告保留',async t=>{
 const page=await mount(t,locale!),button=page.getByRole('button',{name:label!,exact:true});await button.waitFor()
 await page.evaluate(()=>(window as any).continuationReadOnly());await page.waitForFunction(()=>(window as any).continuationFixture.inspects>=2)
 assert.deepEqual(await page.evaluate(()=>(window as any).continuationFixture.resumed),[])
 const draft=page.getByRole('textbox');await draft.fill('本人的下一条草稿，暂不发送')
 if(process.env.TELOA_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOT_DIR,'continuation-'+locale+'-ready.png')})
 await button.click();await page.waitForFunction(()=>document.querySelector('button[disabled]')!==null);assert.equal(await button.isDisabled(),true)
 await page.evaluate(()=>(window as any).continuationFixture.reject());await page.getByRole('alert').filter({hasText:errorText!}).waitFor()
 assert.equal(await button.isDisabled(),false);assert.equal(await draft.inputValue(),'本人的下一条草稿，暂不发送');assert.equal(await page.getByText('draft.txt',{exact:true}).count(),1)
 assert.equal(await page.locator('#fixed-result').innerText(),'Evidence and original results stay in this conversation.')
 await page.setViewportSize({width:720,height:720})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 if(process.env.TELOA_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOT_DIR,'continuation-'+locale+'-unknown.png')})
 await button.click();assert.deepEqual(await page.evaluate(()=>(window as any).continuationFixture.resumed),['a'.repeat(64),'a'.repeat(64)])
 await page.evaluate(()=>(window as any).continuationFixture.release());await button.waitFor({state:'hidden'})
 assert.equal(await draft.inputValue(),'本人的下一条草稿，暂不发送')
})

test('导航后撤下播放按钮，迟到只读响应不执行旧工作',async t=>{
 const page=await mount(t,'zh-CN'),button=page.getByRole('button',{name:'继续未完成的工作',exact:true});await button.waitFor();await page.evaluate(()=>(window as any).continuationNavigate());await button.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>(window as any).continuationFixture.resumed),[])
})

test('窄屏三语言只绘制一个原会话，未知提示稳定可读且没有横向溢出',async t=>{
 for(const [locale,label,errorText]of [['zh-CN','继续未完成的工作','恢复尚未确认'],['zh-TW','繼續未完成的工作','尚未確認恢復'],['en','Continue unfinished work','Continuation is unconfirmed']])await t.test(locale!,async sub=>{
  const page=await mount(sub,locale!,720),button=page.getByRole('button',{name:label!,exact:true});await button.waitFor();await button.click();await page.evaluate(()=>(window as any).continuationFixture.reject());await page.getByRole('alert').filter({hasText:errorText!}).waitFor()
  await page.evaluate(async()=>{await document.fonts.ready;await new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve())))})
  assert.equal(await page.locator('main').count(),1);assert.equal(await page.getByRole('heading',{level:1}).count(),1);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
  if(process.env.TELOA_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOT_DIR,'continuation-'+locale+'-unknown-stable.png')})
 })
})
