import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {createServer} from 'node:http'
import {mkdtemp,readFile,writeFile,mkdir,rm} from 'node:fs/promises'
import {homedir,tmpdir} from 'node:os'
import {join} from 'node:path'
import {fileURLToPath,pathToFileURL} from 'node:url'
import {Pool} from './postgres-test-lifecycle.ts'
import {PostgreSqlContainer} from '@testcontainers/postgresql'
import {build} from 'vite'
import {readTemplateShare,readTemplateSharePackage,canonicalTemplateShare,templateShareDigest,WorkError} from '@teloa/contract'
import {MarketContentStore,initializeMarketContents} from '../src/market/content-store.ts'
import {GithubImportService} from '../src/market/github-import.ts'
import {GithubSourceService,initializeGithubSources} from '../src/market/github-source.ts'
import {IndustryLoadService,initializeIndustryLoads} from '../src/work/industry-loads.ts'
import {createIndustryLoadSource} from '../src/work/industry-load-source.ts'
import {BusinessSpaceService} from '../src/work/business-spaces.ts'
import {IndustryReferenceCatalog} from '../src/capabilities/industry-reference-catalog.ts'
import {ResourceService} from '../src/capabilities/resources.ts'
import {initializeResources} from '../src/capabilities/schema.ts'
import {IndustryKnowledgeService,initializeIndustryKnowledge} from '../src/work/industry-knowledge.ts'
import {IndustryRoleSource} from '../src/work/industry-role-source.ts'
import {IndustryRoleService,initializeIndustryRoles} from '../src/work/industry-roles.ts'
import {RoleService,initializeRoles} from '../src/work/roles.ts'
import {initializeTasks} from '../src/work/tasks.ts'
import {RoleLifecycleService,initializeRoleLifecycle} from '../src/work/role-lifecycle.ts'
import {initializeCollaboration} from '../src/work/collaboration.ts'
import {initializeGroupAgentGrants} from '../src/work/group-agent-grants.ts'
import {createRoleHandler} from '../../harness-dsh/src/roles.ts'
import {createMarketContentHandler} from '../../harness-dsh/src/market-content.ts'
import {createIndustryLoadsHandler} from '../../harness-dsh/src/industry-loads.ts'
import {createIndustryKnowledgeHandler} from '../../harness-dsh/src/industry-knowledge.ts'
import {createIndustryRolesHandler} from '../../harness-dsh/src/industry-roles.ts'
import {createBusinessSpaceHandler} from '../../harness-dsh/src/business-spaces.ts'
import {createIndustryPrepareHandler} from '../../harness-dsh/src/industry-prepare.ts'
import {buildSharePlan} from '../../client/ui-workbench/src/client/share-package-plan.ts'
// @ts-expect-error 复用本仓既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from '../../client/ui-workbench/tests/fixtures/load-playwright.mjs'

