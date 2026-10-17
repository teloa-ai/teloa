import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),legacyScopes=fileURLToPath(new URL('./fixtures/legacy-security-scopes.ts',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {PlanExecutionDirectory} from '${client}PlanExecutionDirectory.tsx';import {ContinuousPage} from '${client}ContinuousPage.tsx';import {emptyTaskPreview} from '${client}task-preview.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {createPlanApi} from '${client}plan-api.ts';
import {writeDirectoryFilterCategory} from '${client}workbench-navigation-state.ts';
import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {legacySecurityLabels} from '${legacyScopes}';
// 恢复的 SOC 筛选以存量目录已有安全运营为前提（新目录只预置通用工作），这里显式提供该目录行。
const legacyLabels=legacySecurityLabels();
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const planId='11111111-1111-4111-8111-111111111111',taskId='22222222-2222-4222-8222-222222222222',employeeId='33333333-3333-4333-8333-333333333333',claimId='44444444-4444-4444-8444-444444444444';
const item={claimId,planId,occurrenceId:'weekly:2026-10-12T01:00:00.000Z',planVersion:3,configVersion:2,notificationPolicy:'attention',scheduledAt:'2026-10-12T01:00:00.000Z',claimedAt:'2026-10-12T01:00:01.000Z',task:{id:taskId,state:'waiting'},run:{id:'55555555-5555-4555-8555-555555555555',state:'ended',sessionId:'original-session',createdAt:'2026-10-12T01:00:01.000Z'}};
const state={calls:[],opened:[],plansOpened:0,fail:false,hasRecord:false,rawJournal:'{broken',discards:0},roles=[{id:employeeId,name:'资料核对员工',storage:'persistent'}],plans=[{id:planId,title:'每周资料核对'}];
const api={directory:async input=>{state.calls.push(input);if(state.fail)throw Error('读取失败');return {items:state.hasRecord&&!input.query?[item]:[]}}};window.automationFixture=state;
const recoveryApi=createPlanApi(async endpoint=>{state.calls.push(endpoint);if(endpoint==='plans/list')return [];throw Error('恢复记录丢弃不得发送写请求')},{read:()=>state.rawJournal,write:value=>{state.rawJournal=value},clear:()=>{state.rawJournal=null;state.discards++}});
function App(){const [target,go]=React.useState({kind:'plans'}),noop=()=>{},preview=emptyTaskPreview(),view=document.getElementById('root').dataset.view;const scoped=page=>view==='planfilters'?<BusinessScopeProvider labels={legacyLabels}>{page}</BusinessScopeProvider>:page;return <I18nProvider runtime={runtime}>{view==='plans'||view==='planfilters'||view==='recovery'?scoped(<ContinuousPage persistence={view==='recovery'?{api:recoveryApi,plans:[],merge:noop,refreshRoles:noop,industrySource:()=>null}:undefined} prepareConversation={async value=>state.opened.push(value)} navigation={view==='planfilters'?{state:{category:writeDirectoryFilterCategory({view:'rules',scope:'SOC',planStatus:'archived'})},change:noop}:undefined} state={preview} target={target} go={go} visible seed={null} clearSeed={noop} openArtifacts={noop} openMarket={noop} change={()=>preview} openTask={noop} openRole={noop} openBusiness={noop} team={noop} attention={noop}/>):<PlanExecutionDirectory api={api} plans={plans} roles={roles} scopes={{general:'通用工作',SOC:'安全运营'}} fixedScope={view==='fixed'?'SOC':undefined} fixedRoleId={view==='fixed'?employeeId:undefined} openPlans={()=>state.plansOpened++} openTask={id=>state.opened.push(id)}/>}</I18nProvider>};
createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-automation-compact-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'AutomationCompactFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,view='runs',record=false){const page=await browser.newPage({viewport:{width:1200,height:850}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root" data-view="'+view+'"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:13px;--teloa-font-control:14px;--teloa-font-body:14px;--teloa-font-page:26px;--teloa-font-section:18px;--teloa-font-detail:20px;--teloa-font-reading:14px;--teloa-text:#242624;--teloa-muted:#6c7068;--teloa-background:#fff;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-border:#e2e3de;--teloa-focus:#a34026;--teloa-shadow:0 4px 16px #0002}body{font:14px system-ui;margin:0}'+styles});await page.addScriptTag({content:script});if(!view.startsWith('plan')&&view!=='recovery'){await page.getByRole('textbox',{name:'搜索执行记录'}).waitFor();if(record){await page.evaluate(()=>(window as any).automationFixture.hasRecord=true);await page.getByRole('button',{name:'刷新执行记录'}).click();await page.locator('[data-teloa-claim]').waitFor()}}return page}

test('执行记录只有顶部搜索和按需筛选，准确空态能回到计划且不伪称筛选失败',async t=>{
 const page=await mount(t)
 assert.equal(await page.getByRole('button',{name:'计划',exact:true}).count(),0,'子页面不重复顶层计划导航')
 assert.equal(await page.getByRole('combobox').count(),0,'筛选关闭时不占常驻侧栏')
 assert.equal(await page.getByRole('heading',{name:'还没有执行记录'}).count(),1)
 assert.doesNotMatch(await page.locator('body').innerText(),/真实执行|领取|原生含义|调整筛选/)
 await page.getByRole('button',{name:'查看计划',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).automationFixture.plansOpened),1)
 const trigger=page.getByRole('button',{name:'筛选执行记录',exact:true});await trigger.click()
 const filter=page.getByRole('dialog',{name:'筛选执行记录',exact:true});await filter.getByRole('combobox',{name:'执行状态'}).selectOption('ended')
 await page.keyboard.press('Escape');assert.equal(await filter.count(),0);assert.equal(await trigger.evaluate((node:any)=>node===document.activeElement),true)
 await page.getByRole('heading',{name:'没有匹配的结果'}).waitFor();await page.getByRole('button',{name:'清除筛选',exact:true}).click()
 await page.getByRole('heading',{name:'还没有执行记录'}).waitFor()
})

