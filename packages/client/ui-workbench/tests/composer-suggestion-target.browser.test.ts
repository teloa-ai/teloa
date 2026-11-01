import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createRequire} from 'node:module'
import {execFileSync} from 'node:child_process'
import http from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),req=createRequire(join(root,'package.json'))
const output=process.env.TELOA_UI_TARGET_OUTPUT
// 常规仓库测试使用自有临时目录；具名验收窗口可显式保留证据与资源护栏。
const O=output??fs.mkdtempSync(join(root,'.runtime-suggestion-target-')),guarded=process.env.TELOA_UI_TARGET_GUARD==='true'
const save=(name:string,value:unknown)=>fs.writeFileSync(join(O,name),JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600})
let browser:any,context:any,a:any,b:any,server:http.Server,timer:ReturnType<typeof setInterval>,script:string,css:string,origin:string,fatal:Error|undefined
const errors:string[]=[],network:string[]=[]
let start=0,peakRSS=0,peakOwn=0,minFree=Infinity
function resource(){
 if(!guarded)return {}
 const rows=execFileSync('/bin/ps',['-axo','pid=,ppid=,rss='],{encoding:'utf8'}).trim().split('\n').map(line=>line.trim().split(/\s+/).map(Number)),ids=new Set([process.pid])
 let changed;do{changed=false;for(const[pid,ppid]of rows)if(pid!==undefined&&ppid!==undefined&&ids.has(ppid)&&!ids.has(pid)){ids.add(pid);changed=true}}while(changed)
 const rss=rows.filter(row=>ids.has(row[0]!)).reduce((sum,row)=>sum+row[2]!*1024,0),own=Number(execFileSync('/usr/bin/du',['-sk',O],{encoding:'utf8'}).trim().split(/\s/)[0])*1024,stat=fs.statfsSync(O),free=stat.bavail*stat.bsize
 peakRSS=Math.max(peakRSS,rss);peakOwn=Math.max(peakOwn,own);minFree=Math.min(minFree,free)
 if(rss>2147483648||own>16777216||free<21695533056||Date.now()-start>120000)throw Error('TARGET_UI_RESOURCE_HOLD '+JSON.stringify({rss,own,free}))
 return{rss,own,free,pids:[...ids]}
}
// 复用固定产品组件；只有事件源/延迟supplier是具名合成夹具，不启动宿主/模型。
const entry=`
import React,{useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import {ComposerSuggestionDock} from '${client}ComposerSuggestionDock.tsx';
import {ComposerSuggestionSetting} from '${client}ComposerSuggestionSetting.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';
const source=(initial)=>{let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;for(const f of [...listeners])f()},listeners:()=>listeners.size}};
const state=source({docks:location.pathname==='/twins'?['normal','overlay']:['normal']});
const raw=source({entries:[]}),normal=source({draft:'',focused:false}),overlay=source({draft:'',focused:false});let bad=false;
const events={getSnapshot:()=>{if(bad)throw Error('F05_EXPECTED_SYNTHETIC_BOUNDARY_RENDER_FAILURE');return raw.getSnapshot()},subscribe:raw.subscribe};
const inputs={normal,overlay},calls=[],inserts=[],checks=[];let latestText=null,holdChecks=false;const pendingChecks=[];
const suggest=(signal,options)=>{if(options?.cacheOnly){checks.push({kind:'cacheOnly',aborted:!!signal?.aborted});if(holdChecks)return new Promise(resolve=>pendingChecks.push(resolve));return Promise.resolve(latestText)}return new Promise(resolve=>{const row={resolve,aborted:false};signal?.addEventListener('abort',()=>row.aborted=true,{once:true});calls.push(row)})};
const fixture={
 deferChecks:()=>{holdChecks=true},releaseChecks:()=>{holdChecks=false;for(const resolve of pendingChecks.splice(0))resolve(latestText)},
 reply:()=>raw.set({entries:[{type:'event',event:{seq:8,time:8,type:'user/message',surfaceOp:'append',data:{id:'synthetic-human',role:'user',source:{kind:'user'},content:[{type:'text',text:'合成UI机制输入'}]}}},{type:'event',event:{seq:10,time:10,type:'assistant/message',surfaceOp:'append',data:{turn:10,step:1,message:{id:'synthetic-reply',role:'assistant',content:[{type:'text',text:'合成UI机制回复'}]},interrupted:false}}},{type:'event',event:{seq:11,time:11,type:'turn/end',data:{turn:10,reason:{kind:'completed'}}}}]}),
 resolve:(i,text)=>{latestText=text;calls[i].resolve(text)},bad:()=>{bad=true;raw.set({...raw.getSnapshot()})},
 docks:keys=>state.set({docks:keys}),
 read:()=>({calls:calls.map(c=>({aborted:c.aborted})),checks:checks.length,pendingChecks:pendingChecks.length,inserts,inputs:{normal:normal.getSnapshot(),overlay:overlay.getSnapshot()},eventSubscribers:raw.listeners(),active:document.activeElement?.id,targets:[...document.querySelectorAll('[data-composer-suggestion]')].map(e=>e.parentElement.id),dom:{normal:document.getElementById('editor-normal')?.innerText,overlay:document.getElementById('editor-overlay')?.innerText}})
};window.f=fixture;
const i18n={getSnapshot:()=>snap,subscribe:()=>()=>{},t:key=>key},snap={locale:'zh-CN',dshLocale:'zh',revision:1};
function Editor({name}){return <section id={'host-'+name} style={{position:'relative',border:'1px solid #aaa',margin:24,padding:12,minHeight:80}}><label>{name==='normal'?'普通输入面':'覆盖层输入面（受控双挂载）'}</label><div id={'editor-'+name} role="textbox" aria-label={name} data-composer-input contentEditable suppressContentEditableWarning style={{minHeight:44}} onInput={e=>inputs[name].set({draft:e.currentTarget.innerText,focused:document.activeElement===e.currentTarget})}/></section>}
function App(){const view=useSyncExternalStore(state.subscribe,state.getSnapshot);
 const scope=location.pathname==='/wrong'?'other-session':'synthetic-same-session';
 const surface=name=><div id={'surface-'+name} data-conversation-session={location.pathname==='/unowned'?undefined:scope}>
  <ComposerSuggestionDock sessionId="synthetic-same-session" overlay={name==='overlay'} events={events} input={inputs[name]} running={false} suggest={suggest} insertText={text=>{inserts.push({target:name,text,active:document.activeElement?.id});document.getElementById('editor-'+name).innerText=text;inputs[name].set({draft:text,focused:true})}}/>
  <Editor name={name}/>{location.pathname==='/ambiguous'&&<Editor name="overlay"/>}{location.pathname==='/nested'&&<div data-conversation-session="nested-other-session"><Editor name="overlay"/></div>}
 </div>;
 return <I18nProvider runtime={i18n}><ComposerSuggestionSetting/><p>源码组件零模型机制；不是实装原生overlay验收</p>{view.docks.map(name=><React.Fragment key={name}>{surface(name)}</React.Fragment>)}{location.pathname==='/unowned'&&<Editor name="overlay"/>}</I18nProvider>}
createRoot(document.getElementById('root')).render(<App/>);
`