const identity={id:randomUUID,now:()=>new Date().toISOString()}
type RpcCall={endpoint:string;payload:any;localId?:string}
async function browserHtml(){
 const result=await build({configFile:false,plugins:[{name:'forbid-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器验收不能调用宿主摘要')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],root:fileURLToPath(new URL('../../../',import.meta.url)),logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:fileURLToPath(new URL('../../client/ui-workbench/tests/fixtures/employee-template-share-live.tsx',import.meta.url)),name:'EmployeeShareLive',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result
 assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code
 const css=bundle.output.filter(row=>row.type==='asset'&&row.fileName.endsWith('.css')).map(row=>String((row as any).source)).join('\n')
 return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+css+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
}
async function localHarness(t:any,pool:Pool,html:string,loss:'load'|'prepare'|'knowledge-two'){
 const owner='local:template-'+randomUUID(),market=new MarketContentStore(pool,identity),spaces=new BusinessSpaceService(pool,identity)
 const githubSources=new GithubSourceService(pool,identity,{request:async()=>{throw new WorkError('teloa/forbidden','本轮验收不允许访问外部 GitHub 来源。')}})
 const githubImports=new GithubImportService(market,{read:(ownerId,input)=>githubSources.read(ownerId,input)})
 const personal=await spaces.ensurePersonal(owner)
 const loads=new IndustryLoadService(pool,identity,createIndustryLoadSource(market),undefined,undefined,'personal')
 const sources=new IndustryReferenceCatalog(pool,market,loads),resources=new ResourceService(pool,sources,identity),knowledge=new IndustryKnowledgeService(pool,identity,loads,sources,resources),roles=new RoleService(pool,identity)
 const employees=new IndustryRoleService(pool,identity,loads,new IndustryRoleSource(market,loads),knowledge,roles)
 const roleHandler=createRoleHandler(owner,async()=>roles),lifecycle=new RoleLifecycleService(pool,identity)
 // v2 接收的一键准备走宿主真实处理器；分享员工不带技能、连接或插件，对应目录为空，除读取空技能目录外的技能调用即越界。
 const prepare=createIndustryPrepareHandler(owner,async()=>({
  loads:async(endpoint,payload)=>{if(endpoint!=='industry-loads/get')throw Error(endpoint);return loads.get(owner,payload as any)},
  knowledge:async(endpoint,payload)=>endpoint==='industry-knowledge/list'?knowledge.list(owner,payload as any):knowledge.instantiate(owner,payload as any),
  roles:async(endpoint,payload)=>endpoint==='industry-roles/list'?employees.list(owner,payload as any):employees.instantiate(owner,payload as any),
  roleRecords:(endpoint,payload)=>roleHandler(endpoint,payload),
  skills:async endpoint=>{if(endpoint==='skill-installations/list')return {items:[],usages:[]};throw Error('本轮不允许调用技能接口：'+endpoint)},
  mcp:async()=>({items:[]}),dataSources:async()=>({items:[]}),executionTools:async()=>({items:[]}),plugins:async()=>({items:[]}),
  lifecycle:payload=>lifecycle.change(owner,payload as any),sleep:async()=>{},
 }))
 const handlers=[
  {prefix:'roles/',call:roleHandler},
  {prefix:'industry-loads/readiness',call:prepare},{prefix:'industry-loads/prepare',call:prepare},
  {prefix:'market-content/',call:createMarketContentHandler(owner,async()=>({
   import:(actor,input)=>market.import(actor,input),
   importGithub:(actor,input)=>githubImports.importIndustry(actor,input),
   importGithubSkill:(actor,input)=>githubImports.importSkill(actor,input),
   get:(actor,input)=>market.get(actor,input),
   getImport:(actor,input)=>market.getImport(actor,input),
   list:(actor,input)=>market.list(actor,input),
  }))},
  {prefix:'industry-loads/',call:createIndustryLoadsHandler(owner,async()=>loads)},
  {prefix:'industry-knowledge/',call:createIndustryKnowledgeHandler(owner,async()=>knowledge)},
  {prefix:'industry-roles/',call:createIndustryRolesHandler(owner,async()=>employees)},
  {prefix:'business-spaces/',call:createBusinessSpaceHandler(owner,async()=>spaces,()=> 'personal')},
 ]
 const calls:RpcCall[]=[],unexpected:string[]=[],publisherCalls:string[]=[];let lost=false,publisher:any,publisherOwner:any
 const server=createServer(async(request,response)=>{
  if(request.method==='GET'&&request.url==='/'){response.setHeader('content-type','text/html; charset=utf-8');response.end(html);return}
  if(publisher&&request.url?.startsWith('/test/template-publisher')){
   try{
    let value:unknown
    if(request.method==='POST'&&request.url==='/test/template-publisher'){
     let raw='';for await(const chunk of request){raw+=chunk;if(Buffer.byteLength(raw)>2*1024*1024)throw Error('请求过大')}
     const {method,input}=JSON.parse(raw);assert.ok(['publish','list','revoke'].includes(method));publisherCalls.push(method)
     value=await publisher.rpc(method,publisherOwner,input)
    }else if(request.method==='GET'){
     const shareId=request.url.slice('/test/template-publisher/'.length);assert.match(shareId,/^[a-f0-9-]{36}$/i)
     const metadata=await publisher.call('/v1/shares/'+shareId),packageResponse=await publisher.call('/v1/shares/'+shareId+'/package')
     assert.equal(metadata.status,200);assert.equal(packageResponse.status,200);publisherCalls.push('read:'+shareId)
     const preview=await metadata.json();value={shareId,package:await packageResponse.json(),sha256:preview.sha256}
    }else throw Error('未知分享验收接口')
    response.setHeader('content-type','application/json');response.end(JSON.stringify(value))
   }catch(error){response.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:(error as Error).message}))}
   return
  }
  if(request.method!=='POST'||request.url!=='/rpc'){unexpected.push(request.method+' '+request.url);response.writeHead(404).end();return}
  try{
   let bytes=0;const chunks:Buffer[]=[]
   for await(const chunk of request){bytes+=chunk.length;if(bytes>2*1024*1024)throw Error('请求过大');chunks.push(chunk)}
   const {endpoint,payload}=JSON.parse(Buffer.concat(chunks).toString('utf8')),handler=handlers.find(row=>typeof endpoint==='string'&&endpoint.startsWith(row.prefix))
   if(!handler){unexpected.push(String(endpoint));throw new WorkError('teloa/forbidden','本轮不允许执行该接口。')}
   const localId=endpoint==='industry-knowledge/instantiate'?(await loads.get(owner,{loadId:payload.loadId})).items.find(item=>item.instanceId===payload.itemInstanceId)?.localId:undefined
   calls.push({endpoint,payload,...(localId?{localId}:{})})
   const value=await handler.call(endpoint,payload)
   // 模拟网络丢失发生在真实事务与 handler 回执核验成功之后。
   if(!lost&&(loss==='load'&&endpoint==='industry-loads/create'||loss==='prepare'&&endpoint==='industry-loads/prepare'||loss==='knowledge-two'&&localId==='knowledge-two')){
    // 单纯断开复用连接会被 Chromium 自动重传；截断已开始的回包让丢失确定发生在调用方。
    lost=true;response.writeHead(200,{'content-type':'application/json','content-length':'100','connection':'close'}).end('{"value":');return
   }
   response.setHeader('content-type','application/json');response.end(JSON.stringify({value}))
  }catch(error){response.writeHead(400,{'content-type':'application/json'}).end(JSON.stringify({error:{code:(error as any).code??'teloa/unavailable',message:(error as Error).message}}))}
 })
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
 t.after(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve())}))
 const address=server.address();assert.ok(address&&typeof address==='object')
 const origin='http://127.0.0.1:'+address.port,serviceRoot=process.env.TELOA_TEMPLATE_SERVICE_ROOT
 // 可选的跨仓开发输入只从明确传入的本机路径加载，不把私有服务源码打入社区产物。
 if(serviceRoot){const service=await import(pathToFileURL(join(serviceRoot,'apps/template-share-api/tests/fixture.mjs')).href);publisherOwner=service.OWNER;publisher=await service.fixture(t,{vars:{API_ORIGIN:origin,SHARE_SITE_ORIGIN:origin}})}
 return {owner,personal,loads,knowledge,roles,employees,calls,unexpected,publisherCalls,publisher,origin,lost:()=>lost}
}
const multilineDescription='核对本人提供的资料。\n逐项注明可核实来源。\n整理观点与未决问题。\n对照两份知识的版本。\n保留本人审批边界。\n完整介绍末尾标记。'
function fullPackage(title='完整资源研究员工'){
 const id=randomUUID(),version='1.0.0'
 const resources=[{id:'employee',kind:'role',title,version,required:true,source:{kind:'local',path:'role.json'}},...['knowledge-one','knowledge-two'].map(localId=>({id:localId,kind:'knowledge',title:localId,version,required:true,source:{kind:'local',path:localId+'.md'}})),{id:'review-skill',kind:'skill',title:'核对方法',version,required:false,source:{kind:'local',path:'skills/review/SKILL.md'}}]
 const manifest={format:'teloa.business-package/v2',id,version,title,description:multilineDescription,domain:'general',scope:'general',resources,relations:[{kind:'role-knowledge',from:'employee',to:'knowledge-one'},{kind:'role-knowledge',from:'employee',to:'knowledge-two'},{kind:'role-skill',from:'employee',to:'review-skill'}],entrypoints:[]}
 return readTemplateSharePackage({format:'teloa.template-share/v1',id,version,title:manifest.title,description:manifest.description,compatibility:{manifestFormat:'teloa.business-package/v2',capabilities:['people']},requirements:['配置本人模型与权限。'],files:[{path:'teloa.json',text:JSON.stringify(manifest)},{path:'role.json',text:JSON.stringify({format:'teloa.role/v1',name:manifest.title,kind:'employee',avatarKey:'researcher',duty:'形成可核对建议。',dataScope:'本人选择的两份知识。',executionScope:'仅阅读与代拟。'})},{path:'knowledge-one.md',text:'# 第一份知识\n\n核对资料来源。'},{path:'knowledge-two.md',text:'# 第二份知识\n\n核对资料版本。'},{path:'skills/review/SKILL.md',text:'---\nname: review\ndescription: Review provided material.\n---\n\nReview material; ask before external actions.'}]})
}
async function localPage(t:any,browser:any,origin:string){
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}})
 t.after(()=>context.close())
 const page=await context.newPage();page.setDefaultTimeout(7000)
 const errors:string[]=[],blocked:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>{const url=new URL(route.request().url());if(url.origin===origin)return route.continue();blocked.push(url.href);return route.abort()})
 await page.goto(origin+'/')
 return {page,errors,blocked}
}
const confirm=async(page:any)=>{await page.getByRole('button',{name:'确认添加',exact:true}).click()}
const retry=async(page:any)=>{await page.getByRole('button',{name:'核对原请求',exact:true}).click()}
const configuration=(page:any)=>page.locator('dialog[open] summary').filter({hasText:'查看完整配置'})
async function selectTemplateFile(dialog:any,path:string){
 const file=dialog.getByRole('button',{name:path,exact:true})
 await file.click();assert.equal(await file.getAttribute('aria-pressed'),'true')
 await dialog.getByRole('region',{name:path,exact:true}).waitFor()
}
async function firstFold(page:any,action:string){
 assert.equal(await configuration(page).evaluate((node:HTMLElement)=>(node.parentElement as HTMLDetailsElement).open),false,'完整配置默认折叠')
 const button=page.locator('dialog[open] article').getByRole('button',{name:action,exact:true}),box=await button.boundingBox(),viewport=page.viewportSize()
 await page.waitForFunction((node:HTMLButtonElement)=>!node.disabled,await button.elementHandle())
 assert.ok(box&&box.y>=0&&box.y+box.height<=viewport.height,action+' 在首屏可见')
 assert.ok(box.height>=44,'真实宿主祖先中主动作高度仍至少 44px')
 assert.equal(await page.locator('dialog[open] article h3').evaluate((node:HTMLElement)=>getComputedStyle(node).fontSize),'22px','真实 TaskPage/TeamPage 祖先不覆盖卡片标题字号')
 const privacy=page.locator('dialog[open] p').filter({hasText:/^不包含账号、登录密钥、私人记忆、会话、权限或工作进度。$|^副本使用你自己的材料、模型和权限；添加不会开始执行任务。$/})
 assert.equal(await privacy.evaluate((node:HTMLElement)=>getComputedStyle(node).fontSize),'12px','真实员工详情祖先不覆盖隐私说明字号')
 const dialog=await page.locator('dialog[open]').boundingBox();assert.ok(dialog&&dialog.x>=0&&dialog.x+dialog.width<=viewport.width,'抽屉不横向溢出')
 await button.hover()
 const contrast=await button.evaluate((node:HTMLElement)=>{
  const style=getComputedStyle(node),luminance=(color:string)=>{const channels=color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(channel=>{const value=channel/255;return value<=.04045?value/12.92:((value+.055)/1.055)**2.4});return .2126*channels[0]!+.7152*channels[1]!+.0722*channels[2]!}
  const foreground=luminance(style.color),background=luminance(style.backgroundColor);return (Math.max(foreground,background)+.05)/(Math.min(foreground,background)+.05)
 })
 assert.ok(contrast>=4.5,action+' 悬停时文字对比度合格，实际 '+contrast.toFixed(2))
 await page.mouse.move(0,0)
}
async function screenshot(page:any,name:string,action?:string){
 const output=process.env.TELOA_TEMPLATE_CORE_E2E_OUTPUT
 for(const viewport of [{width:1440,height:1000},{width:1280,height:800}]){
  await page.setViewportSize(viewport)
  await configuration(page).evaluate((node:HTMLElement)=>{(node.parentElement as HTMLDetailsElement).open=false})
  await page.locator('dialog[open]').evaluate((node:HTMLElement)=>{node.scrollTop=0})
  if(action)await firstFold(page,action)
  // 等待尺寸变化与粘性头完成绘制，避免截到上一视口的合成残影。
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))))
  if(output){await mkdir(output,{recursive:true});await page.screenshot({path:join(output,name+'-'+viewport.width+'x'+viewport.height+'.png')})}
 }
}
async function closeAndFocus(page:any,trigger:string){
 await page.getByRole('button',{name:'关闭',exact:true}).click()
 assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await page.getByRole('button',{name:trigger,exact:true}).evaluate((node:HTMLElement)=>node===document.activeElement),true,'关闭后焦点返回原入口')
}
async function delayedPreview(t:any,page:any){
 const slow={shareId:randomUUID(),package:fullPackage('慢速模板 A')},fast={shareId:randomUUID(),package:fullPackage('快速模板 B')}
 const a={...slow,sha256:await templateShareDigest(slow.package)},b={...fast,sha256:await templateShareDigest(fast.package)}
 let started!:()=>void,release!:()=>void
 const aStarted=new Promise<void>(resolve=>{started=resolve}),gate=new Promise<void>(resolve=>{release=resolve})
 await page.route('**/test/template-preview/*',async(route:any)=>{const id=new URL(route.request().url()).pathname.split('/').at(-1);if(id===a.shareId){started();await gate;return route.fulfill({contentType:'application/json',body:JSON.stringify(a)})}if(id===b.shareId)return route.fulfill({contentType:'application/json',body:JSON.stringify(b)});throw Error('未知的验收模板')})
 await page.evaluate(()=>{(window as any).__templateRaceTitles=[];const observer=new MutationObserver(()=>{for(const node of document.querySelectorAll('dialog[open] h3'))(window as any).__templateRaceTitles.push(node.textContent)});observer.observe(document.body,{childList:true,subtree:true,characterData:true});(window as any).__stopTemplateRace=()=>observer.disconnect()})
 const deliver=(id:string)=>page.evaluate((shareId:string)=>window.dispatchEvent(new CustomEvent('teloa-test-template-intent',{detail:{shareId}})),id)
 try{
  await deliver(a.shareId);await aStarted;await deliver(b.shareId)
  await page.getByRole('heading',{name:b.package.title,exact:true}).waitFor()
  const completed=page.waitForResponse((response:any)=>new URL(response.url()).pathname==='/test/template-preview/'+a.shareId);release();await (await completed).finished();await page.waitForLoadState('networkidle')
  assert.equal(await page.getByRole('heading',{name:b.package.title,exact:true}).count(),1)
  assert.equal(await page.getByRole('heading',{name:a.package.title,exact:true}).count(),0)
  const titles=await page.evaluate(()=>(window as any).__templateRaceTitles)
  assert.equal(titles.includes(a.package.title),false,'晚到的 A 不曾替换当前 B')
  assert.ok(titles.includes(b.package.title));await screenshot(page,'later-preview-keeps-b')
 }finally{release();await page.evaluate(()=>(window as any).__stopTemplateRace())}
}

