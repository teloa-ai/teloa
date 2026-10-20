import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// B8 Toast 回执：会话归档改为 L1 可撤销——不弹确认，左下角「已归档 · 撤销」，撤销回到原分组并恢复选中；
// 时长（成功 5 秒 / 带动作 8 秒 / 警告错误常驻）与悬停暂停用 Playwright 假时钟核对。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__toast_archive_fixture.tsx'
const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
import {WorkDirectory} from '${client}WorkDirectory.tsx';import {ConversationManagement} from '${client}conversation-management.ts';import {createDialogueOrganization} from '${client}dialogue-organization.ts';
import {ToastProvider,ToastHost,createToastStore} from '${client}Toast.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const noop=()=>{},calls=[],at='2026-10-13T01:00:00Z';
const memory=new Map([['teloa.dialogue-organization/v1',JSON.stringify({schema:'teloa.dialogue-organization/v1',assistantName:'Teloa',type:'session',folders:[{id:'research',name:'研究工作',collapsed:false}],placements:{[JSON.stringify(['session','a-session'])]:'research'}})]]);
const organization=createDialogueOrganization({getItem:key=>memory.get(key)??null,setItem:(key,value)=>memory.set(key,value)});
const row=(id,title)=>({id:'binding-'+id,ownerId:'owner',title,scopeIds:['general'],version:1,status:'ready',requestedSessionId:id,sessionId:id,createdAt:at});
const directory={status:'ready',rows:[row('a-session','原会话'),row('b-session','另一条会话')]},managed={ready:true,baseline:true,archived:[],workspaces:[],pending:{}};
const native={byId:{'a-session':{id:'a-session',title:'原会话',blank:false,running:false,updatedAt:1791763200000},'b-session':{id:'b-session',title:'另一条会话',blank:false,running:true,updatedAt:1791763100000}},ids:['a-session','b-session']};
const work={subscribe:()=>noop,getDirectorySnapshot:()=>directory,refreshDirectory:async()=>{},openConversation:async()=>'opened'},searchState={items:[],hasMore:false},groupState={status:'ready',items:[]},search={subscribe:()=>noop,getSnapshot:()=>searchState,clear:noop,run:async()=>{}},groups={subscribe:()=>noop,getSnapshot:()=>groupState,refresh:async()=>{}};
const management=new ConversationManagement(()=>directory.rows),listeners=new Set(),fixture={calls,failRestore:false};
management.attach({state:()=>managed,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},summary:id=>native.byId[id],rename:async()=>{},archive:async id=>{calls.push(['archive',id]);managed.archived=[...managed.archived,id];listeners.forEach(fn=>fn())},restore:async id=>{calls.push(['restore',id]);if(fixture.failRestore)throw Error('网络中断');managed.archived=managed.archived.filter(value=>value!==id);listeners.forEach(fn=>fn())},copyHistory:async()=>[],fork:async()=>{throw Error('no')},ensure:async()=>directory.rows[0],adopt:async()=>directory.rows[0],move:async()=>{}});
const store=createToastStore();window.toastFixture={...fixture,store,set failRestore(value){fixture.failRestore=value}};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>noop,t:(key,params)=>translateMessage('zh-CN',key,params)};
function App(){return <I18nProvider runtime={runtime}><ToastProvider store={store}><div className={tokens.tokens} style={{display:'flex',height:820}}><div style={{width:236}}/><div style={{width:340}}><WorkDirectory organization={organization} work={work} management={management} search={search} groups={groups} useSessions={fn=>fn(native)} current="a-session" onOpened={noop} focusRequest={0} onClose={noop} openGroup={noop} createGroup={noop}/></div><ToastHost/></div></ToastProvider></I18nProvider>}
createRoot(document.getElementById('root')).render(<App/>);`

async function open(t:any){
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'toast-archive-fixture',resolveId:(id:string)=>id.endsWith('toast-archive-fixture')?virtual:null,load:(id:string)=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'toast-archive-fixture',name:'ToastArchiveFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const server=createServer((_,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>{server.closeAllConnections();return new Promise<void>(resolve=>server.close(()=>resolve()))})
 const address=server.address();assert.ok(address&&typeof address==='object');const origin='http://127.0.0.1:'+address.port
 return async()=>{
  const page=await browser.newPage({viewport:{width:1280,height:820}});page.setDefaultTimeout(4000)
  const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
  await page.clock.install({time:new Date('2026-10-20T08:00:00Z')});await page.clock.pauseAt(new Date('2026-10-20T08:00:01Z'))
  await page.goto(origin);await page.addStyleTag({content:bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
  return {page,errors}
 }
}

test('归档不弹确认，左下角回执可撤销，撤销后回到原分组并恢复选中',async t=>{
 const {page,errors}=await (await open(t))()
 const directory=page.getByRole('region',{name:'会话目录',exact:true}),folder=directory.getByRole('region',{name:'研究工作',exact:true})
 await folder.getByText('原会话',{exact:true}).waitFor()
 await folder.getByRole('button',{name:'会话操作：原会话',exact:true}).click();await page.getByRole('menuitem',{name:'归档会话',exact:true}).click()
 assert.equal(await page.getByRole('dialog').count(),0,'L1 可撤销：不弹确认')
 await folder.getByText('原会话',{exact:true}).waitFor({state:'detached'})
 const toast=page.getByRole('status').filter({hasText:'已归档「原会话」'});await toast.waitFor()
 const box=await toast.boundingBox();assert.ok(box&&box.x<=24&&box.y+box.height>=820-24,'回执在左下角')
 assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'搜索目录会话','原行收起后焦点落到目录搜索框')
 await toast.getByRole('button',{name:'撤销',exact:true}).click()
 await folder.getByText('原会话',{exact:true}).waitFor()
 assert.equal(await folder.locator('[data-session-id="a-session"]').getAttribute('data-active'),'true','撤销后仍是当前选中')
 await page.clock.runFor(50);assert.equal(await page.evaluate(()=>document.activeElement?.closest('[data-session-id]')?.getAttribute('data-session-id')),'a-session','焦点回到恢复的原行')
 assert.equal(await toast.count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).toastFixture.calls),[['archive','a-session'],['restore','a-session']])
 // 运行中的会话不归档：原位提示，不调用归档、不出回执
 await directory.getByRole('button',{name:'会话操作：另一条会话',exact:true}).click();await page.getByRole('menuitem',{name:'归档会话',exact:true}).click()
 await directory.getByRole('alert').filter({hasText:'会话正在运行，结束后才能归档。'}).waitFor()
 assert.equal((await page.evaluate(()=>(window as any).toastFixture.calls)).length,2)
 // 撤销失败给常驻错误回执，可从「已归档」恢复
 await page.evaluate(()=>{(window as any).toastFixture.failRestore=true})
 await folder.getByRole('button',{name:'会话操作：原会话',exact:true}).click();await page.getByRole('menuitem',{name:'归档会话',exact:true}).click()
 await page.getByRole('status').filter({hasText:'已归档「原会话」'}).getByRole('button',{name:'撤销',exact:true}).click()
 const failed=page.getByRole('alert').filter({hasText:'没能撤销归档：'});await failed.waitFor()
 await page.clock.runFor(60_000);assert.equal(await failed.count(),1,'错误回执不自动消失')
 await failed.getByRole('button',{name:'关闭通知',exact:true}).click();assert.equal(await failed.count(),0)
 assert.deepEqual(errors,[])
})

test('成功 5 秒、带动作 8 秒，悬停与键盘聚焦暂停计时，警告常驻；最多叠放 3 条，新的在上',async t=>{
 const {page,errors}=await (await open(t))()
 const show=(input:Record<string,unknown>)=>page.evaluate((value:Record<string,unknown>)=>{(window as any).toastFixture.store.show(value)},input)
 const toasts=page.locator('[data-teloa-toasts] > *')
 await show({message:'已保存设置'});await page.getByRole('status').filter({hasText:'已保存设置'}).waitFor()
 await page.clock.runFor(4_900);assert.equal(await toasts.count(),1)
 await page.clock.runFor(200);assert.equal(await toasts.count(),0,'纯成功回执 5 秒后消失')
 await page.evaluate(()=>(window as any).toastFixture.store.show({message:'已移出列表',action:{label:'撤销',run:()=>{}}}))
 await page.clock.runFor(5_500);assert.equal(await toasts.count(),1,'带撤销的回执 5 秒时仍在')
 const actionToast=page.getByRole('status').filter({hasText:'已移出列表'})
 await actionToast.hover();await page.clock.runFor(20_000);assert.equal(await toasts.count(),1,'悬停时暂停')
 await page.mouse.move(900,100);await page.clock.runFor(2_000);assert.equal(await toasts.count(),1,'离开后从剩余时间继续')
 await page.clock.runFor(800);assert.equal(await toasts.count(),0,'带动作回执共 8 秒')
 await page.evaluate(()=>(window as any).toastFixture.store.show({message:'可键盘操作',action:{label:'查看',run:()=>{}}}))
 await page.getByRole('button',{name:'查看',exact:true}).focus();await page.clock.runFor(30_000);assert.equal(await toasts.count(),1,'键盘聚焦时暂停')
 await page.getByRole('button',{name:'关闭通知',exact:true}).click();assert.equal(await toasts.count(),0)
 await show({tone:'warning',message:'同步较慢'});const warning=page.getByRole('alert').filter({hasText:'同步较慢'});await warning.waitFor()
 await page.clock.runFor(120_000);assert.equal(await warning.count(),1,'警告不自动消失')
 for(const message of ['第一条','第二条','第三条'])await show({tone:'error',message})
 assert.equal(await toasts.count(),3);assert.deepEqual(await toasts.allInnerTexts().then((rows:string[])=>rows.map((text:string)=>text.trim())),['第三条','第二条','第一条'],'新的在上，超出挤掉最早一条')
 const colors=await page.locator('[data-teloa-toasts] > *').first().evaluate((element:HTMLElement)=>{const style=getComputedStyle(element);return [style.backgroundColor,style.color]})
 assert.deepEqual(colors,['rgb(28, 27, 25)','rgb(244, 242, 237)'],'浅色主题反色底取令牌')
 assert.deepEqual(errors,[])
})
