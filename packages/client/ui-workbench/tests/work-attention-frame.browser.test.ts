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
// 复用真实 Frame/store/BindingClient、WorkHome、TaskPage、来源详情和 CreateEntry。
// 无关市场/群/成果/计划页在组件边界隔离；原生会话输入仍为既有 slot 探针，网络回执全部合成。
const isolated=['WorkDirectory','MarketPage','TeamCapabilitiesPage','ResourceManager','CollaborationPage','ContinuousPage','ArtifactPanel','ProjectOverviewPage','CapabilityTargetPanel','SavedIndustryDirectory','AutoDreamSettingsPage']
let browser:any,script:string,styles:string,temp:string
const patch=(text:string,from:string,to:string)=>{assert.equal(text.split(from).length,2,from);return text.replace(from,to)}

before(async()=>{
 const source=await readFile(new URL('./business-builder-frame.test.ts',import.meta.url),'utf8'),ast=ts.createSourceFile('frame.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS)
 let node:ts.Expression|undefined
 const visit=(item:ts.Node)=>{if(ts.isVariableDeclaration(item)&&item.name.getText(ast)==='entry')node=item.initializer;ts.forEachChild(item,visit)};visit(ast);assert.ok(node)
 let entry=new Function('client','return '+node.getText(ast))(client) as string
 const setup=`
import {createWorkAttentionApi} from '${client}work-attention-api.ts';
import {createPageCreateApi} from '${client}page-create-api.ts';
import {createPlanDraftApi} from '${client}plan-draft-api.ts';
import {createBusinessDashboardApi} from '${client}business-dashboard-api.ts';
const first='10000000-0000-4000-8000-000000000001',second='10000000-0000-4000-8000-000000000002',changeId='10000000-0000-4000-8000-000000000003';
const a=f.attention={calls:[],generation:0,mode:'ok',settled:new Set(),created:[],listeners:new Set(),readAt:'2026-10-17T00:00:00.000Z'};
const body=id=>({name:id===first?'资料研究员甲':'资料研究员乙',kind:'employee',scopes:['general'],duty:'核对本轮资料',dataScope:'已分配资料',executionScope:'只读整理',skills:[],knowledge:[],responsibility:{triggers:['明确任务'],autonomousActions:['核对'],confirmationPoints:['外发'],escalationRules:['失败'],deliveryChecks:['完整']}});
const pageDraft=id=>({id,ownerId:'self',requestId:id,entity:'role',body:JSON.stringify(body(id)),bodyHash:'a'.repeat(64),title:id===first?'原草案甲':'原草案乙',status:a.settled.has(id)?'applied':'draft',...(a.settled.has(id)?{appliedRef:'created-'+id}:{}),createdAt:a.readAt,updatedAt:a.readAt});
const draftSource=id=>({kind:'page-create-draft',entity:'role',draftId:id,bodyHash:'a'.repeat(64)});
const changeSource={kind:'business-change-set',scope:'sales',changeSetId:changeId,revision:3,digest:'c'.repeat(64)},syncSource={kind:'business-sync',scope:'sales',mappingId:'orders',runId:'failed-orders'};
const attentionRow=(id,title,source,target,kind,reason)=>({id,title,source,target,kind,reason,...(source.scope?{scope:source.scope}:{}),basisHash:'d'.repeat(64),occurredAt:a.readAt});
const rowDraft=id=>attentionRow('draft:'+id,id===first?'原草案甲':'原草案乙',draftSource(id),{kind:'page-create-draft',draftId:id},'review','page-create-draft-pending');
const rowChange=attentionRow('change','待采用修改',changeSource,{kind:'business-change-set',scope:'sales',changeSetId:changeId},'approval','business-change-review');
const rowSync=attentionRow('sync','失败同步',syncSource,{kind:'business-sync',scope:'sales',mappingId:'orders'},'error','business-sync-failed');
a.items=[rowDraft(first),rowChange,rowSync];
props.workAttentionConnection={getSnapshot:()=>a.generation,subscribe:listener=>{a.listeners.add(listener);return()=>a.listeners.delete(listener)}};
props.workAttentionApi=createWorkAttentionApi(async(endpoint,input)=>{a.calls.push({endpoint,input});return {schema:'teloa.work-attention/v1',items:a.items.filter(row=>!a.settled.has(row.source.draftId)),incomplete:[]}});
props.pageCreateApi=createPageCreateApi(async(endpoint,input)=>{
 a.calls.push({endpoint,input});const id=input.draftId;
 if(endpoint==='page-create-drafts/read'){const row={...pageDraft(id),...(a.mode==='source-changed'?{bodyHash:'b'.repeat(64)}:{})};if(a.mode==='hold-read'){a.readPending=true;await new Promise(resolve=>a.releaseRead=()=>resolve())}return row};
 if(endpoint==='page-create-drafts/directory')return {schema:'teloa.page-create-drafts/v1',entity:'role',readAt:a.readAt,drafts:[pageDraft(first),pageDraft(second)]};
 if(endpoint==='page-create-drafts/preview')return {schema:'teloa.page-create-draft-preview/v1',draft:pageDraft(id),fields:[{path:'name',value:body(id).name}],fieldsTruncated:false,consequences:[],next:{endpoint:'roles/create',consentKeys:[]},computedAt:a.readAt};
 if(endpoint==='page-create-drafts/settle'){
  if(a.mode==='settle-unknown')throw Object.assign(Error('本次回执未知'),{code:'teloa/network'});
  if(a.mode==='hold-settle'){a.settlePending=true;await new Promise(resolve=>a.releaseSettle=resolve)}
  a.settled.add(id);return {schema:'teloa.page-create-drafts/v1',entity:'role',readAt:a.readAt,drafts:[pageDraft(first),pageDraft(second)]};
 }
 throw Error('Unexpected page-create endpoint: '+endpoint)
});
props.planDraftApi=createPlanDraftApi(async()=>{throw Error('员工原稿不得进入计划确认')});a.openOriginal=()=>props.planDraftApi.openDraft(pageDraft(first));a.replaceRoleApi=()=>{props.roleApi=new Proxy(props.roleApi,{});renderFrame()};
const oldRoles=props.roleApi;props.roleApi=new Proxy(oldRoles,{get:(target,key)=>key==='list'?async()=>a.created:key==='create'?async fields=>{a.calls.push({endpoint:'roles/create',fields});const id='created-'+(fields.name==='资料研究员甲'?first:second),row={...fields,id,ownerId:'self',state:'active',version:1,createdAt:a.readAt,updatedAt:a.readAt};a.created.push(row);return row}:Reflect.get(target,key)});
// 真实员工详情会复制资料API；须提供有自有方法的正式空目录，不能沿用空Proxy冒充。
props.resourceApi={directory:async()=>({drafts:[],resources:[]}),sources:async()=>[]};
const before={scope:'sales',type:'customer',id:'one',version:1,snapshotHash:'a'.repeat(64),title:'固定客户',source:'本地记录',observedAt:a.readAt,receivedAt:a.readAt,quality:'complete',summary:'原备注',fields:[{label:'备注',value:'原备注'}]};
const change=()=>({schema:'teloa.business-change-set/v1',id:changeId,scope:'sales',revision:3,digest:'c'.repeat(64),state:'draft',sessionId:'original-change-session',batch:{requestId:changeId,scope:'sales',operations:[{operation:'edit',type:'customer',id:'one',expectedVersion:1,fields:[{name:'note',value:'待审备注'}]}]},preview:{fingerprint:'b'.repeat(64),definitions:[],targets:[before],operations:[{operation:'edit',type:'customer',title:'固定客户',before,fields:[{name:'note',value:'待审备注'}]}]},createdAt:a.readAt,updatedAt:a.readAt});
props.attentionBusinessApi=createBusinessWorkResultsApi(async(endpoint,input)=>{a.calls.push({endpoint,input});if(endpoint==='business-changes/get')return change();if(endpoint==='business-changes/intent')return {sessionId:'original-change-session',text:'请求原生审批'};throw Error(endpoint)},{resume:async session=>a.calls.push({endpoint:'resume-original',session}),send:async(session,text)=>a.calls.push({endpoint:'send-original',session,text})});
const syncRun=id=>({id:id==='orders'?'failed-orders':'failed-other',scope:'sales',mappingId:id,startedAt:a.readAt,finishedAt:a.readAt,status:'failed',upserted:0,tombstoned:0,fetched:0,durationMs:1,trigger:'manual',error:{code:'teloa/dependency-unavailable',reason:'原失败'}});
props.businessDashboardApi=createBusinessDashboardApi(async(endpoint,input)=>{a.calls.push({endpoint,input});if(endpoint==='business-sync/status')return ['orders','other'].map(mappingId=>({mappingId,lastRun:syncRun(mappingId),consecutiveFailures:1,quota:{rows:0,limit:500000}}));if(endpoint==='business-sync/rules')return ['orders','other'].map(mappingId=>({scope:'sales',mappingId,title:mappingId==='orders'?'订单映射':'其他映射',definitionHash:'b'.repeat(64),enabled:false,revision:1,schedule:{kind:'every',seconds:300},running:false}));if(endpoint==='business-sync/runtime')return {scope:'sales',managed:true,syncEnabled:false,revision:1};if(endpoint==='business-sync/run'){const {error,...run}=syncRun(input.mappingId);return {...run,status:'ok'}};throw Error(endpoint)});
a.addNativeSources=()=>{for(const id of ['draft-source-A','draft-source-B']){const row={id:crypto.randomUUID(),ownerId:'self',title:id,scopeIds:['general'],version:1,status:'ready',requestedSessionId:id,sessionId:id,createdAt:a.readAt,requestId:crypto.randomUUID()};rows.set(id,row);byId[id]={...row,displayTitle:id}}};
a.nextGeneration=()=>{a.generation++;a.items=[rowDraft(second)];for(const listener of a.listeners)listener()};
`
 entry=patch(entry,"const frameRoot=",setup+"const frameRoot=")
 temp=await mkdtemp(join(root,'.runtime-work-attention-frame-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const stubbed=new Set(isolated.map(name=>join(client,name+'.tsx')))
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'isolate-unrelated-pages',enforce:'pre',load:async id=>{if(!stubbed.has(id))return;const text=await readFile(id,'utf8');return [...text.matchAll(/export (?:async )?(?:function|const|class) (\w+)/g)].map(match=>'export const '+match[1]+'=()=>null;').join('\n')}}],build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'WorkAttentionFrameFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function mount(t:TestContext){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(4000)
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));page.on('console',(message:any)=>{if(message.type()==='error')errors.push(message.text())});t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().isNavigationRequest()?route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><div id="root"></div></body></html>'}):route.abort())
 await page.goto('https://fixture.invalid');await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 await page.waitForFunction(()=>(window as any).frameFixture.controller.getSnapshot().status==='ready'&&document.querySelector('#teloa-main'))
 await page.evaluate(()=>(window as any).frameFixture.navigate('home'))
 await page.getByRole('button',{name:'一起处理',exact:true}).click()
 await page.getByRole('button',{name:'打开对象 原草案甲',exact:true}).waitFor()
 return page
}
const calls=(page:any,endpoint:string)=>page.evaluate((name:string)=>(window as any).frameFixture.attention.calls.filter((call:any)=>call.endpoint===name),endpoint)

