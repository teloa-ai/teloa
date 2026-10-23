import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'
import {buildSharePlan} from '../src/client/share-package-plan.ts'

// N26：template-share/v2 员工分享包通过「导入模板」抽屉的真实界面路径；
//   - 粘贴/上传有效包：不出"未知字段"错误，显示预览/确认区域（含员工名）
//   - 含疑似密钥的包：出现中文警告，不执行导入

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))

const skillText='---\nname: research-notes\ndescription: 整理调研要点\n---\n# 调研笔记\n收集来源与要点。'
const employeePkg=buildSharePlan({
  publisher:'Max',license:'CC-BY-4.0',subject:'employee',
  roles:[{id:'r1',name:'调研助理',kind:'employee' as const,duty:'整理行业资料。',dataScope:'提供的文档。',executionScope:'外部写入前确认。',skills:['research-notes'],knowledge:[]}],
  skills:[{name:'research-notes',title:'调研笔记',resourceId:'research-notes',version:'1.0.0',text:skillText,license:'MIT',publisher:'Max'}]
})

declare global {interface Window {shareImportFixture:{imports:string[];saved:string[];savedIds:string[];storedIds:(string|null)[];closed:number};loadFixture:{calls:Record<string,unknown>[]}}}
let browser:any,script:string,styles:string,temp:string,origin:string,server:ReturnType<typeof createServer>

