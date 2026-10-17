import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用仓库固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('主群与话题刷新保留阅读位置，只把本人可见消息推进为已读',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_reading.tsx',markdown='\0group-reading-markdown'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),group={id:id(1),ownerId:'self',name:'阅读位置验证群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z'};
 const message=(n,rootId=null,employee=false)=>({id:id(n),groupId:group.id,rootId,authorId:employee?id(9):'self',authorKind:employee?'employee':'self',text:'消息 '+n+'：实际阅读位置与已读游标测试。',references:[],mentions:[],mentionAll:false,createdAt:new Date(Date.UTC(2026,9,15,0,0,n)).toISOString(),...(employee?{taskId:id(8),runId:id(7),contextMode:rootId?'thread':'main'}:{})});
 const f=window.readingFixture={main:Array.from({length:60},(_,n)=>message(100+n)),replies:Array.from({length:35},(_,n)=>message(200+n,id(100))),marks:[],cursors:{},visible:true,topic:false,failReading:false,calls:0,render:()=>{},append:()=>f.main.push(message(100+f.main.length,null,true)),appendTopic:()=>f.replies.push(message(200+f.replies.length,id(100),true))};
 const rows=rootId=>rootId?[f.main[0],...f.replies]:f.main;const reading=rootId=>{const list=rows(rootId),cursor=f.cursors[rootId||'main']||null;return {schema:'teloa.group-reading/v1',groupId:group.id,rootId:rootId||null,cursor,latest:list.length?{messageId:list.at(-1).id,createdAt:list.at(-1).createdAt}:null,unreadCount:list.filter(m=>m.authorId!=='self'&&(!cursor||m.createdAt>cursor.createdAt||m.createdAt===cursor.createdAt&&m.id>cursor.messageId)).length}};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,get:async()=>({group,members:[{groupId:group.id,roleId:null,createdAt:group.createdAt}]}),messages:async(_,rootId)=>{f.calls++;return {items:structuredClone(rootId?rows(rootId):[...f.main,...f.replies])}},resources:async()=>({items:[]}),reading:async(_,rootId)=>{if(f.failReading)throw Error('private read detail');return reading(rootId)},markRead:async(_,messageId,rootId)=>{f.marks.push({messageId,rootId:rootId||null});const m=rows(rootId).find(m=>m.id===messageId),old=f.cursors[rootId||'main'];if(!old||m.createdAt>old.createdAt||m.createdAt===old.createdAt&&m.id>old.messageId)f.cursors[rootId||'main']={messageId,createdAt:m.createdAt};return reading(rootId)}};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},app=createRoot(document.getElementById('root'));f.render=()=>app.render(<I18nProvider runtime={runtime}><SavedCollaborationPage api={api} visible={f.visible} target={{groupId:group.id,rootId:f.topic?id(100):''}} roles={[]} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></I18nProvider>);f.render();`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-reading-test',resolveId:id=>id.endsWith('group-reading-test')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'import React from "react";export function MarkdownText({text,children}){return React.createElement("p",null,text??children)}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-reading-test',name:'GroupReadingTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:900}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort());await page.setContent('<html lang="zh-CN"><style>html,body,#root{height:100%;margin:0}body{--teloa-font-body:14px;--teloa-font-control:13px;--teloa-font-caption:12px;--teloa-font-detail:21px;--teloa-text:#222;--teloa-background:#fff;--teloa-surface:#f6f6f6;--teloa-border:#ddd}</style><body><div id="root"></div></body></html>')
 for(const item of bundle.output)if(item.type==='asset'&&item.fileName.endsWith('.css'))await page.addStyleTag({content:String(item.source)})
 await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const main=page.locator('[aria-label="群消息记录"]');await main.locator('[data-teloa-message-id]').nth(59).waitFor()
 await page.waitForFunction(()=>{const log=document.querySelector('[aria-label="群消息记录"]')!;return log.scrollHeight>log.clientHeight&&log.scrollTop>100})
 await main.evaluate((log:HTMLElement)=>{log.scrollTop=180;log.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(200)
 await page.evaluate(()=>(window as any).readingFixture.append())
 await main.locator('[data-teloa-message-id]').nth(60).waitFor({timeout:6500})
 assert.ok(Math.abs(await main.evaluate((log:HTMLElement)=>log.scrollTop)-180)<2,'4 秒刷新不能把正在读历史的本人拉到底部')
 const latest=page.getByRole('button',{name:/1 条未读.*返回最新/});await latest.waitFor()
 assert.equal(await page.evaluate(()=>(window as any).readingFixture.marks.some((m:any)=>m.messageId.endsWith('000160'))),false,'未出现在阅读窗口的新消息不能提前标已读')
 await latest.click();await page.waitForFunction(()=>(window as any).readingFixture.cursors.main?.messageId.endsWith('000160'))
 await main.evaluate((log:HTMLElement)=>{log.scrollTop=250;log.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(100)
 await page.evaluate(()=>{const f=(window as any).readingFixture;f.visible=false;f.render()});await main.waitFor({state:'detached'})
 await page.evaluate(()=>{const f=(window as any).readingFixture;f.visible=true;f.render()});await main.waitFor();await page.waitForTimeout(150)
 assert.ok(Math.abs(await main.evaluate((log:HTMLElement)=>log.scrollTop)-250)<2,'重新打开原群保留本人位置')
 const mainAnchor=await main.evaluate((log:HTMLElement)=>{const top=log.getBoundingClientRect().top;return Array.from(log.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).find(row=>row.getBoundingClientRect().bottom>top)?.dataset.teloaMessageId})
 await page.evaluate(()=>{const f=(window as any).readingFixture;f.topic=true;f.render()});const topic=page.locator('[class*="topicMessages"]');await topic.locator('[data-teloa-message-id]').nth(35).waitFor()
 await page.waitForFunction(()=>document.querySelector('[class*="topicMessages"]')!.scrollTop>100)
 await topic.evaluate((log:HTMLElement)=>{log.scrollTop=120;log.dispatchEvent(new Event('scroll'))});await page.waitForTimeout(100)
 await page.evaluate(()=>(window as any).readingFixture.appendTopic());await topic.locator('[data-teloa-message-id]').nth(36).waitFor({timeout:6500})
 assert.ok(Math.abs(await topic.evaluate((log:HTMLElement)=>log.scrollTop)-120)<2,'话题与主群分别保留阅读位置')
 const topicLatest=page.getByRole('complementary',{name:'话题讨论'}).getByRole('button',{name:/1 条未读.*返回最新/});await topicLatest.click();await page.waitForFunction(()=>Object.entries((window as any).readingFixture.cursors).some(([key,value]:any)=>key!=='main'&&value.messageId.endsWith('000235')))
 assert.equal(await page.evaluate(()=>(window as any).readingFixture.cursors.main.messageId.endsWith('000160')),true)
 await page.evaluate(()=>{const f=(window as any).readingFixture;f.topic=false;f.render()});await main.waitFor();await page.waitForTimeout(200)
 assert.equal(await main.evaluate((log:HTMLElement)=>{const top=log.getBoundingClientRect().top;return Array.from(log.querySelectorAll<HTMLElement>('[data-teloa-message-id]')).find(row=>row.getBoundingClientRect().bottom>top)?.dataset.teloaMessageId}),mainAnchor,'关闭话题后主群仍阅读同一条原消息；宽度变化按消息锚点恢复')
 await page.evaluate(()=>{const f=(window as any).readingFixture;f.visible=false;f.render();f.append()});await main.waitFor({state:'detached'});await page.waitForTimeout(4200)
 assert.equal(await page.evaluate(()=>(window as any).readingFixture.marks.some((m:any)=>m.messageId.endsWith('000161'))),false,'隐藏期间不能替本人已读新消息')
 await page.evaluate(()=>{const f=(window as any).readingFixture;f.visible=true;f.render()});await latest.waitFor()
 await main.evaluate((log:HTMLElement)=>{log.scrollTop=log.scrollHeight-log.clientHeight-25;log.dispatchEvent(new Event('scroll'))});await page.waitForFunction(()=>(window as any).readingFixture.cursors.main?.messageId.endsWith('000161'))
 await page.evaluate(()=>(window as any).readingFixture.append());await main.locator('[data-teloa-message-id]').nth(62).waitFor({timeout:6500})
 await page.waitForFunction(()=>{const log=document.querySelector('[aria-label="群消息记录"]')!;return log.scrollHeight-log.clientHeight-log.scrollTop<2})
 await page.waitForFunction(()=>(window as any).readingFixture.cursors.main?.messageId.endsWith('000162'))
 await page.getByRole('textbox',{name:'群讨论消息',exact:true}).fill('同步失败仍保留未发送草稿')
 await page.evaluate(()=>(window as any).readingFixture.failReading=true);const retry=page.getByRole('button',{name:'重试同步',exact:true});await retry.waitFor({timeout:6500})
 assert.equal(await page.getByRole('textbox',{name:'群讨论消息',exact:true}).inputValue(),'同步失败仍保留未发送草稿')
 await page.evaluate(()=>(window as any).readingFixture.failReading=false);await retry.click();await retry.waitFor({state:'detached'})
 assert.deepEqual(errors,[])
})
