import assert from 'node:assert/strict'
import test,{type TestContext} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const setup=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {ContextDrawer} from ${JSON.stringify(join(client,'ContextDrawer.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import {emptyTaskPreview} from ${JSON.stringify(join(client,'task-preview.ts'))};
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};`

async function fixture(t:TestContext,source:string,frame=false){
 const temp=await mkdtemp(join(root,'.runtime-context-work-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),frame?source:setup+source+`createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const isolated=['WorkDirectory','WorkHome','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:frame?[{name:'isolate-unrelated-context-pages',enforce:'pre',load:async id=>{if(!isolated.some(name=>id===join(client,name+'.tsx')))return;const source=await readFile(id,'utf8');return [...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')}}]:[],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ContextWorkTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.stack??error.message))
 if(frame){const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>')});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())));const origin='http://127.0.0.1:'+((server.address() as {port:number}).port);await page.route('**/*',(route:any)=>{if(new URL(route.request().url()).origin===origin)return route.continue();requests.push(route.request().url());return route.abort()});await page.goto(origin)}
 else {await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()});await page.setContent('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')}
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 return {page,errors,requests}
}

async function employeeFrameFixture(t:TestContext,cold=false,receiptOpen?:string){
 // 复用既有端口夹具，实际运行 Frame/store/TaskPage/TeamPage/ContextDrawer；仅隔离无关页面和外部 API。
 const source=await readFile(join(client,'../../tests/business-builder-frame.test.ts'),'utf8'),file=ts.createSourceFile('frame-fixture.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let entry:ts.Expression|undefined;const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='entry')entry=node.initializer;ts.forEachChild(node,visit)};visit(file);assert.ok(entry)
 let original=new Function('client','return '+entry.getText(file))(client) as string
 if(receiptOpen){const probe='<textarea aria-label="slot-probe" defaultValue="原生输入草稿"/>';assert.equal(original.split(probe).length,2);original=`import {ConversationObjectCard} from ${JSON.stringify(join(client,'ConversationObjectCard.tsx'))};`+original.replace(probe,probe+`<ConversationObjectCard receipt={{kind:'role',id:employee.id,title:employee.name,revision:'3'}} readRole={async()=>({...employee,ownerId:'local:teloa-owner'})} readGroup={async()=>undefined} drafts={{}} mcp={{}} openRole={${receiptOpen}} openGroup={noop} openCapabilities={noop}/>`)}
 const boundary="createRoot(document.getElementById('root')).render(";assert.equal(original.split(boundary).length,2)
 return fixture(t,"window.frameStartup={withRole:true};"+original.replace(boundary,`
 f.holdRoleReads=${cold};const roleReads=[];f.releaseRoleReads=()=>{f.holdRoleReads=false;roleReads.splice(0).forEach(resolve=>resolve())};
 const requireActions=()=>store.actions;f.actions=store.actions;f.nativeSession=id=>{selected=id;for(const listener of listeners)listener()};
 const sourceTask={id:'10000000-0000-4000-8000-000000000001',ownerId:'self',title:'原任务',goal:'原任务目标',scope:'general',groupId:null,skills:[],state:'ready',version:1,contentVersion:1,assigneeRoleId:'r-profile',assigneeRoleVersion:3,createdAt:stamp,updatedAt:stamp};
 props.taskApi=new Proxy(generic,{get:(target,key)=>key==='list'?async()=>[sourceTask]:key==='attention'?async()=>({items:[{task:sourceTask,attention:null}]}):key==='completion'?async()=>null:target[key]});
 props.industryTaskApi=new Proxy(generic,{get:(target,key)=>key==='source'?async()=>null:target[key]});
 props.resourceApi={directory:async()=>({resources:[]}),sources:async()=>[]};
 props.roleApi=new Proxy(props.roleApi,{get:(target,key)=>key==='list'?async()=>{if(f.holdRoleReads)await new Promise(resolve=>roleReads.push(resolve));if(f.failRoleReads)throw Error('controlled role read failure');return [{...f.employee},{...f.employee,id:'r-other',name:'另一员工'}]}:target[key]});
 `+boundary),true)
}

test('实际 Frame 任务负责人叠加员工，邮箱与员工依次关闭返回同一任务、焦点及未提交草稿',async t=>{
 const {page,errors,requests}=await employeeFrameFixture(t)
 await page.waitForFunction(()=>!!(window as any).frameFixture)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.actions.openTask('10000000-0000-4000-8000-000000000001');f.rememberDirectory('tasks',{query:'原任务',scrollTop:240})})
 const owner=page.getByRole('button',{name:'原姓名',exact:true});await owner.waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText(),state:await page.evaluate(()=>(window as any).frameFixture.state())}));throw error})
 await page.getByRole('button',{name:'修改任务目标',exact:true}).click()
 await page.getByRole('textbox',{name:'工作目标',exact:true}).fill('尚未提交的原任务草稿')
 await page.keyboard.press('Escape')
 await owner.click()
 const employee=page.getByRole('dialog',{name:'原姓名',exact:true});await employee.waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText(),state:await page.evaluate(()=>(window as any).frameFixture.state())}));throw error})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().view),'tasks')
 assert.equal(await owner.evaluate((node:HTMLElement)=>node.isConnected),true)
 const more=employee.getByRole('button',{name:'更多员工操作',exact:true});await more.click()
 const mail=employee.getByRole('button',{name:'工作邮箱 · 未接入',exact:true});await mail.click();await page.getByRole('dialog',{name:'工作邮箱',exact:true}).waitFor()
 await page.keyboard.press('Escape');assert.equal(await more.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await owner.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await page.getByRole('button',{name:'修改任务目标',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'工作目标',exact:true}).inputValue(),'尚未提交的原任务草稿');await page.keyboard.press('Escape')
 // 外点与关闭按钮也只关预览，不导航、不提交。
 await owner.click();await employee.waitFor();await page.mouse.click(10,480);assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await owner.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await owner.click();await employee.waitFor();await employee.getByRole('button',{name:'关闭',exact:true}).first().click();assert.equal(await page.locator('dialog[open]').count(),0)
 assert.deepEqual(await page.evaluate(()=>{const s=(window as any).frameFixture.state();return [s.view,s.taskId,s.navigationDirectories.tasks.query]}),['tasks','10000000-0000-4000-8000-000000000001','原任务'])
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})

