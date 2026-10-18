import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// N24：Grok Bot recipe.json 上传/粘贴先轻量预览，确认后才经原 importIndustry 保存；预览不写入、不授权。
// 夹具为原创内容，不复制任何公开 recipe 原件。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string,origin:string,server:ReturnType<typeof createServer>
declare global {interface Window {recipeFixture:{imports:Array<{sourceKind:string;name?:string;recipe:boolean;files:number;manifestFormat:string;scope:string;pluginStates:string[];mappedTools:string[]}>;saved:string[];closed:number;catalogReads:number;catalogVersion:string;parentRenders:number;reopen:()=>void;holdImport:boolean;release?:()=>void}}}
const recipe={
 profile:{name:'调研助理',title:'市场调研助理',description:'整理公开行业资料并形成简报，不代替本人判断。'},
 memory:[{kind:'profile',content:'偏好简体中文的要点式简报。'}],
 skills:[{name:'竞品速览',description:'按固定清单整理竞品公开信息。',content:'# 竞品速览\n\n列出名称、定位、价格与来源链接。'},{name:'周报草稿',description:'把本周资料整理为周报草稿。',content:'# 周报草稿\n\n按主题分组，每条附来源。'}],
 routines:[{name:'每周行业动态',slug:'weekly-digest',description:'每周汇总行业动态。',content:'# 每周行业动态\n\n收集本周公开资讯并给出三条要点。'}],
 plugins:[{pluginId:'calendar.sync',name:'日历',description:'读取本人日程以安排提醒。'},{pluginId:'mail.read',name:'邮箱'}],
 gettingStarted:{skill:'竞品速览'},
}
const plain={format:'teloa.work-template/v1',id:'work-plain',title:'普通模板',version:'1.0.0',domain:'general',description:'原 Teloa 清单仍按旧路径处理。',requirements:['资料'],output:'结果',skills:[]}
const mappedRecipe={...recipe,plugins:[{pluginId:'48677658',name:'GitHub'},{pluginId:'674',name:'Slack'},{pluginId:'unknown-id',name:'GitHub'}]}
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {MarketImportForm} from '${client}MarketForms.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;
const locale='zh-CN',snapshot={locale,dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.recipeFixture={imports:[],saved:[],closed:0,catalogReads:0,catalogVersion:'1.0.0',parentRenders:0,holdImport:false};
const githubSourceApi={pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>{},resolve:async()=>{throw Error('fixture')}};
const contentApi={hydrate:async item=>item,importIndustry:async item=>{const mappedTools=item.packageContent.files.filter(file=>file.path.startsWith('connections/')&&file.path.endsWith('.json')).flatMap(file=>{const value=JSON.parse(new TextDecoder().decode(file.bytes));return value.format==='teloa.mcp-connection/v1'?value.tools:[]});f.imports.push({sourceKind:item.source.kind,name:item.source.name,recipe:!!item.recipeImport,files:item.packageContent?.files.length??0,manifestFormat:item.manifest.format,scope:item.scope,pluginStates:item.recipeImport?.plugins.map(row=>row.state)??[],mappedTools});if(f.holdImport)await new Promise(resolve=>{f.release=resolve});return {...item,id:'stored-'+f.imports.length}}};
const connector=(id,serverName,tools)=>({format:'teloa.market-catalog-entry/v1',id,kind:'connector',delivery:'managed',version:f.catalogVersion,taxonomy:{functions:['dev-tools'],industries:['general']},upstream:null,connector:{serverName,title:{'zh-CN':serverName,en:serverName},summary:{'zh-CN':'原创测试目录',en:'Synthetic catalog'},auth:{kind:'none'},recipe:{transport:'streamable-http',url:'https://example.invalid/mcp'},tools,upstreamUrl:'https://example.invalid'},modifications:[],license:{spdx:'MIT',files:['LICENSE']},compatibility:{status:'needs-configuration',teloa:'>=0.2.0-alpha.6',dsh:'0.1.7-rc.1',conditions:[]},requires:{tools:[],network:true,runtimes:[]},review:{status:'approved',reviewedAt:'2026-10-01',reviewer:'Synthetic'}});
const marketCatalogApi={list:async()=>{f.catalogReads++;return {catalogVersion:f.catalogVersion,nextCursor:null,items:[connector('teloa.mcp-github','github',[{name:'read_item',description:{'zh-CN':'读取公开条目',en:'Read item'},readOnly:true},{name:'write_item',description:{'zh-CN':'写入条目',en:'Write item'},readOnly:false}]),connector('teloa.mcp-slack','slack',[])].map(entry=>({entry,artifact:null,addedContentId:null,addedRoleId:null,secretGroup:null})),counts:{},skipped:{unknownKind:0,newerApp:0}}}};
const mode=document.documentElement.dataset.mode||'paste';
function App(){const [open,setOpen]=React.useState(true),[draft,setDraft]=React.useState();f.parentRenders++;f.reopen=()=>setOpen(true);return <I18nProvider runtime={runtime}>{open&&<MarketImportForm githubSourceApi={githubSourceApi} contentApi={contentApi} marketCatalogApi={marketCatalogApi} openConnection={()=>{}} items={[]} mode={mode} draft={draft} onDraft={value=>setDraft(value)} close={()=>{f.closed++;setOpen(false)}} save={item=>f.saved.push(item.id)} saveMany={items=>f.saved.push(...items.map(item=>item.id))}/>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-market-recipe-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketRecipeFixture',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
 // crypto.subtle 只在安全上下文可用：固定本机 HTTP 来源，只回同一页骨架，其余请求全部阻断。
 server=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN" data-mode="'+(new URL(request.url??'/','http://x').searchParams.get('mode')||'paste')+'"><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port
})
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,mode:'paste'|'upload'){
 const page=await browser.newPage({viewport:{width:1100,height:1000}}),errors:string[]=[]
 page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
 await page.goto(origin+'/?mode='+mode)
 await page.addStyleTag({content:'body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 await page.getByRole('dialog',{name:'导入模板',exact:true}).waitFor()
 return page
}
const state=(page:any)=>page.evaluate(()=>window.recipeFixture)

test('粘贴 Grok recipe：先显示原职责、技能、例行任务、应用依赖与记忆的只读预览，不写入；返回保留粘贴内容；确认才经 importIndustry 保存',async t=>{
 const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true}),textarea=dialog.getByRole('textbox',{name:'JSON 清单',exact:true}),preview=dialog.getByRole('region',{name:'模板预览',exact:true})
 const raw=JSON.stringify(recipe,null,2);await textarea.fill(raw)
 await dialog.getByRole('button',{name:'读取并预览',exact:true}).click();await preview.waitFor()
 const text=await preview.innerText()
 assert.match(text,/市场调研助理/);assert.match(text,/原职责 · 整理公开行业资料并形成简报/)
 assert.match(text,/技能\s*2/);assert.match(text,/竞品速览/);assert.match(text,/周报草稿/)
 assert.match(text,/例行任务\s*1/);assert.match(text,/每周行业动态\s*需设置计划/)
 assert.match(text,/应用依赖\s*2/);assert.match(text,/日历\s*未配置/);assert.match(text,/邮箱\s*未配置/)
 await preview.getByText('来源',{exact:true}).click();const source=await preview.innerText();assert.match(source,/1 条模板作者记忆作为模板参考导入，不写入本人记忆/);assert.match(source,/入门技能 · 竞品速览/);assert.match(source,/原件 SHA-256 · [0-9a-f]{64}/)
 assert.match(text,/导入不会安装应用、授权、启用定时或执行任务/);assert.match(text,/导入成功只表示模板已保存/)
 // 只有模板真的声明了应用或例行任务，才提示连接授权或另行设置计划
 assert.match(text,/所列应用需你连接并授权后才能使用/);assert.match(text,/例行任务不会自动启用/)
 assert.equal(await dialog.getByRole('button',{name:'粘贴',exact:true}).isDisabled(),true,'预览期间不切换页签')
 let s=await state(page);assert.deepEqual(s.imports,[]);assert.deepEqual(s.saved,[],'预览不写入')
 await dialog.getByRole('button',{name:'返回修改',exact:true}).click();await preview.waitFor({state:'hidden'})
 assert.equal(await textarea.inputValue(),raw,'返回保留粘贴内容')
 await dialog.getByRole('button',{name:'读取并预览',exact:true}).click();await preview.waitFor()
 await dialog.getByRole('button',{name:'确认导入',exact:true}).click()
 await page.waitForFunction(()=>window.recipeFixture.saved.length===1)
 s=await state(page)
 assert.deepEqual(s.imports,[{sourceKind:'upload',name:'recipe.json',recipe:true,files:s.imports[0]!.files,manifestFormat:'teloa.business-package/v2',scope:'general',pluginStates:['needs-configuration','needs-configuration'],mappedTools:[]}])
 assert.ok(s.imports[0]!.files>=8,'固定包含原件、报告、清单、角色、技能、例行与连接文件');assert.deepEqual(s.saved,['stored-1']);assert.equal(s.closed,0)
})

