import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),fixtures=fileURLToPath(new URL('./market-catalog-fixture.ts',import.meta.url))
let browser:any,temp:string,script:string,styles:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {MarketPage} from '${client}MarketPage.tsx';import {ThemePresenter} from '${client}theme-presenter.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {roleEntry,catalogEntry,solutionEntry,modelEntry} from '${fixtures}';import {sandboxMarket} from '${client}market-preview.ts';
new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},fixture={addRoles:[],added:[],forced:0};window.marketPrimaryFixture=fixture;
const artifact={files:[{path:'role.json',sha256:'a'.repeat(64),size:1}],treeHash:'b'.repeat(64)};
const wrap=(entry,contents)=>({entry,artifact:entry.kind==='model'?null:artifact,addedContentId:null,addedRoleId:null,secretGroup:null,...(contents?{contents}:{})});
const roles=Array.from({length:8},(_,i)=>wrap({...roleEntry(),id:'teloa.role.role-'+i,role:{...roleEntry().role,roleId:'role-'+i,title:{'zh-CN':'研究员工 '+i,en:'Research employee '+i},definition:{...roleEntry().role.definition,name:'研究员工 '+i}}}));
const solution=wrap(solutionEntry(),{role:1,skill:2,plan:1});const {solution:boardDefinition,...boardBase}=solutionEntry();const dashboard=wrap({...boardBase,id:'teloa.test-dashboard',kind:'dashboard',dashboard:{...boardDefinition,packageId:'test-dashboard',title:{'zh-CN':'产品交付看板',en:'Product delivery dashboard'}}},{'business-configuration':1});const catalog=[...roles,solution,dashboard,wrap(catalogEntry()),wrap(modelEntry())];
const api={list:async({marketplace}={})=>({catalogVersion:'fixture-1',items:marketplace&&marketplace!=='teloa'?[]:catalog,nextCursor:null,counts:{solution:1,dashboard:1,role:8,skill:1,connector:0,model:1},skipped:{unknownKind:0,newerApp:0}}),ranking:async()=>new Map(),addRole:async(id,version)=>{fixture.addRoles.push({id,version});return {roleId:'11111111-1111-4111-8111-111111111111',status:'created'}},rolePackage:async()=>({packageId:'test-sol',packageVersion:'1.0.0',manifest:{format:'teloa.business-package/v3',id:'test-sol-role-0',title:'研究员工 0',version:'1.0.0',domain:'general',scope:'general',description:'研究员工。',resources:[{id:'role-0',kind:'role',title:'研究员工 0',version:'1.0.0',required:true,source:{kind:'local',path:'roles/role-0.json'}},{id:'tool-a',kind:'skill',title:'Tool A',version:'1.0.0',required:true,source:{kind:'local',path:'skills/tool-a/SKILL.md'}},{id:'profile',kind:'knowledge',title:'原始 PROFILE',version:'1.0.0',required:true,source:{kind:'local',path:'references/PROFILE.md'}}],relations:[{kind:'role-skill',from:'role-0',to:'tool-a'},{kind:'role-knowledge',from:'role-0',to:'profile'}],entrypoints:[]}}),add:async id=>{fixture.added.push(id);return {contentId:'22222222-2222-4222-8222-222222222222'}},solutionPackage:async()=>{if(fixture.teamPackage)return {manifest:fixture.teamPackage,readOnlyResources:[]};throw Error('fixture source unavailable')}};
const skills={list:async()=>({items:[],usages:[]}),pending:()=>undefined};
function App(){const [state,setState]=React.useState(sandboxMarket()),[selected,setSelected]=React.useState(null),[intent,setIntent]=React.useState(null),[forced,setForced]=React.useState(),[mountKey,setMountKey]=React.useState(0),[handled,setHandled]=React.useState(0);window.remountCurrentMarket=()=>setMountKey(value=>value+1);window.remountForcedMarketCategory=category=>{fixture.restoredNavigation={category:'home',query:'旧市场搜索',selectedId:undefined,mobileLayer:'category'};setForced({category,serial:++fixture.forced});setMountKey(value=>value+1)};window.restoreMarketNavigation=category=>{fixture.restoredNavigation={category,query:'notes',selectedId:undefined,mobileLayer:'category'};setForced({category:'home',serial:0});setMountKey(value=>value+1)};window.repeatForcedMarketCategory=()=>setForced(current=>({...current}));window.openSavedMarketItem=id=>setSelected(id);window.addSingleEmployeeItem=name=>setState(current=>{const base=current.items.find(item=>item.id==='bundle-security'),manifest=JSON.parse(JSON.stringify(base.manifest)),roles=manifest.resources.filter(row=>row.kind==='role'),dropped=new Set(roles.slice(1).map(row=>row.id));roles[0].title=name;delete roles[0].localized;manifest.resources=manifest.resources.filter(row=>!dropped.has(row.id));manifest.relations=manifest.relations.filter(row=>!dropped.has(row.from)&&!dropped.has(row.to));manifest.entrypoints=manifest.entrypoints.filter(row=>!dropped.has(row));return {...current,items:[...current.items,{...base,id:'local-single-employee',title:name,manifest}]}});window.forceMarketCategory=category=>setForced({category,serial:++fixture.forced});return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[]}><MarketPage key={mountKey} navigationState={fixture.restoredNavigation} visible state={state} change={setState} itemId={selected} intentId={intent} open={(id,intent)=>{setSelected(id??null);setIntent(intent??null)}} seed={null} clearSeed={()=>{}} forceCategory={forced&&forced.serial>handled?forced:undefined} onForceCategoryHandled={serial=>{fixture.handled=(fixture.handled??[]).concat(serial);setHandled(serial)}} onNavigationChange={next=>fixture.restoredNavigation=next} marketCatalogApi={api} installations={{visible:false,selected:null,open:id=>fixture.installationSelection=id,market:()=>{}}} skillInstallApi={skills} marketPluginInstallApi={{pending:()=>undefined}} industryLoads={{loads:[],error:undefined,save:async()=>{},recover:async()=>{}}} industryReview={{loads:[],upgrade:async()=>{},rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:()=>{}}} saveResolved={()=>{}} spaces={[]} targets={[]} planFromTemplate={()=>{}} manageIndustryLoad={()=>{}} update={()=>{}} prepare={async()=>{}} capabilities={()=>{}} nativeSettings={()=>{}} nativeModels={()=>{}} openRole={()=>{}} configureBinding={()=>{}} openTarget={()=>{}} githubSourceApi={{pending:()=>undefined,recoveryMessage:()=>undefined}}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-market-primary-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketPrimaryFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])});await page.route('**/*',(route:any)=>route.abort());await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-caption:12px;--teloa-font-control:13px;--teloa-font-body:14px;--teloa-font-page:24px;--teloa-font-detail:18px;--teloa-font-section:18px;--teloa-leading-heading:1.4;--teloa-leading-label:1.5;--teloa-weight-medium:500;--teloa-weight-heading:600;--teloa-text:#242624;--teloa-muted:#6c7068;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-hover:#eeeeea;--teloa-border:#e2e3de;--teloa-accent:#a34026;--teloa-on-accent:#fff;--teloa-focus:#a34026;--teloa-design-r1:6px;--teloa-design-r2:8px;--teloa-design-r3:10px;--teloa-design-round:999px}body{font:14px system-ui;margin:0}*{box-sizing:border-box}'+styles});await page.addScriptTag({content:script});await page.getByRole('navigation',{name:'市场分类'}).waitFor();return page
}

