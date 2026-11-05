import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string,styles:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {BusinessHome} from '${client}BusinessHome.tsx';import {HomeComposerContext} from '${client}HomeComposerContext.tsx';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {createHomeContextApi} from '${client}home-native-controller.ts';
const snapshot={locale:window.businessEntryLocale??'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const labels=[['general','通用工作'],['SOC','安全运营'],['AppSec','应用安全']].map(([scope,title])=>({scope,title,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}));
const roles=Array.from({length:3},(_,index)=>({id:'employee-'+index,name:'原员工'+index,kind:'employee',scopes:['general','SOC','AppSec'],state:'active',version:1,skills:[],knowledge:[]})),plans=Array.from({length:5},(_,index)=>({scope:'SOC',state:'paused',title:'原计划'+index}));
const fixture={opened:[],staff:[],connected:[],composition:[],sets:[],reads:[],blocked:[],locked:false};window.businessEntryFixture=fixture;
const setup=window.pendingBusinessContext;let current={sessionId:'original',scopeId:'general',roleId:null,version:1,locked:false};const rows=new Map(setup?[['teloa.home-work-context/v1',JSON.stringify(setup.request)]]:[]),storage={getItem:key=>rows.get(key)??null,setItem:(key,value)=>rows.set(key,value),removeItem:key=>rows.delete(key)};
const api=createHomeContextApi(async(endpoint,payload)=>{if(endpoint.endsWith('/read')){fixture.reads.push(payload.sessionId);if(payload.sessionId==='original')return current;if(setup?.unknown)throw Error('上次设置结果未知');return {...setup.request,scopeId:'AppSec',version:setup.request.expectedVersion+2,locked:false}}fixture.sets.push(payload);const next={...payload,version:payload.expectedVersion+1,locked:false};if(payload.sessionId==='original')current=next;return next},storage,()=> 'original-context-request');
let binding={sessionId:'original',status:'ready',conversation:{}};const bindingListeners=new Set(),work={subscribe:listener=>{bindingListeners.add(listener);return()=>bindingListeners.delete(listener)},getSnapshot:()=>binding},useSession=select=>select({blank:!fixture.locked,pendingSubmissions:[]}),useInput=select=>select({attachmentIds:[]}),isNativeChild=()=>false,isAssistantContext=async()=>true,getRoles=async()=>roles,block=(...value)=>fixture.blocked.push(value);
window.replaceHomeBinding=purpose=>{binding={...binding,conversation:purpose?{purpose}:{}};for(const listener of bindingListeners)listener()};
function App(){const [locked,setLocked]=React.useState(false);window.lockBusinessEntry=()=>{fixture.locked=true;setLocked(true)};return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={labels}><section aria-label="原输入上下文"><HomeComposerContext key={String(locked)} sessionId="original" api={api} work={work} useSession={useSession} useInput={useInput} isNativeChild={isNativeChild} isAssistantContext={isAssistantContext} roles={getRoles} block={block}/></section><BusinessHome labels={labels} directory={{status:'ready',retry:()=>{}}} roles={roles} dataSources={[]} attention={[]} tasks={[]} plans={plans} open={scope=>fixture.opened.push(scope)} openStaff={scope=>fixture.staff.push(scope)} connect={scope=>fixture.connected.push(scope)} addBusiness={()=>{}} goComposition={target=>fixture.composition.push(target)}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-business-entry-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BusinessEntryFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,pending?:{request:{requestId:string;sessionId:string;scopeId:string;roleId:null;expectedVersion:number};unknown?:boolean},locale='zh-CN'){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:12px;--teloa-font-control:13px;--teloa-font-body:14px;--teloa-font-page:24px;--teloa-font-detail:18px;--teloa-font-section:18px;--teloa-leading-heading:1.4;--teloa-leading-label:1.5;--teloa-weight-medium:500;--teloa-weight-heading:600;--teloa-text:#242624;--teloa-muted:#6c7068;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-border:#e2e3de;--teloa-accent:#a34026;--teloa-design-r1:6px;--teloa-design-r3:10px;--teloa-design-round:999px}body{font:14px system-ui;margin:0}section[aria-label="原输入上下文"]{padding:100px 24px 16px}'+styles});await page.addScriptTag({content:'window.businessEntryLocale='+JSON.stringify(locale)});if(pending)await page.addScriptTag({content:'window.pendingBusinessContext='+JSON.stringify(pending)});await page.addScriptTag({content:script});await page.getByRole('heading',{name:'业务',exact:true}).waitFor();return page
}

test('简中、繁中与英文分别展示未决设置及首条消息后固定业务规则',async t=>{
 const cases=[['zh-CN','上次业务设置仍待核对，请先核对上次设置。','会话发送第一条消息后业务固定，切换业务需新建工作。'],['zh-TW','上次業務設定仍待核對，請先核對上次設定。','會話傳送第一則訊息後業務固定，切換業務需建立新工作。'],['en','The previous business setting is still unconfirmed. Check that setting first.','The business is fixed after the first message. Start new work to change it.']]
 for(const [locale,pendingText,fixedText] of cases)await t.test(locale!,async sub=>{
  const page=await mount(sub,{request:{requestId:'old-setting',sessionId:'old',scopeId:'SOC',roleId:null,expectedVersion:1},unknown:true},locale)
  await page.getByRole('alert').filter({hasText:pendingText!}).waitFor()
  assert.equal(await page.getByRole('combobox').isDisabled(),true)
  if(process.env.TELOA_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOT_DIR,'business-context-'+locale+'-pending.png')})
  await page.evaluate(()=>(window as any).lockBusinessEntry())
  const hint=page.getByRole('tooltip',{includeHidden:true})
  assert.equal(await hint.isVisible(),false,'固定业务说明不常驻工具栏')
  const context=page.getByRole('region',{name:'原输入上下文',exact:true}).locator('[aria-describedby]')
  await context.focus();await hint.waitFor();assert.equal(await hint.innerText(),fixedText)
  await context.press('Escape');await hint.waitFor({state:'hidden'})
  await context.blur();await context.hover();await hint.waitFor()
  await page.getByRole('alert').filter({hasText:pendingText!}).waitFor()
  if(process.env.TELOA_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOT_DIR,'business-context-'+locale+'-fixed.png')})
 })
})

