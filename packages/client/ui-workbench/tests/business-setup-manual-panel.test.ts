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
import {BusinessSetupManualWorkspace} from '${client}BusinessSetupManualWorkspace.tsx';
import {BusinessSetupManualEditor} from '${client}BusinessSetupManualEditor.tsx';
import {BusinessSetupHistoryPanel} from '${client}BusinessSetupHistoryPanel.tsx';
import {BusinessBuilderFlow} from '${client}business-builder-flow.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
const locale=document.documentElement.lang,snapshot={locale,dshLocale:locale,revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);
const f=window.manualFixture={calls:[],quota:false,closed:false,reviews:0,restores:[]};let mode='editor',epoch=0;const storage=new Map();
const id='12345678-1234-4234-8234-123456789012',roleId='12345678-1234-4234-8234-123456789013',stamp='2026-10-21T00:00:00.000Z',hash='a'.repeat(64),responsibility={triggers:[],autonomousActions:[],confirmationPoints:[],escalationRules:[],deliveryChecks:[]};
let draft={ownerId:'self',id,scope:'sales',revision:1,baseVersion:1,status:'draft',hash,createdAt:stamp,updatedAt:stamp,candidate:{format:'teloa.business-configuration/v2',scope:'sales',title:'客户服务',sources:[{sourceId:'records',kind:'local-records'}],definitions:[{kind:'object-type',definition:{format:'teloa.business-object-type/v2',id:'ticket',version:'1.0.0',domain:'sales',title:'工单',unit:'条',lead:'跟进',sourceId:'records',fields:[{name:'name',label:'名称',from:'名称',type:'text',required:true},{name:'priority',label:'优先级',from:'优先级',type:'enum',required:false,values:['普通','紧急']}]}}],pages:[{id:'tickets',title:'工单页',kind:'records',objectType:'ticket',fields:['name','priority'],allowCreate:true,allowEdit:true,allowArchive:true}],homePageId:'tickets'}};
const binding={kind:'builder',draftId:id,requestId:'12345678-1234-4234-8234-123456789020',sessionId:'original',scope:'sales',title:'客户服务',createdAt:stamp,updatedAt:stamp};
let plan={format:'teloa.business-setup-plan/v1',draftId:id,scope:'sales',revision:1,configurationRevision:1,configurationHash:hash,contentId:'12345678-1234-4234-8234-123456789021',contentHash:hash,title:'客户服务',description:'原说明',resources:[],roleEdits:[],rejected:[],state:'draft',updatedAt:stamp};
const api={bySession:async()=>binding,draft:async()=>draft,setupPlan:async()=>plan,setupManual:async()=>{if(plan?.state==='applied')throw Error('已采用方案必须建立新草案');return ({draftId:id,revision:plan?.revision??0,configurationRevision:draft.revision,configurationHash:draft.hash,candidate:draft.candidate,description:plan?.description??'原说明',roleEdits:plan?.roleEdits??[],employees:[{roleId,expectedVersion:1,name:'质检员',duty:'核对工单',responsibility,state:'paused'}]})},setupEdit:async input=>{f.calls.push('edit');f.saved=input;draft={...draft,candidate:input.candidate,revision:draft.revision+1,hash:'b'.repeat(64)};plan={...plan,revision:plan.revision+1,configurationRevision:draft.revision,configurationHash:draft.hash,description:input.description,roleEdits:input.roleEdits};return plan},setupPreview:async input=>{f.calls.push('preview');plan={...plan,revision:plan.revision+1};return {draftId:id,revision:plan.revision,digest:hash,receipt:hash,configurationReceipt:hash,configurationRevision:draft.revision,baseVersion:1,changes:[],rejected:[],blocked:false}},setupHistory:async input=>{if(f.historyHold){f.historyHolds??={};return new Promise(resolve=>{f.historyHolds[input.scope]=()=>resolve({scope:input.scope,currentVersion:2,beforeVersion:null,items:[{version:1,hash,title:input.scope+' old',pages:1,createdAt:stamp}]})})}return {scope:input.scope,currentVersion:2,beforeVersion:null,items:[{version:2,hash,title:'当前版',pages:1,createdAt:stamp},{version:1,hash:'b'.repeat(64),title:'旧版',pages:1,createdAt:stamp}]} }};
const make=()=>new BusinessBuilderFlow({api,work:{},storage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>{if(f.quota)throw Error('quota');storage.set(key,value)},removeItem:key=>storage.delete(key)},journalKey:'personal-space/self',id:()=> '12345678-1234-4234-8234-123456789099',refreshScopes:async()=>{},switching:{read:()=>({mainSessionId:'original',bindingSessionId:'original',bindingReady:true,input:{draft:'',phase:'plain',attachmentIds:[],occurrences:[],queue:[]},pendingSubmissions:[]})}});
let flow=make(),scope='sales',registered=false;
const controllerState={api,namespace:'personal-space/self',flow:null,checkedSessionId:null,sessionKind:null};
const controller={getSnapshot:()=>controllerState,captureNavigation:current=>({current}),start:async(options,token)=>{if(!token.current())throw Error('changed');f.startCount=(f.startCount??0)+1;registered=true;if(f.afterAdoption)plan=null;flow=make();await flow.restoreSession('original');Object.assign(controllerState,{flow,checkedSessionId:'original',sessionKind:'builder'})},open:async(sessionId,allow,token)=>{f.calls.push('open-original');if(!token.current())throw Error('changed');flow=make();await flow.restoreSession(sessionId);if(!token.current())throw Error('changed');Object.assign(controllerState,{flow,checkedSessionId:sessionId,sessionKind:'builder'})}};
api.setupPlans=async()=>({items:[]});api.list=async input=>{f.calls.push('directory:'+String(input.cursor??'first'));return !registered?{items:[]}:input.cursor?{items:[{binding,draft:{id,scope:'sales',status:'draft',revision:draft.revision,title:'原草案',updatedAt:stamp}}]}:{items:Array.from({length:32},(_,i)=>({binding:{...binding,sessionId:'applied-'+i},draft:{id:'old-'+i,scope:'sales',status:'applied',revision:1,title:'已采用',updatedAt:stamp}})),nextCursor:'older'}};
f.workspace=()=>{mode='workspace';plan=null;registered=false;Object.assign(controllerState,{flow:null,checkedSessionId:null,sessionKind:null});render()};
f.adoptedWorkspace=()=>{f.afterAdoption=true;plan={...plan,state:'applied'};flow.publish({setupPlan:plan,phase:'saved',result:{scope:'sales',version:1}});Object.assign(controllerState,{flow,checkedSessionId:'original',sessionKind:'builder'});registered=false;mode='workspace';render()};
f.switchSession=()=>Object.assign(controllerState,{flow:null,checkedSessionId:'other',sessionKind:null});f.reopenWorkspace=()=>{mode='workspace';render()};
const app=createRoot(document.getElementById('root'));function render(){app.render(<I18nProvider runtime={runtime}><main className={tokens.tokens}>{mode==='workspace'?<BusinessSetupManualWorkspace controller={controller} api={api} scope='sales' close={()=>{mode='closed';render()}} review={()=>f.reviews++}/>:mode==='editor'?<BusinessSetupManualEditor key={epoch} flow={flow} onClose={()=>{f.closed=true;mode='closed';render()}} onReview={()=>f.reviews++}/>:mode==='history'?<BusinessSetupHistoryPanel api={api} scope={scope} onRestore={async(version,hash)=>{f.restores.push({version,hash})}}/>:<button onClick={()=>{mode='editor';render()}}>Open editor</button>}</main></I18nProvider>)}
f.rebuild=async()=>{flow=make();await flow.restoreSession('original');epoch++;mode='editor';render()};
f.history=next=>{mode='history';scope=next??'sales';render()};f.release=scope=>f.historyHolds[scope]();
flow.restoreSession('original').then(render);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-setup-manual-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'ManualFixture',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')+'body{margin:0;font-family:system-ui}main{padding:20px;max-width:700px;margin:auto}*{box-sizing:border-box}'
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-builder-panel',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
for(const locale of ['zh-CN','en'])test(locale+' 手动编辑普通控件、刷新恢复、额度失败保留输入，保存仅生成预览',async t=>{
 const page=await browser.newPage({viewport:{width:390,height:900}});page.setDefaultTimeout(5000);t.after(()=>page.close());page.on('pageerror',(e:Error)=>process.stderr.write('MANUAL_PAGE_ERROR '+e.message+'\n'));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="'+locale+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const en=locale==='en',label=(cn:string,english:string)=>page.getByLabel(en?english:cn,{exact:true}),button=(cn:string,english:string)=>page.getByRole('button',{name:en?english:cn,exact:true})
 await label('业务说明','Business description').fill('本人手动说明')
 await label('选项（每行一项）','Options (one per line)').fill('普通\n紧急');await label('选项（每行一项）','Options (one per line)').press('End');await label('选项（每行一项）','Options (one per line)').press('Enter');await label('选项（每行一项）','Options (one per line)').pressSequentially('立即')
 await page.locator('summary').filter({hasText:'质检员'}).click();await label('将此员工职责纳入草案','Include this employee in the proposal').check();await label('职责说明','Duties').fill('核对并追踪上线')
 await label('页面名称','Page name').fill('上线工单页')
 await button('关闭并保留输入','Close and keep input').click();await page.evaluate(()=>(window as any).manualFixture.rebuild())
 assert.equal(await label('业务说明','Business description').inputValue(),'本人手动说明');assert.equal(await label('选项（每行一项）','Options (one per line)').inputValue(),'普通\n紧急\n立即')
 await page.evaluate(()=>(window as any).manualFixture.quota=true);await label('业务说明','Business description').fill('额度故障时输入仍在')
 await page.getByRole('alert').filter({hasText:en?'local recovery could not be saved':'本机恢复记录尚未保存'}).waitFor()
 assert.equal(await label('业务说明','Business description').inputValue(),'额度故障时输入仍在')
 await page.evaluate(()=>(window as any).manualFixture.quota=false);await label('业务说明','Business description').fill('最终人工说明')
 await page.screenshot({path:'/tmp/teloa-builder-panel/'+locale+'-390-manual-editor.png',fullPage:true})
 await button('保存草案并复核','Save draft and review').click();await page.getByRole('button',{name:'Open editor',exact:true}).waitFor()
 const saved=await page.evaluate(()=>(window as any).manualFixture.saved)
 assert.equal(saved.description,'最终人工说明');assert.deepEqual(saved.candidate.definitions[0].definition.fields[1].values,['普通','紧急','立即']);assert.equal(saved.roleEdits[0].duty,'核对并追踪上线');assert.equal(saved.candidate.pages[0].title,'上线工单页')
 assert.deepEqual(await page.evaluate(()=>(window as any).manualFixture.calls),['edit','preview'])
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
})
test('历史切业务后旧load不会释放新flight；只回调固定版本和摘要',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close());page.on('pageerror',(e:Error)=>process.stderr.write('MANUAL_PAGE_ERROR '+e.message+'\n'));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByLabel('业务说明',{exact:true}).waitFor()
 await page.evaluate(()=>{const f=(window as any).manualFixture;f.historyHold=true;f.history('sales')});await page.waitForFunction(()=>(window as any).manualFixture.historyHolds?.sales)
 await page.evaluate(()=>(window as any).manualFixture.history('support'));await page.waitForFunction(()=>(window as any).manualFixture.historyHolds?.support)
 await page.evaluate(()=>(window as any).manualFixture.release('sales'));await page.waitForTimeout(30)
 assert.equal(await page.getByRole('button',{name:'读取最新原稿',exact:true}).isDisabled(),true)
 await page.evaluate(()=>(window as any).manualFixture.release('support'));await page.getByText('support old · v1',{exact:true}).waitFor();assert.equal(await page.getByText('sales old · v1',{exact:true}).count(),0)
 await page.getByRole('button',{name:'回到此版本并复核',exact:true}).click();assert.deepEqual(await page.evaluate(()=>(window as any).manualFixture.restores),[{version:1,hash:'a'.repeat(64)}])
})

