import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用工作树的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('工作额度真实表单快速切换范围后仅改token，提交保留目标范围其余字段及本人确认',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__work_budget_scope.tsx'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {WorkBudgetPanel} from '${client}WorkBudgetPanel.tsx';import {createWorkBudgetApi} from '${client}work-budget-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const id='11111111-1111-4111-8111-111111111111',usage={usedTokens:100,usedRounds:0,concurrent:0,usedElapsedMs:5000,moneyMinorUnits:null};
 const initial={account:{...usage,budgetAccountId:id,version:4,policy:{maxGoalRounds:8,maxTokens:1007586,maxElapsedMs:600000,maxConcurrent:2,maxRetries:1,stagnationRounds:3,money:null}},owner:{...usage,version:1,policy:{maxGoalRounds:32,maxTokens:8000000,maxElapsedMs:21600000,maxConcurrent:8,maxRetries:3,stagnationRounds:5,money:null}}};
 const secondId='22222222-2222-4222-8222-222222222222',otherPolicy={maxGoalRounds:17,maxTokens:3000000,maxElapsedMs:1800000,maxConcurrent:3,maxRetries:2,stagnationRounds:7,money:null};
 const stores=[{...structuredClone(initial),other:{...usage,budgetAccountId:secondId,version:8,policy:otherPolicy}},{account:{...usage,budgetAccountId:id,version:14,policy:{...otherPolicy,maxGoalRounds:27,maxTokens:4000000,maxElapsedMs:2400000,maxConcurrent:4,maxRetries:4}},other:{...usage,budgetAccountId:secondId,version:18,policy:{...otherPolicy,maxGoalRounds:37,maxTokens:5000000,maxElapsedMs:3000000,maxConcurrent:5,maxRetries:5}},owner:{...usage,version:11,policy:{...otherPolicy,maxGoalRounds:47,maxTokens:10000000,maxElapsedMs:3600000,maxConcurrent:6,maxRetries:6}}}];
 const f=window.budgetScopeFixture={initial:structuredClone(initial),stores,rows:stores[0],calls:[],loseReply:false,holdReply:false,held:null},receipts=new Map();
 const transport=identity=>async(method,payload)=>{const key=method.includes('/owner/')?'owner':payload.budgetAccountId===secondId?'other':'account',rows=stores[identity];if(method.endsWith('/read'))return structuredClone(rows[key]);f.calls.push({identity,method,payload:structuredClone(payload)});if(receipts.has(payload.requestId))return structuredClone(receipts.get(payload.requestId));if(payload.expectedVersion!==rows[key].version)throw Object.assign(Error('Version changed'),{rejected:true});rows[key]={...rows[key],version:rows[key].version+1,policy:structuredClone(payload.policy)};const result={...(key==='owner'?{}:{budgetAccountId:payload.budgetAccountId}),version:rows[key].version,policy:structuredClone(payload.policy)};receipts.set(payload.requestId,result);if(f.loseReply){f.loseReply=false;throw Error('Reply lost after commit')}if(f.holdReply){f.holdReply=false;await new Promise(resolve=>{f.held=resolve})}return structuredClone(result);};
 const apis=[createWorkBudgetApi(transport(0)),createWorkBudgetApi(transport(1))];function App(){const [account,setAccount]=React.useState(0),[work,setWork]=React.useState(0);return <><button onClick={()=>setAccount(value=>1-value)}>切换测试账户</button><button onClick={()=>setWork(value=>1-value)}>切换测试职责</button><WorkBudgetPanel api={apis[account]} budgetAccountId={work?secondId:id}/></>}

 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'work-budget-scope',resolveId:id=>id.endsWith('work-budget-scope-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'work-budget-scope-fixture',name:'BudgetScopeFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);const chunk=bundle.output.find(item=>item.type==='chunk');assert.ok(chunk&&chunk.type==='chunk')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage(),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 const url='http://127.0.0.1:49328/work-budget-scope';await page.route('**/*',(route:any)=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort());await page.goto(url);await page.addScriptTag({content:chunk.code})
 await page.locator('summary').click();const scope=page.getByRole('combobox',{name:'修改额度范围'}),token=page.getByRole('spinbutton',{name:'累计 token 上限'}),confirm=page.getByRole('checkbox'),save=page.getByRole('button',{name:'确认保存工作额度'})
 await scope.waitFor();assert.equal(await token.inputValue(),'1007586')
 const initial=await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').initial)
 await scope.selectOption('owner');await token.fill('45192')
 assert.equal(await save.isDisabled(),true);assert.deepEqual(await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls),[])
 await confirm.check();await save.click();await page.waitForFunction(()=>Reflect.get(window,'budgetScopeFixture').rows.owner.version===2)
 let calls=await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)
 assert.equal(calls.length,1);assert.equal(calls[0].method,'work-budgets/owner/configure');assert.deepEqual(calls[0].payload.policy,{...initial.owner.policy,maxTokens:45192},'只编辑本人token时，不得把职责的轮次、并发、耗时、重试或停滞额度写入本人范围')
 await scope.selectOption('account');await token.fill('2000000');assert.equal(await save.isDisabled(),true);assert.equal(await confirm.isChecked(),false)
 await confirm.check();await save.click();await page.waitForFunction(()=>Reflect.get(window,'budgetScopeFixture').rows.account.version===5)
 calls=await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)
 assert.equal(calls.length,2);assert.equal(calls[1].method,'work-budgets/configure');assert.deepEqual(calls[1].payload.policy,{...initial.account.policy,maxTokens:2000000},'反向切回也必须保留职责范围其余字段')
 // 旧范围的明确勾选不能带到新范围；刷新后的新版本同样需要重新核对。
 await confirm.check();assert.equal(await save.isEnabled(),true);await scope.selectOption('owner')
 assert.equal(await confirm.isChecked(),false);assert.equal(await save.isDisabled(),true)
 await token.fill('50000');await confirm.check()
 const revised={...initial.owner.policy,maxGoalRounds:64,maxTokens:9000000,maxConcurrent:16,maxRetries:4}
 await page.evaluate((policy:unknown)=>{const f=Reflect.get(window,'budgetScopeFixture');f.rows.owner={...f.rows.owner,version:3,policy}},revised)
 await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[id$="-maxGoalRounds"]')?.value==='64')
 assert.equal(await confirm.isChecked(),false);assert.equal(await save.isDisabled(),true);assert.equal(await token.inputValue(),'9000000')
 await token.fill('9500000');assert.equal(await save.isDisabled(),true);assert.equal((await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)).length,2)
 // 丢回执后切换显示范围，恢复仍提交原 requestId、原范围和完整策略。
 await page.evaluate(()=>{Reflect.get(window,'budgetScopeFixture').loseReply=true});await confirm.check();await save.click()
 const recover=page.getByRole('button',{name:'核对原控制请求',exact:true});await recover.waitFor()
 const original=(await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)).at(-1)
 assert.equal(original.payload.expectedVersion,3);assert.deepEqual(original.payload.policy,{...revised,maxTokens:9500000})
 await scope.selectOption('account');assert.equal(await save.isDisabled(),true);assert.equal(await confirm.isDisabled(),true)
 await recover.click();await recover.waitFor({state:'detached'})
 calls=await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)
 assert.equal(calls.length,4);assert.deepEqual(calls[3],original,'恢复必须精确沿用原本人额度请求，不能改成当前显示的职责额度')
 assert.equal(await confirm.isChecked(),false);assert.equal(await save.isDisabled(),true)
 // 每个 API 身份与职责有不同版本和策略；切换后立即编辑，不能把旧服务端读数包装成新草稿。
 for(const [name,identity,key,maxTokens] of [['切换测试账户',1,'account',4100000],['切换测试职责',1,'other',5100000]] as const){
  const target=await page.evaluate(({identity,key}:{identity:number;key:string})=>structuredClone(Reflect.get(window,'budgetScopeFixture').stores[identity][key]),{identity,key})
  await confirm.check();assert.equal(await save.isEnabled(),true);await page.getByRole('button',{name,exact:true}).click()
  await token.fill(String(maxTokens));assert.equal(await confirm.isChecked(),false);assert.equal(await save.isDisabled(),true)
  await confirm.check();await save.click();await page.waitForFunction((length:number)=>Reflect.get(window,'budgetScopeFixture').calls.length===length,identity===1&&key==='account'?5:6)
  const sent=(await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)).at(-1)
  assert.equal(sent.identity,identity);assert.equal(sent.payload.budgetAccountId,target.budgetAccountId);assert.equal(sent.payload.expectedVersion,target.version)
  assert.deepEqual(sent.payload.policy,{...target.policy,maxTokens},name+'之后快速编辑必须只改目标token，其他字段来自目标身份的服务端策略')
 }
 for(const [name,identity,key,maxTokens] of [['切换测试账户',1,'account',4100000],['切换测试职责',0,'other',3100000]] as const)await t.test(name+'后旧提交迟答不能覆盖新读取并成为新草稿',async()=>{
  await page.goto(url);await page.addScriptTag({content:chunk.code});await page.locator('summary').click();await scope.waitFor()
  const target=await page.evaluate(({identity,key}:{identity:number;key:string})=>structuredClone(Reflect.get(window,'budgetScopeFixture').stores[identity][key]),{identity,key})
  await token.fill('2000000');await confirm.check();await page.evaluate(()=>{Reflect.get(window,'budgetScopeFixture').holdReply=true});await save.click()
  await page.waitForFunction(()=>typeof Reflect.get(window,'budgetScopeFixture').held==='function')
  await page.getByRole('button',{name,exact:true}).click()
  await page.waitForFunction((rounds:number)=>document.querySelector<HTMLInputElement>('input[id$="-maxGoalRounds"]')?.value===String(rounds),target.policy.maxGoalRounds)
  await page.evaluate(()=>{Reflect.get(window,'budgetScopeFixture').held()})
  await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('select')?.disabled===false)
  await page.getByRole('button',{name:'核对原控制请求',exact:true}).waitFor({state:'detached'})
  await page.waitForFunction(()=>document.querySelector<HTMLInputElement>('input[type=checkbox]')?.disabled===false)
  await token.fill(String(maxTokens));await confirm.check();await save.click();await page.waitForFunction(()=>Reflect.get(window,'budgetScopeFixture').calls.length===2)
  const sent=(await page.evaluate(()=>Reflect.get(window,'budgetScopeFixture').calls)).at(-1)
  assert.equal(sent.identity,identity);assert.equal(sent.payload.budgetAccountId,target.budgetAccountId,'旧回执不能把新职责表单的提交目标改回旧职责')
  assert.equal(sent.payload.expectedVersion,target.version,'新身份必须使用其实际版本，不能继承旧身份回执版本')
  assert.deepEqual(sent.payload.policy,{...target.policy,maxTokens},'新身份其余未编辑字段必须保留')
 })
})