test('新工作只读核对旧设置，前进版本解除禁用且保留当前通用业务',async t=>{
 const page=await mount(t,{request:{requestId:'old-setting',sessionId:'old',scopeId:'SOC',roleId:null,expectedVersion:1}}),select=page.getByRole('combobox',{name:'业务',exact:true})
 await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[aria-label="业务"]')?.disabled)
 assert.equal(await select.inputValue(),'general')
 assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.reads),['old','original'])
 assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.sets),[])
})

test('旧业务设置结果未知时明确提示，显式核对只续办原请求且不污染当前选择',async t=>{
 const request={requestId:'old-setting',sessionId:'old',scopeId:'SOC',roleId:null,expectedVersion:1},page=await mount(t,{request,unknown:true}),select=page.getByRole('combobox',{name:'业务',exact:true})
 await page.getByRole('alert').filter({hasText:'上次业务设置仍待核对，请先核对上次设置。'}).waitFor()
 assert.equal(await select.isDisabled(),true)
 if(process.env.TELOA_TEST_SCREENSHOT_DIR)await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOT_DIR,'business-context-pending.png')})
 await page.getByRole('button',{name:'核对上次设置',exact:true}).click()
 await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[aria-label="业务"]')?.disabled)
 assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.sets),[request])
 assert.equal(await select.inputValue(),'general')
})

test('业务目录多列收紧空白、窄窗口回到单列，原进入及管理员工动作保持',async t=>{
 const page=await mount(t),cards=page.getByRole('article'),first=await cards.nth(0).boundingBox(),second=await cards.nth(1).boundingBox()
 assert.ok(first&&second);assert.ok(Math.abs(first.y-second.y)<2,'桌面卡片应在同一行呈现');assert.ok(first.height<230,'业务卡片不再占用过高区域')
 await cards.filter({has:page.getByText('安全运营',{exact:true})}).getByRole('button').first().click();assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.opened),['SOC'])
 await page.getByRole('button',{name:'查看员工 · 安全运营',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.staff),['SOC'])
 await page.setViewportSize({width:720,height:900});const narrowFirst=await cards.nth(0).boundingBox(),narrowSecond=await cards.nth(1).boundingBox();assert.ok(narrowFirst&&narrowSecond);assert.ok(narrowSecond.y>=narrowFirst.y+narrowFirst.height);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth))
})

test('业务卡的三位员工和五项自动化是并列事实，计划数不能被说成员工的子集',async t=>{
 const page=await mount(t),card=page.getByRole('article').filter({has:page.getByText('安全运营',{exact:true})}),body=await card.innerText()
 assert.match(body,/3 位员工/);assert.match(body,/5 项自动化/);assert.doesNotMatch(body,/其中|设成了自动化/)
 await card.getByRole('button',{name:'5 项自动化',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.composition),[{kind:'business',scope:'SOC'}])
})

test('业务选择呈现轻量控件，修改仍固定原会话与版本；已发送后只读不再写入',async t=>{
 const page=await mount(t),select=page.getByRole('combobox',{name:'业务',exact:true});await select.waitFor();await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[aria-label="业务"]')?.disabled)
 const style=await select.evaluate((node:any)=>({height:node.getBoundingClientRect().height,border:getComputedStyle(node).borderTopWidth}));assert.ok(style.height<=28,'业务选择不使用大表单高度');assert.equal(style.border,'0px')
 await select.selectOption('SOC');await page.waitForFunction(()=>(window as any).businessEntryFixture.sets.length===1);assert.deepEqual(await page.evaluate(()=>(window as any).businessEntryFixture.sets[0]),{sessionId:'original',scopeId:'SOC',roleId:null,expectedVersion:1,requestId:'original-context-request'})
 await page.evaluate(()=>(window as any).lockBusinessEntry());await page.getByText('安全运营',{exact:true}).first().waitFor();assert.equal(await select.count(),0);assert.equal(await page.evaluate(()=>(window as any).businessEntryFixture.sets.length),1)
})

test('浏览器认回助手专属身份后撤下业务切换，恢复普通首页绑定后可切换安全运营',async t=>{
 const page=await mount(t),select=page.getByRole('combobox',{name:'业务',exact:true})
 await select.waitFor();await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[aria-label="业务"]')?.disabled)
 await page.evaluate(()=>(window as any).replaceHomeBinding('assistant'));await select.waitFor({state:'hidden'})
 assert.equal(await page.evaluate(()=>(window as any).businessEntryFixture.sets.length),0)
 await page.evaluate(()=>(window as any).replaceHomeBinding());await select.waitFor()
 await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[aria-label="业务"]')?.disabled)
 await select.selectOption('SOC');await page.waitForFunction(()=>(window as any).businessEntryFixture.sets.length===1)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).businessEntryFixture;return [f.sets[0].sessionId,f.sets[0].scopeId,f.blocked.at(-1)[1]]}),['original','SOC',undefined])
})