test('真实市场首页即「AI 员工」：横向工作领域、分区卡片，用途筛选与窄窗口仍可用',async t=>{
 const page=await mount(t);const nav=page.getByRole('navigation',{name:'市场分类'});assert.deepEqual(await nav.getByRole('button').allInnerTexts(),['全部','AI 员工','AI 团队','应用','技能']);assert.equal(await nav.getByRole('button',{name:'AI 员工',exact:true}).getAttribute('aria-current'),'page')
 await page.locator('[data-catalog-row="teloa.role.role-0"]').waitFor()
 const first=page.locator('ul').filter({has:page.locator('[data-catalog-row="teloa.role.role-0"]')}).first(),columns=await first.evaluate((el:HTMLElement)=>getComputedStyle(el).gridTemplateColumns.split(' ').length)
 // 1.0 紧凑卡：白底描边（设计稿 10），不再是灰底
 assert.equal(columns,4);assert.equal(await first.locator('button').first().evaluate((el:HTMLElement)=>getComputedStyle(el).backgroundColor),'rgb(255, 255, 255)');if(process.env.TELOA_MARKET_CAPTURE)await page.screenshot({path:join(process.env.TELOA_MARKET_CAPTURE,'market-b-employees.png'),fullPage:true})
 // 单员工模板与员工同一目录；工作领域在搜索上方横排，不占侧栏。
 // 1.0（设计稿 10）：搜索框在左、用途分类在同一行右侧，搜索框不超过 360px
 const purpose=page.getByRole('group',{name:'用途分类'}),purposeBox=await purpose.boundingBox(),search=page.getByRole('textbox',{name:'搜索市场'}),searchBox=await search.boundingBox();assert.ok(purposeBox&&searchBox&&Math.abs(purposeBox.y+purposeBox.height/2-(searchBox.y+searchBox.height/2))<24&&purposeBox.x>searchBox.x+searchBox.width&&searchBox.width<=360)
 assert.equal(await search.getAttribute('placeholder'),'搜索员工、团队或想完成的工作');assert.equal(await page.getByText('高级资源',{exact:true}).count(),0);assert.equal(await page.getByText('更多筛选',{exact:true}).count(),0)
 // 分区先列四项，查看全部仍使用同一领域筛选，原条目没有丢失。
 await page.getByRole('button',{name:'查看全部',exact:true}).click();assert.equal(await page.locator('[data-catalog-row="teloa.office"]').count(),1)
 await purpose.getByRole('button',{name:'办公与文档',exact:true}).click();assert.equal(await page.locator('[data-catalog-row^="teloa.role.role-"]').count(),8);await purpose.getByRole('button',{name:'全部',exact:true}).click();assert.equal(await page.locator('[data-catalog-row^="teloa.role.role-"]').count(),4)
 await page.setViewportSize({width:900,height:900});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
})

