// @ts-expect-error 本机可信文档夹具为 MJS 模块。
import {setLocalDocument} from './fixtures/local-document.mjs'
import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {TaskDetail} from '${client}TaskDetail.tsx';import {TaskList} from '${client}TaskList.tsx';import {readTaskInputs} from '${client}task-inputs.ts';import {emptyBusinessPreview} from '${client}business-preview.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import css from '${client}TaskPage.module.css';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},at='2026-10-13T02:00:00.000Z';
const role={id:'employee-original',name:'开发验收·资料编辑已保存',kind:'employee',scopes:['general'],state:'active',version:3},task={storage:'persistent',id:'task-original',title:'核对采购资料与付款异常',goal:window.n46DetailMode?'逐字保留的原目标。'.repeat(180)+'末尾核对标记':'核对已授权记录，给出结论。',scope:'general',object:'采购',version:3,state:window.n46DetailMode==='cancelled'?'cancelled':window.n46DetailMode==='closed-review'?'completed':'waiting',need:null,request:'',authorId:'self',assigneeId:role.id,assigneeHistory:[],createdAt:at,updatedAt:at,result:'',evidence:[],history:[],supplements:[],approvalRequired:false,risk:{key:'task.approval.risk.none'},execution:'not_started',source:{groupId:'group-original',messageId:'message-original',rootId:'message-original',text:'核对原消息。'}};
if(window.taskShortcutMode){task.planSource={planId:'plan-original',runId:'run-original',planVersion:7,title:window.taskShortcutMode==='untitled'?' ':'每周采购核对'};if(window.taskShortcutMode!=='group-and-plan')delete task.source;}
const fixture={selected:[],roles:[],sources:[],plans:[],closed:0,changes:[],full:0};window.taskCompactFixture=fixture;
function App(){const noop=()=>{},[selected,select]=React.useState(task.id),[full,setFull]=React.useState(window.taskDetailContext==='full');return <I18nProvider runtime={runtime}><section className={[css.page,css.alignedPage,css.selectedPage,(window.taskDetailContext==='overview'||window.taskDetailContext==='full')&&css.overviewPage,window.taskDetailContext==='embedded'&&css.embeddedPage,full&&css.fullDetail].filter(Boolean).join(' ')} style={{height:'100vh'}}><div className={[css.layout,css.hasSelection,(window.taskDetailContext==='overview'||window.taskDetailContext==='full')&&css.overviewLayout].filter(Boolean).join(' ')}><aside className={css.directory} data-teloa-pane="directory"><TaskList rows={[task,{...task,id:'task-second',title:'另一个原任务',state:'ready'}].map(task=>({task,attention:{kinds:[],reason:null},ownerName:role.name,scopeLabel:'通用工作',unverified:false}))} filter="all" selected={selected} select={id=>{select(id);fixture.selected.push(id)}} stateLabel={state=>runtime.t('status.'+state)} attentionLabel={noop} stamp={at=>at}/></aside><TaskDetail presentation={{full,toggle:()=>{setFull(!full);fixture.full++}}} attentionNeeds={task.state==='cancelled'?[]:['review']} attention={task.state==='cancelled'?undefined:{kind:'review',reason:'execution-completed'}} attentionReason="执行已结束，结果等待核对。" securityItems={[]} securityActions={null} industrySource={null} executions={()=>null} knowledge={null} handoffs={window.n46DetailMode==='long'?<label>交接草稿<input aria-label="交接草稿" defaultValue="原交接说明"/></label>:null} handoffRows={[]} conversations={()=>window.n46DetailMode?<div style={{height:640}}>原资料内容<input aria-label="资料草稿" defaultValue="原草稿"/></div>:null} draft={readTaskInputs({},task)} patch={noop} clear={noop} review={noop} openArtifacts={noop} openPlans={target=>fixture.plans.push(target)} task={task} approvals={[]} artifacts={[]} change={value=>fixture.changes.push(value)} back={()=>fixture.closed++} backHidden={false} groups={[{id:'group-original',name:'采购核对群',scope:'general'}]} openSource={value=>fixture.sources.push(value)} roles={[role]} team={noop} openRole={id=>fixture.roles.push(id)} business={emptyBusinessPreview()} openBusiness={noop} saveTemplate={noop}/></div></section></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-task-compact-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'TaskCompactFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
 if(process.env.TELOA_UI_TOOLBAR_PREVIEW_DIR){
  const folder=process.env.TELOA_UI_TOOLBAR_PREVIEW_DIR;await mkdir(folder,{recursive:true})
  const source=await readFile(new URL(import.meta.url),'utf8'),ast=ts.createSourceFile('task.ts',source,ts.ScriptTarget.Latest,true)
  let content:ts.Expression|undefined;const visit=(node:ts.Node)=>{if(ts.isPropertyAssignment(node)&&node.name.getText(ast)==='content'&&node.initializer.getText(ast).includes('+styles'))content=node.initializer;ts.forEachChild(node,visit)};visit(ast);assert.ok(content)
  const css=new Function('styles','return '+content.getText(ast))(styles)
  await writeFile(join(folder,'task.css'),css);await writeFile(join(folder,'task.js'),script)
  await writeFile(join(folder,'task.html'),'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="task.css"></head><body><div id="root"></div><script>window.n46DetailMode="long"</script><script src="task.js"></script></body></html>')
 }
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,mode?:'long'|'cancelled'|'closed-review',shortcut?:'plan-only'|'group-and-plan'|'untitled',context?:'overview'|'embedded'|'full'){const page=await browser.newPage({viewport:{width:1400,height:900}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await setLocalDocument(page,'<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:13px;--teloa-font-control:14px;--teloa-font-body:14px;--teloa-font-page:26px;--teloa-font-list:15px;--teloa-font-section:18px;--teloa-font-detail:20px;--teloa-font-reading:14px;--teloa-leading-heading:1.5;--teloa-leading-label:1.5;--teloa-weight-medium:500;--teloa-weight-heading:600;--teloa-text:#242624;--teloa-muted:#6c7068;--teloa-background:#fff;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-border:#e2e3de;--teloa-focus:#646860;--teloa-shadow:0 4px 16px #0002}body{font:14px system-ui;margin:0}'+styles});if(mode)await page.evaluate((value:string)=>{(window as any).n46DetailMode=value},mode);if(context)await page.evaluate((value:string)=>{(window as any).taskDetailContext=value},context);if(shortcut)await page.evaluate((value:string)=>{(window as any).taskShortcutMode=value},shortcut);await page.addScriptTag({content:script});await page.getByRole('article',{name:'任务详情'}).waitFor();return page}

test('任务吸顶标题在长正文滚动后完整覆盖顶部及两侧留白',async t=>{
 for(const context of [undefined,'overview','embedded','full'] as const){
 const page=await mount(t,'long',undefined,context),detail=page.getByRole('article',{name:'任务详情'}),sticky=detail.locator(':scope>div').first()
 await detail.getByRole('button',{name:'展开全文',exact:true}).click()
 for(const width of [1400,720])for(const size of [14,28]){
  await page.setViewportSize({width,height:700})
  await page.addStyleTag({content:':root{--teloa-font-body:'+size+'px;--teloa-font-control:'+size+'px;--teloa-font-caption:'+size+'px;--teloa-font-section:'+Math.round(size*1.3)+'px} body{margin:0}'})
  for(const top of [160,480]){
   await detail.evaluate((node:HTMLElement,top:number)=>{node.scrollTop=top},top)
   assert.ok(await detail.evaluate((node:HTMLElement)=>node.scrollTop>0),'任务详情应能在自己的滚动区内阅读长正文：'+context+' '+JSON.stringify(await detail.evaluate((node:HTMLElement)=>({height:node.clientHeight,scroll:node.scrollHeight,overflow:getComputedStyle(node).overflow,flex:getComputedStyle(node).flex,parentHeight:node.parentElement!.clientHeight,parentFlex:getComputedStyle(node.parentElement!).flex}))))
   const boxes=await sticky.evaluate((node:HTMLElement)=>{const parent=node.parentElement!,a=parent.getBoundingClientRect(),b=node.getBoundingClientRect(),hit=document.elementFromPoint(a.left+a.width/2,a.top+3);return {top:a.top,header:b.top,left:a.left,headerLeft:b.left,right:a.right,headerRight:b.right,covered:!!hit&&node.contains(hit),background:getComputedStyle(node).backgroundColor}})
   assert.ok(Math.abs(boxes.header-boxes.top)<2,JSON.stringify(boxes))
   assert.ok(Math.abs(boxes.headerLeft-boxes.left)<2&&Math.abs(boxes.headerRight-boxes.right)<2,'吸顶背景应覆盖详情的左右内边距')
   assert.equal(boxes.covered,true,'顶部不能露出已经滚过的正文')
   assert.notEqual(boxes.background,'rgba(0, 0, 0, 0)')
   if(process.env.TELOA_UI_SCREENSHOT_DIR&&top===480&&context==='overview'&&size===14){await mkdir(process.env.TELOA_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.TELOA_UI_SCREENSHOT_DIR,'task-sticky-'+width+'.png')})}
  }
 }
 await page.close()
 }
})

