import assert from 'node:assert/strict'
import {after,before,test} from 'node:test'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用本工作树的无头浏览器加载器。
import {loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222'
const address=(id:string)=>'http://127.0.0.1:49329/#teloa/v1/conversation/'+id
const homeHash='#teloa/v1/directory/home'
let script:string
const browsers=new Map<string,any>()

// 生产 history/store/BindingClient/恢复器配真实浏览器 history；原生选中与输入仅用会话隔离探针。
// 不启动服务或数据库，不冒充完整 Frame、正式原生编辑器或安装包验收。
const entry=`
import {createWorkbenchStore} from '${client}store.ts';
import {BindingClient} from '${client}binding-client.ts';
import {restoreWorkbenchConversation} from '${client}workbench-conversation-restore.ts';
import {attachWorkbenchObjectHistory,initialWorkbenchObjectNavigation,navigationForWorkbenchObject,describeWorkbenchObject} from '${client}workbench-object-url.ts';
import {captureWorkbenchNavigationState} from '${client}workbench-navigation-state.ts';
const A='${A}',B='${B}',H='33333333-3333-4333-8333-333333333333';
const rows=[A,B,H].map(id=>({id,sessionId:'session-'+id,requestedSessionId:'session-'+id,status:'ready',ownerId:'fixture-owner',scopeIds:['general'],version:1,createdAt:'2026-10-31T00:00:00Z'}));
const inputs=JSON.parse(sessionStorage.getItem('history-fixture-inputs')||'{}'),listeners=new Set();
let selected=rows[1].sessionId,adapter,lastView;
const f=window.navigationFixture={restores:[],reads:[],events:[],errors:[],submits:0};
const main={getSnapshot:()=>selected,subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener)}};
const store=createWorkbenchStore('light',initialWorkbenchObjectNavigation(undefined,location.hash)).create();
const choose=id=>{selected=id;for(const listener of listeners)listener();void work.select(id)};
const work=new BindingClient({list:async()=>rows,read:async id=>{f.reads.push(id);return rows.find(row=>row.sessionId===id)},ensure:async id=>rows.find(row=>row.sessionId===id),current:main.getSnapshot,isNativeChild:()=>false,block:()=>{},adopt:async id=>id,open:choose,catalog:async()=>{throw Error('Unexpected execution catalog')},create:async()=>{throw Error('Unexpected session creation')}});
const render=()=>{
 const state=store.getSnapshot(),inputId=state.view==='home'?rows[2].sessionId:selected;
 document.body.replaceChildren();const label=document.createElement('div');label.dataset.view=state.view;label.textContent=state.view;
 const input=document.createElement('textarea');input.dataset.session=inputId;input.value=inputs[inputId]||'';input.oninput=()=>{inputs[inputId]=input.value;sessionStorage.setItem('history-fixture-inputs',JSON.stringify(inputs))};
 document.body.append(label,input);
};
const observe=()=>{adapter?.observe(store.getSnapshot().objectNavigationRevision,work.getSnapshot().conversation?.id);render()};
const changed=()=>{
 const view=store.getSnapshot().view,enteredHome=view==='home'&&lastView!=='home';lastView=view;observe();
 if(enteredHome)choose(rows[2].sessionId);
};
for(const kind of ['popstate','hashchange'])addEventListener(kind,()=>f.events.push({kind,hash:location.hash,state:history.state}));
void work.select(selected).then(()=>{
 adapter=attachWorkbenchObjectHistory({window,scope:'fixture-owner/install',capture:()=>captureWorkbenchNavigationState(store.getSnapshot()),describe:async()=>describeWorkbenchObject(store.getSnapshot(),{conversationId:work.getSnapshot().conversation?.id}),restore:async(route,local,current,signal)=>{
  f.restores.push(route);const saved=navigationForWorkbenchObject(route,local);
  if(route.base.kind==='conversation'){const id=await restoreWorkbenchConversation(work,main,route.base.id,current,signal);if(!current())return;if(!id)throw Error('Target not restored')}
  if(current())store.actions.restoreObjectNavigation(saved);
 },error:error=>{f.errors.push(error.message)}});
 store.subscribe(changed);work.subscribe(observe);main.subscribe(observe);changed();
 f.home=()=>store.actions.navigate('home');f.state=()=>({view:store.getSnapshot().view,selected,hash:location.hash,input:document.querySelector('textarea')?.value,restores:f.restores.length,reads:f.reads.length,historyLength:history.length});f.ready=true;
});
`

before(async()=>{
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'object-history-fixture',enforce:'pre',resolveId:id=>id.endsWith('object-history-fixture')?root+'__object_history_fixture.ts':null,load:id=>id===root+'__object_history_fixture.ts'?entry:undefined}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:'object-history-fixture',name:'ObjectHistoryFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(row=>row.type==='chunk')!.code
 const pw=loadPlaywright()
 for(const engine of ['webkit','firefox'])browsers.set(engine,await pw[engine].launch({headless:true}))
})
after(async()=>{for(const browser of browsers.values())await browser.close()})

