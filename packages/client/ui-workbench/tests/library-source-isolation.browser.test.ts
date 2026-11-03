import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {mkdtemp,rm,writeFile,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用工作树无头浏览器加载器。
import {loadPlaywright,launchOptions} from './fixtures/load-playwright.mjs'

let browser:any,html:string
before(async()=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url)),temp=await mkdtemp(join(root,'.runtime-library-source-'))
 try{
  await writeFile(join(temp,'fixture.tsx'),`
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {ResourceManager} from ${JSON.stringify(join(client,'ResourceManager.tsx'))};
import {I18nProvider} from ${JSON.stringify(join(client,'i18n/provider.tsx'))};
import {translateMessage} from ${JSON.stringify(join(client,'i18n/messages.ts'))};
import {prototypeThemes} from ${JSON.stringify(join(client,'../brand/prototype-theme.ts'))};
import tokens from ${JSON.stringify(join(client,'theme-tokens.module.css'))};
const params=new URL(location.href).searchParams,mode=params.get('mode'),locale=params.get('locale')||'zh-CN',stamp='2026-10-28T00:00:00Z',hash='a'.repeat(64);
const local={id:'11111111-1111-4111-8111-111111111111',ownerId:'self',title:'原本机资料',sourceId:'local_material_11111111-1111-4111-8111-111111111111',sourceVersion:hash,scopeIds:['general'],status:'active',version:1,createdAt:stamp,updatedAt:stamp};
const healthy={...local,id:'22222222-2222-4222-8222-222222222222',title:'正常资料',sourceId:'local_material_22222222-2222-4222-8222-222222222222'};
const draft={...local,id:'33333333-3333-4333-8333-333333333333',requestId:'44444444-4444-4444-8444-444444444444',title:'原本机草稿',status:'draft'};
const localSource={id:local.sourceId,title:local.title,source:'docs/original.md',version:mode==='changed'?'b'.repeat(64):hash,bytes:40},healthySource={id:healthy.sourceId,title:healthy.title,source:'docs/healthy.md',version:hash,bytes:40};
let available=mode!=='missing',sourcesDenied=false;const evidence=window.sourceIsolation={writes:[],uses:[],clipboard:[],reads:0,sourceReads:0,setAvailable:value=>available=value,denySources:value=>sourcesDenied=value,localSourceId:local.sourceId,hash};Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>evidence.clipboard.push(text)}});
const api={directory:async()=>({drafts:mode==='draft'?[draft]:[],resources:[local,healthy]}),sources:async()=>{evidence.sourceReads++;if(sourcesDenied)throw Object.assign(Error('来源许可已拒绝'),{code:'teloa/forbidden'});return [healthySource,...available?[localSource]:[]]},knowledgeTree:async()=>({space:{id:'space',ownerId:'self',workspaceId:'default',title:'资料空间',rootNodeId:'root',directoryRevision:1,scopeIds:['general'],createdAt:stamp,updatedAt:stamp},nodes:[{id:'root',spaceId:'space',parentId:null,type:'space',title:'资料空间',path:['root'],siblingOrder:0,createdAt:stamp,updatedAt:stamp}]}),readContent:async resource=>{evidence.reads++;if(resource.id===local.id&&(!available||mode==='read-failure'))throw Object.assign(Error('原件暂不可读'),{code:'teloa/forbidden'});if(resource.id===local.id&&mode==='loading')await new Promise(resolve=>{evidence.finishRead=resolve});return {resource,text:'# 上次成功读取正文'}},update:async input=>{evidence.writes.push(input);throw Error('禁止写入')},apply:async input=>{evidence.writes.push(input);throw Error('禁止写入')}};
const snapshot={locale,dshLocale:locale,revision:1},runtime={subscribe:()=>()=>{},getSnapshot:()=>snapshot,t:(key,params)=>translateMessage(locale,key,params)};
function App(){const [visible,setVisible]=useState(true);return <div className={tokens.tokens} style={{...prototypeThemes.light,height:'100vh'}}><button onClick={()=>setVisible(value=>!value)}>切换目录可见</button><ResourceManager api={api} visible={visible} selectedDraftId={mode==='draft'?draft.id:null} targetResource={null} clearTarget={()=>{}} openConversation={()=>{throw Error('禁止模型')}} onUseResource={resource=>evidence.uses.push({id:resource.id,version:resource.version})}/></div>}
createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><App/></I18nProvider>);
`)
  const built=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},plugins:[{name:'block-host-crypto',enforce:'pre',resolveId(id){if(id==='node:crypto')return '\0blocked-crypto'},load(id){if(id==='\0blocked-crypto')return "function blocked(){throw Error('本测试不执行宿主摘要')}export{blocked as createHash,blocked as createPublicKey,blocked as verify}"}}],build:{write:false,minify:false,lib:{entry:join(temp,'fixture.tsx'),name:'LibrarySourceIsolation',formats:['iife']}}}),bundle=Array.isArray(built)?built[0]:built;assert.ok(bundle&&'output'in bundle)
  html='<html><meta charset="utf-8"><style>body{margin:0}*{box-sizing:border-box}'+bundle.output.flatMap(row=>row.type==='asset'&&row.fileName.endsWith('.css')?[String(row.source)]:[]).join('\n')+'</style><body><div id="root"></div><script>'+bundle.output.find((row):row is Extract<typeof row,{type:'chunk'}>=>row.type==='chunk'&&row.isEntry)!.code.replace(/<\/script/gi,'<\\/script')+'</script></body></html>'
 }finally{await rm(temp,{recursive:true,force:true})}
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(()=>browser?.close())
async function mount(t:any,mode:string,locale='zh-CN'){
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(4000);const errors:string[]=[],network:string[]=[]
 page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{const url=new URL(route.request().url());if(url.origin==='https://fixture.invalid'&&url.pathname==='/source-isolation')return route.fulfill({contentType:'text/html',body:html});network.push(url.origin+url.pathname);return route.abort()})
 t.after(async()=>{await page.close();assert.deepEqual(errors,[]);assert.deepEqual(network,[])})
 await page.goto('https://fixture.invalid/source-isolation?mode='+mode+'&locale='+locale);await page.waitForFunction(()=>Boolean((window as any).sourceIsolation?.sourceReads)).catch(async(error:unknown)=>{t.diagnostic(JSON.stringify({errors,body:(await page.locator('body').innerText()).slice(0,1500)}));throw error});return page
}
async function refresh(page:any){const count=await page.evaluate(()=>(window as any).sourceIsolation.sourceReads);await page.getByRole('button',{name:'切换目录可见',exact:true}).click();await page.getByRole('button',{name:'切换目录可见',exact:true}).click();await page.waitForFunction((before:number)=>(window as any).sourceIsolation.sourceReads>before,count)}
async function screenshot(page:any,name:string){const out=process.env.TELOA_LIBRARY_SOURCE_EVIDENCE;if(out){await mkdir(out,{recursive:true});await page.screenshot({path:join(out,name+'.png'),fullPage:true})}}