test('团队推荐不补个人旧模板，原团队详情按深链可读；应用分类页签可达',async t=>{
 const page=await mount(t);await page.getByRole('navigation',{name:'市场分类'}).getByRole('button',{name:'AI 团队',exact:true}).click()
 const security=page.locator('[data-teloa-entry="bundle-security"]');assert.equal(await security.count(),0)
 assert.equal(await page.locator('[data-catalog-row="teloa.office"]').count(),0);assert.equal(await page.locator('[data-catalog-row^="teloa.role.role-"]').count(),0);assert.equal(await page.locator('[data-teloa-entry="bundle-general"]').count(),0)
 if(process.env.TELOA_MARKET_CAPTURE)await page.screenshot({path:join(process.env.TELOA_MARKET_CAPTURE,'market-b-teams.png'),fullPage:true})
 // 团队详情按实际组成显示：两位员工各自成卡，不是静态文案
 await page.evaluate(()=> (window as any).openSavedMarketItem('bundle-security'));const dialog=page.getByRole('dialog');await dialog.waitFor();assert.match(await dialog.innerText(),/安全行业模板/);assert.match(await dialog.innerText(),/2 位员工[\s\S]*SOC 调查岗[\s\S]*AppSec 审计岗/);await page.keyboard.press('Escape');assert.equal(await dialog.count(),0)
 await page.getByRole('navigation',{name:'市场分类'}).getByRole('button',{name:'应用',exact:true}).click();await page.getByRole('searchbox',{name:'在应用和技能中搜索'}).waitFor();assert.equal(await page.getByRole('searchbox',{name:'在应用和技能中搜索'}).getAttribute('placeholder'),'在应用和技能中搜索');await page.getByRole('button',{name:/内部沟通稿.*起草周报/}).waitFor();assert.equal(await page.getByRole('navigation',{name:'市场分类'}).getByRole('button',{name:'应用',exact:true}).getAttribute('aria-current'),'page','应用视图保留市场分类且应用页签选中');assert.equal(await page.getByRole('heading',{name:'市场',exact:true}).count(),1);assert.equal(await page.getByRole('heading',{name:'应用',exact:true}).count(),1,'应用目录标题只给读屏');const appRow=page.locator('section[aria-labelledby="market-apps-title"] li').filter({hasText:'内部沟通稿'}),main=appRow.locator('button').first();assert.equal(await main.evaluate((el:HTMLElement)=>getComputedStyle(el).borderTopWidth),'0px','应用名称保持无框轻行');assert.equal(await main.evaluate((el:HTMLElement)=>getComputedStyle(el).justifyContent),'flex-start','名称左对齐，不被市场通用按钮覆盖');assert.equal(await appRow.locator('button').nth(1).evaluate((el:HTMLElement)=>getComputedStyle(el).borderRadius),'999px','操作使用轻量胶囊');assert.equal(await page.locator('[data-catalog-row^="teloa.role.role-"]').count(),0)
})

