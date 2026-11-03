import assert from 'node:assert/strict'
import {test,type TestContext} from 'node:test'
import {mkdir,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用当前工作树的无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

test('个人资料状态随当前语言重译，不重新保存或丢失草稿',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=join(root,'profile-notice.fixture.tsx')
 // 保留真实组件、I18nProvider、个人资料store/sync及账号store；只替代公开Host/账号bridge。
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';
 import {PersonalProfileSettings} from ${JSON.stringify(join(client,'PersonalProfileSettings.tsx'))};
 import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
 import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
 import {localizeWorkError} from ${JSON.stringify(join(client,'i18n/errors.ts'))};
 import {personalProfile} from ${JSON.stringify(join(client,'personal-profile.ts'))};
 import {applicationPresentation} from ${JSON.stringify(join(client,'application-presentation.ts'))};
 let snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},hostName='Before',mode='accept',release;const listeners=new Set(),calls=[];
 const i18n={t:(key,params)=>translateMessage(snapshot.locale,key,params),getSnapshot:()=>snapshot,subscribe:f=>{listeners.add(f);return()=>listeners.delete(f)}};
 const wait=()=>new Promise((resolve,reject)=>{release=outcome=>outcome==='error'?reject({code:'teloa/forbidden'}):resolve()});
 const evidence=window.profileNoticeFixture={calls,message:(locale,error)=>localizeWorkError(locale,error),locale(locale){snapshot={locale,dshLocale:locale,revision:snapshot.revision+1};for(const f of listeners)f()},mode(value){mode=value},release(value){release(value)},async managed(){await applicationPresentation.configure({presentation:async()=>({schema:'teloa.application-presentation/v1',product:'Pro',account:{displayName:'Managed name',email:'synthetic@example.invalid'}}),openAccount:async()=>{calls.push({kind:'open-account'});if(mode==='defer')await wait();else throw Error('synthetic bridge unavailable')}})}};
 personalProfile.connect(async(endpoint,payload)=>{if(endpoint==='profile/get')return {displayName:hostName};if(endpoint==='profile/save'){calls.push({kind:'save',displayName:payload.displayName});if(mode==='defer')await wait();if(mode==='error')throw {code:'teloa/forbidden'};hostName=payload.displayName;return {displayName:hostName}}throw Error('unexpected public endpoint')});
 void(async()=>{await personalProfile.ready();createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><PersonalProfileSettings/></I18nProvider>)})();`
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'profile-notice-fixture',resolveId:id=>id===virtual?virtual:undefined,load:id=>id===virtual?entry:undefined}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:virtual,name:'ProfileNotice',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,styles=bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch({...launchOptions(),headless:true});t.after(()=>browser.close())
 const open=async(t:TestContext)=>{const page=await browser.newPage({viewport:{width:1000,height:500}});t.after(()=>page.close());page.setDefaultTimeout(2500);const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1/profile-notice'?route.fulfill({contentType:'text/html',body:'<!doctype html><html><body style="font:16px system-ui;padding:24px"><div id="root"></div></body></html>'}):route.abort());await page.goto('http://127.0.0.1/profile-notice');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByRole('textbox').waitFor();return page}
 const locale=async(page:any,value:string)=>{await page.evaluate((value:string)=>(window as any).profileNoticeFixture.locale(value),value);await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}
 const calls=(page:any)=>page.evaluate(()=>(window as any).profileNoticeFixture.calls)
 const evidence=async(page:any,name:string)=>{const dir=process.env.F23_PROFILE_NOTICE_EVIDENCE_DIR;if(!dir)return;await mkdir(dir,{recursive:true});await page.screenshot({path:join(dir,name+'.png'),fullPage:true});await writeFile(join(dir,name+'.aria.txt'),await page.locator('body').ariaSnapshot())}
 await t.test('真实normalizer校验拒绝显示可纠正原因并随当前三语重译，零Host保存',async t=>{
  const page=await open(t),input=page.getByRole('textbox');await input.fill('f23@example.invalid');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('status').waitFor()
  for(const [language,expected]of [['zh-CN','显示名称不能使用邮箱，请填写姓名或昵称。'],['zh-Hant','顯示名稱不能使用電子郵件地址，請填寫姓名或暱稱。'],['en','Use a name or nickname instead of an email address.']] as const){
   await locale(page,language);await evidence(page,'validation-email-'+language);assert.equal(await page.getByRole('status').innerText(),expected);assert.deepEqual(await calls(page),[],'客户端确定校验拒绝不能调用Host或自动重试');assert.equal(await input.inputValue(),'f23@example.invalid')
  }
  await input.fill('   ');await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(await page.getByRole('status').innerText(),'Enter a display name.');assert.deepEqual(await calls(page),[])
  for(const [reason,expected]of [['profile-name-empty',['请输入显示名称。','請輸入顯示名稱。','Enter a display name.']],['profile-name-too-long',['显示名称最多 40 个字符，请缩短后再保存。','顯示名稱最多 40 個字元，請縮短後再儲存。','Use a display name of 40 characters or fewer.']]] as const){
   for(const [index,language]of ['zh-CN','zh-Hant','en'].entries()){const text=await page.evaluate(({language,reason}:{language:string;reason:string})=>(window as any).profileNoticeFixture.message(language,{code:'teloa/invalid-input',details:{reason},message:'secret raw exception /private/name'}),{language,reason});assert.equal(text,expected[index]!);assert.doesNotMatch(text,/secret|private|稍后|稍後|Try again later/i)}
  }
  const unknown=await page.evaluate(()=>(window as any).profileNoticeFixture.message('en',{code:'teloa/invalid-input',details:{reason:'unknown-profile-reason'},message:'secret raw'}));assert.match(unknown,/input/i);assert.doesNotMatch(unknown,/secret/)
  await input.fill('Corrected name');assert.equal(await page.getByRole('status').count(),0);await page.getByRole('button',{name:'Save',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(await page.getByRole('status').innerText(),'Saved.');assert.deepEqual(await calls(page),[{kind:'save',displayName:'Corrected name'}],'仅本人明确修正并保存才调用Host')
 })
 await t.test('成功状态由简中切繁中再切英文，仅保存一次',async t=>{
  const page=await open(t);await page.getByRole('textbox').fill('Saved synthetic name');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(await page.getByRole('status').innerText(),'已保存。')
  await locale(page,'zh-Hant');await evidence(page,'saved-zh-Hant');assert.equal(await page.getByRole('status').innerText(),'已儲存。')
  await locale(page,'en');assert.equal(await page.getByRole('status').innerText(),'Saved.');await evidence(page,'saved-en');assert.deepEqual(await calls(page),[{kind:'save',displayName:'Saved synthetic name'}]);assert.equal(await page.getByRole('textbox').inputValue(),'Saved synthetic name')
 })
 await t.test('保存中切语言：晚到成功和失败均按当前语言，失败保留草稿且不重发',async t=>{
  const page=await open(t);await page.evaluate(()=>(window as any).profileNoticeFixture.mode('defer'));await page.getByRole('textbox').fill('Delayed success');await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>(window as any).profileNoticeFixture.calls.length===1);await locale(page,'en');await page.evaluate(()=>(window as any).profileNoticeFixture.release('accept'));await page.getByRole('status').waitFor();assert.equal(await page.getByRole('status').innerText(),'Saved.')
  await locale(page,'zh-CN');await page.getByRole('textbox').fill('Unsent after error');await page.getByRole('button',{name:'保存',exact:true}).click();await page.waitForFunction(()=>(window as any).profileNoticeFixture.calls.length===2);await locale(page,'en');await page.evaluate(()=>(window as any).profileNoticeFixture.release('error'));await page.getByRole('status').waitFor();await evidence(page,'late-error-en');assert.equal(await page.getByRole('status').innerText(),'You do not have permission to perform this action.');assert.equal(await page.getByRole('textbox').inputValue(),'Unsent after error');assert.equal((await calls(page)).length,2)
  await locale(page,'zh-Hant');assert.equal(await page.getByRole('status').innerText(),'你沒有執行此操作的權限。');assert.equal((await calls(page)).length,2)
 })
 await t.test('已显示的保存错误随三语切换，编辑保留并清提示',async t=>{
  const page=await open(t);await page.evaluate(()=>(window as any).profileNoticeFixture.mode('error'));await page.getByRole('textbox').fill('Original failed draft');await page.getByRole('button',{name:'保存',exact:true}).click();await page.getByRole('status').waitFor();assert.equal(await page.getByRole('status').innerText(),'你没有执行此操作的权限。');await locale(page,'zh-Hant');assert.equal(await page.getByRole('status').innerText(),'你沒有執行此操作的權限。');await locale(page,'en');assert.equal(await page.getByRole('status').innerText(),'You do not have permission to perform this action.');assert.equal((await calls(page)).length,1);await page.getByRole('textbox').fill('Still unsent');assert.equal(await page.getByRole('status').count(),0);assert.equal((await calls(page)).length,1)
 })
 await t.test('管理账号失败跟随语言；只读姓名不被保存',async t=>{
  const page=await open(t);await page.evaluate(()=>(window as any).profileNoticeFixture.managed());await page.getByRole('button',{name:'管理账号',exact:true}).click();await page.getByRole('status').waitFor();const chinese=await page.getByRole('status').innerText();await locale(page,'zh-Hant');const traditional=await page.getByRole('status').innerText();assert.notEqual(traditional,chinese);await locale(page,'en');const english=await page.getByRole('status').innerText();assert.notEqual(english,traditional);assert.match(english,/account/i);assert.equal(await page.getByRole('textbox').getAttribute('readonly'),'');assert.deepEqual(await calls(page),[{kind:'open-account'}]);await evidence(page,'managed-error-en')
 })
})
