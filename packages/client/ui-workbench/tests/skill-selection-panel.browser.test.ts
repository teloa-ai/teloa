import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('默认安装选择经真实API和React明确确认，丢回包与迟到结果保留身份边界',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-skill-selection-panel-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useMemo,useState} from 'react';import {createRoot} from 'react-dom/client';import {SkillInstallControl} from ${JSON.stringify(join(client,'SkillInstallControl.tsx'))};import {SkillSelectionPanel} from ${JSON.stringify(join(client,'SkillSelectionPanel.tsx'))};import {createSkillInstallApi} from ${JSON.stringify(join(client,'skill-install-api.ts'))};import {createSkillSelectionApi} from ${JSON.stringify(join(client,'skill-selection-api.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};import css from ${JSON.stringify(join(client,'MarketPage.module.css'))};
const hash=c=>c.repeat(64),oldId='11111111-1111-4111-8111-111111111111',targetId='22222222-2222-4222-8222-222222222222',thirdId='33333333-3333-4333-8333-333333333333',loadId='44444444-4444-4444-8444-444444444444',itemInstanceId='55555555-5555-4555-8555-555555555555',ownerId='local:teloa-owner',oldAt='2026-10-28T00:00:00.000Z',at='2026-10-28T00:01:00.000Z',native={name:'soc-t1-triage',description:'调查',modelInvocable:true,userInvocable:true,bodyHash:hash('c')},stable=value=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item),digest=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stable(value)))),byte=>byte.toString(16).padStart(2,'0')).join('');
const makeRecord=(id,publisher,trustHash)=>({id,ownerId,source:{kind:'industry-local',loadId,itemInstanceId,contentId:id,contentHash:hash('a'),resourceId:'soc-t1-triage',resourceVersion:'1.2.2'},bundleHash:hash('d'),native,trust:{publisher,repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'unknown',dsh:'unknown'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'review'}},trustHash,state:'installed',version:2,createdAt:oldAt,updatedAt:oldAt});
const old=makeRecord(oldId,'原发布者',hash('e')),target=makeRecord(targetId,'当前包发布者',hash('f')),third=makeRecord(thirdId,'第三目标发布者',hash('9')),records=[old,target,third],usages=[{loadId:'66666666-6666-4666-8666-666666666666',itemInstanceId:'77777777-7777-4777-8777-777777777777',installationId:oldId},{loadId,itemInstanceId,installationId:targetId}],fixture=window.fixture={calls:[],commands:[],changed:0,selection:{ownerId,nativeName:native.name,installationId:oldId,version:1,updatedAt:oldAt},loseOnce:false,hold:false,release:undefined},receipts=new Map();
const impactFor=selected=>({nativeName:native.name,selection:{installationId:fixture.selection.installationId,version:fixture.selection.version},current:{installationId:fixture.selection.installationId,installationVersion:2,bundleHash:hash('d'),availability:'enabled',availabilityVersion:1},target:{installationId:selected.id,installationVersion:2,bundleHash:selected.bundleHash,availability:'enabled',availabilityVersion:1},industryUsages:[{loadId:usages[0].loadId,itemInstanceId:usages[0].itemInstanceId}]});
const call=async(endpoint,payload)=>{fixture.calls.push({endpoint,payload});if(endpoint==='skill-installations/get')return records.find(row=>row.id===payload.installationId);if(endpoint==='skill-installations/list')return {items:records,usages};if(endpoint==='skill-installations/preview')return {source:target.source,bundleHash:target.bundleHash,native,trust:target.trust,trustHash:target.trustHash,files:[{path:'SKILL.md',hash:hash('c'),size:100}],installationPlan:{skills:[{id:'soc-t1-triage',version:'1.2.2',path:'SKILL.md'}],plugins:[],connections:[],permissions:[]}};if(endpoint==='skill-installations/observe')return {installationId:payload.installationId,scope:'default-workspace',state:fixture.selection.installationId===payload.installationId?'available':'shadowed',...(fixture.selection.installationId===payload.installationId?{}:{reason:'different-source'}),current:{...native,provider:'teloa-market',source:fixture.selection.installationId}};if(endpoint==='skill-selections/get')return fixture.selection;if(endpoint==='skill-selections/preview'){const selected=records.find(row=>row.id===payload.targetInstallationId),impact=impactFor(selected),value={selection:fixture.selection,current:records.find(row=>row.id===fixture.selection.installationId),target:selected,impact,impactDigest:await digest(impact)};if(fixture.hold)return new Promise(resolve=>{fixture.release=()=>{fixture.hold=false;resolve(value)}});return value};if(endpoint==='skill-selections/change'){fixture.commands.push(structuredClone(payload));if(receipts.has(payload.requestId))return {...receipts.get(payload.requestId),current:fixture.selection};const before=fixture.selection,selected=records.find(row=>row.id===payload.targetInstallationId),impact=impactFor(selected),impactDigest=await digest(impact);if(payload.expectedImpactDigest!==impactDigest||payload.industryUsages.length)throw Error('unsafe request');const result={...before,installationId:selected.id,version:before.version+1,updatedAt:at};fixture.selection=result;const value={receipt:{requestId:payload.requestId,nativeName:native.name,before,result,migratedIndustryUsages:[],impact,impactDigest,createdAt:at},current:result};receipts.set(payload.requestId,value);if(fixture.loseOnce){fixture.loseOnce=false;throw Error('response lost')}return value};throw Error('unexpected endpoint')};
const journal={read:()=>localStorage.getItem('selection-journal'),write:value=>localStorage.setItem('selection-journal',value),clear:()=>localStorage.removeItem('selection-journal')},snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};
function App(){const [epoch,setEpoch]=useState(0),[selected,setSelected]=useState(target),selectionApi=useMemo(()=>createSkillSelectionApi(call,journal),[epoch]),api=useMemo(()=>createSkillInstallApi(call,undefined,selectionApi),[selectionApi]);fixture.remount=()=>setEpoch(value=>value+1);fixture.switchTarget=()=>setSelected(third);const onChanged=()=>fixture.changed++;return <I18nProvider runtime={i18n}><main className={css.detail} style={{maxWidth:680,margin:'24px auto',padding:16}}>{window.testMode==='direct'?<SkillSelectionPanel api={selectionApi} record={selected} onChanged={onChanged}/>:<SkillInstallControl api={api} source={{kind:'industry',loadId,itemInstanceId}} title="T1方法" changed={onChanged}/>}</main></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'SkillSelectionFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n'),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const mount=async(mode='control')=>{const page=await browser.newPage({viewport:{width:1100,height:900}}),errors:string[]=[];page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/skill-selection'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1/skill-selection');await page.evaluate((value:string)=>{(window as any).testMode=value},mode);if(styles)await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('button',{name:'预览设为默认版本',exact:true}).waitFor();return {page,errors}}
 const previewAndConfirm=async(page:any)=>{await page.getByRole('button',{name:'预览设为默认版本',exact:true}).click();const preview=page.getByRole('region',{name:'默认选择切换预览',exact:true});await preview.waitFor();await preview.getByRole('checkbox').check();await preview.getByRole('button',{name:'确认设为默认版本',exact:true}).click()}
 await t.test('先预览两侧发布者与摘要，明确确认后只切默认选择，再真实observe新来源可用',async()=>{
  const {page,errors}=await mount();try{
   assert.equal(await page.evaluate(()=>(window as any).fixture.commands.length),0)
   await page.getByRole('button',{name:'预览设为默认版本',exact:true}).click();const preview=page.getByRole('region',{name:'默认选择切换预览',exact:true});await preview.waitFor()
   await preview.getByText('原发布者',{exact:true}).waitFor();await preview.getByText('当前包发布者',{exact:true}).waitFor();await preview.getByText(/保留原安装的 1 项加载引用，本次迁移 0 项/).waitFor()
   assert.equal(await preview.getByRole('button',{name:'确认设为默认版本',exact:true}).isDisabled(),true)
   await preview.getByRole('checkbox').check();await preview.getByRole('button',{name:'确认设为默认版本',exact:true}).click();await page.getByText('此安装已是当前 Teloa 的默认选择。',{exact:true}).waitFor()
   const commands=await page.evaluate(()=>(window as any).fixture.commands);assert.equal(commands.length,1);assert.deepEqual(commands[0].industryUsages,[])
   assert.equal(await page.evaluate(()=>(window as any).fixture.calls.some((row:any)=>row.endpoint==='skill-installations/install')),false)
   await page.getByRole('button',{name:'核对默认工作区可用性',exact:true}).click();await page.getByText('默认工作区可用',{exact:true}).waitFor();assert.deepEqual(errors,[])
   await page.setViewportSize({width:390,height:844});assert.ok(await page.locator('main').evaluate((element:HTMLElement)=>element.scrollWidth<=element.clientWidth+1))
  }finally{await page.close()}
 })
 await t.test('提交丢回包后重建API仍恢复同requestId，不重装或迁移旧引用',async()=>{
  const {page,errors}=await mount();try{
   await page.evaluate(()=>(window as any).fixture.loseOnce=true);await previewAndConfirm(page);await page.getByRole('button',{name:'核对原默认选择请求',exact:true}).waitFor()
   const request=await page.evaluate(()=>(window as any).fixture.commands[0]);assert.ok(await page.evaluate(()=>localStorage.getItem('selection-journal')))
   await page.evaluate(()=>(window as any).fixture.remount());await page.getByRole('button',{name:'核对原默认选择请求',exact:true}).click();await page.getByText('原切换请求已确认；当前选择以上方最新状态为准。',{exact:true}).waitFor()
   const commands=await page.evaluate(()=>(window as any).fixture.commands);assert.equal(commands.length,2);assert.deepEqual(commands[1],request);assert.equal(await page.evaluate(()=>localStorage.getItem('selection-journal')),null);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('损坏恢复记录可明确丢弃并回显，保留不会撤销已发切换的说明',async()=>{
  const {page,errors}=await mount('direct');try{
   await page.evaluate(()=>{localStorage.setItem('selection-journal','{broken');(window as any).fixture.remount()})
   await page.getByText('可丢弃这条恢复记录后重试；若上一次请求已经生效，请到对应目录核对。',{exact:true}).waitFor()
   await page.getByText('放弃恢复记录不会撤销已经发送的切换。请刷新当前选择后再决定下一步。',{exact:true}).waitFor()
   await page.getByRole('button',{name:'丢弃这条恢复记录',exact:true}).click()
   await page.getByText('已丢弃本地恢复记录；如果上一次请求已经生效，请到目录里核对。',{exact:true}).waitFor()
   assert.equal(await page.evaluate(()=>localStorage.getItem('selection-journal')),null);assert.equal(await page.evaluate(()=>(window as any).fixture.commands.length),0);assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('A目标迟到的预览不能出现在已切至B的面板，也不会触发onChanged或change',async()=>{
  const {page,errors}=await mount('direct');try{
   await page.evaluate(()=>(window as any).fixture.hold=true);await page.getByRole('button',{name:'预览设为默认版本',exact:true}).click();await page.waitForFunction(()=>typeof (window as any).fixture.release==='function')
   await page.evaluate(()=>(window as any).fixture.switchTarget());await page.getByText('同名技能的默认选择仍是另一份安装。可先预览切换影响。',{exact:true}).waitFor();await page.evaluate(()=>(window as any).fixture.release())
   await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.textContent==='预览设为默认版本'&&!button.disabled))
   assert.equal(await page.getByRole('region',{name:'默认选择切换预览',exact:true}).count(),0);assert.equal(await page.evaluate(()=>(window as any).fixture.changed),0);assert.equal(await page.evaluate(()=>(window as any).fixture.commands.length),0)
   await page.getByRole('button',{name:'预览设为默认版本',exact:true}).click();await page.getByText('第三目标发布者',{exact:true}).waitFor();assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
})
