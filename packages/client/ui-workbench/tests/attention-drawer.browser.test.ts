import assert from 'node:assert/strict'
import test from 'node:test'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

test('真实需要你与概览保留部分来源提示、继续载入和原对象只读打开；关闭不采用草稿',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-work-attention-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {TaskPage} from '${client}TaskPage.tsx';import {WorkHome} from '${client}WorkHome.tsx';import {aggregateAttentionItems,openAttentionItem} from '${client}attention-item.ts';import {emptyTaskPreview} from '${client}task-preview.ts';
 import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import tokens from '${client}theme-tokens.module.css';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},noop=()=>{},preview=emptyTaskPreview();
 const directory={status:'ready',rows:[]},managed={baseline:true,ready:true,archived:[]},work={subscribe:()=>()=>{},getDirectorySnapshot:()=>directory},management={subscribe:()=>()=>{},getSnapshot:()=>managed},useSessions=select=>select({byId:{}});
 const digest='a'.repeat(64),occurredAt='2026-10-17T00:00:00.000Z',draftId='87654321-1234-4234-8234-123456789012';
 const rows=[
 {id:'business-change-set:opaque-change-id',kind:'error',reason:'business-change-stale',title:'opaque-change-id',scope:'SOC',occurredAt,source:{kind:'business-change-set',scope:'SOC',changeSetId:'opaque-change-id',revision:3,digest},basisHash:digest},
 {id:'business-sync:SOC:opaque-map-id',kind:'error',reason:'business-sync-failed',title:'opaque-map-id',scope:'SOC',occurredAt,source:{kind:'business-sync',scope:'SOC',mappingId:'opaque-map-id',runId:'run-1'},basisHash:digest},
 {id:'page-create-draft:'+draftId,kind:'review',reason:'page-create-draft-pending',title:'原员工草稿',occurredAt,source:{kind:'page-create-draft',entity:'role',draftId,bodyHash:digest},basisHash:digest}];
 const calls=[];function App(){const [state,set]=useState({loaded:false,loading:true,more:false});
 window.audit={calls,set,rows};const items=aggregateAttentionItems({tasks:[],taskAttention:[],workAttention:state.loaded?rows:[],handoffs:[],business:preview.business,continuous:preview.continuous,savedPlanIds:new Set(),bindings:[]},runtime.t);
 const actions={openTask:noop,openArtifact:noop,openGroup:noop,openMarket:noop,openIndustrySkill:noop,openBusiness:noop,openPlans:noop,openBinding:noop,openInstallation:noop,openWorkAttention:source=>calls.push({kind:'open',source})};
 const partial=state.loaded,more=state.more?()=>{calls.push({kind:'more'});set(value=>({...value,loading:true}))}:undefined;
 return <main className={tokens.tokens} id="teloa-main"><WorkHome visible current={undefined} work={work} management={management} useSessions={useSessions} workTasks={[]} colleagues={[]} conversationLinks={[]} open={noop} openTask={noop} openTasks={noop} plans={noop} attention={()=>calls.push({kind:'attention'})} attentionStatus={{count:items.length,known:false,incomplete:partial}} planStatus={{savedPlans:0,examplePlans:0,exampleRuns:0,directory:'ready'}}/>
 <TaskPage mode="attention" state={preview} attentionItems={items} attentionKnown={false} attentionLoading={state.loading} attentionMore={more} retryAttention={()=>calls.push({kind:'retry'})} selected={null} visible conversations={()=>null} openArtifacts={noop} openPlans={noop} openAttention={item=>openAttentionItem(item,actions)} select={noop} change={noop} switchMode={noop} openSource={noop} team={noop} openRole={noop} openBusiness={noop} saveTemplate={noop}/></main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'WorkAttentionTest',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port,browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const errors:string[]=[],external:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message))
 await page.route('**/*',(route:any)=>{if(route.request().url().startsWith(url+'/'))return route.continue();external.push(route.request().url());return route.abort()})
 await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.getByText('正在加载待办事项',{exact:true}).first().waitFor()
 assert.equal(await page.getByRole('heading',{name:'没有需要处理的事项',exact:true}).count(),0)
 await page.evaluate(()=>(window as any).audit.set({loaded:true,loading:false,more:true}))
 const draft=page.getByRole('button',{name:/原员工草稿/}).first();await draft.waitFor()
 assert.equal(await page.getByText('至少 3 项',{exact:true}).count(),2)
 assert.equal(await page.getByText('opaque-change-id',{exact:true}).count(),0);assert.equal(await page.getByText('opaque-map-id',{exact:true}).count(),0)
 assert.equal(await page.getByRole('button',{name:'重试',exact:true}).count(),1,'分页与来源读取不全并存时，重试入口仍可达')
 await page.getByRole('button',{name:'继续载入',exact:true}).click()
 assert.equal(await page.locator('[data-teloa-attention-arrow]').count(),3,'翻页在途保留原条目')
 await page.evaluate(()=>(window as any).audit.set({loaded:true,loading:false,more:false}))
 await page.getByRole('button',{name:'重试',exact:true}).click()
 assert.equal(await page.locator('[data-teloa-attention-arrow]').count(),3,'来源失败仍可重试，原条目保留')
 await draft.click();const dialog=page.getByRole('dialog',{name:'原员工草稿',exact:true});await dialog.waitFor()
 await page.getByText('原草稿等待你查看与确认，尚未采用。',{exact:true}).waitFor()
 await page.keyboard.press('Escape');assert.equal(await page.locator('dialog[open]').count(),0)
 assert.equal(await draft.evaluate((element:HTMLElement)=>element===document.activeElement),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).audit.calls),[{kind:'more'},{kind:'retry'}])
 await page.getByRole('button',{name:/打开.*原员工草稿/}).click()
 const calls=await page.evaluate(()=>(window as any).audit.calls)
 assert.deepEqual(calls[2],{kind:'open',source:{kind:'page-create-draft',entity:'role',draftId:'87654321-1234-4234-8234-123456789012',bodyHash:'a'.repeat(64)}})
 await page.setViewportSize({width:430,height:932})
 await page.getByRole('button',{name:'重试',exact:true}).waitFor();assert.equal(await page.locator('[data-teloa-attention-arrow]').count(),3)
 assert.deepEqual(errors,[]);assert.deepEqual(external,[])
})

