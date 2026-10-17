import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('原群读取失败可就地重试，返回后保留原群身份与未发送草稿',{timeout:30000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_read_retry.tsx',markdown='\0group-read-markdown'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const f=window.retryFixture={calls:[],fail:true,failMessages:false,visible:true,render:()=>{}};
 const group={id:'original-group',ownerId:'self',name:'采购核查群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:'2026-10-13T00:00:00.000Z',updatedAt:'2026-10-13T00:00:00.000Z'};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:[group]}),get:async id=>{f.calls.push(['get',id]);if(f.fail)throw Error('private transport detail');return {group,members:[{groupId:id,roleId:null,createdAt:group.createdAt}]}},messages:async id=>{f.calls.push(['messages',id]);if(f.failMessages)throw Error('private messages transport');return {items:[]}},resources:async id=>{f.calls.push(['resources',id]);return {items:[]}}};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},app=createRoot(document.getElementById('root'));
 f.render=()=>app.render(<I18nProvider runtime={runtime}><SavedCollaborationPage api={api} visible={f.visible} target={{groupId:group.id,rootId:''}} roles={[]} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></I18nProvider>);f.render();`
 // 本用例核对容器读取与草稿恢复，Markdown 叶节点不参与本次验证。
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-read-retry',resolveId:id=>id.endsWith('group-read-retry')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'export function MarkdownText(){return null}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-read-retry',name:'GroupReadRetry',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(2500)
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));await page.route('**/*',(r:any)=>r.abort());await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 await page.getByRole('alert').waitFor();assert.doesNotMatch(await page.getByRole('alert').innerText(),/private transport/)
 const retry=page.getByRole('alert').getByRole('button',{name:'刷新',exact:true});await retry.waitFor()
 await page.evaluate(()=>{(window as any).retryFixture.fail=false});await retry.click();await page.getByRole('heading',{name:'采购核查群',exact:true}).waitFor()
 await page.getByRole('textbox',{name:'群讨论消息',exact:true}).fill('未发送的原群草稿')
 await page.evaluate(()=>{const f=(window as any).retryFixture;f.visible=false;f.render()});await page.waitForFunction(()=>!(document.querySelector('section[aria-label="协作群"]')))
 await page.evaluate(()=>{const f=(window as any).retryFixture;f.fail=true;f.visible=true;f.render()});await retry.waitFor()
 await page.evaluate(()=>{(window as any).retryFixture.fail=false});await retry.click();await page.getByRole('heading',{name:'采购核查群',exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'群讨论消息',exact:true}).inputValue(),'未发送的原群草稿')
 await page.evaluate(()=>{const f=(window as any).retryFixture;f.visible=false;f.render()});await page.waitForFunction(()=>!(document.querySelector('section[aria-label="协作群"]')))
 await page.evaluate(()=>{const f=(window as any).retryFixture;f.failMessages=true;f.visible=true;f.render()})
 // 消息单口失败不能丢掉已经成功核验的原群身份、成员及资料入口。
 await page.getByRole('alert').waitFor();await page.getByRole('heading',{name:'采购核查群',exact:true}).waitFor()
 await page.getByRole('button',{name:'1 位成员',exact:true}).click();await page.getByRole('heading',{name:'成员 1',exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'群讨论消息',exact:true}).inputValue(),'未发送的原群草稿')
 assert.equal(await page.getByRole('button',{name:'发送群消息',exact:true}).isDisabled(),true)
 await page.evaluate(()=>{(window as any).retryFixture.failMessages=false});await retry.click();await page.getByRole('heading',{name:'开始第一段讨论',exact:true}).waitFor()
 assert.equal(await page.getByRole('textbox',{name:'群讨论消息',exact:true}).inputValue(),'未发送的原群草稿')
 assert.deepEqual([...new Set((await page.evaluate(()=>(window as any).retryFixture.calls)).map((row:string[])=>row[1]))],['original-group']);assert.deepEqual(errors,[])
})
