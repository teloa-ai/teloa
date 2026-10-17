import test from 'node:test'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用已固定的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('原群与话题长回复按需预览并下载完整原文；关闭、切群和迟到读取保留草稿且不派工',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),entryId=root+'__group_message_body.tsx',markdown='\0group-body-markdown',nodeCrypto='\0group-body-node-crypto'
 const mainText='# 原消息完整结论\n\n'+'材料与后续动作🙂。'.repeat(1300)+'\n\n原消息末尾结论。',topicText='# 话题完整结论\n\n'+'话题事实与依据🙂。'.repeat(1300)+'\n\n话题末尾结论。'
 const summary=(text:string)=>({chars:text.length,sha256:createHash('sha256').update(text).digest('hex')})
 const entry=String.raw`import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import tokens from '${client}theme-tokens.module.css';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import {SavedCollaborationPage} from '${client}SavedCollaborationPage.tsx';import {createGroupApi} from '${client}group-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {groupMessagePageFixture,groupMessageReadingFixture} from '${client}../../tests/fixtures/group-message-page-rpc.ts';
 for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;document.body.style.margin='0';document.getElementById('root').style.height='100dvh';
 const ids={a:'11111111-1111-4111-8111-111111111111',b:'22222222-2222-4222-8222-222222222222',role:'33333333-3333-4333-8333-333333333333',main:'44444444-4444-4444-8444-444444444444',reply:'55555555-5555-4555-8555-555555555555',topic:'66666666-6666-4666-8666-666666666666',topicReply:'77777777-7777-4777-8777-777777777777'},at='2026-10-15T00:00:00.000Z';
 const mainText=${JSON.stringify(mainText)},topicText=${JSON.stringify(topicText)},mainSummary=${JSON.stringify(summary(mainText))},topicSummary=${JSON.stringify(summary(topicText))};
 const f=window.bodyFixture={ids,target:{groupId:ids.a,rootId:''},calls:[],writes:[],hold:false,held:false,release:()=>{},corrupt:false,render:()=>{}};
 const group=id=>({id,ownerId:'self',version:1,name:id===ids.a?'完整回复群':'另一群',scope:'general',announcement:'',rules:{historyVisibleToNewMembers:true,draftsVisibleInGroup:true,mentionAllAllowed:true},pinned:false,archived:false,createdAt:at,updatedAt:at});
 const human=(id,text,second)=>({id,groupId:ids.a,rootId:null,authorId:'self',text,references:[],mentions:[],createdAt:'2026-10-15T00:00:0'+second+'.000Z'});
 const employee=(id,rootId,text,fullText,contextMode,second)=>({id,groupId:ids.a,rootId,authorId:ids.role,taskId:'88888888-8888-4888-8888-888888888888',runId:contextMode==='main'?'99999999-9999-4999-8999-999999999999':'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',text:text.slice(0,1197)+'\n\n…',references:[],createdAt:'2026-10-15T00:00:0'+second+'.000Z',contextMode,replyToMessageId:rootId,author:{name:'原资料员工',kind:'employee',version:1},fullText});
 const rows=[human(ids.main,'主群原消息',0),employee(ids.reply,ids.main,mainText,mainSummary,'main',1),human(ids.topic,'显式话题来源',2),employee(ids.topicReply,ids.topic,topicText,topicSummary,'thread',3)];
 const api=createGroupApi(async(endpoint,input)=>{f.calls.push([endpoint,input]);
 if(endpoint==='groups/list')return [group(ids.a),group(ids.b)];
 if(endpoint==='groups/get')return {group:group(input.groupId),members:[{groupId:input.groupId,roleId:null,createdAt:at},{groupId:input.groupId,roleId:ids.role,createdAt:at}]};
 if(endpoint==='groups/messages/list')return input.groupId!==ids.a?[]:input.rootId?rows.filter(row=>row.id===input.rootId||row.rootId===input.rootId):rows;if(endpoint==='groups/messages/page')return groupMessagePageFixture(rows,input);if(endpoint==='groups/reading/get'||endpoint==='groups/reading/mark')return groupMessageReadingFixture(rows,input,f.cursors||(f.cursors={}));
 // 提及角标轮询为只读目录，不是发送或派工；所有未声明写口仍进入下方拒绝。
 if(endpoint==='groups/attention')return {schema:'teloa.group-attention/v1',items:[]};
 if(endpoint==='groups/resources/list')return [];
 if(endpoint==='groups/agent-grants/get')return {groupVersion:1,roleVersion:1,grant:null,status:'not-granted'};
 if(endpoint==='groups/messages/body'){const text=input.messageId===ids.reply?mainText:topicText,summary=input.messageId===ids.reply?mainSummary:topicSummary;if(f.hold){f.held=true;await new Promise(resolve=>{f.release=resolve})}return {groupId:input.groupId,messageId:input.messageId,text:f.corrupt?text.slice(0,-1)+'改':text,...summary}}
 f.writes.push([endpoint,input]);throw Error('全文读取不能发送或派工');});
 const roles=[{id:ids.role,name:'当前员工名',kind:'employee',state:'active',scopes:['general'],version:1,duty:'核对资料',dataScope:'固定资料',executionScope:'只读核对',skills:[],knowledge:[],memories:[],history:[]}];
 const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={getSnapshot:()=>snapshot,subscribe:()=>()=>{},t:(key,params)=>translateMessage('zh-CN',key,params)},app=createRoot(document.getElementById('root'));
 f.render=()=>flushSync(()=>app.render(<I18nProvider runtime={runtime}><div id="teloa-main" tabIndex={-1}/><SavedCollaborationPage api={api} visible={true} target={f.target} roles={roles} profileName="Max" directory={{refresh:async()=>{},open:()=>{},select:()=>{},createRequest:0,createHandled:()=>{}}}/></I18nProvider>));f.render();`
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:[{find:'@deepseek-ai/dsh-client-ui-primitives',replacement:markdown},{find:'node:crypto',replacement:nodeCrypto}]},plugins:[{name:'group-message-body',resolveId:id=>id.endsWith('group-message-body-test')?entryId:[markdown,nodeCrypto].includes(id)?id:null,load:id=>id===entryId?entry:id===markdown?'export const MarkdownText=({text})=>text':id===nodeCrypto?'export function createHash(){throw Error("不应执行服务器摘要")};export function randomUUID(){return crypto.randomUUID()};export function createPublicKey(){throw Error("不应执行签名")};export function verify(){throw Error("不应执行签名")}':null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:'group-message-body-test',name:'GroupMessageBodyTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960},acceptDownloads:true});t.after(()=>page.close());page.setDefaultTimeout(5000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.route('http://127.0.0.1:49319/group-body-test',(route:any)=>route.fulfill({status:200,contentType:'text/html',body:'<html lang="zh-CN"><body><div id="root"></div></body></html>'}))
 await page.goto('http://127.0.0.1:49319/group-body-test');await page.addStyleTag({content:bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')});await page.addScriptTag({content:bundle.output.find(item=>item.type==='chunk')!.code})
 const ids=await page.evaluate(()=>(window as any).bodyFixture.ids),dialog=page.getByRole('dialog',{name:'完整回复',exact:true}),mainRow=page.locator('[data-teloa-message-id="'+ids.reply+'"]'),mainDraft=page.getByRole('region',{name:'讨论',exact:true}).getByRole('textbox',{name:'群讨论消息',exact:true})
 await mainRow.waitFor();await mainDraft.fill('主群草稿必须保留')
 assert.equal((await page.evaluate(()=>(window as any).bodyFixture.calls)).filter((row:any)=>row[0]==='groups/messages/body').length,0,'初次群流不读取完整正文')
 const mainOpen=mainRow.getByRole('button',{name:'阅读完整回复',exact:true});await mainOpen.click();await dialog.getByText('原消息末尾结论。',{exact:false}).waitFor()
 assert.equal(await dialog.getByRole('heading',{name:'原资料员工的回复',exact:true}).count(),1,'全文沿用原作者快照')
 assert.equal(await dialog.getByRole('button',{name:'返回工作概览',exact:true}).count(),0,'复用预览组件不能沿用错误来源的返回文案')
 await dialog.getByRole('button',{name:'源文本',exact:true}).click();assert.equal(await dialog.locator('pre').innerText(),mainText)
 const downloading=page.waitForEvent('download');await dialog.getByRole('button',{name:'下载',exact:true}).click();const downloaded=await downloading
 assert.equal(await readFile(await downloaded.path(),'utf8'),mainText)
 assert.equal(downloaded.suggestedFilename(),'原资料员工的回复.md')
 if(process.env.TELOA_GROUP_BODY_SCREENSHOT)await page.screenshot({path:process.env.TELOA_GROUP_BODY_SCREENSHOT,fullPage:true})
 await dialog.getByRole('button',{name:'返回讨论',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await mainDraft.inputValue(),'主群草稿必须保留');assert.equal(await mainOpen.evaluate((node:HTMLElement)=>document.activeElement===node),true)
 const topicRoot=page.locator('[data-teloa-message-id="'+ids.topic+'"]');await topicRoot.locator('button[class*="threadPreview"]').click()
 const topicPanel=page.getByRole('complementary',{name:'话题讨论',exact:true}),topicDraft=topicPanel.getByRole('textbox')
 await topicDraft.fill('话题草稿必须保留')
 await topicPanel.locator('[data-teloa-message-id="'+ids.topicReply+'"]').getByRole('button',{name:'阅读完整回复',exact:true}).click();await dialog.getByText('话题末尾结论。',{exact:false}).waitFor()
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal(await topicDraft.inputValue(),'话题草稿必须保留');assert.equal(await mainDraft.inputValue(),'主群草稿必须保留')
 // 当前全文取不到或摘要不符时显示失败，不拿别的消息或摘要内容冒充。
 await page.evaluate(()=>(window as any).bodyFixture.corrupt=true)
 await mainOpen.click();await dialog.getByRole('alert').waitFor();assert.equal(await dialog.locator('pre').count(),0)
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 await page.evaluate(()=>{const f=(window as any).bodyFixture;f.corrupt=false;f.hold=true})
 await mainOpen.click();await page.waitForFunction(()=>(window as any).bodyFixture.held)
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 await page.evaluate(()=>{const f=(window as any).bodyFixture;f.target={groupId:f.ids.b,rootId:''};f.render()})
 await page.getByRole('heading',{name:'另一群',exact:true}).waitFor();await mainDraft.fill('另一群草稿')
 await page.evaluate(()=>{const f=(window as any).bodyFixture;f.hold=false;f.release()})
 await page.waitForFunction(()=>(window as any).bodyFixture.calls.filter((row:any)=>row[0]==='groups/get'&&row[1].groupId===(window as any).bodyFixture.ids.b).length>=1)
 assert.equal(await dialog.count(),0);assert.equal(await mainDraft.inputValue(),'另一群草稿');assert.equal(await page.getByText('原消息末尾结论。',{exact:false}).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).bodyFixture.writes),[]);assert.deepEqual(errors,[])
})
