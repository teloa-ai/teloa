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
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const labels=[['general','通用工作'],['SOC','安全运营'],['AppSec','应用安全']].map(([scope,title])=>({scope,title,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}));
const roles=Array.from({length:3},(_,index)=>({id:'employee-'+index,name:'原员工'+index,kind:'employee',scopes:['general','SOC','AppSec'],state:'active',version:1,skills:[],knowledge:[]})),plans=Array.from({length:5},(_,index)=>({scope:'SOC',state:'paused',title:'原计划'+index}));
const fixture={opened:[],staff:[],connected:[],composition:[],sets:[],blocked:[],locked:false};window.businessEntryFixture=fixture;
let current={sessionId:'original',scopeId:'general',roleId:null,version:1,locked:false};const storage={getItem:()=>null,setItem:()=>{},removeItem:()=>{}};
const api=createHomeContextApi(async(endpoint,payload)=>{if(endpoint.endsWith('/read'))return current;fixture.sets.push(payload);return current={...payload,version:payload.expectedVersion+1,locked:false}},storage,()=> 'original-context-request');
const binding={sessionId:'original',status:'ready',conversation:{}},work={subscribe:()=>()=>{},getSnapshot:()=>binding},useSession=select=>select({blank:!fixture.locked,pendingSubmissions:[]}),useInput=select=>select({attachmentIds:[]}),isNativeChild=()=>false,isAssistantContext=async()=>true,getRoles=async()=>roles,block=(...value)=>fixture.blocked.push(value);
function App(){const [locked,setLocked]=React.useState(false);window.lockBusinessEntry=()=>{fixture.locked=true;setLocked(true)};return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={labels}><section aria-label="原输入上下文"><HomeComposerContext key={String(locked)} sessionId="original" api={api} work={work} useSession={useSession} useInput={useInput} isNativeChild={isNativeChild} isAssistantContext={isAssistantContext} roles={getRoles} block={block}/></section><BusinessHome labels={labels} directory={{status:'ready',retry:()=>{}}} roles={roles} dataSources={[]} attention={[]} tasks={[]} plans={plans} open={scope=>fixture.opened.push(scope)} openStaff={scope=>fixture.staff.push(scope)} connect={scope=>fixture.connected.push(scope)} addBusiness={()=>{}} goComposition={target=>fixture.composition.push(target)}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-business-entry-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BusinessEntryFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:12px;--teloa-font-control:13px;--teloa-font-body:14px;--teloa-font-page:24px;--teloa-font-detail:18px;--teloa-font-section:18px;--teloa-leading-heading:1.4;--teloa-leading-label:1.5;--teloa-weight-medium:500;--teloa-weight-heading:600;--teloa-text:#242624;--teloa-muted:#6c7068;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-border:#e2e3de;--teloa-accent:#a34026;--teloa-design-r1:6px;--teloa-design-r3:10px;--teloa-design-round:999px}body{font:14px system-ui;margin:0}'+styles});await page.addScriptTag({content:script});await page.getByRole('heading',{name:'业务',exact:true}).waitFor();return page
}

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
