import assert from 'node:assert/strict'
import {test,before,after} from 'node:test'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有测试浏览器夹具为无声明的 MJS 模块。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessBuilderDirectory} from '${client}BusinessBuilderDirectory.tsx';
import {BusinessBuilderPanel} from '${client}BusinessBuilderPanel.tsx';
import {BusinessBuilderFlow} from '${client}business-builder-flow.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
const locale=document.documentElement.lang,en=locale==='en',snapshot={locale,dshLocale:locale,revision:1};
const runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const fixture=window.builderFixture={calls:[],opened:[],failPage:false,lost:false,revision:1,holdSave:false};
fixture.theme=dark=>{for(const [key,value] of Object.entries(prototypeThemes[dark?'dark':'light']))document.body.style.setProperty(key,value)};
let journal=null,setupJournal=null,receipt=null,releaseSave;fixture.releaseSave=()=>releaseSave?.();
const pages=[{kind:'records',id:'a',title:en?'Requests':'服务工单',objectType:'ticket',fields:[],allowCreate:true,allowEdit:true,allowArchive:true},{kind:'records',id:'b',title:en?'Follow-up':'后续跟进',objectType:'ticket',fields:[],allowCreate:true,allowEdit:true,allowArchive:true}];
const definition={format:'teloa.business-object-type/v1',domain:'sales',id:'ticket',version:'1.0.0',sourceId:'records',title:'Ticket',unit:'条',lead:'',fields:[]};
let draft={ownerId:'owner',id:'12345678-1234-4234-8234-123456789012',scope:'sales',revision:1,baseVersion:0,status:'draft',hash:'a'.repeat(64),createdAt:'2026-09-29T00:00:00.000Z',updatedAt:'2026-09-29T00:00:00.000Z',candidate:{format:'teloa.business-configuration/v1',scope:'sales',title:en?'Customer care':'客户服务',sources:[],definitions:[],pages:[]}};
let binding={kind:'builder',requestId:'12345678-1234-4234-8234-123456789013',title:'新业务',draftId:draft.id,sessionId:'native-session',createdAt:draft.createdAt,updatedAt:draft.updatedAt};
const api={byRequest:async input=>{fixture.calls.push('by-request:'+input.requestId);return binding},reserve:async input=>{fixture.calls.push('reserve:'+input.requestId);return binding},bind:async input=>{fixture.calls.push('bind:'+input.requestId);binding={...binding,sessionId:input.sessionId};return binding},bySession:async()=>binding,draft:async()=>{fixture.calls.push('draft');draft={...draft,revision:fixture.revision,hash:(fixture.revision===1?'a':'b').repeat(64)};return draft},preview:async input=>{fixture.calls.push('preview:'+input.expectedRevision);return {draftId:draft.id,revision:input.expectedRevision,candidateHash:draft.hash,baseVersion:0,dependencyHash:draft.hash,receipt:draft.hash,changes:{rows:[],truncated:false},issues:[]}},page:async input=>{fixture.calls.push('page:'+input.pageId+':'+input.expectedRevision);if(fixture.failPage)throw Object.assign(Error('private scope/internal id'),{code:'teloa/invalid-input'});return {mode:'preview',scope:'sales',configurationHash:draft.hash,draftId:draft.id,revision:input.expectedRevision,page:{kind:'records',definition:pages.find(p=>p.id===input.pageId),objectType:definition,emptyState:'no-records'}}},apply:async input=>{fixture.calls.push('apply');if(fixture.holdSave)await new Promise(resolve=>{releaseSave=resolve});receipt={scope:'sales',version:1,configurationHash:draft.hash,requestId:input.requestId};if(fixture.lost)throw Error('internal request secret');return receipt},receipt:async()=>{fixture.calls.push('receipt');return receipt}};
let showDirectory=false;fixture.directory=()=>{showDirectory=true;render()};
api.list=async()=>({items:draft.status==='discarded'?[]:[{binding,draft:{id:draft.id,title:draft.candidate.title,scope:draft.scope,revision:draft.revision,status:draft.status,updatedAt:draft.updatedAt}}]});
api.discard=async input=>{fixture.calls.push('discard:'+input.expectedRevision);if(fixture.holdDiscard)await new Promise(resolve=>{fixture.releaseDiscard=resolve});if(draft.status!=='discarded')draft={...draft,status:'discarded',revision:draft.revision+1};if(fixture.loseDiscard){fixture.loseDiscard=false;throw Error('private discard details')};return draft};
let plan=null;
api.setupPlan=async()=>plan;
api.setupPreview=async input=>{fixture.calls.push('setup-preview');plan={...plan,revision:plan.revision+1,rejected:input.rejected};return {draftId:draft.id,revision:plan.revision,digest:'c'.repeat(64),receipt:'d'.repeat(64),configurationReceipt:draft.hash,configurationRevision:draft.revision,baseVersion:0,rejected:input.rejected,blocked:false,changes:[{id:'field:ticket:date',entity:'field',label:en?'Ticket · Release date':'工单 · 上线日期',before:null,after:{label:'上线日期',type:'datetime',required:false}},{id:'role:operator',entity:'role',label:en?'Reviewer · Duties':'质检员 · 职责',before:{duty:'核对'},after:{duty:'核对上线'}}]}};
api.setupApply=async input=>{fixture.calls.push('setup-apply');const adoption={requestId:input.requestId,configuration:{scope:'sales',version:1,configurationHash:draft.hash,requestId:input.requestId},roleIds:[],contentId:plan.contentId,contentHash:plan.contentHash,steps:plan.resources.map(r=>({id:r.id,kind:r.kind,title:r.title,state:'pending'}))};plan={...plan,state:'applied',adoption};draft={...draft,status:'applied'};return adoption};
api.setupPrepare=async input=>{fixture.calls.push(input.expectedDigest?'setup-prepare-confirmed':'setup-prepare-read');plan={...plan,adoption:{...plan.adoption,loadId:'12345678-1234-4234-8234-123456789088',steps:plan.resources.map(r=>({id:r.id,kind:r.kind,title:r.title,state:r.kind==='mcp'?'needs-user':input.expectedDigest?'done':'pending'}))}};return plan};
api.setupReadiness=async()=>({digest:'e'.repeat(64),rows:plan.resources.map(r=>({itemInstanceId:r.id,kind:r.kind,title:r.title,state:r.kind==='mcp'?'needs-user':'auto'}))});
const makeFlow=()=>new BusinessBuilderFlow({api,work:{create:async options=>{if(!fixture.pending)throw Error('unexpected native create');fixture.calls.push('native-create:'+options.requestId);await options.beforeOpen({sessionId:'native-session'});fixture.pending=false;return {sessionId:'native-session'}}},storage:{getItem:key=>key.endsWith('/setup-apply')?setupJournal:journal,setItem:(key,value)=>{if(key.endsWith('/setup-apply'))setupJournal=value;else journal=value},removeItem:key=>{if(key.endsWith('/setup-apply'))setupJournal=null;else journal=null}},journalKey:'builder-panel-test',id:()=> '12345678-1234-4234-8234-123456789099',refreshScopes:async()=>{},switching:{read:()=>({mainSessionId:'native-session',bindingSessionId:'native-session',bindingReady:true,input:{draft:'',draftRev:0,phase:'plain',attachmentIds:[],occurrences:[],queue:[]},pendingSubmissions:[],monitor:undefined})}});
let flow=makeFlow();fixture.rebuild=()=>{flow=makeFlow();render()};
fixture.load=async(empty=false)=>{draft={...draft,candidate:{...draft.candidate,pages:empty?[]:pages,...(empty?{}:{homePageId:'a'})}};await flow.restoreSession('native-session')};
fixture.serverPending=async()=>{fixture.pending=true;const {sessionId,...reservation}=binding;binding=reservation;await flow.restoreSession('native-session')};
fixture.completePlan=async()=>{await fixture.load();plan={format:'teloa.business-setup-plan/v1',draftId:draft.id,scope:'sales',revision:1,configurationRevision:draft.revision,configurationHash:draft.hash,contentId:'12345678-1234-4234-8234-123456789077',contentHash:'b'.repeat(64),title:draft.candidate.title,description:en?'Review tickets and prepare a daily summary.':'核对客户工单，整理每日摘要。',roleEdits:[],rejected:[],state:'draft',updatedAt:draft.updatedAt,resources:[{id:'operator',kind:'role',title:en?'Ticket reviewer':'工单审核员',version:'1.0.0',description:en?'Review ticket urgency.':'核对工单优先级。'},{id:'work',kind:'work-template',title:en?'Review tickets':'核对工单',version:'1.0.0',description:en?'Follow the existing review method.':'依照工作模板核对未结工单。'},{id:'mail',kind:'mcp',title:en?'Support connection':'客服连接',version:'1.0.0',description:en?'Requires your authorization.':'需要本人另行连接与授权。'},{id:'daily',kind:'plan',title:en?'Daily review':'每日核对',version:'1.0.0',description:en?'Save paused.':'保存后保持暂停。'}]};await flow.refreshSetupPlan()};
fixture.leave=()=>{void flow.requestLeave().then(value=>{fixture.leaveResult=value})};
fixture.corruptSetup=()=>{setupJournal='{broken';render()};
fixture.snapshot=()=>flow.getSnapshot();fixture.refreshDraft=()=>flow.refreshDraft();
const app=createRoot(document.getElementById('root'));const render=()=>app.render(<I18nProvider runtime={runtime}><main className={tokens.tokens}>{showDirectory?<BusinessBuilderDirectory flow={flow} open={()=>{fixture.opened.push('builder')}}/>:<BusinessBuilderPanel flow={flow} renderPage={projection=><article data-page={projection.page.definition.id}><h3>{projection.page.definition.title}</h3><p>{en?'No records yet':'还没有记录'}</p></article>} onOpenSaved={result=>fixture.opened.push(result)}/> }</main></I18nProvider>);
render();fixture.load(true);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-builder-panel-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'BuilderPanelFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built
 assert.ok(bundle&&'output' in bundle)
 const output=bundle.output;script=output.find(item=>item.type==='chunk')!.code;styles=output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')+'body{margin:0;background:var(--teloa-background);color:var(--teloa-text);font-family:var(--teloa-design-font)}main{padding:16px}'
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-builder-panel',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
test('隐藏父容器时离开确认仍可见，Escape回原入口且不放弃草案',async t=>{
 const page=await browser.newPage({viewport:{width:390,height:900}});page.setDefaultTimeout(3000);t.after(()=>page.close());await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><button id="leave-origin">导航入口</button><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.evaluate(()=>(window as any).builderFixture.completePlan())
 await page.locator('#leave-origin').focus();await page.evaluate(()=>{document.querySelector('main')!.style.display='none';(window as any).builderFixture.leave()})
 await page.getByRole('dialog',{name:'业务还在搭建中',exact:true}).waitFor();await page.keyboard.press('Escape')
 assert.equal(await page.getByRole('dialog').count(),0);assert.equal(await page.locator('#leave-origin').evaluate((node:HTMLElement)=>node===document.activeElement),true)
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.leaveResult),false);assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.some((x:string)=>x.startsWith('discard:'))),false)
})
for(const locale of ['zh-CN','en'])test(locale+' 完整方案逐项复核、明确采用、分阶段准备及保留草案离开',async t=>{
 const page=await browser.newPage({viewport:{width:390,height:1100}});page.setDefaultTimeout(5000);t.after(()=>page.close());await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="'+locale+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.evaluate(()=>(window as any).builderFixture.completePlan())
 const en=locale==='en',button=(zh:string,english:string)=>page.getByRole('button',{name:en?english:zh,exact:true})
 await page.getByRole('heading',{name:en?'Business plan':'完整业务方案',exact:true}).waitFor()
 assert.equal(await button('保存业务','Save business').count(),0)
 await page.evaluate(()=>(window as any).builderFixture.leave());await page.getByRole('dialog').waitFor();await button('继续搭建','Continue building').click();assert.equal(await page.evaluate(()=>(window as any).builderFixture.leaveResult),false)
 await page.evaluate(()=>(window as any).builderFixture.leave());await button('保留草案离开','Keep draft and leave').click();assert.equal(await page.evaluate(()=>(window as any).builderFixture.leaveResult),true)
 await button('复核完整方案','Review plan').click();await button('拟采纳 · 改为拒绝','Accept · reject').first().click();await button('已拒绝 · 改为采纳','Rejected · accept').waitFor()
 await page.locator('summary').first().click();await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-390-plan-review.png',fullPage:true})
 await button('采用已选变更','Apply selected changes').click();await button('读取资源准备清单','Read preparation checklist').waitFor()
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.filter((x:string)=>x==='apply').length),0)
 await button('读取资源准备清单','Read preparation checklist').click();assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.includes('setup-prepare-confirmed')),false)
 await button('确认准备资源','Confirm preparation').click();await page.getByText(en?'Needs your attention':'需要本人处理',{exact:true}).first().waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-390-plan-prepared.png',fullPage:true})
})
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 面板串行预览、旧内容归属、固定保存核对与键盘操作',async t=>{
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(5000)
 const errors:string[]=[],requests:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()});t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="'+locale+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:'*{box-sizing:border-box}body{margin:0;font-family:system-ui;background:var(--teloa-background)}main{max-width:1000px;margin:auto;padding:24px}'+styles});await page.addScriptTag({content:script})
 const en=locale==='en',button=(zh:string,english:string)=>page.getByRole('button',{name:en?english:zh,exact:true}),save=button('保存业务','Save business'),refresh=button('刷新预览','Refresh preview')
 await page.getByText(en?'Describe the business you want to build in the conversation.':'在对话中描述你想搭建的业务。',{exact:true}).waitFor();assert.equal(await page.locator('input,textarea').count(),0);assert.equal(await save.isDisabled(),true)
 assert.deepEqual(await page.evaluate(()=>(window as any).builderFixture.calls),['draft']);await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-'+width+'-empty.png',fullPage:true})
 await page.evaluate(()=>(window as any).builderFixture.load());await refresh.focus();await page.keyboard.press('Enter');await page.locator('[data-page=a]').waitFor();assert.equal(await save.isEnabled(),true)
 assert.deepEqual((await page.evaluate(()=>(window as any).builderFixture.calls)).slice(-3),['draft','preview:1','page:a:1'])
 await page.evaluate(()=>{(window as any).builderFixture.failPage=true});await button('后续跟进','Follow-up').click();await page.getByRole('alert').waitFor();assert.equal(await save.isDisabled(),true);assert.equal(await page.locator('[data-page=a]').count(),1)
 await page.getByText(en?'Previous preview: Customer care · Requests':'上次预览：客户服务 · 服务工单',{exact:true}).waitFor();assert.equal(await page.getByText('private scope/internal id').count(),0)
 await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-'+width+'-stale.png',fullPage:true})
 await page.evaluate(async()=>{(window as any).builderFixture.failPage=false;(window as any).builderFixture.revision=2;await (window as any).builderFixture.refreshDraft()});assert.equal(await save.isDisabled(),true);await refresh.click();await page.locator('[data-page=b]').waitFor()
 assert.deepEqual((await page.evaluate(()=>(window as any).builderFixture.calls)).slice(-3),['draft','preview:2','page:b:2'])
 await page.evaluate(()=>{(window as any).builderFixture.lost=true;(window as any).builderFixture.holdSave=true});await save.click();await page.getByText(en?'Saving business…':'正在保存业务…',{exact:true}).waitFor();assert.equal(await refresh.isDisabled(),true);assert.equal(await button('核对保存结果','Check save result').isDisabled(),true);await page.evaluate(()=>(window as any).builderFixture.releaseSave());await button('核对保存结果','Check save result').waitFor();assert.equal(await save.count(),0);assert.equal(await refresh.isDisabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.snapshot().binding.sessionId),'native-session');await page.evaluate(()=>(window as any).builderFixture.rebuild());await page.locator('button:not([disabled])').filter({hasText:en?'Check save result':'核对保存结果'}).waitFor();assert.equal(await button('核对保存结果','Check save result').isEnabled(),true)
 await button('核对保存结果','Check save result').click();await button('打开业务','Open business').click();assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.filter((x:string)=>x==='apply').length),1);assert.equal(await page.evaluate(()=>(window as any).builderFixture.opened[0].scope),'sales')
 assert.equal(await page.locator('body').innerText().then((text:string)=>text.includes('internal request secret')),false)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-'+width+'-saved.png',fullPage:true})
})


