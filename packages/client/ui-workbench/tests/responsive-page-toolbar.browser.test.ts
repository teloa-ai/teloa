import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import ts from 'typescript'
import {build} from 'vite'
// @ts-expect-error 复用项目的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const preview=process.env.TELOA_UI_TOOLBAR_PREVIEW_DIR,capture=process.env.TELOA_UI_SCREENSHOT_DIR
type Kind='automation'|'market'
const bundles=new Map<Kind,{script:string;styles:string}>()
let browser:any,temp:string

// 复用现有真实页面与 API 夹具，仅增加长内容、记录和数量；不在夹具里重画产品布局。
async function fixture(kind:Kind){
 const name=kind==='automation'?'continuous-create.browser.test.ts':'market-primary.browser.test.ts'
 const source=await readFile(new URL(name,import.meta.url),'utf8'),ast=ts.createSourceFile(name,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let entry:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='entry')entry=node.initializer;ts.forEachChild(node,visit)};visit(ast);assert.ok(entry)
 let code=new Function('root','client','fixtures','return '+entry.getText(ast))(root,client,fileURLToPath(new URL('./market-catalog-fixture.ts',import.meta.url))) as string
 const replace=(from:string,to:string)=>{assert.equal(code.split(from).length,2,'真实页面夹具锚点已改变：'+from);code=code.replace(from,to)}
 const config="const responsive=new URLSearchParams(location.search),responsiveSize=Number(responsive.get('font')||14),responsiveTheme=responsive.get('theme')==='dark'?'dark':'light';\n"
 if(kind==='automation'){
  replace("useState({size:14,theme:'light'})","useState({size:responsiveSize,theme:responsiveTheme})")
  replace('Array.from({length:1000}','Array.from({length:Number(responsive.get(\'count\')||1000)}')
  replace("title:'核对计划 '+i","title:'核对计划 '+i+' · 跨区域客户反馈与安全告警的持续复核及每日交付'")
  replace("'安全员工'","'T1 跨区域安全运营分析工程师与持续复核负责人'")
  replace('directory:async()=>({items:[],cursor:null})',"directory:async()=>({items:plans.slice(0,60).map((p,i)=>({claimId:'77777777-7777-4777-8777-'+String(i).padStart(12,'0'),planId:p.id,occurrenceId:'daily:'+stamp,planVersion:1,configVersion:1,notificationPolicy:'attention',scheduledAt:stamp,claimedAt:stamp,task:{id:'88888888-8888-4888-8888-'+String(i).padStart(12,'0'),state:'running'},run:{id:'99999999-9999-4999-8999-'+String(i).padStart(12,'0'),state:'active',sessionId:'native-'+i,createdAt:stamp}})),cursor:null})")
 }else{
  replace("active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}","active:{colorScheme:responsiveTheme,tokens:{}},fontSizes:{text:responsiveSize}")
  replace('const api={',"catalog.push(...Array.from({length:120},(_,i)=>{const original=responsiveConnector(),title={'zh-CN':'跨区域文档应用 '+i+' · 来源核对与协作',en:'Document app '+i};return wrap({...original,id:'teloa.connector.responsive-'+i,connector:{...original.connector,title}})}));const api={")
  replace('marketCatalogApi={api}', 'marketCatalogApi={api} managedMcpConnectionApi={{list:async()=>[]}}')
  code="import {connectorEntry as responsiveConnector} from '"+fileURLToPath(new URL('./market-navigation-fixture.ts',import.meta.url))+"';\n"+code
 }
 return config+code
}