test('行业看板可从 AI 团队目录和用途筛选进入原详情，关闭仍回到团队目录',async t=>{
 const page=await mount(t)
 const board=page.locator('[data-catalog-row="teloa.test-dashboard"]')
 assert.equal(await board.count(),0,'员工目录不混入看板')
 await page.getByRole('navigation',{name:'市场分类'}).getByRole('button',{name:'AI 团队',exact:true}).click()
 await board.waitFor();assert.match(await board.innerText(),/产品交付看板/)
 await page.getByRole('group',{name:'用途分类'}).getByRole('button',{name:'办公与文档',exact:true}).click()
 await board.waitFor();await board.click()
 const dialog=page.getByRole('dialog');await dialog.waitFor()
 assert.match(await dialog.innerText(),/产品交付看板/)
 assert.equal(await dialog.getByText('看板',{exact:true}).count(),1,'仍清楚标明原资源类型')
 assert.deepEqual(await page.evaluate(()=>(window as any).marketPrimaryFixture.added),[],'浏览详情不自动添加')
 await page.keyboard.press('Escape');await board.waitFor()
 assert.equal(await page.getByRole('navigation',{name:'市场分类'}).getByRole('button',{name:'AI 团队',exact:true}).getAttribute('aria-current'),'page')
})

test('模板详情清楚分组，原 addRole 固定版本回执保持；关闭保留查询与回焦',async t=>{
 const page=await mount(t);await page.getByRole('button',{name:'AI 员工',exact:true}).click();const search=page.getByRole('textbox',{name:'搜索市场'});await search.fill('研究员工 0');const card=page.locator('[data-catalog-row="teloa.role.role-0"]');await card.waitFor();const before=await card.boundingBox();await card.click();const dialog=page.getByRole('dialog');await dialog.waitFor();await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.deepEqual(await card.boundingBox(),before,'详情打开后原列表的布局位置保持')
 await dialog.getByRole('tab',{name:'默认方法',exact:true}).click();assert.match(await dialog.innerText(),/tool-a/);if(process.env.TELOA_MARKET_CAPTURE)await page.screenshot({path:join(process.env.TELOA_MARKET_CAPTURE,'n10-market-implemented-detail.png'),fullPage:true})
 await dialog.getByRole('tab',{name:'可选例行',exact:true}).click();assert.match(await dialog.innerText(),/没有预设例行任务。添加不会启用计划。/)
 const source=dialog.locator('details').filter({hasText:'来源与许可'});await source.locator('summary').click();await source.getByText('目录版本 fixture-1',{exact:true}).waitFor()
 // 「创建为员工」先就地列出组成，不发添加；取消不添加，确认才按固定版本添加一次
 const addRoles=()=>page.evaluate(()=>(window as any).marketPrimaryFixture.addRoles)
 await dialog.getByRole('button',{name:'创建为员工',exact:true}).click();const plan=dialog.getByRole('region',{name:'添加后你会得到',exact:true});await plan.waitFor()
 assert.match(await plan.innerText(),/Tool A/);assert.match(await plan.innerText(),/原始 PROFILE/);assert.match(await plan.innerText(),/不添加同团队其他员工/);assert.match(await plan.innerText(),/保持暂停/);assert.deepEqual(await addRoles(),[])
 await plan.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await plan.count(),0);assert.deepEqual(await addRoles(),[])
 await dialog.getByRole('button',{name:'创建为员工',exact:true}).click();await plan.waitFor();await plan.getByRole('button',{name:'确认添加',exact:true}).click()
 await dialog.getByText('已创建，默认暂停',{exact:true}).waitFor();assert.deepEqual(await addRoles(),[{id:'teloa.role.role-0',version:'1.0.0'}])
 await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);assert.equal(await search.inputValue(),'研究员工 0');assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('data-catalog-row')),'teloa.role.role-0')
})