test('任务详情工具栏同一行、长负责人不挤窄列，状态和下一步紧凑且仍归属原对象',async t=>{
 const page=await mount(t),detail=page.getByRole('article',{name:'任务详情'}),heading=detail.getByRole('heading',{name:'核对采购资料与付款异常',exact:true}),more=detail.getByRole('button',{name:'更多操作',exact:true}),back=detail.getByRole('button',{name:'返回目录',exact:true})
 const titleBox=await heading.boundingBox(),menuBox=await more.boundingBox(),backBox=await back.boundingBox();assert.ok(titleBox&&menuBox&&backBox);assert.ok(Math.abs(titleBox.y-menuBox.y)<12);assert.ok(Math.abs(titleBox.y-backBox.y)<12)
 const table=page.getByRole('table');assert.deepEqual(await table.getByRole('columnheader').allTextContents(),['任务','状态']);assert.equal(await table.getByText('开发验收·资料编辑已保存',{exact:true}).count(),2)
 assert.ok((await detail.locator('[data-teloa-status-box]').boundingBox()).height<130)
 for(const phrase of ['等待处理','核对结果','查看运行'])assert.ok((await detail.innerText()).includes(phrase),phrase)
 await detail.getByRole('button',{name:'开发验收·资料编辑已保存',exact:true}).click();await detail.getByRole('button',{name:'采购核对群',exact:true}).click()
 assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.roles),['employee-original']);assert.equal((await page.evaluate(()=>(window as any).taskCompactFixture.sources))[0].groupId,'group-original')
 assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.changes),[])
 if(process.env.TELOA_COMPACT_UI_SCREENSHOT_DIR){await mkdir(process.env.TELOA_COMPACT_UI_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:join(process.env.TELOA_COMPACT_UI_SCREENSHOT_DIR,'task-compact.png')})}
})