const hostStyles='*{box-sizing:border-box}html,body{margin:0;height:100%}body{font-family:var(--teloa-design-font,system-ui);font-size:var(--teloa-font-body);line-height:var(--teloa-leading-body);background:var(--teloa-background)}#root{width:100%;max-width:100%;height:100dvh;min-width:0;margin-inline:auto}'
function html(kind:Kind){return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Teloa · '+(kind==='automation'?'自动化':'市场')+'响应式验收</title><style>'+hostStyles+'</style><link rel="stylesheet" href="'+kind+'.css"></head><body><div id="root"></div><script>window.planMode="many";const width=Number(new URLSearchParams(location.search).get("width"));if(width>0)document.getElementById("root").style.width=width+"px";</script><script src="'+kind+'.js"></script></body></html>'}

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-responsive-toolbar-'))
 for(const kind of ['automation','market'] as const){
  const entry=join(temp,kind+'.tsx');await writeFile(entry,await fixture(kind))
  const built=await build({configFile:false,root,logLevel:'silent',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry,name:'ResponsiveToolbar',formats:['iife']},rollupOptions:{external:(id:string)=>id.startsWith('node:')}}})
  const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
  const data={script:bundle.output.find(item=>item.type==='chunk')!.code,styles:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')};bundles.set(kind,data)
  if(preview){await mkdir(preview,{recursive:true});await writeFile(join(preview,kind+'.html'),html(kind));await writeFile(join(preview,kind+'.js'),data.script);await writeFile(join(preview,kind+'.css'),data.styles)}
 }
 if(capture)await mkdir(capture,{recursive:true})
 browser=await loadPlaywright().chromium.launch(launchOptions())
},{timeout:120000})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

const sizes=[{viewport:2560,width:2560},{viewport:1440,width:1440},{viewport:1024,width:1024},{viewport:768,width:768},{viewport:390,width:390},{viewport:320,width:320},{viewport:2560,width:420},{viewport:2560,width:720}]
async function mount(t:any,kind:Kind,size:typeof sizes[number],font:number,theme:string,count=1000){
 const page=await browser.newPage({viewport:{width:size.viewport,height:960}}),errors:string[]=[],data=bundles.get(kind)!
 page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>{const path=new URL(route.request().url()).pathname;return path.endsWith('.html')?route.fulfill({contentType:'text/html',body:html(kind)}):path.endsWith('.js')?route.fulfill({contentType:'text/javascript',body:data.script}):path.endsWith('.css')?route.fulfill({contentType:'text/css',body:data.styles}):route.abort()})
 await page.goto('http://fixture.invalid/'+kind+'.html?width='+size.width+'&font='+font+'&theme='+theme+'&count='+count)
 return page
}
async function fits(page:any,label:string){
 const result=await page.evaluate(()=>{const root=document.getElementById('root')!;return {page:document.documentElement.scrollWidth,viewport:innerWidth,content:root.scrollWidth,width:root.clientWidth}})
 assert.ok(result.page<=result.viewport+1&&result.content<=result.width+1,label+' 不应横向溢出：'+JSON.stringify(result))
}
async function automationAlignment(page:any,label:string){
 const positions=await page.evaluate(()=>{const page=document.querySelector('[data-continuous-mode]')!,title=page.querySelector(':scope>header h1')!,tab=page.querySelector(':scope>nav button')!,search=page.querySelector('input')!.closest('label')!;return [title,tab,search].map(node=>node.getBoundingClientRect().left)})
 assert.ok(Math.max(...positions)-Math.min(...positions)<2,label+' 标题、页签和搜索应共用左边线：'+positions)
 await fits(page,label)
 const density=await page.locator('[data-continuous-mode] [data-teloa-field-shell]').first().evaluate((node:Element)=>({height:node.getBoundingClientRect().height,line:Number.parseFloat(getComputedStyle(node.querySelector('input')!).lineHeight)}))
 assert.ok(density.height<=Math.max(density.line+22,44),label+' 搜索控件在保留窄窗口44px目标后不应重复叠加内边距：'+JSON.stringify(density))
}

