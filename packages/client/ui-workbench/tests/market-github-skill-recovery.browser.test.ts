import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const requestId='11111111-1111-4111-8111-111111111111',skillInput={githubRequestId:requestId,skillPath:'skills/original/SKILL.md'}
let browser:any,script:string,temp:string,origin:string,server:ReturnType<typeof createServer>
// 使用真实来源 API 解析和恢复原请求；宿主回执与能力导入均为本机受控替身，不访问 GitHub。
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {MarketImportForm} from '${client}MarketForms.tsx';import {createGithubSourceApi} from '${client}github-source-api.ts';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
const snapshot={locale:'zh-CN',dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.recoveryFixture={calls:[],imports:[],templates:[],saved:[],drafts:{},holdSource:false,holdImport:false,failImport:false};
const skill=document.documentElement.dataset.kind!=='template',request={requestId:'${requestId}',owner:'teloa-ai',repo:'examples',ref:'frozen',...(skill?{path:'skills/original'}:{})};
const original=skill?'---\\nname: original\\ndescription: Original static skill\\n---\\nOnly original text.\\n':JSON.stringify({format:'teloa.business-package/v2',id:'original-template',version:'1.0.0',title:'原模板',description:'原模板说明',domain:'general',scope:'general',resources:[],relations:[],entrypoints:[]});
const bytes=new TextEncoder().encode(original),filePath=skill?'skills/original/SKILL.md':'teloa.json';
const sourceApis=[0,1].map(owner=>{let raw=owner===0?JSON.stringify({schema:'teloa.github-source/v1',request}):null;return createGithubSourceApi(async(method,input)=>{f.calls.push({owner,method,input});if(f.holdSource)await new Promise(resolve=>f.releaseSource=()=>{f.holdSource=false;resolve()});const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');return {requestId:input.requestId,ownerId:'self',stage:'ready',provenance:{kind:'github',owner:input.owner,repo:input.repo,requestedRef:input.ref,resolvedCommit:'a'.repeat(40),archiveHash:'b'.repeat(64),...(input.path?{path:input.path}:{})},files:[{path:filePath,hash,base64:btoa(String.fromCharCode(...bytes))}],createdAt:'2026-10-15T00:00:00.000Z',updatedAt:'2026-10-15T00:00:00.000Z'}},{read:()=>raw,write:value=>raw=value,clear:()=>raw=null})});
const contentApis=[0,1].map(owner=>({importGithubSkill:async input=>{f.imports.push({owner,input});if(f.holdImport)await new Promise(resolve=>f.releaseImport=()=>{f.holdImport=false;resolve()});if(f.failImport){f.failImport=false;throw Error('原技能导入结果未知')}return {id:'original-skill-'+owner}},importGithub:async input=>{f.templates.push({owner,input});return {id:'original-template-'+owner}}}));
function App(){const [owner,setOwner]=React.useState(0),[open,setOpen]=React.useState(true);f.owner=value=>setOwner(value);f.open=value=>setOpen(value);React.useEffect(()=>{f.currentOwner=owner},[owner]);return <I18nProvider runtime={runtime}><button onClick={()=>setOpen(true)}>打开原导入</button>{open&&<MarketImportForm githubSourceApi={sourceApis[owner]} contentApi={contentApis[owner]} items={[]} mode="github" draft={f.drafts[owner]} onDraft={value=>f.drafts[owner]=value} close={()=>setOpen(false)} save={item=>f.saved.push({owner,id:item.id})} saveMany={()=>{throw Error('不能批量保存')}}/>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-market-github-recovery-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketGithubRecovery',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code
 browser=await loadPlaywright().chromium.launch(launchOptions())
 server=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html data-kind="'+(new URL(request.url??'/','http://x').searchParams.get('kind')||'skill')+'"><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port
})
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,kind='skill'){
 const page=await browser.newPage({viewport:{width:1280,height:1000}}),errors:string[]=[];page.setDefaultTimeout(3500);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort());await page.goto(origin+'/?kind='+kind);await page.addScriptTag({content:script});await page.getByRole('dialog',{name:'导入模板',exact:true}).waitFor();return page
}
const state=(page:any)=>page.evaluate(()=>(window as any).recoveryFixture)
const recover=(page:any)=>page.getByRole('button',{name:'检查获取结果',exact:true}).click()

test('恢复带 path 的原 GitHub 请求只按回执导入技能，不因当前默认模板选项转为行业模板',async t=>{
 const page=await mount(t);await recover(page);await page.waitForFunction(()=>(window as any).recoveryFixture.saved.length===1||[...document.querySelectorAll('button')].some(button=>button.textContent==='导入为模板'))
 const actual=await state(page);assert.equal(actual.calls.length,1);assert.equal(actual.calls[0].input.requestId,requestId);assert.deepEqual(actual.imports,[{owner:0,input:skillInput}]);assert.deepEqual(actual.templates,[]);assert.deepEqual(actual.saved,[{owner:0,id:'original-skill-0'}]);assert.equal(await page.getByText('未找到行业模板',{exact:true}).count(),0)
})

test('无 path 的原 GitHub 模板恢复仍先显示固定来源预览，不自动导入',async t=>{
 const page=await mount(t,'template');await recover(page);await page.getByRole('button',{name:'导入为模板',exact:true}).waitFor()
 const actual=await state(page);assert.equal(actual.calls.length,1);assert.equal(actual.calls[0].input.path,undefined);assert.deepEqual(actual.imports,[]);assert.deepEqual(actual.templates,[]);assert.deepEqual(actual.saved,[])
})

test('技能导入结果未知后关闭重开继续同来源和路径，不重新获取 GitHub',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).recoveryFixture.failImport=true);await recover(page);await page.getByRole('alert').waitFor();await page.keyboard.press('Escape');await page.getByRole('dialog').waitFor({state:'detached'});await page.getByRole('button',{name:'打开原导入',exact:true}).click()
 await page.getByRole('button',{name:'核对未完成导入',exact:true}).click();await page.waitForFunction(()=>(window as any).recoveryFixture.saved.length===1)
 const actual=await state(page);assert.equal(actual.calls.length,1);assert.deepEqual(actual.imports,[{owner:0,input:skillInput},{owner:0,input:skillInput}]);assert.deepEqual(actual.saved,[{owner:0,id:'original-skill-0'}])
})

