import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用仓内无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('真实额度组件保存有限或不限，保留用量、冲突草稿与原幂等请求',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__work_budget_panel.tsx'
 const fixture=`import React,{useMemo,useState}from'react';import{createRoot}from'react-dom/client';import{WorkBudgetPanel}from'${client}WorkBudgetPanel.tsx';import{createWorkBudgetApi}from'${client}work-budget-api.ts';import{I18nProvider}from'${client}i18n/provider.tsx';import{translateMessage}from'${client}i18n/messages.ts';import css from'${client}TaskPage.module.css';
const id='11111111-1111-4111-8111-111111111111',policy={maxTokens:2000000,maxGoalRounds:32,maxConcurrent:8,maxElapsedMs:21600000,maxRetries:3,stagnationRounds:3,money:null},unlimited={...policy,maxTokens:null,maxGoalRounds:null,maxConcurrent:null,maxElapsedMs:null},initial=document.documentElement.dataset.mode==='unlimited'?unlimited:policy,used={usedTokens:2500000,usedRounds:12,concurrent:2,usedElapsedMs:90000,moneyMinorUnits:null},f=window.budgetFixture={calls:[],commands:[],mutations:0,account:{...used,budgetAccountId:id,version:3,policy:initial},owner:{...used,usedTokens:2700000,version:7,policy:document.documentElement.dataset.mode==='unlimited'?unlimited:{...policy,maxTokens:8000000,maxRetries:5,stagnationRounds:7}},hold:false,loseOnce:false,conflictOnce:false,release:undefined,remount:undefined},receipts=new Map();
const call=async(endpoint,payload)=>{f.calls.push({endpoint,payload});if(endpoint==='work-budgets/read')return structuredClone(f.account);if(endpoint==='work-budgets/owner/read')return structuredClone(f.owner);if(endpoint==='work-budgets/configure'||endpoint==='work-budgets/owner/configure'){f.commands.push(structuredClone(payload));const scope=endpoint==='work-budgets/configure'?'account':'owner';if(f.conflictOnce){f.conflictOnce=false;f[scope]={...f[scope],version:f[scope].version+1,usedTokens:f[scope].usedTokens+100};throw Object.assign(Error('private host message'),{code:'teloa/version-conflict',rejected:true})};if(f.hold)await new Promise(resolve=>f.release=()=>{f.hold=false;resolve()});if(!receipts.has(payload.requestId)){if(payload.expectedVersion!==f[scope].version)throw Error('incorrect CAS');f.mutations++;f[scope]={...f[scope],version:f[scope].version+1,policy:structuredClone(payload.policy)};receipts.set(payload.requestId,{version:f[scope].version,policy:payload.policy,...(scope==='account'?{budgetAccountId:id}:{})})};if(f.loseOnce){f.loseOnce=false;throw Error('response lost')};return structuredClone(receipts.get(payload.requestId))};throw Error('unexpected endpoint')};
const journal={read:()=>localStorage.getItem('budget-journal'),write:value=>localStorage.setItem('budget-journal',value),clear:()=>localStorage.removeItem('budget-journal')},snapshot={locale:'en',dshLocale:'en',revision:1},runtime={t:(key,params)=>translateMessage('en',key,params),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
function App(){const[epoch,setEpoch]=useState(0),api=useMemo(()=>createWorkBudgetApi(call,journal),[epoch]);f.remount=()=>setEpoch(value=>value+1);return <I18nProvider runtime={runtime}><main className={css.page} style={{padding:20}}><WorkBudgetPanel api={api} budgetAccountId={id}/></main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'budget-fixture',resolveId:id=>id.endsWith('budget-fixture')?virtual:null,load:id=>id===virtual?fixture:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'budget-fixture',name:'BudgetFixture',formats:['iife']}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n'),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const mount=async(mode='finite')=>{const page=await browser.newPage({viewport:{width:1080,height:1000}}),errors:string[]=[];page.setDefaultTimeout(4500);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/budget'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en" data-mode="'+mode+'"><body><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1/budget');await page.addStyleTag({content:':root{--teloa-font-caption:14px;--teloa-font-control:16px;--teloa-font-body:16px;--teloa-weight-medium:500;--teloa-border:#ccc;--teloa-text:#222;--teloa-muted:#555;--teloa-surface:#fff;--teloa-focus:#336699}body{font:16px system-ui;margin:0}'+styles});await page.addScriptTag({content:script});try{await page.getByLabel('Change limits for',{exact:true}).waitFor({state:'attached'})}catch(cause){throw Error(JSON.stringify({errors,body:await page.locator('body').innerText()}),{cause})};const details=page.locator('details');if(!await details.evaluate((node:HTMLDetailsElement)=>node.open))await page.getByText('Work limits',{exact:true}).first().click();return {page,errors}}
 const confirm=async(page:any)=>{await page.getByLabel('I confirm these limits, retaining usage and existing role permissions.',{exact:true}).check();await page.getByRole('button',{name:'Confirm and save limits',exact:true}).click()}
 await t.test('不限不误报额度耗尽，数字草稿可切回，空重试与空有限值均显式无效，宽窄窗口可操作',async()=>{
  const {page,errors}=await mount('unlimited');try{
   assert.equal(await page.getByRole('alert').count(),0);assert.match(await page.locator('dl').innerText(),/2,500,000\/Unlimited/);assert.equal(await page.getByRole('spinbutton').count(),2)
   const mode=page.getByRole('combobox',{name:'Limit mode for Total token limit',exact:true});await mode.selectOption('finite');const tokens=page.getByRole('spinbutton',{name:'Total token limit',exact:true});assert.equal(await tokens.inputValue(),'1');await tokens.fill('6500000');await mode.selectOption('unlimited');await mode.selectOption('finite');assert.equal(await tokens.inputValue(),'6500000')
   await tokens.fill('');await page.getByLabel('I confirm these limits, retaining usage and existing role permissions.',{exact:true}).check();assert.equal(await page.getByRole('button',{name:'Confirm and save limits',exact:true}).isDisabled(),true);assert.equal(await tokens.getAttribute('aria-invalid'),'true');await mode.selectOption('unlimited');await mode.selectOption('finite');assert.equal(await tokens.inputValue(),'');await tokens.fill('6500000')
   const retries=page.getByRole('spinbutton',{name:'Retry limit per operation',exact:true});await retries.fill('');assert.equal(await retries.getAttribute('aria-invalid'),'true');assert.equal(await page.getByRole('button',{name:'Confirm and save limits',exact:true}).isDisabled(),true);await retries.fill('0');assert.equal(await retries.getAttribute('aria-invalid'),null)
   for(const width of [390,720,1080,2560,3840]){await page.setViewportSize({width,height:1000});assert.ok(await page.locator('form').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1),'width '+width);for(const box of await page.getByRole('combobox').all()){const bounds=await box.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1)}}
   assert.equal(await page.evaluate(()=>(window as any).budgetFixture.commands.length),0);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('新额度只在真实回执后回显；四项null原样提交，用量不清零，没有停止或执行请求',async()=>{
  const {page,errors}=await mount();try{
   for(const resource of ['Total token limit','Total round limit','Concurrent work limit','Model time limit per 24 hours (minutes)'])await page.getByRole('combobox',{name:'Limit mode for '+resource,exact:true}).selectOption('unlimited')
   await page.getByText(/without pausing/).waitFor();await page.evaluate(()=>(window as any).budgetFixture.hold=true);await confirm(page);await page.waitForFunction(()=>typeof (window as any).budgetFixture.release==='function');assert.equal(await page.getByRole('status').count(),0);assert.match(await page.locator('dl').innerText(),/2,500,000\/2,000,000/)
   await page.evaluate(()=>(window as any).budgetFixture.release());await page.getByRole('status').filter({hasText:'The limits request for Current work account is confirmed'}).waitFor();assert.match(await page.locator('dl').innerText(),/2,500,000\/Unlimited/);assert.match(await page.locator('dl').innerText(),/12\/Unlimited/)
   const commands=await page.evaluate(()=>(window as any).budgetFixture.commands);assert.equal(commands.length,1);for(const key of ['maxTokens','maxGoalRounds','maxConcurrent','maxElapsedMs'])assert.equal(commands[0].policy[key],null);assert.equal(commands[0].policy.maxRetries,3)
   assert.equal(await page.getByRole('alert').count(),0);assert.ok((await page.evaluate(()=>(window as any).budgetFixture.calls)).every((row:any)=>row.endpoint.startsWith('work-budgets/')));assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('冲突和最新读取保留输入与累计用量，owner/work分别CAS，降额显示保护说明',async()=>{
  const {page,errors}=await mount();try{
   const token=()=>page.getByRole('spinbutton',{name:'Total token limit',exact:true});await token().fill('6000000');await page.evaluate(()=>(window as any).budgetFixture.conflictOnce=true);await confirm(page);await page.getByRole('alert').filter({hasText:'Limits changed in another page'}).waitFor();assert.equal(await token().inputValue(),'6000000');assert.equal(await page.getByRole('status').count(),0)
   await page.getByRole('button',{name:'Refresh',exact:true}).click();await page.getByRole('status').filter({hasText:'Your unsaved input is preserved'}).waitFor();assert.equal(await token().inputValue(),'6000000');assert.match(await page.locator('dl').innerText(),/2,500,100/)
   await page.getByLabel('Change limits for',{exact:true}).selectOption('owner');await token().fill('5000000');await page.getByText(/Lowering limits rechecks current usage/).waitFor();await confirm(page);await page.getByRole('status').filter({hasText:'The limits request for All my work is confirmed'}).waitFor();await page.getByLabel('Change limits for',{exact:true}).selectOption('account');assert.equal(await token().inputValue(),'6000000');await confirm(page);await page.getByRole('status').filter({hasText:'The limits request for Current work account is confirmed'}).waitFor()
   const calls=await page.evaluate(()=>(window as any).budgetFixture.calls),commands=await page.evaluate(()=>(window as any).budgetFixture.commands);assert.equal(commands.length,3);assert.equal(commands[2].expectedVersion,4);const ownerCall=calls.find((row:any)=>row.endpoint==='work-budgets/owner/configure');assert.ok(ownerCall);assert.equal(Object.hasOwn(ownerCall.payload,'budgetAccountId'),false);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('本人范围只编辑四项资源且原样保留停止字段；切回职责仍可编辑并单独保存',async()=>{
  const {page,errors}=await mount();try{
   const retries=()=>page.getByRole('spinbutton',{name:'Retry limit per operation',exact:true}),stagnation=()=>page.getByRole('spinbutton',{name:'Consecutive rounds without new progress',exact:true}),scope=page.getByLabel('Change limits for',{exact:true})
   await retries().fill('0');await stagnation().fill('4')
   await scope.selectOption('owner')
   assert.equal(await retries().count(),0);assert.equal(await stagnation().count(),0)
   await page.getByText('Retry and stagnation protection are configured per work account. Switch to “Current work account” to adjust them. Owner limits do not change these settings.',{exact:true}).waitFor()
   assert.equal(await page.getByRole('combobox',{name:/Limit mode for /}).count(),4)
   await page.getByRole('spinbutton',{name:'Total token limit',exact:true}).fill('9000000');await confirm(page)
   await page.getByRole('status').filter({hasText:'The limits request for All my work is confirmed'}).waitFor()
   let commands=await page.evaluate(()=>(window as any).budgetFixture.commands)
   assert.equal(commands.length,1);assert.equal(commands[0].policy.maxRetries,5);assert.equal(commands[0].policy.stagnationRounds,7);assert.equal(commands[0].policy.maxTokens,9000000)
   await scope.selectOption('account')
   assert.equal(await retries().inputValue(),'0');assert.equal(await stagnation().inputValue(),'4')
   assert.equal(await page.getByText(/Retry and stagnation protection are configured per work account/).count(),0)
   await confirm(page);await page.getByRole('status').filter({hasText:'The limits request for Current work account is confirmed'}).waitFor()
   commands=await page.evaluate(()=>(window as any).budgetFixture.commands)
   assert.equal(commands.length,2);assert.equal(commands[1].policy.maxRetries,0);assert.equal(commands[1].policy.stagnationRounds,4)
   const owner=await page.evaluate(()=>(window as any).budgetFixture.owner.policy)
   assert.equal(owner.maxRetries,5);assert.equal(owner.stagnationRounds,7);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('丢回包保留journal，重建API后用同requestId核对，不把未知结果显示为成功',async()=>{
  const {page,errors}=await mount();try{
   await page.getByLabel('Change limits for',{exact:true}).selectOption('owner');await page.getByRole('combobox',{name:'Limit mode for Total token limit',exact:true}).selectOption('unlimited');await page.evaluate(()=>(window as any).budgetFixture.loseOnce=true);await confirm(page);await page.getByText('Check the uncertain limits change using the original request.',{exact:true}).waitFor();assert.equal(await page.getByRole('status').count(),0);const original=await page.evaluate(()=>(window as any).budgetFixture.commands[0]);assert.ok(await page.evaluate(()=>localStorage.getItem('budget-journal')))
   await page.evaluate(()=>(window as any).budgetFixture.remount());await page.getByRole('button',{name:'Check original control request',exact:true}).click();await page.getByRole('status').filter({hasText:'The limits request for All my work is confirmed'}).waitFor();const commands=await page.evaluate(()=>(window as any).budgetFixture.commands);assert.deepEqual(commands[1],original);assert.equal(await page.evaluate(()=>(window as any).budgetFixture.mutations),1);assert.equal(await page.evaluate(()=>localStorage.getItem('budget-journal')),null);assert.match(await page.locator('dl').innerText(),/2,700,000\/Unlimited/);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
})