async function readerActions(page:any){const summary=page.locator('[data-library-reader]>header details>summary');if(await summary.count()&&!await summary.evaluate((node:HTMLElement)=>node.parentElement?.hasAttribute('open')))await summary.click()}
async function readerInfo(page:any,locale:string){await page.getByRole('button',{name:locale==='en'?'File information':locale==='zh-CN'?'文件信息':'檔案資訊',exact:true}).click();const panel=page.getByRole('complementary',{name:locale==='en'?'Page details':locale==='zh-CN'?'页面信息':'頁面資訊',exact:true});await panel.locator('details>summary').first().click();return panel}

test('坏来源不让已登记资料消失，也不继续显示为可引用；三语状态一致',async t=>{
 for(const [locale,all,unavailable,available] of [['zh-CN','全部资料','来源暂不可用','可引用'],['zh-Hant','全部資料','來源暫時無法使用','可引用'],['en','All materials','Source temporarily unavailable','Available']]){
  const page=await mount(t,'missing',locale);await page.getByRole('button',{name:all,exact:true}).click();const row=page.getByRole('row').filter({has:page.locator('[data-teloa-entry="11111111-1111-4111-8111-111111111111"]')});await row.getByText(unavailable,{exact:true}).waitFor();assert.equal(await row.getByText(available,{exact:true}).count(),0);assert.equal(await page.locator('[data-teloa-entry="22222222-2222-4222-8222-222222222222"]').count(),1);await screenshot(page,'missing-list-'+locale)
  assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
 }
})