test('首页退出技术资源导航，原对象深链保留；应用搜索与详情关闭保持上下文',async t=>{
 const page=await mount(t);await page.getByRole('navigation',{name:'市场分类'}).getByRole('button',{name:'AI 员工',exact:true}).click();assert.equal(await page.locator('[data-teloa-entry]').filter({hasText:'设计审阅岗位'}).count(),0,'包内角色不重复占员工卡');assert.equal(await page.locator('[data-teloa-entry="bundle-design"]').count(),0);await page.evaluate(()=>(window as any).openSavedMarketItem('bundle-design'));await page.getByRole('dialog').waitFor();assert.match(await page.getByRole('dialog').innerText(),/设计行业模板/);await page.keyboard.press('Escape');assert.equal(await page.getByText('高级资源',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'应用',exact:true}).count(),1,'同页只有一个应用目录入口');await page.evaluate(()=>(window as any).forceMarketCategory('skill'));await page.locator('[data-catalog-row="anthropic.internal-comms"]').waitFor();assert.match(await page.locator('body').innerText(),/支持手动调用的技能安装后可用 \/ 引用/)
 await page.evaluate(()=>(window as any).forceMarketCategory('model'));await page.locator('[data-catalog-row="teloa.model.test-model"]').waitFor();await page.getByRole('button',{name:'应用',exact:true}).click();const search=page.getByRole('searchbox',{name:'在应用和技能中搜索'});await search.focus();assert.equal(await search.evaluate((el:HTMLElement)=>getComputedStyle(el).outlineStyle),'none');await search.fill('内部沟通稿');const skill=page.getByRole('button',{name:/内部沟通稿.*起草周报/});await skill.click();const detail=page.getByRole('dialog');await detail.waitFor();assert.match(await detail.innerText(),/技能[\s\S]*内部沟通稿/);await page.keyboard.press('Escape');assert.equal(await detail.count(),0);assert.equal(await search.inputValue(),'内部沟通稿');await page.evaluate(()=>(window as any).forceMarketCategory('model'));assert.match(await page.locator('[data-catalog-row="teloa.model.test-model"]').innerText(),/测试模型/)
})

