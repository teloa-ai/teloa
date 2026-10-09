import assert from 'node:assert/strict'
import test from 'node:test'
import {writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('统一能力中心桌面：发现分类、搜索保留、我的按需详情与真实管理回调',async t=>{
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('本浏览器验收不允许执行宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/capability-center.tsx',import.meta.url)),name:'CapabilityCenterTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code
 const style=bundle.output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>String((item as any).source)).join('\n')
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>能力中心开发预览</title><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1050}})
 page.setDefaultTimeout(7000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>{errors.push(error.message);console.error(error.stack)})
 const requests:string[]=[];await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent(html)
 const nav=page.getByRole('navigation',{name:'主导航',exact:true})
 await page.getByRole('heading',{name:'能力中心',exact:true}).waitFor()
 assert.equal(await nav.getByRole('button',{name:'市场',exact:true}).count(),0)
 assert.equal(await nav.getByRole('button',{name:'能力中心',exact:true}).count(),1)
 await page.locator('[data-catalog-row="teloa.github"]').waitFor()
 assert.equal(await page.locator('[data-catalog-row="codex.research"]').count(),1)
 await page.getByRole('navigation',{name:'市场分类',exact:true}).getByRole('button',{name:'技能',exact:true}).click()
 assert.equal(await page.locator('[data-catalog-row="teloa.github"]').count(),0)
 const search=page.getByRole('textbox',{name:'全局搜索市场',exact:true})
 await search.fill('研究')
 await page.getByRole('button',{name:'我的',exact:true}).click()
 assert.equal(await page.getByRole('complementary',{name:'能力详情',exact:true}).count(),0)
 const mineSearch=page.getByRole('textbox',{name:'搜索我的能力',exact:true})
 await mineSearch.fill('没有这个技能')
 await page.getByText('没有找到匹配的能力',{exact:true}).waitFor()
 await page.getByRole('button',{name:'清空搜索',exact:true}).click()
 await page.getByRole('option').first().click()
 await page.getByRole('complementary',{name:'能力详情',exact:true}).waitFor()
 await page.getByRole('button',{name:'关闭详情',exact:true}).click()
 assert.equal(await page.getByRole('complementary',{name:'能力详情',exact:true}).count(),0)
 await page.getByRole('button',{name:'发现',exact:true}).click()
 assert.equal(await search.inputValue(),'研究')
 await page.getByRole('button',{name:'管理安装',exact:true}).click()
 assert.equal(await page.getByRole('button',{name:'我的',exact:true}).getAttribute('aria-pressed'),'true')
 assert.ok(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.includes('installations')))
 await page.getByRole('button',{name:'连接与运行环境',exact:true}).click()
 assert.ok(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.includes('settings')))
 await page.getByRole('button',{name:'发现',exact:true}).click()
 await search.fill('')
 await page.getByRole('navigation',{name:'市场分类',exact:true}).getByRole('button',{name:'全部',exact:true}).click()
 await page.getByRole('button',{name:'我的',exact:true}).click()
 await page.getByRole('button',{name:'连接器',exact:true}).click()
 assert.equal(await page.getByRole('option').count(),1,'同一 GitHub 下的多个 MCP 工具只显示一个连接器')
 await page.getByText('已发现 2 项工具',{exact:true}).waitFor()
 await page.getByRole('button',{name:'技能',exact:true}).click()
 await page.getByRole('button',{name:'发现',exact:true}).click()
 assert.equal(await page.evaluate(()=>Array.from(document.images).every(image=>image.complete&&image.naturalWidth>0)),true)
 if(process.env.TELOA_CENTER_EVIDENCE){
  const target=process.env.TELOA_CENTER_EVIDENCE;await mkdir(target,{recursive:true})
  await writeFile(target+'/能力中心开发预览.html',html)
  await page.getByRole('heading',{name:'能力中心',exact:true}).click()
  await page.screenshot({path:target+'/能力中心-发现-开发.png',fullPage:true})
  await page.getByRole('button',{name:'我的',exact:true}).click()
  await page.screenshot({path:target+'/能力中心-我的-开发.png',fullPage:true})
  await page.getByRole('button',{name:'切换主题',exact:true}).click()
  await page.screenshot({path:target+'/能力中心-深色-开发.png',fullPage:true})
 }
 await page.setViewportSize({width:1100,height:900})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