test('同一资料来源失效立即撤销旧缓存的引用就绪，重试恢复仍绑定原版本',async t=>{
 const page=await mount(t,'cache');await page.getByRole('button',{name:'全部资料',exact:true}).click();await page.locator('[data-teloa-entry="11111111-1111-4111-8111-111111111111"]').click();await page.getByRole('heading',{name:'上次成功读取正文',exact:true}).waitFor();await readerActions(page);const use=page.getByRole('button',{name:'用于任务',exact:true});await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='用于任务')?.disabled)
 await page.evaluate(()=>(window as any).sourceIsolation.setAvailable(false));await refresh(page);await page.getByRole('alert').filter({hasText:'来源暂不可用'}).waitFor();assert.equal(await use.isDisabled(),true,'来源消失后不能沿用成功缓存继续用于任务');assert.equal(await page.getByRole('heading',{name:'上次成功读取正文',exact:true}).count(),0);await screenshot(page,'missing-open-document')
 await page.evaluate(()=>(window as any).sourceIsolation.setAvailable(true));await page.getByRole('button',{name:'重新读取原版本',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='用于任务')?.disabled);await use.click();assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.uses),[{id:'11111111-1111-4111-8111-111111111111',version:1}]);assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
})

test('来源缺失后的刷新保留正在编辑草稿的名称与原来源版本，禁止误保存改绑',async t=>{
 const page=await mount(t,'draft'),name=page.getByRole('textbox',{name:'名称',exact:true});await name.waitFor();await name.fill('未提交的原草稿标题');const source=page.getByRole('combobox'),original=await source.inputValue();assert.equal(original,'local_material_11111111-1111-4111-8111-111111111111')
 await page.evaluate(()=>(window as any).sourceIsolation.setAvailable(false));await refresh(page);await page.getByRole('status').filter({hasText:'来源暂不可用'}).waitFor();assert.equal(await source.inputValue(),original,'不能改绑为正常资料来源');assert.equal(await name.inputValue(),'未提交的原草稿标题');await page.getByText('a'.repeat(64),{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'保存草案',exact:true}).isDisabled(),true);await screenshot(page,'missing-editing-draft');assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
})

test('本机资料缺源、读取失败或来源变版时复制引用不可用且没有剪贴板或业务写入',async t=>{
 for(const mode of ['missing','read-failure','changed']){
  const page=await mount(t,mode);await page.getByRole('button',{name:'全部资料',exact:true}).click();await page.locator('[data-teloa-entry="11111111-1111-4111-8111-111111111111"]').click();await page.getByRole('alert').first().waitFor();await readerActions(page);const copy=page.getByRole('button',{name:'复制引用',exact:true})
  assert.equal(await copy.isDisabled(),true,mode+'不能复制尚未核实的固定引用');await copy.evaluate((button:HTMLButtonElement)=>button.click());assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.clipboard),[]);assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
 }
})