test('真实市场关闭导入窗口保留原粘贴和文件，重开不恢复就绪预览',async t=>{
 const page=await mount(t)
 const open=async()=>{await page.locator('summary[aria-label="创建或导入"]').click();await page.getByRole('button',{name:'导入模板',exact:true}).click();await page.getByRole('dialog',{name:'导入模板',exact:true}).waitFor()}
 await open();const dialog=page.getByRole('dialog',{name:'导入模板',exact:true});await dialog.getByRole('button',{name:'粘贴',exact:true}).click();await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill('原件输入尚未确认');await page.mouse.click(5,5);assert.equal(await dialog.count(),0);await open();assert.equal(await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).inputValue(),'原件输入尚未确认');assert.equal(await dialog.getByRole('region',{name:'模板预览',exact:true}).count(),0)
 await dialog.getByRole('button',{name:'文件',exact:true}).click();await dialog.getByLabel('模板文件',{exact:true}).setInputFiles({name:'原模板.json',mimeType:'application/json',buffer:Buffer.from('{}')});await page.keyboard.press('Escape');await open();await dialog.getByText('已选择：原模板.json',{exact:true}).waitFor()
})


test('返回沿用轻量图标，真实市场父级样式不把它撑成描边文字按钮；点击后恢复原目录',async t=>{
 const page=await mount(t),search=page.getByRole('textbox',{name:'搜索市场'})
 const assertBack=async(name:string)=>{
  const dialog=page.getByRole('dialog'),back=dialog.getByRole('button',{name,exact:true});await back.waitFor()
  const title=await dialog.locator(':scope > header h2').textContent();assert.equal(await dialog.getByRole('heading',{name:title!,exact:true}).count(),1,'抽屉只显示一次对象标题')
  assert.equal(await back.getAttribute('title'),name)
  assert.equal(await back.textContent(),'','导航不占用一行文字按钮')
  const shape=await back.evaluate((el:HTMLElement)=>{const css=getComputedStyle(el),box=el.getBoundingClientRect();return {width:box.width,height:box.height,border:css.borderTopWidth,bg:css.backgroundColor}})
  assert.equal(shape.width,32);assert.equal(shape.height,32);assert.equal(shape.border,'0px');assert.equal(shape.bg,'rgba(0, 0, 0, 0)')
  const titleBox=await dialog.locator(':scope > header h2').boundingBox(),backBox=await back.boundingBox();assert.ok(titleBox&&backBox&&Math.abs(backBox.x-titleBox.x)<=24,'短内容详情不缩到抽屉中间 '+JSON.stringify({titleBox,backBox}))
  await back.press('Enter');assert.equal(await dialog.count(),0)
 }
 await search.fill('办公');await page.locator('[data-catalog-row="teloa.office"]').click();await assertBack('回到市场');assert.equal(await search.inputValue(),'办公')
 await page.evaluate(()=>(window as any).openSavedMarketItem('bundle-security'));await assertBack('回到市场');assert.equal(await search.inputValue(),'办公')
})