test('服务端预约未绑定且本地journal已丢失：现有恢复按钮显式按固定request恢复，不挂在核对中',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close())
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.evaluate(()=>(window as any).builderFixture.serverPending())
 const restore=page.getByRole('button',{name:'恢复搭建会话',exact:true})
 await restore.waitFor();assert.equal(await restore.isEnabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.some((x:string)=>x.startsWith('native-create:'))),false)
 await restore.click();await page.waitForFunction(()=>(window as any).builderFixture.snapshot().binding?.sessionId==='native-session')
 const calls=await page.evaluate(()=>(window as any).builderFixture.calls)
 assert.equal(calls.filter((x:string)=>x==='native-create:12345678-1234-4234-8234-123456789013').length,1)
 assert.equal(calls.filter((x:string)=>x==='bind:12345678-1234-4234-8234-123456789013').length,1)
 assert.equal(await restore.count(),0)
})

test('目录中未绑定预约仍可确认放弃，无需新建会话',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close())
 await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.evaluate(async()=>{const f=(window as any).builderFixture;await f.serverPending();f.directory()})
 const discard=page.getByRole('button',{name:'放弃草案',exact:true});await discard.waitFor();assert.equal(await discard.isEnabled(),true)
 await discard.click();await page.getByRole('button',{name:'确认放弃',exact:true}).click()
 await page.getByText('已放弃搭建草案，会话与历史已保留。',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.some((x:string)=>x.startsWith('native-create:'))),false)
 assert.equal(await discard.count(),0)
})

