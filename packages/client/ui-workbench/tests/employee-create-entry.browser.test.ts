import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('员工Markdown创建保留原稿、自动带入业务，仅核对后写入',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__employee_create_entry_fixture.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {EmployeeCreateEntry} from '${client}EmployeeCreateEntry.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {ThemePresenter} from '${client}theme-presenter.ts';import tokens from '${client}theme-tokens.module.css';
 new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});document.body.classList.add(tokens.tokens);
 const noop=()=>{},saved=new Map(),storage={getItem:key=>saved.get(key)??null,setItem:(key,value)=>saved.set(key,value),removeItem:key=>saved.delete(key)},stamp='2026-10-18T00:00:00Z';
 const fields={name:'资料研究员',kind:'employee',scopes:['research'],duty:'核实资料并标注来源',dataScope:'本人提供的资料',executionScope:'仅整理，不发送、不改动外部系统',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]}};
 const draft={id:'role-draft',ownerId:'owner',requestId:'original-request',entity:'role',body:JSON.stringify(fields),bodyHash:'a'.repeat(64),title:fields.name,status:'draft',createdAt:stamp,updatedAt:stamp};
 const f=window.employeeCreate={prepared:[],created:[],settled:[],opened:[],fail:false,finish:noop};
 const api={directory:async()=>({schema:'teloa.page-create-drafts/v1',entity:'role',readAt:stamp,drafts:[draft]}),preview:async()=>({schema:'teloa.page-create-draft-preview/v1',draft,fields:[{path:'岗位',value:fields.duty},{path:'数据',value:fields.dataScope},{path:'边界',value:fields.executionScope}],fieldsTruncated:false,consequences:[],next:{endpoint:'roles/create',consentKeys:[]},computedAt:stamp}),settle:async input=>{f.settled.push(input)}};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const [open,setOpen]=useState(false);return <I18nProvider runtime={runtime}><main><button onClick={()=>setOpen(true)}>新建员工</button>{open&&<EmployeeCreateEntry api={api} scope="research" scopeName="研究业务" storage={storage} prepare={async(prompt,scope)=>{f.prepared.push({...prompt,scope});if(f.fail)throw Error('prepare failed')}} create={async fields=>{f.created.push(fields);await new Promise(resolve=>f.finish=resolve);return 'saved-employee'}} created={id=>f.opened.push(id)} close={()=>setOpen(false)}/>}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'employee-create-fixture',resolveId:id=>id.endsWith('employee-create-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'employee-create-fixture',name:'EmployeeCreateFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3500)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/employee-create'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/employee-create');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')+'\nbody{margin:0}'});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const opener=page.getByRole('button',{name:'新建员工',exact:true}),drawer=page.getByRole('dialog'),description=drawer.getByRole('textbox',{name:'创建说明',exact:true})
 await opener.click();await description.waitFor();assert.equal(await drawer.getByRole('textbox').count(),1);assert.equal(await drawer.locator('select').count(),0)
 assert.match(await description.getAttribute('placeholder')??'',/^# 资料研究员\n/)
 const markdown='# 资料研究员\n\n核实我提供的资料，标注来源。';await description.fill(markdown)
 await page.keyboard.press('Escape');await opener.click();assert.equal(await description.inputValue(),markdown)
 assert.deepEqual(await page.evaluate(()=>(window as any).employeeCreate.created),[])
 await page.evaluate(()=>(window as any).employeeCreate.fail=true);await drawer.getByRole('button',{name:'继续',exact:true}).click();await drawer.getByRole('alert').waitFor();assert.equal(await description.inputValue(),markdown)
 await page.evaluate(()=>(window as any).employeeCreate.fail=false);await drawer.getByRole('button',{name:'继续',exact:true}).click();await drawer.waitFor({state:'hidden'})
 const prepared=await page.evaluate(()=>(window as any).employeeCreate.prepared);assert.equal(prepared.length,2);assert.equal(prepared[1].scope,'research');assert.ok(prepared[1].text.includes(markdown));assert.match(prepared[1].text,/研究业务.*research/);assert.match(prepared[1].text,/员工正文的 scopes/)
 assert.deepEqual(await page.evaluate(()=>(window as any).employeeCreate.created),[],'准备不创建、不执行')
 await opener.click();await description.waitFor();assert.equal(await description.inputValue(),markdown,'成功预备后保留说明供恢复')
 for(const width of [1440,430]){await page.setViewportSize({width,height:900});const bounds=await drawer.evaluate((node:HTMLElement)=>({client:node.clientWidth,scroll:node.scrollWidth}));assert.ok(bounds.scroll<=bounds.client);if(process.env.TELOA_TEST_CAPTURE_DIR)await drawer.screenshot({path:process.env.TELOA_TEST_CAPTURE_DIR+'/employee-create-'+width+'.png'})}
 await drawer.locator('summary').filter({hasText:'资料研究员'}).click();await drawer.getByRole('button',{name:'确认',exact:true}).click();await page.waitForFunction(()=>(window as any).employeeCreate.created.length===1)
 await page.waitForFunction(()=>document.querySelector<HTMLButtonElement>('dialog button[aria-label="关闭"]')?.disabled===true);await page.keyboard.press('Escape');assert.equal(await drawer.isVisible(),true)
 await page.evaluate(()=>(window as any).employeeCreate.finish());await drawer.waitFor({state:'hidden'})
 const result=await page.evaluate(()=>(window as any).employeeCreate);assert.equal(result.created[0].scopes[0],'research');assert.equal(result.created[0].executionScope,'仅整理，不发送、不改动外部系统');assert.equal(result.settled[0].draftId,'role-draft');assert.equal(result.settled[0].expectedBodyHash,'a'.repeat(64));assert.equal(result.settled[0].appliedRef,'saved-employee');assert.deepEqual(result.opened,['saved-employee']);assert.deepEqual(errors,[])
})
