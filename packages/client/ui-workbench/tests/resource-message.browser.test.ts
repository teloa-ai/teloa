import test from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用既有无头本机浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('资料管理→真实history适配→固定原消息抽屉→原会话端口，错误重试与原对象连接守卫',async t=>{
 const built=await build({configFile:false,root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:fileURLToPath(new URL('./fixtures/resource-message.tsx',import.meta.url)),name:'ResourceMessageTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')+'</style><div id="root"></div><script>'+bundle.output.filter(row=>row.type==='chunk').map(row=>row.code).join('\n').replace(/<\/script/gi,'<\\/script')+'</script></html>'
 const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end(html)});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const address=server.address();assert.ok(address&&typeof address==='object');const url='http://127.0.0.1:'+address.port
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1440,height:960}});page.setDefaultTimeout(8000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(url)?route.continue():route.abort())
 await page.goto(url);const citation=page.getByRole('button',{name:'原引用会话',exact:true});await citation.waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,text:await page.locator('body').innerText()}));throw error});await citation.click()
 const drawer=page.getByRole('dialog',{name:'原消息',exact:true});await drawer.getByText('这是第1条原消息',{exact:false}).waitFor().catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,text:await page.locator('body').innerText(),calls:await page.evaluate(()=>(window as any).resourceMessageFixture.calls)}));throw error});assert.match(await drawer.innerText(),/历史资料1 · v1/);assert.doesNotMatch(await drawer.innerText(),/当前资料正文|\[\[teloa-resource:/)
 assert.deepEqual(await page.evaluate(()=>(window as any).resourceMessageFixture.opened),[],'查看原消息本身不选会话或执行')
 await page.screenshot({path:process.env.TELOA_RESOURCE_MESSAGE_SCREENSHOT??'/tmp/teloa-resource-original-message.png'})
 await drawer.getByRole('button',{name:'打开原会话',exact:true}).click();await drawer.waitFor({state:'detached'});assert.deepEqual(await page.evaluate(()=>(window as any).resourceMessageFixture.opened),['original-session'])
 await page.evaluate(()=>{(window as any).resourceMessageFixture.mode='fail-history'});await citation.click();await drawer.getByRole('alert').waitFor();assert.equal(await drawer.getByRole('button',{name:'打开原会话',exact:true}).count(),0)
 await page.evaluate(()=>{(window as any).resourceMessageFixture.mode='ready'});await drawer.getByRole('button',{name:'重试',exact:true}).click();await drawer.getByText('这是第1条原消息',{exact:false}).waitFor();await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 // 同一会话改目标消息：较早的分页回包不得覆盖新目标，已取得的retain仍须释放。
 await page.evaluate(()=>{(window as any).resourceMessageFixture.mode='delay'});await citation.click();await page.waitForFunction(()=>(window as any).resourceMessageFixture.pending.length===1)
 await page.evaluate(()=>{const f=(window as any).resourceMessageFixture;f.mode='ready';f.retarget()});await drawer.getByText('这是第2条原消息',{exact:false}).waitFor();await page.evaluate(()=>(window as any).resourceMessageFixture.pending.shift()());assert.doesNotMatch(await drawer.innerText(),/这是第1条原消息/);await drawer.getByRole('button',{name:'关闭',exact:true}).click()
 // 同会话切资料与切连接分别使旧读取失效。
 for(const change of ['select','connection']){
  await page.evaluate(()=>{(window as any).resourceMessageFixture.mode='delay'});await citation.click();await page.waitForFunction(()=>(window as any).resourceMessageFixture.pending.length===1)
  await page.evaluate((kind:string)=>{const f=(window as any).resourceMessageFixture;f.mode='ready';kind==='select'?f.select(1):f.connection()},change);await drawer.waitFor({state:'detached'});await page.evaluate(()=>(window as any).resourceMessageFixture.pending.shift()())
  assert.equal(await drawer.count(),0);assert.equal(await page.getByText('这是第1条原消息',{exact:false}).count(),0)
  if(change==='connection')await page.evaluate(()=>(window as any).resourceMessageFixture.select(1))
  await citation.waitFor()
 }
 await page.getByRole('button',{name:'原引用群',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).resourceMessageFixture.groups),[['33333333-3333-4333-a333-333333333333','','44444444-4444-4444-a444-444444444444']])
 assert.equal(await page.evaluate(()=>(window as any).resourceMessageFixture.writes),0);assert.equal(await page.evaluate(()=>(window as any).resourceMessageFixture.released),(await page.evaluate(()=>(window as any).resourceMessageFixture.calls)).filter((row:any[])=>row[0]==='retain').length);assert.deepEqual(errors,[])
})