test('任务状态列表键盘选择、更多菜单Escape和原详情返回契约保留',async t=>{
 const page=await mount(t),detail=page.getByRole('article',{name:'任务详情'}),more=detail.getByRole('button',{name:'更多操作',exact:true})
 await page.getByRole('table',{name:'任务列表'}).getByRole('button').first().focus();await page.keyboard.press('ArrowDown');assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.selected),['task-second'])
 await more.click();await page.getByRole('menu').waitFor();await more.focus();await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0,'打开首帧焦点仍在触发器时 Escape 只关闭菜单');assert.equal(await more.evaluate((node:HTMLElement)=>node===document.activeElement),true);assert.equal(await page.evaluate(()=>(window as any).taskCompactFixture.closed),0)
 await more.click();await page.waitForFunction(()=>document.activeElement?.getAttribute('role')==='menuitem');await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0,'焦点进入菜单项后 Escape 同样只关闭菜单');assert.equal(await more.evaluate((node:HTMLElement)=>node===document.activeElement),true);assert.equal(await page.evaluate(()=>(window as any).taskCompactFixture.closed),0)
 await detail.getByRole('button',{name:'返回目录',exact:true}).click();assert.equal(await page.evaluate(()=>(window as any).taskCompactFixture.closed),1)
})


test('长目标可完整展开，宽窄布局不丢属性，取消任务只保留必要内容且原锚点可达',async t=>{
 const page=await mount(t,'long'),detail=page.getByRole('article',{name:'任务详情'}),expand=detail.getByRole('button',{name:'展开全文',exact:true})
 const before=await expand.boundingBox();assert.ok(before)
 await expand.click();assert.equal(await detail.getByRole('button',{name:'收起',exact:true}).getAttribute('aria-expanded'),'true')
 assert.ok((await detail.getByRole('button',{name:'收起',exact:true}).boundingBox()).y>before.y,'展开后完整目标占据实际可读高度')
 assert.ok((await detail.innerText()).includes('末尾核对标记'))
 await detail.getByRole('button',{name:'收起',exact:true}).click()
 await detail.locator('button[aria-pressed]').click()
 await detail.getByRole('button',{name:'更多操作',exact:true}).click();await page.getByRole('menuitem',{name:'安排接任',exact:true}).click()
 const handoff=detail.getByRole('textbox',{name:'交接草稿',exact:true});assert.equal(await handoff.isVisible(),true,'交接动作不藏在编号与配置中');await handoff.fill('本人未提交的交接说明');const config=detail.getByRole('button',{name:'任务信息',exact:true});await config.click();await config.click();assert.equal(await handoff.inputValue(),'本人未提交的交接说明');assert.equal(await handoff.isVisible(),true)
 const facts=detail.locator('dl[aria-label="任务概要"]'),goal=detail.locator('div[class*="goalLine"]')
 assert.ok((await facts.boundingBox()).y>(await goal.boundingBox()).y,'宽详情在同一阅读主栏中先目标、后属性')
 assert.equal(await detail.locator('section[aria-label="工作成果"]').count(),0,'没有已保存成果时不展示空成果卡')
 await detail.getByRole('button',{name:'任务信息',exact:true}).click()
 await detail.getByRole('textbox',{name:'资料草稿',exact:true}).fill('本人未提交的资料草稿')
 assert.equal(await handoff.inputValue(),'本人未提交的交接说明','展开同一阅读主栏中的任务资料不清交接草稿')
 await page.setViewportSize({width:720,height:900})
 assert.equal(await detail.getByRole('textbox',{name:'资料草稿',exact:true}).inputValue(),'本人未提交的资料草稿','宽窄切换不重挂载资料表单')
 assert.equal(await detail.evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth),true)
 assert.ok((await facts.boundingBox()).y>(await expand.boundingBox()).y,'窄详情属性在正文状态之后')
 const owner=detail.getByRole('button',{name:'开发验收·资料编辑已保存',exact:true})
 assert.equal(await owner.evaluate((node:HTMLElement)=>{const activity=Array.from(document.querySelectorAll('button')).find(item=>item.textContent==='活动记录');return !!activity&&!!(node.compareDocumentPosition(activity)&Node.DOCUMENT_POSITION_FOLLOWING)}),true,'属性链接在DOM与阅读顺序里都先于活动')
 await owner.focus();await page.keyboard.press('Tab');assert.equal(await detail.getByRole('button',{name:'采购核对群',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.changes),[])
 const cancelled=await mount(t,'cancelled'),closed=cancelled.getByRole('article',{name:'任务详情'})
 assert.equal(await closed.locator('[data-teloa-status-box]').count(),0,'无待办的取消任务不重复状态卡')
 assert.equal(await closed.getByRole('button',{name:'活动记录',exact:true}).getAttribute('aria-expanded'),'false')
 await closed.getByRole('button',{name:'更多操作',exact:true}).click()
 await cancelled.getByRole('menuitem',{name:'任务编号与依据',exact:true}).click()
 await closed.getByText('task-original',{exact:true}).waitFor()
 assert.equal(await closed.getByRole('button',{name:'任务信息',exact:true}).getAttribute('aria-expanded'),'true')
 assert.deepEqual(await cancelled.evaluate(()=>(window as any).taskCompactFixture.changes),[])
 const waiting=await mount(t,'closed-review'),pending=waiting.getByRole('article',{name:'任务详情'})
 assert.equal(await pending.locator('[data-teloa-status-box]').count(),1)
 assert.equal(await pending.getByRole('button',{name:'活动记录',exact:true}).getAttribute('aria-expanded'),'false','终态历史按需展开，待核对事项保持就地可达');await pending.getByRole('button',{name:'活动记录',exact:true}).click();assert.equal(await pending.getByRole('button',{name:'活动记录',exact:true}).getAttribute('aria-expanded'),'true')
})


