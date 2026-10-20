import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdir,writeFile} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('精简市场：员工／团队入口、应用连接往返、已添加无重复资源管理且安装恢复仍可达',async t=>{
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('本浏览器验收不允许执行宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/capability-center.tsx',import.meta.url)),name:'CapabilityCenterTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code
 const style=bundle.output.filter(item=>item.type==='asset'&&item.fileName.endsWith('.css')).map(item=>String((item as any).source)).join('\n')
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>市场开发预览</title><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 // 用例超时或被取消时立即关浏览器，不让无头进程在 t.after 之前悬着
 t.signal.addEventListener('abort',()=>{void browser.close().catch(()=>{})},{once:true})
 const page=await browser.newPage({viewport:{width:1440,height:1050}})
 page.setDefaultTimeout(7000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>{errors.push(error.message);console.error(error.stack)})
 const requests:string[]=[];await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent(html)
 const nav=page.getByRole('navigation',{name:'主导航',exact:true})
 await page.getByRole('heading',{level:1,name:'市场',exact:true}).waitFor()
 // 2026-10-14 最终 B：父层不再套「能力中心」标题、技术描述与我的／发现切换；主导航只有「市场」
 assert.equal(await page.getByRole('heading',{name:'能力中心',exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:/^(我的|发现)$/}).count(),0)
 assert.equal(await nav.getByRole('button',{name:'能力中心',exact:true}).count(),0)
 assert.equal(await nav.getByRole('button',{name:'市场',exact:true}).getAttribute('aria-current'),'page')
 const createOrImport=page.locator('summary[aria-label="创建或导入"]')
 assert.equal(await createOrImport.count(),1,'创建与导入只有一个页头入口')
 await createOrImport.click()
 // 当前夹具未提供模板创建端口：保留模板与技能导入；GitHub与粘贴在模板导入内部。
 for(const name of ['导入模板','导入技能'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),1,name)
 for(const name of ['创建任务模板','用会话创建行业模板','从 GitHub 添加','粘贴清单'])assert.equal(await page.getByRole('button',{name,exact:true}).count(),0,name)
 // 原生 toggle 事件在下一帧才登记关闭监听；等两帧后再按 Esc，与真实按键节奏一致
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 await page.keyboard.press('Escape');await page.locator('details[open] > summary[aria-label="创建或导入"]').waitFor({state:'detached'})
 assert.equal(await page.getByRole('button',{name:/^已添加/}).count(),1)
 const categories=page.getByRole('navigation',{name:'市场分类',exact:true})
 assert.deepEqual(await categories.getByRole('button').allTextContents(),['全部','AI 员工','AI 团队','应用','技能'])
 // 发现首页是 AI 员工；2026-10-14 用户选 B：应用是主导航旁的快捷入口，进入统一应用目录——连接器应用与技能同列，但各守应用/技能身份与已装/已连接状态
 // 隔离目录没有员工或团队条目：官方目录读完后给出真实空态，而不是补示例或列出连接器；用途分类只在有可选用途时出现（见 market-primary.browser）
 await page.getByRole('status').filter({hasText:'这里还没有内容'}).waitFor()
 assert.equal(await page.getByRole('group',{name:'用途分类',exact:true}).count(),0,'没有可选用途时不渲染只剩「全部」的分类')
 assert.equal(await page.locator('[data-catalog-row="teloa.github"]').count(),0,'AI 员工目录不列连接器')
 // 1.0：应用并入市场，是与 AI 员工、AI 团队并列的分类页签；左栏只留市场
 const appsEntry=categories.getByRole('button',{name:'应用',exact:true}),marketEntry=nav.getByRole('button',{name:'市场',exact:true})
 assert.equal(await page.getByRole('button',{name:'应用',exact:true}).count(),1,'应用只在市场分类一处');assert.equal(await nav.getByRole('button',{name:'应用',exact:true}).count(),0,'应用不再占左栏入口')
 await appsEntry.click()
 const appsSearch=page.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true});await appsSearch.waitFor()
 assert.equal(await appsEntry.getAttribute('aria-current'),'page');assert.equal(await marketEntry.getAttribute('aria-current'),'page','应用归属市场，左栏仍是市场')
 // 应用视图保留市场标题与分类；应用目录标题只给读屏
 assert.equal(await page.getByRole('heading',{name:'市场',exact:true}).count(),1);assert.equal(await page.getByRole('heading',{name:'应用',exact:true}).count(),1);assert.equal(await categories.count(),1,'应用视图保留市场分类')
 assert.equal(await page.locator('[data-catalog-row]').count(),0,'应用页不再是旧官方目录行')
 const github=page.getByRole('button',{name:/^GitHub/}),research=page.getByRole('button',{name:/^资料研究/})
 await github.waitFor();await research.waitFor()
 // 工作台注入全局受管连接后，应用目录实际读取连接列表：不再提示连接服务不可用，未添加的应用给出原目录「添加」动作
 await page.waitForFunction(()=>(window as any).capabilityCenterTest.calls.includes('connections:list'))
 assert.equal(await page.getByRole('status').filter({hasText:'应用连接服务暂不可用'}).count(),0)
 const githubRow=page.locator('li').filter({has:github})
 assert.equal(await githubRow.getByRole('button',{name:'添加',exact:true}).count(),1)
 // 详情抽屉以类型（应用／技能）为标题，名称是抽屉内标题；安装与连接状态按实际读取结果列在「来源与权限」里
 await github.click();const appDetail=page.getByRole('dialog',{name:'应用',exact:true});await appDetail.getByRole('heading',{name:'GitHub',exact:true}).waitFor()
 assert.match(await appDetail.innerText(),/未连接/,'连接器是应用：连接状态按实际读取结果显示');await appDetail.getByText('来源与权限',{exact:true}).click()
 assert.match(await appDetail.innerText(),/安装[\s\S]*未添加[\s\S]*连接[\s\S]*未连接/,'安装与连接各按实际读取结果显示');assert.equal(await appDetail.getByText('无需连接外部账号。',{exact:true}).count(),0)
 await page.keyboard.press('Escape');assert.equal(await appDetail.count(),0)
 await research.click();const skillDetail=page.getByRole('dialog',{name:'技能',exact:true});await skillDetail.getByRole('heading',{name:'资料研究',exact:true}).waitFor()
 assert.match(await skillDetail.innerText(),/无需连接外部账号。/,'技能不被当作应用');assert.equal(await page.getByRole('dialog',{name:'应用',exact:true}).count(),0)
 await page.keyboard.press('Escape');assert.equal(await skillDetail.count(),0)
 // Apps 内统一搜索覆盖应用与技能：搜「研究」只剩技能，连接器应用不混入
 await appsSearch.fill('研究');await research.waitFor();assert.equal(await github.count(),0,'Apps 内搜索按应用与技能统一匹配')
 // 从 Apps 点「添加」直接进入原连接页：连接不是内容，不发目录内容添加请求，也不自动提交或建立受管连接；返回后搜索与用途选择保留
 await appsSearch.fill('Git');await github.waitFor()
 const purposes=page.getByRole('navigation',{name:'应用用途',exact:true}),purpose=await purposes.locator('[aria-pressed="true"]').innerText()
 await githubRow.getByRole('button',{name:'添加',exact:true}).click()
 const back=page.getByRole('button',{name:'返回',exact:true});await back.waitFor()
 assert.equal(await appsSearch.count(),0,'进入原连接设置页')
 assert.deepEqual(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.filter((call:string)=>call.startsWith('catalog:add')||call.startsWith('managed:'))),[],'应用添加不调用目录内容添加，也不自动提交或建立受管连接')
 if(process.env.TELOA_CENTER_EVIDENCE){await mkdir(process.env.TELOA_CENTER_EVIDENCE,{recursive:true});await page.screenshot({path:process.env.TELOA_CENTER_EVIDENCE+'/市场B-连接页-开发.png',fullPage:true})}
 await back.click();await appsSearch.waitFor()
 assert.equal(await appsSearch.inputValue(),'Git','返回后保留应用搜索');assert.equal(await purposes.locator('[aria-pressed="true"]').innerText(),purpose,'返回后保留用途选择')
 assert.equal(await appsEntry.getAttribute('aria-current'),'page')
 await appsSearch.fill('');await github.waitFor()
 // 在应用里点左栏「市场」回到 AI 员工目录
 await marketEntry.click();await appsSearch.waitFor({state:'detached'})
 assert.equal(await categories.getByRole('button',{name:'AI 员工',exact:true}).getAttribute('aria-current'),'page');assert.equal(await marketEntry.getAttribute('aria-current'),'page');assert.equal(await appsEntry.getAttribute('aria-current'),null)
 assert.equal(await page.getByText('高级资源',{exact:true}).count(),0)
 assert.equal(await page.getByText('更多筛选',{exact:true}).count(),0)
 const addedEntry=page.getByRole('button',{name:/^已添加/})
 await addedEntry.click()
 await page.getByRole('heading',{level:2,name:'已添加',exact:true}).waitFor()
 assert.equal(await page.getByRole('navigation',{name:'我的资源分组',exact:true}).count(),0)
 assert.equal(await page.getByRole('region',{name:'我的应用',exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'已安装',exact:true}).count(),0)
 assert.equal(await marketEntry.getAttribute('aria-current'),'page')
 // 已保存的本人成果保留唯一直接入口，打开仍可用作计划；没有恢复四分类管理。
 await page.getByRole('button',{name:'本人周报模板',exact:true}).click()
 const ownTemplate=page.getByRole('dialog',{name:'本人周报模板',exact:true});await ownTemplate.waitFor()
 await ownTemplate.getByRole('button',{name:'创建持续计划',exact:true}).click()
 assert.ok(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.includes('plan:own-weekly')))
 await page.keyboard.press('Escape')
 // 应用从唯一常驻入口进入；查看安装记录仍调用原安装管理，不触发安装、连接或授权。
 await appsEntry.click();await appsSearch.waitFor()
 const records=page.getByRole('button',{name:'应用安装记录',exact:true})
 await records.click()
 assert.ok(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.includes('installations')))
 await page.getByRole('button',{name:'返回应用',exact:true}).click();await appsSearch.waitFor()
 const mine=page.getByRole('button',{name:/^我的应用 \d+$/})
 await mine.click();assert.equal(await mine.getAttribute('aria-pressed'),'true')
 assert.equal(await page.getByRole('navigation',{name:'我的资源分组',exact:true}).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.filter((call:string)=>call.startsWith('catalog:add')||call.startsWith('managed:'))),[])
 await mine.click();await github.waitFor()
 // 创建收为应用页加号：关闭不提交，重新打开保留原草稿。
 const openSkillCreator=async()=>{await page.locator('summary[aria-label="添加应用或技能"]').click();await page.getByRole('button',{name:'创建技能',exact:true}).click()}
 await openSkillCreator();const creator=page.getByRole('dialog',{name:'创建技能',exact:true})
 const sentence=creator.getByRole('textbox');await sentence.fill('把周报整理成摘要')
 await page.keyboard.press('Escape');assert.equal(await creator.isVisible(),false)
 await openSkillCreator();assert.equal(await sentence.inputValue(),'把周报整理成摘要')
 await page.keyboard.press('Escape')
 assert.equal(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.includes('prepare')),false)
 // 旧对象入口现在只在上下文抽屉里读原资源，不把四分类管理页接回市场。
 await page.evaluate(()=>(window as any).openCapabilityResource('skill'))
 const resourceContext=page.getByRole('dialog',{name:'技能',exact:true});await resourceContext.waitFor()
 await resourceContext.getByRole('option',{name:/research/}).waitFor()
 assert.equal(await resourceContext.getByRole('heading',{name:'技能',exact:true}).count(),1,'上下文目录仅保留抽屉标题')
 assert.equal(await resourceContext.getByRole('textbox').count(),1,'搜索仍在当前目录内')
 assert.equal(await resourceContext.getByRole('button',{name:'新建',exact:true}).count(),1,'页内添加入口保留')
 assert.equal(await resourceContext.getByRole('button',{name:'刷新能力目录',exact:true}).count(),1,'当前目录刷新保留')
 assert.equal(await resourceContext.getByRole('navigation',{name:'我的资源分组',exact:true}).count(),0)
 assert.equal(await resourceContext.getByRole('button',{name:'返回分类',exact:true}).count(),0,'上下文抽屉没有已退出分类页的返回动作')
 await resourceContext.getByRole('option',{name:/research/}).click()
 await resourceContext.getByRole('button',{name:'查看配置',exact:true}).waitFor()
 const settingsCount=await page.evaluate(()=>(window as any).capabilityCenterTest.calls.filter((call:string)=>call==='settings').length)
 await resourceContext.getByRole('button',{name:'查看配置',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).capabilityCenterTest.calls.filter((call:string)=>call==='settings').length),settingsCount+1)
 // 详情返回列表后可以选另一项，关闭重开也不困在上次详情。
 await resourceContext.getByRole('button',{name:'返回能力目录',exact:true}).click()
 await resourceContext.getByRole('option',{name:/test-skill-0/}).click()
 await resourceContext.getByRole('heading',{name:'test-skill-0',exact:true}).waitFor()
 await resourceContext.getByRole('button',{name:'返回能力目录',exact:true}).click()
 await page.keyboard.press('Escape');assert.equal(await resourceContext.count(),0)
 await page.evaluate(()=>(window as any).openCapabilityResource('skill'));await resourceContext.getByRole('option',{name:/research/}).waitFor()
 await page.keyboard.press('Escape');assert.equal(await resourceContext.count(),0)
 for(const [category,title] of [['source','连接器'],['method','工作安排'],['extension','应用']]){
  await page.evaluate((category:string)=>(window as any).openCapabilityResource(category),category)
  const context=page.getByRole('dialog',{name:title,exact:true});await context.waitFor()
  assert.equal(await context.getByRole('heading',{name:title,exact:true}).count(),1,'目录不重复 '+title+' 标题')
  assert.equal(await context.getByRole('textbox').count(),1)
  if(category==='extension'){await context.getByText('还没有添加应用或技能',{exact:true}).waitFor();assert.doesNotMatch(await context.innerText(),/扩展/)}
  await page.keyboard.press('Escape')
 }
 await appsSearch.waitFor()
 await page.setViewportSize({width:1100,height:900})
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 if(process.env.TELOA_CENTER_EVIDENCE){await mkdir(process.env.TELOA_CENTER_EVIDENCE,{recursive:true});await page.screenshot({path:process.env.TELOA_CENTER_EVIDENCE+'/market-simplified-apps.png',fullPage:false})}
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})