test('员工模板真实 UI → 本机 HTTP Harness → 隔离 PG：失回执恢复本人副本', {timeout:180_000},async t=>{
 const directory=await mkdtemp(join(tmpdir(),'teloa-template-share-live-'));t.after(()=>rm(directory,{recursive:true,force:true}))
 process.env.DOCKER_HOST='unix://'+join(homedir(),'.orbstack/run/docker.sock');process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE='/var/run/docker.sock'
 const container=await new PostgreSqlContainer('postgres:17-alpine').start()
 const pool=new Pool({connectionString:container.getConnectionUri()});t.after(async()=>{await pool.end();await container.stop()})
 for(const initialize of [initializeMarketContents,initializeGithubSources,initializeResources,initializeIndustryLoads,initializeIndustryKnowledge,initializeRoles,initializeCollaboration,initializeGroupAgentGrants,initializeTasks,initializeRoleLifecycle,initializeIndustryRoles])await initialize(pool)
 const html=await browserHtml(),browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())

 await t.test('导出完整正文，文件预览后明确添加；加载成功失回执再核对不重复、不执行',async t=>{
  const f=await localHarness(t,pool,html,'load'),{page,errors,blocked}=await localPage(t,browser,f.origin)
  await page.getByRole('button',{name:'分享验收员工',exact:true}).click()
  await page.getByRole('dialog',{name:'分享模板',exact:true}).waitFor()
  await page.getByRole('heading',{name:'验收研究员工',exact:true}).waitFor()
  // 1.0 头像是内联 SVG 小机器人，按 data-avatar 核对分享卡与接收卡显示同一员工形象。
  assert.equal(await page.getByRole('dialog',{name:'分享模板',exact:true}).locator('article [data-avatar] svg').count(),1,'分享卡复用所选员工形象')
  const sharedAvatar=await page.getByRole('dialog',{name:'分享模板',exact:true}).locator('article [data-avatar]').getAttribute('data-avatar')
  assert.equal(sharedAvatar,'security-analyst')
  await screenshot(page,'author-offline-draft','导出离线模板')
  const downloading=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线模板',exact:true}).click()
  const downloaded=await downloading,path=join(directory,'employee.teloa-share.json');await downloaded.saveAs(path)
  const raw=await readFile(path,'utf8'),pkg=readTemplateShare(JSON.parse(raw))
  for(const secret of ['SOURCE_PRIVATE','source-private','aaaaaaaa-aaaa','SOC','runtimeConfig'])assert.equal(raw.includes(secret),false,secret+' 不进入模板')
  assert.equal(JSON.parse(pkg.files.find(file=>file.path==='employee.json')!.text).avatarKey,'security-analyst');assert.equal(pkg.files.length,3);assert.equal(f.calls.length,0,'导出不会发布或创建资源')
  await closeAndFocus(page,'分享验收员工')
  await page.getByRole('button',{name:'分享验收员工',exact:true}).click()
  const downloadingAgain=page.waitForEvent('download');await page.getByRole('button',{name:'导出离线模板',exact:true}).click()
  const reopenedPath=join(directory,'employee-reopened.teloa-share.json');await (await downloadingAgain).saveAs(reopenedPath)
  assert.equal(await readFile(reopenedPath,'utf8'),raw,'首次草稿关闭重开后保留相同模板身份与正文')
  await closeAndFocus(page,'分享验收员工')
  await page.getByRole('button',{name:'接收模板文件',exact:true}).click()
  await page.getByLabel('选择离线模板文件',{exact:true}).setInputFiles(path)
  await page.getByRole('heading',{name:'验收研究员工',exact:true}).waitFor()
  const receive=page.getByRole('dialog',{name:'导入模板',exact:true})
  assert.equal(await receive.locator('article [data-avatar]').getAttribute('data-avatar'),sharedAvatar)
  await screenshot(page,'role-file-preview','确认添加')
  await configuration(page).click()
  await selectTemplateFile(receive,'employee.json')
  await receive.getByText('仅接收方明确提供的资料。',{exact:false}).waitFor()
  assert.equal(f.calls.length,0,'文件预览不会创建或执行')
  await confirm(page);await page.getByRole('alert').waitFor()
  // v2 员工经固定内容 → 加载 → 一键准备建立：加载已写入、回包丢失时尚未建员工。
  assert.equal(f.lost(),true);assert.equal((await f.loads.list(f.owner,{})).items.length,1);assert.equal((await f.roles.list(f.owner,{})).length,0)
  await screenshot(page,'role-receipt-lost','核对原请求')
  await retry(page);await page.getByText('员工副本已添加。',{exact:true}).waitFor().catch(async(error:unknown)=>{console.error({calls:f.calls.map(row=>row.endpoint),page:await page.locator('dialog[open]').innerText()});throw error})
  const saved=await f.roles.list(f.owner,{});assert.equal(saved.length,1);assert.equal(saved[0]!.ownerId,f.owner);assert.deepEqual(saved[0]!.skills,[]);assert.deepEqual(saved[0]!.knowledge,[]);assert.deepEqual(saved[0]!.scopes,['general']);assert.equal(saved[0]!.runtimeConfig,undefined);assert.equal(saved[0]!.avatarKey,'security-analyst')
  const attempts=f.calls.filter(row=>row.endpoint==='industry-loads/create');assert.equal(attempts.length,2);assert.equal(attempts[0]!.payload.requestId,attempts[1]!.payload.requestId)
  assert.equal((await f.loads.list(f.owner,{})).items.length,1,'核对原请求续用原加载，不另建')
  assert.equal(f.calls.filter(row=>row.endpoint==='market-content/import').length,1);assert.equal(f.calls.filter(row=>row.endpoint==='industry-loads/prepare').length,1)
  assert.equal(f.calls.filter(row=>row.endpoint==='roles/create').length,0,'v2 员工只由加载真源实例化')
  assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
  await screenshot(page,'role-copy-added','查看员工')
  await page.locator('dialog[open] article').getByRole('button',{name:'查看员工',exact:true}).click();assert.equal(await page.getByLabel('当前打开对象',{exact:true}).textContent(),'role:'+saved[0]!.id)
  assert.equal(await page.locator('dialog[open]').count(),0,'查看员工关闭原抽屉并打开真实回执对象')
  if(f.publisher){
   await page.evaluate(()=>window.dispatchEvent(new CustomEvent('teloa-test-template-publisher')))
   await page.getByRole('button',{name:'分享验收员工',exact:true}).click()
   await page.getByRole('button',{name:'发布分享链接',exact:true}).waitFor()
   await screenshot(page,'author-publish-ready','发布分享链接')
   await page.getByRole('button',{name:'发布分享链接',exact:true}).click()
   await page.getByRole('button',{name:'复制链接',exact:true}).waitFor()
   const shareUrl=await page.getByLabel('分享链接',{exact:true}).textContent(),shareId=new URL(shareUrl!).searchParams.get('id')!
   const publishedResponse=await f.publisher.call('/v1/shares/'+shareId+'/package');assert.equal(publishedResponse.status,200)
   assert.equal(await templateShareDigest(await publishedResponse.json()),await templateShareDigest(pkg),'Worker 的固定包摘要与真实作者草稿一致')
   assert.equal((await f.publisher.db.prepare('select count(*) n from template_shares').first()).n,1,'实际隔离 D1 仅发布一次')
   await screenshot(page,'author-published','复制链接')
   await page.context().grantPermissions(['clipboard-read','clipboard-write'],{origin:f.origin})
   await page.getByRole('button',{name:'复制链接',exact:true}).click()
   await page.getByRole('button',{name:'链接已复制',exact:true}).waitFor()
   assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),shareUrl)
   await screenshot(page,'author-link-copied','链接已复制')
   await closeAndFocus(page,'分享验收员工')
   const priorReads=f.publisherCalls.filter((method:string)=>method.startsWith('read:')).length
   await page.evaluate((id:string)=>window.dispatchEvent(new CustomEvent('teloa-test-template-intent',{detail:{shareId:id,publisher:true}})),shareId)
   await page.getByRole('heading',{name:pkg.title,exact:true}).waitFor()
   await screenshot(page,'published-link-preview','确认添加')
   await confirm(page);await page.getByText('员工副本已添加。',{exact:true}).waitFor()
   assert.equal(f.publisherCalls.filter((method:string)=>method.startsWith('read:')).length,priorReads+2,'预览与明确添加前均重新读取真实 Worker')
   assert.equal((await f.roles.list(f.owner,{})).length,1,'同一已接收包不会另建员工副本')
   await page.locator('dialog[open] article').getByRole('button',{name:'查看员工',exact:true}).click();assert.equal(await page.getByLabel('当前打开对象',{exact:true}).textContent(),'role:'+saved[0]!.id)
  }
  const priorCalls=f.calls.length;await delayedPreview(t,page);assert.equal(f.calls.length,priorCalls,'切换链接仅预览，不产生 PG 写入')
  assert.deepEqual(f.unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 })

