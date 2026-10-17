import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const isolated=['WorkDirectory','WorkHome','TaskPage','TeamPage','BusinessPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
let browser:any,script:string,styles:string,temp:string
const patch=(source:string,from:string,to:string)=>{assert.equal(source.split(from).length,2,from);return source.replace(from,to)}
before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined;const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 entry=patch(entry,"workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]}]","workspaces:[{workspaceId:'workspace',title:'工作目录',path:'/fixture',sessionIds:[]},{workspaceId:'other',title:'其他目录',path:'/other',sessionIds:[]}]")
 entry=patch(entry,"create:async p=>{const prior=","create:async p=>{(f.creationRequests??=[]).push(p.requestId);if(f.failCreate)throw Error('controlled native create failure');const prior=")
 entry=patch(entry,"open:id=>{selected=id;","open:id=>{if(f.abortNativeNavigationOnOpen)nativeNavigation.abort();selected=id;")
 entry=patch(entry,"return [{scope:f.otherScope?'general':'sales',title:'验收业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}]","return [{scope:'general',title:'通用工作',kind:'general',loads:0,activeLoads:0,tasks:0,groups:0},{scope:'sales',title:'验收业务',kind:'domain',loads:0,activeLoads:0,tasks:0,groups:0}]")
 const setup=`
 if(startup.oneWorkspace)managementState.workspaces.splice(1);
 f.creationPrompts=[];props.preparation={prepare:prompt=>f.creationPrompts.push(prompt),invalidate:noop};
 props.pageCreateApi={directory:async({entity,scope})=>({schema:'teloa.page-create-drafts/v1',entity,...(scope?{scope}:{}),drafts:[],readAt:stamp})};
 props.marketCatalogApi={list:async()=>({catalogVersion:'fixture',items:[],nextCursor:null,counts:{role:0,skill:0,connector:0,model:0,solution:0,dashboard:0},skipped:{unknownKind:0,newerApp:0}})};
 props.businessCustomizationApi=new Proxy(generic,{get:(target,key)=>key==='directory'?async()=>({drafts:[],entries:[]}):target[key]});
 f.openMarket=()=>startup.businessPreparation||startup.legacyBusiness?store.actions.openBusiness({scope:'sales',section:startup.businessSection||'overview'}):store.actions.openMarketCategory('apps');
 `
 entry=patch(entry,"createRoot(document.getElementById('root')).render",setup+"createRoot(document.getElementById('root')).render")
 temp=await mkdtemp(join(root,'.runtime-market-create-frame-'));await writeFile(join(temp,'entry.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 // 目录内容不参与创建回执；保留真实 Frame 接线、创建抽屉、CreateEntry 与工作区选择窗。
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;const entry=id===join(client,'MarketPage.tsx')?'MarketPage':id===join(client,'BusinessPage.tsx')?'BusinessPage':null;if(entry==='BusinessPage'){const actual=(await readFile(id,'utf8')).replace('export function BusinessPage','function RealBusinessPage');return actual+`\nexport function BusinessPage(props){if(window.frameStartup.legacyBusiness)return <RealBusinessPage {...props} workspace={undefined} configuration={undefined}/>;return <BusinessCreationHost {...props}/>;}\nfunction BusinessCreationHost(props){const [open,setOpen]=useState(false);return <div hidden={!props.visible}><button onClick={()=>setOpen(true)}>创建技能</button><MarketResourceCreator kind="skill" open={open} close={()=>setOpen(false)} creation={props.pageCreate} browse={()=>{}}/></div>}\nimport {MarketResourceCreator} from '${client}MarketResourceCreator.tsx';`; }if(entry)return `import React,{useState} from 'react';import {MarketResourceCreator} from '${client}MarketResourceCreator.tsx';export function ${entry}(props){const [open,setOpen]=useState(false);return <div hidden={!props.visible}><button onClick={()=>setOpen(true)}>创建技能</button><MarketResourceCreator kind="skill" open={open} close={()=>setOpen(false)} creation={${entry==='MarketPage'?'props.mine.pageCreate':'props.pageCreate'}} browse={()=>{}}/></div>}`;const source=await readFile(id,'utf8');return [...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'entry.tsx'),name:'MarketCreateFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1400,height:1000}}),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text())});t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>{(window as any).frameStartup=value},startup);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready')
 await page.evaluate(()=>(window as any).frameFixture.openMarket())
 if(startup.legacyBusiness)return {page,workspace:page.getByRole('dialog',{name:'新建工作会话',exact:true})} as any;
 await page.getByRole('button',{name:'创建技能',exact:true}).click()
 const creator=page.getByRole('dialog',{name:'创建技能',exact:true}),input=creator.getByRole('textbox'),workspace=page.getByRole('dialog',{name:'新建工作会话',exact:true})
 await input.fill('原技能需求');return {page,creator,input,workspace}
}
const saved=(page:any)=>page.evaluate(()=>sessionStorage.getItem('teloa.market-creation-input/v1/skill'))

test('真实Frame技能创建取消旧启动恢复，打开自行撤销导航也不丢草稿',async t=>{
 const {page,creator,input}=await mount(t,{holdCreate:true,oneWorkspace:true,nativeOpenView:'messages',abortNativeNavigationOnOpen:true})
 const description='# 会议整理\n\n仅处理本人提供的记录。'
 await input.fill(description)
 await page.evaluate(()=>(window as any).frameFixture.holdRestore())
 await creator.getByRole('button',{name:'继续',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await page.evaluate(()=>(window as any).frameFixture.releaseRestore())
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),undefined,'旧启动恢复不能在正式创建等待期间切换主会话')
 await page.evaluate(()=>(window as any).frameFixture.releaseCreate())
 await page.waitForFunction(()=>(window as any).frameFixture.creationPrompts.length===1)
 await creator.waitFor({state:'hidden'})
 const facts=await page.evaluate(()=>{const f=(window as any).frameFixture;return {current:f.current(),conversation:f.rows()[0],prompt:f.creationPrompts[0],sent:f.sent}})
 assert.equal(facts.current,facts.conversation.sessionId)
 assert.equal(facts.prompt.sessionId,facts.conversation.sessionId)
 assert.ok(facts.prompt.text.includes(description),'原始Markdown只带入本次创建的会话')
 assert.equal(await saved(page),null)
 assert.deepEqual(facts.sent,[])
})

test('真实Frame业务prepare等待两个工作区的明确选择，取消保留原稿且不报读取失败',async t=>{
 const {page,creator,input,workspace}=await mount(t,{businessPreparation:true})
 await creator.getByRole('button',{name:'继续',exact:true}).click();await workspace.waitFor()
 assert.equal(await saved(page),'原技能需求','工作区尚未选择不能当作prepare成功清稿')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creates),0)
 await workspace.getByRole('button',{name:'取消',exact:true}).click();await workspace.waitFor({state:'hidden'})
 assert.equal(await creator.isVisible(),true);assert.equal(await input.inputValue(),'原技能需求');assert.equal(await creator.getByRole('alert').count(),0)
 assert.equal(await creator.getByRole('button',{name:'继续',exact:true}).isEnabled(),true)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.creationPrompts.length,f.sent.length]}),[0,0,0])
})
test('真实Frame创建失败保留市场原稿，实际成功才清除并准备一次且不发送',async t=>{
 const failed=await mount(t,{failCreate:true})
 await failed.creator.getByRole('button',{name:'继续',exact:true}).click();await failed.workspace.getByRole('alert').waitFor()
 assert.equal(await saved(failed.page),'原技能需求');assert.equal(await failed.input.inputValue(),'原技能需求')
 const success=await mount(t,{businessPreparation:true})
 await success.creator.getByRole('button',{name:'继续',exact:true}).click();await success.workspace.waitFor();await success.workspace.getByRole('combobox').selectOption('other');await success.workspace.getByRole('button',{name:'创建会话',exact:true}).click()
 await success.page.waitForFunction(()=>(window as any).frameFixture.creationPrompts.length===1)
 await success.creator.waitFor({state:'hidden'});assert.equal(await saved(success.page),null)
 const facts=await success.page.evaluate(()=>{const f=(window as any).frameFixture;return {creates:f.creates,prompt:f.creationPrompts[0].text,workspace:f.rows()[0].requestedWorkspaceId,sent:f.sent}})
 assert.equal(facts.creates,1);assert.match(facts.prompt,/原技能需求/);assert.equal(facts.workspace,'other');assert.match(facts.prompt,/sales/);assert.deepEqual(facts.sent,[])
})
test('真实Frame旧创建迟到时保留期间的新输入和重开后的草稿，忙碌请求不冒充成功',async t=>{
 const {page,creator,input}=await mount(t,{holdCreate:true,oneWorkspace:true})
 await creator.getByRole('button',{name:'继续',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await input.fill('创建期间的新技能输入');await page.keyboard.press('Escape');await creator.waitFor({state:'hidden'});await page.getByRole('button',{name:'创建技能',exact:true}).click()
 await creator.getByRole('button',{name:'继续',exact:true}).click();await creator.getByRole('alert').waitFor();assert.equal(await saved(page),'创建期间的新技能输入','忙碌请求不能清掉新稿')
 await page.evaluate(()=>(window as any).frameFixture.releaseCreate());await page.waitForFunction(()=>(window as any).frameFixture.rows().length===1)
 assert.equal(await saved(page),'创建期间的新技能输入');assert.equal(await input.inputValue(),'创建期间的新技能输入')
 assert.equal(await creator.isVisible(),true,'旧prepare结果不能关闭重开的新入口');assert.equal(await page.evaluate(()=>(window as any).frameFixture.sent.length),0)
})
test('真实Frame离开市场后未准备正文的成功会话回执不清原需求',async t=>{
 const {page,creator}=await mount(t,{holdCreate:true,oneWorkspace:true})
 await creator.getByRole('button',{name:'继续',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.navigate('tasks');f.releaseCreate()});await page.waitForFunction(()=>(window as any).frameFixture.rows().length===1)
 await page.waitForFunction(()=>document.querySelector<HTMLTextAreaElement>('dialog textarea')?.value===''||document.querySelector<HTMLButtonElement>('dialog button[type=submit]')?.disabled===false)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creationPrompts.length),0)
 assert.equal(await saved(page),'原技能需求','未执行preparation.prepare不能清掉原需求')
})
test('真实Frame创建失败后在原选择窗重试成功，沿原request清稿一次并清除旧错误',async t=>{
 const {page,creator,workspace}=await mount(t,{failCreate:true})
 await creator.getByRole('button',{name:'继续',exact:true}).click();await workspace.getByRole('alert').waitFor()
 await page.evaluate(()=>(window as any).frameFixture.failCreate=false);await workspace.locator('button[type=submit]').click()
 await page.waitForFunction(()=>(window as any).frameFixture.creationPrompts.length===1);await workspace.waitFor({state:'hidden'})
 assert.equal(await saved(page),null,'原请求重试prepared成功才清稿')
 await creator.waitFor({state:'hidden'})
 const facts=await page.evaluate(()=>{const f=(window as any).frameFixture;return {requests:f.creationRequests,creates:f.creates,prompts:f.creationPrompts.length,sent:f.sent}})
 assert.equal(facts.requests.length,2);assert.equal(facts.requests[0],facts.requests[1]);assert.equal(facts.creates,1);assert.equal(facts.prompts,1);assert.deepEqual(facts.sent,[])
 await page.getByRole('button',{name:'创建技能',exact:true}).click();assert.equal(await creator.getByRole('textbox').inputValue(),'');assert.equal(await creator.getByRole('alert').count(),0)
})