test('能力中心新建应用直接编辑 Markdown，关闭保稿且未提交不创建或安装',async t=>{
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('本浏览器验收不允许执行宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/capability-center.tsx',import.meta.url)),name:'CapabilityCenterCreationTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code
 const style=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>应用新建隔离验收</title><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>window.extensionCreation=true;</script><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}}),requests:string[]=[],errors:string[]=[]
 page.setDefaultTimeout(7000)
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 await page.setContent(html)
 const open=async()=>{await page.evaluate(()=>(window as any).openCapabilityResource('extension'));const drawer=page.getByRole('dialog',{name:'应用',exact:true});await drawer.getByRole('button',{name:'新建',exact:true}).click();return drawer}
 let drawer=await open()
 const sentence=()=>drawer.locator('textarea')
 const evidence=process.env.TELOA_CENTER_CREATION_EVIDENCE
 if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:evidence+'/extension-create-initial-1440.png',fullPage:true})}
 assert.equal(await sentence().count(),1,'点新建应用后直接出现 Markdown 输入，不需第二次点描述')
 assert.equal(await sentence().isEditable(),true)
 assert.equal(await drawer.getByRole('button',{name:'描述需求',exact:true}).count(),0)
 assert.equal(await sentence().getAttribute('placeholder'),'# 客户反馈\n把我提供的反馈归类，标出待办。','应用使用现有 Markdown 短例')
 const draft='# 每周工作摘要\n把选定资料整理成可核对的应用草案。'
 await sentence().fill(draft);await sentence().press('Enter')
 assert.equal(await sentence().inputValue(),draft+'\n','Enter只换行，不提交')
 await page.keyboard.press('Escape');await drawer.waitFor({state:'detached'})
 drawer=await open();assert.equal(await sentence().inputValue(),draft+'\n','Escape关闭后重开恢复同一应用草稿')
 await page.getByRole('dialog',{name:'应用',exact:true}).locator('textarea').click()
 await page.mouse.click(10,900);await drawer.waitFor({state:'detached'})
 drawer=await open();assert.equal(await sentence().inputValue(),draft+'\n','外点关闭后重开恢复原稿')
 if(evidence)await page.screenshot({path:evidence+'/extension-create-draft-1440.png',fullPage:true})
 await page.setViewportSize({width:430,height:900})
 assert.equal(await sentence().isEditable(),true)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'窄屏不横向溢出')
 if(evidence){
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
  await page.screenshot({path:evidence+'/extension-create-draft-430.png',fullPage:false})
  await writeFile(evidence+'/ui-facts.json',JSON.stringify(await page.evaluate(()=>({openDialogs:document.querySelectorAll('dialog[open]').length,dialogs:Array.from(document.querySelectorAll('dialog')).map(item=>({open:item.open,title:item.querySelector('h2')?.textContent,display:getComputedStyle(item).display,rect:{top:item.getBoundingClientRect().top,bottom:item.getBoundingClientRect().bottom}})),viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth})),null,2)+'\n')
 }
 const calls:string[]=await page.evaluate(()=>(window as any).capabilityCenterTest.calls as string[])
 assert.deepEqual(calls.filter(call=>call==='prepare'||call.startsWith('create:')||call.startsWith('install:')||call.startsWith('managed:')||call.startsWith('catalog:add')),[],'查看、输入和关闭不准备发送、不创建对象、不安装')
 assert.deepEqual(errors,[]);assert.deepEqual(requests,[])
})