// 与作者端同一套计划器生成的 v2 员工包：只带员工正文，不带技能、资料或连接。
function employeePackage(){
 return buildSharePlan({subject:'employee',publisher:'验收作者',roles:[{id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',name:'验收准备员工',kind:'employee',avatarKey:'security-analyst',duty:'核对本人提供的资料并形成建议。',dataScope:'仅接收方明确提供的资料。',executionScope:'仅阅读与代拟，外部操作须本人批准。',skills:[],knowledge:[]}],skills:[]})
}

 await t.test('员工成功建立后最终 prepare 回执丢失：按真实员工目录核对原对象，不重复、不执行、关闭不重做',async t=>{
  const f=await localHarness(t,pool,html,'prepare'),{page,errors,blocked}=await localPage(t,browser,f.origin),pkg=employeePackage(),path=join(directory,'prepare.teloa-share.json')
  await writeFile(path,canonicalTemplateShare(pkg))
  await page.getByRole('button',{name:'接收模板文件',exact:true}).click();await page.getByLabel('选择离线模板文件',{exact:true}).setInputFiles(path)
  await page.getByRole('heading',{name:pkg.title,exact:true}).waitFor();assert.equal(f.calls.length,0)
  await confirm(page)
  // 员工、加载与资料已全部写入后回包被截断：客户端不得再发 prepare，而是读真实 industry-roles/list 核对原对象。
  await page.getByText('员工副本已添加。',{exact:true}).waitFor().catch(async(error:unknown)=>{console.error({calls:f.calls.map(row=>row.endpoint),lost:f.lost(),page:await page.locator('dialog[open]').innerText()});throw error})
  await page.getByText('资源包员工保持暂停，配置后再启用。',{exact:true}).waitFor()
  assert.equal(f.lost(),true);assert.equal(await page.locator('dialog[open] [role="alert"]').count(),0,'丢失的是终态回执，核对真源后不再报错')
  const endpoints=f.calls.map(row=>row.endpoint)
  assert.equal(endpoints.filter(name=>name==='industry-loads/prepare').length,1,'最终回执丢失后不重发 prepare')
  assert.equal(endpoints.filter(name=>name==='industry-loads/create').length,1);assert.equal(endpoints.filter(name=>name==='market-content/import').length,1);assert.equal(endpoints.filter(name=>name==='roles/create').length,0)
  assert.ok(endpoints.lastIndexOf('industry-roles/list')>endpoints.indexOf('industry-loads/prepare'),'prepare 之后按真实员工目录核对')
  // 同一 owner、原 load / 实例 / 员工一一对应；最终员工仍暂停，源权限与 runtimeConfig 不进入副本，资料版本随加载固定。
  const [load]=(await f.loads.list(f.owner,{})).items,[instance]=(await f.employees.list(f.owner,{})).items,saved=await f.roles.list(f.owner,{})
  assert.ok(load&&instance&&saved.length===1);assert.equal(load.ownerId,f.owner);assert.equal(instance.loadId,load.id);assert.equal(instance.itemInstanceId,load.items.find(item=>item.kind==='role')!.instanceId)
  // 分享副本不自动上岗：接收端明确请求 activate:false，实例与本人员工都保持暂停，不启用自动小结计划。
  assert.equal(instance.role?.id,saved[0]!.id);assert.equal(instance.state,'paused');assert.equal(saved[0]!.state,'paused');assert.equal(saved[0]!.ownerId,f.owner)
  assert.equal((await pool.query('select count(*)::int n from teloa_role_transitions where role_id=$1',[saved[0]!.id])).rows[0].n,0,'没有任何上岗/暂停变更，自动小结计划不会随恢复启用')
  assert.deepEqual(saved[0]!.skills,[]);assert.deepEqual(saved[0]!.knowledge,[]);assert.deepEqual(saved[0]!.scopes,['general']);assert.equal(saved[0]!.runtimeConfig,undefined);assert.equal(saved[0]!.avatarKey,'security-analyst')
  assert.deepEqual(load.items.map(item=>[item.kind,item.version]),[['role',pkg.version]]);assert.equal(load.templateVersion,pkg.version)
  assert.equal(await page.getByRole('button',{name:'查看员工',exact:true}).first().isVisible(),true)
  // 非本人：同一服务对另一 owner 既读不到也没有写入。
  const stranger='local:stranger-'+randomUUID()
  assert.deepEqual(await f.roles.list(stranger,{}),[]);assert.deepEqual((await f.employees.list(stranger,{})).items,[]);assert.deepEqual((await f.loads.list(stranger,{})).items,[])
  assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
  // 关闭抽屉只恢复入口焦点，不重发任何请求；重开同一文件仍只核对、不再建。
  const settled=f.calls.length
  await closeAndFocus(page,'接收模板文件')
  await page.getByRole('button',{name:'接收模板文件',exact:true}).click();await page.getByLabel('选择离线模板文件',{exact:true}).setInputFiles(path)
  await page.getByRole('heading',{name:pkg.title,exact:true}).waitFor()
  assert.equal(f.calls.length,settled,'关闭与重开只预览，不触发重做')
  await confirm(page);await page.getByText('员工副本已添加。',{exact:true}).waitFor()
  assert.equal(f.calls.filter(row=>row.endpoint==='industry-loads/prepare').length,1);assert.equal(f.calls.filter(row=>row.endpoint==='industry-loads/create').length,1)
  assert.equal((await f.roles.list(f.owner,{})).length,1);assert.equal((await f.loads.list(f.owner,{})).items.length,1)
  assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
  assert.deepEqual(f.unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 })

 await t.test('完整包第二份知识成功失回执；刷新重试不重发首份，原个人空间员工暂停',async t=>{
  const f=await localHarness(t,pool,html,'knowledge-two'),{page,errors,blocked}=await localPage(t,browser,f.origin),pkg=fullPackage(),path=join(directory,'full.teloa-share.json')
  await writeFile(path,canonicalTemplateShare(pkg))
  await assert.rejects(f.loads.create(f.owner,{requestId:randomUUID(),contentId:randomUUID(),contentHash:'a'.repeat(64),target:{kind:'new',spaceId:randomUUID(),name:'禁止新空间'}}),{code:'teloa/forbidden'})
  await page.getByRole('button',{name:'接收模板文件',exact:true}).click();await page.getByLabel('选择离线模板文件',{exact:true}).setInputFiles(path)
  await page.getByRole('heading',{name:pkg.title,exact:true}).waitFor();assert.equal(f.calls.length,0)
  assert.ok(pkg.description.length<240,'短多行介绍回归输入低于旧字符阈值')
  const readMore=page.getByRole('button',{name:'展开介绍',exact:true});await readMore.waitFor()
  await readMore.click();assert.equal(await page.getByRole('button',{name:'收起介绍',exact:true}).getAttribute('aria-expanded'),'true')
  const description=page.locator('dialog[open] article p').filter({hasText:'完整介绍末尾标记。'})
  assert.equal(await description.evaluate((node:HTMLElement)=>node.scrollHeight<=node.clientHeight+1),true,'展开后末尾不被截断')
  const expandedBox=await description.boundingBox();assert.ok(expandedBox&&expandedBox.y+expandedBox.height<=page.viewportSize().height,'展开后末尾完整可见')
  await page.getByRole('button',{name:'收起介绍',exact:true}).click()
  await screenshot(page,'bundle-file-preview','确认添加')
  await confirm(page);await page.getByRole('alert').waitFor().catch(async(error:unknown)=>{console.error({calls:f.calls.map(row=>[row.endpoint,row.localId]),lost:f.lost(),page:await page.locator('dialog[open]').innerText()});throw error});assert.equal(f.lost(),true)
  assert.equal((await f.knowledge.list(f.owner,{})).items.length,2);assert.equal((await f.roles.list(f.owner,{})).length,0)
  const before=f.calls.filter(row=>row.endpoint==='industry-knowledge/instantiate');assert.deepEqual(before.map(row=>row.localId),['knowledge-one','knowledge-two'])
  await screenshot(page,'bundle-knowledge-receipt-lost','核对原请求')
  await page.reload();await page.getByRole('button',{name:'接收模板文件',exact:true}).click();await page.getByLabel('选择离线模板文件',{exact:true}).setInputFiles(path)
  await page.getByRole('heading',{name:pkg.title,exact:true}).waitFor();await confirm(page)
  await page.getByText('员工副本已添加。',{exact:true}).waitFor();await page.getByText('资源包员工保持暂停，配置后再启用。',{exact:true}).waitFor()
  const attempts=f.calls.filter(row=>row.endpoint==='industry-knowledge/instantiate');assert.deepEqual(attempts.map(row=>row.localId),['knowledge-one','knowledge-two','knowledge-two']);assert.equal(attempts[1]!.payload.requestId,attempts[2]!.payload.requestId)
  const [employee]=await f.roles.list(f.owner,{});assert.ok(employee);assert.equal(employee.state,'paused');assert.equal(employee.ownerId,f.owner);assert.equal(employee.knowledge.length,2);assert.equal(employee.avatarKey,'researcher');assert.deepEqual(employee.skills,[])
  const {items}=await f.employees.list(f.owner,{});assert.equal(items.length,1);assert.deepEqual(items[0]!.declarations.map(row=>[row.kind,row.status]),[['skill','pending-adapter']])
  const load=(await f.loads.list(f.owner,{})).items;assert.equal(load.length,1);assert.equal(load[0]!.space.id,f.personal.id)
  assert.equal(f.calls.filter(row=>row.endpoint==='market-content/import').length,1);assert.equal(f.calls.filter(row=>row.endpoint==='industry-loads/create').length,1)
  assert.equal((await pool.query('select count(*)::int n from teloa_business_spaces where owner_id=$1',[f.owner])).rows[0].n,1)
  assert.equal((await pool.query('select count(*)::int n from teloa_tasks where owner_id=$1',[f.owner])).rows[0].n,0)
  assert.equal(f.calls.some(row=>row.endpoint==='industry-loads/create'&&row.payload.target.kind!=='existing'),false)
  await screenshot(page,'bundle-paused-copy-added','查看员工')
  const dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
  await configuration(page).click();await selectTemplateFile(dialog,'teloa.json')
  const scroll=await dialog.evaluate((node:HTMLElement)=>{node.scrollTop=node.scrollHeight;return node.scrollTop});assert.ok(scroll>0,'完整包实际滚到底部')
  const close=await dialog.getByRole('button',{name:'关闭',exact:true}).boundingBox();assert.ok(close&&close.y>=0&&close.y+close.height<=page.viewportSize().height,'滚到底部后关闭按钮仍在视口内')
  const output=process.env.TELOA_TEMPLATE_CORE_E2E_OUTPUT;if(output)await page.screenshot({path:join(output,'bundle-full-configuration-scrolled-1280x800.png')})
  await closeAndFocus(page,'接收模板文件')
  assert.deepEqual(f.unexpected,[]);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 })
})
