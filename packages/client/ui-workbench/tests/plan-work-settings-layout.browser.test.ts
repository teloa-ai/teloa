import assert from 'node:assert/strict'
import {test,before,after,type TestContext} from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用仓内无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:Awaited<ReturnType<ReturnType<typeof loadPlaywright>['chromium']['launch']>>,script:string,styles:string
declare global{interface Window{planWorkLayout:{calls:unknown[];changes:unknown[];openConfiguration:()=>void}}}
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import{PlanWorkSettings}from'${client}PlanWorkSettings.tsx';import{focusObjectAnchor}from'${client}object-page-anchor.ts';import{I18nProvider}from'${client}i18n/provider.tsx';import{translateMessage}from'${client}i18n/messages.ts';import css from'${client}TaskPage.module.css';
const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={t:(key,params)=>translateMessage('en',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},at='2026-10-16T00:00:00Z',f=window.planWorkLayout={calls:[],changes:[],openConfiguration:()=>focusObjectAnchor(document.body,'plan-work','note')};
const plan={id:'plan-original',ownerId:'local:owner',roleId:'role-original',roleVersion:3,title:'Original plan',goal:'Original goal',dataScope:'Original source scope',delivery:'Original output',scope:'general',state:document.documentElement.dataset.mode==='active'?'active':'paused',version:4,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},createdAt:at,updatedAt:at};
if(document.documentElement.dataset.mode==='business'){plan.scope='SOC';plan.workDefinition={schema:'teloa.plan-work/v3',definitionVersion:2,triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object',scope:'SOC',type:'lead-record',id:'original-key'},coalesce:'latest'}],completion:{kind:'manual'},budget:{maxGoalRounds:32,maxTokens:2000000,maxConcurrent:1,maxElapsedMs:21600000,maxRetries:3,stagnationRounds:3,money:null},safeRecovery:false}};
if(document.documentElement.dataset.mode==='owner'){plan.roleId=null;plan.roleVersion=null;plan.executor={kind:'owner',grantId:'plan-original',grantVersion:2};plan.workDefinition={schema:'teloa.plan-work/v3',definitionVersion:2,authorization:plan.executor,triggers:[{kind:'schedule',schedule:plan.trigger}],completion:{kind:'manual'},budget:{maxGoalRounds:9,maxTokens:65536,maxConcurrent:1,maxElapsedMs:300000,maxRetries:1,stagnationRounds:3,money:null},safeRecovery:false}};
const role={storage:'persistent',id:plan.roleId,version:3,state:'active',kind:'employee',scopes:[plan.scope],workAccess:{roleId:plan.roleId,roleVersion:3,delegations:[{id:'delegation-original',version:2,roleId:plan.roleId,roleVersion:3,scope:plan.scope,state:'active',allowedTools:['read'],knowledgeIds:[]}]}};
const api={configureWorkConfirmed:async(...args)=>{f.calls.push(args);throw Object.assign(Error('Result unconfirmed'),{code:'teloa/network'})}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><section className={css.page}><PlanWorkSettings plan={plan} role={plan.executor?undefined:role} api={api} resources={undefined} groups={[{id:'group-original',name:'Original group',scope:'general'}]} changed={row=>f.changes.push(row)} openRole={()=>{}}/></section></I18nProvider>);`
before(async()=>{const virtual=root+'__plan_work_layout.tsx',result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'plan-work-layout',resolveId:id=>id.endsWith('plan-work-layout')?virtual:null,load:id=>id===virtual?fixture:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'plan-work-layout',name:'PlanWorkLayout',formats:['iife']}}});const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);const chunk=bundle.output.find(row=>row.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,mode='paused'){const page=await browser.newPage({viewport:{width:760,height:950}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><html data-mode="'+mode+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-border:#ddd;--teloa-text:#222;--teloa-muted:#666}body{font:14px system-ui;margin:0}'+styles});await page.addScriptTag({content:script});await page.getByText('Ongoing work',{exact:true}).waitFor();return page}
test('长期配置明确进入编辑，分组平铺保全部额度与草稿；收起不保存，未知回执不自动重发',async t=>{const page=await mount(t),edit=page.getByRole('button',{name:'Edit work configuration',exact:true});assert.equal(await edit.count(),1);assert.equal(await page.getByRole('textbox').count(),0);await edit.click();const goal=page.getByRole('textbox',{name:'Work goal',exact:true});await goal.fill('Keep my unsent goal');assert.equal(await page.getByRole('spinbutton').count(),6,'全部六项额度都直接可核对');await page.getByRole('button',{name:'Close configuration',exact:true}).click();assert.equal(await page.getByRole('textbox').count(),0);assert.deepEqual(await page.evaluate(()=>window.planWorkLayout.calls),[]);await page.evaluate(()=>window.planWorkLayout.openConfiguration());assert.equal(await goal.inputValue(),'Keep my unsent goal');await page.getByLabel('I confirm these triggers, completion policy, and cumulative limits within the role’s existing delegation.',{exact:true}).check();await page.getByRole('button',{name:'Confirm and save definition',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>window.planWorkLayout.calls.length),1);assert.deepEqual(await page.evaluate(()=>window.planWorkLayout.changes),[]);await page.getByRole('button',{name:'Close configuration',exact:true}).click();await edit.click();assert.equal(await goal.inputValue(),'Keep my unsent goal');assert.equal(await page.evaluate(()=>window.planWorkLayout.calls.length),1);for(const width of [760,390]){await page.setViewportSize({width,height:950});assert.equal(await page.locator('form').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth),true)}})
test('运行中的计划仍只能阅读暂停提示，不暴露配置提交',async t=>{const page=await mount(t,'active');assert.equal(await page.getByRole('button',{name:'Edit work configuration',exact:true}).count(),0);assert.equal(await page.getByRole('textbox').count(),0);await page.getByText('Pause the plan and finish the current work before changing its definition.',{exact:true}).waitFor();assert.deepEqual(await page.evaluate(()=>window.planWorkLayout.calls),[])})

test('未支持业务观察选择的旧配置编辑器不能把原v3来源静默替成日程',async t=>{const page=await mount(t,'business');await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();await page.getByRole('textbox',{name:'Work goal',exact:true}).fill('Keep the original observation source');await page.getByLabel('I confirm these triggers, completion policy, and cumulative limits within the role’s existing delegation.',{exact:true}).check();assert.equal(await page.getByRole('button',{name:'Confirm and save definition',exact:true}).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>window.planWorkLayout.calls),[]);await page.getByRole('button',{name:'Close configuration',exact:true}).click();await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Work goal',exact:true}).inputValue(),'Keep the original observation source')})


test('本人计划配置使用原本人日程授权，不要求虚构员工或暴露群/资料授权',async t=>{
 const page=await mount(t,'owner')
 const edit=page.getByRole('button',{name:'Edit work configuration',exact:true})
 await edit.click()
 assert.equal(await page.getByText('Configure role delegation',{exact:true}).count(),0)
 assert.equal(await page.getByRole('combobox').count(),1)
 const trigger=page.getByRole('combobox')
 assert.equal(await trigger.locator('option').count(),1)
 await page.getByRole('textbox',{name:'Work goal',exact:true}).fill('Keep my owner plan goal')
 const retries=page.getByRole('spinbutton',{name:'Retry limit per operation',exact:true})
 assert.equal(await retries.getAttribute('min'),'0');await retries.fill('0')
 await page.getByRole('button',{name:'Close configuration',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>window.planWorkLayout.calls),[])
 await edit.click()
 assert.equal(await page.getByRole('textbox',{name:'Work goal',exact:true}).inputValue(),'Keep my owner plan goal')
 await page.getByLabel('I confirm these schedule, completion policy, and cumulative limits within my existing authorization.',{exact:true}).check()
 await page.getByRole('button',{name:'Confirm and save definition',exact:true}).click()
 await page.getByRole('alert').waitFor()
 const calls=await page.evaluate(()=>window.planWorkLayout.calls) as Array<[unknown,{triggers:unknown[];budget:{maxRetries:number}}]>
 assert.equal(calls.length,1)
 assert.equal(calls[0]?.[1].budget.maxRetries,0)
 assert.deepEqual(calls[0]?.[1].triggers,[{kind:'schedule',schedule:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}])
 assert.deepEqual(await page.evaluate(()=>window.planWorkLayout.changes),[])
})