for(const theme of ['light','dark'])for(const font of [14,28]){
 test('自动化计划与执行记录：版心、窄容器、长内容与大字号 '+theme+' '+font,{timeout:120000},async t=>{
  for(const size of sizes){
   const label=JSON.stringify({theme,font,...size}),page=await mount(t,'automation',size,font,theme)
   await page.locator('[data-teloa-entry]').first().waitFor();await automationAlignment(page,label)
   assert.equal(await page.locator('[data-teloa-entry]').count(),50,'千项计划保持分批展示')
   const query=page.getByRole('textbox',{name:'搜索计划、执行或对象',exact:true})
   const field=await query.evaluate((node:Element)=>node.closest('label')!.getBoundingClientRect().toJSON()),filter=await page.getByRole('button',{name:'筛选计划',exact:true}).boundingBox()
   assert.ok(filter&&Math.abs(field.y+field.height/2-filter.y-filter.height/2)<2,label+' 筛选入口应留在搜索框旁')
   await query.fill('核对计划 999');await page.waitForFunction(()=>document.querySelectorAll('[data-teloa-entry]').length===1)
   assert.match(await page.locator('[data-teloa-entry]').innerText(),/核对计划 999/,'搜索覆盖未加载到首批的计划')
   await automationAlignment(page,label+' 搜索末项')
   await query.fill('');await page.waitForFunction(()=>document.querySelectorAll('[data-teloa-entry]').length===50)
   if(capture&&[390,1440].includes(size.width))await page.screenshot({path:join(capture,'automation-'+size.width+'-'+theme+'-'+font+'.png')})
   await page.getByRole('button',{name:'执行记录',exact:true}).click();await page.locator('[data-teloa-claim]').first().waitFor();await automationAlignment(page,label+' 执行记录')
   const records=await page.locator('[data-teloa-claim]').evaluateAll((nodes:Element[])=>nodes.slice(0,3).map(node=>({width:node.clientWidth,content:node.scrollWidth})))
   assert.ok(records.every((row:{width:number;content:number})=>row.content<=row.width+1),'长执行记录应在卡片内回流')
   await page.close()
  }
 })
 test('市场应用：搜索与操作同排、容器回流、分类和菜单可达 '+theme+' '+font,{timeout:120000},async t=>{
  for(const size of sizes){
   const label=JSON.stringify({theme,font,...size}),page=await mount(t,'market',size,font,theme)
   await page.getByRole('button',{name:'AI 员工',exact:true}).click()
   const card=page.locator('button[class*="gridCard"]').first();await card.waitFor()
   const before=await card.boundingBox();await card.hover()
   const tile=await card.evaluate((node:Element)=>{const parent=node.parentElement!,box=node.getBoundingClientRect(),p=parent.getBoundingClientRect();return {bottom:box.bottom,parentBottom:p.bottom,empty:Array.from(parent.querySelectorAll(':scope>[class*="rowAfter"]:empty')).map(el=>el.getBoundingClientRect().height),radius:getComputedStyle(node).borderBottomLeftRadius}})
   assert.ok(tile.empty.every((height:number)=>height===0),'空的卡片补充区不能占用页脚高度')
   assert.ok(Math.abs(tile.bottom-tile.parentBottom)<2,'没有补充操作的卡片悬浮背景应延伸到底部')
   assert.notEqual(tile.radius,'0px');const after=await card.boundingBox();assert.deepEqual({width:after.width,height:after.height},{width:before.width,height:before.height},'悬浮不能改变卡片尺寸')
   const actions=await page.getByRole('button',{name:'我的应用与技能',exact:true}).evaluate((node:Element)=>Array.from(node.parentElement!.children).map(el=>el.getBoundingClientRect().toJSON()))
   if(Math.abs(actions[1].y-actions[2].y)<10)assert.ok(actions[2].x-actions[1].right<=24,label+' 市场页头操作应成组靠右，不能被弹性空白拉散')
   await page.getByRole('button',{name:'应用',exact:true}).click()
   const apps=page.getByRole('region',{name:'应用',exact:true}),search=apps.getByRole('searchbox'),mine=apps.getByRole('button',{name:/^我的应用 \d+$/})
   await search.waitFor();await fits(page,label)
   const categories=await page.getByRole('navigation',{name:'市场分类',exact:true}).getByRole('button').evaluateAll((nodes:Element[])=>nodes.map(node=>({width:node.clientWidth,text:node.scrollWidth})))
   assert.ok(categories.every((row:{width:number;text:number})=>row.text<=row.width+1),label+' 分类文字不能溢出被压缩的按钮')
   const field=await search.evaluate((node:Element)=>({height:node.parentElement!.getBoundingClientRect().height,line:Number.parseFloat(getComputedStyle(node).lineHeight)}))
   assert.ok(field.height<=field.line+22,label+' 应用搜索不应重复叠加内边距')
   if(size.width>=1440||size.width>=720&&font===14){const a=await search.boundingBox(),b=await mine.boundingBox();assert.ok(a&&b&&Math.abs(a.y+a.height/2-b.y-b.height/2)<2,label+' 搜索与我的应用应处于同一工具行')}
   await search.press('Tab');assert.equal(await mine.evaluate((node:Element)=>document.activeElement===node),true,'搜索之后应直接到我的应用')
   // summary 的文字来自可访问标签，实际 DOM 以 summary 定位。
   const summary=apps.locator('summary[aria-label="添加应用或技能"]');assert.equal(await summary.count(),1)
   await summary.click()
   const menu=await apps.locator('details[open]>div').boundingBox(),bounds=await apps.boundingBox()
   assert.ok(menu&&bounds&&menu.x>=bounds.x-1&&menu.x+menu.width<=bounds.x+bounds.width+1,label+' 添加菜单应留在目录边界内')
   await summary.press('Escape');await apps.locator('details[open]').waitFor({state:'detached'})
   await summary.press('Enter');await apps.locator('details[open]>div>button').first().press('Escape');await apps.locator('details[open]').waitFor({state:'detached'})
   assert.equal(await summary.evaluate((node:Element)=>document.activeElement===node),true,'从菜单选项按 Escape 后回到触发器')
   const create=page.locator('summary[aria-label="创建或导入"]');await create.click()
   const createMenu=await page.locator('details[open]>div').boundingBox(),area=await page.locator('#root').boundingBox()
   assert.ok(createMenu&&area&&createMenu.x>=area.x-1&&createMenu.x+createMenu.width<=area.x+area.width+1,label+' 页头创建菜单也应在内容区内')
   await create.press('Escape');await page.locator('details[open]').waitFor({state:'detached'})
   if(capture&&[390,1440].includes(size.width))await page.screenshot({path:join(capture,'market-apps-'+size.width+'-'+theme+'-'+font+'.png')})
   await search.fill('跨区域文档应用 119');await page.getByText('跨区域文档应用 119 · 来源核对与协作',{exact:true}).waitFor();await fits(page,label+' 搜索末项')
   await mine.click();assert.equal(await search.inputValue(),'跨区域文档应用 119')
   assert.deepEqual(await page.evaluate(()=>{const f=(window as any).marketPrimaryFixture;return [f.addRoles.length,f.added.length,f.forced]}),[0,0,0],'搜索、分类与菜单开关不应添加内容')
   await page.close()
  }
 })
}

