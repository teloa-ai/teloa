import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用项目浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('实际 React 授权主体分别显示本人、员工任务、委托版本与未知历史，模型证据保持独立',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-run-authority-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {readRunRoleSnapshot} from '@teloa/contract';import {TaskRunModels} from ${JSON.stringify(join(client,'TaskRunModels.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
let snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};const listeners=new Set(),runtime={t:(key,params)=>translateMessage(snapshot.locale,key,params),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getSnapshot:()=>snapshot},policy={primary:{provider:'configured-provider',model:'configured-model'}},id='11111111-1111-4111-8111-111111111111',snapshotRole=authorization=>readRunRoleSnapshot({schema:'teloa.run-role/v2',id,version:2,kind:'employee',name:'核验员',scopes:['SOC'],duty:'核对来源',dataScope:'已授权资料',executionScope:'核验',skills:[],knowledge:[],responsibility:{triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]},authorization,twinConsent:null}),rows={owner:{executor:{kind:'owner',grantId:id,grantVersion:3},scope:'general',modelPolicy:policy},role:{executor:{kind:'role',roleId:id,roleVersion:2},roleSnapshot:snapshotRole({kind:'task',taskId:id,taskContentVersion:4}),scope:'SOC',modelPolicy:policy},delegation:{executor:{kind:'role',roleId:id,roleVersion:2},roleSnapshot:snapshotRole({kind:'delegation',delegationId:id,delegationVersion:7}),scope:'SOC',modelPolicy:policy},unknown:{scope:'SOC'}};window.fixture={locale:value=>{snapshot={locale:value,dshLocale:value==='en'?'en':'zh',revision:snapshot.revision+1};listeners.forEach(fn=>fn())}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><main>{Object.entries(rows).map(([kind,run])=><section key={kind} aria-label={kind}><TaskRunModels run={run} planned/></section>)}<section aria-label="observed"><TaskRunModels run={{modelPolicy:policy,modelStatus:{state:'observed',requestSeq:987654,model:{provider:'actual-provider',model:'actual-model'}}}}/></section></main></I18nProvider>);
`)
 const built=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RunAuthorityFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,css=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n'),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:900,height:800}}),errors:string[]=[];t.after(()=>page.close());page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/run-authority'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1/run-authority');await page.addStyleTag({content:css});await page.addScriptTag({content:script})
 await page.getByRole('region',{name:'owner',exact:true}).getByText(/本人授权的执行/).waitFor()
 assert.match(await page.getByRole('region',{name:'owner',exact:true}).innerText(),/实际授权主体：本人授权的执行.*本次业务范围：general/s)
 assert.match(await page.getByRole('region',{name:'role',exact:true}).innerText(),/核验员 · 本人确认的任务授权.*本次业务范围：SOC/s)
 assert.match(await page.getByRole('region',{name:'delegation',exact:true}).innerText(),/核验员 · 本人执行委托 v7.*本次业务范围：SOC/s)
 assert.match(await page.getByRole('region',{name:'unknown',exact:true}).innerText(),/历史授权主体尚未核实/)
 const actual=await page.getByRole('region',{name:'observed',exact:true}).innerText();assert.match(actual,/请求模型：actual-model/);assert.doesNotMatch(actual,/configured-model|987654|actual-provider/)
 assert.doesNotMatch(await page.locator('main').innerText(),/11111111-1111-4111-8111-111111111111|delegationId|grantId/)
 await page.evaluate(()=>(window as any).fixture.locale('en'));await page.getByRole('region',{name:'owner',exact:true}).getByText(/Execution authorized by the owner/).waitFor()
 assert.match(await page.getByRole('region',{name:'role',exact:true}).innerText(),/Owner-approved task authorization/)
 assert.match(await page.getByRole('region',{name:'delegation',exact:true}).innerText(),/Owner delegation v7/)
 assert.match(await page.getByRole('region',{name:'unknown',exact:true}).innerText(),/Historical execution authority is unverified/)
 assert.deepEqual(errors,[])
})
