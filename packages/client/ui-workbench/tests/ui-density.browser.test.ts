import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 工作树共用的浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
// @ts-expect-error 正式类型化看板协议夹具。
import {typedConfigurationFixture} from './fixtures/business-typed-view.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string
const capture=process.env.TELOA_UI_DENSITY_CAPTURE
const entry=`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {TaskList} from '${client}TaskList.tsx';import {StaffRoster} from '${client}StaffRoster.tsx';
import {MarketListRows} from '${client}MarketUnifiedList.tsx';import {LibraryList} from '${client}LibraryList.tsx';
import {SettingsLayout} from '${client}SettingsLayout.tsx';import {ContextDrawer} from '${client}ContextDrawer.tsx';
import {BusinessHome} from '${client}BusinessHome.tsx';import {ConversationObjectCard} from '${client}ConversationObjectCard.tsx';
import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';import {HomeNativeConversation} from '${client}HomeNativeConversation.tsx';
import {TaskForm} from '${client}TaskPage.tsx';import {ThemePresenter} from '${client}theme-presenter.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {emptyTaskPreview,changeTaskPreview} from '${client}task-preview.ts';
import tokens from '${client}theme-tokens.module.css';import pageCss from '${client}TaskPage.module.css';import rosterCss from '${client}TeamPage.module.css';
const noop=()=>{},stamp='2026-10-30T02:00:00Z',snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};
const runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
const theme=new ThemePresenter();const appearance=(size=14,scheme='light')=>theme.apply({active:{colorScheme:scheme,tokens:{}},fontSizes:{text:size,code:13,terminal:13},fontFamilies:{text:'',code:'',terminal:''}});appearance();
const long='这是一个需要完整核对来源、负责人和交付范围的长名称，用于验证大字号与窄屏上的换行效果';
const base=changeTaskPreview(emptyTaskPreview(),{type:'create',id:'seed',title:'工作',goal:'目标',scope:'general',now:stamp}).tasks[0];
const tasks=Array.from({length:1000},(_,i)=>({...base,id:'task-'+String(i).padStart(4,'0'),title:'TASK-'+String(i).padStart(4,'0')+' '+long,state:i%3?'running':'completed',updatedAt:stamp}));
const taskRows=tasks.map(task=>({task,attention:{kinds:[],reason:null},ownerName:'Alex Morgan / 区域团队负责人',scopeLabel:'通用工作',unverified:false}));
const roles=Array.from({length:300},(_,i)=>({id:'employee-'+i,name:'员工 '+String(i).padStart(3,'0')+' '+long,kind:'employee',avatarKey:'general',storage:'persistent',scopes:['general'],state:'active',duty:long,skills:[],knowledge:[],memories:[],history:[]}));
const market=Array.from({length:240},(_,i)=>({key:'market-'+i,title:'MARKET-'+i+' '+long,summary:long+long,requirements:'需要本人确认连接与访问范围。',facts:'本机验收数据',credit:'Teloa 示例团队',art:{kind:'role',seed:'market-'+i},taxonomy:{industries:[],functions:[]},mark:null,open:noop}));
const library=Array.from({length:1000},(_,i)=>({id:'resource-'+i,kind:'knowledge',title:'FILE-'+i+' '+long,location:'/长期工作资料/跨业务证据与复核/2026/October/'+long,scopeIds:['general'],version:100+i,status:'active',visitedAt:Date.parse(stamp)}));
const labels=[{scope:'general',title:'通用工作',kind:'custom',loads:0,activeLoads:0,tasks:0,groups:0},...Array.from({length:5},(_,i)=>({scope:'business-'+i,title:'业务 '+i+' '+long,kind:'custom',loads:0,activeLoads:0,tasks:0,groups:0}))];
const f=window.density={appearance,selected:null,view:'tasks',choose:noop,setView:noop,writes:[]};
const widgetProjection=${JSON.stringify(typedConfigurationFixture())};
function App(){
 const [nativeReady,setNativeReady]=useState(false);f.showNative=()=>setNativeReady(true);
 const [view,setView]=useState('tasks'),[query,setQuery]=useState(''),[selected,choose]=useState(null),[dialog,setDialog]=useState(null);
 f.choose=choose;f.setView=next=>{setView(next);setQuery('');choose(null)};f.view=view;
 const filter=items=>items.filter(row=>(row.title??row.task?.title??row.name).includes(query));
 return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={labels}><div className={tokens.tokens+' fixture'}>
  <nav aria-label="验收场景" className="fixture-nav">{['tasks','people','market','library','business','settings','widgets'].map(key=><button key={key} onClick={()=>f.setView(key)}>{key}</button>)}<button onClick={()=>setDialog('task')}>创建工作</button><button onClick={()=>setDialog('drawer')}>查看详情</button></nav>
  <main aria-label="验收工作区">
   {view==='tasks'&&<section data-density="tasks" className={pageCss.page+' '+pageCss.alignedPage+' '+pageCss.overviewPage}><header className={pageCss.pageHeader}><div><h1>任务</h1><p>1,000 项工作 · 验证长名称、检索与分批展示</p></div></header><div className={pageCss.overviewLayout}><div className={pageCss.directory}><label className="fixture-search">搜索全部任务<input aria-label="搜索全部任务" value={query} onChange={e=>setQuery(e.target.value)}/></label><TaskList rows={filter(taskRows)} filter="all" selected={selected} select={choose} stateLabel={value=>value==='completed'?'已完成':'进行中'} attentionLabel={value=>value} stamp={()=>'10/30 20:21'}/></div></div></section>}
   {view==='people'&&<section data-density="people" className={pageCss.page+' '+pageCss.alignedPage+' '+rosterCss.teamPage}><div className={rosterCss.rosterPage}><div className={rosterCss.rosterPane}><h1>员工</h1><label className="fixture-search">搜索全部员工<input aria-label="搜索全部员工" value={query} onChange={e=>setQuery(e.target.value)}/></label><StaffRoster roles={filter(roles)} labels={labels} tasks={[]} fold={{}} onFoldChange={noop} searching={!!query} onSelect={noop} onHire={noop} onTalk={noop} onPhone={noop}/></div></div></section>}
   {view==='market'&&<section data-density="market" className="fixture-content"><h1>市场</h1><MarketListRows rows={market} layout="cards"/></section>}
   {view==='library'&&<section data-density="library" className="fixture-content"><h1>资料库</h1><LibraryList rows={library} view="mine" query="" preferences={{recent:[],favorites:[]}} open={noop} favorite={noop} clear={noop} loading={false} browseAll={noop} add={noop}/></section>}
   {view==='business'&&<BusinessHome labels={labels} directory={{status:'ready',retry:noop}} roles={[]} dataSources={[]} attention={[]} tasks={[]} open={noop} openStaff={noop} connect={noop} addBusiness={noop}/>}
   {view==='settings'&&<SettingsLayout label="设置" heading="设置" entries={labels.map(row=>({id:row.scope,label:row.title,group:'日常偏好'}))} selectedId="general" onSelect={noop}><section><h2>设置与表单分组</h2><p>说明文字与正文有稳定的阅读顺序。</p>{Array.from({length:20},(_,i)=><label className="fixture-search" key={i}>字段 {i+1} · {long}<input value={long} readOnly/></label>)}</section></SettingsLayout>}
   {view==='home'&&<HomeNativeConversation home ready sessionId="home-draft" isHomeDraft={()=>true} accept={noop} acceptance={{subscribe:()=>noop,getSnapshot:()=>false}} useSession={select=>select({blank:true,promptAttempted:false,pendingSubmissions:[]})} overview={<section data-teloa-home-briefing><h2>继续工作</h2></section>} content={nativeReady?<div className="mock-native" data-phase="hero" data-conversation-region="chat"><div data-conversation-scroll className="mock-scroll"><h1>今天想完成什么？</h1><div className="mock-space"/><div data-composer-seat><div data-composer-card className="mock-card"><textarea aria-label="原生草稿"/><div className="mock-menu" style={{maxHeight:400}}><div role="listbox" aria-label="触发候选建议">{Array.from({length:40},(_,i)=><div role="option" aria-selected={i===0} key={i}>命令 {i+1}</div>)}</div></div></div></div></div></div>:<p>准备输入</p>}/>}
   {view==='widgets'&&<section className="fixture-content" data-density="widgets"><h1>业务看板</h1><BusinessConfigurationPage projection={widgetProjection} colorScheme="light" go={noop}/></section>}
  </main>
  {dialog==='task'&&<TaskForm persistent close={()=>setDialog(null)} save={value=>f.writes.push(value)}/>}
  {dialog==='drawer'&&<ContextDrawer title={'工作详情 · '+long} close={()=>setDialog(null)} padded><h3>当前工作</h3><p>{long}</p>{Array.from({length:50},(_,i)=><section key={i}><h4>记录 {i+1}</h4><p>{long+long}</p></section>)}</ContextDrawer>}
 </div></BusinessScopeProvider></I18nProvider>
}
createRoot(document.getElementById('root')).render(<App/>);`