test('未保存关闭并切会话后复用第二页原草案与输入，start始终一次',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close());await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByLabel('业务说明',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).manualFixture.workspace());await page.getByRole('dialog').waitFor();await page.getByLabel('业务说明',{exact:true}).fill('未保存的原草案输入')
 await page.getByRole('button',{name:'关闭并保留输入',exact:true}).click();await page.getByRole('dialog').waitFor({state:'detached'})
 await page.evaluate(()=>{const f=(window as any).manualFixture;f.switchSession();f.reopenWorkspace()})
 await page.getByLabel('业务说明',{exact:true}).waitFor();assert.equal(await page.getByLabel('业务说明',{exact:true}).inputValue(),'未保存的原草案输入')
 assert.equal(await page.evaluate(()=>(window as any).manualFixture.startCount),1)
 assert.equal(await page.evaluate(()=>(window as any).manualFixture.calls.includes('directory:older')),true);assert.equal(await page.evaluate(()=>(window as any).manualFixture.calls.includes('open-original')),true)
})

test('刚采用后原Flow草案状态尚未刷新，手动编辑建立新候选而不读已采用稿',async t=>{
 const page=await browser.newPage();page.setDefaultTimeout(5000);t.after(()=>page.close());await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<html lang="zh-CN"><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});await page.getByLabel('业务说明',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).manualFixture.adoptedWorkspace())
 await page.getByRole('dialog').getByLabel('业务说明',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>(window as any).manualFixture.startCount),1)
 assert.equal(await page.getByRole('dialog').getByRole('alert').count(),0)
 assert.equal(await page.evaluate(()=>(window as any).manualFixture.calls.includes('edit')),false)
})
