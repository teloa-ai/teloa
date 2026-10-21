import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React,{useState,useMemo} from 'react';import {createRoot} from 'react-dom/client';
import {StaffRoster} from '${client}StaffRoster.tsx';
import {ContinuousPage} from '${client}ContinuousPage.tsx';import {emptyTaskPreview} from '${client}task-preview.ts';import {projectSavedPlan} from '${client}plan-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const stamp='2026-10-11T00:00:00.000Z',role=(id,name,scopes)=>({id,name,scopes,storage:'persistent',kind:'employee',state:'active',version:3,duty:'核对资料',dataScope:'已授权资料',executionScope:'分析',skills:[],knowledge:[],memories:[],history:[]});
const roles=[role('22222222-2222-4222-8222-222222222222','安全员工',['SOC']),role('33333333-3333-4333-8333-333333333333','销售员工',['sales'])];
const fields={title:'原暂停计划',scope:'SOC',goal:'核对资料',dataScope:'已授权资料',delivery:'结果',roleId:roles[0].id,trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'},notificationPolicy:'silent'};
const original={...fields,id:'44444444-4444-4444-8444-444444444444',ownerId:'self',roleVersion:3,source:{kind:'manual'},version:1,configVersion:1,state:'paused',archivedReason:null,archivedAt:null,createdAt:stamp,updatedAt:stamp};
const ownerExecutor={kind:'owner',grantId:original.id,grantVersion:1},completionPolicy={kind:'manual'},ownerPlan={...original,scope:'general',roleId:null,roleVersion:null,executor:ownerExecutor,completionPolicy,source:{kind:'method-reuse',artifactId:original.id,version:1,basisHash:'a'.repeat(64),taskId:'11111111-1111-4111-8111-111111111111'},workDefinition:{schema:'teloa.plan-work/v3',definitionVersion:1,authorization:ownerExecutor,definitionControlId:original.id,budgetAccountId:original.id,completion:completionPolicy,triggers:[{kind:'schedule',schedule:original.trigger}],budget:{maxGoalRounds:9,maxTokens:65536,maxElapsedMs:300000,maxConcurrent:1,maxRetries:1,stagnationRounds:3,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false}};
const eventPlan={...original,completionPolicy:{kind:'manual'},workDefinition:{...ownerPlan.workDefinition,authorization:{kind:'delegation',delegationId:original.id,delegationVersion:1},triggers:[{kind:'local-event',eventKind:'business-object-version',sourceRef:{kind:'business-object',scope:'SOC',type:'lead',id:'lead-1'},coalesce:'latest'}]}};
const template={key:'fixed',itemId:'fixed',templateId:'review',title:'固定安全模板',version:'1.0.0',scope:'SOC',hash:'a'.repeat(64),example:false,source:'测试固定来源',author:'本人',license:'MIT',description:'核对资料',requirements:[],output:'结果',skills:[]};
window.planFixture={creates:[],updates:[],contacts:[],selected:[],tasks:[],conversations:[]};crypto.randomUUID=()=>'66666666-6666-4666-8666-666666666666';
function App(){
 const mode=window.planMode,sourcePlan=mode==='event-plan'?eventPlan:mode==='owner'?ownerPlan:mode.startsWith('origin')?{...original,source:{kind:'manual',sessionId:'original-plan-session'}}:original,[plans,setPlans]=useState(mode==='event-plan'||mode==='owner'||mode==='edit'||mode.startsWith('origin')?[sourcePlan]:[]),[target,go]=useState(mode==='event-plan'||mode==='owner'||mode==='edit'||mode.startsWith('origin')?{kind:'plan',id:original.id}:mode==='business'?{kind:'plans',scope:'SOC'}:{kind:'plans'}),[seed,setSeed]=useState(mode==='template'||mode==='journal-sandbox-template'?{template:{...template,example:mode==='journal-sandbox-template'},fields:{...fields,title:template.title},...(mode==='template'?{source:{kind:'market-content',contentId:original.id,contentHash:template.hash,resourceId:'review',resourceVersion:'1.0.0'}}:{})}:null);
 window.planFixture.enterScope=scope=>go({kind:'plans',...(scope?{scope}:{})});
 window.planFixture.enterTemplate=example=>setSeed({template:{...template,example},fields:{...fields,title:template.title},...(!example?{source:{kind:'market-content',contentId:original.id,contentHash:template.hash,resourceId:'review',resourceVersion:'1.0.0'}}:{})});
 const [sort,setSort]=useState('name');
 if(mode==='staff')return <I18nProvider runtime={runtime}><label>排序<select value={sort} onChange={event=>setSort(event.target.value)}><option value="name">姓名</option><option value="duty">岗位</option></select></label><StaffRoster roles={[...roles,roles[0]]} labels={roles.flatMap(row=>row.scopes.map(scope=>({scope,title:scope,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0})))} tasks={[{id:'original-task',assigneeId:roles[0].id,state:'ready',title:'原始任务',updatedAt:stamp,scope:'SOC'}]} sort={sort} fold={{toggled:[]}} onFoldChange={()=>{}} searching={false} onSelect={id=>window.planFixture.selected.push(id)} onTalk={id=>window.planFixture.contacts.push(['chat',id])} onPhone={id=>window.planFixture.contacts.push(['phone',id])} onOpenTask={id=>window.planFixture.tasks.push(id)} onHire={()=>{}}/></I18nProvider>;
 const merge=rows=>setPlans(current=>[...current.filter(row=>!rows.some(next=>next.id===row.id)),...rows]);
 const api=useMemo(()=>({list:async()=>plans,directory:async()=>({items:[],cursor:null}),executions:async()=>({items:[],nextCursor:null}),skips:async()=>({items:[],nextCursor:null}),schedule:async()=>mode==='event-plan'?{available:true,overview:{planId:original.id,planVersion:1,state:'paused',nextAt:null,latest:null,latestSkip:null},health:null}:null,pending:()=>mode==='journal-pending'?{kind:'create'}:null,recoveryMessage:()=>null,create:async(fields,source)=>{window.planFixture.creates.push({fields,source});return {...original,...fields,source,id:'55555555-5555-4555-8555-555555555555'}},update:async(plan,fields)=>{window.planFixture.updates.push({plan,fields});return {...plan,...fields,version:plan.version+1}}}),[]);
 return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={['general','SOC','sales'].map(scope=>({scope,title:scope,kind:'builtin',loads:0,activeLoads:0,tasks:0,groups:0}))}><ContinuousPage draftStorage={mode.startsWith('journal')?{namespace:'owner:journal-test',storage:mode==='journal-quota'?{getItem:key=>sessionStorage.getItem(key),setItem:()=>{throw Error('QuotaExceededError')},removeItem:key=>sessionStorage.removeItem(key)}:window.sessionStorage}:undefined} openConversation={async id=>{window.planFixture.conversations.push(id);if(mode==='origin-error')throw Error('原会话暂不可用');}} prepareConversation={mode.startsWith('conversation')?async request=>{window.planFixture.conversations.push(request);if(mode==='conversation-error')throw Error('会话准备失败');}:undefined} visible state={{...emptyTaskPreview(),roles,continuous:{plans:plans.map(projectSavedPlan),runs:[],loaded:true}}} target={target} go={go} persistence={{api,plans,controls:mode==='event-plan'?{get:async()=>({ownerId:original.ownerId,scope:'definition',state:'active'}),pending:()=>null}:undefined,merge,refreshRoles:()=>{},industrySource:()=>null}} seed={seed} clearSeed={()=>setSeed(null)} change={()=>{}} openArtifacts={()=>{}} openMarket={()=>{}} openTask={()=>{}} openRole={id=>window.planFixture.contacts.push(['role',id])} openBusiness={()=>{}} team={()=>{}} attention={()=>{}}/></BusinessScopeProvider></I18nProvider>
}createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-continuous-create-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ContinuousCreateFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,mode='new'){
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors:string[]=[]
 page.setDefaultTimeout(4000);page.on('pageerror',(e:Error)=>errors.push(e.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 if(mode.startsWith('journal')){
  await page.route('**/*',(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}))
  await page.addInitScript((value:string)=>(window as any).planMode=value,mode)
  await page.goto('http://continuous-drafts.test/')
 }else{
  await page.route('**/*',(route:any)=>route.abort())
  await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')
 }
 await page.evaluate((value:string)=>(window as any).planMode=value,mode)
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 return page
}

async function startGoal(page:any,goal='核对已授权资料'){
 await page.getByRole('button',{name:'新建自动化',exact:true}).click()
 await page.getByRole('textbox',{name:'持续工作目标',exact:true}).fill(goal)
 await page.getByRole('button',{name:'继续设置',exact:true}).click()
}
test('真实自然语言入口交给原会话，不打开或保存另一个计划表单；失败保留目标',async t=>{
 const page=await mount(t,'conversation')
 await page.getByRole('textbox',{name:'持续工作目标',exact:true}).fill('每周一九点核对已授权资料，只保存暂停计划')
 await page.getByRole('button',{name:'在会话中创建',exact:true}).click()
 const actual=await page.evaluate(()=>(window as any).planFixture)
 assert.deepEqual(actual.conversations,[{goal:'每周一九点核对已授权资料，只保存暂停计划',scope:'general'}])
 assert.deepEqual(actual.creates,[]);assert.equal(await page.getByRole('dialog').count(),0)
 await page.getByRole('button',{name:'按表单创建',exact:true}).click()
 await page.getByRole('dialog',{name:'新建持续计划',exact:true}).waitFor()
 assert.equal(await page.getByRole('dialog').getByRole('textbox',{name:'工作目标',exact:true}).inputValue(),'每周一九点核对已授权资料，只保存暂停计划')
 const failed=await mount(t,'conversation-error')
 await failed.getByRole('textbox',{name:'持续工作目标',exact:true}).fill('不能丢的自动化草稿')
 await failed.getByRole('button',{name:'在会话中创建',exact:true}).click()
 await failed.getByRole('alert').waitFor();assert.match(await failed.getByRole('alert').innerText(),/操作未完成，请稍后重试/)
 assert.equal(await failed.getByRole('textbox',{name:'持续工作目标',exact:true}).inputValue(),'不能丢的自动化草稿')
 assert.deepEqual(await failed.evaluate(()=>(window as any).planFixture.creates),[])
})
test('全局新建可选择业务，切换后重新选同业务员工，保存暂停计划沿用业务与员工版本',async t=>{
 const page=await mount(t)
 await startGoal(page)
 const form=page.getByRole('dialog'),scope=form.getByRole('combobox',{name:/^业务范围/}),role=form.getByRole('combobox',{name:/^负责员工/})
 assert.equal(await scope.isDisabled(),false)
 await form.getByRole('textbox',{name:'计划名称',exact:true}).fill('每周销售核对')
 await scope.selectOption('sales')
 assert.equal(await role.inputValue(),'')
 assert.deepEqual(await role.locator('option:not([disabled])').allTextContents(),['选择同业务在岗且已保存的员工','销售员工'])
 await role.selectOption('33333333-3333-4333-8333-333333333333')
 await scope.selectOption('SOC');assert.equal(await role.inputValue(),'')
 await role.selectOption('22222222-2222-4222-8222-222222222222')
 await form.getByRole('textbox',{name:'工作目标',exact:true}).fill('核对已授权资料')
 await form.getByRole('combobox',{name:'通知策略',exact:true}).selectOption('silent')
 await form.getByRole('button',{name:'保存暂停计划',exact:true}).click()
 await page.getByRole('dialog',{name:'新建持续计划',exact:true}).waitFor({state:'hidden'})
 await page.getByRole('dialog',{name:'每周销售核对',exact:true}).waitFor()
 const calls=await page.evaluate(()=>(window as any).planFixture.creates)
 assert.equal(calls.length,1);assert.equal(calls[0].fields.scope,'SOC');assert.equal(calls[0].fields.expectedRoleVersion,3);assert.equal(calls[0].fields.roleId,'22222222-2222-4222-8222-222222222222');assert.deepEqual(calls[0].source,{kind:'manual'})
})
test('编辑已保存计划仍固定业务与员工，固定业务模板不能改归属',async t=>{
 const page=await mount(t,'edit')
 await page.getByRole('button',{name:'修改计划配置',exact:true}).click()
 let form=page.getByRole('dialog')
 assert.equal(await form.getByRole('combobox',{name:/^业务范围/}).isDisabled(),true)
 assert.equal(await form.getByRole('combobox',{name:/^负责员工/}).isDisabled(),true)
 await page.close()
 const seeded=await mount(t,'template');form=seeded.getByRole('dialog')
 await form.waitFor();assert.equal(await form.getByRole('combobox',{name:/^业务范围/}).isDisabled(),true)
 assert.equal(await form.getByRole('combobox',{name:/^业务范围/}).inputValue(),'SOC')
})

test('示例模板切换至演示范围后仍打开原表单，不创建或执行正式计划',async t=>{
 const page=await mount(t,'journal-sandbox-template'),form=page.getByRole('dialog',{name:'新建持续计划',exact:true})
 await form.waitFor();assert.equal(await form.getByRole('textbox',{name:'计划名称',exact:true}).inputValue(),'固定安全模板')
 assert.equal(await page.locator('[data-continuous-mode="sandbox"]').count(),1)
 await form.getByRole('textbox',{name:'计划名称',exact:true}).fill('示例模板保留的输入');await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).planFixture.enterTemplate(false));await form.waitFor();assert.equal(await page.locator('[data-continuous-mode="saved"]').count(),1);assert.equal(await form.getByRole('textbox',{name:'计划名称',exact:true}).inputValue(),'固定安全模板')
 await form.getByRole('textbox',{name:'计划名称',exact:true}).fill('正式模板独立输入');await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).planFixture.enterTemplate(true));await form.waitFor();assert.equal(await page.locator('[data-continuous-mode="sandbox"]').count(),1);assert.equal(await form.getByRole('textbox',{name:'计划名称',exact:true}).inputValue(),'示例模板保留的输入')
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.creates),[]);assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.tasks),[])
})

