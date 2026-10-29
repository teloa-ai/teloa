import assert from 'node:assert/strict'
import test from 'node:test'
import {createHash} from 'node:crypto'
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
import {readIndustryArchive} from '../src/client/industry-archive.ts'
import {inspectIndustryContent} from '../src/client/industry-content.ts'
import {isIndustryManifest} from '../src/client/industry-manifest.ts'
// @ts-expect-error 仓库现有独立浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('完整业务导出真实React：实际打包下载、预览失效与迟到结果隔离',async t=>{
 const report=process.env.TELOA_ACCEPTANCE_REPORT_DIR??await mkdtemp(join(tmpdir(),'teloa-complete-export-'))
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),built=await build({configFile:false,root,logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器不允许调用宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/complete-business-export.tsx',import.meta.url)),name:'CompleteBusinessExportFixture',formats:['iife']}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,style=bundle.output.filter((row:any)=>row.type==='asset'&&row.fileName.endsWith('.css')).map((row:any)=>String(row.source)).join('\n'),html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 await mkdir(report,{recursive:true});await writeFile(report+'/complete-export-fixture.html',html)
 const evidence:{cases:Array<Record<string,unknown>>;geometry:Array<Record<string,unknown>>}={cases:[],geometry:[]},browser=await loadPlaywright().chromium.launch(launchOptions())
 t.after(async()=>{await browser.close();await writeFile(report+'/complete-export-react-evidence.json',JSON.stringify(evidence,null,2))})
 const setup=async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:900},acceptDownloads:true}),page=await context.newPage(),errors:string[]=[],downloads:any[]=[]
  page.setDefaultTimeout(12000);page.on('pageerror',(cause:Error)=>errors.push(cause.message));page.on('download',(download:any)=>downloads.push(download))
  await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1:3199/complete-export-test'?route.fulfill({contentType:'text/html',body:html}):route.abort())
  await page.goto('http://127.0.0.1:3199/complete-export-test');await page.getByRole('button',{name:'生成预览',exact:true}).waitFor()
  return {context,page,errors,downloads}
 }
 const preview=async(page:any)=>{await page.getByRole('button',{name:'生成预览',exact:true}).click();await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).waitFor()}
 const frame=async(page:any)=>page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
 await t.test('页面预览后下载实际ZIP，完整正文/二进制资产通过重新导入；修改元数据清空旧预览',async()=>{
  const {context,page,errors}=await setup();try{
   await page.getByLabel('包标识',{exact:true}).fill('complete-browser-soc');await page.getByLabel('名称',{exact:true}).fill('SOC 完整业务浏览器验收');await page.getByRole('textbox',{name:'说明',exact:true}).fill('完整业务导出字节验收。');await preview(page)
   await page.screenshot({path:report+'/complete-export-preview.png'})
   const event=page.waitForEvent('download');await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).click();const download=await event;await download.saveAs(report+'/complete-browser-soc.zip');const bytes=new Uint8Array(await readFile(report+'/complete-browser-soc.zip')),receipt=await page.evaluate(()=>(window as any).completeExportFixture.archives.at(-1))
   assert.equal(download.suggestedFilename(),'complete-browser-soc-1.0.0.zip');assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.sha256);assert.equal(bytes.length,receipt.bytes)
   const restored=await readIndustryArchive(bytes,download.suggestedFilename());assert.equal(restored.length,1);const item=restored[0]!.item!;assert.ok(isIndustryManifest(item.manifest));assert.equal(item.manifest.scope,'SOC');assert.equal(item.title,'SOC 完整业务浏览器验收')
   const rows=inspectIndustryContent(item.manifest,item.packageContent!);assert.ok(rows.some(row=>row.definition?.kind==='role'&&row.definition.fields.name==='当前员工 SOC API 0'));assert.ok(rows.some(row=>row.definition?.kind==='knowledge'&&row.definition.text.includes('员工当前手册 SOC API 0')));assert.ok(rows.some(row=>row.definition?.kind==='knowledge'&&row.definition.text.includes('业务通用资料 SOC API 0')));assert.deepEqual(item.packageContent!.files.find(row=>row.path.endsWith('assets/figure.png'))!.bytes,new Uint8Array([137,80,78,71,13,10,26,10,255,0]))
   await page.getByText('ZIP 已开始下载。',{exact:true}).waitFor();await page.getByRole('textbox',{name:'说明',exact:true}).fill('修改后的完整业务导出说明。');assert.equal(await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).count(),0);assert.equal(await page.getByText('ZIP 已开始下载。',{exact:true}).count(),0)
   const before=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='plan'&&row.kind==='finish').at(-1).digest);await preview(page);const after=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='plan'&&row.kind==='finish').at(-1).digest);assert.notEqual(after,before);assert.deepEqual(errors,[])
   evidence.cases.push({name:'download-roundtrip-metadata',receipt,resourceKinds:item.manifest.resources.map(row=>row.kind),files:item.packageContent!.files.length,errors})
  }finally{await context.close()}
 })
 for(const existingPreview of [false,true])await t.test('生成前重新读取来源遇到pending时不打包且无下载入口'+(existingPreview?'，作废已生成的旧预览':'，不使用打开页面时的来源缓存'),async()=>{
  const {context,page,errors,downloads}=await setup();try{
   if(existingPreview)await preview(page)
   const plansBefore=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='plan'&&row.kind==='start').length),sourcesBefore=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='source'&&row.kind==='start').length)
   await page.evaluate(()=>(window as any).completeExportFixture.holdNext('source'));await page.getByRole('button',{name:'生成预览',exact:true}).click();await page.waitForFunction(()=>(window as any).completeExportFixture.held().includes('source'))
   await page.evaluate(()=>(window as any).completeExportFixture.release('source','pending'));await page.getByRole('alert').waitFor();await page.waitForFunction(()=>document.querySelector<HTMLButtonElement>('footer button')?.disabled===false)
   const plansAfter=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='plan'&&row.kind==='start').length),sourcesAfter=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='source'&&row.kind==='start').length)
   assert.equal(plansAfter,plansBefore);assert.equal(sourcesAfter,sourcesBefore+1);assert.equal(await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).count(),0);assert.equal(downloads.length,0);assert.deepEqual(errors,[])
   evidence.cases.push({name:'fresh-source-pending-'+existingPreview,plansBefore,plansAfter,sourcesBefore,sourcesAfter,downloads:downloads.length,errors})
  }finally{await context.close()}
 })
 for(const stage of ['source','plan','download'] as const)for(const axis of ['scope','api'] as const)await t.test(stage+'迟到'+(axis==='api'?'拒绝':'成功')+'在切换'+axis+'后不覆盖新页或下载旧包',async()=>{
  const {context,page,errors,downloads}=await setup();try{
   if(stage==='download')await preview(page)
   await page.evaluate((value:string)=>(window as any).completeExportFixture.holdNext(value),stage)
   if(stage==='source')await page.getByRole('button',{name:'刷新',exact:true}).click();else if(stage==='plan')await page.getByRole('button',{name:'生成预览',exact:true}).click();else await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).click()
   await page.waitForFunction((value:string)=>(window as any).completeExportFixture.held().includes(value),stage)
   await page.evaluate((value:string)=>value==='scope'?(window as any).completeExportFixture.setScope('AppSec'):(window as any).completeExportFixture.setApi(1),axis)
   await page.getByRole('button',{name:'生成预览',exact:true}).waitFor();await page.waitForFunction(()=>document.querySelector<HTMLButtonElement>('footer button')?.disabled===false)
   await page.evaluate(({stage,reject}:{stage:string;reject:boolean})=>(window as any).completeExportFixture.release(stage,reject),{stage,reject:axis==='api'});await frame(page)
   assert.equal(await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).count(),0);assert.equal(downloads.length,0);assert.equal(await page.getByRole('alert').count(),0)
   await preview(page);const result=await page.evaluate(()=>(window as any).completeExportFixture.trace.filter((row:any)=>row.stage==='plan'&&row.kind==='finish').at(-1));assert.equal(result.scope,axis==='scope'?'AppSec':'SOC');assert.equal(result.api,axis==='api'?1:0);assert.deepEqual(errors,[])
   evidence.cases.push({name:stage+'-'+axis,downloads:downloads.length,lastPlan:result,errors})
  }finally{await context.close()}
 })
 await t.test('390窄窗、720p、1080p、2K和4K集中几何验收',async()=>{
  const {context,page,errors}=await setup();try{
   await preview(page)
   for(const [width,height] of [[390,844],[1280,720],[1920,1080],[2560,1440],[3840,2160]] as const){
    await page.setViewportSize({width,height});await frame(page);await page.screenshot({path:report+`/complete-export-${width}x${height}.png`})
    const geometry=await page.evaluate(()=>({width:window.innerWidth,height:window.innerHeight,scrollWidth:document.documentElement.scrollWidth,controls:Array.from(document.querySelectorAll('input,textarea,button')).map(node=>{const box=node.getBoundingClientRect();return {tag:node.tagName,left:box.left,right:box.right,width:box.width,height:box.height}})}));assert.ok(geometry.scrollWidth<=width,`${width}x${height}横向溢出`);assert.ok(geometry.controls.every((row:any)=>row.width>0&&row.left>=-1&&row.right<=width+1),`${width}x${height}控件越界`);assert.equal(await page.getByRole('button',{name:'下载完整 ZIP',exact:true}).isVisible(),true);evidence.geometry.push(geometry)
   }
   assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
})
