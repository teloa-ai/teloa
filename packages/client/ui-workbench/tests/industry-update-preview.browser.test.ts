import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用仓库现有隔离浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('行业更新真实React：摘要基线读取、重试、身份固定与候选迟到隔离',async t=>{
 const report=process.env.TELOA_ACCEPTANCE_REPORT_DIR??await mkdtemp(join(tmpdir(),'teloa-update-preview-')),root=fileURLToPath(new URL('../../../../',import.meta.url))
 const built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器不允许调用宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/industry-update-preview.tsx',import.meta.url)),name:'IndustryUpdatePreviewFixture',formats:['iife']}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,style=bundle.output.filter((row:any)=>row.type==='asset'&&row.fileName.endsWith('.css')).map((row:any)=>String(row.source)).join('\n'),html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>',url='http://127.0.0.1:3199/industry-update-preview-fixture'
 await mkdir(report,{recursive:true});await writeFile(report+'/runtime-update-preview-fixture.html',html)
 const cases:Array<Record<string,unknown>>=[],browser=await loadPlaywright().chromium.launch(launchOptions())
 t.after(async()=>{await browser.close();await writeFile(report+'/runtime-update-preview-browser-evidence.json',JSON.stringify({cases},null,2))})
 const setup=async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:1000}}),page=await context.newPage(),errors:string[]=[],blocked:string[]=[]
  page.setDefaultTimeout(12000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>{if(route.request().url()===url)return route.fulfill({contentType:'text/html',body:html});blocked.push(route.request().url());return route.abort()})
  await page.goto(url);await page.getByLabel('更新目标业务空间',{exact:true}).waitFor()
  return {context,page,errors,blocked}
 }
 const selectLoad=async(page:any)=>{const loadId=await page.evaluate(()=>(window as any).updatePreviewFixture.loadId);await page.getByLabel('更新目标业务空间',{exact:true}).selectOption(loadId);await page.waitForFunction(()=>(window as any).updatePreviewFixture.requests.length>=2)}
 const trace=async(page:any)=>page.evaluate(()=>(window as any).updatePreviewFixture.requests.map((row:any)=>({contentId:row.contentId,hash:row.hash,settled:row.settled})))
 const diff=async(page:any,body='候选手册一')=>{await page.getByText(/内容校验值不同，请逐项复核。/).waitFor();await page.getByText('比较知识正文：手册',{exact:true}).click();await page.locator('pre').filter({hasText:body}).waitFor()}
 await t.test('两边仅summary仍可选已加载位置，按固定身份读取后比较正文并提交准确预览',async()=>{
  const {context,page,errors,blocked}=await setup();try{
   assert.equal((await trace(page)).length,0,'选择加载位置前不读取历史正文')
   await selectLoad(page);await page.getByRole('status').filter({hasText:'正在读取这个模板带来的内容…'}).waitFor();assert.equal(await page.getByRole('button',{name:'确认应用更新',exact:true}).count(),0)
   const requested=await trace(page),ids=await page.evaluate(()=>(window as any).updatePreviewFixture.ids);assert.deepEqual(requested.map((row:any)=>row.contentId).sort(),[ids.baseline,ids.candidate].sort());for(const row of requested)assert.equal(row.hash,await page.evaluate((id:string)=>(window as any).updatePreviewFixture.hash(id),row.contentId))
   await page.evaluate(()=>(window as any).updatePreviewFixture.resolvePending());await diff(page);await page.locator('pre').filter({hasText:'旧版固定规则。'}).waitFor()
   await page.getByRole('checkbox').check();await page.getByRole('button',{name:'确认应用更新',exact:true}).click();await page.waitForFunction(()=>(window as any).updatePreviewFixture.upgrades.length===1)
   const result=await page.evaluate(()=>(window as any).updatePreviewFixture.upgrades[0]);assert.equal(result.loadId,await page.evaluate(()=>(window as any).updatePreviewFixture.loadId));assert.equal(result.candidateContentId,ids.candidate);assert.equal(result.expectedMappingHash,'a'.repeat(64));assert.equal(result.choices.resources.guide,'candidate');assert.deepEqual(result.choices.roles,{})
   assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);cases.push({name:'summary-load-diff-submit',requested,result,errors,blocked})
  }finally{await context.close()}
 })
 await t.test('读取失败保留位置与候选，重试成功后才开放差异和提交',async()=>{
  const {context,page,errors,blocked}=await setup();try{
   await selectLoad(page);await page.evaluate(()=>(window as any).updatePreviewFixture.release(0,'error'));await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'确认应用更新',exact:true}).count(),0)
   const before=(await trace(page)).length;await page.getByRole('button',{name:'重试',exact:true}).click();await page.waitForFunction((count:number)=>(window as any).updatePreviewFixture.requests.length>count,before);await page.evaluate(()=>(window as any).updatePreviewFixture.resolvePending());await diff(page)
   assert.equal(await page.getByRole('alert').count(),0);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);cases.push({name:'read-retry',requested:await trace(page),errors,blocked})
  }finally{await context.close()}
 })
 for(const outcome of ['wrong-id','wrong-hash'])await t.test('完整回包'+outcome+'与固定基线不符时拒绝差异和提交',async()=>{
  const {context,page,errors,blocked}=await setup();try{
   await selectLoad(page);await page.evaluate((outcome:string)=>{const fixture=(window as any).updatePreviewFixture,index=fixture.requests.findIndex((row:any)=>row.contentId===fixture.ids.baseline);fixture.release(index,outcome);fixture.resolvePending()},outcome)
   await page.getByRole('alert').waitFor();assert.equal(await page.getByText('比较知识正文：手册',{exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'确认应用更新',exact:true}).count(),0);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);cases.push({name:'reject-'+outcome,requested:await trace(page),errors,blocked})
  }finally{await context.close()}
 })
 await t.test('候选切换后先显示新候选，旧读取迟到不覆盖正文或提交身份',async()=>{
  const {context,page,errors,blocked}=await setup();try{
   await selectLoad(page);const ids=await page.evaluate(()=>(window as any).updatePreviewFixture.ids),before=(await trace(page)).length
   await page.getByLabel('候选模板版本',{exact:true}).selectOption('fixed-'+ids.next);await page.waitForFunction((id:string)=>(window as any).updatePreviewFixture.requests.some((row:any)=>row.contentId===id),ids.next)
   await page.evaluate(()=>{const fixture=(window as any).updatePreviewFixture;fixture.requests.forEach((row:any,index:number)=>{if(row.contentId!==fixture.ids.candidate)fixture.release(index)})});await diff(page,'候选手册二')
   await page.evaluate(()=>(window as any).updatePreviewFixture.resolvePending());await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
   assert.equal(await page.locator('pre').filter({hasText:'第一份候选规则。'}).count(),0);await page.locator('pre').filter({hasText:'切换后应显示这份规则。'}).waitFor();await page.getByRole('checkbox').check();await page.getByRole('button',{name:'确认应用更新',exact:true}).click();await page.waitForFunction(()=>(window as any).updatePreviewFixture.upgrades.length===1)
   const result=await page.evaluate(()=>(window as any).updatePreviewFixture.upgrades[0]);assert.equal(result.candidateContentId,ids.next);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);cases.push({name:'late-candidate-isolation',before,requested:await trace(page),result,errors,blocked})
  }finally{await context.close()}
 })
})
