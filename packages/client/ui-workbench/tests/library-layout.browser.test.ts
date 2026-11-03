import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 复用现有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('资料页在 2K、缩放桌面及窄屏下对齐，添加菜单与完整顶部操作均可达',async t=>{
 const report=await mkdtemp(join(tmpdir(),'teloa-library-layout-'))
 const output=await build({configFile:false,root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('布局验收不调用宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/library.tsx',import.meta.url)),name:'LibraryLayoutTest',formats:['iife']}}})
 const bundle=Array.isArray(output)?output[0]:output;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,style=bundle.output.filter((row:any)=>row.type==='asset'&&row.fileName.endsWith('.css')).map((row:any)=>String(row.source)).join('\n')
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions()),evidence:Array<Record<string,unknown>>=[]
 t.after(async()=>{await browser.close();await writeFile(join(report,'evidence.json'),JSON.stringify(evidence,null,2)+'\n');console.log('资料页布局截图与核验记录：'+report)})
 const cases=[{width:2560,height:1440,dark:false},{width:2048,height:1152,dark:false},{width:1440,height:900,dark:false},{width:768,height:1024,dark:false},{width:390,height:844,dark:false},{width:2560,height:1440,dark:true}]
 for(const size of cases)await t.test(`${size.width}×${size.height} ${size.dark?'深色':'浅色'}`,async()=>{
  const context=await browser.newContext({viewport:{width:size.width,height:size.height}}),page=await context.newPage(),errors:string[]=[]
  page.setDefaultTimeout(8000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  const rect=async(locator:any)=>{const value=await locator.boundingBox();assert.ok(value);return value as {x:number;y:number;width:number;height:number}}
  const reachable=async(locator:any)=>{const state=await locator.evaluate((node:HTMLElement)=>{const r=node.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return {reachable:node.contains(hit),label:node.innerText,rect:r.toJSON(),hit:hit?.outerHTML.slice(0,160),scrollY}});assert.equal(state.reachable,true,'控件不能被裁切或覆盖：'+JSON.stringify(state))}
  try{
   await page.route('**/*',(route:any)=>new URL(route.request().url()).origin==='http://127.0.0.1:3199'?route.fulfill({contentType:'text/html',body:html}):route.abort())
   await page.goto('http://127.0.0.1:3199/library-test?layout-stress&root-page')
   if(size.dark)await page.getByRole('button',{name:'切换主题',exact:true}).click()
   const directory=page.locator('[data-teloa-pane="directory"]'),content=page.locator('section[data-teloa-pane="detail"]')
   const search=directory.locator('..').getByRole('searchbox'),add=directory.locator('..').getByRole('button',{name:'添加资料',exact:true})
   await directory.getByRole('navigation',{name:'资料文件树',exact:true}).getByRole('button',{name:'个人空间',exact:true}).waitFor()
   const searchBounds=await rect(search.locator('..')),addBounds=await rect(add)
   assert.equal(addBounds.height,searchBounds.height,'搜索框与添加按钮等高');assert.equal(addBounds.width,addBounds.height,'添加按钮为方形');assert.equal(addBounds.y,searchBounds.y)
   await add.click()
   const menu=add.locator('..').locator(':scope>div'),menuBounds=await rect(menu),directoryBounds=await rect(directory.locator('..'))
   assert.ok(menuBounds.x>=directoryBounds.x&&menuBounds.x+menuBounds.width<=directoryBounds.x+directoryBounds.width,'添加菜单完整留在目录列内')
   for(const option of await menu.getByRole('button').all())await reachable(option)
   await page.screenshot({path:join(report,`${size.width}-${size.dark?'dark':'light'}-add.png`)})
   await page.keyboard.press('Escape');assert.equal(await menu.isVisible(),false)
   const title='面向跨业务协作的知识编辑验收手册与资料版本使用规范（第二版）'
   await directory.getByRole('button',{name:title,exact:true}).click()
   const heading=content.getByRole('heading',{name:title,exact:true}),document=heading.locator('xpath=../../..')
   await heading.waitFor();await content.getByText('帮助用户更简单地完成工作。',{exact:true}).waitFor()
   const documentBounds=await rect(document),toolbar=document.locator(':scope>header'),toolbarBounds=await rect(toolbar)
   assert.ok(Math.abs(toolbarBounds.x-documentBounds.x)<1&&Math.abs(toolbarBounds.width-documentBounds.width)<1,'顶部操作与正文共用宽度和左边线')
   await toolbar.getByRole('button',{name:'返回列表',exact:true}).waitFor()
   for(const label of ['下载','修改','文件信息'])await toolbar.getByRole('button',{name:label,exact:true}).waitFor()
   const buttons=await toolbar.getByRole('button').all()
   const buttonBounds=[]
   for(const button of buttons){const bounds=await rect(button);buttonBounds.push(bounds);assert.ok(bounds.x>=documentBounds.x-1&&bounds.x+bounds.width<=documentBounds.x+documentBounds.width+1);await reachable(button)}
   await toolbar.getByLabel('更多知识操作',{exact:true}).click()
   const use=toolbar.getByRole('button',{name:'用于任务',exact:true});await reachable(use)
   assert.equal(await use.isEnabled(),true,'折叠的任务入口仍可操作')
   await toolbar.getByLabel('更多知识操作',{exact:true}).click()
   const headerBounds=await rect(document.locator(':scope>header')),titleBounds=await rect(heading)
   assert.ok(titleBounds.x>=headerBounds.x&&titleBounds.x+titleBounds.width<=headerBounds.x+headerBounds.width+1,'长标题不挤出操作区：'+JSON.stringify({headerBounds,titleBounds}))
   assert.equal(await content.evaluate((node:HTMLElement)=>node.scrollWidth<=node.clientWidth),true,'正文区不能产生横向溢出')
   assert.equal(await page.evaluate(()=>window.document.documentElement.scrollWidth<=innerWidth),true,'页面不能产生横向溢出')
   await page.screenshot({path:join(report,`${size.width}-${size.dark?'dark':'light'}-document.png`)})
   assert.deepEqual(errors,[]);evidence.push({viewport:size,searchBounds,addBounds,menuBounds,documentBounds,toolbarBounds,buttonBounds,titleBounds,errors})
  }catch(cause){await page.screenshot({path:join(report,`${size.width}-${size.dark?'dark':'light'}-failure.png`)});throw cause}finally{await context.close()}
 })
})
