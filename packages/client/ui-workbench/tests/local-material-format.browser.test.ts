import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,rm,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

type Evidence={calls:string[];pending:boolean;labels:{add:string;track:string;name:string;path:string;save:string}}
declare global{interface Window{localFormatEvidence:Evidence}}

test('资料页不支持的本机格式给出准确范围和下一步，服务端同原因可本地化且不回显异常',{timeout:60_000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-local-format-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`
 import React from 'react';import {createRoot} from 'react-dom/client';
 import {ResourceManager} from ${JSON.stringify(join(client,'ResourceManager.tsx'))};
 import {createResourceApiFromRpc} from ${JSON.stringify(join(client,'resource-api.ts'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
 import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import {prototypeThemes} from ${JSON.stringify(join(client,'../brand/prototype-theme.ts'))};
 import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};
 const locale=new URL(location.href).searchParams.get('locale')||'zh-CN',mode=new URL(location.href).searchParams.get('mode'),stamp='2026-01-01T00:00:00Z';
 const calls=[],labels=Object.fromEntries([['add','library.add'],['track','knowledge.local.track'],['name','knowledge.manager.name'],['path','knowledge.local.path'],['save','knowledge.local.save']].map(([key,value])=>[key,translateMessage(locale,value)]));
 const evidence=window.localFormatEvidence={calls,pending:false,labels};let saved=null;
 const api=createResourceApiFromRpc(async(endpoint)=>{
  if(endpoint==='resources/list')return {ok:true,value:{drafts:[],resources:[]}};
  if(endpoint==='resources/sources')return {ok:true,value:[]};
  if(endpoint==='knowledge/tree')return {ok:true,value:{space:{id:'space',ownerId:'owner',workspaceId:'default',title:'Materials',rootNodeId:'root',directoryRevision:1,scopeIds:['general'],createdAt:stamp,updatedAt:stamp},nodes:[{id:'root',spaceId:'space',parentId:null,type:'space',title:'Materials',siblingOrder:0,path:['root'],createdAt:stamp,updatedAt:stamp}]}};
  calls.push(endpoint);return {ok:false,error:{code:'teloa/invalid-input',message:'private/path-and-service-details',details:{reason:mode==='unknown'?'unknown':'local-material-format-unsupported'}}};
 },{read:()=>saved,write:value=>{saved=value;evidence.pending=true},clear:()=>{saved=null;evidence.pending=false}});
 const snapshot={locale,dshLocale:locale,revision:1},runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage(locale,key,params)};
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><div className={tokens.tokens} style={{...prototypeThemes.light,height:'100vh'}}><ResourceManager api={api} visible selectedDraftId={null} targetResource={null} clearTarget={()=>{}} openConversation={()=>{throw Error('No model or conversation allowed')}}/></div></I18nProvider>);
 `)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'LocalMaterialFormatTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const chunk=bundle.output.find(row=>row.type==='chunk'&&row.isEntry);assert.ok(chunk&&chunk.type==='chunk');const script=chunk.code
 const styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(6000)
 const errors:string[]=[],external:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:{request:()=>{url:()=>string};fulfill:(reply:{contentType:string;body:string})=>Promise<void>;abort:()=>Promise<void>})=>{const url=new URL(route.request().url());if(url.origin==='http://127.0.0.1:3199')return route.fulfill({contentType:'text/html',body:'<!doctype html><html><meta charset="utf-8"><div id="root"></div></html>'});external.push(url.href);return route.abort()})
 async function open(locale:string,mode='local'){
  await page.goto('http://127.0.0.1:3199/formats?locale='+locale+'&mode='+mode);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
  const labels=await page.evaluate(()=>window.localFormatEvidence.labels)
  await page.getByRole('button',{name:labels.add,exact:true}).and(page.locator('summary')).click();await page.getByRole('button',{name:labels.track,exact:true}).click();await page.getByLabel(labels.name,{exact:true}).fill('Example material')
  return labels
 }
 for(const locale of ['zh-CN','zh-Hant','en']){
  const labels=await open(locale)
  for(const extension of ['txt','pdf','docx','png']){
   await page.getByLabel(labels.path,{exact:true}).fill('example.'+extension);await page.getByRole('button',{name:labels.save,exact:true}).click()
   const alert=page.getByRole('alert');await alert.waitFor();const text=await alert.innerText()
   assert.match(text,/UTF-8 Markdown/);assert.match(text,/\.md/);assert.match(text,/\.markdown/)
   assert.match(text,locale==='en'?/save.*Markdown|Markdown.*save/i:locale==='zh-Hant'?/儲存為 Markdown|另存為 Markdown/:/保存为 Markdown/)
   assert.doesNotMatch(text,/private\/|稍后重试|稍後再試|Try again later/)
   assert.deepEqual(await page.evaluate(()=>window.localFormatEvidence.calls),[]);assert.equal(await page.evaluate(()=>window.localFormatEvidence.pending),false)
   assert.equal(await page.getByLabel(labels.path,{exact:true}).inputValue(),'example.'+extension)
  }
  const output=process.env.TELOA_LOCAL_MATERIAL_FORMAT_TEST_OUTPUT_DIR;if(output)await page.screenshot({path:join(output,'unsupported-'+locale+'.png'),fullPage:true})
  const server=await open(locale,'server');await page.getByLabel(server.path,{exact:true}).fill('example.md');await page.getByRole('button',{name:server.save,exact:true}).click();await page.getByRole('alert').waitFor()
  assert.match(await page.getByRole('alert').innerText(),/\.markdown/);assert.doesNotMatch(await page.getByRole('alert').innerText(),/private\/|service-details/)
  assert.deepEqual(await page.evaluate(()=>window.localFormatEvidence.calls),['resources/register-local-material']);assert.equal(await page.evaluate(()=>window.localFormatEvidence.pending),false)
 }
 const labels=await open('zh-CN','unknown');await page.getByLabel(labels.path,{exact:true}).fill('example.md');await page.getByRole('button',{name:labels.save,exact:true}).click();await page.getByRole('alert').waitFor()
 assert.equal(await page.getByRole('alert').innerText(),'输入内容不正确，请核对后重试。')
 assert.doesNotMatch(await page.getByRole('alert').innerText(),/private\//)
 assert.deepEqual(errors,[]);assert.deepEqual(external,[])
})
