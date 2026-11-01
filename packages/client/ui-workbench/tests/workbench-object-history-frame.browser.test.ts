import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {readFile,mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import ts from 'typescript'
import {build} from 'vite'
// @ts-expect-error 复用本工作树的无头浏览器加载器。
import {loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222'
const SA='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',SB='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const url=(id:string)=>'http://127.0.0.1:49330/#teloa/v1/conversation/'+id
let script:string,browser:any

before(async()=>{
 // 复用现有完整 Frame 测试的端口装配，保留真实 Frame/store/controller/history/Home，隔离无关页面。
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('fixture.ts',source,ts.ScriptTarget.Latest,true)
 let expression:ts.Expression|undefined
 const visit=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='entry')expression=node.initializer;ts.forEachChild(node,visit)};visit(ast);assert.ok(expression)
 let entry=new Function('client','return '+expression.getText(ast))(client) as string
 const initial="if(!startup.restoreRecord)store.actions.navigate(startup.ensureHandshake?'home':'spaces');"
 assert.ok(entry.includes(initial));entry=entry.replace(initial,"store.actions.openMessages('native');")
 const index=ts.createSourceFile('index.ts',await readFile(new URL('../src/client/index.ts',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true)
 let prepare:ts.Expression|undefined
 const findPrepare=(node:ts.Node)=>{if(ts.isVariableDeclaration(node)&&node.name.getText(index)==='prepareHomeSession')prepare=node.initializer;ts.forEachChild(node,findPrepare)};findPrepare(index);assert.ok(prepare)
 const start=entry.indexOf('const prepareFrameHome='),end=entry.indexOf('\nif(startup.ensureHandshake)',start);assert.ok(start>=0&&end>start)
 entry=entry.slice(0,start)+`f.navigationTrace=[];const trace=kind=>f.navigationTrace.push({kind,hash:location.hash,view:store.getSnapshot().view,selected});let initialSessionPrepared=true;const initialSessionLifetime=new AbortController(),brandString=id=>id;const requireActions=()=>({navigate:view=>{trace('home-prepare-navigate');store.actions.navigate(view)}});const requireWorkContext=()=>({uiWorkspace:{openSession:id=>{trace('home-prepare-native-open');selected=id;for(const listener of listeners)listener();void work.select(id)}}});const prepareProductionHome=`+prepare.getText(index)+`;const prepareFrameHome=signal=>{trace('home-prepare-start');return prepareProductionHome(signal).finally(()=>trace(signal.aborted?'home-prepare-aborted':'home-prepare-return'))};`+entry.slice(end)
 const setup=`
 for(const [id,sessionId] of [['${A}','${SA}'],['${B}','${SB}']]){const row={id,sessionId,requestedSessionId:sessionId,ownerId:'self',title:id,scopeIds:['general'],status:'ready',version:1,createdAt:stamp};rows.set(sessionId,row);byId[sessionId]={...row,displayTitle:row.title}}
 selected='${SA}';void work.select(selected);f.historyEvents=[];for(const kind of ['popstate','hashchange'])addEventListener(kind,()=>f.historyEvents.push({kind,hash:location.hash}));f.readInputs=()=>Object.fromEntries([...inputs].map(([id,input])=>[id,input.draft]));
 const open=work.openSessionResult.bind(work);work.openSessionResult=async(...args)=>{const result=await open(...args);if(f.failAfterSelection&&args[0]==='${SA}'&&result==='opened'){f.failAfterSelection=false;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));f.selectedBeforeFailure={view:store.getSnapshot().view,current:selected};throw Error('controlled native selection confirmation failure')}return result};
 `
 assert.ok(entry.includes('const frameRoot='));entry=entry.replace('const frameRoot=',setup+'const frameRoot=')
 const isolated=new Set(['WorkDirectory','WorkHome','TaskPage','TeamPage','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage'].map(name=>join(client,name+'.tsx')))
 const virtual=root+'__object_history_frame.tsx'
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'object-history-frame',enforce:'pre',resolveId:id=>id.endsWith('object-history-frame')?virtual:null,load:async id=>{
  if(id===virtual)return entry
  if(!isolated.has(id))return
  const original=await readFile(id,'utf8');return [...original.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')
 }}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'object-history-frame',name:'ObjectHistoryFrame',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code
 browser=await loadPlaywright().webkit.launch({headless:true})
})
after(async()=>{await browser?.close()})

async function mount(t:any,name:string){
 const page=await browser.newPage(),errors:string[]=[];page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{
  const evidence=process.env.TELOA_NAVIGATION116_EVIDENCE
  if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,name+'.json'),JSON.stringify(await page.evaluate(()=>{const f=(window as any).frameFixture;return f&&{hash:location.hash,view:f.state().view,current:f.current(),inputs:f.readInputs(),historyEvents:f.historyEvents,navigationTrace:f.navigationTrace,explicitHomeRecovery:f.explicitHomeRecovery,sent:f.sent,controller:f.controller.getSnapshot().status}}),null,2)+'\n');await page.screenshot({path:join(evidence,name+'.png')})}
  await page.close();assert.deepEqual(errors,[])
 })
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html lang="en"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto(url(A));await page.evaluate((sessionId:string)=>{(window as any).frameStartup={sessionId,realHome:true}},SA);await page.addScriptTag({content:script})
 await page.waitForFunction((sessionId:string)=>(window as any).frameFixture?.current()===sessionId&&(window as any).frameFixture.state().view==='messages'&&(window as any).frameFixture.controller.getSnapshot().status==='ready',SA)
 return page
}

