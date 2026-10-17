import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无声明的 Playwright JavaScript 夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// N13：复用 business-builder-frame 的真实 Frame/store/BindingClient/WorkNavigation 夹具；只把原生输入换成按会话保存的公开门面桩。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
let browser:any,script:string,temp:string
const patch=(source:string,from:string,to:string)=>{assert.equal(source.split(from).length,2,from);return source.replace(from,to)}
before(async()=>{
 const fixtureSource=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.ts',fixtureSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 // 两个已登记执行位置；新建会话由原生登记进所在位置（缺省为第一个），且尚未开始。
 entry=patch(entry,"workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]}]","workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]},{workspaceId:'other',title:'其他目录',path:'/other',sessionIds:[]}]")
 entry=patch(entry,"rows.set(row.sessionId,row);byId[row.sessionId]={...row,displayTitle:row.title};","rows.set(row.sessionId,row);byId[row.sessionId]={...row,displayTitle:row.title,blank:true};managementState.workspaces.find(w=>w.workspaceId===(p.workspaceId??'workspace')).sessionIds.push(row.sessionId);")
 const setup=`f.notices=[];const draftInput=id=>({state:{getSnapshot:()=>inputs.get(id)||emptyInput},setDraft:text=>{inputs.set(id,{...(inputs.get(id)||emptyInput),draft:text});f.nativeNotify()},notify:(level,text)=>f.notices.push(text)});
 f.type=value=>{inputs.set(selected,{...emptyInput,...(typeof value==='string'?{draft:value}:value)})};f.draft=id=>(inputs.get(id)||emptyInput).draft;
 if(startup.history){const row={id:crypto.randomUUID(),ownerId:'self',title:'历史会话',version:1,status:'ready',sessionId:'history',requestedSessionId:'history',requestId:crypto.randomUUID(),scopeIds:['general'],createdAt:stamp};rows.set('history',row);byId.history={...row,displayTitle:row.title,blank:false};managementState.workspaces[0].sessionIds.push('history');inputs.set('history',{...emptyInput,draft:'历史草稿'})}
 `
 // 与真实应用 observeMainSessionBinding 一致：主会话打开后绑定跟随。
 entry=patch(entry,"open:id=>{selected=id;","open:id=>{selected=id;void work.select(id);")
 entry=patch(entry,"createRoot(document.getElementById('root')).render",setup+"createRoot(document.getElementById('root')).render")
 entry=patch(entry,'<WorkbenchFrame {...props}','<WorkbenchFrame {...props} conversationDraftInput={draftInput}')
 temp=await mkdtemp(join(root,'.runtime-n13-location-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;const source=await readFile(id,'utf8');const names=[...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>m[1]);return names.map(name=>'export const '+name+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'N13Fixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output' in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function mount(t:any,startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000}});page.setDefaultTimeout(5000);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(r:any)=>r.request().isNavigationRequest()?r.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):r.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>{(window as any).frameStartup=value},startup);await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main')!==null)
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'))
 const f=(expression:string)=>page.evaluate(expression)
 const menu=async(name:string)=>{await page.getByRole('navigation',{name:'主导航'}).or(page.locator('aside')).first().getByRole('button',{name:'新建',exact:true}).click();await page.getByRole('menuitem',{name,exact:true}).click()}
 return {page,f,menu,location:()=>page.getByRole('dialog',{name:'更换执行位置'})}
}

test('N13 新建空白会话草稿：同一位置不另建，跨导航再新建回到原草稿，不提交',async t=>{
 const {page,f,menu,location}=await mount(t)
 await menu('新建工作会话');await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 const first=await f('frameFixture.current()') as string
 await f("frameFixture.type('E2E 新建会话草稿')")
 assert.equal(await f(`frameFixture.draft(${JSON.stringify(first)})`),'E2E 新建会话草稿','前置：草稿确实写在新建会话里')
 await menu('更换执行位置');await location().waitFor()
 // 默认选中当前会话所在位置（对话框在挂载后的 effect 里初始化选择）
 await page.waitForFunction(()=>document.querySelector<HTMLSelectElement>('dialog select')?.value==='workspace')
 await location().getByRole('button',{name:'使用此位置'}).click();await location().waitFor({state:'hidden'})
 assert.deepEqual(await f('[frameFixture.creates,frameFixture.current(),frameFixture.draft(frameFixture.current())]'),[1,first,'E2E 新建会话草稿'])
 // 轻窗 Esc 关闭不提交、不另建
 await menu('更换执行位置');await location().waitFor();await page.keyboard.press('Escape');await location().waitFor({state:'hidden'})
 await f("frameFixture.navigate('tasks')");await f("frameFixture.navigate('home')")
 await menu('新建工作会话');await page.waitForFunction((id:string)=>(window as any).frameFixture.state().view==='messages'&&(window as any).frameFixture.current()===id,first)
 assert.deepEqual(await f('[frameFixture.creates,frameFixture.current(),frameFixture.draft(frameFixture.current()),frameFixture.sent.length]'),[1,first,'E2E 新建会话草稿',0])
})

test('N13 主会话已切走后再新建，重开原空白会话而非另建',async t=>{
 const {page,f,menu}=await mount(t,{history:true})
 await menu('新建工作会话');await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 const first=await f('frameFixture.current()') as string
 await f("frameFixture.type('切走前的草稿')")
 await f("frameFixture.select('history')");await f("frameFixture.navigate('home')")
 await menu('新建工作会话');await page.waitForFunction((id:string)=>(window as any).frameFixture.current()===id,first)
 assert.deepEqual(await f('[frameFixture.creates,frameFixture.draft(frameFixture.current()),frameFixture.draft("history")]'),[1,'切走前的草稿','历史草稿'])
})

test('N13 改到另一执行位置：新会话带上纯文本草稿且不发送，原空白会话清空',async t=>{
 const {page,f,menu,location}=await mount(t)
 await menu('新建工作会话');await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 const first=await f('frameFixture.current()') as string
 await f("frameFixture.type('换位置的草稿')")
 await menu('更换执行位置');await location().waitFor()
 await location().locator('select').selectOption('other');await location().getByRole('button',{name:'使用此位置'}).click();await location().waitFor({state:'hidden'})
 await page.waitForFunction(()=>(window as any).frameFixture.creates===2)
 const second=await f('frameFixture.current()') as string
 assert.notEqual(second,first)
 assert.deepEqual(await f(`[frameFixture.draft(${JSON.stringify(second)}),frameFixture.draft(${JSON.stringify(first)}),frameFixture.rows().find(r=>r.sessionId===${JSON.stringify(second)}).requestedWorkspaceId,frameFixture.sent.length]`),['换位置的草稿','','other',0])
 // 再次新建回到改位置后的空白会话
 await f("frameFixture.navigate('tasks')");await f("frameFixture.navigate('home')")
 await menu('新建工作会话');await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 assert.deepEqual(await f('[frameFixture.creates,frameFixture.current(),frameFixture.draft(frameFixture.current())]'),[2,second,'换位置的草稿'])
})

test('N13 含引用或附件的草稿不做有损迁移：不另建、原草稿保留并说明',async t=>{
 const {page,f,menu,location}=await mount(t)
 await menu('新建工作会话');await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 const first=await f('frameFixture.current()') as string
 await f("frameFixture.type({draft:'看 /资料 ',occurrences:[{occurrenceId:1,source:'teloa-resources',ref:'r1',offset:2,length:3,label:'资料',clipboardText:'/资料'}],attachmentIds:['file-1']})")
 await menu('更换执行位置');await location().waitFor()
 await location().locator('select').selectOption('other');await location().getByRole('button',{name:'使用此位置'}).click()
 await location().getByRole('alert').filter({hasText:'原草稿已保留'}).waitFor()
 assert.deepEqual(await f('[frameFixture.creates,frameFixture.current(),frameFixture.draft(frameFixture.current())]'),[1,first,'看 /资料 '])
 await page.keyboard.press('Escape');await location().waitFor({state:'hidden'})
 assert.equal(await f('frameFixture.creates'),1)
})

test('N13 已有历史的会话更换执行位置：另建新会话，历史草稿、位置与归属不变',async t=>{
 const {page,f,menu,location}=await mount(t,{history:true,sessionId:'history'})
 await page.waitForFunction(()=>(window as any).frameFixture.current()==='history')
 await menu('更换执行位置');await location().waitFor()
 await location().locator('select').selectOption('other');await location().getByRole('button',{name:'使用此位置'}).click();await location().waitFor({state:'hidden'})
 await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 const created=await f('frameFixture.current()') as string
 assert.notEqual(created,'history')
 assert.deepEqual(await f(`[frameFixture.draft('history'),frameFixture.draft(${JSON.stringify(created)}),frameFixture.rows().find(r=>r.sessionId==='history').requestedWorkspaceId,frameFixture.sent.length]`),['历史草稿','',undefined,0])
})

test('N13 改位置创建期间离开：迟到的新会话不打开、不接替记忆，原草稿仍在原空白会话',async t=>{
 const {page,f,menu,location}=await mount(t)
 await menu('新建工作会话');await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 const first=await f('frameFixture.current()') as string
 await f("frameFixture.type('挂起期间的草稿')")
 await menu('更换执行位置');await location().waitFor()
 await f('frameFixture.holdCreate=true')
 await location().locator('select').selectOption('other');await location().getByRole('button',{name:'使用此位置'}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.creates===2)
 await f("frameFixture.navigate('tasks')");await f('frameFixture.releaseCreate()')
 await page.waitForFunction(()=>(window as any).frameFixture.rows().length===2);await page.waitForTimeout(100)
 assert.deepEqual(await f(`[frameFixture.current(),frameFixture.draft(${JSON.stringify(first)}),frameFixture.state().view]`),[first,'挂起期间的草稿','tasks'])
 await f("frameFixture.navigate('home')");await menu('新建工作会话')
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='messages')
 assert.deepEqual(await f('[frameFixture.creates,frameFixture.current(),frameFixture.draft(frameFixture.current()),frameFixture.sent.length]'),[2,first,'挂起期间的草稿',0])
})
