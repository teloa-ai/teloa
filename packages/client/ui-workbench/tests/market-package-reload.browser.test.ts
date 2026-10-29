import assert from 'node:assert/strict'
import test from 'node:test'
import {fileURLToPath} from 'node:url'
import {mkdtemp,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用仓库现有独立浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),virtual=root+'__market_package_reload_fixture.tsx'
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {MarketPage} from '${client}MarketPage.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';import {readIndustryDirectory} from '${client}industry-directory.ts';import {ThemePresenter} from '${client}theme-presenter.ts';
new ThemePresenter().apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
const at='2026-10-29T00:00:00.000Z',contentId='44444444-4444-4444-8444-444444444444',spaceId='55555555-5555-4555-8555-555555555555',resetDigest='b'.repeat(64),trace=[];window.reloadFixture={trace,contentId,spaceId,resetDigest};
const manifest={format:'teloa.business-package/v2',id:'reload-fixture',title:'可重导入知识包',version:'1.0.0',domain:'general',scope:'general',description:'已加载同版本的重导入入口验收',resources:[{id:'guide',kind:'knowledge',title:'导入手册',version:'1.0.0',required:true,source:{kind:'local',path:'guide.md'}}],relations:[],entrypoints:[]};
const file=(path,text)=>{const bytes=new TextEncoder().encode(text);return {path,size:bytes.length,read:async()=>bytes}};
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},i18n={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage('zh-CN',key,params)},skills={list:async()=>({items:[],usages:[]}),pending:()=>undefined},api={pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>{}};
const save=async input=>{trace.push(structuredClone(input));if(!input.knowledgeResetDigest)throw {rejected:true,code:'teloa/conflict',details:{reason:'employee-knowledge-reset-required',knowledgeReset:{digest:resetDigest,documents:[{roleId:'10000000-0000-4000-8000-000000000001',resourceId:'20000000-0000-4000-8000-000000000001',knowledgeId:'30000000-0000-4000-8000-000000000001',bodyVersion:5,contentHash:'c'.repeat(64),title:'已修改员工手册'}]}}}};
function Ready({item}){const [state,setState]=React.useState({items:[item],intents:[]}),[selected,setSelected]=React.useState(item.id);const load={id:'11111111-1111-4111-8111-111111111111',ownerId:'fixture-owner',contentId,contentHash:item.packageContent.hash,templateId:manifest.id,templateVersion:manifest.version,templateTitle:manifest.title,domain:'general',scope:'general',description:'已加载',targetVersion:1,space:{id:spaceId,name:'本人工作空间',version:1,scope:'general'},items:[{localId:'guide',instanceId:'77777777-7777-4777-8777-777777777777',kind:'knowledge',title:'导入手册',version:'1.0.0',required:true,status:'active'}],relations:[],entrypoints:[],createdAt:at,mappingHash:'a'.repeat(64),status:'active'};window.reloadFixture.hash=item.packageContent.hash;
 return <BusinessScopeProvider labels={[]}><MarketPage visible state={state} change={setState} itemId={selected} intentId={null} open={id=>setSelected(id??null)} seed={null} clearSeed={()=>{}} installations={{visible:false,selected:null,open:()=>{},market:()=>{}}} skillInstallApi={skills} marketPluginInstallApi={{pending:()=>undefined}} industryLoads={{api,loads:[load],error:undefined,save,recover:async()=>{}}} industryReview={{loads:[load],upgrade:async()=>{},rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:()=>{}}} space={{id:spaceId,name:'本人工作空间',version:1,description:'',kind:'personal',createdAt:at,updatedAt:at}} saveResolved={()=>{}} spaces={[]} targets={[]} planFromTemplate={()=>{}} manageIndustryLoad={()=>{}} update={()=>{}} prepare={async()=>{}} capabilities={()=>{}} nativeSettings={()=>{}} nativeModels={()=>{}} openRole={()=>{}} configureBinding={()=>{}} openTarget={()=>{}} githubSourceApi={{pending:()=>undefined,recoveryMessage:()=>undefined}}/></BusinessScopeProvider>}