test('原插件 ID 匹配已审应用，默认不选；仅显式所选工具写入声明，空工具与同名未知应用不猜测',async t=>{
 const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
 await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(mappedRecipe));await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
 const github=dialog.locator('[data-recipe-plugin="48677658"]'),slack=dialog.locator('[data-recipe-plugin="674"]'),unknown=dialog.locator('[data-recipe-plugin="unknown-id"]')
 await github.getByText('选择对应应用',{exact:true}).click();await github.getByRole('combobox').waitFor()
 assert.equal(await github.getByRole('combobox').inputValue(),'');assert.equal((await state(page)).imports.length,0)
 await github.getByRole('combobox').selectOption('teloa.mcp-github');assert.equal(await github.getByRole('checkbox',{name:/读取公开条目/}).isChecked(),false)
 await github.getByRole('checkbox',{name:/读取公开条目/}).check();assert.equal(await github.getByRole('checkbox',{name:/写入条目/}).isChecked(),false)
 await slack.getByText('选择对应应用',{exact:true}).click();await slack.getByRole('combobox').selectOption('teloa.mcp-slack');await slack.getByText('先到应用连接核实工具',{exact:true}).waitFor();assert.equal(await slack.getByRole('checkbox').count(),0)
 await unknown.getByText('选择对应应用',{exact:true}).click();await unknown.getByText('未找到对应的已审应用',{exact:true}).waitFor();assert.equal(await unknown.getByRole('combobox').count(),0)
 if(process.env.TELOA_MARKET_CAPTURE)await page.screenshot({path:join(process.env.TELOA_MARKET_CAPTURE,'n24-mapped-import-preview.png'),fullPage:true})
 await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>window.recipeFixture.saved.length===1)
 const s=await state(page);assert.ok(s.catalogReads>=2,'确认重新核验固定目录');assert.deepEqual(s.imports[0]!.mappedTools,['read_item']);assert.deepEqual(s.imports[0]!.pluginStates,['declared-not-connected','needs-configuration','needs-configuration'])
})

