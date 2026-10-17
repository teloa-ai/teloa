import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('全局正文搜索交接原词并可同词重搜；接入仅呈现普通原生会话',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-search-handoff-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {WorkspaceSearch} from '${client}WorkspaceSearch.tsx';import {WorkDirectory} from '${client}WorkDirectory.tsx';import {ConversationSearch} from '${client}conversation-search.ts';import {ConversationManagement} from '${client}conversation-management.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);Object.assign(document.body.style,{margin:'0',fontFamily:'var(--teloa-design-font)',fontSize:'14px'});
 const f=window.searchFixture={calls:[],adoptions:[],requests:[],failNext:false,hold:false,settle:undefined},stamp='2026-10-13T00:00:00.000Z',row={id:'work-owned',sessionId:'owned',requestedSessionId:'owned',ownerId:'test-owner',title:'日常记录',scopeIds:['general'],status:'ready',version:1,createdAt:stamp};
 const directory={status:'ready',rows:[row]},groupState={status:'ready',items:[]},noop=()=>()=>{},work={subscribe:noop,getDirectorySnapshot:()=>directory,refreshDirectory:async()=>{},openConversation:async()=>{throw Error('搜索不得打开或执行会话')}},groups={subscribe:noop,getSnapshot:()=>groupState,refresh:async()=>{}};
 const native=[{id:'owned',title:'日常记录'},{id:'ordinary-fork',parentId:'parent',title:'task-run 复盘笔记'},{id:'ordinary-other',title:'项目讨论'},{id:'task-run-12345678-1234-4234-8234-123456789012',title:'内部任务机密输入'},{id:'group-routing-12345678-1234-5234-a234-123456789012',title:'内部群路由输入'},{id:'subagent',origin:'subagent',title:'内部子 Agent'}].map(r=>({...r,displayTitle:r.title,running:false,blank:false,updatedAt:1})),byId=Object.fromEntries(native.map(r=>[r.id,r])),useSessions=read=>read({byId,ids:native.map(r=>r.id)});
 const management=new ConversationManagement(()=>directory.rows);management.attach({state:()=>({ready:true,baseline:true,archived:[],workspaces:[]}),subscribe:noop,summary:id=>byId[id],adopt:async(id,requestId,title)=>{f.adoptions.push(id);f.requests.push(requestId);if(f.failNext){f.failNext=false;throw Error('会话操作失败')}if(f.hold)await new Promise(resolve=>{f.settle=resolve});const adopted={...row,id:'work-'+id,sessionId:id,requestId,title};directory.rows.push(adopted);return adopted}});
 const search=new ConversationSearch(async query=>{f.calls.push(query);return {items:[{sessionId:'owned',snippet:'正文中的 '+query},{sessionId:'subagent',snippet:'不能暴露的私有命中'}],hasMore:false}},()=>['owned']);
 const localeState={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:noop,getSnapshot:()=>localeState},source={conversations:[],tasks:[],roles:[],groups:[],spaces:[],knowledge:[],capabilities:[],market:[]};
 function App(){const [visible,setVisible]=useState(true),[request,setRequest]=useState({serial:0,query:undefined});return <I18nProvider runtime={runtime}><button onClick={()=>setVisible(true)}>再次全局搜索</button><WorkspaceSearch visible={visible} source={source} conversationStatus="" knowledgeStatus="" capabilityStatus="" close={()=>setVisible(false)} open={async()=>{throw Error('只测试正文交接')}} searchMessages={query=>setRequest(r=>({serial:r.serial+1,query}))}/>{request.serial>0&&<WorkDirectory work={work} management={management} search={search} current={undefined} useSessions={useSessions} onOpened={()=>{}} focusRequest={request.serial} focusQuery={request.query} onFocusHandled={serial=>setRequest(r=>r.serial===serial?{...r,query:undefined}:r)} onClose={()=>{}} groups={groups} selectedGroup={undefined} openGroup={()=>{}} createGroup={()=>{}}/>}</I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('本浏览器验收不允许执行宿主摘要或签名算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'SearchHandoffTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000);await page.route('**/*',(route:any)=>route.abort())
 // 接入请求使用浏览器真实 randomUUID；本机测试来源具备 secure context，不伪造密码学接口。
 await page.route('http://127.0.0.1/search-handoff',async(route:any)=>route.fulfill({contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}))
 await page.goto('http://127.0.0.1/search-handoff');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const globalInput=page.getByRole('dialog').getByRole('combobox',{name:'全局搜索',exact:true}),directoryInput=page.getByRole('textbox',{name:'搜索目录会话',exact:true})
 await globalInput.fill(' 语音 ');await page.getByRole('option',{name:/^在会话正文里搜索“语音”/}).click()
 await page.getByText('正文匹配：正文中的 语音',{exact:true}).waitFor({state:'visible'})
 assert.equal(await directoryInput.inputValue(),'语音');assert.equal(await directoryInput.evaluate((el:any)=>el===document.activeElement),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).searchFixture.calls),['语音']);assert.equal(await page.getByText('不能暴露的私有命中').count(),0)
 await directoryInput.fill('');await page.getByRole('button',{name:'再次全局搜索',exact:true}).click();await globalInput.fill('语音');await page.getByRole('option',{name:/^在会话正文里搜索“语音”/}).click()
 await page.waitForFunction(()=>(window as any).searchFixture.calls.length===2);assert.equal(await directoryInput.inputValue(),'语音')
 await directoryInput.fill('')
 const directory=page.locator('[data-teloa-pane="directory"]'),add=directory.getByRole('button',{name:'添加对话',exact:true})
 assert.equal(await directory.getByRole('heading',{name:'对话',exact:true}).count(),0)
 assert.equal(await directory.getByText('一对一和群都在这里，按最近活动排列',{exact:true}).count(),0)
 await add.click();await directoryInput.click();assert.equal(await add.getAttribute('aria-expanded'),'false')
 const openExisting=async()=>{await add.click();await page.getByRole('button',{name:'添加已有会话',exact:true}).click()}
 await openExisting()
 const adopt=page.getByRole('dialog',{name:'添加已有会话',exact:true}),find=adopt.getByRole('textbox',{name:'查找会话',exact:true})
 await adopt.waitFor({state:'visible'});assert.equal(await find.evaluate((el:any)=>el===document.activeElement),true)
 const box=await adopt.boundingBox();assert.ok(box&&box.width<=480&&box.height<320,'两条候选不应撑成大表单')
 if(process.env.TELOA_TEST_CAPTURE_DIR)await adopt.screenshot({path:join(process.env.TELOA_TEST_CAPTURE_DIR,'existing-chat-compact.png')})
 assert.equal(await adopt.getByRole('radio').count(),0);assert.equal(await adopt.getByText('task-run 复盘笔记',{exact:true}).isVisible(),true)
 assert.equal(await adopt.getByRole('button',{name:'加入工作目录',exact:true}).count(),0)
 assert.equal(await adopt.getByText(/内部任务|内部群路由|内部子 Agent/).count(),0);assert.equal(await adopt.getByText('ordinary-fork',{exact:true}).count(),0)
 await find.fill('不存在的会话');assert.equal(await adopt.getByRole('button',{name:/task-run 复盘笔记/}).count(),0)
 await find.fill('复盘');await page.evaluate(()=>{(window as any).searchFixture.failNext=true})
 await adopt.getByRole('button',{name:/task-run 复盘笔记/}).click();await adopt.getByRole('alert').waitFor({state:'visible'})
 assert.equal(await find.inputValue(),'复盘','失败仍保留搜索和列表，可以直接重试')
 await page.evaluate(()=>{(window as any).searchFixture.hold=true})
 await adopt.getByRole('button',{name:/task-run 复盘笔记/}).evaluate((el:any)=>{el.click();el.click()})
 await page.waitForFunction(()=>(window as any).searchFixture.adoptions.length===2)
 assert.deepEqual(await page.evaluate(()=>(window as any).searchFixture.adoptions),['ordinary-fork','ordinary-fork'],'快速连点只发出一次重试')
 const requestIds=await page.evaluate(()=>(window as any).searchFixture.requests);assert.equal(requestIds[0],requestIds[1],'重试复用同一个原生绑定请求')
 await page.mouse.click(5,5);await adopt.waitFor({state:'hidden'})
 await openExisting();await adopt.waitFor({state:'visible'})
 assert.equal(await adopt.getByRole('button',{name:/task-run 复盘笔记/}).isDisabled(),true,'重开不会重复提交在途会话')
 await page.evaluate(()=>(window as any).searchFixture.settle())
 await adopt.getByText('task-run 复盘笔记',{exact:true}).waitFor({state:'hidden'})
 assert.equal(await adopt.isVisible(),true,'旧请求完成不能关闭后打开的窗口')
 await page.keyboard.press('Escape');await adopt.waitFor({state:'hidden'})
 assert.equal(await add.evaluate((el:any)=>el===document.activeElement),true)
 await page.evaluate(()=>{(window as any).searchFixture.hold=false})
 await openExisting();await adopt.getByRole('button',{name:/项目讨论/}).focus();await page.keyboard.press('Enter')
 await adopt.waitFor({state:'hidden'})
 assert.deepEqual(await page.evaluate(()=>(window as any).searchFixture.adoptions),['ordinary-fork','ordinary-fork','ordinary-other'],'键盘点选即添加并关闭，不额外执行会话')
})