test('目录整体拒绝撤销本机缓存与引用就绪，保留原对象和草稿且恢复只读取原版本',async t=>{
 const page=await mount(t,'cache');await page.getByRole('button',{name:'全部资料',exact:true}).click();await page.locator('[data-teloa-entry="11111111-1111-4111-8111-111111111111"]').click();await page.getByRole('heading',{name:'上次成功读取正文',exact:true}).waitFor();await readerActions(page);const use=page.getByRole('button',{name:'用于任务',exact:true}),copy=page.getByRole('button',{name:'复制引用',exact:true});await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='用于任务')?.disabled)
 await page.evaluate(()=>(window as any).sourceIsolation.denySources(true));await refresh(page);await page.getByRole('alert').first().waitFor();assert.equal(await use.isDisabled(),true,'目录刷新被拒后不能沿用上次来源许可交办');assert.equal(await copy.isDisabled(),true);assert.equal(await page.getByRole('heading',{name:'上次成功读取正文',exact:true}).count(),0);await page.getByRole('heading',{name:'原本机资料',exact:true}).waitFor();await screenshot(page,'source-directory-rejected')
 await copy.evaluate((button:HTMLButtonElement)=>button.click());assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.clipboard),[]);assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.uses),[])
 await page.evaluate(()=>(window as any).sourceIsolation.denySources(false));await page.getByRole('button',{name:'重新读取原版本',exact:true}).click();await page.waitForFunction(()=>!Array.from(document.querySelectorAll('button')).find(button=>button.textContent==='用于任务')?.disabled);assert.equal(await copy.isDisabled(),false);await copy.click();assert.equal((await page.evaluate(()=>(window as any).sourceIsolation.clipboard)).length,1);assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
 const draftPage=await mount(t,'draft'),name=draftPage.getByRole('textbox',{name:'名称',exact:true});await name.waitFor();await name.fill('整体拒绝仍保留草稿');await draftPage.evaluate(()=>(window as any).sourceIsolation.denySources(true));await refresh(draftPage);await draftPage.getByRole('alert').first().waitFor();assert.equal(await name.inputValue(),'整体拒绝仍保留草稿');assert.equal(await draftPage.getByRole('combobox').inputValue(),'local_material_11111111-1111-4111-8111-111111111111');await draftPage.getByText('a'.repeat(64),{exact:true}).waitFor();assert.equal(await draftPage.getByRole('button',{name:'保存草案',exact:true}).isDisabled(),true);assert.deepEqual(await draftPage.evaluate(()=>(window as any).sourceIsolation.writes),[])
})


const sourceStatusLocales=[
 ['zh-CN','全部资料','版本已变化','读取中','读取失败','可引用','页面信息','页面状态'],
 ['zh-Hant','全部資料','版本已變更','讀取中','讀取失敗','可引用','頁面資訊','頁面狀態'],
 ['en','All materials','Version changed','Reading','Read failed','Available for citation','Page details','Page status'],
] as const

test('本机原件变版时列表状态明确显示版本变化，三语不再标可引用',async t=>{
 for(const [locale,all,changed] of sourceStatusLocales){
  const page=await mount(t,'changed',locale);await page.getByRole('button',{name:all,exact:true}).click();const row=page.getByRole('row').filter({has:page.locator('[data-teloa-entry="11111111-1111-4111-8111-111111111111"]')});assert.equal(await row.getByText(changed,{exact:true}).count(),1,'变版列表不能继续声称可引用');await screenshot(page,'version-list-'+locale);assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
 }
})

for(const mode of ['changed','loading','read-failure'] as const)test('本机原件页面状态如实显示'+mode+'且保留固定版本（三语）',async t=>{
 for(const [locale,all,changed,reading,failed,available,infoLabel,statusLabel] of sourceStatusLocales){
  const page=await mount(t,mode,locale);await page.getByRole('button',{name:all,exact:true}).click();await page.locator('[data-teloa-entry="11111111-1111-4111-8111-111111111111"]').click();const info=await readerInfo(page,locale),status=info.locator('dl').filter({has:page.getByText(statusLabel,{exact:true})}).locator('div').filter({has:page.getByText(statusLabel,{exact:true})}).locator('dd');await info.waitFor();
  const expected=mode==='changed'?changed:mode==='loading'?reading:failed;await page.waitForFunction(()=>Boolean((window as any).sourceIsolation.reads));assert.equal(await status.innerText(),expected,'尚未核验有效的原件不能标可引用');await screenshot(page,'version-status-'+mode+'-'+locale);
  if(mode==='loading'){await page.evaluate(()=>(window as any).sourceIsolation.finishRead());await page.getByRole('heading',{name:'上次成功读取正文',exact:true}).waitFor();assert.equal(await status.innerText(),available,'仅固定版本读取成功后恢复可引用');}
  assert.deepEqual(await page.evaluate(()=>(window as any).sourceIsolation.writes),[])
 }
})