before(async()=>{
 const virtual=join(root,'__ui_density.tsx')
 const built=await build({configFile:false,root,logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'ui-density',resolveId:id=>id.endsWith('ui-density')?virtual:null,load:id=>id===virtual?entry:null}],build:{write:false,minify:false,lib:{entry:'ui-density',name:'UIDensity',formats:['iife']},rollupOptions:{external:(id:string)=>id.startsWith('node:')}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
 if(capture)await mkdir(capture,{recursive:true})
})
after(async()=>{await browser?.close()})

async function mount(t:any,width=1440,height=960){
 const page=await browser.newPage({viewport:{width,height}}),errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));page.setDefaultTimeout(6000)
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 const url='http://teloa-density.test/'
 await page.route('**/*',(route:any)=>route.request().url()===url?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>全站密集数据验收</title><style>*{box-sizing:border-box}body{margin:0}.fixture{height:100dvh;display:flex;flex-direction:column}.fixture-nav{display:flex;flex:none;gap:8px;padding:8px;flex-wrap:wrap;border-bottom:1px solid #ddd}.fixture-nav button{font:inherit;min-height:32px}main{flex:1;min-height:0;overflow:auto}.fixture-content{padding:24px}.fixture-search{display:grid;gap:8px;margin-bottom:16px;font-size:var(--teloa-font-control)}.fixture-search input{min-width:0;max-width:100%;padding:10px;font:inherit}.mock-native{height:100%;display:flex;flex-direction:column}.mock-native[data-phase=hero] .mock-scroll{height:100%;display:flex;flex-direction:column;overflow:auto}.mock-space{flex:1}.mock-card{position:relative;height:112px;margin:16px}.mock-card textarea{width:100%;height:100%}.mock-menu{position:absolute;bottom:calc(100% + 4px);height:400px;overflow:hidden;background:var(--teloa-surface);border:1px solid var(--teloa-border);width:100%}.mock-menu [role=listbox]{height:100%;overflow:auto}.mock-menu [role=option]{padding:8px}h1{font-size:var(--teloa-font-page)}h2{font-size:var(--teloa-font-dialog)}</style></head><body><div id="root"></div></body></html>'}):(requests.push(route.request().url()),route.abort()))
 await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('heading',{name:'任务',exact:true}).waitFor()
 return page
}

test('千项目录：首批 50 项、分批展开、全量搜索以及当前对象保留',async t=>{
 const page=await mount(t)
 assert.equal(await page.locator('tr[data-teloa-entry]').count(),50)
 await page.getByRole('button',{name:'再显示 50 项',exact:true}).click();assert.equal(await page.locator('tr[data-teloa-entry]').count(),100)
 await page.getByRole('textbox',{name:'搜索全部任务',exact:true}).fill('TASK-0999')
 assert.equal(await page.locator('tr[data-teloa-entry]').count(),1);assert.match(await page.locator('table').innerText(),/TASK-0999/)
 await page.getByRole('textbox',{name:'搜索全部任务',exact:true}).fill('');assert.equal(await page.locator('tr[data-teloa-entry]').count(),50)
 await page.evaluate(()=>(window as any).density.choose('task-0999'))
 await page.locator('[data-teloa-entry="task-0999"]').waitFor()
 assert.equal(await page.locator('[data-teloa-entry="task-0999"]').count(),1)
 assert.equal(await page.locator('tr[data-teloa-entry]').count(),51)
 assert.deepEqual(await page.evaluate(()=>(window as any).density.writes),[])
})

test('员工、市场、资料都分批挂载，筛选仍查找完整数据集',async t=>{
 const page=await mount(t)
 for(const [view,selector,total] of [['people','tr[data-roster-id]',300],['market','[data-density=market] ul>li',240],['library','[data-density=library] tbody>tr',1000]] as const){
  await page.evaluate((view:string)=>(window as any).density.setView(view),view);await page.locator(selector).first().waitFor()
  assert.equal(await page.locator(selector).count(),50,view)
  assert.match(await page.locator('[data-collection-footer]').innerText(),new RegExp(total.toLocaleString('zh-CN')))
  await page.getByRole('button',{name:'再显示 50 项',exact:true}).click();assert.equal(await page.locator(selector).count(),100,view)
 }
 await page.evaluate(()=>(window as any).density.setView('people'))
 await page.getByRole('textbox',{name:'搜索全部员工',exact:true}).fill('员工 299')
 assert.equal(await page.locator('tr[data-roster-id]').count(),1)
})

test('七种工作面在 320–3840px、明暗与两倍字号下可读且无页面横向溢出',{timeout:120000},async t=>{
 const page=await mount(t),metrics:unknown[]=[]
 for(const width of [320,390,768,1280,1440,1920,2560,3840])for(const scheme of ['light','dark'])for(const size of [14,28]){
  await page.setViewportSize({width,height:width<768?844:960});await page.evaluate(({size,scheme}:{size:number;scheme:string})=>(window as any).density.appearance(size,scheme),{size,scheme})
  for(const view of ['tasks','people','market','library','business','settings','widgets']){
   await page.evaluate((view:string)=>(window as any).density.setView(view),view)
   await page.locator('main h1,main h2').first().waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
   const result=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth+1,mainOverflow:document.querySelector('main')!.scrollWidth>document.querySelector('main')!.clientWidth+1}))
   assert.deepEqual(result,{overflow:false,mainOverflow:false},JSON.stringify({width,scheme,size,view}));metrics.push({width,scheme,size,view,...result})
   if(capture&&[390,1440].includes(width)&&size===14)await page.screenshot({path:join(capture,view+'-'+width+'-'+scheme+'.png')})
  }
 }
 if(capture)await writeFile(join(capture,'density-matrix.json'),JSON.stringify(metrics,null,2)+'\n')
})

