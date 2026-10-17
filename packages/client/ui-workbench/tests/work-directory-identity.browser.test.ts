import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('目录刷新同一批会话仍重读员工身份；首次失败可恢复，旧代迟到结果不覆盖新关联',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__directory_identity_fixture.tsx'
 const entry=`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {translateMessage} from '${client}i18n/messages.ts';import {WorkDirectory} from '${client}WorkDirectory.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';
 const noop=()=>{},listeners=new Set(),conversation={id:'binding',ownerId:'owner',title:'Original chat',scopeIds:['general'],version:1,status:'ready',requestedSessionId:'session',sessionId:'session',createdAt:'2026-10-12T00:00:00Z'};
 let directory={status:'ready',rows:[conversation]},attempt=0;
 const f=window.identityAudit={mode:'fail',held:false,release:noop,calls:()=>attempt};
 const work={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getDirectorySnapshot:()=>directory,
  refreshDirectory:async()=>{directory={status:'ready',rows:[conversation]};for(const listener of listeners)listener()},openConversation:async()=> 'opened'};
 const objectApi={bySession:async sessionId=>{attempt++;const captured=f.mode;if(captured==='fail')throw Error('temporary failure');if(captured==='hold'){f.held=true;await new Promise(resolve=>f.release=resolve)}return [{kind:'role',sessionId,objectId:captured==='bob'?'b':captured==='twin'?'t':'a',active:true}]}};
 const managed={ready:true,baseline:true,archived:[],workspaces:[],pending:{}},searchState={items:[],hasMore:false};
 const management={subscribe:()=>noop,getSnapshot:()=>managed},search={subscribe:()=>noop,getSnapshot:()=>searchState,clear:noop};
 const groupSnapshot={status:'ready',items:[]},groups={subscribe:()=>noop,getSnapshot:()=>groupSnapshot,refresh:async()=>{}};
 const native={byId:{session:{id:'session',title:'Original chat',blank:false,running:false,updatedAt:1791763200000}},ids:['session']};
 const roles=[{id:'a',name:'Alice',kind:'employee',avatarKey:'squirrel-general'},{id:'b',name:'Bob',kind:'employee',avatarKey:'general'},{id:'t',name:'Stored twin',kind:'twin'}];
 const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('en',key,params)};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><button onClick={()=>work.refreshDirectory()}>Refresh verified directory</button><WorkDirectory work={work} management={management} search={search} groups={groups} objectApi={objectApi} roles={roles} useSessions={select=>select(native)} current="session" onOpened={noop} focusRequest={0} onClose={noop} openGroup={noop} createGroup={noop}/></I18nProvider>);
 `
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'directory-identity-fixture',resolveId:id=>id.endsWith('directory-identity-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'directory-identity-fixture',name:'DirectoryIdentityFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:800}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.route('http://127.0.0.1:49320/work-directory-identity',(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1:49320/work-directory-identity');await page.evaluate(()=>localStorage.setItem('teloa.personal-profile/v1',JSON.stringify({displayName:'Max Luo'})));await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).identityAudit.calls()===1)
 assert.equal(await page.getByText('Chat with Alice',{exact:true}).count(),0)
 await page.evaluate(()=>(window as any).identityAudit.mode='alice')
 await page.getByRole('button',{name:'Refresh verified directory',exact:true}).click()
 await page.getByRole('button',{name:'Employees',exact:true}).click();await page.getByText('Chat with Alice',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).identityAudit.mode='hold')
 await page.getByRole('button',{name:'Refresh verified directory',exact:true}).click()
 await page.waitForFunction(()=>(window as any).identityAudit.held)
 assert.equal(await page.getByText('Chat with Alice',{exact:true}).count(),0,'未核实的新目录代次不显示旧员工')
 await page.evaluate(()=>(window as any).identityAudit.mode='bob')
 await page.getByRole('button',{name:'Refresh verified directory',exact:true}).click()
 await page.getByText('Chat with Bob',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).identityAudit.release())
 await page.waitForTimeout(0)
 assert.equal(await page.getByText('Chat with Alice',{exact:true}).count(),0)
 assert.equal(await page.getByText('Chat with Bob',{exact:true}).count(),1)
 assert.equal(await page.getByText('Original chat',{exact:true}).count(),1,'员工身份变化仍保留原会话标题')
 assert.equal(await page.locator('[data-session-id="session"]').getByRole('button').first().isEnabled(),true,'原会话仍可继续打开，空闲状态不靠重复 Continue 文案表达')
 await page.evaluate(()=>(window as any).identityAudit.mode='twin')
 await page.getByRole('button',{name:'Refresh verified directory',exact:true}).click()
 const twin=page.locator('[data-session-id="session"] [data-teloa-twin-avatar]');await twin.waitFor()
 assert.equal(await twin.innerText(),'ML')
 assert.match(await page.locator('[data-session-id="session"]').innerText(),/Max Luo/)
 assert.doesNotMatch(await page.locator('[data-session-id="session"]').innerText(),/Stored twin/)
 assert.deepEqual(errors,[])
})

