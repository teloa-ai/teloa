import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('候选可展开原始依据，关闭查看不提交并保留设置草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-project-evidence-ui-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ProjectRuntimePanel} from ${JSON.stringify(join(client,'ProjectRuntimePanel.tsx'))};import {createProjectRuntimeApi} from ${JSON.stringify(join(client,'project-runtime-api.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const projectId='10000000-0000-4000-8000-000000000001',project={id:projectId,scope:'general',title:'项目',state:'running'};let stored=null;const calls=[],runtime=createProjectRuntimeApi(async(endpoint,input)=>{calls.push([endpoint,input]);if(endpoint.endsWith('/settings'))return {projectId,version:0,automatic:'decisions',readPersonal:false,resources:[]};if(endpoint.endsWith('/candidates'))return {rows:[{id:'20000000-0000-4000-8000-000000000001',projectId,topic:'发布经验',markdown:'先检查清单',kind:'memory',status:'candidate',reason:'needs-review',version:1,source:{sessionId:'30000000-0000-4000-8000-000000000001',messageId:'message-1'},evidence:[{kind:'decision',text:'本人决定每次先检查清单'},{kind:'verified',text:'正式核实：本次清单已检查'},{kind:'untrusted',text:'尚未核实的外部说法'},{kind:'assistant',text:'助手的建议'}]}]};if(endpoint.endsWith('/uses')||endpoint.endsWith('/failures'))return {rows:[]};throw Error(endpoint)},{read:()=>stored,write:value=>{stored=value},clear:()=>{stored=null}}),api={runtime,candidates:async()=>[]};
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};function App(){const [shown,setShown]=useState(true);return <><button onClick={()=>setShown(!shown)}>显示或关闭项目背景</button>{shown&&<ProjectRuntimePanel project={project} api={api} open contextVersion={0}/>}</>};window.fixture={calls};createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ProjectEvidenceTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1200,height:900}});t.after(()=>page.close());page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/project-evidence-test'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/project-evidence-test');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByText('记忆设置',{exact:true}).click()
 await page.getByLabel('自动积累').selectOption('verified');await page.getByRole('button',{name:'待核对',exact:true}).click()
 assert.equal(await page.getByText('本人决定每次先检查清单',{exact:true}).isVisible(),false)
 await page.getByText('原始依据',{exact:true}).click()
 await page.getByText('本人决定每次先检查清单',{exact:true}).waitFor();await page.getByText('正式核实：本次清单已检查',{exact:true}).waitFor()
 await page.getByText('本人决策',{exact:true}).waitFor();await page.getByText('正式核实',{exact:true}).waitFor();await page.getByText('未核实内容',{exact:true}).waitFor();await page.getByText('助手内容',{exact:true}).waitFor()
 assert.equal((await page.getByRole('region',{name:'记忆与资料',exact:true}).textContent())?.includes('30000000-0000-4000-8000-000000000001'),false)
 await page.getByText('原始依据',{exact:true}).click();assert.equal(await page.getByText('本人决定每次先检查清单',{exact:true}).isVisible(),false)
 await page.getByRole('button',{name:'显示或关闭项目背景',exact:true}).click();await page.getByRole('button',{name:'显示或关闭项目背景',exact:true}).click()
 assert.equal(await page.getByLabel('自动积累').inputValue(),'verified','关闭原始依据与项目背景均保留草稿')
 const calls=await page.evaluate(()=> (window as any).fixture.calls)
 assert.equal(calls.some((row:any[])=>['project-runtime/resolve','project-runtime/configure'].includes(row[0])),false,'查看来源不提交配置或采纳候选')
 assert.deepEqual(errors,[])
})