test('长抽屉和表单在矮窗、大字和窄屏下可关闭，操作可见且焦点回到入口',async t=>{
 const page=await mount(t,390,568)
 for(const size of [14,28]){
  await page.evaluate((size:number)=>(window as any).density.appearance(size,'dark'),size)
  for(const entry of ['查看详情','创建工作']){
   const trigger=page.getByRole('button',{name:entry,exact:true});await trigger.click();const dialog=page.getByRole('dialog');await dialog.waitFor()
   const bounds=await dialog.evaluate((el:HTMLElement)=>({width:el.scrollWidth<=el.clientWidth+1,left:el.getBoundingClientRect().left>=0,right:el.getBoundingClientRect().right<=innerWidth+1}))
   assert.deepEqual(bounds,{width:true,left:true,right:true},JSON.stringify({size,entry}))
   if(entry==='创建工作'){await dialog.locator('button[type=submit]').click();await dialog.getByRole('alert').waitFor();assert.deepEqual(await page.evaluate(()=>(window as any).density.writes),[])}
   await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await trigger.evaluate((el:HTMLElement)=>el===document.activeElement),true)
  }
 }
})

test('密集目录与响应式表格的 axe 规则检查',async t=>{
 const source=process.env.TELOA_UI_AUDIT_AXE;if(!source){t.skip('设置 TELOA_UI_AUDIT_AXE 后执行');return}
 const page=await mount(t,390),axe=await readFile(source,'utf8')
 await page.addScriptTag({content:axe})
 for(const view of ['tasks','people','market','library']){
  await page.evaluate((view:string)=>(window as any).density.setView(view),view)
  const report=await page.evaluate(async()=>await (window as any).axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21aa','wcag22aa']}}))
  assert.deepEqual(report.violations.map((item:any)=>({id:item.id,targets:item.nodes.map((node:any)=>node.target)})),[],view)
 }
})


test('首页保留上下顺序，迟到原生输入与候选菜单在窄窗和缩放后都留在可见工作区',async t=>{
 const page=await mount(t,390,568)
 await page.evaluate(()=>(window as any).density.setView('home'))
 await page.getByText('准备输入',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).density.showNative())
 for(const width of [320,390,1440])for(const size of [14,28]){
  await page.setViewportSize({width,height:568});await page.evaluate((size:number)=>(window as any).density.appearance(size),size)
  await page.getByRole('textbox',{name:'原生草稿',exact:true}).focus()
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  const layout=await page.locator('[data-teloa-home]').evaluate((home:HTMLElement)=>{
   const input=home.querySelector<HTMLElement>('[data-composer-card]')!.getBoundingClientRect(),brief=home.querySelector<HTMLElement>('[data-teloa-home-briefing]')!.getBoundingClientRect(),menu=home.querySelector<HTMLElement>('[role=listbox]')!.parentElement!.getBoundingClientRect(),view=home.getBoundingClientRect()
   return {scroll:getComputedStyle(home.querySelector('[data-conversation-scroll]')!).overflow,vertical:brief.top>=input.bottom-1,top:menu.top>=view.top-1,bottom:menu.bottom<=Math.min(view.bottom,innerHeight)+1}
  })
  assert.deepEqual(layout,{scroll:'visible',vertical:true,top:true,bottom:true},JSON.stringify({width,size}))
 }
})