test('真实WorkHome到需要你原草案，settle成功才关闭来源并打开新员工详情',async t=>{
 const page=await mount(t);await page.getByRole('button',{name:'打开对象 原草案甲',exact:true}).click()
 const source=page.getByRole('dialog');await source.getByText('资料研究员甲',{exact:true}).waitFor()
 assert.equal(await source.getByText('原草案乙',{exact:false}).count(),0)
 assert.deepEqual(await calls(page,'roles/create'),[]);assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
 await page.evaluate(()=>(window as any).frameFixture.attention.mode='hold-settle')
 await source.getByRole('button',{name:'确认',exact:true}).click();await page.waitForFunction(()=>(window as any).frameFixture.attention.settlePending)
 assert.equal(await source.isVisible(),true);assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().rolePreview),null)
 await page.evaluate(()=>(window as any).frameFixture.attention.releaseSettle())
 await page.waitForFunction(()=>(window as any).frameFixture.state().rolePreview?.id==='created-10000000-0000-4000-8000-000000000001')
 const created=page.getByRole('dialog',{name:'资料研究员甲',exact:true});await created.waitFor()
 await created.getByText('核对本轮资料',{exact:true}).waitFor()
 assert.equal((await calls(page,'page-create-drafts/settle')).length,1)
 assert.equal((await calls(page,'page-create-drafts/settle'))[0].input.expectedBodyHash,'a'.repeat(64))
 assert.equal(await page.getByRole('button',{name:'打开对象 原草案甲',exact:true}).count(),0)
})