test('业务内新建保持该业务上下文，不跳到其他业务归属',async t=>{
 const page=await mount(t,'business');await startGoal(page)
 const scope=page.getByRole('dialog').getByRole('combobox',{name:'业务范围',exact:true})
 assert.equal(await scope.inputValue(),'SOC');assert.equal(await scope.isDisabled(),true)
})

test('全局与业务内新建草稿分别保留，不能锁住另一个业务的旧草稿',async t=>{
 const page=await mount(t);await startGoal(page)
 let form=page.getByRole('dialog');await form.getByRole('textbox',{name:'计划名称',exact:true}).fill('全局销售草稿')
 await form.getByRole('combobox',{name:'业务范围',exact:true}).selectOption('sales');await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).planFixture.enterScope('SOC'));await startGoal(page)
 form=page.getByRole('dialog');assert.equal(await form.getByRole('combobox',{name:'业务范围',exact:true}).inputValue(),'SOC')
 assert.equal(await form.getByRole('textbox',{name:'计划名称',exact:true}).inputValue(),'核对已授权资料')
 await form.getByRole('textbox',{name:'计划名称',exact:true}).fill('安全业务草稿');await page.keyboard.press('Escape')
 await page.evaluate(()=>(window as any).planFixture.enterScope(null));await startGoal(page)
 form=page.getByRole('dialog');assert.equal(await form.getByRole('combobox',{name:'业务范围',exact:true}).inputValue(),'sales');assert.equal(await form.getByRole('textbox',{name:'计划名称',exact:true}).inputValue(),'全局销售草稿')
})


