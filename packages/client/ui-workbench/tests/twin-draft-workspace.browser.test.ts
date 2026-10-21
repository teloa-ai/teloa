import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('真实多稿界面保留编辑、退回与未知采用；核对回执后仅原群稿显示已发送',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-twin-draft-ui-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';
 import {TwinDraftWorkspace} from ${JSON.stringify(join(client,'TwinDraftWorkspace.tsx'))};
 import {createTwinDraftApi} from ${JSON.stringify(join(client,'twin-drafts-api.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
 import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import pageCss from ${JSON.stringify(join(client,'TaskPage.module.css'))};
 import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};
 import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};
 document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([k,v])=>document.body.style.setProperty(k,v));
 const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
 const owner='owner-ui',roleId='10000000-0000-4000-8000-000000000001',groupId='20000000-0000-4000-8000-000000000001',base={schema:'teloa.twin-draft/v1',ownerId:owner,roleId,roleVersion:1,revision:1,state:'draft',basis:[],createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'};
 const run=async()=>{let rows=[{...base,id:'30000000-0000-4000-8000-000000000001',title:'回复登录修复进度',body:'回归完成后，18 点前合并。',source:{kind:'group',groupId,messageId:'40000000-0000-4000-8000-000000000001',groupVersion:1,rootId:null,label:'研发周同步',text:'今天能合并登录修复吗？'}},{...base,id:'30000000-0000-4000-8000-000000000002',title:'确认内容周会改期',body:'周四上午可以。',source:{kind:'conversation',sessionId:'content-conversation',messageId:'message-1',messageSeq:1,label:'内容周会',text:'这周例会能改到周四吗？'}}];for(const row of rows){row.bodyHash=await hash(row.body);row.source.bodyHash=await hash(row.source.text)}let receipt=null;
 const evidence=window.twinDraftEvidence={sends:0,opened:[],quota:false};
 const call=async(endpoint,input)=>{if(endpoint==='twin-drafts/list')return {ownerId:owner,roleId,roleVersion:1,drafts:structuredClone(rows)};if(endpoint==='twin-drafts/receipt')return receipt;
 const row=rows.find(r=>r.id===input.draftId);if(endpoint==='twin-drafts/revise'){Object.assign(row,{body:input.body,bodyHash:await hash(input.body),revision:row.revision+1});return structuredClone(row)}
 if(endpoint==='twin-drafts/return'){Object.assign(row,{state:'returned',returnReason:input.reason,revision:row.revision+1});return structuredClone(row)}
 if(endpoint==='twin-drafts/adopt'){evidence.sends++;Object.assign(row,{state:'sent',revision:row.revision+1});receipt={draft:structuredClone(row),receipt:{requestId:input.requestId,draftId:row.id,revision:row.revision,bodyHash:row.bodyHash,decidedAt:row.updatedAt,result:{kind:'group-message',groupId,messageId:'50000000-0000-4000-8000-000000000001',authorId:'self'}}};throw Error('response lost')}throw Error(endpoint)};
 const api=createTwinDraftApi(call,{ownerId:owner,namespace:'space-ui',storage:{getItem:k=>localStorage.getItem(k),setItem:(k,v)=>{if(evidence.quota)throw Error('QuotaExceededError');localStorage.setItem(k,v)},removeItem:k=>localStorage.removeItem(k)}}),snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><main className={pageCss.page} style={{maxWidth:1100,margin:'40px auto',padding:20,fontFamily:'sans-serif'}}><h1>Max 的分身</h1><TwinDraftWorkspace port={{api,openConversationDraft:async(id,text)=>{evidence.opened.push({id,text})}}} roleId={roleId} roleVersion={1}/></main></I18nProvider>)};run();`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),formats:['iife'],name:'TwinDraftWorkspaceFixture'}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1100}});page.setDefaultTimeout(6000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/twin-drafts'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/twin-drafts');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('heading',{name:'回复登录修复进度',exact:true}).waitFor()
 await page.getByRole('button',{name:'修改',exact:true}).click()
 await page.getByRole('textbox',{name:'代拟正文',exact:true}).fill('新正文不能在切换时丢失。')
 await page.getByRole('button',{name:/确认内容周会改期/}).click()
 await page.getByRole('button',{name:/回复登录修复进度/}).click()
 await page.getByRole('button',{name:'修改',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'代拟正文',exact:true}).inputValue(),'新正文不能在切换时丢失。')
 await page.evaluate(()=>{(window as any).twinDraftEvidence.quota=true})
 await page.getByRole('textbox',{name:'代拟正文',exact:true}).fill('存储失败的新输入仍需保留。')
 await page.getByText('浏览器未能持久保存新输入，请保留当前页面；切换稿件或收起编辑不会丢失本页输入。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'收起修改',exact:true}).click();await page.getByRole('button',{name:'修改',exact:true}).click()
 assert.equal(await page.getByRole('textbox',{name:'代拟正文',exact:true}).inputValue(),'存储失败的新输入仍需保留。')
 await page.evaluate(()=>{(window as any).twinDraftEvidence.quota=false})
 await page.getByRole('textbox',{name:'代拟正文',exact:true}).fill('修复存储后保留新输入。')

 await page.getByRole('button',{name:'保存修改',exact:true}).click()
 await page.getByText('修改已保存，尚未发送。',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).twinDraftEvidence.sends),0)
 await page.getByRole('checkbox').check();await page.getByRole('button',{name:'采用并发送',exact:true}).click()
 await page.getByText('上次操作结果尚未核实，草稿与原请求已保留。',{exact:true}).waitFor()
 await page.getByRole('button',{name:'核对上次结果',exact:true}).click()
 await page.getByRole('button',{name:/回复登录修复进度.*已发送到原协作群/}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).twinDraftEvidence.sends),1)
 await page.getByRole('button',{name:/确认内容周会改期/}).click()
 await page.getByRole('button',{name:'回原会话继续发送',exact:true}).click()
 assert.equal((await page.evaluate(()=>(window as any).twinDraftEvidence.opened))[0].id,'content-conversation')
 assert.equal(await page.evaluate(()=>(window as any).twinDraftEvidence.sends),1,'打开原会话不发送')
 await page.getByRole('button',{name:'退回',exact:true}).click();await page.getByRole('textbox',{name:'退回意见',exact:true}).fill('请核对日期')
 await page.getByRole('button',{name:'退回',exact:true}).last().click()
 await page.getByText('退回意见：请核对日期',{exact:true}).waitFor()
 await page.getByRole('textbox',{name:'退回意见',exact:true}).waitFor({state:'detached'})
 await page.screenshot({path:'/private/tmp/twin-draft-workspace.png',fullPage:true})
 await page.setViewportSize({width:390,height:1000})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true)
 assert.deepEqual(errors,[])
})

test('回原会话已有输入时显示受控保留提示，普通异常不透传任意message',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-twin-draft-open-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';
 import {TwinDraftWorkspace} from ${JSON.stringify(join(client,'TwinDraftWorkspace.tsx'))};import {createTwinDraftApi} from ${JSON.stringify(join(client,'twin-drafts-api.ts'))};import {openTwinDraftConversation} from ${JSON.stringify(join(client,'twin-draft-conversation.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};import {prototypeThemes} from ${JSON.stringify(join(root,'packages/client/ui-workbench/src/brand/prototype-theme.ts'))};document.body.classList.add(tokens.tokens);Object.entries(prototypeThemes.light).forEach(([k,v])=>document.body.style.setProperty(k,v));document.body.style.fontFamily='sans-serif';
 const hash=async text=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text))),b=>b.toString(16).padStart(2,'0')).join('');
 const run=async()=>{const owner='owner',roleId='10000000-0000-4000-8000-000000000001',row={schema:'teloa.twin-draft/v1',ownerId:owner,id:'30000000-0000-4000-8000-000000000001',roleId,roleVersion:1,revision:1,state:'draft',title:'待本人发送的会话稿',body:'保留的回复正文',bodyHash:await hash('保留的回复正文'),source:{kind:'conversation',sessionId:'original',messageId:'message',messageSeq:1,label:'原工作会话',text:'原文',bodyHash:await hash('原文')},basis:[],createdAt:'2026-10-21T00:00:00Z',updatedAt:'2026-10-21T00:00:00Z'};
 const evidence=window.twinDraftOpenEvidence={text:'已有输入不可覆盖',writes:0,sends:0,untrusted:false};const api=createTwinDraftApi(async(endpoint)=>{if(endpoint!=='twin-drafts/list'){evidence.sends++;throw Error('unexpected write')}return {ownerId:owner,roleId,roleVersion:1,drafts:[row]}},{ownerId:owner,namespace:'occupied',storage:localStorage});
 const input={state:{getSnapshot:()=>({draft:evidence.text,attachmentIds:[],occurrences:[],queue:[],phase:'plain'})},setDraft:text=>{evidence.writes++;evidence.text=text}},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><main style={{maxWidth:1100,margin:'40px auto',padding:20}}><TwinDraftWorkspace port={{api,openConversationDraft:async(_id,text)=>{if(evidence.untrusted)throw Error('UNTRUSTED HOST MESSAGE');await openTwinDraftConversation(text,{open:async()=>true,current:()=>true,input:()=>input,messages:{occupied:'INTERNAL MESSAGE MUST NOT LEAK',unavailable:'INTERNAL MESSAGE MUST NOT LEAK',rejected:'INTERNAL MESSAGE MUST NOT LEAK'}})}}} roleId={roleId} roleVersion={1}/></main></I18nProvider>)};run();`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),formats:['iife'],name:'TwinDraftOccupiedFixture'}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage();page.setDefaultTimeout(6000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/twin-draft-occupied'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('http://127.0.0.1/twin-draft-occupied');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByRole('button',{name:'回原会话继续发送',exact:true}).click()
 await page.getByText('原输入已有文字、附件或排队内容；两份内容均保留，请复制稿件后自行发送。',{exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const e=(window as any).twinDraftOpenEvidence;return {text:e.text,writes:e.writes,sends:e.sends}}),{text:'已有输入不可覆盖',writes:0,sends:0})
 assert.equal(await page.getByText('保留的回复正文',{exact:true}).count(),1);assert.equal(await page.getByText('INTERNAL MESSAGE MUST NOT LEAK',{exact:true}).count(),0)
 await page.screenshot({path:'/private/tmp/twin-draft-occupied-message.png',fullPage:true})
 await page.evaluate(()=>{(window as any).twinDraftOpenEvidence.untrusted=true});await page.getByRole('button',{name:'回原会话继续发送',exact:true}).click()
 await page.getByRole('alert').waitFor();assert.equal(await page.getByText('UNTRUSTED HOST MESSAGE',{exact:true}).count(),0);assert.equal(await page.getByText('原输入已有文字、附件或排队内容；两份内容均保留，请复制稿件后自行发送。',{exact:true}).count(),0)
 assert.deepEqual(errors,[])
})