test('真实TaskPage只打开固定业务修改和同步，不在目录读取时自动采用或运行',async t=>{
 const page=await mount(t)
 await page.getByRole('button',{name:'打开对象 业务修改',exact:true}).click()
 const change=page.getByRole('dialog');await change.getByText('固定客户',{exact:true}).first().waitFor()
 assert.deepEqual(await calls(page,'business-changes/intent'),[])
 await change.getByRole('button',{name:'请求采用',exact:true}).click();await change.waitFor({state:'hidden'})
 assert.deepEqual((await calls(page,'business-changes/intent')).map((call:any)=>call.input),[{changeSetId:'10000000-0000-4000-8000-000000000003',expectedRevision:3,expectedDigest:'c'.repeat(64)}])
 assert.deepEqual((await calls(page,'send-original')).map((call:any)=>call.session),['original-change-session'])
 await page.getByRole('button',{name:'打开对象 同步失败',exact:true}).click()
 const sync=page.getByRole('dialog');await sync.getByText('订单映射',{exact:true}).waitFor()
 assert.equal(await sync.getByText('其他映射',{exact:true}).count(),0);assert.deepEqual(await calls(page,'business-sync/run'),[])
 await sync.getByRole('button',{name:'立即同步',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.attention.calls.some((call:any)=>call.endpoint==='business-sync/run'))
 assert.deepEqual((await calls(page,'business-sync/run')).map((call:any)=>[call.input.scope,call.input.mappingId]),[['sales','orders']])
})

test('真实Frame未知落定或原来源hash改变不跳转、不自动重发；切代迟回不关新来源',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).frameFixture.attention.mode='settle-unknown')
 await page.getByRole('button',{name:'打开对象 原草案甲',exact:true}).click();const dialog=page.getByRole('dialog')
 await dialog.getByRole('button',{name:'确认',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().rolePreview),null);assert.equal((await calls(page,'page-create-drafts/settle')).length,1)
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 await page.evaluate(()=>(window as any).frameFixture.attention.mode='source-changed')
 await page.getByRole('button',{name:'打开对象 原草案甲',exact:true}).click();await dialog.getByRole('alert').waitFor()
 assert.equal(await dialog.getByRole('button',{name:'确认',exact:true}).count(),0);assert.equal((await calls(page,'roles/create')).length,1)
 await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'})
 await page.evaluate(()=>(window as any).frameFixture.attention.mode='hold-settle')
 await page.getByRole('button',{name:'打开对象 原草案甲',exact:true}).click();await dialog.getByRole('button',{name:'确认',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.attention.settlePending)
 await page.evaluate(()=>(window as any).frameFixture.attention.nextGeneration())
 await page.getByRole('button',{name:'打开对象 原草案乙',exact:true}).click();await dialog.getByText('资料研究员乙',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).frameFixture.attention.releaseSettle())
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await dialog.isVisible(),true);assert.equal(await dialog.getByText('资料研究员乙',{exact:true}).count(),1)
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.state().rolePreview),null)
 assert.equal((await calls(page,'page-create-drafts/settle')).length,2)
})


