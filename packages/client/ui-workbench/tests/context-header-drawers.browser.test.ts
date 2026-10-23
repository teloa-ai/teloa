import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('真实身份与引用记录抽屉恢复焦点和草稿；窄桌面概览并栏或收起不覆盖输入',async t=>{
 const built=await build({configFile:false,root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId:(id:string)=>id==='node:crypto'?'\0forbid-host-crypto':undefined,load:(id:string)=>id==='\0forbid-host-crypto'?"function blocked(){throw Error('浏览器客户端不得执行宿主摘要或验签')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}":undefined}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/context-header-drawers.tsx',import.meta.url)),name:'ContextHeaderTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1200,height:900}});page.setDefaultTimeout(3000);t.after(()=>page.close())
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const identity=page.getByRole('button',{name:'会话身份',exact:true}),history=page.getByRole('button',{name:'资料引用记录',exact:true}),draft=page.getByRole('textbox',{name:'未提交草稿'})
 await draft.fill('原会话草稿始终保留')
 assert.equal(await history.textContent(),'');assert.equal(await history.getAttribute('title'),'资料引用记录');assert.equal(Math.round((await history.boundingBox())!.width),32)
 await identity.click();const identityDrawer=page.getByRole('dialog',{name:'会话身份',exact:true});await identityDrawer.waitFor()
 assert.equal(await identityDrawer.getByRole('button',{name:/重新.*介绍|重新.*介紹|introduce.*again/i}).count(),0,'员工身份只展示岗位信息，不提供重新介绍动作')
 const box=await identityDrawer.boundingBox();assert.ok(box);assert.equal(Math.round(box.x+box.width),1200);assert.equal(Math.round(box.height),900)
 await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0);assert.equal(await identity.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).contextHeaderTest.calls),[],'关闭身份详情不发送重新介绍')
 await history.click();const historyDrawer=page.getByRole('dialog',{name:'资料引用记录',exact:true});await historyDrawer.getByText('验收引用 40',{exact:true}).waitFor()
 await historyDrawer.getByRole('button',{name:'更早的引用记录',exact:true}).click();await historyDrawer.getByText('验收引用 1',{exact:true}).waitFor()
 const scroller=historyDrawer.locator(':scope > div');await scroller.evaluate((node:HTMLElement)=>{node.scrollTop=900})
 const scrollTop=await scroller.evaluate((node:HTMLElement)=>node.scrollTop);assert.ok(scrollTop>0)
 await page.keyboard.press('Escape');assert.equal(await history.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 await history.click();await historyDrawer.getByText('验收引用 1',{exact:true}).waitFor();assert.equal(await scroller.evaluate((node:HTMLElement)=>node.scrollTop),scrollTop)
 assert.deepEqual(await page.evaluate(()=>(window as any).contextHeaderTest.calls),['history:undefined','history:20'],'重新打开保留分页，不重复读取或写业务动作')
 await historyDrawer.getByRole('button',{name:'关闭',exact:true}).click();assert.equal(await history.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await draft.inputValue(),'原会话草稿始终保留')
 for(const width of [1200,1024,900,1100]){
  await page.setViewportSize({width,height:900})
  await page.waitForFunction(()=>{const node=document.querySelector('[data-testid="overview"]')!;return innerWidth===1200?node.getBoundingClientRect().width===324:innerWidth===1024?node.getBoundingClientRect().width===360:node.getBoundingClientRect().width===0})
  const metrics=await page.evaluate(()=>{const main=document.querySelector('[data-testid="main"]')!.getBoundingClientRect(),overview=document.querySelector('[data-testid="overview"]')!.getBoundingClientRect(),input=document.querySelector('textarea')!,box=input.getBoundingClientRect();return {mainWidth:main.width,mainRight:main.right,overviewLeft:overview.left,overviewWidth:overview.width,inputClickable:document.elementFromPoint(box.left+box.width/2,box.top+box.height/2)===input,overflow:document.documentElement.scrollWidth>innerWidth}})
  assert.ok(metrics.mainWidth>=360);assert.ok(metrics.mainRight<=metrics.overviewLeft+1);assert.equal(metrics.inputClickable,true);assert.equal(metrics.overflow,false)
  assert.equal(await page.getByRole('button',{name:'工作概览',exact:true}).isVisible(),true)
 }
 await page.getByRole('button',{name:'切换目录',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-testid="overview"]')!.getBoundingClientRect().width>0)
 assert.equal(await draft.inputValue(),'原会话草稿始终保留');assert.equal(await page.locator('dialog[open]').count(),0)
 await identity.click();await identityDrawer.waitFor()
 await page.evaluate(()=>(window as any).contextHeaderTest.primaryEntry());await identity.waitFor({state:'detached'});assert.equal(await page.locator('dialog[open]').count(),0)
 await page.evaluate(()=>(window as any).contextHeaderTest.clearPrimary());await identity.waitFor();assert.equal(await page.locator('dialog[open]').count(),0);await identity.click()
 await identityDrawer.getByText('独立侧栏员工',{exact:false}).waitFor();assert.equal(await identityDrawer.getByRole('button',{name:'让它重新自我介绍',exact:true}).count(),0)
 await page.keyboard.press('Escape');assert.equal(await identity.evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).contextHeaderTest.calls),['history:undefined','history:20'],'桥接收起及独立侧栏回退都不会自动发送介绍')
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
