import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有本机无头浏览器夹具。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-setup-review-'))
 await writeFile(join(temp,'entry.tsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';import {BusinessSetupReview} from '${client}BusinessSetupReview.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(k,p)=>translateMessage('zh-CN',k,p),subscribe:()=>()=>{},getSnapshot:()=>snapshot},f=window.setupReview={requests:[],opens:[],adjustments:0};
 const api={setupPlans:(input,signal)=>new Promise((resolve,reject)=>f.requests.push({input,signal,resolve,reject}))};
 function App(){const [scope,setScope]=React.useState('SOC'),[opened,setOpened]=React.useState(true);f.scope=value=>setScope(value);f.close=()=>setOpened(false);return <I18nProvider runtime={runtime}>{opened&&<BusinessSetupReview api={api} scope={scope} adjust={()=>f.adjustments++} open={async(item,current)=>{f.opens.push({item,current});await new Promise(resolve=>f.finish=resolve)}}/>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
 `)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'SetupReview',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){const page=await browser.newPage();page.setDefaultTimeout(4000);t.after(()=>page.close());await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><div id="root"></div></html>');await page.addScriptTag({content:script});await page.waitForFunction(()=>(window as any).setupReview.requests.length===1);return page}
const item={draftId:'7d3bf90a-7c42-4f51-82de-72c8d889b674',scope:'SOC',sessionId:'original-builder',title:'原业务方案',revision:3}
test('复核原方案只在明确点击后打开；关闭令在途导航失效',async t=>{
 const page=await mount(t);await page.evaluate((value:typeof item)=>(window as any).setupReview.requests[0].resolve({items:[value]}),item)
 await page.getByText(item.title,{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).setupReview.opens.length),0)
 await page.getByRole('button',{name:'复核完整方案',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).setupReview.opens[0].item),item)
 await page.evaluate(()=>(window as any).setupReview.close());await page.getByRole('region').waitFor({state:'detached'})
 assert.equal(await page.evaluate(()=>(window as any).setupReview.opens[0].current()),false);await page.evaluate(()=>(window as any).setupReview.finish())
})
test('切换业务后旧目录迟答不能替换新目录，也不能自动打开',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).setupReview.scope('CRM'));await page.waitForFunction(()=>(window as any).setupReview.requests.length===2)
 await page.evaluate(()=>(window as any).setupReview.requests[1].resolve({items:[]}));await page.getByText('当前业务没有待复核的搭建方案。',{exact:true}).waitFor()
 await page.evaluate((value:typeof item)=>(window as any).setupReview.requests[0].resolve({items:[value]}),item);assert.equal(await page.getByText(item.title,{exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).setupReview.opens.length),0)
})
test('读取失败允许重试；空目录须本人点击才开始调整',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).setupReview.requests[0].reject(Error('unavailable')));await page.getByRole('alert').waitFor()
 await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction(()=>(window as any).setupReview.requests.length===2);await page.evaluate(()=>(window as any).setupReview.requests[1].resolve({items:[]}))
 await page.getByText('当前业务没有待复核的搭建方案。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).setupReview.adjustments),0)
 await page.getByRole('button',{name:'打开搭建会话',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).setupReview.adjustments),1)
})
