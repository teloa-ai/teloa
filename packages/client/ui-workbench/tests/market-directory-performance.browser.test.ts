import {after,before,test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,temp:string,script:string,styles:string

before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-market-directory-performance-'))
 await writeFile(join(temp,'fixture.tsx'),`
import React from 'react';import {createRoot} from 'react-dom/client';import {MarketPage} from '${client}MarketPage.tsx';import {createSkillInstallApi} from '${client}skill-install-api.ts';import {createSkillAvailabilityApi} from '${client}skill-availability-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {ThemePresenter} from '${client}theme-presenter.ts';import {catalogEntry} from '${root}packages/client/ui-workbench/tests/market-catalog-fixture.ts';import {connectorEntry} from '${root}packages/client/ui-workbench/tests/market-navigation-fixture.ts';
new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
const stamp='2026-10-16T00:00:00.000Z',records=Array.from({length:42},(_,index)=>({id:'10000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),ownerId:'self',source:{kind:'atomic',contentId:'20000000-0000-4000-8000-'+String(index+1).padStart(12,'0'),contentHash:'a'.repeat(64),resourceId:'directory-skill-'+index,resourceVersion:'1.0.0'},bundleHash:'b'.repeat(64),native:{name:'directory-skill-'+index,description:'本地已安装技能 '+index,modelInvocable:true,userInvocable:true,bodyHash:'c'.repeat(64)},state:'installed',version:1,createdAt:stamp,updatedAt:stamp}));
const f=window.marketDirectoryPerformance={catalogCalls:0,listCalls:0,observed:[],availability:[],writes:[],emptyFlashes:0,setVisible:()=>{}};
const deny=method=>{f.writes.push(method);throw Error('浏览目录不得写入：'+method)};
// 42条记录经过正式客户端decoder；诊断端口返回可用，测试仍要求浏览时完全不调用它们。
const skills=createSkillInstallApi(async(method,input)=>{if(method==='skill-installations/list'){f.listCalls++;return {items:records,usages:[]}}if(method==='skill-installations/observe'){f.observed.push(input.installationId);const record=records.find(row=>row.id===input.installationId);if(!record)throw Error('未知安装');return {installationId:record.id,scope:'default-workspace',state:'available',current:{...record.native,provider:'fixture',source:'fixture://directory/'+record.id}}}return deny(method)});
const availability=createSkillAvailabilityApi(async(method,input)=>{if(method!=='skill-availability/get')return deny(method);f.availability.push(input.installationId);return {installationId:input.installationId,ownerId:'self',availability:'enabled',version:1,updatedAt:stamp}});
let ready=false,release;const pending=new Promise(resolve=>{release=resolve});f.resolveCatalog=()=>{ready=true;release()};
const artifact={files:[{path:'SKILL.md',sha256:'d'.repeat(64),size:1}],treeHash:'e'.repeat(64)},wrap=entry=>({entry,artifact:entry.kind==='connector'?null:artifact,addedContentId:null,addedRoleId:null,secretGroup:null});
const catalog={list:async()=>{f.catalogCalls++;if(!ready)await pending;return {catalogVersion:'directory-performance-1',items:[wrap(catalogEntry()),wrap(connectorEntry())],nextCursor:null,counts:{role:0,solution:0,dashboard:0,skill:1,connector:1,model:0},skipped:{unknownKind:0,newerApp:0}}},ranking:async()=>new Map(),add:()=>deny('catalog/add')};
new MutationObserver(()=>{if([...document.querySelectorAll('h3')].some(row=>row.textContent==='没有找到匹配的应用或技能'))f.emptyFlashes++}).observe(document.getElementById('root'),{childList:true,subtree:true});
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
function App(){const [visible,setVisible]=React.useState(true),[state,change]=React.useState({items:[],intents:[]});f.setVisible=setVisible;return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[]}><MarketPage visible={visible} navigationState={{category:'apps',query:'',selectedId:undefined,mobileLayer:'list'}} state={state} change={change} itemId={null} intentId={null} open={()=>{}} seed={null} clearSeed={()=>{}} marketCatalogApi={catalog} skillInstallApi={skills} skillAvailabilityApi={availability} managedMcpConnectionApi={{list:async()=>[]}} githubSourceApi={{pending:()=>undefined,recoveryMessage:()=>undefined}} marketPluginInstallApi={{pending:()=>undefined}} installations={{visible:false,selected:null,open:()=>deny('installation/open'),market:()=>{}}} industryLoads={{loads:[],error:undefined,save:()=>deny('industry/save'),recover:()=>deny('industry/recover')}} industryReview={{loads:[],upgrade:()=>deny('industry/upgrade'),rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:()=>{}}} saveResolved={()=>deny('save')} spaces={[]} targets={[]} planFromTemplate={()=>deny('plan')} manageIndustryLoad={()=>deny('load')} update={()=>deny('update')} prepare={()=>deny('prepare')} capabilities={()=>deny('capabilities')} nativeSettings={()=>deny('settings')} nativeModels={()=>deny('models')} openRole={()=>deny('role')} configureBinding={()=>deny('binding')} openTarget={()=>deny('target')}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`)
 const built=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketDirectoryPerformance',formats:['iife']}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})

async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.setDefaultTimeout(5000)
 page.on('pageerror',(error:Error)=>errors.push(error.message));t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.abort());await page.route('http://127.0.0.1:49324/market-directory-performance',(route:any)=>route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset=utf-8><div id="root"></div>'}))
 await page.goto('http://127.0.0.1:49324/market-directory-performance');await page.addStyleTag({content:styles});await page.addScriptTag({content:script})
 const directory=page.locator('section[aria-labelledby="market-apps-title"]');await directory.getByRole('heading',{name:'应用',exact:true}).waitFor()
 await directory.getByRole('button',{name:'我的应用 42',exact:true}).waitFor()
 return {page,directory}
}

