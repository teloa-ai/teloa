import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=new URL('../src/client/',import.meta.url)

test('工作台恢复提示沿用平台主题，重试继续原工作，只有缺少目录才提供位置选择',async t=>{
 const temp=await mkdtemp(join(root,'.runtime-home-recovery-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const notice=fileURLToPath(new URL('HomeNativePreparationNotice.tsx',client)),themes=fileURLToPath(new URL('../brand/prototype-theme.ts',client)),tokens=fileURLToPath(new URL('theme-tokens.module.css',client))
 await writeFile(join(temp,'entry.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {HomeNativePreparationNotice} from ${JSON.stringify(notice)};import {prototypeThemes} from ${JSON.stringify(themes)};import tokens from ${JSON.stringify(tokens)};
 const state=window.recoveryTest={calls:[],theme:'light',error:'restore',locale:'zh-CN',ready:true,timeoutMs:12000},root=createRoot(document.getElementById('root'));
 state.render=()=>root.render(<main className={tokens.tokens} style={{...prototypeThemes[state.theme],minHeight:'100vh',background:'var(--teloa-background)',paddingTop:1}}><HomeNativePreparationNotice locale={state.locale} error={state.error} retry={()=>state.calls.push('retry')} reload={()=>state.calls.push('reload')} ready={state.ready} resetKey={state.calls.length} preparationTimeoutMs={state.timeoutMs} chooseLocation={()=>state.calls.push('choose')}/></main>);state.render();`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),name:'HomeRecoveryNoticeTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:700}});t.after(()=>page.close())
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('heading',{name:'暂时无法恢复工作台',exact:true}).waitFor()
 assert.equal(await page.getByRole('alert').count(),1,'明确的恢复失败仍须显示错误状态')
 assert.equal(await page.getByText('输入内容不正确，请核对后重试。',{exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'选择工作位置',exact:true}).count(),0)
 const button=page.getByRole('button',{name:'重试',exact:true})
 const appearance=await button.evaluate((element:HTMLElement)=>{const style=getComputedStyle(element);return {height:style.minHeight,radius:style.borderRadius,fontSize:style.fontSize,background:style.backgroundColor,border:style.borderColor}})
 assert.deepEqual(appearance,{height:'36px',radius:'7px',fontSize:'13px',background:'rgb(28, 27, 25)',border:'rgb(28, 27, 25)'})
 await button.click();assert.deepEqual(await page.evaluate(()=>(window as any).recoveryTest.calls),['retry'])
 assert.equal(await button.evaluate((element:HTMLElement)=>getComputedStyle(element).backgroundColor),'rgb(28, 27, 25)','悬停后的主按钮保持 1.0 墨黑主色和可读文字')
 const capture=process.env.TELOA_HOME_RECOVERY_CAPTURE
 if(capture){await mkdir(capture,{recursive:true});await page.screenshot({path:join(capture,'home-recovery-light.png')})}
 await page.evaluate(()=>{const state=(window as any).recoveryTest;state.theme='dark';state.render()})
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('main')!).backgroundColor==='rgb(22, 21, 19)')
 if(capture)await page.screenshot({path:join(capture,'home-recovery-dark.png')})
 await page.evaluate(()=>{const state=(window as any).recoveryTest;state.error='location';state.render()})
 await page.getByRole('heading',{name:'选择工作位置',exact:true}).waitFor();await page.getByRole('button',{name:'选择工作位置',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).recoveryTest.calls),['retry','choose'])
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.evaluate(()=>{const state=(window as any).recoveryTest;state.error='restore';state.ready=false;state.render()})
 await page.getByRole('button',{name:'重新加载工作台',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).recoveryTest.calls),['retry','choose','reload'])
 assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),0,'连接未就绪时不提供注定失败的重试')
 await page.evaluate(()=>{const state=(window as any).recoveryTest;state.locale='en';state.render()})
 await page.getByRole('heading',{name:'Unable to restore your workspace',exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'Choose a work location',exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'Reload workspace',exact:true}).count(),1)
 // 上游状态反复重排、始终不 ready 时，提示本身到点必须给出可恢复动作。
 await page.evaluate(()=>{const state=(window as any).recoveryTest;state.error=undefined;state.locale='zh-CN';state.timeoutMs=80;state.render()})
 await page.getByRole('heading',{name:'正在恢复工作台',exact:true}).waitFor({timeout:3000})
 assert.equal(await page.getByRole('status').filter({hasText:'恢复用时较长，你可以继续等待或重试。'}).count(),1)
 assert.equal(await page.getByRole('alert').count(),0,'自然超时仅提示恢复较慢，不能伪装成失败')
 assert.ok(await page.getByRole('button',{name:'重新加载工作台',exact:true}).count())
 await page.evaluate(()=>{const state=(window as any).recoveryTest;state.error='slow';state.locale='en';state.ready=true;state.render()})
 await page.getByRole('heading',{name:'Restoring your workspace',exact:true}).waitFor()
 assert.equal(await page.getByRole('status').filter({hasText:'This is taking longer than usual. You can keep waiting or try again.'}).count(),1)
 assert.equal(await page.getByRole('button',{name:'Retry',exact:true}).count(),1)
 assert.equal(await page.getByRole('alert').count(),0)
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
