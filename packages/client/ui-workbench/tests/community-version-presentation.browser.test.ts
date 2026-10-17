import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import {aboutContactBuildProfile} from '../about-contact-profile.ts'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {flushSync} from 'react-dom';import {AboutSettings} from '${client}AboutSettings.tsx';import {WorkbenchNavigationBrand} from '${client}WorkbenchNavigationChrome.tsx';import {applicationPresentation} from '${client}application-presentation.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const theme={subscribe:()=>()=>{},getSnapshot:()=> 'light'},view=createRoot(document.getElementById('root'));let generation=0;
const configure=product=>applicationPresentation.configure(product==='Free'?undefined:{presentation:async()=>({schema:'teloa.application-presentation/v1',product,account:{displayName:'Alice',email:'alice@example.test'}}),openAccount:async()=>{}});
window.versionFixture={configure,mount:async(locale,product)=>{await configure(product);const snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};flushSync(()=>view.render(<I18nProvider key={++generation} runtime={runtime}><div id="brand"><WorkbenchNavigationBrand product={applicationPresentation.getSnapshot().product} colorScheme="light" onClose={()=>{}}/></div><div id="edition">{runtime.t('app.edition.personal')}</div><div id="about"><AboutSettings theme={theme}/></div></I18nProvider>));return applicationPresentation.getSnapshot()}};
`

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-community-presentation-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',resolve:{alias:aboutContactBuildProfile('community').alias},define:{'process.env.NODE_ENV':'"development"',__TELOA_VERSION__:'"0.2.0-alpha.7"'},build:{write:false,minify:false,rollupOptions:{treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'CommunityPresentationFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

test('关于页按三个版本的适用对象与使用方式比较，共用能力只说明一次',async t=>{
 const page=await browser.newPage({viewport:{width:1440,height:900}});t.after(()=>page.close())
 await page.route('**/*',(route:any)=>route.abort())
 const url='http://127.0.0.1/teloa-about-layout-fixture'
 await page.route(url,(route:any)=>route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}))
 await page.goto(url);await page.addScriptTag({content:script})
 await page.evaluate(()=>(window as any).versionFixture.mount('zh-CN','Free'))
 const table=page.getByRole('table',{name:'版本定位',exact:true})
 assert.deepEqual(await table.getByRole('columnheader').allTextContents(),['版本','适用对象','使用方式'])
 assert.equal(await table.locator('tbody tr').count(),3)
 assert.equal(await table.getByText('当前版本',{exact:true}).count(),1)
 assert.match(await table.innerText(),/社区版[\s\S]*Pro[\s\S]*Enterprise/)
 assert.equal(await table.getByRole('button').count(),0,'版本定位不授予功能或购买权限')
 assert.equal(await page.locator('#about ul').count(),0,'不再堆叠重复的功能清单')
})

test('简繁英真实关于页保留社区联系；商业宿主只显示官方联系并各自高亮当前版本',async t=>{
 const page=await browser.newPage(),errors:string[]=[],requests:string[]=[]
 let checksPassed=false
 page.setDefaultTimeout(6000);page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text().slice(0,1000))})
 t.after(async()=>{if(!checksPassed)t.diagnostic(await page.locator('body').innerText());await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 // 使用可信本机来源，保留反馈表单依赖的真实 crypto.randomUUID；页面仅由夹具响应，无网络请求。
 const fixtureURL='http://127.0.0.1/teloa-community-version-fixture'
 await page.route(fixtureURL,(route:any)=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}))
 await page.goto(fixtureURL);await page.addScriptTag({content:script})
 for(const locale of ['zh-CN','zh-Hant','en']){
  const label=locale==='zh-CN'?'社区版':locale==='zh-Hant'?'社區版':'Community'
  const snapshot=await page.evaluate((locale:string)=>(window as any).versionFixture.mount(locale,'Free'),locale)
  assert.equal(snapshot.product,'Free','展示改名保留兼容协议值');assert.equal(snapshot.account,null)
  await page.locator('#brand [class*="brandTier"]').filter({hasText:label}).waitFor()
  assert.equal(await page.locator('#edition').textContent(),label,locale)
  assert.deepEqual(await page.locator('#about tbody tr > th > strong').allTextContents(),[label,'Pro','Enterprise'],locale)
  assert.equal(await page.locator('#about tr[class*="editionCurrent"] > th > strong').textContent(),label,locale)
  if(locale==='zh-CN')assert.deepEqual(await page.locator('#about tbody tr[aria-current="true"] [class*="srOnly"]').allTextContents(),['当前版本'])
  assert.doesNotMatch(await page.locator('#about section[class*="plansSection"]').innerText(),/\bFree\b|Personal edition|Alpha|not yet available|planned|Public Web/i,locale)
  assert.equal(await page.locator('img[alt="Teloa"]').count(),2,'产品始终是 Teloa')
  assert.deepEqual(await page.locator('#about [class*="contactNames"] strong').allTextContents(),['Max Luo','Morgan Chen','Caleb Pan'])
  assert.deepEqual(await page.locator('#about [class*="contactLinks"] a').evaluateAll((links:any[])=>links.map(link=>link.getAttribute('href'))),['https://teloa.ai','https://github.com/teloa-ai/'])
  assert.equal(await page.locator('#about [class*="connectionActions"] button').count(),locale==='zh-CN'?3:1)
 }
 for(const product of ['Pro','Enterprise']){
  // 切换同一个真实组件时，已经打开的个人二维码也必须从商业版移除。
  await page.evaluate(()=>(window as any).versionFixture.mount('zh-CN','Free'))
  await page.getByRole('button',{name:'联系作者',exact:true}).click();await page.getByRole('dialog').waitFor()
  await page.evaluate((product:string)=>(window as any).versionFixture.configure(product),product)
  await page.waitForFunction(()=>document.querySelectorAll('#about [role="dialog"]').length===0)
  await page.evaluate((product:string)=>(window as any).versionFixture.mount('zh-CN',product),product)
  await page.locator('#brand [class*="brandTier"]').filter({hasText:product}).waitFor()
  assert.deepEqual(await page.locator('#about tbody tr > th > strong').allTextContents(),['社区版','Pro','Enterprise'])
  assert.equal(await page.locator('#about tr[class*="editionCurrent"] > th > strong').textContent(),product)
  const cards=page.locator('#about tbody tr')
  assert.match(await cards.nth(0).innerText(),/开源、自行部署/)
  assert.match(await cards.nth(1).innerText(),/Mac 原生工作台[\s\S]*本机执行[\s\S]*手机接续原会话、审批与成果/)
  assert.match(await cards.nth(2).innerText(),/企业云或内网部署[\s\S]*组织成员[\s\S]*共享员工[\s\S]*SSO[\s\S]*权限与审计/)
  const text=await page.locator('#about section[class*="plansSection"]').innerText()
  assert.match(text,/版本定位/)
  assert.doesNotMatch(text,/三个版本共用 Teloa 核心|自备模型 API 密钥/,'关于页不再重复共享说明')
  assert.doesNotMatch(text,/规划中|尚未开放|公开 Web|Alpha/)
  assert.equal(await page.locator('#about tbody tr[aria-current="true"]').count(),1)
  assert.equal(await page.locator('#about tbody tr[aria-current="true"]').getByRole('rowheader').textContent(),product+'当前版本')
  assert.equal(await page.locator('#about tbody button').count(),0,'版本说明不虚构购买入口')
  assert.equal(await page.locator('#about [class*="contactIdentity"]').count(),0)
  assert.equal(await page.locator('#about [class*="connectionActions"]').count(),0)
  assert.deepEqual(await page.locator('#about [class*="contactLinks"] a').evaluateAll((links:any[])=>links.map(link=>link.getAttribute('href'))),['https://teloa.ai'])
  assert.deepEqual(await page.locator('#about [class*="contactEmails"] a').evaluateAll((links:any[])=>links.map(link=>link.getAttribute('href'))),['mailto:support@teloa.ai','mailto:hi@teloa.ai'])
  assert.doesNotMatch(await page.locator('#about').innerText(),/Max Luo|Morgan Chen|Caleb Pan|neteyes|白帽子|GitHub|联系作者|关注公众号|打赏作者/)
  await page.getByRole('button',{name:'提交反馈',exact:true}).click();await page.getByRole('dialog').waitFor()
 }
 checksPassed=true
})
