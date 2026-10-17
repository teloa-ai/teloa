import assert from 'node:assert/strict'
import {test,before,after,type TestContext} from 'node:test'
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
import ts from 'typescript'
// @ts-expect-error 复用既有无声明的无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const isolated=['WorkDirectory','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
let browser:any,script:string,styles:string,temp:string
before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined
 const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 const setup=`
import {createPageCreateApi} from '${client}page-create-api.ts';
import {createPlanDraftApi} from '${client}plan-draft-api.ts';
const id='10000000-0000-4000-8000-000000000001',planId='20000000-0000-4000-8000-000000000001';
const a=f.planDraft={calls:[],generation:0,listeners:new Set(),openListeners:new Set(),intent:startup.planIntent||'save-paused',settled:false,mode:'ok'};
const workConfig={completion:{kind:'manual'},triggers:[{kind:'schedule',schedule:{kind:'schedule',cadence:'daily',weekday:1,time:'11:00',timezone:'Asia/Singapore'}}],budget:{maxGoalRounds:4,maxTokens:10000,maxElapsedMs:600000,maxConcurrent:1,maxRetries:1,stagnationRounds:2,money:null},overlap:'forbid',missed:'coalesce',safeRecovery:false};
const body=()=>startup.configure?{kind:'configure-work',planId,expectedVersion:1,expectedConfigVersion:1,work:workConfig,intent:a.intent}:{definition:{executor:{kind:'owner'},roleId:null,title:'本人每日核对',goal:'整理已授权资料',scope:'general',dataScope:'已选资料',delivery:'待办与来源',trigger:workConfig.triggers[0].schedule,notificationPolicy:'attention'},work:workConfig,intent:a.intent,source:{artifactId:planId,version:1,basisHash:'e'.repeat(64)}};
const planRecord=()=>({id,ownerId:'local:teloa-owner',requestId:id,entity:'plan',body:JSON.stringify(body()),bodyHash:'a'.repeat(64),title:'本人每日核对',status:a.settled?'applied':'draft',...(a.settled?{appliedRef:planId}:{}),createdAt:stamp,updatedAt:stamp});
const source={kind:'page-create-draft',entity:'plan',draftId:id,bodyHash:'a'.repeat(64)};
a.source=source;a.draft=planRecord;a.id=id;a.planId=planId;
props.workAttentionConnection={getSnapshot:()=>a.generation,subscribe:listener=>{a.listeners.add(listener);return()=>a.listeners.delete(listener)}};
props.workAttentionApi={list:async()=>({schema:'teloa.work-attention/v1',items:a.settled?[]:[{id:'draft:'+id,title:'本人每日核对',source,target:{kind:'page-create-draft',draftId:id},kind:'review',reason:'page-create-draft-pending',basisHash:'d'.repeat(64),occurredAt:stamp}],incomplete:[]})};
props.pageCreateApi=createPageCreateApi(async(endpoint,input)=>{
 a.calls.push([endpoint,input]);
 if(endpoint==='page-create-drafts/read')return {...planRecord(),...(a.mode==='foreign'?{ownerId:'other-owner'}:a.mode==='changed'?{bodyHash:'b'.repeat(64)}:{})};
 if(endpoint==='page-create-drafts/directory')return {schema:'teloa.page-create-drafts/v1',entity:'plan',readAt:stamp,drafts:[planRecord()]};
 if(endpoint==='page-create-drafts/preview')return {schema:'teloa.page-create-draft-preview/v1',draft:planRecord(),fields:[{path:'intent',value:a.intent}],fieldsTruncated:false,consequences:[],next:{endpoint:'page-create-plans/confirm',consentKeys:[]},computedAt:stamp};
 if(endpoint==='page-create-drafts/settle'){if(a.mode==='unknown')throw Object.assign(Error(),{code:'teloa/network'});if(a.mode==='hold-settle')await new Promise(resolve=>a.releaseSettle=resolve);a.settled=true;return {schema:'teloa.page-create-drafts/v1',entity:'plan',readAt:stamp,drafts:[planRecord()]}}
 throw Error(endpoint);
});
props.planDraftApi=createPlanDraftApi(async(endpoint,input)=>{a.calls.push(['page-create-plans/confirm',input]);if(a.mode==='hold-confirm')await new Promise(resolve=>a.releaseConfirm=resolve);return {schema:'teloa.plan-draft-confirmation/v1',draftId:id,bodyHash:'a'.repeat(64),planId,state:a.intent==='save-paused'?'paused':'active',version:2,configVersion:2}});
a.openOriginal=value=>props.planDraftApi.openDraft(value||planRecord());
a.nextGeneration=()=>{a.generation++;for(const listener of a.listeners)listener()};
const oldRefresh=props.conversationPlans.refresh;props.conversationPlans.refresh=async()=>{a.calls.push(['plans-refresh']);return oldRefresh()};
`
 const marker="createRoot(document.getElementById('root')).render"
 assert.equal(entry.split(marker).length,2);entry=entry.replace(marker,setup+marker)
 entry=entry.replace("createRoot(document.getElementById('root')).render", "const planRoot=createRoot(document.getElementById('root'));const renderPlanFrame=()=>planRoot.render")
 entry=entry.replace("void controller.connect({});", "f.replacePlanApi=()=>{props.planDraftApi={...props.planDraftApi,confirm:async()=>{throw Error('New API must not receive old confirmation')}};renderPlanFrame()};renderPlanFrame();void controller.connect({});")

 temp=await mkdtemp(join(root,'.runtime-plan-draft-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubs=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubs.has(id))return;const text=await readFile(id,'utf8');return [...text.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'PlanDraftFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:TestContext,startup:Record<string,unknown>={}){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(3500)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('https://fixture.invalid');await page.evaluate((value:Record<string,unknown>)=>(window as any).frameStartup=value,startup)
 await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main'))
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'))
 await page.getByRole('button',{name:'一起处理',exact:true}).click()
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).waitFor()
 return page
}
const calls=(page:any,name:string)=>page.evaluate((endpoint:string)=>(window as any).frameFixture.planDraft.calls.filter((call:any)=>call[0]===endpoint),name)
test('计划原草案只在本人明确保存后确认，settle成功才刷新和打开计划',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'保存计划',exact:true}).waitFor()
 assert.deepEqual(await calls(page,'page-create-plans/confirm'),[])
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 await page.evaluate(()=>(window as any).frameFixture.planDraft.mode='hold-settle')
 await dialog.getByRole('button',{name:'保存计划',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.planDraft.releaseSettle)
 assert.notEqual(await page.evaluate(()=>(window as any).frameFixture.state().view),'plans')
 assert.deepEqual((await calls(page,'page-create-plans/confirm')).map((call:any)=>call[1]),[{draftId:'10000000-0000-4000-8000-000000000001',expectedBodyHash:'a'.repeat(64)}])
 await page.evaluate(()=>(window as any).frameFixture.planDraft.releaseSettle())
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='plans')
 assert.equal((await calls(page,'page-create-drafts/settle')).length,1)
 assert.ok((await calls(page,'plans-refresh')).length>0)
 assert.deepEqual(await page.evaluate(()=>(window as any).frameFixture.sent),[])
})