before(async()=>{
 start=Date.now();resource();save('admission.json',{at:new Date(start).toISOString(),maxMs:120000,treeRSSCap:2147483648,newBytesCap:16777216,provider:0,SDK:0,PG:0,resourceGuard:guarded,qualification:'source-component fixture; no installed native overlay claim'})
 timer=setInterval(()=>{try{resource()}catch(error){fatal=error as Error;void browser?.close()}},500)
 fs.writeFileSync(join(O,'fixture.tsx'),entry,{flag:'wx'})
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:['react','react/jsx-runtime','react-dom/client','react-dom'].map(name=>({find:new RegExp('^'+name+'$'),replacement:req.resolve(name)}))},define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{treeshake:{moduleSideEffects:false}},lib:{entry:join(O,'fixture.tsx'),name:'ScopedComposerTarget',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 css=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 server=http.createServer((request,response)=>{if(!['/twins','/tab-a','/tab-b','/boundary','/unowned','/wrong','/ambiguous','/nested'].includes(request.url??'')){response.writeHead(404);response.end();return}response.writeHead(200,{'Content-Type':'text/html'});response.end('<!doctype html><html><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address!=='string');origin='http://127.0.0.1:'+address.port
 browser=await loadPlaywright().chromium.launch({channel:'chrome',headless:true,args:['--disable-gpu','--renderer-process-limit=2','--disk-cache-size=1','--media-cache-size=1','--disable-background-networking']})
 context=await browser.newContext({viewport:{width:1100,height:760}})
 await context.route('**/*',(route:any)=>{const url=route.request().url();network.push(url);return url.startsWith(origin+'/')?route.continue():route.abort()})
 a=await context.newPage();b=await context.newPage()
})
after(async()=>{
 clearInterval(timer);await browser?.close();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()))
 save('terminal.json',{at:new Date().toISOString(),durationMs:Date.now()-start,peakRSS,peakOwn,minFree,fatal:fatal?.message??null,browserClosed:!browser?.isConnected(),staticServerClosed:!server?.listening,errors,network,provider:0,SDK:0,PG:0})
 if(!output)fs.rmSync(O,{recursive:true,force:true})
 if(fatal)throw fatal
 assert.deepEqual(network.filter(url=>!url.startsWith(origin+'/')),[])
 assert.deepEqual(errors.filter(message=>!message.includes('F05_EXPECTED_SYNTHETIC_BOUNDARY_RENDER_FAILURE')&&!message.includes('The above error occurred in the <ComposerSuggestionDockInner> component')),[])
})
async function mount(page:any,pathname:string){
 if(fatal)throw fatal
 page.setDefaultTimeout(5000)
 if(!page.__observed){page.__observed=true;page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text())})}
 await page.goto(origin+pathname);await page.addStyleTag({content:css});await page.addScriptTag({content:script});await page.getByRole('textbox',{name:'normal',exact:true}).waitFor();await page.bringToFront()
 await page.evaluate(()=>(window as any).f.reply());await page.waitForFunction(()=>(window as any).f.read().calls.length===1)
}
async function read(page:any){return page.evaluate(()=>(window as any).f.read())}
async function candidate(page:any){await page.evaluate(()=>(window as any).f.resolve(0,'本轮合成UI候选'));await page.waitForTimeout(300)}

