import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// 实际记录组件＋浏览器 localStorage；API 为夹具，不连接宿主、PG、模型或外部源。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const {chromium}=loadPlaywright()
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {readBusinessConfigurationPageProjectionVersioned} from '@teloa/contract';
import {BusinessConfigurationPage} from '${client}BusinessConfigurationPage.tsx';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';
import {createBusinessRecordDrafts} from '${client}business-record-drafts.ts';
import {createBusinessRecordApi} from '${client}business-record-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale.startsWith('zh')?'zh':'en',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.recordDraftFixture={calls:[],t:runtime.t,allowSubmit:false,ids:0},hash='a'.repeat(64),stamp='2026-11-02T00:00:00.000Z';
const objectType={format:'teloa.business-object-type/v1',id:'alert',version:'1.0.0',domain:'SOC',title:'告警',unit:'条',lead:'合成告警输入',sourceId:'records',fields:[{name:'note',label:'Evidence',from:'Evidence',type:'text',required:localStorage.getItem('fixture-required')==='1'}]};
const definition={id:'alerts',title:'Alert records',kind:'records',objectType:'alert',fields:['note'],allowCreate:true,allowEdit:true,allowArchive:false};
const rows=['A','B','C'].map(x=>({scope:'SOC',type:'alert',id:'alert-'+x,version:1,snapshotHash:hash,title:'Alert '+x,summary:'',source:'本地记录',observedAt:stamp,receivedAt:stamp,quality:'complete',fields:[]}));
const api=createBusinessRecordApi(async(endpoint,input)=>{f.calls.push([endpoint,input]);if(endpoint==='business-records/list')return {schema:'teloa.business-data-page/v1',sourceId:'records',capturedAt:stamp,items:rows};if(endpoint==='business-records/get')return rows.find(x=>x.id===input.id);if(f.allowSubmit&&endpoint==='business-records/edit')throw Error('合成失回包');throw Error('未明确提交，不应调用 '+endpoint)});
const projection=()=>readBusinessConfigurationPageProjectionVersioned({mode:'saved',scope:'SOC',configurationHash:hash,configurationVersion:1,page:{kind:'records',definition,objectType,emptyState:'no-records'}});
const app=createRoot(document.getElementById('root'));let owner='owner-a',mount=0;
f.render=(next=owner)=>{owner=next;const namespace='fixture/'+owner;const flow=new BusinessRecordFlow(api,()=>{if(!f.allowSubmit)throw Error('未提交不能生成请求身份');return '11111111-1111-4111-8111-'+String(++f.ids).padStart(12,'0')},(scope,type)=>{const key=namespace+'/records/'+encodeURIComponent(JSON.stringify([scope,type]));return {read:()=>localStorage.getItem(key),write:raw=>localStorage.setItem(key,raw),clear:()=>localStorage.removeItem(key)}},createBusinessRecordDrafts({namespace,storage:localStorage}));app.render(<I18nProvider runtime={runtime}><div><button onClick={()=>f.render(owner==='owner-a'?'owner-b':'owner-a')}>Switch owner</button><BusinessConfigurationPage key={++mount} projection={projection()} recordFlow={flow} capabilities={{create:true,edit:true,archive:false}} colorScheme="light"/></div></I18nProvider>)};f.changeDefinition=()=>{localStorage.setItem('fixture-required','1');objectType.fields[0].required=true;f.render()};f.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/record-draft-ui-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'RecordDraftFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=':root{--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-weight-heading:600;--teloa-weight-medium:500;--teloa-leading-heading:1.4;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#9e4226;--teloa-primary:#252823;--teloa-on-primary:#fff;--teloa-on-accent:#fff}body{font-family:system-ui;margin:16px}'+bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n');browser=await chromium.launch(launchOptions())
})
for(const locale of ['zh-CN','zh-HK','en'])test('记录草稿真实组件换记录、关闭、刷新和本人隔离 '+locale,async()=>{
 const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[]
 page.setDefaultTimeout(7000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 await context.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1:46351/drafts'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="'+locale+'"><meta charset="utf-8"><style>'+styles+'</style><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></html>'}):route.abort())
 const label=(key:string)=>page.evaluate((key:string)=>(window as any).recordDraftFixture.t(key),key)
 const open=async(id:string)=>{await page.locator('button[aria-pressed]').filter({has:page.getByText('Alert '+id,{exact:true})}).click();await page.getByRole('button',{name:await label('business.records.edit'),exact:true}).click()}
 const close=async()=>{await page.getByRole('form',{name:await label('business.records.edit'),exact:true}).getByRole('button',{name:await label('business.records.cancel'),exact:true}).click();await page.keyboard.press('Escape');await page.locator('dialog[open]').waitFor({state:'hidden'})}
 try{
  await page.goto('http://127.0.0.1:46351/drafts')
  for(const id of ['A','B','C']){await open(id);await page.getByLabel('Evidence',{exact:true}).fill('UNSENT-'+id);await close()}
  await open('A');assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'UNSENT-A')
  // 编辑时直接换记录，不能把 A 的编辑器显示在 B 下，也不能发出保存。
  await page.locator('button[aria-pressed]').filter({has:page.getByText('Alert B',{exact:true})}).click();assert.equal(await page.getByRole('form',{name:await label('business.records.edit'),exact:true}).count(),0)
  await page.getByRole('button',{name:await label('business.records.edit'),exact:true}).click();assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'UNSENT-B');await close()
  await page.reload();for(const id of ['C','A','B']){await open(id);assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'UNSENT-'+id);await close()}
  await page.getByRole('button',{name:'Switch owner',exact:true}).click();await open('A');assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'');await close()
  await page.getByRole('button',{name:'Switch owner',exact:true}).click();await open('A');assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'UNSENT-A')
  const writes=await page.evaluate(()=>(window as any).recordDraftFixture.calls.filter(([method]:[string,unknown])=>!['business-records/list','business-records/get'].includes(method)));assert.deepEqual(writes,[]);assert.deepEqual(errors,[])
  if(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS){const directory=process.env.TELOA_RECORD_DRAFT_SCREENSHOTS;await mkdir(directory,{recursive:true});await page.screenshot({path:join(directory,'record-drafts-'+locale+'.png'),fullPage:true})}
  if(locale==='zh-CN'){
   // 仅此处明确提交一次并模拟失回包；导航/刷新不能恢复成新提交或自动核对。
   await page.evaluate(()=>(window as any).recordDraftFixture.allowSubmit=true)
   await page.getByRole('form',{name:await label('business.records.edit'),exact:true}).getByRole('button',{name:await label('business.records.save'),exact:true}).click()
   await page.getByRole('button',{name:await label('business.records.recover'),exact:true}).waitFor()
   const pending=await page.evaluate(()=>{const row=Object.entries(localStorage).find(([key])=>key.includes('/records/'));return row&&JSON.parse(row[1]).mutation.input.requestId});assert.ok(pending)
   await page.locator('button[aria-pressed]').filter({has:page.getByText('Alert B',{exact:true})}).click()
   const detail=page.getByRole('dialog',{name:'Alert B',exact:true});await detail.waitFor();assert.equal(await page.getByRole('form').count(),0)
   await detail.getByRole('button',{name:await label('taskExecution.open'),exact:true}).click()
   await page.getByRole('button',{name:await label('business.records.recover'),exact:true}).waitFor();assert.equal(await page.getByLabel('Evidence',{exact:true}).inputValue(),'UNSENT-A')
   const beforeReload=await page.evaluate(()=>{const f=(window as any).recordDraftFixture;return {ids:f.ids,methods:f.calls.filter(([method]:[string,unknown])=>!['business-records/list','business-records/get'].includes(method)).map(([method]:[string,unknown])=>method)}});assert.deepEqual(beforeReload,{ids:1,methods:['business-records/edit']})
   await page.reload();await page.getByRole('button',{name:await label('business.records.recover'),exact:true}).waitFor()
   const actual=await page.evaluate(()=>{const f=(window as any).recordDraftFixture,row=Object.entries(localStorage).find(([key])=>key.includes('/records/'));return {ids:f.ids,writes:f.calls.filter(([method]:[string,unknown])=>!['business-records/list','business-records/get'].includes(method)),pending:row&&JSON.parse(row[1]).mutation.input.requestId}})
   assert.equal(actual.pending,pending);assert.equal(actual.ids,0);assert.deepEqual(actual.writes,[]);assert.deepEqual(errors,[])
   if(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS)await page.screenshot({path:join(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS,'pending-return-'+locale+'.png'),fullPage:true})
  }
 }catch(error){if(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS){const directory=process.env.TELOA_RECORD_DRAFT_SCREENSHOTS;await mkdir(directory,{recursive:true});await writeFile(join(directory,'failed-'+locale+'.json'),JSON.stringify({errors,text:await page.locator('body').innerText(),fixture:await page.evaluate(()=>(window as any).recordDraftFixture?.calls)},null,2));await page.screenshot({path:join(directory,'failed-'+locale+'.png'),fullPage:true})}throw error}finally{await context.close()}
})
test('R2 两个真实标签页保留分支，明确选择后可按当前字段继续并刷新',async()=>{
 const context=await browser.newContext({viewport:{width:1440,height:1100}}),a=await context.newPage(),b=await context.newPage(),errors:string[]=[]
 for(const page of [a,b]){page.setDefaultTimeout(7000);page.on('pageerror',(error:Error)=>errors.push(error.message))}
 await context.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1:46351/drafts'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>'+styles+'</style><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></html>'}):route.abort())
 const open=async(page:any)=>{await page.locator('button[aria-pressed]').filter({has:page.getByText('Alert A',{exact:true})}).click();await page.getByRole('button',{name:'编辑记录',exact:true}).click()}
 try{
  await a.goto('http://127.0.0.1:46351/drafts');await open(a);await a.getByRole('textbox',{name:/^说明/}).fill('A旧摘要')
  await b.goto('http://127.0.0.1:46351/drafts');await open(b);await b.getByRole('textbox',{name:/^说明/}).fill('B较新的摘要')
  await a.getByRole('textbox',{name:/^记录标题/}).fill('A只改标题')
  const choices=a.getByRole('region',{name:'另一页也有这条记录的草稿。两份内容均已保留，请选择要继续的草稿。',exact:true});await choices.waitFor()
  await choices.getByText('A只改标题',{exact:false}).waitFor();await choices.getByText('B较新的摘要',{exact:true}).waitFor();assert.equal(await a.getByRole('button',{name:'保存记录',exact:true}).count(),0)
  if(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS)await a.screenshot({path:join(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS,'R2-two-tab-conflict.png'),fullPage:true})
  await choices.getByRole('button',{name:'使用这份草稿继续',exact:true}).nth(1).click();assert.equal(await a.getByRole('textbox',{name:/^说明/}).inputValue(),'B较新的摘要')
  await a.reload();await open(a);assert.equal(await a.getByRole('textbox',{name:/^说明/}).inputValue(),'B较新的摘要')
  await a.evaluate(()=>(window as any).recordDraftFixture.changeDefinition());await open(a)
  const reopen=a.getByRole('button',{name:'保留草稿，按当前字段继续',exact:true});await reopen.waitFor();await reopen.click()
  assert.equal(await a.getByRole('textbox',{name:/^说明/}).inputValue(),'B较新的摘要');assert.equal(await a.getByRole('textbox',{name:/^Evidence/}).isEnabled(),true)
  await a.getByRole('textbox',{name:/^Evidence/}).fill('按当前字段继续输入');await a.reload();await open(a);assert.equal(await a.getByRole('textbox',{name:/^Evidence/}).inputValue(),'按当前字段继续输入');assert.equal(await reopen.count(),0)
  for(const page of [a,b]){const actual=await page.evaluate(()=>{const f=(window as any).recordDraftFixture;return {ids:f.ids,writes:f.calls.filter(([method]:[string,unknown])=>!['business-records/list','business-records/get'].includes(method))}});assert.deepEqual(actual,{ids:0,writes:[]})}
  assert.deepEqual(errors,[]);if(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS)await a.screenshot({path:join(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS,'R2-current-schema-reopened.png'),fullPage:true})
 }catch(error){if(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS){await a.screenshot({path:join(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS,'R2-failed.png'),fullPage:true});await writeFile(join(process.env.TELOA_RECORD_DRAFT_SCREENSHOTS,'R2-failed.json'),JSON.stringify({errors,a:await a.locator('body').innerText(),b:await b.locator('body').innerText()},null,2))}throw error}finally{await context.close()}
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