test('保存并启用使用原意图；落定未知保原对象且不自动确认第二次',async t=>{
 const page=await mount(t,{planIntent:'create-and-enable'})
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'保存并启用',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.planDraft.mode='unknown')
 await dialog.getByRole('button',{name:'保存并启用',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.notEqual(await page.evaluate(()=>(window as any).frameFixture.state().view),'plans')
 assert.equal((await calls(page,'page-create-plans/confirm')).length,1);assert.equal((await calls(page,'page-create-drafts/settle')).length,1)
 await page.evaluate(()=>(window as any).frameFixture.planDraft.mode='ok')
 await dialog.getByRole('button',{name:'重新读取',exact:true}).click()
 await dialog.getByRole('button',{name:'保存并启用',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='plans')
 assert.equal((await calls(page,'page-create-plans/confirm')).length,2)
 assert.ok((await calls(page,'page-create-plans/confirm')).every((call:any)=>call[1].expectedBodyHash==='a'.repeat(64)))
})
test('本人连接切代时旧确认ACK不落定、不关闭新来源或抢导航',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 const dialog=page.getByRole('dialog');await page.evaluate(()=>(window as any).frameFixture.planDraft.mode='hold-confirm')
 await dialog.getByRole('button',{name:'保存计划',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.planDraft.releaseConfirm)
 await page.evaluate(()=>(window as any).frameFixture.planDraft.nextGeneration())
 await dialog.waitFor({state:'hidden'})
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 await dialog.getByRole('button',{name:'保存计划',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.planDraft.releaseConfirm())
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await dialog.getByRole('button',{name:'保存计划',exact:true}).isEnabled(),true)
 assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
 assert.notEqual(await page.evaluate(()=>(window as any).frameFixture.state().view),'plans')
})
test('原会话对象请求先正式回读owner/hash，错误来源不打开也不采用',async t=>{
 const page=await mount(t)
 for(const mode of ['foreign','changed']){
  await page.evaluate((value:string)=>{const a=(window as any).frameFixture.planDraft;a.mode=value;a.openOriginal()},mode)
  await page.getByRole('alert').first().waitFor()
  assert.equal(await page.getByRole('dialog').count(),0)
 }
 await page.evaluate(()=>{const a=(window as any).frameFixture.planDraft;a.mode='ok';a.openOriginal()})
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'保存计划',exact:true}).waitFor()
 assert.deepEqual(await calls(page,'page-create-plans/confirm'),[])
 await dialog.getByRole('button',{name:'保存计划',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().view==='plans')
})

test('同对象仅换计划API也隔离旧确认，原选择和新读取保持可操作',async t=>{
 const page=await mount(t);await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 const dialog=page.getByRole('dialog');await page.evaluate(()=>(window as any).frameFixture.planDraft.mode='hold-confirm')
 await dialog.getByRole('button',{name:'保存计划',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.planDraft.releaseConfirm)
 await page.evaluate(()=>(window as any).frameFixture.replacePlanApi())
 await dialog.getByRole('button',{name:'保存计划',exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.planDraft.releaseConfirm())
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await dialog.getByRole('button',{name:'保存计划',exact:true}).isEnabled(),true)
 assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
 assert.notEqual(await page.evaluate(()=>(window as any).frameFixture.state().view),'plans')
})

test('原active计划配置草案只说保存配置，不把save-paused意图冒成已暂停状态',async t=>{
 const page=await mount(t,{configure:true})
 await page.getByRole('button',{name:'打开对象 本人每日核对',exact:true}).click()
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'保存配置',exact:true}).waitFor()
 assert.equal(await dialog.getByText('保存后暂停',{exact:false}).count(),0)
 assert.deepEqual(await calls(page,'page-create-plans/confirm'),[])
})