// N33：「添加后你会得到」分组的标题与数量离边框至少 16px；成员横向头像加可伸缩姓名，长英文名不被 64px 竖排挤成多行；
// 本机单员工与官方多员工团队、宽窄窗口都检查，切到技能与依据资料分组也检查；只读隔离夹具，不写真实数据。
async function youGetFacts(page:any){
 return page.evaluate(()=>{
  const groups=[...document.querySelectorAll('[class*="youGet"] h3')].filter(h3=>(h3 as HTMLElement).offsetParent!==null).map(h3=>{
   const box=(h3.closest('[class*="youGet"]>div')??h3.parentElement!) as HTMLElement,frame=box.getBoundingClientRect(),title=h3.getBoundingClientRect(),count=(h3.querySelector('[class*="solutionGroupCount"]') as HTMLElement).getBoundingClientRect(),style=getComputedStyle(box)
   return {title:(h3.firstChild?.textContent??'').trim(),count:(h3.querySelector('[class*="solutionGroupCount"]') as HTMLElement).innerText.trim(),left:title.left-frame.left,top:title.top-frame.top,right:frame.right-count.right,overflow:box.scrollWidth-box.clientWidth,border:style.borderTopWidth+'|'+getComputedStyle(box.parentElement!).borderTopWidth}
  })
  const members=[...document.querySelectorAll('[class*="memberCards"]>span')].filter(span=>(span as HTMLElement).offsetParent!==null).map(span=>{const name=span.querySelector('strong') as HTMLElement,line=parseFloat(getComputedStyle(name).lineHeight)||16;return {name:name.innerText.trim(),width:name.getBoundingClientRect().width,lines:Math.round(name.getBoundingClientRect().height/line),avatarLeftOfName:(span.firstElementChild as HTMLElement).getBoundingClientRect().right<=name.getBoundingClientRect().left+1}})
  return {groups,members,pageOverflow:document.documentElement.scrollWidth-innerWidth}
 })
}
function assertGroups(facts:any,label:string){
 assert.ok(facts.groups.length>0,label+'：应显示组成分组')
 for(const group of facts.groups){
  assert.ok(group.left>=16,label+' '+group.title+'：标题距左边框 '+group.left)
  assert.ok(group.top>=16,label+' '+group.title+'：标题距上边框 '+group.top)
  assert.ok(group.right>=16,label+' '+group.title+'：数量距右边框 '+group.right)
  assert.ok(group.overflow<=0,label+' '+group.title+'：分组内容不横向溢出')
 }
 assert.ok(facts.pageOverflow<=0,label+'：页面不横向溢出')
}
const teamPackage=(name:string)=>({format:'teloa.business-package/v3',id:'test-team',title:'Launch team',version:'1.0.0',domain:'general',scope:'general',description:'A small launch team.',resources:[{id:'lead',kind:'role',title:name+' Lead',version:'1.0.0',required:true,source:{kind:'local',path:'roles/lead.json'}},{id:'writer',kind:'role',title:'研究员工',version:'1.0.0',required:true,source:{kind:'local',path:'roles/writer.json'}},{id:'reviewer',kind:'role',title:'Customer Interview Reviewer',version:'1.0.0',required:true,source:{kind:'local',path:'roles/reviewer.json'}},{id:'tool-a',kind:'skill',title:'Tool A',version:'1.0.0',required:true,source:{kind:'local',path:'skills/tool-a/SKILL.md'}},{id:'profile',kind:'knowledge',title:'原始 PROFILE',version:'1.0.0',required:true,source:{kind:'local',path:'references/PROFILE.md'}}],relations:[{kind:'role-skill',from:'lead',to:'tool-a'},{kind:'role-knowledge',from:'lead',to:'profile'}],entrypoints:[]})
const longName='Product Idea Stress Test'
function assertMembers(facts:any,names:readonly string[],maxLines:number,label:string){
 assert.deepEqual(facts.members.map((member:any)=>member.name),names,label+'：原姓名与顺序不变')
 for(const member of facts.members){if(member.name.length>8)assert.ok(member.width>64,label+' '+member.name+'：长姓名使用足够宽度 '+member.width);assert.ok(member.lines<=maxLines,label+' '+member.name+'：不被挤成多行 '+member.lines);assert.ok(member.avatarLeftOfName,label+' '+member.name+'：头像在姓名左侧横排')}
}
for(const width of [1280,390]){
 test(width+' 添加后你会得到（本机单员工）：分组留白、横向长名，切换技能与依据资料仍留白',async t=>{
  const page=await mount(t);await page.setViewportSize({width,height:1000})
  await page.evaluate((value:string)=>(window as any).addSingleEmployeeItem(value),longName);await page.evaluate(()=>(window as any).openSavedMarketItem('local-single-employee'))
  await page.getByRole('tab',{name:'AI 员工',exact:true}).waitFor()
  let facts=await youGetFacts(page);assertGroups(facts,'本机/AI 员工')
  assert.deepEqual(facts.groups.map((group:any)=>[group.title,group.count]),[['AI 员工','1 位员工']],'原分组身份与数量不变')
  assertMembers(facts,[longName],width<500?2:1,'本机')
  for(const tab of ['技能','依据资料']){await page.getByRole('tab',{name:tab,exact:true}).click();facts=await youGetFacts(page);assertGroups(facts,'本机/'+tab);assert.deepEqual(facts.groups.map((group:any)=>group.title),[tab])}
 })
 test(width+' 添加后你会得到（官方多员工团队）：分组留白、成员横向且长名不被竖排',async t=>{
  const page=await mount(t);await page.setViewportSize({width,height:1000})
  await page.evaluate((value:any)=>{(window as any).marketPrimaryFixture.teamPackage=value},teamPackage(longName))
  await page.getByRole('button',{name:'查看全部',exact:true}).click();await page.locator('[data-catalog-row="teloa.office"]').click();await page.locator('[class*="memberCards"]').first().waitFor()
  const facts=await youGetFacts(page);assertGroups(facts,'官方团队')
  assert.deepEqual(facts.groups.map((group:any)=>group.title),['AI 员工','技能','依据资料']);assert.equal(facts.groups[0].count,'3 位员工')
  assertMembers(facts,[longName+' Lead','研究员工','Customer Interview Reviewer'],2,'官方团队')
 })
}

