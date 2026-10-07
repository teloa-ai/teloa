import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {AboutSettings} from '${client}AboutSettings.tsx';import {WorkbenchNavigationBrand} from '${client}WorkbenchNavigationChrome.tsx';import {applicationPresentation} from '${client}application-presentation.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const theme={subscribe:()=>()=>{},getSnapshot:()=> 'light'},view=createRoot(document.getElementById('root'));let generation=0;
window.versionFixture={mount:async(locale,product)=>{await applicationPresentation.configure(product==='Free'?undefined:{presentation:async()=>({schema:'teloa.application-presentation/v1',product,account:{displayName:'Alice',email:'alice@example.test'}}),openAccount:async()=>{}});const snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};flushSync(()=>view.render(<I18nProvider key={++generation} runtime={runtime}><div id="brand"><WorkbenchNavigationBrand product={applicationPresentation.getSnapshot().product} colorScheme="light" onClose={()=>{}}/></div><div id="edition">{runtime.t('app.edition.personal')}</div><div id="about"><AboutSettings theme={theme}/></div></I18nProvider>));return applicationPresentation.getSnapshot()}};
`

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-community-presentation-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"',__TELOA_VERSION__:'"0.2.0-alpha.7"'},build:{write:false,minify:false,rollupOptions:{treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'CommunityPresentationFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

test('十语言真实关于页、侧栏与版本标签统一显示社区版；三种宿主各自只高亮当前版本',async t=>{
 const page=await browser.newPage(),errors:string[]=[],requests:string[]=[]
 let checksPassed=false
 page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text().slice(0,1000))})
 t.after(async()=>{if(!checksPassed)t.diagnostic(await page.locator('body').innerText());await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 // 使用可信本机来源，保留反馈表单依赖的真实 crypto.randomUUID；页面仅由夹具响应，无网络请求。
 const fixtureURL='http://127.0.0.1/teloa-community-version-fixture'
 await page.route(fixtureURL,(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}))
 await page.goto(fixtureURL);await page.addScriptTag({content:script})
 for(const locale of ['zh-CN','zh-Hant','en','ja','ko','vi','es','fr','de','pt']){
  const label=locale==='zh-CN'?'社区版':locale==='zh-Hant'?'社區版':'Community'
  const snapshot=await page.evaluate((locale:string)=>(window as any).versionFixture.mount(locale,'Free'),locale)
  assert.equal(snapshot.product,'Free','展示改名保留兼容协议值');assert.equal(snapshot.account,null)
  await page.locator('#brand [class*="brandTier"]').filter({hasText:label}).waitFor()
  assert.equal(await page.locator('#edition').textContent(),label,locale)
  assert.deepEqual(await page.locator('#about article > strong').allTextContents(),[label,'Pro','Enterprise'],locale)
  assert.equal(await page.locator('#about article[class*="planCardCurrent"] > strong').textContent(),label,locale)
  assert.doesNotMatch(await page.locator('#about').innerText(),/\bFree\b|Personal edition/,locale)
  assert.equal(await page.locator('img[alt="Teloa"]').count(),2,'产品始终是 Teloa')
 }
 for(const product of ['Pro','Enterprise']){
  await page.evaluate((product:string)=>(window as any).versionFixture.mount('zh-CN',product),product)
  await page.locator('#brand [class*="brandTier"]').filter({hasText:product}).waitFor()
  assert.deepEqual(await page.locator('#about article > strong').allTextContents(),['社区版','Pro','Enterprise'])
  assert.equal(await page.locator('#about article[class*="planCardCurrent"] > strong').textContent(),product)
  const cards=page.locator('#about article')
  assert.match(await cards.nth(0).innerText(),/公开核心 · 自行部署/)
  assert.match(await cards.nth(1).innerText(),/Mac 本机工作[\s\S]*手机远程（尚未开放）/)
  assert.match(await cards.nth(2).innerText(),/企业独立部署与治理（尚未开放）/)
  const text=await page.locator('#about').innerText()
  assert.match(text,/公开 Web 仅用于注册、登录、账号恢复与返回客户端/)
  assert.match(text,/所有版本均需自备模型 API 密钥，模型费用另计/)
  assert.equal(await page.locator('#about article button').count(),0,'版本说明不虚构购买入口')
 }
 checksPassed=true
})
