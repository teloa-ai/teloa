import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('员工摘要按连接立即隔离，离开工作页签后的迟到成果读取不能重新打开旧内容',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-employee-summary-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {EmployeeWorkOverview} from ${JSON.stringify(join(client,'EmployeeWorkOverview.tsx'))};import {EmployeeGrantedTools} from ${JSON.stringify(join(client,'EmployeeGrantedTools.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={t:(key,params)=>translateMessage('en',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const role={id:'same-role-id',version:1,kind:'employee',storage:'persistent',state:'active',scopes:['general']},f={opened:[]};window.summaryFixture=f;
 const output=title=>({artifactId:'artifact',number:1,title}),grant=name=>({grant:{state:'active',rules:[{name}]}});
 const oldOutputs={listByRole:async()=>[output('Old connection output')]},oldTools={get:async()=>grant('tool.old')};
 const newOutputs={listByRole:()=>new Promise(resolve=>{f.outputs=()=>resolve([output('New connection output')])})},newTools={get:()=>new Promise(resolve=>{f.tools=()=>resolve(grant('tool.new'))})};
 function App(){const [identity,setIdentity]=useState('old'),[active,setActive]=useState(true);return <I18nProvider runtime={runtime}><button onClick={()=>setIdentity('new')}>Switch connection</button><button onClick={()=>setActive(value=>!value)}>Toggle work visibility</button><EmployeeGrantedTools role={role} api={identity==='old'?oldTools:newTools} open={()=>{}}/><EmployeeWorkOverview active={active} artifacts={identity==='old'?oldOutputs:newOutputs} role={role} tasks={[]} state={{artifacts:[]}} scopeName={value=>value} openTask={()=>{}} resources={()=>{}} openArtifact={async(row,current)=>{await new Promise(resolve=>{f.open=resolve});if(current())f.opened.push(row.title)}}/></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'EmployeeSummaryIdentity',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(4000);const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addScriptTag({content:bundle.output.filter(x=>x.type==='chunk').map(x=>x.code).join('\n')})
 await page.getByRole('button',{name:/Old connection output/}).waitFor().catch(async(error:Error)=>{throw Error(JSON.stringify({errors,body:await page.locator('#root').innerText()}),{cause:error})});await page.getByRole('button',{name:'tool.old',exact:true}).waitFor()
 await page.getByRole('button',{name:'Switch connection',exact:true}).click()
 assert.doesNotMatch(await page.locator('#root').innerText(),/Old connection output|tool.old/)
 await page.waitForFunction(()=>!!(window as any).summaryFixture.outputs&&!!(window as any).summaryFixture.tools)
 await page.evaluate(()=>{const f=(window as any).summaryFixture;f.outputs();f.tools()})
 const open=page.getByRole('button',{name:/New connection output/});await open.waitFor();await page.getByRole('button',{name:'tool.new',exact:true}).waitFor()
 await open.click();await page.getByRole('button',{name:'Toggle work visibility'}).click();await page.evaluate(()=>(window as any).summaryFixture.open())
 assert.deepEqual(await page.evaluate(()=>(window as any).summaryFixture.opened),[])
 await page.getByRole('button',{name:'Toggle work visibility'}).click();await open.click();await page.evaluate(()=>(window as any).summaryFixture.open())
 await page.waitForFunction(()=>(window as any).summaryFixture.opened.length===1)
 assert.deepEqual(await page.evaluate(()=>(window as any).summaryFixture.opened),['New connection output'])
})