test('真实 Frame WebKit 冷 A→Home 自有草稿→返回 A，保留 A/B/Home 输入归属',async t=>{
 const page=await mount(t,'webkit-frame')
 await page.getByRole('textbox',{name:'slot-probe'}).fill('A original unsent')
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'))
 await page.waitForFunction((sessionId:string)=>(window as any).frameFixture.current()!==sessionId&&document.querySelector('textarea[aria-label="slot-probe"]'),SA)
 await page.getByRole('textbox',{name:'slot-probe'}).fill('Home own unsent')
 await page.goto(url(A));await page.waitForFunction((sessionId:string)=>(window as any).frameFixture.state().view==='messages'&&(window as any).frameFixture.current()===sessionId,SA)
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'A original unsent')
 await page.goto(url(B));await page.waitForFunction((sessionId:string)=>(window as any).frameFixture.current()===sessionId,SB)
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'');await page.getByRole('textbox',{name:'slot-probe'}).fill('B isolated unsent')
 await page.goBack();await page.waitForFunction((sessionId:string)=>(window as any).frameFixture.current()===sessionId,SA);assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'A original unsent')
 await page.goForward();await page.waitForFunction((sessionId:string)=>(window as any).frameFixture.current()===sessionId,SB);assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'B isolated unsent')
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'));await page.waitForFunction(()=>(window as any).frameFixture.state().view==='home'&&document.querySelector('textarea[aria-label="slot-probe"]'))
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'Home own unsent');assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[])
})

test('真实 Frame 恢复选中 A 后失败保持 A 地址，本人同视图回 Home 才恢复 H 且准备不循环',async t=>{
 const page=await mount(t,'webkit-explicit-home-recovery')
 await page.getByRole('textbox',{name:'slot-probe'}).fill('A protected unsent')
 await page.goto(url(B));await page.waitForFunction((id:string)=>(window as any).frameFixture.current()===id,SB)
 await page.getByRole('textbox',{name:'slot-probe'}).fill('B protected unsent')
 await page.goto(url(A));await page.waitForFunction((id:string)=>(window as any).frameFixture.current()===id,SA)
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'));await page.waitForFunction((id:string)=>(window as any).frameFixture.current()!==id&&document.querySelector('textarea[aria-label="slot-probe"]'),SA)
 await page.getByRole('textbox',{name:'slot-probe'}).fill('H protected unsent')
 await page.evaluate(()=>{const f=(window as any).frameFixture;f.failAfterSelection=true;f.explicitHomeRecovery={home:f.current(),preparesBeforeFailure:f.navigationTrace.filter((x:any)=>x.kind==='home-prepare-start').length}})
 await page.goto(url(A));await page.waitForFunction(()=>(window as any).frameFixture.selectedBeforeFailure&&document.querySelector('[role="alert"]'))
 const failed=await page.evaluate(()=>{const f=(window as any).frameFixture;return {hash:location.hash,view:f.state().view,current:f.current(),selectedBeforeFailure:f.selectedBeforeFailure,prepares:f.navigationTrace.filter((x:any)=>x.kind==='home-prepare-start').length}})
 assert.equal(failed.hash,'#teloa/v1/conversation/'+A);assert.equal(failed.view,'home');assert.equal(failed.current,SA);assert.deepEqual(failed.selectedBeforeFailure,{view:'home',current:SA})
 assert.equal(failed.prepares,await page.evaluate(()=>(window as any).frameFixture.explicitHomeRecovery.preparesBeforeFailure),'finally 不能自动重开 Home 抢走失败 A 意图')
 await page.evaluate((failed:any)=>{const f=(window as any).frameFixture;f.explicitHomeRecovery.failed=failed;f.navigate('home')},failed)
 await page.waitForFunction(()=>(window as any).frameFixture.current()===(window as any).frameFixture.explicitHomeRecovery.home&&document.querySelector('textarea[aria-label="slot-probe"]'))
 assert.equal(await page.getByRole('textbox',{name:'slot-probe'}).inputValue(),'H protected unsent')
 const prepares=await page.evaluate(()=>(window as any).frameFixture.navigationTrace.filter((x:any)=>x.kind==='home-prepare-start').length)
 await page.waitForTimeout(100)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.navigationTrace.filter((x:any)=>x.kind==='home-prepare-start').length),prepares,'生产准备表达式的 navigate(home) 不形成重新准备循环')
 const inputs=await page.evaluate(()=>(window as any).frameFixture.readInputs());assert.equal(inputs[SA],'A protected unsent');assert.equal(inputs[SB],'B protected unsent')
 await page.evaluate((prepares:number)=>{const f=(window as any).frameFixture;f.explicitHomeRecovery.after={current:f.current(),view:f.state().view,prepares,hash:location.hash}},prepares)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[])
})
