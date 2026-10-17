import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 复用本工作树无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

/** 把图片统一成可比较的内容：PNG 取 base64 字节，SVG 去掉 vite 内联时会改写的引号与空白。 */
function inlinedImage(value:string|Buffer){
 if(Buffer.isBuffer(value))return value[0]===0x89?'png:'+value.toString('base64'):'svg:'+value.toString('utf8').replace(/"/g,"'").replace(/\s+/g,'')
 const [head,body]=[value.slice(0,value.indexOf(',')),value.slice(value.indexOf(',')+1)]
 return head.includes('png')?'png:'+body:'svg:'+(head.endsWith(';base64')?Buffer.from(body,'base64').toString('utf8'):decodeURIComponent(body)).replace(/"/g,"'").replace(/\s+/g,'')
}

test('真实应用组件加载原应用图标，浅深色／我的／详情一致，破图回退，窄窗口与关闭返回保持可用',async t=>{
 const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=join(root,'packages/client/ui-workbench/src/client'),temp=await mkdtemp(join(root,'.runtime-app-icons-'))
 t.after(()=>rm(temp,{recursive:true,force:true}))
 const entry=`import React from 'react';import {createRoot} from 'react-dom/client';import {MarketAppsDirectoryView} from '${client}/MarketAppsDirectory.tsx';import {I18nProvider} from '${client}/i18n/provider.tsx';import {translateMessage} from '${client}/i18n/messages.ts';import {ThemePresenter} from '${client}/theme-presenter.ts';
 const theme=new ThemePresenter();theme.apply({active:{colorScheme:'light',tokens:{}},fontSizes:{text:14}});
 const runtime={t:(k,p)=>translateMessage('zh-CN',k,p),getSnapshot:()=>snapshot,subscribe:()=>()=>{}},snapshot={locale:'zh-CN',dshLocale:'zh',revision:1};
 const skill={title:'原工作方法',summary:'同一应用的方法',added:true,installed:true,builtin:false};
 const connector={key:'app:teloa.mcp-github',kind:'app',title:'GitHub（官方远程 MCP）',summary:'查找代码与讨论',categories:['dev-tools'],entryIds:['teloa.mcp-github'],skills:[],connectors:[{title:'GitHub',catalogId:'teloa.mcp-github',entry:{connector:{serverName:'github'}},state:{install:'added',connection:'connected'},tools:[]}],mine:true};
 const packs=[['674','Slack'],['579','Sentry'],['49339676','Remotion 视频制作'],['9717366','pstack']].map(([id,title])=>({key:'pack:cursor:'+id,kind:'library',title,summary:'已审应用的方法',categories:['dev-tools'],entryIds:[],skills:[skill],connectors:[],mine:true,pack:{pluginId:id,members:[],unsupported:[],installable:false}}));
 const local={key:'installed:custom',kind:'installed-skill',title:'GitHub',summary:'本人自建技能，同名不冒用品牌',categories:[],entryIds:[],skills:[skill],connectors:[],mine:true};
 function App(){const [view,setView]=React.useState({query:'',category:'all',mine:false});return <I18nProvider runtime={runtime}><button onClick={()=>theme.apply({active:{colorScheme:'dark',tokens:{}},fontSizes:{text:14}})}>深色</button><MarketAppsDirectoryView rows={[connector,...packs,local]} ranking={new Map()} catalog={{status:'ready'}} connections={{status:'ready',records:[]}} view={view} onViewChange={setView} runAction={()=>{}} busy={undefined} errors={{}}/></I18nProvider>};createRoot(document.getElementById('root')).render(<App/>);`
 await writeFile(join(temp,'entry.tsx'),entry)
 const result=await build({root,configFile:false,logLevel:'error',resolve:{alias:{'@teloa/contract':join(root,'packages/contract/src/index.ts')}},define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,lib:{entry:join(temp,'entry.tsx'),formats:['iife'],name:'AppIconsFixture'},rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}}}})
 const bundle=Array.isArray(result)?result[0]:result;assert.ok(bundle&&'output'in bundle)
 const script=bundle.output.find(item=>item.type==='chunk')!.code,styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 const browser=await loadPlaywright().chromium.launch(launchOptions());t.after(()=>browser.close())
 const page=await browser.newPage({viewport:{width:1100,height:850}}),errors:string[]=[];page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>route.abort())
 await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');await page.addStyleTag({content:'*{box-sizing:border-box}body{font:14px system-ui;margin:20px;background:var(--teloa-surface)}'+styles});await page.addScriptTag({content:script})
 const directory=page.locator('section[aria-labelledby="market-apps-title"]');await directory.getByRole('heading',{name:'应用',exact:true}).waitFor().catch(async (error:Error)=>{t.diagnostic(JSON.stringify({errors,body:await page.locator('body').innerText()}));throw error})
 assert.equal(await directory.locator('li img').count(),5)
 for(const image of await directory.locator('li img').all()){assert.ok(await image.evaluate((el:HTMLImageElement)=>el.complete&&el.naturalWidth>0));assert.match(await image.getAttribute('src'),/^data:image\/(svg\+xml|png)/)}
 // 页面实际显示的是原插件素材：GitHub 用 cursor/plugins 原图，Sentry 用 getsentry/plugin-cursor 原图（vite 内联 SVG 只规范引号与空白）。
 const resources=join(root,'packages/client/ui-workbench/src/brand/resources'),shown=new Set((await directory.locator('li img').evaluateAll((els:Element[])=>els.map(el=>el.getAttribute('src')!))).map(inlinedImage))
 for(const file of ['cursor-github.svg','slack.svg','sentry-plugin-cursor.svg','remotion.svg','pstack.png'])assert.ok(shown.has(inlinedImage(await readFile(join(resources,file)))),file+' 按原文件显示')
 const row=directory.getByRole('button',{name:/^Remotion 视频制作/});await row.click();const detail=page.getByRole('dialog');await detail.waitFor();assert.equal(await detail.locator('img').count(),1);assert.equal(await detail.locator('img').evaluate((el:HTMLElement)=>el.parentElement!.getBoundingClientRect().width),52);assert.equal(await detail.getByText('未添加',{exact:true}).evaluate((el:HTMLElement)=>getComputedStyle(el).whiteSpace),'nowrap','安装状态不被长描述挤成竖排')
 await page.keyboard.press('Escape');assert.equal(await detail.count(),0);await directory.getByRole('button',{name:'我的应用 6',exact:true}).click();assert.equal(await directory.locator('li img').count(),5)
 const custom=directory.getByRole('button').filter({hasText:'本人自建技能'});assert.equal(await custom.locator('img').count(),0);assert.equal(await custom.locator('svg').count(),1)
 await page.getByRole('button',{name:'深色',exact:true}).click();assert.equal(await directory.locator('li img').first().evaluate((el:HTMLElement)=>getComputedStyle(el.parentElement!).backgroundColor),'rgb(255, 255, 255)','品牌图形保留中性浅底，暗色可识别')
 await directory.locator('li img').first().evaluate((el:HTMLElement)=>el.dispatchEvent(new Event('error')));await page.waitForFunction(()=>document.querySelectorAll('section[aria-labelledby="market-apps-title"] li img').length===4);assert.notEqual(await directory.locator('li').first().locator('button').first().locator('span[aria-hidden="true"]').evaluate((el:HTMLElement)=>getComputedStyle(el).color),await directory.locator('li').first().locator('button').first().locator('span[aria-hidden="true"]').evaluate((el:HTMLElement)=>getComputedStyle(el).backgroundColor),'深色破图后的类型图标不能白底白色')
 await page.setViewportSize({width:760,height:850});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 assert.deepEqual(errors,[])
})