test('记录保留真实结束与等待核对状态，打开原任务；编号只在按需详情中出现',async t=>{
 const page=await mount(t,'runs',true),row=page.locator('[data-teloa-claim]')
 for(const phrase of ['每周资料核对','已结束','等待处理'])assert.ok((await row.innerText()).includes(phrase),phrase)
 assert.doesNotMatch(await row.innerText(),/44444444|11111111/)
 await row.getByRole('button',{name:'打开本次任务'}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).automationFixture.opened),['22222222-2222-4222-8222-222222222222'])
 await row.getByText('执行信息',{exact:true}).click();assert.match(await row.innerText(),/44444444|11111111/)
})

test('固定业务和员工不能借清除筛选扩大范围，外部点击关闭筛选后查询保留',async t=>{
 const page=await mount(t,'fixed'),trigger=page.getByRole('button',{name:'筛选执行记录',exact:true});await trigger.click()
 const filter=page.getByRole('dialog',{name:'筛选执行记录',exact:true});assert.equal(await filter.getByRole('combobox',{name:'业务范围'}).isDisabled(),true);assert.equal(await filter.getByRole('combobox',{name:'执行员工'}).isDisabled(),true)
 await page.mouse.click(20,800);assert.equal(await filter.count(),0)
 await page.getByRole('textbox',{name:'搜索执行记录'}).fill('没有这个计划');await page.getByRole('heading',{name:'没有匹配的结果'}).waitFor();await page.getByRole('button',{name:'清除筛选',exact:true}).click()
 const calls=await page.evaluate(()=>(window as any).automationFixture.calls);assert.equal(calls.at(-1).scope,'SOC');assert.equal(calls.at(-1).roleId,'33333333-3333-4333-8333-333333333333')
})

test('自动化只有计划和执行记录两个导航，目标草稿切换保留且不自动发送',async t=>{
 const page=await mount(t,'plans'),nav=page.getByRole('navigation',{name:'自动化',exact:true})
 assert.deepEqual(await nav.getByRole('button').allTextContents(),['计划 0','执行记录'])
 await page.getByRole('textbox',{name:'持续工作目标'}).fill('每周核对资料')
 await nav.getByRole('button',{name:'执行记录'}).click();await page.getByRole('button',{name:'新建沙盒计划',exact:true}).first().click()
 assert.equal(await page.getByRole('textbox',{name:'持续工作目标'}).inputValue(),'每周核对资料')
 assert.deepEqual(await page.evaluate(()=>(window as any).automationFixture.opened),[])
})

test('计划的业务与归档筛选恢复在按需面板中，清除后回到准确空目录',async t=>{
 const page=await mount(t,'planfilters');await page.getByRole('button',{name:'筛选计划',exact:true}).click()
 const filter=page.getByRole('dialog',{name:'筛选计划',exact:true})
 assert.equal(await filter.getByRole('combobox',{name:'全部业务',exact:true}).inputValue(),'SOC')
 assert.equal(await filter.getByRole('combobox',{name:'全部状态',exact:true}).inputValue(),'archived')
 await page.keyboard.press('Escape');assert.equal(await filter.count(),0)
 assert.equal(await page.getByRole('heading',{name:'没有匹配的结果'}).count(),1)
 await page.getByRole('button',{name:'重置筛选',exact:true}).click()
 await page.getByRole('heading',{name:'还没有自动化'}).waitFor()
 assert.equal(await page.getByRole('button',{name:'筛选计划',exact:true}).count(),0)
})

test('丢弃损坏的计划恢复记录只清本地，确认在错误消失后仍可见并保留原目标',async t=>{
 const page=await mount(t,'recovery'),goal=page.getByRole('textbox',{name:'持续工作目标',exact:true})
 await goal.fill('保留这份自动化目标草稿')
 assert.match(await page.getByRole('alert').innerText(),/可丢弃这条恢复记录后重试；若上一次请求已经生效，请到对应目录核对。/)
 const calls=await page.evaluate(()=>(window as any).automationFixture.calls)
 await page.getByRole('button',{name:'丢弃这条恢复记录',exact:true}).click()
 await page.getByRole('status').filter({hasText:'已丢弃本地恢复记录；如果上一次请求已经生效，请到目录里核对。'}).waitFor()
 assert.equal(await page.getByRole('alert').count(),0,'已清除损坏错误，但确认独立可见')
 const actual=await page.evaluate(()=>(window as any).automationFixture)
 assert.equal(actual.rawJournal,null);assert.equal(actual.discards,1);assert.deepEqual(actual.calls,calls,'丢弃不创建、更新或执行计划');assert.deepEqual(actual.opened,[],'丢弃不自动开启会话')
 assert.equal(await goal.inputValue(),'保留这份自动化目标草稿')
})