test('目标优先入口不自动保存，关闭后恢复编辑过的草稿，规则和历史仍可达',async t=>{
 const page=await mount(t)
 assert.equal(await page.getByRole('heading',{name:'你想让员工持续做什么？'}).count(),1)
 await page.getByRole('textbox',{name:'持续工作目标'}).fill('整理反馈，识别紧急问题')
 await page.getByRole('button',{name:'计划 0',exact:true}).click()
 await page.getByRole('button',{name:'新建自动化',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'持续工作目标'}).inputValue(),'整理反馈，识别紧急问题')
 await page.getByRole('button',{name:'继续设置',exact:true}).click()
 let form=page.getByRole('dialog')
 assert.equal(await form.getByRole('textbox',{name:'工作目标',exact:true}).inputValue(),'整理反馈，识别紧急问题')
 await form.getByRole('textbox',{name:'计划名称',exact:true}).fill('本人改过的名称')
 await form.getByRole('textbox',{name:'工作目标',exact:true}).fill('补充后的目标')
 await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'继续设置',exact:true}).click()
 form=page.getByRole('dialog')
 assert.equal(await form.getByRole('textbox',{name:'计划名称',exact:true}).inputValue(),'本人改过的名称')
 assert.equal(await form.getByRole('textbox',{name:'工作目标',exact:true}).inputValue(),'补充后的目标')
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.creates),[])
 await page.keyboard.press('Escape')
 await page.getByRole('button',{name:'执行记录',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'持续工作目标'}).count(),0)
})