// 应用入口必须打开真实安装目录，不能将员工模板导入伪装成自定义应用配置。
test('应用安装记录进入应用目录身份，不打开员工模板导入',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).forceMarketCategory('apps'))
 const apps=page.getByRole('region',{name:'应用',exact:true});await apps.waitFor()
 assert.equal(await apps.getByText('添加自定义连接或导入包',{exact:true}).count(),0)
 assert.equal(await apps.getByText('你的扩展',{exact:true}).count(),0)
 const records=apps.getByRole('button',{name:'应用安装记录',exact:true});await records.click()
 assert.equal(await page.evaluate(()=>(window as any).marketPrimaryFixture.installationSelection),'plugin:directory')
 assert.equal(await page.getByRole('dialog',{name:'导入模板',exact:true}).count(),0)
})


test('旧扩展深链进入统一应用，不再打开独立扩展目录',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).forceMarketCategory('plugin'))
 await page.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true}).waitFor()
 assert.equal(await page.getByRole('heading',{name:'扩展',exact:true}).count(),0)
 assert.equal(await page.getByText('官方扩展',{exact:true}).count(),0)
})


test('业务连接重挂载时首次应用导航覆盖旧市场类别，同serial重渲染保留应用草稿',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).remountForcedMarketCategory('apps'))
 const search=page.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true})
 await search.waitFor();assert.equal(await search.inputValue(),'')
 assert.equal(await page.getByRole('navigation',{name:'市场分类',exact:true}).getByRole('button',{name:'应用',exact:true}).getAttribute('aria-current'),'page')
 await search.fill('meeting-summary')
 await page.evaluate(()=>(window as any).repeatForcedMarketCategory())
 assert.equal(await search.inputValue(),'meeting-summary','相同导航请求不清空已输入的应用搜索')
})


test('默认home serial0不覆盖冷启动恢复的应用目录与搜索',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).restoreMarketNavigation('apps'))
 const search=page.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true})
 await search.waitFor();assert.equal(await search.inputValue(),'notes')
 assert.equal(await page.getByRole('navigation',{name:'市场分类',exact:true}).getByRole('button',{name:'应用',exact:true}).getAttribute('aria-current'),'page')
})


test('已消费的应用请求跨真实key重挂不重复清掉后续搜索草稿',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).forceMarketCategory('apps'))
 const search=page.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true})
 await search.waitFor();await search.fill('原技能搜索草稿')
 await page.evaluate(()=>(window as any).remountCurrentMarket())
 await search.waitFor();assert.equal(await search.inputValue(),'原技能搜索草稿')
 assert.deepEqual(await page.evaluate(()=>(window as any).marketPrimaryFixture.handled),[1],'原请求只确认消费一次')
})
