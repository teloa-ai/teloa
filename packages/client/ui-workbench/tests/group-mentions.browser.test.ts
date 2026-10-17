import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import type {GroupMentionItem} from '@teloa/contract'
// @ts-expect-error 使用仓库固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

type MentionLocateFailureFlag='refuseLocate'|'rejectLocate'
declare global {interface Window {mentionsFixture:{group:string;calls:Array<{group:string;unreadOnly:boolean;before?:string}>;located:GroupMentionItem[];fail:boolean;hold:boolean;rejectLocate:boolean;refuseLocate:boolean;release:(()=>void)|null;render:()=>void}}}

test('群内@我键盘可达、独立筛选分页、按原主群话题定位并拒绝迟到跨群结果',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_mentions.tsx'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {GroupMentions} from '${client}GroupMentions.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),stamp='2026-10-16T00:00:00.000Z',f=window.mentionsFixture={group:id(1),calls:[],located:[],fail:false,hold:false,rejectLocate:false,refuseLocate:false,release:null,render:null};
 const message=(n,rootId)=>({id:id(n),groupId:id(1),rootId,authorId:id(9),taskId:id(7),runId:id(8),text:'结构化提醒 '+n,references:[],createdAt:stamp,mentionSelf:true});
 const page=(unreadOnly,before)=>({schema:'teloa.group-mentions/v1',groupId:id(1),rootId:null,unreadOnly,items:[{message:message(before?12:11,before?id(3):null),rootId:before?id(3):null,excerpt:before?'话题里的提醒':'主群里的提醒',unread:!before}],next:before?null:id(11)});
 const api={attention:async()=>{if(f.fail)throw Error('private');return {schema:'teloa.group-attention/v1',items:[{groupId:id(1),unreadCount:3,mentionCount:2},{groupId:id(2),unreadCount:0,mentionCount:0}]}},mentions:async(group,unreadOnly,before)=>{f.calls.push({group,unreadOnly,before});if(f.fail)throw Error('private');if(f.hold)return new Promise(resolve=>f.release=()=>resolve(page(unreadOnly,before)));return group===id(1)?page(unreadOnly,before):{...page(unreadOnly,before),groupId:group,items:[],next:null}}};
 const state={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>state,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},app=createRoot(document.getElementById('root'));f.render=()=>app.render(<I18nProvider runtime={runtime}><textarea aria-label="原草稿" defaultValue="保留草稿"/><GroupMentions key={f.group} groupId={f.group} active api={api} locate={async item=>{if(f.rejectLocate)throw Error('private locator error');if(f.refuseLocate)return false;f.located.push(item)}} author={item=>'同名员工'} time={value=>value}/></I18nProvider>);f.render();`
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'group-mentions-test',resolveId:id=>id.endsWith('group-mentions-test')?entryId:null,load:id=>id===entryId?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:'group-mentions-test',name:'GroupMentionsTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>')
 for(const output of bundle.output)if(output.type==='asset'&&output.fileName.endsWith('.css'))await page.addStyleTag({content:String(output.source)})
 await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const toggle=page.getByRole('button',{name:'@我 2',exact:true});await toggle.waitFor();await toggle.focus();await page.keyboard.press('Enter')
 await page.getByRole('button',{name:/主群里的提醒/}).click()
 assert.equal(await page.evaluate(()=>window.mentionsFixture.located[0]!.rootId),null)
 const panel=page.getByRole('region',{name:'@我',exact:true})
 for(const mode of ['refuseLocate','rejectLocate'] as const){
  await page.evaluate((key:MentionLocateFailureFlag)=>{window.mentionsFixture[key]=true},mode);await toggle.click();await panel.getByRole('button',{name:/主群里的提醒/}).click()
  await panel.getByText('未能打开原消息，请重试。').waitFor();assert.equal(await panel.getByRole('button',{name:/主群里的提醒/}).count(),1)
  await page.evaluate((key:MentionLocateFailureFlag)=>{window.mentionsFixture[key]=false},mode);await panel.getByRole('button',{name:'重试',exact:true}).click();await panel.waitFor({state:'detached'})
 }
 await toggle.click();await page.getByRole('checkbox',{name:'只看未读'}).uncheck();await page.getByRole('button',{name:'更多提及'}).click()
 await page.getByRole('button',{name:/话题里的提醒/}).click()
 assert.equal(await page.evaluate(()=>window.mentionsFixture.located.at(-1)!.rootId),'00000000-0000-4000-8000-000000000003')
 assert.equal(await page.getByRole('textbox',{name:'原草稿'}).inputValue(),'保留草稿')
 await toggle.click();assert.equal(await page.getByRole('checkbox',{name:'只看未读'}).isChecked(),false)
 await page.keyboard.press('Escape');await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-controls')!==null&&document.activeElement?.getAttribute('aria-expanded')==='false')
 assert.equal(await toggle.evaluate((node:HTMLElement)=>document.activeElement===node),true)
 await page.evaluate(()=>{window.mentionsFixture.fail=true});await toggle.click();await page.getByText('未能读取提及，请重试。').waitFor()
 assert.equal(await page.getByText('没有提及你的消息').count(),0)
 await page.evaluate(()=>{window.mentionsFixture.fail=false;window.mentionsFixture.hold=true});await page.getByRole('button',{name:'重试'}).click()
 await page.evaluate(()=>{window.mentionsFixture.group='00000000-0000-4000-8000-000000000002';window.mentionsFixture.render()});await page.getByRole('button',{name:'@我 0',exact:true}).waitFor()
 await page.evaluate(()=>window.mentionsFixture.release?.());assert.equal(await page.getByText('主群里的提醒').count(),0)
 assert.deepEqual(errors,[])
})