test('可排序名录的详情、单聊、电话与工作入口始终引用原对象',async t=>{
 const page=await mount(t,'staff')
 const rows=page.getByRole('table').locator('tbody tr')
 assert.equal(await rows.count(),2)
 await page.getByRole('combobox',{name:'排序',exact:true}).selectOption('duty')
 await page.getByRole('button',{name:'安全员工 核对资料',exact:true}).click()
 await page.getByRole('button',{name:'安全员工 · 找它说话',exact:true}).click()
 await page.getByRole('button',{name:'安全员工 · 语音通话',exact:true}).click()
 await page.getByRole('button',{name:'原始任务',exact:true}).click()
 const actual=await page.evaluate(()=>(window as any).planFixture)
 assert.deepEqual(actual.selected,['22222222-2222-4222-8222-222222222222'])
 assert.deepEqual(actual.contacts,[['chat','22222222-2222-4222-8222-222222222222'],['phone','22222222-2222-4222-8222-222222222222']])
 assert.deepEqual(actual.tasks,['original-task'])
})


test('会话来源计划在原详情提供回链，读取失败可重试且不新建或保存计划',async t=>{
 const page=await mount(t,'origin')
 const detail=page.getByRole('dialog',{name:'原暂停计划',exact:true})
 await detail.locator('summary').filter({hasText:'更多信息'}).click()
 const origin=detail.getByRole('button',{name:'打开原会话',exact:true})
 await origin.waitFor();assert.equal(await origin.innerText(),'会话中创建')
 await origin.click()
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.conversations),['original-plan-session'])
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.creates),[])
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.updates),[])
 const failed=await mount(t,'origin-error')
 await failed.getByRole('dialog',{name:'原暂停计划',exact:true}).locator('summary').filter({hasText:'更多信息'}).click()
 await failed.getByRole('button',{name:'打开原会话',exact:true}).click()
 await failed.getByRole('alert').waitFor()
 assert.equal(await failed.getByRole('dialog',{name:'原暂停计划',exact:true}).count(),1,'原会话读取失败不能关闭计划详情')
 await failed.getByRole('button',{name:'打开原会话',exact:true}).click()
 assert.deepEqual(await failed.evaluate(()=>(window as any).planFixture.conversations),['original-plan-session','original-plan-session'])
 assert.deepEqual(await failed.evaluate(()=>(window as any).planFixture.creates),[])
})