test('会话员工原稿桥复用真实Frame确认装配，固定原稿且明确确认后才创建一次',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>(window as any).frameFixture.attention.openOriginal())
 const source=page.getByRole('dialog');await source.getByText('资料研究员甲',{exact:true}).waitFor()
 if(process.env.TELOA_AUDIT_SCREENSHOTS)await page.screenshot({path:join(process.env.TELOA_AUDIT_SCREENSHOTS,'role-draft-frame-confirmation-fixed.png'),fullPage:true})
 assert.equal(await source.getByText('原草案乙',{exact:false}).count(),0)
 assert.deepEqual(await calls(page,'roles/create'),[]);assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
 await source.getByRole('button',{name:'确认',exact:true}).click()
 await page.waitForFunction(()=>(window as any).frameFixture.state().rolePreview?.id==='created-10000000-0000-4000-8000-000000000001')
 assert.equal((await calls(page,'roles/create')).length,1)
 assert.deepEqual((await calls(page,'page-create-drafts/settle')).map((r:any)=>[r.input.draftId,r.input.expectedBodyHash,r.input.appliedRef]),[['10000000-0000-4000-8000-000000000001','a'.repeat(64),'created-10000000-0000-4000-8000-000000000001']])
})


test('会话员工原稿读取中更换角色API，旧结果不得打开新本人的确认',async t=>{
 const page=await mount(t)
 await page.evaluate(()=>{const a=(window as any).frameFixture.attention;a.mode='hold-read';a.openOriginal()})
 await page.waitForFunction(()=>(window as any).frameFixture.attention.readPending)
 await page.evaluate(()=>(window as any).frameFixture.attention.replaceRoleApi())
 await page.evaluate(()=>(window as any).frameFixture.attention.releaseRead())
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 assert.equal(await page.getByRole('dialog').count(),0)
 assert.deepEqual(await calls(page,'roles/create'),[]);assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
})


