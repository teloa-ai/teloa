import {test,before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string
const entry=`
import React,{useState} from 'react';import{createRoot}from'react-dom/client';
import{TaskExecutions}from'${client}TaskExecutions.tsx';
import{I18nProvider}from'${client}i18n/provider.tsx';import{translateMessage}from'${client}i18n/messages.ts';
const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('en',key,params)};
const taskId='22222222-2222-4222-8222-222222222222',runId='11111111-1111-4111-8111-111111111111',controlId='33333333-3333-4333-8333-333333333333';
const f=window.resumeFixture={hold:false,waiting:false,release:()=>{},resumes:[],reads:0,changed:false,leave:()=>{},switchApi:()=>{}};
const control={id:controlId,ownerId:'local:teloa-owner',scope:'round',version:3,generation:2,state:'paused',pendingRunIds:[],unknownOperationIds:[]};
const candidate={controlId,expectedGeneration:2,runId,nativeRequestId:runId,reason:'unaccepted'};
const row={id:runId,taskId,taskVersion:1,roleVersion:1,sessionId:'prepared-session',nativeRequestId:runId,state:'prepared',stopRequestedAt:null,goal:'Check the original evidence',roleName:'Researcher',createdAt:'2026-10-12T00:00:00.000Z',skills:[],knowledge:[],lineage:{ownerId:control.ownerId,roundControlId:controlId,controlGeneration:2,definitionControlId:null}};
const api={readiness:async(taskId,taskVersion)=>({schema:'teloa.task-run-readiness/v1',taskId,taskVersion,ready:true}),list:async()=>[row],origin:async()=>({taskId,runId:null,source:null}),pending:()=>undefined,recoveryMessage:()=>undefined,flowRequests:{sources:async()=>({bindings:[],approvals:[],materials:[]}),pending:()=>undefined,recoveryMessage:()=>undefined}};
const controls={pending:()=>undefined,recoveryMessage:()=>undefined,get:async()=>{f.reads++;if(f.hold){f.waiting=true;await new Promise(resolve=>f.release=resolve);f.waiting=false;}return {...control,version:f.changed?4:3}},inspect:async()=>[candidate],resume:async(fixed,runIds)=>{f.resumes.push({controlId:fixed.id,version:fixed.version,runIds})}};
const otherApi={...api,list:async()=>[]};
function App(){const [visible,setVisible]=useState(true),[switched,setSwitched]=useState(false);f.leave=()=>setVisible(false);f.switchApi=()=>setSwitched(true);return visible?<TaskExecutions taskId={taskId} taskVersion={1} taskState="ready" assigned api={switched?otherApi:api} controls={controls} changed={()=>{}} open={async()=>{}}/>:<h2>Another page</h2>}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
`
before(async()=>{
 const virtual=root+'__task_resume_navigation_fixture.tsx'
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'task-resume-navigation-fixture',resolveId:id=>id.endsWith('task-resume-navigation-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'task-resume-navigation-fixture',name:'TaskResumeNavigationFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
async function mount(t:TestContext){
 const page=await browser.newPage();page.setDefaultTimeout(5000);const errors:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="en"><div id="root"></div></html>');await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'Resume and start',exact:true}).first().waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({body:await page.locator('body').innerText(),errors,fixture:await page.evaluate(()=>(window as any).resumeFixture)}));throw error});return page
}
test('本人明确恢复后离开页面，完成原候选核对并仅提交一次，不因卸载吞掉动作',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{(window as any).resumeFixture.hold=true})
 await page.getByRole('button',{name:'Resume and start',exact:true}).first().click()
 await page.waitForFunction(()=>(window as any).resumeFixture.waiting)
 await page.evaluate(()=>(window as any).resumeFixture.leave());await page.getByRole('heading',{name:'Another page'}).waitFor()
 await page.evaluate(()=>(window as any).resumeFixture.release())
 await page.waitForFunction(()=>(window as any).resumeFixture.resumes.length===1)
 assert.deepEqual(await page.evaluate(()=>(window as any).resumeFixture.resumes),[{controlId:'33333333-3333-4333-8333-333333333333',version:3,runIds:['11111111-1111-4111-8111-111111111111']}])
})
test('仅离开不恢复；明确恢复后原控制变版也不能因已离开而跳过核对',async t=>{
 const untouched=await mount(t);await untouched.evaluate(()=>(window as any).resumeFixture.leave());assert.deepEqual(await untouched.evaluate(()=>(window as any).resumeFixture.resumes),[])
 const page=await mount(t);await page.evaluate(()=>{(window as any).resumeFixture.hold=true})
 await page.getByRole('button',{name:'Resume and start',exact:true}).first().click();await page.waitForFunction(()=>(window as any).resumeFixture.waiting)
 await page.evaluate(()=>{const f=(window as any).resumeFixture;f.changed=true;f.leave()});await page.getByRole('heading',{name:'Another page'}).waitFor()
 await page.evaluate(()=>(window as any).resumeFixture.release());await page.waitForFunction(()=>!(window as any).resumeFixture.waiting)
 assert.deepEqual(await page.evaluate(()=>(window as any).resumeFixture.resumes),[])
})
test('同Task切换API身份，已确认动作仍只提交原控制且旧结果不写入新页面',async t=>{
 const page=await mount(t);await page.evaluate(()=>{(window as any).resumeFixture.hold=true})
 await page.getByRole('button',{name:'Resume and start',exact:true}).first().click();await page.waitForFunction(()=>(window as any).resumeFixture.waiting)
 await page.evaluate(()=>(window as any).resumeFixture.switchApi());await page.getByRole('button',{name:'Resume and start',exact:true}).first().waitFor({state:'detached'})
 await page.evaluate(()=>(window as any).resumeFixture.release());await page.waitForFunction(()=>(window as any).resumeFixture.resumes.length===1)
 // 让原提交的list及React更新完成，再核新身份没有旧Researcher执行行。
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await page.getByText('Researcher',{exact:true}).count(),0)
})