test('本人计划在原目录和详情显示通用Agent，暂停配置不跳员工或旧表单',async t=>{
 const page=await mount(t,'owner')
 const drawer=page.getByRole('dialog',{name:'原暂停计划',exact:true})
 await drawer.waitFor()
 const owner=drawer.locator('header').filter({hasText:'通用 Agent'}).first()
 assert.match(await owner.innerText(),/通用 Agent/)
 assert.doesNotMatch(await owner.innerText(),/负责员工|未指派/)
 assert.equal(await drawer.getByRole('button',{name:'通用 Agent',exact:true}).count(),0)
 await drawer.getByRole('button',{name:'修改计划配置',exact:true}).click()
 await drawer.getByRole('textbox',{name:'工作目标',exact:true}).fill('本人原计划的未提交修改')
 await drawer.getByRole('button',{name:'收起配置',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.contacts),[])
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.updates),[])
 assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.creates),[])
})

test('真实业务观察计划仅显示有效事件触发，暂停状态优先且关闭不写入',async t=>{
 const page=await mount(t,'event-plan')
 const drawer=page.getByRole('dialog',{name:'原暂停计划',exact:true});await drawer.waitFor()
 await drawer.getByText('长期工作已暂停',{exact:true}).waitFor()
 const body=await page.locator('body').innerText()
 assert.ok(body.includes('业务记录更新'));assert.ok(!body.includes('09:00'));assert.ok(!body.includes('正在接收触发'))
 assert.equal(await page.getByRole('button',{name:'立即触发一次',exact:true}).count(),0)
 await page.keyboard.press('Escape');await drawer.waitFor({state:'hidden'})
 const rows=await page.locator('body').innerText();assert.ok(rows.includes('业务记录更新'));assert.ok(!rows.includes('09:00'))
 const calls=await page.evaluate(()=>(window as any).planFixture);assert.deepEqual(calls.creates,[]);assert.deepEqual(calls.updates,[])
})


