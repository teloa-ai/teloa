import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('撤回确认取消零写，丢回包关闭重开核对原请求，所有版本仍可读且新修改反馈受限',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-artifact-withdrawal-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 const file={schema:'teloa.file-snapshot/v1',sessionId:'22222222-2222-4222-8222-222222222222',id:'a'.repeat(64),path:'result.txt',bytes:8,sha256:createHash('sha256').update('original').digest('hex'),capturedAt:'2026-10-29T00:00:00.000Z',contentBase64:Buffer.from('original').toString('base64')}
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{ArtifactPanel}from${JSON.stringify(join(client,'ArtifactPanel.tsx'))};import{createArtifactApi}from${JSON.stringify(join(client,'artifact-api.ts'))};import{emptyTaskPreview}from${JSON.stringify(join(client,'task-preview.ts'))};import tokens from${JSON.stringify(join(client,'theme-tokens.module.css'))};document.body.classList.add(tokens.tokens);import{prototypeThemes}from${JSON.stringify(join(client,'../brand/prototype-theme.ts'))};import{I18nProvider}from${JSON.stringify(join(client,'i18n/provider.tsx'))};import{translateMessage}from${JSON.stringify(join(client,'i18n/messages.ts'))};for(const[k,v]of Object.entries(prototypeThemes.light))document.body.style.setProperty(k,v);const id='11111111-1111-4111-8111-111111111111',sessionId='22222222-2222-4222-8222-222222222222',source={kind:'session',id:sessionId},savedSource={...source,scope:'general',version:'binding',title:'原始工作'},file=${JSON.stringify(file)},at='2026-10-29T00:00:00.000Z',artifact={id,source,storage:'persistent',primary:true,links:[],feedback:[],versions:[1,2].map(number=>({number,title:'交付结果',sections:[{id:'body',title:'说明',text:'保留的历史正文 '+number}],source:{ref:source,scope:'general',version:'binding',title:'原始工作',author:'本人',private:true,evidence:[]},note:'版本说明 '+number,author:'本人',at,files:[file]}))};let record=null,withdrawal=null,loseReply=true;const f={writes:[],changes:[],prepared:[],availabilityReads:0};window.withdrawalFixture=f;const journal={read:()=>record,write:x=>record=x,clear:()=>record=null},call=async(method,payload)=>{if(method==='artifacts/availability'){f.availabilityReads++;return withdrawal?{artifactId:id,state:'withdrawn',withdrawal}:{artifactId:id,state:'available',withdrawal:null}}if(method==='artifacts/versions')return artifact.versions.map(v=>({artifactId:id,ownerId:'owner',number:v.number,source:savedSource,content:{title:v.title,sections:v.sections,snapshotIds:[],note:v.note},createdAt:at}));if(method==='artifacts/withdraw'){if(!record)throw Error('原请求未先持久化');f.writes.push(structuredClone(payload));withdrawal??={...payload,withdrawnAt:'2026-10-29T01:00:00.000Z'};if(loseReply){loseReply=false;throw Error('已提交，回包丢失')}return withdrawal}throw Error('未声明调用 '+method)};const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale,revision:1},runtime={t:(k,p)=>translateMessage(locale,k,p),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};f.t=runtime.t;function App(){const[open,setOpen]=useState(true),[api,setApi]=useState(()=>createArtifactApi(call,journal));f.reopen=()=>setOpen(true);f.replaceApi=()=>setApi(()=>createArtifactApi(call,journal));return <I18nProvider runtime={runtime}><button onClick={()=>setOpen(true)}>Reopen fixture</button><aside style={{width:780,height:840}}><ArtifactPanel inline open={open} artifactAvailability={api} revisionIdentity={api} prepareModification={async(...args)=>{f.prepared.push(args)}} requestMethodReuse={async()=>{throw Error('撤回后不得准备方法')}} target={{source,artifact:{id,version:2}}} state={{...emptyTaskPreview(),artifacts:[artifact]}} conversation={{id:sessionId,title:'原始工作',scope:'general',bindingId:'binding'}} taskSources={{list:async()=>[]}} nativeArtifacts={{}} artifactFileApi={{}} close={()=>setOpen(false)} change={async c=>f.changes.push(c)} openSource={()=>{}} openTask={()=>{}}/></aside></I18nProvider>}createRoot(document.getElementById('root')).render(<App/>);`)
 const built=await build({root,configFile:false,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),formats:['iife'],name:'ArtifactWithdrawalFixture'},rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle)
 const browser=await loadPlaywright().chromium.launch({...launchOptions(),headless:true});t.after(()=>browser.close())
 const evidence=process.env.TELOA_ARTIFACT_WITHDRAWAL_EVIDENCE_DIR;if(evidence)await mkdir(evidence,{recursive:true})
 for(const [locale,more,withdraw,confirmTitle,cancel,recover,withdrawn,modify,history,advanced,instruction,hide]of[
  ['zh-CN','更多','撤回成果','撤回成果？','取消','核对撤回结果','已撤回','修改','版本历史','版本与反馈','修改要求','收起修改要求'],
  ['zh-TW','更多','撤回成果','撤回成果？','取消','核對撤回結果','已撤回','修改','版本歷程','版本與回饋','修改要求','收起修改要求'],
  ['en','More','Withdraw artifact','Withdraw this artifact?','Cancel','Check withdrawal result','Withdrawn','Modify','Version history','Versions and feedback','Modification request','Hide modification request'],
 ]as const){
  const page=await browser.newPage({viewport:{width:1280,height:980},serviceWorkers:'block'});t.after(()=>page.close());page.setDefaultTimeout(5000)
  const errors:string[]=[],external:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message))
  await page.route('**/*',(r:any)=>r.request().url()==='http://127.0.0.1:41838/__withdrawal_fixture__'?r.fulfill({contentType:'text/html',body:'<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>'}):(external.push(new URL(r.request().url()).protocol),r.abort()))
  await page.goto('http://127.0.0.1:41838/__withdrawal_fixture__')
  await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui;color:var(--teloa-text);background:var(--teloa-background)}'+bundle.output.flatMap(x=>x.type==='asset'&&x.fileName.endsWith('.css')?[String(x.source)]:[]).join('\n')})
  await page.addScriptTag({content:bundle.output.find(x=>x.type==='chunk')!.code})
  const panel=page.locator('dialog').first(),reader=panel.locator('[data-artifact-reader]'),modifyButton=reader.getByRole('button',{name:modify,exact:true})
  await modifyButton.waitFor();await page.waitForFunction(()=>!(document.querySelector('[data-artifact-reader] button') as HTMLButtonElement)?.disabled)
  await modifyButton.click();const draft=reader.getByRole('textbox',{name:instruction,exact:true});await draft.fill('保留未提交的修改要求')
  await reader.getByRole('button',{name:hide,exact:true}).click()
  await reader.getByRole('button',{name:more,exact:true}).click();await reader.getByRole('menuitem',{name:withdraw,exact:true}).click()
  let dialog=page.getByRole('dialog',{name:confirmTitle,exact:true});await dialog.waitFor()
  assert.match(await dialog.textContent()??'',locale==='en'?/all versions/i:/所有版本/)
  await dialog.getByRole('button',{name:cancel,exact:true}).click()
  assert.equal(await page.evaluate(()=>(window as any).withdrawalFixture.writes.length),0)
  await modifyButton.click();assert.equal(await draft.inputValue(),'保留未提交的修改要求');await reader.getByRole('button',{name:hide,exact:true}).click()
  await reader.getByRole('button',{name:more,exact:true}).click();await reader.getByRole('menuitem',{name:withdraw,exact:true}).click()
  dialog=page.getByRole('dialog',{name:confirmTitle,exact:true})
  if(evidence)await page.screenshot({path:join(evidence,'confirm-'+locale+'.png')})
  await dialog.getByRole('button',{name:withdraw,exact:true}).click()
  await reader.getByRole('button',{name:recover,exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>(window as any).withdrawalFixture.writes.length),1)
  await panel.locator('[data-artifact-close]').click();await page.evaluate(()=>(window as any).withdrawalFixture.replaceApi());await page.getByRole('button',{name:'Reopen fixture',exact:true}).click()
  await reader.getByRole('button',{name:recover,exact:true}).waitFor()
  assert.equal(await page.evaluate(()=>(window as any).withdrawalFixture.writes.length),1,'重开不自动重发撤回')
  await reader.getByRole('button',{name:recover,exact:true}).click()
  await reader.getByText(new RegExp('^'+withdrawn)).first().waitFor()
  await page.waitForFunction(()=>(window as any).withdrawalFixture.writes.length===2)
  const sent=await page.evaluate(()=>(window as any).withdrawalFixture.writes);assert.equal(sent.length,2);assert.deepEqual(sent[0],sent[1])
  assert.equal(await modifyButton.isDisabled(),true)
  await reader.getByRole('button',{name:history,exact:true}).click();await page.getByRole('dialog',{name:history,exact:true}).getByRole('button',{name:/^v1(?:\s|$)/}).click()
  assert.equal(await modifyButton.isDisabled(),true)
  assert.equal(await reader.getByRole('link',{name:locale==='en'?'Download original':locale==='zh-TW'?'下載原檔':'下载原件',exact:true}).getAttribute('download'),'result.txt')
  await reader.getByRole('button',{name:more,exact:true}).click();await reader.getByRole('menuitem',{name:advanced,exact:true}).click()
  const advancedDialog=page.getByRole('dialog',{name:advanced,exact:true}),labels=await page.evaluate(()=>Object.fromEntries(['079','080'].map(key=>[key,(window as any).withdrawalFixture.t('artifact.panel.text.'+key)])))
  assert.equal(await advancedDialog.getByRole('textbox',{name:labels['079'],exact:true}).isDisabled(),true)
  assert.equal(await advancedDialog.getByRole('button',{name:labels['080'],exact:true}).isDisabled(),true)
  assert.deepEqual(await page.evaluate(()=>(window as any).withdrawalFixture.changes),[])
  assert.deepEqual(await page.evaluate(()=>(window as any).withdrawalFixture.prepared),[])
  await advancedDialog.getByRole('button',{name:/关闭|關閉|Close/}).click()
  if(evidence)await page.screenshot({path:join(evidence,'withdrawn-'+locale+'.png')})
  assert.deepEqual(errors,[]);assert.deepEqual(external,[])
 }
})