test('实际 index 员工回执查看接线叠加 Frame 员工，关闭回原卡与会话草稿',async t=>{
 const file=ts.createSourceFile('index.ts',await readFile(join(client,'index.ts'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let open:ts.Expression|undefined;const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(file)==='objectCardPorts'&&node.initializer&&ts.isObjectLiteralExpression(node.initializer)){const property=node.initializer.properties.find(property=>ts.isPropertyAssignment(property)&&property.name.getText(file)==='openRole');if(property&&ts.isPropertyAssignment(property))open=property.initializer}ts.forEachChild(node,visit)};visit(file);assert.ok(open,'执行实际回执端口接线，不能改用测试自写导航')
 const {page,errors,requests}=await employeeFrameFixture(t,false,open.getText(file));await page.waitForFunction(()=>!!(window as any).frameFixture);await page.evaluate(()=>(window as any).frameFixture.actions.openMessages('native'))
 await page.getByRole('textbox',{name:'slot-probe'}).fill('原会话未发送草稿')
 const receipt=page.getByRole('button',{name:/^原姓名.*在岗/});await receipt.click().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error});await page.getByRole('dialog',{name:'原姓名',exact:true}).waitFor();assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().view),'messages')
 await page.keyboard.press('Escape');assert.equal(await receipt.evaluate((node:HTMLElement)=>node===document.activeElement),true);assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'原会话未发送草稿');assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})

test('实际 Frame 冷员工读取可关闭，迟答不重开；读取失败显示失败而非持续加载',async t=>{
 const {page,errors,requests}=await employeeFrameFixture(t,true);await page.waitForFunction(()=>!!(window as any).frameFixture)
 await page.evaluate(()=>(window as any).frameFixture.actions.previewRole('r-profile'))
 const employee=page.getByRole('dialog',{name:'员工',exact:true});await employee.waitFor();await employee.getByRole('status').waitFor();await page.keyboard.press('Escape')
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.failRoleReads=true;f.releaseRoleReads()});assert.equal(await page.locator('dialog[open]').count(),0)
 await page.evaluate(()=>(window as any).frameFixture.actions.previewRole('r-profile'));await employee.waitFor();await employee.getByRole('alert').waitFor();assert.equal(await employee.getByRole('status').count(),0)
 await page.keyboard.press('Escape');await page.evaluate(()=>{const f=(window as any).frameFixture;f.failRoleReads=false;f.actions.previewRole('r-profile');f.actions.closeRolePreview(f.state().rolePreview.request)})
 await page.waitForFunction(()=>document.querySelector('[data-team-directory-mode]')!==null||!(window as any).frameFixture.state().rolePreview);assert.equal(await page.locator('dialog[open]').count(),0)
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})

