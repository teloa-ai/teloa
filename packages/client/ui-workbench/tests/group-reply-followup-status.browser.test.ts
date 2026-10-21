import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('真实状态组件：员工回帖后的空接力中性显示，本人无人回应和真正失败仍可重试',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_followup_status.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {GroupMessageStatus} from '${client}GroupMessageStatus.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const id='11111111-1111-4111-8111-111111111111',role='22222222-2222-4222-8222-222222222222',task='33333333-3333-4333-8333-333333333333';
 const message={id,groupId:id,rootId:task,authorId:role,taskId:task,runId:task,text:'37乘以23等于851。',references:[],createdAt:'2026-10-21T00:00:00.000Z'};
 const decision={messageId:id,kind:'no-candidate',respond:[],hops:1},status={messageId:id,attemptVersion:1,phase:'unavailable',recipients:[],hintCode:'target-unavailable',canRetry:true};
 window.followupFixture={select:()=>{},retries:0};
 function Root(){const [state,set]=useState({kind:'employee',locale:'zh-CN'});window.followupFixture.select=(kind,locale='zh-CN')=>set({kind,locale});const snapshot={locale:state.locale,dshLocale:state.locale,revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage(state.locale,key,params)};const self=state.kind==='self',failed=state.kind==='degraded';return <I18nProvider runtime={runtime}><main style={{maxWidth:720,margin:'30px auto',padding:20,fontFamily:'system-ui',background:'#fff',color:'#242424'}}><h2>测试群 · 原问题与回复</h2><p>本人：37×23等于多少？</p><article><strong>测试员工</strong><p>{message.text}</p><GroupMessageStatus message={self?{...message,authorId:'self'}:message} decision={failed?{...decision,kind:'degraded'}:self?{...decision,hops:0}:decision} status={failed?{...status,phase:'routing-failed',hintCode:'handoff-unavailable'}:status} archived={false} retrying={false} retryFailed={false} retry={()=>window.followupFixture.retries++}/></article></main></I18nProvider>}
 createRoot(document.getElementById('root')).render(<Root/>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'group-followup-status',resolveId:id=>id.endsWith('group-followup-status')?entryId:null,load:id=>id===entryId?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-followup-status',name:'GroupFollowupStatus',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const temporary=await mkdtemp(join(tmpdir(),'teloa-group-followup-'));t.after(()=>rm(temporary,{recursive:true,force:true}))
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1000,height:700}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body style="margin:0;background:#f6f5f2"><div id="root"></div></body></html>')
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const select=async(kind:string,locale='zh-CN')=>page.evaluate(({kind,locale}:{kind:string;locale:string})=>(window as any).followupFixture.select(kind,locale),{kind,locale})
 for(const [locale,text] of [['zh-CN','本轮没有其他接手人。'],['zh-Hant','本輪沒有其他接手人。'],['en','No other employee is taking over this round.']]){
  await select('employee',locale);await page.getByText(text!,{exact:true}).waitFor();assert.equal(await page.getByRole('button').count(),0,'员工空接力不显示重试')
 }
 await select('employee');await page.getByText('本轮没有其他接手人。',{exact:true}).waitFor()
 await page.screenshot({path:join(process.env.GROUP_FOLLOWUP_SHOT_DIR??temporary,'source-followup-desktop.png'),fullPage:true})
 await page.setViewportSize({width:375,height:700});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await page.getByRole('heading',{name:'测试群 · 原问题与回复',exact:true}).count(),1)
 await page.screenshot({path:join(process.env.GROUP_FOLLOWUP_SHOT_DIR??temporary,'source-followup-narrow.png'),fullPage:true})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await select('self');await page.getByText('暂无可回应的员工',{exact:true}).waitFor();await page.getByRole('button',{name:'重新安排',exact:true}).click()
 await select('degraded');await page.getByText('未能安排回应',{exact:true}).waitFor();await page.getByRole('button',{name:'重新安排',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).followupFixture.retries),2,'只有明确点击才提交原重试回调')
 assert.deepEqual(errors,[])
})
