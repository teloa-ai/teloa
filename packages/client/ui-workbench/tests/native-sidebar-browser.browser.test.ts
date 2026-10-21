import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,readdir,rm,writeFile,mkdir} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {tmpdir} from 'node:os'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {build} from 'vite'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

/** 官方三个 Client 的原字节、公开 apply/slots/mount；仅宿主会话、语言和布局边界使用隔离夹具。 */
test('官方开始页浏览器真实装配、沙箱网页与外部打开，不授予自动化工具且关闭保留原会话',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url))
 const officialRequire=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const webRequire=createRequire(officialRequire.resolve('@deepseek-ai/dsh-web-app/package.json'))
 const names=['@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-sidebar-right','@deepseek-ai/dsh-client-ui-sidebar-browser']
 const modules=await Promise.all(names.map(async name=>{const dir=dirname(webRequire.resolve(name+'/package.json'));assert.equal(JSON.parse(await readFile(join(dir,'package.json'),'utf8')).version,DSH_VERSION);return readFile(join(dir,'lib/client.js'),'utf8')}))
 const frontend=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets'),assets=await readdir(frontend)
 const frontendSource=await readFile(join(frontend,assets.find(name=>/^index-.*\.js$/.test(name))!),'utf8'),seedFactory=frontendSource.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],bootStart=dshFrontendBootStart(frontendSource)
 assert.ok(seedFactory&&bootStart>0)
 const seedSource=frontendSource.slice(0,bootStart)+'\nexport const staticSeeds='+seedFactory+'();'
 const styles=(await Promise.all(assets.filter(name=>name.endsWith('.css')).map(name=>readFile(join(frontend,name),'utf8')))).join('\n')
 const temp=await mkdtemp(join(tmpdir(),'teloa-native-sidebar-browser-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const entry=`import {staticSeeds as seeds} from 'official-static-seeds';
async function main(){
const {Context}=seeds['@deepseek-ai/cordis'],React=seeds.react.default??seeds.react,{createElement:h}=React,{createSnapshotStore}=seeds['@deepseek-ai/dsh-client-store'];
const factories=new Map(),loaded=[];window.__ModuleLoader__={load:row=>{loaded.push(row.id);factories.set(row.id,row.factory)}};
${modules.map(source=>'new Function('+JSON.stringify(source)+')();').join('\n')}
const get=id=>{if(!(id in seeds))throw Error('未授权夹具依赖：'+id);return seeds[id]},plugins=Object.fromEntries([...factories].map(([id,factory])=>[id,factory(get)]));
const ctx=new Context(),id='original-browser-session',binding={key:id,ctx,hooks:{},keyedHooks:{},props:{sessionId:id}},current=createSnapshotStore(binding),panel=createSnapshotStore({activePanelId:null}),commands=new Map(),catalog=createSnapshotStore([]),dictionaries=new Map();let retained=0,released=0;
const locale={bind:namespace=>(key,params)=>{let value=dictionaries.get(namespace)?.zh?.[key]??key;for(const [name,text] of Object.entries(params??{}))value=value.replaceAll('{'+name+'}',String(text));return value},register:(namespace,values)=>{dictionaries.set(namespace,values);return()=>dictionaries.delete(namespace)}};
ctx.provide('locale',locale);ctx.provide('shortcuts',{catalog,register:value=>{commands.set(value.id,value);return()=>commands.delete(value.id)},closeWindow:async()=>{throw Error('不得关闭系统窗口')}});
ctx.provide('layout',{panelInfo:panel,openRightbar:()=>{},closeRightbar:()=>{}});ctx.provide('resources',{pin:()=>{}});
ctx.provide('uiSession',{adapter:{current}});ctx.provide('sessions',{retain:sessionId=>{if(sessionId!==id)throw Error('原会话丢失');retained++;return {ready:Promise.resolve(),release:()=>released++}}});
await ctx.plugin({...plugins['@deepseek-ai/dsh-client-ui-renderer'],name:'official-renderer'});
ctx.get('slots').installLocale({...createSnapshotStore({revision:1}),bind:locale.bind});ctx.get('slots').installScope('session',{current,bindingSource:()=>current,renderArea:(_binding,props)=>props.children});ctx.get('slots').bindStoreScope(binding);ctx.get('slots').provideRoot({hooks:{panelInfo:panel}});
ctx.get('slots').register({name:'root',children:{rightbar:{kind:'single'}}},({renderSlot})=>h('div',{style:{display:'flex',height:'100vh'}},h('main',{style:{flex:1,padding:24}},h('h1',null,'原会话'),h('textarea',{'aria-label':'原会话草稿',defaultValue:'保留原任务，不自动发送'})),h('aside',{style:{position:'relative',width:560}},renderSlot('rightbar',{width:560,viewportWidth:innerWidth,canShow:true}))));
await ctx.plugin({...plugins['@deepseek-ai/dsh-client-ui-sidebar-right'],name:'official-sidebar'});
await ctx.plugin({...plugins['@deepseek-ai/dsh-client-ui-sidebar-browser'],name:'official-browser'});
// 第二个隔离入口只让官方默认页选择 guide；浏览器入口、动作与 DOM 均由官方模块生成。
ctx.get('sidebarRightTabs').register({id:'fixture.other-guide',kind:'fixture.document',title:()=> '独立文档入口',guide:[{id:'document',order:20,title:()=> '独立文档入口'}]});
window.nativeBrowserFixture={ctx,loaded,commands:()=>[...commands.keys()],guides:()=>ctx.get('sidebarRightTabs').guide().map(row=>({id:row.id,kind:row.kind,commandId:row.commandId,title:row.title()})),current:()=>current.getSnapshot().key,retained:()=>({retained,released}),tools:()=>ctx.get('tools'),tabs:()=>ctx.get('sidebarRight').openTabs.getSnapshot()};
ctx.get('slots').onEntryError((key,_entry,error)=>console.error('slot failed '+key,error));window.nativeBrowserFixture.unmount=ctx.get('uiRenderer').mount(document.getElementById('root'));
} main().catch(error=>{console.error(error);throw error});
`
 await writeFile(join(temp,'fixture.mjs'),entry)
 const seedId='\0native-browser-seeds'
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'fixed-official-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:null}],build:{write:false,minify:false,target:'esnext',rollupOptions:{treeshake:{moduleSideEffects:false},output:{inlineDynamicImports:true}},lib:{entry:join(temp,'fixture.mjs'),name:'NativeBrowserFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);const script=bundle.output.filter(row=>row.type==='chunk').map(row=>row.code).join('\n')
 const documentRequests:string[]=[],server=createServer((request,response)=>{documentRequests.push(request.url??'');response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><head></head><body style="margin:0;font-family:system-ui"><div id="root"></div></body></html>')})
 await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const targetRequests:string[]=[],target=createServer((request,response)=>{targetRequests.push(request.url??'');response.setHeader('content-type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><body style="font-family:system-ui"><h1>本轮独立网页</h1><p>用户侧网页浏览，不是 Playwright 自动化会话。</p><input aria-label="网页内草稿"/></body></html>')})
 await new Promise<void>(done=>target.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>target.close(()=>done())))
 const origin='http://127.0.0.1:'+(server.address() as {port:number}).port,targetUrl='http://127.0.0.1:'+(target.address() as {port:number}).port+'/document'
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:900}});t.after(()=>page.close());page.setDefaultTimeout(7000)
 const errors:string[]=[],remote:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text())});await page.route('**/*',(route:any)=>{const url=new URL(route.request().url());if([origin,new URL(targetUrl).origin].includes(url.origin))return route.continue();remote.push(url.href);return route.abort()})
 try{
  await page.goto(origin);await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.waitForFunction(()=>!!(window as any).nativeBrowserFixture?.ctx.get('sidebarRight'))
  assert.deepEqual(await page.evaluate(()=>(window as any).nativeBrowserFixture.loaded),names)
  assert.deepEqual(await page.evaluate(()=>(window as any).nativeBrowserFixture.guides().filter((row:{kind:string})=>row.kind==='browser')),[{id:'new',kind:'browser',commandId:'browser.new',title:'浏览器'}])
  assert.ok((await page.evaluate(()=>(window as any).nativeBrowserFixture.commands())).includes('browser.new'))
  await page.evaluate(()=>(window as any).nativeBrowserFixture.ctx.get('sidebarRight').openTab('guide'));await page.getByText('开始',{exact:true}).first().waitFor();if(process.env.TELOA_NATIVE_BROWSER_TEST_OUTPUT){await mkdir(process.env.TELOA_NATIVE_BROWSER_TEST_OUTPUT,{recursive:true});await page.screenshot({path:join(process.env.TELOA_NATIVE_BROWSER_TEST_OUTPUT,'native-start-browser.png'),fullPage:true})}await page.getByRole('button',{name:/浏览器/}).click()
  const address=page.getByRole('textbox',{name:'输入 HTTP(S) 地址'});for(const blocked of ['file:///private/no-access','javascript:alert(1)','data:text/html,no-access',origin]){await address.fill(blocked);await address.press('Enter');assert.equal(await page.locator('iframe').count(),0);assert.deepEqual(targetRequests,[])}
  await address.fill(targetUrl);await address.press('Enter');const frame=page.frameLocator('iframe[data-sidebar-browser-frame="iframe"]');await frame.getByRole('heading',{name:'本轮独立网页'}).waitFor()
  assert.equal(await page.locator('iframe').getAttribute('src'),targetUrl);assert.equal(await page.locator('iframe').getAttribute('sandbox'),'allow-scripts allow-forms allow-same-origin allow-popups allow-popups-to-escape-sandbox');assert.equal(await page.locator('iframe').getAttribute('referrerpolicy'),'no-referrer')
  const popupPromise=page.waitForEvent('popup');await page.getByRole('button',{name:'在系统浏览器中打开'}).click();const popup=await popupPromise;await popup.waitForLoadState();assert.equal(popup.url(),targetUrl);assert.equal(await popup.evaluate(()=>window.opener),null);assert.equal(await popup.evaluate(()=>document.referrer),'');await popup.close()
  assert.equal(await page.evaluate(()=>(window as any).nativeBrowserFixture.tools()),undefined);assert.equal(await page.evaluate(()=>(window as any).nativeBrowserFixture.current()),'original-browser-session')
  await page.getByRole('textbox',{name:'原会话草稿'}).fill('关闭浏览器仍保留这段原稿')
  const evidence=process.env.TELOA_NATIVE_BROWSER_TEST_OUTPUT
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,'native-sidebar-browser.png'),fullPage:true})}
  await page.getByRole('button',{name:'关闭',exact:true}).click();await page.locator('iframe').waitFor({state:'detached'});assert.equal(await page.getByRole('textbox',{name:'原会话草稿'}).inputValue(),'关闭浏览器仍保留这段原稿');assert.equal(await page.evaluate(()=>(window as any).nativeBrowserFixture.current()),'original-browser-session')
  assert.deepEqual(errors,[]);assert.deepEqual(remote,[])
  if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({fixedVersion:DSH_VERSION,loaded:names,guide:'browser.new',carrier:'official sandbox iframe',targetRequests,documentRequests,toolsGranted:false,originalSession:'original-browser-session',originalDraftRetained:true,remote,errors},null,2)+'\n')
 }catch(error){const evidence=process.env.TELOA_NATIVE_BROWSER_TEST_OUTPUT;if(evidence)await page.screenshot({path:join(evidence,'failed.png'),fullPage:true});t.diagnostic(JSON.stringify({errors,targetRequests,frames:await page.locator('iframe').evaluateAll((rows:Element[])=>rows.map(row=>({src:row.getAttribute('src'),width:row.getBoundingClientRect().width,height:row.getBoundingClientRect().height}))),buttons:await page.locator('button').evaluateAll((rows:Element[])=>rows.map(row=>row.getAttribute('aria-label')))}));t.diagnostic(await page.locator('body').innerText());throw error}
})