test('助手目录按本人昵称显示、检索与键盘操作，重命名仍编辑原话题且不冒认普通同名会话',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__directory_assistant_identity_fixture.tsx'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
 import {WorkDirectory} from '${client}WorkDirectory.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 import {createDialogueOrganization} from '${client}dialogue-organization.ts';import {ConversationSearch} from '${client}conversation-search.ts';import assistantAvatar from '${client}../brand/companion/icon.webp';
 import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
 Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
 const noop=()=>{},listeners=new Set(),memory=new Map(),organization=createDialogueOrganization({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)});
 organization.renameAssistant('小罗同学');
 const make=(id,title,purpose)=>({id:'binding-'+id,ownerId:'owner',title,...purpose?{purpose}:{},scopeIds:['general'],version:1,status:'ready',requestedSessionId:id,sessionId:id,createdAt:'2026-10-12T00:00:00Z'});
 let rows=[make('assistant','Teloa 小松鼠助手','assistant'),make('ordinary','Teloa 小松鼠助手'),make('custom','我的独立话题'),make('employee','原员工话题')],directory={status:'ready',rows};
 const f=window.assistantDirectoryAudit={opens:[],writes:[],moves:[],searches:[],organization,assistantAvatar,original:rows[0],setTopic:title=>{rows=rows.map(row=>row.sessionId==='assistant'?{...row,title}:row);directory={status:'ready',rows};for(const listener of listeners)listener()}};
 const work={subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)},getDirectorySnapshot:()=>directory,openConversation:async row=>{f.opens.push({sessionId:row.sessionId,title:row.title,original:row===rows.find(item=>item.sessionId===row.sessionId)});return 'opened'}};
 const managed={ready:true,baseline:true,archived:[],workspaces:[{workspaceId:'workspace',title:'测试工作区',path:'/fixture',sessionIds:rows.map(row=>row.sessionId)}],pending:{},copyHistory:[],uncertain:[],copies:{}};
 const management={subscribe:()=>noop,getSnapshot:()=>managed,rename:async(...args)=>f.writes.push(args),move:async(...args)=>f.moves.push(args)};
 const search=new ConversationSearch(async query=>{f.searches.push(query);return {items:query==='正文命中'?[{sessionId:'custom',snippet:'真实正文摘要'}]:[],hasMore:false}},()=>rows.map(row=>row.sessionId));
 const groupSnapshot={status:'ready',items:[]},groups={subscribe:()=>noop,getSnapshot:()=>groupSnapshot,refresh:async()=>{}},native={byId:Object.fromEntries(rows.map(row=>[row.sessionId,{id:row.sessionId,title:row.title,blank:false,running:false,updatedAt:1791763200000}])),ids:rows.map(row=>row.sessionId)};
 const roles=[{id:'role',name:'研究员',kind:'employee',avatarKey:'squirrel-general'}],objectApi={bySession:async sessionId=>sessionId==='employee'?[{kind:'role',sessionId,objectId:'role',active:true}]:[]};
 const snapshot={locale:'en',dshLocale:'en',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('en',key,params)};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><WorkDirectory organization={organization} work={work} management={management} search={search} groups={groups} objectApi={objectApi} roles={roles} useSessions={select=>select(native)} current="assistant" onOpened={noop} focusRequest={0} onClose={noop} openGroup={noop} createGroup={noop}/></I18nProvider>);`
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'directory-assistant-identity-fixture',resolveId:id=>id.endsWith('directory-assistant-identity-fixture')?virtual:null,load:id=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'directory-assistant-identity-fixture',name:'DirectoryAssistantIdentityFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:430,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.route('http://127.0.0.1:49320/work-directory-assistant',(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="en"><body><div id="root"></div></body></html>'}));await page.goto('http://127.0.0.1:49320/work-directory-assistant')
 await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')+'\nbody{margin:0;font:14px var(--teloa-design-font)}[data-teloa-pane="directory"]{width:100%;height:850px}'});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const directory=page.locator('[data-teloa-pane="directory"]'),assistant=directory.locator('[data-session-id="assistant"]'),ordinary=directory.locator('[data-session-id="ordinary"]'),query=directory.getByRole('textbox',{name:'Search directory conversations',exact:true})
 await assistant.getByText('小罗同学',{exact:true}).waitFor()
 const failures:string[]=[],check=(actual:unknown,expected:unknown,label:string)=>{if(actual!==expected)failures.push(label+': '+JSON.stringify({actual,expected}))}
 check(await assistant.getByRole('button').first().getAttribute('title'),'小罗同学','悬浮名称')
 check(await assistant.getByRole('button',{name:'Conversation actions: 小罗同学',exact:true}).count(),1,'菜单可访问名称')
 check(await assistant.locator('img').count(),1,'共享品牌头像')
 if(await assistant.locator('img').count()){
  assert.equal(await assistant.locator('img').getAttribute('src'),await page.evaluate(()=>(window as any).assistantDirectoryAudit.assistantAvatar))
  assert.equal(await assistant.locator('img').getAttribute('alt'),'')
 }
 assert.equal(await ordinary.getByText('Teloa 小松鼠助手',{exact:true}).count(),1)
 assert.equal(await ordinary.locator('img').count(),0,'普通同名会话不冒认助手')
 await query.fill('小罗同学');await page.waitForFunction(()=>(window as any).assistantDirectoryAudit.searches.includes('小罗同学'))
 check(await assistant.count(),1,'昵称可检索');assert.equal(await ordinary.count(),0)
 await query.fill('正文命中');await directory.getByText('Content match: 真实正文摘要',{exact:true}).waitFor()
 assert.equal(await directory.locator('[data-session-id="custom"]').count(),1,'原正文搜索仍按真实回执显示')
 await query.fill('');await assistant.waitFor()
 const filters=directory.getByRole('button',{name:'Filter and manage conversations',exact:true});await filters.click()
 const panel=directory.getByRole('dialog',{name:'Filter and manage conversations',exact:true})
 await panel.getByRole('combobox',{name:'Filter conversations by execution location',exact:true}).selectOption('workspace:workspace')
 await panel.getByRole('combobox',{name:'Conversation order',exact:true}).selectOption('manual');await page.keyboard.press('Escape')
 check(await assistant.getByRole('button',{name:'Move conversation up: 小罗同学',exact:true}).count(),1,'上移可访问名称')
 check(await assistant.getByRole('button',{name:'Move conversation down: 小罗同学',exact:true}).count(),1,'下移可访问名称')
 // 即使旧源仍有错误名称，也继续走真实菜单和原重命名窗口，收齐显示缺陷的同一轮红证据。
 const menu=assistant.getByRole('button',{name:/^Conversation actions:/});await menu.focus();await page.keyboard.press('Enter')
 check(await page.getByRole('menu',{name:'Manage conversation: 小罗同学',exact:true}).count(),1,'展开菜单名称')
 await page.getByRole('menuitem',{name:'Rename',exact:true}).click()
 const dialog=page.getByRole('dialog',{name:'Rename',exact:true}),name=dialog.getByRole('textbox',{name:'Conversation name',exact:true});await name.waitFor()
 assert.equal(await name.inputValue(),'Teloa 小松鼠助手','昵称投影不替换持久话题编辑值')
 await name.fill('未提交话题草稿');await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 assert.equal(await menu.evaluate((node:HTMLElement)=>node===document.activeElement),true,'Escape返回原稳定菜单入口')
 await menu.press('Enter');await page.getByRole('menuitem',{name:'Rename',exact:true}).click();assert.equal(await name.inputValue(),'未提交话题草稿');await page.keyboard.press('Escape')
 await assistant.getByRole('button').first().focus();await page.keyboard.press('Enter')
 assert.deepEqual(await page.evaluate(()=>(window as any).assistantDirectoryAudit.opens),[{sessionId:'assistant',title:'Teloa 小松鼠助手',original:true}])
 await page.evaluate(()=>(window as any).assistantDirectoryAudit.organization.renameAssistant('小罗'))
 await assistant.getByText('小罗',{exact:true}).waitFor();check(await assistant.getByRole('button').first().getAttribute('title'),'小罗','同页昵称更新')
 await page.evaluate(()=>(window as any).assistantDirectoryAudit.setTopic('已命名的助手话题'));await assistant.getByText('已命名的助手话题',{exact:true}).waitFor().catch(()=>failures.push('保留助手独立话题'))
 await query.fill('我的独立话题');await directory.locator('[data-session-id="custom"]').waitFor();assert.equal(await assistant.count(),0)
 await query.fill('');await directory.getByRole('button',{name:'Employees',exact:true}).click();await directory.getByText('Chat with 研究员',{exact:true}).waitFor();assert.equal(await directory.getByText('原员工话题',{exact:true}).count(),1)
 assert.equal(await directory.getByRole('button',{name:'Conversation actions: 原员工话题',exact:true}).count(),1,'员工会话操作仍以原话题区分，不改成员身份或话题语义')
 await directory.getByRole('button',{name:'Chats',exact:true}).click()
 const bounds=await directory.evaluate((node:HTMLElement)=>({client:node.clientWidth,scroll:node.scrollWidth}));assert.equal(bounds.scroll,bounds.client,'430窄屏无横向溢出')
 if(process.env.TELOA_TEST_CAPTURE_DIR)await directory.screenshot({path:process.env.TELOA_TEST_CAPTURE_DIR+'/directory-assistant-430.png'})
 assert.deepEqual(await page.evaluate(()=>({writes:(window as any).assistantDirectoryAudit.writes,moves:(window as any).assistantDirectoryAudit.moves})),{writes:[],moves:[]})
 assert.deepEqual(errors,[]);assert.deepEqual(failures,[])
})