test('自动化空目录与单条目录在窄屏和宽屏保持创建入口可达',{timeout:60000},async t=>{
 for(const count of [0,1])for(const size of [sizes[0]!,sizes[5]!]){
  const page=await mount(t,'automation',size,28,'dark',count)
  const create=page.getByRole('button',{name:'新建自动化',exact:true});await create.waitFor();await fits(page,'目录数量 '+count)
  const box=await create.boundingBox(),area=await page.locator('#root').boundingBox();assert.ok(box&&area&&box.x>=area.x&&box.x+box.width<=area.x+area.width+1)
  await create.click();await page.getByRole('textbox',{name:'持续工作目标',exact:true}).waitFor()
  assert.deepEqual(await page.evaluate(()=>{const f=(window as any).planFixture;return [f.creates,f.updates,f.conversations]}),[[],[],[]],'打开创建抽屉不创建或执行自动化')
  await page.keyboard.press('Escape');await page.getByRole('textbox',{name:'持续工作目标',exact:true}).waitFor({state:'hidden'})
  await page.close()
 }
})

test('原生下拉框保留键盘选择，箭头预留空间并支持系统高对比度',{timeout:60000},async t=>{
 for(const theme of ['light','dark'])for(const font of [14,28]){
  const page=await mount(t,'automation',sizes[3]!,font,theme,0)
  await page.getByRole('button',{name:'新建自动化',exact:true}).click()
  await page.getByRole('textbox',{name:'持续工作目标',exact:true}).fill('核对每周客户反馈')
  await page.locator('dialog[open] button[type=submit]').click()
  const select=page.locator('dialog[open] select').first();await select.waitFor()
  const style=await select.evaluate((node:Element)=>{const s=getComputedStyle(node);return {appearance:s.appearance,padding:Number.parseFloat(s.paddingInlineEnd),image:s.backgroundImage}})
  assert.equal(style.appearance,'none');assert.ok(style.padding>=40,'箭头与文字之间应留出空间');assert.match(style.image,/svg/)
  await select.focus();await select.press('s');assert.equal(await select.inputValue(),'sales','键盘输入仍可定位原生选项')
  await page.emulateMedia({forcedColors:'active'})
  assert.equal(await select.evaluate((node:Element)=>getComputedStyle(node).appearance),'auto','高对比度使用系统箭头')
  assert.deepEqual(await page.evaluate(()=>{const f=(window as any).planFixture;return [f.creates,f.updates]}),[[],[]])
  await page.close()
 }
})
