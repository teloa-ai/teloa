import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {build} from 'vite'
// @ts-expect-error 仓库现有浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('员工知识真实组件：明确目标、首次保存副本、历史恢复、草稿与未知结果隔离',async t=>{
 const report=process.env.TELOA_ACCEPTANCE_REPORT_DIR??await mkdtemp(join(tmpdir(),'teloa-knowledge-editor-'))
 const built=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('本浏览器验收不允许执行宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root:fileURLToPath(new URL('../../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('./fixtures/employee-knowledge-editor.tsx',import.meta.url)),name:'EmployeeKnowledgeEditor',formats:['iife']}}}),bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,style=bundle.output.filter((item:any)=>item.type==='asset'&&item.fileName.endsWith('.css')).map((item:any)=>String(item.source)).join('\n'),html='<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+style+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 await mkdir(report,{recursive:true});await writeFile(report+'/knowledge-editor-fixture.html',html)
 const geometry:Array<Record<string,unknown>>=[],browser=await loadPlaywright().chromium.launch(launchOptions());t.after(async()=>{await browser.close();await writeFile(report+'/knowledge-editor-container-evidence.json',JSON.stringify(geometry,null,2))})
 const setup=async()=>{
  const context=await browser.newContext({viewport:{width:1440,height:900}}),page=await context.newPage(),errors:string[]=[]
  page.setDefaultTimeout(8000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  await page.route('**/*',(route:any)=>route.request().url()==='http://127.0.0.1:3199/employee-knowledge-test'?route.fulfill({contentType:'text/html',body:html}):route.abort())
  const load=async()=>{await page.goto('http://127.0.0.1:3199/employee-knowledge-test');await page.getByRole('heading',{name:'调查操作手册',exact:true}).waitFor()}
  await load();return {context,page,errors,load}
 }
 const open=async(page:any,name='调查员工甲')=>{await page.getByLabel('选择要修改知识的员工',{exact:true}).selectOption({label:name});await page.getByRole('button',{name:'编辑员工知识',exact:true}).click();await page.getByLabel('Markdown 正文',{exact:true}).waitFor()}
 await t.test('全局多员工必须选择，打开不写；首次保存只改目标员工，历史恢复新增版本',async()=>{
  const {context,page,errors}=await setup();try{
   assert.equal(await page.getByRole('button',{name:'编辑员工知识',exact:true}).isDisabled(),true)
   await open(page);assert.equal(await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>/revise|restore/.test(row.endpoint)).length),0)
   const body=page.getByLabel('Markdown 正文',{exact:true});await body.fill('# 员工甲独立内容');await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByText('当前正文 v2',{exact:true}).waitFor()
   const data=await page.evaluate(()=>{const f=(window as any).fixture;return {a:f.documents[f.roles[0].id].at(-1).markdown,b:f.documents[f.roles[1].id].at(-1).markdown}});assert.equal(data.a,'# 员工甲独立内容');assert.match(data.b,/调查操作手册/)
   await page.locator('summary[aria-label="更多知识操作"]').click();await page.getByRole('button',{name:'页面信息与版本',exact:true}).click();await page.getByRole('button',{name:'查看版本 v1',exact:true}).click();await page.getByRole('button',{name:'恢复为新版本',exact:true}).click();await page.getByText('当前正文 v3',{exact:true}).waitFor()
   assert.equal(await page.evaluate(()=>(window as any).fixture.documents[(window as any).fixture.roles[0].id].length),3);assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 await t.test('未知保存刷新后核对原requestId，索引pending与ready分别显示',async()=>{
  const {context,page,errors,load}=await setup();try{
   await open(page);await page.getByLabel('Markdown 正文',{exact:true}).fill('# 等待核对的内容');await page.evaluate(()=>(window as any).fixture.mode('lost'));await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor()
   const request=await page.evaluate(()=>(window as any).fixture.calls.find((row:any)=>row.endpoint==='employee-knowledge/revise').input)
   await load();await open(page);assert.equal(await page.getByLabel('Markdown 正文',{exact:true}).inputValue(),'# 等待核对的内容');assert.equal(await page.getByRole('button',{name:'保存新版本',exact:true}).isDisabled(),true)
   await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await page.getByText('当前正文 v2',{exact:true}).waitFor();await page.getByText('正文已保存，检索索引正在更新',{exact:true}).waitFor()
   assert.equal(await page.evaluate(()=>(window as any).fixture.calls.find((row:any)=>row.endpoint==='employee-knowledge/status').input.requestId),request.requestId)
   await page.evaluate(()=>(window as any).fixture.ready());await page.getByRole('button',{name:'刷新正文状态',exact:true}).first().click();await page.getByText('当前正文已可检索',{exact:true}).waitFor();assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 for(const operation of ['revise','restore'])await t.test(`未知${operation}确认未保存后遇到版本冲突，可保留正文并明确按新版保存`,async()=>{
  const {context,page,errors,load}=await setup();try{
   await open(page)
   const body=page.getByLabel('Markdown 正文',{exact:true}),original=await body.inputValue()
   if(operation==='restore'){
    await body.fill('# 第二版正文');await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByText('当前正文 v2',{exact:true}).waitFor()
    await page.locator('summary[aria-label="更多知识操作"]').click();await page.getByRole('button',{name:'页面信息与版本',exact:true}).click();await page.getByRole('button',{name:'查看版本 v1',exact:true}).click()
   }else await body.fill('# 网络失败前的草稿')
   const expected=operation==='restore'?original:'# 网络失败前的草稿'
   await page.evaluate(()=>(window as any).fixture.mode('offline'))
   await page.getByRole('button',{name:operation==='restore'?'恢复为新版本':'保存新版本',exact:true}).click();await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor()
   const request=await page.evaluate((operation:string)=>(window as any).fixture.calls.filter((row:any)=>row.endpoint==='employee-knowledge/'+operation).at(-1).input,operation)
   await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor({state:'visible'})
   assert.equal(await page.getByRole('button',{name:'读取最新版并保留草稿',exact:true}).count(),0)
   await load();await open(page);assert.equal(await body.inputValue(),expected)
   await page.evaluate(async()=>{await (window as any).fixture.bump();(window as any).fixture.mode('success')})
   await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await page.getByRole('button',{name:'读取最新版并保留草稿',exact:true}).waitFor()
   assert.equal(await body.inputValue(),expected);assert.equal(await page.getByRole('button',{name:'核对保存结果',exact:true}).count(),0)
   await page.screenshot({path:`${report}/knowledge-recovery-${operation}.png`,fullPage:true})
   const replay=await page.evaluate((operation:string)=>(window as any).fixture.calls.filter((row:any)=>row.endpoint==='employee-knowledge/'+operation).at(-1).input,operation)
   assert.deepEqual(replay,request)
   await page.getByRole('button',{name:'读取最新版并保留草稿',exact:true}).click();assert.equal(await body.inputValue(),expected)
   await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByText(operation==='restore'?'当前正文 v4':'当前正文 v3',{exact:true}).waitFor()
   const saved=await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.endpoint==='employee-knowledge/revise').at(-1).input)
   assert.notEqual(saved.requestId,request.requestId);assert.equal(saved.markdown,expected);assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 await t.test('已有保存回执但核对接口拒绝时不解除pending或再次发送',async()=>{
  const {context,page,errors}=await setup();try{
   await open(page);await page.getByLabel('Markdown 正文',{exact:true}).fill('# 已保存但待核对')
   await page.evaluate(()=>(window as any).fixture.mode('lost'));await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByRole('button',{name:'核对保存结果',exact:true}).waitFor()
   await page.evaluate(()=>(window as any).fixture.mode('status-conflict'));await page.getByRole('button',{name:'核对保存结果',exact:true}).click()
   await page.getByRole('alert').filter({hasText:/版本已过期/}).waitFor()
   assert.equal(await page.getByRole('button',{name:'读取最新版并保留草稿',exact:true}).count(),0);assert.equal(await page.getByRole('button',{name:'保存新版本',exact:true}).isDisabled(),true)
   assert.equal(await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.endpoint==='employee-knowledge/revise').length),1)
   await page.evaluate(()=>(window as any).fixture.mode('success'));await page.getByRole('button',{name:'核对保存结果',exact:true}).click();await page.getByText('当前正文 v2',{exact:true}).waitFor();assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 await t.test('员工页直接进入当前员工；冲突保留草稿；换员工与重开不丢草稿',async()=>{
  const {context,page,errors}=await setup();try{
   await page.evaluate(()=>(window as any).fixture.view('role'));await page.getByRole('button',{name:'编辑员工知识 · 调查操作手册',exact:true}).click();await page.getByLabel('Markdown 正文',{exact:true}).fill('# 草稿留给员工甲')
   await page.evaluate(()=>(window as any).fixture.bump());await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByRole('button',{name:'读取最新版并保留草稿',exact:true}).waitFor();assert.equal(await page.getByLabel('Markdown 正文',{exact:true}).inputValue(),'# 草稿留给员工甲')
   await page.evaluate(()=>(window as any).fixture.role((window as any).fixture.roles[1].id));await page.getByRole('button',{name:'编辑员工知识 · 调查操作手册',exact:true}).click();assert.match(await page.getByLabel('Markdown 正文',{exact:true}).inputValue(),/调查操作手册/)
   await page.evaluate(()=>(window as any).fixture.role((window as any).fixture.roles[0].id));await page.getByRole('button',{name:'编辑员工知识 · 调查操作手册',exact:true}).click();assert.equal(await page.getByLabel('Markdown 正文',{exact:true}).inputValue(),'# 草稿留给员工甲');await page.getByRole('button',{name:'读取最新版并保留草稿',exact:true}).click();assert.equal(await page.getByLabel('Markdown 正文',{exact:true}).inputValue(),'# 草稿留给员工甲')
   await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByText('当前正文 v3',{exact:true}).waitFor();assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 await t.test('员工列表使用effective正文版本，编辑与绑定仍用logical ID；pending可读旧版，removed禁编辑',async()=>{
  const {context,page,errors}=await setup();try{
   await page.evaluate(()=>(window as any).fixture.view('role'));await page.getByRole('button',{name:'编辑员工知识 · 调查操作手册',exact:true}).waitFor()
   await page.getByRole('button',{name:'编辑员工知识 · 调查操作手册',exact:true}).click();await page.getByLabel('Markdown 正文',{exact:true}).fill('# 员工列表最新正文');await page.getByRole('button',{name:'保存新版本',exact:true}).click();await page.getByText('当前正文 v2',{exact:true}).waitFor();await page.getByRole('button',{name:'返回列表',exact:true}).click()
   const row=page.locator('li[data-resource-id="20000000-0000-4000-8000-000000000001"]');await row.getByText(/当前正文 v2/).waitFor();const effectiveId=await row.getAttribute('data-effective-resource-id');assert.notEqual(effectiveId,'20000000-0000-4000-8000-000000000001')
   await page.getByRole('button',{name:'编辑员工知识 · 调查操作手册',exact:true}).click();assert.equal(await page.getByLabel('Markdown 正文',{exact:true}).inputValue(),'# 员工列表最新正文');const read=await page.evaluate(()=>(window as any).fixture.calls.filter((row:any)=>row.endpoint==='employee-knowledge/read').at(-1).input);assert.equal(read.resourceId,'20000000-0000-4000-8000-000000000001');await page.getByRole('button',{name:'返回列表',exact:true}).click()
   await page.evaluate(()=>(window as any).fixture.retitle('员工当前资料名称'));await page.getByRole('button',{name:'刷新知识',exact:true}).click();await row.getByText('员工当前资料名称',{exact:true}).waitFor()
   await page.evaluate(()=>(window as any).fixture.pending(true));await page.getByRole('button',{name:'刷新知识',exact:true}).click();await page.getByText('新版资料正在接入；当前显示旧版本，完成后可继续编辑。',{exact:true}).waitFor();assert.equal(await row.getByRole('button',{name:'编辑员工知识 · 员工当前资料名称',exact:true}).isDisabled(),true);assert.match(await row.textContent(),/当前正文 v2/)
   await page.evaluate(()=>{(window as any).fixture.pending(false);(window as any).fixture.removed(true);(window as any).fixture.editable(true)});await page.getByRole('button',{name:'刷新知识',exact:true}).click();await row.getByText('已从当前包移除，不再供新任务使用',{exact:true}).waitFor();assert.equal(await row.getByRole('button',{name:/编辑员工知识/}).count(),0)
   await row.getByRole('button',{name:/移除/}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.bindingChanges.at(-1)),[])
   await page.getByRole('button',{name:'选择',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).fixture.bindingChanges.at(-1)),['20000000-0000-4000-8000-000000000001']);assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 await t.test('窄窗与720p至4K不产生横向溢出，正文编辑区保持可操作',async()=>{
  const {context,page,errors}=await setup();try{
   await open(page)
   for(const [width,height] of [[390,844],[1280,720],[1920,1080],[2560,1440],[3840,2160]]){
    await page.setViewportSize({width,height});await page.screenshot({path:`${report}/knowledge-editor-${width}x${height}.png`});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`${width}x${height} 横向溢出`);assert.equal(await page.getByRole('button',{name:'保存新版本',exact:true}).isVisible(),true)
   }
   assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
 await t.test('宽屏432px员工抽屉按容器上下排列历史，正文和格式工具保留可用宽度',async()=>{
  const {context,page,errors}=await setup();try{
   await page.evaluate(()=>(window as any).fixture.width(432));await open(page)
   await page.locator('summary[aria-label="更多知识操作"]').click();await page.getByRole('button',{name:'页面信息与版本',exact:true}).click();await page.getByRole('button',{name:'查看版本 v1',exact:true}).waitFor();await page.locator('summary[aria-label="更多知识操作"]').click()
   const measure=async()=>page.getByLabel('Markdown 正文',{exact:true}).evaluate((node:HTMLTextAreaElement)=>{
    const editor=node.closest('section')!,canvas=editor.parentElement!,body=canvas.parentElement!,document=body.parentElement!,history=document.querySelector('aside')!,host=document.closest('[data-editor-host]')!,toolbar=editor.querySelector('[role=toolbar]')!,rect=(element:Element)=>{const box=element.getBoundingClientRect();return {x:box.x,y:box.y,width:box.width,height:box.height,right:box.right,bottom:box.bottom}}
    return {body:rect(node),canvas:rect(canvas),history:rect(history),document:rect(document),host:rect(host),editor:rect(editor),toolbar:rect(toolbar),tools:Array.from(toolbar.children).map(rect),bodyPadding:getComputedStyle(node).paddingLeft,historyBorderLeft:getComputedStyle(history).borderLeftWidth,documentOverflow:document.scrollWidth>document.clientWidth,viewportOverflow:window.document.documentElement.scrollWidth>window.innerWidth}
   })
   for(const [width,height] of [[390,844],[1280,720],[1920,1080],[2560,1440],[3840,2160]]){
    await page.setViewportSize({width,height});await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
    const value=await measure();assert.ok(value.body.width>=300,`${width}x${height} 正文只有 ${value.body.width}px`);assert.ok(value.history.y>=value.canvas.bottom,`${width}x${height} 历史未移到正文下方`);assert.equal(value.historyBorderLeft,'0px');assert.equal(value.documentOverflow,false);assert.equal(value.viewportOverflow,false);assert.equal(value.bodyPadding,'20px');assert.ok(value.tools.every((tool:{x:number;right:number})=>tool.x>=value.editor.x&&tool.right<=value.editor.right),'格式工具不应被裁掉');assert.ok(value.document.right<=value.host.right)
    geometry.push({viewport:{width,height},hostWidth:432,...value});await page.screenshot({path:`${report}/knowledge-editor-drawer-${width}x${height}.png`,fullPage:true})
   }
   await page.setViewportSize({width:1920,height:1080})
   for(const hostWidth of [900,1200]){
    await page.evaluate((width:number)=>(window as any).fixture.width(width),hostWidth);await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));const value=await measure()
    if(hostWidth===900){assert.ok(value.body.width>=850);assert.ok(value.history.y>=value.canvas.bottom)}else{assert.ok(value.body.width>=850);assert.ok(value.history.x>=value.canvas.right);assert.equal(value.history.y,value.canvas.y)}
    assert.equal(value.documentOverflow,false);assert.equal(value.viewportOverflow,false);geometry.push({viewport:{width:1920,height:1080},hostWidth,...value});await page.screenshot({path:`${report}/knowledge-editor-container-${hostWidth}.png`,fullPage:true})
   }
   assert.deepEqual(errors,[])
  }finally{await context.close()}
 })
})
