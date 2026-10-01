import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessBuilderPanel} from '${client}BusinessBuilderPanel.tsx';
import {BusinessBuilderFlow} from '${client}business-builder-flow.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
const locale=document.documentElement.lang,en=locale==='en',snapshot={locale,dshLocale:locale,revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const fixture=window.builderFixture={calls:[],opened:[],failPage:false,lost:false,revision:1,holdSave:false};
let journal=null,receipt=null,releaseSave;fixture.releaseSave=()=>releaseSave?.();
const pages=[{kind:'records',id:'a',title:en?'Requests':'服务工单',objectType:'ticket',fields:[],allowCreate:true,allowEdit:true,allowArchive:true},{kind:'records',id:'b',title:en?'Follow-up':'后续跟进',objectType:'ticket',fields:[],allowCreate:true,allowEdit:true,allowArchive:true}];
const definition={format:'teloa.business-object-type/v1',domain:'sales',id:'ticket',version:'1.0.0',sourceId:'records',title:'Ticket',unit:'条',lead:'',fields:[]};
let draft={ownerId:'owner',id:'12345678-1234-4234-8234-123456789012',scope:'sales',revision:1,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z',candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:en?'Customer care':'客户服务',sources:[],definitions:[],pages:[]}};
let binding={kind:'builder',requestId:'12345678-1234-4234-8234-123456789013',title:'新业务',draftId:draft.id,sessionId:'native-session',createdAt:draft.createdAt,updatedAt:draft.updatedAt};
const api={byRequest:async input=>{fixture.calls.push('by-request:'+input.requestId);return binding},reserve:async input=>{fixture.calls.push('reserve:'+input.requestId);return binding},bind:async input=>{fixture.calls.push('bind:'+input.requestId);binding={...binding,sessionId:input.sessionId};return binding},bySession:async()=>binding,draft:async()=>{fixture.calls.push('draft');draft={...draft,revision:fixture.revision,hash:(fixture.revision===1?'a':'b').repeat(64)};return draft},preview:async input=>{fixture.calls.push('preview:'+input.expectedRevision);return {draftId:draft.id,revision:input.expectedRevision,candidateHash:draft.hash,baseVersion:0,dependencyHash:draft.hash,receipt:draft.hash,changes:{rows:[],truncated:false},issues:[]}},page:async input=>{fixture.calls.push('page:'+input.pageId+':'+input.expectedRevision);if(fixture.failPage)throw Object.assign(Error('private scope/internal id'),{code:'teloa/invalid-input'});return {mode:'preview',scope:'sales',configurationHash:draft.hash,draftId:draft.id,revision:input.expectedRevision,page:{kind:'records',definition:pages.find(p=>p.id===input.pageId),objectType:definition,emptyState:'no-records'}}},apply:async input=>{fixture.calls.push('apply');if(fixture.holdSave)await new Promise(resolve=>{releaseSave=resolve});receipt={scope:'sales',version:1,configurationHash:draft.hash,requestId:input.requestId};if(fixture.lost)throw Error('internal request secret');return receipt},receipt:async()=>{fixture.calls.push('receipt');return receipt}};
const makeFlow=()=>new BusinessBuilderFlow({api,work:{create:async options=>{if(!fixture.pending)throw Error('unexpected native create');fixture.calls.push('native-create:'+options.requestId);await options.beforeOpen({sessionId:'native-session'});fixture.pending=false;return {sessionId:'native-session'}}},storage:{getItem:()=>journal,setItem:(_,value)=>{journal=value},removeItem:()=>{journal=null}},journalKey:'builder-panel-test',id:()=> '12345678-1234-4234-8234-123456789099',refreshScopes:async()=>{},switching:{read:()=>({mainSessionId:'native-session',bindingSessionId:'native-session',bindingReady:true,input:{draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]},pendingSubmissions:[],monitor:undefined})}});
let flow=makeFlow();fixture.rebuild=()=>{flow=makeFlow();render()};
fixture.load=async(empty=false)=>{draft={...draft,candidate:{...draft.candidate,pages:empty?[]:pages,...(empty?{}:{homePageId:'a'})}};await flow.restoreSession('native-session')};
fixture.serverPending=async()=>{fixture.pending=true;const {sessionId,...reservation}=binding;binding=reservation;await flow.restoreSession('native-session')};
fixture.snapshot=()=>flow.getSnapshot();fixture.refreshDraft=()=>flow.refreshDraft();
const app=createRoot(document.getElementById('root'));const render=()=>app.render(<I18nProvider runtime={runtime}><main className={tokens.tokens}><BusinessBuilderPanel flow={flow} renderPage={projection=><article data-page={projection.page.definition.id}><h3>{projection.page.definition.title}</h3><p>{en?'No records yet':'还没有记录'}</p></article>} onOpenSaved={result=>fixture.opened.push(result)}/></main></I18nProvider>);
render();fixture.load(true);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-builder-panel-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderPanelFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output' in bundle)
 const output=bundle.output;script=output.find(item=>item.type==='chunk')!.code;styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-builder-panel',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 面板串行预览、旧内容归属、固定保存核对与键盘操作',async t=>{
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()});t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:var(--teloa-bg)}main{max-width:1000px;margin:auto;padding:24px}'+styles});await page.addScriptTag({content:script})
 const en=locale==='en',button=(zh:string,english:string)=>page.getByRole('button',{name:en?english:zh,exact:true}),save=button('保存业务','Save business'),refresh=button('刷新预览','Refresh preview')
 await page.getByText(en?'Describe the business you want to build in the conversation.':'在对话中描述你想搭建的业务。',{exact:true}).waitFor();assert.equal(await page.locator('input,textarea').count(),0);assert.equal(await save.isDisabled(),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).builderFixture.calls),['draft']);await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-'+width+'-empty.png',fullPage:true})
 await page.evaluate(()=>(window as any).builderFixture.load());await refresh.focus();await page.keyboard.press('Enter');await page.locator('[data-page=a]').waitFor();assert.equal(await save.isEnabled(),true)
 assert.deepEqual((await page.evaluate(()=>(window as any).builderFixture.calls)).slice(-3),['draft','preview:1','page:a:1'])
 await page.evaluate(()=>{(window as any).builderFixture.failPage=true});await button('后续跟进','Follow-up').click();await page.getByRole('alert').waitFor();assert.equal(await save.isDisabled(),true);assert.equal(await page.locator('[data-page=a]').count(),1)
 await page.getByText(en?'Previous preview: Customer care · Requests':'上次预览：客户服务 · 服务工单',{exact:true}).waitFor();assert.equal(await page.getByText('private scope/internal id').count(),0)
 await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-'+width+'-stale.png',fullPage:true})
 await page.evaluate(async()=>{(window as any).builderFixture.failPage=false;(window as any).builderFixture.revision=2;await (window as any).builderFixture.refreshDraft()});assert.equal(await save.isDisabled(),true);await refresh.click();await page.locator('[data-page=b]').waitFor()
 assert.deepEqual((await page.evaluate(()=>(window as any).builderFixture.calls)).slice(-3),['draft','preview:2','page:b:2'])
 await page.evaluate(()=>{(window as any).builderFixture.lost=true;(window as any).builderFixture.holdSave=true});await save.click();await page.getByText(en?'Saving business…':'正在保存业务…',{exact:true}).waitFor();assert.equal(await refresh.isDisabled(),true);assert.equal(await button('核对保存结果','Check save result').isDisabled(),true);await page.evaluate(()=>(window as any).builderFixture.releaseSave());await button('核对保存结果','Check save result').waitFor();assert.equal(await save.count(),0);assert.equal(await refresh.isDisabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.snapshot().binding.sessionId),'native-session');await page.evaluate(()=>(window as any).builderFixture.rebuild());await page.locator('button:not([disabled])').filter({hasText:en?'Check save result':'核对保存结果'}).waitFor();assert.equal(await button('核对保存结果','Check save result').isEnabled(),true)
 await button('核对保存结果','Check save result').click();await button('打开业务','Open business').click();assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.filter((x:string)=>x==='apply').length),1);assert.equal(await page.evaluate(()=>(window as any).builderFixture.opened[0].scope),'sales')
 assert.equal(await page.locator('body').innerText().then((text:string)=>text.includes('internal request secret')),false)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-'+width+'-saved.png',fullPage:true})
})


test('服务端预约未绑定且本地journal已丢失：现有恢复按钮显式按固定request恢复，不挂在核对中',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close())
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.evaluate(()=>(window as any).builderFixture.serverPending())
 const restore=page.getByRole('button',{name:'恢复搭建会话',exact:true})
 await restore.waitFor();assert.equal(await restore.isEnabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.some((x:string)=>x.startsWith('native-create:'))),false)
 await restore.click();await page.waitForFunction(()=>(window as any).builderFixture.snapshot().binding?.sessionId==='native-session')
 const calls=await page.evaluate(()=>(window as any).builderFixture.calls)
 assert.equal(calls.filter((x:string)=>x==='native-create:12345678-1234-4234-8234-123456789013').length,1)
 assert.equal(calls.filter((x:string)=>x==='bind:12345678-1234-4234-8234-123456789013').length,1)
 assert.equal(await restore.count(),0)
})
