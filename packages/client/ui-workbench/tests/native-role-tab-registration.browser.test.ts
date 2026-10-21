import test from 'node:test'
import assert from 'node:assert/strict'
import {createRequire} from 'node:module'
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {tmpdir} from 'node:os'
import {createServer} from 'node:http'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {DSH_VERSION,dshFrontendBootStart} from './fixtures/dsh-official.ts'

test('实际DSH TabSlot注册向员工正文传递原会话目标，重开同一员工仍显示档案',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url))
 const temp=await mkdtemp(join(tmpdir(),'teloa-native-role-registration-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 const sidebarRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-sidebar-right/package.json'))
 assert.equal(JSON.parse(await readFile(join(sidebarRoot,'package.json'),'utf8')).version,DSH_VERSION)
 const end='\t\texports.apply = apply;',official=await readFile(join(sidebarRoot,'lib/client.js'),'utf8');assert.equal(official.split(end).length,2)
 // 临时暴露固定 DSH 座位、Hook 工厂和真实 controller；Frame 使用既有夹具的 API 边界。
 // 原注册循环通过 AST 提取执行，不重写其 kind/params 接线，不修改固定依赖。
 const sidebar=official.replace(end,'\t\texports.roomFixture={TabSlot,tabInfoFactory,createSidebarRightStore,createSidebarRightController,SidebarRightTabRegistry};\n'+end)
 const officialRequire=createRequire(createRequire(join(root,'package.json')).resolve('@deepseek-ai/dsh/package.json'))
 const frontend=join(dirname(officialRequire.resolve('@deepseek-ai/dsh-web-frontend/package.json')),'dist/assets')
 const main=join(frontend,(await readdir(frontend)).find(name=>/^index-.*\.js$/.test(name))!),frontendSource=await readFile(main,'utf8')
 const seedFactory=frontendSource.match(/staticModules:([A-Za-z_$][\w$]*)\(\)/)?.[1],bootStart=dshFrontendBootStart(frontendSource);assert.ok(seedFactory&&bootStart>0)
 const seedSource=frontendSource.slice(0,bootStart)+'\nexport const staticSeeds='+seedFactory+'();'
 const entrySource=await readFile(join(client,'index.ts'),'utf8'),ast=ts.createSourceFile('index.ts',entrySource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let registration=''
 const visit=(node:ts.Node)=>{if(ts.isForOfStatement(node)&&node.expression.getText(ast)==='TELOA_RAIL_KINDS')registration=node.getText(ast);ts.forEachChild(node,visit)};visit(ast);assert.ok(registration)
 const registrationJs=ts.transpileModule(registration,{compilerOptions:{target:ts.ScriptTarget.ES2024}}).outputText
 const rendererRoot=dirname(require.resolve('@deepseek-ai/dsh-client-ui-renderer/package.json')),renderer=await readFile(join(rendererRoot,'lib/client.js'),'utf8')
 const rendererExposed=renderer.replace('\t\texports.SlotRegistry = SlotRegistry;','\t\texports.tabFixture={ContextualEntry};\n\t\texports.SlotRegistry = SlotRegistry;')
 const frameSource=await readFile(join(client,'../../tests/business-builder-frame.test.ts'),'utf8'),frameAst=ts.createSourceFile('frame-test.ts',frameSource,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let frameEntryNode:ts.Expression|undefined
 const findEntry=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(frameAst)==='entry')frameEntryNode=node.initializer;ts.forEachChild(node,findEntry)};findEntry(frameAst);assert.ok(frameEntryNode)
 const frameEntry=new Function('client','return '+frameEntryNode.getText(frameAst))(client) as string
 const renderStart=frameEntry.indexOf('const frameRoot=');assert.ok(renderStart>0,'共享入口的完整声明边界必须存在')
 const framePrelude=frameEntry.slice(0,renderStart).replace("const renderSlot=", "const frameRenderSlot=")
 const frameRender=frameEntry.slice(renderStart).replace("sidebarRightFace={()=>undefined}","sidebarRightFace={()=>native.controller}")
 const entry=`
import {staticSeeds as seeds} from 'official-static-seeds';import {SidebarRightTabBody} from '${client}SidebarRightTabBody.tsx';import {SidebarRightTabTitle} from '${client}SidebarRightTabTitle.tsx';import {publishTeloaTabHost,teloaTabHost} from '${client}sidebar-right-tab-host.ts';import {TELOA_RAIL_KINDS,TELOA_TAB_IDS,teloaTabDefinition,tabToDetailTarget} from '${client}sidebar-right-tabs.ts';
const officialReact=seeds.react.default??seeds.react,{createElement:h}=officialReact,factories=new Map();window.__ModuleLoader__={load:row=>factories.set(row.id,row.factory)};new Function(${JSON.stringify(sidebar)})();new Function(${JSON.stringify(rendererExposed)})();
const resolve=id=>{if(!(id in seeds))throw Error('未授权 fixture 依赖 '+id);return seeds[id]};const {TabSlot,tabInfoFactory,createSidebarRightStore,createSidebarRightController,SidebarRightTabRegistry}=factories.get('@deepseek-ai/dsh-client-ui-sidebar-right')(resolve).roomFixture,{ContextualEntry}=factories.get('@deepseek-ai/dsh-client-ui-renderer')(resolve).tabFixture;
window.frameStartup={withRole:true,roleSession:true,roleScopes:['sales'],sessionId:'role-original'};
${framePrelude}
const sessionId='role-original',nativeStore=createSidebarRightStore(()=>({kind:'guide',contentId:'sidebar://guide',title:'引导'})).create('native-role-registration'),actions=store.actions;
const railSnapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},railRuntime={getSnapshot:()=>railSnapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},requireI18n=()=>railRuntime;
const tabs=new SidebarRightTabRegistry({effect:effect=>effect()}),native=createSidebarRightController(tabs,()=>{}, {autoFullscreen:()=>false,openWithFocus:(_id,open)=>{open();store.actions.openRightbar()},closeWithFocus:(_id,_pane,close)=>close()});native.adopt(sessionId,nativeStore);native.show(sessionId);
const slots=new seeds['@deepseek-ai/dsh-client-ui-slots'].SlotCore();slots.register({name:'root',children:{'sidebar.right.pane.tab':{kind:'keyed',scope:'session'},'sidebar.right.pane.tab.title':{kind:'keyed',scope:'session'}}},()=>null);
const rail={slots:{register:slots.register.bind(slots),inject:(_name,effect)=>effect()},effect:effect=>effect(),sidebarRightTabs:tabs,sidebarRight:native.controller};
const RAIL_TAB_TITLE_KEYS={'teloa.task':'sidebarRight.tab.task','teloa.role':'sidebarRight.tab.role','teloa.business':'sidebarRight.tab.business'};const LocalizedTabBody=props=>h(I18nProvider,{runtime:railRuntime},h(SidebarRightTabBody,props));
${registrationJs}
const nativeUses=selector=>selector(useSyncExternalStore(nativeStore.subscribe,nativeStore.getSnapshot,nativeStore.getSnapshot));const useNavigation=tabId=>useSyncExternalStore(listener=>native.controller.tabDomain.occurrence(sessionId,{id:tabId}).navigation.subscribe(listener),()=>native.controller.tabDomain.occurrence(sessionId,{id:tabId}).navigation.getSnapshot());
const nativeRenderSlot=(name,props,options)=>{const entry=slots.entries(name).find(entry=>entry.options.key===options.entryKey);return entry?h(ContextualEntry,{slotKey:name,Comp:entry.component,kit:{sessionId},standard:{sessionId},injected:entry.inject(sessionId),slotInjected:{props:{},slotHookFactories:{tabInfo:tabInfoFactory}},ownerProps:props,hookContext:options.hookContext,hasHookContext:true}):null};
function NativeRail(){const layout=nativeUses(state=>state.bySession[sessionId]?.layout);useEffect(()=>{if(layout?.expanded&&!store.getSnapshot().rightbar.shown)store.actions.openRightbar()},[layout?.expanded]);const tab=Object.values(layout?.tabs??{}).find(tab=>tab.kind==='teloa.role');return tab?h(TabSlot,{tab,seat:'sidebar.right.pane.tab',renderSlot:nativeRenderSlot,occurrence:tab=>native.controller.tabDomain.occurrence(sessionId,tab),useTabTypes:selector=>selector(TELOA_RAIL_KINDS.map(kind=>tabs.get(kind))),useTabNavigation:useNavigation,useStore:nativeUses,fullscreen:false,shortcuts:[],active:true,retainTab:()=>()=>{}}):null}
const renderSlot=(name,props,options)=>name==='rightbar'?h(NativeRail):frameRenderSlot(name,props,options);
window.nativeRole={open:params=>native.controller.openTab('teloa.role',{params}),layout:()=>nativeStore.getSnapshot().bySession[sessionId]?.layout};
${frameRender}
`
 await writeFile(join(temp,'fixture.tsx'),entry)
 const seedId='\0official-static-seeds',reactId='\0official-react',jsxId='\0official-jsx-runtime',reactDomId='\0official-react-dom-client',reactDomCoreId='\0official-react-dom'
 const reactSource="import {staticSeeds} from 'official-static-seeds';const value=staticSeeds.react;export default value.default??value;export const {Children,cloneElement,createContext,createElement,createRef,forwardRef,Fragment,isValidElement,memo,startTransition,useCallback,useContext,useEffect,useId,useImperativeHandle,useLayoutEffect,useMemo,useReducer,useRef,useState,useSyncExternalStore,useTransition}=value;"
 const jsxSource="import {staticSeeds} from 'official-static-seeds';export const {Fragment,jsx,jsxs}=staticSeeds['react/jsx-runtime'];"
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-frame-pages',enforce:'pre',load:async id=>{const names=['WorkDirectory','WorkHome','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage'];if(!names.some(name=>id===join(client,name+'.tsx')))return;if(id===join(client,'TeamPage.tsx'))return "import React from 'react';export const RoleForm=()=>null;export const TeamPage=props=>{window.frameFixture.teamProps=props;return props.embedded?<section><h2>{props.state.roles.find(role=>role.id===props.selected)?.name}</h2><p>{props.selected}</p></section>:null};";const source=await readFile(id,'utf8');return [...source.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(m=>'export const '+m[1]+'=()=>null;').join('\n');}},{name:'official-room-seeds',enforce:'pre',resolveId:(id,importer)=>id==='official-static-seeds'?seedId:id==='react'?reactId:id==='react/jsx-runtime'?jsxId:id==='react-dom/client'?reactDomId:id==='react-dom'?reactDomCoreId:importer===seedId&&id.startsWith('.')?resolve(frontend,id):null,load:id=>id===seedId?seedSource:id===reactId?reactSource:id===jsxId?jsxSource:id===reactDomId?"import {staticSeeds} from 'official-static-seeds';export const {createRoot,hydrateRoot}=staticSeeds['react-dom/client'];":id===reactDomCoreId?"import {staticSeeds} from 'official-static-seeds';const value=staticSeeds['react-dom'];export default value;export const {createPortal,flushSync}=value;":null}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'NativeRoleFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1400,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const server=createServer((_request,response)=>{response.setHeader('Content-Type','text/html');response.end('<!doctype html><html lang="zh-CN" data-platform="darwin"><body style="margin:0"><div id="root"></div></body></html>')});await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));t.after(()=>new Promise<void>(done=>server.close(()=>done())))
 const origin='http://127.0.0.1:'+((server.address() as any).port),errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(msg:any)=>{if(msg.type()==='error')errors.push(msg.text())});await page.route('**/*',(route:any)=>{if(new URL(route.request().url()).origin===origin)return route.continue();requests.push(route.request().url());return route.abort()})
 await page.goto(origin);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>!!(window as any).frameFixture).catch((error:unknown)=>{t.diagnostic(JSON.stringify(errors));throw error})
 await page.evaluate(()=>(window as any).frameFixture.navigate('team'))
 await page.waitForFunction(()=>(window as any).frameFixture.teamProps?.state.roles.some((role:{id:string})=>role.id==='r-profile'))
 await page.evaluate(async()=>{const f=(window as any).frameFixture;await f.teamProps.talk('r-profile')})
 await page.getByRole('button',{name:/^查看档案/}).click().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,...await page.evaluate(()=>({body:document.body.innerText,current:(window as any).frameFixture.current(),state:(window as any).frameFixture.state()}))}));throw error})
 await page.getByRole('region',{name:'工具与详情',exact:true}).getByRole('heading',{name:'原姓名',exact:true}).waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,...await page.evaluate(()=>({body:document.body.innerText,layout:(window as any).nativeRole.layout()}))}));throw error})
 assert.equal(await page.getByText('这个页签的目标已不可用，请关闭后重新打开。',{exact:true}).count(),0)
 await page.getByRole('textbox',{name:'slot-probe'}).fill('保留员工会话草稿')
 await page.getByRole('button',{name:/^查看档案/}).click()
 await page.getByRole('region',{name:'工具与详情',exact:true}).getByRole('heading',{name:'原姓名',exact:true}).waitFor({state:'hidden'})
 await page.getByRole('button',{name:/^查看档案/}).click()
 await page.getByRole('region',{name:'工具与详情',exact:true}).getByRole('heading',{name:'原姓名',exact:true}).waitFor()
 assert.equal(await page.getByRole('region',{name:'工具与详情',exact:true}).getByRole('heading',{name:'原姓名',exact:true}).isVisible(),true)
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'保留员工会话草稿')
 await page.evaluate(()=>(window as any).nativeRole.open({roleId:'owned-role',unexpected:true}))
 await page.getByText('这个页签的目标已不可用，请关闭后重新打开。',{exact:true}).waitFor()
 assert.equal(await page.getByRole('region',{name:'工具与详情',exact:true}).getByRole('heading',{name:'原姓名',exact:true}).count(),0,'脏参数继续严格拒绝')
 await page.getByRole('button',{name:/^查看档案/}).click()
 await page.getByRole('button',{name:/^查看档案/}).click()
 await page.getByRole('region',{name:'工具与详情',exact:true}).getByRole('heading',{name:'原姓名',exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'保留员工会话草稿')
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),'role-original')
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[])
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
