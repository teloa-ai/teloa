import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React,{useSyncExternalStore} from 'react';import {createRoot} from 'react-dom/client';
import {ComposerSuggestionDock} from '${client}ComposerSuggestionDock.tsx';
import {ComposerSuggestionSetting} from '${client}ComposerSuggestionSetting.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const source=initial=>{let value=initial;const listeners=new Set();return {getSnapshot:()=>value,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)},set:next=>{value=next;listeners.forEach(fn=>fn())}}};
const config=window.suggestionMountConfig??{},ids=['session-a','session-b'],events=Object.fromEntries(ids.map(id=>[id,source({entries:[]})])),inputs=Object.fromEntries(ids.map(id=>[id,source({draft:'',focused:false})])),view=source({sessionId:ids[0],docks:config.docks??['primary']}),calls=[],inserts=[];
const last=id=>events[id].getSnapshot().entries.filter(row=>row.event.type==='assistant/message').at(-1)?.event;
const suggest=Object.fromEntries(ids.map(id=>[id,signal=>new Promise((resolve,reject)=>{const call={sessionId:id,seq:last(id)?.seq,signal,aborted:signal?.aborted??false,resolve,reject};signal?.addEventListener('abort',()=>{call.aborted=true},{once:true});calls.push(call)})]));
const fixture={
 calls:()=>calls.map(({sessionId,seq,aborted})=>({sessionId,seq,aborted})),inserts:()=>inserts.slice(),
 reply:(id,seq,text)=>{const turn=seq,at=seq*1000,previous=events[id].getSnapshot().entries;events[id].set({entries:[...previous,
  {type:'event',event:{seq:seq-2,time:at-2,type:'user/message',surfaceOp:'append',data:{id:id+'-human-'+seq,role:'user',source:{kind:'user'},content:[{type:'text',text:'继续核对这批材料'}]}}},
  {type:'event',event:{seq,time:at,type:'assistant/message',surfaceOp:'append',data:{turn,step:1,message:{id:id+'-answer-'+seq,role:'assistant',content:[{type:'text',text}]},interrupted:false}}},
  {type:'event',event:{seq:seq+1,time:at+1,type:'turn/end',data:{turn,reason:{kind:'completed'}}}}
 ]})},
 resolve:(index,text)=>{if(!calls[index])throw Error('不存在的模型请求');calls[index].resolve(text)},
 reject:index=>{if(!calls[index])throw Error('不存在的模型请求');calls[index].reject(Error('合成模型不可用'))},
 select:id=>view.set({...view.getSnapshot(),sessionId:id}),docks:keys=>view.set({...view.getSnapshot(),docks:keys}),draft:(id,text)=>inputs[id].set({draft:text,focused:false}),
 entries:id=>events[id].getSnapshot().entries,publish:(id,entries)=>events[id].set({entries}),replay:id=>events[id].set({entries:structuredClone(events[id].getSnapshot().entries)}),
 settle:()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))),
};window.suggestionModelFixture=fixture;
const locale='zh-CN',snapshot={locale,dshLocale:'zh',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage(locale,key,params)};
function App(){const {sessionId,docks}=useSyncExternalStore(view.subscribe,view.getSnapshot),history=useSyncExternalStore(events[sessionId].subscribe,events[sessionId].getSnapshot),input=useSyncExternalStore(inputs[sessionId].subscribe,inputs[sessionId].getSnapshot);const answer=history.entries.filter(row=>row.event.type==='assistant/message').at(-1)?.event.data.message.content[0].text??'';
 return <I18nProvider runtime={runtime}><ComposerSuggestionSetting/><main data-slot="main.conversation"><div className="markdown">{answer}</div></main>
 <div style={{position:'relative',width:600,minHeight:100,border:'1px solid gray'}}><span className="_placeholder">输入消息</span><div data-composer-input contentEditable suppressContentEditableWarning role="textbox" aria-label="本人草稿" style={{position:'relative',minHeight:70}} onInput={event=>fixture.draft(sessionId,event.currentTarget.textContent??'')}>{input.draft}</div></div>
 {docks.map(key=><ComposerSuggestionDock key={key} sessionId={sessionId} events={events[sessionId]} input={inputs[sessionId]} running={false} suggest={suggest[sessionId]} insertText={text=>{inserts.push({sessionId,text});fixture.draft(sessionId,text)}}/>)}
 </I18nProvider>}
