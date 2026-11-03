import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer,type ServerResponse} from 'node:http'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用固定的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// 使用真实 BindingClient 的 HTTP 成功/失败状态，不手工设置目录 snapshot。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__work_directory_loading.tsx'
let bundled:ReturnType<typeof bundle>|undefined
async function bundle(){
 const entry=`import React,{useEffect} from 'react';import {createRoot} from 'react-dom/client';import {WorkDirectory} from '${client}WorkDirectory.tsx';import {BindingClient} from '${client}binding-client.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {createDialogueOrganization} from '${client}dialogue-organization.ts';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
 Object.entries(prototypeThemes.light).forEach(([key,value])=>document.body.style.setProperty(key,value));document.body.classList.add(tokens.tokens);
 const locale=new URL(location.href).searchParams.get('locale'),noop=()=>{},memory=new Map(),organization=createDialogueOrganization({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)});
 const work=new BindingClient({list:async()=>{const response=await fetch('/teloa/conversations/list');if(!response.ok)throw Error('503');return response.json()},current:()=>undefined,isNativeChild:()=>false});
 const managed={ready:true,baseline:true,archived:[],workspaces:[],pending:{}},management={subscribe:()=>noop,getSnapshot:()=>managed},searchState={query:'',status:'ready',items:[],hasMore:false},search={subscribe:()=>noop,getSnapshot:()=>searchState,clear:noop,run:async()=>{}};
 const groupSnapshot={status:'ready',items:[]},groups={subscribe:()=>noop,getSnapshot:()=>groupSnapshot,refresh:async()=>{}},native={byId:{'session-loading-proof':{id:'session-loading-proof',title:'保留的会话',blank:false,running:false,updatedAt:1791849600000}},ids:['session-loading-proof']};
 const snapshot={locale,dshLocale:locale,revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage(locale,key,params)};
 window.loadingFixture={refresh:()=>work.refreshDirectory(),snapshot:()=>work.getDirectorySnapshot(),text:key=>translateMessage(locale,key)};
 function App(){useEffect(()=>{void work.refreshDirectory()},[]);return <I18nProvider runtime={runtime}><WorkDirectory organization={organization} work={work} management={management} search={search} groups={groups} useSessions={select=>select(native)} current={undefined} onOpened={noop} focusRequest={0} onClose={noop} openGroup={noop} createGroup={noop}/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'work-directory-loading-fixture',resolveId:id=>id.endsWith('work-directory-loading-fixture')?entryId:null,load:id=>id===entryId?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'work-directory-loading-fixture',name:'WorkDirectoryLoading',formats:['iife']}}})
 const output=Array.isArray(result)?result[0]:result;assert.ok(output&&'output'in output)
 return {js:output.output.find(item=>item.type==='chunk')!.code,css:output.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')}
}
async function fixture(t:any,locale:string){
 bundled??=bundle();const assets=await bundled,pending:ServerResponse[]=[],requests:string[]=[],errors:string[]=[]
 const server=createServer((req,res)=>{
  if(req.url==='/teloa/conversations/list'){requests.push(req.url);pending.push(res);return}
  res.writeHead(200,{'content-type':'text/html'});res.end('<html><body><div id="root"></div></body></html>')
 });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port
 t.after(()=>{for(const res of pending)res.destroy();server.closeAllConnections();server.close()})
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:900,height:800}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(route:any)=>new URL(route.request().url()).origin===origin?route.continue():route.abort());await page.goto(origin+'/?locale='+locale);await page.addStyleTag({content:assets.css+'\nbody{font:14px var(--teloa-design-font);margin:16px;background:var(--teloa-background);color:var(--teloa-text)}[data-teloa-pane=directory]{width:330px;height:740px}'});await page.addScriptTag({content:assets.js})
 const directory=page.locator('[data-teloa-pane="directory"]'),copy=async(key:string)=>page.evaluate((key:string)=>(window as any).loadingFixture.text(key),key)
 const held=async()=>{await page.waitForFunction(()=>(window as any).loadingFixture?.snapshot().status==='loading');assert.equal(await directory.locator('[aria-busy]').getAttribute('aria-busy'),'true');assert.equal(await directory.getByRole('status').filter({hasText:await copy('workDirectory.syncing')}).isVisible(),true);assert.equal(await directory.getByText(await copy('workDirectory.empty.all'),{exact:true}).count(),0)}
 const reply=async(status:number,rows:any[]=[])=>{assert.ok(pending.length,'真实HTTP读取应已到达本轮端点');pending.shift()!.writeHead(status,{'content-type':'application/json'}).end(JSON.stringify(rows));await page.waitForFunction((expected:string)=>(window as any).loadingFixture.snapshot().status===expected,status===200?'ready':'failed');assert.equal(await directory.locator('[aria-busy]').getAttribute('aria-busy'),'false');assert.equal(await directory.getByRole('status').filter({hasText:await copy('workDirectory.syncing')}).count(),0)}
 const refresh=async()=>{await directory.getByRole('button',{name:await copy('conversationDirectory.filters'),exact:true}).click();await directory.getByRole('button',{name:await copy('workDirectory.refresh'),exact:true}).click();await page.keyboard.press('Escape');await page.waitForFunction(()=>(window as any).loadingFixture.snapshot().status==='loading');await page.waitForTimeout(30)}
 const capture=async(name:string)=>{if(process.env.TELOA_TEST_CAPTURE_DIR)await directory.screenshot({path:process.env.TELOA_TEST_CAPTURE_DIR+'/chats-'+locale+'-'+name+'.png'})}
 await page.waitForFunction(()=>(window as any).loadingFixture?.snapshot().status==='loading');await page.waitForTimeout(30)
 return {page,directory,copy,held,reply,refresh,capture,requests,errors}
}
const conversation={id:'binding-loading-proof',ownerId:'self',title:'保留的会话',scopeIds:['general'],version:1,status:'ready',sessionId:'session-loading-proof',requestedSessionId:'session-loading-proof',createdAt:'2026-10-13T00:00:00Z'}

test('Chats真实held首载→成功；缓存刷新503保留名单、查询及页签，重试成功后才显示真空',{timeout:45000},async t=>{
 const f=await fixture(t,'zh-CN');await f.held();await f.capture('cold-held');await f.directory.getByRole('button',{name:'群',exact:true}).click();assert.equal(await f.directory.locator('[aria-busy]').count(),0);assert.equal(await f.directory.getByRole('status').filter({hasText:await f.copy('workDirectory.syncing')}).count(),0);await f.directory.getByRole('button',{name:'会话',exact:true}).click();await f.held();await f.reply(200,[conversation]);await f.directory.locator('[data-session-id="session-loading-proof"]').waitFor();await f.capture('ready')
 const search=f.directory.getByRole('textbox');await search.fill('保留');await f.refresh();await f.held();assert.equal(await search.inputValue(),'保留');assert.equal(await f.directory.locator('[data-session-id="session-loading-proof"]').isVisible(),true);await f.reply(503);assert.equal(await f.directory.getByRole('alert').isVisible(),true);assert.equal(await search.inputValue(),'保留');assert.equal(await f.directory.getByRole('button',{name:'会话',exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await f.directory.locator('[data-session-id="session-loading-proof"]').isVisible(),true);await f.capture('cached-failed')
 await f.refresh();await f.held();await f.reply(200,[conversation]);assert.equal(await f.directory.getByRole('alert').count(),0);assert.equal(await search.inputValue(),'保留');await search.fill('');await f.refresh();await f.held();await f.reply(200,[]);assert.equal(await f.directory.getByText(await f.copy('workDirectory.empty.all'),{exact:true}).isVisible(),true);await f.capture('ready-empty');assert.equal(f.requests.length,4);assert.deepEqual(f.errors,[])
})
for(const locale of ['zh-Hant','en'])test('Chats '+locale+' 首载503不冒充空目录，正常刷新重试held→真空',{timeout:45000},async t=>{
 const f=await fixture(t,locale);await f.held();await f.capture('cold-held');await f.reply(503);assert.equal(await f.directory.getByRole('alert').isVisible(),true);assert.equal(await f.directory.getByText(await f.copy('workDirectory.empty.all'),{exact:true}).count(),0);await f.capture('cold-failed');await f.refresh();await f.held();await f.reply(200,[]);assert.equal(await f.directory.getByRole('alert').count(),0);assert.equal(await f.directory.getByText(await f.copy('workDirectory.empty.all'),{exact:true}).isVisible(),true);await f.capture('ready-empty');assert.equal(f.requests.length,2);assert.deepEqual(f.errors,[])
})