test('同会话双输入面按真实容器和焦点采纳，共享一次请求且只写overlay草稿',async()=>{
 await mount(a,'/twins');await candidate(a)
 const before=await read(a);save('double-mount-before.json',before)
 assert.deepEqual(before.targets,['host-normal','host-overlay'])
 await a.getByRole('textbox',{name:'overlay',exact:true}).click();await a.screenshot({path:join(O,'double-mount-focus-overlay.png')});await a.keyboard.press('Tab');await a.waitForTimeout(150)
 const after=await read(a);save('double-mount-after.json',after)
 assert.equal(after.calls.length,1);assert.deepEqual(after.inserts,[{target:'overlay',text:'本轮合成UI候选',active:'editor-overlay'}]);assert.equal(after.inputs.normal.draft,'');assert.equal(after.inputs.overlay.draft,'本轮合成UI候选')
 await a.screenshot({path:join(O,'double-mount-after-tab.png')})
})
test('无归属多输入框、错误SID和同容器多个editor均不猜目标',async()=>{
 const results=[]
 for(const pathname of ['/unowned','/wrong','/ambiguous']){
  await mount(b,pathname);await candidate(b);assert.equal(await b.locator('[data-composer-suggestion]').count(),0)
  await b.getByRole('textbox',{name:'normal',exact:true}).click();await b.keyboard.press('Tab');await b.waitForTimeout(80)
  const current=await read(b);results.push({pathname,current});assert.deepEqual(current.inserts,[]);assert.equal(current.inputs.normal.draft,'')
 }
 save('rejected-targets.json',results)
})
test('嵌套其他会话不污染本容器唯一editor，Tab重验等待中换SID不写旧稿',async()=>{
 await mount(b,'/nested');await candidate(b);assert.deepEqual((await read(b)).targets,['host-normal'])
 await b.getByRole('textbox',{name:'normal',exact:true}).click();await b.keyboard.press('Tab');await b.waitForTimeout(100);assert.equal((await read(b)).inputs.normal.draft,'本轮合成UI候选')
 await mount(b,'/twins');await candidate(b);await b.getByRole('textbox',{name:'overlay',exact:true}).click();await b.evaluate(()=>(window as any).f.deferChecks());await b.keyboard.press('Tab');await b.waitForFunction(()=>(window as any).f.read().pendingChecks>0)
 await b.evaluate(()=>{document.getElementById('surface-overlay')!.dataset.conversationSession='changed-session';(window as any).f.releaseChecks()});await b.waitForTimeout(100)
 const current=await read(b);save('await-target-change.json',current);assert.deepEqual(current.inserts,[]);assert.equal(current.inputs.normal.draft,'');assert.equal(current.inputs.overlay.draft,'')
})
test('双tab真实storage同步、迟答取消和草稿隔离，关闭一页不影响另一页',async()=>{
 await mount(a,'/tab-a');await mount(b,'/tab-b');await a.bringToFront();await a.getByRole('checkbox').uncheck()
 await b.waitForFunction(()=>!document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.checked&&(window as any).f.read().calls[0].aborted)
 await a.evaluate(()=>(window as any).f.resolve(0,'A旧迟答'));await b.evaluate(()=>(window as any).f.resolve(0,'B旧迟答'));await b.waitForTimeout(100)
 assert.equal(await a.locator('[data-composer-suggestion]').count(),0);assert.equal(await b.locator('[data-composer-suggestion]').count(),0);assert.equal((await read(a)).calls[0].aborted,true)
 await a.getByRole('checkbox').check();await a.waitForFunction(()=>(window as any).f.read().calls.length===2);await b.waitForFunction(()=>(window as any).f.read().calls.length===2)
 await a.bringToFront();await a.evaluate(()=>(window as any).f.resolve(1,'A本页新候选'));await a.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='A本页新候选');await a.getByRole('textbox',{name:'normal',exact:true}).click();await a.keyboard.press('Tab');await a.waitForTimeout(100)
 const first=await read(a),second=await read(b);assert.equal(first.inputs.normal.draft,'A本页新候选');assert.equal(second.inputs.normal.draft,'');save('two-tab-isolation.json',{first,second})
 await a.close();await b.bringToFront();await b.evaluate(()=>(window as any).f.resolve(1,'B本页独立候选'));await b.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='B本页独立候选');assert.equal((await read(b)).calls[1].aborted,false);await b.screenshot({path:join(O,'two-tab-survivor.png')})
})
test('真实React错误边界隔离合成render异常，编辑器仍可输入并释放订阅',async()=>{
 await mount(b,'/boundary');await b.evaluate(()=>(window as any).f.bad());await b.waitForTimeout(150)
 await b.getByRole('textbox',{name:'normal',exact:true}).click();await b.keyboard.type('边界降级后本人草稿');await b.waitForTimeout(100)
 const current=await read(b);save('error-boundary.json',current);assert.equal(current.inputs.normal.draft,'边界降级后本人草稿');assert.equal(current.eventSubscribers,0);assert.equal(current.calls[0].aborted,true);assert.equal(await b.locator('[data-composer-suggestion]').count(),0)
 await b.screenshot({path:join(O,'boundary-editor-usable.png')})
})