test('本人入口的未提交计划在关闭与刷新后恢复原字段，不创建或执行',async t=>{
 const page=await mount(t,'journal');await startGoal(page,'agent-business 持续核对测试资料')
 const form=page.getByRole('dialog',{name:'新建持续计划',exact:true})
 await form.getByLabel('计划名称',{exact:true}).fill('agent-business 刷新保留计划')
 await form.getByRole('combobox',{name:/^负责员工/}).selectOption('22222222-2222-4222-8222-222222222222')
 await form.getByRole('combobox',{name:'通知策略',exact:true}).selectOption('failure')
 await form.getByRole('button',{name:'关闭并保留草稿',exact:true}).click()
 await page.reload();await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await startGoal(page,'agent-business 持续核对测试资料')
 assert.equal(await form.getByLabel('计划名称',{exact:true}).inputValue(),'agent-business 刷新保留计划')
 assert.equal(await form.getByRole('combobox',{name:/^负责员工/}).inputValue(),'22222222-2222-4222-8222-222222222222')
 assert.equal(await form.getByRole('combobox',{name:'通知策略',exact:true}).inputValue(),'failure')
 const calls=await page.evaluate(()=>(window as any).planFixture);assert.deepEqual(calls.creates,[]);assert.deepEqual(calls.updates,[]);assert.deepEqual(calls.tasks,[])
})


test('浏览器存储不足时明确提示未持久化且关闭重开仍保留本窗口输入',async t=>{
 const page=await mount(t,'journal-quota');await startGoal(page)
 const form=page.getByRole('dialog',{name:'新建持续计划',exact:true});await form.getByLabel('计划名称',{exact:true}).fill('存储不足时不要丢这份输入')
 assert.match(await form.getByRole('alert').innerText(),/草稿未能保存到浏览器/)
 await form.getByRole('button',{name:'关闭并保留草稿',exact:true}).click();await page.getByRole('button',{name:'继续设置',exact:true}).click()
 assert.equal(await form.getByLabel('计划名称',{exact:true}).inputValue(),'存储不足时不要丢这份输入');assert.deepEqual(await page.evaluate(()=>(window as any).planFixture.creates),[])
})

test('原计划提交结果待核对时恢复输入不会另发创建或更新',async t=>{
 const page=await mount(t,'journal-pending');await startGoal(page)
 const form=page.getByRole('dialog',{name:'新建持续计划',exact:true});await form.getByLabel('计划名称',{exact:true}).fill('不得重复创建')
 await form.getByRole('combobox',{name:/^负责员工/}).selectOption('22222222-2222-4222-8222-222222222222');await form.getByRole('combobox',{name:'通知策略',exact:true}).selectOption('failure')
 assert.equal(await form.getByRole('button',{name:'保存暂停计划',exact:true}).isDisabled(),true)
 await form.locator('form').evaluate((node:HTMLFormElement)=>node.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})))
 const calls=await page.evaluate(()=>(window as any).planFixture);assert.deepEqual(calls.creates,[]);assert.deepEqual(calls.updates,[]);assert.deepEqual(calls.tasks,[])
})