test('来源核回于 API 换代后不自动导入，返回原本人只沿已核回执继续',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).recoveryFixture.holdSource=true);await recover(page);await page.waitForFunction(()=>(window as any).recoveryFixture.calls.length===1);await page.evaluate(()=>(window as any).recoveryFixture.owner(1));await page.waitForFunction(()=>(window as any).recoveryFixture.currentOwner===1);assert.equal(await page.getByPlaceholder('https://github.com/owner/repo').isEnabled(),true,'新本人不等待旧来源请求');await page.evaluate(()=>(window as any).recoveryFixture.releaseSource());await page.waitForTimeout(50)
 assert.deepEqual((await state(page)).imports,[]);assert.deepEqual((await state(page)).saved,[]);assert.equal(await page.getByRole('button',{name:'核对未完成导入',exact:true}).count(),0)
 await page.evaluate(()=>(window as any).recoveryFixture.owner(0));await page.getByRole('button',{name:'核对未完成导入',exact:true}).click();await page.waitForFunction(()=>(window as any).recoveryFixture.saved.length===1);assert.equal((await state(page)).calls.length,1);assert.deepEqual((await state(page)).imports,[{owner:0,input:skillInput}])
})

test('能力导入完成于卸载期间时只向原本人交付一次回执，不重复导入',async t=>{
 const page=await mount(t);await page.evaluate(()=>(window as any).recoveryFixture.holdImport=true);await recover(page);await page.waitForFunction(()=>(window as any).recoveryFixture.imports.length===1);await page.evaluate(()=>(window as any).recoveryFixture.open(false));await page.getByRole('dialog').waitFor({state:'detached'});await page.evaluate(()=>{(window as any).recoveryFixture.owner(1);(window as any).recoveryFixture.open(true)});await page.waitForFunction(()=>(window as any).recoveryFixture.currentOwner===1);await page.evaluate(()=>(window as any).recoveryFixture.releaseImport());await page.waitForTimeout(50);assert.deepEqual((await state(page)).saved,[])
 await page.evaluate(()=>(window as any).recoveryFixture.owner(0));await page.waitForFunction(()=>(window as any).recoveryFixture.saved.length===1);await page.evaluate(()=>(window as any).recoveryFixture.open(false));await page.getByRole('button',{name:'打开原导入',exact:true}).click();await page.waitForTimeout(50)
 const actual=await state(page);assert.equal(actual.calls.length,1);assert.deepEqual(actual.imports,[{owner:0,input:skillInput}]);assert.deepEqual(actual.saved,[{owner:0,id:'original-skill-0'}])
})

test('未知技能导入可明确丢弃本地恢复记录，回原入口选择新来源且不再派发请求',async t=>{
 const page=await mount(t);await page.evaluate(()=>{(window as any).recoveryFixture.holdImport=true;(window as any).recoveryFixture.failImport=true});await recover(page);await page.waitForFunction(()=>(window as any).recoveryFixture.imports.length===1)
 const discard=page.getByRole('button',{name:'丢弃这条恢复记录',exact:true});assert.equal(await discard.isDisabled(),true,'提交期间不能丢弃本地恢复记录');await page.evaluate(()=>(window as any).recoveryFixture.releaseImport());await page.getByRole('alert').waitFor()
 const before=await state(page);await discard.click();assert.match(await page.getByRole('status').innerText(),/已丢弃本地恢复记录.*如果上一次请求已经生效/);assert.equal(await page.getByRole('alert').count(),0);assert.equal(await page.getByRole('button',{name:'核对未完成导入',exact:true}).count(),0);await page.getByPlaceholder('https://github.com/owner/repo').fill('https://github.com/teloa-ai/new-source')
 const after=await state(page);assert.deepEqual(after.calls,before.calls);assert.deepEqual(after.imports,before.imports);assert.deepEqual(after.saved,[]);assert.equal(after.calls.length,1);assert.deepEqual(after.imports,[{owner:0,input:skillInput}]);await page.evaluate(()=>(window as any).recoveryFixture.owner(1));await page.waitForFunction(()=>(window as any).recoveryFixture.currentOwner===1);assert.equal(await page.getByRole('status').count(),0,'本人的丢弃反馈不带到另一个 API')
})