const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';
import {MarketImportForm} from '${client}MarketForms.tsx';import {IndustryLoadForm} from '${client}IndustryLoadForm.tsx';import {BusinessScopeProvider} from '${client}business-scope-context.tsx';
import {I18nProvider} from '${client}i18n/provider.tsx';
import {translateMessage} from '${client}i18n/messages.ts';
import {prototypeThemes} from '${client}../brand/prototype-theme.ts';
import tokens from '${client}theme-tokens.module.css';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;
const locale='zh-CN',snapshot={locale,dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.shareImportFixture={imports:[],saved:[],savedIds:[],storedIds:[],closed:0};
const githubSourceApi={pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>{},resolve:async()=>{throw Error('fixture')}};
const contentApi={hydrate:async item=>item,importIndustry:async item=>{f.imports.push(item.title??item.id??'');return {...item,id:'imported-'+f.imports.length,contentStorage:{contentId:'c'.repeat(64),createdAt:'2026-10-16T00:00:00.000Z',loaded:true}}}};
const marketCatalogApi={list:async()=>({catalogVersion:'1',nextCursor:null,items:[],counts:{},skipped:{unknownKind:0,newerApp:0}})};
const mode=document.documentElement.dataset.mode||'paste';
function App(){const [open,setOpen]=React.useState(true);return React.createElement(I18nProvider,{runtime},open&&React.createElement(MarketImportForm,{githubSourceApi,contentApi,marketCatalogApi,openConnection:()=>{},items:[],mode,close:()=>{f.closed++;setOpen(false)},save:item=>{f.saved.push(item.title??item.id??'unknown');f.savedIds.push(item.id);f.storedIds.push(item.contentStorage?.contentId??null)},saveMany:items=>{f.saved.push(...items.map(i=>i.title??i.id??'unknown'))}}))}
// 加载确认抽屉夹具：条目与真实导入回包同形（manifest+packageContent，内容标识按是否已固定切换）。
const lf=window.loadFixture={calls:[]};
const loadManifest=JSON.parse(decodeURIComponent(document.documentElement.dataset.manifest||'%7B%7D'));
const loadable=document.documentElement.dataset.loadable==='1';
const loadItem={id:'load-item',kind:'bundle',title:loadManifest.title??'调研助理',version:loadManifest.version??'1.0.0',scope:loadManifest.scope??'general',visibility:'personal',summary:loadManifest.description??'',requirements:[],output:'',author:'本人导入',license:'MIT',source:{kind:'stored',contentId:'c'.repeat(64)},owner:'Teloa',compatibility:'',components:[],manifest:loadManifest,packageContent:{manifestPath:'teloa.json',hash:'a'.repeat(64),files:[],resources:(loadManifest.resources??[]).map(resource=>({id:resource.id,state:'available'}))},...(loadable?{contentStorage:{contentId:'c'.repeat(64),createdAt:'2026-10-16T00:00:00.000Z',loaded:true}}:{})};
function LoadApp(){return React.createElement(I18nProvider,{runtime},React.createElement(BusinessScopeProvider,{labels:[]},React.createElement(IndustryLoadForm,{item:loadItem,space:{id:'space-1',version:1},pending:undefined,recoveryError:undefined,load:async input=>{lf.calls.push(input)},recover:async()=>{}})))}
createRoot(document.getElementById('root')).render(React.createElement((document.documentElement.dataset.view||'import')==='load'?LoadApp:App));
`

before(async()=>{
  temp=await mkdtemp(join(root,'.runtime-market-share-'));await writeFile(join(temp,'fixture.tsx'),entry)
  const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketShareFixture',formats:['iife']}}})
  const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
  script=bundle.output.find(item=>item.type==='chunk')!.code
  styles=bundle.output.flatMap((item:any)=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
  browser=await loadPlaywright().chromium.launch(launchOptions())
  // crypto.subtle 在安全上下文可用：固定本机 HTTP 来源
  const loadManifest=JSON.parse(employeePkg.files.find(file=>file.path==='teloa.json')!.text)
  server=createServer((request,response)=>{const params=new URL(request.url??'/','http://x').searchParams;response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN" data-mode="'+(params.get('mode')||'paste')+'" data-view="'+(params.get('view')||'import')+'" data-loadable="'+(params.get('loadable')||'1')+'" data-manifest="'+encodeURIComponent(JSON.stringify(loadManifest))+'"><body><div id="root"></div></body></html>')})
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const addr=server.address();assert.ok(addr&&typeof addr==='object');origin='http://127.0.0.1:'+addr.port
  await mkdir('/tmp/teloa-walkthrough',{recursive:true})
})
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());if(temp)await rm(temp,{recursive:true,force:true})})

async function mountPage(t:any,query:string){
  const page=await browser.newPage({viewport:{width:1100,height:900}}),errors:string[]=[]
  page.setDefaultTimeout(8000);page.on('pageerror',(error:Error)=>errors.push(error.message))
  t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
  await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
  await page.goto(origin+'/?'+query)
  await page.addStyleTag({content:'body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
  await page.getByRole('dialog',{name:'导入模板',exact:true}).waitFor().catch(()=>{})
  return page
}
async function mount(t:any,mode:'paste'|'upload'){return mountPage(t,'mode='+mode)}

// 与其他行业模板相同：导入只保存为本人市场条目，由市场页关闭抽屉并打开该条目详情，不安装、不授权。
const noImportError=async(dialog:ReturnType<Awaited<ReturnType<typeof mount>>['getByRole']>)=>{
  const alertText=(await dialog.getByRole('alert').allInnerTexts().catch(()=>[] as string[])).join('\n')
  assert.doesNotMatch(alertText,/未知字段|稍后再试|Template /,'分享包导入不应出现内部或笼统错误')
}

test('粘贴有效员工分享包：固定内容后保存为市场条目，连续导入同样成功',async t=>{
  const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
  await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(employeePkg))
  await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
  await page.waitForFunction(()=>window.shareImportFixture.saved.length>=1,undefined,{timeout:5000})
  await page.screenshot({path:'/tmp/teloa-walkthrough/share-paste-after-submit.png'})
  await noImportError(dialog)
  let state=await page.evaluate(()=>window.shareImportFixture)
  assert.deepEqual(state.saved,['调研助理'])
  assert.equal(state.imports.length,1,'粘贴来源也必须先固定完整内容再保存，否则“确认加载”会因缺少 contentId 被禁用')
  assert.equal(state.savedIds[0],'imported-1')
  assert.equal(state.storedIds[0],'c'.repeat(64),'保存的市场条目必须携带已固定内容标识')
  // 连续导入：第二次仍走同一固定内容服务，不能因第一次保存就丢弃内容
  await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
  await page.waitForFunction(()=>window.shareImportFixture.saved.length>=2,undefined,{timeout:5000})
  state=await page.evaluate(()=>window.shareImportFixture)
  assert.deepEqual(state.saved,['调研助理','调研助理'])
  assert.equal(state.imports.length,2)
  assert.equal(state.savedIds[1],'imported-2')
  assert.equal(state.storedIds[1],'c'.repeat(64))
})

const bareManifest={format:'teloa.business-package/v2',id:'bare-team',version:'1.0.0',title:'只有清单',description:'缺少资源正文的清单',domain:'general',scope:'general',resources:[{id:'lead',kind:'role',title:'负责人',version:'1.0.0',required:true,source:{kind:'local',path:'roles/lead.json'}}],relations:[],entrypoints:[]}

test('只粘贴清单没有资源正文：明确说明无法加载并要求导入完整模板包，不保存半份模板',async t=>{
  const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
  await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(bareManifest))
  await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
  const alert=dialog.getByRole('alert');await alert.waitFor()
  const text=await alert.innerText()
  assert.match(text,/完整模板包|缺少资源正文/)
  const state=await page.evaluate(()=>window.shareImportFixture)
  assert.deepEqual(state.saved,[],'半份模板不应保存成无法加载的市场条目')
  assert.deepEqual(state.imports,[],'缺少资源正文时不应调用固定内容服务')
})

test('上传同一员工分享包文件：固定内容后保存为市场条目',async t=>{
  const page=await mount(t,'upload'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
  await dialog.getByLabel('模板文件',{exact:true}).setInputFiles({name:'employee-share.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(employeePkg))})
  await dialog.getByText('已选择：employee-share.json',{exact:true}).waitFor()
  await dialog.getByRole('button',{name:'读取模板',exact:true}).click()
  await page.waitForFunction(()=>window.shareImportFixture.saved.length>=1,undefined,{timeout:5000})
  await page.screenshot({path:'/tmp/teloa-walkthrough/share-upload-after-submit.png'})
  await noImportError(dialog)
  const state=await page.evaluate(()=>window.shareImportFixture)
  assert.deepEqual(state.saved,['调研助理'])
  assert.equal(state.imports.length,1,'上传来源先固定内容再保存')
})

test('含疑似密钥的分享包：界面出现中文警告，不执行导入',async t=>{
  const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
  const withCred=structuredClone(employeePkg) as {files:{path:string;text:string}[]}
  const skill=withCred.files.find(file=>file.path.endsWith('.md'))!
  skill.text+='\napi_key: '+'A'.repeat(24)
  await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(withCred))
  await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
  await dialog.getByRole('alert').waitFor()
  await page.screenshot({path:'/tmp/teloa-walkthrough/share-credential-warning.png'})
  const alertText=await dialog.getByRole('alert').innerText()
  assert.match(alertText,/模板含疑似密钥或账号信息/,'错误提示应为中文并包含"模板含疑似密钥或账号信息"')
  assert.doesNotMatch(alertText,/Template.*contains|Template seems|credential/i,'错误提示不应出现英文原文')
  const s=await page.evaluate(()=>window.shareImportFixture)
  assert.deepEqual(s.saved,[],'出现密钥警告时不应执行导入')
  assert.deepEqual(s.imports,[],'出现密钥警告时不应调用 importIndustry')
})

test('已固定内容的合法模板可以加载：确认按钮可用并提交原 contentId 与内容摘要',async t=>{
  const page=await mountPage(t,'view=load&loadable=1')
  const load=page.getByRole('button',{name:'加载',exact:true})
  await load.waitFor()
  assert.equal(await load.isDisabled(),false,'已固定内容的模板不应禁用加载')
  await load.click()
  await page.waitForFunction(()=>window.loadFixture.calls.length===1)
  const call=await page.evaluate(()=>window.loadFixture.calls[0]) as Record<string,any>
  assert.equal(call.contentId,'c'.repeat(64))
  assert.equal(call.contentHash,'a'.repeat(64))
  assert.deepEqual(call.target,{kind:'existing',spaceId:'space-1',expectedVersion:1})
  assert.equal(typeof call.requestId,'string')
})

test('旧条目缺少已固定内容：加载保持禁用并明确说明重新导入，不尝试提交',async t=>{
  const page=await mountPage(t,'view=load&loadable=0')
  const load=page.getByRole('button',{name:'加载',exact:true})
  await load.waitFor()
  assert.equal(await load.isDisabled(),true)
  const body=await page.locator('body').innerText()
  assert.match(body,/重新导入|重新匯入|Re-import/i)
  assert.deepEqual(await page.evaluate(()=>window.loadFixture.calls),[])
})