async function settle(page:any){await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
for(const engine of ['webkit','firefox'])for(const mechanism of ['Back','hash'])test(engine+' 冷 A→Home 自有草稿→'+mechanism+' 返回 A，恢复 epoch 不被旧地址去重吞掉',async t=>{
 const context=await browsers.get(engine).newContext(),page=await context.newPage(),errors:string[]=[]
 page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{
  const evidence=process.env.TELOA_NAVIGATION116_EVIDENCE
  if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,engine+'-'+mechanism+'.json'),JSON.stringify({engine,mechanism,state:await page.evaluate(()=>(window as any).navigationFixture?.state()),fixture:await page.evaluate(()=>{const f=(window as any).navigationFixture;return f&&{restores:f.restores,reads:f.reads,events:f.events,errors:f.errors,submits:f.submits}}),pageerrors:errors},null,2)+'\n')}
  await context.close();assert.deepEqual(errors,[])
 })
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<html><body></body></html>'}):route.abort())
 await page.goto(address(A));await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).navigationFixture?.ready&&document.querySelector('[data-view="messages"]'))
 await page.locator('textarea').fill('A unsent original')
 await page.evaluate(()=>(window as any).navigationFixture.home());await page.waitForFunction(()=>document.querySelector('[data-view="home"]'))
 await settle(page);assert.equal(await page.locator('textarea').inputValue(),'')
 await page.locator('textarea').fill('Home own unsent')
 const before=await page.evaluate(()=>(window as any).navigationFixture.state())
 assert.equal(new URL(page.url()).hash,homeHash)
 if(mechanism==='Back')await page.goBack();else await page.goto(address(A))
 await page.waitForFunction(()=>document.querySelector('[data-view="messages"]'))
 assert.equal(new URL(page.url()).hash,'#teloa/v1/conversation/'+A)
 assert.equal(await page.locator('textarea').inputValue(),'A unsent original')
 const restored=await page.evaluate(()=>(window as any).navigationFixture.state());assert.equal(restored.restores,before.restores+1,'重复浏览器事件不得重复恢复，同地址重新进入必须恢复')
 if(mechanism==='Back'){await page.goForward();await page.waitForFunction(()=>document.querySelector('[data-view="home"]'));assert.equal(await page.locator('textarea').inputValue(),'Home own unsent');await page.goBack();await page.waitForFunction(()=>document.querySelector('[data-view="messages"]'))}
 await page.goto(address(B));await page.waitForFunction((id:string)=>document.querySelector('textarea')?.getAttribute('data-session')==='session-'+id&&document.querySelector('[data-view="messages"]'),B)
 assert.equal(await page.locator('textarea').inputValue(),'');await page.locator('textarea').fill('B isolated unsent')
 await page.goto(address(A));await page.waitForFunction((id:string)=>document.querySelector('textarea')?.getAttribute('data-session')==='session-'+id,A)
 assert.equal(await page.locator('textarea').inputValue(),'A unsent original')
 await page.reload();await page.addScriptTag({content:script});await page.waitForFunction(()=>document.querySelector('[data-view="messages"]'));assert.equal(await page.locator('textarea').inputValue(),'A unsent original')
 await page.evaluate(()=>(window as any).navigationFixture.home());await page.waitForFunction(()=>document.querySelector('[data-view="home"]'));assert.equal(await page.locator('textarea').inputValue(),'Home own unsent')
 assert.deepEqual(await page.evaluate(()=>(window as any).navigationFixture.errors),[]);assert.equal(await page.evaluate(()=>(window as any).navigationFixture.submits),0)
})