test('待审批抽屉关闭不决定，意见保留；新版本重验影响，真实表单提交当前版本',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
 const temp=await mkdtemp(join(root,'.runtime-attention-drawer-'));t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
 import {TaskPage} from '${client}TaskPage.tsx';import {emptyTaskPreview} from '${client}task-preview.ts';import {SecurityDecisionActions} from '${client}SecurityDecisionActions.tsx';
 import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},noop=()=>{};
 const item={id:'security-action:a1',kind:'approval',source:'security-action',persistence:'saved',target:{kind:'security-action',taskId:'t1',actionId:'a1'},title:'隔离测试主机',reason:{kind:'text',text:'确认本次隔离的影响范围'},scope:'general',occurredAt:'2026-10-11T02:00:00.000Z'};
 function App(){const [items,setItems]=useState([item,{...item,id:'task:review',kind:'review',source:'task',target:{kind:'task',id:'review'},title:'核对测试报告'}]),[version,setVersion]=useState(3),[outcome,setOutcome]=useState();
 window.audit={calls:window.audit?.calls??[],setVersion,remove:()=>setItems(rows=>rows.filter(row=>row.id!==item.id))};
 const action={id:'a1',ownerId:'test-owner',taskId:'t1',version,state:'pending_approval',title:item.title,goal:'隔离 test-host',tool:'security.endpoint.isolate',riskTier:'high',reversible:'irreversible',targetSet:['test-host'],params:{},supersedesActionId:null,frozen:null,proposerId:'test-owner',playbookVersion:'1.0.0',createdAt:item.occurredAt,updatedAt:item.occurredAt};
 const panel={taskId:'t1',actions:[action],approvals:[],executions:[],proposal:{tools:[{tool:action.tool,allowedTargets:action.targetSet}]}},api={pending:()=>undefined,recoveryError:()=>undefined,decide:async(request)=>{window.audit.calls.push(request);setItems(rows=>rows.filter(row=>row.id!==item.id))},execute:async(request)=>{window.audit.calls.push({execute:request})}};
 return <main id="teloa-main" tabIndex={-1}><TaskPage mode="attention" state={emptyTaskPreview()} attentionItems={items} selected={null} visible={true} conversations={()=>null} openArtifacts={noop} openPlans={noop} openAttention={noop} select={noop} change={noop} switchMode={noop} openSource={noop} team={noop} openRole={noop} openBusiness={noop} saveTemplate={noop}
 decisionFacts={()=>({evidence:[],request:{title:'隔离 test-host',targets:['test-host']},risk:{riskTier:'high',reversible:'irreversible',targets:1}})}
 decisionActions={entry=>entry.id===item.id?<SecurityDecisionActions action={action} panel={panel} context={{panel}} attention={[]} known={true} api={api} reload={async()=>null} outcome={outcome} setOutcome={setOutcome} nextStep={false}/>:null}/></main>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);`)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'AttentionDrawerTest',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:960}});t.after(()=>page.close());page.setDefaultTimeout(3000)
 const server=createServer((_request,response)=>{response.setHeader('content-type','text/html');response.end('<!doctype html><html lang="zh-CN"><body style="margin:0"><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise<void>(resolve=>server.close(()=>resolve())))
 const url='http://127.0.0.1:'+(server.address() as {port:number}).port
 const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.request().url().startsWith(url+'/')?route.continue():route.abort())
 await page.goto(url);await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const trigger=page.getByRole('button',{name:/隔离测试主机/}).first(),other=page.getByRole('button',{name:/核对测试报告/}).first()
 const listPosition=await other.boundingBox();await trigger.click()
 const drawer=page.getByRole('dialog',{name:'隔离测试主机',exact:true});await drawer.waitFor()
 const box=await drawer.boundingBox();assert.ok(box);assert.equal(Math.round(box.x+box.width),1440)
 assert.deepEqual(await other.boundingBox(),listPosition,'原待办列表不因展开内容向下移动')
 const reason=drawer.getByRole('textbox'),impact=drawer.getByRole('checkbox')
 await reason.fill('确认仅隔离测试主机');await impact.check();await page.keyboard.press('Escape')
 assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await page.evaluate(()=>(window as any).audit.calls),[])
 assert.equal(await trigger.evaluate((element:HTMLElement)=>element===document.activeElement),true)
 await trigger.click();await drawer.waitFor();assert.equal(await reason.inputValue(),'确认仅隔离测试主机');assert.equal(await impact.isChecked(),false)
 await drawer.getByRole('button',{name:'关闭',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).audit.calls),[])
 assert.equal(await trigger.evaluate((element:HTMLElement)=>element===document.activeElement),true)
 await trigger.click();await drawer.waitFor();await page.mouse.click(20,20)
 assert.equal(await page.locator('dialog[open]').count(),0);assert.deepEqual(await page.evaluate(()=>(window as any).audit.calls),[])
 await trigger.click();await drawer.waitFor();assert.equal(await reason.inputValue(),'确认仅隔离测试主机')
 await impact.check();await page.evaluate(()=>(window as any).audit.setVersion(7))
 await page.waitForFunction(()=>(document.querySelector('dialog textarea') as HTMLTextAreaElement|null)?.value==='')
 assert.equal(await impact.isChecked(),false,'版本变化后的影响确认不能沿用')
 await reason.fill('已核对第七版范围');await impact.check();await drawer.getByRole('button',{name:'批准',exact:true}).click()
 await page.waitForFunction(()=>(window as any).audit.calls.length===1)
 const calls=await page.evaluate(()=>(window as any).audit.calls)
 assert.equal(calls[0].expectedActionVersion,7);assert.equal(calls[0].decision,'approved');assert.equal(calls[0].reason,'已核对第七版范围');assert.equal(calls[0].impactConfirmed,true)
 await page.waitForFunction(()=>!document.querySelector('dialog[open]'))
 assert.equal(await page.evaluate(()=>sessionStorage.getItem('teloa.attention-expanded/v1')),null,'完成事项不恢复旧抽屉')
 assert.deepEqual(errors,[])
})
