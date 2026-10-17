import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import ts from 'typescript'
import {build} from 'vite'
import {marketFunctionKeys} from '@teloa/contract'
import {readDirectoryFilterCategory} from '../src/client/workbench-navigation-state.ts'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

// 执行真实 Frame 的读取函数与 MarketPage 回写回调，不在夹具里另写一套筛选编解码。
async function frameNavigationSource(){
 const text=await readFile(new URL('../src/client/WorkbenchFrame.tsx',import.meta.url),'utf8'),file=ts.createSourceFile('WorkbenchFrame.tsx',text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
 const reader=file.statements.filter(ts.isVariableStatement).find(statement=>statement.declarationList.declarations.some(row=>ts.isIdentifier(row.name)&&row.name.text==='readMarketNavigation'))
 assert.ok(reader)
 const callbacks:string[]=[]
 const visit=(node:ts.Node)=>{if(ts.isJsxAttribute(node)){const parent=node.parent.parent;if((ts.isJsxOpeningElement(parent)||ts.isJsxSelfClosingElement(parent))&&node.name.getText(file)==='onNavigationChange'&&parent.tagName.getText(file)==='MarketPage'&&node.initializer&&ts.isJsxExpression(node.initializer)&&node.initializer.expression)callbacks.push(node.initializer.expression.getText(file))}ts.forEachChild(node,visit)}
 visit(file);assert.equal(callbacks.length,1)
 return {reader:reader.getText(file),callback:callbacks[0]!}
}

test('应用筛选导航保留旧缺省并按原导航规则拒绝非法mine和类别',async()=>{
 const {reader}=await frameNavigationSource(),code=ts.transpileModule(reader,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText
 const read=new Function('readDirectoryFilterCategory','marketFunctionKeys',code+';return readMarketNavigation')(readDirectoryFilterCategory,marketFunctionKeys)
 assert.deepEqual(read(undefined),{category:'home',mobileLayer:'category',appsMine:false,appsCategory:'all'})
 assert.deepEqual(read(JSON.stringify({category:'resources',mobileLayer:'list'})),{category:'resources',mobileLayer:'list',appsMine:true,appsCategory:'all'})
 assert.deepEqual(read(JSON.stringify({category:'apps',mobileLayer:'detail'})),{category:'apps',mobileLayer:'detail',appsMine:false,appsCategory:'all'})
 for(const appsCategory of ['all',...marketFunctionKeys])assert.deepEqual(read(JSON.stringify({category:'apps',mobileLayer:'list',appsMine:'true',appsCategory})),{category:'apps',mobileLayer:'list',appsMine:true,appsCategory})
 for(const patch of [{appsMine:'yes',appsCategory:'office-docs'},{appsMine:'false',appsCategory:'invented'},{appsMine:true,appsCategory:'all'}])assert.deepEqual(read(JSON.stringify({category:'apps',mobileLayer:'detail',...patch})),read(undefined))
})

test('正式应用UI回写后真实reload保我的应用、查询、用途分类及原详情，另一context不继承',{timeout:60000},async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-apps-navigation-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 const source=await frameNavigationSource()
 await writeFile(join(temp,'frame-navigation.ts'),`import {marketFunctionKeys} from '@teloa/contract';import {readDirectoryFilterCategory,writeDirectoryFilterCategory} from '${client}workbench-navigation-state.ts';import type {MarketPageNavigationState} from '${client}MarketPage.tsx';${source.reader};export const readNavigation=readMarketNavigation;export const navigationChange=actions=>(${source.callback});`)
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketPage} from '${client}MarketPage.tsx';import {atomicSkillItem} from '${client}atomic-market.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {captureWorkbenchNavigationState,loadWorkbenchNavigationState,persistWorkbenchNavigationState} from '${client}workbench-navigation-state.ts';import {getTaxonomyLabel} from '${client}market-taxonomy-filter.ts';import {connectorEntry} from '${root}packages/client/ui-workbench/tests/market-navigation-fixture.ts';import {readNavigation,navigationChange} from './frame-navigation.ts';
const f=window.appsNavigation={changes:[],writes:[],categoryTitle:getTaxonomyLabel('function','communication','zh-CN')},saved=loadWorkbenchNavigationState(sessionStorage),directory=saved.directories.market??{},navigation={...readNavigation(directory.category??JSON.stringify({category:'apps',mobileLayer:'list'})),query:directory.query??'',selectedId:directory.selectedId};
const persist=next=>persistWorkbenchNavigationState(sessionStorage,captureWorkbenchNavigationState({view:'market',messageMode:'native',marketMode:'catalog',taskId:null,roleId:null,resourceTarget:null,capabilityBindingId:null,marketItemId:next.selected.marketItemId??null,marketIntentId:null,installationId:null,businessTarget:{scope:'general',section:'overview'},continuousTarget:{kind:'plans'},navigationDirectories:next.directories,detail:next.detail}));const actions={rememberDirectory:(key,patch)=>{const current=loadWorkbenchNavigationState(sessionStorage);persist({...current,directories:{...current.directories,[key]:{...current.directories[key],...patch}}});f.changes.push(patch)}};
const id='11111111-1111-4111-8111-111111111111',item={...atomicSkillItem({id:'internal-comms',title:'internal-comms',version:'1.0.0',categories:[],hash:'a'.repeat(64),entryPath:'SKILL.md',text:'原个人技能正文',files:[{path:'SKILL.md',hash:'b'.repeat(64),bytes:new TextEncoder().encode('原个人技能正文')}]}),id:'stored-'+id,source:{kind:'stored',contentId:id},contentStorage:{contentId:id,createdAt:'2026-10-16T00:00:00Z',loaded:true}};
const noWrite=()=>{f.writes.push('unexpected');throw Error('不允许产品写入')},content={list:async()=>[item],hydrate:async()=>item,pending:()=>undefined,pendingGithubImport:()=>undefined};
const catalog={list:async()=>({catalogVersion:'fixture-1',items:[{entry:connectorEntry(),artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null}],nextCursor:null,counts:{role:0,skill:0,solution:0,dashboard:0,connector:1,model:0},skipped:{unknownKind:0,newerApp:0}}),ranking:async()=>new Map(),add:noWrite},skills={pending:()=>undefined,recoveryMessage:()=>undefined,list:async()=>({items:[],usages:[]}),preview:async()=>({source:{kind:'atomic',contentId:id,contentHash:item.hash,resourceId:'internal-comms',resourceVersion:'1.0.0'},bundleHash:item.hash,native:{name:'internal-comms',description:'原个人技能',bodyHash:'b'.repeat(64),modelInvocable:true,userInvocable:true},files:[{path:'SKILL.md',hash:'b'.repeat(64),size:24}]}),install:noWrite,recover:noWrite};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
function App(){const [state,change]=React.useState({items:[],intents:[]}),[selected,select]=React.useState(saved.selected.marketItemId??null);return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[]}><MarketPage visible navigationState={navigation} onNavigationChange={navigationChange(actions)} state={state} change={change} itemId={selected} intentId={null} open={id=>{const current=loadWorkbenchNavigationState(sessionStorage);persist({...current,selected:{...current.selected,marketItemId:id}});select(id??null)}} seed={null} clearSeed={()=>{}} contentApi={content} marketCatalogApi={catalog} skillInstallApi={skills} githubSourceApi={{pending:()=>undefined,recoveryMessage:()=>undefined}} marketPluginInstallApi={{pending:()=>undefined}} installations={{visible:false,selected:null,open:noWrite,market:()=>{}}} industryLoads={{loads:[],error:undefined,save:noWrite,recover:noWrite}} industryReview={{loads:[],upgrade:noWrite,rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:()=>{}}} saveResolved={noWrite} spaces={[]} targets={[]} planFromTemplate={noWrite} manageIndustryLoad={noWrite} update={noWrite} prepare={noWrite} capabilities={noWrite} nativeSettings={noWrite} nativeModels={noWrite} openRole={noWrite} configureBinding={noWrite} openTarget={noWrite}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const built=await build({root,configFile:false,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),formats:['iife'],name:'AppsNavigation'}}})
 const bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle);const script=bundle.output.find(row=>row.type==='chunk')!.code
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close());const errors:string[]=[]
 const open=async()=>{const context=await browser.newContext({viewport:{width:1280,height:1000}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{const url=route.request().url();return url==='http://127.0.0.1/'?route.fulfill({contentType:'text/html; charset=utf-8',body:'<!doctype html><meta charset=utf-8><div id="root"></div><script src="/fixture.js"></script>'}):url==='http://127.0.0.1/fixture.js'?route.fulfill({contentType:'text/javascript; charset=utf-8',body:script}):route.abort()});await page.goto('http://127.0.0.1/');return page}
 const page=await open();await page.getByRole('heading',{name:'应用',exact:true}).waitFor().catch(async (error:Error)=>{throw Error(error.message+'\n'+JSON.stringify({errors,body:await page.locator('body').innerText()}))});const mine=page.getByRole('button',{name:'我的应用 1',exact:true}),query=page.getByRole('searchbox',{name:'在应用和技能中搜索',exact:true})
 await mine.click();await query.fill('internal-comms');await page.getByRole('button',{name:/^internal-comms/}).click();await page.getByRole('dialog',{name:'internal-comms',exact:true}).getByText('原个人技能正文',{exact:true}).waitFor()
 await page.reload();await page.getByRole('dialog',{name:'internal-comms',exact:true}).getByText('原个人技能正文',{exact:true}).waitFor();await page.keyboard.press('Escape')
 assert.equal(await mine.getAttribute('aria-pressed'),'true');assert.equal(await query.inputValue(),'internal-comms');await page.getByRole('button',{name:/^internal-comms/}).waitFor()
 await query.fill('');await mine.click();const category=await page.evaluate(()=>(window as any).appsNavigation.categoryTitle);await page.getByRole('button',{name:category,exact:true}).click();await query.fill('官方远程');await page.getByRole('button',{name:/^官方远程连接器/}).waitFor()
 await page.reload();assert.equal(await page.getByRole('button',{name:category,exact:true}).getAttribute('aria-pressed'),'true');assert.equal(await mine.getAttribute('aria-pressed'),'false');assert.equal(await query.inputValue(),'官方远程');await page.getByRole('button',{name:/^官方远程连接器/}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).appsNavigation.writes),[])
 const isolated=await open();await isolated.getByRole('heading',{name:'应用',exact:true}).waitFor();assert.equal(await isolated.getByRole('button',{name:'我的应用 1',exact:true}).getAttribute('aria-pressed'),'false');assert.equal(await isolated.getByRole('searchbox').inputValue(),'');assert.deepEqual(errors,[])
})