test('计划来源只保一个可读计划入口，群来源与旧历史缺名时保留回退和原执行入口',async t=>{
 for(const mode of ['plan-only','group-and-plan','untitled'] as const){
  const page=await mount(t,undefined,mode),detail=page.getByRole('article',{name:'任务详情'}),summary=detail.locator('dl[aria-label="任务概要"]')
  if(mode==='plan-only'){await summary.getByRole('button',{name:'每周采购核对',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.plans),[{kind:'plan',id:'plan-original'}])}
  else if(mode==='group-and-plan'){await summary.getByRole('button',{name:'采购核对群',exact:true}).click();assert.equal((await page.evaluate(()=>(window as any).taskCompactFixture.sources))[0].messageId,'message-original')}
  await detail.getByRole('button',{name:'任务信息',exact:true}).click()
  const fallback=detail.getByRole('button',{name:'查看所属计划',exact:true});assert.equal(await fallback.count(),mode==='plan-only'?0:1)
  if(mode!=='plan-only')await fallback.click()
  await detail.getByRole('button',{name:'查看来源执行与工作成果',exact:true}).click()
  assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.plans),[{kind:'plan',id:'plan-original'},{kind:'run',id:'run-original'}])
  assert.match(await detail.innerText(),/配置 v7/);assert.deepEqual(await page.evaluate(()=>(window as any).taskCompactFixture.changes),[])
 }
})
