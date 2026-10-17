import test,{type TestContext} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用既有无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

async function personalSavedFixture(t:TestContext){
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-personal-saved-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 await writeFile(join(temp,'fixture.tsx'),`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketPage} from '${client}MarketPage.tsx';import {atomicSkillItem} from '${client}atomic-market.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';
const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','33333333-3333-4333-8333-333333333333'];
const stored=ids.slice(0,2).map((id,index)=>({...atomicSkillItem({id:'internal-comms',title:'internal-comms',version:'1.0.0',categories:[],hash:String(index+1).repeat(64),entryPath:'SKILL.md',text:'Original private skill '+index,files:[{path:'SKILL.md',hash:String(index+1).repeat(64),bytes:new TextEncoder().encode('Original private skill '+index)},...Array.from({length:6},(_,file)=>({path:'references/ref-'+file+'.md',hash:String(index+1).repeat(64),bytes:new TextEncoder().encode('原始附属文件 '+file)}))]}),id:'stored-'+id,source:{kind:'stored',contentId:id},author:'原作者',license:'MIT',trust:{repository:{host:'github.com',owner:'original-author',repo:'original-skills'}},contentStorage:{contentId:id,createdAt:'2026-10-16T00:00:00Z',loaded:true}}));
const manifest={format:'teloa.business-package/v2',id:'my-app',title:'个人事实应用',version:'1.0.0',domain:'general',scope:'general',description:'原应用包',resources:[{id:'app-skill',kind:'skill',title:'原应用方法',version:'1.0.0',required:true,source:{kind:'local',path:'skills/SKILL.md'}}],relations:[],entrypoints:[]};stored.push({id:'stored-'+ids[2],kind:'bundle',title:manifest.title,version:'1.0.0',scope:'general',visibility:'personal',summary:manifest.description,requirements:[],output:'原应用交付',author:'本人',license:'MIT',compatibility:'待核对',owner:'Teloa',components:[],source:{kind:'stored',contentId:ids[2]},hash:'3'.repeat(64),manifest,contentStorage:{contentId:ids[2],createdAt:'2026-10-16T00:00:00Z',loaded:true}});
const f=window.personalEvidence={opens:[],writes:[],listed:0,hydrateCalls:[],hydrateResolve:null,hydrateReject:null};const mode=window.personalHydrateMode??'immediate',summaries=stored.map(row=>{const {atomicSkill,...summary}=row;return atomicSkill?{...summary,contentStorage:{...row.contentStorage,loaded:false}}:row});const content={list:async()=>{f.listed++;return mode==='immediate'?stored:summaries},hydrate:async item=>{f.hydrateCalls.push(item.contentStorage.contentId);const full=stored.find(row=>row.id===item.id);return mode==='deferred'?new Promise((resolve,reject)=>{f.hydrateResolve=()=>resolve(full);f.hydrateReject=()=>reject(Error('原固定详情读取失败'))}):full},pending:()=>undefined,pendingGithubImport:()=>undefined};const noWrite=()=>{f.writes.push('unexpected');throw Error('禁止写入')};
const catalog={list:async()=>({catalogVersion:'fixture-1',items:[],nextCursor:null,counts:{role:0,skill:0,solution:0,dashboard:0,connector:0,model:0},skipped:{unknownKind:0,newerApp:0}}),ranking:async()=>new Map(),add:noWrite};const skills={list:async()=>({items:[],usages:[]}),pending:()=>undefined,recoveryMessage:()=>undefined,preview:async source=>{const item=stored.find(row=>row.contentStorage.contentId===source.contentId);return {source:{kind:'atomic',contentId:source.contentId,contentHash:item.hash,resourceId:'internal-comms',resourceVersion:'1.0.0'},bundleHash:item.hash,native:{name:'internal-comms',description:item.summary,modelInvocable:true,userInvocable:true,bodyHash:item.hash},files:[{path:'SKILL.md',hash:item.hash,size:29},...Array.from({length:6},(_,file)=>({path:'references/ref-'+file+'.md',hash:item.hash,size:16}))]}},install:noWrite,recover:noWrite};
function App(){const [state,setState]=React.useState({items:[],intents:[]}),[selected,setSelected]=React.useState(null);return <I18nProvider runtime={runtime}><BusinessScopeProvider labels={[]}><MarketPage visible navigationState={{category:window.personalInitialCategory??'apps',query:'',mobileLayer:'list'}} state={state} change={setState} itemId={selected} intentId={null} open={id=>{if(id)f.opens.push(id);setSelected(id??null)}} seed={null} clearSeed={()=>{}} contentApi={content} marketCatalogApi={catalog} skillInstallApi={skills} githubSourceApi={{pending:()=>undefined,recoveryMessage:()=>undefined}} marketPluginInstallApi={{pending:()=>undefined}} installations={{visible:false,selected:null,open:noWrite,market:()=>{}}} industryLoads={{loads:[],error:undefined,save:noWrite,recover:noWrite}} industryReview={{loads:[],upgrade:noWrite,rolesReady:true,rolesFailed:false,refreshRoles:()=>{},context:{industryRoles:[],tasks:[],plans:[]},open:()=>{}}} saveResolved={()=>{}} spaces={[]} targets={[]} planFromTemplate={noWrite} manageIndustryLoad={()=>{}} update={noWrite} prepare={noWrite} capabilities={()=>{}} nativeSettings={()=>{}} nativeModels={()=>{}} openRole={()=>{}} configureBinding={()=>{}} openTarget={()=>{}}/></BusinessScopeProvider></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'PersonalSavedFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 const mount=async(category='apps',mode='immediate')=>{await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.evaluate((value:{category:string;mode:string})=>{(window as any).personalInitialCategory=value.category;(window as any).personalHydrateMode=value.mode},{category,mode});await page.addScriptTag({content:script});await page.waitForFunction(()=>(window as any).personalEvidence.listed>0);await page.getByRole('heading',{name:category==='apps'?'应用':'已添加',exact:true}).waitFor()}
 return {page,mount,errors}
}

test('原未安装个人技能与应用包可从我的应用找回，同名不同内容独立打开且不进入推荐',{timeout:60000},async t=>{
 const {page,mount,errors}=await personalSavedFixture(t)
 await mount();assert.equal(await page.getByRole('button',{name:/internal-comms/}).count(),0,'本人固定内容不进官方浏览与推荐')
 await page.getByRole('button',{name:'我的应用 3',exact:true}).click()
 assert.equal(await page.getByRole('button',{name:/^internal-comms/}).count(),2)
 assert.match(await page.getByRole('button',{name:/^internal-comms/}).nth(0).innerText(),/原作者 · v1\.0\.0/)
 assert.equal(await page.getByText('已保存，待安装',{exact:true}).count(),2)
 await page.getByRole('button',{name:/^internal-comms/}).nth(1).click();await page.getByRole('dialog',{name:'internal-comms',exact:true}).waitFor().catch(async (error:Error)=>{throw Error(error.message+'\n'+await page.locator('body').innerText()+'\n'+JSON.stringify({evidence:await page.evaluate(()=>(window as any).personalEvidence),errors}))});assert.match(await page.getByRole('dialog').innerText(),/Original private skill 1/)
 assert.deepEqual(await page.evaluate(()=>(window as any).personalEvidence.opens),['stored-22222222-2222-4222-8222-222222222222'])
 const detail=page.getByRole('dialog',{name:'internal-comms',exact:true})
 await detail.getByRole('button',{name:'安装到当前 Teloa',exact:true}).waitFor()
 await detail.locator('details').filter({has:page.locator('summary').filter({hasText:'7 个附属文件'})}).locator('summary').click()
 assert.match(await detail.innerText(),/references\/ref-5\.md/)
 assert.equal(await detail.getByRole('heading',{name:'工作要求与交付',exact:true}).count(),0)
 assert.equal(await detail.getByRole('heading',{name:'组成依赖',exact:true}).count(),0)
 assert.equal(await detail.getByRole('heading',{name:'来源与运行归属',exact:true}).count(),0)
 assert.equal(await detail.getByRole('button',{name:'在会话中完善模板',exact:true}).count(),0)
 assert.doesNotMatch(await detail.innerText(),/22222222-2222-4222-8222-222222222222|DSH 生态/)
 await detail.locator('summary').filter({hasText:'来源与版本'}).click()
 assert.match(await detail.innerText(),/原作者/);assert.match(await detail.innerText(),/MIT/)
 assert.equal(await detail.getByRole('link',{name:'original-author/original-skills',exact:true}).getAttribute('href'),'https://github.com/original-author/original-skills')
 await page.keyboard.press('Escape');await page.getByRole('button',{name:/^个人事实应用/}).click();await page.getByRole('dialog',{name:'个人事实应用',exact:true}).waitFor().catch(async (error:Error)=>{throw Error(error.message+'\n'+await page.locator('body').innerText()+'\n'+JSON.stringify({evidence:await page.evaluate(()=>(window as any).personalEvidence),errors}))})
 assert.equal((await page.evaluate(()=>(window as any).personalEvidence.opens)).at(-1),'stored-33333333-3333-4333-8333-333333333333')
 await mount('intents');assert.equal(await page.getByRole('heading',{name:'还没有添加模板',exact:true}).count(),0);await page.getByRole('button',{name:'我的应用与技能',exact:true}).click();await page.getByRole('button',{name:/^internal-comms/}).nth(0).click();await page.getByRole('dialog',{name:'internal-comms',exact:true}).waitFor();assert.match(await page.getByRole('dialog').innerText(),/Original private skill 0/)
 assert.deepEqual(await page.evaluate(()=>(window as any).personalEvidence.writes),[]);assert.deepEqual(errors,[])
})


test('技能摘要延迟读取和失败始终不显示泛方案或安装入口，关闭重开可继续读取原内容',{timeout:60000},async t=>{
 const {page,mount,errors}=await personalSavedFixture(t)
 await mount('apps','deferred');await page.getByRole('button',{name:'我的应用 3',exact:true}).click()
 await page.getByRole('button',{name:/^internal-comms/}).nth(0).click()
 const detail=page.getByRole('dialog',{name:'internal-comms',exact:true})
 await detail.waitFor();await page.waitForFunction(()=>(window as any).personalEvidence.hydrateCalls.length===1)
 const summaryOnly=async()=>{
  for(const name of ['工作要求与交付','组成依赖','来源与运行归属'])assert.equal(await detail.getByRole('heading',{name,exact:true}).count(),0)
  assert.equal(await detail.getByRole('button',{name:'安装到当前 Teloa',exact:true}).count(),0)
  assert.equal(await detail.getByText('Original private skill 0',{exact:true}).count(),0)
 }
 await summaryOnly();await detail.getByRole('status').getByText('正在读取技能内容…',{exact:true}).waitFor()
 await page.evaluate(()=>(window as any).personalEvidence.hydrateReject())
 await detail.getByRole('alert').getByText('已保存内容的详情读取失败。',{exact:true}).waitFor();await summaryOnly()
 await page.keyboard.press('Escape');await page.getByRole('button',{name:'我的应用 3',exact:true}).waitFor()
 await page.getByRole('button',{name:/^internal-comms/}).nth(0).click();await page.waitForFunction(()=>(window as any).personalEvidence.hydrateCalls.length===2)
 await summaryOnly();await page.evaluate(()=>(window as any).personalEvidence.hydrateResolve())
 await detail.getByText('Original private skill 0',{exact:true}).waitFor();await detail.getByRole('button',{name:'安装到当前 Teloa',exact:true}).waitFor()
 assert.deepEqual(await page.evaluate(()=>(window as any).personalEvidence.hydrateCalls),['11111111-1111-4111-8111-111111111111','11111111-1111-4111-8111-111111111111'])
 assert.deepEqual(await page.evaluate(()=>(window as any).personalEvidence.writes),[]);assert.deepEqual(errors,[])
})
