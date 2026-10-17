import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import {prototypeThemes} from '../src/brand/prototype-theme.ts'
// @ts-expect-error 复用固定的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

async function fixture(t:any){
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__directory_drag_search.tsx'
 const entry=`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {WorkDirectory} from '${client}WorkDirectory.tsx';import {WorkspaceSearch} from '${client}WorkspaceSearch.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {createDialogueOrganization} from '${client}dialogue-organization.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
 const noop=()=>{},folder='folder-design',empty='folder-empty',memory=new Map([['teloa.dialogue-organization/v1',JSON.stringify({schema:'teloa.dialogue-organization/v1',assistantName:'Teloa',type:'all',folders:[{id:folder,name:'设计',collapsed:true},{id:empty,name:'空分组',collapsed:false}],placements:{}})]]),storage={getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)},organization=createDialogueOrganization(storage);
 const conversation={id:'binding-original',ownerId:'self',title:'原会话',scopeIds:['general'],version:1,status:'ready',sessionId:'session-original',requestedSessionId:'session-original',createdAt:'2026-10-13T00:00:00Z'};
 const group={id:'group-original',ownerId:'self',name:'原协作群',scope:'general',purpose:'',announcement:'',archived:false,pinned:false,updatedAt:'2026-10-13T00:01:00Z'};
 const f=window.directorySearchFixture={opens:[],searchMessages:[],organization,folder,empty,reload:()=>createDialogueOrganization(storage).getSnapshot()};
 const directory={status:'ready',rows:[conversation]},managed={ready:true,baseline:true,archived:[],workspaces:[],pending:{}},searchState={items:[],hasMore:false};
 const work={subscribe:()=>noop,getDirectorySnapshot:()=>directory,refreshDirectory:async()=>{},openConversation:async row=>{f.opens.push(row.sessionId);return 'opened'}},management={subscribe:()=>noop,getSnapshot:()=>managed},search={subscribe:()=>noop,getSnapshot:()=>searchState,clear:noop,run:async()=>{}};
 const groupSnapshot={status:'ready',items:[group]},groups={subscribe:()=>noop,getSnapshot:()=>groupSnapshot,refresh:async()=>{}},native={byId:{'session-original':{id:'session-original',title:'原会话',blank:false,running:false,updatedAt:1791849600000}},ids:['session-original']};
 const source={conversations:[{conversation,title:conversation.title,status:'idle',updatedAt:1791849600000}],groups:[{...group,storage:'persistent'}],tasks:[{id:'task-original',title:'原任务',goal:'核对资料',state:'ready',scope:'general',storage:'persistent'}],roles:[],spaces:[],knowledge:[],capabilities:[],market:[],plans:[]};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
 function App(){const [visible,setVisible]=useState(false);return <I18nProvider runtime={runtime}><button onClick={()=>setVisible(true)}>打开搜索</button><WorkDirectory organization={organization} work={work} management={management} search={search} groups={groups} useSessions={select=>select(native)} current="session-original" onOpened={noop} focusRequest={0} onClose={noop} openGroup={id=>f.opens.push(id)} createGroup={noop}/><WorkspaceSearch visible={visible} source={source} conversationStatus="" knowledgeStatus="" capabilityStatus="" close={()=>setVisible(false)} open={async row=>{f.opens.push(row.key)}} searchMessages={query=>f.searchMessages.push(query)}/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'directory-drag-search-fixture',resolveId:id=>id.endsWith('directory-drag-search-fixture')?entryId:null,load:id=>id===entryId?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'directory-drag-search-fixture',name:'DirectoryDragSearch',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1280,height:900}});t.after(()=>page.close());page.setDefaultTimeout(2200)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>route.abort());await page.route('http://127.0.0.1/directory-drag-search',(route:any)=>route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1/directory-drag-search');await page.addStyleTag({content:'body{font:14px var(--teloa-design-font);margin:0;background:var(--teloa-background);color:var(--teloa-text)}[data-teloa-pane=directory]{width:330px;height:740px}'});await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 return {page,errors}
}

test('原会话和群拖入空组、折叠组和未分组，持久保存原ID且不触发打开',{timeout:30000},async t=>{
 const {page,errors}=await fixture(t)
 const directory=page.locator('[data-teloa-pane="directory"]'),types=directory.getByRole('group',{name:'对话类型',exact:true})
 assert.equal(await directory.getByText('目录分组',{exact:true}).count(),0,'不为分组再占一排说明与第二个加号')
 const tabs=await types.evaluate((el:HTMLElement)=>({height:el.getBoundingClientRect().height,background:getComputedStyle(el).backgroundColor}))
 assert.ok(tabs.height<=36);assert.equal(tabs.background,'rgba(0, 0, 0, 0)','分类用轻量文字与下划线，不做大块分段卡片')
 await types.getByRole('button',{name:'会话',exact:true}).focus();assert.equal(await types.getByRole('button',{name:'会话',exact:true}).getAttribute('aria-pressed'),'true','旧混合视图迁移为会话分类')
 assert.equal(await directory.locator('[data-group-id]').count(),0)
 await page.keyboard.press('ArrowRight');assert.equal(await types.getByRole('button',{name:'员工',exact:true}).getAttribute('aria-pressed'),'true')
 await page.keyboard.press('ArrowRight');assert.equal(await types.getByRole('button',{name:'群',exact:true}).getAttribute('aria-pressed'),'true')
 assert.equal(await directory.locator('[data-session-id]').count(),0)
 await page.keyboard.press('Home');assert.equal(await types.getByRole('button',{name:'会话',exact:true}).getAttribute('aria-pressed'),'true')
 const create=directory.getByRole('button',{name:'添加对话',exact:true});await create.click()
 assert.equal(await directory.getByRole('button',{name:'新建分组',exact:true}).isVisible(),true,'新建分组收在同一个加号里')
 await page.keyboard.press('Escape')
 await page.mouse.click(500,50)
 for(const theme of ['light','dark'] as const){
  await page.evaluate((values:Record<string,string>)=>{for(const [key,value]of Object.entries(values))document.body.style.setProperty(key,value)},prototypeThemes[theme])
  const width=await directory.evaluate((el:HTMLElement)=>({scroll:el.scrollWidth,client:el.clientWidth}));assert.equal(width.scroll,width.client,theme+'目录不横向溢出')
  if(process.env.TELOA_TEST_CAPTURE_DIR)await directory.screenshot({path:process.env.TELOA_TEST_CAPTURE_DIR+'/dialogue-directory-'+theme+'.png'})
 }
 await page.evaluate((values:Record<string,string>)=>{for(const [key,value]of Object.entries(values))document.body.style.setProperty(key,value)},prototypeThemes.light)
 const group=page.locator('[data-group-id="group-original"]'),session=page.locator('[data-session-id="session-original"]'),folder=page.locator('[data-dialogue-folder]').filter({has:page.getByText('设计',{exact:true})}),empty=page.locator('[data-dialogue-folder]').filter({has:page.getByText('空分组',{exact:true})})
 await types.getByRole('button',{name:'群',exact:true}).click()
 await group.waitFor();const start=await group.boundingBox(),target=await folder.boundingBox();assert.ok(start&&target)
 await page.mouse.move(start.x+80,start.y+start.height/2);await page.mouse.down();await page.mouse.move(start.x+80,start.y+start.height/2-12);await page.mouse.move(target.x+60,target.y+20,{steps:5})
 await page.mouse.move(target.x+64,target.y+20);await page.mouse.move(target.x+60,target.y+20)
 await page.waitForFunction(()=>document.querySelector('[data-dialogue-folder="folder-design"]')?.hasAttribute('data-drop-target'))
 await folder.getByRole('button',{name:'折叠分组 · 设计',exact:true}).waitFor();await page.mouse.up()
 await folder.getByRole('button',{name:'折叠分组 · 设计',exact:true}).waitFor()
 assert.equal(await folder.locator('[data-group-id="group-original"]').count(),1)
 await types.getByRole('button',{name:'会话',exact:true}).click()
 await session.dragTo(empty)
 assert.equal(await empty.locator('[data-session-id="session-original"]').count(),1)
 await empty.locator('[data-session-id="session-original"]').dragTo(page.locator('[data-dialogue-folder="unfiled"]'))
 assert.equal(await page.locator('[data-dialogue-folder="unfiled"] [data-session-id="session-original"]').count(),1)
 const state=await page.evaluate(()=>{const f=(window as any).directorySearchFixture;return {saved:f.reload(),opens:f.opens,folder:f.folder}})
 assert.equal(state.saved.placements[JSON.stringify(['group','group-original'])],state.folder)
 assert.equal(state.saved.placements[JSON.stringify(['session','session-original'])],undefined)
 assert.deepEqual(state.opens,[],'拖动不得打开原会话或群')
 await folder.getByRole('button',{name:'折叠分组 · 设计',exact:true}).click()
 const query=directory.getByRole('textbox',{name:'搜索目录会话',exact:true})
 await types.getByRole('button',{name:'群',exact:true}).click()
 await query.fill('原协作群');await group.waitFor({state:'visible'})
 assert.equal(await folder.getByRole('button').first().getAttribute('aria-expanded'),'true','搜索能看到折叠分组里的命中')
 await query.fill('');await group.waitFor({state:'hidden'})
 assert.equal((await page.evaluate(()=>(window as any).directorySearchFixture.reload())).folders.find((item:any)=>item.id==='folder-design').collapsed,true,'清除搜索后保留原折叠状态')
 const top=await types.boundingBox()
 await page.evaluate(()=>{for(let i=0;i<16;i++)(window as any).directorySearchFixture.organization.createFolder('分组 '+i)})
 const scroll=directory.locator('[class*="directoryScroll"]')
 await scroll.evaluate((el:HTMLElement)=>{el.scrollTop=el.scrollHeight})
 await directory.getByRole('button',{name:'折叠分组 · 分组 15',exact:true}).waitFor({state:'visible'})
 const position=await types.boundingBox(),bounds=await scroll.evaluate((el:HTMLElement)=>({height:el.clientHeight,scroll:el.scrollHeight,top:el.scrollTop}))
 assert.ok(bounds.scroll>bounds.height&&bounds.top>0,'分组在同一内容区滚动，不挤走会话列表')
 assert.equal(position?.y,top?.y,'滚动多个分组时搜索分类仍留在原处')
 assert.deepEqual(errors,[])
})

test('紧凑搜索可按类别筛选、键盘打开原结果，关闭后保留查询',{timeout:30000},async t=>{
 const {page,errors}=await fixture(t);await page.getByRole('button',{name:'打开搜索',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'搜索',exact:true}),input=dialog.getByRole('combobox',{name:'全局搜索',exact:true})
 assert.equal(await dialog.getByRole('tab',{name:'能力',exact:true}).count(),0)
 assert.equal(await dialog.getByRole('tab',{name:'市场',exact:true}).count(),0)
 assert.equal(await dialog.getByRole('tab',{name:'我的资源',exact:true}).count(),1)
 await input.waitFor();await dialog.getByRole('tab',{name:'群',exact:true}).click()
 assert.equal(await dialog.getByRole('option').count(),1);assert.match(await dialog.getByRole('option').innerText(),/原协作群/)
 await dialog.getByRole('tab',{name:'全部',exact:true}).click();await input.fill('原')
 await input.press('ArrowDown');await input.press('Enter');await dialog.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>(window as any).directorySearchFixture.opens),['task:task-original'])
 await page.getByRole('button',{name:'打开搜索',exact:true}).click();assert.equal(await input.inputValue(),'原')
 await input.press('Escape');await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'打开搜索',exact:true}).click();assert.equal(await input.inputValue(),'原')
 await page.mouse.click(4,4);await dialog.waitFor({state:'hidden'});await page.getByRole('button',{name:'打开搜索',exact:true}).click();assert.equal(await input.inputValue(),'原')
 assert.equal(await dialog.getByRole('heading',{name:'搜索',exact:true}).count(),0,'不再重复大标题')
 const styles=await dialog.getByRole('option').first().evaluate((node:HTMLElement)=>({border:getComputedStyle(node).borderTopWidth,height:node.getBoundingClientRect().height}))
 assert.equal(styles.border,'0px');assert.ok(styles.height<=58,'结果是紧凑平面行')
 assert.deepEqual(errors,[])
})