test('原稿桥读取中从原生A切到B，旧A迟答不得在B弹出员工确认',async t=>{
 const page=await mount(t)
 const before=await page.evaluate(async()=>{const f=(window as any).frameFixture;f.attention.addNativeSources();await f.select('draft-source-A');f.navigate('messages');return [f.state().view,f.state().detail,f.state().rolePreview,f.state().messageMode]})
 assert.equal(await page.evaluate(()=>(window as any).frameFixture.current()),'draft-source-A')
 await page.evaluate(()=>{const a=(window as any).frameFixture.attention;a.mode='hold-read';a.openOriginal()})
 await page.waitForFunction(()=>(window as any).frameFixture.attention.readPending)
 const after=await page.evaluate(async()=>{const f=(window as any).frameFixture;await f.select('draft-source-B');return [f.state().view,f.state().detail,f.state().rolePreview,f.state().messageMode]})
 assert.deepEqual(after,before,'A/B切换没有改变旧守卫跟踪的view/detail/rolePreview')
 await page.evaluate(()=>{const a=(window as any).frameFixture.attention;a.mode='ok';a.releaseRead()})
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))
 const actual=await page.evaluate(()=>({native:(window as any).frameFixture.current(),dialogs:[...document.querySelectorAll('dialog[open]')].map(node=>node.textContent)}))
 assert.equal(actual.native,'draft-source-B')
 assert.deepEqual(actual.dialogs,[],'旧A回包不能在B打开原稿确认：'+JSON.stringify(actual))
 assert.deepEqual(await calls(page,'roles/create'),[]);assert.deepEqual(await calls(page,'page-create-drafts/settle'),[])
})