test('实际 Frame 员工预览重绘保草稿，旧关闭不清新员工；明确导航清预览并保原会话详情',async t=>{
 const {page,errors,requests}=await employeeFrameFixture(t);await page.waitForFunction(()=>!!(window as any).frameFixture)
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.actions.openTask('10000000-0000-4000-8000-000000000001')})
 const owner=page.getByRole('button',{name:'原姓名',exact:true});await owner.click();let employee=page.getByRole('dialog',{name:'原姓名',exact:true});await employee.waitFor()
 await employee.getByRole('button',{name:'交给它一件事',exact:true}).click();await page.getByRole('textbox',{name:'任务名称',exact:true}).fill('原员工派活草稿')
 await page.evaluate(()=>(window as any).frameFixture.rememberDirectory('tasks',{scrollTop:321}));assert.equal(await page.getByRole('textbox',{name:'任务名称',exact:true}).inputValue(),'原员工派活草稿');await page.keyboard.press('Escape')
 await page.evaluate(()=>{const f=(window as any).frameFixture,old=f.state().rolePreview.request;f.actions.previewRole('r-other');f.actions.closeRolePreview(old)})
 employee=page.getByRole('dialog',{name:'另一员工',exact:true});await employee.waitFor();await page.keyboard.press('Escape');await owner.click();await page.getByRole('dialog',{name:'原姓名',exact:true}).waitFor();await page.getByRole('button',{name:'交给它一件事',exact:true}).click();assert.equal(await page.getByRole('textbox',{name:'任务名称',exact:true}).inputValue(),'原员工派活草稿');await page.keyboard.press('Escape')
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.actions.openArtifacts({kind:'task',id:'original-artifacts'});f.actions.openDirectory()})
 assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await page.evaluate(()=>{const s=(window as any).frameFixture.state();return [s.view,s.rolePreview,s.detail.target.source.id]}),['settings',null,'original-artifacts'])
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.actions.closeSettings();f.actions.previewRole('r-profile');f.actions.openMessages('native')});assert.equal(await page.locator('dialog[open]').count(),0)
 await page.evaluate(()=>(window as any).frameFixture.nativeSession('original-session'));await page.waitForFunction(()=>(window as any).frameFixture.current()==='original-session')
 await page.evaluate(()=>(window as any).frameFixture.actions.previewRole('r-profile'));await page.getByRole('dialog',{name:'原姓名',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.nativeSession('next-session'));await page.waitForFunction(()=>(window as any).frameFixture.state().rolePreview===null);assert.equal(await page.locator('dialog[open]').count(),0)
 // 明确进入员工目录仍使用原名单抽屉，关闭回到该名单行。
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'));const directoryEntry=page.locator('[data-teloa-pane="directory"] [data-teloa-entry]').filter({hasText:'原姓名'});await directoryEntry.click();await page.getByRole('dialog',{name:'原姓名',exact:true}).waitFor();await page.keyboard.press('Escape')
 assert.equal(await directoryEntry.evaluate((node:HTMLElement)=>node===document.activeElement),true);assert.deepEqual(await page.evaluate(()=>{const s=(window as any).frameFixture.state();return [s.view,s.roleId,s.rolePreview]}),['team',null,null])
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})

