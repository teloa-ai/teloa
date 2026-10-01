import test,{before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器夹具没有声明。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {BusinessSetup} from '${client}BusinessSetup.tsx';
import {BusinessConfigurationSurface} from '${client}BusinessConfigurationSurface.tsx';
import {BusinessRecordFlow} from '${client}business-record-flow.ts';import {createBusinessRecordApi} from '${client}business-record-api.ts';import {createBusinessBuilderApi} from '${client}business-builder-api.ts';
import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const locale=document.documentElement.lang,en=locale==='en',runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>locale};
if(!crypto.randomUUID)crypto.randomUUID=()=> '00000000-0000-4000-8000-000000000001';
const hash='a'.repeat(64),stamp='2026-09-30T00:00:00.000Z',roleId='11111111-1111-4111-8111-111111111111';
const state=window.setupFixture={scope:'sales',version:1,hash,mode:'ready',availability:'ready',actions:[],reads:[],hold:false,release:null,owner:'A',responsibility:false,pending:false,connectionRows:null};
const role={id:roleId,ownerId:'owner',name:'Mina',kind:'employee',state:'active',version:1,scopes:['sales'],duty:'Customer follow-up',dataScope:'Customers',executionScope:'Read',skills:['audit','duplicate'],knowledge:[],createdAt:stamp,updatedAt:stamp};
const responsibility=()=>({scope:state.scope,version:1,roleId:state.availability==='none'?null:roleId,selectedRoleVersion:1,currentRoleVersion:1,availability:state.availability});
const snapshot=input=>({...input,configurationVersion:input.expectedVersion,configurationHash:input.expectedHash,observedAt:stamp,colleagues:{status:'observed',value:{responsibility:responsibility(),roles:[role],selectedRole:state.availability==='none'||state.availability==='missing'||state.roleMismatch?null:role}},skills:{status:'observed',value:{declared:state.extended?Array.from({length:7},(_,i)=>({name:'skill-'+i,status:['observed','unobserved','ambiguous'][i%3]})):[{name:'audit',status:'observed'},{name:'duplicate',status:'ambiguous'}],executionChecked:false}},knowledge:{status:'observed',value:{assigned:Array.from({length:7},(_,i)=>({id:'private-uuid-'+i,title:i===0?'Customer notes':null,version:i===0?2:null,state:state.mixedKnowledge?['available','withdrawn','out-of-scope','oversized','size-unknown','missing','missing'][i]:i===0?'available':'missing'})),businessResourceCount:0,generalResourceCount:3}},connections:{status:'observed',value:{items:state.connectionRows??(state.extended?Array.from({length:7},(_,i)=>({id:'connection-'+i,catalogId:'catalog-'+i,serverName:'Connection '+i,status:['connected','saved','installing','error','pending-oauth','saved','error'][i],updatedAt:stamp})):[{id:'one',catalogId:'catalog-one',serverName:'CRM',status:'connected',updatedAt:stamp}]),binding:'not-declared'}}});
const def=id=>({id,kind:'records',title:id==='orders'?(en?'Orders':'订单'):(en?'Review':'复核'),objectType:'order',fields:['stage'],allowCreate:true,allowEdit:true,allowArchive:true});
const object={format:'teloa.business-object-type/v1',id:'order',version:'1.0.0',domain:'sales',title:en?'Order':'订单',unit:'items',lead:'Start with the first order',sourceId:'local',fields:[{name:'stage',label:'Stage',from:'Stage',type:'text',required:false}]};
const records=new BusinessRecordFlow(createBusinessRecordApi(async()=>({schema:'teloa.business-data-page/v1',sourceId:'local',capturedAt:stamp,items:[]})));
function services(owner){return {api:createBusinessBuilderApi(async(endpoint,input)=>endpoint.endsWith('/current')?(state.mode==='legacy'?null:({scope:state.scope,version:state.version,hash:state.hash,createdAt:stamp,manifest:{format:'teloa.business-configuration/v1',scope:state.scope,title:owner+' '+(en?'Customer orders':'客户订单'),sources:[{sourceId:'local',kind:'local-records'}],definitions:[{kind:'object-type',localId:'order',version:1,definitionHash:hash}],pages:[def('orders'),def('review')],homePageId:'orders'}})):({mode:'saved',scope:input.scope,configurationVersion:state.version,configurationHash:state.hash,page:{kind:'records',definition:def(input.pageId),objectType:object,emptyState:'no-records'}})),records,capabilities:{create:true,edit:true,archive:true},adjust:()=>{},setup:{api:{read:async(input,signal)=>{state.reads.push([owner,input]);if(state.mode==='failed')throw Error('private detail');let value=snapshot(input);if(state.mode==='unavailable')value={...value,skills:{status:'unavailable'},knowledge:{status:'unavailable'},connections:{status:'unavailable'}};if(state.hold)return await new Promise(resolve=>{state.release=()=>resolve(value)});return value}},open:(scope,title,target)=>state.actions.push([scope,title,target])},responsibility:{api:{reconcile:async()=>responsibility(),read:async()=>responsibility(),pending:()=>state.pending?{}:null,canReselect:()=>true,set:async()=>{if(state.holdSave)return await new Promise(resolve=>{state.releaseSave=resolve});if(state.mode==='write-failed')throw Error('write failed');state.availability='ready';state.pending=false},recover:async()=>{if(!state.preservePending)state.pending=false;return responsibility()},reselect:async()=>{state.pending=false;return responsibility()}},roles:{list:async()=>[role]}}}}
let supplied=services('A');const app=createRoot(document.getElementById('root'));
state.render=()=>app.render(<I18nProvider runtime={runtime}>{state.standalone?<BusinessSetup scope={state.scope} title="Saved business" configurationVersion={state.version} configurationHash={state.hash} services={supplied.setup}/>:<BusinessConfigurationSurface scope={state.scope} services={{...supplied,responsibility:state.responsibility?supplied.responsibility:undefined}} colorScheme="light" backHome={()=>{}} legacy={()=><div>Legacy business</div>}/>}</I18nProvider>);
state.change=patch=>{Object.assign(state,patch);if(patch.owner)supplied=services(patch.owner);state.render()};state.render();
`
before(async()=>{
 await mkdir(join(client,'../../.runtime'),{recursive:true});temp=await mkdtemp(join(client,'../../.runtime/business-setup-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'SetupFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions());await mkdir('/tmp/teloa-business-setup',{recursive:true})
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function fixture(t:any,locale='zh-CN',width=390){
 const page=await browser.newPage({viewport:{width,height:1000}});page.setDefaultTimeout(3000);const errors:string[]=[],requests:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()});t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<html lang="'+locale+'"><body><div id="root"></div></body></html>');await page.addStyleTag({content:':root{--teloa-font-page:26px;--teloa-font-section:18px;--teloa-font-body:14px;--teloa-font-caption:12px;--teloa-font-control:14px;--teloa-border:#ddd;--teloa-surface:#fff;--teloa-subtle:#f5f5f2;--teloa-text:#252823;--teloa-muted:#646a62;--teloa-accent:#9e4226;--teloa-on-accent:#fff}body{font-family:system-ui;margin:0}#root{height:100vh}'+styles});await page.addScriptTag({content:script});await page.getByRole('heading',{level:1}).waitFor();return page
}
for(const locale of ['zh-CN','en'])for(const width of [390,1400])test(locale+'/'+width+' 四类真实摘要按需展开，键盘动作传当前业务与冻结目标',async t=>{
 const p=await fixture(t,locale,width),en=locale==='en',panel=p.getByRole('region',{name:en?"Employees and capabilities":"员工与能力"})
 await panel.getByText('Mina',{exact:true}).waitFor();assert.deepEqual(await p.evaluate(()=>(window as any).setupFixture.actions),[]);assert.equal(await panel.getByText('audit',{exact:true}).isVisible(),false)
 const summary=panel.locator('summary').first();await summary.focus();await p.keyboard.press('Enter');await panel.getByText('audit',{exact:true}).waitFor()
 assert.match(await panel.innerText(),en?/Check before execution/:/执行前核对/);assert.doesNotMatch(await panel.innerText(),/private-uuid/)
 assert.equal(await panel.locator('li').filter({hasText:en?'Unavailable resource':'不可用资料'}).count(),4)
 assert.match(await panel.innerText(),en?/2 more/:/另有 2 项/)
 for(const [name,target] of [[en?'Configure duties':'配置职责',{kind:'role',id:'11111111-1111-4111-8111-111111111111'}],[en?"Configure employee skills":"配置员工技能",{kind:'role',id:'11111111-1111-4111-8111-111111111111'}],[en?"Configure employee resource scopes":"配置员工资料范围",{kind:'role',id:'11111111-1111-4111-8111-111111111111'}],[en?"Business employee directory":"业务员工目录",{kind:'colleagues'}],[en?'Install skills':'安装技能',{kind:'skills'}],[en?'Manage resources':'管理资料',{kind:'resources'}],[en?'Connection directory':'连接目录',{kind:'connections'}],[en?'Configure CRM':'配置 CRM',{kind:'connection',catalogId:'catalog-one'}]]){const button=panel.getByRole('button',{name,exact:true});await button.focus();await p.keyboard.press('Enter');assert.deepEqual((await p.evaluate(()=>(window as any).setupFixture.actions)).at(-1),['sales',en?'A Customer orders':'A 客户订单',target])}
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.match(await panel.innerText(),en?/Local connections/:/本机连接/);assert.match(await panel.innerText(),en?/does not mean this business has a confirmed source mapping/:/不代表该业务的来源映射已确认/);await p.getByRole('heading',{level:1}).scrollIntoViewIfNeeded();await p.screenshot({path:'/tmp/teloa-business-setup/'+locale+'-'+width+'.png',fullPage:true});await panel.locator('summary').first().click();await p.getByRole('heading',{level:1}).scrollIntoViewIfNeeded();await p.screenshot({path:'/tmp/teloa-business-setup/'+locale+'-'+width+'-compact.png',fullPage:true})
})
test('正式业务页未展开准备详情时也能找到外部来源接入路径和原连接目录',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"})
 await p.evaluate(()=>(window as any).setupFixture.change({connectionRows:[],owner:'no-connections'}))
 const guide=panel.getByRole('region',{name:'外部数据来源（例如告警）'})
 await guide.getByText(/还没有保存受管连接/).waitFor()
 assert.match(await guide.innerText(),/调整业务.*来源映射.*启用同步/)
 assert.equal(await panel.locator('details').first().evaluate((element:HTMLDetailsElement)=>element.open),false)
 await guide.getByRole('button',{name:'连接目录'}).click()
 assert.deepEqual((await p.evaluate(()=>(window as any).setupFixture.actions)).at(-1),['sales','no-connections 客户订单',{kind:'connections'}])
})
test('来源提示只依据本机连接状态，不把已连接或读取失败说成业务已接入',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"}),guide=panel.getByRole('region',{name:'外部数据来源（例如告警）'})
 await guide.getByText(/有已连接的受管连接/).waitFor()
 assert.match(await guide.innerText(),/不代表该业务的来源映射已确认或数据已同步/)
 await p.evaluate(()=>(window as any).setupFixture.change({owner:'saved',connectionRows:[{id:'one',catalogId:'catalog-one',serverName:'CRM',status:'saved',updatedAt:'2026-09-30T00:00:00.000Z'}]}))
 await guide.getByText(/暂无已连接的受管连接/).waitFor()
 await p.evaluate(()=>(window as any).setupFixture.change({owner:'unknown',mode:'unavailable'}))
 await guide.getByText(/连接状态暂时无法核对/).waitFor()
 assert.doesNotMatch(await guide.innerText(),/已连接的受管连接|已接入当前业务/)
})
test('失败重试不遮挡记录；读取不可用不冒充空；未设置可跳过并去业务同事目录',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('Mina',{exact:true}).waitFor()
 await p.evaluate(()=>(window as any).setupFixture.change({mode:'failed',owner:'B'}));await panel.getByRole('alert').waitFor();await p.getByRole('button',{name:'新增第一条',exact:true}).waitFor();assert.doesNotMatch(await panel.innerText(),/private detail/)
 await p.evaluate(()=>(window as any).setupFixture.change({mode:'unavailable',availability:'none'}));await panel.getByRole('button',{name:'重试',exact:true}).focus();await p.keyboard.press('Enter');await panel.getByText('未设置，可稍后配置',{exact:true}).waitFor();assert.equal(await panel.getByText('暂时无法核对',{exact:true}).count(),3)
 await panel.locator('summary').first().click();await panel.getByRole('button',{name:'配置职责',exact:true}).click();assert.deepEqual((await p.evaluate(()=>(window as any).setupFixture.actions)).at(-1)[2],{kind:'colleagues'})
})
test('暂停、离岗、缺失、撤掉业务范围如实显示，配置不换成目录其他同事',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('Mina',{exact:true}).waitFor();await panel.locator('summary').first().click()
 for(const [availability,label]of [['paused','已暂停'],['retired','已离岗'],['missing','已不存在'],['forbidden','不再支持此业务']]){await p.evaluate((availability:string)=>(window as any).setupFixture.change({availability,owner:availability}),availability);await panel.getByText(label,{exact:true}).waitFor();await panel.locator('summary').first().click();await panel.getByRole('button',{name:'配置职责',exact:true}).click();assert.deepEqual((await p.evaluate(()=>(window as any).setupFixture.actions)).at(-1)[2],availability==='missing'?{kind:'colleagues'}:{kind:'role',id:'11111111-1111-4111-8111-111111111111'})}
})
test('业务/API/配置代次切换立即清投影，迟到旧回包不污染新准备区',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('Mina',{exact:true}).waitFor()
 await p.evaluate(()=>(window as any).setupFixture.change({hold:true,owner:'old'}));await p.waitForFunction(()=>typeof(window as any).setupFixture.release==='function');await panel.getByText("正在核对员工与能力…").waitFor();assert.equal(await panel.getByText('Mina',{exact:true}).count(),0)
 await p.evaluate(()=>(window as any).setupFixture.change({scope:'support',version:2,hash:'b'.repeat(64),hold:false,owner:'new',availability:'none'}));await panel.getByText('未设置，可稍后配置',{exact:true}).waitFor();await p.evaluate(()=>(window as any).setupFixture.release());assert.equal(await panel.getByText('Mina',{exact:true}).count(),0)
 assert.deepEqual((await p.evaluate(()=>(window as any).setupFixture.reads)).at(-1)[1],{scope:'support',expectedVersion:2,expectedHash:'b'.repeat(64)})
})
test('原责任成功保存、恢复、重新选择仅刷新准备；失败不刷新，所选记录页保留',async t=>{
 const p=await fixture(t);await p.evaluate(()=>(window as any).setupFixture.change({responsibility:true,availability:'none',owner:'ready'}));await p.getByRole('region',{name:"员工与能力"}).getByText('未设置，可稍后配置',{exact:true}).waitFor();await p.getByRole('navigation').getByRole('button',{name:'复核',exact:true}).click()
 const panel=p.getByRole('region',{name:'业务负责人'});await panel.getByRole('combobox').selectOption('11111111-1111-4111-8111-111111111111');await panel.getByRole('button',{name:'保存负责人'}).click();await p.getByRole('region',{name:"员工与能力"}).getByText('Mina',{exact:true}).waitFor();await p.getByRole('heading',{level:2,name:'复核',exact:true}).waitFor()
 for(const action of ['核对保存结果','重新选择']){await p.evaluate(()=>(window as any).setupFixture.change({pending:true,owner:'pending'}));await panel.getByRole('button',{name:action,exact:true}).waitFor();const n=await p.evaluate(()=>(window as any).setupFixture.reads.length);await panel.getByRole('button',{name:action,exact:true}).click();await p.waitForFunction((n:number)=>(window as any).setupFixture.reads.length===n+1,n)}
 await p.evaluate(()=>(window as any).setupFixture.change({pending:false,availability:'none',mode:'write-failed',owner:'failed'}));await p.getByRole('heading',{level:1,name:'failed 客户订单',exact:true}).waitFor();await panel.getByRole('combobox').selectOption('11111111-1111-4111-8111-111111111111');const n=await p.evaluate(()=>(window as any).setupFixture.reads.length);await panel.getByRole('button',{name:'保存负责人'}).click();await panel.getByRole('alert').waitFor();assert.equal(await p.evaluate(()=>(window as any).setupFixture.reads.length),n)
})
test('同一API的scope、version、hash分别变化均清旧投影并重读，迟到旧代次不得导航',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('Mina',{exact:true}).waitFor();await p.evaluate(()=>(window as any).setupFixture.change({standalone:true}));await panel.getByText('Mina',{exact:true}).waitFor()
 for(const patch of [{scope:'support'},{version:2},{hash:'b'.repeat(64)}]){
  await p.evaluate((patch:any)=>(window as any).setupFixture.change({...patch,hold:true}),patch);await p.waitForFunction(()=>typeof(window as any).setupFixture.release==='function');await panel.getByText("正在核对员工与能力…").waitFor();assert.equal(await panel.getByText('Mina',{exact:true}).count(),0);assert.equal(await panel.getByRole('button').count(),0)
  await p.evaluate(()=>(window as any).setupFixture.release());await panel.getByText('Mina',{exact:true}).waitFor();await p.evaluate(()=>(window as any).setupFixture.change({hold:false,release:null}))
 }
 const inputs=(await p.evaluate(()=>(window as any).setupFixture.reads)).slice(-3).map((row:any)=>row[1]);assert.deepEqual(inputs,[{scope:'support',expectedVersion:1,expectedHash:'a'.repeat(64)},{scope:'support',expectedVersion:2,expectedHash:'a'.repeat(64)},{scope:'support',expectedVersion:2,expectedHash:'b'.repeat(64)}])
})
test('资料六类实情与技能同名/未见可读，清单各最多五项且完整配置入口可用',async t=>{
 const p=await fixture(t),panel=p.getByRole('region',{name:"员工与能力"});await panel.getByText('Mina',{exact:true}).waitFor();await p.evaluate(()=>(window as any).setupFixture.change({extended:true,mixedKnowledge:true,roleMismatch:true,owner:'metadata'}));await panel.getByText("所选员工不可用",{exact:true}).waitFor();await panel.locator('summary').first().click()
 for(const label of ['资料可读取','已撤回','不在已授权范围','超出读取大小限制','来源大小待核对','目录已见','目录未见','同名待核对','已连接','已保存，未连接','正在连接','连接失败','等待授权'])await panel.getByText(label,{exact:true}).first().waitFor()
 assert.equal(await panel.locator('ul').count(),3);for(const list of await panel.locator('ul').all())assert.equal(await list.locator('li').count(),5)
 assert.equal(await panel.getByText(/另有 2 项/).count(),3);assert.doesNotMatch(await panel.innerText(),/private-uuid|skill-5|Connection 5/)
 for(const name of ['配置职责',"配置员工技能","配置员工资料范围"]){await panel.getByRole('button',{name,exact:true}).click();assert.deepEqual((await p.evaluate(()=>(window as any).setupFixture.actions)).at(-1)[2],{kind:'colleagues'})}
 await p.evaluate(()=>(window as any).setupFixture.change({extended:false,mixedKnowledge:false,owner:'missing'}));await panel.getByText("所选员工不可用",{exact:true}).waitFor();await panel.locator('summary').first().click();assert.equal(await panel.getByText('已缺失',{exact:true}).count(),4)
})
test('current明确缺失的旧业务不挂载准备、不读取准备API',async t=>{
 const p=await fixture(t);await p.getByRole('region',{name:"员工与能力"}).getByText('Mina',{exact:true}).waitFor();const n=await p.evaluate(()=>(window as any).setupFixture.reads.length);await p.evaluate(()=>(window as any).setupFixture.change({mode:'legacy',owner:'legacy'}));await p.getByText('Legacy business',{exact:true}).waitFor();assert.equal(await p.getByRole('region',{name:"员工与能力"}).count(),0);assert.equal(await p.evaluate(()=>(window as any).setupFixture.reads.length),n)
})
test('负责人旧身份迟到保存及仍待核对的恢复均不刷新当前准备',async t=>{
 const p=await fixture(t);await p.evaluate(()=>(window as any).setupFixture.change({responsibility:true,availability:'none',owner:'old-save',holdSave:true}));await p.getByRole('heading',{level:1,name:'old-save 客户订单',exact:true}).waitFor();const panel=p.getByRole('region',{name:'业务负责人'});await panel.getByRole('combobox').selectOption('11111111-1111-4111-8111-111111111111');await panel.getByRole('button',{name:'保存负责人'}).click();await p.waitForFunction(()=>typeof(window as any).setupFixture.releaseSave==='function')
 await p.evaluate(()=>(window as any).setupFixture.change({owner:'new-save',holdSave:false}));await p.getByRole('heading',{level:1,name:'new-save 客户订单',exact:true}).waitFor();await p.getByRole('region',{name:"员工与能力"}).getByText('未设置，可稍后配置',{exact:true}).waitFor();const n=await p.evaluate(()=>(window as any).setupFixture.reads.length);await p.evaluate(()=>(window as any).setupFixture.releaseSave());await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await p.evaluate(()=>(window as any).setupFixture.reads.length),n)
 await p.evaluate(()=>(window as any).setupFixture.change({owner:'pending-save',pending:true,preservePending:true}));await panel.getByRole('button',{name:'核对保存结果',exact:true}).waitFor();const pendingReads=await p.evaluate(()=>(window as any).setupFixture.reads.length);await panel.getByRole('button',{name:'核对保存结果',exact:true}).click();await p.waitForFunction(()=>document.querySelector('section[aria-label="业务负责人"]')?.getAttribute('aria-busy')==='false');assert.equal(await p.evaluate(()=>(window as any).setupFixture.reads.length),pendingReads);assert.equal(await panel.getByRole('combobox').isDisabled(),true)
})
