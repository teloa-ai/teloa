import test from 'node:test'
import assert from 'node:assert/strict'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('群首次和后续读取失败均自动恢复；切群拒收旧结果，草稿不丢且从不重发',{timeout:45000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_message_recovery.tsx',markdown='\0group-recovery-markdown'
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222'},stamp='2026-10-15T00:00:00.000Z';
 const group=id=>({id,ownerId:'self',name:id===ids.a?'A 群':'B 群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,version:1,createdAt:stamp,updatedAt:stamp});
 const f=window.recoveryFixture={ids,target:{groupId:ids.a,rootId:''},fail:true,failed:0,hold:false,held:false,release:()=>{},reads:[],writes:[],items:[],render:()=>{}};
 const api={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:[group(ids.a),group(ids.b)]}),get:async id=>{f.reads.push(id);if(id===ids.a&&f.fail){f.failed++;throw Error('offline')}if(id===ids.a&&f.hold){f.held=true;await new Promise(resolve=>{f.release=resolve})}return {group:group(id),members:[{groupId:id,roleId:null,createdAt:stamp}]}},messages:async id=>({items:f.items.filter(m=>m.groupId===id)}),resources:async()=>({items:[]}),send:async(...input)=>{f.writes.push(input);throw Error('重读不能发送')}};
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},app=createRoot(document.getElementById('root'));
 f.render=()=>app.render(<I18nProvider runtime={runtime}><div id="teloa-main" tabIndex={-1}/><SavedCollaborationPage api={api} visible={true} target={f.target} roles={[]} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></I18nProvider>);f.render();`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown}]},plugins:[{name:'group-message-recovery',resolveId:id=>id.endsWith('group-message-recovery')?entryId:id===markdown?markdown:null,load:id=>id===entryId?entry:id===markdown?'export function MarkdownText(){return null}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:'group-message-recovery',name:'GroupMessageRecovery',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:800}});t.after(()=>page.close());page.setDefaultTimeout(6500)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const state=()=>page.evaluate(()=>(window as any).recoveryFixture),message=page.getByRole('textbox',{name:'群讨论消息',exact:true})
 await page.waitForFunction(()=>(window as any).recoveryFixture.failed===1)
 await page.evaluate(()=>(window as any).recoveryFixture.fail=false)
 await page.getByRole('heading',{name:'A 群',exact:true}).waitFor()
 await message.fill('A 群未发送草稿')
 await page.evaluate(()=>(window as any).recoveryFixture.fail=true)
 await page.waitForFunction(()=>(window as any).recoveryFixture.failed>=2)
 assert.equal(await message.inputValue(),'A 群未发送草稿')
 await page.evaluate(()=>{const f=(window as any).recoveryFixture;f.fail=false;f.items.push({id:'33333333-3333-4333-8333-333333333333',groupId:f.ids.a,rootId:null,authorId:'self',text:'恢复后新消息',references:[],mentions:[],createdAt:'2026-10-15T00:00:01.000Z'})})
 await page.locator('[data-teloa-message-id="33333333-3333-4333-8333-333333333333"]').waitFor()
 assert.equal(await message.inputValue(),'A 群未发送草稿')
 await page.evaluate(()=>(window as any).recoveryFixture.hold=true)
 await page.waitForFunction(()=>(window as any).recoveryFixture.held)
 await page.evaluate(()=>{const f=(window as any).recoveryFixture;f.target={groupId:f.ids.b,rootId:''};f.render()})
 await page.getByRole('heading',{name:'B 群',exact:true}).waitFor()
 await message.fill('B 群未发送草稿')
 await page.evaluate(()=>{const f=(window as any).recoveryFixture;f.hold=false;f.release()})
 await page.waitForFunction(()=>{const f=(window as any).recoveryFixture;return f.reads.filter((id:string)=>id===f.ids.b).length>=2})
 assert.equal(await page.getByRole('heading',{name:'B 群',exact:true}).count(),1)
 assert.equal(await message.inputValue(),'B 群未发送草稿')
 assert.equal(await page.locator('[data-teloa-message-id="33333333-3333-4333-8333-333333333333"]').count(),0,'旧群迟到的读取不能混入当前群')
 assert.deepEqual((await state()).writes,[])
 assert.deepEqual(errors,[])
})
