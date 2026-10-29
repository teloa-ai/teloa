import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('包升级的原安装准确展示，只有本人确认才登记新usage，差异不冒认为可沿用',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-skill-upgrade-reuse-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {SkillInstallControl} from ${JSON.stringify(join(client,'SkillInstallControl.tsx'))};import {createSkillInstallApi} from ${JSON.stringify(join(client,'skill-install-api.ts'))};import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
const oldLoad='11111111-1111-4111-8111-111111111111',loadId='22222222-2222-4222-8222-222222222222',itemInstanceId='33333333-3333-4333-8333-333333333333',installationId='44444444-4444-4444-8444-444444444444',stamp='2026-10-28T00:00:00.000Z',hash=c=>c.repeat(64),native={name:'soc-t1-triage',description:'本轮告警调查',bodyHash:hash('c'),modelInvocable:true,userInvocable:true},trust={publisher:'测试发布者',repository:null,license:{status:'declared',value:'MIT'},signature:{status:'unverified',signer:null},compatibility:{teloa:'unknown',dsh:'unknown'},plugins:[],externalCapabilities:[],permissions:[],review:{conclusion:'needs-review',summary:'待核对'}};
const oldSource={kind:'industry-local',loadId:oldLoad,itemInstanceId:'55555555-5555-4555-8555-555555555555',contentId:'66666666-6666-4666-8666-666666666666',contentHash:hash('a'),resourceId:'soc-t1-triage',resourceVersion:'1.2.2'},newSource={...oldSource,loadId,itemInstanceId,contentId:'77777777-7777-4777-8777-777777777777',contentHash:hash('b')},record={id:installationId,ownerId:'local:test-owner',source:oldSource,bundleHash:hash('d'),native,trust,trustHash:hash('e'),state:'installed',version:2,createdAt:stamp,updatedAt:stamp};
const fixture=window.fixture={calls:[],linked:false,observation:'missing',mode:window.testMode??'equivalent'};
const fixed={source:newSource,bundleHash:fixture.mode==='files'?hash('9'):record.bundleHash,native:fixture.mode==='native'?{...native,description:'新描述'}:native,trust,trustHash:fixture.mode==='trust'?hash('9'):record.trustHash,files:[{path:'SKILL.md',hash:hash('c'),size:100}],installationPlan:{skills:[{id:'soc-t1-triage',version:'1.2.2',path:'SKILL.md'}],plugins:[],connections:[],permissions:[]}};
const api=createSkillInstallApi(async(endpoint,payload)=>{fixture.calls.push({endpoint,payload});if(endpoint==='skill-installations/preview')return fixed;if(endpoint==='skill-installations/list')return {items:[record],usages:fixture.linked?[{loadId,itemInstanceId,installationId}]:[]};if(endpoint==='skill-installations/install'){fixture.linked=true;return {installation:record,source:newSource}};if(endpoint==='skill-installations/observe')return {installationId,scope:'default-workspace',state:fixture.observation,current:fixture.observation==='available'?{...native,provider:'teloa-market',source:'original-installed-directory'}:null};throw Error('unexpected endpoint')});
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},i18n={t:(key,params)=>translateMessage('zh-CN',key,params),getSnapshot:()=>snapshot,subscribe:()=>()=>{}};createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><main style={{maxWidth:600,margin:'24px auto',padding:16}}><SkillInstallControl api={api} source={{kind:'industry',loadId,itemInstanceId}} title="T1调查方法"/></main></I18nProvider>);
`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:')},lib:{entry:join(temp,'fixture.tsx'),name:'SkillUpgradeReuse',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n'),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const mount=async(mode='equivalent')=>{
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors:string[]=[];page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/skill-upgrade-reuse'?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
  await page.goto('http://127.0.0.1/skill-upgrade-reuse');await page.evaluate((value:string)=>{(window as any).testMode=value},mode);if(styles)await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
  return {page,errors}
 }
 await t.test('原安装与固定版本可见，未自动登记；沿用只注册当前加载，再核对真实工作区',async()=>{
  const {page,errors}=await mount();try{
   const reuse=page.getByRole('button',{name:'沿用到当前加载：T1调查方法',exact:true});await reuse.waitFor()
   await page.getByText('已安装 · 默认工作区可用性待核对',{exact:true}).waitFor()
   await page.getByText('已装固定资源：soc-t1-triage · 版本 1.2.2',{exact:true}).waitFor()
   await page.getByText('此技能已安装，但尚未关联当前行业加载。',{exact:true}).waitFor()
   assert.equal(await page.getByText('尚未安装',{exact:true}).count(),0)
   assert.equal(await page.evaluate(()=>(window as any).fixture.calls.some((row:any)=>row.endpoint==='skill-installations/install')),false)
   await reuse.click();await reuse.waitFor({state:'hidden'})
   const calls=await page.evaluate(()=>(window as any).fixture.calls),installed=calls.filter((row:any)=>row.endpoint==='skill-installations/install')
   assert.equal(installed.length,1);assert.equal(installed[0].payload.source.loadId,'22222222-2222-4222-8222-222222222222');assert.equal(installed[0].payload.expectedTrustHash,'e'.repeat(64));assert.equal(installed[0].payload.expectedBundleHash,'d'.repeat(64))
   assert.equal(await page.getByText('默认工作区可用',{exact:true}).count(),0,'保存usage不能冒充可用性观测')
   await page.getByRole('button',{name:'核对默认工作区可用性',exact:true}).click();await page.getByText('默认工作区未发现此技能',{exact:true}).waitFor()
   assert.equal(await page.getByText('尚未安装',{exact:true}).count(),0,'工作区缺失不抹除全局已安装事实')
   assert.deepEqual(errors,[])
  }finally{await page.close()}
 })
 await t.test('文件、信任和原生变化逐项提示，不能显示沿用按钮或自动安装',async()=>{
  for(const [mode,label] of [['files','全部文件校验值'],['trust','信任说明'],['native','原生名称、正文或调用配置']] as const){
   const {page,errors}=await mount(mode);try{
    await page.getByText('已有安装与当前来源不一致',{exact:true}).waitFor();assert.match(await page.getByRole('status').innerText(),new RegExp(label))
    assert.equal(await page.getByRole('button',{name:/沿用到当前加载/}).count(),0)
    await page.getByRole('button',{name:'核对并安装当前来源',exact:true}).waitFor()
    assert.equal(await page.evaluate(()=>(window as any).fixture.calls.some((row:any)=>row.endpoint==='skill-installations/install')),false)
    assert.deepEqual(errors,[])
   }finally{await page.close()}
  }
 })
})
