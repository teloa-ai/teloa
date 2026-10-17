import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {buildSharePlan} from '../src/client/share-package-plan.ts'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('应用和技能接收空组成不能确认；重新选择可继续且员工本体不受影响',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-share-selection-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {TemplateShareReceive} from ${JSON.stringify(join(client,'TemplateShareReceive.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};window.selectionCalls=[];
 const accept=async(pkg,choice)=>{window.selectionCalls.push(choice);return {sha256:'a'.repeat(64),complete:false,roleIds:[],roles:[],coordinator:'skipped',pendingKinds:[],skills:[],mcp:[],plugins:[],plans:[]}};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><TemplateShareReceive open close={()=>{}} intent={null} accept={accept} openRole={()=>{}} configure={()=>{}}/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ShareSelection',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><body><div id="root"></div></body>')
 await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 const dialog=page.getByRole('dialog',{name:'导入模板',exact:true}),file=dialog.locator('input[type=file]'),skill={name:'notes',text:'---\nname: notes\ndescription: Summarize provided notes\n---\nUse supplied notes only.',license:'MIT'}
 for(const subject of ['app','skill'] as const){
  const pkg=buildSharePlan({subject,title:subject,publisher:'Test',license:'MIT',roles:[],skills:[skill]})
  await file.setInputFiles({name:'template.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pkg))})
  const add=dialog.getByRole('button',{name:'确认添加',exact:true}),option=dialog.getByRole('checkbox');await option.waitFor();assert.equal(await add.isDisabled(),false)
  await option.uncheck();assert.equal(await add.isDisabled(),true);await dialog.getByText('至少选择一项内容。',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>(window as any).selectionCalls),[])
  await option.check();assert.equal(await add.isDisabled(),false);assert.equal(await dialog.getByText('至少选择一项内容。',{exact:true}).count(),0)
 }
 const employee=buildSharePlan({subject:'employee',title:'Employee',publisher:'Test',license:'MIT',roles:[{id:'e',name:'Employee',kind:'employee',duty:'Summarize supplied notes.',dataScope:'Supplied notes.',executionScope:'Ask before sending.',skills:['notes'],knowledge:[]}],skills:[skill]})
 await file.setInputFiles({name:'employee.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(employee))});const option=dialog.getByRole('checkbox');await option.waitFor();await option.uncheck();assert.equal(await dialog.getByRole('button',{name:'确认添加',exact:true}).isDisabled(),false,'员工本体仍会添加，不是空包');assert.deepEqual(await page.evaluate(()=>(window as any).selectionCalls),[]);assert.deepEqual(errors,[])
})

test('本地模板确认挂起后关闭重开：等待并锁定原选择，迟到回执不覆盖恢复内容',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-share-recovery-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {TemplateShareReceive} from ${JSON.stringify(join(client,'TemplateShareReceive.tsx'))};import {createShareAcceptance} from ${JSON.stringify(join(client,'template-share-accept.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},values=new Map(),storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
 let releaseAck,releaseChoice;const ack=new Promise(resolve=>releaseAck=resolve),choiceGate=new Promise(resolve=>releaseChoice=resolve);window.recovery={loads:[],imports:0,choiceReads:0,holdChoice:false,firstFinished:false,releaseAck:()=>releaseAck(),releaseChoice:()=>releaseChoice()};
 const flow=createShareAcceptance(storage,{createRole:async()=>{throw Error('不应直接建员工')},industry:{target:async()=>({kind:'existing',spaceId:'00000000-0000-4000-8000-000000000001',expectedVersion:1}),importContent:async item=>{window.recovery.imports++;return {...item,contentStorage:{contentId:'00000000-0000-4000-8000-000000000002',createdAt:'2026-10-16T00:00:00Z',loaded:true}}},load:async request=>{window.recovery.loads.push(request);await ack;window.recovery.firstFinished=true;throw Error('原确认回执丢失')}}});
 const savedChoice=async pkg=>{window.recovery.choiceReads++;if(window.recovery.holdChoice)await choiceGate;return flow.choice(pkg)};
 function App(){const [open,setOpen]=useState(true);return <I18nProvider runtime={runtime}><button onClick={()=>setOpen(true)}>重新打开</button><TemplateShareReceive open={open} close={()=>setOpen(false)} intent={null} accept={flow.accept} savedChoice={savedChoice} openRole={()=>{}} configure={()=>{}} targets={[{scope:'support',title:'支持业务'}]}/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ShareRecovery',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 // 只拦截本轮本机来源文档，让真实浏览器提供 WebCrypto；不连接任何服务或端口。
 const fixtureUrl='http://127.0.0.1/teloa-share-recovery'
 await page.route('**/*',(route:{abort:()=>Promise<void>;request:()=>{url:()=>string};fulfill:(input:{contentType:string;body:string})=>Promise<void>})=>route.request().url()===fixtureUrl?route.fulfill({contentType:'text/html',body:'<!doctype html><body><div id="root"></div></body>'}):route.abort());await page.goto(fixtureUrl)
 await page.addStyleTag({content:bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(row=>row.type==='chunk')!.code})
 const pkg=buildSharePlan({subject:'employee',title:'原员工模板',publisher:'Test',license:'MIT',roles:[{id:'employee',name:'原员工',kind:'employee',duty:'核对资料',dataScope:'本人提供的材料',executionScope:'对外操作前确认',skills:['notes'],knowledge:[]}],skills:[{name:'notes',license:'MIT',text:'---\nname: notes\ndescription: Keep supplied notes\n---\n# Notes'}]})
 const dialog=page.getByRole('dialog',{name:'导入模板',exact:true}),option=dialog.getByRole('checkbox'),scope=dialog.getByRole('combobox'),confirm=dialog.getByRole('button',{name:/^(确认添加|正在处理…)$/})
 await dialog.locator('input[type=file]').setInputFiles({name:'employee.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(pkg))});await option.waitFor();await scope.selectOption('support');await option.uncheck();await confirm.click()
 await page.waitForFunction(()=>Reflect.get(window,'recovery').loads.length===1)
 await page.evaluate(()=>{Reflect.get(window,'recovery').holdChoice=true});await dialog.getByRole('button',{name:'关闭',exact:true}).click();await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'重新打开',exact:true}).click();await dialog.waitFor()
 await page.waitForFunction(()=>Reflect.get(window,'recovery').choiceReads===2)
 assert.equal(await option.isDisabled(),true,'原选择未核实前不可改选');assert.equal(await scope.isDisabled(),true);assert.equal(await confirm.isDisabled(),true)
 await page.evaluate(()=>Reflect.get(window,'recovery').releaseChoice());await dialog.getByText('这份模板已开始添加，将按原来的业务范围和所选技能继续，不会重复创建。',{exact:true}).waitFor();assert.equal(await scope.inputValue(),'support');assert.equal(await option.isChecked(),false);assert.equal(await option.isDisabled(),true);assert.equal(await scope.isDisabled(),true)
 await page.evaluate(()=>Reflect.get(window,'recovery').releaseAck());await page.waitForFunction(()=>Reflect.get(window,'recovery').firstFinished)
 assert.equal(await scope.inputValue(),'support');assert.equal(await option.isChecked(),false);assert.equal(await option.isDisabled(),true);assert.equal(await scope.isDisabled(),true);assert.equal(await confirm.isDisabled(),false,'原回执迟到不锁住新视图的继续入口')
 assert.deepEqual(await page.evaluate(()=>({loads:Reflect.get(window,'recovery').loads.length,imports:Reflect.get(window,'recovery').imports})),{loads:1,imports:1});assert.deepEqual(errors,[])
})
