import {test,before,after,type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用工作区统一的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:Awaited<ReturnType<ReturnType<typeof loadPlaywright>['chromium']['launch']>>,script:string,styles:string
before(async()=>{
 const raw=JSON.parse(await readFile(new URL('./fixtures/task-run-delivery-installed97.json',import.meta.url),'utf8'))
 const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {createTaskRunApi} from '${client}task-run-api.ts';import {TaskExecutions} from '${client}TaskExecutions.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const raw=${JSON.stringify(raw)}.find(row=>row.deliveryCheck.state===document.documentElement.dataset.delivery),locale='en',snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.deliveryCodecFixture={rows:[],known:false,calls:[],waiting:translateMessage(locale,'taskCompletion.verificationWaiting.title'),completed:translateMessage(locale,'taskExecution.reason.completed')};
const api=createTaskRunApi(async(method,payload)=>{f.calls.push([method,payload]);if(method==='task-runs/origin')return {taskId:raw.taskId,runId:null,source:null};if(method==='task-runs/list')return [raw];throw Error('Unexpected fixture endpoint '+method)}),noop=()=>{};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><TaskExecutions taskId={raw.taskId} taskVersion={3} taskState="waiting" assigned api={api} open={noop} changed={noop} onRuns={(rows,known)=>{f.rows=rows;f.known=known}}/></I18nProvider>);
`
 const virtual=root+'__task_run_delivery_codec.tsx',result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'task-run-delivery-codec',resolveId:id=>id.endsWith('task-run-delivery-codec')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'task-run-delivery-codec',name:'TaskRunDeliveryCodec',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch({...launchOptions(),headless:true})
})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,state:'unknown'|'saved'){
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors:string[]=[]
 page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 const url='http://127.0.0.1:49328/task-run-delivery-codec'
 await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort())
 await page.route(url,(route:{fulfill:(response:{status:number;contentType:string;body:string})=>Promise<void>})=>route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><html lang="en" data-delivery="'+state+'"><body><div id="root"></div></body></html>'}))
 await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).deliveryCodecFixture.known)
 return page
}
test('实际97未保存员工回包经codec进入真实Run组件，显示待交付且保持warn',async t=>{
 const page=await mount(t,'unknown'),f=await page.evaluate(()=>(window as any).deliveryCodecFixture)
 assert.equal(f.rows[0].state,'ended');assert.equal(f.rows[0].reason,'completed');assert.deepEqual(f.rows[0].deliveryCheck,{state:'unknown'})
 assert.equal(await page.locator('[data-tone="warn"]').getByText(f.waiting,{exact:true}).count(),1)
 assert.equal(await page.locator('[data-tone="good"]').count(),0)
 assert.equal(await page.getByText('The returned information is incomplete or does not match this operation. The result cannot yet be confirmed.',{exact:true}).count(),0)
})
test('实际97已保存员工回包经codec保持saved，原生完成与交付核验不混写',async t=>{
 const page=await mount(t,'saved'),f=await page.evaluate(()=>(window as any).deliveryCodecFixture)
 assert.equal(f.rows[0].state,'ended');assert.equal(f.rows[0].reason,'completed');assert.deepEqual(f.rows[0].deliveryCheck,{state:'saved'})
 assert.equal(await page.locator('[data-tone="good"]').getByText(f.completed,{exact:true}).count(),1)
 assert.equal(await page.getByText(f.waiting,{exact:true}).count(),0)
})
