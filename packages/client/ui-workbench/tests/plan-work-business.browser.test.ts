import assert from 'node:assert/strict'
import {test,before,after,type TestContext} from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用仓内无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:Awaited<ReturnType<ReturnType<typeof loadPlaywright>['chromium']['launch']>>,script:string,styles:string
declare global{interface Window{planBusiness:{calls:Array<[string,any]>;changes:any[];reads:string[];finishSources?:()=>void}}}
const fixture=`import React from 'react';import{createRoot}from'react-dom/client';import{PlanWorkSettings}from'${client}PlanWorkSettings.tsx';import{createPlanApi}from'${client}plan-api.ts';import{I18nProvider}from'${client}i18n/provider.tsx';import{translateMessage}from'${client}i18n/messages.ts';import css from'${client}TaskPage.module.css';
const mode=document.documentElement.dataset.mode,locale=document.documentElement.lang||'en',snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},at='2026-10-25T00:00:00.000Z',f=window.planBusiness={calls:[],changes:[],reads:[]};
const roleId='22222222-2222-4222-8222-222222222222',planId='11111111-1111-4111-8111-111111111111',delegationId='33333333-3333-4333-8333-333333333333',requestId='44444444-4444-4444-8444-444444444444';
const trigger={kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},business={kind:'local-event',eventKind:'business-object-version',sourceRef:mode==='single'?{kind:'business-object',scope:'support',type:'tickets',id:'original-ticket'}:{kind:'business-object-type',scope:'support',type:'tickets'},coalesce:'latest'};
const plan={id:planId,ownerId:'local:owner',roleId,roleVersion:3,title:'售后逐单核验',goal:'按当前记录金额核验；不同记录独立，同一记录更新续办。',dataScope:'本业务工单；外部只读。',delivery:'关联原工单的核验结果。',scope:'support',state:mode==='active'?'active':'paused',version:4,configVersion:2,trigger,notificationPolicy:'attention',source:{kind:'manual'},archivedReason:null,archivedAt:null,createdAt:at,updatedAt:at,completionPolicy:{kind:'manual'}};
if(mode!=='new')plan.workDefinition={schema:'teloa.plan-work/v3',definitionVersion:2,definitionControlId:planId,budgetAccountId:roleId,authorization:{kind:'delegation',delegationId,delegationVersion:2},triggers:mode==='multiple'?[business,{kind:'schedule',schedule:trigger}]:mode==='unknown'?[{kind:'local-event',eventKind:'business-sync-result',sourceRef:{kind:'business-sync',scope:'support',mappingId:'orders-sync'},coalesce:'none'}]:[business],completion:{kind:'manual'},budget:{maxGoalRounds:8,maxTokens:1000000,maxConcurrent:2,maxElapsedMs:600000,maxRetries:1,stagnationRounds:3,money:null},overlap:mode==='single'?'forbid':'independent',missed:'coalesce',safeRecovery:false};
if(mode==='money')plan.workDefinition.budget.money={currency:'USD',maxMinorUnits:500};
const role={storage:'persistent',id:roleId,version:3,state:'active',kind:'employee',scopes:['support'],workAccess:{roleId,roleVersion:3,delegations:[{id:delegationId,version:2,roleId,roleVersion:3,scope:'support',state:'active',allowedTools:['read'],knowledgeIds:[]}]}};
let saved=plan;
const api=createPlanApi(async(endpoint,payload)=>{f.calls.push([endpoint,payload]);if(endpoint==='plans/get')return saved;if(endpoint!=='plans/configure-work-confirmed')throw Error('Unexpected endpoint');if(mode==='conflict')throw Object.assign(Error('Version conflict'),{code:'teloa/version-conflict',rejected:true});saved={...plan,...payload.fields,version:5,configVersion:3,state:'paused',completionPolicy:payload.configuration.completion,workDefinition:{schema:'teloa.plan-work/v3',definitionVersion:3,definitionControlId:planId,budgetAccountId:roleId,authorization:{kind:'delegation',delegationId,delegationVersion:2},...payload.configuration}};return saved},undefined,()=>requestId);
const businessSources={list:async(scope,signal)=>{f.reads.push(scope);if(mode==='delayed')await new Promise(resolve=>{f.finishSources=resolve});if(mode==='unavailable')throw Object.assign(Error('Source unavailable'),{code:'teloa/source-unavailable'});if(mode==='unpaged')return [{sourceRef:{kind:'business-object-type',scope:'support',type:'tickets'}}];return mode==='removed'?[]:[{sourceRef:{kind:'business-object-type',scope:'support',type:'tickets'},title:'售后工单'},{sourceRef:{kind:'business-object-type',scope:'support',type:'orders'},title:'订单'}]}};
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><section className={css.page}><PlanWorkSettings plan={plan} role={role} api={api} businessSources={businessSources} resources={undefined} changed={row=>f.changes.push(row)} openRole={()=>{}}/></section></I18nProvider>);`
before(async()=>{const virtual=root+'__plan_work_business.tsx',result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'plan-work-business',resolveId:id=>id.endsWith('plan-work-business')?virtual:null,load:id=>id===virtual?fixture:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'plan-work-business',name:'PlanWorkBusiness',formats:['iife']}}});const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);const chunk=bundle.output.find(row=>row.type==='chunk');assert.ok(chunk&&chunk.type==='chunk');script=chunk.code;styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())})
after(async()=>{await browser?.close()})
async function mount(t:TestContext,mode='business',locale='en'){const page=await browser.newPage({viewport:{width:760,height:1050}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:{abort:()=>Promise<void>})=>route.abort());await page.setContent('<!doctype html><html lang="'+locale+'" data-mode="'+mode+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-border:#ddd;--teloa-text:#222;--teloa-muted:#666}body{font:14px system-ui;margin:0}'+styles});await page.addScriptTag({content:script});return page}
const confirmation='I confirm these triggers, completion policy, and cumulative limits within the role’s existing delegation.'
const save='Confirm and save definition'
test('原业务触发可审阅修改，真实API保留来源/版本/独立策略，保存仍暂停且不启用',async t=>{
 const page=await mount(t);await page.getByRole('button',{name:'Edit work configuration',exact:true}).click()
 assert.equal(await page.getByRole('combobox',{name:'Wake when',exact:true}).inputValue(),'business')
 await page.getByRole('combobox',{name:'Business records',exact:true}).selectOption('type:tickets')
 assert.equal(await page.getByLabel('Handle each record independently; updates continue that record’s work.',{exact:true}).isChecked(),true)
 await page.getByRole('textbox',{name:'Work goal',exact:true}).fill('按当前版本核验')
 assert.equal(await page.getByRole('button',{name:save,exact:true}).isDisabled(),true)
 await page.getByLabel(confirmation,{exact:true}).check();await page.getByRole('button',{name:save,exact:true}).click()
 await page.waitForFunction(()=>window.planBusiness.changes.length===1)
 const result=await page.evaluate(()=>window.planBusiness)
 assert.deepEqual(result.calls.map((row:[string,unknown])=>row[0]),['plans/configure-work-confirmed','plans/get'])
 const payload=result.calls[0]![1]
 assert.equal(payload.planId,'11111111-1111-4111-8111-111111111111');assert.equal(payload.expectedVersion,4);assert.equal(payload.expectedConfigVersion,2)
 assert.deepEqual(payload.configuration.triggers,[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object-type',scope:'support',type:'tickets'},coalesce:'latest'}]);assert.equal(payload.configuration.overlap,'independent')
 assert.equal(result.changes[0].state,'paused');assert.equal(result.changes[0].goal,'按当前版本核验');assert.deepEqual(result.reads,['support'])
})
test('已有单记录来源与禁止重叠策略原样保留，关闭编辑不提交且保留草稿',async t=>{
 const page=await mount(t,'single');await page.getByRole('button',{name:'Edit work configuration',exact:true}).click()
 const selector=page.getByRole('combobox',{name:'Business records',exact:true})
 assert.equal(await selector.inputValue(),'original-record');assert.equal(await page.getByLabel('Handle each record independently; updates continue that record’s work.',{exact:true}).isChecked(),false)
 await page.getByRole('textbox',{name:'Work goal',exact:true}).fill('保留单记录草稿');await page.getByRole('button',{name:'Close configuration',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.planBusiness.calls),[])
 await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'Work goal',exact:true}).inputValue(),'保留单记录草稿')
 await page.getByLabel(confirmation,{exact:true}).check();await page.getByRole('button',{name:save,exact:true}).click();await page.waitForFunction(()=>window.planBusiness.changes.length===1)
 const payload=await page.evaluate(()=>window.planBusiness.calls[0]![1]);assert.deepEqual(payload.configuration.triggers[0].sourceRef,{kind:'business-object',scope:'support',type:'tickets',id:'original-ticket'});assert.equal(payload.configuration.overlap,'forbid')
})
test('日程计划选择业务来源时才配置独立对象，修改来源会撤销旧确认',async t=>{
 const page=await mount(t,'new');await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();await page.getByRole('combobox',{name:'Wake when',exact:true}).selectOption('business')
 const selector=page.getByRole('combobox',{name:'Business records',exact:true});await selector.selectOption('type:tickets');await page.getByLabel(confirmation,{exact:true}).check();await selector.selectOption('type:orders')
 assert.equal(await page.getByLabel(confirmation,{exact:true}).isChecked(),false);await page.getByLabel(confirmation,{exact:true}).check();await page.getByRole('button',{name:save,exact:true}).click();await page.waitForFunction(()=>window.planBusiness.changes.length===1)
 const config=await page.evaluate(()=>window.planBusiness.calls[0]![1].configuration);assert.deepEqual(config.triggers[0].sourceRef,{kind:'business-object-type',scope:'support',type:'orders'});assert.equal(config.overlap,'independent')
})
test('来源仍在读取时作出的确认不自动授权稍后读回的业务来源',async t=>{
 const page=await mount(t,'delayed');await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();await page.getByLabel(confirmation,{exact:true}).check()
 assert.equal(await page.getByRole('button',{name:save,exact:true}).isDisabled(),true);await page.evaluate(()=>window.planBusiness.finishSources?.())
 await page.waitForFunction(()=>!document.querySelector<HTMLSelectElement>('select[required]')?.disabled)
 assert.equal(await page.getByLabel(confirmation,{exact:true}).isChecked(),false);assert.equal(await page.getByRole('button',{name:save,exact:true}).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>window.planBusiness.calls),[])
})
for(const mode of ['unavailable','removed','multiple','unknown'])test(mode+'：不可读、撤回、多来源或未支持触发不得静默改为日程或提交',async t=>{
 const page=await mount(t,mode);await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();await page.getByLabel(confirmation,{exact:true}).check();assert.equal(await page.getByRole('button',{name:save,exact:true}).isDisabled(),true);assert.deepEqual(await page.evaluate(()=>window.planBusiness.calls),[])
 if(mode==='unknown'||mode==='multiple')await page.getByText('This plan uses additional trigger types. Review them in the source conversation before changing the configuration.',{exact:true}).waitFor()
})
test('服务端版本冲突保留当前草稿与暂停状态，不自动重试或启用',async t=>{
 const page=await mount(t,'conflict');await page.getByRole('button',{name:'Edit work configuration',exact:true}).click();await page.getByRole('combobox',{name:'Business records',exact:true}).selectOption('type:tickets');await page.getByLabel(confirmation,{exact:true}).check();await page.getByRole('button',{name:save,exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.evaluate(()=>window.planBusiness.calls.length),1);assert.deepEqual(await page.evaluate(()=>window.planBusiness.changes),[])
})
test('中文业务配置在桌面和窄屏可读，审图证据仅按指定目录输出',async t=>{
 const page=await mount(t,'business','zh-CN');await page.getByRole('button',{name:'修改工作配置',exact:true}).click();await page.getByRole('combobox',{name:'业务记录',exact:true}).selectOption('type:tickets')
 assert.equal(await page.locator('form').count(),1)
 for(const width of [760,390]){
  await page.setViewportSize({width,height:1800});assert.equal(await page.locator('form').evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth),true)
  if(process.env.TELOA_TEST_EVIDENCE_DIR){
   const start=await page.getByRole('combobox',{name:'唤醒条件',exact:true}).locator('..').boundingBox(),end=await page.getByLabel('每条记录独立工作；同一记录更新继续原工作。',{exact:true}).locator('..').boundingBox()
   assert.ok(start&&end);await page.screenshot({path:process.env.TELOA_TEST_EVIDENCE_DIR+'/business-trigger-controls-'+width+'.png',clip:{x:0,y:start.y,width,height:end.y+end.height-start.y+8}})
  }
 }
 assert.doesNotMatch(await page.locator('body').innerText(),/sourceRef|business-object-type|11111111|22222222|original-ticket/)
})

for(const mode of ['money','unpaged'])test(mode+'：修改原业务触发时保留费用上限及无页面的合法原类型',async t=>{
 const page=await mount(t,mode);await page.getByRole('button',{name:'Edit work configuration',exact:true}).click()
 await page.getByRole('combobox',{name:'Business records',exact:true}).selectOption('type:tickets')
 if(mode==='unpaged')await page.getByRole('option',{name:'The record type already bound to this plan',exact:true}).waitFor({state:'attached'})
 await page.getByRole('textbox',{name:'Work goal',exact:true}).fill('仅更新核验目标')
 await page.getByLabel(confirmation,{exact:true}).check();await page.getByRole('button',{name:save,exact:true}).click();await page.waitForFunction(()=>window.planBusiness.changes.length===1)
 const config=await page.evaluate(()=>window.planBusiness.calls[0]![1].configuration)
 assert.deepEqual(config.triggers[0].sourceRef,{kind:'business-object-type',scope:'support',type:'tickets'})
 assert.deepEqual(config.budget.money,mode==='money'?{currency:'USD',maxMinorUnits:500}:null)
})
