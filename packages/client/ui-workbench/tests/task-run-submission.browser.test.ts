import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:Awaited<ReturnType<ReturnType<typeof loadPlaywright>['chromium']['launch']>>,script:string,styles:string
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {TaskExecutions} from '${client}TaskExecutions.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const known=window.submissionMode==='not-published';const f=window.submissionFixture={disposed:0,started:0,reconciled:0,stopped:0};let run={id:'original-run',taskId:'original-task',taskVersion:2,roleVersion:1,sessionId:'original-session',nativeRequestId:'00000000-0000-4000-8000-000000000001',state:'submitting',submissionRecovery:known?'not-published':'unknown',stopRequestedAt:known?'2026-10-25T10:01:00.000Z':null,goal:'核对原告警的新增证据',roleName:'SOC 调查员工',createdAt:'2026-10-25T10:00:00.000Z',skills:[],knowledge:[]};
const api={origin:async()=>({taskId:run.taskId,source:null}),list:async()=>[structuredClone(run)],pending:()=>undefined,recoveryMessage:()=>undefined,reconcile:async()=>{f.reconciled++;return structuredClone(run)},disposeUnknown:async input=>{if(input.id!==run.id)throw Error('身份变化');f.disposed++;run={...run,state:'submission_unknown',stopRequestedAt:'2026-10-25T10:01:00.000Z'};return structuredClone(run)},stop:async()=>{f.stopped++;run={...run,state:'withdrawn'};return structuredClone(run)},start:async()=>{f.started++;return structuredClone(run)}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><TaskExecutions taskId={run.taskId} taskVersion={2} taskState="running" assigned api={api} open={async()=>{}} changed={()=>{}}/></I18nProvider>);`
before(async()=>{
 const virtual=root+'__task_run_submission.tsx',result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'task-run-submission',resolveId:id=>id.endsWith('task-run-submission-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'task-run-submission-fixture',name:'SubmissionFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close()})
test('未知提交先告知再本人确认，取消无副作用；刷新保留原Run且不自动重发',async t=>{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 const url='http://127.0.0.1:49327/submission-recovery';await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.route(url,(route:{fulfill:(v:unknown)=>Promise<void>})=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}));await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const card=page.locator('[data-teloa-run-id="original-run"]');await card.waitFor()
 await page.getByRole('button',{name:'结束本次未知提交',exact:true}).click();await page.getByRole('button',{name:'确认结束，保留结果未知',exact:true}).waitFor()
 await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.evaluate(()=>Reflect.get(window,'submissionFixture').disposed),0)
 await page.getByRole('button',{name:'结束本次未知提交',exact:true}).click();await page.getByRole('button',{name:'确认结束，保留结果未知',exact:true}).click()
 await card.getByText('已结束提交 · 结果未知',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>Reflect.get(window,'submissionFixture').disposed),1)
 await page.getByRole('button',{name:'刷新',exact:true}).click();await card.getByText('已结束提交 · 结果未知',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>Reflect.get(window,'submissionFixture').started),0);assert.equal(await page.getByRole('button',{name:'确认结束，保留结果未知',exact:true}).count(),0)
 assert.equal(await page.getByText('已完成',{exact:true}).count(),0)
 if(process.env.TELOA_TEST_ARTIFACT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_ARTIFACT_DIR,'submission-unknown.png'),fullPage:true})
})

test('确定未发布且已停止不展示未知或重发入口，正常停止回执撤回并清除等待',async t=>{
 const page=await browser.newPage({viewport:{width:1100,height:900}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 const url='http://127.0.0.1:49327/submission-cancel';await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.route(url,(route:{fulfill:(v:unknown)=>Promise<void>})=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}));await page.goto(url);await page.evaluate(()=>Reflect.set(window,'submissionMode','not-published'));await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const card=page.locator('[data-teloa-run-id="original-run"]');await card.getByText('本次提交确定未发送。',{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'继续原提交',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'结束本次未知提交',exact:true}).count(),0)
 await card.getByRole('button',{name:'停止',exact:true}).click();await card.getByText('已撤回',{exact:true}).waitFor()
 assert.equal(await page.getByText('停止请求已提交，正在等待执行端结束。',{exact:true}).count(),0)
 const f=await page.evaluate(()=>Reflect.get(window,'submissionFixture'));assert.equal(f.stopped,1);assert.equal(f.started,0);assert.equal(f.disposed,0)
 if(process.env.TELOA_TEST_ARTIFACT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_ARTIFACT_DIR,'submission-notpublished-cancelled.png'),fullPage:true})
})
