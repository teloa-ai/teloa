import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'

test('真实 DSH 概况在 767/740/699px 收起保留入口，扩大后原页签和草稿仍可继续',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url))
 const temp=await mkdtemp(join(tmpdir(),'teloa-native-overview-room-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const sidebarRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json'))
 assert.equal(JSON.parse(await readFile(join(sidebarRoot,'package.json'),'utf8')).version,DSH_VERSION)
 const end='\t\texports.apply = apply;',official=await readFile(join(sidebarRoot,'lib/client.js'),'utf8');assert.equal(official.split(end).length,2)
 // 只在临时夹具暴露固定官方组件与真实 store；不改依赖或代写 Seat/Panel。
 const sidebar=official.replace(end,'\t\texports.roomFixture={RightbarSeat,createSidebarRightStore};\n'+end)
 const officialRequire=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const frontend=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const main=join(frontend,(await readdir(frontend)).find(name=>/^index-.*\.js$/.test(name))!),frontendSource=await readFile(main,'utf8')
 const nativeStyles=(await Promise.all((await readdir(frontend)).filter(name=>name.endsWith('.css')).map(name=>readFile(join(frontend,name),'utf8')))).join('\n')
 const seedFactory=frontendSource.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],bootStart=dshFrontendBootStart(frontendSource);assert.ok(seedFactory&&bootStart>0)
 const seedSource=frontendSource.slice(0,bootStart)+'\nexport const staticSeeds='+seedFactory+'();'
 const entry=`
import {staticSeeds as seeds} from 'official-static-seeds';import {leaseNativeSidebarAccessibility} from '${client}native-sidebar-accessibility.ts';import workbenchCss from '${client}WorkbenchFrame.module.css';import {collapseOverviewWithoutRoom,collapseRightbarForDirectory,directoryNeedsRoom,directoryShown,directoryTrackWidth,rightbarTrackWidth,rightbarCanShow,rightbarDirectoryForOpening} from '${client}rightbar-width.ts';import {ConversationOverviewEntry} from '${client}ConversationOverviewTab.tsx';import {publishTeloaTabHost,notifyTeloaTabHost} from '${client}sidebar-right-tab-host.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const React=seeds.react.default??seeds.react,{createElement:h,useLayoutEffect,useState,useEffect,useSyncExternalStore}=React,{createRoot}=seeds['react-dom/client'],factories=new Map();window.__ModuleLoader__={load:row=>factories.set(row.id,row.factory)};new Function(${JSON.stringify(sidebar)})();
const resolve=id=>{if(!(id in seeds))throw Error('未授权 fixture 依赖 '+id);return seeds[id]};const {RightbarSeat,createSidebarRightStore}=factories.get('@deepseek-ai/dsh-client-ui-sidebar-right')(resolve).roomFixture;
const store=createSidebarRightStore(()=>({kind:'teloa.overview',contentId:'dsh-resource://teloa.overview/',title:'工作概览'})).create('native-room-isolated'),actions=store.actions,id='owned',mounted={getSnapshot:()=>id,subscribe:()=>()=>{}};
const face={mounted,active:()=>{const layout=store.getSnapshot().bySession[id]?.layout;if(!layout)return;const {activeTabId}=seeds['@deepseek-ai/dsh-client-ui-dockkit'].getPane(layout,layout.activePaneId);return Object.values(layout.tabs).find(tab=>tab.id===activeTabId)},isExpanded:()=>!!store.getSnapshot().bySession[id]?.layout.expanded,toggleExpanded:()=>actions.toggleExpanded(id)};
const guard=(viewport,canShow)=>collapseOverviewWithoutRoom(face,id,viewport,canShow);
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)};
const uses=selector=>selector(useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot));let currentRoom=true,currentViewport=innerWidth,setDirectoryForTest,directoryForTest,directoryVisibleForTest;
publishTeloaTabHost({render:()=>null,hasEvidence:()=>false,label:()=>undefined,bindTab:()=>{},releaseTab:()=>{},overviewRoom:{canShow:()=>currentViewport>=768&&currentRoom,guard:()=>guard(currentViewport,currentRoom)}});
function App(){const [viewport,setViewport]=useState(innerWidth),[shown,setShown]=useState(false),[directory,setDirectory]=useState(false);setDirectoryForTest=setDirectory;directoryForTest=()=>directory;useSyncExternalStore(store.subscribe,store.getSnapshot,store.getSnapshot);useEffect(()=>leaseNativeSidebarAccessibility(document.getElementById('root'),{closeLabel:'关闭',exitFullscreen:()=>actions.setMode(id,'push'),collapsePanel:()=>{if(face.isExpanded())face.toggleExpanded()}}),[]);useEffect(()=>{const resize=()=>setViewport(innerWidth);addEventListener('resize',resize);return()=>removeEventListener('resize',resize)},[]);const openingDirectory=rightbarDirectoryForOpening(viewport,directory),width=rightbarTrackWidth(546,viewport,openingDirectory),canShow=rightbarCanShow(viewport,openingDirectory,width),occupants={rightbar:shown,groupPanel:false},directoryVisible=directoryShown(viewport,directory,occupants);directoryVisibleForTest=()=>directoryVisible;const toggleDirectory=()=>{if(directoryVisible){setDirectory(false);return}if(directoryNeedsRoom(viewport,occupants))collapseRightbarForDirectory(face,id);setDirectory(true)};currentRoom=canShow;currentViewport=viewport;useLayoutEffect(()=>{guard(viewport,canShow);notifyTeloaTabHost()});return h(I18nProvider,{runtime},h('div',{className:workbenchCss.columns,style:{display:'flex',height:'100vh'}},h('aside',{'aria-label':'会话目录列',hidden:!directoryVisible,style:{width:directoryTrackWidth(viewport,directoryVisible),flex:'none'}}),h('main',{style:{flex:1,minWidth:0}},h('button',{onClick:toggleDirectory,'aria-expanded':directoryVisible},'会话目录'),h(ConversationOverviewEntry,{sessionId:id,open:()=>actions.setExpanded(id,true)}),h('button',{onClick:()=>actions.setExpanded(id,true)},'原生展开'),h('textarea',{'aria-label':'原任务草稿',defaultValue:'继续原任务'})),h('aside',{style:{width:shown?width:0,position:'relative'}},h(RightbarSeat,{sessionId:id,width,viewportWidth:viewport,canShow,useStore:uses,actions,t:key=>key,renderSlot:(name,owner,options)=>name==='sidebar.right.pane.tab'?h('textarea',{'aria-label':'概况保留草稿',defaultValue:'待继续的反馈'}):name==='sidebar.right.pane.tab.title'?options.fallback:null,syncPresentation:({shown})=>setShown(shown),measureRoom:()=>{},reportAutoFullscreen:()=>{},openTab:()=>{},closeTab:()=>{},useTabTypes:selector=>selector([{kind:'teloa.overview',keepMounted:true},{kind:'file',keepMounted:true}]),useTabNavigation:()=>({}),occurrence:()=>({current:true}),retainTab:()=>()=>{},active:true,useShortcuts:selector=>selector([]),splitPane:paneId=>actions.splitPane(id,paneId),toggleFullscreen:()=>actions.setMode(id,store.getSnapshot().bySession[id].layout.mode==='fullscreen'?'push':'fullscreen')}))))}
window.nativeRoom={store,directory:()=>directoryForTest(),directoryVisible:()=>directoryVisibleForTest(),setDirectory:value=>setDirectoryForTest(value),collapse:()=>actions.setExpanded(id,false),expand:()=>actions.setExpanded(id,true),open:(kind,suffix='')=>actions.openContent(id,{kind,contentId:'dsh-resource://'+kind+'/'+suffix,title:suffix||kind},()=>{}),viewport:()=>currentViewport,layout:()=>store.getSnapshot().bySession[id]?.layout};createRoot(document.getElementById('root')).render(h(App));
`
 await writeFile(join(temp,'fixture.mjs'),entry)
 const seedId='\0official-static-seeds',reactId='\0official-react',jsxId='\0official-jsx-runtime'
 const reactSource="import {staticSeeds} from 'official-static-seeds';const value=staticSeeds.react;export default value.default??value;export const {Children,cloneElement,createContext,createElement,createRef,forwardRef,Fragment,isValidElement,memo,startTransition,useCallback,useContext,useEffect,useId,useImperativeHandle,useLayoutEffect,useMemo,useReducer,useRef,useState,useSyncExternalStore,useTransition}=value;"
 const jsxSource="import {staticSeeds} from 'official-static-seeds';export const {Fragment,jsx,jsxs}=staticSeeds['react/jsx-runtime'];"
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'official-room-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:id===reactId?reactSource:id===jsxId?jsxSource:null}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.mjs'),name:'NativeRoomFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1024,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="zh-CN" data-platform="darwin"><body style="margin:0"><div id="root"></div></body></html>')});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const origin='http://127.0.0.1:'+((server.address() as any).port),errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(msg:any)=>{if(msg.type()==='error')errors.push(msg.text())});await page.route('**/*',(route:any)=>{if(new URL(route.request().url()).origin===origin)return route.continue();requests.push(route.request().url());return route.abort()})
 assert.ok(styles.includes('data-dockkit-strip-tabs'),'实际加载工作台公共页签样式')
 await page.goto(origin);await page.addStyleTag({content:nativeStyles+'\n'+styles});await page.addScriptTag({content:script})
 assert.ok(script.includes('window.nativeRoom'),'构建须保留测试入口')
 assert.equal(await page.evaluate(()=>!!(window as any).nativeRoom),true,'官方 fixture 必须完成装配')
 await page.waitForFunction(()=>document.querySelector('#root')?.children.length);assert.equal(await page.getByRole('button',{name:'工作概览',exact:true}).count(),1,await page.locator('#root').innerHTML())
 await page.getByRole('button',{name:'工作概览',exact:true}).click();await page.waitForFunction(()=>!!document.querySelector('[data-sidebar-right-open]'))
 assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'push')
 await page.getByRole('textbox',{name:'概况保留草稿'}).fill('保存到原页签的草稿')
 const retained=await page.evaluate(()=>(window as any).nativeRoom.layout().tabs)
 // 用户现场为 963px 且目录开着：两个真实原生入口都必须打开同一页签，不能闪现后被 canShow 收起。
 await page.evaluate(()=>(window as any).nativeRoom.collapse())
 await page.setViewportSize({width:963,height:900})
 await page.evaluate(()=>(window as any).nativeRoom.setDirectory(true))
 await page.waitForFunction(()=>(window as any).nativeRoom.viewport()===963&&(window as any).nativeRoom.directory()===true)
 assert.equal(await page.getByRole('button',{name:'工作概览',exact:true}).isDisabled(),false)
 await page.getByRole('button',{name:'工作概览',exact:true}).click()
 await page.waitForFunction(()=>!!document.querySelector('[data-sidebar-right-open]')&&(window as any).nativeRoom.directory()===true)
 assert.equal(await page.evaluate(()=>(window as any).nativeRoom.directoryVisible()),false,'概览打开时目录只在渲染期让位')
 assert.equal(await page.getByRole('complementary',{name:'会话目录列'}).isVisible(),false)
 assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'push')
 assert.equal(await page.getByRole('textbox',{name:'原任务草稿'}).inputValue(),'继续原任务')
 assert.equal(await page.getByRole('textbox',{name:'概况保留草稿'}).inputValue(),'保存到原页签的草稿')
 await page.evaluate(()=>(window as any).nativeRoom.collapse())
 await page.waitForFunction(()=>!document.querySelector('[data-sidebar-right-open]')&&(window as any).nativeRoom.directoryVisible()===true)
 assert.equal(await page.getByRole('complementary',{name:'会话目录列'}).isVisible(),true,'收起概览后原目录回来，不需要本人重新打开')
 assert.equal(await page.evaluate(()=>(window as any).nativeRoom.directory()),true)
 await page.getByRole('button',{name:'原生展开',exact:true}).click()
 await page.waitForFunction(()=>!!document.querySelector('[data-sidebar-right-open]')&&(window as any).nativeRoom.directory()===true)
 assert.deepEqual(await page.evaluate(()=>(window as any).nativeRoom.layout().tabs),retained,'让出目录不能丢失原页签')
 assert.equal(await page.evaluate(()=>(window as any).nativeRoom.directoryVisible()),false)
 // 本人主动点目录入口：收起概览并显示目录，不能静默回弹；页签与两处草稿保留。
 const directoryButton=page.getByRole('button',{name:'会话目录',exact:true})
 assert.equal(await directoryButton.getAttribute('aria-expanded'),'false','入口按实际可见状态报告')
 await directoryButton.click()
 await page.waitForFunction(()=>!document.querySelector('[data-sidebar-right-open]')&&(window as any).nativeRoom.directoryVisible()===true)
 assert.equal(await directoryButton.getAttribute('aria-expanded'),'true')
 assert.equal(await page.evaluate(()=>(window as any).nativeRoom.directory()),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).nativeRoom.layout().tabs),retained,'为目录收起概览不关闭页签')
 assert.equal(await page.getByRole('textbox',{name:'原任务草稿'}).inputValue(),'继续原任务')
 await page.getByRole('button',{name:'工作概览',exact:true}).click();await page.getByRole('textbox',{name:'概况保留草稿'}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'概况保留草稿'}).inputValue(),'保存到原页签的草稿','重新打开概览回到原页签草稿')
 // 宽窗并存，缩窄让位，放宽后原目录自动回来。
 await page.setViewportSize({width:1440,height:900});await page.waitForFunction(()=>(window as any).nativeRoom.viewport()===1440&&(window as any).nativeRoom.directoryVisible()===true)
 assert.equal(await page.locator('[data-sidebar-right-open]').count(),1,'1440 目录与概览并存')
 await page.setViewportSize({width:963,height:900});await page.waitForFunction(()=>(window as any).nativeRoom.viewport()===963&&(window as any).nativeRoom.directoryVisible()===false)
 assert.equal(await page.locator('[data-sidebar-right-open]').count(),1,'缩窄时让出目录而不是关概览')
 await page.setViewportSize({width:1440,height:900});await page.waitForFunction(()=>(window as any).nativeRoom.viewport()===1440&&(window as any).nativeRoom.directoryVisible()===true)
 assert.equal(await page.evaluate(()=>(window as any).nativeRoom.directory()),true,'放宽后恢复原目录')
 assert.equal(await page.getByRole('textbox',{name:'原任务草稿'}).inputValue(),'继续原任务')
 for(const width of [767,740,699]){
  await page.setViewportSize({width,height:900});await page.waitForFunction((width:number)=>(window as any).nativeRoom.viewport()===width,width)
  await page.evaluate(()=>(window as any).nativeRoom.expand())
  await page.waitForFunction(()=>!document.querySelector('[data-sidebar-right-open]'))
  assert.equal(await page.getByRole('textbox',{name:'原任务草稿'}).inputValue(),'继续原任务')
  const entry=page.getByRole('button',{name:'工作概览',exact:true});assert.equal(await entry.isDisabled(),true);assert.match(await entry.getAttribute('title')??'',/扩大|扩宽/)
  assert.deepEqual(await page.evaluate(()=>(window as any).nativeRoom.layout().tabs),retained,'收起不删除或复制原页签')
 }
 await page.setViewportSize({width:1024,height:900});await page.getByRole('button',{name:'工作概览',exact:true}).click();await page.getByRole('textbox',{name:'概况保留草稿'}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'概况保留草稿'}).inputValue(),'保存到原页签的草稿');assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'push')
 await page.getByRole('textbox',{name:'概况保留草稿'}).press('Escape')
 assert.equal(await page.locator('[data-sidebar-right-open]').count(),1,'右栏输入区的 Esc 交给编辑器，不收起概览')
 await page.locator('[data-dockkit-tab][aria-selected="true"]').focus();await page.keyboard.press('Escape')
 await page.waitForFunction(()=>!document.querySelector('[data-sidebar-right-open]'))
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'工作概览','Esc 收起须回到原工作概览入口')
 assert.deepEqual(await page.evaluate(()=>(window as any).nativeRoom.layout().tabs),retained,'Esc 收起保留页签')
 await page.getByRole('button',{name:'工作概览',exact:true}).click();await page.getByRole('textbox',{name:'概况保留草稿'}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'概况保留草稿'}).inputValue(),'保存到原页签的草稿','Esc 收起后草稿保留')
 const fullscreen=page.getByRole('button',{name:'chrome.toFullscreen',exact:true});await fullscreen.click()
 await page.waitForFunction(()=>document.querySelector('[data-sidebar-right-open]')?.getAttribute('data-sidebar-right-panel')==='fullscreen')
 assert.equal(await page.evaluate(()=>!!document.activeElement?.closest('[data-sidebar-right-open]')),true,'全屏须把焦点移到可见右栏')
 await page.getByRole('textbox',{name:'概况保留草稿'}).press('Escape')
 assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'fullscreen','编辑器优先处理自己的Esc')
 await page.locator('[data-dockkit-tab][aria-selected="true"]').focus()
 await page.evaluate(()=>document.activeElement!.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,bubbles:true})))
 assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'fullscreen','输入法取消不退出全屏')
 await page.evaluate(()=>{const panel=document.querySelector('[data-sidebar-right-open]')!,dialog=document.createElement('dialog');dialog.id='own-test-dialog';dialog.innerHTML='<input aria-label="原生对话框输入">';panel.appendChild(dialog);dialog.showModal();dialog.querySelector('input')!.focus()})
 await page.getByRole('textbox',{name:'原生对话框输入'}).press('Escape')
 assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'fullscreen','原生dialog关闭先于退出全屏')
 await page.evaluate(()=>document.getElementById('own-test-dialog')!.remove())
 await page.locator('[data-dockkit-tab][aria-selected="true"]').focus()
 await page.keyboard.press('Escape');await page.waitForFunction(()=>document.querySelector('[data-sidebar-right-open]')?.getAttribute('data-sidebar-right-panel')==='push')
 assert.equal(await fullscreen.evaluate((node:HTMLElement)=>node===document.activeElement),true,'退出全屏回到原控制入口')
 assert.equal(await page.getByRole('textbox',{name:'原任务草稿'}).inputValue(),'继续原任务')
 await page.setViewportSize({width:740,height:900});await page.waitForFunction(()=>(window as any).nativeRoom.viewport()===740)
 await page.evaluate(()=>(window as any).nativeRoom.open('file'));await page.waitForFunction(()=>!!document.querySelector('[data-sidebar-right-open]'))
 assert.equal(await page.locator('[data-sidebar-right-open]').getAttribute('data-sidebar-right-panel'),'fullscreen','概况守卫不改官方文件全屏规则')
 await page.evaluate(()=>(window as any).nativeRoom.open('teloa.overview'));await page.waitForFunction(()=>!document.querySelector('[data-sidebar-right-open]'))
 assert.equal(await page.locator('[data-dockkit-host="dock"]').evaluateAll((nodes:HTMLElement[])=>nodes.every(node=>node.inert)),true,'已收起的原生右栏不得继续接收键盘焦点')
 await page.setViewportSize({width:1430,height:900})
 await page.evaluate(()=>{const f=(window as any).nativeRoom;f.open('file','文件A');f.open('file','文件B');f.open('file','很长的员工档案名称与业务主题C')})
 await page.getByRole('button',{name:'dock.splitPane',exact:true}).click()
 await page.waitForFunction(()=>document.querySelectorAll('[data-dockkit-strip-tabs]').length===2)
 const current=page.locator('[data-dockkit-strip-tabs] [data-dockkit-tab][aria-selected="true"]')
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('[data-dockkit-strip-tabs] [data-dockkit-tab][aria-selected="true"]')).every(tab=>{const strip=tab.closest('[data-dockkit-strip-tabs]')!,box=strip.getBoundingClientRect(),b=tab.getBoundingClientRect();return b.left>=box.left-1&&b.right<=box.right+1}))
 assert.equal(await current.evaluateAll((tabs:HTMLElement[])=>tabs.every(tab=>{const strip=tab.closest('[data-dockkit-strip-tabs]')!,box=strip.getBoundingClientRect(),b=tab.getBoundingClientRect();return b.left>=box.left-1&&b.right<=box.right+1})),true,'分栏后每格当前页签保持可见')
 const longTab=page.locator('[data-dockkit-tab]').filter({hasText:'很长的员工档案名称与业务主题C'})
 assert.equal(await longTab.getAttribute('title'),'很长的员工档案名称与业务主题C')
 assert.equal(await longTab.locator('[data-dockkit-tab-title]').evaluate((node:HTMLElement)=>getComputedStyle(node).textOverflow),'ellipsis')
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