for(const directory of [false,true])for(const dark of [false,true])test((dark?'深色':'浅色')+(directory?'目录':'面板')+'放弃草案须确认；取消不写入，失回包重试不重复采用，刷新读取退役结果',async t=>{
 const page=await browser.newPage({viewport:{width:430,height:960}});page.setDefaultTimeout(5000);t.after(()=>page.close())
 const errors:string[]=[];page.on('pageerror',(e:Error)=>errors.push(e.message))
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><div id="root"></div></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.evaluate(async(directory:boolean)=>{await (window as any).builderFixture.load();if(directory)(window as any).builderFixture.directory()},directory)
 await page.evaluate((dark:boolean)=>(window as any).builderFixture.theme(dark),dark)
 const discard=page.getByRole('button',{name:'放弃草案',exact:true})
 await discard.click();const confirm=page.getByRole('dialog',{name:'放弃搭建草案',exact:true});await confirm.waitFor()
 if(directory)assert.equal(await discard.evaluate((el:HTMLElement)=>getComputedStyle(el).borderTopWidth),'0px','确认层不改变原目录动作样式')
 if(process.env.TELOA_DISCARD_EVIDENCE)await page.screenshot({path:process.env.TELOA_DISCARD_EVIDENCE+(directory?'/directory':'/panel')+(dark?'-dark':'')+'-confirm.png',fullPage:true})
 await confirm.getByRole('button',{name:'取消',exact:true}).click()
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.some((c:string)=>c.startsWith('discard:'))),false)
 await discard.click();await page.evaluate(()=>{const f=(window as any).builderFixture;f.holdDiscard=true;f.loseDiscard=true})
 await confirm.getByRole('button',{name:'确认放弃',exact:true}).click()
 assert.equal(await confirm.getByRole('button',{name:'取消',exact:true}).isDisabled(),true)
 await page.keyboard.press('Escape');assert.equal(await confirm.isVisible(),true)
 await page.evaluate(()=>(window as any).builderFixture.releaseDiscard());await confirm.getByRole('alert').waitFor()
 assert.doesNotMatch(await page.locator('body').innerText(),/private discard details/)
 await page.evaluate(()=>(window as any).builderFixture.holdDiscard=false)
 await confirm.getByRole('button',{name:'确认放弃',exact:true}).click();await confirm.waitFor({state:'detached'})
 await page.getByText('已放弃搭建草案，会话与历史已保留。',{exact:true}).waitFor()
 assert.equal(await page.getByText('草案页面已准备好',{exact:true}).count(),0,'放弃后不再提示继续预览或保存')
 const calls=await page.evaluate(()=>(window as any).builderFixture.calls)
 assert.deepEqual(calls.filter((c:string)=>c.startsWith('discard:')),['discard:1','discard:1'])
 assert.equal(calls.includes('apply'),false)
 if(!directory){await page.getByRole('button',{name:'刷新预览',exact:true}).click();assert.equal(await page.getByRole('button',{name:'保存业务',exact:true}).count(),0)}
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 if(process.env.TELOA_DISCARD_EVIDENCE)await page.screenshot({path:process.env.TELOA_DISCARD_EVIDENCE+(directory?'/directory':'/panel')+(dark?'-dark':'')+'-discarded.png',fullPage:true})
 assert.deepEqual(errors,[])
})