test('应用目录版本变化拒绝旧工具选择，不导入；重新预览后可再选择',async t=>{
 const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
 await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(mappedRecipe));await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
 const github=dialog.locator('[data-recipe-plugin="48677658"]');await github.getByText('选择对应应用',{exact:true}).click();await github.getByRole('combobox').selectOption('teloa.mcp-github');await github.getByRole('checkbox',{name:/读取公开条目/}).check()
 await page.evaluate(()=>{window.recipeFixture.catalogVersion='2.0.0'});await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await dialog.getByRole('alert').waitFor();assert.equal((await state(page)).imports.length,0)
})

test('外点收起预览后保留粘贴，重开重新预览并清空应用选择；内联草稿回调不会循环',async t=>{
 const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true}),raw=JSON.stringify(mappedRecipe)
 await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(raw);await dialog.getByRole('button',{name:'读取并预览',exact:true}).click()
 const github=dialog.locator('[data-recipe-plugin="48677658"]');await github.getByText('选择对应应用',{exact:true}).click();await github.getByRole('combobox').selectOption('teloa.mcp-github');await github.getByRole('checkbox',{name:/读取公开条目/}).check()
 await page.mouse.click(5,5);await dialog.waitFor({state:'hidden'});assert.equal((await state(page)).imports.length,0)
 await page.evaluate(()=>window.recipeFixture.reopen());await dialog.waitFor();assert.equal(await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).inputValue(),raw);assert.equal(await dialog.getByRole('region',{name:'模板预览',exact:true}).count(),0)
 await dialog.getByRole('button',{name:'读取并预览',exact:true}).click();await github.getByText('选择对应应用',{exact:true}).click();await github.getByRole('combobox').waitFor();assert.equal(await github.getByRole('combobox').inputValue(),'');assert.ok((await state(page)).parentRenders<12)
})