function App(){const [item,setItem]=React.useState();React.useEffect(()=>{void readIndustryDirectory([file('teloa.json',JSON.stringify(manifest)),file('guide.md','# 导入正文')],'teloa.json','重导入验收').then(value=>setItem({...value,id:'stored-'+contentId,contentStorage:{contentId,createdAt:at,loaded:true}}))},[]);return item?<Ready item={item}/>:null}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={i18n}><App/></I18nProvider>);`

test('市场同版本已加载仍可重新导入并复用知识覆盖确认，主按钮保持已添加',async t=>{
 const report=process.env.TELOA_ACCEPTANCE_REPORT_DIR??await mkdtemp(join(tmpdir(),'teloa-package-reload-'))
 const result=await build({configFile:false,root,logLevel:'error',plugins:[{name:'forbid-host-crypto',enforce:'pre' as const,resolveId(id:string){if(id==='node:crypto')return '\0forbid-host-crypto'},load(id:string){if(id==='\0forbid-host-crypto')return "function blocked(){throw Error('浏览器不允许调用宿主摘要算法')} export {blocked as createHash,blocked as createPublicKey,blocked as verify}"}},{name:'market-package-reload-fixture' ,resolveId:(id:string)=>id.endsWith('market-package-reload-fixture')?virtual:null,load:(id:string)=>id===virtual?entry:null}],define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:'market-package-reload-fixture',name:'MarketPackageReloadFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(row=>row.type==='chunk')!.code,css=bundle.output.filter((row:any)=>row.type==='asset'&&row.fileName.endsWith('.css')).map((row:any)=>String(row.source)).join('\n'),html='<!doctype html><html><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+css+'</style><body><div id="root"></div><script>'+script.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[],blocked:string[]=[]
 page.setDefaultTimeout(12000);page.on('pageerror',(cause:Error)=>errors.push(cause.message))
 await page.route('**/*',(route:any)=>{if(route.request().url()==='http://127.0.0.1:3199/market-reload-test')return route.fulfill({contentType:'text/html',body:html});blocked.push(route.request().url());return route.abort()})
 await page.goto('http://127.0.0.1:3199/market-reload-test')
 const primary=page.getByRole('button',{name:'已在我的团队里',exact:true}),reload=page.getByRole('button',{name:'重新导入此包',exact:true})
 await reload.waitFor();assert.equal(await primary.isDisabled(),true);assert.equal(await reload.isEnabled(),true)
 assert.equal(await page.evaluate(()=>(window as any).reloadFixture.trace.length),0)
 await reload.click();const confirm=page.getByRole('button',{name:'加载',exact:true});await confirm.waitFor();assert.equal(await confirm.isEnabled(),true)
 await confirm.click();const reset=page.getByRole('region',{name:'导入将覆盖本地知识',exact:true});await reset.waitFor();assert.match(await reset.innerText(),/已修改员工手册/)
 assert.equal(await page.evaluate(()=>(window as any).reloadFixture.trace.length),1)
 await reset.getByRole('button',{name:'确认覆盖并继续',exact:true}).click();await page.waitForFunction(()=>(window as any).reloadFixture.trace.length===2)
 const evidence=await page.evaluate(()=>(window as any).reloadFixture)
 assert.equal(evidence.trace[0].contentId,evidence.contentId);assert.equal(evidence.trace[0].contentHash,evidence.hash);assert.deepEqual(evidence.trace[0].target,{kind:'existing',spaceId:evidence.spaceId,expectedVersion:1})
 assert.deepEqual(evidence.trace[1],{...evidence.trace[0],knowledgeResetDigest:evidence.resetDigest});assert.equal(await primary.isDisabled(),true);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[])
 await writeFile(report+'/runtime-package-reload-browser-evidence.json',JSON.stringify({trace:evidence.trace,errors,blocked,primaryRemainsAdded:true},null,2))
})