test('42项已安装技能的实际应用目录浏览、搜索与返回不逐项诊断或冒充可用',{timeout:30000},async t=>{
 const {page,directory}=await mount(t)
 await page.evaluate(()=>(window as any).marketDirectoryPerformance.resolveCatalog())
 await directory.getByRole('button',{name:/^内部沟通稿/}).waitFor();await directory.getByRole('button',{name:/^官方远程连接器/}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).marketDirectoryPerformance;return {observe:f.observed.length,get:f.availability.length}}),{observe:0,get:0},'浏览目录不能触发42×2次运行诊断')
 await directory.getByRole('button',{name:/^内部沟通稿/}).click();const detail=page.getByRole('dialog',{name:'技能',exact:true});await detail.getByRole('heading',{name:'内部沟通稿',exact:true}).waitFor();t.diagnostic(JSON.stringify({openedDialog:await detail.getByRole('heading',{level:2}).innerText(),item:await detail.getByRole('heading',{name:'内部沟通稿',exact:true}).innerText()}));await page.keyboard.press('Escape')
 const query=directory.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true});await query.fill('官方远程');await directory.getByRole('button',{name:/^官方远程连接器/}).waitFor();await query.fill('')
 await directory.getByRole('button',{name:'我的应用 42',exact:true}).click()
 const installed=directory.locator('li').filter({has:page.getByRole('button',{name:/^directory-skill-0\s/})});await installed.getByRole('button',{name:'已安装',exact:true}).waitFor()
 assert.equal(await directory.getByText('已安装并可用',{exact:true}).count(),0,'安装记录不能代替运行可用性核验')
 await page.evaluate(()=>(window as any).marketDirectoryPerformance.setVisible(false));await directory.waitFor({state:'hidden'});await page.evaluate(()=>(window as any).marketDirectoryPerformance.setVisible(true));await directory.getByRole('button',{name:'我的应用 42',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>{const f=(window as any).marketDirectoryPerformance;return {observe:f.observed.length,get:f.availability.length,writes:f.writes}}),{observe:0,get:0,writes:[]})
})

test('已有42个本地安装项时官方目录仍在读取，不闪无匹配并在真实响应后展示目录',{timeout:30000},async t=>{
 const {page,directory}=await mount(t)
 await page.waitForFunction(()=>(window as any).marketDirectoryPerformance.catalogCalls>0)
 assert.equal(await directory.getByRole('heading',{name:'没有找到匹配的应用或技能',exact:true}).count(),0,'本地记录已到但官方目录未返回时不能宣称没有匹配')
 assert.equal(await page.evaluate(()=>(window as any).marketDirectoryPerformance.emptyFlashes),0,'等待期间不得短暂闪现无匹配空态')
 await page.evaluate(()=>(window as any).marketDirectoryPerformance.resolveCatalog())
 await directory.getByRole('button',{name:/^内部沟通稿/}).waitFor();await directory.getByRole('button',{name:/^官方远程连接器/}).waitFor()
 assert.equal(await directory.getByRole('heading',{name:'没有找到匹配的应用或技能',exact:true}).count(),0)
 assert.deepEqual(await page.evaluate(()=>(window as any).marketDirectoryPerformance.writes),[])
})
