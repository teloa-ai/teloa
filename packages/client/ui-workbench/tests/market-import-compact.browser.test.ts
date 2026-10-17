import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {build} from 'vite'
// @ts-expect-error 既有独立无界面浏览器夹具。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

// N30：导入改为平台抽屉 + 轻量页签；默认只需选文件或文件夹，粘贴与 GitHub 按需切换，自然语言创建单独打开。
// 夹具为原创内容；不连 GitHub、不调用模型。
const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
let browser:any,script:string,styles:string,temp:string,origin:string,server:ReturnType<typeof createServer>
const recipe={profile:{name:'调研助理',title:'市场调研助理',description:'整理公开行业资料并形成简报，不代替本人判断。'},memory:[],skills:[{name:'竞品速览',description:'按固定清单整理竞品公开信息。',content:'# 竞品速览\n\n列出名称与来源。'}],routines:[],plugins:[]}
const entry=`
import React from 'react';import {createRoot} from 'react-dom/client';import {MarketImportForm} from '${client}MarketForms.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';import {prototypeThemes} from '${client}../brand/prototype-theme.ts';import tokens from '${client}theme-tokens.module.css';
for(const [key,value] of Object.entries(prototypeThemes.light))document.body.style.setProperty(key,value);document.body.className=tokens.tokens;
const locale='zh-CN',snapshot={locale,dshLocale:'zh-CN',revision:1},runtime={t:(key,params)=>translateMessage(locale,key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot};
const f=window.importFixture={imports:[],saved:[],closed:0,resolves:[]};
const githubSourceApi={pending:()=>undefined,recoveryMessage:()=>undefined,discard:()=>{},resolve:async input=>{f.resolves.push(input);throw Error('fixture')}};
const contentApi={hydrate:async item=>item,importIndustry:async item=>{f.imports.push(item.manifest.resources.filter(row=>row.kind==='role').length);return {...item,id:'stored-'+f.imports.length}}};
const mode=document.documentElement.dataset.mode;
function App(){const [open,setOpen]=React.useState(true);return <I18nProvider runtime={runtime}>{open&&<MarketImportForm githubSourceApi={githubSourceApi} contentApi={contentApi} items={[]} mode={mode} close={()=>{f.closed++;setOpen(false)}} save={item=>f.saved.push(item.id)} saveMany={items=>f.saved.push(...items.map(item=>item.id))}/>}</I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);
`
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-market-import-compact-'));await writeFile(join(temp,'fixture.tsx'),entry)
 const result=await build({configFile:false,root,resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'MarketImportCompact',formats:['iife']}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 script=bundle.output.find(item=>item.type==='chunk')!.code
 styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
 // crypto.subtle 需安全上下文：本机固定来源只回页面骨架，其余请求阻断。
 server=createServer((request,response)=>{response.setHeader('Content-Type','text/html; charset=utf-8');response.end('<!doctype html><html lang="zh-CN" data-mode="'+(new URL(request.url??'/','http://x').searchParams.get('mode')||'upload')+'"><body><div id="root"></div></body></html>')})
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();assert.ok(address&&typeof address==='object');origin='http://127.0.0.1:'+address.port
})
after(async()=>{await browser?.close();server?.closeAllConnections();await new Promise<void>(resolve=>server?server.close(()=>resolve()):resolve());if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any,mode:string,width=1280){
 const page=await browser.newPage({viewport:{width,height:900}}),errors:string[]=[]
 page.setDefaultTimeout(5000);page.on('pageerror',(error:Error)=>errors.push(error.message))
 t.after(async()=>{await page.close();assert.deepEqual(errors,[])})
 await page.route('**/*',(route:any)=>route.request().url().startsWith(origin+'/')?route.continue():route.abort())
 await page.goto(origin+'/?mode='+mode)
 await page.addStyleTag({content:'body{margin:0;font:14px system-ui}'+styles});await page.addScriptTag({content:script})
 return page
}
const state=(page:any)=>page.evaluate(()=>(window as any).importFixture)

for(const width of [1280,390])test(width+' 默认导入：右侧抽屉、轻量页签、只需选文件或文件夹，技术说明按需展开',async t=>{
 const page=await mount(t,'upload',width),dialog=page.getByRole('dialog',{name:'导入模板',exact:true});await dialog.waitFor()
 const box=await dialog.boundingBox();assert.ok(box&&Math.abs(box.x+box.width-width)<=1&&box.height>=880,'使用平台右侧抽屉而非居中大弹窗')
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
 const tabs=dialog.locator('[aria-pressed]');assert.deepEqual(await tabs.allInnerTexts(),['文件','粘贴','GitHub'],'自然语言创建不与导入文件同排')
 for(let index=0;index<3;index++){const height=(await tabs.nth(index).boundingBox())!.height;assert.ok(height<=40,'页签是轻量页签：'+height)}
 // 两个原生文件控件只作为可聚焦的隐藏输入，界面上是带图标的按钮
 const file=dialog.getByLabel('模板文件',{exact:true}),folder=dialog.getByLabel('模板文件夹',{exact:true})
 for(const input of [file,folder]){const size=await input.boundingBox();assert.ok(!size||size.width<=1&&size.height<=1,'原生文件控件不直接显示')}
 for(const name of ['选择文件','选择文件夹']){const button=dialog.getByText(name,{exact:true});assert.ok(await button.isVisible());assert.equal(await button.evaluate((node:HTMLElement)=>!!node.closest('label')?.querySelector('svg')),true,name+' 有图标')}
 await file.focus();assert.equal(await page.evaluate(()=>(document.activeElement as HTMLInputElement|null)?.type),'file','隐藏输入仍可用键盘聚焦')
 // 长篇技术说明默认收起，信息按钮展开后边界仍在
 const notice=dialog.getByText('支持 ZIP、JSON 和 recipe.json。',{exact:true})
 assert.equal(await notice.isVisible(),false)
 const info=dialog.getByRole('button',{name:'导入说明',exact:true});assert.equal(await info.getAttribute('aria-expanded'),'false');await info.click()
 assert.equal(await info.getAttribute('aria-expanded'),'true');assert.ok(await notice.isVisible());assert.ok(await dialog.getByText(/不会自动安装或授权/).first().isVisible())
 // 按需入口：粘贴与 GitHub 切换后原输入可用
 await tabs.nth(1).click();await dialog.getByRole('textbox',{name:'JSON 清单',exact:true}).waitFor()
 await tabs.nth(2).click();await dialog.getByPlaceholder('https://github.com/owner/repo').waitFor();assert.equal(await dialog.getByRole('group',{name:'导入为',exact:true}).count(),1)
 await tabs.nth(0).click();await dialog.getByText('选择文件',{exact:true}).waitFor()
 assert.deepEqual((await state(page)).resolves,[])
})

test('选文件后预览按真实清单的员工身份展示，确认后经原导入保存；返回保留文件',async t=>{
 const page=await mount(t,'upload'),dialog=page.getByRole('dialog',{name:'导入模板',exact:true});await dialog.waitFor()
 await dialog.getByLabel('模板文件',{exact:true}).setInputFiles({name:'recipe.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(recipe))})
 await dialog.getByText('已选择：recipe.json',{exact:true}).waitFor()
 await dialog.getByRole('button',{name:'读取模板',exact:true}).click()
 const preview=dialog.getByRole('region',{name:'模板预览',exact:true});await preview.waitFor()
 const identity=preview.locator('[data-import-identity]');assert.equal(await identity.getAttribute('data-import-identity'),'employee')
 assert.match(await identity.innerText(),/AI 员工/);assert.match(await preview.innerText(),/市场调研助理/)
 assert.equal(await dialog.locator('[aria-pressed]').first().isDisabled(),true,'预览期间不切换页签')
 assert.deepEqual((await state(page)).imports,[],'预览不写入')
 await dialog.getByRole('button',{name:'返回修改',exact:true}).click();await dialog.getByText('已选择：recipe.json',{exact:true}).waitFor()
 await dialog.getByRole('button',{name:'读取模板',exact:true}).click();await preview.waitFor()
 await dialog.getByRole('button',{name:'确认导入',exact:true}).click()
 await page.waitForFunction(()=>(window as any).importFixture.saved.length===1)
 const s=await state(page);assert.deepEqual(s.imports,[1],'按原 importIndustry 保存 1 位员工的固定包');assert.deepEqual(s.saved,['stored-1'])
})

test('自然语言创建单独打开：不显示导入页签与文件选择，保留原保存语义',async t=>{
 const page=await mount(t,'conversation'),dialog=page.getByRole('dialog').first();await dialog.waitFor()
 assert.equal(await dialog.locator('[aria-pressed]').count(),0)
 assert.equal(await dialog.getByText('选择文件',{exact:true}).count(),0)
 const request=dialog.getByRole('textbox',{name:'希望创建什么工作方式',exact:true});await request.fill('每周整理竞品动态')
 await dialog.getByRole('button',{name:'保存并准备会话',exact:true}).click()
 await page.waitForFunction(()=>(window as any).importFixture.saved.length===1)
 await page.keyboard.press('Escape')
})
