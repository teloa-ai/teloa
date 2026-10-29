import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 既有独立浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('知识空间展开后可直接打开真实知识页，不要求先创建资料投影',async t=>{
 const report=process.env.TELOA_ACCEPTANCE_REPORT_DIR??await mkdtemp(join(tmpdir(),'teloa-knowledge-space-'))
 await mkdir(report,{recursive:true})
 const output=await build({configFile:false,root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器不调用宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/library.tsx',import.meta.url)),name:'KnowledgeSpaceTreeTest',formats:['iife']}}})
 const bundle=Array.isArray(output)?output[0]:output;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,style=bundle.output.filter((row:any)=>row.type==='asset'&&row.fileName.endsWith('.css')).map((row:any)=>String(row.source)).join('\n')
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions()),evidence:Array<Record<string,unknown>>=[]
 t.after(async()=>{await browser.close();await writeFile(join(report,'knowledge-space-tree-browser-evidence.json'),JSON.stringify(evidence,null,2)+'\n')})
 const setup=async(query:string)=>{
  const context=await browser.newContext({viewport:{width:1440,height:1050}}),page=await context.newPage(),errors:string[]=[]
  page.setDefaultTimeout(8000);page.on('pageerror',(cause:Error)=>errors.push(cause.message))
  await page.route('**/*',(route:any)=>{const url=new URL(route.request().url());return url.origin==='http://127.0.0.1:3199'&&url.pathname==='/library-test'?route.fulfill({contentType:'text/html',body:html}):route.abort()})
  await page.goto('http://127.0.0.1:3199/library-test?'+query)
  const directory=page.locator('[data-teloa-pane="directory"]'),content=page.locator('main[data-teloa-pane="detail"]')
  await directory.locator('summary[data-teloa-entry="root"]').waitFor()
  return {context,page,directory,content,errors}
 }
 await t.test('仅根节点直属文档时展开可见，点页读取正文并记录访问',async()=>{
  const {context,page,directory,content,errors}=await setup('root-page');try{
   const root=directory.locator('summary[data-teloa-entry="root"]'),document=directory.getByRole('button',{name:'产品定位',exact:true})
   await document.waitFor({state:'visible'});await root.click();assert.equal(await document.isVisible(),false);await root.click();await document.waitFor({state:'visible'})
   await document.click();await content.getByText('帮助用户更简单地完成工作。',{exact:true}).waitFor()
   assert.equal(await document.getAttribute('aria-current'),'page');await page.screenshot({path:join(report,'knowledge-space-root-page.png')})
   await content.getByRole('button',{name:'返回列表',exact:true}).click();await content.getByRole('table').waitFor();assert.equal(await content.getByRole('row').count(),2)
   await page.getByRole('button',{name:'最近访问',exact:true}).click();assert.equal(await content.getByRole('row').count(),2);assert.deepEqual(errors,[])
   evidence.push({case:'root-projected',readVersions:await page.evaluate(()=>(window as any).__libraryReads),errors})
  }finally{await context.close()}
 })
 await t.test('嵌套文件夹保留目录层级，展开页可打开且未保存修改仍受保护',async()=>{
  const {context,page,directory,content,errors}=await setup('');try{
   const folder=directory.locator('summary[data-teloa-entry="folder"]'),document=directory.getByRole('button',{name:'产品定位',exact:true})
   await folder.click();assert.equal(await document.isVisible(),false);await folder.click();await document.click();await content.getByText('帮助用户更简单地完成工作。',{exact:true}).waitFor()
   await content.getByRole('tab',{name:'编辑',exact:true}).click();await content.getByRole('textbox',{name:'Markdown 正文',exact:true}).fill('# 保留未保存草稿')
   await directory.getByRole('button',{name:'设计规范',exact:true}).click();await page.getByText('资料有未保存的修改。离开会丢弃这些修改。',{exact:true}).waitFor();await page.getByRole('button',{name:'继续编辑',exact:true}).click()
   assert.equal(await content.getByRole('textbox',{name:'Markdown 正文',exact:true}).inputValue(),'# 保留未保存草稿');assert.deepEqual(errors,[])
   evidence.push({case:'nested-dirty-guard',errors})
  }finally{await context.close()}
 })
 await t.test('未投影的独立知识页仍可展开并直接阅读全文',async()=>{
  const {context,page,directory,content,errors}=await setup('standalone&root-page');try{
   const document=directory.getByRole('button',{name:'产品定位',exact:true});assert.equal(await document.isEnabled(),true);await document.click();await content.getByText('帮助用户更简单地完成工作。',{exact:true}).waitFor()
   assert.equal(await content.getByRole('button',{name:'用于任务',exact:true}).count(),0);assert.deepEqual(errors,[])
   evidence.push({case:'standalone',readVersions:await page.evaluate(()=>(window as any).__libraryReads),errors})
  }finally{await context.close()}
 })
 await t.test('员工独立副本按当前物理资料预览，不把它冒充原员工逻辑绑定',async()=>{
  const {context,page,directory,content,errors}=await setup('employee-copy&root-page');try{
   await directory.getByRole('button',{name:'产品定位',exact:true}).click();await content.getByText('帮助用户更简单地完成工作。',{exact:true}).waitFor()
   assert.deepEqual(await page.evaluate(()=>(window as any).__libraryEmployeeKnowledgeReads),[]);assert.deepEqual(errors,[])
   evidence.push({case:'employee-copy-preview',readVersions:await page.evaluate(()=>(window as any).__libraryReads),employeeKnowledgeReads:[],errors})
  }finally{await context.close()}
 })
 await t.test('来源暂不可用的已有页面保留入口，并显示明确正文状态',async()=>{
  const {context,directory,content,errors}=await setup('standalone&root-page&missing-source');try{
   const document=directory.getByRole('button',{name:'产品定位',exact:true});assert.equal(await document.isEnabled(),true);await document.click();await content.getByText('正文暂不可读；请核对来源或重新同步。',{exact:true}).waitFor();assert.deepEqual(errors,[])
   evidence.push({case:'unavailable-source',errors})
  }finally{await context.close()}
 })
})