test('放弃请求在连接更换后迟答不关闭新确认，不把旧完成回执显示到新连接',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close())
 await page.route('**/*',(route:any)=>route.abort());await page.setContent('<html lang="zh-CN"><div id="root"></div></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 await page.evaluate(async()=>{const f=(window as any).builderFixture;await f.load();f.directory();f.holdDiscard=true})
 const discard=page.getByRole('button',{name:'放弃草案',exact:true});await discard.click()
 let confirm=page.getByRole('dialog',{name:'放弃搭建草案',exact:true});await confirm.getByRole('button',{name:'确认放弃',exact:true}).click()
 await page.evaluate(()=>(window as any).builderFixture.rebuild())
 await confirm.waitFor({state:'detached'});await discard.click();await confirm.waitFor()
 await page.evaluate(()=>(window as any).builderFixture.releaseDiscard())
 assert.equal(await confirm.isVisible(),true)
 assert.equal(await confirm.getByRole('button',{name:'取消',exact:true}).isEnabled(),true)
 assert.equal(await page.getByText('已放弃搭建草案，会话与历史已保留。',{exact:true}).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).builderFixture.opened),[])
})

test('损坏方案恢复日志显示明确读取错误，保留方案而不发采用',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close());const errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.evaluate(async()=>{const f=(window as any).builderFixture;await f.completePlan();f.corruptSetup()})
 await page.getByRole('alert').filter({hasText:'无法读取本机方案采用恢复记录'}).waitFor()
 assert.equal(await page.getByRole('heading',{name:'完整业务方案',exact:true}).isVisible(),true);assert.deepEqual(errors,[])
 assert.equal(await page.getByRole('button',{name:'采用已选变更',exact:true}).count(),0)
 assert.equal(await page.evaluate(()=>(window as any).builderFixture.calls.includes('setup-apply')),false)
})