test('员工计划使用 Frame 真实入口叠加详情，Esc 返回原计划行与员工，不跳自动化目录',async t=>{
 const file=ts.createSourceFile('WorkbenchFrame.tsx',await readFile(join(client,'WorkbenchFrame.tsx'),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 let open:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(file)==='RolePlans'){const attr=node.attributes.properties.find(property=>ts.isJsxAttribute(property)&&property.name.getText(file)==='open');if(attr&&ts.isJsxAttribute(attr)&&attr.initializer&&ts.isJsxExpression(attr.initializer))open=attr.initializer.expression}ts.forEachChild(node,visit)};visit(file);assert.ok(open,'核对实际员工入口，不重写 Frame 路由')
 const {page,errors,requests}=await fixture(t,`import {RolePlans} from ${JSON.stringify(join(client,'ContinuousPage.tsx'))};
 const state={...emptyTaskPreview(),continuous:{plans:[{id:'original-plan',version:1,revision:1,enabled:false,archived:false,history:[],fields:{title:'原员工计划',roleId:'original-role',scope:'general',goal:'原目标',dataScope:'原资料',delivery:'原成果',trigger:{kind:'schedule',cadence:'daily',weekday:1,time:'09:00',timezone:'Asia/Singapore'}}}],runs:[],loaded:true}};
 function App(){const [employee,setEmployee]=useState(false),[plans,setPlans]=useState(false),[conversationPlanTarget,setConversationPlanTarget]=useState(null),[navigation,setNavigation]=useState('员工'),actions={openPlans:target=>{setEmployee(false);setPlans(false);setNavigation('自动化')}};
 return <main id="teloa-main" tabIndex={-1}><h1>{navigation}</h1><textarea aria-label="原会话草稿" defaultValue="继续原工作"/><button onClick={()=>setEmployee(true)}>打开原员工</button>{employee&&<ContextDrawer title="原员工" close={()=>setEmployee(false)}><button onClick={()=>setPlans(true)}>员工自动化</button>{plans&&<ContextDrawer title="员工自动化" close={()=>setPlans(false)}><RolePlans heading={false} state={state} id="original-role" open={${open.getText(file)}} savedPlanIds={new Set(['original-plan'])}/></ContextDrawer>}</ContextDrawer>}{conversationPlanTarget&&<ContextDrawer title="原员工计划" close={()=>setConversationPlanTarget(undefined)}><p>{conversationPlanTarget.id}</p></ContextDrawer>}</main>}`)
 await page.getByRole('button',{name:'打开原员工',exact:true}).click();await page.getByRole('button',{name:'员工自动化',exact:true}).click()
 await page.getByRole('button',{name:'原员工计划 已暂停',exact:true}).click()
 await page.getByRole('dialog',{name:'原员工计划',exact:true}).waitFor()
 assert.equal(await page.locator('dialog[open]').count(),3)
 assert.equal(await page.getByRole('heading',{name:'员工',exact:true}).count(),1)
 await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'原员工计划',exact:true}).waitFor({state:'detached'})
 assert.equal(await page.locator('dialog[open]').count(),2)
 assert.equal(await page.getByRole('button',{name:'原员工计划 已暂停',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'员工自动化',exact:true}).waitFor({state:'detached'})
 assert.equal(await page.getByRole('button',{name:'员工自动化',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'原员工',exact:true}).waitFor({state:'detached'})
 assert.equal(await page.getByRole('button',{name:'打开原员工',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'继续原工作');assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})

test('任务内成果在宽桌面也置于任务上层，Esc 先关成果并保留任务和来源草稿',async t=>{
 const {page,errors,requests}=await fixture(t,`import {ArtifactPanel} from ${JSON.stringify(join(client,'ArtifactPanel.tsx'))};
 function App(){const [task,setTask]=useState(false),[artifact,setArtifact]=useState(false);return <main id="teloa-main" tabIndex={-1}><textarea aria-label="原会话草稿" defaultValue="继续原工作"/><button onClick={()=>setTask(true)}>打开原任务</button>{task&&<ContextDrawer title="原任务" close={()=>setTask(false)}><button onClick={()=>setArtifact(true)}>查看工作成果</button><input aria-label="任务草稿" defaultValue="原任务补充"/></ContextDrawer>}<ArtifactPanel open={artifact} target={{source:{kind:'session',id:'original-session'}}} state={emptyTaskPreview()} conversation={{id:'original-session',title:'原任务会话',scope:'general',bindingId:'original-binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setArtifact(false)} change={async()=>{throw Error('浏览不写入')}} openSource={()=>{}} openTask={()=>{}}/></main>}`)
 await page.getByRole('button',{name:'打开原任务',exact:true}).click();await page.getByRole('button',{name:'查看工作成果',exact:true}).click()
 const artifact=page.getByRole('dialog',{name:'工作成果',exact:true});await artifact.waitFor()
 assert.equal(await artifact.evaluate((node:HTMLElement)=>node.matches(':modal')),true,'成果不能 show() 后沉在已有 showModal() 的任务下方')
 assert.equal(await artifact.getByRole('textbox').count(),0)
 await page.keyboard.press('Escape');await artifact.waitFor({state:'detached'})
 assert.equal(await page.getByRole('dialog',{name:'原任务',exact:true}).count(),1)
 assert.equal(await page.getByRole('button',{name:'查看工作成果',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await page.getByRole('textbox',{name:'任务草稿'}).inputValue(),'原任务补充')
 await page.getByRole('button',{name:'查看工作成果',exact:true}).click();await artifact.waitFor()
 assert.equal(await artifact.getByRole('textbox').count(),0)
 await page.keyboard.press('Escape');await artifact.waitFor({state:'detached'});await page.keyboard.press('Escape');await page.getByRole('dialog',{name:'原任务',exact:true}).waitFor({state:'detached'})
 assert.equal(await page.getByRole('button',{name:'打开原任务',exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'继续原工作');assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
