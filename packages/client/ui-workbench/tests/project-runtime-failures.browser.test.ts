import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('候选页失败可读，丢回执按原请求恢复且暂停拒绝保留草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-project-failures-ui-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ProjectRuntimePanel} from ${JSON.stringify(join(client,'ProjectRuntimePanel.tsx'))};import {createProjectRuntimeApi} from ${JSON.stringify(join(client,'project-runtime-api.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const projectId='10000000-0000-4000-8000-000000000001',eventId='20000000-0000-4000-8000-000000000001',project={id:projectId,scope:'general',title:'项目',state:'running'};let stored=null,retried=false,paused=false;const calls=[];
 const journal={read:()=>stored,write:value=>{stored=value},clear:()=>{stored=null}},createApi=()=>({runtime:createProjectRuntimeApi(async(endpoint,input)=>{calls.push([endpoint,input]);if(endpoint.endsWith('/settings'))return {projectId,version:0,automatic:paused?'paused':'decisions',readPersonal:false,resources:[]};if(endpoint.endsWith('/candidates')||endpoint.endsWith('/uses'))return {rows:[]};if(endpoint.endsWith('/failures'))return {rows:retried&&!paused?[]:[{eventId,projectId,attempts:3,errorCode:'teloa/dependency-unavailable',canRetry:!paused}]};if(endpoint.endsWith('/retry')){if(paused)throw {code:'teloa/conflict',rejected:true,message:'private stack /secret/path'};if(!retried){retried=true;throw Error('lost receipt private stack /secret/path')}return {ok:true}};throw Error(endpoint)},journal),candidates:async()=>[]});
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 function App(){const [api,setApi]=useState(createApi),[key,setKey]=useState(0);return <><button onClick={()=>{setApi(createApi());setKey(n=>n+1)}}>重新进入项目</button><ProjectRuntimePanel key={key} project={project} api={api} open contextVersion={0}/></>};window.fixture={calls,failAgain:()=>{retried=false},pause:()=>{paused=true},draft:()=>JSON.parse(stored).drafts[0]};createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ProjectFailureTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1200,height:900}});t.after(()=>page.close());page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/project-failure-test'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/project-failure-test');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByText('记忆设置',{exact:true}).click()
 await page.getByLabel('自动积累').selectOption('verified')
 await page.getByRole('button',{name:'待核对',exact:true}).click();await page.getByText('模型或服务暂时不可用，未保存新的项目记忆。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 assert.equal((await page.evaluate(()=> (window as any).fixture.calls)).filter((row:any[])=>row[0]==='project-runtime/retry').length,0,'读取或刷新失败列表不派发模型')
 await page.getByRole('button',{name:'重试提炼',exact:true}).click();await page.getByRole('button',{name:'核对上次操作',exact:true}).waitFor()
 await page.getByRole('button',{name:'重新进入项目',exact:true}).click();await page.getByRole('button',{name:'核对上次操作',exact:true}).waitFor()
 assert.equal((await page.evaluate(()=> (window as any).fixture.calls)).filter((row:any[])=>row[0]==='project-runtime/retry').length,1,'重新进入不自动派发重试')
 await page.getByRole('button',{name:'核对上次操作',exact:true}).click();await page.getByText('重试已受理，结果会显示在待核对内容或项目记忆中。',{exact:true}).waitFor()
 const retries=(await page.evaluate(()=> (window as any).fixture.calls)).filter((row:any[])=>row[0]==='project-runtime/retry')
 assert.equal(retries.length,2);assert.deepEqual(retries[0],retries[1])
 assert.equal(await page.getByLabel('自动积累').inputValue(),'verified','重试成功不提交或清空设置草稿')
 await page.evaluate(()=> (window as any).fixture.failAgain())
 await page.getByRole('button',{name:'待核对',exact:true}).click();await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.getByRole('button',{name:'重试提炼',exact:true}).waitFor()
 await page.evaluate(()=> (window as any).fixture.pause())
 // 模拟另一窗口暂停后，仍从已读取的可重试入口发出请求；服务端明确拒绝。
 await page.getByRole('button',{name:'重试提炼',exact:true}).click()
 await page.getByText('来源或设置已改变，请刷新核对是否仍可重试。',{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'核对上次操作',exact:true}).count(),0,'明确拒绝不保留未知操作')
 await page.getByRole('button',{name:'刷新',exact:true}).click()
 await page.getByText('积累已暂停。恢复积累并保存设置后才能重试。',{exact:true}).waitFor()
 assert.equal(await page.getByRole('button',{name:'重试提炼',exact:true}).isDisabled(),true)
 assert.equal(await page.evaluate(()=> (window as any).fixture.draft().automatic),'verified')
 assert.equal((await page.getByRole('region',{name:'记忆与资料',exact:true}).textContent())?.includes('/secret/path'),false)
 assert.deepEqual(errors,[])
})
