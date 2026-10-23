import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))

test('离线发送：先显示网络不可用且草稿已保留，可重试；不把浏览器关闭状态当首错',{timeout:30000},async t=>{
 const temp=await mkdtemp(join(root,'.runtime-offline-send-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {HomeSubmissionNotice} from '${client}HomeSubmissionNotice.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import dock from '${client}ComposerDock.module.css';
 const noop=()=>()=>{},localeState={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:noop,getSnapshot:()=>localeState},listeners=new Set();let unknown=false;
 const monitor={getSnapshot:()=>unknown,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},attach:()=>()=>{},check:async()=>{window.submissionTest.calls.push('check')}};
 window.submissionTest={calls:[],setUnknown:value=>{unknown=value;for(const listener of listeners)listener()}};
 function App(){return <I18nProvider runtime={runtime}><main className={dock.tokens}><HomeSubmissionNotice monitor={monitor}/></main></I18nProvider>}
 createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器验收不允许执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],
 configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),name:'OfflineSendTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:700}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');if(styles)await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const alert=page.getByRole('alert')
 assert.equal(await alert.count(),0,'在线且无未知提交时不应显示恢复提示')
 await page.context().setOffline(true);await page.waitForFunction(()=>navigator.onLine===false)
 await page.getByText(/网络不可用/).waitFor({state:'visible'})
 assert.equal(await page.getByText(/草稿已保留/).isVisible(),true,'离线时应明确草稿保留')
 const retry=alert.getByRole('button').first()
 await retry.click()
 assert.deepEqual(await page.evaluate(()=>(window as any).submissionTest.calls),['check'],'离线提示提供重试入口')
 await page.context().setOffline(false);await page.waitForFunction(()=>navigator.onLine===true)
 await page.evaluate(()=>(window as any).submissionTest.setUnknown(true))
 await page.getByText(/上次发送结果尚未确认/).waitFor({state:'visible'})
 await page.context().setOffline(true);await page.waitForFunction(()=>navigator.onLine===false)
 const copy=await alert.innerText()
 assert.ok(copy.indexOf('网络不可用')>=0,'离线时仍显示网络不可用')
 assert.ok(copy.indexOf('网络不可用')<copy.indexOf('上次发送结果尚未确认'),'离线发送失败提示必须排在浏览器关闭/未确认类提示之前')
 assert.deepEqual(errors,[])
})
