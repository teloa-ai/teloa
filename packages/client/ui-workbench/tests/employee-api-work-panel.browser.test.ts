import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用项目已有 Chromium 加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('原 API 工作面板使用真实客户端 API 验证续办、恢复、切换与窄屏',{timeout:90000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-api-work-panel-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';
import {EmployeeApiWorkPanel} from ${JSON.stringify(join(client,'EmployeeApiWorkPanel.tsx'))};import {createEmployeeApiWorkApi} from ${JSON.stringify(join(client,'employee-api-work-api.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import {ThemePresenter} from ${JSON.stringify(join(client,'theme-presenter.ts'))};import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import taskCss from ${JSON.stringify(join(client,'TaskPage.module.css'))};
new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14,code:12,terminal:12}});
const taskA='11111111-1111-4111-8111-111111111111',taskB='22222222-2222-4222-8222-222222222222',workA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',workB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',nextTask='77777777-7777-4777-8777-777777777777';
let snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};const listeners=new Set(),i18n={t:(key,params)=>translateMessage(snapshot.locale,key,params),subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},getSnapshot:()=>snapshot},f=window.fixture={calls:[],opened:[],navigated:[],accepted:0,mode:'normal',readFail:false,holdRead:false,readHeld:false,continueHeld:false};
const source=[0,1].map(owner=>Object.fromEntries([taskA,taskB].map(taskId=>[taskId,{taskId,currentTaskId:taskId,sessionId:taskId===taskA?'original-session-a':'original-session-b',canContinue:true,work:{id:taskId===taskA?workA:workB,title:(owner?'第二账户':'')+(taskId===taskA?'原API工作甲':'原API工作乙'),version:3,round:1,state:'failed',error:'execution_tools_required'}}]))),journals=[null,null],accepted=new Map();let readRelease,readReject,continueRelease;
const makeApi=owner=>createEmployeeApiWorkApi(async(method,payload)=>{
 f.calls.push({owner,method,payload:structuredClone(payload)});
 if(method==='employee-integrations/work-for-task'){
  const value=structuredClone(source[owner][payload.taskId]);if(f.readFail)throw Error('RAW_READ_ERROR_MUST_NOT_RENDER');
  if(f.holdRead){f.holdRead=false;f.readHeld=true;return await new Promise((resolve,reject)=>{readRelease=()=>{f.readHeld=false;resolve(value)};readReject=()=>{f.readHeld=false;reject(Error('stale read failure'))}})}
  return value;
 }
 if(method!=='employee-integrations/continue-work')throw Error('unexpected endpoint');
 if(f.mode==='blocked-model')throw {code:'teloa/dependency-unavailable',details:{reason:'employee-api-model-unavailable'},message:'MODEL_SECRET_MUST_NOT_RENDER'};
 const key=owner+'/'+payload.requestId;let result=accepted.get(key),previous=source[owner][payload.taskId];
 if(!result){if(payload.workId!==previous.work.id||payload.expectedVersion!==previous.work.version)throw Object.assign(Error('version conflict'),{code:'teloa/version-conflict',rejected:true});f.accepted++;result={...previous,currentTaskId:nextTask,sessionId:null,canContinue:false,work:{...previous.work,round:previous.work.round+1,version:previous.work.version+1,state:'queued',error:null}};source[owner][payload.taskId]=result;accepted.set(key,result)}
 const mode=f.mode;if(mode==='hold'){f.continueHeld=true;await new Promise(resolve=>continueRelease=()=>{f.continueHeld=false;resolve()})}
 if(mode==='unknown')throw Error('response lost');if(mode==='malformed')return {...result,work:{...result.work,round:result.work.round-1}};
 return structuredClone(result);
},{read:()=>journals[owner],write:value=>journals[owner]=value,clear:()=>journals[owner]=null});
f.releaseRead=()=>readRelease?.();f.rejectRead=()=>readReject?.();f.releaseContinue=()=>continueRelease?.();f.source=(task,patch)=>{const id=task==='a'?taskA:taskB,previous=source[0][id];source[0][id]={...previous,...patch,work:{...previous.work,...patch.work}}};f.locale=value=>{snapshot={locale:value,dshLocale:value==='en'?'en':'zh',revision:snapshot.revision+1};listeners.forEach(fn=>fn())};f.damageJournal=()=>journals[0]='{broken';f.journal=()=>journals[0];
function App(){const [task,setTask]=useState(taskA),[owner,setOwner]=useState(0),[revision,setRevision]=useState(0),[visible,setVisible]=useState(true),api=useMemo(()=>makeApi(owner),[owner,revision]);f.select=value=>setTask(value==='a'?taskA:taskB);f.owner=setOwner;f.recreate=()=>setRevision(value=>value+1);f.visible=setVisible;return <I18nProvider runtime={i18n}><main className={tokens.tokens+' '+taskCss.page} style={{maxWidth:760,margin:'0 auto',minHeight:'100vh'}}><article className={taskCss.detail}>{visible&&<EmployeeApiWorkPanel taskId={task} api={api} open={async sessionId=>{f.opened.push(sessionId)}} openTask={taskId=>f.navigated.push(taskId)}/>}</article></main></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);
`)
 const built=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'EmployeeApiWorkPanelFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,css=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n'),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const mount=async()=>{const page=await browser.newPage({viewport:{width:1000,height:900}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/api-work-panel'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="margin:0"><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1/api-work-panel');await page.addStyleTag({content:css});await page.addScriptTag({content:script});await page.getByRole('textbox',{name:'继续原工作',exact:true}).waitFor();return {page,errors}}
 const turn=async(page:any)=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 await t.test('queued 给出等待原因，只有真实会话才提供原会话入口',async()=>{
  const {page,errors}=await mount();try{
   await page.getByRole('button',{name:'打开本轮原会话',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.opened),['original-session-a'])
   await page.evaluate(()=>(window as any).fixture.source('a',{canContinue:false,sessionId:null,work:{state:'queued',error:'dispatch_unavailable'}}));await page.getByRole('button',{name:'刷新原工作',exact:true}).click()
   await page.getByText(/宿主暂时无法派发，正在按原请求重试/).waitFor();assert.equal(await page.getByRole('button',{name:'打开本轮原会话',exact:true}).count(),0);assert.equal(await page.getByRole('textbox',{name:'继续原工作',exact:true}).count(),0)
   await page.evaluate(()=>(window as any).fixture.source('a',{sessionId:'paused-original-session',work:{state:'waiting',error:'execution_paused'}}));await page.getByRole('button',{name:'刷新原工作',exact:true}).click();await page.getByText(/本轮执行已暂停.*宿主重启后正在保护原运行/).waitFor()
   assert.match(await page.locator('section').innerText(),/不要重复创建工作或提交新轮次/);await page.getByRole('button',{name:'打开本轮原会话',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.opened),['original-session-a','paused-original-session'])
   assert.equal((await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.method.endsWith('continue-work')))).length,0);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('模型依赖失败保留同一续办，提示修正模型后核对原请求',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.mode='blocked-model');await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('模型恢复后继续核对')
   await page.getByRole('button',{name:'提交后续轮次',exact:true}).click();await page.getByRole('alert').filter({hasText:/原工作使用的模型或模型认证暂不可用/}).waitFor();assert.doesNotMatch(await page.locator('section').innerText(),/MODEL_SECRET_MUST_NOT_RENDER/)
   assert.equal(await page.evaluate(()=>(window as any).fixture.accepted),0);await page.evaluate(()=>(window as any).fixture.mode='normal');await page.getByRole('button',{name:'核对上次续办',exact:true}).click()
   await page.getByRole('status').filter({hasText:/原API工作甲.*第2轮/}).waitFor();assert.equal(await page.evaluate(()=>(window as any).fixture.accepted),1)
   const calls=await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.method.endsWith('continue-work')));assert.deepEqual(calls[0].payload,calls[1].payload);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('终态续办保留同一个 work ID，语言切换保留输入，双击只受理一次',async()=>{
  const {page,errors}=await mount();try{
   await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('继续核对甲的来源')
   await page.evaluate(()=>(window as any).fixture.locale('en'));assert.equal(await page.getByRole('textbox',{name:'Continue original work',exact:true}).inputValue(),'继续核对甲的来源')
   await page.evaluate(()=>{(window as any).fixture.locale('zh-CN');(window as any).fixture.mode='hold'});await page.locator('form').evaluate((form:HTMLFormElement)=>{form.requestSubmit();form.requestSubmit()})
   await page.waitForFunction(()=>(window as any).fixture.continueHeld);assert.equal(await page.getByRole('button',{name:'核对上次续办',exact:true}).isDisabled(),true)
   assert.equal(await page.evaluate(()=>(window as any).fixture.accepted),1);await page.evaluate(()=>(window as any).fixture.releaseContinue())
   await page.getByRole('status').filter({hasText:/原API工作甲.*第2轮.*排队中/}).waitFor()
   const calls=await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.method.endsWith('continue-work')))
   assert.equal(calls.length,1);assert.equal(calls[0].payload.workId,'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');assert.equal(calls[0].payload.input,'继续核对甲的来源');assert.equal('expectedRound'in calls[0].payload,false)
   await page.getByRole('button',{name:'打开最新轮次任务',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.navigated),['77777777-7777-4777-8777-777777777777']);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 for(const mode of ['unknown','malformed'])await t.test(mode+' 回包保留原输入并跨 API 重建恢复同一请求',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate((value:string)=>(window as any).fixture.mode=value,mode);await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('本次续办的原输入')
   await page.getByRole('button',{name:'提交后续轮次',exact:true}).click();await page.getByRole('button',{name:'核对上次续办',exact:true}).waitFor();await page.waitForFunction(()=>!document.querySelector('section button:last-of-type')?.hasAttribute('disabled'))
   await page.getByRole('status').filter({hasText:/上次续办的结果待核对/}).waitFor();assert.equal(await page.getByRole('textbox',{name:'上次续办输入',exact:true}).inputValue(),'本次续办的原输入')
   assert.ok(await page.evaluate(()=>(window as any).fixture.journal()));await page.evaluate(()=>{(window as any).fixture.mode='normal';(window as any).fixture.recreate()})
   await page.getByRole('button',{name:'核对上次续办',exact:true}).click();await page.getByRole('status').filter({hasText:/原API工作甲.*第2轮.*排队中/}).waitFor();await page.getByRole('button',{name:'核对上次续办',exact:true}).waitFor({state:'hidden'})
   const calls=await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.method.endsWith('continue-work')));assert.equal(calls.length,2);assert.deepEqual(calls[0].payload,calls[1].payload);assert.equal(await page.evaluate(()=>(window as any).fixture.accepted),1);assert.equal(await page.evaluate(()=>(window as any).fixture.journal()),null);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 for(const outcome of ['success','failure'])await t.test('切换任务后迟到的刷新'+outcome+' 不覆盖新任务或新输入',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.holdRead=true);await page.getByRole('button',{name:'刷新原工作',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.readHeld)
   await page.evaluate(()=>(window as any).fixture.select('b'));await page.getByRole('status').filter({hasText:/原API工作乙/}).waitFor();await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('乙的待提交输入')
   await page.evaluate((value:string)=>value==='success'?(window as any).fixture.releaseRead():(window as any).fixture.rejectRead(),outcome);await turn(page)
   assert.equal(await page.getByRole('textbox',{name:'继续原工作',exact:true}).inputValue(),'乙的待提交输入');assert.doesNotMatch(await page.locator('section').innerText(),/原API工作甲/);assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('切换 API 身份后旧续办回包不污染新身份的任务与输入',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.mode='hold');await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('旧身份输入');await page.getByRole('button',{name:'提交后续轮次',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.continueHeld)
   await page.evaluate(()=>(window as any).fixture.owner(1));await page.getByRole('status').filter({hasText:/第二账户原API工作甲/}).waitFor();await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('新身份待提交输入')
   await page.evaluate(()=>(window as any).fixture.releaseContinue());await turn(page)
   assert.equal(await page.getByRole('textbox',{name:'继续原工作',exact:true}).inputValue(),'新身份待提交输入');assert.match(await page.locator('section').innerText(),/第二账户原API工作甲.*第1轮/);assert.equal((await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.owner===1&&row.method.endsWith('continue-work')))).length,0);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('切换任务时明确显示另一任务的 pending，旧续办完成后恢复当前任务输入',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.mode='hold');await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('甲的续办');await page.getByRole('button',{name:'提交后续轮次',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.continueHeld)
   await page.evaluate(()=>(window as any).fixture.select('b'));await page.getByRole('button',{name:'打开待核对的原任务',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.navigated),['11111111-1111-4111-8111-111111111111']);assert.equal(await page.getByRole('textbox',{name:'继续原工作',exact:true}).count(),0)
   await page.evaluate(()=>(window as any).fixture.releaseContinue());await page.getByRole('textbox',{name:'继续原工作',exact:true}).waitFor();assert.match(await page.locator('section').innerText(),/原API工作乙.*第1轮/);assert.doesNotMatch(await page.locator('section').innerText(),/原API工作甲/);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('卸载期间完成的续办不再次发送，损坏恢复记录阻止新请求',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.mode='hold');await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('卸载测试');await page.getByRole('button',{name:'提交后续轮次',exact:true}).click();await page.waitForFunction(()=>(window as any).fixture.continueHeld)
   await page.evaluate(()=>(window as any).fixture.visible(false));await page.locator('section').waitFor({state:'hidden'});await page.evaluate(()=>(window as any).fixture.releaseContinue());await turn(page);await page.evaluate(()=>(window as any).fixture.visible(true))
   await page.getByRole('status').filter({hasText:/原API工作甲.*第2轮/}).waitFor();assert.equal(await page.evaluate(()=>(window as any).fixture.accepted),1)
   await page.evaluate(()=>{(window as any).fixture.damageJournal();(window as any).fixture.recreate()});await page.getByRole('alert').filter({hasText:/续办恢复记录无法读取/}).waitFor();assert.equal(await page.locator('form').count(),0);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('读取失败可重试，390px 长标题和输入不产生横向溢出',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>{(window as any).fixture.readFail=true;(window as any).fixture.recreate()});await page.getByRole('button',{name:'重试读取',exact:true}).waitFor();assert.doesNotMatch(await page.locator('section').innerText(),/RAW_READ_ERROR/)
   await page.evaluate(()=>(window as any).fixture.readFail=false);await page.getByRole('button',{name:'重试读取',exact:true}).click();await page.getByRole('textbox',{name:'继续原工作',exact:true}).waitFor()
   await page.setViewportSize({width:390,height:844});await page.evaluate(()=>(window as any).fixture.source('a',{work:{title:'LongApiWorkTitle'.repeat(18)}}));await page.getByRole('button',{name:'刷新原工作',exact:true}).click();await page.getByRole('textbox',{name:'继续原工作',exact:true}).fill('继续核对完整问题与资料来源。'.repeat(20))
   assert.ok(await page.locator('section').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth+1));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1))
   if(process.env.TELOA_TEST_SCREENSHOT)await page.screenshot({path:process.env.TELOA_TEST_SCREENSHOT,fullPage:true});assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
})
