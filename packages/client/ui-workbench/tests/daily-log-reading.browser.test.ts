import {test,before,after} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,rm,mkdir} from 'node:fs/promises'
import {fileURLToPath} from 'node:url'
import {join} from 'node:path'
import {build} from 'vite'
// @ts-expect-error 既有无头浏览器加载器。
import {launchOptions,loadPlaywright} from './fixtures/load-playwright.mjs'

const root=fileURLToPath(new URL('../../../../',import.meta.url)),client=fileURLToPath(new URL('../src/client/',import.meta.url))
const markdown='# 当天结论\n\n**已复核**；标识 J03_V3_4409、case__one__two、中文_编号_甲保持原样。独立的 _斜体_ 和 __加粗__ 仍可阅读。\n\n| 案例 | 失败次数 | 判定 |\n| --- | --- | --- |\n| CS-D | 18 | 保持观察 |\n| CS-E | 19 | 升级人工研判 |\n\n- 不合并案例\n- 不执行处置\n\n```json\n{"marker":"J03_V3_4409"}\n```\n\n![外部图片](https://example.invalid/beacon.png)\n\n<script>alert(1)</script>'
let browser:any,script:string,styles:string,temp:string
before(async()=>{
 temp=await mkdtemp(join(root,'.runtime-daily-log-reading-'))
 await writeFile(join(temp,'fixture.tsx'),`
 import React,{useState} from 'react';import {createRoot} from 'react-dom/client';import {RoleDailyLogPanel} from '${client}RoleDailyLogPanel.tsx';import {MarkdownPreview} from '${client}knowledge-markdown.tsx';import {KnowledgeMarkdownEditor} from '${client}KnowledgeMarkdownEditor.tsx';import {I18nProvider} from '${client}i18n/provider.tsx';import {translateMessage} from '${client}i18n/messages.ts';
 const snapshot={locale:'zh-CN',dshLocale:'zh',revision:1},runtime={t:(key,params)=>translateMessage('zh-CN',key,params),subscribe:()=>()=>{},getSnapshot:()=>snapshot},markdown=${JSON.stringify(markdown)};
 const log={id:'log-1',ownerId:'owner',roleId:'role-1',roleVersion:1,kind:'daily-digest',day:'2026-10-25',state:'kept',runId:'run-1',title:'实际工作日志',markdown,scopeIds:['SOC'],evidence:[],pruneHints:[],createdAt:'2026-10-25T04:47:00.000Z',discardedAt:null};
 const api={list:async()=>[log],get:async()=>log,pending:()=>false,recoveryMessage:()=>undefined};
 function Editor(){const [value,setValue]=useState('请核对金额');return <KnowledgeMarkdownEditor value={value} onChange={setValue}/>}
 createRoot(document.getElementById('root')).render(<I18nProvider runtime={runtime}><div id="drawer" style={{width:480}}><RoleDailyLogPanel roleId="role-1" kind="daily-digest" api={api}/></div><div id="shared-preview"><MarkdownPreview markdown={markdown} images={false}/></div><div id="editor"><Editor/></div></I18nProvider>);
 `)
 const output=await build({configFile:false,root,logLevel:'error',define:{'process.env.NODE_ENV':'"development"'},build:{write:false,minify:false,rollupOptions:{external:(id:string)=>id.startsWith('node:'),treeshake:{moduleSideEffects:false}},lib:{entry:join(temp,'fixture.tsx'),name:'DailyLogReading',formats:['iife']}}})
 const bundle=Array.isArray(output)?output[0]:output;assert.ok(bundle&&'output'in bundle);script=bundle.output.find(item=>item.type==='chunk')!.code;styles=bundle.output.flatMap(item=>item.type==='asset'&&item.fileName.endsWith('.css')?[String(item.source)]:[]).join('\n')
 browser=await loadPlaywright().chromium.launch(launchOptions())
})
after(async()=>{await browser?.close();if(temp)await rm(temp,{recursive:true,force:true})})
async function mount(t:any){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors:string[]=[],requests:string[]=[];page.setDefaultTimeout(3000);page.on('pageerror',(error:Error)=>errors.push(error.message));await page.route('**/*',(route:any)=>{requests.push(route.request().url());return route.abort()})
 t.after(async()=>{if(process.env.TELOA_TEST_SCREENSHOTS){await mkdir(process.env.TELOA_TEST_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOTS,t.name+'.png'),fullPage:true})}await page.close();assert.deepEqual(errors,[]);assert.deepEqual(requests,[])})
 await page.setContent('<!doctype html><html lang="zh-CN"><head><style>:root{--teloa-border:#ddd;--teloa-sidebar:#f6f5f2;--teloa-surface:white;--teloa-text:#222;--teloa-muted:#666;--teloa-subtle:#f8f7f4;--teloa-font-control:14px;--teloa-font-caption:12px;--teloa-font-body:14px;--teloa-font-section:18px;--teloa-weight-heading:600;--teloa-leading-heading:1.4}body{margin:16px;font-family:Arial,sans-serif}</style></head><body><div id="root"></div></body></html>');await page.addStyleTag({content:styles});await page.addScriptTag({content:script});return page
}
test('窄抽屉中日志正文呈现标题表格且使用完整宽度，宽容器保持日期并栏',async t=>{
 const page=await mount(t),panel=page.locator('#drawer');await panel.getByRole('button',{name:/实际工作日志/}).click();const body=panel.getByRole('article',{name:'实际工作日志'});await body.waitFor()
 assert.equal(await body.getByRole('heading',{name:'当天结论',exact:true}).count(),1)
 assert.equal(await body.getByRole('table').count(),1);assert.equal(await body.getByRole('cell',{name:'升级人工研判',exact:true}).count(),1);assert.equal(await body.locator('strong').filter({hasText:'已复核'}).count(),1)
 assert.equal(await body.locator('img,script').count(),0);assert.ok((await body.textContent()).includes('J03_V3_4409'))
 const size=await body.boundingBox(),days=await panel.getByRole('navigation').boundingBox();assert.ok(size.width>=400,'窄抽屉正文不能再被日期栏挤压');assert.ok(size.y>=days.y+days.height,'窄容器日期目录应位于正文上方')
 assert.equal(await panel.evaluate((el:HTMLElement)=>el.scrollWidth<=el.clientWidth+1),true)
 if(process.env.TELOA_TEST_SCREENSHOTS){await mkdir(process.env.TELOA_TEST_SCREENSHOTS,{recursive:true});await panel.screenshot({path:join(process.env.TELOA_TEST_SCREENSHOTS,'日志窄容器480px.png')})}
 await panel.evaluate((el:HTMLElement)=>el.style.width='900px');await page.waitForTimeout(50);const wide=await body.boundingBox(),wideDays=await panel.getByRole('navigation').boundingBox();assert.ok(wide.x>wideDays.x+wideDays.width);assert.ok(wide.width>600)
})
test('编辑器给句中中文选区添加斜体后预览保留正确语义',async t=>{
 const page=await mount(t),editor=page.locator('#editor');await editor.getByRole('tab',{name:'编辑',exact:true}).click();const input=editor.locator('textarea');await input.evaluate((el:HTMLTextAreaElement)=>{el.focus();el.setSelectionRange(3,5)})
 await editor.getByRole('button',{name:'斜体',exact:true}).click();await editor.getByRole('tab',{name:'预览',exact:true}).click();const preview=editor.getByRole('tabpanel');assert.equal(await preview.textContent(),'请核对金额');assert.equal(await preview.locator('em').textContent(),'金额')
})
test('共享预览保留含下划线的业务标识，同时保留独立强调语法',async t=>{
 const page=await mount(t),preview=page.locator('#shared-preview');await preview.getByRole('heading',{name:'当天结论'}).waitFor();const text=await preview.locator('p').filter({hasText:'已复核'}).textContent();for(const value of ['J03_V3_4409','case__one__two','中文_编号_甲'])assert.ok(text.includes(value),value+' 必须逐字保留')
 assert.equal(await preview.locator('em').count(),1);assert.equal(await preview.locator('em').textContent(),'斜体');assert.equal(await preview.locator('strong').filter({hasText:'加粗'}).count(),1);assert.equal(await preview.locator('img,script').count(),0)
})
