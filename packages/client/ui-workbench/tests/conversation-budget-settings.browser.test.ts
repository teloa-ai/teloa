import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 仓库真实浏览器夹具。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('新任务额度页面保存不限、保留冲突草稿并恢复原请求，六种窗口不溢出',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-new-task-budget-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {ConversationBudgetSettings} from '${client}ConversationBudgetSettings.tsx';import {createConversationBudgetApi} from '${client}conversation-budget-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const policy={maxTokens:2000000,maxGoalRounds:32,maxConcurrent:4,maxElapsedMs:21600000,maxRetries:3,stagnationRounds:3,money:null};let current={sessionId:'browser-budget',version:0,configured:false,policy},lost=false,denied=false;const receipts=new Map(),calls=[];window.budgetPage={calls,get current(){return current},conflict(){current={...current,version:current.version+1}},lose(){lost=true}};
 let nextId=1;const api=createConversationBudgetApi(async(endpoint,payload)=>{calls.push({endpoint,payload:structuredClone(payload)});if(endpoint.endsWith('/read')){if(denied)throw Object.assign(Error('task-bound'),{code:'teloa/forbidden',rejected:true});return structuredClone(current);}if(receipts.has(payload.requestId))return receipts.get(payload.requestId);if(payload.expectedVersion!==current.version)throw Object.assign(Error('changed'),{code:'teloa/version-conflict',rejected:true});current={...current,configured:true,version:current.version+1,policy:payload.policy};receipts.set(payload.requestId,structuredClone(current));if(lost){lost=false;throw Error('lost reply')}return structuredClone(current)},()=> '33333333-3333-4333-8333-'+String(nextId++).padStart(12,'0'));
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};const root=createRoot(document.getElementById('root'));const render=sessionId=>root.render(<I18nProvider runtime={runtime}><ConversationBudgetSettings key={sessionId} sessionId={sessionId} api={api}/><main>原任务会话保持可见</main></I18nProvider>);window.budgetPage.deny=()=>{denied=true;render('task-run-protected')};render('browser-budget');`)
 await writeFile(join(temp,'crypto.ts'),'export function createHash(){throw Error("不应调用服务摘要")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("不应验证服务签名")};export function verify(){throw Error("不应验证服务签名")}')
 const built=await build({configFile:false,root,resolve:{alias:{'node:crypto':join(temp,'crypto.ts'),'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'NewTaskBudgetTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:720}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html><body><div id="root"></div></body></html>')
 await page.addStyleTag({content:':root{--teloa-border:#555;--teloa-text:#eee;--teloa-muted:#bbb;--teloa-surface:#252525;--teloa-hover:#333;--teloa-focus:#8cf;--teloa-font-control:14px;--teloa-font-caption:13px;--teloa-weight-medium:500}*{box-sizing:border-box}body{margin:0;background:#181818;color:#eee;font:14px system-ui}#root{display:flex;flex-direction:column;min-height:100vh}main{padding:16px}'+bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')})
 await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 await page.locator('summary').click();await page.getByText('当前使用默认额度',{exact:true}).waitFor()
 const tokens=page.getByRole('spinbutton',{name:'累计 token 上限',exact:true}),mode=page.getByRole('combobox',{name:'累计 token 上限限制方式',exact:true}),save=page.getByRole('button',{name:'保存新任务额度',exact:true}),confirm=page.getByRole('checkbox')
 await tokens.fill('');assert.equal(await tokens.getAttribute('aria-invalid'),'true');assert.equal(await save.isEnabled(),false)
 await tokens.fill('3000000');await mode.selectOption('unlimited');await confirm.check();await save.click()
 await page.getByText('新任务额度已保存；批准交办后才会生效。',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).budgetPage.current.policy.maxTokens),null)
 assert.equal(await page.evaluate(()=>(window as any).budgetPage.calls.some((item:any)=>!item.endpoint.startsWith('conversation-budgets/'))),false,'保存页设不调用交办、Task、Run或账户接口')
 await mode.selectOption('finite');assert.equal(await tokens.inputValue(),'3000000')
 await tokens.fill('5000000');await page.evaluate(()=>(window as any).budgetPage.conflict());await confirm.check();await save.click()
 await page.getByText(/设置已在其他页面修改/).waitFor();assert.equal(await tokens.inputValue(),'5000000')
 await page.getByRole('button',{name:'读取最新设置',exact:true}).click();assert.equal(await tokens.inputValue(),'5000000')
 await confirm.check();await save.click();await page.getByText('新任务额度已保存；批准交办后才会生效。',{exact:true}).waitFor()
 await tokens.fill('6000000');await page.evaluate(()=>(window as any).budgetPage.lose());await confirm.check();await save.click()
 await page.getByText(/上次保存结果尚未确认/).waitFor();await page.getByRole('button',{name:'核对上次保存',exact:true}).click();await page.getByText('新任务额度已保存；批准交办后才会生效。',{exact:true}).waitFor()
 const commands=await page.evaluate(()=>(window as any).budgetPage.calls.filter((item:any)=>item.endpoint.endsWith('/configure')).map((item:any)=>item.payload))
 assert.deepEqual(commands.at(-1),commands.at(-2),'未知回执恢复沿原requestId与policy，不发新请求')
 for(const [width,height] of [[360,740],[886,954],[1280,720],[1920,1080],[2560,1440],[3840,2160]]){
  await page.setViewportSize({width,height});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,JSON.stringify({width,height}))
  assert.equal(await page.getByText('原任务会话保持可见',{exact:true}).isVisible(),true)
 }
 await page.evaluate(()=>(window as any).budgetPage.deny())
 await page.locator('summary').waitFor({state:'hidden'})
 assert.equal(await page.getByText('原任务会话保持可见',{exact:true}).isVisible(),true,'任务会话由宿主拒绝页设后隐藏入口，不影响原工作')
 assert.deepEqual(errors,[])
})