for(const kind of ['resources','dashboard'] as const)test('真实Frame旧业务'+kind+'准备取消不产生未处理拒绝，创建失败保留原工作区错误',async t=>{
 const {page,workspace}=await mount(t,{legacyBusiness:true,businessSection:kind==='dashboard'?'dashboards':'overview'})
 if(kind==='resources'){
  await page.locator('summary').filter({hasText:'更多'}).first().click();await page.getByRole('button',{name:'业务资源',exact:true}).click()
 }
 const action=page.getByRole('button',{name:kind==='resources'?'在会话中准备业务资源':'设计看板',exact:true})
 await action.click();await workspace.waitFor();await workspace.getByRole('button',{name:'取消',exact:true}).click();await workspace.waitFor({state:'hidden'})
 assert.equal(await action.isVisible(),true,'取消留在原业务入口')
 await page.evaluate(()=>(window as any).frameFixture.failCreate=true);await action.click();await workspace.waitFor();await workspace.getByRole('button',{name:'创建会话',exact:true}).click();await workspace.getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.creationPrompts.length),0)
 await workspace.getByRole('button',{name:'取消',exact:true}).click();await workspace.waitFor({state:'hidden'});assert.equal(await action.isVisible(),true)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.sent.length),0)
})

test('真实Frame资源准备成功进入原会话后原抽屉收起，返回原业务没有遮挡且不发送',async t=>{
 const {page,workspace}=await mount(t,{legacyBusiness:true})
 await page.locator('summary').filter({hasText:'更多'}).first().click();await page.getByRole('button',{name:'业务资源',exact:true}).click()
 const resources=page.getByRole('dialog',{name:'业务资源',exact:true});await resources.getByRole('heading',{name:'暂无业务资源',exact:true}).waitFor()
 for(const label of ['在会话中准备业务资源','打开市场']){const action=resources.getByRole('button',{name:label,exact:true});assert.equal(await action.textContent(),'');assert.equal(await action.getAttribute('title'),label);assert.equal(await action.locator('svg').count(),1);assert.notEqual(await action.getAttribute('data-teloa-toolbar-icon'),null);const box=await action.boundingBox();assert.equal(box?.width,32);assert.equal(box?.height,32)}
 assert.equal(await resources.getByText('可以从市场选择适用方案，或先在会话中整理业务目标、对象与资料需求。确认后才会应用到当前业务。',{exact:true}).count(),0)
 await resources.getByRole('button',{name:'在会话中准备业务资源',exact:true}).click();await workspace.waitFor()
 await workspace.getByRole('combobox').selectOption('other');await workspace.getByRole('button',{name:'创建会话',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.creationPrompts.length===1)
 await resources.waitFor({state:'hidden'});await page.evaluate(()=>(window as any).frameFixture.openFormal())
 await page.getByRole('button',{name:'业务资源',exact:true}).waitFor({state:'hidden'})
 assert.equal(await resources.count(),0)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creates,f.creationPrompts.length,f.sent.length]}),[1,1,0])
})
test('真实Frame旧资源准备迟到不收起切到另一业务后新开的资源抽屉',async t=>{
 const {page}=await mount(t,{legacyBusiness:true,holdCreate:true,oneWorkspace:true})
 await page.locator('summary').filter({hasText:'更多'}).first().click();await page.getByRole('button',{name:'业务资源',exact:true}).click()
 const resources=page.getByRole('dialog',{name:'业务资源',exact:true});await resources.getByRole('button',{name:'在会话中准备业务资源',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.creates===1)
 await resources.getByRole('button',{name:'关闭',exact:true}).click();await page.evaluate(()=>(window as any).frameFixture.openBusiness({scope:'general',section:'overview'}))
 await page.locator('summary').filter({hasText:'更多'}).first().click();await page.getByRole('button',{name:'业务资源',exact:true}).click();await resources.waitFor()
 await page.evaluate(()=>(window as any).frameFixture.releaseCreate());await page.waitForFunction(()=>(window as any).frameFixture.rows().length===1)
 assert.equal(await resources.isVisible(),true,'旧请求不能收起另一业务新入口')
 assert.equal(await resources.getByText('通用工作',{exact:true}).count(),1)
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).frameFixture;return [f.creationPrompts.length,f.sent.length]}),[0,0])
})
