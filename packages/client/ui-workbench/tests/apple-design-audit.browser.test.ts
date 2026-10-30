import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdir,readFile,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用工作树内的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string
const capture=process.env.TELOA_UI_AUDIT_CAPTURE
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {TaskForm,TaskPage} from '${client}TaskPage.tsx';import {ProjectForm} from '${client}ProjectForm.tsx';import {RoleForm} from '${client}TeamPage.tsx';
import {ToolbarIconButton} from '${client}ToolbarIconButton.tsx';import {Plus,ChevronRight} from 'lucide-react';
import {WorkbenchNavigationItems,WorkbenchHubNavigation} from '${client}WorkbenchNavigationChrome.tsx';
import {ThemePresenter} from '${client}theme-presenter.ts';import tokens from '${client}theme-tokens.module.css';import frame from '${client}WorkbenchFrame.module.css';
import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {emptyTaskPreview,changeTaskPreview} from '${client}task-preview.ts';
const noop=()=>{},stamp='2026-10-30T02:00:00Z',snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};
const runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
const theme=new ThemePresenter();const appearance=(size=14,scheme='light')=>theme.apply({active:{colorScheme:scheme,tokens:{}},fontSizes:{text:size,code:13,terminal:13},fontFamilies:{text:'',code:'',terminal:''}});appearance();
const f=window.audit={appearance,saves:[],behavior:'success',release:noop,open:noop};
const first=changeTaskPreview(emptyTaskPreview(),{type:'create',id:'task-1',title:'核对本次交付资料与来源',goal:'对照原件核对来源，保留未确认项',scope:'general',now:stamp});
const base=changeTaskPreview(first,{type:'create',id:'task-2',title:'整理下一轮交付计划',goal:'列出负责人和待确认项',scope:'general',now:stamp});
const work={readHomeSkills:async()=>[]},resourceApi={directory:async()=>({resources:[]}),sources:async()=>[]};
function App(){
 const [open,setOpen]=useState(null);f.open=setOpen;
 const save=async fields=>{f.saves.push(fields);if(f.behavior==='fail')throw Object.assign(Error(),{code:'teloa/source-unavailable'});if(f.behavior==='pending')await new Promise(resolve=>{f.release=resolve});setOpen(null)};
 return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[{scope:'general',title:'通用工作',kind:'custom'}]}><div className={tokens.tokens+' '+frame.frame}>
  <aside className={frame.navigation}><WorkbenchNavigationItems view="tasks" onSelect={noop}/></aside>
  <div className={frame.workspace}>
   <header className={frame.topbar}><nav className={frame.crumbs} aria-label="当前位置"><button className={frame.crumb}>工作台</button><ChevronRight size={12} aria-hidden/><button className={frame.crumb} aria-current="page"><strong>任务与交付资料核对</strong></button></nav><div className={frame.toolbar}><ToolbarIconButton label="添加工作" icon={Plus} onClick={()=>setOpen('task')}/></div></header>
   <main id="teloa-main" className={frame.main} tabIndex={-1}>
    <WorkbenchHubNavigation view="tasks" onSelect={noop}/>
    <div className="fixture-actions"><button id="task-entry" onClick={()=>setOpen('task')}>打开任务表单</button><button id="project-entry" onClick={()=>setOpen('project')}>打开项目表单</button><button id="role-entry" onClick={()=>setOpen('role')}>打开员工表单</button></div>
    <TaskPage visible autoFocus={false} mode="tasks" state={base} selected={null} select={id=>{f.selected=id}} change={noop} switchMode={noop} conversations={()=>null} openArtifacts={noop} openPlans={noop} attentionItems={[]} openAttention={noop} openSource={noop} team={noop} openRole={noop} openBusiness={noop} saveTemplate={noop}/>
   </main>
  </div>
  {open==='task'&&<TaskForm persistent close={()=>setOpen(null)} save={save}/>}
  {open==='project'&&<ProjectForm initial={{title:'',goal:'',scope:'general',state:'planned',dueDate:null}} scopeName="通用工作" close={()=>setOpen(null)} save={save}/>}
  {open==='role'&&<RoleForm work={work} resourceApi={resourceApi} close={()=>setOpen(null)} save={save}/>}
 </div></BusinessScopeProvider></I18nProvider>
}
createRoot(document.getElementById('root')).render(<App/>);`

before(async()=>{
 const virtual=join(root,'__apple_design_audit.tsx')
 const built=await build({configFile:false,root,logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'apple-design-audit',resolveId:id=>id.endsWith('apple-design-audit')?virtual:null,load:id=>id===virtual?entry:null}],build:{write:false,minify:false,lib:{entry:'apple-design-audit',name:'AppleDesignAudit',formats:['iife']},rollupOptions:{external:(id:string)=>id.startsWith('node:')}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(row=>row.type==='chunk')!.code
 styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
 if(capture)await mkdir(capture,{recursive:true})
})
after(async()=>{await browser?.close()})

async function mount(t:any,width=1440,touch=false){
 const context=await browser.newContext({viewport:{width,height:960},hasTouch:touch}),page=await context.newPage(),errors:string[]=[],requests:string[]=[]
 t.after(async()=>{await context.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'验收不得访问服务、真实实例或模型')})
 page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 const url='http://teloa-ui-audit.test/'
 await page.route('**/*',(route:any)=>{
  if(route.request().url()===url)return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Teloa 设计验收</title><style>body{margin:0}*{box-sizing:border-box}.fixture-actions{display:flex;flex-wrap:wrap;gap:8px;padding:12px}.fixture-actions button{font:inherit;min-height:44px}</style></head><body><div id="root"></div></body></html>'})
  requests.push(route.request().url());return route.abort()
 })
 await page.goto(url)
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.locator('#task-entry').waitFor().catch((error:unknown)=>{t.diagnostic(JSON.stringify({errors}));throw error})
 return page
}
async function assertNoOverflow(page:any){
 const result=await page.evaluate(()=>({page:document.documentElement.scrollWidth<=innerWidth,dialogs:Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).every(node=>node.scrollWidth<=node.clientWidth+1&&node.getBoundingClientRect().left>=0&&node.getBoundingClientRect().right<=innerWidth+1)}))
 assert.deepEqual(result,{page:true,dialogs:true})
}

test('任务表单：空白就地反馈、隐藏缺项定位、失败保留输入、在途去重及焦点返回',async t=>{
 const page=await mount(t),open=page.locator('#task-entry');await open.click()
 const dialog=page.getByRole('dialog'),goal=dialog.locator('textarea'),submit=dialog.locator('button[type=submit]')
 await submit.click();assert.equal(await goal.getAttribute('aria-invalid'),'true');assert.equal(await goal.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 const errorId=await goal.getAttribute('aria-describedby');assert.equal(await page.locator(`[id="${errorId}"]`).innerText(),'请填写工作目标。');assert.equal(await page.evaluate(()=>(window as any).audit.saves.length),0)
 if(capture)await page.screenshot({path:join(capture,'task-required-feedback.png')})
 await goal.fill('核对本次交付资料，列明来源与未确认项。');assert.equal(await goal.getAttribute('aria-invalid'),null)
 const options=dialog.locator('details');await options.locator('summary').click();const title=dialog.locator('input[required]');await title.fill('   ');await options.locator('summary').click();await submit.click()
 assert.equal(await options.evaluate((node:HTMLDetailsElement)=>node.open),true);assert.equal(await title.evaluate((node:HTMLElement)=>node===document.activeElement),true);assert.equal(await title.getAttribute('aria-invalid'),'true')
 await title.fill('交付资料核对');await page.evaluate(()=>(window as any).audit.behavior='fail');await submit.click();await dialog.getByRole('alert').waitFor()
 assert.equal(await goal.inputValue(),'核对本次交付资料，列明来源与未确认项。');assert.equal(await title.inputValue(),'交付资料核对')
 await page.evaluate(()=>(window as any).audit.behavior='pending');await submit.click();await page.waitForFunction(()=>document.querySelector('form')?.getAttribute('aria-busy')==='true')
 assert.equal(await dialog.getByRole('alert').count(),0);assert.equal(await submit.isDisabled(),true);await page.keyboard.press('Escape');assert.equal(await dialog.count(),1)
 assert.equal(await page.evaluate(()=>(window as any).audit.saves.length),2)
 if(capture)await page.screenshot({path:join(capture,'task-saving-feedback.png')})
 await page.evaluate(()=>(window as any).audit.release());await dialog.waitFor({state:'hidden'});assert.equal(await open.evaluate((node:HTMLElement)=>node===document.activeElement),true)
})

test('项目表单：先说明目标、必填关联提示、自动名称和手动更名均可纠错',async t=>{
 const page=await mount(t,320,true);await page.locator('#project-entry').click()
 const dialog=page.getByRole('dialog'),goal=dialog.locator('textarea'),submit=dialog.locator('button[type=submit]')
 await submit.click();assert.equal(await goal.getAttribute('aria-invalid'),'true');assert.equal(await page.evaluate(()=>(window as any).audit.saves.length),0)
 const descriptions=(await goal.getAttribute('aria-describedby')).split(' ');assert.equal(descriptions.length,2)
 for(const id of descriptions)assert.equal(await page.locator(`[id="${id}"]`).isVisible(),true)
 await goal.fill('发布业务周报。列出本周进展与待核对项。');const title=dialog.locator('input[required]');assert.equal(await title.inputValue(),'发布业务周报。')
 await title.fill(' ');await submit.click();assert.equal(await title.getAttribute('aria-invalid'),'true');assert.equal(await title.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await title.fill('本周业务周报');await goal.fill('更新周报内容');assert.equal(await title.inputValue(),'本周业务周报');await assertNoOverflow(page)
 await dialog.locator('summary').click();const date=dialog.locator('input[type=date]');await date.fill('2026-10-31')
 await date.evaluate((node:HTMLInputElement)=>node.min='2026-11-01');await dialog.locator('summary').click();await submit.click();assert.equal(await page.evaluate(()=>(window as any).audit.saves.length),0,'产品必填校验不能绕过原生日期约束')
 assert.equal(await date.evaluate((node:HTMLInputElement)=>node.closest('details')!.open&&node===document.activeElement),true,'展开并聚焦含无效日期的可选区')
 await date.evaluate((node:HTMLInputElement)=>node.removeAttribute('min'))
 await submit.click();await dialog.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>(window as any).audit.saves[0].title),'本周业务周报')
})

test('默认字号保持原层级；本人字号和浏览器默认字体可同步放大辅助文字与标题',async t=>{
 const page=await mount(t);await page.locator('#task-entry').click();const dialog=page.getByRole('dialog')
 const sizes=()=>dialog.evaluate((node:HTMLElement)=>({input:parseFloat(getComputedStyle(node.querySelector('textarea')!).fontSize),heading:parseFloat(getComputedStyle(node.querySelector('h2')!).fontSize)}))
 assert.deepEqual(await sizes(),{input:13,heading:18})
 await page.evaluate(()=>(window as any).audit.appearance(28));assert.deepEqual(await sizes(),{input:26,heading:36})
 await page.evaluate(()=>{(window as any).audit.appearance(14);document.documentElement.style.fontSize='32px'});assert.deepEqual(await sizes(),{input:26,heading:36})
 await assertNoOverflow(page)
})

test('员工表单沿用原校验流程，错误与姓名字段关联且修正后解除',async t=>{
 const page=await mount(t,320,true);await page.locator('#role-entry').click();const dialog=page.getByRole('dialog'),name=dialog.locator('input[maxlength="80"]').first()
 await name.fill('');await dialog.locator('button[type=submit]').click();assert.equal(await name.getAttribute('aria-invalid'),'true')
 const id=await name.getAttribute('aria-describedby');assert.ok(id);assert.equal(await page.locator(`[id="${id}"]`).getAttribute('role'),'alert')
 assert.equal(await name.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await name.fill('资料核验员');assert.equal(await name.getAttribute('aria-invalid'),'false');assert.equal(await name.getAttribute('aria-describedby'),null)
 assert.equal(await page.evaluate(()=>(window as any).audit.saves.length),0)
})

test('员工创建四步在窄屏和两倍字号下均可继续与退出，不写入员工',async t=>{
 const page=await mount(t,320,true)
 for(const scheme of ['light','dark'])for(const size of [14,28]){
  await page.evaluate(({size,scheme}:any)=>(window as any).audit.appearance(size,scheme),{size,scheme});await page.locator('#role-entry').click()
  const dialog=page.getByRole('dialog'),next=dialog.locator('button[type=submit]')
  await dialog.locator('input[maxlength="80"]').first().fill('资料核验员');await assertNoOverflow(page);await next.click()
  const duty=dialog.locator('textarea[required]').first();await duty.fill('对照原件核对交付资料，列出来源与未确认项。');await assertNoOverflow(page);await next.click();await assertNoOverflow(page)
  await next.click();await assertNoOverflow(page)
  if(capture)await page.screenshot({path:join(capture,`role-review-320-${scheme}-${size}.png`)})
  await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 }
 assert.equal(await page.evaluate(()=>(window as any).audit.saves.length),0)
})

test('任务保留表格标题与列关系，方向键/Home/End/Enter 在真实任务按钮间导航',async t=>{
 const page=await mount(t),table=page.getByRole('table',{name:'任务列表'}),buttons=table.locator('button[data-teloa-task-open]')
 const focused=async(locator:any)=>page.waitForFunction((node:HTMLElement)=>node===document.activeElement,await locator.elementHandle())
 assert.equal(await buttons.count(),2);assert.equal(await page.getByRole('listbox').count(),0)
 await buttons.first().focus();await page.keyboard.press('Tab');await focused(buttons.last())
 await buttons.first().focus();await page.keyboard.press('ArrowDown');await focused(buttons.last())
 await page.keyboard.press('Home');await focused(buttons.first())
 await page.keyboard.press('End');await focused(buttons.last())
 await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>(window as any).audit.selected),await buttons.last().evaluate((node:HTMLElement)=>node.closest('tr')!.dataset.teloaEntry))
})

test('320/390/768/1440 宽度、明暗主题及两倍字号：目录和三类表单无横向溢出',async t=>{
 const page=await mount(t)
 const measurements:unknown[]=[]
 for(const width of [320,390,768,1440])for(const scheme of ['light','dark'])for(const size of [14,28]){
  await page.setViewportSize({width,height:960});await page.evaluate(({size,scheme}:any)=>(window as any).audit.appearance(size,scheme),{size,scheme})
  await assertNoOverflow(page)
  for(const kind of ['task','project','role']){
   await page.locator('#'+kind+'-entry').click();const dialog=page.getByRole('dialog');await dialog.waitFor();await assertNoOverflow(page)
   measurements.push({width,scheme,size,kind,dialog:await dialog.boundingBox()})
   if(capture&&size===14&&[320,1440].includes(width))await page.screenshot({path:join(capture,`${kind}-${width}-${scheme}.png`)})
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
  }
 }
 if(capture)await writeFile(join(capture,'layout-metrics.json'),JSON.stringify(measurements,null,2)+'\n')
})

test('触摸工具按钮、键盘焦点、减少动态效果和强制对比模式',async t=>{
 const page=await mount(t,390,true),action=page.getByRole('button',{name:'添加工作',exact:true})
 const box=await action.boundingBox();assert.ok(box.width>=44&&box.height>=44)
 await action.focus();await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab')
 assert.equal(await action.evaluate((node:HTMLElement)=>getComputedStyle(node).outlineStyle),'solid')
 await page.emulateMedia({reducedMotion:'reduce'});await page.addStyleTag({content:'#task-entry{animation:example 10s infinite;transition:opacity 2s;scroll-behavior:smooth}@keyframes example{to{opacity:.5}}'})
 const reduced=await page.locator('#task-entry').evaluate((node:HTMLElement)=>({animation:getComputedStyle(node).animationName,transition:getComputedStyle(node).transitionDuration,scroll:getComputedStyle(node).scrollBehavior}))
 assert.deepEqual(reduced,{animation:'none',transition:'0s',scroll:'auto'})
 await page.emulateMedia({forcedColors:'active'});await action.focus();assert.equal(await action.evaluate((node:HTMLElement)=>getComputedStyle(node).outlineStyle),'solid')
})

test('可选 axe 验收：真实表单及目录的可访问性规则',async t=>{
 const source=process.env.TELOA_UI_AUDIT_AXE
 if(!source){t.skip('设置 TELOA_UI_AUDIT_AXE 为本地 axe.min.js 可执行自动审查');return}
 const page=await mount(t,320,true),axe=await readFile(source,'utf8'),results:unknown[]=[]
 await page.addScriptTag({content:axe})
 for(const scheme of ['light','dark'])for(const kind of ['directory','task','project','role']){
  await page.evaluate((scheme:string)=>(window as any).audit.appearance(14,scheme),scheme)
  if(kind!=='directory')await page.locator('#'+kind+'-entry').click()
  const report=await page.evaluate(async()=>await (window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}))
  results.push({scheme,kind,violations:report.violations})
  assert.deepEqual(report.violations.map((v:any)=>({id:v.id,nodes:v.nodes.map((n:any)=>n.target)})),[],scheme+' '+kind)
  if(kind!=='directory')await page.keyboard.press('Escape')
 }
 if(capture)await writeFile(join(capture,'axe-results.json'),JSON.stringify(results,null,2)+'\n')
})
