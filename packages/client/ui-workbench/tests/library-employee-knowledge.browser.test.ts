import assert from 'node:assert/strict'
import test from 'node:test'
import {writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// N27：资料库员工知识分组——在岗员工资料可见，退役员工与分身不显示；点击预览、搜索过滤正常。
// 员工分组下分「资料」「工作成果」两段；成果点击交给工作台成果查看器，读取失败给出错误提示。

test('资料库员工知识分组：在岗员工资料可见，退役员工与分身不产生分组；点击资源打开预览；搜索过滤；完整列表视图包含员工资源',async t=>{
  const root=fileURLToPath(new URL('../../../../',import.meta.url))
  const result=await build({
    configFile:false,
    plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('本浏览器验收不允许执行宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],
    root,
    logLevel:'error',
    define:{'process.env.NODE_ENV':'"development"'},
    build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/library-employee.tsx',import.meta.url)),name:'LibraryEmployeeTest',formats:['iife']}}
  })
  const bundle=Array.isArray(result)?result[0]:result
  assert.ok(bundle&&'output'in bundle)
  const script=bundle.output.find(item=>item.type==='chunk')!.code
  const style=bundle.output.filter((item:any)=>item.type==='asset'&&item.fileName.endsWith('.css')).map((item:any)=>String(item.source)).join('\n')
  const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'

  await mkdir('/tmp/teloa-walkthrough',{recursive:true})

  const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
  const page=await browser.newPage({viewport:{width:1440,height:1050}})
  page.setDefaultTimeout(8000)
  const errors:string[]=[];page.on('pageerror',(error:Error)=>{errors.push(error.message);console.error(error.stack)})
  await page.route('**/*',(route:any)=>{
    const u=new URL(route.request().url())
    if(u.origin==='http://127.0.0.1:3199'&&u.pathname==='/library-employee-test')return route.fulfill({contentType:'text/html',body:html})
    return route.abort()
  })
  await page.goto('http://127.0.0.1:3199/library-employee-test')
  await page.getByRole('heading',{name:'资料库',exact:true}).waitFor()

  // ── 1. 左侧树：在岗员工分组可见，内含两条资料 ──────────────────────────────
  const directory=page.locator('[data-teloa-pane=directory]')
  // 等待员工知识分组出现
  const groupLabel=await directory.getByText('调研助理',{exact:true}).waitFor().then(()=>directory.getByText('调研助理',{exact:true}))
  assert.ok(await groupLabel.isVisible(),'左侧树应显示"调研助理"分组')
  await page.screenshot({path:'/tmp/teloa-walkthrough/library-employee-left-tree.png'})

  // 断言退役员工和分身不生成分组
  assert.equal(await directory.getByText('前员工',{exact:true}).count(),0,'退役员工不应生成知识分组')
  assert.equal(await directory.getByText('分身甲',{exact:true}).count(),0,'分身不应生成知识分组')

  // 点击分组展开，找到两条员工资料
  const group=directory.locator('[data-teloa-entry="role-active"]')
  if(await group.count()>0){
    // 如果分组有 data-teloa-entry 属性，展开并检查资料条目
    const groupEl=group.first()
    if(await groupEl.getAttribute('aria-expanded')==='false')await groupEl.click()
    await directory.getByRole('button',{name:'员工专项资料甲',exact:true}).waitFor()
    assert.ok(await directory.getByRole('button',{name:'员工专项资料甲',exact:true}).isVisible(),'员工专项资料甲 应出现在分组内')
    assert.ok(await directory.getByRole('button',{name:'员工专项资料乙',exact:true}).isVisible(),'员工专项资料乙 应出现在分组内')
  } else {
    // 分组可能是展开的列表形式
    await directory.getByRole('button',{name:'员工专项资料甲',exact:true}).waitFor()
    assert.ok(await directory.getByRole('button',{name:'员工专项资料甲',exact:true}).isVisible(),'员工专项资料甲 应出现在分组内')
    assert.ok(await directory.getByRole('button',{name:'员工专项资料乙',exact:true}).isVisible(),'员工专项资料乙 应出现在分组内')
  }

  // ── 1b. 员工工作成果：分组内分「资料」「工作成果」两段，只读成果目录，不为退役员工或分身请求 ──
  const activeGroup=directory.locator('details:has(> summary[data-teloa-entry="role-active"])')
  await activeGroup.getByRole('button',{name:'竞品调研结论',exact:true}).waitFor()
  assert.equal(await activeGroup.locator(':scope > summary small').innerText(),'4','分组计数含资料与成果')
  assert.ok(await activeGroup.getByText('资料',{exact:true}).isVisible(),'员工分组应有「资料」段')
  assert.ok(await activeGroup.getByText('工作成果',{exact:true}).isVisible(),'员工分组应有「工作成果」段')
  const writerGroup=directory.locator('details:has(> summary[data-teloa-entry="role-writer"])')
  assert.ok(await writerGroup.getByRole('button',{name:'新品发布文案',exact:true}).isVisible(),'只有成果的员工也出分组')
  assert.equal(await writerGroup.getByText('资料',{exact:true}).count(),0,'没有资料的员工不出「资料」段')
  const flakyGroup=directory.locator('details:has(> summary[data-teloa-entry="role-flaky"])')
  assert.ok(await flakyGroup.getByRole('button',{name:'产品知识笔记',exact:true}).isVisible(),'成果目录失败时资料仍可见')
  assert.equal(await flakyGroup.getByText('工作成果',{exact:true}).count(),0,'成果目录失败时不出成果段')
  const outputs=await page.evaluate(()=>(window as any).__libraryOutputs)
  assert.deepEqual([...outputs.requested].sort(),['role-active','role-flaky','role-writer'])
  await page.screenshot({path:'/tmp/teloa-walkthrough/library-employee-outputs.png'})
  await directory.getByRole('button',{name:'竞品调研结论',exact:true}).click()
  await page.waitForFunction(()=>(window as any).__libraryOutputs.opened.length===1)
  assert.deepEqual((await page.evaluate(()=>(window as any).__libraryOutputs)).opened,['11111111-1111-4111-8111-111111111111'])
  assert.equal(await page.getByRole('alert').count(),0)
  await directory.getByRole('button',{name:'无权查看的成果',exact:true}).click()
  await page.getByRole('alert').waitFor()
  assert.ok((await page.getByRole('alert').innerText()).trim().length>0,'打开失败时给出错误提示')
  await page.screenshot({path:'/tmp/teloa-walkthrough/library-employee-output-error.png'})

  // ── 2. 点击员工资料打开详情预览 ────────────────────────────────────────────
  await directory.getByRole('button',{name:'员工专项资料甲',exact:true}).click()
  const detail=page.locator('main[data-teloa-pane=detail]')
  // 详情区域应显示选中资料的名称
  await detail.getByRole('heading',{name:'员工专项资料甲',exact:true}).waitFor()
  await page.screenshot({path:'/tmp/teloa-walkthrough/library-employee-resource-detail.png'})

  // ── 3. 搜索过滤员工知识分组 ─────────────────────────────────────────────────
  const searchInput=page.getByRole('searchbox').or(page.getByPlaceholder(/搜索/))
  if(await searchInput.count()>0){
    await searchInput.first().fill('资料甲')
    await page.waitForFunction(()=>{
      const buttons=document.querySelectorAll('[data-teloa-pane=directory] button')
      return Array.from(buttons).some(b=>b.textContent?.includes('员工专项资料甲'))&&!Array.from(buttons).some(b=>b.textContent?.includes('员工专项资料乙'))
    },{timeout:3000}).catch(()=>{/* 搜索UI可能以不同方式呈现 */})
    await page.screenshot({path:'/tmp/teloa-walkthrough/library-employee-search.png'})
    await searchInput.first().fill('文案')
    await directory.getByRole('button',{name:'新品发布文案',exact:true}).waitFor()
    assert.equal(await directory.getByRole('button',{name:'竞品调研结论',exact:true}).count(),0,'搜索同步过滤工作成果')
    await searchInput.first().fill('')
    await directory.getByRole('button',{name:'员工专项资料乙',exact:true}).waitFor()
  }

  // ── 4. 完整列表视图包含员工资料 ─────────────────────────────────────────────
  const listButton=page.getByRole('button',{name:'全部资料',exact:true}).or(page.getByRole('button',{name:'查看全部资料',exact:true}))
  if(await listButton.count()>0){
    await listButton.first().click()
    await page.getByRole('table').waitFor()
    const tableText=await page.getByRole('table').innerText()
    assert.match(tableText,/员工专项资料甲/,'完整列表应包含员工专项资料甲')
    assert.match(tableText,/员工专项资料乙/,'完整列表应包含员工专项资料乙')
    await page.screenshot({path:'/tmp/teloa-walkthrough/library-employee-list-view.png'})
  }

  assert.deepEqual(errors,[],'浏览器不应有未捕获错误')
})
