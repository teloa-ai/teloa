import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('业务员工名单紧凑可用，同一身份、任务、协调与团队分享入口保留',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-employee-roster-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {BusinessWorkspace} from ${JSON.stringify(join(client,'BusinessWorkspace.tsx'))};import {TemplateShareProvider} from ${JSON.stringify(join(client,'EmployeeTemplateShare.tsx'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));
 const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 const evidence=window.rosterFixture={calls:[],failChat:false},now='2026-10-15T00:00:00Z',id=index=>'10000000-0000-4000-8000-'+String(index).padStart(12,'0');
 const names=['研究员','写作伙伴','产品研究员','研发工程师','质量工程师','销售顾问','会议助理','内容编辑'];
 const roles=names.map((name,index)=>({id:id(index+1),name,avatarKey:['researcher','content-writer','product-manager','developer','qa-tester','sales','executive-assistant','ui-designer'][index],storage:'persistent',kind:'employee',state:index===1?'paused':'active',scopes:['sales'],version:1,duty:index===0?'核实访谈材料，整理有来源的结论。':'依据目标协作，交付可核对的工作成果。',dataScope:'本人提供的资料',executionScope:'获准的本地工作',skills:[],knowledge:[],memories:[],history:[]}));
 const excluded=[{...roles[0],id:id(20),name:'已退役员工',state:'retired'},{...roles[0],id:id(21),name:'本人分身',kind:'twin'},{...roles[0],id:id(22),name:'页面示例员工',storage:undefined}];
 const tasks=[{id:'task-first',storage:'persistent',title:'整理客户访谈',scope:'general',assigneeId:id(1),state:'running',updatedAt:now},{id:'task-next',storage:'persistent',title:'补充访谈来源',scope:'general',assigneeId:id(1),state:'ready',updatedAt:'2026-10-14T00:00:00Z'},{id:'task-other',storage:'persistent',title:'其他业务的任务',scope:'private-business',assigneeId:id(1),state:'running',updatedAt:now}];
 const groups={list:async()=>({items:[]})},dashboardApi={list:async()=>[]},store=new Map(),sharing={storage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value),removeItem:key=>store.delete(key)},publisher:'测试发布者',sources:{skills:async()=>[]},receive:()=>{},openDraft:()=>{}};
 const responsibility={api:{read:async({scope})=>{evidence.calls.push(['responsibility',scope]);return {scope,version:1,roleId:id(1),availability:'ready'}}},roles:{list:async()=>roles}};
 function App(){const [scope,setScope]=useState('general'),[section,setSection]=useState('employees'),[unknown,setUnknown]=useState(false);const services={responsibility,groups,attention:[],rolesKnown:true,rolesFailed:false,tasksKnown:!unknown,tasksFailed:unknown,attentionKnown:true,attentionFailed:false,refresh:()=>evidence.calls.push(['refresh']),createGroup:()=>{},openGroup:()=>{},openAttention:()=>{},talkRole:async roleId=>{evidence.calls.push(['chat',roleId]);if(evidence.failChat)throw Error('failed')},renderRole:(roleId,close)=><><p>原员工档案：{roleId}</p><button onClick={close}>返回名单</button></>};return <I18nProvider runtime={i18n}><TemplateShareProvider value={sharing}><aside><button onClick={()=>setUnknown(!unknown)}>切换工作读取状态</button><button onClick={()=>{setScope('sales');setSection('employees')}}>查看具体业务</button></aside><BusinessWorkspace key={scope} scope={scope} title={scope==='general'?'通用工作':'销售工作'} target={{scope,section}} state={{tasks,roles:[...roles,...excluded]}} services={services} dashboardApi={dashboardApi} go={target=>setSection(target.section)} back={()=>{}} start={()=>{}} configure={()=>{}} staff={()=>evidence.calls.push(['manage'])} openTask={taskId=>evidence.calls.push(['task',taskId])} openWork={()=>{}} colorScheme="light"><span/></BusinessWorkspace></TemplateShareProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BusinessRosterTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/business-roster'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/business-roster');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const identity=page.getByRole('list').getByRole('button',{name:/^研究员/});await identity.waitFor()
 const density=await identity.evaluate((element:HTMLElement)=>{const row=element.closest('tr,li,article')!;return {height:row.getBoundingClientRect().height,border:getComputedStyle(row).borderRadius}})
 assert.ok(density.height<=84,'员工名单不能继续用撑满留白的大卡片')
 for(const name of ['已退役员工','本人分身','页面示例员工','未指定 · 员工按岗位协作','其他业务的任务','暂无进行中的工作'])assert.equal(await page.getByText(name,{exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'设置协调员工',exact:true}).count(),0,'通用范围没有业务协调设置或空协调节点')
 assert.equal((await page.evaluate(()=>(window as any).rosterFixture.calls)).some((row:any[])=>row[0]==='responsibility'),false)
 await identity.click();const profile=page.getByRole('dialog',{name:'研究员',exact:true});await profile.waitFor();assert.match(await profile.innerText(),/10000000-0000-4000-8000-000000000001/);await page.keyboard.press('Escape')
 await page.getByRole('button',{name:/整理客户访谈/}).click();await page.getByRole('button',{name:'对话 · 研究员',exact:true}).click();await page.getByRole('button',{name:'管理员工',exact:true}).click()
 const actions=await page.evaluate(()=>(window as any).rosterFixture.calls);assert.ok(actions.some((row:any[])=>row[0]==='task'&&row[1]==='task-first'));assert.ok(actions.some((row:any[])=>row[0]==='chat'&&row[1]==='10000000-0000-4000-8000-000000000001'));assert.ok(actions.some((row:any[])=>row[0]==='manage'))
 await page.getByRole('button',{name:/分享.*团队/}).click();const sharing=page.getByRole('dialog',{name:/分享.*团队/});await sharing.waitFor();await page.keyboard.press('Escape');assert.equal(await sharing.isVisible(),false)
 await page.getByRole('button',{name:'总览',exact:true}).click();const overviewRow=page.getByRole('list').getByRole('button',{name:/^研究员/});assert.ok(await overviewRow.evaluate((element:HTMLElement)=>element.closest('tr,li,article')!.getBoundingClientRect().height)<=84,'总览复用同一紧凑名单')
 await page.getByRole('button',{name:'切换工作读取状态',exact:true}).click();assert.equal(await page.getByRole('button',{name:/整理客户访谈/}).count(),0,'读取失败不能继续冒充已知的当前工作');assert.ok(await page.getByText('读取失败，请重试',{exact:true}).count()>0)
 await page.getByRole('button',{name:'AI 员工',exact:true}).click();await page.setViewportSize({width:620,height:1000});const chat=page.getByRole('button',{name:'对话 · 研究员',exact:true}),chatBox=await chat.boundingBox(),identityBox=await identity.boundingBox();assert.ok(chatBox&&identityBox&&chatBox.x+chatBox.width<=620&&identityBox.x>=0,'窄窗的姓名和对话入口无需横向寻找');await chat.click();assert.ok(await identity.isVisible());assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,'窄窗不把名单撑出视口')
 await page.setViewportSize({width:1440,height:1000});await page.getByRole('button',{name:'查看具体业务',exact:true}).click();await page.getByRole('button',{name:'设置协调员工',exact:true}).waitFor();await page.getByText('协调员工',{exact:true}).waitFor();await page.locator('header').getByRole('button',{name:/^研究员/}).click();await profile.waitFor();await page.keyboard.press('Escape')
 await page.getByRole('button',{name:/分享.*团队/}).click();await sharing.waitFor();assert.equal(await sharing.getByRole('combobox').inputValue(),'10000000-0000-4000-8000-000000000001','团队分享沿用当前业务同一协调员工');await page.keyboard.press('Escape')
 assert.deepEqual(errors,[])
})