test('保存中外点和 Esc 都不关闭，待原导入回执返回后才允许收起',async t=>{
 const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true})
 await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(recipe));await dialog.getByRole('button',{name:'读取并预览',exact:true}).click();await page.evaluate(()=>{window.recipeFixture.holdImport=true});await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>window.recipeFixture.imports.length===1)
 await page.mouse.click(5,5);await page.keyboard.press('Escape');assert.equal(await dialog.count(),1);assert.equal((await state(page)).closed,0)
 await page.evaluate(()=>window.recipeFixture.release?.());await page.waitForFunction(()=>window.recipeFixture.saved.length===1);await dialog.getByRole('button',{name:'确认导入',exact:true}).waitFor();await page.keyboard.press('Escape');await dialog.waitFor({state:'hidden'});assert.equal((await state(page)).imports.length,1)
})

test('上传 recipe.json 走同一预览与确认；原 Teloa 清单粘贴仍按旧路径直接保存，不出现预览',async t=>{
 const page=await mount(t,'upload'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true}),preview=dialog.getByRole('region',{name:'模板预览',exact:true})
 await dialog.getByLabel('模板文件',{exact:true}).setInputFiles({name:'recipe.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(recipe))})
 await dialog.getByRole('button',{name:'读取模板',exact:true}).click();await preview.waitFor()
 assert.deepEqual((await state(page)).imports,[])
 await dialog.getByRole('button',{name:'确认导入',exact:true}).click();await page.waitForFunction(()=>window.recipeFixture.saved.length===1)
 const s=await state(page);assert.equal(s.imports.length,1);assert.equal(s.imports[0]!.sourceKind,'upload');assert.equal(s.imports[0]!.name,'recipe.json');assert.equal(s.imports[0]!.recipe,true)
 const plainPage=await mount(t,'paste'),plainDialog=plainPage.getByRole('dialog',{name:'导入模板',exact:true})
 await plainDialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(plain))
 await plainDialog.getByRole('button',{name:'读取并预览',exact:true}).click()
 await plainPage.waitForFunction(()=>window.recipeFixture.saved.length===1)
 assert.equal(await plainDialog.getByRole('region',{name:'模板预览',exact:true}).count(),0,'原 Teloa 清单不进入 Grok 预览')
 assert.deepEqual((await state(plainPage)).imports,[],'粘贴原清单不经 importIndustry，沿用旧行为')
})

test('没有应用与例行任务的 recipe：导入说明只讲保存与后续准备，不要求配置应用或设置计划',async t=>{
 const page=await mount(t,'paste'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true}),preview=dialog.getByRole('region',{name:'模板预览',exact:true})
 const minimal={profile:{name:'写作伙伴',title:'Writing partner',description:'按原写作方法修改本人提供的文字。'},memory:[],skills:[{name:'Writing revision',description:'修改文字。',content:'# Writing revision\n\n按原方法修改。'}],routines:[],plugins:[]}
 await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).fill(JSON.stringify(minimal))
 await dialog.getByRole('button',{name:'读取并预览',exact:true}).click();await preview.waitFor()
 const text=await preview.innerText()
 assert.match(text,/例行任务\s*0/);assert.match(text,/应用依赖\s*0/);assert.match(text,/导入成功只表示模板已保存/)
 assert.doesNotMatch(text,/设置计划|需设置|配置应用|连接并授权/,'无应用与例行的模板不得提示必需设置')
 assert.deepEqual((await state(page)).imports,[],'预览不写入')
})