if(config.initialReply)fixture.reply('session-a',10,'请把清单原件发过来，我再逐项核对。');
createRoot(document.getElementById('root')).render(config.strict?<React.StrictMode><App/></React.StrictMode>:<App/>);
`

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-suggestion-model-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'SuggestionModelFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function mount(t:any,enabled=true,config:{strict?:boolean;docks?:string[];initialReply?:boolean}={}){
 const page=await browser.newPage({viewport:{width:1000,height:700}}),errors:string[]=[]
 page.setDefaultTimeout(4000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().url()==='http://suggestion-fixture.test/'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://suggestion-fixture.test/')
 await page.evaluate((value:boolean)=>localStorage.setItem('teloa.composer-suggestion.enabled',String(value)),enabled)
 await page.evaluate((value:unknown)=>(window as any).suggestionMountConfig=value,config)
 await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('textbox',{name:'本人草稿'}).waitFor()
 return page
}
const promptForMaterial='请把清单原件发过来，我再逐项核对。'
async function reply(page:any,seq=10,text=promptForMaterial,id='session-a'){
 await page.evaluate(({id,seq,text}:any)=>(window as any).suggestionModelFixture.reply(id,seq,text),{id,seq,text})
}
async function calls(page:any){return page.evaluate(()=>(window as any).suggestionModelFixture.calls())}
async function waitCalls(page:any,count:number){await page.waitForFunction((expected:number)=>(window as any).suggestionModelFixture.calls().length===expected,count)}
async function settle(page:any){await page.evaluate(()=>(window as any).suggestionModelFixture.settle())}
const ghost=(page:any)=>page.locator('[data-composer-suggestion]')

test('模型请求 pending 时不先显示材料模板或更改本人草稿',async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1);await settle(page)
 assert.equal(await ghost(page).count(),0,'模型尚未返回时不应显示“我把材料发给你。”')
 assert.equal(await page.getByRole('textbox',{name:'本人草稿'}).textContent(),'')
 assert.deepEqual(await page.evaluate(()=>(window as any).suggestionModelFixture.inserts()),[])
})

test('灰字准确使用宿主模型结果，Tab 仅将该结果带入草稿',async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'好'))
 await page.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='好')
 assert.equal(await page.getByRole('textbox',{name:'本人草稿'}).textContent(),'')
 await page.keyboard.press('Tab');await settle(page)
 assert.equal(await page.getByRole('textbox',{name:'本人草稿'}).textContent(),'好')
 assert.deepEqual(await page.evaluate(()=>(window as any).suggestionModelFixture.inserts()),[{sessionId:'session-a',text:'好'}])
 assert.equal(await ghost(page).count(),0)
})

for(const outcome of ['null','failure'] as const)test(`模型 ${outcome} 时保持无灰字，不退回模板`,async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1)
 await page.evaluate((result:'null'|'failure')=>{const f=(window as any).suggestionModelFixture;if(result==='null')f.resolve(0,null);else f.reject(0)},outcome)
 await settle(page);assert.equal(await ghost(page).count(),0)
 assert.equal(await page.getByRole('textbox',{name:'本人草稿'}).textContent(),'')
})

test('设置关闭时不请求，开启后才请求当前回复',async t=>{
 const page=await mount(t,false);await reply(page);await page.waitForTimeout(1800)
 assert.deepEqual(await calls(page),[],'关闭状态不能产生辅助模型请求')
 assert.equal(await ghost(page).count(),0)
 await page.getByRole('checkbox').check();await waitCalls(page,1)
 assert.deepEqual((await calls(page)).map((row:any)=>[row.sessionId,row.seq]),[['session-a',10]])
})

test('关闭设置中止在途请求，迟答不显示；再次开启使用最新回复',async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1)
 await page.getByRole('checkbox').uncheck();await settle(page)
 assert.equal((await calls(page))[0].aborted,true,'关闭设置须向在途请求传递取消')
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'已关闭请求的迟答'));await settle(page)
 assert.equal(await ghost(page).count(),0)
 await reply(page,20,'仍缺少这批原件，请核对。');await page.waitForTimeout(1800)
 assert.equal((await calls(page)).length,1)
 await page.getByRole('checkbox').check();await waitCalls(page,2)
 assert.equal((await calls(page))[1].seq,20)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(1,'请先列出缺少的文件'))
 await page.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='请先列出缺少的文件')
})

test('正文相同而事件 seq 不同的两次回复独立请求，不用正文 hash 代替身份',async t=>{
 const page=await mount(t);await reply(page,10);await waitCalls(page,1)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'第一轮的模型建议'));await settle(page)
 await reply(page,20);await waitCalls(page,2)
 assert.deepEqual((await calls(page)).map((row:any)=>row.seq),[10,20])
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(1,'第二轮的模型建议'))
 await page.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='第二轮的模型建议')
})

test('切换会话中止旧请求，迟答不污染新会话也不覆盖本人草稿',async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1)
 await page.evaluate(()=>{const f=(window as any).suggestionModelFixture;f.draft('session-b','本人正在编辑的新会话草稿');f.select('session-b')});await settle(page)
 assert.equal((await calls(page))[0].aborted,true)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'旧会话迟到的建议'));await settle(page)
 assert.equal(await ghost(page).count(),0)
 assert.equal(await page.getByRole('textbox',{name:'本人草稿'}).textContent(),'本人正在编辑的新会话草稿')
 assert.deepEqual(await page.evaluate(()=>(window as any).suggestionModelFixture.inserts()),[])
 assert.equal((await calls(page)).length,1)
})

test('本人在模型等待期间输入草稿，模型结果不覆盖或抢占输入',async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1)
 await page.getByRole('textbox',{name:'本人草稿'}).fill('我自己的后续问题')
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'模型给的另一句话'));await settle(page)
 assert.equal(await page.getByRole('textbox',{name:'本人草稿'}).textContent(),'我自己的后续问题')
 assert.equal(await ghost(page).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).suggestionModelFixture.inserts()),[])
})

test('StrictMode 双 dock 共享一次请求，移除发起 dock 不取消仍在使用的请求',async t=>{
 const page=await mount(t,true,{strict:true,docks:['primary','secondary'],initialReply:true});await waitCalls(page,1);await settle(page)
 assert.equal((await calls(page))[0].aborted,false)
 await page.evaluate(()=>(window as any).suggestionModelFixture.docks(['secondary']));await settle(page)
 assert.equal((await calls(page)).length,1);assert.equal((await calls(page))[0].aborted,false)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'共享模型建议'))
 await page.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='共享模型建议')
 await page.keyboard.press('Tab');await settle(page)
 assert.deepEqual(await page.evaluate(()=>(window as any).suggestionModelFixture.inserts()),[{sessionId:'session-a',text:'共享模型建议'}])
 assert.equal(await ghost(page).count(),0)
})

test('最后一个 dock 离开取消共享请求，重新挂载后旧回包不能替换新请求',async t=>{
 const page=await mount(t,true,{strict:true,docks:['primary','secondary'],initialReply:true});await waitCalls(page,1)
 await page.evaluate(()=>(window as any).suggestionModelFixture.docks([]));await settle(page)
 assert.equal((await calls(page))[0].aborted,true)
 await page.evaluate(()=>(window as any).suggestionModelFixture.docks(['replacement']));await waitCalls(page,2)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'已经离开的旧建议'));await settle(page)
 assert.equal(await ghost(page).count(),0)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(1,'重新挂载的有效建议'))
 await page.waitForFunction(()=>document.querySelector('[data-composer-suggestion]')?.textContent==='重新挂载的有效建议')
 assert.equal((await calls(page)).length,2)
})

test('同一正式 seq 的事件回放不重复请求，新本人输入立即取消旧回复候选',async t=>{
 const page=await mount(t);await reply(page);await waitCalls(page,1)
 await page.evaluate(()=>(window as any).suggestionModelFixture.replay('session-a'));await settle(page)
 assert.equal((await calls(page)).length,1);assert.equal((await calls(page))[0].aborted,false)
 await page.evaluate(()=>{const f=(window as any).suggestionModelFixture;f.publish('session-a',[...f.entries('session-a'),{type:'event',event:{seq:18,time:18000,type:'user/message',surfaceOp:'append',data:{id:'next-user',role:'user',source:{kind:'user'},content:[{type:'text',text:'改成新的核验问题'}]}}}])});await settle(page)
 assert.equal((await calls(page))[0].aborted,true)
 await page.evaluate(()=>(window as any).suggestionModelFixture.resolve(0,'已经有新问题后的旧建议'));await settle(page)
 assert.equal(await ghost(page).count(),0)
 assert.equal((await calls(page)).length,1,'新本人输入本身不是已完成的助手回复')
 await reply(page,30);await waitCalls(page,2)
 assert.deepEqual((await calls(page)).map((row:any)=>row.seq),[10,30])
})
